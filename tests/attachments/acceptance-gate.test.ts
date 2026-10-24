import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced } from '../helpers/transitionedEvents';
import { linkPr } from '../helpers/prLink';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { AcceptanceEvidenceStoryClosedError } from '@/lib/acceptanceEvidence/errors';

// THE ACCEPTANCE GATE ON THE CONTRACT (Story MOTIR-4949 · Subtask MOTIR-4950;
// ADR `approval-gates.md` §1, the MOTIR-5787 amendment) against a REAL Postgres.
//
// This file replaced the suite for `acceptanceEvidenceService.decide`, which is
// retired: a story's receipt is now decided as an `acceptance_result` approval gate
// through the ONE decide door every kind uses. What is proved here:
//
//   · PLACEMENT (point 1) — a publish raises an `awaiting` gate on the STORY, whether
//     the publisher named the story or a LEAF under it, and the leaf holds none;
//   · SUPERSEDE (point 5) — a newer receipt retires the awaiting question with cause
//     `republished` and asks a fresh one about the new recording;
//   · THE EFFECT (point 7) — approval stamps the receipt, and writes `done` ONLY when
//     nothing under the story is left for the cascade to close: an open child, or an
//     open delivery of the story's own, leaves the status alone;
//   · THE FREEZE (point 6) — a receipt approved through the gate refuses a republish
//     exactly as it did through the old path.
//
// Blob is the one mocked external.

vi.mock('@/lib/blob/uploader', () => {
  let seq = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({
      url: `https://store1.public.blob.vercel-storage.com/${p}-${++seq}`,
    })),
    putPrivateAttachment: vi.fn(async (p: string) => ({ pathname: `${p}-${++seq}` })),
    signedDownloadUrl: vi.fn(async (p: string) => `https://blob.example/signed/${p}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { resolveAcceptanceStory } = await import('@/lib/acceptanceEvidence/publishAuth');
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const video = () => new File([new Uint8Array(1024)], 'run.webm', { type: 'video/webm' });

let fx: WorkItemFixture;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment", "approval_gate" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeStory(status: 'todo' | 'in_progress' | 'in_review' = 'in_review') {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Accepted story' },
    fx.ctx,
  );
  if (status !== 'todo') await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  if (status === 'in_review') await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  return story;
}

async function makeChild(storyId: string, title = 'E2E + acceptance video') {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title, parentId: storyId },
    fx.ctx,
  );
}

async function publish(storyId: string, commitSha?: string) {
  return acceptanceEvidenceService.recordFromUpload(
    { workItemId: storyId, video: video(), commitSha },
    fx.ctx,
  );
}

const gatesOn = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'acceptance_result' },
    orderBy: { createdAt: 'asc' },
  });

const awaitingGate = async (workItemId: string) =>
  adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId, kind: 'acceptance_result', state: 'awaiting' },
  });

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

const decide = (gateId: string, decision: 'approve' | 'request_changes') =>
  approvalGatesService.decide(
    {
      gateId,
      decision,
      noteMd: decision === 'request_changes' ? 'Needs changes.' : null,
      source: 'ui',
      stamp: DECIDED_WITHOUT_A_READER,
    },
    fx.ctx,
  );

describe('placement — the gate hangs on the STORY (point 1)', () => {
  it('a publish on the story raises ONE awaiting `acceptance_result` gate on the story, about this recording', async () => {
    const story = await makeStory();
    const evidence = await publish(story.id, 'a'.repeat(40));

    const gates = await gatesOn(story.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      state: 'awaiting',
      subjectId: evidence.id,
      subjectVersion: 'a'.repeat(40),
      // ADR §2 — `assigneeId ?? reporterId`, answered at creation. The story has no
      // assignee, so the reporter (the fixture's actor) is asked.
      routedToId: fx.ctx.userId,
    });
  });

  it('a publish addressed to a LEAF lands on its story, and the leaf holds no acceptance gate — the single-card-run shape', async () => {
    const story = await makeStory();
    const leaf = await makeChild(story.id);

    // The doors resolve a leaf key UP before anything is written; this is that hop.
    const target = await resolveAcceptanceStory(leaf.identifier, fx.ctx);
    if (target instanceof Response) throw new Error('the leaf did not resolve');
    expect(target.id).toBe(story.id);
    await publish(target.id);

    // The leaf is still open, so the story cannot finish and is asked nothing yet
    // (MOTIR-5903); the leaf never holds the question at all.
    expect(await gatesOn(story.id)).toHaveLength(0);
    expect(await gatesOn(leaf.id)).toHaveLength(0);

    // The leaf reaching `done` is what asks the story — with no further publish.
    await workItemsService.updateStatus(leaf.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(leaf.id, 'done', fx.ctx);
    expect(await gatesOn(story.id)).toHaveLength(1);
    expect(await gatesOn(leaf.id)).toHaveLength(0);
  });

  it('a newer recording SUPERSEDES the awaiting question with cause `republished` and asks about the new one (point 5)', async () => {
    const story = await makeStory();
    const first = await publish(story.id);
    const second = await publish(story.id);

    const gates = await gatesOn(story.id);
    expect(gates.map((g) => [g.subjectId, g.state, g.supersededCause])).toEqual([
      [first.id, 'superseded', 'republished'],
      [second.id, 'awaiting', null],
    ]);
  });
});

describe('the effect — approval writes `done` only when nothing is left for the cascade (point 7)', () => {
  it('a story with nothing under it: approval stamps the receipt and writes `done` — TERMINAL', async () => {
    const story = await makeStory('in_review');
    const evidence = await publish(story.id);
    const gate = await awaitingGate(story.id);

    // The `done` it writes is announced after the commit (Bug MOTIR-9415).
    const { result, hops } = await expectEachHopAnnounced(
      story.id,
      { workspaceId: fx.workspaceId, actorId: fx.ctx.userId },
      () => decide(gate.id, 'approve'),
    );
    expect(hops).toEqual([{ fromStatusKey: 'in_review', toStatusKey: 'done' }]);

    expect(result.effect).toEqual({ statusWritten: 'done' });
    expect(result.gate.state).toBe('approved');
    expect(await statusOf(story.id)).toBe('done');
    const receipt = await adminDb.acceptanceEvidence.findUniqueOrThrow({
      where: { id: evidence.id },
    });
    expect(receipt.status).toBe('approved');
    expect(receipt.approvedById).toBe(fx.ctx.userId);
  });

  it('a child filed AFTER the question was asked — the receipt is approved, the story does NOT move, and the child is untouched', async () => {
    // The question is asked only over a settled subtree (MOTIR-5903), so an open child
    // under an awaiting question is one that ARRIVED after it — a bug filed mid-review.
    const story = await makeStory('in_progress');
    await publish(story.id);
    const gate = await awaitingGate(story.id);
    const child = await makeChild(story.id);
    await workItemsService.updateStatus(child.id, 'in_progress', fx.ctx);

    const result = await decide(gate.id, 'approve');

    // Writing `done` here would have `childStatusCascadeService` close the child
    // whose work has not landed. The rollup writes `done` when it does.
    expect(result.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'rollup_writes_done',
    });
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(await statusOf(child.id)).toBe('in_progress');
    expect(result.gate.state).toBe('approved');
  });

  it('a story every child of which is DONE is terminal again: approval writes `done`', async () => {
    const story = await makeStory('in_review');
    const child = await makeChild(story.id);
    await workItemsService.updateStatus(child.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(child.id, 'done', fx.ctx);
    await publish(story.id);

    const result = await decide((await awaitingGate(story.id)).id, 'approve');

    expect(result.effect).toEqual({ statusWritten: 'done' });
    expect(await statusOf(story.id)).toBe('done');
  });

  it('a story with an OPEN delivery of its own — the story run: approval writes no status, the merge will', async () => {
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: `inst-${fx.workspaceId}`,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: `${fx.workspaceId}-0`,
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    const story = await makeStory('in_review');
    await linkPr(
      {
        workItemId: story.id,
        projectId: fx.projectId,
        owner: 'moooon',
        name: 'motir-core',
        number: 4949,
        headRef: 'parent/MOTIR-4949-acceptance-gate',
      },
      fx.ctx,
    );
    // The story run's question is asked once its set is GREEN (MOTIR-5903), and not before.
    await publish(story.id);
    expect(await gatesOn(story.id)).toHaveLength(0);
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 4949 } });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: 'e5'.repeat(20),
        checkName: 'Vitest',
        conclusion: 'success',
      },
    });
    await withWorkspaceContext(fx.ctx, async (tx) =>
      reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: story.id } }), tx),
    );

    const result = await decide((await awaitingGate(story.id)).id, 'approve');

    expect(result.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'merge_writes_done',
    });
    expect(await statusOf(story.id)).toBe('in_review');
  });

  it('REQUEST CHANGES stamps the receipt and moves nothing — the old path moved the story back to In progress, and no longer does', async () => {
    const story = await makeStory('in_review');
    const evidence = await publish(story.id);

    const result = await decide((await awaitingGate(story.id)).id, 'request_changes');

    expect(result.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'request_changes_moves_nothing',
    });
    expect(await statusOf(story.id)).toBe('in_review');
    const receipt = await adminDb.acceptanceEvidence.findUniqueOrThrow({
      where: { id: evidence.id },
    });
    expect(receipt.status).toBe('changes_requested');
    expect(receipt.approvedById).toBeNull();
  });
});

describe('an APPROVED receipt with no pull request closes the STORY (point 6; MOTIR-5872)', () => {
  it('a receipt approved through the gate closes the story, so a republish is refused and asks nothing new', async () => {
    const story = await makeStory('in_review');
    await publish(story.id);
    await decide((await awaitingGate(story.id)).id, 'approve');

    await expect(publish(story.id)).rejects.toBeInstanceOf(AcceptanceEvidenceStoryClosedError);
    // The refused publish rolled back with its supersede: the approved gate stands,
    // and no second question was raised.
    const gates = await gatesOn(story.id);
    expect(gates.map((g) => g.state)).toEqual(['approved']);
  });

  it('a PENDING receipt is what a fresh gate would ask about — `currentSubject` names it', async () => {
    const story = await makeStory('in_review');
    const evidence = await publish(story.id);
    const { acceptanceResultGateHandler } =
      await import('@/lib/approvalGates/acceptanceResultHandler');
    const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    const subject = await adminDb.$transaction((tx) =>
      acceptanceResultGateHandler.currentSubject({ item, ctx: fx.ctx, tx }),
    );
    expect(subject).toBe(evidence.id);
  });

  it('the gate never asks about an approved receipt again — `currentSubject` answers nothing once it is signed', async () => {
    const story = await makeStory('in_review');
    await publish(story.id);
    await decide((await awaitingGate(story.id)).id, 'approve');

    const { acceptanceResultGateHandler } =
      await import('@/lib/approvalGates/acceptanceResultHandler');
    const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    const subject = await adminDb.$transaction((tx) =>
      acceptanceResultGateHandler.currentSubject({ item, ctx: fx.ctx, tx }),
    );
    expect(subject).toBeNull();
  });
});

describe('the Approvals tab — the row names the recording', () => {
  it('an awaiting acceptance gate is decidable by its reporter and its subject summarises the recording', async () => {
    const story = await makeStory('in_review');
    const evidence = await publish(story.id, 'b'.repeat(40));

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: story.id, kind: 'acceptance_result' },
      fx.ctx,
    );
    expect(read.gate?.state).toBe('awaiting');
    expect(read.canDecide).toBe(true);

    const { summarizeGateSubjects } = await import('@/lib/approvalGates/subjectSummary');
    const gate = await awaitingGate(story.id);
    const summaries = await adminDb.$transaction((tx) => summarizeGateSubjects([gate], tx));
    expect(summaries.get(gate.id)).toEqual({
      kind: 'acceptance_result',
      acceptanceEvidenceId: evidence.id,
      producedByKey: null,
      commitSha: 'b'.repeat(40),
      chapterCount: 0,
    });
  });
});
