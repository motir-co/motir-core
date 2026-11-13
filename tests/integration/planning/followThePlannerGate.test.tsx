// @vitest-environment happy-dom
//
// THE FOLLOW-THE-PLANNER INTEGRATION GATE (MOTIR-8596, Story MOTIR-8590; design
// `design/ai-planning/design-notes.md` Part XXVIII).
//
// ── What no unit can see ────────────────────────────────────────────────────
// The story's four code cards each shipped a floor against a snapshot they BUILT:
// the derivation (`plannerDrive.test.ts`) feeds `PlanProgressStep` fixtures, the
// canvas (`canvas-follow-while-on.test.tsx`) feeds arbitrary `{ key, trail }`, the
// host (`planning-workspace-follow-planner.test.tsx`) mocks the conversation hook,
// and the live draft (`proposal-peek-live-draft.test.tsx`) re-renders `ProposalPeek`.
// This file mounts the assembled path and mocks nothing on it:
//
//   the planners' own writers        `lib/mcp/tools/authorPlan.ts` — `create_plan`,
//                                    `add_plan_items`, `update_plan_proposal` and
//                                    `report_plan_step` (the step store the
//                                    progress snapshot reads)
//     → Postgres
//     → GET /api/plans/[id]          the REAL route, through the REAL client
//     → useGeneratingPlanPoll        the REAL poll inside the REAL conversation
//     → PlanningWorkspaceHost        the REAL host: its following state, the one
//                                    lifted progress clock, the Follow the planner
//                                    control → PlanProposalViews → PlanReviewCanvas
//                                    → ProjectRoadmapCanvas, each level read
//                                    through the REAL roadmap route
//     → ProposalPeek                 → IssueQuickViewPanel in proposal mode →
//                                    LiveDraftField (seam 2; MOTIR-11201 replaced
//                                    the replay with the live draft)
//
// The substitutions are the live-drawing gate's (`liveDrawingGate.test.tsx`), all
// OUTSIDE the path: the session cookie and the project it resolves, the router,
// the server actions module, the composer's target search and the actor's
// permission set. Unlike that gate the quick-view panel is REAL here — seam 2 is
// the panel. `ProjectRoadmapCanvas` and `PlanProposalViews` are WRAPPED, never
// replaced: the wrapper records the follow props the real component was handed.
//
// ⚠️ ONE CLOCK. Only `setInterval` is faked, so the poll ticks when a test says
// so. The live draft is DATA on that read, not motion: the partial on screen is
// whatever the latest read carried, so a seam-2 case asserts it after a tick
// rather than racing a frame.
import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { ComponentProps } from 'react';

// ── The seams OUTSIDE the path under test ──────────────────────────────────
const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    activeCtx.current
      ? { userId: activeCtx.current.userId, workspaceId: activeCtx.current.workspaceId }
      : null,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeCtx.current,
}));

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
// The plan page reads its List | Canvas view from the address, so it is settable.
const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
  usePathname: () => '/planning',
  useSearchParams: () => new URLSearchParams(search.value),
}));
// The approve route's server-side copy needs a request-scoped i18n config the
// test env has none of; the key is echoed (nothing here asserts that copy).
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));
// The actor's permission set — the shell's provider, which reaches the server.
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: () => true }),
}));
// The composer's target search and the peek panel reach the server on their
// own; nothing here types into the composer or opens a peek.
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: () => ({ results: [], loading: false, error: null }),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

// ── The two WRAPPED components: real render, recorded follow props ─────────
interface CanvasProps {
  followKey: string | null;
  followMode: string | null;
  hasControl: boolean;
}
interface ViewsProps {
  live: boolean;
  followMode: string | null;
  hasReading: boolean;
  hasControl: boolean;
}
const { canvasLog, viewsLog } = vi.hoisted(() => ({
  canvasLog: [] as CanvasProps[],
  viewsLog: [] as ViewsProps[],
}));
vi.mock('@/components/planning/ProjectRoadmapCanvas', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/planning/ProjectRoadmapCanvas')>();
  function Recorded(props: ComponentProps<typeof real.ProjectRoadmapCanvas>) {
    canvasLog.push({
      followKey: props.followTo?.key ?? null,
      followMode: props.followMode ?? null,
      hasControl: props.followControl != null,
    });
    return <real.ProjectRoadmapCanvas {...props} />;
  }
  return { ...real, ProjectRoadmapCanvas: Recorded };
});
vi.mock('@/components/planning/PlanProposalViews', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/planning/PlanProposalViews')>();
  function Recorded(props: ComponentProps<typeof real.PlanProposalViews>) {
    viewsLog.push({
      live: props.live === true,
      followMode: props.followMode ?? null,
      hasReading: props.progressReading !== undefined,
      hasControl: props.followControl != null,
    });
    return <real.PlanProposalViews {...props} />;
  }
  return { ...real, PlanProposalViews: Recorded };
});

const { GET: planRoute } = await import('@/app/api/plans/[id]/route');
const { POST: approveRoute } = await import('@/app/api/plans/[id]/approve/route');
const { GET: sessionRoute } = await import('@/app/api/ai/plan-change/session/route');
const { GET: roadmapRoute } = await import('@/app/api/projects/[key]/roadmap/route');
const { runCreatePlan, runAddPlanItems, runUpdatePlanProposal, runReportPlanStep } =
  await import('@/lib/mcp/tools/authorPlan');
const { plansService } = await import('@/lib/services/plansService');
const { POLL_MS, FAILING_AFTER } = await import('@/lib/hooks/useGeneratingPlanPoll');
const { parsePlanningLaunch } = await import('@/lib/planning/launcher');
const { PlanningWorkspaceHost } = await import('@/components/planning/PlanningWorkspaceHost');
const { PlanDetail } = await import('@/components/planning/PlanDetail');
const { IssueQuickViewPanel } =
  await import('@/app/(authed)/items/_components/IssueQuickViewPanel');

// ── fetch → the REAL route handlers ────────────────────────────────────────
const BASE = 'http://localhost:3000';
/** Every response still being produced — `settle` waits for all of them. */
const inFlight = new Set<Promise<unknown>>();
/** How many upcoming PLAN reads to fail, as a dropped connection does. */
const drop = { planReads: 0, failed: 0 };
/** Every plan read served, in order — the poll's own trail. */
const planReads: string[] = [];
/**
 * The subset of `planReads` issued by the GENERATING poll (`useGeneratingPlanPoll`),
 * told apart by the caller on the stack. The hand-over case needs it: after the plan
 * leaves `generating` the surface DOES keep reading it, on purpose — MOTIR-6151's
 * gate watch re-reads an awaiting plan so a lease taken elsewhere holds its verbs —
 * so "no further plan read" is the wrong claim. "No further GENERATING-poll read"
 * is the right one.
 */
const generatingPollReads: string[] = [];
/** Anything fetched that this seam does not serve. Asserted empty. */
const unserved: string[] = [];

function installFetch(): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, BASE);
    const path = url.pathname;
    const run = async (): Promise<Response> => {
      const approve = /^\/api\/plans\/([^/]+)\/approve$/.exec(path);
      if (approve && init?.method === 'POST') {
        return approveRoute(
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: (init.body as string | undefined) ?? '{}',
          }),
          { params: Promise.resolve({ id: decodeURIComponent(approve[1]!) }) },
        );
      }
      const plan = /^\/api\/plans\/([^/]+)$/.exec(path);
      if (plan) {
        planReads.push(path);
        if (new Error().stack?.includes('useGeneratingPlanPoll')) generatingPollReads.push(path);
        if (drop.planReads > 0) {
          drop.planReads -= 1;
          drop.failed += 1;
          throw new TypeError('Failed to fetch');
        }
        return planRoute(new Request(url), {
          params: Promise.resolve({ id: decodeURIComponent(plan[1]!) }),
        });
      }
      if (path === '/api/ai/plan-change/session') return sessionRoute(new Request(url));
      const roadmap = /^\/api\/projects\/([^/]+)\/roadmap$/.exec(path);
      if (roadmap) {
        return roadmapRoute(new Request(url), {
          params: Promise.resolve({ key: decodeURIComponent(roadmap[1]!) }),
        });
      }
      unserved.push(`${init?.method ?? 'GET'} ${path}`);
      return new Response(JSON.stringify({ code: 'NOT_SERVED' }), { status: 404 });
    };
    const p = run();
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  });
}

// ── Clock and waiting ──────────────────────────────────────────────────────
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

// ⚠️ A TEST THAT TIMES OUT MUST NOT OUTLIVE ITSELF (MOTIR-7203). Vitest abandons
// a timed-out body and moves on, but nothing stops the body: its `until` /
// `settle` loops keep calling `act()` on the real clock into the NEXT test, React
// reports "overlapping act() calls", and every later test in the file hangs to
// its own timeout. That is how one slow case on a loaded CI shard failed all
// seven (run 36861699491: 144 overlap warnings in the second test, then five
// tests that drew nothing). So every body runs through this file's `it`, and
// `afterEach` ENDS it: the helpers below throw once their test has ended, and
// `afterEach` waits for the body — and the route calls it left in flight — to
// unwind before the next `beforeEach` truncates under them.
const body = { running: null as Promise<unknown> | null, ended: false };
function alive(): void {
  if (body.ended) throw new Error('this helper outlived its test, which has already ended');
}
/**
 * ⚠️ THE TEST'S BUDGET IS LARGER THAN ANY ONE WAIT'S (MOTIR-8887). `until` gives
 * each condition its own 15 s, and a case chains several of them after a DB-backed
 * `drivenToS()` and several poll reads — so with the suite's 15 s
 * `testTimeout` the TEST expired together with its FIRST slow wait, on a loaded
 * shard, as a bare `Test timed out in 15000ms` that named no condition. A wait
 * that really never resolves still throws its own assertion at 15 s, naming what
 * it was waiting for; this budget only keeps a merely slow case from being
 * misreported as a hang. (Vitest 4 takes the options object as the SECOND argument.)
 */
const CASE_BUDGET = { timeout: 45_000 };
function it(name: string, fn: () => Promise<void>): void {
  vitestIt(name, CASE_BUDGET, () => {
    const run = fn();
    body.running = run;
    return run;
  });
}

/** Drain every in-flight route call and every render it causes. */
async function settle(): Promise<void> {
  for (let quiet = 0; quiet < 3; ) {
    alive();
    const pending = [...inFlight];
    await act(async () => {
      await Promise.allSettled(pending);
      await sleep(5);
    });
    quiet = pending.length === 0 && inFlight.size === 0 ? quiet + 1 : 0;
  }
}

/** Wait on the real clock until `check` passes — Testing Library's `waitFor`
 *  polls on `setInterval`, which this file has faked. */
async function until(check: () => void, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    alive();
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await act(async () => {
        await sleep(20);
      });
    }
  }
}

/** ONE poll tick: the interval fires, the read goes through the route, the pane draws. */
async function tick(): Promise<void> {
  alive();
  act(() => {
    vi.advanceTimersByTime(POLL_MS);
  });
  await settle();
}

// ── DOM reads ──────────────────────────────────────────────────────────────
const node = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
/** The breadcrumb's current level, or `null` at the root with no bar. */
const activeCrumb = () =>
  screen.queryByRole('navigation', { name: /breadcrumb/i })?.querySelector('[aria-current="page"]')
    ?.textContent ?? null;
const followState = () => screen.queryByTestId('canvas-follow-state');
const followButton = () => screen.queryByTestId('canvas-follow-planner');
/** The follow request the canvas was LAST handed. */
const lastFollowKey = () => canvasLog.at(-1)?.followKey ?? null;

// ── The tenant and the tree ────────────────────────────────────────────────
//
//   E  "Live drawing" (epic)
//   ├─ S  "The generating pane" (story)   ← the level the reader stands on
//   │   ├─ C1 "Poll the plan"   (subtask, todo)   ← a modify adds an edge to it
//   │   └─ D  "Old spike"       (subtask, DONE)   ← the plan never mentions it
//   └─ S2 "The hand-over" (story)         ← "another level"
let fx: WorkItemFixture;
const tree = { E: '', S: '', S2: '', C1: '', D: '', S2Key: '', SKey: '', EKey: '' };

beforeEach(async () => {
  body.ended = false;
  body.running = null;
  canvasLog.length = 0;
  viewsLog.length = 0;
  search.value = '';
  planReads.length = 0;
  generatingPollReads.length = 0;
  unserved.length = 0;
  drop.planReads = 0;
  drop.failed = 0;
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  } as unknown as ProjectContext;

  const E = await createTestWorkItem(fx, { kind: 'epic', title: 'Live drawing' });
  const S = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'The generating pane',
    parentId: E.id,
  });
  const S2 = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'The hand-over',
    parentId: E.id,
  });
  const C1 = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Poll the plan',
    parentId: S.id,
  });
  const D = await createTestWorkItem(fx, { kind: 'subtask', title: 'Old spike', parentId: S.id });
  await adminDb.workItem.update({ where: { id: D.id }, data: { status: 'done' } });
  Object.assign(tree, {
    E: E.id,
    S: S.id,
    S2: S2.id,
    C1: C1.id,
    D: D.id,
    EKey: E.identifier,
    SKey: S.identifier,
    S2Key: S2.identifier,
  });

  installFetch();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(async () => {
  // A body still running here has timed out: end it, let it unwind at its next
  // helper call, and drain the route calls the unmounted pane left in flight.
  body.ended = true;
  await body.running?.catch(() => {});
  cleanup();
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The planners' writes ───────────────────────────────────────────────────
type ToolResult = { structuredContent?: unknown; isError?: boolean; content?: unknown };
function ok<T>(r: ToolResult): T {
  if (r.isError) throw new Error(`tool refused: ${JSON.stringify(r.content)}`);
  return r.structuredContent as T;
}

/** An MCP agent opens a plan: `generating`, attributed to its harness, in its own session. */
async function agentOpensPlan(): Promise<{ planId: string; sessionId: string }> {
  alive();
  const plan = ok<{ id: string }>(
    await runCreatePlan(
      {
        projectKey: fx.projectIdentifier,
        title: 'Draw the plan as it is written',
        plannedWithHarness: 'Claude Code',
        plannedWithModel: 'claude-opus-5',
      },
      fx.ctx,
    ),
  );
  const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
  expect(row.status).toBe('generating');
  expect(row.sessionId).not.toBeNull();
  return { planId: plan.id, sessionId: row.sessionId! };
}

/** `add_plan_items` — one batch, ids back index-for-index. */
async function agentAppends(
  planId: string,
  proposals: unknown[],
  final = false,
): Promise<string[]> {
  alive();
  const res = ok<{ planItemIds: string[] }>(
    await runAddPlanItems(
      { planId, proposals: proposals as never, ...(final ? { final: true } : {}) },
      fx.ctx,
    ),
  );
  return res.planItemIds;
}

const addUnder = (parent: string, title: string, blockedBy: string[] = []) => ({
  op: 'add',
  proposedFields: { title, kind: 'subtask' },
  parentRef: parent,
  blockedByRefs: blockedBy.map((id) => `planItem:${id}`),
});

/** A plan item's canvas node id — what `data-node-id` carries for a proposal. */
async function nodeIdOf(planId: string, planItemId: string): Promise<string> {
  const review = await readReview(planId);
  const item = review.items.find((i) => i.planItemId === planItemId);
  if (!item) throw new Error(`no review item ${planItemId}`);
  return item.nodeId;
}

async function readReview(planId: string): Promise<PlanReviewDto> {
  const res = await planRoute(new Request(`${BASE}/api/plans/${planId}`), {
    params: Promise.resolve({ id: planId }),
  });
  return (await res.json()) as PlanReviewDto;
}

// ── The step store's door ──────────────────────────────────────────────────
/** `report_plan_step` — what a planner session says it is doing now. */
async function reportStep(
  planId: string,
  sessionKey: string,
  step: 'settle' | 'lay' | 'author' | 'end',
  target?: string,
): Promise<void> {
  alive();
  ok(
    await runReportPlanStep(
      { planId, sessionKey, step, ...(target !== undefined ? { target } : {}) } as never,
      fx.ctx,
    ),
  );
}
const pi = (id: string) => `planItem:${id}`;

/** A deepen, as the planner's own correction door writes it. */
async function deepen(planId: string, planItemId: string, fields: Record<string, unknown>) {
  alive();
  ok(await runUpdatePlanProposal({ planId, planItemId, ...fields } as never, fx.ctx));
}

// ── Mounting the surface ───────────────────────────────────────────────────
const label = {
  E: () => `${tree.EKey} · Live drawing`,
  S: () => `${tree.SKey} · The generating pane`,
  S2: () => `${tree.S2Key} · The hand-over`,
};
function surface(sessionId: string, trail: { id: string; label: string }[]) {
  return (
    <PlanningWorkspaceHost
      projectKey={fx.projectIdentifier}
      projectName="Acme"
      launch={{ ...parsePlanningLaunch({ mode: 'replan', from: 'project' }), sessionId }}
      onClose={() => {}}
      initialTarget={null}
      initialCanvasTrail={trail}
    />
  );
}
/** Mount on the epic's level, so a driven move to a story is a visible change. */
async function mountAtEpic(sessionId: string) {
  const r = renderWithIntl(surface(sessionId, [{ id: tree.E, label: label.E() }]));
  await settle();
  // A pane that opens on a plan already holding proposals shows the List; the
  // reader switches to the Canvas, which is where following lives.
  const canvasTab = screen.queryByRole('button', { name: 'Canvas' });
  if (canvasTab && canvasTab.getAttribute('aria-pressed') !== 'true') {
    fireEvent.click(canvasTab);
    await settle();
  }
  return r;
}

/**
 * The common opening: a plan with one proposal under each story, the planner
 * authoring the one under S. Mounted on the epic, the canvas is driven to S.
 */
async function drivenToS() {
  const { planId, sessionId } = await agentOpensPlan();
  const [a, b] = await agentAppends(planId, [
    addUnder(tree.S, 'Read the snapshot'),
    addUnder(tree.S2, 'Hand over without a remount'),
  ]);
  await reportStep(planId, 'sess_a', 'author', pi(a!));
  await mountAtEpic(sessionId);
  await until(() => expect(activeCrumb()).toBe(label.S()));
  expect(followState()?.getAttribute('data-follow')).toBe('on');
  return { planId, sessionId, a: a!, b: b! };
}

/** The planner moves on to the card under S2: the one move every case probes with. */
async function plannerMovesToS2(planId: string, b: string) {
  await reportStep(planId, 'sess_a', 'end');
  await reportStep(planId, 'sess_b', 'author', pi(b));
  await tick();
}

/** Every text the live region held while watched, in order. */
function watchAnnouncements(): { said: string[]; stop: () => void } {
  const region = screen.getByTestId('canvas-follow-live');
  const said: string[] = [];
  const obs = new MutationObserver(() => {
    const text = region.textContent ?? '';
    if (text && said.at(-1) !== text) said.push(text);
  });
  obs.observe(region, { subtree: true, childList: true, characterData: true });
  return { said, stop: () => obs.disconnect() };
}

// ════════════════════════════════════════════════════════════════════════════
describe('seam 1 · poll snapshot → driven step → follow request → canvas level', () => {
  it('⭐ an author step drives the canvas to its level, then a lay step to another', async () => {
    const { planId } = await drivenToS();
    expect(followButton()).toBeNull();
    expect(viewsLog.at(-1)).toMatchObject({ live: true, followMode: 'whileOn', hasControl: true });
    expect(canvasLog.at(-1)!.followMode).toBe('whileOn');
    expect(lastFollowKey()).toMatch(/^drive:/);

    // The planner lays S2's children: the canvas follows to S2's level.
    await reportStep(planId, 'sess_a', 'end');
    await reportStep(planId, 'sess_b', 'lay', tree.S2);
    await tick();
    await until(() => expect(activeCrumb()).toBe(label.S2()));
    expect(followState()).not.toBeNull();
    expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
  });

  it('two steps in flight: the canvas holds the EARLIER one until it ends', async () => {
    const { planId, sessionId } = await agentOpensPlan();
    const [a, b] = await agentAppends(planId, [
      addUnder(tree.S, 'Read the snapshot'),
      addUnder(tree.S2, 'Hand over without a remount'),
    ]);
    await reportStep(planId, 'sess_a', 'author', pi(a!));
    await sleep(5); // distinct `startedAt`s
    await reportStep(planId, 'sess_b', 'author', pi(b!));
    await mountAtEpic(sessionId);
    await until(() => expect(activeCrumb()).toBe(label.S()));
    for (let i = 0; i < 3; i += 1) {
      await tick();
      expect(activeCrumb()).toBe(label.S());
    }
    await reportStep(planId, 'sess_a', 'end');
    await tick();
    await until(() => expect(activeCrumb()).toBe(label.S2()));
  });

  it('a step that names no level (settle, an untargeted author, a target off the plan) moves nothing', async () => {
    const { planId, sessionId } = await agentOpensPlan();
    await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    await reportStep(planId, 'sess_a', 'settle');
    await mountAtEpic(sessionId);
    const settled = activeCrumb();
    expect(lastFollowKey() ?? '').not.toMatch(/^drive:/);
    await reportStep(planId, 'sess_a', 'author');
    await tick();
    expect(activeCrumb()).toBe(settled);
    // C1 is a committed card the plan has written nothing for: not on the plan.
    await reportStep(planId, 'sess_a', 'author', tree.C1);
    await tick();
    await tick();
    expect(activeCrumb()).toBe(settled);
    expect(lastFollowKey() ?? '').not.toMatch(/^drive:/);
  });

  it('an unchanged driven step keeps ONE key and is announced once', async () => {
    const { planId, a } = await drivenToS();
    const key = lastFollowKey();
    const heard = watchAnnouncements();
    for (let i = 0; i < 3; i += 1) {
      await deepen(planId, a, { explanationMd: `Why, take ${i}.` });
      await tick();
    }
    heard.stop();
    expect(lastFollowKey()).toBe(key);
    expect(heard.said).toEqual([]);
    expect(activeCrumb()).toBe(label.S());
  });

  const NAVIGATIONS: { via: string; act: (ids: { planId: string; b: string }) => Promise<void> }[] =
    [
      {
        via: 'a crumb',
        act: async () => {
          const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
          fireEvent.click(within(crumbs).getByRole('button', { name: label.E() }));
          await settle();
          await until(() => expect(activeCrumb()).toBe(label.E()));
        },
      },
      {
        via: 'Back',
        act: async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Back' }));
          await settle();
          await until(() => expect(activeCrumb()).toBe(label.E()));
        },
      },
      {
        via: 'a drill',
        act: async ({ planId }) => {
          // The planner moves to a card on the EPIC's level, and the canvas follows
          // there; the reader then drills into a story from it.
          const [e] = await agentAppends(planId, [
            {
              op: 'add',
              proposedFields: { title: 'A sibling story', kind: 'story' },
              parentRef: tree.E,
            },
          ]);
          await reportStep(planId, 'sess_a', 'end');
          await reportStep(planId, 'sess_e', 'author', pi(e!));
          await tick();
          await until(() => expect(activeCrumb()).toBe(label.E()));
          expect(followState()).not.toBeNull();
          await until(() => expect(node(tree.S)).not.toBeNull());
          fireEvent.keyDown(node(tree.S)!, { key: 'Enter' });
          fireEvent.click(within(node(tree.S)!).getByTestId('drill-button'));
          await settle();
          await until(() => expect(activeCrumb()).toBe(label.S()));
        },
      },
      {
        via: 'a search jump',
        act: async () => {
          const input = screen.getByPlaceholderText(/search/i);
          fireEvent.change(input, { target: { value: 'Poll the plan' } });
          fireEvent.submit(input.closest('form')!);
          await settle();
        },
      },
      {
        via: 'the pill’s Go there',
        act: async ({ planId }) => {
          await agentAppends(planId, [addUnder(tree.S2, 'One more on the other story')]);
          await tick();
          const pill = await (async () => {
            await until(() => expect(screen.getByTestId('canvas-arrivals-offer')).toBeTruthy());
            return screen.getByTestId('canvas-arrivals-offer');
          })();
          fireEvent.click(pill);
          await settle();
          await until(() => expect(activeCrumb()).toBe(label.S2()));
        },
      },
    ];
  for (const { via, act } of NAVIGATIONS) {
    it(`${via} turns following OFF: the request goes null, the button shows, the next step moves nothing`, async () => {
      const ids = await drivenToS();
      await act(ids);
      await until(() => expect(followButton()).not.toBeNull());
      expect(lastFollowKey()).toBeNull();
      const here = activeCrumb();
      // A NEW driven step, on a level the reader is not on.
      await reportStep(ids.planId, 'sess_a', 'end');
      await reportStep(ids.planId, 'sess_e', 'end');
      await reportStep(ids.planId, 'sess_c', 'author', pi(here === label.S2() ? ids.a : ids.b));
      await tick();
      await tick();
      expect(activeCrumb()).toBe(here);
      expect(followButton()).not.toBeNull();
      expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
    });
  }

  it('selecting a card and opening its quick view leave following ON', async () => {
    const { planId, a, b } = await drivenToS();
    const proposal = await nodeIdOf(planId, a);
    await until(() => expect(node(proposal)).not.toBeNull());
    fireEvent.click(node(tree.C1)!);
    fireEvent.keyDown(node(proposal)!, { key: 'Enter' });
    fireEvent.click(within(node(proposal)!).getByTestId('view-button'));
    await until(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await settle();
    expect(followState()?.getAttribute('data-follow')).toBe('on');
    await plannerMovesToS2(planId, b);
    await until(() => expect(activeCrumb()).toBe(label.S2()));
  });

  it('Follow the planner lands on the driven level within that render, and the next move lands', async () => {
    const { planId, b } = await drivenToS();
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    fireEvent.click(within(crumbs).getByRole('button', { name: label.E() }));
    await settle();
    await until(() => expect(followButton()).not.toBeNull());
    const reads = planReads.length;
    fireEvent.click(followButton()!);
    await settle();
    expect(planReads.length).toBe(reads); // no tick, no read
    await until(() => expect(activeCrumb()).toBe(label.S()));
    expect(followButton()).toBeNull();
    expect(followState()).not.toBeNull();
    await plannerMovesToS2(planId, b);
    await until(() => expect(activeCrumb()).toBe(label.S2()));
  });

  it('a FAILING read keeps the key and the level; a STALLED plan moves nothing', async () => {
    const { planId, b } = await drivenToS();
    const key = lastFollowKey();
    drop.planReads = FAILING_AFTER;
    await plannerMovesToS2(planId, b);
    for (let i = 1; i < FAILING_AFTER; i += 1) await tick();
    expect(drop.failed).toBe(FAILING_AFTER);
    expect(lastFollowKey()).toBe(key);
    expect(activeCrumb()).toBe(label.S());
    await until(() => expect(followState()?.getAttribute('data-idle')).toBe('true'));

    // Recovered, the move lands; then the plan goes quiet past the stall line.
    await tick();
    await until(() => expect(activeCrumb()).toBe(label.S2()));
    await reportStep(planId, 'sess_b', 'end');
    await reportStep(
      planId,
      'sess_c',
      'author',
      pi((await readReview(planId)).items[0]!.planItemId),
    );
    await adminDb.plan.update({
      where: { id: planId },
      data: { lastActivityAt: new Date(Date.now() - 3_600_000) },
    });
    await adminDb.planStep.updateMany({
      where: { planId },
      data: { startedAt: new Date(Date.now() - 3_600_000) },
    });
    await tick();
    await tick();
    expect(activeCrumb()).toBe(label.S2());
    await until(() => expect(followState()?.getAttribute('data-idle')).toBe('true'));
  });

  it('⭐ the hand-over ends it: the control leaves, the request is null, no offer, no move', async () => {
    const { planId } = await drivenToS();
    await agentAppends(planId, [], true);
    await tick();
    await until(() => expect(screen.queryByTestId('plan-live-state')).toBeNull());
    const leaving = followState();
    if (leaving) {
      expect(leaving.getAttribute('data-leaving')).toBe('true');
      fireEvent.animationEnd(leaving);
    }
    await until(() => expect(followState()).toBeNull());
    expect(followButton()).toBeNull();
    expect(lastFollowKey()).toBeNull();
    expect(viewsLog.at(-1)!.followMode).toBeNull();
    for (let i = 0; i < 2; i += 1) {
      await tick();
      expect(activeCrumb()).toBe(label.S());
      expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
const BODY = 'The planner wrote this description while the reader watched it arrive.';

/** An `author` session's in-flight card, as the plan-step door holds it (MOTIR-11199). */
async function drafting(
  planId: string,
  sessionKey: string,
  planItemId: string,
  seq: number,
  fields: { title?: string; descriptionMd?: string; explanationMd?: string },
) {
  alive();
  await plansService.recordPlanItemDraft(
    planId,
    { sessionKey, itemDraft: { target: pi(planItemId), seq, ...fields } },
    fx.ctx as never,
  );
}

/** The accessible text of `root`: its text without any `aria-hidden` subtree. */
function accessibleText(root: Element): string {
  let out = '';
  const walk = (n: Node) => {
    if (n instanceof Element && n.getAttribute('aria-hidden') === 'true') return;
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    n.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}
const liveText = (field: string) =>
  document.querySelector(`[data-testid="quick-view-live-${field}"] [data-live-partial]`)
    ?.textContent ?? null;
const cueState = () =>
  screen.queryByTestId('quick-view-live-cue')?.getAttribute('data-live-cue') ?? null;

/** Open a proposal's quick view through the CANVAS door. */
async function viewOnCanvas(nodeId: string) {
  await until(() => expect(node(nodeId)).not.toBeNull());
  fireEvent.keyDown(node(nodeId)!, { key: 'Enter' });
  fireEvent.click(within(node(nodeId)!).getByTestId('view-button'));
  await until(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
}

describe('seam 2 · snapshot → the quick view’s live field (MOTIR-11201, Part XXIX)', () => {
  it('⭐ a description being written grows in the open quick view, then the stored card lands (canvas door)', async () => {
    const { planId, a } = await drivenToS();
    await viewOnCanvas(await nodeIdOf(planId, a));
    // The author step targets the card before any partial: the cue, no live field.
    await until(() => expect(cueState()).toBe('writing'));
    expect(liveText('descriptionMd')).toBeNull();

    await drafting(planId, 'sess_a', a, 1, { descriptionMd: 'The planner wrote' });
    await tick();
    await until(() => expect(liveText('descriptionMd')).toBe('The planner wrote'));
    // A screen reader never meets the partial; the one live region is the cue.
    const peek = screen.getByTestId('proposal-peek');
    expect(accessibleText(peek)).not.toContain('The planner wrote');
    expect(peek.querySelectorAll('[role="status"], [aria-live]').length).toBe(1);

    await drafting(planId, 'sess_a', a, 2, { descriptionMd: 'The planner wrote this description' });
    await tick();
    await until(() => expect(liveText('descriptionMd')).toBe('The planner wrote this description'));

    // The write lands and the step ends: the stored card replaces the partial.
    await deepen(planId, a, { descriptionMd: BODY });
    await reportStep(planId, 'sess_a', 'end');
    await tick();
    await until(() => expect(cueState()).toBe('written'));
    expect(liveText('descriptionMd')).toBeNull();
    expect(screen.getByText(BODY)).toBeTruthy();
    expect(screen.getByTestId('quick-view-live-cue').textContent).toBe('Written');
  });

  it('a draft that ends with no write is dropped, and nothing is announced', async () => {
    const { planId, a } = await drivenToS();
    await viewOnCanvas(await nodeIdOf(planId, a));
    await drafting(planId, 'sess_a', a, 1, { descriptionMd: 'Half a thought' });
    await tick();
    await until(() => expect(liveText('descriptionMd')).toBe('Half a thought'));
    await reportStep(planId, 'sess_a', 'end');
    await tick();
    await until(() => expect(cueState()).toBe('idle'));
    expect(screen.queryByText('Half a thought')).toBeNull();
    expect(screen.getByTestId('quick-view-live-cue').textContent).toBe('');
  });

  it('closing and reopening mid-stream shows the current partial at once', async () => {
    const { planId, a } = await drivenToS();
    const nodeId = await nodeIdOf(planId, a);
    await drafting(planId, 'sess_a', a, 1, { title: 'Read the snapshot, then' });
    await tick();
    await viewOnCanvas(nodeId);
    await until(() => expect(liveText('title')).toBe('Read the snapshot, then'));
    fireEvent.click(
      within(screen.getByTestId('proposal-peek')).getAllByRole('button', { name: /close/i })[0]!,
    );
    await settle();
    await until(() => expect(screen.queryByTestId('proposal-peek')).toBeNull());
    await viewOnCanvas(nodeId);
    expect(liveText('title')).toBe('Read the snapshot, then');
    expect(cueState()).toBe('writing');
  });

  it('the List door’s quick view shows the same draft', async () => {
    const { planId, a } = await drivenToS();
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Open .*Read the snapshot/ }));
    await until(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    await drafting(planId, 'sess_a', a, 1, { explanationMd: 'Because the reader' });
    await tick();
    await until(() => expect(liveText('explanationMd')).toBe('Because the reader'));
  });
});

/** A COMMITTED card's quick-view payload, with every typeable field unwritten. */
const COMMITTED: QuickViewData = {
  folderId: null,
  folderPath: [],
  id: 'cmqvitem00000000000000p7',
  identifier: 'PROD-7',
  title: 'Email + password sign-in',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'subtask',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  fixReason: null,
  descriptionMd: null,
  explanationMd: null,
  type: 'code',
  executor: 'coding_agent',
  difficulty: null,
  obsolescence: null,
  obsolescenceNoteMd: null,
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  archived: null,
  parent: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: true,
  status: 'in_progress',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points' as const,
    pointScale: 'fibonacci' as const,
    customScaleValues: [],
    canEdit: true,
  },
};

// ════════════════════════════════════════════════════════════════════════════
describe('guards · never driven, never a partial off the overlay', () => {
  it('⭐ PlanDetail over a GENERATING plan is handed no followMode, reading or control, and never moves', async () => {
    const { planId } = await agentOpensPlan();
    const [a] = await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    const [b] = await agentAppends(planId, [addUnder(tree.S2, 'Hand over')]);
    await reportStep(planId, 'sess_a', 'author', pi(a!));
    await drafting(planId, 'sess_a', a!, 1, {
      descriptionMd: 'A partial the plan page never shows',
    });
    const review = await readReview(planId);
    expect(review.status).toBe('generating');
    search.value = 'view=canvas';
    renderWithIntl(
      <PlanDetail initialReview={review} projectKey={fx.projectIdentifier} ariaLabel="Plan" />,
    );
    await settle();
    await until(() => expect(canvasLog.length).toBeGreaterThan(0));
    const before = activeCrumb();
    await reportStep(planId, 'sess_a', 'end');
    await reportStep(planId, 'sess_b', 'author', pi(b!));
    await tick();
    await tick();
    expect(activeCrumb()).toBe(before);
    expect(viewsLog.length).toBeGreaterThan(0);
    expect(viewsLog.every((v) => v.followMode === null && !v.hasReading && !v.hasControl)).toBe(
      true,
    );
    expect(canvasLog.every((c) => c.followMode === null && !c.hasControl)).toBe(true);
    expect(followState()).toBeNull();
    expect(followButton()).toBeNull();
    expect(document.querySelector('[data-testid^="quick-view-live-"]')).toBeNull();
    expect(screen.queryByText('A partial the plan page never shows')).toBeNull();
  });

  it('the List view: a driven step changes no row and draws no driven state', async () => {
    const { planId, b } = await drivenToS();
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    await settle();
    const list = screen.getByTestId('plan-proposal-list');
    const rows = list.textContent;
    await plannerMovesToS2(planId, b);
    await settle();
    expect(screen.getByTestId('plan-proposal-list').textContent).toBe(rows);
    expect(list.querySelector('[data-follow]')).toBeNull();
    expect(list.querySelector('[data-testid="canvas-bar-trips"]')).toBeNull();
  });

  it('a committed-card quick view handed a live draft shows none of it', async () => {
    renderWithIntl(
      <IssueQuickViewPanel
        state="ready"
        data={COMMITTED}
        {...({
          live: { draft: { writing: true, fields: { title: 'A partial title' } } },
        } as object)}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Email + password sign-in')).toBeTruthy();
    expect(screen.queryByText('A partial title')).toBeNull();
    expect(screen.queryByTestId('quick-view-live-cue')).toBeNull();
  });
});
