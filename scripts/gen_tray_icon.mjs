// Generates the menu-bar tray icon as a macOS *template* image: pure black
// pixels carrying only an alpha mask. macOS then tints it itself -- dark on
// light menu bars, light on dark ones -- which is what makes it adapt to the
// wallpaper automatically. Anything other than alpha (colors, a background
// plate) is ignored by the template renderer, so the glyph is drawn edge to
// edge with no plate behind it.
//
// Run: node scripts/gen_tray_icon.mjs
// Writes electron/trayIconTemplate.png (22pt) and @2x (44px).

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron');

// Glyph geometry in a 22x22 coordinate space (macOS menu bar icons are 22pt
// tall). Drawn nearly edge to edge: the old icon wasted most of its box on a
// rounded background plate, which made the keyboard itself look tiny.
const BOARD = { x: 2, y: 2.4, w: 18, h: 11.8, r: 2.6 };
const KEY = { w: 3.6, h: 3.3, r: 0.9, cols: [4.4, 9.2, 14.0], rows: [4.7, 9.5] };
const BALL = { cx: 11, cy: 18.4, r: 3.3 };
const BALL_HIGHLIGHT = { cx: 9.7, cy: 17.1, r: 1.05 };

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

// Solid keyboard body with the keycaps punched out, plus a trackball below
// with a punched-out highlight -- mirrors the app icon's silhouette.
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

function renderAlpha(size) {
  const scale = size / 22;
  const alpha = new Uint8Array(size * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / scale;
          const y = (py + (sy + 0.5) / SS) / scale;
          if (covered(x, y)) hits++;
        }
      }
      alpha[py * size + px] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return alpha;
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
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

function writePng(file, size, alpha) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[o++] = 0; // R -- template images only carry alpha
      raw[o++] = 0; // G
      raw[o++] = 0; // B
      raw[o++] = alpha[y * size + x];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${size}x${size}, ${png.length} bytes)`);
}

writePng(path.join(OUT_DIR, 'trayIconTemplate.png'), 22, renderAlpha(22));
writePng(path.join(OUT_DIR, 'trayIconTemplate@2x.png'), 44, renderAlpha(44));
