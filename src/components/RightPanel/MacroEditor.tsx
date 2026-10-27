import { useState, useEffect, useCallback } from 'react';
import { KeymapStore } from '../../store/useKeymapStore';
import { MacroAction } from '../../types';
import { writeMacroToDevice, isConnected, claimFreeMacroSlot, releaseMacroSlot, getFreeMacroSlots, saveChanges, registerMacroDeviceId, setMacro, computeMacroWireStepCount, MAX_MACRO_WIRE_STEPS } from '../../services/usbService';

interface Props {
  store: KeymapStore;
}

const ACTIONS: { value: MacroAction; label: string; desc: string }[] = [
  { value: 'macro_tap', label: 'Tap', desc: 'Press & release' },
  { value: 'macro_press', label: 'Press', desc: 'Hold down' },
  { value: 'macro_release', label: 'Release', desc: 'Let go' },
  { value: 'macro_wait_time', label: 'Wait', desc: 'Delay (ms)' },
];

const KEY_EVENT_TO_MACRO: Record<string, string> = {
  KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F', KeyG: 'G', KeyH: 'H',
  KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L', KeyM: 'M', KeyN: 'N', KeyO: 'O', KeyP: 'P',
  KeyQ: 'Q', KeyR: 'R', KeyS: 'S', KeyT: 'T', KeyU: 'U', KeyV: 'V', KeyW: 'W', KeyX: 'X',
  KeyY: 'Y', KeyZ: 'Z',
  Digit1: 'N1', Digit2: 'N2', Digit3: 'N3', Digit4: 'N4', Digit5: 'N5',
  Digit6: 'N6', Digit7: 'N7', Digit8: 'N8', Digit9: 'N9', Digit0: 'N0',
  Minus: 'MINUS', Equal: 'EQUAL', BracketLeft: 'LBKT', BracketRight: 'RBKT',
  Backslash: 'BSLH', Semicolon: 'SEMI', Quote: 'SQT', Backquote: 'GRAVE',
  Comma: 'COMMA', Period: 'DOT', Slash: 'FSLH',
  Enter: 'ENTER', Escape: 'ESC', Backspace: 'BSPC', Delete: 'DEL', Tab: 'TAB', Space: 'SPACE',
  CapsLock: 'CAPS', ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  Home: 'HOME', End: 'END', PageUp: 'PG_UP', PageDown: 'PG_DN',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  ShiftLeft: 'LSHIFT', ShiftRight: 'RSHIFT', ControlLeft: 'LCTRL', ControlRight: 'RCTRL',
  AltLeft: 'LALT', AltRight: 'RALT', MetaLeft: 'LGUI', MetaRight: 'RGUI',
  // Numpad row (e.g. a "number" layer bound to &kp KP_N1.. rather than
  // plain &kp N1..) reports separate Numpad* browser codes, distinct from
  // the top-row Digit* codes above -- without these, recording a macro
  // while that layer is held silently captured nothing for the digits.
  Numpad0: 'KP_N0', Numpad1: 'KP_N1', Numpad2: 'KP_N2', Numpad3: 'KP_N3', Numpad4: 'KP_N4',
  Numpad5: 'KP_N5', Numpad6: 'KP_N6', Numpad7: 'KP_N7', Numpad8: 'KP_N8', Numpad9: 'KP_N9',
  NumpadAdd: 'KP_PLUS', NumpadSubtract: 'KP_MINUS', NumpadMultiply: 'KP_STAR',
  NumpadDivide: 'KP_FSLH', NumpadDecimal: 'KP_DOT', NumpadEnter: 'KP_ENTER',
};

const MACRO_KEY_CATEGORIES = [
  { name: 'Letters', keys: 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z'.split(' ') },
  { name: 'Numbers', keys: 'N1 N2 N3 N4 N5 N6 N7 N8 N9 N0'.split(' ') },
  { name: 'Numpad', keys: 'KP_N1 KP_N2 KP_N3 KP_N4 KP_N5 KP_N6 KP_N7 KP_N8 KP_N9 KP_N0 KP_PLUS KP_MINUS KP_STAR KP_FSLH KP_DOT KP_ENTER'.split(' ') },
  { name: 'Symbols', keys: 'MINUS EQUAL LBKT RBKT BSLH SEMI SQT GRAVE COMMA DOT FSLH EXCL AT HASH DLLR PRCNT CARET AMPS STAR LPAR RPAR PLUS UNDER TILDE PIPE'.split(' ') },
  { name: 'Modifiers', keys: 'LSHIFT RSHIFT LCTRL RCTRL LALT RALT LGUI RGUI'.split(' ') },
  { name: 'Navigation', keys: 'ENTER ESC BSPC DEL TAB SPACE CAPS UP DOWN LEFT RIGHT HOME END PG_UP PG_DN'.split(' ') },
  { name: 'Function', keys: 'F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 F13 F14 F15 F16 F17 F18 F19 F20 F21 F22 F23 F24'.split(' ') },
  { name: 'Media', keys: 'C_VOL_UP C_VOL_DN C_MUTE C_PLAY_PAUSE C_NEXT C_PREV C_BRI_UP C_BRI_DN'.split(' ') },
  { name: 'IME', keys: 'LANG1 LANG2 LANG3 INT_RO INT_KANA INT_YEN'.split(' ') },
];

export function MacroEditor({ store }: Props) {
  const macro = store.selectedMacro;
  const idx = store.selectedMacroIndex;
  const [pickerStepIdx, setPickerStepIdx] = useState<number | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerCategory, setPickerCategory] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  // Record press/release separately so held keys (e.g. Cmd held while
  // tapping C) keep their real semantics; adjacent press+release of the
  // same key are collapsed into a tap when recording stops.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (idx === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return; // OS auto-repeat would flood duplicate steps
    const macroKey = KEY_EVENT_TO_MACRO[e.code];
    if (macroKey) {
      store.addMacroStep(idx, { action: 'macro_press', behavior: 'kp', param: macroKey });
    }
  }, [idx, store]);

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (idx === null) return;
    e.preventDefault();
    e.stopPropagation();
    const macroKey = KEY_EVENT_TO_MACRO[e.code];
    if (macroKey) {
      store.addMacroStep(idx, { action: 'macro_release', behavior: 'kp', param: macroKey });
    }
  }, [idx, store]);

  useEffect(() => {
    if (recording) {
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('keyup', handleKeyUp, true);
      return () => {
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('keyup', handleKeyUp, true);
      };
    }
  }, [recording, handleKeyDown, handleKeyUp]);

  const stopRecording = () => {
    setRecording(false);
    if (idx === null || macro === null) return;
    // press immediately followed by release of the same key == a tap
    const b = macro.bindings;
    const collapsed: typeof b = [];
    for (let i = 0; i < b.length; i++) {
      const cur = b[i], nxt = b[i + 1];
      if (cur.action === 'macro_press' && nxt?.action === 'macro_release' && nxt.param === cur.param) {
        collapsed.push({ ...cur, action: 'macro_tap' });
        i++;
      } else {
        collapsed.push(cur);
      }
    }
    if (collapsed.length !== b.length) store.updateMacro(idx, { bindings: collapsed });
  };

  useEffect(() => {
    setRecording(false);
  }, [idx]);

  if (macro === null || idx === null) {
    return <div className="right-panel-placeholder">Select a macro to edit</div>;
  }

  const pickKey = (stepIdx: number) => {
    setPickerStepIdx(stepIdx);
    setPickerSearch('');
    setPickerCategory(null);
  };

  const selectKey = (key: string) => {
    if (pickerStepIdx !== null) {
      store.updateMacroStep(idx, pickerStepIdx, { param: key });
      setPickerStepIdx(null);
    }
  };

  // Key picker overlay
  if (pickerStepIdx !== null) {
    const q = pickerSearch.toLowerCase();
    const filtered = MACRO_KEY_CATEGORIES
      .filter(cat => !pickerCategory || cat.name === pickerCategory)
      .map(cat => ({
        ...cat,
        keys: cat.keys.filter(k => !q || k.toLowerCase().includes(q)),
      }))
      .filter(cat => cat.keys.length > 0);

    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Select Key</span>
          <button className="btn" style={{ fontSize: 12 }} onClick={() => setPickerStepIdx(null)}>✕ Close</button>
        </div>
        <input
          type="text"
          placeholder="Search keys..."
          value={pickerSearch}
          onChange={e => setPickerSearch(e.target.value)}
          style={{ width: '100%', marginBottom: 8 }}
          autoFocus
        />
        <div className="keycode-categories" style={{ marginBottom: 8 }}>
          <button
            className={`category-btn ${!pickerCategory ? 'selected' : ''}`}
            onClick={() => setPickerCategory(null)}
          >All</button>
          {MACRO_KEY_CATEGORIES.map(cat => (
            <button
              key={cat.name}
              className={`category-btn ${pickerCategory === cat.name ? 'selected' : ''}`}
              onClick={() => setPickerCategory(pickerCategory === cat.name ? null : cat.name)}
            >{cat.name}</button>
          ))}
        </div>
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          {filtered.map(cat => (
            <div key={cat.name} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{cat.name}</div>
              <div className="keycode-grid">
                {cat.keys.map(k => (
                  <button key={k} className="keycode-btn" onClick={() => selectKey(k)}>{k}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="key-info-header">
        <button className="btn btn-outline" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => store.setSelectedMacroIndex(null)}>← 一覧</button>
        <span className="key-info-id">&amp;{macro.name}</span>
        <span className="key-info-type">{macro.bindings.length} steps</span>
      </div>

      {/* Name */}
      <div className="config-section">
        <div className="config-label">Name</div>
        <input
          type="text"
          value={macro.name}
          onChange={e => store.updateMacro(idx, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })}
          style={{ width: '100%' }}
          placeholder="macro_name"
        />
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          letters, numbers, underscores only
        </div>
      </div>

      {/* Timing */}
      <div className="config-section">
        <div className="config-label">Timing</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ flex: 1, fontSize: 11, color: 'var(--text-secondary)' }}>
            Wait (ms)
            <input
              type="number"
              value={macro.waitMs}
              min={0} max={5000}
              onChange={e => store.updateMacro(idx, { waitMs: parseInt(e.target.value) || 30 })}
              style={{ width: '100%', marginTop: 4 }}
            />
          </label>
          <label style={{ flex: 1, fontSize: 11, color: 'var(--text-secondary)' }}>
            Tap (ms)
            <input
              type="number"
              value={macro.tapMs}
              min={0} max={5000}
              onChange={e => store.updateMacro(idx, { tapMs: parseInt(e.target.value) || 30 })}
              style={{ width: '100%', marginTop: 4 }}
            />
          </label>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
          Wait: ステップ間の待ち時間 / Tap: キー押下の持続時間（Writeで実機に保存されます。FW 2026-10-27以降）
        </div>
      </div>

      {/* Write to Device */}
      {isConnected() && (macro.deviceId !== undefined || getFreeMacroSlots().length > 0) && (
        <div className="config-section" style={{ marginTop: 16 }}>
          <button
            className="btn"
            style={{ width: '100%', fontSize: 12, border: '1px solid var(--accent)', color: 'var(--accent)', padding: '6px' }}
            onClick={async () => {
              const freshlyClaimed = macro.deviceId === undefined;
              let targetId: number;
              if (freshlyClaimed) {
                const slot = claimFreeMacroSlot();
                if (slot === null) {
                  alert('No free macro slots on device.');
                  return;
                }
                targetId = slot;
              } else {
                targetId = macro.deviceId as number;
              }
              const wireSteps = computeMacroWireStepCount(macro);
              if (wireSteps > MAX_MACRO_WIRE_STEPS) {
                if (freshlyClaimed) releaseMacroSlot(targetId);
                alert(`Macro "${macro.name}" needs ${wireSteps} device steps (Tap counts as 2: press+release), but the firmware only supports ${MAX_MACRO_WIRE_STEPS}. Remove some steps or split it into multiple macros.`);
                return;
              }
              const ok = await writeMacroToDevice(targetId, macro);
              if (ok) {
                // Only commit local state once the device write actually
                // succeeded -- committing beforehand meant a failed write
                // still left Studio believing the macro exists in that
                // slot (registered in macroNameToDeviceId, deviceId set),
                // when the device itself has nothing there.
                if (freshlyClaimed) store.updateMacro(idx, { deviceId: targetId });
                registerMacroDeviceId(macro.name, targetId);
                const saved = await saveChanges();
                if (saved) {
                  alert(`Macro "${macro.name}" written and saved to device flash.`);
                } else {
                  alert(`Macro "${macro.name}" written but flash save failed.`);
                }
              } else {
                if (freshlyClaimed) releaseMacroSlot(targetId);
                alert('Failed to write macro to device.');
              }
            }}
          >Write to Device</button>
        </div>
      )}

      {isConnected() && macro.deviceId === undefined && getFreeMacroSlots().length === 0 && (
        <div className="config-section" style={{ marginTop: 16, fontSize: 11, color: 'var(--danger)' }}>
          実機の空きマクロスロットがありません。不要なマクロを削除してから再度お試しください。
        </div>
      )}

      {/* Record */}
      <div className="config-section" style={{ marginTop: 16 }}>
        <button
          className="btn"
          onClick={() => recording ? stopRecording() : setRecording(true)}
          style={{
            width: '100%',
            fontSize: 12,
            padding: '6px',
            background: recording ? 'var(--danger)' : undefined,
            color: recording ? '#fff' : 'var(--accent)',
            border: `1px solid ${recording ? 'var(--danger)' : 'var(--accent)'}`,
          }}
        >
          {recording ? '⏺ Recording... (click to stop)' : '⏺ Record keystrokes'}
        </button>
        {recording && (
          <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4, textAlign: 'center' }}>
            Type keys to add steps automatically
          </div>
        )}
      </div>

      {/* Steps */}
      <div className="config-section">
        <div className="config-label">
          Steps ({macro.bindings.length})
          {(() => {
            const wireSteps = computeMacroWireStepCount(macro);
            const over = wireSteps > MAX_MACRO_WIRE_STEPS;
            return (
              <span style={{ fontWeight: 'normal', color: over ? 'var(--danger)' : 'var(--text-muted)', marginLeft: 6 }}>
                — {wireSteps}/{MAX_MACRO_WIRE_STEPS} device steps{over ? ' (too many, Tap = 2 steps)' : ''}
              </span>
            );
          })()}
        </div>

        {macro.bindings.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0', textAlign: 'center' }}>
            No steps yet. Add a step below.
          </div>
        )}

        {macro.bindings.map((step, si) => (
          <div key={si} className="macro-step">
            <div className="macro-step-header">
              <span className="macro-step-num">{si + 1}</span>

              {/* Action selector */}
              <select
                className="macro-step-select"
                value={step.action}
                onChange={e => {
                  const action = e.target.value as MacroAction;
                  if (action === 'macro_wait_time') {
                    store.updateMacroStep(idx, si, { action, ms: step.ms || 100, behavior: undefined, param: undefined });
                  } else {
                    store.updateMacroStep(idx, si, { action, behavior: 'kp', param: step.param || 'SPACE', ms: undefined });
                  }
                }}
              >
                {ACTIONS.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>

              {/* Param */}
              {step.action === 'macro_wait_time' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <input
                    type="number"
                    value={step.ms || 100}
                    min={1} max={10000}
                    onChange={e => store.updateMacroStep(idx, si, { ms: parseInt(e.target.value) || 100 })}
                    style={{ width: 60 }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>ms</span>
                </div>
              ) : (
                <button
                  className="btn btn-outline"
                  style={{ fontSize: 11, padding: '3px 8px', flex: 1, textAlign: 'left', fontFamily: 'monospace' }}
                  onClick={() => pickKey(si)}
                >{step.param || '?'}</button>
              )}

              {/* Controls */}
              <div style={{ display: 'flex', gap: 1 }}>
                <button
                  className="btn btn-icon"
                  style={{ width: 22, height: 22, fontSize: 9 }}
                  onClick={() => store.moveMacroStep(idx, si, 'up')}
                  disabled={si === 0}
                  title="Move up"
                >▲</button>
                <button
                  className="btn btn-icon"
                  style={{ width: 22, height: 22, fontSize: 9 }}
                  onClick={() => store.moveMacroStep(idx, si, 'down')}
                  disabled={si === macro.bindings.length - 1}
                  title="Move down"
                >▼</button>
                <button
                  className="btn btn-icon"
                  style={{ width: 22, height: 22, fontSize: 9, color: 'var(--danger)' }}
                  onClick={() => store.removeMacroStep(idx, si)}
                  title="Remove"
                >✕</button>
              </div>
            </div>
          </div>
        ))}

        {/* Add step buttons */}
        <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
          <button
            className="btn btn-outline"
            style={{ flex: 1, fontSize: 11 }}
            onClick={() => store.addMacroStep(idx, { action: 'macro_tap', behavior: 'kp', param: 'SPACE' })}
          >+ Tap</button>
          <button
            className="btn btn-outline"
            style={{ flex: 1, fontSize: 11 }}
            onClick={() => store.addMacroStep(idx, { action: 'macro_press', behavior: 'kp', param: 'LSHIFT' })}
          >+ Press</button>
          <button
            className="btn btn-outline"
            style={{ flex: 1, fontSize: 11 }}
            onClick={() => store.addMacroStep(idx, { action: 'macro_release', behavior: 'kp', param: 'LSHIFT' })}
          >+ Release</button>
          <button
            className="btn btn-outline"
            style={{ flex: 1, fontSize: 11 }}
            onClick={() => store.addMacroStep(idx, { action: 'macro_wait_time', ms: 100 })}
          >+ Wait</button>
        </div>
      </div>

      {/* Delete */}
      <div className="config-section" style={{ marginTop: 16 }}>
        <button
          className="btn"
          style={{ width: '100%', color: 'var(--danger)', fontSize: 12, border: '1px solid var(--danger)', padding: '6px' }}
          onClick={async () => {
            if (!confirm(`Delete macro "${macro.name}"?`)) return;
            if (macro.deviceId !== undefined && isConnected()) {
              await setMacro(macro.deviceId, '', []);
              await saveChanges();
            }
            store.removeMacro(idx);
          }}
        >Delete macro</button>
      </div>
    </div>
  );
}
