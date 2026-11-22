import {
  handOffCodeGraphIndex,
  readCodeGraphIndexStatus,
  type CodeGraphIndexStatus,
} from '@/lib/ai/motirAiClient';
import {
  AI_PLAN_INDEX_PAUSE_REASON,
  INDEX_SIZE_REFUSED_PAUSE_REASON,
} from '@/lib/ciFleet/indexAllowance';
import { getGitProvider, requireRepoTarballUrlResolver, type ChangedFilesResult } from '@/lib/git';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { CODE_GRAPH_HANDOFF_INDEXED_BY } from '@/lib/repositories/jobRunRepository';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import {
  requireCurrentIndexTarget,
  type IndexRepoInput,
  type IndexRepoResult,
  type IndexTarget,
} from '@/lib/services/codeGraphIndexService';
import { withSystemContext } from '@/lib/workspaces/context';
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
//   step  index-head-v1         read the live default-branch head, once per run
//   step  index-push-diff-v1    a PUSH-caused refresh only (MOTIR-11884): the stamped
//                               head, the host's changed paths between it and the
//                               head, and the push-or-refresh decision over them
//   step  index-handoff-v1      mint the URL at the head and hand off: ONE memo,
//                               holding only `{ jobId, commitSha, handedAt }`
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
// ⚠️ THE HEAD IS ITS OWN STEP, AHEAD OF THE HANDOFF (MOTIR-11884). The commit the
// URL is minted at, the commit a push is compared against and the commit the run
// waits for are ONE value, read once; every later pass — and a handoff re-tried
// after a `429` — reads it back from the memo and never asks the host again. The
// comparison sits between the two because it needs the head and must be memoized
// apart from the handoff: a handoff deferred by the registration retry re-runs, and
// the comparison must not be asked twice for the same pair.
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

/** What caused a refresh, from its payload: only the push webhooks say `push`. */
export interface IndexHandoffOptions {
  refreshCause?: 'push' | undefined;
}

/** The kind-specific fields of one handoff body. */
export type HandoffKindFields =
  | { kind: 'first_index' | 'refresh' }
  | { kind: 'push'; previousCommitSha: string; changedPaths: string[] };

/** Why a push-caused run was handed off as a refresh instead. */
export type PushFallbackReason =
  | 'no_stamped_head'
  | 'head_unchanged'
  | 'sha_not_hex'
  | 'no_such_ref'
  | 'not_connected'
  | 'revoked'
  | 'too_large'
  | 'host_error'
  | 'truncated'
  | 'comparison_threw';

/** The comparison step's memo: the push fields, or the refresh and why. */
export type PushComparison =
  | { kind: 'push'; previousCommitSha: string; changedPaths: string[] }
  | { kind: 'refresh'; fallback: PushFallbackReason };

/** motir-codegraph accepts a commit only as 40 lowercase hex. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * THE PUSH-OR-REFRESH RULE (MOTIR-11884), pure, so it is tested as a table.
 *
 * A push is handed off as `kind: push` only when motir-core can vouch for the
 * comparison: a stamped head that differs from the head, both full SHAs, and an
 * `ok`, untruncated listing between them. Anything else is a `refresh`, which the
 * service treats as a whole-tree index — the safe answer when the comparison is
 * unknown. The changed paths are every file's path plus each rename's previous path,
 * de-duplicated, so a moved file's old path is named too; an empty list is a valid
 * push ("changed nothing" is a real answer).
 */
export function pushComparisonFor(
  stampedHead: string | null,
  head: string,
  listing: ChangedFilesResult | { threw: true } | null,
): PushComparison {
  if (!stampedHead) return { kind: 'refresh', fallback: 'no_stamped_head' };
  if (stampedHead === head) return { kind: 'refresh', fallback: 'head_unchanged' };
  if (!FULL_SHA.test(stampedHead) || !FULL_SHA.test(head)) {
    return { kind: 'refresh', fallback: 'sha_not_hex' };
  }
  if (!listing || 'threw' in listing) return { kind: 'refresh', fallback: 'comparison_threw' };
  if (listing.outcome !== 'ok') return { kind: 'refresh', fallback: listing.outcome };
  if (listing.truncated) return { kind: 'refresh', fallback: 'truncated' };
  const paths = new Set<string>();
  for (const file of listing.files) {
    paths.add(file.path);
    if (file.previousPath) paths.add(file.previousPath);
  }
  return { kind: 'push', previousCommitSha: stampedHead, changedPaths: [...paths] };
}

/** The comparison is asked only when the pair can be compared at all. */
const comparable = (stampedHead: string | null, head: string): stampedHead is string =>
  stampedHead !== null && stampedHead !== head && FULL_SHA.test(stampedHead) && FULL_SHA.test(head);

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
  options: IndexHandoffOptions = {},
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

  const head = await ctx.step.run('index-head-v1', () => readHead(input, target));

  let kindFields: HandoffKindFields = {
    kind: jobId === 'system.code-graph-index' ? 'first_index' : 'refresh',
  };
  if (jobId === 'system.code-graph-refresh' && options.refreshCause === 'push') {
    const comparison = await ctx.step.run('index-push-diff-v1', () =>
      comparePush(input, target, head.commitSha),
    );
    kindFields = comparison.kind === 'push' ? comparison : { kind: 'refresh' };
  }

  const handed = await ctx.step.run('index-handoff-v1', () =>
    handOff(input, target, kindFields, head.commitSha),
  );

  const status = await readCodeGraphIndexStatus({
    coreOrganizationId: target.organizationId,
    repoRef: target.repoRef,
  });
  const settled = settledOutcome(status, handed);

  if (settled.kind === 'published' || settled.kind === 'superseded') {
    // ⚠️ THE STAMP IS WHAT WAS PUBLISHED. A superseded handoff's own commit never
    // was, so stamping it would make the next push compare against a graph that does
    // not exist; the newer published head is the graph that does.
    const publishedCommit =
      settled.kind === 'superseded' ? settled.publishedCommit : handed.commitSha;
    await settleIndexingRepo(target.repoRef, target.organizationId, publishedCommit);
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
      indexedBy: CODE_GRAPH_HANDOFF_INDEXED_BY,
      ...(settled.kind === 'superseded' ? { supersededBy: settled.publishedCommit } : {}),
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

/** The head step's body: the live default-branch head. A failure throws, unrecorded,
 *  so the idempotent retry policy asks again. */
async function readHead(
  input: IndexRepoInput,
  target: Extract<IndexTarget, { indexed: true }>,
): Promise<{ commitSha: string }> {
  const head = await getGitProvider(target.providerId).resolveRef(
    input.installationId,
    input.repoOwner,
    input.repoName,
    input.defaultBranch,
  );
  if (head.outcome !== 'resolved') {
    throw new Error(
      `index handoff: could not read the head of ${target.repoRef}@${input.defaultBranch} (${head.outcome})`,
    );
  }
  return { commitSha: head.sha };
}

/**
 * The comparison step's body (MOTIR-11884): the head motir-core last STAMPED for
 * the repository, the host's changed paths between it and the head, and the
 * push-or-refresh decision over them.
 *
 * ⚠️ IT NEVER THROWS. A listing that throws despite its contract, or a row read that
 * fails, is a refresh — a whole-tree index is always a correct answer — and the step
 * records it, so a retry does not ask the host again for the same pair. Comparing
 * the STAMPED head with the CURRENT one covers every push since the last published
 * index, however many runs are queued, so no accumulator of push payloads is needed.
 *
 * The comparison uses the installation credential this process holds; nothing
 * credential-shaped is handed to motir-ai. The fallback is logged once, with the
 * repository and the reason only.
 */
async function comparePush(
  input: IndexRepoInput,
  target: Extract<IndexTarget, { indexed: true }>,
  head: string,
): Promise<PushComparison> {
  let stampedHead: string | null = null;
  let listing: ChangedFilesResult | { threw: true } | null = null;
  try {
    const row = await withSystemContext((tx) =>
      githubRepoRepository.findConnectedByOrganizationAndName(
        target.organizationId,
        input.repoOwner,
        input.repoName,
        tx,
      ),
    );
    stampedHead = row?.indexedHeadSha ?? null;
    if (comparable(stampedHead, head)) {
      listing = await getGitProvider(target.providerId).listChangedFiles(
        input.installationId,
        input.repoOwner,
        input.repoName,
        stampedHead,
        head,
      );
    }
  } catch {
    listing = { threw: true };
  }
  const comparison = pushComparisonFor(stampedHead, head, listing);
  if (comparison.kind === 'refresh') {
    console.warn(
      `[index-handoff] ${target.repoRef}: push handed off as a refresh (${comparison.fallback})`,
    );
  }
  return comparison;
}

/**
 * The handoff step's body: mint the source URL AT the head and hand off.
 *
 * ⚠️ THE URL LIVES ONLY IN THIS FUNCTION'S SCOPE, and the step records what it
 * returns — so it returns no URL. A `429 rate_limited` answer defers from inside the
 * step, unrecorded, so the next pass mints a fresh URL and hands off again.
 */
async function handOff(
  input: IndexRepoInput,
  target: Extract<IndexTarget, { indexed: true }>,
  kindFields: HandoffKindFields,
  head: string,
): Promise<IndexHandoffMemo> {
  const sourceUrl = await requireRepoTarballUrlResolver(getGitProvider(target.providerId))(
    input.installationId,
    input.repoOwner,
    input.repoName,
    head,
  );
  const answer = await handOffCodeGraphIndex({
    coreOrganizationId: target.organizationId,
    coreWorkspaceId: input.workspaceId,
    coreProjectId: target.anchorProjectId,
    repoRef: target.repoRef,
    ...kindFields,
    commitSha: head,
    ref: input.defaultBranch,
    sourceUrl,
  });
  if (answer.outcome === 'registration_in_progress') {
    deferRun(
      new Date(Date.now() + INDEX_HANDOFF_REGISTRATION_RETRY_MS),
      'index handoff: the repository is being registered by another request',
    );
  }
  return { jobId: answer.jobId, commitSha: head, handedAt: new Date().toISOString() };
}

type SettledOutcome =
  | { kind: 'published' }
  | { kind: 'superseded'; publishedCommit: string }
  | { kind: 'refused_for_size'; message: string }
  | { kind: 'failed'; reason: string; message: string }
  | { kind: 'pending' };

/**
 * What the service's status says about THE HANDED COMMIT. Published when it is the
 * indexed commit; still pending while a job for it is queued or running; refused or
 * failed when it is the last failure's commit. A failure of an OLDER commit is
 * history, not this run's outcome.
 *
 * ⚠️ SUPERSEDED (MOTIR-11884). With no debounce, pushes are handed off one run each,
 * and the service's queue supersedes a still-queued push of the same repository and
 * ref by a newer one — so the handed commit may never be published. When nothing is
 * in progress and the service published a DIFFERENT commit after this handoff, the
 * handed job was superseded or overtaken: the repository is indexed at a newer head,
 * and the run settles on that rather than waiting out the deadline for a commit that
 * will never come. While anything is in progress, the run keeps waiting.
 */
export function settledOutcome(
  status: CodeGraphIndexStatus,
  handed: Pick<IndexHandoffMemo, 'commitSha' | 'handedAt'>,
): SettledOutcome {
  const handedCommit = handed.commitSha;
  if (status.indexedCommit?.commit === handedCommit) return { kind: 'published' };
  if (status.inProgressJob?.commit === handedCommit) return { kind: 'pending' };
  const failure = status.lastFailure;
  if (failure?.commit === handedCommit) {
    return failure.reason === CODEGRAPH_SIZE_REFUSAL_REASON
      ? { kind: 'refused_for_size', message: failure.message }
      : { kind: 'failed', reason: failure.reason, message: failure.message };
  }
  const published = status.indexedCommit;
  if (
    status.inProgressJob === null &&
    published !== null &&
    Date.parse(published.publishedAt) > Date.parse(handed.handedAt)
  ) {
    return { kind: 'superseded', publishedCommit: published.commit };
  }
  return { kind: 'pending' };
}
