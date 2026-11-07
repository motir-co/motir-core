import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { askIndexAllowanceUnlessBooted } from '@/lib/jobs/indexFleetSteps';
import { jobServices } from '@/lib/jobs/services';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobStepRepository } from '@/lib/repositories/jobStepRepository';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import {
  AI_PLAN_INDEX_PAUSE_REASON,
  indexDrawKey,
  indexPauseReasonFor,
  isIndexHardStop,
  parseIndexAllowanceVerdict,
} from '@/lib/ciFleet/indexAllowance';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  containerExitsWith,
  INDEX_REPO_REF,
  indexAllowanceWorld,
  indexEventFor,
  indexJobRuns,
  driveIndexFleetFast,
  indexStepIds,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// THE INDEX ALLOWANCE ON THE DISPATCH PATH (MOTIR-4593 · Story MOTIR-4335).
//
// motir-ai owns the allowance and its verdicts (MOTIR-4592 / MOTIR-5284, proven
// against a real ledger there). What is under test HERE is what motir-core does
// with a verdict: which ones boot, which ones pause and what they record, where
// the one draw per container happens, and that nothing on this path reaches a
// ledger route. motir-ai is the HTTP leaf, answered by the shared fleet fixture's
// `indexAllowanceWorld`; the job, the dispatch service, the orchestrator port and
// the database are real.
//
// ⚠️ Motir does not charge for code indexing. The allowance is internal.

const [REPO_OWNER, REPO_NAME] = INDEX_REPO_REF.split('/') as [string, string];

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
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function runIndex(
  slug: string,
  opts: { checkOutcome?: string; exitCode?: number | null } = {},
) {
  const seeded = await seedIndexWorkspace(slug, 1);
  stubIndexFleet();
  if (opts.checkOutcome) indexAllowanceWorld.checkOutcome = opts.checkOutcome;
  containerExitsWith(opts.exitCode === undefined ? 0 : opts.exitCode);
  const engine = new JobTestEngine({ function: codeGraphIndex });
  const run = (await engine.execute({
    events: [
      indexEventFor({
        installationId: seeded.installationId,
        workspaceId: seeded.workspaceId,
        eventId: `evt-${slug}`,
      }),
    ],
  })) as {
    result?: unknown;
    error?: { message?: string };
    ctx: Parameters<typeof indexStepIds>[0];
  };
  return { ...seeded, ...run };
}

function repoRow() {
  return adminDb.githubRepo.findFirstOrThrow({
    where: { owner: REPO_OWNER, name: REPO_NAME },
    select: {
      indexPausedReason: true,
      indexPausedAt: true,
      indexingRunId: true,
      indexedHeadSha: true,
    },
  });
}

describe('the vocabulary', () => {
  it('a hard stop is the outcome FAMILY, not a list of today’s names (AC 4)', () => {
    expect(isIndexHardStop('hard_stop_no_credit')).toBe(true);
    expect(isIndexHardStop('hard_stop_allowance_exhausted')).toBe(true);
    // Hard gate B lands in motir-ai separately (MOTIR-5280). Refused with no change here.
    expect(isIndexHardStop('hard_stop_headroom_exhausted')).toBe(true);
    for (const boots of [
      'ok',
      'soft_gate_crossed',
      'no_allowance_configured',
      'exempt',
      'hard_stop_',
    ]) {
      expect(isIndexHardStop(boots), boots).toBe(false);
    }
    expect(indexPauseReasonFor('hard_stop_no_credit')).toBe('paused_index_no_credit');
    expect(indexPauseReasonFor('hard_stop_allowance_exhausted')).toBe(
      'paused_index_allowance_exhausted',
    );
    expect(indexPauseReasonFor('soft_gate_crossed')).toBeNull();
  });

  it('a body that is not a verdict is "could not ask", never a verdict', () => {
    for (const body of [
      null,
      'ok',
      {},
      { outcome: '' },
      { code: 'internal_error' },
      { credential: 'x' },
    ]) {
      expect(parseIndexAllowanceVerdict(body)).toBeNull();
    }
    expect(parseIndexAllowanceVerdict({ outcome: 'ok', attributedCredits: 3 })).toMatchObject({
      outcome: 'ok',
      attributedCredits: 3,
      window: null,
    });
  });
});

describe('THE SOFT GATE BOOTS (AC 3) — the assertion whose opposite looks correct', () => {
  it('soft_gate_crossed boots the container, indexes, and records no pause', async () => {
    const { result } = await runIndex('alw-soft', { checkOutcome: 'soft_gate_crossed' });

    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(result).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF });
    expect((await repoRow()).indexPausedReason).toBeNull();
  }, 30_000);

  it.each(['ok', 'exempt', 'no_allowance_configured'])(
    '%s boots — a meta organisation (exempt) is never stopped (AC 7)',
    async (outcome) => {
      const { result } = await runIndex(`alw-${outcome.slice(0, 6)}`, { checkOutcome: outcome });
      expect(fakeOrchestrator.provisioned).toHaveLength(1);
      expect(result).toMatchObject({ indexed: true });
    },
    30_000,
  );
});

describe('a HARD STOP pauses: nothing admitted, nothing booted, the reason recorded (AC 3a, 4)', () => {
  it.each([
    ['hard_stop_no_credit', 'paused_index_no_credit'],
    ['hard_stop_allowance_exhausted', 'paused_index_allowance_exhausted'],
    ['hard_stop_headroom_exhausted', 'paused_index_headroom_exhausted'],
  ])(
    '%s → %s, as a SUCCEEDED no-op run',
    async (outcome, reason) => {
      const admit = vi.spyOn(codeGraphIndexDispatchService, 'admitIndexContainer');
      const { result, ctx } = await runIndex(`alw-${reason.slice(13, 20)}`, {
        checkOutcome: outcome,
      });

      expect(result).toEqual({ indexed: false, reason });
      expect(fakeOrchestrator.provisioned).toEqual([]);
      expect(admit).not.toHaveBeenCalled();
      expect(indexStepIds(ctx).filter((id) => id.startsWith('index-'))).toEqual([
        'index-allowance',
      ]);
      expect(indexAllowanceWorld.draws).toEqual([]);

      const runs = await indexJobRuns();
      expect(runs.map((r) => r.status)).toEqual(['succeeded']);
      expect(runs[0]!.output).toEqual({ indexed: false, reason });

      const row = await repoRow();
      expect(row.indexPausedReason).toBe(reason);
      expect(row.indexPausedAt).toBeInstanceOf(Date);
      // A refused dispatch booted nothing, so nothing is in flight for the repo.
      expect(row.indexingRunId).toBeNull();
    },
    30_000,
  );

  it('pins BOTH arms against each other: a paid org past its allowance boots, a Free org past its allowance does not', async () => {
    const paid = await runIndex('alw-arm-paid', { checkOutcome: 'soft_gate_crossed' });
    expect(paid.result).toMatchObject({ indexed: true });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);

    await truncateAuthTables();
    await truncateJobRuns();
    fakeOrchestrator.reset();
    const free = await runIndex('alw-arm-free', { checkOutcome: 'hard_stop_allowance_exhausted' });
    expect(free.result).toEqual({ indexed: false, reason: 'paused_index_allowance_exhausted' });
    expect(fakeOrchestrator.provisioned).toEqual([]);
  }, 60_000);

  it('the next dispatch the allowance lets boot LIFTS the recorded pause', async () => {
    const { installationId, workspaceId } = await runIndex('alw-lift', {
      checkOutcome: 'hard_stop_no_credit',
    });
    expect((await repoRow()).indexPausedReason).toBe('paused_index_no_credit');

    indexAllowanceWorld.checkOutcome = 'ok';
    const engine = new JobTestEngine({ function: codeGraphIndex });
    const again = await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-alw-lift-2' })],
    });

    expect(again.result).toMatchObject({ indexed: true });
    const row = await repoRow();
    expect(row.indexPausedReason).toBeNull();
    expect(row.indexPausedAt).toBeNull();
  }, 60_000);
});

describe('"could not ask" boots (the rollout, and a motir-ai blip)', () => {
  it('a motir-ai that answers 500 does not stop indexing', async () => {
    const { result } = await runIndex('alw-500', { checkOutcome: 'http_500' });
    expect(indexAllowanceWorld.checks).toHaveLength(1);
    expect(result).toMatchObject({ indexed: true });
  }, 30_000);

  it('a run that already BOOTED before the ask existed proceeds without asking', async () => {
    const seeded = await seedIndexWorkspace('alw-resume', 1);
    stubIndexFleet();
    const run = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        workspaceId: seeded.workspaceId,
        runAt: new Date(),
        maxAttempts: 1,
      },
    });
    const anchorProjectId = seeded.projectIds[0]!;
    const target = {
      indexed: true as const,
      repoRef: INDEX_REPO_REF,
      providerId: 'github' as const,
      organizationId: 'org-resume',
      anchorProjectId,
    };
    const ask = vi.spyOn(codeGraphIndexDispatchService, 'askIndexAllowance');

    await adminDb.jobStep.create({
      data: {
        runId: run.id,
        stepId: `index-boot:${anchorProjectId}`,
        kind: 'run',
        result: { phase: 'supervising' },
        workspaceId: seeded.workspaceId,
      },
    });
    indexAllowanceWorld.checkOutcome = 'hard_stop_no_credit';

    expect(await askIndexAllowanceUnlessBooted({ runId: run.id }, jobServices, target)).toEqual({
      proceed: true,
      outcome: null,
    });
    expect(ask).not.toHaveBeenCalled();

    // A fresh run of the same shape DOES ask, and is refused.
    const fresh = await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        workspaceId: seeded.workspaceId,
        runAt: new Date(),
        maxAttempts: 1,
      },
    });
    expect(
      await askIndexAllowanceUnlessBooted({ runId: fresh.id }, jobServices, target),
    ).toMatchObject({
      proceed: false,
      reason: 'paused_index_no_credit',
    });
  });
});

describe('ONE draw per container, at teardown (AC 1, 8)', () => {
  it('draws exactly once, keyed on the container, with its billable seconds — the accrual does not draw', async () => {
    const { result } = await runIndex('alw-draw');

    expect(result).toMatchObject({ indexed: true });
    expect(indexAllowanceWorld.draws).toHaveLength(1);
    const [container] = fakeOrchestrator.provisioned;
    const draw = indexAllowanceWorld.draws[0]!;
    expect(draw.idempotencyKey).toBe(indexDrawKey('fake', container!.id));
    expect(Number.isInteger(draw.containerSeconds)).toBe(true);
    expect(draw.containerSeconds).toBeGreaterThanOrEqual(0);
    expect(draw.coreOrganizationId).toBe(indexAllowanceWorld.checks[0]!.coreOrganizationId);
  }, 30_000);

  it('the poll — where the accrual checkpoint is written — names no draw', () => {
    // `billable_seconds` is a TOTAL to date on the accrual, never a delta: a draw
    // there would attribute the same seconds twice. Asserted on the source because
    // the checkpoint is a function the fixture already wraps.
    const source = readFileSync(
      join(process.cwd(), 'lib/services/codeGraphIndexDispatchService.ts'),
      'utf8',
    );
    const pollStart = source.indexOf('async pollIndexContainer(');
    const pollEnd = source.indexOf('async settleIndexContainer(');
    expect(pollStart).toBeGreaterThan(0);
    const poll = source.slice(pollStart, pollEnd);
    expect(poll).toContain('recordContainerAccrual');
    expect(poll).not.toMatch(/drawIndexAllowance|drawAllowanceForContainer/);
    expect(source.slice(pollEnd)).toContain('drawAllowanceForContainer(session');
  });

  it('a FAILED container still draws, and is logged as a failure rather than as consumption', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { error } = await runIndex('alw-fail', { exitCode: 30 });

    expect(error?.message).toContain('graph_unbuildable');
    expect(indexAllowanceWorld.draws).toHaveLength(1);
    const logged = warn.mock.calls.find((call) =>
      String(call[0]).includes('drawn by a container that did not index'),
    );
    expect(logged?.[1]).toMatchObject({ exitClass: 'graph_unbuildable' });
  }, 30_000);
});

describe('nothing on this path reaches the visible balance (AC 2)', () => {
  it.each(['ok', 'soft_gate_crossed'])(
    'with the draw answering %s, the only credit routes called are the allowance’s own',
    async (drawOutcome) => {
      const seeded = await seedIndexWorkspace(`alw-bal-${drawOutcome.slice(0, 4)}`, 1);
      stubIndexFleet();
      indexAllowanceWorld.drawOutcome = drawOutcome;
      containerExitsWith(0);
      await new JobTestEngine({ function: codeGraphIndex }).execute({
        events: [
          indexEventFor({ installationId: seeded.installationId, workspaceId: seeded.workspaceId }),
        ],
      });

      const creditPaths = indexAllowanceWorld.aiPaths.filter((p) => p.includes('/v1/credits/'));
      expect(creditPaths.sort()).toEqual(['/v1/credits/index-check', '/v1/credits/index-draw']);
      expect(
        indexAllowanceWorld.aiPaths.some((p) => /debit|ci-overage|top-?up|grant/.test(p)),
      ).toBe(false);
    },
    30_000,
  );
});

describe('no AI-entitlement check on the index path (AC 11, decision A)', () => {
  it('a workspace that never ran an AI job is asked about by organisation alone, and boots on a non-zero balance', async () => {
    const entitlement = vi.spyOn(ciAllowanceService, 'getEntitlementState');
    const { result } = await runIndex('alw-noai');

    expect(result).toMatchObject({ indexed: true });
    expect(indexAllowanceWorld.checks).toHaveLength(1);
    expect(Object.keys(indexAllowanceWorld.checks[0]!)).toEqual(['coreOrganizationId']);
    expect(entitlement).not.toHaveBeenCalled();
  }, 30_000);

  it('and the same org at a ZERO balance is stopped by gate A, not by an entitlement', async () => {
    const entitlement = vi.spyOn(ciAllowanceService, 'getEntitlementState');
    const { result } = await runIndex('alw-noai0', { checkOutcome: 'hard_stop_no_credit' });

    expect(result).toEqual({ indexed: false, reason: 'paused_index_no_credit' });
    expect(entitlement).not.toHaveBeenCalled();
  }, 30_000);
});

describe('the pause bookkeeping NEVER fails a run (MOTIR-4544 top-up)', () => {
  it('an unreadable boot memo is not evidence of a boot — the run still asks', async () => {
    vi.spyOn(jobStepRepository, 'findByRunAndStep').mockRejectedValueOnce(
      new Error('memo table down'),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ask = vi.spyOn(codeGraphIndexDispatchService, 'askIndexAllowance');
    const target = {
      indexed: true as const,
      repoRef: INDEX_REPO_REF,
      providerId: 'github' as const,
      organizationId: 'org-memo-down',
      anchorProjectId: 'proj-memo-down',
    };
    stubIndexFleet();
    indexAllowanceWorld.checkOutcome = 'hard_stop_no_credit';

    expect(
      await askIndexAllowanceUnlessBooted({ runId: 'run-memo-down' }, jobServices, target),
    ).toMatchObject({
      proceed: false,
      reason: 'paused_index_no_credit',
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('could not read the boot memo');
  });

  it('a pause that cannot be RECORDED still ends the run as the paused no-op', async () => {
    vi.spyOn(githubRepoRepository, 'markIndexPaused').mockRejectedValue(new Error('write refused'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = await runIndex('alw-pw-fail', { checkOutcome: 'hard_stop_no_credit' });

    expect(result).toEqual({ indexed: false, reason: 'paused_index_no_credit' });
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(
      error.mock.calls.some((call) => String(call[0]).includes('could not record the index pause')),
    ).toBe(true);
  }, 30_000);

  it('a pause that cannot be LIFTED does not stop the index', async () => {
    vi.spyOn(githubRepoRepository, 'clearIndexPause').mockRejectedValue(new Error('write refused'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = await runIndex('alw-lift-fail');

    expect(result).toMatchObject({ indexed: true });
    expect(
      error.mock.calls.some((call) => String(call[0]).includes('could not lift the index pause')),
    ).toBe(true);
  }, 30_000);

  it('the repository writes refuse a malformed repoRef rather than matching every row', async () => {
    await seedIndexWorkspace('alw-malformed', 1);
    const counts = await withSystemContext(async (tx) => [
      await githubRepoRepository.markIndexPaused(
        'no-slash',
        'org-any',
        { reason: 'paused_index_no_credit' },
        tx,
      ),
      await githubRepoRepository.clearIndexPause('no-slash', tx),
    ]);
    expect(counts).toEqual([0, 0]);
    expect((await repoRow()).indexPausedReason).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AN ORGANISATION WITH NO PAID AI PLAN (MOTIR-8235).
//
// Index admission asks the paid-plan gate first (MOTIR-6909). Its refusal used
// to be WAITED on like a full lane — sixty attempts over most of an hour — and
// then thrown as `IndexDispatchFailedError`, which the monitor filed as a
// production error once per repository. The plan does not change while a run
// waits, so the refusal is now a recorded pause: asked once, nothing booted, the
// run a SUCCEEDED no-op, the reason on the repository row.
// ─────────────────────────────────────────────────────────────────────────────

describe('no paid AI plan: a recorded pause, never a 60-attempt failure (MOTIR-8235)', () => {
  it('asks admission ONCE, boots nothing, and succeeds as a no-op carrying the reason', async () => {
    const plan = vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false);
    const admit = vi.spyOn(codeGraphIndexAdmissionService, 'admit');

    const { result, error } = await runIndex('alw-noplan');

    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: AI_PLAN_INDEX_PAUSE_REASON });
    expect(plan).toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(fakeOrchestrator.provisioned).toEqual([]);

    const runs = await indexJobRuns();
    expect(runs.map((r) => r.status)).toEqual(['succeeded']);
    // No `output.repoRef`: §6's "this repo is indexed" claim is never made.
    expect(runs[0]!.output).toEqual({ indexed: false, reason: 'paused_index_ai_plan_required' });

    const row = await repoRow();
    expect(row.indexPausedReason).toBe('paused_index_ai_plan_required');
    expect(row.indexPausedAt).toBeInstanceOf(Date);
    // The indexing claim taken before admission is released with the pause.
    expect(row.indexingRunId).toBeNull();
    expect(row.indexedHeadSha).toBeNull();
  }, 30_000);

  it('a paid organisation indexes as before, and lifts that pause', async () => {
    vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false);
    const { installationId, workspaceId } = await runIndex('alw-plan-lift');
    expect((await repoRow()).indexPausedReason).toBe('paused_index_ai_plan_required');

    vi.mocked(aiPlanGateService.hasPaidAiPlan).mockResolvedValue(true);
    const engine = new JobTestEngine({ function: codeGraphIndex });
    const again = await engine.execute({
      events: [indexEventFor({ installationId, workspaceId, eventId: 'evt-alw-plan-lift-2' })],
    });

    expect(again.result).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF });
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect((await repoRow()).indexPausedReason).toBeNull();
  }, 60_000);
});
