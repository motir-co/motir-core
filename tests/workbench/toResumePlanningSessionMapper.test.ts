import { describe, expect, it } from 'vitest';
import { toToResumePlanningSessionDto } from '@/lib/mappers/workbenchPlanningMappers';
import type { PlanProgressSnapshot } from '@/lib/plans/planProgress';

// The To resume planning-session entry mapper (Story MOTIR-7905 · MOTIR-7914 / MOTIR-7939):
// pure, so every branch is pinned here without a database.

const progress = { steps: [] } as unknown as PlanProgressSnapshot;
const titles = new Map([['MOTIR-1', 'Login']]);
const plans = new Map([
  ['g1', { id: 'g1', title: 'Walking', status: 'generating' }],
  ['w1', { id: 'w1', title: 'Waiting', status: 'planned' }],
  ['s1', { id: 's1', title: 'Stale one', status: 'stale' }],
  ['d1', { id: 'd1', title: 'Decided', status: 'approved' }],
]);
const failed = {
  id: 'sess',
  targetKeys: ['MOTIR-1', 'MOTIR-9'],
  failedAt: new Date('2026-10-10T10:00:00.000Z'),
  failureReason: 'rate_limited',
  failureStopPhase: 'author' as const,
  failureStopRef: 'ref',
  failureStopTitle: 'Third',
};

describe('toToResumePlanningSessionDto', () => {
  it('a failed walk carries its failure, its progress and the waiting plan beside it', () => {
    const dto = toToResumePlanningSessionDto(
      failed,
      { form: 'failed_walk', entryPlanId: 'g1', waitingPlanId: 'w1' },
      plans,
      'Acme',
      titles,
      progress,
    );
    expect(dto).toMatchObject({
      sessionId: 'sess',
      form: 'failed_walk',
      planId: 'g1',
      title: 'Walking',
      waitingPlan: { planId: 'w1', title: 'Waiting', status: 'planned' },
      projectName: 'Acme',
      targets: [
        { key: 'MOTIR-1', title: 'Login' },
        { key: 'MOTIR-9', title: null },
      ],
      failure: {
        failedAt: '2026-10-10T10:00:00.000Z',
        reason: 'rate_limited',
        stopPhase: 'author',
        stopRef: 'ref',
        stopTitle: 'Third',
      },
      endedAt: null,
      progress,
    });
  });

  it('a failure beside a waiting plan has no progress, and a stale plan is named as stale', () => {
    const dto = toToResumePlanningSessionDto(
      failed,
      { form: 'failed_beside_waiting_plan', entryPlanId: 's1', waitingPlanId: 's1' },
      plans,
      'Acme',
      titles,
      progress,
    );
    expect(dto.progress).toBeNull();
    expect(dto.waitingPlan).toEqual({ planId: 's1', title: 'Stale one', status: 'stale' });
  });

  it('a waiting plan that was decided meanwhile is not offered as waiting', () => {
    const dto = toToResumePlanningSessionDto(
      failed,
      { form: 'failed_walk', entryPlanId: 'g1', waitingPlanId: 'd1' },
      plans,
      'Acme',
      titles,
      null,
    );
    expect(dto.waitingPlan).toBeNull();
  });

  it('a session that ended failed carries no failure record and names when it ended', () => {
    const dto = toToResumePlanningSessionDto(
      { id: 'old', targetKeys: [], endedAt: new Date('2026-10-01T00:00:00.000Z') },
      { form: 'ended_with_waiting_plan', entryPlanId: 'w1', waitingPlanId: 'w1' },
      plans,
      'Acme',
      titles,
      progress,
    );
    expect(dto.failure).toBeNull();
    expect(dto.endedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(dto.progress).toBeNull();
  });

  it('an ended session with no recorded end time reads null, never a made-up date', () => {
    const dto = toToResumePlanningSessionDto(
      { id: 'old', targetKeys: [] },
      { form: 'ended_with_waiting_plan', entryPlanId: 'w1', waitingPlanId: null },
      plans,
      'Acme',
      titles,
      null,
    );
    expect(dto.endedAt).toBeNull();
    expect(dto.waitingPlan).toBeNull();
  });

  it('an unresolved session is still listed as a failed walk on its latest plan, with defaults', () => {
    const dto = toToResumePlanningSessionDto(
      { id: 'x', targetKeys: [], latestPlan: { id: 'lp', title: null } },
      null,
      plans,
      'Acme',
      titles,
      progress,
    );
    expect(dto).toMatchObject({ form: 'failed_walk', planId: 'lp', title: null });
    expect(dto.failure).toEqual({
      failedAt: new Date(0).toISOString(),
      reason: 'internal',
      stopPhase: null,
      stopRef: null,
      stopTitle: null,
      notPlannedYet: [],
    });
  });

  it('carries the halted walk’s not-planned-yet lines in order, and none as an empty list (MOTIR-10209)', () => {
    const lines = [
      '"D" is not planned yet: plan "B" first, then plan "D".',
      'Not written yet: "T".',
    ];
    const withLines = toToResumePlanningSessionDto(
      { id: 'x', targetKeys: [], failedAt: new Date(0), failureNotPlannedYet: lines },
      null,
      plans,
      'Acme',
      titles,
      null,
    );
    expect(withLines.failure?.notPlannedYet).toEqual(lines);
    const withNull = toToResumePlanningSessionDto(
      { id: 'x', targetKeys: [], failedAt: new Date(0), failureNotPlannedYet: null },
      null,
      plans,
      'Acme',
      titles,
      null,
    );
    expect(withNull.failure?.notPlannedYet).toEqual([]);
  });

  it('an unresolved session with no plan at all has no entry plan', () => {
    const dto = toToResumePlanningSessionDto(
      { id: 'x', targetKeys: [] },
      null,
      plans,
      'Acme',
      titles,
      null,
    );
    expect(dto.planId).toBeNull();
  });
});
