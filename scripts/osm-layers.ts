/**
 * The city round a place, from OpenStreetMap (© OpenStreetMap contributors, ODbL): buildings, roads, parks, woods,
 * water and trees, asked of Overpass in one go and cut to a region of the game's frame. What `scripts/osm-streets.ts`
 * (the streets out of a station's exits) and `scripts/gbg-osm.ts` (Gothenburg's city in squares) share.
 */
import { colourOf, heightOf, overpass, packed as packedFrom, roofOf, simplify, type El, type Pt } from './osm-lib';

/** How far a building's outline may be simplified, in meters. */
const SIMPLIFY = 0.6;

/** Kinds of ground, as the game paints them. */
export const AREA = { grass: 0, wood: 1, water: 2, paved: 3, asphalt: 4, sand: 5 } as const;
/** Kinds of way: a road for cars, a pedestrian street, a path. */
export const ROAD = { road: 0, pedestrian: 1, path: 2 } as const;

export interface Region { cx: number; cz: number; hx: number; hz: number; round: boolean }

export const WIDTHS: Record<string, [number, number]> = {
  motorway: [ROAD.road, 14], trunk: [ROAD.road, 13], primary: [ROAD.road, 13], secondary: [ROAD.road, 11], tertiary: [ROAD.road, 9],
  motorway_link: [ROAD.road, 8], trunk_link: [ROAD.road, 8], primary_link: [ROAD.road, 8], secondary_link: [ROAD.road, 7], tertiary_link: [ROAD.road, 7],
  unclassified: [ROAD.road, 7], residential: [ROAD.road, 7], living_street: [ROAD.road, 6], service: [ROAD.road, 4.5], busway: [ROAD.road, 7],
  pedestrian: [ROAD.pedestrian, 7], footway: [ROAD.path, 2.5], path: [ROAD.path, 2.5], cycleway: [ROAD.path, 2.5], bridleway: [ROAD.path, 2.5], track: [ROAD.path, 3],
};

export function areaKind(t: Record<string, string>): number | null {
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.water) return AREA.water;
  if (t.natural === 'wood' || t.natural === 'scrub' || t.landuse === 'forest') return AREA.wood;
  if (t.leisure === 'playground') return AREA.sand;
  if (t.amenity === 'parking') return AREA.asphalt;
  if (t.highway === 'pedestrian' || t.place === 'square') return AREA.paved;
  if (t.leisure || t.landuse || t.natural) return AREA.grass;
  return null;
}

// ---- Geometry in the game's frame, in meters. ----

/** Joins open chains end to end into closed rings (the ways of a multipolygon come in any order and direction). */
export function rings(chains: Pt[][]): Pt[][] {
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05;
  const open = chains.filter((c) => c.length > 1).map((c) => [...c]);
  const out: Pt[][] = [];
  while (open.length) {
    let ring = open.pop()!;
    for (let grew = true; grew && !same(ring[0], ring[ring.length - 1]);) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const c = open[i];
        const end = ring[ring.length - 1];
        if (same(c[0], end)) ring = ring.concat(c.slice(1));
        else if (same(c[c.length - 1], end)) ring = ring.concat([...c].reverse().slice(1));
        else if (same(c[c.length - 1], ring[0])) ring = c.concat(ring.slice(1));
        else if (same(c[0], ring[0])) ring = [...c].reverse().concat(ring.slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) out.push(ring.slice(0, -1));
  }
  return out;
}

/** Sutherland-Hodgman: a ring cut to the rectangle. */
export function clipRing(ring: Pt[], x0: number, x1: number, z0: number, z1: number): Pt[] {
  let pts = ring;
  const edges: Array<[(p: Pt) => boolean, (a: Pt, b: Pt) => Pt]> = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= z0, (a, b) => [a[0] + ((b[0] - a[0]) * (z0 - a[1])) / (b[1] - a[1]), z0]],
    [(p) => p[1] <= z1, (a, b) => [a[0] + ((b[0] - a[0]) * (z1 - a[1])) / (b[1] - a[1]), z1]],
  ];
  for (const [inside, cut] of edges) {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    pts = out;
    if (pts.length < 3) return [];
  }
  return pts;
}

export function area(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    s += ax * bz - bx * az;
  }
  return s / 2;
}

/** The middle of a ring's corners. */
export const middle = (ring: Pt[]): Pt => [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length];

export function inside(p: Pt, ring: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** The parts of a polyline within the rectangle, each cut where it crosses the edge (Liang-Barsky per segment). */
export function clipLine(line: Pt[], x0: number, x1: number, z0: number, z1: number): Pt[][] {
  const parts: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1];
    const dx = bx - ax, dz = bz - az;
    let t0 = 0, t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dz, az - z0], [dz, z1 - az]]) {
      if (p === 0) { if (q < 0) ok = false; continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (!ok || t0 > t1) {
      if (cur.length > 1) parts.push(cur);
      cur = [];
      continue;
    }
    const a: Pt = [ax + dx * t0, az + dz * t0], b: Pt = [ax + dx * t1, az + dz * t1];
    if (!cur.length) cur.push(a);
    cur.push(b);
    if (t1 < 1) {
      parts.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) parts.push(cur);
  return parts;
}

/**
 * The sea within the rectangle, from the coastline (land on the left of its ways in OSM; turned into the game's frame,
 * which is mirrored, the water lies on the left in x and z). Each stretch of coast that crosses the rectangle is closed
 * along its edge, counterclockwise, to where the next comes in.
 */
export function sea(coast: Pt[][], x0: number, x1: number, z0: number, z1: number): Pt[][] {
  const W = x1 - x0, H = z1 - z0, P = 2 * (W + H);
  const eps = 0.01;
  /** Where on the edge a point lies, counterclockwise from (x0, z0). */
  const along = ([x, z]: Pt): number => {
    if (Math.abs(z - z0) < eps) return x - x0;
    if (Math.abs(x - x1) < eps) return W + (z - z0);
    if (Math.abs(z - z1) < eps) return W + H + (x1 - x);
    return 2 * W + H + (z1 - z);
  };
  const onEdge = ([x, z]: Pt) => Math.abs(x - x0) < eps || Math.abs(x - x1) < eps || Math.abs(z - z0) < eps || Math.abs(z - z1) < eps;
  const corners: Array<[number, Pt]> = [[0, [x0, z0]], [W, [x1, z0]], [W + H, [x1, z1]], [2 * W + H, [x0, z1]]];
  const parts = coast.flatMap((c) => clipLine(c, x0, x1, z0, z1)).filter((p) => onEdge(p[0]) && onEdge(p[p.length - 1]));
  const out: Pt[][] = [];
  const used = new Set<number>();
  for (let s = 0; s < parts.length; s++) {
    if (used.has(s)) continue;
    const poly: Pt[] = [];
    let c = s;
    for (let guard = 0; guard <= parts.length; guard++) {
      used.add(c);
      poly.push(...parts[c]);
      const tOut = along(parts[c][parts[c].length - 1]);
      let next = -1, best = Infinity;
      for (let d = 0; d < parts.length; d++) {
        if (used.has(d) && d !== s) continue;
        const gap = (along(parts[d][0]) - tOut + P) % P;
        if (gap < best) { best = gap; next = d; }
      }
      if (next < 0) break;
      // The corners passed on the way round.
      for (const [t, p] of [...corners, ...corners.map(([t, p]) => [t + P, p] as [number, Pt])]) {
        const u = t - tOut;
        if (u > 0 && u < best) poly.push(p);
      }
      if (next === s) break;
      c = next;
    }
    if (poly.length >= 3) out.push(poly);
  }
  return out;
}


/** Joins ways that follow on from each other (the coast is drawn in one direction throughout). */
export function joinChains(chains: Pt[][]): Pt[][] {
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05;
  const open = chains.map((c) => [...c]);
  for (let joined = true; joined;) {
    joined = false;
    for (let i = 0; i < open.length && !joined; i++) {
      for (let j = 0; j < open.length; j++) {
        if (i === j || !same(open[i][open[i].length - 1], open[j][0])) continue;
        open[i] = open[i].concat(open[j].slice(1));
        open.splice(j, 1);
        joined = true;
        break;
      }
    }
  }
  return open;
}

/** A relation's member ways, whole (Overpass's answer kept by relation), as latitude and longitude. */
const lakes = new Map<number, Array<{ role: string; pts: Array<[number, number]> }>>();
const membersOf = (rel: El | undefined) => (rel?.members ?? []).filter((m) => m.type === 'way' && m.geometry).map((m) => ({ role: m.role, pts: m.geometry!.map((p) => [p.lat, p.lon] as [number, number]) }));
export async function relationWhole(id: number): Promise<Array<{ role: string; pts: Array<[number, number]> }>> {
  if (!lakes.has(id)) {
    const [rel] = await overpass(`relation(${id});out geom;`, `lake-${id}`);
    lakes.set(id, membersOf(rel));
  }
  return lakes.get(id)!;
}

/**
 * Asks for every relation in `els` whole, in one question to Overpass rather than one each (a city has hundreds of
 * them: buildings round a courtyard, parks), kept under `key`. `streetParts` then finds them without asking again.
 */
export async function wholeRelations(els: El[], key: string): Promise<void> {
  // Every relation `els` has, whether an earlier place asked for it or not, so what is kept under `key` is whole and a
  // run from the cache does not depend on which places ran before it.
  const ids = els.filter((e) => e.type === 'relation').map((e) => e.id);
  if (!ids.length) return;
  for (const rel of await overpass(`relation(id:${ids.join(',')});out geom;`, key)) lakes.set(rel.id, membersOf(rel));
  // One Overpass leaves out (deleted since) is fetched alone, as before.
  for (const id of ids) if (!lakes.has(id)) await relationWhole(id);
}

/**
 * The Overpass statements that ask for the city: `near` filters the ways and nodes (`around.s:300`, or a box
 * `57.69,11.94,57.72,11.99`), `coastNear` the coastline, which is asked from further out so the sea can be closed.
 * Follows the statements that set the place, and ends the query.
 */
export function streetQuery(near: string, coastNear: string): string {
  return `(` +
    `way[building](${near});relation[building](${near});` +
    `way[highway](${near});` +
    `way[leisure~"^(park|garden|playground|pitch|common|dog_park|golf_course)$"](${near});` +
    `way[landuse~"^(grass|recreation_ground|meadow|forest|cemetery|allotments|village_green|flowerbed|park)$"](${near});` +
    `way[natural~"^(water|wood|scrub|grassland|heath)$"](${near});way[waterway=riverbank](${near});` +
    `way[amenity=parking](${near});way[place=square](${near});` +
    `way[natural=coastline](${coastNear});` +
    `node[natural=tree](${near});` +
    `);out geom tags;` +
    `(relation[leisure~"^(park|garden)$"](${near})(if:count_members()<300);relation[landuse~"^(grass|forest|cemetery|recreation_ground)$"](${near})(if:count_members()<300);` +
    `relation[natural=wood](${near})(if:count_members()<300);relation[place=square](${near}););out geom tags;` +
    `relation[natural=water](${near});out ids tags;`;
}

/** The outlines of a relation, in the game's frame. */
export type Parts = Map<number, { outer: Pt[][]; inner: Pt[][] }>;

/**
 * What the answer to `streetQuery` leaves out and the layers need whole: each relation (a building, a park, a lake
 * such as Mälaren) asked for whole, once, to be cut to size, and the coast as long chains.
 */
export async function streetParts(els: El[], toGame: (lat: number, lon: number) => Pt): Promise<{ parts: Parts; coast: Pt[][] }> {
  const g = (geom: Array<{ lat: number; lon: number }>) => geom.map((p) => toGame(p.lat, p.lon));
  const parts: Parts = new Map();
  for (const rel of els.filter((e) => e.type === 'relation')) {
    const whole = await relationWhole(rel.id);
    const ring = (inner: boolean) => rings(whole.filter((m) => (m.role === 'inner') === inner).map((m) => m.pts.map(([lat, lon]) => toGame(lat, lon))));
    parts.set(rel.id, { outer: ring(false), inner: ring(true) });
  }
  // The coast as long chains, each way joined to the next where one ends and the next begins.
  const coast = joinChains(els.filter((e) => e.type === 'way' && e.tags?.natural === 'coastline' && e.geometry).map((e) => g(e.geometry!)));
  return { parts, coast };
}

/** One region's city, ready to be written: lists as the game reads them (`world/streetOsm.ts`). */
export interface Layers {
  buildings: Array<Array<number | null>>;
  roads: number[][];
  names: string[];
  areas: number[][];
  trees: Pt[];
  /**
   * Square meters of building within 150 m of the region's middle, and whether that makes it the city (paved between
   * the houses): more than a quarter or so of the ground it is measured over (`builtArea`).
   */
  built: number;
  urban: boolean;
}

/**
 * The ground `built` is measured over: the 150 m circle round the region's middle, as far as the region reaches. All
 * of it for a station's street (a 260 m circle, or a wider rectangle in the open); for a city square of 250 m, the
 * square's part of it, or the share of building would read low and dense blocks would come out as grass.
 */
export function builtArea({ hx, hz, round }: Region): number {
  const r = 150;
  if (round) return Math.PI * Math.min(r, hx) ** 2;
  if (hx >= r && hz >= r) return Math.PI * r * r;
  let n = 0;
  for (let x = -r + 1; x < r; x += 2) for (let z = -r + 1; z < r; z += 2) if (x * x + z * z <= r * r && Math.abs(x) <= hx && Math.abs(z) <= hz) n++;
  return n * 4;
}

/**
 * The city within `region`: buildings whole where their middle lies within it, roads and ground cut to its square,
 * trees within it. A round region keeps buildings and trees within `hx` of its middle.
 */
export function streetLayers(els: El[], { parts, coast }: { parts: Parts; coast: Pt[][] }, toGame: (lat: number, lon: number) => Pt, region: Region, origin: Pt = [0, 0]): Layers {
  // Measured in the frame given, written from `origin` (a city square from its middle, while the city is one frame).
  const packed = (pts: Pt[]) => packedFrom(pts.map(([x, z]) => [x - origin[0], z - origin[1]] as Pt));
  const g = (geom: Array<{ lat: number; lon: number }>) => geom.map((p) => toGame(p.lat, p.lon));
  const { cx, cz, hx, hz, round } = region;
  const [x0, x1, z0, z1] = [cx - hx, cx + hx, cz - hz, cz + hz];
  const within = ([x, z]: Pt) => (round ? Math.hypot(x - cx, z - cz) <= hx : x >= x0 && x <= x1 && z >= z0 && z <= z1);

  // Buildings: the outline of each (a multipolygon's outer rings), whole where its middle is within reach.
  const buildings: Array<{ id: number; b: Array<number | null> }> = [];
  let built = 0;
  for (const e of els) {
    const t = e.tags;
    if (!t?.building || t.building === 'roof' || t.building === 'no' || t.location === 'underground' || t.layer?.startsWith('-')) continue;
    const outlines = e.type === 'way' && e.geometry ? [g(e.geometry).slice(0, -1)]
      : e.type === 'relation' ? parts.get(e.id)?.outer ?? [] : [];
    for (const ring of outlines) {
      if (ring.length < 3 || !within(middle(ring))) continue;
      const simple = simplify(ring, SIMPLIFY);
      if (Math.hypot(...middle(simple).map((v, k) => v - (k ? cz : cx)) as Pt) < 150) built += Math.abs(area(simple));
      buildings.push({ id: e.id, b: [Math.round(heightOf(t) * 10), colourOf(t), roofOf(t), ...packed(simple)] });
    }
  }
  buildings.sort((p, q) => p.id - q.id);

  // Roads, cut to the square, with the names of the streets.
  const names: string[] = [];
  const roads: Array<{ id: number; r: number[] }> = [];
  for (const e of els) {
    const t = e.tags;
    if (e.type !== 'way' || !t?.highway || !e.geometry || t.area === 'yes' || t.tunnel === 'yes' || t.covered === 'yes' || t.layer?.startsWith('-') || t.footway === 'sidewalk') continue;
    const kind = WIDTHS[t.highway];
    if (!kind) continue;
    const lanes = parseFloat(t.lanes ?? '');
    const width = kind[0] === ROAD.road && lanes > 2 ? Math.max(kind[1], lanes * 3.2) : kind[1];
    const name = kind[0] !== ROAD.path ? t.name ?? null : null;
    let n = -1;
    if (name) {
      n = names.indexOf(name);
      if (n < 0) n = names.push(name) - 1;
    }
    for (const part of clipLine(g(e.geometry), x0, x1, z0, z1)) roads.push({ id: e.id, r: [kind[0], Math.round(width * 10), n, ...packed(part)] });
  }
  roads.sort((p, q) => p.id - q.id);

  // Ground: parks, woods, squares and water, cut to the square; holes for the islands in a lake.
  const areas: Array<{ id: number; a: number[] }> = [];
  const addArea = (id: number, kind: number, outer: Pt[], inner: Pt[][]) => {
    const o = clipRing(outer, x0, x1, z0, z1);
    if (o.length < 3 || Math.abs(area(o)) < 4) return;
    // A hole cut to the square often runs along its edge, so it is judged by its middle, not a corner. An island that
    // covers all of it (Kungsholmen in Mälaren) leaves no water.
    const holes = inner.map((h) => clipRing(h, x0, x1, z0, z1)).filter((h) => h.length >= 3 && Math.abs(area(h)) > 1 && inside(middle(h), o));
    if (holes.reduce((sum, h) => sum + Math.abs(area(h)), 0) > 0.97 * Math.abs(area(o))) return;
    areas.push({ id, a: [kind, ...[o, ...holes].flatMap((ring) => [ring.length, ...packed(ring)])] });
  };
  for (const e of els) {
    const kind = e.tags ? areaKind(e.tags) : null;
    if (kind === null || e.tags?.building || (e.tags?.highway && e.tags.area !== 'yes' && e.tags.highway !== 'pedestrian')) continue;
    if (e.type === 'way' && e.geometry && e.geometry.length >= 4) {
      const ring = g(e.geometry);
      if (Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.1) addArea(e.id, kind, ring.slice(0, -1), []);
    } else if (e.type === 'relation') {
      const whole = parts.get(e.id);
      for (const outer of whole?.outer ?? []) addArea(e.id, kind, outer, whole!.inner);
    }
  }
  for (const ring of sea(coast, x0, x1, z0, z1)) areas.push({ id: 0, a: [AREA.water, ring.length, ...packed(ring)] });
  areas.sort((p, q) => p.id - q.id);

  const trees = els.filter((e) => e.type === 'node' && e.tags?.natural === 'tree').map((e) => toGame(e.lat!, e.lon!)).filter(within).slice(0, 600);
  // Dense enough to be the city: paved between the houses; else grass.
  const urban = built / builtArea(region) > 0.24;
  return { buildings: buildings.map((b) => b.b), roads: roads.map((r) => r.r), names, areas: areas.map((a) => a.a), trees: trees.map(([x, z]) => [x - origin[0], z - origin[1]] as Pt), built, urban };
}
