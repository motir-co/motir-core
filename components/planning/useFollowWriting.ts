'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';
import { followScrollTop, isScrollKey } from '@/lib/planning/followWriting';

// FOLLOW THE WRITING (MOTIR-11248; design `design/ai-planning/design-notes.md`
// Part XXX §30.2, §30.4, §30.5).
//
// The proposal quick view's main column keeps the caret of a card being written in
// view while the reader has the toggle pressed. Following is VIEW STATE of the open
// quick view: it starts off, the panel is keyed per proposal so another card starts
// off too, and it ends with the writing.
//
// ⚠️ THE READER'S SCROLL IS READ FROM THE INPUT THAT CAUSES IT, NEVER FROM `scroll`.
// The follow's own `scrollTop` write and the browser's scroll anchoring both fire
// `scroll` as well, so a `scroll` listener could only tell them apart with a timing
// window or a "this one was mine" flag, and both race (§30.5). A wheel, a finger,
// a press on the scrollbar or a scroll key is only ever the reader's.

const CARET = '[data-live-caret]';

/** Where the caret sits in the column's own scroll coordinates. */
function caretGeometry(scroller: HTMLElement, caret: Element) {
  const column = scroller.getBoundingClientRect();
  const at = caret.getBoundingClientRect();
  const offset = scroller.scrollTop - column.top - scroller.clientTop;
  return {
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    caretTop: at.top + offset,
    caretBottom: at.bottom + offset,
  };
}

export interface FollowWriting {
  /** The toggle is pressed. */
  following: boolean;
  /** The toggle's press: on ⇄ off. */
  toggle: () => void;
}

/**
 * @param writing the card is being written (the cue reads `writing`): only then is
 *   there anything to follow, and following ends when it stops.
 * @param scrollerRef the quick view's main column — the ONE element whose
 *   `scrollTop` following writes (never `scrollIntoView`, which would also move
 *   the overlay and the page, §30.4).
 */
export function useFollowWriting(
  writing: boolean,
  scrollerRef: RefObject<HTMLElement | null>,
): FollowWriting {
  const [following, setFollowing] = useState(false);
  // Writing ended while following: the control goes, and nothing is followed any
  // more, so a later card's writing in the same open view starts off again (§30.2).
  if (following && !writing) setFollowing(false);
  const on = following && writing;
  // Read by the layout effect and turned off by the input listeners SYNCHRONOUSLY,
  // so a read that renders between the reader's wheel and React's re-render never
  // moves the column under their hand.
  const live = useRef(on);
  // Synced in a layout effect declared BEFORE the follow effect, so the follow
  // effect of the same commit reads this render's value.
  useLayoutEffect(() => {
    live.current = on;
  });
  // The press scrolls smoothly (it can be a long trip); every later read is instant.
  const pressed = useRef(false);
  const reduced = usePrefersReducedMotion();

  const toggle = useCallback(() => {
    setFollowing((was) => {
      pressed.current = !was;
      return !was;
    });
  }, []);

  // After every render that holds the caret: bring it into view. A layout effect,
  // and this panel's own, so it runs after `LiveDraftField` has drawn the caret in
  // this same commit (children's layout effects run first).
  useLayoutEffect(() => {
    if (!live.current) return;
    const scroller = scrollerRef.current;
    const caret = scroller?.querySelector(CARET);
    // Pressed before any partial arrived (P1): nothing moves until one does, and
    // then it moves as any read does.
    const smooth = pressed.current && !reduced;
    pressed.current = false;
    if (!scroller || !caret) return;
    const top = followScrollTop(caretGeometry(scroller, caret));
    if (top === null) return;
    scroller.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  });

  // While following, the reader's own intent to scroll the column turns it off,
  // in the same frame as the input and before the browser scrolls (§30.5).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!on || !scroller) return;
    const stop = () => {
      if (!live.current) return;
      live.current = false;
      setFollowing(false);
    };
    // A press on the column ITSELF is its scrollbar; a press on text targets the
    // text (and selects it), which moves nothing.
    let clickedIn = false;
    const onPointerDownAnywhere = (e: PointerEvent) => {
      clickedIn = e.target instanceof Node && scroller.contains(e.target);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === scroller) stop();
    };
    const keyTarget = (el: Element | null) =>
      el instanceof HTMLElement
        ? { tagName: el.tagName, isContentEditable: el.isContentEditable }
        : null;
    // Focus inside the column (Tab into it).
    const onKeyDown = (e: KeyboardEvent) => {
      if (isScrollKey(e, keyTarget(e.target as Element | null))) stop();
    };
    // Clicked into the column with nothing focusable under the click: focus stays on
    // <body> (or the dialog around the column), and the browser scrolls the column
    // the reader last clicked into.
    const onDocumentKeyDown = (e: KeyboardEvent) => {
      if (!clickedIn) return;
      const active = scroller.ownerDocument.activeElement;
      const around = !active || active === scroller.ownerDocument.body || active.contains(scroller);
      if (around && isScrollKey(e, null)) stop();
    };
    const doc = scroller.ownerDocument;
    scroller.addEventListener('wheel', stop, { passive: true });
    scroller.addEventListener('touchstart', stop, { passive: true });
    scroller.addEventListener('pointerdown', onPointerDown);
    scroller.addEventListener('keydown', onKeyDown);
    doc.addEventListener('pointerdown', onPointerDownAnywhere, true);
    doc.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      scroller.removeEventListener('wheel', stop);
      scroller.removeEventListener('touchstart', stop);
      scroller.removeEventListener('pointerdown', onPointerDown);
      scroller.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('pointerdown', onPointerDownAnywhere, true);
      doc.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [on, scrollerRef]);

  return { following: on, toggle };
}
