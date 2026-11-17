'use client';

/**
 * Draws one background from the registry (`../../backgrounds/registry`) inside
 * its parent's box — the element a page area hands the canvas to. The parent
 * must be `relative isolate` (or otherwise positioned): the canvas sits
 * absolutely behind the content (`absolute inset-0 -z-10`), so it adds nothing
 * to the parent's height and is the middle of the same field at any width.
 *
 * `id` is the stored per-area choice. An unknown or missing id draws the
 * style's default (the Wave), and `none` renders nothing at all.
 *
 * `focusId` names the page's main content — the sign-in card, the hero's idea
 * box. The Wave gathers its lines there; every other background clears a
 * feathered area behind it in the page colour so text stays readable.
 *
 * Decorative only: `aria-hidden`, no pointer events, nothing to tab to. Every
 * colour is a design-system token read from the live theme. It stops drawing
 * off screen and in a hidden tab, and holds one still frame under
 * `prefers-reduced-motion` (see `../../backgrounds/runtime`). `still` holds that
 * one still frame whatever the motion preference — a picker's swatch.
 */

import { useEffect, useRef } from 'react';
import { BACKGROUND_NONE } from '../../backgrounds/registry';
import { startBackground } from '../../backgrounds/runtime';
import { cn } from '../../utils/cn';

export interface BackgroundProps {
  /** The background id, or `none`. */
  id: string | null | undefined;
  /** The id of the element the background gathers around / clears behind. */
  focusId?: string;
  /** Draw one still frame and never animate (a swatch). */
  still?: boolean;
  /** Extra classes for the canvas (it already fills its parent). */
  className?: string;
}

export function Background({ id, focusId, still, className }: Readonly<BackgroundProps>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const none = id === BACKGROUND_NONE;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || none) return;
    return startBackground({
      canvas,
      id,
      focus: focusId ? () => document.getElementById(focusId) : undefined,
      still,
    });
  }, [id, focusId, still, none]);

  if (none) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-background={id ?? ''}
      className={cn('pointer-events-none absolute inset-0 -z-10 block size-full', className)}
    />
  );
}
