import { describe, expect, it } from 'vitest';
import { PageLevelCursorInvalidError } from '@/lib/pages';
import { decodePageSearchCursor, encodePageSearchCursor } from '@/lib/pages/pageSearchCursor';

// The full-text page search cursor (Story MOTIR-9489 · MOTIR-9551): opaque
// base64url of `[rank, id]`, round-tripping exactly, refusing anything else.

const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('pageSearchCursor', () => {
  it('round-trips the seek key, the float rank exactly', () => {
    for (const seek of [
      { rank: 0.0607927106320858, id: 'cmabc' },
      { rank: 0, id: 'x' },
      { rank: 1e-20, id: 'y' },
    ]) {
      expect(decodePageSearchCursor(encodePageSearchCursor(seek))).toEqual(seek);
    }
  });

  it('is opaque base64url', () => {
    expect(encodePageSearchCursor({ rank: 0.5, id: 'abc' })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 json', '%%%'],
    ['an object', raw({ rank: 1, id: 'a' })],
    ['one element', raw([1])],
    ['three elements', raw([1, 'a', 'b'])],
    ['a string rank', raw(['1', 'a'])],
    ['a null rank', raw([null, 'a'])],
    ['an empty id', raw([1, ''])],
    ['a number id', raw([1, 2])],
  ])('refuses %s', (_label, cursor) => {
    expect(() => decodePageSearchCursor(cursor)).toThrow(PageLevelCursorInvalidError);
  });
});
