import type { Prisma } from '@/generated/prisma/client';
import { RLS_DENIAL, isRlsDenial, isSqlState } from '../helpers/sqlstate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The PAGE COMMENT schema — MOTIR-10871 (Story MOTIR-10866, Epic MOTIR-5749).
//
// Proves, on real Postgres, what `20261110175415_page_comment` makes the
// DATABASE do, independent of any service: the cascades from page and from a
// root, the author RESTRICT and resolver SET NULL, the four CHECKs, the
// cotenancy trigger's refusals (SQLSTATE 23514), the two partial indexes, and
// RLS under the non-bypass `motir_app` role. `pageVersionSchema.test.ts` is the
// same shape.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenants {
  userAId: string;
  userBId: string;
  w1: string;
  w2: string;
  p1: string;
  p1b: string;
  p2: string;
}

async function makeTenants(): Promise<Tenants> {
  const userA = await usersService.createUser({
    email: 'pc-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Comment Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'pc-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Comment Tenant B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'PC W1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'PC W2', ownerUserId: userB.id });
  const p1 = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'PC P1',
    identifier: 'PCONE',
  });
  const p1b = await projectsService.createProject({
    workspaceId: w1.workspace.id,
    actorUserId: userA.id,
    name: 'PC P1b',
    identifier: 'PCONEB',
  });
  const p2 = await projectsService.createProject({
    workspaceId: w2.workspace.id,
    actorUserId: userB.id,
    name: 'PC P2',
    identifier: 'PCTWO',
  });
  return {
    userAId: userA.id,
    userBId: userB.id,
    w1: w1.workspace.id,
    w2: w2.workspace.id,
    p1: p1.id,
    p1b: p1b.id,
    p2: p2.id,
  };
}

let counter = 0;
function next(): number {
  counter += 1;
  return counter;
}

const BODY = Uint8Array.from([1, 2, 3, 4]);
const EMPTY_DOC = { type: 'doc', content: [] };

async function makePage(t: { workspaceId: string; projectId: string; userId: string }) {
  const n = next();
  const row = await adminDb.page.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      createdById: t.userId,
      updatedById: t.userId,
      title: `Page ${n}`,
      position: `a${n.toString(36)}`,
      bodyState: BODY,
      bodyJson: EMPTY_DOC,
      bodyMarkdown: `body ${n}`,
    },
  });
  return row;
}

async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; projectId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.projectId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

async function makeComment(args: {
  workspaceId: string;
  projectId: string;
  pageId: string;
  authorId: string;
  parentCommentId?: string | null;
  bodyMd?: string;
  resolvedAt?: Date | null;
  resolvedById?: string | null;
  anchor?: Uint8Array | null;
  anchorQuote?: string | null;
}) {
  return adminDb.pageComment.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      pageId: args.pageId,
      authorId: args.authorId,
      parentCommentId: args.parentCommentId ?? null,
      bodyMd: args.bodyMd ?? `comment ${next()}`,
      resolvedAt: args.resolvedAt ?? null,
      resolvedById: args.resolvedById ?? null,
      anchor: args.anchor ?? null,
      anchorQuote: args.anchorQuote ?? null,
    },
  });
}

/** SQLSTATE 23514, `check_violation` — what the CHECKs and the trigger raise. */
const isCheckViolation = isSqlState('23514');

async function seed() {
  const t = await makeTenants();
  const page = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
  const base = { workspaceId: t.w1, projectId: t.p1, pageId: page.id, authorId: t.userAId };
  return { t, page, base };
}

describe('page_comment — threads and cascades', () => {
  it('stores a root and its replies, and a new comment carries no anchor', async () => {
    const { base } = await seed();
    const root = await makeComment(base);
    const reply = await makeComment({ ...base, parentCommentId: root.id });
    expect(root).toMatchObject({
      parentCommentId: null,
      resolvedAt: null,
      resolvedById: null,
      anchor: null,
      anchorQuote: null,
      editedAt: null,
    });
    expect(reply.parentCommentId).toBe(root.id);
  });

  it('deletes a root’s replies with the root', async () => {
    const { base } = await seed();
    const root = await makeComment(base);
    await makeComment({ ...base, parentCommentId: root.id });
    await makeComment({ ...base, parentCommentId: root.id });
    const other = await makeComment(base);

    await adminDb.pageComment.delete({ where: { id: root.id } });

    const left = await adminDb.pageComment.findMany({ select: { id: true } });
    expect(left.map((r) => r.id)).toEqual([other.id]);
  });

  it('leaves the root when a reply is deleted', async () => {
    const { base } = await seed();
    const root = await makeComment(base);
    const reply = await makeComment({ ...base, parentCommentId: root.id });

    await adminDb.pageComment.delete({ where: { id: reply.id } });

    expect(await adminDb.pageComment.findUnique({ where: { id: root.id } })).not.toBeNull();
  });

  it('deletes a page’s comments with the page', async () => {
    const { page, base } = await seed();
    const root = await makeComment(base);
    await makeComment({ ...base, parentCommentId: root.id });

    await adminDb.page.delete({ where: { id: page.id } });

    expect(await adminDb.pageComment.count({ where: { pageId: page.id } })).toBe(0);
  });

  it('refuses deleting a user who authored a comment', async () => {
    const { t, base } = await seed();
    await makeComment({ ...base, authorId: t.userBId });
    await expect(adminDb.user.delete({ where: { id: t.userBId } })).rejects.toThrow();
    expect(await adminDb.user.count({ where: { id: t.userBId } })).toBe(1);
  });

  it('keeps a thread resolved when its resolver is deleted', async () => {
    const { base } = await seed();
    // A user with nothing else to their name, so only the comment refers to them.
    const resolver = await usersService.createUser({
      email: 'pc-resolver@example.com',
      password: 'hunter2hunter2',
      name: 'Comment Resolver',
    });
    const at = new Date('2026-11-10T12:00:00.000Z');
    const root = await makeComment({ ...base, resolvedAt: at, resolvedById: resolver.id });

    await adminDb.user.delete({ where: { id: resolver.id } });

    expect(await adminDb.pageComment.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({
      resolvedAt: at,
      resolvedById: null,
    });
  });
});

describe('page_comment — CHECKs', () => {
  it('refuses resolving a reply', async () => {
    const { t, base } = await seed();
    const root = await makeComment(base);
    await expect(
      makeComment({
        ...base,
        parentCommentId: root.id,
        resolvedAt: new Date(),
        resolvedById: t.userAId,
      }),
    ).rejects.toThrow(/page_comment_resolved_only_on_root/);
  });

  it('refuses a resolver without a resolved time, and allows a time without a resolver', async () => {
    const { t, base } = await seed();
    await expect(makeComment({ ...base, resolvedById: t.userAId })).rejects.toThrow(
      /page_comment_resolver_needs_time/,
    );
    const orphaned = await makeComment({ ...base, resolvedAt: new Date() });
    expect(orphaned.resolvedById).toBeNull();
  });

  it('refuses half an anchor, and an anchor on a reply', async () => {
    const { base } = await seed();
    await expect(makeComment({ ...base, anchor: Uint8Array.from([1, 2]) })).rejects.toThrow(
      /page_comment_anchor_pairing/,
    );
    await expect(makeComment({ ...base, anchorQuote: 'quoted' })).rejects.toThrow(
      /page_comment_anchor_pairing/,
    );
    const root = await makeComment({
      ...base,
      anchor: Uint8Array.from([1, 2]),
      anchorQuote: 'quoted',
    });
    expect(Buffer.from(root.anchor!).equals(Buffer.from([1, 2]))).toBe(true);
    await expect(
      makeComment({
        ...base,
        parentCommentId: root.id,
        anchor: Uint8Array.from([3]),
        anchorQuote: 'again',
      }),
    ).rejects.toThrow(/page_comment_anchor_only_on_root/);
  });
});

describe('page_comment — cotenancy', () => {
  it('refuses a comment whose project or workspace differs from its page’s', async () => {
    const { t, page } = await seed();
    const wrongProject = makeComment({
      workspaceId: t.w1,
      projectId: t.p1b,
      pageId: page.id,
      authorId: t.userAId,
    });
    await expect(wrongProject).rejects.toThrow(/PAGE_COMMENT_CROSS_PROJECT/);
    await expect(wrongProject).rejects.toSatisfy(isCheckViolation);
    await expect(
      makeComment({ workspaceId: t.w2, projectId: t.p2, pageId: page.id, authorId: t.userAId }),
    ).rejects.toThrow(/PAGE_COMMENT_CROSS_WORKSPACE/);
  });

  it('refuses a reply to another page’s comment, and a reply to a reply', async () => {
    const { t, base } = await seed();
    const other = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const foreign = await makeComment({ ...base, pageId: other.id });
    await expect(makeComment({ ...base, parentCommentId: foreign.id })).rejects.toThrow(
      /PAGE_COMMENT_REPLY_CROSS_PAGE/,
    );

    const root = await makeComment(base);
    const reply = await makeComment({ ...base, parentCommentId: root.id });
    await expect(makeComment({ ...base, parentCommentId: reply.id })).rejects.toThrow(
      /PAGE_COMMENT_REPLY_DEPTH/,
    );
  });

  it('refuses re-parenting a comment onto a reply', async () => {
    const { base } = await seed();
    const root = await makeComment(base);
    const reply = await makeComment({ ...base, parentCommentId: root.id });
    const loose = await makeComment(base);
    await expect(
      adminDb.pageComment.update({ where: { id: loose.id }, data: { parentCommentId: reply.id } }),
    ).rejects.toThrow(/PAGE_COMMENT_REPLY_DEPTH/);
  });
});

describe('page_comment — indexes', () => {
  it('carries the two partial root-list indexes', async () => {
    const rows = await adminDb.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'page_comment'
       ORDER BY indexname
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect([...byName.keys()]).toEqual([
      'page_comment_open_roots_idx',
      'page_comment_page_id_idx',
      'page_comment_parent_comment_id_created_at_idx',
      'page_comment_pkey',
      'page_comment_resolved_roots_idx',
      'page_comment_workspace_id_idx',
    ]);
    expect(byName.get('page_comment_open_roots_idx')).toMatch(
      /\(page_id, created_at, id\) WHERE \(\(parent_comment_id IS NULL\) AND \(resolved_at IS NULL\)\)/,
    );
    expect(byName.get('page_comment_resolved_roots_idx')).toMatch(
      /\(page_id, resolved_at, id\) WHERE \(\(parent_comment_id IS NULL\) AND \(resolved_at IS NOT NULL\)\)/,
    );
  });
});

describe('page_comment — RLS under the non-bypass role', () => {
  it('carries the page policy pair, enabled and forced (catalog)', async () => {
    const policies = await adminDb.$queryRaw<
      { policyname: string; permissive: string; cmd: string }[]
    >`
      SELECT policyname, permissive, cmd FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'page_comment'
       ORDER BY policyname
    `;
    expect(policies).toEqual([
      { policyname: 'page_comment_active_workspace', permissive: 'PERMISSIVE', cmd: 'ALL' },
      { policyname: 'page_comment_project_narrow', permissive: 'RESTRICTIVE', cmd: 'SELECT' },
    ]);
    const [flags] = await adminDb.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'page_comment'
    `;
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('hides another workspace’s comments and refuses writing one', async () => {
    const t = await makeTenants();
    const mine = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const theirs = await makePage({ workspaceId: t.w2, projectId: t.p2, userId: t.userBId });
    const c = await makeComment({
      workspaceId: t.w1,
      projectId: t.p1,
      pageId: mine.id,
      authorId: t.userAId,
    });
    await makeComment({
      workspaceId: t.w2,
      projectId: t.p2,
      pageId: theirs.id,
      authorId: t.userBId,
    });

    const visible = await asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
      tx.pageComment.findMany({ select: { id: true } }),
    );
    expect(visible.map((r) => r.id)).toEqual([c.id]);

    await expect(
      asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
        tx.pageComment.create({
          data: {
            workspaceId: t.w2,
            projectId: t.p2,
            pageId: theirs.id,
            authorId: t.userAId,
            bodyMd: 'smuggled',
          },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
  });

  it('lets the app role write and resolve a comment in its own workspace', async () => {
    const { t, base } = await seed();
    const resolved = await asAppRole({ userId: t.userAId, workspaceId: t.w1 }, async (tx) => {
      const root = await tx.pageComment.create({ data: { ...base, bodyMd: 'mine' } });
      return tx.pageComment.update({
        where: { id: root.id },
        data: { resolvedAt: new Date(), resolvedById: t.userAId },
      });
    });
    expect(resolved.resolvedById).toBe(t.userAId);
  });

  it('narrows reads to the bound project when app.project_id is set', async () => {
    const t = await makeTenants();
    const inP1 = await makePage({ workspaceId: t.w1, projectId: t.p1, userId: t.userAId });
    const inP1b = await makePage({ workspaceId: t.w1, projectId: t.p1b, userId: t.userAId });
    const c1 = await makeComment({
      workspaceId: t.w1,
      projectId: t.p1,
      pageId: inP1.id,
      authorId: t.userAId,
    });
    const c1b = await makeComment({
      workspaceId: t.w1,
      projectId: t.p1b,
      pageId: inP1b.id,
      authorId: t.userAId,
    });

    const narrowed = await asAppRole(
      { userId: t.userAId, workspaceId: t.w1, projectId: t.p1 },
      (tx) => tx.pageComment.findMany({ select: { id: true } }),
    );
    expect(narrowed.map((r) => r.id)).toEqual([c1.id]);

    const wide = await asAppRole({ userId: t.userAId, workspaceId: t.w1 }, (tx) =>
      tx.pageComment.findMany({ select: { id: true } }),
    );
    expect(wide.map((r) => r.id).sort()).toEqual([c1.id, c1b.id].sort());
  });
});
