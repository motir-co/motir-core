import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { promoteDeliveredCardsOnGreen, promoteIfCiAlreadyGreen } from '@/lib/services/ciPromotion';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-3006 — CI GREEN IS WHAT MAKES A CARD REVIEWABLE.
//
// `implemented` says the code is pushed; In Review says a human should look. The
// only thing entitled to move a card between them is the build. Two things this
// suite exists to pin, and both were defects the card names explicitly:
//
//  1. The promotion is PER PULL REQUEST, not per linked card. A session pull
//     request carries N cards and its link column names NONE of them, so a green
//     run must promote all N. Asserted with N > 1 — N = 1 passes even with the
//     1:1 defect.
//  2. The promotion is a LATCH, not an edge. The run pushes BEFORE it transitions
//     (MOTIR-3004), so the green verdict can land while the card is still In
//     Progress. A card ARRIVING at `implemented` therefore re-reads the recorded
//     verdict, and promotes itself if it is already green.
//
// Real Postgres, the real webhook service, the real provider seam — no mocks.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci-promote';
const REPO_PROVIDER_ID = '881';
/** A SECOND connected repository that never reports a check (MOTIR-3823) — the
 *  `motir-meta` shape: no `.github/` at all, so no pull request in it can ever
 *  carry a check row. Connected in every scenario and inert unless a test opens
 *  a pull request in it. */
const DOCS_REPO_PROVIDER_ID = '882';

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
      {
        providerRepoId: DOCS_REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme-docs',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

/** Open a pull request whose head ref is `headBranch`. When it names a card's
 *  identifier the sync links it (and moves the card to `implemented`); when it
 *  does not — a session branch — the row is stored linked to nothing, which is
 *  exactly the shape `motir auto` produces. */
async function openPr(headBranch: string, number: number) {
  await openPrIn(REPO_PROVIDER_ID, headBranch, number);
}

/** The same delivery, in a NAMED repository — the two-repository cases need it. */
async function openPrIn(repoProviderId: string, headBranch: string, number: number) {
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(repoProviderId) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headBranch})`,
      head: { ref: headBranch },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

function checkSuitePayload(opts: {
  conclusion: string | null;
  headSha: string;
  status?: string;
  prNumbers?: number[];
  headBranch?: string | null;
}) {
  return {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: opts.headBranch ?? null,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: (opts.prNumbers ?? []).map((n) => ({ number: n })),
    },
  };
}

const ci = (opts: Parameters<typeof checkSuitePayload>[0]) =>
  githubWebhookService.handleEvent('check_suite', checkSuitePayload(opts));

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function revisionCount(workItemId: string): Promise<number> {
  return adminDb.workItemRevision.count({ where: { workItemId } });
}

/** A card at `implemented` with its own pull request — the ordinary shape. */
async function cardWithPr(
  s: Awaited<ReturnType<typeof makeScenario>>,
  title: string,
  number: number,
) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  // MOTIR-3674 — the link is the only association a pull request has; the key in
  // the branch is a label. A run writes it the moment `gh pr create` returns,
  // which is before the `opened` delivery lands.
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef: `subtask/${item.identifier}-work`,
    title: `A change (subtask/${item.identifier}-work)`,
  });
  await openPr(`subtask/${item.identifier}-work`, number);
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** MOTIR-3674 — the link for a case that opens its pull request directly rather
 *  than through `cardWithPr`. */
async function linkOne(identifier: string, number: number) {
  await linkPrByIdentifier({
    identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef: `subtask/${identifier}-work`,
    title: `A change (subtask/${identifier}-work)`,
  });
}

describe('a terminal GREEN promotes the cards a pull request delivers', () => {
  it('moves a single-card pull request from implemented to in_review', async () => {
    const s = await makeScenario('ci-single@example.com');
    const item = await cardWithPr(s, 'A change', 11);

    const res = await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [11] });

    expect(res).toMatchObject({ outcome: 'verified', ciState: 'passing' });
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('promotes ALL the cards on a SESSION branch from ONE green run (N > 1)', async () => {
    // The defect this asserts: a session pull request's link column names none of
    // its cards, so a promotion that resolves "the linked work item" moves one of
    // N and leaves the rest at Implemented forever. N = 3 here because N = 1
    // passes even with the defect.
    const s = await makeScenario('ci-session@example.com');
    const branch = 'motir/auto-20260819-020000';
    const items = [];
    for (const title of ['One', 'Two', 'Three']) {
      const item = await workItemsService.createWorkItem(
        { projectId: s.project.id, kind: 'task', title },
        s.ctx,
      );
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
      await workItemsService.markIntegrated(item.id, branch, s.ctx);
      expect(await statusOf(item.id)).toBe('implemented');
      items.push(item);
    }
    await openPr(branch, 12);

    const res = await ci({ conclusion: 'success', headSha: 'sha-a', prNumbers: [12] });

    expect(res).toMatchObject({ outcome: 'no_work_item' });
    for (const item of items) expect(await statusOf(item.id)).toBe('in_review');
  });

  it('leaves a sibling that is NOT at a source status exactly where it is', async () => {
    // A card a person parked at Blocked must not be yanked forward by a green run —
    // while its siblings still promote. (Since MOTIR-12094 a sibling at In Progress
    // IS promoted: a green, ready set is the evidence, whatever the card says.)
    const s = await makeScenario('ci-sibling@example.com');
    const branch = 'motir/auto-20260819-030000';
    const promoted = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Promoted' },
      s.ctx,
    );
    const reworking = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Being reworked' },
      s.ctx,
    );
    for (const item of [promoted, reworking]) {
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
      await workItemsService.markIntegrated(item.id, branch, s.ctx);
    }
    await workItemsService.updateStatus(reworking.id, 'blocked', s.ctx);
    await openPr(branch, 13);

    await ci({ conclusion: 'success', headSha: 'sha-b', prNumbers: [13] });

    expect(await statusOf(promoted.id)).toBe('in_review');
    expect(await statusOf(reworking.id)).toBe('blocked');
  });
});

describe('everything that is not a terminal green promotes nothing', () => {
  it('a terminal FAILURE writes ciState failing and moves no card', async () => {
    const s = await makeScenario('ci-fail@example.com');
    const item = await cardWithPr(s, 'A change', 14);

    const res = await ci({ conclusion: 'failure', headSha: 'sha1', prNumbers: [14] });

    expect(res).toMatchObject({ outcome: 'failed', ciState: 'failing' });
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('a PARTIAL aggregate — a check still pending — promotes nothing', async () => {
    const s = await makeScenario('ci-partial@example.com');
    const item = await cardWithPr(s, 'A change', 15);

    // One check still running, one green, at the same sha: the aggregate is not
    // terminal, so the card stays put whatever the terminal one says.
    await githubWebhookService.handleEvent('check_run', {
      action: 'completed',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      check_run: {
        head_sha: 'sha1',
        status: 'in_progress',
        conclusion: null,
        name: 'e2e',
        check_suite: { head_branch: null },
        pull_requests: [{ number: 15 }],
      },
    } as Record<string, unknown>);
    await githubWebhookService.handleEvent('check_run', {
      action: 'completed',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      check_run: {
        head_sha: 'sha1',
        status: 'completed',
        conclusion: 'success',
        name: 'build',
        check_suite: { head_branch: null },
        pull_requests: [{ number: 15 }],
      },
    });

    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('a green run for a SUPERSEDED sha, after a newer push, promotes nothing', async () => {
    const s = await makeScenario('ci-superseded@example.com');
    const item = await cardWithPr(s, 'A change', 16);

    // The order is the realistic one, and it is what makes the assertion mean
    // something: the OLD sha's checks are sighted first (still running), THEN a
    // newer push records its own, and only then does the old sha's verdict land.
    // `derivePrCiState` orders shas by FIRST sighting, so the late green belongs
    // to a commit the branch has already moved past.
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-old', prNumbers: [16] });
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-new', prNumbers: [16] });
    await ci({ conclusion: 'success', headSha: 'sha-old', prNumbers: [16] });

    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('promotes from in_progress DIRECTLY to in_review — the source is widened (MOTIR-12094)', async () => {
    // This test used to pin the opposite: a card whose agent never reported stayed
    // `in_progress` on a green run. The rule was overruled — the green, ready set is
    // the evidence — and the move is straight to In Review, never through Implemented.
    const s = await makeScenario('ci-source@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Never finished' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await linkOne(item.identifier, 17);
    await openPr(`subtask/${item.identifier}-work`, 17);
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    expect(await statusOf(item.id)).toBe('in_progress');

    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [17] });

    expect(await statusOf(item.id)).toBe('in_review');
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: item.id },
      orderBy: { changedAt: 'asc' },
      select: { diff: true },
    });
    const moves = revisions
      .map((r) => (r.diff as { status?: { from: string; to: string } }).status)
      .filter((m) => m !== undefined);
    // The LAST move is the promotion, and it starts at In Progress.
    expect(moves.at(-1)).toEqual({ from: 'in_progress', to: 'in_review' });
  });
});

describe('the LATCH — a card that arrives at implemented AFTER the green', () => {
  it('promotes itself the moment it arrives, with no further delivery', async () => {
    // The window MOTIR-3004's push-first ordering opens: the agent pushes, CI
    // reports green, and only then does the card reach `implemented`. Edge 1
    // found nothing; edge 2 is what saves it.
    const s = await makeScenario('latch@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Green arrived first' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await linkOne(item.identifier, 18);
    await openPr(`subtask/${item.identifier}-work`, 18);
    // Park it at Blocked: the pull-request delivery moved it to implemented, and this
    // test is about the card NOT being at a source status when CI reports. Since
    // MOTIR-12094 In Progress IS a source (the green would promote it there), so the
    // window the latch exists for is a card at a status that is not one.
    await workItemsService.updateStatus(item.id, 'blocked', s.ctx);

    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [18] });
    expect(await statusOf(item.id)).toBe('blocked');

    // The agent's own transition, arriving late — and landing at in_review.
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('latches a SESSION card too, through mark_integrated', async () => {
    // The loop integrates its cards one at a time and CI runs on each push, so a
    // card can join a branch whose verdict is ALREADY green. The first card is
    // what makes the delivery record rows at all — a pull request that delivers
    // nothing is still the clean no-op it always was, which is why the green has
    // to be recorded while at least one card is on the branch.
    const s = await makeScenario('latch-session@example.com');
    const branch = 'motir/auto-20260819-040000';
    const first = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'First on the branch' },
      s.ctx,
    );
    await workItemsService.updateStatus(first.id, 'in_progress', s.ctx);
    await workItemsService.markIntegrated(first.id, branch, s.ctx);
    await openPr(branch, 19);
    await ci({ conclusion: 'success', headSha: 'sha-s', prNumbers: [19] });
    expect(await statusOf(first.id)).toBe('in_review');

    // A LATER card joins the same branch, after the verdict is already recorded.
    const later = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Integrated after the green' },
      s.ctx,
    );
    await workItemsService.updateStatus(later.id, 'in_progress', s.ctx);
    await workItemsService.markIntegrated(later.id, branch, s.ctx);

    expect(await statusOf(later.id)).toBe('in_review');
  });

  it('does NOT latch on a failing, a pending, or a superseded verdict', async () => {
    const s = await makeScenario('latch-guards@example.com');

    // failing
    const failing = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Red' },
      s.ctx,
    );
    await workItemsService.updateStatus(failing.id, 'in_progress', s.ctx);
    await linkOne(failing.identifier, 20);
    await openPr(`subtask/${failing.identifier}-work`, 20);
    await workItemsService.updateStatus(failing.id, 'in_progress', s.ctx);
    await ci({ conclusion: 'failure', headSha: 'sha1', prNumbers: [20] });
    await workItemsService.updateStatus(failing.id, 'implemented', s.ctx);
    expect(await statusOf(failing.id)).toBe('implemented');

    // still pending
    const pending = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Running' },
      s.ctx,
    );
    await workItemsService.updateStatus(pending.id, 'in_progress', s.ctx);
    await linkOne(pending.identifier, 21);
    await openPr(`subtask/${pending.identifier}-work`, 21);
    await workItemsService.updateStatus(pending.id, 'in_progress', s.ctx);
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha1', prNumbers: [21] });
    await workItemsService.updateStatus(pending.id, 'implemented', s.ctx);
    expect(await statusOf(pending.id)).toBe('implemented');

    // superseded: green on an old sha, a newer push still running
    const superseded = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Stale green' },
      s.ctx,
    );
    await workItemsService.updateStatus(superseded.id, 'in_progress', s.ctx);
    await linkOne(superseded.identifier, 22);
    await openPr(`subtask/${superseded.identifier}-work`, 22);
    await workItemsService.updateStatus(superseded.id, 'in_progress', s.ctx);
    await ci({ conclusion: 'success', headSha: 'sha-old', prNumbers: [22] });
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-new', prNumbers: [22] });
    await workItemsService.updateStatus(superseded.id, 'implemented', s.ctx);
    expect(await statusOf(superseded.id)).toBe('implemented');
  });

  it('is a clean no-op for a card with NO change request at all', async () => {
    // The ordinary case for a human moving a card to Implemented by hand.
    const s = await makeScenario('latch-none@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'No pull request' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    expect(await statusOf(item.id)).toBe('implemented');
  });
});

describe('idempotence — the two edges never promote twice', () => {
  it('a redelivered green performs no second transition and records no second revision', async () => {
    const s = await makeScenario('ci-idempotent@example.com');
    const item = await cardWithPr(s, 'A change', 23);

    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [23] });
    expect(await statusOf(item.id)).toBe('in_review');
    const afterFirst = await revisionCount(item.id);

    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [23] });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await revisionCount(item.id)).toBe(afterFirst);
  });

  it('the two edges together produce ONE promotion, whichever fires first', async () => {
    const s = await makeScenario('ci-both-edges@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Both edges' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await linkOne(item.identifier, 24);
    await openPr(`subtask/${item.identifier}-work`, 24);
    // Blocked, not In Progress — In Progress is a source since MOTIR-12094.
    await workItemsService.updateStatus(item.id, 'blocked', s.ctx);

    // Edge 2 first: the green is recorded, then the card arrives.
    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [24] });
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect(await statusOf(item.id)).toBe('in_review');
    const afterLatch = await revisionCount(item.id);

    // Edge 1 second: another delivery of the same verdict finds it already there.
    await ci({ conclusion: 'success', headSha: 'sha1', prNumbers: [24] });

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await revisionCount(item.id)).toBe(afterLatch);
  });
});

describe('a card the promotion CANNOT move is skipped, not fatal', () => {
  it('a project with no `in_review` loses only its own card — the siblings still promote', async () => {
    // A workspace may hold a project on a CUSTOM workflow that has no
    // `in_review` at all, and a run's session branch can carry cards from both.
    // The rule is the one `completeSession` already applies to a close-out: a
    // per-card refusal is a skip, so one unpromotable card cannot strand the
    // rest of the run at Implemented.
    const s = await makeScenario('ci-refused@example.com');
    const custom = await projectsService.createProject({
      workspaceId: s.workspace.id,
      actorUserId: s.user.id,
      name: 'Custom',
      identifier: 'CUST',
    });
    // The custom workflow's review column is called something else, which is all
    // it takes: the target status does not exist for this project.
    await adminDb.workflowStatus.updateMany({
      where: { projectId: custom.id, key: 'in_review' },
      data: { key: 'code_review' },
    });

    const branch = 'motir/auto-20260819-050000';
    const ordinary = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Ordinary workflow' },
      s.ctx,
    );
    const refused = await workItemsService.createWorkItem(
      { projectId: custom.id, kind: 'task', title: 'Custom workflow' },
      s.ctx,
    );
    for (const item of [ordinary, refused]) {
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
      await workItemsService.markIntegrated(item.id, branch, s.ctx);
      expect(await statusOf(item.id)).toBe('implemented');
    }
    await openPr(branch, 23);
    const before = await revisionCount(refused.id);

    // The green still reports normally — a skipped card is not a failed webhook.
    await ci({ conclusion: 'success', headSha: 'sha-r', prNumbers: [23] });

    expect(await statusOf(ordinary.id)).toBe('in_review');
    expect(await statusOf(refused.id)).toBe('implemented');
    // …and it was SKIPPED, not moved somewhere else: nothing was written for it.
    expect(await revisionCount(refused.id)).toBe(before);
  });

  it('a MARKED card (a legacy mark on an open card) is skipped the same way — MOTIR-6681', async () => {
    // A card marked under MOTIR-6672 is `done` and never at Implemented, but one
    // marked while open before that rule is, and `in_review` is outside the done
    // category the mark holds it to. The promotion records a skip for that card —
    // it does not fail the webhook, and it does not stop its sibling.
    const s = await makeScenario('ci-marked@example.com');
    const marked = await cardWithPr(s, 'Marked while open', 31);
    await adminDb.workItem.update({ where: { id: marked.id }, data: { obsolescence: 'outdated' } });
    const before = await revisionCount(marked.id);

    const res = await ci({ conclusion: 'success', headSha: 'sha-m', prNumbers: [31] });

    expect(res).toMatchObject({ outcome: 'verified', ciState: 'passing' });
    expect(await statusOf(marked.id)).toBe('implemented');
    expect(await revisionCount(marked.id)).toBe(before);
  });

  it('a workflow with no EDGE to in_review is skipped the same way', async () => {
    // The second tolerated refusal: the status exists, but this project's
    // workflow has no `implemented → in_review` transition. Both refusals are
    // the project's own answer about its own card, and neither is a fault of
    // the run — so both skip rather than throw.
    const s = await makeScenario('ci-noedge@example.com');
    const edgeless = await projectsService.createProject({
      workspaceId: s.workspace.id,
      actorUserId: s.user.id,
      name: 'Edgeless',
      identifier: 'EDGE',
    });
    const from = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: edgeless.id, key: 'implemented' },
    });
    const to = await adminDb.workflowStatus.findFirstOrThrow({
      where: { projectId: edgeless.id, key: 'in_review' },
    });
    await adminDb.workflowTransition.deleteMany({
      where: { projectId: edgeless.id, fromStatusId: from.id, toStatusId: to.id },
    });

    const branch = 'motir/auto-20260819-060000';
    const ordinary = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Ordinary workflow' },
      s.ctx,
    );
    const refused = await workItemsService.createWorkItem(
      { projectId: edgeless.id, kind: 'task', title: 'No edge to review' },
      s.ctx,
    );
    for (const item of [ordinary, refused]) {
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
      await workItemsService.markIntegrated(item.id, branch, s.ctx);
    }
    await openPr(branch, 24);

    await ci({ conclusion: 'success', headSha: 'sha-e', prNumbers: [24] });

    expect(await statusOf(ordinary.id)).toBe('in_review');
    expect(await statusOf(refused.id)).toBe('implemented');
  });
});

describe('a row that is GONE by the time the promotion runs', () => {
  // Both edges run AFTER their transaction has committed, so the world can have
  // moved on: the pull request row can be deleted (a repository disconnected,
  // an installation removed) and the card can be archived away. Neither may
  // throw — a promotion that raises here turns a recorded verdict into a webhook
  // GitHub retries forever, and a card's own transition into a 500.
  it('a change request that no longer exists promotes nothing, quietly', async () => {
    const s = await makeScenario('gone-pr@example.com');

    const promoted = await promoteDeliveredCardsOnGreen({
      changeRequestId: 'no-such-change-request',
      workspaceId: s.workspace.id,
      actorUserId: s.user.id,
    });

    expect(promoted).toEqual([]);
  });

  it('a work item that no longer exists latches nothing, quietly', async () => {
    const s = await makeScenario('gone-item@example.com');

    await expect(promoteIfCiAlreadyGreen('no-such-work-item', s.ctx)).resolves.toBe(false);
  });
});

// ── ALL GREEN PROMOTES (Story MOTIR-3655 · MOTIR-3685) ───────────────────────
//
// `ciPromotion` shipped promoting every card a pull request delivers the moment
// THAT pull request went green — correct while a card had one pull request, and
// wrong the first time it has two. A card delivered by a green pull request and
// a red one was announced reviewable on half its evidence.
//
// This is a CHANGE to shipped behaviour, so the unchanged case is asserted as
// carefully as the changed one: over a set of ONE, "every" and "some" agree, and
// almost every card in the tree is that case.

/** Record a SECOND pull request as delivering `workItemId`.
 *
 *  ⚠️ MOTIR-3674 — this goes through the REAL link door now. It used to insert a
 *  `work_item_delivery` row directly, which was a faithful fixture only while the
 *  title parse ALSO stamped `github_pull_request.work_item_id` from the branch.
 *  With the parse retired and that column dropped (MOTIR-3757), the delivery row
 *  IS the whole of a link — but the door stays the door: a fixture that inserts
 *  the row itself asserts a shape rather than the behaviour a caller gets, and
 *  `link_pull_request` does more than write the row (it stamps the provenance and
 *  refreshes the unlinked-pull-request check). */
async function alsoDelivers(
  s: Awaited<ReturnType<typeof makeScenario>>,
  workItemId: string,
  prNumber: number,
) {
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: prNumber } });
  await githubPullRequestService.linkPullRequest(workItemId, pr.id, s.ctx);
  return pr;
}

describe('a card reaches In Review only when EVERY pull request delivering it is green', () => {
  it('one green and one RED leaves it at implemented', async () => {
    const s = await makeScenario('allgreen-red@example.com');
    const card = await cardWithPr(s, 'spans two pull requests', 41);
    await openPr('subtask/ACME-1-second', 42);
    await alsoDelivers(s, card.id, 42);

    await ci({ conclusion: 'failure', headSha: 'sha-red', prNumbers: [42] });
    await ci({ conclusion: 'success', headSha: 'sha-green', prNumbers: [41] });

    // The green one WOKE the promotion; it did not decide it.
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('one green and one still RUNNING leaves it at implemented', async () => {
    // `running` is not a failure and not a pass — the loop is waiting for a
    // verdict, not receiving one — so it withholds exactly as a red does.
    const s = await makeScenario('allgreen-running@example.com');
    const card = await cardWithPr(s, 'one still building', 43);
    await openPr('subtask/ACME-1-second', 44);
    await alsoDelivers(s, card.id, 44);

    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-pending', prNumbers: [44] });
    await ci({ conclusion: 'success', headSha: 'sha-green', prNumbers: [43] });

    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('BOTH green promotes it', async () => {
    const s = await makeScenario('allgreen-both@example.com');
    const card = await cardWithPr(s, 'both landed', 45);
    await openPr('subtask/ACME-1-second', 46);
    await alsoDelivers(s, card.id, 46);

    await ci({ conclusion: 'success', headSha: 'sha-a', prNumbers: [45] });
    await ci({ conclusion: 'success', headSha: 'sha-b', prNumbers: [46] });

    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('the LATCH still works — the SECOND pull request going green later promotes it', async () => {
    // The property the latch exists for, now over a set: the first green arrives
    // and correctly does nothing, and the card is promoted by the last one
    // rather than being stranded at implemented for ever.
    const s = await makeScenario('allgreen-latch@example.com');
    const card = await cardWithPr(s, 'the second one lands later', 47);
    await openPr('subtask/ACME-1-second', 48);
    await alsoDelivers(s, card.id, 48);

    await ci({ conclusion: 'success', headSha: 'sha-first', prNumbers: [47] });
    expect(await statusOf(card.id)).toBe('implemented');

    await ci({ conclusion: 'success', headSha: 'sha-second', prNumbers: [48] });
    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a RED that goes green on a re-push promotes it — the fixing loop’s own case', async () => {
    // MOTIR-3685's watch-and-fix loop pushes a fix, and the newer sha's green
    // must outrank the older sha's red. That is `derivePrCiState`'s latest-sha
    // rule, reached through the set.
    const s = await makeScenario('allgreen-refix@example.com');
    const card = await cardWithPr(s, 'fixed on the second try', 49);
    await openPr('subtask/ACME-1-second', 50);
    await alsoDelivers(s, card.id, 50);

    await ci({ conclusion: 'success', headSha: 'sha-ok', prNumbers: [49] });
    await ci({ conclusion: 'failure', headSha: 'sha-bad', prNumbers: [50] });
    expect(await statusOf(card.id)).toBe('implemented');

    await ci({ conclusion: 'success', headSha: 'sha-fixed', prNumbers: [50] });
    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a SINGLE-pull-request card is unchanged — every and some agree over a set of one', async () => {
    // The case nearly every card in the tree is. An all-green rule that
    // perturbed it would have made the product worse to fix a rarity.
    const s = await makeScenario('allgreen-single@example.com');
    const card = await cardWithPr(s, 'the ordinary card', 51);

    await ci({ conclusion: 'success', headSha: 'sha-only', prNumbers: [51] });

    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a card with NO pull request at all is never promoted — an empty set is not green', async () => {
    // `[].every(...)` is vacuously true, so the empty case has to be refused
    // explicitly or a card with no evidence whatever promotes itself.
    const s = await makeScenario('allgreen-none@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'no pull request' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    expect(await promoteIfCiAlreadyGreen(item.id, s.ctx)).toBe(false);
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('BOTH EDGES agree — the arrival edge withholds on the same set edge 1 withholds on', async () => {
    // The latch only works if the two edges ask the same question. If one
    // counted ANY and the other EVERY, a card would be reviewable or not
    // depending on which edge happened to fire.
    const s = await makeScenario('allgreen-edges@example.com');
    const card = await cardWithPr(s, 'arrives after a partial green', 52);
    await openPr('subtask/ACME-1-second', 53);
    await alsoDelivers(s, card.id, 53);

    await ci({ conclusion: 'success', headSha: 'sha-a', prNumbers: [52] });
    await ci({ conclusion: 'failure', headSha: 'sha-b', prNumbers: [53] });

    // Drive the ARRIVAL edge directly, which is the one a run's own transition
    // fires. It must reach the same verdict.
    expect(await promoteIfCiAlreadyGreen(card.id, s.ctx)).toBe(false);
    expect(await statusOf(card.id)).toBe('implemented');
  });
});

// ── A REPOSITORY THAT CANNOT REPORT A CHECK IS GREEN (MOTIR-3823) ────────────
//
// `derivePrCiState` answers `null` for a pull request with no check rows, and
// `deliverySetIsGreen` read every `null` as "not passing" — so a card whose only
// delivery sits in a repository with NO CI was permanently un-promotable. That is
// every `targetRepo: motir-meta` card: those cards went `implemented → done` on
// merge and never passed through In Review at all.
//
// Decided by Yue, 2026-08-28: a CI-less repository counts as GREEN. The whole
// difficulty is that the NAIVE fix — read `null` as `passing` — is a worse,
// silent regression: `null` is ALSO the state of every pull request for the first
// seconds of its life, which is exactly when the arrival edge fires. So these
// tests come in pairs, and the second of each pair is the one the naive fix
// fails.

/** THE EVIDENCE that `moooon/acme-docs` cannot report a check: a pull request of
 *  its own that reached MERGE without ever recording one. It delivers no card.
 *
 *  This is the half of the discriminator that is evidence rather than the
 *  absence of it — a merged pull request had its entire lifetime to produce a
 *  check — and without it a newly-connected repository that HAS CI but has not
 *  run it yet would read as CI-less and promote its first card early. */
async function mergedSilentPr(number: number) {
  const headRef = `docs/history-${number}`;
  await openPrIn(DOCS_REPO_PROVIDER_ID, headRef, number);
  await githubWebhookService.handleEvent('pull_request', {
    action: 'closed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(DOCS_REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'closed',
      merged: true,
      // GitHub always carries this on a merged pull request, and the
      // discriminator READS it: a row whose `created_at` postdates its own
      // `merged_at` was written by the historical backfill, not watched, and is
      // not evidence. Omitting it here would exercise a shape GitHub never sends.
      merged_at: new Date().toISOString(),
      title: `A docs change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

/** A card whose ONLY delivery is a pull request in `moooon/acme-docs`.
 *
 *  Deliberately NOT `cardWithPr`: that helper asserts the card is at
 *  `implemented` after the delivery, and here the arrival edge is expected to
 *  promote it straight past that. The status is what each test asserts. */
async function cardWithDocsPr(
  s: Awaited<ReturnType<typeof makeScenario>>,
  title: string,
  number: number,
) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme-docs',
    number,
    headRef: `subtask/${item.identifier}-docs`,
    title: `A docs change (subtask/${item.identifier}-docs)`,
  });
  await openPrIn(DOCS_REPO_PROVIDER_ID, `subtask/${item.identifier}-docs`, number);
  return item;
}

/** Record a check run in `moooon/acme`, so that repository has demonstrably
 *  reported one — which is what makes a LATER silent pull request there mean
 *  "not yet", never "no CI". Uses a pull request of its own so the card under
 *  test keeps an empty check set. */
async function repoHasReportedBefore(number: number) {
  await openPr(`chore/unrelated-${number}`, number);
  await ci({ conclusion: 'success', headSha: `sha-history-${number}`, prNumbers: [number] });
}

describe('a delivery in a repository that CANNOT report a check counts as green', () => {
  it('promotes a card whose ONLY delivery is in a CI-less repository', async () => {
    // The reproduction, reduced: a single-repository `motir-meta` card. Before
    // MOTIR-3823 this sat at `implemented` for ever — nothing would ever report,
    // so nothing would ever promote it.
    const s = await makeScenario('cil-only@example.com');
    await mergedSilentPr(60);

    const card = await cardWithDocsPr(s, 'a corpus change', 61);

    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a MIXED set — one passing delivery and one CI-less — promotes', async () => {
    // The shape the defect was FOUND on (MOTIR-3780): motir-core#2429 green,
    // motir-meta#334 silent for ever. One `null` was enough to withhold.
    const s = await makeScenario('cil-mixed@example.com');
    await mergedSilentPr(62);
    const card = await cardWithPr(s, 'spans a code repo and a docs repo', 63);
    await openPrIn(DOCS_REPO_PROVIDER_ID, 'subtask/ACME-1-docs', 64);
    await alsoDelivers(s, card.id, 64);

    expect(await statusOf(card.id)).toBe('implemented');
    await ci({ conclusion: 'success', headSha: 'sha-code', prNumbers: [63] });

    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a passing delivery plus a FAILING one still does not promote', async () => {
    // The CI-less rule widens what counts as green; it must not weaken what
    // counts as red. Asserted with the docs repo present so the widening is
    // live in this scenario.
    const s = await makeScenario('cil-red@example.com');
    await mergedSilentPr(65);
    const card = await cardWithPr(s, 'one repo is red', 66);
    await openPr('subtask/ACME-1-second', 67);
    await alsoDelivers(s, card.id, 67);

    await ci({ conclusion: 'failure', headSha: 'sha-red', prNumbers: [67] });
    await ci({ conclusion: 'success', headSha: 'sha-green', prNumbers: [66] });

    expect(await statusOf(card.id)).toBe('implemented');
  });
});

describe('a delivery that has simply NOT REPORTED YET is not green — the trap', () => {
  it('does NOT promote a card whose repository CAN report but has not yet — the ARRIVAL edge', async () => {
    // THE criterion the naive `null → passing` fix fails. `promoteIfCiAlreadyGreen`
    // fires the instant a card reaches `implemented`, which a run reaches right
    // after `gh pr create` — reliably before any check row exists. Reading that
    // silence as a pass would announce essentially every card in the system
    // reviewable before its build had spoken.
    const s = await makeScenario('cil-notyet-arrival@example.com');
    await repoHasReportedBefore(70);

    const card = await cardWithPr(s, 'its build has not started', 71);

    expect(await statusOf(card.id)).toBe('implemented');
    expect(await promoteIfCiAlreadyGreen(card.id, s.ctx)).toBe(false);
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('does NOT promote when a SIBLING delivery has not reported yet — the CI edge', async () => {
    // The same question at the other edge. A green pull request WAKES the
    // promotion; a sibling in a repository that can report and has not yet must
    // still withhold it. Both edges ask one function of one set, and this is what
    // asserts they agree rather than assuming it.
    const s = await makeScenario('cil-notyet-ci@example.com');
    await repoHasReportedBefore(72);
    const card = await cardWithPr(s, 'a sibling is still silent', 73);
    await openPr('subtask/ACME-1-second', 74);
    await alsoDelivers(s, card.id, 74);

    await ci({ conclusion: 'success', headSha: 'sha-first', prNumbers: [73] });

    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('a repository with NO history at all is not yet CI-less — absence of evidence holds', async () => {
    // The safe-direction half, and the property that buys out the worse failure.
    // An OPEN pull request and no check row is exactly what a newly-connected
    // repository WITH CI looks like in the seconds before its first run reports,
    // so an untested repository is read as ABLE to report and the card is HELD —
    // today's behaviour, visible, and self-correcting.
    const s = await makeScenario('cil-nohistory@example.com');

    const card = await cardWithDocsPr(s, 'the docs repo’s first ever card', 75);

    expect(await statusOf(card.id)).toBe('implemented');

    // …and the repository's first MERGE without a check resolves it: the same
    // card, re-asked, now promotes.
    await mergedSilentPr(76);
    expect(await promoteIfCiAlreadyGreen(card.id, s.ctx)).toBe(true);
    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a BACKFILLED merge is not evidence — a repository connected mid-life still holds', async () => {
    // The hole the WATCHED clause closes, and it is the worst one available:
    // `historicalPullRequestBackfillService` mirrors a repository's
    // PRE-CONNECTION pull requests through the same upsert — merged, with no
    // check rows, because Motir was not there to receive them. A repository
    // connected mid-life therefore arrives carrying merged silent rows, and a
    // rule reading "has a merged pull request with no checks" would call it
    // CI-less on its first day and promote EVERY one of its cards to In Review
    // before any build had spoken.
    //
    // The tell is on the row: a backfilled one was created long AFTER it merged,
    // where a watched one was created by the `opened` delivery and predates its
    // own merge. Built here by aging the row into that shape rather than by
    // driving the sweep, which needs the GitHub API — the shape is the fact under
    // test, and it is the exact shape that service produces.
    const s = await makeScenario('cil-backfilled@example.com');
    await mergedSilentPr(78);
    await adminDb.githubPullRequest.updateMany({
      where: { number: 78 },
      data: {
        mergedAt: new Date('2026-01-01T00:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });

    const card = await cardWithDocsPr(s, 'a card in a mid-life repository', 79);

    expect(await statusOf(card.id)).toBe('implemented');
    expect(await promoteIfCiAlreadyGreen(card.id, s.ctx)).toBe(false);

    // …and a merge Motir actually WATCHED, in the same repository, does resolve it.
    await mergedSilentPr(80);
    expect(await promoteIfCiAlreadyGreen(card.id, s.ctx)).toBe(true);
    expect(await statusOf(card.id)).toBe('in_review');
  });

  it('a card with NO delivery at all is still not green — the empty set is untouched', async () => {
    // The property MOTIR-3685 asserted and this card must not perturb: there is
    // nothing to map, so the CI-less rule cannot reach it.
    const s = await makeScenario('cil-empty@example.com');
    await mergedSilentPr(77);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'no pull request' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    expect(await promoteIfCiAlreadyGreen(item.id, s.ctx)).toBe(false);
    expect(await statusOf(item.id)).toBe('implemented');
  });
});
