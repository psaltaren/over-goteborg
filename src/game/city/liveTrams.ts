// The trams on Västtrafik's live data: departures and traffic situations from the relay's shared copies (`feeds/vt`,
// `feeds/situations`, server/vasttrafik.ts), the departures matched to the trips (`liveMatch.ts`) and planned into the
// trip table (`livePlan.ts`) a little each frame. Polled only while the game plays and live data is wanted; the relay
// asks Västtrafik once for everyone. Without a relay, without word for a few minutes, or turned off, the next half
// hour is planned as the timetable has it and the trams are back on it as they set out. No three.js.

import { feedOff, relayFeed } from '../relay';
import type { Blocks } from './blocks';
import { LiveMatcher, type LiveDeparture } from './liveMatch';
import { LivePlanner, type Live } from './livePlan';
import type { TripTable } from './tripTable';

/** A traffic situation on the trams in the city, as the relay passes it on (server/vasttrafik.ts, `VtSituation`). */
export interface Situation {
  id: string;
  title: string;
  description: string;
  severity: string;
  start: number;
  end: number | null;
  lines: string[];
  areas: string[];
  stops: string[];
}

/**
 * What the trams follow: Västtrafik live, the timetable by choice, the timetable while waiting for word or for want of
 * it, or the timetable because the relay has no key for Västtrafik (`unavailable`: nothing to choose).
 */
export type LiveStatus = 'live' | 'off' | 'waiting' | 'failed' | 'unavailable';

/** How often the departures are asked for, and the situations, in ms; and how often a relay without the key is asked again. */
const POLL = 30_000;
const POLL_OFF = 10 * 60_000;
const SITUATIONS = 5 * 60_000;
/** How old the relay's copy may be before the trams go back to the timetable (seconds): a few of the relay's minutes. */
const STALE = 4 * 60;
/** How often the next half hour is planned again, in seconds of the game's clock. */
const PLAN_EVERY = 30;
/** Milliseconds a frame gives the planning at most. */
const BUDGET_MS = 1;

export class LiveTrams {
  private readonly planner: LivePlanner;
  private readonly matcher: LiveMatcher;
  private departures: LiveDeparture[] = [];
  /** When the relay fetched the departures it gave last (epoch seconds), 0 for never. */
  private heard = 0;
  private failures = 0;
  private nextPoll = 0;
  private nextSituations = 0;
  private polling = false;
  private steps: Generator<void, void> | null = null;
  private planAt = -Infinity;
  private wanted: boolean;
  /** The traffic situations on the trams in the city, newest word. */
  situations: Situation[] = [];
  /** What the last planning followed, for `__us`. */
  live: ReadonlyMap<number, Live> = new Map();

  constructor(private readonly table: TripTable, blocks: Blocks, wanted: boolean) {
    this.planner = new LivePlanner(table, blocks);
    this.matcher = new LiveMatcher(table);
    this.wanted = wanted;
  }

  get enabled(): boolean {
    return this.wanted;
  }

  /** Live data on or off: off, the trams go back to the timetable as they set out, and nothing more is asked. */
  setEnabled(on: boolean): void {
    this.wanted = on;
    this.nextPoll = 0;
    this.planAt = -Infinity;
  }

  /** What the trams follow now. */
  get status(): LiveStatus {
    if (feedOff('vt')) return 'unavailable';
    if (!this.wanted) return 'off';
    if (this.fresh(Date.now() / 1000)) return 'live';
    return this.failures >= 2 ? 'failed' : 'waiting';
  }

  get stats(): LivePlanner['stats'] {
    return this.planner.stats;
  }

  /** Every frame, with the game's clock `epoch` (seconds): asks the relay when due, and plans a little. */
  update(epoch: number): void {
    const now = Date.now();
    if (this.wanted && !this.polling && now >= this.nextPoll) void this.poll(now);
    if (!this.steps && epoch - this.planAt >= PLAN_EVERY) {
      this.planAt = epoch;
      // The word as the clock has it now; the timetable when it is old, turned off or not here.
      this.live = this.wanted && this.fresh(now / 1000) ? this.matcher.match(this.departures, epoch) : new Map();
      // Nothing to plan without word and with every trip on the timetable: it is clear of clashes as it is.
      if (this.live.size || this.table.planned) this.steps = this.planner.update(epoch, this.live);
    }
    if (!this.steps) return;
    const until = performance.now() + BUDGET_MS;
    do {
      if (this.steps.next().done) {
        this.steps = null;
        break;
      }
    } while (performance.now() < until);
  }

  /** Plans the next half hour at once: while the game loads, before the first frame. */
  planNow(epoch: number): void {
    this.steps = null;
    this.planAt = epoch;
    this.planner.plan(epoch, this.wanted && this.fresh(Date.now() / 1000) ? this.matcher.match(this.departures, epoch) : new Map());
  }

  /** Asks the relay for the departures, and for the situations when they are due. */
  private async poll(now: number): Promise<void> {
    this.polling = true;
    this.nextPoll = now + POLL;
    try {
      const vt = await relayFeed<{ departures: LiveDeparture[] }>('vt');
      if (vt && Array.isArray(vt.data.departures)) {
        this.departures = vt.data.departures;
        this.heard = vt.at;
        this.failures = 0;
        // New word: planned with it at once rather than at the next turn.
        this.planAt = -Infinity;
      } else if (feedOff('vt')) this.nextPoll = now + POLL_OFF;
      else this.failures++;
      if (now >= this.nextSituations && !feedOff('vt')) {
        this.nextSituations = now + SITUATIONS;
        const situations = await relayFeed<Situation[]>('situations');
        if (situations && Array.isArray(situations.data)) this.situations = situations.data;
      }
    } finally {
      this.polling = false;
    }
  }

  private fresh(nowSeconds: number): boolean {
    return this.heard > 0 && nowSeconds - this.heard < STALE;
  }
}

/** The situations in force at `epoch` that touch a line, a stop area or a platform. */
export function situationsFor(situations: Situation[], epoch: number, touch: { lines?: string[]; area?: string; stop?: string }): Situation[] {
  return situations.filter((s) => s.start <= epoch && (s.end === null || s.end > epoch) && (
    (touch.lines ?? []).some((l) => s.lines.includes(l)) || (touch.area !== undefined && s.areas.includes(touch.area)) || (touch.stop !== undefined && s.stops.includes(touch.stop))
  ));
}

/** The stop area a platform (a stop point gid) belongs to. */
export const areaOf = (stop: string) => `${stop.slice(0, 3)}1${stop.slice(4, 13)}000`;
