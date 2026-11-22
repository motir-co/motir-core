// E2E: the STORY's verification recipe, automated
// (Story MOTIR-3417 · Subtask MOTIR-3487; re-written for the handoff by MOTIR-11884).
//
// @smoke — every default-branch push is its OWN refresh run on the Postgres
// engine, handed off to motir-ai and settled on the published head; two
// repositories stay independent; and a worker killed mid-run resumes on the SAME
// handoff rather than handing the commit off again.
//
// ⚠️ WHAT CHANGED (MOTIR-11884). This spec used to assert that a push BURST
// coalesced into ONE run, through the refresh job's two-minute debounce. The
// debounce is gone: each refresh is handed off to motir-ai, and motir-codegraph's
// own queue supersedes a still-queued push of the same repository and ref, so
// coalescing in motir-core would only delay the newest push. The properties the
// spec existed for are kept and re-asserted — one run per event, repositories
// independent, the ledger contract, a resume that does not repeat the side effect.
//
// ⚠️ NOTHING HERE REACHES THE NETWORK. Every boundary the worker crosses —
// GitHub's token, live head and tarball redirect, motir-ai's handoff and status —
// is an undici intercept in `lib/test-code-graph-mock.ts`, and the archive host
// carries a trap that fails loudly if anything fetches bytes in-process.

import { expect, test, type APIRequestContext } from '@playwright/test';
import { resetDatabase, adminDb, truncateJobTables } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { postSignedWebhook } from './_helpers/github-seed';
import { killJobWorker, startJobWorker } from './_helpers/job-worker-process';
import {
  E2E_INDEX_INSTALLATION_ID,
  E2E_INDEX_REPOS,
  indexRepoRef,
  seedConnectedRepos,
} from './_helpers/migrate-index-seed';

const REFRESH_JOB = 'system.code-graph-refresh';
const [STOREFRONT, BILLING_API] = E2E_INDEX_REPOS;

// ⚠️ THE ONE LONG WAIT IS EXPRESSED AS STATE. A SIGKILLed worker holds its claim
// for `LEASE_MS` (60 s); the kill test makes the row claimable instead of sleeping
// through it, and the lease's length is asserted by value in
// `tests/jobs/supervisor-cutover-story-gate.test.ts`.
test.describe.configure({ timeout: 240_000, mode: 'serial' });

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

test.afterEach(async () => {
  // Unconditional: a spec that leaves the routing set hands the next one a server
  // running this job on a lane it was not written against — and `jobs-flow.spec.ts`
  // asserts the opposite lane against this same server.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

// ── helpers ────────────────────────────────────────────────────────────────

type SeedRepo = (typeof E2E_INDEX_REPOS)[number];

function pushPayload(repo: SeedRepo, head: string) {
  return {
    ref: `refs/heads/${repo.defaultBranch}`,
    after: head,
    installation: { id: Number(E2E_INDEX_INSTALLATION_ID) },
    repository: {
      // The STORED provider id — `handlePush` resolves the repo by
      // `(installation, providerRepoId)` and answers 2xx `unknown_repo` for a
      // mismatch, which is why every delivery below asserts the OUTCOME.
      id: Number(repo.providerRepoId),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner },
    },
  };
}

/** Deliver one push and assert it actually enqueued, rather than merely 2xx'd. */
async function push(request: APIRequestContext, repo: SeedRepo, head: string): Promise<void> {
  const res = await postSignedWebhook(request, 'push', pushPayload(repo, head));
  expect(res.status()).toBeLessThan(300);
  // ⚠️ THE OUTCOME, NOT THE STATUS. The ack never hinges on the queue, so
  // `unknown_installation` / `unknown_repo` / `ignored_ref` are all 2xx. A status
  // assertion alone would pass on a burst that enqueued nothing and leave the
  // failure to surface minutes later as a missing row.
  expect(await res.json()).toMatchObject({ result: { outcome: 'refresh_enqueued' } });
}

/** Sign up, make a project, and connect `repos` — the state a refresh needs. */
async function seedWorkspace(page: Parameters<typeof signUp>[0], repos: SeedRepo[]) {
  const email = `refresh-engine-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  await signUp(page, email);
  // ⚠️ NO `createFirstProject` HERE (MOTIR-4876). Registration now SEEDS a
  // project at the workspace tier, so the workspace already holds exactly one
  // and creating another made it two — which this test can SEE, because
  // `projectsIndexed` counts every project in the workspace and the fan-out is
  // one container per (repo × project). The assertion below is `1`, and it is
  // the faithful number: a real account that has just registered has one
  // project, not two.
  const local = email.split('@')[0]!;
  const ws = await adminDb.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  await seedConnectedRepos(ws.id, repos);
  return ws;
}

const queuedRows = () => adminDb.jobQueueRun.findMany({ where: { jobId: REFRESH_JOB } });
const ledgerRows = () => adminDb.jobRun.findMany({ where: { functionId: REFRESH_JOB } });
const succeeded = async () => (await ledgerRows()).filter((r) => r.status === 'succeeded');

// ─────────────────────────────────────────────────────────────────────────────

test('a same-repo BURST is one run PER push, each handed off — nothing coalesces @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!]);

  for (const head of ['sha-1', 'sha-2', 'sha-3', 'sha-4']) {
    await push(request, STOREFRONT!, head);
  }

  // ⚠️ THE COUNT IS THE ASSERTION. Four pushes, four runs, each due at once and
  // none carrying a debounce key — the shape a coalescing debounce would collapse.
  const rows = await queuedRows();
  expect(rows, 'four pushes, four runs').toHaveLength(4);
  expect(new Set(rows.map((r) => r.eventId)).size).toBe(4);
  expect(rows.every((r) => r.debounceKey === null)).toBe(true);
  expect(rows.every((r) => r.runAt.getTime() <= Date.now())).toBe(true);

  await expect
    .poll(async () => (await succeeded()).length, {
      message: 'every refresh should settle on the engine',
      timeout: 120_000,
      intervals: [500],
    })
    .toBe(4);

  // Each one hands off and writes the ledger contract: one `output.repoRef`,
  // marked as indexed by motir-codegraph.
  for (const run of await ledgerRows()) {
    expect(run.output).toMatchObject({
      indexed: true,
      repoRef: indexRepoRef(STOREFRONT!),
      projectsIndexed: 1,
      indexedBy: 'motir-codegraph',
    });
  }
  // The steps, observed from outside the process: the head, the push comparison
  // (a push carries `refreshCause: 'push'`) and ONE handoff per run; never a
  // container step.
  for (const row of rows) {
    const ids = (await adminDb.jobStep.findMany({ where: { runId: row.id } })).map((s) => s.stepId);
    expect(ids).toEqual(
      expect.arrayContaining(['index-head-v1', 'index-push-diff-v1', 'index-handoff-v1']),
    );
    expect(ids.filter((id) => /^index-(admit|boot|settle):/.test(id))).toEqual([]);
  }
  expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
});

test('a burst across TWO repos is run per push, per repository — they stay independent @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!, BILLING_API!]);

  await push(request, STOREFRONT!, 'sf-1');
  await push(request, BILLING_API!, 'ba-1');
  await push(request, STOREFRONT!, 'sf-2');
  await push(request, BILLING_API!, 'ba-2');

  expect(await queuedRows(), 'four pushes, four runs').toHaveLength(4);

  await expect
    .poll(async () => (await succeeded()).length, {
      message: 'every run should settle',
      timeout: 120_000,
      intervals: [500],
    })
    .toBe(4);

  // ONE `output.repoRef` per run, two per repository — the per-repo ledger
  // contract §6 forces, which a dispatch that BATCHED would fail.
  const refs = (await ledgerRows())
    .map((r) => (r.output as { repoRef?: string } | null)?.repoRef)
    .sort();
  expect(refs).toEqual(
    [
      indexRepoRef(BILLING_API!),
      indexRepoRef(BILLING_API!),
      indexRepoRef(STOREFRONT!),
      indexRepoRef(STOREFRONT!),
    ].sort(),
  );
});

test('a pushed refresh settles in the ledger @smoke', async ({ page, request }) => {
  await seedWorkspace(page, [STOREFRONT!]);
  await push(request, STOREFRONT!, 'dash-1');

  await expect
    .poll(async () => (await ledgerRows())[0]?.status ?? 'none', {
      message: 'the refresh should settle in the ledger',
      timeout: 120_000,
      intervals: [500],
    })
    .toBe('succeeded');

  // ⚠️ A DASHBOARD STEP STOOD HERE (Story MOTIR-4843 · MOTIR-4861), and its
  // surface is retired (Story MOTIR-9982 · MOTIR-10042): it opened the tenant
  // Job runs dashboard to see this refresh's row. The ledger is staff-only at
  // `/admin/jobs` now, covered by its own specs; the settled ledger row polled
  // above is the claim.
});

test('a worker KILLED mid-run resumes on the SAME handoff — handed once, one ledger row @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!]);
  await push(request, STOREFRONT!, 'restart-1');

  const [queued] = await queuedRows();
  expect(queued).toBeDefined();

  // ⚠️ WAIT FOR THE HANDOFF STEP, NOT FOR A TIMER. `index-handoff-v1` in
  // `job_step` is the authoritative signal that motir-ai has the commit and the
  // run is polling — which is precisely "mid-run". The seam answers "running" for
  // a moment after a handoff, so the run defers at least once.
  const handoffMemo = async () =>
    (
      await adminDb.jobStep.findFirst({
        where: { runId: queued!.id, stepId: 'index-handoff-v1' },
      })
    )?.result as { jobId?: string } | null | undefined;
  await expect
    .poll(async () => (await handoffMemo())?.jobId ?? null, {
      message: 'the run should hand the commit off',
      timeout: 120_000,
      intervals: [250],
    })
    .not.toBeNull();
  const handedJobId = (await handoffMemo())!.jobId;

  // THE KILL — SIGKILL, not the graceful drain.
  await killJobWorker();

  // Between polls the row is `pending` and unclaimed; a kill inside one pass leaves
  // it `running` with a lease nobody renews. Both are correct, and both are made
  // claimable in one write rather than waiting out `LEASE_MS`.
  const orphaned = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: queued!.id } });
  expect(orphaned.state).toMatch(/^(running|pending|succeeded)$/);
  await adminDb.jobQueueRun.update({
    where: { id: queued!.id },
    data: { leaseExpiresAt: new Date(Date.now() - 1_000), runAt: new Date(Date.now() - 1_000) },
  });

  await startJobWorker();

  await expect
    .poll(async () => (await ledgerRows())[0]?.status ?? 'none', {
      message: 'the resumed run should settle',
      timeout: 120_000,
      intervals: [500],
    })
    .toBe('succeeded');

  // ⚠️ THE ASSERTION THE TEST TURNS ON: THE SAME HANDOFF. The handoff sits inside
  // a memoized step, so the resumed pass replayed it rather than handing the
  // commit off a second time — its recorded job is the one handed before the kill.
  expect((await handoffMemo())!.jobId, 'handed off once, across both workers').toBe(handedJobId);
  const runs = await ledgerRows();
  expect(runs, 'one job_run, not one per pass').toHaveLength(1);
  expect(runs[0]!.output).toMatchObject({
    indexed: true,
    repoRef: indexRepoRef(STOREFRONT!),
    indexedBy: 'motir-codegraph',
  });
});
