import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

/** The one external a design publish touches; mocked as a STORE so the publish's
 *  authoritative size/type read answers what was put. */
const blobs = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => blobs.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { designEvidenceService, designPrefix } from '@/lib/services/designEvidenceService';
import { makeWorkWaitOn } from '@/tests/helpers/designWaits';
import { shaFor } from '../helpers/commitShaFixtures';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { derivePrCiState } from '@/lib/github/prCiState';
import { workItemCiStateBackfillService } from '@/lib/services/workItemCiStateBackfillService';
import { mergeQueueExitService, queueExitCardMoves } from '@/lib/services/mergeQueueExitService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { NormalizedMergeQueueExit } from '@/lib/git/types';

// THE EJECTION ARM (Story MOTIR-5461 · MOTIR-5632; `docs/decisions/approval-gates.md`
// §4 THIRD AMENDMENT, decisions 1–4, 6 and 9 — and, since Story MOTIR-5799 · MOTIR-5805,
// the FOURTH AMENDMENT: a manual un-landed exit re-asks the merge question on ONE fresh
// gate at `in_review`, and approving it re-queues — except, since the FIFTH AMENDMENT
// (MOTIR-6594), a queue FAILURE, which holds the card at `implemented` and asks nothing),
// on a REAL Postgres, through the real
// webhook service — the door a GitHub delivery walks. The `dequeued` bodies are the
// REAL deliveries MOTIR-5627 captured (`tests/fixtures/github/merge-queue/`), with only
// the installation, the repository id, the number and the head re-pointed at this
// fixture's rows.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-queue-exit';
const REPO_PROVIDER_ID = '993';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const KIND = 'pull_request_approval';
/**
 * A FAILURE that still RE-ASKS. Since the FIFTH AMENDMENT (MOTIR-6594) the queue's own
 * failures (`CI_FAILURE`, `CI_TIMEOUT`, `INVALID_MERGE_COMMIT`, `GIT_TREE_INVALID`) are
 * CAN'T-LAND and hold the card at Implemented, so the tests about the RE-ASK's mechanics
 * — its idempotency, the promotion hold beside it, approving it, a design card's merge
 * gate — eject for branch protection: a `failure` disposition (so the card reads red and
 * the promotion holds) whose class is `setting` (so the question comes back).
 */
const REASK = 'BRANCH_PROTECTIONS';

type Captured = 'dequeued-ci-failure' | 'dequeued-manual' | 'dequeued-merge';

function captured(name: Captured): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}

/** A captured `dequeued` body, re-pointed at one of this fixture's pull requests. */
function dequeued(
  from: Captured,
  opts: { number: number; headSha: string; reason?: string | null },
): Record<string, unknown> {
  const body = captured(from);
  const pr = structuredClone(body['pull_request']) as Record<string, unknown>;
  pr['number'] = opts.number;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: opts.headSha };
  return {
    ...body,
    ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    number: opts.number,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID), full_name: 'moooon/acme' },
    pull_request: pr,
  };
}

const eject = (body: Record<string, unknown>, deliveryId: string) =>
  githubWebhookService.handleEvent('pull_request', body, deliveryId);

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'manual' | 'auto' = 'manual') {
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

const ci = (number: number, headSha: string) =>
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

/** ANOTHER check completing green at a commit that already has one — a fresh row, so
 *  the verdict is recomputed (a repeat of the same check is idempotent and would wake
 *  nothing). */
const laterCheck = (number: number, headSha: string, name: string) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      name,
      check_suite: { head_branch: null },
      pull_requests: [{ number }],
    },
  });

async function openLinked(identifier: string, number: number) {
  const headRef = `subtask/${identifier}-${number}`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent('pull_request', {
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
}

async function card(s: Scenario, title: string, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) await openLinked(item.identifier, number);
  return item;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const pr = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
const gates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: KIND },
    orderBy: { createdAt: 'asc' },
  });
const awaitingGates = async (workItemId: string) =>
  (await gates(workItemId)).filter((g) => g.state === 'awaiting');
const exits = async (number: number) =>
  adminDb.githubPullRequestQueueExit.findMany({
    where: { pullRequestId: (await pr(number)).id },
    orderBy: { createdAt: 'asc' },
  });

/** Record that Motir enqueued a pull request — what `recordMotirMerge` writes. */
async function markQueued(number: number) {
  await adminDb.githubPullRequest.update({
    where: { id: (await pr(number)).id },
    data: { mergeAuthority: 'gate', mergeOutcomeRef: `queue:entry-${number}` },
  });
}

/**
 * A `manual` card with pull requests #11 and #12, green at `sha-a` / `sha-b`, APPROVED
 * by a person, and both enqueued — the state a queue ejects from.
 */
async function approvedAndQueued(email: string) {
  const s = await makeScenario(email);
  const item = await card(s, 'Two pull requests', [11, 12]);
  await ci(11, 'sha-a');
  await ci(12, 'sha-b');
  expect(await statusOf(item.id)).toBe('in_review');
  const [gate] = await awaitingGates(item.id);
  await approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, decision: 'approve', source: 'ui' },
    s.ctx,
  );
  expect(await statusOf(item.id)).toBe('approved');
  await markQueued(11);
  await markQueued(12);
  const approved = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
  return { s, item, approved };
}

beforeEach(async () => {
  blobs.clear();
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a FAILURE removal', () => {
  // §4 FIFTH AMENDMENT (MOTIR-6594): a queue FAILURE is CAN'T-LAND. Yue, 2026-09-27:
  // *"when a PR failed in the merge queue, we should not open a new approval gate"*.
  it('in a manual project: one exit row, the queued record cleared, the card HELD at IMPLEMENTED with NO gate, the approval untouched', async () => {
    const { item, approved } = await approvedAndQueued('fail-manual@example.com');
    sent.length = 0;

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }),
      'guid-fail-1',
    );

    expect(result).toMatchObject({
      event: 'pull_request_dequeued',
      outcome: 'recorded',
      disposition: 'failure',
      rawReason: 'CI_FAILURE',
      moved: [item.identifier],
      reasked: [],
      clearedQueuedOutcome: true,
    });
    const [row, ...more] = await exits(11);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      deliveryId: 'guid-fail-1',
      rawReason: 'CI_FAILURE',
      disposition: 'failure',
      headSha: 'sha-a',
      requeuedAt: null,
    });
    expect((await pr(11)).mergeOutcomeRef).toBeNull();
    // The authority is still true: a person asked for this enqueue.
    expect((await pr(11)).mergeAuthority).toBe('gate');
    // The sibling approved at its own head stays in the queue.
    expect((await pr(12)).mergeOutcomeRef).toBe('queue:entry-12');
    // Back to Implemented, where `motir fix` claims it — and NOTHING is asked.
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);

    // The decided gate is a record: byte-for-byte what it was.
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } });
    expect(after).toEqual(approved);

    // One transition event, after commit.
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          workItemId: item.id,
          fromStatusKey: 'approved',
          toStatusKey: 'implemented',
        }),
      }),
    ]);
  });

  it('a CI_FAILURE held at Implemented asks nothing on a green check at the SAME head, and ONE gate once a push goes green', async () => {
    const { item, approved } = await approvedAndQueued('fail-rearm@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }),
      'guid-fail-rearm',
    );

    await laterCheck(11, 'sha-a', 'lint');
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);

    // A push moves the head, the exit stops standing, and the ordinary CI promotion asks
    // ONE fresh question about the NEW commits.
    await ci(11, 'sha-a2');

    expect(await statusOf(item.id)).toBe('in_review');
    const fresh = await awaitingGates(item.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.subjectVersion).toBe('moooon/acme#11@sha-a2,moooon/acme#12@sha-b');
    expect(fresh[0]!.id).not.toBe(approved.id);
  });

  it('in an auto project: the card moves from in_review to implemented, and NO gate is raised (unchanged)', async () => {
    const s = await makeScenario('fail-auto@example.com', 'auto');
    const item = await card(s, 'Auto merged', [21]);
    await ci(21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await gates(item.id)).toEqual([]);
    await markQueued(21);

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 21, headSha: 'sha-auto' }),
      'guid-auto-1',
    );

    expect(result).toMatchObject({ outcome: 'recorded', moved: [item.identifier], reasked: [] });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await gates(item.id)).toEqual([]);
  });

  // ⚠️ BY CLASS, NOT BY DISPOSITION (§4 FOURTH AMENDMENT, point 2; MOTIR-5805). All
  // five are `failure` rows; what differs is what a person can do about them. Since the
  // FIFTH AMENDMENT (MOTIR-6594) every queue failure but a setting is CAN'T-LAND.
  it.each([
    // A timeout with no check named says the checks did not finish, which failed
    // nothing (§4 SIXTH AMENDMENT, MOTIR-6847): re-asked like MANUAL.
    ['CI_TIMEOUT', 'in_review', 1],
    ['INVALID_MERGE_COMMIT', 'implemented', 0],
    ['GIT_TREE_INVALID', 'implemented', 0],
    // A setting somebody can change: the same commits land once it is changed.
    ['BRANCH_PROTECTIONS', 'in_review', 1],
    // CAN'T LAND: the commits cannot combine, so the card is held and NOTHING is asked.
    ['MERGE_CONFLICT', 'implemented', 0],
  ] as const)('%s settles the card at %s with %i gate(s)', async (reason, status, gateCount) => {
    const { item } = await approvedAndQueued(`fail-${reason}@example.com`);
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason }),
      `guid-${reason}`,
    );
    expect(await statusOf(item.id)).toBe(status);
    expect(await awaitingGates(item.id)).toHaveLength(gateCount);
    expect((await exits(11))[0]).toMatchObject({
      rawReason: reason,
      disposition: reason === 'CI_TIMEOUT' ? 'neutral' : 'failure',
    });
  });

  it('a CONFLICT held at Implemented raises nothing on a green check at the SAME head', async () => {
    const { item } = await approvedAndQueued('conflict-hold@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: 'MERGE_CONFLICT' }),
      'guid-conflict-hold',
    );
    expect(await statusOf(item.id)).toBe('implemented');

    await ci(11, 'sha-a');

    expect(await awaitingGates(item.id)).toEqual([]);
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('moves only a card at the enqueued status, and names the rest', async () => {
    const { s, item } = await approvedAndQueued('scope@example.com');
    const other = await card(s, 'Also delivered, still being worked', []);
    // A second delivery row for #11, written directly: the link door would also
    // re-sync the pull request's cards, and this test is about the arm's own scope.
    const row = await pr(11);
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: s.workspace.id,
        workItemId: other.id,
        githubPullRequestId: row.id,
        repoId: row.repoId,
      },
    });
    expect(await statusOf(other.id)).toBe('in_progress');
    expect(await statusOf(item.id)).toBe('approved');

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }),
      'guid-scope',
    );

    expect(result).toMatchObject({
      moved: [item.identifier],
      skipped: [{ key: other.identifier, status: 'in_progress', reason: 'not_enqueued_status' }],
    });
    expect(await statusOf(other.id)).toBe('in_progress');
  });

  it('a MARKED card (a legacy mark on an open card) is skipped `held_by_mark` and moves nowhere — MOTIR-6681', async () => {
    // A card marked under MOTIR-6672 is `done` and never queued; one marked while
    // open before that rule can be, and every move this exit makes leaves the done
    // category. It is recorded and left, and the exit still records normally.
    const { item } = await approvedAndQueued('marked-exit@example.com');
    await adminDb.workItem.update({ where: { id: item.id }, data: { obsolescence: 'outdated' } });

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }),
      'guid-marked',
    );

    expect(result).toMatchObject({
      outcome: 'recorded',
      moved: [],
      skipped: [{ key: item.identifier, status: 'approved', reason: 'held_by_mark' }],
    });
    expect(await statusOf(item.id)).toBe('approved');
    expect(await exits(11)).toHaveLength(1);
  });

  it('Queue again leaves a MARKED card at Implemented rather than failing — MOTIR-6681', async () => {
    const s = await makeScenario('marked-return@example.com');
    const item = await card(s, 'Marked while open', []);
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { status: 'implemented', obsolescence: 'deprecated' },
    });

    const moved = await withWorkspaceContext(s.ctx, (tx) =>
      queueExitCardMoves.returnCard(
        { id: item.id, status: 'implemented' },
        'in_review',
        s.ctx,
        tx,
        {},
      ),
    );

    expect(moved).toBeNull();
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('a pull request that delivers no card records the exit and moves nothing, without error', async () => {
    const s = await makeScenario('unlinked@example.com');
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 31,
        state: 'open',
        merged: false,
        title: 'Nobody linked me',
        head: { ref: 'feature/unlinked' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    void s;

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 31, headSha: 'sha-u' }),
      'guid-unlinked',
    );

    expect(result).toMatchObject({ outcome: 'recorded', moved: [], skipped: [] });
    expect(await exits(31)).toHaveLength(1);
  });
});

describe('NEUTRAL, UNKNOWN and LANDED removals', () => {
  it('a manual removal writes a neutral row, clears the queued record and ASKS AGAIN', async () => {
    const { item } = await approvedAndQueued('manual@example.com');

    const result = await eject(
      dequeued('dequeued-manual', { number: 11, headSha: 'sha-a' }),
      'guid-manual',
    );

    expect(result).toMatchObject({
      outcome: 'recorded',
      disposition: 'neutral',
      moved: [item.identifier],
      reasked: [item.identifier],
    });
    expect((await exits(11))[0]).toMatchObject({ rawReason: 'MANUAL', disposition: 'neutral' });
    expect((await pr(11)).mergeOutcomeRef).toBeNull();
    // ⚠️ A NEUTRAL REMOVAL RE-ASKS TOO (MOTIR-5805; Yue, 2026-09-19). The approval sent
    // the pull request to the queue and it did not land, so the yes has been used.
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingGates(item.id)).toHaveLength(1);
  });

  it('an unrecognised reason is recorded neutral, asks again, and is logged raw once', async () => {
    const { item } = await approvedAndQueued('unknown@example.com');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: 'failed_checks' }),
      'guid-unknown',
    );

    // Unrecognised is `neutral` (it moves nothing on the disposition axis) and
    // RETRYABLE (a person is asked, and can still reach for `motir fix`).
    expect(result).toMatchObject({
      outcome: 'recorded',
      disposition: 'neutral',
      moved: [item.identifier],
    });
    expect(await statusOf(item.id)).toBe('in_review');
    const logged = warn.mock.calls.filter((call) =>
      String(call[0]).includes('unrecognised merge-queue removal reason'),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toMatchObject({ rawReason: 'failed_checks' });
  });

  it('a MERGE removal writes nothing and changes nothing', async () => {
    const { item } = await approvedAndQueued('landed@example.com');

    const result = await eject(
      dequeued('dequeued-merge', { number: 11, headSha: 'sha-a' }),
      'guid-landed',
    );

    expect(result).toMatchObject({ outcome: 'landed', disposition: 'landed' });
    expect(await exits(11)).toEqual([]);
    expect((await pr(11)).mergeOutcomeRef).toBe('queue:entry-11');
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('a delivery with no X-GitHub-Delivery header is refused rather than recorded without a key', async () => {
    await approvedAndQueued('no-guid@example.com');
    const result = await githubWebhookService.handleEvent(
      'pull_request',
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }),
    );
    expect(result).toMatchObject({ outcome: 'malformed' });
    expect(await exits(11)).toEqual([]);
  });
});

describe('IDEMPOTENCY — keyed on the delivery GUID', () => {
  it('the same delivery twice writes one row, and the second answers duplicate', async () => {
    const { item } = await approvedAndQueued('dup@example.com');
    const body = dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK });

    await eject(body, 'guid-same');
    const second = await eject(body, 'guid-same');

    expect(second).toMatchObject({ outcome: 'duplicate' });
    expect(await exits(11)).toHaveLength(1);
    expect(await statusOf(item.id)).toBe('in_review');
    // A redelivered `dequeued` raises no second gate and moves nothing.
    expect(await awaitingGates(item.id)).toHaveLength(1);
  });

  it('two deliveries at the same head and reason are two exits', async () => {
    const { item } = await approvedAndQueued('two@example.com');
    const body = dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK });

    await eject(body, 'guid-first');
    const second = await eject(body, 'guid-second');

    expect(second).toMatchObject({ outcome: 'recorded' });
    expect(await exits(11)).toHaveLength(2);
    // The card is already at `in_review` and already asking: still ONE gate.
    expect(await awaitingGates(item.id)).toHaveLength(1);
  });
});

describe('the PROMOTION HOLD (decision 6) and the re-ask', () => {
  it('after a failure exit, a green check at the SAME head asks nothing twice — still ONE gate, still in_review', async () => {
    const { item } = await approvedAndQueued('hold@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK }),
      'guid-hold',
    );
    const [reasked] = await awaitingGates(item.id);

    const result = await laterCheck(11, 'sha-a', 'lint');
    expect(result).toMatchObject({ event: 'ci', ciState: 'passing' });

    expect(await statusOf(item.id)).toBe('in_review');
    expect((await awaitingGates(item.id)).map((g) => g.id)).toEqual([reasked!.id]);
  });

  it('a card a person moves back to implemented by hand is held there — the latch does not promote it', async () => {
    const { s, item } = await approvedAndQueued('hold-edge2@example.com');
    await eject(dequeued('dequeued-manual', { number: 11, headSha: 'sha-a' }), 'guid-neutral');
    await eject(dequeued('dequeued-ci-failure', { number: 12, headSha: 'sha-b' }), 'guid-fail-12');
    expect(await statusOf(item.id)).toBe('in_review');

    // A person moves it out and back in: the latch (edge 2) must not promote it.
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('a push to a NEW head supersedes the re-asked gate `head moved`, and the next green raises exactly ONE over the new commits', async () => {
    const { item, approved } = await approvedAndQueued('rearm@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK }),
      'guid-rearm',
    );
    const [reasked] = await awaitingGates(item.id);

    await ci(11, 'sha-a2');

    expect(await statusOf(item.id)).toBe('in_review');
    expect(
      await adminDb.approvalGate.findUniqueOrThrow({ where: { id: reasked!.id } }),
    ).toMatchObject({ state: 'superseded', supersededCause: 'head_moved' });
    const fresh = await awaitingGates(item.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.subjectVersion).toBe('moooon/acme#11@sha-a2,moooon/acme#12@sha-b');
    expect(fresh[0]!.id).not.toBe(approved.id);
    expect(fresh[0]!.id).not.toBe(reasked!.id);
  });
});

// ── §4 FOURTH AMENDMENT, point 3 (MOTIR-5805): APPROVING THE RE-ASKED GATE RE-QUEUES ──
describe('approving the re-asked gate', () => {
  const github = getGitProvider('github') as Required<GitProvider>;
  const ciStateOf = async (id: string) =>
    (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).ciState;

  async function ejected(email: string) {
    const out = await approvedAndQueued(email);
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK }),
      `g-${email}`,
    );
    const [reasked] = await awaitingGates(out.item.id);
    return { ...out, reasked: reasked! };
  }

  it('enqueues the ejected member through the merge seam, stamps the exit, lifts the red, and moves the card to approved', async () => {
    const { s, item, reasked } = await ejected('reask-approve@example.com');
    expect(await ciStateOf(item.id)).toBe('failing');
    const host = vi
      .spyOn(github, 'mergeChangeRequest')
      .mockResolvedValue({ outcome: 'enqueued', entryId: 'MQE_again' });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: reasked.id, source: 'ui' },
      s.ctx,
    );

    // #11 left the queue and is re-enqueued; #12 never left and is enqueued as the
    // approval names it — each member of the set is carried out.
    const onEleven = result.members.find((m) => m.subjectVersion.includes('#11@'));
    expect(onEleven).toMatchObject({ outcome: 'enqueued' });
    expect(host.mock.calls.some(([args]) => args.number === 11)).toBe(true);
    expect((await exits(11))[0]!.requeuedAt).not.toBeNull();
    expect((await pr(11)).mergeOutcomeRef).toBe('queue:MQE_again');
    expect(await statusOf(item.id)).toBe('approved');
    expect(await ciStateOf(item.id)).not.toBe('failing');
    expect(
      await adminDb.approvalGate.findUniqueOrThrow({ where: { id: reasked.id } }),
    ).toMatchObject({ state: 'approved' });
  });

  // ⚠️ REWRITTEN FROM THE OPPOSITE RULE (MOTIR-5834; §4 FOURTH AMENDMENT, points 2 and 8).
  // It used to read *the approval stands and the retry re-queues under it*. A host
  // CONFLICT is `cant_land`: the same commits cannot land however many times anyone says
  // yes, so the approval is spent, the card falls back to `implemented`, NOTHING is asked
  // again, and the retry is refused rather than re-queueing on a spent yes.
  it('a CONFLICT the host refuses spends the approval, drops the card to implemented, asks nothing, and refuses the retry', async () => {
    const { s, item, reasked } = await ejected('reask-refused@example.com');
    vi.spyOn(github, 'mergeChangeRequest').mockResolvedValue({
      outcome: 'refused',
      refusal: { code: 'conflict' },
    });

    const result = await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: reasked.id, source: 'ui' },
      s.ctx,
    );

    expect(result.members.find((m) => m.subjectVersion.includes('#11@'))).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_CONFLICT' },
    });
    expect((await exits(11))[0]!.requeuedAt).toBeNull();
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);

    // The refusal stands at this head, so the retry acts on nothing and calls no host.
    vi.restoreAllMocks();
    const host = vi.spyOn(github, 'mergeChangeRequest');
    const retried = await pullRequestMergeService.retryApproveAndMergeMember(
      {
        approvalGateId: reasked.id,
        pullRequestId: (await pr(11)).id,
        noteMd: null,
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );
    expect(retried).toMatchObject({ outcome: 'refused', refusal: { tag: 'MERGE_CONFLICT' } });
    expect(host).not.toHaveBeenCalled();
    expect((await exits(11))[0]!.requeuedAt).toBeNull();
  });

  it('a STALE stamp is refused by the shipped stamp check, and nothing is enqueued', async () => {
    const { s, item, reasked } = await ejected('reask-stale@example.com');
    const host = vi.spyOn(github, 'mergeChangeRequest');

    await expect(
      pullRequestMergeService.approveAndMerge(
        { stamp: 'v1.a-stamp-for-something-else', gateId: reasked.id, source: 'ui' },
        s.ctx,
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_GATE_STALE_SUBJECT' });

    expect(host).not.toHaveBeenCalled();
    expect((await exits(11))[0]!.requeuedAt).toBeNull();
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingGates(item.id)).toEqual([reasked]);
  });
});

describe('NO SECOND GATE over approved commits (guard b)', () => {
  it('a green check on an approved card whose member is still queued raises nothing', async () => {
    const { item } = await approvedAndQueued('queued-green@example.com');

    const result = await laterCheck(12, 'sha-b', 'lint');
    expect(result).toMatchObject({ event: 'ci', ciState: 'passing' });

    expect(await statusOf(item.id)).toBe('approved');
    expect(await awaitingGates(item.id)).toEqual([]);
  });
});

// ── MOTIR-5666: the merge question comes back ALONE, and the design cannot be
// swapped underneath it (`design-result.md` AMENDMENT 6 Q2 and Q3) ───────────────
describe('a DESIGN card the queue ejects', () => {
  /** Publish a design result onto `item`. */
  async function designed(s: Scenario, item: { id: string }) {
    await makeWorkWaitOn(item.id, { projectId: s.project.id, ctx: s.ctx });
    const prefix = designPrefix(s.workspace.id, item.id);
    blobs.set(`${prefix}v1.mock.html`, { contentType: 'text/html', size: 2048 });
    blobs.set(`${prefix}v1.design-notes.md`, { contentType: 'text/markdown', size: 512 });
    return designEvidenceService.recordFromPathnames(
      {
        workItemId: item.id,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/work-items/v1.mock.html',
            pathname: `${prefix}v1.mock.html`,
          },
          {
            kind: 'note_file',
            sourcePath: 'design/work-items/design-notes.md',
            pathname: `${prefix}v1.design-notes.md`,
          },
        ],
        commitSha: shaFor('v1'),
      },
      s.ctx,
    );
  }

  /** Approve the card's design gate through the decide door. */
  async function approveDesign(s: Scenario, item: { id: string }) {
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: item.id, kind: 'design_result' },
    });
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
      s.ctx,
    );
    return { gate: await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } }) };
  }

  /**
   * `approvedAndQueued`, with a published and APPROVED design on the card.
   *
   * ⚠️ THE ORDER IS GREEN FIRST, THEN BOTH DECISIONS. A design approved BEFORE the
   * set goes green is held and carried by `settleGreenVerdict` (AMENDMENT 6 Q4), so
   * no merge gate is ever raised and there is nothing to enqueue from — a true
   * behaviour, and a different scenario from the one this block is about. Deciding
   * each gate through the DOOR rather than through `approveAndMerge` keeps the host
   * out of it: what is under test is the ejection, not the merge.
   */
  async function designedAndQueued(email: string) {
    const s = await makeScenario(email);
    const item = await card(s, 'A design that ships as code', [11, 12]);
    await designed(s, item);
    await ci(11, 'sha-a');
    await ci(12, 'sha-b');
    const design = await approveDesign(s, item);
    const [merge] = await awaitingGates(item.id);
    await approvalGatesService.decide(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: merge!.id, decision: 'approve', source: 'ui' },
      s.ctx,
    );
    await markQueued(11);
    await markQueued(12);
    return { s, item, design };
  }

  it('leaves the DESIGN gate decided and re-asks ONLY the merge — one awaiting merge gate, standing alone', async () => {
    const { item, design } = await designedAndQueued('mq-design-eject@example.com');

    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK }),
      'guid-d1',
    );

    // §4 FOURTH AMENDMENT, point 2: the MERGE question is asked again, alone.
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingGates(item.id)).toHaveLength(1);
    expect(
      await adminDb.approvalGate.count({
        where: { workItemId: item.id, kind: 'design_result', state: 'awaiting' },
      }),
    ).toBe(0);

    // And the design decision is exactly as it was. Nobody is asked a second time
    // whether the design is right, because nothing about the design changed.
    const after = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: design.gate.id } });
    expect(after).toMatchObject({ state: 'approved', supersededCause: null });
    expect(after.decidedAt?.toISOString()).toBe(design.gate.decidedAt?.toISOString());
    expect(
      await adminDb.approvalGate.count({ where: { workItemId: item.id, kind: 'design_result' } }),
    ).toBe(1);
  });

  it('REFUSES a republish and a withdrawal after the ejection — the failure is about the COMMITS', async () => {
    // The shape MOTIR-5661 was written for, driven end to end here rather than in
    // its unit context: the queue ejects, an agent comes back to the card, and
    // re-publishing the asset is a reasonable-looking thing for it to do. It would
    // turn a commits problem into a shipped design nobody approved.
    const { s, item } = await designedAndQueued('mq-design-republish@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK }),
      'guid-d2',
    );
    expect(await statusOf(item.id)).toBe('in_review');

    const prefix = designPrefix(s.workspace.id, item.id);
    blobs.set(`${prefix}v2.mock.html`, { contentType: 'text/html', size: 2048 });
    blobs.set(`${prefix}v2.design-notes.md`, { contentType: 'text/markdown', size: 512 });
    await expect(
      designEvidenceService.recordFromPathnames(
        {
          workItemId: item.id,
          assets: [
            {
              kind: 'mock',
              sourcePath: 'design/work-items/v2.mock.html',
              pathname: `${prefix}v2.mock.html`,
            },
            {
              kind: 'note_file',
              sourcePath: 'design/work-items/design-notes.md',
              pathname: `${prefix}v2.design-notes.md`,
            },
          ],
          commitSha: shaFor('v2'),
        },
        s.ctx,
      ),
    ).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });

    await expect(
      designEvidenceService.withdrawCurrentForWorkItem({ workItemId: item.id }, s.ctx),
    ).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });

    await expect(
      designEvidenceService.createUploadTokens(
        {
          workItemId: item.id,
          files: [
            {
              kind: 'mock',
              sourcePath: 'design/work-items/v2.mock.html',
              contentType: 'text/html',
            },
          ],
        },
        s.ctx,
      ),
    ).rejects.toMatchObject({ code: 'DESIGN_CARD_CLOSED' });
  });

  it('a PUSH after the ejection re-arms the merge question and leaves the design alone', async () => {
    const { item, design } = await designedAndQueued('mq-design-push@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK }),
      'guid-d3',
    );

    await ci(11, 'sha-a2');

    // A new head is a new question — exactly ONE fresh merge gate over it.
    const fresh = await awaitingGates(item.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.subjectVersion).toBe('moooon/acme#11@sha-a2,moooon/acme#12@sha-b');
    // …and the design gate is untouched by a push, as by an ejection.
    expect(
      await adminDb.approvalGate.findUniqueOrThrow({ where: { id: design.gate.id } }),
    ).toMatchObject({ state: 'approved', supersededCause: null });
  });
});

// ── THE CARD'S BADGE COUNTS THE EXIT (Story MOTIR-5628 · MOTIR-5717) ─────────────
//
// The pull request's OWN checks stay green through an ejection — the queue failed on
// its merge group — so the card's `ciState`, folded from those checks alone, read
// `passing` on a card the promotion refuses. The fold now reads the same
// `queueExitHoldsAtHead` rule the hold does, and the exit write recomputes it.

describe('an ejected card reads RED (MOTIR-5717)', () => {
  const ciStateOf = async (id: string) =>
    (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).ciState;
  const ownVerdict = async (number: number) =>
    derivePrCiState(
      await adminDb.githubCheckRun.findMany({ where: { pullRequestId: (await pr(number)).id } }),
    );
  /** A PENDING check at a new commit — the shipped pending arm, as a push produces. */
  const pending = (number: number, headSha: string) =>
    githubWebhookService.handleEvent('check_run', {
      action: 'created',
      installation: INSTALLATION,
      repository: { id: Number(REPO_PROVIDER_ID) },
      check_run: {
        head_sha: headSha,
        status: 'in_progress',
        conclusion: null,
        name: 'build',
        check_suite: { head_branch: null },
        pull_requests: [{ number }],
      },
    });

  it('a failure exit makes the card failing while the pull request’s own verdict stays passing', async () => {
    const { item } = await approvedAndQueued('red-fail@example.com');
    expect(await ciStateOf(item.id)).toBe('passing');

    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'guid-red-1');

    expect(await ciStateOf(item.id)).toBe('failing');
    // Guard (a): the pull request's own verdict — the pill, the promotion's green
    // test — is NOT touched by the queue.
    expect(await ownVerdict(11)).toBe('passing');
  });

  it('a card skipped as not_enqueued_status turns red too', async () => {
    const { s, item } = await approvedAndQueued('red-skipped@example.com');
    const other = await card(s, 'Also delivered, still being worked', []);
    const row = await pr(11);
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: s.workspace.id,
        workItemId: other.id,
        githubPullRequestId: row.id,
        repoId: row.repoId,
      },
    });

    const result = await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }),
      'guid-red-2',
    );

    expect(result).toMatchObject({
      skipped: [{ key: other.identifier, reason: 'not_enqueued_status' }],
    });
    expect(await statusOf(other.id)).toBe('in_progress');
    expect(await ciStateOf(other.id)).toBe('failing');
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('a neutral exit leaves the card at its own verdict', async () => {
    const { item } = await approvedAndQueued('red-neutral@example.com');
    await eject(dequeued('dequeued-manual', { number: 11, headSha: 'sha-a' }), 'guid-red-neutral');
    expect((await exits(11))[0]).toMatchObject({ disposition: 'neutral' });
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a failure exit recorded at an OLD head contributes the member’s own verdict', async () => {
    const { item } = await approvedAndQueued('red-old-head@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-before' }),
      'guid-red-old',
    );
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a pending check at a NEW head moves the card from failing to running', async () => {
    const { item } = await approvedAndQueued('red-push@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'guid-red-3');
    expect(await ciStateOf(item.id)).toBe('failing');

    await pending(11, 'sha-a2');

    // The exit names `sha-a`; the head is now `sha-a2`, so the hold has lifted and
    // the member reads its own (pending) verdict.
    expect(await ciStateOf(item.id)).toBe('running');
  });

  it('a further green check at the SAME head keeps the card red and moves nothing', async () => {
    const { item } = await approvedAndQueued('red-same-head@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK }),
      'guid-red-4',
    );

    await laterCheck(11, 'sha-a', 'lint');

    expect(await statusOf(item.id)).toBe('in_review');
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('the backfill dry run predicts what the apply writes for an ejected card', async () => {
    const { item } = await approvedAndQueued('red-backfill@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'guid-red-5');
    // A card ejected BEFORE this change shipped: its stored verdict is still green.
    await adminDb.workItem.update({ where: { id: item.id }, data: { ciState: 'passing' } });

    const rehearsal = await workItemCiStateBackfillService.backfillCiState({ dryRun: true });
    expect(rehearsal.changed).toEqual([
      { workItemId: item.id, identifier: item.identifier, from: 'passing', to: 'failing' },
    ]);
    expect(await ciStateOf(item.id)).toBe('passing');

    const real = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(real.changed).toEqual(rehearsal.changed);
    expect(await ciStateOf(item.id)).toBe('failing');
  });
});

// ── THE DELIVERIES THAT REACH NO CARD (MOTIR-5805) ──────────────────────────────
//
// `recordExit` is the ONE entry point every un-landed queue outcome goes through, so its
// refusals are load-bearing in a way a webhook handler's usually are not: each one names
// a different missing row, and a delivery that cannot be tied to a card must say WHICH
// link is missing rather than failing anonymously. Driven directly, because a signed
// delivery cannot carry an installation the tenant has never heard of.
describe('a removal that reaches no card says which link is missing', () => {
  const exitFor = (over: Partial<NormalizedMergeQueueExit> = {}): NormalizedMergeQueueExit => ({
    providerRepoId: REPO_PROVIDER_ID,
    number: 11,
    headSha: 'sha-a',
    rawReason: 'CI_FAILURE',
    ...over,
  });

  it('with no delivery id it is MALFORMED — never recorded without an idempotency key', async () => {
    const result = await mergeQueueExitService.recordExit({
      installationId: INSTALLATION_ID,
      exit: exitFor(),
      deliveryId: null,
    });
    expect(result).toMatchObject({ outcome: 'malformed', disposition: 'failure' });
  });

  it('with no installation id at all, and with one nobody has installed', async () => {
    for (const installationId of [null, 'inst-nobody-installed']) {
      const result = await mergeQueueExitService.recordExit({
        installationId,
        exit: exitFor(),
        deliveryId: `guid-unknown-inst-${installationId ?? 'null'}`,
      });
      expect(result, `installationId=${installationId}`).toMatchObject({
        outcome: 'unknown_installation',
      });
    }
  });

  it('a repository the installation does not carry is UNKNOWN REPO, not an unknown card', async () => {
    await makeScenario('exit-unknown-repo@example.com');
    const result = await mergeQueueExitService.recordExit({
      installationId: INSTALLATION_ID,
      exit: exitFor({ providerRepoId: '424242' }),
      deliveryId: 'guid-unknown-repo',
    });
    expect(result).toMatchObject({ outcome: 'unknown_repo' });
  });

  it('a pull request Motir has never mirrored is UNKNOWN PULL REQUEST', async () => {
    await makeScenario('exit-unknown-pr@example.com');
    const result = await mergeQueueExitService.recordExit({
      installationId: INSTALLATION_ID,
      exit: exitFor({ number: 9999 }),
      deliveryId: 'guid-unknown-pr',
    });
    expect(result).toMatchObject({ outcome: 'unknown_pull_request' });
  });
});

describe('a CAN’T-LAND exit is never re-queued, whatever anyone approved', () => {
  it('a conflict that PRE-DATES the approval still refuses — the class decides, not the clock', async () => {
    const { s, item, approved } = await approvedAndQueued('cantland-predates@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: 'MERGE_CONFLICT' }),
      'guid-cantland-predates',
    );
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);

    // ⚠️ TWO RULES MEET HERE, AND ONLY ONE OF THEM IS ABOUT TIME. *No exit is re-queued on
    // an approval given before it* (point 1) would let this one through, because the exit
    // is backdated to before the approval — so what refuses it is the CLASS (point 2): the
    // same commits cannot land however many times anyone says yes. Backdated rather than
    // staged, because the order is the whole point and a second approval would change it.
    await adminDb.githubPullRequestQueueExit.updateMany({
      where: { pullRequestId: (await pr(11)).id },
      data: { exitedAt: new Date(approved.decidedAt!.getTime() - 60_000) },
    });
    const host = vi.spyOn(getGitProvider('github') as Required<GitProvider>, 'mergeChangeRequest');

    const outcome = await pullRequestMergeService.retryApproveAndMergeMember(
      {
        approvalGateId: approved.id,
        pullRequestId: (await pr(11)).id,
        noteMd: null,
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );

    expect(outcome).toMatchObject({ outcome: 'refused', refusal: { tag: 'MERGE_CONFLICT' } });
    expect(host).not.toHaveBeenCalled();
    expect((await exits(11))[0]!.requeuedAt).toBeNull();
  });
});

// A RE-QUEUE MADE OUTSIDE MOTIR (MOTIR-6903; §4 SEVENTH AMENDMENT). GitHub sends
// `enqueued` for every enqueue, so a pull request put back by *Merge when ready*,
// `gh pr merge --auto` or another integration answers the exit still standing at its
// head: the red, the hold and the repair claim lift. No status moves and no gate is
// decided — the merge moves the card. The body is the captured `dequeued` delivery
// with its action swapped, which is the shape GitHub gives the pair.
describe('a re-queue made on GitHub (MOTIR-6903)', () => {
  const github = getGitProvider('github') as Required<GitProvider>;
  const cardOf = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });

  function enqueued(opts: { number: number; headSha: string }): Record<string, unknown> {
    const body = dequeued('dequeued-ci-failure', opts);
    delete body['reason'];
    return { ...body, action: 'enqueued' };
  }
  const requeue = (opts: { number: number; headSha: string }) =>
    githubWebhookService.handleEvent('pull_request', enqueued(opts), 'guid-enqueued');

  it('a CI_FAILURE held at Implemented: the exit is stamped, the red and the fix reason lift, and the card stays put with nothing asked', async () => {
    const { item, approved } = await approvedAndQueued('gh-requeue-fail@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'g-fail');
    expect(await cardOf(item.id)).toMatchObject({
      status: 'implemented',
      ciState: 'failing',
      fixReason: expect.anything(),
    });
    sent.length = 0;

    const result = await requeue({ number: 11, headSha: 'sha-a' });

    expect(result).toEqual({ event: 'pull_request_enqueued', outcome: 'requeued' });
    expect((await exits(11))[0]!.requeuedAt).not.toBeNull();
    const after = await cardOf(item.id);
    expect(after.ciState).not.toBe('failing');
    expect(after.fixReason).toBeNull();
    // ⚠️ NOTHING ELSE: no move, no question, the decided gate a record as it was.
    expect(after.status).toBe('implemented');
    expect(await awaitingGates(item.id)).toEqual([]);
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
      approved,
    );
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
    // Motir's merge record stays Motir's: a GitHub-side enqueue does not write it.
    expect((await pr(11)).mergeOutcomeRef).toBeNull();
  });

  it('a NEUTRAL removal re-asked at In Review: the exit is stamped and the re-asked gate stays awaiting, undecided', async () => {
    const { item } = await approvedAndQueued('gh-requeue-neutral@example.com');
    await eject(dequeued('dequeued-manual', { number: 11, headSha: 'sha-a' }), 'g-manual');
    const [reasked] = await awaitingGates(item.id);
    expect(reasked).toBeDefined();

    expect(await requeue({ number: 11, headSha: 'sha-a' })).toMatchObject({
      outcome: 'requeued',
    });

    expect((await exits(11))[0]!.requeuedAt).not.toBeNull();
    expect(await statusOf(item.id)).toBe('in_review');
    expect(await awaitingGates(item.id)).toEqual([reasked]);
  });

  it('an enqueue at a head the exit does not name changes nothing', async () => {
    const { item } = await approvedAndQueued('gh-requeue-other-head@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'g-head');

    expect(await requeue({ number: 11, headSha: 'sha-a2' })).toMatchObject({
      outcome: 'no_standing_exit',
    });
    expect((await exits(11))[0]!.requeuedAt).toBeNull();
    expect(await cardOf(item.id)).toMatchObject({ status: 'implemented', ciState: 'failing' });
  });

  it('a redelivered enqueue changes nothing twice', async () => {
    await approvedAndQueued('gh-requeue-twice@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'g-twice');
    await requeue({ number: 11, headSha: 'sha-a' });
    const [stamped] = await exits(11);

    expect(await requeue({ number: 11, headSha: 'sha-a' })).toMatchObject({
      outcome: 'no_standing_exit',
    });
    const [again, ...more] = await exits(11);
    expect(more).toEqual([]);
    expect(again!.requeuedAt).toEqual(stamped!.requeuedAt);
  });

  it('Motir’s own first enqueue has no exit to answer', async () => {
    await approvedAndQueued('gh-requeue-first@example.com');
    expect(await requeue({ number: 11, headSha: 'sha-a' })).toMatchObject({
      outcome: 'no_standing_exit',
    });
    expect(await exits(11)).toEqual([]);
  });

  it('the enqueue that follows a Queue-again press finds the exit already claimed — ONE stamp, ONE host enqueue', async () => {
    const { s, item } = await approvedAndQueued('gh-requeue-after-press@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK }),
      'g-press-first',
    );
    const [reasked] = await awaitingGates(item.id);
    const host = vi
      .spyOn(github, 'mergeChangeRequest')
      .mockResolvedValue({ outcome: 'enqueued', entryId: 'MQE_press' });
    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: reasked!.id, source: 'ui' },
      s.ctx,
    );
    const [pressed] = await exits(11);
    expect(pressed!.requeuedAt).not.toBeNull();

    expect(await requeue({ number: 11, headSha: 'sha-a' })).toMatchObject({
      outcome: 'no_standing_exit',
    });
    expect((await exits(11))[0]!.requeuedAt).toEqual(pressed!.requeuedAt);
    expect(host.mock.calls.filter(([args]) => args.number === 11)).toHaveLength(1);
  });

  it('a press after the GitHub re-queue claims nothing again — the exit keeps the webhook’s stamp and the host is asked once', async () => {
    const { s, item } = await approvedAndQueued('gh-requeue-then-press@example.com');
    await eject(
      dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a', reason: REASK }),
      'g-webhook-first',
    );
    const [reasked] = await awaitingGates(item.id);
    await requeue({ number: 11, headSha: 'sha-a' });
    const [stamped] = await exits(11);
    // GitHub answers an enqueue of a queued pull request with its existing entry.
    const host = vi
      .spyOn(github, 'mergeChangeRequest')
      .mockResolvedValue({ outcome: 'enqueued', entryId: 'MQE_existing' });

    await pullRequestMergeService.approveAndMerge(
      { stamp: DECIDED_WITHOUT_A_READER, gateId: reasked!.id, source: 'ui' },
      s.ctx,
    );

    expect((await exits(11))[0]!.requeuedAt).toEqual(stamped!.requeuedAt);
    expect(host.mock.calls.filter(([args]) => args.number === 11)).toHaveLength(1);
  });

  it('a body with no head is malformed, and a pull request Motir never mirrored is unknown', async () => {
    await approvedAndQueued('gh-requeue-malformed@example.com');
    const body = enqueued({ number: 11, headSha: 'sha-a' });
    body['pull_request'] = { number: 11, head: {} };
    expect(await githubWebhookService.handleEvent('pull_request', body, 'g-bad')).toEqual({
      event: 'pull_request',
      outcome: 'malformed',
    });
    expect(await requeue({ number: 404, headSha: 'sha-a' })).toMatchObject({
      outcome: 'unknown_pull_request',
    });
  });
  it('reaches no pull request without a known installation and repository', async () => {
    await makeScenario('gh-requeue-unknown@example.com');
    const entry = { providerRepoId: REPO_PROVIDER_ID, number: 11, headSha: 'sha-a' };
    for (const installationId of [null, 'inst-nobody-installed']) {
      expect(await mergeQueueExitService.recordEntry({ installationId, entry })).toEqual({
        event: 'pull_request_enqueued',
        outcome: 'unknown_installation',
      });
    }
    expect(
      await mergeQueueExitService.recordEntry({
        installationId: INSTALLATION_ID,
        entry: { ...entry, providerRepoId: '424242' },
      }),
    ).toMatchObject({ outcome: 'unknown_repo' });
  });

  it('a claim a racing press won first answers no_standing_exit and recomputes nothing', async () => {
    const { item } = await approvedAndQueued('gh-requeue-lost-claim@example.com');
    await eject(dequeued('dequeued-ci-failure', { number: 11, headSha: 'sha-a' }), 'g-lost');
    // The press stamps between this delivery's unlocked read and its claim.
    const { githubPullRequestQueueExitRepository } =
      await import('@/lib/repositories/githubPullRequestQueueExitRepository');
    vi.spyOn(githubPullRequestQueueExitRepository, 'claimRequeue').mockResolvedValueOnce(0);

    const now = new Date('2026-09-29T09:28:07Z');
    expect(
      await mergeQueueExitService.recordEntry({
        installationId: INSTALLATION_ID,
        entry: { providerRepoId: REPO_PROVIDER_ID, number: 11, headSha: 'sha-a' },
        now,
      }),
    ).toMatchObject({ outcome: 'no_standing_exit' });
    expect(await cardOf(item.id)).toMatchObject({ ciState: 'failing' });

    // Unmocked, the same call stamps the time it was given.
    await mergeQueueExitService.recordEntry({
      installationId: INSTALLATION_ID,
      entry: { providerRepoId: REPO_PROVIDER_ID, number: 11, headSha: 'sha-a' },
      now,
    });
    expect((await exits(11))[0]!.requeuedAt).toEqual(now);
  });
});
