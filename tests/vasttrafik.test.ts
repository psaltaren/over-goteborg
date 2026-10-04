import { afterAll, afterEach, expect, setSystemTime, test } from 'bun:test';
import { createFeeds } from '../server/feedCore';
import { trimSituations, Vasttrafik, VT_PER_MINUTE } from '../server/vasttrafik';
import live from '../src/game/city/osm/live.json';

const realFetch = globalThis.fetch;
afterEach(async () => { await settle(); globalThis.fetch = realFetch; });
afterAll(() => { setSystemTime(); });

// Each relay keeps its state, so the clock only ever moves forward.
let clock = Date.parse('2026-10-07T06:00:00Z');
const advance = (seconds: number) => { clock += seconds * 1000; setSystemTime(new Date(clock)); };
advance(0);

const background = new Set<Promise<unknown>>();
const waitUntil = (task: Promise<unknown>) => { background.add(task); void task.finally(() => background.delete(task)); };
const settle = () => Promise.all([...background]);
const queries = live.queries.map((q) => `${q.gid}|${q.platforms.join(',')}`);
/** What the portal's authentication key looks like: base64 of a client id and secret (made up). */
const KEY = btoa('client:no secret');

/** A stand-in for Västtrafik: a token, and at every stop area a tram and a bus leaving in five minutes. */
function vasttrafik(options: { refuse?: number } = {}) {
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  let refuse = options.refuse ?? 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    calls.push({ url, auth, body: String(init?.body ?? '') });
    await new Promise((r) => setTimeout(r, 2));
    if (url.endsWith('/token')) return Response.json({ access_token: `token-${calls.length}`, token_type: 'Bearer', expires_in: 86400 });
    if (refuse > 0) {
      refuse--;
      return new Response('', { status: 401 });
    }
    const area = /stop-areas\/(\d+)\//.exec(url)?.[1];
    if (area) {
      const at = new Date(clock + 300_000).toISOString();
      const stop = `${area.slice(0, 3)}2${area.slice(4, 13)}001`;
      return Response.json({ results: [
        { serviceJourney: { line: { shortName: '6', transportMode: 'tram' } }, stopPoint: { gid: stop }, plannedTime: at, estimatedTime: new Date(clock + 360_000).toISOString(), isCancelled: false },
        { serviceJourney: { line: { shortName: '16', transportMode: 'bus' } }, stopPoint: { gid: stop }, plannedTime: at, estimatedTime: null, isCancelled: false },
      ] });
    }
    return Response.json([]);
  }) as typeof fetch;
  return calls;
}

const relay = () => {
  const feeds = createFeeds({ waitUntil, vasttrafik: new Vasttrafik({ key: KEY, device: 'test' }) });
  return async (name: string) => {
    const response = await feeds.handle(new URL(`http://relay/feeds/${name}`));
    await settle();
    return response!;
  };
};

test('a crowd of players costs Västtrafik one token and one budget of calls, and gets the trams alone', async () => {
  const calls = vasttrafik();
  const ask = relay();
  const answers = await Promise.all(Array.from({ length: 200 }, () => ask('vt')));
  const tokens = calls.filter((c) => c.url.endsWith('/token'));
  expect(tokens.length).toBe(1);
  expect(tokens[0].auth).toBe(`Basic ${KEY}`);
  expect(tokens[0].body).toContain('grant_type=client_credentials');
  expect(tokens[0].body).toContain('scope=device_test');
  expect(calls.length).toBeLessThanOrEqual(VT_PER_MINUTE);
  expect(calls.filter((c) => c.url.includes('/departures')).every((c) => c.auth.startsWith('Bearer token-'))).toBe(true);
  const body = (await answers[0].json()) as { data: { departures: Array<[string, string, number, number | null, number]> } };
  expect(body.data.departures.length).toBeGreaterThan(0);
  expect(body.data.departures.every(([, line]) => line === '6')).toBe(true);
  const [, , planned, expected, cancelled] = body.data.departures[0];
  expect(expected! - planned).toBe(60);
  expect(cancelled).toBe(0);
});

test('however often players ask, Västtrafik gets at most its budget a minute, one token, and every call a fresh list', async () => {
  const calls = vasttrafik();
  const ask = relay();
  const sent: number[] = [];
  const asked = new Map<string, number>();
  let worst = 0;
  for (let step = 0; step < 10 * 60; step++) {
    advance(1);
    const before = calls.length;
    await ask('vt');
    for (const c of calls.slice(before)) {
      sent.push(clock);
      const area = /stop-areas\/(\d+)\//.exec(c.url)?.[1];
      if (area) asked.set(`${area}|${new URL(c.url).searchParams.get('platforms')}`, clock);
    }
    if (step > 120) for (const key of queries) worst = Math.max(worst, clock - (asked.get(key) ?? 0));
    const minute = sent.filter((t) => clock - t < 60_000).length;
    expect(minute).toBeLessThanOrEqual(VT_PER_MINUTE);
  }
  expect(calls.filter((c) => c.url.endsWith('/token')).length).toBe(1);
  expect(worst).toBeLessThan(90_000);
});

test('a refused token is fetched again once', async () => {
  const calls = vasttrafik({ refuse: 1 });
  advance(120);
  const ask = relay();
  const answer = await ask('vt');
  expect(answer.status).toBe(200);
  expect(calls.filter((c) => c.url.endsWith('/token')).length).toBe(2);
});

test('a key Västtrafik keeps refusing costs a token now and then, never the budget', async () => {
  const calls = vasttrafik({ refuse: Infinity });
  advance(120);
  const ask = relay();
  const sent: number[] = [];
  for (let step = 0; step < 30 * 60; step++) {
    advance(1);
    const before = calls.length;
    await ask('vt');
    for (let i = before; i < calls.length; i++) sent.push(clock);
    expect(sent.filter((t) => clock - t < 60_000).length).toBeLessThanOrEqual(VT_PER_MINUTE);
  }
  // Refused twice in a row, the feed waits ten minutes: a half hour costs a few tokens, not one every pause.
  expect(calls.filter((c) => c.url.endsWith('/token')).length).toBeLessThanOrEqual(4);
});

test('without the key the trams\' feeds are off, and nobody is asked', async () => {
  const calls = vasttrafik();
  advance(120);
  const feeds = createFeeds({ waitUntil, log: () => {} });
  for (const name of ['vt', 'situations']) {
    const answer = await feeds.handle(new URL(`http://relay/feeds/${name}`));
    expect(answer!.status).toBe(404);
    expect(await answer!.json()).toEqual({ error: 'off' });
  }
  expect(calls.length).toBe(0);
});

test('only the traffic situations on the trams in the city are passed on, and not those over', () => {
  const now = Date.parse('2026-10-07T08:00:00+02:00') / 1000;
  const line = live.lines.find((l) => l.line === '6')!.gids[0];
  const area = live.areas[0];
  const list = [
    { situationNumber: '1', title: 'Spårarbete', description: 'Linje 6 kör inte.', severity: 'normal', startTime: '2026-10-07T05:00:00+02:00', endTime: '2026-10-07T20:00:00+02:00', affectedLines: [{ gid: line, designation: '6' }] },
    { situationNumber: '2', title: 'Hållplats flyttad', startTime: '2026-10-06T05:00:00+02:00', endTime: null, affectedStopPoints: [{ gid: `${area.gid.slice(0, 3)}2${area.gid.slice(4, 13)}001`, stopAreaGid: area.gid }] },
    { situationNumber: '3', title: 'Buss i Borås', startTime: '2026-10-07T05:00:00+02:00', endTime: '2026-10-07T20:00:00+02:00', affectedLines: [{ gid: '9011014999900000', designation: '1' }] },
    { situationNumber: '4', title: 'Över', startTime: '2026-10-06T05:00:00+02:00', endTime: '2026-10-06T20:00:00+02:00', affectedLines: [{ gid: line, designation: '6' }] },
    { situationNumber: '5', title: 'I morgon', startTime: '2026-10-08T05:00:00+02:00', endTime: null, affectedLines: [{ gid: line, designation: '6' }] },
  ];
  const kept = trimSituations(list, now);
  expect(kept.map((s) => s.id)).toEqual(['1', '2']);
  expect(kept[0].lines).toEqual(['6']);
  expect(kept[1].areas).toEqual([area.gid]);
  expect(kept[1].end).toBeNull();
});
