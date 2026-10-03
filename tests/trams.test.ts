import { describe, expect, test } from 'bun:test';
import { CLEAR, inFootprint, stepAside, type Footprint } from '../src/game/city/aside';
import type { Pt } from '../src/game/city/geo';
import { doorsOf, sectionBoxes, sectionHalf, tramModel } from '../src/game/city/tramModel';
import { TRAM_FLOOR, TRAM_JOINT, TRAM_LENGTH, TRAM_ROOF, TRAM_SECTION_ENDS, TRAM_WIDTH, TRAM_WIRE } from '../src/game/layout';

describe('the M34', () => {
  test('is 45 m in four sections, a cab at each end, as wide as the track allows', () => {
    expect(TRAM_SECTION_ENDS[TRAM_SECTION_ENDS.length - 1]).toBe(TRAM_LENGTH);
    expect(TRAM_SECTION_ENDS.length - 1).toBe(4);
    // The sections and the gaps the bellows close add up to the car.
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += 2 * sectionHalf(k) + TRAM_JOINT;
    expect(sum).toBeCloseTo(TRAM_LENGTH, 6);
    const m = tramModel();
    m.end.computeBoundingBox();
    m.middle.computeBoundingBox();
    const end = m.end.boundingBox!, mid = m.middle.boundingBox!;
    // The cab reaches the end section's front; nothing sticks out beside the car or above its roof.
    expect(end.max.x).toBeCloseTo(sectionHalf(0), 3);
    for (const b of [end, mid]) {
      expect(b.max.z).toBeLessThanOrEqual(TRAM_WIDTH / 2 + 1e-6);
      expect(b.min.z).toBeGreaterThanOrEqual(-TRAM_WIDTH / 2 - 1e-6);
      expect(b.max.y).toBeLessThanOrEqual(TRAM_ROOF + 1e-6);
    }
    // The pantograph is up at the wire.
    m.pantograph.computeBoundingBox();
    expect(m.pantograph.boundingBox!.max.y).toBeCloseTo(TRAM_WIRE, 1);
  });

  test('has eight double doors a side, none in the cab', () => {
    const doors = [...doorsOf('end'), ...doorsOf('middle'), ...doorsOf('middle'), ...doorsOf('end')];
    expect(doors.length).toBe(8);
    for (const d of doorsOf('end')) expect(d).toBeLessThan(sectionHalf(0) - 1.1 - 0.65);
    for (const d of doorsOf('middle')) expect(Math.abs(d)).toBeLessThan(sectionHalf(1) - 0.65);
  });
});

describe('stepping out of a tram\'s way', () => {
  const hw = TRAM_WIDTH / 2;
  // A tram along +x, its front section at the origin; the track along z = 0, and a second track at z = 3.2.
  const tram: Footprint = { x: 0, z: 0, dx: 1, dz: 0, hl: 5.6, hw };
  const track: Array<[Pt, Pt]> = [[[-50, 0], [50, 0]]];
  const both: Array<[Pt, Pt]> = [...track, [[-50, 3.2], [50, 3.2]]];
  const anywhere = () => true;
  const clearOf = (p: Pt, segs: Array<[Pt, Pt]>) => segs.every(([a, b]) => Math.abs(p[1] - a[1]) >= hw + CLEAR - 1e-9 || p[0] < a[0] || p[0] > b[0]);

  test('sees someone in front of a moving tram, not beside it', () => {
    expect(inFootprint(tram, 6.5, 0.3, 0.25, 2)).toBe(true);
    expect(inFootprint(tram, 6.5, 0.3, 0.25, 0)).toBe(false);
    expect(inFootprint(tram, 0, hw + 0.5, 0.25, 2)).toBe(false);
  });

  test('steps to the side they stand on, clear of the track', () => {
    const to = stepAside(6, -0.4, tram, [tram], track, hw, anywhere)!;
    expect(to[1]).toBeLessThan(0);
    expect(clearOf(to, track)).toBe(true);
    expect(Math.abs(to[0] - 6)).toBeLessThan(0.01);
  });

  test('never onto the other track of a double track: across it, or the other way', () => {
    // Standing between the two tracks' middles, nearer the far one.
    const to = stepAside(6, 0.5, tram, [tram], both, hw, anywhere)!;
    expect(clearOf(to, both)).toBe(true);
  });

  test('not into a wall: the other side, then round about', () => {
    const wallLeft = (_x: number, z: number) => z > -2;
    const to = stepAside(6, -0.4, tram, [tram], track, hw, wallLeft)!;
    expect(to[1]).toBeGreaterThan(0);
    expect(stepAside(6, 0, tram, [tram], track, hw, () => false)).toBeNull();
  });
});

describe('boarding the M34', () => {
  test('has a floor, a ceiling and walls, a doorway at every door on both sides, and a wall to the cab', () => {
    for (const kind of ['end', 'middle'] as const) {
      const boxes = sectionBoxes(kind);
      const floor = boxes[0];
      expect(floor.y1).toBeCloseTo(TRAM_FLOOR, 6);
      // The floor reaches half across each articulation (the cab's wall in an end section).
      expect(floor.x0).toBeCloseTo(-sectionHalf(kind === 'end' ? 0 : 1) - TRAM_JOINT / 2, 6);
      for (const s of [1, -1] as const) {
        const panels = boxes.filter((b) => b.door?.side === s);
        expect(panels.length).toBe(doorsOf(kind).length);
        for (const d of doorsOf(kind)) expect(panels.some((p) => p.x0 < d && p.x1 > d)).toBe(true);
        // The side is closed but for its doorways: its boxes meet end to end.
        const wall = boxes.filter((b) => (s > 0 ? b.z1 > 0 : b.z0 < 0) && b.y0 === TRAM_FLOOR && b.y1 > 2 && Math.abs(b.z1 - b.z0) < 0.2).sort((a, b) => a.x0 - b.x0);
        for (let k = 1; k < wall.length; k++) expect(wall[k].x0).toBeCloseTo(wall[k - 1].x1, 6);
      }
      const cabWall = boxes.some((b) => Math.abs(b.z1 - b.z0) > 2 && b.y0 === TRAM_FLOOR && b.x1 - b.x0 < 0.2);
      expect(cabWall).toBe(kind === 'end');
    }
  });
});
