import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A STORY RUN'S ACCEPTANCE CARRIES ITS DELIVERY SET'S REVIEW PATH (Bug MOTIR-10533;
// `design/github/design-notes.md` § 32.4), against a REAL Postgres. The acceptance gate
// leads the Development frame while it awaits and ONE press on it merges the story's pull
// requests (`approval-gates.md` §1, the MOTIR-5787 amendment), so its read, its To approve
// row and its Approvals room row are owed the same review line the approve-and-merge gate
// carries — read at the CURRENT delivery-set version. What a plausible wrong fix passes,
// pinned hardest:
//   - a line read at the acceptance gate's own version (its RECORDING), which names no
//     commits and so is never a delivery set;
//   - a line on an acceptance whose story has no pull requests.

vi.mock('@/lib/blob/uploader', () => {
  let n = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({ url: `https://blob.example/${p}-${++n}` })),
    putPrivateAttachment: vi.fn(async (p: string) => ({ pathname: `${p}-${++n}` })),
    signedDownloadUrl: vi.fn(async (p: string) => `https://blob.example/signed/${p}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');

const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';
const SET_VERSION = `acme/api#12@${HEAD_API},acme/web#7@${HEAD_WEB}`;
const video = () => new File([new Uint8Array(1024)], 'run.webm', { type: 'video/webm' });

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  // The suite's truncate order (MOTIR-3066; `tests/truncate-lock-order.test.ts`).
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "approval_gate" RESTART IDENTITY CASCADE',
  );
  fx = await makeWorkItemFixture();
  await adminDb.project.update({ where: { id: fx.projectId }, data: { prMergeMode: 'manual' } });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function storyInReview(title: string) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  return story;
}

/** A STORY in review whose own run delivered `acme/web#7` and `acme/api#12`, both green. */
async function storyRun() {
  const story = await storyInReview('Accept a story from its recording');
  for (const [name, number, head] of [
    ['web', 7, HEAD_WEB],
    ['api', 12, HEAD_API],
  ] as const) {
    seq += 1;
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-10533-${seq}`,
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
        repoId: `repo-10533-${seq}`,
        owner: 'acme',
        name,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number,
        title: `Change in ${name}`,
        state: 'open',
        headRef: 'parent/ACME-20-acceptance',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: story.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: head, checkName: 'Vitest', conclusion: 'success' },
    });
  }
  return story;
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const homeCtx = () => ({ ...fx.ctx, projectId: fx.projectId });

describe('a story run’s acceptance reads its delivery set’s review path (MOTIR-10533)', () => {
  it('the gate read carries the review line at the DELIVERY SET’s version, never the recording’s', async () => {
    const story = await storyRun();
    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'c0ffee1' },
      fx.ctx,
    );
    const [acceptance, merge] = await gatesOf(story.id);
    expect([acceptance!.kind, merge!.kind]).toEqual(['acceptance_result', 'pull_request_approval']);
    expect(merge!.subjectVersion).toBe(SET_VERSION);

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: story.id, kind: 'acceptance_result' },
      fx.ctx,
    );
    expect(read.gate?.id).toBe(acceptance!.id);
    // The version the line is read at is the merge gate's, and is not the acceptance's own.
    expect(read.reviewPath?.currentVersion).toBe(SET_VERSION);
    expect(read.reviewPath?.currentVersion).not.toBe(read.gate?.subjectVersion);
    expect(read.reviewPath).toMatchObject({
      identifier: story.identifier,
      line: { value: 'not_reviewed', command: `motir review ${story.identifier}` },
      recordRef: null,
      viewerIsRouted: true,
      sentBackRecord: null,
    });

    // The same answer the approve-and-merge read gives for the same card.
    const mergeRead = await approvalGatesService.getForWorkItem(
      { workItemId: story.id, kind: 'pull_request_approval' },
      fx.ctx,
    );
    expect(read.reviewPath).toEqual(mergeRead.reviewPath);
  });

  it('a push moves the line to the new set — it follows the commits, not the receipt', async () => {
    const story = await storyRun();
    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'c0ffee1' },
      fx.ctx,
    );
    const moved = '2222222222222222222222222222222222222222';
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 12 } });
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: moved, checkName: 'Vitest', conclusion: 'success' },
    });
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: moved } });

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: story.id, kind: 'acceptance_result' },
      fx.ctx,
    );
    const mergeRead = await approvalGatesService.getForWorkItem(
      { workItemId: story.id, kind: 'pull_request_approval' },
      fx.ctx,
    );
    expect(read.reviewPath?.currentVersion).toBe(`acme/api#12@${moved},acme/web#7@${HEAD_WEB}`);
    expect(read.reviewPath?.currentVersion).toBe(mergeRead.reviewPath?.currentVersion);
    expect(read.reviewPath?.line?.value).toBe('not_reviewed');
  });

  it('To approve and the Approvals room carry the line on the acceptance row', async () => {
    const story = await storyRun();
    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'c0ffee1' },
      fx.ctx,
    );
    const [acceptance] = await gatesOf(story.id);

    const queue = await approvalGatesService.listAwaitingMe(homeCtx());
    const row = queue.items.find((r) => r.gateId === acceptance!.id);
    expect(row, 'the acceptance asks on To approve').toBeDefined();
    expect(row?.review).toMatchObject({
      line: { value: 'not_reviewed', command: `motir review ${story.identifier}` },
      recordRef: null,
      badge: null,
    });

    const room = await approvalGatesService.listRecords(homeCtx(), { limit: 50 });
    const roomRow = room.sections.awaiting.items.find((r) => r.gateId === acceptance!.id);
    expect(roomRow?.review?.line.value).toBe('not_reviewed');
  });

  it('an acceptance whose story has NO pull requests reads no line, on the read and on the row', async () => {
    const story = await storyInReview('Accept a story with no delivery');
    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'c0ffee1' },
      fx.ctx,
    );
    const gates = await gatesOf(story.id);
    expect(gates.map((g) => [g.kind, g.state])).toEqual([['acceptance_result', 'awaiting']]);

    const read = await approvalGatesService.getForWorkItem(
      { workItemId: story.id, kind: 'acceptance_result' },
      fx.ctx,
    );
    expect(read.gate?.id).toBe(gates[0]!.id);
    expect(read.reviewPath?.currentVersion ?? null).toBeNull();
    expect(read.reviewPath?.line ?? null).toBeNull();

    const queue = await approvalGatesService.listAwaitingMe(homeCtx());
    const row = queue.items.find((r) => r.gateId === gates[0]!.id);
    expect(row).toBeDefined();
    expect(row?.review ?? null).toBeNull();
  });

  it('a gate kind that does not stand in front of the merge pays nothing for it', async () => {
    const story = await storyRun();
    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: video(), commitSha: 'c0ffee1' },
      fx.ctx,
    );
    for (const kind of ['design_result', 'decision_approval', 'manual_work'] as const) {
      const read = await approvalGatesService.getForWorkItem(
        { workItemId: story.id, kind },
        fx.ctx,
      );
      expect(read.reviewPath ?? null, kind).toBeNull();
    }
  });
});
