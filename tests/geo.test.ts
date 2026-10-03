import { describe, expect, test } from 'bun:test';
import { CITY, cityTiles, PLACES, placeNear, PLAY, TILE, toGame, toLatLon, yawToward } from '../src/game/city/geo';

describe('the city frame', () => {
  test('goes there and back', () => {
    for (const [lat, lon] of [[57.7087, 11.9733], [57.6998, 11.953], [57.72, 11.99]]) {
      const [x, z] = toGame(lat, lon);
      const [lat2, lon2] = toLatLon(x, z);
      expect(Math.abs(lat2 - lat)).toBeLessThan(1e-9);
      expect(Math.abs(lon2 - lon)).toBeLessThan(1e-9);
    }
  });

  test('measures meters as they are, at Gothenburg\'s latitude', () => {
    // The WGS 84 ellipsoid's radii of curvature, in closed form (independent of the series geo.ts uses): meters per
    // degree north (the meridian's M) and east (the prime vertical's N, times the cosine). The frame was once 0.75% short
    // north to south and 0.24% east to west; this holds it to 0.05%.
    const a = 6_378_137, e2 = 0.00669437999014, rad = Math.PI / 180;
    const phi = 57.707 * rad, w = 1 - e2 * Math.sin(phi) ** 2;
    const north = (a * (1 - e2)) / w ** 1.5 * rad, east = (a / Math.sqrt(w)) * Math.cos(phi) * rad;
    const [nx, nz] = toGame(57.716, 11.97), [sx, sz] = toGame(57.698, 11.97);
    expect(Math.abs(Math.hypot(nx - sx, nz - sz) / (0.018 * north) - 1)).toBeLessThan(0.0005);
    const [ex, ez] = toGame(57.707, 11.99), [wx, wz] = toGame(57.707, 11.95);
    expect(Math.abs(Math.hypot(ex - wx, ez - wz) / (0.04 * east) - 1)).toBeLessThan(0.0005);
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

  test('names the inner city\'s places, all where the player may walk', () => {
    for (const [name, [x, z]] of Object.entries(PLACES)) {
      expect(x > PLAY.x0 && x < PLAY.x1 && z > PLAY.z0 && z < PLAY.z1).toBe(true);
      expect(placeNear(x, z).name).toBe(name);
    }
    // Drottningtorget lies east of Brunnsparken, Järntorget furthest west, all along +x as the frame promises.
    expect(PLACES.Drottningtorget[0]).toBeLessThan(PLACES.Brunnsparken[0]);
    expect(PLACES.Järntorget[0]).toBeGreaterThan(PLACES.Grönsakstorget[0]);
  });

  test('turns the player toward a place', () => {
    // Player looks along (-sin yaw, -cos yaw): toward +x is a yaw of -90 degrees.
    expect(yawToward([0, 0], [10, 0])).toBeCloseTo(-Math.PI / 2, 6);
    expect(yawToward([0, 0], [0, -10])).toBeCloseTo(0, 6);
  });
});
