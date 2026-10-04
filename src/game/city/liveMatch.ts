// Västtrafik's departures matched to the game's trips: a departure names its platform (a stop point), its line and
// the time it was planned for, and a trip's times less the block pass's holds are those planned times (`unheld`), so
// a departure finds its trip exactly, by platform and planned second. No three.js.

import { unheld } from './blocks';
import { signAt, type Day } from './schedule';
import { serviceDays } from './serviceDay';
import { tripId, type TripTable } from './tripTable';
import type { Live } from './livePlan';

/**
 * A departure as the relay passes it on (`feeds/vt`): its platform (Västtrafik's stop point gid), line, the time it
 * was planned for and the time Västtrafik expects it (epoch seconds; null without word from the tram), and 1 if it is
 * cancelled.
 */
export type LiveDeparture = [stop: string, line: string, planned: number, expected: number | null, cancelled: 0 | 1];

/** How far from the planned second a departure is still taken for a trip's (Västtrafik plans to the minute, the feed to the second). */
const SLACK = [0, -60, 60, -30, 30];

export class LiveMatcher {
  /** Per kind of day, its trips' planned departures by platform and second: [trip index, stop index]. */
  private readonly index = new Map<Day, { trips: unknown; at: Map<string, Array<[number, number]>> }>();

  constructor(private readonly table: TripTable) {}

  /**
   * What the departures say of each trip of the service days running at `epoch`, by trip id: when it leaves each stop
   * Västtrafik expects it at, and whether it is cancelled (every departure of it heard of is). Departures without an
   * expected time say nothing.
   */
  match(departures: LiveDeparture[], epoch: number): Map<number, Live> {
    const out = new Map<number, Live & { heard: number; dropped: number }>();
    const days = serviceDays(epoch);
    for (const [stop, line, planned, expected, cancelled] of departures) {
      for (const sd of days) {
        const found = this.find(sd.day, stop, line, planned - sd.start);
        if (!found) continue;
        const id = tripId(sd.start, found[0]);
        const live = out.get(id) ?? { leaves: new Map<number, number>(), cancelled: false, heard: 0, dropped: 0 };
        out.set(id, live);
        live.heard++;
        if (cancelled) live.dropped++;
        else if (expected !== null) live.leaves.set(found[1], expected);
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

  /** The trip of a kind of day that leaves platform `stop` on `line` at `t` seconds into its service day, as planned. */
  private find(day: Day, stop: string, line: string, t: number): [number, number] | null {
    const at = this.planned(day);
    if (!at) return null;
    for (const d of SLACK) {
      for (const [trip, k] of at.get(`${stop}|${Math.round(t + d)}`) ?? []) {
        const run = this.table.runs[this.table.day(day)!.trips[trip].run];
        if (signAt(run, run.stops[k].s).line === line) return [trip, k];
      }
    }
    return null;
  }

  /** A day's planned departures by platform and second, made the first time they are asked for (and again for a new list). */
  private planned(day: Day): Map<string, Array<[number, number]>> | null {
    const data = this.table.day(day);
    if (!data) return null;
    const kept = this.index.get(day);
    if (kept && kept.trips === data.trips) return kept.at;
    const at = new Map<string, Array<[number, number]>>();
    data.trips.forEach((trip, i) => {
      const run = this.table.runs[trip.run];
      const times = unheld(trip.times, data.holds.get(i) ?? []);
      run.stops.forEach((st, k) => {
        if (!st.stop || st.s < 0 || st.s > run.length || k === run.stops.length - 1) return;
        const key = `${st.stop}|${times[2 * k + 1]}`;
        if (!at.has(key)) at.set(key, []);
        at.get(key)!.push([i, k]);
      });
    });
    this.index.set(day, { trips: data.trips, at });
    return at;
  }
}
