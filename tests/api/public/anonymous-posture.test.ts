import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runAsCloudBuild } from '../../helpers/cloudBuild';

// This suite asserts what the public surface SERVES, which is a CLOUD build
// (MOTIR-4034): off-cloud every `app/api/public/*` route is an absent capability.
runAsCloudBuild();

// THE ANONYMOUS POSTURE, PER ROUTE — asserted by CALLING each one with no
// session (MOTIR-3885).
//
// `contract-coverage.test.ts` reads the gate out of each route's SOURCE and
// compares it to the declaration; that is a check on the document. This is the
// check on the SERVER: every read that is supposed to answer a logged-out
// visitor is driven with no session at all and must not refuse, and the four
// that ARE gated must refuse with 401. A comment saying "NOT session-gated" and
// a route that behaves that way are different claims, and only one of them
// survives a refactor.
//
// ⚠️ THE ROUTE SET IS DERIVED FROM THE FILESYSTEM. The table below is static —
// it has to be, because a dynamic `import()` of a computed path defeats the
// bundler — but a walk of `app/api/public` is compared against it, so a route
// added later fails this suite until somebody states its posture. That is the
// idiom `proxy-matcher.test.ts` uses one surface over: the enumeration is
// checked, never trusted.
//
// ⚠️ WHY THE FOUR GATED ONES ARE ASSERTED AS EXCEPTIONS RATHER THAN SKIPPED. A
// skipped case records nothing. `follow` (POST/DELETE) refuses because a follow
// is a relationship between an ACCOUNT and a project; `requests` (POST) and its
// `duplicates` pre-check refuse because writing to a public project is
// sign-in-to-act. Each of those is a decision, and a decision that stops holding
// should turn this red.

const getSession = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@/lib/auth', () => ({ getSession }));
// Every service is stubbed to a trivial value: this suite is about the GATE,
// which runs before the service, so what the service would have said is noise.
// `requireCompliantSession` is deliberately NOT stubbed — it is one of the two
// gates under test, and it reads the same mocked `getSession`.
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
  /** True when a caller with NO session must be refused. */
  gated: boolean;
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
    gated: false,
    call: () => (ideas.GET as Handler)(get('/api/public/ideas?category=pets&tag=smb')),
  },
  {
    file: 'ideas/tags/route.ts',
    method: 'GET',
    gated: false,
    call: () => (ideaTags.GET as Handler)(get('/api/public/ideas/tags?locale=ja')),
  },
  {
    file: 'ideas/[slug]/route.ts',
    method: 'GET',
    gated: false,
    call: () =>
      (ideaDetail.GET as Handler)(get('/api/public/ideas/a-care-team-app-for-families'), {
        params: Promise.resolve({ slug: 'a-care-team-app-for-families' }),
      }),
  },
  {
    file: 'p/[identifier]/route.ts',
    method: 'GET',
    gated: false,
    call: () => (subject.GET as Handler)(get('/api/public/p/ACME'), identifierCtx),
  },
  {
    file: 'p/[identifier]/tree/route.ts',
    method: 'GET',
    gated: false,
    call: () => (tree.GET as Handler)(get('/api/public/p/ACME/tree'), identifierCtx),
  },
  {
    file: 'p/[identifier]/board/route.ts',
    method: 'GET',
    gated: false,
    call: () => (board.GET as Handler)(get('/api/public/p/ACME/board'), identifierCtx),
  },
  {
    file: 'p/[identifier]/items/[key]/route.ts',
    method: 'GET',
    gated: false,
    call: () =>
      (itemDetail.GET as Handler)(get('/api/public/p/ACME/items/ACME-42'), {
        params: Promise.resolve({ identifier: 'ACME', key: 'ACME-42' }),
      }),
  },
  {
    file: 'p/[identifier]/requests/[requestKey]/route.ts',
    method: 'GET',
    gated: false,
    call: () =>
      (requestDetail.GET as Handler)(get('/api/public/p/ACME/requests/ACME-7'), {
        params: Promise.resolve({ identifier: 'ACME', requestKey: 'ACME-7' }),
      }),
  },
  {
    file: 'p/[identifier]/changelog.xml/route.ts',
    method: 'GET',
    gated: false,
    call: () => (feed.GET as Handler)(get('/api/public/p/ACME/changelog.xml'), identifierCtx),
  },
  {
    file: 'projects/route.ts',
    method: 'GET',
    gated: false,
    call: () => (projectIndex.GET as Handler)(get('/api/public/projects')),
  },
  {
    file: 'p/[identifier]/items/route.ts',
    method: 'GET',
    gated: false,
    call: () => (items.GET as Handler)(get('/api/public/p/ACME/items'), identifierCtx),
  },
  {
    file: 'p/[identifier]/roadmap/route.ts',
    method: 'GET',
    gated: false,
    call: () =>
      (roadmap.GET as Handler)(
        get('/api/public/p/ACME/roadmap?bucket=planned&cursor=abc'),
        identifierCtx,
      ),
  },
  {
    file: 'p/[identifier]/changelog/route.ts',
    method: 'GET',
    gated: false,
    call: () => (changelog.GET as Handler)(get('/api/public/p/ACME/changelog'), identifierCtx),
  },
  {
    file: 'p/[identifier]/subscribe/route.ts',
    method: 'POST',
    gated: false,
    call: () =>
      (subscribe.POST as Handler)(
        send('/api/public/p/ACME/subscribe', 'POST', { email: 'reader@example.test' }),
        identifierCtx,
      ),
  },
  {
    file: 'explore/route.ts',
    method: 'GET',
    gated: false,
    call: () => (explore.GET as Handler)(get('/api/public/explore')),
  },
  {
    // MOTIR-4217 — the host resolver. Anonymous like every other READ here, and
    // MORE so: it is called by another SERVER before a page exists, so there is
    // no user for a session to belong to. The guard's own source check proves
    // the file contains no `getSession` call.
    file: 'hosts/[host]/route.ts',
    method: 'GET',
    gated: false,
    call: () => (hosts.GET as Handler)(get('/api/public/hosts/acme.motir.example'), hostCtx),
  },
  {
    file: 'categories/route.ts',
    method: 'GET',
    gated: false,
    call: () => (categories.GET as unknown as () => Promise<Response>)(),
  },
  {
    file: 'p/[identifier]/follow/route.ts',
    method: 'POST',
    gated: true,
    call: () => (follow.POST as Handler)(send('/api/public/p/ACME/follow', 'POST'), identifierCtx),
  },
  {
    file: 'p/[identifier]/follow/route.ts',
    method: 'DELETE',
    gated: true,
    call: () =>
      (follow.DELETE as Handler)(send('/api/public/p/ACME/follow', 'DELETE'), identifierCtx),
  },
  {
    file: 'projects/[projectId]/requests/route.ts',
    method: 'POST',
    gated: true,
    call: () =>
      (requests.POST as Handler)(
        send('/api/public/projects/proj_1/requests', 'POST', { kind: 'bug', title: 'x' }),
        projectCtx,
      ),
  },
  {
    file: 'projects/[projectId]/requests/duplicates/route.ts',
    method: 'GET',
    gated: true,
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

describe('the table is DERIVED, not remembered', () => {
  it('covers every route file on disk, and names no file that is not there', () => {
    const onDisk = [...new Set(routeFilesOnDisk())].sort();
    const inTable = [...new Set(CASES.map((c) => c.file))].sort();
    expect(inTable, 'a public route has no posture case — add one, do not skip it').toEqual(onDisk);
  });
});

describe('every ANONYMOUS route answers a caller with no session', () => {
  for (const testCase of CASES.filter((c) => !c.gated)) {
    it(`${testCase.method} ${testCase.file} does not refuse`, async () => {
      getSession.mockResolvedValue(null as never);
      const res = await testCase.call();
      // Not "is 200": `subscribe` answers 202. What must never happen is a
      // refusal — the whole point of the surface is that a logged-out visitor,
      // and a crawler, are served.
      expect(res.status, `${testCase.method} ${testCase.file} answered ${res.status}`).toBeLessThan(
        400,
      );
    });
  }
});

describe('the four GATED routes refuse, and are exceptions rather than omissions', () => {
  for (const testCase of CASES.filter((c) => c.gated)) {
    it(`${testCase.method} ${testCase.file} answers 401 with UNAUTHENTICATED`, async () => {
      getSession.mockResolvedValue(null as never);
      const res = await testCase.call();
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    });
  }

  it('counts exactly four of them — a fifth is a decision, not a detail', () => {
    // The GATED number is the one that must not move by accident, and it has
    // not: four, unchanged. The ANONYMOUS number moves whenever a read is added,
    // which is ordinary growth — MOTIR-4109's board took it from 8 to 9, MOTIR-4110's two detail reads to 11, MOTIR-4111's feed and project index to 13. Both
    // are pinned so that either movement is a sentence somebody wrote.
    expect(CASES.filter((c) => c.gated)).toHaveLength(4);
    // 13 → 14: MOTIR-4217's `GET /api/public/hosts/{host}`. It joins the
    // ANONYMOUS half, and more firmly than its neighbours — the others read a
    // session to personalise, this one reads none at all, because it is called
    // by another server before a page exists.
    // 14 → 17: MOTIR-7676's three idea-store reads (`/api/public/ideas`, its
    // `tags` facet and one idea by slug), anonymous like the directory they sit
    // beside and reading no session at all.
    expect(CASES.filter((c) => !c.gated)).toHaveLength(17);
  });
});
