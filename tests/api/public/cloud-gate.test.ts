import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_SURFACE_ABSENT_CODE } from '@/lib/publicProjects/cloudGate';

// MOTIR-4034 — the PUBLIC SURFACE IS A CLOUD CAPABILITY, asserted by CALLING
// every handler in BOTH builds.
//
// `anonymous-posture.test.ts` one file over asks *who may call these routes*.
// This asks *does this build serve them at all*, which is a different question
// with a different answer per build, and the arm that has never existed is the
// self-hosted one — so it is the arm this file drives first.
//
// ⚠️ BOTH ARMS, because either alone passes for the wrong reason. Off-cloud
// only would go green on a route that 404s because its service threw; on-cloud
// only would go green on a gate that never fires. The pair is what makes each
// assertion mean something: the SAME handler, the SAME arguments, and the only
// difference is `MOTIR_CLOUD`.
//
// ⚠️ THE TABLE IS COMPARED AGAINST THE FILESYSTEM, never trusted — the idiom
// `anonymous-posture.test.ts` and `proxy-matcher.test.ts` both use. A route
// added later fails the derivation test below until somebody gives it a case.
// The SOURCE-level totality guard (a handler that skips the gate entirely) is
// `cloud-gate-totality.test.ts` (MOTIR-4036); this file is about behaviour.

const getSession = vi.hoisted(() => vi.fn(async () => null));
const requireCompliantSession = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, session: { user: { id: 'user_1' } } })),
);

vi.mock('@/lib/auth', () => ({ getSession }));
// ⚠️ STUBBED HERE, and deliberately NOT stubbed in `anonymous-posture.test.ts`.
// There it is one of the two gates under test. Here the subject is the
// CAPABILITY gate that runs ahead of it, and the real one reaches Postgres for
// the caller's 2FA requirement — so left real it would fail the CLOUD arm of the
// two write routes for a reason that has nothing to do with this file, and pass
// the SELF-HOSTED arm for a reason that does (the gate returned first). The
// off-cloud arm asserts it is never CALLED, which is the property that matters.
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));
// Every service is stubbed: this suite is about the GATE, which runs before the
// service, so what the service would have said is noise. On the CLOUD arm the
// stubs are what let each handler reach a non-404 answer at all.
vi.mock('@/lib/services/publicAddressesService', () => ({
  // MOTIR-4217 — these guards test POSTURE (does the gate run, is a session
  // read), not whether a fixture host exists. Unmocked, the route would answer
  // its honest 404 for an unknown host and the guard would read that as a
  // refusal — measuring the fixture instead of the property.
  publicAddressesService: {
    resolveHost: vi.fn(async () => ({
      kind: 'no_application' as const,
      workspace: { name: 'Acme' },
    })),
  },
  PublicHostNotFoundError: class PublicHostNotFoundError extends Error {
    readonly code = 'NOT_FOUND' as const;
  },
}));

vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: {
    getOverview: vi.fn(async () => ({})),
    getProjectTreeLevel: vi.fn(async () => ({ rows: [], hasMore: false, total: 0 })),
    getWorkItems: vi.fn(async () => ({ items: [], nextCursor: null })),
    getBoard: vi.fn(async () => ({ boardId: '', name: '', columns: [], cap: 0, truncated: false })),
    getWorkItemDetail: vi.fn(async () => ({})),
    getRequestDetail: vi.fn(async () => ({})),
    getChangelogFeed: vi.fn(async () => ({
      project: { identifier: 'ACME', name: 'Acme' },
      entries: [],
    })),
    listPublicIndex: vi.fn(async () => ({ projects: [], nextCursor: null })),
    getRoadmap: vi.fn(async () => ({ columns: [] })),
    getRoadmapColumn: vi.fn(async () => ({ bucket: 'planned', cards: [], nextCursor: null })),
    getChangelog: vi.fn(async () => ({ entries: [], nextCursor: null })),
    submitPublicRequest: vi.fn(async () => ({})),
    findDuplicateRequests: vi.fn(async () => ({ candidates: [] })),
  },
}));
vi.mock('@/lib/services/publicFollowService', () => ({
  publicFollowService: {
    followAsAccount: vi.fn(async () => ({})),
    unfollowAsAccount: vi.fn(async () => ({})),
    subscribeByEmail: vi.fn(async () => undefined),
  },
}));
vi.mock('@/lib/services/projectSquareService', () => ({
  projectSquareService: { listDirectory: vi.fn(async () => ({ items: [], nextCursor: null })) },
}));
vi.mock('@/lib/services/projectTagsService', () => ({
  projectTagsService: { listCategories: vi.fn(async () => []) },
}));
vi.mock('@/lib/services/ideasPublicService', () => ({
  ideasPublicService: {
    listActive: vi.fn(async () => ({ items: [], categories: [], total: 0 })),
    listTags: vi.fn(async () => []),
    getBySlug: vi.fn(async () => ({})),
  },
}));
vi.mock('@/lib/rateLimit/publicWriteGuard', () => ({
  enforcePublicWriteRateLimit: vi.fn(async () => null),
}));
vi.mock('@/lib/rateLimit/publicFollowGuard', () => ({
  enforcePublicFollowRateLimit: vi.fn(async () => null),
}));

const subject = await import('@/app/api/public/p/[identifier]/route');
const tree = await import('@/app/api/public/p/[identifier]/tree/route');
const items = await import('@/app/api/public/p/[identifier]/items/route');
const board = await import('@/app/api/public/p/[identifier]/board/route');
const itemDetail = await import('@/app/api/public/p/[identifier]/items/[key]/route');
const requestDetail = await import('@/app/api/public/p/[identifier]/requests/[requestKey]/route');
const feed = await import('@/app/api/public/p/[identifier]/changelog.xml/route');
const projectIndex = await import('@/app/api/public/projects/route');
const roadmap = await import('@/app/api/public/p/[identifier]/roadmap/route');
const changelog = await import('@/app/api/public/p/[identifier]/changelog/route');
const subscribe = await import('@/app/api/public/p/[identifier]/subscribe/route');
const follow = await import('@/app/api/public/p/[identifier]/follow/route');
const explore = await import('@/app/api/public/explore/route');
const categories = await import('@/app/api/public/categories/route');
const ideas = await import('@/app/api/public/ideas/route');
const ideaTags = await import('@/app/api/public/ideas/tags/route');
const ideaDetail = await import('@/app/api/public/ideas/[slug]/route');
const hosts = await import('@/app/api/public/hosts/[host]/route');
const requests = await import('@/app/api/public/projects/[projectId]/requests/route');
const duplicates = await import('@/app/api/public/projects/[projectId]/requests/duplicates/route');

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;

interface Case {
  /** The route FILE, so the derived walk can be compared against this table. */
  file: string;
  method: string;
  call: () => Promise<Response>;
}

const identifierCtx = { params: Promise.resolve({ identifier: 'ACME' }) };
const projectCtx = { params: Promise.resolve({ projectId: 'proj_1' }) };
const hostCtx = { params: Promise.resolve({ host: 'acme.motir.example' }) };
const get = (path: string) => new Request(`https://app.motir.co${path}`);
const send = (path: string, method: string, body?: unknown) =>
  new Request(`https://app.motir.co${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const CASES: Case[] = [
  {
    // MOTIR-7676 — the idea store's three anonymous reads (Story MOTIR-7662).
    file: 'ideas/route.ts',
    method: 'GET',
    call: () => (ideas.GET as Handler)(get('/api/public/ideas?category=pets&tag=smb')),
  },
  {
    file: 'ideas/tags/route.ts',
    method: 'GET',
    call: () => (ideaTags.GET as Handler)(get('/api/public/ideas/tags?locale=ja')),
  },
  {
    file: 'ideas/[slug]/route.ts',
    method: 'GET',
    call: () =>
      (ideaDetail.GET as Handler)(get('/api/public/ideas/a-care-team-app-for-families'), {
        params: Promise.resolve({ slug: 'a-care-team-app-for-families' }),
      }),
  },
  {
    file: 'p/[identifier]/route.ts',
    method: 'GET',
    call: () => (subject.GET as Handler)(get('/api/public/p/ACME'), identifierCtx),
  },
  {
    file: 'p/[identifier]/tree/route.ts',
    method: 'GET',
    call: () => (tree.GET as Handler)(get('/api/public/p/ACME/tree'), identifierCtx),
  },
  {
    file: 'p/[identifier]/items/route.ts',
    method: 'GET',
    call: () => (items.GET as Handler)(get('/api/public/p/ACME/items'), identifierCtx),
  },
  {
    file: 'p/[identifier]/board/route.ts',
    method: 'GET',
    call: () => (board.GET as Handler)(get('/api/public/p/ACME/board'), identifierCtx),
  },
  {
    file: 'p/[identifier]/items/[key]/route.ts',
    method: 'GET',
    call: () =>
      (itemDetail.GET as Handler)(get('/api/public/p/ACME/items/ACME-42'), {
        params: Promise.resolve({ identifier: 'ACME', key: 'ACME-42' }),
      }),
  },
  {
    file: 'p/[identifier]/requests/[requestKey]/route.ts',
    method: 'GET',
    call: () =>
      (requestDetail.GET as Handler)(get('/api/public/p/ACME/requests/ACME-7'), {
        params: Promise.resolve({ identifier: 'ACME', requestKey: 'ACME-7' }),
      }),
  },
  {
    file: 'p/[identifier]/changelog.xml/route.ts',
    method: 'GET',
    call: () => (feed.GET as Handler)(get('/api/public/p/ACME/changelog.xml'), identifierCtx),
  },
  {
    file: 'projects/route.ts',
    method: 'GET',
    call: () => (projectIndex.GET as Handler)(get('/api/public/projects')),
  },
  {
    file: 'p/[identifier]/roadmap/route.ts',
    method: 'GET',
    call: () =>
      (roadmap.GET as Handler)(
        get('/api/public/p/ACME/roadmap?bucket=planned&cursor=abc'),
        identifierCtx,
      ),
  },
  {
    file: 'p/[identifier]/changelog/route.ts',
    method: 'GET',
    call: () => (changelog.GET as Handler)(get('/api/public/p/ACME/changelog'), identifierCtx),
  },
  {
    file: 'p/[identifier]/subscribe/route.ts',
    method: 'POST',
    call: () =>
      (subscribe.POST as Handler)(
        send('/api/public/p/ACME/subscribe', 'POST', { email: 'reader@example.test' }),
        identifierCtx,
      ),
  },
  {
    file: 'p/[identifier]/follow/route.ts',
    method: 'POST',
    call: () => (follow.POST as Handler)(send('/api/public/p/ACME/follow', 'POST'), identifierCtx),
  },
  {
    file: 'p/[identifier]/follow/route.ts',
    method: 'DELETE',
    call: () =>
      (follow.DELETE as Handler)(send('/api/public/p/ACME/follow', 'DELETE'), identifierCtx),
  },
  {
    file: 'explore/route.ts',
    method: 'GET',
    call: () => (explore.GET as Handler)(get('/api/public/explore')),
  },
  {
    // MOTIR-4217 — the host resolver. Off-cloud there are no tenant addresses
    // at all (the ADR §11), so the gate runs first here exactly as everywhere
    // else on this surface.
    file: 'hosts/[host]/route.ts',
    method: 'GET',
    call: () => (hosts.GET as Handler)(get('/api/public/hosts/acme.motir.example'), hostCtx),
  },
  {
    file: 'categories/route.ts',
    method: 'GET',
    call: () => (categories.GET as unknown as () => Promise<Response>)(),
  },
  {
    file: 'projects/[projectId]/requests/route.ts',
    method: 'POST',
    call: () =>
      (requests.POST as Handler)(
        send('/api/public/projects/proj_1/requests', 'POST', { kind: 'bug', title: 'x' }),
        projectCtx,
      ),
  },
  {
    file: 'projects/[projectId]/requests/duplicates/route.ts',
    method: 'GET',
    call: () =>
      (duplicates.GET as Handler)(
        get('/api/public/projects/proj_1/requests/duplicates?title=x'),
        projectCtx,
      ),
  },
];

/** Every `route.ts` under `app/api/public`, relative to that directory. */
function routeFilesOnDisk(dir = join(process.cwd(), 'app', 'api', 'public'), out: string[] = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFilesOnDisk(full, out);
    else if (entry === 'route.ts')
      out.push(
        relative(join(process.cwd(), 'app', 'api', 'public'), full)
          .split(sep)
          .join('/'),
      );
  }
  return out;
}

let previousFlag: string | undefined;
beforeEach(() => {
  previousFlag = process.env['MOTIR_CLOUD'];
  // A signed-in caller throughout, so the four session-required routes reach
  // their own logic on the cloud arm and the gate is the only variable.
  getSession.mockResolvedValue({ user: { id: 'user_1' } } as never);
});
afterEach(() => {
  if (previousFlag === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousFlag;
});

describe('the table is DERIVED, not remembered', () => {
  it('covers every route file on disk, and names no file that is not there', () => {
    const onDisk = [...new Set(routeFilesOnDisk())].sort();
    const inTable = [...new Set(CASES.map((c) => c.file))].sort();
    expect(inTable, 'a public route has no cloud-gate case — add one, do not skip it').toEqual(
      onDisk,
    );
  });

  it('finds routes at all — the vacuous-pass floor', () => {
    expect(routeFilesOnDisk().length).toBeGreaterThanOrEqual(8);
    expect(CASES.length).toBeGreaterThanOrEqual(12);
  });
});

describe('SELF-HOSTED (MOTIR_CLOUD unset) — the capability is ABSENT', () => {
  beforeEach(() => {
    delete process.env['MOTIR_CLOUD'];
  });

  for (const testCase of CASES) {
    it(`${testCase.method} ${testCase.file} answers 404 with the surface's refusal shape`, async () => {
      const res = await testCase.call();
      expect(res.status, `${testCase.method} ${testCase.file} answered ${res.status}`).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe(PUBLIC_SURFACE_ABSENT_CODE);
    });
  }

  it('answers IDENTICALLY on every route — one gate, one shape, by construction', async () => {
    const answers = await Promise.all(
      CASES.map(async (c) => {
        const res = await c.call();
        return JSON.stringify({ status: res.status, body: await res.json() });
      }),
    );
    expect(new Set(answers).size, `distinct answers: ${[...new Set(answers)].join(' | ')}`).toBe(1);
  });

  it('does NOT answer 403, and does not name the capability — a 404 leaks no existence', async () => {
    const res = await (explore.GET as Handler)(get('/api/public/explore'));
    expect(res.status).not.toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/cloud|MOTIR_CLOUD|self.?host/i);
  });

  it('never reaches the rate limiter or the session — an absent capability spends nothing', async () => {
    const { enforcePublicWriteRateLimit } = await import('@/lib/rateLimit/publicWriteGuard');
    const { enforcePublicFollowRateLimit } = await import('@/lib/rateLimit/publicFollowGuard');
    vi.mocked(enforcePublicWriteRateLimit).mockClear();
    vi.mocked(enforcePublicFollowRateLimit).mockClear();
    getSession.mockClear();
    requireCompliantSession.mockClear();

    for (const testCase of CASES) await testCase.call();

    expect(vi.mocked(enforcePublicWriteRateLimit)).not.toHaveBeenCalled();
    expect(vi.mocked(enforcePublicFollowRateLimit)).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(requireCompliantSession).not.toHaveBeenCalled();
  });
});

describe('CLOUD (MOTIR_CLOUD=true) — every route behaves as it does today', () => {
  beforeEach(() => {
    process.env['MOTIR_CLOUD'] = 'true';
  });

  for (const testCase of CASES) {
    it(`${testCase.method} ${testCase.file} is served`, async () => {
      const res = await testCase.call();
      // Not "is 200": `subscribe` answers 202 and `requests` 201. What must not
      // happen is the gate's refusal — which is the whole difference between
      // the two arms, and would be invisible from the off-cloud arm alone.
      expect(res.status, `${testCase.method} ${testCase.file} answered ${res.status}`).toBeLessThan(
        400,
      );
    });
  }
});
