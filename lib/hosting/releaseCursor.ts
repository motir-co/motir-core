import { InvalidReleaseCursorError } from '@/lib/hosting/errors';

// The opaque cursor for a repository's production release history (Story
// MOTIR-9797 · MOTIR-10036): a base64url JSON tuple `(createdAt, id)`, the same
// codec as the public changelog's. Both halves are load-bearing — `createdAt` is
// the sort key and `id` the tiebreak, because two releases created in the same
// millisecond tie and an unbroken tie makes a page boundary skip or repeat one.

export interface ReleaseCursor {
  /** ISO 8601 — the last release on the previous page. */
  createdAt: string;
  /** That release's id. */
  id: string;
}

/** Encode a `(createdAt, id)` position into the opaque page token. */
export function encodeReleaseCursor(cursor: ReleaseCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

/**
 * Decode the opaque token back to its position, validating every field, so a
 * hand-edited token answers 400 instead of reaching the query as `Invalid Date`
 * and silently returning an empty page.
 */
export function decodeReleaseCursor(raw: string): ReleaseCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidReleaseCursorError();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new InvalidReleaseCursorError();
  const [createdAt, id] = parsed as [unknown, unknown];
  if (typeof createdAt !== 'string' || Number.isNaN(new Date(createdAt).getTime())) {
    throw new InvalidReleaseCursorError();
  }
  if (typeof id !== 'string' || id.length === 0) throw new InvalidReleaseCursorError();
  return { createdAt, id };
}
