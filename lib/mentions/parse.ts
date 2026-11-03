// Mention-token parsing (Story 5.1 · Subtask 5.1.2). Mentions serialize into
// stored Markdown as a durable token — `[@Display Name](mention:<userId>)` —
// so the body stays plain Markdown (one storage format, no parallel rich-text
// blob), renders as a user chip in MarkdownView (5.1.4), and is parseable
// server-side. THIS helper is the server-side half: the comments service (and,
// in 5.1.6, the description-mention path) extracts the candidate user ids from
// a body before validating them against the viewable-member set. Pure string
// work — no Prisma, no IO — so it is unit-testable and importable anywhere.

import { withoutCode } from '@/lib/markdown/proseRanges';

/**
 * One mention token: `[@Display Name](mention:<userId>)`. The display name is
 * anything up to the closing bracket (names contain spaces/diacritics); the id
 * is the cuid character set. Defined with `/g` for `matchAll` (which clones
 * the regex per call, so the shared constant carries no lastIndex state).
 *
 * ⚠️ THE NAME CLASS EXCLUDES `[` AS WELL AS `]` (MOTIR-4202). With `[^\]]*`
 * alone, a body of unclosed openers — `[@[@[@…` — made every `matchAll` start
 * position scan to the end of the string before failing at `\]`, which is
 * O(n²) in the body (5.2 s at 80k characters; CodeQL `js/polynomial-redos`,
 * alert #1). Stopping the name at the next `[` bounds each attempt at the next
 * token start. No mention picker emits a `[` inside a display name, so the
 * accepted set is unchanged for every real token.
 */
export const MENTION_TOKEN_RE = /\[@([^\]\[]*)\]\(mention:([A-Za-z0-9_-]+)\)/g;

/**
 * Extract the mentioned user ids from a Markdown body, DEDUPED in first-seen
 * order — one candidate per user regardless of how many times the token
 * repeats (the `@@unique([commentId, mentionedUserId])` substrate stores one
 * row per user). Malformed near-tokens (no `mention:` scheme, unclosed
 * bracket) simply don't match — they are body text, never an error.
 *
 * ⚠️ A TOKEN INSIDE CODE IS NOT A MENTION (MOTIR-10233). It renders as literal text,
 * so it must not notify anyone, the rule work-item references already follow.
 */
export function parseMentionIds(bodyMd: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  // No token anywhere ⇒ nothing to find, and no parse to pay for.
  if (!bodyMd.includes('mention:')) return ids;
  for (const match of withoutCode(bodyMd).matchAll(MENTION_TOKEN_RE)) {
    // The id group is `+`-quantified, so a match always captures it; the cast
    // only papers over noUncheckedIndexedAccess (no runtime branch).
    const id = match[2] as string;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
