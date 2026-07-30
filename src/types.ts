export type BindingType = 'basic' | 'mod-tap' | 'layer-tap' | 'momentary' | 'toggle' | 'to-layer' | 'trans' | 'none';

export type Modifier = 'lshift' | 'lctrl' | 'lalt' | 'lgui' | 'rshift' | 'rctrl' | 'ralt' | 'rgui';

export interface KeyBinding {
  type: BindingType;
  keyCode: string;
  label: string;
  modifiers?: Modifier[];
  layer?: number;
  tapKeyCode?: string;
  tapLabel?: string;
  // The actual on-device behavior ID as last read (or explicitly assigned).
  // For layer-tap/mod-tap keys this is what lets a custom hold-tap (e.g.
  // lt6_j, distinct from the generic built-in &lt) survive a write --
  // without it, the write path can't tell "this key already uses a custom
  // behavior" from "this is a fresh generic layer-tap".
  behaviorId?: number;
}

// A hex color ("#rrggbb"). The firmware LED is PWM-driven (full 24-bit RGB),
// not a fixed palette -- see usbService.ts's setLayerProps/readKeymap for the
// packed-RGB wire encoding.
export type LedColor = string;

// The old 8-color palette (each channel purely on/off), kept as quick-pick
// presets in the color picker UI. Order matches the firmware's legacy
// color_names table (0=black..7=white) purely for familiarity, not because
// the wire format is index-based anymore.
export const LED_COLORS: LedColor[] = ['#000000', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'];

export interface KeyConfig {
  id: string; // e.g. "L00", "R03"
  binding: KeyBinding;
}

export interface Layer {
  name: string;
  index: number;
  ledColor: LedColor;
  isProtected: boolean;
  keys: KeyConfig[];
}

export interface Combo {
  id: string;
  name: string;
  keyPositions: string[];
  binding: KeyBinding;
  timeoutMs: number;
  layers: number[];
  suppressAml?: boolean;
  // Don't fire if a non-combo key was typed within this window (0 = off) --
  // ZMK combo require-prior-idle-ms, the mistyping guard for combos that
  // share keys with normal typing.
  requirePriorIdleMs?: number;
  // Release the combo behavior on the first key release instead of the
  // last -- ZMK combo slow-release.
  slowRelease?: boolean;
}

export interface GestureShortcut {
  direction: 'up' | 'down' | 'left' | 'right';
  keyCode: string;
  label: string;
  layer: number;
}

export interface BluetoothProfile {
  index: number;
  name: string;
  connected: boolean;
  active: boolean;
  ledColor: LedColor;
}

export type MacroAction = 'macro_tap' | 'macro_press' | 'macro_release' | 'macro_wait_time';

export interface MacroStep {
  action: MacroAction;
  behavior?: string;
  param?: string;
  ms?: number;
}

export interface Macro {
  name: string;
  waitMs: number;
  tapMs: number;
  bindings: MacroStep[];
  deviceId?: number;
}

export type OsLayout = 'us' | 'jis';

// Single unified tab bar (below the keyboard) -- only one of these eight is
// ever showing at a time. 'macros' covers both the macro list and, once a
// macro is selected (see selectedMacroIndex), its editor.
export type PanelTab = 'layers' | 'combos' | 'macros' | 'key-config' | 'trackball' | 'timing' | 'bluetooth' | 'diagnostics';

export interface KeymapProject {
  layers: Layer[];
  combos: Combo[];
  macros: Macro[];
  osLayout: OsLayout;
  tappingTerm: number;
  gestures: GestureShortcut[];
  bluetoothProfiles: BluetoothProfile[];
  amlExcluded?: string[];
  deviceSettings?: DeviceSettingsSnapshot;
}

export interface GestureBindingSnapshot {
  behaviorId: number;
  param1: number;
  param2: number;
}

// Cursor ratio is intentionally omitted: the app always sends 1/1 for it
// (see setSensitivity in usbService.ts) and there's no UI to change it, so
// it can't diverge from the device default and isn't worth round-tripping.
export interface SensitivitySnapshot {
  cpi: number;
  scrollNum: number;
  scrollDen: number;
  scrollInverted: boolean;
}

export interface DeviceSettingsSnapshot {
  schemaVersion: 1;
  exportedAt: string;
  device?: {
    name?: string;
    firmwareVersion?: string;
  };
  tappingTerm?: number;
  bluetoothProfiles?: {
    profiles: { name: string; connected?: boolean }[];
    activeIndex?: number;
  };
  usbSlots?: {
    slots: { name: string }[];
    activeIndex?: number;
  };
  trackball?: {
    sensitivity?: SensitivitySnapshot;
    autoLayer?: {
      enabled: boolean;
      requirePriorIdleMs: number;
      excludedPositions: number[];
      motionThreshold: number;
      durationMs: number;
    };
    precisionScale?: {
      numerator: number;
      denominator: number;
    };
    speedScale?: {
      numerator: number;
      denominator: number;
    };
    accel?: {
      enabled: boolean;
      maxMilli: number;
      threshold: number;
      range: number;
    };
    inertia?: {
      enabled: boolean;
      decayMilli: number;
      startSpeed: number;
    };
    dragScale?: {
      enabled: boolean;
      numerator: number;
      denominator: number;
    };
  };
  trackballProfiles?: {
    conductorSlotCount: number;
    profiles: Array<{
      sensitivity?: SensitivitySnapshot;
      precisionScale?: {
        numerator: number;
        denominator: number;
      };
      speedScale?: {
        numerator: number;
        denominator: number;
      };
      accel?: {
        enabled: boolean;
        maxMilli: number;
        threshold: number;
        range: number;
      };
      inertia?: {
        enabled: boolean;
        decayMilli: number;
        startSpeed: number;
      };
      dragScale?: {
        enabled: boolean;
        numerator: number;
        denominator: number;
      };
    }>;
  };
  osConfig?: {
    enabled: boolean;
    osMap: number[];
    endpointCount?: number;
    activeEndpoint?: number;
    activeOs?: number;
  };
  gestureConfig?: {
    enabled: boolean;
    hasOverride: boolean[];
    overrides: GestureBindingSnapshot[];
    endpointCount?: number;
    activeEndpoint?: number;
  };
}
