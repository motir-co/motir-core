import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import type {
  RawPlannerFinding,
  RawPlannerFindingAudit,
  RawPlannerFindingRecord,
} from '@/lib/ai/motirAiClient';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A FINDING'S PLANNING-BUG KEY over the platform door (Story MOTIR-11455 ·
// MOTIR-11590): `POST /api/platform/planner-findings/{findingId}/bug-key` and
// `…/bug-key/remove`, over real Postgres, the real gate, real tokens, a real work
// item and the real audit transaction. motir-ai's four client calls are stubbed,
// so every assertion about motir-ai is about what core SENT it.
//
//  - the gate: both routes are operator writes; every refusal and a support
//    principal answer the same 404 with no motir-ai call and no audit row;
//  - the set: the key resolves in the RECORD's project (not the caller's), is
//    stored as the work item's identifier, and writes one triage row; a key that
//    names no work item there, or a record with no verdict, writes nothing;
//  - a key the finding already carries is a no-op, as is a clear of a key it
//    no longer carries;
//  - the clear resolves nothing, so a key whose work item is gone still goes.

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const client = vi.hoisted(() => ({
  getPlannerFinding: vi.fn(),
  getPlannerFindingRecord: vi.fn(),
  setPlannerFindingBugKey: vi.fn(),
  clearPlannerFindingBugKey: vi.fn(),
}));

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  ...client,
}));

beforeEach(async () => {
  vi.resetModules();
  currentSession = null;
  for (const fn of Object.values(client)) fn.mockReset();
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
});

afterAll(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function routes() {
  const [set, remove] = await Promise.all([
    import('@/app/api/platform/planner-findings/[findingId]/bug-key/route'),
    import('@/app/api/platform/planner-findings/[findingId]/bug-key/remove/route'),
  ]);
  return { set, remove };
}

let seq = 0;

async function staff(role: PlatformRole | null) {
  const { owner, workspace } = await createTestWorkspace({ name: `Key staff ${++seq}` });
  if (role) await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: role } });
  const { token, dto } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'motir-check-plan',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  });
  return { owner, workspace, token, tokenId: dto.id };
}

const ctx = { params: Promise.resolve({ findingId: 'pf_1' }) };

function post(path: '' | '/remove', token: string | null, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/platform/planner-findings/pf_1/bug-key${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function json(res: Response) {
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
}

const NOW = '2026-11-17T02:00:00.000Z';

function rawRecord(over: Partial<RawPlannerFindingRecord> = {}): RawPlannerFindingRecord {
  return {
    id: 'rec_1',
    source: 'check_plan',
    planner: 'hosted',
    coreOrganizationId: 'org_1',
    coreWorkspaceId: 'ws_1',
    coreProjectId: 'proj_1',
    aiProjectId: 'aip_1',
    planId: 'plan_1',
    planSessionId: null,
    jobId: null,
    planTitle: 'Plan one',
    authorModel: null,
    baselineBranch: null,
    baselineCommit: null,
    verdictState: 'attributed',
    verdictBy: 'u_x',
    verdictAt: NOW,
    runThroughAnswer: null,
    runThroughStopCards: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function rawFinding(over: Partial<RawPlannerFinding> = {}): RawPlannerFinding {
  return {
    id: 'pf_1',
    recordId: 'rec_1',
    coreOrganizationId: 'org_9',
    coreWorkspaceId: 'ws_1',
    coreProjectId: 'proj_1',
    aiProjectId: 'aip_1',
    planId: 'plan_1',
    jobId: null,
    planTitle: 'Plan one',
    cardRef: null,
    source: 'check_plan',
    planner: 'hosted',
    authorModel: null,
    authorSessionKey: null,
    baselineBranch: null,
    baselineCommit: null,
    site: 'leaf:MOTIR-12',
    prediction: 'STOPS',
    whatHappened: 'The leaf names no file.',
    evidence: 'MOTIR-12 body',
    correction: null,
    outcome: 'reported',
    rule: null,
    attribution: 'code',
    why: 'The walker skipped the read.',
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
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function keyAudit(before: string | null, after: string | null): RawPlannerFindingAudit {
  return {
    action: 'ai.planner_finding.triage',
    findingId: 'pf_1',
    actorCoreUserId: 'u_op',
    at: NOW,
    before: { bugKey: before },
    after: { bugKey: after },
  };
}

/** A record in a real project with one real work item, and the finding the stubs answer. */
async function arrange(
  over: { record?: Partial<RawPlannerFindingRecord>; finding?: Partial<RawPlannerFinding> } = {},
) {
  const fixture = await makeWorkItemFixture({ name: `Tenant ${++seq}`, identifier: 'BUGS' });
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'bug', title: 'the planner skipped the read' },
    fixture.ctx,
  );
  const record = rawRecord({ coreProjectId: fixture.projectId, ...over.record });
  const finding = rawFinding({ coreProjectId: fixture.projectId, ...over.finding });
  client.getPlannerFinding.mockResolvedValue(finding);
  client.getPlannerFindingRecord.mockResolvedValue({ record, findings: [finding] });
  client.setPlannerFindingBugKey.mockImplementation(async (_id: string, key: string) => ({
    finding: { ...finding, bugKey: key },
    audit: keyAudit(finding.bugKey, key),
  }));
  client.clearPlannerFindingBugKey.mockImplementation(async () => ({
    finding: { ...finding, bugKey: null },
    audit: keyAudit(finding.bugKey, null),
  }));
  return { fixture, item, record, finding };
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } });
}

const ROUTES = [
  {
    name: 'POST /bug-key',
    run: (r: Awaited<ReturnType<typeof routes>>, t: string | null) =>
      r.set.POST(post('', t, { key: 'BUGS-1' }), ctx),
  },
  {
    name: 'POST /bug-key/remove',
    run: (r: Awaited<ReturnType<typeof routes>>, t: string | null) =>
      r.remove.POST(post('/remove', t, { key: 'BUGS-1' }), ctx),
  },
];

const REFUSALS: { name: string; arrange: () => Promise<string | null> }[] = [
  { name: 'anonymous', arrange: async () => null },
  {
    name: 'a non-staff session',
    arrange: async () => {
      currentSession = { user: { id: (await createTestUser()).id } };
      return null;
    },
  },
  { name: 'a non-staff token', arrange: async () => (await staff(null)).token },
  { name: 'a support token', arrange: async () => (await staff('support')).token },
  {
    name: 'a support session',
    arrange: async () => {
      const user = await createTestUser();
      await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
      currentSession = { user: { id: user.id } };
      return null;
    },
  },
];

describe('the gate — both key routes are operator writes', () => {
  describe.each(REFUSALS)('$name', ({ arrange: refuse }) => {
    it.each(ROUTES)('$name answers 404 with no motir-ai call and no audit row', async (route) => {
      await arrange();
      const bearer = await refuse();
      const res = await json(await route.run(await routes(), bearer));
      expect(res).toEqual({ status: 404, body: { code: 'NOT_FOUND' }, cache: 'no-store' });
      for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
      expect(await auditRows()).toEqual([]);
    });
  });
});

describe('POST /bug-key — set', () => {
  it("resolves the key in the record's project, stores the identifier, and writes one triage row", async () => {
    const { owner, token, tokenId } = await staff('operator');
    const { record } = await arrange();
    const r = await routes();

    const res = await json(await r.set.POST(post('', token, { key: '  bugs-1 ' }), ctx));
    expect(res.status).toBe(200);
    expect(res.cache).toBe('no-store');
    expect(res.body.record).toEqual(record);
    expect(res.body.finding.bugKey).toBe('BUGS-1');
    expect(client.setPlannerFindingBugKey).toHaveBeenCalledWith('pf_1', 'BUGS-1', owner.id);

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(['estate.read', 'planner_finding.triage']);
    expect(rows[0]!.metadata).toEqual({
      surface: 'planner_finding.bug_key',
      credential: { kind: 'token', apiTokenId: tokenId },
    });
    expect(rows[1]).toMatchObject({
      actorUserId: owner.id,
      targetKind: 'platform',
      targetId: 'pf_1',
      targetLabel: 'leaf:MOTIR-12',
      organizationId: 'org_9',
      metadata: {
        recordId: 'rec_1',
        findingId: 'pf_1',
        key: 'BUGS-1',
        before: { bugKey: null },
        after: { bugKey: 'BUGS-1' },
        credential: { kind: 'token', apiTokenId: tokenId },
      },
    });
    expect(rows[1]!.reason).toMatch('/api/platform/planner-findings');
  });

  it('refuses a key that names no work item in the record project with 400, writing nothing', async () => {
    const { token } = await staff('operator');
    await arrange();
    const r = await routes();
    const res = await json(await r.set.POST(post('', token, { key: 'BUGS-404' }), ctx));
    expect(res).toEqual({
      status: 400,
      body: { code: 'FINDING_KEY_REFUSED', reason: 'not_a_work_item' },
      cache: 'no-store',
    });
    expect(client.setPlannerFindingBugKey).not.toHaveBeenCalled();
    expect((await auditRows()).map((row) => row.action)).toEqual(['estate.read']);
  });

  it("refuses a key that exists only in another project, even the caller's own", async () => {
    const { owner, workspace, token } = await staff('operator');
    // The caller's own project holds an OTHR-1; the record's project does not.
    const { projectsService } = await import('@/lib/services/projectsService');
    const own = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Other',
      identifier: 'OTHR',
    });
    await workItemsService.createWorkItem(
      { projectId: own.id, kind: 'bug', title: 'elsewhere' },
      { userId: owner.id, workspaceId: workspace.id },
    );
    await arrange();
    const r = await routes();
    const res = await json(await r.set.POST(post('', token, { key: 'OTHR-1' }), ctx));
    expect(res.body).toEqual({ code: 'FINDING_KEY_REFUSED', reason: 'not_a_work_item' });
    expect(client.setPlannerFindingBugKey).not.toHaveBeenCalled();
  });

  it('refuses a record with no verdict with 409, before any resolution or write', async () => {
    const { token } = await staff('operator');
    await arrange({ record: { verdictState: 'open', verdictBy: null, verdictAt: null } });
    const r = await routes();
    const res = await json(await r.set.POST(post('', token, { key: 'BUGS-1' }), ctx));
    expect(res).toEqual({
      status: 409,
      body: { code: 'FINDING_KEY_REFUSED', reason: 'record_open' },
      cache: 'no-store',
    });
    expect(client.setPlannerFindingBugKey).not.toHaveBeenCalled();
    expect((await auditRows()).map((row) => row.action)).toEqual(['estate.read']);
  });

  it('answers a key the finding already carries, in any casing, with no write', async () => {
    const { token } = await staff('operator');
    const { finding } = await arrange({ finding: { bugKey: 'bugs-1' } });
    const r = await routes();
    const res = await json(await r.set.POST(post('', token, { key: 'BUGS-1' }), ctx));
    expect(res.status).toBe(200);
    expect(res.body.finding).toEqual(finding);
    expect(client.setPlannerFindingBugKey).not.toHaveBeenCalled();
    expect((await auditRows()).map((row) => row.action)).toEqual(['estate.read']);
  });

  it('writes no triage row when motir-ai reports the same change landed first', async () => {
    const { token } = await staff('operator');
    const { finding } = await arrange();
    client.setPlannerFindingBugKey.mockResolvedValueOnce({
      finding: { ...finding, bugKey: 'BUGS-1' },
      audit: null,
    });
    const r = await routes();
    const res = await json(await r.set.POST(post('', token, { key: 'BUGS-1' }), ctx));
    expect(res.status).toBe(200);
    expect(res.body.finding.bugKey).toBe('BUGS-1');
    expect((await auditRows()).map((row) => row.action)).toEqual(['estate.read']);
  });

  it('answers a finding that belongs to no record as 404', async () => {
    const { token } = await staff('operator');
    await arrange({ finding: { recordId: undefined } });
    const r = await routes();
    const res = await json(await r.set.POST(post('', token, { key: 'BUGS-1' }), ctx));
    expect(res).toEqual({
      status: 404,
      body: { code: 'PLANNER_FINDING_NOT_FOUND', findingId: 'pf_1' },
      cache: 'no-store',
    });
    expect(client.getPlannerFindingRecord).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([]);
  });

  it.each([
    ['an empty key', { key: '   ' }],
    ['no key', {}],
    ['an unknown member', { key: 'BUGS-1', note: 'x' }],
  ])('refuses %s before any read', async (_n, body) => {
    const { token } = await staff('operator');
    await arrange();
    const r = await routes();
    const res = await json(await r.set.POST(post('', token, body), ctx));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
    for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('POST /bug-key/remove — clear', () => {
  it('clears the carried key on an operator session and writes one triage row', async () => {
    const { owner } = await staff('operator');
    currentSession = { user: { id: owner.id } };
    await arrange({ finding: { bugKey: 'BUGS-1' } });
    const r = await routes();
    const res = await json(await r.remove.POST(post('/remove', null, { key: 'bugs-1' }), ctx));
    expect(res.status).toBe(200);
    expect(res.body.finding.bugKey).toBeNull();
    expect(client.clearPlannerFindingBugKey).toHaveBeenCalledWith('pf_1', owner.id);
    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(['estate.read', 'planner_finding.triage']);
    expect(rows[1]).toMatchObject({
      metadata: {
        key: 'BUGS-1',
        before: { bugKey: 'BUGS-1' },
        after: { bugKey: null },
        credential: { kind: 'session' },
      },
    });
    expect(rows[1]!.reason).toMatch(/Cleared/);
  });

  it('clears a key whose work item no longer exists — the clear resolves nothing', async () => {
    const { token } = await staff('operator');
    await arrange({ finding: { bugKey: 'GONE-7' } });
    const r = await routes();
    const res = await json(await r.remove.POST(post('/remove', token, { key: 'GONE-7' }), ctx));
    expect(res.status).toBe(200);
    expect(client.clearPlannerFindingBugKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a key the finding no longer carries', 'BUGS-2'],
    ['a finding that carries no key', null],
  ])('answers %s as it stands, with no write', async (_n, carried) => {
    const { token } = await staff('operator');
    const { finding } = await arrange({ finding: { bugKey: carried === null ? null : 'BUGS-2' } });
    const r = await routes();
    const res = await json(await r.remove.POST(post('/remove', token, { key: 'BUGS-1' }), ctx));
    expect(res.status).toBe(200);
    expect(res.body.finding).toEqual(finding);
    expect(client.clearPlannerFindingBugKey).not.toHaveBeenCalled();
    expect((await auditRows()).map((row) => row.action)).toEqual(['estate.read']);
  });

  it('refuses a record with no verdict with 409', async () => {
    const { token } = await staff('operator');
    await arrange({
      record: { verdictState: 'open', verdictBy: null, verdictAt: null },
      finding: { bugKey: 'BUGS-1' },
    });
    const r = await routes();
    const res = await json(await r.remove.POST(post('/remove', token, { key: 'BUGS-1' }), ctx));
    expect(res.body).toEqual({ code: 'FINDING_KEY_REFUSED', reason: 'record_open' });
    expect(res.status).toBe(409);
    expect(client.clearPlannerFindingBugKey).not.toHaveBeenCalled();
  });
});
