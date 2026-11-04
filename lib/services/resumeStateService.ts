import type {
  ApprovalGateKind,
  ApprovalGateState,
  Prisma,
  WorkItemResumeState,
} from '@/generated/prisma/client';
import { toWorkflowStatusDto } from '@/lib/mappers/workflowMappers';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { collectDeliveries } from '@/lib/services/deliveryVerdict';
import { dispatchRunHeldGateRepository } from '@/lib/repositories/dispatchRunHeldGateRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { ladderKeysFrom, RUNG_RANK, rankOfStatus } from '@/lib/workItems/statusLadder';
import {
  advanceResumeCiSnapshot,
  sameResumeCiSnapshot,
  takeResumeCiSnapshot,
  toResumeCiSnapshot,
  type ResumeCiSnapshot,
} from '@/lib/workItems/resumeCi';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// WHETHER A CARD WAITS TO RESUME, STORED (Story MOTIR-7701 · MOTIR-7707) —
// `WorkItem.resumeState` + `WorkItem.resumeRunId`, the column the Workbench's To
// resume tab lists, pages and counts by.
//
// ── A sibling of `fixReason`, never a sixth value of it ─────────────────────
// To fix means *a repair would claim this card*. A run that stopped because its
// remaining work waits on a person's approval is not broken, and nothing repairs
// it: the approval releases it. So it is its own column, carved out of In progress
// the way `fixReason` is, and To fix wins on the rare card where both hold.
//
// ── A function of runs, gates and the delivery set's CI ─────────────────────
// The card's LATEST run (the continue claim's own read, `findLatestForWorkItem`)
// decides it: a run that closed `gated` makes the card wait; anything newer — a
// continue, a fresh run, a run that died — takes it off, and a died run is To fix's
// `run_died`, unchanged. While it waits, the run's held gates (MOTIR-7703) say
// which way: `ready_to_resume` once one of them is approved, else
// `waiting_on_gate`. Each held gate is read as the LATEST gate of its kind on its
// card, so a design republished after the run stopped (its first gate superseded)
// is answered by the version a person actually decided.
//
// Two facts outside the run take a card off as well: an open delivery at Implemented /
// In Review / Approved (MOTIR-8611, below), and CI that STARTED on the card's delivery set
// after the gated run ended (Story MOTIR-10305 · MOTIR-10308) — somebody pushed, so the
// card is moving again and belongs to In progress, not to a resume nobody needs. That
// second fact is why the CI handlers (`changeRequestCiFeedback`) recompute this column.
//
// ── The shape is `recomputeWorkItemFixReason`'s ─────────────────────────────
// A read-derived write under the card's row lock, idempotent (an unchanged answer
// writes nothing), inside the caller's transaction.

/** What `WorkItem.resumeState` / `resumeRunId` hold together. */
export interface ResumeStateValue {
  resumeState: WorkItemResumeState | null;
  resumeRunId: string | null;
}

export const NOTHING_TO_RESUME: ResumeStateValue = { resumeState: null, resumeRunId: null };

/**
 * What the card's To resume answer is NOW, read inside `tx` without writing it.
 * `null` state for a card outside the `in_progress` status CATEGORY, archived, or already
 * delivered (Implemented / In Review / Approved with an open pull request).
 */
export async function deriveResumeState(
  item: ResumeStateItem,
  tx: Prisma.TransactionClient,
): Promise<ResumeStateValue> {
  return (await deriveResumeAnswer(item, tx)).value;
}

/** What the To resume derivation reads of a card. */
export interface ResumeStateItem {
  id: string;
  projectId: string;
  workspaceId: string;
  status: string;
  archivedAt: Date | null;
  /** For the delivery set's session-branch arm (`collectDeliveries`). */
  sessionBranch: string | null;
  /** The gated run's stored snapshot of the delivery set (MOTIR-10308). */
  resumeDetail?: unknown;
}

/**
 * The answer and the snapshot it was read against — what the recompute stores. `snapshot`
 * is `undefined` on every exit before the gated run is read: the stored one is LEFT as it
 * is, so a card that moved again stays off To resume through a status move and back.
 */
interface ResumeAnswer {
  value: ResumeStateValue;
  snapshot?: ResumeCiSnapshot | null;
}

const NO_ANSWER: ResumeAnswer = { value: NOTHING_TO_RESUME };

async function deriveResumeAnswer(
  item: ResumeStateItem,
  tx: Prisma.TransactionClient,
): Promise<ResumeAnswer> {
  if (item.archivedAt !== null) return NO_ANSWER;
  const statuses = (
    await workflowsRepository.findStatuses(item.projectId, item.workspaceId, tx)
  ).map(toWorkflowStatusDto);
  if (statuses.find((s) => s.key === item.status)?.category !== 'in_progress') {
    return NO_ANSWER;
  }
  // ⚠️ DELIVERED IS NOT PARKED (MOTIR-8611). Implemented / In Review / Approved share the
  // `in_progress` CATEGORY, but a card there WITH AN OPEN PULL REQUEST is CI's to move from
  // here — the continue claim answers it `use_fix` before it ever reads the gated run. So a
  // gated run left behind the card (the work landed some other way: a later build, a hand
  // move) is no longer something to resume, and listing it offers a resume the claim refuses.
  // The open delivery is half the test: a design card's own publish walks it to In Review
  // with NO pull request (`moveToReviewWhenUndelivered`), and that card still waits on its
  // gate.
  const rank = rankOfStatus(item.status, statuses, ladderKeysFrom(statuses));
  if (
    (rank === RUNG_RANK.implemented ||
      rank === RUNG_RANK.in_review ||
      rank === RUNG_RANK.approved) &&
    (await workItemDeliveryRepository.countOpenByWorkItem(item.id, tx)) > 0
  ) {
    return NO_ANSWER;
  }

  const run = await dispatchRunRepository.findLatestForWorkItem(item.id, tx);
  if (!run || run.status !== 'succeeded' || run.stopReason !== 'gated') return NO_ANSWER;

  // ⚠️ MOVING AGAIN IS NOT PARKED (MOTIR-10308). CI that started on the delivery set
  // since the run stopped means the card's work went on without a resume, so offering one
  // would resume a run the card has moved past. "Since" is measured against the snapshot
  // the gated run's own recompute took of the set (`lib/workItems/resumeCi.ts`), never by
  // timestamp alone: the run's OWN last push is checked after it stops, and that CI is not
  // a new start. The set is `collectDeliveries`', the one answer to which pull requests
  // deliver a card.
  const snapshot = await resumeCiSnapshotFor(item, run, tx);
  if (snapshot?.moved) return { value: NOTHING_TO_RESUME, snapshot };

  const { verdict } = await readHeldGateVerdict(run.id, tx);
  // Declined / overturned stay waiting; a gate answered "changes requested" is
  // decided and releases the run to redo the work (MOTIR-9185).
  return {
    value: {
      resumeState: verdict === 'released' ? 'ready_to_resume' : 'waiting_on_gate',
      resumeRunId: run.id,
    },
    snapshot,
  };
}

/**
 * The gated run's snapshot of the delivery set, read NOW: the stored one advanced over the
 * set when it is this run's, else a fresh one (the run's first recompute — its close — or a
 * card stored before snapshots existed, which therefore has nothing to compare yet).
 */
async function resumeCiSnapshotFor(
  item: { id: string; sessionBranch: string | null; resumeDetail?: unknown },
  run: { id: string; endedAt: Date | null },
  tx: Prisma.TransactionClient,
): Promise<ResumeCiSnapshot | null> {
  if (run.endedAt === null) return null;
  const members = [...(await collectDeliveries(item, tx))].map(([id, pr]) => ({
    id,
    headSha: pr.headSha,
    checkRuns: pr.checkRuns,
  }));
  const stored = toResumeCiSnapshot(item.resumeDetail ?? null);
  return stored?.runId === run.id
    ? advanceResumeCiSnapshot(stored, members, run.endedAt)
    : takeResumeCiSnapshot(run.id, members);
}

/** One gate a `gated` run stopped on, as it stands NOW. */
export interface HeldGateRef {
  /** The LATEST gate of this kind on the card — a republish's, not the superseded one. */
  gateId: string;
  workItemId: string;
  /** The card's key (`MOTIR-7`). */
  key: string;
  kind: ApprovalGateKind;
  state: ApprovalGateState;
}

/**
 * Where a `gated` run's held gates stand (MOTIR-7707 · MOTIR-7708):
 *
 * - `released` — at least one is approved (a decision chosen, a direction
 *   confirmed, manual work marked done all write `approved`), or the run recorded
 *   none: there is work to resume.
 * - `released` ALSO holds when a gate was answered "changes requested" (MOTIR-9185):
 *   that is a decided gate carrying a reason, so the run resumes to read it and redo
 *   the work, as a fresh run does from `latestRefusal`. No replan is needed.
 * - `sent_back` — none approved or changes-requested, and at least one was declined
 *   or overturned: resuming would build on an answer nobody gave.
 * - `awaiting` — every one is still waiting on its person.
 *
 * ONE reading, shared by the To resume column and the continue claim, so the
 * Workbench never offers a resume the claim would refuse.
 */
export async function readHeldGateVerdict(
  runId: string,
  tx: Prisma.TransactionClient,
): Promise<{
  verdict: 'released' | 'sent_back' | 'awaiting';
  released: HeldGateRef[];
  changesRequested: HeldGateRef[];
  sentBack: HeldGateRef[];
  waiting: HeldGateRef[];
}> {
  const held = await dispatchRunHeldGateRepository.listByRun(runId, tx);
  const released: HeldGateRef[] = [];
  const changesRequested: HeldGateRef[] = [];
  const sentBack: HeldGateRef[] = [];
  const waiting: HeldGateRef[] = [];
  // A `gated` close that found no awaiting gate (it was decided in the same minute)
  // has nothing left to wait on (MOTIR-7703).
  if (held.length === 0) {
    return { verdict: 'released', released, changesRequested, sentBack, waiting };
  }
  const cards = await workItemRepository.findByIds([...new Set(held.map((r) => r.workItemId))], tx);
  const keyOf = new Map(cards.map((card) => [card.id, card.identifier]));
  const seen = new Set<string>();
  for (const row of held) {
    const slot = `${row.workItemId}:${row.kind}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    const latest = await approvalGateRepository.findLatestByWorkItem(row.workItemId, row.kind, tx);
    // The fallbacks are unreachable: the held row's own gate is a gate of this kind on
    // this card, and the card was read above.
    const ref: HeldGateRef = {
      /* v8 ignore next */
      gateId: latest?.id ?? row.gateId,
      workItemId: row.workItemId,
      /* v8 ignore next */
      key: keyOf.get(row.workItemId) ?? row.workItemId,
      kind: row.kind,
      /* v8 ignore next */
      state: latest?.state ?? 'awaiting',
    };
    if (ref.state === 'approved') released.push(ref);
    else if (ref.state === 'changes_requested') changesRequested.push(ref);
    else if (SENT_BACK.has(ref.state)) sentBack.push(ref);
    else waiting.push(ref);
  }
  const verdict =
    released.length > 0 || changesRequested.length > 0
      ? 'released'
      : sentBack.length > 0
        ? 'sent_back'
        : 'awaiting';
  return { verdict, released, changesRequested, sentBack, waiting };
}

const SENT_BACK = new Set<ApprovalGateState>(['declined', 'overturned']);

/**
 * RECOMPUTE one card's stored `resumeState` / `resumeRunId`, and write them if they
 * moved. Inside the writer's own transaction; takes the card's row lock first.
 */
export async function recomputeWorkItemResumeState(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<ResumeStateValue> {
  const locked = await workItemRepository.lockById(workItemId, tx);
  if (!locked) return NOTHING_TO_RESUME;
  const item = await workItemRepository.findById(workItemId, tx);
  /* v8 ignore next -- a granted lock on an immutable id implies a readable row */
  if (!item) return NOTHING_TO_RESUME;

  const { value: next, snapshot } = await deriveResumeAnswer(item, tx);
  const snapshotChanged =
    snapshot !== undefined &&
    !sameResumeCiSnapshot(toResumeCiSnapshot(item.resumeDetail ?? null), snapshot);
  if (
    item.resumeState !== next.resumeState ||
    item.resumeRunId !== next.resumeRunId ||
    snapshotChanged
  ) {
    await workItemRepository.updateResumeState(
      workItemId,
      snapshotChanged ? { ...next, resumeDetail: snapshot } : next,
      tx,
    );
  }
  return next;
}

export const resumeStateService = {
  /**
   * AFTER A GATE ON THIS CARD WAS DECIDED — recompute every card a run held by it
   * covers (MOTIR-7707). Called by the decide door and by the design-approval-off
   * system approval AFTER their transaction commits, never inside it.
   *
   * ⚠️ WHY AFTER THE COMMIT. The decision holds the gate's card lock, and the cards
   * waiting on the run are its SIBLINGS and its parent. A run close locks those same
   * cards in its own order (scope first, then legs ascending — `lockCoveredCards`),
   * and it covers the gate's card as a leg. Taking the siblings inside the decision
   * would lock in the inverse order and could deadlock against a close racing the
   * press. So each run's cards are recomputed in their own transaction, in the
   * close's order, once the decision is visible.
   */
  async afterGateDecided(
    workItemId: string,
    ctx: { userId: string; workspaceId: string },
  ): Promise<void> {
    const runIds = await withWorkspaceContext(ctx, (tx) =>
      dispatchRunHeldGateRepository.listRunIdsByWorkItem(workItemId, tx),
    );
    for (const runId of runIds) {
      await withWorkspaceContext(ctx, async (tx) => {
        const run = await dispatchRunRepository.findByIdWithCards(runId, tx);
        /* v8 ignore next -- a held row cascades away with its run */
        if (!run) return;
        const legs = [
          ...new Set(
            run.cards
              .map((card) => card.workItemId)
              .filter((id): id is string => id !== null && id !== run.scopeWorkItemId),
          ),
        ].sort();
        if (run.scopeWorkItemId) await recomputeWorkItemResumeState(run.scopeWorkItemId, tx);
        for (const id of legs) await recomputeWorkItemResumeState(id, tx);
      });
    }
  },
};
