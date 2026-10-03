// Out of a tram's way: where someone standing in the track goes when a tram comes (it rings, and they step aside to
// the nearest spot clear of every track and every tram, `trams.ts` has the tram ring and `boot.ts` moves the player).
// Pure: the trams as rectangles in the plane, the tracks as segments, and a test for walls handed in. No three.js.

import type { Pt } from './geo';

/** A tram's section in the plane: its middle, the way it faces (a unit vector), its half length and half width. */
export interface Footprint {
  x: number;
  z: number;
  dx: number;
  dz: number;
  hl: number;
  hw: number;
}

/** Whether a point lies within `margin` of a rectangle (`ahead` more in front of it, the way it faces). */
export function inFootprint(f: Footprint, x: number, z: number, margin = 0, ahead = 0): boolean {
  const ux = x - f.x, uz = z - f.z;
  const along = ux * f.dx + uz * f.dz;
  const across = -ux * f.dz + uz * f.dx;
  return along > -f.hl - margin && along < f.hl + margin + ahead && Math.abs(across) < f.hw + margin;
}

/** How far a point lies from a segment. */
function toSegment(x: number, z: number, [ax, az]: Pt, [bx, bz]: Pt): number {
  const ex = bx - ax, ez = bz - az;
  const len2 = ex * ex + ez * ez || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
  return Math.hypot(ax + ex * t - x, az + ez * t - z);
}

/** How far out of the way to step: off a track's middle by more than half a tram and this. */
export const CLEAR = 0.9;

/**
 * The nearest spot to (`x`, `z`) clear of every track (`segments`, their middles, a tram `hw` either side) and every
 * tram (`trams`), by `CLEAR`, and that `free` allows (no wall there): searched across the tram in the way (`from`),
 * on both sides of it and further out, then round about. Null when none is near.
 */
export function stepAside(x: number, z: number, from: Footprint, trams: Footprint[], segments: Array<[Pt, Pt]>, hw: number, free: (x: number, z: number) => boolean): Pt | null {
  const ok = (px: number, pz: number) =>
    segments.every(([a, b]) => toSegment(px, pz, a, b) >= hw + CLEAR) && trams.every((f) => !inFootprint(f, px, pz, CLEAR)) && free(px, pz);
  // Across the tram first, to the side the person stands on, then the other; further out a step at a time.
  const across = -(x - from.x) * from.dz + (z - from.z) * from.dx;
  const sides = across >= 0 ? [1, -1] : [-1, 1];
  for (let out = from.hw + CLEAR; out <= from.hw + 12; out += 0.5) {
    for (const side of sides) {
      const along = (x - from.x) * from.dx + (z - from.z) * from.dz;
      const px = from.x + from.dx * along - from.dz * out * side;
      const pz = from.z + from.dz * along + from.dx * out * side;
      if (ok(px, pz)) return [px, pz];
    }
  }
  // Round about, wider and wider.
  for (let r = 2; r <= 20; r += 1) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (ok(px, pz)) return [px, pz];
    }
  }
  return null;
}
