import { describe, expect, it } from 'vitest';
import { STYLE_IDS, createAurora, drawClearArea, type BackgroundFrameEnv } from '../src/index';
import {
  PALETTE_MODES,
  fixtureColours,
  recordingCanvasFactory,
  recordingContext,
} from './helpers/recordingCanvas';

const W = 640;
const H = 400;

function draw(env: Omit<BackgroundFrameEnv, 'createCanvas'>, t = 1.25) {
  const { ctx, ops } = recordingContext();
  const aurora = createAurora();
  aurora.resize(W, H);
  aurora.frame(ctx, t, { ...env, createCanvas: recordingCanvasFactory().create });
  return ops;
}

const focus = { x: 200, y: 150, w: 240, h: 100 };

describe('Aurora', () => {
  it('renders a frame under every style × palette × mode without throwing', () => {
    for (const style of STYLE_IDS) {
      for (const { colours } of PALETTE_MODES) {
        expect(() => draw({ colours, style, focus })).not.toThrow();
      }
    }
  });

  it('fills its whole box with the page colour first, so the first frame covers the screen', () => {
    const ops = draw(
      { colours: fixtureColours('motir', 'light'), style: 'warm-editorial', focus },
      0,
    );
    const firstFill = ops.findIndex((op) => op[0] === 'fillRect');
    expect(ops[firstFill]).toEqual(['fillRect', 0, 0, W, H]);
    expect(ops.slice(0, firstFill)).toContainEqual(['=fillStyle', 'rgba(251, 249, 250, 1)']);
    expect(ops.filter((op) => op[0] === 'fill')).toHaveLength(7);
  });

  it('draws the same frame under every style for the same palette and mode', () => {
    for (const { colours } of PALETTE_MODES.slice(0, 4)) {
      const reference = draw({ colours, style: STYLE_IDS[0]!, focus });
      for (const style of STYLE_IDS) expect(draw({ colours, style, focus })).toEqual(reference);
    }
  });

  it('changes colour with palette and with mode', () => {
    const light = draw({
      colours: fixtureColours('motir', 'light'),
      style: 'warm-editorial',
      focus,
    });
    const dark = draw({ colours: fixtureColours('motir', 'dark'), style: 'warm-editorial', focus });
    const cobalt = draw({
      colours: fixtureColours('cobalt', 'light'),
      style: 'warm-editorial',
      focus,
    });
    expect(dark).not.toEqual(light);
    expect(cobalt).not.toEqual(light);
  });

  it('moves over time', () => {
    const colours = fixtureColours('motir', 'light');
    expect(draw({ colours, style: 'warm-editorial', focus }, 0)).not.toEqual(
      draw({ colours, style: 'warm-editorial', focus }, 3),
    );
  });
});

describe('drawClearArea', () => {
  it('feathers an ellipse of page colour centred on the box', () => {
    const { ctx, ops } = recordingContext();
    drawClearArea(ctx, focus, fixtureColours('motir', 'light'));
    expect(ops).toContainEqual(['translate', 320, 200]);
    expect(ops.find((op) => op[0] === 'createRadialGradient')).toEqual([
      'createRadialGradient',
      'createRadialGradient#0',
      0,
      0,
      0,
      0,
      0,
      270,
    ]);
    expect(ops.filter((op) => op[0] === 'addColorStop').map((op) => op[3])).toEqual([
      'rgba(251, 249, 250, 0.9)',
      'rgba(251, 249, 250, 0.82)',
      'rgba(251, 249, 250, 0)',
    ]);
    expect(ops).toContainEqual(['fill']);
  });

  it('does nothing for an empty box', () => {
    const { ctx, ops } = recordingContext();
    drawClearArea(ctx, { x: 0, y: 0, w: 0, h: 10 }, fixtureColours('motir', 'light'));
    expect(ops).toEqual([]);
  });
});
