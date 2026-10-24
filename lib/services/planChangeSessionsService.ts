import {
  Prisma,
  type Plan,
  type PlanChangeSession,
  type PlanChangeTurn,
  type PlanChangeTurnConfirm,
  type PlanChangeTurnIntent,
  type PlanChangeTurnOutage,
  type PlanChangeTurnRole,
} from '@/generated/prisma/client';

import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import {
  planChangeSessionRepository,
  type PlanChangeSessionUpdateInput,
} from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import {
  anchorOf,
  isPickSeedGate,
  isPlanningSeedGate,
  readChosenOption,
  refusalSeedAnchorsOnParent,
  toSeedAncestors,
} from '@/lib/planning/refusalSeed';
import { workflowsService } from '@/lib/services/workflowsService';
import { CLEARED_FAILURE_COLUMNS, sessionWaitingState } from '@/lib/planChange/sessionWaitingState';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { offerTurns, planOfferService } from '@/lib/services/planOfferService';
import { pendingPlanOfferOf } from '@/lib/planChange/planOffer';
import {
  clearWithin as clearPlanningSessionGate,
  raiseWithin as raisePlanningSessionGate,
} from '@/lib/services/planningSessionGateService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { planSessionsService } from '@/lib/services/planSessionsService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { aiSharpenService } from '@/lib/services/aiSharpenService';
import { toCarriedAnswers } from '@/lib/mappers/sharpenMappers';
import { toPlanChangeSessionDto } from '@/lib/mappers/planChangeMappers';
import { planChangeMailboxRepository } from '@/lib/repositories/planChangeMailboxRepository';
import { planChangeRunPauseRepository } from '@/lib/repositories/planChangeRunPauseRepository';
import { parseWorkItemTokenIds } from '@/lib/mentions/workItemRefs';
import { normalizeBodyRefs } from '@/lib/workItems/normalizeBodyRefs';
import { resolveWorkItemRefSummaries } from '@/lib/workItems/resolveWorkItemRefs';
import { readPlanningTurn } from '@/lib/planning/plannerTurn';
import { readCodeUnreadable } from '@/lib/planning/codeUnreadable';
import { readCodeUnsearchable, type CodeUnsearchableRepo } from '@/lib/planning/codeUnsearchable';
import { getJob } from '@/lib/ai/motirAiClient';
import type { CarriedAnswers, SubmittedRequirement } from '@/lib/ai/types';
import { turnSubmitKey } from '@/lib/ai/turnSubmitKey';
import { readGuideTurnRecord, type GuideTurnRecord } from '@/lib/ai/guideWorkItem';
import type {
  AnswerOfferInput,
  CopyableSessionDto,
  DebugLandingDto,
  PlanChangeSessionDto,
  PlanChangeSubmitResultDto,
  PlanOfferRestartResultDto,
  PlanSessionRestartResultDto,
  ResumableSessionDto,
} from '@/lib/dto/planChange';
import { planRepository } from '@/lib/repositories/planRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { planRevisionsService } from '@/lib/services/planRevisionsService';
import { plansService } from '@/lib/services/plansService';
import { planDriftService } from '@/lib/services/planDriftService';
import { PlanNotFoundError, PlanRevisionInFlightError } from '@/lib/plans/errors';
import { planChangeMailboxService } from '@/lib/services/planChangeMailboxService';
import { classifyFailedWaitingTurn } from '@/lib/planChange/failedWaitingTurn';
import { isReopenedByRevision, revisionLeaseJobId } from '@/lib/planChange/revisionLease';
import {
  classifySessionTurn,
  type SessionTurnPlanStatus,
} from '@/lib/planChange/classifySessionTurn';
import { PermissionDeniedError } from '@/lib/projects/errors';
import {
  EmptyPlanChangeIntentError,
  EmptyPlanChangeTurnError,
  GuideSessionNotPlannableError,
  PlanSessionAwaitingResumeError,
  GuideReplanOfferAlreadyConfirmedError,
  GuideReplanOfferNotFoundError,
  GuideReplanOfferNotOpenError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
  PlanChangeTurnNotFoundError,
  PlanSeedNotApplicableError,
  PlanSessionEndedError,
  PlanSessionNotCopyableError,
  PlanSessionNotFoundError,
  PlanSessionPlanDecidedError,
  PlanSessionPlanStaleError,
  PlanAgainNotAvailableError,
  PlanChangeJobNotRunningError,
  PlanChangeMailboxJobMismatchError,
  PlanOfferStartRefusedError,
  type StalePlanFinishedCard,
} from '@/lib/planChange/errors';
import { PROJECT_SCOPE_KEY, type PlanChangeScope } from '@/lib/planChange/scope';
import { offerRestartStopKey } from '@/lib/planChange/offerRestart';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { endSession, endSessionWithin } from '@/lib/services/planSessionEndService';
import { replanOfferOf, replanOfferStateOf } from '@/lib/planning/guideReplanOffer';
import { KEEP_PLANNING_MARKER_BODY, NEW_SESSION_CONFIRM_BODY } from '@/lib/planChange/restart';

/**
 * How a write ADDRESSES its session (AMENDMENT 17 §2, story MOTIR-6011): by its
 * ID. A scope holds many sessions over time, so the id is the only address that
 * names exactly one. (The scope-key compatibility address MOTIR-6021 kept for
 * the doors' migration was removed with its last caller, MOTIR-6028.)
 */
export type PlanChangeSessionAddress = { sessionId: string };

// The plan-change CONVERSATION seam (Story 7.30 · MOTIR-1728) — what makes
// changing a plan a dialogue instead of a one-shot prompt.
//
// WHAT THIS IS NOT: a new AI capability. The engine is untouched — MOTIR-899
// (augment) and MOTIR-1347 (modify/remove ops) already emit the deltas, and
// MOTIR-902 already ships `POST /api/ai/augment` plus the job / stream / approve
// routes. This service COMPOSES a conversation on top of that contract: it
// accumulates the user's turns and submits their accumulated intent as ONE
// ordinary `augment` job. No new job kind, no motir-ai change. (If the engine
// ever needs conversation-NATIVE context — the turns as structured history
// rather than one accumulated prompt — that is a separate motir-ai card, not an
// absorption into this one: ONE SUBTASK = ONE REPO = ONE PR.)
//
// WHY PERSISTED and not client state: a conversation that evaporates on reload
// is not a conversation. The thread is a row, so re-opening the planning
// workspace RESUMES it, and the accumulated context is what the job actually
// receives rather than whatever a component happened to still hold.
//
// 4-layer + concurrency (CLAUDE.md): this service owns the transactions and the
// DTO mapping; the repositories are single-op leaves. Appending a turn is
// READ-DERIVED — the next `seq` comes from the session's `turnCount` — so the
// append locks the session row (`SELECT … FOR UPDATE`) and RE-READS it inside
// the transaction before allocating (the lock-before-read-derived-update rule);
// the `(session_id, seq)` unique is the DB backstop, translated from P2002 to a
// typed `PlanChangeTurnConflictError` so no raw Prisma error escapes.
//
// SIDE-EFFECTS-OUTSIDE-TX (CLAUDE.md): submitting calls motir-ai over the
// network. That happens BEFORE the short transaction that records the marker
// turn — a conversation row is never locked across a motir-ai round-trip. (It is
// also structurally forced: `submitAugment` opens its own transactions, and
// Prisma cannot nest interactive ones.)

/**
 * Build the intent submitted to the plan-edit job from the thread's `user`
 * turns, IN ORDER. This is the whole point of the seam: the engine receives the
 * ACCUMULATED refinement, not just the latest message, so "make them smaller"
 * still carries "add auth to the billing epic" from three turns ago.
 *
 * A SINGLE-turn thread renders byte-identically to the turn itself — so a
 * one-shot change through the conversation is exactly the prompt the shipped
 * "Augment from prompt" path sent, with no added framing to shift the engine's
 * behaviour. Only a genuine multi-turn thread gets the numbered framing, which
 * states the one thing the engine cannot infer from a concatenation: later turns
 * REFINE earlier ones rather than contradicting them.
 *
 * Exported for direct unit testing — it is pure, and it is the contract the rail
 * and the engine meet on.
 */
export function buildAccumulatedIntent(
  turns: Array<Pick<PlanChangeTurn, 'role' | 'body'>>,
): string {
  const userTurns = turns.filter((t) => t.role === 'user').map((t) => t.body.trim());
  if (userTurns.length === 0) return '';
  if (userTurns.length === 1) return userTurns[0]!;
  const numbered = userTurns.map((body, i) => `${i + 1}. ${body}`).join('\n');
  return (
    `Plan change requested across ${userTurns.length} turns of one conversation. ` +
    `Apply the ACCUMULATED intent below as a single change — later turns REFINE ` +
    `earlier ones rather than replacing them:\n\n${numbered}`
  );
}

/**
 * What a FAILED-WAITING session's overlay needs beyond the failure itself (Story MOTIR-7905 ·
 * MOTIR-7918 / MOTIR-7941): whether its way on is **Resume** — the SAME classifier the submit
 * door refuses by (`classifyFailedWaitingTurn`'s `refuse_resume`), so the screen and the server
 * cannot disagree — and the plan that WAITS for the person beside it, if any (the session's most
 * recent undecided `planned` / `stale` plan).
 */
async function failedWaitingShape(
  row: PlanChangeSession,
  pctx: ProjectContext,
  tx?: Prisma.TransactionClient,
): Promise<{
  resumable: boolean;
  waitingPlan: { planId: string; title: string | null; status: 'planned' | 'stale' } | null;
}> {
  const read = async (t: Prisma.TransactionClient) => {
    const rows = await planRepository.listUndecidedBySession(row.id, t);
    return Promise.all(rows.map(async (p) => ({ ...p, status: await turnStatusOf(p, t) })));
  };
  const plans = tx
    ? await read(tx)
    : await withWorkspaceServiceContext(pctx.workspaceId, (t) => read(t));
  const resumable =
    classifyFailedWaitingTurn({
      waiting: sessionWaitingState(row),
      failedJobId: row.failedJobId,
      failureResumable: row.failureResumable,
      plans,
    }) === 'refuse_resume';
  // Newest first (the repository orders it): the first `planned` / `stale` one waits.
  const waiting = plans.find((p) => p.status === 'planned' || p.status === 'stale');
  return {
    resumable,
    waitingPlan: waiting
      ? {
          planId: waiting.id,
          title: waiting.title,
          status: waiting.status === 'stale' ? 'stale' : 'planned',
        }
      : null,
  };
}

/** Read a session's thread and map both to the DTO. `tx` joins a surrounding
 *  transaction (an append returns the thread it just extended).
 *
 *  The thread's `assistant` bodies carry `[KEY](motir:<id>)` tokens (normalized
 *  at write time by {@link recordPlannerTurn}), so their summaries are resolved
 *  here — ONE resolve for the whole thread — and threaded to the rail, which
 *  renders them through the shipped `WorkItemRefChip` path exactly as the detail
 *  page and the comment thread do. A thread with no references pays nothing:
 *  `resolveWorkItemRefSummaries` returns `{}` for an empty ref set. */
async function toDto(
  row: PlanChangeSession,
  pctx: ProjectContext,
  tx?: Prisma.TransactionClient,
): Promise<PlanChangeSessionDto> {
  // Bound when the caller holds no transaction (MOTIR-2846). Forwarding a `tx?`
  // that may be undefined into a bindable read looks bound at this line and is
  // not: under `motir_app` the turn list came back empty and every conversation
  // rendered as having no history.
  const turns = tx
    ? await planChangeTurnRepository.listBySessionId(row.id, pctx.workspaceId, tx)
    : await withWorkspaceServiceContext(pctx.workspaceId, (t) =>
        planChangeTurnRepository.listBySessionId(row.id, pctx.workspaceId, t),
      );
  const ids = turns
    .filter((t) => t.role === 'assistant')
    .flatMap((t) => parseWorkItemTokenIds(t.body));
  // An ANSWER's citations are stored as IDENTIFIERS, not as `motir:` id tokens
  // in the body, so they ride the `keys` half of the same ONE resolve
  // (MOTIR-1818). Two reasons they are not left to the client: the rail must
  // render a citation through the shipped `WorkItemRefChip` path exactly as the
  // detail page does, and resolving them here keeps a citation chip's title
  // subject to the same access checks as everything else on the thread.
  const citedKeys = turns.flatMap((t) => t.citations);
  // A guide turn's `file_bug` outcomes name a bug by KEY — the one it filed, or
  // the existing one a duplicate was refused as (MOTIR-7811). The rail draws it
  // as a chip, so it rides the same resolve under the same access checks.
  const filedKeys = turns.flatMap((t) => {
    const record = t.role === 'assistant' ? readGuideTurnRecord(t.guideTurn) : null;
    return (record?.outcomes ?? []).flatMap((o) =>
      o.type === 'file_bug' && o.workItemKey ? [o.workItemKey] : [],
    );
  });
  const workItemRefs = await resolveWorkItemRefSummaries(
    { ids: [...new Set(ids)], keys: [...new Set([...citedKeys, ...filedKeys])] },
    pctx.projectId,
    { userId: pctx.userId, workspaceId: pctx.workspaceId },
  );
  // A guide thread's files (MOTIR-7486), resolved once as the caller may see them.
  const fileIds = turns.flatMap((t) => t.attachmentIds);
  // The planner's latest mid-run pause on the CURRENT run (MOTIR-8007). One indexed
  // read, and only for a session that has a run.
  const runPause = row.lastJobId
    ? tx
      ? await planChangeRunPauseRepository.findLatestForSession(
          row.id,
          row.lastJobId,
          pctx.workspaceId,
          tx,
        )
      : await withWorkspaceServiceContext(pctx.workspaceId, (t) =>
          planChangeRunPauseRepository.findLatestForSession(
            row.id,
            row.lastJobId!,
            pctx.workspaceId,
            t,
          ),
        )
    : null;
  // Whether the run has READ the answer's mailbox entry: a reloaded rail has no live
  // mailbox poll yet, and this is what lets it say "planning resumed" (MOTIR-7990).
  const answerEntryId = runPause?.mailboxEntryId ?? null;
  const readAnswerEntry = async (t: Prisma.TransactionClient): Promise<boolean> => {
    const [entry] = await planChangeMailboxRepository.findTurnsByIds(
      [answerEntryId!],
      row.id,
      row.lastJobId!,
      pctx.workspaceId,
      t,
    );
    return entry ? entry.consumedAt !== null : false;
  };
  const entryRead = answerEntryId
    ? tx
      ? await readAnswerEntry(tx)
      : await withWorkspaceServiceContext(pctx.workspaceId, readAnswerEntry)
    : undefined;
  const mapped = toPlanChangeSessionDto(row, turns, workItemRefs, runPause, entryRead);
  // Every offer's two DERIVED fields (MOTIR-9290), resolved where every turn DTO is
  // built so no reader sees a stored offer without its state.
  const offers = await planOfferService.resolveFor(row.id, turns, pctx, tx);
  const base =
    offers.size === 0
      ? mapped
      : {
          ...mapped,
          turns: mapped.turns.map((t) => {
            const resolved = t.offer ? offers.get(t.id) : undefined;
            return resolved ? { ...t, offer: { ...t.offer!, ...resolved } } : t;
          }),
        };
  // Whether a FAILED session holds a half-written walk that only Resume continues, or a plan
  // that waits for the person (situation 2) — the one fact the overlay needs to choose between
  // Resume + a held composer and the decide door + an open one (MOTIR-7918 / MOTIR-7941). The
  // SAME classifier the submit door refuses by, so the screen and the server cannot disagree.
  const shape = base.failure ? await failedWaitingShape(row, pctx, tx) : null;
  const dto = shape
    ? {
        ...base,
        failure: { ...base.failure!, resumable: shape.resumable },
        failedWaiting: shape.resumable ? ('resume' as const) : ('reply' as const),
        waitingPlan: shape.waitingPlan,
      }
    : base;
  if (fileIds.length === 0) return dto;
  const attachments = await attachmentsService.listViewableByIds(fileIds, {
    userId: pctx.userId,
    workspaceId: pctx.workspaceId,
  });
  return { ...dto, attachments };
}

/**
 * Assert the actor may run the PLANNER on this project — `ai:plan`
 * (Story MOTIR-2291 · Subtask MOTIR-2355).
 *
 * ⚠️ IT REPLACES `assertCanEdit`, AND THE TWO ARE NOT THE SAME ACTOR SET. Editing
 * a work item and submitting a planning job look alike from a route — both are
 * writes a member does — but a planning job SPENDS THE WORKSPACE'S AI CREDITS,
 * and `work_item:edit` is held by the implicit workspace-member grant while
 * `ai:plan` deliberately is not (`docs/decisions/member-facing-permissions.md`
 * §2). So a workspace member with no membership on THIS project could open a
 * plan-change thread and run the planner on somebody else's project, on the
 * workspace's bill. That is the case this card is really about, and it does not
 * follow from the viewer case.
 */
async function assertCanPlan(projectId: string, ctx: ServiceContext): Promise<void> {
  await projectAccessService.assertPermission(projectId, ctx, 'ai:plan');
}

/** Resolve the ADDRESSED conversation — the shared precondition of every write
 *  (AMENDMENT 17 §2: by id; a session of another project is
 *  `PLAN_SESSION_NOT_FOUND`). Gated on `ai:plan`: every caller mutates it. */
async function requireSession(
  pctx: ProjectContext,
  address: PlanChangeSessionAddress,
): Promise<PlanChangeSession> {
  const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
  await assertCanPlan(pctx.projectId, ctx);
  return findSessionById(pctx, address.sessionId);
}

/** One session BY ID in this project, or the typed `PLAN_SESSION_NOT_FOUND` — an
 *  id from another project never resolves to a sibling session of the same
 *  scope (AMENDMENT 17 §2). Gate-free: the callers assert their own permission. */
async function findSessionById(
  pctx: ProjectContext,
  sessionId: string,
): Promise<PlanChangeSession> {
  const session = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
    planChangeSessionRepository.findByIdInProject(sessionId, pctx.projectId, pctx.workspaceId, tx),
  );
  if (!session) throw new PlanSessionNotFoundError(sessionId);
  return session;
}

/**
 * Append one turn under the session's row lock. Shared by the user-turn append,
 * the submission marker AND the planner's own turn so ALL THREE allocate `seq`
 * the same safe way — a second allocation route for assistant turns would
 * quietly reintroduce exactly the lost-append race this one guards.
 * Returns the updated session row (its `turnCount` bumped, plus any extra patch).
 *
 * `skipIf` is an IDEMPOTENCY gate evaluated INSIDE the lock, for callers whose
 * append may legitimately be replayed (the planner turn, whose recording the
 * client can re-issue on a reload or from a second tab). Returning true skips
 * the insert and yields the thread as it already stands. It has to run under the
 * lock, not before it: checked outside, two concurrent replays would both see
 * "not there yet" and both insert.
 */
/**
 * Keep only the citations that name a work item IN THIS PROJECT, in the order
 * the answer gave them (MOTIR-1818; ADR §1).
 *
 * Three things it drops, and each is a real failure mode of a grounded answer:
 * a key the model invented, a key that resolves in ANOTHER project (the read is
 * `projectId`-scoped, so a cross-tenant identifier simply does not come back),
 * and a duplicate. What survives is a list the rail can render as chips knowing
 * every one of them opens something.
 *
 * BOUND, and deliberately so (MOTIR-2846's shape): `findByIdentifiers` falls
 * back to the `db` singleton when handed no `tx`, and `work_item` is
 * workspace-keyed — so an unbound read under `motir_app` matches no row, returns
 * `[]`, and every citation would be silently dropped as "unresolvable". That
 * failure has no error and no log; it just looks like an answer that cited
 * nothing. This runs before `appendLocked` opens its short write lock
 * (side-effects and reads that need no lock stay outside it), so it opens its
 * own read-only binding rather than threading a `tx` that does not exist yet.
 */
async function resolveCitations(
  citations: readonly string[],
  pctx: ProjectContext,
): Promise<string[]> {
  const wanted = [...new Set(citations.map((c) => c.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const rows = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
    workItemRepository.findByIdentifiers(pctx.projectId, wanted, tx),
  );
  const known = new Set(rows.map((r) => r.identifier));
  return wanted.filter((c) => known.has(c));
}

/** The English the declined-turn row carries (MOTIR-8141): never rendered — the rail draws
 *  `planningWorkspace.codeUnreadable.planBody` from the stored face — but every turn row
 *  has a non-empty body, and this is the one a reader of the table meets. */
const DECLINED_FALLBACK_BODY =
  "I can't read your code right now, so I haven't changed your plan. Motir is on it.";

/** The English the unsearchable-code turn row carries (MOTIR-9167): never rendered — the
 *  overlay draws its banner from the stored repository list — but every turn row has a
 *  non-empty body. */
const UNSEARCHABLE_FALLBACK_BODY =
  "I can't search your code yet, so I haven't planned. Once it can be searched, continue the conversation.";

interface AppendTurn {
  role: PlanChangeTurnRole;
  body: string;
  jobId?: string | null;
  authorId?: string | null;
  question?: string | null;
  isAnswer?: boolean;
  intent?: PlanChangeTurnIntent | null;
  citations?: string[];
  /** A `user` turn's resolved anchor identifier (MOTIR-7064). */
  anchorKey?: string | null;
  /** A debug reply's landing (MOTIR-7064), persisted with the reply itself. */
  debugLanding?: DebugLandingDto | null;
  /** A guide reply's record (MOTIR-7470), persisted with the reply itself. */
  guideTurn?: GuideTurnRecord | null;
  /** A guide `user` turn's files (MOTIR-7484) — ids the caller already validated. */
  attachmentIds?: readonly string[];
  /** The fixed confirm core writes on an `assistant` turn (MOTIR-7649). */
  confirm?: PlanChangeTurnConfirm | null;
  /** How a code-graph outage touched this `assistant` turn (MOTIR-8141). */
  codeUnreadable?: PlanChangeTurnOutage | null;
  /** The target repositories whose code could not be SEARCHED, when the conversation stopped for that (MOTIR-9167). */
  codeUnsearchable?: CodeUnsearchableRepo[] | null;
  /** The planning job running when a `user` turn was typed (MOTIR-7996). */
  runJobId?: string | null;
  /** The text an `assistant` answer offered to forward (MOTIR-7996). */
  forwardOffer?: string | null;
  /** The ONE offer an `assistant` answer ended with (MOTIR-9288), stored undecided. */
  answerOffer?: AnswerOfferInput | null;
}

async function appendLocked(
  session: PlanChangeSession,
  pctx: ProjectContext,
  turn: AppendTurn,
  patch: PlanChangeSessionUpdateInput = {},
  skipIf?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<PlanChangeSessionDto> {
  return withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      const row = await appendWithin(session.id, pctx, turn, patch, tx, skipIf);
      return toDto(row, pctx, tx);
    },
  );
}

/**
 * The transactional CORE of {@link appendLocked}, factored out so the FIRST turn
 * of a new session can be appended inside the transaction that creates the
 * session (MOTIR-6021) — a session with no turn is exactly the "opened by a look"
 * row AMENDMENT 17 §1 forbids. `tx` is REQUIRED; this never opens a transaction.
 *
 * Every append moves `lastActivityAt` in the SAME update that bumps `turnCount`
 * (§3): the idle close and the Plans page's order both read it, and a turn
 * that did not move it would let a live conversation age out mid-sentence.
 *
 * Exported for One start per offer (MOTIR-9291), which appends the offer's request
 * inside its own claim transaction rather than in a second one.
 */
export async function appendWithin(
  sessionId: string,
  pctx: ProjectContext,
  turn: AppendTurn,
  patch: PlanChangeSessionUpdateInput,
  tx: Prisma.TransactionClient,
  skipIf?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<PlanChangeSession> {
  const locked = await planChangeSessionRepository.lockById(sessionId, tx);
  if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
  // Re-read UNDER the lock: `turnCount` is the read-derived value the next
  // `seq` comes from, and a sibling append may have moved it between the
  // caller's read and this transaction.
  const fresh = await planChangeSessionRepository.findById(sessionId, pctx.workspaceId, tx);
  if (!fresh) throw new PlanChangeSessionNotFoundError(pctx.projectId);

  if (skipIf && (await skipIf(tx))) return fresh;
  // An ENDED session takes no turn from a person (AMENDMENT 23 §3), checked
  // under the row lock so an end that commits first is always seen. A late
  // machine turn of the attempt that just finished may still land on the record.
  if (fresh.endedAt && turn.role === 'user') throw new PlanSessionEndedError(fresh.id);

  const seq = fresh.turnCount;
  try {
    await planChangeTurnRepository.create(
      {
        workspaceId: pctx.workspaceId,
        sessionId: fresh.id,
        seq,
        role: turn.role,
        body: turn.body,
        jobId: turn.jobId ?? null,
        question: turn.question ?? null,
        isAnswer: turn.isAnswer ?? false,
        intent: turn.intent ?? null,
        citations: turn.citations ?? [],
        anchorKey: turn.anchorKey ?? null,
        attachmentIds: turn.attachmentIds ? [...turn.attachmentIds] : [],
        confirm: turn.confirm ?? null,
        codeUnreadable: turn.codeUnreadable ?? null,
        ...(turn.codeUnsearchable
          ? {
              codeUnsearchable: turn.codeUnsearchable.map((r) => ({
                repoRef: r.repoRef,
                state: r.state,
              })),
            }
          : {}),
        runJobId: turn.runJobId ?? null,
        forwardOffer: turn.forwardOffer ?? null,
        // An explicit literal, not the DTO itself: Prisma's JSON input wants an
        // indexable object, and spelling the four fields keeps the column's
        // shape exactly the DTO's.
        ...(turn.debugLanding
          ? {
              debugLanding: {
                outcome: turn.debugLanding.outcome,
                workItemKey: turn.debugLanding.workItemKey,
                title: turn.debugLanding.title,
                createdInTriage: turn.debugLanding.createdInTriage,
              },
            }
          : {}),
        // The offer (MOTIR-9288): spelled field by field like `debugLanding`, with
        // every disposition field written NULL, so the stored record is exactly the
        // wire shape and an undecided offer never has an absent field.
        ...(turn.answerOffer
          ? {
              answerOffer: {
                kind: turn.answerOffer.kind,
                requestMd: turn.answerOffer.requestMd,
                targetKey: turn.answerOffer.targetKey,
                // The bug a `log_bug` offer would write (MOTIR-9322), stored whole so
                // a confirm writes exactly what was checked here.
                ...(turn.answerOffer.bug
                  ? {
                      bug: JSON.parse(
                        JSON.stringify(turn.answerOffer.bug),
                      ) as Prisma.InputJsonObject,
                    }
                  : {}),
                declinedAt: null,
                declinedById: null,
                confirmedAt: null,
                confirmedById: null,
                confirmedSessionId: null,
              },
            }
          : {}),
        // The record round-trips through JSON: it is plain data by construction
        // (the parsed actions and their outcomes), so this is a copy, not a cast.
        ...(turn.guideTurn
          ? { guideTurn: JSON.parse(JSON.stringify(turn.guideTurn)) as Prisma.InputJsonObject }
          : {}),
        authorId: turn.authorId ?? null,
      },
      tx,
    );
  } catch (err) {
    // The `(session_id, seq)` unique fired: some writer claimed this position
    // without holding the lock (a desynced `turnCount`). Surface the typed
    // conflict — a raw P2002 never escapes the service.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new PlanChangeTurnConflictError(fresh.id, seq);
    }
    throw err;
  }

  // THE PLANNING-SESSION GATE (MOTIR-7913), in the same transaction as the turn and under
  // the same lock: the person's turn ANSWERS whatever the session was waiting on, and a
  // planner turn that carries a question starts the wait. A reply wait is raised by the
  // sweep, never here.
  if (turn.role === 'user') {
    await clearPlanningSessionGate(tx, { sessionId: fresh.id, cause: 'answered' });
  } else if (turn.role === 'assistant' && turn.question) {
    await raisePlanningSessionGate(tx, {
      sessionId: fresh.id,
      workspaceId: pctx.workspaceId,
      cause: 'question',
    });
  }

  // Every turn is activity, so it pushes the session's lease out too (AMENDMENT
  // 23 §2): the idle close reads `lastActivityAt` and the lease sweep reads the
  // lease, and the two must agree on when the session went quiet.
  const now = new Date();
  await planTargetLockService.refreshForSessionWithin(fresh.id, now, tx);
  return planChangeSessionRepository.update(
    fresh.id,
    { ...patch, turnCount: seq + 1, lastActivityAt: now },
    tx,
  );
}

/**
 * RESUME-OR-START under the member's scope lock (AMENDMENT 17 §3, §6) — the core
 * of {@link planChangeSessionsService.startWithFirstTurn} and of the public
 * `open` doors' {@link planChangeSessionsService.openForScope}. Takes the
 * member's scope lock, RE-READS their resumable session under it, and either
 * resumes it (refreshing its target lease) or creates a new session and takes
 * the scope's targets — handing over any live lease the member's own older
 * sessions of this scope still hold. Returns the session id. `tx` is REQUIRED.
 */
async function resumeOrStartWithin(
  pctx: ProjectContext,
  scope: PlanChangeScope,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<string> {
  await planChangeSessionRepository.lockScopeForUser(
    pctx.projectId,
    scope.scopeKey,
    pctx.userId,
    tx,
  );
  const resumable = await planChangeSessionRepository.findResumableForUser(
    pctx.projectId,
    scope.scopeKey,
    pctx.userId,
    pctx.workspaceId,
    tx,
  );
  // TAKE-BACK (AMENDMENT 23 §3): no open session for this scope, but one of the
  // member's own open sessions already holds a card in it — that is the
  // conversation they are having about it, so the turn lands there. Nothing is
  // created and nothing is taken over; its own scope is left as it is.
  const heldBy = resumable
    ? null
    : await planChangeSessionRepository.findOpenHoldingForUser(
        pctx.projectId,
        scope.targetKeys,
        pctx.userId,
        pctx.workspaceId,
        tx,
      );

  let sessionId: string;
  if (heldBy) {
    sessionId = heldBy.id;
  } else if (resumable) {
    sessionId = resumable.id;
    await planTargetLockService.acquireForScopeWithin(sessionId, scope.targetKeys, pctx, now, tx);
  } else {
    const created = await planChangeSessionRepository.create(
      {
        workspaceId: pctx.workspaceId,
        projectId: pctx.projectId,
        createdById: pctx.userId,
        scopeKey: scope.scopeKey,
        targetKeys: scope.targetKeys,
        origin: 'conversation',
        lastActivityAt: now,
      },
      tx,
    );
    sessionId = created.id;
    // No take-over (AMENDMENT 23 §3 retires AMENDMENT 17 §6 here): a card the
    // caller's own open session holds was TAKEN BACK above, and an ended session
    // released its leases when it ended — so whatever refuses this acquire is
    // another person's.
    await planTargetLockService.acquireForScopeWithin(sessionId, scope.targetKeys, pctx, now, tx);
  }
  return sessionId;
}

/**
 * The SEED GUARD (AMENDMENT 17 §9; MOTIR-6207). The gate's validity is the
 * CALLER's precondition — the seed read (MOTIR-6208) only offers a seed for a
 * refused gate — and it is asserted again HERE, under the transaction that
 * writes the stamp, so a forged or stale `seedGateId` can never be recorded.
 *
 * The gate row is LOCKED (`approvalGateRepository.lockById`, `FOR UPDATE`) and
 * read under that lock: the stamp is a READ-DERIVED write (it is legal only
 * while the gate is refused), so a decision racing this turn either commits
 * first and is seen here, or waits for this transaction.
 *
 * Refuses with ONE {@link PlanSeedNotApplicableError} when the gate is missing
 * or hidden by RLS, lives in another workspace or project, is not a gate
 * {@link isPlanningSeedGate} accepts (a refusal, or a PICK with a well-formed
 * stamp — MOTIR-6434), or the scope does not sit on the gate's ANCHOR (a
 * card-less gate included).
 *
 * THE ANCHOR is the one the seed read offered:
 *  - a PICK's, resolved by the SAME `anchorOf` — its nearest not-done, unarchived
 *    ancestor must be among the scope's targets, or, when it has none (the
 *    project), the scope must be the project scope;
 *  - a refusal's own card — or, for a kind that anchors on the card's PARENT
 *    ({@link refusalSeedAnchorsOnParent}: a design Re-plan, MOTIR-6424), the card
 *    OR its parent, since the seed read hands the planner the parent and a
 *    parentless design card anchors on itself. The decision kinds keep the card
 *    alone: the parent is never read for them.
 */
async function assertSeedApplicableWithin(
  pctx: ProjectContext,
  scope: PlanChangeScope,
  seedGateId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const gate = await approvalGateRepository.lockById(seedGateId, tx);
  if (
    !gate ||
    gate.workspaceId !== pctx.workspaceId ||
    gate.projectId !== pctx.projectId ||
    !isPlanningSeedGate(gate) ||
    !gate.workItemId
  ) {
    throw new PlanSeedNotApplicableError(seedGateId);
  }
  const pick = isPickSeedGate(gate);
  if (pick && !readChosenOption(gate.chosenOption))
    throw new PlanSeedNotApplicableError(seedGateId);
  const item = await workItemRepository.findById(gate.workItemId, tx);
  if (!item || item.projectId !== pctx.projectId) throw new PlanSeedNotApplicableError(seedGateId);

  if (pick) {
    const ancestors = toSeedAncestors(
      await workItemRepository.findAncestors(item.id, pctx.workspaceId, tx),
      await workflowsService.listStatusesByProject(pctx.projectId, pctx.workspaceId, tx),
    );
    const anchorKey = anchorOf(gate, item.identifier, ancestors);
    const onAnchor =
      anchorKey === null
        ? scope.scopeKey === PROJECT_SCOPE_KEY && scope.targetKeys.length === 0
        : scope.targetKeys.includes(anchorKey.toUpperCase());
    if (!onAnchor) throw new PlanSeedNotApplicableError(seedGateId);
    return;
  }

  if (scope.targetKeys.includes(item.identifier.toUpperCase())) return;
  if (refusalSeedAnchorsOnParent(gate.kind) && item.parentId) {
    const parent = await workItemRepository.findById(item.parentId, tx);
    if (
      parent &&
      parent.projectId === pctx.projectId &&
      scope.targetKeys.includes(parent.identifier.toUpperCase())
    ) {
      return;
    }
  }
  throw new PlanSeedNotApplicableError(seedGateId);
}

/**
 * RESUME-SEEDED-OR-START under the member's scope lock (AMENDMENT 17 §9) — the
 * seeded twin of {@link resumeOrStartWithin}, and deliberately NOT a flag on it.
 * The unseeded path resumes the member's most recent conversation in the scope;
 * a seeded turn landing there would stamp a gate on a conversation it did not
 * start. So this resumes ONLY the member's recent session seeded by the SAME
 * gate, and otherwise creates a new one carrying `seedGateId` — with the same
 * target take-over from the member's older sessions of the scope (§6).
 *
 * The choice between resume and create is read-derived, so it is made under
 * the SAME `lockScopeForUser` lock as the unseeded path: two first turns racing
 * for one gate queue there, and the second re-reads the first's session. The
 * seed guard runs under the lock too, before anything is written.
 */
async function resumeSeededOrStartWithin(
  pctx: ProjectContext,
  scope: PlanChangeScope,
  seedGateId: string,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<string> {
  await planChangeSessionRepository.lockScopeForUser(
    pctx.projectId,
    scope.scopeKey,
    pctx.userId,
    tx,
  );
  await assertSeedApplicableWithin(pctx, scope, seedGateId, tx);

  const seeded = await planChangeSessionRepository.findSeededForUser(
    pctx.projectId,
    seedGateId,
    pctx.userId,
    pctx.workspaceId,
    tx,
  );
  if (seeded) {
    await planTargetLockService.acquireForScopeWithin(seeded.id, scope.targetKeys, pctx, now, tx);
    return seeded.id;
  }

  const created = await planChangeSessionRepository.create(
    {
      workspaceId: pctx.workspaceId,
      projectId: pctx.projectId,
      createdById: pctx.userId,
      scopeKey: scope.scopeKey,
      targetKeys: scope.targetKeys,
      origin: 'conversation',
      seedGateId,
      lastActivityAt: now,
    },
    tx,
  );
  // A SEEDED session is the one place the hand-over survives (AMENDMENT 17 §9):
  // it must never land on the member's own unseeded (or differently seeded)
  // session, so take-back cannot serve it, and the card passes from that OPEN
  // session to this one instead of refusing the member over their own hold.
  const predecessors = await planChangeSessionRepository.listIdsForUserInScope(
    pctx.projectId,
    scope.scopeKey,
    pctx.userId,
    pctx.workspaceId,
    created.id,
    tx,
  );
  await planTargetLockService.acquireForScopeWithin(created.id, scope.targetKeys, pctx, now, tx, {
    takeOverFrom: predecessors,
  });
  return created.id;
}

/**
 * The GUIDE-SEEDED start under the member's scope lock AND the guide session's row
 * lock (MOTIR-8691; decision MOTIR-8685). Locks, in this order on every path:
 *  1. the member's scope lock (as the gate path takes it), so two first turns for
 *     one scope queue;
 *  2. the guide conversation's row lock (the one Decline and the landing take), so
 *     a Confirm racing a Decline or a newer offer serializes. Decline takes only
 *     this one, so the order cannot invert.
 * Then, under both, it asserts the offer is the caller's, the latest undecided one,
 * and that its target is the scope; creates the stamped session (or lands on the
 * caller's own open conversation that already holds the target); appends the turn
 * ONCE; and marks the offer confirmed in the same transaction.
 *
 * Every refusal that tells a stranger something is the ONE
 * {@link PlanSeedNotApplicableError}, so the cases cannot be told apart.
 */
async function confirmGuideOfferWithin(
  pctx: ProjectContext,
  scope: PlanChangeScope,
  seedGuideTurnId: string,
  body: string,
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<PlanChangeSession> {
  await planChangeSessionRepository.lockScopeForUser(
    pctx.projectId,
    scope.scopeKey,
    pctx.userId,
    tx,
  );
  const notApplicable = () => new PlanSeedNotApplicableError(seedGuideTurnId);

  const probe = await planChangeTurnRepository.findById(seedGuideTurnId, pctx.workspaceId, tx);
  if (!probe) throw notApplicable();
  const locked = await planChangeSessionRepository.lockById(probe.sessionId, tx);
  if (!locked) throw notApplicable();
  const guideSession = await planChangeSessionRepository.findByIdInProject(
    probe.sessionId,
    pctx.projectId,
    pctx.workspaceId,
    tx,
  );
  if (
    !guideSession ||
    guideSession.origin !== 'guide' ||
    guideSession.createdById !== pctx.userId
  ) {
    throw notApplicable();
  }
  // Re-read the thread UNDER the lock: a landing or a decline may have committed
  // between the probe and the lock.
  const rows = await planChangeTurnRepository.listBySessionId(
    guideSession.id,
    pctx.workspaceId,
    tx,
  );
  const turns = rows.map((t) => ({
    id: t.id,
    role: t.role,
    guide: readGuideTurnRecord(t.guideTurn),
  }));
  const offer = replanOfferOf(turns, seedGuideTurnId);
  if (!offer || offer.targetKey === null) throw notApplicable();
  const targetKey = offer.targetKey.toUpperCase();
  if (!scope.targetKeys.some((k) => k.toUpperCase() === targetKey)) throw notApplicable();

  const state = replanOfferStateOf(turns, seedGuideTurnId);
  if (state === 'confirmed') {
    throw new GuideReplanOfferAlreadyConfirmedError(seedGuideTurnId, offer.confirmedSessionId!);
  }
  if (state !== 'undecided') throw new GuideReplanOfferNotOpenError(seedGuideTurnId);

  // The caller's OWN open conversation that already holds the target is the
  // session the request lands on (the take-back read): nothing is created and
  // nothing is stamped on it.
  const heldBy = await planChangeSessionRepository.findOpenHoldingForUser(
    pctx.projectId,
    scope.targetKeys,
    pctx.userId,
    pctx.workspaceId,
    tx,
  );
  let sessionId: string;
  if (heldBy) {
    sessionId = heldBy.id;
  } else {
    const created = await planChangeSessionRepository.create(
      {
        workspaceId: pctx.workspaceId,
        projectId: pctx.projectId,
        createdById: pctx.userId,
        scopeKey: scope.scopeKey,
        targetKeys: scope.targetKeys,
        origin: 'conversation',
        seedGuideTurnId,
        lastActivityAt: now,
      },
      tx,
    );
    sessionId = created.id;
    const predecessors = await planChangeSessionRepository.listIdsForUserInScope(
      pctx.projectId,
      scope.scopeKey,
      pctx.userId,
      pctx.workspaceId,
      created.id,
      tx,
    );
    await planTargetLockService.acquireForScopeWithin(created.id, scope.targetKeys, pctx, now, tx, {
      takeOverFrom: predecessors,
    });
  }

  const row = await appendWithin(
    sessionId,
    pctx,
    { role: 'user', body, authorId: pctx.userId },
    {},
    tx,
  );

  // The confirmation, in the SAME transaction as the session and its turn.
  const offerRow = rows.find((t) => t.id === seedGuideTurnId)!;
  await planChangeTurnRepository.setGuideTurn(
    offerRow.id,
    pctx.workspaceId,
    {
      ...(offerRow.guideTurn as Record<string, unknown>),
      replanOffer: {
        ...offer,
        confirmedAt: now.toISOString(),
        confirmedById: pctx.userId,
        confirmedSessionId: sessionId,
      },
    } as Prisma.InputJsonValue,
    tx,
  );
  return row;
}

/** The end reasons whose CONVERSATION ALONE a new session may carry over
 *  (AMENDMENT 23 §6): Motir ended them. `restarted` (the person asked for
 *  something new) is not here, and neither are `approved` / `declined` (those
 *  were decisions) — but a session of ANY end reason that still holds an
 *  undecided plan is copyable too, and the carry takes the plan with it
 *  (Story MOTIR-7928 · MOTIR-7930; {@link isCopyable}). */
const COPYABLE_END_REASONS: ReadonlySet<string> = new Set(['failed', 'idle']);

/** Whether an ENDED session can be carried into a new one: Motir ended it
 *  ({@link COPYABLE_END_REASONS}), or it still holds an undecided plan. An
 *  `approved` / `declined` end decided its plan, so it holds none. */
function isCopyable(row: PlanChangeSession, waitingPlan: Plan | null): boolean {
  if (!row.endedAt || !row.endReason) return false;
  return COPYABLE_END_REASONS.has(row.endReason) || waitingPlan !== null;
}

/** The copyable read's answer for the caller's latest own conversation. */
/** Whether the Plan something new confirm is PENDING on this thread
 *  (MOTIR-7649; ADR AMENDMENT 3, A3.2): the latest turn is that confirm. Read
 *  under the session's row lock by every caller, because it guards an append. */
async function restartConfirmPendingWithin(
  sessionId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const latest = await planChangeTurnRepository.findLatestInSession(sessionId, workspaceId, tx);
  return latest?.role === 'assistant' && latest.confirm === 'new_session';
}

/** The confirm turn itself — one shape for the words and the button (A3.2). */
const NEW_SESSION_CONFIRM_TURN: AppendTurn = {
  role: 'assistant',
  body: NEW_SESSION_CONFIRM_BODY,
  confirm: 'new_session',
};

/** Plan something new acts only on the caller's OWN `conversation` session (A3.3):
 *  another member's session, a guide conversation and a session opened by any
 *  other door are `PLAN_SESSION_NOT_FOUND`, as the copy door answers. */
function assertRestartable(session: PlanChangeSession, pctx: ProjectContext): void {
  if (session.createdById !== pctx.userId || session.origin !== 'conversation') {
    throw new PlanSessionNotFoundError(session.id);
  }
}

function toCopyable(
  row: PlanChangeSession | null,
  waitingPlan: Plan | null,
): CopyableSessionDto | null {
  if (!row?.endedAt || !row.endReason || !isCopyable(row, waitingPlan)) return null;
  return {
    id: row.id,
    endReason: row.endReason as CopyableSessionDto['endReason'],
    endedAt: row.endedAt.toISOString(),
    turnCount: row.turnCount,
    waitingPlanId: waitingPlan?.id ?? null,
  };
}

/**
 * The plan a carry MOVES (MOTIR-7930), locked and re-read under its row lock —
 * "is it still undecided?" guards the move (the read-derived-write rule). With
 * `planId`, the plan the person was looking at: it must still sit under the
 * source and be undecided. Without it, the source's most recent UNDECIDED plan,
 * which is not always its LATEST (a `failed` end can hold a declined attempt over
 * an earlier plan that still waits). Decided under the lock →
 * {@link PlanSessionPlanDecidedError}; moved to another session →
 * `PLAN_SESSION_NOT_COPYABLE`; nothing waiting → `null`.
 */
async function lockWaitingPlanWithin(
  source: PlanChangeSession,
  planId: string | null,
  pctx: ProjectContext,
  tx: Prisma.TransactionClient,
): Promise<Plan | null> {
  const candidateId =
    planId ?? (await planRepository.findLatestUndecidedBySession(source.id, tx))?.id ?? null;
  if (!candidateId) return null;
  await planRepository.lockById(candidateId, tx);
  const plan = await planRepository.findById(candidateId, pctx.workspaceId, tx);
  if (!plan) throw new PlanSessionNotFoundError(source.id);
  if (plan.status === 'approved' || plan.status === 'declined') {
    throw new PlanSessionPlanDecidedError(source.id, plan.id, plan.status);
  }
  // Undecided but no longer the source's: an earlier carry moved it, and that
  // session has ended too. Carrying the conversation alone would strand the plan.
  if (plan.sessionId !== source.id)
    throw new PlanSessionNotCopyableError(source.id, source.endReason);
  return plan;
}

// ── THE TURN ON A WAITING PLAN (MOTIR-7945) ──────────────────────────────────

function undecidedStatus(status: string): SessionTurnPlanStatus {
  return status === 'planned' || status === 'stale' ? status : 'generating';
}

/**
 * An undecided plan's status AS A CONVERSATION'S NEXT TURN READS IT (Bug MOTIR-8208).
 * A revision RE-OPENS the plan it rewrites (`planned` → `generating`), but that plan
 * is still the one the conversation waits on: a turn sent while the revision runs
 * REVISES it — and is refused `PLAN_REVISION_IN_FLIGHT` until the revision ends —
 * rather than opening a second plan beside it as a `generating` plan would. So a
 * re-opened plan reads as `planned` here, exactly as it read before the re-open.
 */
async function turnStatusOf(
  plan: { id: string; status: string },
  tx: Prisma.TransactionClient,
): Promise<SessionTurnPlanStatus> {
  const status = undecidedStatus(plan.status);
  if (status !== 'generating') return status;
  return isReopenedByRevision(plan, await planRevisionRepository.listByPlan(plan.id, tx))
    ? 'planned'
    : status;
}

/** The revision actor a conversation's revise records — Motir's own planner. */
const SESSION_REVISION_ACTOR = { source: 'native', harness: 'Motir', model: null } as const;

/**
 * REVISE the plan the conversation waits on, then BIND the turn to the session:
 * the `system` marker turn, `lastJobId` / `lastSubmittedAt` and the lease
 * heartbeat, exactly as an ordinary submit records them. The revision lease is
 * taken by `submitSessionRevision` under the PLAN lock; the bind takes the
 * SESSION lock; the two are never held together.
 */
async function reviseWithinSession(
  session: PlanChangeSession,
  pctx: ProjectContext,
  planId: string,
  intent: string,
  opts: { clearFailure?: boolean } = {},
): Promise<PlanChangeSubmitResultDto> {
  const { jobId } = await aiPlanEditsService.submitSessionRevision(planId, intent, pctx);
  return bindRevisionTurn(session, pctx, { jobId, planId }, intent, opts);
}

/**
 * REVISE the waiting plan — or, when THIS conversation's own revision is still
 * running on it, QUEUE the turn for that revision (Bug MOTIR-8352).
 *
 * A rail that is streaming the revision sends a turn to the job's mailbox and
 * never reaches the submit. A rail that is NOT streaming it — after a reload, in
 * another tab, an MCP caller of `submit_plan_session` — has no job in hand, so its
 * send arrives here, and the revision's lease refused it `PLAN_REVISION_IN_FLIGHT`:
 * the person's correction was lost while the run that should read it was still
 * working. Now the refusal stands only when the hold is somebody else's (another
 * session's job, an MCP `hold_plan_revision` holder): the lease's job is this
 * session's `lastJobId` and it is still running ⇒ the newest user turn goes into
 * its mailbox, and the answer is that RUNNING job, so the caller streams the
 * revision its turn now rides on rather than a second one.
 *
 * The mailbox key is derived from the turn (`queued-revision:<turnId>`), so a
 * retried submit queues the sentence once.
 */
async function reviseOrQueueWithinSession(
  session: PlanChangeSession,
  pctx: ProjectContext,
  planId: string,
  intent: string,
  turns: ReadonlyArray<Pick<PlanChangeTurn, 'id' | 'role' | 'body' | 'jobId' | 'seq'>>,
  opts: { clearFailure?: boolean } = {},
): Promise<PlanChangeSubmitResultDto> {
  try {
    return await reviseWithinSession(session, pctx, planId, intent, opts);
  } catch (err) {
    if (!(err instanceof PlanRevisionInFlightError)) throw err;
    const queued = await queueForRunningRevision(session, pctx, planId, turns);
    if (!queued) throw err;
    return queued;
  }
}

/**
 * The newest user turn, queued on the session's RUNNING revision of `planId` — or
 * null when the revision holding the plan is not this session's, has nothing new
 * to carry, or has ended in the meantime (the caller then keeps its refusal).
 */
async function queueForRunningRevision(
  session: PlanChangeSession,
  pctx: ProjectContext,
  planId: string,
  turns: ReadonlyArray<Pick<PlanChangeTurn, 'id' | 'role' | 'body' | 'jobId' | 'seq'>>,
): Promise<PlanChangeSubmitResultDto | null> {
  const jobId = session.lastJobId;
  if (!jobId) return null;
  // The job the lease names (a hosted acquire records it); a hold whose job is not
  // this session's last submission — or that has no job at all, an MCP holder — is
  // somebody else's revision.
  const holder = await withWorkspaceServiceContext(pctx.workspaceId, async (tx) =>
    revisionLeaseJobId(await planRevisionRepository.listByPlan(planId, tx), new Date()),
  );
  if (holder !== jobId) return null;
  const turn = latestTurnAfterSubmission(turns, jobId);
  if (!turn) return null;
  try {
    await planChangeMailboxService.attachTurn(
      {
        jobId,
        sessionId: session.id,
        body: turn.body,
        idempotencyKey: `queued-revision:${turn.id}`,
        disposition: 'fold',
      },
      pctx,
    );
  } catch (err) {
    // The revision finished (or the thread moved on) between the refusal and the
    // queue: there is no run left to read it, so the caller's refusal is the answer.
    if (err instanceof PlanChangeJobNotRunningError) return null;
    if (err instanceof PlanChangeMailboxJobMismatchError) return null;
    throw err;
  }
  const fresh = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
    planChangeSessionRepository.findById(session.id, pctx.workspaceId, tx),
  );
  if (!fresh) throw new PlanChangeSessionNotFoundError(pctx.projectId);
  return { jobId, planId, session: await toDto(fresh, pctx) };
}

/**
 * The newest `user` turn written AFTER the `system` marker that submitted `jobId`
 * — the turn this send carries. Null when there is none: everything the person
 * typed before that marker is already in the revision's intent.
 */
export function latestTurnAfterSubmission<
  T extends Pick<PlanChangeTurn, 'role' | 'body' | 'jobId' | 'seq'>,
>(turns: readonly T[], jobId: string): T | null {
  const ordered = [...turns].sort((a, b) => a.seq - b.seq);
  let markerSeq = -1;
  for (const t of ordered) {
    if (t.role === 'system' && t.jobId === jobId) markerSeq = t.seq;
  }
  if (markerSeq < 0) return null;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const t = ordered[i]!;
    if (t.seq <= markerSeq) return null;
    if (t.role === 'user' && t.body.trim().length > 0) return t;
  }
  return null;
}

/**
 * The idempotency key of a conversation's planning submit (MOTIR-9258): its
 * newest `user` turn and the job the session held before this submit. A re-send,
 * a double press and a Try again of a submit that never came back all reuse it,
 * so motir-ai answers them with ONE job. A submit after a job the session already
 * holds — a new turn, or Plan it again — is a new key, and runs fresh.
 */
export function planningSubmitKey(
  turns: ReadonlyArray<Pick<PlanChangeTurn, 'id' | 'role' | 'seq'>>,
  lastJobId: string | null,
): string | undefined {
  const latest = [...turns].sort((a, b) => b.seq - a.seq).find((t) => t.role === 'user');
  return latest ? turnSubmitKey(latest.id, 'plan', lastJobId) : undefined;
}

/**
 * Record a revision job on its session, in ONE transaction under the session row
 * lock. A session that ENDED between the submit and this bind takes no turn, and
 * the lease the job just took is released — a refused bind never leaves a plan
 * leased to a turn nobody recorded.
 */
async function bindRevisionTurn(
  session: PlanChangeSession,
  pctx: ProjectContext,
  submitted: { jobId: string; planId: string },
  intent: string,
  opts: { clearFailure?: boolean } = {},
): Promise<PlanChangeSubmitResultDto> {
  const { jobId, planId } = submitted;
  const bound = await withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      const locked = await planChangeSessionRepository.lockById(session.id, tx);
      const fresh = locked
        ? await planChangeSessionRepository.findById(session.id, pctx.workspaceId, tx)
        : null;
      if (!fresh) throw new PlanChangeSessionNotFoundError(pctx.projectId);
      if (fresh.endedAt) return null;
      const row = await appendWithin(
        session.id,
        pctx,
        { role: 'system', body: intent, jobId },
        {
          lastJobId: jobId,
          lastSubmittedAt: new Date(),
          // The failure record is cleared in the SAME update, under the SAME session lock
          // that re-read `endedAt` above (MOTIR-7938): a restart that won the lock never
          // sees a cleared record, and a double send clears it once. Clearing an absent
          // record is a no-op write of nulls.
          ...(opts.clearFailure && sessionWaitingState(fresh) === 'failed'
            ? CLEARED_FAILURE_COLUMNS
            : {}),
        },
        tx,
      );
      return toDto(row, pctx, tx);
    },
  );
  if (!bound) {
    await plansService.releaseRevisionLease(planId, pctx, SESSION_REVISION_ACTOR, {
      jobId,
      reason: 'session_ended',
    });
    throw new PlanSessionEndedError(session.id);
  }
  await planTargetLockService.refreshForSession(session.id, pctx);
  return { jobId, planId, session: bound };
}

/** The stale outcome: the finished card(s) the plan changes, in key order. */
async function staleOutcome(
  planId: string,
  pctx: ProjectContext,
): Promise<PlanSessionPlanStaleError> {
  const [finished, statuses] = await Promise.all([
    planDriftService.readTerminalTargets(planId, pctx.projectId, pctx.workspaceId),
    workflowsService.listStatusesByProject(pctx.projectId, pctx.workspaceId),
  ]);
  const labelOf = new Map(statuses.map((s) => [s.key, s.label]));
  const finishedCards: StalePlanFinishedCard[] = [...finished]
    .sort((a, b) => a.key - b.key)
    .map((w) => ({
      id: w.id,
      key: w.identifier,
      title: w.title,
      status: w.status,
      statusLabel: labelOf.get(w.status) ?? w.status,
    }));
  return new PlanSessionPlanStaleError(planId, finishedCards);
}

async function planAgainRefusal(
  sessionId: string,
  stalePlanId: string,
  reason: 'decided' | 'superseded',
  latestPlanId: string | null,
  pctx: ProjectContext,
): Promise<Error> {
  if (reason === 'superseded') return new PlanAgainNotAvailableError('superseded', latestPlanId);
  const plan = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
    planRepository.findById(stalePlanId, pctx.workspaceId, tx),
  );
  if (!plan || plan.sessionId !== sessionId) throw new PlanNotFoundError(stalePlanId);
  return new PlanSessionPlanDecidedError(sessionId, stalePlanId, plan.status);
}

type PlanAgainClaim = { kind: 'claimed'; claimedAt: Date; previous: Date | null };

/**
 * THE DOUBLE-ACCEPT GUARD for Plan it again, BEFORE any job is dispatched: under
 * the session row lock, the stale plan must still be the plan the conversation
 * waits on and the accumulated intent must still be UNSUBMITTED (the stale
 * outcome writes nothing, so after it the intent reads unsubmitted). Setting
 * `lastSubmittedAt` is the claim — a second accept that takes the lock after
 * this one commits reads the intent as submitted and is refused. A plan restored
 * to `planned` in the meantime is revised instead of planned beside.
 */
async function claimPlanAgain(
  session: PlanChangeSession,
  pctx: ProjectContext,
  stalePlanId: string,
): Promise<PlanAgainClaim | { kind: 'revise'; planId: string }> {
  const out = await withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      const locked = await planChangeSessionRepository.lockById(session.id, tx);
      const fresh = locked
        ? await planChangeSessionRepository.findById(session.id, pctx.workspaceId, tx)
        : null;
      if (!fresh) throw new PlanChangeSessionNotFoundError(pctx.projectId);
      if (fresh.endedAt) throw new PlanSessionEndedError(fresh.id);
      const latest = await planRepository.findLatestUndecidedBySession(fresh.id, tx);
      const turn = classifySessionTurn({
        origin: fresh.origin,
        endedAt: fresh.endedAt,
        latestUndecided: latest ? { id: latest.id, status: await turnStatusOf(latest, tx) } : null,
        planAgainOf: stalePlanId,
      });
      if (turn.kind === 'revise') return turn;
      if (turn.kind === 'plan_again_refused') {
        return { kind: 'refused' as const, reason: turn.reason, latestPlanId: latest?.id ?? null };
      }
      const turns = await planChangeTurnRepository.listBySessionId(fresh.id, pctx.workspaceId, tx);
      const newestUser = [...turns].reverse().find((t) => t.role === 'user');
      const submittedSince =
        fresh.lastSubmittedAt !== null &&
        (!newestUser || fresh.lastSubmittedAt.getTime() >= newestUser.createdAt.getTime());
      if (submittedSince) {
        // The winner's job is in flight: its plan does not exist yet.
        return { kind: 'refused' as const, reason: 'superseded' as const, latestPlanId: null };
      }
      const claimedAt = new Date();
      await planChangeSessionRepository.update(fresh.id, { lastSubmittedAt: claimedAt }, tx);
      return { kind: 'claimed' as const, claimedAt, previous: fresh.lastSubmittedAt };
    },
  );
  if (out.kind === 'refused') {
    throw await planAgainRefusal(session.id, stalePlanId, out.reason, out.latestPlanId, pctx);
  }
  return out;
}

/** Give a Plan it again claim back when its job never started — only if no
 *  later write has moved `lastSubmittedAt` since the claim. */
async function releasePlanAgainClaim(
  session: PlanChangeSession,
  pctx: ProjectContext,
  claim: PlanAgainClaim,
): Promise<void> {
  await withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      await planChangeSessionRepository.lockById(session.id, tx);
      const fresh = await planChangeSessionRepository.findById(session.id, pctx.workspaceId, tx);
      if (fresh?.lastSubmittedAt?.getTime() !== claim.claimedAt.getTime()) return;
      await planChangeSessionRepository.update(session.id, { lastSubmittedAt: claim.previous }, tx);
    },
  );
}

/**
 * The conversation's carried answers (MOTIR-9315): what its own person's grilling
 * settled, or `undefined`. Only a conversation is grilled before planning, and only
 * by the person whose conversation it is, so any other session carries nothing.
 */
async function carriedAnswersFor(
  session: PlanChangeSession,
  pctx: ProjectContext,
): Promise<CarriedAnswers | undefined> {
  if (session.origin !== 'conversation' || session.createdById !== pctx.userId) return undefined;
  return toCarriedAnswers(await aiSharpenService.getSettledForConversation(session.id, pctx));
}

export const planChangeSessionsService = {
  /**
   * END a session (AMENDMENT 23 §2) — the one end operation, idempotent, in one
   * transaction. Lives in `planSessionEndService` (see its header for why); this
   * is the conversation service's address for it.
   */
  endSession,

  /**
   * The RESUME read (AMENDMENT 17 §3, AMENDMENT 23 §3): the caller's OWN OPEN
   * session for the scope, at any age, else `null` — an ended session is never
   * resumed. A scope the caller has no open session for falls back to the
   * TAKE-BACK: their own open session that holds one of the scope's cards.
   * Another member's session is never resumed automatically — reopening one is
   * an explicit by-id act ({@link getById}). WRITES NOTHING and takes no lock:
   * looking at the door is not starting a conversation.
   *
   * Browse-gated, like {@link getById}: it reads a conversation.
   */
  async findResumable(
    pctx: ProjectContext,
    scopeKey: string = PROJECT_SCOPE_KEY,
  ): Promise<PlanChangeSessionDto | null> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await projectAccessService.assertCanBrowse(pctx.projectId, ctx);
    // A scope key IS its canonical target set (`buildScope`), so the take-back
    // needs no second argument; the project scope (`''`) holds no card.
    const targetKeys = scopeKey ? scopeKey.split(',') : [];
    const found = await withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
      const own = await planChangeSessionRepository.findResumableForUser(
        pctx.projectId,
        scopeKey,
        pctx.userId,
        pctx.workspaceId,
        tx,
      );
      if (own) return { row: own, takenBack: false };
      const holding = await planChangeSessionRepository.findOpenHoldingForUser(
        pctx.projectId,
        targetKeys,
        pctx.userId,
        pctx.workspaceId,
        tx,
      );
      return holding ? { row: holding, takenBack: true } : null;
    });
    if (!found) return null;
    // The take-back is SAID (MOTIR-7643): the overlay's notice tells the person
    // they are back in the session they already had open, and nothing was started.
    return { ...(await toDto(found.row, pctx)), takenBack: found.takenBack };
  },

  /**
   * One session BY ID — any member who may browse the project may READ any of
   * its sessions (AMENDMENT 17 §3: reopening from the Plans page is not
   * own-only). Writes nothing. An id outside this project is
   * `PLAN_SESSION_NOT_FOUND`.
   */
  async getById(pctx: ProjectContext, sessionId: string): Promise<PlanChangeSessionDto> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await projectAccessService.assertCanBrowse(pctx.projectId, ctx);
    const row = await findSessionById(pctx, sessionId);
    // The REOPEN extras (MOTIR-6024): the reopened line names who started it,
    // a member without `ai:plan` reads it read-only, and a still-undecided plan
    // comes back reviewable — the three things a Plans row's reopen needs.
    const [startedBy, endedBy, pending, viewerCanPlan] = await Promise.all([
      withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
        planChangeSessionRepository.findStarter(row.id, pctx.workspaceId, tx),
      ),
      // Who ENDED it (AMENDMENT 23 §1) — the end marker's `by {name}`.
      row.endedById
        ? withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
            planChangeSessionRepository.findEnder(row.id, pctx.workspaceId, tx),
          )
        : null,
      withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
        planRepository.findLatestUndecidedBySession(row.id, tx),
      ),
      assertCanPlan(pctx.projectId, ctx).then(
        () => true,
        (err: unknown) => {
          if (err instanceof PermissionDeniedError) return false;
          throw err;
        },
      ),
    ]);
    // The newest UNDECIDED plan, not the session's latest plan: a newer declined plan
    // sitting on an older `planned` one must not hide the plan still waiting (MOTIR-8867).
    const undecided = pending?.id ?? null;
    // An ENDED session whose plan a carry took away (MOTIR-7932; design state 4):
    // where that plan went, so the old session can say so and link to it.
    const movedTo =
      row.endedAt && !undecided
        ? await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
            planRevisionRepository.findLatestCarriedFromSession(row.id, tx),
          )
        : null;
    const movedToSessionId =
      movedTo && typeof movedTo.diff === 'object' && movedTo.diff && !Array.isArray(movedTo.diff)
        ? ((movedTo.diff as { toSessionId?: unknown }).toSessionId ?? null)
        : null;
    return {
      ...(await toDto(row, pctx)),
      startedBy,
      endedBy,
      startedByViewer: row.createdById === pctx.userId,
      viewerCanPlan,
      pendingPlanId: undecided,
      planMovedToSessionId: typeof movedToSessionId === 'string' ? movedToSessionId : null,
    };
  },

  /**
   * {@link getById} for a READER — the overlay's `GET /api/ai/plan-change/session`
   * (Story MOTIR-6179 · MOTIR-6330). A session outside the reader's Plans-room
   * scope (neither `plan:view_any` nor in their Mine view) is the same
   * `PLAN_SESSION_NOT_FOUND` an unknown id is, so a pasted link confirms nothing.
   * `getById` itself stays scope-free for its AUTHORING callers (the contextual
   * planner and the ask door), which continue a conversation under `ai:plan`.
   */
  async getByIdForReader(pctx: ProjectContext, sessionId: string): Promise<PlanChangeSessionDto> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    const inScope = await planSessionsService.isSessionInReaderScope(
      pctx.projectId,
      sessionId,
      ctx,
    );
    if (!inScope) throw new PlanSessionNotFoundError(sessionId);
    return this.getById(pctx, sessionId);
  },

  /**
   * The RESUME read plus what a FRESH start points to (AMENDMENT 17 §3;
   * MOTIR-6024): the caller's resumable conversation for the scope — or, when
   * there is none, the scope's most recent OTHER conversation (any member's)
   * that has REACHED PLANNING, which the overlay's notice links to on the Plans
   * page (MOTIR-9304). The read owns that rule; this service deliberately neither
   * re-applies nor second-guesses it. The `copyable` half is NOT narrowed: the
   * caller's own ended conversation is copyable whatever it holds. Writes nothing.
   */
  async findResumableWithEarlier(
    pctx: ProjectContext,
    scopeKey: string = PROJECT_SCOPE_KEY,
  ): Promise<ResumableSessionDto> {
    const session = await planChangeSessionsService.findResumable(pctx, scopeKey);
    if (session) return { session, earlier: null, copyable: null };
    const [row, own, waitingPlan] = await withWorkspaceServiceContext(
      pctx.workspaceId,
      async (tx) => {
        const latestOwn = await planChangeSessionRepository.findLatestConversationForUser(
          pctx.projectId,
          scopeKey,
          pctx.userId,
          pctx.workspaceId,
          tx,
        );
        return [
          await planChangeSessionRepository.findLatestConversationInScope(
            pctx.projectId,
            scopeKey,
            pctx.workspaceId,
            null,
            tx,
          ),
          latestOwn,
          // The plan a carry would MOVE (MOTIR-7930): read only for an ended
          // session, since an open one is resumed rather than copied.
          latestOwn?.endedAt
            ? await planRepository.findLatestUndecidedBySession(latestOwn.id, tx)
            : null,
        ] as const;
      },
    );
    return {
      session: null,
      copyable: toCopyable(own, waitingPlan),
      earlier: row
        ? {
            id: row.id,
            targetKeys: row.targetKeys,
            lastActivityAt: row.lastActivityAt.toISOString(),
            startedBy: row.createdBy,
            mine: row.createdById === pctx.userId,
          }
        : null,
    };
  },

  /**
   * RESUME-OR-START with the member's FIRST TURN — the only way a conversation
   * comes into existence (AMENDMENT 17 §1). In ONE transaction:
   *
   *  1. take the member's scope lock ({@link planChangeSessionRepository.lockScopeForUser});
   *  2. RE-READ the resumable session UNDER it — so a second tab that sent its
   *     first turn a moment earlier is found here, and this turn lands on THAT
   *     session instead of forking a second one (the read-derived-write rule:
   *     the choice between append and create reads `lastActivityAt`);
   *  3. resume it (refreshing its target lease) — or create a new session and
   *     take the scope's target lock, TAKING OVER any live lease the member's
   *     own older sessions of this scope still hold (§6) rather than being
   *     refused by their own earlier conversation;
   *  4. append the turn, which moves `lastActivityAt`.
   *
   * The result is the session the turn landed on, so a caller that lost the race
   * observes the winner's id. `ai:plan`-gated: it writes.
   */
  async startWithFirstTurn(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    body: string,
    opts: { isAnswer?: boolean; anchorKey?: string | null } = {},
  ): Promise<PlanChangeSessionDto> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    const now = new Date();

    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const sessionId = await resumeOrStartWithin(pctx, scope, now, tx);

        const row = await appendWithin(
          sessionId,
          pctx,
          {
            role: 'user',
            body: trimmed,
            authorId: pctx.userId,
            isAnswer: opts.isAnswer === true,
            anchorKey: opts.anchorKey ?? null,
          },
          {},
          tx,
        );
        return toDto(row, pctx, tx);
      },
    );
  },

  /**
   * CARRY AN ENDED CONVERSATION INTO A NEW SESSION (AMENDMENT 23 §6; MOTIR-7641),
   * TAKING ITS WAITING PLAN WITH IT (Story MOTIR-7928 · MOTIR-7930). In ONE
   * transaction, under the member's scope lock (so two racing carries create one
   * session):
   *
   *  * a source that is not the caller's own `conversation` is
   *    `PLAN_SESSION_NOT_FOUND`, so an id confirms nothing;
   *  * the caller's own OPEN session for the source's scope wins — or, with none,
   *    their open session that already holds one of its cards (the take-back,
   *    AMENDMENT 23 §3). `opts.body` lands THERE, the result says `takenBack`,
   *    and nothing is copied or moved: the waiting plan stays where it was.
   *    EXCEPT an open session with no turns and no copy source — the empty one
   *    Plan something new leaves (`restart`): when the source has a waiting plan,
   *    the carry ADOPTS that session instead of creating one (MOTIR-7987);
   *  * the plan that waits is the source's most recent UNDECIDED plan — or
   *    `opts.planId`, the plan the person was looking at. It is locked and
   *    re-read; one decided meanwhile is `PLAN_SESSION_PLAN_DECIDED`;
   *  * a source still open, or ended with no waiting plan by a restart or a
   *    decision, is `PLAN_SESSION_NOT_COPYABLE`;
   *  * otherwise a new `conversation` session of the same scope is created with
   *    `copiedFromSessionId`, holding the source's `user` and `assistant` turns in
   *    `seq` order (not its `system` turns, not a pending question, not a turn's
   *    `jobId`). The waiting plan MOVES to it (`Plan.sessionId`, with a
   *    `session_carried` row on its trail), the session takes the scope's cards,
   *    and `opts.body` is appended as its next turn. That is the first turn doing
   *    the carry.
   *
   * Lock order: scope lock, then plan row, then work items (inside
   * `acquireForScopeWithin`). Another member's live hold on a scope card refuses
   * the acquire and rolls the whole carry back. The source stays ended and
   * unchanged. `ai:plan`-gated: it writes.
   */
  async startCopied(
    pctx: ProjectContext,
    fromSessionId: string,
    opts: {
      body?: string;
      isAnswer?: boolean;
      anchorKey?: string | null;
      planId?: string | null;
    } = {},
  ): Promise<PlanChangeSessionDto> {
    const body = opts.body?.trim() || null;
    if (opts.body !== undefined && !body) throw new EmptyPlanChangeTurnError();
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    const now = new Date();
    const firstTurn = (): AppendTurn | null =>
      body
        ? {
            role: 'user',
            body,
            authorId: pctx.userId,
            isAnswer: opts.isAnswer === true,
            anchorKey: opts.anchorKey ?? null,
          }
        : null;

    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const source = await planChangeSessionRepository.findByIdInProject(
          fromSessionId,
          pctx.projectId,
          pctx.workspaceId,
          tx,
        );
        if (!source || source.createdById !== pctx.userId || source.origin !== 'conversation') {
          throw new PlanSessionNotFoundError(fromSessionId);
        }
        await planChangeSessionRepository.lockScopeForUser(
          pctx.projectId,
          source.scopeKey,
          pctx.userId,
          tx,
        );
        const resumable = await planChangeSessionRepository.findResumableForUser(
          pctx.projectId,
          source.scopeKey,
          pctx.userId,
          pctx.workspaceId,
          tx,
        );
        const open =
          resumable ??
          (await planChangeSessionRepository.findOpenHoldingForUser(
            pctx.projectId,
            source.targetKeys,
            pctx.userId,
            pctx.workspaceId,
            tx,
          ));
        // An EMPTY open session on the scope — the one Plan something new leaves
        // behind (`restart`) — has nothing to take back to, so it does not win over
        // a plan that still waits: the carry ADOPTS it instead of creating a second
        // session beside it (MOTIR-7987). Without a waiting plan it is still the
        // take-back, as before.
        const adoptable =
          resumable && resumable.turnCount === 0 && !resumable.copiedFromSessionId
            ? resumable
            : null;
        const waitingPlanId =
          adoptable &&
          (opts.planId ??
            (await planRepository.findLatestUndecidedBySession(source.id, tx))?.id ??
            null);
        if (open && !waitingPlanId) {
          const turn = firstTurn();
          const landed = turn ? await appendWithin(open.id, pctx, turn, {}, tx) : open;
          return { ...(await toDto(landed, pctx, tx)), takenBack: true };
        }

        const waitingPlan = await lockWaitingPlanWithin(
          source,
          waitingPlanId || opts.planId || null,
          pctx,
          tx,
        );
        if (!isCopyable(source, waitingPlan)) {
          throw new PlanSessionNotCopyableError(source.id, source.endReason);
        }

        const turns = (
          await planChangeTurnRepository.listBySessionId(source.id, pctx.workspaceId, tx)
        ).filter((t) => t.role === 'user' || t.role === 'assistant');
        const created = adoptable
          ? await planChangeSessionRepository.update(
              adoptable.id,
              { copiedFromSessionId: source.id, turnCount: turns.length, lastActivityAt: now },
              tx,
            )
          : await planChangeSessionRepository.create(
              {
                workspaceId: pctx.workspaceId,
                projectId: pctx.projectId,
                createdById: pctx.userId,
                scopeKey: source.scopeKey,
                targetKeys: source.targetKeys,
                origin: 'conversation',
                copiedFromSessionId: source.id,
                turnCount: turns.length,
                lastActivityAt: now,
              },
              tx,
            );
        for (const [seq, turn] of turns.entries()) {
          await planChangeTurnRepository.create(
            {
              workspaceId: pctx.workspaceId,
              sessionId: created.id,
              seq,
              role: turn.role,
              body: turn.body,
              authorId: turn.authorId,
              isAnswer: turn.isAnswer,
              intent: turn.intent,
              anchorKey: turn.anchorKey,
              citations: turn.citations,
              attachmentIds: turn.attachmentIds,
              createdAt: turn.createdAt,
            },
            tx,
          );
        }

        if (waitingPlan) {
          // The plan MOVES (never attaches: `Plan.sessionId` is one key), so every
          // read of "the session's plan" now finds it under the new session.
          await planRepository.moveToSession(waitingPlan.id, created.id, tx);
          await planRevisionsService.recordRevision(
            {
              planId: waitingPlan.id,
              changedById: pctx.userId,
              changeKind: 'session_carried',
              diff: { fromSessionId: source.id, toSessionId: created.id },
            },
            tx,
          );
          // The SESSION holds a conversation plan's cards (MOTIR-5648), and the
          // end gave them back — so the new session takes the scope again, taking
          // over a lease the caller's own older sessions of this scope still hold.
          // Another member's hold refuses, and the whole carry rolls back.
          const predecessors = await planChangeSessionRepository.listIdsForUserInScope(
            pctx.projectId,
            source.scopeKey,
            pctx.userId,
            pctx.workspaceId,
            created.id,
            tx,
          );
          await planTargetLockService.acquireForScopeWithin(
            created.id,
            source.targetKeys,
            pctx,
            now,
            tx,
            { takeOverFrom: predecessors },
          );
        }

        const turn = firstTurn();
        if (turn && !waitingPlan) {
          // A conversation-only carry's first turn takes the scope the way any
          // first turn does.
          await planTargetLockService.acquireForScopeWithin(
            created.id,
            source.targetKeys,
            pctx,
            now,
            tx,
          );
        }
        const landed = turn ? await appendWithin(created.id, pctx, turn, {}, tx) : created;
        return toDto(landed, pctx, tx);
      },
    );
  },

  /**
   * The member's own latest GUIDE conversation on one card (Story MOTIR-7459 ·
   * MOTIR-7464; ADR `conversation-turn-intent.md` AMENDMENT 2, A2.2), or `null`.
   * Browse-gated like {@link findResumable}; WRITES NOTHING.
   */
  async findGuide(
    pctx: ProjectContext,
    scope: PlanChangeScope,
  ): Promise<PlanChangeSessionDto | null> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await projectAccessService.assertCanBrowse(pctx.projectId, ctx);
    const row = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      planChangeSessionRepository.findLatestGuideForUser(
        pctx.projectId,
        scope.scopeKey,
        pctx.userId,
        pctx.workspaceId,
        tx,
      ),
    );
    return row ? toDto(row, pctx) : null;
  },

  /**
   * OPEN a guide conversation on one card (MOTIR-7464; AMENDMENT 2, A2.2) — the
   * Guide me through door. In ONE transaction, under the member's scope lock:
   *
   *  * `resume: true` (the card HAS to-do rows) — re-read the member's latest
   *    guide conversation on the card UNDER the lock and, if there is one, return
   *    it with NOTHING appended (`opened: false`). A second tab pressing the door
   *    at the same moment therefore lands on the first tab's conversation instead
   *    of forking a second one.
   *  * otherwise, or with none to resume — create a `guide`-origin session
   *    scoped at the card and append the OPENING turn as `intent: 'guide'`,
   *    anchored on the card (`opened: true`). A card with NO rows always lands
   *    here: a temporary walk cannot be resumed (A2.3).
   *
   * It takes NO `PlanTargetLock` and submits no plan, so the card is never parked
   * at `planning` (A2.2). `ai:plan`-gated: it writes.
   */
  async openGuideWithFirstTurn(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    body: string,
    opts: { resume: boolean },
  ): Promise<{ session: PlanChangeSessionDto; opened: boolean }> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const anchorKey = scope.targetKeys[0] ?? null;
    if (scope.targetKeys.length !== 1 || !anchorKey) {
      throw new Error('A guide conversation is scoped at exactly one card.');
    }
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    const now = new Date();

    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        await planChangeSessionRepository.lockScopeForUser(
          pctx.projectId,
          scope.scopeKey,
          pctx.userId,
          tx,
        );
        if (opts.resume) {
          const existing = await planChangeSessionRepository.findLatestGuideForUser(
            pctx.projectId,
            scope.scopeKey,
            pctx.userId,
            pctx.workspaceId,
            tx,
          );
          if (existing) return { session: await toDto(existing, pctx, tx), opened: false };
        }
        const created = await planChangeSessionRepository.create(
          {
            workspaceId: pctx.workspaceId,
            projectId: pctx.projectId,
            createdById: pctx.userId,
            scopeKey: scope.scopeKey,
            targetKeys: scope.targetKeys,
            origin: 'guide',
            lastActivityAt: now,
          },
          tx,
        );
        const row = await appendWithin(
          created.id,
          pctx,
          {
            role: 'user',
            body: trimmed,
            authorId: pctx.userId,
            intent: 'guide',
            anchorKey,
          },
          {},
          tx,
        );
        return { session: await toDto(row, pctx, tx), opened: true };
      },
    );
  },

  /**
   * A SEEDED first turn (AMENDMENT 17 §9; story MOTIR-6068 · MOTIR-6207) — the
   * re-plan a refused decision opens, started from the gate that refused it. In
   * ONE transaction: take the member's scope lock, assert the seed (the gate is
   * a gate `isPlanningSeedGate` accepts (a refusal or a pick), in this workspace and project, on a
   * work item the scope anchors on — else {@link PlanSeedNotApplicableError} and
   * nothing is written), resume the member's recent session seeded by THIS gate
   * or create one with `seedGateId`, then append the turn exactly as
   * {@link startWithFirstTurn} does.
   *
   * It never resumes an unseeded session, nor one seeded by a different gate,
   * and the stamp is written only when the session is created — never onto an
   * existing row. The result is the session the turn landed on, so a caller
   * that lost a race observes the winner's id. `ai:plan`-gated: it writes.
   */
  async startSeededWithFirstTurn(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    body: string,
    seedGateId: string,
    opts: { isAnswer?: boolean; anchorKey?: string | null } = {},
  ): Promise<PlanChangeSessionDto> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    const now = new Date();

    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const sessionId = await resumeSeededOrStartWithin(pctx, scope, seedGateId, now, tx);
        const row = await appendWithin(
          sessionId,
          pctx,
          {
            role: 'user',
            body: trimmed,
            authorId: pctx.userId,
            isAnswer: opts.isAnswer === true,
            anchorKey: opts.anchorKey ?? null,
          },
          {},
          tx,
        );
        return toDto(row, pctx, tx);
      },
    );
  },

  /**
   * The SEEDED-session read the refusal's door returns to (AMENDMENT 17 §9;
   * MOTIR-6207): the id of the caller's OWN OPEN session seeded by `seedGateId`,
   * else `null` (AMENDMENT 23 §3 — no window). Another member's seeded session
   * is never returned — sessions are per member (MOTIR-6011 §6) — and neither is
   * an ended one. Browse-gated like {@link findResumable}; WRITES NOTHING and
   * takes no lock.
   */
  async findSeededSession(pctx: ProjectContext, seedGateId: string): Promise<string | null> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await projectAccessService.assertCanBrowse(pctx.projectId, ctx);
    const row = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      planChangeSessionRepository.findSeededForUser(
        pctx.projectId,
        seedGateId,
        pctx.userId,
        pctx.workspaceId,
        tx,
      ),
    );
    return row?.id ?? null;
  },

  /**
   * A GUIDE-SEEDED first turn (Story MOTIR-8684 · MOTIR-8691; decision MOTIR-8685):
   * Confirm on a guide's re-plan offer. `body` is the request the guide wrote,
   * SENT once as the planner's first turn on the offer's target. See
   * {@link confirmGuideOfferWithin} for the locks and the refusals.
   *
   * NEVER SENDS TWICE — unlike the gate path, which resumes a same-seed session and
   * appends again, a confirmed offer is refused with
   * {@link GuideReplanOfferAlreadyConfirmedError} carrying the session to open.
   * `ai:plan`-gated: it writes.
   */
  async startGuideSeededWithFirstTurn(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    body: string,
    seedGuideTurnId: string,
  ): Promise<PlanChangeSessionDto> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    const now = new Date();
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const row = await confirmGuideOfferWithin(pctx, scope, seedGuideTurnId, trimmed, now, tx);
        return toDto(row, pctx, tx);
      },
    );
  },

  /**
   * The session a CONFIRMED guide offer started (MOTIR-8691): what the seed read
   * reports and the rail returns to. Browse-gated; writes nothing, takes no lock.
   * Answers for the offer's OWNER only — another member's offer, an undecided or
   * declined one, and an unknown turn id all read `null`, never an error that names
   * the difference. The offer's stored `confirmedSessionId` is read first; if it
   * names nothing in this project, the stamped session is looked up instead.
   */
  async findGuideSeededSession(
    pctx: ProjectContext,
    seedGuideTurnId: string,
  ): Promise<{ sessionId: string; open: boolean } | null> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await projectAccessService.assertCanBrowse(pctx.projectId, ctx);
    return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
      const turn = await planChangeTurnRepository.findById(seedGuideTurnId, pctx.workspaceId, tx);
      if (!turn || turn.role !== 'assistant') return null;
      const guideSession = await planChangeSessionRepository.findByIdInProject(
        turn.sessionId,
        pctx.projectId,
        pctx.workspaceId,
        tx,
      );
      if (
        !guideSession ||
        guideSession.origin !== 'guide' ||
        guideSession.createdById !== pctx.userId
      ) {
        return null;
      }
      const offer = readGuideTurnRecord(turn.guideTurn)?.replanOffer;
      if (!offer || offer.confirmedSessionId === null) return null;
      const named = await planChangeSessionRepository.findByIdInProject(
        offer.confirmedSessionId,
        pctx.projectId,
        pctx.workspaceId,
        tx,
      );
      const found =
        named ??
        (await planChangeSessionRepository.findSeededByGuideTurnForUser(
          pctx.projectId,
          seedGuideTurnId,
          pctx.userId,
          pctx.workspaceId,
          tx,
        ));
      return found ? { sessionId: found.id, open: found.endedAt === null } : null;
    });
  },

  /**
   * The PUBLIC `open` doors' resume-or-start (MOTIR-6028) — `POST
   * /api/v1/projects/{key}/plan-session` and the MCP `open_plan_session`. The
   * caller's resumable session for the scope, or a NEW one, under the same lock
   * and lease hand-over as {@link startWithFirstTurn}, and with no turn.
   *
   * ⚠️ WHY AN OPEN MAY CREATE HERE AND NOT IN THE BROWSER (AMENDMENT 17 §1).
   * The browser's mount is a LOOK and creates nothing. These doors are an
   * explicit act by an API client or agent that is about to talk — and the
   * deployed `motir plan` CLI reads a session (its id and thread) from `open`
   * before its first turn, so returning nothing would break every shipped
   * client. The session this creates is a `conversation` like any other.
   */
  async openForScope(pctx: ProjectContext, scope: PlanChangeScope): Promise<PlanChangeSessionDto> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    const now = new Date();
    const row = await withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const sessionId = await resumeOrStartWithin(pctx, scope, now, tx);
        const session = await planChangeSessionRepository.findById(sessionId, pctx.workspaceId, tx);
        if (!session) throw new PlanSessionNotFoundError(sessionId);
        return session;
      },
    );
    return toDto(row, pctx);
  },

  // ── The PUBLIC doors (MOTIR-6028) ─────────────────────────────────────────
  // The v1 plan-session routes and the MCP `open_plan_session` /
  // `append_plan_turn` / `submit_plan_session` tools share ONE resolution, here,
  // so the two surfaces cannot drift. Each takes an OPTIONAL `sessionId`: given,
  // it addresses exactly that session (another project's is
  // `PLAN_SESSION_NOT_FOUND`); absent, the caller keeps the pre-session
  // behaviour — their resumable session for the scope, or a first turn starts
  // one — so a client built before the id existed keeps working.

  /** Open: the named session, else the caller's resumable one, else a new one. */
  async openPublic(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    sessionId?: string,
  ): Promise<PlanChangeSessionDto> {
    if (!sessionId) return planChangeSessionsService.openForScope(pctx, scope);
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    await assertCanPlan(pctx.projectId, ctx);
    return toDto(await findSessionById(pctx, sessionId), pctx);
  },

  /** Append: to the named session (re-taking its targets, as a continuing
   *  conversation does), else resume-or-start with this turn. */
  async appendPublic(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    body: string,
    sessionId?: string,
  ): Promise<PlanChangeSessionDto> {
    if (!sessionId) return planChangeSessionsService.startWithFirstTurn(pctx, scope, body);
    await requireSession(pctx, { sessionId });
    await planTargetLockService.acquireForScope(sessionId, scope.targetKeys, pctx);
    return planChangeSessionsService.appendTurn(body, pctx, { sessionId });
  },

  /** Submit: the named session, else the caller's resumable one — with neither
   *  there is nothing to submit (`PLAN_CHANGE_SESSION_NOT_FOUND`). */
  async submitPublic(
    pctx: ProjectContext,
    scope: PlanChangeScope,
    requirement?: SubmittedRequirement,
    sessionId?: string,
  ): Promise<PlanChangeSubmitResultDto> {
    // Gated by the SIBLINGS it delegates to (`findResumable` browse, `submit`
    // `ai:plan`) — `tests/permissions/noUngovernedOperation.test.ts` follows this
    // `this.` hop as its real-code control.
    const id = sessionId ?? (await this.findResumable(pctx, scope.scopeKey))?.id;
    if (!id) throw new PlanChangeSessionNotFoundError(pctx.projectId);
    return this.submit(pctx, { sessionId: id }, requirement);
  },

  /**
   * Append what the user just typed to the thread and return the UPDATED session
   * (the full ordered thread included — the rail renders straight from it).
   * Appending does NOT submit: turns accumulate until the user asks for the
   * change, which is what makes refinement across turns possible.
   *
   * `address` names WHICH conversation, by its `{ sessionId }`.
   *
   * `isAnswer` marks the turn as the REPLY to the planner's pending question
   * (MOTIR-2226) — set by the composer's answer bar, and by nothing else. It
   * changes no behaviour on the way in; it is recorded so the transcript can say
   * later whether the question was answered or merely superseded, which is a
   * judgement the words themselves cannot be asked to carry.
   */
  async appendTurn(
    body: string,
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
    opts: {
      isAnswer?: boolean;
      intent?: PlanChangeTurnIntent;
      jobId?: string;
      anchorKey?: string | null;
      /**
       * The planning job that was RUNNING when this turn was typed (MOTIR-7996).
       * Marks the turn as a mid-run turn, which is what keeps its settle from ever
       * opening a new planning run for it.
       */
      runJobId?: string;
      /**
       * The files a GUIDE turn carries (MOTIR-7484; `guide-turn-files.md` A3.2),
       * already validated by `aiGuideService` against the guided card. A turn
       * with files may carry no words, so the empty-body refusal narrows to a
       * turn with neither.
       */
      attachmentIds?: readonly string[];
    } = {},
  ): Promise<PlanChangeSessionDto> {
    const trimmed = body.trim();
    const files = opts.attachmentIds ?? [];
    if (!trimmed && files.length === 0) throw new EmptyPlanChangeTurnError();
    const session = await requireSession(pctx, address);
    return appendLocked(session, pctx, {
      role: 'user',
      body: trimmed,
      authorId: pctx.userId,
      isAnswer: opts.isAnswer === true,
      // ⚠️ SERVER-RESOLVED (ADR §1). `opts.intent` is what the ASK SERVICE
      // decided after motir-ai classified the turn — never a value parsed off a
      // request body. The shipped plan-change append passes nothing and its
      // turns keep a null intent, exactly as every turn written before the
      // model existed does; that is why there is no back-fill.
      intent: opts.intent ?? null,
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      // The anchor the ASK SERVICE resolved (MOTIR-7064) — an identifier this
      // caller can see, never the raw posted string.
      anchorKey: opts.anchorKey ?? null,
      ...(opts.runJobId ? { runJobId: opts.runJobId } : {}),
      ...(files.length > 0 ? { attachmentIds: files } : {}),
    });
  },

  /**
   * Append the ANSWER an ask produced, as an `assistant` turn carrying its
   * CITATIONS (MOTIR-1818; ADR §1). The write half of the ask loop —
   * `recordPlannerTurn` is its plan-change sibling, and the two deliberately
   * share `appendLocked`'s row-locked allocation rather than growing a second
   * append path.
   *
   * IDEMPOTENT ON `jobId`, the same guarantee and the same mechanism the planner
   * turn has: the client records the answer when its stream settles, and a
   * reload, a second tab or a retried settle all replay that call. The skip is
   * evaluated UNDER the session lock, so two concurrent replays cannot both pass
   * it.
   *
   * CITATIONS ARE VALIDATED BEFORE THEY PERSIST — see {@link resolveCitations}.
   * A key that names no work item IN THIS PROJECT is dropped rather than stored,
   * because the rail renders each one as a work-item chip and a chip that
   * resolves to nothing is worse than a missing citation: it asserts the answer
   * rested on something it did not.
   *
   * A DEBUG reply carries its `debugLanding` (MOTIR-7064) — what the turn wrote,
   * or that it wrote nothing — persisted in THIS append, so the reply and the
   * outcome line it renders commit together and a reload redraws both.
   */
  async appendAnswerTurn(
    input: {
      jobId: string;
      body: string;
      citations?: readonly string[];
      debugLanding?: DebugLandingDto | null;
      /** The exact text this answer OFFERS to forward to the running planner
       *  (MOTIR-7996) — the offered `user` turn's body. */
      forwardOffer?: string | null;
      /** Set when the answer was given WITHOUT the code (MOTIR-8141): the stored
       *  face its notice is drawn from. */
      codeUnreadable?: PlanChangeTurnOutage | null;
      /** The ONE offer this answer ended with (MOTIR-9288), persisted with the turn
       *  in this append — undecided. No gate here: an offer that cannot start is a
       *  state the rail renders, so the write refuses none. */
      answerOffer?: AnswerOfferInput | null;
    },
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const trimmed = input.body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const session = await requireSession(pctx, address);
    const citations = await resolveCitations(input.citations ?? [], pctx);
    return appendLocked(
      session,
      pctx,
      {
        role: 'assistant',
        body: trimmed,
        jobId: input.jobId,
        citations,
        debugLanding: input.debugLanding ?? null,
        forwardOffer: input.forwardOffer ?? null,
        codeUnreadable: input.codeUnreadable ?? null,
        answerOffer: input.answerOffer ?? null,
      },
      {},
      async (tx) =>
        (await planChangeTurnRepository.findByJobIdAndRole(
          session.id,
          input.jobId,
          'assistant',
          pctx.workspaceId,
          tx,
        )) !== null,
    );
  },

  /**
   * Record what a `user` turn actually RAN AS (MOTIR-1818; ADR §1/§3).
   *
   * Two callers, one write. The REDIRECT: `ask_project` classified the turn as a
   * plan change, so the effective disposition moves before the plan-change job
   * is dispatched. The CORRECTION: the person pressed "Answer this instead" (the
   * only direction left, AMENDMENT 3), so the turn is re-run as an answer — same turn, no
   * second `user` row, because the thread is a record of who said what and they
   * said it once. `corrected` is what separates the two on the record.
   *
   * Under the session's row lock, so it cannot interleave with an append. A turn
   * id that is not on this thread — or is on another tenant's — raises
   * `PlanChangeTurnNotFoundError` rather than silently patching nothing.
   */
  async recordTurnIntent(
    turnId: string,
    intent: PlanChangeTurnIntent,
    pctx: ProjectContext,
    opts: {
      corrected?: boolean;
      jobId?: string;
      forwardedEntryId?: string;
      revisedLateJobId?: string;
    } = {},
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const session = await requireSession(pctx, address);
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
        const turn = await planChangeTurnRepository.findByIdInSession(
          turnId,
          session.id,
          pctx.workspaceId,
          tx,
        );
        if (!turn) throw new PlanChangeTurnNotFoundError(turnId);
        await planChangeTurnRepository.updateIntent(
          turn.id,
          {
            intent,
            ...(opts.jobId ? { jobId: opts.jobId } : {}),
            // The mailbox entry a mid-run turn was FORWARDED as (MOTIR-7996),
            // written in the SAME locked write that records `plan_change`.
            ...(opts.forwardedEntryId ? { forwardedEntryId: opts.forwardedEntryId } : {}),
            // The REVISE_PLAN job a late change became (MOTIR-7997), same locked write.
            ...(opts.revisedLateJobId ? { revisedLateJobId: opts.revisedLateJobId } : {}),
            // `corrected` LATCHES: a turn re-read a second time stays corrected,
            // because what the flag records is that Motir once got it wrong, and
            // that does not stop being true.
            intentCorrected: opts.corrected === true || turn.intentCorrected,
          },
          tx,
        );
        // A correction is the member acting on the thread, so it moves
        // `lastActivityAt` like a turn does (AMENDMENT 17 §3).
        const fresh = await planChangeSessionRepository.update(
          session.id,
          { lastActivityAt: new Date() },
          tx,
        );
        return toDto(fresh, pctx, tx);
      },
    );
  },

  /**
   * THE CONTROL (MOTIR-7649; ADR AMENDMENT 3, A3.3) — Plan something new pressed:
   * append the SAME fixed confirm the words produce to the caller's own open
   * conversation session. Idempotent: a confirm already pending returns the
   * session unchanged. An ended session is `PLAN_SESSION_ENDED`.
   */
  async requestRestartConfirm(
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const session = await requireSession(pctx, address);
    assertRestartable(session, pctx);
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
        const fresh = await planChangeSessionRepository.findById(session.id, pctx.workspaceId, tx);
        if (!fresh) throw new PlanChangeSessionNotFoundError(pctx.projectId);
        // Checked under the lock: an end that commits first is always seen.
        if (fresh.endedAt) throw new PlanSessionEndedError(fresh.id);
        const row = await appendWithin(fresh.id, pctx, NEW_SESSION_CONFIRM_TURN, {}, tx, (t) =>
          restartConfirmPendingWithin(fresh.id, pctx.workspaceId, t),
        );
        return toDto(row, pctx, tx);
      },
    );
  },

  /**
   * KEEP PLANNING (MOTIR-7649; ADR AMENDMENT 3, A3.2): the confirm's second
   * answer. Writes the `system` marker that answers a PENDING confirm and closes
   * nothing. With no confirm pending (already answered, superseded by a later
   * turn, or the session ended) it writes nothing and returns the thread.
   */
  async keepPlanning(
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const session = await requireSession(pctx, address);
    assertRestartable(session, pctx);
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const row = await appendWithin(
          session.id,
          pctx,
          { role: 'system', body: KEEP_PLANNING_MARKER_BODY },
          {},
          tx,
          async (t) => {
            const now = await planChangeSessionRepository.findById(session.id, pctx.workspaceId, t);
            if (!now || now.endedAt) return true;
            return !(await restartConfirmPendingWithin(session.id, pctx.workspaceId, t));
          },
        );
        return toDto(row, pctx, tx);
      },
    );
  },

  /**
   * CONFIRM — Plan something new (MOTIR-7649; ADR AMENDMENT 3, A3.3/A3.4). In ONE
   * transaction under the member's scope lock: end the caller's own conversation
   * session `restarted` through AMENDMENT 23's one end operation (its `generating`
   * plan discarded as the person's decision, every card it held given back), then
   * return a NEW, empty `conversation` session for the same scope. It holds no
   * lock until its first turn, which takes the scope as any first turn does.
   *
   * Two edges, both by the decision: a session that had ALREADY ended ends
   * nothing and still gets a new session; and when the caller already has an
   * open session for the scope — or one holding one of its cards (the take-back)
   * — that session is returned and nothing is created.
   */
  async restart(
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanSessionRestartResultDto> {
    const session = await requireSession(pctx, address);
    assertRestartable(session, pctx);
    const now = new Date();
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        // The scope lock FIRST, as every start takes it: a first turn racing this
        // restart for the same scope serialises behind it instead of creating a
        // second open session beside the new one.
        await planChangeSessionRepository.lockScopeForUser(
          pctx.projectId,
          session.scopeKey,
          pctx.userId,
          tx,
        );
        await endSessionWithin(tx, session.id, pctx.workspaceId, 'restarted', {
          endedById: pctx.userId,
          actor: { userId: pctx.userId, workspaceId: pctx.workspaceId },
          now,
        });
        const open =
          (await planChangeSessionRepository.findResumableForUser(
            pctx.projectId,
            session.scopeKey,
            pctx.userId,
            pctx.workspaceId,
            tx,
          )) ??
          (await planChangeSessionRepository.findOpenHoldingForUser(
            pctx.projectId,
            session.targetKeys,
            pctx.userId,
            pctx.workspaceId,
            tx,
          ));
        const next =
          open ??
          (await planChangeSessionRepository.create(
            {
              workspaceId: pctx.workspaceId,
              projectId: pctx.projectId,
              createdById: pctx.userId,
              scopeKey: session.scopeKey,
              targetKeys: session.targetKeys,
              origin: 'conversation',
              lastActivityAt: now,
            },
            tx,
          ));
        return {
          outcome: 'restarted' as const,
          endedSessionId: session.id,
          session: await toDto(next, pctx, tx),
        };
      },
    );
  },

  /**
   * PLANNING SOMETHING ELSE MID-PLANNING (Story MOTIR-9219 · MOTIR-9293; AMENDMENT 5
   * clause 7): a confirmed plan offer on a conversation that already holds an undecided
   * plan ends that conversation through the restart lifecycle Plan something new uses,
   * and puts the offered request on the session that follows it. It DISPATCHES NO JOB:
   * the confirm entry (`planOfferStartService`) runs its one `submit` on the returned
   * session when `ownsStart` is true, and starts nothing when it is false.
   *
   *  - refuses another member's session and a guide conversation as the button does
   *    (`PLAN_SESSION_NOT_FOUND`), and a caller without `ai:plan` (`requireSession`);
   *  - an addressed session that already ENDED ends nothing, creates nothing and
   *    appends nothing: `ownsStart: false`, with the caller's open session for the
   *    offer's scope when there is one — which is what makes a replayed confirm harmless;
   *  - a session with a run records the shipped Stop for its `lastJobId` FIRST, outside
   *    the transaction, so the walk reads it at its next boundary (a no-op when the run
   *    already finished). A restart that then fails leaves a stopped run on an open
   *    session, which the person can confirm again;
   *  - then, in ONE transaction: the offer's scope lock, the end (`restarted`, by the
   *    caller), the successor resolved the way a first turn resolves it — so it holds
   *    the offered targets' lease, which `submit` only refreshes — and the request as
   *    its `user` turn. A refused lease rolls all three back.
   */
  async restartForPlanOffer(
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
    input: { requestMd: string; scope: PlanChangeScope; offerRef: string },
  ): Promise<PlanOfferRestartResultDto> {
    const session = await requireSession(pctx, address);
    assertRestartable(session, pctx);
    const request = input.requestMd.trim();
    if (!request) throw new EmptyPlanChangeTurnError();
    const txCtx = { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId };

    const openForScope = async (tx: Prisma.TransactionClient) =>
      planChangeSessionRepository.findResumableForUser(
        pctx.projectId,
        input.scope.scopeKey,
        pctx.userId,
        pctx.workspaceId,
        tx,
      );
    if (session.endedAt) {
      return withWorkspaceContext(txCtx, async (tx) => {
        const open = await openForScope(tx);
        return {
          outcome: 'already' as const,
          endedSessionId: null,
          session: open ? await toDto(open, pctx, tx) : null,
          ownsStart: false,
        };
      });
    }

    if (session.lastJobId) {
      await planChangeMailboxService.raiseStop(
        session.lastJobId,
        offerRestartStopKey(input.offerRef),
        pctx,
        session.id,
      );
    }

    const now = new Date();
    return withWorkspaceContext(txCtx, async (tx) => {
      // The offer's scope lock FIRST, as every start takes it, so a first turn racing
      // this confirm serialises instead of opening a second session beside the
      // successor. The session's row lock is NOT taken before the end: the end locks
      // the plan and then the session, and the other order deadlocks.
      await planChangeSessionRepository.lockScopeForUser(
        pctx.projectId,
        input.scope.scopeKey,
        pctx.userId,
        tx,
      );
      const ended = await endSessionWithin(tx, session.id, pctx.workspaceId, 'restarted', {
        endedById: pctx.userId,
        actor: { userId: pctx.userId, workspaceId: pctx.workspaceId },
        now,
      });
      // Ended by another write between the read above and this lock: its end stands,
      // and this call owns no start.
      if (!ended.ended) {
        const open = await openForScope(tx);
        return {
          outcome: 'already' as const,
          endedSessionId: null,
          session: open ? await toDto(open, pctx, tx) : null,
          ownsStart: false,
        };
      }
      const successorId = await resumeOrStartWithin(pctx, input.scope, now, tx);
      const row = await appendWithin(
        successorId,
        pctx,
        { role: 'user', body: request, authorId: pctx.userId },
        {},
        tx,
      );
      return {
        outcome: 'restarted' as const,
        endedSessionId: session.id,
        session: await toDto(row, pctx, tx),
        ownsStart: true,
      };
    });
  },

  /**
   * The conversation's latest UNDECIDED plan with its status as the next turn reads it
   * (MOTIR-9291) — the read {@link submit} routes by, for a start that must refuse a
   * conversation already planning. Null when it holds none. `tx` joins the caller's.
   */
  async heldPlanOf(
    _pctx: ProjectContext,
    address: PlanChangeSessionAddress,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; status: SessionTurnPlanStatus } | null> {
    const row = await planRepository.findLatestUndecidedBySession(address.sessionId, tx);
    return row ? { id: row.id, status: await turnStatusOf(row, tx) } : null;
  },

  /**
   * CLAIM the ONE write a confirmed `log_bug` offer makes (MOTIR-7049's claim, fed by
   * the stored offer since MOTIR-9323) — a compare-and-set of the OFFER turn's
   * `debugLandingClaimedAt` under the session's row lock, the serialisation every
   * turn write takes. `true` when THIS call claimed it; `false` when an earlier or
   * concurrent confirm already had — the loser's cue to write nothing and read the
   * winner's landing. Only the thread's PENDING `log_bug` offer can be claimed: a
   * declined or superseded one refuses `offer_not_open`, and a turn holding no such
   * offer is the shipped 404.
   */
  async claimDebugLanding(
    turnId: string,
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<boolean> {
    const session = await requireSession(pctx, address);
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
        const rows = await planChangeTurnRepository.listBySessionId(
          session.id,
          pctx.workspaceId,
          tx,
        );
        // Only the person whose conversation it is may confirm its offer.
        if (session.createdById !== pctx.userId) throw new PlanChangeTurnNotFoundError(turnId);
        const turns = offerTurns(rows);
        const turn = turns.find((t) => t.id === turnId);
        if (!turn || turn.role !== 'assistant' || turn.offer?.kind !== 'log_bug') {
          throw new PlanChangeTurnNotFoundError(turnId);
        }
        if (rows.find((r) => r.id === turnId)!.debugLandingClaimedAt !== null) return false;
        if (pendingPlanOfferOf(turns)?.turnId !== turnId) {
          throw new PlanOfferStartRefusedError('offer_not_open');
        }
        return planChangeTurnRepository.claimDebugLanding(turnId, pctx.workspaceId, tx);
      },
    );
  },

  /**
   * STAMP a claimed `log_bug` offer's landing (MOTIR-9323): the offer is marked
   * confirmed by the caller and the landing recorded as `debugLanding` on the offer's
   * OWN answer turn, in one locked write — no new turn, so the outcome line the rail
   * draws from that turn and a reloaded thread agree.
   */
  async recordDebugLanding(
    turnId: string,
    landing: DebugLandingDto,
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const session = await requireSession(pctx, address);
    await withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
        const row = await planChangeTurnRepository.findByIdInSession(
          turnId,
          session.id,
          pctx.workspaceId,
          tx,
        );
        if (!row?.answerOffer || row.debugLandingClaimedAt === null) {
          throw new PlanChangeTurnNotFoundError(turnId);
        }
        await planChangeTurnRepository.confirmDebugLanding(
          row.id,
          pctx.workspaceId,
          {
            ...(row.answerOffer as Record<string, unknown>),
            confirmedAt: new Date().toISOString(),
            confirmedById: pctx.userId,
          } as Prisma.InputJsonValue,
          {
            outcome: landing.outcome,
            workItemKey: landing.workItemKey,
            title: landing.title,
            createdInTriage: landing.createdInTriage,
          },
          tx,
        );
      },
    );
    return planChangeSessionsService.getById(pctx, session.id);
  },

  /**
   * CLAIM a `guide` turn's landing (MOTIR-7470; ADR AMENDMENT 2, A2.4) — a
   * compare-and-set of the turn's `guideLandingClaimedAt` under the session's row
   * lock, {@link claimDebugLanding}'s shape. `true` when THIS call claimed it;
   * `false` when an earlier or concurrent settle of the same job already had, the
   * loser's cue to land nothing. Only a `user` turn that ran as `guide` can be
   * claimed.
   */
  async claimGuideLanding(
    turnId: string,
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<boolean> {
    const session = await requireSession(pctx, address);
    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
        const turn = await planChangeTurnRepository.findByIdInSession(
          turnId,
          session.id,
          pctx.workspaceId,
          tx,
        );
        if (!turn || turn.role !== 'user') throw new PlanChangeTurnNotFoundError(turnId);
        if (turn.intent !== 'guide') return false;
        return planChangeTurnRepository.claimGuideLanding(turn.id, pctx.workspaceId, tx);
      },
    );
  },

  /**
   * Append a guide turn's REPLY (MOTIR-7470) — the `assistant` turn carrying the
   * job's message and its {@link GuideTurnRecord}, in ONE append. IDEMPOTENT ON
   * `jobId` under the session lock, {@link appendAnswerTurn}'s mechanism, so a
   * replayed settle never appends a second reply.
   */
  async appendGuideReplyTurn(
    input: { jobId: string; body: string; record: GuideTurnRecord },
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const trimmed = input.body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const session = await requireSession(pctx, address);
    return appendLocked(
      session,
      pctx,
      { role: 'assistant', body: trimmed, jobId: input.jobId, guideTurn: input.record },
      {},
      async (tx) =>
        (await planChangeTurnRepository.findByJobIdAndRole(
          session.id,
          input.jobId,
          'assistant',
          pctx.workspaceId,
          tx,
        )) !== null,
    );
  },

  /**
   * Decline a guide conversation's re-plan offer (MOTIR-8689; decision MOTIR-8685):
   * stamps `declinedAt` / `declinedById` on the offer, under the session's row lock
   * (the lock `claimGuideLanding` takes, so a decline serializes against a landing
   * and against a later Confirm). Appends no turn, submits no job, plans nothing,
   * spends nothing, and does not touch the work item.
   *
   *  - not the caller's own `guide` session, or no offer on that assistant turn ⇒
   *    404, with nothing telling the cases apart;
   *  - already `declined` ⇒ IDEMPOTENT: the thread comes back, nothing is written;
   *  - `superseded` ⇒ `GuideReplanOfferNotOpenError`.
   *
   *  - `confirmed` (a planning session was started from it, MOTIR-8691) ⇒ also
   *    `GuideReplanOfferNotOpenError`, writing nothing.
   */
  async declineGuideReplanOffer(
    turnId: string,
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const session = await requireSession(pctx, address);
    if (session.origin !== 'guide' || session.createdById !== pctx.userId) {
      throw new PlanChangeSessionNotFoundError(pctx.projectId);
    }
    await withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
        const rows = await planChangeTurnRepository.listBySessionId(
          session.id,
          pctx.workspaceId,
          tx,
        );
        const turns = rows.map((t) => ({
          id: t.id,
          role: t.role,
          guide: readGuideTurnRecord(t.guideTurn),
        }));
        const state = replanOfferStateOf(turns, turnId);
        if (state === null) throw new GuideReplanOfferNotFoundError(turnId);
        if (state === 'declined') return;
        // `superseded` and `confirmed` can no longer be declined.
        if (state === 'superseded' || state === 'confirmed') {
          throw new GuideReplanOfferNotOpenError(turnId);
        }
        const row = rows.find((t) => t.id === turnId)!;
        const record = readGuideTurnRecord(row.guideTurn)!;
        await planChangeTurnRepository.setGuideTurn(
          row.id,
          pctx.workspaceId,
          // The stored JSON, with only the offer's decision changed: every other
          // key of the column rides through untouched.
          {
            ...(row.guideTurn as Record<string, unknown>),
            replanOffer: {
              ...record.replanOffer!,
              declinedAt: new Date().toISOString(),
              declinedById: pctx.userId,
            },
          } as Prisma.InputJsonValue,
          tx,
        );
      },
    );
    return planChangeSessionsService.getById(pctx, session.id);
  },

  /**
   * RELEASE a debug landing's claim (MOTIR-7049). The caller does this ONLY when
   * the write was refused inside its own transaction — so nothing committed — and
   * a later confirm may try again. A claim is never released after a write that
   * may have committed: the landing fails closed rather than writing twice.
   */
  async releaseDebugLanding(
    turnId: string,
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<void> {
    const session = await requireSession(pctx, address);
    await withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
        await planChangeTurnRepository.releaseDebugLanding(turnId, pctx.workspaceId, tx);
      },
    );
  },

  /**
   * Record the PLANNER's turn for a settled job — the consuming half of
   * MOTIR-2222's contract (MOTIR-2226).
   *
   * The planning job's result carries a findings report and, when the request was
   * not determinate, one question. This persists that utterance as an `assistant`
   * turn so it lands in the thread's history: the report becomes a checkpoint the
   * user can act on, and a question becomes something that survives a reload and
   * can still be answered tomorrow.
   *
   * THREE properties this method exists to hold, none of which the caller can be
   * asked to guarantee:
   *
   *  1. **At most one turn per job.** The client records on settle, and a reload,
   *     a second tab or a re-read replays that call — so the append carries an
   *     idempotency gate on `(session, jobId, assistant)`, evaluated under the
   *     session's row lock. Every replay after the first is a no-op that returns
   *     the thread unchanged.
   *  2. **Only the thread's OWN job.** The job id arrives from the client, so it
   *     is checked against the session's `lastJobId` rather than trusted: a job
   *     this conversation did not submit has no business narrating into it.
   *  3. **A silent job is not a failure.** No result, no `turn`, or an
   *     unreadable one (an older engine, a kind that emits none) returns the
   *     thread as it stands. The run still happened and its proposals are still
   *     on the canvas; the only thing missing is narration.
   *
   * SIDE-EFFECTS-OUTSIDE-TX (CLAUDE.md): the motir-ai read and the reference
   * normalization both happen BEFORE the short locked append, so no session row
   * is held across a network round-trip.
   */
  async recordPlannerTurn(
    jobId: string,
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<PlanChangeSessionDto> {
    const session = await requireSession(pctx, address);
    // (2) The thread narrates its OWN run. A mismatch is not an error — the
    // client may simply be replaying a stale settle after a newer turn — so it
    // yields the current thread rather than throwing at the user.
    if (session.lastJobId !== jobId) return toDto(session, pctx);

    const job = await getJob(jobId, pctx.projectId);

    // THE OUTAGE FACE (Story MOTIR-8136 · MOTIR-8141). A plan-writing job that met an
    // unreadable code graph ends SUCCESSFULLY and wrote no plan; it is NOT the failed
    // path ("That didn't go through") and it is not silent either — the person is told
    // plainly, on a turn that remembers it. The words are the catalogue's, drawn from
    // the stored face (`planningWorkspace.codeUnreadable`), never from this body; the
    // English here is only the non-empty fallback every turn row must carry. Same
    // idempotency gate as the append below, so a replayed settle writes nothing.
    if (readCodeUnreadable(job.result) === 'declined') {
      return appendLocked(
        session,
        pctx,
        {
          role: 'assistant',
          body: DECLINED_FALLBACK_BODY,
          jobId,
          codeUnreadable: 'declined',
        },
        {},
        async (tx) =>
          (await planChangeTurnRepository.findByJobIdAndRole(
            session.id,
            jobId,
            'assistant',
            pctx.workspaceId,
            tx,
          )) !== null,
      );
    }

    // THE CODE-CAN'T-BE-SEARCHED FACE (Story MOTIR-9165 · MOTIR-9167). A conversation that
    // stopped because a TARGET repository has no usable code graph opened no planning job;
    // its result carries the blocked list. The turn remembers it, so the overlay's banner
    // survives a reload. Same idempotency gate as the append below.
    const unsearchable = readCodeUnsearchable(job.result);
    if (unsearchable) {
      return appendLocked(
        session,
        pctx,
        {
          role: 'assistant',
          body: UNSEARCHABLE_FALLBACK_BODY,
          jobId,
          codeUnsearchable: unsearchable,
        },
        {},
        async (tx) =>
          (await planChangeTurnRepository.findByJobIdAndRole(
            session.id,
            jobId,
            'assistant',
            pctx.workspaceId,
            tx,
          )) !== null,
      );
    }

    const utterance = readPlanningTurn(job.result);
    if (!utterance) return toDto(session, pctx); // (3)

    // The report names work items by bare key; rewriting them to the canonical
    // `[KEY](motir:<id>)` token is what makes them render as the shipped
    // `WorkItemRefChip` rather than as plain text — the same write-side
    // normalization every stored body gets (MOTIR-1440), reused, not reinvented.
    //
    // BOUND, and the binding is opened HERE rather than threaded (MOTIR-2960).
    // `normalizeBodyRefs` resolves key → id through `findByIdentifiers`, whose
    // `tx ?? db` falls back to the singleton; `work_item` is workspace-keyed, so
    // an unbound resolve under `motir_app` matches no row and returns `[]` —
    // with no error and no log. The failure is therefore SILENT and total: every
    // key stays plain text and `workItemRefs` comes back empty, which reads as
    // "the planner linked nothing" rather than as a fault. The other four
    // `normalizeBodyRefs` callers sit inside a write transaction and pass its
    // `tx`; this one normalizes BEFORE `appendLocked` opens its short lock
    // (side-effects-outside-tx, above), so there is no `tx` to thread and the
    // correct fix is its own read-only binding — the same shape `toDto` uses a
    // few hundred lines up for exactly this reason (MOTIR-2846).
    const [normalized] = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      normalizeBodyRefs(
        {
          projectId: pctx.projectId,
          projectIdentifier: pctx.project.identifier,
          fields: [utterance.message],
        },
        tx,
      ),
    );

    return appendLocked(
      session,
      pctx,
      {
        role: 'assistant',
        body: typeof normalized === 'string' ? normalized : utterance.message,
        jobId,
        question: utterance.question,
      },
      {},
      // (1) Under the lock, so two concurrent replays cannot both pass it.
      async (tx) =>
        (await planChangeTurnRepository.findByJobIdAndRole(
          session.id,
          jobId,
          'assistant',
          pctx.workspaceId,
          tx,
        )) !== null,
    );
  },

  /**
   * Submit the thread's ACCUMULATED intent to the shipped plan-edit job contract
   * and record the submission on the thread.
   *
   * The job is an ordinary `augment` — the rail streams it via the existing
   * `GET /api/ai/augment/[jobId]` and approves the delta via the existing
   * approve route; this seam adds neither. The marker turn's body IS the exact
   * intent that went out, so the thread carries its own provenance (what was
   * sent, and which job it became) with no invented, untranslatable copy.
   *
   * Ordering is deliberate: the motir-ai round-trip happens OUTSIDE the
   * transaction, which then only records the outcome.
   *
   * A CONTEXTUAL thread (7.12.3 · MOTIR-909 — one whose `targetKeys` are
   * non-empty) submits through the same job contract with the anchor set attached,
   * so motir-ai (7.12.2 · MOTIR-908) classifies the turn against those items'
   * neighborhood. The thread's own scope decides that — there is no second submit
   * surface and no second job kind.
   *
   * `requirement` (Story MOTIR-3942 · MOTIR-4172) is the optional six-field WHAT
   * the caller settled before submitting, riding through to `context.requirement`
   * on the envelope. It is a PASS-THROUGH: this seam neither validates it,
   * defaults it, nor persists it on the thread.
   *
   * ⚠️ BOTH ARMS OF THE FORK BELOW CARRY IT, stated rather than left to be read
   * off the code. A dispatched agent's re-plan is always ANCHORED, so the
   * contextual arm is the one that matters in practice and the augment arm is
   * the one that would go unnoticed if it silently dropped the value — which is
   * exactly why it does not. The two arms differ in what motir-ai classifies the
   * turn AGAINST, never in what reaches the envelope.
   *
   * ⚠️ AND IT IS NOT WRITTEN ONTO THE THREAD. The prose turns are the thread's
   * record and the marker turn's body stays byte-identical to the intent that
   * went out; persisting the struct back onto the session is a different seam
   * (MOTIR-4159), and writing it here would give the thread a second, silently
   * divergent copy of the same value.
   */
  async submit(
    pctx: ProjectContext,
    address: PlanChangeSessionAddress,
    requirement?: SubmittedRequirement,
    opts: { planAgainOf?: string | null } = {},
  ): Promise<PlanChangeSubmitResultDto> {
    const session = await requireSession(pctx, address);
    // A guide conversation never plans (AMENDMENT 2, A2.2): refused before its
    // turns are read, so no plan-edit job is ever submitted for one.
    if (session.origin === 'guide') throw new GuideSessionNotPlannableError(session.id);
    // A FAILED-WAITING session submits nothing new (Story MOTIR-7905 · MOTIR-7916): the
    // ordinary submit would open a SECOND plan beside the one the session holds and make the
    // failure record name a job that is no longer the session's attempt. The ways on are Resume
    // (`planSessionResumeService`) or ending the session. A PRE-check, not a re-check under the
    // lock: the one window left needs the running attempt to fail in the same instant a person
    // submits, and closing it would orphan an already-opened plan.
    // NARROWED BY MOTIR-7938: only a session holding a resumable failed walk (or a shape with no
    // other exit) is refused. A failed session whose most recent undecided plan is `planned` /
    // `stale` — situation 2 — falls through to the revise routing, and the bind clears the
    // failure in the same transaction that records the turn.
    const failedTurn = classifyFailedWaitingTurn({
      waiting: sessionWaitingState(session),
      failedJobId: session.failedJobId,
      failureResumable: session.failureResumable,
      plans:
        sessionWaitingState(session) === 'failed'
          ? await withWorkspaceServiceContext(pctx.workspaceId, async (tx) =>
              Promise.all(
                (await planRepository.listUndecidedBySession(session.id, tx)).map(async (p) => ({
                  ...p,
                  status: await turnStatusOf(p, tx),
                })),
              ),
            )
          : [],
    });
    if (failedTurn === 'refuse_resume') throw new PlanSessionAwaitingResumeError(session.id);
    const clearFailure = failedTurn === 'continue';
    const turns = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      planChangeTurnRepository.listBySessionId(session.id, pctx.workspaceId, tx),
    );
    const intent = buildAccumulatedIntent(turns);
    if (!intent) throw new EmptyPlanChangeIntentError(session.id);

    // An ENDED conversation plans nothing more (AMENDMENT 23 §3): its waiting
    // plan is carried into a new session instead (MOTIR-7930). An accept of a
    // stale outcome whose plan was decided meanwhile (deciding the latest plan
    // ends its session) says so rather than just "ended".
    if (session.endedAt) {
      if (opts.planAgainOf) {
        const refusal = await planAgainRefusal(session.id, opts.planAgainOf, 'decided', null, pctx);
        if (
          refusal instanceof PlanSessionPlanDecidedError &&
          (refusal.planStatus === 'approved' || refusal.planStatus === 'declined')
        ) {
          throw refusal;
        }
      }
      throw new PlanSessionEndedError(session.id);
    }

    // ROUTED BY THE PLAN THE CONVERSATION WAITS ON (MOTIR-7945): a `planned`
    // plan is revised in place, a `stale` one is answered in words, and an
    // accept of that answer plans it again. Read outside any lock — every
    // branch that writes re-checks under its own lock.
    const latest = await withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
      const row = await planRepository.findLatestUndecidedBySession(session.id, tx);
      return row ? { id: row.id, status: await turnStatusOf(row, tx) } : null;
    });
    const turn = classifySessionTurn({
      origin: session.origin,
      endedAt: session.endedAt,
      latestUndecided: latest,
      planAgainOf: opts.planAgainOf,
    });
    if (turn.kind === 'revise') {
      return reviseOrQueueWithinSession(session, pctx, turn.planId, intent, turns, {
        clearFailure,
      });
    }
    if (turn.kind === 'stale') throw await staleOutcome(turn.planId, pctx);
    if (turn.kind === 'plan_again_refused') {
      throw await planAgainRefusal(
        session.id,
        opts.planAgainOf!,
        turn.reason,
        latest?.id ?? null,
        pctx,
      );
    }
    let claim: PlanAgainClaim | null = null;
    if (turn.kind === 'plan_again') {
      const claimed = await claimPlanAgain(session, pctx, turn.stalePlanId);
      if (claimed.kind === 'revise') {
        return reviseOrQueueWithinSession(session, pctx, claimed.planId, intent, turns, {
          clearFailure,
        });
      }
      claim = claimed;
    }

    // Side effect OUTSIDE the tx: the shipped submit path (tenant/org resolution,
    // code context, the metered motir-ai job). Its typed errors (out-of-credits /
    // transport) propagate for the route to map — a failed submit leaves the
    // thread untouched, so the user can retry without losing their turns. A
    // failure therefore also yields NO plan: `submitPlanEditJob` opens the Plan
    // only AFTER the job is accepted, so there is no `planId` to report and no
    // orphan row to clean up.
    //
    // KEYED (MOTIR-9258): a submit that outlives a waking motir-ai is re-sent under
    // one key, and a repeat that comes back with a job already planned into gets
    // that job's plan back (`createPlan`), never a second one.
    const idempotencyKey = planningSubmitKey(turns, session.lastJobId);
    // CARRIED ANSWERS (Story MOTIR-9221 · MOTIR-9315): what the person settled when
    // this conversation was grilled before planning rides the run, so the run does
    // not grill that request again. Read now, at submit, so a Stop, a finish or Grill
    // me switched off all carry what was settled so far. A fresh run only: a plan
    // again re-plans what an earlier run already carried.
    const carriedAnswers = claim ? undefined : await carriedAnswersFor(session, pctx);
    const submitOpts = {
      sessionId: session.id,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(carriedAnswers ? { carriedAnswers } : {}),
    };
    let submitted: { jobId: string; planId: string };
    try {
      submitted =
        session.targetKeys.length > 0
          ? await aiPlanEditsService.submitContextual(
              intent,
              session.targetKeys,
              pctx,
              requirement,
              submitOpts,
            )
          : await aiPlanEditsService.submitAugment(intent, pctx, requirement, submitOpts);
    } catch (err) {
      // A Plan it again whose job never started gives its claim back, so the
      // owner can accept again (MOTIR-7945).
      if (claim) await releasePlanAgainClaim(session, pctx, claim);
      throw err;
    }
    const { jobId, planId } = submitted;

    const updated = await appendLocked(
      session,
      pctx,
      { role: 'system', body: intent, jobId },
      {
        lastJobId: jobId,
        lastSubmittedAt: new Date(),
        // A turn that bound on a failed session (Plan it again on its stale plan) clears the
        // record in the same update (MOTIR-7938), as the revise bind does.
        ...(clearFailure ? CLEARED_FAILURE_COLUMNS : {}),
      },
      // A repeat answered with the same job records no second marker: the thread
      // already says which job its intent became.
      async (tx) =>
        (await planChangeTurnRepository.findByJobIdAndRole(
          session.id,
          jobId,
          'system',
          pctx.workspaceId,
          tx,
        )) !== null,
    );
    // HEARTBEAT (MOTIR-2787). Submitting is the thread proving it is alive, so it
    // pushes the target lease out by a fresh window. Without this a conversation
    // longer than one lease would have its own targets swept out from under it;
    // with it, the window only starts running down once the session goes quiet —
    // which is exactly the condition the sweep exists to detect. A thread holding
    // nothing refreshes nothing.
    await planTargetLockService.refreshForSession(session.id, pctx);
    // `planId` is PASSED THROUGH, never re-derived: the submit above already
    // opened exactly one `generating` Plan bound to `jobId` (MOTIR-1743), so
    // this seam opens none of its own (MOTIR-1745).
    return { jobId, planId, session: updated };
  },
};
