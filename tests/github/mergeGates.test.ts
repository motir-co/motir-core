import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown>; gatesAtSend: number }> = [];
vi.mock('@/lib/jobs/sendEvent', async () => {
  const { adminDb: admin } = await import('../helpers/adminDb');
  return {
    sendEvent: async (name: string, data: Record<string, unknown>) => {
      // Read on ANOTHER connection at the moment of sending: a gate visible here was
      // committed before the event left, which is what "post-commit" means.
      const gatesAtSend = await admin.approvalGate.count({
        where: { workItemId: String(data['workItemId']) },
      });
      sent.push({ name, data, gatesAtSend });
    },
  };
});

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { ChangeRequestMergeability } from '@/lib/git/types';
import { jobServices } from '@/lib/jobs/services';
import {
  HEAD_MOVED_RETRY_WAITS_MS,
  pullRequestHeadMoved,
} from '@/lib/jobs/definitions/pullRequestHeadMoved';
import { homeService } from '@/lib/services/homeService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { howToTestService } from '@/lib/services/howToTestService';
import { promoteDeliveredCardsOnGreen } from '@/lib/services/ciPromotion';
import { mergeCandidateHead } from '@/lib/services/mergeGates';
import { pullRequestMergeabilityService } from '@/lib/services/pullRequestMergeabilityService';
import { raisePullRequestApprovalGate } from '@/lib/services/pullRequestApprovalGates';
import { resolveRunTargetFor } from '@/lib/services/runTarget';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// ONE GATE per card (MOTIR-5603 · MOTIR-5611; `approval-gates.md` §8's SECOND
// AMENDMENT, decisions 1 and 2), against a REAL Postgres through the real webhook
// service — the same doors a GitHub delivery walks.
//
// A green delivery set leaves EXACTLY ONE `awaiting` gate on the run target in a
// `manual` project — the `pull_request_approval` gate over the whole set — and NEVER a
// per-pull-request `pull_request_merge` gate. This file is the regression guard for
// that: every assertion below fails if the manual arm ever raises one again.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-merge-gates';
const REPO_PROVIDER_ID = '991';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

function pullRequestPayload(action: string, number: number, headRef: string, extra = {}) {
  return {
    action,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
      ...extra,
    },
  };
}

/** A green (or not) CI verdict for one pull request at one commit. */
const ci = (opts: {
  conclusion: string | null;
  headSha: string;
  number: number;
  status?: string;
}) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: null,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: opts.number }],
    },
  });

/** ONE named check at one commit — how a LATE row for an old commit arrives (a
 *  workflow reporting after the push, a redelivery). The name is one that commit has
 *  not reported yet, so the ingestion INSERTS a row rather than updating one. */
const checkRun = (opts: { name: string; conclusion: string; headSha: string; number: number }) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: 'completed',
      conclusion: opts.conclusion,
      name: opts.name,
      check_suite: { head_branch: null, id: 777 },
      pull_requests: [{ number: opts.number }],
    },
  });

/** A card delivered by one pull request per number, each linked the way a run links
 *  it and opened, so the card sits at `implemented`. */
async function cardWithPrs(s: Scenario, title: string, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) {
    const headRef = `subtask/${item.identifier}-${number}`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef,
    });
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('opened', number, headRef),
    );
  }
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function prId(number: number): Promise<string> {
  return (await adminDb.githubPullRequest.findFirstOrThrow({ where: { number } })).id;
}

/** Every gate on the card, whatever its kind — what a person would see waiting. */
async function gatesOf(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId },
    orderBy: { createdAt: 'asc' },
  });
}

/** The gate kind MOTIR-5611 retired. Every call below asserts this is EMPTY. */
async function mergeGates(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'pull_request_merge' },
    orderBy: { createdAt: 'asc' },
  });
}

async function awaitingVersions(workItemId: string): Promise<string[]> {
  return (await gatesOf(workItemId))
    .filter((g) => g.state === 'awaiting')
    .map((g) => g.subjectVersion ?? '')
    .sort();
}

/** Record a green check row directly — for the cases that drive the promotion by hand. */
async function greenRow(number: number, sha: string) {
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: await prId(number),
      commitSha: sha,
      checkName: 'ci / vitest',
      conclusion: 'success',
    },
  });
}

/** A card promoted to in_review on two green pull requests, holding its ONE gate. */
async function reviewedWithOneGate(email: string) {
  const s = await makeScenario(email);
  const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);
  await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
  await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
  expect(await statusOf(item.id)).toBe('in_review');
  const gates = await gatesOf(item.id);
  expect(gates).toHaveLength(1);
  expect(gates[0]!.kind).toBe('pull_request_approval');
  expect(await mergeGates(item.id)).toEqual([]);
  return { s, item };
}

/** Answer the host's mergeability read with this SEQUENCE, one answer per read, the
 *  last repeating — the one thing that leaves the process (MOTIR-7063). */
function stubHostReading(...answers: Array<Partial<ChangeRequestMergeability>>) {
  let reads = 0;
  const github = getGitProvider('github') as Required<GitProvider>;
  const spy = vi.spyOn(github, 'readChangeRequestMergeability').mockImplementation(async () => {
    const answer = answers[Math.min(reads, answers.length - 1)]!;
    reads += 1;
    return { mergeable: null, mergeableState: null, headSha: null, ...answer };
  });
  return { spy, reads: () => reads };
}

/** Drive the `pull-request/head-moved` job's own handler with a step API that executes
 *  steps and records sleeps — the run a `synchronize` enqueues (MOTIR-7063). */
async function runHeadMovedJob(workspaceId: string, number: number, headSha: string) {
  const pullRequestId = await prId(number);
  const slept: number[] = [];
  const ctx = {
    event: {
      name: 'pull-request/head-moved',
      data: {
        workspaceId,
        pullRequestId,
        number,
        headSha,
        idempotencyKey: `${pullRequestId}:${headSha}`,
      },
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
    pullRequestHeadMoved.handler as unknown as (
      c: typeof ctx,
      s: typeof jobServices,
    ) => Promise<Record<string, unknown>>
  )(ctx, jobServices);
  return { result, slept };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('ONE GATE — a green delivery set leaves exactly one awaiting gate on the run target', () => {
  it('a card whose two pull requests turn green reaches in_review holding ONE gate over BOTH heads', async () => {
    const s = await makeScenario('mg-raise@example.com');
    const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);

    // One green of two is not the verdict: no promotion, no gate.
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);

    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
    expect(await statusOf(item.id)).toBe('in_review');

    const gates = await gatesOf(item.id);
    expect(gates).toHaveLength(1);
    expect([
      gates[0]!.kind,
      gates[0]!.subjectId,
      gates[0]!.subjectVersion,
      gates[0]!.state,
    ]).toEqual([
      'pull_request_approval',
      item.id,
      'moooon/acme#11@sha-a,moooon/acme#12@sha-b',
      'awaiting',
    ]);
    expect(gates[0]!.routedToId).toBe(s.user.id);
    // MOTIR-5611: the per-pull-request kind is never raised again.
    expect(await mergeGates(item.id)).toEqual([]);

    // And through the PRODUCTION read — a row in the table that the scoped read
    // cannot see is not a question anybody is being asked.
    const awaiting = await withWorkspaceContext(s.ctx, (tx) =>
      approvalGateRepository.findAwaitingByWorkItem(item.id, tx),
    );
    expect(awaiting.map((g) => g.kind)).toEqual(['pull_request_approval']);
  });

  it('the same card in an AUTO project reaches in_review and holds NO gate at all', async () => {
    const s = await makeScenario('mg-auto@example.com');
    await adminDb.project.update({ where: { id: s.project.id }, data: { prMergeMode: 'auto' } });
    const item = await cardWithPrs(s, 'Auto', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('one pull request green and one red: the card stays implemented and holds no gate', async () => {
    const s = await makeScenario('mg-red@example.com');
    const item = await cardWithPrs(s, 'Half green', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'failure', headSha: 'sha-b', number: 12 });

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('a card whose provider cannot merge (GitLab) gets no gate; the same one on GitHub gets ONE', async () => {
    const s = await makeScenario('mg-gitlab@example.com');
    // Promote with no gate first, so the provider is the only thing that differs
    // between the two re-raises below.
    await adminDb.project.update({ where: { id: s.project.id }, data: { prMergeMode: 'auto' } });
    const item = await cardWithPrs(s, 'GitLab', [11]);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    expect(await statusOf(item.id)).toBe('in_review');
    await adminDb.project.update({ where: { id: s.project.id }, data: { prMergeMode: 'manual' } });

    const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'acme' } });
    const promote = async () =>
      promoteDeliveredCardsOnGreen({
        changeRequestId: await prId(11),
        workspaceId: s.workspace.id,
        actorUserId: s.user.id,
      });

    await adminDb.githubRepo.update({ where: { id: repo.id }, data: { provider: 'gitlab' } });
    await promote();
    expect(await gatesOf(item.id)).toEqual([]);

    await adminDb.githubRepo.update({ where: { id: repo.id }, data: { provider: 'github' } });
    await promote();
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a']);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  // ⚠️ REVERSED — MOTIR-5662, one of MOTIR-5652's two root causes. This test
  // pinned `raisePullRequestApprovalGate`'s run-target refusal: a card whose run
  // target resolved to `{ kind: 'ancestor' }` raised nothing. `resolveRunTargetFor`
  // answers *whose How to test is this*, which is true and useful; it was never an
  // answer to *does this card have something to decide*. In a parent run the
  // How-to-test record is written once onto the PARENT, so EVERY child resolved to
  // `ancestor` and raised nothing — while the parent's own promotion was skipped by
  // `ContainerHasOpenChildrenError`. No gate anywhere.
  //
  // The How-to-test half of the assertion is UNCHANGED and is why the test is kept
  // rather than deleted: the two questions used to share one answer, and this is
  // where they are shown to have come apart.
  it('a CHILD a container run delivers raises its gate exactly as its run target does — and How to test still names the ancestor', async () => {
    const s = await makeScenario('mg-child@example.com');
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story' },
      s.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A child', parentId: story.id },
      s.ctx,
    );
    // The parent run's record — what makes the story the run target.
    await adminDb.testInstructions.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: story.id,
        bodyMd: '## Open the page',
      },
    });
    for (const identifier of [story.identifier, child.identifier]) {
      await linkPrByIdentifier({
        identifier,
        owner: 'moooon',
        name: 'acme',
        number: 13,
        headRef: `parent/${story.identifier}-work`,
      });
    }
    await greenRow(13, 'sha-p');

    // MOTIR-6971: the gate is asked only of a card IN REVIEW, whatever its run target —
    // so while the run has settled neither card, nothing is raised.
    const unsettled = await withWorkspaceContext(s.ctx, async (tx) =>
      raisePullRequestApprovalGate(
        await tx.workItem.findUniqueOrThrow({ where: { id: child.id } }),
        tx,
      ),
    );
    expect(unsettled).toBe(false);
    await adminDb.workItem.updateMany({
      where: { id: { in: [story.id, child.id] } },
      data: { status: 'in_review' },
    });

    const raised = await withWorkspaceContext(s.ctx, async (tx) => {
      const rows = await Promise.all(
        [child.id, story.id].map((id) => tx.workItem.findUniqueOrThrow({ where: { id } })),
      );
      return {
        child: await raisePullRequestApprovalGate(rows[0]!, tx),
        story: await raisePullRequestApprovalGate(rows[1]!, tx),
        target: await resolveRunTargetFor(rows[0]!, tx),
      };
    });

    expect(raised.child).toBe(true);
    expect(raised.story).toBe(true);
    expect(await awaitingVersions(child.id)).toEqual(['moooon/acme#13@sha-p']);
    expect(await awaitingVersions(story.id)).toEqual(['moooon/acme#13@sha-p']);

    // The child's run target is still the STORY — naming the resolved kind, because
    // the point is that a gate is now raised DESPITE it.
    expect(raised.target).toMatchObject({ kind: 'ancestor', holder: { id: story.id } });
    expect((await howToTestService.getForWorkItem(child.id, s.ctx)).runTarget).toEqual({
      key: story.identifier,
    });
  });
});

describe('WITHDRAW — the card’s ONE gate is superseded when its SET changes', () => {
  it('a NEW COMMIT supersedes the card’s gate; the next green raises a fresh one over the new set', async () => {
    const { item } = await reviewedWithOneGate('mg-push@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });
    const afterPush = await gatesOf(item.id);
    expect(afterPush.map((g) => [g.subjectVersion, g.state])).toEqual([
      ['moooon/acme#11@sha-a,moooon/acme#12@sha-b', 'superseded'],
    ]);

    await ci({ conclusion: 'success', headSha: 'sha-a2', number: 11 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a2,moooon/acme#12@sha-b']);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  // MOTIR-5604 — green → push → green must leave exactly ONE awaiting gate even when a row
  // for the OLD commit is written after the new one's. The head used to be the commit of
  // the newest ROW, so that late row made the old commit current again: the withdrawal
  // superseded the fresh gate, and the raise named the old head.
  it('a LATE row for the OLD commit, written after the new head went green, leaves the fresh gate standing', async () => {
    const { s, item } = await reviewedWithOneGate('mg-late-after@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-a2', number: 11 });
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a2,moooon/acme#12@sha-b']);

    await checkRun({ name: 'CodeQL', conclusion: 'success', headSha: 'sha-a', number: 11 });

    // Rows for BOTH commits exist, and the older commit's was written last.
    const rows = await adminDb.githubCheckRun.findMany({
      where: { pullRequestId: await prId(11) },
      orderBy: { createdAt: 'desc' },
    });
    expect(new Set(rows.map((r) => r.commitSha))).toEqual(new Set(['sha-a', 'sha-a2']));
    expect(rows[0]!.commitSha).toBe('sha-a');

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a2,moooon/acme#12@sha-b']);
    const awaiting = await withWorkspaceContext(s.ctx, (tx) =>
      approvalGateRepository.findAwaitingByWorkItem(item.id, tx),
    );
    expect(awaiting.map((g) => g.kind)).toEqual(['pull_request_approval']);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  it('a LATE row for the OLD commit, written between the push and the new green, does not stop the green raising over the NEW head', async () => {
    const { item } = await reviewedWithOneGate('mg-late-between@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });
    expect(await awaitingVersions(item.id)).toEqual([]);

    // The old commit reports a check it had not reported before, AFTER the new commit's
    // first row. The new commit's verdict then UPDATES its pending row, which keeps that
    // row's creation time — so the old commit's row stays the newest one.
    await checkRun({ name: 'CodeQL', conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-a2', number: 11 });

    const gates = await gatesOf(item.id);
    expect(gates.filter((g) => g.state === 'awaiting')).toHaveLength(1);
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a2,moooon/acme#12@sha-b']);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  it('a `synchronize` delivery supersedes the gate asked about the head it moved away from', async () => {
    const { item } = await reviewedWithOneGate('mg-sync@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('synchronize', 11, `subtask/${item.identifier}-11`, {
        head: { ref: `subtask/${item.identifier}-11`, sha: 'sha-a3' },
      }),
    );

    expect(await awaitingVersions(item.id)).toEqual([]);
  });

  it('a CLOSED member supersedes the gate — the set nobody can merge is no longer the question', async () => {
    const { item } = await reviewedWithOneGate('mg-closed@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('closed', 12, `subtask/${item.identifier}-12`),
    );

    expect(await awaitingVersions(item.id)).toEqual([]);
    expect((await gatesOf(item.id)).map((g) => g.state)).toEqual(['superseded']);
  });

  // ⚠️ AMENDED — MOTIR-5663. The withdrawal still happens and still records
  // `set_changed`; what is new is that the site then ASKS what the card should hold
  // now. The remaining member is green, so the answer is a gate over the SMALLER
  // set — which is the structural half of this level: a question retired for an
  // excellent reason used to leave the card with none (MOTIR-5604, paid for once at
  // one site while six others behaved the same way).
  it('UNLINKING a member supersedes that card’s gate and re-asks over the smaller set', async () => {
    const { s, item } = await reviewedWithOneGate('mg-unlink@example.com');

    const result = await githubPullRequestService.unlinkPullRequestByCoordinates(
      { workItemId: item.id, projectId: s.project.id, owner: 'moooon', name: 'acme', number: 12 },
      s.ctx,
    );

    expect(result.removed).toBe(true);
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a']);
  });
});

describe('one transaction, ONE gate per card, however the events arrive', () => {
  it('a gate insert that FAILS rolls the status write back with it', async () => {
    const s = await makeScenario('mg-rollback@example.com');
    const item = await cardWithPrs(s, 'Rollback', [11]);
    await greenRow(11, 'sha-a');
    vi.spyOn(approvalGateRepository, 'create').mockRejectedValueOnce(new Error('insert failed'));
    sent.length = 0;

    await expect(
      promoteDeliveredCardsOnGreen({
        changeRequestId: await prId(11),
        workspaceId: s.workspace.id,
        actorUserId: s.user.id,
      }),
    ).rejects.toThrow('insert failed');

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
  });

  it('two green events for one card, concurrently, leave ONE gate; a redelivery adds none', async () => {
    const s = await makeScenario('mg-race@example.com');
    const item = await cardWithPrs(s, 'Race', [11, 12]);
    await greenRow(11, 'sha-a');
    await greenRow(12, 'sha-b');
    const green = async (number: number) =>
      promoteDeliveredCardsOnGreen({
        changeRequestId: await prId(number),
        workspaceId: s.workspace.id,
        actorUserId: s.user.id,
      });

    const [first, second] = await Promise.all([green(11), green(12)]);

    expect([...first, ...second]).toContain(item.id);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#11@sha-a,moooon/acme#12@sha-b']);

    await Promise.all([green(11), green(11)]);
    expect(await gatesOf(item.id)).toHaveLength(1);
    expect(await mergeGates(item.id)).toEqual([]);
  });

  it('work-item/transitioned is still sent after commit, with the payload it always carried', async () => {
    const s = await makeScenario('mg-event@example.com');
    const item = await cardWithPrs(s, 'Event', [11]);
    sent.length = 0;

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });

    const transitioned = sent.filter((e) => e.name === 'work-item/transitioned');
    expect(transitioned).toHaveLength(1);
    expect(transitioned[0]!.data).toEqual({
      workspaceId: s.workspace.id,
      workItemId: item.id,
      actorId: s.user.id,
      fromStatusKey: 'implemented',
      toStatusKey: 'in_review',
      revisionId: expect.any(String),
    });
    // The gate was committed before the event left.
    expect(transitioned[0]!.gatesAtSend).toBe(1);
  });
});

// A DRAFT IS NOT A MERGE CANDIDATE (MOTIR-5699). A draft pull request is its author
// saying *not ready*, and GitHub refuses to merge one — so a green draft must not put
// an approve-and-merge question on anybody's To approve. `mergeCandidateHead` is the
// one statement of candidacy both merge modes read, which is why the rule lives there;
// the two draft EDGES (`ready_for_review`, `converted_to_draft`) are what keep an
// already-green pull request's gate in step with the flag.
describe('a DRAFT is not a merge candidate (MOTIR-5699)', () => {
  const openGreen = {
    state: 'open',
    merged: false,
    repo: { provider: 'github' },
    checkRuns: [
      {
        id: 'c1',
        pullRequestId: 'p1',
        commitSha: 'sha-a',
        checkName: 'ci / vitest',
        conclusion: 'success',
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  } as unknown as Parameters<typeof mergeCandidateHead>[0] & object;

  it('a green DRAFT has no merge head; a ready one does, and an UNKNOWN draft-ness is not invented', () => {
    expect(mergeCandidateHead({ ...openGreen, draft: true })).toBeNull();
    expect(mergeCandidateHead({ ...openGreen, draft: false })).toBe('sha-a');
    // Rows written before MOTIR-5002 do not know — they stay candidates.
    expect(mergeCandidateHead({ ...openGreen, draft: null })).toBe('sha-a');
  });

  /** A card delivered by ONE pull request opened as a DRAFT — which, since MOTIR-4968,
   *  leaves the card where it was rather than moving it to `implemented`. */
  async function cardWithDraft(s: Scenario, title: string, number: number) {
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    const headRef = `subtask/${item.identifier}-${number}`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef,
    });
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('opened', number, headRef, { draft: true }),
    );
    expect(await statusOf(item.id)).toBe('in_progress');
    return { item, headRef };
  }

  it('a DRAFT going green raises NO gate — through the CI delivery AND through a direct reconcile', async () => {
    const s = await makeScenario('mg-draft-green@example.com');
    const { item } = await cardWithDraft(s, 'Draft', 21);

    await ci({ conclusion: 'success', headSha: 'sha-d', number: 21 });
    expect(await gatesOf(item.id)).toEqual([]);

    // The status-agnostic door every other raiser shares (the reconcile sweep, the
    // status funnel, the withdrawers' re-ask) — the path the reported card took.
    const raised = await withWorkspaceContext(s.ctx, async (tx) =>
      raisePullRequestApprovalGate(
        await tx.workItem.findUniqueOrThrow({ where: { id: item.id } }),
        tx,
      ),
    );
    expect(raised).toBe(false);
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('marking an ALREADY-GREEN draft ready for review raises exactly ONE gate', async () => {
    const s = await makeScenario('mg-draft-ready@example.com');
    const { item, headRef } = await cardWithDraft(s, 'Draft then ready', 22);
    await ci({ conclusion: 'success', headSha: 'sha-r', number: 22 });
    expect(await gatesOf(item.id)).toEqual([]);

    // No check event follows — CI has already spoken for this head.
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('ready_for_review', 22, headRef, { draft: false }),
    );

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#22@sha-r']);
    expect(await gatesOf(item.id)).toHaveLength(1);
  });

  it('converting a pull request back to a DRAFT withdraws its gate as `member_drafted`; ready again re-asks ONCE', async () => {
    const s = await makeScenario('mg-redraft@example.com');
    const item = await cardWithPrs(s, 'Redraft', [23]);
    await ci({ conclusion: 'success', headSha: 'sha-x', number: 23 });
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#23@sha-x']);
    const headRef = `subtask/${item.identifier}-23`;

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('converted_to_draft', 23, headRef, { draft: true }),
    );
    expect((await gatesOf(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'member_drafted'],
    ]);
    expect(await awaitingVersions(item.id)).toEqual([]);

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('ready_for_review', 23, headRef, { draft: false }),
    );
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#23@sha-x']);
    expect((await gatesOf(item.id)).filter((g) => g.state === 'awaiting')).toHaveLength(1);
  });
});

// A CONFLICTED MEMBER IS NOT A MERGE CANDIDATE (MOTIR-5913, for bug MOTIR-5907). The host's
// `mergeable_state` is stored with the head it was read at, and a member the host reports
// `dirty` AT ITS CURRENT HEAD is asked about nobody, is not promoted to In Review, and is
// what a `synchronize` replaces. `null` — GitHub has not computed — is no conflict (and, owed
// at the head, it holds the promotion: MOTIR-7063, below).
describe('a CONFLICTED member is not a merge candidate (MOTIR-5913)', () => {
  const openGreen = {
    state: 'open',
    merged: false,
    draft: false,
    repo: { provider: 'github' },
    checkRuns: [
      {
        id: 'c1',
        pullRequestId: 'p1',
        commitSha: 'sha-a',
        checkName: 'ci / vitest',
        conclusion: 'success',
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  } as unknown as Parameters<typeof mergeCandidateHead>[0] & object;

  it('`dirty` AT the head has no merge head; at an OLDER head, or unknown, it is still a candidate', () => {
    expect(
      mergeCandidateHead({ ...openGreen, mergeableState: 'dirty', mergeableStateHeadSha: 'sha-a' }),
    ).toBeNull();
    expect(
      mergeCandidateHead({
        ...openGreen,
        mergeableState: 'dirty',
        mergeableStateHeadSha: 'sha-old',
      }),
    ).toBe('sha-a');
    expect(
      mergeCandidateHead({ ...openGreen, mergeableState: null, mergeableStateHeadSha: null }),
    ).toBe('sha-a');
    expect(
      mergeCandidateHead({ ...openGreen, mergeableState: 'clean', mergeableStateHeadSha: 'sha-a' }),
    ).toBe('sha-a');
  });

  async function storeReading(
    number: number,
    mergeableState: string | null,
    headSha: string | null,
  ) {
    await adminDb.githubPullRequest.update({
      where: { id: await prId(number) },
      data: { mergeableState, mergeableStateHeadSha: headSha },
    });
  }

  it('a member stored `dirty` at the head its checks go green on is NOT promoted and raises NO gate', async () => {
    const s = await makeScenario('mg-conflict-hold@example.com');
    const item = await cardWithPrs(s, 'Conflicted', [31]);
    await storeReading(31, 'dirty', 'sha-c');

    await ci({ conclusion: 'success', headSha: 'sha-c', number: 31 });

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('a member stored `behind` a strict base at its head is held the same way (MOTIR-10054)', async () => {
    const s = await makeScenario('mg-behind-hold@example.com');
    const item = await cardWithPrs(s, 'Out of date', [35]);
    await storeReading(35, 'behind', 'sha-b');

    await ci({ conclusion: 'success', headSha: 'sha-b', number: 35 });

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('a reading at an OLDER head is OWED, not clean (MOTIR-7063): green at the new head waits, and the host’s clean answer there promotes with ONE gate', async () => {
    const s = await makeScenario('mg-conflict-old-head@example.com');
    const item = await cardWithPrs(s, 'Old reading', [32]);
    await storeReading(32, 'dirty', 'sha-before');

    await ci({ conclusion: 'success', headSha: 'sha-after', number: 32 });

    // The `dirty` is about another commit, so it is no conflict at `sha-after` — and no
    // answer about it either. Nobody is asked yet.
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);

    stubHostReading({ mergeable: true, mergeableState: 'clean', headSha: 'sha-after' });
    const summary = await pullRequestMergeabilityService.settleHeadMember(s.workspace.id, {
      pullRequestId: await prId(32),
      number: 32,
    });

    expect(summary).toMatchObject({ outcome: 'clean', promoted: 1 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#32@sha-after']);
  });

  it('the RESOLVING PATH end to end (MOTIR-5914): a conflict withdraws the asked gate and holds the card; a push that resolves it and goes green asks exactly ONCE', async () => {
    const s = await makeScenario('mg-conflict-e2e@example.com');
    const item = await cardWithPrs(s, 'Conflict then resolve', [34]);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 34 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#34@sha-a']);

    // The base moved and the host now reports the member conflicted at its head.
    await pullRequestMergeabilityService.settleReading(s.workspace.id, await prId(34), {
      mergeable: false,
      mergeableState: 'dirty',
      headSha: 'sha-a',
    });
    expect((await gatesOf(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'conflict'],
    ]);
    expect(await statusOf(item.id)).toBe('implemented');

    const headRef = `subtask/${item.identifier}-34`;
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('synchronize', 34, headRef, { head: { ref: headRef, sha: 'sha-b' } }),
    );
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 34 });
    // Green at the resolving head is not yet "resolved": the host has not said (MOTIR-7063).
    expect(await statusOf(item.id)).toBe('implemented');

    stubHostReading({ mergeable: true, mergeableState: 'clean', headSha: 'sha-b' });
    await runHeadMovedJob(s.workspace.id, 34, 'sha-b');

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#34@sha-b']);
    expect((await gatesOf(item.id)).filter((g) => g.state === 'awaiting')).toHaveLength(1);
  });

  it('a `synchronize` REPLACES the reading with pending at the new head and asks the host; the resolving head asks exactly ONCE', async () => {
    const s = await makeScenario('mg-conflict-resolve@example.com');
    const item = await cardWithPrs(s, 'Resolve', [33]);
    await storeReading(33, 'dirty', 'sha-1');
    await ci({ conclusion: 'success', headSha: 'sha-1', number: 33 });
    expect(await statusOf(item.id)).toBe('implemented');

    const headRef = `subtask/${item.identifier}-33`;
    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('synchronize', 33, headRef, { head: { ref: headRef, sha: 'sha-2' } }),
    );
    const row = await adminDb.githubPullRequest.findUniqueOrThrow({
      where: { id: await prId(33) },
    });
    // The old head's `dirty` is gone — and what stands in its place is OWED, not nothing.
    expect([row.mergeableState, row.mergeableStateHeadSha]).toEqual(['unknown', 'sha-2']);
    expect(sent.filter((e) => e.name === 'pull-request/head-moved').map((e) => e.data)).toEqual([
      {
        workspaceId: s.workspace.id,
        pullRequestId: row.id,
        number: 33,
        headSha: 'sha-2',
        idempotencyKey: `${row.id}:sha-2`,
      },
    ]);

    await ci({ conclusion: 'success', headSha: 'sha-2', number: 33 });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);

    stubHostReading({ mergeable: true, mergeableState: 'clean', headSha: 'sha-2' });
    await runHeadMovedJob(s.workspace.id, 33, 'sha-2');

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#33@sha-2']);
    expect((await gatesOf(item.id)).filter((g) => g.state === 'awaiting')).toHaveLength(1);
  });
});

// A PUSH ONTO A BASE THAT HAS ALREADY MOVED PAST IT (MOTIR-7063). The conflict arrives
// with no event on the base at all, so the `synchronize` itself asks: it marks the
// reading PENDING at the new head and enqueues `pull-request/head-moved`, whose host
// read settles it. Green CI does not promote a head whose reading is still owed.
describe('a push is asked about at its NEW head (MOTIR-7063)', () => {
  const headRefOf = (item: { identifier: string }, number: number) =>
    `subtask/${item.identifier}-${number}`;
  const push = (item: { identifier: string }, number: number, sha: string) =>
    githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('synchronize', number, headRefOf(item, number), {
        head: { ref: headRefOf(item, number), sha },
      }),
    );
  const reading = async (number: number) => {
    const row = await adminDb.githubPullRequest.findUniqueOrThrow({
      where: { id: await prId(number) },
    });
    return [row.mergeableState, row.mergeableStateHeadSha];
  };
  const fixReasonOf = async (workItemId: string) =>
    (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).fixReason;
  const toFixRow = async (s: Scenario, workItemId: string) =>
    (
      await homeService.listToFix({
        userId: s.user.id,
        workspaceId: s.workspace.id,
        projectId: s.project.id,
      })
    ).items.find((row) => row.id === workItemId);

  it('onto a CONFLICTING base: the re-read stores `dirty` at the new head, the card is `conflicted` in To fix, and green there promotes nothing', async () => {
    const s = await makeScenario('mg-7063-conflict@example.com');
    const item = await cardWithPrs(s, 'Pushed onto a moved base', [41]);

    await push(item, 41, 'sha-b');
    expect(await reading(41)).toEqual(['unknown', 'sha-b']);

    stubHostReading({ mergeable: false, mergeableState: 'dirty', headSha: 'sha-b' });
    const { result, slept } = await runHeadMovedJob(s.workspace.id, 41, 'sha-b');

    expect(result).toMatchObject({ outcome: 'conflicted', passes: 1 });
    expect(slept).toEqual([]);
    expect(await reading(41)).toEqual(['dirty', 'sha-b']);
    expect(await fixReasonOf(item.id)).toBe('conflicted');
    expect((await toFixRow(s, item.id))?.fixReason).toBe('conflicted');

    await ci({ conclusion: 'success', headSha: 'sha-b', number: 41 });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('green BEFORE the answer waits; a CLEAN answer then promotes with exactly ONE gate', async () => {
    const s = await makeScenario('mg-7063-clean@example.com');
    const item = await cardWithPrs(s, 'Pushed onto a clean base', [42]);

    await push(item, 42, 'sha-b');
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 42 });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gatesOf(item.id)).toEqual([]);

    stubHostReading({ mergeable: true, mergeableState: 'clean', headSha: 'sha-b' });
    const { result } = await runHeadMovedJob(s.workspace.id, 42, 'sha-b');

    expect(result).toMatchObject({ outcome: 'clean', promoted: 1 });
    expect(await reading(42)).toEqual(['clean', 'sha-b']);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#42@sha-b']);
  });

  it('a CLEAN answer BEFORE green promotes nothing yet; the green that follows promotes with ONE gate', async () => {
    const s = await makeScenario('mg-7063-clean-first@example.com');
    const item = await cardWithPrs(s, 'Answer first', [43]);

    await push(item, 43, 'sha-b');
    stubHostReading({ mergeable: true, mergeableState: 'clean', headSha: 'sha-b' });
    const { result } = await runHeadMovedJob(s.workspace.id, 43, 'sha-b');
    expect(result).toMatchObject({ outcome: 'clean', promoted: 0 });
    expect(await statusOf(item.id)).toBe('implemented');

    await ci({ conclusion: 'success', headSha: 'sha-b', number: 43 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#43@sha-b']);
  });

  it('a card IN REVIEW pushed onto a conflicting base is moved to Implemented and listed in To fix as `conflicted`', async () => {
    const s = await makeScenario('mg-7063-in-review@example.com');
    const item = await cardWithPrs(s, 'Already asked', [44]);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 44 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#44@sha-a']);

    await push(item, 44, 'sha-b');
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 44 });
    // The push withdrew the question about `sha-a`, and green at `sha-b` asks nothing
    // while the reading there is owed.
    expect(await awaitingVersions(item.id)).toEqual([]);

    stubHostReading({ mergeable: false, mergeableState: 'dirty', headSha: 'sha-b' });
    await runHeadMovedJob(s.workspace.id, 44, 'sha-b');

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingVersions(item.id)).toEqual([]);
    expect((await toFixRow(s, item.id))?.fixReason).toBe('conflicted');
  });

  it('a card IN REVIEW pushed onto a clean base is asked again about the new head, ONCE', async () => {
    const s = await makeScenario('mg-7063-in-review-clean@example.com');
    const item = await cardWithPrs(s, 'Asked again', [45]);
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 45 });

    await push(item, 45, 'sha-b');
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 45 });
    expect(await awaitingVersions(item.id)).toEqual([]);

    stubHostReading({ mergeable: true, mergeableState: 'clean', headSha: 'sha-b' });
    const { result } = await runHeadMovedJob(s.workspace.id, 45, 'sha-b');

    expect(result).toMatchObject({ outcome: 'clean', gatesRaised: 1 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#45@sha-b']);
  });

  it('the host computes LAZILY: `null` is asked again after the bounded waits, and a `dirty` on the retry settles', async () => {
    const s = await makeScenario('mg-7063-lazy@example.com');
    const item = await cardWithPrs(s, 'Lazy host', [46]);
    await push(item, 46, 'sha-b');

    const host = stubHostReading(
      { mergeable: null, mergeableState: 'unknown' },
      { mergeable: false, mergeableState: 'dirty', headSha: 'sha-b' },
    );
    const { result, slept } = await runHeadMovedJob(s.workspace.id, 46, 'sha-b');

    expect(host.reads()).toBe(2);
    expect(slept).toEqual([HEAD_MOVED_RETRY_WAITS_MS[0]]);
    expect(result).toMatchObject({ outcome: 'conflicted', passes: 2 });
    expect(await fixReasonOf(item.id)).toBe('conflicted');
  });

  it('`null` on EVERY retry leaves the reading pending and the card held — the reconcile tick is the backstop', async () => {
    const s = await makeScenario('mg-7063-never@example.com');
    const item = await cardWithPrs(s, 'Never computed', [47]);
    await push(item, 47, 'sha-b');
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 47 });

    stubHostReading({ mergeable: null, mergeableState: 'unknown' });
    const { result, slept } = await runHeadMovedJob(s.workspace.id, 47, 'sha-b');

    expect(slept).toEqual([...HEAD_MOVED_RETRY_WAITS_MS]);
    expect(result).toMatchObject({
      outcome: 'unknown',
      passes: HEAD_MOVED_RETRY_WAITS_MS.length + 1,
    });
    expect(await reading(47)).toEqual(['unknown', 'sha-b']);
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await fixReasonOf(item.id)).toBeNull();
  });

  it('a pull request NOTHING has asked about is not held — an unasked row is not an owed one', async () => {
    const s = await makeScenario('mg-7063-unasked@example.com');
    const item = await cardWithPrs(s, 'Never pushed', [48]);
    expect(await reading(48)).toEqual([null, null]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 48 });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingVersions(item.id)).toEqual(['moooon/acme#48@sha-a']);
  });
});
