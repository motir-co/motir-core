import { describe, expect, it } from 'vitest';
import { PLAN_STATUS_DTO_VALUES, type PlanStatusDto } from '@/lib/dto/plans';
import { UNDECIDED_PLAN_STATUSES, planHoldFor, type PlanHoldLock } from '@/lib/plans/planHold';

// THE PLAN HOLD's predicate (Story MOTIR-6017 · MOTIR-6265;
// `docs/decisions/agent-authored-plans.md` AMENDMENT 21 §1) — pure, so every
// `PlanStatus` member is asserted here without a database.

const NOW = new Date('2026-09-25T12:00:00Z');
const LIVE: PlanHoldLock = { planId: 'plan_1', expiresAt: new Date('2026-09-26T12:00:00Z') };
const EXPIRED: PlanHoldLock = { planId: 'plan_1', expiresAt: new Date('2026-09-24T12:00:00Z') };

const EXPECTED: Record<PlanStatusDto, boolean> = {
  generating: true,
  planned: true,
  approving: true,
  stale: true,
  approved: false,
  declined: false,
};

describe('planHoldFor — AMENDMENT 21 §1', () => {
  it('covers every PlanStatus member, and holds exactly the undecided ones', () => {
    expect([...PLAN_STATUS_DTO_VALUES].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const planStatus of PLAN_STATUS_DTO_VALUES) {
      const hold = planHoldFor({ itemStatus: 'planning', lock: LIVE, planStatus, now: NOW });
      expect(hold.held, planStatus).toBe(EXPECTED[planStatus]);
      if (hold.held) expect(hold).toEqual({ held: true, planId: 'plan_1', planStatus });
    }
  });

  it('UNDECIDED_PLAN_STATUSES is the same set the predicate holds for', () => {
    expect([...UNDECIDED_PLAN_STATUSES].sort()).toEqual(
      PLAN_STATUS_DTO_VALUES.filter((s) => EXPECTED[s]).sort(),
    );
  });

  it('a card not at `planning` is never held', () => {
    for (const itemStatus of ['todo', 'in_progress', 'blocked', 'done']) {
      expect(planHoldFor({ itemStatus, lock: LIVE, planStatus: 'planned', now: NOW }).held).toBe(
        false,
      );
    }
  });

  it('no lock row, or no resolvable plan, is not held', () => {
    expect(
      planHoldFor({ itemStatus: 'planning', lock: null, planStatus: null, now: NOW }).held,
    ).toBe(false);
    expect(
      planHoldFor({ itemStatus: 'planning', lock: LIVE, planStatus: null, now: NOW }).held,
    ).toBe(false);
  });

  it('a SESSION-held lock (planId null) never holds', () => {
    const session: PlanHoldLock = { planId: null, expiresAt: LIVE.expiresAt };
    expect(
      planHoldFor({ itemStatus: 'planning', lock: session, planStatus: 'planned', now: NOW }).held,
    ).toBe(false);
  });

  it('an EXPIRED lease holds nothing on a `generating` plan — and still holds on planned / stale', () => {
    expect(
      planHoldFor({ itemStatus: 'planning', lock: EXPIRED, planStatus: 'generating', now: NOW })
        .held,
    ).toBe(false);
    for (const planStatus of ['planned', 'stale'] as const) {
      expect(
        planHoldFor({ itemStatus: 'planning', lock: EXPIRED, planStatus, now: NOW }).held,
        planStatus,
      ).toBe(true);
    }
  });
});
