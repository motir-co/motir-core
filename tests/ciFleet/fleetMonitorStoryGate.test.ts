import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Story MOTIR-6905's INTEGRATION GATE, part 1 (MOTIR-7321) — THE READ → VERDICT →
 * ALERT SEAM, against a real Postgres.
 *
 * The fleet monitor's page read (`platformFleetMonitorService.listRunningOrgs`)
 * and the mismatch alert job (`system.fleet-debit-monitor`) are two consumers of
 * ONE verdict. Their own suites prove each half with the other stubbed; this file
 * seeds the real rows every mismatch reason is judged on — `CiRunnerProvisioningIntent`,
 * `CiLiveAccrual`, `CiPeriodCharge`, `CiPeriodUsage`, `FleetInFlightSlot` — runs
 * the real job handler with a Sentry capture spy, and asserts the alert's
 * fingerprints are EXACTLY the page's mismatch verdicts for the same orgs on the
 * same clock.
 *
 * Mocked, and nothing else: the SESSION (the test environment has no cookies —
 * the real `requirePlatformStaff` reads the user's role from Postgres), Sentry at
 * its module, and motir-ai's balance read at its client (no live motir-ai).
 *
 * Also here: every monitor read writes exactly one `estate.read`, and the
 * coverage top-up for the monitor's and the job's edges.
 */

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

/** motir-ai's balance, per org: a number, or an Error for "could not be read". */
const balances = new Map<string, number | Error>();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgUsage: vi.fn(async (q: { coreOrganizationId: string }) => {
    const balance = balances.get(q.coreOrganizationId) ?? 500;
    if (balance instanceof Error) throw balance;
    return { balance };
  }),
}));

const { db } = await import('@/lib/db');
const { MOTIR_RUNNER_LABEL } = await import('@/lib/ciFleet/config');
const { isFleetMismatch } = await import('@/lib/dto/platformFleetMonitor');
const { NotPlatformStaffError } = await import('@/lib/platform/errors');
const { requirePlatformStaff } = await import('@/lib/platform/auth');
const { ciPeriodUsageRepository } = await import('@/lib/repositories/ciPeriodUsageRepository');
const { ciAllowanceService } = await import('@/lib/services/ciAllowanceService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { platformFleetMonitorService, FLEET_MONITOR_WINDOW_MS, FLEET_MONITOR_PERIOD_MS } =
  await import('@/lib/services/platformFleetMonitorService');
const { fleetDebitMonitorService } = await import('@/lib/services/fleetDebitMonitorService');
const { fleetDebitMonitor } = await import('@/lib/jobs/definitions/fleetDebitMonitor');
const { withSystemContext } = await import('@/lib/workspaces/context');
const { platformOrganizationRepository } =
  await import('@/lib/repositories/platformOrganizationRepository');
const { FleetDebitMismatchError } = await import('@/lib/ciFleet/debitMismatchErrors');
const { createTestUser } = await import('../fixtures/userFixtures');
const { JobTestEngine } = await import('../helpers/jobs');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables, truncateJobRuns } = await import('../helpers/db');

type FleetVerdict = import('@/lib/dto/platformFleetMonitor').FleetVerdict;
type PlatformPrincipal = import('@/lib/platform/auth').PlatformPrincipal;

/** On a debit-period boundary — the job and every read below judge at this instant. */
const NOW = new Date('2026-07-15T12:00:00.000Z');
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');
const MIN = 60_000;
const W = FLEET_MONITOR_WINDOW_MS;
const P = FLEET_MONITOR_PERIOD_MS;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let seq = 0;

interface Tenant {
  organizationId: string;
  workspaceId: string;
  name: string;
}

async function seedTenant(label: string, options: { isMeta?: boolean } = {}): Promise<Tenant> {
  seq += 1;
  const owner = await createTestUser({ email: `fleet-gate-${seq}@example.com` });
  const name = `${label} ${seq}`;
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  if (options.isMeta) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  const org = await adminDb.organization.findUniqueOrThrow({
    where: { id: workspace.organizationId },
  });
  return { organizationId: workspace.organizationId, workspaceId: workspace.id, name: org.name };
}

async function seedIntent(
  t: Tenant,
  options: {
    startedAt?: Date | null;
    bootedAt?: Date | null;
    queuedAt?: Date;
    status?: string;
    settledAt?: Date | null;
  } = {},
) {
  seq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: t.workspaceId,
      organizationId: t.organizationId,
      installationId: '1',
      runId: `gate-run-${seq}`,
      runAttempt: 1,
      jobId: `gate-job-${seq}`,
      repoOwner: 'motir-projects',
      repoName: 'web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: options.queuedAt ?? ago(60 * MIN),
      status: options.status ?? 'running',
      startedAt: options.startedAt === undefined ? ago(11 * MIN) : options.startedAt,
      bootedAt: options.bootedAt ?? null,
      settledAt: options.settledAt ?? null,
    },
  });
}

/** One live-charge tick for the org, on an intent that settled long before the window. */
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

async function seedStuckDebit(t: Tenant) {
  await adminDb.ciPeriodCharge.create({
    data: {
      organizationId: t.organizationId,
      periodStart: JULY_2026,
      chargedCredits: 150,
      debitedCredits: 0,
      pendingDebitRef: `ci:${t.organizationId}:0-150`,
      pendingDebitCredits: 150,
      pendingDebitSince: ago(W + MIN),
    },
  });
}

async function seedSlot(t: Tenant, workload: string, claimedAt: Date) {
  seq += 1;
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref: `gate-ref-${seq}`,
      organizationId: t.organizationId,
      claimedAt,
      expiresAt: new Date(NOW.getTime() + 60 * MIN),
    },
  });
}

/** Spend the one-member org's included minutes, so a ≤ 0 balance exhausts it. */
async function exhaust(t: Tenant) {
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
  balances.set(t.organizationId, 0);
}

/** The estate: one org per verdict, plus one holding two mismatches at once. */
async function seedEstate() {
  // running_not_debited (a) — a job 11 minutes in, and no tick has reached the org.
  const noTick = await seedTenant('NoTick');
  await seedIntent(noTick, { startedAt: ago(11 * MIN) });

  // running_not_debited (b) — ticks arrive, but motir-ai has not confirmed the
  // debit for the whole window.
  const stuck = await seedTenant('Stuck');
  await seedIntent(stuck, { startedAt: ago(30 * MIN) });
  await seedAccrual(stuck, NOW);
  await seedStuckDebit(stuck);

  // debited_nothing_running — a tick inside the window, nothing in flight or settled in it.
  const phantom = await seedTenant('Phantom');
  await seedAccrual(phantom, ago(5 * MIN));

  // exhausted_still_running — balance 0, a runner older than one period, ticks arriving.
  const exhausted = await seedTenant('Exhausted');
  await exhaust(exhausted);
  await seedAccrual(exhausted, NOW);
  await seedIntent(exhausted, { startedAt: ago(P + MIN) });

  // Two reasons on one org: exhausted AND no tick reaching a 21-minute job.
  const both = await seedTenant('Both');
  await exhaust(both);
  await seedIntent(both, { startedAt: ago(W + MIN) });

  // balance_unknown — a hosted run older than a period, and motir-ai cannot answer.
  const unknown = await seedTenant('Unknown');
  balances.set(unknown.organizationId, new Error('motir-ai is down'));
  await seedSlot(unknown, 'hosted_agent', ago(P + MIN));

  // not_charged — the meta org leaks every way and is never alerted.
  const meta = await seedTenant('Meta', { isMeta: true });
  await seedIntent(meta, { startedAt: ago(W + MIN) });

  // ok — a fresh job and a tick now.
  const ok = await seedTenant('Healthy');
  await seedIntent(ok, { startedAt: ago(3 * MIN) });
  await seedAccrual(ok, NOW);

  return { noTick, stuck, phantom, exhausted, both, unknown, meta, ok };
}

const EXPECTED: Record<keyof Awaited<ReturnType<typeof seedEstate>>, FleetVerdict[]> = {
  noTick: ['running_not_debited'],
  stuck: ['running_not_debited'],
  phantom: ['debited_nothing_running'],
  exhausted: ['exhausted_still_running'],
  both: ['running_not_debited', 'exhausted_still_running'],
  unknown: ['balance_unknown'],
  meta: ['not_charged'],
  ok: ['ok'],
};

let staff: PlatformPrincipal;

async function signInStaff(role: 'support' | 'superadmin' = 'support') {
  seq += 1;
  const user = await createTestUser({ email: `ops+fleetgate${seq}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id } };
  staff = await requirePlatformStaff('support');
}

/** The fingerprint the alert raises for one (org, reason). */
const fingerprint = (orgId: string, reason: string) => ['fleet-debit-mismatch', reason, orgId];

function capturedFingerprints(): string[][] {
  return captureException.mock.calls.map(
    ([, hint]) => (hint as { fingerprint: string[] }).fingerprint,
  );
}

const sortFp = (fps: string[][]) => [...fps].map((fp) => fp.join('|')).sort();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_audit_log", "fleet_machine_kill", "ci_period_usage", "fleet_in_flight_slot", "ci_live_accrual", "ci_runner_provisioning_intent", "ci_period_charge" RESTART IDENTITY CASCADE',
  );
  await truncateJobRuns();
  await truncateAuthTables();
  captureException.mockReset();
  balances.clear();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
  await signInStaff();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('read → verdict → alert: the page and the alert agree (AC2)', () => {
  it('for every mismatch reason, the alert fingerprints ARE the page’s mismatch verdicts', async () => {
    const estate = await seedEstate();

    // ── The alert: the real job handler, on the fixed clock ──────────────────
    const { result } = await new JobTestEngine({ function: fleetDebitMonitor }).execute();
    expect(result).toEqual({ orgs: 8, mismatched: 5, alerted: 6, failures: 0 });

    // ── The page: the staff read the monitor renders ─────────────────────────
    const page = await platformFleetMonitorService.listRunningOrgs(staff, {}, NOW);
    if (page.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(page.total).toBe(8);
    expect(page.mismatched).toBe(5);
    const pageVerdicts = new Map(page.rows.map((row) => [row.organizationId, row.verdicts]));

    // Each org's verdict, named — so the agreement below cannot pass vacuously.
    for (const [key, tenant] of Object.entries(estate)) {
      expect(pageVerdicts.get(tenant.organizationId), key).toEqual(
        EXPECTED[key as keyof typeof EXPECTED],
      );
      const judged = await platformFleetMonitorService.judgeOrganization(
        tenant.organizationId,
        NOW,
      );
      expect(judged.verdicts, key).toEqual(EXPECTED[key as keyof typeof EXPECTED]);
    }

    // The agreement: one fingerprint per (org, mismatch verdict) the page shows,
    // and nothing for ok / balance_unknown / not_charged.
    const fromPage = page.rows.flatMap((row) =>
      row.verdicts.filter(isFleetMismatch).map((reason) => fingerprint(row.organizationId, reason)),
    );
    expect(sortFp(capturedFingerprints())).toEqual(sortFp(fromPage));
    expect(fromPage).toHaveLength(6);

    // The alert names the org the page names.
    for (const [error] of captureException.mock.calls) {
      const err = error as { organizationId: string; message: string };
      const row = page.rows.find((r) => r.organizationId === err.organizationId);
      expect(err.message).toContain(row?.name ?? '∅');
    }
  });

  it('a second run over the same rows raises the SAME fingerprints — one issue per (org, reason)', async () => {
    await seedEstate();
    await new JobTestEngine({ function: fleetDebitMonitor }).execute();
    const first = sortFp(capturedFingerprints());
    captureException.mockReset();
    await new JobTestEngine({ function: fleetDebitMonitor }).execute();
    expect(sortFp(capturedFingerprints())).toEqual(first);
  });

  it('a mismatch the meter repairs stops alerting on the next run, and the page clears it too', async () => {
    const t = await seedTenant('Repaired');
    await seedIntent(t, { startedAt: ago(11 * MIN) });
    await fleetDebitMonitorService.run(NOW);
    expect(capturedFingerprints()).toEqual([fingerprint(t.organizationId, 'running_not_debited')]);

    // The live charge catches up: a tick lands now.
    await seedAccrual(t, NOW);
    captureException.mockReset();
    expect(await fleetDebitMonitorService.run(NOW)).toMatchObject({ alerted: 0, mismatched: 0 });
    const dto = await platformFleetMonitorService.orgFleet(staff, t.organizationId, NOW);
    expect(dto.meter === 'enabled' && dto.row.verdicts).toEqual(['ok']);
  });
});

describe('the audit trail of the reads (AC5)', () => {
  it('each monitor read writes exactly ONE estate.read; the alert job writes none', async () => {
    const estate = await seedEstate();
    const reads: [string, () => Promise<unknown>, string][] = [
      [
        'listRunningOrgs',
        () => platformFleetMonitorService.listRunningOrgs(staff, {}, NOW),
        'platform',
      ],
      [
        'orgFleet',
        () => platformFleetMonitorService.orgFleet(staff, estate.noTick.organizationId, NOW),
        'organization',
      ],
      ['listKills', () => platformFleetMonitorService.listKills(staff, {}, NOW), 'platform'],
    ];
    for (const [name, read, targetKind] of reads) {
      const before = await adminDb.platformAuditLog.count();
      await read();
      const rows = await adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rows, name).toHaveLength(before + 1);
      expect(rows.at(-1), name).toMatchObject({
        action: 'estate.read',
        actorUserId: staff.userId,
        targetKind,
      });
    }

    const before = await adminDb.platformAuditLog.count();
    await fleetDebitMonitorService.run(NOW);
    expect(await adminDb.platformAuditLog.count()).toBe(before);
  });

  it('off-cloud each read still writes its one estate.read, and reads nothing', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const t = await seedTenant('Offcloud');
    const before = await adminDb.platformAuditLog.count();
    expect(await platformFleetMonitorService.listRunningOrgs(staff, {}, NOW)).toEqual({
      meter: 'disabled',
    });
    expect(await platformFleetMonitorService.orgFleet(staff, t.organizationId, NOW)).toEqual({
      meter: 'disabled',
    });
    expect(await platformFleetMonitorService.listKills(staff, {}, NOW)).toEqual({
      meter: 'disabled',
    });
    const rows = await adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(before + 3);
    expect(rows.slice(-3).map((row) => [row.action, row.targetKind, row.targetId])).toEqual([
      ['estate.read', 'platform', null],
      ['estate.read', 'organization', t.organizationId],
      ['estate.read', 'platform', null],
    ]);
  });

  it('a non-staff session is refused by every read before it reads or audits', async () => {
    const t = await seedTenant('Refused');
    await seedIntent(t);
    currentSession = {
      user: { id: (await createTestUser({ email: `no-role-${seq++}@x.test` })).id },
    };
    await expect(requirePlatformStaff('support')).rejects.toBeInstanceOf(NotPlatformStaffError);
    for (const read of [
      () => platformFleetMonitorService.listRunningOrgs(staff, {}, NOW),
      () => platformFleetMonitorService.orgFleet(staff, t.organizationId, NOW),
      () => platformFleetMonitorService.listKills(staff, {}, NOW),
    ]) {
      await expect(read()).rejects.toBeInstanceOf(NotPlatformStaffError);
    }
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});

describe('the monitor’s edges (coverage top-up)', () => {
  it('the oldest job is the EARLIEST of several; a container with no start is aged by boot, then queue', async () => {
    const t = await seedTenant('Several');
    await seedIntent(t, { startedAt: ago(W + 2 * MIN) });
    await seedIntent(t, { startedAt: ago(2 * MIN) });
    await seedIntent(t, { startedAt: null, bootedAt: ago(4 * MIN) });
    await seedIntent(t, { startedAt: null, bootedAt: null, queuedAt: ago(6 * MIN) });
    const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
    expect(reading.facts.oldestCiJobStartedAt).toEqual(ago(W + 2 * MIN));
    expect(reading.facts.oldestCiInFlightAt).toEqual(ago(W + 2 * MIN));
    expect(reading.facts.ciInFlight).toBe(4);
    expect(reading.verdicts).toEqual(['running_not_debited']);

    // Not started at all: aged by the boot, and failing that by the queue.
    const booting = await seedTenant('Booting');
    await seedIntent(booting, { startedAt: null, bootedAt: ago(4 * MIN) });
    await seedIntent(booting, { startedAt: null, bootedAt: null, queuedAt: ago(9 * MIN) });
    const b = await platformFleetMonitorService.judgeOrganization(booting.organizationId, NOW);
    expect(b.facts.oldestCiJobStartedAt).toBeNull();
    expect(b.facts.oldestCiInFlightAt).toEqual(ago(9 * MIN));
  });

  it('an entitlement read that THROWS is balance_unknown, logged — Error or not', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = await seedTenant('Throws');
    await seedSlot(t, 'agent_instance', ago(P + MIN));
    vi.spyOn(ciAllowanceService, 'getEntitlementState')
      .mockRejectedValueOnce(new Error('entitlement exploded'))
      .mockRejectedValueOnce('a bare string');

    for (const detail of ['entitlement exploded', 'unknown']) {
      const reading = await platformFleetMonitorService.judgeOrganization(t.organizationId, NOW);
      expect(reading.verdicts).toEqual(['balance_unknown']);
      expect(reading.balanceCredits).toBeNull();
      expect(error).toHaveBeenLastCalledWith(
        '[platformFleetMonitorService] could not read the entitlement',
        { organizationId: t.organizationId, detail },
      );
    }
  });

  it('an organisation with no row is judged as charged, and its row falls back to the reading', async () => {
    const gone = 'org_does_not_exist';
    await adminDb.fleetInFlightSlot.create({
      data: {
        workload: 'hosted_agent',
        ref: 'gate-orphan',
        organizationId: gone,
        claimedAt: ago(MIN),
        expiresAt: new Date(NOW.getTime() + 60 * MIN),
      },
    });
    const reading = await platformFleetMonitorService.judgeOrganization(gone, NOW);
    expect(reading).toMatchObject({ name: null, facts: { isMeta: false }, verdicts: ['ok'] });

    const dto = await platformFleetMonitorService.orgFleet(staff, gone, NOW);
    if (dto.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(dto.row).toMatchObject({ organizationId: gone, name: null, isMeta: false });

    const list = await platformFleetMonitorService.listRunningOrgs(
      staff,
      { page: Number.NaN },
      NOW,
    );
    if (list.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(list.page).toBe(1);
    expect(list.rows).toEqual([expect.objectContaining({ organizationId: gone, name: null })]);
  });

  it('a kill whose organisation the name read does not return carries no name', async () => {
    const t = await seedTenant('Killed');
    await adminDb.fleetMachineKill.create({
      data: {
        app: 'motir-fleet',
        machineId: 'm-orphan',
        reason: 'org_stopped',
        action: 'destroy',
        workload: 'ci_runner',
        organizationId: t.organizationId,
        ageSeconds: 900,
        decidedAt: ago(MIN),
        completedAt: ago(MIN),
      },
    });
    // The org is deleted between the kill read and the name read.
    vi.spyOn(platformOrganizationRepository, 'findOrganizationsByIds').mockResolvedValue([]);
    const dto = await platformFleetMonitorService.listKills(staff, {}, NOW);
    if (dto.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(dto.rows).toEqual([
      expect.objectContaining({
        machineId: 'm-orphan',
        organizationId: t.organizationId,
        organizationName: null,
      }),
    ]);
  });

  it('a judgement that throws a non-Error is one failure, logged as `unknown`', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(platformFleetMonitorService, 'listOrganizationsToJudge').mockResolvedValue(['x']);
    vi.spyOn(platformFleetMonitorService, 'judgeOrganization').mockRejectedValue('bare');
    expect(await fleetDebitMonitorService.run(NOW)).toEqual({
      orgs: 1,
      mismatched: 0,
      alerted: 0,
      failures: 1,
    });
    expect(error).toHaveBeenCalledWith(
      '[fleetDebitMonitorService] could not judge an organization',
      {
        organizationId: 'x',
        detail: 'unknown',
      },
    );
  });

  it('an alert for an org with no name still names the org by id', () => {
    const error = new FleetDebitMismatchError('org_nameless', null, 'running_not_debited');
    expect(error.message).toContain('an unnamed organization (org_nameless)');
  });
});
