import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { decodePageCursor } from '@/lib/api/v1/pagination';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { isGrantable } from '@/lib/tokens/grant';
import { LEGACY_SCOPE_PERMISSIONS } from '@/lib/mcp/scopes';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  auditV1RouteSource,
  declaredPermissions,
  loadV1RouteModules,
  readRouteSource,
  v1RouteFiles,
} from '../../helpers/v1RouteAudit';
import { createV1Caller, createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { createTestWorkItem } from '../../fixtures';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import { plansService } from '@/lib/services/plansService';
import { sprintsService } from '@/lib/services/sprintsService';
import { truncateAuthTables } from '../../helpers/db';
import { adminDb } from '../../helpers/adminDb';
import { ALIGNED_WINDOW_MS, waitForWindowBoundary } from '../../helpers/rateLimitWindow';

// The Story 11.1 vitest GATE (Subtask 11.1.5 — MOTIR-1861).
//
// Three jobs, none of which the per-subtask suites can do:
//
//   1. Top up coverage on the seams BETWEEN the three code subtasks.
//   2. Drive one subtask's REAL output through the next's REAL consumer — the
//      compositions their units mock away.
//   3. Assert the ARCHITECTURE contracts a coverage percentage cannot see,
//      written so they keep holding for the endpoints 11.2 / 11.3 add later.

const REPO_ROOT = process.cwd();
const ME = 'http://localhost:3000/api/v1/me';
const WORKSPACES = 'http://localhost:3000/api/v1/workspaces';

const savedEnv = {
  limit: process.env['MOTIR_API_V1_RATE_LIMIT'],
  window: process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'],
};
function budget(limit: number, windowMs = 60_000) {
  process.env['MOTIR_API_V1_RATE_LIMIT'] = String(limit);
  process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = String(windowMs);
}
function restoreEnv() {
  if (savedEnv.limit === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT'];
  else process.env['MOTIR_API_V1_RATE_LIMIT'] = savedEnv.limit;
  if (savedEnv.window === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'];
  else process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = savedEnv.window;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Coverage top-up — the seam branches no single subtask's tests reach
// ─────────────────────────────────────────────────────────────────────────────

describe('gate — coverage top-up', () => {
  it('rejects a validly-signed cursor whose payload is not JSON at all', () => {
    // The `JSON.parse` catch: a payload that passes the HMAC but is not
    // decodable. Only reachable by signing deliberate garbage, which is why no
    // subtask-level test hit it.
    const payload = Buffer.from('{not json', 'utf8').toString('base64url');
    const signature = createHmac('sha256', `${process.env['BETTER_AUTH_SECRET']}:api-v1-cursor`)
      .update(payload)
      .digest('base64url');

    expect(() => decodePageCursor(`${payload}.${signature}`)).toThrowError(/valid page cursor/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Integration seams — REAL components, no mock standing in for a subtask
// ─────────────────────────────────────────────────────────────────────────────

describe('gate — seam: auth × pagination', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });
  afterEach(restoreEnv);

  // ORDERING, not just the status. A limiter or a cursor parser that ran first
  // would be an unauthenticated compute path — work done, and a DB read
  // performed, for a caller we never identified.
  it('401s a paginated request BEFORE any cursor parsing or reading happens', async () => {
    const { GET } = await import('@/app/api/v1/workspaces/route');

    // Malformed cursor AND malformed limit AND no credential. If parsing ran
    // first this would be a 422; the 401 proves auth is the first gate.
    const res = await GET(new Request(`${WORKSPACES}?cursor=garbage&limit=0`));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('does not run the handler at all for an unauthenticated paginated request', async () => {
    let handlerRan = false;
    const route = withV1Route({ permission: 'project:browse' }, async () => {
      handlerRan = true;
      return NextResponse.json({ items: [], nextCursor: null });
    });

    await route(new Request(`${WORKSPACES}?limit=5`));

    expect(handlerRan).toBe(false);
  });
});

describe('gate — seam: auth × limiter (does a refused request spend budget?)', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });
  afterEach(restoreEnv);

  // ⚠️ THE design question this card exists to force an answer to, decided
  // deliberately and asserted in BOTH directions.
  //
  // An UNAUTHENTICATED request must NOT spend budget. The budget belongs to a
  // credential; if an unidentified request could spend one, anyone who learned
  // a token's fingerprint could exhaust its budget without ever holding the
  // secret — a denial-of-service against a specific integration, mounted by
  // someone who cannot authenticate at all.
  it('an UNAUTHENTICATED request spends nothing', async () => {
    budget(2, ALIGNED_WINDOW_MS);
    const caller = await createV1Caller();
    const { GET } = await import('@/app/api/v1/me/route');

    // Fixture setup is done; the assertion below spans several requests and
    // reads their ACCUMULATED count, so start it at the top of a window (see
    // `tests/helpers/rateLimitWindow.ts`).
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);

    for (let i = 0; i < 10; i++) {
      expect((await GET(new Request(ME))).status).toBe(401);
    }

    // The token's budget is untouched: two successes, then the refusal.
    expect((await GET(new Request(ME, { headers: caller.headers }))).status).toBe(200);
    expect((await GET(new Request(ME, { headers: caller.headers }))).status).toBe(200);
    expect((await GET(new Request(ME, { headers: caller.headers }))).status).toBe(429);
  });

  // …but a request from a VALID token that is refused for SCOPE must spend it.
  // Refusing a request is not the same as it being free to serve: a 403 still
  // costs a full token lookup. If 403s were unmetered, the holder of any valid
  // token could hammer an endpoint whose scope it lacks with no ceiling at all.
  it('a VALID token refused for SCOPE (403) DOES spend budget', async () => {
    budget(2, ALIGNED_WINDOW_MS);
    // A real token that will never satisfy a `read` route.
    const caller = await createV1Caller({ scopes: ['integration'] });
    const { GET } = await import('@/app/api/v1/me/route');

    // MOTIR-2224: this trio reads the ACCUMULATED count, so a grid boundary
    // falling between its calls resets the counter and serves the third an
    // ordinary 403 instead of the 429 asserted below. Start at the top of a
    // window (see `tests/helpers/rateLimitWindow.ts`).
    await waitForWindowBoundary(ALIGNED_WINDOW_MS);

    expect((await GET(new Request(ME, { headers: caller.headers }))).status).toBe(403);
    expect((await GET(new Request(ME, { headers: caller.headers }))).status).toBe(403);
    // Budget spent — and 429 OUTRANKS 403: a caller over its budget is told to
    // back off regardless of what it asked for.
    const third = await GET(new Request(ME, { headers: caller.headers }));
    expect(third.status).toBe(429);
  });

  it('carries the rate-limit headers on a 403 too', async () => {
    budget(5);
    const caller = await createV1Caller({ scopes: ['integration'] });
    const { GET } = await import('@/app/api/v1/me/route');

    const res = await GET(new Request(ME, { headers: caller.headers }));

    expect(res.status).toBe(403);
    expect(res.headers.get('x-ratelimit-limit')).toBe('5');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('4');
  });
});

describe('gate — seam: limiter × pagination', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });
  afterEach(restoreEnv);

  // If a client cannot complete an ordinary full scan within its budget, the
  // API is unusable for its most common read — the two features would be
  // individually correct and jointly useless.
  it('a full paged scan of a realistic collection completes without a 429', async () => {
    // The shipped default budget, not a widened one — the assertion is about
    // the REAL configuration.
    delete process.env['MOTIR_API_V1_RATE_LIMIT'];
    delete process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'];

    const caller = await createV1Caller({ workspaceName: 'W0' });
    for (let i = 1; i < 25; i++) {
      await workspacesService.createWorkspace({ name: `W${i}`, ownerUserId: caller.user.id });
    }
    const { GET } = await import('@/app/api/v1/workspaces/route');

    // Page at the SMALLEST sane size, which is the worst case for the budget.
    const seen: string[] = [];
    let cursor: string | null = null;
    let requests = 0;

    do {
      const url = `${WORKSPACES}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await GET(new Request(url, { headers: caller.headers }));
      expect(res.status, 'a full scan must never be rate-limited').toBe(200);
      const page = (await res.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      seen.push(...page.items.map((w) => w.id));
      cursor = page.nextCursor;
      requests += 1;
    } while (cursor && requests < 100);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });
});

describe('gate — seam: error mapping × every layer', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });
  afterEach(restoreEnv);

  it('a 422 raised beneath pagination still carries { code, error } AND the limit headers', async () => {
    budget(9);
    const caller = await createV1Caller();
    const { GET } = await import('@/app/api/v1/workspaces/route');

    const res = await GET(
      new Request(`${WORKSPACES}?cursor=nonsense`, { headers: caller.headers }),
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      code: 'INVALID_CURSOR',
      error: 'The `cursor` parameter is not a valid page cursor.',
    });
    // Headers must not be dropped on an error path.
    expect(res.headers.get('x-ratelimit-limit')).toBe('9');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('8');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('a 500 keeps the limit + request-id headers while leaking nothing', async () => {
    budget(4);
    const caller = await createV1Caller();
    const route = withV1Route({ permission: 'project:browse' }, async () => {
      throw new Error('Invalid `db.workspace.findMany()` invocation at 10.0.0.4:5432');
    });

    const res = await route(new Request(WORKSPACES, { headers: caller.headers }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error.' });
    expect(res.headers.get('x-ratelimit-limit')).toBe('4');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('5432');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Architecture guards — what a coverage percentage cannot see
// ─────────────────────────────────────────────────────────────────────────────

describe('gate — architecture guards over the /api/v1 route tree', () => {
  it('finds the route tree at all (a guard over zero files proves nothing)', () => {
    const files = v1RouteFiles(REPO_ROOT);

    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files).toContain('app/api/v1/me/route.ts');
    expect(files).toContain('app/api/v1/workspaces/route.ts');
    // Story 11.2's work-item resource. Named EXPLICITLY so a deleted route is a
    // failing test rather than a silently smaller sweep.
    expect(files).toContain('app/api/v1/work-items/[key]/route.ts');
  });

  it('EVERY v1 route is clean: no Prisma, no transaction, through the wrapper, scope declared', () => {
    const violations = v1RouteFiles(REPO_ROOT).flatMap((file) =>
      auditV1RouteSource(file, readRouteSource(REPO_ROOT, file)),
    );

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('EVERY declared permission is GRANTABLE, and a GET declares `project:browse`', () => {
    for (const file of v1RouteFiles(REPO_ROOT)) {
      const source = readRouteSource(REPO_ROOT, file);
      const permissions = declaredPermissions(source);

      expect(permissions.length, `${file} declares a permission`).toBeGreaterThan(0);
      for (const permission of permissions) {
        // Grantable, not merely a real catalog key: a route asking for
        // something no token can hold is unreachable over the public API.
        expect(isGrantable(permission), `${file} declares "${permission}"`).toBe(true);
      }
      if (/export const GET\s*=/.test(source)) {
        // The page resource (MOTIR-9493) reads under `page:view`, the finer key
        // `pagesService` asserts beside browse — a page is not every browser's.
        const readKey = /\/pages\//.test(file) ? 'page:view' : 'project:browse';
        expect(permissions, `${file} — a GET is gated on \`${readKey}\``).toContain(readKey);
      }
    }
  });

  // ⚠️ Each guard is proven by DELIBERATELY introducing the violation. A guard
  // that has never been shown to fail is indistinguishable from no guard.
  describe('the guards actually fail when violated', () => {
    it('catches a route that calls Prisma', () => {
      const bad = `
        import { db } from '@/lib/db';
        import { withV1Route } from '@/lib/api/v1/route';
        export const GET = withV1Route({ permission: 'project:browse' }, async () => {
          const rows = await db.workspace.findMany();
          return Response.json(rows);
        });
      `;

      expect(auditV1RouteSource('bad/route.ts', bad).map((v) => v.rule)).toContain(
        'prisma-in-route',
      );
    });

    it('catches a route that opens a transaction', () => {
      const bad = `
        import { withV1Route } from '@/lib/api/v1/route';
        import { prisma } from '@/lib/prisma';
        export const GET = withV1Route({ permission: 'project:browse' }, async () => {
          await prisma.$transaction(async (tx) => tx.workspace.count());
          return Response.json({});
        });
      `;

      expect(auditV1RouteSource('bad/route.ts', bad).map((v) => v.rule)).toContain(
        'transaction-in-route',
      );
    });

    it('catches a route that hand-rolls its export instead of using the wrapper', () => {
      // The dangerous shape: it LOOKS like a normal Next route, and it escapes
      // auth, the scope gate, the error envelope, the request id AND the rate
      // limiter all at once.
      const bad = `
        export async function GET(req: Request) {
          return Response.json({ secrets: 'everything' });
        }
      `;

      expect(auditV1RouteSource('bad/route.ts', bad).map((v) => v.rule)).toContain(
        'bypasses-wrapper',
      );
    });

    it('catches a POST that bypasses the wrapper even when a sibling GET does not', () => {
      const bad = `
        import { withV1Route } from '@/lib/api/v1/route';
        export const GET = withV1Route({ permission: 'project:browse' }, async () => Response.json({}));
        export const POST = async (req: Request) => Response.json({ wrote: true });
      `;

      const rules = auditV1RouteSource('bad/route.ts', bad);
      expect(rules.map((v) => v.rule)).toContain('bypasses-wrapper');
      expect(rules.find((v) => v.rule === 'bypasses-wrapper')?.detail).toContain('POST');
    });

    it('catches a route that declares no permission', () => {
      const bad = `
        import { withV1Route } from '@/lib/api/v1/route';
        export const GET = withV1Route({}, async () => Response.json({}));
      `;

      expect(auditV1RouteSource('bad/route.ts', bad).map((v) => v.rule)).toContain(
        'no-permission-declared',
      );
    });

    it('does NOT fire on prose — a comment explaining the rule is not a violation', () => {
      // A guard that flags its own documentation teaches people to delete the
      // documentation.
      const good = `
        // No \`db.*\` and no $transaction( in a route — the 4-layer contract.
        import { withV1Route } from '@/lib/api/v1/route';
        export const GET = withV1Route({ permission: 'project:browse' }, async () => Response.json({}));
      `;

      expect(auditV1RouteSource('good/route.ts', good)).toEqual([]);
    });
  });
});

describe('gate — cross-tenant isolation across the whole v1 tree', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });
  afterEach(restoreEnv);

  // Enumerated from the tree rather than listed, so an endpoint added later is
  // covered by construction.
  //
  // Story 11.2 brought the first PARAMETERISED routes, which this sweep now
  // fills in: a `[key]` segment gets a work item the caller really owns, so the
  // route reaches its service and the assertion is about ISOLATION rather than
  // about a 404 it would have returned anyway. A route whose params this map
  // cannot fill FAILS LOUDLY — a silently skipped route is a hole in a guard
  // that reads as coverage.
  it('no v1 route returns ANY identifier belonging to another tenant', async () => {
    // The legacy `read` grant, plus `page:view` (MOTIR-9493) — no legacy scope
    // expands to a page key, and the page read must answer 200 to be swept.
    const mine = await createV1ProjectCaller({
      workspaceName: 'Mine',
      permissions: [...LEGACY_SCOPE_PERMISSIONS.read, 'page:view'],
    });
    const theirs = await createV1ProjectCaller({ workspaceName: 'Theirs', identifier: 'OTHR' });

    const myItem = await createTestWorkItem(mine.fixture, { kind: 'task', title: 'Mine' });
    const theirItem = await createTestWorkItem(theirs.fixture, { kind: 'task', title: 'Theirs' });

    // Story 11.3's sprint-scoped routes need a `[sprintId]` the caller owns, and
    // a foreign sprint whose id must never appear in any of their bodies.
    const mySprint = await sprintsService.createSprint(
      mine.fixture.projectId,
      { name: 'Mine' },
      mine.ctx,
    );
    const theirSprint = await sprintsService.createSprint(
      theirs.fixture.projectId,
      { name: 'Theirs' },
      theirs.ctx,
    );

    // Story 11.7's plan reads need a `[planId]` the caller owns, and a foreign
    // plan whose id must never appear either. Created through the service
    // directly — no motir-ai involved, because a Plan row exists independently
    // of the job that fills it.
    // Each plan is ASKED FOR by its caller — a token without `plan:view_any` reads
    // the plans that are its owner's (MOTIR-6330).
    const myPlan = await plansService.createPlan(
      mine.fixture.projectId,
      { createdById: mine.ctx.userId },
      mine.ctx,
    );
    const theirPlan = await plansService.createPlan(
      theirs.fixture.projectId,
      { createdById: theirs.ctx.userId },
      theirs.ctx,
    );

    // MOTIR-5357's run-addressed read needs an `[id]` naming a SCOPED run the
    // caller owns (an unscoped run answers 422), and a foreign run whose id must
    // never appear.
    const scopedRun = (caller: typeof mine, item: typeof myItem) =>
      adminDb.dispatchRun.create({
        data: {
          workspaceId: caller.fixture.workspaceId,
          projectId: caller.fixture.projectId,
          command: 'run_scope',
          status: 'running',
          scopeWorkItemId: item.id,
          // The caller STARTED it — a run it "owns" is one it opened (MOTIR-6331).
          createdById: caller.user.id,
        },
      });
    const myRun = await scopedRun(mine, myItem);
    const theirRun = await scopedRun(theirs, theirItem);

    // MOTIR-5408's folder routes need a `[folderId]` the caller owns, and a
    // foreign folder whose id must never appear.
    const myFolder = await foldersService.createFolder(
      { projectId: mine.fixture.projectId, parentFolderId: null, name: 'Mine' },
      mine.ctx,
    );
    const theirFolder = await foldersService.createFolder(
      { projectId: theirs.fixture.projectId, parentFolderId: null, name: 'Theirs' },
      theirs.ctx,
    );

    // MOTIR-9493's page read needs a `[pageId]` the caller owns, and a foreign
    // page whose id must never appear.
    const myPage = await pagesService.createPage(mine.ctx, {
      projectId: mine.fixture.projectId,
      title: 'Mine',
    });
    const theirPage = await pagesService.createPage(theirs.ctx, {
      projectId: theirs.fixture.projectId,
      title: 'Theirs',
    });

    const foreign = [
      theirs.workspace.id,
      theirs.user.id,
      theirs.user.email,
      theirItem.id,
      theirItem.identifier,
      theirs.fixture.projectId,
      theirSprint.id,
      theirPlan.id,
      theirRun.id,
      theirFolder.id,
      theirPage.id,
    ];

    /** Fill one `[slug]` segment with a value the CALLER legitimately owns. */
    const paramValue = (slug: string): string => {
      if (slug === 'key') return myItem.identifier;
      if (slug === 'projectKey') return mine.projectKey;
      if (slug === 'sprintId') return mySprint.id;
      if (slug === 'planId') return myPlan.id;
      if (slug === 'id') return myRun.id;
      if (slug === 'folderId') return myFolder.id;
      if (slug === 'pageId') return myPage.id;
      throw new Error(
        `the cross-tenant sweep has no value for the dynamic segment [${slug}] — ` +
          'add one rather than letting the route be skipped',
      );
    };

    /**
     * A MANDATORY query parameter, for the routes that have one — the same shape
     * as `paramValue` one level out, for the axis a path segment cannot express.
     *
     * ⚠️ AND AN ABSENT ENTRY IS STILL LOUD. A route that grows a required query
     * and is not named here answers 422 rather than 200, which the assertion
     * below names by pathname — so this map does not reintroduce the silent-skip
     * hole the `paramValue` throw exists to prevent. It only has to be ADDED to.
     */
    const REQUIRED_QUERY: Record<string, string> = {
      // MOTIR-6191 — the gate read is addressed by (work item, gate KIND), and
      // the kind has no default on purpose: guessing one would answer about a
      // decision the caller did not ask about.
      '/api/v1/work-items/[key]/approval-gate': 'kind=decision_approval',
    };

    /**
     * GET routes whose ONLY caller is a hosted run's own token, which refuse the PAT this
     * sweep reads as. They are still swept — the PAT's answer must be the named refusal,
     * carrying nothing foreign — and their owning-tenant read (and the other-card refusal)
     * is driven with a real run token in the suite named beside each.
     */
    const RUN_TOKEN_ONLY: Record<string, { code: string; suite: string }> = {
      // MOTIR-6821 — the hosted REVIEW run's brief; a PAT is `REVIEW_RUN_TOKEN_REQUIRED`.
      '/api/v1/work-items/[key]/review-prompt': {
        code: 'REVIEW_RUN_TOKEN_REQUIRED',
        suite: 'tests/api/v1/agent-review-routes.test.ts',
      },
    };

    const modules = await loadV1RouteModules();
    expect(modules.size, 'the tree really was discovered').toBeGreaterThanOrEqual(3);
    for (const pathname of Object.keys(RUN_TOKEN_ONLY)) {
      expect(modules.get(pathname)?.GET, `${pathname} is a GET route in the tree`).toBeDefined();
    }

    for (const [pathname, mod] of modules) {
      if (!mod.GET) continue;

      const params: Record<string, string> = {};
      const url = pathname.replace(/\[(\w+)\]/g, (_match, slug: string) => {
        const value = paramValue(slug);
        params[slug] = value;
        return encodeURIComponent(value);
      });

      const required = REQUIRED_QUERY[pathname];
      const query = `?limit=100${required ? `&${required}` : ''}`;
      const res = await mod.GET(
        new Request(`http://localhost:3000${url}${query}`, { headers: mine.headers }),
        { params: Promise.resolve(params) },
      );
      const runTokenOnly = RUN_TOKEN_ONLY[pathname];
      if (runTokenOnly) {
        expect(res.status, `${pathname} refuses a PAT (see ${runTokenOnly.suite})`).toBe(403);
      } else {
        expect(res.status, `${pathname} answers the owning tenant`).toBe(200);
      }

      const body = (await res.json()) as unknown;
      if (runTokenOnly) {
        expect(body, `${pathname} names its refusal`).toMatchObject({ code: runTokenOnly.code });
      }
      const serialised = JSON.stringify(body);
      for (const id of foreign) {
        expect(serialised, `${pathname} must not leak ${id}`).not.toContain(id);
      }
    }
  });
});
