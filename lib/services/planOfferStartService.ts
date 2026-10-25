import type { Prisma, PlanChangeTurn } from '@/generated/prisma/client';
import type { ProjectContext } from '@/lib/projects';
import type { DebugLandingDto, PlanChangeSessionDto } from '@/lib/dto/planChange';
import { debugLandingService } from '@/lib/services/debugLandingService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { toPlanChangeTurnDto } from '@/lib/mappers/planChangeMappers';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { contextualPlanningService } from '@/lib/services/contextualPlanningService';
import { appendWithin, planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { planOfferService } from '@/lib/services/planOfferService';
import { requirementPageService } from '@/lib/services/requirementPageService';
import { requirementPageLocale } from '@/lib/ai/requirementMarkdown';
import { resolveTenantLanguages } from '@/lib/ai/tenantLanguages';
import type { SubmittedRequirement } from '@/lib/ai/types';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { buildScope } from '@/lib/planChange/scope';
import { pendingPlanOfferOf, type PlanOfferTurn } from '@/lib/planChange/planOffer';
import { planOfferStartPath } from '@/lib/planChange/offerRestart';
import {
  PlanChangeSessionNotFoundError,
  PlanChangeTurnNotFoundError,
  PlanOfferRequirementNotSavedError,
  PlanOfferStartRefusedError,
  PlanSessionEndedError,
  PlanSessionNotFoundError,
} from '@/lib/planChange/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// ONE START PER OFFER (Story MOTIR-9219 · MOTIR-9291; ADR conversation-turn-intent
// AMENDMENT 5 · MOTIR-9215, clauses 1–3 and 7). The one seam that turns a person's yes
// into a planning run. Three doors reach it — the Confirm button and a typed yes
// (`confirmPlanOffer`), and a turn whose answer said "plan this" with a grounded
// target (`startTargetedPlan`) — and each converges on ONE routine:
//
//   permissions → target re-resolved under the caller → already planning? → CLAIM →
//   landing → ONE start → stamp.
//
// ── EXACTLY ONCE OVER A SIDE EFFECT OUTSIDE THE TRANSACTION ────────────────────────
// The start is the metered plan-edit job, which cannot sit inside a transaction (a
// failed submit must leave the thread as it was, `submit`'s own rule). So the claim is
// written first, under the conversation's row lock, the start runs, and the outcome is
// stamped after. A claim whose start throws is RELEASED, because nothing was spent and
// the person must be able to press Confirm again; a stamped start is never released.
//
//   - the two offer doors claim the OFFER: a compare-and-set that moves it off pending
//     (`confirmedAt`), then `confirmedSessionId` and the job are stamped on success;
//   - the targeted door has no offer row (an immediate offer is never stored), so it
//     claims the TURN — `planStartClaimedAt`, the debug and guide claims' shape.
//
// A second door arriving in the same instant finds the claim taken and is answered
// with the winner's session and job, never a second run and never an error.
//
// ── MID-PLANNING (MOTIR-9293) ───────────────────────────────────────────────────
// A confirm on a conversation that already holds an undecided plan would REVISE that
// plan through `submit`. So it takes `planChangeSessionsService.restartForPlanOffer`:
// the conversation ends `restarted` (its run stopped, a generating plan discarded) and
// the request becomes the first turn of the session that follows, which this seam then
// submits. The targeted "plan this" door keeps refusing `already_planning`.
//
// ── WHERE THE REQUEST LANDS ─────────────────────────────────────────────────────
// `submit` forks on the session's own `targetKeys`, and the ask overlay's conversation
// is project-wide. So an offer with NO target is the plan's conversation already: its
// request is appended there (skipped when a retry finds it already there) and
// submitted there. An offer WITH a target goes through the shipped scoped door,
// `contextualPlanningService.planFromWorkItem`, which sets the project-wide thread
// aside, lands on (or starts) the caller's session for that card, takes its lock and
// submits — and names the session, which is how the client switches to it. The thread's
// scope is never rewritten in place: `scopeKey` is its resume identity.

/** What a start answers: the conversation the job runs in, which may not be the one
 *  on screen, the job and its plan. */
export interface PlanOfferStartResult {
  sessionId: string;
  jobId: string;
  planId: string;
  session: PlanChangeSessionDto;
}

/** What a Confirm press answers (MOTIR-9323): a plan offer's start, or a `log_bug`
 *  offer's one landed write and the thread after it. */
export type OfferConfirmResult =
  | ({ kind: 'plan' } & PlanOfferStartResult)
  | { kind: 'log_bug'; sessionId: string; landing: DebugLandingDto; session: PlanChangeSessionDto };

/** The job a stamped start recorded on its offer, beside the store card's keys. */
interface RecordedStart {
  jobId: string;
  planId: string;
}

/** How long a losing door waits for the winner's stamp before it gives up. */
const WINNER_WAIT_MS = 30_000;
const WINNER_POLL_MS = 200;

function actorOf(pctx: ProjectContext) {
  return { userId: pctx.userId, workspaceId: pctx.workspaceId };
}

function txScope(pctx: ProjectContext) {
  return { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId };
}

/** The story's actor, asserted at START time: a member whose access changed between
 *  the offer and the press writes nothing. `PermissionDeniedError` → 403. */
async function assertCanStart(pctx: ProjectContext): Promise<void> {
  await projectAccessService.assertPermission(pctx.projectId, actorOf(pctx), 'ai:plan');
  await projectAccessService.assertPermission(pctx.projectId, actorOf(pctx), 'work_item:edit');
}

/**
 * The plan's target, re-resolved NOW through the keyed read pinned to the active
 * project and browse-gated for the caller. Unknown, moved, or no longer browsable all
 * refuse `target_not_available`, so they cannot be told apart; a target that has since
 * closed refuses with the lifecycle's own `target_closed`.
 */
async function resolveStartTarget(
  targetKey: string,
  pctx: ProjectContext,
): Promise<{ id: string; identifier: string }> {
  let item: { id: string; identifier: string; projectId: string; status: string };
  try {
    item = await workItemsService.getWorkItemByIdentifier(pctx.projectId, targetKey, actorOf(pctx));
  } catch (err) {
    if (
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectAccessDeniedError ||
      err instanceof ProjectNotFoundError
    ) {
      throw new PlanOfferStartRefusedError('target_not_available');
    }
    throw err;
  }
  if (item.projectId !== pctx.projectId) {
    throw new PlanOfferStartRefusedError('target_not_available');
  }
  const terminal = await workflowsService.getTerminalStatusKeys(pctx.projectId, pctx.workspaceId);
  if (terminal.has(item.status)) throw new PlanOfferStartRefusedError('target_closed');
  return { id: item.id, identifier: item.identifier };
}

/** The caller's own conversation, re-read UNDER its row lock. Another member's, or
 *  another project's, reads exactly as a missing one. */
async function lockOwnConversation(
  pctx: ProjectContext,
  conversationId: string,
  tx: Prisma.TransactionClient,
) {
  const locked = await planChangeSessionRepository.lockById(conversationId, tx);
  if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
  const session = await planChangeSessionRepository.findByIdInProject(
    conversationId,
    pctx.projectId,
    pctx.workspaceId,
    tx,
  );
  if (!session || session.createdById !== pctx.userId) {
    throw new PlanChangeSessionNotFoundError(pctx.projectId);
  }
  return session;
}

/** A targeted "plan this" turn on a conversation that already waits on an undecided
 *  plan starts nothing: only a confirmed offer takes the mid-planning restart. */
async function assertNotPlanning(
  pctx: ProjectContext,
  conversationId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (await planChangeSessionsService.heldPlanOf(pctx, { sessionId: conversationId }, tx)) {
    throw new PlanOfferStartRefusedError('already_planning');
  }
}

function offerTurns(rows: readonly PlanChangeTurn[]): PlanOfferTurn[] {
  return rows.map((row) => {
    const dto = toPlanChangeTurnDto(row);
    return { id: dto.id, seq: dto.seq, role: dto.role, offer: dto.offer ?? null };
  });
}

function offerJson(row: PlanChangeTurn): Record<string, unknown> | null {
  const raw = row.answerOffer;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function recordedStartOf(offer: Record<string, unknown>): RecordedStart | null {
  const start = offer['start'];
  if (!start || typeof start !== 'object' || Array.isArray(start)) return null;
  const { jobId, planId } = start as Record<string, unknown>;
  return typeof jobId === 'string' && typeof planId === 'string' ? { jobId, planId } : null;
}

/**
 * Land a TARGETED plan through the shipped scoped door. A retry after a start that
 * threw finds its request already on the caller's session for that card, unsubmitted,
 * and resubmits it there instead of appending it a second time.
 */
async function landTargeted(
  pctx: ProjectContext,
  input: { conversationId: string; target: { id: string; identifier: string }; prompt: string },
): Promise<PlanOfferStartResult> {
  const scope = buildScope([input.target.identifier]);
  const landed = await planChangeSessionsService.findResumable(pctx, scope.scopeKey);
  const last = landed?.turns.at(-1);
  if (landed && last?.role === 'user' && last.body === input.prompt.trim()) {
    return contextualPlanningService.resubmitFromWorkItem(
      { anchorId: input.target.id, sessionId: landed.id },
      pctx,
    );
  }
  return contextualPlanningService.planFromWorkItem(
    { anchorId: input.target.id, prompt: input.prompt, sessionId: input.conversationId },
    pctx,
  );
}

/** What the offer's own row says, read under the conversation's lock. */
type OfferRead =
  | { kind: 'started'; sessionId: string; start: RecordedStart }
  | { kind: 'in_flight' }
  | { kind: 'open' };

async function readOffer(
  pctx: ProjectContext,
  conversationId: string,
  offerTurnId: string,
): Promise<OfferRead> {
  return withWorkspaceContext(txScope(pctx), async (tx) => {
    await lockOwnConversation(pctx, conversationId, tx);
    const row = await planChangeTurnRepository.findByIdInSession(
      offerTurnId,
      conversationId,
      pctx.workspaceId,
      tx,
    );
    const offer = row && row.role === 'assistant' ? offerJson(row) : null;
    if (!offer) throw new PlanChangeTurnNotFoundError(offerTurnId);
    const start = recordedStartOf(offer);
    if (typeof offer['confirmedSessionId'] === 'string' && start) {
      return { kind: 'started', sessionId: offer['confirmedSessionId'], start };
    }
    return typeof offer['confirmedAt'] === 'string' ? { kind: 'in_flight' } : { kind: 'open' };
  });
}

/** The losing door's answer: the winner's session and job, waited for while the winner
 *  is still starting. Null when the winner gave its claim back (its start threw). */
async function winnerOf(
  pctx: ProjectContext,
  conversationId: string,
  offerTurnId: string,
): Promise<PlanOfferStartResult | null> {
  const deadline = Date.now() + WINNER_WAIT_MS;
  for (;;) {
    const read = await readOffer(pctx, conversationId, offerTurnId);
    if (read.kind === 'open') return null;
    if (read.kind === 'started') {
      const session = await planChangeSessionsService.getById(pctx, read.sessionId);
      return { sessionId: read.sessionId, ...read.start, session };
    }
    if (Date.now() >= deadline) throw new PlanOfferStartRefusedError('offer_not_open');
    await new Promise((resolve) => setTimeout(resolve, WINNER_POLL_MS));
  }
}

/** How a claimed start proceeds: on its own conversation (`submit`), through the
 *  mid-planning restart (`restart`), or on the successor an earlier restart of this same
 *  offer already put its request on, whose start then threw (`resume`). */
type ClaimOutcome = { kind: 'claimed'; path: 'submit' | 'restart' | 'resume' } | { kind: 'lost' };

/**
 * Claim the offer under the conversation's lock. An offer with no target, starting on
 * its own conversation, also appends its request in the SAME transaction, so a refused
 * append rolls the claim back with it. A conversation holding an undecided plan takes
 * the restart (MOTIR-9293) instead of `submit`, which would revise that plan.
 */
async function claimOffer(
  pctx: ProjectContext,
  input: { conversationId: string; offerTurnId: string; requestMd: string; targeted: boolean },
): Promise<ClaimOutcome> {
  return withWorkspaceContext(txScope(pctx), async (tx) => {
    const conversation = await lockOwnConversation(pctx, input.conversationId, tx);
    // Ended by the caller's own restart: only the retry of a restart whose start threw
    // may still start here, on the successor. Any other end refuses.
    const restartedByCaller =
      conversation.endReason === 'restarted' && conversation.endedById === pctx.userId;
    if (conversation.endedAt && !restartedByCaller) {
      throw new PlanSessionEndedError(conversation.id);
    }
    const rows = await planChangeTurnRepository.listBySessionId(
      input.conversationId,
      pctx.workspaceId,
      tx,
    );
    const offerRow = rows.find((t) => t.id === input.offerTurnId);
    const offer = offerRow && offerRow.role === 'assistant' ? offerJson(offerRow) : null;
    if (!offerRow || !offer) throw new PlanChangeTurnNotFoundError(input.offerTurnId);
    // Taken by a door that committed first: the loser's cue to read the winner.
    if (typeof offer['confirmedAt'] === 'string') return { kind: 'lost' };
    const pending = pendingPlanOfferOf(offerTurns(rows));
    if (pending?.turnId !== offerRow.id) throw new PlanOfferStartRefusedError('offer_not_open');
    const held = conversation.endedAt
      ? null
      : await planChangeSessionsService.heldPlanOf(pctx, { sessionId: input.conversationId }, tx);
    const route = planOfferStartPath({
      endedAt: conversation.endedAt,
      latestUndecidedStatus: held?.status ?? null,
    });
    const path = route === 'no-start' ? 'resume' : route;
    const claimed = await planChangeTurnRepository.claimAnswerOfferStart(
      offerRow.id,
      pctx.workspaceId,
      pctx.userId,
      tx,
    );
    if (!claimed) return { kind: 'lost' };
    if (path === 'submit' && !input.targeted) {
      const request = input.requestMd.trim();
      await appendWithin(
        input.conversationId,
        pctx,
        { role: 'user', body: request, authorId: pctx.userId },
        {},
        tx,
        // A retry after a start that threw finds its request already on the thread.
        async () =>
          rows.some((t) => t.role === 'user' && t.seq >= offerRow.seq && t.body === request),
      );
    }
    return { kind: 'claimed', path };
  });
}

/** What a no-target offer's start hands the run beyond its request (MOTIR-9436). */
interface ComposedStart {
  requirement: SubmittedRequirement;
  requirementPage: { pageId: string; title: string };
}

/** THE one call site of the shipped submit this seam adds (MOTIR-9291): every start
 *  that is not a targeted landing runs it, on the conversation the plan belongs to.
 *  With a composed requirement the run gets it and its page, and NO carried answers:
 *  Grill me's answers are already inside the requirement (MOTIR-9436). */
async function submitOn(
  pctx: ProjectContext,
  sessionId: string,
  composed?: ComposedStart,
): Promise<PlanOfferStartResult> {
  const submitted = composed
    ? await planChangeSessionsService.submit(pctx, { sessionId }, composed.requirement, {
        requirementPage: composed.requirementPage,
        omitCarriedAnswers: true,
      })
    : await planChangeSessionsService.submit(pctx, { sessionId });
  return {
    sessionId: submitted.session.id,
    jobId: submitted.jobId,
    planId: submitted.planId,
    session: submitted.session,
  };
}

/** The page an earlier attempt recorded on the offer, if it reads as one. */
function recordedPageOf(offer: Record<string, unknown>): { pageId: string; title: string } | null {
  const page = offer['requirementPage'];
  if (!page || typeof page !== 'object' || Array.isArray(page)) return null;
  const { pageId, title } = page as Record<string, unknown>;
  return typeof pageId === 'string' && pageId && typeof title === 'string' && title
    ? { pageId, title }
    : null;
}

/** Rewrite the stored offer under the conversation's lock: `change` gets what is stored
 *  and answers what to keep. A no-op when the offer no longer reads. */
async function rewriteOffer(
  pctx: ProjectContext,
  conversationId: string,
  offerTurnId: string,
  change: (offer: Record<string, unknown>) => Record<string, unknown>,
) {
  await withWorkspaceContext(txScope(pctx), async (tx) => {
    await lockOwnConversation(pctx, conversationId, tx);
    const row = await planChangeTurnRepository.findByIdInSession(
      offerTurnId,
      conversationId,
      pctx.workspaceId,
      tx,
    );
    const offer = row ? offerJson(row) : null;
    if (!row || !offer) return;
    await planChangeTurnRepository.setAnswerOffer(
      row.id,
      pctx.workspaceId,
      change(offer) as Prisma.InputJsonValue,
      tx,
    );
  });
}

/**
 * The requirement page of a confirmed no-target offer, written EXACTLY ONCE (MOTIR-9436).
 * Called only by the claim's winner, so a double press or a Confirm racing a typed yes
 * reaches it once. The page is written OUTSIDE the claim's transaction (`createPageFromMarkdown`
 * opens its own, and holding the conversation lock across a folder and page write would
 * queue unrelated conversations behind it) and its id is recorded on the offer BEFORE the
 * submit, so a start that then throws leaves a retry that re-uses it. The one gap is a
 * crash between the write and the record, which can leave an unlinked page nothing reads.
 *
 * A write that throws gives the claim back, marks the offer `requirementSaveFailed` and
 * throws {@link PlanOfferRequirementNotSavedError}: nothing started, Confirm still works.
 */
async function ensureRequirementPage(
  pctx: ProjectContext,
  input: {
    conversationId: string;
    offerTurnId: string;
    requestMd: string;
    requirement: SubmittedRequirement;
  },
): Promise<{ pageId: string; title: string }> {
  // Read UNDER the lock, not from the thread read before the claim: an earlier attempt
  // may have recorded its page after that read and released its claim since.
  const recorded = await withWorkspaceContext(txScope(pctx), async (tx) => {
    await lockOwnConversation(pctx, input.conversationId, tx);
    const row = await planChangeTurnRepository.findByIdInSession(
      input.offerTurnId,
      input.conversationId,
      pctx.workspaceId,
      tx,
    );
    const offer = row ? offerJson(row) : null;
    return offer ? recordedPageOf(offer) : null;
  });
  if (recorded) return recorded;
  let page: { pageId: string; title: string };
  try {
    const { contentLanguage } = await resolveTenantLanguages({
      workspaceId: pctx.workspaceId,
      userId: pctx.userId,
    });
    const written = await requirementPageService.write({
      workspaceId: pctx.workspaceId,
      projectId: pctx.projectId,
      requirement: input.requirement,
      requestMd: input.requestMd,
      conversationLabel: input.conversationId,
      at: new Date(),
      locale: requirementPageLocale(contentLanguage),
    });
    page = { pageId: written.pageId, title: written.title };
  } catch (err) {
    await releaseOffer(pctx, input.conversationId, input.offerTurnId);
    await rewriteOffer(pctx, input.conversationId, input.offerTurnId, (offer) => ({
      ...offer,
      requirementSaveFailed: true,
    }));
    throw new PlanOfferRequirementNotSavedError(err);
  }
  await rewriteOffer(pctx, input.conversationId, input.offerTurnId, (offer) => {
    const { requirementSaveFailed: _cleared, ...kept } = offer;
    return { ...kept, requirementPage: page };
  });
  return page;
}

async function releaseOffer(pctx: ProjectContext, conversationId: string, offerTurnId: string) {
  await withWorkspaceContext(txScope(pctx), async (tx) => {
    await lockOwnConversation(pctx, conversationId, tx);
    await planChangeTurnRepository.releaseAnswerOfferStart(offerTurnId, pctx.workspaceId, tx);
  });
}

/** Stamp the started session and job on the offer. A refusal recorded by an earlier
 *  attempt no longer describes it, so it is dropped. */
async function stampOffer(
  pctx: ProjectContext,
  conversationId: string,
  offerTurnId: string,
  started: PlanOfferStartResult,
) {
  await withWorkspaceContext(txScope(pctx), async (tx) => {
    await lockOwnConversation(pctx, conversationId, tx);
    const row = await planChangeTurnRepository.findByIdInSession(
      offerTurnId,
      conversationId,
      pctx.workspaceId,
      tx,
    );
    const offer = row ? offerJson(row) : null;
    if (!row || !offer) return;
    const { startRefusal: _dropped, requirementSaveFailed: _cleared, ...kept } = offer;
    await planChangeTurnRepository.setAnswerOffer(
      row.id,
      pctx.workspaceId,
      {
        ...kept,
        confirmedSessionId: started.sessionId,
        start: { jobId: started.jobId, planId: started.planId },
      } as Prisma.InputJsonValue,
      tx,
    );
  });
}

export const planOfferStartService = {
  /**
   * The Confirm button, whatever the offer's kind: a plan offer starts its plan
   * ({@link confirmPlanOffer}); a `log_bug` offer makes its one write through the
   * debug landing (MOTIR-9323), the function a typed yes reaches too.
   */
  async confirmOffer(
    pctx: ProjectContext,
    input: { conversationId: string; offerTurnId: string },
  ): Promise<OfferConfirmResult> {
    let kind: string | undefined;
    try {
      const thread = await planChangeSessionsService.getById(pctx, input.conversationId);
      kind = thread.turns.find((t) => t.id === input.offerTurnId)?.offer?.kind;
    } catch (err) {
      if (err instanceof PlanSessionNotFoundError) {
        throw new PlanChangeTurnNotFoundError(input.offerTurnId);
      }
      throw err;
    }
    if (kind === 'log_bug') {
      const landed = await debugLandingService.confirmLogBugOffer(pctx, input);
      return { kind: 'log_bug', sessionId: input.conversationId, ...landed };
    }
    return { kind: 'plan', ...(await planOfferStartService.confirmPlanOffer(pctx, input)) };
  },

  /**
   * The Confirm button and the typed yes: start the plan the offer on `offerTurnId`
   * describes, exactly once. A second door for the same offer gets the first one's
   * session and job.
   *
   *  - an offer turn that is absent, another member's or another project's ⇒ the
   *    shipped `PlanChangeTurnNotFoundError` (404), the three alike;
   *  - a declined or superseded offer ⇒ `offer_not_open`; a target that no longer
   *    resolves ⇒ `target_not_available`; a closed one ⇒ `target_closed` — each a 409
   *    `PlanOfferStartRefusedError`, written before any claim;
   *  - a conversation holding an undecided plan is ended `restarted` and the plan
   *    starts on the session that follows it (MOTIR-9293), never beside that plan;
   *  - an ended conversation ⇒ `PlanSessionEndedError`; a held target ⇒
   *    `PlanTargetLockedError`; a refused submit ⇒ its own error, the offer pending
   *    again (and `out_of_credits` recorded on it for a 402).
   */
  async confirmPlanOffer(
    pctx: ProjectContext,
    input: { conversationId: string; offerTurnId: string },
  ): Promise<PlanOfferStartResult> {
    try {
      return await confirm(pctx, input, 2);
    } catch (err) {
      // Another member's conversation reads exactly as a missing offer turn.
      if (err instanceof PlanChangeSessionNotFoundError) {
        throw new PlanChangeTurnNotFoundError(input.offerTurnId);
      }
      throw err;
    }
  },

  /**
   * A turn whose answer said "plan this" with a grounded target (`immediate: true`):
   * start it at once on `anchorKey`, claimed on the person's turn so a replayed settle
   * of the same ask job starts nothing. Null when the claim was already taken.
   */
  async startTargetedPlan(
    pctx: ProjectContext,
    input: { conversationId: string; askJobId: string; anchorKey: string },
  ): Promise<PlanOfferStartResult | null> {
    await assertCanStart(pctx);
    const target = await resolveStartTarget(input.anchorKey, pctx);
    const claimed = await withWorkspaceContext(txScope(pctx), async (tx) => {
      const conversation = await lockOwnConversation(pctx, input.conversationId, tx);
      if (conversation.endedAt) throw new PlanSessionEndedError(conversation.id);
      const turn = await planChangeTurnRepository.findByJobIdAndRole(
        input.conversationId,
        input.askJobId,
        'user',
        pctx.workspaceId,
        tx,
      );
      if (!turn) throw new PlanChangeTurnNotFoundError(input.askJobId);
      if (turn.planStartClaimedAt) return null;
      await assertNotPlanning(pctx, input.conversationId, tx);
      return (await planChangeTurnRepository.claimPlanStart(turn.id, pctx.workspaceId, tx))
        ? turn
        : null;
    });
    if (!claimed) return null;
    try {
      return await landTargeted(pctx, {
        conversationId: input.conversationId,
        target,
        prompt: claimed.body,
      });
    } catch (err) {
      await withWorkspaceContext(txScope(pctx), async (tx) => {
        await lockOwnConversation(pctx, input.conversationId, tx);
        await planChangeTurnRepository.releasePlanStart(claimed.id, pctx.workspaceId, tx);
      });
      throw err;
    }
  },
};

async function confirm(
  pctx: ProjectContext,
  input: { conversationId: string; offerTurnId: string },
  attempts: number,
): Promise<PlanOfferStartResult> {
  await assertCanStart(pctx);
  const read = await readOffer(pctx, input.conversationId, input.offerTurnId);
  if (read.kind !== 'open') {
    const winner = await winnerOf(pctx, input.conversationId, input.offerTurnId);
    if (winner) return winner;
    if (attempts <= 1) throw new PlanOfferStartRefusedError('offer_not_open');
    return confirm(pctx, input, attempts - 1);
  }

  // The offer as stored, for its request and target. Its state is the lifecycle's,
  // re-judged under the lock by the claim.
  const thread = await planChangeSessionsService.getById(pctx, input.conversationId);
  const offer = thread.turns.find((t) => t.id === input.offerTurnId)?.offer;
  if (!offer) throw new PlanChangeTurnNotFoundError(input.offerTurnId);
  // A bug offer (MOTIR-9322) is never a plan to start: its confirm is its own door.
  if (offer.kind !== 'plan') throw new PlanOfferStartRefusedError('offer_not_open');
  if (offer.state === 'declined' || offer.state === 'superseded') {
    throw new PlanOfferStartRefusedError('offer_not_open');
  }
  const target = offer.targetKey ? await resolveStartTarget(offer.targetKey, pctx) : null;

  const claim = await claimOffer(pctx, {
    conversationId: input.conversationId,
    offerTurnId: input.offerTurnId,
    requestMd: offer.requestMd,
    targeted: target !== null,
  });
  if (claim.kind === 'lost') {
    const winner = await winnerOf(pctx, input.conversationId, input.offerTurnId);
    if (winner) return winner;
    if (attempts <= 1) throw new PlanOfferStartRefusedError('offer_not_open');
    return confirm(pctx, input, attempts - 1);
  }

  // A NO-TARGET offer that carries its composed requirement saves it as a page now, after
  // the claim and before any start, on all three paths (MOTIR-9436). One without a
  // requirement (an older offer, or one the read could not compose) starts as it always did.
  const composed: ComposedStart | undefined =
    !target && offer.requirement
      ? {
          requirement: offer.requirement,
          requirementPage: await ensureRequirementPage(pctx, {
            conversationId: input.conversationId,
            offerTurnId: input.offerTurnId,
            requestMd: offer.requestMd,
            requirement: offer.requirement,
          }),
        }
      : undefined;

  // The scope the plan runs in: the target's, or the conversation's own.
  const scope = target ? buildScope([target.identifier]) : buildScope(thread.targetKeys);
  let started: PlanOfferStartResult;
  try {
    if (claim.path === 'restart') {
      // MID-PLANNING (MOTIR-9293): end the conversation through the restart lifecycle
      // and start on the session that follows it, never `submit` on this one.
      const restarted = await planChangeSessionsService.restartForPlanOffer(
        pctx,
        { sessionId: input.conversationId },
        { requestMd: offer.requestMd, scope, offerRef: input.offerTurnId },
      );
      if (!restarted.ownsStart || !restarted.session) {
        throw new PlanOfferStartRefusedError('offer_not_open');
      }
      started = await submitOn(pctx, restarted.session.id, composed);
    } else if (claim.path === 'resume') {
      const successor = await planChangeSessionsService.findResumable(pctx, scope.scopeKey);
      const last = successor?.turns.at(-1);
      if (!successor || last?.role !== 'user' || last.body !== offer.requestMd.trim()) {
        throw new PlanSessionEndedError(input.conversationId);
      }
      started = await submitOn(pctx, successor.id, composed);
    } else if (target) {
      started = await landTargeted(pctx, {
        conversationId: input.conversationId,
        target,
        prompt: offer.requestMd,
      });
    } else {
      started = await submitOn(pctx, input.conversationId, composed);
    }
  } catch (err) {
    await releaseOffer(pctx, input.conversationId, input.offerTurnId);
    if (err instanceof MotirAiOutOfCreditsError) {
      await planOfferService.recordCannotStart(
        input.offerTurnId,
        'out_of_credits',
        err.message,
        pctx,
        { sessionId: input.conversationId },
      );
    }
    throw err;
  }
  await stampOffer(pctx, input.conversationId, input.offerTurnId, started);
  return started;
}
