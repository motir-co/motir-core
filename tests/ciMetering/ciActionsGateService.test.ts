import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciActionsGateService } from '@/lib/services/ciActionsGateService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import {
  actionsPermissionsClient,
  type SetActionsEnabledInput,
} from '@/lib/github/actionsPermissions';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { organizationIdOf } from '../helpers/organizationOf';

// THE CI-ACTIONS GATE against real Postgres (Story MOTIR-1775 · MOTIR-1907) —
// `docs/decisions/ci-minutes-allowance.md` §A, §4.4, §6.5, §8.6.
//
// The GitHub boundary is stubbed at `actionsPermissionsClient.setActionsEnabled`
// (the module that owns ALL the host mechanics — the same seam
// `repoProvisioning` established for creation). Everything below it is real: the
// RLS contexts, the per-workspace GUC binding, the intent columns, the
// convergence predicate and the ownership filter, because every acceptance
// criterion here is about what the DATABASE holds and WHICH repositories get
// called.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-07-15T12:00:00.000Z');

interface Tenant {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  userId: string;
}

let seq = 0;

/** One org + workspace + project. `isMeta` flips the org's meta flag — the flag
 *  that must bypass this gate no matter what the entitlement says. */
async function seedTenant(opts?: { isMeta?: boolean }): Promise<Tenant> {
  seq += 1;
  const user = await usersService.createUser({
    email: `ci-actions-${seq}-${Date.now()}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${seq}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Proj ${seq}`,
    identifier: `P${seq}X`,
  });
  if (opts?.isMeta) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
    userId: user.id,
  };
}

/**
 * A repo-set row REALIZED against a mirror row.
 *
 * `state` is the ownership axis and the whole point of several tests below:
 * `created` is a repository MOTIR made (Motir pays GitHub for its Actions);
 * `connected` is one the user already owned and merely pointed Motir at (they
 * pay). Only the former may ever be touched.
 */
async function seedRepo(
  tenant: Tenant,
  name: string,
  opts?: { state?: 'created' | 'connected'; owner?: string },
): Promise<{ rowId: string }> {
  const owner = opts?.owner ?? MOTIR_ORG;
  const installationId = `inst-${tenant.workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      // NULL, as Motir's shared provisioning installation is in production: no
      // tenant owns it, so a tenant context cannot read it (MOTIR-10062).
      workspaceId: null,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: tenant.workspaceId,
      organizationId: await organizationIdOf(tenant.workspaceId),
      repoId: `${name}-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: tenant.workspaceId,
      projectId: tenant.projectId,
      role: 'web',
      name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: opts?.state ?? 'created',
      position: `a${seq}${name}`,
      githubRepoId: mirror.id,
    },
  });
  return { rowId: row.id };
}

/** An entitlement state to INJECT. The gate never re-derives it, so a test can
 *  put the org in any state without staging a balance or a meter row. */
function stateOf(state: CiEntitlementStateDTO['state']): CiEntitlementStateDTO {
  return {
    organizationId: 'org',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    applicable: state !== 'bypassed',
    internal: false,
    memberCount: 3,
    poolMinutes: 1000,
    floorApplied: true,
    consumedMinutes: state === 'within_allowance' ? 10 : 2000,
    remainingMinutes: 0,
    overageMinutes: state === 'within_allowance' ? 0 : 1000,
    chargedCredits: 0,
    balance: state === 'ci_credits_exhausted' ? 0 : 100,
    state,
  };
}

async function readRow(rowId: string) {
  const row = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: rowId } });
  return {
    disabled: row.ciActionsDisabled,
    intentAt: row.ciActionsIntentAt,
    appliedAt: row.ciActionsAppliedAt,
  };
}

let setActionsEnabled: MockInstance<(input: SetActionsEnabledInput) => Promise<void>>;

/**
 * What GitHub does with the installation id a call is made under: it mints a token
 * only for an id IT issued — a seeded `GithubInstallation.installationId`. Any
 * other id, Motir's own `GithubInstallation.id` cuid above all (MOTIR-10062), is
 * the 404 production answers, so the stub refuses it rather than succeeding.
 */
async function githubIssued(input: SetActionsEnabledInput): Promise<void> {
  const known = await adminDb.githubInstallation.findUnique({
    where: { installationId: input.installationId },
  });
  if (!known) {
    throw new Error(`token endpoint returned 404 for installation ${input.installationId}`);
  }
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  setActionsEnabled = vi
    .spyOn(actionsPermissionsClient, 'setActionsEnabled')
    .mockImplementation(githubIssued);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('ciActionsGateService — the exhausted stop', () => {
  it('disables Actions on every Motir-CREATED repo of the org, and on no other', async () => {
    const tenant = await seedTenant();
    const created = await seedRepo(tenant, 'alpha-web');
    const second = await seedRepo(tenant, 'alpha-api');
    // The user's own repository, merely connected. GitHub bills THEM for it, so
    // it must never be touched — the criterion this whole test exists for.
    const connected = await seedRepo(tenant, 'alpha-legacy', { state: 'connected' });

    const result = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });

    expect(result).toMatchObject({ outcome: 'synced', disabled: true, intentChanged: 2 });
    expect(await readRow(created.rowId)).toMatchObject({ disabled: true });
    expect(await readRow(second.rowId)).toMatchObject({ disabled: true });
    expect(await readRow(connected.rowId)).toMatchObject({
      disabled: false,
      intentAt: null,
      appliedAt: null,
    });

    // Two host calls, both DISABLING, and neither for the connected repo.
    expect(setActionsEnabled).toHaveBeenCalledTimes(2);
    const targets = setActionsEnabled.mock.calls.map(([arg]) => arg);
    expect(targets.map((t) => t.repo).sort()).toEqual(['alpha-api', 'alpha-web']);
    expect(targets.every((t) => t.enabled === false)).toBe(true);
  });

  it('calls GitHub under its NUMERIC installation id, never Motir\u2019s cuid (MOTIR-10062)', async () => {
    const tenant = await seedTenant();
    const row = await seedRepo(tenant, 'iota-web');
    const installation = await adminDb.githubInstallation.findUniqueOrThrow({
      where: { installationId: `inst-${tenant.workspaceId}` },
    });

    const result = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });

    expect(result).toMatchObject({ outcome: 'synced', applied: 1, failed: 0 });
    expect(setActionsEnabled).toHaveBeenCalledTimes(1);
    expect(setActionsEnabled.mock.calls[0]![0].installationId).toBe(installation.installationId);
    expect(setActionsEnabled.mock.calls[0]![0].installationId).not.toBe(installation.id);
    expect((await readRow(row.rowId)).appliedAt).not.toBeNull();
  });

  it('leaves a row pending, calling nothing, when its installation is no longer on record', async () => {
    const tenant = await seedTenant();
    const row = await seedRepo(tenant, 'kappa-web');
    vi.spyOn(githubInstallationRepository, 'findHostInstallationIdsByIds').mockResolvedValue(
      new Map(),
    );

    const result = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });

    expect(result).toMatchObject({ outcome: 'synced', applied: 0, failed: 1 });
    expect(setActionsEnabled).not.toHaveBeenCalled();
    const after = await readRow(row.rowId);
    expect(after.disabled).toBe(true);
    expect(after.appliedAt).toBeNull();
  });

  it('stamps applied only after the host call lands, so a settled row leaves the pending set', async () => {
    const tenant = await seedTenant();
    const row = await seedRepo(tenant, 'beta-web');

    await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });

    const after = await readRow(row.rowId);
    expect(after.disabled).toBe(true);
    expect(after.intentAt).not.toBeNull();
    expect(after.appliedAt).not.toBeNull();
    // Converged means applied is at or after intent — the predicate the sweep reads.
    expect(after.appliedAt!.getTime()).toBeGreaterThanOrEqual(after.intentAt!.getTime());
  });

  it.each(['within_allowance', 'drawing_on_credits', 'bypassed'] as const)(
    'disables nothing in the %s state',
    async (state) => {
      const tenant = await seedTenant();
      const row = await seedRepo(tenant, `gamma-${state}`);

      const result = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
        at: NOW,
        state: stateOf(state),
      });

      expect(result).toMatchObject({ outcome: 'synced', disabled: false });
      expect(await readRow(row.rowId)).toMatchObject({ disabled: false });
      // Crossing the pool is §6.1's normal, VISIBLE event — work keeps running.
      expect(setActionsEnabled).not.toHaveBeenCalled();
    },
  );

  it('leaves another organization untouched', async () => {
    const exhausted = await seedTenant();
    const bystander = await seedTenant();
    const mine = await seedRepo(exhausted, 'mine-web');
    const theirs = await seedRepo(bystander, 'theirs-web');

    await ciActionsGateService.syncForOrganization(exhausted.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });

    expect(await readRow(mine.rowId)).toMatchObject({ disabled: true });
    expect(await readRow(theirs.rowId)).toMatchObject({ disabled: false, intentAt: null });
    expect(setActionsEnabled).toHaveBeenCalledTimes(1);
  });
});

describe('ciActionsGateService — fail OPEN', () => {
  it('leaves Actions ENABLED and makes no host call when the entitlement read throws', async () => {
    const tenant = await seedTenant();
    const row = await seedRepo(tenant, 'delta-web');
    vi.spyOn(ciAllowanceService, 'getEntitlementState').mockRejectedValue(
      new Error('motir-ai unreachable'),
    );

    // No injected state — this is the path that READS, so the read can throw.
    const result = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
    });

    expect(result).toMatchObject({ outcome: 'failed_open' });
    // Motir's own outage must never look like the user being out of credits.
    expect(await readRow(row.rowId)).toMatchObject({ disabled: false, intentAt: null });
    expect(setActionsEnabled).not.toHaveBeenCalled();
  });
});

describe('ciActionsGateService — the bypasses', () => {
  /**
   * ⚠️ THE STATE IS INJECTED AS `ci_credits_exhausted` ON PURPOSE, and this is the
   * whole point of the test.
   *
   * `getEntitlementState` returns `bypassed` for a meta org and NEVER
   * `ci_credits_exhausted` (§4.4 — moooon B.V. pays its own GitHub bill), so a
   * test that let this path READ the state would exercise THAT guard, return
   * early on `state !== exhausted`, and go green having never touched the
   * `isMeta` branch at all — asserting the allowance service's behaviour while
   * appearing to assert this card's. Injecting the exhausted state is the only
   * way to reach the meta guard, and reaching it matters: disabling Actions on
   * `moooon-B-V` would cost Motir the ability to ship the fix.
   */
  it('bypasses a META org even when the state says exhausted — no call, no intent write', async () => {
    const tenant = await seedTenant({ isMeta: true });
    const row = await seedRepo(tenant, 'meta-web');

    const result = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });

    expect(result).toEqual({ outcome: 'bypassed', reason: 'meta' });
    expect(setActionsEnabled).not.toHaveBeenCalled();
    expect(await readRow(row.rowId)).toMatchObject({
      disabled: false,
      intentAt: null,
      appliedAt: null,
    });
  });

  it('bypasses entirely off-cloud (MOTIR_CLOUD=false), likewise on an exhausted state', async () => {
    const tenant = await seedTenant();
    const row = await seedRepo(tenant, 'selfhost-web');
    vi.stubEnv('MOTIR_CLOUD', 'false');

    const result = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });

    expect(result).toEqual({ outcome: 'bypassed', reason: 'disabled' });
    expect(setActionsEnabled).not.toHaveBeenCalled();
    expect(await readRow(row.rowId)).toMatchObject({ disabled: false, intentAt: null });
  });

  it('bypasses when no provisioning org is configured — nothing is Motir-owned', async () => {
    const tenant = await seedTenant();
    await seedRepo(tenant, 'unowned-web');
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');

    const result = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });

    expect(result).toEqual({ outcome: 'bypassed', reason: 'disabled' });
    expect(setActionsEnabled).not.toHaveBeenCalled();
  });
});

describe('ciActionsGateService — resume', () => {
  it('re-enables every row it disabled when the balance recovers, and no row it did not', async () => {
    const tenant = await seedTenant();
    const disabled = await seedRepo(tenant, 'eps-web');
    const untouched = await seedRepo(tenant, 'eps-legacy', { state: 'connected' });

    await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });
    expect(await readRow(disabled.rowId)).toMatchObject({ disabled: true });
    setActionsEnabled.mockClear();

    // The top-up: balance back above zero, so the org is merely drawing credits.
    const later = new Date(NOW.getTime() + 60_000);
    await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: later,
      state: stateOf('drawing_on_credits'),
    });

    expect(await readRow(disabled.rowId)).toMatchObject({ disabled: false });
    expect(await readRow(untouched.rowId)).toMatchObject({ intentAt: null, appliedAt: null });
    expect(setActionsEnabled).toHaveBeenCalledTimes(1);
    expect(setActionsEnabled.mock.calls[0]![0]).toMatchObject({
      repo: 'eps-web',
      enabled: true,
    });
  });

  it('lists a disabled org so the hourly resume can find it without the org acting', async () => {
    const disabledTenant = await seedTenant();
    const solvent = await seedTenant();
    await seedRepo(disabledTenant, 'zeta-web');
    await seedRepo(solvent, 'eta-web');

    await ciActionsGateService.syncForOrganization(disabledTenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });

    // A disabled org cannot meter a run (its Actions are off), so nothing it does
    // can re-trigger the gate — the resume pass has to be able to find it.
    const ids = await ciActionsGateService.listDisabledOrganizationIds();
    expect(ids).toContain(disabledTenant.organizationId);
    expect(ids).not.toContain(solvent.organizationId);
  });
});

describe('ciActionsGateService — convergence', () => {
  it('records intent for a row whose host call FAILED, and the next sweep completes it', async () => {
    const tenant = await seedTenant();
    const ok = await seedRepo(tenant, 'theta-ok');
    const flaky = await seedRepo(tenant, 'theta-flaky');

    // Half the fan-out fails — the case the whole persist-intent design exists for.
    setActionsEnabled.mockImplementation(async (input: SetActionsEnabledInput) => {
      if (input.repo === 'theta-flaky') throw new Error('GitHub 500');
      await githubIssued(input);
    });

    const first = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });
    expect(first).toMatchObject({ outcome: 'synced', applied: 1, failed: 1 });

    // Both rows hold the intent; only the one that landed is stamped applied.
    expect(await readRow(ok.rowId)).toMatchObject({ disabled: true });
    expect((await readRow(ok.rowId)).appliedAt).not.toBeNull();
    const flakyAfterFirst = await readRow(flaky.rowId);
    expect(flakyAfterFirst.disabled).toBe(true);
    expect(flakyAfterFirst.intentAt).not.toBeNull();
    expect(flakyAfterFirst.appliedAt).toBeNull();

    // GitHub recovers; the sweep finishes the job with no new intent decision.
    setActionsEnabled.mockReset();
    setActionsEnabled.mockImplementation(githubIssued);
    const swept = await ciActionsGateService.sweep();

    expect(swept).toEqual({ applied: 1, failed: 0 });
    expect(setActionsEnabled).toHaveBeenCalledTimes(1);
    expect(setActionsEnabled.mock.calls[0]![0]).toMatchObject({
      repo: 'theta-flaky',
      enabled: false,
    });
    expect((await readRow(flaky.rowId)).appliedAt).not.toBeNull();
  });

  it('is a no-op on a second pass in the same state — no re-stamp, no repeat call', async () => {
    const tenant = await seedTenant();
    const row = await seedRepo(tenant, 'iota-web');

    await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });
    const afterFirst = await readRow(row.rowId);
    setActionsEnabled.mockClear();

    const second = await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: new Date(NOW.getTime() + 60_000),
      state: stateOf('ci_credits_exhausted'),
    });

    // The intent did not change, so the row never re-enters the pending set —
    // without that guard, every pass would re-issue a call per repo forever.
    expect(second).toMatchObject({ intentChanged: 0, applied: 0, failed: 0 });
    expect(setActionsEnabled).not.toHaveBeenCalled();
    expect(await readRow(row.rowId)).toEqual(afterFirst);
  });

  it('sweeps nothing when everything is converged', async () => {
    const tenant = await seedTenant();
    await seedRepo(tenant, 'kappa-web');
    await ciActionsGateService.syncForOrganization(tenant.organizationId, {
      at: NOW,
      state: stateOf('ci_credits_exhausted'),
    });
    setActionsEnabled.mockClear();

    expect(await ciActionsGateService.sweep()).toEqual({ applied: 0, failed: 0 });
    expect(setActionsEnabled).not.toHaveBeenCalled();
  });
});
