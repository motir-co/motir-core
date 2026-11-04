import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import type { WorkItemLinkedPagesDto } from '@/lib/dto/pageLinks';
import { renderLinkedPages, runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { decisionPageService } from '@/lib/services/decisionPageService';
import { AGENT_LINKED_PAGES_LIMIT } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// Bug MOTIR-10315 — `get_work_item` returns the card's LINKED PAGES: the set its
// Pages section shows, bounded at 50 with `hasMore`, each row with its id and
// title, and the card's LATEST decision publication marked with its version (on
// its row, and as `decisionPage` wherever it sits). A reader without `page:view`
// gets the rest of the read with `pages: null`. On real Postgres, through the
// tool's own adapter.

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function card(type: 'decision' | 'code' = 'decision') {
  seq += 1;
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Card ${seq}`, type, executor: 'coding_agent' },
    fx.ctx,
  );
}

const page = (title: string, markdown = '# Decision\n\nOption A.') =>
  pagesService.createPageFromMarkdown(fx.ctx, { projectId: fx.projectId, title, markdown });

const link = (pageId: string, workItemId: string, updatedAt?: Date) =>
  Promise.all([
    adminDb.pageWorkItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        pageId,
        workItemId,
        source: 'manual',
        createdById: fx.ownerId,
      },
    }),
    updatedAt ? adminDb.page.update({ where: { id: pageId }, data: { updatedAt } }) : null,
  ]);

async function read(ctx: ServiceContext, key: string) {
  const res = await runGetWorkItem({ key }, ctx);
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  const structured = (res as CallToolResult).structuredContent as {
    pages: WorkItemLinkedPagesDto | null;
    item: { identifier: string };
  };
  const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return { pages: structured.pages, item: structured.item, text };
}

describe('get_work_item — the linked pages (MOTIR-10315)', () => {
  it('serves an empty list and no decision for a card with no page, and prints no page line', async () => {
    const item = await card('code');

    const { pages, text } = await read(fx.ctx, item.identifier);

    expect(pages).toEqual({ rows: [], hasMore: false, decisionPage: null });
    expect(text).not.toContain('Pages:');
    expect(text).not.toContain('Decision page:');
  });

  it('serves the Pages section’s set — id, title, state, sources — and marks the published decision', async () => {
    const item = await card();
    const notes = await page('Notes');
    const choice = await page('Choice');
    await link(notes.id, item.id, new Date('2026-01-01T00:00:00.000Z'));
    await decisionPageService.publish({ workItemId: item.id, pageId: choice.id }, fx.ctx);

    const { pages, text } = await read(fx.ctx, item.identifier);

    expect(pages!.hasMore).toBe(false);
    expect(pages!.rows).toEqual([
      expect.objectContaining({
        pageId: choice.id,
        title: 'Choice',
        state: 'live',
        sources: ['manual'],
        decision: { versionNumber: 1, publishedAt: expect.any(String) },
      }),
      expect.objectContaining({ pageId: notes.id, title: 'Notes', decision: null }),
    ]);
    expect(pages!.decisionPage).toEqual({
      pageId: choice.id,
      title: 'Choice',
      versionNumber: 1,
      publishedAt: pages!.rows[0]!.decision!.publishedAt,
    });
    expect(text).toContain(`Decision page: Choice (${choice.id}) — published version 1`);
    expect(text).toContain(`Pages: Choice (${choice.id}) [decision v1] · Notes (${notes.id})`);
  });

  it('marks ONLY the latest publication when the card was published more than once', async () => {
    const item = await card();
    const first = await page('First take');
    const second = await page('Second take');
    await decisionPageService.publish({ workItemId: item.id, pageId: first.id }, fx.ctx);
    await decisionPageService.publish({ workItemId: item.id, pageId: second.id }, fx.ctx);

    const { pages } = await read(fx.ctx, item.identifier);

    const byId = new Map(pages!.rows.map((r) => [r.pageId, r]));
    expect(byId.get(second.id)!.decision).toMatchObject({ versionNumber: 1 });
    expect(byId.get(first.id)!.decision).toBeNull();
    expect(pages!.decisionPage).toMatchObject({ pageId: second.id, title: 'Second take' });
  });

  it('is bounded at 50 rows with hasMore, and still names a decision page outside the window', async () => {
    const item = await card();
    const choice = await page('Choice');
    await decisionPageService.publish({ workItemId: item.id, pageId: choice.id }, fx.ctx);
    // The decision page is the OLDEST edit, so the newest-first window passes it by.
    await adminDb.page.update({
      where: { id: choice.id },
      data: { updatedAt: new Date('2020-01-01T00:00:00.000Z') },
    });
    for (let i = 0; i < AGENT_LINKED_PAGES_LIMIT; i += 1) {
      const p = await pagesService.createPage(fx.ctx, { projectId: fx.projectId, title: `P${i}` });
      await link(p.id, item.id);
    }

    const { pages, text } = await read(fx.ctx, item.identifier);

    expect(AGENT_LINKED_PAGES_LIMIT).toBe(50);
    expect(pages!.rows).toHaveLength(50);
    expect(pages!.hasMore).toBe(true);
    expect(pages!.rows.some((r) => r.pageId === choice.id)).toBe(false);
    expect(pages!.decisionPage).toMatchObject({ pageId: choice.id, versionNumber: 1 });
    expect(text).toContain('…and more');
  });

  it('gives a reader without page:view the rest of the read with pages: null and no page text', async () => {
    const item = await card();
    const secret = await page('Secret decision title');
    await decisionPageService.publish({ workItemId: item.id, pageId: secret.id }, fx.ctx);
    const browseOnly = await createCustomRoleAs({
      ctx: fx.ctx,
      name: 'Browser',
      permissions: ['project:browse', 'work_item:view'],
    });
    const user = await usersService.createUser({
      email: 'browse-only@example.com',
      password: 'hunter2hunter2',
      name: 'Browse only',
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    await setProjectRoleDefinitionFor(user.id, fx.projectId, {
      roleDefinitionId: browseOnly.id,
      role: 'member',
    });

    const res = await read({ userId: user.id, workspaceId: fx.workspaceId }, item.identifier);

    expect(res.item.identifier).toBe(item.identifier);
    expect(res.pages).toBeNull();
    expect(res.text).not.toContain('Secret decision title');
    expect(res.text).not.toContain(secret.id);
  });
});

describe('renderLinkedPages', () => {
  it('prints nothing for null, and flags an archived row', () => {
    expect(renderLinkedPages(null)).toEqual([]);
    expect(
      renderLinkedPages({
        rows: [
          {
            pageId: 'p1',
            title: 'Old',
            state: 'unavailable',
            sources: ['manual'],
            updatedAt: '2026-01-01T00:00:00.000Z',
            place: { folderPath: [], parentPageTitle: null },
            decision: { versionNumber: 2, publishedAt: '2026-01-01T00:00:00.000Z' },
          },
        ],
        hasMore: false,
        decisionPage: null,
      }),
    ).toEqual(['Pages: Old (p1) [decision v2, archived]']);
  });
});
