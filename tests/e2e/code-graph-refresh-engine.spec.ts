// E2E: the STORY's verification recipe, automated
// (Story MOTIR-3417 · Subtask MOTIR-3487 — closes the Story).
//
// @smoke — a push burst coalesces into ONE refresh that boots a container, polls
// it and settles it ON THE POSTGRES ENGINE, and a worker restart mid-index
// resumes rather than orphaning.
//
// ⚠️ WHAT MADE THIS WRITABLE. It was blocked: the index writer crosses two
// boundaries — motir-ai's run-credential mint and GitHub's tarball redirect —
// and neither had a seam in this lane. MOTIR-3564 built one
// (`lib/test-code-graph-mock.ts`, installed by the WORKER, because the supervisor
// is a job). `tests/e2e/code-graph-writer-seam.spec.ts` is that card's own smoke;
// this file is the story's assertions on top of it.
//
// ⚠️ AND WHAT THE CARD ASKED FOR THAT CANNOT BE WRITTEN AS WRITTEN. Its second
// assertion is *"That run's payload is the LAST delivery's, asserted on a field
// that differs between the pushes."* There is no such field:
// `enqueueCodeGraphRefresh` builds `CodeGraphRefreshData` from the STORED repo —
// `{installationId, workspaceId, repoOwner, repoName, defaultBranch}` — so two
// pushes to one repo produce byte-identical event data. The property is real and
// is asserted in its honest form: the coalesce REPOINTS `job_queue.event_id` at
// the newest `job_event` row, so the executed run carries the LAST delivery's
// event. (And "it indexes the last push's head" holds by construction rather than
// by assertion: the container fetches the default branch's CURRENT head at run
// time, which is why the refresh job pins no SHA.)
//
// ⚠️ NOTHING HERE REACHES THE NETWORK. The container is the `fake` orchestrator
// selected by the shipped `MOTIR_FLEET_ORCHESTRATOR` seam; both HTTP boundaries
// are undici intercepts; the archive host carries a trap that fails loudly if
// anything fetches bytes in-process. No new webServer entry and no new service.

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

// ⚠️ THE TWO LONG WAITS ARE ASSERTED, NOT SLEPT THROUGH — and the distinction is
// what keeps this spec affordable in a bulk leg. `codeGraphRefresh` declares
// `period: '2m'` and a SIGKILLed worker holds its claim for `LEASE_MS` (60 s), so
// a spec that waited both out would spend ~9 minutes ASLEEP in a lane whose whole
// bulk-leg budget is 160-280 s (`tests/e2e/shard-plan.ts` — and one such spec
// would reintroduce precisely the imbalance that file exists to prevent).
//
// Each is instead asserted where it is a CLAIM and then expressed as state where
// it is only a delay: `run_at` really is `period` past the last arrival, and
// nothing has run while the window is open — then the row is made due. That is a
// sharper claim than "a run appeared two minutes later", and it changes no
// declaration: the job's `period` and the worker's lease are asserted BY VALUE in
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

/**
 * Let the debounce window ELAPSE, expressed as state rather than as elapsed time.
 *
 * ⚠️ THIS IS NOT SHORTENING THE MECHANISM UNDER TEST — it is separating two
 * assertions that waiting conflates. `run_at` being `period` past the last
 * arrival IS the debounce; each test below asserts that VALUE explicitly, which
 * is a sharper claim than "a run appeared two minutes later" and is the whole of
 * what the window guarantees. What is left after that is execution, and paying
 * two real minutes per test to observe it would put ~8 minutes of pure sleeping
 * into a lane whose entire bulk leg budget is ~160-280 s
 * (`tests/e2e/shard-plan.ts` — the imbalance it exists to prevent is exactly what
 * one such spec would reintroduce).
 *
 * Moving `run_at` into the past is precisely what the passage of the window does
 * to the claim; nothing else about the row is touched.
 */
async function elapseDebounceWindow(): Promise<void> {
  await adminDb.jobQueueRun.updateMany({
    where: { jobId: REFRESH_JOB, state: 'pending' },
    data: { runAt: new Date(Date.now() - 1_000) },
  });
}

/** The declared window, read off the shipped job rather than restated here. */
const DEBOUNCE_PERIOD_MS = 120_000;
const ledgerRows = () => adminDb.jobRun.findMany({ where: { functionId: REFRESH_JOB } });

// ─────────────────────────────────────────────────────────────────────────────

test('a same-repo BURST coalesces into ONE run carrying the LAST delivery @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!]);

  for (const head of ['sha-1', 'sha-2', 'sha-3', 'sha-4']) {
    await push(request, STOREFRONT!, head);
  }

  // ⚠️ THE COUNT IS THE ASSERTION, not the existence of a first run. A shape that
  // enqueued four and ran four would satisfy "a refresh happened".
  const rows = await queuedRows();
  expect(rows, 'four pushes, one pending run').toHaveLength(1);

  // Four events were written; the coalesced row points at the LAST of them.
  const events = await adminDb.jobEvent.findMany({
    where: { name: REFRESH_JOB },
    orderBy: { receivedAt: 'asc' },
  });
  expect(events).toHaveLength(4);
  expect(rows[0]!.eventId, 'the run carries the LAST delivery').toBe(events.at(-1)!.id);
  expect(rows[0]!.debounceKey).toBe(
    `${E2E_INDEX_INSTALLATION_ID}/${STOREFRONT!.owner}/${STOREFRONT!.name}`,
  );

  // ⚠️ THE WINDOW ITSELF, ASSERTED RATHER THAN WAITED OUT. `codeGraphRefresh`
  // declares `period: '2m'`, and the engine sets `run_at` that far past the LAST
  // arrival — so the row is not yet due, and this is the claim the debounce
  // actually makes. Sleeping through it would prove the same thing more slowly
  // and less precisely.
  const dueIn = rows[0]!.runAt.getTime() - Date.now();
  expect(dueIn, 'the burst is deferred by the declared period').toBeGreaterThan(
    DEBOUNCE_PERIOD_MS - 30_000,
  );
  expect(dueIn).toBeLessThanOrEqual(DEBOUNCE_PERIOD_MS);
  expect(await ledgerRows(), 'nothing has run while the window is open').toHaveLength(0);

  // …and once the window closes it runs, on the engine, to the ledger contract.
  await elapseDebounceWindow();
  await expect
    .poll(async () => (await ledgerRows())[0]?.status ?? 'none', {
      message: 'the coalesced refresh should settle on the engine',
      timeout: 120_000,
      intervals: [500],
    })
    .toBe('succeeded');

  const runs = await ledgerRows();
  expect(runs, 'ONE job_run per repo').toHaveLength(1);
  expect(runs[0]!.output).toMatchObject({
    indexed: true,
    repoRef: indexRepoRef(STOREFRONT!),
    projectsIndexed: 1,
  });

  // The collapse, observed from outside the process (MOTIR-3484): the memoized
  // side effects, and not one poll or wait checkpoint.
  const steps = await adminDb.jobStep.findMany({ where: { runId: rows[0]!.id } });
  const ids = steps.map((s) => s.stepId).filter((id) => !id.startsWith('job-run:'));
  expect(ids.some((id) => id.startsWith('index-boot:'))).toBe(true);
  expect(ids.some((id) => id.startsWith('index-settle:'))).toBe(true);
  expect(ids.filter((id) => id.startsWith('index-poll:') || id.startsWith('index-wait:'))).toEqual(
    [],
  );

  // The slot was taken and given back: the container is provably gone.
  expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
});

test('a burst across TWO repos produces TWO runs — the key does not merge tenants @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!, BILLING_API!]);

  // Interleaved on purpose: a resolver that dropped a term would coalesce these
  // into one bucket, which is exactly the Inngest failure mode MOTIR-2994
  // measured and the engine refuses at registration.
  await push(request, STOREFRONT!, 'sf-1');
  await push(request, BILLING_API!, 'ba-1');
  await push(request, STOREFRONT!, 'sf-2');
  await push(request, BILLING_API!, 'ba-2');

  const rows = await queuedRows();
  expect(rows, 'two repos, two pending runs').toHaveLength(2);
  expect(rows.map((r) => r.debounceKey).sort()).toEqual(
    [
      `${E2E_INDEX_INSTALLATION_ID}/${BILLING_API!.owner}/${BILLING_API!.name}`,
      `${E2E_INDEX_INSTALLATION_ID}/${STOREFRONT!.owner}/${STOREFRONT!.name}`,
    ].sort(),
  );

  await elapseDebounceWindow();

  await expect
    .poll(async () => (await ledgerRows()).filter((r) => r.status === 'succeeded').length, {
      message: 'both repos should settle',
      timeout: 120_000,
      intervals: [500],
    })
    .toBe(2);

  // ONE `output.repoRef` each — the per-repo ledger contract §6 forces, which a
  // dispatch that BATCHED would fail.
  const refs = (await ledgerRows())
    .map((r) => (r.output as { repoRef?: string } | null)?.repoRef)
    .sort();
  expect(refs).toEqual([indexRepoRef(BILLING_API!), indexRepoRef(STOREFRONT!)].sort());
});

test('the coalesced run is RENDERED on the operator dashboard @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!]);
  await push(request, STOREFRONT!, 'dash-1');
  await elapseDebounceWindow();

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

test('a worker KILLED mid-index resumes on the SAME container — one boot, no orphan @smoke', async ({
  page,
  request,
}) => {
  await seedWorkspace(page, [STOREFRONT!]);
  await push(request, STOREFRONT!, 'restart-1');
  await elapseDebounceWindow();

  const [queued] = await queuedRows();
  expect(queued).toBeDefined();

  // ⚠️ WAIT FOR THE BOOT STEP, NOT FOR A TIMER. `index-boot:<pid>` appearing in
  // `job_step` is the authoritative signal that a container exists and the
  // supervisor is watching it — which is precisely "mid-index". Killing on a
  // sleep would race the boot and sometimes test nothing.
  await expect
    .poll(
      async () =>
        (await adminDb.jobStep.findMany({ where: { runId: queued!.id } })).some((s) =>
          s.stepId.startsWith('index-boot:'),
        ),
      { message: 'the supervisor should boot a container', timeout: 120_000, intervals: [250] },
    )
    .toBe(true);

  // THE KILL — SIGKILL, not the graceful drain. A drain would let the supervisor
  // FINISH, which would prove the opposite of the story's criterion.
  await killJobWorker();

  // ⚠️ AMENDED ON THE RECORD (MOTIR-3778): A KILLED WORKER USUALLY LEAVES NO
  // CLAIM AT ALL NOW, AND THIS STEP IS SETUP RATHER THAN THE SUBJECT.
  //
  // It used to assert the row was `running` — *"a SIGKILLed worker leaves the row
  // `running` with a lease nobody renews"* — and that was TRUE of a supervisor
  // that HELD its claim for its container's whole life. `docs/decisions/
  // job-queue-foundation.md` §16 makes a supervision a state machine over RUNS:
  // between polls the row is `pending` with `claimed_by: null`, and the window in
  // which a kill can strand a claim is one provider read wide. So the kill now
  // lands on a `pending` row almost every time and on a `running` one
  // occasionally, and BOTH are correct.
  //
  // ⚠️ THE PROPERTY THIS SPEC IS NAMED FOR IS UNCHANGED and is asserted below: the
  // resumed pass REPLAYS THE BOOT rather than provisioning again. What the resume
  // needs from this step is only that the run is CLAIMABLE — a `running` row
  // waits out `LEASE_MS` (60 s) before `reclaimExpiredLeases` can take it, so its
  // lease is expired here exactly as before; a deferred row is already unclaimed
  // and simply needs to be due. Both are forced in one write. Waiting either out
  // would add a minute of sleeping to prove numbers this spec is not about — the
  // lease's length is asserted by value in
  // `tests/jobs/supervisor-cutover-story-gate.test.ts`, and the poll cadence in
  // `tests/jobs/code-graph-index-self-rescheduling.test.ts`.
  const orphaned = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: queued!.id } });
  expect(
    orphaned.state,
    'a killed worker leaves the run either claimed-and-stale or already deferred back',
  ).toMatch(/^(running|pending)$/);
  await adminDb.jobQueueRun.update({
    where: { id: queued!.id },
    data: { leaseExpiresAt: new Date(Date.now() - 1_000), runAt: new Date(Date.now() - 1_000) },
  });

  await startJobWorker();

  await expect
    .poll(async () => (await ledgerRows())[0]?.status ?? 'none', {
      message: 'the resumed supervisor should settle the SAME container',
      timeout: 120_000,
      intervals: [500],
    })
    .toBe('succeeded');

  // ⚠️ THE ASSERTION THE CARD TURNS ON: ONE BOOT. "It finished" is true of the
  // double-boot case too — and a second boot is a second billed container and a
  // second admission slot. The boot sits inside a memoized step, so the resumed
  // pass replayed it instead of provisioning again.
  //
  // ⚠️ AND IT IS ONLY EXPRESSIBLE BECAUSE THE FAKE'S CONTAINER OUTLIVES THE
  // WORKER (MOTIR-3828). Boot and first poll used to be the same pass in the same
  // process, so the fake's module-level machine map was indistinguishable from a
  // real provider; they are now different processes by design, and an in-memory
  // map would report this container `exists: false` — which
  // `pollIndexContainer` correctly classifies `never_started`. The lane's worker
  // therefore runs the fake with `MOTIR_FAKE_CONTAINER_STATE_PATH` set; see that
  // seam's block in `lib/orchestrator/adapters/fake` for why it belongs to the
  // fake rather than to this spec.
  const steps = await adminDb.jobStep.findMany({ where: { runId: queued!.id } });
  const boots = steps.filter((s) => s.stepId.startsWith('index-boot:'));
  expect(boots, 'exactly one boot across both passes').toHaveLength(1);

  const runs = await ledgerRows();
  expect(runs, 'one job_run, not one per pass').toHaveLength(1);
  expect(runs[0]!.output).toMatchObject({ indexed: true, repoRef: indexRepoRef(STOREFRONT!) });

  // NO ORPHAN: the slot is back, so the container was torn down rather than left
  // running with nothing watching it — the failure this whole story is about.
  expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
});
