import { MotirAiUnavailableError } from '@/lib/ai/errors';
import {
  forwardPullRequestState,
  forwardRetire,
  type CodeGraphForwardAnswer,
} from '@/lib/ai/motirAiClient';
import { defineJob } from '../defineJob';
import { deferRun } from '../engine/defer';
import type { CodeGraphForwardData } from '../types';

// The code-graph FORWARD job (MOTIR-12055 · story MOTIR-11870) —
// `system.code-graph-forward`.
//
// ONE thing GitHub reported about a connected repository's branch — a pull request
// opened, reopened or closed, or the branch deleted — relayed to motir-ai, which
// turns it into motir-codegraph's pull-request-state or retire call through its
// mapping. The run keeps sending it until motir-ai gives a SETTLED answer.
//
//   step  forward-started-v1   { startedAt } — the only thing a run remembers
//     ↓
//   ONE call, NOT memoized, picked by `kind`:
//     settled  (recorded · stale · unknown_ref · default_branch · retired ·
//               already_done)                   → succeeded, no retry
//     refused  (any 4xx but 401 and 429)         → succeeded, a warning, no retry
//     unavailable (transport, deadline, 5xx, 429, 503 codegraph_unavailable)
//                                               → `deferRun`, the wait growing with
//                                                 the time since `startedAt`, capped
//                                                 at 30 min; past 24 h a recorded
//                                                 failure instead
//     anything else (401, a config error)        → thrown into the `idempotent`
//                                                 budget: a FAILED run
//
// ⚠️ THE CALL STAYS OUTSIDE A STEP, as in `indexHandoffSteps.ts`. A memo freezes its
// FIRST answer for the life of the run, so a memoized call would replay its first
// `unavailable` forever. Re-sending is safe: the service answers a repeat `stale` /
// `already_done`, and it keeps the NEWEST `reportedAt` per pull request, so retries
// landing in any order leave whatever GitHub said last.
//
// ⚠️ A DEFER IS NOT A RETRY. `deferRun` returns the row to `pending` with the attempt
// REFUNDED (`engine/defer.ts`), so an outage of any length up to the deadline costs
// none of the five-attempt budget, which is left for the failures that are real.
//
// SYSTEM-scoped: a forward belongs to an organisation and a repository, not to one
// workspace (`CodeGraphForwardData`), so it is enqueued with `sendSystemEvent`
// (`lib/jobs/codeGraphForward.ts`).

/** How long a run keeps re-sending through an outage before it fails, from its start. */
export const CODE_GRAPH_FORWARD_DEADLINE_MS = 24 * 60 * 60_000;

/** The shortest and the longest wait between two sends. */
export const CODE_GRAPH_FORWARD_MIN_WAIT_MS = 30_000;
export const CODE_GRAPH_FORWARD_MAX_WAIT_MS = 30 * 60_000;

/** The run re-sent through an outage for the whole deadline and never got an answer. */
export class CodeGraphForwardTimedOutError extends Error {
  readonly code = 'CODE_GRAPH_FORWARD_TIMED_OUT' as const;
  constructor(
    readonly kind: CodeGraphForwardData['kind'],
    readonly repoRef: string,
    readonly ref: string,
    detail: string,
  ) {
    super(
      `Forwarding ${kind} for ${repoRef} ${ref} to motir-ai did not settle within ${String(CODE_GRAPH_FORWARD_DEADLINE_MS / 3_600_000)} hours: ${detail}`,
    );
    this.name = 'CodeGraphForwardTimedOutError';
  }
}

/**
 * The wait before the next send: the time since the run started, clamped to
 * [30 s, 30 min]. Each wait is about the time already spent, so the waits roughly
 * double, and they stop growing at the cap.
 */
export function codeGraphForwardWaitMs(elapsedMs: number): number {
  return Math.min(
    CODE_GRAPH_FORWARD_MAX_WAIT_MS,
    Math.max(CODE_GRAPH_FORWARD_MIN_WAIT_MS, elapsedMs),
  );
}

/** What a finished run records: the kind and the answer, never more. */
export type CodeGraphForwardResult =
  | { kind: CodeGraphForwardData['kind']; outcome: string }
  | { kind: CodeGraphForwardData['kind']; outcome: 'refused'; status: number; code: string };

/** The ONE call a pass makes, by kind. The body is built from named fields only. */
function send(data: CodeGraphForwardData): Promise<CodeGraphForwardAnswer<string>> {
  if (data.kind === 'retire') {
    return forwardRetire({
      coreOrganizationId: data.coreOrganizationId,
      repoRef: data.repoRef,
      ref: data.ref,
    });
  }
  return forwardPullRequestState({
    coreOrganizationId: data.coreOrganizationId,
    repoRef: data.repoRef,
    ref: data.ref,
    pullRequestNumber: data.pullRequestNumber,
    state: data.state,
    ...(data.mergedAt !== undefined ? { mergedAt: data.mergedAt } : {}),
    reportedAt: data.reportedAt,
  });
}

export const codeGraphForward = defineJob(
  {
    id: 'system.code-graph-forward',
    retryPolicy: 'idempotent',
  },
  async (ctx): Promise<CodeGraphForwardResult> => {
    const data = ctx.event.data as CodeGraphForwardData;
    const { startedAt } = await ctx.step.run('forward-started-v1', async () => ({
      startedAt: new Date().toISOString(),
    }));

    let answer: CodeGraphForwardAnswer<string>;
    try {
      answer = await send(data);
    } catch (err) {
      if (!(err instanceof MotirAiUnavailableError)) throw err;
      const elapsedMs = Date.now() - Date.parse(startedAt);
      if (elapsedMs >= CODE_GRAPH_FORWARD_DEADLINE_MS) {
        throw new CodeGraphForwardTimedOutError(data.kind, data.repoRef, data.ref, err.message);
      }
      return deferRun(
        new Date(Date.now() + codeGraphForwardWaitMs(elapsedMs)),
        'code-graph forward: motir-ai or motir-codegraph unavailable',
      );
    }

    if (answer.kind === 'refused') {
      console.warn(
        `[code-graph-forward] motir-ai refused ${data.kind} for ${data.repoRef} ${data.ref}: ${String(answer.status)} ${answer.code}`,
      );
      return { kind: data.kind, outcome: 'refused', status: answer.status, code: answer.code };
    }
    return { kind: data.kind, outcome: answer.outcome };
  },
);
