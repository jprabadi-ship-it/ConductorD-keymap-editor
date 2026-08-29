// Generates the menu-bar tray icon: the app icon's key-cluster artwork, in
// its own colors, with the rounded background plate dropped so only the
// keyboard and trackball remain on transparency.
//
// Run: node scripts/gen_tray_icon.mjs
// Writes electron/trayIcon.png and @2x.
//
// Geometry mirrors build/icon.svg's inner group (translate(512,512)
// scale(1.35)), converted to the 1024-unit icon space here; keep the two in
// sync if the app icon's artwork changes. Not a macOS template image -- those
// are alpha-only, which would throw away the colors this icon is made of.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron');

const BODY = { x: 302.75, y: 343.25, w: 418.5, h: 337.5, r: 54 };
const KEY = { w: 81, h: 81, r: 16.2, cols: [350, 451.25, 552.5], rows: [387.8, 489.05] };
const ACCENT = { col: 0, row: 1 }; // the orange key, as on the app icon
const BALL = { cx: 491.75, cy: 707.75, r: 97.2, stroke: 5.4 };
const HIGHLIGHT = { cx: 459.35, cy: 675.35, r: 27 };

const COLOR = {
  bodyTop: [0x7e, 0x84, 0x8d],
  bodyBottom: [0x58, 0x5c, 0x64],
  key: [0xff, 0xff, 0xff],
  accent: [0xf5, 0x94, 0x3d],
  ball: [0xff, 0xff, 0xff],
  ballEdge: [0x58, 0x5c, 0x64],
  highlight: [0xda, 0xde, 0xe4],
};

// Bounding box of everything drawn, so the glyph can be fitted to the icon
// without the plate's former padding around it.
const BBOX = {
  x0: Math.min(BODY.x, BALL.cx - BALL.r - BALL.stroke),
  y0: Math.min(BODY.y, BALL.cy - BALL.r - BALL.stroke),
  x1: Math.max(BODY.x + BODY.w, BALL.cx + BALL.r + BALL.stroke),
  y1: Math.max(BODY.y + BODY.h, BALL.cy + BALL.r + BALL.stroke),
};

const CANVAS_H = 22; // the menu bar's fixed icon height, in points
const CONTENT_H = 21; // fill nearly all of it -- the plate used to eat this space
const SS = 8; // supersampling factor, for anti-aliased edges

const glyphW = BBOX.x1 - BBOX.x0;
const glyphH = BBOX.y1 - BBOX.y0;
const CANVAS_W = Math.ceil((glyphW / glyphH) * CONTENT_H) + 1;

function insideRoundRect(x, y, { x: rx, y: ry, w, h, r }) {
  if (x < rx || x > rx + w || y < ry || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const insideCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// Painter's order: body, keycaps, trackball (edge under fill), highlight.
function sample(x, y) {
  if (insideCircle(x, y, HIGHLIGHT.cx, HIGHLIGHT.cy, HIGHLIGHT.r)) return COLOR.highlight;
  if (insideCircle(x, y, BALL.cx, BALL.cy, BALL.r - BALL.stroke)) return COLOR.ball;
  if (insideCircle(x, y, BALL.cx, BALL.cy, BALL.r + BALL.stroke)) return COLOR.ballEdge;

  if (insideRoundRect(x, y, BODY)) {
    for (let c = 0; c < KEY.cols.length; c++) {
      for (let r = 0; r < KEY.rows.length; r++) {
        const cap = { x: KEY.cols[c], y: KEY.rows[r], w: KEY.w, h: KEY.h, r: KEY.r };
        if (insideRoundRect(x, y, cap)) {
          return c === ACCENT.col && r === ACCENT.row ? COLOR.accent : COLOR.key;
        }
      }
    }
    // Vertical gradient, matching the app icon's "halfLight" fill.
    const t = (y - BODY.y) / BODY.h;
    return COLOR.bodyTop.map((v, i) => Math.round(v + (COLOR.bodyBottom[i] - v) * t));
  }
  return null;
}

function render(scale) {
  const pw = CANVAS_W * scale;
  const ph = CANVAS_H * scale;
  const px = new Uint8Array(pw * ph * 4);
  const unitsPerPoint = glyphH / CONTENT_H;
  const originX = BBOX.x0 - ((CANVAS_W - glyphW / unitsPerPoint) / 2) * unitsPerPoint;
  const originY = BBOX.y0 - ((CANVAS_H - CONTENT_H) / 2) * unitsPerPoint;

  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let hits = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = originX + ((x + (sx + 0.5) / SS) / scale) * unitsPerPoint;
          const uy = originY + ((y + (sy + 0.5) / SS) / scale) * unitsPerPoint;
          const c = sample(ux, uy);
          if (c) {
            hits++;
            r += c[0];
            g += c[1];
            b += c[2];
          }
        }
      }
      const o = (y * pw + x) * 4;
      if (hits) {
        px[o] = Math.round(r / hits);
        px[o + 1] = Math.round(g / hits);
        px[o + 2] = Math.round(b / hits);
        px[o + 3] = Math.round((hits / (SS * SS)) * 255);
      }
    }
  }
  return { px, pw, ph };
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
  const { px, pw, ph } = render(scale);
  const raw = Buffer.alloc(ph * (pw * 4 + 1));
  let o = 0;
  for (let y = 0; y < ph; y++) {
    raw[o++] = 0; // filter: none
    Buffer.from(px.buffer, y * pw * 4, pw * 4).copy(raw, o);
    o += pw * 4;
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

writePng(path.join(OUT_DIR, 'trayIcon.png'), 1);
writePng(path.join(OUT_DIR, 'trayIcon@2x.png'), 2);
