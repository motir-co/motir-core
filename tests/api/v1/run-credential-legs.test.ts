import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { dispatchRunOpenedSchema } from '@/lib/api/v1/workLoop/schema';
import { RUN_TOKEN_ROUTES } from '@/lib/hostedRuns/runTokenRoutes';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { bearer, createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// A hosted run's own credential reaches its RUN'S cards — every leg, and the
// scope it was opened for — on every route the CLI's `motir run` calls, and no
// other card (MOTIR-6557, `hosted-run-runs-the-cli-as-the-app.md` §4). Real
// Postgres, the real bearer path.
//
// ⚠️ Each route is driven BOTH ways: a call that is admitted proves nothing
// about the lock unless the same call on a card outside the run is refused. A
// leg's call may still be refused for its own reasons (a 409 on a status move,
// a 404 on an unconnected repository) — what it must never be is the run-scope
// 403, so that is what the admitted arm asserts.

const BASE = 'http://localhost:3000/api/v1';
type Headers = Record<string, string>;
type Handler = (
  req: Request,
  args: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const OUT_OF_SCOPE = 'DISPATCH_RUN_TOKEN_OUT_OF_SCOPE';

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { code?: string }).code;
}

function request(method: string, path: string, headers: Headers, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(
  loader: () => Promise<Record<string, unknown>>,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  params: Record<string, string>,
  headers: Headers,
  body?: unknown,
): Promise<Response> {
  const mod = await loader();
  const handler = mod[method] as Handler;
  return handler(request(method, path, headers, body), { params: Promise.resolve(params) });
}

/** A card-keyed route of the table, with the body its request needs. */
interface CardRoute {
  path: string;
  method: 'GET' | 'POST';
  loader: () => Promise<Record<string, unknown>>;
  suffix: string;
  body?: unknown;
}

const CARD_ROUTES: CardRoute[] = [
  {
    path: '/api/v1/work-items/{key}',
    method: 'GET',
    suffix: '',
    loader: () => import('@/app/api/v1/work-items/[key]/route'),
  },
  {
    path: '/api/v1/work-items/{key}/designs',
    method: 'GET',
    suffix: '/designs',
    loader: () => import('@/app/api/v1/work-items/[key]/designs/route'),
  },
  {
    path: '/api/v1/work-items/{key}/dispatch-prompt',
    method: 'GET',
    suffix: '/dispatch-prompt',
    loader: () => import('@/app/api/v1/work-items/[key]/dispatch-prompt/route'),
  },
  {
    path: '/api/v1/work-items/{key}/how-to-test',
    method: 'GET',
    suffix: '/how-to-test',
    loader: () => import('@/app/api/v1/work-items/[key]/how-to-test/route'),
  },
  {
    path: '/api/v1/work-items/{key}/claim',
    method: 'POST',
    suffix: '/claim',
    loader: () => import('@/app/api/v1/work-items/[key]/claim/route'),
  },
  {
    path: '/api/v1/work-items/{key}/transitions',
    method: 'POST',
    suffix: '/transitions',
    body: { status: 'in_progress' },
    loader: () => import('@/app/api/v1/work-items/[key]/transitions/route'),
  },
  {
    path: '/api/v1/work-items/{key}/integration',
    method: 'POST',
    suffix: '/integration',
    body: { sessionBranch: 'hosted/run-legs' },
    loader: () => import('@/app/api/v1/work-items/[key]/integration/route'),
  },
  {
    path: '/api/v1/work-items/{key}/pull-requests',
    method: 'POST',
    suffix: '/pull-requests',
    body: {
      url: 'https://github.com/acme/api/pull/7',
      headRef: 'hosted/run-legs',
      baseRef: 'main',
    },
    loader: () => import('@/app/api/v1/work-items/[key]/pull-requests/route'),
  },
];

/**
 * The review run's routes (MOTIR-6821, MOTIR-11953) answer ONLY a `command: review` run's token, so
 * the `run_scope` token this file mints is refused there by the review-run check before any
 * leg question arises. Their binding — the run's own card, and a refusal for a card outside
 * it — is proven in `tests/api/v1/agent-review-routes.test.ts` with a review run's token.
 */
const REVIEW_RUN_ONLY = [
  'GET /api/v1/work-items/{key}/review-prompt',
  'POST /api/v1/work-items/{key}/agent-review',
  // An own-agent review's token only (MOTIR-11953), proven in
  // `tests/agentInstances/reviewInMyAgentVerdict.test.ts`.
  'POST /api/v1/work-items/{key}/review-verdict',
];

async function seedItem(
  caller: V1ProjectCaller,
  kind: 'story' | 'task',
  title: string,
  parentId?: string,
): Promise<{ id: string; key: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    caller.fixture.ctx,
  );
  return { id: item.id, key: item.identifier };
}

async function openRun(caller: V1ProjectCaller, body: Record<string, unknown>): Promise<string> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/route');
  const res = await POST(request('POST', '/dispatch-runs', caller.headers, body), {
    params: Promise.resolve({}),
  });
  expect(res.status, 'seeding a run').toBe(201);
  return dispatchRunOpenedSchema.parse(await res.json()).run.id;
}

describe('a hosted run credential reaches its run’s legs and scope, and nothing else (MOTIR-6557)', () => {
  let caller: V1ProjectCaller;
  let parent: { id: string; key: string };
  let legA: { id: string; key: string };
  let legB: { id: string; key: string };
  let outside: { id: string; key: string };
  let otherParent: { id: string; key: string };
  let runId: string;
  let otherRunId: string;
  let run: Headers;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    parent = await seedItem(caller, 'story', 'the story this run drains');
    legA = await seedItem(caller, 'task', 'first child', parent.id);
    legB = await seedItem(caller, 'task', 'second child', parent.id);
    otherParent = await seedItem(caller, 'story', 'another story');
    outside = await seedItem(caller, 'task', 'a card outside the run', otherParent.id);

    runId = await openRun(caller, {
      projectKey: caller.projectKey,
      command: 'run_scope',
      origin: 'hosted',
      scopeKey: parent.key,
      cards: [
        { key: legA.key, disposition: 'queued' },
        { key: legB.key, disposition: 'queued' },
      ],
    });
    otherRunId = await openRun(caller, {
      projectKey: caller.projectKey,
      command: 'run',
      cards: [{ key: outside.key, disposition: 'queued' }],
    });
    const { token } = await runCredentialService.mintRunCredential({
      dispatchRunId: runId,
      dispatcherUserId: caller.fixture.owner.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    run = bearer(token);
  });

  it('every card-keyed route in the table is exercised here', () => {
    const tableCardPaths = RUN_TOKEN_ROUTES.filter(
      (r) => r.binding === 'run_cards' && r.path.includes('{key}'),
    )
      .map((r) => `${r.method} ${r.path}`)
      .filter((p) => !REVIEW_RUN_ONLY.includes(p));
    expect(CARD_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(tableCardPaths.sort());
  });

  describe.each(CARD_ROUTES)('$method $path', (route) => {
    const at = (key: string) =>
      call(
        route.loader,
        route.method,
        `/work-items/${key}${route.suffix}`,
        { key },
        run,
        route.body,
      );

    it('admits a leg of the run (both legs of a two-leg parent run)', async () => {
      for (const leg of [legA, legB]) {
        const res = await at(leg.key);
        expect([401, 403], `${leg.key}: ${res.status} ${await codeOf(res)}`).not.toContain(
          res.status,
        );
      }
    });

    it('refuses a card outside the run with the run-scope 403', async () => {
      const res = await at(outside.key);
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe(OUT_OF_SCOPE);
    });
  });

  it('reads the run’s SCOPE card (the parent it closes out) but no other container', async () => {
    const detail = () => import('@/app/api/v1/work-items/[key]/route');
    const own = await call(detail, 'GET', `/work-items/${parent.key}`, { key: parent.key }, run);
    expect(own.status).toBe(200);
    const other = await call(
      detail,
      'GET',
      `/work-items/${otherParent.key}`,
      { key: otherParent.key },
      run,
    );
    expect(other.status).toBe(403);
    expect(await codeOf(other)).toBe(OUT_OF_SCOPE);
  });

  describe('POST /api/v1/scope-claims', () => {
    const claim = (body: unknown) =>
      call(() => import('@/app/api/v1/scope-claims/route'), 'POST', '/scope-claims', {}, run, body);

    it('claims its own run’s scope', async () => {
      const res = await claim({ kind: 'work_item', key: parent.key });
      expect(res.status, `${await codeOf(res)}`).toBe(200);
    });

    it('refuses another container, and any sprint', async () => {
      const other = await claim({ kind: 'work_item', key: otherParent.key });
      expect(other.status).toBe(403);
      expect(await codeOf(other)).toBe(OUT_OF_SCOPE);
      const sprint = await claim({ kind: 'sprint', projectKey: caller.projectKey });
      expect(sprint.status).toBe(403);
      expect(await codeOf(sprint)).toBe(OUT_OF_SCOPE);
    });
  });

  describe('POST /api/v1/sessions/complete', () => {
    const complete = (headers: Headers, sessionBranch: string) =>
      call(
        () => import('@/app/api/v1/sessions/complete/route'),
        'POST',
        '/sessions/complete',
        {},
        headers,
        {
          sessionBranch,
        },
      );
    // Seed each card's session branch directly: what is under test is which
    // cards a run token may COMPLETE, not how a branch gets recorded.
    const onBranch = (id: string, sessionBranch: string) =>
      withWorkspaceContext(caller.fixture.ctx, (tx) =>
        workItemRepository.update(id, { sessionBranch }, tx),
      );

    it('completes a session of its own legs, and refuses one carrying a card outside the run', async () => {
      await onBranch(legA.id, 'hosted/own');
      await onBranch(outside.id, 'hosted/foreign');

      const own = await complete(run, 'hosted/own');
      expect([401, 403], `${own.status} ${await codeOf(own)}`).not.toContain(own.status);

      const foreign = await complete(run, 'hosted/foreign');
      expect(foreign.status).toBe(403);
      expect(await codeOf(foreign)).toBe(OUT_OF_SCOPE);
    });
  });

  it('reads its OWN run’s close-out prompt and not another run’s', async () => {
    const closeOut = (id: string) =>
      call(
        () => import('@/app/api/v1/dispatch-runs/[id]/close-out-prompt/route'),
        'GET',
        `/dispatch-runs/${id}/close-out-prompt`,
        { id },
        run,
      );
    const own = await closeOut(runId);
    expect([401, 403], `${own.status} ${await codeOf(own)}`).not.toContain(own.status);
    const other = await closeOut(otherRunId);
    expect(other.status).toBe(403);
    expect(await codeOf(other)).toBe(OUT_OF_SCOPE);
  });

  it('reads its own project (the ready set, the work-item list) and who it is', async () => {
    const params = { projectKey: caller.projectKey };
    // The three ready LANES (MOTIR-6832) answer the project-bound token; the flat
    // `GET …/ready` they replaced is gone (MOTIR-6841).
    for (const lane of ['leaves', 'containers', 'bugs'] as const) {
      const res = await call(
        () => import(`@/app/api/v1/projects/[projectKey]/ready/${lane}/route`),
        'GET',
        `/projects/${caller.projectKey}/ready/${lane}`,
        params,
        run,
      );
      expect(res.status, lane).toBe(200);
    }
    const list = await call(
      () => import('@/app/api/v1/projects/[projectKey]/work-items/route'),
      'GET',
      `/projects/${caller.projectKey}/work-items`,
      params,
      run,
    );
    expect(list.status).toBe(200);
    const me = await call(() => import('@/app/api/v1/me/route'), 'GET', '/me', {}, run);
    expect(me.status).toBe(200);
  });

  describe('what stays refused', () => {
    it('POST /api/v1/dispatch-runs — the server opens hosted runs', async () => {
      const res = await call(
        () => import('@/app/api/v1/dispatch-runs/route'),
        'POST',
        '/dispatch-runs',
        {},
        run,
        {
          projectKey: caller.projectKey,
          command: 'run',
          cards: [{ key: legA.key, disposition: 'queued' }],
        },
      );
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('RUN_TOKEN_NOT_ALLOWED');
    });

    it('GET /api/v1/workspaces — the dispatcher’s other workspaces are not the run’s', async () => {
      const res = await call(
        () => import('@/app/api/v1/workspaces/route'),
        'GET',
        '/workspaces',
        {},
        run,
      );
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('RUN_TOKEN_NOT_ALLOWED');
    });

    it('an AI planning route (the expansion) — even on a leg', async () => {
      const res = await call(
        () => import('@/app/api/v1/work-items/[key]/expansions/route'),
        'POST',
        `/work-items/${legA.key}/expansions`,
        { key: legA.key },
        run,
        {},
      );
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('RUN_TOKEN_NOT_ALLOWED');
    });

    it('a write outside the table, even on a leg (PATCH the card)', async () => {
      const res = await call(
        () => import('@/app/api/v1/work-items/[key]/route'),
        'PATCH',
        `/work-items/${legA.key}`,
        { key: legA.key },
        run,
        { title: 'renamed by an agent' },
      );
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('RUN_TOKEN_NOT_ALLOWED');
    });
  });
});
