// The runtime every background shares — HeroWaves' rules, generalised:
//
//  • the canvas fills its HOST's box (the nearest ancestor that has one: a
//    `display: contents` wrapper is skipped, as a built page's island wrapper
//    has no box), at the device pixel ratio capped at 2;
//  • the inks are design-system tokens read off the live theme, re-read when
//    `data-theme`, `data-palette` or `data-style` change on `<html>` or on the
//    nearest appearance scope around the host;
//  • frames are drawn at most ~30 times a second, only while the host is on
//    screen and the tab is visible;
//  • under `prefers-reduced-motion` exactly one still frame is drawn;
//  • every background except the one that gathers around it is cleared behind
//    the focus element (the page's main content) by a feathered fade.
//
// DOM-only: called from the client component's effect, never on the server.

import { drawClearArea } from './clearArea';
import { drawerFor } from './drawers';
import { BACKGROUND_REGISTRY, resolveBackground } from './registry';
import { readBackgroundColours } from './tokens';
import type {
  BackgroundBox,
  BackgroundCanvas,
  BackgroundColours,
  BackgroundContext,
  BackgroundDrawer,
} from './types';
import { resolveStyle, type StyleId } from '../theme/styles';

/** Frames are drawn at most this often. */
export const BACKGROUND_FRAME_MS = 1000 / 30;
/** A resize is acted on once it has settled for this long. */
const RESIZE_SETTLE_MS = 120;
/** The attributes that change a background's inks or its style. */
export const BACKGROUND_THEME_ATTRIBUTES = ['data-theme', 'data-palette', 'data-style'] as const;

/** The element whose box the canvas fills — `display: contents` wrappers skipped. */
export function boxParent(el: Element): HTMLElement | null {
  let parent = el.parentElement;
  while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
  return parent;
}

/** The box to gather around when there is no focus element: the middle of the box. */
export function centreBox(w: number, h: number): BackgroundBox {
  return { x: w * 0.33, y: h * 0.36, w: w * 0.34, h: h * 0.28 };
}

/** `el`'s box relative to `host`'s. */
function boxIn(el: Element, host: Element): BackgroundBox {
  const r = el.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  return { x: r.left - h.left, y: r.top - h.top, w: r.width, h: r.height };
}

/** The `data-style` in force for `el`: the nearest scope's, else `<html>`'s. */
function activeStyle(el: Element): StyleId {
  const scoped = el.closest('[data-style]')?.getAttribute('data-style');
  return resolveStyle(scoped ?? document.documentElement.getAttribute('data-style')).id as StyleId;
}

export interface StartBackgroundOptions {
  /** The canvas to draw into. Its host is its nearest boxed ancestor. */
  canvas: HTMLCanvasElement;
  /** The background id (any value; an unknown one resolves to the style's default). */
  id: unknown;
  /** The main content to gather around / clear behind, looked up on each measure. */
  focus?: () => Element | null;
  /**
   * Draw one still frame and never animate, whatever the motion preference — a
   * picker's swatch. It still redraws on a resize or a theme change.
   */
  still?: boolean;
}

interface Scene {
  W: number;
  H: number;
  colours: BackgroundColours;
  style: StyleId;
  focus: BackgroundBox;
  /** Clear behind the focus — set only when there is a focus element. */
  clear: BackgroundBox | null;
  drawer: BackgroundDrawer;
}

/**
 * Start drawing `id` into `canvas`. Returns the stop function, which removes
 * every observer and listener and cancels the pending frame. Returns a no-op
 * stop when the canvas has no host or no 2D context.
 */
export function startBackground({
  canvas,
  id,
  focus,
  still: forceStill = false,
}: StartBackgroundOptions): () => void {
  const host = boxParent(canvas);
  const ctx = canvas.getContext('2d');
  if (!host || !ctx) return () => {};
  const still =
    forceStill || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const createCanvas = (w: number, h: number): BackgroundCanvas | null => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c as unknown as BackgroundCanvas;
  };
  let scene: Scene | null = null;
  let drawerKey = '';
  let drawer: BackgroundDrawer | null = null;

  const measure = () => {
    scene = measureScene(canvas, host, ctx, id, focus, (key, make) => {
      if (key !== drawerKey || !drawer) {
        drawer = make();
        drawerKey = key;
      }
      return drawer;
    });
  };
  const frame = (t: number) => {
    if (!scene) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    drawFrame(ctx, scene, t, createCanvas);
  };
  return runLoop({ host, still, measure, frame });
}

/** Size the canvas and read everything a frame needs; `null` when nothing can be drawn. */
function measureScene(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  ctx: BackgroundContext,
  id: unknown,
  focus: (() => Element | null) | undefined,
  drawerOf: (key: string, make: () => BackgroundDrawer) => BackgroundDrawer,
): Scene | null {
  const style = activeStyle(host);
  const def = resolveBackground(id, style);
  const make = drawerFor(def.id as keyof typeof BACKGROUND_REGISTRY);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = host.clientWidth;
  const H = host.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colours = readBackgroundColours(host, ctx);
  if (!make || !colours || W === 0 || H === 0) return null;
  const drawer = drawerOf(`${def.id}|${W}|${H}`, make);
  drawer.resize(W, H);
  const focusEl = focus?.() ?? null;
  const focusBox = focusEl ? boxIn(focusEl, host) : centreBox(W, H);
  const clear = focusEl && !def.gathersAroundFocus ? focusBox : null;
  return { W, H, colours, style, focus: focusBox, clear, drawer };
}

/** Draw one frame of `scene` at `t` seconds, then its clear area. */
function drawFrame(
  ctx: BackgroundContext,
  scene: Scene,
  t: number,
  createCanvas: (w: number, h: number) => BackgroundCanvas | null,
): void {
  ctx.save();
  scene.drawer.frame(ctx, t, {
    colours: scene.colours,
    style: scene.style,
    focus: scene.focus,
    createCanvas,
  });
  ctx.restore();
  if (scene.clear) drawClearArea(ctx, scene.clear, scene.colours);
}

interface LoopOptions {
  host: HTMLElement;
  still: boolean;
  measure: () => void;
  frame: (t: number) => void;
}

/** The throttled, visibility-aware loop and every observer that feeds it. */
function runLoop({ host, still, measure, frame }: LoopOptions): () => void {
  let raf = 0;
  let last = 0;
  let visible = true;
  const start = performance.now();
  const tick = (now: number) => {
    raf = 0;
    if (!visible || document.hidden) return;
    if (now - last >= BACKGROUND_FRAME_MS) {
      last = now;
      frame((now - start) / 1000);
    }
    raf = requestAnimationFrame(tick);
  };
  const showing = () => visible && !document.hidden;
  // Reduced motion: the still frame is t = 0, drawn once per measure and never
  // animated. Otherwise the loop runs while the host is showing.
  const play = () => {
    if (!still && !raf && showing()) raf = requestAnimationFrame(tick);
  };
  const refresh = () => {
    measure();
    if (!showing()) return;
    frame(still ? 0 : (performance.now() - start) / 1000);
    play();
  };
  // Coming back on screen: redraw the still frame, or restart the loop.
  const resume = () => {
    if (!showing()) return;
    if (still) frame(0);
    else play();
  };
  const stopObserving = observe(host, refresh, (isVisible) => {
    visible = isVisible;
    resume();
  });
  const onVisibility = resume;
  document.addEventListener('visibilitychange', onVisibility);
  void document.fonts?.ready?.then(refresh);
  refresh();
  return () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    stopObserving();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Resize, theme and on-screen observers. Each is skipped where the platform lacks it. */
function observe(
  host: HTMLElement,
  refresh: () => void,
  onVisible: (visible: boolean) => void,
): () => void {
  const stops: Array<() => void> = [];
  let pending = 0;
  if (typeof ResizeObserver !== 'undefined') {
    const resize = new ResizeObserver(() => {
      window.clearTimeout(pending);
      pending = window.setTimeout(refresh, RESIZE_SETTLE_MS);
    });
    resize.observe(host);
    stops.push(() => resize.disconnect());
  }
  if (typeof MutationObserver !== 'undefined') {
    const themed = new MutationObserver(refresh);
    const attributeFilter = [...BACKGROUND_THEME_ATTRIBUTES];
    themed.observe(document.documentElement, { attributes: true, attributeFilter });
    const scope = host.closest('[data-theme],[data-palette],[data-style]');
    if (scope && scope !== document.documentElement) {
      themed.observe(scope, { attributes: true, attributeFilter });
    }
    stops.push(() => themed.disconnect());
  }
  if (typeof IntersectionObserver !== 'undefined') {
    const seen = new IntersectionObserver(([entry]) => onVisible(entry?.isIntersecting ?? true));
    seen.observe(host);
    stops.push(() => seen.disconnect());
  }
  return () => {
    window.clearTimeout(pending);
    stops.forEach((stop) => stop());
  };
}
