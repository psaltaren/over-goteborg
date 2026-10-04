import { describe, expect, test } from 'bun:test';
import { PLAY, STREET_Y } from '../src/game/city/geo';
import file from '../src/game/city/osm/underground.json';
import tracks from '../src/game/city/osm/tracks.json';
import { readLinks, type TrackFile } from '../src/game/city/trackData';
import { TrackIndex } from '../src/game/city/trackIndex';
import { RAIL_CENTRALEN, RAIL_HAGA, Underground, type UndergroundFile } from '../src/game/city/underground';
import type { CityWorld } from '../src/game/city/world';
import { VL } from '../src/game/layout';
import type { Physics } from '../src/game/physics';

/** Västlänken laid out, with nothing built: a world that only notes what is queued. */
function underground(): { u: Underground; queued: Array<{ under: boolean }> } {
  const queued: Array<{ under: boolean }> = [];
  const world = { later: (_rect: unknown, _build: unknown, _release: unknown, _ready: unknown, under = false) => queued.push({ under }) } as unknown as CityWorld;
  return { u: new Underground(file as unknown as UndergroundFile, {} as Physics, world), queued };
}
const index = new TrackIndex(readLinks(tracks as unknown as TrackFile));

describe('Västlänken', () => {
  test('its line runs unbroken from east of Centralen\'s platforms, straight through the station, to past Haga', () => {
    const spine = file.spine as Array<[number, number]>;
    for (let i = 1; i < spine.length; i++) expect(Math.hypot(spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1])).toBeLessThan(5.5);
    expect(spine[0][0]).toBeLessThan(-106);
    // Along x through the platforms, between the two middle tracks.
    for (const [x, z] of spine) if (x > -106 && x < 156) expect(Math.abs(z + 2.3)).toBeLessThan(1.5);
    expect(Math.min(...spine.map((p) => p[1]))).toBeLessThan(-1400);
  });

  test('lies as deep as Trafikverket builds it, falling gently and never climbing from Centralen to Haga', () => {
    const { u } = underground();
    expect(u.spine.frame(u.at.platformsE).y).toBeCloseTo(RAIL_CENTRALEN, 5);
    expect(STREET_Y - RAIL_CENTRALEN).toBeCloseTo(VL.depthCentralen, 5);
    expect(u.spine.frame(u.at.haga + 50).y).toBeCloseTo(RAIL_HAGA, 5);
    let last = Infinity;
    for (let s = 0; s < u.spine.length; s += 5) {
      const { y } = u.spine.frame(s);
      expect(y).toBeLessThanOrEqual(last + 1e-9);
      if (last < Infinity) expect((last - y) / 5).toBeLessThan(0.01);
      last = y;
    }
  });

  test('has its parts in order along the line, and every one of them queued under the street but the ways up', () => {
    const { u, queued } = underground();
    const order = [u.at.platformsE, u.at.platformsW, u.at.station, u.at.throat, u.at.railsEnd, u.at.rock, u.at.hoist, u.at.haga];
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(u.at.haga + VL.haga.dug + VL.haga.pilots).toBeLessThanOrEqual(u.spine.length);
    expect(queued.filter((q) => !q.under).length).toBe(2);
    expect(queued.filter((q) => q.under).length).toBeGreaterThan(10);
  });

  test('is reached from the street where one may walk, clear of the trams, and each way lands where one can stand', () => {
    const { u } = underground();
    const street = u.doors.filter((d) => Math.abs(d.y - STREET_Y) < 0.1);
    const below = u.doors.filter((d) => d.y < STREET_Y - 5);
    expect(street.length).toBe(2);
    expect(below.length).toBe(2);
    for (const d of street) {
      expect(d.x).toBeGreaterThan(PLAY.x0 + 1);
      expect(d.x).toBeLessThan(PLAY.x1 - 1);
      expect(d.z).toBeGreaterThan(PLAY.z0 + 1);
      expect(d.z).toBeLessThan(PLAY.z1 - 1);
      expect(index.distance(d.x, d.z)).toBeGreaterThan(8);
    }
    // Down the hoist: out onto the tunnel's walkway, beside the line.
    const down = u.doors.find((d) => d.to && d.under)!;
    const { d: off } = u.spine.locate(down.to!.x, down.to!.z);
    expect(off).toBeLessThan(VL.tunnel.half);
    expect(down.to!.y).toBeLessThan(STREET_Y - 15);
    // Up again (the hoist, and the emergency exit): onto the street, in the playable area, outside the door stepped in.
    for (const d of u.doors.filter((x) => x.to && !x.under)) {
      expect(d.to!.y).toBeCloseTo(STREET_Y + 0.05, 5);
      expect(d.to!.z).toBeLessThan(PLAY.z1 - 1);
      expect(d.to!.z).toBeGreaterThan(PLAY.z0 + 1);
      const back = u.doorAt({ x: d.to!.x, y: d.to!.y, z: d.to!.z } as never);
      expect(back).toBeNull();
    }
  });

  test('names where the player stands under the street', () => {
    const { u } = underground();
    const c = u.scene('Centralen');
    expect(u.where(c.x, c.z)).toBe('Centralen');
    const h = u.scene('Haga');
    expect(u.where(h.x, h.z)).toBe('Station Haga');
    const mid = u.spine.frame((u.at.throat + u.at.haga) / 2);
    expect(u.where(mid.x, mid.z)).toBe('Västlänken');
    // Centralen's scene stands on its south platform.
    const south = (file.platforms[0] as Array<[number, number]>);
    expect(c.x).toBeGreaterThan(Math.min(...south.map((p) => p[0])));
    expect(c.x).toBeLessThan(Math.max(...south.map((p) => p[0])));
    expect(c.z).toBeGreaterThan(Math.min(...south.map((p) => p[1])));
    expect(c.z).toBeLessThan(Math.max(...south.map((p) => p[1])));
  });
});
