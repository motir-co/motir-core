import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import type {
  RawPlannerFinding,
  RawPlannerFindingRecord,
  RawPlannerFindingVerdictAudit,
} from '@/lib/ai/motirAiClient';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { PLANNER_FINDING_NO_PLAN_ID } from '@/lib/services/plannerFindingsService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { createTestProject } from '../fixtures/projectFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The PLANNER-FINDINGS platform routes (Story MOTIR-11455 · MOTIR-11458) over
// real Postgres, the real gate, real tokens and the real audit transaction.
// What is stubbed: `getSession()` (the repo's standing exception) and the five
// motir-ai client calls, because motir-ai is another service — so every assertion
// about motir-ai is about what core SENT it and what core did with its answer.
//
//  - the gate: each of the five routes answers an operator session and an
//    operator / superadmin token, and the SAME 404 to every refusal, with no
//    motir-ai call and no audit row;
//  - the create: tenant ids and the plan session from a core plan id read across
//    tenants, the `projectKey` fallback when the plan is gone, a body naming
//    neither refused, one `planner_finding.record` row;
//  - the verdict: forwarded with the actor, one `planner_finding.verdict` row per
//    changed finding, none when motir-ai refuses.

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const client = vi.hoisted(() => ({
  getPlannerFinding: vi.fn(),
  listPlannerFindingRecords: vi.fn(),
  getPlannerFindingRecord: vi.fn(),
  createPlannerFindingRecord: vi.fn(),
  submitPlannerFindingRecordVerdict: vi.fn(),
}));

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  ...client,
}));

// `requirePlatformStaff` (the session arm) is React-`cache()`d process-wide in
// vitest, so each case imports the routes from a fresh module graph.
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
  const [finding, records, record, verdict] = await Promise.all([
    import('@/app/api/platform/planner-findings/[findingId]/route'),
    import('@/app/api/platform/planner-findings/records/route'),
    import('@/app/api/platform/planner-findings/records/[id]/route'),
    import('@/app/api/platform/planner-findings/records/[id]/verdict/route'),
  ]);
  return { finding, records, record, verdict };
}

/**
 * The motir-ai error classes from the SAME module graph as the routes: after
 * `vi.resetModules()` a statically imported class is a different constructor,
 * and the routes' `instanceof` map would not know it.
 */
async function aiErrors() {
  return import('@/lib/ai/errors');
}

let seq = 0;

/** A user at `role` (null: a tenant user) with a fresh PAT in their own workspace. */
async function staff(role: PlatformRole | null) {
  const { owner, workspace } = await createTestWorkspace({ name: `Findings staff ${++seq}` });
  if (role) await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: role } });
  const { token, dto } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'motir-check-plan',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  });
  return { owner, workspace, token, tokenId: dto.id };
}

function call(
  path: string,
  token: string | null,
  init: { method?: string; body?: unknown; rawBody?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined || init.rawBody !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return new Request(`http://localhost/api/platform/planner-findings${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}

async function json(res: Response) {
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
}

const NOW = '2026-11-16T12:00:00.000Z';

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
    verdictState: 'open',
    verdictBy: null,
    verdictAt: null,
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
    coreOrganizationId: 'org_1',
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
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const FINDING_INPUT = {
  site: 'leaf:MOTIR-12',
  prediction: 'STOPS',
  whatHappened: 'The leaf names no file.',
  evidence: 'MOTIR-12 body',
  outcome: 'reported',
} as const;

const VERDICT = {
  verdicts: [{ findingId: 'pf_1', attribution: 'code', why: 'The walker skipped the read.' }],
};

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } });
}

// ── The gate ────────────────────────────────────────────────────────────────

type Routes = Awaited<ReturnType<typeof routes>>;

/** The five routes, each as one call with a credential. */
const ROUTES: { name: string; run: (r: Routes, token: string | null) => Promise<Response> }[] = [
  {
    name: 'GET /:findingId',
    run: (r, t) =>
      r.finding.GET(call('/pf_1', t), { params: Promise.resolve({ findingId: 'pf_1' }) }),
  },
  { name: 'GET /records', run: (r, t) => r.records.GET(call('/records', t)) },
  {
    name: 'GET /records/:id',
    run: (r, t) =>
      r.record.GET(call('/records/rec_1', t), { params: Promise.resolve({ id: 'rec_1' }) }),
  },
  {
    name: 'POST /records',
    run: (r, t) =>
      r.records.POST(
        call('/records', t, {
          method: 'POST',
          body: {
            planId: 'gone',
            projectKey: 'PROD',
            planner: 'hosted',
            findings: [FINDING_INPUT],
          },
        }),
      ),
  },
  {
    name: 'POST /records/:id/verdict',
    run: (r, t) =>
      r.verdict.POST(call('/records/rec_1/verdict', t, { method: 'POST', body: VERDICT }), {
        params: Promise.resolve({ id: 'rec_1' }),
      }),
  },
];

/** Answer every motir-ai call, so an admitted caller reaches a 2xx on each route. */
function answerEveryCall(orgId: string) {
  const record = rawRecord({ coreOrganizationId: orgId });
  client.getPlannerFinding.mockResolvedValue(rawFinding());
  client.listPlannerFindingRecords.mockResolvedValue({
    records: [{ ...record, findingCount: 1, attributedCount: 0 }],
    nextCursor: null,
    retention: { days: 90, cutoff: NOW },
  });
  client.getPlannerFindingRecord.mockResolvedValue({ record, findings: [rawFinding()] });
  client.createPlannerFindingRecord.mockResolvedValue({ record, findings: [rawFinding()] });
  client.submitPlannerFindingRecordVerdict.mockResolvedValue({
    record: { ...record, verdictState: 'attributed' },
    findings: [rawFinding({ attribution: 'code' })],
    audit: [],
  });
}

/** A refused caller: sets up the session or mints the token, and answers the bearer (or null). */
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
  { name: 'an unknown token', arrange: async () => 'motir_pat_not-a-real-token' },
  { name: 'a bearer that is not a PAT', arrange: async () => 'some-other-credential' },
  {
    name: 'a revoked token',
    arrange: async () => {
      const { owner, token, tokenId } = await staff('superadmin');
      await apiTokensService.deleteToken(owner.id, tokenId);
      return token;
    },
  },
  {
    name: 'an expired token',
    arrange: async () => {
      const { token, tokenId } = await staff('superadmin');
      await adminDb.apiToken.update({
        where: { id: tokenId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      return token;
    },
  },
  {
    name: "a suspended organization's token",
    arrange: async () => {
      const { workspace, token } = await staff('superadmin');
      await adminDb.organization.update({
        where: { id: workspace.organizationId },
        data: { suspendedAt: new Date(), suspendedReason: 'Abuse report' },
      });
      return token;
    },
  },
  {
    name: 'a run token, even dispatched by a superadmin',
    arrange: async () => {
      const fixture = await makeWorkItemFixture();
      await adminDb.user.update({
        where: { id: fixture.owner.id },
        data: { platformRole: 'superadmin' },
      });
      const item = await workItemsService.createWorkItem(
        { projectId: fixture.projectId, kind: 'task', title: 'a hosted card' },
        fixture.ctx,
      );
      const opened = await dispatchRunService.open(
        {
          projectKey: fixture.projectIdentifier,
          command: 'run',
          reportedBy: 'cli',
          origin: 'hosted',
          cards: [{ key: item.identifier, disposition: 'queued' }],
        },
        fixture.ctx,
      );
      const minted = await runCredentialService.mintRunCredential({
        dispatchRunId: opened.run.id,
        dispatcherUserId: fixture.owner.id,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
      return minted.token;
    },
  },
];

/**
 * A SUPPORT principal (MOTIR-11504): admitted to the three reads, which ask for
 * `PLANNER_FINDING_RECORDS_READ_LEVEL`, and refused by every write, which asks
 * for `operator`.
 */
const SUPPORT: { name: string; arrange: () => Promise<string | null> }[] = [
  {
    name: 'a support session',
    arrange: async () => {
      const user = await createTestUser();
      await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
      currentSession = { user: { id: user.id } };
      return null;
    },
  },
  { name: 'a support token', arrange: async () => (await staff('support')).token },
];
const READ_ROUTES = ROUTES.filter((route) => route.name.startsWith('GET '));
const WRITE_ROUTES = ROUTES.filter((route) => !route.name.startsWith('GET '));

describe('the gate — a support principal reads records and writes nothing', () => {
  describe.each(SUPPORT)('$name', ({ arrange }) => {
    it.each(WRITE_ROUTES)(
      '$name answers 404 with no motir-ai call and no audit row',
      async (route) => {
        answerEveryCall('org_1');
        const bearer = await arrange();
        const r = await routes();
        const res = await json(await route.run(r, bearer));
        expect(res).toEqual({ status: 404, body: { code: 'NOT_FOUND' }, cache: 'no-store' });
        for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
        expect(await auditRows()).toEqual([]);
      },
    );

    it.each(READ_ROUTES)('$name answers 200, audited as estate.read', async (route) => {
      answerEveryCall('org_1');
      const bearer = await arrange();
      const r = await routes();
      const res = await json(await route.run(r, bearer));
      expect(res.status).toBe(200);
      expect(res.cache).toBe('no-store');
      expect((await auditRows()).map((row) => row.action)).toEqual(['estate.read']);
    });
  });
});

describe('the gate — every route, every refusal, the same 404', () => {
  describe.each(REFUSALS)('$name', ({ arrange }) => {
    it.each(ROUTES)('$name answers 404 with no motir-ai call and no audit row', async (route) => {
      answerEveryCall('org_1');
      const bearer = await arrange();
      const r = await routes();

      const res = await json(await route.run(r, bearer));
      expect(res).toEqual({ status: 404, body: { code: 'NOT_FOUND' }, cache: 'no-store' });
      for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
      expect(await auditRows()).toEqual([]);
    });
  });
});

describe('the gate — an operator session and an operator or superadmin token are admitted', () => {
  it.each(ROUTES)('$name answers an operator console session', async (route) => {
    const { owner, workspace } = await staff('operator');
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    currentSession = { user: { id: owner.id } };
    answerEveryCall(workspace.organizationId);
    const r = await routes();
    // A session has no token workspace, so a `projectKey` create names its own.
    const res =
      route.name === 'POST /records'
        ? await r.records.POST(
            call('/records', null, {
              method: 'POST',
              body: {
                projectKey: 'PROD',
                workspaceId: workspace.id,
                planner: 'hosted',
                findings: [FINDING_INPUT],
              },
            }),
          )
        : await route.run(r, null);
    expect(res.status).toBe(route.name === 'POST /records' ? 201 : 200);
    const rows = await auditRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.actorUserId).toBe(owner.id);
      expect((row.metadata as { credential: unknown }).credential).toEqual({ kind: 'session' });
    }
  });

  it.each(['operator', 'superadmin'] as const)(
    'each route answers a %s token, and every audit row names the token',
    async (role) => {
      const { owner, workspace, token, tokenId } = await staff(role);
      answerEveryCall(workspace.organizationId);
      const r = await routes();
      for (const route of ROUTES.filter((x) => x.name !== 'POST /records')) {
        const res = await route.run(r, token);
        expect({ route: route.name, status: res.status }).toEqual({
          route: route.name,
          status: 200,
        });
      }
      const rows = await auditRows();
      expect(rows.map((row) => row.action)).toEqual([
        'estate.read',
        'estate.read',
        'estate.read',
        'planner_finding.verdict',
      ]);
      for (const row of rows) {
        expect(row.actorUserId).toBe(owner.id);
        expect((row.metadata as { credential: unknown }).credential).toEqual({
          kind: 'token',
          apiTokenId: tokenId,
        });
      }
    },
  );
});

// ── The reads ───────────────────────────────────────────────────────────────

describe('the reads', () => {
  it('GET /:findingId answers the finding with its recordId, audited as estate.read', async () => {
    const { token } = await staff('operator');
    client.getPlannerFinding.mockResolvedValue(rawFinding());
    const r = await routes();

    const res = await json(
      await r.finding.GET(call('/pf_1', token), { params: Promise.resolve({ findingId: 'pf_1' }) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'pf_1', recordId: 'rec_1' });
    expect(client.getPlannerFinding).toHaveBeenCalledWith('pf_1');
    const [row] = await auditRows();
    expect(row).toMatchObject({ action: 'estate.read', targetKind: 'platform', targetId: 'pf_1' });
  });

  it('GET /:findingId maps an unknown finding to 404 and leaves no audit row', async () => {
    const { token } = await staff('operator');
    client.getPlannerFinding.mockRejectedValue(
      new (await aiErrors()).PlannerFindingNotFoundError('pf_x'),
    );
    const r = await routes();
    const res = await json(
      await r.finding.GET(call('/pf_x', token), { params: Promise.resolve({ findingId: 'pf_x' }) }),
    );
    expect(res).toEqual({
      status: 404,
      body: { code: 'PLANNER_FINDING_NOT_FOUND', findingId: 'pf_x' },
      cache: 'no-store',
    });
    expect(await auditRows()).toEqual([]);
  });

  it('GET /records passes the filters through and refuses an unknown one', async () => {
    const { token } = await staff('operator');
    client.listPlannerFindingRecords.mockResolvedValue({
      records: [],
      nextCursor: null,
      retention: { days: 90, cutoff: null },
    });
    const r = await routes();

    const ok = await json(
      await r.records.GET(
        call(
          '/records?verdictState=open&planner=plan_py&source=check_plan&planId=plan_1&createdFrom=2026-11-01T00:00:00.000Z&createdTo=2026-11-16T00:00:00.000Z&cursor=c1&limit=10',
          token,
        ),
      ),
    );
    expect(ok.status).toBe(200);
    expect(client.listPlannerFindingRecords).toHaveBeenCalledWith({
      verdictState: 'open',
      planner: 'plan_py',
      source: 'check_plan',
      planId: 'plan_1',
      createdFrom: '2026-11-01T00:00:00.000Z',
      createdTo: '2026-11-16T00:00:00.000Z',
      cursor: 'c1',
      limit: 10,
    });
    const [row] = await auditRows();
    expect(row?.metadata).toMatchObject({
      surface: 'planner_finding_records',
      query: { verdictState: 'open', limit: 10 },
    });

    const bad = await json(
      await r.records.GET(call('/records?verdictState=closed&colour=red', token)),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_REQUEST');
    expect(bad.body.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['verdictState']),
    );
  });

  it('GET /records/:id answers the record; an unknown one is 404, an outage 503', async () => {
    const { token } = await staff('operator');
    const r = await routes();
    const ctx = { params: Promise.resolve({ id: 'rec_1' }) };

    client.getPlannerFindingRecord.mockResolvedValueOnce({
      record: rawRecord(),
      findings: [rawFinding()],
    });
    const ok = await json(await r.record.GET(call('/records/rec_1', token), ctx));
    expect(ok.status).toBe(200);
    expect(ok.body.record.id).toBe('rec_1');
    expect(ok.body.findings).toHaveLength(1);

    client.getPlannerFindingRecord.mockRejectedValueOnce(
      new (await aiErrors()).PlannerFindingRecordNotFoundError('rec_x'),
    );
    expect(
      await json(
        await r.record.GET(call('/records/rec_x', token), {
          params: Promise.resolve({ id: 'rec_x' }),
        }),
      ),
    ).toEqual({
      status: 404,
      body: { code: 'PLANNER_FINDING_RECORD_NOT_FOUND', recordId: 'rec_x' },
      cache: 'no-store',
    });

    client.getPlannerFindingRecord.mockRejectedValueOnce(
      new (await aiErrors()).MotirAiUnavailableError('down'),
    );
    expect((await json(await r.record.GET(call('/records/rec_1', token), ctx))).body).toEqual({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});

// ── The create ──────────────────────────────────────────────────────────────

/** A plan in ANOTHER tenant than the staff member's, with a planning session. */
async function foreignPlan() {
  const fx = await makeWorkItemFixture({ name: `Planned ${++seq}`, identifier: 'PLAN' });
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: '',
      targetKeys: [],
      turnCount: 1,
    },
  });
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: session.id,
      status: 'planned',
      createdById: fx.ownerId,
      title: 'Ship the export',
      sourceJobId: 'job_9',
      authorModel: 'claude-opus-5-5',
    },
  });
  return { fx, session, plan };
}

describe('POST /records — the record is stored under the tenant core resolves', () => {
  it('resolves the tenant ids, session and job from a core plan id the staff member cannot see as a tenant', async () => {
    const { owner, token } = await staff('operator');
    const { fx, session, plan } = await foreignPlan();
    client.createPlannerFindingRecord.mockImplementation(async (req) => ({
      record: rawRecord({
        id: 'rec_new',
        coreOrganizationId: req.record.coreOrganizationId,
        planId: req.record.planId,
        planTitle: req.record.planTitle,
      }),
      findings: [rawFinding({ recordId: 'rec_new' })],
    }));
    const r = await routes();

    const res = await json(
      await r.records.POST(
        call('/records', token, {
          method: 'POST',
          body: {
            planId: plan.id,
            planner: 'hosted',
            baseline: { branch: 'main', commit: 'abc123' },
            findings: [{ ...FINDING_INPUT, attribution: 'code', why: '  The walker.  ' }],
          },
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.record.id).toBe('rec_new');
    expect(client.createPlannerFindingRecord).toHaveBeenCalledWith({
      record: {
        coreOrganizationId: fx.workspace.organizationId,
        coreWorkspaceId: fx.workspaceId,
        coreProjectId: fx.projectId,
        planId: plan.id,
        source: 'check_plan',
        planner: 'hosted',
        planSessionId: session.id,
        jobId: 'job_9',
        planTitle: 'Ship the export',
        authorModel: 'claude-opus-5-5',
        baselineBranch: 'main',
        baselineCommit: 'abc123',
      },
      findings: [{ ...FINDING_INPUT, attribution: 'code', why: 'The walker.' }],
      actorCoreUserId: owner.id,
    });

    const rows = await auditRows();
    expect(rows.map((row) => [row.action, row.targetId])).toEqual([
      ['estate.read', plan.id],
      ['planner_finding.record', 'rec_new'],
    ]);
    expect(rows[1]).toMatchObject({
      targetKind: 'platform',
      targetLabel: 'Ship the export',
      organizationId: fx.workspace.organizationId,
      reason: expect.stringMatching(/\S/),
      metadata: expect.objectContaining({ recordId: 'rec_new', planId: plan.id, findingCount: 1 }),
    });
  });

  it("lets the body's title and model stand over the plan's, and fills a session the plan lacks", async () => {
    const { token } = await staff('operator');
    const fx = await makeWorkItemFixture({ name: `Sessionless ${++seq}`, identifier: 'BARE' });
    const plan = await adminDb.plan.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, status: 'planned' },
    });
    client.createPlannerFindingRecord.mockResolvedValue({
      record: rawRecord({ planTitle: null, planId: plan.id }),
      findings: [rawFinding()],
    });
    const r = await routes();

    await r.records.POST(
      call('/records', token, {
        method: 'POST',
        body: {
          planId: plan.id,
          planner: 'plan_py',
          planSessionId: 'sess_cli',
          jobId: 'job_cli',
          planTitle: 'Named by the check',
          authorModel: 'claude-sonnet-5-5',
          findings: [FINDING_INPUT],
        },
      }),
    );
    expect(client.createPlannerFindingRecord.mock.calls[0]![0].record).toEqual({
      coreOrganizationId: fx.workspace.organizationId,
      coreWorkspaceId: fx.workspaceId,
      coreProjectId: fx.projectId,
      planId: plan.id,
      source: 'check_plan',
      planner: 'plan_py',
      planSessionId: 'sess_cli',
      jobId: 'job_cli',
      planTitle: 'Named by the check',
      authorModel: 'claude-sonnet-5-5',
    });
    // No title on either side: the row is labelled by the plan id.
    expect((await auditRows())[1]?.targetLabel).toBe(plan.id);
  });

  it("falls back to projectKey in the token's workspace when the plan is gone", async () => {
    const { owner, workspace, token } = await staff('operator');
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    client.createPlannerFindingRecord.mockResolvedValue({
      record: rawRecord({ coreOrganizationId: workspace.organizationId }),
      findings: [rawFinding()],
    });
    const r = await routes();

    const res = await r.records.POST(
      call('/records', token, {
        method: 'POST',
        body: {
          planId: 'plan_deleted',
          projectKey: 'prod',
          planner: 'hosted',
          findings: [FINDING_INPUT],
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(client.createPlannerFindingRecord.mock.calls[0]![0].record).toEqual({
      coreOrganizationId: workspace.organizationId,
      coreWorkspaceId: workspace.id,
      coreProjectId: project.id,
      planId: 'plan_deleted',
      source: 'check_plan',
      planner: 'hosted',
    });
  });

  it('records with no plan id at all under the no-plan marker', async () => {
    const { owner, workspace, token } = await staff('operator');
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    client.createPlannerFindingRecord.mockResolvedValue({
      record: rawRecord(),
      findings: [rawFinding()],
    });
    const r = await routes();
    await r.records.POST(
      call('/records', token, {
        method: 'POST',
        body: { projectKey: 'PROD', planner: 'hosted', findings: [FINDING_INPUT] },
      }),
    );
    expect(client.createPlannerFindingRecord.mock.calls[0]![0].record.planId).toBe(
      PLANNER_FINDING_NO_PLAN_ID,
    );
    // No plan to read: the create's own row is the only one.
    expect((await auditRows()).map((row) => row.action)).toEqual(['planner_finding.record']);
  });

  it.each([
    ['neither planId nor projectKey', {}, 'projectKey'],
    ['a planId that is not stored, and no projectKey', { planId: 'plan_deleted' }, 'projectKey'],
  ])('refuses a body naming %s with a validation error and no write', async (_n, extra, path) => {
    const { token } = await staff('operator');
    const r = await routes();
    const res = await json(
      await r.records.POST(
        call('/records', token, {
          method: 'POST',
          body: { ...extra, planner: 'hosted', findings: [FINDING_INPUT] },
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_REQUEST', issues: [{ path }] });
    expect(client.createPlannerFindingRecord).not.toHaveBeenCalled();
    expect((await auditRows()).filter((row) => row.action !== 'estate.read')).toEqual([]);
  });

  it('refuses projectKey on a console session that names no workspace', async () => {
    const { owner } = await staff('operator');
    currentSession = { user: { id: owner.id } };
    const r = await routes();
    const res = await json(
      await r.records.POST(
        call('/records', null, {
          method: 'POST',
          body: { projectKey: 'PROD', planner: 'hosted', findings: [FINDING_INPUT] },
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual([{ path: 'workspaceId', message: expect.any(String) }]);
  });

  it('answers 404 for a projectKey the staff member cannot record in', async () => {
    const { token } = await staff('operator');
    const r = await routes();
    const res = await json(
      await r.records.POST(
        call('/records', token, {
          method: 'POST',
          body: { projectKey: 'NOPE', planner: 'hosted', findings: [FINDING_INPUT] },
        }),
      ),
    );
    expect(res).toEqual({ status: 404, body: { code: 'PROJECT_NOT_FOUND' }, cache: 'no-store' });
    expect(client.createPlannerFindingRecord).not.toHaveBeenCalled();
  });

  it('refuses a malformed body before any read', async () => {
    const { token } = await staff('operator');
    const r = await routes();
    const notJson = await json(
      await r.records.POST(call('/records', token, { method: 'POST', rawBody: '{nope' })),
    );
    expect(notJson.body).toEqual({
      code: 'INVALID_REQUEST',
      issues: [{ path: '', message: 'body must be JSON' }],
    });
    const shape = await json(
      await r.records.POST(
        call('/records', token, {
          method: 'POST',
          body: { planner: 'neither', findings: [], aiProjectId: 'x' },
        }),
      ),
    );
    expect(shape.status).toBe(400);
    expect(shape.body.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['planner', 'findings']),
    );
    expect(await auditRows()).toEqual([]);
  });

  it("writes no record row when motir-ai refuses the create, and answers motir-ai's reason", async () => {
    const { token } = await staff('operator');
    const { plan } = await foreignPlan();
    client.createPlannerFindingRecord.mockRejectedValue(
      new (await aiErrors()).MotirAiBadRequestError("'findings[0].evidence' is required", 400),
    );
    const r = await routes();
    const res = await json(
      await r.records.POST(
        call('/records', token, {
          method: 'POST',
          body: { planId: plan.id, planner: 'hosted', findings: [FINDING_INPUT] },
        }),
      ),
    );
    expect(res).toEqual({
      status: 400,
      body: { code: 'UPSTREAM_REJECTED', detail: "'findings[0].evidence' is required" },
      cache: 'no-store',
    });
    expect((await auditRows()).map((row) => row.action)).toEqual(['estate.read']);
  });
});

describe("POST /records — the check's run-through answer is carried, never derived", () => {
  it('posts the answer and its cards on the record and writes the one record row as before', async () => {
    const { token } = await staff('operator');
    const { plan } = await foreignPlan();
    client.createPlannerFindingRecord.mockImplementation(async (req) => ({
      record: rawRecord({
        id: 'rec_ans',
        planId: req.record.planId,
        runThroughAnswer: req.record.runThroughAnswer ?? null,
        runThroughStopCards: req.record.runThroughStopCards ?? [],
      }),
      findings: [rawFinding({ recordId: 'rec_ans' })],
    }));
    const r = await routes();
    const res = await json(
      await r.records.POST(
        call('/records', token, {
          method: 'POST',
          body: {
            planId: plan.id,
            planner: 'plan_py',
            findings: [FINDING_INPUT],
            runThroughAnswer: 'STOPS',
            runThroughStopCards: ['MOTIR-7', 'planItem:abc'],
          },
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.record).toMatchObject({
      runThroughAnswer: 'STOPS',
      runThroughStopCards: ['MOTIR-7', 'planItem:abc'],
    });
    const sent = client.createPlannerFindingRecord.mock.calls[0]![0];
    expect(sent.record).toMatchObject({
      planId: plan.id,
      runThroughAnswer: 'STOPS',
      runThroughStopCards: ['MOTIR-7', 'planItem:abc'],
    });
    expect(sent.findings).toEqual([FINDING_INPUT]);
    const rows = (await auditRows()).filter((row) => row.action === 'planner_finding.record');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual(
      expect.objectContaining({ recordId: 'rec_ans', planId: plan.id, findingCount: 1 }),
    );
  });

  it('posts neither key when the body names neither, and passes a null answer back as null', async () => {
    const { token } = await staff('operator');
    const { plan } = await foreignPlan();
    client.createPlannerFindingRecord.mockResolvedValue({
      record: rawRecord({ planId: plan.id }),
      findings: [rawFinding()],
    });
    const r = await routes();
    const res = await json(
      await r.records.POST(
        call('/records', token, {
          method: 'POST',
          body: { planId: plan.id, planner: 'hosted', findings: [FINDING_INPUT] },
        }),
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body.record).toMatchObject({ runThroughAnswer: null, runThroughStopCards: [] });
    const sent = client.createPlannerFindingRecord.mock.calls[0]![0].record;
    expect(Object.keys(sent)).not.toContain('runThroughAnswer');
    expect(Object.keys(sent)).not.toContain('runThroughStopCards');
  });

  it.each([
    ['SETTLES as the answer', { runThroughAnswer: 'SETTLES' }, 'runThroughAnswer'],
    ['an unknown answer', { runThroughAnswer: 'maybe' }, 'runThroughAnswer'],
    ['a card list that is not an array', { runThroughStopCards: 'MOTIR-7' }, 'runThroughStopCards'],
    ['an empty card ref', { runThroughStopCards: ['MOTIR-7', '  '] }, 'runThroughStopCards.1'],
    ['a non-string card ref', { runThroughStopCards: [7] }, 'runThroughStopCards.0'],
    [
      'more cards than findings a record may hold',
      { runThroughStopCards: Array.from({ length: 101 }, (_, i) => `MOTIR-${i}`) },
      'runThroughStopCards',
    ],
  ])(
    'refuses %s with a 400 naming its path, no client call and no row',
    async (_n, extra, path) => {
      const { token } = await staff('operator');
      const r = await routes();
      const res = await json(
        await r.records.POST(
          call('/records', token, {
            method: 'POST',
            body: { planId: 'plan_x', planner: 'hosted', findings: [FINDING_INPUT], ...extra },
          }),
        ),
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
      expect(res.body.issues.map((i: { path: string }) => i.path)).toContain(path);
      expect(client.createPlannerFindingRecord).not.toHaveBeenCalled();
      expect(await auditRows()).toEqual([]);
    },
  );

  it('answers the stored pair on the list and the read, and the verdict posts neither key', async () => {
    const { token } = await staff('operator');
    const record = rawRecord({ runThroughAnswer: 'THRU', runThroughStopCards: [] });
    client.listPlannerFindingRecords.mockResolvedValue({
      records: [{ ...record, findingCount: 1, attributedCount: 0 }],
      nextCursor: null,
      retention: { days: 90, cutoff: NOW },
    });
    client.getPlannerFindingRecord.mockResolvedValue({ record, findings: [rawFinding()] });
    client.submitPlannerFindingRecordVerdict.mockResolvedValue({
      record: { ...record, verdictState: 'attributed' },
      findings: [rawFinding({ attribution: 'code' })],
      audit: [],
    });
    const r = await routes();
    const ctx = { params: Promise.resolve({ id: 'rec_1' }) };

    const list = await json(await r.records.GET(call('/records', token)));
    expect(list.body.records[0]).toMatchObject({
      runThroughAnswer: 'THRU',
      runThroughStopCards: [],
    });
    const read = await json(await r.record.GET(call('/records/rec_1', token), ctx));
    expect(read.body.record).toMatchObject({ runThroughAnswer: 'THRU', runThroughStopCards: [] });
    const verdict = await json(
      await r.verdict.POST(
        call('/records/rec_1/verdict', token, { method: 'POST', body: VERDICT }),
        {
          params: Promise.resolve({ id: 'rec_1' }),
        },
      ),
    );
    expect(verdict.body.record.runThroughAnswer).toBe('THRU');
    const posted = JSON.stringify(client.submitPlannerFindingRecordVerdict.mock.calls[0]);
    expect(posted).not.toContain('runThrough');
  });
});

// ── The verdict ─────────────────────────────────────────────────────────────

function verdictAudit(findingId: string, actor: string): RawPlannerFindingVerdictAudit {
  return {
    action: 'ai.planner_finding.verdict',
    findingId,
    actorCoreUserId: actor,
    at: NOW,
    before: { attribution: null },
    after: { attribution: 'code', why: 'The walker skipped the read.' },
  };
}

describe('POST /records/:id/verdict', () => {
  const ctx = () => ({ params: Promise.resolve({ id: 'rec_1' }) });

  it('forwards the verdict with the actor and writes one verdict row per changed finding', async () => {
    const { owner, token } = await staff('operator');
    client.submitPlannerFindingRecordVerdict.mockResolvedValue({
      record: rawRecord({ verdictState: 'attributed', coreOrganizationId: 'org_9' }),
      findings: [rawFinding({ id: 'pf_1' }), rawFinding({ id: 'pf_2', site: 'leaf:MOTIR-13' })],
      audit: [verdictAudit('pf_1', owner.id), verdictAudit('pf_2', owner.id)],
    });
    const r = await routes();
    const body = {
      verdicts: [
        { findingId: 'pf_1', attribution: 'code', why: 'The walker skipped the read.' },
        {
          findingId: 'pf_2',
          attribution: 'corpus',
          why: 'A pack says to.',
          hostedCell: 'author.story',
          planpyCell: 'author.story',
          fixDirection: 'Drop the line.',
        },
      ],
      replace: true,
    };

    const res = await json(
      await r.verdict.POST(call('/records/rec_1/verdict', token, { method: 'POST', body }), ctx()),
    );
    expect(res.status).toBe(200);
    expect(res.body.record.verdictState).toBe('attributed');
    expect(client.submitPlannerFindingRecordVerdict).toHaveBeenCalledWith('rec_1', body, owner.id);

    const rows = await auditRows();
    expect(rows.map((row) => [row.action, row.targetId, row.targetLabel])).toEqual([
      ['planner_finding.verdict', 'pf_1', 'leaf:MOTIR-12'],
      ['planner_finding.verdict', 'pf_2', 'leaf:MOTIR-13'],
    ]);
    expect(rows[0]).toMatchObject({
      organizationId: 'org_9',
      metadata: {
        recordId: 'rec_1',
        findingId: 'pf_1',
        before: { attribution: null },
        after: { attribution: 'code', why: 'The walker skipped the read.' },
      },
    });
  });

  it('writes one row on the record when the verdict changed no finding', async () => {
    const { token } = await staff('operator');
    client.submitPlannerFindingRecordVerdict.mockResolvedValue({
      record: rawRecord({ verdictState: 'attributed', planTitle: null }),
      findings: [rawFinding()],
      audit: [],
    });
    const r = await routes();
    await r.verdict.POST(
      call('/records/rec_1/verdict', token, { method: 'POST', body: VERDICT }),
      ctx(),
    );
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'planner_finding.verdict',
      targetId: 'rec_1',
      targetLabel: 'plan_1',
      metadata: expect.objectContaining({ recordId: 'rec_1', changedFindings: 0 }),
    });
    // The finding's own id the record did not change is not named as a target.
    expect(client.submitPlannerFindingRecordVerdict.mock.calls[0]![1]).toEqual(VERDICT);
  });

  it('labels a changed finding motir-ai did not echo back with no label', async () => {
    const { owner, token } = await staff('operator');
    client.submitPlannerFindingRecordVerdict.mockResolvedValue({
      record: rawRecord({ verdictState: 'attributed' }),
      findings: [],
      audit: [verdictAudit('pf_1', owner.id)],
    });
    const r = await routes();
    await r.verdict.POST(
      call('/records/rec_1/verdict', token, { method: 'POST', body: VERDICT }),
      ctx(),
    );
    expect((await auditRows())[0]?.targetLabel).toBeNull();
  });

  it.each([
    [
      'an already-attributed record without replace',
      (E: Awaited<ReturnType<typeof aiErrors>>) =>
        new E.MotirAiConflictError('record rec_1 already has a verdict'),
      409,
      { code: 'CONFLICT', detail: 'record rec_1 already has a verdict' },
    ],
    [
      'an unknown record',
      (E: Awaited<ReturnType<typeof aiErrors>>) => new E.PlannerFindingRecordNotFoundError('rec_1'),
      404,
      { code: 'PLANNER_FINDING_RECORD_NOT_FOUND', recordId: 'rec_1' },
    ],
    [
      'a verdict missing a finding',
      (E: Awaited<ReturnType<typeof aiErrors>>) =>
        new E.MotirAiBadRequestError('verdicts are missing: pf_2', 400),
      400,
      { code: 'UPSTREAM_REJECTED', detail: 'verdicts are missing: pf_2' },
    ],
    [
      'an outage',
      (E: Awaited<ReturnType<typeof aiErrors>>) => new E.MotirAiUnavailableError('down'),
      503,
      { code: 'UPSTREAM_UNAVAILABLE' },
    ],
  ])('writes no audit row for %s, and maps it', async (_n, error, status, body) => {
    const { token } = await staff('operator');
    client.submitPlannerFindingRecordVerdict.mockRejectedValue(error(await aiErrors()));
    const r = await routes();
    const res = await json(
      await r.verdict.POST(
        call('/records/rec_1/verdict', token, { method: 'POST', body: VERDICT }),
        ctx(),
      ),
    );
    expect({ status: res.status, body: res.body }).toEqual({ status, body });
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a malformed verdict before motir-ai is called', async () => {
    const { token } = await staff('operator');
    const r = await routes();
    const res = await json(
      await r.verdict.POST(
        call('/records/rec_1/verdict', token, {
          method: 'POST',
          body: { verdicts: [{ findingId: 'pf_1', attribution: 'luck', why: '' }], replace: 'yes' },
        }),
        ctx(),
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['verdicts.0.attribution', 'verdicts.0.why', 'replace']),
    );
    expect(client.submitPlannerFindingRecordVerdict).not.toHaveBeenCalled();
  });

  it('re-throws an error the map does not know, so Next answers 500', async () => {
    const { token } = await staff('operator');
    client.submitPlannerFindingRecordVerdict.mockRejectedValue(new TypeError('boom'));
    const r = await routes();
    await expect(
      r.verdict.POST(
        call('/records/rec_1/verdict', token, { method: 'POST', body: VERDICT }),
        ctx(),
      ),
    ).rejects.toThrow('boom');
  });
});

describe('the records service re-checks the level the gate resolved', () => {
  it('admits a support actor to the three reads, which ask for the read level', async () => {
    const { plannerFindingRecordsService } = await import('@/lib/services/plannerFindingsService');
    answerEveryCall('org_1');
    // A real user: the audited read appends a row naming its actor.
    const { owner } = await staff('support');
    const actor = {
      userId: owner.id,
      email: owner.email,
      role: 'support' as const,
      credential: { kind: 'session' as const },
    };
    await expect(plannerFindingRecordsService.getFinding(actor, 'pf_1')).resolves.toMatchObject({
      id: 'pf_1',
    });
    await expect(plannerFindingRecordsService.listRecords(actor, {})).resolves.toMatchObject({
      records: [expect.objectContaining({ id: 'rec_1' })],
    });
    await expect(plannerFindingRecordsService.getRecord(actor, 'rec_1')).resolves.toMatchObject({
      record: { id: 'rec_1' },
    });
  });

  it('refuses a support actor every write, before any motir-ai call', async () => {
    const { plannerFindingRecordsService } = await import('@/lib/services/plannerFindingsService');
    const { NotPlatformStaffError } = await import('@/lib/platform/errors');
    const actor = {
      userId: 'u_sp',
      email: 'sp@moooon.net',
      role: 'support' as const,
      credential: { kind: 'session' as const },
    };
    await expect(
      plannerFindingRecordsService.createRecord(actor, {
        planner: 'hosted',
        projectKey: 'PROD',
        findings: [FINDING_INPUT],
      } as never),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    await expect(
      plannerFindingRecordsService.submitVerdict(actor, 'rec_1', VERDICT as never),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([]);
  });
});
