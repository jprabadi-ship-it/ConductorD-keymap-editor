import { useEffect, useRef, useState } from 'react';
import { KeyButton } from './components/KeyboardView/KeyButton';
import { LEFT_KEYS, RIGHT_KEYS, KeyPosition, positionToKeyId, positionsToKeyIds } from './data/layout';
import { Layer, Combo, KeyBinding } from './types';
import {
  connectUsb, connectBle, disconnectUsb, disconnectBle, requestUnlock, readKeymap, getCombosFromDevice, getAutoLayer, getRuntimeState,
  adoptExistingBleConnection, onDeviceDisconnect, onDeviceReconnect, onActiveLayerChange, onKeyInputEvent, subscribeToInput,
} from './services/usbService';

interface LayerState {
  layers: Layer[];
  combos: Combo[];
  amlExcluded: string[];
  highestLayer: number;
  connected: boolean;
  pressedPositions: number[];
  battery?: BatteryLevels | null;
}

interface BatteryLevels {
  l: number | null;
  r: number | null;
}

// Physical anchor keys for the battery badges, one per hardware half.
// Position-based on purpose -- the badge marks the hardware half, not
// whatever binding the current layer puts there.
const BATTERY_ANCHOR_LEFT = 'L35';
const BATTERY_ANCHOR_RIGHT = 'R30';

// The popup can connect to a device on its own -- independent of whatever
// the (possibly not even open) main editor window is doing -- since it's
// just another page in the same app bundle with full access to usbService.
interface LocalConnection {
  connected: boolean;
  layers: Layer[];
  combos: Combo[];
  amlExcluded: string[];
  highestLayer: number;
  pressedPositions: number[];
  battery: BatteryLevels | null;
}

const EMPTY_LOCAL_CONNECTION: LocalConnection = {
  connected: false, layers: [], combos: [], amlExcluded: [], highestLayer: 0, pressedPositions: [], battery: null,
};

function BatteryBadge({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  return <span className="minimap-batt">{label} {value}%</span>;
}

function renderHalf(layer: Layer, positions: KeyPosition[], comboMap: Map<string, string>, amlExcluded: string[], pressedKeyIds: Set<string>, className: string, battMap: Map<string, { label: string; value: number | null }>) {
  const maxCol = Math.max(...positions.map(p => p.col));
  const maxRow = Math.max(...positions.map(p => p.row));
  const cells = [];
  for (let row = 0; row <= maxRow; row++) {
    for (let col = 0; col <= maxCol; col++) {
      const pos = positions.find(p => p.row === row && p.col === col);
      const keyConfig = pos && layer.keys.find(k => k.id === pos.id);
      const batt = pos && battMap.get(pos.id);
      const button = keyConfig && (
        <KeyButton
          key={pos!.id}
          keyConfig={keyConfig}
          // Reused as a "currently pressed" glow, not an editing selection --
          // this popup is read-only, so `selected` never means that here.
          selected={pressedKeyIds.has(pos!.id)}
          onClick={() => {}}
          comboName={comboMap.get(pos!.id)}
          isAmlExcluded={amlExcluded.includes(pos!.id)}
        />
      );
      cells.push(
        button
          ? (batt
              ? <div key={pos!.id} className="minimap-batt-anchor">
                  {button}
                  <BatteryBadge label={batt.label} value={batt.value} />
                </div>
              : button)
          : <div key={`empty-${className}-${row}-${col}`} />
      );
    }
  }
  return <div className={`keyboard-half ${className}`}>{cells}</div>;
}

// Leaves a little breathing room around the scaled content instead of
// letting it touch the window edges exactly.
const FIT_MARGIN = 0.94;

export function LayerPopup() {
  const [state, setState] = useState<LayerState | null>(null);
  const [localConn, setLocalConn] = useState<LocalConnection>(EMPTY_LOCAL_CONNECTION);
  const [connecting, setConnecting] = useState<'usb' | 'bluetooth' | null>(null);
  // Which transport the popup's own connection used -- needed to pick the
  // right disconnect call. null when the popup never connected itself.
  const [connType, setConnType] = useState<'usb' | 'bluetooth' | null>(null);
  const [showMinimap, setShowMinimap] = useState(true);
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Tracks whether THIS popup was the one locally connected, so the tray
  // "disconnected" notification only fires on a real connect->disconnect
  // transition (see the tray-relay effect below).
  const wasLocallyConnected = useRef(false);

  useEffect(() => {
    const api = (window as any).electronAPI;
    return api?.onLayerState?.((s: LayerState) => setState(s));
  }, []);

  useEffect(() => {
    const api = (window as any).electronAPI;
    return api?.onShowMinimap?.((show: boolean) => setShowMinimap(show));
  }, []);

  // Picked independently from the main editor window's own toggle (this is
  // a separate renderer, so it doesn't share React/DOM state with it) --
  // just applies the attribute the CSS already keys its dark/light rules on.
  useEffect(() => {
    const api = (window as any).electronAPI;
    // Pull the initial prefs instead of relying on a push: the show-time
    // set-theme IPC can fire before this listener exists (lost on launch,
    // which left the dark default rendering as light).
    api?.getPopupPrefs?.().then((prefs: { theme: 'light' | 'dark'; showMinimap: boolean } | null) => {
      if (!prefs) return;
      document.documentElement.setAttribute('data-theme', prefs.theme);
      setShowMinimap(prefs.showMinimap);
    });
    return api?.onSetTheme?.((theme: 'light' | 'dark') => {
      document.documentElement.setAttribute('data-theme', theme);
    });
  }, []);

  // Live layer/key-press streaming for a connection made directly from this
  // popup (see handleConnect below) -- harmless no-ops if never connected.
  useEffect(() => {
    onDeviceDisconnect(() => {
      setLocalConn(c => ({ ...c, connected: false, pressedPositions: [] }));
      setConnType(null);
    });
    // usbService reopens the port by itself once the device returns from an
    // unexpected loss; without this the minimap would keep showing
    // "disconnected" over a connection that is actually live again.
    onDeviceReconnect(() => {
      setLocalConn(c => ({ ...c, connected: true }));
      setConnType('usb');
      subscribeToInput(true);
    });
    onActiveLayerChange(highestLayer => {
      setLocalConn(c => ({ ...c, highestLayer }));
    });
    onKeyInputEvent((position, pressed) => {
      setLocalConn(c => ({
        ...c,
        pressedPositions: pressed
          ? (c.pressedPositions.includes(position) ? c.pressedPositions : [...c.pressedPositions, position])
          : c.pressedPositions.filter(p => p !== position),
      }));
    });
  }, []);

  // Battery isn't pushed by the device, so refresh it periodically for a
  // connection made from this popup (the main-window path gets battery via
  // the relayed layer-state IPC instead).
  useEffect(() => {
    if (!localConn.connected) return;
    const interval = setInterval(async () => {
      const runtime = await getRuntimeState();
      if (runtime) {
        setLocalConn(c => ({ ...c, battery: { l: runtime.peripheralL, r: runtime.peripheralR } }));
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [localConn.connected]);

  // Relay this popup's own connection state to the Electron main process too
  // (see electron/main.cjs's 'layer-state' handler / updateTrayBatteryIcon)
  // -- previously only App.tsx (the main Studio window) did this, so
  // connecting from the minimap directly (without ever opening Studio) left
  // the tray's battery display permanently blank. Only sent while this
  // popup holds its own local connection, not while displaying a
  // Studio-relayed remote one (that data already made this same round trip
  // from the other window).
  useEffect(() => {
    if (!localConn.connected) {
      // Only notify the tray on an actual local-connection->disconnect
      // transition, not on initial mount (localConn starts unconnected even
      // while the Studio window has its own active connection -- sending
      // "disconnected" unconditionally here would incorrectly blank the
      // tray's battery display whenever the popup itself isn't the one
      // connected, e.g. while just showing Studio-relayed remote state).
      if (wasLocallyConnected.current) {
        wasLocallyConnected.current = false;
        (window as any).electronAPI?.sendLayerState?.({
          layers: [], combos: [], amlExcluded: [], highestLayer: 0,
          connected: false, pressedPositions: [], battery: null,
        });
      }
      return;
    }
    wasLocallyConnected.current = true;
    (window as any).electronAPI?.sendLayerState?.({
      layers: localConn.layers, combos: localConn.combos, amlExcluded: localConn.amlExcluded,
      highestLayer: localConn.highestLayer, connected: true, pressedPositions: localConn.pressedPositions,
      battery: localConn.battery,
    });
  }, [localConn.connected, localConn.layers, localConn.combos, localConn.amlExcluded, localConn.highestLayer, localConn.pressedPositions, localConn.battery]);

  // Port handoff with the Studio window: when Studio wants to connect we
  // release our connection (remembering the transport), and when Studio
  // disconnects we silently take it back. Refs, not state, because the IPC
  // listeners below are registered once and must see current values.
  const connTypeRef = useRef<'usb' | 'bluetooth' | null>(null);
  const releasedTypeRef = useRef<'usb' | 'bluetooth' | null>(null);
  useEffect(() => { connTypeRef.current = connType; }, [connType]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    const offRelease = api?.onReleasePort?.(async () => {
      const type = connTypeRef.current;
      if (!type) {
        api.portReleased(null);
        return;
      }
      await (type === 'usb' ? disconnectUsb() : disconnectBle());
      setLocalConn(EMPTY_LOCAL_CONNECTION);
      setConnType(null);
      releasedTypeRef.current = type;
      api.portReleased({ type });
    });
    const offReclaim = api?.onReclaimPort?.(() => {
      const type = releasedTypeRef.current;
      releasedTypeRef.current = null;
      // USB can reconnect without a user gesture (the permission is already
      // granted); BLE requires a click, so the connect button reappears and
      // one tap restores it.
      if (type === 'usb') handleConnectRef.current('usb', { silent: true });
    });
    return () => { offRelease?.(); offReclaim?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Everything after the link is up -- shared by connecting ourselves and by
  // adopting a connection another window already opened.
  const loadConnectedState = async (type: 'usb' | 'bluetooth') => {
      await requestUnlock();
      await subscribeToInput(true);

      const [result, combos, aml, runtime] = await Promise.all([
        readKeymap(), getCombosFromDevice(), getAutoLayer(), getRuntimeState(),
      ]);
      if (!result?.layers) return;

      const layers: Layer[] = result.layers.map((dl: any) => ({
        name: dl.name,
        index: dl.id,
        ledColor: dl.ledColor ?? '#000000',
        isProtected: false,
        keys: Object.entries(dl.bindings as Record<string, KeyBinding>).map(([id, binding]) => ({ id, binding })),
      }));

      setLocalConn({
        connected: true,
        layers,
        combos: combos ?? [],
        amlExcluded: aml ? positionsToKeyIds(aml.excludedPositions) : [],
        highestLayer: runtime?.highestLayer ?? 0,
        pressedPositions: [],
        battery: runtime ? { l: runtime.peripheralL, r: runtime.peripheralR } : null,
      });
      setConnType(type);
  };

  const handleConnect = async (type: 'usb' | 'bluetooth', options?: { silent?: boolean }) => {
    setConnecting(type);
    try {
      const ok = type === 'usb' ? await connectUsb(options) : await connectBle();
      if (!ok) return;
      await loadConnectedState(type);
    } finally {
      setConnecting(null);
    }
  };
  // Keeps the once-registered reclaim IPC listener pointed at the latest
  // handleConnect (which closes over fresh state setters each render).
  const handleConnectRef = useRef(handleConnect);
  useEffect(() => { handleConnectRef.current = handleConnect; });

  // One native BLE link lives in the main process, so if the Studio window
  // already opened it, join that instead of sitting here showing
  // "disconnected" over a live device.
  const loadConnectedStateRef = useRef(loadConnectedState);
  useEffect(() => { loadConnectedStateRef.current = loadConnectedState; });
  useEffect(() => {
    adoptExistingBleConnection().then(adopted => {
      if (adopted) loadConnectedStateRef.current('bluetooth');
    });
  }, []);

  // A connection made directly from the popup takes priority over whatever
  // the main editor window last reported over IPC -- it's live and local to
  // this window, whereas `state` may just be the main window's stale/default
  // keymap if it was never connected either.
  const effective: LayerState | null = localConn.connected
    ? { layers: localConn.layers, combos: localConn.combos, amlExcluded: localConn.amlExcluded, highestLayer: localConn.highestLayer, connected: true, pressedPositions: localConn.pressedPositions, battery: localConn.battery }
    : state;

  const layer = effective ? effective.layers.find(l => l.index === effective.highestLayer) ?? effective.layers[0] : null;

  // Rescale the content to fit whenever the window is resized or the
  // content's own natural size changes (e.g. the minimap being toggled).
  // offsetWidth/offsetHeight are layout measurements, unaffected by the
  // transform we apply below, so this doesn't feed back into itself.
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const recompute = () => {
      const { offsetWidth: w, offsetHeight: h } = content;
      if (!w || !h) return;
      const fit = Math.min(container.clientWidth / w, container.clientHeight / h) * FIT_MARGIN;
      setScale(fit > 0 ? fit : 1);
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(container);
    ro.observe(content);
    // Belt-and-suspenders: some window-resize paths don't reliably trigger
    // ResizeObserver in every environment, but always fire a resize event.
    window.addEventListener('resize', recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [layer, showMinimap]);

  // Right-click anywhere in the popup opens the opacity/minimap/theme menu
  // (the window is frameless, so there's no title bar to host it on).
  const onContextMenu = () => (window as any).electronAPI?.showPopupMenu?.();

  // Hidden feature: scroll over the popup to fade it in/out steplessly,
  // instead of picking from the menu's fixed percentages.
  const onWheel = (e: React.WheelEvent) => {
    (window as any).electronAPI?.adjustPopupOpacity?.(-e.deltaY / 800);
  };

  // The ❌ acts like a window close button: cut this popup's own connection
  // if it has one, then dismiss the minimap (reopen from the tray menu).
  const handleClose = async () => {
    if (connType === 'bluetooth') await disconnectBle();
    else if (connType === 'usb') await disconnectUsb();
    // onDeviceDisconnect also fires for real unplugs; calling the reset here
    // too keeps the UI immediate even if that callback is delayed.
    setLocalConn(EMPTY_LOCAL_CONNECTION);
    setConnType(null);
    (window as any).electronAPI?.hidePopup?.();
  };

  const openStudio = () => (window as any).electronAPI?.openStudio?.();

  const connectButtons = (
    <span className="layer-popup-connect-group">
      <button className="layer-popup-connect-btn" onClick={() => handleConnect('usb')} disabled={connecting !== null}>
        {connecting === 'usb' ? '接続中...' : 'USB接続'}
      </button>
      <button className="layer-popup-connect-btn" onClick={() => handleConnect('bluetooth')} disabled={connecting !== null}>
        {connecting === 'bluetooth' ? '接続中...' : 'BT接続'}
      </button>
    </span>
  );

  if (!layer) {
    return (
      <div className="layer-popup" onContextMenu={onContextMenu} onWheel={onWheel}>
        <div className="layer-popup-empty layer-popup-drag" style={{ flexDirection: 'column', gap: 8, position: 'relative' }}>
          <button className="layer-popup-close" style={{ position: 'fixed', top: 8, left: 8 }}
            onClick={handleClose} title="ミニマップを閉じる">✕</button>
          <span className="layer-popup-grip" title="ここを掴んで移動">⠿</span>
          <span>読み込み中...</span>
          {connectButtons}
          <button className="layer-popup-connect-btn" onClick={openStudio} title="Keymap Editor（Studio）を開く">
            Editorへ
          </button>
        </div>
      </div>
    );
  }

  // Same derivation as KeyboardView/useKeymapStore's comboOverlays.
  const comboMap = new Map<string, string>();
  effective!.combos.forEach(combo => combo.keyPositions.forEach(pos => comboMap.set(pos, combo.name)));

  const pressedKeyIds = new Set(effective!.pressedPositions.map(positionToKeyId).filter((id): id is string => id !== null));

  const battMap = new Map<string, { label: string; value: number | null }>();
  if (effective!.battery) {
    battMap.set(BATTERY_ANCHOR_LEFT, { label: 'L', value: effective!.battery.l });
    battMap.set(BATTERY_ANCHOR_RIGHT, { label: 'R', value: effective!.battery.r });
  }

  return (
    <div className="layer-popup" onContextMenu={onContextMenu} onWheel={onWheel} ref={containerRef}>
      <div className="layer-popup-content" ref={contentRef} style={{ transform: `scale(${scale})` }}>
        <div className="layer-popup-header layer-popup-drag">
          <button className="layer-popup-close" onClick={handleClose}
            title={localConn.connected ? '切断してミニマップを閉じる' : 'ミニマップを閉じる'}>✕</button>
          <span className="layer-popup-grip" title="ここを掴んで移動">⠿</span>
          <span className="led-dot" style={{ width: 10, height: 10, borderRadius: '50%', background: layer.ledColor }} />
          <span>{layer.name}</span>
          {!effective!.connected && connectButtons}
          <button className="layer-popup-connect-btn" onClick={openStudio} title="Keymap Editor（Studio）を開く">
            Editorへ
          </button>
          <button
            className="layer-popup-menu-btn"
            onClick={onContextMenu}
            title="設定（不透明度・ミニマップ・テーマ）"
          >⋮</button>
        </div>

        <div className="keyboard-container">
          {renderHalf(layer, LEFT_KEYS, comboMap, effective!.amlExcluded, pressedKeyIds, 'left', battMap)}
          {renderHalf(layer, RIGHT_KEYS, comboMap, effective!.amlExcluded, pressedKeyIds, 'right', battMap)}
        </div>

        {showMinimap && (
          <div className="layer-switcher">
            {effective!.layers.map(l => (
              <div key={l.index} className={`layer-dot ${l.index === layer.index ? 'active' : ''}`} title={l.name}>
                <span className="layer-dot-circle" style={{ background: l.ledColor }} />
                <span className="layer-dot-label">{l.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
