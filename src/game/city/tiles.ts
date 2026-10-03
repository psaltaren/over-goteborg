// The city in squares (`TILE` in `geo.ts`): each square's map from OpenStreetMap (`scripts/gbg-osm.ts`, the files in
// `city/osm/tiles/`), fetched the first time it is wanted and built into an outdoor `Section` with Joel's street
// builder (`world/streetOsm.ts`), with quay walls where the ground meets the water and no road crosses it. `CityWorld`
// builds the squares near the player and takes the far ones down.

import type { Group, Mesh, MeshBasicMaterial } from 'three';
import { rgb } from '../gfx/color';
import type { Physics, StaticCollider } from '../physics';
import { Section } from '../world/section';
import { streetOsmSteps } from '../world/streetOsm';
import { grow, STREET_Y, TILE, type Pt, type Rect } from './geo';
import { Rails } from './rails';
import type { Link } from './trackData';

const OPEN_AMBIENT = rgb(0x4a4a4a);
/** The walls of a house a square owns that reach this far into the next still get their colliders from it. */
const WALL_REACH = 60;
/** How far from a square's middle its lit windows and street signs go: to its corners and a little past. */
const REACH = 190;
/** The most street lamps a square lays (a station street lays 24 round its square). */
const LAMPS = 48;
/** The kind of ground that is water, in the files' `areas` (see `scripts/osm-streets.ts`'s format). */
const WATER = 2;
/** A quay wall: how high above the street it stands (a railing's height), and how far down it goes. */
const QUAY = { up: 1.1, down: 1, thick: 0.3 };

/** A square's file, as `scripts/gbg-osm.ts` writes it: the street files' lists, from the square's `middle` (meters). */
export interface TileFile {
  middle: [number, number];
  urban: boolean;
  names: string[];
  trees: number[];
  buildings: Array<Array<number | null>>;
  roads: number[][];
  areas: number[][];
}

/** Where each square's file is served, by key: Vite fills the list in at build time (a static list, not a build's). */
let URLS: Record<string, string> | null = null;
function fileUrls(): Record<string, string> {
  if (URLS) return URLS;
  let found: Record<string, string> = {};
  // Under Bun (the tests) there is no Vite to fill it in.
  try {
    found = import.meta.glob<string>('./osm/tiles/*.json', { query: '?url', import: 'default', eager: true });
  } catch { /* No files. */ }
  URLS = Object.fromEntries(Object.entries(found).map(([path, url]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), url]));
  return URLS;
}

/** The squares there are files for. */
export const tileKeys = (): string[] => Object.keys(fileUrls());

/** A list of points as the files pack them: decimeters, the first as it is and each next from the one before. */
export function unpack(list: number[], from: number, count: number): Pt[] {
  const out: Pt[] = [];
  let x = 0, z = 0;
  for (let k = 0; k < count; k++) {
    x += list[from + 2 * k];
    z += list[from + 2 * k + 1];
    out.push([x / 10, z / 10]);
  }
  return out;
}

/** A road crossing the water's edge more slant than this (the sine of the angle, 30 degrees) is not a bridge but a road along the quay whose line strays over the edge. */
const BRIDGE_SLANT = 0.5;
/** Less quay than this between two roads crossing the edge is left open: the carriageways and tracks of one wide bridge. */
const BRIDGE_JOIN = 6;

/** Where segment a-b meets segment c-d: how far along each (0 to 1), or null if they do not meet. */
function meet(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number; sin: number } | null {
  const ex = b[0] - a[0], ez = b[1] - a[1], fx = d[0] - c[0], fz = d[1] - c[1];
  const den = ex * fz - ez * fx;
  if (Math.abs(den) < 1e-9) return null;
  const gx = c[0] - a[0], gz = c[1] - a[1];
  const t = (gx * fz - gz * fx) / den, u = (gx * ez - gz * ex) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, sin: Math.abs(den) / (Math.hypot(ex, ez) * Math.hypot(fx, fz)) };
}

/**
 * Where the quay walls go in a square (meters from its middle): along the water's edge, except where the edge is the
 * square's own (the water goes on into the next) and where a road crosses it (a bridge), as pieces of at most 8 m.
 * A road that only runs beside the quay leaves it walled: the gap is cut where the road's line crosses the edge
 * (steeply, as a bridge does), as wide as the road is where it meets the edge and a meter more on each side.
 */
export function quayWalls(file: Pick<TileFile, 'areas' | 'roads'>): Array<[Pt, Pt]> {
  const half = TILE / 2 - 0.05;
  const roads = file.roads.map((r) => ({ line: unpack(r, 3, (r.length - 3) / 2), half: r[1] / 20 + 1 }));
  const out: Array<[Pt, Pt]> = [];
  for (const area of file.areas) {
    if (area[0] !== WATER) continue;
    // Each ring of the area: its count of points, then the points.
    for (let at = 1; at < area.length;) {
      const count = area[at];
      const ring = unpack(area, at + 1, count);
      at += 1 + 2 * count;
      // How far round the ring each corner lies, and the stretches of it the roads open.
      const along = [0];
      for (let i = 0; i < ring.length; i++) along.push(along[i] + Math.hypot(ring[(i + 1) % ring.length][0] - ring[i][0], ring[(i + 1) % ring.length][1] - ring[i][1]));
      const round = along[ring.length];
      const open: Array<[number, number]> = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        for (const { line, half: h } of roads) {
          for (let k = 0; k + 1 < line.length; k++) {
            const hit = meet(a, b, line[k], line[k + 1]);
            if (!hit || hit.sin < BRIDGE_SLANT) continue;
            const s = along[i] + hit.t * (along[i + 1] - along[i]);
            const reach = h / hit.sin;
            // Once as it is and once a round either way, so a gap over the ring's first corner opens both ends.
            for (const shift of [-round, 0, round]) open.push([s - reach + shift, s + reach + shift]);
          }
        }
      }
      open.sort((p, q) => p[0] - q[0]);
      for (let k = open.length - 1; k > 0; k--) {
        if (open[k][0] - open[k - 1][1] >= BRIDGE_JOIN) continue;
        open[k - 1][1] = Math.max(open[k - 1][1], open[k][1]);
        open.splice(k, 1);
      }
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        // The square's own edge, where the clipped water goes on.
        if ((Math.abs(a[0]) > half && Math.abs(b[0]) > half && Math.sign(a[0]) === Math.sign(b[0])) || (Math.abs(a[1]) > half && Math.abs(b[1]) > half && Math.sign(a[1]) === Math.sign(b[1]))) continue;
        const [s0, s1] = [along[i], along[i + 1]];
        const point = (s: number): Pt => {
          const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
          return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        };
        // What is left of the edge between the open stretches, in pieces of at most 8 m.
        let from = s0;
        const walled: Array<[number, number]> = [];
        for (const [o0, o1] of open) {
          if (o1 <= from || o0 >= s1) continue;
          if (o0 > from) walled.push([from, o0]);
          from = Math.max(from, o1);
        }
        if (from < s1) walled.push([from, s1]);
        for (const [w0, w1] of walled) {
          const n = Math.max(1, Math.ceil((w1 - w0) / 8));
          for (let k = 0; k < n; k++) out.push([point(w0 + ((w1 - w0) * k) / n), point(w0 + ((w1 - w0) * (k + 1)) / n)]);
        }
      }
    }
  }
  return out;
}

/**
 * The city's squares, each built when the player comes near (a lazy build in `CityWorld`): each square's file fetched
 * the first time it is wanted, used for one build and let go, and fetched again (from the browser's cache) when the
 * square is built again. A square whose file could not be fetched (offline, refused) is built as bare ground, and
 * asked for again the next time it is built.
 */
export class Tiles {
  /** Each square's file: here, on the way (null), failed to come ('failed'), or none to be had (false). */
  private readonly files = new Map<string, TileFile | null | false | 'failed'>();
  /** The lit windows of the squares built, lit or put out together (`lightWindows`). */
  private readonly windows = new Set<Mesh>();
  /** The tram tracks to lay in each square: not known yet (undefined), or none to be had (null, offline). */
  private rails: Rails | null | undefined = undefined;

  /** @param windowLight how lit the windows are now, 0 by day to 1 at night. */
  constructor(private readonly physics: Physics, private readonly windowLight: () => number) {}

  /** The tram tracks, once fetched (null when they cannot be): the squares with files wait for them. */
  setTracks(links: Link[] | null): void {
    this.rails = links ? new Rails(links) : null;
  }

  /** Is the square's file here (or failed, or none to be had), and the tracks known? Starts fetching it if not. */
  ready(key: string): boolean {
    const known = this.files.get(key);
    if (known !== undefined) return known !== null && (known === false || this.rails !== undefined);
    const url = fileUrls()[key];
    if (!url) {
      this.files.set(key, false);
      return true;
    }
    this.files.set(key, null);
    // Offline or refused: the square is built as bare ground, rather than a build that never comes.
    fetch(url).then((r) => (r.ok ? r.json() : 'failed')).catch(() => 'failed').then((f: TileFile | 'failed') => this.files.set(key, f));
    return false;
  }

  /** Builds the square `rect` from its file (bare ground if it failed to come), and lets the file go. Null for a square there is no file for. */
  *build(key: string, rect: Rect, seed: number): Generator<void, { group: Group; release(): void } | null> {
    const known = this.files.get(key);
    this.files.delete(key);
    if (!known) return null;
    const [cx, cz]: Pt = [(rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2];
    const file: TileFile = known !== 'failed' ? known : { middle: [cx, cz], urban: true, names: [], trees: [], buildings: [], roads: [], areas: [] };
    const s = new Section(`tile-${key}`, OPEN_AMBIENT, false, true);
    // The whole city is paved between its houses: the parks, squares and water come as areas of their own. One base for
    // every square, so no seam shows where a square that reads as suburb meets one that reads as city.
    const built = yield* streetOsmSteps(s, this.physics, { ...file, entrance: null, urban: true }, {
      y: STREET_Y, ox: cx, oz: cz, turn: 0, square: null, middle: [cx, cz], ground: rect, reach: REACH, lamps: LAMPS,
      clear: [], walk: grow(rect, WALL_REACH), inflate: 0, seed,
    });
    yield;
    const quay: StaticCollider[] = [];
    for (const [a, b] of quayWalls(file)) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.2) continue;
      const centre = { x: cx + (a[0] + b[0]) / 2, y: STREET_Y + (QUAY.up - QUAY.down) / 2, z: cz + (a[1] + b[1]) / 2 };
      quay.push(this.physics.turnedBox(centre, { x: len / 2 + 0.15, y: (QUAY.up + QUAY.down) / 2, z: QUAY.thick / 2 }, Math.atan2(-(b[1] - a[1]), b[0] - a[0])));
    }
    yield;
    // The tram tracks: the rails in the street, the wire over them and its poles.
    const poles = this.rails ? yield* this.rails.buildSteps(s, this.physics, rect, STREET_Y) : [];
    yield;
    const group = yield* s.finishSteps();
    const windows: Mesh | null = built.windows;
    if (windows) this.windows.add(windows);
    return {
      group,
      release: () => {
        for (const c of [...built.colliders, ...quay, ...poles]) this.physics.remove(c);
        if (windows) this.windows.delete(windows);
      },
    };
  }

  /** Lights the windows of every square built as `windowLight` says, and by day leaves them out of the frame altogether. */
  lightWindows(): void {
    if (!this.windows.size) return;
    const light = this.windowLight();
    for (const w of this.windows) {
      (w.material as MeshBasicMaterial).opacity = light;
      w.visible = light > 0;
    }
  }
}
