// The app icon as PNG, drawn from the same shapes as public/favicon.svg: an M34 tram from the front under its contact
// wire, its pantograph up to the wire. Generated at build time (vite.config.ts), so no image file is committed.
import { deflateSync } from 'node:zlib';

type RGB = [number, number, number];
const BG: RGB = [0x05, 0x06, 0x08];
const BLUE: RGB = [0x3b, 0xa8, 0xe0];
const CREAM: RGB = [0xee, 0xe8, 0xd6];
const GLASS: RGB = [0x1d, 0x2a, 0x33];
const WIRE: RGB = [0x8a, 0x93, 0x99];

/** Signed distance to a rounded box, in the favicon's 64 unit space. */
function box(x: number, y: number, x0: number, y0: number, w: number, h: number, r: number): number {
  const qx = Math.abs(x - (x0 + w / 2)) - w / 2 + r;
  const qy = Math.abs(y - (y0 + h / 2)) - h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to a segment. */
function line(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
  return Math.hypot(ax + ex * t - x, ay + ey * t - y);
}

/** The colour at a point of the 64 unit favicon, or null outside its rounded square. */
function sample(x: number, y: number, square: boolean): RGB | null {
  if (!square && box(x, y, 0, 0, 64, 64, 14) > 0) return null;
  // The wire across the top, and the pantograph from it down to the roof.
  if (line(x, y, 7, 11, 57, 11) <= 1 || line(x, y, 28, 12, 36, 25) <= 1) return WIRE;
  if (box(x, y, 16, 25, 32, 32, 6) <= 0) {
    if (box(x, y, 20, 33, 24, 11, 2) <= 0) return GLASS;
    if (box(x, y, 20, 48, 5, 3, 1) <= 0 || box(x, y, 39, 48, 5, 3, 1) <= 0) return CREAM;
    return y < 31 ? CREAM : BLUE;
  }
  return BG;
}

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A square PNG of the icon. `square` fills the corners (for maskable and Apple icons, which the system rounds itself)
 * and `scale` shrinks the picture toward the middle, so it stays inside a maskable icon's safe circle.
 */
export function iconPng(size: number, { square = false, scale = 1 } = {}): Uint8Array {
  const SS = 4;
  const rows = new Uint8Array(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Pixel to favicon units, scaled around the centre.
          const u = (((px + (sx + 0.5) / SS) / size) * 64 - 32) / scale + 32;
          const v = (((py + (sy + 0.5) / SS) / size) * 64 - 32) / scale + 32;
          const inside = u >= 0 && u <= 64 && v >= 0 && v <= 64;
          const c = inside ? sample(u, v, square) : square ? BG : null;
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const o = row + 1 + px * 4;
      if (a) {
        rows[o] = Math.round(r / a);
        rows[o + 1] = Math.round(g / a);
        rows[o + 2] = Math.round(b / a);
      }
      rows[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8); // 8 bit RGBA, no interlace.
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}

/** Every icon the pages and the web app manifest point to. */
export const ICONS: Array<{ file: string; png: () => Uint8Array }> = [
  { file: 'icon-192.png', png: () => iconPng(192) },
  { file: 'icon-512.png', png: () => iconPng(512) },
  { file: 'icon-maskable-512.png', png: () => iconPng(512, { square: true, scale: 0.72 }) },
  { file: 'apple-touch-icon.png', png: () => iconPng(180, { square: true, scale: 0.84 }) },
];
