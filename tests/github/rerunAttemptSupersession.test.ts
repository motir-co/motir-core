import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { liveCheckRows, type SuiteScopedCheckRow } from '@/lib/github/checkSuites';
import { derivePrCiState } from '@/lib/github/prCiState';
import { lastDecidedBeforeHead, prCiStateAtHead } from '@/lib/github/pullRequestHead';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-11827 — A RE-RUN ATTEMPT SHARES ITS SUITE, SO A GREEN RE-RUN MUST RETIRE
// THE CANCELLED ATTEMPT'S FAILURES.
//
// GitHub keeps every attempt of one workflow run ("Re-run jobs", "Re-run failed
// jobs") under ONE `check_suite.id`. MOTIR-3209 supersedes by suite, so on
// motir-core#4353 @ `b50389ac` (CI run 44542390691, suite 120570907095) the
// attempt-1 rows — cancelled at 14:19 before the matrix expanded, `cancelled` →
// `failure` — stayed live after attempt 3 went green at 15:12:
//
//  * the template-named matrix rows (`Vitest (${{ matrix.leg }}/20)`) are never
//    re-reported under that name;
//  * the gated jobs (`CLI package`, …) are SKIPPED by the later attempts, and a
//    skipped delivery was dropped before it reached the row.
//
// The fix reads the suite's own roll-up (a GREEN roll-up retires every failure in
// its suite that finished no later than it did) and lets a timed `skipped`
// delivery settle the older row at its key. Real Postgres, the real webhook
// service, the real provider seam; the pure half drives `liveCheckRows` directly.

// ── the pure half ────────────────────────────────────────────────────────────

const CI = '120570907095';
const CODEQL = '120570907100';

function at(hhmmss: string): Date {
  return new Date(`2026-11-19T${hhmmss}Z`);
}

type Row = SuiteScopedCheckRow & { commitSha: string; createdAt: Date };

function row(
  checkName: string,
  conclusion: string,
  conclusionAt: Date | null,
  checkSuiteId = CI,
): Row {
  return {
    checkName,
    conclusion,
    conclusionAt,
    checkSuiteId,
    commitSha: 'b50389ac',
    createdAt: at('14:10:00'),
  };
}

function rollUp(conclusion: string, conclusionAt: Date | null, checkSuiteId = CI): Row {
  return { ...row('github-actions', conclusion, conclusionAt, checkSuiteId), suiteAggregate: true };
}

/** #4353's rows as they stood with only the ROLL-UP rule to clear them: the
 *  attempt-1 failures (the matrix templates and the gated job, which nothing
 *  re-reports under that name), attempt 3's greens, and the green roll-up. */
function the4353Rows(): Row[] {
  return [
    row('Vitest (${{ matrix.leg }}/20)', 'failure', at('14:19:37')),
    row('Playwright E2E (${{ matrix.id }})', 'failure', at('14:19:37')),
    row('CLI package', 'failure', at('14:19:37')),
    row('TypeScript', 'success', at('14:58:00')),
    row('Vitest (1/20)', 'success', at('15:00:00')),
    row('Playwright E2E (3)', 'success', at('15:10:00')),
    row('CI complete', 'success', at('15:12:00')),
    rollUp('success', at('15:12:10')),
  ];
}

describe('liveCheckRows — an earlier ATTEMPT inside one suite (MOTIR-11827)', () => {
  it('a green roll-up retires every failure in its suite that finished before it', () => {
    const live = liveCheckRows(the4353Rows());
    expect(live.filter((r) => r.conclusion === 'failure')).toEqual([]);
    expect(live.map((r) => r.checkName)).not.toContain('CLI package');
    expect(derivePrCiState(the4353Rows())).toBe('passing');
    expect(prCiStateAtHead({ headSha: 'b50389ac', checkRuns: the4353Rows() })).toBe('passing');
  });

  it('reproduces the defect: without the roll-up the cancelled attempt still votes', () => {
    const rows = the4353Rows().filter((r) => r.suiteAggregate !== true);
    expect(derivePrCiState(rows)).toBe('failing');
  });

  it('names no failing check for the commit once it is no longer the head', () => {
    const later = { ...row('TypeScript', 'success', at('16:00:00')), commitSha: 'c0ffee00' };
    const decided = lastDecidedBeforeHead({
      headSha: 'c0ffee00',
      checkRuns: [...the4353Rows(), { ...later, createdAt: at('16:00:00') }],
    });
    expect(decided).toMatchObject({ commitSha: 'b50389ac', red: false, failingChecks: [] });
  });

  it('a failure that finished AFTER the green roll-up is a newer attempt and still votes', () => {
    const rows = [...the4353Rows(), row('Playwright E2E (3)', 'failure', at('17:30:00'))];
    // The same key twice only happens in a hand-built fixture; what matters is the
    // later failure is not retired by the older green.
    expect(liveCheckRows(rows).some((r) => r.conclusion === 'failure')).toBe(true);
    expect(derivePrCiState(rows)).toBe('failing');
  });

  it('a red or pending roll-up retires nothing', () => {
    for (const conclusion of ['failure', 'pending']) {
      const rows = [
        row('Vitest (${{ matrix.leg }}/20)', 'failure', at('14:19:37')),
        row('TypeScript', 'success', at('14:58:00')),
        rollUp(conclusion, at('15:12:10')),
      ];
      expect(liveCheckRows(rows)).toEqual(rows);
    }
  });

  it('a row or a roll-up with no time cannot be ordered, so the failure keeps its vote', () => {
    const untimedRow = [row('CLI package', 'failure', null), rollUp('success', at('15:12:10'))];
    expect(derivePrCiState(untimedRow)).toBe('failing');
    const untimedRollUp = [row('CLI package', 'failure', at('14:19:37')), rollUp('success', null)];
    expect(derivePrCiState(untimedRollUp)).toBe('failing');
  });

  it('a roll-up speaks for its own suite only — CI’s green never retires CodeQL’s red', () => {
    const rows = [
      ...the4353Rows(),
      row('Analyze (javascript-typescript)', 'failure', at('14:30:00'), CODEQL),
      rollUp('failure', at('14:30:05'), CODEQL),
    ];
    const live = liveCheckRows(rows);
    expect(
      live
        .filter((r) => r.conclusion === 'failure' && r.suiteAggregate !== true)
        .map((r) => r.checkName),
    ).toEqual(['Analyze (javascript-typescript)']);
    expect(derivePrCiState(rows)).toBe('failing');
  });

  it('rows with no suite identity are never retired by a roll-up', () => {
    const rows = [
      row('license/cla', 'failure', at('14:00:00'), ''),
      rollUp('success', at('15:12:10')),
    ];
    expect(liveCheckRows(rows)).toEqual(rows);
  });
});

describe('liveCheckRows — the edges of the attempt rule (MOTIR-11827)', () => {
  it('an empty set is returned as it came', () => {
    expect(liveCheckRows([])).toEqual([]);
  });

  it('two green roll-ups for one suite: the LATER green is the one that orders', () => {
    const rows = [
      row('Vitest (${{ matrix.leg }}/20)', 'failure', at('14:19:37')),
      row('Playwright E2E (3)', 'failure', at('15:30:00')),
      rollUp('success', at('15:40:00')),
      rollUp('success', at('15:12:10')),
    ];
    expect(liveCheckRows(rows).filter((r) => r.conclusion === 'failure')).toEqual([]);
  });

  it('a roll-up with no suite identity orders nothing', () => {
    const rows = [
      row('Vitest', 'failure', at('14:19:37'), ''),
      rollUp('success', at('15:12:10'), ''),
    ];
    expect(derivePrCiState(rows)).toBe('failing');
  });

  it('a non-numeric suite id still orders runs deterministically (the fallback tier)', () => {
    const rows = [
      row('TypeScript', 'failure', at('14:00:00'), 'run-a'),
      row('TypeScript', 'success', at('14:30:00'), 'run-b'),
    ];
    expect(liveCheckRows(rows).map((r) => r.checkSuiteId)).toEqual(['run-b']);
    expect(liveCheckRows([...rows].reverse()).map((r) => r.checkSuiteId)).toEqual(['run-b']);
  });
});

// ── the Postgres half ────────────────────────────────────────────────────────

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci-rerun-attempt';
const REPO_PROVIDER_ID = '4353';
const SHA = 'b50389ac';
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
        name: 'acme',
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
    name: 'acme',
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

/** One `check_run` delivery of CI's suite, dated as GitHub dates it: a pending
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
      started_at: `2026-11-19T${time}Z`,
      completed_at: status === 'completed' ? `2026-11-19T${time}Z` : null,
      check_suite: { id: Number(CI), head_branch: null },
      pull_requests: [{ number: prNumber }],
    },
  });
}

/** The suite's own roll-up — the `check_suite` `completed` delivery each attempt ends with. */
function suiteCompleted(prNumber: number, conclusion: string, time: string) {
  return githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    ...ENVELOPE,
    check_suite: {
      id: Number(CI),
      head_sha: SHA,
      head_branch: null,
      status: 'completed',
      conclusion,
      updated_at: `2026-11-19T${time}Z`,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: prNumber }],
    },
  });
}

/** Attempts 1 and 2 of #4353's CI run: a cancelled attempt before the matrix
 *  expanded, then a red one (the admin-jobs-columns flake). */
async function cancelledThenRed(pr: number) {
  for (const name of [
    'TypeScript',
    'Vitest (${{ matrix.leg }}/20)',
    'Playwright E2E (${{ matrix.id }})',
    'CLI package',
  ]) {
    await checkRun(pr, name, 'cancelled', '14:19:37');
  }
  await checkRun(pr, 'CI complete', 'failure', '14:19:38');
  await suiteCompleted(pr, 'cancelled', '14:19:40');

  await checkRun(pr, 'TypeScript', null, '14:22:00', 'in_progress');
  await checkRun(pr, 'CLI package', 'skipped', '14:22:05');
  await checkRun(pr, 'TypeScript', 'success', '14:30:00');
  await checkRun(pr, 'Vitest (1/20)', 'success', '14:40:00');
  await checkRun(pr, 'Playwright E2E (3)', 'failure', '14:52:00');
  await checkRun(pr, 'CI complete', 'failure', '14:52:30');
  await suiteCompleted(pr, 'failure', '14:52:40');
}

/** Attempt 3: every job re-run, the gated job skipped again, and the run's
 *  `Playwright E2E (3)` leg ending with `e2eConclusion`. */
async function attemptThree(pr: number, e2eConclusion: 'success' | 'failure') {
  for (const name of ['TypeScript', 'Vitest (1/20)', 'Playwright E2E (3)', 'CI complete']) {
    await checkRun(pr, name, null, '14:53:00', 'in_progress');
  }
  await checkRun(pr, 'CLI package', 'skipped', '14:53:05');
  await checkRun(pr, 'TypeScript', 'success', '14:58:00');
  await checkRun(pr, 'Vitest (1/20)', 'success', '15:00:00');
  await checkRun(pr, 'Playwright E2E (3)', e2eConclusion, '15:10:00');
  await checkRun(pr, 'CI complete', e2eConclusion, '15:12:00');
  return suiteCompleted(pr, e2eConclusion, '15:12:10');
}

async function storedRows() {
  return adminDb.githubCheckRun.findMany({ orderBy: { createdAt: 'asc' } });
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

describe('replaying motir-core#4353 through the webhook (MOTIR-11827)', () => {
  it('AC 1 — a green third attempt reads PASSING, with no failing check left', async () => {
    const s = await makeScenario('rerun-pass@example.com');
    const item = await cardWithPr(s, 4353);

    await cancelledThenRed(4353);
    expect((await cardOf(item.id)).ciState).toBe('failing');

    const last = await attemptThree(4353, 'success');
    expect(last).toMatchObject({ ciState: 'passing' });
    expect((await cardOf(item.id)).ciState).toBe('passing');
    expect((await cardOf(item.id)).status).toBe('in_review');

    const rows = await storedRows();
    expect(derivePrCiState(rows)).toBe('passing');
    expect(liveCheckRows(rows).filter((r) => r.conclusion === 'failure')).toEqual([]);
    // The cancelled attempt's rows are still on disk — history — and simply no
    // longer vote. The skipped job's row was SETTLED by the skip, not left red.
    expect(rows.some((r) => r.checkName === 'Vitest (${{ matrix.leg }}/20)')).toBe(true);
    expect(rows.find((r) => r.checkName === 'CLI package')!.conclusion).toBe('neutral');

    const comments = await adminDb.comment.findMany({ where: { workItemId: item.id } });
    const body = comments.at(-1)!.bodyMd;
    expect(body).toContain('✅');
    expect(body).not.toContain('${{');
  });

  it('AC 2 — the repair claim on that card answers not_failing', async () => {
    const s = await makeScenario('rerun-repair@example.com');
    const item = await cardWithPr(s, 4354);

    await cancelledThenRed(4354);
    await attemptThree(4354, 'success');

    expect(
      await workItemRepairService.claimRepair(s.project.id, item.identifier, s.ctx),
    ).toMatchObject({ outcome: 'not_repairable', reason: 'not_failing' });
  });

  it('AC 3 — a genuine red in the newest attempt still reads failing', async () => {
    const s = await makeScenario('rerun-red@example.com');
    const item = await cardWithPr(s, 4355);

    await cancelledThenRed(4355);
    const last = await attemptThree(4355, 'failure');

    expect(last).toMatchObject({ ciState: 'failing' });
    expect((await cardOf(item.id)).ciState).toBe('failing');
    expect((await cardOf(item.id)).status).toBe('implemented');
  });
});

describe('a skipped delivery at a key that already holds a verdict (MOTIR-11827)', () => {
  it('settles an OLDER failure, and re-derives the verdict', async () => {
    const s = await makeScenario('skip-settles@example.com');
    const item = await cardWithPr(s, 31);

    await checkRun(31, 'Deploy', 'cancelled', '10:00:00');
    await checkRun(31, 'TypeScript', 'success', '10:05:00');
    expect((await cardOf(item.id)).ciState).toBe('failing');

    const skipped = await checkRun(31, 'Deploy', 'skipped', '10:20:00');
    expect(skipped).toMatchObject({ outcome: 'neutral_settled', ciState: 'passing' });
    expect((await cardOf(item.id)).ciState).toBe('passing');
  });

  it('is refused when it is OLDER than the verdict the row holds — a late delivery', async () => {
    const s = await makeScenario('skip-late@example.com');
    await cardWithPr(s, 32);

    await checkRun(32, 'Deploy', 'failure', '10:20:00');
    const late = await checkRun(32, 'Deploy', 'skipped', '10:00:00');

    expect(late).toMatchObject({ outcome: 'ignored_pending' });
    expect((await storedRows())[0]!.conclusion).toBe('failure');
  });

  it('creates nothing when no row is at its key, and nothing without a time', async () => {
    const s = await makeScenario('skip-nothing@example.com');
    await cardWithPr(s, 33);

    expect(await checkRun(33, 'Deploy', 'skipped', '10:00:00')).toMatchObject({
      outcome: 'ignored_pending',
    });
    expect(await storedRows()).toHaveLength(0);

    await checkRun(33, 'Deploy', 'cancelled', '10:00:00');
    const untimed = await githubWebhookService.handleEvent('check_run', {
      action: 'completed',
      ...ENVELOPE,
      check_run: {
        head_sha: SHA,
        status: 'completed',
        conclusion: 'skipped',
        name: 'Deploy',
        check_suite: { id: Number(CI), head_branch: null },
        pull_requests: [{ number: 33 }],
      },
    });
    expect(untimed).toMatchObject({ outcome: 'ignored_pending' });
    expect((await storedRows())[0]!.conclusion).toBe('failure');
  });

  it('a redelivered skip over a row it already settled is a no-op', async () => {
    const s = await makeScenario('skip-again@example.com');
    await cardWithPr(s, 34);

    await checkRun(34, 'Deploy', 'cancelled', '10:00:00');
    await checkRun(34, 'Deploy', 'skipped', '10:20:00');
    expect(await checkRun(34, 'Deploy', 'skipped', '10:20:00')).toMatchObject({
      outcome: 'ignored_pending',
    });
  });
});
