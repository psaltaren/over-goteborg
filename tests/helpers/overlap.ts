// Whether trams overlap: each tram's sections as rectangles in the plane, tried pair by pair by the separating axes.
// Shared by the timetable's test (tests/trip-table.test.ts) and the live plan's (tests/live-plan.test.ts).

import schedule from '../../src/game/city/osm/schedule.json';
import tracks from '../../src/game/city/osm/tracks.json';
import { onTrack, TramPath, type SectionPose } from '../../src/game/city/path';
import type { ScheduleFile } from '../../src/game/city/schedule';
import { readLinks, type TrackFile } from '../../src/game/city/trackData';
import type { TramState } from '../../src/game/city/tripTable';
import { TRAM_JOINT, TRAM_SECTION_ENDS, TRAM_WIDTH } from '../../src/game/layout';

export const file = schedule as unknown as ScheduleFile;
export const links = readLinks(tracks as unknown as TrackFile);
const paths = file.runs.map((r) => new TramPath(r, links));

/**
 * A tram's sections as rectangles in the plane (middle, facing, half length), those wholly on its run's track: past
 * either end of a run the track goes on straight out of sight, where the game draws no section (`onTrack`).
 */
function footprint(st: TramState): Array<SectionPose & { hl: number }> {
  const length = file.runs[st.run].length;
  return paths[st.run].sections(st.s, TRAM_SECTION_ENDS)
    .map((p, k) => ({ ...p, hl: (TRAM_SECTION_ENDS[k + 1] - TRAM_SECTION_ENDS[k] - TRAM_JOINT) / 2, on: onTrack(st.s, k, length) }))
    .filter((p) => p.on);
}

/** How far two rectangles overlap, by the separating axes: 0 or less when they do not. */
function overlap(a: SectionPose & { hl: number }, b: SectionPose & { hl: number }, hw: number): number {
  let least = Infinity;
  for (const [ax, az] of [[a.dx, a.dz], [-a.dz, a.dx], [b.dx, b.dz], [-b.dz, b.dx]]) {
    const reach = (r: typeof a) => Math.abs(r.hl * (r.dx * ax + r.dz * az)) + Math.abs(hw * (-r.dz * ax + r.dx * az));
    const gap = Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) - reach(a) - reach(b);
    least = Math.min(least, -gap);
  }
  return least;
}

/** The trams in `states` that overlap one another, as lines saying where (at moment `t`, epoch seconds). */
export function overlaps(states: TramState[], t: number): string[] {
  const hw = TRAM_WIDTH / 2;
  const found: string[] = [];
  const prints = states.map(footprint);
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const [a, b] = [prints[i], prints[j]];
      if (!a.length || !b.length || Math.hypot(a[0].x - b[0].x, a[0].z - b[0].z) > 100) continue;
      for (const p of a) for (const q of b) {
        const d = overlap(p, q, hw);
        if (d > 0.01) found.push(`${new Date(t * 1000).toISOString()} trams ${states[i].line} ${states[i].headsign} and ${states[j].line} ${states[j].headsign} overlap ${d.toFixed(2)} m at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`);
      }
    }
  }
  return found;
}
