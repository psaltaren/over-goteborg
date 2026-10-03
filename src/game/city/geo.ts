// The one frame for the whole city, shared by the data scripts and the game: meters, y up, x along Västlänken
// through its station Centralen toward Haga, z to the right of x (as everywhere in the game), and the middle between
// Centralen's two platforms at x = z = 0. Turned that way, Joel's station and tunnel builders lay the underground
// (P6) unchanged along +x, and the inner city happens to lie along x too: Drottningtorget at x = 100, Järntorget at
// x = 1500, all of it between z = -950 and -100. No three.js here: `scripts/` imports it.

/** The middle between Västlänken's two platforms at Centralen (OSM ways 477161102 and 477161104, layer -1). */
export const ORIGIN = { lat: 57.711215, lon: 11.972921 } as const;
/** Which way +x points, as a compass bearing in degrees: along those platforms toward Haga (west-south-west). */
export const HEADING = 252.25;

const EAST = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const NORTH = 110_540;
const SIN = Math.sin((HEADING * Math.PI) / 180);
const COS = Math.cos((HEADING * Math.PI) / 180);

export type Pt = [number, number];

/**
 * A place's latitude and longitude in the game's frame, in meters. Flat (an equirectangular map round the origin):
 * over the two kilometers the game covers it is off by less than half a meter at the edges, the same for every layer,
 * so the tracks, the buildings and the stops all agree with each other.
 */
export function toGame(lat: number, lon: number): Pt {
  const e = (lon - ORIGIN.lon) * EAST;
  const n = (lat - ORIGIN.lat) * NORTH;
  return [e * SIN + n * COS, e * COS - n * SIN];
}

/** The way back: latitude and longitude of a point in the game's frame. */
export function toLatLon(x: number, z: number): [number, number] {
  const e = x * SIN + z * COS;
  const n = x * COS - z * SIN;
  return [ORIGIN.lat + n / NORTH, ORIGIN.lon + e / EAST];
}

/** A rectangle in the game's frame, in meters. */
export interface Rect { x0: number; x1: number; z0: number; z1: number }

/**
 * Where the player may walk: from Drottningtorget and Lilla Bommen in the east to past Järntorget in the west, from
 * the river down to Kungsparken and Grönsakstorget.
 */
export const PLAY: Rect = { x0: -150, x1: 1650, z0: -950, z1: -100 };

/** How far the trams' paths run on past `PLAY`, beyond the fog, so they come and go unseen. */
export const TRACK_REACH = 200;

/** The city is built in squares this wide, near ones built and far ones taken down. */
export const TILE = 250;

/** The squares of city there are: `PLAY` and a square more round it, what can be seen from inside it. */
export const CITY: Rect = {
  x0: Math.floor((PLAY.x0 - TILE) / TILE) * TILE,
  x1: Math.ceil((PLAY.x1 + TILE) / TILE) * TILE,
  z0: Math.floor((PLAY.z0 - TILE) / TILE) * TILE,
  z1: Math.ceil((PLAY.z1 + TILE) / TILE) * TILE,
};

/** A square's name, from its corner nearest -x and -z in whole squares (`-2_-5`); its files are named after it. */
export const tileKey = (i: number, j: number) => `${i}_${j}`;

/** Every square of `CITY`, with its corner in whole squares. */
export function cityTiles(): Array<{ i: number; j: number; key: string; rect: Rect }> {
  const out: Array<{ i: number; j: number; key: string; rect: Rect }> = [];
  for (let i = CITY.x0 / TILE; i < CITY.x1 / TILE; i++) {
    for (let j = CITY.z0 / TILE; j < CITY.z1 / TILE; j++) {
      out.push({ i, j, key: tileKey(i, j), rect: { x0: i * TILE, x1: (i + 1) * TILE, z0: j * TILE, z1: (j + 1) * TILE } });
    }
  }
  return out;
}

/** `r` grown by `m` meters on every side. */
export const grow = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, x1: r.x1 + m, z0: r.z0 - m, z1: r.z1 + m });

/** The latitude and longitude box round a rectangle of the game's frame, for asking OpenStreetMap: (south, west, north, east). */
export function bbox(r: Rect): [number, number, number, number] {
  const corners = [toLatLon(r.x0, r.z0), toLatLon(r.x0, r.z1), toLatLon(r.x1, r.z0), toLatLon(r.x1, r.z1)];
  const lats = corners.map((c) => c[0]), lons = corners.map((c) => c[1]);
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r6(Math.min(...lats)), r6(Math.min(...lons)), r6(Math.max(...lats)), r6(Math.max(...lons))];
}
