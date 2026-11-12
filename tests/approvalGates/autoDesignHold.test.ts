import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { makeWorkWaitOn } from '@/tests/helpers/designWaits';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// AN UNANSWERED DESIGN HOLDS EVERY MERGE THAT DOES NOT FOLLOW IT (Bug MOTIR-5762;
// `docs/decisions/design-result.md` AMENDMENT 6 Q1), against a REAL Postgres through the
// real webhook and publish doors.
//
// ⚠️ THE TWO DOORS THAT MERGED OVER IT. The design gate is the PRIMARY question and the
// merge is what FOLLOWS it — but two paths reached the merge without asking it:
//
//   · `settleGreenVerdict`'s `auto` arm returned a merge for every green candidate, so in
//     an `auto` project a design card merged on green with its design still `awaiting`.
//     §7a's *"`auto` means no gate"* is about the MERGE gate; the design gate is raised at
//     publish in both modes.
//   · the GitHub review sync decided the approve-to-merge gate from reviews alone, so in
//     `manual` a full set of GitHub approvals merged over an undecided design.

const store = new Map<string, { contentType: string; size: number }>();

/** Every job the promotion enqueues — the channel an auto merge goes out on. */
const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { pullRequestMergeService } = await import('@/lib/services/pullRequestMergeService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { settleGreenVerdict } = await import('@/lib/services/mergeGates');
const { evaluateForWorkItem } = await import('@/lib/services/pullRequestReviewSync');
const syncedMergeRunner = await import('@/lib/services/syncedMergeRunner');
const { githubPullRequestReviewRepository } =
  await import('@/lib/repositories/githubPullRequestReviewRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-auto-design';
const REPO_PROVIDER_ID = '882';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'auto' | 'manual') {
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
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: mode, prMergeModeDecidedAt: new Date() },
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

const green = (headSha: string, number: number) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

async function openLinked(identifier: string, number: number) {
  const headRef = `design/${identifier}-${number}`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A design (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

/** A design card with an open delivering pull request, mid-run. */
async function designCard(s: Scenario, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: `Draw the frame ${number}` },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await makeWorkWaitOn(item.id, { projectId: s.project.id, ctx: s.ctx });
  await openLinked(item.identifier, number);
  return item;
}

async function publish(s: Scenario, itemId: string, label: string) {
  const prefix = designPrefix(s.workspace.id, itemId);
  store.set(`${prefix}${label}.mock.html`, { contentType: 'text/html', size: 2048 });
  store.set(`${prefix}${label}.design-notes.md`, { contentType: 'text/markdown', size: 512 });
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: itemId,
      assets: [
        {
          kind: 'mock',
          sourcePath: `design/work-items/${label}.mock.html`,
          pathname: `${prefix}${label}.mock.html`,
        },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: `${prefix}${label}.design-notes.md`,
        },
      ],
      commitSha: shaFor(label),
    },
    s.ctx,
  );
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const awaiting = async (workItemId: string, kind: string) =>
  (await gatesOf(workItemId)).find((g) => g.kind === kind && g.state === 'awaiting');

const autoMerges = () => sent.filter((e) => e.name === 'pull-request/auto-merge.requested');

/** `settleGreenVerdict` asked directly, over the card's one delivering pull request. */
async function settle(s: Scenario, itemId: string) {
  const pr = await adminDb.workItemDelivery.findFirstOrThrow({ where: { workItemId: itemId } });
  return withWorkspaceContext(s.ctx, async (tx) => {
    const item = await tx.workItem.findUniqueOrThrow({ where: { id: itemId } });
    return settleGreenVerdict({ item, pullRequestIds: [pr.githubPullRequestId] }, s.ctx, tx);
  });
}

beforeEach(async () => {
  store.clear();
  sent.length = 0;
  await truncateAuthTables();
  _resetInstallationTokenCache();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('MOTIR-5762 — AUTO: an awaiting design holds the automatic merge', () => {
  it('a green design card with an AWAITING design gate merges nothing', async () => {
    const s = await makeScenario('adh-held@example.com', 'auto');
    const item = await designCard(s, 61);
    await publish(s, item.id, 'v1');

    await green('sha-a', 61);

    // The design question is still open, so nothing merges — neither on the promotion's
    // own channel nor when the verdict is asked for directly.
    expect(await awaiting(item.id, 'design_result')).toBeDefined();
    expect(autoMerges()).toHaveLength(0);
    expect(await settle(s, item.id)).toEqual([]);
  });

  it('once the design is APPROVED over the current result, the merge follows', async () => {
    const s = await makeScenario('adh-approved@example.com', 'auto');
    const item = await designCard(s, 62);
    await publish(s, item.id, 'v1');
    await green('sha-a', 62);
    expect(autoMerges()).toHaveLength(0);

    const design = (await awaiting(item.id, 'design_result'))!;
    const pressed = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design.id, source: 'ui' },
      s.ctx,
    );
    expect(pressed.approval.gate.state).toBe('approved');

    // ⚠️ THE SET WAS ALREADY GREEN, so no later verdict would ever come to carry this
    // approval. The press settles the card itself — exactly one merge, at the green head.
    expect(autoMerges()).toHaveLength(1);
    expect(autoMerges()[0]!.data).toMatchObject({ workItemId: item.id, headSha: 'sha-a' });

    // …and the NEXT green verdict returns the merge too, the way the manual arm's Q4
    // carry already does.
    const pr = await adminDb.workItemDelivery.findFirstOrThrow({ where: { workItemId: item.id } });
    expect(await settle(s, item.id)).toEqual([
      { pullRequestId: pr.githubPullRequestId, headSha: 'sha-a' },
    ]);
  });

  it('an approval pressed BEFORE green is carried by that green', async () => {
    const s = await makeScenario('adh-before@example.com', 'auto');
    const item = await designCard(s, 63);
    await publish(s, item.id, 'v1');
    const design = (await awaiting(item.id, 'design_result'))!;
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: design.id, source: 'ui' },
      s.ctx,
    );
    // Nothing green yet — nothing to merge.
    expect(autoMerges()).toHaveLength(0);

    await green('sha-a', 63);

    expect(autoMerges()).toHaveLength(1);
  });

  it('a design decided CHANGES_REQUESTED still holds the merge', async () => {
    const s = await makeScenario('adh-changes@example.com', 'auto');
    const item = await designCard(s, 64);
    await publish(s, item.id, 'v1');
    const design = (await awaiting(item.id, 'design_result'))!;
    await approvalGatesService.decide(
      {
        gateId: design.id,
        decision: 'request_changes',
        refusalVerdict: 'revise',
        source: 'ui',
        noteMd: 'Wrong frame.',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );

    await green('sha-a', 64);

    expect(autoMerges()).toHaveLength(0);
    expect(await settle(s, item.id)).toEqual([]);
  });

  it('an approval of a SUPERSEDED result still holds the merge', async () => {
    const s = await makeScenario('adh-superseded@example.com', 'auto');
    const item = await designCard(s, 65);
    await publish(s, item.id, 'v1');
    const v1 = (await awaiting(item.id, 'design_result'))!;
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: v1.id, source: 'ui' },
      s.ctx,
    );
    // A NEW current result the approval does not name. The publish door refuses a new
    // result on a card whose design is approved, so the state is written directly: it is
    // the state the predicate guards (a card reopened by hand and republished), not a
    // path this spec is about.
    const v1Row = await adminDb.designEvidence.findFirstOrThrow({
      where: { workItemId: item.id, isCurrent: true },
    });
    await adminDb.designEvidence.update({ where: { id: v1Row.id }, data: { isCurrent: false } });
    await adminDb.designEvidence.create({
      data: {
        workspaceId: s.workspace.id,
        workItemId: item.id,
        commitSha: shaFor('v2'),
        isCurrent: true,
      },
    });

    await green('sha-a', 65);

    expect(autoMerges()).toHaveLength(0);
    expect(await settle(s, item.id)).toEqual([]);
  });
});

describe('MOTIR-5762 — MANUAL: a GitHub approval does not merge over an awaiting design', () => {
  async function approveOnGithub(s: Scenario, itemId: string, headSha: string) {
    const delivery = await adminDb.workItemDelivery.findFirstOrThrow({
      where: { workItemId: itemId },
    });
    await withWorkspaceContext(s.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        {
          githubReviewId: `gh-${itemId}`,
          githubPullRequestId: delivery.githubPullRequestId,
          reviewerGithubUserId: '4242',
          reviewerLogin: 'ada-l',
          reviewerType: 'User',
          state: 'approved',
          commitSha: headSha,
          reviewerPermission: 'write',
          submittedAt: new Date('2026-09-19T10:00:00Z'),
          htmlUrl: null,
        },
        tx,
      ),
    );
  }

  it('holds the merge gate while the design awaits, and applies the review once it is approved', async () => {
    const mergeSpy = vi.spyOn(syncedMergeRunner, 'runSyncedMerge').mockResolvedValue();
    const s = await makeScenario('adh-review@example.com', 'manual');
    const item = await designCard(s, 66);
    await publish(s, item.id, 'v1');
    await green('sha-a', 66);
    const merge = (await awaiting(item.id, 'pull_request_approval'))!;
    expect(merge).toBeDefined();

    await approveOnGithub(s, item.id, 'sha-a');
    const held = await evaluateForWorkItem(item.id, s.workspace.id);

    // The review is recorded, the merge gate stays open, and nothing merges: the design
    // is the question a person answers first.
    expect(held.outcome).toBe('held_by_design');
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: merge.id } })).state).toBe(
      'awaiting',
    );
    expect(mergeSpy).not.toHaveBeenCalled();

    // The design decided on its own (not through the one press, which would carry the
    // merge itself) — the standing review now applies, with nobody asked twice.
    const design = (await awaiting(item.id, 'design_result'))!;
    await approvalGatesService.decide(
      {
        gateId: design.id,
        decision: 'approve',
        source: 'ui',
        noteMd: null,
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );
    const applied = await evaluateForWorkItem(item.id, s.workspace.id);
    expect(applied.outcome).toBe('decided_approved');
    expect(mergeSpy).toHaveBeenCalledTimes(1);
  });
});
