// FOLLOW THE WRITING, AS PURE RULES (MOTIR-11248; design
// `design/ai-planning/design-notes.md` Part XXX §30.4, §30.5).
//
// The proposal quick view of a card being written offers a toggle that keeps the
// caret in view after every read. This module decides, purely:
//   - where the main column has to scroll to so the caret's line sits inside it
//     with a clear band around it — or that it need not move at all (§30.4);
//   - which key presses are the reader asking the column to scroll, which turn
//     following off (§30.5).
//
// PURE: no React, no DOM reads.

/** The space kept clear below (or above) the caret's line: two lines of body text. */
export const FOLLOW_CLEARANCE_PX = 48;

/** The column and the caret, measured in the column's own scroll coordinates. */
export interface FollowGeometry {
  /** The column's current `scrollTop`. */
  scrollTop: number;
  /** Its visible height (`clientHeight`). */
  clientHeight: number;
  /** Its content height (`scrollHeight`). */
  scrollHeight: number;
  /** The caret's top, from the top of the column's content. */
  caretTop: number;
  /** The caret's bottom, from the top of the column's content. */
  caretBottom: number;
}

/**
 * The `scrollTop` that brings the caret's line into view with
 * {@link FOLLOW_CLEARANCE_PX} clear below it (scrolling down) or above it
 * (scrolling up, to the title) — the MINIMAL move, so the column does not
 * re-centre on every read. `null` when the caret is already inside that band, or
 * when the move would be clamped to where the column already is.
 */
export function followScrollTop(g: FollowGeometry): number | null {
  const maxTop = Math.max(0, g.scrollHeight - g.clientHeight);
  let target: number;
  if (g.caretBottom + FOLLOW_CLEARANCE_PX > g.scrollTop + g.clientHeight) {
    target = g.caretBottom + FOLLOW_CLEARANCE_PX - g.clientHeight;
  } else if (g.caretTop - FOLLOW_CLEARANCE_PX < g.scrollTop) {
    target = g.caretTop - FOLLOW_CLEARANCE_PX;
  } else {
    return null;
  }
  const clamped = Math.round(Math.min(maxTop, Math.max(0, target)));
  return clamped === Math.round(g.scrollTop) ? null : clamped;
}

/** The keys that scroll a column the reader has focused or clicked into (§30.5). */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** What a key event says about where it was typed — enough to tell a scroll from typing. */
export interface ScrollKeyTarget {
  /** The focused element's tag name (`INPUT`, `BUTTON`, `A`, …), upper case. */
  tagName: string;
  /** The focused element is `contenteditable`. */
  isContentEditable: boolean;
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
// Space on these activates them rather than scrolling the page.
const SPACE_ACTIVATES = new Set(['BUTTON', 'SUMMARY']);

/**
 * The reader is asking the column to scroll: ↑ ↓ PageUp PageDown Home End Space
 * Shift+Space, with no modifier that turns the key into a shortcut, and not typed
 * into a field (where the keys move a text cursor) or onto a control Space presses.
 */
export function isScrollKey(
  event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  target: ScrollKeyTarget | null,
): boolean {
  if (!SCROLL_KEYS.has(event.key)) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  if (target) {
    if (target.isContentEditable || EDITABLE_TAGS.has(target.tagName)) return false;
    if (event.key === ' ' && SPACE_ACTIVATES.has(target.tagName)) return false;
  }
  return true;
}
