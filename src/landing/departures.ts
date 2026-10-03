// The departure board on the landing page: the next trams to leave Drottningtorget, from the game's own timetable
// (`game/city/tripTable.ts`), so the board shows the trams the game has. Its own chunk, the timetable's files fetched
// once the page has settled; no three.js. Its words (now, minutes, none) are the page's own, in its language.

import { unpackTrips, type Run } from '../game/city/schedule';
import { serviceDays } from '../game/city/serviceDay';
import { TripTable } from '../game/city/tripTable';

const FILES = import.meta.glob<string>('../game/city/osm/trams/*.json', { query: '?url', import: 'default', eager: true });
const url = (name: string) => Object.entries(FILES).find(([path]) => path.endsWith(`/${name}.json`))?.[1];
/** The stop on the board, and how many trams it shows (two rows, as the board is drawn), how often it is drawn again. */
const STOP = 'Drottningtorget';
const ROWS = 2;
const EVERY = 15_000;

async function json<T>(name: string): Promise<T> {
  const at = url(name);
  if (!at) throw new Error(`No file for ${name}`);
  const res = await fetch(at);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return (await res.json()) as T;
}

/** Fills `board` with the next trams from Drottningtorget, and keeps it filled. */
export async function mountDepartures(board: HTMLElement): Promise<void> {
  const { runs } = await json<{ runs: Run[] }>('runs');
  const table = new TripTable(runs);
  /** The timetables of the service days running now, fetched as the clock comes to them. */
  const ensure = async (epoch: number) => {
    for (const { day } of serviceDays(epoch)) if (!table.has(day)) table.addDay(day, unpackTrips((await json<{ trips: number[][] }>(day)).trips));
  };
  const stops = [...new Set(runs.flatMap((r) => r.stops.filter((s) => s.name === STOP && s.stop && s.s >= 0 && s.s <= r.length).map((s) => s.stop)))];
  const { now = 'Nu', min = '{min} min', none = '' } = board.dataset;
  const draw = async () => {
    const at = Date.now() / 1000;
    await ensure(at);
    const next = stops.flatMap((s) => table.departures(s, at, ROWS)).sort((a, b) => a.at - b.at).slice(0, ROWS);
    const rows = next.map((d) => {
      const minutes = Math.floor((d.at - at) / 60);
      return [d.line, d.headsign, minutes < 1 ? now : min.replace('{min}', String(minutes))];
    });
    if (!rows.length && none) rows.push(['', none, '']);
    board.replaceChildren(...rows.flatMap((cells, i) => {
      const row = document.createElement('span');
      row.className = 'menu-board-row';
      cells.forEach((text, k) => {
        if (k) row.append(' ');
        const cell = document.createElement('span');
        cell.textContent = text;
        row.append(cell);
      });
      return i ? [' ', row] : [row];
    }));
    board.classList.remove('is-pending');
  };
  await draw();
  setInterval(() => void draw().catch(() => {}), EVERY);
}
