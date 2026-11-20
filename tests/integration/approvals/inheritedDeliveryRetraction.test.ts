import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkPrByIdentifier } from '../../helpers/prLink';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { RawPreplanStateResponse } from '@/lib/ai/types';

// AN INHERITED DELIVERY FOLLOWS ITS CHILD (Bug MOTIR-11839), on a REAL Postgres through
// the real link, unlink, move, file, plan-approve, settings, webhook and reconcile doors.
//
// MOTIR-11835 made a link write the child's pull request on every non-epic ancestor
// (`inherited = true`) when "Complete children when a parent is done" is on, and nothing
// took it back: unlinking the child left the parent merging a pull request somebody had
// declared was not this work, a re-parent left the OLD parent delivering it while the new
// one never did, and turning the switch off left every row standing. The inherited rows
// are now reconciled against the rule wherever its inputs move — and a row an ancestor was
// linked to in its own right is never touched.
//
// Deleting the child is one more such input (Bug MOTIR-11901): the FK cascade took the
// child's own row, but not the row its parent inherited from it.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

const { getPreplanState } = await import('@/lib/ai/motirAiClient');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { foldersService } = await import('@/lib/services/foldersService');
const { plansService } = await import('@/lib/services/plansService');
const { projectStatusAutomationService } =
  await import('@/lib/services/projectStatusAutomationService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { githubPullRequestService } = await import('@/lib/services/githubPullRequestService');
const { reconcileInheritedDeliveries } = await import('@/lib/services/inheritedDeliveryService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { workItemDeliveryRepository } =
  await import('@/lib/repositories/workItemDeliveryRepository');

const INSTALLATION_ID = 'inst-11839';
const REPO_PROVIDER_ID = '11839';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

async function makeScenario(email: string, opts: { cascade: boolean } = { cascade: true }) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
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
    data: { autoCompleteChildrenOnParentDone: opts.cascade },
  });
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
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

const ci = (headSha: string, number: number) =>
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

const pullRequestEvent = (number: number, headRef: string, merged = false) =>
  githubWebhookService.handleEvent('pull_request', {
    action: merged ? 'closed' : 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: merged ? 'closed' : 'open',
      merged,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });

const link = (identifier: string, number: number, headRef = `branch/${number}`) =>
  linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });

const unlink = (s: Scenario, item: { id: string }, number: number) =>
  githubPullRequestService.unlinkPullRequestByCoordinates(
    { workItemId: item.id, projectId: s.project.id, owner: 'moooon', name: 'acme', number },
    s.ctx,
  );

const prId = async (number: number) =>
  (await adminDb.githubPullRequest.findFirstOrThrow({ where: { number } })).id;

/** The pull requests a card delivers, as stored, each with its provenance. */
async function deliveries(workItemId: string): Promise<string[]> {
  const rows = await adminDb.workItemDelivery.findMany({
    where: { workItemId },
    select: { githubPullRequestId: true, inherited: true },
  });
  const prs = await adminDb.githubPullRequest.findMany({
    where: { id: { in: rows.map((r) => r.githubPullRequestId) } },
    select: { id: true, number: true },
  });
  const numberOf = new Map(prs.map((p) => [p.id, p.number]));
  return rows
    .map((r) => `#${numberOf.get(r.githubPullRequestId)}${r.inherited ? ' inherited' : ''}`)
    .sort();
}

const mergeGatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'pull_request_approval' },
    orderBy: { createdAt: 'asc' },
  });

const awaitingOf = async (workItemId: string) =>
  (await mergeGatesOf(workItemId)).filter((g) => g.state === 'awaiting');

const create = (
  s: Scenario,
  kind: 'epic' | 'story' | 'task' | 'subtask',
  title: string,
  parentId?: string,
) => workItemsService.createWorkItem({ projectId: s.project.id, kind, title, parentId }, s.ctx);

async function story(s: Scenario, title = 'The story', children = 1) {
  const parent = await create(s, 'story', title);
  const kids = [];
  for (let i = 0; i < children; i++)
    kids.push(await create(s, 'subtask', `${title} ${i}`, parent.id));
  return { parent, kids };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  vi.mocked(getPreplanState).mockResolvedValue({
    session: null,
    docs: [],
    catalog: null,
  } as RawPreplanStateResponse);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe("unlinking a child's pull request (AC 1)", () => {
  it('reproduction: the story stops delivering the pull request its child was unlinked from', async () => {
    const s = await makeScenario('11839-unlink@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await link(child!.identifier, 10);
    expect(await deliveries(parent.id)).toEqual(['#10 inherited']);

    expect(await unlink(s, child!, 10)).toMatchObject({ removed: true });

    expect(await deliveries(child!.id)).toEqual([]);
    expect(await deliveries(parent.id)).toEqual([]);
  });

  it('keeps a delivery the story was linked to explicitly', async () => {
    const s = await makeScenario('11839-explicit@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await link(child!.identifier, 11);
    await link(parent.identifier, 11);
    expect(await deliveries(parent.id)).toEqual(['#11']);

    await unlink(s, child!, 11);

    expect(await deliveries(parent.id)).toEqual(['#11']);
  });

  it('keeps it while another child still delivers the same pull request', async () => {
    const s = await makeScenario('11839-sibling@example.com');
    const {
      parent,
      kids: [a, b],
    } = await story(s, 'The story', 2);
    await link(a!.identifier, 12);
    await link(b!.identifier, 12);

    await unlink(s, a!, 12);
    expect(await deliveries(parent.id)).toEqual(['#12 inherited']);

    await unlink(s, b!, 12);
    expect(await deliveries(parent.id)).toEqual([]);
  });

  it('retracts every level it was inherited on, below the epic', async () => {
    const s = await makeScenario('11839-tree@example.com');
    const epic = await create(s, 'epic', 'The epic');
    const top = await create(s, 'story', 'The story', epic.id);
    const task = await create(s, 'task', 'The task', top.id);
    const sub = await create(s, 'subtask', 'The subtask', task.id);
    await link(sub.identifier, 13);
    expect([await deliveries(task.id), await deliveries(top.id)]).toEqual([
      ['#13 inherited'],
      ['#13 inherited'],
    ]);

    await unlink(s, sub, 13);

    for (const id of [sub.id, task.id, top.id, epic.id]) expect(await deliveries(id)).toEqual([]);
  });

  it("retracts through the picker's door too (`unlinkPullRequest`)", async () => {
    const s = await makeScenario('11839-picker@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await link(child!.identifier, 14);

    const result = await githubPullRequestService.unlinkPullRequest(
      child!.id,
      await prId(14),
      s.ctx,
    );

    expect(result).toEqual({ removed: true });
    expect(await deliveries(parent.id)).toEqual([]);
  });

  it("leaves the story's inherited row standing — and says so — while the child still delivers it", async () => {
    const s = await makeScenario('11839-unlink-parent@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await link(child!.identifier, 15);

    // The story's merge still closes the child, so the rule writes the row straight back.
    expect(await unlink(s, parent, 15)).toMatchObject({ removed: false });
    expect(
      await githubPullRequestService.unlinkPullRequest(parent.id, await prId(15), s.ctx),
    ).toEqual({ removed: false });
    expect(await deliveries(parent.id)).toEqual(['#15 inherited']);
  });
});

describe('moving a child to another parent (AC 2)', () => {
  it('reproduction: the inherited delivery moves from the old story to the new one', async () => {
    const s = await makeScenario('11839-move@example.com');
    const {
      parent: from,
      kids: [child],
    } = await story(s, 'From');
    const { parent: to } = await story(s, 'To', 0);
    await link(child!.identifier, 20);

    await workItemsService.moveWorkItem(child!.id, { newParentId: to.id }, s.ctx);

    expect(await deliveries(from.id)).toEqual([]);
    expect(await deliveries(to.id)).toEqual(['#20 inherited']);
    expect(await deliveries(child!.id)).toEqual(['#20']);
  });

  it('follows a re-parent through the edit door (`updateWorkItem`), and leaves an explicit link behind', async () => {
    const s = await makeScenario('11839-patch@example.com');
    const {
      parent: from,
      kids: [child],
    } = await story(s, 'From');
    const { parent: to } = await story(s, 'To', 0);
    await link(child!.identifier, 21);
    await link(child!.identifier, 22);
    await link(from.identifier, 22);

    await workItemsService.updateWorkItem(child!.id, { parentId: to.id }, s.ctx);

    expect(await deliveries(from.id)).toEqual(['#22']);
    expect(await deliveries(to.id)).toEqual(['#21 inherited', '#22 inherited']);
  });

  it('moves a whole subtree: a task carries its subtask’s pull request to the new story', async () => {
    const s = await makeScenario('11839-subtree@example.com');
    const from = await create(s, 'story', 'From');
    const to = await create(s, 'story', 'To');
    const task = await create(s, 'task', 'The task', from.id);
    const sub = await create(s, 'subtask', 'The subtask', task.id);
    await link(sub.identifier, 23);

    await workItemsService.moveWorkItem(task.id, { newParentId: to.id }, s.ctx);

    expect(await deliveries(task.id)).toEqual(['#23 inherited']);
    expect(await deliveries(from.id)).toEqual([]);
    expect(await deliveries(to.id)).toEqual(['#23 inherited']);
  });

  it('retracts it when the child moves to the top level, or is filed into a folder', async () => {
    const s = await makeScenario('11839-unparent@example.com');
    // Tasks, not subtasks: a subtask cannot stand at the top level.
    const parent = await create(s, 'story', 'The story');
    const a = await create(s, 'task', 'Task a', parent.id);
    const b = await create(s, 'task', 'Task b', parent.id);
    await link(a.identifier, 24);
    await link(b.identifier, 25);
    const folder = await foldersService.createFolder(
      { projectId: s.project.id, parentFolderId: null, name: 'Parked' },
      s.ctx,
    );

    await workItemsService.moveWorkItem(a.id, { newParentId: null }, s.ctx);
    expect(await deliveries(parent.id)).toEqual(['#25 inherited']);

    await workItemsService.fileWorkItem(b.id, { folderId: folder.id }, s.ctx);
    expect(await deliveries(parent.id)).toEqual([]);
  });

  it('follows a re-parent an approved plan makes', async () => {
    const s = await makeScenario('11839-plan@example.com');
    const {
      parent: from,
      kids: [child],
    } = await story(s, 'From');
    const { parent: to } = await story(s, 'To', 0);
    await link(child!.identifier, 26);

    const plan = await plansService.createPlan(s.project.id, { title: 'Move it' }, s.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: child!.id, patch: { parentRef: to.id } }],
      s.ctx,
    );
    await plansService.markPlanned(plan.id, s.ctx);
    await plansService.approvePlan(plan.id, s.ctx);

    expect(await deliveries(from.id)).toEqual([]);
    expect(await deliveries(to.id)).toEqual(['#26 inherited']);
  });

  it('writes nothing with the switch off', async () => {
    const s = await makeScenario('11839-move-off@example.com', { cascade: false });
    const {
      parent: from,
      kids: [child],
    } = await story(s, 'From');
    const { parent: to } = await story(s, 'To', 0);
    await link(child!.identifier, 27);

    await workItemsService.moveWorkItem(child!.id, { newParentId: to.id }, s.ctx);

    expect([await deliveries(from.id), await deliveries(to.id)]).toEqual([[], []]);
  });
});

describe('each removal re-asks the parent over its new set (AC 3)', () => {
  /** A story with its own green pull request #30 and a child's green #31, asked once over both. */
  async function askedOverBoth(email: string, childKind: 'subtask' | 'task' = 'subtask') {
    const s = await makeScenario(email);
    const parent = await create(s, 'story', 'The story');
    const child = await create(s, childKind, 'The child', parent.id);
    for (const item of [parent, child]) {
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    }
    const storyRef = `story/${parent.identifier}`;
    const childRef = `subtask/${child.identifier}`;
    await link(parent.identifier, 30, storyRef);
    await link(child.identifier, 31, childRef);
    await pullRequestEvent(30, storyRef);
    await pullRequestEvent(31, childRef);
    await workItemsService.updateStatus(child.id, 'implemented', s.ctx);
    await workItemsService.updateStatus(parent.id, 'implemented', s.ctx);
    await ci('sha-story', 30);
    await ci('sha-child', 31);
    const [before] = await awaitingOf(parent.id);
    expect(before!.subjectVersion).toContain('#30@sha-story');
    expect(before!.subjectVersion).toContain('#31@sha-child');
    return { s, parent, child: child, before: before! };
  }

  it('on an unlink: the question over both is withdrawn as `set_changed` and asked again over #30 alone', async () => {
    const { s, parent, child, before } = await askedOverBoth('11839-gate-unlink@example.com');

    await unlink(s, child, 31);

    const gates = await mergeGatesOf(parent.id);
    expect(gates.find((g) => g.id === before.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'set_changed',
    });
    const awaiting = gates.filter((g) => g.state === 'awaiting');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.subjectVersion).toBe('moooon/acme#30@sha-story');
  });

  it('on a move: the old story is re-asked over #30 alone, and the new story is asked about #31', async () => {
    const { s, parent, child, before } = await askedOverBoth('11839-gate-move@example.com');
    const to = await create(s, 'story', 'To');

    await workItemsService.moveWorkItem(child.id, { newParentId: to.id }, s.ctx);

    const gates = await mergeGatesOf(parent.id);
    expect(gates.find((g) => g.id === before.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'set_changed',
    });
    expect((await awaitingOf(parent.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#30@sha-story',
    ]);
    expect(await deliveries(to.id)).toEqual(['#31 inherited']);
    // The child is still asked nothing: its pull request is its new story's.
    expect(await mergeGatesOf(child.id)).toEqual([]);
  });

  for (const [how, moveOut] of [
    [
      'moved to the top level',
      (s: Scenario, id: string) => workItemsService.moveWorkItem(id, { newParentId: null }, s.ctx),
    ],
    [
      'filed into a folder',
      async (s: Scenario, id: string) => {
        const folder = await foldersService.createFolder(
          { projectId: s.project.id, parentFolderId: null, name: 'Parked' },
          s.ctx,
        );
        return workItemsService.fileWorkItem(id, { folderId: folder.id }, s.ctx);
      },
    ],
  ] as const) {
    it(`on a child ${how}: the story is re-asked over #30, and the child is asked about its own #31`, async () => {
      const { s, parent, child } = await askedOverBoth(
        `11839-gate-out-${how.length}@example.com`,
        'task',
      );

      await moveOut(s, child.id);

      expect((await awaitingOf(parent.id)).map((g) => g.subjectVersion)).toEqual([
        'moooon/acme#30@sha-story',
      ]);
      expect((await awaitingOf(child.id)).map((g) => g.subjectVersion)).toEqual([
        'moooon/acme#31@sha-child',
      ]);
    });
  }

  it('on a delete: the question over both is withdrawn as `set_changed` and asked again over #30 alone', async () => {
    const { s, parent, child, before } = await askedOverBoth('11901-gate-delete@example.com');

    await workItemsService.deleteWorkItem(child.id, s.ctx);

    expect(await deliveries(parent.id)).toEqual(['#30']);
    const gates = await mergeGatesOf(parent.id);
    expect(gates.find((g) => g.id === before.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'set_changed',
    });
    expect(gates.filter((g) => g.state === 'awaiting').map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#30@sha-story',
    ]);
  });

  it("unlinking the story's inherited row while the child delivers it leaves the question alone", async () => {
    const { s, parent, before } = await askedOverBoth('11839-gate-noop@example.com');

    expect(await unlink(s, parent, 31)).toMatchObject({ removed: false });

    expect(await mergeGatesOf(parent.id)).toEqual([
      expect.objectContaining({ id: before.id, state: 'awaiting' }),
    ]);
  });

  it('on the switch turned off: the story is re-asked over #30, and the child is asked about its own #31', async () => {
    const { s, parent, child, before } = await askedOverBoth('11839-gate-switch@example.com');

    await projectStatusAutomationService.updateStatusAutomation(
      'ACME',
      { autoCompleteChildrenOnParentDone: false },
      s.ctx,
    );

    expect(await deliveries(parent.id)).toEqual(['#30']);
    expect((await mergeGatesOf(parent.id)).find((g) => g.id === before.id)).toMatchObject({
      state: 'superseded',
      supersededCause: 'set_changed',
    });
    expect((await awaitingOf(parent.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#30@sha-story',
    ]);
    expect((await awaitingOf(child.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#31@sha-child',
    ]);
  });
});

describe('deleting a child (Bug MOTIR-11901)', () => {
  it('reproduction: the story stops delivering the pull request its deleted child delivered', async () => {
    const s = await makeScenario('11901-delete@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await link(child!.identifier, 60);
    expect(await deliveries(parent.id)).toEqual(['#60 inherited']);

    await workItemsService.deleteWorkItem(child!.id, s.ctx);

    expect(await deliveries(parent.id)).toEqual([]);
    expect(await adminDb.workItemDelivery.count()).toBe(0);
  });

  it('keeps a delivery the story was linked to explicitly', async () => {
    const s = await makeScenario('11901-explicit@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await link(child!.identifier, 61);
    await link(parent.identifier, 61);

    await workItemsService.deleteWorkItem(child!.id, s.ctx);

    expect(await deliveries(parent.id)).toEqual(['#61']);
  });

  it('keeps it while another child still delivers the same pull request', async () => {
    const s = await makeScenario('11901-sibling@example.com');
    const {
      parent,
      kids: [a, b],
    } = await story(s, 'The story', 2);
    await link(a!.identifier, 62);
    await link(b!.identifier, 62);

    await workItemsService.deleteWorkItem(a!.id, s.ctx);
    expect(await deliveries(parent.id)).toEqual(['#62 inherited']);

    await workItemsService.deleteWorkItem(b!.id, s.ctx);
    expect(await deliveries(parent.id)).toEqual([]);
  });

  it('deleting a task retracts what its story inherited from the subtask under it, and leaves the rest', async () => {
    const s = await makeScenario('11901-subtree@example.com');
    const epic = await create(s, 'epic', 'The epic');
    const top = await create(s, 'story', 'The story', epic.id);
    const gone = await create(s, 'task', 'The deleted task', top.id);
    const sub = await create(s, 'subtask', 'Its subtask', gone.id);
    const kept = await create(s, 'task', 'The kept task', top.id);
    await link(sub.identifier, 63);
    await link(kept.identifier, 64);
    expect(await deliveries(top.id)).toEqual(['#63 inherited', '#64 inherited']);

    await workItemsService.deleteWorkItem(gone.id, s.ctx);

    expect(await deliveries(top.id)).toEqual(['#64 inherited']);
    expect(await deliveries(epic.id)).toEqual([]);
  });

  it('a deleted top-level card, or one that delivered nothing, leaves every other row alone', async () => {
    const s = await makeScenario('11901-noop@example.com');
    const {
      parent,
      kids: [child, quiet],
    } = await story(s, 'The story', 2);
    const lone = await create(s, 'task', 'A lone task');
    await link(child!.identifier, 65);
    await link(lone.identifier, 66);

    await workItemsService.deleteWorkItem(quiet!.id, s.ctx);
    await workItemsService.deleteWorkItem(lone.id, s.ctx);

    expect([await deliveries(child!.id), await deliveries(parent.id)]).toEqual([
      ['#65'],
      ['#65 inherited'],
    ]);
  });
});

describe('the switch itself', () => {
  it('turned on, writes the inherited rows for open pull requests and leaves merged ones as history', async () => {
    const s = await makeScenario('11839-switch-on@example.com', { cascade: false });
    const {
      parent,
      kids: [a, b],
    } = await story(s, 'The story', 2);
    await link(a!.identifier, 40, 'a');
    await link(b!.identifier, 41, 'b');
    await pullRequestEvent(40, 'a');
    await pullRequestEvent(41, 'b', true);
    expect(await deliveries(parent.id)).toEqual([]);

    await projectStatusAutomationService.updateStatusAutomation(
      'ACME',
      { autoCompleteChildrenOnParentDone: true },
      s.ctx,
    );

    expect(await deliveries(parent.id)).toEqual(['#40 inherited']);
  });

  it('a save that does not flip it reconciles nothing', async () => {
    const s = await makeScenario('11839-switch-same@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await link(child!.identifier, 42);
    // A stale row the rule would remove — left alone, because the switch did not move.
    await adminDb.workItemDelivery.deleteMany({ where: { workItemId: child!.id } });

    await projectStatusAutomationService.updateStatusAutomation(
      'ACME',
      { autoCompleteChildrenOnParentDone: true, autoRollupParentStatus: false },
      s.ctx,
    );

    expect(await deliveries(parent.id)).toEqual(['#42 inherited']);
  });
});

describe('the reconcile', () => {
  it('is idempotent, and answers nothing for a pull request nobody delivers', async () => {
    const s = await makeScenario('11839-idem@example.com');
    const {
      kids: [child],
    } = await story(s);
    await link(child!.identifier, 50);
    await pullRequestEvent(51, 'nobody');

    const ids = [await prId(50), await prId(51)];
    const again = await withWorkspaceContext(s.ctx, async (tx) => [
      await reconcileInheritedDeliveries([ids[0]!], tx),
      await reconcileInheritedDeliveries([ids[1]!], tx),
      await reconcileInheritedDeliveries([], tx),
    ]);

    expect(again).toEqual([[], [], []]);
    expect(
      await withWorkspaceContext(s.ctx, (tx) =>
        workItemDeliveryRepository.listPullRequestIdsByWorkItems([], tx),
      ),
    ).toEqual([]);
  });

  it("a re-link through the picker's door changes nothing", async () => {
    const s = await makeScenario('11839-relink@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await link(child!.identifier, 52);

    await githubPullRequestService.linkPullRequest(child!.id, await prId(52), s.ctx);

    expect([await deliveries(child!.id), await deliveries(parent.id)]).toEqual([
      ['#52'],
      ['#52 inherited'],
    ]);
  });
});
