// The drawing interface every background plugs into. A drawer is plain
// TypeScript over a 2D canvas context: the runtime (`./runtime`) owns the
// canvas, the size, the clock, the token reads and the loop, and calls a drawer
// with everything it needs for one frame.

import type { Rgb } from './colour';
import type { StyleId } from '../theme/styles';

/** A rectangle in CSS pixels, relative to the background's own box. */
export interface BackgroundBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The inks a background paints with, every one read from a design-system token
 * on the live theme (see `./tokens` for the token each comes from).
 */
export interface BackgroundColours {
  /** The page background (`--el-page-bg`): what a background fills its box with. */
  bg: Rgb;
  /** A raised surface (`--el-surface`). */
  surface: Rgb;
  /** Body ink (`--el-text`). */
  ink: Rgb;
  /** A hairline (`--el-border`). */
  line: Rgb;
  /** The accent fill (`--el-accent`). */
  accent: Rgb;
  /** The ink on the accent fill (`--el-accent-text`). */
  onAccent: Rgb;
  /** The palette's three wave hues (`--el-showcase-wave-1..3`). */
  hues: readonly [Rgb, Rgb, Rgb];
  /** The decision touch (`--el-showcase-decision`). */
  decision: Rgb;
  /** The highlight touch (`--el-showcase-highlight`). */
  highlight: Rgb;
  /** The deep ground (`--el-showcase-ground`) — a hard shadow's ink. */
  ground: Rgb;
  /** True when the page background is dark (read from its luminance, not an attribute). */
  dark: boolean;
}

/** Everything a drawer is handed for one frame. */
export interface BackgroundFrameEnv {
  colours: BackgroundColours;
  /** The active `data-style`. A background that does not follow the style ignores it. */
  style: StyleId;
  /**
   * The main content's box. Always set: with no focus element it is a centred
   * box, so a gathering background still has somewhere to gather.
   */
  focus: BackgroundBox;
  /**
   * Makes an off-screen canvas (a cellular automaton paints its grid into one
   * and scales it up). The runtime supplies `document.createElement`; a test
   * supplies a fake.
   */
  createCanvas: (width: number, height: number) => BackgroundCanvas | null;
}

/** The slice of an off-screen canvas a drawer uses. */
export interface BackgroundCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): BackgroundContext | null;
}

/**
 * The slice of `CanvasRenderingContext2D` a drawer may use. Typed as the DOM
 * context so drawers are checked against the real API; tests pass a recording
 * stand-in.
 */
export type BackgroundContext = CanvasRenderingContext2D;

/** One background's drawing, made fresh per canvas (it may hold per-size state). */
export interface BackgroundDrawer {
  /** The box changed size (CSS pixels). Called before the first frame. */
  resize(width: number, height: number): void;
  /**
   * Draw the frame at `t` seconds. It MUST paint its whole box — the first frame
   * fills the screen — and must not throw over a missing ink.
   */
  frame(ctx: BackgroundContext, t: number, env: BackgroundFrameEnv): void;
}

/** Makes a drawer. */
export type BackgroundDrawerFactory = () => BackgroundDrawer;
