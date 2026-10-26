import { PageLevelCursorInvalidError } from '@motir/pages';
import type { PageSearchSeek } from '@/lib/repositories/pageRepository';

// The page full-text search's keyset cursor (Story MOTIR-9489 · MOTIR-9551) —
// the title-search codec (`pageTitleSearchCursor.ts`) applied to this read's
// seek key. Opaque base64url of `[rank, id]`, the last hit served; anything this
// module did not issue is the tree level's `PAGE_CURSOR_INVALID`. Since
// MOTIR-9572 the number is the FUSED score (reciprocal-rank fusion of the
// full-text and by-meaning rankings), not `ts_rank`; the format is unchanged.

export function encodePageSearchCursor(cursor: PageSearchSeek): string {
  return Buffer.from(JSON.stringify([cursor.rank, cursor.id])).toString('base64url');
}

/** Decode a cursor, refusing anything {@link encodePageSearchCursor} did not produce. */
export function decodePageSearchCursor(raw: string): PageSearchSeek {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new PageLevelCursorInvalidError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'number' ||
    !Number.isFinite(parsed[0]) ||
    typeof parsed[1] !== 'string' ||
    parsed[1] === ''
  ) {
    throw new PageLevelCursorInvalidError();
  }
  return { rank: parsed[0], id: parsed[1] };
}
