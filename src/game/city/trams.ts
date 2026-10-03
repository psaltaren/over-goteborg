// Every tram in the city, from the timetable (`tripTable.ts`) each frame, in a handful of draw calls however many run:
// one instanced mesh per part of the M34 (`tramModel.ts`) holds that part of every tram, so thirty trams cost what one
// does. Each section hangs between two points on its run's track (`path.ts`). A tram is drawn once all of it is on
// its run, and fades in and out (a dither, per tram) over its first and last stretch, out where the runs begin and end,
// so none appears or vanishes all at once in the fog. The signs come from one atlas of the signs in use, a row each,
// only the row drawn uploaded. Trams near the player are solid: a box per section, moved by hand (never on a kinematic
// body, as `Train` explains). A tram about to run into someone gives `inTheWay` to `boot.ts`, which rings and moves them
// (`aside.ts`).

import type RAPIER from '@dimforge/rapier3d';
import {
  CanvasTexture,
  Color,
  DataTexture,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Mesh,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { FONT, fitText, MONO } from '../gfx/signs';
import { TRAM_BODY, TRAM_DOORS, TRAM_FLOOR, TRAM_JOINT, TRAM_LENGTH, TRAM_SECTION_ENDS, TRAM_WIDTH } from '../layout';
import type { Physics } from '../physics';
import { inFootprint, type Footprint } from './aside';
import { STREET_Y, type Pt } from './geo';
import { TramPath, type SectionPose } from './path';
import type { Run } from './schedule';
import type { Link } from './trackData';
import { TrackIndex } from './trackIndex';
import type { TramState, TripTable } from './tripTable';
import { doorsOf, sectionBoxes, sectionHalf, SKIRT, tramModel, type SectionBox } from './tramModel';

/** The most trams drawn at once (the area holds 30 at the weekday rush). */
const CAPACITY = 48;
/** Trams this far from the player are drawn (the fog's far edge, and some); this close they are solid. */
const SHOW_REACH = 460;
const SOLID_REACH = 70;
/** Trams this near have their inside drawn, and this near can be boarded: doorways, a floor, walls. */
const INSIDE_REACH = 40;
const BOARD_REACH = 25;
/**
 * How many trams at once may be near enough to board (the rest nearby are solid boxes), and have their inside drawn: those
 * near, and those standing with their doors open within `OPEN_REACH`, so no open doorway shows through the car.
 */
const BOARDABLE = 3;
const INSIDES = 8;
const OPEN_REACH = 120;
/** How far past a section's end someone still counts as in it: the outer half of a bellows on a tight curve. */
const JOINT_SLACK = 0.6;
/** The sections' boxes, front to rear: the end sections' and the middle ones'. */
const BOXES: SectionBox[][] = [sectionBoxes('end'), sectionBoxes('middle'), sectionBoxes('middle'), sectionBoxes('end')];
/** How far a tram runs on its track while it fades in, or out, where its run begins or ends. */
const FADE = 60;
/** The signs' atlas: rows of this many pixels, as many as this; row 0 stays black, for a sign that finds no room. */
const SIGN_W = 512, SIGN_H = 96, SIGN_ROWS = 24;
/** Västtrafik's line colours (Wikidata, CC0; line 1 white with black figures, as the Swedish Wikipedia says). */
const LINE_COLOURS: Record<string, string> = {
  '1': '#ffffff', '2': '#fddd04', '3': '#1f4fd6', '4': '#00a33a', '5': '#e2001a', '6': '#ff8800', '7': '#a86a1e',
  '8': '#bbbb00', '9': '#8888ff', '10': '#88ff88', '11': '#000000', '12': '#55c2b5', '13': '#ffbb88',
};
/** Half an articulation's gap: a section's floor reaches this far past its end, to meet the next's. */
const TRAM_JOINT_HALF = TRAM_JOINT / 2;
/** A door leaf's travel: how far it slides aside once it has swung out. */
const SLIDE = TRAM_DOORS.width / 2 - 0.04;
/** The doors of an end and a middle section, in its own frame. */
const END_DOORS = doorsOf('end');
const MIDDLE_DOORS = doorsOf('middle');
/** Head and tail lamps. */
const HEAD = new Color(1, 0.97, 0.9);
const TAIL = new Color(0.95, 0.08, 0.06);
/** Windows: dark slate by day, warm from the lights inside at night. */
const GLASS_DAY = new Color(0.17, 0.23, 0.27);
const GLASS_NIGHT = new Color(0.9, 0.78, 0.56);

/**
 * The line-and-destination signs in use, each a row of one texture: the line's number on its colour, the destination
 * in amber. A sign is drawn on a small canvas and copied into its row, and only those rows go to the GPU.
 */
class SignAtlas {
  readonly texture: DataTexture;
  private readonly data: Uint8Array;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rows = new Map<string, number>();
  /** When each row was last asked for (a frame number), so the longest unused goes when the atlas is full. */
  private readonly used: number[] = new Array(SIGN_ROWS).fill(-1);
  private frame = 0;

  constructor() {
    this.data = new Uint8Array(SIGN_W * SIGN_H * SIGN_ROWS * 4);
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255;
    this.texture = new DataTexture(this.data, SIGN_W, SIGN_H * SIGN_ROWS);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.anisotropy = 4;
    this.texture.needsUpdate = true;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIGN_W;
    this.canvas.height = SIGN_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.used[0] = Infinity;
  }

  next(): void {
    this.frame++;
  }

  /** The row of a sign, drawn the first time it is wanted; row 0 (blank) when every row is in use this frame. */
  row(line: string, headsign: string): number {
    const key = `${line}|${headsign}`;
    let r = this.rows.get(key);
    if (r === undefined) {
      // The row longest unused, if it was not used this frame.
      let oldest = 1;
      for (let k = 2; k < SIGN_ROWS; k++) if (this.used[k] < this.used[oldest]) oldest = k;
      if (this.used[oldest] >= this.frame) return 0;
      for (const [k, v] of this.rows) if (v === oldest) this.rows.delete(k);
      r = oldest;
      this.rows.set(key, r);
      this.draw(r, line, headsign);
    }
    this.used[r] = this.frame;
    return r;
  }

  private draw(r: number, line: string, headsign: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#060708';
    ctx.fillRect(0, 0, SIGN_W, SIGN_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let x = 14;
    if (line) {
      // The line's number on its colour, dark or light figures as the colour wants.
      const colour = LINE_COLOURS[line] ?? '#3a3f45';
      const c = new Color(colour);
      ctx.fillStyle = colour;
      ctx.fillRect(x, 12, 96, SIGN_H - 24);
      ctx.fillStyle = c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.55 ? '#111' : '#fff';
      fitText(ctx, line, 84, 800, 62, FONT);
      ctx.fillText(line, x + 48, SIGN_H / 2 + 3);
      x += 112;
    }
    ctx.fillStyle = '#ffb02e';
    fitText(ctx, headsign, SIGN_W - x - 14, 700, 54, MONO);
    ctx.fillText(headsign, (x + SIGN_W - 14) / 2, SIGN_H / 2 + 3);
    // Into the row, upside down (the texture's rows run up from the bottom), a range per line of pixels.
    const pixels = ctx.getImageData(0, 0, SIGN_W, SIGN_H).data;
    const line4 = SIGN_W * 4;
    for (let py = 0; py < SIGN_H; py++) {
      const at = (r * SIGN_H + (SIGN_H - 1 - py)) * line4;
      this.data.set(pixels.subarray(py * line4, (py + 1) * line4), at);
      this.texture.addUpdateRange(at, line4);
    }
    this.texture.needsUpdate = true;
  }
}

/** The hash-dither that fades a tram: fragments drop out as its `fade` falls, a pattern on the screen. */
function fading<T extends MeshBasicMaterial>(material: T, key: string, more?: (shader: WebGLProgramParametersWithUniforms) => void): T {
  material.onBeforeCompile = (shader) => {
    more?.(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float fade;\nvarying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = fade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('void main() {', 'void main() {\n  if (vFade < 0.999 && fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) > vFade) discard;');
  };
  // Each its own program: the patches differ, and three.js would otherwise share one by the base material.
  material.customProgramCacheKey = () => `tram-${key}`;
  return material;
}

/**
 * Glass that reads as glass: dark by day, turning pale toward a glancing angle as a window does; lit warm from inside
 * at night (its colour, set each frame). As `train.ts` has it, through each tram's instance.
 */
function glassMaterial(): MeshBasicMaterial {
  const day = { value: 1 };
  const m = fading(new MeshBasicMaterial({ color: GLASS_DAY }), 'glass', (shader) => {
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
  });
  m.userData.day = day;
  return m;
}

/** A sign's material: its row of the atlas from the instance (`signRow`). */
function signMaterial(atlas: SignAtlas): MeshBasicMaterial {
  return fading(new MeshBasicMaterial({ map: atlas.texture }), 'sign', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float signRow;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
vMapUv.y = (signRow + vMapUv.y) * ${(1 / SIGN_ROWS).toFixed(8)};`);
  });
}

/** One part of every tram: an instanced mesh, filled afresh each frame, with a fade per instance. */
function part(geometry: BufferGeometry, material: Material, count: number): InstancedMesh {
  geometry.setAttribute('fade', new InstancedBufferAttribute(new Float32Array(count), 1).setUsage(DynamicDrawUsage));
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  // The instances spread over the city: culled as a whole they would vanish with the first one out of view.
  mesh.frustumCulled = false;
  return mesh;
}

/** A tram drawn this frame: its state, its sections, and how near the player it is. Kept from frame to frame. */
export interface DrawnTram {
  state: TramState;
  sections: Footprint[];
  distance: number;
}

/**
 * Where someone stands in a tram: which tram and section, and where in the section's own frame (`x` along it toward
 * its cab, `z` across), and the way that frame faced. `trams.carry` moves them with it.
 */
export interface Aboard {
  id: number;
  k: number;
  x: number;
  z: number;
  yaw: number;
}

/** A section's own frame: its middle, and the way its cab faces (the rear section's turned round). */
function frameOf(f: Footprint, k: number, last: number): { x: number; z: number; dx: number; dz: number } {
  const turn = k === last ? -1 : 1;
  return { x: f.x, z: f.z, dx: f.dx * turn, dz: f.dz * turn };
}

export class Trams {
  readonly group = new Group();
  /** The trams in the area this frame, and those drawn, nearest the player first. */
  states: TramState[] = [];
  readonly drawn: DrawnTram[] = [];
  private readonly pool: DrawnTram[] = [];
  private readonly paths: TramPath[];
  private readonly lengths: number[];
  private readonly tracks: TrackIndex;
  private readonly atlas = new SignAtlas();
  private readonly body = fading(new MeshBasicMaterial({ vertexColors: true }), 'body');
  private readonly glass = glassMaterial();
  private readonly lampMaterial = fading(new MeshBasicMaterial(), 'lamp');
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
  private readonly endInside: InstancedMesh;
  private readonly middleInside: InstancedMesh;
  private readonly inside = fading(new MeshBasicMaterial({ vertexColors: true }), 'inside');
  /** The boxes of the trams near enough to board, a set per tram, each box made once its size; which tram each set was last put round, and how. */
  private readonly boardSlots: RAPIER.Collider[][] = [];
  private readonly slotTram: Array<{ id: number; s: number; open: boolean } | null> = [];
  private readonly colliderAt = { x: 0, y: 0, z: 0 };
  private readonly colliderTurn = { x: 0, y: 0, z: 0, w: 1 };
  /** The display over the aisle of the tram ridden, and what it says. */
  readonly display: Mesh;
  private readonly displayCanvas: HTMLCanvasElement;
  private displayText = '';
  private readonly displayLocal: Matrix4;
  private readonly poses: SectionPose[] = [];
  private readonly joint: Pt = [0, 0];
  private readonly m = new Matrix4();
  private readonly s = new Matrix4();
  private readonly q = new Quaternion();
  private readonly at = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);

  constructor(private readonly physics: Physics, private readonly table: TripTable, runs: Run[], links: Link[]) {
    this.group.name = 'trams';
    this.paths = runs.map((r) => new TramPath(r, links));
    this.lengths = runs.map((r) => r.length);
    this.tracks = new TrackIndex(links);
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
    this.endInside = part(model.endInside, this.inside, INSIDES * 2);
    this.middleInside = part(model.middleInside, this.inside, INSIDES * 2);
    this.displayCanvas = document.createElement('canvas');
    this.displayCanvas.width = 512;
    this.displayCanvas.height = 96;
    const tex = new CanvasTexture(this.displayCanvas);
    tex.colorSpace = SRGBColorSpace;
    this.display = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: tex }));
    this.display.visible = false;
    this.displayLocal = model.display;
    this.group.add(this.ends, this.endGlass, this.middles, this.middleGlass, this.bellows, this.pantographs, this.lamps, this.leaves, this.signs, this.endInside, this.middleInside, this.display);
  }

  /** The tracks' segments within about `reach` of (`x`, `z`). */
  tracksNear(x: number, z: number, reach = 25): Array<[Pt, Pt]> {
    return this.tracks.near(x, z, reach);
  }

  /** How far into its fade a tram is: 0 while any of it is past its run's ends, 1 once it is `FADE` in from both. */
  private fadeOf(st: TramState): number {
    const length = this.lengths[st.run];
    if (st.s < TRAM_LENGTH || st.s > length) return 0;
    return Math.min(1, (st.s - TRAM_LENGTH) / FADE, (length - st.s) / FADE);
  }

  /** Puts instance `i` of `mesh` at matrix `m`, faded by `fade`. */
  private put(mesh: InstancedMesh, i: number, m: Matrix4, fade: number): void {
    mesh.setMatrixAt(i, m);
    (mesh.geometry.getAttribute('fade') as InstancedBufferAttribute).setX(i, fade);
  }

  /**
   * The trams at `time` (epoch seconds), drawn round the player at (`px`, `pz`): each section, its glass, doors, bellows,
   * lamps and signs; the near ones solid. `daylight` (0 to 1) dims the bodies and lights the windows.
   */
  update(time: number, px: number, pz: number, daylight: number, riding: number | null = null): void {
    this.states = this.table.at(time, this.states);
    this.atlas.next();
    // The trams to draw, nearest first: when there are more signs about than the atlas holds, the nearest have theirs.
    this.drawn.length = 0;
    for (const st of this.states) {
      if (this.fadeOf(st) <= 0 || this.drawn.length >= CAPACITY) continue;
      const poses = this.paths[st.run].sections(st.s, TRAM_SECTION_ENDS, this.poses);
      let near = Infinity;
      for (const p of poses) near = Math.min(near, Math.hypot(p.x - px, p.z - pz));
      if (near > SHOW_REACH) continue;
      const tram = (this.pool[this.drawn.length] ??= { state: st, sections: [], distance: 0 });
      tram.state = st;
      // The tram ridden first of all: its boxes, its inside, its sign.
      tram.distance = st.id === riding ? 0 : near;
      for (let k = 0; k < poses.length; k++) {
        const f = (tram.sections[k] ??= { x: 0, z: 0, dx: 1, dz: 0, hl: 0, hw: TRAM_WIDTH / 2 });
        f.x = poses[k].x;
        f.z = poses[k].z;
        f.dx = poses[k].dx;
        f.dz = poses[k].dz;
        f.hl = sectionHalf(k);
      }
      tram.sections.length = poses.length;
      this.drawn.push(tram);
    }
    this.drawn.sort((a, b) => a.distance - b.distance);
    let ends = 0, middles = 0, joints = 0, pantographs = 0, leaves = 0, signs = 0, solid = 0, endsIn = 0, middlesIn = 0, boarding = 0, insides = 0;
    for (const tram of this.drawn) {
      const showInside = (tram.distance < INSIDE_REACH || (tram.state.doors > 0.02 && tram.distance < OPEN_REACH)) && insides++ < INSIDES;
      const st = tram.state;
      const fade = this.fadeOf(st);
      const row = this.atlas.row(st.line, st.headsign);
      const last = tram.sections.length - 1;
      for (let k = 0; k <= last; k++) {
        const p = tram.sections[k];
        const rear = k === last;
        const end = k === 0 || rear;
        // The section's frame: at its middle on the street, turned the way it faces; the rear cab turned round.
        this.q.setFromAxisAngle(this.up, Math.atan2(-p.dz, p.dx) + (rear ? Math.PI : 0));
        this.m.compose(this.at.set(p.x, STREET_Y, p.z), this.q, this.one);
        if (showInside) {
          if (end) this.put(this.endInside, endsIn++, this.m, fade);
          else this.put(this.middleInside, middlesIn++, this.m, fade);
        }
        if (end) {
          this.put(this.ends, ends, this.m, fade);
          this.put(this.endGlass, ends, this.m, fade);
          this.put(this.lamps, ends, this.m, fade);
          this.lamps.setColorAt(ends++, rear ? TAIL : HEAD);
          for (const local of this.signLocal) {
            this.put(this.signs, signs, this.s.multiplyMatrices(this.m, local), fade);
            this.signRows.setX(signs++, row);
          }
        } else {
          this.put(this.middles, middles, this.m, fade);
          this.put(this.middleGlass, middles++, this.m, fade);
        }
        if (k === 1) this.put(this.pantographs, pantographs++, this.m, fade);
        // The doors: open on the platform's side (the tram's right or left, the rear section's turned round with it).
        const platform = rear ? -st.side : st.side;
        const doors = end ? END_DOORS : MIDDLE_DOORS;
        for (let d = 0; d < doors.length; d++) {
          for (let side = -1; side <= 1; side += 2) {
            const open = side === platform ? st.doors : 0;
            for (let leaf = -1; leaf <= 1; leaf += 2) {
              const x = doors[d] + leaf * (TRAM_DOORS.width / 4 + open * SLIDE);
              const z = side * (TRAM_WIDTH / 2 + 0.03 + open * TRAM_DOORS.plug);
              this.s.makeRotationY(side > 0 ? 0 : Math.PI).setPosition(x, TRAM_FLOOR + TRAM_DOORS.height / 2, z);
              this.put(this.leaves, leaves++, this.s.premultiply(this.m), fade);
            }
          }
        }
        // The bellows behind this section, facing halfway between it and the next.
        if (!rear) {
          const n = tram.sections[k + 1];
          this.paths[st.run].point(st.s - TRAM_SECTION_ENDS[k + 1], this.joint);
          this.q.setFromAxisAngle(this.up, Math.atan2(-(p.dz + n.dz), p.dx + n.dx));
          this.put(this.bellows, joints++, this.m.compose(this.at.set(this.joint[0], STREET_Y, this.joint[1]), this.q, this.one), fade);
        }
      }
      if (tram.distance < BOARD_REACH && boarding < BOARDABLE) this.boardable(tram, boarding++);
      else if (tram.distance < SOLID_REACH) solid = this.solid(tram.sections, solid);
    }
    for (let k = boarding; k < this.boardSlots.length; k++) {
      if (this.slotTram[k] === null) continue;
      for (const c of this.boardSlots[k]) c.setEnabled(false);
      this.slotTram[k] = null;
    }
    for (let k = solid; k < this.colliders.length; k++) this.colliders[k].setEnabled(false);
    this.upload(this.ends, ends);
    this.upload(this.endGlass, ends);
    this.upload(this.lamps, ends);
    this.upload(this.middles, middles);
    this.upload(this.middleGlass, middles);
    this.upload(this.bellows, joints);
    this.upload(this.pantographs, pantographs);
    this.upload(this.leaves, leaves);
    this.upload(this.signs, signs);
    this.upload(this.endInside, endsIn);
    this.upload(this.middleInside, middlesIn);
    this.range(this.lamps.instanceColor!, ends, 3);
    this.range(this.signRows, signs, 1);
    this.light(daylight);
  }

  /** Draws `count` instances of `mesh`, and sends only those to the GPU (not the whole of each buffer). */
  private upload(mesh: InstancedMesh, count: number): void {
    mesh.count = count;
    this.range(mesh.instanceMatrix, count, 16);
    this.range(mesh.geometry.getAttribute('fade') as InstancedBufferAttribute, count, 1);
  }

  private range(attr: InstancedBufferAttribute, count: number, size: number): void {
    if (!count) return;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, count * size);
    attr.needsUpdate = true;
  }

  /** Boxes for a near tram's sections, from the pool: `used` taken so far, and the count after. */
  private solid(sections: Footprint[], used: number): number {
    const R = this.physics.R;
    const half = (TRAM_BODY.eave - SKIRT) / 2;
    for (const f of sections) {
      let c = this.colliders[used];
      if (!c) {
        c = this.physics.world.createCollider(R.ColliderDesc.cuboid(f.hl, half, f.hw));
        this.colliders.push(c);
      }
      c.setHalfExtents({ x: f.hl, y: half, z: f.hw });
      const yaw = Math.atan2(-f.dz, f.dx);
      c.setTranslation({ x: f.x, y: STREET_Y + SKIRT + half, z: f.z });
      c.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
      c.setEnabled(true);
      used++;
    }
    return used;
  }

  /**
   * A tram near enough to board: its sections' floors, ceilings, walls and doorways (`sectionBoxes`), a doorway's panel
   * taken away while that side's doors are open. From the slot's set of boxes, made the first time.
   */
  private boardable(tram: DrawnTram, slot: number): void {
    const R = this.physics.R;
    if (!this.boardSlots[slot]) {
      this.boardSlots[slot] = BOXES.flatMap((boxes) => boxes.map((b) => this.physics.world.createCollider(R.ColliderDesc.cuboid((b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2, (b.z1 - b.z0) / 2))));
      this.slotTram[slot] = null;
    }
    const doorsOpen = tram.state.doors > 0.6;
    // A tram standing where it stood last frame, its doors as they were, keeps its boxes where they are.
    const kept = this.slotTram[slot];
    if (kept && kept.id === tram.state.id && kept.s === tram.state.s && kept.open === doorsOpen) return;
    this.slotTram[slot] = { id: tram.state.id, s: tram.state.s, open: doorsOpen };
    const colliders = this.boardSlots[slot];
    const last = tram.sections.length - 1;
    const at = this.colliderAt, rotation = this.colliderTurn;
    let i = 0;
    for (let k = 0; k <= last; k++) {
      const f = frameOf(tram.sections[k], k, last);
      const yaw = Math.atan2(-f.dz, f.dx);
      rotation.y = Math.sin(yaw / 2);
      rotation.w = Math.cos(yaw / 2);
      // The doors open on the platform's side, as the tram sees it; the rear section is turned round.
      const open = doorsOpen ? (k === last ? -tram.state.side : tram.state.side) : 0;
      for (const b of BOXES[k]) {
        const c = colliders[i++];
        const lx = (b.x0 + b.x1) / 2, lz = (b.z0 + b.z1) / 2;
        at.x = f.x + lx * f.dx - lz * f.dz;
        at.y = STREET_Y + (b.y0 + b.y1) / 2;
        at.z = f.z + lx * f.dz + lz * f.dx;
        c.setTranslation(at);
        c.setRotation(rotation);
        c.setEnabled(b.step ? b.step.side === open : !(b.door && b.door.side === open));
      }
    }
  }

  /**
   * Where someone with their feet at `feet` stands in a tram, or null when in none: on its floor (or its step), or, if
   * they were in it the frame before (`was`), anywhere up off it, as in a jump. Of the sections a point at an
   * articulation lies in, the one it lies furthest into.
   */
  aboard(feet: Vector3, was: Aboard | null = null): Aboard | null {
    const floor = STREET_Y + TRAM_FLOOR;
    let best: Aboard | null = null, bestOut = Infinity;
    // Every tram drawn, not only those that were near: the player may have been put in one (a teleport, a respawn).
    for (const tram of this.drawn) {
      const up = feet.y - floor;
      const same = was?.id === tram.state.id;
      if (!(Math.abs(up) <= 0.2 || (same && up > -0.25 && up < 1.4))) continue;
      const last = tram.sections.length - 1;
      for (let k = 0; k <= last; k++) {
        const f = frameOf(tram.sections[k], k, last);
        const ux = feet.x - f.x, uz = feet.z - f.z;
        if (ux * ux + uz * uz > 64) continue;
        const x = ux * f.dx + uz * f.dz, z = -ux * f.dz + uz * f.dx;
        // Inside its walls, and within the section, half each articulation and a little more on a curve's outside.
        const out = Math.abs(x) - (tram.sections[k].hl + TRAM_JOINT_HALF);
        if (out <= JOINT_SLACK && out < bestOut && Math.abs(z) < TRAM_WIDTH / 2 - 0.05) {
          best = { id: tram.state.id, k, x, z, yaw: Math.atan2(-f.dz, f.dx) };
          bestOut = out;
        }
      }
    }
    return best;
  }

  /**
   * Where someone who stood at `on` before this frame's move stands now, the tram having moved on: how far they are
   * carried, and how far turned. Null when that tram is no longer drawn (it has left the area).
   */
  carry(on: Aboard): { dx: number; dz: number; turn: number; heading: number } | null {
    const tram = this.drawn.find((t) => t.state.id === on.id);
    if (!tram || !tram.sections[on.k]) return null;
    const section = tram.sections[on.k];
    const f = frameOf(section, on.k, tram.sections.length - 1);
    const yaw = Math.atan2(-f.dz, f.dx);
    let turn = yaw - on.yaw;
    turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
    // The way the tram goes there (its section's, not turned round for the rear cab), for the sway.
    return { dx: f.x + on.x * f.dx - on.z * f.dz, dz: f.z + on.x * f.dz + on.z * f.dx, turn, heading: Math.atan2(-section.dz, section.dx) };
  }

  /** The tram drawn with this id, or undefined. */
  tram(id: number): DrawnTram | undefined {
    return this.drawn.find((t) => t.state.id === id);
  }

  /**
   * Someone in a doorway as its doors close: where to move them so the doors shut clear of them, inside if they stood
   * more in than out. Null when no door is closing on them.
   */
  doorway(feet: Vector3): Pt | null {
    for (const tram of this.drawn) {
      if (tram.distance > BOARD_REACH) break;
      const st = tram.state;
      if (!st.closing || st.doors <= 0 || st.doors > 0.7) continue;
      const last = tram.sections.length - 1;
      for (let k = 0; k <= last; k++) {
        const f = frameOf(tram.sections[k], k, last);
        const side = k === last ? -st.side : st.side;
        const ux = feet.x - f.x, uz = feet.z - f.z;
        const x = ux * f.dx + uz * f.dz, z = -ux * f.dz + uz * f.dx;
        if (Math.sign(z) !== side || Math.abs(z) < TRAM_WIDTH / 2 - 0.45 || Math.abs(z) > TRAM_WIDTH / 2 + 0.45) continue;
        if (!doorsOf(k === 0 || k === last ? 'end' : 'middle').some((d) => Math.abs(x - d) < TRAM_DOORS.width / 2 + 0.2)) continue;
        const toZ = side * (Math.abs(z) < TRAM_WIDTH / 2 ? TRAM_WIDTH / 2 - 0.5 : TRAM_WIDTH / 2 + 0.5);
        return [f.x + x * f.dx - toZ * f.dz, f.z + x * f.dz + toZ * f.dx];
      }
    }
    return null;
  }

  /**
   * The display over the aisle of the tram ridden (id), saying `text` (its line and destination over, the next stop
   * under); hidden with no tram.
   */
  showDisplay(id: number | null, line: string, headsign: string, text: string): void {
    const tram = id === null ? undefined : this.tram(id);
    this.display.visible = !!tram;
    if (!tram) return;
    const f = frameOf(tram.sections[0], 0, tram.sections.length - 1);
    this.q.setFromAxisAngle(this.up, Math.atan2(-f.dz, f.dx));
    this.m.compose(this.at.set(f.x, STREET_Y, f.z), this.q, this.one).multiply(this.displayLocal);
    this.display.matrixAutoUpdate = false;
    this.display.matrix.copy(this.m);
    this.display.matrixWorldNeedsUpdate = true;
    const key = `${line}|${headsign}|${text}`;
    if (key === this.displayText) return;
    this.displayText = key;
    const ctx = this.displayCanvas.getContext('2d')!;
    ctx.fillStyle = '#060708';
    ctx.fillRect(0, 0, 512, 96);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffb02e';
    fitText(ctx, line ? `${line} ${headsign}` : headsign, 480, 600, 30, MONO);
    ctx.fillText(line ? `${line} ${headsign}` : headsign, 256, 26);
    fitText(ctx, text, 480, 700, 40, MONO);
    ctx.fillText(text, 256, 66);
    ((this.display.material as MeshBasicMaterial).map as CanvasTexture).needsUpdate = true;
  }

  /** Bodies as bright as the daylight (and a little at night, the street lamps on them); windows lit from inside after dusk. */
  private light(daylight: number): void {
    this.body.color.setScalar(Math.max(0.2, daylight));
    const night = Math.min(1, Math.max(0, (0.5 - daylight) / 0.35));
    this.glass.color.copy(GLASS_DAY).multiplyScalar(Math.max(0.25, daylight)).lerp(GLASS_NIGHT, night);
    (this.glass.userData.day as { value: number }).value = daylight;
  }

  /**
   * The section of a moving tram about to run into someone at (`x`, `z`): in its way, its front a second's travel and a
   * meter ahead of it. Null when no tram is. A tram standing still runs into no one: people walk up to it and in.
   */
  inTheWay(x: number, z: number): { tram: DrawnTram; section: Footprint } | null {
    for (const tram of this.drawn) {
      if (tram.distance > 60) break;
      if (Math.abs(tram.state.speed) <= 0.05) continue;
      for (let k = 0; k < tram.sections.length; k++) {
        const ahead = k === 0 ? 1 + Math.abs(tram.state.speed) : 0;
        if (inFootprint(tram.sections[k], x, z, 0.25, ahead)) return { tram, section: tram.sections[k] };
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
        out.push(reach ? { ...f, x: f.x + (f.dx * reach) / 2, z: f.z + (f.dz * reach) / 2, hl: f.hl + reach / 2 } : { ...f });
      });
    }
    return out;
  }

  /** The nearest tram drawn: which, how far and how fast, for its sound; null when none is. */
  nearest(): { id: number; distance: number; speed: number } | null {
    const t = this.drawn[0];
    return t ? { id: t.state.id, distance: t.distance, speed: Math.abs(t.state.speed) } : null;
  }
}
