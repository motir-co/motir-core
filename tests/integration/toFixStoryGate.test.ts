import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { homeService } from '@/lib/services/homeService';
import { projectsService } from '@/lib/services/projectsService';
import { pullRequestMergeabilityService } from '@/lib/services/pullRequestMergeabilityService';
import { usersService } from '@/lib/services/usersService';
import { workItemFixReasonBackfillService } from '@/lib/services/workItemFixReasonBackfillService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import { setProjectAccess } from '@/tests/helpers/projectAccess';
import { homePageItems } from '../helpers/homePage';

// THE STORY GATE for To fix on the Workbench (Story MOTIR-6588 · MOTIR-6606), on a
// real Postgres, through the real services.
//
// Every sibling tests its own link — the recompute, the wiring, the backfill, the
// partitioned read. What only this tier can see is an EVENT travelling the whole
// chain: a GitHub delivery or a person's press → the writer's recompute → the stored
// `fixReason` → the Workbench's To fix / In progress partition and its counts. So no
// case here writes `fixReason`: each reaches it through the door the product walks —
// the check webhook, the queue's `dequeued`, a mergeability reading, a gate decision,
// a status move — and asserts what the READER sees.

let scenarioSeq = 0;

async function makeScenario(email: string) {
  scenarioSeq += 1;
  const installationId = `inst-to-fix-gate-${scenarioSeq}`;
  const providerRepoId = `66060${scenarioSeq}`;
  const repoName = `acme${scenarioSeq}`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Acme ${scenarioSeq}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: 'manual' } });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: 'moooon', accountType: 'Organization' },
    repos: [
      {
        providerRepoId,
        owner: 'moooon',
        name: repoName,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const installation = { id: installationId, account: { login: 'moooon', type: 'Organization' } };
  return { user, workspace, project, ctx, installation, providerRepoId, repoName };
}
type Scenario = Awaited<ReturnType<typeof makeScenario>>;

const hctx = (s: Scenario, userId: string = s.user.id) => ({
  userId,
  workspaceId: s.workspace.id,
  projectId: s.project.id,
});

const pullRequestEvent = (
  s: Scenario,
  action: 'opened' | 'synchronize',
  number: number,
  headRef: string,
  sha?: string,
) =>
  githubWebhookService.handleEvent('pull_request', {
    action,
    installation: s.installation,
    repository: { id: Number(s.providerRepoId) },
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

/** A card of the reader's, In Progress, delivered by one open pull request. */
async function card(s: Scenario, title: string, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-${number}`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: s.repoName,
    number,
    headRef,
  });
  await pullRequestEvent(s, 'opened', number, headRef);
  return { item, headRef };
}

/** A check completing at `headSha` with `conclusion`, or starting (`null`). */
const check = (
  s: Scenario,
  number: number,
  headSha: string,
  name: string,
  conclusion: 'success' | 'failure' | null,
) =>
  githubWebhookService.handleEvent('check_run', {
    action: conclusion === null ? 'created' : 'completed',
    installation: s.installation,
    repository: { id: Number(s.providerRepoId) },
    check_run: {
      head_sha: headSha,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
      name,
      check_suite: { head_branch: null },
      pull_requests: [{ number }],
    },
  });

const prRow = (s: Scenario, number: number) =>
  adminDb.githubPullRequest.findFirstOrThrow({
    where: { number, repo: { workspaceId: s.workspace.id } },
  });

/** The pull request at `number` reported conflicted (or clean) at `headSha`. */
async function mergeability(
  s: Scenario,
  number: number,
  headSha: string,
  state: 'dirty' | 'clean',
) {
  const pr = await prRow(s, number);
  await pullRequestMergeabilityService.settleReading(s.workspace.id, pr.id, {
    mergeable: state === 'clean',
    mergeableState: state,
    headSha,
  });
}

async function awaitingMergeGate(itemId: string) {
  const [gate] = await adminDb.approvalGate.findMany({
    where: { workItemId: itemId, kind: 'pull_request_approval', state: 'awaiting' },
  });
  return gate!;
}

/** The queue ejects the pull request at `number` with CI_FAILURE at `headSha`. */
async function queueFailure(s: Scenario, itemId: string, number: number, headSha: string) {
  const gate = await awaitingMergeGate(itemId);
  await approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
    s.ctx,
  );
  const pr = await prRow(s, number);
  await adminDb.githubPullRequest.update({
    where: { id: pr.id },
    data: { mergeAuthority: 'gate', mergeOutcomeRef: `queue:entry-${number}` },
  });
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', 'dequeued-ci-failure.json');
  const body = JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
  const pull = structuredClone(body['pull_request']) as Record<string, unknown>;
  pull['number'] = number;
  pull['head'] = { ...(pull['head'] as Record<string, unknown>), sha: headSha };
  await githubWebhookService.handleEvent(
    'pull_request',
    {
      ...body,
      number,
      installation: s.installation,
      repository: { id: Number(s.providerRepoId), full_name: `moooon/${s.repoName}` },
      pull_request: pull,
    },
    `guid-to-fix-gate-${number}-${headSha}`,
  );
}

/** Request changes on the card's awaiting approve-to-merge gate. */
async function requestChanges(s: Scenario, itemId: string, noteMd: string) {
  const gate = await awaitingMergeGate(itemId);
  await approvalGatesService.decide(
    {
      stamp: DECIDED_WITHOUT_A_READER,
      gateId: gate.id,
      decision: 'request_changes',
      noteMd,
      source: 'ui',
    },
    s.ctx,
  );
}

/** Where the READER sees the card: which work tab lists it, and the three counts. */
async function whereIs(s: Scenario, itemId: string) {
  const ctx = hctx(s);
  const [toFix, inProgress, finished, counts] = await Promise.all([
    homeService.listToFix(ctx),
    homeService.listInProgress(ctx),
    homeService.listRecentlyFinished(ctx),
    homeService.tabCounts(ctx),
  ]);
  // The counts are the lists' own totals — the badge never disagrees with the rows.
  expect(counts.toFix).toBe(toFix.total);
  // MOTIR-8015: In progress pages GROUPS, so its badge (items) is the page's items.
  expect(counts.inProgress).toBe(homePageItems(inProgress).length);
  const row = toFix.items.find((r) => r.id === itemId);
  const tabs = [
    row ? 'to-fix' : null,
    homePageItems(inProgress).some((r) => r.id === itemId) ? 'in-progress' : null,
    homePageItems(finished).some((r) => r.id === itemId) ? 'finished' : null,
  ].filter((t): t is string => t !== null);
  return { tabs, row, counts };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('per reason — an event puts the card on To fix, and only there', () => {
  it('a red check run → ci_failed, naming the check', async () => {
    const s = await makeScenario('gate-red@example.com');
    const { item } = await card(s, 'red card', 101);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect((await whereIs(s, item.id)).tabs).toEqual(['in-progress']);

    await check(s, 101, 'sha-a', 'vitest', 'failure');

    const seen = await whereIs(s, item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(seen.row).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: { repair: 'fix', check: 'vitest', affected: 1, total: 1 },
    });
    expect(seen.counts).toMatchObject({ toFix: 1, inProgress: 0 });
  });

  it('a merge-queue CI_FAILURE exit → queue_failed, naming the queue’s reason', async () => {
    const s = await makeScenario('gate-queue@example.com');
    const { item } = await card(s, 'queued card', 102);
    await check(s, 102, 'sha-a', 'vitest', 'success');
    expect((await whereIs(s, item.id)).tabs).toEqual(['in-progress']);

    await queueFailure(s, item.id, 102, 'sha-a');

    const seen = await whereIs(s, item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(seen.row).toMatchObject({
      status: 'implemented',
      fixReason: 'queue_failed',
      fixDetail: { repair: 'fix', queueReason: 'CI_FAILURE' },
    });
  });

  it('a conflicted mergeability reading → conflicted, naming the base', async () => {
    const s = await makeScenario('gate-conflict@example.com');
    const { item } = await card(s, 'conflicted card', 103);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    await mergeability(s, 103, 'sha-a', 'dirty');

    const seen = await whereIs(s, item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(seen.row).toMatchObject({
      fixReason: 'conflicted',
      fixDetail: { repair: 'fix', base: 'main' },
    });
  });

  it('a Request changes decision → changes_requested, naming the reviewer and the note, repaired by `motir fix` (§12.7)', async () => {
    const s = await makeScenario('gate-changes@example.com');
    const { item } = await card(s, 'reviewed card', 104);
    await check(s, 104, 'sha-a', 'vitest', 'success');

    await requestChanges(s, item.id, '\nRename the export button.\nAnd the tooltip.');

    const seen = await whereIs(s, item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(seen.row).toMatchObject({
      status: 'in_review',
      fixReason: 'changes_requested',
      fixDetail: {
        repair: 'fix',
        gate: 'pull_request_approval',
        reviewRef: null,
        notePreview: 'Rename the export button.',
      },
    });
    // The reviewer's NAME, never the gate's `Name <email>` audit label (found by the
    // acceptance E2E, MOTIR-6607).
    const reviewer = (seen.row!.fixDetail as { reviewerName: string | null }).reviewerName;
    expect(reviewer).toEqual(expect.any(String));
    expect(reviewer).not.toMatch(/[<@]/);
  });
});

describe('per clearing path — the repair takes the card back off To fix', () => {
  it('a green push clears ci_failed → back on In progress', async () => {
    const s = await makeScenario('gate-green@example.com');
    const { item } = await card(s, 'red card', 111);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    await check(s, 111, 'sha-a', 'vitest', 'failure');
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-fix']);

    await check(s, 111, 'sha-b', 'vitest', 'success');

    expect((await whereIs(s, item.id)).tabs).toEqual(['in-progress']);
  });

  it('a resolved conflict (a clean reading) clears conflicted → back on In progress', async () => {
    const s = await makeScenario('gate-resolved@example.com');
    const { item } = await card(s, 'conflicted card', 112);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    await mergeability(s, 112, 'sha-a', 'dirty');
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-fix']);

    await mergeability(s, 112, 'sha-a', 'clean');

    expect((await whereIs(s, item.id)).tabs).toEqual(['in-progress']);
  });

  // Since Story MOTIR-10305 the push keeps the card on To fix as FIXING while its CI runs,
  // and the green that follows is what takes it back to In progress.
  it('a new commit after changes requested reads Fixing while CI runs, and its green clears it', async () => {
    const s = await makeScenario('gate-newcommit@example.com');
    const { item, headRef } = await card(s, 'reviewed card', 113);
    await check(s, 113, 'sha-a', 'vitest', 'success');
    await requestChanges(s, item.id, 'Rename it.');
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-fix']);

    await pullRequestEvent(s, 'synchronize', 113, headRef, 'sha-b');
    await check(s, 113, 'sha-b', 'vitest', null);

    const fixing = await whereIs(s, item.id);
    expect(fixing.tabs).toEqual(['to-fix']);
    expect(fixing.row).toMatchObject({
      fixReason: 'changes_requested',
      fixDetail: { fixing: true },
    });

    await check(s, 113, 'sha-b', 'vitest', 'success');

    expect((await whereIs(s, item.id)).tabs).not.toContain('to-fix');
  });

  it('a move to a done-category status clears it → on Recently finished', async () => {
    const s = await makeScenario('gate-done@example.com');
    const { item } = await card(s, 'red card', 114);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    await check(s, 114, 'sha-a', 'vitest', 'failure');
    expect((await whereIs(s, item.id)).tabs).toEqual(['to-fix']);

    // `done` itself waits on the merge while a pull request is open; `cancelled` is the
    // done-category move a person can make here.
    await workItemsService.updateStatus(item.id, 'cancelled', s.ctx);

    expect((await whereIs(s, item.id)).tabs).toEqual(['finished']);
  });
});

describe('priority', () => {
  it('a card both red and conflicted is listed as conflicted', async () => {
    const s = await makeScenario('gate-priority@example.com');
    const { item } = await card(s, 'red and conflicted', 121);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    await check(s, 121, 'sha-a', 'vitest', 'failure');
    expect((await whereIs(s, item.id)).row?.fixReason).toBe('ci_failed');

    await mergeability(s, 121, 'sha-a', 'dirty');

    const seen = await whereIs(s, item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(seen.row?.fixReason).toBe('conflicted');
  });
});

describe('priority — a dead run (Story MOTIR-6590 · MOTIR-6883, case 5)', () => {
  it('a card at In Progress with a dead run AND a failing check reads run_died, listed above queue_failed and changes_requested', async () => {
    const s = await makeScenario('gate-priority-died@example.com');
    // Each PR reason through its own event, as the cases above reach them.
    const sentBack = await card(s, 'sent back', 131);
    await check(s, 131, 'sha-a', 'vitest', 'success');
    await requestChanges(s, sentBack.item.id, 'Not yet.');
    const queued = await card(s, 'queued', 132);
    await check(s, 132, 'sha-a', 'vitest', 'success');
    await queueFailure(s, queued.item.id, 132, 'sha-a');

    // The dead-run card: In Progress, its pull request red, and its run dies.
    const died = await card(s, 'died', 133);
    await check(s, 133, 'sha-a', 'vitest', 'failure');
    // Opening the pull request moved it to Implemented; the run that picks it back up
    // is working on it again, so it is In Progress with its check still red.
    await workItemsService.updateStatus(died.item.id, 'in_progress', s.ctx);
    const { run } = await dispatchRunService.open(
      {
        projectKey: s.project.identifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: died.item.identifier, disposition: 'queued' }],
      },
      s.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'checkout_ready',
          workItemKey: died.item.identifier,
          disposition: 'running',
          data: { branch: died.headRef },
        },
      ],
      s.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'interrupted' }, s.ctx);

    const seen = await whereIs(s, died.item.id);
    expect(seen.tabs).toEqual(['to-fix']);
    expect(seen.row).toMatchObject({
      status: 'in_progress',
      fixReason: 'run_died',
      fixDetail: { repair: 'continue', continueKey: died.item.identifier },
    });
    const order = (await homeService.listToFix(hctx(s))).items.map((r) => r.fixReason);
    expect(order).toEqual(['run_died', 'queue_failed', 'changes_requested']);
  });
});

describe('the list agrees with the command — `motir fix`', () => {
  it('a card is on To fix exactly when claimRepair would claim it', async () => {
    const s = await makeScenario('gate-matrix@example.com');
    const shapes: Array<{ label: string; id: string }> = [];

    const red = await card(s, 'red', 131);
    await workItemsService.updateStatus(red.item.id, 'implemented', s.ctx);
    await check(s, 131, 'sha-a', 'vitest', 'failure');
    shapes.push({ label: 'red', id: red.item.id });

    const conflicted = await card(s, 'conflicted', 132);
    await workItemsService.updateStatus(conflicted.item.id, 'implemented', s.ctx);
    await mergeability(s, 132, 'sha-a', 'dirty');
    shapes.push({ label: 'conflicted', id: conflicted.item.id });

    const queued = await card(s, 'queue failed', 133);
    await check(s, 133, 'sha-a', 'vitest', 'success');
    await queueFailure(s, queued.item.id, 133, 'sha-a');
    shapes.push({ label: 'queue failed', id: queued.item.id });

    const running = await card(s, 'running', 134);
    await workItemsService.updateStatus(running.item.id, 'implemented', s.ctx);
    await check(s, 134, 'sha-a', 'vitest', null);
    shapes.push({ label: 'running', id: running.item.id });

    const green = await card(s, 'green', 135);
    await check(s, 135, 'sha-a', 'vitest', 'success');
    shapes.push({ label: 'green (in review)', id: green.item.id });

    const sentBack = await card(s, 'sent back', 136);
    await check(s, 136, 'sha-a', 'vitest', 'success');
    await requestChanges(s, sentBack.item.id, 'Not yet.');
    shapes.push({ label: 'sent back', id: sentBack.item.id });

    const building = await card(s, 'building', 137);
    await check(s, 137, 'sha-a', 'vitest', 'failure');
    // A red build lands a card that is still In Progress at Implemented (the CI
    // feedback's own move), so this shape is claimable too — and listed.
    shapes.push({ label: 'red from In Progress', id: building.item.id });

    const toFix = await homeService.listToFix(hctx(s));
    // Since MOTIR-6822 a card a review sent back is claimable too (the `review` class),
    // so EVERY listed reason here is one `motir fix` claims.
    const CLAIMED_REASONS = ['queue_failed', 'conflicted', 'ci_failed', 'changes_requested'];
    const verdicts: Record<string, { listed: string | null; claimed: boolean }> = {};
    for (const shape of shapes) {
      const row = toFix.items.find((r) => r.id === shape.id);
      const identifier = (await adminDb.workItem.findUniqueOrThrow({ where: { id: shape.id } }))
        .identifier;
      const claim = await workItemRepairService.claimRepair(s.project.id, identifier, s.ctx);
      verdicts[shape.label] = {
        listed: row?.fixReason ?? null,
        claimed: claim.outcome === 'claimed',
      };
      expect(
        CLAIMED_REASONS.includes(row?.fixReason ?? ''),
        `${shape.label}: listed ${row?.fixReason ?? 'nothing'}, claim ${claim.outcome}`,
      ).toBe(claim.outcome === 'claimed');
    }
    expect(verdicts).toEqual({
      red: { listed: 'ci_failed', claimed: true },
      conflicted: { listed: 'conflicted', claimed: true },
      'queue failed': { listed: 'queue_failed', claimed: true },
      running: { listed: null, claimed: false },
      'green (in review)': { listed: null, claimed: false },
      // A review sent it back: claimed as the `review` class, its repair `fix` (§12.7).
      'sent back': { listed: 'changes_requested', claimed: true },
      'red from In Progress': { listed: 'ci_failed', claimed: true },
    });
  });
});

describe('the backfill converges', () => {
  it('cards stuck before the wiring get their reason from one apply, and a second apply changes 0', async () => {
    // Seeded through the fixture door, which no writer recomputes — exactly the state
    // of a card that went red before this story deployed.
    const fx = await makeWorkItemFixture({ identifier: 'BKF' });
    const repo = await connectRepairRepo(fx, 'web');
    const red = await createTestWorkItem(fx, { kind: 'task', title: 'red before deploy' });
    await setStatus(red.id, 'implemented');
    await deliveredPr(fx, red.id, repo, { headRef: 'a', checks: { Vitest: 'failure' } });
    const conflicted = await createTestWorkItem(fx, { kind: 'task', title: 'conflicted' });
    await setStatus(conflicted.id, 'implemented');
    const pr = await deliveredPr(fx, conflicted.id, repo, {
      headRef: 'b',
      checks: { Vitest: 'success' },
    });
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { mergeableState: 'dirty', mergeableStateHeadSha: 'c'.repeat(40) },
    });
    const ctx = { ...fx.ctx, projectId: fx.projectId };
    expect((await homeService.tabCounts(ctx)).toFix).toBe(0);

    const first = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: false,
      workspaceId: fx.workspaceId,
    });
    expect(first.failed).toEqual([]);
    expect(first.byReason).toMatchObject({ ci_failed: 1, conflicted: 1 });
    expect(first.changed).toHaveLength(2);

    const list = await homeService.listToFix(ctx);
    expect(Object.fromEntries(list.items.map((r) => [r.id, r.fixReason]))).toEqual({
      [red.id]: 'ci_failed',
      [conflicted.id]: 'conflicted',
    });

    const second = await workItemFixReasonBackfillService.backfillFixReason({
      dryRun: false,
      workspaceId: fx.workspaceId,
    });
    expect(second.changed).toEqual([]);
  });
});

describe('isolation', () => {
  it('another workspace’s stuck card is never listed or counted', async () => {
    const mine = await makeScenario('gate-mine@example.com');
    const theirs = await makeScenario('gate-theirs@example.com');
    const { item } = await card(theirs, 'theirs', 141);
    await workItemsService.updateStatus(item.id, 'implemented', theirs.ctx);
    await check(theirs, 141, 'sha-a', 'vitest', 'failure');
    // Positive control: its own reader sees it.
    expect((await homeService.listToFix(hctx(theirs))).total).toBe(1);

    // Pointed AT the other workspace's project, so the project axis alone is not what
    // excludes it.
    const foreign = {
      userId: mine.user.id,
      workspaceId: mine.workspace.id,
      projectId: theirs.project.id,
    };
    expect((await homeService.listToFix(foreign)).total).toBe(0);
    expect((await homeService.tabCounts(foreign)).toFix).toBe(0);
    expect((await homeService.listToFix(hctx(mine))).total).toBe(0);
  });

  it('a stuck card in a project the reader cannot browse is never listed or counted', async () => {
    const s = await makeScenario('gate-private@example.com');
    const outsider = await usersService.createUser({
      email: 'gate-outsider@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    await workspacesService.addMember({
      userId: outsider.id,
      workspaceId: s.workspace.id,
      workspaceRole: 'member',
    });
    const { item } = await card(s, 'private red', 151);
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: outsider.id } });
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    await check(s, 151, 'sha-a', 'vitest', 'failure');
    // Positive control: while the project is open, the outsider sees their card.
    expect((await homeService.listToFix(hctx(s, outsider.id))).total).toBe(1);

    await setProjectAccess(adminDb, s.project.id, 'members');

    expect((await homeService.listToFix(hctx(s, outsider.id))).total).toBe(0);
    expect((await homeService.tabCounts(hctx(s, outsider.id))).toFix).toBe(0);
  });
});
