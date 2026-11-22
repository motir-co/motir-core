// E2E: the index WRITER path actually executes in this lane
// (Story MOTIR-3417 · Subtask MOTIR-3564; re-pointed at the handoff by MOTIR-11884).
//
// ⚠️ THIS IS THE SEAM'S OWN PROOF, NOT THE STORY'S E2E. It asserts exactly one
// thing: that a `system.code-graph-refresh` run claimed by the lane's worker
// reaches a SUCCEEDED ledger row through the path the job really takes — since
// MOTIR-11883, the handoff to motir-ai (read the head, hand off, poll the status)
// rather than a container. `code-graph-refresh-engine.spec.ts` builds the story's
// assertions on top of it.
//
// ⚠️ THE SEAM. `lib/test-code-graph-mock.ts` stubs the boundaries the worker
// crosses — GitHub's installation token, its live head and tarball redirect, and
// motir-ai's handoff and status routes; the worker installs it, because the index
// is a JOB and the worker is the process that makes the calls.
//
// ⚠️ AND NOTHING HERE REACHES THE NETWORK. Every boundary is an undici intercept,
// and the download host carries a trap that fails loudly if anything ever tries to
// fetch the archive in-process.

import { expect, test } from '@playwright/test';
import { resetDatabase, adminDb, truncateJobTables } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { postSignedWebhook } from './_helpers/github-seed';
import {
  E2E_INDEX_INSTALLATION_ID,
  E2E_INDEX_REPOS,
  indexRepoRef,
  seedConnectedRepos,
} from './_helpers/migrate-index-seed';

const REFRESH_JOB = 'system.code-graph-refresh';
const [REPO] = E2E_INDEX_REPOS;

// A handed-off run polls the status at the shipped 5 s cadence until the seam
// reads published, plus the worker's claim interval. There is no debounce window
// to wait out since MOTIR-11884: the row is due the moment the webhook writes it.
test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

test.afterEach(async () => {
  // Unconditional: a spec that leaves the routing set hands the next spec a
  // server running this job on a lane it was not written against.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/** The `push` delivery a default-branch commit produces. */
function pushPayload(head: string) {
  return {
    ref: `refs/heads/${REPO!.defaultBranch}`,
    after: head,
    installation: { id: Number(E2E_INDEX_INSTALLATION_ID) },
    repository: {
      // ⚠️ THE STORED PROVIDER ID, not an invented one. `handlePush` resolves the
      // repo by `(installation, providerRepoId)`, and a mismatch returns 2xx with
      // `unknown_repo` — which is why the assertion below is on the OUTCOME and
      // not on the status.
      id: Number(REPO!.providerRepoId),
      name: REPO!.name,
      full_name: `${REPO!.owner}/${REPO!.name}`,
      default_branch: REPO!.defaultBranch,
      owner: { login: REPO!.owner },
    },
  };
}

test('a push drives the index writer to a SUCCEEDED ledger row on the engine @smoke', async ({
  page,
  request,
}) => {
  const email = `writer-seam-${Date.now()}@example.test`;
  await signUp(page, email);
  // ⚠️ NO `createFirstProject` HERE (MOTIR-4876). Registration now SEEDS a
  // project at the workspace tier, so the workspace already holds exactly one
  // and creating another made it two — which this test can SEE, because
  // `projectsIndexed` counts every project in the workspace and the fan-out is
  // one container per (repo × project). The assertion below is `1`, and it is
  // the faithful number: a real account that has just registered has one
  // project, not two.

  const local = email.split('@')[0]!;
  const ws = await adminDb.workspace.findFirstOrThrow({
    where: { name: `${local}'s Workspace` },
  });
  await seedConnectedRepos(ws.id, [REPO!]);

  const res = await postSignedWebhook(request, 'push', pushPayload('sha-writer-seam'));
  expect(res.status(), 'the webhook route must accept the delivery').toBeLessThan(300);
  // ⚠️ THE OUTCOME, NOT THE STATUS. `handlePush` answers 2xx for
  // `unknown_installation`, `unknown_repo` and `ignored_ref` alike — the ack never
  // hinges on the queue — so a status assertion alone would pass on a delivery
  // that enqueued nothing and leave the real failure to surface 150 seconds later
  // as a missing ledger row.
  expect(await res.json()).toMatchObject({ result: { outcome: 'refresh_enqueued' } });

  // ⚠️ DUE AT ONCE (MOTIR-11884): no debounce, so nothing is moved here.
  const [due] = await adminDb.jobQueueRun.findMany({ where: { jobId: REFRESH_JOB } });
  expect(due!.runAt.getTime(), 'the refresh is due when it is written').toBeLessThanOrEqual(
    Date.now(),
  );
  expect(due!.debounceKey).toBeNull();

  // ⚠️ THE AUTHORITATIVE SIGNAL IS THE LEDGER ROW, never a timer and never a
  // rendered pixel. The run is claimed by the worker, hands off, defers across
  // status polls and then settles — so the wait is on the row reaching a TERMINAL
  // state, and the assertion is on what it says.
  await expect
    .poll(
      async () =>
        (
          await adminDb.jobRun.findFirst({
            where: { functionId: REFRESH_JOB },
            orderBy: { startedAt: 'desc' },
          })
        )?.status ?? 'none',
      {
        message: 'the refresh run should reach a terminal state on the engine',
        timeout: 120_000,
        intervals: [500],
      },
    )
    .toBe('succeeded');

  // ONE row per repo, carrying ONE `output.repoRef` — the contract MOTIR-3417
  // refuses to let this story change, and the thing `listSucceededCodeGraphIndexRepoRefs`
  // and the onboarding wizard both read.
  const runs = await adminDb.jobRun.findMany({ where: { functionId: REFRESH_JOB } });
  expect(runs).toHaveLength(1);
  expect(runs[0]!.output).toMatchObject({
    indexed: true,
    repoRef: indexRepoRef(REPO!),
    projectsIndexed: 1,
    indexedBy: 'motir-codegraph',
  });

  // ⚠️ AND IT REALLY WENT THROUGH THE HANDOFF, which is what distinguishes this
  // from a seeded row. The memoized steps are the evidence: a run that
  // short-circuited would have written none of them, and one that took the
  // container path would have written `index-boot:`.
  const queued = await adminDb.jobQueueRun.findFirstOrThrow({
    where: { jobId: REFRESH_JOB },
  });
  expect(queued.state).toBe('succeeded');
  const steps = await adminDb.jobStep.findMany({ where: { runId: queued.id } });
  const ids = steps.map((s) => s.stepId).filter((id) => !id.startsWith('job-run:'));
  expect(ids).toEqual(
    expect.arrayContaining(['resolve-target-v2', 'index-head-v1', 'index-handoff-v1']),
  );
  expect(ids.filter((id) => /^index-(admit|boot|settle):/.test(id))).toEqual([]);
  // ⚠️ THE SOURCE URL IS A BEARER SECRET: no memo the run wrote carries it.
  expect(JSON.stringify(steps.map((s) => s.result))).not.toContain('E2E_PRESIGNED');

  // And no fleet capacity was ever taken.
  expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
});
