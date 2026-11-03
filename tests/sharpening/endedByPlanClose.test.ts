import { describe, expect, it } from 'vitest';
import { endedByPlanClose } from '@/lib/services/aiSharpenService';
import { PLAN_CLOSED_WRITE_BACK } from '@/lib/services/replanRefusalService';

// MOTIR-10233 — the predicate that keeps a late grilling result from re-opening a session
// the can't-plan door ended. It must recognise exactly the write-back that door stores,
// and nothing that merely looks like a write-back.
describe('endedByPlanClose', () => {
  it('is true for the write-back the can’t-plan door stores', () => {
    expect(endedByPlanClose(PLAN_CLOSED_WRITE_BACK)).toBe(true);
  });

  it('is false for an ordinary write-back, a failure, or nothing at all', () => {
    expect(endedByPlanClose({ ok: true })).toBe(false);
    expect(endedByPlanClose({ ok: false, error: 'x' })).toBe(false);
    expect(endedByPlanClose({ ok: false, planClosed: 'yes' })).toBe(false);
    expect(endedByPlanClose(null)).toBe(false);
    expect(endedByPlanClose(undefined)).toBe(false);
    expect(endedByPlanClose('planClosed')).toBe(false);
  });
});
