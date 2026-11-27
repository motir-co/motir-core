import { MotirAiUnavailableError } from '@/lib/ai/errors';
import {
  forwardPullRequestState,
  forwardRetire,
  type CodeGraphForwardAnswer,
} from '@/lib/ai/motirAiClient';
import { PullRequestReadError } from '@/lib/github/pullRequestRead';
import { codeGraphForwardLiveStateService } from '@/lib/services/codeGraphForwardLiveStateService';
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
//   on a RE-SEND of a `state: open` report only, the pull request read LIVE
//   (MOTIR-12321), NOT memoized:
//     still open                                 → sent as it is
//     closed or merged since                     → THAT is sent instead, with the
//                                                 host's `updated_at` (and `merged_at`)
//     gone (404 / 410) · repository disconnected → succeeded, nothing sent
//     unreadable (`PullRequestReadError`)        → deferred like an outage, below
//     ↓
//   ONE call, NOT memoized, picked by `kind`:
//     settled  (recorded · stale · unknown_ref · default_branch · retired ·
//               already_done)                   → succeeded, no retry — EXCEPT:
//     unknown_ref on a `state: open` report     → `deferRun` on the same waits and
//                                                 the same 24 h deadline; past it,
//                                                 succeeded with `unknown_ref`
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
// ⚠️ AN OPEN REPORT WAITS FOR ITS BRANCH (MOTIR-12299). A pull request's `opened` /
// `reopened` starts its head's index (`system.code-graph-pr-head-index`) AND enqueues
// this forward in the same delivery, and the forward lands seconds before the head
// publishes. motir-codegraph records a pull request's state only on a branch it holds
// (`upsertPullRequestState` answers `unknown_ref` and writes nothing otherwise), and
// `synchronize` forwards no state, so an `unknown_ref` settled on the first answer
// lost the open state for good: production held no open row at all. So an open
// report that answers `unknown_ref` is NOT settled — it is re-sent on the outage
// waits until the head has published and it answers `recorded` (or `stale`), and a
// branch that never publishes (refused, oversized, paused) settles `unknown_ref` at
// the deadline, with a warning. A closed or merged report stays settled on
// `unknown_ref`: its branch is retired or was never held, and there is nothing to
// protect.
//
// ⚠️ A HELD OPEN REPORT ASKS THE HOST AGAIN BEFORE EVERY RE-SEND (MOTIR-12321). The
// wait above can outlive the pull request. Closed or merged before its head
// publishes, the close report answers `unknown_ref` and settles on that first answer
// (writing nothing), and when the head then publishes the still-waiting open report
// would be RECORDED — an open row for a closed pull request, its branch never retired
// on report. So every pass after the first reads the pull request live
// (`codeGraphForwardLiveStateService`, the read `codeGraphPrHeadIndex.ts` step
// `pr-head-v1` makes) and sends what the host says NOW: an ended pull request is
// reported closed or merged, which the service records and retires on once the head
// is held. The FIRST pass sends without the read: the report left its delivery
// seconds ago, and every re-send pays for the read instead. The read is outside any
// step for the reason the call is: a memo would freeze the first answer.
//
// ⚠️ A DEFER IS NOT A RETRY. `deferRun` returns the row to `pending` with the attempt
// REFUNDED (`engine/defer.ts`), so an outage of any length up to the deadline costs
// none of the five-attempt budget, which is left for the failures that are real.
//
// SYSTEM-scoped: a forward belongs to an organisation and a repository, not to one
// workspace (`CodeGraphForwardData`), so it is enqueued with `sendSystemEvent`
// (`lib/jobs/codeGraphForward.ts`).

/**
 * How long a run keeps re-sending, from its start: through an outage before it fails,
 * and for an open report's branch to be indexed before it settles `unknown_ref`.
 */
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

/**
 * What a finished run records: the kind and the answer, never more — plus, when a
 * held open report found its pull request ended and reported THAT, the state it sent.
 */
export type CodeGraphForwardResult =
  | { kind: CodeGraphForwardData['kind']; outcome: string; reportedAs?: 'closed' | 'merged' }
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
    const event = ctx.event.data as CodeGraphForwardData;
    // The step body runs on the FIRST pass only; every later pass replays its memo.
    let firstPass = false;
    const { startedAt } = await ctx.step.run('forward-started-v1', async () => {
      firstPass = true;
      return { startedAt: new Date().toISOString() };
    });

    let data = event;
    let reportedAs: 'closed' | 'merged' | undefined;
    let answer: CodeGraphForwardAnswer<string>;
    try {
      if (!firstPass && event.kind === 'pull_request_state' && event.state === 'open') {
        const live = await codeGraphForwardLiveStateService.read(event);
        if (live.kind === 'gone' || live.kind === 'not_connected') {
          return { kind: event.kind, outcome: live.kind };
        }
        if (live.kind === 'ended') {
          reportedAs = live.state;
          data = {
            kind: 'pull_request_state',
            coreOrganizationId: event.coreOrganizationId,
            repoRef: event.repoRef,
            ref: event.ref,
            pullRequestNumber: event.pullRequestNumber,
            state: live.state,
            ...(live.mergedAt !== undefined ? { mergedAt: live.mergedAt } : {}),
            reportedAt: live.reportedAt,
          };
        }
      }
      answer = await send(data);
    } catch (err) {
      if (!(err instanceof MotirAiUnavailableError) && !(err instanceof PullRequestReadError)) {
        throw err;
      }
      const elapsedMs = Date.now() - Date.parse(startedAt);
      if (elapsedMs >= CODE_GRAPH_FORWARD_DEADLINE_MS) {
        throw new CodeGraphForwardTimedOutError(data.kind, data.repoRef, data.ref, err.message);
      }
      return deferRun(
        new Date(Date.now() + codeGraphForwardWaitMs(elapsedMs)),
        err instanceof PullRequestReadError
          ? 'code-graph forward: the pull request could not be read from the host'
          : 'code-graph forward: motir-ai or motir-codegraph unavailable',
      );
    }
    const ended = reportedAs !== undefined ? { reportedAs } : {};

    if (
      answer.kind === 'settled' &&
      answer.outcome === 'unknown_ref' &&
      data.kind === 'pull_request_state' &&
      data.state === 'open'
    ) {
      const elapsedMs = Date.now() - Date.parse(startedAt);
      if (elapsedMs < CODE_GRAPH_FORWARD_DEADLINE_MS) {
        return deferRun(
          new Date(Date.now() + codeGraphForwardWaitMs(elapsedMs)),
          "code-graph forward: the open pull request's branch is not indexed yet",
        );
      }
      console.warn(
        `[code-graph-forward] ${data.repoRef} ${data.ref} was never indexed within ${String(CODE_GRAPH_FORWARD_DEADLINE_MS / 3_600_000)} hours; pull request #${String(data.pullRequestNumber)} stays unrecorded as open`,
      );
      return { kind: data.kind, outcome: answer.outcome };
    }

    if (answer.kind === 'refused') {
      console.warn(
        `[code-graph-forward] motir-ai refused ${data.kind} for ${data.repoRef} ${data.ref}: ${String(answer.status)} ${answer.code}`,
      );
      return { kind: data.kind, outcome: 'refused', status: answer.status, code: answer.code };
    }
    return { kind: data.kind, outcome: answer.outcome, ...ended };
  },
);
