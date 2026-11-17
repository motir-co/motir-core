// The clear area: a feathered fade in the page background colour behind the
// page's main content, so text over a busy background stays readable. Every
// background gets it except the one that gathers around the content instead
// (the Wave — `gathersAroundFocus` in the registry).

import { rgba } from './colour';
import type { BackgroundBox, BackgroundColours, BackgroundContext } from './types';

/** How far the fade reaches past the content box, in CSS pixels. */
export const CLEAR_AREA_FEATHER = { x: 150, y: 110 } as const;

/**
 * Paint an elliptical fade centred on `box`: nearly solid page colour across
 * the box itself, feathering to nothing `CLEAR_AREA_FEATHER` beyond its edges.
 */
export function drawClearArea(
  ctx: BackgroundContext,
  box: BackgroundBox,
  colours: BackgroundColours,
): void {
  if (box.w <= 0 || box.h <= 0) return;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rx = box.w / 2 + CLEAR_AREA_FEATHER.x;
  const ry = box.h / 2 + CLEAR_AREA_FEATHER.y;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, rgba(colours.bg, 0.9));
  g.addColorStop(Math.min(0.9, box.w / 2 / rx), rgba(colours.bg, 0.82));
  g.addColorStop(1, rgba(colours.bg, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
