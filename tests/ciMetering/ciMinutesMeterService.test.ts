import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubBothAppCredentials } from '../helpers/appCredentials';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { resetOwnedOrgCache } from '@/lib/ciMetering/ownedOrgs';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { ciWorkflowRunUsageRepository } from '@/lib/repositories/ciWorkflowRunUsageRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import type { NormalizedWorkflowRunEvent } from '@/lib/git/types';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// The CI-minutes METER against real Postgres (Story MOTIR-1775 · MOTIR-1896) —
// `docs/decisions/ci-minutes-allowance.md`. The GitHub HTTP boundary is stubbed
// (global `fetch`, the shipped convention for these tests); everything else —
// the RLS contexts, the attribution chain, the unique index, the rollup — runs
// for real, because the acceptance criteria are all about what the DATABASE does.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '55501';
const PROVIDER_REPO_ID = '99001';

/** Four parallel Linux jobs — the seeded starter's own CI shape (ADR §Context):
 *  3 + 3 + 5 + 8 = 19 billable minutes, all at x1.00. */
const STARTER_JOBS = [
  { id: 1, name: 'lint', minutes: 3 },
  { id: 2, name: 'typecheck', minutes: 3 },
  { id: 3, name: 'build', minutes: 5 },
  { id: 4, name: 'e2e', minutes: 8 },
];
const STARTER_BILLABLE_MINUTES = 19;

const RUN_COMPLETED_AT = new Date('2026-07-30T12:00:00.000Z');
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');

function jobsPayload(jobs = STARTER_JOBS, labels = ['ubuntu-latest']) {
  const started = new Date('2026-07-30T11:00:00.000Z');
  return {
    total_count: jobs.length,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      started_at: started.toISOString(),
      completed_at: new Date(started.getTime() + job.minutes * 60_000).toISOString(),
      labels,
      run_attempt: 1,
    })),
  };
}

/** Stub the GitHub App token mint + the workflow-jobs read. Returns the mock so
 *  a test can assert the API was (or was NOT) called. */
function stubGithub(jobsBody: unknown = jobsPayload()): ReturnType<typeof vi.fn> {
  // ⚠️ BOTH registrations, because this suite's repository is MOTIR-OWNED
  // (`GITHUB_FALLBACK_ORG` is stubbed to the provisioning org above), and since
  // MOTIR-5861 the low-level mints resolve their App from the repository's
  // PROVENANCE — so a hosted repository here mints through `motir-studio`.
  // Wiring only the user-facing App made every one of these reads throw
  // `GithubAppNotConfiguredError: GitHub App (provisioning)`.
  stubBothAppCredentials();
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const u = String(url);
    if (u.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({
          token: 'ghs_x',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/actions/runs/')) {
      return new Response(JSON.stringify(jobsBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  githubRepoId: string;
  projectRepoId: string;
}

/**
 * A tenant with a GitHub installation, a connected repo in MOTIR'S org, and a
 * repo-set row realizing it — i.e. the shape every Motir-created project repo
 * has. `repoOwner` is parameterised so a test can seed the connect-existing case.
 */
async function seedTenant(options?: {
  email?: string;
  repoOwner?: string;
  repoName?: string;
  installationId?: string;
  providerRepoId?: string;
  isMeta?: boolean;
  withProjectRepo?: boolean;
}): Promise<Fixture> {
  const email = options?.email ?? 'ci-meter@example.com';
  const repoOwner = options?.repoOwner ?? MOTIR_ORG;
  const repoName = options?.repoName ?? 'acme-web';
  const installationId = options?.installationId ?? INSTALLATION_ID;
  const providerRepoId = options?.providerRepoId ?? PROVIDER_REPO_ID;

  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${randomInt(100, 1000)}`,
  });

  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: repoOwner, accountType: 'Organization' },
    repos: [
      { providerRepoId, owner: repoOwner, name: repoName, defaultBranch: 'main', archived: false },
    ],
  });
  const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: providerRepoId },
  });

  let projectRepoId = '';
  if (options?.withProjectRepo !== false) {
    const projectRepo = await adminDb.projectRepo.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        role: 'web',
        name: repoName,
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        position: 'a0',
        githubRepoId: githubRepo.id,
      },
    });
    projectRepoId = projectRepo.id;
  }

  if (options?.isMeta) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }

  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    githubRepoId: githubRepo.id,
    projectRepoId,
  };
}

function runEvent(overrides: Partial<NormalizedWorkflowRunEvent> = {}): NormalizedWorkflowRunEvent {
  return {
    providerRepoId: PROVIDER_REPO_ID,
    runId: '7001',
    attempt: 1,
    repoOwner: MOTIR_ORG,
    repoName: 'acme-web',
    workflowName: 'CI',
    completedAt: RUN_COMPLETED_AT,
    ...overrides,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('meterWorkflowRun — the happy path (§3, §4.5, §5.2)', () => {
  it('meters a Motir-owned run, attributes it, and rolls it into the month', async () => {
    const fx = await seedTenant();
    stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(result).toMatchObject({
      outcome: 'metered',
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      billableMinutes: STARTER_BILLABLE_MINUTES,
      linearEquivalentMinutes: STARTER_BILLABLE_MINUTES, // all-Linux → x1.00
    });
    expect((result as { periodStart: Date }).periodStart.toISOString()).toBe(
      JULY_2026.toISOString(),
    );

    const row = await adminDb.ciWorkflowRunUsage.findFirstOrThrow({ where: { runId: '7001' } });
    expect(row).toMatchObject({
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      githubRepoId: fx.githubRepoId,
      runAttempt: 1,
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      jobCount: 4,
      billableMinutes: STARTER_BILLABLE_MINUTES,
    });
    // §3.3 — the raw wall clock and the applied multiplier are retained, so a
    // repricing is a recomputation rather than a backfill.
    expect(Number(row.rawWallClockSeconds)).toBe(STARTER_BILLABLE_MINUTES * 60);
    expect(row.runnerBreakdown).toEqual([
      expect.objectContaining({ family: 'linux_x64', multiplier: 1, unpriced: false }),
    ]);

    const rollup = await adminDb.ciPeriodUsage.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(rollup.periodStart.toISOString()).toBe(JULY_2026.toISOString());
    expect(rollup.billableMinutes).toBe(STARTER_BILLABLE_MINUTES);
    expect(rollup.runCount).toBe(1);
  });

  it('normalizes a macOS run at the price ratio, not raw wall clock', async () => {
    await seedTenant();
    stubGithub(jobsPayload([{ id: 1, name: 'mac', minutes: 10 }], ['macos-14']));

    const result = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(result).toMatchObject({
      outcome: 'metered',
      billableMinutes: 10,
      linearEquivalentMinutes: 103.3, // 10 x 10.33
    });
  });

  it('ACCUMULATES successive runs into one period row', async () => {
    const fx = await seedTenant();
    stubGithub();

    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '1' }), INSTALLATION_ID);
    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '2' }), INSTALLATION_ID);
    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '3' }), INSTALLATION_ID);

    const rollup = await adminDb.ciPeriodUsage.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(rollup.runCount).toBe(3);
    expect(rollup.billableMinutes).toBe(STARTER_BILLABLE_MINUTES * 3);
    // Exactly one rollup row — the whole point of the table.
    const ciPeriodUsageCount = await adminDb.ciPeriodUsage.count({
      where: { workspaceId: fx.workspaceId },
    });
    expect(ciPeriodUsageCount).toBe(1);
  });

  it('files runs from DIFFERENT months in different period rows', async () => {
    const fx = await seedTenant();
    stubGithub();

    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '1' }), INSTALLATION_ID);
    await ciMinutesMeterService.meterWorkflowRun(
      runEvent({ runId: '2', completedAt: new Date('2026-08-02T09:00:00.000Z') }),
      INSTALLATION_ID,
    );

    const rows = await adminDb.ciPeriodUsage.findMany({
      where: { workspaceId: fx.workspaceId },
      orderBy: { periodStart: 'asc' },
    });
    expect(rows.map((r) => r.periodStart.toISOString())).toEqual([
      '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
  });
});

describe('meterWorkflowRun — idempotency (§5.8, the duplicate-report criterion)', () => {
  it('counts a REPLAYED run exactly once and leaves the rollup untouched', async () => {
    const fx = await seedTenant();
    stubGithub();
    const event = runEvent();

    const first = await ciMinutesMeterService.meterWorkflowRun(event, INSTALLATION_ID);
    const second = await ciMinutesMeterService.meterWorkflowRun(event, INSTALLATION_ID);

    expect(first.outcome).toBe('metered');
    expect(second).toEqual({ outcome: 'duplicate', runId: '7001', runAttempt: 1 });
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count({
      where: { runId: '7001' },
    });
    expect(ciWorkflowRunUsageCount).toBe(1);

    const rollup = await adminDb.ciPeriodUsage.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(rollup.runCount).toBe(1);
    expect(rollup.billableMinutes).toBe(STARTER_BILLABLE_MINUTES);
  });

  it('counts a run once even when two deliveries race (the unique index, not the pre-check)', async () => {
    // The cheap pre-read cannot save us here — both callers miss it. The
    // `(run_id, run_attempt)` unique index is the real guarantee, and because
    // the rollup increment shares the losing transaction it rolls back too.
    const fx = await seedTenant();
    stubGithub();
    const event = runEvent();

    const results = await Promise.all([
      ciMinutesMeterService.meterWorkflowRun(event, INSTALLATION_ID),
      ciMinutesMeterService.meterWorkflowRun(event, INSTALLATION_ID),
    ]);

    // Either ordering is legitimate; what must hold is exactly one of each.
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'metered']);
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count({
      where: { runId: '7001' },
    });
    expect(ciWorkflowRunUsageCount).toBe(1);
    const rollup = await adminDb.ciPeriodUsage.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(rollup.runCount).toBe(1);
    expect(rollup.billableMinutes).toBe(STARTER_BILLABLE_MINUTES);
  });

  it('falls back to the UNIQUE INDEX when the pre-check misses (the real guard)', async () => {
    // Deterministic version of the race above: the row already exists, but the
    // cheap pre-read is forced to report "not metered yet" — exactly what both
    // callers see when two deliveries arrive together. The INSERT then loses on
    // `(run_id, run_attempt)`, and because the rollup increment shares that
    // transaction it rolls back too, so the total cannot be inflated.
    const fx = await seedTenant();
    stubGithub();
    await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);
    vi.spyOn(ciWorkflowRunUsageRepository, 'findByRunAndAttempt').mockResolvedValueOnce(null);

    const second = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(second).toEqual({ outcome: 'duplicate', runId: '7001', runAttempt: 1 });
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count({
      where: { runId: '7001' },
    });
    expect(ciWorkflowRunUsageCount).toBe(1);
    const rollup = await adminDb.ciPeriodUsage.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(rollup.runCount).toBe(1);
    expect(rollup.billableMinutes).toBe(STARTER_BILLABLE_MINUTES);
  });

  it('meters a RE-RUN again — a new attempt is compute GitHub bills again', async () => {
    const fx = await seedTenant();
    stubGithub();

    await ciMinutesMeterService.meterWorkflowRun(runEvent({ attempt: 1 }), INSTALLATION_ID);
    const rerun = await ciMinutesMeterService.meterWorkflowRun(
      runEvent({ attempt: 2 }),
      INSTALLATION_ID,
    );

    expect(rerun.outcome).toBe('metered');
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count({
      where: { runId: '7001' },
    });
    expect(ciWorkflowRunUsageCount).toBe(2);
    const rollup = await adminDb.ciPeriodUsage.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(rollup.runCount).toBe(2);
  });

  it('skips the GitHub round-trip on an obvious redelivery', async () => {
    await seedTenant();
    const fetchMock = stubGithub();
    const event = runEvent();

    await ciMinutesMeterService.meterWorkflowRun(event, INSTALLATION_ID);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await ciMinutesMeterService.meterWorkflowRun(event, INSTALLATION_ID);

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('meterWorkflowRun — the §5.1 gate and its edges', () => {
  it('does NOT meter a repo in the user’s own account (connect-existing)', async () => {
    await seedTenant({ repoOwner: 'some-user', repoName: 'their-app' });
    const fetchMock = stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(
      runEvent({ repoOwner: 'some-user', repoName: 'their-app' }),
      INSTALLATION_ID,
    );

    expect(result).toEqual({ outcome: 'not_metered', reason: 'foreign_owner' });
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count();
    expect(ciWorkflowRunUsageCount).toBe(0);
    // The gate short-circuits BEFORE any API call — GitHub bills the user here.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('STOPS metering a repo the user has taken over (§5.5, MOTIR-711)', async () => {
    // The transfer edge, and the reason the owner is read from the RUN rather
    // than the mirror: the mirror row still says `motir-projects` here, exactly
    // as it would before a reconciling webhook lands. The run says otherwise,
    // and the run is what GitHub bills on.
    const fx = await seedTenant();
    stubGithub();

    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: 'before' }), INSTALLATION_ID);
    const afterTransfer = await ciMinutesMeterService.meterWorkflowRun(
      runEvent({ runId: 'after', repoOwner: 'the-user' }),
      INSTALLATION_ID,
    );

    expect(afterTransfer).toEqual({ outcome: 'not_metered', reason: 'foreign_owner' });
    // Minutes metered BEFORE the transfer stay attributed and stay charged.
    const rows = await adminDb.ciWorkflowRunUsage.findMany({
      where: { workspaceId: fx.workspaceId },
    });
    expect(rows.map((r) => r.runId)).toEqual(['before']);
  });

  it('is inert self-hosted (§8.5)', async () => {
    await seedTenant();
    stubGithub();
    vi.stubEnv('MOTIR_CLOUD', 'false');

    expect(await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID)).toEqual({
      outcome: 'disabled',
    });
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count();
    expect(ciWorkflowRunUsageCount).toBe(0);
  });

  it('is inert when no provisioning org is configured (MOTIR-1779 has not run)', async () => {
    await seedTenant();
    stubGithub();
    vi.stubEnv('GITHUB_FALLBACK_ORG', undefined);

    expect(await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID)).toEqual({
      outcome: 'disabled',
    });
  });

  it('RECORDS the meta org’s minutes — `isMeta` suppresses the charge, not the measurement (ADR §20)', async () => {
    // MOTIR-5283. This test used to assert ZERO rows for a meta org: the meter
    // returned before the write, so moooon B.V.'s Actions minutes — real spend,
    // paid on the GitHub bill — were recorded nowhere in Motir.
    const fx = await seedTenant({ isMeta: true });
    stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(result).toMatchObject({
      outcome: 'metered',
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      linearEquivalentMinutes: STARTER_BILLABLE_MINUTES,
      isMeta: true,
    });
    const rows = await adminDb.ciWorkflowRunUsage.findMany({
      where: { organizationId: fx.organizationId },
    });
    expect(rows.map((r) => r.runId)).toEqual(['7001']);
  });

  it('carries `isMeta: false` for an ordinary tenant', async () => {
    await seedTenant();
    stubGithub();

    expect(await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID)).toMatchObject(
      { outcome: 'metered', isMeta: false },
    );
  });

  it('puts the meta org’s minutes in the period rollup the margin readout reads (ADR §20)', async () => {
    // `getOrgPeriodCostBasis`'s denominator is this rollup. Before MOTIR-5283 it
    // was empty for the meta org however much CI it ran, so a fleet-cost row
    // for that org would have had nothing to divide by.
    const fx = await seedTenant({ isMeta: true });
    stubGithub();

    await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    const consumption = await ciMinutesMeterService.getOrgPeriodConsumption(
      fx.organizationId,
      RUN_COMPLETED_AT,
    );
    expect(consumption.linearEquivalentMinutes).toBe(STARTER_BILLABLE_MINUTES);
    const basis = await ciFleetCostMeterService.getOrgPeriodCostBasis(
      fx.organizationId,
      RUN_COMPLETED_AT,
    );
    expect(basis.linearEquivalentMinutes).toBe(STARTER_BILLABLE_MINUTES);
  });

  it('LOGS a Motir-owned repo with no attributable project rather than swallowing it (§5.4)', async () => {
    // Real spend, charged to nobody. Silence here would hide it, which is why
    // the ADR makes the log the required behaviour.
    await seedTenant({ withProjectRepo: false });
    stubGithub();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(result).toEqual({
      outcome: 'unattributed',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no attributable project'),
      expect.objectContaining({ repoName: 'acme-web', runId: '7001' }),
    );
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count();
    expect(ciWorkflowRunUsageCount).toBe(0);
  });

  it('reports an unknown installation and an unknown repo distinctly', async () => {
    await seedTenant();
    stubGithub();

    expect(await ciMinutesMeterService.meterWorkflowRun(runEvent(), '404404')).toEqual({
      outcome: 'unknown_installation',
    });
    expect(
      await ciMinutesMeterService.meterWorkflowRun(
        runEvent({ providerRepoId: '888888' }),
        INSTALLATION_ID,
      ),
    ).toEqual({ outcome: 'unknown_repo' });
  });

  it('records nothing for a run with no billable jobs', async () => {
    await seedTenant();
    stubGithub({ total_count: 0, jobs: [] });

    expect(await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID)).toEqual({
      outcome: 'no_billable_jobs',
      runId: '7001',
    });
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count();
    expect(ciWorkflowRunUsageCount).toBe(0);
  });

  it('LOGS an unpriced runner but still meters it at x1.00 (§3.4)', async () => {
    await seedTenant();
    stubGithub(jobsPayload([{ id: 1, name: 'big', minutes: 10 }], ['ubuntu-latest-8-core']));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(result).toMatchObject({ outcome: 'metered', linearEquivalentMinutes: 10 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unpriced runner'),
      expect.objectContaining({ families: ['unknown'] }),
    );
  });
});

describe('meterWorkflowRun — attribution is tenant-safe (§5.2)', () => {
  it('does not attribute a repo to a project row in ANOTHER workspace', async () => {
    // The project-repo row is read under the INSTALLATION's workspace GUC, so a
    // row belonging to a different tenant is invisible to RLS — cross-tenant
    // mis-attribution is structurally impossible, not merely unlikely.
    const a = await seedTenant({ email: 'tenant-a@example.com' });
    const b = await seedTenant({
      email: 'tenant-b@example.com',
      installationId: '55502',
      providerRepoId: '99002',
      repoName: 'other-web',
    });
    stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(result).toMatchObject({ workspaceId: a.workspaceId, organizationId: a.organizationId });
    expect(result).not.toMatchObject({ workspaceId: b.workspaceId });
  });

  it('⚠️ a repository used by TWO projects meters the ORG, with the project NULL', async () => {
    // Story MOTIR-4669 · MOTIR-4648 dropped `ProjectRepo.githubRepoId @unique`,
    // so this lookup can return N rows, and the meter refuses to guess between
    // them. GitHub has already charged, so the ORGANISATION is metered either
    // way — that half must not change. What is genuinely unknown is the PROJECT,
    // and `project_id` is nullable on the usage row for exactly this state.
    //
    // Taking `rows[0]` would have been a one-word change and a plausible-looking
    // line in the meter attributed to a project that may have run nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fx = await seedTenant();
    const second = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: (await adminDb.user.findFirstOrThrow()).id,
      name: 'Beacon',
      identifier: `B${randomInt(100, 1000)}`,
    });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: second.id,
        role: 'web',
        name: 'acme-web',
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        position: 'a0',
        githubRepoId: fx.githubRepoId,
      },
    });
    stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(result).toMatchObject({
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
    });
    const usage = await adminDb.ciWorkflowRunUsage.findFirstOrThrow();
    expect(usage.projectId).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('used by several projects'),
      expect.objectContaining({ projectCount: 2 }),
    );
  });
});

describe('getOrgPeriodConsumption — the ONE read MOTIR-1901 consumes', () => {
  it('returns the org’s consumption for the period containing an instant', async () => {
    const fx = await seedTenant();
    stubGithub();
    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '1' }), INSTALLATION_ID);
    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '2' }), INSTALLATION_ID);

    const consumption = await ciMinutesMeterService.getOrgPeriodConsumption(
      fx.organizationId,
      RUN_COMPLETED_AT,
    );

    expect(consumption).toEqual({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
      linearEquivalentMinutes: STARTER_BILLABLE_MINUTES * 2,
      billableMinutes: STARTER_BILLABLE_MINUTES * 2,
      runCount: 2,
      bySource: { ci: STARTER_BILLABLE_MINUTES * 2, preview: 0 },
    });
  });

  it('returns ZERO for an org with no consumption — never throws or returns null', async () => {
    const fx = await seedTenant();
    expect(
      await ciMinutesMeterService.getOrgPeriodConsumption(fx.organizationId, RUN_COMPLETED_AT),
    ).toMatchObject({ linearEquivalentMinutes: 0, billableMinutes: 0, runCount: 0 });
  });

  it('counts only the asked-for period', async () => {
    const fx = await seedTenant();
    stubGithub();
    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '1' }), INSTALLATION_ID);

    const august = await ciMinutesMeterService.getOrgPeriodConsumption(
      fx.organizationId,
      new Date('2026-08-15T00:00:00.000Z'),
    );
    expect(august.linearEquivalentMinutes).toBe(0);
  });

  it('SUMS across the org’s workspaces — the pool is org-level (§4.1)', async () => {
    const a = await seedTenant({ email: 'org-ws-a@example.com' });
    // A second workspace in the SAME org, with its own installation + repo.
    // Created directly rather than through `workspacesService`: with
    // `MOTIR_CLOUD=true` (which this suite needs, so the meter is enabled) the
    // free tier's one-workspace entitlement cap would reject it. The cap is a
    // real product rule and not what this test is about — the fixture is a
    // multi-workspace org, which a paid org legitimately has.
    const owner = await adminDb.user.findFirstOrThrow({ where: { email: 'org-ws-a@example.com' } });
    const secondWorkspace = await adminDb.workspace.create({
      data: { name: 'Second WS', slug: 'second-ws-ci-meter', organizationId: a.organizationId },
    });
    await adminDb.workspaceMembership.create({
      data: {
        workspaceId: secondWorkspace.id,
        userId: owner.id,
        workspaceRole: 'manager',
      },
    });
    const second = { workspace: secondWorkspace };
    const project = await projectsService.createProject({
      workspaceId: second.workspace.id,
      actorUserId: owner.id,
      name: 'Second',
      identifier: 'SEC',
    });
    await githubInstallationService.persistInstallation({
      workspaceId: second.workspace.id,
      installation: {
        installationId: '55503',
        accountLogin: MOTIR_ORG,
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '99003',
          owner: MOTIR_ORG,
          name: 'second-web',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    const repo2 = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: '99003' } });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: second.workspace.id,
        projectId: project.id,
        role: 'web',
        name: 'second-web',
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        position: 'a0',
        githubRepoId: repo2.id,
      },
    });
    stubGithub();

    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '1' }), INSTALLATION_ID);
    await ciMinutesMeterService.meterWorkflowRun(
      runEvent({ runId: '2', providerRepoId: '99003', repoName: 'second-web' }),
      '55503',
    );

    const consumption = await ciMinutesMeterService.getOrgPeriodConsumption(
      a.organizationId,
      RUN_COMPLETED_AT,
    );
    expect(consumption.runCount).toBe(2);
    expect(consumption.billableMinutes).toBe(STARTER_BILLABLE_MINUTES * 2);
  });
});

describe('getOrgPeriodTotalsByRepo — the reconciliation’s meter-side read', () => {
  it('groups an org’s period by repository', async () => {
    const fx = await seedTenant();
    stubGithub();
    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '1' }), INSTALLATION_ID);
    await ciMinutesMeterService.meterWorkflowRun(runEvent({ runId: '2' }), INSTALLATION_ID);

    expect(
      await ciMinutesMeterService.getOrgPeriodTotalsByRepo(fx.organizationId, RUN_COMPLETED_AT),
    ).toEqual([
      {
        repoOwner: MOTIR_ORG,
        repoName: 'acme-web',
        billableMinutes: STARTER_BILLABLE_MINUTES * 2,
        linearEquivalentMinutes: STARTER_BILLABLE_MINUTES * 2,
        runCount: 2,
      },
    ]);
  });

  it('is empty for a period with no runs', async () => {
    const fx = await seedTenant();
    expect(
      await ciMinutesMeterService.getOrgPeriodTotalsByRepo(
        fx.organizationId,
        new Date('2026-09-10T00:00:00.000Z'),
      ),
    ).toEqual([]);
  });
});

describe('the rollup row is readable per workspace', () => {
  it('exposes the workspace’s own period row, and nothing before its first run', async () => {
    const fx = await seedTenant();
    stubGithub();
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        ciPeriodUsageRepository.findByWorkspaceAndPeriod(fx.workspaceId, JULY_2026, tx),
      ),
    ).toBeNull();

    await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    const row = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      ciPeriodUsageRepository.findByWorkspaceAndPeriod(fx.workspaceId, JULY_2026, tx),
    );
    expect(row).toMatchObject({
      workspaceId: fx.workspaceId,
      billableMinutes: STARTER_BILLABLE_MINUTES,
      runCount: 1,
    });
  });
});

describe('meterWorkflowRun — failures that are NOT idempotency', () => {
  it('rethrows a non-unique-constraint DB error instead of calling it a duplicate', async () => {
    // The catch around the write exists ONLY to translate the idempotency race.
    // Swallowing anything else would turn a real outage into a silent
    // "already counted", and the minutes would never be billed.
    await seedTenant();
    stubGithub();
    const boom = new Error('connection terminated unexpectedly');
    vi.spyOn(ciWorkflowRunUsageRepository, 'create').mockRejectedValueOnce(boom);

    await expect(
      ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID),
    ).rejects.toThrow('connection terminated unexpectedly');
    const ciPeriodUsageCount = await adminDb.ciPeriodUsage.count();
    expect(ciPeriodUsageCount).toBe(0);
  });
});

describe('ciPeriodUsageRepository.sumForOrgPeriod — outside a transaction', () => {
  it('reads through the db singleton when no tx is supplied', async () => {
    const fx = await seedTenant();
    stubGithub();
    await ciMinutesMeterService.meterWorkflowRun(runEvent(), INSTALLATION_ID);

    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        ciPeriodUsageRepository.sumForOrgPeriod(fx.organizationId, JULY_2026, tx),
      ),
    ).toEqual({
      organizationId: fx.organizationId,
      periodStart: JULY_2026,
      linearEquivalentMinutes: STARTER_BILLABLE_MINUTES,
      billableMinutes: STARTER_BILLABLE_MINUTES,
      runCount: 1,
    });
  });

  it('returns zeros — never null — for an org that has never run CI', async () => {
    const fx = await seedTenant();
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        ciPeriodUsageRepository.sumForOrgPeriod(fx.organizationId, JULY_2026, tx),
      ),
    ).toMatchObject({ linearEquivalentMinutes: 0, billableMinutes: 0, runCount: 0 });
  });
});

describe('provisioningOrg', () => {
  it('reports the configured org the §5.1 gate matches on', () => {
    expect(ciMinutesMeterService.provisioningOrg()).toBe(MOTIR_ORG);
    vi.stubEnv('GITHUB_FALLBACK_ORG', undefined);
    expect(ciMinutesMeterService.provisioningOrg()).toBeNull();
  });
});

describe('the webhook seam — githubWebhookService.handleWorkflowRun', () => {
  function delivery(overrides: Record<string, unknown> = {}) {
    return {
      action: 'completed',
      installation: { id: Number(INSTALLATION_ID) },
      repository: {
        id: Number(PROVIDER_REPO_ID),
        name: 'acme-web',
        owner: { login: MOTIR_ORG },
      },
      workflow_run: {
        id: 7001,
        name: 'CI',
        run_attempt: 1,
        run_started_at: '2026-07-30T11:00:00Z',
        updated_at: RUN_COMPLETED_AT.toISOString(),
      },
      ...overrides,
    };
  }

  it('meters a completed `workflow_run` delivery end to end', async () => {
    await seedTenant();
    stubGithub();

    const result = await githubWebhookService.handleEvent('workflow_run', delivery());

    expect(result).toEqual({ event: 'workflow_run', outcome: 'metered' });
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count();
    expect(ciWorkflowRunUsageCount).toBe(1);
  });

  it('records a META org’s run and charges NOTHING for it, even past the pool (ADR §20)', async () => {
    // MOTIR-5283. Now that the meter records a meta run, the ONLY thing keeping
    // it uncharged is the `isMeta` this seam hands `chargeForMeteredRun` — whose
    // bypass is keyed on that argument, not on a read of its own. One 1,200-minute
    // job overruns the 1,000-minute floor, so an ordinary org WOULD be charged
    // here: the assertions below are about the bypass, not about a run too small
    // to bill.
    const fx = await seedTenant({ isMeta: true });
    stubGithub(jobsPayload([{ id: 1, name: 'soak', minutes: 1200 }]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await githubWebhookService.handleEvent('workflow_run', delivery());

    expect(result).toEqual({ event: 'workflow_run', outcome: 'metered' });
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count();
    expect(ciWorkflowRunUsageCount).toBe(1);
    // No charge row at all: the charger returns before `ensureRow`, and never
    // reaches the motir-ai debit (which `stubGithub` would refuse, logging here).
    const ciPeriodChargeCount = await adminDb.ciPeriodCharge.count();
    expect(ciPeriodChargeCount).toBe(0);
    expect(error).not.toHaveBeenCalled();
    // And the entitlement still reports the org as bypassed, not as in overage.
    const state = await ciAllowanceService.getEntitlementState(fx.organizationId, RUN_COMPLETED_AT);
    expect(state).toMatchObject({ state: 'bypassed', overageMinutes: 0, chargedCredits: 0 });
  });

  it('ignores a run that has not completed — nothing billable yet (§5.7)', async () => {
    await seedTenant();
    stubGithub();

    expect(
      await githubWebhookService.handleEvent('workflow_run', delivery({ action: 'in_progress' })),
    ).toEqual({ event: 'workflow_run', outcome: 'ignored_action' });
    const ciWorkflowRunUsageCount = await adminDb.ciWorkflowRunUsage.count();
    expect(ciWorkflowRunUsageCount).toBe(0);
  });

  it('ACKS rather than 500s when metering throws — a retry cannot fix an API outage', async () => {
    // GitHub retries a failed delivery, and the idempotency key means a later
    // redelivery meters exactly once, so acking loses nothing recoverable.
    await seedTenant();
    stubGithub();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await githubWebhookService.handleEvent('workflow_run', delivery())).toEqual({
      event: 'workflow_run',
      outcome: 'failed',
    });
    expect(error).toHaveBeenCalled();
  });

  it('reports an unusable delivery without touching the meter', async () => {
    await seedTenant();
    stubGithub();

    expect(
      await githubWebhookService.handleEvent('workflow_run', delivery({ workflow_run: undefined })),
    ).toEqual({ event: 'workflow_run', outcome: 'ignored_action' });
    expect(
      await githubWebhookService.handleEvent('workflow_run', delivery({ installation: undefined })),
    ).toEqual({ event: 'workflow_run', outcome: 'unknown_installation' });
  });
});

describe("a hosted repo in a fleet account's GitHub org (MOTIR-8974)", () => {
  const SHARD_ORG = 'motir-shard-1';

  beforeEach(async () => {
    await adminDb.fleetShard.deleteMany({});
    resetOwnedOrgCache();
    await fleetShardService.createShard({
      name: 'ci-runner-shard-1',
      fleetKind: 'ci_runner',
      provider: 'fly',
      state: 'active',
      githubOrg: SHARD_ORG,
      githubInstallationId: '77001',
      flyOrg: 'motir',
      flyApp: 'motir-ci-shard-1',
      flyRegion: 'iad',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      limits: { machineLimit: 50 },
    });
  });

  afterEach(async () => {
    await adminDb.fleetShard.deleteMany({});
    resetOwnedOrgCache();
  });

  it('is metered and rolled into the month exactly as one in the provisioning org', async () => {
    const fx = await seedTenant({ repoOwner: SHARD_ORG });
    stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(
      runEvent({ repoOwner: SHARD_ORG }),
      INSTALLATION_ID,
    );

    expect(result).toMatchObject({
      outcome: 'metered',
      organizationId: fx.organizationId,
      billableMinutes: STARTER_BILLABLE_MINUTES,
    });
    const rollup = await adminDb.ciPeriodUsage.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(rollup.billableMinutes).toBe(STARTER_BILLABLE_MINUTES);
  });

  it('is NOT metered once the account is disabled — the org leaves the set', async () => {
    const [account] = await fleetShardService.listShards();
    await fleetShardService.setState(account!.id, 'disabled');
    resetOwnedOrgCache();
    await seedTenant({ repoOwner: SHARD_ORG });
    stubGithub();

    const result = await ciMinutesMeterService.meterWorkflowRun(
      runEvent({ repoOwner: SHARD_ORG }),
      INSTALLATION_ID,
    );
    expect(result).toEqual({ outcome: 'not_metered', reason: 'foreign_owner' });
  });
});
