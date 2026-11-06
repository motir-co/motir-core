// @vitest-environment happy-dom
//
// THE LIVE-DRAWING INTEGRATION GATE (MOTIR-6301, Story MOTIR-6158).
//
// ── What no unit can see ────────────────────────────────────────────────────
// Every code card of the story shipped its own floor, and every one of them
// drives its subject with a HAND-BUILT snapshot: the live pane's suite
// (`planning-workspace-live-pane.test.tsx`) mocks the conversation hook and feeds
// it `planReviewItem(...)` fixtures; the poll's suite (`useGeneratingPlanPoll`)
// stubs `fetchPlanReview`; the card and motion suites render props. So each card
// can be right against its own idea of the snapshot while the assembled path —
// rows written by the planners, read back through the route, polled, and drawn —
// disagrees with itself.
//
// This file mounts that assembled path and mocks nothing on it:
//
//   the planners' own writers        `lib/mcp/tools/authorPlan.ts` (an MCP agent)
//                                    and `plansService` (deepen, withdraw, close)
//     → Postgres
//     → GET /api/plans/[id]          the REAL route, reached through the REAL
//                                    client (`fetchPlanReview`) by `fetch` being
//                                    dispatched into the route handler
//     → useGeneratingPlanPoll        the REAL poll, inside the REAL
//                                    `usePlanChangeConversation` (a NAMED session
//                                    whose plan an agent is still writing)
//     → PlanningWorkspaceHost        the REAL live pane: PlanProposalViews →
//                                    PlanReviewCanvas → ProjectRoadmapCanvas →
//                                    PlanningCanvas with its motion, each level
//                                    read through the REAL roadmap route
//
// The only substitutions are OUTSIDE that path: the session cookie (`getSession`
// / the workspace + active project it resolves), the router, and three
// app-level panels that reach the server on their own. `PlanningCanvas` and
// `PlanProposalViews` are WRAPPED, never replaced: the wrapper records the props
// the real component was handed (the node and edge MODEL, and whether it was told
// to be live / to move) and renders the real thing.
//
// ⚠️ THE POLL'S CLOCK IS THE ONE THING CONTROLLED. Only `setInterval` is faked,
// so the poll ticks exactly when a test says so and a batch of writes lands in
// ONE snapshot, the way it does between two real 2.5s ticks. Everything else —
// the route's I/O, React's scheduler, the motion's fallback timers — runs on the
// real clock, which is why this file waits with `until` rather than `waitFor`
// (Testing Library's poller is itself a `setInterval`).
import type { ComponentProps } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanReviewDto } from '@/lib/dto/planReview';

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
vi.mock('@/app/(authed)/items/_components/IssueQuickViewPanel', () => ({
  IssueQuickViewPanel: () => null,
}));

// ── The two WRAPPED components: real render, recorded props ────────────────
interface CanvasModel {
  nodes: string[];
  edges: { from: string; to: string; variant: string }[];
  motion: boolean;
}
const { canvasLog, viewsLog } = vi.hoisted(() => ({
  canvasLog: [] as CanvasModel[],
  viewsLog: [] as { live: boolean }[],
}));
vi.mock('@/components/planning/PlanningCanvas', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/planning/PlanningCanvas')>();
  function Recorded(props: ComponentProps<typeof real.PlanningCanvas>) {
    canvasLog.push({
      nodes: props.nodes.map((n) => n.id),
      edges: props.edges.map((e) => ({ from: e.from, to: e.to, variant: e.variant ?? 'firm' })),
      motion: props.motion === true,
    });
    return <real.PlanningCanvas {...props} />;
  }
  return { ...real, PlanningCanvas: Recorded };
});
vi.mock('@/components/planning/PlanProposalViews', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/planning/PlanProposalViews')>();
  function Recorded(props: ComponentProps<typeof real.PlanProposalViews>) {
    viewsLog.push({ live: props.live === true });
    return <real.PlanProposalViews {...props} />;
  }
  return { ...real, PlanProposalViews: Recorded };
});

const { GET: planRoute } = await import('@/app/api/plans/[id]/route');
const { POST: approveRoute } = await import('@/app/api/plans/[id]/approve/route');
const { GET: sessionRoute } = await import('@/app/api/ai/plan-change/session/route');
const { GET: roadmapRoute } = await import('@/app/api/projects/[key]/roadmap/route');
const { plansService } = await import('@/lib/services/plansService');
const { runCreatePlan, runAddPlanItems, runUpdatePlanProposal, runWithdrawPlanProposal } =
  await import('@/lib/mcp/tools/authorPlan');
const { POLL_MS } = await import('@/lib/hooks/useGeneratingPlanPoll');
const { parsePlanningLaunch } = await import('@/lib/planning/launcher');
const { PlanningWorkspaceHost } = await import('@/components/planning/PlanningWorkspaceHost');
const { PlanDetail } = await import('@/components/planning/PlanDetail');
const { WorkItemRoadmap } = await import('@/components/planning/WorkItemRoadmap');

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
function it(name: string, fn: () => Promise<void>): void {
  vitestIt(name, () => {
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
const nodeEls = (id: string) => [...document.querySelectorAll(`[data-node-id="${id}"]`)];
const node = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
const motionOf = (id: string) => node(id)?.getAttribute('data-motion') ?? null;
/** The model the canvas was LAST handed — what the level is, not what is fading. */
const model = (): CanvasModel => canvasLog.at(-1)!;
const edgeKey = (e: { from: string; to: string; variant: string }) =>
  `${e.from}→${e.to}:${e.variant}`;
const edgeKeys = (m: CanvasModel = model()) => m.edges.map(edgeKey).sort();
/** Every drawn node id, duplicates included — "drawn twice" is a count > 1. */
const drawnIds = () =>
  [...document.querySelectorAll('[data-testid="canvas-world"] [data-node-id]')].map(
    (el) => el.getAttribute('data-node-id')!,
  );
const livePaths = () =>
  document.querySelectorAll('[data-testid="canvas-edges"] path:not([data-motion="exit"])').length;

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

// ── Mounting the surface ───────────────────────────────────────────────────
function surface(sessionId: string) {
  return (
    <PlanningWorkspaceHost
      projectKey={fx.projectIdentifier}
      projectName="Acme"
      launch={{ ...parsePlanningLaunch({ mode: 'replan', from: 'project' }), sessionId }}
      onClose={() => {}}
      initialTarget={null}
      initialCanvasTrail={[
        { id: tree.E, label: `${tree.EKey} · Live drawing` },
        { id: tree.S, label: `${tree.SKey} · The generating pane` },
      ]}
    />
  );
}

async function mountSurface(sessionId: string) {
  const r = renderWithIntl(surface(sessionId));
  await settle();
  return r;
}

/**
 * Every motion that APPEARED in the DOM while it was watched — `node:<id>:<motion>`
 * for a card, `edge:<motion>` for an arrow — so a transient phase (an arrow
 * fading out, a card's cue) is asserted as having happened rather than raced.
 */
function watchMotion(): { seen: Set<string>; stop: () => void } {
  const seen = new Set<string>();
  const note = (el: Element) => {
    const m = el.getAttribute('data-motion');
    if (!m) return;
    const id = el.getAttribute('data-node-id');
    seen.add(id ? `node:${id}:${m}` : el.tagName.toLowerCase() === 'path' ? `edge:${m}` : m);
  };
  const scan = (root: Element) => {
    note(root);
    root.querySelectorAll('[data-motion]').forEach(note);
  };
  scan(document.body);
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') note(r.target as Element);
      r.addedNodes.forEach((n) => n instanceof Element && scan(n));
    }
  });
  obs.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-motion'],
  });
  return { seen, stop: () => obs.disconnect() };
}

/** The surface's drawn state, in the terms "equals a fresh mount" is judged by. */
function drawnState() {
  const m = model();
  return {
    nodes: [...m.nodes].sort(),
    edges: edgeKeys(m),
    dom: drawnIds().sort(),
    titles: [...document.querySelectorAll('[data-testid="canvas-world"] [data-node-id]')]
      .map((el) => `${el.getAttribute('data-node-id')}=${el.textContent}`)
      .sort(),
    paths: livePaths(),
    marker: screen.queryByTestId('plan-live-state')?.textContent ?? null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
describe('MOTIR-6301 · the poll → pane seam, against rows the planners wrote', () => {
  it('⭐ append, off-level, deepen — each drawn once, from the real read', async () => {
    const { planId, sessionId } = await agentOpensPlan();
    await mountSurface(sessionId);

    // The pane is LIVE from the plan's first read, on the level the reader stood.
    // Nothing is proposed yet, so the marker's word is the progress line's
    // `starting` state (design/ai-planning Part XXVI §26.1 · MOTIR-7829), not yet
    // *Being written*.
    await until(() => expect(screen.getByTestId('plan-live-state').textContent).toBe('Starting…'));
    await until(() => expect(node(tree.C1)).not.toBeNull());
    expect(viewsLog.at(-1)!.live).toBe(true);
    expect(model().motion).toBe(true);
    expect(node(tree.D)).not.toBeNull();

    // ── 1. APPEND two cards, one `blocked_by` the other — both land, WITH the edge ──
    const [a1] = await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    const [a2] = await agentAppends(planId, [addUnder(tree.S, 'Draw the arrow', [a1!])]);
    const n1 = await nodeIdOf(planId, a1!);
    const n2 = await nodeIdOf(planId, a2!);
    await tick();
    await until(() => expect(node(n2)).not.toBeNull());
    expect(node(n1)).not.toBeNull();
    expect(edgeKeys()).toContain(`${n1}→${n2}:pending`);
    expect(motionOf(n1)).toBe('enter');
    expect(motionOf(n2)).toBe('enter');
    expect(screen.getByTestId('plan-live-announce').textContent).toBe('2 items added to the plan');
    await until(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));

    // ── 2. A third whose blocker is on ANOTHER level — the anchor, and that level's count ──
    const [b] = await agentAppends(planId, [addUnder(tree.S2, 'Hand over without a remount')]);
    const [a3] = await agentAppends(planId, [addUnder(tree.S, 'Wait for the hand-over', [b!])]);
    const nb = await nodeIdOf(planId, b!);
    const n3 = await nodeIdOf(planId, a3!);
    await tick();
    await until(() => expect(node(n3)).not.toBeNull());
    // The blocker is drawn HERE only as the off-level anchor, with the `cross` arrow.
    expect(nodeEls(nb)).toHaveLength(1);
    expect(model().nodes).toContain(nb);
    expect(edgeKeys()).toContain(`${nb}→${n3}:cross`);
    expect(node(n3)!.querySelector('[data-testid="cross-blocked-flag"]')).not.toBeNull();
    // …and the level it DOES sit on is counted, never jumped to.
    expect(screen.getByTestId('canvas-arrivals-offer').textContent).toBe(
      `1 new in ${tree.S2Key} · Go there`,
    );
    await until(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));

    // ── 3. DEEPEN a body — cued in place, never re-entered ──
    const before = node(n1);
    const deepen = watchMotion();
    await plansService.deepenProposal(
      planId,
      a1!,
      { descriptionMd: 'Replace the set on every read.' },
      fx.ctx,
    );
    await tick();
    await until(() => expect(deepen.seen).toContain(`node:${n1}:cue`));
    await until(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));
    deepen.stop();
    expect(node(n1)).toBe(before);
    expect(deepen.seen).not.toContain(`node:${n1}:enter`);
    expect(deepen.seen).not.toContain(`node:${n1}:exit`);

    // Nothing, at any point after the churn, is drawn twice.
    const ids = drawnIds();
    expect(new Set(ids).size).toBe(ids.length);
    const keys = edgeKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(unserved).toEqual([]);
  });

  // Steps 4–6 continue the SAME plan shape from a fresh mount, not from the one
  // steps 1–3 drew on: one body holding all six steps ran at the 15 s budget on a
  // loaded CI shard (MOTIR-7203). Every assertion of 4–6 is unchanged. The plan's
  // FIRST read holds one container's cards only — a plan spread across two opens
  // in the List (`defaultPlanView`, pinned at that read), whose rows keep their
  // entrance mark — so the off-level pair lands on a live tick, as step 2's did.
  it('⭐ rewire, modify, withdraw — each drawn once, from the real read', async () => {
    const { planId, sessionId } = await agentOpensPlan();
    const [a1] = await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    const [a2] = await agentAppends(planId, [addUnder(tree.S, 'Draw the arrow', [a1!])]);
    const n1 = await nodeIdOf(planId, a1!);
    const n2 = await nodeIdOf(planId, a2!);
    await mountSurface(sessionId);
    await until(() => expect(node(n2)).not.toBeNull());
    expect(edgeKeys()).toContain(`${n1}→${n2}:pending`);
    const [b] = await agentAppends(planId, [addUnder(tree.S2, 'Hand over without a remount')]);
    const [a3] = await agentAppends(planId, [addUnder(tree.S, 'Wait for the hand-over', [b!])]);
    const nb = await nodeIdOf(planId, b!);
    const n3 = await nodeIdOf(planId, a3!);
    await tick();
    await until(() => expect(node(n3)).not.toBeNull());
    expect(edgeKeys()).toContain(`${nb}→${n3}:cross`);
    await until(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));

    // ── 4. update_plan_proposal REWIRES blockedByRefs — the old edge exits, the new enters ──
    // From the proposal it named to a COMMITTED card on the level — a rewire the
    // withdrawal below cannot be refused over (a referenced proposal cannot go).
    const rewire = watchMotion();
    ok(
      await runUpdatePlanProposal(
        { planId, planItemId: a2!, blockedByRefs: [tree.C1] } as never,
        fx.ctx,
      ),
    );
    await tick();
    await until(() => expect(edgeKeys()).toContain(`${tree.C1}→${n2}:pending`));
    expect(edgeKeys()).not.toContain(`${n1}→${n2}:pending`);
    await until(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));
    rewire.stop();
    // The old arrow faded OUT and the new one drew IN; no card entered or left.
    expect(rewire.seen).toContain('edge:exit');
    expect(rewire.seen).toContain('edge:enter');
    expect(
      [...rewire.seen].filter((m) => /:(enter|exit)$/.test(m) && m.startsWith('node:')),
    ).toEqual([]);

    // ── 5. A modify's `blockedByAdd` on a COMMITTED card — its edge renders ──
    await agentAppends(planId, [
      { op: 'modify', workItemId: tree.C1, patch: { blockedByAdd: [`planItem:${a1}`] } },
    ]);
    await tick();
    await until(() => expect(edgeKeys()).toContain(`${n1}→${tree.C1}:pending`));
    expect(nodeEls(tree.C1)).toHaveLength(1);
    await until(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));

    // ── 6. WITHDRAW — the card exits, and never returns on a later snapshot ──
    const withdraw = watchMotion();
    ok(await runWithdrawPlanProposal({ planId, planItemId: a3! } as never, fx.ctx));
    await tick();
    await until(() => expect(withdraw.seen).toContain(`node:${n3}:exit`));
    withdraw.stop();
    await until(() => expect(node(n3)).toBeNull());
    expect(model().nodes).not.toContain(n3);
    // The anchor it alone needed leaves with it (§23.6).
    expect(model().nodes).not.toContain(nb);
    await until(() => expect(node(nb)).toBeNull());
    for (let i = 0; i < 3; i += 1) {
      await tick();
      expect(node(n3)).toBeNull();
      expect(model().nodes).not.toContain(n3);
    }

    // Nothing, at any point after the churn, is drawn twice.
    const ids = drawnIds();
    expect(new Set(ids).size).toBe(ids.length);
    const keys = edgeKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(unserved).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MOTIR-6301 · a dropped read, and the recovery (§23.10)', () => {
  it('⭐ two failed reads, writes in between, then recovery — equal to a fresh mount, nothing twice', async () => {
    const { planId, sessionId } = await agentOpensPlan();
    const [a1] = await agentAppends(planId, [addUnder(tree.S, 'A card to be withdrawn')]);
    const [a0] = await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    const [a2] = await agentAppends(planId, [addUnder(tree.S, 'Draw the arrow', [a0!])]);
    const view = await mountSurface(sessionId);
    const n1 = await nodeIdOf(planId, a1!);
    const n2 = await nodeIdOf(planId, a2!);
    await until(() => expect(node(n2)).not.toBeNull());

    // The connection drops for two reads. Meanwhile the agent keeps writing: one
    // new card, one withdrawal of a card already drawn.
    drop.planReads = 2;
    const [a3] = await agentAppends(planId, [addUnder(tree.S, 'Survive the drop', [a2!])]);
    ok(await runWithdrawPlanProposal({ planId, planItemId: a1! } as never, fx.ctx));
    const n3 = await nodeIdOf(planId, a3!);
    await tick();
    await tick();
    expect(drop.failed).toBe(2);
    // The last good snapshot stands through the failures — nothing cleared.
    expect(node(n1)).not.toBeNull();
    expect(node(n3)).toBeNull();
    expect(screen.getByTestId('plan-live-state').textContent).toBe('Being written');

    // Recovery: the next read is a normal snapshot.
    await tick();
    await until(() => expect(node(n3)).not.toBeNull());
    await until(() => expect(node(n1)).toBeNull());
    await until(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));
    await tick();
    const recovered = drawnState();

    // No node id and no edge key twice.
    expect(new Set(recovered.dom).size).toBe(recovered.dom.length);
    expect(new Set(recovered.edges).size).toBe(recovered.edges.length);
    expect(recovered.edges).toContain(`${n2}→${n3}:pending`);
    expect(recovered.nodes).not.toContain(n1);

    // A FRESH MOUNT of the same plan draws exactly what the recovered pane does.
    view.unmount();
    cleanup();
    canvasLog.length = 0;
    await mountSurface(sessionId);
    await until(() => expect(node(n3)).not.toBeNull());
    await settle();
    expect(drawnState()).toEqual(recovered);
    expect(unserved).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MOTIR-6301 · one review model, drawn identically live and proposed', () => {
  it('⭐ the live pane and the plan page draw the same node ids and the same (from, to, variant) edges', async () => {
    const { planId, sessionId } = await agentOpensPlan();
    const [a1] = await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    const [b] = await agentAppends(planId, [addUnder(tree.S2, 'Hand over')]);
    await agentAppends(planId, [
      addUnder(tree.S, 'Draw the arrow', [a1!]),
      addUnder(tree.S, 'Wait for the hand-over', [b!]),
      { op: 'modify', workItemId: tree.C1, patch: { blockedByAdd: [`planItem:${a1}`] } },
    ]);

    // ── LIVE: the surface, fed by the poll ──
    const live = await mountSurface(sessionId);
    await until(() => expect(screen.getByTestId('plan-live-state')).toBeTruthy());
    // The level has settled once the first add — the card every edge here touches
    // but the cross one — is drawn and nothing is still moving.
    const n1 = await nodeIdOf(planId, a1!);
    await until(() => expect(model().nodes).toEqual(expect.arrayContaining([tree.C1, n1])));
    await until(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));
    await settle();
    const liveModel = model();
    expect(viewsLog.at(-1)!.live).toBe(true);
    // The ONE model the poll handed the pane — the route's read of this plan.
    const theModel = await readReview(planId);
    expect(theModel.status).toBe('generating');
    live.unmount();
    cleanup();

    // ── PROPOSED: the plan page's `PlanReviewCanvas`, handed the SAME model ──
    canvasLog.length = 0;
    // The page picks its own default view by the plan's size; the model under
    // test is the CANVAS's, so the page is opened on it, through its own URL.
    search.value = 'view=canvas';
    renderWithIntl(
      <PlanDetail
        initialReview={{ ...theModel, status: 'planned' }}
        projectKey={fx.projectIdentifier}
        ariaLabel="Plan"
      />,
    );
    await settle();
    // The page opens at its default level; walk it to the reader's.
    await until(() => expect(model().nodes.length).toBeGreaterThan(0));
    const pageAtDefault = model();
    const pageModel = pageAtDefault.nodes.includes(tree.C1)
      ? pageAtDefault
      : await drillPageTo([tree.E, tree.S]);

    expect([...pageModel.nodes].sort()).toEqual([...liveModel.nodes].sort());
    expect(edgeKeys(pageModel)).toEqual(edgeKeys(liveModel));
    // …a parity of two empty drawings cannot pass: the cross, the pending pair
    // and the modify's committed-end edge are all in it.
    expect(edgeKeys(liveModel).some((k) => k.endsWith(':cross'))).toBe(true);
    expect(edgeKeys(liveModel).filter((k) => k.endsWith(':pending')).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(unserved).toEqual([]);
  });

  it('⭐ the HAND-OVER: the proposed plan is drawn from the same model the live pane last drew', async () => {
    const { planId, sessionId } = await agentOpensPlan();
    const [a1] = await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    await agentAppends(planId, [addUnder(tree.S, 'Draw the arrow', [a1!])]);
    await mountSurface(sessionId);
    await until(() => expect(screen.getByTestId('plan-live-state')).toBeTruthy());
    await until(() => expect(model().edges.length).toBe(1));
    const liveModel = model();
    const views = screen.getByTestId('plan-proposal-views');

    // The agent closes the plan — the poll sees it leave `generating`.
    await agentAppends(planId, [], true);
    await tick();
    await until(() => expect(screen.queryByTestId('plan-live-state')).toBeNull());
    await until(() => expect(screen.getByTestId('plan-change-confirm-bar')).toBeTruthy());
    expect(viewsLog.at(-1)!.live).toBe(false);
    expect(screen.getByTestId('plan-proposal-views')).toBe(views);
    expect([...model().nodes].sort()).toEqual([...liveModel.nodes].sort());
    expect(edgeKeys()).toEqual(edgeKeys(liveModel));
    // The proposed pane does not move — motion is the live pane's alone.
    expect(model().motion).toBe(false);
    // …and the GENERATING poll has stopped: it issues no further read. Not "no
    // further plan read at all": once the plan is awaiting a decision, MOTIR-6151's
    // gate watch re-reads it on its own interval, deliberately — counting those
    // failed this case twice on CI. A generating poll that had NOT stopped would
    // still add one read per tick here.
    await settle();
    expect(generatingPollReads.length).toBeGreaterThan(0);
    const pollReads = generatingPollReads.length;
    await tick();
    await tick();
    expect(generatingPollReads.length).toBe(pollReads);
  });
});

/** Drill the plan page's canvas by activating each crumb's node in turn. */
async function drillPageTo(path: string[]): Promise<CanvasModel> {
  for (const id of path) {
    await until(() => expect(node(id)).not.toBeNull());
    const el = node(id)!;
    fireEvent.click(el);
    const drill = el.querySelector<HTMLElement>('[data-testid="drill-button"]');
    if (drill) fireEvent.click(drill);
    else fireEvent.keyDown(el, { key: 'Enter' });
    await settle();
  }
  await until(() => expect(model().nodes).toContain(tree.C1));
  return model();
}

// ════════════════════════════════════════════════════════════════════════════
describe('MOTIR-6301 · one card on every surface', () => {
  it('⭐ an untouched DONE card is drawn on the live pane exactly as /roadmap draws it — no hatch', async () => {
    const { planId, sessionId } = await agentOpensPlan();
    await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    // A SECOND done card the plan DOES touch — so the hatch selector is shown to
    // match something, and "no hatch" on the untouched one is not vacuous.
    const touched = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Finished and amended',
      parentId: tree.S,
    });
    await adminDb.workItem.update({ where: { id: touched.id }, data: { status: 'done' } });
    await agentAppends(planId, [
      { op: 'modify', workItemId: touched.id, patch: { title: 'Finished, retitled' } },
    ]);

    await mountSurface(sessionId);
    // The LIVE pane, holding the plan — not the roadmap drawn before its first read.
    await until(() => expect(screen.getByTestId('plan-live-state')).toBeTruthy());
    await until(() =>
      expect(node(touched.id)?.querySelector('[data-testid="plan-item-node"]')).toBeTruthy(),
    );
    expect(node(tree.D)).not.toBeNull();
    await until(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));
    expect(node(tree.D)!.querySelector('[data-testid="plan-item-lock-hatch"]')).toBeNull();
    expect(node(tree.D)!.getAttribute('aria-disabled')).not.toBe('true');
    expect(node(touched.id)!.querySelector('[data-testid="plan-item-lock-hatch"]')).not.toBeNull();
    // The CARD is compared — the canvas's own per-node wrapper carries surface
    // state (a selection's dim, the emphasis ring) that is not the card's.
    const card = () => node(tree.D)!.querySelector('[data-node-state]')!;
    expect(card().getAttribute('data-node-state')).toBe('done');
    const onPane = card().outerHTML;
    cleanup();

    // /roadmap — its client canvas, over the same route, on the same level.
    renderWithIntl(
      <WorkItemRoadmap
        projectKey={fx.projectIdentifier}
        initialTrail={[
          { id: tree.E, label: `${tree.EKey} · Live drawing` },
          { id: tree.S, label: `${tree.SKey} · The generating pane` },
        ]}
      />,
    );
    await settle();
    await until(() => expect(node(tree.D)).not.toBeNull());
    expect(card().outerHTML).toBe(onPane);
  });

  it('⭐ a DECIDED add carries exactly ONE outcome spine', async () => {
    const { planId, sessionId } = await agentOpensPlan();
    const [a1] = await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    await agentAppends(planId, [addUnder(tree.S, 'Draw the arrow', [a1!])], true);
    const n1 = await nodeIdOf(planId, a1!);

    await mountSurface(sessionId);
    await until(() => expect(screen.getByTestId('plan-change-confirm-bar')).toBeTruthy());
    await until(() => expect(node(n1)).not.toBeNull());
    expect(node(n1)!.querySelectorAll('[data-testid$="outcome-spine"]')).toHaveLength(0);

    // Approve from the surface's own bar — the real approve route writes the tree.
    fireEvent.click(
      within(screen.getByTestId('plan-change-confirm-bar')).getByRole('button', {
        name: /^Approve$/,
      }),
    );
    await settle();
    await until(() =>
      expect(document.querySelectorAll('[data-testid$="outcome-spine"]').length).toBeGreaterThan(0),
    );
    // The two accepted adds, found by TITLE (not by the spine being counted).
    const byTitle = (title: string) =>
      [...document.querySelectorAll('[data-testid="canvas-world"] [data-node-id]')].filter((el) =>
        el.textContent?.includes(title),
      );
    for (const title of ['Read the snapshot', 'Draw the arrow']) {
      const drawn = byTitle(title);
      expect(drawn).toHaveLength(1);
      expect(drawn[0]!.querySelectorAll('[data-testid$="outcome-spine"]')).toHaveLength(1);
    }
    // The committed card the plan never touched wears none.
    expect(node(tree.C1)!.querySelectorAll('[data-testid$="outcome-spine"]')).toHaveLength(0);
    // …and each accepted card is drawn ONCE — as the committed node the level now
    // returns, never beside a keyless ghost of the proposal it was (MOTIR-3206).
    const ids = drawnIds();
    expect(new Set(ids).size).toBe(ids.length);
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('approved');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MOTIR-6301 · the plan page does not opt into the live pane', () => {
  it('⭐ PlanDetail, even over a GENERATING plan, hands neither `live` nor `motion` down', async () => {
    const { planId } = await agentOpensPlan();
    const [a1] = await agentAppends(planId, [addUnder(tree.S, 'Read the snapshot')]);
    await agentAppends(planId, [addUnder(tree.S, 'Draw the arrow', [a1!])]);
    const review = await readReview(planId);
    expect(review.status).toBe('generating');

    renderWithIntl(
      <PlanDetail initialReview={review} projectKey={fx.projectIdentifier} ariaLabel="Plan" />,
    );
    await settle();
    await until(() => expect(canvasLog.length).toBeGreaterThan(0));
    // The page's own poll ticks too — and still nothing moves.
    await agentAppends(planId, [addUnder(tree.S, 'A third')]);
    await tick();
    expect(viewsLog.length).toBeGreaterThan(0);
    expect(viewsLog.every((v) => v.live === false)).toBe(true);
    expect(canvasLog.every((c) => c.motion === false)).toBe(true);
    expect(document.querySelectorAll('[data-motion]')).toHaveLength(0);

    // …and statically: the page's source passes neither prop.
    const src = readFileSync(
      resolve(__dirname, '../../../components/planning/PlanDetail.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(/\blive(?:Failing)?=\{/);
    expect(src).not.toMatch(/\bmotion=\{/);
  });
});
