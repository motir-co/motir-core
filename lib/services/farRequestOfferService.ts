import type { Prisma, PlanChangeTurn } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { appendWithin } from '@/lib/services/planChangeSessionsService';

// THE KEPT TOO-FAR REQUESTS, OFFERED AFTER THE DECISION (Story MOTIR-11515 · MOTIR-11521).
//
// While a conversation's plan waited, a request the planner judged too far from it was
// answered and KEPT on the person's turn (MOTIR-11518). Once the plan is APPROVED or
// DECLINED — which ends the conversation — each kept request is offered as a plan of its
// own, ONE AT A TIME and in the order it was asked: one assistant turn carrying one `plan`
// offer for the earliest kept request. Confirming or declining it consumes that request,
// and the door that did so calls {@link farRequestOfferService.offerNext} again for the
// next one.
//
// ── WHY ONE AT A TIME ───────────────────────────────────────────────────────────
// The shipped lifecycle reads an offer `superseded` as soon as ANY later assistant turn
// exists (`planOfferStateOf`), and the rail, the requirement pane and the ask and sharpen
// settles all read that one rule. Writing every offer at once would leave all but the last
// dead on arrival; writing the next only once the live one is resolved keeps the rule and
// still offers each request exactly once.
//
// ── EXACTLY ONCE ────────────────────────────────────────────────────────────────
// Three doors call `offerNext` (the decision hook, confirm, decline) and any of them may
// be replayed. Under the conversation's row lock it writes nothing while the LATEST
// assistant turn already holds a far-request offer that is live or whose start is in
// flight, so a replay finds the offer it wrote and stops. The consume is a compare-and-set
// on `far_request_consumed_at IS NULL`, so a request is never consumed twice.

/** The stored offer's raw JSON, or null when the turn holds none. */
function offerJsonOf(row: Pick<PlanChangeTurn, 'role' | 'answerOffer'>) {
  const raw = row.role === 'assistant' ? row.answerOffer : null;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** The kept request a stored offer was written for, or null on any other offer. */
export function farRequestTurnIdOf(offer: Record<string, unknown> | null): string | null {
  const id = offer?.['farRequestTurnId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** The English body the offer turn is stored with. The rail draws the localised lead
 *  line (`planningWorkspace.planOffer.afterDecision.lead`) in its place; this is what any
 *  reader without the catalogue (an export, an MCP read) sees. */
export const AFTER_DECISION_OFFER_BODY =
  'While the plan was waiting for your decision, you asked for this. It’s better planned on its own, so here it is as a new plan.';

type Actor = { userId: string; workspaceId: string; projectId: string };

export const farRequestOfferService = {
  /**
   * Offer the conversation's EARLIEST kept too-far request, when it should be offered
   * now: the conversation ended `approved` or `declined`, keeps at least one request,
   * and its latest assistant turn holds no far-request offer that is still live or
   * starting. `true` when this call wrote the offer turn. Under the conversation's row
   * lock, in one transaction.
   */
  async offerNext(actor: Actor, sessionId: string): Promise<boolean> {
    return withWorkspaceContext(actor, async (tx) => {
      const locked = await planChangeSessionRepository.lockById(sessionId, tx);
      if (!locked) return false;
      const session = await planChangeSessionRepository.findByIdInProject(
        sessionId,
        actor.projectId,
        actor.workspaceId,
        tx,
      );
      if (!session?.endedAt) return false;
      if (session.endReason !== 'approved' && session.endReason !== 'declined') return false;

      const kept = await planChangeTurnRepository.listKeptFarRequests(
        session.id,
        actor.workspaceId,
        tx,
      );
      const next = kept[0];
      if (!next?.farRequestRequirement) return false;

      const rows = await planChangeTurnRepository.listBySessionId(
        session.id,
        actor.workspaceId,
        tx,
      );
      const latestAssistant = [...rows].reverse().find((t) => t.role === 'assistant');
      const latestOffer = latestAssistant ? offerJsonOf(latestAssistant) : null;
      if (farRequestTurnIdOf(latestOffer) && isUnresolved(latestOffer!)) return false;

      const offered = rows.filter((t) => farRequestTurnIdOf(offerJsonOf(t)) !== null).length;
      await appendWithin(
        session.id,
        actor,
        {
          role: 'assistant',
          body: AFTER_DECISION_OFFER_BODY,
          answerOffer: {
            kind: 'plan',
            requestMd: next.farRequestRequirement,
            targetKey: null,
            farRequest: {
              turnId: next.id,
              position: offered + 1,
              total: offered + kept.length,
            },
          },
        },
        {},
        tx,
      );
      return true;
    });
  },

  /**
   * CONSUME the kept request a resolved offer was written for (MOTIR-11521), inside the
   * caller's transaction and under its lock: confirm's claim and decline's write both
   * call it. `true` when this call consumed it; an offer written for no kept request, or
   * one whose request was already consumed, writes nothing.
   */
  async consumeForOffer(
    offer: Record<string, unknown> | null,
    scope: { sessionId: string; workspaceId: string },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const turnId = farRequestTurnIdOf(offer);
    if (!turnId) return false;
    return planChangeTurnRepository.markFarRequestConsumed(turnId, scope, tx);
  },

  /** Give back the consume of an offer whose start threw (MOTIR-11521), in the caller's
   *  transaction, so the offer and its request are pending and kept again together. */
  async releaseForOffer(
    offer: Record<string, unknown> | null,
    scope: { sessionId: string; workspaceId: string },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const turnId = farRequestTurnIdOf(offer);
    if (turnId) await planChangeTurnRepository.releaseFarRequestConsumed(turnId, scope, tx);
  },

  /**
   * {@link offerNext}, BEST-EFFORT: the after-commit step of a decision, a confirm or a
   * decline. A failure is logged and swallowed, exactly as the decision's lock release
   * is, so it can never change, delay or fail the door that called it; the next door to
   * resolve an offer, or a replay of this one, writes the offer then.
   */
  async offerNextAfterCommit(actor: Actor, sessionId: string, door: string): Promise<void> {
    try {
      await farRequestOfferService.offerNext(actor, sessionId);
    } catch (err) {
      // A constant format string: the door and the conversation id ride as arguments, so
      // neither can be read as a `%` directive (CodeQL js/tainted-format-string).
      console.warn(
        '[farRequestOfferService] offering the next kept far request after %s on conversation %s failed; it is offered by the next door that resolves an offer',
        door,
        sessionId,
        err,
      );
    }
  },
};

/** A far-request offer nobody has declined, and whose start is not stamped: it is
 *  either live (nothing set) or a confirm is starting it (`confirmedAt` alone). */
function isUnresolved(offer: Record<string, unknown>): boolean {
  if (typeof offer['declinedAt'] === 'string') return false;
  return typeof offer['confirmedSessionId'] !== 'string';
}
