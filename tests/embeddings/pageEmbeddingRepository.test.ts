import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createPage, pageStoreFor, systemClock } from '@/lib/pages';
import {
  EMBEDDING_DIMENSIONS,
  pageEmbeddingRepository,
} from '@/lib/repositories/pageEmbeddingRepository';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `pageEmbeddingRepository` over real Postgres (Story MOTIR-9490 · MOTIR-9570):
// the upsert is one idempotent statement, the row dies with its page, and the
// ranking and both counts read inside `PAGE_SEARCH_LIVE_IN_PROJECT` — live
// pages of one project, of one model — and nowhere else.

const MODEL = 'text-embedding-3-small';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

async function makeTenant(tag: string): Promise<Tenant> {
  const user = await usersService.createUser({
    email: `page-embed-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Page Embed ${tag}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Page Embed ${tag}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: user.id,
    name: `Page Embed ${tag}`,
    identifier: `PE${tag.toUpperCase()}`,
  });
  return { userId: user.id, workspaceId: ws.workspace.id, projectId: project.id };
}

async function addProject(t: Tenant, identifier: string): Promise<string> {
  const project = await projectsService.createProject({
    workspaceId: t.workspaceId,
    actorUserId: t.userId,
    name: `Second ${identifier}`,
    identifier,
  });
  return project.id;
}

const inTenant = <T>(
  t: Tenant,
  fn: Parameters<typeof withWorkspaceContext<T>>[1],
  projectId = t.projectId,
) => withWorkspaceContext({ userId: t.userId, workspaceId: t.workspaceId, projectId }, fn);

async function newPage(t: Tenant, title: string, projectId = t.projectId): Promise<string> {
  const page = await inTenant(
    t,
    (tx) =>
      createPage(pageStoreFor(tx), systemClock, {
        workspaceId: t.workspaceId,
        projectId,
        actorId: t.userId,
        title,
      }),
    projectId,
  );
  return page.id;
}

/** A unit vector along axis `axis`, nudged toward axis `toward` by `w` — distances are controllable. */
function vector(axis: number, toward = axis, w = 0): number[] {
  const v = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  v[axis] = 1;
  if (toward !== axis) v[toward] = w;
  return v;
}

async function embed(
  t: Tenant,
  pageId: string,
  embedding: number[],
  opts: { model?: string; hash?: string; projectId?: string } = {},
): Promise<void> {
  await inTenant(t, (tx) =>
    pageEmbeddingRepository.upsert(
      {
        pageId,
        workspaceId: t.workspaceId,
        projectId: opts.projectId ?? t.projectId,
        model: opts.model ?? MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        contentHash: opts.hash ?? 'h',
        embeddedAt: new Date(),
        embedding,
      },
      tx,
    ),
  );
}

async function archive(pageId: string): Promise<void> {
  await adminDb.page.update({
    where: { id: pageId },
    data: { archivedAt: new Date(), archiveRootId: pageId },
  });
}

describe('pageEmbeddingRepository.upsert / findByPageId / deleteByPageId', () => {
  it('writes one row, and a second upsert replaces its hash and vector rather than adding one', async () => {
    const t = await makeTenant('upsert');
    const pageId = await newPage(t, 'On-call rota');
    await embed(t, pageId, vector(1), { hash: 'first' });
    await embed(t, pageId, vector(2), { hash: 'second' });

    const row = await inTenant(t, (tx) => pageEmbeddingRepository.findByPageId(pageId, tx));
    expect(row).toMatchObject({ pageId, contentHash: 'second', model: MODEL, dimensions: 1536 });
    expect(await adminDb.pageEmbedding.count()).toBe(1);

    const [ranked] = await inTenant(t, (tx) =>
      pageEmbeddingRepository.rankByEmbedding(
        { projectId: t.projectId, model: MODEL, queryEmbedding: vector(2), limit: 5 },
        tx,
      ),
    );
    // The SECOND vector is the stored one: it is at distance 0 from its own axis.
    expect(ranked?.distance).toBeCloseTo(0, 6);
  });

  it('findByPageId answers null for a page with no row', async () => {
    const t = await makeTenant('none');
    const pageId = await newPage(t, 'Unembedded');
    expect(await inTenant(t, (tx) => pageEmbeddingRepository.findByPageId(pageId, tx))).toBeNull();
  });

  it('deleteByPageId removes the row and answers 1, then 0', async () => {
    const t = await makeTenant('delete');
    const pageId = await newPage(t, 'Doomed');
    await embed(t, pageId, vector(1));
    expect(await inTenant(t, (tx) => pageEmbeddingRepository.deleteByPageId(pageId, tx))).toBe(1);
    expect(await inTenant(t, (tx) => pageEmbeddingRepository.deleteByPageId(pageId, tx))).toBe(0);
    expect(await adminDb.pageEmbedding.count()).toBe(0);
  });

  it('deleting the page cascades its embedding away', async () => {
    const t = await makeTenant('cascade');
    const pageId = await newPage(t, 'Short-lived');
    await embed(t, pageId, vector(1));
    await adminDb.pageVersion.deleteMany({ where: { pageId } });
    await adminDb.page.delete({ where: { id: pageId } });
    expect(await adminDb.pageEmbedding.findUnique({ where: { pageId } })).toBeNull();
  });
});

describe('pageEmbeddingRepository.rankByEmbedding', () => {
  it('returns live pages nearest first, ids breaking a tie', async () => {
    const t = await makeTenant('rank');
    const near = await newPage(t, 'Near');
    const far = await newPage(t, 'Far');
    const tieA = await newPage(t, 'Tie A');
    const tieB = await newPage(t, 'Tie B');
    await embed(t, near, vector(1, 2, 0.1));
    await embed(t, far, vector(3));
    await embed(t, tieA, vector(1, 2, 0.5));
    await embed(t, tieB, vector(1, 2, 0.5));

    const rows = await inTenant(t, (tx) =>
      pageEmbeddingRepository.rankByEmbedding(
        { projectId: t.projectId, model: MODEL, queryEmbedding: vector(1), limit: 10 },
        tx,
      ),
    );
    const ties = [tieA, tieB].sort();
    expect(rows.map((r) => r.pageId)).toEqual([near, ...ties, far]);
    expect(rows[0]!.distance).toBeLessThan(rows[1]!.distance);
    expect(typeof rows[0]!.distance).toBe('number');
  });

  it('never returns an archived page, another project’s page or another model’s row', async () => {
    const t = await makeTenant('filter');
    const otherProject = await addProject(t, 'PEFX');
    const live = await newPage(t, 'Live');
    const archived = await newPage(t, 'Archived');
    const elsewhere = await newPage(t, 'Elsewhere', otherProject);
    const otherModel = await newPage(t, 'Other model');
    await embed(t, live, vector(1));
    await embed(t, archived, vector(1));
    await embed(t, elsewhere, vector(1), { projectId: otherProject });
    await embed(t, otherModel, vector(1), { model: 'another-model' });
    await archive(archived);

    const [rows, rankable] = await inTenant(t, async (tx) => [
      await pageEmbeddingRepository.rankByEmbedding(
        { projectId: t.projectId, model: MODEL, queryEmbedding: vector(1), limit: 10 },
        tx,
      ),
      await pageEmbeddingRepository.countRankable(t.projectId, MODEL, tx),
    ]);
    expect(rows.map((r) => r.pageId)).toEqual([live]);
    // countRankable agrees with the ranking, or the under-return fallback would misfire.
    expect(rankable).toBe(rows.length);
  });

  it('honours the limit', async () => {
    const t = await makeTenant('limit');
    for (let i = 0; i < 4; i += 1) await embed(t, await newPage(t, `P${i}`), vector(i + 1));
    const rows = await inTenant(t, (tx) =>
      pageEmbeddingRepository.rankByEmbedding(
        { projectId: t.projectId, model: MODEL, queryEmbedding: vector(1), limit: 2 },
        tx,
      ),
    );
    expect(rows).toHaveLength(2);
  });

  it('the exact path (ordered index scan off, ef_search widened) answers the same rows', async () => {
    const t = await makeTenant('exact');
    const a = await newPage(t, 'A');
    const b = await newPage(t, 'B');
    await embed(t, a, vector(1));
    await embed(t, b, vector(2));
    const rows = await inTenant(t, async (tx) => {
      await pageEmbeddingRepository.setEfSearchForLimit(25, tx);
      await pageEmbeddingRepository.disableOrderedIndexScan(tx);
      const [ef] = await tx.$queryRaw<
        Array<{ ef: string }>
      >`SELECT current_setting('hnsw.ef_search') AS ef`;
      expect(ef?.ef).toBe('100');
      return pageEmbeddingRepository.rankByEmbedding(
        { projectId: t.projectId, model: MODEL, queryEmbedding: vector(1), limit: 10 },
        tx,
      );
    });
    expect(rows.map((r) => r.pageId)).toEqual([a, b]);
  });
});

describe('pageEmbeddingRepository counts', () => {
  it('countEmbeddedByProject counts live pages with a row of the model, against all live pages', async () => {
    const t = await makeTenant('counts');
    const embedded = await newPage(t, 'Embedded');
    await newPage(t, 'Pending');
    const archived = await newPage(t, 'Archived');
    const otherModel = await newPage(t, 'Other model');
    await embed(t, embedded, vector(1));
    await embed(t, archived, vector(1));
    await embed(t, otherModel, vector(1), { model: 'another-model' });
    await archive(archived);

    const counts = await inTenant(t, (tx) =>
      pageEmbeddingRepository.countEmbeddedByProject(t.projectId, MODEL, tx),
    );
    expect(counts).toEqual({ embedded: 1, total: 3 });
  });

  it('a project with no pages counts zero of zero', async () => {
    const t = await makeTenant('empty');
    expect(
      await inTenant(t, (tx) =>
        pageEmbeddingRepository.countEmbeddedByProject(t.projectId, MODEL, tx),
      ),
    ).toEqual({ embedded: 0, total: 0 });
    expect(
      await inTenant(t, (tx) => pageEmbeddingRepository.countRankable(t.projectId, MODEL, tx)),
    ).toBe(0);
  });
});

describe('the one access predicate', () => {
  it('the ranking and both counts read inside PAGE_SEARCH_LIVE_IN_PROJECT and write no archived check', () => {
    const source = readFileSync(
      resolve(__dirname, '../../lib/repositories/pageEmbeddingRepository.ts'),
      'utf8',
    );
    expect(source).toContain(
      "import { PAGE_SEARCH_LIVE_IN_PROJECT } from '@/lib/repositories/pageRepository'",
    );
    // Interpolated in the shared `rankable` fragment (ranking + countRankable) and the coverage count.
    expect(source.match(/\$\{PAGE_SEARCH_LIVE_IN_PROJECT\(/g)?.length).toBe(2);
    expect(source).not.toMatch(/archived_at"?\s+IS\s+NULL/i);
    expect(source).not.toMatch(/p\."project_id"\s*=/);
  });
});

describe('every write method takes a REQUIRED tx', () => {
  it('no method falls back to the db singleton', () => {
    const source = readFileSync(
      resolve(__dirname, '../../lib/repositories/pageEmbeddingRepository.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from '@\/lib\/db'/);
    expect(source).not.toMatch(/tx\?:/);
  });
});
