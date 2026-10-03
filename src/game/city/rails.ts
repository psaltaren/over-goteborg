// The tram tracks in the street, built into each square of the city (`tiles.ts`) from the track graph (`tracks.json`):
// two grooved rails a track, sunk in a strip of setts as Drottningtorget has them, and over it the contact wire the
// pantographs reach up to, hung from poles beside the track with an arm out over it. A segment of track is built by the
// square its middle lies in, so the squares meet without a seam or a doubled rail; a track that runs both ways (a twin)
// once. Into the square's lit layer, so the street lamps' light is baked in.

import { BoxGeometry, Matrix4, Vector3 } from 'three';
import type { MeshBuilder } from '../gfx/builder';
import type { Paint } from '../gfx/builder';
import { rgb } from '../gfx/color';
import { TRAM_GAUGE, TRAM_RAIL, TRAM_WIDTH, TRAM_WIRE } from '../layout';
import type { Physics, StaticCollider } from '../physics';
import type { Section } from '../world/section';
import type { Pt, Rect } from './geo';
import type { Link } from './trackData';

const SETTS = rgb(0x9b958b);
const STEEL = rgb(0xc3c6c9);
const GROOVE = rgb(0x1c1d1e);
const WIRE = rgb(0x26292b);
const POLE = rgb(0x4d5753);
/** Heights over the street of the setts and the rails' heads, just over the road (`streetOsm.ts` lays roads at -0.05). */
const BED_Y = -0.042;
const HEAD_Y = -0.032;
/** The strip of setts: the gauge and this much either side. */
const BED_OUT = 0.45;
/** The contact wire's thickness as drawn (thicker than it is, so it does not flicker out of sight). */
const WIRE_T = 0.025;
/** Poles: one every this many meters along a track, kept this far from a junction, this far out from the track's middle. */
const POLE_EVERY = 36;
const POLE_KEEP = 10;
const POLE_OUT = TRAM_WIDTH / 2 + 1.25;
const POLE_HALF = 0.11;

/** A polyline moved `o` meters to the right of the way it runs (z is right of +x), its corners mitred. */
function offset(pts: Pt[], o: number): Pt[] {
  const normal = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
    return [-dz / len, dx / len];
  };
  return pts.map((p, i) => {
    const n1 = i > 0 ? normal(pts[i - 1], p) : null;
    const n2 = i + 1 < pts.length ? normal(p, pts[i + 1]) : null;
    let [nx, nz] = n1 && n2 ? [n1[0] + n2[0], n1[1] + n2[1]] : (n1 ?? n2)!;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    // Mitred: further out at a corner, so the strip keeps its width round it (held where the corner is sharp).
    const ref = n1 ?? n2!;
    const k = 1 / Math.max(0.5, nx * ref[0] + nz * ref[1]);
    return [p[0] + nx * o * k, p[1] + nz * o * k];
  });
}

const inside = (r: Rect, x: number, z: number) => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1;

/** A level beam from `a` to `b`, `t` thick, whichever way it runs. */
function beam(out: MeshBuilder, a: Vector3, b: Vector3, t: number, paint: Paint): void {
  const geo = new BoxGeometry(a.distanceTo(b), t, t);
  const m = new Matrix4().makeRotationY(Math.atan2(-(b.z - a.z), b.x - a.x)).setPosition(a.clone().add(b).multiplyScalar(0.5));
  out.geometry(geo, m, paint);
  geo.dispose();
}

/** The tracks near a point, for keeping poles off them: their segments by 20 m square. */
class TrackGrid {
  private readonly cells = new Map<string, Array<[Pt, Pt]>>();
  constructor(links: Link[]) {
    for (const l of links) {
      for (let i = 0; i + 1 < l.pts.length; i++) {
        const [a, b] = [l.pts[i], l.pts[i + 1]];
        for (let x = Math.floor(Math.min(a[0], b[0]) / 20); x <= Math.floor(Math.max(a[0], b[0]) / 20); x++) {
          for (let z = Math.floor(Math.min(a[1], b[1]) / 20); z <= Math.floor(Math.max(a[1], b[1]) / 20); z++) {
            const key = `${x},${z}`;
            if (!this.cells.has(key)) this.cells.set(key, []);
            this.cells.get(key)!.push([a, b]);
          }
        }
      }
    }
  }

  /** How far the nearest track's middle lies from (`x`, `z`). */
  distance(x: number, z: number): number {
    let best = Infinity;
    for (let i = Math.floor(x / 20) - 1; i <= Math.floor(x / 20) + 1; i++) {
      for (let j = Math.floor(z / 20) - 1; j <= Math.floor(z / 20) + 1; j++) {
        for (const [[ax, az], [bx, bz]] of this.cells.get(`${i},${j}`) ?? []) {
          const ex = bx - ax, ez = bz - az, len2 = ex * ex + ez * ez || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
          best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
        }
      }
    }
    return best;
  }
}

/** The track graph, ready for building squares from: its links, each once (a twin left out), and where tracks lie. */
export class Rails {
  readonly links: Link[];
  private readonly grid: TrackGrid;

  constructor(links: Link[]) {
    this.links = links.filter((l) => l.twin === null || l.id < l.twin);
    this.grid = new TrackGrid(links);
  }

  /**
   * The rails, the setts, the wire and the poles in the square `rect`, at street level `y`, into `s`; the poles'
   * colliders made with `physics` and handed back, to be taken away with the square.
   */
  build(s: Section, physics: Physics, rect: Rect, y: number): StaticCollider[] {
    const colliders: StaticCollider[] = [];
    const g = TRAM_GAUGE / 2;
    // Strips across a track, from its middle: [from, to, height, paint].
    const strips: Array<[number, number, number, Paint]> = [
      [-g - TRAM_RAIL.head - BED_OUT, g + TRAM_RAIL.head + BED_OUT, BED_Y, SETTS],
      [-g - TRAM_RAIL.head, -g, HEAD_Y, STEEL],
      [-g, -g + TRAM_RAIL.groove, HEAD_Y - 0.004, GROOVE],
      [g - TRAM_RAIL.groove, g, HEAD_Y - 0.004, GROOVE],
      [g, g + TRAM_RAIL.head, HEAD_Y, STEEL],
    ];
    for (const l of this.links) {
      const pts = l.pts;
      // The segments whose middle lies in this square.
      const mine: number[] = [];
      for (let i = 0; i + 1 < pts.length; i++) if (inside(rect, (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2)) mine.push(i);
      if (mine.length) {
        for (const [o0, o1, h, paint] of strips) {
          const left = offset(pts, o0), right = offset(pts, o1);
          for (const i of mine) {
            // Wound to face up (right to left along the track), as the light is baked by the face's normal.
            s.lit.quad(new Vector3(right[i][0], y + h, right[i][1]), new Vector3(right[i + 1][0], y + h, right[i + 1][1]),
              new Vector3(left[i + 1][0], y + h, left[i + 1][1]), new Vector3(left[i][0], y + h, left[i][1]), paint);
          }
        }
        // The contact wire: a thin ribbon flat and one on edge, so it shows from below and from the side.
        const w0 = offset(pts, -WIRE_T / 2), w1 = offset(pts, WIRE_T / 2);
        const top = y + TRAM_WIRE + WIRE_T;
        for (const i of mine) {
          const [a, b] = [pts[i], pts[i + 1]];
          s.lit.quad(new Vector3(w0[i][0], top, w0[i][1]), new Vector3(w0[i + 1][0], top, w0[i + 1][1]), new Vector3(w1[i + 1][0], top, w1[i + 1][1]), new Vector3(w1[i][0], top, w1[i][1]), WIRE);
          s.lit.quad(new Vector3(a[0], top - WIRE_T * 1.5, a[1]), new Vector3(b[0], top - WIRE_T * 1.5, b[1]), new Vector3(b[0], top + WIRE_T * 0.5, b[1]), new Vector3(a[0], top + WIRE_T * 0.5, a[1]), WIRE);
        }
      }
      this.poles(s, physics, l, rect, y, colliders);
    }
    return colliders;
  }

  /** The poles along a link in this square: on the side away from other tracks, an arm out over the wire. */
  private poles(s: Section, physics: Physics, l: Link, rect: Rect, y: number, colliders: StaticCollider[]): void {
    if (l.length < 2 * POLE_KEEP) return;
    let along = 0, next = POLE_KEEP + (Math.abs(l.id * 7.3) % POLE_EVERY) / 2;
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [a, b] = [l.pts[i], l.pts[i + 1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (next <= along + len && next <= l.length - POLE_KEEP) {
        const t = (next - along) / len;
        const [x, z] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const [nx, nz] = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        // The side with no other track near; none if there is a track either side (between two pairs).
        const side = [1, -1].find((k) => this.grid.distance(x + nx * k * POLE_OUT, z + nz * k * POLE_OUT) > POLE_OUT - 0.2);
        const [px, pz] = side ? [x + nx * side * POLE_OUT, z + nz * side * POLE_OUT] : [0, 0];
        if (side && inside(rect, px, pz)) {
          const height = TRAM_WIRE + 1.1;
          s.lit.box({ x: px - POLE_HALF, y: y - 0.05, z: pz - POLE_HALF }, { x: px + POLE_HALF, y: y + height, z: pz + POLE_HALF }, POLE, [], 2);
          // The arm, out to over the track, and the wire's hanger down from it.
          const [ex, ez] = [x - nx * side * 0.1, z - nz * side * 0.1];
          const armY = y + TRAM_WIRE + 0.75;
          beam(s.lit, new Vector3(px, armY, pz), new Vector3(ex, armY, ez), 0.09, POLE);
          s.lit.box({ x: x - 0.015, y: y + TRAM_WIRE, z: z - 0.015 }, { x: x + 0.015, y: armY, z: z + 0.015 }, WIRE, [], 2);
          colliders.push(physics.box({ x: px - POLE_HALF, y, z: pz - POLE_HALF }, { x: px + POLE_HALF, y: y + 3, z: pz + POLE_HALF }));
        }
        next += POLE_EVERY;
      }
      along += len;
    }
  }
}
