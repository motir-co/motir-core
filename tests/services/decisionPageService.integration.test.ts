import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  DecisionCardFinishedError,
  DecisionPageArchivedError,
  DecisionPageEmptyError,
  DecisionPageInAnotherProjectError,
  DecisionPageNotFoundError,
  NotADecisionCardError,
} from '@/lib/decisionPages/errors';
import { pageDecisionSubjectVersion } from '@/lib/approvalGates/decisionSubject';
import { decisionPageService } from '@/lib/services/decisionPageService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import { userRepository } from '@/lib/repositories/userRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced, transitionedEventsFor } from '../helpers/transitionedEvents';

// `decisionPageService.publish` over real Postgres (Story MOTIR-5761 · MOTIR-7432;
// `approval-gates.md` §8 NINTH AMENDMENT clauses 1–3). The seal, the publication
// row, the gate it raises or supersedes, the status walk, the replay, every
// refusal with nothing written, and a save racing the publish.

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

async function card(
  opts: { type?: 'decision' | 'code'; executor?: 'coding_agent' | 'human' } = {},
) {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Decide ${seq}`,
      type: opts.type ?? 'decision',
      executor: opts.executor ?? 'coding_agent',
    },
    fx.ctx,
  );
}

async function page(markdown = '# Decision\n\nWe pick option A.', projectId = fx.projectId) {
  const created = await pagesService.createPageFromMarkdown(fx.ctx, {
    projectId,
    title: 'Decision',
    markdown,
  });
  return created;
}

/** Push the page's versions back an hour, so the next save opens a new version. */
async function age(pageId: string) {
  const back = new Date(Date.now() - 3_600_000);
  await adminDb.pageVersion.updateMany({
    where: { pageId },
    data: { startedAt: back, savedAt: back },
  });
}

async function save(pageId: string, markdown: string) {
  const current = await pagesService.getPageMarkdown(fx.ctx, { projectId: fx.projectId, pageId });
  return pagesService.savePageMarkdown(fx.ctx, {
    projectId: fx.projectId,
    pageId,
    markdown,
    expectedRevision: current.revision,
  });
}

const gates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'decision_approval' },
    orderBy: { createdAt: 'asc' },
  });
const publications = (workItemId: string) =>
  adminDb.decisionPagePublication.findMany({ where: { workItemId } });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

/** Publish, asserting every status hop it wrote was announced once (Bug MOTIR-9485). */
async function publishAnnounced(workItemId: string, pageId: string) {
  return expectEachHopAnnounced(
    workItemId,
    { workspaceId: fx.ctx.workspaceId, actorId: fx.ctx.userId },
    () => decisionPageService.publish({ workItemId, pageId }, fx.ctx),
  );
}

describe('decisionPageService.publish — an agent decision card', () => {
  it('seals the latest version, records one publication, raises an awaiting gate and walks the card to review', async () => {
    const item = await card();
    const p = await page();

    // Each hop of the walk is announced once the publish commits (Bug MOTIR-9485).
    const { result: dto, hops } = await publishAnnounced(item.id, p.id);
    expect(hops.length).toBeGreaterThan(0);

    const version = await adminDb.pageVersion.findFirstOrThrow({
      where: { pageId: p.id },
      orderBy: { number: 'desc' },
    });
    expect(version.sealedAt).not.toBeNull();
    expect(version.frozenAt).toBeNull();
    expect(dto).toMatchObject({
      workItemId: item.id,
      workItemKey: item.identifier,
      pageId: p.id,
      versionId: version.id,
      versionNumber: version.number,
      publishedById: fx.ownerId,
      replayed: false,
    });
    expect(await publications(item.id)).toHaveLength(1);
    const [gate] = await gates(item.id);
    expect(gate).toMatchObject({
      state: 'awaiting',
      subjectId: item.id,
      subjectVersion: pageDecisionSubjectVersion(p.id, version.id),
    });
    expect(dto.gateId).toBe(gate!.id);
    expect(['in_review', 'implemented']).toContain(await statusOf(item.id));
  });

  // Bug MOTIR-9485: the walk wrote its hop and announced nothing, so the parent
  // rollup, the bell and automation rules never saw the card enter review.
  it('announces the In Progress card’s one hop to review with work-item/transitioned', async () => {
    const item = await card();
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    const p = await page();

    const { hops } = await publishAnnounced(item.id, p.id);

    expect(hops).toEqual([{ fromStatusKey: 'in_progress', toStatusKey: 'in_review' }]);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a replay walks nothing and announces nothing', async () => {
    const item = await card();
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    const p = await page();
    await decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx);

    const { result, hops } = await publishAnnounced(item.id, p.id);

    expect(result.replayed).toBe(true);
    expect(hops).toEqual([]);
  });

  // ⚠️ THE EMIT WAITS FOR THE COMMIT. A publish that fails after the walk rolls the
  // hop back, and an event already sent for it would tell every consumer about a
  // move that never happened.
  it('announces nothing when the publish rolls back after the walk', async () => {
    const item = await card();
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    const p = await page();
    const before = await transitionedEventsFor(item.id);
    // The publisher read that closes the publish's transaction, after the walk has written.
    const publisher = vi
      .spyOn(userRepository, 'findByIds')
      .mockRejectedValueOnce(new Error('the publish fails after the walk'));

    try {
      await expect(
        decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx),
      ).rejects.toThrow('the publish fails after the walk');
    } finally {
      publisher.mockRestore();
    }

    expect(await statusOf(item.id)).toBe('in_progress');
    expect(await publications(item.id)).toHaveLength(0);
    expect(await transitionedEventsFor(item.id)).toEqual(before);
  });

  it('the SAME version twice is a replay: no second publication, no second gate', async () => {
    const item = await card();
    const p = await page();
    const first = await decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx);
    const again = await decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx);

    expect(again).toMatchObject({ id: first.id, replayed: true, gateId: null });
    expect(await publications(item.id)).toHaveLength(1);
    expect(await gates(item.id)).toHaveLength(1);
  });

  it('after an edit, a republish seals the NEW version and supersedes the awaiting gate as republished', async () => {
    const item = await card();
    const p = await page();
    const first = await decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx);
    // Within the window and by the same author: the seal alone makes this a new version.
    await save(p.id, '# Decision\n\nWe pick option B.');

    const second = await decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx);

    expect(second.versionNumber).toBe(first.versionNumber + 1);
    const sealedFirst = await adminDb.pageVersion.findUniqueOrThrow({
      where: { id: first.versionId },
    });
    expect(sealedFirst.bodyMarkdown).toContain('option A');
    expect(await publications(item.id)).toHaveLength(2);
    const [old, current] = await gates(item.id);
    expect(old).toMatchObject({ state: 'superseded', supersededCause: 'republished' });
    expect(current).toMatchObject({
      state: 'awaiting',
      subjectVersion: pageDecisionSubjectVersion(p.id, second.versionId),
    });
  });
});

describe('decisionPageService.publish — one version, two cards', () => {
  it('a version another card already sealed keeps its FIRST seal', async () => {
    const p = await page();
    const first = await decisionPageService.publish(
      { workItemId: (await card()).id, pageId: p.id },
      fx.ctx,
    );
    const second = await decisionPageService.publish(
      { workItemId: (await card()).id, pageId: p.id },
      fx.ctx,
    );
    expect(second.versionId).toBe(first.versionId);
    expect(second.sealedAt).toBe(first.sealedAt);
    expect(second.replayed).toBe(false);
  });
});

describe('decisionPageService.publish — a human decision card', () => {
  it('records and seals, raises no decision_approval and moves no status', async () => {
    const item = await card({ executor: 'human' });
    const before = await statusOf(item.id);
    const p = await page();

    const dto = await decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx);

    expect(dto.gateId).toBeNull();
    expect(await publications(item.id)).toHaveLength(1);
    expect(await gates(item.id)).toHaveLength(0);
    expect(await statusOf(item.id)).toBe(before);
  });
});

describe('decisionPageService.publish — the refusals, each with nothing written', () => {
  async function nothingWritten(workItemId: string, pageId: string | null) {
    expect(await publications(workItemId)).toHaveLength(0);
    expect(await gates(workItemId)).toHaveLength(0);
    if (pageId) {
      const sealed = await adminDb.pageVersion.count({
        where: { pageId, sealedAt: { not: null } },
      });
      expect(sealed).toBe(0);
    }
  }

  it('NOT_A_DECISION_CARD', async () => {
    const item = await card({ type: 'code' });
    const p = await page();
    await expect(
      decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx),
    ).rejects.toBeInstanceOf(NotADecisionCardError);
    await nothingWritten(item.id, p.id);
  });

  it('PAGE_NOT_FOUND for an unknown id', async () => {
    const item = await card();
    const err = await decisionPageService
      .publish({ workItemId: item.id, pageId: 'no-such-page' }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionPageNotFoundError);
    expect(err).toMatchObject({ code: 'PAGE_NOT_FOUND' });
    await nothingWritten(item.id, null);
  });

  it('PAGE_IN_ANOTHER_PROJECT for a readable page filed elsewhere', async () => {
    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const item = await card();
    const p = await page('# Elsewhere', other.id);
    await expect(
      decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx),
    ).rejects.toBeInstanceOf(DecisionPageInAnotherProjectError);
    await nothingWritten(item.id, p.id);
  });

  it('WORK_ITEM_NOT_FOUND for an unknown card', async () => {
    const p = await page();
    await expect(
      decisionPageService.publish({ workItemId: 'no-such-card', pageId: p.id }, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('PAGE_NOT_FOUND — never "another project" — for a page in a project the caller cannot read', async () => {
    const closed = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Closed',
      identifier: 'CLO',
    });
    await adminDb.project.update({ where: { id: closed.id }, data: { accessMode: 'members' } });
    const p = await page('# Closed', closed.id);
    const member = await usersService.createUser({
      email: `decision-member-${seq}@example.com`,
      password: 'hunter2hunter2',
      name: 'Member',
    });
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    const item = await card();
    const err = await decisionPageService
      .publish(
        { workItemId: item.id, pageId: p.id },
        { userId: member.id, workspaceId: fx.workspaceId },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionPageNotFoundError);
    await nothingWritten(item.id, p.id);
  });

  it('PAGE_IS_EMPTY for a blank page', async () => {
    const item = await card();
    const p = await pagesService.createPage(fx.ctx, { projectId: fx.projectId, title: 'Blank' });
    await expect(
      decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx),
    ).rejects.toBeInstanceOf(DecisionPageEmptyError);
    await nothingWritten(item.id, p.id);
  });

  it('PAGE_ARCHIVED for an archived page', async () => {
    const item = await card();
    const p = await page();
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    await expect(
      decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx),
    ).rejects.toBeInstanceOf(DecisionPageArchivedError);
    await nothingWritten(item.id, p.id);
  });

  it('CARD_IS_FINISHED for a card in the done category', async () => {
    const item = await card();
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
    const p = await page();
    await expect(
      decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx),
    ).rejects.toBeInstanceOf(DecisionCardFinishedError);
    await nothingWritten(item.id, p.id);
  });
});

describe('decisionPageService.publish — a save racing the publish', () => {
  it('never leaves a sealed version extended: its markdown is what the publication reports', async () => {
    for (let round = 0; round < 12; round += 1) {
      const item = await card();
      const p = await page(`# Round ${round}\n\noriginal`);
      await age(p.id);
      const current = await pagesService.getPageMarkdown(fx.ctx, {
        projectId: fx.projectId,
        pageId: p.id,
      });

      const [published] = await Promise.all([
        decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx),
        pagesService
          .savePageMarkdown(fx.ctx, {
            projectId: fx.projectId,
            pageId: p.id,
            markdown: `# Round ${round}\n\nracing edit`,
            expectedRevision: current.revision,
          })
          .catch(() => null),
      ]);

      const sealed = await adminDb.pageVersion.findUniqueOrThrow({
        where: { id: published.versionId },
      });
      // Either order is legitimate: the edit landed before the seal (and is in
      // the sealed version), or after it (and started N+1). Never INTO it after.
      const later = await adminDb.pageVersion.findMany({
        where: { pageId: p.id, number: { gt: sealed.number } },
      });
      if (sealed.bodyMarkdown.includes('racing edit')) {
        expect(later).toHaveLength(0);
      } else {
        expect(sealed.bodyMarkdown).toContain('original');
        expect(later.every((v) => v.sealedAt === null)).toBe(true);
        expect(sealed.savedAt.getTime()).toBeLessThanOrEqual(sealed.sealedAt!.getTime());
      }
    }
  });
});
