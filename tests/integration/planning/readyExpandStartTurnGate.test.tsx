// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestWorkItem } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { plansService } from '@/lib/services/plansService';
import { truncateAuthTables } from '../../helpers/db';
import { renderWithIntl } from '../../helpers/renderWithIntl';

// STORY GATE — /ready's EXPAND STARTS ONE PLANNING CONVERSATION
// (Story MOTIR-5266 · Subtask MOTIR-7877).
//
// ⚠️ WHAT THIS FILE IS NOT. Each code card pinned its own unit against a STUBBED
// neighbour: the banner's push (`tests/components/expansion-nudge-banner.test.tsx`),
// the address round trip (`tests/planning/launcher.test.ts`) and the overlay's
// single send with the conversation hook stubbed
// (`tests/components/planning-start-turn.test.tsx`). None of that is re-asserted.
//
// WHAT IS. The assembled seam, against REAL rows. The overlay is mounted at the
// exact address the banner writes —
// `withPlanningOverlay('/ready?lane=main', { kind: 'work-item', itemKey, startTurn })`
// — and everything from there is real: `PlanningWorkspaceOverlay` → the host → the
// rail → `usePlanChangeConversation` → `planChangeClient` / `planningAnchorClient`,
// whose `fetch` is routed into the REAL route handlers:
//
//   GET  /api/work-items/planning-anchor?key=        (the anchor read)
//   GET  /api/work-items/{id}/ai/plan                (the contextual resume read)
//   POST /api/work-items/{id}/ai/plan                (the first-turn send)
//   GET  /api/work-items/{id}/ai/plan/{jobId}/stream (the run's relay)
//
// The assertions are on `plan_change_session` / `plan_change_turn` rows. The
// failure caught is the one every unit stays green through: the start turn sent
// TWICE — by a remount, a reload, a StrictMode double effect or two launches in a
// row — or sent INTO a conversation the stub already had.
//
// Mocked — the boundaries OUTSIDE the path, and nothing in it:
//   · the motir-ai client (a Vitest process must not reach it): `submitJob`
//     answers a job id, `streamJob` yields one quiet frame and then stays open,
//     as a running job does;
//   · the request scope the routes read: `getSession` (the one mock `CLAUDE.md`
//     sanctions) and `getActiveProject`, exactly as `pickPlanSeam.test.ts` does;
//   · `next/navigation` and `shallowUrl` — the host's ONE replace is recorded and
//     applied to the address, so a remount reads what the page would;
//   · the canvases, the onboarding routing read, the substrate poll, the
//     composer's target search and the project-access provider — surfaces beside
//     the conversation that reach the server for reasons of their own.
// Any OTHER request is answered 404 and recorded in `unserved`; the run asserts
// none of them carries the conversation (`assertNoConversationRequestUnserved`).

// ── The motir-ai boundary ───────────────────────────────────────────────────
let jobSeq = 0;
const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: `job-ready-${++jobSeq}` }));
/** Every open stream's release — a running job's stream ends only when released. */
const openStreams = new Set<() => void>();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: vi.fn(),
  streamJob: async function* () {
    yield { event: 'turn', data: {} };
    await new Promise<void>((release) => openStreams.add(release));
  },
}));

// ── The request scope ───────────────────────────────────────────────────────
const auth = vi.hoisted(() => ({
  session: null as { user: { id: string; email: string; name: string } } | null,
  ctx: null as ProjectContext | null,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => auth.session,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => auth.ctx,
}));
// The plan read resolves its workspace from the `workspace_id` cookie.
vi.mock('next/headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/headers')>()),
  cookies: async () => ({
    get: (name: string) =>
      name === 'workspace_id' && auth.ctx ? { name, value: auth.ctx.workspaceId } : undefined,
    getAll: () => [],
    has: (name: string) => name === 'workspace_id' && auth.ctx !== null,
  }),
  headers: async () => new Headers(),
}));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getLocale: async () => 'en',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

// ── The page's address ──────────────────────────────────────────────────────
// A SUBSCRIBED address, as Next's is: a shallow replace re-renders every reader of
// `useSearchParams`, which is what re-runs an effect keyed on the address.
const nav = vi.hoisted(() => ({
  pathname: '/ready',
  search: '',
  listeners: new Set<() => void>(),
}));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (fn: () => void) => {
    nav.listeners.add(fn);
    return () => nav.listeners.delete(fn);
  };
  return {
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    usePathname: () => useSyncExternalStore(subscribe, () => nav.pathname),
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => nav.search)),
  };
});
const { shallowReplace, shallowPush } = vi.hoisted(() => ({
  shallowReplace: vi.fn((href: string) => {
    window.history.replaceState(null, '', href);
    const url = new URL(href, 'http://localhost:3000');
    nav.pathname = url.pathname;
    nav.search = url.search.replace(/^\?/, '');
    for (const notify of nav.listeners) notify();
  }),
  shallowPush: vi.fn(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace }));

// ── Surfaces beside the conversation ────────────────────────────────────────
vi.mock('@/lib/planning/onboardingRoutingClient', () => ({
  resolveOnboardingRouting: vi.fn(() => new Promise(() => {})),
}));
vi.mock('@/lib/planning/substratePoll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/substratePoll')>()),
  fetchPlanningSubstrate: vi.fn(() => new Promise(() => {})),
}));
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: () => true }),
}));
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: () => ({ results: [], loading: false, tooShort: true }),
}));
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="review-canvas-stub" />,
}));

const { PlanningWorkspaceOverlay } = await import('@/components/planning/PlanningWorkspaceOverlay');
const { withPlanningOverlay, OVERLAY_PARAM_NAMES } = await import('@/lib/planning/launcher');
const { resetPickAutoSendClaimsForTests } = await import('@/lib/planning/pickAutoSend');
const { GET: anchorRoute } = await import('@/app/api/work-items/planning-anchor/route');
const { GET: resumeRoute, POST: planRoute } =
  await import('@/app/api/work-items/[id]/ai/plan/route');
const { GET: streamRoute } = await import('@/app/api/work-items/[id]/ai/plan/[jobId]/stream/route');
const { GET: planReadRoute } = await import('@/app/api/plans/[id]/route');
const { GET: sessionReadRoute } = await import('@/app/api/ai/plan-change/session/route');

// ── fetch → the REAL handlers ───────────────────────────────────────────────
const BASE = 'http://localhost:3000';
const inFlight = new Set<Promise<unknown>>();
/** Every request a real handler answered, as `<METHOD> <path> <status>`. */
const served: string[] = [];
/** Every request this seam does not serve — answered 404, recorded, inspected. */
const unserved: string[] = [];

function installFetch(): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, BASE);
    const method = init?.method ?? 'GET';
    const request = () =>
      new Request(url, {
        method,
        headers: init?.headers,
        ...(init?.body !== undefined ? { body: init.body } : {}),
      });
    const run = async (): Promise<Response> => {
      let res: Response | null = null;
      const plan = /^\/api\/work-items\/([^/]+)\/ai\/plan$/.exec(url.pathname);
      const stream = /^\/api\/work-items\/([^/]+)\/ai\/plan\/([^/]+)\/stream$/.exec(url.pathname);
      const planRead = /^\/api\/plans\/([^/]+)$/.exec(url.pathname);
      if (url.pathname === '/api/work-items/planning-anchor' && method === 'GET') {
        res = await anchorRoute(request());
      } else if (plan && method === 'GET') {
        res = await resumeRoute(request(), {
          params: Promise.resolve({ id: decodeURIComponent(plan[1]!) }),
        });
      } else if (plan && method === 'POST') {
        res = await planRoute(request(), {
          params: Promise.resolve({ id: decodeURIComponent(plan[1]!) }),
        });
      } else if (stream && method === 'GET') {
        res = await streamRoute(request(), {
          params: Promise.resolve({
            id: decodeURIComponent(stream[1]!),
            jobId: decodeURIComponent(stream[2]!),
          }),
        });
      } else if (planRead && method === 'GET') {
        res = await planReadRoute(request(), {
          params: Promise.resolve({ id: decodeURIComponent(planRead[1]!) }),
        });
      } else if (url.pathname === '/api/ai/plan-change/session' && method === 'GET') {
        res = await sessionReadRoute(request());
      }
      if (res) {
        served.push(`${method} ${url.pathname} ${res.status}`);
        return res;
      }
      unserved.push(`${method} ${url.pathname}`);
      return new Response(JSON.stringify({ code: 'NOT_SERVED' }), { status: 404 });
    };
    // Honour the caller's abort as a browser does: an aborted read REJECTS, and
    // whatever the handler answers afterwards never reaches the caller.
    const signal = init?.signal;
    const handled = run();
    // The handler's own work is settled even when its caller stopped listening.
    inFlight.add(handled);
    void handled.finally(() => inFlight.delete(handled)).catch(() => {});
    const p = signal
      ? Promise.race([
          handled,
          new Promise<never>((_, reject) => {
            const abort = () => reject(new DOMException('aborted', 'AbortError'));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          }),
        ])
      : handled;
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  });
}

/** Drain every route call in flight and every render it causes. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await Promise.allSettled([...inFlight]);
      await new Promise((r) => setTimeout(r, 0));
    });
    if (inFlight.size === 0) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      if (inFlight.size === 0) return;
    }
  }
  throw new Error('route calls never settled');
}

/** The conversation's own requests must all have reached a real handler. */
function assertNoConversationRequestUnserved(): void {
  const conversational = unserved.filter((r) =>
    /\/api\/(work-items\/|ai\/plan-change|ai\/ask|plans\/)/.test(r),
  );
  expect(conversational, 'a conversation request fell through the seam').toEqual([]);
}

/** Every console.error the run printed — an act warning is a real finding. */
const consoleErrors: string[] = [];

// ── Fixture ─────────────────────────────────────────────────────────────────
let fx: WorkItemFixture;
let stub: WorkItem;

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
  served.length = 0;
  unserved.length = 0;
  resetPickAutoSendClaimsForTests();
  fx = await makeWorkItemFixture();
  auth.session = { user: { id: fx.owner.id, email: fx.owner.email, name: fx.owner.name } };
  auth.ctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  } as ProjectContext;
  stub = await createTestWorkItem(fx, { kind: 'story', title: 'Billing (a thin stub)' });
  installFetch();
  consoleErrors.length = 0;
  const original = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
    original(...args);
  });
});

afterEach(async () => {
  cleanup();
  for (const release of openStreams) release();
  openStreams.clear();
  await Promise.allSettled([...inFlight]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(
    consoleErrors.filter((m) => m.includes('not wrapped in act')),
    'no update landed outside an act scope',
  ).toEqual([]);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Helpers ─────────────────────────────────────────────────────────────────
/** The address the banner writes for this stub (MOTIR-7876). */
const launchAddress = () =>
  withPlanningOverlay('/ready?lane=main', {
    kind: 'work-item',
    itemKey: stub.identifier,
    startTurn: true,
  });

function openAt(href: string): void {
  const url = new URL(href, BASE);
  nav.pathname = url.pathname;
  nav.search = url.search.replace(/^\?/, '');
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
}

const overlay = () => (
  <PlanningWorkspaceOverlay projectKey={fx.projectIdentifier} projectName="Acme" substrate={null} />
);

/** Mount the overlay at `href` and let every real read and write settle. */
async function launch(href = launchAddress(), ui = overlay()) {
  openAt(href);
  const view = renderWithIntl(ui, { now: NOW });
  await settle();
  return view;
}

/** A reload: a fresh page — the page-level claim gone, the database kept. */
function reloadPage(): void {
  cleanup();
  resetPickAutoSendClaimsForTests();
}

const sessionsOnStub = () =>
  adminDb.planChangeSession.findMany({
    where: { projectId: fx.projectId, targetKeys: { has: stub.identifier } },
    include: { turns: { orderBy: { seq: 'asc' } } },
  });

async function rows() {
  const sessions = await sessionsOnStub();
  const userTurns = sessions.flatMap((s) => s.turns.filter((t) => t.role === 'user'));
  return {
    allSessions: await adminDb.planChangeSession.count(),
    allTurns: await adminDb.planChangeTurn.count(),
    sessions,
    userTurns: userTurns.map((t) => t.body),
  };
}

/** The page's clock — the rail's relative times measure against it. */
const NOW = new Date();

const startTurn = () => `Plan ${stub.identifier}`;

/** The one session and its one user turn the launch must leave. */
async function expectOneStart(): Promise<string> {
  const r = await rows();
  expect(r.allSessions, 'one session in the whole project').toBe(1);
  expect(r.sessions).toHaveLength(1);
  expect(r.sessions[0]!.targetKeys).toEqual([stub.identifier]);
  expect(r.sessions[0]!.createdById).toBe(fx.ownerId);
  expect(r.sessions[0]!.endedAt).toBeNull();
  expect(r.userTurns, 'exactly one user turn, the start turn').toEqual([startTurn()]);
  return r.sessions[0]!.id;
}

const posts = () => served.filter((s) => s.startsWith('POST ')).length;

// ════════════════════════════════════════════════════════════════════════════

describe('SEAM: Expand’s address → ONE session on the stub, ONE “Plan <KEY>” turn', () => {
  it('the launch reads the anchor, finds no conversation, and sends the start turn once', async () => {
    expect((await rows()).allSessions).toBe(0);
    await launch();

    expect(served).toContain(`GET /api/work-items/planning-anchor 200`);
    expect(served).toContain(`GET /api/work-items/${stub.id}/ai/plan 200`);
    expect(served).toContain(`POST /api/work-items/${stub.id}/ai/plan 200`);
    expect(posts(), 'one send').toBe(1);
    const sessionId = await expectOneStart();

    // The send reached motir-ai once, on this stub's session.
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const r = await rows();
    expect(r.sessions[0]!.lastJobId).toBe('job-ready-1');

    // The address now NAMES the conversation instead of asking to start one —
    // ONE replace, planStart gone, planSession the DB row's id, the lane kept.
    expect(shallowReplace).toHaveBeenCalledTimes(1);
    const replaced = new URL(shallowReplace.mock.calls[0]![0] as string, BASE);
    expect(replaced.pathname).toBe('/ready');
    expect(replaced.searchParams.get('lane')).toBe('main');
    expect(replaced.searchParams.has(OVERLAY_PARAM_NAMES.start)).toBe(false);
    expect(replaced.searchParams.get(OVERLAY_PARAM_NAMES.session)).toBe(sessionId);
    expect(replaced.searchParams.get(OVERLAY_PARAM_NAMES.item)).toBe(stub.identifier);

    assertNoConversationRequestUnserved();
  });

  it('a REMOUNT on the same page, at the same start address, sends nothing more', async () => {
    (await launch()).unmount();
    const sessionId = await expectOneStart();
    await launch(launchAddress());
    expect(await expectOneStart()).toBe(sessionId);
    expect(posts()).toBe(1);
    assertNoConversationRequestUnserved();
  });

  it('a RELOAD at the address the host rewrote (planSession=<id>) resumes and sends nothing', async () => {
    await launch();
    const sessionId = await expectOneStart();
    const rewritten = `${window.location.pathname}${window.location.search}`;
    expect(new URL(rewritten, BASE).searchParams.get(OVERLAY_PARAM_NAMES.session)).toBe(sessionId);

    reloadPage();
    await launch(rewritten);
    expect(await expectOneStart()).toBe(sessionId);
    expect(posts()).toBe(1);
    expect(served).toContain(`GET /api/work-items/${stub.id}/ai/plan 200`);
    assertNoConversationRequestUnserved();
  });

  it('a RELOAD at the ORIGINAL start address (before the rewrite) still sends nothing', async () => {
    await launch();
    const sessionId = await expectOneStart();

    // A fresh page: no page claim, no rail ref — only the server's answer that
    // the stub's resumable conversation already holds a user turn.
    reloadPage();
    await launch(launchAddress());
    expect(await expectOneStart()).toBe(sessionId);
    expect(posts()).toBe(1);
    assertNoConversationRequestUnserved();
  });

  it('a StrictMode double effect sends once', async () => {
    await launch(launchAddress(), <StrictMode>{overlay()}</StrictMode>);
    await expectOneStart();
    expect(posts()).toBe(1);
  });

  it('TWO launches back to back on one page — a double press — send once', async () => {
    openAt(launchAddress());
    const first = renderWithIntl(overlay(), { now: NOW });
    const second = renderWithIntl(overlay(), { now: NOW });
    await settle();
    await expectOneStart();
    expect(posts()).toBe(1);
    first.unmount();
    second.unmount();

    // …and a third press after both closed adds nothing either.
    await launch(launchAddress());
    await expectOneStart();
    expect(posts()).toBe(1);
  });

  it('a stub that already has an OPEN conversation with a user turn is RESUMED: no turn is added', async () => {
    // The conversation the person already had on this stub — written through the
    // real send route, so it is the product's row, not a fixture's.
    const earlier = await planRoute(
      new Request(`${BASE}/api/work-items/${stub.id}/ai/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Split billing into invoices and refunds' }),
      }),
      { params: Promise.resolve({ id: stub.id }) },
    );
    expect(earlier.status).toBe(200);
    const before = await rows();
    expect(before.sessions).toHaveLength(1);
    expect(before.userTurns).toEqual(['Split billing into invoices and refunds']);
    submitJobMock.mockClear();

    await launch();

    const after = await rows();
    expect(after.allSessions).toBe(1);
    expect(after.allTurns, 'no turn of any role was added').toBe(before.allTurns);
    expect(after.sessions[0]!.id).toBe(before.sessions[0]!.id);
    expect(after.userTurns).toEqual(['Split billing into invoices and refunds']);
    expect(after.userTurns).not.toContain(startTurn());
    expect(posts(), 'the launch sent nothing').toBe(0);
    expect(submitJobMock).not.toHaveBeenCalled();
    // …and the address names the resumed conversation, so a reload lands on it.
    expect(shallowReplace).toHaveBeenCalledTimes(1);
    expect(
      new URL(shallowReplace.mock.calls[0]![0] as string, BASE).searchParams.get(
        OVERLAY_PARAM_NAMES.session,
      ),
    ).toBe(before.sessions[0]!.id);
    assertNoConversationRequestUnserved();
  });

  it('a RESUMED conversation holding a proposed plan comes back REVIEWABLE — the address rewrite does not cut its read', async () => {
    // The stub's conversation already ran, and its plan proposed a child.
    const earlier = await planRoute(
      new Request(`${BASE}/api/work-items/${stub.id}/ai/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: startTurn() }),
      }),
      { params: Promise.resolve({ id: stub.id }) },
    );
    expect(earlier.status).toBe(200);
    const { planId } = (await earlier.json()) as { planId: string };
    const ctx = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Export as CSV', kind: 'subtask' },
          parentRef: stub.id,
        },
      ],
      ctx,
    );
    await plansService.markPlanned(planId, ctx);
    served.length = 0;

    const view = await launch();

    // The plan was READ to its end — never cut off by the planStart → planSession
    // replace — and the overlay holds it for a decision.
    expect(served).toContain(`GET /api/plans/${planId} 200`);
    expect(shallowReplace).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('plan-change-confirm-bar')).toBeTruthy();
    expect(posts(), 'the launch sent nothing').toBe(0);
    assertNoConversationRequestUnserved();
  });
});
