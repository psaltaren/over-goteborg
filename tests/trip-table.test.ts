import { describe, expect, test } from 'bun:test';
import { stockholmEpoch } from '../src/game/clock';
import schedule from '../src/game/city/osm/schedule.json';
import tracks from '../src/game/city/osm/tracks.json';
import { onTrack, TramPath, type SectionPose } from '../src/game/city/path';
import type { ScheduleFile } from '../src/game/city/schedule';
import { readLinks, type TrackFile } from '../src/game/city/trackData';
import { TripTable, type TramState } from '../src/game/city/tripTable';
import { TRAM_JOINT, TRAM_SECTION_ENDS, TRAM_WIDTH } from '../src/game/layout';

const file = schedule as unknown as ScheduleFile;
const links = readLinks(tracks as unknown as TrackFile);
const table = () => new TripTable(file.runs, { weekday: file.weekday, saturday: file.saturday, sunday: file.sunday });
const paths = file.runs.map((r) => new TramPath(r, links));

/**
 * A tram's sections as rectangles in the plane (middle, facing, half length), those wholly on its run's track: past
 * either end of a run the track goes on straight out of sight, where the game draws no section (`onTrack`).
 */
function footprint(st: TramState): Array<SectionPose & { hl: number }> {
  const length = file.runs[st.run].length;
  return paths[st.run].sections(st.s, TRAM_SECTION_ENDS)
    .map((p, k) => ({ ...p, hl: (TRAM_SECTION_ENDS[k + 1] - TRAM_SECTION_ENDS[k] - TRAM_JOINT) / 2, on: onTrack(st.s, k, length) }))
    .filter((p) => p.on);
}

/** How far two rectangles overlap, by the separating axes: 0 or less when they do not. */
function overlap(a: SectionPose & { hl: number }, b: SectionPose & { hl: number }, hw: number): number {
  let least = Infinity;
  for (const [ax, az] of [[a.dx, a.dz], [-a.dz, a.dx], [b.dx, b.dz], [-b.dz, b.dx]]) {
    const reach = (r: typeof a) => Math.abs(r.hl * (r.dx * ax + r.dz * az)) + Math.abs(hw * (-r.dz * ax + r.dx * az));
    const gap = Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) - reach(a) - reach(b);
    least = Math.min(least, -gap);
  }
  return least;
}

describe('the trams at a moment', () => {
  test('are where the clock puts them, whatever was asked before', () => {
    const base = stockholmEpoch(2026, 10, 7, 7, 30);
    const times = Array.from({ length: 60 }, (_, k) => base + ((k * 7919) % 3600) + k / 10);
    const one = table();
    const asked = times.map((t) => JSON.stringify(one.at(t)));
    // Asked again in the opposite order, and of a fresh table.
    for (let k = times.length - 1; k >= 0; k--) expect(JSON.stringify(one.at(times[k]))).toBe(asked[k]);
    const fresh = table();
    times.forEach((t, k) => expect(JSON.stringify(fresh.at(t))).toBe(asked[k]));
  });

  test('stand still with their doors open only at a stop', () => {
    const t0 = stockholmEpoch(2026, 10, 7, 16, 0);
    const trams = table();
    let opened = 0;
    for (let t = t0; t < t0 + 1800; t += 1) {
      for (const st of trams.at(t)) {
        expect(st.doors).toBeGreaterThanOrEqual(0);
        expect(st.doors).toBeLessThanOrEqual(1);
        if (st.doors > 0) {
          opened++;
          expect(st.stop).toBeGreaterThanOrEqual(0);
          expect(Math.abs(st.speed)).toBeLessThan(1e-6);
        }
      }
    }
    expect(opened).toBeGreaterThan(1000);
  });

  // The weekday rush is the plan's test (docs/PLAN.md, P3); the whole of each kind of day, its night included, costs
  // a few seconds more.
  for (const [what, y, m, d] of [['weekday', 2026, 10, 7], ['Saturday', 2026, 10, 10], ['Sunday', 2026, 10, 11]] as const) {
    test(`never overlap one another, every second of a ${what} and the night after`, () => {
      expect(clear(stockholmEpoch(y, m, d, 4, 0), stockholmEpoch(y, m, d + 1, 3, 0))).toEqual([]);
    }, 120_000);
  }

  // The nights the clocks change, when a service day is 23 or 25 hours long: Saturday's last trams into Sunday's first.
  for (const [what, y, m, d] of [['summer time begins', 2027, 3, 28], ['summer time ends', 2026, 10, 25]] as const) {
    test(`never overlap one another the night ${what}`, () => {
      expect(clear(stockholmEpoch(y, m, d - 1, 22, 0), stockholmEpoch(y, m, d, 9, 0))).toEqual([]);
    }, 120_000);
  }
});

/** Where trams overlap between two moments, a second apart (at most ten). */
function clear(from: number, to: number): string[] {
  const trams = table();
  const hw = TRAM_WIDTH / 2;
  const found: string[] = [];
  let most = 0;
  for (let t = from; t <= to && found.length < 10; t++) {
    const states = trams.at(t);
    most = Math.max(most, states.length);
    const prints = states.map(footprint);
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        const [a, b] = [prints[i], prints[j]];
        if (!a.length || !b.length || Math.hypot(a[0].x - b[0].x, a[0].z - b[0].z) > 100) continue;
        for (const p of a) for (const q of b) {
          const d = overlap(p, q, hw);
          if (d > 0.01) found.push(`${new Date(t * 1000).toISOString()} trams ${states[i].line} ${states[i].headsign} and ${states[j].line} ${states[j].headsign} overlap ${d.toFixed(2)} m at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`);
        }
      }
    }
  }
  if (most < 15) found.push(`at most ${most} trams at once: the day did not load`);
  return found;
}
