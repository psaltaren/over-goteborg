/**
 * Gothenburg's tram tracks as a graph trams can run on, from OpenStreetMap's `railway=tram` ways (© OpenStreetMap
 * contributors, ODbL). Used by `scripts/gbg-osm.ts`, which fetches the ways and writes the result.
 *
 * 1. Links. Gothenburg's tracks are drawn one way each (`oneway=yes` on nearly all of them, right-hand running), so
 *    every way is a directed track; the few without are run both ways. A link runs from one junction (a switch, a
 *    crossing, an end) to the next, and is cut where it leaves the area kept.
 * 2. Turns. At a junction a tram may go on from one link to another where the track turns less than `MAX_TURN`.
 * 3. Switch toes. OSM draws a diverging track leaving at an angle, often from a node already well into the curve; the
 *    street's leaves along the through track from the switch's toe, a few meters before, and curves away. Where the
 *    angle is large, the toe is moved back along the through track (`toes`), and a merge the same way round.
 * 4. Spacing. Double track OSM draws tighter than `SPACING` is moved apart to it, away from the junctions at its ends.
 * 5. Easing. The whole network as one smoothing spline (`easeAll`): kept as OSM has it except where a curve, along a
 *    track or through a junction, is tighter than `MIN_RADIUS`, and opened out there. Junctions the fixes accept as
 *    tighter are listed with their reasons in `scripts/gbg-track-fixes.ts`.
 * 6. Blocks. Every track is cut into blocks of at most `BLOCK` meters, one tram per block, and blocks on two tracks that
 *    come closer than `CLEAR` (a switch, a crossing) conflict: a tram in one keeps every other tram out of the other.
 *    Pairs rather than one block per junction, so trams pass side by side through Drottningtorget and Brunnsparken
 *    wherever their paths do not touch, as they do in the street.
 */
import type { Pt, Rect } from '../src/game/city/geo';
import { TRAM_TRACK_SPACING, TRAM_WIDTH } from '../src/game/layout';
import { CHORD, MIN_RADIUS, curveAt, endDir, pointAt, polylineLength, prevsOf, radius, resample, startDir, turn, type Block, type Link, type Stop } from '../src/game/city/trackData';
import type { TrackFixes } from './gbg-track-fixes';
import { clipLine } from './osm-layers';
import type { El } from './osm-lib';

/** The sharpest turn from one track to the next at a junction, in degrees. */
const MAX_TURN = 45;
/**
 * Two tracks closer than this, centre to centre, cannot both hold a tram: a car's width (`layout.ts`). OSM draws most
 * double track 3.1 to 3.6 m apart, but a kilometer or so a little tighter, so a wider margin would join every junction
 * along those stretches into one.
 */
const CLEAR = TRAM_WIDTH;
/** Double track drawn tighter than this is moved apart to it, and kept there through the easing (`layout.ts`). */
const SPACING = TRAM_TRACK_SPACING;
/** How strongly the easing keeps two tracks run opposite ways as far apart as `separate` left them. */
const KEEP_APART = 50;
/**
 * Within this far of a junction, double track is left as OSM draws it: tracks close in, cross and change sides there
 * (Drottningtorget, Järntorget), and spacing them would move the switches.
 */
const NEAR_JUNCTION = 15;
/** Blocks are at most this long: short, so a tram can follow close behind another, as at a busy stop. */
const BLOCK = 10;
/** Curves are eased to a little more than the least radius, so rounding to centimeters cannot take them under it. */
const EASE_TO = MIN_RADIUS * 1.06;
/** How strongly the easing draws a bend to the radius it aims for (`easeAll`), against a point's pull of 1 toward OSM. */
const BEND = 400;
/** A diverging or merging track that meets its switch at more than this angle gets its toe moved (`toes`). */
const KNEE = 8;
/** How far the toe may be moved, and how far the new curve may then lie from the track as OSM draws it. */
const TOE_REACH = 30;
const TOE_OFF = 1.5;
/**
 * Junctions made by moving a toe are numbered `TOE_NODE` times the toes moved from that node so far plus the node,
 * clear of OSM's node ids and the same from one build to the next as long as OSM is.
 */
const TOE_NODE = 1e12;
/** How far a stop node may lie from the track and still be put on it: the plan's 3 m. */
const STOP_REACH = 3;

type Way = El & { nodes: number[] };

export interface Built {
  links: Link[];
  stops: Stop[];
  blocks: Block[];
  conflicts: Array<[number, number]>;
  /** What was done and what looks wrong, for the script to print. */
  report: string[];
}

const unit = (a: Pt): Pt => {
  const d = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / d, a[1] / d];
};
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The distance from a point to a polyline, and how far along it the nearest point lies. */
export function project(pts: Pt[], p: Pt): { d: number; s: number } {
  let best = { d: Infinity, s: 0 };
  let along = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / len2)) : 0;
    const d = Math.hypot(ax + dx * t - p[0], az + dz * t - p[1]);
    if (d < best.d) best = { d, s: along + t * Math.sqrt(len2) };
    along += Math.sqrt(len2);
  }
  return best;
}

export function buildTracks(els: El[], toGame: (lat: number, lon: number) => Pt, keep: Rect, fixes: TrackFixes): Built {
  const report: string[] = [];
  const ways = els.filter((e): e is Way => e.type === 'way' && e.tags?.railway === 'tram' && !!e.geometry && Array.isArray((e as Way).nodes) && !fixes.drop.includes(e.id));

  // ---- 1. Directed segments, and the links between junctions. ----
  const pos = new Map<number, Pt>();
  const outs = new Map<number, Array<{ to: number; way: number }>>();
  const ins = new Map<number, number>();
  const near = new Map<number, Set<number>>();
  const directionOf = (w: Way): 1 | -1 | 0 => {
    if (w.id in fixes.direction) return fixes.direction[w.id];
    const o = w.tags?.oneway;
    return o === 'yes' || o === 'true' || o === '1' ? 1 : o === '-1' ? -1 : 0;
  };
  let twoWay = 0;
  for (const w of ways) {
    w.nodes.forEach((n, i) => pos.set(n, toGame(w.geometry![i].lat, w.geometry![i].lon)));
    const dir = directionOf(w);
    if (dir === 0) twoWay++;
    for (let i = 0; i + 1 < w.nodes.length; i++) {
      const a = w.nodes[i], b = w.nodes[i + 1];
      if (a === b) continue;
      for (const [p, q] of [[a, b], [b, a]]) {
        if (!near.has(p)) near.set(p, new Set());
        near.get(p)!.add(q);
      }
      const seg = (p: number, q: number) => {
        if (!outs.has(p)) outs.set(p, []);
        outs.get(p)!.push({ to: q, way: w.id });
        ins.set(q, (ins.get(q) ?? 0) + 1);
      };
      if (dir >= 0) seg(a, b);
      if (dir <= 0) seg(b, a);
    }
  }
  const junction = (n: number) => (near.get(n)?.size ?? 0) !== 2 || (ins.get(n) ?? 0) !== (outs.get(n)?.length ?? 0);
  const walked = new Set<string>();
  const raw: Array<{ nodes: number[]; ways: number[] }> = [];
  const walk = (a: number, first: { to: number; way: number }) => {
    const nodes = [a, first.to];
    const wayList = [first.way];
    walked.add(`${a}>${first.to}`);
    let prev = a, cur = first.to;
    while (!junction(cur) && cur !== a) {
      const on = (outs.get(cur) ?? []).filter((s) => s.to !== prev);
      if (on.length !== 1 || walked.has(`${cur}>${on[0].to}`)) break;
      walked.add(`${cur}>${on[0].to}`);
      nodes.push(on[0].to);
      if (wayList[wayList.length - 1] !== on[0].way) wayList.push(on[0].way);
      prev = cur;
      cur = on[0].to;
    }
    raw.push({ nodes, ways: wayList });
  };
  for (const [n, list] of outs) if (junction(n)) for (const s of list) if (!walked.has(`${n}>${s.to}`)) walk(n, s);
  // Loops with no junction on them.
  for (const [n, list] of outs) for (const s of list) if (!walked.has(`${n}>${s.to}`)) walk(n, s);

  // ---- Cut to the area kept. ----
  const inside = ([x, z]: Pt) => x >= keep.x0 && x <= keep.x1 && z >= keep.z0 && z <= keep.z1;
  type Raw = { ways: number[]; from: number; to: number; pts: Pt[]; nodes: number[] };
  const cut: Raw[] = [];
  for (const r of raw) {
    const pts = r.nodes.map((n) => pos.get(n)!);
    const startIn = inside(pts[0]), endIn = inside(pts[pts.length - 1]);
    const parts = clipLine(pts, keep.x0, keep.x1, keep.z0, keep.z1);
    parts.forEach((part, k) => {
      if (polylineLength(part) < 0.5) return;
      cut.push({
        ways: r.ways,
        from: k === 0 && startIn ? r.nodes[0] : -1,
        to: k === parts.length - 1 && endIn ? r.nodes[r.nodes.length - 1] : -1,
        pts: part,
        nodes: r.nodes,
      });
    });
  }
  const links: Link[] = cut.map((c, id) => {
    const pts = resample(c.pts, 1);
    return { id, ways: c.ways, from: c.from, to: c.to, twin: null, next: [], length: polylineLength(pts), pts };
  });
  // The same track both ways: the reverse of another link, point for point.
  for (const a of links) {
    if (a.twin !== null) continue;
    const b = links.find((l) => l !== a && l.twin === null && l.pts.length === a.pts.length && l.pts.every((p, i) => dist(p, a.pts[a.pts.length - 1 - i]) < 0.01));
    if (b) {
      a.twin = b.id;
      b.twin = a.id;
    }
  }
  // Each way as OSM draws it, to measure how far the easing moves the track from it.
  const drawn = new Map(ways.map((w) => [w.id, w.geometry!.map((g) => toGame(g.lat, g.lon))]));

  // ---- 2. Turns. ----
  const forbidden = new Set(fixes.forbid.map(([a, b]) => `${a}>${b}`));
  for (const a of links) {
    if (a.to < 0) continue;
    for (const b of links) {
      if (b.from !== a.to || b.id === a.twin || forbidden.has(`${a.ways[a.ways.length - 1]}>${b.ways[0]}`)) continue;
      if (turn(endDir(a.pts), startDir(b.pts)) <= MAX_TURN) a.next.push(b.id);
    }
  }
  // ---- 3. Switch toes moved back where OSM puts the switch in the curve. ----
  const moved = toes(links);
  if (moved) report.push(`moved the toe of ${moved} switches back along the through track`);
  const prevs = prevsOf(links);

  // ---- 4. Double track moved apart where drawn too tight. ----
  const spread = separate(links);
  if (spread.meters) report.push(`moved ${spread.meters} m of double track apart to ${SPACING} m, at most ${spread.most.toFixed(2)} m`);

  // ---- 5. Easing: the whole network as one smoothing spline. ----
  const tight = easeAll(links, prevs, fixes.tight);
  const close = closeOpposite(links);
  if (close.meters) report.push(`WARN ${close.meters} m of track lies closer than ${CLEAR} m to a track run the other way (at most ${close.least.toFixed(2)} m, at ${close.at.map(Math.round).join(', ')})`);
  if (tight.length) report.push(`WARN ${tight.length} places still curve tighter than ${MIN_RADIUS} m (${tight.slice(0, 6).join('; ')}): fix them in scripts/gbg-track-fixes.ts`);
  // How far the track now lies from the ways it was drawn from, as OSM draws them.
  let off = 0, offAt: Pt = [0, 0];
  for (const l of links) {
    const own = l.ways.map((id) => drawn.get(id)!).filter(Boolean);
    for (const p of l.pts) {
      const d = Math.min(...own.map((q) => project(q, p).d));
      if (d > off) [off, offAt] = [d, p];
    }
  }
  report.push(`easing moved the track at most ${off.toFixed(1)} m from OSM (at ${offAt.map((v) => v.toFixed(0)).join(', ')})`);

  // ---- 6. Blocks. ----
  const { blocks, conflicts } = cutBlocks(links);

  // ---- Stops. ----
  const stops: Stop[] = [];
  let away = 0;
  for (const e of els) {
    if (e.type !== 'node' || e.tags?.railway !== 'tram_stop' || !e.tags.name) continue;
    const p = toGame(e.lat!, e.lon!);
    if (!inside(p)) continue;
    // On the nearest link drawn from a way through the node (and its twin, a track run both ways), else the nearest
    // track. By way rather than by node: moving a switch's toe makes links no OSM node list knows.
    const through = new Set(ways.filter((w) => w.nodes.includes(e.id)).map((w) => w.id));
    const on = links.filter((l) => l.ways.some((w) => through.has(w)));
    const best = (on.length ? on : links).map((l) => ({ l, ...project(l.pts, p) })).sort((a, b) => a.d - b.d)[0];
    if (!best || best.d > STOP_REACH) {
      away++;
      continue;
    }
    const r2 = (v: number) => Math.round(v * 100) / 100;
    stops.push({ name: e.tags.name, osm: e.id, link: best.l.id, s: r2(best.s), off: r2(best.d) });
    if (best.l.twin !== null) stops.push({ name: e.tags.name, osm: e.id, link: best.l.twin, s: r2(best.l.length - best.s), off: r2(best.d) });
  }
  if (away) report.push(`WARN ${away} tram stops lie more than ${STOP_REACH} m from any track`);

  report.unshift(`${ways.length} ways (${twoWay} run both ways), ${links.length} links, ${(links.reduce((s, l) => s + l.length, 0) / 1000).toFixed(1)} km of track one way, ` +
    `${links.filter((l) => l.next.length > 1).length} diverging switches, ${blocks.length} blocks with ${conflicts.length} conflicts between them, ${stops.length} stops`);
  return { links, stops, blocks, conflicts, report };
}

/**
 * Switches whose diverging (or merging) track meets them at an angle, as OSM draws many, get their toe moved back
 * along the through track: the through link is cut a few meters before the junction, and the diverging track starts
 * there instead, along the through track, curving (a cubic Hermite) into the track as OSM has it. The shortest move
 * that gives a curve no tighter than `EASE_TO` and within `TOE_OFF` of OSM's track is taken. A merge is the same the
 * other way round. Returns how many were moved. Tracks run both ways are left as they are.
 */
function toes(links: Link[]): number {
  let moved = 0;
  const into = (id: number) => links.filter((l) => l.next.includes(id));
  const fromNode = new Map<number, number>();
  /**
   * A toe moved back from junction `node`: numbered from the OSM node it comes from in the end (a toe moved from a toe
   * counts with its node's), so each id is used once and the same toe gets the same id each build.
   */
  const toeNode = (node: number) => {
    const base = node % TOE_NODE;
    const k = (fromNode.get(base) ?? 0) + 1;
    fromNode.set(base, k);
    return TOE_NODE * k + base;
  };
  const hermite = (a: Pt, ta: Pt, b: Pt, tb: Pt): Pt[] => {
    const m = dist(a, b);
    const steps = Math.max(4, Math.round(m));
    const out: Pt[] = [];
    for (let j = 0; j <= steps; j++) {
      const u = j / steps, u2 = u * u, u3 = u2 * u;
      const [h00, h10, h01, h11] = [2 * u3 - 3 * u2 + 1, u3 - 2 * u2 + u, -2 * u3 + 3 * u2, u3 - u2];
      out.push([h00 * a[0] + h10 * m * ta[0] + h01 * b[0] + h11 * m * tb[0], h00 * a[1] + h10 * m * ta[1] + h01 * b[1] + h11 * m * tb[1]]);
    }
    return out;
  };
  const dirAt = (pts: Pt[], s: number): Pt => {
    const a = pointAt(pts, Math.max(0, s - 1)), b = pointAt(pts, Math.min(polylineLength(pts), s + 1));
    return unit([b[0] - a[0], b[1] - a[1]]);
  };
  const smooth = (curve: Pt[], before: Pt[], after: Pt[]) => {
    const joined = resample([...before, ...curve, ...after], 1);
    for (let i = 1; i + 1 < joined.length; i++) {
      if (radius(joined[Math.max(0, i - CHORD)], joined[i], joined[Math.min(joined.length - 1, i + CHORD)]) < EASE_TO) return false;
    }
    return true;
  };
  /** The first fit found: a toe `x` meters off the junction on `along`, joining `onto` `k` meters off it. */
  const fit = (along: Pt[], onto: Pt[]) => {
    const la = polylineLength(along), lo = polylineLength(onto);
    const osm = [...along, ...onto];
    for (let x = 2; x <= Math.min(TOE_REACH, la - 4); x += 1) {
      const T = pointAt(along, la - x), tT = dirAt(along, la - x);
      for (let k = 3; k <= Math.min(TOE_REACH + 10, lo - 2); k += 1) {
        const P = pointAt(onto, k), tP = dirAt(onto, k);
        const curve = hermite(T, tT, P, tP);
        if (curve.some((q) => project(osm, q).d > TOE_OFF)) continue;
        if (!smooth(curve, [pointAt(along, la - x - CHORD)], [pointAt(onto, k + CHORD)])) continue;
        return { x, k, curve };
      }
    }
    return null;
  };
  const cutAt = (pts: Pt[], s: number): [Pt[], Pt[]] => {
    const length = polylineLength(pts);
    const head = resample([...pts.filter((_, i) => i === 0 || polylineLength(pts.slice(0, i + 1)) < s), pointAt(pts, s)], 1);
    const tail = resample([pointAt(pts, s), ...pts.filter((_, i) => polylineLength(pts.slice(0, i + 1)) > s)], 1);
    return length - s < 1e-6 ? [pts, [pts[pts.length - 1]]] : [head, tail];
  };
  const fresh = (l: Omit<Link, 'id' | 'length'>): Link => {
    const link = { ...l, id: links.length, length: polylineLength(l.pts) };
    links.push(link);
    return link;
  };
  for (const o of [...links]) {
    // A diverging track: one link leads into it, and it is not that link's straightest way on.
    const leads = into(o.id);
    if (o.twin !== null || leads.length !== 1) continue;
    const i = leads[0];
    if (i.twin !== null || i.next.length < 2 || turn(endDir(i.pts), startDir(o.pts, 3)) <= KNEE) continue;
    const straight = i.next.map((id) => ({ id, t: turn(endDir(i.pts), startDir(links[id].pts)) })).sort((p, q) => p.t - q.t)[0].id;
    if (straight === o.id) continue;
    const f = fit(i.pts, o.pts);
    if (!f) continue;
    const node = toeNode(i.to);
    const [head, tail] = cutAt(i.pts, i.length - f.x);
    const rest = i.next.filter((id) => id !== o.id);
    // Which of the through link's ways its tail runs along is not kept, so it takes them all.
    const b = fresh({ ways: [...i.ways], from: node, to: i.to, twin: null, next: rest, pts: tail });
    i.pts = head;
    i.length = polylineLength(head);
    i.to = node;
    i.next = [b.id, o.id];
    const [, after] = cutAt(o.pts, f.k);
    o.pts = resample([...f.curve, ...after.slice(1)], 1);
    o.length = polylineLength(o.pts);
    o.from = node;
    // It now sets off along the through track's last way.
    if (!o.ways.includes(i.ways[i.ways.length - 1])) o.ways = [i.ways[i.ways.length - 1], ...o.ways];
    moved++;
  }
  for (const i of [...links]) {
    // A merging track: it leads into one link only, and is not that link's straightest way in.
    if (i.twin !== null || i.next.length !== 1) continue;
    const o = links[i.next[0]];
    const from = into(o.id);
    if (o.twin !== null || from.length < 2 || turn(endDir(i.pts, 3), startDir(o.pts)) <= KNEE) continue;
    const straight = from.map((l) => ({ id: l.id, t: turn(endDir(l.pts), startDir(o.pts)) })).sort((p, q) => p.t - q.t)[0].id;
    if (straight === i.id) continue;
    // The same fit, the tracks taken backwards.
    const f = fit([...o.pts].reverse(), [...i.pts].reverse());
    if (!f) continue;
    const node = toeNode(o.from);
    const [head, tail] = cutAt(o.pts, f.x);
    const a = fresh({ ways: [...o.ways], from: o.from, to: node, twin: null, next: [o.id], pts: head });
    for (const l of from) if (l.id !== i.id) l.next = l.next.map((id) => (id === o.id ? a.id : id));
    o.pts = tail;
    o.length = polylineLength(tail);
    o.from = node;
    const [before] = cutAt(i.pts, i.length - f.k);
    i.pts = resample([...before.slice(0, -1), ...[...f.curve].reverse()], 1);
    i.length = polylineLength(i.pts);
    i.to = node;
    // It now joins along the through track's first way.
    if (!i.ways.includes(o.ways[0])) i.ways = [...i.ways, o.ways[0]];
    moved++;
  }
  return moved;
}

/**
 * The whole network eased until no curve is tighter than `EASE_TO`, and otherwise left as OSM has it.
 *
 * Every point of every track is a variable (a junction one, shared by its tracks), drawn toward where it lies now:
 * weight 1, a junction 10, the ends where tracks run out of the area held. Every bend, three points along a track or
 * through each turn a tram may take at a junction, is drawn with stiffness `BEND` toward its own present bend, held to
 * the most `EASE_TO` allows (three points a meter apart on a circle of radius R bend by 1/R). A bend within the limit is
 * its own target and costs nothing, so wide curves and straight track do not move; one beyond it is drawn to the
 * limit, which spreads a knee into an arc of that radius. Round after round, each solved exactly (conjugate gradients),
 * until every bend is within the limit. Double track run opposite ways keeps the spacing `separate` gave it, and the
 * junctions the fixes accept as tighter aim a little over the radius they accept. Returns the places still too tight,
 * measured as the tests measure them (`curveAt`).
 */
function easeAll(links: Link[], prevs: number[][], allowed: TrackFixes['tight']): string[] {
  const own = links.filter((l) => l.twin === null || l.twin > l.id);
  // One variable per point; a junction's, shared.
  const nodeVar = new Map<number, number>();
  const xs: Pt[] = [];
  const weight: number[] = [];
  const vars = new Map<number, number[]>();
  const point = (p: Pt, w: number) => {
    xs.push([...p] as Pt);
    weight.push(w);
    return xs.length - 1;
  };
  const endVar = (node: number, p: Pt) => {
    if (node < 0) return point(p, 1e9);
    if (!nodeVar.has(node)) nodeVar.set(node, point(p, 10));
    return nodeVar.get(node)!;
  };
  for (const a of own) {
    const n = a.pts.length - 1;
    vars.set(a.id, a.pts.map((p, i) => (i === 0 ? endVar(a.from, p) : i === n ? endVar(a.to, p) : point(p, 1))));
  }
  const varsOf = (id: number) => {
    const l = links[id];
    return l.twin !== null && !vars.has(id) ? [...vars.get(l.twin)!].reverse() : vars.get(id)!;
  };
  const target = xs.map((p) => [...p] as Pt);

  /** The least radius accepted at point `i` of `a`: lower within `CHORD` of a junction the fixes allow to be tight. */
  const least = (a: Link, i: number) => Math.min(MIN_RADIUS,
    i <= CHORD && allowed[a.from] ? allowed[a.from].radius : MIN_RADIUS,
    i >= a.pts.length - 1 - CHORD && allowed[a.to] ? allowed[a.to].radius : MIN_RADIUS);
  /** The radius a bend aims for: a little over the least accepted, so rounding to centimeters stays over it. */
  const aimFor = (r: number) => (r < MIN_RADIUS ? r * 1.03 : EASE_TO);

  // The bends: three variables and the radius aimed for. Along every track, and through every turn at a junction.
  const bends: Array<{ v: [number, number, number]; aim: number; k: number }> = [];
  const seenBend = new Set<string>();
  const addBend = (v: [number, number, number], aim: number) => {
    const key = v[0] < v[2] ? v.join(',') : [...v].reverse().join(',');
    if (seenBend.has(key)) return;
    seenBend.add(key);
    bends.push({ v, aim, k: BEND });
  };
  for (const a of own) {
    const v = vars.get(a.id)!;
    for (let j = 1; j + 1 < v.length; j++) addBend([v[j - 1], v[j], v[j + 1]], aimFor(least(a, j)));
  }
  for (const a of links) {
    for (const b of a.next) {
      const va = varsOf(a.id), vb = varsOf(b);
      if (va.length > 1 && vb.length > 1) addBend([va[va.length - 2], va[va.length - 1], vb[1]], aimFor(allowed[a.to]?.radius ?? MIN_RADIUS));
    }
  }

  // Track run the other way alongside, on plain double track: each point held as far from its partner as `separate`
  // left it, so the easing moves double track together instead of drawing it in again.
  const pairs: Array<{ i: number; j: number; d: Pt }> = [];
  {
    const CELL = 4;
    const grid = new Map<string, Array<{ v: number; link: number; dir: Pt; plain: boolean }>>();
    /** Whether point `k` of `a` lies on plain double track, away from the junctions at its ends. */
    const plain = (a: Link, k: number) => !((a.from >= 0 && k < NEAR_JUNCTION) || (a.to >= 0 && k > a.pts.length - 1 - NEAR_JUNCTION));
    const dirAt = (pts: Pt[], k: number) => unit([pts[Math.min(pts.length - 1, k + 1)][0] - pts[Math.max(0, k - 1)][0], pts[Math.min(pts.length - 1, k + 1)][1] - pts[Math.max(0, k - 1)][1]]);
    for (const a of own) {
      const v = vars.get(a.id)!;
      a.pts.forEach((p, k) => {
        const key = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push({ v: v[k], link: a.id, dir: dirAt(a.pts, k), plain: plain(a, k) });
      });
    }
    const seen = new Set<string>();
    for (const a of own) {
      const v = vars.get(a.id)!;
      a.pts.forEach((p, k) => {
        if (!plain(a, k)) return;
        const dir = dirAt(a.pts, k);
        let best: { v: number; d: number } | null = null;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (const q of grid.get(`${Math.floor(p[0] / CELL) + dx},${Math.floor(p[1] / CELL) + dz}`) ?? []) {
              if (q.link === a.id || q.link === a.twin || !q.plain || dir[0] * q.dir[0] + dir[1] * q.dir[1] > -0.97) continue;
              const d = dist(p, xs[q.v]);
              if (d < SPACING + 0.5 && (!best || d < best.d)) best = { v: q.v, d };
            }
          }
        }
        if (!best || v[k] === best.v) return;
        const key = v[k] < best.v ? `${v[k]},${best.v}` : `${best.v},${v[k]}`;
        if (seen.has(key)) return;
        seen.add(key);
        pairs.push({ i: v[k], j: best.v, d: [xs[v[k]][0] - xs[best.v][0], xs[v[k]][1] - xs[best.v][1]] });
      });
    }
  }

  /** A x for one coordinate: the weights, the bends' stiffness times their second difference spread back, and the pairs. */
  const apply = (x: number[]): number[] => {
    const out = x.map((v, i) => weight[i] * v);
    for (const { v: [i, j, k], k: stiff } of bends) {
      const r = stiff * (x[i] - 2 * x[j] + x[k]);
      out[i] += r;
      out[j] -= 2 * r;
      out[k] += r;
    }
    for (const { i, j } of pairs) {
      const r = KEEP_APART * (x[i] - x[j]);
      out[i] += r;
      out[j] -= r;
    }
    return out;
  };
  const diagonal = () => {
    const d = [...weight];
    for (const { v: [i, j, k], k: stiff } of bends) {
      d[i] += stiff;
      d[j] += 4 * stiff;
      d[k] += stiff;
    }
    for (const { i, j } of pairs) {
      d[i] += KEEP_APART;
      d[j] += KEEP_APART;
    }
    return d;
  };
  /** Conjugate gradients for one coordinate, preconditioned by the diagonal, from the current positions. */
  const solve = (c: 0 | 1, goals: Pt[]) => {
    const diag = diagonal();
    const b = target.map((p, i) => weight[i] * p[c]);
    bends.forEach(({ v: [i, j, k], k: stiff }, n) => {
      b[i] += stiff * goals[n][c];
      b[j] -= 2 * stiff * goals[n][c];
      b[k] += stiff * goals[n][c];
    });
    for (const { i, j, d } of pairs) {
      b[i] += KEEP_APART * d[c];
      b[j] -= KEEP_APART * d[c];
    }
    const x = xs.map((p) => p[c]);
    const ax = apply(x);
    const r = b.map((v, i) => v - ax[i]);
    let z = r.map((v, i) => v / diag[i]);
    let p = [...z];
    let rz = r.reduce((sum, v, i) => sum + v * z[i], 0);
    const scale = b.reduce((sum, v, i) => sum + (v * v) / diag[i], 0);
    for (let it = 0; it < 3000 && rz > scale * 1e-20; it++) {
      const ap = apply(p);
      const alpha = rz / p.reduce((sum, v, i) => sum + v * ap[i], 0);
      for (let i = 0; i < x.length; i++) {
        x[i] += alpha * p[i];
        r[i] -= alpha * ap[i];
      }
      z = r.map((v, i) => v / diag[i]);
      const next = r.reduce((sum, v, i) => sum + v * z[i], 0);
      p = z.map((v, i) => v + (next / rz) * p[i]);
      rz = next;
    }
    x.forEach((v, i) => (xs[i][c] = v));
  };
  for (let round = 0; round < 300; round++) {
    // Each bend's goal: its present bend, held to the most its aim allows.
    // A bend still over after a round is held to it harder: the goal is the limit, not a straight line, so a stiff bend
    // takes exactly the radius aimed for and nothing more.
    let over = 0;
    const goals = bends.map((bend): Pt => {
      const [i, j, k] = bend.v;
      const d: Pt = [xs[i][0] - 2 * xs[j][0] + xs[k][0], xs[i][1] - 2 * xs[j][1] + xs[k][1]];
      const h = (dist(xs[i], xs[j]) + dist(xs[j], xs[k])) / 2;
      const most = (h * h) / bend.aim, size = Math.hypot(d[0], d[1]);
      if (size <= most) return d;
      if (size > most * 1.01) {
        over++;
        if (round) bend.k = Math.min(1e6, bend.k * 2);
      }
      return [(d[0] * most) / size, (d[1] * most) / size];
    });
    if (!over) break;
    solve(0, goals);
    solve(1, goals);
  }
  for (const a of own) {
    a.pts = vars.get(a.id)!.map((i) => [...xs[i]] as Pt);
    a.length = polylineLength(a.pts);
    if (a.twin !== null) {
      links[a.twin].pts = [...a.pts].reverse();
      links[a.twin].length = a.length;
    }
  }
  const out: string[] = [];
  for (const a of links) {
    for (let i = 0; i < a.pts.length; i++) {
      const r = curveAt(links, prevs, a.id, (i * a.length) / Math.max(1, a.pts.length - 1));
      if (r < least(a, i)) {
        out.push(`link ${a.id} at ${a.pts[i].map(Math.round).join(', ')}: ${r.toFixed(1)} m`);
        break;
      }
    }
  }
  return out;
}

/**
 * Double track drawn tighter than `SPACING`, moved apart to it: each of two tracks run opposite ways within it is moved
 * half the shortfall away from the other, the move smoothed along the track and faded out over the last
 * `NEAR_JUNCTION` meters before a junction, so switches and crossings stay where OSM has them. Tracks run the same way are left alone: those are the
 * two sides of a switch, which close in on each other by design. Every move is worked out before any is made.
 */
function separate(links: Link[]): { meters: number; most: number } {
  const own = links.filter((l) => l.twin === null);
  const CELL = 4;
  const grid = new Map<string, Array<{ link: number; a: Pt; b: Pt }>>();
  for (const l of own) {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const k = `${Math.floor(l.pts[i][0] / CELL)},${Math.floor(l.pts[i][1] / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push({ link: l.id, a: l.pts[i], b: l.pts[i + 1] });
    }
  }
  const moves = new Map<number, Pt[]>();
  let meters = 0, most = 0;
  for (const l of own) {
    const n = l.pts.length - 1;
    const want: Pt[] = l.pts.map(() => [0, 0]);
    let any = false;
    for (let i = 0; i <= n; i++) {
      const p = l.pts[i];
      const dir = unit([l.pts[Math.min(n, i + 1)][0] - l.pts[Math.max(0, i - 1)][0], l.pts[Math.min(n, i + 1)][1] - l.pts[Math.max(0, i - 1)][1]]);
      const [cx, cz] = [Math.floor(p[0] / CELL), Math.floor(p[1] / CELL)];
      let best: { d: number; q: Pt } | null = null;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const g of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
            if (g.link === l.id) continue;
            const ex = g.b[0] - g.a[0], ez = g.b[1] - g.a[1], len = Math.hypot(ex, ez);
            if (len < 1e-6 || (dir[0] * ex + dir[1] * ez) / len > -0.97) continue;
            const t = Math.max(0, Math.min(1, ((p[0] - g.a[0]) * ex + (p[1] - g.a[1]) * ez) / (len * len)));
            const q: Pt = [g.a[0] + ex * t, g.a[1] + ez * t];
            const d = dist(p, q);
            if (d < SPACING && d > 0.5 && (!best || d < best.d)) best = { d, q };
          }
        }
      }
      if (!best) continue;
      const away = unit([p[0] - best.q[0], p[1] - best.q[1]]);
      const w = (SPACING - best.d) / 2;
      want[i] = [away[0] * w, away[1] * w];
      any = true;
    }
    if (!any) continue;
    // Smoothed along the track (a moving average, twice), then faded toward the junctions at its ends.
    let m = want;
    for (let pass = 0; pass < 2; pass++) {
      m = m.map((_, i) => {
        let sx = 0, sz = 0, k = 0;
        for (let j = Math.max(0, i - 10); j <= Math.min(n, i + 10); j++) [sx, sz, k] = [sx + m[j][0], sz + m[j][1], k + 1];
        return [sx / k, sz / k] as Pt;
      });
    }
    m = m.map(([x, z], i) => {
      const f = Math.min(1, l.from >= 0 ? i / NEAR_JUNCTION : 1, l.to >= 0 ? (n - i) / NEAR_JUNCTION : 1);
      return [x * f, z * f] as Pt;
    });
    moves.set(l.id, m);
  }
  for (const [id, m] of moves) {
    const l = links[id];
    l.pts = l.pts.map((p, i) => [p[0] + m[i][0], p[1] + m[i][1]] as Pt);
    l.length = polylineLength(l.pts);
    for (const [x, z] of m) {
      const d = Math.hypot(x, z);
      if (d > 0.05) meters++;
      most = Math.max(most, d);
    }
  }
  return { meters, most };
}

/**
 * Track run one way that lies closer than `CLEAR` to track run the other way, on plain double track (more than
 * `NEAR_JUNCTION` from a junction on both): drawn or eased too tight, which the blocks would take for single track.
 * Meters of it (sampled every meter), the least distance and where.
 */
export function closeOpposite(links: Link[]): { meters: number; least: number; at: Pt } {
  const own = links.filter((l) => l.twin === null || l.twin > l.id);
  const CELL = 4;
  const plain = (l: Link, s: number) => !((l.from >= 0 && s < NEAR_JUNCTION) || (l.to >= 0 && s > l.length - NEAR_JUNCTION));
  const grid = new Map<string, Array<{ link: number; a: Pt; b: Pt }>>();
  for (const l of own) {
    let s = 0;
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const seg = dist(l.pts[i], l.pts[i + 1]);
      if (plain(l, s) && plain(l, s + seg)) {
        const k = `${Math.floor(l.pts[i][0] / CELL)},${Math.floor(l.pts[i][1] / CELL)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push({ link: l.id, a: l.pts[i], b: l.pts[i + 1] });
      }
      s += seg;
    }
  }
  let meters = 0, least = Infinity, at: Pt = [0, 0];
  for (const l of own) {
    for (let s = 0; s <= l.length; s += 1) {
      if (!plain(l, s)) continue;
      const p = pointAt(l.pts, s), q = pointAt(l.pts, Math.min(l.length, s + 0.5));
      const dir = unit([q[0] - p[0], q[1] - p[1]]);
      let d = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const g of grid.get(`${Math.floor(p[0] / CELL) + dx},${Math.floor(p[1] / CELL) + dz}`) ?? []) {
            if (g.link === l.id || g.link === l.twin) continue;
            const e = unit([g.b[0] - g.a[0], g.b[1] - g.a[1]]);
            if (dir[0] * e[0] + dir[1] * e[1] > -0.97) continue;
            d = Math.min(d, project([g.a, g.b], p).d);
          }
        }
      }
      if (d >= CLEAR) continue;
      meters++;
      if (d < least) [least, at] = [d, p];
    }
  }
  return { meters, least, at };
}

/** The blocks and which of them conflict, as `buildTracks` describes them. */
function cutBlocks(links: Link[]): { blocks: Block[]; conflicts: Array<[number, number]> } {
  const own = links.filter((l) => l.twin === null || l.twin > l.id);
  const blocks: Block[] = [];
  const ids = new Map<number, number[]>();
  const r2 = (v: number) => Math.round(v * 100) / 100;
  for (const l of own) {
    const n = Math.max(1, Math.ceil(l.length / BLOCK));
    const list: number[] = [];
    for (let k = 0; k < n; k++) {
      const s0 = (l.length * k) / n, s1 = (l.length * (k + 1)) / n;
      const spans: Array<[number, number, number]> = [[l.id, r2(s0), r2(s1)]];
      if (l.twin !== null) spans.push([l.twin, r2(l.length - s1), r2(l.length - s0)]);
      list.push(blocks.length);
      blocks.push({ id: blocks.length, spans });
    }
    ids.set(l.id, list);
  }
  const blockAt = (link: number, s: number) => {
    const list = ids.get(link)!;
    return list[Math.min(list.length - 1, Math.floor((s / links[link].length) * list.length))];
  };
  // One sample a meter along each track (a track run both ways once), and the pairs closer than `CLEAR`.
  const samples: Array<{ link: number; s: number; p: Pt }> = [];
  for (const l of own) for (let s = 0; s <= l.length; s += 1) samples.push({ link: l.id, s, p: pointAt(l.pts, s) });
  const grid = new Map<string, number[]>();
  samples.forEach((x, i) => {
    const k = `${Math.floor(x.p[0] / CLEAR)},${Math.floor(x.p[1] / CLEAR)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  /**
   * Whether two points are one track running on through junctions (a tram passes both, one after the other), not two
   * tracks side by side: a tram from one, on its link or the twin, reaches the other within `2 * CLEAR` of track, over
   * however many short links lie between (a moved toe leaves one of a couple of meters).
   */
  const sides = (link: number) => [links[link], ...(links[link].twin !== null ? [links[links[link].twin!]] : [])];
  const toEnd = (x: Link, link: number, s: number) => (x.id === link ? links[link].length - s : s);
  const toStart = (y: Link, link: number, s: number) => (y.id === link ? s : links[link].length - s);
  const reaches = (x: Link, d: number, b: { link: number; s: number }): boolean =>
    d < 2 * CLEAR && x.next.some((id) => {
      const y = links[id];
      return y.id === b.link || y.twin === b.link ? d + toStart(y, b.link, b.s) < 2 * CLEAR : reaches(y, d + y.length, b);
    });
  const onto = (a: { link: number; s: number }, b: { link: number; s: number }) => sides(a.link).some((x) => reaches(x, toEnd(x, a.link, a.s), b));
  const follows = (a: { link: number; s: number }, b: { link: number; s: number }) => onto(a, b) || onto(b, a);
  const pairs = new Set<string>();
  samples.forEach((x, i) => {
    const [cx, cz] = [Math.floor(x.p[0] / CLEAR), Math.floor(x.p[1] / CLEAR)];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const y = samples[j];
          if (j <= i || y.link === x.link || dist(y.p, x.p) >= CLEAR || follows(x, y)) continue;
          const a = blockAt(x.link, x.s), b = blockAt(y.link, y.s);
          if (a !== b) pairs.add(a < b ? `${a},${b}` : `${b},${a}`);
        }
      }
    }
  });
  const conflicts = [...pairs].map((k) => k.split(',').map(Number) as [number, number]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return { blocks, conflicts };
}
