import { describe, expect, it } from 'vitest';
import {
  PLAN_GAP_FIELD_MAX,
  PLAN_GAP_REFS_MAX,
  PlanGapRefusal,
  parsePlanGapEntries,
  parsePlanGapEntry,
} from '@/lib/plans/planRaisedGap';

// The pure half of MOTIR-10176: what a `gaps` entry may say, and what is stored of it.

describe('parsePlanGapEntry — a raise', () => {
  it('keeps every field, trimmed, and an absent optional as null', () => {
    expect(
      parsePlanGapEntry({
        op: 'raise',
        id: ' g-1 ',
        level: 'planItem:story',
        raisedBy: 'planItem:adapter',
        what: '  Nothing creates the role. ',
        decision: 'Who owns it',
        before: 'planItem:b',
        note: 'from the check',
      }),
    ).toEqual({
      op: 'raise',
      id: 'g-1',
      level: 'planItem:story',
      raisedBy: 'planItem:adapter',
      what: 'Nothing creates the role.',
      decision: 'Who owns it',
      after: null,
      before: 'planItem:b',
      note: 'from the check',
      amended: false,
    });
  });

  it('keeps a gap’s line breaks and drops every other control character', () => {
    const g = parsePlanGapEntry({
      op: 'raise',
      id: 'g',
      what: 'one\r\ntwo\u0007three',
      level: 'a\nb',
    });
    expect(g).toMatchObject({ what: 'one\ntwo three', level: 'a b' });
  });

  it('caps a long field with an ellipsis', () => {
    const g = parsePlanGapEntry({ op: 'raise', id: 'g', what: 'x'.repeat(5000) });
    expect(Array.from((g as { what: string }).what)).toHaveLength(PLAN_GAP_FIELD_MAX.what);
    expect((g as { what: string }).what.endsWith('…')).toBe(true);
  });

  it('carries amended: true for a gap raised after its level’s amend', () => {
    expect(parsePlanGapEntry({ op: 'raise', id: 'g', what: 'w', amended: true })).toMatchObject({
      amended: true,
    });
  });

  it.each([
    [null, /must be an object/],
    [[], /must be an object/],
    [{ op: 'raise', what: 'w' }, /\.id is required/],
    [{ op: 'raise', id: 'g' }, /\.what is required/],
    [{ op: 'raise', id: 'g', what: 3 }, /\.what must be a string/],
    [{ op: 'raise', id: 'g', what: 'w', amended: 1 }, /\.amended must be a boolean/],
    [{ op: 'close', id: 'g' }, /\.op must be one of: raise, amend/],
  ])('refuses %j', (raw, message) => {
    expect(() => parsePlanGapEntry(raw)).toThrow(PlanGapRefusal);
    expect(() => parsePlanGapEntry(raw)).toThrow(message);
  });
});

describe('parsePlanGapEntry — an amend', () => {
  it('dedupes its refs and keeps the open part', () => {
    expect(
      parsePlanGapEntry({ op: 'amend', id: 'g', refs: ['a', ' a ', 'b'], open: 'the raiser' }),
    ).toEqual({ op: 'amend', id: 'g', refs: ['a', 'b'], open: 'the raiser' });
  });

  it('reads no refs as an answer that named nothing', () => {
    expect(parsePlanGapEntry({ op: 'amend', id: 'g' })).toEqual({
      op: 'amend',
      id: 'g',
      refs: [],
      open: null,
    });
  });

  it.each([
    [{ op: 'amend', id: 'g', refs: 'a' }, /refs must be an array/],
    [
      {
        op: 'amend',
        id: 'g',
        refs: Array.from({ length: PLAN_GAP_REFS_MAX + 1 }, (_, i) => `r${i}`),
      },
      /refs must be an array of at most/,
    ],
    [{ op: 'amend', id: 'g', refs: [1] }, /refs\[0\] must be a non-empty string/],
    [{ op: 'amend', refs: [] }, /\.id is required/],
  ])('refuses %j', (raw, message) => {
    expect(() => parsePlanGapEntry(raw)).toThrow(message);
  });
});

describe('parsePlanGapEntries — the whole call', () => {
  it('names the failing entry by its index', () => {
    expect(() =>
      parsePlanGapEntries([
        { op: 'raise', id: 'g', what: 'w' },
        { op: 'raise', id: 'h' },
      ]),
    ).toThrow(/^gaps\[1\]\.what/);
  });

  it.each([[[]], ['nope'], [undefined]])('refuses an empty or non-array batch %j', (raw) => {
    expect(() => parsePlanGapEntries(raw)).toThrow(/1 to 50 entries/);
  });
});
