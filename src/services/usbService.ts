import protobuf from 'protobufjs';
import { debugLog } from '../components/DebugConsole';
import protoJson from '../data/zmk-studio-proto.json';
import { keyIdsToPositions, positionsToKeyIds } from '../data/layout';
import type { DeviceSettingsSnapshot, KeyBinding, Layer, SensitivitySnapshot } from '../types';

const SOF = 171;
const EOF = 173;
const ESC = 172;
const BAUD_RATE = 12500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let port: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let reader: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let writer: any = null;
let requestId = 0;
let onDisconnectCallback: (() => void) | null = null;
let onActiveLayerCallback: ((highestLayer: number) => void) | null = null;
let onKeyInputCallback: ((position: number, pressed: boolean) => void) | null = null;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeout: number;
};

const pendingRequests = new Map<number, PendingRequest>();

function resetConnectionState() {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Connection closed'));
  }
  pendingRequests.clear();
  unlocked = false;
}

export function onDeviceDisconnect(cb: () => void) {
  onDisconnectCallback = cb;
}

// Fires on the unsolicited layerChanged/runtimeStateChanged push notification
// the firmware sends when the active layer changes (zmk.core.Notification).
export function onActiveLayerChange(cb: (highestLayer: number) => void) {
  onActiveLayerCallback = cb;
}

// Fires on every physical key press/release, streamed by the firmware's
// input_stream_worker once subscribeInput(true) is sent (core_subsystem.c).
export function onKeyInputEvent(cb: (position: number, pressed: boolean) => void) {
  onKeyInputCallback = cb;
}

export async function subscribeToInput(enable: boolean): Promise<void> {
  try {
    await sendRequest({ core: { subscribeInput: { enable } } });
  } catch (e: any) {
    debugLog('ERR', 'USB', `subscribeInput failed: ${e.message}`);
  }
}

// Protobuf types
let RequestType: protobuf.Type;
let ResponseType: protobuf.Type;

function initProto() {
  if (RequestType) return;
  try {
    const root = protobuf.Root.fromJSON({ nested: protoJson } as protobuf.INamespace);
    RequestType = root.lookupType('zmk.studio.Request');
    ResponseType = root.lookupType('zmk.studio.Response');
    debugLog('INF', 'USB', 'Protobuf schema loaded');
  } catch (e: any) {
    debugLog('ERR', 'USB', `Protobuf init failed: ${e.message}`);
  }
}

// SLIP framing
function encodeFrame(data: Uint8Array): Uint8Array {
  const out: number[] = [SOF];
  for (const byte of data) {
    if (byte === SOF || byte === EOF || byte === ESC) {
      out.push(ESC, byte);
    } else {
      out.push(byte);
    }
  }
  out.push(EOF);
  return new Uint8Array(out);
}

class FrameDecoder {
  private buffer: number[] = [];
  private inFrame = false;
  private escaped = false;

  onData(data: Uint8Array) {
    for (const byte of data) {
      if (this.escaped) {
        this.buffer.push(byte);
        this.escaped = false;
        continue;
      }
      if (byte === ESC) { this.escaped = true; continue; }
      if (byte === EOF && this.inFrame) {
        this.inFrame = false;
        if (this.buffer.length > 0) {
          handleFrame(new Uint8Array(this.buffer));
        }
        this.buffer = [];
        continue;
      }
      if (byte === SOF) { this.buffer = []; this.inFrame = true; continue; }
      if (this.inFrame) this.buffer.push(byte);
    }
  }
}

const decoder = new FrameDecoder();

// ---- Web Bluetooth transport (ZMK Studio GATT RPC service) ----
// Same framed byte stream as serial: the firmware's gatt_rpc_transport.c
// feeds raw bytes into the same RPC ring buffer, so the SLIP-style
// encoder/decoder above is shared. Responses arrive as GATT indications
// (~27-byte chunks), so BLE requests get a much longer timeout than USB.
const STUDIO_BLE_SERVICE = '00000000-0196-6107-c967-c5cfb1c2482a';
const STUDIO_BLE_RPC_CHRC = '00000001-0196-6107-c967-c5cfb1c2482a';
const BLE_WRITE_CHUNK = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bleDevice: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bleChar: any = null;

export async function connectBle(): Promise<boolean> {
  if (!('bluetooth' in navigator)) {
    debugLog('ERR', 'BLE', 'Web Bluetooth API is not supported. Use Chrome or Edge.');
    alert('Web Bluetooth API is not supported. Use Chrome or Edge.');
    return false;
  }
  try {
    debugLog('INF', 'BLE', 'Requesting Bluetooth device...');
    // Same requestDevice shape as the official zmk-studio-ts-client: filter
    // by the Studio service UUID ONLY. On macOS Chrome surfaces the
    // already-HID-connected keyboard through this filter (CoreBluetooth's
    // connected-peripherals lookup matches by service UUID), so no pairing
    // mode is needed. Do NOT add namePrefix filters: those also match the
    // OS pairing DB's classic-Bluetooth ghost entries ("<name> - Paired"),
    // which always fail gatt.connect() with "Unsupported device".
    bleDevice = await (navigator as any).bluetooth.requestDevice({
      filters: [{ services: [STUDIO_BLE_SERVICE] }],
      optionalServices: [STUDIO_BLE_SERVICE],
    });
    debugLog('INF', 'BLE', `Device selected: ${bleDevice.name}, connecting GATT...`);
    bleDevice.addEventListener('gattserverdisconnected', () => {
      debugLog('WRN', 'BLE', 'GATT disconnected');
      bleChar = null;
      bleDevice = null;
      resetConnectionState();
      onDisconnectCallback?.();
    });
    if (!bleDevice.gatt.connected) {
      await bleDevice.gatt.connect();
    }
    const service = await bleDevice.gatt.getPrimaryService(STUDIO_BLE_SERVICE);
    bleChar = await service.getCharacteristic(STUDIO_BLE_RPC_CHRC);
    // stop-then-start, like the official client: reconnecting to the same
    // device otherwise silently loses notifications. startNotifications
    // subscribes via CCC; the characteristic uses indications, which Web
    // Bluetooth handles through the same API.
    await bleChar.stopNotifications().catch(() => {});
    await bleChar.startNotifications();
    bleChar.addEventListener('characteristicvaluechanged', (e: any) => {
      const dv = e.target.value as DataView;
      decoder.onData(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    });
    initProto();
    debugLog('INF', 'BLE', 'Studio GATT RPC connected');
    return true;
  } catch (e: any) {
    if (e?.name !== 'NotFoundError') {
      debugLog('ERR', 'BLE', `Connection failed: ${e.message || e}`);
    } else {
      debugLog('INF', 'BLE', 'User cancelled device selection');
    }
    try { bleDevice?.gatt?.disconnect?.(); } catch { /* ignore */ }
    bleDevice = null;
    bleChar = null;
    return false;
  }
}

export async function disconnectBle(): Promise<void> {
  try {
    if (bleChar) { await bleChar.stopNotifications().catch(() => {}); bleChar = null; }
    if (bleDevice) { bleDevice.gatt?.disconnect?.(); bleDevice = null; }
    resetConnectionState();
    debugLog('INF', 'BLE', 'Disconnected');
  } catch (e: any) {
    debugLog('WRN', 'BLE', `Disconnect error: ${e.message}`);
  }
}

async function bleWriteFrame(frame: Uint8Array): Promise<void> {
  if (!bleChar) throw new Error('BLE not connected');
  for (let offset = 0; offset < frame.length; offset += BLE_WRITE_CHUNK) {
    const chunk = frame.slice(offset, offset + BLE_WRITE_CHUNK);
    await bleChar.writeValueWithResponse(chunk);
  }
}

// Serial connection
export async function connectUsb(options?: { silent?: boolean }): Promise<boolean> {
  if (!('serial' in navigator)) {
    debugLog('ERR', 'USB', 'Web Serial API is not supported. Use Chrome or Edge.');
    alert('Web Serial API is not supported. Use Chrome or Edge.');
    return false;
  }
  try {
    if (options?.silent) {
      // No user gesture available (e.g. the popup reclaiming the port after
      // Studio hands it back) — only previously-granted ports are usable.
      const granted = await (navigator as any).serial.getPorts();
      if (!granted.length) {
        debugLog('WRN', 'USB', 'Silent connect: no previously granted serial port');
        return false;
      }
      port = granted[0];
    } else {
      debugLog('INF', 'USB', 'Requesting serial port...');
      port = await (navigator as any).serial.requestPort({});
    }
    debugLog('INF', 'USB', 'Port selected, opening...');
    await port!.open({ baudRate: BAUD_RATE });
    if (port!.readable && port!.writable) {
      reader = port!.readable.getReader();
      writer = port!.writable.getWriter();
      startReading();
      initProto();
      debugLog('INF', 'USB', `Serial port opened (baud: ${BAUD_RATE})`);
      return true;
    }
    debugLog('ERR', 'USB', 'Port not readable/writable');
    return false;
  } catch (e: any) {
    if (e?.name !== 'NotFoundError') {
      debugLog('ERR', 'USB', `Connection failed: ${e.message || e}`);
    } else {
      debugLog('INF', 'USB', 'User cancelled port selection');
    }
    port = null;
    return false;
  }
}

async function startReading() {
  try {
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) decoder.onData(value);
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError') {
      debugLog('ERR', 'USB', `Read error: ${e.message}`);
      reader = null;
      writer = null;
      port = null;
      resetConnectionState();
      debugLog('INF', 'USB', 'Connection lost — state reset');
      onDisconnectCallback?.();
    }
  }
}

export function isConnected(): boolean {
  return port !== null || bleChar !== null;
}

export async function disconnectUsb(): Promise<void> {
  try {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); reader = null; }
    if (writer) { await writer.close().catch(() => {}); writer.releaseLock(); writer = null; }
    if (port) { await port.close().catch(() => {}); port = null; }
    resetConnectionState();
    debugLog('INF', 'USB', 'Disconnected');
  } catch (e: any) {
    debugLog('WRN', 'USB', `Disconnect error: ${e.message}`);
  }
}

function handleFrame(data: Uint8Array) {
  try {
    const resp = ResponseType.decode(data) as any;

    // Unsolicited pushes (not tied to a pending request).
    const highestLayer = resp.notification?.core?.layerChanged?.highestLayer
      ?? resp.notification?.core?.runtimeStateChanged?.highestLayer;
    if (highestLayer !== undefined) {
      onActiveLayerCallback?.(highestLayer);
    }

    const inputKey = resp.notification?.core?.inputKey;
    if (inputKey !== undefined) {
      onKeyInputCallback?.(inputKey.position, !!inputKey.pressed);
    }

    const rr = resp.requestResponse;
    if (!rr) return;

    const pending = pendingRequests.get(rr.requestId);
    if (!pending) {
      debugLog('WRN', 'USB', `Unexpected response id: ${rr.requestId}`);
      return;
    }

    clearTimeout(pending.timeout);
    pendingRequests.delete(rr.requestId);

    if (rr.meta?.simpleError !== undefined && rr.meta?.simpleError !== null) {
      const errNames: Record<number, string> = { 0: 'GENERIC', 1: 'UNLOCK_REQUIRED', 2: 'RPC_NOT_FOUND', 3: 'MSG_DECODE_FAILED', 4: 'MSG_ENCODE_FAILED' };
      const errName = errNames[rr.meta.simpleError] || `code ${rr.meta.simpleError}`;
      debugLog('ERR', 'USB', `Device error: ${errName}`);
      if (rr.meta.simpleError === 1) unlocked = false;
      pending.reject(new Error(`Device error: ${errName}`));
      return;
    }

    pending.resolve(rr);
  } catch (e: any) {
    debugLog('WRN', 'USB', `Decode error: ${e.message}`);
  }
}

async function sendRequest(payload: Record<string, unknown>, minTimeoutMs?: number): Promise<any> {
  const viaBle = bleChar !== null;
  if (!writer && !viaBle) throw new Error('Not connected');
  initProto();

  const id = ++requestId;
  const msg = RequestType.create({ requestId: id, ...payload });
  const buffer = RequestType.encode(msg).finish();
  const frame = encodeFrame(buffer);

  // BLE responses arrive as ~27-byte GATT indications (each acked per conn
  // interval), so large replies like getKeymap take seconds -- give BLE a
  // much longer deadline than the serial transport. minTimeoutMs raises the
  // floor further for RPCs known to be slow on the firmware side (e.g.
  // saveChanges, which does one blocking settings_save_one() per dirty key).
  const timeoutMs = Math.max(viaBle ? 30000 : 5000, minTimeoutMs ?? 0);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Response timeout'));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timeout });

    const write = viaBle ? bleWriteFrame(frame) : writer!.write(frame);
    write.catch((e: any) => {
      clearTimeout(timeout);
      pendingRequests.delete(id);
      reject(e);
    });
  });
}

// ZMK Studio API
export async function getDeviceInfo(): Promise<{ name: string; firmwareVersion: string } | null> {
  try {
    const resp = await sendRequest({ core: { getDeviceInfo: true } });
    const info = resp.core?.getDeviceInfo;
    if (info) {
      debugLog('INF', 'USB', `Device: ${info.name} (FW: ${info.firmwareVersion})`);
      return { name: info.name, firmwareVersion: info.firmwareVersion };
    }
    return null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getDeviceInfo failed: ${e.message}`);
    return null;
  }
}

export interface RuntimeBatteryState {
  central: number | null; // dongle; null = unknown (255 on the wire)
  peripheralR: number | null; // slot 0 -- has the trackball
  peripheralL: number | null; // slot 1
  charging: boolean;
  highestLayer: number;
  activeOs?: number;
  osProfileEnabled?: boolean;
  activeLayersBitmask?: number;
  // Always decode to a real boolean (proto3 default is false), even on
  // firmware older than 0.6.12 that doesn't send these fields at all --
  // there's no wire-level way to tell "false" from "field absent" here.
  // Callers MUST cross-check the connected device's firmware version
  // (see firmwareCompat.ts) before trusting these as real connection
  // state; on unsupported firmware they'll misleadingly read as false.
  peripheralRConnected: boolean;
  peripheralLConnected: boolean;
}

const UNKNOWN_BATTERY = 255;
function normalizeBattery(v: number | undefined): number | null {
  return v === undefined || v === UNKNOWN_BATTERY ? null : v;
}

export async function getRuntimeState(): Promise<RuntimeBatteryState | null> {
  try {
    const resp = await sendRequest({ core: { getRuntimeState: true } });
    const rs = resp.core?.getRuntimeState;
    if (!rs) return null;
    return {
      central: normalizeBattery(rs.batteryCentral),
      peripheralR: normalizeBattery(rs.batteryPeripheral),
      peripheralL: normalizeBattery(rs.batteryPeripheralL),
      charging: !!rs.charging,
      highestLayer: rs.highestLayer ?? 0,
      activeOs: rs.activeOs ?? 0,
      osProfileEnabled: !!rs.osProfileEnabled,
      activeLayersBitmask: rs.activeLayersBitmask ?? 0,
      peripheralRConnected: rs.peripheralRConnected,
      peripheralLConnected: rs.peripheralLConnected,
    };
  } catch (e: any) {
    debugLog('ERR', 'USB', `getRuntimeState failed: ${e.message}`);
    return null;
  }
}

export async function getLockState(): Promise<number> {
  try {
    const resp = await sendRequest({ core: { getLockState: true } });
    return resp.core?.getLockState ?? 0;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getLockState failed: ${e.message}`);
    return 0;
  }
}

let unlocked = false;

export function isUnlocked(): boolean {
  return unlocked;
}

export async function requestUnlock(): Promise<boolean> {
  debugLog('INF', 'USB', 'Checking lock state...');
  try {
    const state = await getLockState();
    debugLog('INF', 'USB', `Lock state: ${state} (0=locked, 1=unlocked)`);
    if (state === 1) {
      unlocked = true;
      debugLog('INF', 'USB', 'Device is unlocked');
      return true;
    }
  } catch (e: any) {
    debugLog('WRN', 'USB', `getLockState failed: ${e.message}`);
  }

  // Probe behaviors as fallback
  try {
    const behaviors = await listBehaviors();
    if (behaviors.length > 0) {
      unlocked = true;
      debugLog('INF', 'USB', `Device accessible (${behaviors.length} behaviors). Treating as unlocked.`);
      return true;
    }
  } catch (e: any) {
    debugLog('WRN', 'USB', `Behavior probe failed: ${e.message}`);
  }

  unlocked = false;
  debugLog('WRN', 'USB', 'Device is LOCKED. Press the studio_unlock combo on your keyboard to unlock.');
  return false;
}

// Behavior cache: behaviorId -> { displayName, ... }
const behaviorCache: Record<number, { displayName: string }> = {};

export async function listBehaviors(): Promise<number[]> {
  try {
    const resp = await sendRequest({ behaviors: { listAllBehaviors: true } });
    const ids = resp.behaviors?.listAllBehaviors?.behaviors || [];
    debugLog('INF', 'USB', `Behaviors: ${ids.length} available`);
    return ids;
  } catch (e: any) {
    debugLog('ERR', 'USB', `listBehaviors failed: ${e.message}`);
    return [];
  }
}

// Discovers every custom hold-tap behavior the firmware currently exposes
// (not a hardcoded name list -- generalizes TimingConfig.tsx's per-name
// lookup pattern via CUSTOM_HOLDTAP_RE so new customs show up without an
// editor code change). Used by KeyConfig.tsx to offer them as an explicit
// choice for layer-tap/mod-tap keys, instead of only ever being reachable
// by having read one off the device previously.
export async function listCustomHoldTapBehaviors(): Promise<{ id: number; name: string; kind: 'lt' | 'mt' }[]> {
  const ids = await listBehaviors();
  const result: { id: number; name: string; kind: 'lt' | 'mt' }[] = [];
  for (const id of ids) {
    const details = await getBehaviorDetails(id);
    if (details && CUSTOM_HOLDTAP_RE.test(details.displayName)) {
      result.push({ id, name: details.displayName, kind: /^lt/i.test(details.displayName) ? 'lt' : 'mt' });
    }
  }
  return result;
}

export async function getBehaviorDetails(behaviorId: number): Promise<{ displayName: string } | null> {
  if (behaviorCache[behaviorId]) return behaviorCache[behaviorId];
  try {
    const resp = await sendRequest({ behaviors: { getBehaviorDetails: { behaviorId } } });
    const details = resp.behaviors?.getBehaviorDetails;
    if (details) {
      behaviorCache[behaviorId] = { displayName: details.displayName || `b${behaviorId}` };
      return behaviorCache[behaviorId];
    }
    return null;
  } catch {
    return null;
  }
}

// HID Usage Code to key label
// HID keyboard page (0x07) usage codes
const KB_USAGE_US: Record<number, string> = {
  0: 'NONE', 4: 'A', 5: 'B', 6: 'C', 7: 'D', 8: 'E', 9: 'F', 10: 'G', 11: 'H', 12: 'I', 13: 'J',
  14: 'K', 15: 'L', 16: 'M', 17: 'N', 18: 'O', 19: 'P', 20: 'Q', 21: 'R', 22: 'S', 23: 'T',
  24: 'U', 25: 'V', 26: 'W', 27: 'X', 28: 'Y', 29: 'Z',
  30: '1', 31: '2', 32: '3', 33: '4', 34: '5', 35: '6', 36: '7', 37: '8', 38: '9', 39: '0',
  40: 'Enter', 41: 'Esc', 42: 'Bksp', 43: 'Tab', 44: 'Space',
  45: '-', 46: '=', 47: '[', 48: ']', 49: '\\', 50: '#', 51: ';', 52: "'", 53: '`', 54: ',', 55: '.', 56: '/',
  57: 'Caps', 58: 'F1', 59: 'F2', 60: 'F3', 61: 'F4', 62: 'F5', 63: 'F6',
  64: 'F7', 65: 'F8', 66: 'F9', 67: 'F10', 68: 'F11', 69: 'F12',
  70: 'PrtSc', 71: 'ScrLk', 72: 'Pause', 73: 'Ins', 74: 'Home', 75: 'PgUp',
  76: 'Del', 77: 'End', 78: 'PgDn', 79: 'Right', 80: 'Left', 81: 'Down', 82: 'Up',
  83: 'Num Lock',
  84: 'KP /', 85: 'KP *', 86: 'KP -', 87: 'KP +', 88: 'KP Enter',
  89: 'KP 1', 90: 'KP 2', 91: 'KP 3', 92: 'KP 4', 93: 'KP 5',
  94: 'KP 6', 95: 'KP 7', 96: 'KP 8', 97: 'KP 9', 98: 'KP 0', 99: 'KP .',
  100: '\\', 101: 'App',
  104: 'F13', 105: 'F14', 106: 'F15', 107: 'F16', 108: 'F17', 109: 'F18',
  110: 'F19', 111: 'F20', 112: 'F21', 113: 'F22', 114: 'F23', 115: 'F24',
  135: 'INT_RO', 136: 'INT_KANA', 137: 'INT_YEN',
  144: 'LANG1', 145: 'LANG2',
  224: 'L Ctrl', 225: 'L Shift', 226: 'L Alt', 227: 'L GUI',
  228: 'R Ctrl', 229: 'R Shift', 230: 'R Alt', 231: 'R GUI',
};

const SHIFT_MAP_US: Record<number, string> = {
  30: '!', 31: '@', 32: '#', 33: '$', 34: '%', 35: '^', 36: '&', 37: '*', 38: '(', 39: ')',
  45: '_', 46: '+', 47: '{', 48: '}', 49: '|', 51: ':', 52: '"', 53: '~', 54: '<', 55: '>', 56: '?',
};

// JIS overrides (same HID codes, different printed characters)
const KB_USAGE_JIS_OVERRIDE: Record<number, string> = {
  46: '^', 47: '@', 48: '[', 49: ']', 51: ';', 52: ':', 53: '半/全',
  135: '\\', 136: 'カナ', 137: '¥',
};

const SHIFT_MAP_JIS: Record<number, string> = {
  30: '!', 31: '"', 32: '#', 33: '$', 34: '%', 35: '&', 36: "'", 37: '(', 38: ')', 39: '~',
  45: '=', 46: '~', 47: '`', 48: '{', 49: '}', 51: '+', 52: '*', 53: '半/全', 54: '<', 55: '>', 56: '?',
};

let currentLayout: 'us' | 'jis' = 'us';

export function setKeyboardLayout(layout: 'us' | 'jis') {
  currentLayout = layout;
  // Rebuild reverse lookup tables
  rebuildLabelTables();
}

export function getBehaviorDisplayName(behaviorId: number): string | undefined {
  return behaviorCache[behaviorId]?.displayName;
}

// Read-only snapshots for the config audit (configAudit.ts): the raw
// per-position bindings captured by the last device Read, and the behavior
// id->name table. Copies, so audit code can't mutate connection state.
export function getRawBindingsSnapshot(): Record<string, { behaviorId: number; param1: number; param2: number }> {
  return { ...rawBindings };
}

export function getBehaviorCacheEntries(): { id: number; displayName: string }[] {
  return Object.entries(behaviorCache).map(([id, b]) => ({ id: Number(id), displayName: b.displayName }));
}

export function getKeyboardLayout(): 'us' | 'jis' {
  return currentLayout;
}

export function relabelBindings(layers: import('../types').Layer[]): import('../types').Layer[] {
  return layers.map((layer, layerIdx) => ({
    ...layer,
    keys: layer.keys.map(k => {
      const raw = rawBindings[`${layer.index}:${k.id}`];
      if (!raw) return k;
      const beh = behaviorCache[raw.behaviorId];
      const behName = beh?.displayName || '';
      if (behName.includes('Key Press') || behName === 'kp') {
        const label = hidToLabel(raw.param1);
        return { ...k, binding: { ...k.binding, label, keyCode: label } };
      }
      if (behName.includes('Mod-Tap') || behName === 'mt') {
        const tapLabel = hidToLabel(raw.param2);
        const label = hidToLabel(raw.param1);
        return { ...k, binding: { ...k.binding, label: tapLabel, tapLabel, keyCode: label } };
      }
      if (behName.includes('Layer-Tap') || behName === 'lt') {
        const tapLabel = hidToLabel(raw.param2);
        return { ...k, binding: { ...k.binding, tapLabel } };
      }
      return k;
    }),
  }));
}

function getKbUsage(): Record<number, string> {
  if (currentLayout === 'jis') {
    return { ...KB_USAGE_US, ...KB_USAGE_JIS_OVERRIDE };
  }
  return KB_USAGE_US;
}

function getShiftMap(): Record<number, string> {
  return currentLayout === 'jis' ? SHIFT_MAP_JIS : SHIFT_MAP_US;
}

// Aliases for backward compat within this file
const KB_USAGE = KB_USAGE_US;

// Consumer page (0x0C)
const CONSUMER_USAGE: Record<number, string> = {
  0x6F: 'Bri+', 0x70: 'Bri-',
  0xB5: 'Next', 0xB6: 'Prev', 0xB7: 'Stop', 0xCD: 'Play',
  0xE2: 'Mute', 0xE9: 'Vol+', 0xEA: 'Vol-',
  // AC_NEXT_KEYBOARD_LAYOUT_SELECT -- the macOS "🌐 Globe/fn" key
  // (dt-bindings/zmk/keys.h's GLOBE define).
  0x29D: 'Globe',
};

const MOD_BITS: [number, string][] = [
  [0x01, 'C'], [0x02, 'S'], [0x04, 'A'], [0x08, 'G'],
  [0x10, 'RC'], [0x20, 'RS'], [0x40, 'RA'], [0x80, 'RG'],
];

function parseParam(param: number): { mods: number; page: number; usage: number } {
  return {
    mods: (param >> 24) & 0xFF,
    page: (param >> 16) & 0xFF,
    usage: param & 0xFFFF,
  };
}

function modPrefix(mods: number): string {
  const parts: string[] = [];
  for (const [bit, name] of MOD_BITS) {
    if (mods & bit) parts.push(name);
  }
  return parts.length > 0 ? parts.join('+') + '+' : '';
}

export function hidToLabel(param: number): string {
  const { mods, page, usage } = parseParam(param);
  const kbUsage = getKbUsage();
  const shiftMap = getShiftMap();

  if (page === 0x07 || page === 0x00) {
    const base = kbUsage[usage];
    if (mods === 0) return base || `HID:${usage.toString(16)}`;
    const hasShift = (mods & 0x22) !== 0;
    if (hasShift && shiftMap[usage]) {
      const remainingMods = mods & ~0x22;
      if (remainingMods === 0) return shiftMap[usage];
      return modPrefix(remainingMods) + shiftMap[usage];
    }
    const prefix = modPrefix(mods);
    return prefix + (base || usage.toString(16));
  }
  if (page === 0x0C) {
    const base = CONSUMER_USAGE[usage] || `Con:${usage.toString(16)}`;
    if (mods === 0) return base;
    return modPrefix(mods) + base;
  }
  return `0x${param.toString(16)}`;
}

// Raw protobuf bindings from last Read, keyed by "layerId:posId"
const rawBindings: Record<string, { behaviorId: number; param1: number; param2: number }> = {};

// Reverse lookup: behavior displayName -> behaviorId
function findBehaviorId(name: string): number | null {
  for (const [id, info] of Object.entries(behaviorCache)) {
    if (info.displayName.toLowerCase().includes(name.toLowerCase())) return Number(id);
  }
  return null;
}

// Reverse lookup tables (rebuilt on layout change)
let LABEL_TO_USAGE: Record<string, number> = {};
let LABEL_TO_SHIFTED: Record<string, number> = {};
const LABEL_TO_CONSUMER: Record<string, number> = {};
for (const [code, label] of Object.entries(CONSUMER_USAGE)) {
  LABEL_TO_CONSUMER[label] = Number(code);
}

function rebuildLabelTables() {
  LABEL_TO_USAGE = {};
  for (const [code, label] of Object.entries(getKbUsage())) {
    LABEL_TO_USAGE[label] = Number(code);
  }
  LABEL_TO_SHIFTED = {};
  for (const [code, label] of Object.entries(getShiftMap())) {
    LABEL_TO_SHIFTED[label] = Number(code);
  }
}
rebuildLabelTables();

// Protobuf bindings array order: row-by-row, left then right per row
const KEY_ORDER = [
  'L00','L01','L02','L03','L04','R00','R01','R02','R03','R04',
  'L10','L11','L12','L13','L14','R10','R11','R12','R13','R14',
  'L20','L21','L22','L23','L24','R20','R21','R22','R23','R24',
  'L30','L31','L32','L33','L34','L35','R30','R31','R32','R33',
];

// Detect macro behaviors (non-standard behaviors). Module-scope so both
// readKeymap and combo decoding (which sees the same behaviorId universe)
// can classify a behaviorId as "a firmware macro" consistently.
const STANDARD_BEHAVIORS = new Set([
  'key press', 'mouse key press', 'mouse_move', 'mouse_scroll',
  'none', 'transparent', 'caps word', 'external power',
  'grave/escape', 'key repeat', 'key toggle', 'output selection',
  'sticky key', 'momentary layer', 'sticky layer', 'studio unlock',
  'reset', 'to layer', 'bluetooth', 'bootloader',
  'layer-tap', 'mod-tap', 'toggle layer', 'toggle scroll invert',
  'enc_key_press', 'toggle aml', 'usb slot select', 'pinch zoom',
]);

function computeMacroBehaviorIds(): Set<number> {
  const ids = new Set<number>();
  for (const [idStr, beh] of Object.entries(behaviorCache)) {
    if (!STANDARD_BEHAVIORS.has(beh.displayName.toLowerCase()) && !beh.displayName.toLowerCase().startsWith('mt_')) {
      ids.add(Number(idStr));
    }
  }
  return ids;
}

// Custom hold-tap behaviors (lt6_j, mt_shift, mt_shift_z, ...) are project-
// specific ZMK behaviors layered on top of the built-in &lt/&mt, named by
// convention as "lt<N>_..."/"mt_...". Their firmware displayName is the
// literal behavior name (e.g. "lt6_j"), not a generic "Layer-Tap" category
// string, so they need this separate recognition path. Canonical location:
// configAudit.ts reuses this same regex to detect when one silently stops
// being referenced by any key (the 2026-07 J/Z incident's signature).
export const CUSTOM_HOLDTAP_RE = /^(mt|lt)\d*_/i;

// Decode a raw {behaviorId, param1, param2} triple (as returned by any RPC
// that carries a BehaviorBinding -- keymap bindings, combo bindings, gesture
// overrides) into the editor's local KeyBinding shape. Shared so combos
// don't need their own, slightly-different copy of this classification logic.
function decodeBinding(binding: { behaviorId: number; param1: number; param2: number }): KeyBinding {
  const macroBehaviorIds = computeMacroBehaviorIds();
  const beh = behaviorCache[binding.behaviorId];
  const behName = beh?.displayName || '';

  let type = 'basic';
  let label = hidToLabel(binding.param1);
  let keyCode = label;
  const extra: any = {};

  if (behName.includes('Bluetooth') || behName === 'bt' || behName.includes('bt')) {
    type = 'basic';
    // param1: 0=CLR, 1=NXT, 2=PRV, 3=SEL, 4=CLR_ALL, 5=DISC
    if (binding.param1 === 3) {
      label = `BT ${binding.param2}`;
      keyCode = `BT_SEL ${binding.param2}`;
    } else if (binding.param1 === 0) {
      label = 'BT Clr'; keyCode = 'BT_CLR';
    } else if (binding.param1 === 4) {
      label = 'BT All'; keyCode = 'BT_CLR_ALL';
    } else if (binding.param1 === 1) {
      label = 'BT Nxt'; keyCode = 'BT_NXT';
    } else if (binding.param1 === 2) {
      label = 'BT Prv'; keyCode = 'BT_PRV';
    } else if (binding.param1 === 5) {
      label = 'BT Disc'; keyCode = 'BT_DISC';
    } else {
      label = `BT(${binding.param1},${binding.param2})`;
      keyCode = label;
    }
  } else if (behName.includes('USB Slot Select') || behName === 'usb_sel') {
    type = 'basic';
    label = `USB ${binding.param1}`;
    keyCode = `USB_SEL_${binding.param1}`;
  } else if (behName.includes('Bootloader') || behName === 'bootloader') {
    type = 'basic'; label = 'Boot'; keyCode = 'BOOTLOADER';
  } else if (behName.includes('Reset') || behName === 'sys_reset') {
    type = 'basic'; label = 'Reset'; keyCode = 'RESET';
  } else if (behName.includes('Output') || behName === 'out') {
    type = 'basic';
    // dt-bindings/zmk/outputs.h: OUT_TOG=0, OUT_USB=1, OUT_BLE=2.
    if (binding.param1 === 1) {
      label = 'Out USB'; keyCode = 'OUT_USB';
    } else if (binding.param1 === 2) {
      label = 'Out BT'; keyCode = 'OUT_BT';
    } else if (binding.param1 === 0) {
      label = 'Out Toggle'; keyCode = 'OUT_TOG';
    } else {
      label = `Out(${binding.param1})`; keyCode = label;
    }
  } else if (behName.includes('Scroll Invert') || behName.includes('scrl_inv') || behName.includes('SCRL_INV')) {
    type = 'basic'; label = 'Scrl Inv'; keyCode = 'SCRL_INV';
  } else if (behName.toLowerCase() === 'toggle aml' || behName === 'aml_tog') {
    // Must be checked before the generic "Toggle" (layer toggle) branch
    // below, since "Toggle AML" contains that substring too.
    type = 'basic'; label = 'AML Tog'; keyCode = 'AML_TOG';
  } else if (behName.toLowerCase() === 'pinch zoom' || behName === 'pinch_zm') {
    type = 'basic'; label = 'Pinch Zoom'; keyCode = 'PINCH_ZOOM';
  } else if (behName.includes('Mouse Key Press') || behName === 'mkp' || behName.includes('mkp')) {
    type = 'basic';
    const mouseLabel: Record<number, string> = { 1: 'Click', 2: 'R Click', 4: 'M Click', 8: 'MB4', 16: 'MB5' };
    const mouseCode: Record<number, string> = { 1: 'KC_BTN1', 2: 'KC_BTN2', 4: 'KC_BTN3', 8: 'KC_BTN4', 16: 'KC_BTN5' };
    label = mouseLabel[binding.param1] || `MB${binding.param1}`;
    keyCode = mouseCode[binding.param1] || `mkp MB${binding.param1}`;
  } else if (behName.includes('Key Press') || behName === 'kp') {
    type = 'basic';
    const { mods: kpMods } = parseParam(binding.param1);
    if (kpMods) {
      const modMap: [number, string][] = [
        [0x01, 'lctrl'], [0x02, 'lshift'], [0x04, 'lalt'], [0x08, 'lgui'],
        [0x10, 'rctrl'], [0x20, 'rshift'], [0x40, 'ralt'], [0x80, 'rgui'],
      ];
      const mods: string[] = [];
      for (const [bit, name] of modMap) {
        if (kpMods & bit) mods.push(name);
      }
      extra.modifiers = mods;
      const baseParam = binding.param1 & 0x00FFFFFF;
      const baseLabel = hidToLabel(baseParam);
      label = baseLabel;
      keyCode = baseLabel;
    }
  } else if (behName.includes('Mod-Tap') || behName === 'mt') {
    type = 'mod-tap';
    extra.tapLabel = hidToLabel(binding.param2);
    label = extra.tapLabel;
  } else if (behName.includes('Layer-Tap') || behName === 'lt') {
    type = 'layer-tap';
    extra.layer = binding.param1;
    extra.tapLabel = hidToLabel(binding.param2);
    label = extra.tapLabel;
  } else if (CUSTOM_HOLDTAP_RE.test(behName)) {
    // Project-specific hold-tap (lt6_j, mt_shift, mt_shift_z, ...) -- same
    // param layout as the built-in &lt/&mt cases above, just decoded via the
    // custom behavior's own literal name instead of a generic display string.
    if (/^lt/i.test(behName)) {
      type = 'layer-tap';
      extra.layer = binding.param1;
      extra.tapLabel = hidToLabel(binding.param2);
      label = extra.tapLabel;
    } else {
      type = 'mod-tap';
      extra.tapLabel = hidToLabel(binding.param2);
      label = extra.tapLabel;
    }
  } else if (behName.includes('Momentary') || behName === 'mo') {
    type = 'momentary';
    extra.layer = binding.param1;
    label = `L${binding.param1}`;
    keyCode = `MO(${binding.param1})`;
  } else if (behName.includes('Toggle') || behName === 'tog') {
    type = 'toggle';
    extra.layer = binding.param1;
    label = `TG${binding.param1}`;
    keyCode = `TG(${binding.param1})`;
  } else if (behName.includes('None') || behName === 'none') {
    type = 'none';
    label = '';
    keyCode = 'NONE';
  } else if (behName.includes('Trans') || behName === 'trans') {
    type = 'trans';
    label = '---';
    keyCode = 'TRANS';
  } else if (macroBehaviorIds.has(binding.behaviorId)) {
    type = 'basic';
    const editorName = Object.entries(macroNameToDeviceId).find(([, id]) => id === binding.behaviorId)?.[0];
    const macroName = editorName || behaviorCache[binding.behaviorId]?.displayName || `macro_${binding.behaviorId}`;
    label = `&${macroName}`;
    keyCode = `&${macroName}`;
  } else if (binding.behaviorId === 0 && binding.param1 === 0 && binding.param2 === 0) {
    type = 'none';
    label = '';
    keyCode = 'NONE';
  }

  return { type, keyCode, label, behaviorId: binding.behaviorId, ...extra } as KeyBinding;
}

export async function readKeymap(): Promise<any> {
  try {
    debugLog('INF', 'USB', 'Reading keymap from device...');

    // Get behavior list first
    const behaviorIds = await listBehaviors();
    for (const bid of behaviorIds) {
      await getBehaviorDetails(bid);
    }
    debugLog('INF', 'USB', `Loaded ${Object.keys(behaviorCache).length} behavior details`);

    const macroBehaviorIds = computeMacroBehaviorIds();
    const firmwareMacros: { id: number; name: string }[] = [...macroBehaviorIds].map(id => ({
      id, name: behaviorCache[id]?.displayName || `macro_${id}`,
    }));
    debugLog('INF', 'USB', `Firmware macros found: ${firmwareMacros.length} [${firmwareMacros.map(m => `${m.id}:${m.name}`).join(', ')}]`);
    debugLog('INF', 'USB', `Non-standard check: cache has ${Object.keys(behaviorCache).length} behaviors, standard set has ${STANDARD_BEHAVIORS.size} entries`);

    const resp = await sendRequest({ keymap: { getKeymap: true } });
    const keymap = resp.keymap?.getKeymap;
    if (!keymap) {
      debugLog('WRN', 'USB', 'Empty keymap response');
      return null;
    }

    const layerCount = keymap.layers?.length ?? 0;
    debugLog('INF', 'USB', `Keymap received: ${layerCount} layers`);

    // Convert protobuf keymap to app format
    const layers = keymap.layers.map((layer: any) => {
      const bindings: Record<string, any> = {};

      (layer.bindings || []).forEach((binding: any, idx: number) => {
        if (idx >= KEY_ORDER.length) return;
        const posId = KEY_ORDER[idx];
        const decoded = decodeBinding(binding);

        bindings[posId] = decoded;
        rawBindings[`${layer.id}:${posId}`] = { behaviorId: binding.behaviorId, param1: binding.param1, param2: binding.param2 };
        if (layer.id === 0 && (posId === 'L00' || posId === 'L01')) {
          debugLog('INF', 'USB', `  RAW ${posId}: beh=${binding.behaviorId} p1=0x${binding.param1.toString(16)} p2=0x${binding.param2.toString(16)} → "${decoded.label}"`);
        }
      });

      const layerName = layer.name && layer.name.length > 0 ? layer.name : `Layer ${layer.id}`;
      // Wire value is a packed 0xRRGGBB with bit 24 set to mark "a real color
      // follows" (0 = not reported, e.g. no LED widget compiled in at all);
      // undefined here means "leave ledColor as-is".
      const ledColor = layer.color > 0 ? `#${(layer.color & 0xFFFFFF).toString(16).padStart(6, '0')}` : undefined;
      debugLog('INF', 'USB', `  Layer ${layer.id}: "${layerName}" (${Object.keys(bindings).length} keys)${ledColor ? `, color=${ledColor}` : ''}`);
      return {
        id: layer.id,
        name: layerName,
        bindings,
        ledColor,
      };
    });

    return { layers, firmwareMacros, raw: keymap };
  } catch (e: any) {
    debugLog('ERR', 'USB', `Read keymap failed: ${e.message}`);
    return null;
  }
}

export async function setLayerBinding(layerId: number, keyPosition: number, behaviorId: number, param1: number, param2: number): Promise<boolean> {
  try {
    const resp = await sendRequest({
      keymap: {
        setLayerBinding: { layerId, keyPosition, binding: { behaviorId, param1, param2 } },
      },
    });
    const result = resp.keymap?.setLayerBinding;
    const errNames: Record<number, string> = { 0: 'OK', 1: 'INVALID_LOCATION', 2: 'INVALID_BEHAVIOR', 3: 'INVALID_PARAMETERS' };
    if (typeof result === 'number' && result !== 0) {
      debugLog('ERR', 'USB', `setLayerBinding response: ${errNames[result] || result}`);
      return false;
    }
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setLayerBinding failed: ${e.message}`);
    return false;
  }
}

export async function setLayerProps(layerId: number, name: string, colorHex?: string): Promise<boolean> {
  try {
    // Firmware color field: 0 means "leave color unchanged". A real color has
    // bit 24 (0x01000000) set so packed black (#000000) doesn't collide with
    // that sentinel. Anything that isn't a #rrggbb string (e.g. a pre-v0.36.0
    // keyword like 'green' surviving in an imported file) is treated as "no
    // change" rather than half-parsed into a garbage color -- parseInt(hex)
    // reads 'cyan' as 0xC and 'green' as NaN.
    let color = 0;
    if (colorHex !== undefined) {
      if (/^#[0-9a-f]{6}$/i.test(colorHex)) {
        color = 0x01000000 | parseInt(colorHex.slice(1), 16);
      } else {
        debugLog('WRN', 'USB', `setLayerProps: unrecognized color "${colorHex}" for layer ${layerId}, leaving device color unchanged`);
      }
    }
    const resp = await sendRequest({
      keymap: { setLayerProps: { layerId, name, color } },
    });
    const result = resp.keymap?.setLayerProps;
    if (typeof result === 'number' && result !== 0) {
      debugLog('ERR', 'USB', `setLayerProps response: ${result}`);
      return false;
    }
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setLayerProps failed: ${e.message}`);
    return false;
  }
}

export async function saveChanges(): Promise<boolean> {
  try {
    debugLog('INF', 'USB', 'Saving changes to device flash...');
    // Firmware writes one settings_save_one() per dirty key, fully serially
    // (see zmk/app/src/keymap.c's save_bindings()) -- a large diff can easily
    // exceed the default 5s serial timeout even though the device is still
    // working, not stuck. 20s floor gives that room without weakening BLE's
    // already-larger default.
    const resp = await sendRequest({ keymap: { saveChanges: true } }, 20000);
    const saveResp = resp.keymap?.saveChanges;
    if (saveResp?.err !== undefined && saveResp?.err !== null && saveResp.err !== 0) {
      const errNames: Record<number, string> = { 1: 'GENERIC', 2: 'NOT_SUPPORTED', 3: 'NO_SPACE' };
      debugLog('ERR', 'USB', `Save error: ${errNames[saveResp.err] || `code ${saveResp.err}`}`);
      return false;
    }
    debugLog('INF', 'USB', 'Changes saved to flash');
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `Save failed: ${e.message}`);
    return false;
  }
}

export async function discardChanges(): Promise<boolean> {
  try {
    const resp = await sendRequest({ keymap: { discardChanges: true } });
    debugLog('INF', 'USB', 'Changes discarded');
    return resp.keymap?.discardChanges !== undefined;
  } catch (e: any) {
    debugLog('ERR', 'USB', `Discard failed: ${e.message}`);
    return false;
  }
}

export async function getTappingTerm(): Promise<number | null> {
  try {
    const resp = await sendRequest({ core: { getTappingTerm: true } });
    const tt = resp.core?.getTappingTerm;
    if (tt) {
      const ms = tt.tappingTermMs ?? tt.tappingTerm ?? null;
      debugLog('INF', 'USB', `Tapping term: ${ms}ms (default: ${tt.defaultTappingTermMs}ms)`);
      return ms;
    }
    return null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getTappingTerm failed: ${e.message}`);
    return null;
  }
}

export async function setTappingTerm(ms: number): Promise<boolean> {
  try {
    await sendRequest({ core: { setTappingTerm: { tappingTermMs: ms } } });
    debugLog('INF', 'USB', `Tapping term set to ${ms}ms`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setTappingTerm failed: ${e.message}`);
    return false;
  }
}

// Keyboard-side key-repeat emulation (works around macOS not repeating
// letter keys under a sustained hold -- see conductor_key_repeat.h on the
// firmware side). Default off.
// Build identity of one unit (dongle itself or a split peripheral), for
// firmware-mismatch detection. buildId is the CI-injected short git SHA --
// identical across every unit of one CI run, "" on local builds or firmware
// too old to report it (which the UI shows as "unknown", not a mismatch).
export interface FirmwareUnitInfo {
  connected: boolean;
  stamp: string;
  buildId: string;
}

export async function getFirmwareInfo(): Promise<{ self: FirmwareUnitInfo; peripherals: FirmwareUnitInfo[] } | null> {
  try {
    const resp = await sendRequest({ core: { getFirmwareInfo: true } });
    const info = resp.core?.getFirmwareInfo;
    if (!info?.self) {
      // Firmware predating the RPC responds without this oneof member.
      return null;
    }
    const unit = (u: any): FirmwareUnitInfo => ({
      connected: u?.connected === true,
      stamp: u?.stamp ?? '',
      buildId: u?.buildId ?? '',
    });
    return { self: unit(info.self), peripherals: (info.peripherals ?? []).map(unit) };
  } catch (e: any) {
    debugLog('WRN', 'USB', `getFirmwareInfo failed (old firmware?): ${e.message}`);
    return null;
  }
}

export async function getKeyRepeatEnabled(): Promise<boolean | null> {
  try {
    const resp = await sendRequest({ core: { getKeyRepeatEnabled: true } });
    return resp.core?.getKeyRepeatEnabled === true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getKeyRepeatEnabled failed: ${e.message}`);
    return null;
  }
}

export async function setKeyRepeatEnabled(enabled: boolean): Promise<boolean> {
  try {
    await sendRequest({ core: { setKeyRepeatEnabled: { enabled } } });
    debugLog('INF', 'USB', `Key repeat emulation ${enabled ? 'enabled' : 'disabled'}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setKeyRepeatEnabled failed: ${e.message}`);
    return false;
  }
}

export async function getBleProfiles(): Promise<{ profiles: { name: string; connected: boolean }[]; activeIndex: number } | null> {
  try {
    const resp = await sendRequest({ core: { getBleProfiles: true } });
    const p = resp.core?.getBleProfiles;
    if (p) {
      return { profiles: p.profiles ?? [], activeIndex: p.activeIndex ?? 0 };
    }
    return null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getBleProfiles failed: ${e.message}`);
    return null;
  }
}

export async function setBleProfileName(profileIndex: number, name: string): Promise<boolean> {
  try {
    await sendRequest({ core: { setBleProfileName: { profileIndex, name } } });
    debugLog('INF', 'USB', `BT profile ${profileIndex} name set to "${name}"`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setBleProfileName failed: ${e.message}`);
    return false;
  }
}

export async function setActiveBleProfile(profileIndex: number): Promise<boolean> {
  try {
    await sendRequest({ core: { setActiveBleProfile: { profileIndex } } });
    debugLog('INF', 'USB', `Active BT profile set to ${profileIndex}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setActiveBleProfile failed: ${e.message}`);
    return false;
  }
}

// USB has no ZMK-native "profile" concept (unlike BLE), so it gets 5
// software-selected virtual slots (see conductor_usb_slot.h on the firmware
// side) mirroring the 5 BLE profiles, switched on-device via &usb_sel.
export async function getUsbSlots(): Promise<{ slots: { name: string }[]; activeIndex: number } | null> {
  try {
    const resp = await sendRequest({ core: { getUsbSlots: true } });
    const s = resp.core?.getUsbSlots;
    if (s) {
      return { slots: s.slots ?? [], activeIndex: s.activeIndex ?? 0 };
    }
    return null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getUsbSlots failed: ${e.message}`);
    return null;
  }
}

export async function setUsbSlotName(slotIndex: number, name: string): Promise<boolean> {
  try {
    await sendRequest({ core: { setUsbSlotName: { slotIndex, name } } });
    debugLog('INF', 'USB', `USB slot ${slotIndex} name set to "${name}"`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setUsbSlotName failed: ${e.message}`);
    return false;
  }
}

export async function setActiveUsbSlot(slotIndex: number): Promise<boolean> {
  try {
    await sendRequest({ core: { setActiveUsbSlot: { slotIndex } } });
    debugLog('INF', 'USB', `Active USB slot set to ${slotIndex}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setActiveUsbSlot failed: ${e.message}`);
    return false;
  }
}

// Pointing (trackball) APIs
export async function getSensitivity(): Promise<{ cpi: number; cursorNum: number; cursorDen: number; scrollNum: number; scrollDen: number; scrollInverted: boolean } | null> {
  try {
    const resp = await sendRequest({ pointing: { getSensitivity: {} } });
    const s = resp.pointing?.getSensitivity;
    if (s) {
      // scroll.numerator is wire-type uint32 (see pointing.proto), but
      // setSensitivity() below encodes "inverted" by sending a negative JS
      // number into it, which wraps to a huge unsigned value (e.g. -400 ->
      // 4294966896). protobufjs decodes a uint32 field as a plain
      // non-negative number, so it never comes back negative here -- fix by
      // reinterpreting values above the int32 range as their two's-
      // complement negative equivalent before checking the sign, instead of
      // just testing `< 0` (which could never be true and left inversion
      // undetected + that huge number surfacing as-is in diagnostics).
      const u32ScrollNum = (s.scroll?.numerator ?? 1) >>> 0;
      const rawScrollNum = u32ScrollNum > 0x7FFFFFFF ? u32ScrollNum - 0x100000000 : u32ScrollNum;
      const scrollInverted = rawScrollNum < 0;
      return { cpi: s.cpi, cursorNum: s.cursor?.numerator ?? 1, cursorDen: s.cursor?.denominator ?? 1, scrollNum: Math.abs(rawScrollNum), scrollDen: s.scroll?.denominator ?? 1, scrollInverted };
    }
    return null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getSensitivity failed: ${e.message}`);
    return null;
  }
}

export async function setSensitivity(cpi: number, scrollNum: number, scrollDen: number, scrollInverted: boolean = false): Promise<boolean> {
  try {
    const signedScrollNum = scrollInverted ? -scrollNum : scrollNum;
    await sendRequest({ pointing: { setSensitivity: { cpi, cursor: { numerator: 1, denominator: 1 }, scroll: { numerator: signedScrollNum, denominator: scrollDen } } } });
    debugLog('INF', 'USB', `Sensitivity set: CPI=${cpi}, scroll=${scrollNum}/${scrollDen}, inverted=${scrollInverted}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setSensitivity failed: ${e.message}`);
    return false;
  }
}

export async function getAutoLayer(): Promise<{ enabled: boolean; requirePriorIdleMs: number; excludedPositions: number[]; motionThreshold: number; durationMs: number } | null> {
  try {
    const resp = await sendRequest({ pointing: { getAutoLayer: {} } });
    const aml = resp.pointing?.getAutoLayer;
    if (!aml) return null;
    return {
      enabled: aml.enabled ?? true,
      requirePriorIdleMs: aml.requirePriorIdleMs ?? 0,
      excludedPositions: aml.excludedPositions ?? [],
      motionThreshold: aml.motionThreshold ?? 0,
      durationMs: aml.durationMs ?? 0,
    };
  } catch (e: any) {
    debugLog('ERR', 'USB', `getAutoLayer failed: ${e.message}`);
    return null;
  }
}

export async function setAutoLayer(enabled: boolean, requirePriorIdleMs: number, excludedPositions: number[], motionThreshold: number, durationMs?: number): Promise<boolean> {
  try {
    await sendRequest({ pointing: { setAutoLayer: { enabled, requirePriorIdleMs, excludedPositions, motionThreshold, durationMs: durationMs ?? 0 } } });
    debugLog('INF', 'USB', `AML set: enabled=${enabled}, idle=${requirePriorIdleMs}ms, duration=${durationMs ?? 0}ms, excluded=[${excludedPositions.join(',')}]`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setAutoLayer failed: ${e.message}`);
    return false;
  }
}

export async function getHoldTapPositions(behaviorId: number): Promise<{ positions: number[]; hasRuntimeOverride: boolean } | null> {
  try {
    const resp = await sendRequest({ behaviors: { getHoldTapPositions: { behaviorId } } });
    const details = resp.behaviors?.getHoldTapPositions;
    if (!details) return null;
    return {
      positions: details.positions ?? [],
      hasRuntimeOverride: details.hasRuntimeOverride ?? false,
    };
  } catch (e: any) {
    debugLog('ERR', 'USB', `getHoldTapPositions failed: ${e.message}`);
    return null;
  }
}

export async function setHoldTapPositions(behaviorId: number, positions: number[], clearOverride: boolean = false): Promise<boolean> {
  try {
    await sendRequest({ behaviors: { setHoldTapPositions: { behaviorId, positions, clearOverride } } });
    debugLog('INF', 'USB', `hold-tap positions set for behavior ${behaviorId}: clear=${clearOverride}, positions=[${positions.join(',')}]`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setHoldTapPositions failed: ${e.message}`);
    return false;
  }
}

// Hold-tap "flavor" (decision algorithm) runtime override. 0-3, matching
// firmware's enum flavor / the devicetree flavor property's enum order:
// 0=hold-preferred, 1=balanced, 2=tap-preferred, 3=tap-unless-interrupted.
export async function getHoldTapFlavor(behaviorId: number): Promise<{ flavor: number; hasRuntimeOverride: boolean } | null> {
  try {
    const resp = await sendRequest({ behaviors: { getHoldTapFlavor: { behaviorId } } });
    const details = resp.behaviors?.getHoldTapFlavor;
    if (!details) return null;
    return {
      flavor: details.flavor ?? 0,
      hasRuntimeOverride: details.hasRuntimeOverride ?? false,
    };
  } catch (e: any) {
    debugLog('ERR', 'USB', `getHoldTapFlavor failed: ${e.message}`);
    return null;
  }
}

export async function setHoldTapFlavor(behaviorId: number, flavor: number, clearOverride: boolean = false): Promise<boolean> {
  try {
    await sendRequest({ behaviors: { setHoldTapFlavor: { behaviorId, flavor, clearOverride } } });
    debugLog('INF', 'USB', `hold-tap flavor set for behavior ${behaviorId}: clear=${clearOverride}, flavor=${flavor}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setHoldTapFlavor failed: ${e.message}`);
    return false;
  }
}

export async function getPrecisionScale(): Promise<{ numerator: number; denominator: number } | null> {
  try {
    const resp = await sendRequest({ pointing: { getPrecisionScale: {} } });
    return resp.pointing?.getPrecisionScale?.precision || null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getPrecisionScale failed: ${e.message}`);
    return null;
  }
}

export async function setPrecisionScale(numerator: number, denominator: number): Promise<boolean> {
  try {
    await sendRequest({ pointing: { setPrecisionScale: { precision: { numerator, denominator } } } });
    debugLog('INF', 'USB', `Precision set: ${numerator}/${denominator}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setPrecisionScale failed: ${e.message}`);
    return false;
  }
}

export async function getSpeedScale(): Promise<{ numerator: number; denominator: number } | null> {
  try {
    const resp = await sendRequest({ pointing: { getSpeedScale: {} } });
    return resp.pointing?.getSpeedScale?.speed || null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getSpeedScale failed: ${e.message}`);
    return null;
  }
}

export async function setSpeedScale(numerator: number, denominator: number): Promise<boolean> {
  try {
    await sendRequest({ pointing: { setSpeedScale: { speed: { numerator, denominator } } } });
    debugLog('INF', 'USB', `Speed set: ${numerator}/${denominator}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setSpeedScale failed: ${e.message}`);
    return false;
  }
}

export async function getAccel(): Promise<{ enabled: boolean; maxMilli: number; threshold: number; range: number } | null> {
  try {
    const resp = await sendRequest({ pointing: { getAccel: {} } });
    return resp.pointing?.getAccel?.accel || null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getAccel failed: ${e.message}`);
    return null;
  }
}

export async function setAccel(enabled: boolean, maxMilli: number, threshold: number, range: number): Promise<boolean> {
  try {
    await sendRequest({ pointing: { setAccel: { accel: { enabled, maxMilli, threshold, range } } } });
    debugLog('INF', 'USB', `Accel set: enabled=${enabled}, max=${maxMilli}, threshold=${threshold}, range=${range}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setAccel failed: ${e.message}`);
    return false;
  }
}

export async function getInertia(): Promise<{ enabled: boolean; decayMilli: number; startSpeed: number } | null> {
  try {
    const resp = await sendRequest({ pointing: { getInertia: {} } });
    return resp.pointing?.getInertia?.inertia || null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getInertia failed: ${e.message}`);
    return null;
  }
}

export async function setInertia(enabled: boolean, decayMilli: number, startSpeed: number): Promise<boolean> {
  try {
    await sendRequest({ pointing: { setInertia: { inertia: { enabled, decayMilli, startSpeed } } } });
    debugLog('INF', 'USB', `Inertia set: enabled=${enabled}, decay=${decayMilli}, startSpeed=${startSpeed}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setInertia failed: ${e.message}`);
    return false;
  }
}

export async function getDragScale(): Promise<{ enabled: boolean; numerator: number; denominator: number } | null> {
  try {
    const resp = await sendRequest({ pointing: { getDragScale: {} } });
    return resp.pointing?.getDragScale?.dragScale || null;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getDragScale failed: ${e.message}`);
    return null;
  }
}

export async function setDragScale(enabled: boolean, numerator: number, denominator: number): Promise<boolean> {
  try {
    await sendRequest({ pointing: { setDragScale: { dragScale: { enabled, numerator, denominator } } } });
    debugLog('INF', 'USB', `Drag scale set: enabled=${enabled}, ratio=${numerator}/${denominator}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setDragScale failed: ${e.message}`);
    return false;
  }
}

// Per-output-device gesture binding override. Flattened per (endpoint,
// direction): index = endpointIndex*4 + direction (0=up,1=down,2=left,3=right).
// endpointIndex is zmk_endpoint_instance_to_index (NONE=0, USB=1, BT profile
// N=2+N). hasOverride[i]=false means that slot falls back to the shared/DT
// default gesture binding.
export interface GestureBindingValue { behaviorId: number; param1: number; param2: number; }

// Best-effort label for a gesture override value, for display only (mirrors
// relabelBindings' 'kp' case). Requires ensureBehaviorsLoaded() to have run
// for the behavior name to be known; falls back to a generic id otherwise.
export function gestureBindingLabel(v: GestureBindingValue): string {
  const name = getBehaviorDisplayName(v.behaviorId) ?? '';
  if (name === 'Key Press' || name === 'kp') {
    return hidToLabel(v.param1);
  }
  if (name === 'None' || name === 'none') {
    return '---';
  }
  return name || `#${v.behaviorId}`;
}

export async function getGestureConfig(): Promise<{ enabled: boolean; hasOverride: boolean[]; overrides: GestureBindingValue[]; endpointCount: number; activeEndpoint: number } | null> {
  try {
    const resp = await sendRequest({ pointing: { getGestureConfig: {} } });
    const g = resp.pointing?.getGestureConfig;
    if (!g) return null;
    return {
      enabled: g.enabled ?? false,
      hasOverride: g.hasOverride ?? [],
      overrides: (g.overrides ?? []).map((o: any) => ({
        behaviorId: o.behaviorId ?? 0, param1: o.param1 ?? 0, param2: o.param2 ?? 0,
      })),
      endpointCount: g.endpointCount ?? 0,
      activeEndpoint: g.activeEndpoint ?? 0,
    };
  } catch (e: any) {
    debugLog('ERR', 'USB', `getGestureConfig failed: ${e.message}`);
    return null;
  }
}

export async function setGestureEnabled(enabled: boolean): Promise<boolean> {
  try {
    await sendRequest({ pointing: { setGestureEnabled: { enabled } } });
    debugLog('INF', 'USB', `Gesture overrides enabled=${enabled}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setGestureEnabled failed: ${e.message}`);
    return false;
  }
}

export async function setGestureBinding(endpointIndex: number, direction: number, clear: boolean, binding?: GestureBindingValue): Promise<boolean> {
  try {
    await sendRequest({
      pointing: {
        setGestureBinding: {
          endpointIndex, direction, clear,
          binding: binding ?? { behaviorId: 0, param1: 0, param2: 0 },
        },
      },
    });
    debugLog('INF', 'USB', `Gesture binding set: endpoint=${endpointIndex} direction=${direction} clear=${clear}`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setGestureBinding failed: ${e.message}`);
    return false;
  }
}

// Per-output-device keymap overlay. osMap is indexed by
// zmk_endpoint_instance_to_index (NONE=0, USB=1, BT profile N=2+N); each
// entry is a layer id activated on top of the shared keymap when that
// endpoint is selected (0 = no overlay, shared keymap only).
export async function getOsConfig(): Promise<{ enabled: boolean; osMap: number[]; endpointCount: number; activeEndpoint: number; activeOs: number } | null> {
  try {
    const resp = await sendRequest({ core: { getOsConfig: true } });
    const c = resp.core?.getOsConfig;
    if (!c) return null;
    return {
      enabled: c.enabled ?? false,
      osMap: c.osMap ?? [],
      endpointCount: c.endpointCount ?? 0,
      activeEndpoint: c.activeEndpoint ?? 0,
      activeOs: c.activeOs ?? 0,
    };
  } catch (e: any) {
    debugLog('ERR', 'USB', `getOsConfig failed: ${e.message}`);
    return null;
  }
}

export async function setOsConfig(enabled: boolean, osMap: number[]): Promise<boolean> {
  try {
    await sendRequest({ core: { setOsConfig: { enabled, osMap } } });
    debugLog('INF', 'USB', `OS config set: enabled=${enabled}, map=[${osMap.join(',')}]`);
    return true;
  } catch (e: any) {
    debugLog('ERR', 'USB', `setOsConfig failed: ${e.message}`);
    return false;
  }
}

function stripCursor(sensitivity: { cpi: number; cursorNum: number; cursorDen: number; scrollNum: number; scrollDen: number; scrollInverted: boolean }): SensitivitySnapshot {
  return { cpi: sensitivity.cpi, scrollNum: sensitivity.scrollNum, scrollDen: sensitivity.scrollDen, scrollInverted: sensitivity.scrollInverted };
}

export async function collectDeviceSettingsSnapshot(options?: { includeAllSlotProfiles?: boolean }): Promise<DeviceSettingsSnapshot> {
  const snapshot: DeviceSettingsSnapshot = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
  };

  if (!isConnected()) {
    debugLog('WRN', 'USB', 'Device settings snapshot skipped: no device connected');
    return snapshot;
  }

  // Per-slot cycling below requires secured RPCs (set_active_usb_slot /
  // set_active_ble_profile); if the device can't be unlocked, every switch
  // would silently fail and leave the snapshot full of empty {} entries
  // that look like "no per-slot config" instead of "couldn't read this".
  let includeAllSlotProfiles = options?.includeAllSlotProfiles ?? true;
  if (includeAllSlotProfiles && !isUnlocked() && !(await requestUnlock())) {
    debugLog('WRN', 'USB', 'Device is locked: skipping per-slot trackball backup, exporting current slot only');
    includeAllSlotProfiles = false;
  }

  const [
    device,
    tappingTerm,
    bluetoothProfiles,
    usbSlots,
    sensitivity,
    autoLayer,
    precisionScale,
    speedScale,
    accel,
    inertia,
    dragScale,
    osConfig,
    gestureConfig,
  ] = await Promise.all([
    getDeviceInfo(),
    getTappingTerm(),
    getBleProfiles(),
    getUsbSlots(),
    getSensitivity(),
    getAutoLayer(),
    getPrecisionScale(),
    getSpeedScale(),
    getAccel(),
    getInertia(),
    getDragScale(),
    getOsConfig(),
    getGestureConfig(),
  ]);

  if (device) snapshot.device = device;
  if (tappingTerm !== null) snapshot.tappingTerm = tappingTerm;
  if (bluetoothProfiles) snapshot.bluetoothProfiles = bluetoothProfiles;
  if (usbSlots) snapshot.usbSlots = usbSlots;
  if (sensitivity || autoLayer || precisionScale || speedScale || accel || inertia || dragScale) {
    snapshot.trackball = {};
    if (sensitivity && !(usbSlots || bluetoothProfiles)) snapshot.trackball.sensitivity = stripCursor(sensitivity);
    if (autoLayer) snapshot.trackball.autoLayer = autoLayer;
    if (precisionScale && !(usbSlots || bluetoothProfiles)) snapshot.trackball.precisionScale = precisionScale;
    if (speedScale && !(usbSlots || bluetoothProfiles)) snapshot.trackball.speedScale = speedScale;
    if (accel && !(usbSlots || bluetoothProfiles)) snapshot.trackball.accel = accel;
    if (inertia && !(usbSlots || bluetoothProfiles)) snapshot.trackball.inertia = inertia;
    if (dragScale && !(usbSlots || bluetoothProfiles)) snapshot.trackball.dragScale = dragScale;
  }

  if (includeAllSlotProfiles && (usbSlots || bluetoothProfiles)) {
    const usbCount = usbSlots?.slots?.length ?? 0;
    const btCount = bluetoothProfiles?.profiles?.length ?? 0;
    const total = usbCount + btCount;
    const profiles: NonNullable<DeviceSettingsSnapshot['trackballProfiles']>['profiles'] = [];
    // osConfig/gestureConfig's activeEndpoint is the only source that knows
    // which of the 10 conductor slots is truly active right now (USB's and
    // BLE's own activeIndex are tracked independently of each other and of
    // which transport is actually selected). If neither is available, there
    // is no safe guess — skip the restore below rather than silently
    // defaulting to slot 0.
    const originalEndpoint = osConfig?.activeEndpoint ?? gestureConfig?.activeEndpoint;

    for (let slotIndex = 0; slotIndex < total; slotIndex++) {
      const selected = slotIndex < usbCount
        ? await setActiveUsbSlot(slotIndex)
        : await setActiveBleProfile(slotIndex - usbCount);
      if (!selected) {
        profiles[slotIndex] = {};
        continue;
      }
      const [slotSensitivity, slotPrecisionScale, slotSpeedScale, slotAccel, slotInertia, slotDragScale] = await Promise.all([
        getSensitivity(),
        getPrecisionScale(),
        getSpeedScale(),
        getAccel(),
        getInertia(),
        getDragScale(),
      ]);
      profiles[slotIndex] = {};
      if (slotSensitivity) profiles[slotIndex].sensitivity = stripCursor(slotSensitivity);
      if (slotPrecisionScale) profiles[slotIndex].precisionScale = slotPrecisionScale;
      if (slotSpeedScale) profiles[slotIndex].speedScale = slotSpeedScale;
      if (slotAccel) profiles[slotIndex].accel = slotAccel;
      if (slotInertia) profiles[slotIndex].inertia = slotInertia;
      if (slotDragScale) profiles[slotIndex].dragScale = slotDragScale;
    }

    if (originalEndpoint === undefined) {
      debugLog('ERR', 'USB', 'Could not determine the original active output; left on the last scanned slot. Check the active USB slot / BLE profile on the device.');
    } else if (originalEndpoint < usbCount) {
      await setActiveUsbSlot(originalEndpoint);
    } else if (originalEndpoint < total) {
      await setActiveBleProfile(originalEndpoint - usbCount);
    }

    snapshot.trackballProfiles = {
      conductorSlotCount: total,
      profiles,
    };
  }

  if (osConfig) snapshot.osConfig = osConfig;
  if (gestureConfig) snapshot.gestureConfig = gestureConfig;

  debugLog('INF', 'USB', 'Device settings snapshot collected');
  return snapshot;
}

export async function applyDeviceSettingsSnapshot(snapshot: DeviceSettingsSnapshot): Promise<boolean> {
  if (!isConnected()) {
    debugLog('WRN', 'USB', 'Device settings import skipped: no device connected');
    return false;
  }
  if (!isUnlocked() && !(await requestUnlock())) {
    debugLog('ERR', 'USB', 'Device settings import failed: device is locked');
    return false;
  }

  let ok = true;
  const remember = async (label: string, action: Promise<boolean>) => {
    const result = await action;
    if (!result) {
      ok = false;
      debugLog('WRN', 'USB', `Device settings import step failed: ${label}`);
    }
    return result;
  };

  if (snapshot.tappingTerm !== undefined) {
    await remember('tapping term', setTappingTerm(snapshot.tappingTerm));
  }

  if (snapshot.bluetoothProfiles?.profiles) {
    for (let i = 0; i < snapshot.bluetoothProfiles.profiles.length; i++) {
      const name = snapshot.bluetoothProfiles.profiles[i]?.name;
      if (name !== undefined) await remember(`BT profile ${i} name`, setBleProfileName(i, name));
    }
  }

  if (snapshot.usbSlots?.slots) {
    for (let i = 0; i < snapshot.usbSlots.slots.length; i++) {
      const name = snapshot.usbSlots.slots[i]?.name;
      if (name !== undefined) await remember(`USB slot ${i} name`, setUsbSlotName(i, name));
    }
    if (snapshot.usbSlots.activeIndex !== undefined) {
      debugLog('WRN', 'USB', 'USB active slot is recorded in the JSON, but current firmware has no RPC to restore it');
    }
  }

  const trackball = snapshot.trackball;
  const trackballProfiles = snapshot.trackballProfiles;
  const hasTrackballProfiles = !!trackballProfiles?.profiles?.length;
  if (!hasTrackballProfiles && trackball?.sensitivity) {
    const s = trackball.sensitivity;
    await remember('trackball sensitivity', setSensitivity(s.cpi, s.scrollNum, s.scrollDen, s.scrollInverted));
  }
  if (trackball?.autoLayer) {
    const a = trackball.autoLayer;
    await remember('AML', setAutoLayer(a.enabled, a.requirePriorIdleMs, a.excludedPositions, a.motionThreshold, a.durationMs));
  }
  if (!hasTrackballProfiles && trackball?.precisionScale) {
    const p = trackball.precisionScale;
    await remember('precision scale', setPrecisionScale(p.numerator, p.denominator));
  }
  if (!hasTrackballProfiles && trackball?.speedScale) {
    const s = trackball.speedScale;
    await remember('speed scale', setSpeedScale(s.numerator, s.denominator));
  }
  if (!hasTrackballProfiles && trackball?.accel) {
    const a = trackball.accel;
    await remember('accel', setAccel(a.enabled, a.maxMilli, a.threshold, a.range));
  }
  if (!hasTrackballProfiles && trackball?.inertia) {
    const i = trackball.inertia;
    await remember('inertia', setInertia(i.enabled, i.decayMilli, i.startSpeed));
  }
  if (!hasTrackballProfiles && trackball?.dragScale) {
    const d = trackball.dragScale;
    await remember('drag scale', setDragScale(d.enabled, d.numerator, d.denominator));
  }

  if (trackballProfiles?.profiles?.length) {
    const usbCount = snapshot.usbSlots?.slots?.length ?? 0;
    const btCount = snapshot.bluetoothProfiles?.profiles?.length ?? 0;
    const total = Math.min(trackballProfiles.profiles.length, usbCount + btCount);
    const originalEndpoint = snapshot.osConfig?.activeEndpoint ?? snapshot.gestureConfig?.activeEndpoint;

    for (let slotIndex = 0; slotIndex < total; slotIndex++) {
      const selected = slotIndex < usbCount
        ? await remember(`select USB slot ${slotIndex}`, setActiveUsbSlot(slotIndex))
        : await remember(`select BT profile ${slotIndex - usbCount}`, setActiveBleProfile(slotIndex - usbCount));
      if (!selected) continue;
      const profile = trackballProfiles.profiles[slotIndex];
      if (profile?.sensitivity) {
        const s = profile.sensitivity;
        await remember(`trackball sensitivity ${slotIndex}`, setSensitivity(s.cpi, s.scrollNum, s.scrollDen, s.scrollInverted));
      }
      if (profile?.precisionScale) {
        const p = profile.precisionScale;
        await remember(`precision scale ${slotIndex}`, setPrecisionScale(p.numerator, p.denominator));
      }
      if (profile?.speedScale) {
        const s = profile.speedScale;
        await remember(`speed scale ${slotIndex}`, setSpeedScale(s.numerator, s.denominator));
      }
      if (profile?.accel) {
        const a = profile.accel;
        await remember(`accel ${slotIndex}`, setAccel(a.enabled, a.maxMilli, a.threshold, a.range));
      }
      if (profile?.inertia) {
        const i = profile.inertia;
        await remember(`inertia ${slotIndex}`, setInertia(i.enabled, i.decayMilli, i.startSpeed));
      }
      if (profile?.dragScale) {
        const d = profile.dragScale;
        await remember(`drag scale ${slotIndex}`, setDragScale(d.enabled, d.numerator, d.denominator));
      }
      await remember(`save pointing ${slotIndex}`, saveChanges());
    }

    if (originalEndpoint === undefined) {
      debugLog('ERR', 'USB', 'Could not determine the original active output; left on the last restored slot. Check the active USB slot / BLE profile on the device.');
    } else if (originalEndpoint < usbCount) {
      await remember('restore active USB slot', setActiveUsbSlot(originalEndpoint));
    } else if (originalEndpoint < usbCount + btCount) {
      await remember('restore active BT profile', setActiveBleProfile(originalEndpoint - usbCount));
    }
  }

  if (snapshot.osConfig) {
    await remember('per-device keymap overlay', setOsConfig(snapshot.osConfig.enabled, snapshot.osConfig.osMap));
  }

  if (snapshot.gestureConfig) {
    await remember('gesture enabled', setGestureEnabled(snapshot.gestureConfig.enabled));
    const directions = 4;
    for (let i = 0; i < snapshot.gestureConfig.hasOverride.length; i++) {
      const endpointIndex = Math.floor(i / directions);
      const direction = i % directions;
      const hasOverride = snapshot.gestureConfig.hasOverride[i];
      const binding = snapshot.gestureConfig.overrides[i];
      if (hasOverride && binding) {
        await remember(`gesture ${endpointIndex}:${direction}`, setGestureBinding(endpointIndex, direction, false, binding));
      } else {
        await remember(`gesture ${endpointIndex}:${direction}`, setGestureBinding(endpointIndex, direction, true));
      }
    }
  }

  if (
    snapshot.tappingTerm !== undefined ||
    trackball?.autoLayer ||
    (!hasTrackballProfiles && (trackball?.sensitivity || trackball?.precisionScale || trackball?.speedScale || trackball?.accel || trackball?.inertia || trackball?.dragScale))
  ) {
    await remember('save changes', saveChanges());
  }

  debugLog(ok ? 'INF' : 'WRN', 'USB', ok ? 'Device settings imported' : 'Device settings import completed with warnings');
  return ok;
}

// --- Macro RPC ---

export interface DeviceMacroSummary {
  id: number;
  name: string;
  stepCount: number;
}

export interface DeviceMacroStep {
  action: 'keyPress' | 'keyRelease' | 'waitMs';
  value: number;
}

export interface DeviceMacroData {
  id: number;
  name: string;
  steps: DeviceMacroStep[];
}

export async function listAllMacros(): Promise<{ macros: DeviceMacroSummary[]; maxMacros: number } | null> {
  try {
    const resp = await sendRequest({ macros: { listAllMacros: true } });
    const data = resp.macros?.listAllMacros;
    if (!data) return null;
    const macros = (data.macros || []).map((m: any) => ({
      id: m.id ?? 0,
      name: m.name ?? '',
      stepCount: m.stepCount ?? 0,
    }));
    debugLog('INF', 'USB', `listAllMacros: ${macros.length} macros (max ${data.maxMacros})`);
    return { macros, maxMacros: data.maxMacros ?? 16 };
  } catch (e: any) {
    debugLog('ERR', 'USB', `listAllMacros failed: ${e.message}`);
    return null;
  }
}

export async function getMacroData(macroId: number): Promise<DeviceMacroData | null> {
  try {
    const resp = await sendRequest({ macros: { getMacroData: { macroId } } });
    const data = resp.macros?.getMacroData;
    if (!data) {
      debugLog('WRN', 'USB', `getMacroData(${macroId}): no response`);
      return null;
    }
    // oneof: check macro field first (protobufjs may show err=0 as default)
    const macro = data.macro;
    if (!macro) {
      debugLog('WRN', 'USB', `getMacroData(${macroId}) error: ${data.err}`);
      return null;
    }
    const steps: DeviceMacroStep[] = (macro.steps || []).map((s: any) => {
      const actionType = s.actionType ?? 1;
      const value = s.value ?? 0;
      if (actionType === 2) return { action: 'keyRelease' as const, value };
      if (actionType === 3) return { action: 'waitMs' as const, value };
      return { action: 'keyPress' as const, value };
    });
    debugLog('INF', 'USB', `getMacroData(${macroId}): "${macro.name}", ${steps.length} steps: ${steps.map(s => `${s.action}=0x${s.value.toString(16)}`).join(', ')}`);
    return { id: macro.id ?? macroId, name: macro.name ?? '', steps };
  } catch (e: any) {
    debugLog('ERR', 'USB', `getMacroData failed: ${e.message}`);
    return null;
  }
}

export async function setMacro(macroId: number, name: string, steps: DeviceMacroStep[]): Promise<boolean> {
  const protoSteps = steps.map(s => {
    const actionType = s.action === 'keyRelease' ? 2 : s.action === 'waitMs' ? 3 : 1;
    return { actionType, value: s.value };
  });
  // set_macro synchronously does a settings_save_one() NVS write on the
  // firmware side (same as saveChanges), which can exceed the default 5s
  // USB timeout once the NVS area holding up to 32 macro slots needs
  // garbage collection -- give it the same floor as saveChanges. In
  // practice the first attempt still sometimes times out even with this
  // floor (observed even right after a full settings_reset), so retry a
  // couple of times before giving up -- a manual re-click has reliably
  // succeeded in the past, so an automatic retry should too.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await sendRequest({
        macros: { setMacro: { macro: { id: macroId, name, steps: protoSteps } } }
      }, 20000);
      const result = resp.macros?.setMacro;
      if (result === 0 || result === 'SET_MACRO_RESP_OK') {
        debugLog('INF', 'USB', `setMacro(${macroId}): OK, ${steps.length} steps saved${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        return true;
      }
      debugLog('WRN', 'USB', `setMacro(${macroId}) error: ${result}`);
      return false;
    } catch (e: any) {
      if (attempt < MAX_ATTEMPTS) {
        debugLog('WRN', 'USB', `setMacro(${macroId}) attempt ${attempt} failed: ${e.message}, retrying...`);
        continue;
      }
      debugLog('ERR', 'USB', `setMacro failed after ${MAX_ATTEMPTS} attempts: ${e.message}`);
      return false;
    }
  }
  return false;
}

let freeDeviceMacroSlots: number[] = [];
let macroNameToDeviceId: Record<string, number> = {};

export function getFreeMacroSlots(): number[] {
  return freeDeviceMacroSlots;
}

export function claimFreeMacroSlot(): number | null {
  return freeDeviceMacroSlots.shift() ?? null;
}

// Returns a device macro slot to the free pool immediately after it's
// cleared (deleting a macro), instead of requiring a fresh Read to notice
// it's free again -- without this, all 16 dynamic slots can appear
// exhausted (silently hiding "Write to Device" on any new macro) even right
// after the user deleted an old one to make room.
export function releaseMacroSlot(deviceId: number) {
  if (!freeDeviceMacroSlots.includes(deviceId)) freeDeviceMacroSlots.push(deviceId);
  for (const [name, id] of Object.entries(macroNameToDeviceId)) {
    if (id === deviceId) delete macroNameToDeviceId[name];
  }
}

export function registerMacroDeviceId(name: string, deviceId: number) {
  macroNameToDeviceId[name] = deviceId;
}

function isDynamicSlot(name: string): boolean {
  return /^m_dyn_\d+$/.test(name);
}

export async function readMacrosFromDevice(): Promise<import('../types').Macro[] | null> {
  try {
    const result = await listAllMacros();
    if (!result || result.macros.length === 0) return null;

    const macros: import('../types').Macro[] = [];
    freeDeviceMacroSlots = [];

    for (const summary of result.macros) {
      const data = await getMacroData(summary.id);

      if (isDynamicSlot(summary.name)) {
        const hasRealSteps = data && data.steps.length > 0 &&
          data.steps.some(s => s.action !== 'waitMs' && s.value !== 0);
        if (!hasRealSteps) {
          freeDeviceMacroSlots.push(summary.id);
          debugLog('INF', 'USB', `Free macro slot: ${summary.name} (id=${summary.id})`);
          continue;
        }
      }

      if (!data) {
        macros.push({ name: summary.name, waitMs: 30, tapMs: 30, bindings: [], deviceId: summary.id });
        continue;
      }

      const bindings: import('../types').MacroStep[] = [];
      for (const step of data.steps) {
        if (step.action === 'waitMs') {
          bindings.push({ action: 'macro_wait_time', ms: step.value });
        } else {
          const label = hidToLabel(step.value);
          const action = step.action === 'keyPress' ? 'macro_press' : 'macro_release';
          bindings.push({ action, behavior: 'kp', param: label });
        }
      }

      // Merge consecutive press+release of same key into tap
      const merged: import('../types').MacroStep[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const cur = bindings[i];
        const next = bindings[i + 1];
        if (cur.action === 'macro_press' && next?.action === 'macro_release' &&
            cur.param === next.param) {
          merged.push({ ...cur, action: 'macro_tap' });
          i++; // skip the release
        } else {
          merged.push(cur);
        }
      }

      macros.push({ name: data.name, waitMs: 30, tapMs: 30, bindings: merged, deviceId: summary.id });
    }
    macroNameToDeviceId = {};
    for (const m of macros) {
      if (m.deviceId !== undefined) {
        macroNameToDeviceId[m.name] = m.deviceId;
      }
    }
    debugLog('INF', 'USB', `readMacrosFromDevice: ${macros.length} macros loaded, ${freeDeviceMacroSlots.length} free slots`);
    return macros;
  } catch (e: any) {
    debugLog('ERR', 'USB', `readMacrosFromDevice failed: ${e.message}`);
    return null;
  }
}

// Firmware's MAX_MACRO_STEPS (macro_subsystem.c) and the wire protocol's
// MacroSequence.steps max_count (macros.options) are both 50 (raised from
// 32 on 2026-07-22). A single UI "Tap" row expands to 2 wire steps
// (keyPress+keyRelease) below, so the wire count can exceed the UI's
// displayed step count -- exceeding the limit on the wire causes the
// request to fail nanopb decode on the firmware side, which can't even
// send back a clean error, so the host just sees a Response timeout with
// nothing indicating *why*. Check before sending.
export const MAX_MACRO_WIRE_STEPS = 50;

export function computeMacroWireStepCount(macro: import('../types').Macro): number {
  let count = 0;
  for (const step of macro.bindings) {
    count += step.action === 'macro_tap' ? 2 : 1;
  }
  return count;
}

export async function writeMacroToDevice(macroId: number, macro: import('../types').Macro): Promise<boolean> {
  const steps: DeviceMacroStep[] = [];

  for (const step of macro.bindings) {
    if (step.action === 'macro_wait_time') {
      steps.push({ action: 'waitMs', value: step.ms ?? 100 });
    } else {
      const param = labelToParam(step.param || '', step.param || '');
      if (step.action === 'macro_tap') {
        steps.push({ action: 'keyPress', value: param });
        steps.push({ action: 'keyRelease', value: param });
      } else if (step.action === 'macro_press') {
        steps.push({ action: 'keyPress', value: param });
      } else if (step.action === 'macro_release') {
        steps.push({ action: 'keyRelease', value: param });
      }
    }
  }

  if (steps.length > MAX_MACRO_WIRE_STEPS) {
    debugLog('ERR', 'USB', `writeMacroToDevice: "${macro.name}" needs ${steps.length} wire steps (Tap = 2 steps each), exceeds firmware limit of ${MAX_MACRO_WIRE_STEPS}`);
    return false;
  }

  return setMacro(macroId, macro.name, steps);
}

const ZMK_TO_USAGE: Record<string, number> = {
  ENTER: 40, ESC: 41, BSPC: 42, DEL: 76, TAB: 43, SPACE: 44, CAPS: 57,
  UP: 82, DOWN: 81, LEFT: 80, RIGHT: 79, HOME: 74, END: 77, PG_UP: 75, PG_DN: 78,
  MINUS: 45, EQUAL: 46, LBKT: 47, RBKT: 48, BSLH: 49, SEMI: 51, SQT: 52,
  GRAVE: 53, COMMA: 54, DOT: 55, FSLH: 56,
  LSHIFT: 225, RSHIFT: 229, LCTRL: 224, RCTRL: 228,
  LALT: 226, RALT: 230, LGUI: 227, RGUI: 231,
  N1: 30, N2: 31, N3: 32, N4: 33, N5: 34, N6: 35, N7: 36, N8: 37, N9: 38, N0: 39,
  LANG1: 144, LANG2: 145, LANG3: 146,
  INT_RO: 135, INT_KANA: 136, INT_YEN: 137,
  // Keypad/numpad usages (USB HID Keyboard/Keypad page 0x54-0x63) -- distinct
  // from the top-row N1-N0 above, used when a layer is bound to &kp KP_N1 etc.
  KP_FSLH: 84, KP_STAR: 85, KP_MINUS: 86, KP_PLUS: 87, KP_ENTER: 88,
  KP_N1: 89, KP_N2: 90, KP_N3: 91, KP_N4: 92, KP_N5: 93,
  KP_N6: 94, KP_N7: 95, KP_N8: 96, KP_N9: 97, KP_N0: 98, KP_DOT: 99,
};

const ZMK_TO_SHIFTED: Record<string, number> = {
  EXCL: 30, AT: 31, HASH: 32, DLLR: 33, PRCNT: 34, CARET: 35,
  AMPS: 36, STAR: 37, LPAR: 38, RPAR: 39,
  PLUS: 46, UNDER: 45, TILDE: 53, PIPE: 49,
};

const ZMK_TO_CONSUMER: Record<string, number> = {
  C_VOL_UP: 0xE9, C_VOL_DN: 0xEA, C_MUTE: 0xE2,
  C_PLAY_PAUSE: 0xCD, C_NEXT: 0xB5, C_PREV: 0xB6,
  C_BRI_UP: 0x6F, C_BRI_DN: 0x70,
};

function labelToParam(label: string, keyCode: string): number {
  // ZMK-style labels from macro editor
  if (ZMK_TO_SHIFTED[label] !== undefined) {
    return (0x02 << 24) | (0x07 << 16) | ZMK_TO_SHIFTED[label];
  }
  if (ZMK_TO_USAGE[label] !== undefined) {
    return (0x07 << 16) | ZMK_TO_USAGE[label];
  }
  if (ZMK_TO_CONSUMER[label] !== undefined) {
    return (0x0C << 16) | ZMK_TO_CONSUMER[label];
  }
  // Check shifted symbols
  if (LABEL_TO_SHIFTED[label] !== undefined) {
    return (0x02 << 24) | (0x07 << 16) | LABEL_TO_SHIFTED[label];
  }
  // Check keyboard usage
  if (LABEL_TO_USAGE[label] !== undefined) {
    return (0x07 << 16) | LABEL_TO_USAGE[label];
  }
  // Check consumer
  if (LABEL_TO_CONSUMER[label] !== undefined) {
    return (0x0C << 16) | LABEL_TO_CONSUMER[label];
  }
  // Mod+key pattern like "C+Up"
  const modMatch = label.match(/^([CSAG+]+)\+(.+)$/);
  if (modMatch) {
    let mods = 0;
    const modStr = modMatch[1];
    if (modStr.includes('C')) mods |= 0x01;
    if (modStr.includes('S')) mods |= 0x02;
    if (modStr.includes('A')) mods |= 0x04;
    if (modStr.includes('G')) mods |= 0x08;
    const baseLabel = modMatch[2];
    const baseUsage = LABEL_TO_USAGE[baseLabel];
    if (baseUsage !== undefined) {
      return (mods << 24) | (0x07 << 16) | baseUsage;
    }
    const consumerUsage = LABEL_TO_CONSUMER[baseLabel];
    if (consumerUsage !== undefined) {
      return (mods << 24) | (0x0C << 16) | consumerUsage;
    }
  }
  return 0;
}

export async function ensureBehaviorsLoaded(): Promise<void> {
  if (Object.keys(behaviorCache).length === 0) {
    const ids = await listBehaviors();
    for (const bid of ids) await getBehaviorDetails(bid);
  }
}

// Behavior-name -> behaviorId lookup, shared by resolveKeyBindingRpc and
// writeKeymapToDevice's per-key conversion so both use the same matching
// rules (exact/specific matches first to avoid e.g. "toggle" colliding with
// "toggle scroll invert").
function computeBehByType(): Record<string, number> {
  const behByType: Record<string, number> = {};
  for (const [idStr, beh] of Object.entries(behaviorCache)) {
    const n = beh.displayName.toLowerCase();
    const id = Number(idStr);
    if (!behByType['mkp'] && (n === 'mouse key press' || n === 'mkp')) behByType['mkp'] = id;
    if (!behByType['kp'] && n === 'key press') behByType['kp'] = id;
    if (!behByType['mo'] && (n === 'momentary layer' || n.includes('momentary'))) behByType['mo'] = id;
    if (!behByType['lt'] && (n === 'layer-tap' || n === 'lt')) behByType['lt'] = id;
    if (!behByType['mt'] && (n === 'mod-tap' || n === 'mt')) behByType['mt'] = id;
    if (!behByType['tog'] && (n === 'toggle layer' || n.includes('toggle layer'))) behByType['tog'] = id;
    if (!behByType['none'] && n === 'none') behByType['none'] = id;
    if (!behByType['trans'] && n === 'transparent') behByType['trans'] = id;
    if (!behByType['bt'] && n === 'bluetooth') behByType['bt'] = id;
    if (!behByType['boot'] && n === 'bootloader') behByType['boot'] = id;
    if (!behByType['usb_sel'] && n === 'usb slot select') behByType['usb_sel'] = id;
    if (!behByType['out'] && (n === 'output selection' || n === 'out')) behByType['out'] = id;
    if (!behByType['aml_tog'] && (n === 'toggle aml' || n === 'aml_tog')) behByType['aml_tog'] = id;
    if (!behByType['pinch_zm'] && (n === 'pinch zoom' || n === 'pinch_zm')) behByType['pinch_zm'] = id;
  }
  return behByType;
}

// Resolves a KeyBinding to {behaviorId, param1, param2} for RPCs that store
// a standalone binding value rather than a keymap layer position (e.g.
// gesture overrides, combo bindings). Mirrors writeKeymapToDevice's
// per-key conversion switch, including the BT_SEL/USB_SEL/mkp/AML_TOG
// special cases -- ComboList.tsx's OUTPUT KEY picker exposes those too now,
// not just plain key presses.
export async function resolveKeyBindingRpc(binding: KeyBinding): Promise<{ behaviorId: number; param1: number; param2: number } | null> {
  await ensureBehaviorsLoaded();
  const behByType = computeBehByType();

  if (binding.type === 'none') {
    if (behByType['none'] === undefined) return null;
    return { behaviorId: behByType['none'], param1: 0, param2: 0 };
  }

  if (binding.type === 'trans') {
    if (behByType['trans'] === undefined) return null;
    return { behaviorId: behByType['trans'], param1: 0, param2: 0 };
  }

  if (binding.type === 'basic') {
    // Same special-case keyCodes as writeKeymapToDevice's per-key switch --
    // combos/gestures didn't use to expose these in their own editors (see
    // this function's doc comment), but ComboList.tsx's OUTPUT KEY picker
    // now does (Mouse/Device categories, AML toggle), so this needs to
    // resolve them the same way or they'd silently fall through to being
    // treated as a plain (and meaningless) Key Press label below.
    if (binding.keyCode?.startsWith('USB_SEL')) {
      if (behByType['usb_sel'] === undefined) return null;
      return { behaviorId: behByType['usb_sel'], param1: parseInt(binding.keyCode.replace(/^USB_SEL[_ ]/, '') || '0'), param2: 0 };
    }
    if (binding.keyCode?.startsWith('BT_SEL')) {
      if (behByType['bt'] === undefined) return null;
      return { behaviorId: behByType['bt'], param1: 3, param2: parseInt(binding.keyCode.replace(/^BT_SEL[_ ]/, '') || '0') };
    }
    if (binding.keyCode === 'BT_CLR') {
      if (behByType['bt'] === undefined) return null;
      return { behaviorId: behByType['bt'], param1: 0, param2: 0 };
    }
    if (binding.keyCode === 'BT_CLR_ALL') {
      if (behByType['bt'] === undefined) return null;
      return { behaviorId: behByType['bt'], param1: 4, param2: 0 };
    }
    if (binding.keyCode === 'OUT_USB' || binding.keyCode === 'OUT_BT' || binding.keyCode === 'OUT_TOG') {
      if (behByType['out'] === undefined) return null;
      const param1 = binding.keyCode === 'OUT_USB' ? 1 : binding.keyCode === 'OUT_BT' ? 2 : 0;
      return { behaviorId: behByType['out'], param1, param2: 0 };
    }
    if (binding.keyCode === 'BOOTLOADER') {
      if (behByType['boot'] === undefined) return null;
      return { behaviorId: behByType['boot'], param1: 0, param2: 0 };
    }
    if (binding.keyCode === 'AML_TOG') {
      if (behByType['aml_tog'] === undefined) return null;
      return { behaviorId: behByType['aml_tog'], param1: 0, param2: 0 };
    }
    if (binding.keyCode === 'PINCH_ZOOM') {
      if (behByType['pinch_zm'] === undefined) return null;
      return { behaviorId: behByType['pinch_zm'], param1: 0, param2: 0 };
    }
    if (binding.keyCode?.startsWith('mkp') || binding.keyCode?.startsWith('KC_BTN') ||
        binding.label?.startsWith('MB') || binding.label === 'Click' || binding.label === 'R Click' || binding.label === 'M Click') {
      if (behByType['mkp'] === undefined) return null;
      const btnMap: Record<string, number> = {
        'KC_BTN1': 1, 'KC_BTN2': 2, 'KC_BTN3': 4, 'KC_BTN4': 8, 'KC_BTN5': 16,
        'Click': 1, 'R Click': 2, 'M Click': 4,
        'MB1': 1, 'MB2': 2, 'MB3': 4, 'MB4': 8, 'MB5': 16,
      };
      const param1 = btnMap[binding.keyCode || ''] || btnMap[binding.label || ''] || 1;
      return { behaviorId: behByType['mkp'], param1, param2: 0 };
    }

    if (behByType['kp'] === undefined) return null;
    let param1 = labelToParam(binding.label, binding.keyCode);
    if (binding.modifiers?.length) {
      const modBits: Record<string, number> = {
        lctrl: 0x01, lshift: 0x02, lalt: 0x04, lgui: 0x08,
        rctrl: 0x10, rshift: 0x20, ralt: 0x40, rgui: 0x80,
      };
      let mods = (param1 >>> 24) & 0xFF;
      for (const m of binding.modifiers) {
        mods |= modBits[m] || 0;
      }
      param1 = (mods << 24) | (param1 & 0x00FFFFFF);
    }
    return { behaviorId: behByType['kp'], param1, param2: 0 };
  }

  if (binding.type === 'momentary') {
    if (behByType['mo'] === undefined) return null;
    return { behaviorId: behByType['mo'], param1: binding.layer ?? 0, param2: 0 };
  }

  if (binding.type === 'toggle') {
    if (behByType['tog'] === undefined) return null;
    return { behaviorId: behByType['tog'], param1: binding.layer ?? 0, param2: 0 };
  }

  if (binding.type === 'layer-tap') {
    if (behByType['lt'] === undefined) return null;
    const param2 = labelToParam(binding.tapLabel || binding.label, binding.tapKeyCode || '');
    return { behaviorId: behByType['lt'], param1: binding.layer ?? 0, param2 };
  }

  if (binding.type === 'mod-tap') {
    if (behByType['mt'] === undefined) return null;
    const mtModUsage: Record<string, number> = {
      lctrl: 0x700E0, lshift: 0x700E1, lalt: 0x700E2, lgui: 0x700E3,
      rctrl: 0x700E4, rshift: 0x700E5, ralt: 0x700E6, rgui: 0x700E7,
    };
    const param1 = binding.modifiers?.length
      ? (mtModUsage[binding.modifiers[0]] || 0x700E1)
      : labelToParam(binding.label, binding.keyCode);
    const tapKey = binding.tapLabel || binding.label;
    const param2 = labelToParam(tapKey, binding.tapKeyCode || tapKey);
    return { behaviorId: behByType['mt'], param1, param2 };
  }

  return null;
}

// Reads the device's real combos via combo.getCombos (previously never
// called -- the Combos tab used to show a hardcoded local demo list with no
// relation to what's actually compiled into the keyboard). Firmware 0.6.12+
// persists combo names on the device (DT combos report their devicetree node
// name); older firmware sends no name, so those get a synthetic placeholder
// that App.tsx's Read merge can override with a local name.
export async function getCombosFromDevice(): Promise<import('../types').Combo[] | null> {
  await ensureBehaviorsLoaded();
  try {
    const resp = await sendRequest({ combo: { getCombos: true } });
    const data = resp.combo?.getCombos;
    if (!data) {
      debugLog('WRN', 'USB', 'Empty combos response');
      return null;
    }
    const combos: import('../types').Combo[] = (data.combos || []).map((c: any, i: number) => {
      const binding = decodeBinding({
        behaviorId: c.binding?.behaviorId ?? 0,
        param1: c.binding?.param1 ?? 0,
        param2: c.binding?.param2 ?? 0,
      });
      const layers: number[] = [];
      const mask = c.layerMask ?? 0;
      for (let bit = 0; bit < 32; bit++) {
        if (mask & (1 << bit)) layers.push(bit);
      }
      return {
        id: `combo_${i}`,
        name: c.name || `Combo ${i + 1}`,
        keyPositions: positionsToKeyIds(c.keyPositions || []),
        binding,
        timeoutMs: c.timeoutMs || 50,
        layers,
        requirePriorIdleMs: c.requirePriorIdleMs || 0,
        slowRelease: !!c.slowRelease,
      };
    });
    debugLog('INF', 'USB', `Loaded ${combos.length} combos from device (max ${data.maxCombos})`);
    return combos;
  } catch (e: any) {
    debugLog('ERR', 'USB', `getCombosFromDevice failed: ${e.message}`);
    return null;
  }
}

// Truncate to at most maxBytes of UTF-8 without splitting a character.
function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = enc.encode(ch).length;
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

// A combo resolved to exactly the values the device receives and stores.
export type WireCombo = {
  name: string;
  positions: number[];
  binding: { behaviorId: number; param1: number; param2: number };
  timeoutMs: number;
  layerMask: number;
  requirePriorIdleMs: number;
  slowRelease: boolean;
};

// Key-position order doesn't matter to the firmware's matcher, so compare
// as sorted sets to avoid treating a mere reordering as a difference. An
// empty device name means the firmware predates name persistence and would
// report "" forever -- don't let that count as a mismatch. Shared between
// the diffing writer and the post-write verification.
function wireComboMatchesDevice(local: WireCombo, dev: any): boolean {
  const devPositions: number[] = dev.keyPositions || [];
  const a = [...local.positions].sort((x, y) => x - y);
  const b = [...devPositions].sort((x, y) => x - y);
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) return false;
  if ((dev.binding?.behaviorId ?? 0) !== local.binding.behaviorId ||
      (dev.binding?.param1 ?? 0) !== local.binding.param1 ||
      (dev.binding?.param2 ?? 0) !== local.binding.param2) return false;
  if ((dev.timeoutMs || 50) !== local.timeoutMs) return false;
  if ((dev.layerMask ?? 0) !== local.layerMask) return false;
  if ((dev.requirePriorIdleMs ?? 0) !== local.requirePriorIdleMs) return false;
  if (!!dev.slowRelease !== local.slowRelease) return false;
  if ((dev.name || '') !== '' && dev.name !== local.name) return false;
  return true;
}

// Syncs the local combo list to the device with a positional diff: combos at
// matching indexes are compared field by field and only rewritten (setCombo)
// when they actually differ, extra local combos are added, extra device
// combos removed from the end down. The previous implementation was a full
// delete-all + re-add on every Write (~2 RPCs per combo, several seconds),
// which also made touching nothing cost as much as changing everything.
// Returns the wire-form list actually intended for the device so the caller
// can verify it landed (see verifyDeviceState).
export async function writeCombosToDevice(combos: import('../types').Combo[]): Promise<{ ok: boolean; expected: WireCombo[] }> {
  // wireCombos is what we WANT on the device -- the caller (App.tsx) hands
  // this straight to verifyDeviceState() as its ground truth, independent of
  // whether every RPC below actually lands. It must survive a partial
  // failure below: previously the whole loop lived inside one try/catch, so
  // a single RPC timing out mid-sync threw the entire computed set away and
  // returned expected: [], which made verifyDeviceState report a false
  // "expected 0 combos, found N on device" -- the device's combos were never
  // touched, but the caller couldn't tell that from an empty expected set.
  let ok = true;
  const wireCombos: WireCombo[] = [];
  for (const combo of combos) {
    try {
      const rpcBinding = await resolveKeyBindingRpc(combo.binding);
      if (!rpcBinding) {
        debugLog('WRN', 'USB', `Skipping combo "${combo.name}": unresolvable binding (${combo.binding.type}/${combo.binding.keyCode})`);
        ok = false;
        continue;
      }
      const positions = keyIdsToPositions(combo.keyPositions);
      if (positions.length < 2) {
        debugLog('WRN', 'USB', `Skipping combo "${combo.name}": fewer than 2 key positions`);
        ok = false;
        continue;
      }
      let layerMask = 0;
      for (const l of combo.layers || []) layerMask |= (1 << l);
      wireCombos.push({
        // Firmware-side storage is 32 bytes including the NUL, and nanopb
        // rejects the whole message if the string exceeds that, so truncate
        // by UTF-8 bytes (names can be Japanese). Firmware older than
        // 0.6.12's name support simply ignores the field.
        name: truncateUtf8(combo.name || '', 31),
        positions,
        binding: rpcBinding,
        timeoutMs: combo.timeoutMs || 50,
        layerMask,
        requirePriorIdleMs: combo.requirePriorIdleMs || 0,
        slowRelease: !!combo.slowRelease,
      });
    } catch (e: any) {
      debugLog('ERR', 'USB', `Skipping combo "${combo.name}": ${e.message}`);
      ok = false;
    }
  }

  let deviceCombos: any[] = [];
  try {
    const before = await sendRequest({ combo: { getCombos: true } });
    deviceCombos = before.combo?.getCombos?.combos ?? [];
  } catch (e: any) {
    // Can't diff against a device state we failed to read, so nothing below
    // is safe to send -- bail out without touching any combo RPCs. expected
    // still reflects the locally-intended set, so verifyDeviceState can
    // still give an honest (if unhappy) report against whatever's actually
    // on the device, rather than the "expected 0" false alarm.
    debugLog('ERR', 'USB', `writeCombosToDevice: failed to read current device combos, aborting sync: ${e.message}`);
    return { ok: false, expected: wireCombos };
  }

  let updated = 0;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  // Overlapping indexes: rewrite in place only where something differs.
  const overlap = Math.min(wireCombos.length, deviceCombos.length);
  for (let i = 0; i < overlap; i++) {
    if (wireComboMatchesDevice(wireCombos[i], deviceCombos[i])) {
      unchanged++;
      continue;
    }
    try {
      const setResp = await sendRequest({
        combo: {
          setCombo: {
            index: i,
            combo: {
              keyPositions: wireCombos[i].positions,
              binding: wireCombos[i].binding,
              timeoutMs: wireCombos[i].timeoutMs,
              layerMask: wireCombos[i].layerMask,
              requirePriorIdleMs: wireCombos[i].requirePriorIdleMs,
              slowRelease: wireCombos[i].slowRelease,
              name: wireCombos[i].name,
            },
          },
        },
      });
      if ((setResp.combo?.setCombo ?? 0) !== 0) {
        debugLog('WRN', 'USB', `Failed to update combo "${combos[i]?.name}" at ${i}: code ${setResp.combo?.setCombo}`);
        ok = false;
      } else {
        updated++;
      }
    } catch (e: any) {
      debugLog('ERR', 'USB', `Failed to update combo "${combos[i]?.name}" at ${i}: ${e.message}`);
      ok = false;
    }
  }

  // Extra local combos: append.
  for (let i = overlap; i < wireCombos.length; i++) {
    try {
      const addResp = await sendRequest({
        combo: {
          addCombo: {
            combo: {
              keyPositions: wireCombos[i].positions,
              binding: wireCombos[i].binding,
              timeoutMs: wireCombos[i].timeoutMs,
              layerMask: wireCombos[i].layerMask,
              requirePriorIdleMs: wireCombos[i].requirePriorIdleMs,
              slowRelease: wireCombos[i].slowRelease,
              name: wireCombos[i].name,
            },
          },
        },
      });
      if (addResp.combo?.addCombo?.ok === undefined) {
        debugLog('WRN', 'USB', `Failed to add combo "${wireCombos[i].name}": ${JSON.stringify(addResp.combo?.addCombo)}`);
        ok = false;
      } else {
        added++;
      }
    } catch (e: any) {
      debugLog('ERR', 'USB', `Failed to add combo "${wireCombos[i].name}": ${e.message}`);
      ok = false;
    }
  }

  // Extra device combos: remove from the end down so indexes stay stable.
  for (let i = deviceCombos.length - 1; i >= wireCombos.length; i--) {
    try {
      await sendRequest({ combo: { removeCombo: { index: i } } });
      removed++;
    } catch (e: any) {
      debugLog('ERR', 'USB', `Failed to remove combo at ${i}: ${e.message}`);
      ok = false;
    }
  }

  debugLog('INF', 'USB', `Combo sync: ${unchanged} unchanged, ${updated} updated, ${added} added, ${removed} removed`);
  return { ok, expected: wireCombos };
}

// Returns the raw triples actually sent per position key ("layer:posId"),
// so the caller can verify they landed on the device (verifyDeviceState).
export async function writeKeymapToDevice(layers: Layer[], dirtyKeys?: Set<string>): Promise<{ ok: boolean; written: Record<string, { behaviorId: number; param1: number; param2: number }> }> {
  if (!writer) {
    debugLog('ERR', 'USB', 'Not connected');
    return { ok: false, written: {} };
  }

  // Ensure behaviors are loaded
  if (Object.keys(behaviorCache).length === 0) {
    const ids = await listBehaviors();
    for (const bid of ids) await getBehaviorDetails(bid);
  }

  // Build behavior ID map from raw bindings + behavior cache
  const behByType: Record<string, number> = {};
  const matchBeh = (name: string, id: number) => {
    const n = name.toLowerCase();
    // Exact or specific matches first to avoid collisions
    if (!behByType['mkp'] && (n === 'mouse key press' || n === 'mkp')) behByType['mkp'] = id;
    if (!behByType['kp'] && n === 'key press') behByType['kp'] = id;
    if (!behByType['mo'] && (n === 'momentary layer' || n.includes('momentary'))) behByType['mo'] = id;
    if (!behByType['lt'] && (n === 'layer-tap' || n === 'lt')) behByType['lt'] = id;
    if (!behByType['mt'] && (n === 'mod-tap' || n === 'mt')) behByType['mt'] = id;
    if (!behByType['tog'] && (n === 'toggle layer' || n.includes('toggle layer'))) behByType['tog'] = id;
    if (!behByType['none'] && n === 'none') behByType['none'] = id;
    if (!behByType['trans'] && n === 'transparent') behByType['trans'] = id;
    if (!behByType['bt'] && n === 'bluetooth') behByType['bt'] = id;
    if (!behByType['boot'] && n === 'bootloader') behByType['boot'] = id;
    if (!behByType['usb_sel'] && n === 'usb slot select') behByType['usb_sel'] = id;
    if (!behByType['out'] && (n === 'output selection' || n === 'out')) behByType['out'] = id;
    if (!behByType['aml_tog'] && (n === 'toggle aml' || n === 'aml_tog')) behByType['aml_tog'] = id;
    if (!behByType['pinch_zm'] && (n === 'pinch zoom' || n === 'pinch_zm')) behByType['pinch_zm'] = id;
  };
  // From raw bindings first (most reliable)
  for (const [, raw] of Object.entries(rawBindings)) {
    const beh = behaviorCache[raw.behaviorId];
    if (beh) matchBeh(beh.displayName, raw.behaviorId);
  }
  // Always fill in any behavior types not resolved from rawBindings by
  // scanning the full cache -- rawBindings only reflects behaviors actually
  // used somewhere in the currently-loaded keymap, so a type genuinely
  // present on the device but unused so far (e.g. &bt/&bootloader/&out on a
  // keymap that never happened to bind one) would otherwise never resolve
  // when the user newly assigns it, silently falling back to behaviorId 0.
  // matchBeh()'s own `!behByType[x]` guards make this a pure fill-in pass,
  // never overwriting a value already found via rawBindings.
  for (const [idStr, beh] of Object.entries(behaviorCache)) {
    matchBeh(beh.displayName, Number(idStr));
  }
  // Log all behaviors for debugging
  const allBehaviors = Object.entries(behaviorCache).map(([id, b]) => `${id}:${b.displayName}`);
  debugLog('INF', 'USB', `All behaviors: ${allBehaviors.join(', ')}`);
  debugLog('INF', 'USB', `Behavior IDs: ${JSON.stringify(behByType)}`);

  let written = 0;
  let skipped = 0;
  let failed = 0;
  const writtenBindings: Record<string, { behaviorId: number; param1: number; param2: number }> = {};

  for (const layer of layers) {
    for (let keyIdx = 0; keyIdx < KEY_ORDER.length; keyIdx++) {
      const posId = KEY_ORDER[keyIdx];
      const key = layer.keys.find(k => k.id === posId);
      if (!key) continue;

      const rawKey = `${layer.index}:${posId}`;
      const raw = rawBindings[rawKey];
      const layerArrayIdx = layers.indexOf(layer);
      const isDirty = dirtyKeys ? (dirtyKeys.has(rawKey) || dirtyKeys.has(`${layerArrayIdx}:${posId}`)) : true;

      // If key wasn't modified by user, skip it entirely
      if (!isDirty) {
        skipped++;
        continue;
      }

      const binding = key.binding;
      let behaviorId = 0;
      let param1 = 0;
      let param2 = 0;

      switch (binding.type) {
        case 'basic':
          if (binding.keyCode?.startsWith('&') && binding.keyCode.length > 1) {
            const macroName = binding.keyCode.substring(1);
            // Check editor macro name → deviceId mapping first
            if (macroNameToDeviceId[macroName] !== undefined) {
              behaviorId = macroNameToDeviceId[macroName];
              debugLog('INF', 'USB', `  Macro: &${macroName} → beh=${behaviorId} (via deviceId)`);
            } else {
              // Fallback: look up by firmware display name
              const macroEntry = Object.entries(behaviorCache).find(([, b]) => b.displayName === macroName);
              if (macroEntry) {
                behaviorId = Number(macroEntry[0]);
                debugLog('INF', 'USB', `  Macro: &${macroName} → beh=${behaviorId}`);
              } else {
                debugLog('ERR', 'USB', `  Macro "&${macroName}" not found in firmware behaviors. Available: ${Object.values(behaviorCache).map(b => b.displayName).filter(n => !['Key Press','None','Transparent','Bluetooth','Bootloader','Momentary Layer','Layer-Tap','Mod-Tap','Toggle Layer','Mouse Key Press'].includes(n)).join(', ')}`);
              }
            }
          } else if (binding.keyCode?.startsWith('USB_SEL')) {
            behaviorId = behByType["usb_sel"] ?? 0;
            param1 = parseInt(binding.keyCode.replace(/^USB_SEL[_ ]/, '') || '0');
          } else if (binding.keyCode?.startsWith('BT_SEL')) {
            behaviorId = behByType["bt"] ?? 0;
            param1 = 3;
            param2 = parseInt(binding.keyCode.replace(/^BT_SEL[_ ]/, '') || '0');
          } else if (binding.keyCode === 'BT_CLR') {
            behaviorId = behByType["bt"] ?? 0; param1 = 0;
          } else if (binding.keyCode === 'BT_CLR_ALL') {
            behaviorId = behByType["bt"] ?? 0; param1 = 4;
          } else if (binding.keyCode === 'OUT_USB') {
            // dt-bindings/zmk/outputs.h: OUT_TOG=0, OUT_USB=1, OUT_BLE=2.
            behaviorId = behByType["out"] ?? 0; param1 = 1;
          } else if (binding.keyCode === 'OUT_BT') {
            behaviorId = behByType["out"] ?? 0; param1 = 2;
          } else if (binding.keyCode === 'OUT_TOG') {
            behaviorId = behByType["out"] ?? 0; param1 = 0;
          } else if (binding.keyCode === 'BOOTLOADER') {
            behaviorId = behByType["boot"] ?? 0;
          } else if (binding.keyCode === 'AML_TOG') {
            behaviorId = behByType["aml_tog"] ?? 0;
          } else if (binding.keyCode === 'PINCH_ZOOM') {
            behaviorId = behByType["pinch_zm"] ?? 0;
          } else if (binding.keyCode?.startsWith('mkp') || binding.keyCode?.startsWith('KC_BTN') ||
                     binding.label?.startsWith('MB') || binding.label === 'Click' || binding.label === 'R Click' || binding.label === 'M Click') {
            behaviorId = behByType["mkp"] ?? 0;
            const btnMap: Record<string, number> = {
              'KC_BTN1': 1, 'KC_BTN2': 2, 'KC_BTN3': 4, 'KC_BTN4': 8, 'KC_BTN5': 16,
              'Click': 1, 'R Click': 2, 'M Click': 4,
              'MB1': 1, 'MB2': 2, 'MB3': 4, 'MB4': 8, 'MB5': 16,
            };
            param1 = btnMap[binding.keyCode || ''] || btnMap[binding.label || ''] || 1;
          } else {
            behaviorId = behByType["kp"] ?? 0;
            param1 = labelToParam(binding.label, binding.keyCode);
            if (binding.modifiers?.length) {
              const modBits: Record<string, number> = {
                lctrl: 0x01, lshift: 0x02, lalt: 0x04, lgui: 0x08,
                rctrl: 0x10, rshift: 0x20, ralt: 0x40, rgui: 0x80,
              };
              let mods = (param1 >>> 24) & 0xFF;
              for (const m of binding.modifiers) {
                mods |= modBits[m] || 0;
              }
              param1 = (mods << 24) | (param1 & 0x00FFFFFF);
            }
          }
          break;
        case 'momentary':
          behaviorId = behByType["mo"] ?? 0;
          param1 = binding.layer ?? 0;
          break;
        case 'layer-tap': {
          // Preserve a custom hold-tap (lt6_j, ...) instead of always
          // downgrading to the generic built-in &lt -- this is the actual
          // fix for the J/Z-gets-silently-overwritten bug: without this
          // check, writing this key for ANY reason (direct edit, a layer
          // copy that includes its position, ...) always emitted the
          // generic ID, discarding whatever custom behavior was there.
          const customLt = binding.behaviorId !== undefined &&
            behaviorCache[binding.behaviorId] &&
            CUSTOM_HOLDTAP_RE.test(behaviorCache[binding.behaviorId].displayName)
            ? binding.behaviorId : undefined;
          behaviorId = customLt ?? behByType["lt"] ?? 0;
          param1 = binding.layer ?? 0;
          param2 = labelToParam(binding.tapLabel || binding.label, binding.tapKeyCode || '');
          break;
        }
        case 'mod-tap': {
          const customMt = binding.behaviorId !== undefined &&
            behaviorCache[binding.behaviorId] &&
            CUSTOM_HOLDTAP_RE.test(behaviorCache[binding.behaviorId].displayName)
            ? binding.behaviorId : undefined;
          behaviorId = customMt ?? behByType["mt"] ?? 0;
          const mtModUsage: Record<string, number> = {
            lctrl: 0x700E0, lshift: 0x700E1, lalt: 0x700E2, lgui: 0x700E3,
            rctrl: 0x700E4, rshift: 0x700E5, ralt: 0x700E6, rgui: 0x700E7,
          };
          if (binding.modifiers?.length) {
            param1 = mtModUsage[binding.modifiers[0]] || 0x700E1;
          } else {
            param1 = labelToParam(binding.label, binding.keyCode);
          }
          const tapKey = binding.tapLabel || binding.label;
          param2 = labelToParam(tapKey, binding.tapKeyCode || tapKey);
          break;
        }
        case 'toggle':
          behaviorId = behByType["tog"] ?? 0;
          param1 = binding.layer ?? 0;
          break;
        case 'none':
          behaviorId = behByType["none"] ?? 0;
          break;
        case 'trans':
          behaviorId = behByType["trans"] ?? 0;
          break;
        default:
          if (raw) { behaviorId = raw.behaviorId; param1 = raw.param1; param2 = raw.param2; }
          break;
      }

      debugLog('INF', 'USB', `  Write ${posId}@L${layer.index}: beh=${behaviorId} p1=0x${param1.toString(16)} p2=0x${param2.toString(16)}`);

      try {
        // setLayerBinding() catches its own errors and resolves to false
        // rather than throwing (e.g. INVALID_BEHAVIOR) -- the boolean
        // return must be checked, or a per-key rejection silently counts
        // as written, and a genuinely partial Write reports success.
        const success = await setLayerBinding(layer.index, keyIdx, behaviorId, param1, param2);
        if (success) {
          written++;
          writtenBindings[rawKey] = { behaviorId, param1, param2 };
        } else {
          failed++;
        }
      } catch (e: any) {
        debugLog('ERR', 'USB', `Failed to write ${posId} on layer ${layer.index}: ${e.message}`);
        failed++;
      }
    }
  }

  debugLog('INF', 'USB', `Write complete: ${written} bindings updated, ${skipped} unchanged${failed > 0 ? `, ${failed} FAILED` : ''}`);
  return { ok: failed === 0, written: writtenBindings };
}

// Post-write verification: re-read the keymap and combos from the device
// and confirm what we just wrote actually landed. Guards against the class
// of failure where an RPC "succeeds" but NVS keeps or corrupts old data --
// the same kind of silent divergence behind the J/Z incident. Returns a
// human-readable mismatch list (empty = verified clean).
export async function verifyDeviceState(
  expectedKeys: Record<string, { behaviorId: number; param1: number; param2: number }>,
  expectedCombos: WireCombo[],
): Promise<{ ok: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  try {
    // readKeymap refreshes the module-level rawBindings from the device.
    const reread = await readKeymap();
    if (!reread) {
      return { ok: false, mismatches: ['実機からの再読込に失敗しました（検証不能）'] };
    }
    for (const [key, exp] of Object.entries(expectedKeys)) {
      const actual = rawBindings[key];
      if (!actual) {
        mismatches.push(`${key}: 再読込に存在しません`);
        continue;
      }
      if (actual.behaviorId !== exp.behaviorId || actual.param1 !== exp.param1 || actual.param2 !== exp.param2) {
        mismatches.push(`${key}: 期待 beh=${exp.behaviorId}/p1=0x${exp.param1.toString(16)}/p2=0x${exp.param2.toString(16)} → 実機 beh=${actual.behaviorId}/p1=0x${actual.param1.toString(16)}/p2=0x${actual.param2.toString(16)}`);
      }
    }

    const resp = await sendRequest({ combo: { getCombos: true } });
    const deviceCombos: any[] = resp.combo?.getCombos?.combos ?? [];
    if (deviceCombos.length !== expectedCombos.length) {
      mismatches.push(`コンボ数: 期待${expectedCombos.length}件 → 実機${deviceCombos.length}件`);
    } else {
      for (let i = 0; i < expectedCombos.length; i++) {
        if (!wireComboMatchesDevice(expectedCombos[i], deviceCombos[i])) {
          mismatches.push(`コンボ「${expectedCombos[i].name || `#${i}`}」が書き込んだ内容と一致しません`);
        }
      }
    }

    return { ok: mismatches.length === 0, mismatches };
  } catch (e: any) {
    debugLog('ERR', 'USB', `verifyDeviceState failed: ${e.message}`);
    return { ok: false, mismatches: [`検証中にエラー: ${e.message}`] };
  }
}
