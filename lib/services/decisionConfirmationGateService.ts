import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { asksTheConfirmQuestion } from '@/lib/approvalGates/decisionConfirmationHandler';
import {
  readDecisionRecords,
  type DecisionRecordsNow,
} from '@/lib/approvalGates/decisionConfirmationRecord';
import { parseDecisionRecord } from '@/lib/approvalGates/decisionRecord';
import { routingTargetId } from '@/lib/approvalGates/routing';
import type {
  DecisionConfirmationBodyDTO,
  DecisionConfirmationPortViewDTO,
  SupersededItemDTO,
} from '@/lib/dto/approvalGate';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { resolveMarkdownWorkItemRefs } from '@/lib/workItems/resolveWorkItemRefs';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { hasOpenBlocker, hopsToReview } from './choiceGateService';
import { workflowsService } from './workflowsService';

// THE CONFIRM GATE'S ONE RAISER (Story MOTIR-5871 · Subtask MOTIR-5954; ADR
// `docs/decisions/approval-gates.md` §1's MOTIR-5952 amendment, point 4).
//
// A `decision_confirmation` gate is owed on a `decision` + `human` work item whose
// body parses complete, that has no open blocker, and that is not in a
// done-category status — the `choiceGateService.reconcile` shape, keyed on the
// work item's own fields rather than a pull-request set, and SUPERSEDING on an
// edit that moves the stamp. It differs from the choice in ONE trigger: the
// EXECUTOR. Flipping a decision to `coding_agent` hands it to `decision_approval`,
// so the pending confirmation is withdrawn rather than left beside it.
//
// ⚠️ IT DECIDES AND WRITES GATES; IT MOVES NO STATUS. It returns the hops to
// `in_review` and the caller applies them through `applyStatusTransition` — the
// same split, for the same import-cycle reason, as the choice raiser.
//
// ⚠️ IT OPENS NO TRANSACTION AND TAKES NO LOCK: every caller is already inside the
// work item's write transaction.
//
// A hand move to `cancelled` is NOT handled here: the shipped pull-back rule
// (§6d's amendment, rule 6) supersedes every awaiting gate on that move, which is
// point 4's "a cancel withdraws the question" with no new code.

const KIND = 'decision_confirmation' as const;

/** What a reconcile did — enough for a caller to act on and a test to assert. */
export interface DecisionReconcile {
  raised: boolean;
  /** How many awaiting gates were withdrawn (a moved stamp, a broken body, a new executor). */
  superseded: number;
  /** The status keys to walk to reach `in_review` by DECLARED edges; empty when none. */
  hopsToReview: string[];
}

const NOTHING: DecisionReconcile = { raised: false, superseded: 0, hopsToReview: [] };

/**
 * A work item's decision body as the item page and the port read it — the parse,
 * gate or no gate, so a defective body renders its defect (and its draft) rather
 * than nothing — plus the record the port links. Null for a work item that is not
 * a `human` decision. Pure: the ONE mapping of parse → DTO; the caller resolves
 * the record, which is a read.
 */
export function decisionConfirmationBodyOf(
  item: { type: string | null; executor: string | null; descriptionMd: string | null },
  records: DecisionRecordsNow,
  titleOf: (key: string) => string | null,
): DecisionConfirmationBodyDTO | null {
  if (!asksTheConfirmQuestion(item)) return null;
  const parse = parseDecisionRecord(item.descriptionMd);
  const keys = parse.ok ? parse.supersedes : parse.draft.supersedes;
  const shared = {
    record: records.record,
    recordCount: records.count,
    presentRecordIds: records.presentIds,
    supersedesItems: keys.map((key): SupersededItemDTO => ({ key, title: titleOf(key) })),
  };
  if (!parse.ok) return { ok: false, defect: parse.defect, draft: parse.draft, ...shared };
  const { ok: _ok, ...sections } = parse;
  return { ok: true, port: { ...sections, ...shared } };
}

export const decisionConfirmationGateService = {
  /**
   * Bring a work item's `decision_confirmation` question into line with its body.
   * Idempotent on `(workItemId, kind, subjectVersion)`: a redelivered event, or a
   * write that did not move the stamp, changes nothing.
   */
  async reconcile(item: WorkItem, tx: Prisma.TransactionClient): Promise<DecisionReconcile> {
    const awaiting = (await approvalGateRepository.findAwaitingByWorkItem(item.id, tx)).filter(
      (gate) => gate.kind === KIND,
    );

    // Not a `human` decision any more — its type or its EXECUTOR changed: the
    // question it asked is withdrawn.
    if (!asksTheConfirmQuestion(item)) {
      if (awaiting.length === 0) return NOTHING;
      const superseded = await approvalGateRepository.supersedeAwaitingByWorkItem(
        item.id,
        KIND,
        'withdrawn',
        tx,
      );
      return { ...NOTHING, superseded };
    }

    const parse = parseDecisionRecord(item.descriptionMd);

    // A body that stopped parsing supersedes the gate and raises none — the defect
    // state takes its place. The subject was restated under the question.
    if (!parse.ok) {
      if (awaiting.length === 0) return NOTHING;
      const superseded = await approvalGateRepository.supersedeAwaitingByWorkItem(
        item.id,
        KIND,
        'republished',
        tx,
      );
      return { ...NOTHING, superseded };
    }

    // The same stamp is already being asked: nothing to do.
    if (awaiting.some((gate) => gate.subjectVersion === parse.subjectVersion)) return NOTHING;

    const terminal = await workflowsService.getTerminalStatusKeysByProjects(
      [item.projectId],
      item.workspaceId,
      tx,
    );
    const isDone = terminal.get(item.projectId)?.has(item.status) ?? false;
    const blocked = !isDone && (await hasOpenBlocker(item, item.workspaceId, tx));

    // An awaiting gate at an OLD stamp is withdrawn whatever happens next: the
    // person must never confirm a decision that no longer says what it said.
    let superseded = 0;
    if (awaiting.length > 0) {
      superseded = await approvalGateRepository.supersedeAwaitingByWorkItem(
        item.id,
        KIND,
        'republished',
        tx,
      );
    }
    if (isDone || blocked) return { ...NOTHING, superseded };

    // A decision already DECIDED at this stamp is not asked again: the same words
    // confirmed once are confirmed, and nothing re-asks them until they change.
    const latest = await approvalGateRepository.findLatestByWorkItem(item.id, KIND, tx);
    if (
      latest &&
      latest.state !== 'awaiting' &&
      latest.state !== 'superseded' &&
      latest.subjectVersion === parse.subjectVersion
    ) {
      return { ...NOTHING, superseded };
    }

    const raised = await approvalGateRepository.createAwaitingIfAbsent(
      {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        workItemId: item.id,
        kind: KIND,
        subjectId: item.id,
        subjectVersion: parse.subjectVersion,
        routedToId: routingTargetId(item),
      },
      tx,
    );
    return { raised, superseded, hopsToReview: raised ? await hopsToReview(item, tx) : [] };
  },

  /**
   * WHAT THE ITEM PAGE KNOWS ABOUT A DECISION'S BODY (the card's point 6) — the
   * parse itself and the record it would stamp, gate or no gate. Null for a work
   * item that is not a `human` decision.
   */
  async readBody(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<DecisionConfirmationBodyDTO | null> {
    return (await this.readBodyWithRefs(workItemId, ctx)).body;
  },

  /**
   * {@link readBody} with the body's work-item links resolved for the reader (bug
   * MOTIR-10023) — what the surfaces that DRAW the port read. The four sections are
   * parsed from the work item's description, so its `[KEY](motir:<id>)` tokens are
   * the port's; `{}` and no ref query when there is no body or it links nothing.
   */
  async readBodyWithRefs(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<{ body: DecisionConfirmationBodyDTO | null; workItemRefs: WorkItemRefMap }> {
    const read = await withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId) return null;
      if (!asksTheConfirmQuestion(item)) return null;
      // The `## Supersedes` keys' TITLES, in ONE project-scoped read — a key that names
      // nothing here (a removed item is exactly what a less-requirement decision
      // supersedes) simply has no title.
      const parse = parseDecisionRecord(item.descriptionMd);
      const keys = parse.ok ? parse.supersedes : parse.draft.supersedes;
      const found = await workItemRepository.findByIdentifiers(item.projectId, keys, tx);
      const titles = new Map(found.map((row) => [row.identifier, row.title]));
      const body = decisionConfirmationBodyOf(
        item,
        await readDecisionRecords(item.id, tx),
        (key) => titles.get(key) ?? null,
      );
      return body ? { body, descriptionMd: item.descriptionMd } : null;
    });
    if (!read) return { body: null, workItemRefs: {} };
    const workItemRefs = read.descriptionMd
      ? await resolveMarkdownWorkItemRefs(read.descriptionMd, ctx)
      : {};
    return { body: read.body, workItemRefs };
  },

  /** The overlay's port for a `decision_confirmation` gate — null when the body no longer parses. */
  async readPort(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<DecisionConfirmationPortViewDTO | null> {
    const { body, workItemRefs } = await this.readBodyWithRefs(workItemId, ctx);
    return body?.ok ? { ...body.port, workItemRefs } : null;
  },
};
