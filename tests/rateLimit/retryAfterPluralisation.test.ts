import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimitExceededError, type RateLimitDecision } from '@/lib/api/v1/rateLimit';
import { rateLimitedResponse } from '@/lib/rateLimit/guard';
import { mcpRateLimitedResponse } from '@/lib/rateLimit/mcpGuard';

// ── The "Retry in N second(s)" pluralisation, on purpose (MOTIR-2688) ────────
//
// Three surfaces build the same sentence with the same ternary:
//
//   lib/rateLimit/mcpGuard.ts   the JSON-RPC error envelope on POST /api/mcp
//   lib/rateLimit/guard.ts      the app's `{ code, error }` 429
//   lib/api/v1/rateLimit.ts     RateLimitExceededError, the /api/v1 429
//
// ⚠️ NONE OF THEM HAD A DELIBERATE TEST FOR THE PLURAL ARM, AND TWO OF THEM WERE
// GREEN ANYWAY. That is the whole reason this file exists, and it is worth being
// precise about, because the obvious reading of the red build that produced it
// is the wrong one.
//
// The suites that exercise these surfaces used to leave the rate-limit window at
// its shipped 60 s default. `retryAfterSeconds` is
// `max(1, resetAt - now)` against an EPOCH-ALIGNED bucket, so the countdown
// landed on a different number every run — usually well above 1, which took the
// `'s'` arm and coloured the branch covered. The coverage was being supplied by
// a race.
//
// MOTIR-2648 then pinned those windows, correctly: the same nondeterminism had
// been failing tests at random across four cards (MOTIR-2101 → 2224 → 2598 →
// 2647), and pinning is what stopped it. With the window pinned the countdown
// reads `1` every time, the plural arm stopped executing, and
// `lib/rateLimit/mcpGuard.ts` fell to 75 % branches and took `main` red — which
// red-lights every open PR, since PR CI composes each branch with `main`.
//
// So the gate was right and MOTIR-2648 was right. No shipped behaviour changed;
// a hole that had existed since the message was written became visible the
// moment the noise hiding it was cleaned up. **Removing nondeterminism can lower
// coverage, and where it does, the number was never real.** The two tempting
// repairs — restoring the flake, or lowering the threshold — each delete the
// only evidence that a shipped code path is untested.
//
// ⚠️ ALL THREE ARE PINNED HERE, not just the one that went red. `guard.ts` reads
// 100 % branches today and `lib/api/v1/rateLimit.ts` reads 94.44 % with line 66
// — the pluralisation — uncovered; the second is the same hole surviving only
// because the file has other branches to dilute it, and the first is a number
// nobody should trust after the paragraph above. Fixing this one file at a time
// is precisely the failure mode MOTIR-2648 was itself filed on.
//
// ⚠️ AND THESE ASSERTIONS MUST NEVER DEPEND ON TIMING. Every case builds the
// decision directly, asserts through the public surface, and touches no
// database, no window and no clock beyond `Date.now()` for the offset. A test
// whose coverage came from a race is not repaired by another race.

/** A refusal whose countdown is `secondsOut`, give or take a clock tick. */
function refusal(secondsOut: number): RateLimitDecision {
  return {
    allowed: false,
    limit: 60,
    remaining: 0,
    resetAt: Math.floor(Date.now() / 1000) + secondsOut,
    degraded: false,
  };
}

/**
 * A refusal whose window has already reset — `retryAfterSeconds` floors at 1, so
 * this is the singular arm with no dependence on where the second boundary is.
 */
const SINGULAR = refusal(-5);

/**
 * Far enough out that a tick during the call cannot round it to 1. The
 * assertions below match `\d+ seconds` rather than a literal, for the same
 * reason.
 */
const PLURAL = refusal(42);

describe('POST /api/mcp — the JSON-RPC 429 (MOTIR-2688)', () => {
  it('says "seconds" when more than one remains', async () => {
    const body = await mcpRateLimitedResponse(PLURAL).json();
    expect(body.error.message).toMatch(/^Too many requests\. Retry in \d+ seconds\.$/);
  });

  it('says "second" when exactly one does', async () => {
    const body = await mcpRateLimitedResponse(SINGULAR).json();
    expect(body.error.message).toBe('Too many requests. Retry in 1 second.');
  });

  it('carries the machine-readable countdown either way', async () => {
    // The message is prose an agent should not have to parse; `error.data` is
    // the half it backs off on. Asserted here so a future edit to the sentence
    // cannot quietly take the number with it.
    const body = await mcpRateLimitedResponse(SINGULAR).json();
    expect(body.error.data.retryAfterSeconds).toBe(1);
  });
});

describe('POST /api/mcp — one clock read for body and header (MOTIR-11601)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps Retry-After equal to error.data.retryAfterSeconds when the second ticks mid-call', async () => {
    const base = 1_700_000_000_000;
    const decision: RateLimitDecision = {
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: base / 1000 + 30,
      degraded: false,
    };
    // Every read of the clock lands one second after the previous one, so a
    // second read for the header would disagree with the body.
    let reads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => base + 1000 * reads++);

    const response = mcpRateLimitedResponse(decision);
    const body = await response.json();

    expect(body.error.data.retryAfterSeconds).toBe(30);
    expect(response.headers.get('Retry-After')).toBe(String(body.error.data.retryAfterSeconds));
  });
});

describe('the app 429 — rateLimitedResponse (MOTIR-2688)', () => {
  it('says "seconds" when more than one remains', async () => {
    const body = await rateLimitedResponse(PLURAL).json();
    expect(body.error).toMatch(/^Too many requests\. Retry in \d+ seconds\.$/);
  });

  it('says "second" when exactly one does', async () => {
    const body = await rateLimitedResponse(SINGULAR).json();
    expect(body.error).toBe('Too many requests. Retry in 1 second.');
  });

  it('stamps Retry-After to match the sentence', async () => {
    const response = rateLimitedResponse(SINGULAR);
    expect(response.headers.get('Retry-After')).toBe('1');
  });
});

describe('/api/v1 — RateLimitExceededError (MOTIR-2688)', () => {
  // This one takes the count as a parameter rather than deriving it, so the two
  // arms are reachable without a decision at all — which is exactly why its
  // uncovered line 66 had no excuse.
  it('says "seconds" when more than one remains', () => {
    expect(new RateLimitExceededError(42).message).toBe(
      'Rate limit exceeded. Retry in 42 seconds.',
    );
  });

  it('says "second" when exactly one does', () => {
    expect(new RateLimitExceededError(1).message).toBe('Rate limit exceeded. Retry in 1 second.');
  });

  it('keeps its typed code and status on both arms', () => {
    for (const error of [new RateLimitExceededError(1), new RateLimitExceededError(42)]) {
      expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(error.status).toBe(429);
    }
  });
});
