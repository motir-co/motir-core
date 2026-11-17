import { describe, expect, it } from 'vitest';
import {
  STYLE_IDS,
  TOPO_BASE_STYLE,
  createTopography,
  drawerFor,
  hasTopoVariation,
  topoConfigFor,
  type BackgroundColours,
  type BackgroundFrameEnv,
} from '../src/index';
import {
  PALETTE_MODES,
  fixtureColours,
  recordingCanvasFactory,
  recordingContext,
  type Op,
} from './helpers/recordingCanvas';

const W = 480;
const H = 300;
const focus = { x: 180, y: 100, w: 120, h: 100 };
const light = fixtureColours('motir', 'light');

function frames(
  style: string,
  times: number[],
  colours: BackgroundColours = light,
  createCanvas?: BackgroundFrameEnv['createCanvas'],
): { ops: Op[][]; offscreen: number } {
  const d = createTopography();
  d.resize(W, H);
  const off = recordingCanvasFactory();
  const ops = times.map((t) => {
    const rec = recordingContext();
    d.frame(rec.ctx, t, {
      colours,
      style: style as never,
      focus,
      createCanvas: createCanvas ?? off.create,
    });
    return rec.ops;
  });
  return { ops, offscreen: off.made.length };
}

const sig = (ops: Op[]) => JSON.stringify(ops);

describe('Topography', () => {
  it('is the drawer registered for the topography id', () => {
    expect(drawerFor('topography')).toBe(createTopography);
  });

  it('has its own variation for every registered style', () => {
    for (const style of STYLE_IDS) expect(hasTopoVariation(style), style).toBe(true);
    expect(hasTopoVariation('not-a-style')).toBe(false);
  });

  it('covers its whole box first, under every style, palette and mode, and draws contours', () => {
    for (const style of STYLE_IDS)
      for (const { colours } of PALETTE_MODES) {
        const ops = frames(style, [2.5], colours).ops[0]!;
        const first = ops.findIndex((op) => op[0] === 'fillRect');
        expect(ops[first], style).toEqual(['fillRect', 0, 0, W, H]);
        expect(
          ops.filter((op) => op[0] === 'lineTo' || op[0] === 'rect').length,
          style,
        ).toBeGreaterThan(20);
      }
  }, 60_000);

  it('draws a visibly different variation under each style', () => {
    const seen = new Set(STYLE_IDS.map((style) => sig(frames(style, [1.1]).ops[0]!)));
    expect(seen.size).toBe(STYLE_IDS.length);
  });

  it('draws the base variation for a style id with no entry', () => {
    expect(topoConfigFor('a-style-registered-later')).toBe(topoConfigFor(TOPO_BASE_STYLE));
    const unknown = frames('a-style-registered-later', [3]).ops[0]!;
    expect(unknown.length).toBeGreaterThan(20);
    expect(sig(unknown)).toBe(sig(frames(TOPO_BASE_STYLE, [3]).ops[0]!));
  });

  it('drifts, steps Neo-Brutalism once a second, and holds High-Contrast still', () => {
    const [w0, w1] = frames('warm-editorial', [0, 6]).ops;
    expect(sig(w0!)).not.toBe(sig(w1!));
    const [n0, n1, n2] = frames('neo-brutalism', [0.1, 0.9, 1.1]).ops;
    expect(sig(n0!)).toBe(sig(n1!));
    expect(sig(n2!)).not.toBe(sig(n0!));
    const [s0, s1] = frames('high-contrast-accessible', [0, 30]).ops;
    expect(sig(s0!)).toBe(sig(s1!));
  });

  it('paints terraces into an off-screen canvas, and still draws its contours without one', () => {
    const withCanvas = frames('soft-playful', [0]);
    expect(withCanvas.offscreen).toBeGreaterThan(0);
    expect(withCanvas.ops[0]!.some((op) => op[0] === 'drawImage')).toBe(true);
    const without = frames('soft-playful', [0], light, () => null).ops[0]!;
    expect(without.some((op) => op[0] === 'drawImage')).toBe(false);
    expect(without.filter((op) => op[0] === 'lineTo').length).toBeGreaterThan(20);
  });

  it('draws a smaller grid on a narrow box', () => {
    const d = createTopography();
    d.resize(320, 480);
    const rec = recordingContext();
    d.frame(rec.ctx, 0, {
      colours: light,
      style: 'warm-editorial',
      focus,
      createCanvas: () => null,
    });
    expect(rec.ops[1]).toEqual(['fillRect', 0, 0, 320, 480]);
  });
});
