import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import type { RawCodeAuditSurface } from '@/lib/ai/motirAiClient';
import { adminDb } from '../helpers/adminDb';

// THE FIRST-AUDIT TRIGGER (MOTIR-2266) — `docs/decisions/audit-on-first-index.md`
// option B: a repo whose code-graph index SUCCEEDS and that has no derived audit
// gets its `code_audit` + `propose_convention` pair, once, for that repo only.
//
// Driven through the REAL `system.code-graph-index` job, over the SHARED index
// HANDOFF world (`tests/helpers/indexHandoff.ts` — motir-ai and GitHub stubbed at
// the HTTP boundary since MOTIR-11883 moved the job off the container fleet),
// against a REAL Postgres — the world `tests/jobs/code-graph-index-handoff.test.ts`
// drives. That matters: the
// property under test is not "the service submits" but "the JOB submits, without
// changing what the job is". A service-only suite could not see the two things
// most likely to break in production — a derivation blip failing an index that
// already succeeded, and a failed index deriving anything at all.
//
// ⚠️ ONLY THE TWO CODE-HEALTH CALLS ARE MOCKED, over `importOriginal`. The index
// path needs the REAL `handOffCodeGraphIndex` and `readCodeGraphIndexStatus` (the
// world answers them over the stubbed `fetch`), so mocking the module WHOLE would replace the world the
// job runs in. The two that are replaced are the gate's read and the submit —
// the only motir-ai calls this card adds.
const getCodeAuditMock = vi.fn<(q: unknown) => Promise<RawCodeAuditSurface>>();
const refreshCodeAuditMock =
  vi.fn<
    (t: unknown, c: unknown, a: unknown) => Promise<{ auditJobId: string; conventionJobId: string }>
  >();

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/motirAiClient')>();
  return {
    ...actual,
    getCodeAudit: (q: unknown) => getCodeAuditMock(q),
    refreshCodeAudit: (t: unknown, c: unknown, a: unknown) => refreshCodeAuditMock(t, c, a),
  };
});

const { db } = await import('@/lib/db');
const { codeGraphIndex } = await import('@/lib/jobs/definitions/codeGraphIndex');
const { firstAuditTriggerService } = await import('@/lib/services/firstAuditTriggerService');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
const { truncateAuthTables, truncateJobRuns } = await import('../helpers/db');
const { INDEX_REPO_REF, indexEventFor, indexJobRuns, indexStepIds, seedIndexWorkspace } =
  await import('../helpers/indexFleet');
const { failedAt, HANDOFF_HEAD, handoffWorld, stubIndexHandoff } =
  await import('../helpers/indexHandoff');

const REPO_REF = INDEX_REPO_REF;
const OTHER_REPO = { owner: 'moooon', name: 'motir-ai' };
const OTHER_REPO_REF = `${OTHER_REPO.owner}/${OTHER_REPO.name}`;

/** motir-ai's `GET /v1/code-audit` body for a repo that HAS a derived audit. */
function auditedSurface(): RawCodeAuditSurface {
  return {
    audit: {
      id: 'audit_1',
      healthSummary: { grade: 'B' },
      codeGraphRef: 'cg_1',
      repoKey: REPO_REF,
      createdAt: '2026-08-05T00:00:00.000Z',
    },
    findings: [],
    total: 0,
    nextOffset: null,
  } as unknown as RawCodeAuditSurface;
}

/** The same body for a repo with NOTHING derived — a SUCCESSFUL read, not an error. */
function unauditedSurface(): RawCodeAuditSurface {
  return {
    audit: null,
    findings: [],
    total: 0,
    nextOffset: null,
  } as unknown as RawCodeAuditSurface;
}

/** The `repoRef` each submit carried, in call order — the scope under test. */
function submittedRepoRefs(): (string | null | undefined)[] {
  return refreshCodeAuditMock.mock.calls.map((call) => {
    const context = call[1] as { code?: { repoRef?: string | null } };
    return context.code?.repoRef;
  });
}

function runIndex(args: { installationId: string; workspaceId: string; projectIds: string[] }) {
  return new JobTestEngine({ function: codeGraphIndex }).execute({
    events: [
      indexEventFor({
        installationId: args.installationId,
        workspaceId: args.workspaceId,
        eventId: `evt-${args.installationId}`,
      }),
    ],
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  getCodeAuditMock.mockReset();
  refreshCodeAuditMock.mockReset();
  refreshCodeAuditMock.mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // ⚠️ AND AFTER, NOT ONLY BEFORE. `fleet_in_flight_slot` is FLEET-WIDE — nullable
  // `workspace_id`, no foreign key, by design, so a slot outlives whatever it
  // pointed at — which means no `TRUNCATE "workspace" CASCADE` reaches it and the
  // NEXT FILE IN THIS WORKER does not clean up after this one. A slot this file
  // leaves behind is counted by `fleetCeilingService.census`, which unions EVERY
  // workload, so it defers an unrelated file's CI-runner admission with no visible
  // cause. Clearing it before our own tests protects us; clearing it after protects
  // everyone else.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TRIGGER — one pair, for the repo that just indexed.
// ─────────────────────────────────────────────────────────────────────────────

describe('system.code-graph-index — the FIRST-audit trigger', () => {
  it('reaches the trigger through the injected service bag, not an ad-hoc import', async () => {
    // The 4-layer seam: `defineJob` hands the handler `jobServices`, so the step
    // resolves the singleton off the bag rather than importing it itself.
    const { jobServices } = await import('@/lib/jobs/services');
    expect(jobServices.firstAuditTrigger).toBe(firstAuditTriggerService);
  });

  it('submits exactly ONE code_audit + propose_convention pair for a repo with no audit', async () => {
    const { workspaceId, projectIds, installationId } = await seedIndexWorkspace('fa-first', 1);
    stubIndexHandoff();
    getCodeAuditMock.mockResolvedValue(unauditedSurface());

    const { result, ctx } = await runIndex({ installationId, workspaceId, projectIds });

    expect(result).toEqual({
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      indexedBy: 'motir-codegraph',
    });
    // ONE pair. `refreshCodeAudit` is the call that submits BOTH jobs — motir-ai
    // returns an `auditJobId` and a `conventionJobId` from the one request — so
    // "exactly one pair" is exactly one call.
    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
    expect(submittedRepoRefs()).toEqual([REPO_REF]);
    // Its own checkpoint, so a replay reads the memo instead of re-submitting.
    expect(indexStepIds(ctx)).toContain('derive-first-audit');
  }, 30_000);

  it('submits NOTHING for a repo that ALREADY has a derived audit — the idempotency gate', async () => {
    const { workspaceId, projectIds, installationId } = await seedIndexWorkspace('fa-idem', 1);
    stubIndexHandoff();
    // ⚠️ THE GATE IS "HAS NO AUDIT YET", NOT "IS THIS INDEX ROW NEW". A re-index,
    // a reconcile or a retry of an already-assessed repo must fire nothing — which
    // is what makes the trigger safe to hang off EVERY index completion. Reading
    // it the other way is the MOTIR-1961 defect on the indexing half.
    getCodeAuditMock.mockResolvedValue(auditedSurface());

    const { result } = await runIndex({ installationId, workspaceId, projectIds });

    expect(result).toMatchObject({ indexed: true, repoRef: REPO_REF });
    expect(getCodeAuditMock).toHaveBeenCalledTimes(1);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  }, 30_000);

  it('derives ONLY the repo that indexed — never a sibling connected repo', async () => {
    // The un-scoped `reaudit` fans out over the whole connected SET, so learning
    // about a second repo would cost both repos' derivations — the precise defect
    // MOTIR-2244 exists to remove and MOTIR-2247's `repoKeys` closed.
    const { workspaceId, projectIds, installationId } = await seedIndexWorkspace('fa-scope', 1, [
      { owner: 'moooon', name: 'motir-core' },
      OTHER_REPO,
    ]);
    stubIndexHandoff();
    getCodeAuditMock.mockResolvedValue(unauditedSurface());

    await runIndex({ installationId, workspaceId, projectIds });

    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(1);
    expect(submittedRepoRefs()).toEqual([REPO_REF]);
    expect(submittedRepoRefs()).not.toContain(OTHER_REPO_REF);
    // And the GATE was asked about the indexed repo only — an un-scoped read
    // would have cost a request per connected repo before spending anything.
    expect(
      getCodeAuditMock.mock.calls.map((call) => (call[0] as { repoKey: string }).repoKey),
    ).toEqual([REPO_REF]);
  }, 30_000);

  it('asks the gate — and derives — ONCE PER PROJECT the graph landed in', async () => {
    // An audit is keyed on (project, repo) and the index fans out over every
    // project of the workspace, so deriving only the first project's would leave
    // the others in exactly the un-assessed state this card ends.
    const { workspaceId, projectIds, installationId } = await seedIndexWorkspace('fa-fanout', 2);
    stubIndexHandoff();
    getCodeAuditMock.mockResolvedValue(unauditedSurface());

    await runIndex({ installationId, workspaceId, projectIds });

    expect(refreshCodeAuditMock).toHaveBeenCalledTimes(2);
    expect(submittedRepoRefs()).toEqual([REPO_REF, REPO_REF]);
    const derivedProjects = refreshCodeAuditMock.mock.calls.map(
      (call) => (call[0] as { projectId: string }).projectId,
    );
    expect(new Set(derivedProjects)).toEqual(new Set(projectIds));
  }, 30_000);

  it('submits NOTHING when the index job FAILS', async () => {
    const { workspaceId, projectIds, installationId } = await seedIndexWorkspace('fa-failed', 1);
    stubIndexHandoff();
    // The service reports the handed commit FAILED — `runIndexHandoffSteps`
    // throws, so the trigger is never reached.
    handoffWorld.statuses = [
      failedAt(HANDOFF_HEAD, 'fetch_failed', 'The source could not be fetched.'),
    ];
    getCodeAuditMock.mockResolvedValue(unauditedSurface());

    const { error, ctx } = (await runIndex({ installationId, workspaceId, projectIds })) as {
      error?: unknown;
      ctx: Parameters<typeof indexStepIds>[0];
    };

    expect(error).toBeDefined();
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
    expect(getCodeAuditMock).not.toHaveBeenCalled();
    expect(indexStepIds(ctx)).not.toContain('derive-first-audit');
    expect((await indexJobRuns()).filter((run) => run.status === 'succeeded')).toEqual([]);
  }, 30_000);

  it('leaves a SUCCEEDED index untouched when the derivation throws — logged, never retried', async () => {
    const { workspaceId, projectIds, installationId } = await seedIndexWorkspace('fa-blip', 1);
    stubIndexHandoff();
    getCodeAuditMock.mockResolvedValue(unauditedSurface());
    // motir-ai is down at exactly the wrong moment. The index has already
    // succeeded; failing the run here would cost the ledger its `succeeded` row —
    // the row `listSucceededCodeGraphIndexRepoRefs` and the onboarding wizard read
    // to know the repo HAS a graph — and buy four Inngest retries of a finished
    // index. The repo is simply left un-audited, which is the state MOTIR-2244's
    // nudge already exists to report.
    refreshCodeAuditMock.mockRejectedValue(new MotirAiUnavailableError('motir-ai is down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, error } = await runIndex({ installationId, workspaceId, projectIds });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      indexedBy: 'motir-codegraph',
    });
    const runs = await indexJobRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.output).toMatchObject({ repoRef: REPO_REF });
    // Asserted, not assumed: a silent swallow is how this becomes unaccountable.
    expect(
      logged.mock.calls.some((call) => String(call[0]).includes('[first-audit-trigger]')),
    ).toBe(true);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SERVICE'S OWN VERDICTS — the arms a job-level run cannot reach.
// ─────────────────────────────────────────────────────────────────────────────

describe('firstAuditTriggerService — the verdicts that derive nothing', () => {
  it('skips a workspace with no OWNER — there is no actor to mint a read-back token for', async () => {
    const { workspaceId } = await seedIndexWorkspace('fa-noowner', 1);
    await adminDb.workspaceMembership.deleteMany({
      where: { workspaceId, workspaceRole: 'manager' },
    });

    const report = await firstAuditTriggerService.deriveFirstAudit({
      workspaceId,
      repoRef: REPO_REF,
    });

    expect(report).toEqual({ repoRef: REPO_REF, submitted: 0, outcomes: [], skipped: 'no_owner' });
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('skips a workspace with no PROJECT — an audit has nowhere to live', async () => {
    const { workspaceId } = await seedIndexWorkspace('fa-noproj', 0);

    const report = await firstAuditTriggerService.deriveFirstAudit({
      workspaceId,
      repoRef: REPO_REF,
    });

    expect(report).toEqual({
      repoRef: REPO_REF,
      submitted: 0,
      outcomes: [],
      skipped: 'no_projects',
    });
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('skips a repo whose coverage read is UNAVAILABLE — unknown is not missing', async () => {
    const { workspaceId, projectIds } = await seedIndexWorkspace('fa-unavail', 1);
    // The same distinction MOTIR-2248 made for the nudge, which declines to count
    // an unreadable repo. Spending a derivation on a guess is the more expensive
    // way to be wrong, and the next index still reaches the repo.
    getCodeAuditMock.mockRejectedValue(new MotirAiUnavailableError('read timed out'));

    const report = await firstAuditTriggerService.deriveFirstAudit({
      workspaceId,
      repoRef: REPO_REF,
    });

    expect(report.submitted).toBe(0);
    expect(report.outcomes).toEqual([
      { projectId: projectIds[0], status: 'skipped', reason: 'coverage_unavailable' },
    ]);
    expect(refreshCodeAuditMock).not.toHaveBeenCalled();
  });

  it('contains ONE project failure — the workspace’s other projects still derive', async () => {
    const { workspaceId, projectIds } = await seedIndexWorkspace('fa-contain', 2);
    getCodeAuditMock.mockResolvedValue(unauditedSurface());
    refreshCodeAuditMock
      .mockRejectedValueOnce(new MotirAiUnavailableError('one project’s submit blew up'))
      .mockResolvedValue({ auditJobId: 'job_a', conventionJobId: 'job_c' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = await firstAuditTriggerService.deriveFirstAudit({
      workspaceId,
      repoRef: REPO_REF,
    });

    expect(report.submitted).toBe(1);
    expect(report.outcomes).toHaveLength(2);
    expect(report.outcomes.filter((o) => o.reason === 'submit_failed')).toHaveLength(1);
    expect(report.outcomes.filter((o) => o.status === 'submitted')).toHaveLength(1);
    expect(new Set(report.outcomes.map((o) => o.projectId))).toEqual(new Set(projectIds));
  });

  it('reports lookup_failed — and never throws — when the owner read blows up', async () => {
    const { workspaceId } = await seedIndexWorkspace('fa-lookup', 1);
    const membershipRepository = await import('@/lib/repositories/workspaceMembershipRepository');
    vi.spyOn(
      membershipRepository.workspaceMembershipRepository,
      'findStandInManagerByWorkspace',
    ).mockRejectedValue(new Error('the connection pool is gone'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = await firstAuditTriggerService.deriveFirstAudit({
      workspaceId,
      repoRef: REPO_REF,
    });

    expect(report).toEqual({
      repoRef: REPO_REF,
      submitted: 0,
      outcomes: [],
      skipped: 'lookup_failed',
    });
    expect(
      logged.mock.calls.some((call) => String(call[0]).includes('[first-audit-trigger]')),
    ).toBe(true);
  });
});
