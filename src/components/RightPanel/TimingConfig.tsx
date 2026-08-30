import { useEffect, useState } from 'react';
import { KeymapStore } from '../../store/useKeymapStore';
import { isConnected, isUnlocked, requestUnlock, getTappingTerm, setTappingTerm, saveChanges, listBehaviors, getBehaviorDetails, getHoldTapPositions, setHoldTapPositions, getHoldTapFlavor, setHoldTapFlavor, getKeyRepeatEnabled, setKeyRepeatEnabled, unlockFailureMessage } from '../../services/usbService';
import { debugLog } from '../DebugConsole';
import { keyIdsToPositions, positionsToKeyIds } from '../../data/layout';
import { MiniKeyboardPicker } from './MiniKeyboardPicker';

interface Props {
  store: KeymapStore;
}

const PRESETS = [150, 175, 200, 250, 300];

// Named hold-tap behaviors with positional gating (hold-trigger-key-positions),
// defined in config/monokey.keymap. Resolved to a Studio behaviorId by name at
// runtime since local IDs aren't stable identifiers we can hardcode.
const POSITIONAL_HOLD_TAP_NAMES = ['mt_shift_z', 'lt6_j'] as const;

interface HoldTapEntry {
  name: string;
  behaviorId: number | null;
  keyIds: string[];
  hasOverride: boolean;
}

// Every hold-tap behavior instance in this keymap, and how it's identified
// to Studio: &mt/&lt report their built-in display-name, the project's own
// custom instances (config/monokey.keymap) have no display-name set so
// Studio falls back to their devicetree node label.
const FLAVOR_HOLD_TAP_NAMES = [
  { name: 'Mod-Tap', label: '&mt（親指段の汎用Modタップ）' },
  { name: 'Layer-Tap', label: '&lt（親指段の汎用レイヤータップ）' },
  { name: 'mt_shift', label: 'mt_shift（親指段のShift）' },
  { name: 'lt6_j', label: 'lt6_j（Jキー: layer6タップ）' },
  { name: 'mt_shift_z', label: 'mt_shift_z（Zキー: Shiftタップ）' },
] as const;

// Wire encoding matches firmware's enum flavor / the devicetree flavor
// property's enum string order -- 0-3, no translation needed either side.
const FLAVOR_OPTIONS = [
  { value: 0, name: 'hold-preferred', condition: '時間経過 or 他キー押下', fit: 'ショートカット即応重視' },
  { value: 1, name: 'balanced', condition: '時間経過 or 他キーの押下+解放', fit: 'ホームロウMod全般（定番）' },
  { value: 2, name: 'tap-preferred', condition: '時間経過のみ', fit: '誤ホールド絶対回避派' },
  { value: 3, name: 'tap-unless-interrupted', condition: '時間内の他キー押下のみ（時間経過では確定しない）', fit: '押しっぱなし癖がある方' },
] as const;

interface FlavorEntry {
  name: string;
  label: string;
  behaviorId: number | null;
  flavor: number;
  hasOverride: boolean;
}

export function TimingConfig({ store }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [holdTapEntries, setHoldTapEntries] = useState<HoldTapEntry[]>(
    POSITIONAL_HOLD_TAP_NAMES.map(name => ({ name, behaviorId: null, keyIds: [], hasOverride: false }))
  );
  const [holdTapLoaded, setHoldTapLoaded] = useState(false);
  const [editingHoldTap, setEditingHoldTap] = useState<string | null>(null);
  const [flavorEntries, setFlavorEntries] = useState<FlavorEntry[]>(
    FLAVOR_HOLD_TAP_NAMES.map(({ name, label }) => ({ name, label, behaviorId: null, flavor: 0, hasOverride: false }))
  );
  const [flavorLoaded, setFlavorLoaded] = useState(false);
  const [keyRepeatEnabled, setKeyRepeatEnabledState] = useState(false);
  const [keyRepeatLoaded, setKeyRepeatLoaded] = useState(false);
  const [keyRepeatBusy, setKeyRepeatBusy] = useState(false);

  useEffect(() => {
    if (!isConnected() || loaded) return;
    (async () => {
      const tt = await getTappingTerm();
      if (tt !== null) {
        store.setTappingTerm(tt);
        debugLog('INF', 'Timing', `Loaded tapping term: ${tt}ms`);
      }
      setLoaded(true);
    })();
  }, [loaded]);

  useEffect(() => {
    if (!isConnected() || keyRepeatLoaded) return;
    (async () => {
      const enabled = await getKeyRepeatEnabled();
      if (enabled !== null) {
        setKeyRepeatEnabledState(enabled);
        debugLog('INF', 'Timing', `Loaded key repeat emulation: ${enabled}`);
      }
      setKeyRepeatLoaded(true);
    })();
  }, [keyRepeatLoaded]);

  const toggleKeyRepeat = async () => {
    if (!isConnected()) { debugLog('WRN', 'Timing', 'Not connected'); return; }
    if (!isUnlocked() && !(await requestUnlock())) {
      alert(unlockFailureMessage());
      return;
    }
    setKeyRepeatBusy(true);
    const next = !keyRepeatEnabled;
    const ok = await setKeyRepeatEnabled(next);
    if (ok) {
      setKeyRepeatEnabledState(next);
    }
    setKeyRepeatBusy(false);
  };

  useEffect(() => {
    if (!isConnected() || holdTapLoaded) return;
    (async () => {
      const ids = await listBehaviors();
      const entries: HoldTapEntry[] = [];
      for (const name of POSITIONAL_HOLD_TAP_NAMES) {
        let behaviorId: number | null = null;
        for (const id of ids) {
          const details = await getBehaviorDetails(id);
          if (details?.displayName === name) { behaviorId = id; break; }
        }
        if (behaviorId === null) {
          entries.push({ name, behaviorId: null, keyIds: [], hasOverride: false });
          continue;
        }
        const positions = await getHoldTapPositions(behaviorId);
        entries.push({
          name,
          behaviorId,
          keyIds: positions ? positionsToKeyIds(positions.positions) : [],
          hasOverride: positions?.hasRuntimeOverride ?? false,
        });
      }
      setHoldTapEntries(entries);
      setHoldTapLoaded(true);
      debugLog('INF', 'Timing', `Loaded positional hold-tap config for ${entries.length} behaviors`);
    })();
  }, [holdTapLoaded]);

  useEffect(() => {
    if (!isConnected() || flavorLoaded) return;
    (async () => {
      const ids = await listBehaviors();
      const entries: FlavorEntry[] = [];
      for (const { name, label } of FLAVOR_HOLD_TAP_NAMES) {
        let behaviorId: number | null = null;
        for (const id of ids) {
          const details = await getBehaviorDetails(id);
          if (details?.displayName === name) { behaviorId = id; break; }
        }
        if (behaviorId === null) {
          entries.push({ name, label, behaviorId: null, flavor: 0, hasOverride: false });
          continue;
        }
        const result = await getHoldTapFlavor(behaviorId);
        entries.push({
          name,
          label,
          behaviorId,
          flavor: result?.flavor ?? 0,
          hasOverride: result?.hasRuntimeOverride ?? false,
        });
      }
      setFlavorEntries(entries);
      setFlavorLoaded(true);
      debugLog('INF', 'Timing', `Loaded hold-tap flavor config for ${entries.length} behaviors`);
    })();
  }, [flavorLoaded]);

  const toggleHoldTapKey = (name: string, keyId: string) => {
    setHoldTapEntries(prev => prev.map(e => e.name !== name ? e : {
      ...e,
      keyIds: e.keyIds.includes(keyId) ? e.keyIds.filter(k => k !== keyId) : [...e.keyIds, keyId],
    }));
  };

  const saveHoldTapPositions = async (entry: HoldTapEntry) => {
    if (entry.behaviorId === null) return;
    if (!isConnected()) { debugLog('WRN', 'Timing', 'Not connected'); return; }
    if (!isUnlocked() && !(await requestUnlock())) {
      alert(unlockFailureMessage());
      return;
    }
    const ok = await setHoldTapPositions(entry.behaviorId, keyIdsToPositions(entry.keyIds));
    if (ok) {
      setHoldTapEntries(prev => prev.map(e => e.name === entry.name ? { ...e, hasOverride: true } : e));
      debugLog('INF', 'Timing', `Saved hold-trigger positions for ${entry.name}`);
    }
  };

  const resetHoldTapPositions = async (entry: HoldTapEntry) => {
    if (entry.behaviorId === null) return;
    if (!isConnected()) { debugLog('WRN', 'Timing', 'Not connected'); return; }
    if (!isUnlocked() && !(await requestUnlock())) {
      alert(unlockFailureMessage());
      return;
    }
    const ok = await setHoldTapPositions(entry.behaviorId, [], true);
    if (ok) {
      const positions = await getHoldTapPositions(entry.behaviorId);
      setHoldTapEntries(prev => prev.map(e => e.name === entry.name ? {
        ...e,
        keyIds: positions ? positionsToKeyIds(positions.positions) : [],
        hasOverride: positions?.hasRuntimeOverride ?? false,
      } : e));
      debugLog('INF', 'Timing', `Reset ${entry.name} to devicetree default positions`);
    }
  };

  const setFlavorFor = async (entry: FlavorEntry, flavor: number) => {
    if (entry.behaviorId === null) return;
    if (!isConnected()) { debugLog('WRN', 'Timing', 'Not connected'); return; }
    if (!isUnlocked() && !(await requestUnlock())) {
      alert(unlockFailureMessage());
      return;
    }
    const ok = await setHoldTapFlavor(entry.behaviorId, flavor);
    if (ok) {
      setFlavorEntries(prev => prev.map(e => e.name === entry.name ? { ...e, flavor, hasOverride: true } : e));
      debugLog('INF', 'Timing', `Saved flavor for ${entry.name}: ${FLAVOR_OPTIONS[flavor]?.name}`);
    }
  };

  const resetFlavor = async (entry: FlavorEntry) => {
    if (entry.behaviorId === null) return;
    if (!isConnected()) { debugLog('WRN', 'Timing', 'Not connected'); return; }
    if (!isUnlocked() && !(await requestUnlock())) {
      alert(unlockFailureMessage());
      return;
    }
    const ok = await setHoldTapFlavor(entry.behaviorId, 0, true);
    if (ok) {
      const result = await getHoldTapFlavor(entry.behaviorId);
      setFlavorEntries(prev => prev.map(e => e.name === entry.name ? {
        ...e,
        flavor: result?.flavor ?? 0,
        hasOverride: result?.hasRuntimeOverride ?? false,
      } : e));
      debugLog('INF', 'Timing', `Reset ${entry.name} to devicetree default flavor`);
    }
  };

  const handleSave = async () => {
    if (!isConnected()) { debugLog('WRN', 'Timing', 'Not connected'); return; }
    if (!isUnlocked() && !(await requestUnlock())) {
      alert(unlockFailureMessage());
      return;
    }
    const ok = await setTappingTerm(store.tappingTerm);
    if (ok) {
      await saveChanges();
      debugLog('INF', 'Timing', `Tapping term saved: ${store.tappingTerm}ms`);
    }
  };

  return (
    <div>
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ flex: 1, marginRight: 8 }}>
            <div className="config-label">キーボード側キーリピート</div>
            <div className="config-description">
              ONにすると、キーを押し続けている間ホストOSの設定に関係なくキーボード自身が高速に離す→押すを繰り返し、連続入力を送信します
              （macOSで英字キーが長押しリピートせずアクセント候補が出てしまう問題への対策。修飾キー・メディアキーは対象外）。
              デフォルトOFF。
            </div>
          </div>
          <button
            onClick={toggleKeyRepeat}
            disabled={keyRepeatBusy}
            style={{
              width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', flexShrink: 0,
              background: keyRepeatEnabled ? 'var(--accent)' : 'var(--bg-hover)',
              position: 'relative', transition: 'background 0.2s', opacity: keyRepeatBusy ? 0.5 : 1,
            }}
          >
            <span style={{
              position: 'absolute', top: 2, left: keyRepeatEnabled ? 18 : 2,
              width: 16, height: 16, borderRadius: '50%', background: 'white',
              transition: 'left 0.2s',
            }} />
          </button>
        </div>
      </div>

      <div className="config-section">
        <div className="config-label">長押し判定時間</div>
        <div className="config-description">
          キーを押してからホールド（レイヤー切替・修飾キー）と判定するまでの時間を設定します。
          短いほど反応が速く、長いほどタップが安定します。
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Tapping Term</div>
        <div className="timing-value">
          {store.tappingTerm}<span className="timing-unit">ms</span>
        </div>

        <input
          type="range"
          className="timing-slider"
          min={100}
          max={400}
          step={5}
          value={store.tappingTerm}
          onChange={e => store.setTappingTerm(Number(e.target.value))}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
          <span>100ms（速い）</span>
          <span>400ms（遅い）</span>
        </div>
      </div>

      <div className="config-section">
        <div className="config-label">プリセット</div>
        <div className="timing-presets">
          {PRESETS.map(p => (
            <button
              key={p}
              className={`preset-btn ${store.tappingTerm === p ? 'selected' : ''}`}
              onClick={() => store.setTappingTerm(p)}
            >{p}ms</button>
          ))}
        </div>
      </div>

      <div className="save-actions">
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleSave}>デバイスに保存</button>
        <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setLoaded(false)}>再読込</button>
      </div>
      <div className="save-note">
        この設定はデバイスのFlashメモリに保存され、再起動後も維持されます。
        全てのlayer-tapキーとmod-tapキーに適用されます。
      </div>

      <div className="config-section">
        <div className="config-label">位置限定ホールドタップ</div>
        <div className="config-description">
          特定のレイヤータップ／modタップキーは、指定したキー（通常は反対の手）を押している間だけホールド判定されます。
          同じ手の高速な連続入力を誤ってホールドと判定しないようにするための設定です。
          対象キーがConductorD Studioでレイアウト変更された場合、この設定もあわせて更新してください（ファームウェア再ビルド不要）。
        </div>
        {holdTapEntries.map(entry => (
          <div key={entry.name} style={{ marginBottom: 12, padding: 8, background: 'var(--bg-secondary)', borderRadius: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>{entry.name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 8,
                  background: entry.hasOverride ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: entry.hasOverride ? 'white' : 'var(--text-muted)',
                }}>
                  {entry.hasOverride ? 'カスタム' : 'デフォルト'}
                </span>
                <button
                  className="btn btn-outline"
                  style={{ fontSize: 10, padding: '2px 6px' }}
                  onClick={() => setEditingHoldTap(editingHoldTap === entry.name ? null : entry.name)}
                  disabled={entry.behaviorId === null}
                >{editingHoldTap === entry.name ? '閉じる' : '編集'}</button>
              </div>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {entry.behaviorId === null ? '未検出（デバイスに存在しません）' : `${entry.keyIds.length}個のキーでホールド判定`}
            </div>
            {editingHoldTap === entry.name && entry.behaviorId !== null && (
              <div style={{ marginTop: 8 }}>
                <MiniKeyboardPicker selected={entry.keyIds} onToggle={id => toggleHoldTapKey(entry.name, id)} />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button className="btn btn-primary" style={{ flex: 1, fontSize: 11 }} onClick={() => saveHoldTapPositions(entry)}>保存</button>
                  <button className="btn btn-outline" style={{ flex: 1, fontSize: 11 }} onClick={() => resetHoldTapPositions(entry)}>デフォルトに戻す</button>
                </div>
              </div>
            )}
          </div>
        ))}
        <button className="btn btn-outline" style={{ width: '100%', fontSize: 11 }} onClick={() => setHoldTapLoaded(false)}>再読込</button>
      </div>

      <div className="config-section">
        <div className="config-label">Hold-Tap Flavor</div>
        <div className="config-description">
          長押し（hold）とタップ（tap）をどう判定するかの方式です。&mt/&lt/mt_shift/lt6_j/mt_shift_zそれぞれに個別設定できます。
          デバイスのFlashに保存され、ファームウェア再ビルド不要で即座に反映されます。
        </div>

        <div style={{ overflowX: 'auto', marginBottom: 10 }}>
          <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                <th style={{ padding: '4px 6px' }}>flavor</th>
                <th style={{ padding: '4px 6px' }}>ホールド確定の条件</th>
                <th style={{ padding: '4px 6px' }}>向いている人</th>
              </tr>
            </thead>
            <tbody>
              {FLAVOR_OPTIONS.map(f => (
                <tr key={f.value} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '4px 6px', fontFamily: 'monospace' }}>{f.name}</td>
                  <td style={{ padding: '4px 6px', color: 'var(--text-muted)' }}>{f.condition}</td>
                  <td style={{ padding: '4px 6px', color: 'var(--text-muted)' }}>{f.fit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {flavorEntries.map(entry => (
          <div key={entry.name} style={{ marginBottom: 12, padding: 8, background: 'var(--bg-secondary)', borderRadius: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{entry.label}</span>
              <span style={{
                fontSize: 9, padding: '1px 6px', borderRadius: 8,
                background: entry.hasOverride ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: entry.hasOverride ? 'white' : 'var(--text-muted)',
              }}>
                {entry.hasOverride ? 'カスタム' : 'デフォルト'}
              </span>
            </div>
            {entry.behaviorId === null ? (
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>未検出（デバイスに存在しません）</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
                  {FLAVOR_OPTIONS.map(f => (
                    <button
                      key={f.value}
                      className={`preset-btn ${entry.flavor === f.value ? 'selected' : ''}`}
                      style={{ fontSize: 10, fontFamily: 'monospace' }}
                      onClick={() => setFlavorFor(entry, f.value)}
                    >{f.name}</button>
                  ))}
                </div>
                <button
                  className="btn btn-outline"
                  style={{ width: '100%', fontSize: 10, marginTop: 6 }}
                  onClick={() => resetFlavor(entry)}
                  disabled={!entry.hasOverride}
                >デフォルトに戻す</button>
              </>
            )}
          </div>
        ))}
        <button className="btn btn-outline" style={{ width: '100%', fontSize: 11 }} onClick={() => setFlavorLoaded(false)}>再読込</button>
      </div>
    </div>
  );
}
