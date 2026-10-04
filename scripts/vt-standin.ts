// A stand-in for Västtrafik's API, for the relay to ask where the real one cannot be: `scripts/worker-check.ts` counts
// what the hub asks of it, and in development it gives the trams something to follow without a key:
//
//   bun scripts/vt-standin.ts                      (on port 8920, or PORT)
//   VASTTRAFIK_KEY=standin VASTTRAFIK_URL=http://localhost:8920 bun run dev
//
// It answers a token, each stop area's departures from the game's own timetable (each line late by an amount that
// drifts over the hour, one trip in forty cancelled) and one traffic situation on line 6. `GET /calls` says what it
// was asked, when. Nothing here is Västtrafik's data beyond the timetable the game already has.

import { unheld } from '../src/game/city/blocks';
import schedule from '../src/game/city/osm/schedule.json';
import live from '../src/game/city/osm/live.json';
import { signAt, type ScheduleFile } from '../src/game/city/schedule';
import { serviceDays } from '../src/game/city/serviceDay';

const file = schedule as unknown as ScheduleFile;
const calls: Array<{ at: number; path: string }> = [];

/** A small hash, so the made-up delays are the same whenever asked. */
const hash = (...xs: number[]) => {
  let h = 2166136261;
  for (const x of xs) h = Math.imul(h ^ Math.floor(x), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
};
const lineDelay = (line: string, at: number) => {
  const n = [...line].reduce((a, c) => a + c.charCodeAt(0), 0);
  return hash(n) < 0.3 ? 0 : Math.round(240 * hash(n, 1) * (0.5 + 0.5 * Math.sin(at / 1800 + 6 * hash(n, 2))));
};

/** The departures from a stop area's platforms in the next `minutes`, as Västtrafik's API would give them. */
function departures(area: string, minutes: number): unknown[] {
  const now = Date.now() / 1000;
  const out: Array<{ at: number; body: unknown }> = [];
  const prefix = area.slice(4, 13);
  for (const sd of serviceDays(now)) {
    file[sd.day].forEach((trip, i) => {
      const run = file.runs[trip.run];
      const planned = unheld(trip.times, trip.holds ?? []);
      run.stops.forEach((st, k) => {
        if (!st.stop || st.stop.slice(4, 13) !== prefix || st.s < 0 || st.s > run.length || k === run.stops.length - 1) return;
        const at = sd.start + planned[2 * k + 1];
        if (at < now - 60 || at > now + minutes * 60) return;
        const line = signAt(run, st.s).line;
        if (!line) return;
        const cancelled = hash(sd.start, i) < 0.025;
        const expected = at + lineDelay(line, at) + Math.round(40 * hash(sd.start, i, 3) - 20);
        out.push({ at, body: {
          serviceJourney: { gid: `9015014${String(i).padStart(9, '0')}`, direction: signAt(run, st.s).headsign, line: { shortName: line, designation: line, transportMode: 'tram' } },
          stopPoint: { gid: st.stop, name: st.name, platform: st.platform },
          plannedTime: new Date(at * 1000).toISOString(),
          estimatedTime: cancelled ? null : new Date(expected * 1000).toISOString(),
          isCancelled: cancelled,
          isPartCancelled: false,
        } });
      });
    });
  }
  return out.sort((a, b) => a.at - b.at).map((d) => d.body);
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8920),
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/calls') return Response.json(calls);
    calls.push({ at: Date.now(), path: url.pathname });
    if (url.pathname === '/token' && request.method === 'POST') {
      if (!request.headers.get('authorization')?.startsWith('Basic ')) return Response.json({ error: 'invalid_client' }, { status: 401 });
      return Response.json({ access_token: `standin-${calls.length}`, scope: 'default', token_type: 'Bearer', expires_in: 86400 });
    }
    if (!request.headers.get('authorization')?.startsWith('Bearer ')) return new Response('', { status: 401 });
    const area = /^\/pr\/v4\/stop-areas\/(\d{16})\/departures$/.exec(url.pathname)?.[1];
    if (area) return Response.json({ results: departures(area, Number(url.searchParams.get('timeSpanInMinutes') ?? 60)), pagination: { limit: 100, offset: 0, size: 0 } });
    if (url.pathname === '/ts/v1/traffic-situations') {
      const now = Date.now();
      const six = live.lines.find((l) => l.line === '6');
      return Response.json([{
        situationNumber: 'standin-1',
        creationTime: new Date(now - 3600_000).toISOString(),
        startTime: new Date(now - 3600_000).toISOString(),
        endTime: new Date(now + 3 * 3600_000).toISOString(),
        severity: 'normal',
        title: 'Linje 6 kör en annan väg vid Kortedala',
        description: 'Spårarbete. Ersättningsbussar går mellan Beväringsgatan och Kortedala torg.',
        affectedLines: six ? [{ gid: six.gids[0], designation: '6' }] : [],
        affectedStopPoints: [],
      }]);
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Västtrafik's stand-in on http://localhost:${server.port}`);
