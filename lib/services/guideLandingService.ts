import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { getJob } from '@/lib/ai/motirAiClient';
import {
  deriveTemporaryList,
  GUIDE_BUGS_PER_TURN,
  GUIDE_SKIP_LINKED_PULL_REQUEST,
  parseGuideTurn,
  type GuideAction,
  type GuideActionOutcome,
  type GuideRowInput,
  type GuideTurn,
  type GuideReplanOffer,
  type GuideReplanTargetResolution,
  type GuideTurnRecord,
} from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import { guideReplyBody } from '@/lib/planning/guideReplyNotes';
import { toSeedAncestors } from '@/lib/planning/refusalSeed';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { deliveryMemberState } from '@/lib/workItems/deliverySet';
import { commentsService } from '@/lib/services/commentsService';
import { guideBugFilingService } from '@/lib/services/guideBugFilingService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workflowsService } from '@/lib/services/workflowsService';
import { walkToDone as walkStatusesToDone } from '@/lib/workflows/walkToDone';
import {
  GuideBugCapExceededError,
  GuideBugDuplicateError,
  PlanChangeSessionNotFoundError,
} from '@/lib/planChange/errors';
import { PermissionDeniedError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import { ApprovalGatePendingError, WorkItemError } from '@/lib/workItems/errors';
import { ApprovalGateError } from '@/lib/approvalGates/errors';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import {
  EmptyTodoTextError,
  TodoCommandTooLongError,
  TodoNotesTooLongError,
  TodoReorderConflictError,
  TodoTextTooLongError,
  WorkItemTodoNotFoundError,
} from '@/lib/workItemTodos/errors';
import { CommentForbiddenError } from '@/lib/comments/errors';

// LANDING a guide turn (Story MOTIR-7459 · MOTIR-7470) — the write half of the
// conversation's FOURTH intent, `docs/decisions/conversation-turn-intent.md`
// AMENDMENT 2, A2.4–A2.6. `guide_work_item` (motir-ai, MOTIR-7463) writes
// nothing; this reads its settled `guideTurn` and lands each action, AS THE
// PERSON WHOSE TURN IT WAS, through the service that already owns that write:
//
//   | action                                   | saved list                                   | temporary walk |
//   | ---------------------------------------- | -------------------------------------------- | -------------- |
//   | `write_todos`                            | `addTodo` per row, then `setTodoDone`         | n/a            |
//   | `tick` / `untick`                        | `setTodoDone`                                | recorded       |
//   | `add_step` / `revise_step` /             | `addTodo` (+`moveTodo`) / `updateTodo` /     | recorded       |
//   | `remove_step` / `move_step`              | `deleteTodo` / `moveTodo`                    |                |
//   | `edit_item`                              | `workItemsService.updateWorkItem`            | same           |
//   | `cannot_do` / `needs_replan`             | `commentsService.addComment`                 | same           |
//   | `close`                                  | `workItemsService.updateStatus`, walked      | same           |
//   | `file_bug`                               | `guideBugFilingService.fileGuideBug` →       | same           |
//   |                                          | `workItemsService.createWorkItem` (a `bug`)  |                |
//   | `propose_todos` / `current_step` /       | recorded on the conversation                 | recorded       |
//   | `offer_close` / `local_agent_prompt`     |                                              |                |
//
// Every write goes through the gated path the person would use by hand, so the
// turn can do nothing they could not, and the card's own events, revisions and
// activity fire.
//
// ── AGAINST THE CARD AS IT STANDS AT LANDING (A2.4) ──────────────────────────
// A person may tick, untick or edit rows while a turn runs. An action naming a
// row that is gone, or already in the state it asks for, is SKIPPED and recorded
// with its reason. It does not fail the turn: the turn's other actions still land.
//
// ── A TICKED ROW MAY BE CORRECTED (`guide-turn-files.md` A3.9 (b)) ───────────
// This amends A2.4's "a correction aimed at a ticked row is skipped". While the
// card's target holds, `revise_step` / `remove_step` / `move_step` land on any
// row, ticked or not, and a revised ticked row KEEPS its tick. When the revision
// means the done work no longer satisfies it, motir-ai sends an `untick` for the
// row just before the `revise_step`, which lands through the ordinary untick. A
// change that would alter the target is `needs_replan`, which edits nothing and
// leaves a comment, exactly as `cannot_do` does.
//
// ── EXACTLY ONCE: A CLAIM BEFORE THE WRITES ──────────────────────────────────
// `debugLandingService`'s shape. The settle is replayable (a reload, a retried
// request, a second tab). The `user` turn carries a CLAIM
// (`guideLandingClaimedAt`), taken under the session's row lock AFTER the result
// parsed and BEFORE the first write:
//
//   * a replay after a finished landing finds the job's `assistant` turn and
//     returns the thread, writing nothing;
//   * a concurrent settle loses the claim and writes nothing;
//   * a failure part-way keeps the claim — the landing fails CLOSED, so a retry
//     never ticks or comments twice.
//
// ── NOTHING LANDS FROM A TURN THAT DID NOT RUN ───────────────────────────────
// A job that failed, was cancelled, or never produced a `guideTurn` lands no
// action and appends no reply.
//
// ── NOTHING LANDS ON A CARD CLOSED WHILE THE TURN RAN (MOTIR-7817) ───────────
// The door refuses a card that is Done or archived (A2.7, gate 5 of
// `aiGuideService`), but the job runs for seconds to minutes after it, and the
// write services land on an archived card. So the landing re-applies that gate
// to the card as it stands: a card archived, or moved into the done category,
// since the turn was sent lands NO action. Each is recorded as skipped with the
// reason and the reply is still appended, the way A2.4 treats a row that is gone.

/** What a guide settle produced. */
export type GuideSettleResult =
  | { outcome: 'guided'; session: PlanChangeSessionDto; record: GuideTurnRecord }
  | { outcome: 'failed'; session: PlanChangeSessionDto }
  | { outcome: 'silent'; session: PlanChangeSessionDto };

/** A refusal an action's guard raises — recorded on the turn, never thrown out.
 *  A `file_bug` refused as a duplicate carries the existing bug's key. */
class Skip extends Error {
  constructor(
    message: string,
    readonly workItemKey?: string,
  ) {
    super(message);
  }
}

/** The guided card as it stands at landing, with its saved rows. */
interface LandingCard {
  item: WorkItemDto;
  rows: WorkItemTodoDto[];
  /** The guide conversation the turn belongs to — what a `file_bug` is counted on. */
  sessionId: string;
  /** How many bugs THIS turn has filed so far (`GUIDE_BUGS_PER_TURN`). */
  bugsFiledThisTurn: number;
  /** The re-plan offer THIS turn has landed (MOTIR-8689) — one per turn. */
  replanOffer: GuideReplanOffer | null;
}

function actorOf(ctx: ProjectContext): ServiceContext {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

async function readRows(item: WorkItemDto, ctx: ProjectContext): Promise<WorkItemTodoDto[]> {
  return (await workItemTodosService.listTodos(item.id, actorOf(ctx))).items;
}

/** The assistant turns' records, in order — what the temporary list derives from. */
function recordsOf(session: PlanChangeSessionDto) {
  return session.turns
    .filter((t) => t.role === 'assistant')
    .map((t) => ({ seq: t.seq, record: t.guide ?? null }));
}

/** Whether a linked pull request will close the card on merge (A2.6). A closed,
 *  unmerged one delivers nothing and does not count. */
async function hasLinkedPullRequest(item: WorkItemDto, ctx: ProjectContext): Promise<boolean> {
  const deliveries = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemDeliveryRepository.listByWorkItem(item.id, tx),
  );
  return deliveries.some((d) => deliveryMemberState(d.pullRequest) !== 'closed');
}

/** The walk from the card's status to Done (A2.6), over the project's workflow. */
async function walkToDone(item: WorkItemDto, ctx: ProjectContext): Promise<string[] | null> {
  const wf = await workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId);
  return walkStatusesToDone(wf, item.status);
}

/** The destination index `moveTodo` takes — the list WITHOUT the moving row. */
function indexAfter(rows: WorkItemTodoDto[], movingId: string | null, afterRowId: string | null) {
  const without = rows.filter((r) => r.id !== movingId);
  if (afterRowId === null) return 0;
  const at = without.findIndex((r) => r.id === afterRowId);
  if (at < 0) throw new Skip('the step it was to follow is no longer on the list');
  return at + 1;
}

function savedRow(card: LandingCard, rowId: string): WorkItemTodoDto {
  const row = card.rows.find((r) => r.id === rowId);
  if (!row) throw new Skip('that step is not on this card');
  return row;
}

/** The comment `cannot_do` leaves on the card. */
export function guideCannotDoComment(reason: string, step: string | null): string {
  return [
    '**Motir AI could not take this card further.**',
    '',
    step ? `Stopped at: ${step}` : null,
    `Reason: ${reason}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** The comment `needs_replan` leaves on the card (A3.9 (b)): the change asked for
 *  would alter what the card is for, so nothing was changed and the walk stopped. */
export function guideNeedsReplanComment(reason: string, targetKey?: string | null): string {
  return [
    '**Motir AI stopped: this card needs a re-plan.**',
    '',
    'The change asked for in the guided walk would alter what this card is for, so nothing on the card was changed.',
    `Reason: ${reason}`,
    ...(targetKey === undefined
      ? []
      : [
          '',
          targetKey === null
            ? 'No open work item to re-plan on.'
            : `Re-plan offered on: ${targetKey}`,
        ]),
  ].join('\n');
}

/**
 * Where a `needs_replan` offer plans (MOTIR-8685 Q4), resolved ONCE at landing, as
 * the person whose turn it was:
 *
 *  1. the key the guide asked for, else the guided card;
 *  2. a key that cannot be read (unknown, not browsable, another project) falls
 *     back to the guided card — nothing of the unreadable card is kept;
 *  3. a target that is archived or in the done category walks UP its ancestors to
 *     the nearest one that is neither; every one done ⇒ no target;
 *  4. otherwise it stands as asked.
 */
export async function resolveReplanTarget(
  requestedKey: string | null,
  card: WorkItemDto,
  ctx: ProjectContext,
): Promise<{ targetKey: string | null; targetResolution: GuideReplanTargetResolution }> {
  let target = card;
  let resolution: GuideReplanTargetResolution = 'guided_card';
  // Keys are case-insensitive, folded the way the guide door folds `itemKey`
  // (`requireGuidableCard`), so a guide asking for `motir-9` reaches `MOTIR-9`.
  const askedKey = requestedKey === null ? null : requestedKey.trim().toUpperCase();
  if (askedKey !== null && askedKey !== card.identifier.toUpperCase()) {
    try {
      const asked = await workItemsService.getWorkItemByIdentifier(
        ctx.projectId,
        askedKey,
        actorOf(ctx),
      );
      if (asked.projectId === ctx.projectId) {
        target = asked;
        resolution = 'as_asked';
      }
    } catch (err) {
      // Not found, or not browsable by this person: indistinguishable, and both
      // fall back to the guided card.
      if (
        !(
          err instanceof WorkItemError ||
          err instanceof PermissionDeniedError ||
          err instanceof ProjectAccessDeniedError
        )
      ) {
        throw err;
      }
    }
  } else if (askedKey !== null) {
    resolution = 'as_asked';
  }
  const [statuses, ancestorRows] = await Promise.all([
    workflowsService.listStatusesByProject(ctx.projectId, ctx.workspaceId),
    target.parentId
      ? withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
          workItemRepository.findAncestors(target.id, ctx.workspaceId, tx),
        )
      : Promise.resolve([]),
  ]);
  const doneKeys = new Set(statuses.filter((st) => st.category === 'done').map((st) => st.key));
  if (target.archivedAt === null && !doneKeys.has(target.status)) {
    return { targetKey: target.identifier, targetResolution: resolution };
  }
  // `findAncestors` is root → parent; walk it from the parent up.
  const ancestors = toSeedAncestors(
    ancestorRows.filter((row) => row.projectId === ctx.projectId),
    statuses,
  );
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const a = ancestors[i]!;
    if (!a.archived && a.statusCategory !== 'done') {
      return { targetKey: a.key, targetResolution: 'nearest_open_ancestor' };
    }
  }
  return { targetKey: null, targetResolution: 'none' };
}

/** The comment `close` leaves on the card — the turn's own summary. */
export function guideCloseComment(messageMd: string): string {
  return `**Closed after a guided walk with Motir AI.**\n\n${messageMd}`;
}

/**
 * Land ONE action against the card as it stands. Returns its outcome; a guard's
 * refusal comes back as `skipped` with the reason. Mutates `card.rows` to the
 * list as it stands after a saved-list write, so the next action reads it.
 */
async function landOne(
  action: GuideAction,
  index: number,
  card: LandingCard,
  temporary: { active: boolean; rows: GuideRowInput[] },
  turn: GuideTurn,
  ctx: ProjectContext,
): Promise<GuideActionOutcome> {
  const actor = actorOf(ctx);
  const recorded: GuideActionOutcome = { type: action.type, outcome: 'recorded' };
  const landed = (todoId?: string): GuideActionOutcome => ({
    type: action.type,
    outcome: 'landed',
    ...(todoId ? { todoId } : {}),
  });
  const tempHas = (id: string) => temporary.rows.some((r) => r.id === id);
  const tempTicked = (id: string) => temporary.rows.find((r) => r.id === id)?.done === true;
  /** A correction's row on the temporary list — ticked or not (A3.9 (b)). */
  const tempRow = (id: string) => {
    if (!tempHas(id)) throw new Skip('that step is not on the list');
  };

  switch (action.type) {
    case 'propose_todos':
      if (card.rows.length > 0) throw new Skip('the card already has a list');
      return recorded;

    case 'current_step':
    case 'offer_close':
      return recorded;

    case 'local_agent_prompt': {
      // A prompt for the person's LOCAL agent writes nothing to the card (A3.9 (a)):
      // it is recorded on the conversation. It still names a step on the list.
      if (temporary.active) tempRow(action.rowId);
      else savedRow(card, action.rowId);
      return recorded;
    }

    case 'write_todos': {
      // A proposal never overwrites a list.
      if (card.rows.length > 0) throw new Skip('the card already has a list');
      let lastId: string | null = null;
      for (const row of action.rows) {
        const added = await workItemTodosService.addTodo(
          card.item.id,
          {
            text: row.text,
            notesMd: row.notesMd,
            commandText: row.commandText,
            ...(row.executor ? { executor: row.executor } : {}),
          },
          actor,
        );
        lastId = added.todo.id;
        if (row.done) await workItemTodosService.setTodoDone(added.todo.id, true, actor);
      }
      card.rows = await readRows(card.item, ctx);
      temporary.active = false;
      temporary.rows = [];
      return landed(lastId ?? undefined);
    }

    case 'tick':
    case 'untick': {
      const done = action.type === 'tick';
      if (temporary.active) {
        if (!tempHas(action.rowId)) throw new Skip('that step is not on the list');
        if (tempTicked(action.rowId) === done)
          throw new Skip('that step was already in that state');
        temporary.rows = temporary.rows.map((r) => (r.id === action.rowId ? { ...r, done } : r));
        return recorded;
      }
      const row = savedRow(card, action.rowId);
      if (row.done === done) throw new Skip('that step was already in that state');
      await workItemTodosService.setTodoDone(row.id, done, actor, { workItemId: card.item.id });
      card.rows = card.rows.map((r) => (r.id === row.id ? { ...r, done } : r));
      return landed(row.id);
    }

    case 'add_step': {
      if (temporary.active) return recorded;
      if (card.rows.length === 0) throw new Skip('the card has no list to add a step to');
      const toIndex = indexAfter(card.rows, null, action.afterRowId);
      const added = await workItemTodosService.addTodo(
        card.item.id,
        {
          text: action.text,
          notesMd: action.notesMd,
          commandText: action.commandText,
          ...(action.executor ? { executor: action.executor } : {}),
        },
        actor,
      );
      if (toIndex !== card.rows.length) {
        await workItemTodosService.moveTodo(added.todo.id, toIndex, actor);
      }
      card.rows = await readRows(card.item, ctx);
      return landed(added.todo.id);
    }

    case 'revise_step': {
      if (temporary.active) {
        tempRow(action.rowId);
        return recorded;
      }
      const row = savedRow(card, action.rowId);
      await workItemTodosService.updateTodo(
        row.id,
        {
          ...(action.text !== undefined ? { text: action.text } : {}),
          ...(action.notesMd !== undefined ? { notesMd: action.notesMd } : {}),
          ...(action.commandText !== undefined ? { commandText: action.commandText } : {}),
          ...(action.executor !== undefined ? { executor: action.executor } : {}),
        },
        actor,
      );
      card.rows = await readRows(card.item, ctx);
      return landed(row.id);
    }

    case 'remove_step': {
      if (temporary.active) {
        tempRow(action.rowId);
        return recorded;
      }
      const row = savedRow(card, action.rowId);
      await workItemTodosService.deleteTodo(row.id, actor);
      card.rows = card.rows.filter((r) => r.id !== row.id);
      return landed(row.id);
    }

    case 'move_step': {
      if (temporary.active) {
        tempRow(action.rowId);
        return recorded;
      }
      const row = savedRow(card, action.rowId);
      await workItemTodosService.moveTodo(
        row.id,
        indexAfter(card.rows, row.id, action.afterRowId),
        actor,
      );
      card.rows = await readRows(card.item, ctx);
      return landed(row.id);
    }

    case 'edit_item': {
      // The GUIDED card only, and only these three fields (A2.5) — the parser
      // already refused any other field, so the patch is built from them alone.
      const fresh = await workItemsService.getWorkItem(card.item.id, actor);
      const patch = {
        ...(action.title !== undefined ? { title: action.title } : {}),
        ...(action.descriptionMd !== undefined ? { descriptionMd: action.descriptionMd } : {}),
        ...(action.explanationMd !== undefined ? { explanationMd: action.explanationMd } : {}),
      };
      card.item = await workItemsService.updateWorkItem(card.item.id, patch, actor, {
        expectedUpdatedAt: fresh.updatedAt,
      });
      return landed();
    }

    case 'cannot_do': {
      const current = [...turn.actions]
        .reverse()
        .find(
          (a): a is Extract<GuideAction, { type: 'current_step' }> => a.type === 'current_step',
        );
      const step = current
        ? (card.rows.find((r) => r.id === current.rowId)?.text ??
          temporary.rows.find((r) => r.id === current.rowId)?.text ??
          null)
        : (card.rows.find((r) => !r.done)?.text ?? null);
      await commentsService.addComment(
        card.item.id,
        { bodyMd: guideCannotDoComment(action.reason, step) },
        actor,
      );
      return landed();
    }

    case 'needs_replan': {
      // A reason-only `needs_replan` comments exactly as it always has.
      if (action.requestMd === undefined) {
        await commentsService.addComment(
          card.item.id,
          { bodyMd: guideNeedsReplanComment(action.reason) },
          actor,
        );
        return landed();
      }
      if (card.replanOffer) throw new Skip('a guide turn carries one re-plan offer');
      const requestedTargetKey = action.targetKey ?? null;
      const { targetKey, targetResolution } = await resolveReplanTarget(
        requestedTargetKey,
        card.item,
        ctx,
      );
      await commentsService.addComment(
        card.item.id,
        { bodyMd: guideNeedsReplanComment(action.reason, targetKey) },
        actor,
      );
      card.replanOffer = {
        reason: action.reason,
        requestMd: action.requestMd,
        requestedTargetKey,
        targetKey,
        targetResolution,
        declinedAt: null,
        declinedById: null,
        confirmedAt: null,
        confirmedById: null,
        confirmedSessionId: null,
      };
      return landed();
    }

    case 'file_bug': {
      // One per turn (decision MOTIR-7798 Q3); the per-conversation bound is
      // held under the session's row lock inside the filing itself.
      if (card.bugsFiledThisTurn >= GUIDE_BUGS_PER_TURN) {
        throw new Skip('a guide turn files at most one bug');
      }
      try {
        const filed = await guideBugFilingService.fileGuideBug(
          action,
          { id: card.sessionId },
          card.item,
          ctx,
        );
        card.bugsFiledThisTurn += 1;
        return { type: action.type, outcome: 'landed', workItemKey: filed.key };
      } catch (err) {
        if (err instanceof GuideBugCapExceededError) {
          throw new Skip(
            `this conversation has already filed ${err.filed} bugs, the most one guide conversation may file`,
          );
        }
        if (err instanceof GuideBugDuplicateError) {
          throw new Skip(`already filed as ${err.existingKey}`, err.existingKey);
        }
        throw err;
      }
    }

    case 'close': {
      const list = temporary.active ? temporary.rows : card.rows;
      if (list.length === 0 || list.some((r) => !r.done)) {
        throw new Skip('not every step is ticked');
      }
      if (await hasLinkedPullRequest(card.item, ctx)) {
        throw new Skip(GUIDE_SKIP_LINKED_PULL_REQUEST);
      }
      const path = await walkToDone(card.item, ctx);
      if (path === null) throw new Skip('the workflow has no way from here to Done');
      try {
        for (const key of path) {
          card.item = await workItemsService.updateStatus(card.item.id, key, actor);
        }
      } catch (err) {
        // A pending approval owns the card's status (MOTIR-4887). The guide never
        // moves past it — and decides it ONLY when it is the manual-work question,
        // whose answer IS this close (`manual-work-gate.md` §5; A2.6 row 2).
        if (err instanceof ApprovalGatePendingError) {
          if (err.gateKind === 'manual_work' && err.gateId) {
            await markManualWorkDone(err.gateId, actor);
            card.item = await workItemsService.getWorkItem(card.item.id, actor);
          } else {
            throw new Skip(
              'an approval waiting on this card owns its status — decide it on the card',
            );
          }
        } else {
          throw err;
        }
      }
      await commentsService.addComment(
        card.item.id,
        { bodyMd: guideCloseComment(turn.messageMd) },
        actor,
      );
      return landed();
    }
  }
  // Unreachable: the parser admits only the closed set.
  void index;
  throw new Skip('not an action this build lands');
}

/**
 * THE GUIDE'S CONSENTED CLOSE DECIDES A PENDING `manual_work` GATE (MOTIR-7474;
 * `manual-work-gate.md` §5, `conversation-turn-intent.md` A2.6 row 2) — through the
 * decide door, as the person whose turn it was, never around it. Mark done is the
 * gate's `approve`: the door records the decision and writes Done.
 *
 * `DECIDED_WITHOUT_A_READER`: the person consented in the conversation and was never
 * shown the gate's render, so there is no stamp to hand back. Nothing about manual
 * work has a version (§1), so the stale check has nothing to protect here. A refusal
 * from the door (not their card to decide, already decided) becomes a skip.
 */
async function markManualWorkDone(gateId: string, actor: ServiceContext): Promise<void> {
  try {
    await approvalGatesService.decide(
      { gateId, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      actor,
    );
  } catch (err) {
    if (err instanceof ApprovalGateError) {
      throw new Skip(
        'the work waiting on this card could not be marked done — mark it on the card',
      );
    }
    throw err;
  }
}

/**
 * Why NOTHING may land on the card as it stands, or `null` when the turn may land:
 * the door's own gate 5 (A2.7), re-read at landing because the card can be
 * archived or finished while the turn's job runs (MOTIR-7817).
 */
async function closedSinceSent(item: WorkItemDto, ctx: ProjectContext): Promise<string | null> {
  if (item.archivedAt) return 'the card was archived while this turn ran';
  const terminal = await workflowsService.getTerminalStatusKeys(ctx.projectId, ctx.workspaceId);
  if (terminal.has(item.status)) return 'the card was finished while this turn ran';
  return null;
}

export const guideLandingService = {
  /**
   * Read a settled `guide_work_item` job and land what it produced. REPLAYABLE:
   * see the header. `turn` is the `user` turn the job ran for.
   */
  async land(
    input: { jobId: string; turn: PlanChangeTurnDto; result: GuideTurn },
    session: PlanChangeSessionDto,
    ctx: ProjectContext,
  ): Promise<GuideSettleResult> {
    const address = { sessionId: session.id };
    const itemKey = session.targetKeys[0];
    if (!itemKey) throw new PlanChangeSessionNotFoundError(ctx.projectId);

    // The card, as it stands, gated as the person: browse through the keyed
    // read, and the edit permission every landing write needs.
    const item = await workItemsService.getWorkItemByIdentifier(
      ctx.projectId,
      itemKey,
      actorOf(ctx),
    );
    await projectAccessService.assertPermission(ctx.projectId, actorOf(ctx), 'work_item:edit');

    const claimed = await planChangeSessionsService.claimGuideLanding(input.turn.id, ctx, address);
    if (!claimed) return { outcome: 'silent', session };

    const card: LandingCard = {
      item,
      rows: await readRows(item, ctx),
      sessionId: session.id,
      bugsFiledThisTurn: 0,
      replanOffer: null,
    };
    const derived = deriveTemporaryList(recordsOf(session));
    const temporary = { active: card.rows.length === 0 && derived.length > 0, rows: derived };
    const startedTemporary = card.rows.length === 0;

    const outcomes: GuideActionOutcome[] = [];
    const closed = await closedSinceSent(item, ctx);
    for (const [i, action] of input.result.actions.entries()) {
      if (closed) {
        outcomes.push({ type: action.type, outcome: 'skipped', reason: closed });
        continue;
      }
      try {
        outcomes.push(await landOne(action, i, card, temporary, input.result, ctx));
      } catch (err) {
        // A guard's refusal, or a write the owning service refused inside its own
        // transaction (so it committed nothing): recorded, and the turn goes on.
        if (
          err instanceof Skip ||
          err instanceof WorkItemError ||
          err instanceof WorkItemTodoNotFoundError ||
          err instanceof EmptyTodoTextError ||
          err instanceof TodoTextTooLongError ||
          err instanceof TodoNotesTooLongError ||
          err instanceof TodoCommandTooLongError ||
          err instanceof TodoReorderConflictError ||
          err instanceof CommentForbiddenError ||
          err instanceof PermissionDeniedError ||
          err instanceof ProjectAccessDeniedError
        ) {
          outcomes.push({
            type: action.type,
            outcome: 'skipped',
            reason: err instanceof Skip ? err.message : 'the card refused the change',
            ...(err instanceof Skip && err.workItemKey ? { workItemKey: err.workItemKey } : {}),
          });
          continue;
        }
        throw err;
      }
      // A proposal on a card with no rows starts the temporary walk for the
      // rest of THIS turn too.
      if (action.type === 'propose_todos' && outcomes.at(-1)?.outcome === 'recorded') {
        temporary.active = true;
        temporary.rows = action.rows.map((r) => ({ ...r, done: false }));
      }
    }

    const record: GuideTurnRecord = {
      actions: input.result.actions,
      outcomes,
      temporary:
        startedTemporary &&
        !outcomes.some(
          (o, i) => o.outcome === 'landed' && input.result.actions[i]!.type === 'write_todos',
        ),
      replanOffer: card.replanOffer,
    };
    const updated = await planChangeSessionsService.appendGuideReplyTurn(
      {
        jobId: input.jobId,
        body: guideReplyBody(input.result.messageMd, input.result.actions, outcomes),
        record,
      },
      ctx,
      address,
    );
    return { outcome: 'guided', session: updated, record };
  },

  /**
   * Decline the re-plan offer on a guide reply turn (MOTIR-8689). Stored under the
   * conversation's own lock; plans nothing, spends nothing, writes nothing else.
   */
  async declineReplanOffer(
    turnId: string,
    ctx: ProjectContext,
    opts: { sessionId: string },
  ): Promise<PlanChangeSessionDto> {
    return planChangeSessionsService.declineGuideReplanOffer(turnId, ctx, {
      sessionId: opts.sessionId,
    });
  },

  /**
   * The settle door for a guide turn: find the `user` turn the job ran for,
   * replay a landed one, read the job, and land it. A job id this thread never
   * submitted yields the thread as it stands.
   */
  async settle(
    jobId: string,
    ctx: ProjectContext,
    opts: { sessionId: string },
  ): Promise<GuideSettleResult> {
    const session = await planChangeSessionsService.getById(ctx, opts.sessionId);
    if (session.origin !== 'guide') throw new PlanChangeSessionNotFoundError(ctx.projectId);
    const turn = session.turns.find((t) => t.role === 'user' && t.jobId === jobId);
    if (!turn) return { outcome: 'silent', session };

    const reply = session.turns.find((t) => t.role === 'assistant' && t.jobId === jobId);
    if (reply) {
      return reply.guide
        ? { outcome: 'guided', session, record: reply.guide }
        : { outcome: 'silent', session };
    }

    const job = await getJob(jobId, ctx.projectId);
    // Still running: nothing to land yet, and nothing is decided.
    if (job.status === 'queued' || job.status === 'running') return { outcome: 'silent', session };
    // Nothing lands from a turn that did not run (A2.4).
    if (job.status !== 'succeeded' || !job.result?.guideTurn) return { outcome: 'failed', session };
    const result = parseGuideTurn(job.result.guideTurn);
    return guideLandingService.land({ jobId, turn, result }, session, ctx);
  },
};
