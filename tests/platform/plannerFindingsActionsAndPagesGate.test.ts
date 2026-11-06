import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import type { RawPlannerFinding } from '@/lib/ai/motirAiClient';
import {
  PRICED_JOB_RESULT,
  json,
  plannerFindingsFake,
  problem,
  recordedFinding,
  type PlannerFindingsFake,
} from '../fixtures/motirAiContract/plannerFindings';

/**
 * Story MOTIR-10353's INTEGRATION GATE, actions-and-pages half (MOTIR-10527):
 * the five triage Server Actions, the `(admin)` layout and the list, group and
 * detail pages, over real Postgres with the REAL `requirePlatformStaff` (only
 * `getSession` is mocked, as `fleetConsoleGate.test.ts` does) and motir-ai faked
 * at `fetch` by `tests/fixtures/motirAiContract/plannerFindings.ts`. No service,
 * action, client module or write context is mocked; `revalidatePath` is a spy,
 * `notFound` throws a sentinel, and next-intl serves the real `en` catalogue.
 *
 * NOT REACHABLE HERE, and owned by the unit tests: the actions' `FAILED` code —
 * it answers only an error that is neither a gate, validation, state nor
 * motir-ai error, which needs a defect (say, an audit row with no reason) the
 * triage service's own reason rule prevents; `plannerFindingsActions.test.ts`
 * asserts the mapping. Nor the residual case where motir-ai applied a triage and
 * core's audit commit then failed, which no honest input causes after the remote
 * write; `plannerFindingsTriageService.test.ts` asserts its log line.
 *
 * The `(admin)` layout's staff path (its two-factor gate and `console.open` row)
 * is not exercised: only its 404 for non-staff is a claim of this gate.
 */

let currentSession: { user: { id: string } } | null = null;

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: vi.fn(() => {
    throw new NotFoundSentinel();
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { db } = await import('@/lib/db');
const { revalidatePath } = await import('next/cache');
const actions = await import('@/app/(admin)/admin/planner-findings/actions');
const { default: AdminLayout } = await import('@/app/(admin)/layout');
const { default: ListPage } = await import('@/app/(admin)/admin/planner-findings/page');
const { default: GroupPage } =
  await import('@/app/(admin)/admin/planner-findings/groups/[fingerprint]/page');
const { default: DetailPage } = await import('@/app/(admin)/admin/planner-findings/[id]/page');
const { FindingTriageControls } =
  await import('@/app/(admin)/admin/planner-findings/_components/FindingTriageControls');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { renderToHtml, walk } = await import('../helpers/serverPageHarness');

interface World {
  org: string;
  ws: string;
  nonStaff: Record<'noRole' | 'workspaceMember' | 'orgOwner', string>;
  operator: string;
  support: string;
}

let world: World;
let fake: PlannerFindingsFake;
let fetchSpy: ReturnType<typeof vi.fn>;

function finding(id: string, over: Partial<RawPlannerFinding> = {}): RawPlannerFinding {
  return recordedFinding({
    id,
    coreOrganizationId: world.org,
    coreWorkspaceId: world.ws,
    coreProjectId: 'proj_of_the_finding',
    ...over,
  });
}

function install(seed: RawPlannerFinding[]): PlannerFindingsFake {
  fake = plannerFindingsFake(seed);
  fetchSpy = vi.fn((input: string | URL, init?: RequestInit) => fake.fetch(input, init));
  vi.stubGlobal('fetch', fetchSpy);
  return fake;
}

async function staff(role: 'support' | 'operator'): Promise<string> {
  const user = await createTestUser({ email: `ops+pfgate-${role}@moooon.net`, name: role });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return user.id;
}

const as = (userId: string | null) => {
  currentSession = userId ? { user: { id: userId } } : null;
};
const auditCount = () => adminDb.platformAuditLog.count();
const revalidated = () => vi.mocked(revalidatePath).mock.calls;

const FORM = {
  mistakeType: 'regular_planning',
  title: 'leaf:ACME-12',
  why: 'The leaf named a file that does not exist.',
  howToApply: 'Read the path before naming it.',
};

/** The five actions, each on the finding it would change. */
const FIVE = [
  [
    'attribution',
    () => actions.setPlannerFindingAttributionAction('pf_a', { attribution: 'corpus' }),
  ],
  ['promote', () => actions.promotePlannerFindingAction('pf_b', FORM)],
  ['bug key', () => actions.recordPlannerFindingBugKeyAction('pf_c', 'MOTIR-123')],
  ['dismiss', () => actions.dismissPlannerFindingAction('pf_d', 'noise')],
  ['restore', () => actions.restorePlannerFindingAction('pf_r')],
] as const;

const fiveFindings = () => [
  finding('pf_a'),
  finding('pf_b'),
  finding('pf_c'),
  finding('pf_d'),
  finding('pf_r', { status: 'dismissed' }),
];

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme Space' });
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
    nonStaff: { noRole: loner.id, workspaceMember: member.id, orgOwner: owner.id },
    operator: await staff('operator'),
    support: await staff('support'),
  };
  install([]);
  as(null);
  vi.mocked(revalidatePath).mockClear();
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

const KINDS = ['noSession', 'noRole', 'workspaceMember', 'orgOwner'] as const;
const sessionOf = (kind: (typeof KINDS)[number]) =>
  kind === 'noSession' ? null : world.nonStaff[kind];

// ── The refusals ─────────────────────────────────────────────────────────────

describe('the five actions refuse non-staff and support', () => {
  it.each([...KINDS, 'support'] as const)(
    '%s — NOT_PERMITTED, with no call, row, revalidation or lesson',
    async (kind) => {
      install(fiveFindings());
      const before = fake.snapshot();
      as(kind === 'support' ? world.support : sessionOf(kind));
      for (const [name, act] of FIVE) {
        expect(await act(), name).toEqual({ ok: false, code: 'NOT_PERMITTED' });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await auditCount()).toBe(0);
      expect(revalidatePath).not.toHaveBeenCalled();
      expect(fake.snapshot()).toBe(before);
      expect(fake.lessons).toEqual([]);
    },
  );

  it('the gate is not vacuous: an operator passes all five; support reads the list', async () => {
    install(fiveFindings());
    as(world.operator);
    for (const [name, act] of FIVE) {
      expect(await act(), name).toMatchObject({ ok: true, finding: expect.any(Object) });
    }
    expect(revalidated()).toHaveLength(5);
    for (const call of revalidated()) expect(call).toEqual(['/admin/planner-findings', 'layout']);
    expect(await auditCount()).toBe(5);

    as(world.support);
    const html = await renderToHtml(
      await ListPage({ searchParams: Promise.resolve({ view: 'all' }) }),
    );
    expect(html).toContain('data-testid="planner-findings-card"');
  });
});

describe('the layout and the three pages give non-staff the 404 before any read', () => {
  it.each(KINDS)('%s — every surface rejects with the sentinel', async (kind) => {
    install([finding('pf_a')]);
    as(sessionOf(kind));
    await expect(AdminLayout({ children: null })).rejects.toBeInstanceOf(NotFoundSentinel);
    for (const view of ['all', 'grouped']) {
      await expect(ListPage({ searchParams: Promise.resolve({ view }) })).rejects.toBeInstanceOf(
        NotFoundSentinel,
      );
    }
    await expect(
      GroupPage({
        params: Promise.resolve({ fingerprint: 'fp_pf_a' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toBeInstanceOf(NotFoundSentinel);
    await expect(DetailPage({ params: Promise.resolve({ id: 'pf_a' }) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── What each result code means, from real refusals ──────────────────────────

describe('the result codes', () => {
  beforeEach(() => as(world.operator));

  it('attribution corpus: the PATCH body, ok, the re-read and one row', async () => {
    install([finding('pf_a')]);
    const result = await actions.setPlannerFindingAttributionAction('pf_a', {
      attribution: 'corpus',
    });
    expect(result).toMatchObject({ ok: true, finding: { id: 'pf_a', attribution: 'corpus' } });
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      attribution: 'corpus',
      actorCoreUserId: world.operator,
    });
    const html = await renderToHtml(await DetailPage({ params: Promise.resolve({ id: 'pf_a' }) }));
    expect(html).toContain(en.platformAdmin.plannerFindings.attribution.corpus);
    expect(await auditCount()).toBe(1);
  });

  it('UNCHANGED for a same-value write and a restore of a live finding; it revalidates', async () => {
    install([finding('pf_same', { attribution: 'corpus' }), finding('pf_new')]);
    expect(
      await actions.setPlannerFindingAttributionAction('pf_same', { attribution: 'corpus' }),
    ).toEqual({ ok: false, code: 'UNCHANGED' });
    expect(await actions.restorePlannerFindingAction('pf_new')).toEqual({
      ok: false,
      code: 'UNCHANGED',
    });
    expect(revalidated()).toHaveLength(2);
    expect(await auditCount()).toBe(0);
  });

  it('INVALID for a 400 (no revalidation) and GONE for a 404 (revalidates)', async () => {
    install([finding('pf_a')]);
    fake.override((c) =>
      c.method === 'PATCH' ? problem(400, 'validation_error', 'note is too long') : undefined,
    );
    expect(await actions.dismissPlannerFindingAction('pf_a', 'x')).toEqual({
      ok: false,
      code: 'INVALID',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    fake.override(null);
    expect(await actions.dismissPlannerFindingAction('pf_gone')).toEqual({
      ok: false,
      code: 'GONE',
    });
    expect(revalidated()).toEqual([['/admin/planner-findings', 'layout']]);
    expect(await auditCount()).toBe(0);
    expect(fake.findings.get('pf_a')!.status).toBe('new');
  });

  it('INVALID before any motir-ai call for bad input', async () => {
    install([finding('pf_a')]);
    for (const key of ['motir', '123', '']) {
      expect(await actions.recordPlannerFindingBugKeyAction('pf_a', key), key).toEqual({
        ok: false,
        code: 'INVALID',
      });
    }
    expect(
      await actions.setPlannerFindingAttributionAction('pf_a', { attribution: 'everyone' }),
    ).toEqual({ ok: false, code: 'INVALID' });
    expect(await actions.promotePlannerFindingAction('pf_a', { ...FORM, title: '  ' })).toEqual({
      ok: false,
      code: 'INVALID',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await auditCount()).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the transport throws',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    ['a malformed 200', () => json({ audit: null })],
  ])('UNAVAILABLE from every write when %s; nothing changes', async (_n, answer) => {
    install(fiveFindings());
    const before = fake.snapshot();
    fake.override(answer);
    for (const [name, act] of FIVE) {
      expect(await act(), name).toEqual({ ok: false, code: 'UNAVAILABLE' });
    }
    expect(await auditCount()).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(fake.snapshot()).toBe(before);
  });

  it('a 409 near-duplicate on promote is DUPLICATE_LESSON; no PATCH, no row', async () => {
    install([finding('pf_b')]);
    fake.override((c) =>
      c.path === '/v1/lessons'
        ? problem(409, 'conflict', 'A lesson like this exists: lsn_existing')
        : undefined,
    );
    expect(await actions.promotePlannerFindingAction('pf_b', FORM)).toEqual({
      ok: false,
      code: 'DUPLICATE_LESSON',
      detail: 'A lesson like this exists: lsn_existing',
    });
    expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(await auditCount()).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(fake.findings.get('pf_b')!.status).toBe('new');
  });

  it('LESSON_NOT_LINKED carries the created lesson and revalidates', async () => {
    install([finding('pf_b')]);
    fake.override((c) =>
      c.method === 'PATCH' ? problem(500, 'internal_error', 'boom') : undefined,
    );
    expect(await actions.promotePlannerFindingAction('pf_b', FORM)).toEqual({
      ok: false,
      code: 'LESSON_NOT_LINKED',
      lessonId: 'lsn_fake_1',
    });
    expect(fake.lessons).toHaveLength(1);
    expect(revalidated()).toEqual([['/admin/planner-findings', 'layout']]);
    expect(await auditCount()).toBe(0);
  });

  it('promote of a finding already promoted is UNCHANGED with no create or PATCH', async () => {
    install([finding('pf_b', { status: 'promoted_to_lesson', lessonId: 'lsn_old' })]);
    expect(await actions.promotePlannerFindingAction('pf_b', FORM)).toEqual({
      ok: false,
      code: 'UNCHANGED',
    });
    expect(fake.calls.map((c) => c.method)).toEqual(['GET']);
  });
});

// ── The pages, as staff ──────────────────────────────────────────────────────

describe('the pages over the stub', () => {
  beforeEach(() => as(world.operator));

  const list = async (params: Record<string, string> = {}) =>
    renderToHtml(await ListPage({ searchParams: Promise.resolve({ view: 'all', ...params }) }));

  it('motir-ai down is the unavailable state, never empty or no-match', async () => {
    install([]);
    fake.override(() => problem(503, 'service_unavailable', 'down'));
    const views: Record<string, string>[] = [{}, { state: 'dismissed' }, { view: 'grouped' }];
    for (const params of views) {
      const html = await list(params);
      expect(html).toContain('data-testid="planner-findings-unavailable"');
      expect(html).not.toContain('planner-findings-empty');
      expect(html).not.toContain('planner-findings-no-match');
      expect(html).not.toContain('<table');
    }
  });

  it('empty with no filter; no-match with a filter that matches nothing', async () => {
    install([]);
    expect(await list()).toContain('data-testid="planner-findings-empty"');
    install([finding('pf_a')]);
    const html = await list({ state: 'dismissed' });
    expect(html).toContain('data-testid="planner-findings-no-match"');
    expect(html).not.toContain('planner-findings-empty');
  });

  it('the grouped view renders the groups table', async () => {
    install([finding('pf_a'), finding('pf_b')]);
    expect(await list({ view: 'grouped' })).toContain(
      'data-testid="planner-findings-groups-table"',
    );
  });

  it('an unknown fingerprint is group.empty, not the 404', async () => {
    install([finding('pf_a')]);
    const html = await renderToHtml(
      await GroupPage({
        params: Promise.resolve({ fingerprint: 'fp_nothing' }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-testid="planner-findings-group-empty"');
  });

  it('an unknown finding id is the 404 sentinel', async () => {
    install([]);
    await expect(
      DetailPage({ params: Promise.resolve({ id: 'pf_unknown' }) }),
    ).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('cost lines when the job has them; not metered otherwise, for either source', async () => {
    install([
      finding('pf_cost', { jobId: 'job_1' }),
      finding('pf_loop'),
      finding('pf_check', { source: 'check_plan' }),
    ]);
    fake.jobs.set('job_1', { status: 'succeeded', result: PRICED_JOB_RESULT });
    const detail = async (id: string) =>
      renderToHtml(await DetailPage({ params: Promise.resolve({ id }) }));

    const priced = await detail('pf_cost');
    expect(priced).toContain('data-testid="planner-finding-cost"');
    expect(priced.match(/data-testid="planner-finding-cost-line"/g)).toHaveLength(2);

    const loop = await detail('pf_loop');
    expect(loop).toContain('data-testid="planner-finding-not-metered"');
    expect(loop).not.toContain('data-testid="planner-finding-cost"');

    // The merged strip (MOTIR-10524) shows not-metered for a check_plan finding
    // too, adding the line that says a check is never metered.
    const check = await detail('pf_check');
    expect(check).toContain('data-testid="planner-finding-not-metered"');
    expect(check).not.toContain('data-testid="planner-finding-cost"');
  });

  it('canTriage follows the real platformRole column: operator true, support false', async () => {
    install([finding('pf_a')]);
    const controls = async () => {
      const tree = await DetailPage({ params: Promise.resolve({ id: 'pf_a' }) });
      const found = walk(tree).filter((el: ReactElement) => el.type === FindingTriageControls);
      expect(found).toHaveLength(1);
      return found[0]!.props as { canTriage: boolean };
    };
    as(world.operator);
    expect((await controls()).canTriage).toBe(true);
    as(world.support);
    expect((await controls()).canTriage).toBe(false);
    // Both render.
    const html = await renderToHtml(await DetailPage({ params: Promise.resolve({ id: 'pf_a' }) }));
    expect(html).toContain('data-testid="planner-finding-detail"');
  });
});
