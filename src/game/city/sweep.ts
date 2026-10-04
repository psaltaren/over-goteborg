// Shapes swept along a line that turns and climbs: Västlänken's tunnel from Centralen to Haga (`underground.ts`), whose
// line OSM gives (`osm/underground.json`). Joel's tubes run straight along x; this lays a cross-section along any line,
// a quad between each two frames, and colliders as boxes turned to each stretch. No three.js beyond the vector type.

import { Vector3 } from 'three';
import type { MeshBuilder, Paint } from '../gfx/builder';
import type { Physics, StaticCollider } from '../physics';
import type { Pt } from './geo';

/** A place on the line: where (y the rail top there), which way it runs (t), the way to its left (n), how far along (s). */
export interface Frame {
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  s: number;
}

/** A point of a cross-section: `u` meters to the left of the line, `v` above its rail top. */
export type Cross = [u: number, v: number];

export class Spine {
  private readonly pts: Pt[];
  private readonly at0: number[] = [0];
  readonly length: number;

  /** @param height the rail top at `s` meters along. */
  constructor(pts: Pt[], private readonly height: (s: number) => number) {
    this.pts = pts;
    for (let i = 1; i < pts.length; i++) this.at0.push(this.at0[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.length = this.at0[this.at0.length - 1];
  }

  /** The frame `s` meters along (clamped to the line), its direction the average of the stretches either side of a point. */
  frame(s: number): Frame {
    const c = Math.max(0, Math.min(this.length, s));
    let i = 1;
    while (i < this.at0.length - 1 && this.at0[i] < c) i++;
    const [a, b] = [this.pts[i - 1], this.pts[i]];
    const t = (c - this.at0[i - 1]) / (this.at0[i] - this.at0[i - 1] || 1);
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    // The direction blends from the stretch before to the one after across each point, so the walls bend smoothly.
    const dir = (k: number): Pt => {
      const p = this.pts[Math.max(0, Math.min(this.pts.length - 2, k))], q = this.pts[Math.max(1, Math.min(this.pts.length - 1, k + 1))];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
    };
    const here = dir(i - 1), before = dir(i - 2), after = dir(i);
    const w = t < 0.5 ? 0.5 - t : t - 0.5;
    const other = t < 0.5 ? before : after;
    let tx = here[0] * (1 - w) + other[0] * w, tz = here[1] * (1 - w) + other[1] * w;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    // Left, looking along the line: x toward the left is -z in the game's frame (z lies to the right of x).
    return { x, y: this.height(c), z, tx, tz, nx: tz, nz: -tx, s: c };
  }

  /** Frames from `s0` to `s1`, about `step` meters apart, both ends included. */
  frames(s0: number, s1: number, step = 5): Frame[] {
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    return Array.from({ length: n + 1 }, (_, k) => this.frame(s0 + ((s1 - s0) * k) / n));
  }

  /** How far along the line the point nearest (`x`, `z`) lies, and how far from it. */
  locate(x: number, z: number): { s: number; d: number } {
    let best = { s: 0, d: Infinity };
    for (let i = 1; i < this.pts.length; i++) {
      const [a, b] = [this.pts[i - 1], this.pts[i]];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2));
      const d = Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
      if (d < best.d) best = { s: this.at0[i - 1] + t * Math.sqrt(len2), d };
    }
    return best;
  }
}

/** A cross-section point placed in the world on a frame. */
export const place = (f: Frame, [u, v]: Cross, out = new Vector3()): Vector3 => out.set(f.x + f.nx * u, f.y + v, f.z + f.nz * u);

const ab = new Vector3();
const ad = new Vector3();
const want = new Vector3();

/**
 * The strip a cross-section's edge from `a` to `b` sweeps between the frames, facing `facing` (a direction in the
 * cross-section: [toward the left, up]); split across into cells no wider than `cell` meters, for the baked light.
 */
export function sweep(b: MeshBuilder, frames: Frame[], a: Cross, z: Cross, paint: Paint, facing: Cross, cell = 3): void {
  if (b.dry) return;
  const parts = Math.max(1, Math.ceil(Math.hypot(z[0] - a[0], z[1] - a[1]) / cell));
  for (let i = 1; i < frames.length; i++) {
    const f0 = frames[i - 1], f1 = frames[i];
    for (let k = 0; k < parts; k++) {
      const c0: Cross = [a[0] + ((z[0] - a[0]) * k) / parts, a[1] + ((z[1] - a[1]) * k) / parts];
      const c1: Cross = [a[0] + ((z[0] - a[0]) * (k + 1)) / parts, a[1] + ((z[1] - a[1]) * (k + 1)) / parts];
      const p = place(f0, c0), q = place(f1, c0), r = place(f1, c1), s = place(f0, c1);
      want.set(f0.nx * facing[0], facing[1], f0.nz * facing[0]);
      const n = ab.subVectors(q, p).cross(ad.subVectors(s, p));
      if (n.dot(want) < 0) b.quad(p, s, r, q, paint);
      else b.quad(p, q, r, s, paint);
    }
  }
}

/** A whole cross-section (a closed or open list of points) swept, each edge facing `inward` toward the line's middle. */
export function sweepSection(b: MeshBuilder, frames: Frame[], profile: Cross[], paint: Paint, middle: Cross, cell = 3): void {
  for (let i = 1; i < profile.length; i++) {
    const [a, z] = [profile[i - 1], profile[i]];
    const mid: Cross = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2];
    sweep(b, frames, a, z, paint, [middle[0] - mid[0], middle[1] - mid[1]], cell);
  }
}

/**
 * A box along the line: from `u0` to `u1` across and `v0` to `v1` up, from frame to frame in stretches about `stretch`
 * meters long (each a box turned to its chord, a little longer, so they overlap at the bends).
 */
export function sweptBoxes(physics: Physics, frames: Frame[], u0: number, u1: number, v0: number, v1: number, stretch = 15): StaticCollider[] {
  const out: StaticCollider[] = [];
  const every = Math.max(1, Math.round(stretch / Math.max(0.5, frames.length > 1 ? frames[1].s - frames[0].s : stretch)));
  for (let i = 0; i < frames.length - 1; i += every) {
    const a = frames[i], b = frames[Math.min(frames.length - 1, i + every)];
    const um = (u0 + u1) / 2;
    const ax = a.x + a.nx * um, az = a.z + a.nz * um, bx = b.x + b.nx * um, bz = b.z + b.nz * um;
    const len = Math.hypot(bx - ax, bz - az);
    const y = (a.y + b.y) / 2;
    out.push(physics.turnedBox(
      { x: (ax + bx) / 2, y: y + (v0 + v1) / 2, z: (az + bz) / 2 },
      { x: len / 2 + 0.3, y: (v1 - v0) / 2, z: (u1 - u0) / 2 },
      // turnedBox turns a box along x about y: to this stretch's heading.
      Math.atan2(-(bz - az), bx - ax),
    ));
  }
  return out;
}
