// Västlänken under the city (P6): station Centralen, finished and waiting for its opening on 13 December 2026, the
// double-track tunnel west and south from it, and Haga's rock hall, still being dug for its opening around 2030. Laid
// from OpenStreetMap's tracks (`osm/underground.json`, `scripts/gbg-underground.ts`) at Trafikverket's depths
// (`VL` in layout.ts), and reached from the street by a construction hoist at the works at Rosenlund, with an
// emergency exit up to Nils Ericsonsgatan. Built lazily like the squares (`CityWorld.later`, under the street: only
// while the player is down there), each part a baked `Section`; the colliders go with it. Centralen's look follows
// Kanozi's design (Trafikverket's pictures): dark green granite, a brass ceiling over the outer tracks with fluted brown
// walls behind them, a high pale concrete hall over the middle two, slate columns, glass boxes round the escalators.

import { CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, RepeatWrapping, SRGBColorSpace, Vector3, type Texture } from 'three';
import { MeshBuilder, type Paint } from '../gfx/builder';
import { mix, rgb, type RGB } from '../gfx/color';
import { noise3 } from '../gfx/noise';
import { FONT, fitText } from '../gfx/signs';
import sv from '../i18n/sv.json';
import { VL } from '../layout';
import type { Physics, StaticCollider } from '../physics';
import { Section } from '../world/section';
import { STREET_Y, type Pt, type Rect } from './geo';
import { place, Spine, sweep, sweepSection, sweptBoxes, type Cross, type Frame } from './sweep';
import type { CityWorld } from './world';

/** Where the game finds the file: Vite fills it in at build time (none under Bun). */
let FILE_URL: string | null | undefined;
function fileUrl(): string | null {
  if (FILE_URL !== undefined) return FILE_URL;
  try {
    FILE_URL = Object.values(import.meta.glob<string>('./osm/underground.json', { query: '?url', import: 'default', eager: true }))[0] ?? null;
  } catch {
    FILE_URL = null;
  }
  return FILE_URL;
}

/** Västlänken's lines and outlines, fetched from the game's own origin like the squares; null when it cannot be had. */
export async function loadUnderground(): Promise<UndergroundFile | null> {
  const url = fileUrl();
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`underground.json: ${res.status}`);
  return (await res.json()) as UndergroundFile;
}

/** The file `scripts/gbg-underground.ts` writes. */
export interface UndergroundFile {
  spine: Pt[];
  tracks: Pt[][];
  haga: Pt[][];
  platforms: Pt[][];
  entrances: Pt[][];
}

/** The rail top at Centralen and at Haga, in the game's heights (the street at `STREET_Y`). */
export const RAIL_CENTRALEN = STREET_Y - VL.depthCentralen;
export const RAIL_HAGA = STREET_Y - VL.depthHaga;
/** When Centralen opens to travellers: 13 December 2026, its first morning (Stockholm time, epoch seconds). */
export const CENTRALEN_OPENS = Date.UTC(2026, 11, 13, 4) / 1000;

/** A way between the street and the underground: stepping into it takes the player through (or says why not). */
export interface Door {
  /** The middle of where it is stepped into, its half size in the plane, and the floor under it. */
  x: number;
  z: number;
  y: number;
  half: number;
  /** Where it leads, and which way the player then looks (null: it does not open from this side). */
  to: { x: number; y: number; z: number; yaw: number } | null;
  /** Whether it leads under the street. */
  under: boolean;
  /** What is said going through (`text.vastlanken`, in the menus' language: it tells what the player does). */
  say: 'hoistDown' | 'hoistUp' | 'exitUp' | 'exitLocked';
}

const AMBIENT = rgb(0x2a2b2e);
const DARK = rgb(0x121214);
const C = {
  granite: (p: Vector3): RGB => mix(rgb(0x30483b), rgb(0x587262), noise3(p.x * 0.7, p.y, p.z * 0.7, 7)),
  edge: rgb(0xd8d2c4),
  tactile: rgb(0xe9e3d3),
  concrete: rgb(0x75736d),
  pale: rgb(0xd9d8d3),
  beam: rgb(0xc9c8c2),
  slab: rgb(0x3d3c39),
  steel: rgb(0x7e848b),
  railTop: rgb(0xc3c8cd),
  black: rgb(0x1b1c1e),
  pine: rgb(0xdcc69e),
  glow: rgb(0xfff2da),
  sky: rgb(0xeef3ff),
  shutter: rgb(0x8d9196),
  bed: (p: Vector3): RGB => mix(rgb(0x4a4844), rgb(0x5d5a55), noise3(p.x * 2, 0, p.z * 2, 3)),
  wetFloor: (p: Vector3): RGB => mix(rgb(0x3f3d3a), rgb(0x23262a), Math.max(0, noise3(p.x * 0.12, 0, p.z * 0.12, 11) * 2 - 0.9)),
  rock: (p: Vector3): RGB => mix(rgb(0x4e4a45), rgb(0x77716a), noise3(p.x * 0.35, p.y * 0.5, p.z * 0.35, 4)),
  shotcrete: (p: Vector3): RGB => mix(rgb(0x8a877f), rgb(0xa29f97), noise3(p.x * 0.6, p.y * 0.6, p.z * 0.6, 5)),
  yellow: rgb(0xd9a91c),
  orange: rgb(0xd8742a),
  plywood: rgb(0xc9935a),
  rebar: rgb(0x4a3a30),
  green: rgb(0x1f8a4c),
  fence: rgb(0xb7bcc0),
};
/** Light: Centralen's warm lamps under the brass, its cool hall light, the tunnel's lamps, the works' floodlights. */
const LAMP = { warm: rgb(0xffe6c4), flute: rgb(0xffa85a), hall: rgb(0xeef3ff), tunnel: rgb(0xffe0b0), work: rgb(0xfff4e0) };

/** Lazily made, once, and kept: the textures every build shares (their materials are shared, so freeing leaves them). */
let textures: { flute: Texture; brass: Texture; slate: Texture; mesh: Texture } | null = null;
function surfaces(): NonNullable<typeof textures> {
  if (textures) return textures;
  const make = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): Texture => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    draw(canvas.getContext('2d')!);
    const t = new CanvasTexture(canvas);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  textures = {
    // A meter of dark brown flutes, lit from the side: the walls behind the outer tracks.
    flute: make(128, 32, (ctx) => {
      for (let x = 0; x < 128; x++) {
        const k = (x % 16) / 16;
        const shade = 0.55 + 0.45 * Math.sin(k * Math.PI);
        ctx.fillStyle = `rgb(${Math.round(92 * shade)}, ${Math.round(54 * shade)}, ${Math.round(32 * shade)})`;
        ctx.fillRect(x, 0, 1, 32);
      }
    }),
    // A meter of brass sheet, perforated.
    brass: make(128, 128, (ctx) => {
      ctx.fillStyle = '#b58d4a';
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = '#3a2a14';
      for (let y = 2; y < 128; y += 6) for (let x = (y / 6) % 2 ? 2 : 5; x < 128; x += 6) ctx.fillRect(x, y, 2, 2);
    }),
    // A meter and a half of slate in blocks, its joints a shade darker.
    slate: make(192, 128, (ctx) => {
      ctx.fillStyle = '#c2c3c0';
      ctx.fillRect(0, 0, 192, 128);
      for (let row = 0; row < 4; row++) {
        for (let col = -1; col < 3; col++) {
          const x = col * 96 + (row % 2) * 48;
          // Each block a shade of its own, the same grey in every channel (a little warm).
          const g = 176 + (((row * 7 + col * 13) % 5) + 5) % 5 * 5;
          ctx.fillStyle = `rgb(${g + 3}, ${g + 2}, ${g})`;
          ctx.fillRect(x + 2, row * 32 + 2, 92, 28);
        }
      }
    }),
    // Steel mesh: the hoist's cage and the fences at the works.
    mesh: make(64, 64, (ctx) => {
      ctx.clearRect(0, 0, 64, 64);
      ctx.fillStyle = '#9aa2a8';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#2b2f33';
      for (let y = 3; y < 64; y += 8) for (let x = 3; x < 64; x += 8) ctx.fillRect(x, y, 5, 5);
    }),
  };
  return textures;
}

let glassMaterial: MeshBasicMaterial | null = null;
const glass = () => (glassMaterial ??= new MeshBasicMaterial({ color: 0xcfe3e6, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide }));

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const ab = new Vector3();
const ad = new Vector3();

/** A quad facing `facing` (its corners in either order round it), split into cells for the baked light. */
function face(b: MeshBuilder, a: Vector3, c1: Vector3, c2: Vector3, d: Vector3, facing: Vector3, paint: Paint, cell = 3): void {
  const n = ab.subVectors(c1, a).cross(ad.subVectors(d, a));
  if (n.dot(facing) < 0) b.gridQuad(a, d, c2, c1, paint, cell);
  else b.gridQuad(a, c1, c2, d, paint, cell);
}

const UP = v(0, 1, 0), DOWN = v(0, -1, 0);

/** The signs of a part, drawn into an atlas of its own: a row each, white or yellow on black, or a green exit sign. */
class Signs {
  readonly texture: Texture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rows: string[] = [];

  constructor(private readonly count: number) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 64 * count;
    this.ctx = canvas.getContext('2d')!;
    this.texture = new CanvasTexture(canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
  }

  /** A row with `text`: on black, white (or `color`), with a yellow mark (an arrow, a letter) before it, or a green exit. */
  row(text: string, kind: 'plain' | 'yellow' | 'exit' | 'notice' = 'plain'): number {
    const key = `${kind}|${text}`;
    const at = this.rows.indexOf(key);
    if (at >= 0) return at;
    const row = this.rows.length;
    if (row >= this.count) throw new Error('Signs: the atlas is full');
    this.rows.push(key);
    const { ctx } = this;
    const y = row * 64;
    ctx.fillStyle = kind === 'exit' ? '#14864a' : kind === 'notice' ? '#f2efe6' : '#141516';
    ctx.fillRect(0, y, 512, 64);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = kind === 'notice' ? '#1b1c1e' : kind === 'yellow' ? '#f5c518' : '#ffffff';
    fitText(ctx, text, 488, 700, 36, FONT);
    ctx.fillText(text, 256, y + 33);
    this.texture.needsUpdate = true;
    return row;
  }

  /** A sign `w` by `h` meters, its middle at `at`, facing `facing` (horizontal), showing row `row`; both sides with `two`. */
  put(layer: MeshBuilder, at: Vector3, facing: Vector3, w: number, h: number, row: number, two = false): void {
    // Looking at its face (against `facing`), the text runs to the right: x's way for a sign that faces +z.
    const right = v(facing.z, 0, -facing.x).normalize().multiplyScalar(w / 2);
    const up = v(0, h / 2, 0);
    const v0 = 1 - (row + 1) / this.count, v1 = 1 - row / this.count;
    const a = at.clone().sub(right).sub(up), b = at.clone().add(right).sub(up), c = at.clone().add(right).add(up), d = at.clone().sub(right).add(up);
    const lift = facing.clone().normalize().multiplyScalar(0.01);
    for (const [side, push] of two ? [[1, lift], [-1, lift.clone().negate()]] as const : [[1, lift]] as const) {
      const [p, q, r, s] = [a, b, c, d].map((x) => x.clone().add(push));
      // Seen from the front the text reads left to right; from behind, the back's own copy does too.
      if (side > 0) {
        layer.tri(p, q, r, rgb(0xffffff), { uvs: [[0, v0], [1, v0], [1, v1]] });
        layer.tri(p, r, s, rgb(0xffffff), { uvs: [[0, v0], [1, v1], [0, v1]] });
      } else {
        layer.tri(q, p, s, rgb(0xffffff), { uvs: [[0, v0], [1, v0], [1, v1]] });
        layer.tri(q, s, r, rgb(0xffffff), { uvs: [[0, v0], [1, v1], [0, v1]] });
      }
    }
  }
}

/** A display of lit text (green on black), not baked: the departure boards. */
function board(lines: string[], w: number, h: number): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#050706';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#6ef58a';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    ctx.textAlign = 'left';
    fitText(ctx, line, 488, 700, 34, FONT);
    ctx.fillText(line, 12, 34 + i * 58);
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // Two faces back to back, each reading the right way round from its side.
  const material = new MeshBasicMaterial({ map: texture });
  const front = new Mesh(new PlaneGeometry(w, h), material);
  const back = new Mesh(new PlaneGeometry(w, h), material);
  back.rotation.y = Math.PI;
  front.add(back);
  return front;
}

export class Underground {
  readonly spine: Spine;
  readonly doors: Door[] = [];
  /** How far along the line each place lies: the platforms' ends, the station's west end, the four tracks joined, the rails' end, the rock, the hoist, Haga's hall. */
  readonly at: { platformsE: number; platformsW: number; station: number; throat: number; railsEnd: number; rock: number; hoist: number; haga: number };
  private readonly tracks: Pt[][];

  /** @param clock the game's clock (epoch seconds): whether Centralen has opened yet, when a part is built. */
  constructor(private readonly file: UndergroundFile, private readonly physics: Physics, private readonly world: CityWorld, private readonly clock: () => number = () => Date.now() / 1000) {
    // The rail falls from Centralen's level west of the station to Haga's at its hall, evenly.
    const flat = { from: 0, to: 0 };
    this.spine = new Spine(file.spine, (s) => (s <= flat.from ? RAIL_CENTRALEN : s >= flat.to ? RAIL_HAGA : RAIL_CENTRALEN + ((RAIL_HAGA - RAIL_CENTRALEN) * (s - flat.from)) / (flat.to - flat.from)));
    const sAt = (x: number, z: number) => this.spine.locate(x, z).s;
    let haga = this.spine.length;
    for (let s = 0; s < this.spine.length; s += 2) if (this.spine.frame(s).z <= VL.haga.northZ) { haga = s; break; }
    this.at = {
      platformsE: sAt(-106, 0),
      platformsW: sAt(156, 0),
      station: sAt(VL.station.west, 0),
      throat: sAt(VL.station.throat, 0),
      railsEnd: sAt(875, -258),
      rock: sAt(875, -258) + 140,
      hoist: sAt(1050, -895),
      haga,
    };
    // Level through the whole station, as it is built; falling from its west end, where the throat begins.
    flat.from = this.at.station;
    flat.to = this.at.haga;
    this.tracks = file.tracks;
    this.register();
  }

  /** The name the status line gives where the player stands under the street. */
  where(x: number, z: number): string {
    const { s, d } = this.spine.locate(x, z);
    if (x < VL.station.west + 30 && d < 40) return sv.vastlanken.centralen;
    if (s >= this.at.haga - 10 && d < 40) return sv.vastlanken.haga;
    return sv.vastlanken.tunnel;
  }

  /** The door the player's feet stand in, if any. */
  doorAt(feet: Vector3): Door | null {
    for (const d of this.doors) if (Math.abs(feet.x - d.x) < d.half && Math.abs(feet.z - d.z) < d.half && Math.abs(feet.y - d.y) < 2) return d;
    return null;
  }

  /** Where the player stands to see a part (the measuring scenes): on Centralen's south platform, or in Haga's hall. */
  scene(name: 'Centralen' | 'Haga'): { x: number; y: number; z: number; yaw: number } {
    if (name === 'Centralen') return { x: 120, y: RAIL_CENTRALEN + VL.platform + 0.05, z: -12, yaw: Math.PI / 2 };
    const f = this.spine.frame(this.at.haga + 12);
    return { x: f.x + f.nx * 6, y: f.y - 0.55, z: f.z + f.nz * 6, yaw: Math.atan2(-f.tx, -f.tz) };
  }

  /** Every part queued to be built near the player: the station, its west end, the tunnel in stretches, Haga, and the two ways up. */
  private register(): void {
    const { world } = this;
    const lazily = (rect: Rect, under: boolean, build: (colliders: StaticCollider[]) => Generator<void, Section>) => {
      const colliders: StaticCollider[] = [];
      world.later(rect, function* () {
        const section = yield* build(colliders);
        yield* world.add(yield* section.finishSteps());
      }, () => {
        for (const c of colliders.splice(0)) this.physics.remove(c);
      }, undefined, under);
    };
    const S = VL.station;
    lazily({ x0: S.east - 10, x1: S.west + 10, z0: S.wallS - 6, z1: S.wallN + 6 }, true, (c) => this.centralen(c));
    lazily({ x0: S.west - 10, x1: S.throat + 10, z0: -50, z1: 40 }, true, (c) => this.throat(c));
    for (let s = this.at.throat; s < this.at.haga; s += 130) {
      const from = s, to = Math.min(this.at.haga, s + 130);
      lazily(this.bounds(from, to, 12), true, (c) => this.tunnel(c, from, to));
    }
    lazily(this.bounds(this.at.haga, this.at.haga + VL.haga.dug + VL.haga.pilots, VL.haga.half + 8), true, (c) => this.hagaHall(c));
    // The ways up: the hoist's tower at the works, and the emergency exit's hut.
    const cage = this.cage();
    lazily({ x0: cage.x - 30, x1: cage.x + 30, z0: cage.z - 30, z1: cage.z + 30 }, false, (c) => this.works(c));
    lazily({ x0: EXIT.x - 12, x1: EXIT.x + 12, z0: EXIT.z - 12, z1: EXIT.z + 12 }, false, (c) => this.exitHut(c));
    // Down at the works, up from the hoist's foot, and up the emergency exit (which does not open from the street).
    const foot = this.hoistFoot();
    this.doors.push(
      { x: cage.x, z: cage.z, y: STREET_Y, half: VL.hoist.half - 0.3, under: true, say: 'hoistDown', to: { x: foot.out.x, y: foot.out.y + 0.05, z: foot.out.z, yaw: foot.yaw } },
      { x: foot.x, z: foot.z, y: foot.y, half: VL.hoist.half - 0.3, under: false, say: 'hoistUp', to: { x: cage.x, y: STREET_Y + 0.05, z: cage.z + VL.hoist.half + 1.6, yaw: Math.PI } },
      { x: EXIT.x, z: EXIT.z - 1.4, y: STREET_Y, half: 0.9, under: false, say: 'exitLocked', to: null },
    );
    const door = this.exitDoor();
    this.doors.push({ x: door.x, z: door.z, y: door.y, half: 1.1, under: false, say: 'exitUp', to: { x: EXIT.x, y: STREET_Y + 0.05, z: EXIT.z - 2.6, yaw: 0 } });
  }

  /** The plane round the line from `s0` to `s1`, `margin` meters out. */
  private bounds(s0: number, s1: number, margin: number): Rect {
    const fs = this.spine.frames(s0, s1, 10);
    return {
      x0: Math.min(...fs.map((f) => f.x)) - margin,
      x1: Math.max(...fs.map((f) => f.x)) + margin,
      z0: Math.min(...fs.map((f) => f.z)) - margin,
      z1: Math.max(...fs.map((f) => f.z)) + margin,
    };
  }

  /** The hoist's cage at the street, straight over its foot beside the tunnel's left wall. */
  private cage(): { x: number; z: number } {
    const f = this.spine.frame(this.at.hoist);
    return { x: f.x + f.nx * VL.hoist.out, z: f.z + f.nz * VL.hoist.out };
  }

  /** The hoist's foot in the tunnel: the cage, the floor under it, where one steps out, and which way one looks then. */
  private hoistFoot(): { x: number; y: number; z: number; out: Vector3; yaw: number } {
    const f = this.spine.frame(this.at.hoist);
    const c = this.cage();
    const out = place(f, [VL.tunnel.half - VL.tunnel.walk - 0.6, VL.tunnel.walkUp]);
    // Looking along the tunnel toward Haga.
    return { x: c.x, y: f.y + VL.tunnel.walkUp, z: c.z, out, yaw: Math.atan2(-f.tx, -f.tz) };
  }

  /** Centralen's emergency exit, in the south wall at its west entrances: the doorway's middle at the floor. */
  private exitDoor(): { x: number; y: number; z: number } {
    const x = EXIT_DOOR_X;
    const { s } = this.spine.locate(x, 0);
    return { x, y: this.spine.frame(s).y - VL.bed + 0.02, z: this.wallAt(x, -1) + 1.2 };
  }

  /** The throat's wall at `x`: four meters out from its outermost track on that side (-1 south, 1 north). */
  private wallAt(x: number, side: -1 | 1): number {
    const zs = this.tracks.map((t) => trackZ(t, x));
    return side < 0 ? Math.min(...zs) - 4 : Math.max(...zs) + 4;
  }

  // ---- Centralen ----

  private *centralen(colliders: StaticCollider[]): Generator<void, Section> {
    const S = VL.station;
    const s = new Section('vl-centralen', AMBIENT);
    const { physics } = this;
    const box = (min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) => colliders.push(physics.box(min, max));
    const t = surfaces();
    const yR = RAIL_CENTRALEN, yF = yR - VL.bed, yP = yR + VL.platform, yB = yP + S.brass, yHi = STREET_Y - 1.2;
    const [x0, x1] = [S.east, S.west];
    const [zS, zN] = [S.wallS, S.wallN];
    const colS = S.columnS, colN = S.columnN, half = S.column / 2;
    const opens = this.clock() < CENTRALEN_OPENS;

    // The track bed, and the four tracks on their slabs.
    face(s.lit, v(x0, yF, zS), v(x1, yF, zS), v(x1, yF, zN), v(x0, yF, zN), UP, C.bed, 4);
    box({ x: x0 - 1, y: yF - 1, z: zS - 1 }, { x: x1 + 1, y: yF, z: zN + 1 });
    for (const track of this.tracks) {
      const z = trackZ(track, (x0 + 120) / 2);
      lay(s.lit, x0, x1, z, yR);
    }
    yield;

    // The platforms: dark green granite, a pale edge, the guide strips, the sides down to the track bed.
    const platforms = this.file.platforms.map((p) => ({
      x0: Math.min(...p.map((q) => q[0])), x1: Math.max(...p.map((q) => q[0])),
      z0: Math.min(...p.map((q) => q[1])) + 0.2, z1: Math.max(...p.map((q) => q[1])) - 0.2,
    }));
    for (const p of platforms) {
      face(s.floor, v(p.x0, yP, p.z0 + 0.45), v(p.x1, yP, p.z0 + 0.45), v(p.x1, yP, p.z1 - 0.45), v(p.x0, yP, p.z1 - 0.45), UP, C.granite, 3);
      for (const [za, zb] of [[p.z0, p.z0 + 0.45], [p.z1 - 0.45, p.z1]]) face(s.floor, v(p.x0, yP, za), v(p.x1, yP, za), v(p.x1, yP, zb), v(p.x0, yP, zb), UP, C.edge, 6);
      for (const zt of [p.z0 + 1.1, p.z1 - 1.7]) face(s.tactile, v(p.x0 + 1, yP + 0.005, zt), v(p.x1 - 1, yP + 0.005, zt), v(p.x1 - 1, yP + 0.005, zt + 0.6), v(p.x0 + 1, yP + 0.005, zt + 0.6), UP, C.tactile, 6);
      face(s.lit, v(p.x0, yF, p.z0), v(p.x1, yF, p.z0), v(p.x1, yP, p.z0), v(p.x0, yP, p.z0), v(0, 0, -1), C.concrete, 6);
      face(s.lit, v(p.x0, yF, p.z1), v(p.x1, yF, p.z1), v(p.x1, yP, p.z1), v(p.x0, yP, p.z1), v(0, 0, 1), C.concrete, 6);
      face(s.lit, v(p.x0, yF, p.z0), v(p.x0, yF, p.z1), v(p.x0, yP, p.z1), v(p.x0, yP, p.z0), v(-1, 0, 0), C.concrete, 6);
      face(s.lit, v(p.x1, yF, p.z0), v(p.x1, yF, p.z1), v(p.x1, yP, p.z1), v(p.x1, yP, p.z0), v(1, 0, 0), C.concrete, 6);
      box({ x: p.x0, y: yF, z: p.z0 }, { x: p.x1, y: yP, z: p.z1 });
    }
    yield;

    // The fluted brown walls behind the outer tracks, lit from their feet; the east end wall.
    const flute = s.artLayer(t.flute);
    for (const [z, nz] of [[zS, 1], [zN, -1]] as const) {
      face(flute, v(x0, yF, z), v(x1, yF, z), v(x1, yB, z), v(x0, yB, z), v(0, 0, nz), rgb(0xffffff), 3);
      box({ x: x0, y: yF, z: nz > 0 ? z - 1 : z }, { x: x1, y: yHi + 1, z: nz > 0 ? z : z + 1 });
      for (let x = x0 + 4; x < x1; x += 9) s.light(x, yR + 0.4, z + nz * 0.6, LAMP.flute, 0.75, 6);
    }
    face(s.lit, v(x0, yF, zS), v(x0, yF, zN), v(x0, yHi, zN), v(x0, yHi, zS), v(1, 0, 0), C.pale, 3);
    box({ x: x0 - 1, y: yF, z: zS }, { x: x0, y: yHi + 1, z: zN });
    // The west end over the brass: the station opens into its throat below it, whose ceiling lies lower than the hall's.
    for (const nx of [-1, 1]) face(s.lit, v(x1, yB, zS), v(x1, yB, zN), v(x1, yHi, zN), v(x1, yHi, zS), v(nx, 0, 0), C.pale, 3);

    // The brass ceilings over each outer track and its platform, with lines of light, open over the glass boxes.
    const brass = s.artLayer(t.brass);
    const stairs = [VL.stairs.east, VL.stairs.middle].flatMap((x) => [x - 0.5, x + VL.stairs.length + 0.5]);
    const gaps = (za: number, zb: number) => {
      // Along x, the brass between the boxes on this side's platform.
      const cuts = [x0, ...stairs, x1];
      for (let i = 0; i + 1 < cuts.length; i += 2) face(brass, v(cuts[i], yB, za), v(cuts[i + 1], yB, za), v(cuts[i + 1], yB, zb), v(cuts[i], yB, zb), DOWN, rgb(0xffffff), 4);
      // Over a box, the brass reaches only round it.
      for (let i = 1; i + 1 < cuts.length; i += 2) {
        const p = platforms[(za + zb) / 2 < 0 ? 0 : 1];
        const pz = (p.z0 + p.z1) / 2;
        const w = VL.stairs.width / 2 + 0.4;
        for (const [zc, zd] of [[za, pz - w], [pz + w, zb]]) if (zd > zc) face(brass, v(cuts[i], yB, zc), v(cuts[i + 1], yB, zc), v(cuts[i + 1], yB, zd), v(cuts[i], yB, zd), DOWN, rgb(0xffffff), 4);
      }
      for (let z = za + 1.6; z < zb - 0.8; z += 3.2) s.unlit.box({ x: x0 + 2, y: yB - 0.06, z: z - 0.04 }, { x: x1 - 2, y: yB - 0.01, z: z + 0.04 }, C.glow, ['py']);
      for (let x = x0 + 5; x < x1; x += 9) for (const z of [za + 3.5, (za + zb) / 2 + 2]) s.light(x, yB - 0.4, z, LAMP.warm, 0.95, 11);
    };
    gaps(zS, colS - half);
    gaps(colN + half, zN);
    yield;

    // The high hall over the middle tracks: fascias down to the columns, pale concrete beams, the light let in between.
    for (const [z, nz] of [[colS - half, 1], [colN + half, -1]] as const) {
      face(s.lit, v(x0, yB, z), v(x1, yB, z), v(x1, yHi, z), v(x0, yHi, z), v(0, 0, nz), C.pale, 4);
      face(s.lit, v(x0, yB, z - nz * S.column), v(x1, yB, z - nz * S.column), v(x1, yB, z), v(x0, yB, z), DOWN, C.pale, 6);
    }
    face(s.lit, v(x0, yHi, colS - half), v(x1, yHi, colS - half), v(x1, yHi, colN + half), v(x0, yHi, colN + half), DOWN, C.pale, 4);
    for (let x = x0 + S.beamStep / 2; x < x1; x += S.beamStep) {
      s.lit.box({ x: x - 0.45, y: yHi - 1.6, z: colS - half }, { x: x + 0.45, y: yHi, z: colN + half }, C.beam, ['py']);
      s.unlit.box({ x: x + 1.2, y: yHi - 0.02, z: -4 }, { x: x + S.beamStep - 1.2, y: yHi - 0.005, z: 1.5 }, C.sky, ['py']);
    }
    for (let x = x0 + 6; x < x1; x += 12) s.light(x, yHi - 2.5, -1.3, LAMP.hall, 1.35, 22);
    yield;

    // The slate columns down the platforms, the benches between them, the sector letters on them.
    const slate = s.artLayer(t.slate);
    const signs = new Signs(24);
    const art = s.artLayer(signs.texture, true);
    const letters = 'ABCDE';
    for (const [p, zc] of [[platforms[0], colS], [platforms[1], colN]] as const) {
      let k = 0;
      for (let x = p.x0 + 6; x < p.x1 - 4; x += S.columnStep, k++) {
        if (stairs.some((sx, i) => i % 2 === 0 && x > sx - 1 && x < stairs[i + 1] + 1)) continue;
        for (const [n, a, b] of [
          [v(-1, 0, 0), v(x - half, yP, zc - half), v(x - half, yP, zc + half)], [v(1, 0, 0), v(x + half, yP, zc + half), v(x + half, yP, zc - half)],
          [v(0, 0, -1), v(x + half, yP, zc - half), v(x - half, yP, zc - half)], [v(0, 0, 1), v(x - half, yP, zc + half), v(x + half, yP, zc + half)],
        ] as const) face(slate, a, b, v(b.x, yB, b.z), v(a.x, yB, a.z), n, rgb(0xffffff), 2);
        box({ x: x - half, y: yP, z: zc - half }, { x: x + half, y: yB, z: zc + half });
        // Every fourth column carries its sector's letter, both sides along the platform.
        if (k % 4 === 0) {
          const row = signs.row(letters[Math.min(letters.length - 1, Math.floor(k / 4))], 'yellow');
          for (const nx of [-1, 1]) signs.put(art, v(x + nx * (half + 0.02), yP + 3.2, zc), v(nx, 0, 0), 0.7, 0.7, row);
        }
        // A bench of pale pine between this column and the next, on the platform's middle.
        const zb = (p.z0 + p.z1) / 2 + (zc < 0 ? -1.5 : 1.5);
        const bx = x + S.columnStep / 2;
        if (bx < p.x1 - 6 && !stairs.some((sx, i) => i % 2 === 0 && bx > sx - 2 && bx < stairs[i + 1] + 2)) {
          s.lit.box({ x: bx - 1.3, y: yP, z: zb - 0.25 }, { x: bx + 1.3, y: yP + 0.46, z: zb + 0.25 }, C.pine, ['ny']);
          s.lit.box({ x: bx - 0.25, y: yP + 0.46, z: zb - 0.25 }, { x: bx + 0.25, y: yP + 1.05, z: zb + 0.25 }, C.pine, ['ny']);
          box({ x: bx - 1.3, y: yP, z: zb - 0.25 }, { x: bx + 1.3, y: yP + 0.46, z: zb + 0.25 });
        }
      }
    }
    yield;

    // The glass boxes round the escalators, up to the halls over the brass (shut until the station opens).
    for (const p of platforms) {
      const pz = (p.z0 + p.z1) / 2;
      for (const [sx, up] of [[VL.stairs.east, sv.vastlanken.upPark], [VL.stairs.middle, sv.vastlanken.upGrand]] as const) {
        if (sx < p.x0 || sx + VL.stairs.length > p.x1) continue;
        yield* this.stairBox(s, colliders, sx, pz, yP, yB, signs, art, up, opens);
      }
    }

    // Names on the walls across the outer tracks, the tracks' numbers hung over the platforms, the way out west.
    const name = signs.row(sv.vastlanken.centralen);
    for (let x = x0 + 20; x < x1 - 10; x += 40) {
      signs.put(art, v(x, yP + 2.8, zS + 0.05), v(0, 0, 1), 4.2, 0.6, name);
      signs.put(art, v(x, yP + 2.8, zN - 0.05), v(0, 0, -1), 4.2, 0.6, name);
    }
    const numbers = [signs.row(`${sv.vastlanken.track.replace('{n}', '21')}  ·  ${sv.vastlanken.track.replace('{n}', '22')}`), signs.row(`${sv.vastlanken.track.replace('{n}', '23')}  ·  ${sv.vastlanken.track.replace('{n}', '24')}`)];
    platforms.forEach((p, i) => {
      for (let x = p.x0 + 18; x < p.x1 - 10; x += 45) {
        const z = (p.z0 + p.z1) / 2;
        signs.put(art, v(x, yB - 0.8, z), v(1, 0, 0), 3.2, 0.5, numbers[i], true);
        s.lit.box({ x: x - 0.02, y: yB - 0.55, z: z - 1 }, { x: x + 0.02, y: yB, z: z - 0.98 }, C.black);
        s.lit.box({ x: x - 0.02, y: yB - 0.55, z: z + 0.98 }, { x: x + 0.02, y: yB, z: z + 1 }, C.black);
      }
    });
    const exit = signs.row(`${sv.vastlanken.exit}  →`, 'exit');
    for (const p of platforms) signs.put(art, v(p.x1 - 3, yB - 0.7, (p.z0 + p.z1) / 2), v(-1, 0, 0), 2.4, 0.4, exit);
    // The departure boards over the middle of each platform: what the station says while it waits.
    for (const p of platforms) {
      const b = board(opens ? [sv.vastlanken.centralen, sv.vastlanken.opens] : [sv.vastlanken.welcome, ''], 2.6, 0.65);
      b.position.set((p.x0 + p.x1) / 2 + 30, yB - 1.1, (p.z0 + p.z1) / 2);
      b.rotation.y = Math.PI / 2;
      s.extras.add(b);
    }
    return s;
  }

  /** One glass box round an escalator, a stair and a second escalator, up from the platform at `x` to the hall above. */
  private *stairBox(s: Section, colliders: StaticCollider[], x: number, zc: number, yP: number, yB: number, signs: Signs, art: MeshBuilder, up: string, opens: boolean): Generator<void, void> {
    const { physics } = this;
    const L = VL.stairs.length, W = VL.stairs.width / 2, rise = VL.stairs.rise;
    const run = rise / Math.tan(Math.PI / 6);
    const xa = x + 3, xb = xa + run, xc = x + L;
    const yTop = yP + rise;
    const shaftTop = yTop + 3.2;
    const panes = new MeshBuilder(false);
    // Glass on three sides up to the brass, black mullions, a black rim along their tops; the front left open.
    for (const [za, zb, nz] of [[zc - W, zc - W, -1], [zc + W, zc + W, 1]] as const) {
      face(panes, v(x, yP, za), v(xc, yP, za), v(xc, yB, za), v(x, yB, za), v(0, 0, nz), rgb(0xffffff), 50);
      for (let mx = x; mx <= xc + 0.01; mx += 1.6) s.lit.box({ x: mx - 0.04, y: yP, z: za - 0.04 }, { x: mx + 0.04, y: yB, z: zb + 0.04 }, C.black);
      s.lit.box({ x, y: yB - 0.12, z: za - 0.05 }, { x: xc, y: yB, z: zb + 0.05 }, C.black, ['py']);
      colliders.push(physics.box({ x, y: yP, z: za - 0.05 }, { x: xc, y: shaftTop, z: zb + 0.05 }));
    }
    face(panes, v(xc, yP, zc - W), v(xc, yP, zc + W), v(xc, yB, zc + W), v(xc, yB, zc - W), v(1, 0, 0), rgb(0xffffff), 50);
    s.lit.box({ x: xc - 0.05, y: yB - 0.12, z: zc - W }, { x: xc + 0.05, y: yB, z: zc + W }, C.black, ['py']);
    // The back pane is glass to see through, and a wall to walk against.
    colliders.push(physics.box({ x: xc, y: yP, z: zc - W }, { x: xc + 0.1, y: shaftTop, z: zc + W }));
    const pane = new Mesh(panes.build(), glass());
    pane.renderOrder = 1;
    s.extras.add(pane);
    // Above the brass the box goes on up as a shaft of slate to the hall, where a shutter is down at its far end.
    const slate = s.artLayer(surfaces().slate);
    for (const [za, nz] of [[zc - W, 1], [zc + W, -1]] as const) face(slate, v(x, yB, za), v(xc, yB, za), v(xc, shaftTop, za), v(x, shaftTop, za), v(0, 0, nz), rgb(0xffffff), 3);
    face(slate, v(x, yB, zc - W), v(x, yB, zc + W), v(x, shaftTop, zc + W), v(x, shaftTop, zc - W), v(1, 0, 0), rgb(0xffffff), 3);
    face(slate, v(xc, yB, zc - W), v(xc, yB, zc + W), v(xc, yTop, zc + W), v(xc, yTop, zc - W), v(-1, 0, 0), rgb(0xffffff), 3);
    face(s.lit, v(x, shaftTop, zc - W), v(xc, shaftTop, zc - W), v(xc, shaftTop, zc + W), v(x, shaftTop, zc + W), DOWN, C.pale, 3);
    face(s.lit, v(xc - 0.1, yTop, zc - W), v(xc - 0.1, yTop, zc + W), v(xc - 0.1, yTop + 3, zc + W), v(xc - 0.1, yTop + 3, zc - W), v(-1, 0, 0), C.shutter, 1);
    for (let y = yTop + 0.15; y < yTop + 3; y += 0.15) s.lit.box({ x: xc - 0.12, y, z: zc - W + 0.1 }, { x: xc - 0.1, y: y + 0.02, z: zc + W - 0.1 }, rgb(0x6f7378));
    // The flights: two escalators (stopped, walked like stairs) either side of a fixed stair, all at the same slope.
    const slope = Math.atan2(rise, run);
    const len = Math.hypot(run, rise);
    for (const [za, zb, metal] of [[zc - W + 0.2, zc - 1.2, true], [zc - 1.2, zc + 1.2, false], [zc + 1.2, zc + W - 0.2, true]] as const) {
      // A step every 0.2 m up, as dark lines on the escalators and as treads on the stair.
      for (let k = 0; k < rise / 0.2; k++) {
        const ax = xa + (k * 0.2) / Math.tan(slope), ay = yP + k * 0.2;
        s.lit.box({ x: ax, y: ay, z: za }, { x: ax + 0.2 / Math.tan(slope), y: ay + 0.2, z: zb }, metal ? (k % 2 ? rgb(0x9aa1a6) : rgb(0x5d646a)) : C.pale, ['ny']);
      }
      // The escalators' handrails, black, a metre over the steps all the way up.
      if (metal) for (const zr of [za + 0.05, zb - 0.05]) slopedBar(s.lit, v(xa - 0.6, yP + 0.95, zr), v(xb + 0.6, yTop + 0.95, zr), 0.08, C.black);
      colliders.push(physics.tiltedBox({ x: (xa + xb) / 2 + Math.sin(slope) * 0.1, y: yP + rise / 2 - Math.cos(slope) * 0.1, z: (za + zb) / 2 }, { x: len / 2, y: 0.1, z: (zb - za) / 2 }, slope));
    }
    // The landing at the top, up to the shutter.
    s.floor.box({ x: xb, y: yTop - 0.2, z: zc - W }, { x: xc, y: yTop, z: zc + W }, C.granite, ['ny']);
    colliders.push(physics.box({ x: xb, y: yTop - 0.2, z: zc - W }, { x: xc, y: yTop, z: zc + W }));
    colliders.push(physics.box({ x: xc - 0.1, y: yTop, z: zc - W }, { x: xc + 0.5, y: shaftTop, z: zc + W }));
    s.light(x + L / 2, yB - 0.6, zc, LAMP.warm, 0.9, 10);
    s.light(xb, yTop + 2.6, zc, LAMP.hall, 0.9, 8);
    // Its name over the way in, and on the shutter what it says.
    signs.put(art, v(x - 0.05, yB - 0.6, zc), v(-1, 0, 0), 4.5, 0.55, signs.row(up, 'yellow'));
    signs.put(art, v(xc - 0.13, yTop + 1.5, zc), v(-1, 0, 0), 2.6, 0.5, signs.row(opens ? sv.vastlanken.opens : sv.vastlanken.closed, 'notice'));
    yield;
  }

  // ---- The throat: four tracks to two, west of the platforms ----

  private *throat(colliders: StaticCollider[]): Generator<void, Section> {
    const s = new Section('vl-throat', AMBIENT);
    const { physics } = this;
    const x0 = VL.station.west, x1 = VL.station.throat;
    const yAt = (x: number) => this.spine.frame(this.spine.locate(x, 0).s).y;
    const door = this.exitDoor();
    for (let x = x0; x < x1; x += 10) {
      const xb = Math.min(x1, x + 10);
      const [ya, yb] = [yAt(x), yAt(xb)];
      const [sa, sb] = [this.wallAt(x, -1), this.wallAt(xb, -1)];
      const [na, nb] = [this.wallAt(x, 1), this.wallAt(xb, 1)];
      face(s.lit, v(x, ya - VL.bed, sa), v(xb, yb - VL.bed, sb), v(xb, yb - VL.bed, nb), v(x, ya - VL.bed, na), UP, C.bed, 4);
      face(s.lit, v(x, ya + 7.5, sa), v(xb, yb + 7.5, sb), v(xb, yb + 7.5, nb), v(x, ya + 7.5, na), DOWN, C.concrete, 4);
      // The south wall, with the emergency exit's doorway at its west entrances.
      const doorHere = door.x >= x && door.x < xb;
      if (doorHere) {
        const t = (door.x - 1 - x) / (xb - x), u = (door.x + 1 - x) / (xb - x);
        const zA = sa + (sb - sa) * t, zB = sa + (sb - sa) * u;
        face(s.lit, v(x, ya - VL.bed, sa), v(door.x - 1, ya - VL.bed, zA), v(door.x - 1, ya + 7.5, zA), v(x, ya + 7.5, sa), v(0, 0, 1), C.concrete, 3);
        face(s.lit, v(door.x + 1, yb - VL.bed, zB), v(xb, yb - VL.bed, sb), v(xb, yb + 7.5, sb), v(door.x + 1, yb + 7.5, zB), v(0, 0, 1), C.concrete, 3);
        face(s.lit, v(door.x - 1, door.y + 2.3, zA), v(door.x + 1, door.y + 2.3, zB), v(door.x + 1, ya + 7.5, zB), v(door.x - 1, ya + 7.5, zA), v(0, 0, 1), C.concrete, 3);
        // Beyond the doorway, a lit stair climbs away to the street.
        for (let k = 0; k < 12; k++) s.lit.box({ x: door.x - 1, y: door.y + k * 0.18, z: zA - 1.2 - k * 0.28 - 0.28 }, { x: door.x + 1, y: door.y + (k + 1) * 0.18, z: zA - 1.2 - k * 0.28 }, C.pale, ['ny']);
        s.lit.box({ x: door.x - 1, y: door.y - 0.1, z: zA - 1.2 }, { x: door.x + 1, y: door.y, z: zA }, C.pale, ['ny']);
        s.light(door.x, door.y + 2.2, zA - 1.5, LAMP.hall, 1.0, 7);
      } else face(s.lit, v(x, ya - VL.bed, sa), v(xb, yb - VL.bed, sb), v(xb, yb + 7.5, sb), v(x, ya + 7.5, sa), v(0, 0, 1), C.concrete, 3);
      face(s.lit, v(x, ya - VL.bed, na), v(xb, yb - VL.bed, nb), v(xb, yb + 7.5, nb), v(x, ya + 7.5, na), v(0, 0, -1), C.concrete, 3);
      // Floor and walls to stand on and against.
      const mid = (x + xb) / 2, ym = (ya + yb) / 2;
      colliders.push(physics.box({ x, y: ym - VL.bed - 1, z: Math.min(sa, sb) - 1 }, { x: xb, y: ym - VL.bed, z: Math.max(na, nb) + 1 }));
      const wall = (za: number, zb: number, side: number) => colliders.push(physics.turnedBox({ x: mid, y: ym + 3.5, z: (za + zb) / 2 + side * 0.5 }, { x: 5.3, y: 4.5, z: 0.5 }, Math.atan2(-(zb - za), xb - x)));
      if (!doorHere) wall(sa, sb, -1);
      else {
        // Either side of the doorway, along the wall's slant as drawn; a floor and walls in the doorway.
        const t = (door.x - 1 - x) / (xb - x), u = (door.x + 1 - x) / (xb - x);
        const zA = sa + (sb - sa) * t, zB = sa + (sb - sa) * u;
        const piece = (ax: number, az: number, bx: number, bz: number) => colliders.push(physics.turnedBox({ x: (ax + bx) / 2, y: ym + 3.5, z: (az + bz) / 2 - 0.5 }, { x: Math.hypot(bx - ax, bz - az) / 2 + 0.05, y: 4.5, z: 0.5 }, Math.atan2(-(bz - az), bx - ax)));
        piece(x, sa, door.x - 1, zA);
        piece(door.x + 1, zB, xb, sb);
        const zd = Math.min(zA, zB);
        colliders.push(physics.box({ x: door.x - 1, y: door.y - 1, z: zd - 5 }, { x: door.x + 1, y: door.y, z: zd + 0.2 }));
        colliders.push(physics.box({ x: door.x - 1.6, y: door.y, z: zd - 6 }, { x: door.x - 1, y: door.y + 3, z: zd }));
        colliders.push(physics.box({ x: door.x + 1, y: door.y, z: zd - 6 }, { x: door.x + 1.6, y: door.y + 3, z: zd }));
        colliders.push(physics.box({ x: door.x - 1, y: door.y, z: zd - 6 }, { x: door.x + 1, y: door.y + 3, z: zd - 5 }));
      }
      wall(na, nb, 1);
      for (const [z, nz] of [[sa, 1], [na, -1]] as const) {
        s.unlit.box({ x: mid - 0.3, y: ya + 3.1, z: z + nz * 0.08 - 0.06 }, { x: mid + 0.3, y: ya + 3.3, z: z + nz * 0.08 + 0.06 }, C.glow);
        s.light(mid, ya + 3.2, z + nz * 1.2, LAMP.tunnel, 1.0, 12);
      }
    }
    // Its west end: a wall across round the tunnel's mouth.
    {
      const f = this.spine.frame(this.at.throat);
      const [zs, zn] = [this.wallAt(x1, -1), this.wallAt(x1, 1)];
      const y0 = f.y - VL.bed, y1 = f.y + 7.5;
      const mouthS = f.z - VL.tunnel.half, mouthN = f.z + VL.tunnel.half, top = f.y + VL.tunnel.height;
      const n = v(-1, 0, 0);
      face(s.lit, v(x1, y0, zs), v(x1, y0, mouthS), v(x1, y1, mouthS), v(x1, y1, zs), n, C.concrete, 3);
      face(s.lit, v(x1, y0, mouthN), v(x1, y0, zn), v(x1, y1, zn), v(x1, y1, mouthN), n, C.concrete, 3);
      face(s.lit, v(x1, top, mouthS), v(x1, top, mouthN), v(x1, y1, mouthN), v(x1, y1, mouthS), n, C.concrete, 3);
      colliders.push(physics.box({ x: x1, y: y0, z: zs - 1 }, { x: x1 + 1, y: y1, z: mouthS }));
      colliders.push(physics.box({ x: x1, y: y0, z: mouthN }, { x: x1 + 1, y: y1, z: zn + 1 }));
    }
    // The four tracks, as OSM lays them, joining two by two.
    for (const track of this.tracks) {
      const pts = track.filter((p) => p[0] >= x0 - 5 && p[0] <= x1 + 5);
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]];
        layAlong(s.lit, v(a[0], yAt(a[0]), a[1]), v(b[0], yAt(b[0]), b[1]));
      }
    }
    const signs = new Signs(4);
    const art = s.artLayer(signs.texture, true);
    signs.put(art, v(door.x, door.y + 2.7, this.wallAt(door.x, -1) + 0.06), v(0, 0, 1), 2.2, 0.4, signs.row(sv.vastlanken.exit, 'exit'));
    yield;
    return s;
  }

  // ---- The tunnel, from the throat to Haga ----

  private *tunnel(colliders: StaticCollider[], s0: number, s1: number): Generator<void, Section> {
    const { physics } = this;
    const T = VL.tunnel;
    const s = new Section(`vl-tunnel-${Math.round(s0)}`, DARK);
    const frames = this.spine.frames(s0, s1, 5);
    const rails = Math.min(s1, this.at.railsEnd);
    const rock = Math.max(s0, Math.min(s1, this.at.rock));
    const H = T.half, W = T.walk, up = T.walkUp;
    const hoist = this.at.hoist;
    // The floor: the track bed while the rails run, the raw floor of the works beyond.
    const split = (a: number, b: number) => (b > a + 0.5 ? this.spine.frames(a, b, 5) : null);
    const laid = split(s0, rails), raw = split(Math.max(s0, rails), s1);
    if (laid) sweep(s.lit, laid, [-H + W, -VL.bed], [H - W, -VL.bed], C.bed, [0, 1], 3);
    if (raw) sweep(s.lit, raw, [-H + W, -VL.bed], [H - W, -VL.bed], C.wetFloor, [0, 1], 3);
    // The walkways along both walls, and the walls: concrete as far as the rock, then the rock itself, shotcreted.
    for (const side of [-1, 1]) {
      const u0 = side * H, u1 = side * (H - W);
      sweep(s.lit, frames, [u0, up], [u1, up], C.concrete, [0, 1], 3);
      sweep(s.lit, frames, [u1, -VL.bed], [u1, up], C.concrete, [-side, 0], 3);
    }
    const concrete = split(s0, rock), shot = split(rock, s1);
    // The left wall opens onto the hoist's shaft.
    const walls = (part: Frame[] | null, paint: Paint) => {
      if (!part) return;
      for (const side of [-1, 1]) {
        const pieces = side > 0 && hoist > part[0].s && hoist < part[part.length - 1].s
          ? [this.spine.frames(part[0].s, hoist - VL.hoist.half - 0.4, 5), this.spine.frames(hoist + VL.hoist.half + 0.4, part[part.length - 1].s, 5)]
          : [part];
        for (const piece of pieces) if (piece.length > 1) sweep(s.lit, piece, [side * H, up], [side * H, T.height], paint, [-side, 0], 2.5);
      }
      sweep(s.lit, part, [-H, T.height], [H, T.height], paint, [0, -1], 3);
    };
    walls(concrete, C.concrete);
    walls(shot, C.shotcrete);
    // Where the concrete gives way to rock, a heavier frame.
    if (this.at.rock > s0 && this.at.rock < s1) {
      const f = this.spine.frames(this.at.rock - 0.6, this.at.rock + 0.6, 1.2);
      sweepSection(s.lit, f, [[-H, up], [-H + 0.5, T.height - 0.5], [H - 0.5, T.height - 0.5], [H, up]], C.slab, [0, 3]);
    }
    yield;
    // The tracks as far as they are laid, and their end, buffers and a barrier and what it says. (A sign's atlas only
    // where there is a sign: a layer left empty never becomes a mesh, so its texture would never be let go of.)
    if (laid) {
      for (const u of [-T.track, T.track]) {
        sweep(s.lit, laid, [u - 1.2, -VL.rail], [u + 1.2, -VL.rail], C.slab, [0, 1], 3);
        for (const r of [u - 0.7175, u + 0.7175]) {
          sweep(s.lit, laid, [r - 0.035, 0], [r + 0.035, 0], C.railTop, [0, 1], 1);
          sweep(s.lit, laid, [r - 0.035, -VL.rail], [r - 0.035, 0], C.steel, [-1, 0], 1);
          sweep(s.lit, laid, [r + 0.035, -VL.rail], [r + 0.035, 0], C.steel, [1, 0], 1);
        }
      }
      if (rails < s1) {
        const f = this.spine.frame(rails);
        const along = v(f.tx, 0, f.tz), left = v(f.nx, 0, f.nz);
        const ang = Math.atan2(-f.tz, f.tx);
        // A buffer stop at each track's end.
        for (const u of [-T.track, T.track]) {
          const c = place(f, [u, 0.5]);
          orientedBox(s.lit, c.clone().setY(f.y + 0.05), v(0.5, 0.55, 1.2), along, left, C.orange);
          colliders.push(physics.turnedBox({ x: c.x, y: f.y + 0.05, z: c.z }, { x: 0.5, y: 0.55, z: 1.2 }, ang));
        }
        // And a barrier across the tracks beyond them, red and white; the walkways go on past it into the works.
        const g = this.spine.frame(rails + 2);
        const facing = v(-g.tx, 0, -g.tz);
        for (let k = 0; k < 6; k++) {
          const u0 = -H + W + ((2 * (H - W)) * k) / 6, u1 = -H + W + ((2 * (H - W)) * (k + 1)) / 6;
          face(s.lit, place(g, [u0, 0.3]), place(g, [u1, 0.3]), place(g, [u1, 1.3]), place(g, [u0, 1.3]), facing, k % 2 ? rgb(0xf2f2f2) : rgb(0xc8332b), 1);
          face(s.lit, place(g, [u1, 0.3]), place(g, [u0, 0.3]), place(g, [u0, 1.3]), place(g, [u1, 1.3]), facing.clone().negate(), k % 2 ? rgb(0xf2f2f2) : rgb(0xc8332b), 1);
        }
        const gc = place(g, [0, 0.8]);
        colliders.push(physics.turnedBox({ x: gc.x, y: gc.y, z: gc.z }, { x: 0.1, y: 1.3, z: H - W }, ang));
        const at = place(this.spine.frame(rails + 1.9), [0, 1.9]);
        const signs = new Signs(1);
        signs.put(s.artLayer(signs.texture, true), at, facing, 3.2, 0.5, signs.row(sv.vastlanken.railEnd, 'notice'));
      }
    }
    // Beyond the rails, the works' ventilation duct along the roof, and lamps on a cable under it.
    if (raw) {
      const duct: Cross[] = Array.from({ length: 9 }, (_, k) => [-2.8 + 0.55 * Math.cos((k / 8) * Math.PI * 2), T.height - 0.8 + 0.55 * Math.sin((k / 8) * Math.PI * 2)]);
      for (let k = 1; k < duct.length; k++) {
        const [a, b] = [duct[k - 1], duct[k]];
        sweep(s.lit, raw, a, b, C.yellow, [(a[0] + b[0]) / 2 + 2.8, (a[1] + b[1]) / 2 - (T.height - 0.8)], 3);
      }
    }
    // Lamps: the finished tunnel's on its walls every 24 m, the works' on their cable every 8 m, a light every 16. The
    // lamps of the stretches either side light this one's ends too, so no seam shows between two stretches.
    for (let at = Math.ceil((s0 - 16) / 8) * 8; at < s1 + 16; at += 8) {
      if (at < this.at.throat || at > this.at.haga) continue;
      const f = this.spine.frame(at);
      const mine = at >= s0 && at < s1;
      if (at < this.at.railsEnd) {
        if (at % 24 !== 0) continue;
        for (const side of [-1, 1]) {
          const p = place(f, [side * (H - 0.08), 3.2]);
          if (mine) s.unlit.box({ x: p.x - 0.25, y: p.y - 0.08, z: p.z - 0.25 }, { x: p.x + 0.25, y: p.y + 0.08, z: p.z + 0.25 }, C.glow);
          const q = place(f, [side * (H - 1.5), 3.2]);
          s.light(q.x, q.y, q.z, LAMP.tunnel, 1.0, 13);
        }
      } else {
        const p = place(f, [-1.9, T.height - 1.5]);
        if (mine) s.unlit.box({ x: p.x - 0.08, y: p.y - 0.12, z: p.z - 0.08 }, { x: p.x + 0.08, y: p.y + 0.02, z: p.z + 0.08 }, C.glow);
        if (at % 16 === 0) s.light(p.x, p.y - 0.3, p.z, LAMP.work, 1.0, 11);
      }
    }
    // The hoist's foot in a chamber beside the left wall, its cage and its mast up the shaft.
    if (hoist >= s0 && hoist < s1) this.hoistShaft(s, colliders);
    // To stand on and against: the floor, the walkways, the walls (open at the hoist).
    colliders.push(...sweptBoxes(physics, frames, -H, H, -VL.bed - 1, -VL.bed));
    for (const side of [-1, 1]) {
      colliders.push(...sweptBoxes(physics, frames, Math.min(side * H, side * (H - W)), Math.max(side * H, side * (H - W)), -VL.bed, up));
      const pieces = side > 0 && hoist > s0 && hoist < s1
        ? [this.spine.frames(s0, hoist - VL.hoist.half - 0.4, 5), this.spine.frames(hoist + VL.hoist.half + 0.4, s1, 5)]
        : [frames];
      for (const piece of pieces) if (piece.length > 1) colliders.push(...sweptBoxes(physics, piece, side > 0 ? H : -H - 1, side > 0 ? H + 1 : -H, up, T.height + 1));
    }
    // Where the tunnel ends at the throat, nothing; where it meets Haga's hall, the hall carries on.
    yield;
    return s;
  }

  /** The construction hoist's foot: a chamber off the tunnel's left wall, the cage on its floor, the shaft up toward the street. */
  private hoistShaft(s: Section, colliders: StaticCollider[]): void {
    const { physics } = this;
    const f = this.spine.frame(this.at.hoist);
    const c = this.cage();
    const h = VL.hoist.half;
    const y = f.y + VL.tunnel.walkUp;
    const t = surfaces();
    const cageArt = s.artLayer(t.mesh);
    // The shaft, from the chamber's floor up toward the street, in the frame of the tunnel at the hoist.
    const along = v(f.tx, 0, f.tz), left = v(f.nx, 0, f.nz);
    const at = (u: number, w: number, yy: number) => v(c.x + left.x * u + along.x * w, yy, c.z + left.z * u + along.z * w);
    const top = STREET_Y - 1.4;
    const inner = h + 0.9;
    for (const [n, a, b] of [
      [left.clone().negate(), at(inner, -inner, y), at(inner, inner, y)],
      [along.clone(), at(-inner, -inner, y), at(inner, -inner, y)],
      [along.clone().negate(), at(inner, inner, y), at(-inner, inner, y)],
    ] as const) face(s.lit, a, b, v(b.x, top, b.z), v(a.x, top, a.z), n, C.concrete, 3);
    face(s.lit, at(-inner, -inner, y), at(inner, -inner, y), at(inner, inner, y), at(-inner, inner, y), UP, C.wetFloor, 2);
    // The cage: mesh walls on three sides, its gate open to the tunnel, a lamp inside; the mast's tubes up the shaft.
    for (const [u0, w0, u1, w1] of [[-h, -h, h, -h], [h, -h, h, h], [-h, h, h, h]] as const) {
      face(cageArt, at(u0, w0, y), at(u1, w1, y), at(u1, w1, y + 2.4), at(u0, w0, y + 2.4), at(0, 0, y).sub(at((u0 + u1) / 2, (w0 + w1) / 2, y)), rgb(0xffffff), 3);
    }
    s.lit.box({ x: Math.min(...[at(-h, -h, 0).x, at(h, h, 0).x]), y: y + 2.4, z: Math.min(at(-h, -h, 0).z, at(h, h, 0).z) }, { x: Math.max(at(-h, -h, 0).x, at(h, h, 0).x), y: y + 2.55, z: Math.max(at(-h, -h, 0).z, at(h, h, 0).z) }, C.yellow);
    for (const [u, w] of [[h + 0.3, -0.5], [h + 0.3, 0.5]]) {
      const p = at(u, w, y);
      s.lit.box({ x: p.x - 0.07, y, z: p.z - 0.07 }, { x: p.x + 0.07, y: top, z: p.z + 0.07 }, C.yellow);
    }
    s.light(c.x, y + 2.1, c.z, LAMP.work, 1.1, 9);
    // The cage's walls and the shaft's to stand against; the chamber's floor.
    const ang = Math.atan2(-left.z, left.x);
    colliders.push(physics.turnedBox({ x: c.x, y: y - 0.5, z: c.z }, { x: inner, y: 0.5, z: inner }, ang));
    for (const [u, w, hu, hw] of [[inner + 0.5, 0, 0.5, inner + 1], [0, -h - 0.05, h, 0.05], [0, h + 0.05, h, 0.05], [h + 0.05, 0, 0.05, h]] as const) {
      const p = at(u, w, 0);
      colliders.push(physics.turnedBox({ x: p.x, y: y + 2, z: p.z }, { x: hu, y: 2, z: hw }, ang));
    }
  }

  // ---- Haga's hall, being dug ----

  private *hagaHall(colliders: StaticCollider[]): Generator<void, Section> {
    const Hg = VL.haga;
    const s = new Section('vl-haga', DARK);
    const { physics } = this;
    const s0 = this.at.haga, dug = s0 + Hg.dug, end = dug + Hg.pilots;
    const frames = this.spine.frames(s0, dug, 4);
    const floor = -0.6;
    // The hall's section: walls up to the springing, then the vault to the crown; a little rough, as blasted.
    const vault: Cross[] = [];
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * Math.PI;
      vault.push([Hg.half * Math.cos(a), Hg.wall + (Hg.crown - Hg.wall) * Math.sin(a)]);
    }
    const profile: Cross[] = [[Hg.half, floor], ...vault, [-Hg.half, floor]];
    sweepSection(s.lit, frames, profile, C.rock, [0, Hg.wall], 3);
    sweep(s.lit, frames, [-Hg.half, floor], [Hg.half, floor], C.wetFloor, [0, 1], 3);
    // Where the hall meets the tunnel from the north, a wall round the tunnel's mouth; at the far end, the rock not yet
    // dug, with the three pilot tunnels into it.
    const f0 = this.spine.frame(s0), f1 = this.spine.frame(dug);
    endWall(s.lit, f0, Hg.half, Hg.wall, Hg.crown, floor, [[-VL.tunnel.half, VL.tunnel.half, () => VL.tunnel.height]], 1, C.shotcrete);
    const pilots = [-16, 0, 16];
    endWall(s.lit, f1, Hg.half, Hg.wall, Hg.crown, floor, pilots.map((u) => [u - 4, u + 4, (w: number) => pilotTop(w - u)] as Hole), -1, C.rock);
    yield;
    for (const u of pilots) {
      const pf = this.spine.frames(dug, end, 4);
      sweepSection(s.lit, pf, [[u + 4, floor], ...PILOT.map(([w, h]) => [u + w, h] as Cross), [u - 4, floor]], C.rock, [u, 3], 2.5);
      sweep(s.lit, pf, [u - 4, floor], [u + 4, floor], C.wetFloor, [0, 1], 3);
      const fe = this.spine.frame(end);
      endWall(s.lit, fe, 4, 4.5, 7, floor, [], -1, C.rock, u);
      colliders.push(...sweptBoxes(physics, pf, u - 4, u + 4, floor - 1, floor));
      colliders.push(...sweptBoxes(physics, pf, u + 4, u + 5, floor, 8), ...sweptBoxes(physics, pf, u - 5, u - 4, floor, 8));
      const pe = this.spine.frames(end - 0.5, end + 0.5, 1);
      colliders.push(...sweptBoxes(physics, pe, u - 4, u + 4, floor, 8));
      for (let at = dug + 10; at < end; at += 20) {
        const p = place(this.spine.frame(at), [u, 5.5]);
        s.unlit.box({ x: p.x - 0.1, y: p.y - 0.15, z: p.z - 0.1 }, { x: p.x + 0.1, y: p.y, z: p.z + 0.1 }, C.glow);
        s.light(p.x, p.y - 0.4, p.z, LAMP.work, 1.0, 12);
      }
    }
    yield;
    // The pillars down the middle: cast and crowned near the north end, in formwork further in, steel only at the far end.
    const signs = new Signs(6);
    const art = s.artLayer(signs.texture, true);
    let k = 0;
    for (let at = s0 + 8; at < dug - 4; at += Hg.pillarStep, k++) {
      const f = this.spine.frame(at);
      const p = place(f, [0, floor]);
      const crown = Hg.crown - 0.4;
      if (k < 10) {
        column(s.lit, p, 0.9, floor, 10, C.pale);
        // The crown widens like an upturned cone into the vault.
        for (let j = 0; j < 8; j++) {
          const a0 = (j / 8) * Math.PI * 2, a1 = ((j + 1) / 8) * Math.PI * 2;
          const q = (a: number, r: number, yy: number) => v(p.x + Math.cos(a) * r, f.y + yy, p.z + Math.sin(a) * r);
          face(s.lit, q(a0, 0.9, 10), q(a1, 0.9, 10), q(a1, 2.4, crown), q(a0, 2.4, crown), v(Math.cos((a0 + a1) / 2), -0.5, Math.sin((a0 + a1) / 2)), C.pale, 3);
        }
        colliders.push(physics.box({ x: p.x - 0.8, y: f.y + floor, z: p.z - 0.8 }, { x: p.x + 0.8, y: f.y + crown, z: p.z + 0.8 }));
      } else if (k < 14) {
        s.lit.box({ x: p.x - 1.1, y: f.y + floor, z: p.z - 1.1 }, { x: p.x + 1.1, y: f.y + 6.5, z: p.z + 1.1 }, C.plywood);
        for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) s.lit.box({ x: p.x + dx - 0.04, y: f.y + floor, z: p.z + dz - 0.04 }, { x: p.x + dx + 0.04, y: f.y + 7.2, z: p.z + dz + 0.04 }, C.steel);
        for (const yy of [2.2, 4.4, 6.6]) s.lit.box({ x: p.x - 1.65, y: f.y + yy, z: p.z - 1.65 }, { x: p.x + 1.65, y: f.y + yy + 0.06, z: p.z + 1.65 }, C.steel, ['ny']);
        colliders.push(physics.box({ x: p.x - 1.7, y: f.y + floor, z: p.z - 1.7 }, { x: p.x + 1.7, y: f.y + 7.2, z: p.z + 1.7 }));
      } else {
        for (let j = 0; j < 12; j++) {
          const a = (j / 12) * Math.PI * 2;
          s.lit.box({ x: p.x + Math.cos(a) * 0.8 - 0.03, y: f.y + floor, z: p.z + Math.sin(a) * 0.8 - 0.03 }, { x: p.x + Math.cos(a) * 0.8 + 0.03, y: f.y + 9, z: p.z + Math.sin(a) * 0.8 + 0.03 }, C.rebar);
        }
        colliders.push(physics.box({ x: p.x - 0.9, y: f.y + floor, z: p.z - 0.9 }, { x: p.x + 0.9, y: f.y + 9, z: p.z + 0.9 }));
      }
    }
    yield;
    // The works' things: a wheel loader, a drill rig at the middle pilot, site huts by the north wall, rebar, floodlights.
    const thing = (sAt: number, u: number, parts: Array<[number, number, number, number, number, number, RGB]>) => {
      const f = this.spine.frame(sAt);
      const along = v(f.tx, 0, f.tz), left = v(f.nx, 0, f.nz);
      const ang = Math.atan2(-along.z, along.x);
      for (const [w0, w1, y0, y1, u0, u1, paint] of parts) {
        const c = v(f.x, 0, f.z).addScaledVector(left, u + (u0 + u1) / 2).addScaledVector(along, (w0 + w1) / 2);
        const half = v((w1 - w0) / 2, (y1 - y0) / 2, (u1 - u0) / 2);
        orientedBox(s.lit, c.setY(f.y + floor + (y0 + y1) / 2), half, along, left, paint);
        colliders.push(physics.turnedBox({ x: c.x, y: c.y, z: c.z }, half, ang));
      }
    };
    thing(s0 + 40, -14, [[-3.5, 3.5, 0, 1.6, -1.4, 1.4, C.yellow], [-1, 2, 1.6, 3.4, -1.1, 1.1, C.yellow], [3.5, 5, 0.3, 1.6, -1.6, 1.6, C.steel]]);
    thing(dug + 12, 0, [[-3, 3, 0, 1.8, -1.3, 1.3, C.yellow], [-2, 0.5, 1.8, 3.6, -1, 1, C.yellow], [3, 9, 2.6, 3, -0.15, 0.15, C.steel]]);
    thing(s0 + 6, 18, [[-3, 3, 0, 2.6, -1.25, 1.25, rgb(0xe9e4d8)], [-3, 3, 2.6, 5.2, -1.25, 1.25, rgb(0xe9e4d8)]]);
    thing(s0 + 6, 13, [[-3, 3, 0, 2.6, -1.25, 1.25, rgb(0xd9d2c0)]]);
    thing(s0 + 70, 12, [[-6, 6, 0, 0.5, -1.2, 1.2, C.rebar]]);
    for (const [at, u] of [[s0 + 25, -8], [s0 + 25, 10], [s0 + 75, -10], [s0 + 120, 9], [s0 + 160, -12]] as const) {
      const f = this.spine.frame(at);
      const p = place(f, [u, floor]);
      s.lit.box({ x: p.x - 0.05, y: p.y, z: p.z - 0.05 }, { x: p.x + 0.05, y: p.y + 4, z: p.z + 0.05 }, C.black);
      s.unlit.box({ x: p.x - 0.5, y: p.y + 4, z: p.z - 0.2 }, { x: p.x + 0.5, y: p.y + 4.6, z: p.z + 0.2 }, C.glow);
      s.light(p.x, p.y + 4.3, p.z, LAMP.work, 1.7, 34);
    }
    // What the works say: the station, when it opens, what to wear.
    const fs = this.spine.frame(s0 + 3);
    const sign = place(fs, [VL.tunnel.half + 3, 3.2]);
    const towards = v(fs.tx, 0, fs.tz);
    signs.put(art, sign, towards, 6, 0.75, signs.row(sv.vastlanken.hagaOpens, 'notice'));
    signs.put(art, sign.clone().add(v(0, -0.9, 0)), towards, 6, 0.5, signs.row(sv.vastlanken.ppe, 'notice'));
    // The hall's floor and walls to stand on and against, and the wall at its north end round the tunnel's mouth.
    colliders.push(...sweptBoxes(physics, frames, -Hg.half, Hg.half, floor - 1, floor));
    colliders.push(...sweptBoxes(physics, frames, Hg.half, Hg.half + 1, floor, Hg.crown), ...sweptBoxes(physics, frames, -Hg.half - 1, -Hg.half, floor, Hg.crown));
    for (const [a, b] of [[-Hg.half, -VL.tunnel.half], [VL.tunnel.half, Hg.half]]) colliders.push(...sweptBoxes(physics, this.spine.frames(s0 - 0.5, s0 + 0.5, 1), a, b, floor, Hg.crown));
    for (const [a, b] of [[-Hg.half, -20], [-12, -4], [4, 12], [20, Hg.half]]) colliders.push(...sweptBoxes(physics, this.spine.frames(dug - 0.5, dug + 0.5, 1), a, b, floor, Hg.crown));
    // The ventilation duct along the hall, and the lamps on its cable.
    const duct: Cross[] = Array.from({ length: 9 }, (_, j) => [-6 + 0.7 * Math.cos((j / 8) * Math.PI * 2), Hg.crown - 2.2 + 0.7 * Math.sin((j / 8) * Math.PI * 2)]);
    for (let j = 1; j < duct.length; j++) {
      const [a, b] = [duct[j - 1], duct[j]];
      sweep(s.lit, frames, a, b, C.yellow, [(a[0] + b[0]) / 2 + 6, (a[1] + b[1]) / 2 - (Hg.crown - 2.2)], 3);
    }
    for (let at = s0 + 4; at < dug; at += 12) {
      const p = place(this.spine.frame(at), [-4.6, Hg.crown - 3.2]);
      s.unlit.box({ x: p.x - 0.1, y: p.y - 0.15, z: p.z - 0.1 }, { x: p.x + 0.1, y: p.y, z: p.z + 0.1 }, C.glow);
      s.light(p.x, p.y - 0.4, p.z, LAMP.work, 0.9, 16);
    }
    yield;
    return s;
  }

  // ---- Up on the street ----

  /** The works at Rosenlund: a fence round the hoist's tower and the site huts, its gate open toward the cage. */
  private *works(colliders: StaticCollider[]): Generator<void, Section> {
    const s = new Section('vl-works', rgb(0x6a6e74), false, true);
    const { physics } = this;
    const c = this.cage();
    const y = STREET_Y;
    const h = VL.hoist.half;
    const t = surfaces();
    const meshArt = s.artLayer(t.mesh);
    // The fence: panels of mesh on concrete feet, a gate left open on the north side, in line with the cage's door.
    const [fx0, fx1, fz0, fz1] = [c.x - 16, c.x + 14, c.z - 12, c.z + 9];
    const gate = [c.x - 2.5, c.x + 2.5];
    const fenceRun = (ax: number, az: number, bx: number, bz: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      const n = v(-(bz - az), 0, bx - ax).normalize();
      for (let d = 0; d < len - 0.01; d += 3.5) {
        const e = Math.min(len, d + 3.5);
        const p = v(ax + ((bx - ax) * d) / len, y, az + ((bz - az) * d) / len), q = v(ax + ((bx - ax) * e) / len, y, az + ((bz - az) * e) / len);
        face(meshArt, p, q, v(q.x, y + 2, q.z), v(p.x, y + 2, p.z), n, rgb(0xffffff), 4);
        face(meshArt, q, p, v(p.x, y + 2, p.z), v(q.x, y + 2, q.z), n.clone().negate(), rgb(0xffffff), 4);
        s.lit.box({ x: p.x - 0.3, y, z: p.z - 0.15 }, { x: p.x + 0.3, y: y + 0.15, z: p.z + 0.15 }, C.concrete);
      }
      colliders.push(physics.turnedBox({ x: (ax + bx) / 2, y: y + 1, z: (az + bz) / 2 }, { x: len / 2, y: 1.2, z: 0.1 }, Math.atan2(-(bz - az), bx - ax)));
    };
    fenceRun(fx0, fz0, fx1, fz0);
    fenceRun(fx1, fz0, fx1, fz1);
    fenceRun(fx0, fz1, fx0, fz0);
    fenceRun(fx1, fz1, gate[1], fz1);
    fenceRun(gate[0], fz1, fx0, fz1);
    // The ground inside: gravel and steel plates over the shaft's collar.
    face(s.lit, v(fx0, y + 0.02, fz0), v(fx1, y + 0.02, fz0), v(fx1, y + 0.02, fz1), v(fx0, y + 0.02, fz1), UP, (p) => mix(rgb(0x6b6760), rgb(0x86817a), noise3(p.x, 0, p.z, 2)), 3);
    s.lit.box({ x: c.x - h - 1.5, y, z: c.z - h - 1.5 }, { x: c.x + h + 1.5, y: y + 0.12, z: c.z + h + 1.5 }, rgb(0x55595e), ['ny']);
    // The hoist: its cage at the street, gate open north, and its mast up past the cage.
    for (const [ax, az, bx, bz, n] of [[c.x - h, c.z - h, c.x + h, c.z - h, v(0, 0, 1)], [c.x + h, c.z - h, c.x + h, c.z + h, v(-1, 0, 0)], [c.x - h, c.z + h, c.x - h, c.z - h, v(1, 0, 0)]] as const) {
      face(meshArt, v(ax, y + 0.12, az), v(bx, y + 0.12, bz), v(bx, y + 2.5, bz), v(ax, y + 2.5, az), n, rgb(0xffffff), 3);
      face(meshArt, v(bx, y + 0.12, bz), v(ax, y + 0.12, az), v(ax, y + 2.5, az), v(bx, y + 2.5, bz), n.clone().negate(), rgb(0xffffff), 3);
    }
    s.lit.box({ x: c.x - h, y: y + 2.5, z: c.z - h }, { x: c.x + h, y: y + 2.65, z: c.z + h }, C.yellow);
    for (const dx of [-0.6, 0.6]) for (const dz of [-0.6, 0.6]) s.lit.box({ x: c.x + dx - 0.08, y, z: c.z - h - 1.2 + dz - 0.08 }, { x: c.x + dx + 0.08, y: y + 22, z: c.z - h - 1.2 + dz + 0.08 }, C.yellow);
    for (let yy = y + 2; yy < y + 22; yy += 2) s.lit.box({ x: c.x - 0.68, y: yy, z: c.z - h - 1.88 }, { x: c.x + 0.68, y: yy + 0.08, z: c.z - h - 0.52 }, C.yellow, ['ny']);
    colliders.push(physics.box({ x: c.x - h, y, z: c.z - h - 0.1 }, { x: c.x + h, y: y + 2.6, z: c.z - h }));
    colliders.push(physics.box({ x: c.x - h - 0.1, y, z: c.z - h }, { x: c.x - h, y: y + 2.6, z: c.z + h }));
    colliders.push(physics.box({ x: c.x + h, y, z: c.z - h }, { x: c.x + h + 0.1, y: y + 2.6, z: c.z + h }));
    colliders.push(physics.box({ x: c.x - 0.8, y, z: c.z - h - 2 }, { x: c.x + 0.8, y: y + 22, z: c.z - h - 0.4 }));
    // Two site huts stacked by the east fence, a floodlight on a pole.
    for (const [y0, paint] of [[y, rgb(0xe9e4d8)], [y + 2.7, rgb(0xd9d2c0)]] as const) s.lit.box({ x: fx1 - 3.2, y: y0, z: fz0 + 1 }, { x: fx1 - 0.8, y: y0 + 2.6, z: fz0 + 7 }, paint);
    colliders.push(physics.box({ x: fx1 - 3.2, y, z: fz0 + 1 }, { x: fx1 - 0.8, y: y + 5.3, z: fz0 + 7 }));
    s.lit.box({ x: fx0 + 1 - 0.07, y, z: fz0 + 1 - 0.07 }, { x: fx0 + 1 + 0.07, y: y + 8, z: fz0 + 1 + 0.07 }, C.black);
    s.unlit.box({ x: fx0 + 0.6, y: y + 8, z: fz0 + 0.8 }, { x: fx0 + 1.4, y: y + 8.5, z: fz0 + 1.2 }, C.glow);
    // The sign on the gate's posts, both ways.
    const signs = new Signs(4);
    const art = s.artLayer(signs.texture, true);
    signs.put(art, v(gate[1] + 2.2, y + 1.4, fz1 + 0.06), v(0, 0, 1), 3.6, 0.55, signs.row(sv.vastlanken.siteName, 'notice'));
    signs.put(art, v(gate[1] + 2.2, y + 0.8, fz1 + 0.06), v(0, 0, 1), 3.6, 0.45, signs.row(sv.vastlanken.siteNo, 'notice'));
    s.light(c.x, y + 2.3, c.z, LAMP.work, 0.8, 8);
    yield;
    return s;
  }

  /** The emergency exit's hut on Nils Ericsonsgatan: concrete, a steel door on its south side, the green sign over it. */
  private *exitHut(colliders: StaticCollider[]): Generator<void, Section> {
    const s = new Section('vl-exit', rgb(0x6a6e74), false, true);
    const y = STREET_Y;
    const [x0, x1, z0, z1] = [EXIT.x - 2, EXIT.x + 2, EXIT.z - 1.2, EXIT.z + 1.2];
    s.lit.box({ x: x0, y, z: z0 }, { x: x1, y: y + 2.8, z: z1 }, C.concrete, ['ny']);
    s.lit.box({ x: x0 - 0.15, y: y + 2.8, z: z0 - 0.15 }, { x: x1 + 0.15, y: y + 3, z: z1 + 0.15 }, C.slab);
    s.lit.box({ x: EXIT.x - 0.55, y, z: z0 - 0.04 }, { x: EXIT.x + 0.55, y: y + 2.1, z: z0 }, rgb(0x55606a), ['ny']);
    const signs = new Signs(2);
    const art = s.artLayer(signs.texture, true);
    signs.put(art, v(EXIT.x, y + 2.4, z0 - 0.05), v(0, 0, -1), 1.6, 0.35, signs.row(sv.vastlanken.exit, 'exit'));
    this.physics && colliders.push(this.physics.box({ x: x0, y, z: z0 }, { x: x1, y: y + 3, z: z1 }));
    yield;
    return s;
  }
}

/** The emergency exit's hut on the street (at the playable area's north edge, on Nils Ericsonsgatan), and the door it leads from below. */
const EXIT = { x: VL.exit.hutX, z: VL.exit.hutZ } as const;
const EXIT_DOOR_X = VL.exit.doorX;

/** A track's z at `x` (its line's points run along x through the station and its throat). */
function trackZ(track: Pt[], x: number): number {
  for (let i = 1; i < track.length; i++) {
    const [a, b] = [track[i - 1], track[i]];
    if ((x - a[0]) * (x - b[0]) <= 0 && a[0] !== b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return Math.abs(x - track[0][0]) < Math.abs(x - track[track.length - 1][0]) ? track[0][1] : track[track.length - 1][1];
}

/** A straight track along x at `z`: its slab, and the two rails on it. */
function lay(b: MeshBuilder, x0: number, x1: number, z: number, yR: number): void {
  b.box({ x: x0, y: yR - VL.bed, z: z - 1.2 }, { x: x1, y: yR - VL.rail, z: z + 1.2 }, C.slab, ['ny', 'px', 'nx'], 6);
  for (const r of [z - 0.7175, z + 0.7175]) b.box({ x: x0, y: yR - VL.rail, z: r - 0.035 }, { x: x1, y: yR, z: r + 0.035 }, (_p, n) => (n.y > 0.5 ? C.railTop : C.steel), ['ny', 'px', 'nx'], 6);
}

/** A track between two points on its line (rail tops at their y): slab and rails, turned to the stretch. */
function layAlong(b: MeshBuilder, a: Vector3, c: Vector3): void {
  const d = v(c.x - a.x, 0, c.z - a.z);
  const len = d.length();
  if (len < 0.01) return;
  d.divideScalar(len);
  const n = v(-d.z, 0, d.x);
  const strip = (u0: number, u1: number, y0: number, y1: number, paint: Paint) => {
    const p = (pt: Vector3, u: number, yy: number) => v(pt.x + n.x * u, pt.y + yy, pt.z + n.z * u);
    face(b, p(a, u0, y1), p(c, u0, y1), p(c, u1, y1), p(a, u1, y1), UP, paint, 6);
    if (y0 < y1) {
      face(b, p(a, u0, y0), p(c, u0, y0), p(c, u0, y1), p(a, u0, y1), n.clone().negate(), paint, 6);
      face(b, p(a, u1, y0), p(c, u1, y0), p(c, u1, y1), p(a, u1, y1), n, paint, 6);
    }
  };
  strip(-1.2, 1.2, -VL.bed, -VL.rail, C.slab);
  for (const r of [-0.7175, 0.7175]) strip(r - 0.035, r + 0.035, -VL.rail, 0, C.railTop);
}

/** A square bar `w` thick from `a` to `c`, which climbs along x (a handrail): its top and its two sides. */
function slopedBar(b: MeshBuilder, a: Vector3, c: Vector3, w: number, paint: Paint): void {
  const h = w / 2;
  face(b, v(a.x, a.y + h, a.z - h), v(c.x, c.y + h, c.z - h), v(c.x, c.y + h, c.z + h), v(a.x, a.y + h, a.z + h), UP, paint, 6);
  face(b, v(a.x, a.y - h, a.z - h), v(c.x, c.y - h, c.z - h), v(c.x, c.y + h, c.z - h), v(a.x, a.y + h, a.z - h), v(0, 0, -1), paint, 6);
  face(b, v(a.x, a.y - h, a.z + h), v(c.x, c.y - h, c.z + h), v(c.x, c.y + h, c.z + h), v(a.x, a.y + h, a.z + h), v(0, 0, 1), paint, 6);
}

/** An eight-sided column, its foot at `p` (y the floor's own), `height` meters up from `floor`. */
function column(b: MeshBuilder, p: Vector3, r: number, floor: number, top: number, paint: Paint): void {
  for (let j = 0; j < 8; j++) {
    const a0 = (j / 8) * Math.PI * 2, a1 = ((j + 1) / 8) * Math.PI * 2;
    const q = (a: number, yy: number) => v(p.x + Math.cos(a) * r, p.y - floor + yy, p.z + Math.sin(a) * r);
    face(b, q(a0, floor), q(a1, floor), q(a1, top), q(a0, top), v(Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)), paint, 3);
  }
}

/** A box turned to a frame: its middle, half sizes along the line, up and to the left. */
function orientedBox(b: MeshBuilder, c: Vector3, half: Vector3, along: Vector3, left: Vector3, paint: Paint): void {
  const corner = (i: number, j: number, k: number) => c.clone().addScaledVector(along, i * half.x).add(v(0, j * half.y, 0)).addScaledVector(left, k * half.z);
  const faces: Array<[Vector3, Vector3, Vector3, Vector3, Vector3]> = [
    [corner(1, -1, -1), corner(1, -1, 1), corner(1, 1, 1), corner(1, 1, -1), along],
    [corner(-1, -1, 1), corner(-1, -1, -1), corner(-1, 1, -1), corner(-1, 1, 1), along.clone().negate()],
    [corner(-1, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(-1, 1, 1), UP],
    [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1), left],
    [corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1), left.clone().negate()],
  ];
  for (const [a, b1, c1, d, n] of faces) face(b, a, b1, c1, d, n, paint, 3);
}

/** A pilot tunnel's arch, across from its middle: its corners up the sides, then round to its crown. */
const PILOT: Cross[] = [[4, 4.5], [2.5, 6.6], [0, 7], [-2.5, 6.6], [-4, 4.5]];
/** The pilot's roof `w` meters across from its middle. */
function pilotTop(w: number): number {
  const pts = [...PILOT].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    if (w >= a[0] && w <= b[0]) return a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0]);
  }
  return 4.5;
}

/** An opening in an end wall: from `u0` to `u1` across, its top at each point across. */
type Hole = [u0: number, u1: number, top: (u: number) => number];

/**
 * The wall across a hall at a frame, from wall to wall and up into the vault, facing along the line (`facing` 1) or
 * back (-1), with openings where tunnels go through, shaped as their roofs; `offset` moves it across (a pilot's own).
 */
function endWall(b: MeshBuilder, f: Frame, half: number, wall: number, crown: number, floor: number, holes: Hole[], facing: 1 | -1, paint: Paint, offset = 0): void {
  const n = v(f.tx * facing, 0, f.tz * facing);
  const top = (u: number) => {
    const t = Math.min(1, Math.abs(u) / half);
    return wall + (crown - wall) * Math.sqrt(Math.max(0, 1 - t * t));
  };
  // Across in steps of half a meter: the wall from the floor, or from an opening's roof, up to the vault.
  for (let u = -half; u < half - 0.01; u += 0.5) {
    const ue = Math.min(half, u + 0.5), um = (u + ue) / 2;
    const hole = holes.find(([a, z]) => um > a - offset && um < z - offset);
    const from = (w: number) => (hole ? hole[2](w + offset) : floor);
    face(b, place(f, [u + offset, from(u)]), place(f, [ue + offset, from(ue)]), place(f, [ue + offset, top(ue)]), place(f, [u + offset, top(u)]), n, paint, 3);
  }
}
