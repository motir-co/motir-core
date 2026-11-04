import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// POST /api/work-items/[id]/decision-page (Story MOTIR-5761 · MOTIR-7434) — the
// confirm port's door onto `decisionPageService.publish`. The workspace context
// (session cookie + `next/headers` in production) is the one thing faked, as in
// `tests/design-evidence-routes.test.ts`; the key resolution, the permission
// checks and the write run through the real path.

const workspaceCtx = vi.hoisted(() => ({
  current: null as null | { userId: string; workspaceId: string },
}));
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => workspaceCtx.current };
});

const { POST } = await import('@/app/api/work-items/[id]/decision-page/route');

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  workspaceCtx.current = { userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const post = (key: string, body?: unknown) =>
  POST(
    new Request(`http://localhost/api/work-items/${key}/decision-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: key }) },
  );

async function card(type: 'decision' | 'code' = 'decision') {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Decide ${seq}`,
      type,
      executor: 'coding_agent',
    },
    fx.ctx,
  );
}

const page = (markdown = '# Decision\n\nOption A.', projectId = fx.projectId) =>
  pagesService.createPageFromMarkdown(fx.ctx, { projectId, title: 'Choice', markdown });

describe('POST /api/work-items/[id]/decision-page', () => {
  it('publishes (201), then answers a replay of the same version with 200', async () => {
    const item = await card();
    const p = await page();

    const res = await post(item.identifier, { pageId: p.id });
    expect(res.status).toBe(201);
    const { publication } = await res.json();
    expect(publication).toMatchObject({ pageId: p.id, versionNumber: 1, replayed: false });
    expect(publication.gateId).toEqual(expect.any(String));

    const again = await post(item.identifier, { pageId: p.id });
    expect(again.status).toBe(200);
    expect((await again.json()).publication).toMatchObject({ id: publication.id, replayed: true });
  });

  it('leaves the published page linked to the card — the Choose page door (MOTIR-10315)', async () => {
    const item = await card();
    const p = await page();

    expect((await post(item.identifier, { pageId: p.id })).status).toBe(201);
    const links = await adminDb.pageWorkItemLink.findMany({ where: { workItemId: item.id } });
    expect(links).toEqual([
      expect.objectContaining({ pageId: p.id, source: 'manual', createdById: fx.ctx.userId }),
    ]);
  });

  it('401s without a session and 400s without a pageId', async () => {
    const item = await card();
    workspaceCtx.current = null;
    expect((await post(item.identifier, { pageId: 'x' })).status).toBe(401);
    workspaceCtx.current = { userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId };
    const res = await post(item.identifier, {});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_REQUEST');
  });

  it('a viewer, who may read the card but not edit it, is refused by the permission gate', async () => {
    const item = await card();
    const p = await page();
    const viewer = await adminDb.user.create({
      data: { email: `decision-viewer-${seq}@example.com`, name: 'Viewer', emailVerified: true },
    });
    await adminDb.workspaceMembership.create({
      data: { userId: viewer.id, workspaceId: fx.workspaceId, workspaceRole: 'viewer' },
    });
    workspaceCtx.current = { userId: viewer.id, workspaceId: fx.workspaceId };
    const res = await post(item.identifier, { pageId: p.id });
    expect(res.status).toBe(403);
    expect(await adminDb.decisionPagePublication.count({ where: { workItemId: item.id } })).toBe(0);
  });

  it('404s an unknown card', async () => {
    expect((await post('PROD-99999', { pageId: 'x' })).status).toBe(404);
  });

  it('maps every service refusal to its code and status', async () => {
    const expectRefusal = async (res: Response, code: string, status: number) => {
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(code);
    };
    const p = await page();
    const code = await card('code');
    await expectRefusal(await post(code.identifier, { pageId: p.id }), 'NOT_A_DECISION_CARD', 422);

    const decision = await card();
    await expectRefusal(
      await post(decision.identifier, { pageId: 'no-such-page' }),
      'PAGE_NOT_FOUND',
      404,
    );

    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const elsewhere = await page('# Elsewhere', other.id);
    await expectRefusal(
      await post(decision.identifier, { pageId: elsewhere.id }),
      'PAGE_IN_ANOTHER_PROJECT',
      422,
    );

    const blank = await pagesService.createPage(fx.ctx, { projectId: fx.projectId, title: 'B' });
    await expectRefusal(
      await post(decision.identifier, { pageId: blank.id }),
      'PAGE_IS_EMPTY',
      422,
    );

    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    await expectRefusal(await post(decision.identifier, { pageId: p.id }), 'PAGE_ARCHIVED', 409);

    const fresh = await page();
    await adminDb.workItem.update({ where: { id: decision.id }, data: { status: 'done' } });
    await expectRefusal(
      await post(decision.identifier, { pageId: fresh.id }),
      'CARD_IS_FINISHED',
      409,
    );
  });
});
