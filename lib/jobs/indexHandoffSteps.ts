import {
  handOffCodeGraphIndex,
  readCodeGraphIndexStatus,
  type CodeGraphIndexStatus,
} from '@/lib/ai/motirAiClient';
import {
  AI_PLAN_INDEX_PAUSE_REASON,
  INDEX_SIZE_REFUSED_PAUSE_REASON,
} from '@/lib/ciFleet/indexAllowance';
import { getGitProvider, requireRepoTarballUrlResolver } from '@/lib/git';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import {
  requireCurrentIndexTarget,
  type IndexRepoInput,
  type IndexRepoResult,
  type IndexTarget,
} from '@/lib/services/codeGraphIndexService';
import { deferRun } from './engine/defer';
import type { JobContext } from './defineJob';
import {
  claimIndexingRepo,
  liftIndexingPause,
  pauseIndexingRepo,
  settleIndexingRepo,
  type IndexFleetJobId,
} from './indexFleetSteps';
import type { JobServices } from './services';

// THE INDEX HANDOFF — `system.code-graph-index` and `system.code-graph-refresh`
// since MOTIR-11883 (story MOTIR-11022).
//
// motir-core no longer boots an indexer container. Both jobs hand motir-ai the
// repository at its live default-branch head, with a pre-signed source URL minted
// AT that commit, and motir-ai — motir-codegraph's only client — starts the
// service's job. The run then polls motir-ai's status route until the service
// published, refused or failed that commit.
//
//   step  resolve-target-v2     DB reads only, unchanged from the fleet path
//     ↓   (the three no-op verdicts and `provider_cannot_index` return here)
//   step  index-allowance       the internal index allowance, memoized
//   step  index-ai-plan         the paid-AI-plan gate, memoized (an `unknown`
//                               answer defers from INSIDE the step, so it is
//                               never recorded and the next pass asks again)
//         claim the repository row (best effort, as before)
//   step  index-handoff-v1      read the live head, mint the URL at it, hand off:
//                               ONE memo, holding only `{ jobId, commitSha, handedAt }`
//         ONE status read per pass, then settle or defer
//   step  cancel-offboarding    on the published arm only
//
// ⚠️ ONLY THE SIDE EFFECT IS CHECKPOINTED, NEVER THE WAIT
// (`docs/decisions/job-queue-foundation.md` §13). A deferral re-runs the handler
// from the top and only memoized calls are skipped, so the handoff MUST be a step —
// that is what stops a deferred pass handing the same commit off again — and the
// status read must NOT be one, or the first `still running` answer would be frozen
// forever. Each pass therefore costs a few memo reads and ONE status read: N passes
// are N reads.
//
// ⚠️ THE HEAD IS READ INSIDE THE HANDOFF STEP. The commit the URL is minted at and
// the commit the run waits for are one value, read once; a later pass reads it back
// from the memo and never asks the host again.
//
// ⚠️ THE SOURCE URL IS A BEARER SECRET TO THE CUSTOMER'S CODE. It is computed
// inside the handoff step and dropped before the step returns, so it never enters a
// `job_step` memo, the `job_run` output, a log line or an error message.
//
// ⚠️ THE LEDGER CONTRACT DOES NOT MOVE (`docs/decisions/code-graph-index-fleet.md`
// §6). A published commit is ONE `succeeded` row with ONE `output.repoRef`, now
// beside `output.indexedBy: 'motir-codegraph'`, which tells a handoff-written row
// from an old-fleet one. A refusal or a pause succeeds with no `repoRef`; a failure
// THROWS, so `defineJob` writes no succeeded row for a repository nothing indexed.

/** Between two status reads. A chosen default, not a measurement. */
export const INDEX_HANDOFF_POLL_INTERVAL_MS = 5_000;

/** How long a handed commit may take to settle, from the handoff. The old container's
 *  own budget; the service's targets are 60 s for a small push and 10 min for a
 *  motir-core-sized first index. */
export const INDEX_HANDOFF_DEADLINE_MS = 30 * 60_000;

/** The pause before re-handing while another call holds the registration claim. */
export const INDEX_HANDOFF_REGISTRATION_RETRY_MS = 3_000;

/** The pause before re-asking a plan gate that could not answer. */
export const INDEX_HANDOFF_PLAN_UNKNOWN_RETRY_MS = 30_000;

/** The service's reason for a repository too large to index. */
export const CODEGRAPH_SIZE_REFUSAL_REASON = 'repository_too_large';

/**
 * A handed-off index that did not publish: the service failed the handed commit, or
 * nothing settled within {@link INDEX_HANDOFF_DEADLINE_MS}.
 *
 * ⚠️ IT THROWS RATHER THAN RETURNING A DIMINISHED RESULT, for the ledger contract:
 * `defineJob` writes `output` only on success, so the throw is what keeps a
 * `succeeded` row claiming the repository indexed out of the ledger.
 */
export class IndexHandoffFailedError extends Error {
  readonly code = 'INDEX_HANDOFF_FAILED' as const;
  constructor(
    readonly repoRef: string,
    readonly commitSha: string,
    /** The service's failure reason, or `timed_out`. */
    readonly reason: string,
    detail: string,
  ) {
    super(`Indexing ${repoRef} at ${commitSha} failed (${reason}): ${detail}`);
    this.name = 'IndexHandoffFailedError';
  }
}

/** What the handoff step records: no URL, ever. */
export interface IndexHandoffMemo {
  jobId: string;
  commitSha: string;
  /** ISO instant of the handoff; the deadline is measured from it. */
  handedAt: string;
}

const handoffKindFor = (jobId: IndexFleetJobId) =>
  jobId === 'system.code-graph-index' ? ('first_index' as const) : ('refresh' as const);

/**
 * Drive ONE repository's index through motir-ai's handoff. Returns the ledger's
 * {@link IndexRepoResult}, or throws {@link IndexHandoffFailedError}.
 */
export async function runIndexHandoffSteps(
  ctx: JobContext,
  services: JobServices,
  input: IndexRepoInput,
  /** The job driving this run: it picks the handoff kind, and the indexing claim
   *  resolves its ledger row by it (MOTIR-9454). */
  jobId: IndexFleetJobId,
): Promise<IndexRepoResult> {
  // Unchanged from the fleet path, id and all: DB reads only, narrowed rather than
  // cast (MOTIR-5020).
  const target = requireCurrentIndexTarget(
    await ctx.step.run('resolve-target-v2', () => services.codeGraph.resolveIndexTarget(input)),
  );
  if (!target.indexed) return target;

  // ⚠️ BOTH GATES BEFORE ANYTHING IS CLAIMED OR SENT. A stop is a recorded pause and
  // a succeeded no-op with no `repoRef`, which the catch-up sweep re-asks.
  const allowance = await ctx.step.run('index-allowance', () =>
    services.codeGraphIndexDispatch.askIndexAllowance(target.organizationId),
  );
  if (!allowance.proceed) {
    await pauseIndexingRepo(target.repoRef, target.organizationId, allowance.reason);
    return { indexed: false, reason: allowance.reason };
  }
  // There is no admission step to answer `ai_plan_required` any more, so the plan is
  // asked directly. An `unknown` answer defers INSIDE the step: a thrown step is not
  // recorded, so the next pass asks again rather than replaying "unknown" forever.
  const plan = await ctx.step.run('index-ai-plan', async () => {
    const paid = await aiPlanGateService.hasPaidAiPlan(target.organizationId);
    if (paid === 'unknown') {
      deferRun(
        new Date(Date.now() + INDEX_HANDOFF_PLAN_UNKNOWN_RETRY_MS),
        'index handoff: the AI plan could not be read',
      );
    }
    return { paid: paid === true };
  });
  if (!plan.paid) {
    await pauseIndexingRepo(target.repoRef, target.organizationId, AI_PLAN_INDEX_PAUSE_REASON);
    return { indexed: false, reason: AI_PLAN_INDEX_PAUSE_REASON };
  }
  await liftIndexingPause(target.repoRef);

  // The ledger-row claim (MOTIR-9454), best effort and idempotent per pass. Its
  // stored-head answer is not used: the head the run waits for is read live below.
  await claimIndexingRepo(ctx, target.repoRef, target.organizationId, {
    functionId: jobId,
    eventId: ctx.event.id ?? ctx.runId,
  });

  const handed = await ctx.step.run('index-handoff-v1', () =>
    handOff(input, target, handoffKindFor(jobId)),
  );

  const status = await readCodeGraphIndexStatus({
    coreOrganizationId: target.organizationId,
    repoRef: target.repoRef,
  });
  const settled = settledOutcome(status, handed.commitSha);

  if (settled.kind === 'published') {
    await settleIndexingRepo(target.repoRef, target.organizationId, handed.commitSha);
    await ctx.step.run('cancel-offboarding', async () => ({
      cancelled: await codeGraphOffboardingService.cancelQuietly({
        coreWorkspaceId: input.workspaceId,
        coreProjectIds: [target.anchorProjectId],
        repoRefs: [target.repoRef],
      }),
    }));
    return {
      indexed: true,
      repoRef: target.repoRef,
      projectsIndexed: 1,
      indexedBy: 'motir-codegraph',
    };
  }
  if (settled.kind === 'refused_for_size') {
    await pauseIndexingRepo(target.repoRef, target.organizationId, INDEX_SIZE_REFUSED_PAUSE_REASON);
    return { indexed: false, reason: INDEX_SIZE_REFUSED_PAUSE_REASON, detail: settled.message };
  }
  if (settled.kind === 'failed') {
    throw new IndexHandoffFailedError(
      target.repoRef,
      handed.commitSha,
      settled.reason,
      settled.message,
    );
  }

  const deadline = Date.parse(handed.handedAt) + INDEX_HANDOFF_DEADLINE_MS;
  if (Date.now() >= deadline) {
    throw new IndexHandoffFailedError(
      target.repoRef,
      handed.commitSha,
      'timed_out',
      `motir-codegraph did not publish the handed commit within ${String(INDEX_HANDOFF_DEADLINE_MS / 60_000)} minutes of the handoff`,
    );
  }
  return deferRun(
    new Date(Date.now() + INDEX_HANDOFF_POLL_INTERVAL_MS),
    'index handoff: waiting for motir-codegraph',
  );
}

/**
 * The handoff step's body: read the live head, mint the source URL AT it, hand off.
 *
 * ⚠️ THE URL LIVES ONLY IN THIS FUNCTION'S SCOPE, and the step records what it
 * returns — so it returns no URL. A `429 rate_limited` answer defers from inside the
 * step, unrecorded, so the next pass mints a fresh URL and hands off again.
 */
async function handOff(
  input: IndexRepoInput,
  target: Extract<IndexTarget, { indexed: true }>,
  kind: 'first_index' | 'refresh',
): Promise<IndexHandoffMemo> {
  const provider = getGitProvider(target.providerId);
  const head = await provider.resolveRef(
    input.installationId,
    input.repoOwner,
    input.repoName,
    input.defaultBranch,
  );
  if (head.outcome !== 'resolved') {
    // A thrown step is not recorded, so the idempotent retry policy asks again.
    throw new Error(
      `index handoff: could not read the head of ${target.repoRef}@${input.defaultBranch} (${head.outcome})`,
    );
  }
  const sourceUrl = await requireRepoTarballUrlResolver(provider)(
    input.installationId,
    input.repoOwner,
    input.repoName,
    head.sha,
  );
  const answer = await handOffCodeGraphIndex({
    coreOrganizationId: target.organizationId,
    coreWorkspaceId: input.workspaceId,
    coreProjectId: target.anchorProjectId,
    repoRef: target.repoRef,
    kind,
    commitSha: head.sha,
    ref: input.defaultBranch,
    sourceUrl,
  });
  if (answer.outcome === 'registration_in_progress') {
    deferRun(
      new Date(Date.now() + INDEX_HANDOFF_REGISTRATION_RETRY_MS),
      'index handoff: the repository is being registered by another request',
    );
  }
  return { jobId: answer.jobId, commitSha: head.sha, handedAt: new Date().toISOString() };
}

type SettledOutcome =
  | { kind: 'published' }
  | { kind: 'refused_for_size'; message: string }
  | { kind: 'failed'; reason: string; message: string }
  | { kind: 'pending' };

/**
 * What the service's status says about THE HANDED COMMIT. Published when it is the
 * indexed commit; still pending while a job for it is queued or running; refused or
 * failed when it is the last failure's commit. A failure of an OLDER commit is
 * history, not this run's outcome.
 */
export function settledOutcome(status: CodeGraphIndexStatus, handedCommit: string): SettledOutcome {
  if (status.indexedCommit?.commit === handedCommit) return { kind: 'published' };
  if (status.inProgressJob?.commit === handedCommit) return { kind: 'pending' };
  const failure = status.lastFailure;
  if (failure?.commit === handedCommit) {
    return failure.reason === CODEGRAPH_SIZE_REFUSAL_REASON
      ? { kind: 'refused_for_size', message: failure.message }
      : { kind: 'failed', reason: failure.reason, message: failure.message };
  }
  return { kind: 'pending' };
}
