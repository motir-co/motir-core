import { describe, expect, it } from 'vitest';
import { FOLLOW_CLEARANCE_PX, followScrollTop, isScrollKey } from '@/lib/planning/followWriting';

// FOLLOW THE WRITING, PURE RULES (MOTIR-11248; design Part XXX §30.4, §30.5).

const column = { clientHeight: 400, scrollHeight: 2000 };

describe('followScrollTop — the minimal move that keeps the caret in view (§30.4)', () => {
  it('moves nothing while the caret is inside the clear band', () => {
    expect(
      followScrollTop({ ...column, scrollTop: 0, caretTop: 100, caretBottom: 116 }),
    ).toBeNull();
  });

  it('scrolls down so the caret line has 48px clear below it', () => {
    const top = followScrollTop({ ...column, scrollTop: 0, caretTop: 500, caretBottom: 516 });
    expect(top).toBe(516 + FOLLOW_CLEARANCE_PX - 400);
  });

  it('counts the band itself: a caret 20px above the bottom still moves', () => {
    const top = followScrollTop({ ...column, scrollTop: 100, caretTop: 464, caretBottom: 480 });
    expect(top).toBe(480 + 48 - 400);
  });

  it('scrolls UP to a caret above the view (the title grew), with 48px clear above', () => {
    const top = followScrollTop({ ...column, scrollTop: 900, caretTop: 120, caretBottom: 150 });
    expect(top).toBe(120 - 48);
  });

  it('clamps at the top and at the end of the content', () => {
    expect(followScrollTop({ ...column, scrollTop: 300, caretTop: 10, caretBottom: 30 })).toBe(0);
    expect(followScrollTop({ ...column, scrollTop: 0, caretTop: 1980, caretBottom: 1996 })).toBe(
      1600,
    );
  });

  it('answers null when the clamped move would not change anything', () => {
    // Already at the end: the band cannot be honoured, and nothing can move.
    expect(
      followScrollTop({ ...column, scrollTop: 1600, caretTop: 1980, caretBottom: 1996 }),
    ).toBeNull();
    // Already at the top with the title's caret near it.
    expect(followScrollTop({ ...column, scrollTop: 0, caretTop: 10, caretBottom: 30 })).toBeNull();
  });

  it('a column with no overflow never moves', () => {
    expect(
      followScrollTop({
        scrollTop: 0,
        clientHeight: 400,
        scrollHeight: 300,
        caretTop: 280,
        caretBottom: 296,
      }),
    ).toBeNull();
  });
});

describe('isScrollKey — the reader asking the column to scroll (§30.5)', () => {
  const key = (
    k: string,
    mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey', boolean>> = {},
  ) => ({
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  });
  const on = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable });

  it('takes the scroll keys, Space included', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) {
      expect(isScrollKey(key(k), null)).toBe(true);
      expect(isScrollKey(key(k), on('A'))).toBe(true);
    }
  });

  it('ignores every other key and a key made a shortcut by a modifier', () => {
    expect(isScrollKey(key('Tab'), null)).toBe(false);
    expect(isScrollKey(key('Enter'), null)).toBe(false);
    expect(isScrollKey(key('ArrowLeft'), null)).toBe(false);
    expect(isScrollKey(key('ArrowDown', { altKey: true }), null)).toBe(false);
    expect(isScrollKey(key('Home', { ctrlKey: true }), null)).toBe(false);
    expect(isScrollKey(key('ArrowUp', { metaKey: true }), null)).toBe(false);
  });

  it('ignores keys typed into a field, where they move a text cursor', () => {
    expect(isScrollKey(key('ArrowDown'), on('INPUT'))).toBe(false);
    expect(isScrollKey(key('End'), on('TEXTAREA'))).toBe(false);
    expect(isScrollKey(key('ArrowUp'), on('SELECT'))).toBe(false);
    expect(isScrollKey(key(' '), on('DIV', true))).toBe(false);
  });

  it('ignores Space on a control it presses, but not an arrow there', () => {
    expect(isScrollKey(key(' '), on('BUTTON'))).toBe(false);
    expect(isScrollKey(key(' '), on('SUMMARY'))).toBe(false);
    expect(isScrollKey(key('PageDown'), on('BUTTON'))).toBe(true);
  });
});
