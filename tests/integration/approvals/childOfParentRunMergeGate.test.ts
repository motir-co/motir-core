import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkPrByIdentifier } from '../../helpers/prLink';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// A CHILD LINKED TO ITS PARENT RUN'S PULL REQUEST IS ASKED NOTHING (Bug MOTIR-11624), on a
// REAL Postgres through the real link, webhook, status and reconcile doors.
//
// The defect, as MOTIR-11455's parent run met it: the story-branch pull request was linked
// to the story AND to a child (the child's dispatch prompt said to link the child). CI went
// green, promoted the child to In Review, and an awaiting `pull_request_approval` gate was
// raised ON THE CHILD over the story's whole pull request — an Approve that would merge the
// story from one child while its siblings were unbuilt. A pull request an ancestor also
// delivers is the ancestor's, and only the ancestor's gate may ask to merge it.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const INSTALLATION_ID = 'inst-11624';
const REPO_PROVIDER_ID = '11624';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string) {
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

const mergeGatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'pull_request_approval' },
    orderBy: { createdAt: 'asc' },
  });

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

/** The 30-minute sweep's own call, on the card's current row (`pullRequestReconcileService`). */
const sweep = (s: Scenario, workItemId: string) =>
  withWorkspaceContext(s.ctx, async (tx) =>
    reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: workItemId } }), tx),
  );

/** A story with two children, both In Progress, as a parent run holds them. */
async function storyWithChildren(email: string) {
  const s = await makeScenario(email);
  const story = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'story', title: 'The story' },
    s.ctx,
  );
  const built = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'subtask', title: 'Built child', parentId: story.id },
    s.ctx,
  );
  const unbuilt = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'subtask', title: 'Unbuilt child', parentId: story.id },
    s.ctx,
  );
  for (const item of [story, built, unbuilt]) {
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  }
  return { s, story, built, unbuilt, headRef: `parent/${story.identifier}-work` };
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

describe("a child linked beside its story to the story's pull request", () => {
  it('reaches In Review on green CI and is asked NO merge question — the reproduction', async () => {
    const { s, story, built, headRef } = await storyWithChildren('11624-repro@example.com');
    // The parent run's links: the story, and the child its dispatch prompt said to link.
    await link(story.identifier, 70, headRef);
    await link(built.identifier, 70, headRef);
    await opened(70, headRef);
    await workItemsService.updateStatus(built.id, 'implemented', s.ctx);

    await ci('sha-story', 70);

    // CI still promotes the child — its status is not what this card is about.
    expect(await statusOf(built.id)).toBe('in_review');
    expect(await mergeGatesOf(built.id)).toEqual([]);
    expect(await sweep(s, built.id)).toEqual([]);
    expect(await mergeGatesOf(built.id)).toEqual([]);
  });

  it('withdraws a merge question the child already holds as `set_changed` on the next reconcile', async () => {
    const { s, story, built, headRef } = await storyWithChildren('11624-stray@example.com');
    await link(story.identifier, 71, headRef);
    await link(built.identifier, 71, headRef);
    await opened(71, headRef);
    await adminDb.workItem.update({ where: { id: built.id }, data: { status: 'in_review' } });
    // The gate MOTIR-11455's child was left holding, raised before this rule.
    await adminDb.approvalGate.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: built.id,
        kind: 'pull_request_approval',
        subjectId: built.id,
        subjectVersion: 'moooon/acme#71@sha-story',
        routedToId: s.user.id,
      },
    });

    expect(await sweep(s, built.id)).toEqual([]);

    const [gate] = await mergeGatesOf(built.id);
    expect(gate).toMatchObject({ state: 'superseded', supersededCause: 'set_changed' });
    expect(await statusOf(built.id)).toBe('in_review');
  });

  it("still asks about the child's OWN pull request, and only about that one", async () => {
    const { s, story, built, headRef } = await storyWithChildren('11624-own@example.com');
    // With "Complete children when a parent is done" on, the child's own pull request is
    // the story's too (MOTIR-11835, pinned in childDeliveryInheritance.test.ts). Off, the
    // child keeps a set of its own — the case this pins.
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { autoCompleteChildrenOnParentDone: false },
    });
    await link(story.identifier, 72, headRef);
    await link(built.identifier, 72, headRef);
    await opened(72, headRef);
    const ownRef = `subtask/${built.identifier}-own`;
    await link(built.identifier, 73, ownRef);
    await opened(73, ownRef);
    await workItemsService.updateStatus(built.id, 'implemented', s.ctx);

    await ci('sha-story', 72);
    await ci('sha-own', 73);

    expect(await statusOf(built.id)).toBe('in_review');
    const gates = await mergeGatesOf(built.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      state: 'awaiting',
      subjectVersion: 'moooon/acme#73@sha-own',
    });
    // Nothing more to ask, and the standing question is not withdrawn.
    expect(await sweep(s, built.id)).toEqual([]);
    expect((await mergeGatesOf(built.id)).map((g) => g.state)).toEqual(['awaiting']);
  });
});

describe('a child of a parent that does NOT deliver the pull request', () => {
  it('is asked the merge question exactly as before', async () => {
    const { s, built } = await storyWithChildren('11624-plain@example.com');
    // With "Complete children when a parent is done" on, the child's own pull request is
    // the story's too (MOTIR-11835, pinned in childDeliveryInheritance.test.ts). Off, the
    // child keeps a set of its own — the case this pins.
    await adminDb.project.update({
      where: { id: s.project.id },
      data: { autoCompleteChildrenOnParentDone: false },
    });
    const ownRef = `subtask/${built.identifier}-alone`;
    await link(built.identifier, 74, ownRef);
    await opened(74, ownRef);
    await workItemsService.updateStatus(built.id, 'implemented', s.ctx);

    await ci('sha-alone', 74);

    expect(await statusOf(built.id)).toBe('in_review');
    const gates = await mergeGatesOf(built.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      state: 'awaiting',
      subjectVersion: 'moooon/acme#74@sha-alone',
    });
  });
});
