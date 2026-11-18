import { describe, expect, it } from 'vitest';
import { toResumeFormOf } from '@/lib/planChange/toResumeForm';

const t = (n: number) => new Date(2026, 9, 1, 0, n);
const plan = (id: string, status: 'generating' | 'stopped' | 'planned' | 'stale', n: number) => ({
  id,
  status,
  createdAt: t(n),
});
const open = { endedAt: null, endReason: null };
const endedFailed = { endedAt: t(50), endReason: 'failed' };

describe('toResumeFormOf (MOTIR-7939)', () => {
  it('an open failed session holding a generating plan is a failed_walk', () => {
    expect(toResumeFormOf(open, [plan('g', 'generating', 2)])).toEqual({
      form: 'failed_walk',
      entryPlanId: 'g',
      waitingPlanId: null,
    });
  });
  it('an open failed session holding a STOPPED plan is a failed_walk too (Bug MOTIR-11701)', () => {
    expect(toResumeFormOf(open, [plan('s', 'stopped', 2)])).toEqual({
      form: 'failed_walk',
      entryPlanId: 's',
      waitingPlanId: null,
    });
  });

  it('a failed_walk names an older waiting plan as its second line', () => {
    expect(toResumeFormOf(open, [plan('g', 'generating', 2), plan('p', 'planned', 1)])).toEqual({
      form: 'failed_walk',
      entryPlanId: 'g',
      waitingPlanId: 'p',
    });
  });
  it('an open failed session holding only a planned or stale plan is failed_beside_waiting_plan', () => {
    for (const status of ['planned', 'stale'] as const) {
      expect(toResumeFormOf(open, [plan('p', status, 1)])).toEqual({
        form: 'failed_beside_waiting_plan',
        entryPlanId: 'p',
        waitingPlanId: 'p',
      });
    }
  });
  it('an open session holding nothing undecided takes no form', () => {
    expect(toResumeFormOf(open, [])).toBeNull();
  });
  it('an ended-failed session holding a waiting plan is ended_with_waiting_plan', () => {
    expect(toResumeFormOf(endedFailed, [plan('p', 'planned', 1)])).toEqual({
      form: 'ended_with_waiting_plan',
      entryPlanId: 'p',
      waitingPlanId: 'p',
    });
  });
  it('an ended session holding only a generating plan takes no form', () => {
    expect(toResumeFormOf(endedFailed, [plan('g', 'generating', 1)])).toBeNull();
  });
  it('only a FAILED end takes the ended form', () => {
    for (const endReason of ['idle', 'restarted', 'declined', 'approved']) {
      expect(toResumeFormOf({ endedAt: t(50), endReason }, [plan('p', 'planned', 1)])).toBeNull();
    }
  });
  it('the newest waiting plan wins, and id breaks a createdAt tie', () => {
    expect(
      toResumeFormOf(endedFailed, [plan('a', 'planned', 1), plan('b', 'stale', 3)])?.waitingPlanId,
    ).toBe('b');
    expect(
      toResumeFormOf(endedFailed, [plan('a', 'planned', 2), plan('b', 'planned', 2)])
        ?.waitingPlanId,
    ).toBe('b');
  });
});
