import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import { jobServices } from '@/lib/jobs/services';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import {
  DEFAULT_INDEX_IN_FLIGHT_CAP,
  indexInFlightCap,
  orgIndexInFlightCap,
} from '@/lib/ciFleet/limits';
import { fakeOrchestrator } from '@motir/orchestrator';
import { githubProvider } from '@/lib/git/providers/github';
import * as motirAiClient from '@/lib/ai/motirAiClient';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { createStepApi } from '@/lib/jobs/engine/step';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { dispatchedEvents, JobTestEngine, spyOnJobDispatch } from '../helpers/jobs';
import {
  containerExitsWith,
  INDEX_REPO_REF,
  INDEX_TARBALL_URL,
  indexEventFor,
  indexJobRuns,
  driveIndexFleetFast,
  INDEX_FAST_SUPERVISION,
  indexStepIds,
  refreshEventFor,
  refreshJobRuns,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
  tarballBodyWasTouched,
} from '../helpers/indexFleet';

// system.code-graph-index — THE DURABLE STEP SHAPE (MOTIR-2027) — and
// system.code-graph-refresh, which drives the SAME one since MOTIR-2057.
//
// Driven IN-PROCESS via the in-process JobTestEngine against a REAL Postgres, on the `fake`
// orchestrator, with only the two externals stubbed (GitHub's tarball redirect,
// motir-ai's run-credential mint).
//
// What is under test is not "does it index" — `tests/ciFleet/
// codeGraphIndexDispatch.test.ts` covers the dispatch service — but the DURABLE
// SHAPE and the LEDGER CONTRACT, because those are what production breaks on:
//
//   • The shape. An index run is minutes and `app/api/inngest/route.ts` pins
//     `maxDuration = 300`, so supervision must be a SEQUENCE OF BOUNDED STEPS
//     with `ctx.step.sleep` between them, never a loop inside one step. That is
//     the MOTIR-2007 defect applied to a second workload.
//   • The ledger. Whatever the fan-out does internally — one container per
//     (repo × project) — the JOB still writes ONE `job_run` per repo with ONE
//     `output.repoRef`, because `listSucceededCodeGraphIndexRepoRefs` and the
//     onboarding wizard's per-repo rows read exactly that
//     (`docs/decisions/code-graph-index-fleet.md` §6).
//   • And no repo tarball ever enters the function again (§2).
//
// the in-process JobTestEngine hands back a mocked `ctx`, so `ctx.step.run` is a spy and the
// step ids it was called with are directly assertable — the closest thing to
// observing the executor's checkpoints from a unit test.
//
// ⚠️ THERE ARE NO `step.sleep` CALLS LEFT TO PRE-FULFIL (MOTIR-3484). This note
// used to explain that an un-stubbed sleep is re-found forever by
// `JobTestEngine` and `execute()` never resolves, so `sleepSteps()` supplied
// their state. The waits are ordinary `await`s inside the dispatch service now,
// and the problem is the mirror image: at the SHIPPED cadence a four-poll test
// would sleep 45 real seconds. `driveIndexFleetFast()` (in the shared fixture)
// shortens the cadence through the service's own options seam and changes
// nothing else — the composition, the steps, the gate and the ledger are all
// real. The cadence itself is asserted BY VALUE elsewhere, which is where a
// number belongs.

// The world this suite drives is the SHARED index-fleet fixture
// (`tests/helpers/indexFleet.ts`), so the seam suite that reads the ledger's
// real consumers measures the same one. The aliases below keep this file's call
// sites reading as they did when the fixture was inlined here.
const TARBALL_URL = INDEX_TARBALL_URL;
const REPO_REF = INDEX_REPO_REF;
const seedWorkspace = seedIndexWorkspace;
const stepIds = indexStepIds;
const indexRuns = indexJobRuns;
const indexEvent = (installationId: string, workspaceId: string) =>
  indexEventFor({ installationId, workspaceId, eventId: `evt-${installationId}` });

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  // The admission slots are real rows and no FK cascade reaches them (a slot must
  // survive the deletion of whatever it pointed at — the model comment). A file
  // that left them behind would slowly fill the index lane and start deferring
  // its own later cases.
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  // The supervision loop is a real `await` now (MOTIR-3484), so a job-level test
  // would otherwise sleep at the shipped cadence. Re-applied per test because
  // `afterEach` restores mocks.
  driveIndexFleetFast();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // ⚠️ AND AFTER, NOT ONLY BEFORE (MOTIR-3358). The `beforeEach` above clears these
  // for this file's own sake; this clears them for whatever file runs NEXT IN THIS
  // WORKER, which is a different problem with the same cause. `fleet_in_flight_slot`
  // is FLEET-WIDE — its `workspace_id` is nullable and is not a foreign key, by
  // design, because a slot must outlive whatever it pointed at — so no
  // `TRUNCATE "workspace" CASCADE` reaches it and the next file's `truncateAuthTables`
  // does NOT clean up after this one.
  //
  // And this file leaves slots behind on purpose: a run whose CONTAINER DIES keeps
  // its slot until the TTL expires it, which is right in production and never
  // happens here, because these tests freeze the clock. The census that reads this
  // table unions EVERY workload (`lib/ciFleet/workloads.ts`), so a leaked
  // `code_graph_index` slot is counted against the CI-runner fleet ceiling too —
  // and the symptom lands in `tests/ciFleet/ciRunnerAdmissionService.test.ts`, an
  // unrelated file, as an admission that defers for no visible reason.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE, AS COLLAPSED BY MOTIR-3484 — admit → boot → (loop) → settle, per
// project, with THREE durable steps and an ordinary loop between two of them.
//
// ⚠️ WHAT THIS SECTION USED TO ASSERT, AND WHY IT DOES NOT ANY MORE. It asserted
// `index-admit:<pid>:<n>` / `index-wait:<pid>:<n>` / `index-poll:<pid>:<n>` as
// separate checkpoints, "the property that makes a step, not the run, the unit
// `maxDuration` applies to". That was a true assertion about a Vercel ceiling,
// and it stopped describing anything the moment motir-core became a long-lived
// Fly process (MOTIR-2384). The DURABILITY it was standing in for is unchanged
// and is what is asserted now: the operations that CLAIM, PROVISION and TEAR DOWN
// are memoized, so a worker restart cannot do any of them twice.
// ─────────────────────────────────────────────────────────────────────────────

describe('system.code-graph-index — ONE composition, memoized at the side effects', () => {
  it('drives the dispatch service through the step seam, with admit / boot / settle as the only steps', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-shape', 2);
    stubIndexFleet();
    containerExitsWith(0);
    // ⚠️ THE ASSERTION IS INVERTED FROM WHAT IT WAS, deliberately. It used to be
    // that the JOB must NEVER call the service's composition — "a job that
    // called it would rebuild the hour-long invocation MOTIR-2007 removed for
    // CI". That ceiling is gone, and having ONE composition instead of two kept
    // in agreement by hand is what MOTIR-3484 delivered. So the job must call
    // it, and must call it with a step seam.
    //
    // ⚠️ THE ENTRY POINT MOVED (MOTIR-3828): the job drives
    // `advanceIndexContainer`, which does ONE poll and defers, rather than
    // `runIndexContainer`, which is now the in-process run-to-completion wrapper
    // for a caller with no `job_queue` row. Same composition, one pass at a
    // time — `docs/decisions/job-queue-foundation.md` §16.
    const composed = vi.spyOn(codeGraphIndexDispatchService, 'advanceIndexContainer');
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    // ⚠️ STILL `toEqual`, AND STILL EXACT — `coreTimings` (MOTIR-4413) and
    // `indexModes` (MOTIR-4945) are named rather than allowed for.
    // `toMatchObject` would have been the one-character fix and it would have
    // thrown away what these assertions are FOR: §6's ledger contract is that
    // this row carries `indexed` / `repoRef` / `projectsIndexed` and nothing a
    // reader has to learn about, so an assertion that stops noticing extra keys
    // stops guarding the contract on the very card that adds one.
    // `expect.any(Array)` keeps the shape closed while recording that a fourth
    // and now a fifth optional key exist.
    //
    // ⚠️ AND THE COST OF THE FIFTH IS THE ARGUMENT FOR KEEPING THIS SHAPE, not
    // against it: adding `indexModes` turned TWELVE of these assertions red
    // across three files at once. That is the guard doing precisely its job —
    // every one of them is a place a reader is promised the row's whole
    // contents, and a card that widens the row is made to come past all of them.
    expect(result).toEqual({
      // ⚠️ `projectsIndexed: 1`, AND IT USED TO BE THE PROJECT COUNT
      // (MOTIR-4652 · Story MOTIR-4642). The field counts CONTAINERS; the
      // fan-out that made that number equal the workspace's project count is
      // retired, because the graph is keyed to the ORGANISATION and two projects
      // sharing a repository shared a byte-identical graph. The field is kept —
      // historical rows carry other values and a reader meeting one needs
      // somewhere to learn what it meant.
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      coreTimings: expect.any(Array),
      indexModes: expect.any(Array),
    });
    expect(composed).toHaveBeenCalled();
    for (const call of composed.mock.calls) {
      expect(call[2]?.steps, 'the job must supply the durable seam').toBeDefined();
    }
    // ⚠️ COUNT THE MEMOIZED WORK, NOT THE CALLS. `composed` is called on EVERY
    // replay pass, because Inngest re-invokes the handler from the top at each
    // step boundary and `runIndexContainer` is ordinary code between the steps it
    // drives. What must happen exactly once per project is the BOOT — and it
    // does, because that is the half that sits inside a memoized step. This is
    // the durability property stated as an assertion rather than as a comment.
    //
    // ⚠️ ONCE PER REPOSITORY NOW, not once per project — the number is a
    // CONSTANT rather than a ratio, which is what makes it a regression detector
    // for a fan-out that came back at any width.
    expect(boot).toHaveBeenCalledTimes(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);

    const ids = stepIds(ctx).filter((id) => !id.startsWith('job-run:'));
    expect(ids[0]).toBe('resolve-target-v2');
    // ⚠️ AND `assert-fleet-configured` IS NO LONGER A STEP. It is a read of
    // process configuration that throws; under §13.1's test nothing exists twice
    // if it runs again. It still runs, still first, still before anything is
    // billed — the failing-deployment case below is what asserts that.
    expect(ids).not.toContain('assert-fleet-configured');

    // ⚠️ THE IDS BELONG TO ONE PROJECT NOW — THE ANCHOR (MOTIR-4652). This used
    // to walk every project of the workspace, which was walking the fan-out.
    // There is one container, and it is keyed by the project motir-ai resolves
    // its run credential through; WHICH project that is is not a contract, so it
    // is read off the ids and checked for membership rather than predicted.
    const scoped = ids.filter((id) => /^index-(admit|boot|settle):/.test(id));
    const anchors = new Set(scoped.map((id) => id.slice(id.indexOf(':') + 1)));
    expect(anchors.size).toBe(1);
    const anchorProjectId = [...anchors][0]!;
    expect(projectIds).toContain(anchorProjectId);
    // The three that CLAIM, PROVISION and TEAR DOWN — in order, and nothing
    // else. The admission backoff is INSIDE the first of them rather than
    // spread across sixty ids (§13.3(c) says why it must be a step at all).
    expect(scoped).toEqual([
      `index-admit:${anchorProjectId}`,
      `index-boot:${anchorProjectId}`,
      `index-settle:${anchorProjectId}`,
    ]);
    // Not one poll or wait checkpoint survives — roughly 128 database writes per
    // 30-minute index, which is what the collapse buys.
    expect(
      ids.filter((id) => id.startsWith('index-poll:') || id.startsWith('index-wait:')),
    ).toEqual([]);

    // ⚠️ THE BOOT STILL DOES NOT SUPERVISE. Its resolved value is a SESSION
    // awaiting supervision, not a settled outcome — so a regression that awaited
    // the container inside `bootIndexContainer` fails right here, exactly as it
    // did before the collapse.
    for (const call of boot.mock.results) {
      expect(await call.value).toMatchObject({ phase: 'supervising' });
    }
  }, 30_000);

  it('supervises across MANY polls without writing a step per poll', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-long', 1);
    stubIndexFleet();
    // Not terminal until the fourth poll: a container that ran for longer than
    // any single invocation of the old shape could have lasted.
    const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
      codeGraphIndexDispatchService,
    );
    let polls = 0;
    const poll = vi
      .spyOn(codeGraphIndexDispatchService, 'pollIndexContainer')
      .mockImplementation(async (session, previous, options) => {
        polls += 1;
        if (polls >= 4) {
          for (const id of fakeOrchestrator.liveContainerIds()) {
            fakeOrchestrator.completeJob(id, { exitCode: 0 });
          }
        }
        return realPoll(session, previous, options);
      });

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    // At least the four the container needed. It is not EXACTLY four, and the
    // reason is worth stating: the loop is ordinary code between two steps, so an
    // Inngest replay pass re-enters it and re-polls a container it has already
    // watched. Those reads are idempotent and the outcome is memoized — the
    // engine, which does not re-invoke from the top, runs the loop once.
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(4);
    const projectId = projectIds[0]!;
    // ⚠️ THE PROPERTY THE COLLAPSE BUYS, asserted as a CONSTANT rather than as a
    // sequence: four polls, and the step count is the same three it would have
    // been for one. Today's shape wrote a sleep checkpoint AND a result row per
    // poll, and replayed every earlier one on each resume.
    const own = stepIds(ctx).filter((id) => id.endsWith(`:${projectId}`));
    expect(own).toEqual([
      `index-admit:${projectId}`,
      `index-boot:${projectId}`,
      `index-settle:${projectId}`,
    ]);
    expect(result).toEqual({
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      coreTimings: expect.any(Array),
      indexModes: expect.any(Array),
    });
    // Teardown was reached — the guarantee the whole shape exists for, now held
    // by an ordinary `finally` rather than by a step reachable from both exits.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns).toHaveLength(1);
  }, 30_000);

  it('NEVER materializes the repo tarball in the function', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-bytes', 2);
    stubIndexFleet();
    containerExitsWith(0);
    // The two ways bytes used to enter this process: the buffering provider
    // fetch, and the motir-ai upload that carried them. NEITHER is spy-able any
    // more, because neither EXISTS — MOTIR-2124 removed the first and MOTIR-2138
    // the second. Both are asserted below as ABSENCE, which is the stronger form
    // of "was not called".

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    expect(result).toMatchObject({ indexed: true });
    // ⚠️ THE DEFECT, INVERTED (§2). `motir-core` itself exhausted 5/5 attempts on
    // the old path because the function buffered a whole repo; the pre-signed URL
    // now goes to the container and the body is never read here at all.
    expect(tarballBodyWasTouched()).toBe(false);
    // Not "was not called" but "cannot be called": the byte-returning provider
    // method is gone from the seam entirely (MOTIR-2124), so no future edit can
    // reintroduce the buffering path by reaching for it.
    expect(
      (githubProvider as unknown as Record<string, unknown>)['fetchRepoTarball'],
    ).toBeUndefined();
    // Same form, one layer down: the motir-ai client exports no byte-upload
    // method at all (MOTIR-2138), so there is nothing left for a future caller
    // to import. This is what the `indexCodeGraph` spy used to assert, in the
    // stronger form deletion makes available.
    expect((motirAiClient as unknown as Record<string, unknown>)['indexCodeGraph']).toBeUndefined();
    // What the container was actually handed: the resolved URL, not a token.
    for (const spec of fakeOrchestrator.specs) {
      expect(spec.env['MOTIR_INDEX_TARBALL_URL']).toBe(TARBALL_URL);
    }
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE LEDGER CONTRACT — one `job_run` per REPO, one `output.repoRef` (§6).
// ─────────────────────────────────────────────────────────────────────────────

describe('the ledger stays per REPO, and so does the container', () => {
  it.each([1, 2])(
    'writes ONE succeeded run with ONE repoRef for a workspace with %i project(s)',
    async (projectCount) => {
      const { workspaceId, installationId } = await seedWorkspace(
        `cgf-ledger${projectCount}`,
        projectCount,
      );
      stubIndexFleet();
      containerExitsWith(0);

      const engine = new JobTestEngine({ function: codeGraphIndex });
      const { result } = await engine.execute({
        events: [indexEvent(installationId, workspaceId)],
      });

      // ⚠️ ONE CONTAINER FOR BOTH ARMS (MOTIR-4652). This used to read
      // `toHaveLength(projectCount)` — the fan-out really did widen, and the
      // parametrisation existed to measure the widening. It measures the
      // opposite property now: the count does NOT move with the project count,
      // which is what "keyed to the organisation" means at this seam.
      expect(fakeOrchestrator.provisioned).toHaveLength(1);
      expect(result).toEqual({
        indexed: true,
        repoRef: REPO_REF,
        projectsIndexed: 1,
        coreTimings: expect.any(Array),
        indexModes: expect.any(Array),
      });

      // ⚠️ AND THE LEDGER DID NOT. Two projects must not become two rows or two
      // repoRefs: `listSucceededCodeGraphIndexRepoRefs` builds the indexed SET
      // from these rows, and the wizard's per-repo rows and `allIndexed` gate on
      // it. This is the case that proves the ledger did not become per-project.
      const runs = await indexRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('succeeded');
      expect(runs[0]!.output).toEqual({
        indexed: true,
        repoRef: REPO_REF,
        projectsIndexed: 1,
        coreTimings: expect.any(Array),
        indexModes: expect.any(Array),
      });
    },
    30_000,
  );

  it('the enqueue gate reads the run back as exactly one indexed repoRef', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-gate', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    // Read BACK through the consumer, not through the row: the contract is what
    // the gate and the onboarding wizard see, and a shape change that still
    // stored "something" would pass a row assertion and fail here.
    const { withSystemContext } = await import('@/lib/workspaces/context');
    const { jobRunRepository } = await import('@/lib/repositories/jobRunRepository');
    const refs = await withSystemContext((tx) =>
      jobRunRepository.listSucceededCodeGraphIndexRepoRefs(workspaceId, tx),
    );
    expect(refs).toEqual([REPO_REF]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE NO-OP VERDICTS — the shipped contract that the job never throws on
// a tenant that went away, and the ledger records WHY nothing was indexed.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveIndexTarget’s no-op verdicts still reach the ledger unchanged', () => {
  it('installation_missing: resolves in ONE step, boots nothing, and records the reason', async () => {
    const { workspaceId } = await seedWorkspace('cgf-noinst', 1);
    stubIndexFleet();

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent('inst-gone', workspaceId)],
    });

    expect(result).toEqual({ indexed: false, reason: 'installation_missing' });
    const runs = await indexRuns();
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual({ indexed: false, reason: 'installation_missing' });
    // Nothing was spent: not the config gate, not a container.
    // Nothing past `resolve-target` ran: no admission, no boot, no settle. (The
    // config gate is no longer a step of its own — MOTIR-3484 — so its ABSENCE
    // from the id list proves nothing; the id list being EMPTY of index work
    // does.)
    expect(stepIds(ctx).filter((id) => id.startsWith('index-'))).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('no_projects: a workspace with nothing to index boots nothing and records the reason', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-noproj', 0);
    stubIndexFleet();

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    expect(result).toEqual({ indexed: false, reason: 'no_projects' });
    const runs = await indexRuns();
    expect(runs[0]!.output).toEqual({ indexed: false, reason: 'no_projects' });
    // Nothing past `resolve-target` ran: no admission, no boot, no settle. (The
    // config gate is no longer a step of its own — MOTIR-3484 — so its ABSENCE
    // from the id list proves nothing; the id list being EMPTY of index work
    // does.)
    expect(stepIds(ctx).filter((id) => id.startsWith('index-'))).toEqual([]);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('workspace_missing: a vanished tenant is a clean no-op, never a throw', async () => {
    const { installationId } = await seedWorkspace('cgf-nows', 1);
    stubIndexFleet();

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error, ctx } = (await engine.execute({
      events: [indexEvent(installationId, 'ws-gone')],
    })) as { result?: unknown; error?: unknown; ctx: Parameters<typeof stepIds>[0] };

    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: 'workspace_missing' });
    expect(fakeOrchestrator.provisioned).toEqual([]);
    // Nothing past `resolve-target` ran: no admission, no boot, no settle. (The
    // config gate is no longer a step of its own — MOTIR-3484 — so its ABSENCE
    // from the id list proves nothing; the id list being EMPTY of index work
    // does.)
    expect(stepIds(ctx).filter((id) => id.startsWith('index-'))).toEqual([]);
    // ⚠️ THIS VERDICT ALONE HAS NO LEDGER ROW, and that is `job_run.workspaceId`'s
    // FK rather than a gap here: `recordStart` catches the P2003 for a tenant that
    // is already gone (MOTIR-1545) and returns null, so there is no row to flip.
    // The verdict is still the run's RESULT, which is what the assertion above
    // pins — and a workspace that exists (the two cases above) does get the row.
    expect(await indexRuns()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A PROVIDER THAT CAN NEVER BE INDEXED (MOTIR-2124) — refused, not retried.
// ─────────────────────────────────────────────────────────────────────────────

describe('a GitLab repo is REFUSED before dispatch, not dead-lettered five times', () => {
  // ⚠️ THE REGRESSION THIS FILE DID NOT HAVE. The GitLab feed's own suite
  // (`tests/gitlab/gitlabCodeGraphFeed.test.ts`) asserts the job is ENQUEUED and
  // stops there, so both MOTIR-2027 (first index → containers) and MOTIR-2057
  // (refresh → containers) went green while every GitLab index actually threw at
  // `index-boot`, burned all five Inngest attempts and dead-lettered. What was
  // missing was a test that drove a GitLab installation through the DISPATCH path.
  // These do.
  //
  // The seed flips the installation's `provider` column, which is exactly how a
  // GitLab connection is stored in production — `gitlabConnectionService` reuses
  // the same `GithubInstallation` entity under `provider: 'gitlab'` — so what is
  // under test is the shipped discriminator, not a mock.
  async function seedGitlabWorkspace(slug: string, projectCount: number) {
    const seeded = await seedWorkspace(slug, projectCount);
    await adminDb.githubInstallation.update({
      where: { installationId: seeded.installationId },
      data: { provider: 'gitlab' },
    });
    return seeded;
  }

  it('index: resolves to provider_cannot_index, boots NOTHING, and never throws', async () => {
    const { workspaceId, installationId } = await seedGitlabWorkspace('cgf-gitlab', 2);
    // The fleet is fully configured on purpose: the refusal must come from the
    // PROVIDER's capability, not from an unconfigured deployment that would have
    // refused a GitHub repo too.
    stubIndexFleet();
    containerExitsWith(0);
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error, ctx } = (await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    })) as { result?: unknown; error?: unknown; ctx: Parameters<typeof stepIds>[0] };

    // ⚠️ NO THROW IS THE WHOLE POINT. A throw is what Inngest retries, and five
    // retries of a host that structurally cannot succeed is the dead-letter storm
    // — 35 rows in 48 h, per push, explaining nothing.
    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: 'provider_cannot_index' });

    // Nothing was spent, in dispatch order: no config gate, no admission slot, no
    // boot, no container.
    const ids = stepIds(ctx).filter((id) => !id.startsWith('job-run:'));
    expect(ids).toEqual(['resolve-target-v2']);
    expect(boot).not.toHaveBeenCalled();
    expect(fakeOrchestrator.provisioned).toEqual([]);
    const fleetInFlightSlotCount = await adminDb.fleetInFlightSlot.count();
    expect(fleetInFlightSlotCount).toBe(0);
  });

  it('index: records the reason on a SUCCEEDED ledger row that claims no repoRef', async () => {
    const { workspaceId, installationId } = await seedGitlabWorkspace('cgf-gitlab-led', 1);
    stubIndexFleet();

    const engine = new JobTestEngine({ function: codeGraphIndex });
    await engine.execute({ events: [indexEvent(installationId, workspaceId)] });

    const runs = await indexRuns();
    expect(runs).toHaveLength(1);
    // `succeeded` means "this run is finished and will not be retried" — it does
    // NOT mean the repo has a graph, and the two must stay distinguishable: the
    // row carries NO `output.repoRef`, which is the key
    // `listSucceededCodeGraphIndexRepoRefs` and the onboarding wizard read
    // (`docs/decisions/code-graph-index-fleet.md` §6). A verdict that claimed one
    // would tell every downstream reader this repo is indexed, forever.
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual({ indexed: false, reason: 'provider_cannot_index' });
    expect(runs[0]!.output).not.toHaveProperty('repoRef');
  });

  it('refresh: a PUSH takes the same refusal — the five-dead-letters-per-push case', async () => {
    const { workspaceId, installationId } = await seedGitlabWorkspace('cgj-gitlab-push', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const { result, error } = (await engine.execute({
      events: [refreshEventFor({ installationId, workspaceId })],
    })) as { result?: unknown; error?: unknown };

    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: 'provider_cannot_index' });
    expect(fakeOrchestrator.provisioned).toEqual([]);
    const runs = await refreshJobRuns();
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual({ indexed: false, reason: 'provider_cannot_index' });
  });

  it('the SAME workspace on GitHub still indexes — the refusal is the provider, not the seed', async () => {
    // ⚠️ THE CONTROL. Without it, every assertion above would still pass if the
    // gate refused everything, and "GitLab is not indexed" would be indistinguishable
    // from "indexing is broken".
    const { workspaceId, installationId } = await seedWorkspace('cgf-github-ctl', 1);
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    expect(result).toMatchObject({ indexed: true, repoRef: REPO_REF });
    expect(fakeOrchestrator.provisioned.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A REPO MOTIR CREATED WAITS FOR A COMMIT OF ITS OWN (MOTIR-4589) — at run time,
// in the same resolve step every trigger passes through.
// ─────────────────────────────────────────────────────────────────────────────

describe('a created repository that holds only its seed is not indexed yet (MOTIR-4589)', () => {
  const SEED = 'f'.repeat(40);

  /** Turn the fixture's connected rows into rows Motir CREATED and seeded at `SEED`,
   *  with the default branch at `head` (null: no push observed since creation). */
  async function seededAt(workspaceId: string, head: string | null): Promise<void> {
    await adminDb.projectRepo.updateMany({
      where: { workspaceId },
      data: { state: 'created', seedHeadSha: SEED },
    });
    await adminDb.githubRepo.updateMany({
      where: { workspaceId },
      data: { defaultBranchHeadSha: head },
    });
  }

  it('resolves to no_commit_beyond_template, boots NOTHING, and records it on the ledger', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { workspaceId, installationId } = await seedWorkspace('cgi-seed-only', 1);
    await seededAt(workspaceId, null);
    stubIndexFleet();

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    expect(result).toEqual({ indexed: false, reason: 'no_commit_beyond_template' });
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    // A succeeded row that claims no repoRef: "not indexed YET", never a failure,
    // and never read by the enqueue gate as an indexed repository.
    const runs = await indexRuns();
    expect(runs.map((r) => r.status)).toEqual(['succeeded']);
    expect(runs[0]!.output).toEqual({ indexed: false, reason: 'no_commit_beyond_template' });
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('not indexed yet: no commit beyond the template'),
      REPO_REF,
    );
  });

  it('a push of Motir’s OWN seeding (head still the seed) is held too — the refresh path', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { workspaceId, installationId } = await seedWorkspace('cgi-seed-stub', 1);
    await seededAt(workspaceId, SEED);
    stubIndexFleet();

    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const { result } = await engine.execute({
      events: [refreshEventFor({ installationId, workspaceId, eventId: 'evt-seed-stub' })],
    });

    expect(result).toEqual({ indexed: false, reason: 'no_commit_beyond_template' });
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
  });

  it('SELF-HEAL: a created repo with commits past its seed but no graph is picked up by the next reconcile', async () => {
    // The case this card could plausibly break (MOTIR-1961): its push happened,
    // the index was dropped, and no further push is coming. The reconcile's
    // has-no-graph gate still offers it, and the run-time gate lets it through.
    const { workspaceId, installationId } = await seedWorkspace('cgi-seed-heal', 1);
    await seededAt(workspaceId, 'e'.repeat(40));
    const send = spyOnJobDispatch();
    send.mockClear();
    const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { workspaceId } });

    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId,
      workspaceId,
      repos: [
        {
          providerRepoId: repo.repoId,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          archived: false,
        },
      ],
    });
    const enqueued = dispatchedEvents(send).filter((e) => e.name === 'system.code-graph-index');
    expect(enqueued).toHaveLength(1);

    stubIndexFleet();
    containerExitsWith(0);
    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });
    expect(result).toMatchObject({ indexed: true, repoRef: REPO_REF });
    expect(fakeOrchestrator.provisioned.length).toBeGreaterThan(0);
  });

  it('a CONNECTED repository is never held, whatever its head', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgi-seed-conn', 1);
    await adminDb.githubRepo.updateMany({
      where: { workspaceId },
      data: { defaultBranchHeadSha: null },
    });
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });
    expect(result).toMatchObject({ indexed: true, repoRef: REPO_REF });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP IDS ARE KEYED BY projectId — what Inngest memoizes against.
// ─────────────────────────────────────────────────────────────────────────────

describe('step ids identify the SAME unit of work on every replay', () => {
  it('keys boot / poll / settle by project id, never by loop position', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-keys', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    const ids = stepIds(ctx);
    // ⚠️ THE ANCHOR'S ids, not every project's (MOTIR-4652) — one container, so
    // one keyed set. The property under test is unchanged and is about the KEY,
    // not the count: an id names the unit of work, so a replay finds the same
    // memo.
    const anchorProjectId = ids
      .find((id) => id.startsWith('index-boot:'))!
      .slice('index-boot:'.length);
    expect(projectIds).toContain(anchorProjectId);
    expect(ids).toContain(`index-admit:${anchorProjectId}`);
    expect(ids).toContain(`index-boot:${anchorProjectId}`);
    expect(ids).toContain(`index-settle:${anchorProjectId}`);
    // A positional id would re-point at a DIFFERENT project if the workspace's
    // project list changed between attempts. None exists — and the rule matters
    // MORE after the collapse, not less: there are three ids left and each one
    // carries more (MOTIR-3484).
    expect(ids.filter((id) => /^index-(admit|boot|settle):\d+$/.test(id))).toEqual([]);
  }, 30_000);

  it('a replay after the project list changed resumes the MEMOIZED project', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-replay', 1);
    stubIndexFleet();
    containerExitsWith(0);
    const memoizedProjectId = projectIds[0]!;

    // The replay: `resolve-target` comes back from Inngest's memo, and the
    // workspace has since gained a project the memo never saw. A run that
    // re-derived its fan-out from the live list would now index the NEW project.
    const resolved = await codeGraphIndexService.resolveIndexTarget({
      installationId,
      workspaceId,
      repoOwner: 'moooon',
      repoName: 'motir-core',
      defaultBranch: 'main',
    });
    const drifted = await projectsService.createProject({
      workspaceId,
      actorUserId: (await adminDb.user.findFirstOrThrow()).id,
      name: 'Added between attempts',
      identifier: 'DRIFT',
    });
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      steps: [{ id: 'resolve-target-v2', handler: () => resolved }],
    });

    // It resumed the SAME project's work. The drifted project is not indexed by
    // this run — it belongs to the next one, which will resolve it for itself.
    expect(stepIds(ctx)).toContain(`index-boot:${memoizedProjectId}`);
    expect(stepIds(ctx)).not.toContain(`index-boot:${drifted.id}`);
    expect(boot.mock.calls.map((call) => call[0]!.projectId)).toEqual([memoizedProjectId]);
    expect(result).toEqual({
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      coreTimings: expect.any(Array),
      indexModes: expect.any(Array),
    });
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FAILURE — the run FAILS, loudly and by name, rather than claiming a repo.
// ─────────────────────────────────────────────────────────────────────────────

describe('a container that did not index FAILS the run', () => {
  it.each([
    [30, 'graph_unbuildable'],
    [137, 'out_of_memory'],
    [50, 'credential_refused'],
    [null, 'exit_unobserved'],
  ] as const)(
    'exit %s surfaces the NAMED class %s, and records no success',
    async (code, name) => {
      const { workspaceId, installationId } = await seedWorkspace(`cgf-x${code ?? 'null'}`, 1);
      stubIndexFleet();
      containerExitsWith(code);

      const engine = new JobTestEngine({ function: codeGraphIndex });
      // `the in-process JobTestEngine` CAPTURES a handler throw onto `error` (serialized, so the
      // subclass name flattens to `Error`) rather than rejecting `execute()`.
      const { result, error } = (await engine.execute({
        events: [indexEvent(installationId, workspaceId)],
      })) as { result?: unknown; error?: { message?: string } };

      expect(result).toBeUndefined();
      // The exit code is the container's entire diagnostic channel, so the run
      // reports what happened by NAME — "the parser died on this tree" and "the
      // kernel killed it" are different on-call responses.
      expect(error?.message).toContain(name);
      expect(error?.message).toContain(REPO_REF);

      // ⚠️ AND NOTHING CLAIMS THE REPO. A `succeeded` row carrying an
      // `output.repoRef` would tell the enqueue gate and the wizard that this repo
      // has a code graph, forever — for a container that did not build one.
      const runs = await indexRuns();
      expect(runs.filter((run) => run.status === 'succeeded')).toEqual([]);
      expect(runs.every((run) => run.output === null)).toBe(true);
      // The container was still torn down: failure is not a leak.
      expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    },
    30_000,
  );

  it('stops at the FIRST failing project rather than booting the rest', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-firstfail', 3);
    stubIndexFleet();
    containerExitsWith(30);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    // One container, not three. A retry RESUMES from the memoized steps, so
    // failing fast costs nothing and spends nothing.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  }, 30_000);

  it('a container that never STARTED fails as never_started, carrying supervision’s own detail', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-nostart', 1);
    stubIndexFleet();
    // The boot deadline firing is a wall-clock event (120s), so it is driven at
    // the poll rather than by waiting: the provider reported a machine, and it
    // never reached a running state.
    vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockResolvedValue({
      done: true,
      reason: 'provision_failed',
      startedAt: null,
      exitCode: null,
      failureDetail: 'the container never started',
    });

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    })) as { result?: unknown; error?: { message?: string } };

    expect(result).toBeUndefined();
    // A boot that never happened is its OWN class — not `graph_unbuildable`,
    // which would send an operator looking at the repo instead of the fleet —
    // and the run reports supervision's own detail rather than the exit's.
    expect(error?.message).toContain('never_started');
    expect(error?.message).toContain('the container never started');
    // It was still torn down: a machine nothing destroys is billed until the reaper.
    // `never_started` is re-dispatchable (MOTIR-6586), so there were two, and
    // both were destroyed.
    expect(fakeOrchestrator.teardowns).toHaveLength(2);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect((await indexRuns()).filter((run) => run.status === 'succeeded')).toEqual([]);
  }, 30_000);

  it('a provider that refuses to boot fails the run — no container, no success', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-noboot', 1);
    stubIndexFleet();
    fakeOrchestrator.failNextProvision('no capacity in iad');

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    })) as { result?: unknown; error?: { message?: string } };

    expect(result).toBeUndefined();
    expect(error?.message).toContain('provision_failed');
    expect((await indexRuns()).filter((run) => run.status === 'succeeded')).toEqual([]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CONFIG GATE — unconfigured must be LOUD, never a silent `succeeded` row.
// ─────────────────────────────────────────────────────────────────────────────

describe('an unconfigured index fleet fails the run loudly', () => {
  it('gates BEFORE the fan-out and writes no succeeded row with a repoRef', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-unconfigured', 2);
    stubIndexFleet();
    // Select the REAL adapter on a deployment that has none of its variables —
    // exactly a self-hosted build, or a cloud one that lost its secrets.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    for (const name of [
      'FLY_FLEET_API_TOKEN',
      'FLY_FLEET_APP',
      'MOTIR_RUNNER_IMAGE',
      'MOTIR_INDEXER_IMAGE',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error, ctx } = (await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    })) as { result?: unknown; error?: { message?: string }; ctx: Parameters<typeof stepIds>[0] };

    // LOUD: the run fails, naming what to set — never a quiet "nothing to do".
    expect(result).toBeUndefined();
    expect(error?.message).toMatch(/set /i);
    // ⚠️ THE GATE IS NO LONGER ITS OWN STEP (MOTIR-3484), so what proves it fired
    // is that the run FAILED naming what to set while NOTHING was admitted,
    // booted or billed — which is what the gate was ever for.
    expect(stepIds(ctx).filter((id) => id.startsWith('index-'))).toEqual([]);
    // Nothing was attempted or billed.
    expect(boot).not.toHaveBeenCalled();
    expect(fakeOrchestrator.provisioned).toEqual([]);

    // ⚠️ THE ROW THAT MUST NOT EXIST. A `succeeded` run carrying an
    // `output.repoRef` in this state is indistinguishable from a real index
    // everywhere downstream — the enqueue gate skips the repo and the wizard
    // ticks it — for a deployment that cannot index anything at all.
    const runs = await indexRuns();
    expect(runs.filter((run) => run.status === 'succeeded')).toEqual([]);
    expect(runs.some((run) => run.output !== null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ADMISSION CAP — over the cap means WAIT (MOTIR-1990), inside ONE step.
//
// ⚠️ THE SHAPE CHANGED AND THE RULE DID NOT (MOTIR-3484). This section used to
// assert that a deferral produces ANOTHER attempt under a DIFFERENT step id
// (`index-admit:<pid>:1`, `:2`, `:3`) with `ctx.step.sleep` between them — and
// that was load-bearing: one shared id would have let Inngest memoize the first
// `deferred` answer for the life of the run, so "wait" would silently have become
// "drop". Nothing memoizes an in-process loop, so the sixty ids collapse to one
// step containing the whole backoff, and the property to assert is the one that
// always mattered: it ASKS AGAIN, and it boots once admitted.
//
// It stays a step at all — rather than plain control flow before the boot step —
// for the reason `docs/decisions/job-queue-foundation.md` §13.3(c) gives: a
// resume that re-asked admission after the settle step had released the slot
// would be granted a fresh one and never release it.
// ─────────────────────────────────────────────────────────────────────────────

describe('the admission cap queues, and nothing is dropped', () => {
  it('asks again after a deferral, inside ONE memoized step, and boots once admitted', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-queue', 1);
    stubIndexFleet();
    containerExitsWith(0);
    // ⚠️ Bind the REAL method BEFORE spying, or the fall-through below re-enters
    // the spy and recurses forever.
    const real = codeGraphIndexAdmissionService.admit.bind(codeGraphIndexAdmissionService);
    const admit = vi.spyOn(codeGraphIndexAdmissionService, 'admit');
    admit
      .mockResolvedValueOnce({
        outcome: 'deferred',
        reason: 'index_cap',
        detail: 'indexing is at its global cap (6/6)',
      })
      .mockResolvedValueOnce({
        outcome: 'deferred',
        reason: 'org_index_cap',
        detail: 'the organization is at its index cap (3/3, half of the global 6)',
      })
      .mockImplementation(real);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, ctx } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    // It waited twice and then indexed. NOTHING was dropped.
    expect(result).toEqual({
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      coreTimings: expect.any(Array),
      indexModes: expect.any(Array),
    });
    const projectId = projectIds[0]!;
    const ids = stepIds(ctx);
    // Three asks, ONE checkpoint. The retry loop is in-process now, so the
    // deferral cannot be frozen into a memo — the failure the per-attempt ids
    // used to prevent has no way to occur.
    expect(admit).toHaveBeenCalledTimes(3);
    expect(ids.filter((id) => id.startsWith('index-admit:'))).toEqual([`index-admit:${projectId}`]);
    // Every step id is still distinct — a repeated id is the memo trap wearing a
    // different costume.
    expect(new Set(ids).size).toBe(ids.length);
    // And the WAITING is no longer a checkpoint of any kind.
    const sleeps = (
      ctx as unknown as { step: { sleep: { mock: { calls: unknown[][] } } } }
    ).step.sleep.mock.calls.map((call) => String(call[0]));
    expect(sleeps).toEqual([]);
  }, 30_000);

  // The cap is STRUCTURAL on this path, not conventional: `bootIndexContainer`
  // requires the ticket, so a boot with no admission is a type error — and this
  // is the runtime half, that the ticket a boot receives is the one the gate
  // actually granted.
  it('boots on the ticket the gate granted, and never before it', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-ticket', 1);
    stubIndexFleet();
    containerExitsWith(0);
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new JobTestEngine({ function: codeGraphIndex });
    await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
    });

    expect(boot).toHaveBeenCalledTimes(1);
    const admission = boot.mock.calls[0]![1];
    expect(admission.slotRef).toBe(`${projectIds[0]}:${REPO_REF}`);
    // And the slot really was taken and then given back — the container is gone,
    // so the capacity is free.
    const fleetInFlightSlotCount = await adminDb.fleetInFlightSlot.count();
    expect(fleetInFlightSlotCount).toBe(0);
  }, 30_000);

  // ⚠️ THE LEDGER CONTRACT UNDER A REFUSAL (§6). A run that could not get
  // capacity must FAIL, never record a `succeeded` row carrying an
  // `output.repoRef` — that row is a permanent claim, to every reader, that the
  // repo has a code graph.
  it('FAILS the run when admission is never granted — it never claims the repo', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-starved', 1);
    stubIndexFleet();
    vi.spyOn(codeGraphIndexAdmissionService, 'admit').mockResolvedValue({
      outcome: 'deferred',
      reason: 'index_cap',
      detail: 'indexing is at its global cap (6/6)',
    });

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { error } = await engine.execute({
      events: [indexEvent(installationId, workspaceId)],
      // Enough sleeps for the whole waiting budget.
    });

    // The named failure, not a bare throw: the operator reads the reason off it.
    expect((error as Error).message).toContain('admission_deferred');
    expect((error as Error).message).toContain('index_cap');
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    // The ledger recorded a FAILED run, not a success with an `output.repoRef`.
    const runs = await indexRuns();
    expect(runs.at(-1)?.status).not.toBe('succeeded');
    expect(runs.at(-1)?.output).toBeNull();
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// TWO RUNS, ONE (repo × project) — MOTIR-2160.
//
// The refresh job debounces pushes on `installationId/owner/name` with a 2-minute
// window, which coalesces merges INSIDE one window and does nothing once a run has
// started — while an index takes minutes. So a second run arriving mid-index is
// ordinary merge cadence. What the caps could not see is that the slot key names
// the WORK, not the worker: a second run's held-slot read was indistinguishable
// from a replay, and it booted a container judged against none of the three bounds.
// ─────────────────────────────────────────────────────────────────────────────

describe('a refresh run whose (repo × project) is already being indexed', () => {
  /** Take the slot as a DIFFERENT run, through the real gate — a first run mid-index. */
  async function heldByAnotherRun(workspaceId: string, projectId: string, dispatchId: string) {
    const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    return codeGraphIndexAdmissionService.admit({
      projectId,
      repoRef: REPO_REF,
      dispatchId,
      workspaceId,
      organizationId: workspace.organizationId,
      containerTimeoutMs: 1_800_000,
    });
  }

  // ⚠️ THE ASSERTION THE CARD TURNS ON: THE COUNT OF BOOTED CONTAINERS. One unit
  // of index work is one container's worth of spend, and the second run must not
  // add another however many times it asks.
  it('BOOTS NOTHING while the first run holds the slot', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgf-overlap', 1);
    stubIndexFleet();
    containerExitsWith(0);
    const projectId = projectIds[0]!;
    expect(await heldByAnotherRun(workspaceId, projectId, 'evt-first')).toMatchObject({
      outcome: 'admitted',
    });

    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const { error } = await engine.execute({
      events: [refreshEventFor({ installationId, workspaceId })],
      // Enough sleeps for the whole waiting budget — the second run WAITS, and
      // only fails once the budget is exhausted. Nothing is dropped silently.
    });

    // NOT ONE container for the second run — the first one's is the only one.
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    expect((error as Error).message).toContain('repo_index_in_flight');
    // …and it never took a second slot, so the first run's capacity is intact and
    // still names its real owner.
    const slots = await adminDb.fleetInFlightSlot.findMany();
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ ownerRef: 'evt-first', ref: `${projectId}:${REPO_REF}` });
    // The ledger recorded a FAILED run: a refresh that indexed nothing must never
    // claim the repo (§6).
    const runs = await refreshJobRuns();
    expect(runs.at(-1)?.status).not.toBe('succeeded');
  }, 60_000);

  // The other side of the same coin, and the property scoping `already_held` to
  // the run must not cost: THIS run asking again for capacity it already holds is
  // a replay, not an overlap — the case MOTIR-2002 asserted for the CI fleet by
  // call count, asserted here by container count.
  it('still admits the SAME run’s replayed admit step, and boots exactly once', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgf-replay', 1);
    stubIndexFleet();
    containerExitsWith(0);
    // ⚠️ Bind the REAL method BEFORE spying, or the fall-through re-enters the spy.
    const real = codeGraphIndexAdmissionService.admit.bind(codeGraphIndexAdmissionService);
    const seen: Array<{ outcome: string }> = [];
    // Every admit step runs TWICE against the real gate — the shape of a durable
    // step whose work committed but whose memo did not, so the retry re-executes
    // it. The run proceeds on the SECOND answer.
    vi.spyOn(codeGraphIndexAdmissionService, 'admit').mockImplementation(async (request, now) => {
      const first = await real(request, now);
      const again = await real(request, now);
      seen.push(first, again);
      return again;
    });

    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const { result } = await engine.execute({
      events: [refreshEventFor({ installationId, workspaceId })],
    });

    expect(result).toEqual({
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      coreTimings: expect.any(Array),
      indexModes: expect.any(Array),
    });
    // The re-execution was NOT refused, and it was not a second slot either.
    expect(seen.map((v) => v.outcome)).toEqual(['admitted', 'already_held']);
    // ONE container, from the run that owns the capacity.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    // And it gave that capacity back — which an ownership-checked release only
    // does for the run that took it.
    const fleetInFlightSlotCount = await adminDb.fleetInFlightSlot.count();
    expect(fleetInFlightSlotCount).toBe(0);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DEFINITION — the cap is NOT here, and must never come back (MOTIR-1990).
// ─────────────────────────────────────────────────────────────────────────────

describe('the job definition carries NO concurrency number', () => {
  // ⚠️ A REGRESSION GUARD, not a tautology. `concurrency: 2` lived here until
  // MOTIR-1990 and the temptation to put a number back is exactly what §7
  // forbids. Two reasons it must stay absent, both fatal:
  //   • It would make the CONFIGURED cap a lie. A stepped supervision loop holds
  //     its Inngest slot for the CONTAINER'S WHOLE LIFE, so a limit of 2 beside a
  //     configured cap of six means two, whatever an operator sets.
  //   • It is UNKEYED, which is the starvation it was meant to prevent — one
  //     tenant's five repos ahead of another's first index. A per-tenant limit
  //     here would need a KEYED concurrency; `defineJob` can express one since
  //     MOTIR-1982, and it STILL does not belong here, because the first reason
  //     applies to a keyed cap just as much — it would cap supervisors, not
  //     containers. Fairness for this job lives in admission control.
  it('leaves concurrency to the orchestrator’s admission cap, and keeps the retry policy', () => {
    // Read off the SHIPPED definition — what the module actually declared —
    // rather than re-invoking `defineJob` with the options a test believes it
    // passes. (It used to come off the vendor function object's `opts`; the
    // declaration is the registration now.)
    expect(codeGraphIndex.id).toBe('system.code-graph-index');
    // There is no `concurrency` option left to carry (MOTIR-3418): no job
    // declared one and the engine never read it, so `defineJob` dropped it. The
    // assertion is therefore about the OPTION rather than about this job's value.
    expect(Object.hasOwn(codeGraphIndex, 'concurrency')).toBe(false);
    // `idempotent` = 5 total attempts. Re-indexing converges: a re-dispatched
    // container rebuilds the same graph over the same key.
    expect(codeGraphIndex.maxAttempts).toBe(5);
  });

  // Where the number went. Both are read from config so an operator can move
  // them against the fleet spend cap with no deploy, and the per-tenant one is
  // DERIVED from the global so the two cannot drift apart.
  it('puts the numbers in config, with the per-org one derived', () => {
    expect(indexInFlightCap()).toBe(DEFAULT_INDEX_IN_FLIGHT_CAP);
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '10');
    expect(indexInFlightCap()).toBe(10);
    expect(orgIndexInFlightCap(indexInFlightCap())).toBe(5);
  });

  it('exposes the dispatch service on the job DI seam', () => {
    // The 4-layer seam: `defineJob` hands the handler `jobServices`, so the step
    // shape drives the real singleton rather than importing it ad hoc.
    expect(jobServices.codeGraphIndexDispatch).toBe(codeGraphIndexDispatchService);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH — THE SAME FLEET PATH AS THE FIRST INDEX (MOTIR-2057).
//
// MOTIR-2027 left this job on the in-process shape (§11: "Still building
// in-process, unchanged") and production then ran the abandoned path at a ~68%
// failure rate for three days: `motir-core`'s whole-tree parse does not fit in
// the 180 s upload client deadline, and its five idempotent
// retries starved every other repo's refresh against motir-ai's one parse
// permit. So what these cases pin is that a PUSH refresh dispatches containers,
// that its per-repo debounce survived the move, and that the first-index path
// did not change — not one of which is safe to read off the diff.
// ─────────────────────────────────────────────────────────────────────────────

describe('system.code-graph-refresh runs on the INDEX FLEET', () => {
  it('drives boot → poll → settle ONCE, and NEVER fetches bytes in-process', async () => {
    const { workspaceId, projectIds, installationId } = await seedWorkspace('cgj-refresh', 2);
    stubIndexFleet();
    containerExitsWith(0);
    // The two ways bytes used to enter this process on a push: the buffering
    // provider fetch (removed outright by MOTIR-2124) and the motir-ai upload
    // that carried them under the 180 s deadline (removed by MOTIR-2138). Both
    // are asserted below as absence — see the two checks at the end.

    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const { result, ctx } = await engine.execute({
      events: [refreshEventFor({ installationId, workspaceId })],
    });

    // The ledger row a refresh writes is unchanged in SHAPE — one per repo, one
    // repoRef — which is what makes this a path swap and not a contract change.
    expect(result).toEqual({
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      coreTimings: expect.any(Array),
      indexModes: expect.any(Array),
    });

    const ids = stepIds(ctx).filter((id) => !id.startsWith('job-run:'));
    expect(ids[0]).toBe('resolve-target-v2');
    // The SAME three steps the first index writes — one code path, differing only
    // in the event and in the refresh job's debounce (MOTIR-2057), which is why
    // this suite asserts the shape on both jobs rather than trusting the sharing.
    // ⚠️ AND THE SAME ONE-CONTAINER SHAPE (MOTIR-4652): a refresh that still fanned
    // out per project while the first index no longer did would be a divergence
    // between two jobs whose whole point is that they are one path.
    const scoped = ids.filter((id) => /^index-(admit|boot|settle):/.test(id));
    const anchorProjectId = scoped[0]!.slice(scoped[0]!.indexOf(':') + 1);
    expect(projectIds).toContain(anchorProjectId);
    expect(scoped).toEqual([
      `index-admit:${anchorProjectId}`,
      `index-boot:${anchorProjectId}`,
      `index-settle:${anchorProjectId}`,
    ]);

    // ⚠️ THE DEFECT, INVERTED. A push used to buffer `motir-core`'s whole tree
    // into this function and POST it; one container per (organisation, repoRef)
    // now fetches it from the pre-signed URL instead, and the body is never read
    // here.
    expect(tarballBodyWasTouched()).toBe(false);
    // Not "was not called" but "cannot be called": the byte-returning provider
    // method is gone from the seam entirely (MOTIR-2124), so no future edit can
    // reintroduce the buffering path by reaching for it.
    expect(
      (githubProvider as unknown as Record<string, unknown>)['fetchRepoTarball'],
    ).toBeUndefined();
    expect((motirAiClient as unknown as Record<string, unknown>)['indexCodeGraph']).toBeUndefined();
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    for (const spec of fakeOrchestrator.specs) {
      expect(spec.env['MOTIR_INDEX_TARBALL_URL']).toBe(TARBALL_URL);
    }
  }, 30_000);

  it('fails the run and claims nothing when a refresh container dies', async () => {
    const { workspaceId, installationId } = await seedWorkspace('cgj-refresh-x', 1);
    stubIndexFleet();
    containerExitsWith(30);

    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const { result, error } = (await engine.execute({
      events: [refreshEventFor({ installationId, workspaceId })],
    })) as { result?: unknown; error?: { message?: string } };

    expect(result).toBeUndefined();
    expect(error?.message).toContain('graph_unbuildable');
    expect(error?.message).toContain(REPO_REF);
    // A stale graph must never read as fresh: no `succeeded` row, no output, and
    // the failure is what the DLQ and MOTIR-2105's staleness signal see.
    const runs = await refreshJobRuns();
    expect(runs.filter((run) => run.status === 'succeeded')).toEqual([]);
    expect(runs.every((run) => run.output === null)).toBe(true);
    // Teardown still happened — a failed refresh is not a billed leak.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns).toHaveLength(1);
  }, 30_000);

  it('keeps the per-repo DEBOUNCE, and carries no concurrency number', () => {
    // Read off the SHIPPED definition — what the module actually declared.
    // Coalescing happens at ENQUEUE (`lib/jobs/engine/dispatcher.ts`), which
    // `tests/jobs/engine-debounce.test.ts` drives directly; what THIS test pins is
    // that the declaration survived the move, which is exactly what a path swap
    // risks dropping.
    expect(codeGraphRefresh.id).toBe('system.code-graph-refresh');
    // A push storm still coalesces: same key (installation + repo), same 2m
    // window, same 15m cap on the total deferral.
    expect(codeGraphRefresh.debounce).toEqual({
      key: "event.data.installationId + '/' + event.data.repoOwner + '/' + event.data.repoName",
      period: '2m',
      timeout: '15m',
    });
    // `concurrency: 2` is GONE (MOTIR-2057), for MOTIR-1990's three reasons — a
    // stepped supervisor holds its slot for the container's whole life, an
    // unkeyed limit IS the starvation this job suffered, and its scale-to-zero
    // premise moved to the containers. The cap lives in admission control now —
    // and since MOTIR-3418 there is no option to carry one at all.
    expect(Object.hasOwn(codeGraphRefresh, 'concurrency')).toBe(false);
    expect(codeGraphRefresh.maxAttempts).toBe(5);
  });

  it('leaves the first index UNCHANGED — same step sequence, and no debounce on it', async () => {
    // The healthy path is not collateral: refresh adopting this shape must not
    // reshape it. Driving both jobs over ONE seeded world and comparing the step
    // sequences is the direct form of "they share one path, and it is the index
    // job's own" — a copied-and-edited shape fails here even when both are green
    // in isolation.
    const { workspaceId, installationId } = await seedWorkspace('cgj-parity', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const indexRun = await new JobTestEngine({ function: codeGraphIndex }).execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-parity-index' })],
    });
    const refreshRun = await new JobTestEngine({ function: codeGraphRefresh }).execute({
      events: [refreshEventFor({ installationId, workspaceId, eventId: 'evt-parity-refresh' })],
    });

    expect(indexRun.result).toEqual({
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      coreTimings: expect.any(Array),
      indexModes: expect.any(Array),
    });
    // ⚠️ THE PARITY IS OVER THE CONTRACT, NOT OVER THE NUMBERS. `coreTimings`
    // (MOTIR-4413) is a MEASUREMENT of two different runs, so comparing the two
    // results field for field would assert that two containers took the same
    // number of milliseconds — a flake by construction, and one that would read
    // as "the two jobs diverged". What must match is the ledger contract and the
    // SHAPE of the reading: the same three fields, and the same phases recorded
    // for the same number of containers.
    const { coreTimings: refreshTimings, ...refreshContract } = refreshRun.result as {
      coreTimings?: { projectId: string; phasesMs: Record<string, number> }[];
    } & Record<string, unknown>;
    const { coreTimings: indexTimings, ...indexContract } = indexRun.result as {
      coreTimings?: { projectId: string; phasesMs: Record<string, number> }[];
    } & Record<string, unknown>;
    expect(refreshContract).toEqual(indexContract);
    expect(refreshTimings).toHaveLength(indexTimings!.length);
    expect(refreshTimings!.map((t) => Object.keys(t.phasesMs).sort())).toEqual(
      indexTimings!.map((t) => Object.keys(t.phasesMs).sort()),
    );
    // ⚠️ THE PARITY IS OVER THE FLEET PATH, and `derive-first-audit` is the ONE
    // step deliberately outside it (MOTIR-2266). It hangs off
    // `system.code-graph-index` alone because `docs/decisions/audit-on-first-index.md`
    // §4 decides the FIRST audit and leaves "refresh the audit on a re-index"
    // open — a step in the SHARED `runIndexFleetSteps` would have answered that
    // by accident. Filtering it by NAME keeps the guard's whole point intact: any
    // OTHER step added to one job and not the other still fails here.
    const FIRST_AUDIT_STEP = 'derive-first-audit';
    const shapeOf = (ctx: Parameters<typeof stepIds>[0]) =>
      stepIds(ctx).filter((id) => !id.startsWith('job-run:') && id !== FIRST_AUDIT_STEP);
    expect(shapeOf(refreshRun.ctx)).toEqual(shapeOf(indexRun.ctx));
    // …and the divergence is real and one-directional: only the index job fires it.
    expect(stepIds(indexRun.ctx)).toContain(FIRST_AUDIT_STEP);
    expect(stepIds(refreshRun.ctx)).not.toContain(FIRST_AUDIT_STEP);

    // And the difference between them stays exactly one thing: the first index
    // must run PROMPTLY on install, so it must never grow a debounce window.
    expect(codeGraphIndex.debounce).toBeUndefined();
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE COLLAPSE BUYS, MEASURED (MOTIR-3484) — the `job_step` count.
//
// The old shape wrote a sleep checkpoint AND a result row per poll, and replayed
// every earlier one on each resume: `indexFleetSteps.ts` counted "roughly 128
// `step.run` round trips per 30-minute index, each one a database write", so a
// loop that polls N times performed on the order of N² memo lookups. The whole
// point of the collapse is that the number is now a CONSTANT — and a regression
// there is silent, because the run still succeeds.
//
// Driven through the ENGINE's real `createStepApi`, because `job_step` is what
// this measures and only the engine writes those rows. Millisecond budgets, so
// the two runs differ in POLL COUNT and in nothing else.
// ─────────────────────────────────────────────────────────────────────────────

describe('the step ledger a supervised run writes is a CONSTANT', () => {
  /** One `job_queue` row plus the engine step API bound to it. */
  async function engineSteps(jobId: string) {
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId,
        eventName: jobId,
        runAt: new Date(),
        maxAttempts: 5,
        eventId: null,
        workspaceId: null,
      },
    });
    return { runId: run.id, steps: createStepApi({ runId: run.id, workspaceId: null }) };
  }

  async function dispatchInputFor(slug: string) {
    const { workspaceId, projectIds, installationId } = await seedWorkspace(slug, 1);
    const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    return {
      installationId,
      providerId: 'github' as const,
      organizationId: workspace.organizationId,
      workspaceId,
      projectId: projectIds[0]!,
      repoOwner: 'moooon',
      repoName: 'motir-core',
      repoRef: REPO_REF,
      defaultBranch: 'main',
      runId: `run-${slug}`,
      dispatchId: `evt-${slug}`,
    };
  }

  /** Supervise one container to completion, terminal after `pollsBeforeExit` polls. */
  async function superviseCounting(slug: string, pollsBeforeExit: number) {
    stubIndexFleet();
    const input = await dispatchInputFor(slug);
    const { runId, steps } = await engineSteps('system.code-graph-index');

    const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
      codeGraphIndexDispatchService,
    );
    let polls = 0;
    vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockImplementation(
      async (session, previous, options) => {
        polls += 1;
        if (polls >= pollsBeforeExit) {
          for (const id of fakeOrchestrator.liveContainerIds()) {
            fakeOrchestrator.completeJob(id, { exitCode: 0 });
          }
        }
        return realPoll(session, previous, options);
      },
    );

    const outcome = await codeGraphIndexDispatchService.runIndexContainer(input, {
      ...INDEX_FAST_SUPERVISION,
      steps,
    });
    const rows = await adminDb.jobStep.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      outcome,
      polls,
      stepIdsWritten: rows.map((r) => r.stepId),
      projectId: input.projectId,
    };
  }

  it('writes THREE step rows however many times it polled', async () => {
    const quick = await superviseCounting('cgf-steps-1', 1);
    expect(quick.outcome).toMatchObject({ outcome: 'settled', verdict: { indexed: true } });
    expect(quick.stepIdsWritten).toEqual([
      `index-admit:${quick.projectId}`,
      `index-boot:${quick.projectId}`,
      `index-settle:${quick.projectId}`,
    ]);

    vi.restoreAllMocks();
    fakeOrchestrator.reset();
    driveIndexFleetFast();

    // ⚠️ THE SAME SUPERVISION AT A DIFFERENT POLL BUDGET — this is what makes the
    // number a PROPERTY rather than a coincidence of one fixture. Asserting "it
    // is small" would pass on a shape that writes one row per poll and happened
    // to poll twice.
    const long = await superviseCounting('cgf-steps-2', 8);
    expect(long.outcome).toMatchObject({ outcome: 'settled', verdict: { indexed: true } });
    expect(long.polls).toBeGreaterThanOrEqual(8);
    expect(long.stepIdsWritten).toHaveLength(3);
    expect(long.stepIdsWritten).toHaveLength(quick.stepIdsWritten.length);
    // And not one of them is a sleep checkpoint — the row kind the old shape
    // wrote once per poll.
    const kinds = await adminDb.jobStep.findMany({ select: { kind: true } });
    expect(kinds.every((k) => k.kind === 'run')).toBe(true);
  }, 60_000);
});
