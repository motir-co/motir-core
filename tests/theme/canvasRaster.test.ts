import { describe, expect, it } from 'vitest';
import {
  interpolatePositions,
  isTexture,
  parseGradient,
  parseLayers,
  parseLength,
  parsePosition,
  parsePositionList,
  parseSize,
  relativeLuminance,
  splitTopLevel,
  worstCanvasContrast,
  type CanvasInput,
  type Rgba,
} from './canvasRaster';
import { contrast } from './colorMetrics';

// MOTIR-10736 — the canvas painter the style AA gate measures with. These
// cases pin the CSS it reads and the pixels it paints, against values worked
// out by hand from CSS Images 3 / Backgrounds 3.

/** A colour reader for the forms these cases use. */
function colourOf(expression: string): Rgba | undefined {
  const value = expression.trim();
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/.exec(value);
  if (rgba) return { r: +rgba[1]!, g: +rgba[2]!, b: +rgba[3]!, a: +rgba[4]! };
  return undefined;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const INK = [{ name: 'ink', colour: BLACK }];

/** Paint `image` over white at a 100×100 viewport and return the black ink's worst ratio. */
function paintOne(
  declarations: Parameters<typeof parseLayers>[0],
  extra: Partial<CanvasInput> = {},
) {
  return worstCanvasContrast({
    ground: WHITE,
    layers: parseLayers(declarations, colourOf),
    viewports: [{ width: 100, height: 100 }],
    states: [{ name: 'still', positions: [] }],
    inks: INK,
    step: 4,
    ...extra,
  })[0]!;
}

describe('canvasRaster — parsing', () => {
  it('splits at the top level only', () => {
    expect(splitTopLevel('a(b, c), d')).toEqual(['a(b, c)', 'd']);
    expect(splitTopLevel('a  b', ' ')).toEqual(['a', '', 'b']);
  });

  it('reads lengths, percentages and a bare zero, and nothing else', () => {
    expect(parseLength('12%')).toEqual({ px: 0, pct: 12 });
    expect(parseLength('-3.5px')).toEqual({ px: -3.5, pct: 0 });
    expect(parseLength('0')).toEqual({ px: 0, pct: 0 });
    expect(parseLength('7')).toBeUndefined();
    expect(parseLength('2em')).toBeUndefined();
  });

  it('reads one- and two-value positions, keywords in either order', () => {
    expect(parsePosition('12% 0%')).toEqual([
      { px: 0, pct: 12 },
      { px: 0, pct: 0 },
    ]);
    expect(parsePosition('center top')).toEqual([
      { px: 0, pct: 50 },
      { px: 0, pct: 0 },
    ]);
    expect(parsePosition('bottom right')).toEqual([
      { px: 0, pct: 100 },
      { px: 0, pct: 100 },
    ]);
    expect(parsePosition('left')).toEqual([
      { px: 0, pct: 0 },
      { px: 0, pct: 50 },
    ]);
    expect(parsePosition('9px 9px')[0]).toEqual({ px: 9, pct: 0 });
    expect(() => parsePosition('right 10px top 4px')).toThrow(/unsupported position/);
    expect(() => parsePosition('top sideways')).toThrow(/unsupported position/);
    expect(() => parsePosition('')).toThrow(/unsupported position/);
    expect(parsePositionList('0% 0%, 100% 40%')).toHaveLength(2);
  });

  it('reads linear directions: an angle, a turn, a side, and the default', () => {
    const stops = '#000000, #ffffff';
    expect(parseGradient(`linear-gradient(90deg, ${stops})`, colourOf).angle).toBe(90);
    expect(parseGradient(`linear-gradient(0.5turn, ${stops})`, colourOf).angle).toBe(180);
    expect(parseGradient(`linear-gradient(to left, ${stops})`, colourOf).angle).toBe(270);
    const plain = parseGradient(`repeating-linear-gradient(${stops})`, colourOf);
    expect([plain.angle, plain.repeating, plain.stops.length]).toEqual([180, true, 2]);
    expect(() => parseGradient(`linear-gradient(to top left, ${stops})`, colourOf)).toThrow(
      /unsupported direction/,
    );
  });

  it('reads radial shapes: two radii, a circle radius, and a bare circle', () => {
    const stops = 'rgba(0, 0, 0, 0.5), transparent 60%';
    const ellipse = parseGradient(`radial-gradient(85% 80% at 6% -12%, ${stops})`, colourOf);
    expect(ellipse.radii).toEqual([
      { px: 0, pct: 85 },
      { px: 0, pct: 80 },
    ]);
    expect(ellipse.centre).toEqual([
      { px: 0, pct: 6 },
      { px: 0, pct: -12 },
    ]);
    expect(parseGradient(`radial-gradient(circle 4px, ${stops})`, colourOf).radii).toEqual([
      { px: 4, pct: 0 },
      { px: 4, pct: 0 },
    ]);
    const bare = parseGradient(`radial-gradient(circle at 9px 9px, ${stops})`, colourOf);
    expect(bare.radii).toBeNull();
    for (const shape of ['ellipse', 'circle 4px 5px', 'closest-side', '40% at 50% 50%']) {
      expect(() => parseGradient(`radial-gradient(${shape}, ${stops})`, colourOf)).toThrow(
        /unsupported radial shape/,
      );
    }
  });

  it('refuses what it cannot paint, loudly', () => {
    expect(() => parseGradient('url(a.png)', colourOf)).toThrow(/unsupported image/);
    expect(() => parseGradient('linear-gradient(#000000)', colourOf)).toThrow(/two stops/);
    expect(() => parseGradient('linear-gradient(90deg, #000000, nope)', colourOf)).toThrow(
      /unsupported colour stop/,
    );
    expect(() => parseGradient('linear-gradient(#000000 1px 2px 3px, #fff)', colourOf)).toThrow();
  });

  it('reads sizes and cycles the layer lists as CSS does', () => {
    expect(parseSize('180% 180%')).toEqual([
      { px: 0, pct: 180 },
      { px: 0, pct: 180 },
    ]);
    expect(parseSize('32px')).toEqual([{ px: 32, pct: 0 }, 'auto']);
    expect(parseSize('auto')).toEqual(['auto', 'auto']);
    expect(() => parseSize('cover')).toThrow(/unsupported size/);
    expect(() => parseSize('1px 2px 3px')).toThrow(/unsupported size/);
    const layers = parseLayers(
      {
        image: 'linear-gradient(#000000, #ffffff), linear-gradient(#000000, #ffffff)',
        size: '40px 40px',
        position: '0 0, 50% 50%',
        repeat: 'no-repeat',
      },
      colourOf,
    );
    expect(layers.map((l) => l.size[0])).toEqual([
      { px: 40, pct: 0 },
      { px: 40, pct: 0 },
    ]);
    expect(layers[1]!.position[0]).toEqual({ px: 0, pct: 50 });
    expect(layers.every((l) => !l.repeat)).toBe(true);
    expect(() =>
      parseLayers({ image: 'linear-gradient(#000000, #ffffff)', repeat: 'space' }, colourOf),
    ).toThrow(/unsupported background-repeat/);
  });

  it('classes a repeating gradient or a small tile as texture, a wash as field', () => {
    const [wash, tile, stripe, wide] = parseLayers(
      {
        image: [
          'radial-gradient(50% 50% at 50% 50%, #000000, #ffffff)',
          'linear-gradient(#000000, #ffffff)',
          'repeating-linear-gradient(45deg, #000000 0 2px, transparent 2px 18px)',
          'linear-gradient(#000000, #ffffff)',
        ].join(', '),
        size: 'auto, 32px 32px, auto, 100px 100px',
      },
      colourOf,
    );
    expect([wash, tile, stripe, wide].map((l) => isTexture(l!))).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it('interpolates two position lists per layer and per axis, cycling the shorter', () => {
    const from = parsePositionList('0% 0%, 100% 0%');
    const to = parsePositionList('100% 40%');
    expect(interpolatePositions(from, to, 0.5)).toEqual([
      [
        { px: 0, pct: 50 },
        { px: 0, pct: 20 },
      ],
      [
        { px: 0, pct: 100 },
        { px: 0, pct: 20 },
      ],
    ]);
  });
});

describe('canvasRaster — painting', () => {
  it('measures luminance on the 8-bit value a screenshot holds', () => {
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 6);
    expect(relativeLuminance({ r: 300, g: -4, b: 0.2, a: 1 })).toBeCloseTo(0.2126, 6);
  });

  it('a flat translucent layer composites over the ground exactly once', () => {
    const result = paintOne({ image: 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))' });
    // 255 × 0.5 = 127.5 → 128 on 8 bits.
    expect(result.ratio).toBeCloseTo(contrast('#000000', '#808080'), 6);
    expect(result.where).toMatch(/^100x100 still at \(\d+,\d+\)$/);
  });

  it('stacks two overlapping washes, darker than either alone (the MOTIR-10736 defect)', () => {
    const wash = 'linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.4))';
    const alone = paintOne({ image: wash }).ratio;
    const both = paintOne({ image: `${wash}, ${wash}` }).ratio;
    // 1 − 0.6 × 0.6 = 0.64 coverage: 255 × 0.36 = 91.8 → 92.
    expect(both).toBeCloseTo(contrast('#000000', '#5c5c5c'), 6);
    expect(both).toBeLessThan(alone);
  });

  it('interpolates stops in premultiplied space, so transparent is a pure alpha ramp', () => {
    // White ink on black: a premultiplied ramp from white to transparent never
    // dips toward the black `transparent` carries, so the lightest pixel is the
    // stop itself and the worst ratio for white ink is at the white end.
    const result = worstCanvasContrast({
      ground: BLACK,
      layers: parseLayers({ image: 'linear-gradient(90deg, #ffffff, transparent)' }, colourOf),
      viewports: [{ width: 100, height: 4 }],
      states: [{ name: 'still', positions: [] }],
      inks: [{ name: 'white', colour: WHITE }],
      step: 4,
    })[0]!;
    // Pixel centre 0.5 of 100 → 99.5% white over black: 253.7 → 254.
    expect(result.ratio).toBeCloseTo(contrast('#ffffff', '#fefefe'), 6);
    expect(result.where).toBe('100x4 still at (0,0)');
  });

  it('fixes up stops: a position behind its predecessor, and an unpositioned middle stop', () => {
    const whitest = (image: string) =>
      worstCanvasContrast({
        ground: BLACK,
        layers: parseLayers({ image }, colourOf),
        viewports: [{ width: 100, height: 4 }],
        states: [{ name: 'still', positions: [] }],
        inks: [{ name: 'white', colour: WHITE }],
        step: 2,
      })[0]!;
    // White at 20% is clamped to the black stop's 50%: a hard edge at x = 50.
    const clamped = whitest('linear-gradient(90deg, #000000 50%, #ffffff 20%)');
    expect([clamped.ratio, clamped.where]).toEqual([1, '100x4 still at (50,0)']);
    // The unpositioned white stop lands halfway between 0 and 100%.
    const middle = whitest('linear-gradient(90deg, #000000, #ffffff, #000000)');
    expect(middle.where).toMatch(/at \((49|50),0\)$/);
    expect(middle.ratio).toBeLessThan(1.05);
  });

  it('places a radial wash by its centre and radii in the tile, and nothing outside it', () => {
    const dot = paintOne({
      image: 'radial-gradient(10% 10% at 50% 50%, #000000, #000000 50%, transparent 50%)',
      repeat: 'no-repeat',
      size: '80px 80px',
      position: '0 0',
    });
    expect(dot.ratio).toBeCloseTo(1, 6);
    const [, x, y] = /at \((\d+),(\d+)\)$/.exec(dot.where)!.map(Number);
    expect(Math.hypot(x! + 0.5 - 40, y! + 0.5 - 40)).toBeLessThanOrEqual(4);
    // A no-repeat tile off-screen paints nothing: the ground shows everywhere.
    const offscreen = paintOne({
      image: 'radial-gradient(circle at 50% 50%, #000000, #000000)',
      repeat: 'no-repeat',
      size: '80px 80px',
      position: '-200px -200px',
    });
    expect(offscreen.ratio).toBeCloseTo(21, 6);
  });

  it('paints a small tile as a texture: its colours reach every pixel', () => {
    const dot = paintOne({
      image: 'radial-gradient(circle 4px at 50% 50%, #000000, #000000 50%, transparent 50%)',
      repeat: 'no-repeat',
      size: '40px 40px',
    });
    expect(dot.ratio).toBeCloseTo(1, 6);
  });

  it('repeats a tile, and a repeating gradient, across the whole viewport', () => {
    const grid = paintOne({
      image: 'linear-gradient(90deg, rgba(0, 0, 0, 0.5) 1px, transparent 1px)',
      size: '32px 32px',
    });
    expect(grid.ratio).toBeCloseTo(contrast('#000000', '#808080'), 6);
    const stripes = paintOne({
      image: 'repeating-radial-gradient(circle at 50% 50%, #000000 0 2px, transparent 2px 10px)',
    });
    expect(stripes.ratio).toBeCloseTo(1, 6);
  });

  it('composites every texture colour over every field pixel', () => {
    const result = paintOne({
      image: [
        'linear-gradient(90deg, rgba(0, 0, 0, 0.5) 2px, transparent 2px)',
        'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))',
      ].join(', '),
      size: '16px 16px, auto',
    });
    // The line over the wash: 0.75 coverage, 255 × 0.25 = 63.75 → 64.
    expect(result.ratio).toBeCloseTo(contrast('#000000', '#404040'), 6);
  });

  it('takes the worst of every state, and says which one it was', () => {
    const layers = parseLayers(
      {
        image: 'radial-gradient(10px 10px at 50% 50%, #000000, transparent)',
        size: '200px 200px',
        repeat: 'no-repeat',
      },
      colourOf,
    );
    const input: CanvasInput = {
      ground: WHITE,
      layers,
      viewports: [{ width: 100, height: 100 }],
      states: [
        // The tile sits off-screen in the first state; its centre is mid-screen in the second.
        { name: 'away', positions: [parsePosition('300px 300px')] },
        { name: 'here', positions: [parsePosition('-50px -50px')] },
      ],
      inks: INK,
    };
    const [result] = worstCanvasContrast(input);
    expect(result!.where).toMatch(/^100x100 here at \((49|50),(49|50)\)$/);
    expect(result!.ratio).toBeLessThan(1.2);
  });

  it('measures an ink against a plain ground when there are no layers', () => {
    const [result] = worstCanvasContrast({
      ground: WHITE,
      layers: [],
      viewports: [{ width: 13, height: 7 }],
      states: [{ name: 'still', positions: [] }],
      inks: INK,
    });
    expect(result!.ratio).toBeCloseTo(21, 6);
  });
});
