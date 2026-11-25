export interface KeyCodeEntry {
  code: string;
  label: string;
  category: string;
}

export const KEY_CATEGORIES = [
  'Letters', 'Numbers', 'Modifiers', 'Navigation', 'Function',
  'Special', 'IME', 'Symbols', 'Media', 'Mouse', 'Device', 'System', 'Layer',
] as const;

export type KeyCategory = typeof KEY_CATEGORIES[number];

export const KEYCODES: KeyCodeEntry[] = [
  // Letters
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => ({ code: `KC_${c}`, label: c, category: 'Letters' })),

  // Numbers
  ...'1234567890'.split('').map(c => ({ code: `KC_${c}`, label: c, category: 'Numbers' })),
  // Numpad
  ...Array.from({ length: 10 }, (_, i) => ({ code: `KC_KP${i}`, label: `KP ${i}`, category: 'Numbers' })),
  { code: 'KC_KP_DOT', label: 'KP .', category: 'Numbers' },
  { code: 'KC_KP_PLUS', label: 'KP +', category: 'Numbers' },
  { code: 'KC_KP_MINUS', label: 'KP -', category: 'Numbers' },
  { code: 'KC_KP_ASTERISK', label: 'KP *', category: 'Numbers' },
  { code: 'KC_KP_SLASH', label: 'KP /', category: 'Numbers' },
  { code: 'KC_KP_ENTER', label: 'KP Enter', category: 'Numbers' },
  { code: 'KC_NLCK', label: 'Num Lock', category: 'Numbers' },

  // Modifiers
  { code: 'KC_LSFT', label: 'L Shift', category: 'Modifiers' },
  { code: 'KC_RSFT', label: 'R Shift', category: 'Modifiers' },
  { code: 'KC_LCTL', label: 'L Ctrl', category: 'Modifiers' },
  { code: 'KC_RCTL', label: 'R Ctrl', category: 'Modifiers' },
  { code: 'KC_LALT', label: 'L Alt', category: 'Modifiers' },
  { code: 'KC_RALT', label: 'R Alt', category: 'Modifiers' },
  { code: 'KC_LGUI', label: 'L GUI', category: 'Modifiers' },
  { code: 'KC_RGUI', label: 'R GUI', category: 'Modifiers' },

  // Navigation
  { code: 'KC_UP', label: 'Up', category: 'Navigation' },
  { code: 'KC_DOWN', label: 'Down', category: 'Navigation' },
  { code: 'KC_LEFT', label: 'Left', category: 'Navigation' },
  { code: 'KC_RIGHT', label: 'Right', category: 'Navigation' },
  { code: 'KC_HOME', label: 'Home', category: 'Navigation' },
  { code: 'KC_END', label: 'End', category: 'Navigation' },
  { code: 'KC_PGUP', label: 'PgUp', category: 'Navigation' },
  { code: 'KC_PGDN', label: 'PgDn', category: 'Navigation' },
  { code: 'KC_INS', label: 'Insert', category: 'Navigation' },
  { code: 'KC_DEL', label: 'Delete', category: 'Navigation' },

  // Function keys (F1-F24)
  ...Array.from({ length: 24 }, (_, i) => ({ code: `KC_F${i + 1}`, label: `F${i + 1}`, category: 'Function' })),

  // Special
  { code: 'KC_ENT', label: 'Enter', category: 'Special' },
  { code: 'KC_ESC', label: 'ESC', category: 'Special' },
  { code: 'KC_BSPC', label: 'Bksp', category: 'Special' },
  { code: 'KC_TAB', label: 'TAB', category: 'Special' },
  { code: 'KC_SPC', label: 'Space', category: 'Special' },
  { code: 'KC_CAPS', label: 'Caps', category: 'Special' },
  { code: 'KC_PSCR', label: 'PrtSc', category: 'Special' },
  { code: 'KC_SCRL', label: 'ScrLk', category: 'Special' },
  { code: 'KC_PAUS', label: 'Pause', category: 'Special' },

  // IME
  { code: 'KC_LANG1', label: 'LANG1 (かな)', category: 'IME' },
  { code: 'KC_LANG2', label: 'LANG2 (英数)', category: 'IME' },
  { code: 'KC_INT1', label: 'INT1 (ろ/_)', category: 'IME' },
  { code: 'KC_INT2', label: 'INT2 (かな/カナ)', category: 'IME' },
  { code: 'KC_INT3', label: 'INT3 (¥)', category: 'IME' },
  { code: 'KC_INT4', label: 'INT4 (変換)', category: 'IME' },
  { code: 'KC_INT5', label: 'INT5 (無変換)', category: 'IME' },
  { code: 'KC_HENK', label: 'Henkan (変換)', category: 'IME' },
  { code: 'KC_MHEN', label: 'Muhenkan (無変換)', category: 'IME' },
  { code: 'KC_KANA', label: 'Kana (かな)', category: 'IME' },
  // macOS "🌐" Globe/fn key (dt-bindings/zmk/keys.h's GLOBE ->
  // AC_NEXT_KEYBOARD_LAYOUT_SELECT, Consumer usage 0x29D).
  { code: 'GLOBE', label: 'Globe (🌐/fn)', category: 'IME' },

  // Symbols
  { code: 'KC_MINS', label: '-', category: 'Symbols' },
  { code: 'KC_EQL', label: '=', category: 'Symbols' },
  { code: 'KC_LBRC', label: '[', category: 'Symbols' },
  { code: 'KC_RBRC', label: ']', category: 'Symbols' },
  { code: 'KC_BSLS', label: '\\', category: 'Symbols' },
  { code: 'KC_SCLN', label: ';', category: 'Symbols' },
  { code: 'KC_QUOT', label: "'", category: 'Symbols' },
  { code: 'KC_GRV', label: '`', category: 'Symbols' },
  { code: 'KC_COMM', label: ',', category: 'Symbols' },
  { code: 'KC_DOT', label: '.', category: 'Symbols' },
  { code: 'KC_SLSH', label: '/', category: 'Symbols' },
  // Shift+key symbols
  { code: 'KC_EXLM', label: '!', category: 'Symbols' },
  { code: 'KC_AT', label: '@', category: 'Symbols' },
  { code: 'KC_HASH', label: '#', category: 'Symbols' },
  { code: 'KC_DLR', label: '$', category: 'Symbols' },
  { code: 'KC_PERC', label: '%', category: 'Symbols' },
  { code: 'KC_CIRC', label: '^', category: 'Symbols' },
  { code: 'KC_AMPR', label: '&', category: 'Symbols' },
  { code: 'KC_ASTR', label: '*', category: 'Symbols' },
  { code: 'KC_LPRN', label: '(', category: 'Symbols' },
  { code: 'KC_RPRN', label: ')', category: 'Symbols' },
  { code: 'KC_UNDS', label: '_', category: 'Symbols' },
  { code: 'KC_PLUS', label: '+', category: 'Symbols' },
  { code: 'KC_LCBR', label: '{', category: 'Symbols' },
  { code: 'KC_RCBR', label: '}', category: 'Symbols' },
  { code: 'KC_PIPE', label: '|', category: 'Symbols' },
  { code: 'KC_COLN', label: ':', category: 'Symbols' },
  { code: 'KC_DQUO', label: '"', category: 'Symbols' },
  { code: 'KC_TILD', label: '~', category: 'Symbols' },
  { code: 'KC_LABK', label: '<', category: 'Symbols' },
  { code: 'KC_RABK', label: '>', category: 'Symbols' },
  { code: 'KC_QUES', label: '?', category: 'Symbols' },

  // Media
  { code: 'KC_MUTE', label: 'Mute', category: 'Media' },
  { code: 'KC_VOLU', label: 'Vol+', category: 'Media' },
  { code: 'KC_VOLD', label: 'Vol-', category: 'Media' },
  { code: 'KC_MPLY', label: 'Play', category: 'Media' },
  { code: 'KC_MNXT', label: 'Next', category: 'Media' },
  { code: 'KC_MPRV', label: 'Prev', category: 'Media' },
  { code: 'KC_MSTP', label: 'Stop', category: 'Media' },
  { code: 'KC_BRIU', label: 'Bri+', category: 'Media' },
  { code: 'KC_BRID', label: 'Bri-', category: 'Media' },
  // macOS system keys as sent by QMK/Keychron boards (KC_LAUNCHPAD /
  // KC_MISSION_CONTROL): Consumer 0x2A0 opens the app list (Launchpad, the
  // Spotlight "Apps" view since macOS 26) and 0x29F opens Mission Control.
  { code: 'KC_LAUNCHPAD', label: 'Apps', category: 'Media' },
  { code: 'KC_MISSION_CONTROL', label: 'Mission', category: 'Media' },

  // Mouse
  { code: 'KC_MS_U', label: 'Mouse Up', category: 'Mouse' },
  { code: 'KC_MS_D', label: 'Mouse Down', category: 'Mouse' },
  { code: 'KC_MS_L', label: 'Mouse Left', category: 'Mouse' },
  { code: 'KC_MS_R', label: 'Mouse Right', category: 'Mouse' },
  { code: 'KC_BTN1', label: 'Click', category: 'Mouse' },
  { code: 'KC_BTN2', label: 'R Click', category: 'Mouse' },
  { code: 'KC_BTN3', label: 'M Click', category: 'Mouse' },
  { code: 'KC_WH_U', label: 'Wheel Up', category: 'Mouse' },
  { code: 'KC_WH_D', label: 'Wheel Down', category: 'Mouse' },

  // Device (Bluetooth profiles + USB virtual slots — see conductor_usb_slot.h
  // on the firmware side; USB has only one physical connection, so its slots
  // are software-selected, unlike BT's real pairing profiles)
  { code: 'BT_SEL_0', label: 'BT 0', category: 'Device' },
  { code: 'BT_SEL_1', label: 'BT 1', category: 'Device' },
  { code: 'BT_SEL_2', label: 'BT 2', category: 'Device' },
  { code: 'BT_SEL_3', label: 'BT 3', category: 'Device' },
  { code: 'BT_SEL_4', label: 'BT 4', category: 'Device' },
  { code: 'BT_CLR', label: 'BT Clear', category: 'Device' },
  { code: 'BT_CLR_ALL', label: 'BT Clear All', category: 'Device' },
  { code: 'OUT_USB', label: 'Out USB', category: 'Device' },
  { code: 'OUT_BT', label: 'Out BT', category: 'Device' },
  { code: 'OUT_TOG', label: 'Out Toggle', category: 'Device' },
  { code: 'USB_SEL_0', label: 'USB 0', category: 'Device' },
  { code: 'USB_SEL_1', label: 'USB 1', category: 'Device' },
  { code: 'USB_SEL_2', label: 'USB 2', category: 'Device' },
  { code: 'USB_SEL_3', label: 'USB 3', category: 'Device' },
  { code: 'USB_SEL_4', label: 'USB 4', category: 'Device' },
  { code: 'AML_TOG', label: 'AML Tog', category: 'Device' },
  { code: 'PINCH_ZOOM', label: 'Pinch Zoom', category: 'Device' },

  // System
  { code: 'QK_BOOT', label: 'Boot', category: 'System' },
  { code: 'QK_RBT', label: 'Reboot', category: 'System' },
  { code: 'EE_CLR', label: 'EEPROM Clear', category: 'System' },
  { code: 'DB_TOGG', label: 'Debug Toggle', category: 'System' },

  // Layer (generated dynamically)
  ...Array.from({ length: 14 }, (_, i) => ({ code: `MO(${i})`, label: `MO(${i})`, category: 'Layer' })),
  ...Array.from({ length: 14 }, (_, i) => ({ code: `TG(${i})`, label: `TG(${i})`, category: 'Layer' })),
  ...Array.from({ length: 14 }, (_, i) => ({ code: `TO(${i})`, label: `TO(${i})`, category: 'Layer' })),
  ...Array.from({ length: 14 }, (_, i) => ({ code: `LT(${i})`, label: `LT(${i})`, category: 'Layer' })),
];

export function findKeyCode(code: string): KeyCodeEntry | undefined {
  return KEYCODES.find(k => k.code === code);
}

export function searchKeyCodes(query: string, category?: string): KeyCodeEntry[] {
  let results = KEYCODES;
  if (category) results = results.filter(k => k.category === category);
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(k => k.label.toLowerCase().includes(q) || k.code.toLowerCase().includes(q));
  }
  return results;
}
