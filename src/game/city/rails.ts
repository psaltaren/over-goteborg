// The tram tracks in the street, built into each square of the city (`tiles.ts`) from the track graph (`tracks.json`):
// two grooved rails a track, sunk in a strip of setts as Drottningtorget has them, and over it the contact wire the
// pantographs reach up to, hung from poles beside the track with an arm out over it. A segment of track is built by the
// square its middle lies in, so the squares meet without a seam or a doubled rail; a track that runs both ways (a twin)
// once. Into the square's lit layer, so the street lamps' light is baked in. What does not depend on the square (each
// track's strips, where its poles stand) is worked out once, when the tracks arrive, so a square takes only its own.

import { BoxGeometry, Matrix4, Vector3 } from 'three';
import type { MeshBuilder, Paint } from '../gfx/builder';
import { rgb } from '../gfx/color';
import { TRAM_GAUGE, TRAM_POLES, TRAM_RAIL, TRAM_WIRE } from '../layout';
import type { Physics, StaticCollider } from '../physics';
import type { Section } from '../world/section';
import type { Pt, Rect } from './geo';
import type { Link } from './trackData';
import { TrackIndex } from './trackIndex';

const SETTS = rgb(0x9b958b);
const STEEL = rgb(0xc3c6c9);
const GROOVE = rgb(0x1c1d1e);
const WIRE = rgb(0x26292b);
const POLE = rgb(0x4d5753);

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
const meets = (a: Rect, b: Rect) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1;

/** A level beam from `a` to `b`, `t` thick, whichever way it runs. */
function beam(out: MeshBuilder, a: Vector3, b: Vector3, t: number, paint: Paint): void {
  const geo = new BoxGeometry(a.distanceTo(b), t, t);
  const m = new Matrix4().makeRotationY(Math.atan2(-(b.z - a.z), b.x - a.x)).setPosition(a.clone().add(b).multiplyScalar(0.5));
  out.geometry(geo, m, paint);
  geo.dispose();
}

/** A track as the squares take it: its points, how far it reaches, and its strips across (rails, setts, wire) as polylines. */
interface Track {
  pts: Pt[];
  box: Rect;
  /** Each strip: its two edges, its height over the street, and its paint. */
  strips: Array<{ left: Pt[]; right: Pt[]; y: number; paint: Paint }>;
  wire: { left: Pt[]; right: Pt[] };
}

/** A pole: where it stands, and the point over the track its arm reaches to. */
interface Pole {
  x: number;
  z: number;
  over: Pt;
}

/** The track graph, ready for building squares from. */
export class Rails {
  private readonly tracks: Track[] = [];
  private readonly poleList: Pole[] = [];

  constructor(links: Link[]) {
    const index = new TrackIndex(links);
    const g = TRAM_GAUGE / 2, { head, groove, y, bed, bedY } = TRAM_RAIL;
    // Strips across a track, from its middle: [from, to, height, paint].
    const strips: Array<[number, number, number, Paint]> = [
      [-g - head - bed, g + head + bed, bedY, SETTS],
      [-g - head, -g, y, STEEL],
      [-g, -g + groove, y - 0.004, GROOVE],
      [g - groove, g, y - 0.004, GROOVE],
      [g, g + head, y, STEEL],
    ];
    // Each track once: a track that runs both ways is two links, twins, on the same rails.
    for (const l of links.filter((x) => x.twin === null || x.id < x.twin)) {
      const xs = l.pts.map((p) => p[0]), zs = l.pts.map((p) => p[1]);
      const reach = TRAM_POLES.out + 1;
      this.tracks.push({
        pts: l.pts,
        box: { x0: Math.min(...xs) - reach, x1: Math.max(...xs) + reach, z0: Math.min(...zs) - reach, z1: Math.max(...zs) + reach },
        strips: strips.map(([o0, o1, h, paint]) => ({ left: offset(l.pts, o0), right: offset(l.pts, o1), y: h, paint })),
        wire: { left: offset(l.pts, -TRAM_POLES.wire / 2), right: offset(l.pts, TRAM_POLES.wire / 2) },
      });
      this.placePoles(l, index);
    }
  }

  /** Where a link's poles stand: one every `TRAM_POLES.every` meters, on the side away from other tracks. */
  private placePoles(l: Link, index: TrackIndex): void {
    const { every, keep, out } = TRAM_POLES;
    if (l.length < 2 * keep) return;
    // Started a little apart per link, so the poles of two tracks side by side do not stand in pairs.
    let along = 0, next = keep + (Math.abs(l.id * 7.3) % every) / 2;
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [a, b] = [l.pts[i], l.pts[i + 1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (; next <= along + len && next <= l.length - keep; next += every) {
        const t = (next - along) / len;
        const [x, z] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const [nx, nz] = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        // The side with no other track near; none if there is a track either side (between two pairs).
        const side = [1, -1].find((k) => index.distance(x + nx * k * out, z + nz * k * out) > out - 0.2);
        if (side) this.poleList.push({ x: x + nx * side * out, z: z + nz * side * out, over: [x - nx * side * 0.1, z - nz * side * 0.1] });
      }
      along += len;
    }
  }

  /**
   * The rails, the setts, the wire and the poles in the square `rect`, at street level `y`, into `s`; the poles'
   * colliders made with `physics` and handed back, to be taken away with the square. A step for each track laid, so the
   * busiest square (Drottningtorget's, 4 ms here) is built over a few frames, not in one.
   */
  *buildSteps(s: Section, physics: Physics, rect: Rect, y: number): Generator<void, StaticCollider[]> {
    const v = (p: Pt, h: number) => new Vector3(p[0], y + h, p[1]);
    const top = TRAM_WIRE + TRAM_POLES.wire;
    for (const track of this.tracks) {
      if (!meets(track.box, rect)) continue;
      const pts = track.pts;
      let laid = false;
      for (let i = 0; i + 1 < pts.length; i++) {
        if (!inside(rect, (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2)) continue;
        laid = true;
        // Wound to face up (right to left along the track), as the light is baked by the face's normal.
        for (const { left, right, y: h, paint } of track.strips) s.lit.quad(v(right[i], h), v(right[i + 1], h), v(left[i + 1], h), v(left[i], h), paint);
        // The contact wire: a thin ribbon flat and one on edge, so it shows from below and from the side.
        const { left, right } = track.wire;
        s.lit.quad(v(left[i], top), v(left[i + 1], top), v(right[i + 1], top), v(right[i], top), WIRE);
        s.lit.quad(v(pts[i], top - TRAM_POLES.wire * 1.5), v(pts[i + 1], top - TRAM_POLES.wire * 1.5), v(pts[i + 1], top + TRAM_POLES.wire * 0.5), v(pts[i], top + TRAM_POLES.wire * 0.5), WIRE);
      }
      if (laid) yield;
    }
    const colliders: StaticCollider[] = [];
    const { half } = TRAM_POLES;
    for (const p of this.poleList) {
      if (!inside(rect, p.x, p.z)) continue;
      s.lit.box({ x: p.x - half, y: y - 0.05, z: p.z - half }, { x: p.x + half, y: y + TRAM_WIRE + 1.1, z: p.z + half }, POLE, [], 2);
      // The arm, out to over the track, and the wire's hanger down from it.
      const armY = y + TRAM_WIRE + 0.75;
      beam(s.lit, new Vector3(p.x, armY, p.z), new Vector3(p.over[0], armY, p.over[1]), 0.09, POLE);
      s.lit.box({ x: p.over[0] - 0.015, y: y + TRAM_WIRE, z: p.over[1] - 0.015 }, { x: p.over[0] + 0.015, y: armY, z: p.over[1] + 0.015 }, WIRE, [], 2);
      colliders.push(physics.box({ x: p.x - half, y, z: p.z - half }, { x: p.x + half, y: y + 3, z: p.z + half }));
    }
    return colliders;
  }
}
