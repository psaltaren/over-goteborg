// The M34 (Alstom's Flexity, "Superspårvagnen"): Gothenburg's 45 m tram in four sections with a cab at each end, light
// blue under cream with a cream roof, black round dark windows and doors, after photographs of 602 and 607 in 2025.
// Built once as the few geometries every tram shares, for `trams.ts` to draw all trams instanced: an end section (its
// cab toward +x; the rear one is the same turned round) and a middle section, each with its glass apart (dark by day,
// lit at night), a door leaf, the bellows, the pantograph raised to the contact wire, the lamps at a cab and a sign.
// Local frame: x along the car (front +x), y up from the rail top, z to the right; a section's middle at the origin.

import { BoxGeometry, Matrix4, Vector3, type BufferGeometry } from 'three';
import { MeshBuilder, type Paint } from '../gfx/builder';
import { rgb } from '../gfx/color';
import { TRAM_BODY, TRAM_DOORS, TRAM_FLOOR, TRAM_JOINT, TRAM_ROOF, TRAM_SECTION_ENDS, TRAM_WIDTH, TRAM_WIRE } from '../layout';

/**
 * A colour shaded by the way its face turns, as the city's baked light has it: full on a roof, a little less on a side,
 * least underneath. The trams are drawn unlit (`MeshBasicMaterial`, scaled by the daylight like the open air), so they
 * sit in the street as its walls do.
 */
const shaded = (hex: number): Paint => {
  const c = rgb(hex);
  return (_p, n) => {
    const k = 0.8 + 0.2 * n.y + 0.06 * n.x - 0.03 * n.z;
    return [c[0] * k, c[1] * k, c[2] * k];
  };
};
const BLUE = shaded(0x3ba8e0);
const CREAM = shaded(0xf2ecdb);
const BLACK = shaded(0x16191c);
const UNDER = shaded(0x24282c);
const GREY = shaded(0x7a8187);
const BELLOWS = shaded(0x2d3135);
const DOOR_GLASS = shaded(0x2a3742);
/** Glass and lamps are white in the geometry: their materials give the colour (dark by day, lit at night). */
const GLASS = rgb(0xffffff);

/** Half the car's width, and its body's heights and shape (`TRAM_BODY`). */
const HW = TRAM_WIDTH / 2;
const { foot: FOOT, sill: SILL, head: HEAD, eave: EAVE, roof: ROOF, chamfer: CHAMFER, nose: NOSE, pane: PANE, post: POST } = TRAM_BODY;
const LEAF_T = TRAM_DOORS.leaf;

/** A section's half length, its `k`th of `TRAM_SECTION_ENDS`: its span less the gap at each articulation. */
export const sectionHalf = (k: number) => (TRAM_SECTION_ENDS[k + 1] - TRAM_SECTION_ENDS[k] - TRAM_JOINT) / 2;
const END_HALF = sectionHalf(0);
const MID_HALF = sectionHalf(1);

/** Where each door's middle lies along a section, in its own frame (front +x). */
export function doorsOf(kind: 'end' | 'middle'): number[] {
  const k = kind === 'end' ? 0 : 1;
  const span = TRAM_SECTION_ENDS[k + 1] - TRAM_SECTION_ENDS[k];
  return TRAM_DOORS[kind].map((d) => span / 2 - d);
}

export interface TramModel {
  /** An end section's body (cab at +x) and glass, and a middle section's. */
  end: BufferGeometry;
  endGlass: BufferGeometry;
  middle: BufferGeometry;
  middleGlass: BufferGeometry;
  /** One door leaf, its middle at the origin, its outside toward +z. */
  leaf: BufferGeometry;
  /** The bellows over an articulation, its middle at the origin. */
  bellows: BufferGeometry;
  /** The pantograph, raised to the contact wire, on a middle section's roof. */
  pantograph: BufferGeometry;
  /** The lamps at an end section's cab, white (coloured per tram: head or tail). */
  lamps: BufferGeometry;
  /** Where an end section's signs sit: the front display and one on each side, as matrices on a unit quad facing +z. */
  signs: Matrix4[];
  /** The inside of an end section and of a middle one: floor, lining, ceiling, seats, poles, the wall to the cab. */
  endInside: BufferGeometry;
  middleInside: BufferGeometry;
  /** Where the display inside an end section shows the next stop: a matrix on a unit quad facing +z. */
  display: Matrix4;
}

/** The inside's height: the ceiling, under the roof's equipment. */
export const CEILING = 2.45;
/** The walls' thickness inside, as the colliders have them. */
const WALL = 0.08;

/** A box a section's colliders are made of, in its own frame; a door's panel says which door and side it closes. */
export interface SectionBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  /** A doorway's panel (there while that side's doors are shut), or the step out of it (there while they are open). */
  door?: { side: 1 | -1 };
  step?: { side: 1 | -1 };
}

/**
 * The boxes that make a section solid and let people in through its doors: the floor and the ceiling, reaching half
 * across each articulation so one section's meet the next's, the walls between the doors, a panel in each doorway
 * (taken away while that side's doors are open) and a step out of it (there only while they are open: half the floor's
 * height, so the street is two easy steps down), and in an end section the wall to the cab.
 */
export function sectionBoxes(kind: 'end' | 'middle'): SectionBox[] {
  const hl = kind === 'end' ? END_HALF : MID_HALF;
  const x0 = -hl - TRAM_JOINT / 2;
  const x1 = kind === 'end' ? hl - NOSE : hl + TRAM_JOINT / 2;
  const out: SectionBox[] = [
    { x0, x1, y0: TRAM_FLOOR - 0.15, y1: TRAM_FLOOR, z0: -HW, z1: HW },
    { x0, x1, y0: CEILING, y1: CEILING + 0.2, z0: -HW, z1: HW },
  ];
  if (kind === 'end') out.push({ x0: x1 - 0.12, x1, y0: TRAM_FLOOR, y1: CEILING, z0: -HW, z1: HW });
  const half = TRAM_DOORS.width / 2;
  const doors = doorsOf(kind);
  for (const s of [1, -1] as const) {
    const [z0, z1] = s > 0 ? [HW - WALL, HW] : [-HW, -HW + WALL];
    const cuts = [x0, ...doors.flatMap((d) => [d - half, d + half]), x1].sort((p, q) => p - q);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const door = doors.some((d) => Math.abs((cuts[i] + cuts[i + 1]) / 2 - d) < half);
      out.push({ x0: cuts[i], x1: cuts[i + 1], y0: TRAM_FLOOR, y1: CEILING, z0, z1, ...(door ? { door: { side: s } } : {}) });
    }
    for (const d of doors) {
      const [sz0, sz1] = s > 0 ? [HW, HW + 0.35] : [-HW - 0.35, -HW];
      out.push({ x0: d - half, x1: d + half, y0: 0, y1: TRAM_FLOOR / 2, z0: sz0, z1: sz1, step: { side: s } });
    }
  }
  return out;
}

const FLOOR_PAINT = shaded(0x3a3f45);
const EDGE = shaded(0xe2b500);
const LINING = shaded(0xcfd2d4);
const CEILING_PAINT = shaded(0xe4e6e7);
const LIGHT = rgb(0xf4f1e6);
const POSTS = shaded(0x5c6166);
const SEAT = shaded(0x2b4170);
const SEAT_FRAME = shaded(0x8c9399);
const POLE = shaded(0xe2b500);
const BULKHEAD = shaded(0xb3b8bc);
const CAB_GLASS = rgb(0x1a1f23);

/**
 * A section's inside, from `x0` to `x1` (the cab's wall, in an end section): a dark floor with yellow edges at the
 * doors, the lining under the windows and over them, the ceiling with a strip of light down the middle, pairs of seats
 * facing each other between the doors, yellow poles by each door, and in an end section the wall to the cab.
 */
function inside(b: MeshBuilder, kind: 'end' | 'middle'): void {
  const hl = kind === 'end' ? END_HALF : MID_HALF;
  const x0 = -hl - TRAM_JOINT / 2;
  const x1 = kind === 'end' ? hl - NOSE : hl + TRAM_JOINT / 2;
  const w = HW - WALL;
  const doors = doorsOf(kind);
  const half = TRAM_DOORS.width / 2;
  const f = TRAM_FLOOR + 0.002;
  face(b, v(x0, f, -w), v(x1, f, -w), v(x1, f, w), v(x0, f, w), FLOOR_PAINT, v(0, 1, 0));
  // Yellow edges at the doorways, where the floor meets the step.
  for (const d of doors) for (const s of [1, -1]) face(b, v(d - half, f + 0.001, s * (w - 0.12)), v(d + half, f + 0.001, s * (w - 0.12)), v(d + half, f + 0.001, s * w), v(d - half, f + 0.001, s * w), EDGE, v(0, 1, 0));
  // The lining, facing in: under the sills and over the heads, none where the doors are.
  const cuts = [x0, ...doors.flatMap((d) => [d - half, d + half]), x1].sort((p, q) => p - q);
  for (const s of [1, -1]) {
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [xa, xb] = [cuts[i], cuts[i + 1]];
      const door = doors.some((d) => Math.abs((xa + xb) / 2 - d) < half);
      if (!door) {
        face(b, v(xa, TRAM_FLOOR, s * w), v(xb, TRAM_FLOOR, s * w), v(xb, SILL, s * w), v(xa, SILL, s * w), LINING, v(0, 0, -s));
        // The posts between the panes, as the outside has them (`side`).
        const n = Math.max(1, Math.round((xb - xa) / PANE));
        for (let k = 0; k <= n; k++) {
          const px = xa + ((xb - xa) * k) / n;
          face(b, v(px - POST / 2, SILL, s * (w - 0.01)), v(px + POST / 2, SILL, s * (w - 0.01)), v(px + POST / 2, HEAD, s * (w - 0.01)), v(px - POST / 2, HEAD, s * (w - 0.01)), POSTS, v(0, 0, -s));
        }
      }
      face(b, v(xa, door ? Math.min(HEAD, TRAM_FLOOR + TRAM_DOORS.height) : HEAD, s * w), v(xb, door ? Math.min(HEAD, TRAM_FLOOR + TRAM_DOORS.height) : HEAD, s * w), v(xb, CEILING, s * w), v(xa, CEILING, s * w), LINING, v(0, 0, -s));
    }
  }
  // The ceiling, and its light.
  face(b, v(x0, CEILING, -w), v(x1, CEILING, -w), v(x1, CEILING, w), v(x0, CEILING, w), CEILING_PAINT, v(0, -1, 0));
  for (const z of [-0.55, 0.55]) face(b, v(x0 + 0.3, CEILING - 0.01, z - 0.05), v(x1 - 0.3, CEILING - 0.01, z - 0.05), v(x1 - 0.3, CEILING - 0.01, z + 0.05), v(x0 + 0.3, CEILING - 0.01, z + 0.05), LIGHT, v(0, -1, 0));
  // Seats in the bays between the doors: two by two either side of the aisle, the rows facing each other.
  const bays = cuts.slice(0, -1).map((c, i) => [c, cuts[i + 1]] as const).filter(([a, z]) => !doors.some((d) => Math.abs((a + z) / 2 - d) < half));
  for (const [a, z] of bays) {
    const room = z - a - 0.6;
    const rows = Math.max(0, Math.floor(room / 0.75));
    for (let r = 0; r < rows; r++) {
      const x = a + 0.3 + 0.375 + r * 0.75;
      const facing = r < rows / 2 ? 1 : -1;
      for (const s of [1, -1]) {
        const zi = s * 0.45, zo = s * (w - 0.04);
        const [za, zb] = s > 0 ? [zi, zo] : [zo, zi];
        box(b, v(x - 0.22, TRAM_FLOOR + 0.05, za), v(x + 0.22, TRAM_FLOOR + 0.42, zb), SEAT_FRAME);
        box(b, v(x - 0.23, TRAM_FLOOR + 0.42, za), v(x + 0.23, TRAM_FLOOR + 0.5, zb), SEAT);
        const back = x - facing * 0.24;
        box(b, v(back - 0.05, TRAM_FLOOR + 0.5, za), v(back + 0.05, TRAM_FLOOR + 1.12, zb), SEAT);
      }
    }
  }
  // Poles by each door, from floor to ceiling.
  for (const d of doors) for (const s of [1, -1]) for (const e of [-1, 1]) {
    const px = d + e * (half + 0.12), pz = s * (w - 0.35);
    box(b, v(px - 0.02, TRAM_FLOOR, pz - 0.02), v(px + 0.02, CEILING, pz + 0.02), POLE);
  }
  if (kind === 'end') {
    // The wall to the cab, a dark window in it.
    const x = x1 - 0.12;
    face(b, v(x, TRAM_FLOOR, -w), v(x, TRAM_FLOOR, w), v(x, 1.25, w), v(x, 1.25, -w), BULKHEAD, v(-1, 0, 0));
    face(b, v(x, 1.25, -w), v(x, 1.25, -0.5), v(x, CEILING, -0.5), v(x, CEILING, -w), BULKHEAD, v(-1, 0, 0));
    face(b, v(x, 1.25, 0.5), v(x, 1.25, w), v(x, CEILING, w), v(x, CEILING, 0.5), BULKHEAD, v(-1, 0, 0));
    face(b, v(x, 2.05, -0.5), v(x, 2.05, 0.5), v(x, CEILING, 0.5), v(x, CEILING, -0.5), BULKHEAD, v(-1, 0, 0));
    face(b, v(x - 0.005, 1.25, -0.5), v(x - 0.005, 1.25, 0.5), v(x - 0.005, 2.05, 0.5), v(x - 0.005, 2.05, -0.5), CAB_GLASS, v(-1, 0, 0));
  }
}

/** A quad, turned so it faces `out`. */
function face(b: MeshBuilder, a: Vector3, c: Vector3, d: Vector3, e: Vector3, paint: Paint, out: Vector3): void {
  const n = new Vector3().subVectors(c, a).cross(new Vector3().subVectors(d, a));
  if (n.dot(out) >= 0) b.quad(a, c, d, e, paint);
  else b.quad(e, d, c, a, paint);
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** A box from `min` to `max`, its faces out. */
function box(b: MeshBuilder, min: Vector3, max: Vector3, paint: Paint): void {
  b.box(min, max, paint, [], 100);
}

/**
 * One side of a section, from `x0` to `x1` at `z` (`s`, 1 right or -1 left): blue under the windows, black posts and
 * dark glass between, cream above; dark doorways where the doors are. The glass goes to `glass`, lit apart at night.
 */
function side(b: MeshBuilder, glass: MeshBuilder, x0: number, x1: number, s: 1 | -1, doors: number[]): void {
  const z = s * HW;
  const out = v(0, 0, s);
  const wall = (xa: number, xb: number, ya: number, yb: number, paint: Paint) => face(b, v(xa, ya, z), v(xb, ya, z), v(xb, yb, z), v(xa, yb, z), paint, out);
  const half = TRAM_DOORS.width / 2;
  // A doorway reaches no higher than the windows' heads.
  const top = Math.min(HEAD, TRAM_FLOOR + TRAM_DOORS.height);
  // Breaks along the side at each door's edges.
  const cuts = [x0, ...doors.flatMap((d) => [d - half, d + half]).filter((x) => x > x0 && x < x1), x1].sort((p, q) => p - q);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [xa, xb] = [cuts[i], cuts[i + 1]];
    const door = doors.some((d) => Math.abs((xa + xb) / 2 - d) < half);
    wall(xa, xb, HEAD, EAVE, CREAM);
    if (door) {
      // The doorway itself is left open: the leaves close it, and an open door shows the inside.
      wall(xa, xb, FOOT, TRAM_FLOOR, BLUE);
      if (top < HEAD) wall(xa, xb, top, HEAD, BLACK);
      continue;
    }
    wall(xa, xb, FOOT, SILL, BLUE);
    wall(xa, xb, SILL, HEAD, BLACK);
    // The panes, a hair outside the wall.
    const n = Math.max(1, Math.round((xb - xa) / PANE));
    for (let k = 0; k < n; k++) {
      const pa = xa + ((xb - xa) * k) / n + POST / 2, pb = xa + ((xb - xa) * (k + 1)) / n - POST / 2;
      const zz = z + s * 0.004;
      face(glass, v(pa, SILL + 0.06, zz), v(pb, SILL + 0.06, zz), v(pb, HEAD - 0.06, zz), v(pa, HEAD - 0.06, zz), GLASS, out);
    }
  }
}

/** The roof over a section from `x0` to `x1`: the rounded edges and the top, cream, and the boxes on it. */
function roof(b: MeshBuilder, x0: number, x1: number): void {
  for (const s of [1, -1] as const) face(b, v(x0, EAVE, s * HW), v(x1, EAVE, s * HW), v(x1, ROOF, s * (HW - CHAMFER)), v(x0, ROOF, s * (HW - CHAMFER)), CREAM, v(0, 1, s));
  face(b, v(x0, ROOF, -(HW - CHAMFER)), v(x1, ROOF, -(HW - CHAMFER)), v(x1, ROOF, HW - CHAMFER), v(x0, ROOF, HW - CHAMFER), CREAM, v(0, 1, 0));
  // The equipment under its covers (converters, cooling), grey.
  const mid = (x0 + x1) / 2;
  box(b, v(mid - 1.7, ROOF, -0.85), v(mid + 1.7, TRAM_ROOF, 0.85), GREY);
}

/** The skirt's underside and a bogie under the middle, dark. */
function under(b: MeshBuilder, x0: number, x1: number): void {
  face(b, v(x0, FOOT, -HW), v(x1, FOOT, -HW), v(x1, FOOT, HW), v(x0, FOOT, HW), UNDER, v(0, -1, 0));
  box(b, v(-1.1, 0.06, -1.05), v(1.1, FOOT, 1.05), UNDER);
}

/** A section's end at `x` where the bellows meet it: a dark face. */
function joint(b: MeshBuilder, x: number, out: number): void {
  face(b, v(x, FOOT, -HW), v(x, FOOT, HW), v(x, EAVE, HW), v(x, EAVE, -HW), BELLOWS, v(out, 0, 0));
  face(b, v(x, EAVE, -HW), v(x, EAVE, HW), v(x, ROOF, HW - CHAMFER), v(x, ROOF, -(HW - CHAMFER)), BELLOWS, v(out, 0, 0));
}

/**
 * The cab at +x: rings round the nose from the skirt to the roof, each its front's distance in from `END_HALF`, how far
 * its corners are rounded and its half width; between each two a band: blue under the lamps, a black lip, the
 * windscreen (glass), the cream cap with the display, the roof's edge.
 */
function cab(b: MeshBuilder, glass: MeshBuilder): void {
  const back = END_HALF - NOSE;
  const rings = [
    { y: FOOT, x: END_HALF, c: 0.45, w: HW },
    { y: 1.0, x: END_HALF, c: 0.45, w: HW },
    { y: 1.08, x: END_HALF - 0.03, c: 0.42, w: HW },
    { y: 2.45, x: END_HALF - 0.4, c: 0.32, w: HW },
    { y: EAVE, x: END_HALF - 0.5, c: 0.3, w: HW },
    { y: ROOF, x: END_HALF - 0.7, c: 0.38, w: HW - CHAMFER },
  ];
  const bands: Array<{ paint: Paint; to: MeshBuilder }> = [
    { paint: BLUE, to: b }, { paint: BLACK, to: b }, { paint: GLASS, to: glass }, { paint: CREAM, to: b }, { paint: CREAM, to: b },
  ];
  const outline = (r: (typeof rings)[number]) => [
    v(back, r.y, -r.w), v(r.x - r.c, r.y, -r.w), v(r.x, r.y, -r.w + r.c), v(r.x, r.y, r.w - r.c), v(r.x - r.c, r.y, r.w), v(back, r.y, r.w),
  ];
  for (let i = 0; i + 1 < rings.length; i++) {
    const lo = outline(rings[i]), hi = outline(rings[i + 1]);
    for (let k = 0; k + 1 < lo.length; k++) {
      const mid = lo[k].clone().add(lo[k + 1]).add(hi[k]).add(hi[k + 1]).multiplyScalar(0.25);
      face(bands[i].to, lo[k], lo[k + 1], hi[k + 1], hi[k], bands[i].paint, mid.sub(v(back - 3, 1.7, 0)));
    }
  }
  // The roof over the nose.
  const top = outline(rings[rings.length - 1]);
  for (let k = 1; k + 1 < top.length; k++) {
    const n = new Vector3().subVectors(top[k], top[0]).cross(new Vector3().subVectors(top[k + 1], top[0]));
    if (n.y >= 0) b.tri(top[0], top[k], top[k + 1], CREAM);
    else b.tri(top[0], top[k + 1], top[k], CREAM);
  }
  // Underneath, the skirt's foot.
  const foot = outline(rings[0]);
  for (let k = 1; k + 1 < foot.length; k++) {
    const n = new Vector3().subVectors(foot[k], foot[0]).cross(new Vector3().subVectors(foot[k + 1], foot[0]));
    if (n.y <= 0) b.tri(foot[0], foot[k], foot[k + 1], UNDER);
    else b.tri(foot[0], foot[k + 1], foot[k], UNDER);
  }
}

/** A thin bar from `a` to `b`, `t` thick, into `out`. */
function bar(out: MeshBuilder, a: Vector3, b: Vector3, t: number, paint: Paint): void {
  const geo = new BoxGeometry(a.distanceTo(b), t, t);
  // A basis with x along the bar, y and z any two at right angles to it.
  const x = new Vector3().subVectors(b, a).normalize();
  const y = Math.abs(x.y) < 0.99 ? new Vector3(0, 1, 0).sub(x.clone().multiplyScalar(x.y)).normalize() : new Vector3(1, 0, 0);
  const m = new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y)).setPosition(a.clone().add(b).multiplyScalar(0.5));
  out.geometry(geo, m, paint);
  geo.dispose();
}

let model: TramModel | null = null;

/** The M34's geometries, built the first time they are asked for and shared by every tram. */
export function tramModel(): TramModel {
  if (model) return model;
  // An end section: its side from the joint to the cab, the cab, the roof, the underside, its joint end.
  const end = new MeshBuilder(), endGlass = new MeshBuilder();
  const endDoors = doorsOf('end');
  for (const s of [1, -1] as const) side(end, endGlass, -END_HALF, END_HALF - NOSE, s, endDoors);
  roof(end, -END_HALF, END_HALF - NOSE);
  under(end, -END_HALF, END_HALF - NOSE);
  joint(end, -END_HALF, -1);
  cab(end, endGlass);
  // A middle section: two sides, roof, underside, a joint at each end.
  const middle = new MeshBuilder(), middleGlass = new MeshBuilder();
  const midDoors = doorsOf('middle');
  for (const s of [1, -1] as const) side(middle, middleGlass, -MID_HALF, MID_HALF, s, midDoors);
  roof(middle, -MID_HALF, MID_HALF);
  under(middle, -MID_HALF, MID_HALF);
  joint(middle, -MID_HALF, -1);
  joint(middle, MID_HALF, 1);
  // A door leaf: dark glass in a black frame, as thick as a door.
  const leaf = new MeshBuilder();
  const lw = TRAM_DOORS.width / 2, lh = TRAM_DOORS.height;
  box(leaf, v(-lw / 2, -lh / 2, -LEAF_T / 2), v(lw / 2, lh / 2, LEAF_T / 2), BLACK);
  face(leaf, v(-lw / 2 + 0.07, -lh / 2 + 0.5, LEAF_T / 2 + 0.003), v(lw / 2 - 0.07, -lh / 2 + 0.5, LEAF_T / 2 + 0.003), v(lw / 2 - 0.07, lh / 2 - 0.08, LEAF_T / 2 + 0.003), v(-lw / 2 + 0.07, lh / 2 - 0.08, LEAF_T / 2 + 0.003), DOOR_GLASS, v(0, 0, 1));
  face(leaf, v(-lw / 2 + 0.07, -lh / 2 + 0.08, LEAF_T / 2 + 0.003), v(lw / 2 - 0.07, -lh / 2 + 0.08, LEAF_T / 2 + 0.003), v(lw / 2 - 0.07, -lh / 2 + 0.42, LEAF_T / 2 + 0.003), v(-lw / 2 + 0.07, -lh / 2 + 0.42, LEAF_T / 2 + 0.003), BLUE, v(0, 0, 1));
  // The bellows: dark, a little narrower and lower than the car, long enough to close the gap.
  const bellows = new MeshBuilder();
  box(bellows, v(-TRAM_JOINT / 2 - 0.05, FOOT + 0.05, -(HW - 0.1)), v(TRAM_JOINT / 2 + 0.05, ROOF - 0.08, HW - 0.1), BELLOWS);
  // And from inside, walking through: its walls and ceiling facing in, the turntable's plate on the floor.
  const j = TRAM_JOINT / 2 + 0.05, jw = HW - WALL - 0.02;
  for (const s of [1, -1]) face(bellows, v(-j, TRAM_FLOOR, s * jw), v(j, TRAM_FLOOR, s * jw), v(j, CEILING, s * jw), v(-j, CEILING, s * jw), BELLOWS, v(0, 0, -s));
  face(bellows, v(-j, CEILING - 0.01, -jw), v(j, CEILING - 0.01, -jw), v(j, CEILING - 0.01, jw), v(-j, CEILING - 0.01, jw), BELLOWS, v(0, -1, 0));
  face(bellows, v(-j, TRAM_FLOOR + 0.004, -jw), v(j, TRAM_FLOOR + 0.004, -jw), v(j, TRAM_FLOOR + 0.004, jw), v(-j, TRAM_FLOOR + 0.004, jw), SEAT_FRAME, v(0, 1, 0));
  // The pantograph, one arm with a knee, its bow at the wire.
  const panto = new MeshBuilder();
  const base = ROOF + 0.3;
  box(panto, v(-0.75, ROOF, -0.6), v(0.75, base - 0.08, 0.6), GREY);
  box(panto, v(-0.8, base - 0.08, -0.65), v(0.8, base, 0.65), BLACK);
  const knee = v(0.75, (base + TRAM_WIRE) / 2, 0), foot = v(-0.6, base, 0), head = v(-0.15, TRAM_WIRE - 0.06, 0);
  bar(panto, foot, knee, 0.07, BLACK);
  bar(panto, knee, head, 0.05, BLACK);
  bar(panto, v(-0.15, TRAM_WIRE - 0.04, -0.85), v(-0.15, TRAM_WIRE - 0.04, 0.85), 0.05, GREY);
  // The lamps at the cab: two under the windscreen and one over the display, white (tinted per tram, head or tail).
  const lamps = new MeshBuilder();
  for (const s of [1, -1]) face(lamps, v(END_HALF + 0.004, 0.68, s * 0.62), v(END_HALF + 0.004, 0.68, s * 1.0), v(END_HALF + 0.004, 0.82, s * 1.0), v(END_HALF + 0.004, 0.82, s * 0.62), GLASS, v(1, 0, 0));
  // The signs: the display on the cab's cap, leaning back with it, and one on each side above the first windows.
  const cap = { y0: 2.47, y1: EAVE - 0.03, x0: END_HALF - 0.4, x1: END_HALF - 0.5 };
  const lean = Math.atan2(cap.x0 - cap.x1, EAVE - 2.45);
  const front = new Matrix4().makeTranslation((cap.x0 + cap.x1) / 2 + 0.012, (cap.y0 + cap.y1) / 2, 0)
    .multiply(new Matrix4().makeRotationY(Math.PI / 2))
    .multiply(new Matrix4().makeRotationX(-lean))
    .multiply(new Matrix4().makeScale(1.9, cap.y1 - cap.y0, 1));
  const signs = [front];
  for (const s of [1, -1]) {
    signs.push(new Matrix4().makeTranslation(END_HALF - NOSE - 1.0, (HEAD + EAVE) / 2, s * (HW + 0.006))
      .multiply(new Matrix4().makeRotationY(s > 0 ? 0 : Math.PI))
      .multiply(new Matrix4().makeScale(1.3, 0.24, 1)));
  }
  const endInside = new MeshBuilder(), middleInside = new MeshBuilder();
  inside(endInside, 'end');
  inside(middleInside, 'middle');
  // The display over the aisle in front of the cab's wall, facing back down the car.
  const display = new Matrix4().makeTranslation(END_HALF - NOSE - 0.14, CEILING - 0.2, 0)
    .multiply(new Matrix4().makeRotationY(-Math.PI / 2))
    .multiply(new Matrix4().makeScale(1.2, 0.22, 1));
  model = {
    end: end.build(), endGlass: endGlass.build(), middle: middle.build(), middleGlass: middleGlass.build(),
    leaf: leaf.build(), bellows: bellows.build(), pantograph: panto.build(), lamps: lamps.build(), signs,
    endInside: endInside.build(), middleInside: middleInside.build(), display,
  };
  return model;
}
