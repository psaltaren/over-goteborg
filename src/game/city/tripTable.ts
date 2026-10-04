// Where every tram in the area is at a moment: Västtrafik's timetable (`schedule.ts`) on the service days running then
// (`serviceDay.ts`), as a function of the clock alone, so every visitor sees the same trams and a tram is wherever the
// clock puts it, however the frames fell before. Built once from the fetched files; asking costs a lookup in a list of
// the trips running in each five minutes, and a few stops per tram. With live data on, the trips of the next half hour
// keep the times the live plan gives them (`livePlan.ts`, `setPlan`) and the rest the timetable's. No three.js.

import { covered, runPosition, signAt, type Day, type Hold, type Run, type Trip } from './schedule';
import { serviceDays } from './serviceDay';

/** A tram in the area at a moment. */
export interface TramState {
  /** Which tram: its service day's start and its trip's place in the day (`start * 10000 + index`), the same for as long as it runs. */
  id: number;
  run: number;
  /** Its front, in meters along its run. */
  s: number;
  /** How fast it goes along its run, m/s. */
  speed: number;
  /** How far its doors are open, 0 to 1, and on which side of the way it goes (1 right, -1 left). */
  doors: number;
  /** Whether its doors are closing (it leaves soon), not opening. */
  closing: boolean;
  side: 1 | -1;
  /** What its sign says. */
  line: string;
  headsign: string;
  /** The stop it stands at (its index on the run), else -1; and the next it comes to, -1 when none is left in the area. */
  stop: number;
  next: number;
}

/** How long the trips are listed per, in seconds. */
const BUCKET = 300;
/** Doors begin to open this long after a tram stops, take this long to open or close, and are shut this long before it leaves. */
const DOORS_AFTER = 2;
const DOORS_MOVE = 1.5;
const DOORS_SHUT = 3;
/** How far either side of a moment a tram's speed is measured over. */
const SPEED_STEP = 0.05;

/** A day's trips, and for each five minutes of its clock the trips running then. */
interface DayIndex {
  trips: Trip[];
  /** Where the block pass held each held trip, by its place in the list (Västtrafik's times are its times less these). */
  holds: Map<number, Hold[]>;
  buckets: Map<number, number[]>;
  /** For each stop (its id), the day's departures from it in time order, made the first time a stop's are asked for. */
  departures?: Map<string, Array<{ t: number; trip: number; stop: number }>>;
}

/** A tram leaving a stop: when (epoch seconds), and what its sign says. */
export interface Departure {
  at: number;
  line: string;
  headsign: string;
}

/** A trip of a service day running then, as the live plan sees it. */
export interface TripAt {
  id: number;
  run: number;
  day: Day;
  /** Its service day's start (epoch seconds), and its place in the day's list. */
  start: number;
  index: number;
  /** The timetable's times, and the times it keeps now: the live plan's, the same list when it has none, null when it does not run. */
  base: number[];
  times: number[] | null;
}

/** A trip's times as the live plan has them, or null when it does not run (Västtrafik cancelled it). */
interface Plan {
  day: Day;
  start: number;
  index: number;
  times: number[] | null;
}

/** How much later than the timetable a live plan may put a trip, and how much earlier (a trip the block pass held, running on time), in seconds. */
export const MAX_LATE = 30 * 60;
export const MAX_EARLY = 15 * 60;
/** A trip's id from its service day's start and its place in the day, and back. */
export const tripId = (start: number, index: number) => start * 10_000 + index;
const ID = 10_000;

export class TripTable {
  private readonly days = new Map<Day, DayIndex>();
  private readonly plans = new Map<number, Plan>();

  constructor(readonly runs: Run[], days: Partial<Record<Day, Trip[]>> = {}) {
    for (const [day, trips] of Object.entries(days) as Array<[Day, Trip[]]>) this.addDay(day, trips);
  }

  /** A day's trips, once fetched, with where the block pass held them (a trip's own `holds`, or by its place in the list). */
  addDay(day: Day, trips: Trip[], holds: Array<[number, Hold[]]> = []): void {
    const buckets = new Map<number, number[]>();
    trips.forEach((t, i) => {
      for (let b = Math.floor(t.times[0] / BUCKET); b <= Math.floor(t.times[t.times.length - 1] / BUCKET); b++) {
        if (!buckets.has(b)) buckets.set(b, []);
        buckets.get(b)!.push(i);
      }
    });
    const held = new Map<number, Hold[]>(holds);
    trips.forEach((t, i) => { if (t.holds) held.set(i, t.holds); });
    this.days.set(day, { trips, buckets, holds: held });
  }

  /** A day's trips, and where the block pass held them, once fetched. */
  day(day: Day): { trips: Trip[]; holds: Map<number, Hold[]> } | null {
    return this.days.get(day) ?? null;
  }

  /** The live plan's times for a trip (null: it does not run), in its service day's seconds. */
  setPlan(id: number, day: Day, times: number[] | null): void {
    this.plans.set(id, { day, start: Math.floor(id / ID), index: id % ID, times });
  }

  /** Back to the timetable: one trip, or every trip. */
  clearPlan(id: number): void {
    this.plans.delete(id);
  }

  clearPlans(): void {
    this.plans.clear();
  }

  get planned(): number {
    return this.plans.size;
  }

  /** Whether the live plan has a trip, and what it keeps (undefined: the timetable's times). */
  planOf(id: number): number[] | null | undefined {
    return this.plans.get(id)?.times;
  }

  /** How late the live plan has a trip leave its stop `k`, against Västtrafik's own time (seconds), or null without a plan. */
  lateAt(id: number, k: number): number | null {
    const p = this.plans.get(id);
    const data = p && this.days.get(p.day);
    if (!p?.times || !data) return null;
    let planned = data.trips[p.index].times[2 * k + 1];
    // A hold at a stop moved that stop's departure and every one after (`unheld`).
    for (const [stop, shift] of data.holds.get(p.index) ?? []) if (stop <= k) planned -= shift;
    return p.times[2 * k + 1] - planned;
  }

  /** The plans of trips that ended before `epoch` let go of. */
  dropPlansBefore(epoch: number): void {
    for (const [id, p] of this.plans) {
      const base = this.days.get(p.day)?.trips[p.index].times;
      const end = Math.max(p.times?.[p.times.length - 1] ?? -Infinity, base?.[base.length - 1] ?? -Infinity);
      if (p.start + end < epoch) this.plans.delete(id);
    }
  }

  /**
   * Every trip of the service days running at `epoch` that is (by the timetable or the live plan) somewhere between
   * its first stop and its last at some moment from `from` to `to` (epoch seconds).
   */
  trips(epoch: number, from: number, to: number): TripAt[] {
    const out: TripAt[] = [];
    const seen = new Set<number>();
    for (const sd of serviceDays(epoch)) {
      const index = this.days.get(sd.day);
      if (!index) continue;
      // A trip may run up to MAX_LATE later than the timetable, or MAX_EARLY earlier: look that far round.
      for (let b = Math.floor((from - sd.start - MAX_LATE) / BUCKET); b <= Math.floor((to - sd.start + MAX_EARLY) / BUCKET); b++) {
        for (const i of index.buckets.get(b) ?? []) {
          const id = tripId(sd.start, i);
          if (seen.has(id)) continue;
          seen.add(id);
          const trip = index.trips[i];
          const plan = this.plans.get(id);
          const times = plan ? plan.times : trip.times;
          const span = times ?? trip.times;
          if (sd.start + span[0] > to || sd.start + span[span.length - 1] < from) continue;
          out.push({ id, run: trip.run, day: sd.day, start: sd.start, index: i, base: trip.times, times });
        }
      }
    }
    return out;
  }

  has(day: Day): boolean {
    return this.days.has(day);
  }

  /**
   * The trams in the area at `epoch` (seconds): every tram with some of its length on its run. Into `out`, whose objects
   * are filled afresh (the game asks every frame).
   */
  at(epoch: number, out: TramState[] = []): TramState[] {
    let n = 0;
    for (const sd of serviceDays(epoch)) {
      const index = this.days.get(sd.day);
      if (!index) continue;
      const t = epoch - sd.start;
      for (const i of index.buckets.get(Math.floor(t / BUCKET)) ?? []) {
        const id = tripId(sd.start, i);
        if (this.plans.has(id)) continue;
        if (this.state(index.trips[i].run, index.trips[i].times, t, id, (out[n] ??= {} as TramState))) n++;
      }
    }
    // The trips the live plan keeps, wherever their times have taken them.
    for (const [id, p] of this.plans) {
      const times = p.times;
      if (!times) continue;
      const t = epoch - p.start;
      if (t < times[0] || t > times[times.length - 1]) continue;
      const trip = this.days.get(p.day)?.trips[p.index];
      if (trip && this.state(trip.run, times, t, id, (out[n] ??= {} as TramState))) n++;
    }
    out.length = n;
    return out;
  }

  /**
   * The next `n` trams to leave the stop `stop` (Västtrafik's id, a platform) after `epoch`, soonest first: from the
   * timetables of the service days running then, as `at` places the trams (so a tram held by the block pass leaves when
   * it is seen to leave). Not those going out of service from it.
   */
  departures(stop: string, epoch: number, n = 3): Departure[] {
    const out: Departure[] = [];
    for (const sd of serviceDays(epoch)) {
      const index = this.days.get(sd.day);
      if (!index) continue;
      const list = this.departuresOf(index).get(stop);
      if (!list) continue;
      const t = epoch - sd.start;
      // From as far back as a live plan may have made a trip late.
      const late = this.plans.size ? MAX_LATE : 0;
      let lo = 0, hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].t < t - late) lo = mid + 1;
        else hi = mid;
      }
      // The next `n` in service from this day: a tram going out of service from here is passed over, not counted, and
      // one the live plan has cancelled too. With plans, on until the timetable is past the n-th found by as much as a
      // plan may make a trip early.
      const found: number[] = [];
      for (let i = lo; i < list.length; i++) {
        if (found.length >= n && list[i].t - (this.plans.size ? MAX_EARLY : 0) > found[n - 1]) break;
        const { trip, stop: k } = list[i];
        const plan = this.plans.get(tripId(sd.start, trip));
        if (plan && !plan.times) continue;
        const at = plan ? plan.times![2 * k + 1] : list[i].t;
        if (at < t) continue;
        const run = this.runs[index.trips[trip].run];
        const sign = signAt(run, run.stops[k].s);
        if (!sign.line) continue;
        out.push({ at: sd.start + at, line: sign.line, headsign: sign.headsign });
        found.push(at);
        found.sort((a, b) => a - b);
      }
    }
    return out.sort((a, b) => a.at - b.at).slice(0, n);
  }

  /** A day's departures by stop, made once. */
  private departuresOf(index: DayIndex): Map<string, Array<{ t: number; trip: number; stop: number }>> {
    if (index.departures) return index.departures;
    const by = new Map<string, Array<{ t: number; trip: number; stop: number }>>();
    index.trips.forEach((trip, i) => {
      const run = this.runs[trip.run];
      run.stops.forEach((st, k) => {
        // The stops in the area a tram leaves from (not its last, where it goes on out of service or ends).
        if (!st.stop || st.s < 0 || st.s > run.length || k === run.stops.length - 1) return;
        if (!by.has(st.stop)) by.set(st.stop, []);
        by.get(st.stop)!.push({ t: trip.times[2 * k + 1], trip: i, stop: k });
      });
    });
    for (const list of by.values()) list.sort((a, b) => a.t - b.t);
    index.departures = by;
    return by;
  }

  /** A tram on run `r` keeping `times`, `t` seconds into its service day, into `into`; false when it is not in the area. */
  private state(r: number, times: number[], t: number, id: number, into: TramState): boolean {
    const run = this.runs[r];
    const s = runPosition(run, times, t);
    if (s === null || !covered(run, s)) return false;
    const before = runPosition(run, times, t - SPEED_STEP), after = runPosition(run, times, t + SPEED_STEP);
    const speed = before !== null && after !== null ? (after - before) / (2 * SPEED_STEP) : 0;
    let stop = -1, next = -1;
    const n = run.stops.length;
    for (let i = 0; i < n; i++) {
      const arr = times[2 * i], dep = times[2 * i + 1];
      if (t >= arr && t <= dep) stop = i;
      if (arr > t && next < 0 && run.stops[i].s <= run.length) next = i;
    }
    let doors = 0, closing = false, side: 1 | -1 = 1;
    const at = stop >= 0 ? run.stops[stop] : null;
    // Doors open only at a stop in the area that is a stop (not the edge a tram comes in from or goes out to).
    if (at && at.stop && at.s >= 0 && at.s <= run.length) {
      const arr = times[2 * stop], dep = times[2 * stop + 1];
      const opening = Math.min(1, Math.max(0, (t - arr - DOORS_AFTER) / DOORS_MOVE));
      const shutting = Math.min(1, Math.max(0, (dep - DOORS_SHUT - t) / DOORS_MOVE));
      doors = Math.min(opening, shutting);
      closing = t > dep - DOORS_SHUT - DOORS_MOVE;
      side = at.side;
    }
    const sign = signAt(run, s);
    Object.assign(into, { id, run: r, s, speed, doors, closing, side, line: sign.line, headsign: sign.headsign, stop, next });
    return true;
  }
}
