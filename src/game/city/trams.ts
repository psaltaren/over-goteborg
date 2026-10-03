// Every tram in the city, from the timetable (`tripTable.ts`) each frame, in a handful of draw calls however many run:
// one instanced mesh per part of the M34 (`tramModel.ts`) holds that part of every tram, so thirty trams cost what one
// does. Each section hangs between two points on its run's track (`path.ts`); a section past either end of its run, out
// of sight, is not drawn. The signs come from one atlas of the line-and-destination signs in use. Trams near the player
// are solid: a box per section, moved by hand (never on a kinematic body, as `Train` explains). A tram about to run into
// someone gives `inTheWay` to `boot.ts`, which rings and moves them (`aside.ts`).

import type RAPIER from '@dimforge/rapier3d';
import {
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { FONT, fitText, MONO } from '../gfx/signs';
import { TRAM_DOORS, TRAM_FLOOR, TRAM_SECTION_ENDS, TRAM_WIDTH } from '../layout';
import type { Physics } from '../physics';
import { inFootprint, type Footprint } from './aside';
import { STREET_Y, type Pt } from './geo';
import { onTrack, TramPath, type SectionPose } from './path';
import type { Run } from './schedule';
import type { Link } from './trackData';
import type { TramState, TripTable } from './tripTable';
import { doorsOf, sectionHalf, TRAM_HEIGHTS, tramModel } from './tramModel';

/** The most trams drawn at once (the area holds 30 at the weekday rush). */
const CAPACITY = 48;
/** Trams this far from the player are drawn (the fog's far edge, and some); this close they are solid. */
const SHOW_REACH = 460;
const SOLID_REACH = 70;
/** The signs' atlas: rows of this many pixels, as many as this. */
const SIGN_W = 512, SIGN_H = 96, SIGN_ROWS = 24;
/** Västtrafik's line colours (Wikidata, CC0; line 1 white with black figures, as the Swedish Wikipedia says). */
const LINE_COLOURS: Record<string, string> = {
  '1': '#ffffff', '2': '#fddd04', '3': '#1f4fd6', '4': '#00a33a', '5': '#e2001a', '6': '#ff8800', '7': '#a86a1e',
  '8': '#bbbb00', '9': '#8888ff', '10': '#88ff88', '11': '#000000', '12': '#55c2b5', '13': '#ffbb88',
};
/** A door leaf's travel: how far it slides aside, and how far out it swings first (a plug door). */
const SLIDE = TRAM_DOORS.width / 2 - 0.04;
const PLUG = 0.07;
/** Head and tail lamps. */
const HEAD = new Color(1, 0.97, 0.9);
const TAIL = new Color(0.95, 0.08, 0.06);
/** Windows: dark slate by day, warm from the lights inside at night. */
const GLASS_DAY = new Color(0.17, 0.23, 0.27);
const GLASS_NIGHT = new Color(0.9, 0.78, 0.56);

/** The line-and-destination signs in use, each a row of one canvas: the line's number on its colour, the destination in amber. */
class SignAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rows = new Map<string, number>();
  /** When each row was last asked for (a frame number), so the oldest goes when the atlas is full. */
  private readonly used: number[] = new Array(SIGN_ROWS).fill(-1);
  private frame = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIGN_W;
    this.canvas.height = SIGN_H * SIGN_ROWS;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
  }

  next(): void {
    this.frame++;
  }

  /** The row of a sign, drawn the first time it is wanted. */
  row(line: string, headsign: string): number {
    const key = `${line}|${headsign}`;
    let r = this.rows.get(key);
    if (r === undefined) {
      r = this.used.indexOf(-1);
      if (r < 0) {
        // Full: the row longest unused goes.
        r = this.used.indexOf(Math.min(...this.used));
        for (const [k, v] of this.rows) if (v === r) this.rows.delete(k);
      }
      this.rows.set(key, r);
      this.draw(r, line, headsign);
    }
    this.used[r] = this.frame;
    return r;
  }

  private draw(r: number, line: string, headsign: string): void {
    const ctx = this.ctx, y = r * SIGN_H;
    ctx.fillStyle = '#060708';
    ctx.fillRect(0, y, SIGN_W, SIGN_H);
    let x = 14;
    if (line) {
      // The line's number on its colour, dark or light figures as the colour wants.
      const colour = LINE_COLOURS[line] ?? '#3a3f45';
      const c = new Color(colour);
      const light = c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.55;
      ctx.fillStyle = colour;
      ctx.fillRect(x, y + 12, 96, SIGN_H - 24);
      ctx.fillStyle = light ? '#111' : '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fitText(ctx, line, 84, 800, 62, FONT);
      ctx.fillText(line, x + 48, y + SIGN_H / 2 + 3);
      x += 112;
    }
    ctx.fillStyle = '#ffb02e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, headsign, SIGN_W - x - 14, 700, 54, MONO);
    ctx.fillText(headsign, (x + SIGN_W - 14) / 2, y + SIGN_H / 2 + 3);
    this.texture.needsUpdate = true;
  }
}

/** One part of every tram: an instanced mesh, filled afresh each frame. */
function part(geometry: BufferGeometry, material: Material, count: number): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  // The instances spread over the city: culled as a whole they would vanish with the first one out of view.
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Glass that reads as glass: dark and see-through-ish by day, turning pale toward a glancing angle as a window does;
 * lit warm from inside at night (its colour, set each frame). As `train.ts` has it, through each tram's instance.
 */
function glassMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ color: 0x2b3a46 });
  const day = { value: 1 };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uDay = day;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vGlance;')
      .replace('#include <project_vertex>', `#include <project_vertex>
#ifdef USE_INSTANCING
mat4 glassModel = modelMatrix * instanceMatrix;
#else
mat4 glassModel = modelMatrix;
#endif
vec3 glassWorld = (glassModel * vec4(transformed, 1.0)).xyz;
vec3 glassNormal = normalize(mat3(glassModel) * normal);
vGlance = 1.0 - abs(dot(glassNormal, normalize(cameraPosition - glassWorld)));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlance;\nuniform float uDay;')
      .replace('#include <opaque_fragment>', `outgoingLight = mix(outgoingLight, vec3(0.72, 0.79, 0.85) * uDay, vGlance * vGlance * vGlance * 0.65 * uDay);
#include <opaque_fragment>`);
  };
  m.userData.day = day;
  return m;
}

/** A sign's material: its row of the atlas from the instance (`signRow`). */
function signMaterial(atlas: SignAtlas): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ map: atlas.texture });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float signRow;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
vMapUv.y = 1.0 - (signRow + 1.0 - vMapUv.y) * ${(1 / SIGN_ROWS).toFixed(8)};`);
  };
  return m;
}

/** A tram drawn this frame: its state, its sections (those on its track), and how near the player it is. */
export interface DrawnTram {
  state: TramState;
  sections: Footprint[];
  distance: number;
}

export class Trams {
  readonly group = new Group();
  /** The trams in the area this frame, and those drawn, near the player first. */
  states: TramState[] = [];
  readonly drawn: DrawnTram[] = [];
  private readonly paths: TramPath[];
  private readonly atlas = new SignAtlas();
  private readonly body = new MeshBasicMaterial({ vertexColors: true });
  private readonly glass = glassMaterial();
  private readonly lampMaterial = new MeshBasicMaterial();
  private readonly ends: InstancedMesh;
  private readonly endGlass: InstancedMesh;
  private readonly middles: InstancedMesh;
  private readonly middleGlass: InstancedMesh;
  private readonly bellows: InstancedMesh;
  private readonly pantographs: InstancedMesh;
  private readonly lamps: InstancedMesh;
  private readonly leaves: InstancedMesh;
  private readonly signs: InstancedMesh;
  private readonly signRows: InstancedBufferAttribute;
  private readonly signLocal: Matrix4[];
  private readonly colliders: RAPIER.Collider[] = [];
  /** The tracks' segments, by 25 m square, for finding those near a point. */
  private readonly grid = new Map<string, Array<[Pt, Pt]>>();
  private readonly poses: SectionPose[] = [];
  private readonly m = new Matrix4();
  private readonly s = new Matrix4();
  private readonly q = new Quaternion();
  private readonly at = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);

  constructor(private readonly physics: Physics, private readonly table: TripTable, runs: Run[], links: Link[]) {
    this.group.name = 'trams';
    this.paths = runs.map((r) => new TramPath(r, links));
    const model = tramModel();
    this.ends = part(model.end, this.body, CAPACITY * 2);
    this.endGlass = part(model.endGlass, this.glass, CAPACITY * 2);
    this.middles = part(model.middle, this.body, CAPACITY * 2);
    this.middleGlass = part(model.middleGlass, this.glass, CAPACITY * 2);
    this.bellows = part(model.bellows, this.body, CAPACITY * 3);
    this.pantographs = part(model.pantograph, this.body, CAPACITY);
    this.lamps = part(model.lamps, this.lampMaterial, CAPACITY * 2);
    this.lamps.instanceColor = new InstancedBufferAttribute(new Float32Array(CAPACITY * 2 * 3), 3).setUsage(DynamicDrawUsage);
    this.leaves = part(model.leaf, this.body, CAPACITY * 32);
    const quad = new PlaneGeometry(1, 1);
    this.signRows = new InstancedBufferAttribute(new Float32Array(CAPACITY * 6), 1).setUsage(DynamicDrawUsage);
    quad.setAttribute('signRow', this.signRows);
    this.signs = part(quad, signMaterial(this.atlas), CAPACITY * 6);
    this.signLocal = model.signs;
    this.group.add(this.ends, this.endGlass, this.middles, this.middleGlass, this.bellows, this.pantographs, this.lamps, this.leaves, this.signs);
    for (const l of links) {
      for (let i = 0; i + 1 < l.pts.length; i++) {
        const seg: [Pt, Pt] = [l.pts[i], l.pts[i + 1]];
        for (const key of this.cells(seg[0], seg[1])) {
          if (!this.grid.has(key)) this.grid.set(key, []);
          this.grid.get(key)!.push(seg);
        }
      }
    }
  }

  private cells([ax, az]: Pt, [bx, bz]: Pt): string[] {
    const out: string[] = [];
    for (let i = Math.floor(Math.min(ax, bx) / 25); i <= Math.floor(Math.max(ax, bx) / 25); i++) {
      for (let j = Math.floor(Math.min(az, bz) / 25); j <= Math.floor(Math.max(az, bz) / 25); j++) out.push(`${i},${j}`);
    }
    return out;
  }

  /** The tracks' segments within about `reach` of (`x`, `z`). */
  tracksNear(x: number, z: number, reach = 25): Array<[Pt, Pt]> {
    const out = new Set<[Pt, Pt]>();
    for (const key of this.cells([x - reach, z - reach], [x + reach, z + reach])) for (const seg of this.grid.get(key) ?? []) out.add(seg);
    return [...out];
  }

  /**
   * The trams at `time` (epoch seconds), drawn round the player at (`px`, `pz`): each section, its glass, doors, bellows,
   * lamps and signs; the near ones solid. `daylight` (0 to 1) dims the bodies and lights the windows.
   */
  update(time: number, px: number, pz: number, daylight: number): void {
    this.states = this.table.at(time, this.states);
    this.atlas.next();
    const counts = { ends: 0, middles: 0, bellows: 0, pantographs: 0, leaves: 0, signs: 0 };
    let solid = 0;
    this.drawn.length = 0;
    for (const st of this.states) {
      const path = this.paths[st.run];
      const length = path.length;
      const poses = path.sections(st.s, TRAM_SECTION_ENDS, this.poses);
      let near = Infinity;
      for (let k = 0; k < poses.length; k++) if (onTrack(st.s, k, length)) near = Math.min(near, Math.hypot(poses[k].x - px, poses[k].z - pz));
      if (near > SHOW_REACH || this.drawn.length >= CAPACITY) continue;
      const sections: Footprint[] = [];
      const row = this.atlas.row(st.line, st.headsign);
      for (let k = 0; k < poses.length; k++) {
        if (!onTrack(st.s, k, length)) continue;
        const p = poses[k];
        const rear = k === poses.length - 1;
        const end = k === 0 || rear;
        // The section's frame: at its middle on the street, turned the way it faces; the rear cab turned round.
        const yaw = Math.atan2(-p.dz, p.dx) + (rear ? Math.PI : 0);
        this.q.setFromAxisAngle(this.up, yaw);
        this.m.compose(this.at.set(p.x, STREET_Y, p.z), this.q, this.one);
        const i = end ? counts.ends++ : counts.middles++;
        (end ? this.ends : this.middles).setMatrixAt(i, this.m);
        (end ? this.endGlass : this.middleGlass).setMatrixAt(i, this.m);
        if (end) {
          this.lamps.setMatrixAt(i, this.m);
          this.lamps.setColorAt(i, rear ? TAIL : HEAD);
          for (const local of this.signLocal) {
            this.signs.setMatrixAt(counts.signs, this.s.multiplyMatrices(this.m, local));
            this.signRows.setX(counts.signs++, row);
          }
        }
        if (k === 1) this.pantographs.setMatrixAt(counts.pantographs++, this.m);
        // The doors: open on the platform's side (the tram's right or left, the rear section's turned round with it).
        const platform = rear ? -st.side : st.side;
        for (const d of doorsOf(end ? 'end' : 'middle')) {
          for (const side of [1, -1] as const) {
            const open = side === platform ? st.doors : 0;
            for (const leaf of [-1, 1]) {
              const x = d + leaf * (TRAM_DOORS.width / 4 + open * SLIDE);
              const z = side * (TRAM_WIDTH / 2 + 0.03 + open * PLUG);
              this.s.makeRotationY(side > 0 ? 0 : Math.PI).setPosition(x, TRAM_FLOOR + TRAM_DOORS.height / 2, z);
              this.leaves.setMatrixAt(counts.leaves++, this.s.premultiply(this.m));
            }
          }
        }
        sections.push({ x: p.x, z: p.z, dx: p.dx, dz: p.dz, hl: sectionHalf(k), hw: TRAM_WIDTH / 2 });
      }
      // The bellows between two sections both drawn, facing halfway between them.
      for (let k = 0; k + 1 < poses.length; k++) {
        if (!onTrack(st.s, k, length) || !onTrack(st.s, k + 1, length)) continue;
        const [jx, jz] = path.point(st.s - TRAM_SECTION_ENDS[k + 1]);
        const dx = poses[k].dx + poses[k + 1].dx, dz = poses[k].dz + poses[k + 1].dz;
        this.q.setFromAxisAngle(this.up, Math.atan2(-dz, dx));
        this.bellows.setMatrixAt(counts.bellows++, this.m.compose(this.at.set(jx, STREET_Y, jz), this.q, this.one));
      }
      if (near < SOLID_REACH) solid = this.solid(sections, solid);
      this.drawn.push({ state: st, sections, distance: near });
    }
    this.drawn.sort((a, b) => a.distance - b.distance);
    for (let k = solid; k < this.colliders.length; k++) this.colliders[k].setEnabled(false);
    this.ends.count = this.endGlass.count = this.lamps.count = counts.ends;
    this.middles.count = this.middleGlass.count = counts.middles;
    this.bellows.count = counts.bellows;
    this.pantographs.count = counts.pantographs;
    this.leaves.count = counts.leaves;
    this.signs.count = counts.signs;
    for (const mesh of [this.ends, this.endGlass, this.middles, this.middleGlass, this.bellows, this.pantographs, this.lamps, this.leaves, this.signs]) mesh.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
    this.signRows.needsUpdate = true;
    this.light(daylight);
  }

  /** Boxes for a near tram's sections, from the pool: `used` taken so far, and the count after. */
  private solid(sections: Footprint[], used: number): number {
    const R = this.physics.R;
    const half = (TRAM_HEIGHTS.eave - TRAM_HEIGHTS.foot) / 2;
    for (const f of sections) {
      let c = this.colliders[used];
      if (!c) {
        c = this.physics.world.createCollider(R.ColliderDesc.cuboid(1, half, TRAM_WIDTH / 2));
        this.colliders.push(c);
      }
      c.setHalfExtents({ x: f.hl, y: half, z: f.hw });
      const yaw = Math.atan2(-f.dz, f.dx);
      c.setTranslation({ x: f.x, y: STREET_Y + TRAM_HEIGHTS.foot + half, z: f.z });
      c.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
      c.setEnabled(true);
      used++;
    }
    return used;
  }

  /** Bodies as bright as the daylight (and a little at night, the street lamps on them); windows lit from inside after dusk. */
  private light(daylight: number): void {
    this.body.color.setScalar(Math.max(0.2, daylight));
    const night = Math.min(1, Math.max(0, (0.5 - daylight) / 0.35));
    this.glass.color.copy(GLASS_DAY).multiplyScalar(Math.max(0.25, daylight)).lerp(GLASS_NIGHT, night);
    (this.glass.userData.day as { value: number }).value = daylight;
  }

  /**
   * The section of a tram about to run into someone at (`x`, `z`): in its way, its front a second's travel and a meter
   * ahead of it while it moves. Null when no tram is.
   */
  inTheWay(x: number, z: number): { tram: DrawnTram; section: Footprint } | null {
    for (const tram of this.drawn) {
      if (tram.distance > 60) break;
      const moving = Math.abs(tram.state.speed) > 0.05;
      for (let k = 0; k < tram.sections.length; k++) {
        const f = tram.sections[k];
        const ahead = moving && k === 0 && onTrack(tram.state.s, 0, this.paths[tram.state.run].length) ? 1 + Math.abs(tram.state.speed) : 0;
        if (inFootprint(f, x, z, 0.25, ahead)) return { tram, section: f };
      }
    }
    return null;
  }

  /** Every near tram's sections, moving fronts reaching two seconds ahead: where no one may be put. */
  obstacles(): Footprint[] {
    const out: Footprint[] = [];
    for (const tram of this.drawn) {
      if (tram.distance > 80) break;
      tram.sections.forEach((f, k) => {
        const reach = k === 0 ? 2 * Math.abs(tram.state.speed) : 0;
        out.push(reach ? { ...f, x: f.x + (f.dx * reach) / 2, z: f.z + (f.dz * reach) / 2, hl: f.hl + reach / 2 } : f);
      });
    }
    return out;
  }

  /** The nearest tram drawn: which, how far and how fast, for its sound; null when none is. */
  nearest(): { id: string; distance: number; speed: number } | null {
    const t = this.drawn[0];
    return t ? { id: t.state.id, distance: t.distance, speed: Math.abs(t.state.speed) } : null;
  }

  /** Lets go of the GPU buffers, textures and colliders. */
  dispose(): void {
    for (const c of this.colliders) this.physics.world.removeCollider(c, false);
    this.colliders.length = 0;
    this.atlas.texture.dispose();
    for (const mesh of [this.ends, this.endGlass, this.middles, this.middleGlass, this.bellows, this.pantographs, this.lamps, this.leaves, this.signs]) mesh.dispose();
  }
}

