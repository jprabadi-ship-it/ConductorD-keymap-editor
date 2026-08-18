import { useEffect, useState } from 'react';
import {
  getAccel,
  getAutoLayer,
  getBleProfiles,
  getDeviceInfo,
  getDragScale,
  getFirmwareInfo,
  getGestureConfig,
  getInertia,
  getOsConfig,
  getRuntimeState,
  getSensitivity,
  getUsbSlots,
  isConnected,
  type RuntimeBatteryState,
  type FirmwareUnitInfo,
} from '../../services/usbService';
import { isFirmwareVersionSupported, analyzeFirmwareConsistency } from '../../services/firmwareCompat';
import { runConfigAudit, lastAuditResults, lastAuditAt, type AuditFinding } from '../../services/configAudit';
import type { KeymapStore } from '../../store/useKeymapStore';
import { debugLog } from '../DebugConsole';

const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;

// Static snapshot from the last checked CI build (run 29883279360,
// commit aa42891, 2026-07-22) -- firmware has no RPC that reports its own
// flash/RAM usage at runtime, so this can't be queried live. Update these
// numbers by hand whenever a CI memory report is checked again.
const FIRMWARE_SIZE_INFO: Record<string, { flashUsed: number; ramUsed: number }> = {
  dongle: { flashUsed: 352140, ramUsed: 136472 },
  r: { flashUsed: 212612, ramUsed: 57356 }, // R_dongle_mode (periph) -- the build actually flashed to R in normal dongle-mode use
  l: { flashUsed: 202636, ramUsed: 48580 },
};
const FLASH_CAPACITY = 788 * 1024;
const RAM_CAPACITY = 256 * 1024;

function sizeText(usedBytes: number, capacityBytes: number): string {
  const pct = ((usedBytes / capacityBytes) * 100).toFixed(1);
  return `${usedBytes.toLocaleString()} B / ${capacityBytes.toLocaleString()} B (${pct}%)`;
}

type DiagnosticsData = {
  device: Awaited<ReturnType<typeof getDeviceInfo>>;
  runtime: RuntimeBatteryState | null;
  bleProfiles: Awaited<ReturnType<typeof getBleProfiles>>;
  usbSlots: Awaited<ReturnType<typeof getUsbSlots>>;
  sensitivity: Awaited<ReturnType<typeof getSensitivity>>;
  autoLayer: Awaited<ReturnType<typeof getAutoLayer>>;
  accel: Awaited<ReturnType<typeof getAccel>>;
  inertia: Awaited<ReturnType<typeof getInertia>>;
  dragScale: Awaited<ReturnType<typeof getDragScale>>;
  osConfig: Awaited<ReturnType<typeof getOsConfig>>;
  gestureConfig: Awaited<ReturnType<typeof getGestureConfig>>;
  firmwareInfo: Awaited<ReturnType<typeof getFirmwareInfo>>;
};

// One display line per unit: stamp + build id, or why it's unknown.
function unitText(u: FirmwareUnitInfo | undefined, isSelf: boolean) {
  if (!u) return '--';
  if (!isSelf && !u.connected) return 'offline';
  if (!u.stamp && !u.buildId) return '不明（旧FW?）';
  return [u.stamp, u.buildId ? `#${u.buildId}` : ''].filter(Boolean).join(' ');
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', textAlign: 'right', fontFamily: 'monospace' }}>{value}</span>
    </div>
  );
}

function boolText(v: boolean | undefined) {
  return v ? 'ON' : 'OFF';
}

function batteryText(v: number | null | undefined) {
  return v === null || v === undefined ? '--' : `${v}%`;
}

// Firmware older than 0.6.12 doesn't report peripheralRConnected/
// peripheralLConnected (they decode to a misleading `false`, not
// undefined, when absent) -- fall back to inferring from battery presence
// on those, same as before the fields existed, and say so plainly.
function linkText(batteryValue: number | null | undefined, connectedFlag: boolean | undefined, fwSupportsConnectedFlags: boolean) {
  if (fwSupportsConnectedFlags) return connectedFlag ? 'online' : 'offline';
  return (batteryValue !== null && batteryValue !== undefined) ? 'online (推測)' : 'offline (推測)';
}

// Plain-text mirror of the Row entries below, grouped the same way, so
// "copy" produces something pasteable into a bug report or chat rather
// than a wall of raw JSON.
function buildDiagnosticsText(data: DiagnosticsData): string {
  const fwSupportsConnectedFlags = isFirmwareVersionSupported(data.device?.firmwareVersion) === true;
  const lines: string[] = [];
  lines.push(`ConductorD Studio diagnostics (${new Date().toISOString()})`);
  lines.push('');
  lines.push('## Device');
  lines.push(`Name: ${data.device?.name || '--'}`);
  lines.push(`Firmware: ${data.device?.firmwareVersion || '--'}`);
  lines.push(`FW Dongle: ${unitText(data.firmwareInfo?.self, true)}`);
  lines.push(`FW R: ${unitText(data.firmwareInfo?.peripherals?.[0], false)}`);
  lines.push(`FW L: ${unitText(data.firmwareInfo?.peripherals?.[1], false)}`);
  if (data.firmwareInfo) {
    const c = analyzeFirmwareConsistency(data.firmwareInfo.self, data.firmwareInfo.peripherals);
    lines.push(`FW Consistency: ${c.status} -- ${c.detail}`);
  }
  lines.push(`Highest Layer: ${data.runtime?.highestLayer ?? '--'}`);
  lines.push(`Layers Bitmask: ${data.runtime?.activeLayersBitmask !== undefined ? `0x${data.runtime.activeLayersBitmask.toString(16)}` : '--'}`);
  lines.push(`Active OS: ${data.runtime?.activeOs ?? '--'}`);
  lines.push(`OS Profile: ${boolText(data.runtime?.osProfileEnabled)}`);
  lines.push('');
  lines.push('## Battery / Link');
  if (data.runtime?.topology !== 'standalone') {
    lines.push(`Dongle: ${batteryText(data.runtime?.central)}${data.runtime?.charging ? ' charging' : ''}`);
  }
  lines.push(`R: ${batteryText(data.runtime?.peripheralR)}${data.runtime?.topology === 'standalone' && data.runtime?.charging ? ' charging' : ''} (${linkText(data.runtime?.peripheralR, data.runtime?.peripheralRConnected, fwSupportsConnectedFlags)})`);
  lines.push(`L: ${batteryText(data.runtime?.peripheralL)} (${linkText(data.runtime?.peripheralL, data.runtime?.peripheralLConnected, fwSupportsConnectedFlags)})`);
  lines.push(`BLE Active: ${data.bleProfiles?.activeIndex ?? '--'}`);
  lines.push(`USB Active: ${data.usbSlots?.activeIndex ?? '--'}`);
  lines.push('');
  lines.push('## Trackball');
  lines.push(`CPI: ${data.sensitivity?.cpi ?? '--'}`);
  lines.push(`Scroll: ${data.sensitivity ? `${data.sensitivity.scrollNum}/${data.sensitivity.scrollDen}${data.sensitivity.scrollInverted ? ' inverted' : ''}` : '--'}`);
  lines.push(`AML: ${data.autoLayer ? `${boolText(data.autoLayer.enabled)} idle=${data.autoLayer.requirePriorIdleMs}ms motion=${data.autoLayer.motionThreshold} duration=${data.autoLayer.durationMs}ms` : '--'}`);
  lines.push(`AML Excluded: ${data.autoLayer ? `[${data.autoLayer.excludedPositions.join(', ')}]` : '--'}`);
  lines.push(`Accel: ${data.accel ? `${boolText(data.accel.enabled)} max=${(data.accel.maxMilli / 1000).toFixed(1)}x start=${data.accel.threshold} ramp=${data.accel.range}` : '--'}`);
  lines.push(`Inertia: ${data.inertia ? `${boolText(data.inertia.enabled)} decay=${data.inertia.decayMilli} start=${data.inertia.startSpeed}` : '--'}`);
  lines.push(`Drag Scale: ${data.dragScale ? `${boolText(data.dragScale.enabled)} ${data.dragScale.numerator}/${data.dragScale.denominator}` : '--'}`);
  lines.push('');
  lines.push('## Profiles');
  lines.push(`BLE Slots: ${data.bleProfiles ? data.bleProfiles.profiles.map((p, i) => `${i}:${p.name}${p.connected ? '*' : ''}`).join('  ') || '--' : '--'}`);
  lines.push(`USB Slots: ${data.usbSlots ? data.usbSlots.slots.map((s, i) => `${i}:${s.name}`).join('  ') || '--' : '--'}`);
  lines.push(`OS Overlay: ${data.osConfig ? `${boolText(data.osConfig.enabled)} map=[${data.osConfig.osMap.join(', ')}] activeEndpoint=${data.osConfig.activeEndpoint}` : '--'}`);
  lines.push(`Gesture Override: ${data.gestureConfig ? `${boolText(data.gestureConfig.enabled)} overrides=${data.gestureConfig.hasOverride.filter(Boolean).length} activeEndpoint=${data.gestureConfig.activeEndpoint}` : '--'}`);
  if (lastAuditResults !== null) {
    lines.push('');
    lines.push('## Config Audit');
    if (lastAuditResults.length === 0) {
      lines.push('OK: no findings');
    } else {
      for (const f of lastAuditResults) {
        lines.push(`${f.severity.toUpperCase()} [${f.category}] ${f.message}`);
      }
    }
  }
  return lines.join('\n');
}

export function DiagnosticsPanel({ store, onOpenFirmwareWizard }: { store?: KeymapStore; onOpenFirmwareWizard?: (info: DiagnosticsData['firmwareInfo']) => void }) {
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [audit, setAudit] = useState<AuditFinding[] | null>(lastAuditResults);
  const [auditAt, setAuditAt] = useState<string | null>(lastAuditAt);
  const [auditing, setAuditing] = useState(false);

  const rerunAudit = async () => {
    if (!store) return;
    setAuditing(true);
    const results = await runConfigAudit(store.exportProject());
    setAudit(results);
    setAuditAt(new Date().toLocaleTimeString('ja-JP'));
    setAuditing(false);
  };

  const handleCopy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(buildDiagnosticsText(data));
      setCopyStatus('copied');
    } catch (e: any) {
      debugLog('ERR', 'Diagnostics', `Copy to clipboard failed: ${e.message}`);
      setCopyStatus('failed');
    }
    setTimeout(() => setCopyStatus('idle'), 1500);
  };

  const load = async () => {
    if (!isConnected()) {
      setData(null);
      setLoaded(true);
      return;
    }
    setLoading(true);
    const [
      device,
      runtime,
      bleProfiles,
      usbSlots,
      sensitivity,
      autoLayer,
      accel,
      inertia,
      dragScale,
      osConfig,
      gestureConfig,
      firmwareInfo,
    ] = await Promise.all([
      getDeviceInfo(),
      getRuntimeState(),
      getBleProfiles(),
      getUsbSlots(),
      getSensitivity(),
      getAutoLayer(),
      getAccel(),
      getInertia(),
      getDragScale(),
      getOsConfig(),
      getGestureConfig(),
      getFirmwareInfo(),
    ]);
    setData({
      device,
      runtime,
      bleProfiles,
      usbSlots,
      sensitivity,
      autoLayer,
      accel,
      inertia,
      dragScale,
      osConfig,
      gestureConfig,
      firmwareInfo,
    });
    setLoading(false);
    setLoaded(true);
  };

  useEffect(() => {
    if (!loaded) load();
  }, [loaded]);

  // Pure local-data analysis, no RPC needed except the optional resolver
  // check inside runConfigAudit (which itself no-ops without a loaded
  // behavior cache) -- always renderable, unlike the rest of this panel
  // which needs a live device. Kept above the !isConnected() early return
  // below so results (and 再検査) stay visible while disconnected too.
  const auditSection = (
    <div className="config-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div>
          <div className="config-label">設定監査</div>
          <div className="config-description">
            設定の不整合（カスタムbehaviorの置き換わり・発火しないコンボ・存在しない参照など）を検査します。Readのたびに自動実行されます{auditAt ? `（最終: ${auditAt}）` : ''}。
          </div>
        </div>
        {store && (
          <button className="btn btn-outline" style={{ fontSize: 11 }} onClick={rerunAudit} disabled={auditing}>
            {auditing ? '検査中...' : '再検査'}
          </button>
        )}
      </div>
      {audit === null ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>まだ実行されていません（Readすると自動実行されます。または上の「再検査」ボタンでいつでも実行できます）</div>
      ) : audit.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--success)', padding: '6px 0' }}>✓ 問題は見つかりませんでした</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 0' }}>
          {audit.map((f, i) => (
            <div key={i} style={{
              fontSize: 11, lineHeight: 1.5, padding: '6px 8px', borderRadius: 4,
              borderLeft: `3px solid ${f.severity === 'error' ? 'var(--danger)' : 'var(--warning)'}`,
              background: 'var(--bg-tertiary)',
            }}>
              <span style={{ fontWeight: 600, color: f.severity === 'error' ? 'var(--danger)' : 'var(--warning)' }}>
                {f.severity === 'error' ? '✗' : '⚠'} {f.category}
              </span>
              {' — '}{f.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (!isConnected()) {
    return (
      <div>
        {auditSection}
        <div className="config-section">
          <div className="config-label">実機診断</div>
          <div className="config-description">
            接続中のデバイスから現在値を読み出して表示します。USB または BLE で接続してから開いてください。
          </div>
        </div>
      </div>
    );
  }

  const fwSupportsConnectedFlags = isFirmwareVersionSupported(data?.device?.firmwareVersion) === true;

  return (
    <div>
      <div className="config-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <div className="config-label">実機診断</div>
            <div className="config-description">現在の runtime 状態と保存済み設定をまとめて表示します。</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-outline" style={{ fontSize: 11 }} onClick={handleCopy} disabled={!data}>
              {copyStatus === 'copied' ? '✓ コピーしました' : copyStatus === 'failed' ? '❌ コピー失敗' : '📋 コピー'}
            </button>
            <button className="btn btn-outline" style={{ fontSize: 11 }} onClick={() => setLoaded(false)} disabled={loading}>
              {loading ? '読込中...' : '再読込'}
            </button>
          </div>
        </div>
      </div>

      {auditSection}

      {data && (
        <>
          <div className="config-section">
            <div className="config-label">Device</div>
            <Row label="Name" value={data.device?.name || '--'} />
            <Row label="Firmware" value={data.device?.firmwareVersion || '--'} />
            <Row label="Highest Layer" value={String(data.runtime?.highestLayer ?? '--')} />
            <Row label="Layers Bitmask" value={data.runtime?.activeLayersBitmask !== undefined ? `0x${data.runtime.activeLayersBitmask.toString(16)}` : '--'} />
            <Row label="Active OS" value={String(data.runtime?.activeOs ?? '--')} />
            <Row label="OS Profile" value={boolText(data.runtime?.osProfileEnabled)} />
          </div>

          <div className="config-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="config-label">ファームウェア構成</div>
              {isElectron && data.firmwareInfo && (
                <button className="btn btn-outline" style={{ fontSize: 11 }} onClick={() => onOpenFirmwareWizard?.(data.firmwareInfo)}>
                  🔄 アップデート
                </button>
              )}
            </div>
            <Row label="Dongle" value={unitText(data.firmwareInfo?.self, true)} />
            <Row label="R" value={unitText(data.firmwareInfo?.peripherals?.[0], false)} />
            <Row label="L" value={unitText(data.firmwareInfo?.peripherals?.[1], false)} />
            {data.firmwareInfo && (() => {
              const c = analyzeFirmwareConsistency(data.firmwareInfo.self, data.firmwareInfo.peripherals);
              return (
                <div style={{
                  fontSize: 11, marginTop: 6, padding: '6px 8px', borderRadius: 4, lineHeight: 1.5,
                  color: c.status === 'mismatch' ? 'var(--danger)' : c.status === 'unknown' ? 'var(--warning)' : 'var(--success)',
                  background: c.status === 'mismatch' ? 'rgba(239,68,68,0.08)' : c.status === 'unknown' ? 'rgba(245,158,11,0.08)' : 'rgba(16,185,129,0.08)',
                }}>
                  {c.status === 'mismatch' ? '✗ ' : c.status === 'unknown' ? '△ ' : '✓ '}{c.detail}
                </div>
              );
            })()}
            {!data.firmwareInfo && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                このdongleのFWはget_firmware_info未対応です（要FW更新）
              </div>
            )}
          </div>

          <div className="config-section">
            <div className="config-label">ファームウェア容量（前回CI確認時点、実機からの取得値ではありません）</div>
            <Row label="Dongle Flash" value={sizeText(FIRMWARE_SIZE_INFO.dongle.flashUsed, FLASH_CAPACITY)} />
            <Row label="Dongle RAM" value={sizeText(FIRMWARE_SIZE_INFO.dongle.ramUsed, RAM_CAPACITY)} />
            <Row label="R Flash" value={sizeText(FIRMWARE_SIZE_INFO.r.flashUsed, FLASH_CAPACITY)} />
            <Row label="R RAM" value={sizeText(FIRMWARE_SIZE_INFO.r.ramUsed, RAM_CAPACITY)} />
            <Row label="L Flash" value={sizeText(FIRMWARE_SIZE_INFO.l.flashUsed, FLASH_CAPACITY)} />
            <Row label="L RAM" value={sizeText(FIRMWARE_SIZE_INFO.l.ramUsed, RAM_CAPACITY)} />
          </div>

          <div className="config-section">
            <div className="config-label">Battery / Link</div>
            {data.runtime?.topology !== 'standalone' && (
              <Row label="Dongle" value={`${batteryText(data.runtime?.central)}${data.runtime?.charging ? ' charging' : ''}`} />
            )}
            <Row label="R" value={`${batteryText(data.runtime?.peripheralR)}${data.runtime?.topology === 'standalone' && data.runtime?.charging ? ' charging' : ''} (${linkText(data.runtime?.peripheralR, data.runtime?.peripheralRConnected, fwSupportsConnectedFlags)})`} />
            <Row label="L" value={`${batteryText(data.runtime?.peripheralL)} (${linkText(data.runtime?.peripheralL, data.runtime?.peripheralLConnected, fwSupportsConnectedFlags)})`} />
            <Row label="BLE Active" value={String(data.bleProfiles?.activeIndex ?? '--')} />
            <Row label="USB Active" value={String(data.usbSlots?.activeIndex ?? '--')} />
          </div>

          <div className="config-section">
            <div className="config-label">Trackball</div>
            <Row label="CPI" value={String(data.sensitivity?.cpi ?? '--')} />
            <Row label="Scroll" value={data.sensitivity ? `${data.sensitivity.scrollNum}/${data.sensitivity.scrollDen}${data.sensitivity.scrollInverted ? ' inverted' : ''}` : '--'} />
            <Row label="AML" value={data.autoLayer ? `${boolText(data.autoLayer.enabled)} idle=${data.autoLayer.requirePriorIdleMs}ms motion=${data.autoLayer.motionThreshold} duration=${data.autoLayer.durationMs}ms` : '--'} />
            <Row label="AML Excluded" value={data.autoLayer ? `[${data.autoLayer.excludedPositions.join(', ')}]` : '--'} />
            <Row label="Accel" value={data.accel ? `${boolText(data.accel.enabled)} max=${(data.accel.maxMilli / 1000).toFixed(1)}x start=${data.accel.threshold} ramp=${data.accel.range}` : '--'} />
            <Row label="Inertia" value={data.inertia ? `${boolText(data.inertia.enabled)} decay=${data.inertia.decayMilli} start=${data.inertia.startSpeed}` : '--'} />
            <Row label="Drag Scale" value={data.dragScale ? `${boolText(data.dragScale.enabled)} ${data.dragScale.numerator}/${data.dragScale.denominator}` : '--'} />
          </div>

          <div className="config-section">
            <div className="config-label">Profiles</div>
            <Row label="BLE Slots" value={data.bleProfiles ? data.bleProfiles.profiles.map((p, i) => `${i}:${p.name}${p.connected ? '*' : ''}`).join('  ') || '--' : '--'} />
            <Row label="USB Slots" value={data.usbSlots ? data.usbSlots.slots.map((s, i) => `${i}:${s.name}`).join('  ') || '--' : '--'} />
            <Row label="OS Overlay" value={data.osConfig ? `${boolText(data.osConfig.enabled)} map=[${data.osConfig.osMap.join(', ')}] activeEndpoint=${data.osConfig.activeEndpoint}` : '--'} />
            <Row label="Gesture Override" value={data.gestureConfig ? `${boolText(data.gestureConfig.enabled)} overrides=${data.gestureConfig.hasOverride.filter(Boolean).length} activeEndpoint=${data.gestureConfig.activeEndpoint}` : '--'} />
          </div>
        </>
      )}

      <div className="save-note">
        この画面は読み取り専用です。値は現在の接続先と、そのデバイスに保存済みの設定から取得しています。
      </div>
    </div>
  );
}
