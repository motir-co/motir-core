import type { JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { buildScope, MAX_SCOPE_TARGETS, type PlanChangeScope } from '@/lib/planChange/scope';
import {
  PlanChangeSessionNotFoundError,
  type PlanTargetLockedError,
  TooManyPlanChangeTargetsError,
} from '@/lib/planChange/errors';
import type {
  ContextualPlanResultDto,
  ContextualSessionResumeDto,
  PlanChangeSessionDto,
  PlanTargetHeldByDto,
} from '@/lib/dto/planChange';
import type { SubmittedRequirement } from '@/lib/ai/types';

/**
 * What a CONFIRMED targeted plan offer submits beside its turn (MOTIR-9878): the
 * requirement the person read in the pane, the page Confirm saved it to, and the submit's
 * options — the same supply a no-target offer's start sends (MOTIR-9436). The anchored
 * door otherwise submits the bare accumulated intent, exactly as before.
 */
export interface ComposedSubmit {
  requirement: SubmittedRequirement;
  opts: { requirementPage: { pageId: string; title: string }; omitCarriedAnswers: true };
}

/** The shipped submit, with a confirmed offer's requirement when there is one. */
function submitComposed(pctx: ProjectContext, sessionId: string, submitWith?: ComposedSubmit) {
  return submitWith
    ? planChangeSessionsService.submit(pctx, { sessionId }, submitWith.requirement, submitWith.opts)
    : planChangeSessionsService.submit(pctx, { sessionId });
}

// CONTEXTUAL PLANNING — the motir-core side (7.12.3 · MOTIR-909).
//
// "Plan / Re-plan from this work item": a planning conversation ANCHORED at one
// or more work items, whose turns become the SHIPPED 7.11 plan-edit job scoped to
// those anchors' neighborhood (7.12.2 · MOTIR-908), streamed back to the embedded
// panel. Three things it deliberately is NOT:
//
//  * NOT a new chat stack. The thread IS the shipped plan-change conversation
//    (Story 7.30), addressed by its anchor set instead of by the project alone —
//    same table, same turn allocation, same accumulated-intent submit. All AI
//    conversation rides one substrate.
//  * NOT a new job kind. `submitContextual` sends an ordinary 7.11 job with
//    `context.targetKeys`; motir-ai resolves which of expand/augment/replan the
//    turn is. Core does not pre-classify — two classifiers in one loop is how the
//    engine's judgement gets overridden by a caller's guess.
//  * NOT a write to the plan. This opens the session, submits, and streams. The
//    proposed delta is PERSISTED only through the confirmation gate (7.13.5) on
//    the shipped approve route — nothing here touches a work item.
//
// SCOPED, NOT FENCED. The turn is anchored at the targets, but the delta motir-ai
// proposes may touch an anchor, a sibling, or a parent. This service passes the
// anchors as the scope and lets the job reach the neighborhood; it does not
// pre-restrict what the proposal may target. What it DOES enforce is the 6.4 view
// gate on EVERY anchor — `workItemsService` resolves each one as the requesting
// user, so an item in another tenant, or one this actor cannot browse, 404s here
// instead of silently becoming planning context. (Editability of the wider
// neighborhood a parent re-plan would touch is re-checked at persist, where the
// write actually happens.)
//
// 4-layer (CLAUDE.md): the routes parse and call ONE method; this service owns the
// orchestration and composes other services; it opens no transaction of its own
// (the turn appends own theirs, inside `planChangeSessionsService`) and touches no
// repository or Prisma client directly.

export interface ContextualPlanRequest {
  /** The work item the panel is open on — the PRIMARY anchor, by database id
   *  (the `/api/work-items/[id]` path form every sibling route uses). */
  anchorId: string;
  /** ADDITIONAL anchors, by work-item identifier ("MOTIR-812") — what the
   *  @-mention target picker inserts. Empty for the single-target entrance, which
   *  is simply the 1-element case. */
  targetKeys?: readonly string[];
  /** The turn the user typed. For a Re-plan this IS the "reason" — the contract
   *  carries no separate reason field, by design (7.12.2). */
  prompt: string;
  /** The turn is the REPLY to the planner's pending question (MOTIR-2226), sent
   *  from the composer's answer bar. Carried here for the same reason the project
   *  thread carries it: the anchored entrance renders the same rail, so a question
   *  answered on an item's thread must read as answered there too. */
  isAnswer?: boolean;
  /**
   * The SESSION the client holds (MOTIR-6023; AMENDMENT 17 §2). When given,
   * every write lands on exactly that session. When absent, the caller's own
   * RESUMABLE session for the anchor scope is used, and a first turn with none
   * STARTS one (§1, §3) — nothing is created by a read.
   */
  sessionId?: string;
  /**
   * The REFUSED GATE this conversation is seeded from (story MOTIR-6068 ·
   * MOTIR-6210; AMENDMENT 17 §9). Sent by the planning overlay ONLY on the first
   * turn of a seeded re-plan — the one with no session yet — and IGNORED whenever
   * `sessionId` is present: a continuing conversation already remembers its gate,
   * or never had one. With it, the turn starts (or resumes) only a session seeded
   * by THIS gate, never the caller's ordinary resumable one.
   */
  seedGateId?: string;
  /**
   * The GUIDE REPLY TURN whose re-plan offer this conversation is seeded from
   * (story MOTIR-8684 · MOTIR-8691). Same posture as `seedGateId`: sent only on a
   * first turn (no session yet) and IGNORED when `sessionId` is present. Unlike a
   * gate seed it never resumes and re-sends — a confirmed offer is refused with
   * `GuideReplanOfferAlreadyConfirmedError` naming the session. The route refuses
   * both seeds together (400), so the service never sees the pair.
   */
  seedGuideTurnId?: string;
}

/**
 * What an anchored turn returns — the wire shape itself (`ContextualPlanResultDto`),
 * which the route echoes verbatim. It was a separate local interface until
 * MOTIR-1745 grew both by `planId`; two identical shapes that must stay in sync is
 * the drift this seam does not need, so the DTO is now the single definition.
 */
export type ContextualPlanResult = ContextualPlanResultDto;

/**
 * Resolve + VIEW-GATE every anchor, and return the canonical scope.
 *
 * Each anchor goes through `workItemsService`, which is the 6.4 permission
 * authority: it rejects a cross-tenant row as `WorkItemNotFoundError` (404, no
 * existence leak) and a non-browsable project as `ProjectAccessDeniedError`
 * ('browse' → also 404). The primary anchor additionally has to live in the
 * project the turn plans against — an anchor from a sibling project would silently
 * plan against the wrong tree, so it is treated as absent rather than adopted.
 */
async function resolveScope(
  req: ContextualPlanRequest,
  pctx: ProjectContext,
): Promise<PlanChangeScope> {
  const extra = req.targetKeys ?? [];
  // Bound BEFORE the round-trips: the cost of a huge set is the resolution
  // fan-out itself, so rejecting after resolving them would be too late.
  if (extra.length + 1 > MAX_SCOPE_TARGETS) {
    throw new TooManyPlanChangeTargetsError(extra.length + 1, MAX_SCOPE_TARGETS);
  }

  const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
  const anchor = await workItemsService.getWorkItem(req.anchorId, ctx);
  if (anchor.projectId !== pctx.projectId) throw new WorkItemNotFoundError(req.anchorId);

  const identifiers = [anchor.identifier];
  for (const key of extra) {
    const trimmed = key.trim();
    if (!trimmed) continue;
    const item = await workItemsService.getWorkItemByIdentifier(pctx.projectId, trimmed, ctx);
    identifiers.push(item.identifier);
  }
  return buildScope(identifiers);
}

/** The caller's own OPEN session for the scope — or the one of theirs that holds
 *  a card in it (the take-back) — or null (AMENDMENT 17 §3, AMENDMENT 23 §3). */
async function resumable(
  pctx: ProjectContext,
  scope: PlanChangeScope,
): Promise<{ id: string; scopeKey: string } | null> {
  const session = await planChangeSessionsService.findResumable(pctx, scope.scopeKey);
  return session ? { id: session.id, scopeKey: buildScope(session.targetKeys).scopeKey } : null;
}

async function resumableId(pctx: ProjectContext, scope: PlanChangeScope): Promise<string | null> {
  return (await resumable(pctx, scope))?.id ?? null;
}

/** Whether the addressed session plans every card of the requested scope: its own
 *  targets include them all. The project-wide session (no targets) covers none, so a
 *  turn that names a card never lands on it. An unknown session is refused here as
 *  `PLAN_SESSION_NOT_FOUND`, as the append below refused it before. */
async function sessionCovers(
  pctx: ProjectContext,
  sessionId: string,
  scope: PlanChangeScope,
): Promise<boolean> {
  const held = await planChangeSessionsService.getById(pctx, sessionId);
  return scope.targetKeys.every((key) => held.targetKeys.includes(key));
}

/** A write that CONTINUES a conversation needs one: the addressed session, else
 *  the caller's resumable one — and with neither there is nothing to continue. */
async function requireAddressed(
  sessionId: string | undefined,
  pctx: ProjectContext,
  scope: PlanChangeScope,
): Promise<string> {
  const id = sessionId ?? (await resumableId(pctx, scope));
  if (!id) throw new PlanChangeSessionNotFoundError(pctx.projectId);
  return id;
}

/** A lock refusal as the overlay reads it (AMENDMENT 23 §4) — the same fields the
 *  `409 PLAN_TARGET_LOCKED` body carries. */
export function toHeldBy(err: PlanTargetLockedError): PlanTargetHeldByDto {
  return {
    target: err.targetIdentifier,
    holder: err.holderName,
    freesBy: err.freesBy?.toISOString() ?? null,
    holderSessionId: err.holderSessionId,
    sessionWaiting: err.sessionWaiting,
    waitingCause: err.waitingCause,
  };
}

export const contextualPlanningService = {
  /**
   * Open (or RESUME) the planning conversation anchored at the target set, append
   * the user's turn, and submit it as the scoped 7.11 job.
   *
   * Resume matters: the scope key is canonical, so re-opening the panel on the
   * same items — in any order, from any of them — continues the SAME thread, and
   * the accumulated intent of the whole conversation is what the engine receives.
   *
   * Returns the job to stream, the session id, and the thread as it now stands
   * (its user turn and its submission marker included), so the panel renders from
   * one response instead of re-reading.
   */
  async planFromWorkItem(
    req: ContextualPlanRequest,
    pctx: ProjectContext,
    submitWith?: ComposedSubmit,
  ): Promise<ContextualPlanResult> {
    const scope = await resolveScope(req, pctx);

    // A SEEDED first turn (AMENDMENT 17 §9; MOTIR-6210) skips the resumable read
    // on purpose: the caller's recent UNSEEDED conversation on this card is not
    // the one a refusal starts, so landing there would bury the seed in it.
    // `startSeededWithFirstTurn` asserts the gate under its own lock (else
    // `PlanSeedNotApplicableError`, nothing written), resumes only a session of
    // the SAME seed, or creates one stamped with it.
    const seeded = !req.sessionId && req.seedGateId ? req.seedGateId : null;
    const guideSeeded = !req.sessionId && req.seedGuideTurnId ? req.seedGuideTurnId : null;
    // The ADDRESSED session, else the caller's resumable one; with neither, this
    // first turn STARTS the session (AMENDMENT 17 §1, §3). The submit then sends
    // the ACCUMULATED intent — the session's own `targetKeys` make it contextual.
    //
    // The ADDRESSED session only wins while it can plan the requested scope
    // (MOTIR-8983). A held session whose targets do not cover the scope — the
    // project-wide one after "Plan something new", or an open project thread — would
    // lock the requested cards for a job that never names them, so it is set aside
    // and the turn lands on the caller's session for the REQUESTED scope instead.
    // The result carries that session's id, which is how the client switches to it.
    const addressedId =
      seeded || guideSeeded || !req.sessionId
        ? null
        : (await sessionCovers(pctx, req.sessionId, scope))
          ? req.sessionId
          : null;
    const resumed = seeded || guideSeeded || addressedId ? null : await resumable(pctx, scope);
    const target = seeded || guideSeeded ? null : (addressedId ?? resumed?.id ?? null);
    // A CONTINUING conversation re-takes its targets, as opening one always did
    // (MOTIR-2786): an earlier plan's decision may have handed them back, and a
    // turn that plans them again must hold them again. Idempotent for the holder.
    // A TAKE-BACK (AMENDMENT 23 §3) — a session of another scope that already
    // holds this card — is returned as it is: nothing new is taken for it.
    const takenBack = resumed !== null && resumed.scopeKey !== scope.scopeKey;
    if (target && !takenBack) {
      await planTargetLockService.acquireForScope(target, scope.targetKeys, pctx);
    }
    const sessionId = target
      ? (
          await planChangeSessionsService.appendTurn(
            req.prompt,
            pctx,
            { sessionId: target },
            {
              isAnswer: req.isAnswer === true,
            },
          )
        ).id
      : guideSeeded
        ? (
            await planChangeSessionsService.startGuideSeededWithFirstTurn(
              pctx,
              scope,
              req.prompt,
              guideSeeded,
            )
          ).id
        : seeded
          ? (
              await planChangeSessionsService.startSeededWithFirstTurn(
                pctx,
                scope,
                req.prompt,
                seeded,
                { isAnswer: req.isAnswer === true },
              )
            ).id
          : (
              await planChangeSessionsService.startWithFirstTurn(pctx, scope, req.prompt, {
                isAnswer: req.isAnswer === true,
              })
            ).id;
    const { jobId, planId, session } = await submitComposed(pctx, sessionId, submitWith);

    return { jobId, planId, sessionId: session.id, session };
  },

  /**
   * RESUME the item's thread — the entrance's mount read (MOTIR-910), so
   * re-opening the workspace on an item shows the conversation already had
   * rather than a blank rail that only fills in after the next turn.
   *
   * Read-only by construction: it resolves + view-gates the anchor set exactly as
   * a turn does, then READS the thread for that scope. An item never planned
   * before has no thread — `null`, not a freshly written empty row (opening a
   * door is not starting a conversation).
   *
   * It also reports the thread's PENDING `planId` (MOTIR-1745) — the plan its last
   * submission opened, when that plan is still undecided. Resume is the one path
   * where the rail cannot have the id already: a submit hands back `{ jobId,
   * planId }`, but a user who closed the workspace mid-proposal returns holding
   * neither. Resolved through `Plan.sessionId` (AMENDMENT 17 §5): a session that
   * never submitted, and one whose latest plan is decided, reports `null` and the
   * rail simply has nothing to confirm. Which session: the ADDRESSED one, else the
   * caller's own resumable session for the scope (§3).
   */
  async getSessionForWorkItem(
    req: Omit<ContextualPlanRequest, 'prompt'>,
    pctx: ProjectContext,
  ): Promise<ContextualSessionResumeDto> {
    const scope = await resolveScope({ ...req, prompt: '' }, pctx);
    // A READ: the addressed session, else the caller's resumable one — never a
    // write, so a browse-only member looking at an item creates nothing.
    const session = req.sessionId
      ? await planChangeSessionsService.getById(pctx, req.sessionId)
      : await planChangeSessionsService.findResumable(pctx, scope.scopeKey);
    if (!session) {
      // Nothing resumed — say where the scope's earlier conversation is, when
      // there is one and it has reached planning (MOTIR-6024's notice,
      // MOTIR-9304). Never for a NAMED session.
      if (req.sessionId) return { session, planId: null };
      const [{ earlier, copyable }, held] = await Promise.all([
        planChangeSessionsService.findResumableWithEarlier(pctx, scope.scopeKey),
        planTargetLockService.readForeignHoldForScope(scope.targetKeys, pctx),
      ]);
      return { session, planId: null, earlier, copyable, heldBy: held ? toHeldBy(held) : null };
    }

    // The session's still-undecided plan, through the COLUMN (AMENDMENT 17 §5).
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    const planId = await plansService.findPendingPlanIdForSession(pctx.projectId, session.id, ctx);
    return { session, planId };
  },

  /**
   * RE-SUBMIT the thread's accumulated intent WITHOUT appending a turn — the
   * rail's Retry after a failed run (MOTIR-910).
   *
   * Retry must not append: the design's error state is "recoverable in place —
   * the thread survives", so re-sending the same accumulated intent is the
   * correct repair. Appending the last turn again would instead change what the
   * engine is asked, and duplicate the user's words in their own transcript.
   * A scope with no thread yet has nothing to resubmit (`PlanChangeSessionNotFoundError`
   * from the shared submit path).
   */
  async resubmitFromWorkItem(
    req: Omit<ContextualPlanRequest, 'prompt'>,
    pctx: ProjectContext,
    submitWith?: ComposedSubmit,
  ): Promise<ContextualPlanResult> {
    const scope = await resolveScope({ ...req, prompt: '' }, pctx);
    const sessionId = await requireAddressed(req.sessionId, pctx, scope);
    const { jobId, planId, session } = await submitComposed(pctx, sessionId, submitWith);
    return { jobId, planId, sessionId: session.id, session };
  },

  /**
   * Record the PLANNER's turn on the ANCHORED thread (MOTIR-2226) — the same
   * recording the project thread does, addressed by anchor set instead of by
   * project.
   *
   * It exists for one reason: this service owns scope resolution (and its view
   * gate), so the anchored caller must not be asked to compute a scope key. Every
   * property of the recording — idempotency per job, the job-belongs-to-this-thread
   * check, the silent-job tolerance — belongs to `planChangeSessionsService` and is
   * not re-implemented here.
   */
  async recordPlannerTurnForWorkItem(
    req: Omit<ContextualPlanRequest, 'prompt'> & { jobId: string },
    pctx: ProjectContext,
  ): Promise<PlanChangeSessionDto> {
    const scope = await resolveScope({ ...req, prompt: '' }, pctx);
    const sessionId = await requireAddressed(req.sessionId, pctx, scope);
    return planChangeSessionsService.recordPlannerTurn(req.jobId, pctx, { sessionId });
  },

  /**
   * The live channel for a submitted turn: relay the motir-ai job stream to the
   * browser. The anchor is re-gated on every subscribe (the stream route is a
   * separate request — a permission that held at submit is not evidence it still
   * holds now), and the browser reaches motir-ai ONLY through here: the client is
   * `server-only`, so the open-core invariant is structural, not a convention.
   *
   * Returns the generator rather than consuming it, so the ROUTE owns the iterator
   * and client disconnect cancels it promptly (the shipped stream-route shape).
   */
  async streamPlanJob(
    anchorId: string,
    jobId: string,
    pctx: ProjectContext,
  ): Promise<AsyncGenerator<JobStreamEvent>> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    const anchor = await workItemsService.getWorkItem(anchorId, ctx);
    if (anchor.projectId !== pctx.projectId) throw new WorkItemNotFoundError(anchorId);
    return aiPlanEditsService.streamContextual(jobId, pctx.projectId);
  },
};
