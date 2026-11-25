import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { liveCheckRows, type SuiteScopedCheckRow } from '@/lib/github/checkSuites';
import { derivePrCiState } from '@/lib/github/prCiState';
import { prCiStateAtHead } from '@/lib/github/pullRequestHead';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-12200 — A RE-RUN OF A FAILED RUN MUST READ RUNNING, NOT FAILING.
//
// Re-run attempts share one check suite (MOTIR-11827). When attempt 1 fails,
// GitHub completes the suite red and the `check_suite` parse records the roll-up
// row (`github-actions`, `suiteAggregate`) as `failure`. When attempt 2 starts,
// the `check_run` arm reopens the re-run job's row as `pending` — but GitHub
// sends `check_suite` `requested` / `rerequested` only to the App that owns the
// suite, so nothing reopens the roll-up. Failure outranks pending in the fold, so
// the pull request read "Checks failing" for the whole re-run.
//
// Observed on motir-infra#167 @ `e159b6e3`, run 45511434917, suite 123146961591:
// attempt 1's `checks` cancelled at 23:50:53 (suite completed red at 23:50:55),
// attempt 2's `checks` in progress from 23:52:29, and Motir served `failing`.
//
// The fix is the attempt rule's red arm: a `failure` roll-up older than a check
// row of its own suite describes an attempt that has been replaced, and does not
// vote. Pure half over `liveCheckRows` / `derivePrCiState`, then the webhook
// replay through real Postgres for the card's stored `ciState`.

// ── the pure half ────────────────────────────────────────────────────────────

const SUITE = '123146961591';
const CODEQL = '123146961600';

function at(hhmmss: string): Date {
  return new Date(`2026-11-24T${hhmmss}Z`);
}

type Row = SuiteScopedCheckRow & { commitSha: string; createdAt: Date };

function row(
  checkName: string,
  conclusion: string,
  conclusionAt: Date | null,
  checkSuiteId = SUITE,
): Row {
  return {
    checkName,
    conclusion,
    conclusionAt,
    checkSuiteId,
    commitSha: 'e159b6e3',
    createdAt: at('23:40:00'),
  };
}

function rollUp(conclusion: string, conclusionAt: Date | null, checkSuiteId = SUITE): Row {
  return { ...row('github-actions', conclusion, conclusionAt, checkSuiteId), suiteAggregate: true };
}

/** motir-infra#167's rows at 00:02: the re-run's `checks` reopened as pending,
 *  attempt 1's red roll-up still on its row. */
function the167Rows(): Row[] {
  return [row('checks', 'pending', at('23:52:29')), rollUp('failure', at('23:50:55'))];
}

describe('liveCheckRows — a red roll-up a newer attempt replaced (MOTIR-12200)', () => {
  it('AC 1 — the motir-infra#167 rows read RUNNING while the re-run runs', () => {
    const rows = the167Rows();
    expect(liveCheckRows(rows).map((r) => r.checkName)).toEqual(['checks']);
    expect(derivePrCiState(rows)).toBe('running');
    expect(prCiStateAtHead({ headSha: 'e159b6e3', checkRuns: rows })).toBe('running');
  });

  it('a red roll-up that is NEWER than the pending row still votes (the defect’s shape when it was live)', () => {
    // Before MOTIR-12200 every red roll-up voted regardless of time, which is
    // what this shape still does: the pending row predates the roll-up, so it is
    // not a newer attempt.
    const rows = [row('checks', 'pending', at('23:52:29')), rollUp('failure', at('23:59:59'))];
    expect(derivePrCiState(rows)).toBe('failing');
  });

  it('AC 2 — a check that failed AFTER the roll-up is the current attempt, and reads failing', () => {
    const rows = [...the167Rows(), row('diff', 'failure', at('23:58:00'))];
    expect(derivePrCiState(rows)).toBe('failing');
    expect(liveCheckRows(rows).map((r) => r.checkName)).toEqual(['checks', 'diff']);
  });

  it('AC 2 — a red roll-up with no newer row in its suite still votes', () => {
    const rows = [
      row('checks', 'failure', at('23:50:53')),
      row('diff', 'neutral', at('23:50:53')),
      rollUp('failure', at('23:50:55')),
    ];
    expect(liveCheckRows(rows)).toEqual(rows);
    expect(derivePrCiState(rows)).toBe('failing');
    // Only the roll-up recorded (no check of its own ever arrived): still red.
    expect(derivePrCiState([rollUp('failure', at('23:50:55'))])).toBe('failing');
  });

  it('a check at the SAME instant as the roll-up is not newer, so the roll-up keeps its vote', () => {
    const rows = [row('checks', 'success', at('23:50:55')), rollUp('failure', at('23:50:55'))];
    expect(derivePrCiState(rows)).toBe('failing');
  });

  it('AC 3 — a CI re-run never retires another workflow’s red roll-up at the commit', () => {
    const rows = [
      ...the167Rows(),
      row('Analyze (actions)', 'failure', at('23:45:00'), CODEQL),
      rollUp('failure', at('23:45:05'), CODEQL),
    ];
    const live = liveCheckRows(rows);
    expect(live.filter((r) => r.checkSuiteId === CODEQL)).toHaveLength(2);
    expect(live.some((r) => r.checkSuiteId === SUITE && r.suiteAggregate === true)).toBe(false);
    expect(derivePrCiState(rows)).toBe('failing');
  });

  it('AC 3 — a CodeQL roll-up alone, older than CI’s re-run, is still red', () => {
    // The other workflow recorded only its roll-up; a newer check in CI's suite
    // says nothing about it.
    const rows = [...the167Rows(), rollUp('failure', at('23:45:05'), CODEQL)];
    expect(derivePrCiState(rows)).toBe('failing');
  });

  it('the cancelled attempt’s other failures keep their own vote', () => {
    // A failure row of attempt 1 the re-run has not re-reported is still live:
    // only the roll-up is retired, never the checks it summarised.
    const rows = [row('Vitest (${{ matrix.leg }}/3)', 'failure', at('23:50:53')), ...the167Rows()];
    expect(liveCheckRows(rows).map((r) => r.checkName)).toEqual([
      'Vitest (${{ matrix.leg }}/3)',
      'checks',
    ]);
    expect(derivePrCiState(rows)).toBe('failing');
  });

  it('rows that cannot be ordered never retire a red roll-up', () => {
    expect(
      derivePrCiState([row('checks', 'pending', null), rollUp('failure', at('23:50:55'))]),
    ).toBe('failing');
    expect(
      derivePrCiState([row('checks', 'pending', at('23:52:29')), rollUp('failure', null)]),
    ).toBe('failing');
    // No suite identity: one group that supersedes nothing (MOTIR-3209).
    expect(
      derivePrCiState([
        row('checks', 'pending', at('23:52:29'), ''),
        rollUp('failure', at('23:50:55'), ''),
      ]),
    ).toBe('failing');
  });

  it('a green roll-up is left to the green arm — a newer pending check reads running', () => {
    const rows = [row('checks', 'pending', at('23:52:29')), rollUp('success', at('23:50:55'))];
    expect(liveCheckRows(rows)).toEqual(rows);
    expect(derivePrCiState(rows)).toBe('running');
  });

  it('both arms in one suite: a re-run after a green attempt that went red again', () => {
    // attempt 1 red (roll-up 10:00), attempt 2 green (roll-up 11:00) retiring the
    // attempt-1 failure, attempt 3 running from 11:30.
    const rows = [
      row('E2E', 'failure', at('09:59:00')),
      rollUp('failure', at('10:00:00')),
      row('TypeScript', 'success', at('10:50:00')),
      rollUp('success', at('11:00:00')),
      row('E2E', 'pending', at('11:30:00')),
    ];
    expect(derivePrCiState(rows)).toBe('running');
    expect(liveCheckRows(rows).some((r) => r.conclusion === 'failure')).toBe(false);
  });
});

// ── the Postgres half ────────────────────────────────────────────────────────

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci-rerun-red-rollup';
const REPO_PROVIDER_ID = '167';
const SHA = 'e159b6e3';
const ENVELOPE = {
  installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
  repository: { id: Number(REPO_PROVIDER_ID) },
};

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
        name: 'infra',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

async function cardWithPr(s: Awaited<ReturnType<typeof makeScenario>>, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'A change' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-work`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'infra',
    number,
    headRef,
    title: 'A change',
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    ...ENVELOPE,
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: 'A change',
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  return item;
}

/** One `check_run` delivery of the suite, dated as GitHub dates it: a pending
 *  run by its start, a finished one by its finish. */
function checkRun(
  prNumber: number,
  name: string,
  conclusion: string | null,
  time: string,
  status = 'completed',
) {
  return githubWebhookService.handleEvent('check_run', {
    action: status === 'completed' ? 'completed' : 'created',
    ...ENVELOPE,
    check_run: {
      head_sha: SHA,
      status,
      conclusion,
      name,
      started_at: `2026-11-24T${time}Z`,
      completed_at: status === 'completed' ? `2026-11-24T${time}Z` : null,
      check_suite: { id: Number(SUITE), head_branch: null },
      pull_requests: [{ number: prNumber }],
    },
  });
}

/** The suite's `completed` delivery — the only `check_suite` action a
 *  non-owning App receives. */
function suiteCompleted(prNumber: number, conclusion: string, time: string) {
  return githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    ...ENVELOPE,
    check_suite: {
      id: Number(SUITE),
      head_sha: SHA,
      head_branch: null,
      status: 'completed',
      conclusion,
      updated_at: `2026-11-24T${time}Z`,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: prNumber }],
    },
  });
}

/** Attempt 1 of motir-infra#167's run: `checks` cancelled, `diff` skipped, the
 *  suite completed red. */
async function cancelledAttempt(pr: number) {
  await checkRun(pr, 'checks', null, '23:40:00', 'in_progress');
  await checkRun(pr, 'checks', 'cancelled', '23:50:53');
  await checkRun(pr, 'diff', 'skipped', '23:50:54');
  await suiteCompleted(pr, 'failure', '23:50:55');
}

async function cardOf(id: string) {
  return (await adminDb.workItem.findUnique({ where: { id } }))!;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('replaying motir-infra#167 through the webhook (MOTIR-12200)', () => {
  it('AC 1 — the re-run’s pending delivery moves the stored ciState to running', async () => {
    const s = await makeScenario('rerun-red-running@example.com');
    const item = await cardWithPr(s, 167);

    await cancelledAttempt(167);
    expect((await cardOf(item.id)).ciState).toBe('failing');

    await checkRun(167, 'checks', null, '23:52:29', 'in_progress');
    expect((await cardOf(item.id)).ciState).toBe('running');

    const rows = await adminDb.githubCheckRun.findMany();
    // The red roll-up is still on disk — the webhook never reopens it — and
    // simply no longer votes.
    expect(rows.find((r) => r.suiteAggregate)!.conclusion).toBe('failure');
    expect(derivePrCiState(rows)).toBe('running');
  });

  it('AC 2 — the re-run failing again reads failing once more', async () => {
    const s = await makeScenario('rerun-red-again@example.com');
    const item = await cardWithPr(s, 168);

    await cancelledAttempt(168);
    await checkRun(168, 'checks', null, '23:52:29', 'in_progress');
    await checkRun(168, 'checks', 'failure', '23:58:00');
    expect((await cardOf(item.id)).ciState).toBe('failing');

    await suiteCompleted(168, 'failure', '23:58:02');
    expect((await cardOf(item.id)).ciState).toBe('failing');
  });

  it('the re-run going green reads passing', async () => {
    const s = await makeScenario('rerun-red-green@example.com');
    const item = await cardWithPr(s, 169);

    await cancelledAttempt(169);
    await checkRun(169, 'checks', null, '23:52:29', 'in_progress');
    await checkRun(169, 'checks', 'success', '23:58:00');
    await checkRun(169, 'diff', 'success', '23:58:30');
    await suiteCompleted(169, 'success', '23:58:32');
    expect((await cardOf(item.id)).ciState).toBe('passing');
  });
});
