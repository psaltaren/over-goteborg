// Where every tram in the area is at a moment: Västtrafik's timetable (`schedule.ts`) on the service days running then
// (`serviceDay.ts`), as a function of the clock alone, so every visitor sees the same trams and a tram is wherever the
// clock puts it, however the frames fell before. Built once from the fetched files; asking costs a lookup in a list of
// the trips running in each five minutes, and a few stops per tram. No three.js.

import { covered, runPosition, signAt, type Day, type Run, type Trip } from './schedule';
import { serviceDays } from './serviceDay';

/** A tram in the area at a moment. */
export interface TramState {
  /** Which tram: its service day and its trip's place in the day, the same for as long as it runs. */
  id: string;
  run: number;
  /** Its front, in meters along its run. */
  s: number;
  /** How fast it goes along its run, m/s. */
  speed: number;
  /** How far its doors are open, 0 to 1, and on which side of the way it goes (1 right, -1 left). */
  doors: number;
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
  buckets: Map<number, number[]>;
}

export class TripTable {
  private readonly days = new Map<Day, DayIndex>();

  constructor(readonly runs: Run[], days: Partial<Record<Day, Trip[]>> = {}) {
    for (const [day, trips] of Object.entries(days) as Array<[Day, Trip[]]>) this.addDay(day, trips);
  }

  /** A day's trips, once fetched. */
  addDay(day: Day, trips: Trip[]): void {
    const buckets = new Map<number, number[]>();
    trips.forEach((t, i) => {
      for (let b = Math.floor(t.times[0] / BUCKET); b <= Math.floor(t.times[t.times.length - 1] / BUCKET); b++) {
        if (!buckets.has(b)) buckets.set(b, []);
        buckets.get(b)!.push(i);
      }
    });
    this.days.set(day, { trips, buckets });
  }

  has(day: Day): boolean {
    return this.days.has(day);
  }

  /** The trams in the area at `epoch` (seconds): every tram with some of its length on its run. */
  at(epoch: number, out: TramState[] = []): TramState[] {
    out.length = 0;
    for (const sd of serviceDays(epoch)) {
      const index = this.days.get(sd.day);
      if (!index) continue;
      const t = epoch - sd.start;
      for (const i of index.buckets.get(Math.floor(t / BUCKET)) ?? []) {
        const state = this.state(index.trips[i], t);
        if (state) out.push({ ...state, id: `${sd.start}:${i}` });
      }
    }
    return out;
  }

  /** A trip's tram `t` seconds into its service day, or null when it is not in the area. */
  private state(trip: Trip, t: number): Omit<TramState, 'id'> | null {
    const run = this.runs[trip.run];
    const s = runPosition(run, trip.times, t);
    if (s === null || !covered(run, s)) return null;
    const before = runPosition(run, trip.times, t - SPEED_STEP), after = runPosition(run, trip.times, t + SPEED_STEP);
    const speed = before !== null && after !== null ? (after - before) / (2 * SPEED_STEP) : 0;
    let stop = -1, next = -1;
    const n = run.stops.length;
    for (let i = 0; i < n; i++) {
      const arr = trip.times[2 * i], dep = trip.times[2 * i + 1];
      if (t >= arr && t <= dep) stop = i;
      if (arr > t && next < 0 && run.stops[i].s <= run.length) next = i;
    }
    let doors = 0, side: 1 | -1 = 1;
    const at = stop >= 0 ? run.stops[stop] : null;
    // Doors open only at a stop in the area that is a stop (not the edge a tram comes in from or goes out to).
    if (at && at.stop && at.s >= 0 && at.s <= run.length) {
      const arr = trip.times[2 * stop], dep = trip.times[2 * stop + 1];
      const opening = Math.min(1, Math.max(0, (t - arr - DOORS_AFTER) / DOORS_MOVE));
      const closing = Math.min(1, Math.max(0, (dep - DOORS_SHUT - t) / DOORS_MOVE));
      doors = Math.min(opening, closing);
      side = at.side;
    }
    const sign = signAt(run, s);
    return { run: trip.run, s, speed, doors, side, line: sign.line, headsign: sign.headsign, stop, next };
  }
}
