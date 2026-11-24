import type { ApprovalGate, Prisma } from '@/generated/prisma/client';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE DECISION-CORRECTION MARK (Subtask MOTIR-12175, story MOTIR-10139).
//
// A card planned against a decision that was later CORRECTED has an out-of-date
// description, yet it reads To Do and the next run claims it and builds the stale
// version. When a decision card is approved or confirmed AFTER a correction at its
// gate, this walks the work that waits on it and marks what was planned against the
// old version: a not-started card moves to `to_plan` (MOTIR-12174) with a comment
// that says why; a started one keeps its status and gets the comment alone.
//
// ⚠️ IT RUNS AFTER THE DECISION COMMITS, in transactions of its own — the decide
// door's `afterCommit` (`lib/approvalGates/registry.ts`). Never inside the door's:
// a hop the workflow refuses would roll the DECISION back with it, and the
// workflow reads it needs open their own connections, which the door's gate lock
// forbids. Its caller swallows and logs any failure: the decision stands.
//
// ⚠️ DISPOSITION IS BY STATUS CATEGORY, NEVER BY KEY (the workflow convention) —
// the one exception being the two keys that already mean "being re-planned",
// `planning` and `to_plan`, which sit in the in-progress category with started work.

/** The two gate kinds that put a decision to a person. */
export const DECISION_GATE_KINDS = ['decision_approval', 'decision_confirmation'] as const;

/**
 * The supersede causes that mean the DOCUMENT CHANGED under an awaiting gate — a
 * republish of the page (or a confirmation body whose stamp moved), and a push that
 * moved a file decision's head. Every other cause (`pulled_back`, `ci_failed`,
 * `ci_rerunning`, `conflict`, `member_closed`, `member_drafted`, `set_changed`,
 * `withdrawn`, `unknown`) withdraws the SAME question and is not a correction.
 */
export const CORRECTING_SUPERSEDE_CAUSES: ReadonlySet<string> = new Set([
  'republished',
  'head_moved',
]);

export const TO_PLAN_STATUS_KEY = 'to_plan';
const PLANNING_KEYS: ReadonlySet<string> = new Set(['planning', TO_PLAN_STATUS_KEY]);

/** What the mark did to one work item it reached. */
export type DecisionCorrectionMarkOutcome =
  /** Not started and stale: moved to `to_plan`, with one comment. */
  | 'moved'
  /** Started and stale: status kept, the started-item comment written. */
  | 'commented'
  /** Already at `planning` / `to_plan`: nothing, no comment. */
  | 'skipped_already_planning'
  /** Its description was written after the deciding gate was raised: nothing. */
  | 'skipped_fresh'
  /** Done category: nothing. */
  | 'skipped_done'
  /** Not started and stale, but no `to_plan` status, no declared edge into it, or a
   *  hop the workflow refused: the comment alone, status kept. */
  | 'comment_only_no_status';

export interface DecisionCorrectionMarkResult {
  gateId: string;
  /** False when the decision was not a corrected one, so nothing was walked. */
  corrected: boolean;
  items: Array<{ workItemId: string; outcome: DecisionCorrectionMarkOutcome }>;
}

type GateHistoryRow = Pick<
  ApprovalGate,
  'id' | 'state' | 'supersededCause' | 'subjectVersion' | 'createdAt'
>;

/**
 * Was the decision CORRECTED before `deciding` decided it? True when an EARLIER gate of
 * the same kind (raised before it) was sent back (`changes_requested`) or withdrawn
 * because the document changed ({@link CORRECTING_SUPERSEDE_CAUSES}) — and, where both
 * rows carry a `subjectVersion`, on a DIFFERENT version, so a re-ask on the same
 * document does not count. Pure.
 */
export function wasCorrectedBefore(
  deciding: GateHistoryRow,
  history: readonly GateHistoryRow[],
): boolean {
  return history.some((row) => {
    if (row.id === deciding.id || row.createdAt >= deciding.createdAt) return false;
    const corrective =
      row.state === 'changes_requested' ||
      (row.state === 'superseded' &&
        row.supersededCause !== null &&
        CORRECTING_SUPERSEDE_CAUSES.has(row.supersededCause));
    if (!corrective) return false;
    if (row.subjectVersion !== null && deciding.subjectVersion !== null) {
      return row.subjectVersion !== deciding.subjectVersion;
    }
    return true;
  });
}

const isoDate = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * The version a decision was decided on, in words — "version N of <page title>" for a
 * page, "`path` at `<blob7>`" for a file, "the confirmed text of <date>" for a
 * confirmation.
 */
export async function describeDecidedVersion(
  gate: Pick<ApprovalGate, 'kind' | 'subjectVersion' | 'decidedAt' | 'createdAt'>,
  tx: Prisma.TransactionClient,
): Promise<string> {
  if (gate.kind === 'decision_confirmation') {
    return `the confirmed text of ${isoDate(gate.decidedAt ?? gate.createdAt)}`;
  }
  const version = gate.subjectVersion;
  if (!version) return 'its approved version';
  const page = /^page:([^@]+)@(.+)$/.exec(version);
  if (page) {
    const [, pageId, versionId] = page;
    const [row, record] = await Promise.all([
      pageVersionRepository.findVersionById(versionId!, tx),
      pageRepository.findById(pageId!, tx),
    ]);
    const title = record?.title ?? 'its page';
    return row ? `version ${row.number} of ${title}` : `the approved version of ${title}`;
  }
  const at = version.lastIndexOf('@');
  const colon = version.indexOf(':');
  if (at > colon && colon > 0) {
    const path = version.slice(colon + 1, at);
    const blob = version.slice(at + 1, at + 8);
    return `\`${path}\` at \`${blob}\``;
  }
  return 'its approved version';
}

/** The comment the mark writes. English content, like the run-stop comment. */
export function composeMarkComment(input: {
  decisionIdentifier: string;
  decisionId: string;
  versionLabel: string;
  descriptionWrittenAt: Date;
  started: boolean;
}): string {
  const head = `**Planned against an earlier version of [${input.decisionIdentifier}](motir:${input.decisionId}).**`;
  const why = `That decision was corrected and then approved on ${input.versionLabel}, after this work item's description was last written (${isoDate(input.descriptionWrittenAt)}).`;
  const ask = input.started
    ? 'This work item has already started, so its status was kept — check its work against the decision.'
    : 'Re-plan it so it matches the decision before it is built.';
  return `${head} ${why} ${ask}`;
}

interface Reached {
  id: string;
  projectId: string;
  status: string;
  /** When its description was last written — the staleness instant. */
  descriptionWrittenAt: Date;
}

/**
 * The work items the decision reaches: every item `blocked_by` it directly or through
 * a chain of `blocked_by` links (breadth-first, a visited set ending the walk), then
 * the LIVE descendants of every item so reached. The walk continues only from
 * link-reached items, never from a descendant, and follows no other link kind.
 * Archived and triage rows are not live work and are left out.
 */
async function walkDependents(
  decisionId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const visited = new Set<string>([decisionId]);
  const linked: string[] = [];
  const queue: string[] = [decisionId];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const links = await workItemLinkRepository.findByToItem(at, 'is_blocked_by', tx);
    for (const link of links) {
      if (visited.has(link.fromId)) continue;
      visited.add(link.fromId);
      linked.push(link.fromId);
      queue.push(link.fromId);
    }
  }
  const reached = [...linked];
  for (const id of linked) {
    const members = await workItemRepository.findSubtreeMembersForValidity(id, workspaceId, tx);
    for (const member of members) {
      if (visited.has(member.id)) continue;
      visited.add(member.id);
      reached.push(member.id);
    }
  }
  return reached;
}

/** One reached item's disposition, in transactions of its own. */
async function disposeOf(
  item: Reached,
  read: {
    gate: ApprovalGate;
    decision: { id: string; identifier: string };
    versionLabel: string;
  },
  workflow: {
    categoryOf: (projectId: string, statusKey: string) => Promise<string | null>;
    hasToPlan: (projectId: string) => Promise<boolean>;
  },
  ctx: ServiceContext,
): Promise<DecisionCorrectionMarkOutcome> {
  const category = await workflow.categoryOf(item.projectId, item.status);
  if (category === 'done') return 'skipped_done';
  if (PLANNING_KEYS.has(item.status)) return 'skipped_already_planning';
  if (item.descriptionWrittenAt >= read.gate.createdAt) return 'skipped_fresh';

  const started = category !== 'todo';
  const bodyMd = composeMarkComment({
    decisionIdentifier: read.decision.identifier,
    decisionId: read.decision.id,
    versionLabel: read.versionLabel,
    descriptionWrittenAt: item.descriptionWrittenAt,
    started,
  });
  let commentId: string | null = null;
  const writeComment = async (tx: Prisma.TransactionClient): Promise<void> => {
    const created = await commentRepository.create(
      {
        workspaceId: ctx.workspaceId,
        workItemId: item.id,
        authorId: ctx.userId,
        parentCommentId: null,
        bodyMd,
      },
      tx,
    );
    commentId = created.id;
  };
  const commentOnly = () =>
    withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId },
      writeComment,
    );

  let outcome: DecisionCorrectionMarkOutcome;
  if (started) {
    await commentOnly();
    outcome = 'commented';
  } else if (
    (await workflow.hasToPlan(item.projectId)) &&
    (await workflowsService.canTransition(
      item.projectId,
      item.status,
      TO_PLAN_STATUS_KEY,
      ctx.workspaceId,
    ))
  ) {
    try {
      // The move and its comment commit together; `updateStatus` announces the hop
      // (`work-item/transitioned`) after that commit, never before.
      await workItemsService.updateStatus(item.id, TO_PLAN_STATUS_KEY, ctx, {
        inTransaction: writeComment,
      });
      outcome = 'moved';
    } catch (err) {
      // A hop the workflow refuses (a guard, an access check, a race) rolled the move
      // AND its comment back: say it with the comment alone, and keep the status.
      console.error('[decisionCorrectionMark] the move to to_plan was refused; commenting', {
        gateId: read.gate.id,
        workItemId: item.id,
        err,
      });
      commentId = null;
      await commentOnly();
      outcome = 'comment_only_no_status';
    }
  } else {
    await commentOnly();
    outcome = 'comment_only_no_status';
  }

  /* v8 ignore next -- unreachable: every arm above wrote the comment or threw. */
  if (commentId === null) throw new Error(`the mark comment on ${item.id} was not written`);
  // Post-commit, like every comment: a rollback must not have notified watchers.
  await sendEvent('work-item/comment.created', {
    workspaceId: ctx.workspaceId,
    workItemId: item.id,
    commentId,
    authorId: ctx.userId,
    mentionedUserIds: [],
    ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
  });
  return outcome;
}

export const decisionCorrectionMarkService = {
  /**
   * Mark the work planned against a corrected decision, once its gate is DECIDED.
   * Called from the decision gate handlers' `afterCommit` — after the decision has
   * committed — and never inside a transaction of the caller's. Returns what it did
   * to each item it reached; a decision that was not corrected reaches nothing.
   */
  async markForDecidedGate(
    gateId: string,
    ctx: ServiceContext,
  ): Promise<DecisionCorrectionMarkResult> {
    const notCorrected: DecisionCorrectionMarkResult = { gateId, corrected: false, items: [] };

    // ── 1 · READ — the gate, its history, the decision and what it reaches ──────
    const read = await withWorkspaceContext(ctx, async (tx) => {
      const gate = await approvalGateRepository.findById(gateId, tx);
      if (
        !gate ||
        gate.workItemId === null ||
        gate.state !== 'approved' ||
        !(DECISION_GATE_KINDS as readonly string[]).includes(gate.kind)
      ) {
        return null;
      }
      const history = await approvalGateRepository.listByWorkItemAndKind(
        gate.workItemId,
        gate.kind,
        tx,
      );
      if (!wasCorrectedBefore(gate, history)) return null;
      const decision = await workItemRepository.findById(gate.workItemId, tx);
      /* v8 ignore next -- a gate's card cascades with it; a decided gate keeps its card. */
      if (!decision) return null;

      const reachedIds = await walkDependents(decision.id, ctx.workspaceId, tx);
      const reached: Reached[] = [];
      for (const id of reachedIds) {
        const item = await workItemRepository.findById(id, tx);
        if (!item || item.archivedAt !== null || item.triagedAt !== null) continue;
        const writtenAt =
          (await workItemRevisionRepository.findLatestDescriptionChangeAt(id, tx)) ??
          item.createdAt;
        reached.push({
          id,
          projectId: item.projectId,
          status: item.status,
          descriptionWrittenAt: writtenAt,
        });
      }
      return {
        gate,
        decision,
        reached,
        versionLabel: await describeDecidedVersion(gate, tx),
      };
    });
    if (!read) return notCorrected;

    // ── 2 · THE WORKFLOW, PER PROJECT — links may cross projects in a workspace ──
    const categories = new Map<string, Map<string, string>>();
    const categoryOf = async (projectId: string, statusKey: string): Promise<string | null> => {
      let byKey = categories.get(projectId);
      if (!byKey) {
        const statuses = await workflowsService.listStatusesByProject(projectId, ctx.workspaceId);
        byKey = new Map(statuses.map((s) => [s.key, s.category]));
        categories.set(projectId, byKey);
      }
      return byKey.get(statusKey) ?? null;
    };
    const hasToPlan = async (projectId: string): Promise<boolean> =>
      (await categoryOf(projectId, TO_PLAN_STATUS_KEY)) !== null;

    // ── 3 · DISPOSE OF EACH — its own transaction, its events after its commit ──
    const items: DecisionCorrectionMarkResult['items'] = [];
    for (const item of read.reached) {
      try {
        const outcome = await disposeOf(item, read, { categoryOf, hasToPlan }, ctx);
        items.push({ workItemId: item.id, outcome });
      } catch (err) {
        // One item that cannot be marked never stops the others — nor the decision.
        console.error('[decisionCorrectionMark] could not mark a reached work item', {
          gateId,
          workItemId: item.id,
          err,
        });
      }
    }
    return { gateId, corrected: true, items };
  },
};

/**
 * The `afterCommit` a decision gate's approve effect returns (MOTIR-12175): run the
 * mark once the decision has committed, and never let it fail the decision. LAZY
 * import at the call site keeps the gate handlers' import graph free of
 * `workItemsService`.
 */
export async function runDecisionCorrectionMark(
  gateId: string,
  ctx: ServiceContext,
): Promise<void> {
  try {
    await decisionCorrectionMarkService.markForDecidedGate(gateId, ctx);
  } catch (err) {
    console.error('[decisionCorrectionMark] the mark failed; the decision stands', {
      gateId,
      err,
    });
  }
}
