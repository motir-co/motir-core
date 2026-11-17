import { describe, expect, it } from 'vitest';
import {
  STYLE_IDS,
  WAVE_BASE_STYLE,
  createWave,
  drawerFor,
  hasWaveVariation,
  markLines,
  markSquares,
  waveConfigFor,
  type BackgroundColours,
} from '../src/index';
import {
  PALETTE_MODES,
  fixtureColours,
  recordingCanvasFactory,
  recordingContext,
  type Op,
} from './helpers/recordingCanvas';

const W = 640;
const H = 360;
const focus = { x: 240, y: 120, w: 160, h: 120 };
const light = fixtureColours('motir', 'light');

/** Draw one Wave frame per time in `times`; return each frame's ops. */
function frames(
  style: string,
  times: number[],
  colours: BackgroundColours = light,
  box = focus,
): Op[][] {
  const d = createWave();
  d.resize(W, H);
  const off = recordingCanvasFactory();
  return times.map((t) => {
    const rec = recordingContext();
    d.frame(rec.ctx, t, { colours, style: style as never, focus: box, createCanvas: off.create });
    return rec.ops;
  });
}

const sig = (ops: Op[]) => JSON.stringify(ops);

describe('the Wave', () => {
  it('is the drawer registered for the wave id', () => {
    expect(drawerFor('wave')).toBe(createWave);
  });

  it('has its own variation for every registered style', () => {
    for (const style of STYLE_IDS) expect(hasWaveVariation(style), style).toBe(true);
    expect(hasWaveVariation('not-a-style')).toBe(false);
  });

  it('paints its whole box first, under every style, palette and mode, without throwing', () => {
    for (const style of STYLE_IDS)
      for (const { colours } of PALETTE_MODES) {
        const [ops] = frames(style, [1.3], colours);
        const first = ops!.findIndex((op) => op[0] === 'fillRect');
        expect(ops![first], style).toEqual(['fillRect', 0, 0, W, H]);
      }
  });

  it('draws a visibly different variation under each style', () => {
    const seen = new Set(STYLE_IDS.map((style) => sig(frames(style, [0.7])[0]!)));
    expect(seen.size).toBe(STYLE_IDS.length);
  });

  it('draws the base variation for a style id with no entry', () => {
    expect(waveConfigFor('a-style-registered-later')).toBe(waveConfigFor(WAVE_BASE_STYLE));
    const [unknown] = frames('a-style-registered-later', [2]);
    const [base] = frames(WAVE_BASE_STYLE, [2]);
    expect(unknown!.length).toBeGreaterThan(10);
    expect(sig(unknown!)).toBe(sig(base!));
  });

  it('moves Neo-Brutalism in jumps, with 3px square-capped lines and a hard offset shadow', () => {
    const [a, b, c] = frames('neo-brutalism', [0.05, 0.45, 0.55]);
    expect(sig(a!)).toBe(sig(b!));
    expect(sig(c!)).not.toBe(sig(a!));
    expect(a).toContainEqual(['=lineWidth', 3]);
    expect(a).toContainEqual(['=lineJoin', 'miter']);
    expect(a).toContainEqual(['=lineCap', 'square']);
    // The shadow is a hard offset copy, never a blur.
    expect(a!.filter((op) => op[0] === '=shadowBlur' && op[1] !== 0)).toEqual([]);
    expect(a!.filter((op) => op[0] === 'translate' || op[0] === 'moveTo').length).toBeGreaterThan(
      0,
    );
  });

  it('holds High-Contrast still and keeps Warm Editorial drifting', () => {
    const [s0, s1] = frames('high-contrast-accessible', [0, 9]);
    expect(sig(s0!)).toBe(sig(s1!));
    const [w0, w1] = frames('warm-editorial', [0, 9]);
    expect(sig(w0!)).not.toBe(sig(w1!));
  });
});

describe('Warm Editorial — today’s HeroWaves', () => {
  it('draws the 47 HeroWaves lines bunched around the content', () => {
    const lines = markLines(H, focus);
    expect(lines).toHaveLength(47);
    expect(lines[23]!.u).toBe(0);
    expect(lines[23]!.base).toBe(focus.y + focus.h / 2);
    expect(lines[0]!.amp).toBe(70);
    expect(lines[23]!.amp).toBe(180);
  });

  it('places the seven squares clear of the content, the same way every time', () => {
    const lines = markLines(H, focus);
    const sq = markSquares(W, lines, focus);
    expect(sq).toEqual(markSquares(W, lines, focus));
    expect(sq.length).toBeLessThanOrEqual(7);
    for (const s of sq)
      expect(s.x > focus.x - 90 && s.x < focus.x + focus.w + 90 && s.line === 23).toBe(false);
  });

  it('paints the HeroWaves glow, lines, touches and squares in the live inks', () => {
    const [ops] = frames('warm-editorial', [0]);
    expect(ops).toContainEqual(['=filter', 'blur(4px)']);
    expect(ops).toContainEqual(['=lineWidth', 6]);
    expect(ops).toContainEqual(['=globalAlpha', 0.035]);
    expect(ops).toContainEqual(['=globalAlpha', 0.35]);
    expect(ops).toContainEqual(['=lineWidth', 2.2]);
    const dec = `rgba(${light.decision.join(', ')}, 1)`;
    const hl = `rgba(${light.highlight.join(', ')}, 1)`;
    expect(ops).toContainEqual(['=fillStyle', dec]);
    expect(ops).toContainEqual(['=fillStyle', hl]);
    const [dark] = frames('warm-editorial', [0], fixtureColours('motir', 'dark'));
    expect(dark).toContainEqual(['=globalAlpha', 0.06]);
  });

  it('rebuilds its line set when the content moves, and reuses it otherwise', () => {
    const d = createWave();
    d.resize(W, H);
    const off = recordingCanvasFactory();
    const draw = (box: typeof focus) => {
      const rec = recordingContext();
      d.frame(rec.ctx, 0, {
        colours: light,
        style: 'warm-editorial',
        focus: box,
        createCanvas: off.create,
      });
      return sig(rec.ops);
    };
    const a = draw(focus);
    expect(draw(focus)).toBe(a);
    expect(draw({ ...focus, y: focus.y + 40 })).not.toBe(a);
  });
});
