import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPlannerFindingBugKey,
  createPlannerFindingRecord,
  getPlannerFindingRecord,
  listPlannerFindingRecords,
  PLANNER_FINDING_RUN_THROUGH_ANSWERS,
  PLANNER_FINDING_VERDICT_STATES,
  setPlannerFindingBugKey,
  submitPlannerFindingRecordVerdict,
  type RawPlannerFindingRecord,
} from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiConflictError,
  MotirAiUnavailableError,
  PlannerFindingNotFoundError,
  PlannerFindingRecordNotFoundError,
} from '@/lib/ai/errors';

// MOTIR-11458 — the transport for motir-ai's `/v1/admin/planner-finding-records`
// routes: what each call SENDS, and that every malformed 200 is an outage, never
// an empty list or a record without findings.

const RECORD: RawPlannerFindingRecord = {
  id: 'rec_1',
  source: 'check_plan',
  planner: 'hosted',
  coreOrganizationId: 'org_1',
  coreWorkspaceId: 'ws_1',
  coreProjectId: 'pj_1',
  aiProjectId: 'aip_1',
  planId: 'plan_1',
  planSessionId: 'sess_1',
  jobId: null,
  planTitle: 'Plan one',
  authorModel: null,
  baselineBranch: null,
  baselineCommit: null,
  verdictState: 'open',
  verdictBy: null,
  verdictAt: null,
  runThroughAnswer: null,
  runThroughStopCards: [],
  createdAt: '2026-11-16T12:00:00.000Z',
  updatedAt: '2026-11-16T12:00:00.000Z',
};

const RETENTION = { days: 90, cutoff: '2026-08-18T12:00:00.000Z' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function problem(code: string, status: number): Response {
  return json({ type: 'about:blank', code, title: code, status, detail: `${code} detail` }, status);
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

it('holds exactly the two values a run-through answer may take', () => {
  expect(PLANNER_FINDING_RUN_THROUGH_ANSWERS).toEqual(['STOPS', 'THRU']);
});

it('holds exactly the members of the verdict-state enum', () => {
  expect(PLANNER_FINDING_VERDICT_STATES).toEqual(['open', 'attributed']);
});

describe('listPlannerFindingRecords', () => {
  it('GETs the list with no query when given no filter', async () => {
    const page = {
      records: [{ ...RECORD, findingCount: 2, attributedCount: 1 }],
      nextCursor: 'c2',
    };
    const fetchMock = stub(json({ ...page, retention: RETENTION }));
    expect(await listPlannerFindingRecords()).toEqual({ ...page, retention: RETENTION });
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://ai.test/v1/admin/planner-finding-records');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
  });

  it('puts exactly the filters it is given on the query string, and reads a missing window as none', async () => {
    const fetchMock = stub(json({ records: [] }));
    expect(
      await listPlannerFindingRecords({
        verdictState: 'attributed',
        planner: 'plan_py',
        source: 'check_plan',
        planId: 'plan_1',
        createdFrom: '2026-11-01T00:00:00.000Z',
        createdTo: '',
        cursor: 'c1',
        limit: 25,
      }),
    ).toEqual({ records: [], nextCursor: null, retention: { days: 0, cutoff: null } });
    const params = new URL(call(fetchMock)[0]).searchParams;
    expect(Object.fromEntries(params.entries())).toEqual({
      verdictState: 'attributed',
      planner: 'plan_py',
      source: 'check_plan',
      planId: 'plan_1',
      createdFrom: '2026-11-01T00:00:00.000Z',
      cursor: 'c1',
      limit: '25',
    });
  });

  it('maps a validation problem, and reads a 200 without `records` as an outage', async () => {
    stub(problem('validation_error', 400));
    await expect(listPlannerFindingRecords()).rejects.toBeInstanceOf(MotirAiBadRequestError);
    stub(json({ findings: [] }));
    await expect(listPlannerFindingRecords()).rejects.toBeInstanceOf(MotirAiUnavailableError);
    stub(new Response('<html>', { status: 200 }));
    await expect(listPlannerFindingRecords()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('getPlannerFindingRecord', () => {
  it('answers the run-through pair exactly as motir-ai stored it, null included', async () => {
    const answered = { ...RECORD, runThroughAnswer: 'THRU' as const, runThroughStopCards: [] };
    stub(json({ record: answered, findings: [] }));
    expect((await getPlannerFindingRecord('rec_1')).record).toMatchObject({
      runThroughAnswer: 'THRU',
      runThroughStopCards: [],
    });
    stub(json({ record: RECORD, findings: [] }));
    expect((await getPlannerFindingRecord('rec_1')).record.runThroughAnswer).toBeNull();
  });

  it('GETs one record by its encoded id', async () => {
    const fetchMock = stub(json({ record: RECORD, findings: [] }));
    expect(await getPlannerFindingRecord('rec/1')).toEqual({ record: RECORD, findings: [] });
    expect(call(fetchMock)[0]).toBe('https://ai.test/v1/admin/planner-finding-records/rec%2F1');
  });

  it('maps not_found to its own class and anything else through the shared map', async () => {
    stub(problem('not_found', 404));
    const missing = await getPlannerFindingRecord('rec_x').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PlannerFindingRecordNotFoundError);
    expect((missing as PlannerFindingRecordNotFoundError).recordId).toBe('rec_x');
    stub(problem('validation_error', 400));
    await expect(getPlannerFindingRecord('rec_x')).rejects.toBeInstanceOf(MotirAiBadRequestError);
  });

  it.each([
    ['not JSON', new Response('<html>', { status: 200 })],
    ['no record', json({ findings: [] })],
    ['a record without an id', json({ record: {}, findings: [] })],
    ['a null record', json({ record: null, findings: [] })],
    ['no findings array', json({ record: RECORD })],
  ])('reads a 200 with %s as an outage', async (_n, res) => {
    stub(res);
    await expect(getPlannerFindingRecord('rec_1')).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('createPlannerFindingRecord', () => {
  const request = {
    record: {
      coreOrganizationId: 'org_1',
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      planId: 'plan_1',
      source: 'check_plan' as const,
      planner: 'hosted' as const,
    },
    findings: [
      {
        site: 'leaf:MOTIR-12',
        prediction: 'STOPS' as const,
        whatHappened: 'w',
        evidence: 'e',
        outcome: 'reported' as const,
      },
    ],
    actorCoreUserId: 'u_1',
  };

  it('POSTs the body unchanged, once', async () => {
    const fetchMock = stub(json({ record: RECORD, findings: [] }, 201));
    expect(await createPlannerFindingRecord(request)).toEqual({ record: RECORD, findings: [] });
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://ai.test/v1/admin/planner-finding-records');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('POSTs a run-through answer on the record, and answers the stored pair unchanged', async () => {
    const stored = {
      ...RECORD,
      runThroughAnswer: 'STOPS' as const,
      runThroughStopCards: ['MOTIR-7'],
    };
    const fetchMock = stub(json({ record: stored, findings: [] }, 201));
    const answered = {
      ...request,
      record: {
        ...request.record,
        runThroughAnswer: 'STOPS' as const,
        runThroughStopCards: ['MOTIR-7'],
      },
    };
    expect(await createPlannerFindingRecord(answered)).toEqual({ record: stored, findings: [] });
    const sent = JSON.parse(String(call(fetchMock)[1].body));
    expect(sent.record).toMatchObject({
      runThroughAnswer: 'STOPS',
      runThroughStopCards: ['MOTIR-7'],
    });
  });

  it('POSTs no answer key when the record carries none', async () => {
    const fetchMock = stub(json({ record: RECORD, findings: [] }, 201));
    await createPlannerFindingRecord(request);
    const sent = JSON.parse(String(call(fetchMock)[1].body));
    expect(sent.record).not.toHaveProperty('runThroughAnswer');
    expect(sent.record).not.toHaveProperty('runThroughStopCards');
  });

  it("maps motir-ai's refusal, and reads a 2xx without a record as an outage", async () => {
    stub(problem('validation_error', 400));
    const refused = await createPlannerFindingRecord(request).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(MotirAiBadRequestError);
    expect((refused as MotirAiBadRequestError).detail).toBe('validation_error detail');
    stub(json({ ok: true }, 201));
    await expect(createPlannerFindingRecord(request)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
    stub(new Response('<html>', { status: 201 }));
    await expect(createPlannerFindingRecord(request)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('submitPlannerFindingRecordVerdict', () => {
  const verdict = {
    verdicts: [{ findingId: 'pf_1', attribution: 'code' as const, why: 'The walker.' }],
    replace: true,
  };

  it('POSTs the verdict with the actor beside it', async () => {
    const answer = { record: { ...RECORD, verdictState: 'attributed' }, findings: [], audit: [] };
    const fetchMock = stub(json(answer));
    expect(await submitPlannerFindingRecordVerdict('rec_1', verdict, 'u_1')).toEqual(answer);
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://ai.test/v1/admin/planner-finding-records/rec_1/verdict');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ...verdict, actorCoreUserId: 'u_1' });
  });

  it('maps conflict and not_found to their own classes', async () => {
    stub(problem('conflict', 409));
    const conflict = await submitPlannerFindingRecordVerdict('rec_1', verdict, 'u_1').catch(
      (e: unknown) => e,
    );
    expect(conflict).toBeInstanceOf(MotirAiConflictError);
    expect((conflict as MotirAiConflictError).detail).toBe('conflict detail');
    stub(problem('not_found', 404));
    await expect(submitPlannerFindingRecordVerdict('rec_1', verdict, 'u_1')).rejects.toBeInstanceOf(
      PlannerFindingRecordNotFoundError,
    );
  });

  it('falls back to the title when a conflict carries no detail', async () => {
    stub(json({ type: 'about:blank', code: 'conflict', title: 'Conflict', status: 409 }, 409));
    const conflict = await submitPlannerFindingRecordVerdict('rec_1', verdict, 'u_1').catch(
      (e: unknown) => e,
    );
    expect((conflict as MotirAiConflictError).detail).toBe('Conflict');
  });

  it.each([
    ['no audit', json({ record: RECORD, findings: [] })],
    ['no record', json({ audit: [] })],
    ['not JSON', new Response('<html>', { status: 200 })],
  ])('reads a 200 with %s as an outage', async (_n, res) => {
    stub(res);
    await expect(submitPlannerFindingRecordVerdict('rec_1', verdict, 'u_1')).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('the finding key writes (MOTIR-11590)', () => {
  const finding = { id: 'pf/1', bugKey: 'BUGS-1' };
  const audit = { before: { bugKey: null }, after: { bugKey: 'BUGS-1' } };

  it('PATCHes the finding with the key ALONE beside the actor', async () => {
    const fetchMock = stub(json({ finding, audit }));
    expect(await setPlannerFindingBugKey('pf/1', 'BUGS-1', 'u_1')).toEqual({ finding, audit });
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://ai.test/v1/admin/planner-findings/pf%2F1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ bugKey: 'BUGS-1', actorCoreUserId: 'u_1' });
  });

  it('clears with an explicit null key, and answers audit: null as sent', async () => {
    const fetchMock = stub(json({ finding: { ...finding, bugKey: null }, audit: null }));
    expect((await clearPlannerFindingBugKey('pf/1', 'u_1')).audit).toBeNull();
    expect(JSON.parse(String(call(fetchMock)[1].body))).toEqual({
      bugKey: null,
      actorCoreUserId: 'u_1',
    });
  });

  it('maps not_found to the finding class, and a 200 without a finding to an outage', async () => {
    stub(problem('not_found', 404));
    await expect(setPlannerFindingBugKey('pf_1', 'BUGS-1', 'u_1')).rejects.toBeInstanceOf(
      PlannerFindingNotFoundError,
    );
    stub(json({ audit: null }));
    await expect(clearPlannerFindingBugKey('pf_1', 'u_1')).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});
