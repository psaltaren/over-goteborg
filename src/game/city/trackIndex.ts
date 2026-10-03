// The tram tracks by where they lie: every segment of the track graph (`trackData.ts`) in 20 m squares, for finding the
// tracks near a point and how far the nearest is. Shared by the rails' poles (`rails.ts`), the trams (`trams.ts`) and
// stepping aside (`aside.ts`). No three.js.

import type { Pt } from './geo';
import type { Link } from './trackData';

/** The squares' size, in meters. */
const CELL = 20;

/** How far a point lies from a segment. */
export function segmentDistance(x: number, z: number, [ax, az]: Pt, [bx, bz]: Pt): number {
  const ex = bx - ax, ez = bz - az;
  const len2 = ex * ex + ez * ez || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
  return Math.hypot(ax + ex * t - x, az + ez * t - z);
}

export class TrackIndex {
  private readonly cells = new Map<number, Array<[Pt, Pt]>>();

  constructor(links: Link[]) {
    for (const l of links) {
      for (let i = 0; i + 1 < l.pts.length; i++) {
        const [a, b] = [l.pts[i], l.pts[i + 1]];
        for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++) {
          for (let z = Math.floor(Math.min(a[1], b[1]) / CELL); z <= Math.floor(Math.max(a[1], b[1]) / CELL); z++) {
            const key = this.key(x, z);
            if (!this.cells.has(key)) this.cells.set(key, []);
            this.cells.get(key)!.push([a, b]);
          }
        }
      }
    }
  }

  /** A square's key: its two indices in one number (the city lies within a few kilometers of the origin). */
  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }

  /** The segments within about `reach` of (`x`, `z`), each once. */
  near(x: number, z: number, reach: number): Array<[Pt, Pt]> {
    const out = new Set<[Pt, Pt]>();
    for (let i = Math.floor((x - reach) / CELL); i <= Math.floor((x + reach) / CELL); i++) {
      for (let j = Math.floor((z - reach) / CELL); j <= Math.floor((z + reach) / CELL); j++) for (const seg of this.cells.get(this.key(i, j)) ?? []) out.add(seg);
    }
    return [...out];
  }

  /** How far the nearest track's middle lies from (`x`, `z`), looked for within `CELL` (Infinity when none is that near). */
  distance(x: number, z: number): number {
    let best = Infinity;
    for (let i = Math.floor(x / CELL) - 1; i <= Math.floor(x / CELL) + 1; i++) {
      for (let j = Math.floor(z / CELL) - 1; j <= Math.floor(z / CELL) + 1; j++) {
        for (const [a, b] of this.cells.get(this.key(i, j)) ?? []) best = Math.min(best, segmentDistance(x, z, a, b));
      }
    }
    return best;
  }
}
