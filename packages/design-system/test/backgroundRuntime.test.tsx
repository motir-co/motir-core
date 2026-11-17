// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_DRAWERS,
  BACKGROUND_FRAME_MS,
  Background,
  boxParent,
  centreBox,
  startBackground,
} from '../src/index';
import { recordingContext, type Op } from './helpers/recordingCanvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const W = 500;
const H = 300;
const TOKENS: Record<string, string> = {
  '--el-page-bg': '#fbf9fa',
  '--el-surface': '#ffffff',
  '--el-text': '#1c1a22',
  '--el-border': '#e4e0e6',
  '--el-accent': '#d63a9a',
  '--el-accent-text': '#ffffff',
  '--el-showcase-wave-1': '#ff64c8',
  '--el-showcase-wave-2': '#22a99a',
  '--el-showcase-wave-3': '#f08a2e',
  '--el-showcase-decision': '#d63a9a',
  '--el-showcase-highlight': '#22a99a',
  '--el-showcase-ground': '#1c1a22',
};

let ops: Op[];
let rafQueue: Map<number, FrameRequestCallback>;
let rafId: number;
let io: { cb: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> } | null;
let ro: { cb: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> } | null;
let reducedMotion: boolean;
let hidden: boolean;

const frames = () => ops.filter((op) => op[0] === 'fillRect' && op[3] === W && op[4] === H).length;
const flushRaf = (now: number) => {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  pending.forEach((cb) => cb(now));
};

function makeHost(): { host: HTMLDivElement; canvas: HTMLCanvasElement } {
  const host = document.createElement('div');
  for (const [k, v] of Object.entries(TOKENS)) host.style.setProperty(k, v);
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => W });
  Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => H });
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  return { host, canvas };
}

beforeEach(() => {
  ops = [];
  rafQueue = new Map();
  rafId = 0;
  io = null;
  ro = null;
  reducedMotion = false;
  hidden = false;
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-palette');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const rec = recordingContext();
    ops = rec.ops;
    return rec.ctx as never;
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => rafQueue.delete(id));
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn();
      constructor(cb: IntersectionObserverCallback) {
        io = { cb, disconnect: this.disconnect };
      }
      observe() {}
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = vi.fn();
      constructor(cb: ResizeObserverCallback) {
        ro = { cb, disconnect: this.disconnect };
      }
      observe() {}
    },
  );
  vi.spyOn(performance, 'now').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const intersect = (isIntersecting: boolean) =>
  io!.cb([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);

describe('startBackground', () => {
  it('draws a first frame that fills the box, then animates at most ~30 fps', () => {
    const { canvas } = makeHost();
    const stop = startBackground({ canvas, id: 'aurora' });
    expect(frames()).toBe(1);
    expect(rafQueue.size).toBe(1);
    flushRaf(BACKGROUND_FRAME_MS / 2);
    expect(frames()).toBe(1);
    flushRaf(BACKGROUND_FRAME_MS + 1);
    expect(frames()).toBe(2);
    flushRaf(BACKGROUND_FRAME_MS * 1.5);
    expect(frames()).toBe(2);
    flushRaf(BACKGROUND_FRAME_MS * 2 + 2);
    expect(frames()).toBe(3);
    stop();
    expect(rafQueue.size).toBe(0);
    expect(io!.disconnect).toHaveBeenCalled();
    expect(ro!.disconnect).toHaveBeenCalled();
  });

  it('clears a feathered area behind the focus element', () => {
    const { host, canvas } = makeHost();
    const card = document.createElement('form');
    card.getBoundingClientRect = () => ({ left: 100, top: 80, width: 200, height: 120 }) as DOMRect;
    host.append(card);
    startBackground({ canvas, id: 'aurora', focus: () => card });
    expect(ops.some((op) => op[0] === 'createRadialGradient')).toBe(true);
  });

  it('clears nothing without a focus element', () => {
    const { canvas } = makeHost();
    startBackground({ canvas, id: 'aurora' });
    expect(ops.some((op) => op[0] === 'createRadialGradient')).toBe(false);
  });

  it('holds exactly one still frame under reduced motion', () => {
    reducedMotion = true;
    const { canvas } = makeHost();
    startBackground({ canvas, id: 'aurora' });
    expect(frames()).toBe(1);
    expect(rafQueue.size).toBe(0);
    intersect(false);
    intersect(true);
    expect(frames()).toBe(2);
    expect(rafQueue.size).toBe(0);
  });

  it('draws nothing off screen, and resumes when it comes back', () => {
    const { canvas } = makeHost();
    startBackground({ canvas, id: 'aurora' });
    intersect(false);
    flushRaf(1000);
    expect(frames()).toBe(1);
    expect(rafQueue.size).toBe(0);
    intersect(true);
    expect(rafQueue.size).toBe(1);
    flushRaf(2000);
    expect(frames()).toBe(2);
  });

  it('draws nothing in a hidden tab, and resumes when it is shown', () => {
    hidden = true;
    const { canvas } = makeHost();
    startBackground({ canvas, id: 'aurora' });
    expect(frames()).toBe(0);
    expect(rafQueue.size).toBe(0);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    flushRaf(1000);
    expect(frames()).toBe(1);
  });

  it('recolours a running background when the palette or mode changes on <html>', async () => {
    const { host, canvas } = makeHost();
    startBackground({ canvas, id: 'aurora' });
    expect(ops).toContainEqual(['=fillStyle', 'rgba(251, 249, 250, 1)']);
    host.style.setProperty('--el-page-bg', '#131117');
    document.documentElement.setAttribute('data-palette', 'cobalt');
    await new Promise((r) => setTimeout(r, 0));
    expect(ops).toContainEqual(['=fillStyle', 'rgba(19, 17, 23, 1)']);
  });

  it('also watches the nearest appearance scope around the host', async () => {
    const scope = document.createElement('section');
    scope.setAttribute('data-theme', 'light');
    const { host, canvas } = makeHost();
    scope.append(host);
    document.body.append(scope);
    startBackground({ canvas, id: 'aurora' });
    host.style.setProperty('--el-page-bg', '#131117');
    scope.setAttribute('data-theme', 'dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(ops).toContainEqual(['=fillStyle', 'rgba(19, 17, 23, 1)']);
  });

  it('re-measures once a resize settles', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { canvas } = makeHost();
    startBackground({ canvas, id: 'aurora' });
    const before = frames();
    ro!.cb([], {} as ResizeObserver);
    ro!.cb([], {} as ResizeObserver);
    vi.advanceTimersByTime(100);
    expect(frames()).toBe(before);
    vi.advanceTimersByTime(30);
    // Two resizes inside the settle window measure (and draw) once.
    expect(frames()).toBe(before + 1);
  });

  it('draws an unknown id as the style default, the Wave', () => {
    const { canvas } = makeHost();
    startBackground({ canvas, id: 'not-a-background' });
    expect(frames()).toBe(1);
    // The Wave gathers around the content: no clear area is painted over it.
    expect(ops.some((op) => op[0] === 'createRadialGradient')).toBe(false);
  });

  it.each(['wave', 'topography'])(
    'redraws a running %s in the new style when data-style changes on <html>',
    async (id) => {
      document.documentElement.setAttribute('data-style', 'warm-editorial');
      const { canvas } = makeHost();
      startBackground({ canvas, id });
      expect(ops).not.toContainEqual(['=lineWidth', 3]);
      document.documentElement.setAttribute('data-style', 'neo-brutalism');
      await new Promise((r) => setTimeout(r, 0));
      expect(ops).toContainEqual(['=lineWidth', 3]);
      document.documentElement.removeAttribute('data-style');
    },
  );

  it('draws nothing, and does not throw, for an id without a drawer or tokens', () => {
    const { host, canvas } = makeHost();
    const wave = BACKGROUND_DRAWERS.wave;
    delete BACKGROUND_DRAWERS.wave;
    try {
      expect(() => startBackground({ canvas, id: 'not-a-background' })).not.toThrow();
    } finally {
      BACKGROUND_DRAWERS.wave = wave;
    }
    expect(frames()).toBe(0);
    expect(ops.some((op) => op[0] === 'clearRect')).toBe(true);
    host.style.removeProperty('--el-showcase-wave-1');
    expect(() => startBackground({ canvas, id: 'aurora' })).not.toThrow();
  });

  it('is a no-op without a host or a 2D context', () => {
    const orphan = document.createElement('canvas');
    expect(startBackground({ canvas: orphan, id: 'aurora' })).toBeTypeOf('function');
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const { canvas } = makeHost();
    startBackground({ canvas, id: 'aurora' })();
    expect(frames()).toBe(0);
  });

  it('works where the platform has no observers', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('MutationObserver', undefined);
    const { canvas } = makeHost();
    const stop = startBackground({ canvas, id: 'aurora' });
    expect(frames()).toBe(1);
    stop();
  });
});

describe('boxParent and centreBox', () => {
  it('skips display: contents wrappers', () => {
    const outer = document.createElement('div');
    const island = document.createElement('motir-island');
    island.style.display = 'contents';
    const canvas = document.createElement('canvas');
    island.append(canvas);
    outer.append(island);
    document.body.append(outer);
    expect(boxParent(canvas)).toBe(outer);
  });

  it('centres a default focus box', () => {
    const box = centreBox(100, 100);
    expect(box.x).toBeCloseTo(33);
    expect(box.y).toBeCloseTo(36);
    expect(box.w).toBeCloseTo(34);
    expect(box.h).toBeCloseTo(28);
  });
});

describe('<Background>', () => {
  it('renders a decorative canvas and stops drawing on unmount', async () => {
    const host = document.createElement('div');
    for (const [k, v] of Object.entries(TOKENS)) host.style.setProperty(k, v);
    Object.defineProperty(host, 'clientWidth', { get: () => W });
    Object.defineProperty(host, 'clientHeight', { get: () => H });
    const target = document.createElement('div');
    target.style.display = 'contents';
    host.append(target);
    const card = document.createElement('div');
    card.id = 'card';
    card.getBoundingClientRect = () => ({ left: 100, top: 80, width: 200, height: 120 }) as DOMRect;
    host.append(card);
    document.body.append(host);
    const root = createRoot(target);
    await act(async () => root.render(<Background id="aurora" focusId="card" />));
    const canvas = host.querySelector('canvas')!;
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.getAttribute('data-background')).toBe('aurora');
    expect(canvas.className).toContain('pointer-events-none');
    expect(frames()).toBe(1);
    expect(ops.some((op) => op[0] === 'createRadialGradient')).toBe(true);
    await act(async () => root.unmount());
    expect(rafQueue.size).toBe(0);
  });

  it('renders nothing for `none`', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    const root = createRoot(target);
    await act(async () => root.render(<Background id="none" />));
    expect(target.querySelector('canvas')).toBeNull();
    await act(async () => root.render(<Background id={undefined} />));
    expect(target.querySelector('canvas')?.getAttribute('data-background')).toBe('');
    await act(async () => root.unmount());
  });
});
