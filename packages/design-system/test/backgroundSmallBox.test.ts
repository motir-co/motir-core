import { describe, expect, it } from 'vitest';
import { BACKGROUND_DRAWERS, BACKGROUND_IDS, STYLE_IDS } from '../src/index';
import {
  fixtureColours,
  recordingCanvasFactory,
  recordingContext,
} from './helpers/recordingCanvas';

// MOTIR-11672: motir.co's /design draws each background as a 26×14 chip swatch.
// Bento's Wave and Topography lay out a tile grid with 10px gutters, which in a
// box that small gives tiles of negative size — and a negative `arcTo` radius,
// which a browser throws on. The recording context throws the same way, so a
// frame that would throw on a real canvas fails here.
const SMALL_BOXES: Array<[number, number]> = [
  [26, 14],
  [40, 40],
  [1, 1],
];

describe('every background in a box smaller than its own layout', () => {
  for (const [W, H] of SMALL_BOXES)
    it(`draws a ${W}×${H} frame under every style, light and dark, without throwing`, () => {
      const focus = { x: 0, y: 0, w: W, h: H };
      for (const id of BACKGROUND_IDS) {
        const factory = BACKGROUND_DRAWERS[id];
        if (!factory) continue;
        for (const style of STYLE_IDS)
          for (const mode of ['light', 'dark'] as const) {
            const d = factory();
            d.resize(W, H);
            const off = recordingCanvasFactory();
            const rec = recordingContext();
            expect(() =>
              d.frame(rec.ctx, 1.3, {
                colours: fixtureColours('motir', mode),
                style: style as never,
                focus,
                createCanvas: off.create,
              }),
            ).not.toThrow();
          }
      }
    }, 60_000);
});
