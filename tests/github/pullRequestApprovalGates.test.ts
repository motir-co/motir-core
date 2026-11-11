import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown>; gatesAtSend: number }> = [];
vi.mock('@/lib/jobs/sendEvent', async () => {
  const { adminDb: admin } = await import('../helpers/adminDb');
  return {
    sendEvent: async (name: string, data: Record<string, unknown>) => {
      // Read on ANOTHER connection at the moment of sending: a gate visible here was
      // committed before the event left.
      const gatesAtSend = await admin.approvalGate.count({
        where: { workItemId: String(data['workItemId']), kind: 'pull_request_approval' },
      });
      sent.push({ name, data, gatesAtSend });
    },
  };
});

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { promoteDeliveredCardsOnGreen } from '@/lib/services/ciPromotion';
import {
  raisePullRequestApprovalGate,
  withdrawPullRequestApprovalGatesOnCiRerun,
} from '@/lib/services/pullRequestApprovalGates';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// RAISE and WITHDRAW the `pull_request_approval` gate (Story MOTIR-4909 · MOTIR-5482;
// `approval-gates.md` §8's amendment, decisions 1, 3 and 4), against a REAL Postgres through
// the real webhook service — the same doors a GitHub delivery walks. The fixtures mirror
// `mergeGates.test.ts`, whose transaction this gate joins.
//
// ONE `awaiting` approve-and-merge gate per card, on the run target, in a `manual` project,
// once its whole delivery set is green — and `superseded` when that set changes.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-approval-gates';
const REPO_PROVIDER_ID = '992';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const KIND = 'pull_request_approval';

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

/** A CI verdict for one pull request at one commit. */
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

/** A card delivered by one pull request per number, linked and opened, at `implemented`. */
async function cardWithPrs(s: Scenario, title: string, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) await openLinked(item.identifier, number);
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

async function openLinked(identifier: string, number: number) {
  const headRef = `subtask/${identifier}-${number}`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent(
    'pull_request',
    pullRequestPayload('opened', number, headRef),
  );
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function prId(number: number): Promise<string> {
  return (await adminDb.githubPullRequest.findFirstOrThrow({ where: { number } })).id;
}

async function approvalGates(workItemId: string) {
  return adminDb.approvalGate.findMany({
    where: { workItemId, kind: KIND },
    orderBy: { createdAt: 'asc' },
  });
}

async function awaiting(workItemId: string) {
  return (await approvalGates(workItemId)).filter((g) => g.state === 'awaiting');
}

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

const promote = async (s: Scenario, number: number) =>
  promoteDeliveredCardsOnGreen({
    changeRequestId: await prId(number),
    workspaceId: s.workspace.id,
    actorUserId: s.user.id,
  });

/** A card promoted on two green pull requests, holding its one approve-and-merge gate. */
async function reviewedWithGate(email: string) {
  const s = await makeScenario(email);
  const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);
  await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
  await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
  expect(await statusOf(item.id)).toBe('in_review');
  const [gate] = await awaiting(item.id);
  expect(gate?.subjectVersion).toBe('moooon/acme#11@sha-a,moooon/acme#12@sha-b');
  return { s, item };
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

describe('RAISE — one awaiting gate per card, on the run target, when its whole set is green', () => {
  it('a card whose two pull requests turn green reaches in_review holding ONE gate over both heads', async () => {
    const s = await makeScenario('pa-raise@example.com');
    const item = await cardWithPrs(s, 'Two pull requests', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    expect(await approvalGates(item.id)).toEqual([]);

    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });
    expect(await statusOf(item.id)).toBe('in_review');
    const gates = await approvalGates(item.id);
    expect(gates).toHaveLength(1);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(gates[0]).toMatchObject({
      state: 'awaiting',
      subjectId: item.id,
      subjectVersion: 'moooon/acme#11@sha-a,moooon/acme#12@sha-b',
      routedToId: row.assigneeId ?? row.reporterId,
    });
  });

  it('routes to the ASSIGNEE when the card has one, and not to its reporter', async () => {
    const s = await makeScenario('pa-route@example.com');
    const item = await cardWithPrs(s, 'Assigned', [11]);
    const assignee = await usersService.createUser({
      email: 'pa-assignee@example.com',
      password: PASSWORD,
      name: 'Assignee',
    });
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: assignee.id } });

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });

    const [gate] = await awaiting(item.id);
    expect(gate?.routedToId).toBe(assignee.id);
  });

  it('the same card in an AUTO project reaches in_review and holds no gate', async () => {
    const s = await makeScenario('pa-auto@example.com');
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { prMergeMode: 'auto', prMergeModeDecidedAt: new Date() },
    });
    const item = await cardWithPrs(s, 'Auto', [11, 12]);

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await approvalGates(item.id)).toEqual([]);
  });

  // ⚠️ REVERSED — MOTIR-5662, one of MOTIR-5652's two root causes. The run-target
  // refusal is gone: a card with something to decide has a gate regardless of who
  // holds the run target. In a parent run the How-to-test record is written once
  // onto the PARENT, so every child resolved to `ancestor` and raised nothing,
  // while the parent's own promotion was skipped by `ContainerHasOpenChildrenError`.
  it('a CHILD a container run delivers raises its gate too, though its run target is the ANCESTOR', async () => {
    const s = await makeScenario('pa-child@example.com');
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story' },
      s.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A child', parentId: story.id },
      s.ctx,
    );
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
    // MOTIR-6971: asked only of a card IN REVIEW — the run target does not decide it,
    // and neither does green CI on its own.
    await adminDb.workItem.updateMany({
      where: { id: { in: [story.id, child.id] } },
      data: { status: 'in_review' },
    });

    const raised = await withWorkspaceContext(s.ctx, async (tx) => {
      const [childRow, storyRow] = await Promise.all(
        [child.id, story.id].map((id) => tx.workItem.findUniqueOrThrow({ where: { id } })),
      );
      return {
        child: await raisePullRequestApprovalGate(childRow!, tx),
        story: await raisePullRequestApprovalGate(storyRow!, tx),
      };
    });

    expect(raised).toEqual({ child: true, story: true });
    for (const id of [child.id, story.id]) {
      expect((await awaiting(id)).map((g) => g.subjectVersion)).toEqual(['moooon/acme#13@sha-p']);
    }
  });
});

describe('WITHDRAW — superseded when the set the gate asked about changes', () => {
  it('a NEW COMMIT supersedes the gate while the card stays in review; the next green raises a fresh one on the new head', async () => {
    const { item } = await reviewedWithGate('pa-push@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });
    expect(await awaiting(item.id)).toEqual([]);
    expect((await approvalGates(item.id)).map((g) => g.state)).toEqual(['superseded']);
    expect(await statusOf(item.id)).toBe('in_review');

    await ci({ conclusion: 'success', headSha: 'sha-a2', number: 11 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect((await awaiting(item.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#11@sha-a2,moooon/acme#12@sha-b',
    ]);
  });

  it('a `synchronize` delivery supersedes the gate', async () => {
    const { item } = await reviewedWithGate('pa-sync@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('synchronize', 11, `subtask/${item.identifier}-11`, {
        head: { ref: `subtask/${item.identifier}-11`, sha: 'sha-a3' },
      }),
    );

    expect(await awaiting(item.id)).toEqual([]);
  });

  it('a late check row for the SAME head withdraws nothing', async () => {
    const { item } = await reviewedWithGate('pa-late@example.com');

    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });

    expect(await awaiting(item.id)).toHaveLength(1);
  });

  it('a CLOSED member supersedes the gate', async () => {
    const { item } = await reviewedWithGate('pa-closed@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('closed', 12, `subtask/${item.identifier}-12`),
    );

    expect(await awaiting(item.id)).toEqual([]);
  });

  // ⚠️ MOTIR-5901 — a member MERGED ON GITHUB is settled, and the question comes back
  // about the ones still open (§4 SECOND AMENDMENT, decision 4's amendment). Until this
  // fix the close withdrew the gate and nothing ever re-raised it: the merged member
  // failed `isMergeCandidate` on every later verdict, so the open one could only be
  // merged on GitHub too.
  const mergeOnGitHub = (number: number, identifier: string) =>
    githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('closed', number, `subtask/${identifier}-${number}`, { merged: true }),
    );

  it('a member MERGED ON GITHUB withdraws the gate and re-asks at once about the set, the merged member settled', async () => {
    const { item } = await reviewedWithGate('pa-merged-gh@example.com');

    await mergeOnGitHub(11, item.identifier);

    // Held open by #12 (`deferred_open_pr`), so the card is still in review…
    expect(await statusOf(item.id)).toBe('in_review');
    // …the old gate records the close, and ONE fresh gate names the whole set.
    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'member_closed'],
      ['awaiting', null],
    ]);
    expect((await awaiting(item.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#11@sha-a,moooon/acme#12@sha-b',
    ]);
  });

  it('with the open member NOT green, the merge raises nothing — its next green raises ONE gate', async () => {
    const { item } = await reviewedWithGate('pa-merged-gh-red@example.com');
    // #12 moves to a commit CI has not spoken for: the gate goes, and nothing replaces it.
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-b2', number: 12 });
    expect(await awaiting(item.id)).toEqual([]);

    await mergeOnGitHub(11, item.identifier);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toEqual([]);

    await ci({ conclusion: 'success', headSha: 'sha-b2', number: 12 });
    expect(await statusOf(item.id)).toBe('in_review');
    expect((await awaiting(item.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#11@sha-a,moooon/acme#12@sha-b2',
    ]);
    // A redelivery of the same verdict adds none.
    await ci({ conclusion: 'success', headSha: 'sha-b2', number: 12 });
    expect(await awaiting(item.id)).toHaveLength(1);
  });

  it('a member CLOSED WITHOUT MERGING still blocks — nothing is re-asked until it is unlinked (MOTIR-5901)', async () => {
    const { s, item } = await reviewedWithGate('pa-closed-unmerged@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('closed', 12, `subtask/${item.identifier}-12`),
    );
    await ci({ conclusion: 'success', headSha: 'sha-a', number: 11 });
    expect(await awaiting(item.id)).toEqual([]);

    await githubPullRequestService.unlinkPullRequestByCoordinates(
      { workItemId: item.id, projectId: s.project.id, owner: 'moooon', name: 'acme', number: 12 },
      s.ctx,
    );
    // ⚠️ MOTIR-6971: the close pulled the card back to `in_progress`, and a card there is
    // asked nothing, however green what is left — its status has to be set right first.
    expect(await statusOf(item.id)).toBe('in_progress');
    expect(await awaiting(item.id)).toEqual([]);

    // The run settles it (`implemented`); the CI-green latch promotes it on the verdict
    // it already has, and the question comes back over the smaller set, once.
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect(await statusOf(item.id)).toBe('in_review');
    expect((await awaiting(item.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#11@sha-a',
    ]);
  });

  // ⚠️ AMENDED — MOTIR-5663. The withdrawal still happens and still records
  // `set_changed`; what is new is that the site then ASKS what the card should hold
  // now. The remaining member is green, so the answer is a gate over the SMALLER
  // set — which is the structural half of this level: a question retired for an
  // excellent reason used to leave the card with none (MOTIR-5604, paid for once at
  // one site while six others behaved the same way).
  it('UNLINKING a member supersedes the gate and re-asks over the smaller set', async () => {
    const { s, item } = await reviewedWithGate('pa-unlink@example.com');

    const result = await githubPullRequestService.unlinkPullRequestByCoordinates(
      { workItemId: item.id, projectId: s.project.id, owner: 'moooon', name: 'acme', number: 12 },
      s.ctx,
    );

    expect(result.removed).toBe(true);
    expect((await awaiting(item.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#11@sha-a',
    ]);
  });

  it('LINKING a new member supersedes the gate; re-linking one it already delivers does not', async () => {
    const { item } = await reviewedWithGate('pa-link@example.com');

    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 11,
      headRef: `subtask/${item.identifier}-11`,
    });
    expect(await awaiting(item.id)).toHaveLength(1);

    await openLinked(item.identifier, 14);
    expect(await awaiting(item.id)).toEqual([]);
  });
});

describe('one transaction, one gate per card, however the events arrive', () => {
  it('an approval-gate insert that FAILS rolls the status write and the merge gates back with it', async () => {
    const s = await makeScenario('pa-rollback@example.com');
    const item = await cardWithPrs(s, 'Rollback', [11]);
    await greenRow(11, 'sha-a');
    const create = approvalGateRepository.create.bind(approvalGateRepository);
    vi.spyOn(approvalGateRepository, 'create').mockImplementation((data, tx) =>
      data.kind === KIND ? Promise.reject(new Error('approval insert failed')) : create(data, tx),
    );
    sent.length = 0;

    await expect(promote(s, 11)).rejects.toThrow('approval insert failed');

    expect(await statusOf(item.id)).toBe('implemented');
    expect(await adminDb.approvalGate.count({ where: { workItemId: item.id } })).toBe(0);
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
  });

  it('two green events for one card, concurrently, leave ONE gate; a redelivery adds none', async () => {
    const s = await makeScenario('pa-race@example.com');
    const item = await cardWithPrs(s, 'Race', [11, 12]);
    await greenRow(11, 'sha-a');
    await greenRow(12, 'sha-b');

    await Promise.all([promote(s, 11), promote(s, 12)]);

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaiting(item.id)).toHaveLength(1);

    await Promise.all([promote(s, 11), promote(s, 11)]);
    expect(await approvalGates(item.id)).toHaveLength(1);
  });

  it('work-item/transitioned is still sent after commit, with the gate already visible', async () => {
    const s = await makeScenario('pa-event@example.com');
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
    expect(transitioned[0]!.gatesAtSend).toBe(1);
  });
});

describe('AMENDMENT 6 Q5 — the withdrawal records WHY, and the three PR causes are distinct', () => {
  // Until MOTIR-5659 a superseded row carried `state` and nothing else, so every
  // surface describing one had to guess — and MOTIR-5586 / MOTIR-5651 are the two
  // that guessed "a newer design was published" over all of them. The three
  // withdrawals below are three different sentences a person should be told, and
  // the point of these assertions is that the ROW can now tell them apart. A
  // single `expect(state).toBe('superseded')` passes with all three wired to one
  // cause, which is the state this story is undoing.

  it('a moved HEAD records `head_moved`', async () => {
    const { item } = await reviewedWithGate('pa-cause-head@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });

    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'head_moved'],
    ]);
  });

  it('a CLOSED member records `member_closed`', async () => {
    const { item } = await reviewedWithGate('pa-cause-closed@example.com');

    await githubWebhookService.handleEvent(
      'pull_request',
      pullRequestPayload('closed', 12, `subtask/${item.identifier}-12`),
    );

    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'member_closed'],
    ]);
  });

  // Two tests rather than one: each scenario reuses the same pull-request numbers,
  // and only `beforeEach` truncates — a second `reviewedWithGate` in one test
  // inherits the first card's green check rows and never passes through
  // `implemented`.
  it('a member JOINING the set records `set_changed`', async () => {
    const { item } = await reviewedWithGate('pa-cause-join@example.com');

    await openLinked(item.identifier, 14);

    expect((await approvalGates(item.id)).map((g) => g.supersededCause)).toEqual(['set_changed']);
  });

  it('a member LEAVING the set records `set_changed` too', async () => {
    const { s, item } = await reviewedWithGate('pa-cause-unlink@example.com');

    await githubPullRequestService.unlinkPullRequestByCoordinates(
      { workItemId: item.id, projectId: s.project.id, owner: 'moooon', name: 'acme', number: 12 },
      s.ctx,
    );

    // Two rows now (MOTIR-5663): the withdrawn one carrying its cause, and the
    // fresh question over the smaller set — which carries none, because it is a
    // question rather than a withdrawal.
    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'set_changed'],
      ['awaiting', null],
    ]);
  });

  it('an AWAITING gate carries NO cause — the column describes a withdrawal, not a question', async () => {
    const { item } = await reviewedWithGate('pa-cause-awaiting@example.com');

    expect((await awaiting(item.id)).map((g) => g.supersededCause)).toEqual([null]);
  });

  it('a cause is not an ACTOR: the withdrawal still writes no decider, authority or note', async () => {
    // §6b's invariant, re-asserted because this story is the first thing to add a
    // column to that write. A cause says what happened to the SUBJECT; it must
    // not become the toehold by which a product write starts looking like a
    // person's answer.
    const { item } = await reviewedWithGate('pa-cause-noactor@example.com');

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-a2', number: 11 });

    const [row] = await approvalGates(item.id);
    expect(row).toMatchObject({ state: 'superseded', supersededCause: 'head_moved' });
    expect({
      decidedById: row!.decidedById,
      decidedAt: row!.decidedAt,
      decidedByLabel: row!.decidedByLabel,
      decidedUnderAuthority: row!.decidedUnderAuthority,
      decisionSource: row!.decisionSource,
      noteMd: row!.noteMd,
    }).toEqual({
      decidedById: null,
      decidedAt: null,
      decidedByLabel: null,
      decidedUnderAuthority: null,
      decisionSource: null,
      noteMd: null,
    });
  });

  // ── A RED BUILD WITHDRAWS THE QUESTION (MOTIR-6271) ─────────────────────────
  //
  // `approval-gates.md` §8's amendment, decision 2 states the rule over EVERY event —
  // *the question rides on the green set, so every event that takes the set out of green
  // withdraws it* — and its enumeration (head move, close, draft, set change) omitted the
  // most direct one. So a gate raised on a green verdict and contradicted by the build
  // minutes later stood for ever, asking a person to approve a pull request whose suite
  // was red. Observed on moooon-B-V/motir-core#3112 @ 88508fb2: raised 22:45:19, `Vitest
  // (3/12)` and `(6/12)` failed at 22:58, `CI complete` at 23:02:17, and the gate was
  // still `awaiting` over that commit hours later.

  it('a terminal FAILURE at the asked-about commits withdraws the gate and holds the card at Implemented', async () => {
    const { item } = await reviewedWithGate('pa-red-withdraws@example.com');

    // The SAME commit the gate was raised over — nothing moved, the build simply spoke.
    await ci({ conclusion: 'failure', headSha: 'sha-a', number: 11 });

    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'ci_failed'],
    ]);
    // In Review is a promise that a person should look now; a red set is not one anybody
    // can act on, so the card goes back to where its pull request is merely open.
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('the withdrawal is a CAUSE and not an actor — no decider, authority or note', async () => {
    // §6b's invariant, re-asserted for the new writing path exactly as MOTIR-5659 asserted
    // it for the first six: a cause says what happened to the SUBJECT, and must never be
    // the toehold by which a product write starts reading as somebody's answer.
    const { item } = await reviewedWithGate('pa-red-noactor@example.com');

    await ci({ conclusion: 'failure', headSha: 'sha-a', number: 11 });

    const [row] = await approvalGates(item.id);
    expect(row).toMatchObject({ state: 'superseded', supersededCause: 'ci_failed' });
    expect({
      decidedById: row!.decidedById,
      decidedAt: row!.decidedAt,
      decidedByLabel: row!.decidedByLabel,
      decidedUnderAuthority: row!.decidedUnderAuthority,
      decisionSource: row!.decisionSource,
      noteMd: row!.noteMd,
    }).toEqual({
      decidedById: null,
      decidedAt: null,
      decidedByLabel: null,
      decidedUnderAuthority: null,
      decisionSource: null,
      noteMd: null,
    });
  });

  it('the NEXT green raises a FRESH question over the commits that fixed it', async () => {
    // What makes withdrawing right rather than merely tidy: the question comes back by
    // itself. Withdraw-and-never-re-ask would strand the card unapprovable, which is the
    // defect MOTIR-5604 paid for from the other direction.
    const { item } = await reviewedWithGate('pa-red-then-green@example.com');
    await ci({ conclusion: 'failure', headSha: 'sha-a', number: 11 });
    expect(await awaiting(item.id)).toHaveLength(0);

    // A push fixing the build, then green on BOTH members at their current heads.
    await ci({ conclusion: 'success', headSha: 'sha-a3', number: 11 });
    await ci({ conclusion: 'success', headSha: 'sha-b', number: 12 });

    const [fresh] = await awaiting(item.id);
    expect(fresh?.subjectVersion).toBe('moooon/acme#11@sha-a3,moooon/acme#12@sha-b');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a DECIDED gate is untouched by a later red — §8 decision 5', async () => {
    // A failure AFTER an approval re-opens the merge question through its own doors
    // (*Queue again*, a push). It does not reach back and rewrite the answer a person
    // already gave, and the audit must go on reading that answer as theirs.
    const { s, item } = await reviewedWithGate('pa-red-after-decision@example.com');
    const [gate] = await awaiting(item.id);
    await adminDb.approvalGate.update({
      where: { id: gate!.id },
      data: {
        state: 'approved',
        decidedById: s.user.id,
        decidedAt: new Date(),
        decidedByLabel: 'Owner',
      },
    });

    await ci({ conclusion: 'failure', headSha: 'sha-a', number: 11 });

    const [row] = await approvalGates(item.id);
    expect(row).toMatchObject({ state: 'approved', supersededCause: null });
    expect(row!.decidedById).toBe(s.user.id);
  });

  it('a card NOT at In Review loses its gate and is not dragged anywhere', async () => {
    // Only the rung where a person is being asked moves. A card already at Implemented,
    // mid-merge at Approved, or in a terminal status is left exactly where it is — the
    // withdrawal is the part that matters for *To approve*.
    const s = await makeScenario('pa-red-not-in-review@example.com');
    const item = await cardWithPrs(s, 'One pull request', [13]);
    expect(await statusOf(item.id)).toBe('implemented');

    await ci({ conclusion: 'failure', headSha: 'sha-c', number: 13 });

    expect(await awaiting(item.id)).toHaveLength(0);
    expect(await statusOf(item.id)).toBe('implemented');
  });
});

// ── A SET THAT LEAVES GREEN WITHOUT GOING RED WITHDRAWS IT TOO (MOTIR-6946) ──────
//
// The other arm of the asymmetry MOTIR-6271 closed the red half of. On
// moooon-B-V/motir-core#3261 @ 688ce704 the gate was raised at 18:40:08 over a set the
// acceptance lane alone had made green; CI's first job was created at 18:40:58, its checks
// arrived `pending` at the SAME head, and the question stood `awaiting` for the whole run —
// a person could press Approve over commits whose tests had not finished.

/** One check at one commit, as its `check_run` delivery arrives. */
const checkRun = (opts: {
  name: string;
  headSha: string;
  number: number;
  status: string;
  conclusion?: string | null;
  suiteId?: number;
}) =>
  githubWebhookService.handleEvent('check_run', {
    action: opts.status === 'completed' ? 'completed' : 'created',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      name: opts.name,
      head_sha: opts.headSha,
      status: opts.status,
      conclusion: opts.conclusion ?? null,
      pull_requests: [{ number: opts.number }],
      check_suite: { id: opts.suiteId ?? 36613621931, head_branch: null },
    },
  });

describe('a PENDING check at the asked-about commits withdraws the question (MOTIR-6946)', () => {
  it('supersedes the gate as `ci_rerunning` and takes the card out of In Review', async () => {
    const { item } = await reviewedWithGate('pa-rerun-withdraws@example.com');

    // The SAME commit the gate was raised over — a check the set did not have starts.
    await checkRun({ name: 'Vitest (1/12)', headSha: 'sha-a', number: 11, status: 'queued' });

    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'ci_rerunning'],
    ]);
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('the next all-green delivery raises exactly ONE fresh question over the same commits', async () => {
    const { item } = await reviewedWithGate('pa-rerun-then-green@example.com');
    await checkRun({ name: 'Vitest (1/12)', headSha: 'sha-a', number: 11, status: 'in_progress' });
    expect(await awaiting(item.id)).toHaveLength(0);

    // Nothing was pushed: the check simply finishes, and the set is green again.
    await checkRun({
      name: 'Vitest (1/12)',
      headSha: 'sha-a',
      number: 11,
      status: 'completed',
      conclusion: 'success',
    });

    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'ci_rerunning'],
      ['awaiting', null],
    ]);
    const [fresh] = await awaiting(item.id);
    expect(fresh?.subjectVersion).toBe('moooon/acme#11@sha-a,moooon/acme#12@sha-b');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a pending check at a NEW head is a head move, never `ci_rerunning`', async () => {
    const { item } = await reviewedWithGate('pa-rerun-new-head@example.com');

    await checkRun({ name: 'Vitest (1/12)', headSha: 'sha-a2', number: 11, status: 'queued' });

    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'head_moved'],
    ]);
  });

  it('a DECIDED gate is untouched by a later pending check — §8 decision 5', async () => {
    const { s, item } = await reviewedWithGate('pa-rerun-after-decision@example.com');
    const [gate] = await awaiting(item.id);
    await adminDb.approvalGate.update({
      where: { id: gate!.id },
      data: {
        state: 'approved',
        decidedById: s.user.id,
        decidedAt: new Date(),
        decidedByLabel: 'Owner',
      },
    });

    await checkRun({ name: 'Vitest (1/12)', headSha: 'sha-a', number: 11, status: 'queued' });

    const [row] = await approvalGates(item.id);
    expect(row).toMatchObject({ state: 'approved', supersededCause: null });
    expect(row!.decidedById).toBe(s.user.id);
  });

  it('a red check after the rerun still withdraws as `ci_failed` — MOTIR-6271 is unchanged', async () => {
    const { item } = await reviewedWithGate('pa-rerun-then-red@example.com');

    await checkRun({
      name: 'Vitest (1/12)',
      headSha: 'sha-a',
      number: 11,
      status: 'completed',
      conclusion: 'failure',
    });

    expect((await approvalGates(item.id)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'ci_failed'],
    ]);
    expect(await statusOf(item.id)).toBe('implemented');
  });

  // ── The withdrawer on its own, for the arms no delivery reaches ─────────────
  const rerun = (s: Scenario, number: number) =>
    prId(number).then((id) =>
      withWorkspaceContext(s.ctx, (tx) => withdrawPullRequestApprovalGatesOnCiRerun(id, tx)),
    );

  it('leaves a gate whose version is no longer the current set — a head move owns it', async () => {
    const { s, item } = await reviewedWithGate('pa-rerun-stale-version@example.com');
    // A newer head recorded straight onto the pull request, as a late row does before its
    // `pull_request` delivery: the set's version no longer matches the one asked about.
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: await prId(11),
        commitSha: 'sha-a9',
        checkName: 'Vitest (1/12)',
        conclusion: 'pending',
      },
    });

    expect(await rerun(s, 11)).toEqual([]);
    expect((await approvalGates(item.id)).map((g) => g.state)).toEqual(['awaiting']);
  });

  it('reports no card when the supersede retired nothing (a concurrent withdrawal won)', async () => {
    const { s, item } = await reviewedWithGate('pa-rerun-lost-race@example.com');
    vi.spyOn(approvalGateRepository, 'supersedeAwaitingByWorkItem').mockResolvedValueOnce(0);

    expect(await rerun(s, 11)).toEqual([]);
    expect((await approvalGates(item.id)).map((g) => g.state)).toEqual(['awaiting']);
  });

  it('retires a standing ACCEPTANCE question with the merge question, under the same cause', async () => {
    const { s, item } = await reviewedWithGate('pa-rerun-acceptance@example.com');
    // An acceptance question the card is not owed on its own (a task, no receipt) — the
    // predicate answers "no longer owed", so it goes with the merge question.
    await adminDb.approvalGate.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: item.id,
        kind: 'acceptance_result',
        subjectId: 'receipt-rerun',
        state: 'awaiting',
        subjectVersion: 'receipt-rerun@1',
      },
    });

    expect(await rerun(s, 11)).toEqual([item.id]);
    const acceptance = await adminDb.approvalGate.findMany({
      where: { workItemId: item.id, kind: 'acceptance_result' },
    });
    expect(acceptance.map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'ci_rerunning'],
    ]);
  });
});
