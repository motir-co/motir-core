import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced } from '../helpers/transitionedEvents';

// A DESIGN SENT BACK GOES TO TO DO, on either verdict (Story MOTIR-6070 · Subtask
// MOTIR-6423; `docs/decisions/design-refusal-verdict.md` §1 and §2), against a REAL
// Postgres and through the real decide door.
//
// The load-bearing assertions:
//
//   · BOTH verdicts write the project's initial To-do status, and `outcomeRef` carries
//     its key on both — the verdict is what tells them apart, not the status.
//   · The deciding gate ends `changes_requested`, NEVER `superseded`: it is still
//     `awaiting` while the handler runs, so a withdrawal that did not exclude it would
//     supersede the decision being made.
//   · Every OTHER awaiting gate on the card — on Workflow B, the approve-to-merge gate —
//     is withdrawn as `pulled_back`, because the `{ system: true }` write the handler
//     makes skips the funnel's own pull-back rule.
//   · A GitHub-sourced refusal (no verdict) and a project with no initial todo-category
//     status write nothing and withdraw nothing.
//   · The card is claimable afterwards, and a republish raises a fresh question.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { DEFAULT_TRANSITIONS } = await import('@/lib/workflows/defaultWorkflow');
const { IllegalTransitionError } = await import('@/lib/workItems/errors');

let fx: WorkItemFixture;
let card: WorkItem;

const VERDICTS = ['revise', 're_plan'] as const;
/** A GitHub review synced into the door — the one source nobody pressed in Motir. */
const SYNCED = { synced: { reviewerGithubUserId: '999001', reviewerLogin: 'octo-reviewer' } };

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'A design question' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the frame' },
    fx.ctx,
  );
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Walk the card to `status` along the workflow's legal edges. */
async function moveTo(status: 'in_review' | 'implemented') {
  await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(card.id, status, fx.ctx);
}

async function publish(label: string) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, card.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  await ensureWorkWaitsOn(card.id, fx);
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [
        { kind: 'mock', sourcePath: `design/work-items/${label}.mock.html`, pathname },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: notePathname,
        },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
}

const designGateFor = (evidenceId: string) =>
  adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidenceId, kind: 'design_result' },
  });
const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

/**
 * WORKFLOW B — an OPEN linked pull request and the card's awaiting approve-to-merge gate
 * beside the design gate (`design-result.md` AMENDMENT 6).
 */
async function openPullRequestWithMergeGate() {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-6423-${card.id}`,
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
      repoId: `repo-6423-${card.id}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 7,
      title: 'draw the frame',
      state: 'open',
      headRef: 'design/frame',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: card.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: 'pull_request_approval',
        subjectId: card.id,
        subjectVersion: `acme/web#7@${shaFor('head')}`,
      },
      tx,
    ),
  );
}

const refuse = (gateId: string, refusalVerdict: (typeof VERDICTS)[number]) =>
  approvalGatesService.decide(
    {
      stamp: DECIDED_WITHOUT_A_READER,
      gateId,
      decision: 'request_changes',
      refusalVerdict,
      noteMd: 'The empty state is missing.',
      source: 'ui',
    },
    fx.ctx,
  );

describe('Workflow A — a design in review, sent back, goes to To do on EITHER verdict', () => {
  for (const verdict of VERDICTS) {
    it(`${verdict}: in_review → todo, with the history row and outcomeRef = todo`, async () => {
      await moveTo('in_review');
      const v1 = await publish('v1');
      const gate = await designGateFor(v1.id);

      // The return to To do is announced after the commit (Bug MOTIR-9415).
      const { result, hops } = await expectEachHopAnnounced(
        card.id,
        { workspaceId: fx.workspaceId, actorId: fx.ownerId },
        () => refuse(gate.id, verdict),
      );
      expect(hops).toEqual([{ fromStatusKey: 'in_review', toStatusKey: 'todo' }]);

      expect(result.effect).toEqual({ statusWritten: 'todo' });
      expect(result.gate).toMatchObject({
        state: 'changes_requested',
        outcomeRef: 'todo',
        refusalVerdict: verdict,
      });
      expect(await statusOf(card.id)).toBe('todo');

      // The card's history carries the move, written by the person who decided.
      const [latest] = await adminDb.workItemRevision.findMany({
        where: { workItemId: card.id },
        orderBy: { changedAt: 'desc' },
        take: 1,
      });
      expect(latest).toMatchObject({
        changedById: fx.ownerId,
        diff: { status: { from: 'in_review', to: 'todo' } },
      });

      // The deciding gate is decided, never withdrawn.
      const row = await gateRow(gate.id);
      expect(row).toMatchObject({
        state: 'changes_requested',
        supersededCause: null,
        outcomeRef: 'todo',
      });
    });
  }
});

describe('Workflow B — an open pull request: the merge gate is withdrawn as pulled_back', () => {
  for (const status of ['in_review', 'implemented'] as const) {
    for (const verdict of VERDICTS) {
      it(`${verdict} from ${status}: card → todo, merge gate superseded, design gate changes_requested`, async () => {
        await moveTo(status);
        const v1 = await publish('v1');
        const design = await designGateFor(v1.id);
        const merge = await openPullRequestWithMergeGate();

        const result = await refuse(design.id, verdict);

        expect(result.effect.statusWritten).toBe('todo');
        expect(result.gate.outcomeRef).toBe('todo');
        expect(await statusOf(card.id)).toBe('todo');
        expect(await gateRow(merge.id)).toMatchObject({
          state: 'superseded',
          supersededCause: 'pulled_back',
          decidedById: null,
        });
        expect(await gateRow(design.id)).toMatchObject({
          state: 'changes_requested',
          supersededCause: null,
          refusalVerdict: verdict,
        });
        // Nothing on the card is still waiting for a person.
        expect(
          await adminDb.approvalGate.count({ where: { workItemId: card.id, state: 'awaiting' } }),
        ).toBe(0);
      });
    }
  }
});

describe('what the refusal leaves alone', () => {
  it('a project with no INITIAL todo-category status: the refusal is recorded, nothing moves', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    const design = await designGateFor(v1.id);
    const merge = await openPullRequestWithMergeGate();
    // `todo` still exists, but the initial status now sits in another category.
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'todo' },
      data: { isInitial: false },
    });
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'in_progress' },
      data: { isInitial: true },
    });

    const result = await refuse(design.id, 'revise');

    expect(result.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'no_status_in_target_category',
    });
    expect(result.gate).toMatchObject({
      state: 'changes_requested',
      outcomeRef: null,
      refusalVerdict: 'revise',
    });
    expect(await statusOf(card.id)).toBe('in_review');
    expect((await gateRow(merge.id)).state).toBe('awaiting');
  });

  it('a GITHUB-sourced refusal (no verdict) writes no status and withdraws nothing', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    const design = await designGateFor(v1.id);
    const merge = await openPullRequestWithMergeGate();

    // Nothing moves, so nothing is announced.
    const { result, hops } = await expectEachHopAnnounced(
      card.id,
      { workspaceId: fx.workspaceId, actorId: fx.ownerId },
      () =>
        approvalGatesService.decide(
          {
            stamp: DECIDED_WITHOUT_A_READER,
            gateId: design.id,
            decision: 'request_changes',
            source: 'github',
            noteMd: null,
          },
          fx.ctx,
          SYNCED,
        ),
    );
    expect(hops).toEqual([]);

    expect(result.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'request_changes_moves_nothing',
    });
    expect(result.gate).toMatchObject({ state: 'changes_requested', outcomeRef: null });
    expect(await statusOf(card.id)).toBe('in_review');
    expect((await gateRow(merge.id)).state).toBe('awaiting');
  });

  it('a CLOSED card is asserted, not reopened — the decision rolls back whole', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    const design = await designGateFor(v1.id);
    // Unreachable through the doors (MOTIR-5552 closes the question); produced directly.
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    await expect(refuse(design.id, 'revise')).rejects.toThrow(/closed card/);

    expect(await statusOf(card.id)).toBe('done');
    expect(await gateRow(design.id)).toMatchObject({ state: 'awaiting', refusalVerdict: null });
  });

  it('adds no legal edge back to To do — a person still cannot move in_review → todo', async () => {
    for (const from of ['in_review', 'implemented', 'approved']) {
      expect(DEFAULT_TRANSITIONS.some(([a, b]) => a === from && b === 'todo')).toBe(false);
    }
    await moveTo('in_review');
    await expect(workItemsService.updateStatus(card.id, 'todo', fx.ctx)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });
});

describe('after the refusal — the card is work again', () => {
  for (const verdict of VERDICTS) {
    it(`${verdict}: the card can be claimed, and the run's republish raises a FRESH awaiting gate`, async () => {
      await moveTo('in_review');
      const v1 = await publish('v1');
      const v1Gate = await designGateFor(v1.id);
      await refuse(v1Gate.id, verdict);

      // The next run's first act: claim it off To do.
      const claim = await workItemsService.claimWorkItem(fx.projectId, card.identifier, fx.ctx);
      expect(claim.outcome).toBe('claimed');
      expect(await statusOf(card.id)).toBe('in_progress');

      // …and its revised publish asks the question again, over the new version.
      const v2 = await publish('v2');
      const fresh = await designGateFor(v2.id);
      expect(fresh.id).not.toBe(v1Gate.id);
      expect(fresh.state).toBe('awaiting');
      // The decided refusal stands as the record of what was sent back.
      expect((await gateRow(v1Gate.id)).state).toBe('changes_requested');
    });
  }
});

describe('approvalGateRepository.supersedeOtherAwaitingByWorkItem — the exclusion on its own', () => {
  it('withdraws every OTHER awaiting gate on the card, and touches nothing else', async () => {
    const other = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Another card' },
      fx.ctx,
    );
    const gate = (workItemId: string, kind: 'design_result' | 'pull_request_approval', s: string) =>
      adminDb.approvalGate.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId,
          kind,
          subjectId: s,
          subjectVersion: 'v1',
          state: 'awaiting',
        },
      });
    const deciding = await gate(card.id, 'design_result', 'evidence-1');
    const sibling = await gate(card.id, 'pull_request_approval', card.id);
    const olderQuestion = await gate(card.id, 'design_result', 'evidence-0');
    const decided = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: 'design_result',
        subjectId: 'evidence-old',
        subjectVersion: 'v0',
        state: 'changes_requested',
        decidedAt: new Date(),
        decidedById: fx.ownerId,
      },
    });
    const elsewhere = await gate(other.id, 'design_result', 'evidence-x');

    const count = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.supersedeOtherAwaitingByWorkItem(
        card.id,
        deciding.id,
        'pulled_back',
        tx,
      ),
    );

    expect(count).toBe(2);
    expect(await gateRow(deciding.id)).toMatchObject({ state: 'awaiting', supersededCause: null });
    for (const id of [sibling.id, olderQuestion.id]) {
      expect(await gateRow(id)).toMatchObject({
        state: 'superseded',
        supersededCause: 'pulled_back',
      });
    }
    expect((await gateRow(decided.id)).state).toBe('changes_requested');
    expect((await gateRow(elsewhere.id)).state).toBe('awaiting');
  });
});
