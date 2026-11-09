import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { platformMeterReportEnqueue } from '@/lib/services/platformMeterReportEnqueue';
import { supervisionSweepService } from '@/lib/services/supervisionSweepService';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { ciContainerUsageRepository } from '@/lib/repositories/ciContainerUsageRepository';
import {
  ciContainerUsageSliceRepository,
  IDLE_SLICE_REF,
} from '@/lib/repositories/ciContainerUsageSliceRepository';
import { periodStartFor } from '@/lib/ciMetering/period';
import { containerWorkloadFor, FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import {
  buildContainerAccrual,
  type ContainerAccrual,
  type ContainerUsage,
} from '@motir/orchestrator';
import { recordContainerAccrual, recordContainerUsage } from '@/lib/orchestrator';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken, randomInt } from '../helpers/random';

// THE FLEET COST METER against real Postgres (Story MOTIR-1916 · MOTIR-1924 ·
// MOTIR-1995) — `docs/decisions/ci-minutes-allowance.md` §P, `ci-runner-fleet.md`
// §5 and `code-graph-index-fleet.md` §2.
//
// Everything here is real: the tables, the RLS contexts the writes run under,
// the unique index and the row lock that make the record idempotent per container,
// and the rollup the margin readout reads. Nothing is stubbed but the environment
// flags, which ARE the bypasses under test.
//
// What MOTIR-1924 was measured against, and still is:
//   * per-container rows, idempotent, attributed repo → project → workspace → org;
//   * cost per org per period queryable, margin derivable from STORED values;
//   * nothing debits a ledger;
//   * `MOTIR_CLOUD=false` bypasses.
//
// What MOTIR-1995 adds, and where each lives below:
//   * the three-value workload axis (`ci` / `index` / `agent`), separable in the
//     rollup and never merged into one figure;
//   * INCREMENTAL accrual — a running container has recorded seconds before it
//     stops, and teardown reconciles to the true total;
//   * idempotency UNDER CHECKPOINTING — a replayed accrual adds nothing, and a
//     crashed container's partial accrual reconciles rather than duplicating;
//   * `isMeta` orgs are METERED (the bypass is gone), with their cost readable as
//     its own line, and nothing debits a ledger for ANYONE;
//   * ONE write path — a test that fails if a second writer can reach the record.

const PASSWORD = 'hunter2hunter2';
const STOPPED_AT = new Date('2026-08-15T12:00:00.000Z');
const AUGUST_2026 = new Date('2026-08-01T00:00:00.000Z');
/** The shipped `fly`/`iad` rate (`lib/orchestrator/rates.ts`), which is also
 *  what the `fake` adapter prices at — so the arithmetic below is production's,
 *  not a test constant. */
const IAD_USD_PER_SECOND = '0.000031636049';

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  repoFullName: string;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    // MOTIR-3066 — `ci_period_usage` first, matching the suite's other two
    // ci-usage truncates; opposite orders on shared tables deadlock (40P01).
    'TRUNCATE TABLE "ci_period_usage", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  // The meter is a CLOUD meter (§8.5). Every test that expects a write says so;
  // the two that expect the bypass override it.
  vi.stubEnv('MOTIR_CLOUD', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedTenant(options: { isMeta?: boolean } = {}): Promise<Fixture> {
  const email = `fleet-cost-${randomToken(6)}@example.com`;
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
  if (options.isMeta) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    repoFullName: 'motir-projects/acme-web',
  };
}

/** The money a container of `seconds` costs, at the shipped `iad` rate — computed
 *  the way production computes it (`Prisma.Decimal`, never a float), so an
 *  assertion on the stored value is an assertion about the real arithmetic. */
function costFor(seconds: number): string {
  return new Prisma.Decimal(IAD_USD_PER_SECOND).mul(seconds).toFixed();
}

/** One container-seconds record, exactly as `buildContainerUsage` emits it. */
function usageFor(fx: Fixture, overrides: Partial<ContainerUsage> = {}): ContainerUsage {
  const billableSeconds = overrides.billableSeconds ?? 240;
  const stoppedAt = overrides.stoppedAt ?? STOPPED_AT;
  return {
    handleId: `m-${randomToken(8)}`,
    provider: 'fake',
    region: 'iad',
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName: fx.repoFullName,
    workload: 'ci_runner',
    workflowJobId: 44001,
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 8192,
    createdAt: new Date(stoppedAt.getTime() - 300_000),
    startedAt: new Date(stoppedAt.getTime() - billableSeconds * 1000),
    stoppedAt,
    billableSeconds,
    usdPerSecond: IAD_USD_PER_SECOND,
    costUsd: costFor(billableSeconds),
    rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    terminalState: 'destroyed',
    teardownReason: 'job_completed',
    ...overrides,
  };
}

/**
 * One CHECKPOINT on a still-running container, exactly as `buildContainerAccrual`
 * emits it (MOTIR-1995).
 *
 * Defaulted to the INDEX workload rather than CI, because that is the workload that
 * actually reaches this seam today: `codeGraphIndexDispatchService`'s poll is the
 * one supervision loop wired to it, and an index container is the first thing the
 * shared fleet org runs that MOTIR-1924's meter could not see.
 */
function accrualFor(fx: Fixture, overrides: Partial<ContainerAccrual> = {}): ContainerAccrual {
  const accruedSeconds = overrides.accruedSeconds ?? 90;
  const observedAt = overrides.observedAt ?? STOPPED_AT;
  return {
    handleId: `m-${randomToken(8)}`,
    provider: 'fake',
    region: 'iad',
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName: fx.repoFullName,
    workload: 'code_graph_index',
    workflowJobId: null,
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 8192,
    createdAt: new Date(observedAt.getTime() - 300_000),
    startedAt: new Date(observedAt.getTime() - accruedSeconds * 1000),
    observedAt,
    accruedSeconds,
    usdPerSecond: IAD_USD_PER_SECOND,
    costUsd: costFor(accruedSeconds),
    rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('recording one container', () => {
  it('persists the per-runner row and the period rollup, attributed to the org', async () => {
    const fx = await seedTenant();
    const usage = usageFor(fx);

    const outcome = await ciFleetCostMeterService.recordContainerUsage(usage);

    expect(outcome).toMatchObject({
      outcome: 'recorded',
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      periodStart: AUGUST_2026,
      billableSeconds: 240,
    });
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row).toMatchObject({
      containerProvider: 'fake',
      handleId: usage.handleId,
      containerRegion: 'iad',
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      repoFullName: 'motir-projects/acme-web',
      // Stored as a STRING: GitHub's job ids are 64-bit and nothing does maths
      // on them, the same call the intent table makes.
      workflowJobId: '44001',
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 8192,
      billableSeconds: 240,
      terminalState: 'destroyed',
      teardownReason: 'job_completed',
    });
    // The period is a PURE function of the container's STOP instant (§4.5), so
    // it lands in the same monthly bucket the minute meter would use.
    expect(row.periodStart).toEqual(AUGUST_2026);

    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup).toMatchObject({
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      containerSeconds: 240,
      containerCount: 1,
    });
    // 240 s × $0.000031636049 — carried at full decimal precision, never floated.
    expect(rollup.costUsd.toFixed(12)).toBe('0.007592651760');
    expect(row.costUsd.toFixed(12)).toBe('0.007592651760');
    expect(row.usdPerSecond.toFixed(12)).toBe(IAD_USD_PER_SECOND);
  });

  it('a JOBLESS container stores a NULL job id, never the string "null" (MOTIR-2025)', async () => {
    // ⚠️ THE TRAP THIS CLOSES. The port's `workflowJobId` became nullable when
    // indexing joined the fleet, and the write was a bare `String(...)` —
    // `String(null)` is the four-character string `'null'`, which the column
    // accepts happily and which makes "this workload has no job" indistinguish-
    // able from a job actually called that. The column has been `String?` since
    // it was written, for exactly this row.
    const fx = await seedTenant();

    const outcome = await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null }),
    );

    expect(outcome).toMatchObject({ outcome: 'recorded' });
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.workflowJobId).toBeNull();
    expect(row.workflowJobId).not.toBe('null');
    // Everything else about the row is written exactly as it always was — this
    // card widens the port, it does not re-shape the meter (MOTIR-1995 owns
    // teaching this column the workload it is now carried on the record).
    expect(row).toMatchObject({
      containerProvider: 'fake',
      repoFullName: 'motir-projects/acme-web',
      billableSeconds: 240,
      teardownReason: 'job_completed',
    });
  });

  it('is IDEMPOTENT per container — the second teardown of a handle changes nothing', async () => {
    // The `finally` that guarantees teardown and the reaper can both reach the
    // same container, and `teardown` is required to be idempotent — so the
    // second arrival must cost nothing, INCLUDING in the rollup.
    const fx = await seedTenant();
    const usage = usageFor(fx);

    await ciFleetCostMeterService.recordContainerUsage(usage);
    const second = await ciFleetCostMeterService.recordContainerUsage(usage);

    expect(second).toEqual({
      outcome: 'duplicate',
      containerProvider: 'fake',
      handleId: usage.handleId,
    });
    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerCount).toBe(1);
    expect(rollup.containerSeconds).toBe(240);
  });

  it('the ROW LOCK is the guard, not the pre-check — two concurrent settles count once', async () => {
    // Mutation check (MOTIR-1995 replaces MOTIR-1924's unique-index argument with a
    // lock, because the write is no longer a single insert: it READS what the
    // container already contributed and increments the rollup by the difference,
    // which is a read-derived write — `notes.html` #35).
    //
    // Firing both at once is what proves the serialization. Without the
    // `createIfAbsent` → `FOR UPDATE` ordering, both callers would find no prior
    // contribution and each add the container's whole 240 s, and the rollup would
    // say 480 for one container.
    const fx = await seedTenant();
    const usage = usageFor(fx);

    const outcomes = await Promise.all([
      ciFleetCostMeterService.recordContainerUsage(usage),
      ciFleetCostMeterService.recordContainerUsage(usage),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['duplicate', 'recorded']);
    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(240);
    expect(rollup.containerCount).toBe(1);
  });

  it('sums SEVERAL containers into one (workspace, period) rollup row', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx, { billableSeconds: 100 }));
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx, { billableSeconds: 200 }));

    const rollups = await adminDb.ciContainerPeriodCost.findMany();
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ containerSeconds: 300, containerCount: 2 });
  });

  it('records a FAILED BOOT at zero seconds — the row still exists', async () => {
    // §5: "a container with no usage row is a bug with a name". A container that
    // never started is not billed by the provider, so it costs nothing here —
    // but it is still recorded, and the null start instant is what says why.
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        startedAt: null,
        billableSeconds: 0,
        costUsd: '0',
        teardownReason: 'provision_failed',
        terminalState: 'created',
      }),
    );

    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.containerStartedAt).toBeNull();
    expect(row.billableSeconds).toBe(0);
    expect(row.costUsd.toNumber()).toBe(0);
    expect(row.teardownReason).toBe('provision_failed');
  });

  it('records an UNPRICED container with a null rate — "cost unknown", not a real zero', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { usdPerSecond: '0', costUsd: '0', rateEffectiveFrom: null, region: 'syd' }),
    );

    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.rateEffectiveFrom).toBeNull();
    expect(row.costUsd.toNumber()).toBe(0);
    // Distinguishable from a genuine zero-second row by the seconds beside it.
    expect(row.billableSeconds).toBe(240);
  });

  it('keeps the row when the PROJECT is deleted — real money, no longer attributable', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx));

    await adminDb.project.delete({ where: { id: fx.projectId } });

    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.projectId).toBeNull();
    expect(row.organizationId).toBe(fx.organizationId);
  });

  it('DEBITS NOTHING — no credit ledger row, no charge row', async () => {
    // The card's hardest boundary: this is Motir's COGS, never a user-facing
    // charge. `ci_period_charge` is the entitlement half's only durable state,
    // and metering a container must not touch it.
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx));

    const ciPeriodChargeCount = await adminDb.ciPeriodCharge.count();
    expect(ciPeriodChargeCount).toBe(0);
    const ciPeriodUsageCount = await adminDb.ciPeriodUsage.count();
    expect(ciPeriodUsageCount).toBe(0);
  });
});

describe('the bypasses — one survives, one does NOT (§8.5; MOTIR-1995 vs §4.4)', () => {
  it('is INERT off-cloud — MOTIR_CLOUD unset writes nothing', async () => {
    const fx = await seedTenant();
    vi.stubEnv('MOTIR_CLOUD', '');

    expect(await ciFleetCostMeterService.recordContainerUsage(usageFor(fx))).toEqual({
      outcome: 'disabled',
    });
    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(0);
  });

  it('the off-cloud bypass covers the CHECKPOINT path too', async () => {
    // Same claim, same reason: off-cloud there is no fleet, so there is nothing to
    // accrue either. A bypass that covered only the settle would write partial rows
    // on a self-hosted install for containers that do not exist.
    const fx = await seedTenant();
    vi.stubEnv('MOTIR_CLOUD', '');

    expect(await ciFleetCostMeterService.recordContainerAccrual(accrualFor(fx))).toEqual({
      outcome: 'disabled',
    });
    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(0);
  });

  it('METERS the meta org — the §4.4 bypass is GONE, because meta runs on the fleet', async () => {
    // ⚠️ THE INVERSION THIS CARD IS FOR. MOTIR-1924 bypassed meta entirely and was
    // right to: meta CI never runs on the fleet (MOTIR-1915), so there was nothing
    // to record. Meta INDEXING does run on it (`code-graph-index-fleet.md` decision
    // 7 — the circularity test passes for indexing, unlike CI), so the same bypass
    // would produce real Fly spend with NO ROW: dogfooding unbounded and invisible,
    // the shape MOTIR-1935 was filed over.
    const fx = await seedTenant({ isMeta: true });

    const outcome = await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null }),
    );

    expect(outcome).toMatchObject({
      outcome: 'recorded',
      organizationId: fx.organizationId,
      workload: 'index',
      billableSeconds: 240,
    });
    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const ciContainerPeriodCostCount = await adminDb.ciContainerPeriodCost.count();
    expect(ciContainerPeriodCostCount).toBe(1);
  });

  it('meta cost is queryable as ITS OWN LINE — never folded into per-customer margin', async () => {
    // The other half of removing the bypass. Metering meta creates the opposite
    // hazard to skipping it — its cost silently inside the per-customer figure — so
    // the same rows have to be readable as two populations.
    const meta = await seedTenant({ isMeta: true });
    const tenant = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(meta, { workload: 'code_graph_index', workflowJobId: null, billableSeconds: 300 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(usageFor(tenant, { billableSeconds: 120 }));

    const split = await ciFleetCostMeterService.getMetaPeriodCostSplit(STOPPED_AT);

    expect(split).toEqual([
      {
        isMeta: false,
        workload: 'ci',
        containerSeconds: 120,
        costUsd: expect.any(String),
        containerCount: 1,
      },
      {
        isMeta: true,
        workload: 'index',
        containerSeconds: 300,
        costUsd: expect.any(String),
        containerCount: 1,
      },
    ]);
  });

  it('DEBITS NOTHING FOR ANYONE — meta included, no ledger row either way', async () => {
    // `isMeta` suppresses only a CHARGE, and this meter charges nobody — which is
    // exactly why it needs no `isMeta` branch. Asserted for both populations rather
    // than argued: `ci_period_charge` is the entitlement half's only durable state.
    const meta = await seedTenant({ isMeta: true });
    const tenant = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(meta));
    await ciFleetCostMeterService.recordContainerUsage(usageFor(tenant));
    await ciFleetCostMeterService.recordContainerAccrual(accrualFor(tenant));

    const ciPeriodChargeCount = await adminDb.ciPeriodCharge.count();
    expect(ciPeriodChargeCount).toBe(0);
    const ciPeriodUsageCount = await adminDb.ciPeriodUsage.count();
    expect(ciPeriodUsageCount).toBe(0);
  });
});

describe('the WORKLOAD axis — three lines in one shared fleet org (MOTIR-1995)', () => {
  it('records each workload under its own cost line', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'ci_runner', billableSeconds: 100 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null, billableSeconds: 200 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'hosted_agent', workflowJobId: null, billableSeconds: 400 }),
    );

    const rows = await adminDb.ciContainerUsage.findMany({ orderBy: { billableSeconds: 'asc' } });
    expect(rows.map((r) => r.workload)).toEqual(['ci', 'index', 'agent']);
  });

  it('keeps the three SEPARABLE in the rollup — they never merge into one figure', async () => {
    // The acceptance in one test. A rollup keyed only by (workspace, period) would
    // answer 700 s here and make "what did indexing cost us?" a scan over
    // per-container rows — the scan the rollup exists to avoid.
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'ci_runner', billableSeconds: 100 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null, billableSeconds: 200 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'hosted_agent', workflowJobId: null, billableSeconds: 400 }),
    );

    const byWorkload = await ciFleetCostMeterService.getOrgPeriodCostByWorkload(
      fx.organizationId,
      STOPPED_AT,
    );
    expect(byWorkload).toEqual([
      { workload: 'agent', containerSeconds: 400, costUsd: expect.any(String), containerCount: 1 },
      { workload: 'ci', containerSeconds: 100, costUsd: expect.any(String), containerCount: 1 },
      { workload: 'index', containerSeconds: 200, costUsd: expect.any(String), containerCount: 1 },
    ]);
    // And each line is independently readable by the same indexed read.
    expect(
      (await ciFleetCostMeterService.getOrgPeriodCost(fx.organizationId, STOPPED_AT, 'index'))
        .containerSeconds,
    ).toBe(200);
    expect(
      (await ciFleetCostMeterService.getOrgPeriodCost(fx.organizationId, STOPPED_AT, 'ci'))
        .containerSeconds,
    ).toBe(100);
  });

  it('the MARGIN readout uses the `ci` line ONLY — index spend never inflates cost-per-minute', async () => {
    // §Q.2's phantom drift as a RATIO: the denominator is metered CI minutes, so
    // folding index seconds into the numerator produces a cost-per-CI-minute figure
    // that overstates by whatever else the org ran — quietly, and worse as indexing
    // grows. The one number §M's estimate is supposed to be checkable against.
    const fx = await seedTenant();
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: fx.organizationId,
          periodStart: AUGUST_2026,
          billableMinutes: 10,
          rawWallClockSeconds: 600,
          linearEquivalentMinutes: 10,
        },
        tx,
      ),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'ci_runner', billableSeconds: 600 }),
    );
    // A big index container in the same period, which must NOT move the ratio.
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, { workload: 'code_graph_index', workflowJobId: null, billableSeconds: 9000 }),
    );

    const basis = await ciFleetCostMeterService.getOrgPeriodCostBasis(
      fx.organizationId,
      STOPPED_AT,
    );

    expect(basis.containerSeconds).toBe(600);
    expect(Number(basis.costPerLinearEquivalentMinute)).toBeCloseTo(
      (600 * Number(IAD_USD_PER_SECOND)) / 10,
      12,
    );
  });

  it('a new fleet workload cannot be recorded without declaring its cost line', async () => {
    // The totality guard as a runtime assertion of a COMPILE-time property: the
    // registry's union and the cost axis are mapped by a total `Record`, so a fourth
    // workload that names no line fails to build rather than recording spend under
    // whatever value a writer passed. Asserted here because a type-level guarantee
    // that nothing reads is a guarantee nobody notices being weakened to a
    // `Partial` or a lookup-with-fallback.
    expect(FLEET_WORKLOAD_KINDS.map((kind) => containerWorkloadFor(kind)).sort()).toEqual([
      'agent',
      'ci',
      'index',
      'instance',
    ]);
    for (const kind of FLEET_WORKLOAD_KINDS) {
      expect(containerWorkloadFor(kind)).toBeDefined();
    }
  });
});

describe('INCREMENTAL accrual — a running container is visible before it stops (MOTIR-1995)', () => {
  it('records seconds for a STILL-RUNNING container, with no stop instant', async () => {
    // The card's headline: an Epic 9 agent container spans hours, so under
    // teardown-only costing its whole life is spend with no row, against an account
    // Fly gives neither a cap nor an alert for. This is the partial figure read
    // MID-RUN.
    const fx = await seedTenant();

    const outcome = await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { accruedSeconds: 90 }),
    );

    expect(outcome).toMatchObject({
      outcome: 'accrued',
      workload: 'index',
      billableSeconds: 90,
      accruedSecondsDelta: 90,
    });
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(90);
    // The three fields that say "still running" — and the reason the columns were
    // relaxed to nullable ahead of this card.
    expect(row.containerStoppedAt).toBeNull();
    expect(row.terminalState).toBeNull();
    expect(row.teardownReason).toBeNull();
    // The partial cost is already in the rollup, which is the whole point: the
    // figure exists before the money is gone.
    expect((await adminDb.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(90);
  });

  it('ADVANCES on each checkpoint by the DIFFERENCE, never by the whole figure again', async () => {
    const fx = await seedTenant();
    const handleId = 'm-accruing';

    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 60 }),
    );
    const second = await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 150 }),
    );

    expect(second).toMatchObject({ billableSeconds: 150, accruedSecondsDelta: 90 });
    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    // 150, not 60 + 150. The rollup always equals the sum of the per-container rows.
    expect(rollup.containerSeconds).toBe(150);
    // And ONE container, not one per observation.
    expect(rollup.containerCount).toBe(1);
  });

  it('TEARDOWN RECONCILES to the true total — the settle is not the only write', async () => {
    const fx = await seedTenant();
    const handleId = 'm-settling';

    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 100 }),
    );
    const settled = await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 240,
      }),
    );

    expect(settled).toMatchObject({
      outcome: 'recorded',
      billableSeconds: 240,
      accruedSecondsDelta: 140,
    });
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(240);
    expect(row.containerStoppedAt).toEqual(STOPPED_AT);
    expect(row.teardownReason).toBe('job_completed');
    expect((await adminDb.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(240);
  });

  it('reconciles DOWNWARD when the container stopped between two observations', async () => {
    // The case a clamp-at-zero delta would get wrong, permanently: the last poll
    // saw a container that had in fact already stopped, so the final figure is
    // SMALLER than what the rollup already holds. Overstating a container that has
    // finished is the one direction a COGS meter must never drift.
    const fx = await seedTenant();
    const handleId = 'm-overshot';

    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 300 }),
    );
    const settled = await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 250,
      }),
    );

    expect(settled).toMatchObject({ accruedSecondsDelta: -50 });
    expect((await adminDb.ciContainerUsage.findFirstOrThrow()).billableSeconds).toBe(250);
    expect((await adminDb.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(250);
  });

  it('a REPLAYED checkpoint adds NOTHING — idempotent under checkpointing', async () => {
    // ⚠️ THE CASE THE ABSOLUTE-NOT-DELTA CONTRACT EXISTS FOR. Supervision runs as
    // durable Inngest steps, which RE-EXECUTE on replay, so this is the normal path
    // rather than an edge one. A delta-shaped report would double-count every
    // replayed poll — silently, and in the direction that overstates Motir's cost.
    const fx = await seedTenant();
    const handleId = 'm-replayed';
    const accrual = accrualFor(fx, { handleId, accruedSeconds: 120 });

    await ciFleetCostMeterService.recordContainerAccrual(accrual);
    const replay = await ciFleetCostMeterService.recordContainerAccrual(accrual);

    expect(replay).toMatchObject({ billableSeconds: 120, accruedSecondsDelta: 0 });
    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(120);
    expect(rollup.containerCount).toBe(1);
  });

  it('CONCURRENT checkpoints on one container cannot double-count it', async () => {
    // Mutation check on the lock (`notes.html` #35). Both callers read "what has
    // this container contributed?" and write the difference — remove the
    // `createIfAbsent` → `FOR UPDATE` ordering and both see no prior, both add their
    // whole figure, and one container reads as two.
    const fx = await seedTenant();
    const handleId = 'm-raced';

    await Promise.all([
      ciFleetCostMeterService.recordContainerAccrual(
        accrualFor(fx, { handleId, accruedSeconds: 200 }),
      ),
      ciFleetCostMeterService.recordContainerAccrual(
        accrualFor(fx, { handleId, accruedSeconds: 200 }),
      ),
    ]);

    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(200);
    expect(rollup.containerCount).toBe(1);
  });

  it('a LATE checkpoint on an already-settled container changes nothing', async () => {
    // The poll and the teardown race by construction — this is the normal outcome of
    // that race, and it is named as a late observation rather than an error. A
    // settled row is FINAL: re-opening it would make a finished container look live.
    const fx = await seedTenant();
    const handleId = 'm-late';
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 240,
      }),
    );

    const late = await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 9999 }),
    );

    expect(late).toEqual({
      outcome: 'already_settled',
      containerProvider: 'fake',
      handleId,
    });
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(240);
    expect(row.containerStoppedAt).not.toBeNull();
    expect((await adminDb.ciContainerPeriodCost.findFirstOrThrow()).containerSeconds).toBe(240);
  });

  it('a CRASHED container keeps its partial accrual — reconciled by the reaper, not duplicated', async () => {
    // The orchestrator died mid-run, so no settle ever came from the supervision
    // path; the reaper reaches the container later and settles the SAME handle. The
    // partial row must be completed, never joined by a second row for one container.
    const fx = await seedTenant();
    const handleId = 'm-crashed';

    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 400 }),
    );
    // The reaper's settle — a different teardown reason, the same container.
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 520,
        teardownReason: 'reaped',
      }),
    );

    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(520);
    expect(row.teardownReason).toBe('reaped');
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(520);
    expect(rollup.containerCount).toBe(1);
  });

  it('keeps the FIRST period when a container runs across a month boundary', async () => {
    // A container that accrued into August must reconcile INTO August, whatever
    // period its stop instant falls in — the rollup it was already added to is the
    // one the settle's delta has to reach. Re-bucketing would leave August's rollup
    // permanently overstating a container that finished, with no row pointing at why.
    const fx = await seedTenant();
    const handleId = 'm-straddling';
    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, {
        handleId,
        accruedSeconds: 600,
        observedAt: new Date('2026-08-31T23:50:00.000Z'),
      }),
    );

    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 1200,
        stoppedAt: new Date('2026-09-01T00:10:00.000Z'),
      }),
    );

    const rollups = await adminDb.ciContainerPeriodCost.findMany();
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ periodStart: AUGUST_2026, containerSeconds: 1200 });
    expect((await adminDb.ciContainerUsage.findFirstOrThrow()).periodStart).toEqual(AUGUST_2026);
  });

  it('carries money as DECIMAL through a checkpoint and its settle, never a float', async () => {
    // The rounding error is invisible per row and systematic across a month, which
    // is the shape a reconciliation is worst at catching — and a delta-based rollup
    // gives it two chances per container instead of one.
    const fx = await seedTenant();
    const handleId = 'm-decimal';
    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 100 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 240,
      }),
    );

    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    // 240 s × $0.000031636049, to the column's full 12 decimal places — the row and
    // the rollup agreeing EXACTLY is what a signed-delta rollup has to prove.
    expect(row.costUsd.toFixed(12)).toBe('0.007592651760');
    expect(rollup.costUsd.toFixed(12)).toBe('0.007592651760');
  });
});

describe('the CHECKPOINT seam the supervision loop actually calls (MOTIR-1995)', () => {
  it('`recordContainerAccrual` from the sink PERSISTS the partial row', async () => {
    // The sink is what the poll calls; the persist has to happen through THAT path,
    // not only through the service directly — the same argument the settle seam's
    // test makes one function over.
    const fx = await seedTenant();

    await recordContainerAccrual(accrualFor(fx, { accruedSeconds: 45 }));

    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.billableSeconds).toBe(45);
    expect(row.containerStoppedAt).toBeNull();
  });

  it('an UNPRICED checkpoint is recorded at zero AND logged — the earliest warning there is', async () => {
    // The unpriced case on the accrual path. It matters MORE here than at teardown:
    // this log line fires while the container is still running, so a rate row
    // someone forgot is noticed before the spend is sunk rather than after. A build
    // that only warned at teardown would report the gap once the money was gone.
    const fx = await seedTenant();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await recordContainerAccrual(
      accrualFor(fx, {
        accruedSeconds: 120,
        // A region no rate row covers, so `resolveContainerRate` returns null — the
        // real resolver, not a stubbed one.
        region: 'syd',
        usdPerSecond: '0',
        costUsd: '0',
        rateEffectiveFrom: null,
      }),
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no rate row covers this container'),
      // The instant the missing rate was looked for is the OBSERVATION, not a stop —
      // a running container has none, and reporting one would be a lie about when.
      expect.objectContaining({ region: 'syd', at: STOPPED_AT.toISOString() }),
    );
    const row = await adminDb.ciContainerUsage.findFirstOrThrow();
    expect(row.rateEffectiveFrom).toBeNull();
    expect(row.costUsd.toNumber()).toBe(0);
    // Distinguishable from a genuine zero-second row by the seconds beside it.
    expect(row.billableSeconds).toBe(120);
  });

  it('`buildContainerAccrual` prices a running container through the REAL rate table', async () => {
    // The record the seam consumes, built by production's own function rather than
    // hand-assembled — so the arithmetic under every assertion above is the shipped
    // arithmetic. `billableSecondsFor` is REUSED by it, which is what stops a
    // checkpoint and a settle computing the same span two ways.
    const startedAt = new Date(STOPPED_AT.getTime() - 150_000);
    const accrual = buildContainerAccrual({
      handle: { provider: 'fake', id: 'm-built', region: 'iad', createdAt: startedAt },
      attribution: {
        orgId: 'org',
        workspaceId: 'ws',
        projectId: 'proj',
        repoFullName: 'motir-projects/acme-web',
        workload: 'code_graph_index',
        workflowJobId: null,
        size: { cpuKind: 'performance', cpus: 2, memoryMb: 8192 },
        observedStartedAt: startedAt,
      },
      createdAt: startedAt,
      startedAt,
      observedAt: STOPPED_AT,
    });

    expect(accrual.accruedSeconds).toBe(150);
    expect(accrual.usdPerSecond).toBe(IAD_USD_PER_SECOND);
    expect(accrual.costUsd).toBe(costFor(150));
    expect(accrual.rateEffectiveFrom).not.toBeNull();
    // No stop instant exists on this shape at all — the type is what keeps a
    // checkpoint from ever claiming a container ended.
    expect('stoppedAt' in accrual).toBe(false);
  });

  it('an UNPRICED region resolves to a zero rate and a null effective-from', async () => {
    const startedAt = new Date(STOPPED_AT.getTime() - 60_000);
    const accrual = buildContainerAccrual({
      handle: { provider: 'fake', id: 'm-unpriced', region: 'syd', createdAt: startedAt },
      attribution: {
        orgId: 'org',
        workspaceId: 'ws',
        projectId: 'proj',
        repoFullName: 'motir-projects/acme-web',
        workload: 'code_graph_index',
        workflowJobId: null,
        size: { cpuKind: 'performance', cpus: 2, memoryMb: 8192 },
        observedStartedAt: startedAt,
      },
      createdAt: startedAt,
      startedAt,
      observedAt: STOPPED_AT,
    });

    // Under-reporting Motir's own cost is the safe direction — it never over-bills
    // anyone — and the null is what makes "cost unknown" distinguishable from zero.
    expect(accrual.usdPerSecond).toBe('0');
    expect(accrual.costUsd).toBe('0');
    expect(accrual.rateEffectiveFrom).toBeNull();
    expect(accrual.accruedSeconds).toBe(60);
  });
});

describe('ONE write path over the shared record (MOTIR-1995)', () => {
  it('locking an UNKNOWN handle reports nothing rather than inventing a prior', async () => {
    // The defensive branch in the write path. A delta derived from a row we cannot
    // see would be a guess, so the absence is reported as such — and the write is
    // skipped rather than made against an assumed zero.
    const state = await withSystemContext((tx) =>
      ciContainerUsageRepository.lockAccruedState('fake', 'm-never-existed', tx),
    );
    expect(state).toBeNull();
  });

  it('the removed pre-check is really gone — no unlocked read of the same row', async () => {
    // MOTIR-1924's `findByHandle` was an unlocked read of exactly the value the
    // delta is derived from, and it was documented as "NOT the correctness guard".
    // With the lock doing that read on every write it saves nothing and can only
    // tempt a caller into answering the one question that needs the lock.
    expect('findByHandle' in ciContainerUsageRepository).toBe(false);
  });

  it('the repository exposes NO second writer that could reach the record unlocked', async () => {
    // ⚠️ THE TEST THE CARD ASKS FOR: "one write path, proven by a test that fails if
    // a second meter writes the same record." MOTIR-1924's settle-time `create` was
    // REMOVED rather than left beside the accrual path — an unlocked insert that
    // skips the delta arithmetic is exactly how the rollup and the rows would drift
    // apart, and a writer that exists will eventually be called.
    expect('create' in ciContainerUsageRepository).toBe(false);
    // What remains is the three-op sequence, in the order the lock argument needs.
    expect(typeof ciContainerUsageRepository.createIfAbsent).toBe('function');
    expect(typeof ciContainerUsageRepository.lockAccruedState).toBe('function');
    expect(typeof ciContainerUsageRepository.accrue).toBe('function');
  });

  it('both seams land on ONE row and ONE rollup for one container', async () => {
    // The settle and the checkpoint are two entry points, not two records.
    const fx = await seedTenant();
    const handleId = 'm-single';
    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 50 }),
    );
    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, { handleId, accruedSeconds: 80 }),
    );
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId,
        workload: 'code_graph_index',
        workflowJobId: null,
        billableSeconds: 95,
      }),
    );

    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    const ciContainerPeriodCostCount = await adminDb.ciContainerPeriodCost.count();
    expect(ciContainerPeriodCostCount).toBe(1);
    const rollup = await adminDb.ciContainerPeriodCost.findFirstOrThrow();
    expect(rollup.containerSeconds).toBe(95);
    expect(rollup.containerCount).toBe(1);
    expect(rollup.workload).toBe('index');
  });
});

describe('the margin readout', () => {
  it('answers cost per org per period from the ROLLUP, in one read', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx, { billableSeconds: 600 }));

    const cost = await ciFleetCostMeterService.getOrgPeriodCost(
      fx.organizationId,
      STOPPED_AT,
      'ci',
    );

    expect(cost).toMatchObject({
      organizationId: fx.organizationId,
      periodStart: AUGUST_2026,
      containerSeconds: 600,
      containerCount: 1,
    });
    expect(Number(cost.costUsd)).toBeCloseTo(600 * Number(IAD_USD_PER_SECOND), 12);
  });

  it('derives margin against the metered ×1.00 minutes from STORED values only', async () => {
    // The acceptance in one test: both halves are rollup rows read by the same
    // key, so this is a subtraction over stored state — never a recomputation
    // from logs or a scan of per-run history.
    const fx = await seedTenant();
    // 10 metered Linux-equivalent minutes for the org (the customer's side).
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: fx.workspaceId,
          organizationId: fx.organizationId,
          periodStart: AUGUST_2026,
          billableMinutes: 10,
          rawWallClockSeconds: 600,
          linearEquivalentMinutes: 10,
        },
        tx,
      ),
    );
    // 600 container-seconds serving them (Motir's side).
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx, { billableSeconds: 600 }));

    const basis = await ciFleetCostMeterService.getOrgPeriodCostBasis(
      fx.organizationId,
      STOPPED_AT,
    );

    expect(basis).toMatchObject({
      organizationId: fx.organizationId,
      periodStart: AUGUST_2026,
      containerSeconds: 600,
      containerCount: 1,
      linearEquivalentMinutes: 10,
    });
    // $0.0189816 over 10 metered minutes ≈ $0.0019/min — which is what makes
    // §M's `usdPerMinute: 0.001` ESTIMATE checkable at last, and the reason this
    // number had to become a measurement.
    expect(Number(basis.costPerLinearEquivalentMinute)).toBeCloseTo(
      (600 * Number(IAD_USD_PER_SECOND)) / 10,
      12,
    );
  });

  it('reports a NULL ratio rather than dividing by zero when nothing was metered', async () => {
    const fx = await seedTenant();
    await ciFleetCostMeterService.recordContainerUsage(usageFor(fx));

    const basis = await ciFleetCostMeterService.getOrgPeriodCostBasis(
      fx.organizationId,
      STOPPED_AT,
    );

    expect(basis.linearEquivalentMinutes).toBe(0);
    expect(basis.costPerLinearEquivalentMinute).toBeNull();
    expect(basis.containerSeconds).toBe(240);
  });

  it('returns zeros for an org with no fleet activity — total, never null', async () => {
    const fx = await seedTenant();
    const cost = await ciFleetCostMeterService.getOrgPeriodCost(
      fx.organizationId,
      STOPPED_AT,
      'ci',
    );
    expect(cost).toMatchObject({ containerSeconds: 0, containerCount: 0, costUsd: '0' });
  });
});

describe('the seam the orchestrator actually calls', () => {
  it('`recordContainerUsage` from the sink PERSISTS the row', async () => {
    // The sink is what the teardown `finally` and the reaper call; the persist
    // has to happen through THAT path, not only through the service directly.
    const fx = await seedTenant();
    const usage = usageFor(fx);

    await recordContainerUsage(usage);

    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(1);
    expect((await adminDb.ciContainerUsage.findFirstOrThrow()).handleId).toBe(usage.handleId);
  });

  it('NEVER THROWS through the sink when the persist fails', async () => {
    // A sink failure propagating out of the teardown `finally` would turn "the
    // container is gone and we could not record it" into "the container may
    // still be running" — a billing leak traded for a bookkeeping gap.
    const fx = await seedTenant();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // An org id no row exists for: the FK refuses the insert, deep inside the
    // service, exactly as a real referential failure would.
    const usage = usageFor(fx, { orgId: 'org_does_not_exist' });

    await expect(recordContainerUsage(usage)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[containerUsage] could not record a container-seconds row',
      expect.objectContaining({ handleId: usage.handleId }),
    );
    const ciContainerUsageCount = await adminDb.ciContainerUsage.count();
    expect(ciContainerUsageCount).toBe(0);
  });
});

describe('ATTRIBUTION when ONE handle serves MANY repos (MOTIR-3255)', () => {
  // The warm sync worker (`code-graph-index-fleet.md` §16) is one machine, one
  // ORG, many repos over its life. `ci_container_usage` carries one project and
  // one repo per handle, so a worker's row cannot say which project's syncs it
  // performed — the exact unanswerable-cost failure MOTIR-1995 was filed over,
  // reached through an attribution hole instead of a missing route.
  //
  // What is asserted here is the arithmetic that makes the two levels honest:
  // the handle row still owns the TOTAL and still feeds the rollup, and the
  // slices divide that same total exactly, idle included.

  /** A second project in the SAME org — a worker serves one org's repos. */
  async function secondProject(fx: Fixture): Promise<{ projectId: string; repoFullName: string }> {
    const membership = await adminDb.workspaceMembership.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: membership.userId,
      name: `Other ${randomToken(4)}`,
      identifier: `B${randomInt(100, 1000)}`,
    });
    expect(other.id).not.toBe(fx.projectId);
    return { projectId: other.id, repoFullName: 'motir-projects/acme-api' };
  }

  async function slicesFor(handleId: string) {
    return withSystemContext((tx) =>
      ciContainerUsageSliceRepository.listForHandle('fake', handleId, tx),
    );
  }

  it('divides the handle EXACTLY — Σ slices = the handle figure, idle included', async () => {
    // THE CENTRAL CLAIM. Everything else about this record is bookkeeping; if the
    // parts do not add up to the whole, the rollup and the per-project read are
    // two different answers to one question, which is the outcome the card
    // forbids in as many words.
    const fx = await seedTenant();
    const other = await secondProject(fx);
    const accrual = accrualFor(fx, {
      accruedSeconds: 300,
      costUsd: costFor(300),
      // The worker names no repo of its own: it served an ORG.
      repoFullName: null,
      slices: [
        { sliceRef: 'run-a', projectId: fx.projectId, repoFullName: fx.repoFullName, seconds: 120 },
        {
          sliceRef: 'run-b',
          projectId: other.projectId,
          repoFullName: other.repoFullName,
          seconds: 60,
        },
      ],
    });

    const result = await ciFleetCostMeterService.recordContainerAccrual(accrual);
    expect(result.outcome).toBe('accrued');
    if (result.outcome !== 'accrued') return;
    expect(result.attributedSeconds).toBe(180);
    expect(result.idleSeconds).toBe(120);

    const slices = await slicesFor(accrual.handleId);
    expect(slices.reduce((total, slice) => total + slice.seconds, 0)).toBe(300);
    expect(slices.map((s) => [s.kind, s.projectId, s.seconds])).toEqual([
      ['idle', null, 120],
      ['work', fx.projectId, 120],
      ['work', other.projectId, 60],
    ]);

    // …and the money divides with it, from the SAME rate the handle was costed at.
    expect(slices.map((s) => s.costUsd)).toEqual([costFor(120), costFor(120), costFor(60)]);

    // The handle row is unchanged in kind: it still owns the lifetime, and it is
    // still what the rollup counts. Slices are a finer read, never a second total.
    const row = await withSystemContext((tx) =>
      ciContainerUsageRepository.lockAccruedState('fake', accrual.handleId, tx),
    );
    expect(row?.billableSeconds).toBe(300);
  });

  it('gives IDLE to the ORG — a null project, on its own row, derived not reported', async () => {
    // "Idle is a real cost and it belongs to somebody — decide to whom, and write
    // it down." It belongs to the org: a machine waiting for work is costing money
    // on nobody's behalf in particular. Spreading it across the projects it
    // happened to serve would invent an attribution nobody measured.
    const fx = await seedTenant();
    const accrual = accrualFor(fx, {
      accruedSeconds: 200,
      costUsd: costFor(200),
      repoFullName: null,
      slices: [
        { sliceRef: 'run-a', projectId: fx.projectId, repoFullName: fx.repoFullName, seconds: 50 },
      ],
    });

    await ciFleetCostMeterService.recordContainerAccrual(accrual);
    const idle = (await slicesFor(accrual.handleId)).find((s) => s.kind === 'idle');
    expect(idle).toBeDefined();
    expect(idle?.projectId).toBeNull();
    expect(idle?.repoFullName).toBeNull();
    expect(idle?.seconds).toBe(150);

    // DERIVED, not reported: the port has no shape for an idle slice, so a
    // container cannot report one — which is what makes the sum hold by
    // construction rather than by trusting a caller to subtract.
    expect(idle?.sliceRef).toBe(IDLE_SLICE_REF);
  });

  it('RECONCILES across checkpoints — idle shrinks as work is attributed', async () => {
    // A worker checkpoints while it runs. Each observation states absolute totals,
    // so idle is re-derived every time rather than accumulated — and the sum holds
    // at every intermediate state, not only at the end.
    const fx = await seedTenant();
    const other = await secondProject(fx);
    const handleId = `m-${randomToken(8)}`;

    const first = await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, {
        handleId,
        accruedSeconds: 100,
        costUsd: costFor(100),
        repoFullName: null,
        slices: [
          {
            sliceRef: 'run-a',
            projectId: fx.projectId,
            repoFullName: fx.repoFullName,
            seconds: 40,
          },
        ],
      }),
    );
    expect(first.outcome === 'accrued' && first.idleSeconds).toBe(60);

    // A LATER checkpoint: the handle has lived longer and served a second repo.
    // `run-a` is not repeated — an earlier checkpoint already attributed it, and
    // the writer reads the sum back from the table rather than from this call.
    const second = await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, {
        handleId,
        accruedSeconds: 260,
        costUsd: costFor(260),
        repoFullName: null,
        slices: [
          {
            sliceRef: 'run-b',
            projectId: other.projectId,
            repoFullName: other.repoFullName,
            seconds: 90,
          },
        ],
      }),
    );
    expect(second.outcome === 'accrued' && second.attributedSeconds).toBe(130);
    expect(second.outcome === 'accrued' && second.idleSeconds).toBe(130);

    const slices = await slicesFor(handleId);
    expect(slices.reduce((total, s) => total + s.seconds, 0)).toBe(260);
  });

  it('is IDEMPOTENT under replay — a repeated checkpoint changes no slice', async () => {
    // Supervision runs as durable steps that re-execute on replay. A slice write
    // states the slice's TOTAL and upserts on its ref, so a replay rewrites the
    // same number rather than adding a second row.
    const fx = await seedTenant();
    const accrual = accrualFor(fx, {
      accruedSeconds: 150,
      costUsd: costFor(150),
      repoFullName: null,
      slices: [
        { sliceRef: 'run-a', projectId: fx.projectId, repoFullName: fx.repoFullName, seconds: 70 },
      ],
    });

    await ciFleetCostMeterService.recordContainerAccrual(accrual);
    await ciFleetCostMeterService.recordContainerAccrual(accrual);

    const slices = await slicesFor(accrual.handleId);
    expect(slices).toHaveLength(2); // one work, one idle — not four
    expect(slices.reduce((total, s) => total + s.seconds, 0)).toBe(150);
  });

  it('answers "what did this cost project X" — the read MOTIR-1995 demanded stays answerable', async () => {
    const fx = await seedTenant();
    const other = await secondProject(fx);
    const accrual = accrualFor(fx, {
      accruedSeconds: 300,
      costUsd: costFor(300),
      repoFullName: null,
      slices: [
        { sliceRef: 'run-a', projectId: fx.projectId, repoFullName: fx.repoFullName, seconds: 200 },
        {
          sliceRef: 'run-b',
          projectId: other.projectId,
          repoFullName: other.repoFullName,
          seconds: 40,
        },
      ],
    });
    await ciFleetCostMeterService.recordContainerAccrual(accrual);

    const byProject = await withSystemContext((tx) =>
      ciContainerUsageSliceRepository.sumByProjectForOrgPeriod(
        fx.organizationId,
        periodStartFor(accrual.observedAt),
        tx,
      ),
    );
    const seconds = new Map(byProject.map((row) => [row.projectId, row.seconds]));
    expect(seconds.get(fx.projectId)).toBe(200);
    expect(seconds.get(other.projectId)).toBe(40);
    // The org's own line — idle — is RETURNED rather than filtered out, or a
    // reader would find the project totals mysteriously short of the rollup.
    expect(seconds.get(null)).toBe(60);
  });

  it('writes NOTHING for a one-repo handle — no empty set, no whole-lifetime idle row', async () => {
    // Every workload shipping today is one container, one repo, and its row already
    // attributes its whole figure exactly. A slice table that also held those rows
    // would be a second place to read the same fact.
    const fx = await seedTenant();
    const usage = usageFor(fx);
    await ciFleetCostMeterService.recordContainerUsage(usage);
    expect(await slicesFor(usage.handleId)).toEqual([]);
  });

  it('SAYS SO when a handle claims more work than it lived, and still records both', async () => {
    // A reporting bug, not a shape. Idle floors at zero so the row cannot go
    // negative, the slices are kept because what was reported is the evidence, and
    // the discrepancy is logged rather than silently clamped away.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fx = await seedTenant();
    const accrual = accrualFor(fx, {
      accruedSeconds: 60,
      costUsd: costFor(60),
      repoFullName: null,
      slices: [
        { sliceRef: 'run-a', projectId: fx.projectId, repoFullName: fx.repoFullName, seconds: 500 },
      ],
    });

    const result = await ciFleetCostMeterService.recordContainerAccrual(accrual);
    expect(result.outcome === 'accrued' && result.idleSeconds).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('more work than it lived'));

    const slices = await slicesFor(accrual.handleId);
    expect(slices.find((s) => s.kind === 'work')?.seconds).toBe(500);
    warn.mockRestore();
  });

  it('meters a META org identically — slices and all', async () => {
    // `isMeta` is a BILLING flag, and this meter charges nobody. Read every
    // `isMeta` branch as "should this be un-CHARGED?", never "un-MEASURED?".
    const fx = await seedTenant({ isMeta: true });
    const accrual = accrualFor(fx, {
      accruedSeconds: 120,
      costUsd: costFor(120),
      repoFullName: null,
      slices: [
        { sliceRef: 'run-a', projectId: fx.projectId, repoFullName: fx.repoFullName, seconds: 30 },
      ],
    });
    await ciFleetCostMeterService.recordContainerAccrual(accrual);

    const slices = await slicesFor(accrual.handleId);
    expect(slices.reduce((total, s) => total + s.seconds, 0)).toBe(120);
    expect(slices.find((s) => s.kind === 'idle')?.seconds).toBe(90);
  });

  it('touches NO credit ledger, balance or user-facing surface', async () => {
    // The boundary this meter is emphatic about, re-asserted for the new writes:
    // slices are COGS telemetry and nothing else.
    const fx = await seedTenant();
    const chargesBefore = await adminDb.ciPeriodCharge.count();
    const usageBefore = await adminDb.ciPeriodUsage.count();
    await ciFleetCostMeterService.recordContainerAccrual(
      accrualFor(fx, {
        accruedSeconds: 90,
        costUsd: costFor(90),
        repoFullName: null,
        slices: [
          {
            sliceRef: 'run-a',
            projectId: fx.projectId,
            repoFullName: fx.repoFullName,
            seconds: 30,
          },
        ],
      }),
    );
    // `ci_period_charge` is the entitlement half's only durable state and
    // `ci_period_usage` is the customer-facing meter; the credit ledger itself
    // lives in motir-ai, which this process cannot reach at all. Untouched.
    expect(await adminDb.ciPeriodCharge.count()).toBe(chargesBefore);
    expect(await adminDb.ciPeriodUsage.count()).toBe(usageBefore);
  });
});

describe('repairing an index row its settle never closed (MOTIR-8913)', () => {
  const NOW = new Date('2026-08-20T12:00:00.000Z');

  /** A checkpoint row for an index container created `ageMs` before NOW — the
   *  state a lost settle write leaves behind. */
  async function seedCheckpoint(fx: Fixture, ageMs: number, accruedSeconds = 90) {
    const observedAt = new Date(NOW.getTime() - ageMs + accruedSeconds * 1000);
    const accrual = accrualFor(fx, { accruedSeconds, observedAt });
    await ciFleetCostMeterService.recordContainerAccrual(accrual);
    // `created_at` is the row's own default (now), so age it the way production did.
    await adminDb.ciContainerUsage.update({
      where: {
        containerProvider_handleId: { containerProvider: 'fake', handleId: accrual.handleId },
      },
      data: { createdAt: new Date(NOW.getTime() - ageMs) },
    });
    return accrual;
  }

  const rowFor = (handleId: string) =>
    adminDb.ciContainerUsage.findUniqueOrThrow({
      where: { containerProvider_handleId: { containerProvider: 'fake', handleId } },
    });

  it('settles an old unsettled index row from its own figures and leaves the rollup alone', async () => {
    const fx = await seedTenant();
    const accrual = await seedCheckpoint(fx, 3 * 60 * 60_000);
    const before = await ciFleetCostMeterService.getOrgPeriodCost(
      fx.organizationId,
      accrual.observedAt,
      'index',
    );

    const result = await ciFleetCostMeterService.settleStrandedIndexUsage({ now: () => NOW });

    expect(result).toEqual({
      scanned: 1,
      settled: 1,
      repaired: [{ containerProvider: 'fake', handleId: accrual.handleId }],
    });
    const row = await rowFor(accrual.handleId);
    expect(row.terminalState).toBe('repaired');
    expect(row.teardownReason).toBe('reaped');
    expect(row.containerStoppedAt).toEqual(
      new Date(accrual.startedAt.getTime() + accrual.accruedSeconds * 1000),
    );
    expect(row.billableSeconds).toBe(accrual.accruedSeconds);
    const after = await ciFleetCostMeterService.getOrgPeriodCost(
      fx.organizationId,
      accrual.observedAt,
      'index',
    );
    expect(after).toEqual(before);
  });

  it('leaves a young row alone — its container may still be running', async () => {
    const fx = await seedTenant();
    const accrual = await seedCheckpoint(fx, 10 * 60_000);

    const result = await ciFleetCostMeterService.settleStrandedIndexUsage({ now: () => NOW });

    expect(result).toEqual({ scanned: 0, settled: 0, repaired: [] });
    expect((await rowFor(accrual.handleId)).containerStoppedAt).toBeNull();
  });

  it('is idempotent, and never touches a row that settled for real', async () => {
    const fx = await seedTenant();
    const stranded = await seedCheckpoint(fx, 3 * 60 * 60_000);
    const real = await seedCheckpoint(fx, 3 * 60 * 60_000);
    await ciFleetCostMeterService.recordContainerUsage(
      usageFor(fx, {
        handleId: real.handleId,
        workload: 'code_graph_index',
        billableSeconds: real.accruedSeconds,
        startedAt: real.startedAt,
        createdAt: real.createdAt,
      }),
    );

    const first = await ciFleetCostMeterService.settleStrandedIndexUsage({ now: () => NOW });
    const second = await ciFleetCostMeterService.settleStrandedIndexUsage({ now: () => NOW });

    expect(first).toEqual({
      scanned: 1,
      settled: 1,
      repaired: [{ containerProvider: 'fake', handleId: stranded.handleId }],
    });
    expect(second).toEqual({ scanned: 0, settled: 0, repaired: [] });
    expect((await rowFor(stranded.handleId)).terminalState).toBe('repaired');
    expect((await rowFor(real.handleId)).terminalState).toBe('destroyed');
  });
});

describe('reporting a repaired index row to the platform meter (MOTIR-10822)', () => {
  // The repair writes the row directly, never through the usage sink that
  // `withPlatformMeterReport` wraps, so before this card a repaired row was never
  // reported and motir-ai's platform rollup missed it for good. The sweep's tick
  // now enqueues one `system.platform-meter-report` per row it settled, after the
  // repair commits. The events are real `job_event` rows, read back here.
  const NOW = new Date('2026-08-20T12:00:00.000Z');
  const STRANDED_AGE_MS = 3 * 60 * 60_000;

  beforeEach(async () => {
    await truncateJobRuns();
  });

  afterEach(async () => {
    await truncateJobRuns();
  });

  async function seedStranded(fx: Fixture, ageMs = STRANDED_AGE_MS): Promise<ContainerAccrual> {
    const accrual = accrualFor(fx, {
      accruedSeconds: 90,
      observedAt: new Date(NOW.getTime() - ageMs + 90_000),
    });
    await ciFleetCostMeterService.recordContainerAccrual(accrual);
    await adminDb.ciContainerUsage.update({
      where: {
        containerProvider_handleId: { containerProvider: 'fake', handleId: accrual.handleId },
      },
      data: { createdAt: new Date(NOW.getTime() - ageMs) },
    });
    return accrual;
  }

  const meterReports = () =>
    adminDb.jobEvent.findMany({ where: { name: 'system.platform-meter-report' } });

  it('enqueues exactly one report for a row it settles, after the settle commits', async () => {
    const fx = await seedTenant();
    const accrual = await seedStranded(fx);
    // What a SEPARATE connection sees at the moment of the enqueue: only a
    // committed settle is visible to it, so an enqueue from inside the repair's
    // transaction would read the row still unsettled.
    const seenAtEnqueue: Array<string | null> = [];
    const original = platformMeterReportEnqueue.container.bind(platformMeterReportEnqueue);
    const enqueue = vi
      .spyOn(platformMeterReportEnqueue, 'container')
      .mockImplementation(async (provider, handleId) => {
        const row = await adminDb.ciContainerUsage.findUniqueOrThrow({
          where: { containerProvider_handleId: { containerProvider: provider, handleId } },
        });
        seenAtEnqueue.push(row.terminalState);
        await original(provider, handleId);
      });

    const result = await supervisionSweepService.repairStrandedUsage({ now: () => NOW });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('fake', accrual.handleId);
    expect(seenAtEnqueue).toEqual(['repaired']);
    const events = await meterReports();
    expect(events.map((e) => e.data)).toEqual([
      { containerProvider: 'fake', handleId: accrual.handleId },
    ]);
  });

  it('reports each row of a tick once, and a second tick reports nothing more', async () => {
    const fx = await seedTenant();
    const a = await seedStranded(fx);
    const b = await seedStranded(fx);

    await supervisionSweepService.repairStrandedUsage({ now: () => NOW });
    const second = await supervisionSweepService.repairStrandedUsage({ now: () => NOW });

    expect(second).toEqual({ scanned: 0, settled: 0 });
    const handles = (await meterReports()).map((e) => (e.data as { handleId: string }).handleId);
    expect(handles.sort()).toEqual([a.handleId, b.handleId].sort());
  });

  it('enqueues nothing for a row the repair skips — it raced the real settle', async () => {
    const fx = await seedTenant();
    const accrual = await seedStranded(fx);
    // THE RACE, run for real: the row's own settle commits on another connection
    // after the repair has listed it and before the repair writes it, so
    // `settleStranded` finds `container_stopped_at` set and answers 0. That settle
    // goes through the usage sink, which reports the row itself.
    const list = ciContainerUsageRepository.listStrandedIndexUsage.bind(ciContainerUsageRepository);
    vi.spyOn(ciContainerUsageRepository, 'listStrandedIndexUsage').mockImplementation(
      async (...args) => {
        const rows = await list(...args);
        await ciFleetCostMeterService.recordContainerUsage(
          usageFor(fx, {
            handleId: accrual.handleId,
            workload: 'code_graph_index',
            billableSeconds: accrual.accruedSeconds,
            startedAt: accrual.startedAt,
            createdAt: accrual.createdAt,
          }),
        );
        return rows;
      },
    );
    const enqueue = vi.spyOn(platformMeterReportEnqueue, 'container');

    const result = await supervisionSweepService.repairStrandedUsage({ now: () => NOW });

    expect(result).toEqual({ scanned: 1, settled: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(await meterReports()).toEqual([]);
    expect(
      (
        await adminDb.ciContainerUsage.findUniqueOrThrow({
          where: {
            containerProvider_handleId: { containerProvider: 'fake', handleId: accrual.handleId },
          },
        })
      ).terminalState,
    ).toBe('destroyed');
  });

  it('enqueues nothing when no row is stranded', async () => {
    const fx = await seedTenant();
    await seedStranded(fx, 10 * 60_000);
    const enqueue = vi.spyOn(platformMeterReportEnqueue, 'container');

    const result = await supervisionSweepService.repairStrandedUsage({ now: () => NOW });

    expect(result).toEqual({ scanned: 0, settled: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(await meterReports()).toEqual([]);
  });
});
