import { expect, test } from 'bun:test';
import { BoxGeometry, Mesh, MeshBasicMaterial } from 'three';
import { CityWorld } from '../src/game/city/world';
import { Physics } from '../src/game/physics';

/** A city world with something of its own to build at (`x`, `z`): a box, counted as it is built, freed and released. */
function withBox(x: number, z: number, ready = () => true) {
  // Under Bun there are no square files: the city's own squares build nothing, and only the box is seen.
  const world = new CityWorld(new Physics(), () => 0);
  const counts = { builds: 0, disposed: 0, released: 0 };
  let mesh: Mesh | null = null;
  world.later({ x0: x - 10, x1: x + 10, z0: z - 10, z1: z + 10 }, function* () {
    counts.builds++;
    const geo = new BoxGeometry(20, 20, 20);
    geo.addEventListener('dispose', () => counts.disposed++);
    mesh = new Mesh(geo, new MeshBasicMaterial());
    mesh.position.set(x, 0, z);
    yield* world.add(mesh);
  }, () => counts.released++, ready);
  return { world, counts, mesh: () => mesh };
}

test('builds what lies near in the plane, not what lies at the same x far off across it', () => {
  const near = withBox(500, -300);
  near.world.ensureBuilt(500, -150);
  expect(near.counts.builds).toBe(1);
  const across = withBox(500, -1400);
  across.world.ensureBuilt(500, -150);
  expect(across.counts.builds).toBe(0);
});

test('takes down, frees and lets go of what is far away, and builds it again on the way back', () => {
  const { world, counts } = withBox(500, -300);
  world.ensureBuilt(500, -300);
  expect(world.group.children.length).toBe(1);
  // Far off across the city, not along x: taken down, freed, released.
  world.ensureBuilt(500, -1600);
  expect(world.group.children.length).toBe(0);
  expect(counts.disposed).toBe(1);
  expect(counts.released).toBe(1);
  world.ensureBuilt(500, -300);
  expect(counts.builds).toBe(2);
  expect(world.group.children.length).toBe(1);
});

test('hides what is past the fog, and shows it again on the way back', () => {
  const { world, mesh } = withBox(500, -300);
  world.ensureBuilt(500, -300);
  expect(mesh()!.visible).toBe(true);
  // 600 m off: built still, but hidden.
  world.ensureBuilt(500, 300);
  expect(world.group.children.length).toBe(1);
  expect(mesh()!.visible).toBe(false);
  world.ensureBuilt(500, -250);
  expect(mesh()!.visible).toBe(true);
});

test('waits for a file on the way, and builds once it is here', async () => {
  let here = false;
  const { world, counts } = withBox(500, -300, () => here);
  world.ensureBuilt(500, -300);
  expect(counts.builds).toBe(0);
  expect(world.missing(500, -300)).toBeGreaterThan(0);
  here = true;
  await world.settle(500, -300, 500);
  expect(counts.builds).toBe(1);
});

test('finishes a build the player walked away from half done, and does not wait for it where they went', async () => {
  const world = new CityWorld(new Physics(), () => 0);
  const counts = { steps: 0, done: 0, released: 0 };
  world.later({ x0: 490, x1: 510, z0: -310, z1: -290 }, function* () {
    for (let k = 0; k < 5; k++) {
      counts.steps++;
      yield;
    }
    const mesh = new Mesh(new BoxGeometry(20, 20, 20), new MeshBasicMaterial());
    mesh.position.set(500, 0, -300);
    yield* world.add(mesh);
    counts.done++;
  }, () => counts.released++);
  // 490 m off: past what is built at once, but within reach of a step a frame (after the city's own squares, nearer).
  for (let k = 0; k < 100 && !counts.steps; k++) world.keepUp(500, 200);
  expect(counts.steps).toBe(1);
  // Then far off: nothing near is missing, so settling there does not wait out the half-done build.
  const start = performance.now();
  await world.settle(500, 1500, 5000);
  expect(performance.now() - start).toBeLessThan(1000);
  // The frames there finish it, and take it down again.
  for (let k = 0; k < 50 && !counts.released; k++) world.keepUp(500, 1500);
  expect(counts.done).toBe(1);
  expect(counts.released).toBe(1);
  expect(world.building).toBeNull();
});

test('clears to a clean slate, taking down what is built and finishing what is half built first', () => {
  const { world, counts } = withBox(500, -300);
  world.ensureBuilt(500, -300);
  expect(world.group.children.length).toBe(1);
  world.clear();
  expect(world.group.children.length).toBe(0);
  expect(counts.released).toBe(1);
  expect(world.building).toBeNull();
  world.ensureBuilt(500, -300);
  expect(counts.builds).toBe(2);
});
