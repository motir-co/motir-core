import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawPlannerFinding } from '@/lib/ai/motirAiClient';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  PRICED_JOB_RESULT,
  plannerFindingsFake,
  problem,
  json,
  recordedFinding,
  type PlannerFindingsFake,
} from '../fixtures/motirAiContract/plannerFindings';

/**
 * Story MOTIR-10353's INTEGRATION GATE, services half (MOTIR-10527): the
 * planner-findings READ service and TRIAGE service, over real Postgres, with the
 * REAL `requirePlatformStaff` (only `getSession` is mocked — the test
 * environment has no cookies, as `fleetConsoleGate.test.ts` does), the real
 * `withPlatformWrite` audit append, and the real motir-ai client and mappers.
 * motir-ai is faked at `fetch` by the small stateful store in
 * `tests/fixtures/motirAiContract/plannerFindings.ts`; nothing in `lib/` is mocked.
 *
 * What only this stack shows: the gate refuses every non-staff kind before any
 * motir-ai call; a `planner_finding.triage` row lands exactly when motir-ai
 * reports a change; the promote sequence across two systems; and the reads never
 * turn an unreadable motir-ai into an empty answer.
 *
 * NOT REACHABLE HERE, and owned by the unit tests: the residual case where
 * motir-ai applied a triage and core's audit commit then failed (no honest input
 * makes the append fail after the remote write; `plannerFindingsTriageService.test.ts`
 * asserts its log line), and the actions' `FAILED` code (the actions half's file
 * names why).
 */

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const { db } = await import('@/lib/db');
const { plannerFindingsService } = await import('@/lib/services/plannerFindingsService');
const { plannerFindingsTriageService } =
  await import('@/lib/services/plannerFindingsTriageService');
const { NotPlatformStaffError, PlannerFindingLessonNotLinkedError, PlannerFindingUnchangedError } =
  await import('@/lib/platform/errors');
const {
  MotirAiBadRequestError,
  MotirAiConflictError,
  MotirAiUnavailableError,
  PlannerFindingNotFoundError,
} = await import('@/lib/ai/errors');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

interface World {
  org: string;
  ws: string;
  project: string;
  nonStaff: Record<'noRole' | 'workspaceMember' | 'orgOwner', string>;
  operator: string;
  support: string;
}

let world: World;
let fake: PlannerFindingsFake;
let fetchSpy: ReturnType<typeof vi.fn>;

/** A finding of the seeded project — its tenant ids are real rows. */
function finding(id: string, over: Partial<RawPlannerFinding> = {}): RawPlannerFinding {
  return recordedFinding({
    id,
    coreOrganizationId: world.org,
    coreWorkspaceId: world.ws,
    coreProjectId: world.project,
    ...over,
  });
}

function install(seed: RawPlannerFinding[]): PlannerFindingsFake {
  fake = plannerFindingsFake(seed);
  fetchSpy = vi.fn((input: string | URL, init?: RequestInit) => fake.fetch(input, init));
  vi.stubGlobal('fetch', fetchSpy);
  return fake;
}

async function staff(role: 'support' | 'operator', name: string): Promise<string> {
  const user = await createTestUser({ email: `ops+pf-${role}@moooon.net`, name });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return user.id;
}

const as = (userId: string | null) => {
  currentSession = userId ? { user: { id: userId } } : null;
};

const auditRows = () => adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } });
const auditCount = () => adminDb.platformAuditLog.count();
const methods = () => fake.calls.map((c) => `${c.method} ${c.path}`);

/** A principal the caller could hand in; the services must never trust it. */
const FORGED: PlatformPrincipal = { userId: 'forged', email: 'x@evil.test', role: 'superadmin' };

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme Space' });
  const project = await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Rocket',
  });
  const member = await createTestUser({ email: 'member@acme.test' });
  await workspacesService.addMember({
    userId: member.id,
    workspaceId: workspace.id,
    workspaceRole: 'member',
  });
  const loner = await createTestUser({ email: 'nobody@example.test' });
  world = {
    org: workspace.organizationId,
    ws: workspace.id,
    project: project.id,
    nonStaff: { noRole: loner.id, workspaceMember: member.id, orgOwner: owner.id },
    // Neither staff user is a member of the finding's organisation.
    operator: await staff('operator', 'Olive Operator'),
    support: await staff('support', 'Sam Support'),
  };
  install([]);
  as(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const PROMOTE_FORM = {
  mistakeType: '  regular_planning ',
  title: ' leaf:ACME-12 ',
  why: ' The leaf named a test file that does not exist. ',
  howToApply: ' Read the path before naming it. ',
};

// ── The gate ─────────────────────────────────────────────────────────────────

describe('the gate', () => {
  it('follows the session between calls: an operator write, then a support one refused', async () => {
    install([finding('pf_a'), finding('pf_b')]);
    as(world.operator);
    await expect(plannerFindingsTriageService.dismiss(FORGED, 'pf_a')).resolves.toMatchObject({
      finding: { status: 'dismissed' },
    });
    const patches = () => fake.calls.filter((c) => c.method === 'PATCH').length;
    expect(patches()).toBe(1);

    as(world.support);
    await expect(plannerFindingsTriageService.dismiss(FORGED, 'pf_b')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(patches()).toBe(1);
    expect(fake.findings.get('pf_b')!.status).toBe('new');
  });

  const KINDS = ['noSession', 'noRole', 'workspaceMember', 'orgOwner'] as const;
  const reads = [
    ['list', () => plannerFindingsService.list(FORGED, {})],
    ['listGroups', () => plannerFindingsService.listGroups(FORGED, {})],
    ['getGroup', () => plannerFindingsService.getGroup(FORGED, 'fp_pf_a', {})],
    ['listGroupFindings', () => plannerFindingsService.listGroupFindings(FORGED, 'fp_pf_a', {})],
    ['get', () => plannerFindingsService.get(FORGED, 'pf_a')],
  ] as const;
  const writes = [
    [
      'setAttribution',
      () => plannerFindingsTriageService.setAttribution(FORGED, 'pf_a', { attribution: 'corpus' }),
    ],
    ['recordBugKey', () => plannerFindingsTriageService.recordBugKey(FORGED, 'pf_a', 'MOTIR-1')],
    ['dismiss', () => plannerFindingsTriageService.dismiss(FORGED, 'pf_a', 'noise')],
    ['restore', () => plannerFindingsTriageService.restore(FORGED, 'pf_d')],
    [
      'promoteToLesson',
      () => plannerFindingsTriageService.promoteToLesson(FORGED, 'pf_a', PROMOTE_FORM),
    ],
  ] as const;

  it.each(KINDS)(
    '%s — all ten methods refuse a forged superadmin principal before any motir-ai call',
    async (kind) => {
      install([finding('pf_a'), finding('pf_d', { status: 'dismissed' })]);
      const before = fake.snapshot();
      as(kind === 'noSession' ? null : world.nonStaff[kind]);
      for (const [name, call] of [...reads, ...writes]) {
        await expect(call(), name).rejects.toBeInstanceOf(NotPlatformStaffError);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await auditCount()).toBe(0);
      expect(fake.snapshot()).toBe(before);
      expect(fake.lessons).toEqual([]);
    },
  );

  it('support may read but every write is refused before any motir-ai call', async () => {
    install([finding('pf_a'), finding('pf_d', { status: 'dismissed' })]);
    as(world.support);
    for (const [name, call] of writes) {
      await expect(call(), name).rejects.toBeInstanceOf(NotPlatformStaffError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(plannerFindingsService.list(FORGED, {})).resolves.toMatchObject({
      findings: [{ id: 'pf_a' }],
    });
    expect(await auditCount()).toBe(0);
  });
});

// ── The audit rows ───────────────────────────────────────────────────────────

describe('each write appends exactly one planner_finding.triage row', () => {
  const DEFAULT_REASON = /from \/admin\/planner-findings\.$/;

  async function onlyRow() {
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  function expectRow(row: Awaited<ReturnType<typeof onlyRow>>, f: RawPlannerFinding) {
    expect(row).toMatchObject({
      action: 'planner_finding.triage',
      targetKind: 'platform',
      targetId: f.id,
      targetLabel: f.site,
      organizationId: world.org,
      actorUserId: world.operator,
      actorRole: 'operator',
    });
    expect(row.reason?.trim()).toBeTruthy();
  }

  beforeEach(() => as(world.operator));

  it('attribution: the PATCH body, the re-read and the row', async () => {
    const f = finding('pf_attr');
    install([f]);
    const { finding: row } = await plannerFindingsTriageService.setAttribution(FORGED, f.id, {
      attribution: 'corpus',
    });
    expect(row.attribution).toBe('corpus');
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      attribution: 'corpus',
      actorCoreUserId: world.operator,
    });
    const audit = await onlyRow();
    expectRow(audit, f);
    expect(audit.reason).toMatch(DEFAULT_REASON);
    expect(audit.metadata).toEqual({
      findingId: f.id,
      before: { attribution: null },
      after: { attribution: 'corpus' },
    });
    const { detail } = await plannerFindingsService.get(FORGED, f.id);
    expect(detail.attribution).toBe('corpus');
    expect(await auditCount()).toBe(1);
  });

  it('bug key: `motir-123` is recorded as MOTIR-123', async () => {
    const f = finding('pf_bug');
    install([f]);
    await plannerFindingsTriageService.recordBugKey(FORGED, f.id, ' motir-123 ');
    const audit = await onlyRow();
    expectRow(audit, f);
    expect(audit.reason).toMatch(DEFAULT_REASON);
    expect(audit.metadata).toEqual({
      findingId: f.id,
      before: { status: 'new', bugKey: null },
      after: { status: 'filed_as_bug', bugKey: 'MOTIR-123' },
    });
  });

  it('dismiss with a note: the trimmed note is the reason', async () => {
    const f = finding('pf_dis');
    install([f]);
    await plannerFindingsTriageService.dismiss(FORGED, f.id, '  A duplicate of an older finding. ');
    const audit = await onlyRow();
    expectRow(audit, f);
    expect(audit.reason).toBe('A duplicate of an older finding.');
    expect(audit.metadata).toEqual({
      findingId: f.id,
      before: { status: 'new', triageNote: null },
      after: { status: 'dismissed', triageNote: 'A duplicate of an older finding.' },
    });
  });

  it('dismiss with a whitespace-only note: the default reason, no note', async () => {
    const f = finding('pf_dis_blank');
    install([f]);
    await plannerFindingsTriageService.dismiss(FORGED, f.id, '   ');
    const audit = await onlyRow();
    expectRow(audit, f);
    expect(audit.reason).toMatch(DEFAULT_REASON);
    expect(audit.metadata).toEqual({
      findingId: f.id,
      before: { status: 'new' },
      after: { status: 'dismissed' },
    });
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).not.toHaveProperty('note');
  });

  it('restore of a dismissed finding', async () => {
    const f = finding('pf_res', { status: 'dismissed', triageNote: 'noise' });
    install([f]);
    const { finding: row } = await plannerFindingsTriageService.restore(FORGED, f.id);
    expect(row.status).toBe('new');
    const audit = await onlyRow();
    expectRow(audit, f);
    expect(audit.reason).toMatch(DEFAULT_REASON);
    expect(audit.metadata).toEqual({
      findingId: f.id,
      before: { status: 'dismissed', triageNote: 'noise' },
      after: { status: 'new', triageNote: null },
    });
  });

  it('promote', async () => {
    const f = finding('pf_pro');
    install([f]);
    await plannerFindingsTriageService.promoteToLesson(FORGED, f.id, PROMOTE_FORM);
    const audit = await onlyRow();
    expectRow(audit, f);
    expect(audit.reason).toMatch(DEFAULT_REASON);
    expect(audit.metadata).toEqual({
      findingId: f.id,
      before: { status: 'new', lessonId: null },
      after: { status: 'promoted_to_lesson', lessonId: 'lsn_fake_1' },
    });
  });
});

describe('a write that changes nothing, or that motir-ai refuses, leaves no row', () => {
  beforeEach(() => as(world.operator));

  it('a same-value attribution and a restore of a finding that is not dismissed', async () => {
    install([finding('pf_same', { attribution: 'corpus' }), finding('pf_new')]);
    await expect(
      plannerFindingsTriageService.setAttribution(FORGED, 'pf_same', { attribution: 'corpus' }),
    ).rejects.toBeInstanceOf(PlannerFindingUnchangedError);
    await expect(plannerFindingsTriageService.restore(FORGED, 'pf_new')).rejects.toBeInstanceOf(
      PlannerFindingUnchangedError,
    );
    expect(fake.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
    expect(await auditCount()).toBe(0);
  });

  it('a 400 validation_error and a 404 for an unknown id', async () => {
    install([finding('pf_a')]);
    fake.override((c) =>
      c.method === 'PATCH'
        ? problem(400, 'validation_error', 'whyPlanner is not a field')
        : undefined,
    );
    await expect(
      plannerFindingsTriageService.setAttribution(FORGED, 'pf_a', { attribution: 'corpus' }),
    ).rejects.toBeInstanceOf(MotirAiBadRequestError);
    fake.override(null);
    await expect(plannerFindingsTriageService.dismiss(FORGED, 'pf_gone')).rejects.toBeInstanceOf(
      PlannerFindingNotFoundError,
    );
    expect(await auditCount()).toBe(0);
    expect(fake.findings.get('pf_a')!.attribution).toBeNull();
  });

  it('a transport failure and a malformed 200', async () => {
    install([finding('pf_a')]);
    const before = fake.snapshot();
    fake.override(() => {
      throw new TypeError('fetch failed');
    });
    await expect(plannerFindingsTriageService.dismiss(FORGED, 'pf_a')).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
    fake.override(() => json({ audit: null }));
    await expect(plannerFindingsTriageService.dismiss(FORGED, 'pf_a')).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
    expect(await auditCount()).toBe(0);
    expect(fake.snapshot()).toBe(before);
  });
});

// ── Promote across two systems ───────────────────────────────────────────────

describe('promote', () => {
  beforeEach(() => as(world.operator));

  it('reads, creates the lesson in the finding’s own project, then links it', async () => {
    const f = finding('pf_pro');
    install([f]);
    const { finding: row } = await plannerFindingsTriageService.promoteToLesson(
      FORGED,
      f.id,
      PROMOTE_FORM,
    );

    expect(methods()).toEqual([
      'GET /v1/admin/planner-findings/pf_pro',
      'POST /v1/lessons',
      'PATCH /v1/admin/planner-findings/pf_pro',
    ]);
    expect(fake.lessons).toHaveLength(1);
    expect(fake.lessons[0]!.request).toEqual({
      coreOrganizationId: world.org,
      coreWorkspaceId: world.ws,
      coreProjectId: world.project,
      mistakeType: 'regular_planning',
      title: 'leaf:ACME-12',
      body: f.whatHappened,
      why: 'The leaf named a test file that does not exist.',
      howToApply: 'Read the path before naming it.',
    });
    expect(fake.calls[2]!.body).toEqual({
      status: 'promoted_to_lesson',
      lessonId: 'lsn_fake_1',
      actorCoreUserId: world.operator,
    });
    expect(row).toMatchObject({ status: 'promoted_to_lesson', lessonId: 'lsn_fake_1' });
    expect(await auditCount()).toBe(1);

    const { detail } = await plannerFindingsService.get(FORGED, f.id);
    expect(detail).toMatchObject({ status: 'promoted_to_lesson', lessonId: 'lsn_fake_1' });
  });

  it('a 409 near-duplicate refusal is a conflict; no PATCH, no row, still new', async () => {
    install([finding('pf_dup')]);
    fake.override((c) =>
      c.path === '/v1/lessons'
        ? problem(409, 'conflict', 'A lesson like this exists: lsn_existing')
        : undefined,
    );
    const err = await plannerFindingsTriageService
      .promoteToLesson(FORGED, 'pf_dup', PROMOTE_FORM)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MotirAiConflictError);
    expect((err as InstanceType<typeof MotirAiConflictError>).detail).toContain('lsn_existing');
    expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(await auditCount()).toBe(0);
    expect(fake.findings.get('pf_dup')!.status).toBe('new');
  });

  it.each([
    ['a 500', () => problem(500, 'internal_error', 'boom')],
    ['an audit: null answer', () => json({ finding: fake.findings.get('pf_link'), audit: null })],
  ])('a failed link after the create (%s) is LESSON_NOT_LINKED, created once', async (_n, fail) => {
    install([finding('pf_link')]);
    fake.override((c) => (c.method === 'PATCH' ? fail() : undefined));
    const err = await plannerFindingsTriageService
      .promoteToLesson(FORGED, 'pf_link', PROMOTE_FORM)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerFindingLessonNotLinkedError);
    expect(err).toMatchObject({ lessonId: 'lsn_fake_1' });
    expect(fake.calls.filter((c) => c.path === '/v1/lessons')).toHaveLength(1);
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await auditCount()).toBe(0);
    expect(fake.findings.get('pf_link')!.lessonId).toBeNull();
  });

  it('a finding already promoted is unchanged, with neither a create nor a PATCH', async () => {
    install([finding('pf_done', { status: 'promoted_to_lesson', lessonId: 'lsn_old' })]);
    await expect(
      plannerFindingsTriageService.promoteToLesson(FORGED, 'pf_done', PROMOTE_FORM),
    ).rejects.toBeInstanceOf(PlannerFindingUnchangedError);
    expect(methods()).toEqual(['GET /v1/admin/planner-findings/pf_done']);
    expect(await auditCount()).toBe(0);
  });
});

// ── The reads ────────────────────────────────────────────────────────────────

describe('the reads', () => {
  beforeEach(() => as(world.support));

  it('send the default view, a status alone, neither, and drop a value outside its set', async () => {
    install([]);
    await plannerFindingsService.list(FORGED, {});
    await plannerFindingsService.list(FORGED, { status: 'dismissed' });
    await plannerFindingsService.list(FORGED, { status: 'all' });
    for (const status of ['new', 'promoted_to_lesson', 'filed_as_bug']) {
      await plannerFindingsService.list(FORGED, { status });
    }
    await plannerFindingsService.list(FORGED, { source: 'bogus' });
    expect(fake.calls.map((c) => c.query)).toEqual([
      { limit: '50', excludeStatus: 'dismissed' },
      { limit: '50', status: 'dismissed' },
      { limit: '50' },
      { limit: '50', status: 'new' },
      { limit: '50', status: 'promoted_to_lesson' },
      { limit: '50', status: 'filed_as_bug' },
      { limit: '50', excludeStatus: 'dismissed' },
    ]);
    expect(await auditCount()).toBe(0);
  });

  it('two pages chained by nextCursor reach every row, and write no audit row', async () => {
    // The service's page is fixed at 50, so 51 rows make two pages.
    const seed = Array.from({ length: 51 }, (_, i) =>
      finding(`pf_${String(i).padStart(2, '0')}`, {
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
      }),
    );
    install(seed);
    const one = await plannerFindingsService.list(FORGED, {});
    expect(one.findings).toHaveLength(50);
    expect(one.nextCursor).not.toBeNull();
    const two = await plannerFindingsService.list(FORGED, { cursor: one.nextCursor! });
    expect(two.findings).toHaveLength(1);
    expect(two.nextCursor).toBeNull();
    expect(new Set([...one.findings, ...two.findings].map((f) => f.id))).toEqual(
      new Set(seed.map((f) => f.id)),
    );
    expect(await auditCount()).toBe(0);
  });

  it('a group’s counts equal the findings it opens; a dismissed-only group is hidden', async () => {
    install([
      finding('pf_g1', { fingerprint: 'fp_shared', planId: 'plan_1' }),
      finding('pf_g2', {
        fingerprint: 'fp_shared',
        planId: 'plan_2',
        createdAt: '2026-11-02T10:00:00.000Z',
      }),
      finding('pf_g3', { fingerprint: 'fp_hidden', status: 'dismissed' }),
    ]);
    const groups = await plannerFindingsService.listGroups(FORGED, {});
    expect(groups.groups.map((g) => g.fingerprint)).toEqual(['fp_shared']);
    expect(groups.groups[0]).toMatchObject({ findingCount: 2, planCount: 2 });

    const group = await plannerFindingsService.getGroup(FORGED, 'fp_shared', {});
    expect(group).toEqual(groups.groups[0]);
    expect(await plannerFindingsService.getGroup(FORGED, 'fp_unknown', {})).toBeNull();

    const opened = await plannerFindingsService.listGroupFindings(FORGED, 'fp_shared', {});
    expect(fake.calls.at(-1)!.query).toMatchObject({
      fingerprint: 'fp_shared',
      excludeStatus: 'dismissed',
    });
    expect(opened.findings).toHaveLength(group!.findingCount);
    expect(new Set(opened.findings.map((f) => f.planId)).size).toBe(group!.planCount);
    expect(await auditCount()).toBe(0);
  });

  it('a plan that exists nowhere in motir-core is listed, opened by its group and in full', async () => {
    const f = finding('pf_orphan', {
      planId: 'plan_deleted_long_ago',
      planTitle: 'A plan nobody stored',
      fingerprint: 'fp_orphan',
    });
    install([f]);
    expect(await adminDb.plan.count({ where: { id: f.planId } })).toBe(0);
    const want = { planId: 'plan_deleted_long_ago', planTitle: 'A plan nobody stored' };
    expect((await plannerFindingsService.list(FORGED, {})).findings[0]).toMatchObject(want);
    expect(
      (await plannerFindingsService.listGroupFindings(FORGED, 'fp_orphan', {})).findings[0],
    ).toMatchObject(want);
    expect((await plannerFindingsService.get(FORGED, f.id)).detail).toMatchObject(want);
  });

  it('triagedByName resolves a staff user outside the org, and null otherwise', async () => {
    install([
      finding('pf_t1', { triagedBy: world.operator, triagedAt: '2026-11-03T10:00:00.000Z' }),
      finding('pf_t2', { triagedBy: 'user_nobody', triagedAt: '2026-11-03T10:00:00.000Z' }),
      finding('pf_t3'),
    ]);
    expect(await adminDb.organizationMembership.count({ where: { userId: world.operator } })).toBe(
      0,
    );
    expect((await plannerFindingsService.get(FORGED, 'pf_t1')).triagedByName).toBe(
      'Olive Operator',
    );
    expect((await plannerFindingsService.get(FORGED, 'pf_t2')).triagedByName).toBeNull();
    expect((await plannerFindingsService.get(FORGED, 'pf_t3')).triagedByName).toBeNull();
  });
});

describe('the cost', () => {
  beforeEach(() => as(world.support));

  it('priced review and repair lines are copied unchanged, with the counts and no total', async () => {
    install([finding('pf_c', { jobId: 'job_1' })]);
    fake.jobs.set('job_1', { status: 'succeeded', result: PRICED_JOB_RESULT });
    const { detail } = await plannerFindingsService.get(FORGED, 'pf_c');
    expect(detail.cost).toEqual({
      findingsMade: 5,
      findingsFixed: 4,
      lines: [
        {
          stage: 'review',
          model: 'claude-opus',
          inputTokens: 120_000,
          outputTokens: 9_000,
          sessions: 3,
          costMicroUsd: 2_475_000,
        },
        {
          stage: 'repair',
          model: 'claude-opus',
          inputTokens: 40_000,
          outputTokens: 6_000,
          sessions: 2,
          costMicroUsd: 1_050_000,
        },
      ],
    });
    expect(fake.calls.find((c) => c.path === '/v1/jobs/job_1')!.query).toMatchObject({
      coreProjectId: world.project,
    });
  });

  it('a null costMicroUsd survives as null', async () => {
    install([finding('pf_c', { jobId: 'job_1' })]);
    const [review] = PRICED_JOB_RESULT.stageUsage!;
    fake.jobs.set('job_1', {
      status: 'succeeded',
      result: { stageUsage: [{ ...review!, costMicroUsd: null }] },
    });
    const { detail } = await plannerFindingsService.get(FORGED, 'pf_c');
    expect(detail.cost!.lines).toEqual([expect.objectContaining({ costMicroUsd: null })]);
    expect(detail.cost).toMatchObject({ findingsMade: null, findingsFixed: null });
  });

  it.each([
    ['no stageUsage', { dryRun: PRICED_JOB_RESULT.dryRun }],
    ['an empty stageUsage', { stageUsage: [] }],
  ])('%s gives cost null and the finding', async (_n, result) => {
    install([finding('pf_c', { jobId: 'job_1' })]);
    fake.jobs.set('job_1', { status: 'succeeded', result });
    const { detail } = await plannerFindingsService.get(FORGED, 'pf_c');
    expect(detail.cost).toBeNull();
    expect(detail.id).toBe('pf_c');
  });

  it('no jobId gives cost null with no job request', async () => {
    install([finding('pf_c')]);
    const { detail } = await plannerFindingsService.get(FORGED, 'pf_c');
    expect(detail.cost).toBeNull();
    expect(fake.calls.some((c) => c.path.startsWith('/v1/jobs/'))).toBe(false);
  });

  it('a failing job read gives cost null and the finding', async () => {
    install([finding('pf_c', { jobId: 'job_1' })]);
    fake.override((c) =>
      c.path.startsWith('/v1/jobs/') ? problem(500, 'internal_error', 'boom') : undefined,
    );
    const { detail } = await plannerFindingsService.get(FORGED, 'pf_c');
    expect(detail.cost).toBeNull();
    expect(detail.id).toBe('pf_c');
  });
});

describe('an unreadable motir-ai is never an empty answer', () => {
  beforeEach(() => as(world.support));

  const reads = [
    ['list', () => plannerFindingsService.list(FORGED, {})],
    ['listGroups', () => plannerFindingsService.listGroups(FORGED, {})],
    ['getGroup', () => plannerFindingsService.getGroup(FORGED, 'fp_x', {})],
    ['listGroupFindings', () => plannerFindingsService.listGroupFindings(FORGED, 'fp_x', {})],
    ['get', () => plannerFindingsService.get(FORGED, 'pf_x')],
  ] as const;

  it.each([
    [
      'the transport throws',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    ['a 503 problem', () => problem(503, 'service_unavailable', 'down')],
    ['a malformed 200', () => json({ nothing: true })],
  ])('%s — each read rejects with MotirAiUnavailableError', async (_n, answer) => {
    install([finding('pf_x', { fingerprint: 'fp_x' })]);
    fake.override(answer);
    for (const [name, read] of reads) {
      await expect(read(), name).rejects.toBeInstanceOf(MotirAiUnavailableError);
    }
  });

  it('an unknown id rejects with PlannerFindingNotFoundError', async () => {
    install([]);
    await expect(plannerFindingsService.get(FORGED, 'pf_unknown')).rejects.toBeInstanceOf(
      PlannerFindingNotFoundError,
    );
  });
});
