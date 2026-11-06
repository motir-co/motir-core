import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getJob,
  getPlannerFinding,
  listPlannerFindingGroups,
  listPlannerFindings,
  PLANNER_FINDING_ATTRIBUTIONS,
  PLANNER_FINDING_OUTCOMES,
  PLANNER_FINDING_PLANNERS,
  PLANNER_FINDING_PREDICTIONS,
  PLANNER_FINDING_SOURCES,
  PLANNER_FINDING_STATUSES,
  triagePlannerFinding,
  type RawPlannerFinding,
} from '@/lib/ai/motirAiClient';
import {
  MotirAiUnavailableError,
  MotirAiBadRequestError,
  PlannerFindingNotFoundError,
} from '@/lib/ai/errors';

// MOTIR-10516 — the planner-findings console's transport: the four admin calls
// to motir-ai's `/v1/admin/planner-findings` routes, and the dry-run usage
// lines typed on the job result envelope. Every malformed 200 is an outage,
// never an empty list.

const FINDING: RawPlannerFinding = {
  id: 'pf_1',
  coreOrganizationId: 'org_1',
  coreWorkspaceId: 'ws_1',
  coreProjectId: 'pj_1',
  aiProjectId: 'aip_1',
  planId: 'plan_1',
  jobId: 'job_1',
  planTitle: 'Plan one',
  cardRef: 'MOTIR-12',
  source: 'in_loop',
  planner: 'hosted',
  authorModel: null,
  authorSessionKey: null,
  baselineBranch: null,
  baselineCommit: null,
  site: 'acceptance criterion 2',
  prediction: 'STOPS',
  whatHappened: 'The criterion reads the deployment.',
  evidence: 'criterion 2: "verify on the live tenant"',
  correction: null,
  outcome: 'reported',
  rule: 'Split at the deploy boundary',
  attribution: null,
  why: null,
  hostedCell: null,
  planpyCell: null,
  fixDirection: null,
  fingerprint: 'f'.repeat(64),
  status: 'new',
  lessonId: null,
  bugKey: null,
  triageNote: null,
  triagedBy: null,
  triagedAt: null,
  createdAt: '2026-11-06T12:00:00.000Z',
  updatedAt: '2026-11-06T12:00:00.000Z',
};

const RETENTION = { days: 90, cutoff: '2026-08-08T12:00:00.000Z' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function problem(code: string, status: number): Response {
  return json({ type: 'about:blank', code, title: code, status, detail: code }, status);
}

function stub(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof vi.fn>, n = 0): [string, RequestInit] {
  return fetchMock.mock.calls[n] as unknown as [string, RequestInit];
}

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the closed value sets', () => {
  it('hold exactly the members of motir-ai’s enums', () => {
    expect(PLANNER_FINDING_SOURCES).toEqual(['in_loop', 'check_plan']);
    expect(PLANNER_FINDING_PLANNERS).toEqual(['hosted', 'plan_py']);
    expect(PLANNER_FINDING_PREDICTIONS).toEqual(['STOPS', 'SETTLES', 'THRU']);
    expect(PLANNER_FINDING_OUTCOMES).toEqual(['fixed', 'reported', 'fix_failed']);
    expect(PLANNER_FINDING_ATTRIBUTIONS).toEqual(['code', 'corpus', 'model', 'unattributed']);
    expect(PLANNER_FINDING_STATUSES).toEqual([
      'new',
      'promoted_to_lesson',
      'filed_as_bug',
      'dismissed',
    ]);
  });
});

describe('listPlannerFindings', () => {
  it('GETs the list with the service credential and no query when given no filter', async () => {
    const fetchMock = stub(json({ findings: [FINDING], nextCursor: null, retention: RETENTION }));
    expect(await listPlannerFindings()).toEqual({
      findings: [FINDING],
      nextCursor: null,
      retention: RETENTION,
    });
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://ai.test/v1/admin/planner-findings');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
  });

  it('puts exactly the filters it is given on the query string', async () => {
    const fetchMock = stub(json({ findings: [], nextCursor: null, retention: RETENTION }));
    await listPlannerFindings({
      planner: 'hosted',
      source: 'in_loop',
      site: 'criterion 2',
      prediction: 'THRU',
      outcome: 'fixed',
      attribution: 'corpus',
      status: 'new',
      excludeStatus: 'dismissed',
      fingerprint: 'fp_1',
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
      cursor: 'pf_9',
      limit: 25,
    });
    const url = new URL(call(fetchMock)[0]);
    expect(url.pathname).toBe('/v1/admin/planner-findings');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      planner: 'hosted',
      source: 'in_loop',
      site: 'criterion 2',
      prediction: 'THRU',
      outcome: 'fixed',
      attribution: 'corpus',
      status: 'new',
      excludeStatus: 'dismissed',
      fingerprint: 'fp_1',
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
      cursor: 'pf_9',
      limit: '25',
    });
  });

  it('sends no empty-string parameter', async () => {
    const fetchMock = stub(json({ findings: [], nextCursor: null, retention: RETENTION }));
    await listPlannerFindings({ site: '', fingerprint: '', excludeStatus: 'dismissed' });
    expect(call(fetchMock)[0]).toBe(
      'https://ai.test/v1/admin/planner-findings?excludeStatus=dismissed',
    );
  });

  it('pages by handing back the nextCursor it answered', async () => {
    const fetchMock = stub(
      json({ findings: [FINDING], nextCursor: 'pf_1', retention: RETENTION }),
      json({ findings: [], nextCursor: null, retention: RETENTION }),
    );
    const first = await listPlannerFindings({ limit: 1 });
    const second = await listPlannerFindings({ limit: 1, cursor: first.nextCursor ?? undefined });
    expect(new URL(call(fetchMock, 1)[0]).searchParams.get('cursor')).toBe('pf_1');
    expect(second.nextCursor).toBeNull();
  });

  it('reads a missing nextCursor as null and a missing retention as no window', async () => {
    stub(json({ findings: [FINDING] }));
    expect(await listPlannerFindings()).toEqual({
      findings: [FINDING],
      nextCursor: null,
      retention: { days: 0, cutoff: null },
    });
  });

  it('reads a retention with no cutoff string as cutoff null', async () => {
    stub(json({ findings: [], retention: { days: 30, cutoff: 7 } }));
    expect((await listPlannerFindings()).retention).toEqual({ days: 30, cutoff: null });
  });

  it.each([
    ['no findings array', { nextCursor: null }],
    ['a findings object', { findings: {} }],
    ['a null body', null],
  ])('throws unavailable on a 200 with %s', async (_label, body) => {
    stub(json(body));
    await expect(listPlannerFindings()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('throws unavailable on a 200 that is not JSON', async () => {
    stub(new Response('not json', { status: 200 }));
    await expect(listPlannerFindings()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('maps a non-2xx through the shared problem path', async () => {
    stub(problem('validation_error', 400));
    await expect(listPlannerFindings({ planner: 'hosted' })).rejects.toBeInstanceOf(
      MotirAiBadRequestError,
    );
  });
});

describe('listPlannerFindingGroups', () => {
  const GROUP = { fingerprint: 'fp_1', count: 2, planIds: ['plan_1', 'plan_2'], latest: FINDING };

  it('GETs the grouped list with the same filters and answers the groups', async () => {
    const fetchMock = stub(json({ groups: [GROUP], nextCursor: 'cur', retention: RETENTION }));
    expect(
      await listPlannerFindingGroups({ fingerprint: 'fp_1', excludeStatus: 'dismissed' }),
    ).toEqual({ groups: [GROUP], nextCursor: 'cur', retention: RETENTION });
    const [url, init] = call(fetchMock);
    expect(url).toBe(
      'https://ai.test/v1/admin/planner-findings/groups?excludeStatus=dismissed&fingerprint=fp_1',
    );
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
  });

  it('sends no query when given no filter, and fills the missing page members', async () => {
    const fetchMock = stub(json({ groups: [] }));
    expect(await listPlannerFindingGroups()).toEqual({
      groups: [],
      nextCursor: null,
      retention: { days: 0, cutoff: null },
    });
    expect(call(fetchMock)[0]).toBe('https://ai.test/v1/admin/planner-findings/groups');
  });

  it('throws unavailable on a 200 with no groups array', async () => {
    stub(json({ findings: [] }));
    await expect(listPlannerFindingGroups()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('maps a non-2xx through the shared problem path', async () => {
    stub(problem('validation_error', 400));
    await expect(listPlannerFindingGroups()).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });
});

describe('getPlannerFinding', () => {
  it('GETs one finding by its URL-encoded id', async () => {
    const fetchMock = stub(json(FINDING));
    expect(await getPlannerFinding('pf/1')).toEqual(FINDING);
    expect(call(fetchMock)[0]).toBe('https://ai.test/v1/admin/planner-findings/pf%2F1');
  });

  it('throws PlannerFindingNotFoundError on not_found', async () => {
    stub(problem('not_found', 404));
    const err = await getPlannerFinding('pf_missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerFindingNotFoundError);
    expect((err as PlannerFindingNotFoundError).findingId).toBe('pf_missing');
  });

  it('maps any other problem through the shared path', async () => {
    stub(problem('validation_error', 400));
    await expect(getPlannerFinding('pf_1')).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });

  it('throws unavailable on a 200 with no id string', async () => {
    stub(json({ ...FINDING, id: 7 }));
    await expect(getPlannerFinding('pf_1')).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('triagePlannerFinding', () => {
  const AUDIT = {
    action: 'ai.planner_finding.triage',
    findingId: 'pf_1',
    actorCoreUserId: 'user_1',
    at: '2026-11-06T12:30:00.000Z',
    before: { attribution: null },
    after: { attribution: 'corpus' },
  };

  async function sentBody(
    patch: Parameters<typeof triagePlannerFinding>[1],
  ): Promise<Record<string, unknown>> {
    const fetchMock = stub(json({ finding: FINDING, audit: AUDIT }));
    await triagePlannerFinding('pf_1', patch, 'user_1');
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://ai.test/v1/admin/planner-findings/pf_1');
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('sends an attribution change with the actor and nothing else', async () => {
    expect(await sentBody({ attribution: 'corpus' })).toEqual({
      attribution: 'corpus',
      actorCoreUserId: 'user_1',
    });
  });

  it('sends a promote with its lesson id', async () => {
    expect(await sentBody({ status: 'promoted_to_lesson', lessonId: 'lsn_1' })).toEqual({
      status: 'promoted_to_lesson',
      lessonId: 'lsn_1',
      actorCoreUserId: 'user_1',
    });
  });

  it('sends a bug record with its key', async () => {
    expect(await sentBody({ status: 'filed_as_bug', bugKey: 'MOTIR-99' })).toEqual({
      status: 'filed_as_bug',
      bugKey: 'MOTIR-99',
      actorCoreUserId: 'user_1',
    });
  });

  it('sends a dismiss with its note, and a restore', async () => {
    expect(await sentBody({ status: 'dismissed', note: 'Not a planner defect' })).toEqual({
      status: 'dismissed',
      note: 'Not a planner defect',
      actorCoreUserId: 'user_1',
    });
    expect(await sentBody({ status: 'new' })).toEqual({ status: 'new', actorCoreUserId: 'user_1' });
  });

  it('sends the text fields it is given', async () => {
    expect(
      await sentBody({
        why: 'w',
        hostedCell: 'h',
        planpyCell: 'p',
        fixDirection: 'f',
      }),
    ).toEqual({
      why: 'w',
      hostedCell: 'h',
      planpyCell: 'p',
      fixDirection: 'f',
      actorCoreUserId: 'user_1',
    });
  });

  it('answers the finding and the audit record, and audit null when nothing changed', async () => {
    stub(json({ finding: FINDING, audit: AUDIT }), json({ finding: FINDING, audit: null }));
    expect(await triagePlannerFinding('pf_1', { attribution: 'corpus' }, 'user_1')).toEqual({
      finding: FINDING,
      audit: AUDIT,
    });
    expect(await triagePlannerFinding('pf_1', { attribution: 'corpus' }, 'user_1')).toEqual({
      finding: FINDING,
      audit: null,
    });
  });

  it('throws PlannerFindingNotFoundError on not_found', async () => {
    stub(problem('not_found', 404));
    await expect(
      triagePlannerFinding('pf_missing', { status: 'new' }, 'user_1'),
    ).rejects.toBeInstanceOf(PlannerFindingNotFoundError);
  });

  it('maps a validation problem through the shared path', async () => {
    stub(problem('validation_error', 400));
    await expect(
      triagePlannerFinding('pf_1', { status: 'promoted_to_lesson' }, 'user_1'),
    ).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });

  it.each([
    ['no finding', { audit: null }],
    ['a finding with no id', { finding: { site: 'x' }, audit: null }],
    ['a null finding', { finding: null, audit: null }],
    ['no audit key', { finding: FINDING }],
    ['a null body', null],
  ])('throws unavailable on a 200 with %s', async (_label, body) => {
    stub(json(body));
    await expect(triagePlannerFinding('pf_1', { status: 'new' }, 'user_1')).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('getJob and the dry-run usage lines', () => {
  const STAGE_USAGE = [
    {
      stage: 'review',
      model: 'claude-sonnet-5-5',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      sessions: 3,
      costMicroUsd: 12_000,
    },
    {
      stage: 'repair',
      model: 'claude-sonnet-5-5',
      inputTokens: 400,
      outputTokens: 90,
      sessions: 1,
      costMicroUsd: null,
    },
  ];

  function jobBody(result: Record<string, unknown>) {
    return {
      jobId: 'job_1',
      kind: 'plan_from_scratch',
      status: 'succeeded',
      result: {
        envelopeVersion: 1,
        jobKind: 'plan_from_scratch',
        summary: 's',
        usage: { model: null, inputTokens: 0, outputTokens: 0 },
        ...result,
      },
    };
  }

  it('hands stageUsage and dryRun.counts through on the result', async () => {
    stub(
      json(
        jobBody({
          stageUsage: STAGE_USAGE,
          dryRun: {
            outcome: 'ran',
            counts: { findingsAccepted: 4, fixed: 3, reported: 1, fixFailed: 0 },
          },
        }),
      ),
    );
    const job = await getJob('job_1', 'pj_1');
    expect(job.result?.stageUsage).toEqual(STAGE_USAGE);
    expect(job.result?.dryRun?.counts.fixed).toBe(3);
    expect(job.result?.dryRun?.outcome).toBe('ran');
  });

  it('leaves stageUsage undefined, not empty, when the envelope carries none', async () => {
    stub(json(jobBody({})));
    const job = await getJob('job_1', 'pj_1');
    expect(job.result).not.toBeNull();
    expect(job.result?.stageUsage).toBeUndefined();
    expect(job.result?.dryRun).toBeUndefined();
  });
});
