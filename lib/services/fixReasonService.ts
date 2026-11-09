import { createHash } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import {
  readAnsweredReviewRefusal,
  readStandingReviewRefusal,
} from '@/lib/approvalGates/reviewRefusal';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import {
  hasHeadDecidedBeforeRunningChecks,
  isCiUndecidedAtHead,
  lastDecidedBeforeHead,
  pullRequestHead,
} from '@/lib/github/pullRequestHead';
import { mergeabilityAnsweredByHead } from '@/lib/github/mergeability';
import { toFixDetailDto } from '@/lib/mappers/fixReasonMappers';
import { toWorkflowStatusDto } from '@/lib/mappers/workflowMappers';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import {
  workItemDeliveryRepository,
  type WorkItemDeliveryWithChecks,
} from '@/lib/repositories/workItemDeliveryRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { isRunAlive } from '@/lib/runs/runLiveness';
import { evaluateRepair } from '@/lib/services/repairPredicate';
import {
  describeDeadRunWithin,
  evaluateContinueWithin,
} from '@/lib/services/workItemContinueService';
import {
  NOTHING_TO_FIX,
  PULL_REQUEST_GROUP_PREFIX,
  REVIEW_AGENT_REVIEWER_NAME,
  answeredPullRequestReasonOf,
  cardFixGroupKey,
  changesRequestedOf,
  deadRunReasonOf,
  fixingReasonOf,
  fixingWhileRepairing,
  priorWhileRepairing,
  pullRequestReasonOf,
  raisedHeadsOf,
  reviewerNameOf,
  runFixGroupKey,
  sameFixReason,
  withFixGroupKey,
  withRaisedHeads,
  type AnsweredMember,
  type FixReasonValue,
  type RunningHead,
} from '@/lib/workItems/fixReason';
import { queueFailureAnsweredByHead } from '@/lib/workItems/deliverySet';

// WHY A CARD IS STUCK UNTIL SOMETHING IS REPAIRED, STORED (Story MOTIR-6588 ·
// MOTIR-6600) — `WorkItem.fixReason` + `WorkItem.fixDetail`, the column the
// Workbench's To fix tab lists, pages and counts by.
//
// ── One rule, read THROUGH the command's own predicate ──────────────────────
// The tab's promise is that it lists exactly the cards `motir fix` would claim, plus
// the ones a reviewer sent back. So the pull-request half is `evaluateRepair` — the
// predicate the claim and the Development block already decide by — and nothing here
// restates a single one of its rules: an `ok` evaluation is classed by the members IT
// handed over, and a refusal is not a pull-request reason whatever the members look
// like. The one reason the predicate cannot see is a reviewer's Request changes on the
// approve-to-merge gate, which MOVES NOTHING (`approval-gates.md`'s kind table): the
// card waits at In Review with no awaiting gate, and without this column nothing
// anywhere says so.
//
// ── A dead run is read THROUGH `motir continue`'s predicate, the same way ─────
// `run_died` (MOTIR-6880) ranks first and is asked first: `evaluateContinueWithin` is
// the continue claim's own evaluation, so the tab never lists a card the claim would
// refuse as `run_alive` or `no_dead_run`, and `isRunAlive`, the died set and the
// refusal ladder are never restated here. A `use_fix` or `not_in_progress` verdict is
// not this reason, and the pull-request derivation below answers exactly as before.
//
// ── FIXING reads the card's OWN previous answer (Story MOTIR-10305 · MOTIR-10307) ──
// Every pull-request reason and changes-requested stored here records the heads it was
// raised on (`fixDetail.raisedHeads`). When the predicate later refuses the card with
// nothing red — `ci_running` or `not_failing` — and a member whose CI has not decided
// (running, or no check yet at a head the host has announced; MOTIR-10310) is at a head
// other than the recorded one, a fix was pushed: the
// derivation returns the PRIOR stored reason unchanged with `fixing: true`, so the card
// stays on To fix and its count does not move until the CI decides. Green then clears it,
// red raises a fresh reason on the new heads. The prior is read from the row the caller
// passes — the recompute's locked row, so it is consistent with the write it decides.
// ⚠️ A REVIEW REFUSAL DOES NOT DEPEND ON THAT ROW (Bug MOTIR-10733). A push's checks arrive
// one webhook at a time and in no order, so a quick success at the new head can be recorded
// before anything running there: that recompute reads green, stores nothing to fix, and the
// prior is gone. The refusal the push answered is still in its own rows
// (`readAnsweredReviewRefusal`), so the next recompute that sees CI running at a moved head
// raises it again as Fixing — through the same moved-head rule. Every PULL-REQUEST reason is
// read the same way: a red build from the failed check rows at a running member's last
// decided commit before its head (Bug MOTIR-10747, `lastDecidedBeforeHead`), a queue failure
// from its exit row at that commit, and a conflict or an out-of-date base from the
// mergeability reading the push replaced, which the writers carry (Bug MOTIR-10791,
// `mergeabilityAnsweredByHead`).
//
// ── …and a LIVE REPAIR is Fixing from its first second (MOTIR-10506) ────────────
// A `fix` run alive on the card — a claimed `motir fix`, a hosted or agent repair, read
// through `isRunAlive`, the one liveness rule — stores whatever reason the card holds
// with `fixing: true` (`fixingWhileRepairing`), so every surface that draws the tag
// shows it the moment the repair is claimed, not once its push reaches CI. While CI is
// running and nothing is red, the live run keeps the prior answer Fixing even at an
// unmoved head (`priorWhileRepairing`). The moved-head rule above is the RECONCILE: it
// holds Fixing between the run's close and CI's verdict, and sets it for a push no
// tracked run made. A run's open and close recompute every card it covers
// (`dispatchRunService.recomputeCovered`), which is what moves the tag at those moments.
// Which LINE a surface draws over the tag — the hosted repair's, a holder's — is still
// the surface's call.
//
// ── The shape is `recomputeWorkItemCiState`'s ───────────────────────────────
// A read-derived write, so the card's row lock is taken FIRST and everything is read
// under it: two events racing on one card serialise, and the last to commit is the
// one that read the most. Idempotent — an unchanged answer writes nothing — and it
// emits no event. It runs INSIDE the caller's transaction and bound tenant context;
// `work_item` has no system arm.

/**
 * The ENTRY key of a pull-request set (MOTIR-7589; `design/workbench/design-notes.md`
 * § 34.2) — a hash of its OPEN members' ids, sorted, so every card those same pull
 * requests deliver computes the same key without reading one another. A card with no
 * open member has no set to share and stands alone.
 */
export function pullRequestFixGroupKey(
  workItemId: string,
  openPullRequestIds: readonly string[],
): string {
  if (openPullRequestIds.length === 0) return cardFixGroupKey(workItemId);
  const digest = createHash('sha256')
    .update([...openPullRequestIds].sort().join(','))
    .digest('hex')
    .slice(0, 24);
  return `${PULL_REQUEST_GROUP_PREFIX}${digest}`;
}

/** The reviewer's display name — the live user row first (`reviewerNameOf`). */
async function reviewerName(
  decidedById: string | null,
  decidedByLabel: string | null,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  const user = decidedById ? await userRepository.findById(decidedById, tx) : null;
  return reviewerNameOf(user, decidedByLabel);
}

/**
 * The pull-request reason the RUNNING members' push answered, rebuilt from durable rows
 * (`answeredPullRequestReasonOf`), or null when none answered one (Bugs MOTIR-10747 ·
 * MOTIR-10791). Per running member: its latest queue exit, if it was a failure at the last
 * commit CI decided on before the head; the carried conflict or out-of-date reading about an
 * earlier head; and the red build at that last decided commit. A member whose head CI had
 * already decided before the checks running there now answers nothing.
 */
async function answeredReasonOf(
  open: readonly WorkItemDeliveryWithChecks[],
  running: readonly RunningHead[],
  heads: Record<string, string>,
  total: number,
  tx: Prisma.TransactionClient,
): Promise<FixReasonValue | null> {
  const runningIds = new Set(running.map((m) => m.pullRequestId));
  // ⚠️ ONLY A HEAD CI HAS NOT YET DECIDED answers anything (review of MOTIR-10791): a head
  // the host confirmed decided (MOTIR-10797), a re-run there, or a check that started after
  // the head's verdict, answers the head's own verdict.
  // Without this guard the carried conflict reading, which stands until the next push, would
  // re-raise a conflict the head had already resolved as Fixing on every such recompute.
  const members = open.filter(
    (d) => runningIds.has(d.pullRequest.id) && !hasHeadDecidedBeforeRunningChecks(d.pullRequest),
  );
  const exits = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
    members.map((d) => d.pullRequest.id),
    tx,
  );
  const answered: AnsweredMember[] = members.map(({ pullRequest: pr }) => {
    const before = lastDecidedBeforeHead(pr);
    const exit = exits.get(pr.id);
    return {
      pullRequestId: pr.id,
      baseRef: pr.baseRef,
      queueFailure:
        exit && queueFailureAnsweredByHead(exit, pullRequestHead(pr), before?.commitSha)
          ? {
              headSha: exit.headSha,
              failingCheckName: exit.failingCheckName,
              rawReason: exit.rawReason,
            }
          : null,
      blockedReading: mergeabilityAnsweredByHead(pr),
      red: before?.red
        ? { commitSha: before.commitSha, failingChecks: before.failingChecks }
        : null,
    };
  });
  return answeredPullRequestReasonOf(answered, heads, total);
}

/**
 * What the card's to-fix answer is NOW, read inside `tx` without writing it. The
 * caller holds the card's row lock (the recompute below takes it).
 *
 * `null` for a card outside the `in_progress` status CATEGORY or archived: a card
 * that has not started or has finished is not waiting on a repair, whatever its pull
 * requests say.
 */
export async function deriveFixReason(
  item: {
    id: string;
    identifier: string;
    projectId: string;
    workspaceId: string;
    status: string;
    archivedAt: Date | null;
    targetRepos: readonly string[];
    /** The card's PRIOR stored answer — what the Fixing rule keeps (MOTIR-10307). */
    fixReason: string | null;
    fixDetail: unknown;
  },
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<FixReasonValue> {
  if (item.archivedAt !== null) return NOTHING_TO_FIX;
  const statuses = (
    await workflowsRepository.findStatuses(item.projectId, item.workspaceId, tx)
  ).map(toWorkflowStatusDto);
  if (statuses.find((s) => s.key === item.status)?.category !== 'in_progress') {
    return NOTHING_TO_FIX;
  }

  // FIRST: a run that died. Nothing else on the card is repairable until somebody owns
  // its branch again, so it outranks every pull-request reason (`FIX_REASON_PRIORITY`).
  const continued = await evaluateContinueWithin(item, statuses, now, tx);
  if (continued.kind === 'died') {
    const { deadRun, reason } = await describeDeadRunWithin(continued.run, tx);
    const died = deadRunReasonOf({
      key: item.identifier,
      refusal: continued.refusal,
      parentKey: continued.parentKey,
      branch: continued.branch,
      branches: continued.branches,
      lastHeardAt: deadRun.lastHeardAt,
      ranByName: deadRun.dispatcher?.name ?? null,
      diedReason: reason,
    });
    // ONE ENTRY PER DEAD RUN (§ 34.2): the story and every leg the run carried share it.
    if (died) return withFixGroupKey(died, runFixGroupKey(continued.run.id));
  }

  const [verdict, deliveries, repairs] = await Promise.all([
    evaluateRepair(item, statuses, { workspaceId: item.workspaceId }, tx),
    workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
    dispatchRunRepository.findRunningLivenessByCommandForWorkItem(item.id, 'fix', tx),
  ]);
  // A REPAIR IS LIVE on the card (MOTIR-10506): an open `fix` run the liveness rule still
  // reads as alive. A lapsed local run the reap has not closed yet is not one.
  const repairing = repairs.some((run) => isRunAlive(run, now));
  const settled = (value: FixReasonValue): FixReasonValue =>
    repairing ? fixingWhileRepairing(value) : value;
  // The predicate's own notion of an open member, so `total` counts what it counted.
  const open = deliveries.filter((d) => d.pullRequest.state === 'open' && !d.pullRequest.merged);
  const total = open.length;
  // ONE ENTRY PER PULL-REQUEST SET (§ 34.2): every card these open pull requests deliver,
  // stuck for a reason one push to them clears.
  const setKey = pullRequestFixGroupKey(
    item.id,
    open.map((d) => d.pullRequest.id),
  );
  // The heads every reason below is RAISED on — what a later push is measured against.
  // ⚠️ A member whose CI has NOT DECIDED (running, or no row at its head yet) keeps the
  // head the standing reason recorded for it
  // (MOTIR-10310): with two pull requests red, a push to one leaves the card red on the
  // other, and re-stamping the pushed one's new head here would make that push read as
  // "no push" once its sibling turns green. Only a member that has reported raises its
  // own current head; a running one was not part of what went wrong at its new commit.
  const priorDetail = toFixDetailDto(
    (item.fixReason ?? null) as WorkItemFixReasonDto | null,
    item.fixDetail,
  );
  const priorHeads = item.fixReason === 'run_died' ? null : (priorDetail?.raisedHeads ?? null);
  const heads = raisedHeadsOf(
    open.map((d) => {
      const kept = isCiUndecidedAtHead(d.pullRequest) ? priorHeads?.[d.pullRequest.id] : undefined;
      return { pullRequestId: d.pullRequest.id, headSha: kept ?? pullRequestHead(d.pullRequest) };
    }),
  );
  const raised = (value: FixReasonValue): FixReasonValue => settled(withRaisedHeads(value, heads));

  if (verdict.ok) {
    // A claimable card is classed by the members the predicate handed over. On the
    // `ci` class every one of them is failing, so a reason always results; on an
    // `acceptance_rerun` they are every open member, and when none is red the reason
    // is the reviewer's refusal the class exists for.
    const byMembers = pullRequestReasonOf(verdict.pullRequests, total);
    if (byMembers) return raised(withFixGroupKey(byMembers, setKey));
    if (verdict.repairClass === 'acceptance_rerun' && verdict.acceptanceRefusal) {
      // The standing refusal the class was admitted on is the story's latest DECIDED
      // acceptance gate (`readStandingAcceptanceRefusal`) — read for WHO decided it.
      const gate = await approvalGateRepository.findLatestDecidedByWorkItemAndKind(
        item.id,
        'acceptance_result',
        tx,
      );
      // An acceptance Re-run is the story's own (§ 34.2): a card alone.
      return raised(
        withFixGroupKey(
          changesRequestedOf(
            {
              gate: 'acceptance_result',
              reviewerName: await reviewerName(
                gate?.decidedById ?? null,
                verdict.acceptanceRefusal.decidedByLabel,
                tx,
              ),
              noteMd: verdict.acceptanceRefusal.reasonMd,
            },
            total,
          ),
          cardFixGroupKey(item.id),
        ),
      );
    }
    if (verdict.repairClass === 'review' && verdict.reviewRefusal) {
      // A card a REVIEW sent back (MOTIR-6822): the predicate read the standing refusal
      // and named its reviewer — the review agent as the agent (§12.3), a person by their
      // live name — so the row names exactly who the claim's prompt names.
      return raised(
        withFixGroupKey(
          changesRequestedOf(
            {
              gate: verdict.reviewRefusal.gate,
              reviewerName: verdict.reviewRefusal.reviewerName,
              noteMd: verdict.reviewRefusal.findingsMd,
            },
            total,
          ),
          setKey,
        ),
      );
    }
    /* v8 ignore next 2 -- NO PRODUCER: an `ok` evaluation of the `ci` class hands over
       only failing members, and `acceptance_rerun` / `review` always carry their refusal. */
    return NOTHING_TO_FIX;
  }

  // FIXING (MOTIR-10307). The predicate hands over `running` — the members CI has not
  // decided on — exactly on the refusals that mean nothing is red: `ci_running` and
  // `not_failing` (a card sent back at In Review whose push moved its head lands on the
  // latter, and so does a push announced before its first check reports, MOTIR-10310).
  // Whether a fix was pushed is the PRIOR stored answer's recorded heads against the heads
  // CI now runs on: the rule is `fixingReasonOf`'s.
  if (verdict.running.length > 0) {
    const fixing = fixingReasonOf(
      {
        fixReason: (item.fixReason ?? null) as WorkItemFixReasonDto | null,
        fixDetail: priorDetail,
      },
      verdict.running,
    );
    if (fixing) return fixing;
    // The run itself is the evidence while it is live: no moved head is needed.
    if (repairing) {
      const kept = priorWhileRepairing({
        fixReason: (item.fixReason ?? null) as WorkItemFixReasonDto | null,
        fixDetail: priorDetail,
      });
      if (kept) return kept;
    }
    // …and when the stored prior is GONE, what a push answered is read from durable rows
    // (Bugs MOTIR-10747 · MOTIR-10791): a quick success at the new head, recorded before
    // anything running there, read the head green and stored nothing to fix. Each running
    // member's history says what its push answered — a queue failure, a conflict or an
    // out-of-date base, a red build — and the reason is rebuilt as it was raised and put
    // through the same moved-head rule. Only a GONE prior is rebuilt — a stored answer the
    // rule declined (a re-run at its own head, a row from before heads were recorded) is the
    // card's word and is kept as such. It is asked before the review's refusal because every
    // pull-request reason outranks `changes_requested` (`FIX_REASON_PRIORITY`).
    if (item.fixReason === null) {
      const answered = await answeredReasonOf(open, verdict.running, heads, total, tx);
      const refixing =
        answered && fixingReasonOf(withFixGroupKey(answered, setKey), verdict.running);
      if (refixing) return refixing;
    }
    // …and when the stored prior is GONE, the refusal a push answered is read from its own
    // rows (Bug MOTIR-10733): a recompute that saw the new head green on a partial set of
    // checks stored nothing to fix, and the Fixing rule had no prior left to keep. The
    // answer is the one the refusal raised — its gate, reviewer, findings and the heads it
    // was about — put through the same moved-head rule, so a re-run at the reviewed head is
    // still never Fixing.
    const answered = await readAnsweredReviewRefusal(item.id, deliveries, tx);
    if (answered) {
      const byAgent = answered.kind === 'agent_review';
      const asRaised = withRaisedHeads(
        withFixGroupKey(
          changesRequestedOf(
            {
              gate: answered.kind,
              reviewerName: byAgent
                ? REVIEW_AGENT_REVIEWER_NAME
                : await reviewerName(answered.decidedById, answered.decidedByLabel, tx),
              noteMd: answered.noteMd,
            },
            total,
          ),
          setKey,
        ),
        answered.raisedHeads,
      );
      const refixing = fixingReasonOf(asRaised, verdict.running);
      if (refixing) return refixing;
    }
  }

  // Not claimable. The one reason left is a reviewer's standing Request changes on a card
  // the `review` class does not admit — a rung other than Implemented / In Review, or a
  // set with no open member. The rule is the class's own (`readStandingReviewRefusal`).
  const latest = await readStandingReviewRefusal(item.id, deliveries, tx);
  if (latest) {
    // The review AGENT's refusal names the agent, never the run's attributed user (§12.3):
    // the row must not read as a person having reviewed the code.
    const byAgent = latest.kind === 'agent_review';
    return raised(
      withFixGroupKey(
        changesRequestedOf(
          {
            gate: byAgent ? 'agent_review' : 'pull_request_approval',
            reviewerName: byAgent
              ? REVIEW_AGENT_REVIEWER_NAME
              : await reviewerName(latest.decidedById, latest.decidedByLabel, tx),
            noteMd: latest.noteMd,
          },
          total,
        ),
        setKey,
      ),
    );
  }
  return NOTHING_TO_FIX;
}

/**
 * RECOMPUTE one card's stored `fixReason` / `fixDetail`, and write them if they moved.
 *
 * Called by every writer that can change the answer (MOTIR-6602) and by the backfill
 * (MOTIR-6603), inside the writer's own transaction. Returns what it settled on, which
 * is also what is stored.
 */
export async function recomputeWorkItemFixReason(
  workItemId: string,
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<FixReasonValue> {
  const locked = await workItemRepository.lockById(workItemId, tx);
  if (!locked) return NOTHING_TO_FIX;
  const item = await workItemRepository.findById(workItemId, tx);
  /* v8 ignore next -- a granted lock on an immutable id implies a readable row
     (`recomputeWorkItemCiState` records why); the read is nullable, so it is guarded. */
  if (!item) return NOTHING_TO_FIX;

  const next = await deriveFixReason(item, tx, now);
  if (!sameFixReason(item, next)) {
    await workItemRepository.updateFixReason(workItemId, next, tx);
  }
  return next;
}
