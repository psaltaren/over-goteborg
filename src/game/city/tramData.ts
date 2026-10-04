// The trams' data as the game fetches it from its own origin when it starts, as it fetches the squares: the track graph
// (`osm/tracks.json`), the runs (`osm/trams/runs.json`), and the timetable of each service day running (`osm/trams/
// <day>.json`, packed), not bundled into the game's code. A new day's is fetched when the clock comes to it.

import { Blocks } from './blocks';
import { readLinks, type Link, type TrackFile } from './trackData';
import { DAYS, unpackTrips, type Day, type Hold, type Run } from './schedule';
import { serviceDays } from './serviceDay';
import { TripTable } from './tripTable';

/** Where each file is served: Vite fills the list in at build time. */
let URLS: Record<string, string> | null = null;
function urls(): Record<string, string> {
  if (URLS) return URLS;
  let found: Record<string, string> = {};
  // Under Bun (the tests) there is no Vite to fill it in.
  try {
    found = {
      ...import.meta.glob<string>('./osm/tracks.json', { query: '?url', import: 'default', eager: true }),
      ...import.meta.glob<string>('./osm/trams/*.json', { query: '?url', import: 'default', eager: true }),
    };
  } catch { /* No files. */ }
  URLS = Object.fromEntries(Object.entries(found).map(([path, url]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), url]));
  return URLS;
}

/** How long a file may take before the game gives up on it (offline, or a connection that stalls). */
const TIMEOUT = 20_000;

async function fetchJson<T>(name: string): Promise<T> {
  const url = urls()[name];
  if (!url) throw new Error(`No file for ${name}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return (await res.json()) as T;
}

export interface TramData {
  links: Link[];
  runs: Run[];
  table: TripTable;
  /** The track's blocks, for the live plan (`livePlan.ts`). */
  blocks: Blocks;
  /** Fetches the timetables of the service days running at `epoch` that are not here yet; resolves once they are. */
  ensure(epoch: number): Promise<void>;
}

/**
 * The tracks, the runs and the timetables running at `epoch`. Throws if the tracks or the runs cannot be fetched. The
 * tracks go to `onTracks` as soon as they are here (null if they cannot be), for the squares to lay their rails without
 * waiting for the timetable.
 */
export async function loadTramData(epoch: number, onTracks?: (links: Link[] | null) => void): Promise<TramData> {
  const fileUp = fetchJson<TrackFile>('tracks');
  const tracksUp = fileUp.then(readLinks);
  tracksUp.then((links) => onTracks?.(links), () => onTracks?.(null));
  const [file, links, runsFile] = await Promise.all([fileUp, tracksUp, fetchJson<{ runs: Run[] }>('runs')]);
  const table = new TripTable(runsFile.runs);
  const pending = new Map<Day, Promise<void>>();
  const ensure = async (at: number) => {
    const wanted = [...new Set(serviceDays(at).map((d) => d.day))].filter((d) => DAYS.includes(d) && !table.has(d));
    await Promise.all(wanted.map((day) => {
      if (!pending.has(day)) {
        pending.set(day, fetchJson<{ trips: number[][]; holds?: Array<[number, Hold[]]> }>(day)
          .then((f) => table.addDay(day, unpackTrips(f.trips), f.holds))
          // Offline: no trams that day, and asked for again a minute on.
          .catch(() => { pending.delete(day); }));
      }
      return pending.get(day)!;
    }));
  };
  await ensure(epoch);
  return { links, runs: runsFile.runs, table, blocks: new Blocks(runsFile.runs, links, file.blocks, file.conflicts), ensure };
}
