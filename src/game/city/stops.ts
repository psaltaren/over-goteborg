// The tram stops: a platform for each of Västtrafik's stop points in the area (a platform, `RunStop.stop`), raised as
// Gothenburg's kerbs are beside its track, as long as a tram from where the tram stops back; a shelter on it, a post
// with the stop's name, and on the post a display of the next trams to leave, from the timetable (`TripTable.
// departures`, live when Västtrafik's word is in). The platforms, shelters and posts are one baked section, built once
// when the timetable is here; the displays are a few canvases, given to the platforms nearest the player and drawn once
// a second, a traffic notice taking a display's turn now and then where Västtrafik has one for the stop or its lines.

import { CanvasTexture, Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three';
import type { Paint } from '../gfx/builder';
import { rgb } from '../gfx/color';
import { FONT, fitText, MONO } from '../gfx/signs';
import { TRAM_PLATFORM, TRAM_SECTION_ENDS, TRAM_WIDTH } from '../layout';
import type { Physics, StaticCollider } from '../physics';
import { Section } from '../world/section';
import { STREET_Y, type Pt } from './geo';
import { TramPath } from './path';
import { signAt, type Run } from './schedule';
import type { Link } from './trackData';
import { TrackIndex } from './trackIndex';
import type { TripTable } from './tripTable';

const AMBIENT = rgb(0x4a4a4a);
const SLAB = rgb(0xaaa69e);
const KERB = rgb(0x8b8881);
const EDGE = rgb(0xf2f0e8);
const STEEL = rgb(0x5a6266);
const GLASS = rgb(0x9fb4be);
const ROOF = rgb(0x3a3f43);
const SIGN_BLUE = '#1d4a86';
/** How the platform is sampled along its track, in meters. */
const STEP = 2;
/** How many departure displays there are, and how near a platform must be to have one. */
const DISPLAYS = 4;
const DISPLAY_REACH = 70;
/** The name signs' atlas: a row each. */
const NAME_W = 256, NAME_H = 48;
/** A display with a traffic notice shows it this many seconds of each turn of so many. */
const NOTICE_SHOWN = 4, NOTICE_TURN = 12;
/** The heading of a notice on a display (in-world, Swedish). */
const NOTICE_HEAD = 'Trafikinformation';

/** A stop's platform: its stop point, its name and letter, along which run's track, and how it lies. */
interface Platform {
  stop: string;
  name: string;
  letter: string;
  /** The post's foot, and the way its signs face (along the platform, toward its far end). */
  post: Pt;
  facing: Pt;
  /** The lines that leave from it. */
  lines: string[];
}

/** A traffic notice for a platform (its stop point and the lines that leave from it), or null when there is none. */
export type NoticeFor = (stop: string, lines: string[]) => string | null;

export class Stops {
  readonly group = new Group();
  readonly colliders: StaticCollider[] = [];
  private readonly platforms: Platform[] = [];
  private readonly displays: Array<{ mesh: Mesh; ctx: CanvasRenderingContext2D; texture: CanvasTexture; platform: Platform | null; text: string }> = [];

  constructor(physics: Physics, private readonly table: TripTable, runs: Run[], links: Link[]) {
    const index = new TrackIndex(links);
    const s = new Section('stops', AMBIENT, false, true);
    const seen = new Set<string>();
    const lay: Array<{ run: Run; k: number; path: TramPath }> = [];
    const linesAt = new Map<string, Set<string>>();
    for (const run of runs) {
      let path: TramPath | null = null;
      run.stops.forEach((st, k) => {
        if (!st.stop || st.s < 0 || st.s > run.length) return;
        const line = signAt(run, st.s).line;
        if (line) linesAt.set(st.stop, (linesAt.get(st.stop) ?? new Set()).add(line));
        if (seen.has(st.stop)) return;
        seen.add(st.stop);
        path ??= new TramPath(run, links);
        lay.push({ run, k, path });
      });
    }
    // The names, an atlas row each, drawn once.
    const canvas = document.createElement('canvas');
    canvas.width = NAME_W;
    canvas.height = NAME_H * Math.max(1, lay.length);
    const names = canvas.getContext('2d')!;
    const atlas = new CanvasTexture(canvas);
    atlas.colorSpace = SRGBColorSpace;
    const signs = s.artLayer(atlas, true);
    for (const { run, k, path } of lay) {
      const st = run.stops[k];
      const built = this.platform(s, physics, index, path, st.s, st.side);
      if (!built) continue;
      const row = this.platforms.length;
      this.platforms.push({ stop: st.stop, name: st.name, letter: st.platform, post: built.post, facing: built.facing, lines: [...(linesAt.get(st.stop) ?? [])] });
      drawName(names, row, st.name, st.platform);
      // The name sign on its post, both ways round.
      const [px, pz] = built.post, [fx, fz] = built.facing;
      const v0 = 1 - (row + 1) / lay.length, v1 = 1 - row / lay.length;
      for (const turn of [1, -1]) {
        // Across the sign to the right of someone reading it from the side it faces (`facing`, turned).
        const rx = fz * turn * 0.55, rz = -fx * turn * 0.55;
        const at = (sx: number, y: number): Vector3 => new Vector3(px + rx * sx + fx * turn * 0.06, STREET_Y + TRAM_PLATFORM.height + y, pz + rz * sx + fz * turn * 0.06);
        const [a, b, c, d] = [at(-1, 2.7), at(1, 2.7), at(1, 2.98), at(-1, 2.98)];
        signs.tri(a, b, c, rgb(0xffffff), { uvs: [[0, v0], [1, v0], [1, v1]] });
        signs.tri(a, c, d, rgb(0xffffff), { uvs: [[0, v0], [1, v1], [0, v1]] });
      }
    }
    atlas.needsUpdate = true;
    this.group.add(s.finish());
    for (let i = 0; i < DISPLAYS; i++) {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 128;
      const texture = new CanvasTexture(c);
      texture.colorSpace = SRGBColorSpace;
      const mesh = new Mesh(new PlaneGeometry(1.0, 0.5), new MeshBasicMaterial({ map: texture }));
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.displays.push({ mesh, ctx: c.getContext('2d')!, texture, platform: null, text: '' });
    }
  }

  /**
   * A platform beside a run's track from its stop at `s` back as far as a tram is long: on the stop's side, as wide as
   * the other tracks allow (none if under a meter), with a shelter and a post. Null when there is no room.
   */
  private platform(s: Section, physics: Physics, index: TrackIndex, path: TramPath, at: number, side: 1 | -1): { post: Pt; facing: Pt } | null {
    const { height, edge: straight, width, back, ahead } = TRAM_PLATFORM;
    const hw = TRAM_WIDTH / 2;
    const samples: Array<{ p: Pt; n: Pt; d: Pt }> = [];
    for (let a = at - back; a <= at + ahead + 1e-6; a += STEP) {
      const p = path.point(Math.min(a, at + ahead));
      const d = path.direction(Math.min(a, at + ahead));
      samples.push({ p, n: [-d[1] * side, d[0] * side], d });
    }
    // On the inside of a curve a tram's sections, straight between their ends on the track, bulge in toward the
    // platform by as much as a chord does: the edge moves out by that much, the tightest the platform has.
    let bulge = 0;
    const chord = Math.max(...TRAM_SECTION_ENDS.slice(1).map((e, k) => e - TRAM_SECTION_ENDS[k]));
    for (let i = 0; i + 1 < samples.length; i++) {
      const [a, b] = [samples[i], samples[i + 1]];
      const turn = (b.d[0] - a.d[0]) * a.n[0] + (b.d[1] - a.d[1]) * a.n[1];
      if (turn > 0) bulge = Math.max(bulge, (chord * chord * turn) / (8 * STEP));
    }
    const edge = straight + Math.min(0.9, bulge);
    // As wide as no other track's trams come within a little of it, its own track nearest all across.
    const clear = (o: number) => samples.every(({ p, n }) => {
      const dist = index.distance(p[0] + n[0] * o, p[1] + n[1] * o);
      return dist >= hw + 0.35 || dist >= o - 0.05;
    });
    let w = width;
    while (w >= 1 && !clear(edge + w)) w -= 0.2;
    if (w < 1) return null;
    const y = STREET_Y, top = y + height;
    const at3 = (q: Pt, o: number, n: Pt, h: number) => new Vector3(q[0] + n[0] * o, h, q[1] + n[1] * o);
    for (let i = 0; i + 1 < samples.length; i++) {
      const [a, b] = [samples[i], samples[i + 1]];
      const quad = (o0: number, o1: number, h0: number, h1: number, paint: Paint) => s.lit.quad(at3(a.p, o0, a.n, h0), at3(b.p, o0, b.n, h0), at3(b.p, o1, b.n, h1), at3(a.p, o1, a.n, h1), paint);
      // The top, a white line along its edge, and its kerb toward the track and its back.
      faceUp(s, at3(a.p, edge + 0.12, a.n, top), at3(b.p, edge + 0.12, b.n, top), at3(b.p, edge + w, b.n, top), at3(a.p, edge + w, a.n, top), SLAB);
      faceUp(s, at3(a.p, edge, a.n, top + 0.001), at3(b.p, edge, b.n, top + 0.001), at3(b.p, edge + 0.12, b.n, top + 0.001), at3(a.p, edge + 0.12, a.n, top + 0.001), EDGE);
      quad(edge, edge, y - 0.05, top, KERB);
      quad(edge + w, edge + w, y - 0.05, top, KERB);
      // Solid: a box a step, turned with the track.
      const mx = (a.p[0] + b.p[0]) / 2 + a.n[0] * (edge + w / 2), mz = (a.p[1] + b.p[1]) / 2 + a.n[1] * (edge + w / 2);
      const len = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
      this.colliders.push(physics.turnedBox({ x: mx, y: y + height / 2 - 0.05, z: mz }, { x: len / 2 + 0.05, y: height / 2 + 0.05, z: w / 2 }, Math.atan2(-a.d[1], a.d[0])));
    }
    // The platform's two ends.
    for (const e of [samples[0], samples[samples.length - 1]]) s.lit.quad(at3(e.p, edge, e.n, y - 0.05), at3(e.p, edge + w, e.n, y - 0.05), at3(e.p, edge + w, e.n, top), at3(e.p, edge, e.n, top), KERB);
    // The shelter, a third of the way back: a roof on posts, glass at its back and ends.
    const mid = samples[Math.floor(samples.length * 0.62)];
    const so = edge + w - 0.25, sl = 3.2, sd = Math.min(1.5, w - 0.4);
    const corner = (u: number, o: number, h: number) => new Vector3(mid.p[0] + mid.d[0] * u + mid.n[0] * o, top + h, mid.p[1] + mid.d[1] * u + mid.n[1] * o);
    for (const u of [-sl / 2, sl / 2]) for (const o of [so - sd, so]) {
      const c = corner(u, o, 0);
      s.lit.box({ x: c.x - 0.05, y: top, z: c.z - 0.05 }, { x: c.x + 0.05, y: top + 2.4, z: c.z + 0.05 }, STEEL, [], 2);
      this.colliders.push(physics.box({ x: c.x - 0.06, y: top, z: c.z - 0.06 }, { x: c.x + 0.06, y: top + 2.4, z: c.z + 0.06 }));
    }
    s.lit.quad(corner(-sl / 2 - 0.1, so - sd - 0.15, 2.45), corner(sl / 2 + 0.1, so - sd - 0.15, 2.45), corner(sl / 2 + 0.1, so + 0.1, 2.45), corner(-sl / 2 - 0.1, so + 0.1, 2.45), ROOF);
    s.lit.quad(corner(-sl / 2 - 0.1, so + 0.1, 2.5), corner(sl / 2 + 0.1, so + 0.1, 2.5), corner(sl / 2 + 0.1, so - sd - 0.15, 2.5), corner(-sl / 2 - 0.1, so - sd - 0.15, 2.5), ROOF);
    s.lit.quad(corner(-sl / 2, so, 0.15), corner(sl / 2, so, 0.15), corner(sl / 2, so, 2.3), corner(-sl / 2, so, 2.3), GLASS);
    const glassWall = corner(0, so, 1.2);
    this.colliders.push(physics.turnedBox({ x: glassWall.x, y: top + 1.2, z: glassWall.z }, { x: sl / 2, y: 1.1, z: 0.04 }, Math.atan2(-mid.d[1], mid.d[0])));
    // The post with the name and the display, near the platform's front, across from where the tram's front stops.
    const front = samples[samples.length - 3];
    const po = edge + Math.min(1.2, w / 2);
    const post: Pt = [front.p[0] + front.n[0] * po, front.p[1] + front.n[1] * po];
    s.lit.box({ x: post[0] - 0.05, y: top, z: post[1] - 0.05 }, { x: post[0] + 0.05, y: top + 3.0, z: post[1] + 0.05 }, STEEL, [], 2);
    this.colliders.push(physics.box({ x: post[0] - 0.07, y: top, z: post[1] - 0.07 }, { x: post[0] + 0.07, y: top + 2.2, z: post[1] + 0.07 }));
    return { post, facing: [-front.d[0], -front.d[1]] };
  }

  /**
   * Once a second: the displays given to the platforms nearest (`x`, `z`), each showing its next trams at `epoch`, and
   * for a few seconds now and then the platform's traffic notice, if `notice` has one.
   */
  update(epoch: number, x: number, z: number, notice: NoticeFor = () => null): void {
    const near = this.platforms
      .map((p) => ({ p, d: Math.hypot(p.post[0] - x, p.post[1] - z) }))
      .filter(({ d }) => d < DISPLAY_REACH)
      .sort((a, b) => a.d - b.d)
      .slice(0, DISPLAYS)
      .map(({ p }) => p);
    // A platform keeps its display while it stays near; the others go to those come near.
    const free = this.displays.filter((d) => !d.platform || !near.includes(d.platform));
    for (const d of free) d.platform = null;
    for (const p of near) if (!this.displays.some((d) => d.platform === p)) free.shift()!.platform = p;
    for (const d of this.displays) {
      d.mesh.visible = !!d.platform;
      if (!d.platform) continue;
      const p = d.platform;
      const [px, pz] = p.post, [fx, fz] = p.facing;
      d.mesh.matrix.copy(new Matrix4().makeRotationY(Math.atan2(fx, fz)).setPosition(px + fx * 0.07, STREET_Y + TRAM_PLATFORM.height + 2.3, pz + fz * 0.07));
      d.mesh.matrixWorldNeedsUpdate = true;
      const message = Math.floor(epoch) % NOTICE_TURN >= NOTICE_TURN - NOTICE_SHOWN ? notice(p.stop, p.lines) : null;
      if (message) {
        const text = JSON.stringify([p.stop, message]);
        if (text === d.text) continue;
        d.text = text;
        drawNotice(d.ctx, message);
        d.texture.needsUpdate = true;
        continue;
      }
      const departures = this.table.departures(p.stop, epoch, 3);
      const rows = departures.map((dep) => {
        const minutes = Math.floor((dep.at - epoch) / 60);
        return { line: dep.line, headsign: dep.headsign, when: minutes < 1 ? 'Nu' : `${minutes} min` };
      });
      const text = JSON.stringify([p.stop, rows]);
      if (text === d.text) continue;
      d.text = text;
      drawDepartures(d.ctx, rows);
      d.texture.needsUpdate = true;
    }
  }
}

/** A quad on the level, wound to face up whichever way it was given. */
function faceUp(s: Section, a: Vector3, b: Vector3, c: Vector3, d: Vector3, paint: Paint): void {
  const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
  if (ny >= 0) s.lit.quad(a, b, c, d, paint);
  else s.lit.quad(d, c, b, a, paint);
}

/** A stop's name sign, its row of the atlas: white on blue, its platform's letter in a white circle. */
function drawName(ctx: CanvasRenderingContext2D, row: number, name: string, letter: string): void {
  const y = row * NAME_H;
  ctx.fillStyle = SIGN_BLUE;
  ctx.fillRect(0, y, NAME_W, NAME_H);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  fitText(ctx, name, NAME_W - 60, 700, 26, FONT);
  ctx.fillText(name, 10, y + NAME_H / 2 + 1);
  ctx.beginPath();
  ctx.arc(NAME_W - 26, y + NAME_H / 2, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = SIGN_BLUE;
  ctx.textAlign = 'center';
  fitText(ctx, letter, 30, 800, 22, FONT);
  ctx.fillText(letter, NAME_W - 26, y + NAME_H / 2 + 1);
}

/** The next trams, amber on black: the line, where it goes, and when it leaves ("Nu", or minutes). */
function drawDepartures(ctx: CanvasRenderingContext2D, rows: Array<{ line: string; headsign: string; when: string }>): void {
  ctx.fillStyle = '#060708';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#ffb02e';
  ctx.textBaseline = 'middle';
  rows.forEach((r, i) => {
    const y = 22 + i * 40;
    ctx.textAlign = 'left';
    fitText(ctx, r.line, 34, 700, 26, MONO);
    ctx.fillText(r.line, 8, y);
    fitText(ctx, r.headsign, 140, 600, 24, MONO);
    ctx.fillText(r.headsign, 46, y);
    ctx.textAlign = 'right';
    fitText(ctx, r.when, 64, 700, 24, MONO);
    ctx.fillText(r.when, 250, y);
  });
}

/** A traffic notice, amber on black: its heading, and the notice in up to two lines. */
function drawNotice(ctx: CanvasRenderingContext2D, message: string): void {
  ctx.fillStyle = '#060708';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#ffb02e';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  fitText(ctx, NOTICE_HEAD, 240, 700, 24, MONO);
  ctx.fillText(NOTICE_HEAD, 8, 22);
  // The words in two lines of about half each, the second cut short if it must be.
  const words = message.split(/\s+/);
  let first = '';
  while (words.length && (first + ' ' + words[0]).trim().length <= Math.max(18, message.length / 2)) first = `${first} ${words.shift()}`.trim();
  let second = words.join(' ');
  if (second.length > 40) second = `${second.slice(0, 39).trimEnd()}…`;
  ctx.fillStyle = '#ffd27a';
  for (const [line, y] of [[first, 62], [second, 100]] as Array<[string, number]>) {
    if (!line) continue;
    fitText(ctx, line, 240, 600, 22, MONO);
    ctx.fillText(line, 8, y);
  }
}
