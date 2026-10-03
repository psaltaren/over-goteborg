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
function unpack(list: number[], from: number, count: number): Pt[] {
  const out: Pt[] = [];
  let x = 0, z = 0;
  for (let k = 0; k < count; k++) {
    x += list[from + 2 * k];
    z += list[from + 2 * k + 1];
    out.push([x / 10, z / 10]);
  }
  return out;
}

/**
 * Where the quay walls go in a square (meters from its middle): along the water's edge, except where the edge is the
 * square's own (the water goes on into the next) and where a road crosses it (a bridge), as pieces of at most 8 m.
 */
export function quayWalls(file: Pick<TileFile, 'areas' | 'roads'>): Array<[Pt, Pt]> {
  const half = TILE / 2 - 0.05;
  const roads: Array<{ line: Pt[]; half: number }> = file.roads.map((r) => ({ line: unpack(r, 3, (r.length - 3) / 2), half: r[1] / 20 + 1 }));
  /** Whether a point lies on a road (within half its width and a meter). */
  const onRoad = ([x, z]: Pt) => roads.some(({ line, half: h }) => line.some((a, i) => {
    if (i + 1 >= line.length) return false;
    const b = line[i + 1];
    const ex = b[0] - a[0], ez = b[1] - a[1], len2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / len2));
    return Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z) < h;
  }));
  const out: Array<[Pt, Pt]> = [];
  for (const area of file.areas) {
    if (area[0] !== WATER) continue;
    // Each ring of the area: its count of points, then the points.
    for (let at = 1; at < area.length;) {
      const count = area[at];
      const ring = unpack(area, at + 1, count);
      at += 1 + 2 * count;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        // The square's own edge, where the clipped water goes on.
        if ((Math.abs(a[0]) > half && Math.abs(b[0]) > half && Math.sign(a[0]) === Math.sign(b[0])) || (Math.abs(a[1]) > half && Math.abs(b[1]) > half && Math.sign(a[1]) === Math.sign(b[1]))) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / 8));
        for (let k = 0; k < n; k++) {
          const p: Pt = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
          const q: Pt = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n];
          if (onRoad([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])) continue;
          out.push([p, q]);
        }
      }
    }
  }
  return out;
}

/**
 * The city's squares, each built when the player comes near (a lazy build in `CityWorld`): each square's file fetched
 * the first time it is wanted, used for one build and let go, and fetched again (from the browser's cache) when the
 * square is built again.
 */
export class Tiles {
  /** Each square's file: here, on the way (null), or none to be had (false). */
  private readonly files = new Map<string, TileFile | null | false>();

  /** @param windowLight how lit the windows are now, 0 by day to 1 at night. */
  constructor(private readonly physics: Physics, private readonly windowLight: () => number) {}

  /** Is the square's file here (or none to be had)? Starts fetching it if not. */
  ready(key: string): boolean {
    const known = this.files.get(key);
    if (known !== undefined) return known !== null;
    const url = fileUrls()[key];
    if (!url) {
      this.files.set(key, false);
      return true;
    }
    this.files.set(key, null);
    // Offline or refused: the square stays bare ground, rather than a build that never comes.
    fetch(url).then((r) => (r.ok ? r.json() : false)).catch(() => false).then((f: TileFile | false) => this.files.set(key, f));
    return false;
  }

  /** Builds the square `rect` from its file, and lets the file go. Null without a file. */
  *build(key: string, rect: Rect, seed: number): Generator<void, { group: Group; release(): void } | null> {
    const file = this.files.get(key);
    this.files.delete(key);
    if (!file) return null;
    const [cx, cz] = file.middle;
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
    const group = yield* s.finishSteps();
    const windows: Mesh | null = built.windows;
    if (windows) {
      const m = windows.material as MeshBasicMaterial;
      windows.onBeforeRender = () => {
        m.opacity = this.windowLight();
      };
    }
    return {
      group,
      release: () => {
        for (const c of [...built.colliders, ...quay]) this.physics.remove(c);
      },
    };
  }
}
