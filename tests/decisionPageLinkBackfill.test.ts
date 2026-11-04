import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { decisionPageService } from '@/lib/services/decisionPageService';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Bug MOTIR-10315 — the back-fill that links every existing publication's page to
// its card, for publications made before the publish wrote the link itself.
//
// ⚠️ THIS FILE EXECUTES THE MIGRATION'S OWN SQL, READ FROM THE MIGRATION (the
// `dispatchRunLegModelBackfill.test.ts` precedent): a retyped INSERT would stay
// green while the shipped statement drifted. The publications are made through
// the real publish and their links then DELETED, which is the state every
// pre-fix publication is in.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261104140000_decision_page_publication_link_backfill/migration.sql',
);

function backfillStatement(): string {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(statements, 'the migration is exactly ONE INSERT').toHaveLength(1);
  expect(statements[0]).toMatch(/^INSERT INTO "page_work_item_link"/);
  return statements[0]!;
}

const runBackfill = () => adminDb.$executeRawUnsafe(backfillStatement());

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

async function card() {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Decide ${seq}`,
      type: 'decision',
      executor: 'coding_agent',
    },
    fx.ctx,
  );
}

const page = (title: string, markdown = '# Decision\n\nOption A.') =>
  pagesService.createPageFromMarkdown(fx.ctx, { projectId: fx.projectId, title, markdown });

/** Publish, then remove the link the publish wrote — a pre-fix publication. */
async function legacyPublish(workItemId: string, pageId: string) {
  const dto = await decisionPageService.publish({ workItemId, pageId }, fx.ctx);
  await adminDb.pageWorkItemLink.deleteMany({ where: { workItemId, pageId, source: 'manual' } });
  return dto;
}

const links = (workItemId: string) =>
  adminDb.pageWorkItemLink.findMany({
    where: { workItemId },
    orderBy: [{ pageId: 'asc' }, { source: 'asc' }],
  });

describe('the decision-page link back-fill (MOTIR-10315)', () => {
  it('links each published page to its card as the first publisher, once per pair', async () => {
    const a = await card();
    const b = await card();
    const first = await page('First take');
    const second = await page('Second take');
    const dtoA = await legacyPublish(a.id, first.id);
    await legacyPublish(a.id, second.id);
    await legacyPublish(b.id, first.id);
    expect(await adminDb.pageWorkItemLink.count()).toBe(0);

    expect(await runBackfill()).toBe(3);

    expect(await links(a.id)).toEqual(
      [first.id, second.id].sort().map((pageId) =>
        expect.objectContaining({
          pageId,
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          source: 'manual',
          createdById: fx.ctx.userId,
        }),
      ),
    );
    const [linkA] = (await links(a.id)).filter((l) => l.pageId === first.id);
    expect(linkA!.createdAt.toISOString()).toBe(dtoA.publishedAt);
    expect(await links(b.id)).toEqual([
      expect.objectContaining({ pageId: first.id, source: 'manual' }),
    ]);
    // The card's Pages section now shows both pages.
    const { rows } = await pageLinksService.listPagesForWorkItem(fx.ctx, { workItemId: a.id });
    expect(rows.map((r) => r.pageId).sort()).toEqual([first.id, second.id].sort());
  });

  it('a second run adds nothing', async () => {
    const a = await card();
    const p = await page('Choice');
    await legacyPublish(a.id, p.id);

    expect(await runBackfill()).toBe(1);
    expect(await runBackfill()).toBe(0);
    expect(await links(a.id)).toHaveLength(1);
  });

  it('keeps a hand link as it is, and adds the row beside a mention without a second entry', async () => {
    const handLinked = await card();
    const mentioned = await card();
    const hand = await page('Hand');
    const mention = await page('Mention', `# Decision\n\nFor [it](motir:${mentioned.id}).`);
    await legacyPublish(handLinked.id, hand.id);
    await pageLinksService.linkPageForWorkItem(fx.ctx, {
      workItemId: handLinked.id,
      pageId: hand.id,
    });
    const handRow = (await links(handLinked.id))[0]!;
    await legacyPublish(mentioned.id, mention.id);

    expect(await runBackfill()).toBe(1);

    expect(await links(handLinked.id)).toEqual([handRow]);
    const { rows } = await pageLinksService.listPagesForWorkItem(fx.ctx, {
      workItemId: mentioned.id,
    });
    expect(rows).toEqual([
      expect.objectContaining({ pageId: mention.id, sources: ['manual', 'mention'] }),
    ]);
  });
});
