import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import * as orchestratorPackage from '@motir/orchestrator';
import { createUsageSink, type ContainerUsage, type UsageMeter } from '@motir/orchestrator';
import { recordContainerAccrual, recordContainerUsage } from '@/lib/orchestrator';
import { containerWorkloadFor } from '@/lib/ciFleet/workloads';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken, randomInt } from '../helpers/random';

// THE COMPOSITION ROOT'S BINDING, against real Postgres (Story MOTIR-4292 ·
// MOTIR-4300) — the seam MOTIR-4299 created and the one its unit tests
// deliberately cannot reach.
//
// `packages/orchestrator/test/usageSink.test.ts` proves the sink's CONTRACTS
// against a stub meter: it never throws, and it warns on an unpriced row. Those
// assertions became writeable BECAUSE the meter is a port. What a stub can never
// answer is the question this file exists for:
//
//   **is the port actually bound to the real service, and does a record written
//   through `@/lib/orchestrator` reach the table?**
//
// That is one line of composition — `createUsageSink(ciFleetCostMeterService)` —
// and it is exactly the kind of line an extraction gets wrong silently: bind
// nothing, or bind a second sink, and every unit test stays green while the
// fleet's cost record goes nowhere. `ci-runner-fleet.md` §5's invariant is "for
// every provisioned handle, exactly one usage row", and the only place that can
// be observed is here, with the real meter and the real table.
//
// ⚠️ IT ASSERTS THE BINDING, NOT THE METER. `tests/ciFleet/ciFleetCostMeterService.test.ts`
// owns the meter's behaviour — idempotency, attribution, the rollup, the
// off-cloud bypass — and this file must not re-litigate any of it. One row
// reaching one table through the composition root is the whole claim.

const PASSWORD = 'hunter2hunter2';
const STOPPED_AT = new Date('2026-08-15T12:00:00.000Z');
const IAD_USD_PER_SECOND = '0.000031636049';

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    // Same order as the suite next door: opposite orders on shared tables
    // deadlock (40P01, MOTIR-3066).
    'TRUNCATE TABLE "ci_period_usage", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  vi.stubEnv('MOTIR_CLOUD', 'true');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedTenant(): Promise<Fixture> {
  const email = `usage-seam-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `S${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

function usageFor(fx: Fixture, handleId: string): ContainerUsage {
  return {
    handleId,
    provider: 'fake',
    region: 'iad',
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName: 'motir-projects/acme-web',
    workload: 'ci_runner',
    workflowJobId: 44001,
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 8192,
    createdAt: new Date(STOPPED_AT.getTime() - 300_000),
    startedAt: new Date(STOPPED_AT.getTime() - 240_000),
    stoppedAt: STOPPED_AT,
    billableSeconds: 240,
    usdPerSecond: IAD_USD_PER_SECOND,
    costUsd: '0.00759265176',
    rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    terminalState: 'destroyed',
    teardownReason: 'job_completed',
  };
}

describe('the composition root binds the package’s UsageMeter port to the real service', () => {
  it('a record written through `@/lib/orchestrator` reaches `ci_container_usage`', async () => {
    const fx = await seedTenant();
    const handleId = `m-${randomToken(8)}`;

    await recordContainerUsage(usageFor(fx, handleId));

    // Read back as the OWNER, the way the suite next door does: this file is
    // asserting that a row exists, not that a policy let somebody see it.
    const row = await adminDb.ciContainerUsage.findFirst({ where: { handleId } });
    expect(row, 'the sink is bound to nothing if this is null').not.toBeNull();
    expect(row?.workspaceId).toBe(fx.workspaceId);
    expect(row?.projectId).toBe(fx.projectId);
    expect(Number(row?.billableSeconds)).toBe(240);
  });

  it('the CHECKPOINT seam is bound too, and to the meter’s OTHER method', async () => {
    // Two methods, two bindings. Binding one and forgetting the other is the
    // shape a single-assertion seam test misses, and the accrual is the seam a
    // long-running Epic 9 container depends on (MOTIR-1995).
    const fx = await seedTenant();
    const handleId = `m-${randomToken(8)}`;

    await recordContainerAccrual({
      handleId,
      provider: 'fake',
      region: 'iad',
      orgId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoFullName: 'motir-projects/acme-web',
      workload: 'agent_instance',
      workflowJobId: null,
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 8192,
      createdAt: new Date(STOPPED_AT.getTime() - 300_000),
      startedAt: new Date(STOPPED_AT.getTime() - 90_000),
      observedAt: STOPPED_AT,
      accruedSeconds: 90,
      usdPerSecond: IAD_USD_PER_SECOND,
      costUsd: '0.00284724441',
      rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    });

    const row = await adminDb.ciContainerUsage.findFirst({ where: { handleId } });
    expect(row, 'the accrual seam is bound to nothing if this is null').not.toBeNull();
    // The COLUMN's vocabulary is the app registry's, not the port's: the port
    // says `agent_instance` and `containerWorkloadFor` maps it to the stored
    // value. Asserting through the mapper rather than through a literal is what
    // keeps this a test of the BINDING rather than of the enum.
    expect(row?.workload).toBe(containerWorkloadFor('agent_instance'));
    expect(Number(row?.billableSeconds)).toBe(90);
  });

  it('the PACKAGE exports the factory and NOT a bound sink — the binding cannot be bypassed', () => {
    // The boundary, asserted from the other side. If `@motir/orchestrator` ever
    // exported a ready-made `recordContainerUsage`, a caller could import one
    // that is bound to nothing and every test above would still pass — the
    // record would simply go nowhere for that caller. The package exposes the
    // FACTORY; the app owns the binding.
    expect(typeof createUsageSink).toBe('function');
    expect(
      'recordContainerUsage' in orchestratorPackage,
      'the package must not export a pre-bound sink',
    ).toBe(false);
    expect('recordContainerAccrual' in orchestratorPackage).toBe(false);
  });

  it('the sink the factory returns is the one the app re-exports — same shape, both methods', () => {
    // A cheap structural check that the composition root did not export, say,
    // the settle twice. Both names exist, both are functions, and they are not
    // the same function.
    const meter: UsageMeter = {
      async recordContainerUsage() {
        return undefined;
      },
      async recordContainerAccrual() {
        return undefined;
      },
    };
    const sink = createUsageSink(meter);
    expect(Object.keys(sink).sort()).toEqual(['recordContainerAccrual', 'recordContainerUsage']);
    expect(typeof recordContainerUsage).toBe('function');
    expect(typeof recordContainerAccrual).toBe('function');
    expect(recordContainerUsage).not.toBe(recordContainerAccrual);
  });
});
