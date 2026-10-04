import { describe, expect, test } from 'bun:test';
import { stockholmEpoch } from '../src/game/clock';
import { TripTable } from '../src/game/city/tripTable';
import { file, overlaps } from './helpers/overlap';

const table = () => new TripTable(file.runs, { weekday: file.weekday, saturday: file.saturday, sunday: file.sunday });

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
  const found: string[] = [];
  let most = 0;
  for (let t = from; t <= to && found.length < 10; t++) {
    const states = trams.at(t);
    most = Math.max(most, states.length);
    found.push(...overlaps(states, t));
  }
  if (most < 15) found.push(`at most ${most} trams at once: the day did not load`);
  return found;
}

describe('the departures from a stop', () => {
  test('are the trams that leave it next, soonest first, as the trams are seen to leave', () => {
    const trams = table();
    const stop = file.runs.flatMap((r) => r.stops).find((s) => s.name === 'Brunnsparken' && s.platform === 'A1')!.stop;
    const at = stockholmEpoch(2026, 10, 7, 8, 0);
    const next = trams.departures(stop, at, 3);
    expect(next.length).toBe(3);
    for (let k = 1; k < next.length; k++) expect(next[k].at).toBeGreaterThanOrEqual(next[k - 1].at);
    expect(next[0].at).toBeGreaterThanOrEqual(at);
    expect(next[0].at - at).toBeLessThan(600);
    // The first to leave stands at the stop with its doors open just before it leaves, and is gone a few seconds after.
    const standing = trams.at(next[0].at - 4).find((st) => st.stop >= 0 && file.runs[st.run].stops[st.stop].stop === stop && st.line === next[0].line);
    expect(standing).toBeDefined();
  });
});
