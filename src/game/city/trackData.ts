// The tram tracks as `scripts/gbg-osm.ts` writes them (`city/osm/tracks.json`): a directed graph of links, each a
// polyline in the city frame (`geo.ts`) that a tram runs along one way, with the links it may go on to at its end,
// and the blocks no two trams may be in at once. Shared by the data scripts, the tests and the game; no three.js.

import { TRAM_MIN_RADIUS } from '../layout';
import type { Pt } from './geo';

/** The narrowest curve a tram takes, in meters (`layout.ts`). */
export const MIN_RADIUS = TRAM_MIN_RADIUS;
/** Curves are measured over this far either side of a point, about a bogie's length. */
export const CHORD = 3;

export interface Link {
  id: number;
  /** The OSM ways it was drawn from, in order. */
  ways: number[];
  /**
   * The junction it starts and ends at: an OSM node, or where a switch's toe was moved back from one (`TOE_NODE` times
   * the toes moved from that node so far, plus the node), or -1 where it runs out of the area.
   */
  from: number;
  to: number;
  /** The same track the other way, for the few tracks run both ways. */
  twin: number | null;
  /** The links a tram may go on to at its end. */
  next: number[];
  length: number;
  pts: Pt[];
}

export interface Stop {
  name: string;
  /** The OSM node of the stop (`railway=tram_stop`). */
  osm: number;
  link: number;
  s: number;
  /** How far the node lies from the track as eased, in meters. */
  off: number;
}

/**
 * A short stretch of track that holds one tram at a time, as [link, from s, to s]: on its link, and on its twin where
 * the track is run both ways. Blocks listed in the file's `conflicts` cannot hold trams at once either (a switch, a
 * crossing).
 */
export interface Block {
  id: number;
  spans: Array<[number, number, number]>;
}

export interface TrackFile {
  license: string;
  format: string;
  links: Array<Omit<Link, 'pts'> & { pts: number[] }>;
  stops: Stop[];
  blocks: Block[];
  /** Pairs of blocks that cannot hold trams at once, the lower id first. */
  conflicts: Array<[number, number]>;
}

/** Points in centimeters, the first as it is and each next from the one before. */
export function packCm(pts: Pt[]): number[] {
  const cm = pts.map(([x, z]) => [Math.round(x * 100), Math.round(z * 100)]);
  return cm.flatMap(([x, z], i) => (i === 0 ? [x, z] : [x - cm[i - 1][0], z - cm[i - 1][1]]));
}

export function unpackCm(list: number[]): Pt[] {
  const out: Pt[] = [];
  let x = 0, z = 0;
  for (let i = 0; i + 1 < list.length; i += 2) {
    x += list[i];
    z += list[i + 1];
    out.push([x / 100, z / 100]);
  }
  return out;
}

/** The links of a track file, with their points unpacked. */
export const readLinks = (file: TrackFile): Link[] => file.links.map((l) => ({ ...l, pts: unpackCm(l.pts) }));

export function polylineLength(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return s;
}

/** The point `s` meters along a polyline, held at its ends. */
export function pointAt(pts: Pt[], s: number): Pt {
  if (s <= 0) return pts[0];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const d = Math.hypot(bx - ax, bz - az);
    if (s <= d) return d > 0 ? [ax + ((bx - ax) * s) / d, az + ((bz - az) * s) / d] : [ax, az];
    s -= d;
  }
  return pts[pts.length - 1];
}

/** The polyline again with a point every `step` meters (the last step shorter), its ends kept exactly. */
export function resample(pts: Pt[], step = 1): Pt[] {
  const length = polylineLength(pts);
  const n = Math.max(1, Math.round(length / step));
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push(pointAt(pts, (length * k) / n));
  out[0] = pts[0];
  out[n] = pts[pts.length - 1];
  return out;
}

/** The radius of the circle through three points (infinite on a straight line). */
export function radius(a: Pt, b: Pt, c: Pt): number {
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(cross) < 1e-9) return Infinity;
  return (Math.hypot(b[0] - c[0], b[1] - c[1]) * Math.hypot(a[0] - c[0], a[1] - c[1]) * Math.hypot(a[0] - b[0], a[1] - b[1])) / (2 * Math.abs(cross));
}

/** The direction a polyline sets off in at its start, over its first `over` meters. */
export function startDir(pts: Pt[], over = 6): Pt {
  const [ax, az] = pts[0], [bx, bz] = pointAt(pts, Math.min(over, polylineLength(pts)));
  const d = Math.hypot(bx - ax, bz - az) || 1;
  return [(bx - ax) / d, (bz - az) / d];
}

/** The direction a polyline runs in at its end, over its last `over` meters. */
export function endDir(pts: Pt[], over = 6): Pt {
  const length = polylineLength(pts);
  const [ax, az] = pointAt(pts, Math.max(0, length - over)), [bx, bz] = pts[pts.length - 1];
  const d = Math.hypot(bx - ax, bz - az) || 1;
  return [(bx - ax) / d, (bz - az) / d];
}

/** The angle between two directions, in degrees. */
export const turn = (a: Pt, b: Pt) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;

/** For each link, the links a tram may come to it from. */
export const prevsOf = (links: Link[]): number[][] => {
  const out = links.map(() => [] as number[]);
  for (const a of links) for (const b of a.next) out[b].push(a.id);
  return out;
};

/** The point `d` meters back from the end of a polyline, held at its start. */
function pointBack(pts: Pt[], d: number): Pt {
  for (let i = pts.length - 1; i > 0; i--) {
    const [ax, az] = pts[i], [bx, bz] = pts[i - 1];
    const seg = Math.hypot(bx - ax, bz - az);
    if (d <= seg) return seg > 0 ? [ax + ((bx - ax) * d) / seg, az + ((bz - az) * d) / seg] : [ax, az];
    d -= seg;
  }
  return pts[0];
}

/** Every point `d` meters on past the end of link `id`, one for each way a tram may go on (its end, where none). */
function ahead(links: Link[], id: number, d: number): Pt[] {
  const l = links[id];
  if (!l.next.length) return [l.pts[l.pts.length - 1]];
  return l.next.flatMap((n) => (d <= links[n].length ? [pointAt(links[n].pts, d)] : ahead(links, n, d - links[n].length)));
}

/** Every point `d` meters back before the start of link `id`, one for each way a tram may come from (its start, where none). */
function behind(links: Link[], prevs: number[][], id: number, d: number): Pt[] {
  if (!prevs[id].length) return [links[id].pts[0]];
  return prevs[id].flatMap((p) => (d <= links[p].length ? [pointBack(links[p].pts, d)] : behind(links, prevs, p, d - links[p].length)));
}

/**
 * The tightest curve at `s` meters along link `id`: the circle through the points `CHORD` meters either side, along
 * every way a tram may run through the point, however many short links and junctions lie within reach.
 */
export function curveAt(links: Link[], prevs: number[][], id: number, s: number): number {
  const l = links[id];
  const here = pointAt(l.pts, s);
  const back = s >= CHORD ? [l.length - (s - CHORD) < s - CHORD ? pointBack(l.pts, l.length - (s - CHORD)) : pointAt(l.pts, s - CHORD)] : behind(links, prevs, id, CHORD - s);
  const on = s + CHORD <= l.length ? [pointAt(l.pts, s + CHORD)] : ahead(links, id, s + CHORD - l.length);
  let worst = Infinity;
  for (const a of back) for (const b of on) worst = Math.min(worst, radius(a, here, b));
  return worst;
}
