import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLANNER_FINDING_VERDICT_STATES,
  type RawPlannerFinding,
  type RawPlannerFindingRecord,
  type RawPlannerFindingRecordSummary,
} from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError, PlannerFindingRecordNotFoundError } from '@/lib/ai/errors';
import { PLANNER_FINDING_VERDICT_STATE_VALUES } from '@/lib/dto/plannerFindings';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';

/**
 * The console's RECORDS read seam (Story MOTIR-11455 · MOTIR-11463). The platform
 * records service is stubbed at its module and the user lookup at the repository;
 * the mappers are real. What is pinned: the session actor, the record filter
 * mapping (a finding-only key and an out-of-set value dropped), the answer, its
 * stop cards and each finding's key crossing unchanged, `recordId` on a row, one
 * platform call per read, and every refusal propagating untouched.
 */

const records = vi.hoisted(() => ({ listRecords: vi.fn(), getRecord: vi.fn() }));
const users = vi.hoisted(() => ({ findByIds: vi.fn() }));

vi.mock('@/lib/services/plannerFindingsService', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/plannerFindingsService')>(
    '@/lib/services/plannerFindingsService',
  );
  return { ...actual, plannerFindingRecordsService: records };
});
vi.mock('@/lib/repositories/userRepository', () => ({ userRepository: users }));

const { plannerFindingRecordsConsoleService: svc, toRecordQuery } =
  await import('@/lib/services/plannerFindingRecordsConsoleService');
const { toListFilters, toRecordListFilters } =
  await import('@/app/(admin)/admin/planner-findings/_components/listFilters');

const SUPPORT: PlatformPrincipal = { userId: 'u_sp', email: 'sp@moooon.net', role: 'support' };

function rawRecord(over: Partial<RawPlannerFindingRecord> = {}): RawPlannerFindingRecord {
  return {
    id: 'rec_1',
    source: 'check_plan',
    planner: 'hosted',
    coreOrganizationId: 'org_1',
    coreWorkspaceId: 'ws_1',
    coreProjectId: 'pj_1',
    aiProjectId: 'aip_1',
    planId: 'plan_1',
    planSessionId: 'ps_1',
    jobId: 'job_1',
    planTitle: 'Plan one',
    authorModel: 'model-a',
    baselineBranch: 'main',
    baselineCommit: 'abc1234def5678',
    verdictState: 'open',
    verdictBy: null,
    verdictAt: null,
    runThroughAnswer: null,
    runThroughStopCards: [],
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
    ...over,
  };
}

function rawFinding(over: Partial<RawPlannerFinding> = {}): RawPlannerFinding {
  return {
    id: 'pf_1',
    recordId: 'rec_1',
    coreOrganizationId: 'org_1',
    coreWorkspaceId: 'ws_1',
    coreProjectId: 'pj_1',
    aiProjectId: 'aip_1',
    planId: 'plan_1',
    jobId: 'job_1',
    planTitle: 'Plan one',
    cardRef: null,
    source: 'check_plan',
    planner: 'hosted',
    authorModel: null,
    authorSessionKey: null,
    baselineBranch: null,
    baselineCommit: null,
    site: 'lay.story.children',
    prediction: 'STOPS',
    whatHappened: 'w',
    evidence: 'e',
    correction: null,
    outcome: 'reported',
    rule: null,
    attribution: 'corpus',
    why: 'The pack did not carry it.',
    hostedCell: 'lay/story',
    planpyCell: 'PART 2 › story',
    fixDirection: null,
    fingerprint: 'fp_1',
    status: 'new',
    lessonId: null,
    bugKey: 'MOTIR-11602',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
    ...over,
  } as RawPlannerFinding;
}

beforeEach(() => {
  records.listRecords.mockReset();
  records.getRecord.mockReset();
  users.findByIds.mockReset();
  users.findByIds.mockResolvedValue([]);
});

describe('the verdict-state values', () => {
  it('equal the client set, member for member', () => {
    expect([...PLANNER_FINDING_VERDICT_STATE_VALUES]).toEqual([...PLANNER_FINDING_VERDICT_STATES]);
  });
});

describe('the record filters', () => {
  it('maps verdict, planner, source and cursor to the platform query', () => {
    expect(
      toRecordQuery({
        verdict: 'attributed',
        planner: 'plan_py',
        source: 'check_plan',
        cursor: 'c1',
      }),
    ).toEqual({
      verdictState: 'attributed',
      planner: 'plan_py',
      source: 'check_plan',
      cursor: 'c1',
    });
  });

  it('drops a value outside its closed set rather than sending it', () => {
    expect(
      toRecordQuery({ verdict: 'closed', planner: 'gpt', source: 'nope', cursor: '  ' }),
    ).toEqual({});
  });

  it('the URL mapper reads only the record keys, so a finding-only key is dropped', () => {
    const params = {
      view: 'records',
      state: 'dismissed',
      outcome: 'fixed',
      verdict: 'open',
      cursor: 'c2',
    };
    expect(toRecordListFilters(params)).toEqual({ verdict: 'open', cursor: 'c2' });
    // …and the findings mapper never reads the Records view's own key.
    expect(toListFilters({ verdict: 'open' })).toEqual({});
  });
});

describe('list', () => {
  it('composes the session actor, sends the mapped query once, and maps the rows', async () => {
    const summary: RawPlannerFindingRecordSummary = {
      ...rawRecord({ runThroughAnswer: 'STOPS', runThroughStopCards: ['MOTIR-2', 'MOTIR-1'] }),
      findingCount: 4,
      attributedCount: 0,
    };
    records.listRecords.mockResolvedValue({
      records: [summary],
      nextCursor: 'next',
      retention: { days: 90, cutoff: null },
    });

    const out = await svc.list(SUPPORT, { verdict: 'open', state: 'dismissed' } as never);

    expect(records.listRecords).toHaveBeenCalledTimes(1);
    expect(records.listRecords).toHaveBeenCalledWith(
      { ...SUPPORT, credential: { kind: 'session' } },
      { verdictState: 'open' },
    );
    expect(out.nextCursor).toBe('next');
    expect(out.records).toEqual([
      {
        id: 'rec_1',
        source: 'check_plan',
        planner: 'hosted',
        planId: 'plan_1',
        planTitle: 'Plan one',
        planSessionId: 'ps_1',
        jobId: 'job_1',
        authorModel: 'model-a',
        baselineBranch: 'main',
        baselineCommit: 'abc1234def5678',
        verdictState: 'open',
        verdictBy: null,
        verdictAt: null,
        runThroughAnswer: 'STOPS',
        runThroughStopCards: ['MOTIR-2', 'MOTIR-1'],
        createdAt: '2026-11-16T10:00:00.000Z',
        findingCount: 4,
        attributedCount: 0,
      },
    ]);
    expect(out).not.toHaveProperty('records.0.linkedBugKeys');
  });

  it('lets a platform refusal and an outage propagate untouched', async () => {
    records.listRecords.mockRejectedValueOnce(new NotPlatformStaffError());
    await expect(svc.list(SUPPORT, {})).rejects.toBeInstanceOf(NotPlatformStaffError);
    records.listRecords.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    await expect(svc.list(SUPPORT, {})).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('get', () => {
  it('reads the record once and keeps the three readings apart', async () => {
    for (const [answer, cards] of [
      ['THRU', []],
      ['STOPS', ['MOTIR-9', 'MOTIR-3']],
      ['STOPS', []],
      [null, []],
    ] as const) {
      records.getRecord.mockResolvedValueOnce({
        record: rawRecord({ runThroughAnswer: answer, runThroughStopCards: [...cards] }),
        findings: [],
      });
      const { detail } = await svc.get(SUPPORT, 'rec_1');
      // A null answer stays null — never THRU — and an empty list stays empty.
      expect(detail.record.runThroughAnswer).toBe(answer);
      expect(detail.record.runThroughStopCards).toEqual(cards);
    }
    expect(records.getRecord).toHaveBeenCalledTimes(4);
    expect(records.getRecord).toHaveBeenCalledWith(
      { ...SUPPORT, credential: { kind: 'session' } },
      'rec_1',
    );
  });

  it("passes each finding's key through as text, in stored order, with no key set on the record", async () => {
    records.getRecord.mockResolvedValue({
      record: rawRecord(),
      findings: [
        rawFinding({ id: 'pf_b', bugKey: 'MOTIR-404' }),
        rawFinding({ id: 'pf_a', bugKey: null, attribution: null, why: null }),
      ],
    });
    const { detail } = await svc.get(SUPPORT, 'rec_1');
    expect(detail.findings.map((f) => [f.id, f.bugKey])).toEqual([
      ['pf_b', 'MOTIR-404'],
      ['pf_a', null],
    ]);
    expect(detail.findings[0]).toEqual({
      id: 'pf_b',
      site: 'lay.story.children',
      prediction: 'STOPS',
      outcome: 'reported',
      attribution: 'corpus',
      why: 'The pack did not carry it.',
      hostedCell: 'lay/story',
      planpyCell: 'PART 2 › story',
      bugKey: 'MOTIR-404',
    });
    expect(detail.findings[1]!.attribution).toBeNull();
    expect(detail.record).not.toHaveProperty('linkedBugKeys');
    expect(users.findByIds).not.toHaveBeenCalled();
  });

  it('names whoever gave the verdict, and null when they are gone', async () => {
    records.getRecord.mockResolvedValue({
      record: rawRecord({
        verdictState: 'attributed',
        verdictBy: 'u_sam',
        verdictAt: '2026-11-16T12:40:00.000Z',
      }),
      findings: [],
    });
    users.findByIds.mockResolvedValueOnce([{ id: 'u_sam', name: 'Sam' }]);
    expect((await svc.get(SUPPORT, 'rec_1')).verdictByName).toBe('Sam');
    expect(users.findByIds).toHaveBeenCalledWith(['u_sam']);
    users.findByIds.mockResolvedValueOnce([]);
    expect((await svc.get(SUPPORT, 'rec_1')).verdictByName).toBeNull();
  });

  it('lets not-found, a refusal and an outage propagate untouched', async () => {
    records.getRecord.mockRejectedValueOnce(new PlannerFindingRecordNotFoundError('nope'));
    await expect(svc.get(SUPPORT, 'nope')).rejects.toBeInstanceOf(
      PlannerFindingRecordNotFoundError,
    );
    records.getRecord.mockRejectedValueOnce(new NotPlatformStaffError());
    await expect(svc.get(SUPPORT, 'rec_1')).rejects.toBeInstanceOf(NotPlatformStaffError);
    records.getRecord.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    await expect(svc.get(SUPPORT, 'rec_1')).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});
