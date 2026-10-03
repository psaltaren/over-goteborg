/**
 * Västtrafik's tram timetable laid on the tracks, into `src/game/city/osm/schedule.json` (`src/game/city/schedule.ts`
 * says what is in it). From Trafiklab's GTFS Regional static feed for Västtrafik (`vt`, CC0), kept in
 * `node_modules/.cache/gtfs/` and fetched only when there is none or `--fetch` asks: the free key allows 50 downloads a
 * month. Needs `scripts/gbg-osm.ts` to have written the tracks first.
 *
 *   bun scripts/gbg-gtfs.ts            (from the feed kept; fetched once if there is none)
 *   bun scripts/gbg-gtfs.ts --fetch    (a fresh feed: one of the month's 50 downloads)
 *
 * 1. Days. A Wednesday, a Saturday and a Sunday in the feed's first whole week stand for every weekday, Saturday and
 *    Sunday: the game shows the timetable of the kind of day it is.
 * 2. Runs. Each tram route's shape is matched to the tracks (`scripts/gbg-match.ts`); a run is its stretch through the
 *    area, with the stops on it, and the stop before and the one after, out of sight.
 * 3. Trips. Each trip's times at the run's stops, with time to stand at a stop (`DWELL`) where the timetable leaves
 *    none, and a minute at a terminus in the area before setting off.
 * 4. Blocks. The day is run trip by trip in the order they come in: a tram that would enter a block another holds, or
 *    one that conflicts with it (`tracks.json`), is held at the stop before for as long as it takes, and the rest of its
 *    trip moves on by as much. The test (`tests/schedule.test.ts`) then checks every second of each day.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { grow, PLAY, toGame, TRACK_REACH, type Pt } from '../src/game/city/geo';
import { blocksIn, covered, DAYS, runBlocks, runPieces, runPosition, type Day, type Run, type RunStop, type ScheduleFile, type Trip } from '../src/game/city/schedule';
import { pointAt, readLinks, type TrackFile } from '../src/game/city/trackData';
import { TRAM_ACCEL } from '../src/game/layout';
import { splitCsv } from '../server/gtfs';
import { Matcher, nearestAlong } from './gbg-match';
import { project } from './gbg-tracks';
import { writeJson } from './osm-lib';

const CACHE = 'node_modules/.cache/gtfs';
const ZIP = `${CACHE}/vt.zip`;
const DIR = `${CACHE}/vt`;
const URL_BASE = 'https://opendata.samtrafiken.se/gtfs/vt/vt.zip';
const OUT = 'src/game/city/osm/schedule.json';
const LICENSE = 'Timetable from Västtrafik through Trafiklab (GTFS Regional), CC0 1.0: https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/';
/** Västtrafik's trams in GTFS's extended route types. */
const TRAM = '900';
/** The least time a tram stands at a stop in the area, in seconds, where the timetable gives arrival and departure as one. */
const DWELL = 15;
/** How long a tram stands at a terminus in the area before it sets off, and after it arrives. */
const LAYOVER_BEFORE = 60;
const LAYOVER_AFTER = 30;
/** Seconds kept clear between one tram leaving a block and the next coming in. */
const MARGIN = 3;
/** A stop further than this from the track it is matched to is taken for a bad match, and its run left out. */
const STOP_OFF = 8;

// ---- 1. The feed. ----

if (process.argv.includes('--fetch') || !existsSync(ZIP)) {
  const key = process.env.TRAFIKLAB_STATIC_KEY;
  if (!key) throw new Error('No TRAFIKLAB_STATIC_KEY in .env.local: a key for GTFS Regional Static data, from developer.trafiklab.se.');
  console.log('Fetching the feed from Trafiklab (one of the free key\'s 50 a month)...');
  const res = await fetch(`${URL_BASE}?key=${key}`);
  if (!res.ok) throw new Error(`Trafiklab: ${res.status} ${(await res.text()).slice(0, 200)}`);
  mkdirSync(CACHE, { recursive: true });
  await Bun.write(ZIP, new Uint8Array(await res.arrayBuffer()));
}
if (!existsSync(`${DIR}/stop_times.txt`) || statSync(ZIP).mtimeMs > statSync(`${DIR}/stop_times.txt`).mtimeMs) {
  mkdirSync(DIR, { recursive: true });
  const unzip = Bun.spawnSync(['unzip', '-oq', ZIP, '-d', DIR]);
  if (unzip.exitCode !== 0) throw new Error(`unzip: ${unzip.stderr.toString()}`);
}

/** The rows of one of the feed's files, as objects keyed by its header, read a line at a time; only those `keep` wants. */
async function rows(name: string, keep: (r: Record<string, string>) => boolean = () => true): Promise<Array<Record<string, string>>> {
  const out: Array<Record<string, string>> = [];
  let header: string[] | null = null;
  let rest = '';
  const decoder = new TextDecoder();
  const take = (line: string) => {
    const cells = splitCsv(line.replace(/\r$/, ''));
    if (!header) {
      header = cells.map((c) => c.replace(/^﻿/, ''));
      return;
    }
    const r = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    if (keep(r)) out.push(r);
  };
  for await (const chunk of Bun.file(`${DIR}/${name}`).stream()) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
    rest = lines.pop()!;
    for (const line of lines) if (line) take(line);
  }
  if (rest) take(rest);
  return out;
}

const seconds = (time: string) => {
  const [h, m, s] = time.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

const [feed] = await rows('feed_info.txt');
const routes = new Map((await rows('routes.txt', (r) => r.route_type === TRAM)).map((r) => [r.route_id, r.route_short_name]));
const trips = new Map((await rows('trips.txt', (r) => routes.has(r.route_id))).map((r) => [r.trip_id, r]));

// The days: the first Wednesday, Saturday and Sunday after the feed's date, each with the services running on it.
const calendar = await rows('calendar_dates.txt', (r) => r.exception_type === '1');
const start = new Date(`${feed.feed_version}T12:00:00Z`);
const dates = {} as Record<Day, string>;
for (const [day, weekday] of [['weekday', 3], ['saturday', 6], ['sunday', 0]] as Array<[Day, number]>) {
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  dates[day] = d.toISOString().slice(0, 10).replace(/-/g, '');
}
const running = Object.fromEntries(DAYS.map((day) => [day, new Set(calendar.filter((r) => r.date === dates[day]).map((r) => r.service_id))])) as Record<Day, Set<string>>;
const wanted = new Set([...trips.values()].filter((t) => DAYS.some((day) => running[day].has(t.service_id))).map((t) => t.trip_id));
console.log(`feed ${feed.feed_version}: ${routes.size} tram routes, ${wanted.size} tram trips on ${DAYS.map((d) => `${d} ${dates[d]}`).join(', ')}`);

const times = new Map<string, Array<{ seq: number; stop: string; arr: number; dep: number; headsign: string }>>();
for (const r of await rows('stop_times.txt', (r) => wanted.has(r.trip_id))) {
  if (!times.has(r.trip_id)) times.set(r.trip_id, []);
  times.get(r.trip_id)!.push({ seq: Number(r.stop_sequence), stop: r.stop_id, arr: seconds(r.arrival_time), dep: seconds(r.departure_time), headsign: r.stop_headsign });
}
for (const list of times.values()) list.sort((a, b) => a.seq - b.seq);
const usedStops = new Set([...times.values()].flatMap((l) => l.map((x) => x.stop)));
const stops = new Map((await rows('stops.txt', (r) => usedStops.has(r.stop_id))).map((r) => [r.stop_id, { name: r.stop_name, platform: r.platform_code, at: toGame(Number(r.stop_lat), Number(r.stop_lon)) }]));
const usedShapes = new Set([...wanted].map((id) => trips.get(id)!.shape_id));
const shapePts = new Map<string, Array<[number, Pt]>>();
for (const r of await rows('shapes.txt', (r) => usedShapes.has(r.shape_id))) {
  if (!shapePts.has(r.shape_id)) shapePts.set(r.shape_id, []);
  shapePts.get(r.shape_id)!.push([Number(r.shape_pt_sequence), toGame(Number(r.shape_pt_lat), Number(r.shape_pt_lon))]);
}

// ---- 2. Runs. ----

const tracks = (await Bun.file('src/game/city/osm/tracks.json').json()) as TrackFile;
const links = readLinks(tracks);
const matcher = new Matcher(links, grow(PLAY, TRACK_REACH));
const report: string[] = [];

/** A run's track as one polyline, for putting its stops on it. */
const runLine = (run: Pick<Run, 'links' | 'from' | 'to'>): Pt[] => {
  const pts: Pt[] = [];
  for (const p of runPieces({ ...run, length: 0, id: 0, line: '', headsign: '', stops: [] }, links)) {
    for (let s = p.s0; s < p.s1; s += 1) pts.push(pointAt(links[p.link].pts, s));
    pts.push(pointAt(links[p.link].pts, p.s1));
  }
  return pts;
};

const runs: Run[] = [];
const runKey = new Map<string, number>();
/** For each pattern (a shape and its stops): its runs, each with the index in the trip's stop list of each run stop. */
const patterns = new Map<string, Array<{ run: number; at: number[]; first: boolean; last: boolean }>>();
const dropped = new Map<string, number>();

function runsOf(tripId: string): Array<{ run: number; at: number[]; first: boolean; last: boolean }> {
  const trip = trips.get(tripId)!;
  const list = times.get(tripId)!;
  const key = `${trip.shape_id}|${list.map((x) => x.stop).join(',')}`;
  if (patterns.has(key)) return patterns.get(key)!;
  const shape = (shapePts.get(trip.shape_id) ?? []).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const along: number[] = [0];
  for (let i = 1; i < shape.length; i++) along.push(along[i - 1] + Math.hypot(shape[i][0] - shape[i - 1][0], shape[i][1] - shape[i - 1][1]));
  // Each stop's place along the shape, in order.
  const u: number[] = [];
  for (const x of list) u.push(nearestAlong(shape, along, stops.get(x.stop)!.at, u.length ? u[u.length - 1] : 0));
  const out: Array<{ run: number; at: number[]; first: boolean; last: boolean }> = [];
  for (const m of shape.length > 1 ? matcher.match(shape) : []) {
    const line = runLine(m);
    const length = line.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]) : 0), 0);
    const inside = list.map((_, i) => i).filter((i) => u[i] >= m.u0 - 5 && u[i] <= m.u1 + 5);
    const runStops: RunStop[] = [];
    const at: number[] = [];
    let before = inside.length ? inside[0] - 1 : -1;
    if (!inside.length) for (let i = 0; i < list.length; i++) if (u[i] < m.u0) before = i;
    const after = inside.length ? inside[inside.length - 1] + 1 : list.findIndex((_, i) => u[i] > m.u1);
    if (before >= 0) {
      runStops.push(stopAt(list[before].stop, Math.min(-1, -(m.u0 - u[before])), 0));
      at.push(before);
    }
    let last = -Infinity, bad = '';
    for (const i of inside) {
      const { d, s } = project(line, stops.get(list[i].stop)!.at);
      const name = `${stops.get(list[i].stop)!.name} ${stops.get(list[i].stop)!.platform}`;
      if (d > STOP_OFF) bad ||= `${name} ${d.toFixed(0)} m off`;
      else if (s < last) bad ||= `${name} out of order`;
      last = s;
      runStops.push(stopAt(list[i].stop, s, d));
      at.push(i);
    }
    if (after >= 0 && after < list.length) {
      runStops.push(stopAt(list[after].stop, Math.max(length + 1, length + (u[after] - m.u1)), 0));
      at.push(after);
    }
    if (bad || runStops.length < 2) {
      const why = `line ${routes.get(trip.route_id)}: ${bad || 'no stops'}`;
      dropped.set(why, (dropped.get(why) ?? 0) + 1);
      continue;
    }
    const headsign = list[0].headsign || stops.get(list[list.length - 1].stop)!.name;
    const k = `${m.links.join(',')}|${m.from.toFixed(1)}|${m.to.toFixed(1)}|${runStops.map((x) => `${x.stop}@${x.s.toFixed(1)}`).join(',')}|${routes.get(trip.route_id)}|${headsign}`;
    if (!runKey.has(k)) {
      runKey.set(k, runs.length);
      runs.push({ id: runs.length, line: routes.get(trip.route_id)!, headsign, links: m.links, from: round2(m.from), to: round2(m.to), length: round2(length), stops: runStops });
    }
    out.push({ run: runKey.get(k)!, at, first: before < 0, last: after < 0 || after >= list.length });
  }
  patterns.set(key, out);
  return out;
}

function stopAt(id: string, s: number, off: number): RunStop {
  const st = stops.get(id)!;
  return { stop: id, name: st.name, platform: st.platform, s: round2(s), off: round2(off) };
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

// ---- 3. Trips. ----

const days = Object.fromEntries(DAYS.map((d) => [d, [] as Trip[]])) as Record<Day, Trip[]>;
for (const day of DAYS) {
  for (const id of wanted) {
    const trip = trips.get(id)!;
    if (!running[day].has(trip.service_id)) continue;
    const list = times.get(id)!;
    for (const { run, at, first, last } of runsOf(id)) {
      const r = runs[run];
      const t: number[] = [];
      at.forEach((i, k) => {
        let arr = list[i].arr;
        const dep = list[i].dep;
        const inArea = r.stops[k].s >= 0 && r.stops[k].s <= r.length;
        if (inArea && k > 0) {
          // Time to stand, taken from the hop before as far as the hop allows (no faster than speeding up and slowing
          // down at `TRAM_ACCEL` all the way).
          const prevDep = t[t.length - 1];
          const fastest = 2 * Math.sqrt((r.stops[k].s - r.stops[k - 1].s) / TRAM_ACCEL);
          arr = Math.max(Math.min(arr, dep - DWELL), Math.min(arr, prevDep + fastest));
        }
        if (k === 0 && first && inArea) arr = dep - LAYOVER_BEFORE;
        t.push(arr, dep);
      });
      if (last && r.stops[r.stops.length - 1].s <= r.length) t[t.length - 1] = t[t.length - 2] + LAYOVER_AFTER;
      days[day].push({ run, times: t });
    }
  }
}
if (dropped.size) report.push(`WARN runs left out (a stop further than ${STOP_OFF} m from the matched track, or out of order): ${[...dropped].map(([k, n]) => `${k} (${n})`).join('; ')}`);

// ---- 4. The block pass. ----

const along = runs.map((r) => runBlocks(r, links, tracks.blocks));
const conflictsOf = new Map<number, number[]>();
for (const [a, b] of tracks.conflicts) {
  conflictsOf.set(a, [...(conflictsOf.get(a) ?? []), b]);
  conflictsOf.set(b, [...(conflictsOf.get(b) ?? []), a]);
}

/** When a trip's tram is in each block: its first and last second there. */
function occupancy(trip: Trip): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const r = runs[trip.run];
  const t0 = Math.ceil(trip.times[0]), t1 = Math.floor(trip.times[trip.times.length - 1]);
  for (let t = t0; t <= t1; t++) {
    const s = runPosition(r, trip.times, t);
    if (s === null) continue;
    const c = covered(r, s);
    if (!c) continue;
    for (const b of blocksIn(along[trip.run], c[0], c[1])) {
      const cur = out.get(b);
      out.set(b, cur ? [cur[0], t] : [t, t]);
    }
  }
  return out;
}

for (const day of DAYS) {
  // First come, first served: in the order the trams reach the first block where they could meet another (a junction,
  // or the area's first block if they meet none), so a tram that gets to Drottningtorget first goes first, whichever
  // came into the area first.
  const list = days[day].map((trip) => ({ trip, enter: firstContested(trip) })).filter((x) => x.enter !== null).sort((a, b) => a.enter! - b.enter!);
  const held = new Map<number, Array<[number, number]>>();
  let holds = 0, most = 0, stuck = 0;
  for (const { trip } of list) {
    let tries = 0;
    for (; tries < 60; tries++) {
      const occ = occupancy(trip);
      // The earliest clash: a block this tram enters while another holds it, or one that conflicts with it.
      let clash: { at: number; until: number } | null = null;
      for (const [b, [a, z]] of occ) {
        for (const other of [b, ...(conflictsOf.get(b) ?? [])]) {
          for (const [oa, oz] of held.get(other) ?? []) {
            if (oa - MARGIN <= z && a <= oz + MARGIN && (!clash || a < clash.at)) clash = { at: a, until: oz + MARGIN + 1 };
          }
        }
      }
      if (!clash) {
        for (const [b, span] of occ) held.set(b, [...(held.get(b) ?? []), span]);
        break;
      }
      // Hold the tram at the last stop it leaves before the clash, by as long as the other needs.
      const shift = Math.max(1, clash.until - clash.at);
      let k = 0;
      for (let i = 0; i < runs[trip.run].stops.length; i++) if (trip.times[2 * i + 1] <= clash.at) k = i;
      for (let j = 2 * k + 1; j < trip.times.length; j++) trip.times[j] += shift;
      trip.held = (trip.held ?? 0) + shift;
      holds++;
      most = Math.max(most, trip.held);
    }
    if (tries >= 60) stuck++;
  }
  const all = days[day].map((t) => t.held ?? 0).sort((a, b) => a - b);
  const median = all[Math.floor(all.length / 2)], p90 = all[Math.floor(all.length * 0.9)];
  report.push(`${day} (${dates[day]}): ${days[day].length} trips through the area, ${days[day].filter((t) => t.held).length} held (${holds} holds), held a median ${median} s, 90% under ${p90} s, at most ${most} s${stuck ? `; WARN ${stuck} could not be cleared` : ''}`);
}

function firstContested(trip: Trip): number | null {
  const occ = occupancy(trip);
  let first: number | null = null;
  for (const [b, [a]] of occ) if (conflictsOf.has(b) && (first === null || a < first)) first = a;
  return first ?? firstIn(trip);
}

function firstIn(trip: Trip): number | null {
  const r = runs[trip.run];
  for (let t = Math.ceil(trip.times[0]); t <= trip.times[trip.times.length - 1]; t++) {
    const s = runPosition(r, trip.times, t);
    if (s !== null && covered(r, s)) return t;
  }
  return null;
}

// ---- Written. ----

for (const day of DAYS) {
  days[day] = days[day].filter((t) => firstIn(t) !== null).map((t) => ({ run: t.run, times: t.times.map((v) => Math.round(v)), ...(t.held ? { held: Math.round(t.held) } : {}) }));
  days[day].sort((a, b) => a.times[0] - b.times[0]);
}
const file: Omit<ScheduleFile, 'runs' | Day> = {
  license: LICENSE,
  format: 'bun scripts/gbg-gtfs.ts. runs: a route\'s stretch through the area, along links of tracks.json (from meters into the first, to into the last), ' +
    'with its stops (s in meters along the run; the stop before the area below 0, the one after past its length). days: per kind of day, each trip as its run ' +
    'and [arrival, departure] at each of the run\'s stops in seconds from the service day\'s start (noon less 12 h), held: seconds the block pass held it.',
  feed: feed.feed_version,
  dates,
};
writeJson(OUT, file, { runs, weekday: days.weekday, saturday: days.saturday, sunday: days.sunday });
console.log(`${runs.length} runs from ${patterns.size} patterns`);
if (matcher.gaps.length) {
  // Where a route's shape could not be followed on the tracks: track the graph lacks, or a turn it does not allow.
  const at = new Map<string, number>();
  for (const [x, z] of matcher.gaps) {
    const k = `${Math.round(x / 10) * 10}, ${Math.round(z / 10) * 10}`;
    at.set(k, (at.get(k) ?? 0) + 1);
  }
  report.unshift(`WARN shapes the tracks could not follow, so their runs break there: ${[...at].sort((a, b) => b[1] - a[1]).map(([k, n]) => `at ${k} (${n})`).join('; ')}`);
}
for (const line of report) console.log(line);
