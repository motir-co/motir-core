import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import { fleetCodeGraphIndex as codeGraphIndex } from '../helpers/fleetIndexJobs';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  INDEX_REPO_REF,
  containerExitsWith,
  driveIndexFleetFast,
  indexEventFor,
  indexJobRuns,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// WHERE A REFRESH'S CORE-SIDE TIME WENT (MOTIR-4413) — the LEDGER's half.
//
// `tests/ciFleet/codeGraphIndexDispatch.test.ts` proves the three spans are
// derived from sources that survive a `JobRunDefer`. This file proves the other
// end of the same wire: that what a dispatch measured reaches `job_run.output`,
// per `(repo × project)`, WITHOUT disturbing the three fields §6's ledger
// contract is made of.
//
// ⚠️ THE TWO HALVES ARE NOT REDUNDANT, and the split is the same one the fleet's
// own suites already use. A span can be derived perfectly and then dropped by the
// fan-out — `indexEveryProject` throws out of its loop on every pass but the
// last, so "the number was computed" and "the number reached the row" are
// genuinely different claims, and only the second is what an operator reads.

const REPO_REF = INDEX_REPO_REF;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  driveIndexFleetFast();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // FLEET-WIDE and reached by no cascade — see the note in
  // `tests/jobs/code-graph-index.test.ts`, which this file shares a world with.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the ledger row carries the CORE-side phases, per CONTAINER', () => {
  it('records THREE named spans for the container, beside the unchanged three fields', async () => {
    const { workspaceId, projectIds, installationId } = await seedIndexWorkspace('cgt-rows', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-cgt-rows' })],
    });

    const output = result as {
      indexed: boolean;
      repoRef: string;
      projectsIndexed: number;
      coreTimings?: { projectId: string; phasesMs: Record<string, number>; totalMs?: number }[];
    };

    // §6, untouched: this is what `listSucceededCodeGraphIndexRepoRefs` and the
    // onboarding wizard read, and the card that adds a fourth key is exactly the
    // card that has to prove it did not move the other three.
    expect(output.indexed).toBe(true);
    expect(output.repoRef).toBe(REPO_REF);
    // ⚠️ ONE, AND IT USED TO BE `2` (MOTIR-4652 · Story MOTIR-4642). The field
    // counts CONTAINERS, and the fan-out that made that number equal the project
    // count is retired — the graph is keyed to the organisation, so two projects
    // of one workspace share one index rather than booting two byte-identical
    // ones. The field is kept because historical rows carry other values.
    expect(output.projectsIndexed).toBe(1);

    // ONE row per container — the claim this arm has always made, and the number
    // it resolves to is now a constant rather than the project count. What it
    // still forbids is the aggregation: a single `phasesMs` summed across
    // containers would make a slow boot on one of them unreadable, and that stays
    // true the day a repository boots more than one again.
    expect(output.coreTimings).toHaveLength(1);
    // The record is keyed by the ANCHOR project — one of the workspace's, chosen
    // to resolve the run credential motir-ai still mints per project. WHICH one
    // is not a contract, so it is asserted as membership.
    expect(projectIds).toContain(output.coreTimings![0]!.projectId);
    for (const timing of output.coreTimings!) {
      expect(Object.keys(timing.phasesMs).sort()).toEqual([
        'admissionWait',
        'boot',
        'pollToDetect',
      ]);
      expect(timing.totalMs).toBe(Object.values(timing.phasesMs).reduce((sum, ms) => sum + ms, 0));
    }

    // AND IT IS ON THE PERSISTED ROW, not only in the handler's return value —
    // the ledger is the surface an operator actually reads, and it round-trips
    // through JSON to get there.
    const runs = await indexJobRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual(output);
  }, 30_000);

  it('a dispatch that reports NO spans still writes the ledger row it always wrote', async () => {
    const { workspaceId, installationId } = await seedIndexWorkspace('cgt-none', 1);
    stubIndexFleet();
    containerExitsWith(0);

    // ⚠️ THE STATE THIS MODELS IS A DEPLOYMENT MID-ROLLOUT, and it is the reason
    // the field is optional rather than merely nullable. A run already in flight
    // when this card ships replays an `index-admit` memo written in the old
    // shape for the rest of its life, so `coreTimings` comes back with an empty
    // map — and the row it writes must be byte-identical to the row it would
    // have written before, because §6 says that row is a permanent claim and
    // every reader of it predates this card.
    //
    // ⚠️ IT CHAINS OFF THE EXISTING SPY RATHER THAN RE-BINDING THE METHOD.
    // `driveIndexFleetFast` has already replaced `advanceIndexContainer`, and
    // `vi.spyOn` returns THAT SAME spy rather than a fresh one — so binding the
    // method here and calling it from a new implementation calls the new
    // implementation, which is a stack overflow rather than a failed assertion.
    // ⚠️ IT STRIPS THE MODE TOO (MOTIR-4945). This test's claim is that a
    // dispatch reporting NOTHING writes the row it always wrote, and `indexMode`
    // is a SECOND optional channel added after this test — so a run that still
    // reports one would land a fifth key and fail the exact-shape assertion
    // below for the right reason. The mid-rollout state being modelled is a memo
    // that predates BOTH cards, which reports neither.
    const spy = vi.mocked(codeGraphIndexDispatchService.advanceIndexContainer);
    const withFastBudgets = spy.getMockImplementation()!;
    spy.mockImplementation(async (runId, input, options) => {
      const outcome = await withFastBudgets(runId, input, options);
      if (outcome.outcome !== 'settled') return outcome;
      const { indexMode: _dropped, ...withoutMode } = outcome;
      return { ...withoutMode, coreTimings: { phasesMs: {} } };
    });

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-cgt-none' })],
    })) as { result?: unknown; error?: unknown };

    // Telemetry did not fail the run — the whole contract, stated as an
    // assertion. `logPhaseTimings` carries the same rule for the motir-ai half.
    expect(error).toBeUndefined();
    // EXACTLY the three fields. `toEqual` rather than `toMatchObject`, because
    // the claim is that no fourth key appears at all: an empty `coreTimings: []`
    // would be a run announcing that it measured nothing, which is noise on a row
    // many readers parse.
    expect(result).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 1 });

    const runs = await indexJobRuns();
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual({ indexed: true, repoRef: REPO_REF, projectsIndexed: 1 });
  }, 30_000);
});

// WHETHER THE REFRESH SYNCED OR REBUILT (MOTIR-4945) — the LEDGER's half.
//
// `tests/ciFleet/codeGraphIndexDispatch.test.ts` proves the mode is read from a
// source that survives a `JobRunDefer` — the boot memo. This file proves the
// other end of the same wire: that what the dispatch determined reaches
// `job_run.output`, per `(repo × project)`, without disturbing the three fields
// §6's ledger contract is made of.
//
// The two are not redundant for the reason stated at the top of this file:
// `indexEveryProject` throws out of its loop on every pass but the last, so "the
// mode was determined" and "the mode reached the row" are different claims, and
// only the second is what answers *is incremental indexing working?*
describe('the ledger row carries the SYNC/REBUILD mode, per CONTAINER', () => {
  it('records a mode for the container, beside the unchanged three fields', async () => {
    const { workspaceId, projectIds, installationId } = await seedIndexWorkspace('cgm-rows', 2);
    stubIndexFleet();
    containerExitsWith(0);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-cgm-rows' })],
    });

    const output = result as {
      indexed: boolean;
      repoRef: string;
      projectsIndexed: number;
      indexModes?: { projectId: string; mode: string }[];
    };

    // §6, untouched — the same guard the timings arm carries, re-asserted because
    // this is the card adding a FIFTH key.
    expect(output.indexed).toBe(true);
    expect(output.repoRef).toBe(REPO_REF);
    // ⚠️ ONE — see the timings arm above. The fan-out is retired (MOTIR-4652).
    expect(output.projectsIndexed).toBe(1);

    // ONE row per container, and one container. The per-container shape is kept
    // rather than flattened to a single `mode` key: the grant is motir-ai's
    // decision per credential, so a repository CAN legitimately sync under one
    // and rebuild under another, and a scalar would have to be re-widened the day
    // that happens.
    expect(output.indexModes).toHaveLength(1);
    expect(projectIds).toContain(output.indexModes![0]!.projectId);
    // `rebuild`, because this suite's motir-ai stub offers no snapshot — which is
    // also the honest default state of a fresh repository.
    for (const record of output.indexModes!) expect(record.mode).toBe('rebuild');

    // AND IT IS ON THE PERSISTED ROW, not only in the handler's return value.
    const runs = await indexJobRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual(output);
  }, 30_000);

  it('carries `sync` through to the row when the dispatch reports one', async () => {
    const { workspaceId, installationId } = await seedIndexWorkspace('cgm-sync', 1);
    stubIndexFleet();
    containerExitsWith(0);

    // The grant is motir-ai's decision and this suite stubs motir-ai, so the
    // sync arm is driven at the dispatch seam rather than by inventing a
    // snapshot URL the stub would have to serve. What is under test here is the
    // WIRE — that a `sync` determined upstream lands on the row unchanged —
    // and the dispatch-side suite is what proves the determination itself.
    const spy = vi.mocked(codeGraphIndexDispatchService.advanceIndexContainer);
    const withFastBudgets = spy.getMockImplementation()!;
    spy.mockImplementation(async (runId, input, options) => {
      const outcome = await withFastBudgets(runId, input, options);
      if (outcome.outcome !== 'settled') return outcome;
      return { ...outcome, indexMode: 'sync' as const };
    });

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-cgm-sync' })],
    });

    const output = result as { indexModes?: { projectId: string; mode: string }[] };
    expect(output.indexModes!.map((m) => m.mode)).toEqual(['sync']);

    const runs = await indexJobRuns();
    expect(runs[0]!.output).toEqual(output);
  }, 30_000);

  it('a dispatch that reports NO mode writes the row without the key at all', async () => {
    const { workspaceId, installationId } = await seedIndexWorkspace('cgm-none', 1);
    stubIndexFleet();
    containerExitsWith(0);

    // ⚠️ THE MID-ROLLOUT STATE, and the arm where a wrong answer would be
    // invisible. A run already in flight holds an `index-boot` memo with no
    // `syncGranted`, so its dispatch reports no mode — and the row must then be
    // byte-identical to the row it would have written before this card. An
    // `indexModes: []` would be a run announcing it determined nothing, and a
    // defaulted `rebuild` would be worse still: it is the COMMONER mode, so
    // every wrong row would look exactly right and the first measurement of what
    // a sync saves would be quietly polluted.
    const spy = vi.mocked(codeGraphIndexDispatchService.advanceIndexContainer);
    const withFastBudgets = spy.getMockImplementation()!;
    spy.mockImplementation(async (runId, input, options) => {
      const outcome = await withFastBudgets(runId, input, options);
      if (outcome.outcome !== 'settled') return outcome;
      const { indexMode: _dropped, ...withoutMode } = outcome;
      return withoutMode;
    });

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-cgm-none' })],
    })) as { result?: unknown; error?: unknown };

    // A ledger field never fails a run.
    expect(error).toBeUndefined();
    const output = result as Record<string, unknown>;
    expect(output).not.toHaveProperty('indexModes');
    // The spans beside it are unaffected — the two channels are independent, and
    // that independence is the whole reason they are two arrays rather than one.
    expect(output['coreTimings']).toBeDefined();

    const runs = await indexJobRuns();
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).not.toHaveProperty('indexModes');
  }, 30_000);
});

// THE CONTAINER'S OWN VERDICT, BESIDE THE OFFER-DERIVED ONE (MOTIR-5058).
//
// The describe above proves the OFFER reaches the row. This one proves the row can
// now also carry what the container DID with that offer — the fact that lives in
// motir-ai, behind the open/closed boundary, and that nothing on this side could
// see until this card.
//
// ⚠️ THE TWO ARE NOT ONE FIELD MEASURED TWICE, and the third case below is what
// proves it: a run OFFERED a snapshot whose sync then threw is `sync` on this side
// — correctly, a snapshot WAS offered — and `build` on the container's. That single
// disagreement is the entire reason the second field exists, and it is the arm
// MOTIR-5027's detector currently reads straight through.
//
// ⚠️ DRIVEN AT THE FETCH SEAM, NOT BY MOCKING THE CLIENT. What is under test is the
// WIRE — motir-ai's body shape reaching this ledger row through the real parsing in
// `fetchCodeGraphRunVerdict` — so faking that function would check the seam from one
// end and prove the wrong thing.
//
// ⚠️ ONE INDEX RUN PER TEST, AND THAT IS A CONSTRAINT RATHER THAN A STYLE. Both
// `stubIndexFleet` and `containerExitsWith` install a spy that CLOSES OVER the
// implementation it replaced, so calling either twice in one test body nests the
// wrappers and the second run recurses until the stack dies. `afterEach`'s
// `restoreAllMocks` is what makes a per-test install clean; three runs in one `it`
// is not a longer version of the same thing.
describe('the ledger row ALSO carries what the CONTAINER did (MOTIR-5058)', () => {
  type ModeRow = {
    projectId: string;
    mode: string;
    containerMode?: string;
    containerFallbackReason?: string;
    containerTimings?: {
      totalMs?: number;
      unaccountedMs?: number;
      peakRssMb?: number;
      phasesMs?: Record<string, number>;
      syncCounts?: Record<string, number>;
    };
  };

  /**
   * Stand up the fleet world with motir-ai answering the run-verdict route with
   * `body`, and force the OFFER-derived mode to `offer`.
   *
   * `body === 'unreachable'` makes the verdict call throw; `body === 'not-found'`
   * answers 404, which is the OLDER-motir-ai arm. Everything else is serialized as
   * the response body. Every other route behaves exactly as `stubIndexFleet` left it.
   */
  function world(offer: 'sync' | 'rebuild', body: unknown): void {
    stubIndexFleet();
    containerExitsWith(0);

    const base = globalThis.fetch as unknown as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        if (new URL(String(url)).pathname.endsWith('/v1/code-graph/run/verdict')) {
          if (body === 'unreachable') throw new Error('motir-ai is unreachable');
          if (body === 'not-found') return new Response('not found', { status: 404 });
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return base(url, init);
      }),
    );

    // The OFFER is motir-ai's decision and this suite stubs motir-ai, so it is
    // driven at the dispatch seam — the same technique, and the same reason, as the
    // `sync` case in the describe above.
    const spy = vi.mocked(codeGraphIndexDispatchService.advanceIndexContainer);
    const withFastBudgets = spy.getMockImplementation()!;
    spy.mockImplementation(async (runId, input, options) => {
      const outcome = await withFastBudgets(runId, input, options);
      if (outcome.outcome !== 'settled') return outcome;
      return { ...outcome, indexMode: offer };
    });
  }

  async function runIndex(slug: string): Promise<ModeRow[]> {
    const { workspaceId, installationId } = await seedIndexWorkspace(slug, 1);
    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: `evt-${slug}` })],
    })) as { result?: unknown; error?: unknown };
    // Surface the handler's own failure rather than letting it reach the reader as a
    // status assertion — a run that THREW and a run that DEFERRED both leave the row
    // at `running`, and only one of them is a defect in this diff.
    if (error) throw error;

    const output = result as { indexModes?: ModeRow[] };
    // ALWAYS re-assert against the PERSISTED row, never only the return value — for
    // the reason the file's header states: `indexEveryProject` throws out of its loop
    // on every pass but the last, so "computed" and "reached the row" are different
    // claims and only the second is what an operator reads.
    const runs = await indexJobRuns();
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual(output);
    return output.indexModes!;
  }

  // ── AC 3 · the three states a row must now tell apart ────────────────────────

  it('NOT OFFERED — a cold build, with nothing to explain', async () => {
    // No snapshot was granted, so the container built from scratch. Both sides
    // agree, and the absent reason is itself information: a `build` with no reason
    // was never offered anything.
    world('rebuild', { verdict: { indexMode: 'build', fallbackReason: null } });

    expect(await runIndex('cgv-cold')).toEqual([
      { projectId: expect.any(String), mode: 'rebuild', containerMode: 'build' },
    ]);
  }, 30_000);

  it('OFFERED AND SYNCED — the happy path the feature actually promises', async () => {
    // The two sides agree here too, which is exactly why agreement is not evidence
    // that the fields are interchangeable: they agree on two of the three arms.
    world('sync', { verdict: { indexMode: 'sync', fallbackReason: null } });

    expect(await runIndex('cgv-synced')).toEqual([
      { projectId: expect.any(String), mode: 'sync', containerMode: 'sync' },
    ]);
  }, 30_000);

  it('OFFERED AND REBUILT ANYWAY — the blind arm, now on the record with its reason', async () => {
    // THE CARD. Before this, the row said `sync` and nothing contradicted it: the
    // offer-derived mode is not wrong — a snapshot WAS offered — it simply cannot
    // see what happened next. A detector reading it reported healthy through exactly
    // the failure it existed to catch.
    world('sync', {
      verdict: { indexMode: 'build', fallbackReason: 'engine called the snapshot stale' },
    });

    const rows = await runIndex('cgv-refused');
    expect(rows).toEqual([
      {
        projectId: expect.any(String),
        mode: 'sync',
        containerMode: 'build',
        containerFallbackReason: 'engine called the snapshot stale',
      },
    ]);
    // Said twice deliberately: the two facts are SEPARATELY readable on one row,
    // neither having overwritten the other. That is criterion 2's whole content.
    expect(rows[0]!.mode).toBe('sync');
    expect(rows[0]!.containerMode).toBe('build');
  }, 30_000);

  // ── AC 4 · the defensive arm, which is what frees the merge order ────────────

  // Four ways motir-ai can fail to answer, one required outcome: the run SUCCEEDS
  // and the `indexModes` entry is byte-identical to the one written before this
  // card — `{ projectId, mode }` and nothing else.
  //
  // This is the property that makes the two repositories' pull requests free to land
  // in either order, so it is asserted per failure mode rather than once: a client
  // that handled three of these and threw on the fourth would pass a single-case test
  // and fail a production deploy that happened to hit the fourth.
  it.each([
    // An OLDER motir-ai: the route does not exist yet. THE merge-order case.
    ['a 404 from an older motir-ai', 'cgv-404', 'not-found'],
    // A motir-ai that serves the route and has nothing recorded for this run.
    ['an explicit absent verdict', 'cgv-empty', { verdict: null }],
    // One that answers with a verdict object carrying neither field.
    ['a verdict carrying no fields', 'cgv-fieldless', { verdict: {} }],
    // One that does not answer at all.
    ['an unreachable motir-ai', 'cgv-unreachable', 'unreachable'],
  ])(
    'leaves the row BYTE-IDENTICAL to today’s on %s',
    async (_label, slug, body) => {
      world('rebuild', body);

      const rows = await runIndex(slug as string);
      // `toEqual` against an exact object is the assertion that matters — a
      // `toMatchObject` would pass while an undefined-valued key sat on the row.
      expect(rows).toEqual([{ projectId: expect.any(String), mode: 'rebuild' }]);
      // And the keys explicitly, because `toEqual` treats an explicitly-undefined
      // property as absent while `JSON.stringify` onto the ledger does too — so the
      // one thing neither of them would catch is the shape drifting for a reader of
      // the TYPE. A defaulted `containerMode` here would be indistinguishable from a
      // measured one, which is the confusion the field was added to end.
      expect(Object.keys(rows[0]!).sort()).toEqual(['mode', 'projectId']);
    },
    30_000,
  );

  // ── WHAT THE RUN COST (MOTIR-5101) ──────────────────────────────────────────
  //
  // The row above says what the container DID. These say what it COST, and the
  // reason they had to cross the boundary is that this side's own number cannot
  // answer the question: `job_run.duration_ms` spans machine create, image pull,
  // a fixed 15 000 ms detect cap and teardown — 31 513 ms and 58 738 ms on two
  // runs eighteen minutes apart, a swing 62% the size of the effect.

  it('carries the CONTAINER’s timings, beside `coreTimings` and never merged into it', async () => {
    // AC 4, and the failure it guards is a MERGE rather than a miss. The two
    // fields are both "timings" for the same refresh and a later reader's
    // instinct is to unify them — but `coreTimings` is THIS side's provisioning
    // overhead and this is the span inside the container, and adding them
    // produces the very number that says incremental indexing saves nothing.
    // That is the collision MOTIR-5055 records, one field over.
    world('sync', {
      verdict: {
        indexMode: 'sync',
        fallbackReason: null,
        timings: {
          totalMs: 50_203,
          unaccountedMs: 118,
          peakRssMb: 888,
          phasesMs: { build: 21_331, fetch: 4_120 },
          syncCounts: { filesChecked: 4580, filesModified: 12 },
        },
      },
    });

    const { workspaceId, installationId } = await seedIndexWorkspace('cgv-timed', 1);
    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result, error } = (await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-cgv-timed' })],
    })) as { result?: unknown; error?: unknown };
    if (error) throw error;

    const output = result as {
      coreTimings?: { projectId: string; phasesMs: Record<string, number> }[];
      indexModes?: ModeRow[];
    };

    // The container's own reading, intact.
    expect(output.indexModes![0]!.containerTimings).toEqual({
      totalMs: 50_203,
      unaccountedMs: 118,
      peakRssMb: 888,
      phasesMs: { build: 21_331, fetch: 4_120 },
      syncCounts: { filesChecked: 4580, filesModified: 12 },
    });

    // ⚠️ AND `coreTimings` IS STILL THERE, STILL ITS OWN ARRAY, AND STILL
    // MEASURING SOMETHING ELSE. Its phases are the CORE-side spans MOTIR-4413
    // named; the container's are the container's. Neither array's phase names
    // appear in the other, which is the mechanical form of "not conflated".
    expect(Object.keys(output.coreTimings![0]!.phasesMs).sort()).toEqual([
      'admissionWait',
      'boot',
      'pollToDetect',
    ]);
    const containerPhases = Object.keys(output.indexModes![0]!.containerTimings!.phasesMs!);
    for (const phase of containerPhases) {
      expect(output.coreTimings![0]!.phasesMs).not.toHaveProperty(phase);
    }

    // And both survived the JSON round trip onto the row an operator reads.
    const runs = await indexJobRuns();
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toEqual(output);
  }, 30_000);

  it('a verdict WITH a mode but NO timings adds no timings key at all', async () => {
    // AC 5's narrow arm, and the one the `it.each` above cannot reach: there the
    // whole verdict is absent, so any bug in the timings path is masked by the
    // verdict path already returning null. Here motir-ai answers normally and
    // simply has no timings for this run — which is EVERY row written between
    // MOTIR-5122 and this card, i.e. the whole of the store's history.
    //
    // The mode must still land, and the timings key must be absent rather than
    // present-and-empty: `containerTimings: {}` would be a run announcing it had
    // measured itself and found nothing.
    world('sync', { verdict: { indexMode: 'sync', fallbackReason: null } });

    const rows = await runIndex('cgv-untimed');
    expect(rows).toEqual([{ projectId: expect.any(String), mode: 'sync', containerMode: 'sync' }]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['containerMode', 'mode', 'projectId']);
  }, 30_000);

  it('carries a PARTIAL reading — the fields a run did not report are absent, not zero', async () => {
    // The fields arrive INDEPENDENTLY: the sync counts exist only on a run that
    // synced, and `peakRssMb` only from a container new enough to send it, which
    // is none of them before MOTIR-5101 extended the wire. So a run reporting
    // `totalMs` alone is an ordinary state, not a degenerate one.
    //
    // Every absent field must be OMITTED rather than written as `0`: this row is
    // JSON on a durable ledger, and a zero is indistinguishable from a
    // measurement — the confusion the whole MOTIR-5055 → MOTIR-5122 → MOTIR-5058
    // chain exists to remove, in its cheapest possible form.
    world('sync', {
      verdict: {
        indexMode: 'sync',
        fallbackReason: null,
        timings: { totalMs: 50_203 },
      },
    });

    const rows = await runIndex('cgv-partial');
    expect(rows[0]!.containerTimings).toEqual({ totalMs: 50_203 });
    // The key set explicitly: `toEqual` treats an explicitly-undefined property
    // as absent, so it alone would pass while `peakRssMb: undefined` sat on the
    // object and serialised onto the row.
    expect(Object.keys(rows[0]!.containerTimings!)).toEqual(['totalMs']);
  }, 30_000);

  it('ignores a MALFORMED timings object rather than writing it to the ledger', async () => {
    // The body crosses the open/closed boundary and lands on a durable row, so a
    // field of the wrong type must become absent — never a coerced number. A
    // string `totalMs` written through would be indistinguishable, to every later
    // reader of the series, from a measured one.
    world('rebuild', {
      verdict: {
        indexMode: 'build',
        fallbackReason: null,
        timings: {
          totalMs: 'fast',
          unaccountedMs: null,
          peakRssMb: 888,
          phasesMs: ['not', 'a', 'map'],
          syncCounts: { filesChecked: 'lots', nodesUpdated: 7 },
        },
      },
    });

    const rows = await runIndex('cgv-malformed');
    // Only the two well-formed readings survive — the valid `peakRssMb`, and the
    // one numeric count out of a map whose other entry was a string.
    expect(rows[0]!.containerTimings).toEqual({
      peakRssMb: 888,
      syncCounts: { nodesUpdated: 7 },
    });
  }, 30_000);
});
