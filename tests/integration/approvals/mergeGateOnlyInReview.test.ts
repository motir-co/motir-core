import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkPrByIdentifier } from '../../helpers/prLink';
import { hostAnswersCleanAt } from '../../helpers/hostMergeability';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// THE MERGE QUESTION IS ASKED ONLY AT `in_review` (Bug MOTIR-6971; ADR
// `approval-gates.md` §8's EIGHTH AMENDMENT), on a REAL Postgres through the real
// webhook, status and reconcile doors.
//
// The rule, in the product owner's words: green CI means nothing on its own — any
// pull request can be linked to a card — and the run that owns the card must set its
// status as the runbook says. A card left at `in_progress` is a DEAD run. So the
// approve-to-merge gate exists if and only if CI is all green AND the card is In
// Review; leaving either condition withdraws it, and only re-entering both raises it.
//
// The defect it closes: MOTIR-6914, a story at `in_progress` with five blocked
// children, held an awaiting gate over its two green pull requests, and pressing
// Approve threw `IllegalTransitionError: "in_progress" → "approved"` (Sentry
// 7762359336) — a question the workflow could never record an answer to.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { reconcileGatesFor } = await import('@/lib/services/gateSetFor');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const INSTALLATION_ID = 'inst-6971';
const REPO_PROVIDER_ID = '6971';
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

const pullRequest = (action: string, number: number, headRef: string, sha?: string) =>
  githubWebhookService.handleEvent('pull_request', {
    action,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: sha ? { ref: headRef, sha } : { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });

async function openLinked(identifier: string, number: number, headRef: string) {
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await pullRequest('opened', number, headRef);
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'pull_request_approval' },
    orderBy: { createdAt: 'asc' },
  });

const awaitingMerge = async (workItemId: string) =>
  (await gatesOf(workItemId)).filter((g) => g.state === 'awaiting');

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

/** The 30-minute sweep's own call, on the card's current row (`pullRequestReconcileService`). */
const sweep = (s: Scenario, workItemId: string) =>
  withWorkspaceContext(s.ctx, async (tx) =>
    reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: workItemId } }), tx),
  );

/** A card whose run SETTLED it: PR open (→ `implemented`), CI green (→ `in_review`). */
async function reviewedCard(email: string, number: number) {
  const s = await makeScenario(email);
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'A change' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-${number}`;
  await openLinked(item.identifier, number, headRef);
  await ci('sha-a', number);
  return { s, item, headRef };
}

/** A card whose run DIED: a green linked pull request, the card still `in_progress`. */
async function deadRunCard(email: string, number: number) {
  const s = await makeScenario(email);
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'A dead run' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await openLinked(item.identifier, number, `subtask/${item.identifier}-${number}`);
  // The run never settled the card — the state MOTIR-6914 was in. Since MOTIR-12094 a
  // green verdict landing on an `in_progress` card PROMOTES it, so the verdict lands
  // while the card is parked at `blocked` (not a source), and the row is put back at
  // `in_progress` as a fixture: a green set the CI edge never saw at a source.
  await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'blocked' } });
  await ci('sha-dead', number);
  await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_progress' } });
  return { s, item };
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

describe('AC 1 — no gate outside In Review, from any door', () => {
  it('a DEAD RUN — CI green on a card still `in_progress` — promotes it to In Review, and only there is it asked (MOTIR-12094)', async () => {
    const s = await makeScenario('6971-dead-green@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A dead run, green' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await openLinked(item.identifier, 10, `subtask/${item.identifier}-10`);
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'in_progress' } });

    await ci('sha-dead', 10);

    expect(await statusOf(item.id)).toBe('in_review');
    expect((await gatesOf(item.id)).map((g) => [g.kind, g.state])).toEqual([
      ['pull_request_approval', 'awaiting'],
    ]);
  });

  it('a green set at `in_progress` the CI edge never saw is asked nothing by the sweep', async () => {
    const { s, item } = await deadRunCard('6971-dead@example.com', 11);

    expect(await statusOf(item.id)).toBe('in_progress');
    expect(await gatesOf(item.id)).toEqual([]);
    // The backstop is the door that raised MOTIR-6914's gate: it asks the same
    // predicate, and the predicate now reads the card's status.
    expect(await sweep(s, item.id)).toEqual([]);
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('nor at `implemented`, `blocked` or `todo` — only `in_review` is asked', async () => {
    const { s, item } = await deadRunCard('6971-rungs@example.com', 12);
    for (const status of ['implemented', 'blocked', 'todo']) {
      await adminDb.workItem.update({ where: { id: item.id }, data: { status } });
      expect(`${status}: ${JSON.stringify(await sweep(s, item.id))}`).toBe(`${status}: []`);
    }
    expect(await gatesOf(item.id)).toEqual([]);
  });

  it('a STORY held below `implemented` by an open child — MOTIR-6914 — raises nothing over its green pull request', async () => {
    const s = await makeScenario('6971-story@example.com');
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'The story' },
      s.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'subtask', title: 'Not built yet', parentId: story.id },
      s.ctx,
    );
    await workItemsService.updateStatus(story.id, 'in_progress', s.ctx);
    await openLinked(story.identifier, 13, `parent/${story.identifier}-work`);
    await ci('sha-story', 13);

    // The container gate keeps it at `in_progress` (its PR-open `implemented` is
    // refused while a child is open), so no run has settled it, and nothing asks.
    expect(await statusOf(story.id)).toBe('in_progress');
    expect(await sweep(s, story.id)).toEqual([]);
    expect(await gatesOf(story.id)).toEqual([]);
  });
});

describe('AC 2 — a green set at In Review gets exactly ONE gate', () => {
  it('`implemented` → CI green → `in_review`, holding one awaiting gate over the set', async () => {
    const { item } = await reviewedCard('6971-reviewed@example.com', 21);

    expect(await statusOf(item.id)).toBe('in_review');
    const awaiting = await awaitingMerge(item.id);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({ subjectVersion: 'moooon/acme#21@sha-a' });
  });
});

describe('AC 3 — leaving In Review closes the gate', () => {
  for (const to of ['in_progress', 'blocked'] as const) {
    it(`a hand move \`in_review → ${to}\` supersedes it as \`pulled_back\`, and nothing re-asks while the card stays there`, async () => {
      const { s, item } = await reviewedCard(
        `6971-leave-${to}@example.com`,
        to === 'blocked' ? 31 : 32,
      );
      expect(await awaitingMerge(item.id)).toHaveLength(1);

      await workItemsService.updateStatus(item.id, to, s.ctx);

      const [gate] = await gatesOf(item.id);
      expect(gate).toMatchObject({ state: 'superseded', supersededCause: 'pulled_back' });
      expect(await sweep(s, item.id)).toEqual([]);
      expect(await awaitingMerge(item.id)).toEqual([]);
    });
  }

  it('a DECIDED gate is untouched by a later move — §8 decision 5', async () => {
    const { s, item } = await reviewedCard('6971-decided@example.com', 33);
    const [gate] = await awaitingMerge(item.id);
    await adminDb.approvalGate.update({
      where: { id: gate!.id },
      data: {
        state: 'approved',
        decidedById: s.user.id,
        decidedAt: new Date(),
        decidedByLabel: 'Owner',
      },
    });

    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);

    const [row] = await gatesOf(item.id);
    expect(row).toMatchObject({ state: 'approved', supersededCause: null });
  });
});

describe('AC 4 — a stray gate on a card that is not In Review is withdrawn', () => {
  it("MOTIR-6914's shape — an awaiting gate on an `in_progress` card — is superseded as `pulled_back` on the next reconcile", async () => {
    const { s, item } = await deadRunCard('6971-stray@example.com', 41);
    // Raised before this rule, the way the sweep raised MOTIR-6914's.
    await adminDb.approvalGate.create({
      data: {
        workspaceId: s.workspace.id,
        projectId: s.project.id,
        workItemId: item.id,
        kind: 'pull_request_approval',
        subjectId: item.id,
        subjectVersion: 'moooon/acme#41@sha-dead',
        routedToId: s.user.id,
      },
    });

    expect(await sweep(s, item.id)).toEqual([]);

    const [gate] = await gatesOf(item.id);
    expect(gate).toMatchObject({ state: 'superseded', supersededCause: 'pulled_back' });
    expect(await statusOf(item.id)).toBe('in_progress');
  });
});

describe('AC 5 — coming back to In Review re-asks ONCE', () => {
  it('`in_progress → in_review` with the set still green raises exactly one fresh gate', async () => {
    const { s, item } = await reviewedCard('6971-back@example.com', 51);
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    expect(await awaitingMerge(item.id)).toEqual([]);

    await workItemsService.updateStatus(item.id, 'in_review', s.ctx);

    const rows = await gatesOf(item.id);
    expect(rows.map((g) => g.state)).toEqual(['superseded', 'awaiting']);
    expect(rows[1]).toMatchObject({ subjectVersion: 'moooon/acme#51@sha-a' });
    // Idempotent: a second reconcile asks nothing more.
    expect(await sweep(s, item.id)).toEqual([]);
  });
});

describe('an `approved` card whose commits moved is asked again AT In Review, never where it stands', () => {
  it('a push after the approval, then green, moves the card back to `in_review` with ONE fresh gate over the new head', async () => {
    const { s, item, headRef } = await reviewedCard('6971-approved@example.com', 61);
    const [gate] = await awaitingMerge(item.id);
    await adminDb.approvalGate.update({
      where: { id: gate!.id },
      data: {
        state: 'approved',
        decidedById: s.user.id,
        decidedAt: new Date(),
        decidedByLabel: 'Owner',
      },
    });
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'approved' } });

    await pullRequest('synchronize', 61, headRef, 'sha-b');
    // The host says the new head still merges (MOTIR-7063) — until then nobody is asked.
    await hostAnswersCleanAt(s.workspace.id, 61, 'sha-b');
    await ci('sha-b', 61);

    expect(await statusOf(item.id)).toBe('in_review');
    const awaiting = await awaitingMerge(item.id);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({ subjectVersion: 'moooon/acme#61@sha-b' });
  });

  it('a late green at the SAME approved commits moves nothing and asks nothing (MOTIR-5632)', async () => {
    const { s, item } = await reviewedCard('6971-late@example.com', 62);
    const [gate] = await awaitingMerge(item.id);
    await adminDb.approvalGate.update({
      where: { id: gate!.id },
      data: {
        state: 'approved',
        decidedById: s.user.id,
        decidedAt: new Date(),
        decidedByLabel: 'Owner',
      },
    });
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'approved' } });

    await ci('sha-a', 62);

    expect(await statusOf(item.id)).toBe('approved');
    expect(await awaitingMerge(item.id)).toEqual([]);
  });
});
