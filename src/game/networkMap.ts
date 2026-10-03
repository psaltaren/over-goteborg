// Where the metro's stations sit on the HUD's map: apart from the station builder, so the HUD can be had without the
// metro's world and its map data (the city's game uses the HUD with no map).

import type { Network } from './line';

/** The HUD map's size, in its own pixels. */
export const NETWORK_MAP = { w: 1500, h: 1150 };

/** Where each station of the network sits on the HUD map, in `NETWORK_MAP` pixels. */
export function networkMapLayout(net: Network): Array<{ x: number; y: number; label: 'above' | 'below' }> {
  return net.stations.map((s, i) => ({ x: s.map[0] * NETWORK_MAP.w, y: s.map[1] * NETWORK_MAP.h, label: i % 2 ? 'below' : 'above' }));
}
