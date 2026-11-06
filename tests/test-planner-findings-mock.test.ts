import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import type { RawPlannerFinding } from '@/lib/ai/motirAiClient';
import type {
  PlannerFindingsFixture,
  PlannerFindingsJournalLine,
} from '@/lib/test-planner-findings-mock';

// The acceptance lane's stand-in for motir-ai's planner-findings admin routes
// (Story MOTIR-10353 · MOTIR-10529), driven over the wire through an undici
// MockAgent, a temp fixture and a temp journal — the ownership guard's setup.

const ORIGIN = 'http://motir-ai.planner-findings.test';

let agent: MockAgent;
let fixturePath: string;
let journalPath: string;
let helper: typeof import('./e2e/_helpers/planner-findings-fixture');

function finding(over: Partial<RawPlannerFinding> & { id: string }): RawPlannerFinding {
  return helper.fixtureFinding(over);
}

function seed(fixture: Partial<PlannerFindingsFixture>): void {
  writeFileSync(fixturePath, JSON.stringify({ findings: [], ...fixture }));
}

function stored(): PlannerFindingsFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as PlannerFindingsFixture;
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ORIGIN}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function send(
  method: 'PATCH' | 'POST',
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const patch = (id: string, body: Record<string, unknown>) =>
  send('PATCH', `/v1/admin/planner-findings/${id}`, { actorCoreUserId: 'u_op', ...body });

const ids = (body: Record<string, unknown>) =>
  (body['findings'] as RawPlannerFinding[]).map((f) => f.id);

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 0, minutes)).toISOString();

beforeEach(async () => {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), 'motir-planner-findings-'));
  fixturePath = join(dir, 'fixture.json');
  journalPath = join(dir, 'journal.jsonl');
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH', fixturePath);
  vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_JOURNAL_PATH', journalPath);
  helper = await import('./e2e/_helpers/planner-findings-fixture');
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const { installPlannerFindingsBoundaryMock } = await import('@/lib/test-planner-findings-mock');
  installPlannerFindingsBoundaryMock(agent);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await agent.close();
});

describe('install', () => {
  it('is a no-op when MOTIR_AI_URL is unset', async () => {
    vi.stubEnv('MOTIR_AI_URL', '');
    const quiet = new MockAgent();
    const spy = vi.spyOn(quiet, 'get');
    const { installPlannerFindingsBoundaryMock } = await import('@/lib/test-planner-findings-mock');
    installPlannerFindingsBoundaryMock(quiet);
    expect(spy).not.toHaveBeenCalled();
    await quiet.close();
  });

  it('reads no fixture path, or a fixture with no findings array, as an empty store', async () => {
    vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH', '');
    expect((await get('/v1/admin/planner-findings')).body['findings']).toEqual([]);
    vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH', fixturePath);
    writeFileSync(fixturePath, JSON.stringify({ findings: 'nope' }));
    expect((await get('/v1/admin/planner-findings')).body['findings']).toEqual([]);
    // A write with no fixture path stores nothing and still answers.
    vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH', '');
    expect((await send('POST', '/v1/lessons', { title: 't' })).body['id']).toBe('les_pf_1');
  });

  it('reads an absent or half-written fixture as an empty live store', async () => {
    expect((await get('/v1/admin/planner-findings')).body).toEqual({
      findings: [],
      nextCursor: null,
      retention: { days: 90, cutoff: null },
    });
    writeFileSync(fixturePath, '{"findings": [');
    const half = await get('/v1/admin/planner-findings/groups');
    expect(half.status).toBe(200);
    expect(half.body['groups']).toEqual([]);
  });
});

describe('GET /v1/admin/planner-findings', () => {
  it('walks 52 rows of one fingerprint plus others in two pages, each row once', async () => {
    const many = Array.from({ length: 52 }, (_, i) =>
      finding({ id: `pf_${String(i).padStart(2, '0')}`, fingerprint: 'fp_many', createdAt: at(i) }),
    );
    const others = [
      finding({ id: 'pf_x1', createdAt: at(100) }),
      finding({ id: 'pf_x2', createdAt: at(100) }),
    ];
    seed({ findings: [...many, ...others] });

    const first = await get('/v1/admin/planner-findings');
    expect(ids(first.body)).toHaveLength(50);
    // Newest first, `id` descending on the tie.
    expect(ids(first.body).slice(0, 3)).toEqual(['pf_x2', 'pf_x1', 'pf_51']);
    expect(first.body['nextCursor']).toBe(ids(first.body)[49]);
    const second = await get(
      `/v1/admin/planner-findings?cursor=${String(first.body['nextCursor'])}`,
    );
    expect(ids(second.body)).toHaveLength(4);
    expect(second.body['nextCursor']).toBeNull();
    const all = [...ids(first.body), ...ids(second.body)];
    expect(new Set(all).size).toBe(54);

    const byFp = await get('/v1/admin/planner-findings?fingerprint=fp_many&limit=500');
    expect(ids(byFp.body)).toHaveLength(52);
    expect(byFp.body['nextCursor']).toBeNull();
  });

  it('applies each filter exactly, ANDs status with excludeStatus, and refuses bad input', async () => {
    seed({
      findings: [
        finding({ id: 'a', source: 'check_plan', planner: 'plan_py', outcome: 'reported' }),
        finding({ id: 'b', attribution: 'corpus', status: 'dismissed' }),
        finding({ id: 'c', attribution: null, outcome: 'fix_failed', fingerprint: 'fp_c' }),
      ],
    });
    const q = async (qs: string) => ids((await get(`/v1/admin/planner-findings?${qs}`)).body);
    expect(await q('source=check_plan')).toEqual(['a']);
    expect(await q('planner=plan_py')).toEqual(['a']);
    expect(await q('attribution=corpus')).toEqual(['b']);
    expect((await q('attribution=unattributed')).sort()).toEqual(['a', 'c']);
    expect(await q('outcome=fix_failed')).toEqual(['c']);
    expect(await q('fingerprint=fp_c')).toEqual(['c']);
    expect(await q('status=dismissed')).toEqual(['b']);
    expect((await q('excludeStatus=dismissed')).sort()).toEqual(['a', 'c']);
    expect(await q('status=dismissed&excludeStatus=dismissed')).toEqual([]);
    const unknownFp = await get('/v1/admin/planner-findings?fingerprint=fp_nowhere');
    expect(unknownFp.status).toBe(200);
    expect(ids(unknownFp.body)).toEqual([]);

    for (const bad of ['source=hosted', 'status=open', 'limit=0', 'limit=2.5', 'cursor=nope']) {
      const res = await get(`/v1/admin/planner-findings?${bad}`);
      expect(res.status).toBe(400);
      expect(res.body['code']).toBe('validation_error');
    }
  });
});

describe('GET /v1/admin/planner-findings/groups', () => {
  it('groups by the fingerprint each row carries, ordered by the newest row', async () => {
    seed({
      findings: [
        finding({ id: 'p1', fingerprint: 'fp_shared', planId: 'plan_1', createdAt: at(1) }),
        finding({ id: 'p2', fingerprint: 'fp_shared', planId: 'plan_2', createdAt: at(3) }),
        finding({ id: 'd1', fingerprint: 'fp_gone', status: 'dismissed', createdAt: at(5) }),
      ],
    });
    const open = await get('/v1/admin/planner-findings/groups?excludeStatus=dismissed');
    const groups = open.body['groups'] as {
      fingerprint: string;
      count: number;
      planIds: string[];
      latest: RawPlannerFinding;
    }[];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ fingerprint: 'fp_shared', count: 2 });
    expect(groups[0]!.planIds.sort()).toEqual(['plan_1', 'plan_2']);
    expect(groups[0]!.latest.id).toBe('p2');

    const everything = await get('/v1/admin/planner-findings/groups');
    expect(
      (everything.body['groups'] as { fingerprint: string }[]).map((g) => g.fingerprint),
    ).toEqual(['fp_gone', 'fp_shared']);

    const one = await get('/v1/admin/planner-findings/groups?fingerprint=fp_shared');
    expect(one.body['groups']).toHaveLength(1);
    expect((one.body['groups'] as { count: number }[])[0]!.count).toBe(2);

    // Two groups whose newest rows are equally new order by fingerprint.
    seed({
      findings: [
        finding({ id: 't1', fingerprint: 'fp_b', createdAt: at(9) }),
        finding({ id: 't2', fingerprint: 'fp_a', createdAt: at(9) }),
      ],
    });
    const tied = await get('/v1/admin/planner-findings/groups');
    expect((tied.body['groups'] as { fingerprint: string }[]).map((g) => g.fingerprint)).toEqual([
      'fp_a',
      'fp_b',
    ]);
    seed({
      findings: [
        finding({ id: 'p1', fingerprint: 'fp_shared', planId: 'plan_1', createdAt: at(1) }),
        finding({ id: 'p2', fingerprint: 'fp_shared', planId: 'plan_2', createdAt: at(3) }),
        finding({ id: 'd1', fingerprint: 'fp_gone', status: 'dismissed', createdAt: at(5) }),
      ],
    });

    const paged = await get('/v1/admin/planner-findings/groups?limit=1');
    expect(paged.body['nextCursor']).toBe('fp_gone');
    const next = await get('/v1/admin/planner-findings/groups?limit=1&cursor=fp_gone');
    expect((next.body['groups'] as { fingerprint: string }[])[0]!.fingerprint).toBe('fp_shared');
    expect(next.body['nextCursor']).toBeNull();
  });
});

describe('GET /v1/admin/planner-findings/:id', () => {
  it('answers the stored row, or 404 not_found', async () => {
    seed({ findings: [finding({ id: 'pf_1' })] });
    expect((await get('/v1/admin/planner-findings/pf_1')).body['id']).toBe('pf_1');
    const missing = await get('/v1/admin/planner-findings/pf_none');
    expect(missing.status).toBe(404);
    expect(missing.body['code']).toBe('not_found');
  });
});

describe('PATCH /v1/admin/planner-findings/:id', () => {
  beforeEach(() => seed({ findings: [finding({ id: 'pf_1', fingerprint: 'fp_keep' })] }));

  it('an attribution change stores it, audits only that field, and keeps the fingerprint', async () => {
    const res = await patch('pf_1', { attribution: 'corpus' });
    expect(res.status).toBe(200);
    const audit = res.body['audit'] as Record<string, unknown>;
    expect(audit).toMatchObject({
      action: 'ai.planner_finding.triage',
      findingId: 'pf_1',
      actorCoreUserId: 'u_op',
      before: { attribution: null },
      after: { attribution: 'corpus' },
    });
    const row = stored().findings[0]!;
    expect(row).toMatchObject({ attribution: 'corpus', fingerprint: 'fp_keep', triagedBy: 'u_op' });
    expect(row.triagedAt).toBe(audit['at']);
  });

  it('a same-value write answers audit null and stores nothing', async () => {
    await patch('pf_1', { attribution: 'model' });
    const before = readFileSync(fixturePath, 'utf8');
    const res = await patch('pf_1', { attribution: 'model' });
    expect(res.body['audit']).toBeNull();
    expect(readFileSync(fixturePath, 'utf8')).toBe(before);
  });

  it('a status carries exactly its own id and clears the others', async () => {
    let res = await patch('pf_1', { status: 'promoted_to_lesson', lessonId: 'les_1' });
    expect(stored().findings[0]).toMatchObject({ status: 'promoted_to_lesson', lessonId: 'les_1' });
    res = await patch('pf_1', { status: 'filed_as_bug', bugKey: 'ACME-9' });
    expect(stored().findings[0]).toMatchObject({
      status: 'filed_as_bug',
      bugKey: 'ACME-9',
      lessonId: null,
    });
    expect((res.body['audit'] as { before: object }).before).toEqual({
      status: 'promoted_to_lesson',
      lessonId: 'les_1',
      bugKey: null,
    });
    await patch('pf_1', { status: 'dismissed', note: 'Duplicate.' });
    expect(stored().findings[0]).toMatchObject({
      status: 'dismissed',
      triageNote: 'Duplicate.',
      bugKey: null,
    });
    await patch('pf_1', { status: 'new' });
    expect(stored().findings[0]).toMatchObject({
      status: 'new',
      lessonId: null,
      bugKey: null,
      triageNote: null,
    });
  });

  it.each([
    ['no triage field', {}],
    ['a blank actor', { actorCoreUserId: ' ', attribution: 'code' }],
    ['an unknown attribution', { attribution: 'luck' }],
    ['an unknown status', { status: 'open' }],
    ['an id without its status', { lessonId: 'les_1' }],
    ['a note on the wrong status', { status: 'new', note: 'x' }],
    [
      'a bug key on the wrong status',
      { status: 'promoted_to_lesson', lessonId: 'l', bugKey: 'A-1' },
    ],
    ['a lesson id on the wrong status', { status: 'filed_as_bug', bugKey: 'A-1', lessonId: 'l' }],
    ['a promote with no lesson id', { status: 'promoted_to_lesson' }],
    ['a bug with no key', { status: 'filed_as_bug' }],
    ['a blank text field', { why: '  ' }],
  ])('refuses %s with 400 validation_error', async (_name, body) => {
    const res = await patch('pf_1', body);
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('validation_error');
  });

  it('stores a text field it is given', async () => {
    await patch('pf_1', { why: 'The corpus never says it.' });
    expect(stored().findings[0]?.why).toBe('The corpus never says it.');
  });

  it('refuses a body that is not a JSON object, and answers 404 for an unknown id', async () => {
    expect((await send('PATCH', '/v1/admin/planner-findings/pf_1', 'nope')).status).toBe(400);
    expect((await send('PATCH', '/v1/admin/planner-findings/pf_1', '[1]')).status).toBe(400);
    const missing = await patch('pf_none', { attribution: 'code' });
    expect(missing.status).toBe(404);
    expect(missing.body['code']).toBe('not_found');
  });
});

describe('POST /v1/lessons', () => {
  it('stores each request and answers les_pf_<n> echoing it', async () => {
    seed({});
    const lesson = (title: string) => ({
      coreOrganizationId: 'o',
      coreWorkspaceId: 'w',
      coreProjectId: 'p',
      mistakeType: 'regular_planning',
      title,
      why: `${title} why`,
      howToApply: `${title} how`,
      body: `${title} body`,
    });
    const one = await send('POST', '/v1/lessons', { ...lesson('First'), sourceRef: 'pf_1' });
    const two = await send('POST', '/v1/lessons', lesson('Second'));
    expect(one.body).toMatchObject({
      id: 'les_pf_1',
      title: 'First',
      why: 'First why',
      sourceRef: 'pf_1',
    });
    expect(two.body['sourceRef']).toBeNull();
    expect(two.body).toMatchObject({
      id: 'les_pf_2',
      howToApply: 'Second how',
      body: 'Second body',
    });
    expect(stored().createdLessons?.map((l) => [l.id, l.request['title']])).toEqual([
      ['les_pf_1', 'First'],
      ['les_pf_2', 'Second'],
    ]);
    const bad = await send('POST', '/v1/lessons', '{not json');
    expect(bad.status).toBe(400);
    expect(bad.body['code']).toBe('validation_error');
  });
});

describe('GET /v1/jobs/:id', () => {
  it('answers a named job exactly as held, and never claims another id', async () => {
    seed({
      jobs: {
        job_with: helper.fixtureJob(
          [
            {
              stage: 'review',
              model: 'm',
              inputTokens: 1,
              outputTokens: 1,
              sessions: 1,
              costMicroUsd: null,
            },
          ],
          { fixed: 2 },
        ),
        job_without: helper.fixtureJob(undefined),
        job_running: { status: 'running', result: null },
      },
    });
    const withLines = await get('/v1/jobs/job_with?coreProjectId=p');
    expect(withLines.body).toMatchObject({ jobId: 'job_with', status: 'succeeded' });
    expect((withLines.body['result'] as { stageUsage: unknown[] }).stageUsage).toHaveLength(1);
    const without = (await get('/v1/jobs/job_without')).body['result'] as Record<string, unknown>;
    expect('stageUsage' in without).toBe(false);
    expect((await get('/v1/jobs/job_running')).body).toEqual({
      jobId: 'job_running',
      status: 'running',
      result: null,
    });
    // No other seam is installed, so an unnamed id is not answered at all.
    await expect(fetch(`${ORIGIN}/v1/jobs/job_other`)).rejects.toThrow();
  });
});

describe('down mode and the journal', () => {
  it('answers every owned route 503 while down, and normally once live again', async () => {
    seed({ findings: [finding({ id: 'pf_1' })], jobs: { job_1: helper.fixtureJob(undefined) } });
    helper.setPlannerFindingsMode('down');
    for (const res of [
      await get('/v1/admin/planner-findings'),
      await get('/v1/admin/planner-findings/groups'),
      await get('/v1/admin/planner-findings/pf_1'),
      await patch('pf_1', { attribution: 'code' }),
      await send('POST', '/v1/lessons', { title: 't' }),
      await get('/v1/jobs/job_1'),
    ]) {
      expect(res.status).toBe(503);
      expect(res.body['code']).toBe('service_unavailable');
    }
    await expect(fetch(`${ORIGIN}/v1/jobs/job_unnamed`)).rejects.toThrow();
    expect(helper.readJournal().every((line) => line.status === 503)).toBe(true);
    expect(helper.storedFinding('pf_1')?.attribution).toBeNull();

    helper.setPlannerFindingsMode('live');
    expect((await get('/v1/admin/planner-findings/pf_1')).status).toBe(200);
    expect((await get('/v1/jobs/job_1')).status).toBe(200);
  });

  it('writes one line per answered request, in order, with the PATCH and POST bodies', async () => {
    seed({ findings: [finding({ id: 'pf_1' })] });
    helper.resetPlannerFindingsJournal();
    await get('/v1/admin/planner-findings?status=new');
    await patch('pf_1', { attribution: 'code' });
    await send('POST', '/v1/lessons', { title: 'L' });
    const lines: PlannerFindingsJournalLine[] = helper.readJournal();
    expect(lines).toEqual([
      { method: 'GET', path: '/v1/admin/planner-findings', query: { status: 'new' }, status: 200 },
      {
        method: 'PATCH',
        path: '/v1/admin/planner-findings/pf_1',
        query: {},
        status: 200,
        body: { actorCoreUserId: 'u_op', attribution: 'code' },
      },
      { method: 'POST', path: '/v1/lessons', query: {}, status: 201, body: { title: 'L' } },
    ]);
  });

  it('a journal that cannot be written never fails the request', async () => {
    vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_JOURNAL_PATH', join(fixturePath, 'no', 'such.jsonl'));
    seed({});
    expect((await get('/v1/admin/planner-findings')).status).toBe(200);
    vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_JOURNAL_PATH', '');
    expect((await get('/v1/admin/planner-findings')).status).toBe(200);
  });
});

describe('the spec-side helper', () => {
  it('round-trips a finding through write, a PATCH and storedFinding', async () => {
    expect(helper.PLANNER_FINDINGS_FIXTURE).toBe(fixturePath);
    expect(helper.PLANNER_FINDINGS_JOURNAL).toBe(journalPath);
    helper.writePlannerFindingsFixture({ findings: [helper.fixtureFinding({ id: 'pf_rt' })] });
    expect(helper.readPlannerFindingsFixture().findings).toHaveLength(1);
    await patch('pf_rt', { status: 'filed_as_bug', bugKey: 'ACME-482' });
    expect(helper.storedFinding('pf_rt')).toMatchObject({
      status: 'filed_as_bug',
      bugKey: 'ACME-482',
    });
    expect(helper.storedFinding('pf_missing')).toBeUndefined();
  });

  it('defaults to the files under out/ that the acceptance webServer names', async () => {
    vi.resetModules();
    vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH', undefined);
    vi.stubEnv('MOTIR_AI_PLANNER_FINDINGS_JOURNAL_PATH', undefined);
    delete process.env['MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH'];
    delete process.env['MOTIR_AI_PLANNER_FINDINGS_JOURNAL_PATH'];
    const defaults = await import('./e2e/_helpers/planner-findings-fixture');
    expect(defaults.PLANNER_FINDINGS_FIXTURE).toBe(
      join(process.cwd(), 'out', 'e2e-planner-findings-fixture.json'),
    );
    expect(defaults.PLANNER_FINDINGS_JOURNAL).toBe(
      join(process.cwd(), 'out', 'e2e-planner-findings-journal.jsonl'),
    );
    const config = readFileSync('playwright.acceptance.config.ts', 'utf8');
    expect(config).toContain("E2E_TEST_PLANNER_FINDINGS: '1'");
    expect(config).toMatch(/'out',\s*'e2e-planner-findings-fixture\.json'/);
    expect(config).toMatch(/'out',\s*'e2e-planner-findings-journal\.jsonl'/);
  });
});
