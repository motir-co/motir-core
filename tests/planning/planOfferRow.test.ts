import { afterEach, describe, expect, it, vi } from 'vitest';

// THE PLAN OFFER ROW's pure decisions and its decline door (Story MOTIR-9219 ·
// MOTIR-9294). The decisions are total maps over codes this build does not own; the
// door is a pass-through, so its service is stubbed and the shipped error mapping is
// real.

const requireCompliantSession = vi.fn();
const getActiveProject = vi.fn();
const declinePlanOffer = vi.fn();
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: () => requireCompliantSession(),
}));
vi.mock('@/lib/projects', () => ({ getActiveProject: () => getActiveProject() }));
vi.mock('@/lib/services/planOfferService', () => ({
  planOfferService: { declinePlanOffer: (...a: unknown[]) => declinePlanOffer(...a) },
}));

const { alreadyPlanning, answerRefusalKey, cannotStartKey, offerAnswerable } =
  await import('@/lib/planning/planOfferRow');
const { PlanOfferNotFoundError, PlanOfferNotOpenError } = await import('@/lib/planChange/errors');
const { POST: decline } = await import('@/app/api/ai/plan-change/session/offer/decline/route');

afterEach(() => vi.clearAllMocks());

function offerTurn(id: string, seq: number, state: string | null) {
  return {
    id,
    seq,
    role: 'assistant',
    offer:
      state === null
        ? null
        : {
            kind: 'plan',
            requestMd: 'x',
            targetKey: null,
            declinedAt: state === 'declined' ? '2026-10-22T10:00Z' : null,
            confirmedAt: null,
            confirmedSessionId: null,
            state,
          },
  };
}
const CAN = { canContinue: true, hasActions: true };

describe('offerAnswerable', () => {
  it('is the live undecided offer with a viewer and a host that can answer', () => {
    const turns = [{ id: 'u', seq: 0, role: 'user' }, offerTurn('a', 1, 'undecided')];
    expect(offerAnswerable(turns, 1, CAN)).toBe(true);
    expect(offerAnswerable(turns, 1, { ...CAN, canContinue: false })).toBe(false);
    expect(offerAnswerable(turns, 1, { ...CAN, hasActions: false })).toBe(false);
    expect(offerAnswerable(turns, 0, CAN)).toBe(false);
  });

  it('is never an offer a later answer sits after, whatever its served state says', () => {
    const turns = [offerTurn('a', 0, 'undecided'), offerTurn('b', 1, null)];
    expect(offerAnswerable(turns, 0, CAN)).toBe(false);
  });

  it('is never a decided offer', () => {
    expect(offerAnswerable([offerTurn('a', 0, 'declined')], 0, CAN)).toBe(false);
  });
});

describe('the total maps', () => {
  it('cannotStartKey: each known code its own line, anything else generic', () => {
    expect(cannotStartKey('planning_unavailable')).toEqual({
      kind: 'reason',
      key: 'planningUnavailable',
    });
    expect(cannotStartKey('out_of_credits')).toEqual({ kind: 'reason', key: 'outOfCredits' });
    expect(cannotStartKey('target_held')).toEqual({ kind: 'beingPlanned' });
    expect(cannotStartKey('target_closed')).toEqual({ kind: 'reason', key: 'generic' });
    expect(cannotStartKey('toString')).toEqual({ kind: 'reason', key: 'generic' });
    expect(cannotStartKey('')).toEqual({ kind: 'reason', key: 'generic' });
  });

  it('answerRefusalKey: credits and an unreadable target, anything else generic', () => {
    expect(answerRefusalKey('MOTIR_AI_OUT_OF_CREDITS')).toBe('outOfCredits');
    expect(answerRefusalKey('target_not_available')).toBe('targetUnavailable');
    expect(answerRefusalKey('open_plan_in_scope')).toBe('decideOpenPlanFirst');
    expect(answerRefusalKey('already_planning')).toBe('generic');
    expect(answerRefusalKey('constructor')).toBe('generic');
  });

  it('alreadyPlanning: a run in flight or an undecided plan', () => {
    expect(alreadyPlanning({ phase: 'idle', hasUndecidedPlan: false })).toBe(false);
    expect(alreadyPlanning({ phase: 'review', hasUndecidedPlan: true })).toBe(true);
    expect(alreadyPlanning({ phase: 'streaming', hasUndecidedPlan: false })).toBe(true);
    expect(alreadyPlanning({ phase: 'deciding', hasUndecidedPlan: false })).toBe(true);
    // A reopened conversation's plan still being written: idle phase, live review.
    expect(alreadyPlanning({ phase: 'idle', hasUndecidedPlan: false, writingPlan: true })).toBe(
      true,
    );
  });
});

describe('POST /api/ai/plan-change/session/offer/decline', () => {
  const CTX = { projectId: 'p1', workspaceId: 'w1', userId: 'u1' };
  const post = (body: unknown) =>
    decline(
      new Request('http://localhost/api/ai/plan-change/session/offer/decline', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  function signedIn() {
    requireCompliantSession.mockResolvedValue({ ok: true });
    getActiveProject.mockResolvedValue(CTX);
  }

  it('calls the service once and answers its result', async () => {
    signedIn();
    declinePlanOffer.mockResolvedValue({ id: 's1' });
    const res = await post({ sessionId: 's1', offerTurnId: 't1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 's1' });
    expect(declinePlanOffer).toHaveBeenCalledTimes(1);
    expect(declinePlanOffer).toHaveBeenCalledWith('t1', CTX, { sessionId: 's1' });
  });

  it.each([[{ offerTurnId: 't1' }], [{ sessionId: 's1' }], [{}]])(
    'a missing id is 400 and calls nothing (%j)',
    async (body) => {
      signedIn();
      expect((await post(body)).status).toBe(400);
      expect(declinePlanOffer).not.toHaveBeenCalled();
    },
  );

  it('an absent or foreign offer is the shipped 404', async () => {
    signedIn();
    declinePlanOffer.mockRejectedValue(new PlanOfferNotFoundError('t1'));
    expect((await post({ sessionId: 's1', offerTurnId: 't1' })).status).toBe(404);
  });

  it('a confirmed or superseded offer is 409', async () => {
    signedIn();
    declinePlanOffer.mockRejectedValue(new PlanOfferNotOpenError('t1'));
    expect((await post({ sessionId: 's1', offerTurnId: 't1' })).status).toBe(409);
  });
});
