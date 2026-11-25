#!/usr/bin/env node
// Checks that every entry in the key picker (src/data/keycodes.ts) can be
// written to the device as the key it claims to be.
//
// The picker hands its *label* to the Write path, which turns the label back
// into a HID usage (labelToParam in src/services/usbService.ts). A label the
// reverse tables don't know resolves to 0, and a label two usages share
// resolves to the wrong one -- both went unnoticed for a long time (Insert,
// Delete, the whole IME category and "\" up to v0.38.71). Run this after
// adding or rewording a picker entry, or touching the usage tables:
//
//   npm run check:keycodes
//
// Exit status 1 on any failure.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Picker code -> the param it must produce on a US layout: (mods << 24) |
// (usage page << 16) | usage id. Taken from ZMK's dt-bindings/zmk/keys.h
// (0x07 = keyboard page, 0x0C = consumer page, mods 0x02 = left shift).
const EXPECTED = {
  KC_A: 0x070004, KC_B: 0x070005, KC_C: 0x070006, KC_D: 0x070007, KC_E: 0x070008, KC_F: 0x070009,
  KC_G: 0x07000A, KC_H: 0x07000B, KC_I: 0x07000C, KC_J: 0x07000D, KC_K: 0x07000E, KC_L: 0x07000F,
  KC_M: 0x070010, KC_N: 0x070011, KC_O: 0x070012, KC_P: 0x070013, KC_Q: 0x070014, KC_R: 0x070015,
  KC_S: 0x070016, KC_T: 0x070017, KC_U: 0x070018, KC_V: 0x070019, KC_W: 0x07001A, KC_X: 0x07001B,
  KC_Y: 0x07001C, KC_Z: 0x07001D, KC_1: 0x07001E, KC_2: 0x07001F, KC_3: 0x070020, KC_4: 0x070021,
  KC_5: 0x070022, KC_6: 0x070023, KC_7: 0x070024, KC_8: 0x070025, KC_9: 0x070026, KC_0: 0x070027,
  KC_KP0: 0x070062, KC_KP1: 0x070059, KC_KP2: 0x07005A, KC_KP3: 0x07005B, KC_KP4: 0x07005C,
  KC_KP5: 0x07005D, KC_KP6: 0x07005E, KC_KP7: 0x07005F, KC_KP8: 0x070060, KC_KP9: 0x070061,
  KC_KP_DOT: 0x070063, KC_KP_PLUS: 0x070057, KC_KP_MINUS: 0x070056, KC_KP_ASTERISK: 0x070055,
  KC_KP_SLASH: 0x070054, KC_KP_ENTER: 0x070058, KC_NLCK: 0x070053, KC_LSFT: 0x0700E1,
  KC_RSFT: 0x0700E5, KC_LCTL: 0x0700E0, KC_RCTL: 0x0700E4, KC_LALT: 0x0700E2, KC_RALT: 0x0700E6,
  KC_LGUI: 0x0700E3, KC_RGUI: 0x0700E7, KC_UP: 0x070052, KC_DOWN: 0x070051, KC_LEFT: 0x070050,
  KC_RIGHT: 0x07004F, KC_HOME: 0x07004A, KC_END: 0x07004D, KC_PGUP: 0x07004B, KC_PGDN: 0x07004E,
  KC_INS: 0x070049, KC_DEL: 0x07004C, KC_F1: 0x07003A, KC_F2: 0x07003B, KC_F3: 0x07003C,
  KC_F4: 0x07003D, KC_F5: 0x07003E, KC_F6: 0x07003F, KC_F7: 0x070040, KC_F8: 0x070041,
  KC_F9: 0x070042, KC_F10: 0x070043, KC_F11: 0x070044, KC_F12: 0x070045, KC_F13: 0x070068,
  KC_F14: 0x070069, KC_F15: 0x07006A, KC_F16: 0x07006B, KC_F17: 0x07006C, KC_F18: 0x07006D,
  KC_F19: 0x07006E, KC_F20: 0x07006F, KC_F21: 0x070070, KC_F22: 0x070071, KC_F23: 0x070072,
  KC_F24: 0x070073, KC_ENT: 0x070028, KC_ESC: 0x070029, KC_BSPC: 0x07002A, KC_TAB: 0x07002B,
  KC_SPC: 0x07002C, KC_CAPS: 0x070039, KC_PSCR: 0x070046, KC_SCRL: 0x070047, KC_PAUS: 0x070048,
  KC_APP: 0x070065, KC_LANG1: 0x070090, KC_LANG2: 0x070091, KC_INT1: 0x070087, KC_INT2: 0x070088,
  KC_INT3: 0x070089, KC_INT4: 0x07008A, KC_INT5: 0x07008B, KC_HENK: 0x07008A, KC_MHEN: 0x07008B,
  KC_KANA: 0x070088, GLOBE: 0x0C029D, KC_MINS: 0x07002D, KC_EQL: 0x07002E, KC_LBRC: 0x07002F,
  KC_RBRC: 0x070030, KC_BSLS: 0x070031, KC_SCLN: 0x070033, KC_QUOT: 0x070034, KC_GRV: 0x070035,
  KC_COMM: 0x070036, KC_DOT: 0x070037, KC_SLSH: 0x070038, KC_EXLM: 0x207001E, KC_AT: 0x207001F,
  KC_HASH: 0x2070020, KC_DLR: 0x2070021, KC_PERC: 0x2070022, KC_CIRC: 0x2070023, KC_AMPR: 0x2070024,
  KC_ASTR: 0x2070025, KC_LPRN: 0x2070026, KC_RPRN: 0x2070027, KC_UNDS: 0x207002D, KC_PLUS: 0x207002E,
  KC_LCBR: 0x207002F, KC_RCBR: 0x2070030, KC_PIPE: 0x2070031, KC_COLN: 0x2070033, KC_DQUO: 0x2070034,
  KC_TILD: 0x2070035, KC_LABK: 0x2070036, KC_RABK: 0x2070037, KC_QUES: 0x2070038, KC_MUTE: 0x0C00E2,
  KC_VOLU: 0x0C00E9, KC_VOLD: 0x0C00EA, KC_MPLY: 0x0C00CD, KC_MNXT: 0x0C00B5, KC_MPRV: 0x0C00B6,
  KC_MSTP: 0x0C00B7, KC_BRIU: 0x0C006F, KC_BRID: 0x0C0070, KC_LAUNCHPAD: 0x0C02A0,
  KC_MISSION_CONTROL: 0x0C029F,
  // Not named in keys.h: what QMK/Keychron boards send for these two keys.
  KC_LAUNCHPAD: 0x0C02A0, KC_MISSION_CONTROL: 0x0C029F,
};

// Picker entries that are not key presses but still fall through to the
// key-press path, so they cannot be written yet (Write reports them as
// failed). Listed so that a *new* unwritable entry fails this check instead
// of hiding among them. Remove a code from here once its behavior is handled.
const KNOWN_UNWRITABLE = new Set([
  'KC_MS_U', 'KC_MS_D', 'KC_MS_L', 'KC_MS_R', 'KC_WH_U', 'KC_WH_D',
  'QK_BOOT', 'QK_RBT', 'EE_CLR', 'DB_TOGG',
  ...['MO', 'TG', 'TO', 'LT'].flatMap(t => Array.from({ length: 14 }, (_, i) => `${t}(${i})`)),
]);

// Mirrors the keyCode special cases at the top of the 'basic' branch in
// writeKeymapToDevice / resolveKeyBindingRpc: these never reach labelToParam.
function handledByOwnBehavior({ code, label }) {
  return code.startsWith('USB_SEL') || code.startsWith('BT_SEL') ||
    ['BT_CLR', 'BT_CLR_ALL', 'OUT_USB', 'OUT_BT', 'OUT_TOG', 'BOOTLOADER', 'AML_TOG', 'PINCH_ZOOM'].includes(code) ||
    code.startsWith('mkp') || code.startsWith('KC_BTN') ||
    label.startsWith('MB') || ['Click', 'R Click', 'M Click'].includes(label);
}

const hex = n => '0x' + (n >>> 0).toString(16);
const server = await createServer({ root: ROOT, configFile: false, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
const failures = [];
let checked = 0;
try {
  const usb = await server.ssrLoadModule('/src/services/usbService.ts');
  const { KEYCODES } = await server.ssrLoadModule('/src/data/keycodes.ts');

  const seenLabel = new Map();
  for (const entry of KEYCODES) {
    const where = `${entry.category} / ${entry.code} "${entry.label}"`;
    if (seenLabel.has(entry.label)) failures.push(`${where}: same label as ${seenLabel.get(entry.label)}`);
    seenLabel.set(entry.label, entry.code);
    if (handledByOwnBehavior(entry)) continue;

    for (const layout of ['us', 'jis']) {
      usb.setKeyboardLayout(layout);
      const param = usb.labelToParam(entry.label, entry.code) >>> 0;
      if (KNOWN_UNWRITABLE.has(entry.code)) {
        if (param !== 0) failures.push(`${where}: listed in KNOWN_UNWRITABLE but resolves to ${hex(param)} on ${layout}`);
        continue;
      }
      checked++;
      if (param === 0) {
        failures.push(`${where}: resolves to 0 on ${layout} -- add it to KEYCODE_TO_PARAM (or the label tables) in usbService.ts`);
        continue;
      }
      // Symbols are typed by different keys on JIS; only US has one right answer.
      if (layout === 'us') {
        const want = EXPECTED[entry.code];
        if (want === undefined) failures.push(`${where}: no entry in EXPECTED -- add its usage to this script`);
        else if (param !== want >>> 0) failures.push(`${where}: resolves to ${hex(param)}, expected ${hex(want)}`);
      }
      // What a Read shows for this key must write back as the same key, and
      // the picker must still recognise it as this entry.
      const readLabel = usb.hidToLabel(param);
      const again = usb.labelToParam(readLabel, readLabel) >>> 0;
      if (again !== param) failures.push(`${where}: reads back as "${readLabel}" on ${layout}, which writes ${hex(again)} instead of ${hex(param)}`);
      if (!usb.isSameKeyPress(readLabel, readLabel, entry.label, entry.code)) failures.push(`${where}: picker would not highlight it after a Read on ${layout} ("${readLabel}")`);
    }
  }
  usb.setKeyboardLayout('us');
} finally {
  await server.close();
}

if (failures.length) {
  console.error(`check-keycodes: ${failures.length} problem(s)`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`check-keycodes: OK (${checked} picker entry/layout pairs; ${KNOWN_UNWRITABLE.size} known-unwritable entries skipped)`);
