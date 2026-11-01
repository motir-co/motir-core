import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { usersService } from '@/lib/services/usersService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { warmPool } from '../helpers/warmPool';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// The REPAIR CLAIM (Story MOTIR-5460 · MOTIR-5464) — `POST
// /api/v1/work-items/{key}/repair`, over real Postgres.
//
// What is under test: ONE fixing agent at a time on an `implemented` card's red
// pull requests, a refusal for every case where a repair makes no sense, and —
// the property the whole design rests on — the card's status and assignee are
// never written. The race tests warm the pool first; on a cold pool the racers
// share one connection and pass with the lock missing.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function member(
  fx: WorkItemFixture,
  name: string,
): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `${name.toLowerCase().replace(/\W/g, '')}+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** An `implemented` task with ONE open, failing pull request. */
async function redCard(fx: WorkItemFixture, title = 'red card') {
  const card = await createTestWorkItem(fx, { kind: 'task', title });
  await setStatus(card.id, 'implemented');
  const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
  const pr = await deliveredPr(fx, card.id, repo, {
    headRef: 'subtask/red-card',
    baseRef: 'main',
    checks: { Vitest: 'failure', Lint: 'success' },
  });
  return { card, repo, pr };
}

const claim = (fx: WorkItemFixture, key: string, ctx: ServiceContext = fx.ctx) =>
  workItemRepairService.claimRepair(fx.projectId, key, ctx);

async function fixRuns(workItemId: string) {
  return adminDb.dispatchRun.findMany({
    where: { command: 'fix', cards: { some: { workItemId } } },
    orderBy: { startedAt: 'asc' },
  });
}

describe('claimRepair — the claim', () => {
  it('claims an implemented card with one failing PR, and writes neither status nor assignee', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await redCard(fx);
    // Settle the stored To fix reason the way the CI event would have in production
    // (the fixture writes the checks directly). Opening the repair run recomputes it
    // (MOTIR-6881), and an up-to-date card is left exactly as it was.
    await withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, (tx) =>
      recomputeWorkItemFixReason(card.id, tx),
    );
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(before.fixReason).toBe('ci_failed');

    const result = await claim(fx, card.identifier);

    expect(result).toMatchObject({
      key: card.identifier,
      title: 'red card',
      outcome: 'claimed',
      reason: null,
      runTargetKey: null,
      holder: { id: fx.ownerId },
    });
    expect(result.runId).toEqual(expect.any(String));
    expect(result.startedAt).toEqual(expect.any(String));
    expect(result.pullRequests).toEqual([
      {
        repo: `acme/${repo.name}`,
        number: pr.number,
        url: `https://github.com/acme/${repo.name}/pull/${pr.number}`,
        headRef: 'subtask/red-card',
        baseRef: 'main',
        ci: 'failing',
        failingChecks: ['Vitest'],
        queueExit: null,
        conflicted: false,
        outOfDate: false,
      },
    ]);

    // Read the row BACK: the repair is a run, not a status move.
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe('implemented');
    expect(after.assigneeId).toBe(before.assigneeId);
    expect(after.updatedAt).toEqual(before.updatedAt);
    // Still To fix while the repair runs: a running repair is not a repair made.
    expect(after.fixReason).toBe('ci_failed');

    const runs = await fixRuns(card.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: result.runId, status: 'running', createdById: fx.ownerId });
  });

  it('hands over only the failing OPEN pull requests, and ignores a merged one that is red', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo } = await redCard(fx);
    await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/green',
      checks: { Vitest: 'success' },
    });
    await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/merged-red',
      checks: { Vitest: 'failure' },
      state: 'closed',
      merged: true,
    });

    const result = await claim(fx, card.identifier);

    expect(result.outcome).toBe('claimed');
    expect(result.pullRequests.map((p) => p.headRef)).toEqual(['subtask/red-card']);
  });

  it('a pull request mirrored before base branches were recorded is handed over with a null base', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await redCard(fx);
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { baseRef: null } });

    const result = await claim(fx, card.identifier);

    expect(result.pullRequests[0]?.baseRef).toBeNull();
  });
});

describe('claimRepair — the refusals, in order', () => {
  // `in_review` left this list with MOTIR-5803: an In Review card the merge queue ejected
  // is claimed, and any other is `not_failing` (the IN REVIEW cases further down).
  it.each(['todo', 'in_progress', 'approved', 'done'])(
    'a card at `%s` is not_implemented',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const { card } = await redCard(fx);
      await setStatus(card.id, status);

      const result = await claim(fx, card.identifier);

      expect(result).toMatchObject({
        outcome: 'not_repairable',
        reason: 'not_implemented',
        runId: null,
        holder: null,
        startedAt: null,
        pullRequests: [],
      });
      expect(await fixRuns(card.id)).toHaveLength(0);
    },
  );

  it('an ARCHIVED implemented card is not_implemented', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    await adminDb.workItem.update({ where: { id: card.id }, data: { archivedAt: new Date() } });

    const result = await claim(fx, card.identifier);

    expect(result.reason).toBe('not_implemented');
    expect(await fixRuns(card.id)).toHaveLength(0);
  });

  it('a project with no status keyed `implemented` has nothing to repair, even on an in-progress-category card', async () => {
    // The rung is resolved by KEY, so a workflow without the status never reads a
    // plain in-progress card as implemented through the category fallback.
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    await setStatus(card.id, 'in_progress');
    await adminDb.workflowStatus.deleteMany({
      where: { projectId: fx.projectId, key: 'implemented' },
    });

    expect((await claim(fx, card.identifier)).reason).toBe('not_implemented');
  });

  it('a CHILD of a run target is repair_on_run_target, naming that target', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the run target' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'a child',
      parentId: story.id,
    });
    await setStatus(child.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    // The same pull request delivers the child as well as the story.
    await deliveredPr(fx, child.id, repo, { headRef: 'parent/x', checks: { Vitest: 'failure' } });
    await testInstructionsService.publish(
      {
        workItemId: story.id,
        bodyMd: '## Precondition\n\nSign in.',
        previewPath: null,
        repos: [{ repoId: repo.id, commitSha: 'c'.repeat(40) }],
      },
      fx.ctx,
    );

    const result = await claim(fx, child.identifier);

    expect(result).toMatchObject({
      outcome: 'not_repairable',
      reason: 'repair_on_run_target',
      runTargetKey: story.identifier,
      pullRequests: [],
    });
    expect(await fixRuns(child.id)).toHaveLength(0);
  });

  it('an implemented card with no deliveries is no_pull_requests', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'no PRs' });
    await setStatus(card.id, 'implemented');

    expect(await claim(fx, card.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'no_pull_requests',
    });
  });

  it('nothing failing and one member running is ci_running', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'running' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    await deliveredPr(fx, card.id, repo, { headRef: 'a', checks: { Vitest: 'pending' } });
    await deliveredPr(fx, card.id, repo, { headRef: 'b', checks: { Vitest: 'success' } });

    expect((await claim(fx, card.identifier)).reason).toBe('ci_running');
  });

  it('nothing failing and nothing running is not_failing — passing, no CI at all, or red only on a closed PR', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'green' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    await deliveredPr(fx, card.id, repo, { headRef: 'a', checks: { Vitest: 'success' } });
    await deliveredPr(fx, card.id, repo, { headRef: 'b' });
    await deliveredPr(fx, card.id, repo, {
      headRef: 'c',
      checks: { Vitest: 'failure' },
      state: 'closed',
    });

    expect((await claim(fx, card.identifier)).reason).toBe('not_failing');
    expect(await fixRuns(card.id)).toHaveLength(0);
  });
});

describe('claimRepair — who holds it', () => {
  it('a second person is refused as taken, naming the holder and the start, and handed nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const first = await claim(fx, card.identifier);
    const rival = await member(fx, 'Rival Runner');

    const second = await claim(fx, card.identifier, rival.ctx);

    expect(second).toMatchObject({
      outcome: 'taken',
      reason: null,
      runId: first.runId,
      holder: { id: fx.ownerId, name: fx.owner.name },
      startedAt: first.startedAt,
      pullRequests: [],
    });
    expect(await fixRuns(card.id)).toHaveLength(1);
  });

  it('the holder claiming again is mine, with the same run and the branches again', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const first = await claim(fx, card.identifier);

    const again = await claim(fx, card.identifier);

    expect(again.outcome).toBe('mine');
    expect(again.runId).toBe(first.runId);
    expect(again.pullRequests).toEqual(first.pullRequests);
    expect(await fixRuns(card.id)).toHaveLength(1);
  });

  it('once the run is closed, a new claim opens a NEW run', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const first = await claim(fx, card.identifier);
    await dispatchRunService.close(first.runId!, { stopReason: 'halted' }, fx.ctx);

    const next = await claim(fx, card.identifier);

    expect(next.outcome).toBe('claimed');
    expect(next.runId).not.toBe(first.runId);
    expect(await fixRuns(card.id)).toHaveLength(2);
  });

  it('the refusal order holds for a held repair too: a card that left `implemented` is not_implemented, not taken', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    await claim(fx, card.identifier);
    // `done`, not `in_review`: an In Review card is now evaluated for an ejection
    // (MOTIR-5803), so it is no longer the status that left the repairable rungs.
    await setStatus(card.id, 'done');
    const rival = await member(fx, 'Rival Runner');

    expect((await claim(fx, card.identifier, rival.ctx)).reason).toBe('not_implemented');
  });
});

describe('claimRepair — real concurrency (warm pool)', () => {
  it('N genuinely concurrent claims on one card yield EXACTLY ONE run', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const racers = await Promise.all(Array.from({ length: 5 }, (_, i) => member(fx, `Racer ${i}`)));
    const contexts = [fx.ctx, ...racers.map((r) => r.ctx)];

    await warmPool(contexts.length + 2);
    const results = await Promise.all(contexts.map((ctx) => claim(fx, card.identifier, ctx)));

    const winners = results.filter((r) => r.outcome === 'claimed');
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'taken')).toHaveLength(contexts.length - 1);
    for (const loser of results.filter((r) => r.outcome === 'taken')) {
      expect(loser.runId).toBe(winners[0]!.runId);
      expect(loser.holder?.id).toBe(winners[0]!.holder?.id);
    }
    expect(await fixRuns(card.id)).toHaveLength(1);
  });

  it('the SAME caller racing itself resolves to one claimed and one mine', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);

    await warmPool();
    const results = await Promise.all([claim(fx, card.identifier), claim(fx, card.identifier)]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['claimed', 'mine']);
    expect(await fixRuns(card.id)).toHaveLength(1);
  });
});

describe('claimRepair — access', () => {
  it('a key in another workspace is not found, and nothing is opened', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await makeWorkItemFixture({ name: 'Rival Co', identifier: 'ZZZ' });
    const { card } = await redCard(fx);

    await expect(claim(fx, card.identifier, outsider.ctx)).rejects.toMatchObject({
      code: 'WORK_ITEM_NOT_FOUND',
    });
    expect(await fixRuns(card.id)).toHaveLength(0);
  });

  it('a member who may browse the project but not edit it is refused, and nothing is opened', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const reader = await member(fx, 'Read Only');
    const role = await createCustomRoleAs({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: 'Browse only',
      permissions: ['project:browse'],
    });
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: reader.user.id,
      role: 'member',
    });
    await setProjectRoleAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: reader.user.id,
      role: role.id,
    });
    // The reader CAN see the card — the refusal below is the edit gate, not tenancy.
    await expect(
      workItemsService.getWorkItemByIdentifier(fx.projectId, card.identifier, reader.ctx),
    ).resolves.toMatchObject({ id: card.id });

    await expect(claim(fx, card.identifier, reader.ctx)).rejects.toMatchObject({
      code: expect.stringMatching(/DENIED/),
    });
    expect(await fixRuns(card.id)).toHaveLength(0);
  });
});

// ── The Development block's read (MOTIR-5466) ─────────────────────────────────
// The SAME evaluation as the claim, without a lock and without opening anything.
describe('getRepairView — what the Development block draws', () => {
  const view = (fx: WorkItemFixture, id: string, ctx: ServiceContext = fx.ctx) =>
    workItemRepairService.getRepairView(id, ctx);

  it('offers the command on a red implemented card, and opens nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await redCard(fx);

    expect(await view(fx, card.id)).toEqual({
      state: 'offer',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [
        {
          repo: `acme/${repo.name}`,
          number: pr.number,
          ci: 'failing',
          queueExit: null,
          conflict: null,
          outOfDate: null,
        },
      ],
      lastGaveUp: null,
    });
    expect(await fixRuns(card.id)).toHaveLength(0);
  });

  it('is hidden wherever the claim would refuse: running, passing, no CI, no PR, not implemented, green in review', async () => {
    const fx = await makeWorkItemFixture();
    const repo = await connectRepairRepo(fx, 'web');
    const make = async (
      title: string,
      status: string,
      checks?: Record<string, 'success' | 'failure' | 'pending'>,
    ) => {
      const card = await createTestWorkItem(fx, { kind: 'task', title });
      await setStatus(card.id, status);
      if (checks !== undefined) await deliveredPr(fx, card.id, repo, { headRef: title, checks });
      return card;
    };
    const running = await make('running', 'implemented', { Vitest: 'pending' });
    const passing = await make('passing', 'implemented', { Vitest: 'success' });
    const noCi = await make('no-ci', 'implemented', {});
    const noPr = await make('no-pr', 'implemented');
    // A RED In Review card is offered since MOTIR-7491 — see the IN REVIEW block below.
    const notStarted = await make('not-started', 'in_progress', { Vitest: 'failure' });
    const inReview = await make('in-review', 'in_review', { Vitest: 'success' });

    for (const card of [running, passing, noCi, noPr, notStarted, inReview]) {
      expect(await view(fx, card.id), card.title).toEqual({ state: 'hidden' });
    }
  });

  it('names who is fixing it once a repair is claimed — "you" for the holder', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const claimed = await claim(fx, card.identifier);
    const rival = await member(fx, 'Rival Runner');

    expect(await view(fx, card.id)).toMatchObject({
      state: 'in_progress',
      holder: { id: fx.ownerId },
      byViewer: true,
      startedAt: claimed.startedAt,
    });
    expect(await view(fx, card.id, rival.ctx)).toMatchObject({
      state: 'in_progress',
      byViewer: false,
    });
  });

  it('a repair that GAVE UP is offered again with the attempt count its event reported', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const claimed = await claim(fx, card.identifier);
    await dispatchRunService.appendEvents(
      claimed.runId!,
      [
        {
          kind: 'ci_gave_up',
          workItemKey: card.identifier,
          data: { kind: 'gave_up', attempts: 5 },
        },
      ],
      fx.ctx,
    );
    await dispatchRunService.close(claimed.runId!, { stopReason: 'halted' }, fx.ctx);

    const result = await view(fx, card.id);
    expect(result).toMatchObject({ state: 'offer', lastGaveUp: { attempts: 5 } });
    expect(result.state === 'offer' && result.lastGaveUp?.endedAt).toEqual(expect.any(String));
  });

  it('a give-up with no count event, and a STOPPED repair, draw what they should', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const first = await claim(fx, card.identifier);
    await dispatchRunService.close(first.runId!, { stopReason: 'halted' }, fx.ctx);
    expect(await view(fx, card.id)).toMatchObject({ lastGaveUp: { attempts: null } });

    // A stopped (interrupted) repair is neither running nor a give-up: plain F1.
    const second = await claim(fx, card.identifier);
    await dispatchRunService.close(second.runId!, { stopReason: 'interrupted' }, fx.ctx);
    expect(await view(fx, card.id)).toMatchObject({ state: 'offer', lastGaveUp: null });
  });

  it('a CHILD with a red pull request of its own points at its run target; without one it is hidden', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the run target' });
    const red = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'red child',
      parentId: story.id,
    });
    const quiet = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'quiet child',
      parentId: story.id,
    });
    await setStatus(red.id, 'implemented');
    await setStatus(quiet.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    const pr = await deliveredPr(fx, red.id, repo, {
      headRef: 'parent/x',
      checks: { Vitest: 'failure' },
    });
    await testInstructionsService.publish(
      {
        workItemId: story.id,
        bodyMd: '## Precondition\n\nSign in.',
        previewPath: null,
        repos: [{ repoId: repo.id, commitSha: 'c'.repeat(40) }],
      },
      fx.ctx,
    );

    expect(await view(fx, red.id)).toEqual({
      state: 'pointer',
      failing: [
        {
          repo: 'acme/web',
          number: pr.number,
          ci: 'failing',
          queueExit: null,
          conflict: null,
          outOfDate: null,
        },
      ],
      runTargetKey: story.identifier,
    });
    expect(await view(fx, quiet.id)).toEqual({ state: 'hidden' });
  });

  it('is refused for a card the caller cannot see, and for an id that does not exist', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await makeWorkItemFixture({ name: 'Rival Co', identifier: 'ZZZ' });
    const { card } = await redCard(fx);

    await expect(view(fx, card.id, outsider.ctx)).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND/),
    });
    await expect(view(fx, 'cm-no-such-item')).rejects.toMatchObject({
      code: 'WORK_ITEM_NOT_FOUND',
    });
  });
});

describe('getRepairView — what a malformed give-up record still says', () => {
  it('an attempts field that is not a whole number reads as no count, and a missing end reads as the start', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await redCard(fx);
    const claimed = await claim(fx, card.identifier);
    await dispatchRunService.appendEvents(
      claimed.runId!,
      [{ kind: 'ci_gave_up', workItemKey: card.identifier, data: { attempts: '5' } }],
      fx.ctx,
    );
    await dispatchRunService.close(claimed.runId!, { stopReason: 'halted' }, fx.ctx);
    // A failed row with no end time is not something `close` writes; a record
    // imported or repaired by hand can carry one, and the page must still render.
    const run = await adminDb.dispatchRun.update({
      where: { id: claimed.runId! },
      data: { endedAt: null },
    });

    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toMatchObject({
      state: 'offer',
      lastGaveUp: { attempts: null, endedAt: run.startedAt.toISOString() },
    });
  });
});

// ── AN EJECTED CARD IS REPAIRABLE (Story MOTIR-5628 · MOTIR-5719) ───────────────
//
// The merge queue failed on the pull request's MERGE GROUP, so its own checks are
// green; the claim refused it `not_failing` and `motir fix` could not take it. A
// standing failure exit at the head now makes the member failing — through the
// fold's own rule (`queueExitHoldsAtHead` via `standingQueueFailures`) — and the
// claim names the queue's reason and check.

describe('claimRepair — a standing merge-queue failure (MOTIR-5719)', () => {
  const HEAD = 'c'.repeat(40);

  async function exitOn(
    pullRequestId: string,
    opts: {
      rawReason?: string;
      disposition?: 'failure' | 'neutral';
      headSha?: string;
      requeuedAt?: Date | null;
      failingCheckName?: string | null;
      failingCheckUrl?: string | null;
    } = {},
  ) {
    return adminDb.githubPullRequestQueueExit.create({
      data: {
        pullRequestId,
        deliveryId: `guid-${randomToken(8)}`,
        rawReason: opts.rawReason ?? 'CI_FAILURE',
        disposition: opts.disposition ?? 'failure',
        headSha: opts.headSha ?? HEAD,
        exitedAt: new Date('2026-09-18T10:00:00.000Z'),
        requeuedAt: opts.requeuedAt ?? null,
        failingCheckName:
          opts.failingCheckName === undefined ? 'Merge queue / e2e' : opts.failingCheckName,
        failingCheckUrl:
          opts.failingCheckUrl === undefined
            ? 'https://github.com/acme/web/runs/77'
            : opts.failingCheckUrl,
      },
    });
  }

  /** An `implemented` card whose ONLY open pull request is GREEN on its own checks. */
  async function greenCard(fx: WorkItemFixture) {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'ejected card' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/ejected',
      checks: { Vitest: 'success' },
    });
    return { card, repo, pr };
  }

  it('claims an ejected card whose own checks are green, and names the exit', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await exitOn(pr.id);

    const result = await claim(fx, card.identifier);

    expect(result.outcome).toBe('claimed');
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: pr.number,
        ci: 'passing',
        failingChecks: [],
        queueExit: {
          rawReason: 'CI_FAILURE',
          disposition: 'failure',
          exitedAt: '2026-09-18T10:00:00.000Z',
          headSha: HEAD,
          failingCheckName: 'Merge queue / e2e',
          failingCheckUrl: 'https://github.com/acme/web/runs/77',
        },
      }),
    ]);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'implemented',
    );
  });

  it('a MERGE CONFLICT exit is claimed with both check fields null', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await exitOn(pr.id, {
      rawReason: 'MERGE_CONFLICT',
      failingCheckName: null,
      failingCheckUrl: null,
    });

    const result = await claim(fx, card.identifier);

    expect(result.outcome).toBe('claimed');
    expect(result.pullRequests[0]?.queueExit).toMatchObject({
      rawReason: 'MERGE_CONFLICT',
      failingCheckName: null,
      failingCheckUrl: null,
    });
  });

  it.each([
    ['re-queued', { requeuedAt: new Date() }],
    ['neutral', { disposition: 'neutral' as const, rawReason: 'MANUAL' }],
    ['at an OLD head', { headSha: 'a'.repeat(40) }],
  ])('an exit that is %s does not hold — not_failing', async (_label, opts) => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await exitOn(pr.id, opts);

    const result = await claim(fx, card.identifier);

    expect(result).toMatchObject({ outcome: 'not_repairable', reason: 'not_failing' });
    expect(await fixRuns(card.id)).toHaveLength(0);
  });

  it('an exit that does not hold beside a RUNNING member is ci_running', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr } = await greenCard(fx);
    await exitOn(pr.id, { requeuedAt: new Date() });
    await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/running',
      checks: { Vitest: 'pending' },
    });

    expect((await claim(fx, card.identifier)).reason).toBe('ci_running');
  });

  it('an own-failing and a queue-failing member are both handed over, each with its own queueExit', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo, pr: ejected } = await greenCard(fx);
    await exitOn(ejected.id);
    const red = await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/red',
      checks: { Vitest: 'failure' },
    });

    const result = await claim(fx, card.identifier);

    expect(result.outcome).toBe('claimed');
    const byNumber = new Map(result.pullRequests.map((p) => [p.number, p]));
    expect(byNumber.get(red.number)).toMatchObject({ ci: 'failing', queueExit: null });
    expect(byNumber.get(ejected.number)).toMatchObject({
      ci: 'passing',
      queueExit: { rawReason: 'CI_FAILURE' },
    });
  });

  // ── IN REVIEW (MOTIR-5803; `approval-gates.md` §4 FOURTH AMENDMENT, point 5) ──────
  // A manual FAILURE ejection now returns the card to In Review with a fresh gate, and
  // `motir fix` must accept it THERE — but only while the failure exit stands at a
  // member's head. Any other In Review card waits on a person, not on a repair.

  it('IN REVIEW: an ejected card is claimed with the exit’s reason and check, and its status and gates are unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await setStatus(card.id, 'in_review');
    await exitOn(pr.id);
    const gatesBefore = await adminDb.approvalGate.findMany({ where: { workItemId: card.id } });

    const result = await claim(fx, card.identifier);

    expect(result.outcome).toBe('claimed');
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: pr.number,
        ci: 'passing',
        queueExit: expect.objectContaining({
          rawReason: 'CI_FAILURE',
          failingCheckName: 'Merge queue / e2e',
          failingCheckUrl: 'https://github.com/acme/web/runs/77',
        }),
      }),
    ]);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'in_review',
    );
    expect(await adminDb.approvalGate.findMany({ where: { workItemId: card.id } })).toEqual(
      gatesBefore,
    );
  });

  it.each([
    ['no exit at all', null],
    ['an exit that was re-queued', { requeuedAt: new Date() }],
    ['an exit a push has left behind', { headSha: 'a'.repeat(40) }],
  ])('IN REVIEW with %s is refused not_failing, and opens nothing', async (_label, opts) => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await setStatus(card.id, 'in_review');
    if (opts) await exitOn(pr.id, opts);

    const result = await claim(fx, card.identifier);

    expect(result).toMatchObject({ outcome: 'not_repairable', reason: 'not_failing' });
    expect(result.pullRequests).toEqual([]);
    expect(await fixRuns(card.id)).toHaveLength(0);
  });

  // ── BY CLASS (MOTIR-5803; §4 FOURTH AMENDMENT, point 6) ─────────────────────────
  // `motir fix` sends an agent to change CODE, so the admission asks one question of the
  // standing outcome: could a code change answer it?
  it.each([
    ['CI_FAILURE', 'failure' as const],
    ['CI_TIMEOUT', 'failure' as const],
    ['INVALID_MERGE_COMMIT', 'failure' as const],
    ['GIT_TREE_INVALID', 'failure' as const],
    ['MERGE_CONFLICT', 'failure' as const],
  ])('IN REVIEW with %s is CLAIMED — the code may be at fault', async (rawReason, disposition) => {
    // Since the FIFTH AMENDMENT (MOTIR-6594) a live queue failure never reaches In Review;
    // this is a card the OLD rule re-asked, admitted until the convergence moves it.
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await setStatus(card.id, 'in_review');
    await exitOn(pr.id, { rawReason, disposition });

    const result = await claim(fx, card.identifier);

    expect(result.outcome).toBe('claimed');
    expect(result.pullRequests).toHaveLength(1);
  });

  it.each([
    ['BRANCH_PROTECTIONS', 'failure' as const],
    ['MANUAL', 'neutral' as const],
    ['QUEUE_CLEARED', 'neutral' as const],
    ['ROLL_BACK', 'neutral' as const],
    ['SOMETHING_NOBODY_HAS_MAPPED', 'neutral' as const],
  ])(
    'IN REVIEW with %s is refused repair_not_code — an agent has nothing to change',
    async (rawReason, disposition) => {
      const fx = await makeWorkItemFixture();
      const { card, pr } = await greenCard(fx);
      await setStatus(card.id, 'in_review');
      await exitOn(pr.id, { rawReason, disposition });

      const result = await claim(fx, card.identifier);

      expect(result).toMatchObject({ outcome: 'not_repairable', reason: 'repair_not_code' });
      expect(result.pullRequests).toEqual([]);
      expect(await fixRuns(card.id)).toHaveLength(0);
    },
  );

  // CAN'T-LAND is held at Implemented — a conflict, and since the FIFTH AMENDMENT
  // (MOTIR-6594) every queue FAILURE — and `motir fix` claims it there.
  it.each([
    'MERGE_CONFLICT',
    'CI_FAILURE',
    'CI_TIMEOUT',
    'INVALID_MERGE_COMMIT',
    'GIT_TREE_INVALID',
  ])('IMPLEMENTED with %s is claimed — the only way forward is the code', async (rawReason) => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await exitOn(pr.id, { rawReason, disposition: 'failure' });

    const result = await claim(fx, card.identifier);

    expect(result.outcome).toBe('claimed');
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: pr.number,
        queueExit: expect.objectContaining({ rawReason }),
      }),
    ]);
  });

  // MOTIR-7491 reversed this: the red hold is edge-triggered, so a card moved to In Review
  // by hand while a member was ALREADY red is never held back — and refusing it here left
  // it in no queue at all (MOTIR-1408). A red member admits it, with no queue exit needed.
  it('IN REVIEW with a red check of its own and no queue exit is CLAIMED, handing over only the red member', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo } = await greenCard(fx);
    await setStatus(card.id, 'in_review');
    const red = await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/red-in-review',
      checks: { Vitest: 'failure' },
    });

    const result = await claim(fx, card.identifier);

    expect(result).toMatchObject({ outcome: 'claimed', repairClass: 'ci' });
    expect(result.pullRequests).toEqual([
      expect.objectContaining({ number: red.number, ci: 'failing', queueExit: null }),
    ]);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'in_review',
    );
  });

  it('IN REVIEW with a member conflicted at its head and no queue exit is CLAIMED', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await setStatus(card.id, 'in_review');
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { mergeableState: 'dirty', mergeableStateHeadSha: 'c'.repeat(40) },
    });

    const result = await claim(fx, card.identifier);

    expect(result.outcome).toBe('claimed');
    expect(result.pullRequests).toEqual([
      expect.objectContaining({ number: pr.number, conflicted: true }),
    ]);
  });

  it('IN REVIEW with a red member AND a setting ejection is claimed — the red member is the repair', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr, repo } = await greenCard(fx);
    await setStatus(card.id, 'in_review');
    await exitOn(pr.id, { rawReason: 'BRANCH_PROTECTIONS', disposition: 'failure' });
    await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/red-beside-setting',
      checks: { Vitest: 'failure' },
    });

    expect((await claim(fx, card.identifier)).outcome).toBe('claimed');
  });

  it('IN REVIEW: the page’s repair view offers the fix on a red card', async () => {
    const fx = await makeWorkItemFixture();
    const { card, repo } = await greenCard(fx);
    await setStatus(card.id, 'in_review');
    const red = await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/red-view',
      checks: { Vitest: 'failure' },
    });

    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toMatchObject({
      state: 'offer',
      failing: [{ number: red.number, ci: 'failing' }],
    });
  });

  it('IN REVIEW: the page’s repair view offers the fix on an ejected card, and hides it otherwise', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await setStatus(card.id, 'in_review');
    expect((await workItemRepairService.getRepairView(card.id, fx.ctx)).state).toBe('hidden');

    await exitOn(pr.id);

    expect(await workItemRepairService.getRepairView(card.id, fx.ctx)).toMatchObject({
      state: 'offer',
      failing: [{ number: pr.number, queueExit: { rawReason: 'CI_FAILURE' } }],
    });
  });

  it('the page’s repair view OFFERS the fix on an ejected card, naming the exit’s reason', async () => {
    const fx = await makeWorkItemFixture();
    const { card, pr } = await greenCard(fx);
    await exitOn(pr.id, { rawReason: 'CI_TIMEOUT' });

    const view = await workItemRepairService.getRepairView(card.id, fx.ctx);

    expect(view).toMatchObject({
      state: 'offer',
      failing: [
        {
          number: pr.number,
          ci: 'passing',
          queueExit: { rawReason: 'CI_TIMEOUT', failingCheckName: 'Merge queue / e2e' },
        },
      ],
    });
  });
});

// A CONFLICT IS A FAILING MEMBER (MOTIR-5913, for bug MOTIR-5907; design/github § 30
// rule 2). A pull request the host reports `dirty` at its head is held at Implemented
// with its own checks GREEN, and `motir fix` is the answer the item page offers — so the
// claim must take it instead of refusing `not_failing`.
describe('claimRepair — a member the host reports conflicted (MOTIR-5913)', () => {
  const HEAD = 'c'.repeat(40); // the head `deliveredPr` writes its check rows at

  it('claims an implemented card whose only defect is a member `dirty` at its head', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'conflicted' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    const pr = await deliveredPr(fx, card.id, repo, {
      headRef: 'a',
      checks: { Vitest: 'success' },
    });
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { mergeableState: 'dirty', mergeableStateHeadSha: HEAD },
    });

    const result = await claim(fx, card.identifier);
    expect(result.outcome).toBe('claimed');
    expect(result.pullRequests.map((p) => p.number)).toEqual([pr.number]);
  });

  it('still refuses not_failing when the members are clean, unknown, or dirty only at an OLDER head', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'clean' });
    await setStatus(card.id, 'implemented');
    const repo = await connectRepairRepo(fx, 'web');
    const clean = await deliveredPr(fx, card.id, repo, {
      headRef: 'a',
      checks: { Vitest: 'success' },
    });
    await deliveredPr(fx, card.id, repo, { headRef: 'b', checks: { Vitest: 'success' } });
    const stale = await deliveredPr(fx, card.id, repo, {
      headRef: 'c',
      checks: { Vitest: 'success' },
    });
    await adminDb.githubPullRequest.update({
      where: { id: clean.id },
      data: { mergeableState: 'clean', mergeableStateHeadSha: HEAD },
    });
    await adminDb.githubPullRequest.update({
      where: { id: stale.id },
      data: { mergeableState: 'dirty', mergeableStateHeadSha: 'f'.repeat(40) },
    });

    expect((await claim(fx, card.identifier)).reason).toBe('not_failing');
    expect(await fixRuns(card.id)).toHaveLength(0);
  });
});
