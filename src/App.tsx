import { useEffect, useState, useCallback, useRef } from 'react';
import { useKeymapStore } from './store/useKeymapStore';
import { readKeymap, writeKeymapToDevice, saveChanges, setLayerProps, getDeviceInfo, getFirmwareInfo, requestUnlock, isUnlocked, readMacrosFromDevice, onDeviceDisconnect, onActiveLayerChange, onKeyInputEvent, subscribeToInput, getRuntimeState, setKeyboardLayout, getBehaviorDisplayName, getCombosFromDevice, writeCombosToDevice, verifyDeviceState } from './services/usbService';
import { saveWriteBackup } from './services/writeBackups';
import type { KeymapProject } from './types';
import { isFirmwareVersionSupported, checkFirmwareUpdate, analyzeFirmwareConsistency, MIN_SUPPORTED_FW_VERSION } from './services/firmwareCompat';
import { runConfigAudit } from './services/configAudit';
import type { PanelTab } from './types';
import { debugLog } from './components/DebugConsole';
import { Header } from './components/Header/Header';
import { LayerList } from './components/LeftPanel/LayerList';
import { ComboList } from './components/LeftPanel/ComboList';
import { KeyboardView } from './components/KeyboardView/KeyboardView';
import { KeyConfig } from './components/RightPanel/KeyConfig';
import { TrackballConfig } from './components/RightPanel/TrackballConfig';
import { TimingConfig } from './components/RightPanel/TimingConfig';
import { BluetoothConfig } from './components/RightPanel/BluetoothConfig';
import { DiagnosticsPanel } from './components/RightPanel/DiagnosticsPanel';
import { FirmwareUpdateWizard } from './components/RightPanel/FirmwareUpdateWizard';
import { MacroList } from './components/LeftPanel/MacroList';
import { MacroEditor } from './components/RightPanel/MacroEditor';
import { DebugConsole } from './components/DebugConsole';

// Toasts stack up to this many at once (see the toasts state below) --
// older ones get shoved to the back visually and eventually fall off the
// array entirely rather than piling up forever.
const MAX_TOASTS = 3;

interface ToastItem {
  id: number;
  message: string;
  type: 'device' | 'local' | 'error' | 'progress';
  // True for one render right after mount, then flipped off a frame later
  // so the CSS transition on transform/opacity actually animates from an
  // off-stack starting position instead of jumping straight to rest.
  entering: boolean;
}

function App() {
  const store = useKeymapStore();
  const [showConsole, setShowConsole] = useState(false);
  // Rendered at this top level (not inside DiagnosticsPanel) deliberately:
  // the wizard's whole point is guiding the user through resetting a unit
  // into its UF2 bootloader, which necessarily drops the current USB/BLE
  // connection. DiagnosticsPanel unmounts its device-dependent content on
  // disconnect (isConnected() early return), which was silently killing the
  // wizard mid-flow the moment the user actually followed its own
  // instructions. It only ever needed a firmwareInfo snapshot, never a live
  // connection, so it doesn't need to live inside the connection-gated tree.
  const [firmwareWizardInfo, setFirmwareWizardInfo] = useState<Awaited<ReturnType<typeof getFirmwareInfo>> | null>(null);
  const [usbConnected, setUsbConnected] = useState(false); // true for either transport (USB or BLE)
  const [connType, setConnType] = useState<'usb' | 'bluetooth' | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const [highestLayer, setHighestLayer] = useState(0);
  const [pressedPositions, setPressedPositions] = useState<number[]>([]);
  const [popupBattery, setPopupBattery] = useState<{ l: number | null; r: number | null } | null>(null);
  // Once a Write lands on the device, offer the "back to the minimap"
  // shortcut in the header (Electron only).
  const [wroteToDevice, setWroteToDevice] = useState(false);
  // Set when the connected firmware is older than the CI-published
  // firmware-latest release (Electron only -- the check runs through the
  // local gh CLI since the repo is private). Badges the FW download button.
  const [fwUpdateAvailable, setFwUpdateAvailable] = useState(false);
  // firmware-latest's publishedAt (ISO, UTC), shown as a "last updated"
  // stamp on the FW download button. Same Electron-only gh bridge as above;
  // the web build has no data source and simply shows nothing.
  const [fwLatestPublishedAt, setFwLatestPublishedAt] = useState<string | null>(null);

  // Fetch the latest-firmware publish date once at startup, so the stamp is
  // visible without needing a device connection first (the connect-time
  // check below refreshes it and adds the update-available comparison).
  useEffect(() => {
    (window as any).electronAPI?.checkFirmwareLatest?.().then((latest: { name: string; publishedAt: string } | null) => {
      if (latest?.publishedAt) setFwLatestPublishedAt(latest.publishedAt);
    });
  }, []);
  // The last state confirmed to be on the device (captured at Read and
  // after each verified Write) -- this is what a pre-write backup snapshots,
  // since it's what the device holds just before we overwrite it.
  const lastDeviceSnapshotRef = useRef<KeymapProject | null>(null);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback((message: string, type: ToastItem['type'] = 'device', opts?: { persist?: boolean }) => {
    const id = ++toastIdRef.current;
    // Progress toasts (the Write steps) are persistent -- no auto-dismiss
    // timer -- so in the stacked-toast world they'd linger behind forever
    // once the terminal success/error toast (which DOES auto-dismiss after
    // 3s) has come and gone, looking like a Write that never finishes.
    // Successive progress steps may stack (that's the visual), but any
    // NON-progress toast is a terminal state for the sequence and sweeps
    // all progress toasts out of the stack.
    setToasts(prev => [
      { id, message, type, entering: true },
      ...(type === 'progress' ? prev : prev.filter(t => t.type !== 'progress')),
    ].slice(0, MAX_TOASTS));
    // Flip "entering" off a frame after mount so the transition below
    // actually animates from the off-stack starting position instead of
    // snapping straight to rest (the double rAF waits for the browser to
    // paint the initial state first).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setToasts(prev => prev.map(t => (t.id === id ? { ...t, entering: false } : t)));
      });
    });
    if (!opts?.persist) {
      const timer = setTimeout(() => removeToast(id), 3000);
      toastTimersRef.current.set(id, timer);
    } else {
      // Safety net: even a "persistent" toast shouldn't outlive its writer
      // by minutes if some code path forgets to send a terminal toast.
      const timer = setTimeout(() => removeToast(id), 60000);
      toastTimersRef.current.set(id, timer);
    }
  }, [removeToast]);

  useEffect(() => {
    onDeviceDisconnect(() => { setUsbConnected(false); setConnType(null); setPressedPositions([]); });
    onActiveLayerChange(setHighestLayer);
    onKeyInputEvent((position, pressed) => {
      setPressedPositions(prev => {
        if (pressed) return prev.includes(position) ? prev : [...prev, position];
        return prev.includes(position) ? prev.filter(p => p !== position) : prev;
      });
    });
    setKeyboardLayout(store.osLayout);
    // Electron only: surface the main process's BLE scan progress in this
    // debug console (packaged apps have no visible stdout).
    (window as any).electronAPI?.onBleScanLog?.((msg: string) => debugLog('INF', 'BLE-scan', msg));
  }, []);

  // Suspends the runtime-state poll below for the duration of a Write. The
  // firmware's settings flash save blocks its RPC thread for several
  // seconds, so poll requests sent during that window always time out
  // ("getRuntimeState failed: Response timeout") and their responses then
  // arrive after the editor gave up ("Unexpected response id" warnings) --
  // harmless, but they read like Write errors in the console.
  const writeInProgressRef = useRef(false);

  // Active layer isn't reliably pushed by every firmware build yet, so poll
  // as a fallback alongside the layerChanged notification handled above --
  // whichever arrives first wins, the other just confirms the same value.
  useEffect(() => {
    if (!usbConnected) return;
    let cancelled = false;
    const poll = async () => {
      if (writeInProgressRef.current) return;
      const state = await getRuntimeState();
      if (!cancelled && state) {
        setHighestLayer(state.highestLayer);
        // Keep the same object reference when values haven't changed, so the
        // IPC relay effect below doesn't re-fire on every 1s poll tick.
        setPopupBattery(prev =>
          prev && prev.l === state.peripheralL && prev.r === state.peripheralR
            ? prev
            : { l: state.peripheralL, r: state.peripheralR });
      }
    };
    poll();
    const interval = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(interval); setPopupBattery(null); };
  }, [usbConnected]);

  // Live key-press streaming, for the tray popup's light-up-on-press guide.
  useEffect(() => {
    if (usbConnected) subscribeToInput(true);
  }, [usbConnected]);

  // Relays live layer state to the Electron main process, which forwards it
  // to the menu-bar tray's small popup window (see electron/main.cjs). A
  // no-op in a plain browser tab, where window.electronAPI doesn't exist.
  useEffect(() => {
    (window as any).electronAPI?.sendLayerState?.({
      layers: store.layers, combos: store.combos, amlExcluded: store.amlExcluded,
      highestLayer, connected: usbConnected, pressedPositions, battery: popupBattery,
    });
  }, [store.layers, store.combos, store.amlExcluded, highestLayer, usbConnected, pressedPositions, popupBattery]);

  // Auto-save on changes
  useEffect(() => {
    const timer = setTimeout(() => store.autoSave(), 500);
    if (usbConnected) setUnsaved(true);
    return () => clearTimeout(timer);
  }, [store.layers, store.combos, store.macros, store.osLayout]);

  // Pulls the keymap from the device and applies it to the local store.
  // Called both from the header's explicit "Read" button and automatically
  // right after connecting, so the editor never starts from stale local
  // state that could get pushed back to the device on the next Write.
  const handleRead = async () => {
    if (unsaved) {
      if (!confirm('未保存の変更があります。デバイスから読み込むと上書きされます。続けますか？')) return;
    }
    const result = await readKeymap();
    if (result?.layers) {
      const project = store.exportProject();
      project.layers = result.layers.map((dl: any, i: number) => {
        const existing = project.layers[i] || project.layers[0];
        const keys = existing.keys.map((k: any) => ({
          id: k.id,
          binding: dl.bindings[k.id] || { type: 'none', keyCode: 'NONE', label: '' },
        }));
        const isGenericName = !dl.name || dl.name.length === 0 || /^Layer \d+$/.test(dl.name);
        const name = isGenericName && existing.name ? existing.name : (dl.name || existing.name);
        const ledColor = dl.ledColor ?? existing.ledColor;
        return { ...existing, name, ledColor, index: dl.id ?? i, keys };
      });
      // Load firmware macros via RPC (with step data)
      const deviceMacros = await readMacrosFromDevice();
      if (deviceMacros && deviceMacros.length > 0) {
        project.macros = deviceMacros;
        // Re-map macro key labels: DT name → editor name
        for (const layer of project.layers) {
          for (const key of layer.keys) {
            if (key.binding.keyCode?.startsWith('&') && key.binding.keyCode.length > 1) {
              const dtName = key.binding.keyCode.substring(1);
              const macro = deviceMacros.find(m => m.deviceId !== undefined &&
                getBehaviorDisplayName(m.deviceId) === dtName);
              if (macro && macro.name !== dtName) {
                key.binding.label = `&${macro.name}`;
                key.binding.keyCode = `&${macro.name}`;
              }
            }
          }
        }
        debugLog('INF', 'Editor', `Firmware macros loaded with steps: ${deviceMacros.map(m => `${m.name}(${m.bindings.length})`).join(', ')}`);
      } else if (result.firmwareMacros?.length > 0) {
        const fwMacros = result.firmwareMacros.map((m: any) => ({
          name: m.name,
          waitMs: 30,
          tapMs: 30,
          bindings: [],
        }));
        project.macros = fwMacros;
        debugLog('INF', 'Editor', `Firmware macros loaded (no step data): ${fwMacros.map((m: any) => m.name).join(', ')}`);
      }
      // Combos: read after macros so binding labels referencing a macro
      // (&macro_name) resolve to the editor's friendly name, not the raw
      // device behavior name.
      const deviceCombos = await getCombosFromDevice();
      if (deviceCombos) {
        // Firmware 0.6.12+ persists combo names on the device, so a
        // device-reported name (anything that isn't the "Combo N" fallback
        // getCombosFromDevice() synthesizes for nameless firmware) wins.
        // On older firmware every name comes back as that fallback, so keep
        // the local name by position instead -- otherwise each Read
        // (including the automatic post-connect one) would wipe real names.
        const previousCombos = project.combos;
        project.combos = deviceCombos.map((c, i) => ({
          ...c,
          name: /^Combo \d+$/.test(c.name) ? (previousCombos[i]?.name || c.name) : c.name,
        }));
        debugLog('INF', 'Editor', `Combos loaded: ${deviceCombos.length}`);
      }
      store.importProject(project);
      store.clearDirtyKeys();
      setUnsaved(false);
      lastDeviceSnapshotRef.current = project;
      debugLog('INF', 'Editor', `Keymap applied: ${result.layers.length} layers`);
      // Config audit: catch silent settings corruption (the J/Z custom
      // behavior overwrite, dead combos, dangling references) right at Read
      // time, before it gets edited on top of or written back.
      const auditFindings = await runConfigAudit(project);
      const auditErrors = auditFindings.filter(f => f.severity === 'error').length;
      if (auditFindings.length > 0) {
        for (const f of auditFindings) {
          debugLog(f.severity === 'error' ? 'ERR' : 'WRN', 'Audit', `[${f.category}] ${f.message}`);
        }
        showToast(
          auditErrors > 0
            ? `設定監査: 問題${auditErrors}件（診断タブで確認）`
            : `設定監査: 注意${auditFindings.length}件（診断タブで確認）`,
          auditErrors > 0 ? 'error' : 'local',
        );
      } else {
        debugLog('INF', 'Audit', 'Config audit passed: no findings');
        showToast(`${result.layers.length} layers loaded from device`);
      }
    }
  };

  // Single unified tab bar below the keyboard -- only one of these eight
  // panels is ever showing at a time (see PanelTab in types.ts).
  const TABS: { key: PanelTab; label: string; badge?: number }[] = [
    { key: 'layers', label: '⚙ Layers' },
    { key: 'combos', label: '⌨ Combos', badge: store.combos.length },
    { key: 'macros', label: '⚡ Macros', badge: store.macros.length },
    { key: 'key-config', label: '⚙ Key Config' },
    { key: 'trackball', label: '🖲 Trackball' },
    { key: 'timing', label: '⏱ Timing' },
    { key: 'bluetooth', label: '📡 デバイス' },
    { key: 'diagnostics', label: '🩺 診断' },
  ];

  const panelContent = () => {
    switch (store.activeTab) {
      case 'layers': return <LayerList store={store} />;
      case 'combos': return <ComboList store={store} />;
      case 'macros': return store.selectedMacroIndex !== null ? <MacroEditor store={store} /> : <MacroList store={store} />;
      case 'key-config': return <KeyConfig store={store} />;
      case 'trackball': return <TrackballConfig store={store} />;
      case 'timing': return <TimingConfig store={store} />;
      case 'bluetooth': return <BluetoothConfig store={store} />;
      case 'diagnostics': return <DiagnosticsPanel store={store} onOpenFirmwareWizard={setFirmwareWizardInfo} />;
    }
  };

  return (
    <>
      <Header
        store={store}
        showConsole={showConsole}
        onToggleConsole={() => setShowConsole(v => !v)}
        usbConnected={usbConnected}
        connectionType={connType}
        onConnectionChange={async (conn, type) => {
          setUsbConnected(conn);
          setConnType(conn ? type : null);
          if (conn) {
            const info = await getDeviceInfo();
            if (info) {
              debugLog('INF', 'USB', `Device: ${info.name} (FW: ${info.firmwareVersion})`);
              if (isFirmwareVersionSupported(info.firmwareVersion) === false) {
                debugLog('WRN', 'USB', `Firmware ${info.firmwareVersion} is older than the minimum supported ${MIN_SUPPORTED_FW_VERSION} -- some RPCs (device slot switching, peripheral connection status, etc.) may silently fail or time out.`);
                alert(`接続中のファームウェア (${info.firmwareVersion}) は、このStudioが前提とする最小バージョン (${MIN_SUPPORTED_FW_VERSION}) より古いです。\n\n一部の機能（デバイス設定バックアップ、接続状態表示など）が動作しない、または反応が遅くなることがあります。ファームウェアの更新をおすすめします。`);
              }
              // Electron only: compare against the CI-published firmware-latest
              // release. Fire and forget -- a null result (web build, gh CLI
              // missing/offline) just leaves the badge off.
              (window as any).electronAPI?.checkFirmwareLatest?.().then((latest: { name: string; publishedAt: string } | null) => {
                if (!latest) return;
                if (latest.publishedAt) setFwLatestPublishedAt(latest.publishedAt);
                const check = checkFirmwareUpdate(info.firmwareVersion, latest.name, latest.publishedAt);
                setFwUpdateAvailable(check.updateAvailable);
                if (check.updateAvailable) {
                  debugLog('INF', 'Editor', `Newer firmware available (${check.reason === 'version' ? `v${check.latestVersion}` : `newer v${check.latestVersion} build, published ${latest.publishedAt}`}) -- see the FW download button.`);
                  showToast('新しいファームウェアがあります（FWダウンロードボタンから取得）', 'local');
                }
              });
            }
            const ok = await requestUnlock();
            if (!ok) {
              debugLog('WRN', 'USB', 'Device is locked. Write operations will fail. Press studio_unlock combo on keyboard.');
            }
            // Cross-unit firmware consistency: the dongle reports L/R build
            // identities read over the split link. Warn immediately on a
            // hard mismatch; log-only for "unknown" (old peripheral FW or a
            // local build can't be compared, don't cry wolf). Fire and
            // forget -- old dongle firmware returns null here.
            getFirmwareInfo().then(fw => {
              if (!fw) return;
              const c = analyzeFirmwareConsistency(fw.self, fw.peripherals);
              debugLog(c.status === 'mismatch' ? 'ERR' : c.status === 'unknown' ? 'WRN' : 'INF', 'FW',
                `Dongle=${fw.self.stamp} #${fw.self.buildId || '?'} / R=${fw.peripherals[0]?.connected ? `${fw.peripherals[0].stamp} #${fw.peripherals[0].buildId || '?'}` : 'offline'} / L=${fw.peripherals[1]?.connected ? `${fw.peripherals[1].stamp} #${fw.peripherals[1].buildId || '?'}` : 'offline'} -- ${c.detail}`);
              if (c.status === 'mismatch') {
                showToast('⚠️ dongle/L/RのFWビルドが一致していません（診断タブ参照）', 'error');
              }
            });
          }
        }}
        unsaved={unsaved}
        wroteToDevice={wroteToDevice}
        fwUpdateAvailable={fwUpdateAvailable}
        fwLatestPublishedAt={fwLatestPublishedAt}
        onWrite={async () => {
          writeInProgressRef.current = true;
          try {
            if (!isUnlocked()) {
              debugLog('WRN', 'Editor', 'Device is locked. Attempting unlock...');
              const unlocked = await requestUnlock();
              if (!unlocked) {
                debugLog('ERR', 'Editor', 'Cannot write: device is locked. Press studio_unlock combo on keyboard.');
                alert('デバイスがロックされています。キーボードのstudio_unlockコンボを押してからもう一度試してください。');
                return;
              }
            }
            // Pre-write audit gate: errors mean parts of this config will be
            // silently skipped or broken on the device -- make it a conscious
            // decision. Warnings don't block.
            const preAudit = await runConfigAudit(store.exportProject());
            const preErrors = preAudit.filter(f => f.severity === 'error');
            if (preErrors.length > 0) {
              const summary = preErrors.slice(0, 3).map(f => `・${f.message}`).join('\n');
              if (!confirm(`設定監査でエラーが${preErrors.length}件見つかりました:\n\n${summary}${preErrors.length > 3 ? '\n…' : ''}\n\nこのままWriteしますか？（詳細は診断タブ）`)) {
                showToast('Writeを中止しました', 'local');
                return;
              }
            }
            // Auto-backup: what's on the device right now is (as far as we
            // know) the state captured at the last Read/Write -- stash it so
            // a bad Write can be rolled back from the File menu.
            if (lastDeviceSnapshotRef.current) {
              saveWriteBackup(lastDeviceSnapshotRef.current);
              debugLog('INF', 'Editor', 'Pre-write backup saved (File > Write前バックアップ)');
            }
            showToast('書き込み処理中... (1/5 レイヤー設定)', 'progress', { persist: true });
            debugLog('INF', 'Editor', `Writing keymap to device... (${store.dirtyKeys.size} keys modified)`);
            // Write layer names + LED colors
            for (const layer of store.layers) {
              await setLayerProps(layer.index, layer.name, layer.ledColor);
            }
            debugLog('INF', 'Editor', `Layer names and LED colors written (${store.layers.length} layers)`);
            // Write key bindings
            showToast('書き込み処理中... (2/5 キー割り当て)', 'progress', { persist: true });
            const keymapResult = await writeKeymapToDevice(store.layers, store.dirtyKeys);
            // Combos persist themselves per-RPC (no separate save step, unlike
            // the keymap subsystem's saveChanges() below) -- write regardless
            // of keymap dirty-key tracking, same as layer names/colors above.
            showToast('書き込み処理中... (3/5 コンボ)', 'progress', { persist: true });
            const comboResult = await writeCombosToDevice(store.combos);
            if (!comboResult.ok) {
              debugLog('WRN', 'Editor', 'Some combos failed to write -- check the console for details');
            } else {
              debugLog('INF', 'Editor', `Combos written (${store.combos.length})`);
            }
            if (!keymapResult.ok && Object.keys(keymapResult.written).length === 0) {
              debugLog('ERR', 'Editor', 'Write failed: device not connected');
              showToast('書き込みに失敗しました（未接続）', 'error');
              return;
            }
            showToast('書き込み処理中... (4/5 Flash保存)', 'progress', { persist: true });
            const saved = await saveChanges();
            if (!saved) {
              debugLog('ERR', 'Editor', 'Write failed: could not save to device flash -- check the console for details');
              showToast('書き込みに失敗しました（Flash保存エラー）', 'error');
              return;
            }
            // Read-back verification (USB only: a BLE re-read takes tens of
            // seconds and the transport is the same one that just acked every
            // write). Confirms what we wrote is what the device now reports.
            if (connType === 'usb') {
              showToast('書き込み処理中... (5/5 書き戻し検証)', 'progress', { persist: true });
              const verify = await verifyDeviceState(keymapResult.written, comboResult.expected);
              if (!verify.ok) {
                for (const m of verify.mismatches) {
                  debugLog('ERR', 'Verify', m);
                }
                showToast(`書き戻し検証で不一致${verify.mismatches.length}件（>_コンソール参照。File>バックアップから復元できます）`, 'error');
                return;
              }
              debugLog('INF', 'Verify', `Read-back verification passed (${Object.keys(keymapResult.written).length} keys, ${comboResult.expected.length} combos)`);
            }
            store.clearDirtyKeys();
            setUnsaved(false);
            setWroteToDevice(true);
            lastDeviceSnapshotRef.current = store.exportProject();
            debugLog('INF', 'Editor', 'Keymap written and saved to device flash');
            showToast(connType === 'usb' ? '実機のFlashに書き込みました（検証OK）' : '実機のFlashに書き込みました', 'device');
          } catch (e: any) {
            debugLog('ERR', 'Editor', `Write failed: ${e.message}`);
            showToast(`書き込みに失敗しました: ${e.message}`, 'error');
          } finally {
            writeInProgressRef.current = false;
          }
        }}
        onRead={handleRead}
        onSave={() => {
          store.autoSave();
          setUnsaved(false);
          debugLog('INF', 'Editor', 'Saved to LocalStorage');
          showToast('ブラウザのLocalStorageに保存しました', 'local');
        }}
      />

      <div className="app-layout">
        <div className="center-column">
          <KeyboardView store={store} />
          <div className="tab-panel">
            <div className="panel-tabs">
              {TABS.map(tab => (
                <button
                  key={tab.key}
                  className={`panel-tab ${store.activeTab === tab.key ? 'active' : ''}`}
                  onClick={() => store.setActiveTab(tab.key)}
                >
                  {tab.label}
                  {tab.badge !== undefined && <span className="badge">{tab.badge}</span>}
                </button>
              ))}
            </div>
            <div className="panel-content">
              {panelContent()}
            </div>
          </div>
        </div>
      </div>

      <DebugConsole visible={showConsole} />

      {firmwareWizardInfo && (
        <FirmwareUpdateWizard
          self={firmwareWizardInfo.self}
          peripherals={firmwareWizardInfo.peripherals}
          onClose={() => setFirmwareWizardInfo(null)}
        />
      )}

      {/* Footer */}
      <footer className="footer">
        <span className="footer-item">Conductor Monokey</span>
        <span className="footer-item">{store.layers.length} layers</span>
        <span className="footer-item">40 keys</span>
        <span className="footer-item">Cached</span>
        <span className="footer-spacer" />
        <span className="footer-item">Auto-saved to LocalStorage</span>
      </footer>

      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t, i) => (
            <div
              key={t.id}
              className="toast-item"
              style={{
                background: t.type === 'device' ? 'var(--success)' : t.type === 'local' ? 'var(--info)' : t.type === 'progress' ? 'var(--warning)' : 'var(--danger)',
                zIndex: MAX_TOASTS - i,
                transform: t.entering
                  ? 'translate(-50%, 16px) scale(0.92)'
                  : `translate(-50%, ${-i * 10}px) scale(${1 - i * 0.06})`,
                opacity: t.entering ? 0 : Math.max(1 - i * 0.3, 0.3),
              }}
            >
              {t.type === 'device' ? '🔌' : t.type === 'local' ? '💾' : t.type === 'progress' ? '⏳' : '✗'} {t.message}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default App;
