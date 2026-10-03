import { describe, expect, test } from 'bun:test';
import { stockholm, stockholmEpoch } from '../src/game/clock';
import { dayType, easter, serviceDays, serviceStart } from '../src/game/city/serviceDay';

describe('the timetable a day runs', () => {
  test('finds Easter', () => {
    expect(easter(2024)).toEqual([3, 31]);
    expect(easter(2025)).toEqual([4, 20]);
    expect(easter(2026)).toEqual([4, 5]);
    expect(easter(2027)).toEqual([3, 28]);
    expect(easter(2038)).toEqual([4, 25]);
  });

  test('runs Sunday\'s on public holidays and Saturday\'s on the big eves', () => {
    const cases: Array<[number, number, number, string]> = [
      [2026, 10, 7, 'weekday'], [2026, 10, 10, 'saturday'], [2026, 10, 11, 'sunday'],
      [2026, 1, 1, 'sunday'], [2026, 1, 6, 'sunday'], [2026, 4, 3, 'sunday'], [2026, 4, 6, 'sunday'], [2026, 5, 1, 'sunday'],
      [2026, 5, 14, 'sunday'], [2026, 6, 6, 'sunday'], [2026, 6, 19, 'saturday'], [2026, 6, 20, 'sunday'],
      [2026, 10, 31, 'sunday'], [2026, 12, 24, 'saturday'], [2026, 12, 25, 'sunday'], [2026, 12, 26, 'sunday'],
      [2026, 12, 31, 'saturday'], [2027, 6, 25, 'saturday'], [2027, 11, 6, 'sunday'],
    ];
    for (const [y, m, d, day] of cases) expect(`${y}-${m}-${d} ${dayType(y, m, d)}`).toBe(`${y}-${m}-${d} ${day}`);
    // A year has about 250 weekdays' timetables.
    let weekdays = 0;
    for (let k = 0; k < 365; k++) {
      const d = new Date(Date.UTC(2027, 0, 1 + k, 12));
      if (dayType(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) === 'weekday') weekdays++;
    }
    expect(weekdays).toBeGreaterThan(245);
    expect(weekdays).toBeLessThan(255);
  });

  test('starts a service day at noon less twelve hours: midnight, but an hour off when the clocks change', () => {
    expect(stockholm(serviceStart(2026, 10, 7)).hour).toBe(0);
    // Summer time begins 29 March 2026: noon is in summer time, twelve hours before it 23:00 the evening before.
    expect(stockholm(serviceStart(2026, 3, 29)).hour).toBe(23);
    // And ends 25 October: twelve hours before noon is 01:00 that night.
    expect(stockholm(serviceStart(2026, 10, 25)).hour).toBe(1);
  });

  test('has yesterday\'s night and today\'s day running at any moment', () => {
    const at = stockholmEpoch(2026, 10, 12, 0, 30);
    const [yesterday, today] = serviceDays(at);
    expect(yesterday.day).toBe('sunday');
    expect(today.day).toBe('weekday');
    expect(at - yesterday.start).toBeCloseTo(86_400 + 1800, 0);
    expect(at - today.start).toBeCloseTo(1800, 0);
  });
});
