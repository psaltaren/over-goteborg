// No two trams in one block at once: the track graph's blocks and the pairs of them that conflict (`tracks.json`), and
// how a tram's trip is held at a stop until the blocks ahead of it are clear. Shared by the timetable's offline pass
// (`scripts/gbg-gtfs.ts`, which clears a whole day) and the game's live trams (`livePlan.ts`, which clears the next
// half hour as Västtrafik's delays come in), so both keep the same rule. No three.js.

import { covered, hop, runBlocks, runPosition, type Hold, type Run } from './schedule';
import type { Block, Link } from './trackData';

/** Seconds kept clear between one tram leaving a block and the next coming in. */
export const MARGIN = 3;
/** How many times one trip is held before it is given up on as one that cannot be cleared. */
const TRIES = 60;

/** When each block is held: by the trams already placed, as their first and last whole second there. */
export type Held = Map<number, Array<[number, number]>>;
/** One trip's time in each block it passes: its first and last whole second there. */
export type Occupancy = Map<number, [number, number]>;
export type { Hold };
export class Blocks {
  private readonly along: Array<Array<{ block: number; a: number; b: number }> | undefined> = [];
  private readonly conflicts = new Map<number, number[]>();

  constructor(private readonly runs: Run[], private readonly links: Link[], private readonly blocks: Block[], conflicts: Array<[number, number]>) {
    for (const [a, b] of conflicts) {
      if (!this.conflicts.has(a)) this.conflicts.set(a, []);
      if (!this.conflicts.has(b)) this.conflicts.set(b, []);
      this.conflicts.get(a)!.push(b);
      this.conflicts.get(b)!.push(a);
    }
  }

  /** A run's blocks in run meters, worked out the first time they are asked for. */
  alongOf(run: number): Array<{ block: number; a: number; b: number }> {
    return (this.along[run] ??= runBlocks(this.runs[run], this.links, this.blocks));
  }

  /** Whether a block is one where two trams' ways meet (a switch, a crossing). */
  contested(block: number): boolean {
    return this.conflicts.has(block);
  }

  /**
   * When a tram on `run` keeping `times` (seconds) is in each block, sampled every whole second, with `offset` added to
   * the seconds it returns (a service day's start, to compare trips of two days).
   */
  occupancy(run: number, times: number[], offset = 0): Occupancy {
    const out: Occupancy = new Map();
    const r = this.runs[run];
    const along = this.alongOf(run);
    const n = r.stops.length;
    const t0 = Math.ceil(times[0]), t1 = Math.floor(times[times.length - 1]);
    // A tram only goes forward, and a run's blocks follow one another along it, so the first block it can still be in
    // only moves on: `blocksIn` without the walk from the start each second.
    let lo = 0;
    /** The tram's front at `s` from second `from` to second `to`: the blocks it covers held that long. */
    const mark = (s: number, from: number, to: number) => {
      const c = covered(r, s);
      if (!c) return;
      while (lo < along.length && along[lo].b <= c[0]) lo++;
      for (let i = lo; i < along.length && along[i].a < c[1]; i++) {
        if (along[i].b <= c[0]) continue;
        const b = along[i].block;
        const cur = out.get(b);
        if (cur) cur[1] = to + offset;
        else out.set(b, [from + offset, to + offset]);
      }
    };
    // As `runPosition` has it at each whole second, a stop and a hop at a time: standing at a stop the whole stand at
    // once, a hop second by second.
    for (let i = 0; i < n; i++) {
      const arr = times[2 * i], dep = times[2 * i + 1];
      const from = Math.max(t0, Math.ceil(arr)), to = Math.min(t1, Math.floor(dep));
      if (from <= to) mark(r.stops[i].s, from, to);
      if (i + 1 === n) break;
      const next = times[2 * (i + 1)], d = r.stops[i + 1].s - r.stops[i].s;
      for (let t = Math.max(t0, Math.floor(dep) + 1); t < next && t <= t1; t++) mark(r.stops[i].s + hop(d, next - dep, t - dep), t, t);
    }
    return out;
  }

  /**
   * The earliest clash of a trip's `occupancy` with what `held` holds: the first second it comes into a block another
   * tram holds, or one that conflicts with it, within `MARGIN`, and the second it would have to wait until.
   */
  clash(occupancy: Occupancy, held: Held): { at: number; until: number } | null {
    let clash: { at: number; until: number } | null = null;
    for (const [b, [a, z]] of occupancy) {
      for (const other of [b, ...(this.conflicts.get(b) ?? [])]) {
        for (const [oa, oz] of held.get(other) ?? []) {
          if (oa - MARGIN <= z && a <= oz + MARGIN && (!clash || a < clash.at)) clash = { at: a, until: oz + MARGIN + 1 };
        }
      }
    }
    return clash;
  }

  /**
   * Holds a trip (its `times`, changed in place) until it clears what `held` holds, and then holds its blocks in turn:
   * each time at the last stop it leaves before the earliest clash, by as long as the other needs, the rest of its trip
   * moved on by as much; a clash before it leaves its first stop moves the whole trip. `offset` as for `occupancy`, and
   * `known` the occupancy of `times` as given, if worked out already. Returns where it was held, and whether it could be
   * cleared at all (one that cannot holds no blocks).
   */
  clear(run: number, times: number[], held: Held, offset = 0, known?: Occupancy): { holds: Hold[]; cleared: boolean } {
    const steps = this.clearSteps(run, times, held, offset, known);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /** `clear`, pausing after each try (the game spreads it over frames); also the occupancy it held, when it cleared. */
  *clearSteps(run: number, times: number[], held: Held, offset = 0, known?: Occupancy): Generator<void, { holds: Hold[]; cleared: boolean; occupancy?: Occupancy }> {
    const holds: Hold[] = [];
    const stops = this.runs[run].stops.length;
    for (let tries = 0; tries < TRIES; tries++) {
      // The first time round, the occupancy of the times as given, when the caller has it already.
      const occupancy = (tries === 0 && known) || this.occupancy(run, times, offset);
      const clash = this.clash(occupancy, held);
      if (!clash) {
        hold(occupancy, held);
        return { holds, cleared: true, occupancy };
      }
      const shift = Math.max(1, clash.until - clash.at);
      let stop = -1;
      for (let i = 0; i < stops; i++) if (times[2 * i + 1] + offset <= clash.at) stop = i;
      for (let j = stop < 0 ? 0 : 2 * stop + 1; j < times.length; j++) times[j] += shift;
      // Held at a stop again, the holds there add up (each moves the same times on).
      const there = holds.find(([k]) => k === stop);
      if (there) there[1] += shift;
      else holds.push([stop, shift]);
      yield;
    }
    return { holds, cleared: false };
  }

  /** The first second a trip is in a contested block (where trams' ways meet), or else in the area at all. */
  firstContested(run: number, times: number[]): number | null {
    return this.firstContestedIn(this.occupancy(run, times)) ?? firstIn(this.runs[run], times);
  }

  /** The first second of an occupancy in a contested block, or null if it has none. */
  firstContestedIn(occupancy: Occupancy): number | null {
    let first: number | null = null;
    for (const [b, [a]] of occupancy) if (this.contested(b) && (first === null || a < first)) first = a;
    return first;
  }
}

/** The first whole second a trip's tram has some of its length in the area, or null if it never does. */
export function firstIn(run: Run, times: number[]): number | null {
  for (let t = Math.ceil(times[0]); t <= times[times.length - 1]; t++) {
    const s = runPosition(run, times, t);
    if (s !== null && covered(run, s)) return t;
  }
  return null;
}

/** A trip's blocks added to what `held` holds. */
export function hold(occupancy: Occupancy, held: Held): void {
  for (const [b, span] of occupancy) {
    if (!held.has(b)) held.set(b, []);
    held.get(b)!.push(span);
  }
}

/** A trip's blocks taken back from what `held` holds (the very spans `hold` added). */
export function unhold(occupancy: Occupancy, held: Held): void {
  for (const [b, span] of occupancy) {
    const spans = held.get(b);
    const at = spans?.indexOf(span) ?? -1;
    if (at >= 0) spans!.splice(at, 1);
  }
}

/** A trip's times as Västtrafik planned them, before the block pass held it: its `times` less its `holds`. */
export function unheld(times: number[], holds: Hold[]): number[] {
  const out = [...times];
  for (const [stop, shift] of holds) for (let j = stop < 0 ? 0 : 2 * stop + 1; j < out.length; j++) out[j] -= shift;
  return out;
}
