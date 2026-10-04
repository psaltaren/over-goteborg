// Västtrafik's own API, asked by the relay alone, for the `vt` and `situations` feeds (server/feedCore.ts): the trams'
// departures at the stop areas in the city (Planera Resa v4, `/pr/v4/stop-areas/<gid>/departures`) and the traffic
// situations on their lines and stops (Trafikstörningar, `/ts/v1/traffic-situations`). Shared by both relays, the Bun
// relay in development (server/feeds.ts) and the hub on Cloudflare (worker/hub.ts); nothing here needs Bun.
//
// The key: an application on developer.vasttrafik.se subscribed to both APIs, its "Autentiseringsnyckel" (base64 of
// its client id and secret) in VASTTRAFIK_KEY, a secret of the relay's, never the client's. It buys a token for a day
// (OAuth client credentials), kept until it runs out: Västtrafik asks that a new one is not fetched before, so each
// relay asks under a scope of its own (`device_<name>`), and the hub keeps its token through a restart.
//
// Västtrafik names no rate limit, only that use is kept to what is needed, so the relay sets its own: at most
// VT_PER_MINUTE calls in any minute, however many play, spent on the stop areas whose departures are oldest (each is
// asked about every minute or so), and the situations every five minutes. Data: CC0. Västtrafik's name is the source of the
// data, never a mark on the game.

import type { LiveDeparture } from '../src/game/city/liveMatch';
import type { Situation } from '../src/game/city/liveTrams';
import live from '../src/game/city/osm/live.json';
import { SourceError } from './feedCore';

export const VT_API = 'https://ext-api.vasttrafik.se';
/** Calls to Västtrafik in any minute, at most, token and situations included. */
export const VT_PER_MINUTE = 12;
/** Seconds a stop area's departures are served after they were fetched, while newer ones cannot be had. */
export const VT_KEEP = 3 * 60;
/**
 * How far ahead departures are asked for: the game plans the next half hour, and a trip is in the area some minutes
 * (`live.json`, where the busiest areas are split by platform so a call's list holds that span).
 */
const SPAN_MINUTES = live.span;
/** The most departures one call lists. */
const LIMIT = 100;
/** Calls of the minute's budget the departures leave for the token and the situations, and the most one load makes. */
const SPARE = 2;
const PER_LOAD = 4;
/** A token is fetched again this long before it runs out. */
const TOKEN_EARLY = 5 * 60;
const TIMEOUT_MS = 8000;

/** A departure as the game takes it (src/game/city/liveMatch.ts): platform, line, planned and expected epoch seconds, cancelled, direction. */
export type VtDeparture = LiveDeparture;

/** A traffic situation on the trams in the area, as the game takes it (src/game/city/liveTrams.ts). */
export type VtSituation = Situation;

/** Where the hub keeps its token between restarts. */
export interface TokenStore {
  read(): Promise<{ value: string; until: number } | null>;
  write(token: { value: string; until: number }): Promise<void>;
}

export interface VasttrafikOptions {
  /** The authentication key (base64 of `client id:secret`). */
  key: string;
  /** The relay's own scope for its token, so two relays do not take each other's. */
  device: string;
  /** Another address for the API (a stand-in in `scripts/worker-check.ts`). */
  base?: string;
  store?: TokenStore;
  log?: (message: string) => void;
}

interface ApiDeparture {
  serviceJourney?: { direction?: string; line?: { shortName?: string; designation?: string; name?: string; transportMode?: string } };
  stopPoint?: { gid?: string };
  plannedTime?: string;
  estimatedTime?: string | null;
  isCancelled?: boolean;
}

interface ApiSituation {
  situationNumber?: string;
  title?: string;
  description?: string;
  severity?: string;
  startTime?: string;
  endTime?: string | null;
  affectedStopPoints?: Array<{ gid?: string; stopAreaGid?: string }>;
  affectedLines?: Array<{ gid?: string; designation?: string; name?: string }>;
}

const AREAS = live.areas as Array<{ gid: string; name: string }>;
/** The calls for departures: an area's tram platforms, the busiest area's in two calls. */
const QUERIES = (live.queries as Array<{ gid: string; platforms: string[] }>).map((q) => ({ ...q, key: `${q.gid}|${q.platforms.join(',')}` }));
const LINES = live.lines as Array<{ line: string; gids: string[] }>;
const lineOf = new Map(LINES.flatMap(({ line, gids }) => gids.map((gid) => [gid, line] as [string, string])));
const areaGids = new Set(AREAS.map((a) => a.gid));
const epoch = (iso: string | null | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
};

/** A tram departure from the API, as the game takes it, or null for anything else. */
export function trimDeparture(d: ApiDeparture): VtDeparture | null {
  const line = d.serviceJourney?.line;
  const planned = epoch(d.plannedTime);
  const stop = d.stopPoint?.gid;
  const name = line?.shortName ?? line?.designation ?? line?.name;
  if (line?.transportMode !== 'tram' || planned === null || !stop || !name) return null;
  return [stop, name, planned, epoch(d.estimatedTime), d.isCancelled ? 1 : 0, d.serviceJourney?.direction ?? ''];
}

/** The situations that touch the trams in the area, still to come or not yet over at `now` (epoch seconds), as the game takes them. */
export function trimSituations(list: ApiSituation[], now: number): VtSituation[] {
  const out: VtSituation[] = [];
  for (const s of list) {
    const start = epoch(s.startTime), end = epoch(s.endTime);
    if (start === null || (end !== null && end < now) || start > now + 3600) continue;
    const lines = [...new Set((s.affectedLines ?? []).flatMap((l) => (l.gid && lineOf.has(l.gid) ? [lineOf.get(l.gid)!] : [])))];
    const points = (s.affectedStopPoints ?? []).filter((p) => p.stopAreaGid && areaGids.has(p.stopAreaGid));
    if (!lines.length && !points.length) continue;
    out.push({
      id: String(s.situationNumber ?? ''),
      title: (s.title ?? '').trim(),
      description: (s.description ?? '').trim(),
      severity: s.severity ?? 'normal',
      start,
      end,
      lines,
      areas: [...new Set(points.map((p) => p.stopAreaGid!))],
      stops: [...new Set(points.flatMap((p) => (p.gid ? [p.gid] : [])))],
    });
  }
  return out;
}

/** One relay's calls to Västtrafik: its token, its budget, and each stop area's last departures. */
export class Vasttrafik {
  private readonly base: string;
  private token: { value: string; until: number } | null = null;
  private stored: Promise<void> | null = null;
  private tokenLoad: Promise<string> | null = null;
  /** When each call of the last minute was made. */
  private readonly sent: number[] = [];
  /** Each call's last departures, and when they were fetched (ms). */
  private readonly lists = new Map<string, { departures: VtDeparture[]; at: number }>();
  /** The calls whose list came back full. */
  private readonly full = new Set<string>();
  private readonly log: (message: string) => void;

  constructor(private readonly options: VasttrafikOptions) {
    this.base = (options.base ?? VT_API).replace(/\/$/, '');
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** Takes up to `want` calls from the minute's budget. */
  budget(want: number, now = Date.now()): number {
    while (this.sent.length && now - this.sent[0] >= 60_000) this.sent.shift();
    const n = Math.max(0, Math.min(want, VT_PER_MINUTE - this.sent.length));
    for (let i = 0; i < n; i++) this.sent.push(now);
    return n;
  }

  /** The departures of every stop area fetched in the last few minutes, the oldest few fetched again as the budget allows. */
  async departures(): Promise<{ departures: VtDeparture[]; areas: number }> {
    const age = (key: string) => this.lists.get(key)?.at ?? 0;
    const due = [...QUERIES].sort((a, b) => age(a.key) - age(b.key)).filter((q) => Date.now() - age(q.key) > 30_000);
    // A few each time (the feed is loaded every 20 s), so the calls spread over the minute and no area waits two;
    // leaving calls for the token, should it be due, and the situations.
    this.budget(0);
    const room = this.budget(Math.max(0, Math.min(due.length, PER_LOAD, VT_PER_MINUTE - SPARE - this.sent.length)));
    const results = await Promise.allSettled(due.slice(0, room).map(async (q) => {
      const query = new URLSearchParams({
        timeSpanInMinutes: String(SPAN_MINUTES),
        maxDeparturesPerLineAndDirection: '12',
        limit: String(LIMIT),
        platforms: q.platforms.join(','),
      });
      const body = await this.get(`/pr/v4/stop-areas/${q.gid}/departures?${query}`, true) as { results?: unknown } | null;
      const results = Array.isArray(body?.results) ? (body.results as ApiDeparture[]) : [];
      // A full list may have been cut short: the span is then not all there. Said once, to split the area further.
      if (results.length >= LIMIT && !this.full.has(q.key)) {
        this.full.add(q.key);
        this.log(`Västtrafik's list for ${q.gid} (${q.platforms.join(',')}) is full at ${LIMIT}: split it further in live.json`);
      }
      const departures = results.map(trimDeparture).filter((d): d is VtDeparture => d !== null);
      this.lists.set(q.key, { departures, at: Date.now() });
    }));
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    const fresh = [...this.lists].filter(([, l]) => Date.now() - l.at < VT_KEEP * 1000);
    // Refused, or nothing to show: the feed pauses (feedCore.ts), the game keeps to the timetable.
    const refused = failures.find((e) => e instanceof SourceError && (e.status === 401 || e.status === 403 || e.status === 429));
    if (refused || (failures.length && !fresh.length)) throw refused ?? failures[0];
    return { departures: fresh.flatMap(([, l]) => l.departures), areas: fresh.length };
  }

  /** The traffic situations on the trams in the area. */
  async situations(): Promise<VtSituation[]> {
    if (!this.budget(1)) throw new SourceError('ext-api.vasttrafik.se: own budget spent', 429, 60_000);
    const list = await this.get('/ts/v1/traffic-situations', false);
    if (!Array.isArray(list)) throw new SourceError(`${new URL(this.base).host} situations not a list`, 502, 0);
    return trimSituations(list as ApiSituation[], Date.now() / 1000);
  }

  /**
   * A GET with the token, again with a new token if it was refused (the retry counted against the budget, or not made
   * when it is spent); refused again, the key is not good for this API, and the feed waits a long while. 404 (no
   * traffic there now) as null when `empty`.
   */
  private async get(path: string, empty: boolean): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.bearer();
      const response = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'accept-language': 'sv' } });
      if (response.status === 401 && attempt === 0) {
        // Only the token this call used: another call may have fetched a new one meanwhile.
        if (this.token?.value === token) this.token = null;
        if (!this.budget(1)) throw new SourceError(`${new URL(this.base).host} 401, own budget spent`, 401, 60_000);
        continue;
      }
      if (response.status === 404 && empty) return null;
      if (!response.ok) {
        const after = Number(response.headers.get('retry-after')) * 1000;
        const wait = response.status === 401 ? 10 * 60_000 : Number.isFinite(after) ? after : 0;
        throw new SourceError(`${new URL(this.base).host} ${response.status}`, response.status, wait);
      }
      return response.json();
    }
  }

  /** The token, fetched when there is none or it runs out within a few minutes (one fetch however many ask at once). */
  private async bearer(): Promise<string> {
    this.stored ??= (this.options.store?.read() ?? Promise.resolve(null)).then((t) => { this.token ??= t; }, () => {});
    await this.stored;
    if (this.token && this.token.until - TOKEN_EARLY > Date.now() / 1000) return this.token.value;
    this.tokenLoad ??= (async () => {
      // A token counts against the budget too (a call is always left for it, `SPARE`).
      if (!this.budget(1)) throw new SourceError(`${new URL(this.base).host} token, own budget spent`, 429, 60_000);
      const response = await fetch(`${this.base}/token`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Basic ${this.options.key}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: `device_${this.options.device}` }),
      });
      if (!response.ok) throw new SourceError(`${new URL(this.base).host} token ${response.status}`, response.status, response.status === 401 ? 10 * 60_000 : 0);
      const body = await response.json() as { access_token?: string; expires_in?: number };
      if (!body.access_token) throw new SourceError(`${new URL(this.base).host} token without a token`, 502, 0);
      this.token = { value: body.access_token, until: Date.now() / 1000 + (body.expires_in ?? 3600) };
      await this.options.store?.write(this.token).catch(() => {});
      return this.token.value;
    })().finally(() => { this.tokenLoad = null; });
    return this.tokenLoad;
  }
}
