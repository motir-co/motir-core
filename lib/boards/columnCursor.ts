// The per-lane page cursor of the board (MOTIR-10535). A board lane (column)
// loads one page of cards at a time; the cursor names the LAST card of the page
// the client holds, in the lane's own sort order, so the next page starts
// strictly after it (keyset paging — never an offset, which repeats or skips a
// card the moment one moves between two page reads).
//
// A lane has one of two total orders, and the cursor carries which, so a cursor
// minted for one order is refused by the other rather than silently mis-read:
//
//   - `position` (an open lane):     `position ASC, key ASC`
//   - `recent`   (a done-category lane): `updatedAt DESC, key ASC`
//
// `key` (the per-project item number) is the tiebreaker that makes each order
// total. `updatedAt` is a `TIMESTAMP(3)` column, so a JS `Date` round-trips it
// exactly — no microseconds are lost between the read and the next page's
// predicate.
//
// The wire form is OPAQUE to the client: base64url of a small JSON tuple. It is
// a position in a list, not a capability — every page read re-applies the
// board's tenancy, project-access and filter predicates, so a forged cursor can
// at most choose where in the caller's own lane the page starts.

export type ColumnOrder = 'position' | 'recent';

export type ColumnCursor =
  | { order: 'position'; position: string; key: number }
  | { order: 'recent'; updatedAt: Date; key: number };

type Wire = ['p', string, number] | ['r', string, number];

/** The cursor naming `row` as the last card of a page in a lane of `order`. */
export function cursorAfter(
  order: ColumnOrder,
  row: { position: string; key: number; updatedAt: Date },
): string {
  const wire: Wire =
    order === 'position'
      ? ['p', row.position, row.key]
      : ['r', row.updatedAt.toISOString(), row.key];
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}

/**
 * Decode a wire cursor for a lane of `order`. Answers `null` for anything that
 * is not a cursor this module minted for that order — malformed base64 or JSON,
 * a wrong shape, a non-integer key, an unparseable instant, or a cursor of the
 * OTHER order — so the caller refuses it with one typed error.
 */
export function decodeColumnCursor(raw: string, order: ColumnOrder): ColumnCursor | null {
  let wire: unknown;
  try {
    wire = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(wire) || wire.length !== 3) return null;
  const [tag, value, key] = wire as unknown[];
  if (typeof value !== 'string' || typeof key !== 'number' || !Number.isSafeInteger(key)) {
    return null;
  }
  if (order === 'position') {
    return tag === 'p' && value.length > 0 ? { order, position: value, key } : null;
  }
  if (tag !== 'r') return null;
  const updatedAt = new Date(value);
  return Number.isNaN(updatedAt.getTime()) ? null : { order, updatedAt, key };
}
