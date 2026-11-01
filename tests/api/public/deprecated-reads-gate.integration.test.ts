import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { publicRequestVoteRepository } from '@/lib/repositories/publicRequestVoteRepository';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { PUBLIC_CONTRACT_VERSION } from '@/lib/api/public/contractVersion';
import { adminDb } from '../../helpers/adminDb';
import { runAsCloudBuild } from '../../helpers/cloudBuild';
import { truncateAuthTables, truncateRateLimitCounters } from '../../helpers/db';
import { pinSharedRateLimitStoreDeadline } from '../../helpers/rateLimitStore';
import { createTestWorkItem } from '../../fixtures/workItemFixtures';
import { storyGateFixture, type StoryGateFixture } from '../../visitor/_storyGateFixture';
import { consentedVisitor } from '../../visitor/_consentedVisitor';

// THE STORY'S motir-core GATE (MOTIR-6748, Story MOTIR-6171).
//
// The contract card (MOTIR-6746) marked five reads `deprecated` — motir.co no
// longer calls them, because its read pages moved into the app. A deprecation in
// a `1.x` contract is a NOTICE, and `public-surface-hosts.md` AMENDMENT 1 §D is
// the promise that comes with it: nothing on the wire moves. Each card's own
// tests pin its half with mocked services; this file asks the ASSEMBLED question
// against the real datastore — the served document, the five routes over a
// public project with a private epic, and the Visitor's pending-requests read
// with an upvote round trip through the real act route.
//
// Real Postgres throughout; the only stub is the session, as the suite's rule.

runAsCloudBuild();
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const session = vi.hoisted(() => ({
  current: null as { user: { id: string; email: string; name: string } } | null,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));

const { GET: documentGET } = await import('@/app/api/openapi/public.json/route');
const { GET: boardGET } = await import('@/app/api/public/p/[identifier]/board/route');
const { GET: itemsGET } = await import('@/app/api/public/p/[identifier]/items/route');
const { GET: treeGET } = await import('@/app/api/public/p/[identifier]/tree/route');
const { GET: roadmapGET } = await import('@/app/api/public/p/[identifier]/roadmap/route');
const { GET: itemGET } = await import('@/app/api/public/p/[identifier]/items/[key]/route');
const { GET: pendingGET } = await import('@/app/api/p/[identifier]/requests/route');
const { POST: upvotePOST } = await import('@/app/api/public-requests/[id]/upvote/route');

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  session.current = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetSharedRateLimitStoreForTest();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const req = (path: string) => new Request(`https://app.motir.co${path}`);
const on = (identifier: string) => ({ params: Promise.resolve({ identifier }) });

/* ── 1 · the served document ─────────────────────────────────────────────── */

const DEPRECATED: Record<string, string> = {
  getPublicProjectBoard: 'app.motir.co/p/{identifier}/board',
  listPublicProjectWorkItems: 'app.motir.co/p/{identifier}/items',
  getPublicProjectTreeLevel: 'app.motir.co/p/{identifier}/tree',
  getPublicProjectWorkItem: 'app.motir.co/p/{identifier}/items/',
  getPublicProjectRoadmapColumn: 'app.motir.co/p/{identifier}/roadmap',
};

/** The operation count `1.5.0` served — a deprecation adds no operation and removes none. */
const OPERATIONS_AT_1_5_0 = 18;
// 1.7.0 (MOTIR-7676) added three operations — the idea store's public reads —
// and deprecated none, so the five above are still the only deprecated ones.
// 1.8.0 (MOTIR-8350) declared a 503 on those three and added no operation.
// 2.0.0 (MOTIR-9511) reshaped resolvePublicHost's outcomes and added none.
const OPERATIONS_ADDED_SINCE = 3;

type Operation = Record<string, unknown> & { operationId: string };

async function servedOperations() {
  const res = await documentGET();
  expect(res.status).toBe(200);
  const doc = (await res.json()) as {
    info: { version: string };
    paths: Record<string, Record<string, Operation>>;
  };
  return { doc, operations: Object.values(doc.paths).flatMap((p) => Object.values(p)) };
}

describe('the SERVED contract document — GET /api/openapi/public.json', () => {
  it('marks exactly the five reads deprecated, each naming its in-app replacement', async () => {
    const { operations } = await servedOperations();
    const deprecated = operations.filter((o) => o['deprecated'] === true);

    expect(deprecated.map((o) => o.operationId).sort()).toEqual(Object.keys(DEPRECATED).sort());
    for (const op of deprecated) {
      expect(String(op['description']), op.operationId).toContain(DEPRECATED[op.operationId]);
    }
  });

  it('reads 2.0.0, with the operation count 1.5.0 served plus the three added since', async () => {
    const { doc, operations } = await servedOperations();
    expect(doc.info.version).toBe('2.0.0');
    expect(PUBLIC_CONTRACT_VERSION).toBe('2.0.0');
    expect(operations).toHaveLength(OPERATIONS_AT_1_5_0 + OPERATIONS_ADDED_SINCE);
  });

  it('carries NO `deprecated` on any operation the story left alone', async () => {
    const { operations } = await servedOperations();
    const untouched = operations.filter((o) => !(o.operationId in DEPRECATED));
    expect(untouched).toHaveLength(OPERATIONS_AT_1_5_0 + OPERATIONS_ADDED_SINCE - 5);
    for (const op of untouched) expect(op, op.operationId).not.toHaveProperty('deprecated');
  });
});

/* ── 2 · the deprecated routes still answer as documented ────────────────── */

describe('the five deprecated routes, over the real datastore — nothing on the wire moved', () => {
  let t: StoryGateFixture;
  let publicId: string;
  let privateId: string;
  let secretKey: string;
  let openKey: string;
  let secretEpicId: string;

  // Per test, not once: the file's `beforeEach` truncates the auth tables, and
  // a project built before it would be gone by the time a test asked about it.
  beforeEach(async () => {
    t = await storyGateFixture();
    publicId = t.identifier;
    // The fixture's second project is a real project that was never made public.
    privateId = t.other.projectIdentifier;
    secretKey = t.items.C1.identifier;
    openKey = t.items.V1.identifier;
    secretEpicId = t.items.E.id;
  });

  /** The five reads, each as a function of the project it is asked about. */
  const READS: [string, (id: string) => Promise<Response>][] = [
    ['board', (id) => boardGET(req(`/api/public/p/${id}/board`), on(id))],
    ['items', (id) => itemsGET(req(`/api/public/p/${id}/items`), on(id))],
    ['tree', (id) => treeGET(req(`/api/public/p/${id}/tree`), on(id))],
    ['roadmap', (id) => roadmapGET(req(`/api/public/p/${id}/roadmap`), on(id))],
    [
      'items/{key}',
      (id) =>
        itemGET(req(`/api/public/p/${id}/items/${openKey}`), {
          params: Promise.resolve({ identifier: id, key: openKey }),
        }),
    ],
  ];

  it.each(READS)(
    '%s — 200 for the public project, with no private descendant',
    async (_v, read) => {
      const res = await read(publicId);
      expect(res.status).toBe(200);
      // The private epic's children are WITHHELD — their titles never cross.
      expect(await res.text()).not.toMatch(/Hush/);
    },
  );

  it.each(READS)(
    '%s — 404 for a project that is not public, and one that does not exist',
    async (_v, read) => {
      for (const id of [privateId, 'NOPE404']) {
        const res = await read(id);
        expect(res.status, id).toBe(404);
        expect(await res.json(), id).toEqual({ code: 'PROJECT_NOT_FOUND' });
      }
    },
  );

  it('items/{key} — a private epic’s descendant is not found, by the item half', async () => {
    const res = await itemGET(req(`/api/public/p/${publicId}/items/${secretKey}`), {
      params: Promise.resolve({ identifier: publicId, key: secretKey }),
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toMatch(/Hush/);
  });

  it('tree — expanding the private epic yields none of its children', async () => {
    const res = await treeGET(
      req(`/api/public/p/${publicId}/tree?parentId=${secretEpicId}`),
      on(publicId),
    );
    // Withheld either way the service answers it — never a child's title.
    expect([200, 404]).toContain(res.status);
    expect(await res.text()).not.toMatch(/Hush/);
  });

  it('roadmap — each declared 400 still answers as declared', async () => {
    const cases: [string, string][] = [
      ['?bucket=someday&cursor=abc', 'INVALID_ROADMAP_BUCKET'],
      ['?bucket=planned', 'MISSING_ROADMAP_CURSOR'],
      ['?cursor=abc', 'INVALID_ROADMAP_BUCKET'],
    ];
    for (const [query, code] of cases) {
      const res = await roadmapGET(req(`/api/public/p/${publicId}/roadmap${query}`), on(publicId));
      expect(res.status, query).toBe(400);
      expect(await res.json(), query).toEqual({ code });
    }
    const malformed = await roadmapGET(
      req(`/api/public/p/${publicId}/roadmap?bucket=planned&cursor=not-a-cursor`),
      on(publicId),
    );
    expect(malformed.status).toBe(400);
  });
});

/* ── 3 · the Visitor's pending requests, with a vote round trip ──────────── */

describe('the Visitor’s pending requests — the read, the act route and the read again', () => {
  it('shows only active attributed rows by votes; an upvote shows voted and +1, a second removes both; no email anywhere', async () => {
    const t = await storyGateFixture();
    const identifier = t.identifier;
    const submitter = await adminDb.user.create({
      data: {
        email: `submitter.${Date.now()}@acme-corp.test`,
        name: 'Sam Submitter',
        emailVerified: true,
      },
    });

    const ask = async (title: string, patch: Record<string, unknown>) => {
      const item = await createTestWorkItem(t.fx, { kind: 'task', title });
      await adminDb.workItem.update({
        where: { id: item.id },
        data: { triagedAt: new Date(), submittedByUserId: submitter.id, status: 'todo', ...patch },
      });
      return item;
    };
    const popular = await ask('Popular ask', {});
    const quiet = await ask('Quiet ask', {});
    await ask('Snoozed ask', { snoozedUntil: new Date(Date.now() + 86_400_000) });
    await ask('Declined ask', { status: 'done' });
    await ask('Promoted ask', { triagedAt: null });
    await ask('Anonymous ask', { submittedByUserId: null });
    for (const voter of [t.people.m2, t.people.r1]) {
      await adminDb.publicRequestVote.create({
        data: { workItemId: popular.id, userId: voter.id },
      });
    }

    const reader = await consentedVisitor(identifier);
    session.current = {
      user: { id: reader.actorUserId, email: 'reader@example.com', name: 'Reader' },
    };

    const read = async () => {
      const res = await pendingGET(req(`/api/p/${identifier}/requests`), on(identifier));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text, 'an email in the pending read').not.toMatch(/@/);
      return JSON.parse(text) as {
        items: { id: string; title: string; voteCount: number; voted: boolean }[];
      };
    };
    const row = (page: Awaited<ReturnType<typeof read>>, id: string) =>
      page.items.find((i) => i.id === id)!;

    const before = await read();
    expect(before.items.map((i) => i.title)).toEqual(['Popular ask', 'Quiet ask']);
    expect(row(before, quiet.id)).toMatchObject({ voteCount: 0, voted: false });

    const press = async () => {
      const res = await upvotePOST(
        new Request(`https://app.motir.co/api/public-requests/${quiet.id}/upvote`, {
          method: 'POST',
        }),
        { params: Promise.resolve({ id: quiet.id }) },
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toMatch(/@/);
      return JSON.parse(body) as { voted: boolean; voteCount: number };
    };

    expect(await press()).toEqual({ voted: true, voteCount: 1 });
    expect(
      await adminDb.publicRequestVote.count({
        where: { workItemId: quiet.id, userId: reader.actorUserId },
      }),
    ).toBe(1);
    expect(row(await read(), quiet.id)).toMatchObject({ voteCount: 1, voted: true });

    expect(await press()).toEqual({ voted: false, voteCount: 0 });
    expect(
      await adminDb.publicRequestVote.count({
        where: { workItemId: quiet.id, userId: reader.actorUserId },
      }),
    ).toBe(0);
    expect(row(await read(), quiet.id)).toMatchObject({ voteCount: 0, voted: false });
  });
});

/* ── 4 · the arms the happy paths above do not reach ─────────────────────── */

describe('the arms no happy path reaches', () => {
  async function aVoteableRequest() {
    const t = await storyGateFixture();
    const submitter = await adminDb.user.create({
      data: {
        email: `arm.${Date.now()}@acme-corp.test`,
        name: 'Arm Submitter',
        emailVerified: true,
      },
    });
    const item = await createTestWorkItem(t.fx, { kind: 'task', title: 'Arm ask' });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { triagedAt: new Date(), submittedByUserId: submitter.id, status: 'todo' },
    });
    const reader = await consentedVisitor(t.identifier);
    return { t, item, reader };
  }

  it('the pending-requests door lets an UNEXPECTED error throw, never a 200 or a 400', async () => {
    const { t, reader } = await aVoteableRequest();
    session.current = { user: { id: reader.actorUserId, email: 'r@example.com', name: 'R' } };
    vi.spyOn(publicRequestsService, 'listPendingForVisitorContext').mockRejectedValueOnce(
      new Error('the datastore went away'),
    );
    await expect(
      pendingGET(req(`/api/p/${t.identifier}/requests`), on(t.identifier)),
    ).rejects.toThrow('the datastore went away');
  });

  it('an upvote that loses a unique-insert race still reads as VOTED; any other failure throws', async () => {
    const { item, reader } = await aVoteableRequest();
    const ctx = { userId: reader.actorUserId };

    vi.spyOn(publicRequestVoteRepository, 'create').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    expect((await publicRequestsService.toggleUpvote(item.id, ctx)).voted).toBe(true);

    vi.spyOn(publicRequestVoteRepository, 'create').mockRejectedValueOnce(new Error('disk full'));
    await expect(publicRequestsService.toggleUpvote(item.id, ctx)).rejects.toThrow('disk full');
  });
});
