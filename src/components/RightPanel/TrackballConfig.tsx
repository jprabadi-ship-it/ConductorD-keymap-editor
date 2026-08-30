import { useState, useEffect, useCallback, useRef } from 'react';
import { KeymapStore } from '../../store/useKeymapStore';
import { isConnected, isUnlocked, requestUnlock, setSensitivity, setAutoLayer, setPrecisionScale, setSpeedScale, setAccel, getSensitivity, getAutoLayer, getPrecisionScale, getSpeedScale, getAccel, getInertia, setInertia, getDragScale, setDragScale, saveChanges as savePointingChanges, getBleProfiles, getUsbSlots, setActiveBleProfile, setActiveUsbSlot, getOsConfig, getGestureConfig, unlockFailureMessage } from '../../services/usbService';
import { KEY_CATEGORIES, KEYCODES, searchKeyCodes } from '../../data/keycodes';
import { debugLog } from '../DebugConsole';
import { KEYBOARD_LAYOUT, keyIdsToPositions, positionsToKeyIds } from '../../data/layout';
import { buildDeviceEntries } from '../../data/devices';

interface Props {
  store: KeymapStore;
}

type SlotSummary = {
  endpointIndex: number;
  label: string;
  detail: string;
  cpi?: number;
  precision?: string;
  speed?: string;
  accel?: string;
  inertia?: string;
  drag?: string;
};

const CPI_PRESETS = [200, 400, 600, 800, 1200, 1600, 2400, 3200];
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0];
const SCROLL_PRESETS = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0];
const PRECISION_PRESETS = [
  { label: '1/8', value: 0.125 }, { label: '1/4', value: 0.25 },
  { label: '1/3', value: 0.33 }, { label: '1/2', value: 0.5 },
  { label: '2/3', value: 0.67 }, { label: '3/4', value: 0.75 },
  { label: '4/5', value: 0.8 }, { label: '9/10', value: 0.9 },
];
const ACCEL_OPTIONS = [
  { label: 'オフ', value: 0 }, { label: '弱', value: 1 },
  { label: '中', value: 2 }, { label: '強', value: 3 },
];
// decayMilli = 16msティックごとに残る速度x1000。大きいほど長く滑る
const INERTIA_DECAY_PRESETS = [
  { label: '短い', value: 850 }, { label: '標準', value: 900 }, { label: '長い', value: 950 },
];
const DRAG_SCALE_PRESETS = [
  { label: '1/4', num: 1, den: 4 }, { label: '1/2', num: 1, den: 2 }, { label: '2/3', num: 2, den: 3 },
];

const DIRECTION_LABELS: Record<string, { icon: string; label: string }> = {
  up: { icon: '↑', label: '上' },
  left: { icon: '←', label: '左' },
  right: { icon: '→', label: '右' },
  down: { icon: '↓', label: '下' },
};

function AmlMiniKeyboard({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) {
  const leftKeys = KEYBOARD_LAYOUT.filter(k => k.half === 'left');
  const rightKeys = KEYBOARD_LAYOUT.filter(k => k.half === 'right');
  const maxColL = Math.max(...leftKeys.map(k => k.col));
  const maxColR = Math.max(...rightKeys.map(k => k.col));
  const maxRow = Math.max(...KEYBOARD_LAYOUT.map(k => k.row));
  const S = 18;
  const G = 1;

  const renderHalf = (keys: typeof KEYBOARD_LAYOUT, maxCol: number) => {
    const cells: React.ReactNode[] = [];
    for (let row = 0; row <= maxRow; row++) {
      for (let col = 0; col <= maxCol; col++) {
        const pos = keys.find(p => p.row === row && p.col === col);
        if (pos) {
          const isSelected = selected.includes(pos.id);
          cells.push(
            <button key={pos.id} onClick={() => onToggle(pos.id)} style={{
              width: S, height: S, borderRadius: 2, border: '1px solid',
              borderColor: isSelected ? 'var(--accent)' : 'var(--border)',
              background: isSelected ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: isSelected ? 'white' : 'var(--text-muted)',
              fontSize: 5, cursor: 'pointer', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }} title={pos.id}>{pos.id.substring(1)}</button>
          );
        } else {
          cells.push(<div key={`e-${row}-${col}`} style={{ width: S, height: S }} />);
        }
      }
    }
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${maxCol + 1}, ${S}px)`, gap: G }}>
        {cells}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', gap: 3, justifyContent: 'center', padding: '4px 0' }}>
      {renderHalf(leftKeys, maxColL)}
      {renderHalf(rightKeys, maxColR)}
    </div>
  );
}

export function TrackballConfig({ store }: Props) {
  const { setAmlExcluded, trackballResetTick } = store;
  const [editingGesture, setEditingGesture] = useState<'up' | 'down' | 'left' | 'right' | null>(null);
  const [gestureSearch, setGestureSearch] = useState('');
  const [gestureCategory, setGestureCategory] = useState<string | null>(null);
  const [amlEnabled, setAmlEnabled] = useState(true);
  const [amlTimeout, setAmlTimeout] = useState(300);
  const [amlDuration, setAmlDuration] = useState(500);
  const [amlMinDistance, setAmlMinDistance] = useState(0);
  const [cpi, setCpi] = useState(800);
  const [scrollSensitivity, setScrollSensitivity] = useState(1.0);
  const [scrollDirection, setScrollDirection] = useState<'normal' | 'inverted'>('normal');
  const [precisionSensitivity, setPrecisionSensitivity] = useState(0.25);
  const [speedSensitivity, setSpeedSensitivity] = useState(1.0);
  const [accelMode, setAccelMode] = useState(1);
  const [realtimePreview, setRealtimePreview] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [accelMaxRatio, setAccelMaxRatio] = useState(1.2);
  const [accelStartSpeed, setAccelStartSpeed] = useState(10);
  const [accelRampWidth, setAccelRampWidth] = useState(28);
  const [inertiaEnabled, setInertiaEnabled] = useState(false);
  const [inertiaDecay, setInertiaDecay] = useState(900);
  const [inertiaStartSpeed, setInertiaStartSpeed] = useState(8);
  const [dragScaleEnabled, setDragScaleEnabled] = useState(false);
  const [dragScaleNum, setDragScaleNum] = useState(1);
  const [dragScaleDen, setDragScaleDen] = useState(2);
  const [loaded, setLoaded] = useState(false);
  const [slotEntries, setSlotEntries] = useState<ReturnType<typeof buildDeviceEntries>>([]);
  const [selectedEndpoint, setSelectedEndpoint] = useState(0);
  // Kept in sync with selectedEndpoint via effect below so reloadSlotSummaries
  // always reads the latest value even if it's invoked from a stale closure
  // (e.g. captured by an effect before a state update has flushed).
  const selectedEndpointRef = useRef(selectedEndpoint);
  useEffect(() => { selectedEndpointRef.current = selectedEndpoint; }, [selectedEndpoint]);
  const [profileTargetLabel, setProfileTargetLabel] = useState<string>('現在の出力先');
  const [loadingSlot, setLoadingSlot] = useState(false);
  const [slotSummaries, setSlotSummaries] = useState<SlotSummary[]>([]);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [trackballTab, setTrackballTab] = useState<'aml' | 'gesture' | 'cursor' | 'inertia'>('aml');

  const formatEntryLabel = useCallback((entry: ReturnType<typeof buildDeviceEntries>[number], bleProfiles?: Awaited<ReturnType<typeof getBleProfiles>>, usbSlots?: Awaited<ReturnType<typeof getUsbSlots>>) => {
    const renamed = entry.usbSlot !== undefined
      ? usbSlots?.slots[entry.usbSlot]?.name?.trim()
      : entry.btIndex !== undefined
        ? bleProfiles?.profiles[entry.btIndex]?.name?.trim()
        : '';
    return renamed ? `${entry.label} - ${renamed}` : entry.label;
  }, []);

  const loadSlotPointingSettings = useCallback(async (endpointIndex: number, options?: { preserveDeviceSelection?: boolean }) => {
    if (!isConnected()) return;
    setLoadingSlot(true);
    const [bleProfiles, usbSlots, osConfig, gestureConfig] = await Promise.all([
      getBleProfiles(),
      getUsbSlots(),
      getOsConfig(),
      getGestureConfig(),
    ]);

    if (!bleProfiles || !usbSlots) {
      setLoadingSlot(false);
      return;
    }

    const bluetoothProfiles = bleProfiles.profiles.map((profile, index) => ({
      index,
      name: profile.name || `BT ${index}`,
      ledColor: (['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'] as const)[index] ?? '#ffffff',
      connected: !!profile.connected,
      active: index === bleProfiles.activeIndex,
    }));
    const entries = buildDeviceEntries(bluetoothProfiles as any, usbSlots.activeIndex);
    setSlotEntries(entries);

    const entry = entries.find(item => item.endpointIndex === endpointIndex) ?? entries[0];
    if (!entry) {
      setLoadingSlot(false);
      return;
    }

    if (!options?.preserveDeviceSelection) {
      if (entry.usbSlot !== undefined) {
        await setActiveUsbSlot(entry.usbSlot);
      } else if (entry.btIndex !== undefined) {
        await setActiveBleProfile(entry.btIndex);
      }
    }

    const [sens, aml, prec, speed, acc, inertia, dragScale] = await Promise.all([
      getSensitivity(),
      getAutoLayer(),
      getPrecisionScale(),
      getSpeedScale(),
      getAccel(),
      getInertia(),
      getDragScale(),
    ]);

    if (sens) {
      setCpi(sens.cpi);
      if (sens.scrollDen > 0) setScrollSensitivity(sens.scrollNum / sens.scrollDen);
      setScrollDirection(sens.scrollInverted ? 'inverted' : 'normal');
    }
    if (aml) {
      setAmlEnabled(aml.enabled);
      setAmlTimeout(aml.requirePriorIdleMs);
      setAmlDuration(aml.durationMs);
      setAmlMinDistance(aml.motionThreshold);
      setAmlExcluded(positionsToKeyIds(aml.excludedPositions));
    }
    if (prec && prec.denominator > 0) {
      setPrecisionSensitivity(prec.numerator / prec.denominator);
    }
    if (speed && speed.denominator > 0) {
      setSpeedSensitivity(speed.numerator / speed.denominator);
    }
    if (acc) {
      setAccelMode(acc.enabled ? 1 : 0);
      setAccelMaxRatio(acc.maxMilli / 1000);
      setAccelStartSpeed(acc.threshold);
      setAccelRampWidth(acc.range);
    }
    if (inertia) {
      setInertiaEnabled(inertia.enabled);
      if (inertia.decayMilli > 0) setInertiaDecay(inertia.decayMilli);
      if (inertia.startSpeed > 0) setInertiaStartSpeed(inertia.startSpeed);
    }
    if (dragScale) {
      setDragScaleEnabled(dragScale.enabled);
      if (dragScale.numerator > 0) setDragScaleNum(dragScale.numerator);
      if (dragScale.denominator > 0) setDragScaleDen(dragScale.denominator);
    }

    setSelectedEndpoint(entry.endpointIndex);
    setProfileTargetLabel(formatEntryLabel(entry, bleProfiles, usbSlots));
    setLoaded(true);
    setLoadingSlot(false);

    const activeEndpoint = osConfig?.activeEndpoint ?? gestureConfig?.activeEndpoint ?? entry.endpointIndex;
    debugLog('INF', 'Trackball', `Loaded slot ${entry.label} (device active endpoint ${activeEndpoint})`);
  }, [formatEntryLabel, setAmlExcluded]);

  const reloadSlotSummaries = useCallback(async () => {
    if (!isConnected()) return;
    if (!window.confirm('全スロット比較のため、実機の出力先を一時的に順番に切り替えます（BLE接続の場合、切断されることがあります）。続行しますか？')) {
      return;
    }
    setLoadingSummary(true);
    const [bleProfiles, usbSlots, osConfig, gestureConfig] = await Promise.all([
      getBleProfiles(),
      getUsbSlots(),
      getOsConfig(),
      getGestureConfig(),
    ]);
    if (!bleProfiles || !usbSlots) {
      setLoadingSummary(false);
      return;
    }

    const bluetoothProfiles = bleProfiles.profiles.map((profile, index) => ({
      index,
      name: profile.name || `BT ${index}`,
      ledColor: (['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'] as const)[index] ?? '#ffffff',
      connected: !!profile.connected,
      active: index === bleProfiles.activeIndex,
    }));
    const entries = buildDeviceEntries(bluetoothProfiles as any, usbSlots.activeIndex);
    setSlotEntries(entries);

    const originalEndpoint = selectedEndpointRef.current ?? osConfig?.activeEndpoint ?? gestureConfig?.activeEndpoint;
    const summaries: SlotSummary[] = [];
    for (const entry of entries) {
      const selected = entry.usbSlot !== undefined
        ? await setActiveUsbSlot(entry.usbSlot)
        : await setActiveBleProfile(entry.btIndex ?? 0);
      if (!selected) {
        summaries.push({
          endpointIndex: entry.endpointIndex,
          label: entry.label,
          detail: formatEntryLabel(entry, bleProfiles, usbSlots),
        });
        continue;
      }
      const [sens, prec, speed, acc, inertia, dragScale] = await Promise.all([
        getSensitivity(),
        getPrecisionScale(),
        getSpeedScale(),
        getAccel(),
        getInertia(),
        getDragScale(),
      ]);
      summaries.push({
        endpointIndex: entry.endpointIndex,
        label: entry.label,
        detail: formatEntryLabel(entry, bleProfiles, usbSlots),
        cpi: sens?.cpi,
        precision: prec ? `${prec.numerator}/${prec.denominator}` : undefined,
        speed: speed ? `${speed.numerator}/${speed.denominator}` : undefined,
        accel: acc ? `${acc.enabled ? 'ON' : 'OFF'} ${acc.maxMilli / 1000}x` : undefined,
        inertia: inertia ? `${inertia.enabled ? 'ON' : 'OFF'} ${inertia.decayMilli}/${inertia.startSpeed}` : undefined,
        drag: dragScale ? `${dragScale.enabled ? 'ON' : 'OFF'} ${dragScale.numerator}/${dragScale.denominator}` : undefined,
      });
    }

    if (originalEndpoint === undefined) {
      debugLog('ERR', 'Trackball', '元の active output を特定できなかったため復元をスキップしました。現在の出力先を確認してください。');
    } else {
      const restoreEntry = entries.find(entry => entry.endpointIndex === originalEndpoint);
      if (restoreEntry?.usbSlot !== undefined) {
        await setActiveUsbSlot(restoreEntry.usbSlot);
      } else if (restoreEntry?.btIndex !== undefined) {
        await setActiveBleProfile(restoreEntry.btIndex);
      } else {
        debugLog('ERR', 'Trackball', '元の active output に一致するスロットが見つからず復元をスキップしました。');
      }
    }
    setSlotSummaries(summaries);
    setLoadingSummary(false);
  }, [formatEntryLabel]);

  // Load settings from device on mount if connected. This only reads the
  // currently active slot (preserveDeviceSelection: true) — it must NOT
  // trigger reloadSlotSummaries here, since that cycles the device through
  // every USB slot / BLE profile (real transport switches, secured RPCs) and
  // opening this tab should never have that side effect on its own. The
  // slot comparison table is populated only when the user explicitly clicks
  // "比較を更新".
  useEffect(() => {
    if (!isConnected() || loaded) return;
    (async () => {
      const [osConfig, gestureConfig] = await Promise.all([getOsConfig(), getGestureConfig()]);
      const initialEndpoint = osConfig?.activeEndpoint ?? gestureConfig?.activeEndpoint ?? 0;
      await loadSlotPointingSettings(initialEndpoint, { preserveDeviceSelection: true });
    })();
  }, [loaded, loadSlotPointingSettings]);

  // Header "⟳ Reset" bumps trackballResetTick — bring mouse acceleration back to its default (弱)
  const trackballResetTickRef = useRef(trackballResetTick);
  useEffect(() => {
    if (trackballResetTick === trackballResetTickRef.current) return;
    trackballResetTickRef.current = trackballResetTick;
    setAccelMode(1);
    debugLog('INF', 'Trackball', 'Mouse acceleration reset to default (弱)');
  }, [trackballResetTick]);

  // Realtime send helper (with unlock check)
  const sendIfRealtime = useCallback(async (fn: () => Promise<any>) => {
    if (!realtimePreview || !isConnected()) return;
    if (!isUnlocked()) {
      const ok = await requestUnlock();
      if (!ok) {
        debugLog('WRN', 'Trackball', 'Device locked. Press studio_unlock combo.');
        return;
      }
    }
    try {
      await fn();
    } catch (e: any) {
      debugLog('ERR', 'Trackball', `Realtime send failed: ${e.message}`);
    }
  }, [realtimePreview]);

  const handleCpiChange = (val: number) => {
    setCpi(val);
    sendIfRealtime(() => setSensitivity(val, Math.round(scrollSensitivity * 100), 100, scrollDirection === 'inverted'));
  };

  const handleScrollChange = (val: number) => {
    setScrollSensitivity(val);
    sendIfRealtime(() => setSensitivity(cpi, Math.round(val * 100), 100, scrollDirection === 'inverted'));
  };

  const handlePrecisionChange = (val: number) => {
    setPrecisionSensitivity(val);
    sendIfRealtime(() => setPrecisionScale(Math.round(val * 100), 100));
  };

  const handleSpeedChange = (val: number) => {
    setSpeedSensitivity(val);
    sendIfRealtime(() => setSpeedScale(Math.round(val * 100), 100));
  };

  const handleAccelModeChange = (val: number) => {
    setAccelMode(val);
    sendIfRealtime(() => setAccel(val > 0, Math.round(accelMaxRatio * 1000), accelStartSpeed, accelRampWidth));
  };

  const handleAccelDetailChange = (maxR: number, start: number, ramp: number) => {
    setAccelMaxRatio(maxR);
    setAccelStartSpeed(start);
    setAccelRampWidth(ramp);
    sendIfRealtime(() => setAccel(accelMode > 0, Math.round(maxR * 1000), start, ramp));
  };

  // Inertia sends immediately (AML pattern): FW applies + persists in one RPC
  const sendInertia = async (enabled: boolean, decay: number, startSpeed: number) => {
    if (!isConnected()) return;
    if (!isUnlocked() && !(await requestUnlock())) {
      debugLog('WRN', 'Trackball', 'Device locked. Press studio_unlock combo.');
      return;
    }
    await setInertia(enabled, decay, startSpeed);
  };

  const sendDragScale = async (enabled: boolean, num: number, den: number) => {
    if (!isConnected()) return;
    if (!isUnlocked() && !(await requestUnlock())) {
      debugLog('WRN', 'Trackball', 'Device locked. Press studio_unlock combo.');
      return;
    }
    await setDragScale(enabled, num, den);
  };

  return (
    <div>
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>設定対象</span>
          <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 700 }}>{profileTargetLabel}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
          AML は共通設定です。カーソル/精密/加速度/慣性/ドラッグ精密は、選択中の USB slot / BT profile ごとに保存されます。
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {slotEntries.map(entry => (
            <button
              key={entry.endpointIndex}
              className={`preset-btn ${selectedEndpoint === entry.endpointIndex ? 'selected' : ''}`}
              disabled={loadingSlot}
              onClick={() => loadSlotPointingSettings(entry.endpointIndex)}
              style={{
                minWidth: 68,
                textAlign: 'left',
                padding: '6px 8px',
                opacity: loadingSlot ? 0.7 : 1,
              }}
            >
              <div style={{ fontWeight: 600 }}>{entry.label}</div>
              <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{entry.status || '選択可'}</div>
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: 'var(--bg-secondary)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>共通設定</div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>AML</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>全スロット共通で有効・無効や待機時間を管理</div>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: 'var(--bg-secondary)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>スロット別設定</div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{profileTargetLabel}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>CPI / 精密 / 加速度 / 慣性 / Drag をこのスロットに保存</div>
          </div>
        </div>
      </div>

      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>各スロット比較</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>違いがある値だけをざっと見比べられます。</div>
          </div>
          <button className="btn btn-outline" style={{ fontSize: 11 }} onClick={() => reloadSlotSummaries()} disabled={loadingSummary}>
            {loadingSummary ? '更新中...' : '比較を更新'}
          </button>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {slotSummaries.map(summary => (
            <button
              key={summary.endpointIndex}
              className="btn btn-outline"
              onClick={() => loadSlotPointingSettings(summary.endpointIndex)}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(68px, 92px) repeat(4, minmax(0, 1fr))',
                gap: 8,
                alignItems: 'center',
                textAlign: 'left',
                padding: 8,
                background: selectedEndpoint === summary.endpointIndex ? 'var(--bg-secondary)' : 'transparent',
                borderColor: selectedEndpoint === summary.endpointIndex ? 'var(--accent)' : 'var(--border)',
              }}
            >
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{summary.label}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{summary.detail.replace(`${summary.label} - `, '')}</div>
              </div>
              <div style={{ fontSize: 11 }}><span style={{ color: 'var(--text-muted)' }}>CPI </span>{summary.cpi ?? '--'}</div>
              <div style={{ fontSize: 11 }}><span style={{ color: 'var(--text-muted)' }}>精密 </span>{summary.precision ?? '--'}</div>
              <div style={{ fontSize: 11 }}><span style={{ color: 'var(--text-muted)' }}>速度 </span>{summary.speed ?? '--'}</div>
              <div style={{ fontSize: 11 }}><span style={{ color: 'var(--text-muted)' }}>Accel </span>{summary.accel ?? '--'}</div>
              <div style={{ fontSize: 11 }}><span style={{ color: 'var(--text-muted)' }}>Inertia/Drag </span>{summary.inertia ?? '--'} / {summary.drag ?? '--'}</div>
            </button>
          ))}
        </div>
      </div>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 12, borderBottom: '1px solid var(--border)' }}>
        {([
          { key: 'aml', label: 'AML' },
          { key: 'gesture', label: 'ジェスチャ' },
          { key: 'cursor', label: 'カーソル' },
          { key: 'inertia', label: '慣性' },
        ] as const).map(tab => (
          <button
            key={tab.key}
            className="btn"
            onClick={() => setTrackballTab(tab.key)}
            style={{
              flex: 1,
              fontSize: 11,
              padding: '6px 4px',
              borderRadius: '4px 4px 0 0',
              borderBottom: trackballTab === tab.key ? '2px solid var(--accent)' : '2px solid transparent',
              color: trackballTab === tab.key ? 'var(--accent)' : 'var(--text-secondary)',
              fontWeight: trackballTab === tab.key ? 600 : 400,
              background: 'transparent',
            }}
          >{tab.label}</button>
        ))}
      </div>

      {/* AML - quick toggle only */}
      {trackballTab === 'aml' && (<>
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Auto Mouse Layer (AML)</span>
          <div className="btn-group">
            <button className={`btn ${!amlEnabled ? 'btn-active' : ''}`} onClick={async () => {
              setAmlEnabled(false);
              if (isConnected()) {
                if (!isUnlocked() && !(await requestUnlock())) return;
                await setAutoLayer(false, amlTimeout, keyIdsToPositions(store.amlExcluded), amlMinDistance, amlDuration);
                debugLog('INF', 'Trackball', 'AML disabled');
              }
            }}>OFF</button>
            <button className={`btn ${amlEnabled ? 'btn-active' : ''}`} onClick={async () => {
              setAmlEnabled(true);
              if (isConnected()) {
                if (!isUnlocked() && !(await requestUnlock())) return;
                await setAutoLayer(true, amlTimeout, keyIdsToPositions(store.amlExcluded), amlMinDistance, amlDuration);
                debugLog('INF', 'Trackball', 'AML enabled');
              }
            }} style={amlEnabled ? { background: 'var(--success)', color: 'white' } : {}}>ON</button>
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 12 }}>
          トラックボールを動かすと自動でマウスレイヤーに切り替わります
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>発動待機時間</span><span>{amlTimeout}ms</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>持続時間</span><span>{amlDuration}ms</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>最低移動距離</span><span>{amlMinDistance}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>除外キー</span><span>{store.amlExcluded.length}個</span></div>
        </div>

        <button
          className="btn"
          style={{ width: '100%', fontSize: 11, marginTop: 8, padding: '6px', color: 'var(--accent)', border: '1px solid var(--accent)', background: 'transparent' }}
          onClick={() => { store.setActiveTab('combos'); setTimeout(() => window.dispatchEvent(new CustomEvent('open-aml-edit')), 50); }}
        >⚙ Combos タブで詳細設定を開く →</button>
      </div>

      </>)}

      {/* Gesture Shortcuts */}
      {trackballTab === 'gesture' && (<>
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>ジェスチャショートカット</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Layer {store.gestures[0]?.layer ?? 13}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
          トラックボールを素早くフリックしてキー操作を実行します
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          {(['up', 'left', 'right', 'down'] as const).map(dir => {
            const g = store.gestures.find(ge => ge.direction === dir);
            const dl = DIRECTION_LABELS[dir];
            return (
              <button key={dir} className={`btn btn-outline ${editingGesture === dir ? 'btn-active' : ''}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', padding: '8px', fontSize: 11, gap: 2 }}
                onClick={() => { setEditingGesture(editingGesture === dir ? null : dir); setGestureSearch(''); setGestureCategory(null); }}>
                <span style={{ color: 'var(--text-muted)' }}>{dl.icon} {dl.label}</span>
                <span style={{ fontWeight: 600 }}>{g?.label || '---'}</span>
              </button>
            );
          })}
        </div>

        {editingGesture && (() => {
          const dl = DIRECTION_LABELS[editingGesture];
          const g = store.gestures.find(ge => ge.direction === editingGesture);
          const filteredKeycodes = gestureSearch
            ? searchKeyCodes(gestureSearch)
            : KEYCODES.filter(kc => kc.category === (gestureCategory || 'Navigation'));
          const currentLabel = g?.label || '';
          const modMatch = currentLabel.match(/^([CSAG+]+)\+(.+)$/);
          const currentMods = modMatch ? modMatch[1].split('+').filter(Boolean) : [];
          const currentBase = modMatch ? modMatch[2] : currentLabel;

          const toggleMod = (mod: string) => {
            const newMods = currentMods.includes(mod)
              ? currentMods.filter(m => m !== mod)
              : [...currentMods, mod];
            const newLabel = newMods.length > 0 ? newMods.join('+') + '+' + currentBase : currentBase;
            const updated = store.gestures.map(ge =>
              ge.direction === editingGesture ? { ...ge, keyCode: newLabel, label: newLabel } : ge
            );
            store.setGestures(updated);
          };

          const MOD_BUTTONS: { key: string; label: string }[] = [
            { key: 'C', label: '⌃' }, { key: 'S', label: '⇧' },
            { key: 'A', label: '⌥' }, { key: 'G', label: '⌘' },
          ];

          return (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                {dl.icon} {dl.label}ジェスチャを編集
              </div>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                {MOD_BUTTONS.map(m => (
                  <button key={m.key}
                    className={`btn btn-outline ${currentMods.includes(m.key) ? 'btn-active' : ''}`}
                    style={{ fontSize: 12, padding: '4px 8px', minWidth: 32 }}
                    onClick={() => toggleMod(m.key)}>
                    {m.label}
                  </button>
                ))}
              </div>
              <input
                value={gestureSearch}
                onChange={e => setGestureSearch(e.target.value)}
                placeholder="Search..."
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2, maxHeight: 120, overflowY: 'auto' }}>
                {filteredKeycodes.slice(0, 40).map(kc => (
                  <button key={kc.code} className={`keycode-btn ${g?.label === kc.label ? 'selected' : ''}`}
                    style={{ fontSize: 10, padding: '4px 2px' }}
                    onClick={() => {
                      const newLabel = currentMods.length > 0 ? currentMods.join('+') + '+' + kc.label : kc.label;
                      const updated = store.gestures.map(ge =>
                        ge.direction === editingGesture ? { ...ge, keyCode: newLabel, label: newLabel } : ge
                      );
                      store.setGestures(updated);
                      setEditingGesture(null);
                    }}>
                    {kc.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      </>)}

      {/* Cursor & Scroll Tab */}
      {trackballTab === 'cursor' && (<>
      {/* Realtime Preview */}
      <div className="config-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <button
            onClick={() => setRealtimePreview(!realtimePreview)}
            style={{
              width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
              background: realtimePreview ? 'var(--success)' : 'var(--bg-hover)',
              position: 'relative', transition: 'background 0.2s',
            }}
          >
            <span style={{
              position: 'absolute', top: 2, left: realtimePreview ? 18 : 2,
              width: 16, height: 16, borderRadius: '50%', background: 'white',
              transition: 'left 0.2s',
            }} />
          </button>
          <span style={{ fontSize: 12 }}>リアルタイムプレビュー</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>ONにするとスライダー操作が即座にデバイスに反映されます</div>
      </div>

      {/* CPI */}
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span>カーソル感度 (CPI)</span>
          <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 16 }}>{cpi}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>値が大きいほどカーソルが速く動きます</div>
        <input type="range" className="timing-slider" min={200} max={3200} step={100} value={cpi} onChange={e => handleCpiChange(Number(e.target.value))} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
          <span>200</span><span>3200</span>
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 4 }}>
          {CPI_PRESETS.map(p => (
            <button key={p} className={`preset-btn ${cpi === p ? 'selected' : ''}`} onClick={() => handleCpiChange(p)}>{p}</button>
          ))}
        </div>
      </div>

      {/* Cursor Speed (independent of CPI) */}
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span>カーソル速度</span>
          <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 16 }}>{speedSensitivity.toFixed(2)}x</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>CPIとは別に常時かかる速度倍率。CPIはセンサー感度、こちらは最終的な動きの速さの微調整用です。1.0 で等倍。</div>
        <input type="range" className="timing-slider" min={0.1} max={2.0} step={0.05} value={speedSensitivity} onChange={e => handleSpeedChange(Number(e.target.value))} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
          <span>0.1x</span><span>2.0x</span>
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 4 }}>
          {SPEED_PRESETS.map(p => (
            <button key={p} className={`preset-btn ${Math.abs(speedSensitivity - p) < 0.01 ? 'selected' : ''}`} onClick={() => handleSpeedChange(p)}>{p}x</button>
          ))}
        </div>
      </div>

      {/* Scroll Sensitivity */}
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span>スクロール感度</span>
          <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 16 }}>{scrollSensitivity.toFixed(2)}x</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>スクロールレイヤー時のスクロール速度倍率</div>
        <input type="range" className="timing-slider" min={0.25} max={4} step={0.25} value={scrollSensitivity} onChange={e => handleScrollChange(Number(e.target.value))} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
          <span>0.25x</span><span>4x</span>
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 4 }}>
          {SCROLL_PRESETS.map(p => (
            <button key={p} className={`preset-btn ${scrollSensitivity === p ? 'selected' : ''}`} onClick={() => handleScrollChange(p)}>{p}x</button>
          ))}
        </div>
      </div>

      {/* Scroll Direction */}
      <div className="config-section">
        <div style={{ fontSize: 12, marginBottom: 4 }}>スクロール方向</div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>macOS のナチュラルスクロールに合わせるには「反転」を選択</div>
        <div className="btn-group">
          <button className={`btn ${scrollDirection === 'normal' ? 'btn-active' : ''}`} onClick={() => { setScrollDirection('normal'); sendIfRealtime(() => setSensitivity(cpi, Math.round(scrollSensitivity * 100), 100, false)); }} style={scrollDirection === 'normal' ? { background: 'var(--success)', color: 'white' } : {}}>↑ 標準</button>
          <button className={`btn ${scrollDirection === 'inverted' ? 'btn-active' : ''}`} onClick={() => { setScrollDirection('inverted'); sendIfRealtime(() => setSensitivity(cpi, Math.round(scrollSensitivity * 100), 100, true)); }}>↓ 反転</button>
        </div>
      </div>

      {/* Precision Mode Sensitivity */}
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span>精密モード感度</span>
          <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 16 }}>{precisionSensitivity.toFixed(2)}x</span>
        </div>
        <div className="config-description">
          Precision レイヤー（13番目）がONの間、カーソル速度がこの倍率になります。製図など細かい操作向け。1.0 で等倍。
        </div>
        <input type="range" className="timing-slider" min={0.1} max={1.0} step={0.05} value={precisionSensitivity} onChange={e => handlePrecisionChange(Number(e.target.value))} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
          <span>0.10x</span><span>1.00x</span>
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 4 }}>
          {PRECISION_PRESETS.map(p => (
            <button key={p.label} className={`preset-btn ${Math.abs(precisionSensitivity - p.value) < 0.01 ? 'selected' : ''}`} onClick={() => handlePrecisionChange(p.value)}>{p.label}</button>
          ))}
        </div>
      </div>

      {/* Mouse Acceleration */}
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span>マウス加速度</span>
          <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 16 }}>最大 {accelMode === 0 ? 'オフ' : accelMode === 1 ? '1.2x' : accelMode === 2 ? '1.5x' : '2.0x'}</span>
        </div>
        <div className="config-description">
          速く動かすほどカーソルが加速します。ゆっくり動かした時の精度は保ったまま、大きく動かす時の移動量を増やせます（精密モード中は無効）。
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          {ACCEL_OPTIONS.map(opt => (
            <button key={opt.value} className={`preset-btn ${accelMode === opt.value ? 'selected' : ''}`} onClick={() => handleAccelModeChange(opt.value)}>{opt.label}</button>
          ))}
        </div>
      </div>

      {/* Acceleration Curve Graph */}
      {accelMode > 0 && (
        <div className="config-section">
          <svg viewBox="0 0 200 80" style={{ width: '100%', height: 80, background: 'var(--bg-secondary)', borderRadius: 4 }}>
            <line x1="10" y1="70" x2="190" y2="70" stroke="var(--border)" strokeWidth="0.5" />
            <line x1="10" y1="10" x2="10" y2="70" stroke="var(--border)" strokeWidth="0.5" />
            {[1.0, 1.5, 2.0].map((v, i) => (
              <text key={i} x="6" y={70 - ((v - 1) / (accelMaxRatio - 0.8)) * 55} fill="var(--text-muted)" fontSize="6" textAnchor="end">{v.toFixed(1)}x</text>
            ))}
            <text x="190" y="78" fill="var(--text-muted)" fontSize="6" textAnchor="end">速く動かす →</text>
            <path
              d={`M 10,70 ${Array.from({ length: 18 }, (_, i) => {
                const x = 10 + (i + 1) * 10;
                const speed = (i + 1) / 18;
                const t = Math.max(0, (speed - accelStartSpeed / 100) / (accelRampWidth / 100));
                const ratio = 1 + (accelMaxRatio - 1) * Math.min(1, t * t / (1 + t * t));
                const y = 70 - ((ratio - 1) / (accelMaxRatio - 0.8)) * 55;
                return `L ${x},${Math.max(10, y)}`;
              }).join(' ')}`}
              fill="none" stroke="var(--info)" strokeWidth="1.5"
            />
          </svg>
        </div>
      )}

      {/* Drag precision: slows cursor down while any mouse button is held */}
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>ドラッグ精密モード</span>
          <div className="btn-group">
            <button className={`btn ${!dragScaleEnabled ? 'btn-active' : ''}`} onClick={async () => {
              setDragScaleEnabled(false);
              await sendDragScale(false, dragScaleNum, dragScaleDen);
            }}>OFF</button>
            <button className={`btn ${dragScaleEnabled ? 'btn-active' : ''}`} onClick={async () => {
              setDragScaleEnabled(true);
              await sendDragScale(true, dragScaleNum, dragScaleDen);
            }} style={dragScaleEnabled ? { background: 'var(--success)', color: 'white' } : {}}>ON</button>
          </div>
        </div>
        <div className="config-description">
          クリックしたまま動かす（ドラッグ）間だけ、カーソル速度を落として精密に操作できます。レイヤー切替不要、ボタンを離せば即座に通常速度に戻ります（精密モード中は無効）。
        </div>
        {dragScaleEnabled && (
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            {DRAG_SCALE_PRESETS.map(p => (
              <button key={p.label} className={`preset-btn ${dragScaleNum === p.num && dragScaleDen === p.den ? 'selected' : ''}`}
                onClick={async () => {
                  setDragScaleNum(p.num); setDragScaleDen(p.den);
                  await sendDragScale(true, p.num, p.den);
                }}>{p.label}</button>
            ))}
          </div>
        )}
      </div>

      {/* Advanced */}
      <div className="config-section">
        <button className="btn btn-outline" style={{ width: '100%', fontSize: 12 }} onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? '▼' : '▶'} 詳細設定
        </button>
        {showAdvanced && (
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span>最大倍率</span>
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{accelMaxRatio.toFixed(1)}x</span>
              </div>
              <input type="range" className="timing-slider" min={1.0} max={3.0} step={0.1} value={accelMaxRatio} onChange={e => handleAccelDetailChange(Number(e.target.value), accelStartSpeed, accelRampWidth)} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span>効き始める速度</span>
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{accelStartSpeed}</span>
              </div>
              <input type="range" className="timing-slider" min={0} max={50} step={1} value={accelStartSpeed} onChange={e => handleAccelDetailChange(accelMaxRatio, Number(e.target.value), accelRampWidth)} />
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span>立ち上がりの幅</span>
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{accelRampWidth}</span>
              </div>
              <input type="range" className="timing-slider" min={1} max={100} step={1} value={accelRampWidth} onChange={e => handleAccelDetailChange(accelMaxRatio, accelStartSpeed, Number(e.target.value))} />
            </div>
          </div>
        )}
      </div>

      {/* Save / Reset / Default */}
      <div className="save-actions" style={{ flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={async () => {
            if (!isConnected()) return;
            if (!isUnlocked() && !(await requestUnlock())) {
              alert(unlockFailureMessage()); return;
            }
            await setSensitivity(cpi, Math.round(scrollSensitivity * 100), 100, scrollDirection === 'inverted');
            await setPrecisionScale(Math.round(precisionSensitivity * 100), 100);
            await setSpeedScale(Math.round(speedSensitivity * 100), 100);
            await setAccel(accelMode > 0, Math.round(accelMaxRatio * 1000), accelStartSpeed, accelRampWidth);
            await savePointingChanges();
            debugLog('INF', 'Trackball', 'All settings saved to flash');
          }}>💾 保存</button>
          <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => { setLoaded(false); }}>元に戻す</button>
          <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => {
            setCpi(800); setScrollSensitivity(1.0); setPrecisionSensitivity(0.25); setSpeedSensitivity(1.0);
            setAccelMode(1); setAccelMaxRatio(1.2); setAccelStartSpeed(10); setAccelRampWidth(28);
          }}>初期値</button>
        </div>
        <button className="btn btn-outline" style={{ width: '100%', fontSize: 12 }} onClick={() => setLoaded(false)}>再読込</button>
      </div>
      <div className="save-note">
        スライダーを動かすとリアルタイムで反映されます。「保存」でFlashに永続化してください。
      </div>
      </>)}

      {/* Inertia (trackpad-style glide) */}
      {trackballTab === 'inertia' && (<>
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>慣性スクロール / カーソル</span>
          <div className="btn-group">
            <button className={`btn ${!inertiaEnabled ? 'btn-active' : ''}`} onClick={async () => {
              setInertiaEnabled(false);
              await sendInertia(false, inertiaDecay, inertiaStartSpeed);
              debugLog('INF', 'Trackball', 'Inertia disabled');
            }}>OFF</button>
            <button className={`btn ${inertiaEnabled ? 'btn-active' : ''}`} onClick={async () => {
              setInertiaEnabled(true);
              await sendInertia(true, inertiaDecay, inertiaStartSpeed);
              debugLog('INF', 'Trackball', 'Inertia enabled');
            }} style={inertiaEnabled ? { background: 'var(--success)', color: 'white' } : {}}>ON</button>
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
          トラックパッドのように、ボールを弾いた後もカーソルやスクロールが減衰しながら滑り続けます。ボールに触れると即停止します。
        </div>
      </div>

      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span>滑走の長さ</span>
          <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 16 }}>
            {INERTIA_DECAY_PRESETS.find(p => p.value === inertiaDecay)?.label ?? inertiaDecay}
          </span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>弾いた後にどれだけ長く滑り続けるか</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {INERTIA_DECAY_PRESETS.map(p => (
            <button key={p.value} className={`preset-btn ${inertiaDecay === p.value ? 'selected' : ''}`}
              onClick={async () => {
                setInertiaDecay(p.value);
                await sendInertia(inertiaEnabled, p.value, inertiaStartSpeed);
              }}>{p.label}</button>
          ))}
        </div>
      </div>

      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span>発動のしにくさ</span>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{inertiaStartSpeed}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
          この速さ以上で弾いた時だけ慣性が働きます。小さいほど発動しやすく、大きいほど強く弾かないと発動しません。
        </div>
        <input type="range" className="timing-slider" min={2} max={30} step={1} value={inertiaStartSpeed}
          onChange={e => setInertiaStartSpeed(Number(e.target.value))}
          onPointerUp={() => sendInertia(inertiaEnabled, inertiaDecay, inertiaStartSpeed)} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
          <span>発動しやすい</span><span>強く弾いた時だけ</span>
        </div>
      </div>

      <div className="save-note">
        変更は即座にデバイスへ送信・保存されます（接続時）。
      </div>
      </>)}
    </div>
  );
}
