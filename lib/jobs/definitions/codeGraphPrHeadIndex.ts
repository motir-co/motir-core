import { handOffCodeGraphIndex } from '@/lib/ai/motirAiClient';
import {
  AI_PLAN_INDEX_PAUSE_REASON,
  INDEX_SIZE_REFUSED_PAUSE_REASON,
  type IndexPauseReason,
} from '@/lib/ciFleet/indexAllowance';
import { getGitProvider, requireRepoTarballUrlResolver, type ChangedFilesResult } from '@/lib/git';
import { readPullRequest } from '@/lib/github/pullRequestRead';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import {
  requireCurrentIndexTarget,
  type IndexRepoInput,
  type IndexSkipReason,
  type IndexTarget,
} from '@/lib/services/codeGraphIndexService';
import { withSystemContext } from '@/lib/workspaces/context';
import { defineJob } from '../defineJob';
import { deferRun } from '../engine/defer';
import {
  INDEX_HANDOFF_PLAN_UNKNOWN_RETRY_MS,
  INDEX_HANDOFF_REGISTRATION_RETRY_MS,
  type IndexHandoffMemo,
  type PushFallbackReason,
} from '../indexHandoffSteps';
import type { JobServices } from '../services';
import type { CodeGraphPrHeadIndexData } from '../types';

// THE PULL-REQUEST HEAD INDEX (MOTIR-12257 · story MOTIR-12250) —
// `system.code-graph-pr-head-index`.
//
// ONE same-repository pull request's head, handed to motir-ai for indexing on
// `opened`, `reopened` and `synchronize` (`githubPrHeadIndexService`). motir-codegraph
// writes it as a delta over the named previous commit, or as a first index when that
// commit is not one it holds.
//
//   step  resolve-target-v1   the default-branch run's target read (DB only); a
//                             no-op verdict ends the run with it
//   step  pr-gates-v1         the allowance, the paid AI plan (an `unknown` answer
//                             defers from INSIDE the step) and the row's size refusal
//   step  pr-head-v1          the pull request read LIVE from the host: still open,
//                             still same-repository, its head ref and head sha
//   step  pr-head-diff-v1     the row's stamped head, the host's two listings
//                             between it and the head, and the push-or-first-index
//                             decision over them
//   step  pr-handoff-v1       mint the URL at the head and hand off: ONE memo,
//                             holding only `{ jobId, commitSha, handedAt }`
//
// ⚠️ WHY THIS IS NOT `runIndexHandoffSteps`. That runner is built for ONE ref per
// repository and two of its steps belong to the DEFAULT BRANCH: it settles on
// `readCodeGraphIndexStatus`, whose `indexedCommit` is the default branch's (a
// branch head would never read as published and would time out), and on publish it
// stamps the row's `indexedHeadSha` — the head the next default-branch push is
// compared against. So this run asks the same gates and WRITES NONE of the row's
// index state: no claim, no pause, no lift, no stamp, no refusal. It ends when
// motir-ai accepts the handoff; whether the head then publishes is the service's,
// observable through its reads.
//
// ⚠️ THE HEAD IS READ LIVE, NEVER TAKEN FROM THE DELIVERY. A redelivered or
// out-of-order `synchronize` hands off the host's CURRENT head, so an older delivery
// never sends an older commit as newer; a pull request closed before its run reads
// it hands off nothing, so a late run cannot re-index a branch the close retired.
//
// ⚠️ THE CHANGED PATHS ARE TWO LISTINGS. GitHub's `listChangedFiles` is the
// three-dot `compare/{base}...{head}` — what `head` changed since it left `base`.
// For a default-branch push the stamped head is an ancestor and that is the whole
// difference; for a branch it is not: once `main` moves, the files `main` changed
// that the branch lacks are missing, and a delta written with that list would show
// `main`'s newer version as the branch's. Every path that differs between the two
// commits changed since their merge base on at least one side, so the union of both
// directions covers the whole difference (a superset is safe).
//
// ⚠️ THE SOURCE URL IS A BEARER SECRET TO THE CUSTOMER'S CODE. It is minted inside
// the handoff step and dropped before the step returns: it never enters a memo, the
// run's output, a log line or an error. The installation token the live read mints
// is dropped inside its step the same way.
//
// SYSTEM-scoped and `retryPolicy: 'idempotent'`, as the default-branch jobs are: a
// re-handed head is the same commit, and the service supersedes a queued duplicate
// of a ref as it does for pushes.

/** Why a run handed nothing off. */
export type PrHeadSkipReason =
  | IndexSkipReason
  | IndexPauseReason
  | 'refused_for_size'
  | 'not_open'
  | 'gone'
  | 'fork_head';

/** What a finished run records. Never a URL or a token. */
export type CodeGraphPrHeadIndexResult =
  | { handed: false; reason: PrHeadSkipReason }
  | {
      handed: true;
      repoRef: string;
      pullRequestNumber: number;
      commitSha: string;
      kind: 'push' | 'first_index';
    };

/** The gates step's memo. */
export type PrHeadGates =
  | { proceed: true }
  | { proceed: false; reason: IndexPauseReason | 'refused_for_size' };

/** The live read's memo. */
export type LivePullRequestHead =
  | { open: true; headRef: string; headSha: string }
  | { open: false; reason: 'not_open' | 'gone' | 'fork_head' };

/** The comparison step's memo: the push fields, or a first index and why. */
export type PrHeadComparison =
  | { kind: 'push'; previousCommitSha: string; changedPaths: string[] }
  | { kind: 'first_index'; fallback: PushFallbackReason };

/** One listing as the comparison sees it: the host's answer, a throw, or not asked. */
export type PrHeadListing = ChangedFilesResult | { threw: true } | null;

/** motir-codegraph accepts a commit only as 40 lowercase hex. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** The listings are asked only when the pair can be compared at all. */
const comparable = (stampedHead: string | null, head: string): stampedHead is string =>
  stampedHead !== null && stampedHead !== head && FULL_SHA.test(stampedHead) && FULL_SHA.test(head);

/** Why one listing cannot be vouched for, or null when it is a clean answer. */
function listingFallback(listing: PrHeadListing): PushFallbackReason | null {
  if (!listing || 'threw' in listing) return 'comparison_threw';
  if (listing.outcome !== 'ok') return listing.outcome;
  if (listing.truncated) return 'truncated';
  return null;
}

/**
 * THE PUSH-OR-FIRST-INDEX RULE for a pull request's head (MOTIR-12257), pure, so it
 * is tested as a table.
 *
 * `stampedHead` is the repository row's `indexedHeadSha` — the default branch's last
 * published commit, WHATEVER the pull request's base: the two-direction listing makes
 * a delta over any indexed commit correct, so a stacked pull request is a push over
 * it too. It is a `push` only when that head is a full sha different from the head
 * and BOTH listings are clean (`ok`, untruncated); the changed paths are every file's
 * path plus each rename's previous path, from both, de-duplicated. Anything else is a
 * `first_index`, which the service builds whole — the safe answer when the comparison
 * is unknown.
 */
export function prHeadComparisonFor(
  stampedHead: string | null,
  head: string,
  /** `listChangedFiles(stampedHead, head)`: what the branch changed. */
  forward: PrHeadListing,
  /** `listChangedFiles(head, stampedHead)`: what the base moved on since. */
  backward: PrHeadListing,
): PrHeadComparison {
  if (!stampedHead) return { kind: 'first_index', fallback: 'no_stamped_head' };
  if (stampedHead === head) return { kind: 'first_index', fallback: 'head_unchanged' };
  if (!FULL_SHA.test(stampedHead) || !FULL_SHA.test(head)) {
    return { kind: 'first_index', fallback: 'sha_not_hex' };
  }
  const fallback = listingFallback(forward) ?? listingFallback(backward);
  if (fallback) return { kind: 'first_index', fallback };
  const paths = new Set<string>();
  for (const listing of [forward, backward] as ChangedFilesResult[]) {
    if (listing.outcome !== 'ok') continue;
    for (const file of listing.files) {
      paths.add(file.path);
      if (file.previousPath) paths.add(file.previousPath);
    }
  }
  return { kind: 'push', previousCommitSha: stampedHead, changedPaths: [...paths] };
}

type ResolvedTarget = Extract<IndexTarget, { indexed: true }>;

/** The default-branch run's input, from this payload's first five fields. */
function indexInputOf(data: CodeGraphPrHeadIndexData): IndexRepoInput {
  return {
    installationId: data.installationId,
    workspaceId: data.workspaceId,
    repoOwner: data.repoOwner,
    repoName: data.repoName,
    defaultBranch: data.defaultBranch,
  };
}

/** The repository row, under the system context — no workspace is bound in a job. */
function readRow(data: CodeGraphPrHeadIndexData, target: ResolvedTarget) {
  return withSystemContext((tx) =>
    githubRepoRepository.findConnectedByOrganizationAndName(
      target.organizationId,
      data.repoOwner,
      data.repoName,
      tx,
    ),
  );
}

/**
 * The gates step's body: the default-branch run's allowance and plan, asked the same
 * way, and the row's size refusal. A stop writes NOTHING — the row's pause and
 * refusal are the default-branch run's to write.
 */
async function askGates(
  data: CodeGraphPrHeadIndexData,
  target: ResolvedTarget,
  services: JobServices,
): Promise<PrHeadGates> {
  const allowance = await services.codeGraphIndexAllowance.askIndexAllowance(target.organizationId);
  if (!allowance.proceed) return { proceed: false, reason: allowance.reason };
  const paid = await aiPlanGateService.hasPaidAiPlan(target.organizationId);
  if (paid === 'unknown') {
    deferRun(
      new Date(Date.now() + INDEX_HANDOFF_PLAN_UNKNOWN_RETRY_MS),
      'pull-request head index: the AI plan could not be read',
    );
  }
  if (paid !== true) return { proceed: false, reason: AI_PLAN_INDEX_PAUSE_REASON };
  const row = await readRow(data, target);
  if (
    row &&
    (row.indexRefusedAt !== null || row.indexPausedReason === INDEX_SIZE_REFUSED_PAUSE_REASON)
  ) {
    return { proceed: false, reason: 'refused_for_size' };
  }
  return { proceed: true };
}

/**
 * The live read's body: the pull request as the host has it NOW. A read the host
 * cannot answer throws, unrecorded, so the idempotent retry asks again; a pull
 * request the host says is gone, closed or now a fork ends the run.
 */
async function readLiveHead(
  data: CodeGraphPrHeadIndexData,
  target: ResolvedTarget,
): Promise<LivePullRequestHead> {
  const { token } = await getGitProvider(target.providerId).mintInstallationToken(
    data.installationId,
    { owner: data.repoOwner },
  );
  const read = await readPullRequest(token, data.repoOwner, data.repoName, data.pullRequestNumber, {
    caller: 'codeGraphPrHeadIndex',
    installationId: data.installationId,
  });
  if (read.kind === 'gone') return { open: false, reason: 'gone' };
  const pr = read.pullRequest;
  if (pr['state'] !== 'open') return { open: false, reason: 'not_open' };
  const head = record(pr['head']);
  const headRepoId = idOf(record(head?.['repo'])?.['id']);
  const baseRepoId = idOf(record(record(pr['base'])?.['repo'])?.['id']);
  if (!headRepoId || headRepoId !== baseRepoId) return { open: false, reason: 'fork_head' };
  const headRef = head?.['ref'];
  const headSha = head?.['sha'];
  if (
    typeof headRef !== 'string' ||
    headRef === '' ||
    typeof headSha !== 'string' ||
    !FULL_SHA.test(headSha)
  ) {
    throw new Error(
      `pull-request head index: ${target.repoRef}#${String(data.pullRequestNumber)} has no readable head ref or sha`,
    );
  }
  return { open: true, headRef, headSha };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function idOf(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : null;
}

/**
 * The comparison step's body: the row's stamped head, the host's two listings
 * between it and the head, and the decision over them.
 *
 * ⚠️ IT NEVER THROWS. A row read or a listing that throws is a first index — always
 * a correct answer — and the step records it, so a retry does not ask the host again
 * for the same pair. The fallback is logged once, with the repository and the reason.
 */
async function compareHead(
  data: CodeGraphPrHeadIndexData,
  target: ResolvedTarget,
  head: string,
): Promise<PrHeadComparison> {
  let comparison: PrHeadComparison;
  try {
    const stampedHead = (await readRow(data, target))?.indexedHeadSha ?? null;
    let forward: PrHeadListing = null;
    let backward: PrHeadListing = null;
    if (comparable(stampedHead, head)) {
      const provider = getGitProvider(target.providerId);
      // Each listing catches its own throw, so one failing never hides the other's
      // answer from the rule — which then falls back on the failed one.
      const list = async (base: string, tip: string): Promise<PrHeadListing> => {
        try {
          return await provider.listChangedFiles(
            data.installationId,
            data.repoOwner,
            data.repoName,
            base,
            tip,
          );
        } catch {
          return { threw: true };
        }
      };
      forward = await list(stampedHead, head);
      backward = await list(head, stampedHead);
    }
    comparison = prHeadComparisonFor(stampedHead, head, forward, backward);
  } catch {
    // The row read itself failed: nothing to compare against that can be vouched for.
    comparison = { kind: 'first_index', fallback: 'comparison_threw' };
  }
  if (comparison.kind === 'first_index') {
    console.warn(
      `[code-graph-pr-head-index] ${target.repoRef}#${String(data.pullRequestNumber)}: handed off as a first index (${comparison.fallback})`,
    );
  }
  return comparison;
}

/**
 * The handoff step's body: mint the source URL AT the head and hand off a branch
 * head. The URL lives only in this function's scope; a `429 rate_limited` answer
 * defers from inside the step, unrecorded, so the next pass mints afresh.
 */
async function handOff(
  data: CodeGraphPrHeadIndexData,
  target: ResolvedTarget,
  live: Extract<LivePullRequestHead, { open: true }>,
  comparison: PrHeadComparison,
): Promise<IndexHandoffMemo> {
  const sourceUrl = await requireRepoTarballUrlResolver(getGitProvider(target.providerId))(
    data.installationId,
    data.repoOwner,
    data.repoName,
    live.headSha,
  );
  const answer = await handOffCodeGraphIndex({
    coreOrganizationId: target.organizationId,
    coreWorkspaceId: data.workspaceId,
    coreProjectId: target.anchorProjectId,
    repoRef: target.repoRef,
    ...(comparison.kind === 'push'
      ? {
          kind: 'push' as const,
          previousCommitSha: comparison.previousCommitSha,
          changedPaths: comparison.changedPaths,
        }
      : { kind: 'first_index' as const }),
    commitSha: live.headSha,
    ref: live.headRef,
    sourceUrl,
    isDefaultBranch: false,
  });
  if (answer.outcome === 'registration_in_progress') {
    deferRun(
      new Date(Date.now() + INDEX_HANDOFF_REGISTRATION_RETRY_MS),
      'pull-request head index: the repository is being registered by another request',
    );
  }
  return { jobId: answer.jobId, commitSha: live.headSha, handedAt: new Date().toISOString() };
}

export const codeGraphPrHeadIndex = defineJob(
  {
    id: 'system.code-graph-pr-head-index',
    retryPolicy: 'idempotent',
  },
  async (ctx, services): Promise<CodeGraphPrHeadIndexResult> => {
    const data = ctx.event.data as CodeGraphPrHeadIndexData;
    const input = indexInputOf(data);

    const target = requireCurrentIndexTarget(
      await ctx.step.run('resolve-target-v1', () => services.codeGraph.resolveIndexTarget(input)),
    );
    if (!target.indexed) return { handed: false, reason: target.reason };

    const gates = await ctx.step.run('pr-gates-v1', () => askGates(data, target, services));
    if (!gates.proceed) return { handed: false, reason: gates.reason };

    const live = await ctx.step.run('pr-head-v1', () => readLiveHead(data, target));
    if (!live.open) return { handed: false, reason: live.reason };

    const comparison = await ctx.step.run('pr-head-diff-v1', () =>
      compareHead(data, target, live.headSha),
    );

    const handed = await ctx.step.run('pr-handoff-v1', () =>
      handOff(data, target, live, comparison),
    );

    return {
      handed: true,
      repoRef: target.repoRef,
      pullRequestNumber: data.pullRequestNumber,
      commitSha: handed.commitSha,
      kind: comparison.kind,
    };
  },
);
