import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { decisionPageService } from '@/lib/services/decisionPageService';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Bug MOTIR-10315 — publishing a page as a card's decision LINKS the page to the
// card, in the same transaction as the publication: the pair's hand row
// (`manual`), written by the publisher, with the work item's revision. A
// republish of the page — a replay or a new version — leaves one link, a page
// already linked by hand is not linked twice, and a page linked by mention stays
// one entry of the card's Pages section. On real Postgres.

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function card(executor: 'coding_agent' | 'human' = 'coding_agent') {
  seq += 1;
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Decide ${seq}`, type: 'decision', executor },
    fx.ctx,
  );
}

const page = (markdown = '# Decision\n\nWe pick option A.') =>
  pagesService.createPageFromMarkdown(fx.ctx, {
    projectId: fx.projectId,
    title: 'Choice',
    markdown,
  });

const publish = (workItemId: string, pageId: string) =>
  decisionPageService.publish({ workItemId, pageId }, fx.ctx);

const links = (workItemId: string) =>
  adminDb.pageWorkItemLink.findMany({ where: { workItemId }, orderBy: { source: 'asc' } });

/** The revisions that recorded a page link being added. */
async function linkRevisions(workItemId: string) {
  const rows = await adminDb.workItemRevision.findMany({ where: { workItemId } });
  return rows.filter((r) => JSON.stringify(r.diff).includes('"pageLinks"'));
}

/** Push the page's versions back an hour and save, so the page gains version N+1. */
async function newVersion(pageId: string, markdown: string) {
  const back = new Date(Date.now() - 3_600_000);
  await adminDb.pageVersion.updateMany({
    where: { pageId },
    data: { startedAt: back, savedAt: back },
  });
  const current = await pagesService.getPageMarkdown(fx.ctx, { projectId: fx.projectId, pageId });
  await pagesService.savePageMarkdown(fx.ctx, {
    projectId: fx.projectId,
    pageId,
    markdown,
    expectedRevision: current.revision,
  });
}

describe('decisionPageService.publish — the page link (MOTIR-10315)', () => {
  it('links the page to the card by hand, as the publisher, and records the revision', async () => {
    const item = await card();
    const p = await page();

    await publish(item.id, p.id);

    expect(await links(item.id)).toEqual([
      expect.objectContaining({
        pageId: p.id,
        projectId: fx.projectId,
        workspaceId: fx.workspaceId,
        source: 'manual',
        createdById: fx.ctx.userId,
      }),
    ]);
    const [revision, ...more] = await linkRevisions(item.id);
    expect(more).toHaveLength(0);
    expect(revision!.diff).toEqual({ pageLinks: { added: [{ pageId: p.id, title: 'Choice' }] } });

    // The card's Pages section — the read `get_work_item` serves too — shows it.
    const { rows } = await pageLinksService.listPagesForWorkItem(fx.ctx, { workItemId: item.id });
    expect(rows).toEqual([expect.objectContaining({ pageId: p.id, sources: ['manual'] })]);
  });

  it('links on a HUMAN decision card too, which raises no gate', async () => {
    const item = await card('human');
    const p = await page();

    const dto = await publish(item.id, p.id);

    expect(dto.gateId).toBeNull();
    expect(await links(item.id)).toEqual([
      expect.objectContaining({ pageId: p.id, source: 'manual' }),
    ]);
  });

  it('a replay and a new version of the same page leave ONE link and one revision', async () => {
    const item = await card();
    const p = await page();

    const first = await publish(item.id, p.id);
    expect((await publish(item.id, p.id)).replayed).toBe(true);
    await newVersion(p.id, '# Decision\n\nWe pick option B.');
    const second = await publish(item.id, p.id);

    expect(second.versionNumber).toBe(first.versionNumber + 1);
    expect(await links(item.id)).toHaveLength(1);
    expect(await linkRevisions(item.id)).toHaveLength(1);
  });

  it('a page already linked by hand keeps its one row, and no second revision is written', async () => {
    const item = await card();
    const p = await page();
    await pageLinksService.linkPageForWorkItem(fx.ctx, { workItemId: item.id, pageId: p.id });

    await publish(item.id, p.id);

    expect(await links(item.id)).toEqual([
      expect.objectContaining({ pageId: p.id, source: 'manual' }),
    ]);
    expect(await linkRevisions(item.id)).toHaveLength(1);
  });

  it('a page already linked by mention stays ONE entry in the Pages section', async () => {
    const item = await card();
    const p = await page(`# Decision\n\nFor [the card](motir:${item.id}): option A.`);
    expect((await links(item.id)).map((l) => l.source)).toEqual(['mention']);

    await publish(item.id, p.id);

    const { rows } = await pageLinksService.listPagesForWorkItem(fx.ctx, { workItemId: item.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pageId: p.id, sources: ['manual', 'mention'] });
  });

  it('a publish that fails AFTER the link leaves no link and no publication — one transaction', async () => {
    const item = await card();
    const p = await page();
    // The gate step runs after the link is written; failing it rolls the publish back.
    vi.spyOn(approvalGateRepository, 'supersedeAwaitingByWorkItem').mockRejectedValueOnce(
      new Error('boom'),
    );

    await expect(publish(item.id, p.id)).rejects.toThrow('boom');

    expect(await links(item.id)).toHaveLength(0);
    expect(await linkRevisions(item.id)).toHaveLength(0);
    expect(await adminDb.decisionPagePublication.count({ where: { workItemId: item.id } })).toBe(0);
  });
});
