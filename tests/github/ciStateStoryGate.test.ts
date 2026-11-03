import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { homeService } from '@/lib/services/homeService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { workItemCiStateBackfillService } from '@/lib/services/workItemCiStateBackfillService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { CI_STATES } from '@/lib/github/prCiState';
import { recomputeWorkItemCiState } from '@/lib/services/deliveryVerdict';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { FILTER_FIELDS } from '@/lib/filters/registry';
import type { FilterAst } from '@/lib/filters/ast';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { homePageItems } from '../helpers/homePage';

// MOTIR-5477 — THE STORY'S SEAM GATE.
//
// ⚠️ WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY DOES NOT DO. Every code card
// in Story MOTIR-5469 has its own units, and they are good: `cardCiState.test.ts`
// proves the fold, `ciStateBackfill.test.ts` proves the sweep, `ciBadgeState.test.ts`
// proves the drawing rule, `ci-state-filter.test.ts` proves the board and the list
// compile the same predicate. None of them can prove the pieces AGREE, because each
// one holds the other pieces still.
//
// So this file asserts only the joins:
//
//   §1 ONE EVENT, EVERY SURFACE — one card, two pull requests, driven only through
//      the real webhook and the real link doors, with FOUR reads and BOTH filter
//      reads compared after each step. Four reads project four different ways (a
//      per-column whole-row read, two fixed `$queryRaw` projections and the
//      Workbench's own select), and a column dropped from any one of them arrives
//      as `undefined` with nothing going red.
//   §2 THE COLUMN AND THE PROMOTION AGREE — `passing` is not a separate opinion
//      from "this card may move to In Review".
//   §3 THE BACKFILL CONVERGES on what the recompute derives, for three card shapes.
//   §4 CONCURRENCY, REPEATED — a lost update that survives one race is a coin toss,
//      not a passing test.
//   §5 ONE VALUE LIST — the filter's whitelist and the fold's tuple are one object.
//
// Real Postgres, the real webhook service, no mocks.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-story-gate';
const REPO_PROVIDER_ID = '5471';
const OTHER_REPO_PROVIDER_ID = '5472';

interface Scenario {
  userId: string;
  workspaceId: string;
  projectId: string;
  ctx: { userId: string; workspaceId: string };
}

async function makeScenario(email: string, identifier: string): Promise<Scenario> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier,
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
      {
        providerRepoId: OTHER_REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme-api',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    ctx: { userId: user.id, workspaceId: workspace.id },
  };
}

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

/** A check event. `conclusion: null` + `status: 'in_progress'` is the PENDING arm. */
function ci(opts: {
  repoProviderId?: string;
  conclusion: string | null;
  status?: string;
  headSha: string;
  prNumbers: number[];
  name?: string;
}) {
  return githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(opts.repoProviderId ?? REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      name: opts.name ?? 'build',
      check_suite: { head_branch: null },
      pull_requests: opts.prNumbers.map((n) => ({ number: n })),
    },
  });
}

async function storedCiState(workItemId: string): Promise<string | null> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return row.ciState;
}

async function makeCard(s: Scenario, title: string, status = 'in_progress') {
  const item = await workItemsService.createWorkItem(
    { projectId: s.projectId, kind: 'task', title },
    s.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { status, assigneeId: s.userId, reporterId: s.userId },
  });
  return item;
}

// ── The four reads, one signature each ─────────────────────────────────────

async function fromBoard(s: Scenario, itemId: string): Promise<string | null | undefined> {
  const board = await boardsService.getBoard(s.projectId, s.ctx);
  return board.columns.flatMap((c) => c.cards).find((c) => c.id === itemId)?.ciState;
}

async function fromList(s: Scenario, itemId: string): Promise<string | null | undefined> {
  const page = await workItemsService.getProjectIssuesList(
    s.projectId,
    { sort: DEFAULT_SORT },
    s.ctx,
  );
  return page.items.find((i) => i.id === itemId)?.ciState;
}

async function fromTree(s: Scenario, itemId: string): Promise<string | null | undefined> {
  const forest = await workItemsService.getProjectTree(s.projectId, {}, s.ctx);
  const find = (nodes: Awaited<ReturnType<typeof workItemsService.getProjectTree>>): unknown => {
    for (const node of nodes) {
      if (node.id === itemId) return node.ciState;
      const hit = find(node.children);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return find(forest) as string | null | undefined;
}

async function fromWorkbench(s: Scenario, itemId: string): Promise<string | null | undefined> {
  // In progress's category is two tabs since MOTIR-6604: a card stuck until it is
  // repaired (a red one, here) is listed on To fix instead. The row is the same row.
  const ctx = { userId: s.userId, workspaceId: s.workspaceId, projectId: s.projectId };
  const [inProgress, toFix] = await Promise.all([
    homeService.listInProgress(ctx),
    homeService.listToFix(ctx),
  ]);
  return [...homePageItems(inProgress), ...toFix.items].find((r) => r.id === itemId)?.ciState;
}

const ciAst = (value: string): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'ciState', operator: 'is_any_of', value: [value] }],
});

async function listMatches(s: Scenario, itemId: string, value: string): Promise<boolean> {
  const page = await workItemsService.getProjectIssuesList(
    s.projectId,
    { sort: DEFAULT_SORT, filter: { ast: ciAst(value) } },
    s.ctx,
  );
  return page.items.some((i) => i.id === itemId);
}

async function boardMatches(s: Scenario, itemId: string, value: string): Promise<boolean> {
  const board = await boardsService.getBoard(s.projectId, s.ctx, undefined, { ast: ciAst(value) });
  return board.columns.flatMap((c) => c.cards).some((c) => c.id === itemId);
}

/**
 * The §1 assertion, as one call: the stored column, all four reads and both
 * filter reads, for one card, at one moment.
 *
 * ⚠️ `toBe`, never `toBeTruthy`, and the four reads are compared to the STORED
 * value rather than to each other: two reads that both dropped the column agree
 * perfectly, at `undefined`.
 */
async function everySurfaceAgrees(s: Scenario, itemId: string, expected: string | null) {
  expect(await storedCiState(itemId), 'the stored column').toBe(expected);
  expect(await fromBoard(s, itemId), 'the BOARD projection').toBe(expected);
  expect(await fromList(s, itemId), 'the /items LIST read').toBe(expected);
  expect(await fromTree(s, itemId), 'the /items TREE read').toBe(expected);
  expect(await fromWorkbench(s, itemId), 'homeService.listInProgress').toBe(expected);

  // And the filter FINDS it by that value, in both reads that offer the field.
  if (expected !== null) {
    expect(await listMatches(s, itemId, expected), `the LIST filtered on ${expected}`).toBe(true);
    expect(await boardMatches(s, itemId, expected), `the BOARD filtered on ${expected}`).toBe(true);
  }
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── §1 ─────────────────────────────────────────────────────────────────────

describe('§1 one event, every surface (MOTIR-5477)', () => {
  it('pending → one pull request failing → that one unlinked, with six readers agreeing at each step', async () => {
    const s = await makeScenario('every-surface@example.com', 'EVS');
    const item = await makeCard(s, 'A change across two repositories');

    for (const [name, number, repoProviderId] of [
      ['acme', 11, REPO_PROVIDER_ID],
      ['acme-api', 12, OTHER_REPO_PROVIDER_ID],
    ] as const) {
      await linkPrByIdentifier({
        identifier: item.identifier,
        owner: 'moooon',
        name,
        number,
        headRef: `subtask/${item.identifier}-work`,
        title: `A change (subtask/${item.identifier}-work)`,
      });
      await openPrIn(repoProviderId, `subtask/${item.identifier}-work`, number);
    }

    // STEP 1 — a pending check on one of them. `running` is the verdict MOTIR-5470
    // added and the one a stale reader is most likely to miss, because nothing
    // downstream of it changes status.
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-1', prNumbers: [11] });
    await everySurfaceAgrees(s, item.id, 'running');

    // STEP 2 — that pull request finishes RED. `failing` outranks everything.
    await ci({ conclusion: 'failure', headSha: 'sha-1', prNumbers: [11] });
    await ci({
      repoProviderId: OTHER_REPO_PROVIDER_ID,
      conclusion: 'success',
      headSha: 'sha-2',
      prNumbers: [12],
    });
    await everySurfaceAgrees(s, item.id, 'failing');

    // STEP 3 — the failing pull request is UNLINKED. The event that would have
    // corrected the card is the one that just stopped delivering it, so the
    // unlink door has to recompute; the surviving delivery is green.
    const red = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 11 } });
    await githubPullRequestService.unlinkPullRequest(item.id, red.id, s.ctx);
    await everySurfaceAgrees(s, item.id, 'passing');

    // And the card is NO LONGER found by the value it used to read — a filter
    // that only ever adds rows would pass every assertion above.
    expect(await listMatches(s, item.id, 'failing')).toBe(false);
    expect(await boardMatches(s, item.id, 'failing')).toBe(false);
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────

/**
 * The promotion is PRIVATE (`ciPromotion.everyDeliveryIsGreen` is not exported),
 * so its verdict is read where it is observable: an `implemented` card moves to
 * `in_review` exactly when the set is green. That is the same predicate, read
 * through the door that uses it, which is the stronger statement anyway.
 *
 * ⚠️ ONE KNOWN GAP, STATED RATHER THAN HIDDEN: `isPromotable` is
 * `everyDeliveryIsGreen && !heldByQueueFailure` (MOTIR-5632), so a `passing` card
 * held by a merge-queue ejection legitimately does not promote. No fixture here
 * records a queue exit, which is what keeps the biconditional true in this file.
 */
async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } });
  return row.status;
}

describe('§2 the column and the promotion agree (MOTIR-5477)', () => {
  it('passing PROMOTES; failing and running do not, and neither moves the card', async () => {
    const s = await makeScenario('agree@example.com', 'AGR');

    // Three cards, each sitting at `implemented` — the one status the promotion
    // can move from — delivered by one pull request apiece.
    const cards: Array<{ id: string; identifier: string; number: number; want: string }> = [];
    for (const [number, conclusion, want] of [
      [21, 'success', 'passing'],
      [22, 'failure', 'failing'],
      [23, null, 'running'],
    ] as const) {
      const item = await makeCard(s, `A change #${number}`, 'implemented');
      await linkPrByIdentifier({
        identifier: item.identifier,
        owner: 'moooon',
        name: 'acme',
        number,
        headRef: `subtask/${item.identifier}-work`,
        title: `A change (subtask/${item.identifier}-work)`,
      });
      await openPrIn(REPO_PROVIDER_ID, `subtask/${item.identifier}-work`, number);
      await ci({
        conclusion,
        status: conclusion === null ? 'in_progress' : 'completed',
        headSha: `sha-${number}`,
        prNumbers: [number],
      });
      cards.push({ id: item.id, identifier: item.identifier, number, want });
    }

    for (const card of cards) {
      const state = await storedCiState(card.id);
      expect(state, `${card.identifier} column`).toBe(card.want);
      // The biconditional, both directions, in one expression: promoted iff green.
      const promoted = (await statusOf(card.id)) === 'in_review';
      expect(promoted, `${card.identifier} promoted (column ${state})`).toBe(state === 'passing');
    }
  });

  it('a card with TWO deliveries is promoted only once BOTH are green, and its column says so', async () => {
    // The single-delivery case above cannot tell "green" from "the last one was
    // green". This one can: the column and the promotion have to change together
    // on the SECOND verdict, not the first.
    const s = await makeScenario('agree-two@example.com', 'AG2');
    const item = await makeCard(s, 'A change across two repositories', 'implemented');

    for (const [name, number, repoProviderId] of [
      ['acme', 31, REPO_PROVIDER_ID],
      ['acme-api', 32, OTHER_REPO_PROVIDER_ID],
    ] as const) {
      await linkPrByIdentifier({
        identifier: item.identifier,
        owner: 'moooon',
        name,
        number,
        headRef: `subtask/${item.identifier}-work`,
        title: `A change (subtask/${item.identifier}-work)`,
      });
      await openPrIn(repoProviderId, `subtask/${item.identifier}-work`, number);
    }

    await ci({ conclusion: 'success', headSha: 'sha-31', prNumbers: [31] });
    // One green, the other silent — not green, and not promoted.
    expect(await storedCiState(item.id)).not.toBe('passing');
    expect(await statusOf(item.id)).toBe('implemented');

    await ci({
      repoProviderId: OTHER_REPO_PROVIDER_ID,
      conclusion: 'success',
      headSha: 'sha-32',
      prNumbers: [32],
    });
    expect(await storedCiState(item.id)).toBe('passing');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a member that MERGED without checks is dropped from BOTH readings, so they still agree (MOTIR-5786)', async () => {
    // Before MOTIR-5786 the silent merged member read `running` on the column and
    // "not passing" on the promotion: the card sat at `implemented` for ever and
    // the Checks filter listed it as still waiting. It is waiting on nothing, so
    // both readings drop it — and the green member alone decides, on both sides.
    const s = await makeScenario('agree-finished@example.com', 'AGF');
    const item = await makeCard(s, 'A change with an old silent merge', 'implemented');

    for (const number of [41, 42]) {
      await linkPrByIdentifier({
        identifier: item.identifier,
        owner: 'moooon',
        name: 'acme',
        number,
        headRef: `subtask/${item.identifier}-${number}`,
        title: `A change (subtask/${item.identifier}-${number})`,
      });
      await openPrIn(REPO_PROVIDER_ID, `subtask/${item.identifier}-${number}`, number);
    }
    // #41 merged without a single check row — an old merge, or one that skipped CI.
    await adminDb.githubPullRequest.updateMany({
      where: { number: 41, repo: { name: 'acme' } },
      data: { state: 'closed', merged: true },
    });

    await ci({ conclusion: 'success', headSha: 'sha-42', prNumbers: [42] });
    expect(await storedCiState(item.id)).toBe('passing');
    expect(await statusOf(item.id)).toBe('in_review');
  });
});

// ── §3 ─────────────────────────────────────────────────────────────────────

describe('§3 the backfill converges on what the recompute derives (MOTIR-5477)', () => {
  it('three card shapes, one sweep, and a second sweep that changes nothing', async () => {
    const s = await makeScenario('backfill@example.com', 'BKF');

    // Shape 1 — an ordinary LINKED card, one green pull request.
    const linked = await makeCard(s, 'A linked change');
    await linkPrByIdentifier({
      identifier: linked.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 41,
      headRef: `subtask/${linked.identifier}-work`,
      title: `A change (subtask/${linked.identifier}-work)`,
    });
    await openPrIn(REPO_PROVIDER_ID, `subtask/${linked.identifier}-work`, 41);
    await ci({ conclusion: 'success', headSha: 'sha-41', prNumbers: [41] });

    // Shape 2 — a SESSION-BRANCH card, linked to nothing: the shape the old
    // writer never reached, because its loop was over the linked cards.
    const session = await makeCard(s, 'A session change');
    await adminDb.workItem.update({
      where: { id: session.id },
      data: { sessionBranch: 'run/session-bkf' },
    });
    await openPrIn(REPO_PROVIDER_ID, 'run/session-bkf', 42);
    await ci({ conclusion: 'failure', headSha: 'sha-42', prNumbers: [42] });

    // Shape 3 — TWO pull requests, one red: the shape the old writer got wrong by
    // stamping whichever reported last.
    const two = await makeCard(s, 'A two-repository change');
    for (const [name, number, repoProviderId] of [
      ['acme', 43, REPO_PROVIDER_ID],
      ['acme-api', 44, OTHER_REPO_PROVIDER_ID],
    ] as const) {
      await linkPrByIdentifier({
        identifier: two.identifier,
        owner: 'moooon',
        name,
        number,
        headRef: `subtask/${two.identifier}-work`,
        title: `A change (subtask/${two.identifier}-work)`,
      });
      await openPrIn(repoProviderId, `subtask/${two.identifier}-work`, number);
    }
    await ci({ conclusion: 'success', headSha: 'sha-43', prNumbers: [43] });
    await ci({
      repoProviderId: OTHER_REPO_PROVIDER_ID,
      conclusion: 'failure',
      headSha: 'sha-44',
      prNumbers: [44],
    });

    const derived = {
      linked: await storedCiState(linked.id),
      session: await storedCiState(session.id),
      two: await storedCiState(two.id),
    };
    expect(derived).toEqual({ linked: 'passing', session: 'failing', two: 'failing' });

    // Now stamp a STALE value on each — what the old writer would have left.
    await adminDb.workItem.updateMany({
      where: { id: { in: [linked.id, session.id, two.id] } },
      data: { ciState: 'running' },
    });

    await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect({
      linked: await storedCiState(linked.id),
      session: await storedCiState(session.id),
      two: await storedCiState(two.id),
    }).toEqual(derived);

    // ⚠️ "Each column equals what the recompute derives" is asserted as a DRY RUN
    // that predicts nothing, not as a second comparison against the same literals.
    // A dry run folds through the same `deliveryVerdict` the write does, so an
    // empty `changed` IS the statement that every column already holds the
    // recompute's answer — including for any card this test did not name.
    const rehearsal = await workItemCiStateBackfillService.backfillCiState({ dryRun: true });
    expect(rehearsal.changed).toEqual([]);

    const second = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(second.changed).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(second.unchanged).toBeGreaterThanOrEqual(3);
  });

  it('counts a card that is BOTH linked and session-branched exactly ONCE', async () => {
    // ⚠️ THE SWEEP COLLECTS ITS CANDIDATES FROM TWO PLACES — the explicit delivery
    // rows and the pull-request head refs that match a card's `sessionBranch` — and
    // a card can legitimately be in both: a run opens a pull request on its session
    // branch AND someone links a second one by hand. The collector de-duplicates by
    // id, and nothing else in the suite puts a card in both sets, so the dedupe is
    // the one property here no other fixture reaches.
    //
    // It matters beyond a count: a candidate processed twice takes the card's row
    // lock twice in one sweep, and reports its `from → to` pair twice, which is how
    // a rehearsal's output stops matching the run it rehearses.
    const s = await makeScenario('both-sets@example.com', 'BTH');
    const item = await makeCard(s, 'A change delivered twice over');
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { sessionBranch: 'run/session-bth' },
    });

    // (1) the SESSION-BRANCH half — a pull request whose head ref IS that branch.
    await openPrIn(REPO_PROVIDER_ID, 'run/session-bth', 51);
    await ci({ conclusion: 'failure', headSha: 'sha-51', prNumbers: [51] });

    // (2) the LINKED half — a second pull request, explicitly linked to the card.
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme-api',
      number: 52,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(OTHER_REPO_PROVIDER_ID, `subtask/${item.identifier}-work`, 52);
    await ci({
      repoProviderId: OTHER_REPO_PROVIDER_ID,
      conclusion: 'success',
      headSha: 'sha-52',
      prNumbers: [52],
    });

    // The fold reads BOTH halves — one red delivery is enough.
    expect(await storedCiState(item.id)).toBe('failing');

    await adminDb.workItem.update({ where: { id: item.id }, data: { ciState: 'passing' } });
    const report = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });

    // ONE candidate, so ONE change row — not two identical ones.
    const rows = report.changed.filter((c) => c.workItemId === item.id);
    expect(rows).toEqual([
      { workItemId: item.id, identifier: item.identifier, from: 'passing', to: 'failing' },
    ]);
    expect(report.scanned).toBe(1);
  });
});

// ── §4 ─────────────────────────────────────────────────────────────────────

/**
 * The §4 test's own budget (MOTIR-10292) — ten two-delivery races, each a link,
 * an open and two concurrent `check_suite` deliveries, is a LONG test, and the
 * suite-wide 15 s `testTimeout` was sized for a query.
 *
 * Measured on CI shard `Vitest (16/20)`, the only shard that runs this file: the
 * test passed in 6994–13119 ms across seven green runs (the slowest on shards of
 * ~1420–1460 s), and was cut off at 15000 ms (reported 16089 ms) on a 1225 s
 * shard (run 41626033679, attempt 1). The time tracks shard load, not the code:
 * locally it is ~7 s idle and passes at 15.1 s, or times out, under CPU
 * contention. 60 s is over four times the slowest green run.
 *
 * ⚠️ It is still a BOUND, not an absence of one: a race that deadlocks or hangs
 * never settles, so the test fails by this timeout instead of running forever.
 */
const TEN_RACES_TIMEOUT_MS = 60_000;

describe('§4 concurrency, repeated (MOTIR-5477)', () => {
  it(
    'ten races between two deliveries each leave the fold of the FINAL rows',
    { timeout: TEN_RACES_TIMEOUT_MS },
    async () => {
      // ⚠️ THE REPETITION IS THE TEST. A read-derived write without the row lock
      // still commits the right answer most of the time — the losing interleaving
      // needs both recomputes to read before either writes. One run is a coin toss
      // reported as a pass; ten runs that all agree is evidence.
      const s = await makeScenario('race@example.com', 'RCE');

      for (let round = 0; round < 10; round += 1) {
        const item = await makeCard(s, `A change, round ${round}`);
        const a = 100 + round * 2;
        const b = a + 1;

        for (const [name, number, repoProviderId] of [
          ['acme', a, REPO_PROVIDER_ID],
          ['acme-api', b, OTHER_REPO_PROVIDER_ID],
        ] as const) {
          await linkPrByIdentifier({
            identifier: item.identifier,
            owner: 'moooon',
            name,
            number,
            headRef: `subtask/${item.identifier}-work`,
            title: `A change (subtask/${item.identifier}-work)`,
          });
          await openPrIn(repoProviderId, `subtask/${item.identifier}-work`, number);
        }

        // Started TOGETHER — not awaited in sequence. One green, one red.
        //
        // ⚠️ `allSettled`, not `all` (MOTIR-10292). `Promise.all` rejects on the
        // FIRST rejection and stops waiting for the other delivery, which is then
        // still holding a backend when the next round — or the next test's
        // `TRUNCATE` — starts. Both are waited for, then both must have succeeded.
        const settled = await Promise.allSettled([
          ci({ conclusion: 'success', headSha: `sha-${a}`, prNumbers: [a] }),
          ci({
            repoProviderId: OTHER_REPO_PROVIDER_ID,
            conclusion: 'failure',
            headSha: `sha-${b}`,
            prNumbers: [b],
          }),
        ]);
        for (const outcome of settled) {
          if (outcome.status === 'rejected') throw outcome.reason;
        }

        expect(await storedCiState(item.id), `round ${round}`).toBe('failing');
      }
    },
  );
});

// ── §5 ─────────────────────────────────────────────────────────────────────

describe('§5 one value list (MOTIR-5477)', () => {
  it("the filter's whitelist IS the fold's tuple — the same members, in the same order", () => {
    // Two lists that happen to agree are a coincidence a later edit breaks in one
    // place. This fails the moment somebody adds a verdict to the fold without
    // making it searchable, or offers a filter value the fold never writes (which
    // would return nothing, forever, with no error).
    const def = FILTER_FIELDS.find((f) => f.id === 'ciState');
    expect(def, 'the ciState field is registered').toBeDefined();
    expect(def!.valueWhitelist).toEqual([...CI_STATES]);
    expect(def!.nullable, '`null` is a real answer, addressed by the empty pair').toBe(true);
  });
});

// ── §6 ─────────────────────────────────────────────────────────────────────

describe("§6 the recompute's row-vanished arms (MOTIR-5477 §1)", () => {
  it('returns null and writes nothing for an id no row carries', async () => {
    // ⚠️ THIS IS A COVERAGE-FLOOR TEST AND IT IS ALSO A REAL ONE. The recompute
    // runs from a webhook and from the backfill sweep, both of which resolved
    // their card id in an EARLIER transaction — so the row can be gone by the
    // time the lock is asked for. Returning `null` rather than throwing is what
    // keeps a deleted card from failing a delivery the host would then retry
    // forever.
    const s = await makeScenario('vanished@example.com', 'VAN');
    const verdict = await withWorkspaceServiceContext(s.workspaceId, (tx) =>
      recomputeWorkItemCiState('wi_does_not_exist', tx),
    );
    expect(verdict).toBeNull();
  });

  it('a GRANTED lock implies a readable row — the second guard is defensive, not reachable', async () => {
    // The arm below the lock (`findById` → null) cannot be driven from outside,
    // because `lockById` and `findById` resolve the SAME row by the SAME immutable
    // id inside ONE transaction. Rather than mark it ignored, this asserts the
    // invariant that makes it unreachable, so a change that breaks the invariant —
    // a `findById` that starts filtering on something `lockById` does not — fails
    // HERE rather than turning a live card's verdict into a silent `null`.
    const s = await makeScenario('lock-invariant@example.com', 'LCK');
    const item = await makeCard(s, 'A change');

    await withWorkspaceServiceContext(s.workspaceId, async (tx) => {
      const locked = await workItemRepository.lockById(item.id, tx);
      const read = await workItemRepository.findById(item.id, tx);
      expect(locked).not.toBeNull();
      expect(read).not.toBeNull();
      expect(read!.id).toBe(locked!.id);
    });
  });
});
