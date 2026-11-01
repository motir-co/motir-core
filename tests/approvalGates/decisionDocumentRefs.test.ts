import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { DecisionDocumentResolver } from '@/lib/approvalGates/decisionDocumentResolver';
import {
  decisionDocumentService,
  setDecisionDocumentResolver,
} from '@/lib/services/decisionDocumentService';
import { decisionPageService } from '@/lib/services/decisionPageService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Bug MOTIR-10020 — a decision document shown at its gate drew every work-item link
// struck through, because the port's read resolved none of the document's `motir:`
// ids. `readViewForWorkItem` now resolves them for the reader, in one batched read, on
// both arms that draw Markdown — a published page version and a repository file — and
// a document that links nothing pays no ref read.

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

let restoreResolver: DecisionDocumentResolver | null = null;
afterEach(() => {
  if (restoreResolver) setDecisionDocumentResolver(restoreResolver);
  restoreResolver = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function card(title: string, type: 'decision' | 'code' = 'code') {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `${title} ${seq}`,
      type,
      executor: 'coding_agent',
    },
    fx.ctx,
  );
}

/** A decision card whose published page version carries `markdown`. */
async function pageDecision(markdown: string) {
  const item = await card('Decide', 'decision');
  const page = await pagesService.createPageFromMarkdown(fx.ctx, {
    projectId: fx.projectId,
    title: 'Seed registry',
    markdown,
  });
  await decisionPageService.publish({ workItemId: item.id, pageId: page.id }, fx.ctx);
  return item;
}

/** A decision card delivered by one open pull request whose capture found one file. */
async function fileDecision() {
  const item = await card('Decide', 'decision');
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-refs-${seq}`,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: `repo-refs-${seq}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: seq,
      title: 'Decide',
      state: 'open',
      headRef: `docs/decide-${seq}`,
      baseRef: 'main',
      provider: 'github',
      decisionDocOutcome: 'one',
      decisionDocPath: 'docs/decisions/seed-registry.md',
      decisionDocBlobSha: 'blob-1',
      decisionDocHeadSha: 'head-1',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: item.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  return item;
}

/** Serve `markdown` as every captured file's content. */
function serveFile(markdown: string) {
  restoreResolver = setDecisionDocumentResolver({
    async resolve(identity) {
      if (identity.source === 'page' || !identity.resolvable) {
        return { outcome: 'unresolvable', reason: 'unreadable' };
      }
      return {
        outcome: 'resolved',
        repo: identity.repo,
        path: identity.path,
        blobSha: identity.blobSha,
        markdown,
      };
    },
  });
}

const GONE = 'cmgonegonegonegonegone00';

describe('the decision port resolves its document’s work-item links (MOTIR-10020)', () => {
  it('a published page version carries a live summary for a live card, and none for a gone one', async () => {
    const linked = await card('The seed registry');
    const item = await pageDecision(
      `# Decision\n\nSettles [${linked.identifier}](motir:${linked.id}) and retires [MOTIR-1](motir:${GONE}).`,
    );

    const view = await decisionDocumentService.readViewForWorkItem(item.id, fx.ctx);

    expect(view?.outcome).toBe('page');
    if (view?.outcome !== 'page') return;
    expect(view.markdown).toContain(`motir:${linked.id}`);
    expect(view.workItemRefs[linked.id]).toMatchObject({
      accessible: true,
      id: linked.id,
      identifier: linked.identifier,
      title: linked.title,
      status: { category: 'todo' },
    });
    // A card that really is gone stays absent, so its chip still draws struck through.
    expect(view.workItemRefs[GONE]).toBeUndefined();
  });

  it('a repository file (the resolved arm) carries the same summaries', async () => {
    const linked = await card('The seed registry');
    const item = await fileDecision();
    serveFile(`# ADR\n\nSettles [${linked.identifier}](motir:${linked.id}).`);

    const view = await decisionDocumentService.readViewForWorkItem(item.id, fx.ctx);

    expect(view?.outcome).toBe('resolved');
    if (view?.outcome !== 'resolved') return;
    expect(view.workItemRefs[linked.id]).toMatchObject({
      accessible: true,
      identifier: linked.identifier,
      title: linked.title,
    });
  });

  it('a document that links no work item carries an empty map and issues no ref read', async () => {
    const item = await pageDecision('# Decision\n\nNothing linked here.');
    const refRead = vi.spyOn(workItemRepository, 'findByIdsInWorkspace');

    const view = await decisionDocumentService.readViewForWorkItem(item.id, fx.ctx);

    expect(view).toMatchObject({ outcome: 'page', workItemRefs: {} });
    expect(refRead).not.toHaveBeenCalled();
  });

  it('a document that cannot be shown resolves nothing', async () => {
    const item = await fileDecision();
    restoreResolver = setDecisionDocumentResolver({
      async resolve() {
        return { outcome: 'unresolvable', reason: 'host_unreachable' };
      },
    });
    const refRead = vi.spyOn(workItemRepository, 'findByIdsInWorkspace');

    const view = await decisionDocumentService.readViewForWorkItem(item.id, fx.ctx);

    expect(view).toMatchObject({ outcome: 'unresolvable', reason: 'host_unreachable' });
    expect(view).not.toHaveProperty('workItemRefs');
    expect(refRead).not.toHaveBeenCalled();
  });
});
