import { useEffect, useState } from 'react';
import { KeymapStore } from '../../store/useKeymapStore';
import { BindingType, Modifier } from '../../types';
import { KEY_CATEGORIES, searchKeyCodes } from '../../data/keycodes';
import { isConnected, isSameKeyPress, listCustomHoldTapBehaviors } from '../../services/usbService';

interface Props {
  store: KeymapStore;
  /** App's connection state (USB or BLE); the device reads re-run when it changes. */
  connected: boolean;
}

const BINDING_TYPES: { type: BindingType; label: string }[] = [
  { type: 'basic', label: 'Basic' },
  { type: 'mod-tap', label: 'Mod-Tap' },
  { type: 'layer-tap', label: 'Layer-Tap' },
  { type: 'momentary', label: 'Momentary' },
  { type: 'toggle', label: 'Toggle' },
  { type: 'to-layer', label: 'To Layer' },
  { type: 'trans', label: 'Trans' },
  { type: 'none', label: 'None' },
];

const LEFT_MODS: { mod: Modifier; label: string }[] = [
  { mod: 'lshift', label: 'L⇧' },
  { mod: 'lctrl', label: 'L⌃' },
  { mod: 'lalt', label: 'L⌥' },
  { mod: 'lgui', label: 'L⌘' },
];

const RIGHT_MODS: { mod: Modifier; label: string }[] = [
  { mod: 'rshift', label: 'R⇧' },
  { mod: 'rctrl', label: 'R⌃' },
  { mod: 'ralt', label: 'R⌥' },
  { mod: 'rgui', label: 'R⌘' },
];

export function KeyConfig({ store, connected }: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>('Letters');
  const [customHoldTaps, setCustomHoldTaps] = useState<{ id: number; name: string; kind: 'lt' | 'mt' }[] | null>(null);

  // Keyed on the connection so a tab opened before connecting still reads
  // the device's hold-tap behaviors once it is connected.
  useEffect(() => {
    if (!connected) { setCustomHoldTaps(null); return; }
    if (!isConnected() || customHoldTaps !== null) return;
    listCustomHoldTapBehaviors().then(setCustomHoldTaps);
  }, [connected, customHoldTaps]);

  const key = store.selectedKey;
  if (!key) {
    return <div className="right-panel-placeholder">Select a key to configure</div>;
  }

  const binding = key.binding;

  const updateBinding = (updates: Partial<typeof binding>) => {
    store.updateKeyBinding(store.selectedLayerIndex, key.id, { ...binding, ...updates });
  };

  const toggleModifier = (mod: Modifier) => {
    const mods = binding.modifiers || [];
    const newMods = mods.includes(mod) ? mods.filter(m => m !== mod) : [...mods, mod];
    updateBinding({ modifiers: newMods });
  };

  const filteredKeycodes = searchKeyCodes(searchQuery, selectedCategory || undefined);

  return (
    <div>
      <div className="key-info-header">
        <span className="key-info-id">{key.id}</span>
        <span className="key-info-type">{binding.type}</span>
      </div>

      <div className="config-section">
        <div className="config-label">Type</div>
        <div className="type-grid">
          {BINDING_TYPES.map(bt => (
            <button
              key={bt.type}
              className={`type-btn ${binding.type === bt.type ? 'selected' : ''}`}
              onClick={() => updateBinding({ type: bt.type })}
            >{bt.label}</button>
          ))}
        </div>
      </div>

      {(binding.type === 'mod-tap' || binding.type === 'layer-tap') && customHoldTaps && customHoldTaps.some(c => c.kind === (binding.type === 'layer-tap' ? 'lt' : 'mt')) && (
        <div className="config-section">
          <div className="config-label">カスタムbehavior</div>
          <div className="config-description">
            このキーが実際に使うbehaviorを選びます。選ばないと標準のLayer-Tap/Mod-Tapになり、Write時にカスタムbehaviorが失われます。
          </div>
          <div className="type-grid">
            <button
              className={`type-btn ${binding.behaviorId === undefined ? 'selected' : ''}`}
              onClick={() => updateBinding({ behaviorId: undefined })}
            >標準(&amp;{binding.type === 'layer-tap' ? 'lt' : 'mt'})</button>
            {customHoldTaps.filter(c => c.kind === (binding.type === 'layer-tap' ? 'lt' : 'mt')).map(c => (
              <button
                key={c.id}
                className={`type-btn ${binding.behaviorId === c.id ? 'selected' : ''}`}
                onClick={() => updateBinding({ behaviorId: c.id })}
              >{c.name}</button>
            ))}
          </div>
        </div>
      )}

      {(binding.type === 'basic' || binding.type === 'mod-tap' || binding.type === 'layer-tap') && (
        <div className="config-section">
          <div className="config-label">Modifiers</div>
          <button className="btn btn-outline" style={{ fontSize: 10, padding: '2px 6px', marginBottom: 6 }}>Presets</button>
          <div className="right-mod-section">
            <div className="right-mod-label">Left-side modifiers</div>
            <div className="mod-grid">
              {LEFT_MODS.map(m => (
                <button
                  key={m.mod}
                  className={`mod-btn ${binding.modifiers?.includes(m.mod) ? 'selected' : ''}`}
                  onClick={() => toggleModifier(m.mod)}
                >{m.label}</button>
              ))}
            </div>
          </div>
          <div className="right-mod-section">
            <div className="right-mod-label">Right-side modifiers</div>
            <div className="mod-grid">
              {RIGHT_MODS.map(m => (
                <button
                  key={m.mod}
                  className={`mod-btn ${binding.modifiers?.includes(m.mod) ? 'selected' : ''}`}
                  onClick={() => toggleModifier(m.mod)}
                >{m.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {(binding.type === 'basic' || binding.type === 'mod-tap' || binding.type === 'layer-tap') && (
        <div className="config-section">
          <div className="config-label">{binding.type === 'basic' ? 'Key Code' : 'Tap Key Code'}</div>
          <input
            type="text"
            className="keycode-search"
            placeholder="Search..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          <div className="keycode-categories">
            {KEY_CATEGORIES.map(cat => (
              <button
                key={cat}
                className={`category-btn ${selectedCategory === cat ? 'selected' : ''}`}
                onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
              >{cat}</button>
            ))}
          </div>
          <div className="keycode-grid">
            {filteredKeycodes.slice(0, 60).map(kc => {
              const isTapKey = binding.type === 'mod-tap' || binding.type === 'layer-tap';
              const currentCode = isTapKey ? binding.tapKeyCode : binding.keyCode;
              const currentLabel = isTapKey ? binding.tapLabel : binding.label;
              // Read-back keys carry the device-side spelling ("Ins", "LANG1",
              // "Esc") in both label and keyCode, which matches no picker
              // entry by text -- compare the key press itself as well.
              const isSelected = currentCode === kc.code || currentCode === kc.label || currentLabel === kc.label ||
                isSameKeyPress(currentLabel, currentCode, kc.label, kc.code);
              return (
                <button
                  key={kc.code}
                  className={`keycode-btn ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    if (isTapKey) {
                      updateBinding({ tapKeyCode: kc.code, tapLabel: kc.label });
                    } else {
                      updateBinding({ type: 'basic', keyCode: kc.code, label: kc.label });
                    }
                  }}
                >{kc.label}</button>
              );
            })}
          </div>
        </div>
      )}

      {(binding.type === 'layer-tap' || binding.type === 'momentary' || binding.type === 'toggle' || binding.type === 'to-layer') && (
        <div className="config-section">
          <div className="config-label">Layer</div>
          <div className="type-grid">
            {store.layers.map(l => (
              <button
                key={l.index}
                className={`type-btn ${binding.layer === l.index ? 'selected' : ''}`}
                onClick={() => updateBinding({ layer: l.index })}
              >{l.name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
