// The city's landmarks that its map data does not give: Kopparmärra, Karl IX on horseback at Kungsportsplatsen (John
// Börjeson's statue of 1904, copper gone green, on a granite plinth), where OpenStreetMap has it. Built once, a baked
// outdoor section like the squares.

import { BoxGeometry, Matrix4, Vector3 } from 'three';
import type { MeshBuilder, Paint } from '../gfx/builder';
import { rgb } from '../gfx/color';
import type { Physics, StaticCollider } from '../physics';
import { Section } from '../world/section';
import { PLACES, STREET_Y, toGame, type Pt } from './geo';

const GRANITE = rgb(0xb9b6ae);
const GRANITE_DARK = rgb(0x8f8c85);
/** Copper gone green, and its darker hollows. */
const COPPER = rgb(0x5e9c86);
const COPPER_DARK = rgb(0x3f6f5f);

/** Kopparmärra's plinth, where OpenStreetMap has it (`Karl IX:s ryttarstaty`), facing the square's tram stop. */
const STATUE: Pt = toGame(57.7045094, 11.9696082);

/** A box `size` big (along x, up, across), its middle at `at` in the statue's frame, turned `tilt` about its across axis. */
function part(b: MeshBuilder, frame: Matrix4, at: [number, number, number], size: [number, number, number], paint: Paint, tilt = 0): void {
  const geo = new BoxGeometry(...size);
  const m = frame.clone().multiply(new Matrix4().makeTranslation(...at)).multiply(new Matrix4().makeRotationZ(tilt));
  b.geometry(geo, m, paint);
  geo.dispose();
}

export class Landmarks {
  readonly group;
  readonly colliders: StaticCollider[] = [];

  constructor(physics: Physics) {
    const s = new Section('landmarks', rgb(0x4a4a4a), false, true);
    const [x, z] = STATUE;
    const [tx, tz] = PLACES.Kungsportsplatsen;
    // The statue's frame: on the street at its plinth, +x the way the horse walks.
    const yaw = Math.atan2(-(tz - z), tx - x);
    const frame = new Matrix4().makeRotationY(yaw).setPosition(x, STREET_Y, z);
    // The plinth: a step, the block with its moulding, and its cap.
    part(s.lit, frame, [0, 0.2, 0], [5.4, 0.4, 3.2], GRANITE_DARK);
    part(s.lit, frame, [0, 1.9, 0], [4.6, 3.0, 2.4], GRANITE);
    part(s.lit, frame, [0, 3.5, 0], [5.0, 0.2, 2.8], GRANITE_DARK);
    const top = 3.6;
    // The rider and horse, a third larger than life over the plinth's top, as the real one stands.
    const bronze = frame.clone().multiply(new Matrix4().makeTranslation(0, top, 0)).multiply(new Matrix4().makeScale(1.35, 1.35, 1.35)).multiply(new Matrix4().makeTranslation(0, -top, 0));
    // The horse, walking, its near fore raised: body, chest, neck and head, legs, tail.
    part(s.lit, bronze, [0, top + 1.55, 0], [2.4, 0.95, 0.85], COPPER);
    part(s.lit, bronze, [1.15, top + 1.65, 0], [0.6, 0.9, 0.8], COPPER);
    part(s.lit, bronze, [1.55, top + 2.25, 0], [0.45, 1.0, 0.45], COPPER, -0.55);
    part(s.lit, bronze, [1.95, top + 2.6, 0], [0.75, 0.32, 0.32], COPPER, 0.6);
    for (const [lx, lz, lift] of [[0.95, -0.28, 0], [0.95, 0.28, 0.5], [-0.95, -0.28, 0], [-0.95, 0.28, 0]] as const) {
      part(s.lit, bronze, [lx + lift * 0.25, top + 0.55 + lift * 0.35, lz], [0.18, lift ? 0.85 : 1.15, 0.18], COPPER_DARK, lift ? 0.9 : 0);
    }
    part(s.lit, bronze, [-1.35, top + 1.3, 0], [0.18, 0.95, 0.16], COPPER_DARK, -0.25);
    // Karl IX in the saddle: legs astride, body, head and hat, his right arm out with the baton.
    for (const lz of [-0.46, 0.46]) part(s.lit, bronze, [0.1, top + 1.45, lz], [0.6, 0.75, 0.18], COPPER_DARK, 0.4);
    part(s.lit, bronze, [0, top + 2.5, 0], [0.55, 1.1, 0.6], COPPER);
    part(s.lit, bronze, [0.05, top + 3.2, 0], [0.32, 0.36, 0.3], COPPER);
    part(s.lit, bronze, [0.05, top + 3.45, 0], [0.5, 0.12, 0.5], COPPER_DARK);
    part(s.lit, bronze, [0.45, top + 2.75, 0.4], [0.75, 0.14, 0.14], COPPER, 0.35);
    // Solid: the plinth.
    const c = new Vector3(x, STREET_Y, z);
    this.colliders.push(physics.turnedBox({ x: c.x, y: STREET_Y + 1.8, z: c.z }, { x: 2.7, y: 1.8, z: 1.6 }, yaw));
    this.group = s.finish();
  }
}
