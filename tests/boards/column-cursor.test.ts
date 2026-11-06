import { describe, expect, it } from 'vitest';
import { cursorAfter, decodeColumnCursor } from '@/lib/boards/columnCursor';

// The board lane's keyset cursor (MOTIR-10535): opaque on the wire, typed by
// the lane's order, and refused — never mis-read — when it is anything else.

const row = { position: 'a0V', key: 42, updatedAt: new Date('2026-11-06T12:34:56.789Z') };
const wire = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');

describe('board lane cursor', () => {
  it('round-trips a position cursor', () => {
    expect(decodeColumnCursor(cursorAfter('position', row), 'position')).toEqual({
      order: 'position',
      position: 'a0V',
      key: 42,
    });
  });

  it('round-trips a recency cursor to the millisecond', () => {
    const decoded = decodeColumnCursor(cursorAfter('recent', row), 'recent');
    expect(decoded).toEqual({ order: 'recent', updatedAt: row.updatedAt, key: 42 });
  });

  it('is opaque url-safe text', () => {
    expect(cursorAfter('position', row)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a cursor of the OTHER order', () => {
    expect(decodeColumnCursor(cursorAfter('position', row), 'recent')).toBeNull();
    expect(decodeColumnCursor(cursorAfter('recent', row), 'position')).toBeNull();
  });

  it.each([
    ['not base64 json', 'not-a-cursor'],
    ['an object, not a tuple', wire({ p: 'a0', k: 1 })],
    ['a short tuple', wire(['p', 'a0'])],
    ['a non-string value', wire(['p', 7, 1])],
    ['a fractional key', wire(['p', 'a0', 1.5])],
    ['an unsafe key', wire(['p', 'a0', Number.MAX_SAFE_INTEGER + 2])],
    ['a string key', wire(['p', 'a0', '1'])],
    ['an empty position', wire(['p', '', 1])],
    ['an unknown tag', wire(['x', 'a0', 1])],
  ])('refuses %s for a position lane', (_label, raw) => {
    expect(decodeColumnCursor(raw, 'position')).toBeNull();
  });

  it('refuses an unparseable instant for a recency lane', () => {
    expect(decodeColumnCursor(wire(['r', 'yesterday-ish', 1]), 'recent')).toBeNull();
    expect(decodeColumnCursor(wire(['x', '2026-01-01T00:00:00.000Z', 1]), 'recent')).toBeNull();
  });
});
