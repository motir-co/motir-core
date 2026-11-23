import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import {
  CONTAINER_WORKLOAD_BY_FLEET_KIND,
  FLEET_WORKLOAD_KINDS,
  type FleetWorkloadKind,
} from '@/lib/ciFleet/workloads';
import * as workspaceContext from '@/lib/workspaces/context';
import type { ContainerUsage } from '@motir/orchestrator';
import { buildFleetCostReadout } from '../../scripts/fleetCostReadoutQuery';
import { renderReadout } from '../../scripts/fleetCostReadout';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// THE STORY'S VITEST GATE (MOTIR-4544 · Story MOTIR-4335) — the guarantees a
// coverage percentage cannot see, for the fleet-cost READ path.
//
// ⚠️ THE LANE, READ BEFORE A LINE WAS WRITTEN (AC 7). This file joins the main
// vitest lane (`vitest.config.ts`): `tests/setup/globalDb.ts` clones the migrated
// base into one database per worker, `perWorkerDb` rebinds `DATABASE_URL` to it,
// and `MOTIR_CLOUD` is stubbed per test because the meter and the readout are
// cloud-only. It is NOT in the structural-guard lane (`vitest.guards.config.ts`),
// which mounts no database — the seam and the no-writes guard need one, and a
// guard in a lane that cannot reach the asserted state passes on unfixed code.
//
// ⚠️ WHAT THIS CANNOT ASSERT: the credit ledger is motir-ai's. "No balance moved"
// is not assertable from here without asserting this repo's own harness; the
// honest in-repo form is that the read path WRITES NOTHING and IMPORTS NO billing,
// entitlement or credit module (below). Internal COGS only; nothing is a charge.

const PASSWORD = 'hunter2hunter2';
const STOPPED_AT = new Date('2026-08-15T12:00:00.000Z');
/** A cost whose decimal expansion a float CHANGES: `Number()` of it prints
 *  `12345678.123456789`, dropping the trailing `012`. It fits the rollup's
 *  `Decimal(20, 12)` exactly, so the database keeps every digit. */
const UNFLOATABLE_COST = '12345678.123456789012';

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_period_usage", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
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

async function seedOrg(options: { isMeta?: boolean } = {}): Promise<Fixture> {
  const email = `fleet-gate-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `G${randomInt(100, 1000)}`,
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
  };
}

/** One settled container, written through the REAL meter writer. */
async function recordContainer(
  fx: Fixture,
  workload: FleetWorkloadKind,
  billableSeconds: number,
  costUsd: string,
) {
  const usage: ContainerUsage = {
    handleId: `m-${randomToken(8)}`,
    provider: 'fake',
    region: 'iad',
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName: 'motir-projects/acme-web',
    workload,
    workflowJobId: workload === 'ci_runner' ? 44001 : null,
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 4096,
    createdAt: new Date(STOPPED_AT.getTime() - 600_000),
    startedAt: new Date(STOPPED_AT.getTime() - billableSeconds * 1000),
    stoppedAt: STOPPED_AT,
    billableSeconds,
    usdPerSecond: '0.000031636049',
    costUsd,
    rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    terminalState: 'destroyed',
    teardownReason: 'job_completed',
  };
  expect((await ciFleetCostMeterService.recordContainerUsage(usage)).outcome).toBe('recorded');
}

/** The printed row for a line, found by its own four fields — the renderer pads
 *  columns, so the fields are matched in order with whitespace between. */
function printedRow(
  text: string,
  line: { workload: string; containerCount: number; containerSeconds: number; costUsd: string },
) {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^\\s+${escape(line.workload)}\\s+${line.containerCount}\\s+${line.containerSeconds}\\s+${escape(line.costUsd)}$`,
    'm',
  ).test(text);
}

describe('the INTEGRATION SEAM — the real rollup through the real formatter (AC 2)', () => {
  it('renders exactly the fields the service returns, for a META and a TENANT org in one period', async () => {
    const tenant = await seedOrg();
    const meta = await seedOrg({ isMeta: true });
    await recordContainer(tenant, 'agent_instance', 1840, '0.058210330160');
    await recordContainer(tenant, 'ci_runner', 240, '0.007592651760');
    await recordContainer(meta, 'agent_instance', 3600, '0.113889776400');

    const readout = await buildFleetCostReadout({
      organizationId: tenant.organizationId,
      at: STOPPED_AT,
    });
    if (!readout.input?.org) throw new Error('expected an enabled readout with an org section');

    // What the readout rendered IS the service's return value — not a copy shaped like it.
    const serviceOrg = await ciFleetCostMeterService.getOrgPeriodCostByWorkload(
      tenant.organizationId,
      STOPPED_AT,
    );
    const serviceSplit = await ciFleetCostMeterService.getMetaPeriodCostSplit(STOPPED_AT);
    expect(readout.input.org.lines).toEqual(serviceOrg);
    expect(readout.input.metaSplit).toEqual(serviceSplit);

    // The population genuinely differs between meta and tenant.
    expect(serviceSplit.some((row) => row.isMeta)).toBe(true);
    expect(serviceSplit.some((row) => !row.isMeta)).toBe(true);

    // Per rendered row: each field the renderer reads is a field the service returned,
    // with the type it needs. A key renamed in the repository's raw SQL arrives as
    // `undefined`, and both halves below fail on it.
    for (const line of [...serviceOrg, ...serviceSplit]) {
      expect(typeof line.workload).toBe('string');
      expect(Number.isInteger(line.containerCount)).toBe(true);
      expect(Number.isInteger(line.containerSeconds)).toBe(true);
      expect(typeof line.costUsd).toBe('string');
      expect(printedRow(readout.text, line), JSON.stringify(line)).toBe(true);
    }
    expect(serviceOrg.map((line) => line.workload).sort()).toEqual(['ci', 'instance']);
    expect(readout.text).toContain("META (Motir's own)");
    expect(readout.text).toContain('TENANT (paying orgs)');
  });
});

describe('MONEY never becomes a float — through the database, not a fixture (AC 6)', () => {
  it('prints a cost whose decimal expansion a float would change, digit for digit', async () => {
    const tenant = await seedOrg();
    await recordContainer(tenant, 'agent_instance', 60, UNFLOATABLE_COST);

    const readout = await buildFleetCostReadout({
      organizationId: tenant.organizationId,
      at: STOPPED_AT,
    });
    const instance = readout.input?.org?.lines.find((line) => line.workload === 'instance');

    expect(new Prisma.Decimal(instance!.costUsd).equals(new Prisma.Decimal(UNFLOATABLE_COST))).toBe(
      true,
    );
    expect(readout.text).toContain(UNFLOATABLE_COST);
    // The value a `Number()` round-trip would have printed instead.
    expect(String(Number(UNFLOATABLE_COST))).not.toBe(UNFLOATABLE_COST);
    expect(readout.text).not.toContain(`${String(Number(UNFLOATABLE_COST))} `);
  });
});

describe('the cost axis is TOTAL over the fleet union (AC 3)', () => {
  it('declares a cost line for every FleetWorkloadKind — asserted on the key SET, at type and at run time', () => {
    // At type level: a union member with no entry is `never`-violating here, whatever
    // `Record<>` is later weakened to.
    type Missing = Exclude<FleetWorkloadKind, keyof typeof CONTAINER_WORKLOAD_BY_FLEET_KIND>;
    expectTypeOf<Missing>().toBeNever();
    type Extra = Exclude<keyof typeof CONTAINER_WORKLOAD_BY_FLEET_KIND, FleetWorkloadKind>;
    expectTypeOf<Extra>().toBeNever();

    // At run time, against the other total registry over the same union — so a map
    // that lost a key at run time (a spread, a `delete`) fails too.
    expect(Object.keys(CONTAINER_WORKLOAD_BY_FLEET_KIND).sort()).toEqual(
      [...FLEET_WORKLOAD_KINDS].sort(),
    );
    // And no two kinds collapse silently onto one line.
    const lines = Object.values(CONTAINER_WORKLOAD_BY_FLEET_KIND);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe('the readout WRITES NOTHING (AC 4)', () => {
  it('every database transaction the readout opens is READ ONLY, and Postgres would refuse a write', async () => {
    const tenant = await seedOrg();
    const meta = await seedOrg({ isMeta: true });
    await recordContainer(tenant, 'agent_instance', 120, '0.003796325880');
    await recordContainer(meta, 'ci_runner', 60, '0.001898162940');

    const realSystem = workspaceContext.withSystemContext;
    const systemSpy = vi
      .spyOn(workspaceContext, 'withSystemContext')
      .mockImplementation((fn, ...rest) =>
        realSystem(
          async (tx) => {
            await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
            return fn(tx);
          },
          ...(rest as []),
        ),
      );
    const otherDoors = [
      vi.spyOn(workspaceContext, 'withWorkspaceContext'),
      vi.spyOn(workspaceContext, 'withWorkspaceServiceContext'),
      vi.spyOn(workspaceContext, 'withUserContext'),
    ];

    const readout = await buildFleetCostReadout({
      organizationId: tenant.organizationId,
      at: STOPPED_AT,
    });

    expect(readout.input?.metaSplit.length).toBeGreaterThan(0);
    expect(systemSpy).toHaveBeenCalledTimes(2);
    for (const door of otherDoors) expect(door).not.toHaveBeenCalled();

    // The wrapper is not vacuous: the same READ ONLY transaction refuses a write.
    await expect(
      realSystem(async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(
          `UPDATE "ci_container_period_cost" SET "container_count" = "container_count"`,
        );
      }),
    ).rejects.toThrow(/read-only transaction/i);
  });
});

describe('the read path imports NO billing, entitlement or credit module (AC 5)', () => {
  /**
   * The modules the fleet-cost READ path must never reach, by name.
   *
   * ⚠️ ONE NAMED EXCEPTION: `lib/billing/availability.ts`. It is the cloud switch
   * the meter and the readout are gated on (`isCloudBilling()` reads
   * `MOTIR_CLOUD` and nothing else) — no price, no entitlement, no balance. It is
   * named rather than hidden so a second import from `lib/billing/` fails.
   */
  const FORBIDDEN_PREFIXES = [
    'lib/billing/', // billing: catalog, entitlements, AI entitlement, seat sync
    'lib/services/billingService.ts',
    'lib/services/ciAllowanceService.ts', // the CI entitlement / allowance state
    'lib/services/ciMinutesMeterService.ts',
    'lib/services/aiUsageService.ts', // credit usage over the motir-ai boundary
    'lib/ai/motirAiClient.ts', // every credit route
    'lib/ciFleet/indexAllowance.ts', // the internal index allowance (a separate path)
  ];
  const ALLOWED = new Set(['lib/billing/availability.ts']);
  const ROOT = process.cwd();

  function resolveImport(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
    else if (spec === '@motir/orchestrator') base = join(ROOT, 'packages/orchestrator/src/index');
    else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
    else return null; // node builtins and npm packages
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
    }
    return null;
  }

  function runtimeImports(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    const specs: string[] = [];
    // `import type …` and `export type …` are erased and pull nothing in at run time.
    for (const m of source.matchAll(
      /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm,
    ))
      specs.push(m[1]!);
    for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]!);
    for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]!);
    return specs.flatMap((spec) => resolveImport(file, spec) ?? []);
  }

  it('walks the whole transitive import graph from the readout and finds none of them', () => {
    const entries = ['scripts/fleetCostReadoutQuery.ts', 'scripts/fleetCostReadout.ts'].map((f) =>
      join(ROOT, f),
    );
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...runtimeImports(file));
    }
    const reached = [...seen].map((f) => relative(ROOT, f));

    // Not vacuous: the walk reached the meter service and the repository beneath it.
    expect(reached).toContain('lib/services/ciFleetCostMeterService.ts');
    expect(reached).toContain('lib/repositories/ciContainerPeriodCostRepository.ts');
    expect(reached).toContain('lib/billing/availability.ts');

    const violations = reached.filter(
      (f) => !ALLOWED.has(f) && FORBIDDEN_PREFIXES.some((prefix) => f.startsWith(prefix)),
    );
    expect(violations).toEqual([]);
  });
});

describe('the callable readout’s own branches (MOTIR-4544 top-up)', () => {
  it('off-cloud it returns the disabled text and reads NOTHING', async () => {
    vi.stubEnv('MOTIR_CLOUD', '');
    const system = vi.spyOn(workspaceContext, 'withSystemContext');
    const readout = await buildFleetCostReadout({ organizationId: 'org_x', at: STOPPED_AT });
    expect(readout.input).toBeNull();
    expect(readout.text).toMatch(/disabled/i);
    expect(system).not.toHaveBeenCalled();
  });

  it('without an organisation it renders only the platform-wide split', async () => {
    const tenant = await seedOrg();
    await recordContainer(tenant, 'agent_instance', 60, '0.001898162940');
    const readout = await buildFleetCostReadout({ at: STOPPED_AT });
    expect(readout.input?.org).toBeUndefined();
    expect(readout.input?.metaSplit.length).toBe(1);
    expect(readout.text).not.toContain('PER-WORKLOAD');
  });

  it('prints no ABSENT line when every workload ran', () => {
    const line = (workload: string) => ({
      workload,
      containerCount: 1,
      containerSeconds: 1,
      costUsd: '0.1',
    });
    const text = renderReadout({
      periodStart: new Date('2026-08-01T00:00:00Z'),
      periodEnd: new Date('2026-09-01T00:00:00Z'),
      org: {
        organizationId: 'org_all',
        lines: Object.values(CONTAINER_WORKLOAD_BY_FLEET_KIND).map(line),
      },
      metaSplit: [],
    });
    expect(text.split('PER-WORKLOAD')[1]!.split('META vs TENANT')[0]).not.toContain('ABSENT');
  });
});
