// Which of Västtrafik's timetables runs on a date, and when its service day starts. The timetable is kept for a
// weekday, a Saturday and a Sunday (`schedule.ts`); a public holiday runs Sunday's, and the eves of the big ones
// Saturday's, as Västtrafik runs them. Times in a timetable count from noon less twelve hours, as GTFS has it (local
// midnight, but an hour off on the days the clocks change), and run on past 24 h into the night. No three.js.

import { stockholm, stockholmEpoch } from '../clock';
import type { Day } from './schedule';

/** Easter Sunday of `year` (the Gregorian computus, Meeus/Jones/Butcher): [month, day]. */
export function easter(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month, ((h + l - 7 * m + 114) % 31) + 1];
}

/** A date `days` after another, as [year, month, day]. */
function shift(year: number, month: number, day: number, days: number): [number, number, number] {
  const d = new Date(Date.UTC(year, month - 1, day + days, 12));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** Sweden's public holidays and the eves Västtrafik runs as Saturdays, in a year: `MM-DD` to the timetable they run. */
function holidays(year: number): Map<string, Day> {
  const key = (m: number, d: number) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const [em, ed] = easter(year);
  const fromEaster = (days: number) => {
    const [, m, d] = shift(year, em, ed, days);
    return key(m, d);
  };
  // Midsummer Eve is the Friday between 19 and 25 June, All Saints' Day the Saturday between 31 October and 6 November.
  const firstWeekday = (m: number, from: number, weekday: number) => {
    for (let d = from; ; d++) if (new Date(Date.UTC(year, m - 1, d, 12)).getUTCDay() === weekday) return shift(year, m, d, 0);
  };
  const [, mm, md] = firstWeekday(6, 19, 5);
  const [, am, ad] = firstWeekday(10, 31, 6);
  const [, sm, sd] = shift(year, mm, md, 1);
  return new Map<string, Day>([
    ['01-01', 'sunday'], ['01-06', 'sunday'], [fromEaster(-2), 'sunday'], [fromEaster(1), 'sunday'], ['05-01', 'sunday'],
    [fromEaster(39), 'sunday'], ['06-06', 'sunday'], [key(sm, sd), 'sunday'], [key(am, ad), 'sunday'], ['12-25', 'sunday'],
    ['12-26', 'sunday'], [key(mm, md), 'saturday'], ['12-24', 'saturday'], ['12-31', 'saturday'],
  ]);
}

const years = new Map<number, Map<string, Day>>();

/** The timetable a Stockholm date runs: Sunday's on a public holiday, Saturday's on Midsummer, Christmas and New Year's Eve. */
export function dayType(year: number, month: number, day: number): Day {
  if (!years.has(year)) years.set(year, holidays(year));
  const special = years.get(year)!.get(`${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  if (special) return special;
  const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return weekday === 0 ? 'sunday' : weekday === 6 ? 'saturday' : 'weekday';
}

/** Where a date's service day starts, in epoch seconds: noon less twelve hours. */
export function serviceStart(year: number, month: number, day: number): number {
  return stockholmEpoch(year, month, day, 12) - 43_200;
}

/** A service day: its timetable and its start in epoch seconds. */
export interface ServiceDay {
  day: Day;
  start: number;
}

/** The service days whose trams may run at `epoch`: yesterday's (its night, past 24 h) and today's. */
export function serviceDays(epoch: number): [ServiceDay, ServiceDay] {
  const c = stockholm(epoch);
  const [y, m, d] = shift(c.year, c.month, c.day, -1);
  return [
    { day: dayType(y, m, d), start: serviceStart(y, m, d) },
    { day: dayType(c.year, c.month, c.day), start: serviceStart(c.year, c.month, c.day) },
  ];
}
