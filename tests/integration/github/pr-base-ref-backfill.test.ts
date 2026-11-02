import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { pullRequestBaseRefBackfillService } from '@/lib/services/pullRequestBaseRefBackfillService';
import { repoSetCompletionService } from '@/lib/services/repoSetCompletionService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The `base_ref` backfill + the event-free RE-EVALUATION, against real Postgres
// (MOTIR-3034).
//
// THE DEFECT, IN ONE SENTENCE: the repository-set completion gate reads a null
// `base_ref` as UNKNOWN (correctly), and its only trigger is a change-request
// DELIVERY — so an item whose repository already merged before that column
// existed is held at In Review by a row nothing will ever update again.
//
// Everything below asserts the repair END TO END rather than through the
// classifier: the assertions read `work_item.status` and `github_pull_request`
// out of the database after the real services ran. Calling `classifyRepoDelivery`
// here would prove the pure function still works and nothing about whether a held
// card can now reach Done — which is the whole claim.
//
// Only two things are stubbed, both ABOVE the code under test: `fetch` (the
// GitHub REST read) and `mintInstallationToken` (a real mint needs an App private
// key the test env has no business carrying). Everything from the service down —
// the repositories, the gate, the workflow resolution, the status write, RLS — is
// real, per CLAUDE.md.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const INSTALLATION_ID = 'inst-base-ref-1';
const CORE = { providerRepoId: '7001', name: 'motir-core', defaultBranch: 'main' };
const AI = { providerRepoId: '7002', name: 'motir-ai', defaultBranch: 'trunk' };

let fetchMock: ReturnType<typeof vi.fn>;

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "github_pull_request", "github_repo", "github_installation", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // MOTIR-5843 — the provenance cases stub `GITHUB_FALLBACK_ORG`; an env stub that
  // outlives its test silently re-classifies every later repository.
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A workspace + project + connected GitHub repos, mirrored exactly as
 *  `githubInstallationService.persistInstallation` writes them. */
async function makeConnected(
  repos: Array<typeof CORE> = [CORE],
  owner = 'moooon-B-V',
): Promise<{ fx: WorkItemFixture; repoIds: Record<string, string> }> {
  const fx = await makeWorkItemFixture();
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId: INSTALLATION_ID,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repoIds: Record<string, string> = {};
  for (const r of repos) {
    const row = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: r.providerRepoId,
        owner,
        name: r.name,
        defaultBranch: r.defaultBranch,
        archived: false,
        provider: 'github',
      },
    });
    repoIds[r.name] = row.id;
  }
  return { fx, repoIds };
}

/** An item that ships in `repos`, parked at In Review — where the completion gate
 *  leaves a card whose pull request has opened. */
async function heldItem(fx: WorkItemFixture, repos: string[], title = 'Ships somewhere') {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: { status: 'in_review', targetRepos: repos, targetRepo: repos[0] ?? null },
  });
  return item;
}

/** A mirror row as it exists for a merge Motir recorded BEFORE `base_ref` existed:
 *  merged, closed, linked — and no base. This is not a contrived shape; it is
 *  every row written before the MOTIR-2729 migration.
 *
 *  ⚠️ THE LINK IS THE DELIVERY ROW (MOTIR-3757). The `work_item_delivery`
 *  migration's pass 1 carried EVERY non-null `github_pull_request.work_item_id`
 *  into a delivery row, and the column was then dropped — so a row of this vintage
 *  carries exactly what this fixture writes. `workItemId: null` means the row
 *  delivers nothing, which is a real state and the one the unlinked case is
 *  about. */
async function preColumnMergedRow(args: {
  repoId: string;
  number: number;
  workItemId: string | null;
  baseRef?: string | null;
  state?: string;
  merged?: boolean;
}) {
  const row = await adminDb.githubPullRequest.create({
    data: {
      provider: 'github',
      repoId: args.repoId,
      number: args.number,
      state: args.state ?? 'closed',
      merged: args.merged ?? true,
      headRef: `subtask/whatever-${args.number}`,
      baseRef: args.baseRef ?? null,
      title: `A change #${args.number}`,
      linkedManually: false,
    },
  });
  if (args.workItemId) {
    const repo = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: args.repoId } });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: repo.workspaceId,
        workItemId: args.workItemId,
        githubPullRequestId: row.id,
        repoId: args.repoId,
      },
    });
  }
  return row;
}

/** Serve `GET /repos/{o}/{n}/pulls/{number}` for every number in the map; any
 *  number absent from it 404s, which the leaf reads as UNANSWERABLE. */
function serveBases(bases: Record<number, string>): void {
  fetchMock.mockImplementation(async (url: string) => {
    const number = Number(url.split('/').pop());
    const ref = bases[number];
    return ref === undefined
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ number, base: { ref } }), { status: 200 });
  });
}

function statusOf(id: string): Promise<string> {
  return adminDb.workItem
    .findUniqueOrThrow({ where: { id }, select: { status: true } })
    .then((r) => r.status);
}

function baseRefOf(id: string): Promise<string | null> {
  return adminDb.githubPullRequest
    .findUniqueOrThrow({ where: { id }, select: { baseRef: true } })
    .then((r) => r.baseRef);
}

const DRY = { dryRun: true };
const APPLY = { dryRun: false };

describe("MOTIR-2725's own case — one repository, one merged PR, null base", () => {
  it('is HELD before the backfill and COMPLETED after it, end to end', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core'], 'The story that built the gate');
    const row = await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 2121,
      workItemId: item.id,
    });

    // BEFORE — the trap. The item's one repository HAS a merged change request,
    // and the gate still holds it, because a null base does not prove the merge
    // reached the trunk. Asserted through the re-evaluation path so the verdict
    // is the gate's own, not a re-derivation.
    const before = await repoSetCompletionService.reevaluateItem(item.id);
    expect(before.outcome).toBe('held_incomplete_repo_set');
    expect(before.shortfall.unknownBase).toEqual(['motir-core']);
    expect(before.shortfall.outstanding).toEqual([]);
    expect(await statusOf(item.id)).toBe('in_review');

    // #2121 really did merge onto `main`; only Motir's row does not know it.
    serveBases({ 2121: 'main' });
    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(report.repos[0]!.candidates).toBe(1);
    expect(report.repos[0]!.filled).toBe(1);
    expect(report.repos[0]!.unanswerable).toBe(0);
    expect(await baseRefOf(row.id)).toBe('main');

    // AFTER — the same gate, the same rule, a different answer, and the item is
    // Done without any new merge ever having happened.
    expect(report.reevaluated).toHaveLength(1);
    expect(report.reevaluated[0]).toMatchObject({
      workItemId: item.id,
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(item.id)).toBe('done');
  });

  it('moves the repository to AWAITING — not delivered — when the merge was stranded', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    const row = await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 30,
      workItemId: item.id,
    });

    // The MOTIR-1873 case the null was protecting against: `merged: true`, but
    // onto a sibling branch. Learning the base RESOLVES the unknown; it does not
    // satisfy the repository.
    serveBases({ 30: 'subtask/MOTIR-1' });
    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(report.repos[0]!.filled).toBe(1);
    expect(await baseRefOf(row.id)).toBe('subtask/MOTIR-1');
    expect(report.reevaluated[0]!.outcome).toBe('held_incomplete_repo_set');
    // UNKNOWN → OUTSTANDING: the reader's question changed from "which branch?"
    // to "where is the merge?", which is the whole value of filling the column.
    expect(report.reevaluated[0]!.shortfall).toEqual({
      outstanding: ['motir-core'],
      unknownBase: [],
      // Widened by Story MOTIR-2732 (ADR §A5) — a repository that does not
      // EXIST yet is a third kind of shortfall. Empty here: this one exists.
      unestablished: [],
    });
    expect(await statusOf(item.id)).toBe('in_review');
  });
});

describe('the backfill never guesses, and never rewrites', () => {
  it('leaves a row the provider CANNOT answer for null, and the repository unknown', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    const row = await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 41,
      workItemId: item.id,
    });

    serveBases({}); // every number 404s — the pull request is gone
    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(report.repos[0]!.candidates).toBe(1);
    expect(report.repos[0]!.filled).toBe(0);
    expect(report.repos[0]!.unanswerable).toBe(1);
    expect(report.repos[0]!.error).toBeUndefined();
    // Still NULL, still UNKNOWN, still held. Fail-closed is the correct state
    // when nobody can say where the merge landed — the sweep removes REASONS to
    // be unknown, it does not remove the state.
    expect(await baseRefOf(row.id)).toBeNull();
    expect(report.reevaluated).toEqual([]);
    expect((await repoSetCompletionService.reevaluateItem(item.id)).shortfall.unknownBase).toEqual([
      'motir-core',
    ]);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('never touches a row that already HAS a base — and a second run is free', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    const alreadyKnown = await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 50,
      workItemId: item.id,
      baseRef: 'main',
    });
    const missing = await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 51,
      workItemId: item.id,
    });
    const before = await adminDb.githubPullRequest.findUniqueOrThrow({
      where: { id: alreadyKnown.id },
    });

    serveBases({ 50: 'never-read', 51: 'main' });
    const first = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    // Only the null row was ever a candidate, so the known row was never read
    // from the host and never written — its value AND its `updated_at` stand.
    expect(first.repos[0]!.candidates).toBe(1);
    expect(first.repos[0]!.filled).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const after = await adminDb.githubPullRequest.findUniqueOrThrow({
      where: { id: alreadyKnown.id },
    });
    expect(after.baseRef).toBe('main');
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(await baseRefOf(missing.id)).toBe('main');

    // A SECOND run finds no candidates at all: zero host calls, zero writes, and
    // it never even mints a token. Idempotent by construction rather than by a
    // comparison this service could get wrong.
    fetchMock.mockClear();
    const second = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);
    expect(second.repos[0]!.candidates).toBe(0);
    expect(second.repos[0]!.filled).toBe(0);
    expect(second.reevaluated).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a DRY RUN decides and reports but writes nothing and moves no status', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    const row = await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 60,
      workItemId: item.id,
    });

    serveBases({ 60: 'main' });
    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(DRY);

    expect(report.dryRun).toBe(true);
    expect(report.repos[0]!.filled).toBe(1);
    expect(report.reevaluated).toEqual([]);
    expect(await baseRefOf(row.id)).toBeNull();
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('skips an UNMERGED row entirely — its null base is never a term in the gate', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 70,
      workItemId: item.id,
      state: 'open',
      merged: false,
    });

    serveBases({ 70: 'main' });
    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(report.repos[0]!.candidates).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts a row a LIVE DELIVERY filled first, and never clobbers its value', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    const row = await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 75,
      workItemId: item.id,
    });

    // The race the write's `base_ref IS NULL` predicate exists for: a webhook
    // delivery lands between the candidate read and this sweep's write. Driven
    // from inside the host read, which is exactly where the window is.
    fetchMock.mockImplementation(async () => {
      await adminDb.githubPullRequest.update({
        where: { id: row.id },
        data: { baseRef: 'main' },
      });
      return new Response(JSON.stringify({ base: { ref: 'stale-read' } }), { status: 200 });
    });

    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(report.repos[0]!.racedByDelivery).toBe(1);
    expect(report.repos[0]!.filled).toBe(0);
    // The DELIVERY's value stands. It came from the payload of the event itself,
    // so it is at least as good as anything read back afterwards.
    expect(await baseRefOf(row.id)).toBe('main');
  });

  it('fills an UNLINKED row and re-evaluates nothing — a mirror row is not a card', async () => {
    const { fx, repoIds } = await makeConnected();
    await heldItem(fx, ['motir-core']);
    const orphan = await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 76,
      workItemId: null,
    });

    serveBases({ 76: 'main' });
    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(report.repos[0]!.filled).toBe(1);
    expect(await baseRefOf(orphan.id)).toBe('main');
    // No work item to re-evaluate: the row is the workspace's pull-request
    // history, and the completion gate has nothing to say about it.
    expect(report.reevaluated).toEqual([]);
  });

  it('scopes to one workspace / one repo, and reports a skipped non-GitHub connection', async () => {
    const { fx, repoIds } = await makeConnected([CORE, AI]);
    const item = await heldItem(fx, ['motir-core']);
    await preColumnMergedRow({ repoId: repoIds['motir-core']!, number: 77, workItemId: item.id });
    // A GitLab project on the same installation: its merge requests are not
    // readable through this leaf, and omitting it silently would read as "there
    // were none".
    const inst = await adminDb.githubInstallation.findFirstOrThrow();
    await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: '7003',
        owner: 'moooon-B-V',
        name: 'gl-project',
        defaultBranch: 'main',
        provider: 'gitlab',
      },
    });

    const all = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(DRY);
    expect(all.repos.map((r) => r.repoRef).sort()).toEqual([
      'moooon-B-V/motir-ai',
      'moooon-B-V/motir-core',
    ]);
    expect(all.skippedNonGithub).toEqual(['moooon-B-V/gl-project']);

    const byWorkspace = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs({
      ...DRY,
      workspaceId: fx.workspaceId,
    });
    expect(byWorkspace.repos).toHaveLength(2);

    const byRepo = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs({
      ...DRY,
      repoRef: 'MOOOON-B-V/MOTIR-CORE', // case-insensitive
    });
    expect(byRepo.repos.map((r) => r.repoRef)).toEqual(['moooon-B-V/motir-core']);
  });

  it('reports a mint failure per repo rather than aborting the sweep', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    await preColumnMergedRow({ repoId: repoIds['motir-core']!, number: 78, workItemId: item.id });
    const { mintInstallationToken } = await import('@/lib/github/appAuth');
    vi.mocked(mintInstallationToken).mockRejectedValueOnce(new Error('no private key'));

    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(report.repos[0]!.error).toMatch(/could not mint an installation token: no private key/);
    expect(report.repos[0]!.filled).toBe(0);
  });

  it('records a failing repository and keeps sweeping the others', async () => {
    const { fx, repoIds } = await makeConnected([CORE, AI]);
    const item = await heldItem(fx, ['motir-core', 'motir-ai']);
    await preColumnMergedRow({ repoId: repoIds['motir-core']!, number: 80, workItemId: item.id });
    const aiRow = await preColumnMergedRow({
      repoId: repoIds['motir-ai']!,
      number: 81,
      workItemId: item.id,
    });

    // motir-core's installation lost the repo (a 403 with no throttling signal is
    // an ACCESS failure, not a rate limit); motir-ai answers.
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/motir-core/')
        ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify({ base: { ref: 'trunk' } }), { status: 200 }),
    );

    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    const failed = report.repos.find((r) => r.repoRef === 'moooon-B-V/motir-core')!;
    const ok = report.repos.find((r) => r.repoRef === 'moooon-B-V/motir-ai')!;
    expect(failed.error).toMatch(/403/);
    expect(failed.filled).toBe(0);
    expect(ok.error).toBeUndefined();
    expect(ok.filled).toBe(1);
    // Its OWN default branch — `trunk`, never a hard-coded `main`.
    expect(await baseRefOf(aiRow.id)).toBe('trunk');
    // And the item is still held, because motir-core is still unknown. One repo
    // repaired is not a repaired card. Since MOTIR-10135 motir-ai's repaired merge
    // is a LANDED delivery, so the hold is the delivery set's and names the pull
    // request rather than the repository.
    expect(report.reevaluated[0]!.outcome).toBe('held_incomplete_delivery_set');
    expect(report.reevaluated[0]!.deliveryShortfall?.unknownBase).toEqual([
      'moooon-B-V/motir-core#80',
    ]);
    expect(await statusOf(item.id)).toBe('in_review');
  });
});

describe('the re-evaluation path, without any delivery', () => {
  it('completes a TWO-repository item once the second repository is repaired', async () => {
    const { fx, repoIds } = await makeConnected([CORE, AI]);
    const item = await heldItem(fx, ['motir-core', 'motir-ai']);
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 90,
      workItemId: item.id,
      baseRef: 'main',
    });
    await preColumnMergedRow({ repoId: repoIds['motir-ai']!, number: 91, workItemId: item.id });

    // motir-core's merge LANDED, so since MOTIR-10135 the delivery set decides,
    // and it holds on motir-ai's unrecorded base.
    expect(await repoSetCompletionService.reevaluateItem(item.id)).toMatchObject({
      outcome: 'held_incomplete_delivery_set',
      deliveryShortfall: {
        outstanding: [],
        strandedBase: [],
        unknownBase: ['moooon-B-V/motir-ai#91'],
      },
    });

    serveBases({ 91: 'trunk' });
    await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(await statusOf(item.id)).toBe('done');
  });

  it('ABSTAINS on an item that names no repository — re-evaluation is not a bulk completer', async () => {
    const { fx, repoIds } = await makeConnected();
    const unpinned = await createTestWorkItem(fx, { kind: 'task', title: 'Names no repository' });
    await adminDb.workItem.update({ where: { id: unpinned.id }, data: { status: 'in_review' } });
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 100,
      workItemId: unpinned.id,
      baseRef: 'main',
    });

    const verdict = await repoSetCompletionService.reevaluateItem(unpinned.id);

    // The gate abstains on an empty set on a delivery, and must abstain here too:
    // every card in the product that never pinned a repository is in this state,
    // and a repair that completed them would be a bulk status rewrite.
    expect(verdict.outcome).toBe('abstained_no_repo_set');
    expect(await statusOf(unpinned.id)).toBe('in_review');
  });

  it('HOLDS while a linked change request is still open', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 110,
      workItemId: item.id,
      baseRef: 'main',
    });
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 111,
      workItemId: item.id,
      baseRef: 'main',
      state: 'open',
      merged: false,
    });

    const verdict = await repoSetCompletionService.reevaluateItem(item.id);

    // Stricter than the delivery path on purpose: the sync excludes the row it is
    // deciding because that one has just closed, and nothing is closing here.
    expect(verdict.outcome).toBe('held_open_change_request');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('reports an item with no linked change request rather than guessing a tenant', async () => {
    const { fx } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);

    const verdict = await repoSetCompletionService.reevaluateItem(item.id);

    // The workspace is resolved from the CONNECTION tier (the item's linked PR →
    // its repo). With no linked change request there is no trusted tenant to
    // bind, and the honest answer is to say so — an unbound `work_item` read
    // would have returned zero rows and reported "no such work item" for an item
    // that plainly exists (MOTIR-2880).
    expect(verdict.outcome).toBe('no_linked_change_request');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('a DRY RUN reports what it WOULD complete without moving the status', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 115,
      workItemId: item.id,
      baseRef: 'main',
    });

    const verdict = await repoSetCompletionService.reevaluateItem(item.id, { dryRun: true });

    expect(verdict).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('reports ACCESS DENIED when no one in the workspace can author the move', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 116,
      workItemId: item.id,
      baseRef: 'main',
    });
    // The move is attributed to the workspace OWNER — there is no change-request
    // author on this path, because nobody delivered anything.
    await adminDb.workspaceMembership.deleteMany({ where: { workspaceId: fx.workspaceId } });

    const verdict = await repoSetCompletionService.reevaluateItem(item.id);

    expect(verdict.outcome).toBe('access_denied');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('reports NO MATCHING STATUS on a workflow with nothing in the done category', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 117,
      workItemId: item.id,
      baseRef: 'main',
    });
    // A custom workflow with no done-category status. The target is resolved BY
    // CATEGORY against the project's live workflow, never a hard-coded key, so
    // the honest answer here is "this project has nowhere to move it to" — a
    // reported no-op, never a crash and never an invented status.
    await adminDb.workflowStatus.deleteMany({
      where: { projectId: fx.projectId, category: 'done' },
    });

    expect((await repoSetCompletionService.reevaluateItem(item.id)).outcome).toBe(
      'no_matching_status',
    );
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it("reports NO WORK ITEM when the linked row points OUTSIDE the repository's tenant", async () => {
    // The integrity violation the bound read exists to make visible. The
    // workspace comes from the CONNECTION tier (repo → workspace), and the item
    // is read under THAT binding — so a row linking a repository in one tenant to
    // an item in another resolves a workspace and then finds no item. Reported,
    // never guessed around: the alternative is an unbound read, which is how a
    // cross-tenant write gets made (MOTIR-2880).
    const { repoIds } = await makeConnected();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await heldItem(other, ['motir-core'], 'In another tenant');
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 118,
      workItemId: foreign.id,
      baseRef: 'main',
    });

    const verdict = await repoSetCompletionService.reevaluateItem(foreign.id);

    expect(verdict.outcome).toBe('no_work_item');
    expect(await statusOf(foreign.id)).toBe('in_review');
  });

  it('is a NO-OP on an item already Done, and reports it as one', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 120,
      workItemId: item.id,
      baseRef: 'main',
    });

    expect((await repoSetCompletionService.reevaluateItem(item.id)).outcome).toBe('noop');
    expect(await statusOf(item.id)).toBe('done');
  });

  it('reports an ILLEGAL transition rather than forcing a card out of To Do', async () => {
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'todo' } });
    await preColumnMergedRow({
      repoId: repoIds['motir-core']!,
      number: 130,
      workItemId: item.id,
      baseRef: 'main',
    });

    // The default workflow has no `todo → done` edge, and the repair is not
    // entitled to invent one — it goes through the shipped write authority and
    // reports what that authority said.
    expect((await repoSetCompletionService.reevaluateItem(item.id)).outcome).toBe(
      'illegal_transition',
    );
    expect(await statusOf(item.id)).toBe('todo');
  });
});

// ── PROVENANCE: which App this backfill mints through (MOTIR-5843) ───────────
//
// `sweepRepo` holds `repo.owner` and passed the seam nothing, so a hosted
// repository's sweep minted through the user-facing App — which is not installed
// on it. The refusal lands in `report.error` as a per-repo string and the rows
// stay unanswered, so the completion gate keeps holding cards on a base ref that
// could have been read at any time.
//
// ⚠️ MEASURED ON THE TOKEN THE READ CARRIED. `appAuth` is mocked at module scope
// in this file (a real mint needs an App private key), so the "wire only one App"
// arm cannot bite here; the mint stamps the resolved ROLE into its token instead.
describe('the App is chosen by the repository’s provenance', () => {
  function serveBasesCapturingToken(bases: Record<number, string>): { token: () => string } {
    let seen = '';
    fetchMock.mockImplementation(async (url: string, init?: unknown) => {
      const bearer = (init as { headers?: Record<string, string> } | undefined)?.headers?.[
        'authorization'
      ];
      if (bearer) seen = bearer.replace(/^Bearer /, '');
      const number = Number(url.split('/').pop());
      const ref = bases[number];
      return ref === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ number, base: { ref } }), { status: 200 });
    });
    return { token: () => seen };
  }

  async function stampTokensWithRole() {
    const { mintInstallationToken } = await import('@/lib/github/appAuth');
    vi.mocked(mintInstallationToken).mockImplementation(async (_id, role) => ({
      token: `ghs_${role ?? 'defaulted'}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    }));
  }

  afterEach(async () => {
    const { mintInstallationToken } = await import('@/lib/github/appAuth');
    vi.mocked(mintInstallationToken).mockImplementation(async () => ({
      token: 'ghs_test',
      expiresAt: new Date(Date.now() + 3_600_000),
    }));
  });

  it('a HOSTED repository is read with a PROVISIONING-App token', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'moooon-B-V');
    await stampTokensWithRole();
    const { fx, repoIds } = await makeConnected();
    const item = await heldItem(fx, ['motir-core']);
    await preColumnMergedRow({ repoId: repoIds['motir-core']!, number: 2121, workItemId: item.id });
    const captured = serveBasesCapturingToken({ 2121: 'main' });

    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(report.repos[0]!.error).toBeUndefined();
    expect(report.repos[0]!.filled).toBe(1);
    expect(captured.token()).toBe('ghs_provisioning');
  });

  it('CONTROL — a CUSTOMER-OWNED repository is still read with a USER-FACING token, with the provisioning org configured', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    await stampTokensWithRole();
    const { fx, repoIds } = await makeConnected([CORE], 'acme-corp');
    const item = await heldItem(fx, ['motir-core']);
    await preColumnMergedRow({ repoId: repoIds['motir-core']!, number: 2121, workItemId: item.id });
    const captured = serveBasesCapturingToken({ 2121: 'main' });

    const report = await pullRequestBaseRefBackfillService.backfillMissingBaseRefs(APPLY);

    expect(report.repos[0]!.error).toBeUndefined();
    expect(report.repos[0]!.filled).toBe(1);
    expect(captured.token()).toBe('ghs_user-facing');
  });
});
