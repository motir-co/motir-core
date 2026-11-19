import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { summarizeChecks } from '@/lib/services/changeRequestCiFeedback';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { derivePrCiState } from '@/lib/github/prCiState';
import { liveCheckRows } from '@/lib/github/checkSuites';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import {
  ACCEPTANCE_RUNS,
  ACCEPTANCE_SUITE,
  ADVANCED_SECURITY_RUNS,
  ADVANCED_SECURITY_SUITE,
  CI_RUNS,
  CI_SUITE,
  CODEQL_RUNS,
  CODEQL_SUITE,
  type FixtureConclusion,
} from './fixtures/pr3112CheckRuns';

// MOTIR-6274 — EVERY GITHUB ACTIONS WORKFLOW SHARES ONE ROLL-UP NAME, AND THAT
// NAME MUST NOT MAKE ONE WORKFLOW A "RE-RUN" OF ANOTHER.
//
// `liveCheckRows` (MOTIR-3209) reconstructs "same workflow" from a SHARED CHECK
// NAME, on the stated premise that "a CI run and a CodeQL run share nothing".
// They share one row: a `check_suite` event is recorded under the App slug, and
// every Actions workflow is the `github-actions` App. So on motir-core#3112 the
// newest Actions suite (CI) retired CodeQL's and the acceptance lane's suites
// wholesale, and the feedback comment read "4 of 43 checks" over a commit the
// host holds 46 check runs for.
//
// The fix marks the roll-up row (`suiteAggregate`) at ingestion and leaves it
// out of the shared-name test. The pure half below runs the fold over the
// REAL recorded set of #3112 (ids and names read from the host); the Postgres
// half drives the webhook service end to end.

type Row = {
  checkName: string;
  checkSuiteId: string;
  conclusion: FixtureConclusion;
  conclusionAt: Date | null;
  suiteAggregate?: boolean;
};

/** One Actions suite as ingestion records it: its check runs, plus the
 *  `check_suite` roll-up named by the App slug. */
function actionsSuite(
  suiteId: string,
  runs: [string, FixtureConclusion][],
  rollUp: FixtureConclusion,
): Row[] {
  return [
    ...runs.map(([checkName, conclusion]) => ({
      checkName,
      checkSuiteId: suiteId,
      conclusion,
      conclusionAt: null,
    })),
    {
      checkName: 'github-actions',
      checkSuiteId: suiteId,
      conclusion: rollUp,
      conclusionAt: null,
      suiteAggregate: true,
    },
  ];
}

/** #3112's recorded set at `88508fb2`: the three Actions suites with their
 *  roll-ups, the advanced-security suite's one run, and `license/cla` (a
 *  commit status — no suite identity). `ids` lets a test re-mint the three
 *  Actions suite ids in another order. */
function recordedSet(
  ids = { codeql: CODEQL_SUITE, acceptance: ACCEPTANCE_SUITE, ci: CI_SUITE },
): Row[] {
  return [
    ...actionsSuite(ids.codeql, CODEQL_RUNS, 'success'),
    ...actionsSuite(ids.acceptance, ACCEPTANCE_RUNS, 'success'),
    ...actionsSuite(ids.ci, CI_RUNS, 'failure'),
    ...ADVANCED_SECURITY_RUNS.map(([checkName, conclusion]) => ({
      checkName,
      checkSuiteId: ADVANCED_SECURITY_SUITE,
      conclusion,
      conclusionAt: null,
    })),
    {
      checkName: 'license/cla',
      checkSuiteId: '',
      conclusion: 'success' as const,
      conclusionAt: null,
    },
  ];
}

/** The same rows as they read before the column existed — no roll-up marked. */
function unmarked(rows: Row[]): Row[] {
  return rows.map(({ suiteAggregate: _dropped, ...rest }) => rest);
}

function suitesOf(rows: Row[]): string[] {
  return [...new Set(rows.map((r) => r.checkSuiteId))].sort();
}

describe('the fold over motir-core#3112 — every Actions workflow keeps its vote (MOTIR-6274)', () => {
  it('reproduces the defect: read the old way, the newest Actions suite retires the other two', () => {
    // The unmarked reading IS the rule before this fix, and it reproduces the
    // production count to the row: "4 of 43 checks did not pass".
    const live = liveCheckRows(unmarked(recordedSet()));

    expect(suitesOf(live)).toEqual(['', CI_SUITE, ADVANCED_SECURITY_SUITE].sort());
    const summary = summarizeChecks(live);
    expect(summary.total).toBe(43);
    expect(summary.failed).toHaveLength(4);
  });

  it('keeps CI, CodeQL AND the acceptance lane — every row of every suite still votes', () => {
    const rows = recordedSet();
    const live = liveCheckRows(rows);

    expect(live).toEqual(rows);
    expect(suitesOf(live)).toEqual(
      ['', CODEQL_SUITE, ACCEPTANCE_SUITE, CI_SUITE, ADVANCED_SECURITY_SUITE].sort(),
    );
  });

  it('counts the whole recorded set — 50 rows, 46 of them check runs — re-derived, not quoted', () => {
    // 46 check runs (1 + 4 + 40 + 1, the host's own total), the three Actions
    // roll-ups, and `license/cla`. The card's "45" counted the three Actions
    // suites' runs only; the advanced-security run was never retired either way.
    const live = liveCheckRows(recordedSet());
    const checkRuns = live.filter((r) => r.checkSuiteId !== '' && r.suiteAggregate !== true);

    expect(checkRuns).toHaveLength(46);
    expect(live.filter((r) => r.suiteAggregate === true)).toHaveLength(3);
    expect(summarizeChecks(live).total).toBe(50);
    // The verdict is still CI's red — the fix widens the set, it does not soften it.
    expect(
      derivePrCiState(live.map((r) => ({ ...r, commitSha: 'x', createdAt: new Date(0) }))),
    ).toBe('failing');
  });

  it('holds whichever order GitHub minted the three suite ids in', () => {
    // Supersession is ordered by suite id, so under the old rule WHICH workflow
    // survived depended on the order the host created the suites. Every
    // permutation of #3112's three ids must keep all three.
    const ids = [CODEQL_SUITE, ACCEPTANCE_SUITE, CI_SUITE];
    const permutations: [number, number, number][] = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const [a, b, c] of permutations) {
      const rows = recordedSet({ codeql: ids[a]!, acceptance: ids[b]!, ci: ids[c]! });
      expect(liveCheckRows(rows)).toHaveLength(rows.length);
      // …and the old rule really was order-dependent: the survivor is whichever
      // Actions suite got the highest id.
      const oldSurvivors = suitesOf(liveCheckRows(unmarked(rows))).filter(
        (id) => id !== '' && id !== ADVANCED_SECURITY_SUITE,
      );
      expect(oldSurvivors).toEqual([CI_SUITE]);
    }
  });
});

describe("MOTIR-3209's own case still holds — a real re-run retires the run it replaced", () => {
  // PR #2192's ids: two CI runs, the first cancelled before its matrix expanded.
  const CANCELLED = '87626130152';
  const WINNER = '87626227873';
  const CODEQL = '87626129473';

  function twoCiRunsAndCodeql(): Row[] {
    return [
      ...actionsSuite(
        CANCELLED,
        [
          ['TypeScript', 'failure'],
          ['Vitest (${{ matrix.shard }}/${{ matrix.total }})', 'failure'],
          ['Deploy to Fly', 'failure'],
        ],
        'failure',
      ),
      ...actionsSuite(CODEQL, [['Analyze (javascript-typescript)', 'success']], 'success'),
      ...actionsSuite(
        WINNER,
        [
          ['TypeScript', 'success'],
          ['Vitest (1/3)', 'success'],
        ],
        'success',
      ),
    ];
  }

  it('retires the cancelled run WHOLE — template leg, cancelled deploy and its roll-up', () => {
    const live = liveCheckRows(twoCiRunsAndCodeql());

    expect(suitesOf(live)).toEqual([CODEQL, WINNER].sort());
    expect(live.some((r) => r.checkName.includes('${{'))).toBe(false);
    expect(live.some((r) => r.checkName === 'Deploy to Fly')).toBe(false);
    expect(live.every((r) => r.conclusion === 'success')).toBe(true);
  });

  it('a suite whose only row is its roll-up is not retired by a newer suite of the same App', () => {
    // The residue this fix names in `checkSuites.ts`: with no check of its own,
    // the suite cannot be told apart from a different workflow — so it keeps
    // its vote rather than risk discarding a workflow.
    const rows: Row[] = [
      ...actionsSuite('100', [], 'failure'),
      ...actionsSuite('200', [['TypeScript', 'success']], 'success'),
    ];
    expect(suitesOf(liveCheckRows(rows))).toEqual(['100', '200']);
  });
});

describe('the rows the roll-up rule does NOT touch', () => {
  it('a row with no suite identity supersedes nothing and is superseded by nothing', () => {
    const rows: Row[] = [
      { checkName: 'license/cla', checkSuiteId: '', conclusion: 'failure', conclusionAt: null },
      ...actionsSuite('1', [['TypeScript', 'failure']], 'failure'),
      ...actionsSuite('2', [['TypeScript', 'success']], 'success'),
    ];
    const live = liveCheckRows(rows);

    expect(live.find((r) => r.checkName === 'license/cla')).toBeDefined();
    expect(suitesOf(live)).toEqual(['', '2']);
  });

  it('a GitLab pipeline row is NOT a roll-up — its shared `pipeline` name still retires the retried pipeline', () => {
    const rows: Row[] = [
      { checkName: 'pipeline', checkSuiteId: '501', conclusion: 'failure', conclusionAt: null },
      { checkName: 'pipeline', checkSuiteId: '502', conclusion: 'success', conclusionAt: null },
    ];
    expect(liveCheckRows(rows)).toEqual([rows[1]]);
  });
});

// ── End to end: the webhook marks the roll-up, and the verdict keeps CodeQL ──

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-actions-suites';
const REPO_PROVIDER_ID = '6274';
const SHA = '88508fb2';

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
    title: `A change (${headRef})`,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
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
  return item;
}

const envelope = {
  installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
  repository: { id: Number(REPO_PROVIDER_ID) },
};

function checkRun(name: string, conclusion: string, suiteId: string, prNumber: number) {
  return githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    ...envelope,
    check_run: {
      head_sha: SHA,
      status: 'completed',
      conclusion,
      name,
      check_suite: { id: Number(suiteId), head_branch: null },
      pull_requests: [{ number: prNumber }],
    },
  });
}

function checkSuite(conclusion: string, suiteId: string, prNumber: number) {
  return githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    ...envelope,
    check_suite: {
      id: Number(suiteId),
      head_sha: SHA,
      head_branch: null,
      status: 'completed',
      conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: prNumber }],
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('ingestion marks the roll-up, and a newer CI suite no longer hides CodeQL', () => {
  it('records a `check_suite` row as the roll-up and a `check_run` row as a check', async () => {
    const s = await makeScenario('actions-mark@example.com');
    await cardWithPr(s, 31);

    await checkRun('Analyze (javascript-typescript)', 'success', CODEQL_SUITE, 31);
    await checkSuite('success', CODEQL_SUITE, 31);

    const rows = await adminDb.githubCheckRun.findMany({ orderBy: { checkName: 'asc' } });
    expect(rows.map((r) => [r.checkName, r.checkSuiteId, r.suiteAggregate] as const)).toEqual([
      ['Analyze (javascript-typescript)', CODEQL_SUITE, false],
      ['github-actions', CODEQL_SUITE, true],
    ]);
  });

  it("CodeQL's failure still decides the verdict when CI's suite is newer and green", async () => {
    // The #3112 ordering — CodeQL's suite id below CI's — with CodeQL red. Under
    // the old rule CI's `github-actions` roll-up retired CodeQL's suite, the
    // aggregate read green and the card was promoted over a failing scan.
    const s = await makeScenario('actions-codeql@example.com');
    const item = await cardWithPr(s, 32);

    await checkRun('Analyze (javascript-typescript)', 'failure', CODEQL_SUITE, 32);
    await checkSuite('failure', CODEQL_SUITE, 32);
    await checkRun('TypeScript', 'success', CI_SUITE, 32);
    const last = await checkSuite('success', CI_SUITE, 32);

    expect(last).toMatchObject({ outcome: 'verified', ciState: 'failing' });
    expect(last).not.toHaveProperty('promoted');
    const card = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(card!.status).toBe('implemented');

    const comments = await adminDb.comment.findMany({ where: { workItemId: item.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('`Analyze (javascript-typescript)`');
    expect(comments[0]!.bodyMd).toContain('of 4 checks');
  });
});
