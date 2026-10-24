import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import {
  PULL_REQUEST_RECONCILE_QUIET_MINUTES,
  pullRequestReconcileService,
} from '@/lib/services/pullRequestReconcileService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FIRST RUNG'S BACKSTOP (MOTIR-9455) over real Postgres, driven through the real
// `pull_request` webhook seam and the real link door.
//
// The defect: a card whose run never reported `implemented` — or whose `opened` /
// `ready_for_review` delivery was lost, or refused by the container gate while a
// story's children were still landing — sat at In Progress for good with its pull
// request open, ready and green. The reconcile replayed only CLOSED pull requests,
// and every promotion past `implemented` moves a card only FROM `implemented`.
// Observed on MOTIR-9364 / motir-core#3775.
//
// Stubbed ABOVE the code under test, as `pullRequestReconcile.test.ts` does: `fetch`
// (the GitHub REST read) and `mintInstallationToken`. `sendEvent` is captured so the
// `work-item/transitioned` event the move owes can be asserted.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

const INSTALLATION_ID = 'inst-reconcile-9455';
const REPO_ID = '9455';
const NUMBER = 3775;
const HEAD_SHA = 'c'.repeat(40);

/** Past the quiet threshold, so every row written "now" is a candidate. */
const LATER = () => new Date(Date.now() + (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000);

type HostPr = { state: 'open' | 'closed'; draft: boolean; headRef: string };

/** What GitHub currently says about the one pull request. */
let host: HostPr;

function hostPayload(pr: HostPr) {
  return {
    number: NUMBER,
    state: pr.state,
    merged: false,
    merged_at: null,
    draft: pr.draft,
    title: 'Some change',
    head: { ref: pr.headRef, sha: HEAD_SHA },
    base: { ref: 'main' },
    user: { id: 4242 },
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  sent.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (/\/pulls\/\d+\/files/.test(url))
        return new Response(JSON.stringify([{ filename: 'lib/changed.ts' }]), { status: 200 });
      if (/\/check-runs/.test(url))
        return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
      if (/\/pulls\/\d+$/.test(url))
        return new Response(JSON.stringify(hostPayload(host)), { status: 200 });
      return new Response('not stubbed', { status: 500 });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

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
        providerRepoId: REPO_ID,
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { project, ctx };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

/** Open the pull request (as a delivery would) and LINK it to `item`, then age the row
 *  past the quiet threshold. The link door's own resync may already have moved the
 *  card; each caller puts it where its case needs it. */
async function openAndLink(s: Scenario, item: { id: string; identifier: string }, draft: boolean) {
  const headRef = `subtask/${item.identifier}-fix`;
  host = { state: 'open', draft, headRef };
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID },
    repository: { id: Number(REPO_ID) },
    pull_request: hostPayload(host),
  });
  await githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId: item.id,
      projectId: s.project.id,
      owner: 'moooon',
      name: 'motir-core',
      number: NUMBER,
      headRef,
      baseRef: 'main',
      title: null,
    },
    s.ctx,
  );
  await ageRow();
}

async function ageRow() {
  await adminDb.githubPullRequest.updateMany({
    data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
  });
}

/** A task whose run FORGOT to report: its pull request is open and ready, the card
 *  still reads `in_progress`. Written back through the service, which is the shape
 *  the card names ("move the card back to `in_progress` after the delivery"). */
async function forgottenCard(s: Scenario, title: string, draft = false) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await openAndLink(s, item, draft);
  if ((await statusOf(item.id)) !== 'in_progress') {
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  }
  await ageRow();
  sent.length = 0;
  return item;
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

/** Revisions that moved the card INTO `to`. */
async function transitionsInto(workItemId: string, to: string): Promise<number> {
  const revisions = await adminDb.workItemRevision.findMany({ where: { workItemId } });
  return revisions.filter((r) => {
    const status = (r.diff as Record<string, unknown> | null)?.['status'] as
      | { to?: unknown }
      | undefined;
    return status?.to === to;
  }).length;
}

const transitionedEvents = (workItemId: string) =>
  sent.filter((e) => e.name === 'work-item/transitioned' && e.data['workItemId'] === workItemId);

async function greenAtHead() {
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: NUMBER } });
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: pr.id,
      commitSha: HEAD_SHA,
      checkName: 'ci / vitest',
      conclusion: 'success',
    },
  });
}

describe('a card left at In Progress behind an open, ready pull request', () => {
  it('is moved to Implemented by one pass, with a revision and a transitioned event', async () => {
    const s = await makeScenario('reconcile-9455-lift@example.com');
    const card = await forgottenCard(s, 'the run forgot to report');
    const before = await transitionsInto(card.id, 'implemented');

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({
      stillOpen: 1,
      implemented: 1,
      implementedRefused: 0,
      failed: 0,
    });
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await transitionsInto(card.id, 'implemented')).toBe(before + 1);
    expect(transitionedEvents(card.id)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ fromStatusKey: 'in_progress', toStatusKey: 'implemented' }),
      }),
    ]);
  });

  it('continues to In Review in the SAME pass when CI is already green, and is asked about', async () => {
    const s = await makeScenario('reconcile-9455-green@example.com');
    const card = await forgottenCard(s, 'green and forgotten');
    await greenAtHead();

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ implemented: 1, failed: 0 });
    expect(await statusOf(card.id)).toBe('in_review');
    const gates = await adminDb.approvalGate.findMany({
      where: { workItemId: card.id, state: 'awaiting' },
    });
    expect(gates).toEqual([expect.objectContaining({ kind: 'pull_request_approval' })]);
  });

  it('a second pass changes nothing', async () => {
    const s = await makeScenario('reconcile-9455-idem@example.com');
    const card = await forgottenCard(s, 'repaired once');
    await greenAtHead();
    await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });
    expect(await statusOf(card.id)).toBe('in_review');
    const revisions = await adminDb.workItemRevision.count({ where: { workItemId: card.id } });
    const gates = await adminDb.approvalGate.count({ where: { workItemId: card.id } });
    sent.length = 0;
    await ageRow();

    const second = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(second).toMatchObject({ implemented: 0, implementedRefused: 0, promoted: 0 });
    expect(await statusOf(card.id)).toBe('in_review');
    expect(await adminDb.workItemRevision.count({ where: { workItemId: card.id } })).toBe(
      revisions,
    );
    expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(gates);
    expect(transitionedEvents(card.id)).toEqual([]);
  });

  it('a row heard from inside the quiet threshold is not asked about yet', async () => {
    const s = await makeScenario('reconcile-9455-quiet@example.com');
    const card = await forgottenCard(s, 'just delivered');
    await adminDb.githubPullRequest.updateMany({ data: { updatedAt: new Date() } });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({
      now: new Date(),
    });

    expect(summary).toMatchObject({ examined: 0, implemented: 0 });
    expect(await statusOf(card.id)).toBe('in_progress');
  });
});

describe('the pass leaves where they are', () => {
  it('a card behind a DRAFT pull request', async () => {
    const s = await makeScenario('reconcile-9455-draft@example.com');
    const card = await forgottenCard(s, 'still a draft', true);
    expect((await adminDb.githubPullRequest.findFirstOrThrow({})).draft).toBe(true);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, implemented: 0, implementedRefused: 0 });
    expect(await statusOf(card.id)).toBe('in_progress');
  });

  it('a card behind a pull request whose draft-ness is UNKNOWN (`null`)', async () => {
    const s = await makeScenario('reconcile-9455-null-draft@example.com');
    const card = await forgottenCard(s, 'draft-ness not recorded');
    await adminDb.githubPullRequest.updateMany({ data: { draft: null } });
    await ageRow();

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, implemented: 0, implementedRefused: 0 });
    expect(await statusOf(card.id)).toBe('in_progress');
  });

  it('a card whose stored row says ready while the HOST now says draft', async () => {
    const s = await makeScenario('reconcile-9455-host-draft@example.com');
    const card = await forgottenCard(s, 'converted to draft, nobody heard');
    host = { ...host, draft: true };

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, implemented: 0 });
    expect(await statusOf(card.id)).toBe('in_progress');
  });

  it('a card behind a CLOSED pull request', async () => {
    const s = await makeScenario('reconcile-9455-closed@example.com');
    const card = await forgottenCard(s, 'closed unmerged');
    host = { ...host, state: 'closed' };

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ replayed: 1, stillOpen: 0, implemented: 0 });
    expect(await statusOf(card.id)).toBe('in_progress');
  });

  it('a CONTAINER with a child below Implemented — counted as a refusal, not a failure', async () => {
    const s = await makeScenario('reconcile-9455-container@example.com');
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'a story a run is executing' },
      s.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'subtask', title: 'not landed', parentId: story.id },
      s.ctx,
    );
    await workItemsService.updateStatus(story.id, 'in_progress', s.ctx);
    await openAndLink(s, story, false);
    expect(await statusOf(story.id)).toBe('in_progress');

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({
      stillOpen: 1,
      implemented: 0,
      implementedRefused: 1,
      failed: 0,
    });
    expect(await statusOf(story.id)).toBe('in_progress');
  });
});
