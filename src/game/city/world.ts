// The city as the player finds it: the ground everywhere at street level from the start, and the squares of city
// (`tiles.ts`) built when the player comes near and taken down when far. The lazy-build machinery is Joel's (`World`
// in `world/world.ts`), with the distances measured in two dimensions instead of along the line, and the reaches set
// by the open air's fog (the camera sees about 410 m). `World` itself is not imported: it brings the metro's map data
// into the build. The names the scripts read are kept: `group`, `building`, `paused`, `warm`.

import { Box3, Group, type Mesh, type Object3D } from 'three';
import type { Physics } from '../physics';
import { freeMemory } from '../world/section';
import { CITY, cityTiles, PLAY, STREET_Y, type Rect } from './geo';
import { Tiles } from './tiles';

/** Geometry built when the player comes near the rect it stands in: at once, or in steps spread over frames. */
interface Lazy {
  rect: Rect;
  build(): void | Generator<void, unknown>;
  /** What the build added to the world, to take down again when the player is far away. */
  groups: Object3D[];
  /** Lets go of what the rest of the game was handed from the build, when it is taken down. */
  release?(): void;
  /** False while something the build needs is still on the way (a square's file): it waits in the queue. */
  ready?(): boolean;
  /** Under the street (Västlänken, `underground.ts`): built and shown only while the player is down there. */
  under?: boolean;
}

/** Built when the player comes this close: the fog's far edge, and some to spare for walking on. */
export const BUILD_REACH = 600;
/** Taken down and freed this far away, to be built again on the way back. */
const EVICT_REACH = 900;
/** Hidden this far away: past the fog, so nothing seen is ever hidden. */
const SHOW_REACH = 450;
/** How far the player moves between two passes over what to show. */
const SHOW_STEP = 25;
/** Within this, a square missing is built at once, frame or no frame. */
const MUST_REACH = 150;
/** Within this, a missing square gets a few milliseconds of every frame until it is done. */
const NEAR_REACH = 400;
/** Meshes with more vertices than this are warmed on the GPU in a step of their own. */
const WARM_ALONE = 20_000;
/** The walls round the playable area: how high, so no one jumps them. */
const EDGE_HEIGHT = 6;

/** How far a point lies from a rect, in the plane. */
const away = (r: Rect, x: number, z: number) => Math.hypot(Math.max(0, r.x0 - x, x - r.x1), Math.max(0, r.z0 - z, z - r.z1));

export class CityWorld {
  readonly group = new Group();
  /** Uploads an object's geometry and textures to the GPU (set by whoever owns the renderer), so a new square does not stall its first frame. */
  warm: ((object: Object3D) => void) | null = null;
  /** A lazy build in progress, advanced one step per frame. */
  building: { entry: Lazy; steps: Generator<void, unknown> } | null = null;
  /** Builds set aside half done for something nearer, to go on with afterwards. */
  paused: Array<{ entry: Lazy; steps: Generator<void, unknown> }> = [];
  private readonly lazy: Lazy[] = [];
  private readonly built: Lazy[] = [];
  private recording: Lazy | null = null;
  /** Each top-level group's extent in the plane, for hiding what is far away. */
  private readonly extents = new Map<Object3D, Rect>();
  private shownAt: [number, number] = [Number.NaN, Number.NaN];
  private shownCount = 0;
  private below = false;
  readonly tiles: Tiles;

  /**
   * Whether the player is under the street: only what lies at the player's level is built and shown, the city's
   * squares up on the street or the underground's sections down below (the two never in sight of each other).
   */
  get under(): boolean {
    return this.below;
  }

  set under(below: boolean) {
    if (below === this.below) return;
    this.below = below;
    this.shownAt = [Number.NaN, Number.NaN];
    // What was built at the level left is taken down at once, its memory and colliders with it: the player only comes
    // back through a door, and what lies there is built again behind the fade.
    for (const entry of [...this.built]) if (!this.here(entry) && this.building?.entry !== entry && !this.paused.some((p) => p.entry === entry)) this.takeDown(entry);
  }

  /** Whether a lazy build belongs to the level the player is at. */
  private here(entry: Lazy): boolean {
    return !!entry.under === this.below;
  }

  /** @param windowLight how lit the city's windows are now, 0 by day to 1 at night. */
  constructor(physics: Physics, windowLight: () => number) {
    this.group.name = 'city';
    // The ground, everywhere at once: no square can be walked off while its file is on the way.
    physics.box({ x: CITY.x0, y: STREET_Y - 1, z: CITY.z0 }, { x: CITY.x1, y: STREET_Y, z: CITY.z1 });
    // And walls round where the player may go, past which the city thins out into the fog.
    const { x0, x1, z0, z1 } = PLAY;
    const [y0, y1] = [STREET_Y - 1, STREET_Y + EDGE_HEIGHT];
    physics.box({ x: x0 - 1, y: y0, z: z0 - 1 }, { x: x1 + 1, y: y1, z: z0 });
    physics.box({ x: x0 - 1, y: y0, z: z1 }, { x: x1 + 1, y: y1, z: z1 + 1 });
    physics.box({ x: x0 - 1, y: y0, z: z0 }, { x: x0, y: y1, z: z1 });
    physics.box({ x: x1, y: y0, z: z0 }, { x: x1 + 1, y: y1, z: z1 });
    this.tiles = new Tiles(physics, windowLight);
    for (const t of cityTiles()) {
      let release: (() => void) | null = null;
      const self = this;
      this.later(t.rect, function* () {
        const built = yield* self.tiles.build(t.key, t.rect, (t.i + 100) * 1000 + t.j + 100);
        if (!built) return;
        release = built.release;
        yield* self.add(built.group);
      }, () => {
        release?.();
        release = null;
      }, () => this.tiles.ready(t.key));
    }
  }

  /**
   * Queues something to be built when the player comes near `rect`, and taken down (with `release`) when far; `under`
   * the street, only while the player is down there.
   */
  later(rect: Rect, build: Lazy['build'], release?: Lazy['release'], ready?: Lazy['ready'], under = false): void {
    this.lazy.push({ rect, build, groups: [], release, ready, under });
  }

  /** Adds a lazily built group and warms it on the GPU. */
  *add(group: Object3D): Generator<void, void> {
    group.userData.under = !!this.recording?.under;
    this.group.add(group);
    this.recording?.groups.push(group);
    yield* this.warmSteps(group);
  }

  /** Runs one step of a lazy build, noting what it adds. */
  private step(entry: Lazy, steps: Generator<void, unknown>): boolean {
    this.recording = entry;
    try {
      return !!steps.next().done;
    } finally {
      this.recording = null;
    }
  }

  /** Takes down what was built further than `reach` from (`x`, `z`), frees its memory and queues it to be built again. */
  private evict(x: number, z: number, reach = EVICT_REACH): void {
    for (const entry of [...this.built]) {
      if (this.building?.entry === entry || this.paused.some((p) => p.entry === entry) || away(entry.rect, x, z) < reach) continue;
      this.takeDown(entry);
    }
  }

  /** Takes one build down, frees its memory and lets go of what it handed out, and queues it to be built again. */
  private takeDown(entry: Lazy): void {
    for (const group of entry.groups) {
      this.group.remove(group);
      this.extents.delete(group);
      freeMemory(group);
    }
    entry.groups = [];
    entry.release?.();
    this.built.splice(this.built.indexOf(entry), 1);
    this.lazy.push(entry);
  }

  /** Warms a new group's meshes on the GPU: each big mesh in a step of its own, then everything else together. */
  private *warmSteps(group: Object3D): Generator<void, void> {
    if (!this.warm) return;
    const big: Object3D[] = [];
    group.traverse((o) => {
      const geo = (o as Mesh).geometry;
      if (geo && (geo.getAttribute('position')?.count ?? 0) > WARM_ALONE) big.push(o);
    });
    for (const mesh of big) {
      yield;
      this.warm(mesh);
    }
    yield;
    this.warm(group);
  }

  /**
   * One step of building toward (`x`, `z`): on with the build under way if it lies within `reach`, else the nearest
   * thing within reach (whose file is here) is started, and a build further off is set aside to go on with later.
   * False when nothing within reach is left to build.
   */
  private buildNear(x: number, z: number, reach: number): boolean {
    const off = (e: Lazy) => away(e.rect, x, z);
    const current = this.building;
    if (current && off(current.entry) < reach && this.here(current.entry)) {
      if (this.step(current.entry, current.steps)) this.building = this.paused.pop() ?? null;
      return true;
    }
    let best: Lazy | null = null;
    let distance = Infinity;
    for (const l of this.lazy) {
      const d = off(l);
      if (d < reach && d < distance && this.here(l) && (!l.ready || l.ready())) {
        best = l;
        distance = d;
      }
    }
    if (!best) {
      // Something set aside may be what is near now.
      const i = this.paused.findIndex((p) => off(p.entry) < reach && this.here(p.entry));
      if (i < 0) return false;
      if (current) this.paused.push(current);
      this.building = this.paused.splice(i, 1)[0];
      return true;
    }
    this.lazy.splice(this.lazy.indexOf(best), 1);
    this.built.push(best);
    this.recording = best;
    const steps = best.build();
    this.recording = null;
    if (!steps) return true;
    if (current) this.paused.push(current);
    this.building = this.step(best, steps) ? this.paused.pop() ?? null : { entry: best, steps };
    return true;
  }

  /**
   * One step of a build left behind out of reach (the player walked away from it half done), so it is finished and can
   * be taken down like the rest, rather than held half built for good. False when there is none.
   */
  private finishBehind(): boolean {
    if (!this.building) this.building = this.paused.pop() ?? null;
    const current = this.building;
    if (!current) return false;
    if (this.step(current.entry, current.steps)) this.building = this.paused.pop() ?? null;
    return true;
  }

  /** Whether a build within `reach` of (`x`, `z`) is under way or set aside half done. */
  private halfBuilt(x: number, z: number, reach: number): boolean {
    return [this.building, ...this.paused].some((b) => b && away(b.entry.rect, x, z) < reach && this.here(b.entry));
  }

  /**
   * Per frame: what lies within `MUST_REACH` is built now, whatever it takes; what lies within `NEAR_REACH` gets up to
   * `budget` milliseconds of building; one step more toward anything within `BUILD_REACH`, or else of a build left
   * behind; then what is far is hidden, and the windows are lit.
   */
  keepUp(x: number, z: number, budget = 6): void {
    while (this.buildNear(x, z, MUST_REACH));
    const until = performance.now() + budget;
    while (performance.now() < until && this.buildNear(x, z, NEAR_REACH));
    if (!this.buildNear(x, z, BUILD_REACH)) this.finishBehind();
    this.show(x, z);
    this.tiles.lightWindows();
  }

  /** Builds everything within `reach` of (`x`, `z`) whose file is here, right away (after a teleport). */
  ensureBuilt(x: number, z: number, reach = NEAR_REACH): void {
    while (this.buildNear(x, z, reach));
    this.show(x, z);
  }

  /**
   * Takes down everything built, finishing first what is half built: a clean slate before a teleport, so that what is
   * built round the place (`settle` with `BUILD_REACH`) is the same whichever place came before (the measuring scenes).
   */
  clear(): void {
    while (this.finishBehind());
    this.evict(0, 0, 0);
  }

  /** How many things within `reach` of (`x`, `z`) are not built yet: waiting for a file, or not started. */
  missing(x: number, z: number, reach = MUST_REACH): number {
    return this.lazy.filter((l) => away(l.rect, x, z) < reach && this.here(l)).length;
  }

  /**
   * Builds everything within `reach` of (`x`, `z`), waiting for the squares' files to arrive (behind the loading screen,
   * or after a teleport): at most `wait` milliseconds, so a city offline still opens, bare. A build left half done far away (the
   * place teleported from) is not waited for: `keepUp` finishes it in the frames to come.
   */
  async settle(x: number, z: number, wait = 15_000, reach = NEAR_REACH): Promise<void> {
    const until = performance.now() + wait;
    for (;;) {
      this.ensureBuilt(x, z, reach);
      if ((!this.missing(x, z, reach) && !this.halfBuilt(x, z, reach)) || performance.now() > until) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Shows what lies within `SHOW_REACH` of (`x`, `z`) and hides the rest, whenever the player has moved `SHOW_STEP`. */
  private show(x: number, z: number): void {
    if (this.shownCount === this.group.children.length && Math.hypot(x - this.shownAt[0], z - this.shownAt[1]) < SHOW_STEP) return;
    this.evict(x, z);
    this.shownAt = [x, z];
    this.shownCount = this.group.children.length;
    for (const child of this.group.children) {
      let extent = this.extents.get(child);
      if (!extent) {
        child.updateMatrixWorld(true);
        const box = new Box3().setFromObject(child);
        extent = box.isEmpty() ? { x0: -Infinity, x1: Infinity, z0: -Infinity, z1: Infinity } : { x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z };
        this.extents.set(child, extent);
      }
      child.visible = away(extent, x, z) < SHOW_REACH && !!child.userData.under === this.below;
    }
  }
}
