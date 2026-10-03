import { describe, expect, test } from 'bun:test';
import { CITY, cityTiles, PLAY, TILE, toGame, toLatLon } from '../src/game/city/geo';

describe('the city frame', () => {
  test('goes there and back', () => {
    for (const [lat, lon] of [[57.7087, 11.9733], [57.6998, 11.953], [57.72, 11.99]]) {
      const [x, z] = toGame(lat, lon);
      const [lat2, lon2] = toLatLon(x, z);
      expect(Math.abs(lat2 - lat)).toBeLessThan(1e-9);
      expect(Math.abs(lon2 - lon)).toBeLessThan(1e-9);
    }
  });

  test('runs along Västlänken at Centralen, toward Haga', () => {
    // The ends of Västlänken's track 22 either side of Centralen, from OSM: east of the station, then toward Haga.
    const [ax, az] = toGame(57.7121742, 11.978778);
    const [bx, bz] = toGame(57.710042, 11.9659424);
    expect(bx).toBeGreaterThan(ax + 700);
    // Within a few degrees of +x: the tunnel bends a little past the platforms.
    expect(Math.abs(Math.atan2(bz - az, bx - ax))).toBeLessThan((5 * Math.PI) / 180);
  });

  test('keeps right as the game does: z to the right of +x', () => {
    // Heading west-south-west, the river (north) is on the right, the inner city (south) on the left.
    expect(toGame(57.7135, 11.9666)[1]).toBeGreaterThan(0);
    expect(toGame(57.7044, 11.969)[1]).toBeLessThan(0);
  });

  test('has the inner city in the playable area', () => {
    const inside = ([x, z]: [number, number]) => x > PLAY.x0 && x < PLAY.x1 && z > PLAY.z0 && z < PLAY.z1;
    for (const [lat, lon] of [[57.7071, 11.9708], [57.7068, 11.9612], [57.7044, 11.969], [57.7027, 11.9603], [57.6998, 11.953]]) {
      expect(inside(toGame(lat, lon))).toBe(true);
    }
  });

  test('cuts the city into whole squares round the playable area', () => {
    const tiles = cityTiles();
    expect(tiles.length).toBe(((CITY.x1 - CITY.x0) / TILE) * ((CITY.z1 - CITY.z0) / TILE));
    expect(CITY.x0).toBeLessThanOrEqual(PLAY.x0 - TILE);
    expect(CITY.z1).toBeGreaterThanOrEqual(PLAY.z1 + TILE);
    expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length);
  });
});
