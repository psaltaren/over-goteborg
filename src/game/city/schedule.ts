// The trams' day, as `scripts/gbg-gtfs.ts` writes it (`city/osm/schedule.json`): Västtrafik's timetable laid on the
// track graph (`trackData.ts`). A run is the stretch of one route through the area, a list of links with the stops
// along it; a trip is one tram's times at those stops. Where a tram is follows from the clock alone (`runPosition`),
// so every visitor sees the same trams. Shared by the data scripts, the tests and the game; no three.js.

import { TRAM_ACCEL, TRAM_LENGTH } from '../layout';
import { pointAt, type Link } from './trackData';
import type { Pt } from './geo';

/** The days the timetable is kept for: a weekday, a Saturday and a Sunday stand for the rest. */
export const DAYS = ['weekday', 'saturday', 'sunday'] as const;
export type Day = (typeof DAYS)[number];

/**
 * The days whose last trams may run on past midnight into each kind of day: every one into every one. A weekday's night
 * runs into the next weekday and Sunday's into Monday as the calendar has it, but a public holiday runs Sunday's
 * timetable after a weekday's night (`serviceDay.ts`), and its eve Saturday's: the block pass keeps each day's morning
 * clear of all three nights.
 */
export const NIGHT_BEFORE: Record<Day, Day[]> = { weekday: [...DAYS], saturday: [...DAYS], sunday: [...DAYS] };

/** What a tram's sign says when it runs to or from the edge of the area out of service, or between two trips. */
export const OUT_OF_SERVICE = 'Ej i trafik';

export interface RunStop {
  /** Västtrafik's stop point (a platform), its name and platform letter. */
  stop: string;
  name: string;
  platform: string;
  /**
   * Meters along the run. The stop before the run comes into the area lies before 0 and the one after it leaves past
   * the run's length, measured along the route's shape: there the tram is out of sight, coming or going.
   */
  s: number;
  /** How far the platform lies from the track, for the stops in the area. */
  off: number;
  /** Which side of the track the platform lies on, looking the way the run goes: 1 right, -1 left. */
  side: 1 | -1;
}

/** What a tram's sign says from `s` meters along its run on: its line (empty out of service) and where it is going. */
export interface Sign {
  s: number;
  line: string;
  headsign: string;
}

export interface Run {
  id: number;
  line: string;
  /** Where the trips are going, as the signs say it. */
  headsign: string;
  /**
   * Where the sign changes, for a run that is one tram's trips joined (`scripts/gbg-gtfs.ts`): at a terminus in the
   * area, to the next trip's line, or out of service to or from the area's edge. Without it, `line` and `headsign` hold
   * the whole way (`signAt`).
   */
  signs?: Sign[];
  /** The links it runs along, in order, from `from` meters into the first to `to` meters into the last. */
  links: number[];
  from: number;
  to: number;
  length: number;
  stops: RunStop[];
}

/** One tram on one run: its arrival and departure at each of the run's stops, [arrival, departure, arrival, ...]. */
export interface Trip {
  run: number;
  /** Seconds from the start of the service day (noon less twelve hours), past 24 h for the night. */
  times: number[];
  /** Seconds the block pass held it, if it did: added at the stop before the conflict and carried on. */
  held?: number;
}

/** The file: its runs, and the trips of each kind of day under the day's name. */
export type ScheduleFile = {
  license: string;
  format: string;
  /** Västtrafik's feed it was made from, and the date that stands for each kind of day. */
  feed: string;
  dates: Record<Day, string>;
  runs: Run[];
} & Record<Day, Trip[]>;

/**
 * Meters covered `t` seconds into a hop of `d` meters that takes `duration` seconds from standing to standing: speeding
 * up and slowing down at `TRAM_ACCEL`, cruising between, the cruising speed whatever makes the hop take its time. A
 * hop too short for its time to allow that is run harder, speeding up and slowing down in half the time each.
 */
export function hop(d: number, duration: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= duration) return d;
  const T = duration;
  let a = TRAM_ACCEL;
  const disc = a * a * T * T - 4 * a * d;
  let v: number;
  if (disc >= 0) v = (a * T - Math.sqrt(disc)) / 2;
  else {
    a = (4 * d) / (T * T);
    v = (a * T) / 2;
  }
  const ta = v / a;
  if (t <= ta) return 0.5 * a * t * t;
  if (t <= T - ta) return 0.5 * a * ta * ta + v * (t - ta);
  const left = T - t;
  return d - 0.5 * a * left * left;
}

/**
 * Where along its run a trip's tram is at `t` (seconds into the service day): meters along the run, before 0 or past
 * its length while coming or going out of sight, or null before it arrives at its first stop and after it leaves its
 * last (a tram at a terminus in the area stands there from its arrival to its departure).
 */
export function runPosition(run: Run, times: number[], t: number): number | null {
  const n = run.stops.length;
  if (t < times[0] || t > times[2 * n - 1]) return null;
  for (let i = 0; i < n; i++) {
    const arr = times[2 * i], dep = times[2 * i + 1];
    if (t <= dep) return t >= arr ? run.stops[i].s : null;
    if (i + 1 < n && t < times[2 * (i + 1)]) return run.stops[i].s + hop(run.stops[i + 1].s - run.stops[i].s, times[2 * (i + 1)] - dep, t - dep);
  }
  return run.stops[n - 1].s;
}

/** What the sign of a tram on `run` with its front `s` meters along says. */
export function signAt(run: Run, s: number): { line: string; headsign: string } {
  let sign: { line: string; headsign: string } = run;
  for (const x of run.signs ?? []) {
    if (x.s > s) break;
    sign = x;
  }
  return sign;
}

/**
 * A day's trips as the game fetches them (`osm/trams/<day>.json`): each as its run, then its times as whole seconds,
 * each from the one before (the first from the service day's start). Two thirds the size of the plain lists.
 */
export function packTrips(trips: Trip[]): number[][] {
  return trips.map((t) => [t.run, ...t.times.map((v, i) => Math.round(v - (i ? t.times[i - 1] : 0)))]);
}

/** `packTrips` undone. */
export function unpackTrips(packed: number[][]): Trip[] {
  return packed.map(([run, ...deltas]) => {
    let at = 0;
    return { run, times: deltas.map((d) => (at += d)) };
  });
}

/** The stretch of the run a tram whose front is at `s` covers, or null when none of it is in the area. */
export function covered(run: Run, s: number): [number, number] | null {
  const a = Math.max(0, s - TRAM_LENGTH), b = Math.min(run.length, s);
  return b > a ? [a, b] : null;
}

/** A run's track in run meters: each piece of a link, where it starts along the run and on the link. */
export function runPieces(run: Run, links: Link[]): Array<{ link: number; at: number; s0: number; s1: number }> {
  const out: Array<{ link: number; at: number; s0: number; s1: number }> = [];
  let at = 0;
  run.links.forEach((id, k) => {
    const s0 = k === 0 ? run.from : 0;
    const s1 = k === run.links.length - 1 ? run.to : links[id].length;
    out.push({ link: id, at, s0, s1 });
    at += s1 - s0;
  });
  return out;
}

/**
 * A run's track, its pieces worked out once: the point `s` meters along it, in the city frame. Make one per run and
 * keep it; the game asks every tram's position every frame.
 */
export class RunPath {
  readonly pieces: Array<{ link: number; at: number; s0: number; s1: number }>;

  constructor(run: Run, private readonly links: Link[]) {
    this.pieces = runPieces(run, links);
  }

  point(s: number): Pt {
    let p = this.pieces[this.pieces.length - 1];
    for (const q of this.pieces) {
      if (s <= q.at + (q.s1 - q.s0)) {
        p = q;
        break;
      }
    }
    return pointAt(this.links[p.link].pts, p.s0 + Math.max(0, s - p.at));
  }
}

/**
 * The blocks along a run, in run meters: for each, the stretch of the run it covers. Built once per run, so finding the
 * blocks a tram is in is a search, not a walk over the graph.
 */
export function runBlocks(run: Run, links: Link[], blocks: Array<{ id: number; spans: Array<[number, number, number]> }>): Array<{ block: number; a: number; b: number }> {
  const byLink = new Map<number, Array<{ block: number; s0: number; s1: number }>>();
  for (const b of blocks) {
    for (const [link, s0, s1] of b.spans) {
      if (!byLink.has(link)) byLink.set(link, []);
      byLink.get(link)!.push({ block: b.id, s0, s1 });
    }
  }
  const out: Array<{ block: number; a: number; b: number }> = [];
  for (const p of runPieces(run, links)) {
    for (const q of byLink.get(p.link) ?? []) {
      const a = Math.max(p.s0, q.s0), b = Math.min(p.s1, q.s1);
      if (b > a) out.push({ block: q.block, a: p.at + a - p.s0, b: p.at + b - p.s0 });
    }
  }
  return out.sort((x, y) => x.a - y.a);
}

/** The blocks a tram covering run meters [a, b] is in. */
export function blocksIn(along: Array<{ block: number; a: number; b: number }>, a: number, b: number): number[] {
  const out: number[] = [];
  for (const x of along) {
    if (x.a >= b) break;
    if (x.b > a) out.push(x.block);
  }
  return out;
}
