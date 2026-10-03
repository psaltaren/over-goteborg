import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { grow, PLAY } from '../src/game/city/geo';
import schedule from '../src/game/city/osm/schedule.json';
import tracks from '../src/game/city/osm/tracks.json';
import { blocksIn, covered, DAYS, NIGHT_BEFORE, OUT_OF_SERVICE, RunPath, runBlocks, runPieces, runPosition, signAt, unpackTrips, type ScheduleFile, type Trip } from '../src/game/city/schedule';
import { readLinks, type TrackFile } from '../src/game/city/trackData';

const file = schedule as unknown as ScheduleFile;
const track = tracks as unknown as TrackFile;
const links = readLinks(track);

describe('the trams\' day', () => {
  test('has a weekday, a Saturday and a Sunday from one feed, with the city\'s lines', () => {
    expect(new Set(Object.values(file.dates)).size).toBe(3);
    expect(file[DAYS[0]].length).toBeGreaterThan(1500);
    for (const day of DAYS) expect(file[day].length).toBeGreaterThan(1000);
    const lines = new Set(file.runs.map((r) => r.line));
    for (const line of ['1', '2', '3', '4', '5', '6', '7', '9', '10', '11', '12']) expect(lines.has(line)).toBe(true);
    expect(file.license).toContain('CC0');
  });

  test('runs along track that joins up, one link to the next', () => {
    for (const r of file.runs) {
      for (let k = 1; k < r.links.length; k++) expect(links[r.links[k - 1]].next).toContain(r.links[k]);
      expect(r.from).toBeGreaterThanOrEqual(0);
      expect(r.to).toBeLessThanOrEqual(links[r.links[r.links.length - 1]].length + 0.01);
      const pieces = runPieces(r, links);
      const length = pieces.reduce((sum, p) => sum + p.s1 - p.s0, 0);
      expect(Math.abs(length - r.length)).toBeLessThan(0.5);
    }
  });

  test('has its stops in order, and those in the area beside the track', () => {
    // A stop is where Västtrafik puts its platform, beside the track: most within 3 m (88% of the runs' stops in October
    // 2026), some at island platforms up to 5 m off (Brunnsparken, Drottningtorget), and Hagakyrkan's A side 8 m.
    // Further, and a run is taken for a bad match and left out (scripts/gbg-gtfs.ts, STOP_OFF).
    const offs: number[] = [];
    for (const r of file.runs) {
      for (let k = 1; k < r.stops.length; k++) expect(r.stops[k].s).toBeGreaterThan(r.stops[k - 1].s);
      for (const s of r.stops) if (s.s >= 0 && s.s <= r.length) offs.push(s.off);
    }
    expect(Math.max(...offs)).toBeLessThanOrEqual(8);
    expect(offs.filter((d) => d <= 3).length / offs.length).toBeGreaterThanOrEqual(0.85);
  });

  test('has times that run forward', () => {
    for (const day of DAYS) {
      for (const trip of file[day]) {
        expect(trip.times.length).toBe(2 * file.runs[trip.run].stops.length);
        for (let i = 1; i < trip.times.length; i++) expect(trip.times[i]).toBeGreaterThanOrEqual(trip.times[i - 1]);
      }
    }
  });

  test('has a tram standing at any stop in the area take up track, the whole time it stands', () => {
    // So a tram waiting at a terminus is seen by the block pass and this test, not only once it moves.
    for (const r of file.runs) for (const s of r.stops) if (s.s >= 0 && s.s <= r.length) expect(covered(r, s.s)).not.toBeNull();
    for (const day of DAYS) {
      for (const trip of file[day]) {
        const r = file.runs[trip.run], n = r.stops.length;
        if (r.stops[n - 1].s <= r.length) expect(runPosition(r, trip.times, trip.times[2 * n - 1])).toBe(r.stops[n - 1].s);
      }
    }
  });

  test('brings no tram out of thin air: every run comes in from out of sight and goes out of it', () => {
    // A trip that ends in the area goes on as the next that starts there, or out of service to the edge
    // (scripts/gbg-gtfs.ts, step 4): every run starts before its first stop and ends after its last, beyond the fog.
    const near = grow(PLAY, 150);
    const inside = ([x, z]: [number, number]) => x > near.x0 && x < near.x1 && z > near.z0 && z < near.z1;
    for (const r of file.runs) {
      expect(r.stops[0].s).toBeLessThan(0);
      expect(r.stops[r.stops.length - 1].s).toBeGreaterThan(r.length);
      const path = new RunPath(r, links);
      expect(inside(path.point(0)) || inside(path.point(r.length))).toBe(false);
    }
  });

  test('says on its sign where it goes, and out of service where it does not', () => {
    for (const r of file.runs) {
      const signs = r.signs ?? [];
      for (let k = 1; k < signs.length; k++) expect(signs[k].s).toBeGreaterThanOrEqual(signs[k - 1].s);
      for (const st of r.stops) {
        if (st.s < 0 || st.s > r.length) continue;
        // At every stop in the area the tram is in service, with a line and somewhere to go: as it comes in, or once it
        // stands there (the sign changes as a tram arrives where its trip ends, or where one coming in starts).
        const inService = (x: { line: string; headsign: string }) => x.line !== '' && x.headsign !== OUT_OF_SERVICE;
        expect(inService(signAt(r, st.s - 0.01)) || inService(signAt(r, st.s))).toBe(true);
        expect([1, -1]).toContain(st.side);
      }
    }
    expect(file.runs.some((r) => r.signs?.some((x) => x.headsign === OUT_OF_SERVICE))).toBe(true);
  });

  test('gives the game the same trams, packed', () => {
    const dir = 'src/game/city/osm/trams';
    const runs = JSON.parse(readFileSync(`${dir}/runs.json`, 'utf8'));
    expect(runs.runs).toEqual(file.runs);
    expect(runs.dates).toEqual(file.dates);
    for (const day of DAYS) {
      const packed = JSON.parse(readFileSync(`${dir}/${day}.json`, 'utf8'));
      expect(unpackTrips(packed.trips)).toEqual(file[day].map((t) => ({ run: t.run, times: t.times })));
    }
  });

  test('holds trams a little, not long: the queues at the busy stops', () => {
    for (const day of DAYS) {
      const held = file[day].map((t) => t.held ?? 0).sort((a, b) => a - b);
      expect(held[Math.floor(held.length / 2)]).toBeLessThanOrEqual(30);
      expect(held[held.length - 1]).toBeLessThanOrEqual(600);
    }
  });

  const along = file.runs.map((r) => runBlocks(r, links, track.blocks));
  const conflicts = new Map<number, number[]>();
  for (const [a, b] of track.conflicts) {
    conflicts.set(a, [...(conflicts.get(a) ?? []), b]);
    conflicts.set(b, [...(conflicts.get(b) ?? []), a]);
  }
  // Each kind of day with each night that can come before it: any (a holiday runs Sunday's timetable after a weekday).
  for (const [day, before] of DAYS.flatMap((d) => NIGHT_BEFORE[d].map((b) => [d, b] as const))) {
    test(`keeps every tram clear of every other, every second of a ${day} after a ${before} night`, () => {
      // The trams of the night before still out after midnight, on this day's clock.
      const night: Trip[] = file[before].filter((t) => t.times[t.times.length - 1] >= 86_400).map((t) => ({ run: t.run, times: t.times.map((v) => v - 86_400) }));
      const trips = [...file[day], ...night].sort((a, b) => a.times[0] - b.times[0]);
      const t0 = Math.max(0, trips[0].times[0]), t1 = Math.max(...trips.map((t) => t.times[t.times.length - 1]));
      const clashes: string[] = [];
      let next = 0;
      let active: number[] = [];
      for (let t = t0; t <= t1 && clashes.length < 5; t++) {
        while (next < trips.length && trips[next].times[0] <= t) active.push(next++);
        active = active.filter((i) => trips[i].times[trips[i].times.length - 1] >= t);
        const in_ = new Map<number, number>();
        for (const i of active) {
          const r = file.runs[trips[i].run];
          const s = runPosition(r, trips[i].times, t);
          if (s === null) continue;
          const c = covered(r, s);
          if (!c) continue;
          for (const b of blocksIn(along[trips[i].run], c[0], c[1])) {
            const other = in_.get(b);
            if (other !== undefined && other !== i) clashes.push(`${t} s: block ${b} holds two trams`);
            in_.set(b, i);
          }
        }
        for (const [b, i] of in_) {
          for (const c of conflicts.get(b) ?? []) {
            const other = in_.get(c);
            if (other !== undefined && other !== i) clashes.push(`${t} s: blocks ${b} and ${c} conflict and both hold a tram`);
          }
        }
      }
      expect(clashes).toEqual([]);
    }, 60_000);
  }
});
