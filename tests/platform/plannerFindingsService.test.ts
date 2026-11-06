import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { MotirAiUnavailableError, PlannerFindingNotFoundError } from '@/lib/ai/errors';
import type {
  PlannerFindingListQuery,
  RawPlannerFinding,
  RawPlannerFindingGroupPage,
  RawPlannerFindingPage,
} from '@/lib/ai/motirAiClient';
import type { JobView } from '@/lib/ai/errors';

/**
 * The planner-findings console's READ service (Story MOTIR-10353 · MOTIR-10518).
 *
 * motir-ai is stubbed at the client module and the staff gate is a
 * degree-honouring mock, as `platformLessonsService.test.ts` does. The reads
 * write no audit row and touch no Prisma, so nothing here needs a database.
 */

const client = vi.hoisted(() => ({
  listPlannerFindings: vi.fn(),
  listPlannerFindingGroups: vi.fn(),
  getPlannerFinding: vi.fn(),
  getJob: vi.fn(),
}));
const users = vi.hoisted(() => ({ findByIds: vi.fn() }));
const gate = vi.hoisted(() => ({ principal: null as PlatformPrincipal | null }));

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return { ...actual, ...client };
});
vi.mock('@/lib/repositories/userRepository', () => ({ userRepository: users }));
vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!gate.principal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(gate.principal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return gate.principal;
      },
    ),
  };
});

const { plannerFindingsService, PLANNER_FINDINGS_PAGE_SIZE } =
  await import('@/lib/services/plannerFindingsService');

const SUPPORT: PlatformPrincipal = { userId: 'u_staff', email: 'ops@moooon.net', role: 'support' };
const FORGED: PlatformPrincipal = { userId: 'u_evil', email: 'x@example.com', role: 'superadmin' };

function finding(over: Partial<RawPlannerFinding> = {}): RawPlannerFinding {
  return {
    id: 'pf_1',
    coreOrganizationId: 'org_1',
    coreWorkspaceId: 'ws_1',
    coreProjectId: 'pj_1',
    aiProjectId: 'aip_1',
    planId: 'plan_gone_forever',
    jobId: 'job_1',
    planTitle: 'A plan nobody kept',
    cardRef: null,
    source: 'in_loop',
    planner: 'hosted',
    authorModel: null,
    authorSessionKey: null,
    baselineBranch: null,
    baselineCommit: null,
    site: 'leaf:MOTIR-1',
    prediction: 'STOPS',
    whatHappened: 'It named a missing file.',
    evidence: 'not found',
    correction: null,
    outcome: 'fixed',
    rule: null,
    attribution: null,
    why: null,
    hostedCell: null,
    planpyCell: null,
    fixDirection: null,
    fingerprint: 'fp_1',
    status: 'new',
    lessonId: null,
    bugKey: null,
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...over,
  };
}

function page(
  findings: RawPlannerFinding[],
  nextCursor: string | null = null,
): RawPlannerFindingPage {
  return { findings, nextCursor, retention: { days: 90, cutoff: '2026-08-08T00:00:00.000Z' } };
}

function job(result: unknown): JobView {
  return { result } as unknown as JobView;
}

const lastQuery = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.at(-1)?.[0] as PlannerFindingListQuery;

beforeEach(() => {
  vi.clearAllMocks();
  gate.principal = SUPPORT;
  client.listPlannerFindings.mockResolvedValue(page([finding()]));
  client.listPlannerFindingGroups.mockResolvedValue({
    groups: [],
    nextCursor: null,
    retention: { days: 90, cutoff: null },
  } satisfies RawPlannerFindingGroupPage);
  client.getPlannerFinding.mockResolvedValue(finding({ jobId: null }));
  client.getJob.mockResolvedValue(job({}));
  users.findByIds.mockResolvedValue([]);
});

describe('the staff gate runs before any motir-ai call', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['list', () => plannerFindingsService.list(FORGED, {})],
    ['listGroups', () => plannerFindingsService.listGroups(FORGED, {})],
    ['getGroup', () => plannerFindingsService.getGroup(FORGED, 'fp_1', {})],
    ['listGroupFindings', () => plannerFindingsService.listGroupFindings(FORGED, 'fp_1', {})],
    ['get', () => plannerFindingsService.get(FORGED, 'pf_1')],
  ];

  it.each(calls)('%s refuses a non-staff caller holding a forged principal', async (_n, call) => {
    gate.principal = null;
    await expect(call()).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(client.listPlannerFindings).not.toHaveBeenCalled();
    expect(client.listPlannerFindingGroups).not.toHaveBeenCalled();
    expect(client.getPlannerFinding).not.toHaveBeenCalled();
    expect(client.getJob).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  it('sends the given filters, the page size and the dismissed-hidden default', async () => {
    const dto = await plannerFindingsService.list(SUPPORT, {
      source: 'in_loop',
      planner: 'hosted',
      attribution: 'corpus',
      outcome: 'fixed',
      fingerprint: 'fp_9',
      cursor: 'c_1',
    });
    expect(lastQuery(client.listPlannerFindings)).toEqual({
      limit: PLANNER_FINDINGS_PAGE_SIZE,
      source: 'in_loop',
      planner: 'hosted',
      attribution: 'corpus',
      outcome: 'fixed',
      excludeStatus: 'dismissed',
      fingerprint: 'fp_9',
      cursor: 'c_1',
    });
    expect(PLANNER_FINDINGS_PAGE_SIZE).toBe(50);
    expect(dto.nextCursor).toBeNull();
    expect(dto.retention).toEqual({ days: 90, cutoff: '2026-08-08T00:00:00.000Z' });
  });

  it('adds no key for an absent filter', async () => {
    await plannerFindingsService.list(SUPPORT, {});
    expect(lastQuery(client.listPlannerFindings)).toEqual({
      limit: 50,
      excludeStatus: 'dismissed',
    });
  });

  it.each(['new', 'promoted_to_lesson', 'filed_as_bug', 'dismissed'])(
    'a named status %s is sent as that status, with no exclusion',
    async (status) => {
      await plannerFindingsService.list(SUPPORT, { status });
      expect(lastQuery(client.listPlannerFindings)).toEqual({ limit: 50, status });
    },
  );

  it("'all' sends neither a status nor an exclusion", async () => {
    await plannerFindingsService.list(SUPPORT, { status: 'all' });
    expect(lastQuery(client.listPlannerFindings)).toEqual({ limit: 50 });
  });

  it('drops a value outside its closed set rather than sending it', async () => {
    await plannerFindingsService.list(SUPPORT, {
      source: 'bogus',
      planner: 'x',
      attribution: 'y',
      outcome: 'z',
      status: 'archived',
    });
    expect(lastQuery(client.listPlannerFindings)).toEqual({ limit: 50 });
  });

  it('passes one answer’s nextCursor back as the next cursor', async () => {
    client.listPlannerFindings.mockResolvedValueOnce(page([finding()], 'c_2'));
    const first = await plannerFindingsService.list(SUPPORT, {});
    await plannerFindingsService.list(SUPPORT, { cursor: first.nextCursor ?? undefined });
    expect(lastQuery(client.listPlannerFindings).cursor).toBe('c_2');
  });

  it('lists a finding whose plan exists nowhere else, with its stored title and id', async () => {
    const dto = await plannerFindingsService.list(SUPPORT, {});
    expect(dto.findings[0]).toMatchObject({
      planId: 'plan_gone_forever',
      planTitle: 'A plan nobody kept',
    });
  });

  it('lets an unavailable motir-ai through, never an empty page', async () => {
    client.listPlannerFindings.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    await expect(plannerFindingsService.list(SUPPORT, {})).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('listGroups and getGroup', () => {
  const groups: RawPlannerFindingGroupPage = {
    groups: [
      { fingerprint: 'fp_1', count: 3, planIds: ['p1', 'p2', 'p1'], latest: finding() },
      { fingerprint: 'fp_2', count: 1, planIds: ['p3'], latest: finding({ fingerprint: 'fp_2' }) },
    ],
    nextCursor: null,
    retention: { days: 90, cutoff: null },
  };

  it('maps the filters as list does and answers one row per fingerprint', async () => {
    client.listPlannerFindingGroups.mockResolvedValueOnce(groups);
    const dto = await plannerFindingsService.listGroups(SUPPORT, { outcome: 'reported' });
    expect(lastQuery(client.listPlannerFindingGroups)).toEqual({
      limit: 50,
      outcome: 'reported',
      excludeStatus: 'dismissed',
    });
    expect(dto.groups.map((g) => [g.fingerprint, g.findingCount, g.planCount])).toEqual([
      ['fp_1', 3, 2],
      ['fp_2', 1, 1],
    ]);
  });

  it.each([
    [{ status: 'all' }, { limit: 50 }],
    [{ status: 'dismissed' }, { limit: 50, status: 'dismissed' }],
  ])('applies the status form %j to the grouped read', async (filters, query) => {
    await plannerFindingsService.listGroups(SUPPORT, filters);
    expect(lastQuery(client.listPlannerFindingGroups)).toEqual(query);
  });

  it('getGroup reads the one fingerprint under the same filters', async () => {
    client.listPlannerFindingGroups.mockResolvedValueOnce({
      ...groups,
      groups: [groups.groups[0]!],
    });
    const row = await plannerFindingsService.getGroup(SUPPORT, 'fp_1', {
      planner: 'hosted',
      cursor: 'ignored',
    });
    expect(lastQuery(client.listPlannerFindingGroups)).toEqual({
      limit: 50,
      planner: 'hosted',
      excludeStatus: 'dismissed',
      fingerprint: 'fp_1',
    });
    expect(row).toMatchObject({ fingerprint: 'fp_1', findingCount: 3, planCount: 2 });
  });

  it('an unknown fingerprint is null, not an error', async () => {
    await expect(plannerFindingsService.getGroup(SUPPORT, 'fp_none', {})).resolves.toBeNull();
  });

  it('lets an unavailable motir-ai through on both reads', async () => {
    client.listPlannerFindingGroups.mockRejectedValue(new MotirAiUnavailableError('down'));
    await expect(plannerFindingsService.listGroups(SUPPORT, {})).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
    await expect(plannerFindingsService.getGroup(SUPPORT, 'fp_1', {})).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('listGroupFindings', () => {
  it('reads the list under the fingerprint with the same default and the cursor', async () => {
    const dto = await plannerFindingsService.listGroupFindings(SUPPORT, 'fp_1', {
      cursor: 'c_3',
    });
    expect(lastQuery(client.listPlannerFindings)).toEqual({
      limit: 50,
      excludeStatus: 'dismissed',
      fingerprint: 'fp_1',
      cursor: 'c_3',
    });
    expect(dto.findings[0]).toMatchObject({ planId: 'plan_gone_forever' });
  });

  it('lets an unavailable motir-ai through', async () => {
    client.listPlannerFindings.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    await expect(
      plannerFindingsService.listGroupFindings(SUPPORT, 'fp_1', {}),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('get', () => {
  const LINES = [
    {
      stage: 'review',
      model: 'model-a',
      inputTokens: 1000,
      outputTokens: 200,
      sessions: 2,
      costMicroUsd: 4200,
    },
    {
      stage: 'repair',
      model: 'model-b',
      inputTokens: 500,
      outputTokens: 50,
      sessions: 1,
      costMicroUsd: null,
    },
  ];

  it('answers the detail with the plan cost: lines copied, null price kept, counts read', async () => {
    client.getPlannerFinding.mockResolvedValueOnce(finding());
    client.getJob.mockResolvedValueOnce(
      job({
        stageUsage: [...LINES, { stage: 'plan', inputTokens: 1, outputTokens: 1, sessions: 1 }],
        dryRun: {
          outcome: 'ran',
          counts: { findingsAccepted: 4, fixed: 3, reported: 1, fixFailed: 0 },
        },
      }),
    );
    const view = await plannerFindingsService.get(SUPPORT, 'pf_1');
    expect(client.getJob).toHaveBeenCalledWith('job_1', 'pj_1');
    expect(view.detail.cost).toEqual({ findingsMade: 4, findingsFixed: 3, lines: LINES });
    expect(view.detail).toMatchObject({
      planId: 'plan_gone_forever',
      planTitle: 'A plan nobody kept',
    });
  });

  it('keeps a missing count null rather than zero', async () => {
    client.getPlannerFinding.mockResolvedValueOnce(finding());
    client.getJob.mockResolvedValueOnce(job({ stageUsage: [LINES[0]] }));
    const view = await plannerFindingsService.get(SUPPORT, 'pf_1');
    expect(view.detail.cost).toEqual({
      findingsMade: null,
      findingsFixed: null,
      lines: [LINES[0]],
    });
  });

  it('a finding with no job has no cost, and no job is read', async () => {
    const view = await plannerFindingsService.get(SUPPORT, 'pf_1');
    expect(client.getJob).not.toHaveBeenCalled();
    expect(view.detail.cost).toBeNull();
  });

  it.each([
    ['an empty stageUsage', { stageUsage: [] }],
    ['an absent stageUsage', { dryRun: { counts: { findingsAccepted: 1, fixed: 1 } } }],
    ['only malformed lines', { stageUsage: [{ stage: 'review', inputTokens: 'x' }, null] }],
    ['no result at all', null],
  ])('%s gives a null cost', async (_name, result) => {
    client.getPlannerFinding.mockResolvedValueOnce(finding());
    client.getJob.mockResolvedValueOnce(job(result));
    expect((await plannerFindingsService.get(SUPPORT, 'pf_1')).detail.cost).toBeNull();
  });

  it('a job read that fails hides the cost, keeps the finding and logs data only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.getPlannerFinding.mockResolvedValueOnce(finding());
    client.getJob.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    const view = await plannerFindingsService.get(SUPPORT, 'pf_1');
    expect(view.detail.cost).toBeNull();
    expect(view.detail.id).toBe('pf_1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toEqual({ jobId: 'job_1', error: 'MotirAiUnavailableError' });
    warn.mockRestore();
  });

  it('names who last triaged it with one lookup', async () => {
    client.getPlannerFinding.mockResolvedValueOnce(
      finding({ jobId: null, triagedBy: 'u_1', triagedAt: '2026-11-02T00:00:00.000Z' }),
    );
    users.findByIds.mockResolvedValueOnce([{ id: 'u_1', name: 'Ops Support' }]);
    const view = await plannerFindingsService.get(SUPPORT, 'pf_1');
    expect(users.findByIds).toHaveBeenCalledTimes(1);
    expect(users.findByIds).toHaveBeenCalledWith(['u_1']);
    expect(view.triagedByName).toBe('Ops Support');
  });

  it('an untriaged finding makes no lookup; a gone user reads null', async () => {
    expect((await plannerFindingsService.get(SUPPORT, 'pf_1')).triagedByName).toBeNull();
    expect(users.findByIds).not.toHaveBeenCalled();
    client.getPlannerFinding.mockResolvedValueOnce(finding({ jobId: null, triagedBy: 'u_gone' }));
    expect((await plannerFindingsService.get(SUPPORT, 'pf_1')).triagedByName).toBeNull();
  });

  it.each([
    ['not found', new PlannerFindingNotFoundError('pf_x')],
    ['unavailable', new MotirAiUnavailableError('down')],
  ])('rethrows a %s finding read unchanged', async (_name, error) => {
    client.getPlannerFinding.mockRejectedValueOnce(error);
    await expect(plannerFindingsService.get(SUPPORT, 'pf_x')).rejects.toBe(error);
  });
});
