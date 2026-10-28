import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawUsageResponse } from '@/lib/ai/types';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { stubPaidAiPlan } from '../helpers/paidAiPlan';
import { planCapsService } from '@/lib/services/planCapsService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET MONITOR READ (MOTIR-7316 · Story MOTIR-6905) against a REAL Postgres.
// Mocked: the platform session gate and motir-ai's balance read. Real: the
// intents, slots, accrual rows, charge record, kill record, the census, the
// entitlement read and the audit trail.

const usageMock = vi.fn<(q: unknown) => Promise<RawUsageResponse>>();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgUsage: (q: unknown) => usageMock(q),
}));

let currentPrincipal: PlatformPrincipal;
const gate = vi.fn(async () => currentPrincipal);
vi.mock('@/lib/platform/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/auth')>()),
  requirePlatformStaff: () => gate(),
}));

const {
  classify,
  platformFleetMonitorService,
  FLEET_MONITOR_WINDOW_MS,
  FLEET_MONITOR_PERIOD_MS,
  FLEET_ORGS_PAGE_SIZE,
} = await import('@/lib/services/platformFleetMonitorService');
const { workspacesService } = await import('@/lib/services/workspacesService');
type FleetFacts = import('@/lib/services/platformFleetMonitorService').FleetFacts;

/** On a debit-period boundary, so the "current tick" is `NOW` itself. */
const NOW = new Date('2026-07-15T12:00:00.000Z');
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');
const W = FLEET_MONITOR_WINDOW_MS;
const P = FLEET_MONITOR_PERIOD_MS;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

let seq = 0;

interface Tenant {
  organizationId: string;
  workspaceId: string;
}

async function seedTenant(options: { isMeta?: boolean } = {}): Promise<Tenant> {
  const owner = await createTestUser({ email: `fleet-mon-${seq++}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Fleet ${seq}`,
    ownerUserId: owner.id,
  });
  if (options.isMeta) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  return { organizationId: workspace.organizationId, workspaceId: workspace.id };
}

async function seedIntent(
  t: Tenant,
  options: { startedAt?: Date | null; status?: string; settledAt?: Date | null } = {},
) {
  seq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: t.workspaceId,
      organizationId: t.organizationId,
      installationId: '1',
      runId: `run-${seq}`,
      runAttempt: 1,
      jobId: `job-${seq}`,
      repoOwner: 'motir-projects',
      repoName: 'web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: ago(60 * MIN),
      status: options.status ?? 'running',
      startedAt: options.startedAt === undefined ? ago(11 * MIN) : options.startedAt,
      settledAt: options.settledAt ?? null,
    },
  });
}

async function seedAccrual(t: Tenant, tickStart: Date, seconds = 300) {
  const intent = await seedIntent(t, {
    status: 'completed',
    startedAt: ago(120 * MIN),
    settledAt: ago(90 * MIN),
  });
  await adminDb.ciLiveAccrual.create({
    data: {
      provisioningIntentId: intent.id,
      organizationId: t.organizationId,
      workspaceId: t.workspaceId,
      runId: intent.runId,
      runAttempt: 1,
      tickStart,
      periodStart: JULY_2026,
      accruedSeconds: seconds,
    },
  });
}

async function seedSlot(organizationId: string, workload: string, claimedAt: Date) {
  seq += 1;
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref: `ref-${seq}`,
      organizationId,
      claimedAt,
      expiresAt: new Date(NOW.getTime() + 60 * MIN),
    },
  });
}

/** Spend the one-member org's 1,000 included minutes so a ≤ 0 balance exhausts it. */
async function spendPool(t: Tenant) {
  await withSystemContext((tx) =>
    ciPeriodUsageRepository.incrementForPeriod(
      {
        workspaceId: t.workspaceId,
        organizationId: t.organizationId,
        periodStart: JULY_2026,
        billableMinutes: 1_200,
        rawWallClockSeconds: 72_000,
        linearEquivalentMinutes: 1_200,
      },
      tx,
    ),
  );
}

const auditRows = () => adminDb.platformAuditLog.count();

beforeEach(async () => {
  vi.restoreAllMocks();
  // The plan's figures at their seam (MOTIR-9377): Max unless a case says otherwise.
  stubPaidAiPlan('max');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "fleet_machine_kill", "ci_period_usage", "fleet_in_flight_slot", "ci_live_accrual", "ci_runner_provisioning_intent", "ci_period_charge" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  const staff = await createTestUser({ email: `ops+fleet${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: staff.id, email: staff.email, role: 'support' };
  gate.mockReset().mockImplementation(async () => currentPrincipal);
  usageMock.mockReset().mockResolvedValue({ balance: 500 } as RawUsageResponse);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The pure verdict, at each boundary ──────────────────────────────────────

const QUIET: FleetFacts = {
  meteringEnabled: true,
  isMeta: false,
  ciInFlight: 0,
  oldestCiJobStartedAt: null,
  oldestCiInFlightAt: null,
  oldestSlotClaimedAt: null,
  ciSettledInWindow: 0,
  latestAccrualTickStart: null,
  charge: null,
  balance: 'not_read',
};

function running(startedAt: Date, extra: Partial<FleetFacts> = {}): FleetFacts {
  return {
    ...QUIET,
    ciInFlight: 1,
    oldestCiJobStartedAt: startedAt,
    oldestCiInFlightAt: startedAt,
    ...extra,
  };
}

describe('classify — the verdict rule', () => {
  it('nothing running and nothing accrued is ok', () => {
    expect(classify(QUIET, NOW)).toEqual(['ok']);
  });

  it('running_not_debited (a): a job started before now − W with no tick in the window', () => {
    expect(classify(running(ago(W + 1)), NOW)).toEqual(['running_not_debited']);
    // A tick at exactly now − W reaches the org.
    expect(classify(running(ago(W + 1), { latestAccrualTickStart: ago(W) }), NOW)).toEqual(['ok']);
    // A tick before the window does not.
    expect(classify(running(ago(W + 1), { latestAccrualTickStart: ago(W + 1) }), NOW)).toEqual([
      'running_not_debited',
    ]);
  });

  it('a job started at EXACTLY now − W is not yet owed a tick', () => {
    expect(classify(running(ago(W)), NOW)).toEqual(['ok']);
  });

  it('running_not_debited (b): a debit outstanding for the whole window', () => {
    const stuck = (since: Date | null) =>
      running(ago(W + 1), {
        latestAccrualTickStart: NOW,
        charge: {
          chargedCredits: 150,
          debitedCredits: 0,
          pendingDebitRef: 'ci:org:2026-07:0-150',
          pendingDebitSince: since,
        },
      });
    expect(classify(stuck(ago(W)), NOW)).toEqual(['running_not_debited']);
    // Pending for less than the window: motir-ai still has slack to confirm.
    expect(classify(stuck(ago(W - 1)), NOW)).toEqual(['ok']);
    // Charged and confirmed (no ref) is not stuck, however old the row.
    expect(
      classify(
        running(ago(W + 1), {
          latestAccrualTickStart: NOW,
          charge: {
            chargedCredits: 150,
            debitedCredits: 150,
            pendingDebitRef: null,
            pendingDebitSince: null,
          },
        }),
        NOW,
      ),
    ).toEqual(['ok']);
  });

  it('debited_nothing_running: a tick in the window with no CI in flight or settled in it', () => {
    expect(classify({ ...QUIET, latestAccrualTickStart: ago(W) }, NOW)).toEqual([
      'debited_nothing_running',
    ]);
    expect(
      classify({ ...QUIET, latestAccrualTickStart: ago(W), ciSettledInWindow: 1 }, NOW),
    ).toEqual(['ok']);
    expect(classify({ ...QUIET, latestAccrualTickStart: ago(W + 1) }, NOW)).toEqual(['ok']);
  });

  it('exhausted_still_running: older than one period is owed the stop; inside it, not yet', () => {
    const ci = (at: Date) => running(at, { latestAccrualTickStart: NOW, balance: 'exhausted' });
    expect(classify(ci(ago(P + 1)), NOW)).toEqual(['exhausted_still_running']);
    expect(classify(ci(ago(P)), NOW)).toEqual(['ok']);
    // An agent instance or hosted run alone, judged on its slot's claim.
    expect(
      classify({ ...QUIET, balance: 'exhausted', oldestSlotClaimedAt: ago(P + 1) }, NOW),
    ).toEqual(['exhausted_still_running']);
    expect(
      classify({ ...QUIET, balance: 'exhausted', oldestSlotClaimedAt: ago(P - 1) }, NOW),
    ).toEqual(['ok']);
  });

  it('balance_unknown is shown and never a mismatch on its own', () => {
    expect(
      classify({ ...QUIET, balance: 'unknown', oldestSlotClaimedAt: ago(P + 1) }, NOW),
    ).toEqual(['balance_unknown']);
  });

  it('two mismatch reasons on one org are both reported, in order', () => {
    expect(classify(running(ago(W + 1), { balance: 'exhausted' }), NOW)).toEqual([
      'running_not_debited',
      'exhausted_still_running',
    ]);
  });

  it('meta orgs and an inert meter are not_charged, whatever else holds', () => {
    const leaking = running(ago(W + 1), { balance: 'exhausted' });
    expect(classify({ ...leaking, isMeta: true }, NOW)).toEqual(['not_charged']);
    expect(classify({ ...leaking, meteringEnabled: false }, NOW)).toEqual(['not_charged']);
  });
});

// ── The gathered facts, against real rows ───────────────────────────────────

describe('judgeOrganization — the facts the verdict is judged on', () => {
  it('AC1: a CI job 11 minutes old with no tick is running_not_debited; a tick now makes it ok', async () => {
    const t = await seedTenant();
    await seedIntent(t, { startedAt: ago(11 * MIN) });
    const before = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(before.verdicts).toEqual(['running_not_debited']);
    expect(before.byWorkload.ci_runner).toBe(1);

    await seedAccrual(t, NOW);
    const after = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(after.verdicts).toEqual(['ok']);
    expect(after.accruedMinutesInWindow).toBe(5);
  });

  it('AC1 (b): a pending debit outstanding since before the window is running_not_debited', async () => {
    const t = await seedTenant();
    await seedIntent(t, { startedAt: ago(30 * MIN) });
    await seedAccrual(t, NOW);
    await adminDb.ciPeriodCharge.create({
      data: {
        organizationId: t.organizationId,
        periodStart: JULY_2026,
        chargedCredits: 150,
        debitedCredits: 0,
        pendingDebitRef: 'ci:x:0-150',
        pendingDebitCredits: 150,
        pendingDebitSince: ago(W + MIN),
      },
    });
    const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(reading.verdicts).toEqual(['running_not_debited']);
  });

  it('AC2: ticks in the window with no CI in flight or settled in it', async () => {
    const t = await seedTenant();
    await seedAccrual(t, ago(5 * MIN)); // its intent settled 90 minutes ago
    const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(reading.verdicts).toEqual(['debited_nothing_running']);
  });

  it('AC3: exhausted with a CI runner older than a period; inside the period it is ok', async () => {
    const t = await seedTenant();
    await spendPool(t);
    usageMock.mockResolvedValue({ balance: 0 } as RawUsageResponse);
    await seedAccrual(t, NOW);
    const runner = await seedIntent(t, { startedAt: ago(P + MIN) });
    expect(
      (await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW)).verdicts,
    ).toEqual(['exhausted_still_running']);

    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: runner.id },
      data: { startedAt: ago(P - MIN) },
    });
    expect(
      (await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW)).verdicts,
    ).toEqual(['ok']);
  });

  it('AC3: exhausted with a running agent instance older than a period', async () => {
    const t = await seedTenant();
    await spendPool(t);
    usageMock.mockResolvedValue({ balance: -3 } as RawUsageResponse);
    await seedSlot(t.organizationId, 'agent_instance', ago(P + MIN));
    const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(reading.verdicts).toEqual(['exhausted_still_running']);
    expect(reading.byWorkload.agent_instance).toBe(1);
    // The figure the zero stop read rides along, for the page's "balance −3".
    expect(reading.balanceCredits).toBe(-3);
  });

  it('AC4: an unreadable balance is balance_unknown, never a mismatch', async () => {
    const t = await seedTenant();
    usageMock.mockRejectedValue(new Error('motir-ai is down'));
    await seedSlot(t.organizationId, 'hosted_agent', ago(P + MIN));
    const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(reading.verdicts).toEqual(['balance_unknown']);
    expect(reading.balanceCredits).toBeNull();
  });

  it('AC4: a meta org is not_charged, and its balance is never read', async () => {
    const t = await seedTenant({ isMeta: true });
    await seedIntent(t, { startedAt: ago(30 * MIN) });
    const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(reading.verdicts).toEqual(['not_charged']);
    expect(usageMock).not.toHaveBeenCalled();
  });

  it('nothing older than a period never crosses into motir-ai', async () => {
    const t = await seedTenant();
    await seedSlot(t.organizationId, 'hosted_agent', ago(P - MIN));
    const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(usageMock).not.toHaveBeenCalled();
    expect(reading.balanceCredits).toBeNull();
  });
});

// ── The plan's figures (MOTIR-9377) ─────────────────────────────────────────

describe('judgeOrganization — the plan figures each workload is read against', () => {
  it('a Pro org reads its four figures, the CI one from the plan', async () => {
    stubPaidAiPlan('pro');
    const t = await seedTenant();
    const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(reading.plan).toEqual({
      kind: 'capped',
      planKey: 'pro',
      planName: 'Pro',
      agentRunsInParallel: 3,
      agentsPerUser: 2,
      agentsRunningPerOrg: 10,
      ciBurstCap: 5,
      ciBurstSource: 'plan',
    });
  });

  it('a staff override on a Max org is the CI figure, exactly as CI admission reads it', async () => {
    const t = await seedTenant();
    await adminDb.organization.update({
      where: { id: t.organizationId },
      data: { fleetPoolCap: 7 },
    });
    const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(reading.plan).toMatchObject({
      kind: 'capped',
      planKey: 'max',
      agentRunsInParallel: 5,
      agentsPerUser: 3,
      agentsRunningPerOrg: 20,
      ciBurstCap: 7,
      ciBurstSource: 'override',
    });
    expect(await fleetCeilingService.resolveCiBurstCap(t.organizationId)).toMatchObject({
      kind: 'capped',
      figure: 7,
      source: 'override',
    });
  });

  it.each([['isMeta'] as const, ['internalBilling'] as const])(
    'an exempt (%s) org reads no plan limit',
    async (flag) => {
      vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({ kind: 'exempt' });
      const t = await seedTenant();
      await adminDb.organization.update({
        where: { id: t.organizationId },
        data: { [flag]: true },
      });
      const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
      expect(reading.plan).toEqual({ kind: 'exempt', ciBurstOverride: null });
    },
  );

  it('an exempt org with a staff override carries it', async () => {
    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({ kind: 'exempt' });
    const t = await seedTenant({ isMeta: true });
    await adminDb.organization.update({
      where: { id: t.organizationId },
      data: { fleetPoolCap: 3 },
    });
    expect(
      (await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW)).plan,
    ).toEqual({ kind: 'exempt', ciBurstOverride: 3 });
  });

  it('an unmatched plan key is named; no figure is filled in', async () => {
    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({
      kind: 'plan_unknown',
      planKey: 'legacy_tier',
    });
    const t = await seedTenant();
    expect(
      (await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW)).plan,
    ).toEqual({ kind: 'plan_unknown', planKey: 'legacy_tier' });
  });

  it('a CI figure the CI gate cannot read is shown as unreadable beside the agent figures', async () => {
    vi.spyOn(fleetCeilingService, 'resolveCiBurstCap').mockResolvedValue({ kind: 'unreadable' });
    const t = await seedTenant();
    expect(
      (await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW)).plan,
    ).toMatchObject({
      kind: 'capped',
      planKey: 'max',
      agentRunsInParallel: 5,
      ciBurstCap: null,
      ciBurstSource: 'unreadable',
    });
  });

  it.each(['capsFor', 'resolveCiBurstCap'] as const)(
    'a throw from %s reads plan_unknown with no key, and the row keeps its counts and verdicts',
    async (read) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      if (read === 'capsFor') {
        vi.spyOn(planCapsService, 'capsFor').mockRejectedValue(new Error('motir-ai is down'));
      } else {
        vi.spyOn(fleetCeilingService, 'resolveCiBurstCap').mockRejectedValue(new Error('db down'));
      }
      const t = await seedTenant();
      await seedIntent(t, { startedAt: ago(30 * MIN) });
      const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
      expect(reading.plan).toEqual({ kind: 'plan_unknown', planKey: null });
      expect(reading.byWorkload.ci_runner).toBe(1);
      expect(reading.verdicts).toEqual(['running_not_debited']);
      expect(error).toHaveBeenCalled();
    },
  );
});

// ── The staff reads ─────────────────────────────────────────────────────────

describe('listRunningOrgs', () => {
  it('AC5: only orgs running something, mismatched first, 25 to a page with a total over 60', async () => {
    const quiet: string[] = [];
    for (let i = 0; i < 59; i += 1) {
      const org = await adminDb.organization.create({
        data: { name: `Quiet ${i}`, slug: `quiet-${seq++}` },
      });
      await seedSlot(org.id, 'code_graph_index', ago(MIN));
      quiet.push(org.id);
    }
    const leaking = await seedTenant();
    await seedIntent(leaking, { startedAt: ago(30 * MIN) });
    // An org running nothing and accruing nothing is not listed.
    const idle = await adminDb.organization.create({
      data: { name: 'Idle', slug: `idle-${seq++}` },
    });

    const first = await platformFleetMonitorService.listRunningOrgs(currentPrincipal, {}, NOW);
    if (first.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(first.total).toBe(60);
    expect(first.mismatched).toBe(1);
    // The head stats sum the WHOLE set, not the page: 1 runner, no hosted run.
    expect(first.ciRunners).toBe(1);
    expect(first.hostedAgents).toBe(0);
    expect(first.agentInstances).toBe(0);
    expect(first).not.toHaveProperty('defaultPool');
    expect(first).not.toHaveProperty('pooledContainers');
    expect(first.rows[0]).not.toHaveProperty('pool');
    expect(first.rows[0]).not.toHaveProperty('poolUsed');
    expect(first.pageCount).toBe(3);
    expect(first.rows).toHaveLength(FLEET_ORGS_PAGE_SIZE);
    expect(first.rows[0]).toMatchObject({
      organizationId: leaking.organizationId,
      verdicts: ['running_not_debited'],
    });
    expect(first.rows[0]?.name).toMatch(/^Fleet /);

    const last = await platformFleetMonitorService.listRunningOrgs(
      currentPrincipal,
      { page: 3 },
      NOW,
    );
    if (last.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(last.page).toBe(3);
    expect(last.rows).toHaveLength(10);

    const all = new Set<string>();
    for (const page of [1, 2, 3]) {
      const dto = await platformFleetMonitorService.listRunningOrgs(
        currentPrincipal,
        { page },
        NOW,
      );
      if (dto.meter === 'enabled') dto.rows.forEach((row) => all.add(row.organizationId));
    }
    expect(all.size).toBe(60);
    expect(all.has(idle.id)).toBe(false);
    expect(quiet.every((id) => all.has(id))).toBe(true);
  });

  it('off-cloud, the section is disabled and reads nothing', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    expect(await platformFleetMonitorService.listRunningOrgs(currentPrincipal, {}, NOW)).toEqual({
      meter: 'disabled',
    });
  });
});

describe('orgFleet', () => {
  it("returns one org's row, running or not", async () => {
    const t = await seedTenant();
    const dto = await platformFleetMonitorService.orgFleet(currentPrincipal, t.organizationId, NOW);
    if (dto.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(dto.row).toMatchObject({
      organizationId: t.organizationId,
      plan: { kind: 'capped', planKey: 'max', ciBurstCap: 10, ciBurstSource: 'plan' },
      confirmedCreditsThisMonth: 0,
      pendingCredits: 0,
      verdicts: ['ok'],
    });
    expect(dto.window).toEqual({
      windowMinutes: 10,
      periodMinutes: 5,
      judgedAt: NOW.toISOString(),
    });
  });
});

describe('the row carries what the page prints beneath its figures', () => {
  it('the pending debit, its age and the latest tick', async () => {
    const t = await seedTenant();
    await seedIntent(t, { startedAt: ago(3 * MIN) });
    await seedAccrual(t, ago(5 * MIN));
    await adminDb.ciPeriodCharge.create({
      data: {
        organizationId: t.organizationId,
        periodStart: JULY_2026,
        chargedCredits: 1_325,
        debitedCredits: 1_240,
        pendingDebitRef: 'ci:x:1240-1325',
        pendingDebitCredits: 85,
        pendingDebitSince: ago(4 * MIN),
      },
    });
    const dto = await platformFleetMonitorService.orgFleet(currentPrincipal, t.organizationId, NOW);
    if (dto.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(dto.row).toMatchObject({
      confirmedCreditsThisMonth: 1_240,
      pendingCredits: 85,
      pendingSince: ago(4 * MIN).toISOString(),
      latestAccrualTickAt: ago(5 * MIN).toISOString(),
      balanceCredits: null,
    });
  });

  it('nothing pending and no tick ever: both null', async () => {
    const t = await seedTenant();
    const dto = await platformFleetMonitorService.orgFleet(currentPrincipal, t.organizationId, NOW);
    if (dto.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(dto.row.pendingSince).toBeNull();
    expect(dto.row.latestAccrualTickAt).toBeNull();
  });
});

describe('listKills', () => {
  it('AC5: newest first, paged, carrying failureDetail on an incomplete kill', async () => {
    const t = await seedTenant();
    for (let i = 0; i < 30; i += 1) {
      await adminDb.fleetMachineKill.create({
        data: {
          app: 'motir-fleet',
          machineId: `m-${i}`,
          machineName: `machine-${i}`,
          reason: 'unattributed',
          action: 'destroy',
          workload: 'ci_runner',
          organizationId: i === 29 ? t.organizationId : null,
          ageSeconds: 600,
          decidedAt: ago((30 - i) * MIN),
          completedAt: i === 29 ? null : ago((30 - i) * MIN),
          failureDetail: i === 29 ? 'fly: 503 machine busy' : null,
        },
      });
    }
    // Older than `since`: not listed.
    await adminDb.fleetMachineKill.create({
      data: {
        app: 'motir-fleet',
        machineId: 'm-old',
        reason: 'unattributed',
        action: 'destroy',
        ageSeconds: 600,
        decidedAt: ago(48 * 60 * MIN),
      },
    });

    const dto = await platformFleetMonitorService.listKills(
      currentPrincipal,
      { since: ago(24 * 60 * MIN) },
      NOW,
    );
    if (dto.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(dto.total).toBe(30);
    // The refused kill is counted over the window, not the page.
    expect(dto.failed).toBe(1);
    expect(dto.rows).toHaveLength(25);
    expect(dto.rows[0]).toMatchObject({
      machineId: 'm-29',
      completedAt: null,
      failureDetail: 'fly: 503 machine busy',
      organizationId: t.organizationId,
    });
    expect(dto.rows[0]?.organizationName).toMatch(/^Fleet /);
    expect(dto.rows.map((row) => row.decidedAt)).toEqual(
      [...dto.rows.map((row) => row.decidedAt)].sort().reverse(),
    );

    const second = await platformFleetMonitorService.listKills(
      currentPrincipal,
      { since: ago(24 * 60 * MIN), page: 2 },
      NOW,
    );
    if (second.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(second.rows.map((row) => row.machineId)).toEqual(['m-4', 'm-3', 'm-2', 'm-1', 'm-0']);
  });
});

describe('the gate and the audit trail (AC6)', () => {
  it('every read writes exactly one estate.read row', async () => {
    const t = await seedTenant();
    await seedIntent(t);

    for (const read of [
      () => platformFleetMonitorService.listRunningOrgs(currentPrincipal, {}, NOW),
      () => platformFleetMonitorService.orgFleet(currentPrincipal, t.organizationId, NOW),
      () => platformFleetMonitorService.listKills(currentPrincipal, {}, NOW),
    ]) {
      const before = await auditRows();
      await read();
      expect(await auditRows()).toBe(before + 1);
    }
    const rows = await adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => [row.action, row.targetKind])).toEqual([
      ['estate.read', 'platform'],
      ['estate.read', 'organization'],
      ['estate.read', 'platform'],
    ]);
    expect(rows[1]?.targetId).toBe(t.organizationId);
  });

  it('a principal without platform staff is refused before any read', async () => {
    const t = await seedTenant();
    gate.mockRejectedValue(new NotPlatformStaffError());
    const before = await auditRows();

    await expect(
      platformFleetMonitorService.listRunningOrgs(currentPrincipal, {}, NOW),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    await expect(
      platformFleetMonitorService.orgFleet(currentPrincipal, t.organizationId, NOW),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    await expect(
      platformFleetMonitorService.listKills(currentPrincipal, {}, NOW),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);

    expect(await auditRows()).toBe(before);
    expect(usageMock).not.toHaveBeenCalled();
  });
});
