// The one frame for the whole city, shared by the data scripts and the game: meters, y up, x along Västlänken
// through its station Centralen toward Haga, z to the right of x (as everywhere in the game), and the middle between
// Centralen's two platforms at x = z = 0. Turned that way, Joel's station and tunnel builders lay the underground
// (P6) unchanged along +x, and the inner city happens to lie along x too: Drottningtorget at x = 100, Järntorget at
// x = 1500, all of it between z = -950 and -100. No three.js here: `scripts/` imports it.

/** The middle between Västlänken's two platforms at Centralen (OSM ways 477161102 and 477161104, layer -1). */
export const ORIGIN = { lat: 57.711215, lon: 11.972921 } as const;
/** Which way +x points, as a compass bearing in degrees: along those platforms toward Haga (west-south-west). */
export const HEADING = 252.25;

/** Meters per degree of longitude and of latitude at the origin, on the WGS 84 ellipsoid (the usual series). */
const PHI = (ORIGIN.lat * Math.PI) / 180;
const EAST = 111_412.84 * Math.cos(PHI) - 93.5 * Math.cos(3 * PHI);
const NORTH = 111_132.92 - 559.82 * Math.cos(2 * PHI) + 1.175 * Math.cos(4 * PHI);
const SIN = Math.sin((HEADING * Math.PI) / 180);
const COS = Math.cos((HEADING * Math.PI) / 180);

export type Pt = [number, number];

/**
 * A place's latitude and longitude in the game's frame, in meters. Flat (an equirectangular map round the origin, at
 * the ellipsoid's scale there): over the kilometer or so the game reaches north and south of the origin the scale
 * east-west drifts by about 0.03%, under half a meter at the edges, and every layer is drawn the same way.
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

/**
 * The street, in meters above the underground's rail top at y = 0: the city is laid flat at this height, so that P6 can
 * lay Västlänken's station under it with Joel's builders (a hall 8.5 m under the street, as his stations have).
 */
export const STREET_Y = 18;

/**
 * The places of the inner city, where its tram stops are (OSM's `railway=tram_stop`, the middle of each stop's
 * platforms): where the game starts, what the status line names, and the debug API's and the quality gate's scenes.
 */
export const PLACES: Record<string, Pt> = Object.fromEntries(([
  ['Drottningtorget', 57.707731, 11.973195],
  ['Nils Ericsonsplatsen', 57.709126, 11.971084],
  ['Lilla Bommen', 57.709186, 11.96676],
  ['Brunnsparken', 57.70708, 11.96845],
  ['Kungsportsplatsen', 57.704049, 11.969708],
  ['Domkyrkan', 57.704278, 11.963704],
  ['Grönsakstorget', 57.702526, 11.964342],
  ['Stenpiren', 57.70581, 11.95774],
  ['Järntorget', 57.700067, 11.952939],
] as const).map(([name, lat, lon]) => [name, toGame(lat, lon)]));

/** The named place nearest a point, and how far it is. */
export function placeNear(x: number, z: number): { name: string; d: number } {
  let best = { name: '', d: Infinity };
  for (const [name, [px, pz]] of Object.entries(PLACES)) {
    const d = Math.hypot(px - x, pz - z);
    if (d < best.d) best = { name, d };
  }
  return best;
}

/** The yaw (as `Player` has it: 0 looks toward -z) that looks from one point toward another. */
export const yawToward = (from: Pt, to: Pt) => Math.atan2(-(to[0] - from[0]), -(to[1] - from[1]));
