/**
 * A route's shape from the timetable (GTFS `shapes.txt`) laid on the tram tracks (`src/game/city/trackData.ts`): which
 * links a tram on it runs along, and from where to where. Map matching in the usual way (a hidden Markov model, after
 * Newson and Krumm): the shape is sampled every few meters, each sample has the places on the tracks near it, running
 * its way, as candidates, and the most likely sequence of candidates is found (Viterbi), likely where a candidate lies
 * close to its sample and where the track from one candidate to the next is as long as the shape between their samples.
 * Västtrafik's shapes follow the tracks to within a few meters, so this mostly decides which of two tracks side by
 * side, and which way through a junction.
 */
import type { Pt, Rect } from '../src/game/city/geo';
import { polylineLength, type Link } from '../src/game/city/trackData';
import { clipLine } from './osm-layers';

/** Samples this far apart along the shape. */
const STEP = 5;
/** Places on the tracks this close to a sample are its candidates. */
const REACH = 12;
/** How far the shape strays from the track, typically, and how much track and shape lengths may differ, in meters. */
const SIGMA = 4;
const BETA = 3;
/** How many samples in a row may be unreachable before a run is broken there (`matchPiece`). */
const SPIKE = 3;
/** Pieces of shape shorter than this inside the area are left out: a corner clipped, not a run. */
const SHORTEST = 40;

export interface Matched {
  links: number[];
  /** Meters into the first link the run starts at, and into the last that it ends at. */
  from: number;
  to: number;
  /** Where along the whole shape (meters from its start) the run starts and ends. */
  u0: number;
  u1: number;
  /** The candidates' distance from the shape: the largest, for the report. */
  worst: number;
}

interface Candidate { link: number; s: number; d: number }

/** The way from the end of each link to the start of every link within `limit` meters on, and the links passed. */
function reaches(links: Link[], limit: number): Array<Map<number, { d: number; via: number[] }>> {
  return links.map((start) => {
    const out = new Map<number, { d: number; via: number[] }>();
    const queue: Array<{ id: number; d: number; via: number[] }> = start.next.map((id) => ({ id, d: 0, via: [] }));
    while (queue.length) {
      queue.sort((a, b) => a.d - b.d);
      const { id, d, via } = queue.shift()!;
      if (out.has(id) && out.get(id)!.d <= d) continue;
      out.set(id, { d, via });
      const on = d + links[id].length;
      if (on < limit) for (const n of links[id].next) queue.push({ id: n, d: on, via: [...via, id] });
    }
    return out;
  });
}

export class Matcher {
  /** Where along the shapes matched so far a run had to end for want of track: for the report. */
  readonly gaps: Pt[] = [];
  private readonly ahead: Array<Map<number, { d: number; via: number[] }>>;
  private readonly grid = new Map<string, Array<{ link: number; i: number; s: number }>>();

  constructor(private readonly links: Link[], private readonly keep: Rect) {
    this.ahead = reaches(links, 4 * STEP + 60);
    for (const l of links) {
      let s = 0;
      for (let i = 0; i + 1 < l.pts.length; i++) {
        const seg = Math.hypot(l.pts[i + 1][0] - l.pts[i][0], l.pts[i + 1][1] - l.pts[i][1]);
        // A segment goes in every cell it passes through (they can be long: straight track keeps few points).
        const n = Math.max(1, Math.ceil(seg / REACH));
        const cells = new Set<string>();
        for (let k = 0; k <= n; k++) {
          const x = l.pts[i][0] + ((l.pts[i + 1][0] - l.pts[i][0]) * k) / n, z = l.pts[i][1] + ((l.pts[i + 1][1] - l.pts[i][1]) * k) / n;
          cells.add(`${Math.floor(x / REACH)},${Math.floor(z / REACH)}`);
        }
        for (const c of cells) {
          if (!this.grid.has(c)) this.grid.set(c, []);
          this.grid.get(c)!.push({ link: l.id, i, s });
        }
        s += seg;
      }
    }
  }

  /** The places on the tracks near `p`, running in direction `dir`: the nearest on each link. */
  private candidates(p: Pt, dir: Pt): Candidate[] {
    const best = new Map<number, Candidate>();
    const [cx, cz] = [Math.floor(p[0] / REACH), Math.floor(p[1] / REACH)];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const { link, i, s } of this.grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const [a, b] = [this.links[link].pts[i], this.links[link].pts[i + 1]];
          const ex = b[0] - a[0], ez = b[1] - a[1], len = Math.hypot(ex, ez);
          if (len < 1e-6 || (ex * dir[0] + ez * dir[1]) / len < 0.6) continue;
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / (len * len)));
          const d = Math.hypot(a[0] + ex * t - p[0], a[1] + ez * t - p[1]);
          if (d > REACH) continue;
          const cur = best.get(link);
          if (!cur || d < cur.d) best.set(link, { link, s: s + t * len, d });
        }
      }
    }
    return [...best.values()];
  }

  /** Track meters from one candidate to the next, along the way a tram may run, or Infinity; and the links between. */
  private between(a: Candidate, b: Candidate): { d: number; via: number[] } {
    if (a.link === b.link && b.s >= a.s - 0.5) return { d: Math.max(0, b.s - a.s), via: [] };
    const on = this.ahead[a.link].get(b.link);
    if (!on) return { d: Infinity, via: [] };
    return { d: this.links[a.link].length - a.s + on.d + b.s, via: on.via };
  }

  /** The runs of a shape (in the city frame) through the area: one for each piece of it inside, matched to the tracks. */
  match(shape: Pt[]): Matched[] {
    const out: Matched[] = [];
    // Where each piece starts along the whole shape.
    const along: number[] = [0];
    for (let i = 1; i < shape.length; i++) along.push(along[i - 1] + Math.hypot(shape[i][0] - shape[i - 1][0], shape[i][1] - shape[i - 1][1]));
    const { x0, x1, z0, z1 } = this.keep;
    for (const piece of clipLine(shape, x0, x1, z0, z1)) {
      const length = polylineLength(piece);
      if (length < SHORTEST) continue;
      out.push(...this.matchPiece(piece, nearestAlong(shape, along, piece[0])));
    }
    return out;
  }

  /**
   * The runs along one piece of shape inside the area. Where no candidate can be reached from any before it (track the
   * graph lacks, or a turn it does not allow) the run ends there and a new one begins, and the gap is noted in `gaps`.
   */
  private matchPiece(piece: Pt[], u0: number): Matched[] {
    const length = polylineLength(piece);
    const n = Math.max(2, Math.round(length / STEP));
    const samples: Array<{ p: Pt; dir: Pt; u: number }> = [];
    for (let k = 0; k <= n; k++) {
      const u = (length * k) / n;
      const p = at(piece, u), q = at(piece, Math.min(length, u + 2)), r = at(piece, Math.max(0, u - 2));
      const dx = q[0] - r[0], dz = q[1] - r[1], d = Math.hypot(dx, dz) || 1;
      samples.push({ p, dir: [dx / d, dz / d], u });
    }
    const out: Matched[] = [];
    type Layer = { cands: Candidate[]; cost: number[]; back: number[]; u: number };
    let layers: Layer[] = [];
    /** Samples in a row none of whose candidates could be reached: a few are a spike in the shape, more a gap. */
    let unreached = 0;
    const finish = () => {
      if (layers.length >= 2) {
        const run = this.trace(layers);
        out.push({ ...run, u0: u0 + layers[0].u, u1: u0 + layers[layers.length - 1].u });
      }
    };
    for (let k = 0; k <= n; k++) {
      const cs = this.candidates(samples[k].p, samples[k].dir);
      // A sample with no candidate is skipped: the shape strays there.
      if (!cs.length) continue;
      const emit = cs.map((c) => (c.d * c.d) / (2 * SIGMA * SIGMA));
      const prev = layers[layers.length - 1];
      if (!prev) {
        layers.push({ cands: cs, cost: emit, back: cs.map(() => -1), u: samples[k].u });
        continue;
      }
      const du = samples[k].u - prev.u;
      const cost: number[] = [], back: number[] = [];
      for (let j = 0; j < cs.length; j++) {
        let best = Infinity, from = -1;
        for (let i = 0; i < prev.cands.length; i++) {
          const d = this.between(prev.cands[i], cs[j]).d;
          if (d === Infinity) continue;
          const c = prev.cost[i] + Math.abs(d - du) / BETA + emit[j];
          if (c < best) [best, from] = [c, i];
        }
        cost.push(best);
        back.push(from);
      }
      if (cost.every((c) => c === Infinity)) {
        // No way on from any candidate. A sample or three is a spike in the shape (some double back on themselves for a
        // few meters): skipped. More, and the run ends at the last sample reached and a new one begins here.
        if (++unreached <= SPIKE) continue;
        unreached = 0;
        this.gaps.push(samples[k].p);
        finish();
        layers = [{ cands: cs, cost: emit, back: cs.map(() => -1), u: samples[k].u }];
        continue;
      }
      unreached = 0;
      layers.push({ cands: cs, cost, back, u: samples[k].u });
    }
    finish();
    return out;
  }

  /** The links and ends of the cheapest way through the layers, traced back from the cheapest last candidate. */
  private trace(layers: Array<{ cands: Candidate[]; cost: number[]; back: number[] }>): Omit<Matched, 'u0' | 'u1'> {
    const last = layers[layers.length - 1];
    let j = last.cost.indexOf(Math.min(...last.cost));
    const chosen: Candidate[] = [];
    for (let k = layers.length - 1; k >= 0; k--) {
      chosen.push(layers[k].cands[j]);
      j = layers[k].back[j];
    }
    chosen.reverse();
    const links: number[] = [chosen[0].link];
    for (let k = 1; k < chosen.length; k++) {
      const { via } = this.between(chosen[k - 1], chosen[k]);
      for (const id of [...via, chosen[k].link]) if (links[links.length - 1] !== id) links.push(id);
    }
    const first = this.links[links[0]], end = this.links[links[links.length - 1]];
    // A run that comes in over the edge starts where its first link does; one that starts at a terminus, at the stop.
    const from = first.from < 0 ? 0 : chosen[0].s;
    const to = end.to < 0 ? end.length : chosen[chosen.length - 1].s;
    return { links, from, to, worst: Math.max(...chosen.map((c) => c.d)) };
  }
}

/** The point `u` meters along a polyline. */
function at(pts: Pt[], u: number): Pt {
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (u <= d) return d > 0 ? [pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * u) / d, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * u) / d] : pts[i];
    u -= d;
  }
  return pts[pts.length - 1];
}

/** How far along a polyline (with `along` its points' distances) the point nearest `p` lies. */
export function nearestAlong(pts: Pt[], along: number[], p: Pt, after = 0): number {
  let best = Infinity, u = after;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (along[i + 1] < after) continue;
    const [a, b] = [pts[i], pts[i + 1]];
    const ex = b[0] - a[0], ez = b[1] - a[1], len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / len2)) : 0;
    const d = Math.hypot(a[0] + ex * t - p[0], a[1] + ez * t - p[1]);
    const v = along[i] + t * Math.sqrt(len2);
    if (d < best && v >= after) [best, u] = [d, v];
  }
  return u;
}
