/**
 * Gothenburg's inner city from OpenStreetMap (© OpenStreetMap contributors, ODbL), in the city frame (`geo.ts`):
 *
 * - the tram tracks as a graph trams can run on (`scripts/gbg-tracks.ts`, hand fixes in `scripts/gbg-track-fixes.ts`),
 *   with the stops on them and the blocks one tram at a time may be in, into `src/game/city/osm/tracks.json`;
 * - the city in squares of `TILE` meters (buildings, roads, parks, water, trees, as `scripts/osm-streets.ts` has
 *   them for Stockholm), a file per square into `src/game/city/osm/tiles/`, which the game fetches as the player comes
 *   near (P2).
 *
 *   bun scripts/gbg-osm.ts               (both, asking Overpass)
 *   bun scripts/gbg-osm.ts --cached      (from Overpass's last answers, kept in node_modules/.cache/osm/)
 *   bun scripts/gbg-osm.ts --tracks      (or --tiles: only the one)
 *
 * The files are data from OSM, so they are ODbL too: see their `license`.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { bbox, CITY, cityTiles, grow, PLAY, TILE, toGame, TRACK_REACH, type Pt } from '../src/game/city/geo';
import { packCm } from '../src/game/city/trackData';
import { FIXES } from './gbg-track-fixes';
import { buildTracks } from './gbg-tracks';
import { streetLayers, streetParts, streetQuery, wholeRelations } from './osm-layers';
import { LICENSE, overpass, packed, pause, writeJson } from './osm-lib';

const OUT = 'src/game/city/osm';
const only = process.argv.includes('--tracks') ? 'tracks' : process.argv.includes('--tiles') ? 'tiles' : null;
const box = (r: Parameters<typeof bbox>[0]) => bbox(r).join(',');

if (only !== 'tiles') {
  // The tracks run on past the area kept, so every link that crosses its edge is asked for whole.
  const keep = grow(PLAY, TRACK_REACH);
  const near = box(grow(keep, 150));
  const els = await overpass(`(way[railway=tram](${near});node[railway=tram_stop](${near}););out body geom;`, 'gbg-tracks');
  const { links, stops, blocks, conflicts, report } = buildTracks(els, toGame, keep, FIXES);
  for (const line of report) console.log(line);
  mkdirSync(OUT, { recursive: true });
  writeJson(`${OUT}/tracks.json`, {
    license: LICENSE,
    format: 'bun scripts/gbg-osm.ts. The tram tracks in the city frame (src/game/city/geo.ts), meters. links: a track one way, from one junction to the next ' +
      '(from/to: an OSM node; a switch toe moved back from a node, as 1e12 times the toes moved from it plus the node; -1 where it runs out of the area), the links a tram may go on to (next), the same track the other way (twin), its length and points ' +
      '(centimeters, the first as it is and each next from the one before, eased so no curve is tighter than 18 m). stops: OSM\'s tram stops, as a link, s along it and how far the node lies off it. ' +
      'blocks: one tram at a time, as [link, from s, to s] (on the twin too). conflicts: pairs of blocks that cannot hold trams at once (a switch, a crossing).',
  }, {
    links: links.map(({ pts, length, ...l }) => ({ ...l, length: Math.round(length * 100) / 100, pts: packCm(thin(pts)) })),
    stops,
    blocks,
    conflicts,
  });
}

if (only !== 'tracks') {
  if (only !== 'tiles') await pause();
  const near = box(grow(CITY, 50));
  const els = await overpass(`${streetQuery(near, box(grow(CITY, 450)))}`, 'gbg-city');
  await pause();
  await wholeRelations(els, 'gbg-city-relations');
  const dir = `${OUT}/tiles`;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(`${dir}/${f}`);
  let written = 0, buildings = 0;
  // The relations' rings and the coast, joined once in the city frame and moved to each square.
  const city = await streetParts(els, toGame);
  for (const tile of cityTiles()) {
    const [cx, cz] = [(tile.rect.x0 + tile.rect.x1) / 2, (tile.rect.z0 + tile.rect.z1) / 2];
    // Each square in its own numbers, from its middle, as the street files are from a station's.
    const shift = (p: Pt): Pt => [p[0] - cx, p[1] - cz];
    const local = (lat: number, lon: number): Pt => shift(toGame(lat, lon));
    const parts = new Map([...city.parts].map(([id, { outer, inner }]) => [id, { outer: outer.map((r) => r.map(shift)), inner: inner.map((r) => r.map(shift)) }]));
    const coast = city.coast.map((c) => c.map(shift));
    const layers = streetLayers(els, { parts, coast }, local, { cx: 0, cz: 0, hx: TILE / 2, hz: TILE / 2, round: false });
    if (!layers.buildings.length && !layers.roads.length && !layers.areas.length) continue;
    writeJson(`${dir}/${tile.key}.json`, {
      license: LICENSE,
      format: 'bun scripts/gbg-osm.ts. One square of the city, in decimeters from its middle (middle, in meters in the city frame), x and z as in src/game/city/geo.ts; ' +
        'the lists as scripts/osm-streets.ts writes them for Stockholm. buildings: whole where their middle lies in the square. roads and areas: cut to it.',
      middle: [cx, cz],
      urban: layers.urban,
      names: layers.names,
      trees: packed(layers.trees),
    }, { buildings: layers.buildings, roads: layers.roads, areas: layers.areas });
    written++;
    buildings += layers.buildings.length;
  }
  console.log(`${written} squares of ${TILE} m, ${buildings} buildings`);
}

/** The points a polyline needs: those off the line through their neighbours by more than half a centimeter. */
function thin(pts: Pt[]): Pt[] {
  const keep = pts.map(() => false);
  keep[0] = keep[pts.length - 1] = true;
  const run = (a: number, b: number) => {
    let worst = -1, far = 0.005;
    const [ax, az] = pts[a], [bx, bz] = pts[b];
    const len = Math.hypot(bx - ax, bz - az);
    for (let i = a + 1; i < b; i++) {
      // Off the line through the two, or, where they are one point (a loop closing on itself), off that point.
      const d = len > 1e-9 ? Math.abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / len : Math.hypot(pts[i][0] - ax, pts[i][1] - az);
      if (d > far) [worst, far] = [i, d];
    }
    if (worst < 0) return;
    keep[worst] = true;
    run(a, worst);
    run(worst, b);
  };
  run(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}
