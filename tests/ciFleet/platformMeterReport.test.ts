import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { ContainerUsage } from '@motir/orchestrator';
import { FLEET_WORKLOAD_KINDS, type FleetWorkloadKind } from '@/lib/ciFleet/workloads';

/**
 * The platform meter report (Story MOTIR-727 · MOTIR-5286) — every settled fleet
 * container's seconds and Motir cost, reported to motir-ai's platform usage rollup.
 *
 * Over the REAL meter and real Postgres; motir-ai's HTTP edge is faked at `fetch`, so
 * the assertions read the bytes that would cross the wire. The enqueue seam is
 * captured, and the job body (`reportContainer`) is driven as the job would drive it.
 */

const enqueued: { name: string; data: { containerProvider: string; handleId: string } }[] = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendSystemEvent: vi.fn(
    async (name: string, data: { containerProvider: string; handleId: string }) => {
      enqueued.push({ name, data });
    },
  ),
  sendEvent: vi.fn(),
}));

const { db } = await import('@/lib/db');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { ciFleetCostMeterService } = await import('@/lib/services/ciFleetCostMeterService');
const { platformMeterReportService, METER_REPORT_WORKLOAD, STORAGE_COST_USD_PER_DAY } =
  await import('@/lib/services/platformMeterReportService');
const { platformMeterReportEnqueue, withPlatformMeterReport } =
  await import('@/lib/services/platformMeterReportEnqueue');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { agentInstanceStorageChargeService } =
  await import('@/lib/services/agentInstanceStorageChargeService');
const { adminDb } = await import('../helpers/adminDb');

/** The meter as production binds it: the orchestrator's sink settles through this. */
const settle = (usage: Parameters<typeof ciFleetCostMeterService.recordContainerUsage>[0]) =>
  withPlatformMeterReport(ciFleetCostMeterService).recordContainerUsage(usage);
const { truncateAuthTables } = await import('../helpers/db');
const { randomToken, randomInt } = await import('../helpers/random');

const STOPPED_AT = new Date('2026-09-15T12:00:00.000Z');
const IAD_USD_PER_SECOND = '0.000031636049';

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  ownerId: string;
}

/** Every request the faked motir-ai received: its path and its RAW body. */
let posted: { path: string; body: string }[] = [];
let answer: (body: string) => Response = () => Response.json({ sourceId: 'x', idempotent: false });

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_period_usage", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  enqueued.length = 0;
  posted = [];
  answer = () => Response.json({ sourceId: 'x', idempotent: false });
  await adminDb.agentInstanceStorageCharge.deleteMany();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      // The storage DEBIT is the charge pass's own call, not a report.
      if (path === '/v1/credits/agent-storage') {
        return Response.json({ idempotent: false, balanceCredits: 90 });
      }
      posted.push({ path, body: String(init?.body ?? '') });
      return answer(String(init?.body ?? ''));
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedTenant(): Promise<Fixture> {
  const email = `meter-report-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `M${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    ownerId: user.id,
  };
}

function usageFor(fx: Fixture, overrides: Partial<ContainerUsage> = {}): ContainerUsage {
  const billableSeconds = overrides.billableSeconds ?? 240;
  return {
    handleId: `m-${randomToken(8)}`,
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
    startedAt: new Date(STOPPED_AT.getTime() - billableSeconds * 1000),
    stoppedAt: STOPPED_AT,
    billableSeconds,
    usdPerSecond: IAD_USD_PER_SECOND,
    costUsd: new Prisma.Decimal(IAD_USD_PER_SECOND).mul(billableSeconds).toFixed(),
    rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    terminalState: 'destroyed',
    teardownReason: 'job_completed',
    ...overrides,
  };
}

/** The expected receiver workload for each fleet kind — the instance line renamed. */
const EXPECTED: Record<FleetWorkloadKind, string> = {
  ci_runner: 'ci',
  hosted_agent: 'agent',
  agent_instance: 'agent_instance',
};

describe('a settled container is reported to the platform rollup', () => {
  it.each(FLEET_WORKLOAD_KINDS)(
    '%s — one enqueue on settle, one report with every field',
    async (kind) => {
      const fx = await seedTenant();
      const usage = usageFor(fx, { workload: kind });
      expect((await settle(usage)).outcome).toBe('recorded');

      expect(enqueued).toEqual([
        {
          name: 'system.platform-meter-report',
          data: { containerProvider: 'fake', handleId: usage.handleId },
        },
      ]);

      const outcome = await platformMeterReportService.reportContainer('fake', usage.handleId);
      const row = await adminDb.ciContainerUsage.findFirstOrThrow({
        where: { handleId: usage.handleId },
      });
      expect(outcome).toEqual({ outcome: 'reported', containerUsageId: row.id, idempotent: false });
      expect(posted).toHaveLength(1);
      expect(posted[0]!.path).toBe('/v1/platform/meter');
      expect(JSON.parse(posted[0]!.body)).toEqual({
        kind: 'container',
        containerUsageId: row.id,
        coreOrganizationId: fx.organizationId,
        coreWorkspaceId: fx.workspaceId,
        coreProjectId: fx.projectId,
        workload: EXPECTED[kind],
        billableSeconds: 240,
        costUsd: row.costUsd.toFixed(),
        settledAt: STOPPED_AT.toISOString(),
      });
    },
  );

  it('maps every meter line onto the receiver’s vocabulary', () => {
    expect(METER_REPORT_WORKLOAD).toEqual({
      agent: 'agent',
      instance: 'agent_instance',
      ci: 'ci',
      index: 'index',
    });
  });

  it('sends costUsd as the exact decimal STRING the meter stored — a float round trip would bend it', async () => {
    const fx = await seedTenant();
    // 20 significant digits: no IEEE double holds it, so only a string survives.
    const exact = '12345678.123456789012';
    expect(String(Number(exact))).not.toBe(exact);
    const usage = usageFor(fx, { costUsd: exact });
    await settle(usage);
    await platformMeterReportService.reportContainer('fake', usage.handleId);
    expect(posted[0]!.body).toContain(`"costUsd":"${exact}"`);
  });

  it('a project-less container reports its workspace and org only', async () => {
    const fx = await seedTenant();
    const usage = usageFor(fx, { projectId: undefined, workload: 'agent_instance' });
    await settle(usage);
    await platformMeterReportService.reportContainer('fake', usage.handleId);
    expect(JSON.parse(posted[0]!.body)).toMatchObject({
      coreProjectId: null,
      coreWorkspaceId: fx.workspaceId,
    });
  });
});

describe('the report never touches the settle, and is exactly-once at the receiver', () => {
  it('a duplicate teardown enqueues nothing more', async () => {
    const fx = await seedTenant();
    const usage = usageFor(fx);
    await settle(usage);
    expect((await settle(usage)).outcome).toBe('duplicate');
    expect(enqueued).toHaveLength(1);
  });

  it('motir-ai down: the settle stays committed, the job throws to retry, and the retry carries the same key', async () => {
    const fx = await seedTenant();
    const usage = usageFor(fx);
    await settle(usage);

    answer = () => {
      throw new TypeError('fetch failed');
    };
    await expect(
      platformMeterReportService.reportContainer('fake', usage.handleId),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    // The settle and its period rollup are committed regardless.
    const row = await adminDb.ciContainerUsage.findFirstOrThrow({
      where: { handleId: usage.handleId },
    });
    expect(row.containerStoppedAt).not.toBeNull();
    expect(await adminDb.ciContainerPeriodCost.count()).toBe(1);

    answer = () => Response.json({ sourceId: row.id, idempotent: true });
    const retried = await platformMeterReportService.reportContainer('fake', usage.handleId);
    expect(retried).toEqual({ outcome: 'reported', containerUsageId: row.id, idempotent: true });
    const keys = posted.map(
      (p) => (JSON.parse(p.body) as { containerUsageId: string }).containerUsageId,
    );
    expect(new Set(keys)).toEqual(new Set([row.id]));
  });

  it('a non-2xx from motir-ai throws too, so the job retries rather than dropping the report', async () => {
    const fx = await seedTenant();
    const usage = usageFor(fx);
    await settle(usage);
    answer = () =>
      new Response(JSON.stringify({ code: 'internal_error', title: 'Internal', status: 500 }), {
        status: 500,
        headers: { 'content-type': 'application/problem+json' },
      });
    await expect(
      platformMeterReportService.reportContainer('fake', usage.handleId),
    ).rejects.toThrow();
  });

  it('a live checkpoint is never reported as final, and an unknown handle reports nothing', async () => {
    const fx = await seedTenant();
    const usage = usageFor(fx);
    const {
      stoppedAt: _s,
      terminalState: _t,
      teardownReason: _r,
      billableSeconds,
      ...rest
    } = usage;
    await ciFleetCostMeterService.recordContainerAccrual({
      ...rest,
      workload: 'agent_instance',
      startedAt: usage.startedAt ?? STOPPED_AT,
      observedAt: STOPPED_AT,
      accruedSeconds: billableSeconds,
    });
    expect(enqueued).toHaveLength(0);
    expect(await platformMeterReportService.reportContainer('fake', usage.handleId)).toEqual({
      outcome: 'not_settled',
    });
    expect(await platformMeterReportService.reportContainer('fake', 'm-nope')).toEqual({
      outcome: 'missing',
    });
    expect(posted).toHaveLength(0);
  });

  it('off-cloud there is no fleet and nothing is enqueued', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    await platformMeterReportEnqueue.container('fake', 'm-1');
    expect(enqueued).toHaveLength(0);
  });

  it('off-cloud a storage day enqueues nothing either', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    await platformMeterReportEnqueue.storage('charge-1');
    expect(enqueued).toHaveLength(0);
  });

  it('the wrapped meter passes a checkpoint straight through and enqueues nothing', async () => {
    const accruals: unknown[] = [];
    const meter = withPlatformMeterReport({
      recordContainerUsage: async () => ({ outcome: 'duplicate' }),
      recordContainerAccrual: async (accrual: unknown) => {
        accruals.push(accrual);
        return { outcome: 'checkpointed' };
      },
    });
    const accrual = { handleId: 'm-1' } as unknown as Parameters<
      typeof meter.recordContainerAccrual
    >[0];
    expect(await meter.recordContainerAccrual(accrual)).toEqual({ outcome: 'checkpointed' });
    expect(accruals).toEqual([accrual]);
    expect(enqueued).toHaveLength(0);
  });
});

// ── MOTIR-7294 — the storage feed and the backfill ──────────────────────────────

let agentSeq = 0;
async function agentFor(fx: Fixture, createdAt: Date) {
  agentSeq += 1;
  return adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      ownerId: fx.ownerId,
      name: `agent-${agentSeq}`,
      profileId: 'claude',
      imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
      imageDigest: 'sha256:0',
      region: 'iad',
      state: 'running',
      createdAt,
    },
  });
}

async function storageDay(
  fx: Fixture,
  instanceId: string,
  day: string,
  outcome: 'charged' | 'pending',
) {
  return adminDb.agentInstanceStorageCharge.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      agentInstanceId: instanceId,
      day: new Date(`${day}T00:00:00.000Z`),
      credits: 10,
      chargeReference: `agent-storage:${instanceId}:${day}`,
      chargeOutcome: outcome,
    },
  });
}

describe('a charged storage day is reported to the platform rollup (MOTIR-7294)', () => {
  it('the storage cost is the record’s $2.30 agent-month over 30 days, as a decimal string', () => {
    expect(STORAGE_COST_USD_PER_DAY).toBe('0.076666667');
  });

  it('the charge pass enqueues one report per CHARGED day, and the report carries the day’s usage and cost', async () => {
    const fx = await seedTenant();
    const agent = await agentFor(fx, new Date('2026-09-01T00:00:00.000Z'));
    const summary = await agentInstanceStorageChargeService.chargeDays({
      now: new Date('2026-09-29T10:00:00.000Z'),
    });
    expect(summary.charged).toBe(2);

    const days = await adminDb.agentInstanceStorageCharge.findMany({ orderBy: { day: 'asc' } });
    expect(enqueued).toEqual(
      days.map((d) => ({ name: 'system.platform-meter-report', data: { storageChargeId: d.id } })),
    );

    const outcome = await platformMeterReportService.reportStorage(days[0]!.id);
    expect(outcome).toEqual({
      outcome: 'reported',
      storageChargeId: days[0]!.id,
      idempotent: false,
    });
    expect(JSON.parse(posted[0]!.body)).toEqual({
      kind: 'storage',
      instanceId: agent.id,
      coreOrganizationId: fx.organizationId,
      day: '2026-09-28',
      gbSeconds: 10 * 86_400,
      costUsd: '0.076666667',
    });
    expect(posted[0]!.body).toContain('"costUsd":"0.076666667"');
  });

  it('motir-ai down: the storage charge stays committed and the report throws to be retried', async () => {
    const fx = await seedTenant();
    const agent = await agentFor(fx, new Date('2026-09-01T00:00:00.000Z'));
    const day = await storageDay(fx, agent.id, '2026-09-28', 'charged');
    answer = () => {
      throw new TypeError('fetch failed');
    };
    await expect(platformMeterReportService.reportStorage(day.id)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
    const after = await adminDb.agentInstanceStorageCharge.findUniqueOrThrow({
      where: { id: day.id },
    });
    expect(after).toMatchObject({ chargeOutcome: 'charged', platformMeterReportedAt: null });
  });

  it('a day not charged is never reported, and an unknown id reports nothing', async () => {
    const fx = await seedTenant();
    const agent = await agentFor(fx, new Date('2026-09-01T00:00:00.000Z'));
    const day = await storageDay(fx, agent.id, '2026-09-28', 'pending');
    expect(await platformMeterReportService.reportStorage(day.id)).toEqual({
      outcome: 'not_charged',
    });
    expect(await platformMeterReportService.reportStorage('nope')).toEqual({ outcome: 'missing' });
    expect(posted).toHaveLength(0);
  });
});

describe('the backfill reports history exactly once, in bounded batches (MOTIR-7294)', () => {
  it('two runs send every settled container and charged storage day once — the second sends nothing', async () => {
    const fx = await seedTenant();
    for (let i = 0; i < 5; i += 1) {
      await settle(
        usageFor(fx, { workload: FLEET_WORKLOAD_KINDS[i % FLEET_WORKLOAD_KINDS.length] }),
      );
    }
    // A container still running is not history yet.
    const live = usageFor(fx, { workload: 'agent_instance' });
    const { stoppedAt: _s, terminalState: _t, teardownReason: _r, billableSeconds, ...rest } = live;
    await ciFleetCostMeterService.recordContainerAccrual({
      ...rest,
      startedAt: live.startedAt ?? STOPPED_AT,
      workload: 'agent_instance',
      observedAt: STOPPED_AT,
      accruedSeconds: billableSeconds,
    });
    const agent = await agentFor(fx, new Date('2026-09-01T00:00:00.000Z'));
    for (const d of ['2026-09-26', '2026-09-27', '2026-09-28'])
      await storageDay(fx, agent.id, d, 'charged');
    await storageDay(fx, agent.id, '2026-09-29', 'pending');

    const reads: number[] = [];
    const first = await platformMeterReportService.backfill({ batch: 2 });
    expect(first).toEqual({
      containers: { reported: 5, failed: 0 },
      storageDays: { reported: 3, failed: 0 },
    });
    reads.push(posted.length);

    const second = await platformMeterReportService.backfill({ batch: 2 });
    expect(second).toEqual({
      containers: { reported: 0, failed: 0 },
      storageDays: { reported: 0, failed: 0 },
    });
    expect(posted).toHaveLength(reads[0]!);

    const keys = posted.map((p) => {
      const b = JSON.parse(p.body) as {
        kind: string;
        containerUsageId?: string;
        instanceId?: string;
        day?: string;
      };
      return b.kind === 'container' ? b.containerUsageId : `${b.instanceId}:${b.day}`;
    });
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
  });

  it('a row motir-ai refuses is counted, skipped past, and reported by the next run', async () => {
    const fx = await seedTenant();
    const usages = [usageFor(fx), usageFor(fx), usageFor(fx)];
    for (const u of usages) await settle(u);
    const rows = await adminDb.ciContainerUsage.findMany({ orderBy: { id: 'asc' } });
    const bad = rows[1]!.id;
    answer = (body) =>
      body.includes(bad)
        ? new Response(JSON.stringify({ code: 'internal_error', status: 500 }), { status: 500 })
        : Response.json({ sourceId: 'x', idempotent: false });

    expect(await platformMeterReportService.backfill({ batch: 1 })).toEqual({
      containers: { reported: 2, failed: 1 },
      storageDays: { reported: 0, failed: 0 },
    });
    answer = () => Response.json({ sourceId: bad, idempotent: false });
    expect(await platformMeterReportService.backfill({ batch: 1 })).toEqual({
      containers: { reported: 1, failed: 0 },
      storageDays: { reported: 0, failed: 0 },
    });
  });
});

describe('the system.platform-meter-report job routes each event to its step (MOTIR-5286 · MOTIR-7294)', () => {
  it('a container event runs `report-container`, a storage event `report-storage`, retried as idempotent', async () => {
    const { platformMeterReport } = await import('@/lib/jobs/definitions/platformMeterReport');
    expect(platformMeterReport).toMatchObject({
      id: 'system.platform-meter-report',
      retryPolicy: 'idempotent',
    });
    const steps: string[] = [];
    const services = {
      platformMeterReport: {
        reportContainer: vi.fn(async () => ({ outcome: 'missing' as const })),
        reportStorage: vi.fn(async () => ({ outcome: 'missing' as const })),
      },
    };
    const ctx = (data: unknown) => ({
      event: { data },
      step: { run: async (id: string, fn: () => unknown) => (steps.push(id), fn()) },
    });

    await platformMeterReport.handler(
      ctx({ containerProvider: 'fly', handleId: 'm-1' }) as never,
      services as never,
    );
    await platformMeterReport.handler(ctx({ storageChargeId: 'sc_1' }) as never, services as never);

    expect(steps).toEqual(['report-container', 'report-storage']);
    expect(services.platformMeterReport.reportContainer).toHaveBeenCalledWith('fly', 'm-1');
    expect(services.platformMeterReport.reportStorage).toHaveBeenCalledWith('sc_1');
  });
});
