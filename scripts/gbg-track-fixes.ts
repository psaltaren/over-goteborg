/**
 * Hand fixes to the tram tracks as OpenStreetMap has them, applied by `scripts/gbg-osm.ts` before the graph is built.
 * Each fix says why: what OSM has, what the street has, and how it was seen (a test, a look at the map). Better still,
 * fix OSM itself and drop the line here once the fix has come through.
 */
export interface TrackFixes {
  /** Ways left out altogether: a depot track no line runs on, a track drawn twice. */
  drop: number[];
  /** Which way a way is run, where OSM has it wrong or leaves it out: 1 along its nodes, -1 against them, 0 both ways. */
  direction: Record<number, 1 | -1 | 0>;
  /** Turns from one way to the next that the angle alone would allow but the switch does not: [way in, way out]. */
  forbid: Array<[number, number]>;
  /**
   * Junctions (OSM nodes) where the curve through may stay tighter than 18 m: switches OSM draws too close together to
   * ease, each with the least radius accepted there and why. The tests hold every other junction to 18 m.
   */
  tight: Record<number, { radius: number; why: string }>;
}

export const FIXES: TrackFixes = {
  drop: [],
  direction: {
    // Nils Ericsonsplatsen, the eastern track north of the junction: a terminal track run both ways. Trams for the lines
    // that end at Nils Ericsonsplatsen run up it to platform C and back (Gothenburg's trams have a cab at each end), as
    // Västtrafik's shapes show. OSM leaves most of it untagged (both ways) but tags these two short ways one way, which
    // cut platform C off from the south: runs to C were left out, 98 m off their track (October 2026).
    1291064387: 0,
    1291064388: 0,
  },
  forbid: [],
  // None at present (October 2026): every junction eases to 18 m.
  tight: {},
};
