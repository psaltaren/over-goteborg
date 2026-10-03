/**
 * The streets out of every station's exit, from OpenStreetMap (© OpenStreetMap
 * contributors, ODbL). For each station it asks Overpass for the station, the
 * metro's tracks and its entrances (`railway=subway_entrance`), then for the
 * buildings, roads, parks, woods, water and trees round them, turns the map so
 * the tracks run along the game's +x (as `scripts/osm.ts` does), and writes a
 * file per exit into `src/game/world/osm/streets/`, which the game fetches
 * when it builds that street (`world/streetOsm.ts`).
 *
 * Underground a station gets a file per end it may come out at: round the
 * entrance furthest out that way, with the others that way for a second hall
 * at the same end, and the game lays the city so the hall's entrance is where
 * its stairs come up. In the open (and in the city by the water) one
 * file round the station itself, laid as the buildings along the tracks are.
 *
 *   bun scripts/osm-streets.ts Odenplan "T-Centralen"
 *   bun scripts/osm-streets.ts --all
 *   bun scripts/osm-streets.ts --all --cached      (from Overpass's last answers)
 *   bun scripts/osm-streets.ts --all --resume      (asking only what it has not asked yet)
 *   bun scripts/osm-streets.ts --line green        (one line's stations)
 *   bun scripts/osm-streets.ts --all --entrances   (only where every station's entrances are: `ENTRANCES`)
 *
 * The files are data from OSM, so they are ODbL too: see their `license`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { streetKey } from '../src/game/world/osmKey';
import { LICENSE, overpass, packed, pause, stationFrame, stationQuery, stations as allStations, writeJson, type Pt, type Station } from './osm-lib';
import { streetLayers, streetParts, streetQuery, wholeRelations, type Region } from './osm-layers';

const OUT = 'src/game/world/osm/streets';
/**
 * Where every station's entrances are, in the same frame as the street files: what `tests/hall-sides.test.ts` checks
 * the stations' halls against. The game itself never reads it.
 */
const ENTRANCES = 'tests/data/osm-entrances.json';
/** Round an exit: buildings whose middle lies this close, and roads, parks and water within a square this far out. */
const R = 260;
/** In the open: along the tracks either side of the station (the next is 500 m off at the least), and out to either side. */
const OPEN = { x: 250, z: 300 };
/** How far out along its way an exit may lie: further, and it is likely the next station's. */
const EXIT_REACH = 280;

// ---- A station. ----

interface Exit { key: string; entrance: Pt | null; entrances: Pt[]; region: Region }

/** Every entrance round a station, by `line:name`, in meters (see `ENTRANCES`). */
const found = new Map<string, Pt[]>();

/** The station and its entrances, in the game's frame: the first thing asked about each station. */
async function entrancesOf(s: Station) {
  const first = await overpass(`${stationQuery(s)}(way[railway=subway](around.s:350);node[railway=subway_entrance](around.s:450););out geom tags;`, `streets-${s.line}-${s.site}-a`);
  const frame = stationFrame(first, s);
  const entrances = first.filter((e) => e.type === 'node' && e.tags?.railway === 'subway_entrance').map((e) => frame.toGame(e.lat!, e.lon!));
  found.set(`${s.line}:${s.name}`, entrances);
  return { ...frame, entrances };
}

async function fetchStation(s: Station): Promise<Array<{ exit: Exit; data: Record<string, unknown> }>> {
  const tag = `streets-${s.line}-${s.site}`;
  const { toGame, heading, entrances } = await entrancesOf(s);
  const exits: Exit[] = [];
  if (s.open || s.city) exits.push({ key: streetKey(s.line, s.name, null), entrance: null, entrances: [], region: { cx: 0, cz: 0, hx: OPEN.x, hz: OPEN.z, round: false } });
  else {
    for (const end of [1, -1] as const) {
      // The entrance furthest out toward this end, or a made-up one 110 m out where OSM has none there.
      const out = entrances.filter(([x, z]) => end * x > -30 && end * x < EXIT_REACH && Math.abs(z) < 160).sort((a, b) => end * b[0] - end * a[0]);
      const entrance: Pt = out[0] ?? [end * 110, 0];
      // The others that way, for a second hall at the same end: each well apart from those before it, and within reach.
      const others: Pt[] = [];
      for (const p of out.slice(1)) if (Math.hypot(p[0] - entrance[0], p[1] - entrance[1]) < R - 60 && [entrance, ...others].every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 40)) others.push(p);
      exits.push({ key: streetKey(s.line, s.name, end), entrance, entrances: others, region: { cx: entrance[0], cz: entrance[1], hx: R, hz: R, round: true } });
    }
  }
  const reach = Math.min(800, Math.max(...exits.map(({ region: r }) => Math.hypot(r.cx, r.cz) + Math.hypot(r.hx, r.hz))) + 20);
  await pause();
  const els = await overpass(`${stationQuery(s)}${streetQuery(`around.s:${reach}`, `around.s:${reach + 400}`)}`, `${tag}-b`);
  await wholeRelations(els, `${tag}-r`);
  const city = await streetParts(els, toGame);

  const results: Array<{ exit: Exit; data: Record<string, unknown> }> = [];
  for (const exit of exits) {
    const { buildings, roads, names, areas, trees, built, urban } = streetLayers(els, city, toGame, exit.region);
    results.push({
      exit,
      data: {
        entrance: exit.entrance && exit.entrance.map((v) => Math.round(v * 10)),
        ...(exit.entrances.length ? { entrances: exit.entrances.map((p) => p.map((v) => Math.round(v * 10))) } : {}),
        urban,
        names,
        trees: packed(trees),
        buildings,
        roads,
        areas,
      },
    });
    console.log(`${exit.key}: ${buildings.length} buildings, ${roads.length} roads (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}), ${areas.length} areas, ${trees.length} trees, ${Math.round((100 * built) / (Math.PI * 150 * 150))}% built${urban ? ' (city)' : ''}; tracks at ${heading.toFixed(0)}°${exit.entrance ? `, exit at ${exit.entrance.map((v) => v.toFixed(0)).join(', ')}` : ''}`);
  }
  return results;
}

const wanted = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--line');
const all = [...allStations().values()];
const lineArg = process.argv.indexOf('--line');
const line = lineArg >= 0 ? process.argv[lineArg + 1] : null;
const chosen = process.argv.includes('--all') ? all : line ? all.filter((s) => s.line === line) : all.filter((s) => wanted.includes(s.name) || wanted.includes(`${s.line}:${s.name}`));
if (!chosen.length) {
  console.error('Name the stations (a name, or line:name), or --all.');
  process.exit(1);
}
const FORMAT = 'bun scripts/osm-streets.ts. In decimeters from the station\'s middle with x along the tracks; a list of points is [x, z, then each next as dx, dz]. '
  + 'entrance: where the stairs come up (underground); entrances: others the same way, further in, for more halls at that end. buildings: [height, facade colour or null, roof (0 flat, 1 pitched), ...outline]. '
  + 'roads: [kind (0 road, 1 pedestrian, 2 path), width, index in names or -1, ...line]. areas: [kind (0 grass, 1 wood, 2 water, 3 paved, 4 asphalt, 5 sand), then per ring (outer first, then holes) its count of points and the points]. trees: points.';
mkdirSync(OUT, { recursive: true });
const failed: string[] = [];
const onlyEntrances = process.argv.includes('--entrances');
for (const [k, s] of chosen.entries()) {
  try {
    if (onlyEntrances) {
      await entrancesOf(s);
      continue;
    }
    for (const { exit, data } of await fetchStation(s)) {
      const { buildings, roads, areas, ...head } = data as { buildings: unknown[]; roads: unknown[]; areas: unknown[] };
      writeJson(`${OUT}/${exit.key}.json`, { license: LICENSE, format: FORMAT, ...head }, { buildings, roads, areas });
    }
  } catch (err) {
    console.error(`${s.line}:${s.name}: ${(err as Error).message.slice(0, 300)}`);
    failed.push(`${s.line}:${s.name}`);
  }
  if (k < chosen.length - 1) await pause();
}
// The entrances of the stations asked about, merged into those of the rest.
if (found.size) {
  const before = existsSync(ENTRANCES) ? (JSON.parse(readFileSync(ENTRANCES, 'utf8')) as { stations: Record<string, number[][]> }).stations : {};
  const stations = { ...before, ...Object.fromEntries([...found].map(([key, list]) => [key, list.map((p) => p.map((v) => Math.round(v)))])) };
  const sorted = Object.keys(stations).sort().map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(stations[key])}`);
  writeFileSync(ENTRANCES, `{\n  "license": ${JSON.stringify(LICENSE)},\n  "format": "bun scripts/osm-streets.ts --entrances. Per station (line:name), its entrances (railway=subway_entrance) in meters from its middle, x along the tracks toward the next station as the game lays them, z across.",\n  "stations": {\n${sorted.join(',\n')}\n  }\n}\n`);
}
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
