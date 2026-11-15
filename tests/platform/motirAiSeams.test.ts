import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { ContainerUsage } from '@motir/orchestrator';
import {
  CHILDREN,
  MONTHS,
  ORGS,
  OUTGOING,
  PROVIDER_RECONCILIATION,
  RUNS,
  USAGE,
  withIds,
} from '../fixtures/motirAiContract/platformReads';

/**
 * Story 10.1's motir-core INTEGRATION GATE, part 2 (Story MOTIR-727 · MOTIR-7296) —
 * the motir-core side of the motir-ai boundary, over real Postgres with motir-ai
 * faked at `fetch` by RECORDED bodies (`tests/fixtures/motirAiContract`).
 *
 *  1. CLIENT SEAMS — each platform read's recorded response, driven back through the
 *     client and the services into their DTOs: every category, the no-project and
 *     org-level rows, the estate total, the all-time row, the runs; and the
 *     unreachable path, which is a state and never a throw.
 *  2. OUTGOING BODIES — the meter reports and the run attribution carry exactly the
 *     keys motir-ai's contract documents, `costUsd` a decimal string.
 */

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendSystemEvent: vi.fn(async () => {}),
  sendEvent: vi.fn(),
}));

const { db } = await import('@/lib/db');
const { debitAgentMachine } = await import('@/lib/ai/motirAiClient');
const { buildSpendSheet } = await import('@/lib/platform/spend');
const { platformReadService } = await import('@/lib/services/platformReadService');
const { platformUsageService } = await import('@/lib/services/platformUsageService');
const { platformOrgPageService } = await import('@/lib/services/platformOrgPageService');
const { platformMeterReportService } = await import('@/lib/services/platformMeterReportService');
const { ciFleetCostMeterService } = await import('@/lib/services/ciFleetCostMeterService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

interface Seen {
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}
let seen: Seen[] = [];
let ids: { org: string; ws: string; project: string };
let down = false;

function recorded(path: string): unknown {
  switch (path) {
    case '/v1/platform/usage':
      return withIds(USAGE, ids);
    case '/v1/platform/usage/children':
      return withIds(CHILDREN, ids);
    case '/v1/platform/usage/orgs':
      return withIds(ORGS, ids);
    case '/v1/platform/usage/months':
      return withIds(MONTHS, ids);
    case '/v1/platform/usage/provider-reconciliation':
      return PROVIDER_RECONCILIATION;
    case '/v1/platform/runs':
      return withIds(RUNS, ids);
    case '/v1/usage':
      return {
        balance: 4_210,
        tier: null,
        monthSpend: 0,
        search: null,
        agentMachine: null,
        agentStorage: null,
      };
    case '/v1/platform/meter':
      return { sourceId: 'x', idempotent: false };
    case '/v1/credits/agent-machine':
      return {
        transactionId: 't',
        aiOrganizationId: 'a',
        credits: -27,
        balanceAfter: 973,
        exhausted: false,
        idempotent: false,
      };
    default:
      return null;
  }
}

let principal: { userId: string; email: string; role: 'support' };

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_audit_log", "ci_period_usage", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  const staff = await createTestUser({ email: 'ops+seams@moooon.net' });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'support' } });
  principal = { userId: staff.id, email: staff.email, role: 'support' };
  currentSession = { user: { id: staff.id } };

  const owner = await createTestUser({ email: 'owner@acme.test' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Engineering',
    ownerUserId: owner.id,
  });
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { name: 'Acme Corp' },
  });
  const project = await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Mobile App',
    identifier: 'MOB',
  });
  ids = { org: workspace.organizationId, ws: workspace.id, project: project.id };

  seen = [];
  down = false;
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (down) throw new TypeError('fetch failed');
      const url = new URL(String(input));
      seen.push({
        path: url.pathname,
        query: url.searchParams,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      const body = recorded(url.pathname);
      return body === null ? new Response('{}', { status: 404 }) : Response.json(body);
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

describe('1 · client seams: recorded motir-ai reads into their DTOs', () => {
  it('/v1/platform/usage → the Usage & cost sheet: all eight categories, indexing out of the charged total', async () => {
    const { usage } = await platformReadService.getEstateUsage(principal, '2026-09');
    // The view also reads the reconciliation, in parallel, so find the usage call by path.
    const call = seen.find((s) => s.path === '/v1/platform/usage')!;
    expect(call.query.get('level')).toBe('platform');
    expect(call.query.get('period')).toBe('2026-09');
    const sheet = buildSpendSheet(usage!.categories);
    expect(sheet.rows).toHaveLength(8);
    expect(sheet.chargedCredits).toBe(USAGE.spend.chargedCredits);
    expect(sheet.chargedCostMicroUsd).toBe(USAGE.spend.chargedCostMicroUsd);
    expect(sheet.costMicroUsdInclIndexing).toBe(USAGE.spend.costMicroUsdInclIndexing);
    expect(usage!.models.planning_tokens.map((m) => m.model)).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]);
  });

  it('/v1/platform/usage/orgs → Tenants: the estate total row, the org row named from motir-core', async () => {
    const list = await platformUsageService.listTenants(principal, {
      period: '2026-09',
      sort: 'charged',
    });
    expect(seen.at(-1)!.query.get('sort')).toBe('charged');
    expect(list.estate).toMatchObject({
      organization: null,
      chargedCredits: 1_650,
      costMicroUsd: 10_000_000,
    });
    expect(list.rows).toEqual([
      expect.objectContaining({
        organization: expect.objectContaining({ id: ids.org, name: 'Acme Corp' }),
        indexingSeconds: 1_800,
        chargedCredits: 495,
      }),
    ]);
    expect(list.nextCursor).toBe(ORGS.nextCursor);
  });

  it('/usage/provider-reconciliation → the Provider bills section, read in the same audited view', async () => {
    const { reconciliation } = await platformReadService.getEstateUsage(principal, '2026-09');
    const call = seen.find((s) => s.path === '/v1/platform/usage/provider-reconciliation')!;
    expect(call.query.get('period')).toBe('2026-09');
    expect(reconciliation).toStrictEqual(PROVIDER_RECONCILIATION);
  });

  it('/usage/children + /usage/months → the org Usage tab: workspace named, both remainder rows, the all-time row', async () => {
    const tab = await platformOrgPageService.getUsageTab(principal, ids.org, { period: '2026-09' });
    expect(tab.children).toMatchObject({
      childLevel: 'workspace',
      rows: [{ entityId: ids.ws, name: 'Engineering', chargedCredits: 495 }],
      remainder: { noProject: { chargedCredits: 165 }, orgLevel: { chargedCredits: 330 } },
    });
    expect(tab.months!.items.map((m) => m.period)).toEqual(['2026-09', '2026-08']);
    expect(tab.months!.allTime).toMatchObject({ period: 'all', spend: { chargedCredits: 495 } });
    expect(tab.balance).toBe(4_210);
  });

  it('/v1/platform/runs → the org Overview jobs: the hosted run named down to its project, the planning run unattributed', async () => {
    const o = await platformOrgPageService.getOverview(principal, ids.org);
    expect(o.jobs.items).toEqual([
      expect.objectContaining({
        kind: 'coding_run',
        workspace: { id: ids.ws, name: 'Engineering' },
        project: { id: ids.project, name: 'Mobile App' },
        credits: 96,
        unattributed: false,
      }),
      expect.objectContaining({ kind: 'planning_run', workspace: null, unattributed: true }),
    ]);
    expect(o.workspaces[0]).toMatchObject({ id: ids.ws, monthChargedCredits: 495 });
    expect(o.jobs.nextCursor).toBe(RUNS.nextCursor);
  });

  it('motir-ai unreachable: every read answers its unavailable state — never a throw', async () => {
    down = true;
    expect((await platformReadService.getEstateUsage(principal, 'all')).usage).toBeNull();
    expect(
      await platformUsageService.listTenants(principal, { period: 'all', sort: 'cost' }),
    ).toMatchObject({
      unavailable: true,
    });
    expect(
      await platformOrgPageService.getUsageTab(principal, ids.org, { period: 'all' }),
    ).toMatchObject({
      usage: null,
      childrenUnavailable: true,
      months: null,
    });
    expect((await platformOrgPageService.getOverview(principal, ids.org)).jobs.unavailable).toBe(
      true,
    );
    expect(
      (await platformReadService.getOverview(principal, { period: '7d' })).feed.runsUnavailable,
    ).toBe(true);
  });
});

/** The key set motir-ai's contract documents for a body. */
function expectContractKeys(
  body: Record<string, unknown>,
  contract: { required: readonly string[]; optional: readonly string[] },
) {
  for (const key of contract.required) expect(body, `missing ${key}`).toHaveProperty(key);
  const allowed = new Set([...contract.required, ...contract.optional]);
  expect(Object.keys(body).filter((k) => !allowed.has(k))).toEqual([]);
}

describe('2 · outgoing bodies match motir-ai’s contract', () => {
  it('a settled container’s meter report — each workload — costUsd a decimal string', async () => {
    const workloads = [
      ['ci_runner', 'ci'],
      ['code_graph_index', 'index'],
      ['hosted_agent', 'agent'],
      ['agent_instance', 'agent_instance'],
    ] as const;
    for (const [kind, expected] of workloads) {
      const usage: ContainerUsage = {
        handleId: `m-${kind}`,
        provider: 'fake',
        region: 'iad',
        orgId: ids.org,
        workspaceId: ids.ws,
        projectId: ids.project,
        repoFullName: 'acme/web',
        workload: kind,
        workflowJobId: null,
        cpuKind: 'performance',
        cpus: 2,
        memoryMb: 8192,
        createdAt: new Date('2026-09-15T11:50:00Z'),
        startedAt: new Date('2026-09-15T11:56:00Z'),
        stoppedAt: new Date('2026-09-15T12:00:00Z'),
        billableSeconds: 240,
        usdPerSecond: '0.000031636049',
        costUsd: new Prisma.Decimal('0.000031636049').mul(240).toFixed(),
        rateEffectiveFrom: new Date('2026-08-01T00:00:00Z'),
        terminalState: 'destroyed',
        teardownReason: 'job_completed',
      };
      await ciFleetCostMeterService.recordContainerUsage(usage);
      await platformMeterReportService.reportContainer('fake', usage.handleId);
      const body = seen.filter((s) => s.path === '/v1/platform/meter').at(-1)!.body!;
      expectContractKeys(body, OUTGOING.meterContainer);
      expect(body.kind).toBe('container');
      expect(OUTGOING.meterContainer.workloads).toContain(body.workload);
      expect(body.workload).toBe(expected);
      expect(typeof body.costUsd).toBe('string');
      expect(body.costUsd).toMatch(/^\d+(\.\d+)?$/);
      expect(body.settledAt).toBe('2026-09-15T12:00:00.000Z');
    }
  });

  it('a charged storage day’s meter report', async () => {
    const owner = await adminDb.organizationMembership.findFirstOrThrow({
      where: { organizationId: ids.org },
    });
    const agent = await adminDb.agentInstance.create({
      data: {
        workspaceId: ids.ws,
        organizationId: ids.org,
        projectId: ids.project,
        ownerId: owner.userId,
        name: 'agent-1',
        profileId: 'claude',
        imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
        imageDigest: 'sha256:0',
        region: 'iad',
        state: 'running',
      },
    });
    const day = await adminDb.agentInstanceStorageCharge.create({
      data: {
        workspaceId: ids.ws,
        organizationId: ids.org,
        agentInstanceId: agent.id,
        day: new Date('2026-09-28T00:00:00Z'),
        credits: 10,
        chargeReference: `agent-storage:${agent.id}:2026-09-28`,
        chargeOutcome: 'charged',
      },
    });
    await platformMeterReportService.reportStorage(day.id);
    const body = seen.filter((s) => s.path === '/v1/platform/meter').at(-1)!.body!;
    expectContractKeys(body, OUTGOING.meterStorage);
    expect(body).toMatchObject({
      kind: 'storage',
      instanceId: agent.id,
      day: '2026-09-28',
      gbSeconds: 864_000,
    });
    expect(body.costUsd).toMatch(/^\d+\.\d+$/);
  });

  it('a hosted run’s machine charge carries its attribution as a PAIR, or not at all', async () => {
    const charge = {
      coreOrganizationId: ids.org,
      coreRunId: 'cmrun_1',
      credits: 27,
      billableSeconds: 1_592,
      externalRef: 'cmrun_1',
    };
    await debitAgentMachine({ ...charge, coreWorkspaceId: ids.ws, coreProjectId: ids.project });
    const paired = seen.at(-1)!.body!;
    expectContractKeys(paired, OUTGOING.agentMachineRun);
    expect(paired).toMatchObject({ coreWorkspaceId: ids.ws, coreProjectId: ids.project });

    await debitAgentMachine({ ...charge, coreWorkspaceId: ids.ws });
    const half = seen.at(-1)!.body!;
    expectContractKeys(half, OUTGOING.agentMachineRun);
    expect(half).not.toHaveProperty('coreWorkspaceId');
    expect(half).not.toHaveProperty('coreProjectId');
  });
});
