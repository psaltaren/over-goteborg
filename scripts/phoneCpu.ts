// The emulated phone's CPU, the same whichever computer runs the timings. Chrome's throttling divides whatever the
// computer has: "six times slower" was one speed on the Mac the floors were set on, another on an M4 Pro, and another
// again on the same Mac on battery in Low Power Mode, so a scene could fail by the machine and the charger rather than
// by the code. Instead the phone is a fixed speed on the scale of `benchmark` below (after Lighthouse's
// benchmarkIndex: string building, which makes garbage, and array copying, which does not), and each run measures
// this computer on that scale and throttles by the ratio. Used by `fps.ts` and `load.ts`.

import type { CDPSession, Page } from 'puppeteer-core';

/**
 * The phone on the scale of `benchmark`. An M4 Pro on the charger scores about 25 500, so this is it four times slower:
 * Lighthouse's own setting for a fast laptop as a mid-range phone. The floors in `scripts/check.ts` assume this phone.
 */
export const PHONE_SPEED = 6400;

/** Run in the page: iterations per second of two small workloads, averaged. About a second. */
function benchmark(): number {
  const strings = () => {
    const start = performance.now();
    let n = 0;
    while (performance.now() - start < 500) {
      let s = '';
      for (let j = 0; j < 1000; j++) s += 'a';
      n++;
    }
    return n / 10 / ((performance.now() - start) / 1000);
  };
  const arrays = () => {
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 100_000; i++) a[i] = b[i] = i;
    const start = performance.now();
    let n = 0;
    while (n % 10 !== 0 || performance.now() - start < 500) {
      const [from, to] = n % 2 ? [b, a] : [a, b];
      for (let j = 0; j < from.length; j++) to[j] = from[j];
      n++;
    }
    return n / 10 / ((performance.now() - start) / 1000);
  };
  return Math.round((strings() + arrays()) / 2);
}

/**
 * Throttles the page's CPU down to the phone: measures this computer unthrottled (the best of three, so a stray
 * moment of other work does not make the phone faster) and slows it by the ratio. Call it before the page loads
 * anything heavy. Returns the rate and the score, for the report.
 */
export async function throttleToPhone(page: Page, cdp: CDPSession): Promise<{ rate: number; host: number }> {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  let host = 0;
  for (let i = 0; i < 3; i++) host = Math.max(host, (await page.evaluate(benchmark)) as number);
  const rate = Math.max(1, Math.round((host / PHONE_SPEED) * 10) / 10);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return { rate, host };
}

/** How the throttling is described in a report. */
export const describeThrottle = ({ rate, host }: { rate: number; host: number }) =>
  `CPU ${rate}x slower (this computer ${host}, the phone ${PHONE_SPEED})`;
