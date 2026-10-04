// The live plan: Västtrafik's delays and cancellations laid on the timetable, so the trams run late as the real ones
// do, without a tram ever jumping or two ever meeting. No three.js.
//
// A trip's plan is made while its tram still stands out of sight at its first stop, before the area: its times as
// Västtrafik planned them (`unheld`), each stop it will leave as late as Västtrafik expects, a hop never shorter than
// planned (a delay lengthens a stop, never a hop), and then the block pass (`Blocks.clear`) against every tram already
// on its way. Once it sets out its plan is fixed: whatever Västtrafik says after, it runs on as it set out, so nothing
// ever moves under the player. Every so often the trips of the next half hour that have not set out are planned again.
// Without live data (none, stale, or turned off) a trip is planned as the timetable has it, and the trams are back on
// the timetable within the half hour, those already on their way finishing as they set out.

import { Blocks, hold, unheld, type Held, type Occupancy } from './blocks';
import { MAX_EARLY, MAX_LATE, TripTable, type TripAt } from './tripTable';

/** What Västtrafik says of one trip: when its tram leaves stops (by their index on its run, epoch seconds), and whether it runs at all. */
export interface Live {
  leaves: Map<number, number>;
  cancelled: boolean;
}

/** How far ahead trips are planned, in seconds. Planning again more often than this keeps every trip planned before it sets out. */
export const HORIZON = 30 * 60;
/** A trip whose tram sets out within this many seconds keeps its plan: time for a planning to finish before it does. */
export const LEAD = 15;
/** The least a tram stands at a stop when it makes up time, unless the timetable has it stand less. */
const MIN_DWELL = 15;
/** How early Västtrafik's expected time may put a tram, at most: a tram running ahead waits out most of it. */
const MOST_EARLY = 120;

export class LivePlanner {
  /** Each fixed trip's blocks, worked out once for the times it keeps. */
  private readonly occupancies = new Map<number, { times: number[]; occupancy: Occupancy }>();
  private last = -Infinity;
  /** What the last planning did, for `__us` and the tests. */
  stats = { fixed: 0, planned: 0, live: 0, held: 0, cancelled: 0, stuck: 0 };

  constructor(private readonly table: TripTable, private readonly blocks: Blocks) {}

  /**
   * Plans the trips of the next half hour from `epoch` (seconds) that have not set out, with what Västtrafik says of
   * them (`live`, by trip id; empty to follow the timetable), pausing after each trip so the caller can spread it over
   * frames. The plans are given to the table all at once when it is done.
   */
  *update(epoch: number, live: ReadonlyMap<number, Live>): Generator<void, void> {
    // A clock that jumped (the debug clock, a tab put away for an hour) leaves plans made for another time: back to the
    // timetable, which is clear of clashes, and planned afresh from here.
    if (epoch < this.last - 1 || epoch - this.last > HORIZON - 5 * 60) {
      this.table.clearPlans();
      this.occupancies.clear();
    }
    this.last = epoch;
    this.table.dropPlansBefore(epoch - 60);
    const stats = { fixed: 0, planned: 0, live: 0, held: 0, cancelled: 0, stuck: 0 };
    const held: Held = new Map();
    const todo: Array<{ trip: TripAt; times: number[] | null }> = [];
    const keep = new Set<number>();
    for (const trip of this.table.trips(epoch, epoch, epoch + HORIZON)) {
      const sets = trip.start + (trip.times ?? trip.base)[1];
      if (sets <= epoch + LEAD) {
        // On its way, or about to be: as it is. Its blocks are what every other trip is planned round.
        stats.fixed++;
        if (!trip.times) continue;
        keep.add(trip.id);
        const known = this.occupancies.get(trip.id)?.times === trip.times;
        hold(this.occupancyOf(trip.id, trip.run, trip.times, trip.start), held);
        if (!known) yield;
      } else if (trip.start + Math.min(trip.base[1], trip.times?.[1] ?? Infinity) <= epoch + HORIZON) {
        todo.push({ trip, times: this.wanted(trip, live.get(trip.id), epoch) });
      }
    }
    for (const id of this.occupancies.keys()) if (!keep.has(id)) this.occupancies.delete(id);
    yield;
    // First come, first served, as the timetable's own pass: in the order the trams reach the first place where their
    // ways meet another's (or else the area).
    const order: Array<{ trip: TripAt; times: number[] | null; occupancy: Occupancy | null; first: number }> = [];
    for (const { trip, times } of todo) {
      const occupancy = times ? this.blocks.occupancy(trip.run, times, trip.start) : null;
      let entry = Infinity;
      if (occupancy) for (const [, [a]] of occupancy) entry = Math.min(entry, a);
      order.push({ trip, times, occupancy, first: (occupancy && this.blocks.firstContestedIn(occupancy)) ?? entry });
      yield;
    }
    order.sort((a, b) => a.first - b.first);
    const plans: Array<{ trip: TripAt; times: number[] | null }> = [];
    for (const { trip, times, occupancy } of order) {
      if (live.has(trip.id)) stats.live++;
      if (!times) {
        stats.cancelled++;
        plans.push({ trip, times: null });
        continue;
      }
      const { holds, cleared } = yield* this.blocks.clearSteps(trip.run, times, held, trip.start, occupancy ?? undefined);
      if (holds.length) stats.held++;
      // A trip that cannot be cleared, or would run later than a plan may make it, does not run: never two in a block.
      const late = times.some((v, k) => v - trip.base[k] > MAX_LATE || trip.base[k] - v > MAX_EARLY);
      if (!cleared || late) stats.stuck++;
      plans.push({ trip, times: cleared && !late ? times : null });
      yield;
    }
    for (const { trip, times } of plans) {
      if (times && times.every((v, k) => v === trip.base[k])) this.table.clearPlan(trip.id);
      else this.table.setPlan(trip.id, trip.day, times);
    }
    stats.planned = plans.length;
    this.stats = stats;
  }

  /** Plans the next half hour at once (the tests, and the first planning while the game loads). */
  plan(epoch: number, live: ReadonlyMap<number, Live>): void {
    for (const _ of this.update(epoch, live));
  }

  /** A fixed trip's blocks, worked out the first time and kept for as long as it keeps the same times. */
  private occupancyOf(id: number, run: number, times: number[], start: number): Occupancy {
    const kept = this.occupancies.get(id);
    if (kept && kept.times === times) return kept.occupancy;
    const occupancy = this.blocks.occupancy(run, times, start);
    this.occupancies.set(id, { times, occupancy });
    return occupancy;
  }

  /**
   * The times a trip would keep with what Västtrafik says of it, before the block pass: the timetable's without word of
   * it, null when it is cancelled. Never setting out before `epoch` is out (it has not, or it would be fixed).
   */
  private wanted(trip: TripAt, said: Live | undefined, epoch: number): number[] | null {
    if (said?.cancelled) return null;
    const out = said?.leaves.size ? this.late(trip, said) : [...trip.base];
    // Not out of the first stop before the plan is made: the whole trip later if it must (out of sight, where it waits).
    const behind = epoch + LEAD + 1 - (trip.start + out[1]);
    if (behind > 0) for (let j = 0; j < out.length; j++) out[j] += behind;
    return out;
  }

  /** A trip's times as late as Västtrafik says it is at the stops it says it of. */
  private late(trip: TripAt, said: Live): number[] {
    const holds = this.table.day(trip.day)?.holds.get(trip.index) ?? [];
    const planned = unheld(trip.base, holds);
    const n = planned.length / 2;
    const delayAt = (k: number) => Math.min(MAX_LATE - 5 * 60, Math.max(-MOST_EARLY, said.leaves.get(k)! - trip.start - planned[2 * k + 1]));
    // Late (or early) from the start by as much as at the first stop Västtrafik knows of, then as it says at each stop
    // it knows of, standing no shorter than it may to make up time, and keeping its delay past the last.
    const first = Math.min(...said.leaves.keys());
    let delay = delayAt(first);
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const arr = k === 0 ? planned[0] + delay : out[2 * k - 1] + (planned[2 * k] - planned[2 * k - 1]);
      const dwell = planned[2 * k + 1] - planned[2 * k];
      let dep = arr + dwell;
      if (said.leaves.has(k)) {
        delay = delayAt(k);
        dep = Math.max(arr + Math.min(dwell, MIN_DWELL), planned[2 * k + 1] + delay);
      }
      out.push(arr, dep);
    }
    return out;
  }
}
