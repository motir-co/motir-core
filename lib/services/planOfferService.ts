import type { Prisma, PlanChangeTurn } from '@/generated/prisma/client';
import type { ProjectContext } from '@/lib/projects';
import type { AnswerOfferInput, PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { AskPlanOffer } from '@/lib/planning/askResult';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { toPlanChangeTurnDto } from '@/lib/mappers/planChangeMappers';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { planTargetLockRepository } from '@/lib/repositories/planTargetLockRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { isExpired } from '@/lib/planChange/targetLock';
import {
  cannotStartOf,
  pendingPlanOfferOf,
  planOfferStateOf,
  recordedRefusalOf,
  type PlanOfferCannotStart,
  type PlanOfferRecord,
  type PlanOfferState,
  type PlanOfferTurn,
} from '@/lib/planChange/planOffer';
import {
  PlanChangeSessionNotFoundError,
  PlanOfferNotFoundError,
  PlanOfferNotOpenError,
} from '@/lib/planChange/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// THE PLAN OFFER'S LIFECYCLE, the service half (Story MOTIR-9219 · MOTIR-9290; ADR
// conversation-turn-intent AMENDMENT 5 · MOTIR-9215). The pure rule is
// `lib/planChange/planOffer.ts`; this is where it meets the database and the caller.
//
// ── THE GATES ARE ASSERTED WHERE THE ANSWER LANDS ────────────────────────────────
// The ask door asserts only `ai:plan`: it cannot know an answer will carry an offer,
// and a member who may ask but not edit must keep getting answers. So `land` checks
// `ai:plan` + `work_item:edit` + `isMotirAiConfigured()` itself and, when any fails,
// answers "no offer" rather than raising: the answer is appended either way. It is
// the pair the retired debug landing's `assertCanDebug` held (`fa1c010c1`).
//
// ── THREE REASONS ARE READ LIVE; CREDITS ARE RECORDED ───────────────────────────
// A permission can be revoked, a target closed and another session can take the
// target between the answer and the press, so `planning_unavailable`, `target_closed`
// and `target_held` are re-resolved on every read: a reason frozen at land would
// present a Confirm that can only fail. Core learns an org is out of credits only
// from a refused submit (`MotirAiOutOfCreditsError`), so `out_of_credits` is the one
// reason written — by the start that was refused, through `recordCannotStart`.

/** One offer's served, derived fields. */
export interface PlanOfferResolution {
  state: PlanOfferState;
  cannotStart: PlanOfferCannotStart | null;
}

/** What an ask submit states about the live offer (`JobContextBag.pendingPlanOffer`). */
export interface PendingPlanOfferStatement {
  kind: 'plan' | 'log_bug';
  requestText: string;
  targetKey: string | null;
  seq: number;
}

function actorOf(pctx: ProjectContext) {
  return { userId: pctx.userId, workspaceId: pctx.workspaceId };
}

/** The caller's permissions in the project, or null when Motir AI is not configured
 *  or the project is not theirs to see. Never throws for either. */
async function heldForOffers(
  pctx: ProjectContext,
  tx?: Prisma.TransactionClient,
): Promise<ReadonlySet<string> | null> {
  if (!isMotirAiConfigured()) return null;
  try {
    return await projectAccessService.getPermissions(pctx.projectId, actorOf(pctx), tx);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return null;
    throw err;
  }
}

/** Whether the caller may start a plan from an offer right now. Never throws: a
 *  caller who cannot even browse the project may not plan in it. */
async function planningAvailable(
  pctx: ProjectContext,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  const held = await heldForOffers(pctx, tx);
  return Boolean(held?.has('ai:plan') && held.has('work_item:edit'));
}

/** Whether the caller may confirm a `log_bug` offer right now (MOTIR-9322): `ai:plan`
 *  and Motir AI configured. NOT `work_item:edit` — the bug is written by Motir, the
 *  system account, not by the person. Never throws. */
export async function bugLoggingAvailable(
  pctx: ProjectContext,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  return (await heldForOffers(pctx, tx))?.has('ai:plan') ?? false;
}

/**
 * The offer's target, resolved through the KEYED read pinned to the active project
 * and browse-gated for the caller — the read `resolveAnchor` uses. Another project's
 * key, an unknown key and one the caller may not browse all resolve to no target.
 */
async function resolveTarget(
  targetKey: string,
  pctx: ProjectContext,
): Promise<{ identifier: string; status: string } | null> {
  try {
    const item = await workItemsService.getWorkItemByIdentifier(
      pctx.projectId,
      targetKey,
      actorOf(pctx),
    );
    return item.projectId === pctx.projectId
      ? { identifier: item.identifier, status: item.status }
      : null;
  } catch (err) {
    if (
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectAccessDeniedError ||
      err instanceof ProjectNotFoundError
    ) {
      return null;
    }
    throw err;
  }
}

/** The thread's turns as the pure rule reads them, from the raw rows. */
/** The one line a pending `log_bug` offer is stated by: the write a yes makes. */
export function logBugWriteLine(offer: PlanOfferRecord): string {
  const target = offer.bug?.target;
  if (target?.kind === 'anchored' && target.key) {
    return `Add the diagnosis to ${target.key}: ${offer.requestMd}`;
  }
  if (target?.kind === 'existing' && target.key) {
    return `Add a note on ${target.key}, which already covers it: ${offer.requestMd}`;
  }
  return `Log a new bug: ${offer.requestMd}`;
}

/** A thread's stored rows as the pure lifecycle reads them. */
export function offerTurns(rows: readonly PlanChangeTurn[]): PlanOfferTurn[] {
  return rows.map((row) => {
    const dto = toPlanChangeTurnDto(row);
    return { id: dto.id, seq: dto.seq, role: dto.role, offer: dto.offer ?? null };
  });
}

/**
 * The session a disposition write works on, re-read and owner-checked UNDER its row
 * lock. Another member's conversation reads exactly as a missing one.
 */
async function lockOwnSession(
  pctx: ProjectContext,
  sessionId: string,
  tx: Prisma.TransactionClient,
) {
  const locked = await planChangeSessionRepository.lockById(sessionId, tx);
  if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);
  const session = await planChangeSessionRepository.findByIdInProject(
    sessionId,
    pctx.projectId,
    pctx.workspaceId,
    tx,
  );
  if (!session || session.createdById !== pctx.userId) {
    throw new PlanChangeSessionNotFoundError(pctx.projectId);
  }
  return session;
}

/** The thread as the caller reads it — imported at call time, because the session
 *  service builds its DTOs through {@link planOfferService.resolveFor}. */
async function threadOf(pctx: ProjectContext, sessionId: string): Promise<PlanChangeSessionDto> {
  const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
  return planChangeSessionsService.getById(pctx, sessionId);
}

export const planOfferService = {
  /**
   * What the settle's answer arm STORES for an envelope offer, or null for none.
   * Pure reads; the write is the answer's own `appendAnswerTurn`, so an offer can
   * never precede its answer or outlive a failed append. Never throws on a gate.
   *
   *  - no offer, an unknown kind, or `immediate: true` (the turn starts at once
   *    through the targeted door, so there is nothing for a Confirm to answer) ⇒ null;
   *  - the caller lacks `ai:plan` or `work_item:edit`, or Motir AI is not configured
   *    ⇒ null, and the answer still lands;
   *  - a target that does not resolve for the caller in THIS project ⇒ the offer
   *    lands with no target;
   *  - a target that is ALREADY done or cancelled ⇒ null: such a target cannot be
   *    planned, and the answer carries on the conversation instead of drawing an
   *    offer that could never start (design review of MOTIR-9286).
   */
  async land(
    offer: AskPlanOffer | null | undefined,
    pctx: ProjectContext,
  ): Promise<AnswerOfferInput | null> {
    if (!offer || offer.kind !== 'plan' || offer.immediate) return null;
    if (!(await planningAvailable(pctx))) return null;
    if (offer.targetKey === null) {
      return {
        kind: 'plan',
        requestMd: offer.requestMd,
        targetKey: null,
        ...(offer.requirement ? { requirement: offer.requirement } : {}),
      };
    }
    const target = await resolveTarget(offer.targetKey, pctx);
    if (target) {
      const terminal = await workflowsService.getTerminalStatusKeys(
        pctx.projectId,
        pctx.workspaceId,
      );
      if (terminal.has(target.status)) return null;
    }
    return { kind: 'plan', requestMd: offer.requestMd, targetKey: target?.identifier ?? null };
  },

  /**
   * Decline the offer on `turnId` — a door, not a turn, so the disposition is stored
   * (MOTIR-9290; the shape of `declineGuideReplanOffer`). Under the session's row
   * lock; appends no turn, submits no job and leaves `lastActivityAt` untouched, so a
   * decline does not extend the question-only window.
   *
   *  - not the caller's own conversation, or no offer on that turn ⇒ 404;
   *  - already `declined` ⇒ idempotent: the thread comes back, nothing is written;
   *  - `confirmed` or `superseded` ⇒ `PlanOfferNotOpenError`, writing nothing.
   */
  async declinePlanOffer(
    turnId: string,
    pctx: ProjectContext,
    address: { sessionId: string },
  ): Promise<PlanChangeSessionDto> {
    await projectAccessService.assertPermission(pctx.projectId, actorOf(pctx), 'ai:plan');
    await withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        await lockOwnSession(pctx, address.sessionId, tx);
        const rows = await planChangeTurnRepository.listBySessionId(
          address.sessionId,
          pctx.workspaceId,
          tx,
        );
        const state = planOfferStateOf(offerTurns(rows), turnId);
        if (state === null) throw new PlanOfferNotFoundError(turnId);
        if (state === 'declined') return;
        if (state === 'confirmed' || state === 'superseded') {
          throw new PlanOfferNotOpenError(turnId);
        }
        const row = rows.find((t) => t.id === turnId)!;
        // A `log_bug` offer whose write is in flight (MOTIR-9323) is claimed before it
        // is stamped confirmed: it can no longer be declined either.
        if (row.debugLandingClaimedAt !== null) throw new PlanOfferNotOpenError(turnId);
        await planChangeTurnRepository.setAnswerOffer(
          row.id,
          pctx.workspaceId,
          // The stored JSON with only the decision changed: every other key rides through.
          {
            ...(row.answerOffer as Record<string, unknown>),
            declinedAt: new Date().toISOString(),
            declinedById: pctx.userId,
          } as Prisma.InputJsonValue,
          tx,
        );
      },
    );
    return threadOf(pctx, address.sessionId);
  },

  /**
   * Record that a start of the offer on `turnId` was refused for credits — the one
   * reason that cannot be read live (MOTIR-9290). Written by One start per offer when
   * its submit throws `MotirAiOutOfCreditsError`. Under the session's row lock; the
   * first record stands, so a replayed refusal writes nothing.
   */
  async recordCannotStart(
    turnId: string,
    reason: 'out_of_credits',
    detail: string | null,
    pctx: ProjectContext,
    address: { sessionId: string },
  ): Promise<PlanChangeSessionDto> {
    await withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        await lockOwnSession(pctx, address.sessionId, tx);
        const rows = await planChangeTurnRepository.listBySessionId(
          address.sessionId,
          pctx.workspaceId,
          tx,
        );
        if (planOfferStateOf(offerTurns(rows), turnId) === null) {
          throw new PlanOfferNotFoundError(turnId);
        }
        const row = rows.find((t) => t.id === turnId)!;
        if (recordedRefusalOf(row.answerOffer)) return;
        await planChangeTurnRepository.setAnswerOffer(
          row.id,
          pctx.workspaceId,
          {
            ...(row.answerOffer as Record<string, unknown>),
            startRefusal: { reason, detail, at: new Date().toISOString() },
          } as Prisma.InputJsonValue,
          tx,
        );
      },
    );
    return threadOf(pctx, address.sessionId);
  },

  /**
   * The served `state` and `cannotStart` for every offer on a thread, keyed by turn
   * id. A thread with no offer pays nothing. `tx` joins the caller's transaction.
   * Three reads, whatever the number of offers: the caller's permissions, the
   * targets' statuses and the targets' locks.
   */
  async resolveFor(
    sessionId: string,
    rows: readonly PlanChangeTurn[],
    pctx: ProjectContext,
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, PlanOfferResolution>> {
    const turns = offerTurns(rows);
    const all = turns.filter((t) => t.role === 'assistant' && t.offer);
    const out = new Map<string, PlanOfferResolution>();
    // A `log_bug` offer (MOTIR-9322) shares the four states; its one reason is
    // `planning_unavailable` (no `ai:plan`, or Motir AI not configured) — its target
    // is not a plan's, so the lock and closed reads are a plan's alone.
    const bugs = all.filter((t) => t.offer!.kind === 'log_bug');
    if (bugs.length > 0) {
      const bugAvailable = await bugLoggingAvailable(pctx, tx);
      for (const turn of bugs) {
        const raw = rows.find((r) => r.id === turn.id)!.answerOffer;
        out.set(turn.id, {
          state: planOfferStateOf(turns, turn.id)!,
          cannotStart: !bugAvailable
            ? 'planning_unavailable'
            : recordedRefusalOf(raw) !== null
              ? 'out_of_credits'
              : null,
        });
      }
    }
    const offered = all.filter((t) => t.offer!.kind === 'plan');
    if (offered.length === 0) return out;

    const keys = [
      ...new Set(offered.flatMap((t) => (t.offer!.targetKey ? [t.offer!.targetKey] : []))),
    ];
    const readTargets = async (t: Prisma.TransactionClient) => {
      const items = await workItemRepository.findByIdentifiers(pctx.projectId, keys, t);
      const locks = await planTargetLockRepository.listHoldersByWorkItemIds(
        items.map((i) => i.id),
        t,
      );
      return { items, locks };
    };
    const available = await planningAvailable(pctx, tx);
    const { items, locks } =
      keys.length === 0
        ? { items: [], locks: [] }
        : tx
          ? await readTargets(tx)
          : await withWorkspaceServiceContext(pctx.workspaceId, readTargets);
    const terminal =
      keys.length === 0
        ? new Set<string>()
        : await workflowsService.getTerminalStatusKeys(pctx.projectId, pctx.workspaceId);

    const now = new Date();
    const byKey = new Map(items.map((i) => [i.identifier, i]));
    const heldIds = new Set(
      locks
        .filter(
          (l) =>
            !isExpired(l.expiresAt, now) &&
            (l.planId !== null || (l.sessionId !== null && l.sessionId !== sessionId)),
        )
        .map((l) => l.workItemId),
    );
    for (const turn of offered) {
      const target = turn.offer!.targetKey ? byKey.get(turn.offer!.targetKey) : undefined;
      const raw = rows.find((r) => r.id === turn.id)!.answerOffer;
      out.set(turn.id, {
        state: planOfferStateOf(turns, turn.id)!,
        cannotStart: cannotStartOf({
          planningAvailable: available,
          targetClosed: target ? terminal.has(target.status) : false,
          targetHeld: target ? heldIds.has(target.id) : false,
          outOfCredits: recordedRefusalOf(raw) !== null,
        }),
      });
    }
    return out;
  },

  /**
   * What an ask submit states about the live offer, read from the thread as it
   * stood BEFORE the turn being answered: the latest assistant turn's offer when it
   * is undecided, else undefined — so the context key is ABSENT, never null.
   */
  statingPending(turns: readonly PlanOfferTurn[]): PendingPlanOfferStatement | undefined {
    const pending = pendingPlanOfferOf(turns);
    if (!pending) return undefined;
    if (pending.offer.kind === 'log_bug') {
      // A bug offer (MOTIR-9323) is stated by the write it would make, so a typed yes
      // agrees to that write; motir-ai reads a blank `requestText` as no offer.
      return {
        kind: 'log_bug',
        requestText: logBugWriteLine(pending.offer),
        targetKey: pending.offer.targetKey,
        seq: pending.seq,
      };
    }
    if (pending.offer.kind !== 'plan') return undefined;
    return {
      kind: 'plan',
      requestText: pending.offer.requestMd,
      targetKey: pending.offer.targetKey,
      seq: pending.seq,
    };
  },
};
