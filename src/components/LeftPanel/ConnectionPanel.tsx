import { useEffect, useState } from 'react';
import { connectUsb, disconnectUsb, connectBle, disconnectBle, getRuntimeState, RuntimeBatteryState, getBleProfiles, getUsbSlots, getOsConfig, getDeviceInfo } from '../../services/usbService';
import { isFirmwareVersionSupported } from '../../services/firmwareCompat';

interface Props {
  connected: boolean;
  connectionType: 'usb' | 'bluetooth' | null;
  onConnectionChange: (connected: boolean, type: 'usb' | 'bluetooth' | null) => void;
  compact?: boolean;
}

const BATTERY_POLL_MS = 30000;

type HealthState = {
  deviceName: string | null;
  firmwareVersion: string | null;
  runtime: RuntimeBatteryState | null;
  bleActiveIndex: number | null;
  bleActiveName: string | null;
  usbActiveIndex: number | null;
  usbActiveName: string | null;
  osProfileEnabled: boolean | null;
  activeOs: number | null;
};

function BatteryPill({ label, value, charging }: { label: string; value: number | null; charging?: boolean }) {
  const color = value === null ? 'var(--text-muted)' : value <= 20 ? 'var(--danger)' : 'var(--text-secondary)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 44 }}>
      <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color }}>
        {value === null ? '—' : `${value}%${charging ? ' ⚡' : ''}`}
      </span>
    </div>
  );
}

export function ConnectionPanel({ connected, connectionType, onConnectionChange, compact = false }: Props) {
  const [health, setHealth] = useState<HealthState | null>(null);

  // Electron only: the serial port is exclusive, so if the tray popup holds
  // its own connection, ask it to let go before Studio connects, and hand
  // the port back when Studio disconnects (no-ops on the web build).
  const electronAPI = (window as any).electronAPI;

  const handleUsbConnect = async () => {
    if (connected) {
      await (connectionType === 'bluetooth' ? disconnectBle() : disconnectUsb());
      onConnectionChange(false, null);
      electronAPI?.studioReleasedPort?.();
      return;
    }
    await electronAPI?.stealPort?.();
    const success = await connectUsb();
    if (success) {
      onConnectionChange(true, 'usb');
    }
  };

  const handleBleConnect = async () => {
    if (connected) {
      await (connectionType === 'bluetooth' ? disconnectBle() : disconnectUsb());
      onConnectionChange(false, null);
      electronAPI?.studioReleasedPort?.();
      return;
    }
    await electronAPI?.stealPort?.();
    const success = await connectBle();
    if (success) {
      onConnectionChange(true, 'bluetooth');
    }
  };

  // Battery isn't pushed by the device, so poll while connected -- a fresh
  // read on connect plus a slow refresh is enough for a comfort indicator.
  useEffect(() => {
    if (!connected) {
      setHealth(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const [device, runtime, bleProfiles, usbSlots, osConfig] = await Promise.all([
        getDeviceInfo(),
        getRuntimeState(),
        getBleProfiles(),
        getUsbSlots(),
        getOsConfig(),
      ]);
      if (cancelled) return;
      setHealth({
        deviceName: device?.name ?? null,
        firmwareVersion: device?.firmwareVersion ?? null,
        runtime,
        bleActiveIndex: bleProfiles?.activeIndex ?? null,
        bleActiveName: bleProfiles?.activeIndex !== undefined ? (bleProfiles.profiles[bleProfiles.activeIndex]?.name ?? null) : null,
        usbActiveIndex: usbSlots?.activeIndex ?? null,
        usbActiveName: usbSlots?.activeIndex !== undefined ? (usbSlots.slots[usbSlots.activeIndex]?.name ?? null) : null,
        osProfileEnabled: osConfig?.enabled ?? runtime?.osProfileEnabled ?? null,
        activeOs: osConfig?.activeOs ?? runtime?.activeOs ?? null,
      });
    };
    poll();
    const interval = setInterval(poll, BATTERY_POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [connected]);

  // Firmware older than 0.6.12 doesn't report peripheralRConnected/
  // peripheralLConnected at all, and those fields decode to a misleading
  // `false` (not undefined) when absent -- fall back to inferring from
  // battery presence in that case, same as before this field existed.
  const fwSupportsConnectedFlags = isFirmwareVersionSupported(health?.firmwareVersion) === true;
  const statusText = (batteryValue: number | null, connectedFlag: boolean) =>
    (fwSupportsConnectedFlags ? connectedFlag : batteryValue !== null) ? 'online' : 'offline';
  const slotText = (kind: 'BLE' | 'USB', index: number | null, name: string | null) =>
    index === null ? '--' : `${kind}${index}${name ? ` (${name})` : ''}`;

  if (compact) {
    return (
      <div className="connection-panel connection-panel-compact">
        <div className="connection-status" style={{ marginBottom: 0 }}>
          <span className={`status-dot ${connected ? 'connected' : ''}`} />
          <span>{connected ? `${connectionType === 'bluetooth' ? 'BLE' : 'USB'} Connected` : 'Disconnected'}</span>
        </div>

        {connected && health?.runtime && (
          <div className="connection-compact-health">
            <BatteryPill label="L" value={health.runtime.peripheralL} />
            {health.runtime.topology === 'dongle' && (
              <BatteryPill label="D" value={health.runtime.central} charging={health.runtime.charging} />
            )}
            <BatteryPill label="R" value={health.runtime.peripheralR} charging={health.runtime.topology === 'standalone' ? health.runtime.charging : undefined} />
            <div className="connection-compact-meta">
              <div>{health.deviceName || 'Conductor'}{health.firmwareVersion ? ` / ${health.firmwareVersion}` : ''}</div>
              <div>
                {connectionType === 'bluetooth'
                  ? slotText('BLE', health.bleActiveIndex, health.bleActiveName)
                  : slotText('USB', health.usbActiveIndex, health.usbActiveName)}
              </div>
            </div>
          </div>
        )}

        <div className="connection-compact-actions">
          {(!connected || connectionType === 'usb') && (
            <button className="connect-btn connect-btn-usb" onClick={handleUsbConnect}>
              ⚡ {connected && connectionType === 'usb' ? 'Disconnect USB' : 'Connect USB'}
            </button>
          )}
          {(!connected || connectionType === 'bluetooth') && (
            <button
              className="connect-btn connect-btn-usb"
              onClick={handleBleConnect}
              style={{ background: 'var(--info)' }}
            >
              ᛒ {connected && connectionType === 'bluetooth' ? 'Disconnect BLE' : 'Connect BLE'}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="connection-panel">
      <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>⚡ USB / ᛒ BLE</span>
      </div>

      <div className="connection-status">
        <span className={`status-dot ${connected ? 'connected' : ''}`} />
        <span>{connected ? `Connected (${connectionType === 'bluetooth' ? 'BLE' : 'USB'})` : 'Disconnected'}</span>
      </div>

      {connected && health?.runtime && (
        <div style={{ margin: '8px 0', padding: '8px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 8 }}>
            <BatteryPill label="L" value={health.runtime.peripheralL} />
            {health.runtime.topology === 'dongle' && (
              <BatteryPill label="Dongle" value={health.runtime.central} charging={health.runtime.charging} />
            )}
            <BatteryPill label="R" value={health.runtime.peripheralR} charging={health.runtime.topology === 'standalone' ? health.runtime.charging : undefined} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>Device</span>
              <span style={{ color: 'var(--text-primary)', textAlign: 'right' }}>{health.deviceName || 'Conductor'}{health.firmwareVersion ? ` / ${health.firmwareVersion}` : ''}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>Active Output</span>
              <span style={{ color: 'var(--text-primary)', textAlign: 'right' }}>
                {connectionType === 'bluetooth'
                  ? slotText('BLE', health.bleActiveIndex, health.bleActiveName)
                  : slotText('USB', health.usbActiveIndex, health.usbActiveName)}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>Peripherals</span>
              <span style={{ color: 'var(--text-primary)', textAlign: 'right' }}>
                L {statusText(health.runtime.peripheralL, health.runtime.peripheralLConnected)} / R {statusText(health.runtime.peripheralR, health.runtime.peripheralRConnected)}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>Layer State</span>
              <span style={{ color: 'var(--text-primary)', textAlign: 'right' }}>
                highest={health.runtime.highestLayer} mask=0x{(health.runtime.activeLayersBitmask ?? 0).toString(16)}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>OS Profile</span>
              <span style={{ color: 'var(--text-primary)', textAlign: 'right' }}>
                {(health.osProfileEnabled ? 'ON' : 'OFF')}{health.activeOs !== null ? ` / active=${health.activeOs}` : ''}
              </span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              {fwSupportsConnectedFlags
                ? 'Peripheralsの接続状態は実際の接続状態(FW 0.6.12+)です。last-received と per-peripheral の layer 同期状況は、現行 firmware ではまだ露出していません。'
                : `ファームウェア (${health.firmwareVersion || '不明'}) が古いため、Peripheralsの接続状態はバッテリー値の有無から推測した参考値です。最新化すると実際の接続状態が表示されます。`}
            </div>
          </div>
        </div>
      )}

      {(!connected || connectionType === 'usb') && (
        <button className="connect-btn connect-btn-usb" onClick={handleUsbConnect}>
          ⚡ {connected && connectionType === 'usb' ? 'Disconnect USB' : 'Connect via USB'}
        </button>
      )}

      {(!connected || connectionType === 'bluetooth') && (
        <button className="connect-btn connect-btn-usb" onClick={handleBleConnect}
          style={{ marginTop: connected ? 0 : 6, background: 'var(--info)' }}>
          ᛒ {connected && connectionType === 'bluetooth' ? 'Disconnect BLE' : 'Connect via Bluetooth'}
        </button>
      )}

      <div className="connection-help">
        USBケーブル、またはBluetooth（BT0-4のいずれかでペアリング済みのホストから）で接続できます。Web Serial / Web Bluetooth API（Chrome/Edge）が必要です。
      </div>
    </div>
  );
}
