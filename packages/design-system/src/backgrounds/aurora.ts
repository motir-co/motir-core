// Aurora — seven soft filled bands drifting, the shared colour shifting through
// the palette's three wave hues. Ported from dooooWeb's `LoginAurora` (the band
// layout and the three summed sines), with its fixed ten-hue table replaced by
// the palette's own wave hues. Same in every style: it never reads the style.

import { cycleRgb, rgba } from './colour';
import type { BackgroundDrawer, BackgroundDrawerFactory } from './types';

const BANDS = 7;
/** How fast the shared colour moves round the three hues, in hues per second. */
const COLOUR_SPEED = 0.06;

export const createAurora: BackgroundDrawerFactory = (): BackgroundDrawer => {
  let W = 0;
  let H = 0;
  return {
    resize(width, height) {
      W = width;
      H = height;
    },
    frame(ctx, t, env) {
      const c = env.colours;
      ctx.globalAlpha = 1;
      ctx.fillStyle = rgba(c.bg);
      ctx.fillRect(0, 0, W, H);
      // The source was drawn for a ~1400×900 window; scale it to this box.
      const sy = H / 900;
      const sx = Math.max(W / 1400, 0.35);
      const colour = cycleRgb(c.hues, t * COLOUR_SPEED);
      // A dark page carries the bands at full strength; a light one softer.
      const strength = c.dark ? 1 : 0.6;
      for (let i = 0; i < BANDS; i++) {
        const tb = i / (BANDS - 1);
        const baseY = (0.08 + tb * 0.7) * H;
        const amp = (50 + i * 25) * sy;
        const wl = (250 + i * 70) * sx;
        const thick = (70 + i * 25) * sy;
        const op = (0.35 + (1 - tb) * 0.25) * strength;
        const ph = t * (0.3 + i * 0.06) + i;
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let x = 0; x <= W + 4; x += 4) {
          const y =
            baseY +
            Math.sin(x / wl + ph) * amp +
            Math.sin(x / (wl * 0.6) + ph * 1.3) * amp * 0.4 +
            Math.sin(x / (wl * 1.8) + ph * 0.7) * amp * 0.25;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, baseY - thick, 0, baseY + thick * 2);
        g.addColorStop(0, rgba(colour, 0));
        g.addColorStop(0.15, rgba(colour, op));
        g.addColorStop(0.4, rgba(colour, op * 0.9));
        g.addColorStop(0.7, rgba(colour, op * 0.55));
        g.addColorStop(1, rgba(colour, 0));
        ctx.fillStyle = g;
        ctx.fill();
      }
    },
  };
};
