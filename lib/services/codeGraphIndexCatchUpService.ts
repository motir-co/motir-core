import { checkIndexAllowance } from '@/lib/ai/motirAiClient';
import { deriveCodeGraphIndexState, hasBuiltGraph } from '@/lib/codeGraph/indexState';
import {
  isIndexHardStop,
  isIndexCapacityPause,
  type IndexAllowanceVerdict,
} from '@/lib/ciFleet/indexAllowance';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { enqueueCodeGraphIndex, enqueueCodeGraphRefresh } from '@/lib/github/indexEnqueue';
import type { CodeGraphIndexData } from '@/lib/jobs/types';
import {
  githubRepoRepository,
  type IndexCatchUpCandidate,
  type IndexRetryArm,
  type IndexRetryCandidate,
} from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE INDEX CATCH-UP SWEEP (MOTIR-5290 · Story MOTIR-4335).
//
// MOTIR-4593 pauses indexing for a repository when its organisation's internal
// index allowance answers a HARD STOP, and records why. A stop lifts on three
// events — a top-up, a paid tier's new period (`invoice.paid` renews the pool,
// MOTIR-5284) and an upgrade from a Free organisation stopped at its one-time
// allowance — and ALL THREE HAPPEN IN MOTIR-AI. motir-core hears about none of
// them, so this does not wait to be told: it RE-ASKS.
//
// ⚠️ PULL, NOT PUSH, AND THE TRADE IS STATED. One mechanism covers every lift
// event, keeps the card in one repository, and survives a lost notification
// because there is none to lose. It costs latency: indexing resumes within one
// sweep interval of the lift, not at the lift.
//
// ⚠️ Motir does not charge for code indexing. The allowance is internal.
//
// ⚠️ DRIFT, NEVER THE CALENDAR. When an organisation may index again, a paused
// repository is refreshed ONLY if its default branch moved past the graph. An old
// graph on an unchanged repository is a fresh graph: refreshing it would spend
// the allowance that was just granted on code that did not change. Its pause is
// cleared instead. A repository that was never indexed has no graph to be
// current, so it gets its FIRST index.
//
// ⚠️ THE PAUSE IS NOT CLEARED WHEN A REFRESH IS ENQUEUED. The enqueue is
// best-effort and swallows a transport failure, so clearing there could leave a
// stale repository with no record that anything is owed. The dispatched run asks
// the allowance itself and lifts the pause when it boots (MOTIR-4593); until then
// a later sweep may enqueue again, which the refresh job's per-repo debounce
// coalesces.
//
// ⚠️ A FULL INDEXER POOL IS RE-ASKED OF THE POOL, NOT OF THE ALLOWANCE
// (MOTIR-9451). A repository paused because every indexer account was full is
// not refused by its organisation, so asking the allowance for it would answer
// a question that never applied. Those rows are acted on only when the pool has
// room — a read-only headroom check through the SAME chooser admission uses, so
// the two cannot disagree about whether a unit of room exists — and otherwise
// stay paused as `pool_still_full`, so the sweep never re-enqueues into a pool
// that is still full. Admission stays the authority: a dispatch it defers again
// pauses again, and the next tick retries.

// ⚠️ A TERMINALLY FAILED RUN IS RE-DISPATCHED, BOUNDED (MOTIR-10819). A run that
// ends `failed` (its retries exhausted, dead-lettered) or `abandoned` writes no
// pause, so the pass above never saw it: a transient fleet fault left a new
// repository unindexed, and a stale one unrefreshed, until a person replayed the
// dead letter. `retryFailed` is the sweep's second input on the same tick. It
// re-dispatches through the release-then-enqueue `retryIndex` uses — the release
// conditional on the claim still naming the dead run is the race guard — and it is
// BOUNDED, because a repository that fails deterministically must not be
// re-dispatched every five minutes: a backoff doubling from the dead run's finish,
// and a cap on attempts after which `refreshFailing` (MOTIR-2105) is the signal.
// A size refusal is never retried: the index would be refused the same way.

/** Automatic re-dispatches of a FAILED run per repository between two successful
 *  indexes. A lost dispatch is re-sent past it (see `listIndexRetryCandidates`).
 *  Five, with the backoff below, spans about 15½ hours of failures (30 min, 1 h,
 *  2 h, 4 h, 8 h): long enough to outlast a fleet outage like MOTIR-10805's three
 *  hours with room to spare, short enough that a repository that fails every
 *  time stops costing index runs within a day and is left to `refreshFailing`. */
export const INDEX_RETRY_MAX_ATTEMPTS = 5;

/** The wait before the first re-dispatch, doubled for each attempt already made.
 *  Thirty minutes, because a transient fault that dead-lettered a run already
 *  outlasted that run's own five queue attempts: re-dispatching on the next tick
 *  would most likely land in the same fault. */
export const INDEX_RETRY_BASE_BACKOFF_MS = 30 * 60_000;

/** How long a re-dispatch may go unclaimed before it is read as LOST. The enqueue
 *  is best-effort and swallows a transport failure, and the release already
 *  cleared the claim, so nothing else would ever say an index is still owed. Six
 *  hours, because a queued index normally starts within minutes and a run that
 *  waits for room records a pause instead; re-sending sooner would double a run
 *  that is merely queued. */
export const INDEX_RETRY_LOST_DISPATCH_GRACE_MS = 6 * 60 * 60_000;

/** Retry candidates considered per tick — the oldest failure first. */
export const INDEX_RETRY_BATCH = 200;

export type IndexRetryOutcome =
  /** Never indexed — a first index was re-enqueued. */
  | 'retry_index_enqueued'
  /** The head moved past the graph — a refresh was re-enqueued. */
  | 'retry_refresh_enqueued'
  /** Another sweep, or a manual retry, claimed it first — nothing was enqueued. */
  | 'retry_raced'
  /** The graph is current after all — nothing is owed, nothing was written. */
  | 'retry_not_owed'
  /** The claim was taken but the enqueue threw. The attempt is spent; the lost-
   *  dispatch arm re-sends it once its grace has passed. */
  | 'retry_enqueue_failed';

export interface IndexRetrySummary {
  scanned: number;
  outcomes: {
    repoRef: string;
    organizationId: string;
    arm: IndexRetryArm;
    attempt: number;
    outcome: IndexRetryOutcome;
  }[];
}

export interface IndexRetryDeps {
  enqueueRefresh: (data: CodeGraphIndexData) => Promise<void>;
  enqueueIndex: (data: CodeGraphIndexData) => Promise<void>;
}

/** Paused repositories considered per tick — oldest pause first. */
export const INDEX_CATCH_UP_BATCH = 200;

export type IndexCatchUpOutcome =
  /** The allowance still answers a hard stop — the pause stays. */
  | 'still_stopped'
  /** The allowance could not be asked — every pause stays, and the next sweep retries. */
  | 'ask_failed'
  /** Allowed again, and the head moved past the graph — a refresh was enqueued. */
  | 'refresh_enqueued'
  /** Allowed again, never indexed — a first index was enqueued. */
  | 'index_enqueued'
  /** Allowed again, and the graph is current — the pause was cleared, nothing enqueued. */
  | 'pause_cleared'
  /** Allowed again, but the head is unknown — nothing can say the graph is behind.
   *  The pause stays; the next default-branch push records a head and enqueues its
   *  own refresh. */
  | 'head_unknown'
  /** The action for this repository threw — its pause stays, and the next sweep retries. */
  | 'action_failed'
  /** Paused for a full indexer pool, and the pool is still full — the pause stays
   *  and no allowance was asked (MOTIR-9451). */
  | 'pool_still_full';

export interface IndexCatchUpSummary {
  scanned: number;
  organizationsAsked: number;
  outcomes: { repoRef: string; organizationId: string; outcome: IndexCatchUpOutcome }[];
}

export interface IndexCatchUpDeps {
  check: (organizationId: string) => Promise<IndexAllowanceVerdict | null>;
  enqueueRefresh: (data: CodeGraphIndexData) => Promise<void>;
  enqueueIndex: (data: CodeGraphIndexData) => Promise<void>;
  /** Does the indexer pool have room for this organisation's index right now?
   *  Read-only: chooses an account and takes nothing (MOTIR-9451). */
  poolHasRoom: (organizationId: string) => Promise<boolean>;
}

/** The pool's answer, through admission's own chooser, in a transaction of its
 *  own. The switch off (`shardId: null`) means the index runs on the process-wide
 *  fleet, which a full pool does not hold up, so it counts as room. */
export async function indexPoolHasRoom(organizationId: string): Promise<boolean> {
  const placement = await withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx(
      { fleetKind: 'code_graph_index', organizationId },
      new Date(),
      tx,
    ),
  );
  return !('deferred' in placement);
}

// Looked up at CALL time, not captured at import: a suite that mocks the client
// module without these exports must still be able to import the job registry.
const defaultDeps: IndexCatchUpDeps = {
  check: (organizationId) => checkIndexAllowance(organizationId),
  enqueueRefresh: (data) => enqueueCodeGraphRefresh(data),
  enqueueIndex: (data) => enqueueCodeGraphIndex(data),
  poolHasRoom: (organizationId) => indexPoolHasRoom(organizationId),
};

/**
 * What to do with ONE paused repository of an organisation that may index again.
 *
 * ⚠️ WHETHER THE GRAPH IS BEHIND IS `deriveCodeGraphIndexState`'s ANSWER, NOT A
 * SECOND ONE (`tests/codeGraph/indexState.test.ts` holds the tree to one
 * derivation). This only hands it the row's facts. `hasSucceededIndex` is
 * `hasBuiltGraph` — the row's `indexedAt`, the same fact every other caller hands
 * over (Bug MOTIR-10171).
 *
 * ⚠️ A GRAPH BUILT AT AN UNKNOWN HEAD IS REFRESHED, NEVER CLEARED. A success that
 * started before any push recorded a head stamps `indexedAt` and no sha. The
 * derivation reads that as `indexed` (nothing says it is behind), but a pause is
 * exactly the window in which pushes went unindexed, so once a head IS known
 * nothing says the graph matches it either. It is owed a refresh — over-indexing
 * once, never leaving a graph behind.
 */
export function catchUpActionFor(
  repo: Pick<IndexCatchUpCandidate, 'indexedAt' | 'indexedHeadSha' | 'defaultBranchHeadSha'>,
): 'refresh_enqueued' | 'index_enqueued' | 'pause_cleared' | 'head_unknown' {
  const state = deriveCodeGraphIndexState({
    hasSucceededIndex: hasBuiltGraph(repo),
    defaultBranchHeadSha: repo.defaultBranchHeadSha,
    indexedHeadSha: repo.indexedHeadSha,
    // A paused repository has nothing in flight: the pause released its claim.
    hasRunningIndex: false,
  });
  if (state === 'never') return 'index_enqueued';
  if (state === 'indexed') {
    // `indexed` with no recorded head means NOTHING says it is behind — the
    // derivation's own reading of a null head — which is not the same as current.
    if (repo.defaultBranchHeadSha === null) return 'head_unknown';
    return repo.indexedHeadSha === null ? 'refresh_enqueued' : 'pause_cleared';
  }
  return 'refresh_enqueued';
}

/** Re-dispatch ONE retry candidate: claim it, then enqueue what it is owed. */
async function retryOne(
  repo: IndexRetryCandidate,
  now: Date,
  deps: IndexRetryDeps,
): Promise<IndexRetryOutcome> {
  const action = catchUpActionFor(repo);
  // The read already leaves a current graph out; this is the one derivation
  // having the last word, so a row it calls current is never re-indexed.
  if (action !== 'index_enqueued' && action !== 'refresh_enqueued') return 'retry_not_owed';
  const claimed = await withSystemContext((tx) =>
    githubRepoRepository.claimIndexRetry(repo, now, tx),
  );
  if (claimed === 0) return 'retry_raced';
  const data: CodeGraphIndexData = {
    installationId: repo.hostInstallationId,
    workspaceId: repo.workspaceId,
    repoOwner: repo.owner,
    repoName: repo.name,
    defaultBranch: repo.defaultBranch,
  };
  try {
    if (action === 'index_enqueued') {
      await deps.enqueueIndex(data);
      return 'retry_index_enqueued';
    }
    await deps.enqueueRefresh(data);
    return 'retry_refresh_enqueued';
  } catch (err) {
    console.error('[index-catch-up] could not re-enqueue a failed index', {
      repoRef: `${repo.owner}/${repo.name}`,
      err,
    });
    return 'retry_enqueue_failed';
  }
}

export const codeGraphIndexCatchUpService = {
  /**
   * One pass. Never throws on a single organisation's failure: an unreachable
   * motir-ai leaves that organisation's pauses in place and the pass moves on.
   */
  async catchUp(
    opts: { limit?: number; deps?: IndexCatchUpDeps } = {},
  ): Promise<IndexCatchUpSummary> {
    const deps = opts.deps ?? defaultDeps;
    const rows = await withSystemContext((tx) =>
      githubRepoRepository.listIndexPaused(opts.limit ?? INDEX_CATCH_UP_BATCH, tx),
    );
    const summary: IndexCatchUpSummary = {
      scanned: rows.length,
      organizationsAsked: 0,
      outcomes: [],
    };

    // ONE ask per organisation: the verdict is org-scoped, and asking per
    // repository would multiply the calls by the estate's width for one answer.
    const byOrganization = new Map<string, IndexCatchUpCandidate[]>();
    for (const row of rows) {
      byOrganization.set(row.organizationId, [
        ...(byOrganization.get(row.organizationId) ?? []),
        row,
      ]);
    }

    for (const [organizationId, repos] of byOrganization) {
      // ONE allowance ask, and only when a row of this organisation is paused by
      // the allowance; ONE pool read, only when a row is paused by a full pool.
      const allowancePaused = repos.some((repo) => !isIndexCapacityPause(repo.indexPausedReason));
      const poolPaused = repos.some((repo) => isIndexCapacityPause(repo.indexPausedReason));

      let blanket: IndexCatchUpOutcome | null = null;
      if (allowancePaused) {
        summary.organizationsAsked += 1;
        // Total client: `null` is "could not ask", and it is never read as a lift.
        const verdict = await deps.check(organizationId);
        blanket = !verdict
          ? 'ask_failed'
          : isIndexHardStop(verdict.outcome)
            ? 'still_stopped'
            : null;
      }
      let poolBlanket: IndexCatchUpOutcome | null = null;
      if (poolPaused) {
        try {
          poolBlanket = (await deps.poolHasRoom(organizationId)) ? null : 'pool_still_full';
        } catch (err) {
          // An unreadable pool is not room: the pause stays, the next tick retries.
          console.error('[index-catch-up] could not read the indexer pool', {
            organizationId,
            err,
          });
          poolBlanket = 'pool_still_full';
        }
      }

      for (const repo of repos) {
        const repoRef = `${repo.owner}/${repo.name}`;
        const outcome =
          (isIndexCapacityPause(repo.indexPausedReason) ? poolBlanket : blanket) ??
          catchUpActionFor(repo);
        const data: CodeGraphIndexData = {
          installationId: repo.hostInstallationId,
          workspaceId: repo.workspaceId,
          repoOwner: repo.owner,
          repoName: repo.name,
          defaultBranch: repo.defaultBranch,
        };
        try {
          if (outcome === 'refresh_enqueued') await deps.enqueueRefresh(data);
          if (outcome === 'index_enqueued') await deps.enqueueIndex(data);
          if (outcome === 'pause_cleared') {
            await withSystemContext((tx) => githubRepoRepository.clearIndexPause(repoRef, tx));
          }
          summary.outcomes.push({ repoRef, organizationId, outcome });
        } catch (err) {
          // One repository's failure never stops the rest; its pause stays.
          console.error('[index-catch-up] could not act on a paused repository', { repoRef, err });
          summary.outcomes.push({ repoRef, organizationId, outcome: 'action_failed' });
        }
      }
    }
    return summary;
  },

  /**
   * The RETRY pass (MOTIR-10819): re-dispatch each repository whose claimed index
   * or refresh run ended terminal for a reason other than size, once its backoff
   * has elapsed and while it is under the attempt cap. A first index when it was
   * never indexed, a refresh when its head moved past the graph — the same
   * `catchUpActionFor` the paused pass reads. Never throws on one repository.
   */
  async retryFailed(
    opts: { limit?: number; now?: Date; deps?: IndexRetryDeps } = {},
  ): Promise<IndexRetrySummary> {
    const deps = opts.deps ?? defaultDeps;
    const now = opts.now ?? new Date();
    const rows = await withSystemContext((tx) =>
      githubRepoRepository.listIndexRetryCandidates(
        {
          limit: opts.limit ?? INDEX_RETRY_BATCH,
          maxAttempts: INDEX_RETRY_MAX_ATTEMPTS,
          baseBackoffMs: INDEX_RETRY_BASE_BACKOFF_MS,
          lostDispatchGraceMs: INDEX_RETRY_LOST_DISPATCH_GRACE_MS,
          now,
        },
        tx,
      ),
    );
    const summary: IndexRetrySummary = { scanned: rows.length, outcomes: [] };
    for (const repo of rows) {
      summary.outcomes.push({
        repoRef: `${repo.owner}/${repo.name}`,
        organizationId: repo.organizationId,
        arm: repo.arm,
        attempt: repo.retryAttempts + 1,
        outcome: await retryOne(repo, now, deps),
      });
    }
    return summary;
  },
};
