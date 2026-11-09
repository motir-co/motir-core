import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { reconcileRecordedCheckSet } from '@/lib/services/checkSetReconcile';

// Story 7.10 · Subtask 7.10.6 / MOTIR-894 — the CI feedback loop, against a real
// Postgres (the motir-core convention). Covers: a check_suite / check_run
// terminal conclusion → a passing note or failure summary on the LINKED subtask +
// the item's `ciState` verification signal; idempotency on (pr, headSha,
// checkName) under redelivery AND a re-run that changes conclusion (comment
// updated in place, never duplicated); the clean no-op paths (a PR with no linked
// work item; a NEUTRAL conclusion), the pending-RECORDED path (MOTIR-1579 —
// a pending row for the Development surface, with no terminal side-effects); PR resolution by the payload's
// PR-number list AND the head-branch fallback; and the Story-level "N of M
// verified" roll-up computed via the EXISTING `getProjectRoadmap` progress
// aggregation (not a parallel path).
//
// MOTIR-2946 moved the COMMENT's identity one level coarser — ONE comment per
// `(change request, head sha)` carrying the aggregate over the whole check set,
// interim while any check still runs — while leaving the INGESTION key (and so
// the Development surface) at `(pr, headSha, checkName)`. Its cases are the last
// block below.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci';
const REPO_PROVIDER_ID = '777';

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
    ],
  });
  return { user, workspace, project, ctx };
}

/** Open a PR through the pull_request webhook so its row is stored and linked to
 *  `identifier` (via the head ref) — mirrors reality: the PR opens (link) → then
 *  CI runs against it. `identifier: null` opens a PR that resolves to NO work
 *  item (a non-matching head ref). Returns the PR number + head branch. */
async function openPr(identifier: string | null, number: number) {
  const headBranch = identifier ? `feat/${identifier}-work` : 'feat/no-match-branch';
  // MOTIR-3674 — the link is the only association a pull request has; the key in
  // the branch is a label. A run writes it the moment `gh pr create` returns,
  // which is before the `opened` delivery lands.
  // `identifier: null` still means "resolves to no work item" — it just gets
  // there by not being linked rather than by not being named.
  if (identifier) {
    await linkPrByIdentifier({
      identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef: headBranch,
      title: identifier,
    });
  }
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: identifier ?? 'Unrelated change',
      head: { ref: headBranch },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  return { number, headBranch };
}

function checkSuitePayload(opts: {
  conclusion: string | null;
  status?: string;
  headSha: string;
  headBranch?: string | null;
  prNumbers?: number[];
  appSlug?: string;
  repoId?: number;
  suiteId?: number;
  updatedAt?: string;
}) {
  return {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: opts.repoId ?? Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: opts.headBranch === undefined ? null : opts.headBranch,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: opts.appSlug ?? 'github-actions' },
      ...(opts.suiteId !== undefined ? { id: opts.suiteId } : {}),
      ...(opts.updatedAt !== undefined ? { updated_at: opts.updatedAt } : {}),
      pull_requests: (opts.prNumbers ?? []).map((n) => ({ number: n })),
    },
  };
}

function checkRunPayload(opts: {
  conclusion: string | null;
  name?: string;
  status?: string;
  headSha: string;
  headBranch?: string | null;
  prNumbers?: number[];
  suiteId?: number;
  startedAt?: string;
  completedAt?: string;
}) {
  return {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      name: opts.name ?? 'build',
      ...(opts.startedAt !== undefined ? { started_at: opts.startedAt } : {}),
      ...(opts.completedAt !== undefined ? { completed_at: opts.completedAt } : {}),
      check_suite: {
        head_branch: opts.headBranch ?? null,
        ...(opts.suiteId !== undefined ? { id: opts.suiteId } : {}),
      },
      pull_requests: (opts.prNumbers ?? []).map((n) => ({ number: n })),
    },
  };
}

async function commentsOn(workItemId: string) {
  return adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
}
/** THE feedback comment records for one head commit — one row per delivered card
 *  (`github_ci_feedback_comment`, MOTIR-3770). This is where the comment's
 *  identity lives; `githubCheckRun.feedbackCommentId` was its superseded mirror
 *  and left the generated client with MOTIR-3863 (the SCHEMA-ONLY phase of the
 *  column's three-phase drop). */
async function feedbackRecords(commitSha: string) {
  return adminDb.githubCiFeedbackComment.findMany({
    where: { commitSha },
    orderBy: { createdAt: 'asc' },
  });
}
async function ciStateOf(workItemId: string): Promise<string | null> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.ciState;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('githubWebhookService — CI feedback (MOTIR-894)', () => {
  it('a passing check_suite posts a passing note and marks the subtask verified', async () => {
    const s = await makeScenario('pass@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(res).toMatchObject({
      event: 'ci',
      outcome: 'verified',
      workItemId: item.id,
      ciState: 'passing',
    });
    expect(await ciStateOf(item.id)).toBe('passing');

    const comments = await commentsOn(item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('CI passing');

    const checkRows = await adminDb.githubCheckRun.findMany();
    expect(checkRows).toHaveLength(1);
    expect(checkRows[0]).toMatchObject({ conclusion: 'success', commitSha: 'sha1' });
    // WHICH comment this verdict is, per card — `github_ci_feedback_comment`
    // (MOTIR-3770). It used to be asserted off `githubCheckRun.feedbackCommentId`,
    // which MOTIR-3863 took out of the generated client on its way to being
    // dropped; the fact under test is unchanged and only its home moved.
    expect(await feedbackRecords('sha1')).toMatchObject([
      { workItemId: item.id, commentId: comments[0]!.id },
    ]);
  });

  it('a failing check_suite posts the failure summary + link and flips the item to not-ready', async () => {
    const s = await makeScenario('fail@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'failure', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(res).toMatchObject({
      event: 'ci',
      outcome: 'failed',
      workItemId: item.id,
      ciState: 'failing',
    });
    expect(await ciStateOf(item.id)).toBe('failing');

    const comments = await commentsOn(item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('CI failed');
    expect(comments[0]!.bodyMd).toContain('/pull/7/checks'); // the "view checks" link
  });

  it('is idempotent under REDELIVERY — the same conclusion twice never duplicates the comment', async () => {
    const s = await makeScenario('redeliver@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);
    const payload = checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7] });

    const first = await githubWebhookService.handleEvent('check_suite', payload);
    expect(first).toMatchObject({ outcome: 'verified' });
    const second = await githubWebhookService.handleEvent('check_suite', payload);
    expect(second).toMatchObject({ outcome: 'noop' });

    expect(await commentsOn(item.id)).toHaveLength(1);
    const githubCheckRunCount = await adminDb.githubCheckRun.count();
    expect(githubCheckRunCount).toBe(1);
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a RE-RUN that changes conclusion (same pr/sha/check) UPDATES the comment in place', async () => {
    const s = await makeScenario('rerun@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'failure', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(await ciStateOf(item.id)).toBe('failing');

    // A re-run of the SAME suite at the SAME commit now passes.
    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(res).toMatchObject({ outcome: 'verified', ciState: 'passing' });

    const comments = await commentsOn(item.id);
    expect(comments).toHaveLength(1); // updated in place — NOT a second comment
    expect(comments[0]!.bodyMd).toContain('CI passing');
    const githubCheckRunCount = await adminDb.githubCheckRun.count();
    expect(githubCheckRunCount).toBe(1);
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a check event for a PR with NO linked work item is a clean no-op', async () => {
    const s = await makeScenario('nowi@example.com');
    // Also make a REAL item + PR so we can prove nothing leaks onto it.
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);
    // PR #99 opens but resolves to no work item (non-matching head ref).
    await openPr(null, 99);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'shaX', prNumbers: [99] }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'no_work_item' });

    const githubCheckRunCount = await adminDb.githubCheckRun.count();
    expect(githubCheckRunCount).toBe(0); // nothing recorded
    expect(await commentsOn(item.id)).toHaveLength(0); // the real item is untouched
    // ⚠️ `running`, not null, since MOTIR-5470 — and the assertion is SHARPER for
    // it. The real item has a linked pull request of its own that has not
    // reported, which is exactly what `running` means; what this test is about is
    // that #99's SUCCESS did not leak onto it, and `passing` is the value that
    // would prove it had. Asserting null could no longer distinguish the two.
    expect(await ciStateOf(item.id)).toBe('running');
  });

  it('an in-flight (pending) conclusion is RECORDED as a pending row — still no comment, no signal (MOTIR-1579)', async () => {
    const s = await makeScenario('pending@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({
        conclusion: null,
        status: 'in_progress',
        headSha: 'sha1',
        prNumbers: [7],
      }),
    );
    // The row exists (the Development surface derives "Checks running" from
    // it) and the COMMENT stays terminal-only: an announcement needs something to
    // announce.
    //
    // ⚠️ THE `ciState` HALF OF THE TERMINAL-ONLY CONTRACT IS GONE (MOTIR-5470).
    // MOTIR-894 made the column terminal-only, which is why a card whose fix was
    // already building kept reading `failing` until the new commit's first
    // terminal check. The column now carries `running`, so a pending check MOVES
    // it — deliberately, and this assertion is the record of that reversal rather
    // than a test bending to the code.
    expect(res).toMatchObject({ event: 'ci', outcome: 'pending_recorded' });
    const rows = await adminDb.githubCheckRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ conclusion: 'pending' });
    expect(await feedbackRecords('sha1')).toEqual([]);
    expect(await commentsOn(item.id)).toHaveLength(0);
    expect(await ciStateOf(item.id)).toBe('running');
  });

  it('a NEUTRAL (skipped / stale) conclusion stays a full no-op — nothing recorded', async () => {
    const s = await makeScenario('neutral@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'neutral', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'ignored_pending' });
    const githubCheckRunCount = await adminDb.githubCheckRun.count();
    expect(githubCheckRunCount).toBe(0);
    expect(await commentsOn(item.id)).toHaveLength(0);
    // The neutral conclusion is still a full no-op — it recorded nothing, so
    // there is nothing for the fold to read. `running` is what the card ALREADY
    // read from its own open pull request before this event (MOTIR-5470), not
    // something this event wrote: the check count above is what says the no-op
    // held.
    expect(await ciStateOf(item.id)).toBe('running');
  });

  it('a pending RE-RUN preserves the feedback-comment link, and the later terminal conclusion updates that SAME comment', async () => {
    const s = await makeScenario('pending-rerun@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    // 1. Terminal success → the passing note + ciState 'passing'.
    await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7] }),
    );
    const afterSuccess = await commentsOn(item.id);
    expect(afterSuccess).toHaveLength(1);
    expect(await ciStateOf(item.id)).toBe('passing');

    // 2. A re-run starts (pending at the SAME pr/sha/check): the row converges
    //    to 'pending' and KEEPS the comment link — and since MOTIR-5470 the
    //    card's signal goes back to `running` with it. That is the point of the
    //    card rather than a side effect: a re-run IS the card waiting on a
    //    verdict again, and leaving it `passing` is asserting a verdict that has
    //    been withdrawn. The COMMENT is the thing that stays put here.
    const pendingRes = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({
        conclusion: null,
        status: 'in_progress',
        headSha: 'sha1',
        prNumbers: [7],
      }),
    );
    expect(pendingRes).toMatchObject({ event: 'ci', outcome: 'pending_recorded' });
    const rows = await adminDb.githubCheckRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conclusion).toBe('pending');
    // The pending upsert must not lose the comment already recorded for this
    // commit — the record is per card now, so that is what the assertion reads.
    expect(await feedbackRecords('sha1')).toMatchObject([{ commentId: afterSuccess[0]!.id }]);
    expect(await ciStateOf(item.id)).toBe('running'); // the verdict is withdrawn

    // 3. The re-run concludes FAILURE → the SAME comment updates in place
    //    (never a duplicate) and the signal flips.
    await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'failure', headSha: 'sha1', prNumbers: [7] }),
    );
    const afterFailure = await commentsOn(item.id);
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]!.id).toBe(afterSuccess[0]!.id);
    expect(afterFailure[0]!.bodyMd).toContain('CI failed');
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('resolves the PR by HEAD BRANCH when the payload carries no PR-number list', async () => {
    const s = await makeScenario('branch@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    const pr = await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({
        conclusion: 'success',
        headSha: 'sha1',
        prNumbers: [], // no PR list — must fall back to the branch
        headBranch: pr.headBranch,
      }),
    );
    expect(res).toMatchObject({ outcome: 'verified', workItemId: item.id });
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  // ── MOTIR-5918 — a PULL REF where the branch should be ──────────────────────
  //
  // GitHub's CodeQL DEFAULT SETUP runs as a dynamic workflow whose check suite
  // reports `head_branch: refs/pull/<n>/head` and an empty `pull_requests`, read
  // off motir-gateway#45 at f6faeec (suite 96436591673) beside the ordinary
  // `ci.yml` suite at the same commit, which carried the real branch name. The
  // literal matched no stored `head_ref`, so every delivery from that suite was
  // dropped and its rows sat `pending` until the half-hourly reconcile.

  it('a check_run carrying refs/pull/<n>/head records BOTH its pending and terminal rows against PR <n>', async () => {
    const s = await makeScenario('pullref-run@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 45);
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 45 } });

    const pending = await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({
        conclusion: null,
        status: 'in_progress',
        headSha: 'sha1',
        name: 'Analyze (go)',
        headBranch: 'refs/pull/45/head',
        prNumbers: [],
      }),
    );
    expect(pending).toMatchObject({ event: 'ci', outcome: 'pending_recorded' });
    expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
      { pullRequestId: pr.id, checkName: 'Analyze (go)', conclusion: 'pending' },
    ]);

    const done = await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({
        conclusion: 'success',
        headSha: 'sha1',
        name: 'Analyze (go)',
        headBranch: 'refs/pull/45/head',
        prNumbers: [],
      }),
    );
    expect(done).toMatchObject({ event: 'ci', outcome: 'verified', workItemId: item.id });
    // The terminal delivery UPDATED the pending row rather than being dropped.
    expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
      { pullRequestId: pr.id, checkName: 'Analyze (go)', conclusion: 'success' },
    ]);
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a check_suite carrying refs/pull/<n>/merge resolves to PR <n> the same way', async () => {
    const s = await makeScenario('pullref-suite@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 45);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({
        conclusion: 'success',
        headSha: 'sha1',
        prNumbers: [],
        headBranch: 'refs/pull/45/merge',
      }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'verified', workItemId: item.id });
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a pull ref naming a PR Motir has no row for resolves to nothing and writes nothing', async () => {
    const s = await makeScenario('pullref-unknown@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 45);

    const res = await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({
        conclusion: 'success',
        headSha: 'sha1',
        headBranch: 'refs/pull/46/head',
        prNumbers: [],
      }),
    );
    expect(res).toEqual({ event: 'ci', outcome: 'no_pull_request' });
    expect(await adminDb.githubCheckRun.findMany()).toEqual([]);
    expect(await commentsOn(item.id)).toHaveLength(0);
  });

  it('handles a check_run event (per-check) the same way', async () => {
    const s = await makeScenario('checkrun@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7], name: 'lint' }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'verified', ciState: 'passing' });
    expect(await ciStateOf(item.id)).toBe('passing');
    const rows = await adminDb.githubCheckRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checkName: 'lint' });
  });

  // ── MOTIR-2946 — ONE feedback comment per (change request, head sha) ──────────
  //
  // The comment used to be keyed per CHECK NAME, so motir-core's ~34-check PR set
  // put ~34 comments on one work item, each generalizing a single check's
  // conclusion to "this work is verified" — including, mid-run, a red verdict and
  // a green verdict about the same commit minutes apart. These cover the new
  // identity: N conclusions → 1 comment, updated in place, interim while any check
  // is still running, and still naming every failure.

  it('N terminal conclusions at one head sha produce exactly ONE comment (motir-core scale: 34 checks)', async () => {
    const s = await makeScenario('one-comment@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    // motir-core's real check set: 17 Playwright shards, 8 sandbox profiles,
    // CodeQL, the aggregate `CI complete`, license/cla, … — 34 names, one head sha.
    const names = Array.from({ length: 34 }, (_, i) => `check ${i + 1}`);
    expect(await commentsOn(item.id)).toHaveLength(0); // before: 0
    for (const name of names) {
      await githubWebhookService.handleEvent(
        'check_run',
        checkRunPayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7], name }),
      );
    }

    const comments = await commentsOn(item.id);
    expect(comments).toHaveLength(1); // after: 1 — NOT 34
    expect(comments[0]!.bodyMd).toBe(
      '✅ **CI passing** — all 34 checks succeeded on the linked pull request. This work is verified.',
    );
    // Ingestion is UNCHANGED: still one row per check name. The COMMENT is one
    // per (change request, head commit, card), so 34 check rows record exactly
    // one feedback row naming the one comment.
    const rows = await adminDb.githubCheckRun.findMany();
    expect(rows).toHaveLength(34);
    expect(await feedbackRecords('sha1')).toMatchObject([
      { workItemId: item.id, commentId: comments[0]!.id },
    ]);
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a check still PENDING keeps the comment INTERIM — no terminal verdict is asserted', async () => {
    const s = await makeScenario('interim@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    // Three checks announce themselves, as GitHub does before any concludes.
    for (const name of ['lint', 'e2e shard 1', 'e2e shard 2']) {
      await githubWebhookService.handleEvent(
        'check_run',
        checkRunPayload({
          conclusion: null,
          status: 'in_progress',
          headSha: 'sha1',
          prNumbers: [7],
          name,
        }),
      );
    }
    // One concludes. Two are still running, so the comment must NOT claim a verdict.
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7], name: 'lint' }),
    );

    const interim = await commentsOn(item.id);
    expect(interim).toHaveLength(1);
    expect(interim[0]!.bodyMd).toContain('CI running');
    expect(interim[0]!.bodyMd).toContain('1 of 3 checks complete');
    expect(interim[0]!.bodyMd).toContain('No verdict yet');
    expect(interim[0]!.bodyMd).not.toContain('This work is verified');
    expect(interim[0]!.bodyMd).not.toContain('CI failed');

    // The remaining two conclude — one of them red. NOW the set is terminal, and
    // the SAME comment carries the aggregate, naming what failed.
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({
        conclusion: 'failure',
        headSha: 'sha1',
        prNumbers: [7],
        name: 'e2e shard 1',
      }),
    );
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({
        conclusion: 'success',
        headSha: 'sha1',
        prNumbers: [7],
        name: 'e2e shard 2',
      }),
    );

    const final = await commentsOn(item.id);
    expect(final).toHaveLength(1);
    expect(final[0]!.id).toBe(interim[0]!.id); // updated in place
    expect(final[0]!.bodyMd).toContain('CI failed');
    expect(final[0]!.bodyMd).toContain('1 of 3 checks did not pass');
    expect(final[0]!.bodyMd).toContain('`e2e shard 1`'); // the roll-up names it
    expect(final[0]!.bodyMd).toContain('needs another pass');
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('a DIFFERENT check flipping on re-run rewrites the SAME comment, never a second one', async () => {
    const s = await makeScenario('flip@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7], name: 'lint' }),
    );
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'failure', headSha: 'sha1', prNumbers: [7], name: 'build' }),
    );
    const afterFailure = await commentsOn(item.id);
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]!.bodyMd).toContain('`build`');

    // `build` is re-run and now passes: same comment id, new body, green aggregate.
    const res = await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7], name: 'build' }),
    );
    expect(res).toMatchObject({ outcome: 'verified', ciState: 'passing' });

    const afterRerun = await commentsOn(item.id);
    expect(afterRerun).toHaveLength(1);
    expect(afterRerun[0]!.id).toBe(afterFailure[0]!.id);
    expect(afterRerun[0]!.bodyMd).toContain('all 2 checks succeeded');
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a NEW head sha starts its OWN comment — the identity is (change request, head sha)', async () => {
    const s = await makeScenario('newsha@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'failure', headSha: 'sha1', prNumbers: [7], name: 'lint' }),
    );
    await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'success', headSha: 'sha2', prNumbers: [7], name: 'lint' }),
    );

    const bodies = (await commentsOn(item.id)).map((c) => c.bodyMd);
    expect(bodies).toHaveLength(2); // one per pushed commit, not one per check
    expect(bodies.filter((b) => b.includes('CI failed'))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes('CI passing'))).toHaveLength(1);
  });

  it('CONCURRENT terminal deliveries at one head sha still produce ONE comment (real concurrency)', async () => {
    const s = await makeScenario('concurrent@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    // The shape the row lock exists for: N deliveries land together, each reads
    // "no comment yet" and each wants to write one. Without the lock the first
    // two both create one and the work item carries two contradicting verdicts.
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
        githubWebhookService.handleEvent(
          'check_run',
          checkRunPayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7], name }),
        ),
      ),
    );
    expect(results.every((r) => (r as { outcome: string }).outcome === 'verified')).toBe(true);

    const comments = await commentsOn(item.id);
    expect(comments).toHaveLength(1);
    const rows = await adminDb.githubCheckRun.findMany();
    expect(rows).toHaveLength(6);
    expect(await feedbackRecords('sha1')).toMatchObject([
      { workItemId: item.id, commentId: comments[0]!.id },
    ]);
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('the Story shows "N of M verified" via the EXISTING roadmap roll-up', async () => {
    const s = await makeScenario('rollup@example.com');
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'A story' },
      s.ctx,
    );
    const sub1 = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'subtask', title: 'sub 1', parentId: story.id },
      s.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'subtask', title: 'sub 2', parentId: story.id },
      s.ctx,
    );

    // Drive a real CI success against sub1 → its ciState flips to passing.
    await openPr(sub1.identifier, 11);
    await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [11] }),
    );

    // The Story-level meter is the SAME getProjectRoadmap rollup, now carrying
    // `verified` alongside done/total: 1 of the 2 subtasks is CI-verified.
    const roadmap = await workItemsService.getProjectRoadmap(s.project.id, null, s.ctx);
    const storyNode = roadmap.nodes.find((n) => n.id === story.id)!;
    expect(storyNode.progress).toEqual({ done: 0, total: 2, verified: 1 });
  });
});

// ── MOTIR-10456 — a LATE pending delivery never undoes a verdict it predates ──
//
// GitHub never promised delivery order, and the webhook inbox (MOTIR-10425)
// re-runs a lost delivery 2–7 minutes late and retries / replays one that threw.
// Before this card the pending write was an unconditional upsert, so such a
// delivery turned `success` back into `pending` and the card read `running`
// until the reconcile tick. The arbiter is the provider's own time for each
// state: a pending state that STARTED before the row's terminal one FINISHED is
// that run's late delivery; one that started after it is a re-run.
describe('githubWebhookService — late pending deliveries (MOTIR-10456)', () => {
  const SUITE = 87626227873;
  const run = (o: Partial<Parameters<typeof checkRunPayload>[0]>) =>
    checkRunPayload({ headSha: 'sha1', prNumbers: [7], suiteId: SUITE, conclusion: null, ...o });

  async function settledGreen(email: string) {
    const s = await makeScenario(email);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);
    await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: '2026-11-05T10:00:00Z' }),
    );
    const done = await githubWebhookService.handleEvent(
      'check_run',
      run({
        conclusion: 'success',
        startedAt: '2026-11-05T10:00:00Z',
        completedAt: '2026-11-05T10:04:00Z',
      }),
    );
    expect(done).toMatchObject({ outcome: 'verified' });
    expect(await ciStateOf(item.id)).toBe('passing');
    return { s, item };
  }

  it('a pending delivery processed AFTER the same run finished leaves the terminal row and ciState alone', async () => {
    const { item } = await settledGreen('late-pending@example.com');
    const before = await adminDb.githubCheckRun.findFirstOrThrow();
    expect(before.conclusionAt).toEqual(new Date('2026-11-05T10:04:00Z'));

    // The SAME run's `in_progress` delivery, replayed by the inbox sweep.
    const late = await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: '2026-11-05T10:00:00Z' }),
    );
    expect(late).toMatchObject({ event: 'ci', outcome: 'stale_pending', workItemId: item.id });
    const rows = await adminDb.githubCheckRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conclusion: 'success',
      conclusionAt: new Date('2026-11-05T10:04:00Z'),
    });
    expect(rows[0]!.updatedAt).toEqual(before.updatedAt); // nothing was written
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a pending state that started at the very instant the run finished is still the late one', async () => {
    const { item } = await settledGreen('late-pending-tie@example.com');
    const late = await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'queued', startedAt: '2026-11-05T10:04:00Z' }),
    );
    expect(late).toMatchObject({ outcome: 'stale_pending' });
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a RE-RUN of the check in the same suite reads running while it runs, then settles', async () => {
    const { item } = await settledGreen('rerun-pending@example.com');

    // A re-run: a new check run under the same name and suite, started after
    // the first one finished.
    const rerun = await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'queued', startedAt: '2026-11-05T10:10:00Z' }),
    );
    expect(rerun).toMatchObject({ outcome: 'pending_recorded' });
    expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
      { conclusion: 'pending', conclusionAt: new Date('2026-11-05T10:10:00Z') },
    ]);
    expect(await ciStateOf(item.id)).toBe('running');

    // …and the FIRST run's late in_progress arriving now leaves the row pending at
    // the re-run's start — it never moves a pending row's start back (MOTIR-10461).
    const lateStart = await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: '2026-11-05T10:00:00Z' }),
    );
    expect(lateStart).toMatchObject({ outcome: 'stale_pending' });
    expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
      { conclusion: 'pending', conclusionAt: new Date('2026-11-05T10:10:00Z') },
    ]);
    expect(await ciStateOf(item.id)).toBe('running');

    const failed = await githubWebhookService.handleEvent(
      'check_run',
      run({
        conclusion: 'failure',
        startedAt: '2026-11-05T10:10:00Z',
        completedAt: '2026-11-05T10:13:00Z',
      }),
    );
    expect(failed).toMatchObject({ outcome: 'failed' });
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('a check_suite is ordered by updated_at the same way — late `requested` refused, `rerequested` written', async () => {
    const s = await makeScenario('late-suite@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);
    const suite = (o: Partial<Parameters<typeof checkSuitePayload>[0]>) =>
      checkSuitePayload({
        headSha: 'sha1',
        prNumbers: [7],
        suiteId: SUITE,
        conclusion: null,
        ...o,
      });

    await githubWebhookService.handleEvent(
      'check_suite',
      suite({ conclusion: 'success', updatedAt: '2026-11-05T10:05:00Z' }),
    );
    expect(await ciStateOf(item.id)).toBe('passing');

    const late = await githubWebhookService.handleEvent(
      'check_suite',
      suite({ status: 'queued', updatedAt: '2026-11-05T10:00:00Z' }),
    );
    expect(late).toMatchObject({ outcome: 'stale_pending' });
    expect(await ciStateOf(item.id)).toBe('passing');

    const rerequested = await githubWebhookService.handleEvent(
      'check_suite',
      suite({ status: 'queued', updatedAt: '2026-11-05T10:20:00Z' }),
    );
    expect(rerequested).toMatchObject({ outcome: 'pending_recorded' });
    expect(await ciStateOf(item.id)).toBe('running');
  });

  it('a terminal row with no recorded time cannot be ordered, and keeps last-write-wins', async () => {
    const { item } = await settledGreen('untimed-row@example.com');
    // A row written before `conclusion_at` existed.
    await adminDb.githubCheckRun.updateMany({ data: { conclusionAt: null } });
    const res = await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: '2026-11-05T10:00:00Z' }),
    );
    expect(res).toMatchObject({ outcome: 'pending_recorded' });
    expect(await ciStateOf(item.id)).toBe('running');
  });

  it('the reconcile stamps the host’s finish time on what it creates and settles, so a late pending is refused against it too', async () => {
    const s = await makeScenario('reconcile-time@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);
    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 7 } });
    // A pending row whose completion delivery was lost.
    await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: '2026-11-05T10:00:00Z' }),
    );
    const finished = new Date('2026-11-05T10:04:00Z');
    const reported = [
      { checkName: 'build', checkSuiteId: String(SUITE), conclusion: 'success' as const },
      { checkName: 'lint', checkSuiteId: String(SUITE), conclusion: 'success' as const },
      // Still running on the host: created pending, with no finish to date it by.
      { checkName: 'e2e', checkSuiteId: String(SUITE), conclusion: 'pending' as const },
    ].map((r) => ({
      ...r,
      rawConclusion: r.conclusion === 'pending' ? null : 'success',
      url: null,
      completedAt: r.conclusion === 'pending' ? null : finished,
    }));
    const result = await reconcileRecordedCheckSet({
      pullRequestId: pr.id,
      commitSha: 'sha1',
      reported,
      recorded: [{ checkName: 'build', checkSuiteId: String(SUITE), conclusion: 'pending' }],
      tx: adminDb,
    });
    expect(result).toEqual({ created: 2, settled: 1, decided: false });
    expect(await adminDb.githubCheckRun.findMany({ orderBy: { checkName: 'asc' } })).toMatchObject([
      { checkName: 'build', conclusion: 'success', conclusionAt: finished },
      { checkName: 'e2e', conclusion: 'pending', conclusionAt: null },
      { checkName: 'lint', conclusion: 'success', conclusionAt: finished },
    ]);

    const late = await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: '2026-11-05T10:00:00Z' }),
    );
    expect(late).toMatchObject({ outcome: 'stale_pending', workItemId: item.id });
  });
});

// ── MOTIR-10461 — a LATE terminal delivery never settles a re-run it predates ──
//
// The mirror of the block above. A check re-run in the same suite reopens its row
// as `pending`, dated by the re-run's START. The FIRST run's completion delivery,
// processed after that (the inbox re-runs a lost delivery 2–7 minutes late, and
// retries / replays one that threw), finished BEFORE the re-run started: it is
// that first run's late verdict, not the re-run's. Before this card the terminal
// write was an unconditional upsert, so the row and the card read the old verdict
// while the re-run was still running — and a stale green could comment and promote.
describe('githubWebhookService — late terminal deliveries (MOTIR-10461)', () => {
  const SUITE = 87626227873;
  const run = (o: Partial<Parameters<typeof checkRunPayload>[0]>) =>
    checkRunPayload({ headSha: 'sha1', prNumbers: [7], suiteId: SUITE, conclusion: null, ...o });
  const FIRST_START = '2026-11-05T10:00:00Z';
  const FIRST_FINISH = '2026-11-05T10:04:00Z';
  const RERUN_START = '2026-11-05T10:10:00Z';
  const RERUN_FINISH = '2026-11-05T10:13:00Z';

  /** A card with a linked PR whose `build` check is re-running: the first run's
   *  `in_progress`, then the re-run's `queued` — and NOT the first run's completion. */
  async function rerunInFlight(email: string) {
    const s = await makeScenario(email);
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);
    await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: FIRST_START }),
    );
    const rerun = await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'queued', startedAt: RERUN_START }),
    );
    expect(rerun).toMatchObject({ outcome: 'pending_recorded' });
    expect(await ciStateOf(item.id)).toBe('running');
    return { s, item };
  }

  it('the first run’s late FAILURE leaves the re-run’s pending row and ciState running (the card’s reproduction)', async () => {
    const { item } = await rerunInFlight('late-terminal-red@example.com');
    const before = await adminDb.githubCheckRun.findFirstOrThrow();

    const late = await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'failure', startedAt: FIRST_START, completedAt: FIRST_FINISH }),
    );
    expect(late).toEqual({ event: 'ci', outcome: 'stale_terminal', workItemId: item.id });
    const rows = await adminDb.githubCheckRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conclusion: 'pending',
      conclusionAt: new Date(RERUN_START),
    });
    expect(rows[0]!.updatedAt).toEqual(before.updatedAt); // nothing was written
    expect(await ciStateOf(item.id)).toBe('running');
    // A refused verdict announces nothing.
    expect(await feedbackRecords('sha1')).toHaveLength(0);
    expect(await commentsOn(item.id)).toHaveLength(0);
  });

  it('the first run’s late GREEN neither comments nor promotes, and the re-run’s own completion then settles, comments and promotes as before', async () => {
    const { item } = await rerunInFlight('late-terminal-green@example.com');
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'implemented' } });

    const late = await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'success', startedAt: FIRST_START, completedAt: FIRST_FINISH }),
    );
    expect(late).toEqual({ event: 'ci', outcome: 'stale_terminal', workItemId: item.id });
    expect(late).not.toHaveProperty('promoted');
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'implemented',
    );
    expect(await ciStateOf(item.id)).toBe('running');
    expect(await feedbackRecords('sha1')).toHaveLength(0);

    // The run the row is waiting on — finished after it started — settles it.
    const settled = await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'success', startedAt: RERUN_START, completedAt: RERUN_FINISH }),
    );
    expect(settled).toMatchObject({
      outcome: 'verified',
      workItemId: item.id,
      ciState: 'passing',
      promoted: [item.id],
    });
    expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
      { conclusion: 'success', conclusionAt: new Date(RERUN_FINISH) },
    ]);
    expect(await ciStateOf(item.id)).toBe('passing');
    expect(await feedbackRecords('sha1')).toHaveLength(1);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_review',
    );
  });

  it('the re-run’s own failure settles it red, comments and reads failing', async () => {
    const { item } = await rerunInFlight('rerun-red@example.com');
    const failed = await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'failure', startedAt: RERUN_START, completedAt: RERUN_FINISH }),
    );
    expect(failed).toMatchObject({ outcome: 'failed', ciState: 'failing' });
    expect(await ciStateOf(item.id)).toBe('failing');
    expect(await feedbackRecords('sha1')).toHaveLength(1);
  });

  it('a run that finished at the very instant the pending state started still settles it', async () => {
    // The tie MOTIR-10456 resolves the other way round: a pending state that started
    // at the instant a run finished is that run's late delivery, so the finish is the
    // later state — and a terminal delivery dated at the pending start wins.
    const { item } = await rerunInFlight('late-terminal-tie@example.com');
    const res = await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'failure', startedAt: FIRST_START, completedAt: RERUN_START }),
    );
    expect(res).toMatchObject({ outcome: 'failed' });
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('a late in_progress of the first run does not move the re-run’s start back, so its late completion is still refused', async () => {
    // The review note on MOTIR-10456 (motir-core#3972): a pending row refreshed with an
    // OLDER start would make the first run's finish look newer than the re-run.
    const { item } = await rerunInFlight('late-start@example.com');
    const lateStart = await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: FIRST_START }),
    );
    expect(lateStart).toMatchObject({ outcome: 'stale_pending', workItemId: item.id });
    expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
      { conclusion: 'pending', conclusionAt: new Date(RERUN_START) },
    ]);
    expect(await ciStateOf(item.id)).toBe('running');

    const late = await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'failure', startedAt: FIRST_START, completedAt: FIRST_FINISH }),
    );
    expect(late).toMatchObject({ outcome: 'stale_terminal' });
    expect(await ciStateOf(item.id)).toBe('running');
  });

  it('a later pending state of the same row still refreshes its start', async () => {
    await rerunInFlight('later-start@example.com');
    const res = await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: '2026-11-05T10:11:00Z' }),
    );
    expect(res).toMatchObject({ outcome: 'pending_recorded' });
    expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
      { conclusion: 'pending', conclusionAt: new Date('2026-11-05T10:11:00Z') },
    ]);
  });

  it('a pending row with no recorded time cannot be ordered, and keeps last-write-wins', async () => {
    const { item } = await rerunInFlight('untimed-pending@example.com');
    // A row written before `conclusion_at` existed.
    await adminDb.githubCheckRun.updateMany({ data: { conclusionAt: null } });
    const res = await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'failure', startedAt: FIRST_START, completedAt: FIRST_FINISH }),
    );
    expect(res).toMatchObject({ outcome: 'failed' });
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('a terminal delivery with no time of its own cannot be ordered, and keeps last-write-wins', async () => {
    const { item } = await rerunInFlight('untimed-terminal@example.com');
    const res = await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'failure', startedAt: FIRST_START }),
    );
    expect(res).toMatchObject({ outcome: 'failed' });
    expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
      { conclusion: 'failure', conclusionAt: null },
    ]);
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('a session pull request (no linked card) refuses the late verdict the same way and names no card', async () => {
    const s = await makeScenario('late-terminal-session@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A card of the run' },
      s.ctx,
    );
    const sessionBranch = 'motir/auto-run-10461';
    // Dispatch bookkeeping a claim would have written (as cardCiState.test.ts does).
    await adminDb.workItem.update({ where: { id: item.id }, data: { sessionBranch } });
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: {
        number: 7,
        state: 'open',
        merged: false,
        title: 'A run',
        head: { ref: sessionBranch },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'in_progress', startedAt: FIRST_START }),
    );
    await githubWebhookService.handleEvent(
      'check_run',
      run({ status: 'queued', startedAt: RERUN_START }),
    );
    expect(await ciStateOf(item.id)).toBe('running');

    const late = await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'failure', startedAt: FIRST_START, completedAt: FIRST_FINISH }),
    );
    expect(late).toEqual({ event: 'ci', outcome: 'stale_terminal' });
    expect(await ciStateOf(item.id)).toBe('running');
  });

  it('a terminal delivery still overwrites a terminal row, as before (a redelivery or a re-run’s verdict)', async () => {
    const { item } = await rerunInFlight('terminal-over-terminal@example.com');
    await githubWebhookService.handleEvent(
      'check_run',
      run({ conclusion: 'failure', startedAt: RERUN_START, completedAt: RERUN_FINISH }),
    );
    const again = await githubWebhookService.handleEvent(
      'check_run',
      run({
        conclusion: 'success',
        startedAt: '2026-11-05T10:20:00Z',
        completedAt: '2026-11-05T10:24:00Z',
      }),
    );
    expect(again).toMatchObject({ outcome: 'verified' });
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  // ── MOTIR-10467 — and never overwrites a re-run that has already FINISHED ──
  //
  // The block above refuses the first run's late verdict while the re-run RUNS.
  // When the re-run has already settled by the time that late delivery is
  // processed, the row is terminal again — and a terminal row used to be
  // overwritten unguarded, so the 10:04 failure replaced the 10:13 green. Terminal
  // over terminal is now ordered by the finish too: strictly older is refused, the
  // same finish (a redelivery) and a later one (a re-run's verdict) are written.
  describe('a re-run that has already finished (MOTIR-10467)', () => {
    /** `rerunInFlight`, then the re-run's own completion at RERUN_FINISH. */
    async function rerunFinished(email: string, conclusion: 'success' | 'failure') {
      const { s, item } = await rerunInFlight(email);
      const settled = await githubWebhookService.handleEvent(
        'check_run',
        run({ conclusion, startedAt: RERUN_START, completedAt: RERUN_FINISH }),
      );
      expect(settled).toMatchObject({ outcome: conclusion === 'success' ? 'verified' : 'failed' });
      return { s, item };
    }

    it('the first run’s late FAILURE leaves the re-run’s green row, ciState and comment alone (the card’s reproduction)', async () => {
      const { item } = await rerunFinished('finished-late-red@example.com', 'success');
      const before = await adminDb.githubCheckRun.findFirstOrThrow();
      const commentsBefore = await commentsOn(item.id);
      expect(commentsBefore).toHaveLength(1);

      const late = await githubWebhookService.handleEvent(
        'check_run',
        run({ conclusion: 'failure', startedAt: FIRST_START, completedAt: FIRST_FINISH }),
      );
      expect(late).toEqual({ event: 'ci', outcome: 'stale_terminal', workItemId: item.id });
      const rows = await adminDb.githubCheckRun.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        conclusion: 'success',
        conclusionAt: new Date(RERUN_FINISH),
      });
      expect(rows[0]!.updatedAt).toEqual(before.updatedAt); // nothing was written
      expect(await ciStateOf(item.id)).toBe('passing');
      // The comment the re-run wrote is neither rewritten nor joined by another.
      const commentsAfter = await commentsOn(item.id);
      expect(commentsAfter).toHaveLength(1);
      expect(commentsAfter[0]!.bodyMd).toBe(commentsBefore[0]!.bodyMd);
      expect(commentsAfter[0]!.updatedAt).toEqual(commentsBefore[0]!.updatedAt);
      expect(await feedbackRecords('sha1')).toHaveLength(1);
    });

    it('the first run’s late GREEN over a finished red re-run promotes nothing and keeps the card failing', async () => {
      const { item } = await rerunInFlight('finished-late-green@example.com');
      await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'implemented' } });
      await githubWebhookService.handleEvent(
        'check_run',
        run({ conclusion: 'failure', startedAt: RERUN_START, completedAt: RERUN_FINISH }),
      );
      expect(await ciStateOf(item.id)).toBe('failing');

      const late = await githubWebhookService.handleEvent(
        'check_run',
        run({ conclusion: 'success', startedAt: FIRST_START, completedAt: FIRST_FINISH }),
      );
      expect(late).toEqual({ event: 'ci', outcome: 'stale_terminal', workItemId: item.id });
      expect(late).not.toHaveProperty('promoted');
      expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
        { conclusion: 'failure', conclusionAt: new Date(RERUN_FINISH) },
      ]);
      expect(await ciStateOf(item.id)).toBe('failing');
      expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
        'implemented',
      );
    });

    it('a redelivery of the re-run’s own conclusion still converges, as today', async () => {
      const { item } = await rerunFinished('finished-redelivery@example.com', 'success');
      const again = await githubWebhookService.handleEvent(
        'check_run',
        run({ conclusion: 'success', startedAt: RERUN_START, completedAt: RERUN_FINISH }),
      );
      expect(again).toMatchObject({ outcome: 'noop', workItemId: item.id, ciState: 'passing' });
      expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
        { conclusion: 'success', conclusionAt: new Date(RERUN_FINISH) },
      ]);
      expect(await commentsOn(item.id)).toHaveLength(1);
    });

    it('a different conclusion at the SAME finish is a redelivery, and is written', async () => {
      // Equal finish times cannot be ordered against each other, so the tie keeps
      // last-write-wins — the behaviour the row had before this card.
      const { item } = await rerunFinished('finished-tie@example.com', 'success');
      const res = await githubWebhookService.handleEvent(
        'check_run',
        run({ conclusion: 'failure', startedAt: RERUN_START, completedAt: RERUN_FINISH }),
      );
      expect(res).toMatchObject({ outcome: 'failed', ciState: 'failing' });
      expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
        { conclusion: 'failure', conclusionAt: new Date(RERUN_FINISH) },
      ]);
      expect(await ciStateOf(item.id)).toBe('failing');
      expect(await commentsOn(item.id)).toHaveLength(1); // updated in place
    });

    it('a terminal row with no recorded time cannot be ordered, and keeps last-write-wins', async () => {
      const { item } = await rerunFinished('finished-untimed-row@example.com', 'success');
      // A row written before `conclusion_at` existed.
      await adminDb.githubCheckRun.updateMany({ data: { conclusionAt: null } });
      const res = await githubWebhookService.handleEvent(
        'check_run',
        run({ conclusion: 'failure', startedAt: FIRST_START, completedAt: FIRST_FINISH }),
      );
      expect(res).toMatchObject({ outcome: 'failed' });
      expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
        { conclusion: 'failure', conclusionAt: new Date(FIRST_FINISH) },
      ]);
      expect(await ciStateOf(item.id)).toBe('failing');
    });

    it('a terminal delivery with no time of its own over a finished row keeps last-write-wins', async () => {
      const { item } = await rerunFinished('finished-untimed-delivery@example.com', 'success');
      const res = await githubWebhookService.handleEvent(
        'check_run',
        run({ conclusion: 'failure', startedAt: FIRST_START }),
      );
      expect(res).toMatchObject({ outcome: 'failed' });
      expect(await adminDb.githubCheckRun.findMany()).toMatchObject([
        { conclusion: 'failure', conclusionAt: null },
      ]);
      expect(await ciStateOf(item.id)).toBe('failing');
    });

    it('a check_suite’s late `completed` is ordered by updated_at the same way', async () => {
      const s = await makeScenario('finished-suite@example.com');
      const item = await workItemsService.createWorkItem(
        { projectId: s.project.id, kind: 'task', title: 'A change' },
        s.ctx,
      );
      await openPr(item.identifier, 7);
      const suite = (o: { conclusion: string; updatedAt: string }) =>
        checkSuitePayload({ headSha: 'sha1', prNumbers: [7], suiteId: SUITE, ...o });
      const green = await githubWebhookService.handleEvent(
        'check_suite',
        suite({ conclusion: 'success', updatedAt: RERUN_FINISH }),
      );
      expect(green).toMatchObject({ outcome: 'verified' });

      const late = await githubWebhookService.handleEvent(
        'check_suite',
        suite({ conclusion: 'failure', updatedAt: FIRST_FINISH }),
      );
      expect(late).toMatchObject({ outcome: 'stale_terminal', workItemId: item.id });
      expect(await ciStateOf(item.id)).toBe('passing');
    });
  });
});
