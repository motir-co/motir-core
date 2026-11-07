import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { workItemCiStateBackfillService } from '@/lib/services/workItemCiStateBackfillService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-5472 — `pnpm db:backfill:ci-state`.
//
// MOTIR-5470 makes every FUTURE event write the right answer. These are the rows
// already in the table, and they are wrong in ways no event will correct, because
// the correcting event is not coming: the checks have finished.
//
// The sweep is driven through its ENTRY FUNCTION rather than the script's
// `main()`, which is argument parsing and console output over this call.
//
// Real Postgres, the real webhook service — no mocks. The fixtures write the
// stale value DIRECTLY, because the code that produced it no longer exists: that
// is the whole point of a backfill, and reproducing the old writer to generate
// its output would be reviving the defect to test its repair.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci-backfill';

/** A NUMERIC provider repo id per scenario. ⚠️ It must be numeric: the webhook
 *  payloads address a repository as `repository.id`, which the service reads
 *  through `Number(...)` — an identifier-derived string like `771MINE` becomes
 *  `NaN`, resolves no repository, and every check event then vanishes silently
 *  while the fixture still looks correct. */
let nextRepoProviderId = 7710;

async function makeScenario(email: string, identifier: string) {
  nextRepoProviderId += 1;
  const repoProviderId = String(nextRepoProviderId);
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
  const ctx = { userId: user.id, workspaceId: workspace.id };
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: `${INSTALLATION_ID}-${identifier}`,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: repoProviderId,
        owner: 'moooon',
        name: `acme-${identifier.toLowerCase()}`,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx, repoProviderId };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function openPrIn(s: Scenario, headBranch: string, number: number) {
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: {
      id: `${INSTALLATION_ID}-${s.project.identifier}`,
      account: { login: 'moooon', type: 'Organization' },
    },
    repository: { id: Number(s.repoProviderId) },
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

function ci(s: Scenario, opts: { conclusion: string; headSha: string; prNumbers: number[] }) {
  return githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: {
      id: `${INSTALLATION_ID}-${s.project.identifier}`,
      account: { login: 'moooon', type: 'Organization' },
    },
    repository: { id: Number(s.repoProviderId) },
    check_run: {
      head_sha: opts.headSha,
      status: 'completed',
      conclusion: opts.conclusion,
      name: 'build',
      check_suite: { head_branch: null },
      pull_requests: opts.prNumbers.map((n) => ({ number: n })),
    },
  });
}

async function ciStateOf(workItemId: string): Promise<string | null> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.ciState;
}

/** Write the value the RETIRED writer would have left. */
async function setStoredCiState(workItemId: string, ciState: string | null) {
  await adminDb.workItem.update({ where: { id: workItemId }, data: { ciState } });
}

async function makeCard(s: Scenario, title: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
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

describe('workItemCiStateBackfillService (MOTIR-5472)', () => {
  it('converges a stale `failing` whose rows are now all passing', async () => {
    const s = await makeScenario('stale@example.com', 'STALE');
    const item = await makeCard(s, 'A change');
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme-stale',
      number: 1,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(s, `subtask/${item.identifier}-work`, 1);
    await ci(s, { conclusion: 'success', headSha: 'sha-green', prNumbers: [1] });

    // The stale value the old writer left behind.
    await setStoredCiState(item.id, 'failing');

    const report = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(report.changed).toContainEqual({
      workItemId: item.id,
      identifier: item.identifier,
      from: 'failing',
      to: 'passing',
    });
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('gives a SESSION-BRANCH card its first verdict', async () => {
    // The card the old writer never reached at all: its pull request links
    // nothing, so the `deliveredWorkItemIds` loop was empty and the column stayed
    // `null` however red the build.
    const s = await makeScenario('session@example.com', 'SESS');
    const item = await makeCard(s, 'A card the run delivered');
    const sessionBranch = 'motir/auto-run-5472';
    await adminDb.workItem.update({ where: { id: item.id }, data: { sessionBranch } });
    await openPrIn(s, sessionBranch, 2);
    await ci(s, { conclusion: 'failure', headSha: 'sha-red', prNumbers: [2] });

    // Whatever the live path has since written, the fixture asserts the backfill
    // reaches this card from the SESSION arm — so it starts from empty.
    await setStoredCiState(item.id, null);
    expect(await ciStateOf(item.id)).toBeNull();

    const report = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(report.changed).toContainEqual({
      workItemId: item.id,
      identifier: item.identifier,
      from: null,
      to: 'failing',
    });
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('does not consider a card with NO pull requests a candidate', async () => {
    // Almost every card in the tree. A sweep that recomputed them all would be a
    // bulk write over the whole table to store `null` on rows that already say
    // `null`.
    const s = await makeScenario('nopr@example.com', 'NOPR');
    const item = await makeCard(s, 'A card with no pull request');

    const report = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(report.scanned).toBe(0);
    expect(report.changed).toEqual([]);
    expect(await ciStateOf(item.id)).toBeNull();
  });

  it('SKIPS an archived card, and counts the skip', async () => {
    // Archiving is a human saying this card should not be worked. Counting the
    // skip keeps the abstention visible rather than inferable from a smaller
    // total.
    const s = await makeScenario('archived@example.com', 'ARCH');
    const item = await makeCard(s, 'A change');
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme-arch',
      number: 3,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(s, `subtask/${item.identifier}-work`, 3);
    await ci(s, { conclusion: 'success', headSha: 'sha-green', prNumbers: [3] });
    await setStoredCiState(item.id, 'failing');
    await workItemsService.archiveWorkItem(item.id, s.ctx);

    const report = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(report.skippedArchived).toBe(1);
    expect(report.changed).toEqual([]);
    // Untouched — still the stale value, because nobody asked for it to be fixed.
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('is IDEMPOTENT — a second run over the same data changes nothing', async () => {
    const s = await makeScenario('idem@example.com', 'IDEM');
    const item = await makeCard(s, 'A change');
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme-idem',
      number: 4,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(s, `subtask/${item.identifier}-work`, 4);
    await ci(s, { conclusion: 'failure', headSha: 'sha-red', prNumbers: [4] });
    await setStoredCiState(item.id, 'passing');

    const first = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(first.changed).toHaveLength(1);

    const second = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(second.changed).toEqual([]);
    expect(second.unchanged).toBe(1);
    expect(second.scanned).toBe(1);
  });

  it('`--dry-run` writes NOTHING and predicts the same `from → to` pairs', async () => {
    // The property that makes a rehearsal worth running: both paths fold the same
    // set through the same code, and only one of them writes. A dry run that
    // predicted from a different derivation would be a rehearsal of a different
    // sweep.
    const s = await makeScenario('dry@example.com', 'DRY');
    const item = await makeCard(s, 'A change');
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme-dry',
      number: 5,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(s, `subtask/${item.identifier}-work`, 5);
    await ci(s, { conclusion: 'failure', headSha: 'sha-red', prNumbers: [5] });
    await setStoredCiState(item.id, 'passing');

    const rehearsal = await workItemCiStateBackfillService.backfillCiState({ dryRun: true });
    expect(rehearsal.dryRun).toBe(true);
    expect(rehearsal.changed).toEqual([
      { workItemId: item.id, identifier: item.identifier, from: 'passing', to: 'failing' },
    ]);
    // NOTHING was written.
    expect(await ciStateOf(item.id)).toBe('passing');

    const real = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(real.changed).toEqual(rehearsal.changed);
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('`--workspace=<id>` touches only that workspace’s cards', async () => {
    const mine = await makeScenario('mine@example.com', 'MINE');
    const theirs = await makeScenario('theirs@example.com', 'THRS');

    const mineItem = await makeCard(mine, 'My change');
    await linkPrByIdentifier({
      identifier: mineItem.identifier,
      owner: 'moooon',
      name: 'acme-mine',
      number: 6,
      headRef: `subtask/${mineItem.identifier}-work`,
      title: `A change (subtask/${mineItem.identifier}-work)`,
    });
    await openPrIn(mine, `subtask/${mineItem.identifier}-work`, 6);
    await ci(mine, { conclusion: 'failure', headSha: 'sha-red', prNumbers: [6] });
    await setStoredCiState(mineItem.id, 'passing');

    const theirItem = await makeCard(theirs, 'Their change');
    await linkPrByIdentifier({
      identifier: theirItem.identifier,
      owner: 'moooon',
      name: 'acme-thrs',
      number: 7,
      headRef: `subtask/${theirItem.identifier}-work`,
      title: `A change (subtask/${theirItem.identifier}-work)`,
    });
    await openPrIn(theirs, `subtask/${theirItem.identifier}-work`, 7);
    await ci(theirs, { conclusion: 'failure', headSha: 'sha-red', prNumbers: [7] });
    await setStoredCiState(theirItem.id, 'passing');

    const report = await workItemCiStateBackfillService.backfillCiState({
      dryRun: false,
      workspaceId: mine.workspace.id,
    });
    expect(report.changed.map((c) => c.workItemId)).toEqual([mineItem.id]);
    expect(await ciStateOf(mineItem.id)).toBe('failing');
    // The other tenant's stale row is exactly as it was.
    expect(await ciStateOf(theirItem.id)).toBe('passing');
  });
});

// MOTIR-10542 — a card whose delivery set is EMPTY but which still stores a
// verdict. Its last link was removed before the unlink doors recomputed (#2937),
// so it kept the verdict of a pull request it no longer has. The two delivery
// arms start from a member and this card has none, so before the third arm it
// was never a candidate and its badge stayed wrong for ever.
describe('workItemCiStateBackfillService — a stored verdict with no delivery left (MOTIR-10542)', () => {
  /** The pre-#2937 unlink: the delivery row goes, and the stored verdict stays. */
  async function unlinkWithoutRecompute(workItemId: string) {
    await adminDb.workItemDelivery.deleteMany({ where: { workItemId } });
  }

  it('clears the verdict a removed link left behind, and a second run changes nothing', async () => {
    const s = await makeScenario('orphan@example.com', 'ORPH');
    const item = await makeCard(s, 'A card whose pull request was unlinked');
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme-orph',
      number: 20,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(s, `subtask/${item.identifier}-work`, 20);
    await ci(s, { conclusion: 'failure', headSha: 'sha-red', prNumbers: [20] });
    expect(await ciStateOf(item.id)).toBe('failing');
    await unlinkWithoutRecompute(item.id);
    expect(await ciStateOf(item.id)).toBe('failing');

    const first = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(first.changed).toEqual([
      { workItemId: item.id, identifier: item.identifier, from: 'failing', to: null },
    ]);
    expect(first.failed).toEqual([]);
    expect(await ciStateOf(item.id)).toBeNull();

    // Converged: the card now stores `null`, so the third arm no longer reaches it.
    const second = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(second.changed).toHaveLength(0);
    expect(second.scanned).toBe(0);
  });

  it('clears a seeded `failing` on a card that never had a delivery row', async () => {
    const s = await makeScenario('seeded@example.com', 'SEED');
    const item = await makeCard(s, 'A card with a stale badge');
    await setStoredCiState(item.id, 'failing');

    const first = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(first.scanned).toBe(1);
    expect(first.changed).toEqual([
      { workItemId: item.id, identifier: item.identifier, from: 'failing', to: null },
    ]);
    expect(await ciStateOf(item.id)).toBeNull();

    const second = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(second.changed).toHaveLength(0);
  });

  it('`--dry-run` predicts the `→ null` change and writes nothing', async () => {
    const s = await makeScenario('dryorphan@example.com', 'DRYO');
    const failing = await makeCard(s, 'A stale failing badge');
    const passing = await makeCard(s, 'A stale passing badge');
    await setStoredCiState(failing.id, 'failing');
    await setStoredCiState(passing.id, 'passing');

    const rehearsal = await workItemCiStateBackfillService.backfillCiState({ dryRun: true });
    expect(rehearsal.changed).toHaveLength(2);
    expect(rehearsal.changed).toEqual(
      expect.arrayContaining([
        { workItemId: failing.id, identifier: failing.identifier, from: 'failing', to: null },
        { workItemId: passing.id, identifier: passing.identifier, from: 'passing', to: null },
      ]),
    );
    expect(await ciStateOf(failing.id)).toBe('failing');
    expect(await ciStateOf(passing.id)).toBe('passing');

    const real = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(real.changed).toEqual(rehearsal.changed);
    expect(await ciStateOf(failing.id)).toBeNull();
    expect(await ciStateOf(passing.id)).toBeNull();
  });

  it('leaves an ARCHIVED card with a stale verdict and no delivery alone', async () => {
    const s = await makeScenario('archorphan@example.com', 'ARCO');
    const item = await makeCard(s, 'An archived card');
    await setStoredCiState(item.id, 'failing');
    await workItemsService.archiveWorkItem(item.id, s.ctx);

    const report = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(report.scanned).toBe(0);
    expect(report.changed).toEqual([]);
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('is one candidate when a card is reached by a delivery arm AND the stored-verdict arm', async () => {
    const s = await makeScenario('both@example.com', 'BOTH');
    const item = await makeCard(s, 'A linked card with a stale verdict');
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme-both',
      number: 21,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(s, `subtask/${item.identifier}-work`, 21);
    await ci(s, { conclusion: 'success', headSha: 'sha-green', prNumbers: [21] });
    await setStoredCiState(item.id, 'failing');

    const report = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(report.total).toBe(1);
    expect(report.changed).toEqual([
      { workItemId: item.id, identifier: item.identifier, from: 'failing', to: 'passing' },
    ]);
  });

  it('`--workspace=<id>` scopes the stored-verdict arm too', async () => {
    const mine = await makeScenario('mineorphan@example.com', 'MINO');
    const theirs = await makeScenario('theirsorphan@example.com', 'THRO');
    const mineItem = await makeCard(mine, 'My stale badge');
    const theirItem = await makeCard(theirs, 'Their stale badge');
    await setStoredCiState(mineItem.id, 'failing');
    await setStoredCiState(theirItem.id, 'failing');

    const report = await workItemCiStateBackfillService.backfillCiState({
      dryRun: false,
      workspaceId: mine.workspace.id,
    });
    expect(report.changed.map((c) => c.workItemId)).toEqual([mineItem.id]);
    expect(await ciStateOf(mineItem.id)).toBeNull();
    expect(await ciStateOf(theirItem.id)).toBe('failing');
  });
});

// MOTIR-5765 — the first PRODUCTION run (~1,957 candidates) was cancelled by its
// 10-minute job timeout having printed NOTHING, because the report was only ever
// written at the end. These pin the two halves of the repair at the service: a
// sweep reports as it goes, and a sweep that is stopped RETURNS what it did.
describe('workItemCiStateBackfillService — progress and interruption (MOTIR-5765)', () => {
  /** A card whose stored verdict is stale (`passing` over a red build), so the
   *  sweep has something to change and the tallies are distinguishable. */
  async function staleRedCard(s: Scenario, number: number) {
    const item = await makeCard(s, `A change ${number}`);
    const headRef = `subtask/${item.identifier}-work`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: `acme-${s.project.identifier.toLowerCase()}`,
      number,
      headRef,
      title: `A change (${headRef})`,
    });
    await openPrIn(s, headRef, number);
    await ci(s, { conclusion: 'failure', headSha: `sha-red-${number}`, prNumbers: [number] });
    await setStoredCiState(item.id, 'passing');
    return item;
  }

  it('reports progress every N cards and once more on the LAST card', async () => {
    const s = await makeScenario('progress@example.com', 'PROG');
    for (const n of [11, 12, 13]) await staleRedCard(s, n);

    const seen: Array<{ examined: number; total: number; scanned: number; changed: number }> = [];
    const report = await workItemCiStateBackfillService.backfillCiState({
      dryRun: true,
      progressEvery: 2,
      onProgress: (p) => {
        seen.push({ examined: p.examined, total: p.total, scanned: p.scanned, changed: p.changed });
        // The tally is a snapshot of the report so far, never ahead of it.
        expect(p.unchanged + p.changed + p.skippedArchived + p.failed).toBe(p.scanned);
      },
    });

    // Three candidates, interval 2: once at the interval, once at the end — and
    // not on every card, which at production's size would be ~2,000 lines.
    expect(seen).toEqual([
      { examined: 2, total: 3, scanned: 2, changed: 2 },
      { examined: 3, total: 3, scanned: 3, changed: 3 },
    ]);
    expect(report.total).toBe(3);
    expect(report.interrupted).toBe(false);
  });

  it('stops at the next card boundary when aborted, and RETURNS the partial report', async () => {
    const s = await makeScenario('abort@example.com', 'ABRT');
    const items = [];
    for (const n of [21, 22, 23]) items.push(await staleRedCard(s, n));

    // Abort from inside the first progress call — the same moment a SIGTERM
    // would land in production: a card has just committed, the next has not
    // started.
    const controller = new AbortController();
    const report = await workItemCiStateBackfillService.backfillCiState({
      dryRun: false,
      progressEvery: 1,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    expect(report.interrupted).toBe(true);
    expect(report.total).toBe(3);
    expect(report.scanned).toBe(1);
    expect(report.changed).toHaveLength(1);

    // Exactly the one card the sweep reached was written; the two it never read
    // still carry the stale value — so the partial counts describe the database.
    const states = await Promise.all(items.map((i) => ciStateOf(i.id)));
    expect(states.filter((v) => v === 'failing')).toHaveLength(1);
    expect(states.filter((v) => v === 'passing')).toHaveLength(2);

    // And a re-run RESUMES: the written card is a no-op, the other two change.
    const resumed = await workItemCiStateBackfillService.backfillCiState({ dryRun: false });
    expect(resumed.interrupted).toBe(false);
    expect(resumed.changed).toHaveLength(2);
    expect(resumed.unchanged).toBe(1);
  });

  it('examines nothing when the signal is ALREADY aborted', async () => {
    const s = await makeScenario('pre@example.com', 'PRE');
    const item = await staleRedCard(s, 31);

    const controller = new AbortController();
    controller.abort();
    const report = await workItemCiStateBackfillService.backfillCiState({
      dryRun: false,
      signal: controller.signal,
    });

    expect(report).toMatchObject({ interrupted: true, total: 1, scanned: 0, changed: [] });
    expect(await ciStateOf(item.id)).toBe('passing');
  });
});
