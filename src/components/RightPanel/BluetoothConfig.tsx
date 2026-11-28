import { useEffect, useState } from 'react';
import { KeymapStore } from '../../store/useKeymapStore';
import { KeyBinding, Modifier } from '../../types';
import {
  isConnected, getBleProfiles, setBleProfileName, getOsConfig, setOsConfig, getUsbSlots, setUsbSlotName, deviceNameByteLength, DEVICE_NAME_MAX_BYTES,
  getGestureConfig, setGestureEnabled, setGestureBinding, resolveKeyBindingRpc, gestureBindingLabel,
  ensureBehaviorsLoaded,
} from '../../services/usbService';
import { KEY_CATEGORIES, KEYCODES, searchKeyCodes } from '../../data/keycodes';
import {
  SHARED_GESTURE_LAYER, Direction, GESTURE_POSITIONS, DIRECTION_INDEX, DIRECTION_LABELS, overrideSlot, buildDeviceEntries,
} from '../../data/devices';
import { debugLog } from '../DebugConsole';

interface Props {
  store: KeymapStore;
  /** App's connection state (USB or BLE); the device reads re-run when it changes. */
  connected: boolean;
}

const MOD_BUTTONS: { key: Modifier; label: string }[] = [
  { key: 'lctrl', label: '⌃' }, { key: 'lshift', label: '⇧' },
  { key: 'lalt', label: '⌥' }, { key: 'lgui', label: '⌘' },
];

function bindingAt(store: KeymapStore, layerId: number, keyId: string): KeyBinding | undefined {
  return store.layers.find(l => l.index === layerId)?.keys.find(k => k.id === keyId)?.binding;
}

export function BluetoothConfig({ store, connected }: Props) {
  const [loaded, setLoaded] = useState(false);
  // 'usb:N' or 'bt:N'
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [usbSlots, setUsbSlots] = useState<{ name: string }[]>([]);
  const [usbActiveIndex, setUsbActiveIndex] = useState(0);
  const [usbSlotsLoaded, setUsbSlotsLoaded] = useState(false);
  const [copyPickerDevice, setCopyPickerDevice] = useState<number | null>(null);
  const [copyDestinations, setCopyDestinations] = useState<Set<number>>(new Set());
  const [copyBusy, setCopyBusy] = useState(false);

  const {
    gestureHasOverride, setGestureHasOverride, gestureOverrides, setGestureOverrides,
    expandedDevice, setExpandedDevice, editingDirection, setEditingDirection,
  } = store;
  const [gestureLoaded, setGestureLoaded] = useState(false);
  const [osMap, setOsMap] = useState<number[]>([]);
  const [osLoaded, setOsLoaded] = useState(false);
  const [gestureSearch, setGestureSearch] = useState('');
  const [gestureCategory, setGestureCategory] = useState<string | null>(null);
  const [gestureMods, setGestureMods] = useState<Modifier[]>([]);

  // The loaders below run once per connection: dropping the flags when the
  // device goes away makes them read again when it comes back, including when
  // the tab was opened before connecting.
  useEffect(() => {
    if (connected) return;
    setLoaded(false); setGestureLoaded(false); setOsLoaded(false); setUsbSlotsLoaded(false);
  }, [connected]);

  // Load real profile names/connection state from the device on mount.
  useEffect(() => {
    if (!connected || !isConnected() || loaded) return;
    (async () => {
      const result = await getBleProfiles();
      if (result) {
        store.setBluetoothProfiles(store.bluetoothProfiles.map((p, i) => ({
          ...p,
          name: result.profiles[i]?.name ?? p.name,
          connected: result.profiles[i]?.connected ?? p.connected,
          active: i === result.activeIndex,
        })));
        debugLog('INF', 'Bluetooth', `Loaded ${result.profiles.length} BT profiles (active: ${result.activeIndex})`);
      }
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, loaded]);

  // Load the per-device gesture binding overrides on mount.
  useEffect(() => {
    if (!connected || !isConnected() || gestureLoaded) return;
    (async () => {
      await ensureBehaviorsLoaded(); // so gestureBindingLabel() can resolve names
      const result = await getGestureConfig();
      if (result) {
        setGestureHasOverride(result.hasOverride);
        setGestureOverrides(result.overrides);
        debugLog('INF', 'Gesture', `Loaded gesture config: enabled=${result.enabled}, ${result.hasOverride.filter(Boolean).length} override(s)`);
      }
      setGestureLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, gestureLoaded]);

  // Load the per-device keymap overlay assignments on mount.
  useEffect(() => {
    if (!connected || !isConnected() || osLoaded) return;
    (async () => {
      const result = await getOsConfig();
      if (result) {
        setOsMap(result.osMap);
        debugLog('INF', 'Keymap', `Loaded OS overlay map: [${result.osMap.join(',')}]`);
      }
      setOsLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, osLoaded]);

  // Load the USB virtual slot names on mount.
  useEffect(() => {
    if (!connected || !isConnected() || usbSlotsLoaded) return;
    (async () => {
      const result = await getUsbSlots();
      if (result) {
        setUsbSlots(result.slots);
        setUsbActiveIndex(result.activeIndex);
        debugLog('INF', 'USB', `Loaded ${result.slots.length} USB slots (active: ${result.activeIndex})`);
      }
      setUsbSlotsLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, usbSlotsLoaded]);

  const startEdit = (key: string, currentName: string) => {
    setEditingKey(key);
    setEditValue(currentName);
  };

  const commitEdit = async () => {
    if (editingKey === null) return;
    const [kind, idxStr] = editingKey.split(':');
    const idx = Number(idxStr);
    const name = editValue.trim();
    setEditingKey(null);
    // The input's maxLength counts characters; the device limit is bytes.
    const bytes = deviceNameByteLength(name);
    if (bytes > DEVICE_NAME_MAX_BYTES) {
      alert(`名前が長すぎるため書き込めません(${bytes}バイト)。実機が受け取れるのは${DEVICE_NAME_MAX_BYTES}バイトまでです(英数字なら${DEVICE_NAME_MAX_BYTES}文字、日本語なら${Math.floor(DEVICE_NAME_MAX_BYTES / 3)}文字)。`);
      return;
    }
    if (kind === 'usb') {
      const ok = await setUsbSlotName(idx, name);
      if (ok) setUsbSlots(prev => prev.map((s, i) => i === idx ? { ...s, name } : s));
      return;
    }
    const ok = await setBleProfileName(idx, name);
    if (ok) {
      store.setBluetoothProfiles(store.bluetoothProfiles.map((p, i) => i === idx ? { ...p, name } : p));
    }
  };

  const setKeymapOverlay = async (endpointIndex: number, layerId: number) => {
    const newMap = [...osMap];
    while (newMap.length <= endpointIndex) newMap.push(0);
    newMap[endpointIndex] = layerId;
    const ok = await setOsConfig(true, newMap);
    if (ok) setOsMap(newMap);
  };

  const toggleExpanded = (endpointIndex: number) => {
    setCopyPickerDevice(null);
    if (expandedDevice === endpointIndex) {
      setExpandedDevice(null);
      setEditingDirection(null);
      return;
    }
    setExpandedDevice(endpointIndex);
    setEditingDirection(null);
  };

  const openDirection = (endpointIndex: number, direction: Direction) => {
    // Jump the keyboard canvas to the Gesture layer with this device selected
    // in its toolbar dropdown, so the two views stay in sync (and clicking
    // the arrow key there jumps back here — see KeyboardView.tsx).
    store.setActiveTab('layers');
    store.setSelectedLayerIndex(SHARED_GESTURE_LAYER);
    store.setSelectedGestureDevice(endpointIndex);

    if (expandedDevice === endpointIndex && editingDirection === direction) {
      setEditingDirection(null);
      return;
    }
    setEditingDirection(direction);
    setGestureSearch('');
    setGestureCategory(null);
    // Only the shared/default binding carries structured modifiers here (an
    // override is a raw behaviorId/param1 value); seed from that when there's
    // no override yet, otherwise start blank.
    const idx = overrideSlot(endpointIndex, direction);
    if (!gestureHasOverride[idx]) {
      const shared = bindingAt(store, SHARED_GESTURE_LAYER, GESTURE_POSITIONS[direction]);
      setGestureMods(shared?.modifiers ?? []);
    } else {
      setGestureMods([]);
    }
  };

  const applyGestureBinding = async (binding: KeyBinding) => {
    if (expandedDevice === null || editingDirection === null) return;
    const resolved = await resolveKeyBindingRpc(binding);
    if (!resolved) {
      alert('このキーの変換に失敗しました（ファームウェアにKey Press/Noneビヘイビアが見つかりません）。');
      return;
    }
    const idx = overrideSlot(expandedDevice, editingDirection);
    const ok = await setGestureBinding(expandedDevice, DIRECTION_INDEX[editingDirection], false, resolved);
    if (!ok) return;
    await setGestureEnabled(true);
    setGestureHasOverride(prev => { const next = [...prev]; next[idx] = true; return next; });
    setGestureOverrides(prev => { const next = [...prev]; next[idx] = resolved; return next; });
    setEditingDirection(null);
  };

  const resetToShared = async () => {
    if (expandedDevice === null || editingDirection === null) return;
    const idx = overrideSlot(expandedDevice, editingDirection);
    const ok = await setGestureBinding(expandedDevice, DIRECTION_INDEX[editingDirection], true);
    if (!ok) return;
    setGestureHasOverride(prev => { const next = [...prev]; next[idx] = false; return next; });
    setEditingDirection(null);
  };

  // Clears all 4 direction overrides for a device in one go, so switching a
  // device back to fully-shared gestures doesn't require clearing each
  // direction individually.
  const resetAllDeviceGestures = async (endpointIndex: number) => {
    const directions: Direction[] = ['up', 'down', 'left', 'right'];
    const cleared = new Set<Direction>();
    for (const dir of directions) {
      const ok = await setGestureBinding(endpointIndex, DIRECTION_INDEX[dir], true);
      if (ok) cleared.add(dir);
    }
    setGestureHasOverride(prev => {
      const next = [...prev];
      for (const dir of cleared) next[overrideSlot(endpointIndex, dir)] = false;
      return next;
    });
    setEditingDirection(null);
  };

  // Copies one device's overlay config (keymap overlay + all 4 gesture
  // overrides) onto another endpoint. Directions without an override on the
  // source are cleared on the destination so the result is an exact mirror.
  // Caller is responsible for busy/picker state -- see copyDeviceConfigToMany.
  const copyDeviceConfig = async (src: number, dest: number) => {
    await setKeymapOverlay(dest, osMap[src] || 0);
    const directions: Direction[] = ['up', 'down', 'left', 'right'];
    const applied: { dir: Direction; has: boolean }[] = [];
    for (const dir of directions) {
      const srcSlot = overrideSlot(src, dir);
      const has = !!gestureHasOverride[srcSlot];
      const ok = has
        ? await setGestureBinding(dest, DIRECTION_INDEX[dir], false, gestureOverrides[srcSlot])
        : await setGestureBinding(dest, DIRECTION_INDEX[dir], true);
      if (ok) applied.push({ dir, has });
    }
    if (applied.some(a => a.has)) await setGestureEnabled(true);
    setGestureHasOverride(prev => {
      const next = [...prev];
      for (const a of applied) next[overrideSlot(dest, a.dir)] = a.has;
      return next;
    });
    setGestureOverrides(prev => {
      const next = [...prev];
      for (const a of applied) {
        if (a.has) next[overrideSlot(dest, a.dir)] = gestureOverrides[overrideSlot(src, a.dir)];
      }
      return next;
    });
    debugLog('INF', 'Device', `Copied device config: endpoint ${src} -> ${dest} (${applied.length}/4 directions)`);
  };

  // Applies copyDeviceConfig to every selected destination in turn. Awaited
  // sequentially (not Promise.all) since each copy is itself a sequence of
  // RPC calls and the device only has one RPC channel to serve them on.
  const copyDeviceConfigToMany = async (src: number, dests: number[]) => {
    setCopyBusy(true);
    try {
      for (const dest of dests) {
        await copyDeviceConfig(src, dest);
      }
      debugLog('INF', 'Device', `Copied device config: endpoint ${src} -> ${dests.length} device(s)`);
    } finally {
      setCopyBusy(false);
      setCopyPickerDevice(null);
      setCopyDestinations(new Set());
    }
  };

  const devices = buildDeviceEntries(store.bluetoothProfiles, usbActiveIndex);

  return (
    <div>
      <div className="config-section">
        <div className="config-label">デバイス</div>
        <div className="config-description">
          出力先（USB 0〜4・BT 0〜4）ごとの設定です。クリックしてトラックボールジェスチャを個別設定できます。未設定の方向は共有ジェスチャ（Layer {SHARED_GESTURE_LAYER}）を使います。
        </div>

        {!loaded && (
          <div className="config-description">
            デバイスを接続・アンロックすると一覧が表示されます
          </div>
        )}

        {devices.map(dev => {
          const hasKeymapOverlay = (osMap[dev.endpointIndex] || 0) !== 0;
          const hasGestureOverride = (['up', 'down', 'left', 'right'] as const)
            .some(dir => gestureHasOverride[overrideSlot(dev.endpointIndex, dir)]);
          const isExpanded = expandedDevice === dev.endpointIndex;
          const editKey = dev.btIndex !== undefined ? `bt:${dev.btIndex}` : `usb:${dev.usbSlot}`;
          const currentName = dev.btIndex !== undefined
            ? (store.bluetoothProfiles[dev.btIndex]?.name || '')
            : (usbSlots[dev.usbSlot!]?.name || '');
          return (
            <div key={dev.endpointIndex}>
              <div
                className={`bt-profile ${isExpanded ? 'active' : ''}`}
                onClick={() => toggleExpanded(dev.endpointIndex)}
              >
                {dev.ledColor && (
                  <span className="led-dot" style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: dev.ledColor, flexShrink: 0,
                  }} />
                )}
                <span className="bt-profile-index">{dev.label}</span>
                <div className="bt-profile-info">
                  {editingKey === editKey ? (
                    <input
                      autoFocus
                      type="text"
                      style={{ fontSize: 12, padding: '2px 4px' }}
                      value={editValue}
                      maxLength={14}
                      onClick={e => e.stopPropagation()}
                      onChange={e => setEditValue(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitEdit();
                        if (e.key === 'Escape') setEditingKey(null);
                      }}
                    />
                  ) : (
                    <div className="bt-profile-name">
                      {currentName || (dev.btIndex !== undefined ? `Profile ${dev.btIndex}` : `USB ${dev.usbSlot}`)}
                    </div>
                  )}
                  <div className="bt-profile-status">
                    {dev.status && `${dev.status} ・ `}
                    {hasKeymapOverlay ? '個別キーマップ' : '共有キーマップ'}
                    {hasGestureOverride && ' ・ 個別ジェスチャ'}
                  </div>
                </div>
                <button
                  className="btn btn-outline"
                  style={{ fontSize: 10, padding: '2px 6px' }}
                  onClick={e => { e.stopPropagation(); startEdit(editKey, currentName); }}
                >✏️</button>
              </div>

              {isExpanded && (
                <div style={{ padding: '4px 8px 12px' }} onClick={e => e.stopPropagation()}>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>キーマップ</span>
                      {hasKeymapOverlay && (
                        <button
                          className="btn btn-outline"
                          style={{ fontSize: 10, padding: '1px 6px', marginLeft: 'auto' }}
                          onClick={() => {
                            store.setSelectedLayerIndex(osMap[dev.endpointIndex]);
                            store.setDiffMode(true);
                          }}
                        >⇄ 差分を見る</button>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 4 }}>
                      <button
                        className={`btn btn-outline ${!hasKeymapOverlay ? 'btn-active' : ''}`}
                        style={{ fontSize: 10, padding: '4px 6px' }}
                        onClick={() => setKeymapOverlay(dev.endpointIndex, 0)}
                      >なし（共有）</button>
                      {store.layers.filter(l => l.index !== 0).map(l => {
                        const active = (osMap[dev.endpointIndex] || 0) === l.index;
                        return (
                          <button
                            key={l.index}
                            className={`btn btn-outline ${active ? 'btn-active' : ''}`}
                            style={{ fontSize: 10, padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 4 }}
                            onClick={() => setKeymapOverlay(dev.endpointIndex, l.index)}
                          >
                            <span className="led-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: l.ledColor, flexShrink: 0 }} />
                            {l.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>ジェスチャ</span>
                    {hasGestureOverride && (
                      <button
                        className="btn btn-outline"
                        style={{ fontSize: 10, padding: '1px 6px', marginLeft: 'auto' }}
                        onClick={() => resetAllDeviceGestures(dev.endpointIndex)}
                      >全方向を共有に戻す</button>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
                    {(['up', 'down', 'left', 'right'] as const).map(dir => {
                      const dl = DIRECTION_LABELS[dir];
                      const idx = overrideSlot(dev.endpointIndex, dir);
                      const label = gestureHasOverride[idx]
                        ? gestureBindingLabel(gestureOverrides[idx])
                        : (bindingAt(store, SHARED_GESTURE_LAYER, GESTURE_POSITIONS[dir])?.label || '---');
                      const active = editingDirection === dir;
                      return (
                        <button
                          key={dir}
                          className={`btn btn-outline ${active ? 'btn-active' : ''}`}
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '6px', fontSize: 10, gap: 2 }}
                          onClick={() => openDirection(dev.endpointIndex, dir)}
                        >
                          <span style={{ color: 'var(--text-muted)' }}>{dl.icon} {dl.label}</span>
                          <span style={{ fontWeight: 600 }}>{label}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ marginTop: 8 }}>
                    <button
                      className={`btn btn-outline ${copyPickerDevice === dev.endpointIndex ? 'btn-active' : ''}`}
                      style={{ fontSize: 10, padding: '2px 6px' }}
                      onClick={() => {
                        setCopyDestinations(new Set());
                        setCopyPickerDevice(copyPickerDevice === dev.endpointIndex ? null : dev.endpointIndex);
                      }}
                    >⧉ この設定を他のデバイスへコピー</button>
                    {copyPickerDevice === dev.endpointIndex && (() => {
                      const otherDevices = devices.filter(d => d.endpointIndex !== dev.endpointIndex);
                      const allSelected = otherDevices.length > 0 && otherDevices.every(d => copyDestinations.has(d.endpointIndex));
                      const toggleDestination = (endpointIndex: number) => {
                        setCopyDestinations(prev => {
                          const next = new Set(prev);
                          if (next.has(endpointIndex)) next.delete(endpointIndex); else next.add(endpointIndex);
                          return next;
                        });
                      };
                      return (
                        <div style={{ marginTop: 6 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                              コピー先を選択（キーマップオーバーレイとジェスチャ4方向を上書きします）
                            </span>
                            <button
                              className="btn btn-outline"
                              style={{ fontSize: 9, padding: '1px 6px' }}
                              disabled={copyBusy}
                              onClick={() => setCopyDestinations(allSelected ? new Set() : new Set(otherDevices.map(d => d.endpointIndex)))}
                            >{allSelected ? 'すべて解除' : 'すべて選択'}</button>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 4 }}>
                            {otherDevices.map(d => {
                              const destName = d.btIndex !== undefined
                                ? (store.bluetoothProfiles[d.btIndex]?.name || '')
                                : (usbSlots[d.usbSlot!]?.name || '');
                              const selected = copyDestinations.has(d.endpointIndex);
                              return (
                                <button
                                  key={d.endpointIndex}
                                  className={`btn btn-outline ${selected ? 'btn-active' : ''}`}
                                  style={{ fontSize: 10, padding: '4px 6px' }}
                                  disabled={copyBusy}
                                  onClick={() => toggleDestination(d.endpointIndex)}
                                >{selected ? '✓ ' : ''}{d.label}{destName ? ` ${destName}` : ''}</button>
                              );
                            })}
                          </div>
                          <button
                            className="btn btn-primary"
                            style={{ fontSize: 11, padding: '4px 8px', marginTop: 6, width: '100%' }}
                            disabled={copyBusy || copyDestinations.size === 0}
                            onClick={() => copyDeviceConfigToMany(dev.endpointIndex, [...copyDestinations])}
                          >{copyBusy ? 'コピー中…' : `${copyDestinations.size}件へコピーを実行`}</button>
                        </div>
                      );
                    })()}
                  </div>

                  {editingDirection && (() => {
                    const dir = editingDirection;
                    const dl = DIRECTION_LABELS[dir];
                    const filteredKeycodes = gestureSearch
                      ? searchKeyCodes(gestureSearch)
                      : KEYCODES.filter(kc => kc.category === (gestureCategory || 'Navigation'));
                    const toggleMod = (mod: Modifier) => {
                      setGestureMods(prev => prev.includes(mod) ? prev.filter(m => m !== mod) : [...prev, mod]);
                    };
                    return (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                          {dl.icon} {dl.label}ジェスチャを編集
                        </div>
                        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                          {MOD_BUTTONS.map(m => (
                            <button key={m.key}
                              className={`btn btn-outline ${gestureMods.includes(m.key) ? 'btn-active' : ''}`}
                              style={{ fontSize: 12, padding: '4px 8px', minWidth: 32 }}
                              onClick={() => toggleMod(m.key)}>
                              {m.label}
                            </button>
                          ))}
                        </div>
                        <input
                          value={gestureSearch}
                          onChange={e => setGestureSearch(e.target.value)}
                          placeholder="キーを検索 (例: TAB, UP, C)"
                          style={{ width: '100%', padding: '4px 8px', fontSize: 11, marginBottom: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)' }}
                        />
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 4 }}>
                          {KEY_CATEGORIES.filter(c => ['Letters', 'Numbers', 'Navigation', 'Symbols', 'Media', 'Function', 'Modifiers'].includes(c)).map(cat => (
                            <button key={cat} className={`btn btn-outline ${gestureCategory === cat ? 'btn-active' : ''}`}
                              style={{ fontSize: 9, padding: '2px 4px' }}
                              onClick={() => { setGestureCategory(cat); setGestureSearch(''); }}>
                              {cat}
                            </button>
                          ))}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2, maxHeight: 120, overflowY: 'auto', marginBottom: 4 }}>
                          {filteredKeycodes.slice(0, 40).map(kc => (
                            <button key={kc.code} className="keycode-btn"
                              style={{ fontSize: 10, padding: '4px 2px' }}
                              onClick={() => applyGestureBinding({
                                type: 'basic', keyCode: kc.code, label: kc.label,
                                modifiers: gestureMods.length > 0 ? gestureMods : undefined,
                              })}>
                              {kc.label}
                            </button>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-outline" style={{ fontSize: 11, flex: 1 }} onClick={resetToShared}>デフォルト</button>
                          <button className="btn btn-outline" style={{ fontSize: 11, flex: 1 }}
                            onClick={() => applyGestureBinding({ type: 'none', keyCode: 'NONE', label: '' })}>なし</button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}

        <div className="config-description" style={{ marginTop: 8 }}>
          USBケーブルは物理的に1本しかないため、USB 0〜4はソフトウェア上の仮想スロットです。設定レイヤーの USB_SEL キーで切り替え、どのホスト（Windows PC・Mac・iPad・Androidなど）に繋いでいるかを手動で選べます。
          BT 0〜4は1台ずつホスト（PC・スマホなど）とペアリングできます。BT_SEL キーで切り替え、どちらも鉛筆アイコンから名前（最大14バイト・日本語約4文字）を付けられます。
          「デフォルト」はその方向のオーバーライドを解除し、共有ジェスチャ（Layer {SHARED_GESTURE_LAYER}）に戻します。ジェスチャの変更は即座に反映されます（Write不要）。
        </div>
      </div>
    </div>
  );
}
