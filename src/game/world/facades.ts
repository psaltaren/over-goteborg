// The facade textures shared by the city's buildings and the metro's open-air scenery and station streets: a modern
// facade (flats, offices) and an old one (stone city blocks). Kept apart from the builders that use them, so that a
// module needing a texture does not import the metro's open-air builders and, with them, their map data.

import type { Texture } from 'three';
import { cached, canvas, finish } from '../gfx/textures';

/** A block of flats' facade: rows of windows every storey, three metres apart. */
export function facadeTexture(): Texture {
  return cached('facade', () => {
    const [c, ctx] = canvas(64, 64);
    ctx.fillStyle = '#e8e4da';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#39424c';
    ctx.fillRect(14, 16, 36, 30);
    ctx.fillStyle = '#d8d4c8';
    ctx.fillRect(31, 16, 2, 30);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.fillRect(0, 60, 64, 4);
    return finish(c, 3);
  });
}

/** An old town house's facade: plastered wall, tall windows with pale frames, a cornice every storey. */
export function oldFacadeTexture(): Texture {
  return cached('old-facade', () => {
    const [c, ctx] = canvas(64, 64);
    ctx.fillStyle = '#ece6d8';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#f8f4ea';
    ctx.fillRect(18, 8, 28, 44);
    ctx.fillStyle = '#2c343c';
    ctx.fillRect(21, 11, 22, 38);
    ctx.fillStyle = '#e8e2d4';
    ctx.fillRect(31, 11, 2, 38);
    ctx.fillRect(21, 26, 22, 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.fillRect(0, 58, 64, 6);
    return finish(c, 3.2);
  });
}
