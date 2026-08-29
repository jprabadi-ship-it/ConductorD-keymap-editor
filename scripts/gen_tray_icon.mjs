// Generates the menu-bar tray icon as a macOS *template* image: pure black
// pixels carrying only an alpha mask. macOS then tints it itself -- dark on
// light menu bars, light on dark ones -- which is what makes it adapt to the
// wallpaper automatically. Anything other than alpha (colors, a background
// plate) is ignored by the template renderer, so the glyph is drawn edge to
// edge with nothing behind it.
//
// Run: node scripts/gen_tray_icon.mjs
// Writes electron/trayIconTemplate.png and @2x.
//
// The canvas is wider than it is tall on purpose: the menu bar fixes icon
// height at 22pt but lets width run free, so spending the extra width on the
// keyboard is the only way to make it meaningfully bigger.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron');

const W = 26; // points
const H = 22; // points -- the menu bar's fixed icon height

// Keyboard body, drawn nearly to the canvas edges.
const BOARD = { x: 0.7, y: 0.7, w: 24.6, h: 14.4, r: 2.9 };
// Keycaps punched out of it: 3 columns x 2 rows, matching the app icon.
const KEY = { w: 5.7, h: 4.5, r: 1.3, cols: [2.9, 10.15, 17.4], rows: [2.7, 8.6] };
// Trackball tucked under the body, as on the app icon.
const BALL = { cx: 13, cy: 18.7, r: 3.3 };
const BALL_HIGHLIGHT = { cx: 11.75, cy: 17.45, r: 1.05 };

const SS = 8; // supersampling factor, for anti-aliased edges

function insideRoundRect(x, y, { x: rx, y: ry, w, h, r }) {
  if (x < rx || x > rx + w || y < ry || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideCircle(x, y, { cx, cy, r }) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function covered(x, y) {
  if (insideRoundRect(x, y, BOARD)) {
    for (const kx of KEY.cols) {
      for (const ky of KEY.rows) {
        if (insideRoundRect(x, y, { x: kx, y: ky, w: KEY.w, h: KEY.h, r: KEY.r })) return false;
      }
    }
    return true;
  }
  if (insideCircle(x, y, BALL)) return !insideCircle(x, y, BALL_HIGHLIGHT);
  return false;
}

function renderAlpha(scale) {
  const pw = W * scale;
  const ph = H * scale;
  const alpha = new Uint8Array(pw * ph);
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / scale;
          const y = (py + (sy + 0.5) / SS) / scale;
          if (covered(x, y)) hits++;
        }
      }
      alpha[py * pw + px] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return { alpha, pw, ph };
}

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, scale) {
  const { alpha, pw, ph } = renderAlpha(scale);
  const raw = Buffer.alloc(ph * (pw * 4 + 1));
  let o = 0;
  for (let y = 0; y < ph; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < pw; x++) {
      raw[o++] = 0; // R -- template images only carry alpha
      raw[o++] = 0; // G
      raw[o++] = 0; // B
      raw[o++] = alpha[y * pw + x];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pw, 0);
  ihdr.writeUInt32BE(ph, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${pw}x${ph})`);
}

writePng(path.join(OUT_DIR, 'trayIconTemplate.png'), 1);
writePng(path.join(OUT_DIR, 'trayIconTemplate@2x.png'), 2);
