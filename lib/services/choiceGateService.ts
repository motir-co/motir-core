import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { parseChoiceOptions } from '@/lib/approvalGates/choiceOptions';
import { routingTargetId } from '@/lib/approvalGates/routing';
import type { ChoiceBodyDTO, DecisionChoicePortViewDTO } from '@/lib/dto/approvalGate';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { resolveMarkdownWorkItemRefs } from '@/lib/workItems/resolveWorkItemRefs';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { classifyBlockerReadiness } from '@/lib/workItems/blockerReadiness';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workflowsService } from './workflowsService';

// THE CHOICE GATE'S ONE RAISER (Story MOTIR-4914 · Subtask MOTIR-5891; ADR
// `docs/decisions/approval-gates.md` §1's MOTIR-5887 amendment, point 3).
//
// A `decision_choice` gate is owed on a `type: choice` work item whose body parses
// complete, that has no open blocker, and that is not in a done-category status —
// a condition on the WORK ITEM'S OWN FIELDS, not on a pull-request set. That is
// why it is decided here rather than by `lib/approvalGates/gateSet.ts`: the set
// rule pairs a primary question with the merge question on a card that delivers
// pull requests, and a choice never does. It also has to SUPERSEDE on an edit
// (a new `subjectVersion`), which `reconcileGatesFor` deliberately never does.
//
// ⚠️ IT DECIDES AND WRITES GATES; IT MOVES NO STATUS. The raise also walks the work
// item to `in_review` by declared edges, but a status write belongs to
// `workItemsService.applyStatusTransition`, which imports this module — so this
// returns the hops and the caller applies them, and no import cycle forms (the
// same reason `gateSetFor` "asks for no handler").
//
// ⚠️ IT OPENS NO TRANSACTION AND TAKES NO LOCK: every caller is already inside the
// work item's write transaction.

const KIND = 'decision_choice' as const;
const REVIEW_KEY = 'in_review';

/** What a reconcile did — enough for a caller to act on and a test to assert. */
export interface ChoiceReconcile {
  /** A fresh `awaiting` gate was written. */
  raised: boolean;
  /** How many awaiting gates were withdrawn (a moved stamp, a body that stopped parsing). */
  superseded: number;
  /**
   * The status keys to walk, in order, to reach `in_review` by DECLARED edges —
   * empty when no gate was raised, when the item is already there, or when the
   * project's workflow offers no path (then the gate stands and the status stays).
   */
  hopsToReview: string[];
}

const NOTHING: ChoiceReconcile = { raised: false, superseded: 0, hopsToReview: [] };

export async function hasOpenBlocker(
  item: WorkItem,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const blockers = await workItemLinkRepository.findBlockerStatesForItems([item.id], tx);
  if (blockers.length === 0) return false;
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    blockers.map((blocker) => blocker.projectId),
    workspaceId,
    tx,
  );
  return !classifyBlockerReadiness(blockers, terminalByProject).ready;
}

/**
 * The shortest walk from the item's status to `in_review` over the project's
 * DECLARED transitions (point 3: "by declared workflow edges only"). An `open`
 * project permits any move, so the walk is one hop. No path ⇒ no hops.
 *
 * Exported for the decision's confirm gate, which raises on the same rule
 * (`decisionConfirmationGateService`, MOTIR-5954) — one walk, not two.
 */
export async function hopsToReview(
  item: WorkItem,
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  if (item.status === REVIEW_KEY) return [];
  const [project, statuses, transitions] = await Promise.all([
    projectRepository.findById(item.projectId, tx),
    workflowsRepository.findStatuses(item.projectId, item.workspaceId, tx),
    workflowsRepository.findTransitions(item.projectId, item.workspaceId, tx),
  ]);
  const review = statuses.find((status) => status.key === REVIEW_KEY);
  const from = statuses.find((status) => status.key === item.status);
  if (!project || !review || !from) return [];
  if (project.workflowPolicyMode === 'open') return [REVIEW_KEY];

  const keyById = new Map(statuses.map((status) => [status.id, status.key]));
  const next = new Map<string, string[]>();
  for (const edge of transitions) {
    next.set(edge.fromStatusId, [...(next.get(edge.fromStatusId) ?? []), edge.toStatusId]);
  }
  const cameFrom = new Map<string, string>([[from.id, from.id]]);
  const queue = [from.id];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === review.id) break;
    for (const to of next.get(at) ?? []) {
      if (cameFrom.has(to)) continue;
      cameFrom.set(to, at);
      queue.push(to);
    }
  }
  if (!cameFrom.has(review.id)) return [];
  const path: string[] = [];
  for (let at = review.id; at !== from.id; at = cameFrom.get(at)!) path.unshift(keyById.get(at)!);
  return path;
}

/**
 * A work item's body as the item page and the port read it — the parse, gate or no
 * gate, so a defective body renders its defect (and its draft) rather than nothing.
 * Null for a work item that is not a choice. Pure: the ONE mapping of parse → DTO.
 */
export function choiceBodyOf(item: {
  type: string | null;
  descriptionMd: string | null;
}): ChoiceBodyDTO | null {
  if (item.type !== 'choice') return null;
  const parse = parseChoiceOptions(item.descriptionMd);
  if (!parse.ok) return { ok: false, defects: parse.defects, draft: parse.draft };
  const { ok: _ok, ...port } = parse;
  return { ok: true, port };
}

export const choiceGateService = {
  /**
   * Bring a work item's `decision_choice` question into line with its body.
   * Idempotent on `(workItemId, kind, subjectVersion)`: a redelivered event, or a
   * write that did not move the stamp, changes nothing.
   */
  async reconcile(item: WorkItem, tx: Prisma.TransactionClient): Promise<ChoiceReconcile> {
    const awaiting = (await approvalGateRepository.findAwaitingByWorkItem(item.id, tx)).filter(
      (gate) => gate.kind === KIND,
    );

    // Not a choice any more (its type changed): the question it asked is withdrawn.
    if (item.type !== 'choice') {
      if (awaiting.length === 0) return NOTHING;
      const superseded = await approvalGateRepository.supersedeAwaitingByWorkItem(
        item.id,
        KIND,
        'withdrawn',
        tx,
      );
      return { ...NOTHING, superseded };
    }

    const parse = parseChoiceOptions(item.descriptionMd);

    // A body that stopped parsing supersedes the gate and raises none — the defect
    // state takes its place (point 3). The subject was restated under the question.
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

    // A done work item asks nothing, and neither does a blocked one — the rule's
    // other two conditions. An awaiting gate at an OLD stamp is still withdrawn:
    // the person must never pick from options that no longer exist.
    const terminal = await workflowsService.getTerminalStatusKeysByProjects(
      [item.projectId],
      item.workspaceId,
      tx,
    );
    const isDone = terminal.get(item.projectId)?.has(item.status) ?? false;
    const blocked = !isDone && (await hasOpenBlocker(item, item.workspaceId, tx));

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

    // "Nothing re-asks the unchanged options": a pick refused with None of these
    // is asked again only once the body moves its stamp.
    const latest = await approvalGateRepository.findLatestByWorkItem(item.id, KIND, tx);
    if (latest?.state === 'changes_requested' && latest.subjectVersion === parse.subjectVersion) {
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
   * WHAT THE ITEM PAGE KNOWS ABOUT A CHOICE'S BODY (the card's point 5) — the parse
   * itself, gate or no gate, so the port can render the defect state. Null for a
   * work item that is not a choice.
   */
  async readBody(workItemId: string, ctx: ServiceContext): Promise<ChoiceBodyDTO | null> {
    return (await this.readBodyWithRefs(workItemId, ctx)).body;
  },

  /**
   * {@link readBody} with the body's work-item links resolved for the reader (bug
   * MOTIR-10023) — what the surfaces that DRAW the port read. The sections are
   * parsed from the work item's description, so its `[KEY](motir:<id>)` tokens are
   * the port's; `{}` and no ref query when there is no body or it links nothing.
   */
  async readBodyWithRefs(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<{ body: ChoiceBodyDTO | null; workItemRefs: WorkItemRefMap }> {
    const item = await withWorkspaceContext(ctx, (tx) =>
      workItemRepository.findById(workItemId, tx),
    );
    if (!item || item.workspaceId !== ctx.workspaceId) return { body: null, workItemRefs: {} };
    const body = choiceBodyOf(item);
    const workItemRefs =
      body && item.descriptionMd ? await resolveMarkdownWorkItemRefs(item.descriptionMd, ctx) : {};
    return { body, workItemRefs };
  },

  /** The overlay's port for a `decision_choice` gate — null when the body no longer parses. */
  async readPort(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<DecisionChoicePortViewDTO | null> {
    const { body, workItemRefs } = await this.readBodyWithRefs(workItemId, ctx);
    return body?.ok ? { ...body.port, workItemRefs } : null;
  },
};
