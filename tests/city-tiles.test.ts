import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { CITY, cityTiles, TILE } from '../src/game/city/geo';
import { quayWalls, type TileFile } from '../src/game/city/tiles';
import { withoutSigns } from '../src/game/gfx/signs';
import { Physics } from '../src/game/physics';
import { Section } from '../src/game/world/section';
import { streetOsmSteps } from '../src/game/world/streetOsm';

const DIR = 'src/game/city/osm/tiles';
const tile = (key: string) => JSON.parse(readFileSync(`${DIR}/${key}.json`, 'utf8')) as TileFile;

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
    // Fewer walls than water edge: the roads over the canal leave gaps.
    const withoutRoads = quayWalls({ ...f, roads: [] });
    expect(withoutRoads.length).toBeGreaterThan(walls.length);
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
