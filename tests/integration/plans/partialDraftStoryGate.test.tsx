// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { cleanup, screen } from '@testing-library/react';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { mintJobToken } from '@/lib/ai/jobToken';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { authoringTargets, type LiveDrafts } from '@/lib/planning/liveDraft';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanItemDto } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { renderWithIntl } from '../../helpers/renderWithIntl';

// THE PARTIAL-DRAFT STORY GATE, motir-core's half (Story MOTIR-11190 · Subtask
// MOTIR-11204).
//
// The door (MOTIR-11199) and the quick view (MOTIR-11201) each prove their own
// layer. What neither can see is the ASSEMBLED path: a partial card going in
// through the hosted planner's real door, coming out on the real live read for
// the right proposal in the shape the quick view takes as props and rendering
// there — and NEVER becoming the proposal: not on the stored `plan_item` row, not
// on `get_plan`, not on what approve materializes, not through a refused write.
// Plus the order (a stale report never wins), the three exits that clear it
// (the completed write, the step's end, the plan leaving `generating`), and the
// door's refusals leaving nothing behind.
//
// ── THE PLANNER IS PLAYED, NOT RUN ────────────────────────────────────────────
// Exactly as `planNarrationStoryGate.test.ts` plays it: the hosted planner's
// internal routes' handlers imported IN THIS PROCESS, called with the service
// bearer and a minted job token — `plan-proposals` to lay (and close),
// `plan-step` for the step and the `itemDraft` reports, `plan-proposals/[itemId]`
// for the completed write. The reads are the real `GET /api/plans/[id]`, the real
// `POST /api/plans/[id]/approve` and `get_plan` over an in-memory MCP client on
// `buildMcpServer`.
//
// ── NOTHING CHANGED IS PROVEN FROM THE ROWS ──────────────────────────────────
// Every "unchanged" and "left no draft" is a before/after read through the admin
// client, never only the response: a refusal that answered the right code and
// wrote anyway would pass a response-only check.
//
// ── TIME IS NEVER FAKED ──────────────────────────────────────────────────────
// Order is the `seq` each report carries, never a clock.
//
// ── WHAT IS MOCKED ───────────────────────────────────────────────────────────
// The request boundary only — the session, the cookie-reading workspace
// resolver, `next/headers`, `next-intl/server`'s request-scoped translator — plus,
// for the one render, the router and the server-actions module the quick view
// imports (a test has no Next runtime).
// Every service, repository and row is the real one.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const wsCtx = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => wsCtx.current,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
// The approve route words its answer through `next-intl/server`, which needs a
// request scope; the follow-the-planner gate stands it in the same way.
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/planning',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

const { GET: planRoute } = await import('@/app/api/plans/[id]/route');
const { POST: approveRoute } = await import('@/app/api/plans/[id]/approve/route');
const { POST: stepPOST } = await import('@/app/api/internal/ai/plan-step/route');
const { POST: proposalsPOST } = await import('@/app/api/internal/ai/plan-proposals/route');
const { PATCH: deepenPATCH } = await import('@/app/api/internal/ai/plan-proposals/[itemId]/route');
const { ProposalPeek } = await import('@/components/planning/ProposalPeek');

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_code_read", "plan_narration", "plan_narration_session", "plan_step", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  session.current = null;
  wsCtx.current = null;
  await truncateAll();
});

afterEach(() => cleanup());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The hosted planner's doors ───────────────────────────────────────────────

function credentials(fx: WorkItemFixture): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${SERVICE_SECRET}`,
    'x-motir-job-token': mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    }),
  };
}

function step(fx: WorkItemFixture, body: Record<string, unknown>): Promise<Response> {
  return stepPOST(
    new Request('http://core/api/internal/ai/plan-step', {
      method: 'POST',
      headers: credentials(fx),
      body: JSON.stringify(body),
    }),
  );
}

async function stepOk(fx: WorkItemFixture, body: Record<string, unknown>): Promise<unknown> {
  const res = await step(fx, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

async function proposals(fx: WorkItemFixture, body: Record<string, unknown>) {
  const res = await proposalsPOST(
    new Request('http://core/api/internal/ai/plan-proposals', {
      method: 'POST',
      headers: credentials(fx),
      body: JSON.stringify(body),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { planItemIds: string[] };
}

function deepen(
  fx: WorkItemFixture,
  jobId: string,
  itemId: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return deepenPATCH(
    new Request(`http://core/api/internal/ai/plan-proposals/${itemId}`, {
      method: 'PATCH',
      headers: credentials(fx),
      body: JSON.stringify({ jobId, patch }),
    }),
    { params: Promise.resolve({ itemId }) },
  );
}

// ── The reads ────────────────────────────────────────────────────────────────

function signIn(fx: WorkItemFixture): void {
  session.current = {
    user: { id: fx.ownerId, email: `${fx.ownerId}@example.com`, name: 'Reader' },
  };
  wsCtx.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

/** `GET /api/plans/[id]` — the live read every overlay surface polls. */
async function liveRead(fx: WorkItemFixture, planId: string): Promise<PlanReviewDto> {
  signIn(fx);
  const res = await planRoute(new Request(`http://localhost/api/plans/${planId}`), {
    params: Promise.resolve({ id: planId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PlanReviewDto;
}

const servedDrafts = async (fx: WorkItemFixture, planId: string) =>
  (await liveRead(fx, planId)).inFlightDrafts ?? [];

/** `get_plan` over an in-memory MCP client on the real server. */
async function getPlan(fx: WorkItemFixture, planId: string) {
  const server = buildMcpServer(() => fx.ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'partial-draft-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const r = (await client.callTool({
      name: GET_PLAN_TOOL_NAME,
      arguments: { planId },
    })) as CallToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    return {
      items: (r.structuredContent as unknown as { items: PlanItemDto[] }).items,
      raw: JSON.stringify(r),
    };
  } finally {
    await client.close();
  }
}

/** `POST /api/plans/[id]/approve`, pressed with the stamp the reader was shown. */
async function approve(fx: WorkItemFixture, planId: string): Promise<void> {
  const stamp = (await planReviewService.getPlanReview(planId, fx.ctx)).gate?.stamp ?? null;
  signIn(fx);
  const res = await approveRoute(
    new Request(`http://localhost/api/plans/${planId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stamp }),
    }),
    { params: Promise.resolve({ id: planId }) },
  );
  expect(res.status, await res.clone().text()).toBe(200);
}

// ── The stored rows, for every "nothing changed" ─────────────────────────────

const itemRow = (id: string) => adminDb.planItem.findUniqueOrThrow({ where: { id } });

/** Everything a draft report or a refusal could have written. */
async function rows(planId: string) {
  return {
    items: await adminDb.planItem.findMany({ where: { planId }, orderBy: { id: 'asc' } }),
    steps: await adminDb.planStep.findMany({ where: { planId }, orderBy: { sessionKey: 'asc' } }),
  };
}

// ── The plan under write ─────────────────────────────────────────────────────

const STORED_P = 'Remember me on this device';
const STORED_Q = 'Sign out everywhere';

interface Walk {
  fx: WorkItemFixture;
  jobId: string;
  planId: string;
  /** The card being written. */
  p: string;
  /** Its sibling, laid in the same append and written by nobody. */
  q: string;
  target: string;
}

/**
 * A `generating` hosted plan whose two cards were laid TITLE-ONLY through the
 * real proposals door, with an `author` session open on the first.
 */
async function walk(jobId: string, fx?: WorkItemFixture): Promise<Walk> {
  fx ??= await makeWorkItemFixture({ identifier: 'PDG' });
  const plan = await plansService.createPlan(
    fx.projectId,
    { sourceJobId: jobId, title: `Drafted ${jobId}`, createdById: fx.ownerId },
    fx.ctx,
  );
  const laid = await proposals(fx, {
    jobId,
    proposals: [
      { op: 'add', proposedFields: { title: STORED_P, kind: 'task' } },
      { op: 'add', proposedFields: { title: STORED_Q, kind: 'task' } },
    ],
  });
  const [p, q] = laid.planItemIds as [string, string];
  const target = `planItem:${p}`;
  await stepOk(fx, { jobId, sessionKey: 'author-p', step: 'author', target });
  return { fx, jobId, planId: plan.id, p, q, target };
}

const draft = (w: Walk, seq: number, fields: Record<string, string>) =>
  step(w.fx, {
    jobId: w.jobId,
    sessionKey: 'author-p',
    itemDraft: { target: w.target, seq, ...fields },
  });

async function draftOk(w: Walk, seq: number, fields: Record<string, string>) {
  const res = await draft(w, seq, fields);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { planId: string; itemDraft: { applied: boolean; seq: number } };
}

// Not a prefix of the stored title, so a leak of the partial is told from the card.
const PARTIAL = {
  title: 'Keep me signed in on',
  descriptionMd: 'Remembered devices keep the session for',
  explanationMd: 'People who sign in on the same laptop',
};

// ─────────────────────────────────────────────────────────────────────────────
describe('1. door → storage → live read → the quick view’s props', () => {
  it('serves the draft on P’s entry only, in the shape ProposalPeek takes, and it renders', async () => {
    const w = await walk('job_pdg_seam');
    expect(await draftOk(w, 1, PARTIAL)).toEqual({
      planId: w.planId,
      itemDraft: { applied: true, seq: 1 },
    });

    const review = await liveRead(w.fx, w.planId);
    expect(review.inFlightDrafts).toEqual([
      {
        planItemId: w.p,
        sessionKey: 'author-p',
        seq: 1,
        ...PARTIAL,
        updatedAt: expect.any(String),
      },
    ]);
    expect(review.inFlightDrafts!.some((d) => d.planItemId === w.q)).toBe(false);

    // THE PROP TYPE: the read's value assigns to what the quick view exports. A
    // drift between the DTO and `LiveDrafts` fails the type check here.
    const liveDrafts: LiveDrafts = {
      drafts: review.inFlightDrafts ?? [],
      authoring: authoringTargets(review.inFlightSteps),
    };
    const prop: ComponentProps<typeof ProposalPeek>['liveDrafts'] = liveDrafts;

    const itemP = review.items.find((i) => i.planItemId === w.p)!;
    const r = renderWithIntl(
      <ProposalPeek item={itemP} live liveDrafts={prop} onClose={() => {}} />,
    );
    const shown = (field: string) =>
      screen.getByTestId(`quick-view-live-${field}`).querySelector('[data-live-partial]')
        ?.textContent;
    expect(shown('title')).toBe(PARTIAL.title);
    expect(shown('descriptionMd')).toBe(PARTIAL.descriptionMd);
    expect(shown('explanationMd')).toBe(PARTIAL.explanationMd);
    expect(screen.getByTestId('quick-view-live-cue').getAttribute('data-live-cue')).toBe('writing');

    // The sibling's quick view, fed the same read, shows none of it.
    const itemQ = review.items.find((i) => i.planItemId === w.q)!;
    r.rerender(<ProposalPeek item={itemQ} live liveDrafts={prop} onClose={() => {}} />);
    expect(screen.queryByTestId('quick-view-live-descriptionMd')).toBeNull();
    expect(screen.queryByText(PARTIAL.descriptionMd)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2. a partial body is never the proposal', () => {
  it('leaves the row as it was; get_plan and approve see only the stored card', async () => {
    const w = await walk('job_pdg_never');
    const before = await itemRow(w.p);

    for (const [seq, n] of [
      [1, 12],
      [2, 24],
      [3, 40],
    ] as const) {
      await draftOk(w, seq, {
        title: PARTIAL.title.slice(0, 8 + seq),
        descriptionMd: PARTIAL.descriptionMd.slice(0, n),
        explanationMd: PARTIAL.explanationMd.slice(0, n),
      });
    }
    expect(await servedDrafts(w.fx, w.planId)).toHaveLength(1);

    // The row, byte for byte.
    expect(await itemRow(w.p)).toEqual(before);
    // get_plan: the stored body only.
    const plan = await getPlan(w.fx, w.planId);
    expect(plan.items.find((i) => i.id === w.p)?.proposedFields).toEqual(before.proposedFields);
    for (const text of Object.values(PARTIAL)) expect(plan.raw).not.toContain(text.slice(0, 12));
    // The review read's own item is the stored one too.
    const review = await liveRead(w.fx, w.planId);
    expect(review.items.find((i) => i.planItemId === w.p)).toMatchObject({
      title: STORED_P,
      descriptionMd: null,
      explanationMd: null,
    });

    // Close the walk through the real door and approve through the real route.
    await proposals(w.fx, { jobId: w.jobId, proposals: [], final: true });
    await approve(w.fx, w.planId);
    const made = await adminDb.workItem.findMany({ where: { projectId: w.fx.projectId } });
    const madeP = made.find((m) => m.title === STORED_P);
    expect(madeP, 'approve materialized the stored card').toBeDefined();
    expect(madeP!.descriptionMd ?? null).toBeNull();
    const everything = JSON.stringify(made);
    for (const text of Object.values(PARTIAL)) expect(everything).not.toContain(text.slice(0, 12));
  });

  it('only the completed write changes the card', async () => {
    const w = await walk('job_pdg_write');
    await draftOk(w, 1, PARTIAL);
    const res = await deepen(w.fx, w.jobId, w.p, {
      title: 'Remember me on this device for thirty days',
      descriptionMd: 'The written description.',
      explanationMd: 'The written explanation.',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await itemRow(w.p)).proposedFields).toMatchObject({
      title: 'Remember me on this device for thirty days',
      descriptionMd: 'The written description.',
      explanationMd: 'The written explanation.',
    });
  });

  describe('a completed write refused by a rule that gates writes today', () => {
    const refusals: [string, (w: Walk) => [string, Record<string, unknown>]][] = [
      ['a proposal outside the plan', () => ['pi_not_in_this_plan', { title: 'Anything' }]],
      ['an empty title', (w) => [w.p, { title: '   ' }]],
      ['a malformed sections payload', (w) => [w.p, { sections: 'not an object' }]],
    ];

    it.each(refusals)(
      '%s: same code and status as with no draft, nothing promoted',
      async (_n, of) => {
        // TODAY's answer: the same refused write on a twin walk that holds no draft.
        const twin = await walk('job_pdg_twin');
        const [twinItem, twinPatch] = of(twin);
        const today = await deepen(twin.fx, twin.jobId, twinItem, twinPatch);
        const todayBody = (await today.json()) as { code: string };

        const w = await walk('job_pdg_refused', twin.fx);
        await draftOk(w, 1, PARTIAL);
        const before = await rows(w.planId);
        const [item, patch] = of(w);
        const res = await deepen(w.fx, w.jobId, item, patch);
        expect(res.status).toBe(today.status);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(((await res.json()) as { code: string }).code).toBe(todayBody.code);

        // The stored cards are exactly as they were, and no draft became one.
        expect((await rows(w.planId)).items).toEqual(before.items);
        const stored = JSON.stringify((await rows(w.planId)).items);
        for (const text of Object.values(PARTIAL)) expect(stored).not.toContain(text);
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3. order is the sequence the report carries', () => {
  it('serves seq 3 after 1, 3, 2 — the late 2 does not overwrite it', async () => {
    const w = await walk('job_pdg_order');
    await draftOk(w, 1, { descriptionMd: 'One' });
    await draftOk(w, 3, { descriptionMd: 'One two three' });
    expect(await draftOk(w, 2, { descriptionMd: 'One two' })).toEqual({
      planId: w.planId,
      itemDraft: { applied: false, seq: 3 },
    });
    const served = await servedDrafts(w.fx, w.planId);
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ planItemId: w.p, seq: 3, descriptionMd: 'One two three' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4. the three exits clear the draft', () => {
  it('the completed write lands — no draft, the stored card', async () => {
    const w = await walk('job_pdg_exit_write');
    await draftOk(w, 1, PARTIAL);
    const res = await deepen(w.fx, w.jobId, w.p, { descriptionMd: 'Stored at last.' });
    expect(res.status, await res.clone().text()).toBe(200);
    const review = await liveRead(w.fx, w.planId);
    expect((review.inFlightDrafts ?? []).some((d) => d.planItemId === w.p)).toBe(false);
    expect(review.items.find((i) => i.planItemId === w.p)?.descriptionMd).toBe('Stored at last.');
  });

  it('the session reports end — no draft', async () => {
    const w = await walk('job_pdg_exit_end');
    await draftOk(w, 1, PARTIAL);
    await stepOk(w.fx, { jobId: w.jobId, sessionKey: 'author-p', step: 'end' });
    expect(await servedDrafts(w.fx, w.planId)).toEqual([]);
  });

  it('the plan leaves generating — no draft', async () => {
    const w = await walk('job_pdg_exit_close');
    await draftOk(w, 1, PARTIAL);
    await proposals(w.fx, { jobId: w.jobId, proposals: [], final: true });
    const review = await liveRead(w.fx, w.planId);
    expect(review.status).toBe('planned');
    expect(review.inFlightDrafts ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5. each refusal answers its code and leaves no draft', () => {
  type Refusal = [string, number, string, (w: Walk) => Record<string, unknown>];
  const cases: Refusal[] = [
    [
      'bad shape',
      400,
      'PLAN_STEP_INVALID',
      (w) => ({ jobId: w.jobId, sessionKey: 'author-p', itemDraft: { target: w.target, seq: 0 } }),
    ],
    [
      'a foreign job',
      404,
      'NO_PLAN_FOR_JOB',
      (w) => ({
        jobId: 'job_nobody',
        sessionKey: 'author-p',
        itemDraft: { target: w.target, seq: 1, title: 'x' },
      }),
    ],
    [
      // The plan is resolved FROM the job, and a named `planId` must be that
      // plan, so a mismatch answers as the job having no such plan.
      'a mismatched planId',
      404,
      'NO_PLAN_FOR_JOB',
      (w) => ({
        jobId: w.jobId,
        planId: 'plan_not_this_one',
        sessionKey: 'author-p',
        itemDraft: { target: w.target, seq: 1, title: 'x' },
      }),
    ],
    [
      'a proposal that is not the session’s author target',
      422,
      'PLAN_STEP_INVALID',
      (w) => ({
        jobId: w.jobId,
        sessionKey: 'author-p',
        itemDraft: { target: `planItem:${w.q}`, seq: 1, title: 'x' },
      }),
    ],
  ];

  it.each(cases)('%s → %i %s', async (_name, status, code, body) => {
    const w = await walk(`job_pdg_refuse_${status}`);
    const before = await rows(w.planId);
    const res = await step(w.fx, body(w));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code, error: expect.any(String) });
    expect(await rows(w.planId)).toEqual(before);
    expect(await servedDrafts(w.fx, w.planId)).toEqual([]);
  });

  it('a plan not generating → 409 PLAN_NOT_GENERATING', async () => {
    const w = await walk('job_pdg_refuse_409');
    await proposals(w.fx, { jobId: w.jobId, proposals: [], final: true });
    const before = await rows(w.planId);
    const res = await draft(w, 1, PARTIAL);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'PLAN_NOT_GENERATING', error: expect.any(String) });
    expect(await rows(w.planId)).toEqual(before);
    expect(await servedDrafts(w.fx, w.planId)).toEqual([]);
  });
});
