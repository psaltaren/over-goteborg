/**
 * Västlänken under the city, from OpenStreetMap (ODbL), into `src/game/city/osm/underground.json` for
 * `src/game/city/underground.ts`: the tracks through station Centralen (21 to 24, as OSM has them while they are
 * built), the line of the double-track tunnel from Centralen to Haga and on south past the station, Haga's station tracks,
 * Centralen's two platforms and its west entrances. All in the city's frame (`geo.ts`), in meters.
 *
 *   bun scripts/gbg-underground.ts            (asks Overpass, keeps the answer)
 *   bun scripts/gbg-underground.ts --cached   (from the answer kept)
 */
import { toGame, type Pt } from '../src/game/city/geo';
import { overpass, writeJson } from './osm-lib';

const OUT = 'src/game/city/osm/underground.json';
const LICENSE = 'Data © OpenStreetMap contributors, ODbL 1.0: https://www.openstreetmap.org/copyright';
/** The ways, by their OSM ids. */
const WAYS = {
  // Centralen's four station tracks (railway:track_ref 21 to 24), drawn from east to west.
  t21: 477120670, t22: 1414285588, t23: 1414285587, t24: 477120673,
  // The double track west of the station, toward Haga, in two pieces each.
  a1: 1463746047, a2: 1463746048, b1: 1414285601, b2: 1414285602,
  // Haga's two outer station tracks.
  h1: 477427546, h2: 477427547,
  // Centralen's platforms, and the west entrances.
  p1: 477161102, p2: 477161104, north: 1374501614, south: 1396822874,
};
/** Where the line is sampled, in meters along it. */
const STEP = 5;

const ids = Object.values(WAYS).join(',');
const els = await overpass(`way(id:${ids});out geom;`, 'gbg-underground');
const byId = new Map(els.filter((e) => e.type === 'way').map((e) => [e.id, (e.geometry ?? []).map((p) => toGame(p.lat, p.lon))]));
const way = (id: number): Pt[] => {
  const pts = byId.get(id);
  if (!pts?.length) throw new Error(`OSM way ${id} is missing: Västlänken has been redrawn, look again at the ways in this script`);
  return pts;
};
const round = (p: Pt): Pt => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A line resampled every `step` meters along it. */
function resample(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const d = dist(a, b);
    let at = step - carry;
    while (at <= d) {
      out.push([a[0] + ((b[0] - a[0]) * at) / d, a[1] + ((b[1] - a[1]) * at) / d]);
      at += step;
    }
    carry = d - (at - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > 0.5) out.push(last);
  return out;
}

/** The point of a line nearest `p`. */
function nearest(line: Pt[], p: Pt): Pt {
  let best: Pt = line[0], bd = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    const q: Pt = [a[0] + dx * t, a[1] + dz * t];
    const d = dist(q, p);
    if (d < bd) [best, bd] = [q, d];
  }
  return best;
}

/** A line running from low x to high, then on along `to` (both oriented the way the line runs). */
const orient = (pts: Pt[], from: Pt) => (dist(pts[0], from) <= dist(pts[pts.length - 1], from) ? pts : [...pts].reverse());

// Each of the two tracks from the east end of the station to past Haga, then the line halfway between them.
const centre: Pt = [0, 0];
const trackA = [...orient(way(WAYS.t22), [-400, 0])];
const trackB = [...orient(way(WAYS.t23), [-400, 0])];
for (const [id, track] of [[WAYS.a1, trackA], [WAYS.a2, trackB], [WAYS.b1, trackA], [WAYS.b2, trackB]] as Array<[number, Pt[]]>) {
  const pts = orient(way(id), track[track.length - 1]);
  // Where the first piece and the next meet the pieces join at one point: leave that point out once.
  track.push(...(dist(pts[0], track[track.length - 1]) < 2 ? pts.slice(1) : pts));
}
const a = resample(trackA, STEP);
const line = a.map((p) => {
  const q = nearest(trackB, p);
  return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Pt;
});
// From the east end of the platforms: the station's east end is out of the game's reach.
const start = line.findIndex((p) => p[0] > -140);
const spine = resample(line.slice(start), STEP).map(round);

const tracks = Object.fromEntries((['t21', 't22', 't23', 't24'] as const).map((k) => [k, resample(orient(way(WAYS[k]), [-400, 0]), STEP).filter((p) => p[0] > -150 && p[0] < 460).map(round)]));
const haga = (['h1', 'h2'] as const).map((k) => resample(orient(way(WAYS[k]), [1060, -700]), STEP).map(round));
const outline = (id: number) => way(id).map(round);

console.log(`spine ${spine.length} points over ${Math.round(spine.reduce((s, p, i) => s + (i ? dist(spine[i - 1], p) : 0), 0))} m, from ${spine[0]} to ${spine[spine.length - 1]}`);
writeJson(OUT, {
  license: LICENSE,
  format: 'bun scripts/gbg-underground.ts. In the city frame (src/game/city/geo.ts), meters. spine: the double track\'s middle from the east end of Centralen\'s platforms west and south past Haga, a point every 5 m; tracks: Centralen\'s station tracks 21 to 24, east to west; haga: Haga\'s two outer station tracks, north to south; platforms: Centralen\'s two; entrances: its west entrances, north and south.',
  centre,
}, {
  spine,
  tracks: [tracks.t21, tracks.t22, tracks.t23, tracks.t24],
  haga,
  platforms: [outline(WAYS.p1), outline(WAYS.p2)],
  entrances: [outline(WAYS.north), outline(WAYS.south)],
});
