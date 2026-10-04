// Västtrafik's departures matched to the game's trips: a departure names its platform (a stop point), its line, where
// it is going and the time it was planned for, and a trip's times less the block pass's holds are those planned times
// (`unheld`), so a departure finds its trip by platform and planned second, its line and its way telling apart the
// few trips that share them. No three.js.

import { unheld } from './blocks';
import { signAt, type Day } from './schedule';
import { serviceDays } from './serviceDay';
import { tripId, type TripTable } from './tripTable';
import type { Live } from './livePlan';

/**
 * A departure as the relay passes it on (`feeds/vt`, server/vasttrafik.ts): its platform (Västtrafik's stop point
 * gid), line, the time it was planned for and the time Västtrafik expects it (epoch seconds; null without word from
 * the tram), 1 if it is cancelled, and where it is going.
 */
export type LiveDeparture = [stop: string, line: string, planned: number, expected: number | null, cancelled: 0 | 1, direction?: string];

/** The stop area a platform belongs to: Västtrafik's gids, a stop point's with its type and platform digits changed. */
export const areaOf = (stop: string): string => `${stop.slice(0, 3)}1${stop.slice(4, 13)}000`;

/**
 * How far from the planned second a departure is still taken for a trip's, nearest first (Västtrafik plans to the
 * minute, as the timetable does, but a trip may have been moved a little since the timetable was read).
 */
const SLACK = [0, -30, 30, -60, 60];
/** Trips indexed, and departures matched, between two pauses for the frame. */
const PER_STEP = 400;

/** A place's name as a sign gives it, to tell two ways apart: lower case, without what it goes via. */
const way = (name: string) => name.toLowerCase().split(/ via | över /)[0].trim();

export class LiveMatcher {
  /** Per kind of day, its trips' planned departures by platform and second: [trip index, stop index]. */
  private readonly index = new Map<Day, { trips: unknown; version: number; at: Map<string, Array<[number, number]>> }>();

  constructor(private readonly table: TripTable) {}

  /** `matchSteps` at once (the tests). */
  match(departures: LiveDeparture[], epoch: number): Map<number, Live> {
    const steps = this.matchSteps(departures, epoch);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  /**
   * What the departures say of each trip of the service days running at `epoch`, by trip id: when it leaves each stop
   * Västtrafik expects it at, measured from the trip's own planned second, and whether it is cancelled (every
   * departure of it heard of is). Departures without an expected time say nothing; nor do those of a day whose holds
   * are not here yet. Pauses now and then for the frame.
   */
  *matchSteps(departures: LiveDeparture[], epoch: number): Generator<void, Map<number, Live>> {
    const days = serviceDays(epoch);
    for (const sd of days) yield* this.plannedSteps(sd.day);
    const out = new Map<number, Live & { heard: number; dropped: number }>();
    /** Each trip's stop already given a departure, so two departures never land on one. */
    const taken = new Set<string>();
    let n = 0;
    for (const [stop, line, planned, expected, cancelled, direction] of departures) {
      if (++n % PER_STEP === 0) yield;
      for (const sd of days) {
        const found = this.find(sd.day, stop, line, direction ?? '', planned - sd.start, (i, k) => !taken.has(`${sd.start}|${i}|${k}`));
        if (!found) continue;
        const [trip, k, ours] = found;
        taken.add(`${sd.start}|${trip}|${k}`);
        const id = tripId(sd.start, trip);
        const live = out.get(id) ?? { leaves: new Map<number, number>(), cancelled: false, heard: 0, dropped: 0 };
        out.set(id, live);
        live.heard++;
        // As late as Västtrafik says against its own plan, from the trip's planned second.
        if (cancelled) live.dropped++;
        else if (expected !== null) live.leaves.set(k, sd.start + ours + (expected - planned));
        break;
      }
    }
    const result = new Map<number, Live>();
    for (const [id, { leaves, heard, dropped }] of out) {
      const cancelled = dropped > 0 && dropped === heard;
      if (cancelled || leaves.size) result.set(id, { leaves, cancelled });
    }
    return result;
  }

  /**
   * The trip of a kind of day that leaves platform `stop` on `line` toward `direction` at `t` seconds into its service
   * day as planned (or the nearest second within the slack), not yet given a departure: [trip index, stop index, its
   * planned second].
   */
  private find(day: Day, stop: string, line: string, direction: string, t: number, free: (trip: number, k: number) => boolean): [number, number, number] | null {
    const at = this.index.get(day)?.at;
    const data = this.table.day(day);
    if (!at || !data?.held) return null;
    const going = way(direction);
    for (const d of SLACK) {
      const second = Math.round(t + d);
      let fallback: [number, number, number] | null = null;
      for (const [trip, k] of at.get(`${stop}|${second}`) ?? []) {
        const run = this.table.runs[data.trips[trip].run];
        const sign = signAt(run, run.stops[k].s);
        if (sign.line !== line || !free(trip, k)) continue;
        // The one going the way it says, else the first on the line.
        const ours = way(sign.headsign);
        if (!going || ours.startsWith(going) || going.startsWith(ours)) return [trip, k, second];
        fallback ??= [trip, k, second];
      }
      if (fallback) return fallback;
    }
    return null;
  }

  /** A day's planned departures by platform and second, made the first time they are asked for (and again for new holds). */
  private *plannedSteps(day: Day): Generator<void, void> {
    const data = this.table.day(day);
    if (!data?.held) return;
    const kept = this.index.get(day);
    if (kept && kept.trips === data.trips && kept.version === data.version) return;
    const at = new Map<string, Array<[number, number]>>();
    for (let i = 0; i < data.trips.length; i++) {
      if (i % PER_STEP === PER_STEP - 1) yield;
      const trip = data.trips[i];
      const run = this.table.runs[trip.run];
      const times = unheld(trip.times, data.holds.get(i) ?? []);
      run.stops.forEach((st, k) => {
        if (!st.stop || st.s < 0 || st.s > run.length || k === run.stops.length - 1) return;
        const key = `${st.stop}|${times[2 * k + 1]}`;
        if (!at.has(key)) at.set(key, []);
        at.get(key)!.push([i, k]);
      });
    }
    this.index.set(day, { trips: data.trips, version: data.version, at });
  }
}
