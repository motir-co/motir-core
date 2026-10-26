import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { createPage, pageStoreFor, systemClock } from '@/lib/pages';
import { pageEmbeddingRepository } from '@/lib/repositories/pageEmbeddingRepository';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `page_embedding` RLS — the direct-DB tenancy proof (Story MOTIR-9490 ·
// MOTIR-9570), the page companion to `workItemEmbeddingRls.test.ts`.
//
// ⚠️ The dev/CI database connects as the `prodect` superuser, which has
// BYPASSRLS, so every assertion runs inside a transaction that `SET LOCAL ROLE
// motir_app` — without it each would assert the opposite of reality. The helper
// is a local copy on purpose: the RLS suites each carry their own.

const MODEL = 'text-embedding-3-small';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function asAppRole<T>(
  ctx: { workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

function vector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === seed % 1536 ? 1 : 0));
}

interface Tenants {
  w1: string;
  w2: string;
  p1: string;
  p2: string;
  page1: string;
  page2: string;
}

async function makeTenant(tag: string, seed: number) {
  const user = await usersService.createUser({
    email: `page-embed-rls-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Tenant ${tag}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Tenant ${tag}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: user.id,
    name: `Tenant ${tag}`,
    identifier: `R${tag.toUpperCase()}`,
  });
  const ctx = { userId: user.id, workspaceId: ws.workspace.id, projectId: project.id };
  const page = await withWorkspaceContext(ctx, (tx) =>
    createPage(pageStoreFor(tx), systemClock, {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorId: ctx.userId,
      title: `Page ${tag}`,
    }),
  );
  // Seeded as the OWNER (fixtures legitimately span tenants — the adminDb rationale).
  await adminDb.$transaction((tx) =>
    pageEmbeddingRepository.upsert(
      {
        pageId: page.id,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        model: MODEL,
        dimensions: 1536,
        contentHash: `hash-${seed}`,
        embeddedAt: new Date(),
        embedding: vector(seed),
      },
      tx,
    ),
  );
  return { workspaceId: ctx.workspaceId, projectId: ctx.projectId, pageId: page.id };
}

async function makeTenants(): Promise<Tenants> {
  const a = await makeTenant('a', 1);
  const b = await makeTenant('b', 2);
  return {
    w1: a.workspaceId,
    w2: b.workspaceId,
    p1: a.projectId,
    p2: b.projectId,
    page1: a.pageId,
    page2: b.pageId,
  };
}

describe('page_embedding RLS — read isolation', () => {
  it('with NO workspace GUC bound, the motir_app role sees ZERO rows', async () => {
    await makeTenants();
    expect(await asAppRole({}, (tx) => tx.pageEmbedding.findMany())).toEqual([]);
  });

  it("with W1 bound, only W1's embeddings are visible — never W2's", async () => {
    const t = await makeTenants();
    const rows = await asAppRole({ workspaceId: t.w1 }, (tx) =>
      tx.pageEmbedding.findMany({ select: { pageId: true } }),
    );
    expect(rows.map((r) => r.pageId)).toEqual([t.page1]);
  });

  it('a cross-tenant lookup BY PRIMARY KEY returns null', async () => {
    const t = await makeTenants();
    expect(
      await asAppRole({ workspaceId: t.w1 }, (tx) =>
        pageEmbeddingRepository.findByPageId(t.page2, tx),
      ),
    ).toBeNull();
  });

  it("the ranking and both counts are blind to the other tenant's project", async () => {
    const t = await makeTenants();
    const [rows, rankable, coverage] = await asAppRole({ workspaceId: t.w1 }, async (tx) => [
      await pageEmbeddingRepository.rankByEmbedding(
        { projectId: t.p2, model: MODEL, queryEmbedding: vector(2), limit: 10 },
        tx,
      ),
      await pageEmbeddingRepository.countRankable(t.p2, MODEL, tx),
      await pageEmbeddingRepository.countEmbeddedByProject(t.p2, MODEL, tx),
    ]);
    expect(rows).toEqual([]);
    expect(rankable).toBe(0);
    expect(coverage.embedded).toBe(0);
  });
});

describe('page_embedding RLS — write isolation', () => {
  it('refuses to write a row into ANOTHER workspace (WITH CHECK)', async () => {
    const t = await makeTenants();
    await expect(
      asAppRole({ workspaceId: t.w1 }, (tx) =>
        pageEmbeddingRepository.upsert(
          {
            pageId: t.page2,
            workspaceId: t.w2,
            projectId: t.p2,
            model: MODEL,
            dimensions: 1536,
            contentHash: 'smuggled',
            embeddedAt: new Date(),
            embedding: vector(3),
          },
          tx,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot overwrite another tenant's embedding by labelling the row with its own workspace", async () => {
    const t = await makeTenants();
    await asAppRole({ workspaceId: t.w1 }, (tx) =>
      pageEmbeddingRepository
        .upsert(
          {
            pageId: t.page2,
            workspaceId: t.w1,
            projectId: t.p1,
            model: MODEL,
            dimensions: 1536,
            contentHash: 'smuggled',
            embeddedAt: new Date(),
            embedding: vector(4),
          },
          tx,
        )
        .catch(() => 0),
    );
    const row = await adminDb.pageEmbedding.findUnique({ where: { pageId: t.page2 } });
    expect(row?.contentHash).toBe('hash-2');
  });

  it("cannot delete another tenant's embedding", async () => {
    const t = await makeTenants();
    expect(
      await asAppRole({ workspaceId: t.w1 }, (tx) =>
        pageEmbeddingRepository.deleteByPageId(t.page2, tx),
      ),
    ).toBe(0);
    expect(await adminDb.pageEmbedding.findUnique({ where: { pageId: t.page2 } })).not.toBeNull();
  });
});
