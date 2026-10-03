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
  drop: [
    // Nils Ericsonsplatsen: a diagonal from the turning loop across both tracks north of the stop, drawn without a
    // direction, meeting the tracks at about 45 degrees and crossing between them in 6 m (a crossover between tracks
    // 3.2 m apart needs about 15 m at 18 m radius). No tram could take it as drawn. Seen as the one link the easing could
    // not bring to 18 m, and as dead ends either side of it (October 2026). Back in, redrawn, if a line needs it.
    207339529,
  ],
  direction: {
    // Lilla Bommen to Nils Ericsonsplatsen, the eastern track: one track run south, drawn as oneway ways with these
    // stretches between them untagged, so they read as run both ways and the northbound half dead-ended at both ends.
    1087521825: 1,
    1291064386: 1,
    1291064385: 1,
    1291064384: 1,
    1291064383: 1,
  },
  forbid: [],
  // None at present (October 2026): every junction eases to 18 m.
  tight: {},
};
