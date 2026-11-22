import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { db } from '@/lib/db';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { FilterAst } from '@/lib/filters/ast';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { boardsService } from '@/lib/services/boardsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { projectsService } from '@/lib/services/projectsService';
import { pullRequestMergeabilityService } from '@/lib/services/pullRequestMergeabilityService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { toFixTagState } from '@/components/workItems/ToFixTag';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

// THE STORY GATE for the To fix TAG, BANNER and FILTER (Story MOTIR-6589 ·
// MOTIR-6612), on a real Postgres, through the real services.
//
// Every sibling tests its own surface — the filter field (MOTIR-6609), the tag and
// its projections (MOTIR-6610), the banner and the detail read (MOTIR-6611). What
// only this tier can see is whether they AGREE: six reads project `fixReason` five
// different ways (the board's whole-row read, the List and forest `$queryRaw`
// projections, the lazy level's, and the detail aggregate the quick view and the
// item page share), and one missed select renders as a stuck card quietly looking
// healthy on ONE surface, with every sibling's own tests green.
//
// So each stuck card is made stuck through the door the product walks — a check
// webhook, the queue's `dequeued`, a mergeability reading, a Request changes press —
// never by writing the column (the scenario helpers are the tab story's gate's,
// `toFixStoryGate.test.ts`, copied rather than imported: a test file exports no
// helpers). The ONE exception is the stale done card, which no event can produce:
// the recompute clears the reason on done, so a stale value only exists by writing it.

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

async function fixReasonStored(itemId: string): Promise<WorkItemFixReasonDto | null> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: itemId } });
  return row.fixReason;
}

const anyReason: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'fixReason', operator: 'is_not_empty', value: null }],
};
const reasonIs = (reason: WorkItemFixReasonDto): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'fixReason', operator: 'is_any_of', value: [reason] }],
});

/**
 * A status key's CATEGORY in the scenario's project — what the `/items` row shaper
 * derives from the workflow (the List DTO carries the raw key, as `ciState`'s rule
 * needs), so the tag's drawing rule can be applied to a List row as the page does.
 */
async function categoryOf(s: Scenario): Promise<(status: string) => string | null> {
  const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: s.project.id } });
  const byKey = new Map(statuses.map((st) => [st.key, st.category]));
  return (status) => byKey.get(status) ?? null;
}

/** Every read the tag, banner and filter are drawn from, for one reader, at one moment. */
async function readAll(s: Scenario) {
  const [board, list, forest, root] = await Promise.all([
    boardsService.getBoard(s.project.id, s.ctx),
    workItemsService.getProjectIssuesList(s.project.id, { sort: DEFAULT_SORT }, s.ctx),
    workItemsService.getProjectTree(s.project.id, {}, s.ctx),
    workItemsService.listRootIssues(s.project.id, { sort: DEFAULT_SORT }, s.ctx),
  ]);
  const cards = board.columns.flatMap((c) => c.cards);
  return {
    board: (id: string) => cards.find((c) => c.id === id),
    list: (id: string) => list.items.find((r) => r.id === id),
    tree: (id: string) => forest.find((n) => n.id === id),
    root: (id: string) =>
      root.rows.find((r) => 'id' in r && r.id === id) as
        | { fixReason?: WorkItemFixReasonDto | null; statusCategory?: unknown }
        | undefined,
  };
}

async function listFiltered(s: Scenario, ast: FilterAst): Promise<string[]> {
  const page = await workItemsService.getProjectIssuesList(
    s.project.id,
    { sort: DEFAULT_SORT, filter: { ast } },
    s.ctx,
  );
  return page.items.map((r) => r.id).sort();
}

async function boardFiltered(s: Scenario, ast: FilterAst): Promise<string[]> {
  const board = await boardsService.getBoard(s.project.id, s.ctx, undefined, { ast });
  return board.columns
    .flatMap((c) => c.cards)
    .map((c) => c.id)
    .sort();
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** One card per reason, each made stuck through its event; a healthy card; a card cleared by done. */
async function seedStuckProject(s: Scenario) {
  const red = await card(s, 'red card', 201);
  await workItemsService.updateStatus(red.item.id, 'implemented', s.ctx);
  await check(s, 201, 'sha-a', 'vitest', 'failure');

  const queued = await card(s, 'queued card', 202);
  await check(s, 202, 'sha-a', 'vitest', 'success');
  await queueFailure(s, queued.item.id, 202, 'sha-a');

  const conflicted = await card(s, 'conflicting card, green checks', 203);
  await check(s, 203, 'sha-a', 'vitest', 'success');
  await mergeability(s, 203, 'sha-a', 'dirty');

  const reviewed = await card(s, 'reviewed card', 204);
  await check(s, 204, 'sha-a', 'vitest', 'success');
  await requestChanges(s, reviewed.item.id, 'Rename the export button.');

  const healthy = await card(s, 'healthy card', 205);
  await check(s, 205, 'sha-a', 'vitest', 'success');

  // Stuck, then finished: the recompute on the done-category move clears it.
  const finished = await card(s, 'finished card', 206);
  await workItemsService.updateStatus(finished.item.id, 'implemented', s.ctx);
  await check(s, 206, 'sha-a', 'vitest', 'failure');
  await workItemsService.updateStatus(finished.item.id, 'cancelled', s.ctx);

  return {
    red: red.item,
    queued: queued.item,
    conflicted: conflicted.item,
    reviewed: reviewed.item,
    healthy: healthy.item,
    finished: finished.item,
  };
}

describe('every projection agrees, for a card per reason reached through its event', () => {
  it('the board, List, forest, lazy level, quick view and item page carry the STORED reason', async () => {
    const s = await makeScenario('tag-gate-agree@example.com');
    const cards = await seedStuckProject(s);
    const expected: Record<keyof typeof cards, WorkItemFixReasonDto | null> = {
      red: 'ci_failed',
      queued: 'queue_failed',
      conflicted: 'conflicted',
      reviewed: 'changes_requested',
      healthy: null,
      finished: null,
    };

    const reads = await readAll(s);
    for (const [name, item] of Object.entries(cards) as Array<
      [keyof typeof cards, { id: string; identifier: string }]
    >) {
      const want = expected[name];
      // Compared to the STORED column with `toBe`: two reads that both dropped the
      // column would agree with each other perfectly, at `undefined`.
      expect(await fixReasonStored(item.id), `${name}: stored`).toBe(want);
      expect(reads.board(item.id)?.fixReason, `${name}: board`).toBe(want);
      expect(reads.list(item.id)?.fixReason, `${name}: /items list`).toBe(want);
      expect(reads.tree(item.id)?.fixReason, `${name}: /items tree`).toBe(want);
      expect(reads.root(item.id)?.fixReason, `${name}: lazy tree level`).toBe(want);
      const peek = await workItemsService.getQuickView(
        s.project.id,
        item.identifier,
        'workspace',
        s.ctx,
        'en',
      );
      expect(peek.fixReason, `${name}: quick view`).toBe(want);
      const detail = await workItemsService.getIssueDetail(s.project.id, item.identifier, s.ctx);
      expect(detail.fixReason, `${name}: item page`).toBe(want);
      // The banner's detail travels with the reason, and never without it.
      expect(detail.fixDetail === null, `${name}: fixDetail null exactly when fixReason is`).toBe(
        want === null,
      );
    }

    // The detail the banner draws names what each reason's event carried.
    const detailOf = async (item: { identifier: string }) =>
      (await workItemsService.getIssueDetail(s.project.id, item.identifier, s.ctx)).fixDetail;
    expect(await detailOf(cards.red)).toMatchObject({ repair: 'fix', check: 'vitest' });
    expect(await detailOf(cards.queued)).toMatchObject({
      repair: 'fix',
      queueReason: 'CI_FAILURE',
    });
    expect(await detailOf(cards.conflicted)).toMatchObject({ repair: 'fix', base: 'main' });
    expect(await detailOf(cards.reviewed)).toMatchObject({
      // `fix`, never `run` — a sent-back card is the `review` repair class (§12.7, MOTIR-6822).
      repair: 'fix',
      notePreview: 'Rename the export button.',
    });
    // It seeds six cards through the real webhook doors and reads six projections:
    // about 7 s on an idle machine, over the 15 s default on a loaded CI shard.
  }, 60_000);

  it('the conflicting card has GREEN checks and still carries its reason — independent signals', async () => {
    const s = await makeScenario('tag-gate-green@example.com');
    const cards = await seedStuckProject(s);
    const reads = await readAll(s);
    expect(reads.list(cards.conflicted.id)).toMatchObject({
      ciState: 'passing',
      fixReason: 'conflicted',
    });
    expect(reads.board(cards.conflicted.id)).toMatchObject({
      ciState: 'passing',
      fixReason: 'conflicted',
    });
  });
});

describe('the filter finds exactly the cards the tag marks', () => {
  it('To fix is any = the cards whose tag draws, on the list AND the board', async () => {
    const s = await makeScenario('tag-gate-filter@example.com');
    const cards = await seedStuckProject(s);
    const reads = await readAll(s);
    const category = await categoryOf(s);
    const tagged = Object.values(cards)
      .filter((item) => {
        const row = reads.list(item.id)!;
        return toFixTagState(row.fixReason, category(row.status) as never) !== null;
      })
      .map((item) => item.id)
      .sort();
    expect(tagged).toEqual(
      [cards.red.id, cards.queued.id, cards.conflicted.id, cards.reviewed.id].sort(),
    );
    expect(await listFiltered(s, anyReason)).toEqual(tagged);
    expect(await boardFiltered(s, anyReason)).toEqual(tagged);
  });

  it('To fix is <reason> = exactly that reason’s card', async () => {
    const s = await makeScenario('tag-gate-reason@example.com');
    const cards = await seedStuckProject(s);
    const byReason: Array<[WorkItemFixReasonDto, string]> = [
      ['ci_failed', cards.red.id],
      ['queue_failed', cards.queued.id],
      ['conflicted', cards.conflicted.id],
      ['changes_requested', cards.reviewed.id],
    ];
    for (const [reason, id] of byReason) {
      expect(await listFiltered(s, reasonIs(reason)), reason).toEqual([id]);
    }
  });

  it('a DONE card carrying a stale reason draws no tag and no banner — and the RAW filter still finds it', async () => {
    // The design's decision (MOTIR-6608 § *The To fix filter field*, as for Checks):
    // the done-category rule is a DRAWING rule. The filter matches the column, so a
    // saved view never silently drops a row. No event produces this state — the
    // recompute clears the reason on done — so it is written directly.
    const s = await makeScenario('tag-gate-stale@example.com');
    const { item } = await card(s, 'stale done card', 211);
    await workItemsService.updateStatus(item.id, 'cancelled', s.ctx);
    await adminDb.workItem.update({ where: { id: item.id }, data: { fixReason: 'ci_failed' } });

    const reads = await readAll(s);
    const category = await categoryOf(s);
    const row = reads.list(item.id)!;
    expect(row.fixReason).toBe('ci_failed');
    expect(category(row.status)).toBe('done');
    expect(toFixTagState(row.fixReason, category(row.status) as never)).toBeNull();
    const board = reads.board(item.id)!;
    expect(toFixTagState(board.fixReason, board.statusCategory)).toBeNull();
    const peek = await workItemsService.getQuickView(
      s.project.id,
      item.identifier,
      'workspace',
      s.ctx,
      'en',
    );
    expect(toFixTagState(peek.fixReason, peek.statusCategory)).toBeNull();

    expect(await listFiltered(s, anyReason)).toEqual([item.id]);
  });
});

describe('a repair clears the tag everywhere', () => {
  it('a green push takes the red card off every read and out of the filter', async () => {
    const s = await makeScenario('tag-gate-repair@example.com');
    const red = await card(s, 'red card', 221);
    await workItemsService.updateStatus(red.item.id, 'implemented', s.ctx);
    await check(s, 221, 'sha-a', 'vitest', 'failure');
    expect(await listFiltered(s, anyReason)).toEqual([red.item.id]);

    await check(s, 221, 'sha-b', 'vitest', 'success');

    const reads = await readAll(s);
    expect(reads.board(red.item.id)?.fixReason).toBeNull();
    expect(reads.list(red.item.id)?.fixReason).toBeNull();
    expect(reads.tree(red.item.id)?.fixReason).toBeNull();
    const detail = await workItemsService.getIssueDetail(s.project.id, red.item.identifier, s.ctx);
    expect(detail.fixReason).toBeNull();
    expect(detail.fixDetail).toBeNull();
    expect(await listFiltered(s, anyReason)).toEqual([]);
  });
});

describe('isolation', () => {
  it('another workspace’s stuck card is in none of the reads, and the filter never finds it', async () => {
    const mine = await makeScenario('tag-gate-mine@example.com');
    const theirs = await makeScenario('tag-gate-theirs@example.com');
    const { item } = await card(theirs, 'theirs', 231);
    await workItemsService.updateStatus(item.id, 'implemented', theirs.ctx);
    await check(theirs, 231, 'sha-a', 'vitest', 'failure');
    // Positive control: its own reader finds it.
    expect(await listFiltered(theirs, anyReason)).toEqual([item.id]);

    const reads = await readAll(mine);
    expect(reads.list(item.id)).toBeUndefined();
    expect(reads.board(item.id)).toBeUndefined();
    expect(reads.tree(item.id)).toBeUndefined();
    expect(await listFiltered(mine, anyReason)).toEqual([]);
    expect(await boardFiltered(mine, anyReason)).toEqual([]);
    // Pointed straight at the other workspace's project, the read refuses.
    await expect(
      workItemsService.getProjectIssuesList(
        theirs.project.id,
        { sort: DEFAULT_SORT, filter: { ast: anyReason } },
        mine.ctx,
      ),
    ).rejects.toThrow();
    await expect(
      workItemsService.getIssueDetail(theirs.project.id, item.identifier, mine.ctx),
    ).rejects.toThrow();
  });

  it('a stuck card in a project the reader cannot browse is refused on every read', async () => {
    const s = await makeScenario('tag-gate-private@example.com');
    const outsider = await usersService.createUser({
      email: 'tag-gate-outsider@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    await workspacesService.addMember({
      userId: outsider.id,
      workspaceId: s.workspace.id,
      workspaceRole: 'member',
    });
    const { item } = await card(s, 'private red', 241);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    await check(s, 241, 'sha-a', 'vitest', 'failure');
    const octx = { userId: outsider.id, workspaceId: s.workspace.id };
    // Positive control: while the project is open, the outsider's filter finds it.
    const open = await workItemsService.getProjectIssuesList(
      s.project.id,
      { sort: DEFAULT_SORT, filter: { ast: anyReason } },
      octx,
    );
    expect(open.items.map((r) => r.id)).toEqual([item.id]);

    await setProjectAccess(adminDb, s.project.id, 'members');

    await expect(
      workItemsService.getProjectIssuesList(
        s.project.id,
        { sort: DEFAULT_SORT, filter: { ast: anyReason } },
        octx,
      ),
    ).rejects.toThrow();
    await expect(boardsService.getBoard(s.project.id, octx)).rejects.toThrow();
    await expect(
      workItemsService.getIssueDetail(s.project.id, item.identifier, octx),
    ).rejects.toThrow();
  });
});
