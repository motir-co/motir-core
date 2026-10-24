import { getGitProvider } from '@/lib/git';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { githubAppRoleForRepo } from '@/lib/github/appRoleForRepo';
import { readPullRequest } from '@/lib/github/pullRequestRead';
import {
  githubPullRequestRepository,
  type ReconcileCandidate,
} from '@/lib/repositories/githubPullRequestRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { githubWebhookService } from './githubWebhookService';
import { resyncLinkedPullRequest, type ChangeRequestSyncResult } from './changeRequestStatusSync';
import { workflowsService } from './workflowsService';
import { reconcileGatesFor } from './gateSetFor';
import { promoteIfCiAlreadyGreen } from './ciPromotion';
import { readReportedCheckRuns, readReportedCheckSet } from './checkSetReconcile';
import { pullRequestMergeabilityService } from './pullRequestMergeabilityService';
import { resettleStandingExit } from './mergeQueueExitService';
import { githubMergeQueueAttemptRepository } from '@/lib/repositories/githubMergeQueueAttemptRepository';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import type { ReportedCheckRun } from '@/lib/github/checkRuns';
import { pullRequestHead } from '@/lib/github/pullRequestHead';
import { HUNG_CHECK_CONCLUSIONS } from '@/lib/mergeQueue/queueExit';
import { queueExitStandsAtHead } from '@/lib/workItems/deliverySet';
import { sendEvent } from '@/lib/jobs/sendEvent';

// THE OPEN-DELIVERY RECONCILE (MOTIR-5390) — the path that makes a lost
// `pull_request` delivery recoverable instead of permanent.
//
// ── The defect it closes ─────────────────────────────────────────────────
// The status sync has exactly ONE ingress for a merge: the GitHub App's
// `pull_request` delivery. If that request fails (a 500 while the connection
// pool is starved, a restart mid-request) or never arrives, the mirror row keeps
// reading `open` and the card it delivers never completes. GitHub does not
// redeliver a failed App delivery on its own, and nothing else in this repository
// re-read a pull request's state from the host — so one lost event held a card at
// In Review with no end date. `motir-meta#395` merged at 19:58:55Z on 2026-09-13;
// its row still read `open` and MOTIR-4336 sat at In Review behind it.
//
// ⚠️ AND A DELIVERY CAN DIE HALF-WAY. The sync commits the row upsert in one
// transaction and moves the card in a later one, so a failure at the transition
// leaves the row `closed` / `merged` and the card where it was — a redelivery
// repairs it, and none comes. Such a row is recognisable exactly: the post-commit
// capture that stamps `merged_at` runs after the sync, so it never ran.
//
// ── What it does ─────────────────────────────────────────────────────────
// Treat the webhook as the FAST path and a periodic read of the host as the
// GUARANTEE. Each pass:
//   1. DISCOVERS delivering pull requests nothing has heard about for a while
//      that are either still OPEN, or MERGED with no `merged_at` inside a
//      lookback (`listReconcileCandidates`) — cross-tenant, under the system
//      flag, over tables that are all armed for it.
//   2. Keeps only those that still deliver a LIVE card (not archived, not in a
//      done-category status), read per tenant with the workspace bound, because
//      `work_item` has no system arm. A pull request whose every card is already
//      finished is not worth a host call.
//   3. READS the pull request from GitHub with the installation token.
//   4. When the host says it is CLOSED — merged or not — REPLAYS it as a
//      `closed` delivery through `githubWebhookService.handlePullRequest`, the
//      same arm a real delivery reaches. So the sync, its row lock, every
//      completion gate (base branch, delivery set, repository set, draft), the
//      author attribution and the merged-path capture all apply unchanged, and
//      there is no second transition path to drift from the first.
//   5. When the host says it is still OPEN, records that it asked
//      (`markReconciled`) so the row rotates to the back of the queue.
//
// ── Why a CLOSED pull request is replayed, and an OPEN one only re-synced ──
// A missed `closed` is the only delivery with NO successor: nothing else will ever
// arrive for that pull request, so it is replayed whole.
//
// A missed `opened` or `ready_for_review` was once assumed to leave a card one
// rung low until the pull request's next delivery repaired it. That is FALSE for
// the first rung (MOTIR-9455): only those deliveries, the link-time resync and the
// run's own report write `in_progress → implemented`, and every promotion past it
// (green CI, `promoteIfCiAlreadyGreen`) moves a card only FROM `implemented`. So a
// run that forgot to report, a delivery that was lost, or one the container gate
// refused while a story's children were still landing, left the card at In
// Progress for good with its pull request green. A still-open, non-draft row whose
// delivered card sits at `in_progress` is therefore RE-SYNCED through
// `resyncLinkedPullRequest` — the link-time door, the same sync, the same gates —
// before the promotion below, so a card whose CI is already green reaches In
// Review in the same pass.
//
// ── Idempotency ───────────────────────────────────────────────────────────
// A late or duplicate real delivery after a reconcile, or the other way round, is
// the redelivery case the sync already converges on: the row lock serializes
// them, the second sees the card already in its target status and reports `noop`,
// and `mergeAlreadyRecorded` keeps the one-time notes one-time. A row a real
// delivery already finished stops matching either arm — it is no longer open, and
// its capture has stamped `merged_at` — so it is never read again.
//
// ── Bounded ───────────────────────────────────────────────────────────────
// At most `PULL_REQUEST_RECONCILE_BATCH_SIZE` candidates per pass, only rows
// quiet for `PULL_REQUEST_RECONCILE_QUIET_MINUTES`, and only rows delivering a
// live card reach the host. A per-row failure is COUNTED, never thrown: the row
// is simply due again next pass, and one revoked installation does not cost the
// other rows their reconcile.

/** Candidates examined per pass. Far above the realistic count of open,
 *  delivering pull requests quiet for the threshold, and still one host request
 *  per row at most — a few dozen requests every thirty minutes against a limit of
 *  thousands an hour per installation. */
export const PULL_REQUEST_RECONCILE_BATCH_SIZE = 50;

/** How long a row must have been quiet before the reconcile asks the host. Long
 *  enough that a delivery still in flight lands first and the reconcile finds
 *  nothing to do; short enough that a lost merge is repaired within the hour. */
export const PULL_REQUEST_RECONCILE_QUIET_MINUTES = 10;

/** How far back a MERGED row with no `merged_at` is still treated as a delivery
 *  that died half-way. A replay repairs one within the hour, so a week is ample;
 *  the bound exists to exclude rows mirrored before the column existed, and a card
 *  somebody deliberately re-opened long after its pull request merged. */
export const PULL_REQUEST_RECONCILE_MERGE_LOOKBACK_DAYS = 7;

export interface PullRequestReconcileSummary {
  /** Candidate rows the discovery read returned. */
  examined: number;
  /** Rows skipped with NO host call because every card they deliver is finished. */
  skippedNoLiveCard: number;
  /** Rows the host still reports open — stamped as heard-from, nothing replayed. */
  stillOpen: number;
  /** Rows the host reports closed, replayed through the delivery path. */
  replayed: number;
  /** Of `replayed`, how many moved a card (the sync reported a transition). */
  transitioned: number;
  /** Rows the host no longer has (404 / 410) — left as they are, and reported. */
  gone: number;
  /** Rows whose reconcile threw (token mint, host read, replay) — due again next pass. */
  failed: number;
  /**
   * Gates RAISED while repairing a card whose set the predicate says is wrong
   * (Story MOTIR-5652 · Subtask MOTIR-5671). Counted separately from `replayed`
   * because it is a different repair: a replay fixes a delivery nobody heard,
   * this fixes a card whose question is missing whatever the reason.
   */
  gatesRaised: number;
  /**
   * Cards PROMOTED to In Review because re-asking the host settled a check row
   * that had been recorded `pending` since a lost completion (MOTIR-5838).
   *
   * ⚠️ READ A NON-ZERO VALUE THE WAY `gatesRaised` ASKS TO BE READ: it counts
   * pull requests whose completion webhook never arrived. One is a lost
   * delivery repaired; a steady trickle is an ingestion defect, and the
   * ingestion is the bug to fix.
   */
  promoted: number;
  /**
   * Standing queue-failure exits whose check's conclusion Motir never received, now
   * READ from the host and recorded (§4 SIXTH AMENDMENT, point 4; MOTIR-6848). A
   * cancelled / timed-out one re-settles its card through `resettleStandingExit`.
   *
   * ⚠️ READ IT LIKE `promoted`: one is a lost `check_run` delivery repaired (or an exit
   * recorded before the conclusion was); a steady trickle is an ingestion defect.
   */
  queueExitsResolved: number;
  /**
   * Cards moved `in_progress → implemented` because their open, non-draft pull
   * request was re-synced (MOTIR-9455) — a card whose run never reported it, or
   * whose `opened` / `ready_for_review` delivery was lost or refused.
   *
   * ⚠️ READ IT LIKE `promoted`: one is a forgotten report repaired; a steady
   * trickle means runs keep forgetting to write `implemented`, and that is the
   * defect to fix.
   */
  implemented: number;
  /**
   * Cards at `in_progress` that re-sync LEFT where they are because the sync
   * refused the move — a container whose children have not all landed, a workflow
   * with no legal edge. A refusal, never a failure: the card is asked again next
   * pass, and no note is posted for it.
   */
  implementedRefused: number;
}

/** The sync outcomes that mean a card actually moved. */
const MOVED_OUTCOMES = new Set(['transitioned', 'session_closed', 'delivery_applied']);

export const pullRequestReconcileService = {
  /**
   * One reconcile pass. `now` is injectable so a test can place rows either side
   * of the quiet threshold without sleeping.
   */
  async reconcileOpenDeliveries(
    opts: { now?: Date; batchSize?: number } = {},
  ): Promise<PullRequestReconcileSummary> {
    const now = opts.now ?? new Date();
    const summary: PullRequestReconcileSummary = {
      examined: 0,
      skippedNoLiveCard: 0,
      stillOpen: 0,
      replayed: 0,
      transitioned: 0,
      gone: 0,
      failed: 0,
      gatesRaised: 0,
      promoted: 0,
      queueExitsResolved: 0,
      implemented: 0,
      implementedRefused: 0,
    };

    const candidates = await withSystemContext((tx) =>
      githubPullRequestRepository.listReconcileCandidates(
        {
          updatedBefore: new Date(now.getTime() - PULL_REQUEST_RECONCILE_QUIET_MINUTES * 60_000),
          mergedSince: new Date(
            now.getTime() - PULL_REQUEST_RECONCILE_MERGE_LOOKBACK_DAYS * 24 * 60 * 60_000,
          ),
          take: opts.batchSize ?? PULL_REQUEST_RECONCILE_BATCH_SIZE,
        },
        tx,
      ),
    );
    summary.examined = candidates.length;

    // One token per installation AND ROLE per pass. A mint that fails is remembered,
    // so the installation's other rows on the same App are counted as failed without
    // asking again.
    //
    // ⚠️ THE ROLE IS IN THE KEY, AND IT HAS TO BE (MOTIR-5843). Two repositories can
    // sit on ONE installation and differ in provenance — a hosted one mints through
    // the provisioning App, an imported one through the user-facing App — so a memo
    // keyed on `installationId` alone hands the second repository the first's token.
    // That was harmless only while this site passed no repository at all and every
    // mint here was wrong in the SAME direction; resolving provenance per repository
    // without widening the key would introduce a cross-repository credential leak
    // while fixing a refusal, which is the worse defect of the two.
    //
    // The key is the same pair `appAuth.mintInstallationToken` caches on one layer
    // down (`${role}:${installationId}`), because a token IS per installation per
    // App — so this memo has exactly the granularity of the thing it is memoising.
    const tokens = new Map<string, Promise<string>>();
    const hostOwners = await motirOwnedOrgLogins();
    const tokenFor = (installationId: string, owner: string): Promise<string> => {
      const role = githubAppRoleForRepo({ owner }, hostOwners);
      const key = `${role}:${installationId}`;
      let token = tokens.get(key);
      if (!token) {
        token = getGitProvider('github')
          .mintInstallationToken(installationId, { owner })
          .then((t) => t.token);
        tokens.set(key, token);
      }
      return token;
    };

    for (const candidate of candidates) {
      try {
        if (!(await deliversLiveCard(candidate))) {
          summary.skippedNoLiveCard += 1;
          continue;
        }

        const { repo } = candidate;
        const token = await tokenFor(repo.installation.installationId, repo.owner);
        const read = await readPullRequest(token, repo.owner, repo.name, candidate.number);

        if (read.kind === 'gone') {
          summary.gone += 1;
          console.warn(
            `[pullRequestReconcile] ${repo.owner}/${repo.name}#${candidate.number} is gone on the host ` +
              `(${read.status}); its row is left open and its card is not moved.`,
          );
          await markReconciled(candidate);
          continue;
        }

        if (read.pullRequest['state'] !== 'closed') {
          summary.stillOpen += 1;
          // THE MERGEABILITY BACKSTOP (MOTIR-5914, for bug MOTIR-5907). The read above
          // already carries the host's `mergeable` / `mergeable_state`, so this tick is
          // also the failure path of the base-branch re-read: a lost push delivery, a
          // failed enqueue, or a member GitHub had not computed within that job's waits
          // is settled here — BEFORE the promotion and the re-ask below, so a member
          // that now conflicts is neither promoted nor asked about. Not counted on the
          // summary: that is a memoized step result (`reconcile-open-deliveries-v5`), and
          // widening it would owe an id bump for a number nothing reads.
          await settleMergeability(candidate, read.pullRequest);
          // ⚠️ A QUEUE EXIT WHOSE CHECK'S END NOBODY HEARD (MOTIR-6848). Before the
          // promotion and the gate sweep, so a hung check's card re-asks in THIS pass.
          if (await resolveStandingQueueExit(candidate)) summary.queueExitsResolved += 1;
          // ⚠️ THE FIRST RUNG HAS NO OTHER BACKSTOP (MOTIR-9455), and it runs BEFORE the
          // promotion: the latch below moves only a card at `implemented`, so a card
          // this lifts is promoted — and asked about — in the same pass.
          const repair = await implementUnreportedCards(candidate, read.pullRequest);
          summary.implemented += repair.implemented;
          summary.implementedRefused += repair.refused;
          // ⚠️ STILL OPEN IS NOT NOTHING TO DO (Subtask MOTIR-5671). This sweep
          // exists as the backstop for a delivery nobody heard, and a LOST EVENT
          // costs a card its gate exactly as it costs it a merge: every raise in
          // the product hangs off a delivery, so a check-suite delivery that never
          // arrived leaves a green card with no question on it and nothing else
          // ever asks again.
          //
          // It is the SAME predicate and the SAME helper every trigger uses, so
          // this adds no rule of its own — it adds an occasion. And because
          // `reconcileGatesFor` only raises what is missing and never supersedes,
          // a sweep over a card that is already right writes nothing at all.
          //
          // ⚠️ AND A LOST CHECK-COMPLETION IS THE SAME SHAPE ONE LAYER DOWN
          // (MOTIR-5838), which is why the re-read runs FIRST. `reconcileGatesFor`
          // raises what a card's STATE says is owed, and a card stranded that way
          // has a state that is itself wrong: a `pending` row nothing will ever
          // refresh folds the pull request to `running`, so the card is not
          // promotable, no gate is OWED, and the gate sweep raises nothing —
          // correctly, and for ever. Re-asking the host is what makes the state
          // right, and doing it before the gate sweep is what lets the gate be
          // derived from the repaired state in THIS pass rather than the next one.
          summary.promoted += await promoteDeliveredCardsAfterReRead(candidate, now);
          summary.gatesRaised += await reconcileGatesForDeliveredCards(candidate);
          await markReconciled(candidate);
          continue;
        }

        const result = await githubWebhookService.handlePullRequest(
          replayedClosedDelivery(candidate, read.pullRequest),
        );
        summary.replayed += 1;
        if ('outcome' in result && MOVED_OUTCOMES.has(result.outcome)) summary.transitioned += 1;
        // A WARNING, not an info line: every replay means a delivery was lost, and
        // that is the signal worth finding in the logs.
        console.warn(
          `[pullRequestReconcile] replayed a missed close for ${repo.owner}/${repo.name}#${candidate.number}: ` +
            `${'outcome' in result ? result.outcome : result.event}`,
        );
      } catch (err) {
        summary.failed += 1;
        console.error(
          `[pullRequestReconcile] could not reconcile ${candidate.repo.owner}/${candidate.repo.name}` +
            `#${candidate.number}; it is due again next pass:`,
          err,
        );
      }
    }

    return summary;
  },
};

/**
 * Store the host's mergeability from a pull request this tick has just READ, and
 * withdraw the question over any card it now conflicts for (MOTIR-5914). A `null`
 * answer stores nothing — GitHub has not computed, and "not known" is never a conflict.
 */
async function settleMergeability(
  candidate: ReconcileCandidate,
  pull: Record<string, unknown>,
): Promise<void> {
  const mergeable = pull['mergeable'];
  const mergeableState = pull['mergeable_state'];
  const head = pull['head'];
  const headSha =
    head && typeof head === 'object' && typeof (head as Record<string, unknown>)['sha'] === 'string'
      ? ((head as Record<string, unknown>)['sha'] as string)
      : null;
  await pullRequestMergeabilityService.settleReading(candidate.repo.workspaceId, candidate.id, {
    mergeable: typeof mergeable === 'boolean' ? mergeable : null,
    mergeableState: typeof mergeableState === 'string' ? mergeableState : null,
    headSha,
  });
}

/**
 * Whether the pull request still delivers at least one card that could move — not
 * archived, and not in a done-category status of its own project's workflow.
 *
 * Read per WORKSPACE with the workspace bound, never under the bare system flag:
 * `work_item` and `workflow_status` carry no system arm, so an unbound read
 * returns nothing and every candidate would look finished. The delivery row
 * carries the workspace, which is the trusted source of the tenant.
 */
async function deliversLiveCard(candidate: ReconcileCandidate): Promise<boolean> {
  const byWorkspace = new Map<string, string[]>();
  for (const d of candidate.deliveries) {
    byWorkspace.set(d.workspaceId, [...(byWorkspace.get(d.workspaceId) ?? []), d.workItemId]);
  }

  for (const [workspaceId, workItemIds] of byWorkspace) {
    const live = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      const items = (await workItemRepository.findByIds(workItemIds, tx)).filter(
        (item) => item.archivedAt === null,
      );
      if (items.length === 0) return false;
      const terminal = await workflowsService.getTerminalStatusKeysByProjects(
        items.map((item) => item.projectId),
        workspaceId,
        tx,
      );
      return items.some((item) => !terminal.get(item.projectId)?.has(item.status));
    });
    if (live) return true;
  }
  return false;
}

/** The status a card is left at when nobody wrote `implemented` for it. */
const IN_PROGRESS_KEY = 'in_progress';

/**
 * Lift every LIVE card this open pull request delivers that still reads
 * `in_progress` to `implemented`, through the link-time resync (MOTIR-9455).
 *
 * ⚠️ IT ADDS AN OCCASION, NOT A TRANSITION PATH — the same rule the promotion
 * beside it follows. `resyncLinkedPullRequest` is the door `link_pull_request`
 * already runs: it synthesizes the open delivery from the stored row and hands it
 * to `syncChangeRequestStatus`, so the container-completeness gate, the plan hold,
 * the approval guard, the never-back-out-of-a-verdict rule and the revision and
 * `work-item/transitioned` event are all the delivery path's.
 *
 * ⚠️ DRAFT-NESS MUST BE KNOWN `false`, on the stored row AND on the host read this
 * pass just made. A draft is not offered for review, so it is not `implemented`;
 * a row that does not know (`null`) is declined by the resync itself, and a host
 * that now says draft means a `converted_to_draft` nobody heard — the stored
 * `false` is stale, and lifting the card on it would assert what the host has
 * retracted.
 *
 * ⚠️ ASKED ONLY WHEN A DELIVERED CARD READS `in_progress`. A pull request whose
 * cards are all past that rung needs nothing, and re-syncing it would only write
 * the row it already holds. When it does run, every card it delivers is decided
 * exactly as the lost delivery would have decided it.
 *
 * Idempotent: a card already at `implemented` reads `noop`, and one at In Review
 * is never moved back. A refused card (a container whose children have not all
 * landed) stays at `in_progress`, is counted, and is asked again next pass.
 */
async function implementUnreportedCards(
  candidate: ReconcileCandidate,
  pull: Record<string, unknown>,
): Promise<{ implemented: number; refused: number }> {
  const none = { implemented: 0, refused: 0 };
  if (candidate.draft !== false || pull['draft'] === true) return none;

  const stuck = await inProgressDeliveredCards(candidate);
  if (stuck.length === 0) return none;

  const result = await resyncLinkedPullRequest(candidate.id);
  if (!result) return none;

  const outcomes = perCardOutcomes(result);
  let implemented = 0;
  let refused = 0;
  for (const workItemId of stuck) {
    const outcome = outcomes.get(workItemId);
    if (outcome === undefined) continue;
    if (outcome === 'transitioned') implemented += 1;
    else refused += 1;
  }
  return { implemented, refused };
}

/** Each delivered card's own outcome — the list on a multi-card result, else the one card. */
function perCardOutcomes(
  result: ChangeRequestSyncResult,
): Map<string, ChangeRequestSyncResult['outcome']> {
  if (result.deliveredItems)
    return new Map(result.deliveredItems.map((d) => [d.workItemId, d.outcome]));
  return new Map(result.workItemId ? [[result.workItemId, result.outcome]] : []);
}

/**
 * The live cards this pull request delivers that read `in_progress`, read per
 * workspace with the workspace BOUND for the reason {@link deliversLiveCard} gives.
 */
async function inProgressDeliveredCards(candidate: ReconcileCandidate): Promise<string[]> {
  const byWorkspace = new Map<string, string[]>();
  for (const d of candidate.deliveries) {
    byWorkspace.set(d.workspaceId, [...(byWorkspace.get(d.workspaceId) ?? []), d.workItemId]);
  }

  const stuck: string[] = [];
  for (const [workspaceId, workItemIds] of byWorkspace) {
    const items = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      return workItemRepository.findByIds(workItemIds, tx);
    });
    for (const item of items) {
      if (item.archivedAt === null && item.status === IN_PROGRESS_KEY) stuck.push(item.id);
    }
  }
  return stuck;
}

/**
 * Re-derive the gate set of every card this pull request delivers, per workspace and
 * with the workspace BOUND — never under the bare system flag, for the reason
 * {@link deliversLiveCard} gives: `work_item` carries no system arm, so an unbound
 * read returns nothing and every card would look like it had no gates owed.
 *
 * Each card takes the funnel's lock order — its awaiting gates, then the card — so a
 * sweep and a press never contend in opposite directions.
 *
 * ⚠️ IT IS A BACKSTOP, AND NOTHING MAY BE DESIGNED TO RELY ON IT. A thirty-minute
 * repair is the right cost for a rare lost event and the wrong mechanism for the
 * normal path: **a card that routinely needs this sweep to get its gate means a
 * TRIGGER IS MISSING, and the trigger is the bug to fix.** This warning is here
 * rather than only in a pull request because a backstop that works is invisible,
 * and an invisible repair is exactly how a missing trigger survives — cards keep
 * getting their gates, half an hour late, and nobody asks why the fast path did
 * not fire. If `gatesRaised` is routinely non-zero, read it as a defect report.
 *
 * ⚠️ A PER-CARD FAILURE IS COUNTED, NEVER THROWN, matching what the sweep already
 * does per ROW: one card whose reconcile fails must not cost the other cards of
 * the same pull request their repair, nor the rest of the pass.
 */
async function reconcileGatesForDeliveredCards(candidate: ReconcileCandidate): Promise<number> {
  const byWorkspace = new Map<string, string[]>();
  for (const d of candidate.deliveries) {
    byWorkspace.set(d.workspaceId, [...(byWorkspace.get(d.workspaceId) ?? []), d.workItemId]);
  }

  let raised = 0;
  for (const [workspaceId, workItemIds] of byWorkspace) {
    raised += await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      let count = 0;
      for (const workItemId of workItemIds) {
        try {
          await approvalGateRepository.lockAwaitingByWorkItem(workItemId, tx);
          await workItemRepository.lockById(workItemId, tx);
          const item = await workItemRepository.findById(workItemId, tx);
          if (item) count += (await reconcileGatesFor(item, tx)).length;
        } catch (err) {
          console.error('[pullRequestReconcile] could not re-derive a card’s gates', {
            workItemId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return count;
    });
  }
  return raised;
}

/**
 * Re-ask the host about this pull request's check set and promote any card the
 * repaired verdict makes reviewable (MOTIR-5838).
 *
 * ⚠️ IT ADDS AN OCCASION, NOT A PROMOTION PATH. The whole body of it is
 * `promoteIfCiAlreadyGreen` — the SAME edge-2 latch a card arriving at
 * `implemented` fires, with the same host re-read, the same `isPromotable` and
 * the same gate raise inside the same transaction. That is deliberate and is
 * the reason this sweep can be trusted: a card promoted here took exactly the
 * route it would have taken had the delivery arrived, so there is no second
 * answer to drift from the first. The latch is a no-op for a card that is not
 * at `implemented`, so no filter of its own is owed here.
 *
 * The ACTOR is the workspace's stand-in Manager, which is what the CI-feedback
 * path already resolves for a promotion nobody is standing behind
 * (`workspaceMembershipRepository.findStandInManagerByWorkspace`). A workspace
 * with no Manager promotes nothing rather than guessing at an identity.
 *
 * ⚠️ A PER-CARD FAILURE IS COUNTED, NEVER THROWN — the same rule the gate sweep
 * beside it follows, for the same reason: one card must not cost the other
 * cards of the same pull request their repair, nor the rest of the pass.
 */
async function promoteDeliveredCardsAfterReRead(
  candidate: ReconcileCandidate,
  now: Date,
): Promise<number> {
  const byWorkspace = new Map<string, string[]>();
  for (const d of candidate.deliveries) {
    byWorkspace.set(d.workspaceId, [...(byWorkspace.get(d.workspaceId) ?? []), d.workItemId]);
  }

  let promoted = 0;
  for (const [workspaceId, workItemIds] of byWorkspace) {
    const owner = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      return workspaceMembershipRepository.findStandInManagerByWorkspace(workspaceId, tx);
    });
    if (!owner) continue;

    for (const workItemId of workItemIds) {
      try {
        const moved = await promoteIfCiAlreadyGreen(
          workItemId,
          { userId: owner.userId, workspaceId },
          readReportedCheckSet,
          now,
        );
        if (moved) promoted += 1;
      } catch (err) {
        console.error('[pullRequestReconcile] could not re-read a card’s check set', {
          workItemId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return promoted;
}

/** The reasons whose exit is judged by its check's conclusion (§4 SIXTH AMENDMENT). */
const CHECK_JUDGED_REASONS = new Set(['CI_FAILURE', 'CI_TIMEOUT']);

/**
 * Which of a merge-group commit's reported runs is the exit's failing check. The one
 * the exit already NAMES, when it names one; otherwise a GENUINE failure outranks a
 * cancelled / timed-out one (the imprecision the SIXTH AMENDMENT accepts runs the
 * other way only when the webhook ordered it), and a run that did not fail is never it.
 */
export function pickFailingCheck(
  runs: readonly ReportedCheckRun[],
  namedCheck: string | null,
): ReportedCheckRun | null {
  const failed = runs.filter((run) => run.conclusion === 'failure' && run.rawConclusion !== null);
  const latestFirst = [...failed].sort(
    (a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
  );
  if (namedCheck !== null) return latestFirst.find((run) => run.checkName === namedCheck) ?? null;
  const genuine = latestFirst.find((run) => !HUNG_CHECK_CONCLUSIONS.includes(run.rawConclusion!));
  return genuine ?? latestFirst[0] ?? null;
}

/**
 * READ THE CONCLUSION OF A STANDING QUEUE EXIT'S CHECK FROM THE HOST, record it, and
 * re-settle the exit (§4 SIXTH AMENDMENT, point 4; MOTIR-6848). The backstop for a
 * `check_run` delivery that was lost, a check that completed before its attempt row
 * existed, and every exit recorded before the conclusion was.
 *
 * It asks the host only for an exit that still STANDS at the pull request's head, is a
 * `CI_FAILURE` / `CI_TIMEOUT`, has no conclusion, and has a queue attempt naming the
 * merge-group commit — so once a conclusion is recorded the row never matches again,
 * and a moved head or a requeue costs no host call. A `null` answer ("no answer") records
 * nothing: the row is simply asked again next pass. The move is
 * `resettleStandingExit`'s; nothing here moves a card itself.
 */
async function resolveStandingQueueExit(candidate: ReconcileCandidate): Promise<boolean> {
  const workspaceId = candidate.repo.workspaceId;
  const target = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    const exit = (
      await githubPullRequestQueueExitRepository.findLatestByPullRequests([candidate.id], tx)
    ).get(candidate.id);
    if (!exit || !CHECK_JUDGED_REASONS.has(exit.rawReason)) return null;
    if (exit.failingCheckConclusion !== null) return null;
    const pr = (await githubPullRequestRepository.findManyByIdsForSummary([candidate.id], tx)).get(
      candidate.id,
    );
    const head = pr ? (pullRequestHead(pr) ?? undefined) : undefined;
    if (!queueExitStandsAtHead(exit, head)) return null;
    const attempt = await githubMergeQueueAttemptRepository.findLatestByPullRequest(
      candidate.id,
      tx,
    );
    if (!attempt || attempt.createdAt > exit.exitedAt) return null;
    return { exit, attempt };
  });
  if (!target) return false;

  // Check runs alone: a suite roll-up is never the exit's failing check.
  const runs = await readReportedCheckRuns({
    installationId: candidate.repo.installation.installationId,
    owner: candidate.repo.owner,
    name: candidate.repo.name,
    commitSha: target.attempt.headSha,
  });
  if (runs === null) return false;
  const check = pickFailingCheck(runs, target.exit.failingCheckName);
  if (!check) return false;
  const conclusion = check.rawConclusion!;

  const resettled = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    if (target.exit.failingCheckName === null) {
      const named = {
        name: check.checkName,
        url: check.url ?? '',
        conclusion,
      };
      await githubMergeQueueAttemptRepository.setFailingCheckIfUnset(
        target.attempt.id,
        { ...named, at: check.completedAt ?? new Date() },
        tx,
      );
      await githubPullRequestQueueExitRepository.setFailingCheckIfUnset(target.exit.id, named, tx);
    } else {
      const named = { name: check.checkName, conclusion };
      await githubMergeQueueAttemptRepository.setConclusionIfUnset(target.attempt.id, named, tx);
      await githubPullRequestQueueExitRepository.setConclusionIfUnset(target.exit.id, named, tx);
    }
    return resettleStandingExit({ pullRequestId: candidate.id, workspaceId, tx });
  });
  // Post-commit, never inside the transaction — a rollback must not have notified.
  for (const m of resettled.moved) {
    await sendEvent('work-item/transitioned', {
      workspaceId,
      workItemId: m.id,
      actorId: resettled.actorId!,
      fromStatusKey: m.from,
      toStatusKey: m.to,
      revisionId: m.revisionId,
    });
  }
  return true;
}

/** Stamp the row as heard-from, under the tenant the sync itself writes it under. */
async function markReconciled(candidate: ReconcileCandidate): Promise<void> {
  await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, candidate.repo.workspaceId);
    await githubPullRequestRepository.markReconciled(candidate.id, tx);
  });
}

/**
 * The `pull_request` delivery GitHub would have sent for this close.
 *
 * The single-PR read returns the same `pull_request` object a delivery carries, so
 * it is passed through verbatim; the envelope supplies the two fields a delivery
 * adds around it — the action and the installation — and the repository id, taken
 * from the MIRROR row rather than the payload so the replay resolves to exactly the
 * repository the candidate was discovered under.
 */
export function replayedClosedDelivery(
  candidate: ReconcileCandidate,
  pullRequest: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action: 'closed',
    installation: { id: candidate.repo.installation.installationId },
    repository: { id: candidate.repo.repoId },
    pull_request: pullRequest,
  };
}
