// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_TOKENS,
  coloursFromTokens,
  cycleRgb,
  luminance,
  mixRgb,
  packRgb,
  parseColour,
  ramp,
  readBackgroundColours,
  rgba,
} from '../src/index';

describe('parseColour', () => {
  it.each([
    ['#fff', [255, 255, 255]],
    ['#ffff', [255, 255, 255]],
    ['#1c1a22', [28, 26, 34]],
    ['#1C1A22CC', [28, 26, 34]],
    ['rgb(1, 2, 3)', [1, 2, 3]],
    ['rgba(1,2,3,0.5)', [1, 2, 3]],
    ['rgb(10 20 30 / 50%)', [10, 20, 30]],
    ['rgb(100% 0% 50%)', [255, 0, 128]],
    ['color(srgb 1 0.5 0)', [255, 128, 0]],
    ['color(srgb 1.2 -0.1 0 / 0.4)', [255, 0, 0]],
  ])('reads %s', (input, rgb) => {
    expect(parseColour(input)).toEqual(rgb);
  });

  it.each([
    '',
    '   ',
    null,
    undefined,
    '#12',
    '#12345',
    'oklch(0.5 0.1 200)',
    'rgb(1, 2)',
    'rgb(a, b, c)',
    'red',
  ])('refuses %s', (input) => {
    expect(parseColour(input as string)).toBeNull();
  });
});

describe('colour arithmetic', () => {
  it('mixes, formats and packs', () => {
    expect(mixRgb([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
    expect(rgba([1, 2, 3])).toBe('rgba(1, 2, 3, 1)');
    expect(rgba([1, 2, 3], 0.25)).toBe('rgba(1, 2, 3, 0.25)');
    expect(packRgb([1, 2, 3])).toBe(((255 << 24) | (3 << 16) | (2 << 8) | 1) >>> 0);
  });

  it('measures luminance', () => {
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([255, 255, 255])).toBeCloseTo(1);
    expect(luminance([5, 5, 5])).toBeGreaterThan(0);
  });

  it('cycles round a closed ramp, including negative positions', () => {
    const stops = [
      [0, 0, 0],
      [100, 100, 100],
    ] as const;
    expect(cycleRgb(stops, 0)).toEqual([0, 0, 0]);
    expect(cycleRgb(stops, 0.5)).toEqual([50, 50, 50]);
    expect(cycleRgb(stops, 1.5)).toEqual([50, 50, 50]);
    expect(cycleRgb(stops, -0.5)).toEqual([50, 50, 50]);
    expect(ramp(stops, 4)).toEqual([
      [0, 0, 0],
      [50, 50, 50],
      [100, 100, 100],
      [50, 50, 50],
    ]);
  });
});

const TOKEN_VALUES: Record<string, string> = {
  '--el-page-bg': '#fbf9fa',
  '--el-surface': '#ffffff',
  '--el-text': 'rgb(28, 26, 34)',
  '--el-border': '#e4e0e6',
  '--el-accent': 'color(srgb 0.84 0.23 0.6)',
  '--el-accent-text': '#ffffff',
  '--el-showcase-wave-1': '#ff64c8',
  '--el-showcase-wave-2': '#22a99a',
  '--el-showcase-wave-3': '#f08a2e',
  '--el-showcase-decision': '#d63a9a',
  '--el-showcase-highlight': '#22a99a',
  '--el-showcase-ground': '#1c1a22',
};

describe('coloursFromTokens', () => {
  it('reads every ink from its token', () => {
    const c = coloursFromTokens((name) => TOKEN_VALUES[name] ?? '');
    expect(c).not.toBeNull();
    expect(c!.bg).toEqual([251, 249, 250]);
    expect(c!.ink).toEqual([28, 26, 34]);
    expect(c!.hues).toEqual([
      [255, 100, 200],
      [34, 169, 154],
      [240, 138, 46],
    ]);
    expect(c!.dark).toBe(false);
  });

  it('reads a dark page from its luminance', () => {
    const c = coloursFromTokens((name) =>
      name === '--el-page-bg' ? '#131117' : (TOKEN_VALUES[name] ?? ''),
    );
    expect(c!.dark).toBe(true);
  });

  it('answers null when a token is undeclared', () => {
    expect(
      coloursFromTokens((name) => (name === '--el-showcase-wave-2' ? '' : TOKEN_VALUES[name]!)),
    ).toBeNull();
  });

  it('normalises a value the parser cannot read', () => {
    const c = coloursFromTokens(
      (name) => (name === '--el-accent' ? 'oklch(0.6 0.2 350)' : TOKEN_VALUES[name]!),
      () => '#010203',
    );
    expect(c!.accent).toEqual([1, 2, 3]);
    expect(
      coloursFromTokens((name) =>
        name === '--el-accent' ? 'oklch(0.6 0.2 350)' : TOKEN_VALUES[name]!,
      ),
    ).toBeNull();
  });

  it('names one token per ink', () => {
    expect(Object.values(BACKGROUND_TOKENS).every((t) => t.startsWith('--el-'))).toBe(true);
  });
});

describe('readBackgroundColours', () => {
  const host = () => {
    const el = document.createElement('div');
    for (const [k, v] of Object.entries(TOKEN_VALUES)) el.style.setProperty(k, v);
    document.body.append(el);
    return el;
  };

  it('reads the live tokens off an element', () => {
    expect(readBackgroundColours(host())?.accent).toEqual([214, 59, 153]);
  });

  it('normalises through a canvas context fillStyle round-trip', () => {
    const el = host();
    el.style.setProperty('--el-accent', 'hotpink');
    const fake = { fillStyle: '' as string } as unknown as CanvasRenderingContext2D;
    let last = '';
    Object.defineProperty(fake, 'fillStyle', {
      get: () => (last === 'hotpink' ? '#ff69b4' : last),
      set: (v: string) => {
        last = v;
      },
    });
    expect(readBackgroundColours(el, fake)?.accent).toEqual([255, 105, 180]);
    expect(readBackgroundColours(el, null)).toBeNull();
  });
});
