import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { CITY, cityTiles, PLACES, TILE, type Pt } from '../src/game/city/geo';
import { quayWalls, unpack, type TileFile } from '../src/game/city/tiles';
import { CLEAR } from '../src/game/city/aside';
import trackFile from '../src/game/city/osm/tracks.json';
import { readLinks, type TrackFile } from '../src/game/city/trackData';
import { TrackIndex } from '../src/game/city/trackIndex';
import { TRAM_WIDTH } from '../src/game/layout';
import { withoutSigns } from '../src/game/gfx/signs';
import { Physics } from '../src/game/physics';
import { Section } from '../src/game/world/section';
import { streetOsmSteps } from '../src/game/world/streetOsm';

const DIR = 'src/game/city/osm/tiles';
const tile = (key: string) => JSON.parse(readFileSync(`${DIR}/${key}.json`, 'utf8')) as TileFile;
/** Points packed as the files have them: decimeters, each from the one before. */
const pack = (points: Pt[]) => points.flatMap(([x, z], i) => (i ? [Math.round((x - points[i - 1][0]) * 10), Math.round((z - points[i - 1][1]) * 10)] : [x * 10, z * 10]));
/** How long the walls are, all together. */
const length = (walls: Array<[Pt, Pt]>) => walls.reduce((sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);

/** Whether a point (meters, in the game's frame) lies in a square's water. */
function inWater([x, z]: Pt): boolean {
  const t = cityTiles().find(({ rect }) => x >= rect.x0 && x < rect.x1 && z >= rect.z0 && z < rect.z1)!;
  const f = tile(t.key);
  const [px, pz] = [x - f.middle[0], z - f.middle[1]];
  return f.areas.some((area) => {
    if (area[0] !== 2) return false;
    let inside = false;
    for (let at = 1; at < area.length;) {
      const ring = unpack(area, at + 1, area[at]);
      at += 1 + 2 * area[at];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [[xi, zi], [xj, zj]] = [ring[i], ring[j]];
        if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
      }
    }
    return inside;
  });
}

describe('the city\'s squares', () => {
  test('have a file for every square of the city, each in its own middle', () => {
    const keys = new Set(readdirSync(DIR).map((f) => f.replace(/\.json$/, '')));
    for (const t of cityTiles()) {
      expect(keys.has(t.key)).toBe(true);
      const f = tile(t.key);
      expect(f.middle).toEqual([(t.rect.x0 + t.rect.x1) / 2, (t.rect.z0 + t.rect.z1) / 2]);
    }
    expect(keys.size).toBe(((CITY.x1 - CITY.x0) / TILE) * ((CITY.z1 - CITY.z0) / TILE));
  });

  test('wall the quays where the ground meets the water, and leave the bridges open', () => {
    // Brunnsparken's square: Stora Hamnkanalen runs through it, crossed by bridges.
    const f = tile('1_-2');
    const walls = quayWalls(f);
    expect(walls.length).toBeGreaterThan(10);
    // None on the square's own edge, where the canal goes on into the next.
    for (const [a, b] of walls) expect(Math.abs(a[0]) > TILE / 2 - 0.1 && Math.abs(b[0]) > TILE / 2 - 0.1).toBe(false);
    // The bridges leave gaps, but most of the canal is walled: the quays along its streets too.
    const edge = length(quayWalls({ ...f, roads: [] }));
    expect(length(walls)).toBeLessThan(edge - 40);
    expect(length(walls)).toBeGreaterThan(edge * 0.75);
  });

  test('open a quay where a road crosses it, as wide as the road, and not where one runs beside it', () => {
    // A canal 40 m long and 10 m wide, a street 8 m wide along its north quay, and one over it.
    const canal = [2, 4, ...pack([[-20, -5], [20, -5], [20, 5], [-20, 5]])];
    const along = [0, 80, -1, ...pack([[-30, -7], [30, -7]])];
    const over = [0, 80, -1, ...pack([[0, -15], [0, 15]])];
    expect(length(quayWalls({ areas: [canal], roads: [along] }))).toBeCloseTo(100, 3);
    // 4 m each side of the middle, and a meter more: 10 m out of each bank.
    expect(length(quayWalls({ areas: [canal], roads: [over] }))).toBeCloseTo(80, 3);
    // Two carriageways of one bridge, 4 m apart at the quay: one gap from -5 to 19 on each bank, no wall between them.
    const next = [0, 80, -1, ...pack([[14, -15], [14, 15]])];
    expect(length(quayWalls({ areas: [canal], roads: [over, next] }))).toBeCloseTo(100 - 2 * 24, 3);
  });

  test('name only places on land, clear of the trams', () => {
    for (const [name, at] of Object.entries(PLACES)) expect(`${name} ${inWater(at) ? 'in the water' : 'on land'}`).toBe(`${name} on land`);
    // Out of every tram's way: someone put there (the start, a respawn, the gate's scenes) is not pushed aside at once.
    const tracks = new TrackIndex(readLinks(trackFile as unknown as TrackFile));
    for (const [name, [x, z]] of Object.entries(PLACES)) expect(`${name} ${tracks.distance(x, z) >= TRAM_WIDTH / 2 + CLEAR ? 'clear' : `${tracks.distance(x, z).toFixed(2)} m from a track`}`).toBe(`${name} clear`);
  });

  test('build without the square a station street has, with colliders for the walls', () => {
    const f = tile('1_-2');
    const physics = new Physics();
    const s = new Section('tile', [0.3, 0.3, 0.3], true, true);
    const rect = { x0: 250, x1: 500, z0: -500, z1: -250 };
    const built = withoutSigns(() => {
      const it = streetOsmSteps(s, physics, { ...f, entrance: null, urban: true }, {
        y: 18, ox: f.middle[0], oz: f.middle[1], turn: 0, square: null, middle: f.middle, ground: rect, reach: 190, lamps: 48,
        clear: [], walk: { x0: 190, x1: 560, z0: -560, z1: -190 }, inflate: 0, seed: 1,
      });
      let r = it.next();
      while (!r.done) r = it.next();
      return r.value;
    });
    expect(built.colliders.length).toBeGreaterThan(50);
  });
});
