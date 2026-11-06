import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { ChangeRequestMergeability } from '@/lib/git/types';
import { jobServices } from '@/lib/jobs/services';
import {
  BASE_MOVED_RETRY_WAITS_MS,
  pullRequestBaseMoved,
} from '@/lib/jobs/definitions/pullRequestBaseMoved';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { pullRequestMergeabilityService } from '@/lib/services/pullRequestMergeabilityService';
import { workbenchWatermarkService } from '@/lib/services/workbenchWatermarkService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE BASE-BRANCH MERGEABILITY RE-READ (MOTIR-5914, for bug MOTIR-5907; design/github
// § 30 rules 1–2), against a REAL Postgres. A push to a repository's default branch
// re-reads every open delivering pull request that targets it; a member the host reports
// `dirty` withdraws the WHOLE awaiting approve-and-merge gate as `conflict` and holds the
// card at Implemented. The host is the seam's `readChangeRequestMergeability`, stubbed per
// pull request — the one thing that leaves the process (the real read, against the E2E
// merge mock, is `githubMergeMock.test.ts`'s).

const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';
const github = getGitProvider('github') as Required<GitProvider>;

let fx: WorkItemFixture;

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

/** A card in review delivered by `acme/app#7` and `acme/app#12` — ONE repository, both
 *  targeting `main`, both green — holding its ONE awaiting approve-and-merge gate. */
async function inReview(numbers: number[] = [7, 12]) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5914-${numbers.join('-')}`,
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
      repoId: `repo-5914-${numbers.join('-')}`,
      owner: 'acme',
      name: 'app',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const members: Record<number, { prId: string; version: string; head: string }> = {};
  for (const number of numbers) {
    const head = number === 7 ? HEAD_WEB : HEAD_API;
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number,
        title: `Change #${number}`,
        state: 'open',
        headRef: `parent/ACME-${number}`,
        baseRef: 'main',
        provider: 'github',
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
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: head, checkName: 'Vitest', conclusion: 'success' },
    });
    members[number] = { prId: pr.id, version: `acme/app#${number}@${head}`, head };
  }
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'pull_request_approval',
        subjectId: item.id,
        subjectVersion: numbers
          .map((n) => members[n]!.version)
          .sort()
          .join(','),
      },
      tx,
    ),
  );
  return { item, gate, repo, members };
}

/** Answer the host's mergeability read per pull request number — a SEQUENCE per number,
 *  consumed one read at a time, the last answer repeating. */
function stubHost(answers: Record<number, Array<Partial<ChangeRequestMergeability>>>) {
  const reads: number[] = [];
  const spy = vi.spyOn(github, 'readChangeRequestMergeability').mockImplementation(async (args) => {
    reads.push(args.number);
    const seq = answers[args.number] ?? [{ mergeable: true, mergeableState: 'clean' }];
    const seen = reads.filter((n) => n === args.number).length;
    const answer = seq[Math.min(seen - 1, seq.length - 1)]!;
    return { mergeable: null, mergeableState: null, headSha: null, ...answer };
  });
  return { spy, reads };
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const stored = async (prId: string) => {
  const row = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id: prId } });
  return [row.mergeableState, row.mergeableStateHeadSha];
};

/** Drive the job's own handler with a step API that executes steps and records sleeps. */
async function runJob(data: { workspaceId: string; repoId: string; baseRef: string }) {
  const slept: number[] = [];
  const ctx = {
    event: {
      name: 'pull-request/base-moved',
      data: { ...data, baseHeadSha: 'base-2', idempotencyKey: `${data.repoId}:base-2` },
    },
    attempt: 0,
    step: {
      run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
      sleep: async (_id: string, ms: number | string) => {
        slept.push(Number(ms));
      },
    },
  };
  const result = await (
    pullRequestBaseMoved.handler as unknown as (
      c: typeof ctx,
      s: typeof jobServices,
    ) => Promise<Record<string, number>>
  )(ctx, jobServices);
  return { result, slept };
}

describe('a push to the base withdraws the question over a member it put in conflict', () => {
  it('a `dirty` member: the WHOLE gate goes as `conflict`, the card holds at Implemented, and To approve drops it', async () => {
    const { item, gate, repo, members } = await inReview();
    expect(
      (await approvalGatesService.listAwaitingMe({ ...fx.ctx, projectId: fx.projectId })).items.map(
        (r) => r.gateId,
      ),
    ).toEqual([gate.id]);
    stubHost({
      7: [{ mergeable: false, mergeableState: 'dirty', headSha: members[7]!.head }],
      12: [{ mergeable: true, mergeableState: 'clean', headSha: members[12]!.head }],
    });

    const { result } = await runJob({
      workspaceId: fx.workspaceId,
      repoId: repo.id,
      baseRef: 'main',
    });

    expect(result).toMatchObject({
      members: 2,
      conflicted: 1,
      withdrawn: 1,
      held: 1,
      stillUnknown: 0,
    });
    const row = await gateRow(gate.id);
    expect([row.state, row.supersededCause]).toEqual(['superseded', 'conflict']);
    expect(await statusOf(item.id)).toBe('implemented');
    // The clean member's reading is stored as clean; the conflicted one as dirty AT ITS HEAD.
    expect(await stored(members[7]!.prId)).toEqual(['dirty', members[7]!.head]);
    expect(await stored(members[12]!.prId)).toEqual(['clean', members[12]!.head]);
    expect(
      (await approvalGatesService.listAwaitingMe({ ...fx.ctx, projectId: fx.projectId })).items,
    ).toEqual([]);
    // No fresh gate was raised over the set while a member stands `dirty`.
    expect(
      (await adminDb.approvalGate.findMany({ where: { workItemId: item.id, state: 'awaiting' } }))
        .length,
    ).toBe(0);
  });

  it('To approve LEARNS it live (§ 30 Panel 3): the watermark names the approvals tab and its count drops by one', async () => {
    // The held row is the shipped client half (MOTIR-5242): a row the re-read no longer
    // returns is HELD as *Decided elsewhere*, whatever removed it. What a `conflict`
    // withdrawal owes that chain is the NUDGE — the watermark the live stream compares —
    // and a withdrawal that moved no watermark would leave an open tab asking forever.
    const { repo, members } = await inReview();
    const reader = { ...fx.ctx, projectId: fx.projectId };
    const before = await workbenchWatermarkService.read(reader);
    // The watermark is a change detector, not the strip's count (MOTIR-10504): it counts the
    // one awaiting gate AND the review rows of the card it names — here its two deliveries.
    expect(before.tabs.approvals.count).toBe(3);
    stubHost({
      7: [{ mergeable: false, mergeableState: 'dirty', headSha: members[7]!.head }],
      12: [{ mergeable: true, mergeableState: 'clean', headSha: members[12]!.head }],
    });

    await runJob({ workspaceId: fx.workspaceId, repoId: repo.id, baseRef: 'main' });

    const after = await workbenchWatermarkService.read(reader, before.cursor);
    expect(after.moved).toContain('approvals');
    expect(after.tabs.approvals.count).toBe(0);
  });

  it('`mergeable: null` on EVERY retry leaves the gate awaiting and the card in review — after the bounded waits', async () => {
    const { item, gate, repo } = await inReview([7]);
    stubHost({ 7: [{ mergeable: null, mergeableState: 'unknown' }] });

    const { result, slept } = await runJob({
      workspaceId: fx.workspaceId,
      repoId: repo.id,
      baseRef: 'main',
    });

    expect(slept).toEqual([...BASE_MOVED_RETRY_WAITS_MS]);
    expect(result).toMatchObject({ conflicted: 0, withdrawn: 0, stillUnknown: 1 });
    expect((await gateRow(gate.id)).state).toBe('awaiting');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('`null` then `dirty` withdraws on the retry', async () => {
    const { item, gate, repo, members } = await inReview([7]);
    stubHost({
      7: [
        { mergeable: null, mergeableState: 'unknown' },
        { mergeable: false, mergeableState: 'dirty', headSha: members[7]!.head },
      ],
    });

    const { result, slept } = await runJob({
      workspaceId: fx.workspaceId,
      repoId: repo.id,
      baseRef: 'main',
    });

    expect(slept).toEqual([BASE_MOVED_RETRY_WAITS_MS[0]]);
    expect(result).toMatchObject({ conflicted: 1, withdrawn: 1, held: 1, stillUnknown: 0 });
    expect((await gateRow(gate.id)).supersededCause).toBe('conflict');
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('re-running for the same base head is a NO-OP — no second supersede, no status move', async () => {
    const { item, gate, repo, members } = await inReview([7]);
    stubHost({ 7: [{ mergeable: false, mergeableState: 'dirty', headSha: members[7]!.head }] });
    await runJob({ workspaceId: fx.workspaceId, repoId: repo.id, baseRef: 'main' });
    const after = await gateRow(gate.id);
    const revisions = await adminDb.workItemRevision.count({ where: { workItemId: item.id } });

    const { result } = await runJob({
      workspaceId: fx.workspaceId,
      repoId: repo.id,
      baseRef: 'main',
    });

    expect(result).toMatchObject({ conflicted: 1, withdrawn: 0, held: 0 });
    expect(await gateRow(gate.id)).toEqual(after);
    expect(await adminDb.workItemRevision.count({ where: { workItemId: item.id } })).toBe(
      revisions,
    );
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('only pull requests that TARGET the pushed branch are read', async () => {
    const { repo, members } = await inReview([7, 12]);
    await adminDb.githubPullRequest.update({
      where: { id: members[12]!.prId },
      data: { baseRef: 'release' },
    });
    const { reads } = stubHost({});

    await runJob({ workspaceId: fx.workspaceId, repoId: repo.id, baseRef: 'main' });

    expect(reads).toEqual([7]);
  });

  it('a host read that THROWS is counted and leaves the others settled', async () => {
    const { item, repo, members } = await inReview([7, 12]);
    vi.spyOn(github, 'readChangeRequestMergeability').mockImplementation(async (args) => {
      if (args.number === 7) throw new Error('host down');
      return { mergeable: false, mergeableState: 'dirty', headSha: members[12]!.head };
    });

    const { result } = await runJob({
      workspaceId: fx.workspaceId,
      repoId: repo.id,
      baseRef: 'main',
    });

    expect(result).toMatchObject({ failed: 1, conflicted: 1 });
    expect(await stored(members[7]!.prId)).toEqual([null, null]);
    expect(await statusOf(item.id)).toBe('implemented');
  });
});

describe('the withdrawal primitive is the ONE entry point', () => {
  it('a card NOT waiting on a person (pulled back to In Progress) is not moved, and ends asking nothing', async () => {
    const { item, members } = await inReview([7]);
    // Not `implemented`: a green card arriving there is promoted straight back to review
    // (`promoteIfCiAlreadyGreen`). In Progress is a status nobody is being asked in.
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);

    const settled = await pullRequestMergeabilityService.settleReading(
      fx.workspaceId,
      members[7]!.prId,
      { mergeable: false, mergeableState: 'dirty', headSha: members[7]!.head },
    );

    expect(settled.conflicted).toBe(true);
    expect(settled.moved).toEqual([]);
    expect(await statusOf(item.id)).toBe('in_progress');
    expect(
      await adminDb.approvalGate.count({ where: { workItemId: item.id, state: 'awaiting' } }),
    ).toBe(0);
  });

  it('a `null` reading stores nothing and withdraws nothing', async () => {
    const { item, gate, members } = await inReview([7]);

    const settled = await pullRequestMergeabilityService.settleReading(
      fx.workspaceId,
      members[7]!.prId,
      { mergeable: null, mergeableState: null, headSha: members[7]!.head },
    );

    expect(settled).toMatchObject({ conflicted: false, withdrawn: 0, moved: [] });
    expect(await stored(members[7]!.prId)).toEqual([null, null]);
    expect((await gateRow(gate.id)).state).toBe('awaiting');
    expect(await statusOf(item.id)).toBe('in_review');
  });
});
