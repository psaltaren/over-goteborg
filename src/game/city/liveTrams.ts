// The trams on Västtrafik's live data: departures and traffic situations from the relay's shared copies (`feeds/vt`,
// `feeds/situations`, server/vasttrafik.ts), the departures matched to the trips (`liveMatch.ts`) and planned into the
// trip table (`livePlan.ts`), a millisecond each frame. Polled only while the game plays and live data is wanted; the
// relay asks Västtrafik once for everyone. Without a relay, without word for a few minutes, or turned off, the next half
// hour is planned as the timetable has it and the trams are back on it as they set out. The plans are this client's own:
// with live data on, two players may see a tram a little apart, as on the metro's real trains. No three.js.

import { feedOff, relayFeed } from '../relay';
import type { Blocks } from './blocks';
import { LiveMatcher, type LiveDeparture } from './liveMatch';
import { LivePlanner, type Live } from './livePlan';
import type { TripTable } from './tripTable';

/** A traffic situation on the trams in the city, as the relay passes it on (server/vasttrafik.ts). */
export interface Situation {
  id: string;
  title: string;
  description: string;
  severity: string;
  /** From and until when (epoch seconds; `end` null when open). */
  start: number;
  end: number | null;
  /** The tram lines in the area it touches, by name, and its stop areas and platforms there, by gid. */
  lines: string[];
  areas: string[];
  stops: string[];
}

/**
 * What the trams follow: Västtrafik live, the timetable by choice, the timetable while waiting for word (or word that
 * fits no trip), for want of it, or because the relay has no key for Västtrafik (`unavailable`: nothing to choose).
 */
export type LiveStatus = 'live' | 'off' | 'waiting' | 'failed' | 'unavailable';

/** How often the departures are asked for, and the situations, in ms; and how often a relay without the key is asked again. */
const POLL = 30_000;
const SITUATIONS = 5 * 60_000;
const POLL_OFF = 10 * 60_000;
/**
 * How long word is followed after it came, in ms, by this device's clock, whatever it says the time is: the relay's
 * copy is a few minutes old at most when it comes. The situations are kept longer, being asked for less often.
 */
const STALE = 4 * 60_000;
const SITUATIONS_STALE = 15 * 60_000;
/** How often the next half hour is planned again, in seconds of the game's clock. */
const PLAN_EVERY = 30;
/** Milliseconds a frame gives the matching and planning at most. */
const BUDGET_MS = 1;

/** What the live trams need of the trams' data (`tramData.ts`). */
export interface LiveData {
  table: TripTable;
  blocks: Blocks;
  /** Fetches where the block pass held the trips of the days running at an epoch; true once they are here. */
  ensureHolds(epoch: number): Promise<boolean>;
}

export class LiveTrams {
  private readonly planner: LivePlanner;
  private readonly matcher: LiveMatcher;
  private departures: LiveDeparture[] = [];
  /** When the last departures came (this device's ms), 0 for never; and the situations. */
  private heard = 0;
  private situationsHeard = 0;
  private situationList: Situation[] = [];
  private failures = 0;
  private nextPoll = 0;
  private nextSituations = 0;
  private polling = false;
  /** Whether the holds of the days running are here, which matching needs. */
  private holdsReady = false;
  private steps: Generator<void, void> | null = null;
  private planAt = -Infinity;
  /** The game's clock as of the last frame, for a planning to check it is still in time when it is done. */
  private clock = 0;
  private wanted: boolean;
  /** How many trips the last matching found word of. */
  private matched = 0;
  /** What the last planning followed, for `__us`. */
  live: ReadonlyMap<number, Live> = new Map();

  constructor(private readonly data: LiveData, wanted: boolean) {
    this.planner = new LivePlanner(data.table, data.blocks);
    this.matcher = new LiveMatcher(data.table);
    this.wanted = wanted;
  }

  get enabled(): boolean {
    return this.wanted;
  }

  /** Live data on or off: off, the trams go back to the timetable as they set out, and nothing more is asked. */
  setEnabled(on: boolean): void {
    this.wanted = on;
    this.nextPoll = 0;
    this.nextSituations = 0;
    this.planAt = -Infinity;
  }

  /** What the trams follow now. */
  get status(): LiveStatus {
    if (feedOff('vt')) return 'unavailable';
    if (!this.wanted) return 'off';
    if (this.fresh() && this.matched > 0) return 'live';
    return this.failures >= 2 ? 'failed' : 'waiting';
  }

  /** The traffic situations to show: none while live data is off, or when no word of them has come for a while. */
  get situations(): Situation[] {
    return this.wanted && Date.now() - this.situationsHeard < SITUATIONS_STALE ? this.situationList : [];
  }

  get stats(): LivePlanner['stats'] {
    return this.planner.stats;
  }

  /** Every frame, with the game's clock `epoch` (seconds): asks the relay when due, and matches and plans a little. */
  update(epoch: number): void {
    this.clock = epoch;
    const now = Date.now();
    if (this.wanted && !this.polling && now >= this.nextPoll) void this.poll(now, epoch);
    if (!this.steps && epoch - this.planAt >= PLAN_EVERY) {
      this.planAt = epoch;
      const word = this.wanted && this.fresh() && this.holdsReady;
      // Nothing to plan without word and with every trip on the timetable: it is clear of clashes as it is.
      if (word || this.data.table.planned) this.steps = this.planning(epoch, word);
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

  /** A matching of the word as the clock has it (none: the timetable), then a planning with it; again at once if it came too late. */
  private *planning(epoch: number, word: boolean): Generator<void, void> {
    const live = word ? yield* this.matcher.matchSteps(this.departures, epoch) : new Map<number, Live>();
    if (word) this.matched = live.size;
    this.live = live;
    if (!(yield* this.planner.update(epoch, live, () => this.clock))) this.planAt = -Infinity;
  }

  /** Asks the relay for the departures, and for the situations when they are due. */
  private async poll(now: number, epoch: number): Promise<void> {
    this.polling = true;
    this.nextPoll = now + POLL;
    try {
      const vt = await relayFeed<{ departures: LiveDeparture[] }>('vt');
      if (vt && Array.isArray(vt.data.departures)) {
        this.departures = vt.data.departures;
        this.heard = Date.now();
        this.failures = 0;
        // The holds the matching needs, fetched once a day; new word planned with at once rather than at the next turn.
        this.holdsReady = await this.data.ensureHolds(epoch).catch(() => false);
        this.planAt = -Infinity;
      } else if (feedOff('vt')) this.nextPoll = now + POLL_OFF;
      else this.failures++;
      if (now >= this.nextSituations && !feedOff('vt')) {
        this.nextSituations = now + SITUATIONS;
        const situations = await relayFeed<Situation[]>('situations');
        if (situations && Array.isArray(situations.data)) {
          this.situationList = situations.data;
          this.situationsHeard = Date.now();
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private fresh(): boolean {
    return this.heard > 0 && Date.now() - this.heard < STALE;
  }
}

/** The situations in force at `epoch` that touch a line, a stop area or a platform. */
export function situationsFor(situations: Situation[], epoch: number, touch: { lines?: string[]; area?: string; stop?: string }): Situation[] {
  return situations.filter((s) => s.start <= epoch && (s.end === null || s.end > epoch) && (
    (touch.lines ?? []).some((l) => s.lines.includes(l)) || (touch.area !== undefined && s.areas.includes(touch.area)) || (touch.stop !== undefined && s.stops.includes(touch.stop))
  ));
}
