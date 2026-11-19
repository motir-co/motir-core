import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { refreshFeedbackComments } from '@/lib/services/ciFeedbackComments';
import {
  recomputeCardCiAnswers,
  settleLostCheckCompletions,
  shaToSettle,
} from '@/lib/services/lostCheckCompletionService';
import { STALE_PENDING_MS } from '@/lib/services/checkSetReconcile';
import {
  PULL_REQUEST_RECONCILE_QUIET_MINUTES,
  pullRequestReconcileService,
} from '@/lib/services/pullRequestReconcileService';
import { mintInstallationToken } from '@/lib/github/appAuth';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import type { ReportedCheckRun } from '@/lib/github/checkRuns';
import {
  changesRequestedOf,
  REVIEW_AGENT_REVIEWER_NAME,
  withRaisedHeads,
} from '@/lib/workItems/fixReason';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Bug MOTIR-11638 — A LOST CHECK COMPLETION ON A CARD ALREADY IN REVIEW KEPT CI AT
// `running` AND THE CARD ON TO FIX AS FIXING FOR EVER.
//
// Observed on production, 2026-11-17 (UTC): the review agent sent MOTIR-11585 back at
// 03:52 on head `4f119995`, so its fix reason was `changes_requested` raised on that head.
// The fix `2cb7524b` was pushed at ~03:57 while the card stayed In Review. On GitHub every
// check at `2cb7524b` completed green by 04:28; in Motir the row for `Coverage (run overlay
// parity)` was still `pending`, written once at 03:58:31 and never again. So `ciState` read
// `running`, the CI comment read "75 of 76 checks complete", and `fixReasonService` held
// the prior reason as Fixing at the moved head — the card sat on To fix with the Fixing tag
// after the review agent's own pass.
//
// The MOTIR-5838 re-read that repairs exactly this shape ran only for a card at
// `implemented` (`ciPromotion.reconcileClaimedCompleteDeliveries`'s first step). This file
// drives the real `*/5` reconcile pass over real Postgres with the card In Review, stubbing
// only what sits ABOVE the code under test: `fetch` (the GitHub REST reads) and the
// installation-token mint (a real one needs an App private key).

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-11638';
const REPO_PROVIDER_ID = '11638';
const REPO = 'motir-core';
const PR_NUMBER = 4306;
const CHECK_SUITE_ID = 119147852729;
/** The head the review agent refused. */
const REVIEWED_SHA = '4f1199950000000000000000000000000000000a';
/** The fix pushed after the send-back — the head CI ran on. */
const FIX_SHA = '2cb7524b0000000000000000000000000000000b';
const SETTLED_LANE = 'TypeScript build';
const LOST_LANE = 'Coverage (run overlay parity)';

/** Past the reconcile's quiet threshold, so a row written "now" is a candidate. */
const LATER = () => new Date(Date.now() + (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000);
/** When the stranded rows were written — an hour back, well past the stale threshold. */
const AN_HOUR_AGO = () => new Date(Date.now() - 60 * 60_000);

/** What GitHub says each commit's check runs are, as the REST triple. */
let hostChecks: Map<string, [name: string, status: string, conclusion: string | null][]>;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  fetchMock = vi.fn(async (url: string) => {
    const files = /\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files/.exec(url);
    if (files)
      return new Response(JSON.stringify([{ filename: 'lib/changed.ts' }]), { status: 200 });
    const checks = /\/repos\/[^/]+\/([^/]+)\/commits\/([0-9a-f]+)\/check-runs/.exec(url);
    if (checks) {
      const runs = hostChecks.get(checks[2]!) ?? [];
      return new Response(
        JSON.stringify({
          total_count: runs.length,
          check_runs: runs.map(([name, status, conclusion]) => ({
            name,
            status,
            conclusion,
            check_suite: { id: CHECK_SUITE_ID },
          })),
        }),
        { status: 200 },
      );
    }
    const one = /\/repos\/[^/]+\/([^/]+)\/pulls\/(\d+)$/.exec(url);
    if (one && Number(one[2]) === PR_NUMBER) {
      return new Response(JSON.stringify(prPayload('open', FIX_SHA)), { status: 200 });
    }
    // Anything else (the Actions workflow-run read among them) is unanswered, which the
    // readers take as "no answer" — the check runs alone are then the host's set.
    return new Response('not stubbed', { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const checkRunReads = () =>
  fetchMock.mock.calls.filter(([url]) => /\/check-runs/.test(String(url))).length;

function prPayload(state: 'open' | 'closed', headSha: string) {
  return {
    number: PR_NUMBER,
    state,
    merged: false,
    merged_at: null,
    draft: false,
    title: 'Board group-by',
    head: { ref: 'subtask/ACME-1-group-by', sha: headSha },
    base: { ref: 'main' },
    user: { id: 4242 },
    mergeable: true,
    mergeable_state: 'clean',
  };
}

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
        name: REPO,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function prRow() {
  return adminDb.githubPullRequest.findFirstOrThrow({ where: { number: PR_NUMBER } });
}

/** A card with its own open, linked pull request at the REVIEWED head, at `implemented`. */
async function linkedCard(s: Scenario) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Board group-by gains reporter' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = 'subtask/ACME-1-group-by';
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: prPayload('open', REVIEWED_SHA),
  });
  await githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId: item.id,
      projectId: s.project.id,
      owner: 'moooon',
      name: REPO,
      number: PR_NUMBER,
      headRef,
      baseRef: 'main',
      title: null,
    },
    s.ctx,
  );
  if ((await cardRow(item.id)).status !== 'implemented') {
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
  }
  return item;
}

async function cardRow(id: string) {
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

/**
 * THE STRANDED STATE, built the way production reached it: the card In Review, sent back by
 * the review agent on the reviewed head, then a fix pushed — the pull request's head moved
 * to `FIX_SHA` — whose CI recorded one lane `success` and one `pending` whose completion
 * never arrived. The cards' answers are then recomputed exactly as that pending delivery
 * recomputed them, so `ciState` and the fix reason are the ones the Workbench showed.
 */
async function strandedInReview(s: Scenario, opts: { pendingWrittenAt: Date }) {
  const card = await linkedCard(s);
  await workItemsService.updateStatus(card.id, 'in_review', s.ctx);
  const pr = await prRow();
  // The review agent's send-back: `changes_requested`, raised on the reviewed head.
  const sentBack = withRaisedHeads(
    changesRequestedOf(
      {
        gate: 'agent_review',
        reviewerName: REVIEW_AGENT_REVIEWER_NAME,
        noteMd: 'Cover the new group-by fields.',
      },
      1,
    ),
    { [pr.id]: REVIEWED_SHA },
  );
  await adminDb.workItem.update({
    where: { id: card.id },
    data: { fixReason: sentBack.fixReason, fixDetail: sentBack.fixDetail as object },
  });
  // The fix is pushed: the pull request's head moves.
  await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: FIX_SHA } });
  await adminDb.githubCheckRun.createMany({
    data: [
      [SETTLED_LANE, 'success'],
      [LOST_LANE, 'pending'],
    ].map(([checkName, conclusion]) => ({
      pullRequestId: pr.id,
      commitSha: FIX_SHA,
      checkName: checkName!,
      checkSuiteId: String(CHECK_SUITE_ID),
      conclusion: conclusion!,
    })),
  });
  // `updatedAt` is `@updatedAt`, so a create stamps it now(); back-date it explicitly.
  await adminDb.githubCheckRun.updateMany({
    where: { pullRequestId: pr.id, commitSha: FIX_SHA },
    data: { createdAt: opts.pendingWrittenAt, updatedAt: opts.pendingWrittenAt },
  });
  await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, s.workspace.id);
    await recomputeCardCiAnswers([card.id], tx);
  });
  // The interim comment the settled lane's delivery rendered: "1 of 2 checks complete".
  await refreshFeedbackComments({
    pullRequestId: pr.id,
    commitSha: FIX_SHA,
    workspaceId: s.workspace.id,
  });
  // Quiet past the reconcile threshold, so the pass reaches the pull request.
  await adminDb.githubPullRequest.update({
    where: { id: pr.id },
    data: { updatedAt: AN_HOUR_AGO() },
  });
  fetchMock.mockClear();
  return { card, pr };
}

async function feedbackCommentBody(workItemId: string): Promise<string> {
  const pr = await prRow();
  const row = await adminDb.githubCiFeedbackComment.findFirstOrThrow({
    where: { pullRequestId: pr.id, commitSha: FIX_SHA, workItemId },
  });
  return (await adminDb.comment.findUniqueOrThrow({ where: { id: row.commentId } })).bodyMd;
}

async function conclusionOf(checkName: string): Promise<string> {
  const pr = await prRow();
  return (
    await adminDb.githubCheckRun.findFirstOrThrow({
      where: { pullRequestId: pr.id, commitSha: FIX_SHA, checkName },
    })
  ).conclusion;
}

const fixDetailOf = (row: { fixDetail: unknown }) =>
  row.fixDetail as { fixing: boolean; raisedHeads: Record<string, string> | null } | null;

beforeEach(async () => {
  await truncateAuthTables();
  hostChecks = new Map();
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(mintInstallationToken).mockClear();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('MOTIR-11638 — a lost completion on a card already In Review is settled by the reconcile', () => {
  it('REPRODUCTION — the row settles, CI reads passing, the card leaves To fix and the comment is re-rendered', async () => {
    const s = await makeScenario('in-review-green@example.com');
    const { card } = await strandedInReview(s, { pendingWrittenAt: AN_HOUR_AGO() });

    // The state as observed on MOTIR-11585: CI running, Fixing on To fix, "1 of 2".
    const before = await cardRow(card.id);
    expect(before.status).toBe('in_review');
    expect(before.ciState).toBe('running');
    expect(before.fixReason).toBe('changes_requested');
    expect(fixDetailOf(before)?.fixing).toBe(true);
    expect(await feedbackCommentBody(card.id)).toContain('1 of 2 checks complete');

    hostChecks.set(FIX_SHA, [
      [SETTLED_LANE, 'completed', 'success'],
      [LOST_LANE, 'completed', 'success'],
    ]);
    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, checkSetsSettled: 1, promoted: 0, failed: 0 });
    expect(await conclusionOf(LOST_LANE)).toBe('success');
    const after = await cardRow(card.id);
    // CI reflects the host's verdict, and the card is no longer on To fix.
    expect(after.ciState).toBe('passing');
    expect(after.fixReason).toBeNull();
    // The comment is re-rendered at the head — no longer "1 of 2".
    const body = await feedbackCommentBody(card.id);
    expect(body).toContain('CI passing');
    expect(body).not.toContain('checks complete');
    // Not a promotion: the card was already In Review and stays there, and the green set
    // now owes it the approve-to-merge question the send-back's push withdrew.
    expect(after.status).toBe('in_review');
    const gates = await adminDb.approvalGate.findMany({
      where: { workItemId: card.id, kind: 'pull_request_approval', state: 'awaiting' },
    });
    expect(gates).toHaveLength(1);
  });

  it('a lost RED completion raises a fresh reason on the new head instead of holding the old one as Fixing', async () => {
    const s = await makeScenario('in-review-red@example.com');
    const { card, pr } = await strandedInReview(s, { pendingWrittenAt: AN_HOUR_AGO() });

    hostChecks.set(FIX_SHA, [
      [SETTLED_LANE, 'completed', 'success'],
      [LOST_LANE, 'completed', 'failure'],
    ]);
    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ checkSetsSettled: 1, promoted: 0 });
    expect(await conclusionOf(LOST_LANE)).toBe('failure');
    const after = await cardRow(card.id);
    expect(after.ciState).toBe('failing');
    expect(after.fixReason).toBe('ci_failed');
    expect(fixDetailOf(after)).toMatchObject({ fixing: false, raisedHeads: { [pr.id]: FIX_SHA } });
    // The red build is the CAN'T-LAND class: a card a person was being asked about goes
    // back to Implemented, exactly as the lost delivery would have moved it (MOTIR-6271).
    expect(after.status).toBe('implemented');
    const body = await feedbackCommentBody(card.id);
    expect(body).toContain('CI failed');
    expect(body).not.toContain('checks complete');
  });

  it('a FRESH pending row on an In Review card costs no host call and moves nothing', async () => {
    const s = await makeScenario('in-review-fresh@example.com');
    // Written moments before the pass's clock: younger than the stale threshold.
    const passAt = LATER();
    const { card } = await strandedInReview(s, {
      pendingWrittenAt: new Date(passAt.getTime() - 60_000),
    });
    hostChecks.set(FIX_SHA, [
      [SETTLED_LANE, 'completed', 'success'],
      [LOST_LANE, 'completed', 'success'],
    ]);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: passAt });

    expect(summary).toMatchObject({ stillOpen: 1, checkSetsSettled: 0 });
    expect(checkRunReads()).toBe(0);
    expect(await conclusionOf(LOST_LANE)).toBe('pending');
    const after = await cardRow(card.id);
    expect(after.ciState).toBe('running');
    expect(fixDetailOf(after)?.fixing).toBe(true);
  });

  it('the host still reporting the lane RUNNING settles nothing and recomputes nothing', async () => {
    const s = await makeScenario('in-review-running@example.com');
    const { card } = await strandedInReview(s, { pendingWrittenAt: AN_HOUR_AGO() });
    hostChecks.set(FIX_SHA, [
      [SETTLED_LANE, 'completed', 'success'],
      [LOST_LANE, 'in_progress', null],
    ]);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ checkSetsSettled: 0 });
    expect(checkRunReads()).toBeGreaterThan(0);
    expect(await conclusionOf(LOST_LANE)).toBe('pending');
    expect((await cardRow(card.id)).ciState).toBe('running');
  });
});

describe('MOTIR-11638 — what the status-independent re-read costs', () => {
  const ROW_AT = new Date('2026-11-17T03:58:31.000Z');
  const rows = (conclusions: string[]) =>
    conclusions.map((conclusion, i) => ({
      commitSha: FIX_SHA,
      checkName: `lane ${i}`,
      checkSuiteId: String(CHECK_SUITE_ID),
      conclusion,
      conclusionAt: null,
      createdAt: ROW_AT,
      updatedAt: ROW_AT,
    }));
  const STALE = new Date(ROW_AT.getTime() + STALE_PENDING_MS);
  const FRESH = new Date(ROW_AT.getTime() + STALE_PENDING_MS - 1);

  it('names the head for a stale pending row, and nothing while it is fresh', () => {
    const pending = rows(['success', 'pending']);
    expect(shaToSettle({ checkRuns: pending, ciDecidedSha: null }, STALE)).toBe(FIX_SHA);
    expect(shaToSettle({ checkRuns: pending, ciDecidedSha: null }, FRESH)).toBeNull();
  });

  it('asks about a set claiming completeness until the host has confirmed that head decided', () => {
    const complete = rows(['success', 'success']);
    expect(shaToSettle({ checkRuns: complete, ciDecidedSha: null }, FRESH)).toBe(FIX_SHA);
    expect(shaToSettle({ checkRuns: complete, ciDecidedSha: REVIEWED_SHA }, FRESH)).toBe(FIX_SHA);
    expect(shaToSettle({ checkRuns: complete, ciDecidedSha: FIX_SHA }, FRESH)).toBeNull();
  });

  it('a stale pending row is asked about even at a head once recorded decided (a re-run)', () => {
    const rerun = rows(['success', 'pending']);
    expect(shaToSettle({ checkRuns: rerun, ciDecidedSha: FIX_SHA }, STALE)).toBe(FIX_SHA);
  });

  it('names nothing for a pull request with no rows', () => {
    expect(shaToSettle({ checkRuns: [], ciDecidedSha: null }, STALE)).toBeNull();
  });

  it('a green In Review pull request is read ONCE, then not again on the next pass', async () => {
    const s = await makeScenario('in-review-decided@example.com');
    const card = await linkedCard(s);
    await workItemsService.updateStatus(card.id, 'in_review', s.ctx);
    const pr = await prRow();
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: FIX_SHA } });
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: pr.id,
        commitSha: FIX_SHA,
        checkName: SETTLED_LANE,
        checkSuiteId: String(CHECK_SUITE_ID),
        conclusion: 'success',
      },
    });
    hostChecks.set(FIX_SHA, [[SETTLED_LANE, 'completed', 'success']]);
    const read = vi.fn(
      async (): Promise<ReportedCheckRun[]> => [
        {
          checkName: SETTLED_LANE,
          checkSuiteId: String(CHECK_SUITE_ID),
          conclusion: 'success',
          rawConclusion: 'success',
          url: null,
          completedAt: null,
        },
      ],
    );
    const args = { pullRequestId: pr.id, workspaceId: s.workspace.id, now: new Date() };

    // First visit: the claim is checked, the host agrees, and the head is recorded decided.
    expect(await settleLostCheckCompletions({ ...args, readCheckSet: read })).toEqual({
      settled: false,
      promoted: [],
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect((await prRow()).ciDecidedSha).toBe(FIX_SHA);

    // Every later visit at that head costs nothing.
    await settleLostCheckCompletions({ ...args, readCheckSet: read });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a closed pull request, or one the host cannot answer for, settles nothing', async () => {
    const s = await makeScenario('closed-or-unreachable@example.com');
    const { pr } = await strandedInReview(s, { pendingWrittenAt: AN_HOUR_AGO() });
    const now = LATER();

    const unreachable = vi.fn(async () => null);
    expect(
      await settleLostCheckCompletions({
        pullRequestId: pr.id,
        workspaceId: s.workspace.id,
        now,
        readCheckSet: unreachable,
      }),
    ).toEqual({ settled: false, promoted: [] });
    expect(unreachable).toHaveBeenCalledTimes(1);
    expect(await conclusionOf(LOST_LANE)).toBe('pending');

    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { state: 'closed' } });
    const never = vi.fn(async () => null);
    expect(
      await settleLostCheckCompletions({
        pullRequestId: pr.id,
        workspaceId: s.workspace.id,
        now,
        readCheckSet: never,
      }),
    ).toEqual({ settled: false, promoted: [] });
    expect(never).not.toHaveBeenCalled();
  });
});

describe('MOTIR-11638 — the promotion stays the only status-gated part', () => {
  it('a card at Implemented whose lost completion is settled is promoted, and counted once', async () => {
    const s = await makeScenario('implemented-green@example.com');
    const card = await linkedCard(s);
    const pr = await prRow();
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: FIX_SHA } });
    await adminDb.githubCheckRun.createMany({
      data: [
        [SETTLED_LANE, 'success'],
        [LOST_LANE, 'pending'],
      ].map(([checkName, conclusion]) => ({
        pullRequestId: pr.id,
        commitSha: FIX_SHA,
        checkName: checkName!,
        checkSuiteId: String(CHECK_SUITE_ID),
        conclusion: conclusion!,
      })),
    });
    await adminDb.githubCheckRun.updateMany({
      where: { pullRequestId: pr.id },
      data: { createdAt: AN_HOUR_AGO(), updatedAt: AN_HOUR_AGO() },
    });
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { updatedAt: AN_HOUR_AGO() },
    });
    hostChecks.set(FIX_SHA, [
      [SETTLED_LANE, 'completed', 'success'],
      [LOST_LANE, 'completed', 'success'],
    ]);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ checkSetsSettled: 1, promoted: 1 });
    const after = await cardRow(card.id);
    expect(after.status).toBe('in_review');
    expect(after.ciState).toBe('passing');
  });

  it('a card at In Progress is not promoted by a green settle', async () => {
    const s = await makeScenario('in-progress-green@example.com');
    const { card, pr } = await strandedInReview(s, { pendingWrittenAt: AN_HOUR_AGO() });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_progress' } });
    hostChecks.set(FIX_SHA, [
      [SETTLED_LANE, 'completed', 'success'],
      [LOST_LANE, 'completed', 'success'],
    ]);

    const settle = await settleLostCheckCompletions({
      pullRequestId: pr.id,
      workspaceId: s.workspace.id,
      now: LATER(),
    });

    expect(settle).toEqual({ settled: true, promoted: [] });
    const after = await cardRow(card.id);
    expect(after.status).toBe('in_progress');
    expect(after.ciState).toBe('passing');
  });
});

describe('MOTIR-11638 — the settle is the record; what follows it is best-effort', () => {
  const HOST_GREEN = (): [string, string, string | null][] => [
    [SETTLED_LANE, 'completed', 'success'],
    [LOST_LANE, 'completed', 'success'],
  ];

  it('a re-render, withdrawal or promotion that throws never undoes the settle or the recompute', async () => {
    const s = await makeScenario('tails-throw@example.com');
    const { card, pr } = await strandedInReview(s, { pendingWrittenAt: AN_HOUR_AGO() });
    hostChecks.set(FIX_SHA, HOST_GREEN());
    // The settle's own two reads succeed; every read after them — each tail's first step —
    // fails, once with an Error and then with a bare value, as a driver can reject with.
    const real = githubPullRequestRepository.findByIdWithInstallation.bind(
      githubPullRequestRepository,
    );
    let calls = 0;
    vi.spyOn(githubPullRequestRepository, 'findByIdWithInstallation').mockImplementation(
      async (id, tx) => {
        calls += 1;
        if (calls <= 2) return real(id, tx);
        if (calls === 3) throw new Error('connection reset');
        throw 'socket hang up';
      },
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const settle = await settleLostCheckCompletions({
      pullRequestId: pr.id,
      workspaceId: s.workspace.id,
      now: LATER(),
    });

    expect(settle).toEqual({ settled: true, promoted: [] });
    expect(logged).toHaveBeenCalledTimes(3);
    expect(await conclusionOf(LOST_LANE)).toBe('success');
    const after = await cardRow(card.id);
    expect(after.ciState).toBe('passing');
    expect(after.fixReason).toBeNull();
  });

  it('a workspace with no Manager to act as still settles and recomputes, and runs no latch', async () => {
    const s = await makeScenario('no-manager@example.com');
    const { card, pr } = await strandedInReview(s, { pendingWrittenAt: AN_HOUR_AGO() });
    hostChecks.set(FIX_SHA, HOST_GREEN());
    vi.spyOn(workspaceMembershipRepository, 'findStandInManagerByWorkspace').mockResolvedValueOnce(
      null,
    );

    const settle = await settleLostCheckCompletions({
      pullRequestId: pr.id,
      workspaceId: s.workspace.id,
      now: LATER(),
    });

    expect(settle).toEqual({ settled: true, promoted: [] });
    const after = await cardRow(card.id);
    expect(after.ciState).toBe('passing');
    // No latch ran, so the green set has not been asked its merge question yet.
    expect(
      await adminDb.approvalGate.count({
        where: { workItemId: card.id, kind: 'pull_request_approval', state: 'awaiting' },
      }),
    ).toBe(0);
  });

  it('a MERGED pull request is not asked about', async () => {
    const s = await makeScenario('merged@example.com');
    const { pr } = await strandedInReview(s, { pendingWrittenAt: AN_HOUR_AGO() });
    await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { merged: true } });
    const read = vi.fn(async () => null);

    expect(
      await settleLostCheckCompletions({
        pullRequestId: pr.id,
        workspaceId: s.workspace.id,
        now: LATER(),
        readCheckSet: read,
      }),
    ).toEqual({ settled: false, promoted: [] });
    expect(read).not.toHaveBeenCalled();
  });
});
