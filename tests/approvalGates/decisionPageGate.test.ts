import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionDocOutcome } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import {
  decisionApprovalGateHandler,
  decisionHoldsMerge,
  loadDecisionIdentity,
} from '@/lib/approvalGates/decisionApprovalHandler';
import type { DecisionDocumentResolver } from '@/lib/approvalGates/decisionDocumentResolver';
import { pageDecisionSubjectVersion } from '@/lib/approvalGates/decisionSubject';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import {
  decisionDocumentService,
  setPageDecisionDocumentResolver,
} from '@/lib/services/decisionDocumentService';
import { decisionPageService } from '@/lib/services/decisionPageService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { gateSetFor } from '@/lib/services/gateSetFor';
import { summarizeGateSubjects } from '@/lib/approvalGates/subjectSummary';
import { toDecisionDocumentViewDTO } from '@/lib/mappers/decisionDocumentMappers';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced } from '../helpers/transitionedEvents';

// `decision_approval` asks about a PAGE (Story MOTIR-5761 · MOTIR-7433;
// `approval-gates.md` §8 NINTH AMENDMENT). A published page wins the subject over a
// pull request's file; Approve FREEZES the version in the decide transaction and,
// with no pull request open, writes `done`; Request changes, a supersede and a
// withdraw freeze nothing; a second resolver changes only what a person reads.

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

let restorePageResolver: DecisionDocumentResolver | null = null;
afterEach(() => {
  if (restorePageResolver) setPageDecisionDocumentResolver(restorePageResolver);
  restorePageResolver = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Capture {
  outcome: DecisionDocOutcome | null;
  path?: string | null;
  blobSha?: string | null;
  headSha?: string | null;
  state?: 'open' | 'closed';
}

/** A decision card in review, delivered by one pull request per capture given. */
async function decisionCard(
  captures: Capture[],
  card: { type?: 'decision' | 'code'; executor?: 'coding_agent' | 'human' } = {},
) {
  seq += 1;
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Decide ${seq}`,
      type: card.type ?? 'decision',
      executor: card.executor ?? 'coding_agent',
    },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-decision-${seq}`,
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
      repoId: `repo-decision-${seq}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  for (const [index, capture] of captures.entries()) {
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: seq * 10 + index,
        title: 'Decide',
        state: capture.state ?? 'open',
        headRef: `docs/decide-${seq}-${index}`,
        baseRef: 'main',
        provider: 'github',
        decisionDocOutcome: capture.outcome,
        decisionDocPath: capture.path ?? null,
        decisionDocBlobSha: capture.blobSha ?? null,
        decisionDocHeadSha: capture.headSha ?? null,
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
  }
  return item;
}

const ONE: Capture = {
  outcome: 'one',
  path: 'docs/decisions/page-model.md',
  blobSha: 'blob-1',
  headSha: 'head-1',
};

const decide = (gateId: string, decision: 'approve' | 'request_changes') =>
  approvalGatesService.decide(
    {
      stamp: DECIDED_WITHOUT_A_READER,
      gateId,
      decision,
      source: 'ui',
      noteMd: decision === 'request_changes' ? 'Needs changes.' : null,
    },
    fx.ctx,
  );

const itemRow = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });

async function publishedPage(itemId: string, markdown = '# Page model\n\nA tree of pages.') {
  const page = await pagesService.createPageFromMarkdown(fx.ctx, {
    projectId: fx.projectId,
    title: 'Page model',
    markdown,
  });
  const publication = await decisionPageService.publish(
    { workItemId: itemId, pageId: page.id },
    fx.ctx,
  );
  return { page, publication };
}

const versionRow = (id: string) => adminDb.pageVersion.findUniqueOrThrow({ where: { id } });

describe('the subject — a published page wins', () => {
  it('a card with a publication resolves to the page arm, versioned page:<pageId>@<versionId>', async () => {
    const item = await decisionCard([]);
    const { page, publication } = await publishedPage(item.id);
    const identity = await withWorkspaceContext(fx.ctx, (tx) => loadDecisionIdentity(item.id, tx));
    expect(identity).toEqual({
      source: 'page',
      resolvable: true,
      pageId: page.id,
      versionId: publication.versionId,
      versionNumber: publication.versionNumber,
      title: 'Page model',
    });
    const [gate] = await adminDb.approvalGate.findMany({ where: { workItemId: item.id } });
    const version = await withWorkspaceContext(fx.ctx, async (tx) =>
      decisionApprovalGateHandler.subjectVersion({
        gate: gate!,
        ctx: fx.ctx,
        tx,
        resolvedStatusKey: null,
      } as never),
    );
    expect(version).toBe(pageDecisionSubjectVersion(page.id, publication.versionId));
  });

  it('a card with BOTH a captured file and a publication resolves to the page', async () => {
    const item = await decisionCard([ONE]);
    const { page } = await publishedPage(item.id);
    const identity = await withWorkspaceContext(fx.ctx, (tx) => loadDecisionIdentity(item.id, tx));
    expect(identity).toMatchObject({ source: 'page', pageId: page.id });
  });

  it('a page decision with no pull request holds no merge; with one open it holds until approved', async () => {
    const lone = await decisionCard([]);
    await publishedPage(lone.id);
    const delivered = await decisionCard([ONE]);
    await publishedPage(delivered.id);
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(
        await decisionHoldsMerge({ ...lone, type: 'decision', executor: 'coding_agent' }, tx),
      ).toBe(false);
      expect(
        await decisionHoldsMerge({ ...delivered, type: 'decision', executor: 'coding_agent' }, tx),
      ).toBe(true);
    });
  });
});

describe('the gate set', () => {
  it('a page decision with no pull request is a lone primary gate, with no merge gate to carry', async () => {
    const item = await decisionCard([]);
    const { page, publication } = await publishedPage(item.id);
    const row = await itemRow(item.id);
    const set = await withWorkspaceContext(fx.ctx, (tx) => gateSetFor(row, tx));
    expect(set.awaited).toEqual([
      {
        kind: 'decision_approval',
        subjectId: item.id,
        subjectVersion: pageDecisionSubjectVersion(page.id, publication.versionId),
      },
    ]);
    expect(set.primary).toBe('decision_approval');
  });
});

describe('the decision — Approve freezes, nothing else does', () => {
  const awaitingOn = async (itemId: string) =>
    await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: itemId, kind: 'decision_approval', state: 'awaiting' },
    });

  it('Approve with no pull request freezes the version under the gate and writes done', async () => {
    const item = await decisionCard([]);
    const { publication, page } = await publishedPage(item.id);
    const gate = await awaitingOn(item.id);

    // Its `done` is announced after the commit (Bug MOTIR-9415).
    const { result, hops } = await expectEachHopAnnounced(
      item.id,
      { workspaceId: fx.workspaceId, actorId: fx.ctx.userId },
      () => decide(gate.id, 'approve'),
    );
    expect(hops.map((hop) => hop.toStatusKey)).toEqual(['done']);

    const frozen = await versionRow(publication.versionId);
    expect(frozen.frozenAt).not.toBeNull();
    expect(frozen.frozenByGateId).toBe(gate.id);
    expect(result.effect.statusWritten).toBe('done');
    expect((await itemRow(item.id)).status).toBe('done');
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } })).subjectVersion,
    ).toBe(pageDecisionSubjectVersion(page.id, publication.versionId));
  });

  it('Approve with a pull request ALSO open freezes and writes no status — the merge writes done', async () => {
    const item = await decisionCard([ONE]);
    const { publication } = await publishedPage(item.id);
    const gate = await awaitingOn(item.id);
    const before = (await itemRow(item.id)).status;

    // `merge_writes_done` moves nothing, so it announces nothing.
    const { result, hops } = await expectEachHopAnnounced(
      item.id,
      { workspaceId: fx.workspaceId, actorId: fx.ctx.userId },
      () => decide(gate.id, 'approve'),
    );
    expect(hops).toEqual([]);

    expect((await versionRow(publication.versionId)).frozenAt).not.toBeNull();
    expect(result.effect.statusWritten).toBeNull();
    expect((await itemRow(item.id)).status).toBe(before);
  });

  it('Request changes leaves the version sealed, not frozen', async () => {
    const item = await decisionCard([]);
    const { publication } = await publishedPage(item.id);
    await decide((await awaitingOn(item.id)).id, 'request_changes');
    const row = await versionRow(publication.versionId);
    expect(row.sealedAt).not.toBeNull();
    expect(row.frozenAt).toBeNull();
  });

  it('a republish supersedes, and the old version stays sealed, not frozen', async () => {
    const item = await decisionCard([]);
    const { publication, page } = await publishedPage(item.id);
    const current = await pagesService.getPageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
    });
    await pagesService.savePageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
      markdown: '# Page model\n\nA forest of pages.',
      expectedRevision: current.revision,
    });
    await decisionPageService.publish({ workItemId: item.id, pageId: page.id }, fx.ctx);
    const old = await versionRow(publication.versionId);
    expect(old.sealedAt).not.toBeNull();
    expect(old.frozenAt).toBeNull();
  });

  it('a withdraw freezes nothing', async () => {
    const item = await decisionCard([]);
    const { publication } = await publishedPage(item.id);
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.supersedeAllAwaitingByWorkItem(item.id, 'pulled_back', tx),
    );
    expect((await versionRow(publication.versionId)).frozenAt).toBeNull();
  });
});

describe('the second resolver changes only what a person reads', () => {
  it('reads the published version through the page resolver, and a fake page resolver changes nothing about the gate', async () => {
    async function behaviour() {
      const item = await decisionCard([]);
      const { publication } = await publishedPage(item.id);
      const read = await decisionDocumentService.readForWorkItem(item.id, fx.ctx);
      const gate = await adminDb.approvalGate.findFirstOrThrow({
        where: { workItemId: item.id, kind: 'decision_approval', state: 'awaiting' },
      });
      const result = await decide(gate.id, 'approve');
      return {
        read,
        statusWritten: result.effect.statusWritten,
        frozen: (await versionRow(publication.versionId)).frozenAt !== null,
      };
    }

    const real = await behaviour();
    expect(real.read.content).toMatchObject({
      outcome: 'page',
      markdown: '# Page model\n\nA tree of pages.',
    });

    restorePageResolver = setPageDecisionDocumentResolver({
      async resolve() {
        return { outcome: 'unresolvable', reason: 'host_unreachable' };
      },
    });
    const faked = await behaviour();
    expect(faked.read.content).toEqual({ outcome: 'unresolvable', reason: 'host_unreachable' });
    expect({ statusWritten: faked.statusWritten, frozen: faked.frozen }).toEqual({
      statusWritten: real.statusWritten,
      frozen: real.frozen,
    });
  });
});

describe('a save racing an approve', () => {
  it('never extends the frozen version, whichever lands first', async () => {
    for (let round = 0; round < 8; round += 1) {
      const item = await decisionCard([]);
      const { publication, page } = await publishedPage(
        item.id,
        `# Round ${round}\n\napproved text`,
      );
      const gate = await adminDb.approvalGate.findFirstOrThrow({
        where: { workItemId: item.id, kind: 'decision_approval', state: 'awaiting' },
      });
      const current = await pagesService.getPageMarkdown(fx.ctx, {
        projectId: fx.projectId,
        pageId: page.id,
      });
      await Promise.all([
        decide(gate.id, 'approve'),
        pagesService
          .savePageMarkdown(fx.ctx, {
            projectId: fx.projectId,
            pageId: page.id,
            markdown: `# Round ${round}\n\nracing edit`,
            expectedRevision: current.revision,
          })
          .catch(() => null),
      ]);
      const frozen = await versionRow(publication.versionId);
      expect(frozen.frozenAt).not.toBeNull();
      expect(frozen.bodyMarkdown).toContain('approved text');
      expect(frozen.bodyMarkdown).not.toContain('racing edit');
    }
  });
});

describe('what the port and the page History draw (MOTIR-7436)', () => {
  async function saveOver(pageId: string, markdown: string) {
    const current = await pagesService.getPageMarkdown(fx.ctx, { projectId: fx.projectId, pageId });
    await pagesService.savePageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId,
      markdown,
      expectedRevision: current.revision,
    });
  }
  const awaitingGate = (itemId: string) =>
    adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: itemId, kind: 'decision_approval', state: 'awaiting' },
    });
  const tagOf = async (pageId: string, versionNumber: number) =>
    (await pagesService.listPageVersions(fx.ctx, { projectId: fx.projectId, pageId })).items.find(
      (v) => v.number === versionNumber,
    )?.decisionTag;

  it('the read names the author and the save, then the freeze and the change after it', async () => {
    const item = await decisionCard([]);
    const { page, publication } = await publishedPage(item.id);

    const before = await decisionDocumentService.readForWorkItem(item.id, fx.ctx);
    expect(before.content).toMatchObject({
      outcome: 'page',
      frozen: false,
      latestVersionNumber: publication.versionNumber,
    });
    expect(before.content?.outcome === 'page' && before.content.savedAt).toBeTruthy();
    const beforeDto = toDecisionDocumentViewDTO(before);
    expect(beforeDto).toMatchObject({
      outcome: 'page',
      changedSince: false,
      versionUrl: `/pages/${page.id}?version=${publication.versionNumber}`,
    });

    await decide((await awaitingGate(item.id)).id, 'approve');
    await saveOver(page.id, '# Page model\n\nEdited after the approval.');

    const after = await decisionDocumentService.readForWorkItem(item.id, fx.ctx);
    expect(after.content).toMatchObject({
      outcome: 'page',
      versionNumber: publication.versionNumber,
      frozen: true,
      latestVersionNumber: publication.versionNumber + 1,
      markdown: '# Page model\n\nA tree of pages.',
    });
    expect(toDecisionDocumentViewDTO(after)).toMatchObject({ frozen: true, changedSince: true });
  });

  it('History tags the version published, then frozen, naming the card', async () => {
    const item = await decisionCard([]);
    const { page, publication } = await publishedPage(item.id);
    expect(await tagOf(page.id, publication.versionNumber)).toEqual({
      kind: 'published',
      key: item.identifier,
    });

    await decide((await awaitingGate(item.id)).id, 'approve');
    expect(await tagOf(page.id, publication.versionNumber)).toEqual({
      kind: 'frozen',
      key: item.identifier,
    });
  });

  it('an unpublished version carries no tag', async () => {
    const page = await pagesService.createPageFromMarkdown(fx.ctx, {
      projectId: fx.projectId,
      title: 'Plain',
      markdown: '# Plain',
    });
    const list = await pagesService.listPageVersions(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
    });
    expect(list.items.map((v) => v.decisionTag)).toEqual([null]);
  });

  it('the To approve row names the page and the version asked about', async () => {
    const item = await decisionCard([ONE]);
    const { publication } = await publishedPage(item.id);
    const gate = await awaitingGate(item.id);
    const summaries = await withWorkspaceContext(fx.ctx, (tx) =>
      summarizeGateSubjects([{ id: gate.id, kind: gate.kind, subjectId: gate.subjectId }], tx),
    );
    expect(summaries.get(gate.id)).toMatchObject({
      kind: 'decision_approval',
      outcome: 'page',
      title: 'Page model',
      versionNumber: publication.versionNumber,
    });
  });
});

describe('the production page read', () => {
  it('answers a version row that is gone with gone_at_head', async () => {
    const production = setPageDecisionDocumentResolver({
      async resolve() {
        throw new Error('placeholder');
      },
    });
    setPageDecisionDocumentResolver(production);
    const content = await production.resolve(
      {
        source: 'page',
        resolvable: true,
        pageId: 'no-such-page',
        versionId: 'no-such-version',
        versionNumber: 1,
        title: 'Gone',
      },
      fx.ctx,
    );
    expect(content).toEqual({ outcome: 'unresolvable', reason: 'gone_at_head' });
  });
});
