import { describe, expect, test } from 'bun:test';
import tracks from '../src/game/city/osm/tracks.json';
import { PLAY } from '../src/game/city/geo';
import { FIXES } from '../scripts/gbg-track-fixes';
import { CHORD, curveAt, MIN_RADIUS, prevsOf, readLinks, type TrackFile } from '../src/game/city/trackData';

const file = tracks as unknown as TrackFile;
const links = readLinks(file);
const inPlay = ([x, z]: [number, number]) => x > PLAY.x0 && x < PLAY.x1 && z > PLAY.z0 && z < PLAY.z1;
const prevs = prevsOf(links);

describe('the tram tracks', () => {
  test('carry the map data licence', () => {
    expect(file.license).toContain('Open Database License');
  });

  // A knee where one link meets the next shows as a curve too tight through the junction, in the test below: no
  // separate test of direction, which on a curve changes between any two stretches of track however smooth it is.
  test('run on from each link where its next ones start', () => {
    for (const a of links) {
      for (const id of a.next) {
        const [p, q] = [a.pts[a.pts.length - 1], links[id].pts[0]];
        expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(0.02);
      }
    }
  });

  test(`curve no tighter than ${MIN_RADIUS} m, along every link and on through every junction`, () => {
    // Junctions the fixes accept as tighter, each with its reason (scripts/gbg-track-fixes.ts).
    expect(Object.keys(FIXES.tight).length).toBeLessThanOrEqual(3);
    const tight: string[] = [];
    for (const a of links) {
      for (let s = 0; s <= a.length; s += 1) {
        const near = (node: number, d: number) => (d <= CHORD ? FIXES.tight[node]?.radius : undefined);
        const least = Math.min(MIN_RADIUS, near(a.from, s) ?? MIN_RADIUS, near(a.to, a.length - s) ?? MIN_RADIUS);
        const r = curveAt(links, prevs, a.id, s);
        if (r < least) {
          tight.push(`link ${a.id} at ${s} m: ${r.toFixed(1)} m`);
          break;
        }
      }
    }
    expect(tight).toEqual([]);
  });

  test('neither end nor begin where the player can go: a tram can always go on', () => {
    const into = new Set(links.flatMap((l) => l.next));
    const stuck = links.filter((l) => (!l.next.length && inPlay(l.pts[l.pts.length - 1])) || (!into.has(l.id) && inPlay(l.pts[0])));
    expect(stuck.map((l) => l.id)).toEqual([]);
  });

  test('are cut into blocks that cover every link once, end to end', () => {
    const spans = new Map<number, Array<[number, number]>>();
    for (const b of file.blocks) {
      for (const [link, s0, s1] of b.spans) {
        expect(s1 - s0).toBeLessThanOrEqual(10.01);
        if (!spans.has(link)) spans.set(link, []);
        spans.get(link)!.push([s0, s1]);
      }
    }
    for (const l of links) {
      const list = (spans.get(l.id) ?? []).sort((p, q) => p[0] - q[0]);
      expect(list.length).toBeGreaterThan(0);
      expect(list[0][0]).toBeCloseTo(0, 1);
      expect(list[list.length - 1][1]).toBeCloseTo(l.length, 1);
      for (let k = 1; k < list.length; k++) expect(Math.abs(list[k][0] - list[k - 1][1])).toBeLessThan(0.02);
    }
  });

  test('list each conflict between two blocks once', () => {
    const seen = new Set<string>();
    for (const [a, b] of file.conflicts) {
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(file.blocks.length);
      expect(seen.has(`${a},${b}`)).toBe(false);
      seen.add(`${a},${b}`);
    }
    // The busy junctions have them: Brunnsparken and Drottningtorget are full of switches and crossings.
    expect(file.conflicts.length).toBeGreaterThan(100);
  });

  test('have the stops of the inner city on them', () => {
    for (const s of file.stops) {
      expect(s.s).toBeGreaterThanOrEqual(0);
      expect(s.s).toBeLessThanOrEqual(links[s.link].length + 0.01);
    }
    const names = new Set(file.stops.map((s) => s.name));
    for (const name of ['Brunnsparken', 'Drottningtorget', 'Kungsportsplatsen', 'Domkyrkan', 'Grönsakstorget', 'Järntorget']) expect(names.has(name)).toBe(true);
  });
});
