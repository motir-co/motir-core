// Small drawing helpers shared by the Wave and Topography drawers. Plain code
// over a 2D context: no DOM at import time, and no `Path2D` (a test canvas and a
// server render have none) — `PathRec` records a path and replays it.

import { mixRgb, rgba, type Rgb } from './colour';
import type { BackgroundColours, BackgroundContext } from './types';

/** A token colour as a CSS colour string, at an opacity. */
export const A = (c: Rgb, a = 1): string => rgba(c, a);
/** Mix two token colours. */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => mixRgb(a, b, t);

/** A deterministic hash in [-1, 1) — the same jitter every frame for the same inputs. */
export function hash(a: number, b: number, c: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** A rounded-rectangle path. */
export function rr(
  ctx: BackgroundContext,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const q = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}

/** The palette's wave hues as a horizontal gradient that slides with time — today's HeroWaves band. */
export function hueBand(
  ctx: BackgroundContext,
  W: number,
  tt: number,
  c: BackgroundColours,
): CanvasGradient {
  const period = W * 1.4;
  const x0 = -period * ((tt * 0.035) % 1);
  const g = ctx.createLinearGradient(x0, 0, x0 + period * 2, 0);
  const cyc = [...c.hues, ...c.hues, c.hues[0]];
  cyc.forEach((h, i) => g.addColorStop(i / (cyc.length - 1), A(h)));
  return g;
}

type PathOp =
  | { k: 'm'; x: number; y: number }
  | { k: 'l'; x: number; y: number }
  | { k: 'r'; x: number; y: number; w: number; h: number };

/** A recorded path: the slice of `Path2D` the drawers use, replayable into any context. */
export class PathRec {
  readonly ops: PathOp[] = [];
  moveTo(x: number, y: number): void {
    this.ops.push({ k: 'm', x, y });
  }
  lineTo(x: number, y: number): void {
    this.ops.push({ k: 'l', x, y });
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ k: 'r', x, y, w, h });
  }
  addPath(p: PathRec): void {
    this.ops.push(...p.ops);
  }
}

function replay(ctx: BackgroundContext, p: PathRec): void {
  ctx.beginPath();
  for (const o of p.ops) {
    if (o.k === 'm') ctx.moveTo(o.x, o.y);
    else if (o.k === 'l') ctx.lineTo(o.x, o.y);
    else ctx.rect(o.x, o.y, o.w, o.h);
  }
}

/** Stroke a recorded path under the context's current transform and style. */
export function strokePath(ctx: BackgroundContext, p: PathRec): void {
  replay(ctx, p);
  ctx.stroke();
}

/** Fill a recorded path under the context's current transform and style. */
export function fillPath(ctx: BackgroundContext, p: PathRec): void {
  replay(ctx, p);
  ctx.fill();
}
