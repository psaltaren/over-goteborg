import { describe, expect, test } from 'bun:test';
import { stockholmEpoch } from '../src/game/clock';
import { Blocks, unheld } from '../src/game/city/blocks';
import { LiveMatcher, type LiveDeparture } from '../src/game/city/liveMatch';
import { HORIZON, LivePlanner, type Live } from '../src/game/city/livePlan';
import tracks from '../src/game/city/osm/tracks.json';
import { serviceDays } from '../src/game/city/serviceDay';
import type { TrackFile } from '../src/game/city/trackData';
import { tripId, TripTable } from '../src/game/city/tripTable';
import { file, links, overlaps } from './helpers/overlap';

const track = tracks as unknown as TrackFile;
const table = () => new TripTable(file.runs, { weekday: file.weekday, saturday: file.saturday, sunday: file.sunday });
const blocks = () => new Blocks(file.runs, links, track.blocks, track.conflicts);

/** A small seeded random number generator, so a failing run can be run again. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A made-up morning of Västtrafik's: each line late by its own amount, drifting over the morning (a third of them on
 * time, the rest up to four minutes late), each trip a little more or less (up to a minute early), drifting from stop to
 * stop, one trip in fifty cancelled and a tenth of the departures without word from the tram. What the relay would pass
 * on at `epoch`: the departures of the next 45 minutes.
 */
function morning(trams: TripTable, seed: number) {
  const rnd = random(seed);
  const lines = new Map<string, { most: number; phase: number }>();
  const trips = new Map<number, { own: number; drift: number; cancelled: boolean; silent: number }>();
  return (epoch: number): LiveDeparture[] => {
    const out: LiveDeparture[] = [];
    for (const sd of serviceDays(epoch)) {
      const data = trams.day(sd.day)!;
      data.trips.forEach((trip, i) => {
        const run = file.runs[trip.run];
        const planned = unheld(trip.times, data.holds.get(i) ?? []);
        const id = tripId(sd.start, i);
        if (sd.start + planned[1] > epoch + 45 * 60 || sd.start + planned[planned.length - 1] < epoch - 60) return;
        if (!trips.has(id)) trips.set(id, { own: 90 * rnd() - 45, drift: 20 * (rnd() - 0.5), cancelled: rnd() < 0.02, silent: rnd() });
        const said = trips.get(id)!;
        run.stops.forEach((st, k) => {
          if (!st.stop || st.s < 0 || st.s > run.length || k === run.stops.length - 1) return;
          const at = sd.start + planned[2 * k + 1];
          if (at < epoch - 60 || at > epoch + 45 * 60) return;
          const line = (run.signs ?? []).reduce((l, x) => (x.s <= st.s ? x.line : l), run.line);
          if (!lines.has(line)) lines.set(line, { most: rnd() < 0.33 ? 0 : 240 * rnd(), phase: 6 * rnd() });
          const { most, phase } = lines.get(line)!;
          const delay = Math.max(-60, most * (0.5 + 0.5 * Math.sin(at / 1800 + phase)) + said.own + said.drift * k);
          out.push([st.stop, line, at, said.cancelled || said.silent < 0.1 ? null : Math.round(at + delay), said.cancelled ? 1 : 0]);
        });
      });
    }
    return out;
  };
}

describe('the live plan', () => {
  test('without word from Västtrafik, is the timetable', () => {
    const trams = table();
    new LivePlanner(trams, blocks()).plan(stockholmEpoch(2026, 10, 7, 7, 30), new Map());
    expect(trams.planned).toBe(0);
  });

  test('matches every departure to its trip by platform and planned time', () => {
    const trams = table();
    const at = stockholmEpoch(2026, 10, 7, 8, 0);
    const said = morning(trams, 7)(at);
    const live = new LiveMatcher(trams).match(said, at);
    const heard = said.filter(([, , , expected, cancelled]) => expected !== null || cancelled);
    // Each trip's departures with word of it, at each stop it has one.
    const matched = [...live.values()].reduce((n, l) => n + (l.cancelled ? 0 : l.leaves.size), 0);
    expect(heard.length).toBeGreaterThan(300);
    expect(matched).toBe(said.filter(([, , , expected, cancelled]) => expected !== null && !cancelled).length);
    expect([...live.values()].some((l) => l.cancelled)).toBe(true);
  });

  // The plan's promise: trams follow Västtrafik, and still no two ever meet and none ever jumps, through a morning of
  // made-up delays planned again every half minute, and then back on the timetable once the word stops.
  test('runs late as Västtrafik says, with no tram overlapping another or jumping, and falls back when the word stops', () => {
    const trams = table();
    const planner = new LivePlanner(trams, blocks());
    const matcher = new LiveMatcher(trams);
    // A delay passes on to the trams behind, held so as not to meet the late one, so in the rush the timetable comes
    // back an hour or so after the last word: an hour and a quarter is allowed.
    const from = stockholmEpoch(2026, 10, 7, 7, 0), stop = from + 90 * 60, to = stop + HORIZON + 45 * 60;
    const said = morning(trams, 11);
    const problems: string[] = [];
    const last = new Map<number, number>();
    let live = new Map<number, Live>();
    let shown = 0, lateTrips = 0;
    for (let t = from; t <= to && problems.length < 10; t++) {
      if ((t - from) % 30 === 0) {
        live = t < stop ? matcher.match(said(t), t) : new Map();
        planner.plan(t, live);
      }
      const states = trams.at(t);
      problems.push(...overlaps(states, t));
      const seen = new Set<number>();
      for (const st of states) {
        seen.add(st.id);
        const before = last.get(st.id);
        if (before !== undefined && (st.s - before < -0.01 || st.s - before > 25)) problems.push(`${new Date(t * 1000).toISOString()} tram ${st.line} ${st.headsign} jumped ${(st.s - before).toFixed(1)} m`);
        last.set(st.id, st.s);
        // A tram leaving a stop Västtrafik expects it at, when it was planned with that word: on time, or held.
        if (st.stop >= 0 && st.speed === 0 && t < stop) {
          const plan = trams.planOf(st.id);
          if (plan) lateTrips++;
        }
      }
      for (const id of last.keys()) if (!seen.has(id)) last.delete(id);
      shown = Math.max(shown, states.length);
    }
    expect(problems).toEqual([]);
    expect(shown).toBeGreaterThan(15);
    expect(lateTrips).toBeGreaterThan(0);
    // The word stopped an hour and a quarter ago: every tram keeps the timetable again.
    expect(trams.planned).toBe(0);
    // How closely the plan follows the word. Never earlier than Västtrafik says; later where the block pass holds a tram
    // behind another (the timetable itself holds trams a median 17 s to fit them on the track, and delays scatter them):
    // in this morning a median under a minute, nine in ten within three.
    const trams2 = table();
    const planner2 = new LivePlanner(trams2, blocks());
    const at = stockholmEpoch(2026, 10, 7, 8, 0);
    const word = new LiveMatcher(trams2).match(morning(trams2, 3)(at), at);
    planner2.plan(at, word);
    const off: number[] = [];
    for (const [id, l] of word) {
      const plan = trams2.planOf(id);
      if (!plan || l.cancelled) continue;
      const start = Math.floor(id / 10_000);
      for (const [k, expected] of l.leaves) if (start + plan[1] > at + 15) off.push(start + plan[2 * k + 1] - expected);
    }
    off.sort((a, b) => a - b);
    expect(off.length).toBeGreaterThan(100);
    expect(off[0]).toBeGreaterThanOrEqual(0);
    expect(off[Math.floor(off.length / 2)]).toBeLessThan(60);
    expect(off[Math.floor(off.length * 0.9)]).toBeLessThan(180);
  }, 300_000);

  test('takes a cancelled trip off the departure boards, and a trip it has made late puts there late', () => {
    const trams = table();
    const at = stockholmEpoch(2026, 10, 7, 8, 0);
    const stop = file.runs.flatMap((r) => r.stops).find((s) => s.name === 'Brunnsparken' && s.platform === 'A1')!.stop;
    const before = trams.departures(stop, at + 20 * 60, 2);
    expect(before.length).toBe(2);
    // The first of them cancelled, by word of the departure itself.
    // Today's service day (yesterday's, a weekday too, runs on past midnight).
    const sd = serviceDays(at).reduce((a, b) => (b.start > a.start ? b : a));
    const data = trams.day('weekday')!;
    const first = data.trips.findIndex((trip) => {
      const run = file.runs[trip.run];
      return run.stops.some((s, k) => s.stop === stop && sd.start + trip.times[2 * k + 1] === before[0].at);
    });
    expect(first).toBeGreaterThanOrEqual(0);
    const trip = data.trips[first];
    const k = file.runs[trip.run].stops.findIndex((s) => s.stop === stop);
    const planned = sd.start + unheld(trip.times, data.holds.get(first) ?? [])[2 * k + 1];
    const live = new LiveMatcher(trams).match([[stop, before[0].line, planned, null, 1]], at);
    expect(live.get(tripId(sd.start, first))?.cancelled).toBe(true);
    new LivePlanner(trams, blocks()).plan(at, live);
    const after = trams.departures(stop, at + 20 * 60, 2);
    expect(after[0].at).not.toBe(before[0].at);
    expect(after[0].at).toBeGreaterThanOrEqual(before[1].at - 1);
    // And four minutes late instead: it leaves four minutes later, on the board as in the street.
    const later = new LiveMatcher(trams).match([[stop, before[0].line, planned, planned + 240, 0]], at);
    new LivePlanner(trams, blocks()).plan(at + 1, later);
    const left = trams.departures(stop, at + 20 * 60, 4).map((d) => d.at);
    const leaves = sd.start + trams.planOf(tripId(sd.start, first))![2 * k + 1];
    expect(leaves).toBeGreaterThanOrEqual(planned + 240);
    expect(left).toContain(leaves);
    // And a rider on it is told how late it is, against Västtrafik's own time: four minutes, and as long again as the
    // block pass holds it behind the trams it now meets.
    const late = trams.lateAt(tripId(sd.start, first), k)!;
    expect(late).toBeGreaterThanOrEqual(240);
    expect(late).toBeLessThan(420);
  });

  test('starts afresh when the clock jumps', () => {
    const trams = table();
    const planner = new LivePlanner(trams, blocks());
    const at = stockholmEpoch(2026, 10, 7, 8, 0);
    planner.plan(at, new LiveMatcher(trams).match(morning(trams, 5)(at), at));
    expect(trams.planned).toBeGreaterThan(0);
    planner.plan(at + 3 * 3600, new Map());
    expect(trams.planned).toBe(0);
  });
});
