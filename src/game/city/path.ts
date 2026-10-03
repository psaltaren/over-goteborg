// A run's track as the trams follow it: one polyline in the city frame with the meters along it worked out once, so
// a point is a binary search rather than a walk (`RunPath` in `schedule.ts` walks, which the scripts can afford and a
// frame of thirty trams cannot). Past either end the track goes on straight, out of sight, so a tram coming in or going
// out keeps its whole length on it. A tram's sections hang between points on the path (`sections`): each section's
// two ends on the track, so the articulations meet round a curve. No three.js.

import { TRAM_SECTION_ENDS } from '../layout';
import type { Pt } from './geo';
import { runPieces, type Run } from './schedule';
import { pointAt, type Link } from './trackData';

/** One section of a tram: its middle in the plane and the way it faces (unit vector, along the run). */
export interface SectionPose {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

export class TramPath {
  /** The points, and how far along the run each lies. */
  private readonly xs: number[] = [];
  private readonly zs: number[] = [];
  private readonly at: number[] = [];
  readonly length: number;

  constructor(run: Run, links: Link[]) {
    for (const p of runPieces(run, links)) {
      const pts = links[p.link].pts;
      // Meters along the link of each of its points, to take those between s0 and s1.
      let along = 0;
      this.add(p.at, pointAt(pts, p.s0));
      for (let i = 1; i < pts.length; i++) {
        along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (along > p.s0 + 1e-6 && along < p.s1 - 1e-6) this.add(p.at + along - p.s0, pts[i]);
      }
      this.add(p.at + p.s1 - p.s0, pointAt(pts, p.s1));
    }
    this.length = this.at[this.at.length - 1] ?? 0;
  }

  private add(s: number, [x, z]: Pt): void {
    const n = this.at.length;
    // A point where a piece ends and the next begins, once.
    if (n && s - this.at[n - 1] < 1e-6) return;
    this.xs.push(x);
    this.zs.push(z);
    this.at.push(s);
  }

  /** The index of the segment that holds `s`: the last point at or before it, within [0, n - 2]. */
  private segment(s: number): number {
    let lo = 0, hi = this.at.length - 2;
    if (s <= this.at[0]) return 0;
    if (s >= this.at[hi]) return hi;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.at[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The point `s` meters along, the track's last segment carried on straight past either end. */
  point(s: number): Pt {
    const i = this.segment(s);
    const a = this.at[i], b = this.at[i + 1];
    const t = b > a ? (s - a) / (b - a) : 0;
    return [this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t, this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t];
  }

  /** The way the track runs at `s`: a unit vector. */
  direction(s: number): Pt {
    const i = this.segment(s);
    const dx = this.xs[i + 1] - this.xs[i], dz = this.zs[i + 1] - this.zs[i];
    const len = Math.hypot(dx, dz) || 1;
    return [dx / len, dz / len];
  }

  /**
   * A tram's sections, front first, its front `s` meters along: each section from `ends[k]` to `ends[k + 1]` meters
   * behind the front, its middle halfway between its two ends on the track and facing from the rear one to the front.
   */
  sections(s: number, ends: readonly number[], out: SectionPose[] = []): SectionPose[] {
    let [fx, fz] = this.point(s - ends[0]);
    for (let k = 0; k + 1 < ends.length; k++) {
      const [rx, rz] = this.point(s - ends[k + 1]);
      const dx = fx - rx, dz = fz - rz;
      const len = Math.hypot(dx, dz) || 1;
      const pose = (out[k] ??= { x: 0, z: 0, dx: 1, dz: 0 });
      pose.x = (fx + rx) / 2;
      pose.z = (fz + rz) / 2;
      pose.dx = dx / len;
      pose.dz = dz / len;
      fx = rx;
      fz = rz;
    }
    out.length = ends.length - 1;
    return out;
  }
}


/** Whether a tram's `k`th section, its front `s` meters along a run `length` long, lies wholly on the run's track. */
export function onTrack(s: number, k: number, length: number, ends: readonly number[] = TRAM_SECTION_ENDS): boolean {
  return s - ends[k + 1] >= 0 && s - ends[k] <= length;
}
