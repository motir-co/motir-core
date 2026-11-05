import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreatePlannerFindingRequest, RawPlannerFinding } from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';

// THE PLANNER-FINDINGS SERVICE (Subtask MOTIR-10386 · Story MOTIR-10354) —
// `plannerFindingsService.recordFinding`, with its four collaborators mocked at
// their module seams (the shape `tests/ai/lessonSearchSeam.test.ts` uses). The
// real-database path through the same service is the integration test
// (`tests/integration/recordPlannerFinding.test.ts`, MOTIR-10390).
//
// What a happy-path assertion would miss, and so what this file pins:
//   1. The gate is `ai:plan` — the `assertPermission` mock resolves ONLY for that
//      key, so a service asserting a lesson key fails here.
//   2. The gate runs BEFORE any work: asserted as the later mocks' CALL COUNTS.
//   3. A blank optional is ABSENT from the request, never `''` or `null`.
//   4. A failed write propagates as the same instance after ONE call.

const getByKey = vi.fn();
const assertPermission = vi.fn();
const resolveTenantOrg = vi.fn();
const createPlannerFinding = vi.fn();

vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { getByKey: (...args: unknown[]) => getByKey(...args) },
}));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: {
    assertPermission: (...args: unknown[]) => assertPermission(...args),
  },
}));
vi.mock('@/lib/ai/tenantOrg', () => ({
  resolveTenantOrg: (...args: unknown[]) => resolveTenantOrg(...args),
}));
vi.mock('@/lib/ai/motirAiClient', () => ({
  createPlannerFinding: (...args: unknown[]) => createPlannerFinding(...args),
}));

const { plannerFindingsService, RECORD_PLANNER_FINDING_PERMISSION, PLANNER_FINDING_NO_PLAN_ID } =
  await import('@/lib/services/plannerFindingsService');
type RecordPlannerFindingInput =
  import('@/lib/services/plannerFindingsService').RecordPlannerFindingInput;
const { PermissionDeniedError, ProjectNotFoundError } = await import('@/lib/projects/errors');

const ctx = { userId: 'user_1', workspaceId: 'ws_1' };
const PROJECT = { id: 'pj_1', identifier: 'MOTIR' };

const REQUIRED: RecordPlannerFindingInput = {
  planner: 'plan_py',
  site: 'MOTIR-12 criterion 3',
  prediction: 'STOPS',
  whatHappened: 'The runner would stop at the criterion.',
  evidence: 'lib/runner/rules.ts:42 at 4af7d93',
  outcome: 'reported',
};

const FORBIDDEN = [
  'source',
  'status',
  'fingerprint',
  'rule',
  'jobId',
  'lessonId',
  'bugKey',
  'aiProjectId',
  'baseline',
] as const;

function storedRow(over: Partial<RawPlannerFinding> = {}): RawPlannerFinding {
  return {
    id: 'pf_1',
    source: 'check_plan',
    planner: 'plan_py',
    site: REQUIRED.site,
    fingerprint: 'fp_1',
    status: 'new',
    planId: 'plan_1',
    ...over,
  };
}

function sent(): CreatePlannerFindingRequest {
  expect(createPlannerFinding).toHaveBeenCalledTimes(1);
  return createPlannerFinding.mock.calls[0]![0] as CreatePlannerFindingRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getByKey.mockResolvedValue(PROJECT);
  // Resolves ONLY for `ai:plan`: a service asserting `lesson:manage` or
  // `lesson:reinforce` is refused, as a plain member without them would be.
  assertPermission.mockImplementation(async (_projectId: string, _ctx: unknown, key: string) => {
    if (key !== 'ai:plan') throw new PermissionDeniedError(PROJECT.id, key as never);
  });
  resolveTenantOrg.mockResolvedValue({
    organizationId: 'org_1',
    isMeta: false,
    internalBilling: false,
  });
  createPlannerFinding.mockResolvedValue(storedRow());
});

describe('recordFinding — project resolution and the gate', () => {
  it('resolves the trimmed, upper-cased key and asserts ai:plan on that project', async () => {
    await plannerFindingsService.recordFinding('  motir ', ctx, REQUIRED);

    expect(getByKey).toHaveBeenCalledWith('MOTIR', ctx);
    expect(assertPermission).toHaveBeenCalledTimes(1);
    expect(assertPermission).toHaveBeenCalledWith(PROJECT.id, ctx, 'ai:plan');
    expect(RECORD_PLANNER_FINDING_PERMISSION).toBe('ai:plan');
  });

  it('lets a caller who holds ai:plan but no lesson key record a finding', async () => {
    const result = await plannerFindingsService.recordFinding('MOTIR', ctx, REQUIRED);

    expect(result.id).toBe('pf_1');
    for (const call of assertPermission.mock.calls) {
      expect(call[2]).not.toMatch(/^lesson:/);
    }
  });

  it('rethrows a permission refusal and does no upstream work at all', async () => {
    const denied = new PermissionDeniedError(PROJECT.id, 'ai:plan');
    assertPermission.mockRejectedValue(denied);

    await expect(plannerFindingsService.recordFinding('MOTIR', ctx, REQUIRED)).rejects.toBe(denied);
    expect(resolveTenantOrg).toHaveBeenCalledTimes(0);
    expect(createPlannerFinding).toHaveBeenCalledTimes(0);
  });

  it('surfaces the not-found error getByKey raises, unchanged, and sends nothing', async () => {
    const missing = new ProjectNotFoundError('NOPE');
    getByKey.mockRejectedValue(missing);

    await expect(plannerFindingsService.recordFinding('nope', ctx, REQUIRED)).rejects.toBe(missing);
    expect(assertPermission).toHaveBeenCalledTimes(0);
    expect(resolveTenantOrg).toHaveBeenCalledTimes(0);
    expect(createPlannerFinding).toHaveBeenCalledTimes(0);
  });
});

describe('recordFinding — the request it builds', () => {
  it('carries the identity from the org read, the context and the RESOLVED project', async () => {
    await plannerFindingsService.recordFinding('MOTIR', ctx, REQUIRED);

    expect(resolveTenantOrg).toHaveBeenCalledWith({ userId: 'user_1', workspaceId: 'ws_1' });
    expect(sent()).toMatchObject({
      coreOrganizationId: 'org_1',
      coreWorkspaceId: 'ws_1',
      coreProjectId: PROJECT.id,
      source: 'check_plan',
    });
  });

  it('never forwards identity, source or store-owned members placed on the input', async () => {
    const polluted = {
      ...REQUIRED,
      coreProjectId: 'pj_other',
      coreWorkspaceId: 'ws_other',
      coreOrganizationId: 'org_other',
      source: 'in_loop',
      status: 'dismissed',
      fingerprint: 'x',
      rule: 'x',
      jobId: 'x',
      lessonId: 'x',
      bugKey: 'x',
      aiProjectId: 'x',
    } as unknown as RecordPlannerFindingInput;

    await plannerFindingsService.recordFinding('MOTIR', ctx, polluted);

    const req = sent() as unknown as Record<string, unknown>;
    expect(req['coreProjectId']).toBe(PROJECT.id);
    expect(req['coreWorkspaceId']).toBe('ws_1');
    expect(req['coreOrganizationId']).toBe('org_1');
    expect(req['source']).toBe('check_plan');
    for (const key of FORBIDDEN.filter((k) => k !== 'source')) {
      expect(req).not.toHaveProperty(key);
    }
  });

  it('sends the exact required set when nothing optional is given', async () => {
    await plannerFindingsService.recordFinding('MOTIR', ctx, REQUIRED);

    expect(sent()).toEqual({
      coreOrganizationId: 'org_1',
      coreWorkspaceId: 'ws_1',
      coreProjectId: PROJECT.id,
      planId: PLANNER_FINDING_NO_PLAN_ID,
      source: 'check_plan',
      ...REQUIRED,
    });
  });

  it.each([
    ['absent', undefined],
    ['blank', '   '],
    ['empty', ''],
  ])('fills planId with the marker when it is %s', async (_label, planId) => {
    await plannerFindingsService.recordFinding('MOTIR', ctx, { ...REQUIRED, planId });

    expect(PLANNER_FINDING_NO_PLAN_ID.trim()).not.toBe('');
    expect(sent().planId).toBe(PLANNER_FINDING_NO_PLAN_ID);
  });

  it('forwards a planId core never stored, as text, with no plan lookup', async () => {
    await plannerFindingsService.recordFinding('MOTIR', ctx, {
      ...REQUIRED,
      planId: ' plan_never_existed ',
    });

    expect(sent().planId).toBe('plan_never_existed');
    // The only collaborator reads are the four seams; none of them is a plan read.
    expect(getByKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { branch: 'main', commit: 'abc123' },
      { baselineBranch: 'main', baselineCommit: 'abc123' },
    ],
    [{ branch: 'main' }, { baselineBranch: 'main' }],
    [{ commit: 'abc123' }, { baselineCommit: 'abc123' }],
    [{ branch: '  ', commit: '' }, {}],
    [undefined, {}],
  ] as [
    RecordPlannerFindingInput['baseline'],
    { baselineBranch?: string; baselineCommit?: string },
  ][])('splits baseline %j into the two store fields', async (baseline, expected) => {
    await plannerFindingsService.recordFinding('MOTIR', ctx, { ...REQUIRED, baseline });

    const req = sent() as unknown as Record<string, unknown>;
    expect(req).not.toHaveProperty('baseline');
    expect(req['baselineBranch']).toBe(expected.baselineBranch);
    expect(req['baselineCommit']).toBe(expected.baselineCommit);
    if (!('baselineBranch' in expected)) expect(req).not.toHaveProperty('baselineBranch');
    if (!('baselineCommit' in expected)) expect(req).not.toHaveProperty('baselineCommit');
  });

  it('trims every optional text field and forwards attribution unchanged', async () => {
    await plannerFindingsService.recordFinding('MOTIR', ctx, {
      ...REQUIRED,
      planTitle: ' Plan ',
      cardRef: ' MOTIR-12 ',
      authorModel: ' model-x ',
      authorSessionKey: ' s1 ',
      correction: ' Split it. ',
      why: ' The pack is silent. ',
      hostedCell: ' author/criteria ',
      planpyCell: ' author:subtask ',
      fixDirection: ' Add a rule. ',
      attribution: 'corpus',
    });

    expect(sent()).toMatchObject({
      planTitle: 'Plan',
      cardRef: 'MOTIR-12',
      authorModel: 'model-x',
      authorSessionKey: 's1',
      correction: 'Split it.',
      why: 'The pack is silent.',
      hostedCell: 'author/criteria',
      planpyCell: 'author:subtask',
      fixDirection: 'Add a rule.',
      attribution: 'corpus',
    });
  });

  it('leaves every blank or omitted optional ABSENT — never empty, never null', async () => {
    const blanks = {
      planTitle: '  ',
      cardRef: '',
      authorModel: ' ',
      authorSessionKey: '\t',
      correction: '',
      why: '  ',
      hostedCell: '',
      planpyCell: ' ',
      fixDirection: '',
    };

    await plannerFindingsService.recordFinding('MOTIR', ctx, { ...REQUIRED, ...blanks });

    const req = sent() as unknown as Record<string, unknown>;
    for (const key of [...Object.keys(blanks), 'attribution']) {
      expect(req).not.toHaveProperty(key);
    }
    expect(Object.values(req)).not.toContain(null);
    expect(Object.values(req)).not.toContain('');
  });

  it('trims the required text and passes the closed values through', async () => {
    await plannerFindingsService.recordFinding('MOTIR', ctx, {
      planner: 'hosted',
      site: ' site ',
      prediction: 'THRU',
      whatHappened: ' happened ',
      evidence: ' evidence ',
      outcome: 'fix_failed',
    });

    expect(sent()).toMatchObject({
      planner: 'hosted',
      site: 'site',
      prediction: 'THRU',
      whatHappened: 'happened',
      evidence: 'evidence',
      outcome: 'fix_failed',
    });
  });
});

describe('recordFinding — the answer', () => {
  it('returns id, source, fingerprint and status from the stored row, after ONE call', async () => {
    createPlannerFinding.mockResolvedValue(
      storedRow({ id: 'pf_9', fingerprint: 'fp_9', planner: 'hosted' }),
    );

    const result = await plannerFindingsService.recordFinding('MOTIR', ctx, REQUIRED);

    expect(result).toEqual({
      id: 'pf_9',
      source: 'check_plan',
      fingerprint: 'fp_9',
      status: 'new',
    });
    expect(createPlannerFinding).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['MotirAiBadRequestError', new MotirAiBadRequestError("'prediction' must be one of", 400)],
    ['MotirAiUnauthorizedError', new MotirAiUnauthorizedError('service token refused')],
    ['MotirAiUnavailableError', new MotirAiUnavailableError('store is down')],
    ['MotirAiConfigError', new MotirAiConfigError('MOTIR_AI_URL is not set')],
  ])('propagates %s as the same instance, after ONE call', async (_name, error) => {
    createPlannerFinding.mockRejectedValue(error);

    await expect(plannerFindingsService.recordFinding('MOTIR', ctx, REQUIRED)).rejects.toBe(error);
    expect(createPlannerFinding).toHaveBeenCalledTimes(1);
  });
});
