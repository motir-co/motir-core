import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkPrByIdentifier } from '../../helpers/prLink';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// A CHILD'S OWN PULL REQUEST JOINS ITS PARENT'S MERGE SET (Bug MOTIR-11835), on a REAL
// Postgres through the real link, webhook, status and reconcile doors.
//
// The defect, as MOTIR-11017 met it: the story delivered one pull request, its child shipped
// in another repository on a pull request of its OWN, and the story was never linked to the
// child's. Approving the story merged only the story's; "Complete children when a parent is
// done" then closed the child with its pull request open and its own approve-and-merge
// question awaiting on a Done card. With that setting on, a link now writes the same delivery
// on every non-epic ancestor, so the parent's ONE question covers the child's pull request,
// and the child (whose pull request an ancestor now also delivers, MOTIR-11624) is asked
// nothing. With the setting off nothing is inherited.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { githubPullRequestService } = await import('@/lib/services/githubPullRequestService');

const INSTALLATION_ID = 'inst-11835';
const REPO_PROVIDER_ID = '11835';
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

const opened = (number: number, headRef: string) =>
  githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });

const link = (identifier: string, number: number, headRef: string) =>
  linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });

/** The pull-request numbers a card delivers, as stored. */
async function deliveredNumbers(workItemId: string): Promise<number[]> {
  const rows = await adminDb.workItemDelivery.findMany({
    where: { workItemId },
    select: { githubPullRequestId: true },
  });
  const prs = await adminDb.githubPullRequest.findMany({
    where: { id: { in: rows.map((r) => r.githubPullRequestId) } },
    select: { number: true },
  });
  return prs.map((p) => p.number).sort((a, b) => a - b);
}

const mergeGatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'pull_request_approval' },
    orderBy: { createdAt: 'asc' },
  });

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

async function story(s: Scenario, children = 1) {
  const parent = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'story', title: 'The story' },
    s.ctx,
  );
  const kids = [];
  for (let i = 0; i < children; i++) {
    kids.push(
      await workItemsService.createWorkItem(
        { projectId: s.project.id, kind: 'subtask', title: `Child ${i}`, parentId: parent.id },
        s.ctx,
      ),
    );
  }
  for (const item of [parent, ...kids]) {
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  }
  return { parent, kids };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('with "Complete children when a parent is done" ON', () => {
  it("writes the parent's delivery when the parent already has a pull request of its own", async () => {
    const s = await makeScenario('11835-own@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await link(parent.identifier, 80, `story/${parent.identifier}`);
    await link(child!.identifier, 81, `subtask/${child!.identifier}`);

    expect(await deliveredNumbers(parent.id)).toEqual([80, 81]);
    expect(await deliveredNumbers(child!.id)).toEqual([81]);
  });

  it('writes it when the parent has none, so one question on the story covers every child', async () => {
    const s = await makeScenario('11835-none@example.com');
    const {
      parent,
      kids: [a, b],
    } = await story(s, 2);
    const refA = `subtask/${a!.identifier}`;
    const refB = `subtask/${b!.identifier}`;
    await link(a!.identifier, 82, refA);
    await link(b!.identifier, 83, refB);
    await opened(82, refA);
    await opened(83, refB);
    expect(await deliveredNumbers(parent.id)).toEqual([82, 83]);

    for (const kid of [a!, b!]) await workItemsService.updateStatus(kid.id, 'implemented', s.ctx);
    await workItemsService.updateStatus(parent.id, 'implemented', s.ctx);
    await ci('sha-a', 82);
    await ci('sha-b', 83);

    expect(await statusOf(parent.id)).toBe('in_review');
    // The children are asked nothing: their pull requests are the story's.
    expect(await mergeGatesOf(a!.id)).toEqual([]);
    expect(await mergeGatesOf(b!.id)).toEqual([]);
    // The story is asked once, over both.
    const gates = (await mergeGatesOf(parent.id)).filter((g) => g.state === 'awaiting');
    expect(gates).toHaveLength(1);
    expect(gates[0]!.subjectVersion).toContain('#82@sha-a');
    expect(gates[0]!.subjectVersion).toContain('#83@sha-b');
  });

  it('reproduction: a story and a child on separate pull requests raise ONE question, on the story, over both', async () => {
    const s = await makeScenario('11835-repro@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    const storyRef = `story/${parent.identifier}`;
    const childRef = `subtask/${child!.identifier}`;
    await link(parent.identifier, 84, storyRef);
    await link(child!.identifier, 85, childRef);
    await opened(84, storyRef);
    await opened(85, childRef);
    await workItemsService.updateStatus(child!.id, 'implemented', s.ctx);
    await workItemsService.updateStatus(parent.id, 'implemented', s.ctx);

    await ci('sha-story', 84);
    await ci('sha-child', 85);

    expect(await statusOf(child!.id)).toBe('in_review');
    expect(await mergeGatesOf(child!.id)).toEqual([]);
    const gates = (await mergeGatesOf(parent.id)).filter((g) => g.state === 'awaiting');
    expect(gates).toHaveLength(1);
    expect(gates[0]!.subjectVersion).toContain('#84@sha-story');
    expect(gates[0]!.subjectVersion).toContain('#85@sha-child');
  });

  it("supersedes the parent's awaiting question as `set_changed` and re-asks over the full set", async () => {
    const s = await makeScenario('11835-supersede@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    const storyRef = `story/${parent.identifier}`;
    await link(parent.identifier, 86, storyRef);
    await opened(86, storyRef);
    // A parent reaches Implemented only once its children are built.
    await workItemsService.updateStatus(child!.id, 'implemented', s.ctx);
    await workItemsService.updateStatus(parent.id, 'implemented', s.ctx);
    await ci('sha-story', 86);
    expect(await statusOf(parent.id)).toBe('in_review');
    const [before] = await mergeGatesOf(parent.id);
    expect(before).toMatchObject({ state: 'awaiting' });
    expect(before!.subjectVersion).not.toContain('#87');

    const childRef = `subtask/${child!.identifier}`;
    await opened(87, childRef);
    await link(child!.identifier, 87, childRef);

    // The question asked about #86 alone is withdrawn the moment #87 joins the set…
    const [withdrawn] = await mergeGatesOf(parent.id);
    expect(withdrawn).toMatchObject({ state: 'superseded', supersededCause: 'set_changed' });
    expect((await mergeGatesOf(parent.id)).filter((g) => g.state === 'awaiting')).toEqual([]);

    // …and re-asked over both once the new member is green.
    await ci('sha-child', 87);
    const gates = await mergeGatesOf(parent.id);
    const awaiting = gates.filter((g) => g.state === 'awaiting');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.subjectVersion).toContain('#86@sha-story');
    expect(awaiting[0]!.subjectVersion).toContain('#87@sha-child');
  });

  it('withdraws a question the child already holds once its pull request becomes the story’s', async () => {
    const s = await makeScenario('11835-child-gate@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    const childRef = `subtask/${child!.identifier}`;
    await opened(88, childRef);
    // Linked while the setting was off, so the child was asked on its own…
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { autoCompleteChildrenOnParentDone: false },
    });
    await link(child!.identifier, 88, childRef);
    await workItemsService.updateStatus(child!.id, 'implemented', s.ctx);
    await ci('sha-child', 88);
    expect((await mergeGatesOf(child!.id)).map((g) => g.state)).toEqual(['awaiting']);

    // …then the setting is turned on and the link is made again.
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { autoCompleteChildrenOnParentDone: true },
    });
    await link(child!.identifier, 88, childRef);

    expect(await deliveredNumbers(parent.id)).toEqual([88]);
    const [gate] = await mergeGatesOf(child!.id);
    expect(gate).toMatchObject({ state: 'superseded', supersededCause: 'set_changed' });
    expect((await mergeGatesOf(child!.id)).filter((g) => g.state === 'awaiting')).toEqual([]);
  });

  it('walks every non-epic ancestor and stops below the epic', async () => {
    const s = await makeScenario('11835-tree@example.com');
    const epic = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'epic', title: 'The epic' },
      s.ctx,
    );
    const parentStory = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story', parentId: epic.id },
      s.ctx,
    );
    const task = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'The task', parentId: parentStory.id },
      s.ctx,
    );
    const sub = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'subtask', title: 'The subtask', parentId: task.id },
      s.ctx,
    );
    await link(sub.identifier, 89, `subtask/${sub.identifier}`);

    expect(await deliveredNumbers(sub.id)).toEqual([89]);
    expect(await deliveredNumbers(task.id)).toEqual([89]);
    expect(await deliveredNumbers(parentStory.id)).toEqual([89]);
    expect(await deliveredNumbers(epic.id)).toEqual([]);
  });

  it('writes nothing for a card with no parent, and is idempotent on a re-link', async () => {
    const s = await makeScenario('11835-idem@example.com');
    const lone = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Alone' },
      s.ctx,
    );
    await link(lone.identifier, 90, 'task/alone');
    expect(await deliveredNumbers(lone.id)).toEqual([90]);

    const {
      parent,
      kids: [child],
    } = await story(s);
    const childRef = `subtask/${child!.identifier}`;
    await link(child!.identifier, 91, childRef);
    await link(child!.identifier, 91, childRef);
    // The parent linked explicitly as well: still one row each.
    await link(parent.identifier, 91, childRef);
    expect(await deliveredNumbers(parent.id)).toEqual([91]);
    expect(await adminDb.workItemDelivery.count()).toBe(3);
  });

  it("inherits through the picker's door too (`linkPullRequest`)", async () => {
    const s = await makeScenario('11835-picker@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s);
    await opened(92, `subtask/${child!.identifier}`);
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 92 } });

    await githubPullRequestService.linkPullRequest(child!.id, pr.id, s.ctx);

    expect(await deliveredNumbers(child!.id)).toEqual([92]);
    expect(await deliveredNumbers(parent.id)).toEqual([92]);
  });
});

describe('with "Complete children when a parent is done" OFF', () => {
  it("writes only the child's row, and the child is asked its own question", async () => {
    const s = await makeScenario('11835-off@example.com', { cascade: false });
    const {
      parent,
      kids: [child],
    } = await story(s);
    const childRef = `subtask/${child!.identifier}`;
    await link(child!.identifier, 93, childRef);
    await opened(93, childRef);
    await workItemsService.updateStatus(child!.id, 'implemented', s.ctx);
    await ci('sha-off', 93);

    expect(await deliveredNumbers(parent.id)).toEqual([]);
    expect(await deliveredNumbers(child!.id)).toEqual([93]);
    const gates = await mergeGatesOf(child!.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ state: 'awaiting', subjectVersion: 'moooon/acme#93@sha-off' });
  });
});

describe('a child pull request merged on its own, outside the story’s approval', () => {
  const merged = (number: number, headRef: string) =>
    githubWebhookService.handleEvent('pull_request', {
      action: 'closed',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number,
        state: 'closed',
        merged: true,
        title: `A change (${headRef})`,
        head: { ref: headRef },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });

  it('does not complete the story while a sibling is unbuilt — its inherited set is not its work', async () => {
    const s = await makeScenario('11835-early@example.com');
    const {
      parent,
      kids: [a, b],
    } = await story(s, 2);
    const refA = `subtask/${a!.identifier}`;
    await link(a!.identifier, 95, refA);
    await opened(95, refA);
    await workItemsService.updateStatus(a!.id, 'implemented', s.ctx);

    await merged(95, refA);

    expect(await statusOf(a!.id)).toBe('done');
    expect(await statusOf(b!.id)).toBe('in_progress');
    expect(await statusOf(parent.id)).toBe('in_progress');
  });

  it('completes the story on the last merge once every child is built', async () => {
    const s = await makeScenario('11835-late@example.com');
    const {
      parent,
      kids: [a, b],
    } = await story(s, 2);
    const refA = `subtask/${a!.identifier}`;
    const refB = `subtask/${b!.identifier}`;
    await link(a!.identifier, 96, refA);
    await link(b!.identifier, 97, refB);
    await opened(96, refA);
    await opened(97, refB);
    for (const kid of [a!, b!]) await workItemsService.updateStatus(kid.id, 'implemented', s.ctx);

    await merged(96, refA);
    // #97 is still open: the story waits for the last member, as any two-PR card does.
    expect(await statusOf(parent.id)).not.toBe('done');
    await merged(97, refB);

    expect(await statusOf(parent.id)).toBe('done');
  });

  it('reads the whole tree: a grandchild’s merge completes its built task but not the story over an unbuilt sibling', async () => {
    const s = await makeScenario('11835-deep@example.com');
    const top = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story' },
      s.ctx,
    );
    const task = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Built task', parentId: top.id },
      s.ctx,
    );
    const sibling = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Unbuilt task', parentId: top.id },
      s.ctx,
    );
    const sub = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'subtask', title: 'The subtask', parentId: task.id },
      s.ctx,
    );
    for (const item of [top, task, sibling, sub]) {
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    }
    const ref = `subtask/${sub.identifier}`;
    await link(sub.identifier, 99, ref);
    await opened(99, ref);
    await workItemsService.updateStatus(sub.id, 'implemented', s.ctx);

    await merged(99, ref);

    expect(await statusOf(sub.id)).toBe('done');
    expect(await statusOf(task.id)).toBe('done');
    expect(await statusOf(top.id)).not.toBe('done');
  });

  it("still completes the story on its OWN pull request's merge, as before", async () => {
    const s = await makeScenario('11835-own-merge@example.com');
    const { parent } = await story(s, 1);
    const ref = `story/${parent.identifier}`;
    await link(parent.identifier, 98, ref);
    await opened(98, ref);

    await merged(98, ref);

    expect(await statusOf(parent.id)).toBe('done');
  });

  // Review of core#4359: the parent-run shape (MOTIR-11624) links a built child BESIDE its
  // story to the story's OWN pull request. That merge is the story's, not an inherited one,
  // so an unbuilt sibling (a manual child a parent run stops at) must not hold it — with the
  // cascade switch on or off, exactly as on main.
  for (const cascade of [true, false]) {
    it(`completes the story on its OWN pull request's merge when a built child rides it and a sibling is unbuilt (cascade ${cascade ? 'on' : 'off'})`, async () => {
      const s = await makeScenario(`11835-own-ridden-${cascade}@example.com`, { cascade });
      const {
        parent,
        kids: [a, b],
      } = await story(s, 2);
      const number = cascade ? 100 : 101;
      const ref = `story/${parent.identifier}`;
      await link(parent.identifier, number, ref);
      await opened(number, ref);
      await link(a!.identifier, number, ref);
      await workItemsService.updateStatus(a!.id, 'implemented', s.ctx);
      expect(await statusOf(b!.id)).toBe('in_progress');

      await merged(number, ref);

      expect(await statusOf(parent.id)).toBe('done');
      expect(await statusOf(a!.id)).toBe('done');
    });
  }
});
