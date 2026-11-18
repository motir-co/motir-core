// A recording stand-in for a 2D canvas context, so a background's frame can be
// drawn — and compared — in node without a real canvas. Every method call and
// every property write is appended to `ops` in order, with numbers rounded so
// two frames compare by value.

import type {
  BackgroundCanvas,
  BackgroundColours,
  BackgroundContext,
} from '../../src/backgrounds/types';
import { PALETTE_IDS } from '../../src/theme/palettes';
import type { Rgb } from '../../src/backgrounds/colour';

export type Op = [string, ...unknown[]];

const norm = (v: unknown): unknown => {
  if (typeof v === 'number') return Math.round(v * 1000) / 1000;
  if (v && typeof v === 'object' && 'stops' in (v as object)) return (v as { id: string }).id;
  if (v instanceof Uint8ClampedArray || v instanceof Uint32Array) return `buf:${v.length}`;
  if (Array.isArray(v)) return v.map(norm);
  return v;
};

export interface RecordingContext {
  ctx: BackgroundContext;
  ops: Op[];
}

export function recordingContext(): RecordingContext {
  const ops: Op[] = [];
  let gradients = 0;
  const state: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
  };
  const gradient = (kind: string, args: unknown[]) => {
    const id = `${kind}#${gradients++}`;
    const g = {
      id,
      stops: [] as unknown[],
      addColorStop(offset: number, colour: string) {
        ops.push(['addColorStop', id, norm(offset), colour]);
      },
    };
    ops.push([kind, id, ...args.map(norm)]);
    return g;
  };
  const special: Record<string, (...args: unknown[]) => unknown> = {
    createLinearGradient: (...a) => gradient('createLinearGradient', a),
    createRadialGradient: (...a) => gradient('createRadialGradient', a),
    createImageData: (w, h) => {
      ops.push(['createImageData', w, h]);
      return {
        width: w,
        height: h,
        data: new Uint8ClampedArray((w as number) * (h as number) * 4),
      };
    },
    putImageData: (img) => {
      const data = (img as { data: Uint8ClampedArray }).data;
      let hash = 0;
      for (let i = 0; i < data.length; i++) hash = (Math.imul(hash, 31) + data[i]!) | 0;
      ops.push(['putImageData', hash]);
    },
    // A browser throws on a negative radius; the stand-in does too, so a frame
    // that would throw on a real canvas fails here (MOTIR-11672).
    arcTo: (...a) => {
      if ((a[4] as number) < 0)
        throw new RangeError(`arcTo: the radius provided (${String(a[4])}) is negative`);
      ops.push(['arcTo', ...a.map(norm)]);
    },
    arc: (...a) => {
      if ((a[2] as number) < 0)
        throw new RangeError(`arc: the radius provided (${String(a[2])}) is negative`);
      ops.push(['arc', ...a.map(norm)]);
    },
    measureText: () => ({ width: 0 }),
    getLineDash: () => [],
  };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in special) return special[prop];
        if (prop in state) return state[prop];
        if (prop === 'canvas') return { width: 0, height: 0 };
        if (prop === 'filter') return 'none';
        return (...args: unknown[]) => {
          ops.push([prop, ...args.map(norm)]);
        };
      },
      set(_t, prop: string, value: unknown) {
        state[prop] = value;
        ops.push([`=${prop}`, norm(value)]);
        return true;
      },
      has() {
        return true;
      },
    },
  ) as unknown as BackgroundContext;
  return { ctx, ops };
}

/** An off-screen canvas whose context records into its own log. */
export function recordingCanvasFactory(): {
  create: (w: number, h: number) => BackgroundCanvas;
  made: RecordingContext[];
} {
  const made: RecordingContext[] = [];
  return {
    made,
    create(width, height) {
      const rec = recordingContext();
      made.push(rec);
      return { width, height, getContext: () => rec.ctx };
    },
  };
}

/** A deterministic, distinct colour set per palette × mode — stand-ins for the resolved tokens. */
export function fixtureColours(palette: string, mode: 'light' | 'dark'): BackgroundColours {
  let seed = 0;
  for (const ch of `${palette}:${mode}`) seed = (Math.imul(seed, 33) + ch.charCodeAt(0)) >>> 0;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % 256;
  };
  const hue = (): Rgb => [next(), next(), next()];
  const dark = mode === 'dark';
  return {
    bg: dark ? [18, 17, 23] : [251, 249, 250],
    surface: dark ? [29, 26, 34] : [255, 255, 255],
    ink: dark ? [241, 239, 244] : [28, 26, 34],
    line: dark ? [49, 45, 56] : [228, 224, 230],
    accent: hue(),
    onAccent: dark ? [18, 17, 23] : [255, 255, 255],
    hues: [hue(), hue(), hue()],
    decision: hue(),
    highlight: hue(),
    ground: dark ? [8, 8, 10] : [28, 26, 34],
    dark,
  };
}

/** Every palette × mode, as fixture colour sets. */
export const PALETTE_MODES = PALETTE_IDS.flatMap((palette) =>
  (['light', 'dark'] as const).map((mode) => ({
    palette,
    mode,
    colours: fixtureColours(palette, mode),
  })),
);
