import { CODE_HISTORY_TIMEOUT_MS } from './provider';
import type { CodeBlameRange, CodeHistoryKind, CodeHistoryResult } from './types';

// The host-agnostic pieces of `GitProvider.readCodeHistory` (MOTIR-10237) — the
// deadline-bounded fetch, the subject line, and the blame folding both providers
// share, so the GitHub and GitLab implementations differ only in WHICH endpoint they
// ask and how they read its answer.
//
// ⚠️ METADATA ONLY. Nothing here reads a diff, a hunk or a line of content: a log
// is commit metadata and a blame is line NUMBERS against commits.

/** The three fields every {@link CodeHistoryResult} member carries. */
export interface CodeHistoryAsked {
  kind: CodeHistoryKind;
  path: string;
  ref: string;
}

/** What a deadline-bounded host call came back with: a response, or why there is none. */
export type HostCall = { ok: true; res: Response } | { ok: false; detail: string };

/**
 * One GET or POST to a git host, aborted after {@link CODE_HISTORY_TIMEOUT_MS}. A
 * fetch that rejects is answered as the detail a `host_error` carries — never a
 * throw — and the detail never includes the URL or the headers, so nothing
 * credential-shaped can reach a result through it.
 */
export async function fetchWithinDeadline(url: string, init: RequestInit): Promise<HostCall> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODE_HISTORY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { ok: true, res };
  } catch (err) {
    return {
      ok: false,
      detail: controller.signal.aborted
        ? `no response within ${CODE_HISTORY_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'unknown',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** A host error, as the named outcome — the one place its shape is built. */
export function codeHistoryHostError(asked: CodeHistoryAsked, detail: string): CodeHistoryResult {
  return { outcome: 'host_error', ...asked, detail };
}

/** The first line of a commit message, trimmed; `''` for none. */
export function subjectLine(message: unknown): string {
  if (typeof message !== 'string') return '';
  const nl = message.indexOf('\n');
  return (nl === -1 ? message : message.slice(0, nl)).trim();
}

/** A non-empty string, or null. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A hex object id (an abbreviated one included), or null. */
export function hexShaOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value) ? value : null;
}

/**
 * Whether a host's refusal body says the history was too big or too slow to
 * compute — the `too_large` answer, as distinct from a host that is simply down.
 */
export function saysTooLarge(body: string): boolean {
  return /too (large|big|many)|taking too long|took too long|timed? ?out|timeout/i.test(body);
}

/**
 * Cut a blame to `max` ranges. Unlike a paged log, a blame arrives WHOLE, so the
 * count is known and only a blame of more than `max` ranges is truncated.
 */
export function capRanges(
  ranges: CodeBlameRange[],
  max: number,
): { blame: CodeBlameRange[]; truncated: boolean } {
  return { blame: ranges.slice(0, max), truncated: ranges.length > max };
}
