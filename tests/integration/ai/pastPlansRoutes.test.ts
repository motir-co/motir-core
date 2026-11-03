import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { projectsService } from '@/lib/services/projectsService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  PAST_PLAN_SUMMARY_EXCERPT_MAX,
  PAST_PLANS_DEFAULT_LIMIT,
  parsePastPlanQuery,
  toPastPlanRow,
} from '@/lib/plans/pastPlans';
import type { PlanDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { GET as SEARCH } from '@/app/api/internal/ai/past-plans/route';
import { GET as READ_ONE } from '@/app/api/internal/ai/past-plan/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-10241 — the PAST-PLANS door end to end on a real Postgres: the service,
// both internal routes through their REAL handlers, the token's OWN project as the
// only scope (a sibling project and another workspace), declined plans with their
// `decisionReason`, every absence a NAMED state, and nothing written.

const SERVICE_SECRET = 'core-callback-secret-test';

// Lets one case make the job authentication fail with an error that is NOT an
// auth failure, to show the routes rethrow it rather than answer 401.
const authFailure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('@/lib/ai/jobAuth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ai/jobAuth')>();
  return {
    ...real,
    authenticateAndLimitJobRequest: (req: Request) => {
      const err = authFailure.next;
      if (err) {
        authFailure.next = null;
        return Promise.reject(err);
      }
      return real.authenticateAndLimitJobRequest(req);
    },
  };
});

let fx: WorkItemFixture;
let token: string;

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  token = tokenFor(fx.ctx, fx.projectId);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function tokenFor(ctx: ServiceContext, projectId: string): string {
  return mintJobToken({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId });
}

function get(
  handler: (req: Request) => Promise<Response>,
  path: string,
  query: Record<string, string>,
  opts: { bearer?: string; token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const bearer = 'bearer' in opts ? opts.bearer : SERVICE_SECRET;
  const tok = 'token' in opts ? opts.token : token;
  if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;
  if (tok !== undefined) headers['x-motir-job-token'] = tok;
  const qs = new URLSearchParams(query).toString();
  return handler(new Request(`http://core${path}${qs ? `?${qs}` : ''}`, { headers }));
}
const search = (query: Record<string, string> = {}, opts?: Parameters<typeof get>[3]) =>
  get(SEARCH, '/api/internal/ai/past-plans', query, opts);
const readOne = (query: Record<string, string>, opts?: Parameters<typeof get>[3]) =>
  get(READ_ONE, '/api/internal/ai/past-plan', query, opts);

/** A plan of `f`'s project with one proposal, closed to `planned`. */
async function plannedPlan(f: WorkItemFixture, title: string, summary?: string): Promise<string> {
  const plan = await plansService.createPlan(
    f.projectId,
    { title, ...(summary ? { summary } : {}) },
    f.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: `${title} — a proposal`, kind: 'task' } }],
    f.ctx,
  );
  await plansService.markPlanned(plan.id, f.ctx);
  return plan.id;
}

async function declinedPlan(f: WorkItemFixture, title: string): Promise<string> {
  const id = await plannedPlan(f, title);
  await plansService.declinePlan(id, f.ctx);
  return id;
}

async function siblingProject(): Promise<WorkItemFixture> {
  const sibling = await projectsService.createProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Other',
    identifier: 'OTH',
  });
  return { ...fx, projectId: sibling.id, projectIdentifier: sibling.identifier };
}

describe('the past-plans routes — auth and validation', () => {
  it('both refuse a missing bearer and a missing or tampered job token with 401', async () => {
    for (const call of [search, readOne]) {
      expect((await call({ planId: 'x' }, { bearer: undefined })).status).toBe(401);
      expect((await call({ planId: 'x' }, { token: undefined })).status).toBe(401);
      expect((await call({ planId: 'x' }, { token: `${token}x` })).status).toBe(401);
    }
  });

  it('rethrows a non-auth failure of the job authentication', async () => {
    for (const call of [search, readOne]) {
      authFailure.next = new Error('limiter down');
      await expect(call({ planId: 'x' })).rejects.toThrow('limiter down');
    }
  });

  it('refuses a limit outside 1–50, an unknown status and an over-long q with 400', async () => {
    const queries: Record<string, string>[] = [
      { limit: '0' },
      { limit: '51' },
      { limit: '2.5' },
      { limit: 'ten' },
      { status: 'declined,finished' },
      { q: 'x'.repeat(201) },
    ];
    for (const query of queries) {
      const res = await search(query);
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'PAST_PLANS_QUERY_INVALID' });
    }
    expect((await search({ limit: '50' })).status).toBe(200);
  });

  it('refuses a read with no planId with 400', async () => {
    const res = await readOne({ planId: '  ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PAST_PLAN_ID_REQUIRED' });
    expect((await readOne({})).status).toBe(400);
  });
});

describe('GET /api/internal/ai/past-plans — every status, newest first', () => {
  it('returns plans in every status, declined ones with their decisionReason', async () => {
    const generating = (await plansService.createPlan(fx.projectId, { title: 'Writing' }, fx.ctx))
      .id;
    const planned = await plannedPlan(fx, 'Awaiting');
    const reviewed = await declinedPlan(fx, 'Reviewed and declined');
    // An empty plan closed by markPlanned is DISCARDED (declined / discarded).
    const discarded = (await plansService.createPlan(fx.projectId, { title: 'Empty' }, fx.ctx)).id;
    await plansService.markPlanned(discarded, fx.ctx);
    const abandoned = await plannedPlan(fx, 'Left alone');
    await adminDb.plan.update({
      where: { id: abandoned },
      data: { status: 'declined', decisionReason: 'abandoned', decidedAt: new Date() },
    });
    const approved = await plannedPlan(fx, 'Shipped');
    await plansService.approvePlan(approved, fx.ctx);

    const res = await search();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('ok');
    expect(body.nextCursor).toBeNull();
    const byId = new Map(body.plans.map((p: Record<string, unknown>) => [p['id'], p]));
    expect([...byId.keys()]).toEqual([
      approved,
      abandoned,
      discarded,
      reviewed,
      planned,
      generating,
    ]);
    expect(byId.get(generating)).toMatchObject({ status: 'generating', decisionReason: null });
    expect(byId.get(planned)).toMatchObject({ status: 'planned', itemCount: 1 });
    expect(byId.get(reviewed)).toMatchObject({ status: 'declined', decisionReason: 'reviewed' });
    expect(byId.get(discarded)).toMatchObject({ status: 'declined', decisionReason: 'discarded' });
    expect(byId.get(abandoned)).toMatchObject({ status: 'declined', decisionReason: 'abandoned' });
    expect(byId.get(approved)).toMatchObject({ status: 'approved', decisionReason: null });
    expect(body.plans[0]).not.toHaveProperty('items');
  });

  it('narrows by status and by a case-insensitive substring of title or summary', async () => {
    const byTitle = await plannedPlan(fx, 'Billing EXPORT rework');
    const bySummary = await plannedPlan(fx, 'Quarterly', 'Moves the export button to the toolbar');
    const declined = await declinedPlan(fx, 'Export retry');
    await plannedPlan(fx, 'Unrelated');

    const words = await (await search({ q: 'export' })).json();
    expect(words.plans.map((p: { id: string }) => p.id)).toEqual([declined, bySummary, byTitle]);

    const onlyDeclined = await (await search({ q: 'export', status: 'declined' })).json();
    expect(onlyDeclined.plans.map((p: { id: string }) => p.id)).toEqual([declined]);

    const two = await (await search({ status: 'declined, planned,declined' })).json();
    expect(two.plans).toHaveLength(4);
  });

  it('pages with nextCursor, newest first, the cursor reading the next page', async () => {
    const a = await plannedPlan(fx, 'A');
    const b = await plannedPlan(fx, 'B');
    const c = await plannedPlan(fx, 'C');
    const first = await (await search({ limit: '2' })).json();
    expect(first.plans.map((p: { id: string }) => p.id)).toEqual([c, b]);
    expect(first.nextCursor).toBe(b);
    const second = await (await search({ limit: '2', cursor: first.nextCursor })).json();
    expect(second.plans.map((p: { id: string }) => p.id)).toEqual([a]);
    expect(second.nextCursor).toBeNull();
  });

  it('matches a percent sign and an underscore literally', async () => {
    const literal = await plansService.createPlan(
      fx.projectId,
      { title: 'Move user_id over' },
      fx.ctx,
    );
    await plansService.createPlan(fx.projectId, { title: 'Move userXid over' }, fx.ctx);
    const ids = async (q: string) =>
      (await (await search({ q })).json()).plans.map((p: { id: string }) => p.id);
    expect(await ids('user_id')).toEqual([literal.id]);
    expect(await ids('%')).toEqual([]);
  });

  it('bounds the summary excerpt and says when it is cut', async () => {
    const id = await plannedPlan(fx, 'Long');
    const long = 'w'.repeat(PAST_PLAN_SUMMARY_EXCERPT_MAX + 10);
    await adminDb.plan.update({ where: { id }, data: { summary: long } });
    const [row] = (await (await search()).json()).plans;
    expect(row.summaryExcerpt).toHaveLength(PAST_PLAN_SUMMARY_EXCERPT_MAX);
    expect(row.summaryTruncated).toBe(true);
  });

  it('a search with no match is 200 nothing-matched with an empty list', async () => {
    await plannedPlan(fx, 'Something');
    const res = await search({ q: 'nowhere-to-be-found' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'nothing-matched', plans: [], nextCursor: null });
    // An empty project is the same answer.
    const empty = await siblingProject();
    const res2 = await search({}, { token: tokenFor(empty.ctx, empty.projectId) });
    expect(await res2.json()).toMatchObject({ outcome: 'nothing-matched', plans: [] });
  });

  it('a project the token’s user cannot browse is 404, never 403', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const crossed = mintJobToken({
      userId: rival.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    const res = await search({}, { token: crossed });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('never returns a plan of a sibling project or of another workspace', async () => {
    const mine = await plannedPlan(fx, 'Mine export');
    const sibling = await siblingProject();
    await plannedPlan(sibling, 'Sibling export');
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    await plannedPlan(rival, 'Rival export');

    const body = await (await search({ q: 'export' })).json();
    expect(body.plans.map((p: { id: string }) => p.id)).toEqual([mine]);
  });
});

describe('GET /api/internal/ai/past-plan — one plan with its proposals', () => {
  it('returns the plan with its proposals', async () => {
    const id = await declinedPlan(fx, 'Declined with a proposal');
    const res = await readOne({ planId: id });
    expect(res.status).toBe(200);
    const { plan } = await res.json();
    expect(plan).toMatchObject({ id, status: 'declined', decisionReason: 'reviewed' });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].proposedFields.title).toBe('Declined with a proposal — a proposal');
  });

  it('an unknown id, a sibling project’s plan and another workspace’s plan answer the SAME 404', async () => {
    const sibling = await siblingProject();
    const siblingPlan = await plannedPlan(sibling, 'Sibling secret');
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const rivalPlan = await plannedPlan(rival, 'Rival secret');

    for (const planId of ['plan_unknown', siblingPlan, rivalPlan]) {
      const res = await readOne({ planId });
      expect(res.status, planId).toBe(404);
      expect(await res.json()).toEqual({
        code: 'PLAN_NOT_FOUND',
        error: `Plan ${planId} was not found.`,
      });
    }

    // A reader who cannot browse the plan's project: the same answer.
    const mine = await plannedPlan(fx, 'Mine');
    const crossed = mintJobToken({
      userId: rival.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    const res = await readOne({ planId: mine }, { token: crossed });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });
});

describe('the past-plans door — read-only and honest about failure', () => {
  it('writes nothing: no plan or proposal row changes on a search or a read', async () => {
    const id = await declinedPlan(fx, 'Declined');
    const before = await adminDb.plan.findMany({ orderBy: { id: 'asc' } });
    const itemsBefore = await adminDb.planItem.count();
    await search({ q: 'declined' });
    await search({ status: 'declined', limit: '1' });
    await readOne({ planId: id });
    await readOne({ planId: 'plan_unknown' });
    expect(await adminDb.plan.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await adminDb.planItem.count()).toBe(itemsBefore);
  });

  it('rethrows an unexpected failure instead of dressing it as an absence', async () => {
    vi.spyOn(plansService, 'searchPlans').mockRejectedValue(new Error('db down'));
    await expect(
      aiBoundaryService.searchPastPlans(
        fx.projectId,
        { q: null, statuses: null, cursor: null, limit: 20 },
        fx.ctx,
      ),
    ).rejects.toThrow('db down');
    await expect(search()).rejects.toThrow('db down');

    vi.spyOn(plansService, 'admitPlanReader').mockRejectedValue(new Error('db down'));
    await expect(aiBoundaryService.readPastPlan(fx.projectId, 'p', fx.ctx)).rejects.toThrow(
      'db down',
    );
    await expect(readOne({ planId: 'p' })).rejects.toThrow('db down');
  });

  it('rethrows an edit denial untouched — only the browse denial is folded into not-found', async () => {
    const edit = new ProjectAccessDeniedError(fx.projectId, 'edit');
    vi.spyOn(plansService, 'searchPlans').mockRejectedValue(edit);
    vi.spyOn(plansService, 'admitPlanReader').mockRejectedValue(edit);
    await expect(
      aiBoundaryService.searchPastPlans(
        fx.projectId,
        { q: null, statuses: null, cursor: null, limit: 20 },
        fx.ctx,
      ),
    ).rejects.toBe(edit);
    await expect(aiBoundaryService.readPastPlan(fx.projectId, 'p', fx.ctx)).rejects.toBe(edit);
  });
});

describe('parsePastPlanQuery and toPastPlanRow', () => {
  it('defaults, trims and dedupes', () => {
    expect(parsePastPlanQuery({})).toEqual({
      ok: true,
      filters: { q: null, statuses: null, cursor: null, limit: PAST_PLANS_DEFAULT_LIMIT },
    });
    expect(
      parsePastPlanQuery({
        q: '  x ',
        status: ['declined', ' declined', ''],
        cursor: ' c ',
        limit: 3,
      }),
    ).toEqual({ ok: true, filters: { q: 'x', statuses: ['declined'], cursor: 'c', limit: 3 } });
    expect(parsePastPlanQuery({ q: '   ', status: [''] })).toMatchObject({
      ok: true,
      filters: { q: null, statuses: null },
    });
  });

  it('refuses a non-string q or cursor and a non-list status', () => {
    expect(parsePastPlanQuery({ q: 3 })).toMatchObject({ ok: false });
    expect(parsePastPlanQuery({ cursor: {} })).toMatchObject({ ok: false });
    expect(parsePastPlanQuery({ status: 'declined' })).toMatchObject({ ok: false });
    expect(parsePastPlanQuery({ status: [1] })).toMatchObject({ ok: false });
    expect(parsePastPlanQuery({ limit: true })).toMatchObject({ ok: false });
  });

  it('keeps a null summary null and an excerpt under the bound whole', () => {
    const base = {
      id: 'p',
      title: null,
      status: 'planned',
      decisionReason: null,
      summary: null,
      itemCount: 0,
      createdAt: 't',
      plannedAt: null,
      decidedAt: null,
    } as unknown as PlanDto;
    expect(toPastPlanRow(base)).toMatchObject({ summaryExcerpt: null, summaryTruncated: false });
    expect(toPastPlanRow({ ...base, summary: 'short' })).toMatchObject({
      summaryExcerpt: 'short',
      summaryTruncated: false,
    });
  });
});
