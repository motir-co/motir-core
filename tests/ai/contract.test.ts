import { describe, it, expect } from 'vitest';
import { JOB_KINDS, ENVELOPE_VERSION } from '@/lib/ai/types';
import type { Problem } from '@/lib/ai/types';
import {
  errorFromProblem,
  MotirAiUnauthorizedError,
  MotirAiBadRequestError,
  MotirAiJobNotFoundError,
  MotirAiUnavailableError,
  MotirAiOutOfCreditsError,
  type MotirAiError,
} from '@/lib/ai/errors';

// CONTRACT TEST — the open side (Subtask 7.1.8). The frozen canonical lists
// below are IDENTICAL to motir-ai's tests/contract.test.ts; each repo asserts
// its own implementation matches them. If the boundary contract
// (motir-ai/docs/contract.md) changes, BOTH copies must change — the only
// cross-repo drift guard possible without a shared package. A deliberately
// mismatched value makes the suite FAIL (the drift-sim tests prove it bites).

// contract.md §5 — the shared error taxonomy. KEEP IN SYNC with motir-ai.
const CANONICAL_ERROR_CODES = [
  'validation_error',
  'unsupported_version',
  'service_unauthorized',
  'token_expired',
  'token_invalid',
  'not_found',
  'permission_denied',
  'conflict',
  'rate_limited',
  'out_of_credits',
  'ai_job_failed',
  // `ai_job_abandoned` (Story MOTIR-2781 — MOTIR-3222). The reaper's verdict when
  // the worker holding a job stopped renewing its lease: NOTHING about the
  // request was judged, so a resubmit is the right response, unlike
  // `ai_job_failed` where the handler ran and rejected something. Added to
  // motir-ai's copy in the same parent run; the two PRs may merge in either
  // order because an unrecognised code falls to `errorFromProblem`'s status-class
  // branch, and 500 already yields `MotirAiUnavailableError`.
  'ai_job_abandoned',
  // `model_unreachable` (Story MOTIR-7220 — motir-ai MOTIR-7236, this side
  // MOTIR-7227): a planner-model save refused because its one-token probe failed.
  // 422, so the status-class fallback already made it a bad request; it is named
  // in `errorFromProblem` so nobody reads it as retryable.
  'model_unreachable',
  'internal_error',
  // `codegraph_unavailable` (Story MOTIR-11870 — motir-ai MOTIR-12054, this side
  // MOTIR-12055): 503, motir-ai could not reach motir-codegraph. The code-graph
  // forward's one retryable answer; named in `errorFromProblem`.
  'codegraph_unavailable',
] as const;

// contract.md §2.3 — the jobKind enum. KEEP IN SYNC with motir-ai.
const CANONICAL_JOB_KINDS = [
  'noop',
  'discovery',
  'generate_explanation',
  // `analyze_bug` (Story 7.6 — MOTIR-967 handler / MOTIR-1481 trigger); already
  // in motir-ai's canonical set (motir-ai/tests/contract.test.ts, contract.md §2.3).
  'analyze_bug',
  // `propose_convention` (Story 7.14 — MOTIR-1601 handler / MOTIR-839 fresh trigger);
  // live in motir-ai's canonical set (motir-ai/tests/contract.test.ts, contract.md §2.3).
  'propose_convention',
  // `plan_sprint` (Story 7.13 — MOTIR-917 handler / MOTIR-918 consumer); already in
  // motir-ai's canonical set. Adding it HERE closes the drift motir-ai's envelope
  // documented while its motir-core consumer was unbuilt — which is exactly the
  // drift this guard exists to surface.
  'plan_sprint',
  // `ask_project` (Story MOTIR-1343 — MOTIR-1817 handler / MOTIR-1819 consumer);
  // already in motir-ai's canonical set. Adding it HERE closes the drift that
  // card's envelope documented while this consumer was unbuilt.
  'ask_project',
  // `plan` (Story MOTIR-3943 — MOTIR-4304). THE ONE PLANNING KIND: after ADR
  // `session-model.md` §6 step 2 all six planning submit sites send it, and
  // motir-ai resolves what the run is about from the CONTEXT rather than from
  // the name. Already in motir-ai's canonical set (declared by MOTIR-3940's step
  // 1, which made it ACCEPTED while motir-core was still sending the five old
  // kinds); adding it HERE closes that member of the drift.
  //
  // ⚠️ THE DRIFT THAT REMAINS IS REAL AND INTENDED, and a reader must be able to
  // tell it from an oversight: motir-ai's list also carries `code_audit` and
  // `security_audit`, whose motir-core mirrors land with their own consumer
  // surfaces — that pair is UNRELATED to this story and predates it.
  //
  // ⚠️ THE PLANNING WINDOW IS CLOSED (MOTIR-4308). For two cards the five old
  // members sat in BOTH lists on purpose — motir-ai kept accepting them until
  // MOTIR-4306, motir-core kept declaring them until this one — so the sender's
  // switch stayed revertible on its own. The two lists now agree on the planning
  // kind again: exactly one, `plan`. Re-read `motir-ai/tests/contract.test.ts`
  // at the merge base rather than trusting this comment; that list changes
  // without warning from this side, which is the whole reason this guard exists.
  'plan',
  // `author_bug` (Story MOTIR-4930 — MOTIR-5847 handler / MOTIR-5849 trigger);
  // already in motir-ai's canonical set. Adding it HERE, with the trigger that
  // sends it, closes the drift that card's envelope documented while this
  // consumer was unbuilt.
  'author_bug',
  // `guide_work_item` (Story MOTIR-7459 — MOTIR-7463 handler / MOTIR-7464 dispatch);
  // already in motir-ai's canonical set. Adding it HERE, with the guide door that
  // sends it, closes the drift that card's envelope documented.
  'guide_work_item',
  // `sharpen_turn` (Task MOTIR-1101 — MOTIR-8176 handler / MOTIR-8181 dispatch);
  // already in motir-ai's canonical set. Adding it HERE, with the Sharpen door
  // that sends it, closes the drift that card's envelope documented.
  'sharpen_turn',
  // `translate` (Story MOTIR-7735 — MOTIR-8116 handler / MOTIR-8119 client);
  // added in motir-ai's canonical set by the handler card. Adding it HERE, with the
  // client that sends it, keeps the two lists one decision.
  'translate',
] as const;

// The motir-core typed error each canonical code maps to (lib/ai/errors.ts).
const EXPECTED_MAPPING: Record<string, new (...args: never[]) => MotirAiError> = {
  validation_error: MotirAiBadRequestError,
  unsupported_version: MotirAiBadRequestError,
  service_unauthorized: MotirAiUnauthorizedError,
  token_expired: MotirAiUnauthorizedError,
  token_invalid: MotirAiUnauthorizedError,
  permission_denied: MotirAiUnauthorizedError,
  not_found: MotirAiJobNotFoundError,
  conflict: MotirAiBadRequestError, // 409 < 500 → bad-request fallback
  rate_limited: MotirAiUnavailableError,
  out_of_credits: MotirAiOutOfCreditsError, // 402 → its own typed error (the 8.1.8 paywall)
  ai_job_failed: MotirAiUnavailableError,
  model_unreachable: MotirAiBadRequestError, // 422 — a different model or a gateway fix, never a retry
  ai_job_abandoned: MotirAiUnavailableError, // 500 — same class as ai_job_failed; the DISCRIMINATION is the code, not the type
  internal_error: MotirAiUnavailableError,
  codegraph_unavailable: MotirAiUnavailableError, // 503 — the code-graph forward retries it
};

function problemFor(code: string, status = 400): Problem {
  return { type: `https://motir.co/errors/${code}`, title: code, status, code };
}

describe('contract: error taxonomy (§5)', () => {
  it('maps EVERY canonical code to its motir-core typed error', () => {
    for (const code of CANONICAL_ERROR_CODES) {
      const status =
        code === 'conflict'
          ? 409
          : code === 'not_found'
            ? 404
            : code === 'out_of_credits'
              ? 402
              : code === 'codegraph_unavailable'
                ? 503
                : 400;
      const err = errorFromProblem(problemFor(code, status));
      expect(err, `code ${code}`).toBeInstanceOf(EXPECTED_MAPPING[code]!);
    }
  });

  it('the EXPECTED_MAPPING covers exactly the canonical code set', () => {
    expect(Object.keys(EXPECTED_MAPPING).sort()).toEqual([...CANONICAL_ERROR_CODES].sort());
  });
});

describe('contract: jobKind enum (§2.3)', () => {
  it('motir-core JOB_KINDS is EXACTLY the canonical set', () => {
    expect([...JOB_KINDS].sort()).toEqual([...CANONICAL_JOB_KINDS].sort());
  });

  // ⚠️ EQUALITY ALONE CANNOT SAY THIS (MOTIR-4310). The case above passes if BOTH
  // lists carry a retired kind — they would still be equal, and the mirror would
  // still name values motir-ai refuses. This is the half that says what they must
  // NOT contain.
  it('neither list carries a RETIRED planning kind — the five are gone from both', () => {
    for (const kind of ['generate_tree', 'expand_item', 'augment', 'replan', 'revise_plan']) {
      expect([...JOB_KINDS], `JOB_KINDS still carries ${kind}`).not.toContain(kind);
      expect([...CANONICAL_JOB_KINDS], `CANONICAL_JOB_KINDS still carries ${kind}`).not.toContain(
        kind,
      );
    }
    // …and the one that replaced them is in both, so "not containing" cannot be
    // achieved by emptying the planning half altogether.
    expect([...JOB_KINDS]).toContain('plan');
    expect([...CANONICAL_JOB_KINDS]).toContain('plan');
  });

  it('ENVELOPE_VERSION matches the canonical version', () => {
    expect(ENVELOPE_VERSION).toBe('v1');
  });
});

describe('contract: request envelope (§3.1)', () => {
  // The IDENTICAL fixture motir-ai parses in its contract test.
  const CANONICAL_REQUEST = {
    envelopeVersion: 'v1',
    jobKind: 'noop',
    tenant: {
      organizationId: 'org_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
      projectKey: 'MOTIR',
    },
    context: { prompt: 'ping', rootItemKey: null, discovery: null, code: null },
    readBackToken: 'eyJ...token',
  };

  it('the canonical request uses a known kind + version core also speaks', () => {
    expect(ENVELOPE_VERSION).toBe(CANONICAL_REQUEST.envelopeVersion);
    expect((JOB_KINDS as readonly string[]).includes(CANONICAL_REQUEST.jobKind)).toBe(true);
  });
});

describe('contract: drift simulation (the guard must bite)', () => {
  it('an unknown error code does NOT silently pass as a known mapping', () => {
    // A drifted code falls to the status-based fallback, never one of the
    // specific known-code classes by accident.
    const err = errorFromProblem(problemFor('totally_made_up_code', 418));
    expect(err).toBeInstanceOf(MotirAiBadRequestError); // 4xx fallback, not a known mapping
    expect(CANONICAL_ERROR_CODES).not.toContain('totally_made_up_code');
  });

  it('a drifted jobKind is not in the canonical set', () => {
    expect((JOB_KINDS as readonly string[]).includes('mine_bitcoin')).toBe(false);
  });
});
