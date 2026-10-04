/**
 * Västtrafik's tram timetable laid on the tracks, into `src/game/city/osm/schedule.json` (`src/game/city/schedule.ts`
 * says what is in it). From Trafiklab's GTFS Regional static feed for Västtrafik (`vt`, CC0), kept in
 * `node_modules/.cache/gtfs/` and fetched only when there is none or `--fetch` asks: the free key allows 50 downloads a
 * month. Needs `scripts/gbg-osm.ts` to have written the tracks first.
 *
 *   bun scripts/gbg-gtfs.ts            (from the feed kept; fetched once if there is none)
 *   bun scripts/gbg-gtfs.ts --fetch    (a fresh feed: one of the month's 50 downloads)
 *
 * 1. Days. A Wednesday, a Saturday and a Sunday stand for every weekday, Saturday and Sunday: the first of each in the
 *    five weeks after the feed's date that runs the usual number of trips for its weekday (not a public holiday) and on
 *    which the clocks do not change. The game shows the timetable of the kind of day it is.
 * 2. Runs. Each tram route's shape is matched to the tracks (`scripts/gbg-match.ts`); a run is its stretch through the
 *    area, with the stops on it, and the stop before and the one after, out of sight.
 * 3. Trips. Each trip's times at the run's stops, with time to stand at a stop (`DWELL`) where the timetable leaves
 *    none, and a minute at a terminus in the area before setting off.
 * 4. Ends. No tram comes out of thin air: a trip that ends in the area (a short turn at Drottningtorget) goes on as the
 *    next trip that starts near there, if the track leads there in the time between, so the two are one tram; what is
 *    left runs on out of service to the edge of the area, or in from it.
 * 5. Blocks. The day is run trip by trip in the order they reach the junctions: a tram that would enter a block another
 *    holds, or one that conflicts with it (`tracks.json`), is held at the stop before for as long as it takes, and the
 *    rest of its trip moves on by as much. The trams of every night that run past midnight hold their blocks too, so
 *    any day may follow any other. The test (`tests/schedule.test.ts`) then checks every second of each day, after
 *    each night.
 * 6. Written: `schedule.json` for the scripts and tests, and the game's files in `osm/trams/` (the runs, and each day's
 *    trips packed), which it fetches when it starts.
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { grow, PLAY, toGame, TRACK_REACH, type Pt } from '../src/game/city/geo';
import { Blocks, firstIn, type Held } from '../src/game/city/blocks';
import { DAYS, NIGHT_BEFORE, OUT_OF_SERVICE, packTrips, runPieces, type Day, type Hold, type Run, type RunStop, type ScheduleFile, type Sign, type Trip } from '../src/game/city/schedule';
import { endDir, pointAt, polylineLength, prevsOf, readLinks, startDir, turn, type TrackFile } from '../src/game/city/trackData';
import { TRAM_ACCEL, TRAM_LENGTH } from '../src/game/layout';
import { splitCsv } from '../server/gtfs';
import { Matcher, nearestAlong, type Matched } from './gbg-match';
import { project } from './gbg-tracks';
import { writeJson } from './osm-lib';

const CACHE = 'node_modules/.cache/gtfs';
const ZIP = `${CACHE}/vt.zip`;
const DIR = `${CACHE}/vt`;
const URL_BASE = 'https://opendata.samtrafiken.se/gtfs/vt/vt.zip';
const OUT = 'src/game/city/osm/schedule.json';
/** The game's copy: the runs, and each day's trips packed (`packTrips`). */
const GAME_DIR = 'src/game/city/osm/trams';
/** The stop areas and lines the relay asks Västtrafik about. */
const LIVE = 'src/game/city/osm/live.json';
const LICENSE = 'Timetable from Västtrafik through Trafiklab (GTFS Regional), CC0 1.0: https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/';
/** Västtrafik's trams in GTFS's extended route types. */
const TRAM = '900';
/** The least time a tram stands at a stop in the area, in seconds, where the timetable gives arrival and departure as one. */
const DWELL = 15;
/** How long a tram stands at a terminus in the area before it sets off, and after it arrives. */
const LAYOVER_BEFORE = 60;
const LAYOVER_AFTER = 30;
/** A stop further than this from the track it is matched to is taken for a bad match, and its run left out. */
const STOP_OFF = 8;
/** How fast a tram runs out of service, to or from the edge of the area or between two of its trips (m/s). */
const EMPTY_SPEED = 8;
/** The longest a tram stands where its next trip starts, waiting for it, rather than leave the area and another come. */
const TURN_WAIT = 180;
/** How far past either end of its run a tram coming in or going out of service starts or ends: its length and more. */
const OUT_OF_SIGHT = TRAM_LENGTH + 5;

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

// The days. Each date's tram trips, counted; for each kind of day the first in the five weeks after the feed's date
// that runs the usual number for its weekday (a public holiday runs fewer, a Sunday's timetable) and on which the clocks
// do not change.
const calendar = await rows('calendar_dates.txt', (r) => r.exception_type === '1');
const perService = new Map<string, number>();
for (const t of trips.values()) perService.set(t.service_id, (perService.get(t.service_id) ?? 0) + 1);
const perDate = new Map<string, number>();
for (const r of calendar) perDate.set(r.date, (perDate.get(r.date) ?? 0) + (perService.get(r.service_id) ?? 0));
const feedDate = /^\d{4}-?\d{2}-?\d{2}$/.test(feed.feed_version) ? feed.feed_version.replace(/-/g, '') : [...perDate.keys()].sort()[0];
const asDate = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)), 12));
const keyOf = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
/** Whether Stockholm's clocks change during the day (the offset at its noon differs from the next day's). */
const clocksChange = (d: Date) => {
  const offset = (x: Date) => new Intl.DateTimeFormat('en', { timeZone: 'Europe/Stockholm', timeZoneName: 'shortOffset' }).formatToParts(x).find((p) => p.type === 'timeZoneName')!.value;
  return offset(d) !== offset(new Date(d.getTime() + 86_400_000));
};
const dates = {} as Record<Day, string>;
for (const [day, weekday] of [['weekday', 3], ['saturday', 6], ['sunday', 0]] as Array<[Day, number]>) {
  const candidates: Date[] = [];
  for (let k = 1; k <= 35; k++) {
    const d = asDate(feedDate);
    d.setUTCDate(d.getUTCDate() + k);
    if (d.getUTCDay() === weekday && perDate.has(keyOf(d))) candidates.push(d);
  }
  const counts = new Map<number, number>();
  for (const d of candidates) counts.set(perDate.get(keyOf(d))!, (counts.get(perDate.get(keyOf(d))!) ?? 0) + 1);
  const usual = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
  const pick = candidates.find((d) => perDate.get(keyOf(d)) === usual && !clocksChange(d));
  if (!pick) throw new Error(`No ordinary ${day} in the five weeks after the feed's date (${feedDate}).`);
  dates[day] = keyOf(pick);
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
const prevs = prevsOf(links);
const keep = grow(PLAY, TRACK_REACH);
const matcher = new Matcher(links, keep);
const report: string[] = [];

/** A run's track as one polyline (a point a meter), for putting its stops on it. */
const runLine = (run: Pick<Run, 'links' | 'from' | 'to'>): Pt[] => {
  const pts: Pt[] = [];
  for (const p of runPieces({ ...run, length: 0, id: 0, line: '', headsign: '', stops: [] }, links)) {
    for (let s = p.s0; s < p.s1; s += 1) pts.push(pointAt(links[p.link].pts, s));
    pts.push(pointAt(links[p.link].pts, p.s1));
  }
  return pts;
};

/** The straightest of `options` to come to link `to` from, or go on to from link `from`. */
const straightest = (options: number[], at: (id: number) => number) => options.map((id) => ({ id, t: at(id) })).sort((a, b) => a.t - b.t)[0]?.id;

/**
 * A run's start moved `meters` back along the track a tram comes in on, link by link, as far as there is track: so a
 * tram standing at a terminus where its run starts has its whole length on the run. Back toward `stop` where the run
 * has to reach a stop it starts before (the way that passes nearest it), else the straightest way.
 */
function extendBack(m: Matched, meters: number, stop: Pt | null): Matched {
  let { links: ids, from } = m;
  ids = [...ids];
  let need = meters;
  while (need > 0) {
    if (from >= need) {
      from -= need;
      need = 0;
      break;
    }
    need -= from;
    const first = links[ids[0]];
    const options = prevs[first.id].filter((id) => id !== first.twin);
    const p = stop ? options.map((id) => ({ id, d: project(links[id].pts, stop).d })).sort((a, b) => a.d - b.d)[0]?.id
      : straightest(options, (id) => turn(endDir(links[id].pts), startDir(first.pts)));
    if (p === undefined) {
      from = 0;
      break;
    }
    ids.unshift(p);
    from = links[p].length;
  }
  return { ...m, links: ids, from, u0: m.u0 - (meters - need) };
}

/** A run's end moved `meters` on along the track ahead, as far as there is track. */
function extendOn(m: Matched, meters: number): Matched {
  let { links: ids, to } = m;
  ids = [...ids];
  let need = meters;
  while (need > 0) {
    const last = links[ids[ids.length - 1]];
    if (last.length - to >= need) {
      to += need;
      need = 0;
      break;
    }
    need -= last.length - to;
    const n = straightest(last.next.filter((id) => id !== last.twin), (id) => turn(endDir(last.pts), startDir(links[id].pts)));
    if (n === undefined) {
      to = last.length;
      break;
    }
    ids.push(n);
    to = 0;
  }
  return { ...m, links: ids, to, u1: m.u1 + (meters - need) };
}

/**
 * Where a terminus lies beside a run's track rather than on it (the matching kept to the through track where the shape
 * turns off onto a terminal track in its last few meters), the run's end taken through one of the last few junctions
 * onto the track that passes nearest the stop. `end` says which end: the last stop, or (going back) the first.
 */
function snap(m: Matched, stop: Pt, end: 'last' | 'first'): Matched {
  if (project(runLine(m), stop).d <= 3) return m;
  let best: { ids: number[]; s: number; d: number } | null = null;
  const forward = end === 'last';
  const ids = forward ? m.links : [...m.links].reverse();
  for (let k = ids.length - 1; k >= Math.max(0, ids.length - 4); k--) {
    const explore = (path: number[], depth: number) => {
      const l = links[path[path.length - 1]];
      const pr = project(l.pts, stop);
      if (path.length > 1 && pr.d < (best?.d ?? 3)) best = { ids: [...ids.slice(0, k), ...path], s: pr.s, d: pr.d };
      if (depth >= 3) return;
      for (const n of forward ? l.next : prevs[l.id]) if (n !== l.twin) explore([...path, n], depth + 1);
    };
    explore([ids[k]], 0);
  }
  if (!best) return m;
  const b = best as { ids: number[]; s: number; d: number };
  if (forward) return { ...m, links: b.ids, to: Math.min(links[b.ids[b.ids.length - 1]].length, b.s + 1) };
  const back = [...b.ids].reverse();
  return { ...m, links: back, from: Math.max(0, b.s - 1) };
}

const runs: Run[] = [];
const runKey = new Map<string, number>();
type RunUse = { run: number; at: number[]; first: boolean; last: boolean };
/** For each pattern (a route, its shape, its stops and its signs): its runs, with the trip's stop index of each run stop. */
const patterns = new Map<string, RunUse[]>();
const dropped = new Map<string, number>();
const inKeep = ([x, z]: Pt) => x >= keep.x0 && x <= keep.x1 && z >= keep.z0 && z <= keep.z1;

function runsOf(tripId: string): RunUse[] {
  const trip = trips.get(tripId)!;
  const list = times.get(tripId)!;
  const key = `${trip.route_id}|${trip.shape_id}|${list.map((x) => `${x.stop}:${x.headsign}`).join(',')}`;
  if (patterns.has(key)) return patterns.get(key)!;
  const shape = (shapePts.get(trip.shape_id) ?? []).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const along: number[] = [0];
  for (let i = 1; i < shape.length; i++) along.push(along[i - 1] + Math.hypot(shape[i][0] - shape[i - 1][0], shape[i][1] - shape[i - 1][1]));
  // Each stop's place along the shape, in order.
  const u: number[] = [];
  for (const x of list) u.push(nearestAlong(shape, along, stops.get(x.stop)!.at, u.length ? u[u.length - 1] : 0));
  const out: RunUse[] = [];
  const end = list.length - 1;
  for (let m of shape.length > 1 ? matcher.match(shape) : []) {
    // A terminus in the area belongs to the run even where the matching left off the shape's last meters before it.
    const startsHere = inKeep(stops.get(list[0].stop)!.at) && u[0] < m.u0 + 1 && m.u0 - u[0] < 60;
    const endsHere = inKeep(stops.get(list[end].stop)!.at) && u[end] > m.u1 - 1 && u[end] - m.u1 < 60;
    if (endsHere && u[end] > m.u1) m = extendOn(m, u[end] - m.u1 + 1);
    if (endsHere) m = snap(m, stops.get(list[end].stop)!.at, 'last');
    if (startsHere) m = snap(m, stops.get(list[0].stop)!.at, 'first');
    // A tram standing at a terminus where its run starts has its whole length on the run, on the track it came in on:
    // the run starts that far back behind the stop (`room` is how much it has already, below 0 if the stop lies before).
    const room = u[0] - m.u0;
    if (startsHere || (room >= 0 && room <= TRAM_LENGTH)) m = extendBack(m, TRAM_LENGTH + 5 - room, room < 0 ? stops.get(list[0].stop)!.at : null);
    const line = runLine(m);
    const length = polylineLength(line);
    const inside = list.map((_, i) => i).filter((i) => u[i] >= m.u0 && u[i] <= m.u1);
    const runStops: RunStop[] = [];
    const at: number[] = [];
    let before = inside.length ? inside[0] - 1 : -1;
    if (!inside.length) for (let i = 0; i < list.length; i++) if (u[i] < m.u0) before = i;
    let after = inside.length ? inside[inside.length - 1] + 1 : -1;
    if (!inside.length) after = list.findIndex((_, i) => u[i] > m.u1);
    if (before >= 0) {
      runStops.push(stopAt(list[before].stop, Math.min(-1, -(m.u0 - u[before])), 0, 1));
      at.push(before);
    }
    let last = -Infinity, bad = '';
    for (const i of inside) {
      const { d, s } = project(line, stops.get(list[i].stop)!.at);
      const name = `${stops.get(list[i].stop)!.name} ${stops.get(list[i].stop)!.platform}`;
      if (d > STOP_OFF) bad ||= `${name} ${d.toFixed(0)} m off`;
      else if (s < last) bad ||= `${name} out of order`;
      last = s;
      runStops.push(stopAt(list[i].stop, s, d, sideOf(line, s, stops.get(list[i].stop)!.at)));
      at.push(i);
    }
    if (after >= 0 && after < list.length) {
      runStops.push(stopAt(list[after].stop, Math.max(length + 1, length + (u[after] - m.u1)), 0, 1));
      at.push(after);
    }
    if (bad || runStops.length < 2) {
      const why = `line ${routes.get(trip.route_id)}: ${bad || 'no stops'}`;
      dropped.set(why, (dropped.get(why) ?? 0) + 1);
      continue;
    }
    // The sign a tram on the run shows: as the timetable has it at the run's first stop in the area (it changes along
    // many trips), else where the trip ends.
    const signAt = inside.length ? inside[0] : Math.max(0, before);
    const headsign = list[signAt].headsign || stops.get(list[end].stop)!.name;
    const k = `${m.links.join(',')}|${m.from.toFixed(1)}|${m.to.toFixed(1)}|${runStops.map((x) => `${x.stop}@${x.s.toFixed(1)}`).join(',')}|${routes.get(trip.route_id)}|${headsign}`;
    if (!runKey.has(k)) {
      runKey.set(k, runs.length);
      runs.push({ id: runs.length, line: routes.get(trip.route_id)!, headsign, links: m.links, from: round2(m.from), to: round2(m.to), length: round2(length), stops: runStops });
    }
    out.push({ run: runKey.get(k)!, at, first: before < 0 && inside[0] === 0, last: (after < 0 || after >= list.length) && inside[inside.length - 1] === end });
  }
  patterns.set(key, out);
  return out;
}

function stopAt(id: string, s: number, off: number, side: 1 | -1): RunStop {
  const st = stops.get(id)!;
  return { stop: id, name: st.name, platform: st.platform, s: round2(s), off: round2(off), side };
}

/** Which side of a run's track (`line`) a platform at `p` lies on, `s` meters along it: right unless it is clearly left. */
function sideOf(line: Pt[], s: number, p: Pt): 1 | -1 {
  // The segment that holds `s`, measured along the line (its points are not a meter apart everywhere: a piece's last
  // step is shorter, and a junction's point comes twice).
  let i = 0;
  for (let along = 0; i + 2 < line.length; i++) {
    const len = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    if (along + len >= s && len > 0) break;
    along += len;
  }
  const [ax, az] = line[i], [bx, bz] = line[i + 1];
  // Right of the way (dx, dz) is (-dz, dx): z is to the right looking along +x.
  const right = (p[0] - ax) * -(bz - az) + (p[1] - az) * (bx - ax);
  return right < -0.5 ? -1 : 1;
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
        let dep = list[i].dep;
        const inArea = r.stops[k].s >= 0 && r.stops[k].s <= r.length;
        if (inArea && k > 0) {
          // Time to stand, taken from the hop before as far as the hop allows (no faster than speeding up and slowing
          // down at `TRAM_ACCEL` all the way).
          const prevDep = t[t.length - 1];
          const fastest = 2 * Math.sqrt((r.stops[k].s - r.stops[k - 1].s) / TRAM_ACCEL);
          arr = Math.max(Math.min(arr, dep - DWELL), Math.min(arr, prevDep + fastest));
        }
        // At a terminus in the area the tram stands a while before it sets off, and after it arrives.
        if (k === 0 && first && inArea) arr = dep - LAYOVER_BEFORE;
        if (k === at.length - 1 && last && inArea) dep = arr + LAYOVER_AFTER;
        t.push(arr, dep);
      });
      days[day].push({ run, times: t });
    }
  }
}
if (dropped.size) report.push(`WARN runs left out (a stop further than ${STOP_OFF} m from the matched track, or out of order): ${[...dropped].map(([k, n]) => `${k} (${n})`).join('; ')}`);

// ---- 4. Ends in the area. ----

/** Whether a trip's run starts, or ends, at a stop in the area (a terminus there), rather than out of sight. */
const startsIn = (r: Run) => r.stops[0].s >= 0;
const endsIn = (r: Run) => r.stops[r.stops.length - 1].s <= r.length;

/** Seconds a tram takes over `d` meters out of service, from standing to standing (as `hop` runs it at that time). */
const emptyTime = (d: number) => (d >= (EMPTY_SPEED * EMPTY_SPEED) / TRAM_ACCEL ? d / EMPTY_SPEED + EMPTY_SPEED / TRAM_ACCEL : 2 * Math.sqrt(d / TRAM_ACCEL));

/**
 * The shortest way along the track from link `from` to one `goal` takes (forward over `next`, or backward over the links
 * that lead in), as the links in order from `from`, `from` itself included; never onto a twin (no turning back where a
 * track runs both ways). `from` may be the goal too, the long way round a loop.
 */
function way(from: number, forward: boolean, goal: (id: number) => boolean, limit = 2000): number[] | null {
  const steps = (id: number) => (forward ? links[id].next : prevs[id]).filter((n) => n !== links[id].twin);
  const dist = new Map<number, number>();
  const back = new Map<number, number>();
  const queue: number[] = [];
  for (const n of steps(from)) {
    dist.set(n, links[n].length);
    back.set(n, from);
    queue.push(n);
  }
  while (queue.length) {
    queue.sort((a, b) => dist.get(a)! - dist.get(b)!);
    const u = queue.shift()!;
    if (goal(u)) {
      const path = [u];
      for (let x = back.get(u)!; ; x = back.get(x)!) {
        path.unshift(x);
        if (x === from) break;
      }
      return forward ? path : path.reverse();
    }
    for (const n of steps(u)) {
      const d = dist.get(u)! + links[n].length;
      if (d > limit || d >= (dist.get(n) ?? Infinity)) continue;
      dist.set(n, d);
      back.set(n, u);
      if (!queue.includes(n)) queue.push(n);
    }
  }
  return null;
}

/** Where meters `s` along a run lie: the index of its link in the run, and meters into that link. */
function onLink(run: Pick<Run, 'links' | 'from' | 'to'>, s: number): { k: number; o: number } {
  const pieces = runPieces({ ...run, id: 0, line: '', headsign: '', length: 0, stops: [] }, links);
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k];
    if (s <= p.at + (p.s1 - p.s0) || k === pieces.length - 1) return { k, o: p.s0 + s - p.at };
  }
  return { k: 0, o: run.from };
}

/** Meters along a run of meters `o` into its `k`th link. */
function alongLinks(run: Pick<Run, 'links' | 'from' | 'to'>, k: number, o: number): number {
  const p = runPieces({ ...run, id: 0, line: '', headsign: '', length: 0, stops: [] }, links)[k];
  return p.at + o - p.s0;
}

const signsOf = (r: Run): Sign[] => r.signs ?? [{ s: -1e9, line: r.line, headsign: r.headsign }];

/**
 * Run `b` taken on from the end of run `a` as one tram: `a`'s track, the way from its end to `b`'s (along `b` itself
 * where `a` ends on it, else the shortest way to it), and `b`'s from there on; `b`'s stops and signs moved along. Null
 * where the track does not lead from the one to the other before `b`'s first stop. `merged` when `b` sets out from
 * where `a` stopped (its first stop is `a`'s last).
 */
function joinRuns(a: Run, b: Run): { run: Omit<Run, 'id'>; at: number; merged: boolean } | null {
  const last = a.links[a.links.length - 1];
  const aEnd = a.stops[a.stops.length - 1];
  const firstStop = onLink(b, b.stops[0].s).k;
  const attempt = (seq: number[], joinAt: number): { run: Omit<Run, 'id'>; at: number; merged: boolean } | null => {
    const shape = { links: seq, from: a.from, to: b.to };
    const length = runPieces({ ...shape, id: 0, line: '', headsign: '', length: 0, stops: [] }, links).reduce((sum, p) => sum + p.s1 - p.s0, 0);
    // Each of b's stops by its link and meters into it, on the joined run.
    const shift = (x: RunStop): RunStop => {
      const { k, o } = onLink(b, x.s);
      return { ...x, s: round2(alongLinks(shape, joinAt + k, o)) };
    };
    const bStops = b.stops.map(shift);
    const at = bStops[0].s;
    if (at < aEnd.s - 1) return null;
    const merged = at - aEnd.s < 2;
    const stops = [...a.stops, ...(merged ? bStops.slice(1) : bStops)];
    for (let i = 1; i < stops.length; i++) if (stops[i].s <= stops[i - 1].s) return null;
    // The sign changes as the tram arrives where a's trip ends.
    const signs = [...signsOf(a), ...signsOf(b).map((x, i) => ({ ...x, s: i ? round2(alongLinks(shape, joinAt + onLink(b, x.s).k, onLink(b, x.s).o)) : aEnd.s }))];
    return { run: { line: a.line, headsign: a.headsign, signs, links: seq, from: a.from, to: b.to, length: round2(length), stops }, at, merged };
  };
  // a ends on one of b's links before its first stop: on along it.
  const j = b.links.indexOf(last);
  if (j >= 0 && j <= firstStop) {
    const joined = attempt([...a.links, ...b.links.slice(j + 1)], a.links.length - 1 - j);
    if (joined) return joined;
  }
  // Else the shortest way to one of them (round a loop, back to a's own last link if need be).
  const path = way(last, true, (id) => {
    const k = b.links.indexOf(id);
    return k >= 0 && k <= firstStop;
  }, 1500);
  if (!path) return null;
  const k = b.links.indexOf(path[path.length - 1]);
  return attempt([...a.links, ...path.slice(1), ...b.links.slice(k + 1)], a.links.length + path.length - 2 - k);
}

/** A run that comes in out of service from the edge of the area to the start of `b`, as one: null if no track leads in. */
function headOn(b: Run): Omit<Run, 'id'> | null {
  const path = way(b.links[0], false, (id) => links[id].from === -1) ?? (links[b.links[0]].from === -1 ? [b.links[0]] : null);
  if (!path) return null;
  const seq = [...path.slice(0, -1), ...b.links];
  const shape = { links: seq, from: 0, to: b.to };
  const length = runPieces({ ...shape, id: 0, line: '', headsign: '', length: 0, stops: [] }, links).reduce((sum, p) => sum + p.s1 - p.s0, 0);
  const moved = (s: number) => {
    const { k, o } = onLink(b, s);
    return round2(alongLinks(shape, path.length - 1 + k, o));
  };
  const stops = [{ stop: '', name: OUT_OF_SERVICE, platform: '', s: -OUT_OF_SIGHT, off: 0, side: 1 as const }, ...b.stops.map((x) => ({ ...x, s: moved(x.s) }))];
  const signs = [{ s: -1e9, line: '', headsign: OUT_OF_SERVICE }, ...signsOf(b).map((x, i) => ({ ...x, s: i ? moved(x.s) : stops[1].s }))];
  return { line: b.line, headsign: b.headsign, signs, links: seq, from: 0, to: b.to, length: round2(length), stops };
}

/** A run that goes on out of service from the end of `a` to the edge of the area: null if no track leads out. */
function tailOn(a: Run): Omit<Run, 'id'> | null {
  const last = a.links[a.links.length - 1];
  const path = links[last].to === -1 ? [last] : way(last, true, (id) => links[id].to === -1);
  if (!path) return null;
  const seq = [...a.links, ...path.slice(1)];
  const end = path[path.length - 1];
  const shape = { links: seq, from: a.from, to: links[end].length };
  const length = runPieces({ ...shape, id: 0, line: '', headsign: '', length: 0, stops: [] }, links).reduce((sum, p) => sum + p.s1 - p.s0, 0);
  const aEnd = a.stops[a.stops.length - 1];
  const stops = [...a.stops, { stop: '', name: OUT_OF_SERVICE, platform: '', s: round2(length + OUT_OF_SIGHT), off: 0, side: 1 as const }];
  const signs = [...signsOf(a), { s: aEnd.s, line: '', headsign: OUT_OF_SERVICE }];
  return { line: a.line, headsign: a.headsign, signs, links: seq, from: a.from, to: shape.to, length: round2(length), stops };
}

/** A run made here, kept once however many trips share it. */
function register(r: Omit<Run, 'id'>): number {
  const k = `${r.links.join(',')}|${r.from}|${r.to}|${r.stops.map((x) => `${x.stop}@${x.s}`).join(',')}|${(r.signs ?? []).map((x) => `${x.s}:${x.line}:${x.headsign}`).join(',')}`;
  if (!runKey.has(k)) {
    runKey.set(k, runs.length);
    runs.push({ id: runs.length, ...r });
  }
  return runKey.get(k)!;
}

const joins = new Map<string, ReturnType<typeof joinRuns>>();
const joinOf = (a: number, b: number) => {
  const k = `${a}>${b}`;
  if (!joins.has(k)) joins.set(k, joinRuns(runs[a], runs[b]));
  return joins.get(k)!;
};
const ends = { chained: 0, tails: 0, heads: 0, stranded: 0 };
for (const day of DAYS) {
  const list = days[day];
  const starting = list.filter((t) => startsIn(runs[t.run])).sort((a, b) => a.times[1] - b.times[1]);
  const next = new Map<Trip, Trip>();
  const taken = new Set<Trip>();
  // Earliest arrival first, each on as the earliest trip it can reach in time.
  for (const a of list.filter((t) => endsIn(runs[t.run])).sort((x, y) => x.times[x.times.length - 1] - y.times[y.times.length - 1])) {
    const leaves = a.times[a.times.length - 1];
    for (const b of starting) {
      if (taken.has(b) || b === a) continue;
      const departs = b.times[1];
      if (departs < leaves) continue;
      if (departs - leaves > TURN_WAIT + LAYOVER_BEFORE) break;
      const j = joinOf(a.run, b.run);
      if (!j) continue;
      const arrives = j.merged ? leaves : leaves + emptyTime(j.at - runs[a.run].stops[runs[a.run].stops.length - 1].s);
      if (arrives + DWELL > departs) continue;
      next.set(a, b);
      taken.add(b);
      break;
    }
  }
  const out: Trip[] = [];
  // Each tram's trips in order, from one no other leads to. A join that fails on the trips joined so far (where the
  // rounding of the longer run comes out the other way than the pair's did) ends that tram there, and the trip it
  // would have joined starts a tram of its own.
  const firsts = list.filter((t) => !taken.has(t));
  for (let q = 0; q < firsts.length; q++) {
    const first = firsts[q];
    let run = runs[first.run];
    let times = [...first.times];
    let id = first.run;
    for (let cur = first; next.has(cur); ) {
      const b = next.get(cur)!;
      const j = joinOf(id, b.run);
      if (!j) {
        firsts.push(b);
        break;
      }
      const leaves = times[times.length - 1];
      if (j.merged) times = [...times.slice(0, -1), b.times[1], ...b.times.slice(2)];
      else times = [...times, leaves + emptyTime(j.at - run.stops[run.stops.length - 1].s), ...b.times.slice(1)];
      id = register(j.run);
      run = runs[id];
      cur = b;
      ends.chained++;
    }
    if (startsIn(run)) {
      const h = headOn(run);
      if (h) {
        id = register(h);
        const enters = times[0] - emptyTime(runs[id].stops[1].s + OUT_OF_SIGHT);
        times = [enters, enters, ...times];
        run = runs[id];
        ends.heads++;
      } else ends.stranded++;
    }
    if (endsIn(run)) {
      const t = tailOn(run);
      if (t) {
        id = register(t);
        const leaves = times[times.length - 1];
        const gone = leaves + emptyTime(runs[id].stops[runs[id].stops.length - 1].s - run.stops[run.stops.length - 1].s);
        times = [...times, gone, gone];
        run = runs[id];
        ends.tails++;
      } else ends.stranded++;
    }
    out.push({ run: id, times });
  }
  days[day] = out;
}
report.push(`ends in the area: ${ends.chained} trips joined to the one before as one tram, ${ends.heads} coming in and ${ends.tails} going out out of service${ends.stranded ? `; WARN ${ends.stranded} with no track to or from the edge` : ''}`);

// ---- 5. The block pass. ----

const blocks = new Blocks(runs, links, tracks.blocks, tracks.conflicts);

/**
 * One kind of day's block pass, with the blocks the night before holds already taken: its trips in the order they
 * reach the first block where they could meet another (first come, first served, so a tram that gets to Drottningtorget
 * first goes first, whichever came into the area first), each held at the stop before a clash for as long as it takes
 * (`Blocks.clear`).
 */
function blockPass(day: Day, night: Held) {
  const list = days[day].map((trip) => ({ trip, enter: blocks.firstContested(trip.run, trip.times) })).filter((x) => x.enter !== null).sort((a, b) => a.enter! - b.enter!);
  const held: Held = new Map([...night].map(([b, spans]) => [b, [...spans]]));
  let holds = 0, stuck = 0;
  for (const { trip } of list) {
    const result = blocks.clear(trip.run, trip.times, held);
    if (result.holds.length) {
      trip.holds = result.holds;
      trip.held = result.holds.reduce((sum, [, shift]) => sum + shift, 0);
      holds += result.holds.length;
    }
    if (!result.cleared) stuck++;
  }
  return { holds, stuck, held };
}

/** The blocks a day's trams hold after its midnight, on the next day's clock. */
function pastMidnight(held: Held): Held {
  const out: Held = new Map();
  for (const [b, spans] of held) {
    const late = spans.filter(([, z]) => z >= 86_400).map(([a, z]) => [a - 86_400, z - 86_400] as [number, number]);
    if (late.length) out.set(b, late);
  }
  return out;
}

// Twice: once alone, then each day again with what every night holds taken from the first round (any day may follow
// any other: a holiday). The nights run late in the evening, which the morning's holds do not reach, so they come out of
// the second round the same.
const original = Object.fromEntries(DAYS.map((d) => [d, days[d].map((t) => [...t.times])])) as Record<Day, number[][]>;
const firstRound = Object.fromEntries(DAYS.map((d) => [d, blockPass(d, new Map()).held])) as Record<Day, Held>;
for (const day of DAYS) {
  days[day].forEach((t, i) => {
    t.times = [...original[day][i]];
    delete t.held;
    delete t.holds;
  });
  const night: Held = new Map();
  for (const before of NIGHT_BEFORE[day]) for (const [b, spans] of pastMidnight(firstRound[before])) night.set(b, [...(night.get(b) ?? []), ...spans]);
  const { holds, stuck } = blockPass(day, night);
  const all = days[day].map((t) => t.held ?? 0).sort((a, b) => a - b);
  const median = all[Math.floor(all.length / 2)], p90 = all[Math.floor(all.length * 0.9)];
  report.push(`${day} (${dates[day]}): ${days[day].length} trips through the area, ${days[day].filter((t) => t.held).length} held (${holds} holds), held a median ${median} s, 90% under ${p90} s, at most ${all[all.length - 1]} s${stuck ? `; WARN ${stuck} could not be cleared` : ''}`);
}

// ---- 6. Written. ----

for (const day of DAYS) {
  days[day] = days[day].filter((t) => firstIn(runs[t.run], t.times) !== null).map((t) => ({ run: t.run, times: t.times.map((v) => Math.round(v)), ...(t.held ? { held: Math.round(t.held), holds: t.holds!.map(([k, shift]) => [k, Math.round(shift)] as Hold) } : {}) }));
  days[day].sort((a, b) => a.times[0] - b.times[0]);
}
// Only the runs some trip takes (a trip joined to the next leaves its own run unused), numbered again in order.
const used = [...new Set(DAYS.flatMap((d) => days[d].map((t) => t.run)))].sort((a, b) => a - b);
const renumber = new Map(used.map((old, i) => [old, i]));
const kept = used.map((old, i) => ({ ...runs[old], id: i }));
runs.length = 0;
runs.push(...kept);
for (const day of DAYS) for (const t of days[day]) t.run = renumber.get(t.run)!;
const file: Omit<ScheduleFile, 'runs' | Day> = {
  license: LICENSE,
  format: 'bun scripts/gbg-gtfs.ts. runs: a route\'s stretch through the area, along links of tracks.json (from meters into the first, to into the last), ' +
    'with its stops (s in meters along the run; the stop before the area below 0, the one after past its length). Per kind of day (weekday, saturday, sunday), ' +
    'each trip as its run and [arrival, departure] at each of the run\'s stops in seconds from the service day\'s start (noon less 12 h), held: seconds the block pass held it. ' +
    'A run that is one tram\'s trips joined, or that runs out of service to or from the edge of the area, has signs: what its sign says from s meters on.',
  feed: feed.feed_version,
  dates,
};
writeJson(OUT, file, { runs, weekday: days.weekday, saturday: days.saturday, sunday: days.sunday });
// The game's: the runs, and each day's trips packed, fetched apart so a day's are all it waits for.
rmSync(GAME_DIR, { recursive: true, force: true });
mkdirSync(GAME_DIR, { recursive: true });
writeJson(`${GAME_DIR}/runs.json`, { license: LICENSE, format: 'As schedule.json\'s runs (bun scripts/gbg-gtfs.ts).', feed: feed.feed_version, dates }, { runs });
for (const day of DAYS) {
  writeJson(`${GAME_DIR}/${day}.json`, {
    license: LICENSE,
    format: 'trips: each as [run, then its times as whole seconds, each from the one before] (packTrips in src/game/city/schedule.ts). ' +
      'holds: [a trip\'s place in the list, where the block pass held it as [[stop index (-1 the whole trip), seconds], ...]]: its times less these are Västtrafik\'s.',
  }, { trips: packTrips(days[day]), holds: days[day].flatMap((t, i) => (t.holds ? [[i, t.holds]] : [])) });
}
// What the relay asks Västtrafik about (server/vasttrafik.ts): the stop areas the trams stop at in the area, with their
// tram platforms, and the tram lines through it, by Västtrafik's ids (GTFS Regional's are the same).
const areas = new Map<string, { gid: string; name: string; platforms: Set<string> }>();
for (const r of runs) {
  for (const st of r.stops) {
    if (!st.stop || st.s < 0 || st.s > r.length) continue;
    const gid = `${st.stop.slice(0, 3)}1${st.stop.slice(4, 13)}000`;
    if (!areas.has(gid)) areas.set(gid, { gid, name: st.name, platforms: new Set() });
    areas.get(gid)!.platforms.add(st.platform);
  }
}
const inService = new Set(runs.flatMap((r) => [r.line, ...(r.signs ?? []).map((x) => x.line)]).filter(Boolean));
writeJson(LIVE, { license: LICENSE, format: 'bun scripts/gbg-gtfs.ts. areas: the stop areas with stops in the area, with their tram platforms; lines: the tram lines through it, each with its route ids (Västtrafik\'s line gids).' }, {
  areas: [...areas.values()].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ gid: a.gid, name: a.name, platforms: [...a.platforms].sort() })),
  lines: [...inService].sort((a, b) => a.localeCompare(b, 'sv', { numeric: true })).map((line) => ({ line, gids: [...routes].filter(([, name]) => name === line).map(([id]) => id).sort() })),
});
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
