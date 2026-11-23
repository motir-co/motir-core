import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { ownDeliverySetVersion } from '@/lib/agentReview/ownVersion';
import { listOwnDeliveriesWithChecks } from '@/lib/approvalGates/ownDeliveries';
import { withoutAncestorDeliveriesForCards } from '@/lib/approvalGates/ownDeliveriesForCards';
import { reconcileGatesFor } from '@/lib/services/gateSetFor';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkPrByIdentifier } from '../../helpers/prLink';

// AN INHERITED DELIVERY OWNS NO QUESTION (Bug MOTIR-12091), on a REAL Postgres through the
// real link, webhook, status, verdict-reader and reconcile doors.
//
// Observed on production, 2026-11-23: MOTIR-12063 is a bug under the story MOTIR-11012 (In
// Progress). Its pull request (motir-codegraph #56) was linked to it alone, went green, and
// the card moved to In Review — and no `approval_gate` row was ever written for it. With
// "Complete children when a parent is done" on, the link also wrote #56 onto the story as an
// `inherited = true` row (MOTIR-11835), and the own-set rule (MOTIR-11624) read that copy as
// the story owning #56, so the child's own set was empty and nothing was asked. The story,
// still In Progress beside its open siblings, asked nothing either.
//
// Only an ancestor's EXPLICIT row is the parent run's branch. An inherited row is derived
// from the child's own link: it takes nothing from the child, and it is not a second
// question on the story.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

// The reconcile pass mints an installation token before reading the host; a real mint needs
// an App private key, so it is the one thing above the code under test that is stubbed.
vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { workItemDeliveryRepository } =
  await import('@/lib/repositories/workItemDeliveryRepository');
const { bindWorkspaceContext, withSystemContext } = await import('@/lib/workspaces/context');
const { PULL_REQUEST_RECONCILE_QUIET_MINUTES, pullRequestReconcileService } =
  await import('@/lib/services/pullRequestReconcileService');

const INSTALLATION_ID = 'inst-12091';
const REPO_PROVIDER_ID = '12091';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

async function makeScenario(
  email: string,
  opts: { cascade?: boolean; reviewAgent?: boolean } = {},
) {
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
  // The production project's shape: manual merge mode with the cascade switch on.
  await adminDb.project.update({
    where: { id: project.id },
    data: {
      prMergeMode: 'manual',
      autoCompleteChildrenOnParentDone: opts.cascade ?? true,
      reviewAgentEnabled: opts.reviewAgent ?? false,
    },
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

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

const awaitingOf = async (workItemId: string) =>
  (await gatesOf(workItemId)).filter((gate) => gate.state === 'awaiting');

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

/** The story In Progress with `children` children, every one of them In Progress. */
async function story(s: Scenario, children: number) {
  const parent = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'story', title: 'The load-test story' },
    s.ctx,
  );
  const kids = [];
  for (let i = 0; i < children; i++) {
    kids.push(
      await workItemsService.createWorkItem(
        { projectId: s.project.id, kind: 'bug', title: `Bug ${i}`, parentId: parent.id },
        s.ctx,
      ),
    );
  }
  for (const item of [parent, ...kids]) {
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  }
  return { parent, kids };
}

/** The child's own pull request, linked to it alone, built and green. */
async function childOnItsOwnBranch(
  s: Scenario,
  child: { id: string; identifier: string },
  number: number,
  headSha: string,
) {
  const ref = `subtask/${child.identifier}`;
  await link(child.identifier, number, ref);
  await opened(number, ref);
  await workItemsService.updateStatus(child.id, 'implemented', s.ctx);
  await ci(headSha, number);
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a child that delivers its own pull request under a story that is not done', () => {
  it('REPRODUCTION — the child at In Review is asked to approve its pull request, and the story, which inherited it, is asked nothing', async () => {
    const s = await makeScenario('12091-repro@example.com');
    const {
      parent,
      kids: [child, sibling],
    } = await story(s, 2);

    await childOnItsOwnBranch(s, child!, 56, 'sha-56');

    // The production rows: #56 on the child explicitly, and on the story as an inherited copy.
    const rows = await adminDb.workItemDelivery.findMany({
      select: { workItemId: true, inherited: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toEqual([
      { workItemId: child!.id, inherited: false },
      { workItemId: parent.id, inherited: true },
    ]);

    expect(await statusOf(child!.id)).toBe('in_review');
    const asked = await awaitingOf(child!.id);
    expect(asked.map((gate) => [gate.kind, gate.subjectVersion])).toEqual([
      ['pull_request_approval', 'moooon/acme#56@sha-56'],
    ]);
    // The story stays In Progress beside its open sibling, and asks nothing about #56.
    expect(await statusOf(parent.id)).toBe('in_progress');
    expect(await statusOf(sibling!.id)).toBe('in_progress');
    expect(await gatesOf(parent.id)).toEqual([]);
  });

  it('with the review gate on, the child owes its review over its own pull request first', async () => {
    const s = await makeScenario('12091-review@example.com', { reviewAgent: true });
    const {
      parent,
      kids: [child],
    } = await story(s, 2);

    await childOnItsOwnBranch(s, child!, 57, 'sha-57');

    const asked = await awaitingOf(child!.id);
    expect(asked.map((gate) => [gate.kind, gate.subjectVersion])).toEqual([
      ['agent_review', 'moooon/acme#57@sha-57'],
    ]);
    expect(await gatesOf(parent.id)).toEqual([]);
  });

  it('every reader of the version measures the child’s pull request as its own, and the story’s inherited copy as nobody’s', async () => {
    const s = await makeScenario('12091-readers@example.com', { reviewAgent: true });
    const {
      parent,
      kids: [child],
    } = await story(s, 2);
    await childOnItsOwnBranch(s, child!, 58, 'sha-58');
    const [review] = await awaitingOf(child!.id);

    const childRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: child!.id } });
    const parentRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: parent.id } });
    await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, s.workspace.id);
      // The verdict door's version (both review doors share it) is the gate's.
      expect(await ownDeliverySetVersion(childRow, s.workspace.id, tx)).toBe(
        review!.subjectVersion,
      );
      expect(await ownDeliverySetVersion(parentRow, s.workspace.id, tx)).toBeNull();
      // The dismissal's and the handlers' set.
      expect((await listOwnDeliveriesWithChecks(child!.id, tx)).map((d) => d.workItemId)).toEqual([
        child!.id,
      ]);
      expect(await listOwnDeliveriesWithChecks(parent.id, tx)).toEqual([]);
      // The batch reader behind the review state and the To fix rows.
      const linked = await workItemDeliveryRepository.listByWorkItemsWithChecks(
        [parent.id, child!.id],
        tx,
      );
      expect(linked).toHaveLength(2);
      const own = await withoutAncestorDeliveriesForCards(s.workspace.id, linked, tx);
      expect(own.map((d) => d.workItemId)).toEqual([child!.id]);
      // A page holding only the story's inherited copy has nothing of anyone's to filter.
      const storyOnly = linked.filter((d) => d.workItemId === parent.id);
      expect(storyOnly.map((d) => d.inherited)).toEqual([true]);
      expect(await withoutAncestorDeliveriesForCards(s.workspace.id, storyOnly, tx)).toEqual([]);
    });
  });

  it('the story’s OWN pull request is still its question, over that pull request alone', async () => {
    const s = await makeScenario('12091-story-own@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s, 1);
    const storyRef = `story/${parent.identifier}`;
    await link(parent.identifier, 60, storyRef);
    await opened(60, storyRef);
    await childOnItsOwnBranch(s, child!, 61, 'sha-61');
    await workItemsService.updateStatus(parent.id, 'implemented', s.ctx);
    await ci('sha-60', 60);

    expect(await statusOf(parent.id)).toBe('in_review');
    expect((await awaitingOf(parent.id)).map((g) => [g.kind, g.subjectVersion])).toEqual([
      ['pull_request_approval', 'moooon/acme#60@sha-60'],
    ]);
    expect((await awaitingOf(child!.id)).map((g) => [g.kind, g.subjectVersion])).toEqual([
      ['pull_request_approval', 'moooon/acme#61@sha-61'],
    ]);
  });

  it('a pull request the story delivers EXPLICITLY is still the parent run’s branch: the child riding it is asked nothing', async () => {
    const s = await makeScenario('12091-parent-run@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s, 1);
    const storyRef = `story/${parent.identifier}`;
    await link(parent.identifier, 62, storyRef);
    await link(child!.identifier, 62, storyRef);
    await opened(62, storyRef);
    await workItemsService.updateStatus(child!.id, 'implemented', s.ctx);
    await ci('sha-62', 62);

    expect(await statusOf(child!.id)).toBe('in_review');
    expect(await gatesOf(child!.id)).toEqual([]);
  });

  it('with the switch off nothing is inherited, and the child is asked exactly as with it on', async () => {
    const s = await makeScenario('12091-off@example.com', { cascade: false });
    const {
      parent,
      kids: [child],
    } = await story(s, 2);
    await childOnItsOwnBranch(s, child!, 63, 'sha-63');

    expect(await adminDb.workItemDelivery.count({ where: { workItemId: parent.id } })).toBe(0);
    expect((await awaitingOf(child!.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#63@sha-63',
    ]);
  });

  it('linking a second child’s pull request leaves the first child’s question standing', async () => {
    const s = await makeScenario('12091-second@example.com');
    const {
      parent,
      kids: [a, b],
    } = await story(s, 2);
    await childOnItsOwnBranch(s, a!, 64, 'sha-64');
    const [first] = await awaitingOf(a!.id);

    await childOnItsOwnBranch(s, b!, 65, 'sha-65');

    expect(await awaitingOf(a!.id)).toEqual([first]);
    expect((await awaitingOf(b!.id)).map((g) => g.subjectVersion)).toEqual([
      'moooon/acme#65@sha-65',
    ]);
    expect(await gatesOf(parent.id)).toEqual([]);
  });
});

describe('a card already stuck this way (MOTIR-12063, MOTIR-12062)', () => {
  /** Past the reconcile's quiet threshold, so the pull request is a candidate. */
  const later = () => new Date(Date.now() + (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000);

  function hostReads(number: number, headRef: string, headSha: string) {
    const fetchMock = vi.fn(async (url: string) => {
      if (/\/pulls\/\d+\/files/.test(url)) return new Response('[]', { status: 200 });
      if (/\/commits\/[^/]+\/check-runs/.test(url)) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            check_runs: [
              { name: 'build', status: 'completed', conclusion: 'success', check_suite: { id: 1 } },
            ],
          }),
          { status: 200 },
        );
      }
      if (new RegExp(`/pulls/${number}$`).test(url)) {
        return new Response(
          JSON.stringify({
            number,
            state: 'open',
            merged: false,
            merged_at: null,
            draft: false,
            title: 'The fix',
            head: { ref: headRef, sha: headSha },
            base: { ref: 'main' },
            user: { id: 4242 },
            mergeable: true,
            mergeable_state: 'clean',
          }),
          { status: 200 },
        );
      }
      return new Response('not stubbed', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('the reconcile pass raises the missing question with no new push', async () => {
    const s = await makeScenario('12091-sweep@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s, 2);
    await childOnItsOwnBranch(s, child!, 66, 'sha-66');
    // The production state the old rule left: In Review, green, and asked nothing.
    await adminDb.approvalGate.deleteMany({});
    expect(await statusOf(child!.id)).toBe('in_review');
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 66 } });
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });
    hostReads(66, `subtask/${child!.identifier}`, 'sha-66');

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: later() });

    expect(summary).toMatchObject({ stillOpen: 1, failed: 0 });
    expect((await awaitingOf(child!.id)).map((g) => [g.kind, g.subjectVersion])).toEqual([
      ['pull_request_approval', 'moooon/acme#66@sha-66'],
    ]);
    expect(await gatesOf(parent.id)).toEqual([]);
  });

  it('a story asked over an inherited-only set under the old rule loses that question, and the child is asked its own', async () => {
    const s = await makeScenario('12091-standing@example.com');
    const {
      parent,
      kids: [child],
    } = await story(s, 1);
    await childOnItsOwnBranch(s, child!, 70, 'sha-70');
    // The state the old rule left on a story at In Review: the merge question over the
    // child's pull request hangs off the STORY, through its inherited row, and the child
    // is asked nothing.
    const [asked] = await awaitingOf(child!.id);
    expect(asked).toMatchObject({
      kind: 'pull_request_approval',
      subjectVersion: 'moooon/acme#70@sha-70',
    });
    await adminDb.approvalGate.update({
      where: { id: asked!.id },
      data: { workItemId: parent.id },
    });
    await adminDb.workItem.update({ where: { id: parent.id }, data: { status: 'in_review' } });
    expect(
      await adminDb.workItemDelivery.findMany({
        where: { workItemId: parent.id },
        select: { inherited: true },
      }),
    ).toEqual([{ inherited: true }]);

    const parentRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: parent.id } });
    const childRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: child!.id } });
    await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, s.workspace.id);
      expect(await reconcileGatesFor(parentRow, tx)).toEqual([]);
      expect(await reconcileGatesFor(childRow, tx)).toEqual(['pull_request_approval']);
    });

    expect((await gatesOf(parent.id)).map((g) => [g.kind, g.state, g.supersededCause])).toEqual([
      ['pull_request_approval', 'superseded', 'set_changed'],
    ]);
    expect((await awaitingOf(child!.id)).map((g) => [g.kind, g.subjectVersion])).toEqual([
      ['pull_request_approval', 'moooon/acme#70@sha-70'],
    ]);
  });
});
