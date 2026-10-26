import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import { planCapsService } from '@/lib/services/planCapsService';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';
import { stubPaidAiPlan } from '../helpers/paidAiPlan';

// THE CI BURST CAP (Story MOTIR-9363 · MOTIR-9375) — the CI gate holds an org to
// its plan's `ciBurstCap` over its CI runners ALONE, a staff
// `Organization.fleetPoolCap` overrides that one figure, and code-graph indexing
// is held to no plan figure. Real Postgres and the real fleet admission lock;
// the plan is stubbed at `planCapsService.capsFor` with the REAL row for each
// key (`tests/helpers/paidAiPlan.ts`). Credit coverage is the sibling suite's
// subject (`ciRunnerAdmissionService.test.ts`), so it is answered "covered" here
// except where a case says otherwise.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
/** A fixed instant, as the sibling suite pins it. */
const NOW_WITHIN_JULY_2026 = new Date('2026-07-15T12:00:00.000Z');

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(
  options: { isMeta?: boolean; ciBurstCap?: number } = {},
): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `fleet-gate-${suffix}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
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
  // A staff override of the CI burst cap (MOTIR-9375) — how a case sets a
  // small figure without inventing a plan.
  if (options.ciBurstCap !== undefined) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { fleetPoolCap: options.ciBurstCap },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

/** One intent, in whatever lifecycle state the case needs. `pending` is what
 *  MOTIR-1920's handler writes; `running` is what "already in flight" means. */
async function seedIntent(
  fx: Fixture,
  overrides: { status?: string; projectId?: string | null } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: overrides.projectId === undefined ? fx.projectId : overrides.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(80_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW_WITHIN_JULY_2026,
      status: overrides.status ?? 'pending',
    },
  });
}

/** motir-ai's balance read — the only call this path makes across the boundary. */
function stubMotirAi(balance = 1_000): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/v1/usage')) {
        return new Response(JSON.stringify({ balance }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }),
  );
}

async function statusOf(intentId: string): Promise<string> {
  const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
    where: { id: intentId },
  });
  return row.status;
}

/** `count` of the org's CI jobs already in flight. */
async function inFlight(fx: Fixture, count: number): Promise<CiRunnerProvisioningIntent[]> {
  const rows: CiRunnerProvisioningIntent[] = [];
  for (let i = 0; i < count; i++) rows.push(await seedIntent(fx, { status: 'running' }));
  return rows;
}

let slotSeq = 0;
/** A live fleet slot of another workload, held by the org. */
async function otherSlot(fx: Fixture, workload: 'hosted_agent' | 'code_graph_index') {
  slotSeq += 1;
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref: `${workload}-${slotSeq}`,
      ownerRef: `owner-${slotSeq}`,
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      expiresAt: new Date(NOW_WITHIN_JULY_2026.getTime() + 60 * 60_000),
    },
  });
}

const admit = async (fx: Fixture) => ciRunnerAdmissionService.admit(await seedIntent(fx));

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  vi.setSystemTime(NOW_WITHIN_JULY_2026);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  stubMotirAi();
  vi.spyOn(ciRunnerAdmissionService, 'creditDeferral').mockResolvedValue(null);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('each plan’s CI burst cap, over CI runners alone', () => {
  it.each([
    ['standard', 5],
    ['pro', 10],
    ['max', 25],
    ['max_x2', 25],
    ['host', 50],
    ['pool_600k', 20],
  ] as const)('%s admits %i and defers the next plan_cap', async (planKey, figure) => {
    stubPaidAiPlan(planKey);
    const fx = await seedTenant();
    await inFlight(fx, figure - 1);
    expect(await admit(fx)).toMatchObject({
      outcome: 'admitted',
      ciInFlight: figure - 1,
      ciBurstCap: figure,
    });
    const next = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(next)).toMatchObject({
      outcome: 'deferred',
      reason: 'plan_cap',
    });
    expect(await statusOf(next.id)).toBe('pending');
  });

  it('the words name the plan and the figure, never 500 or the env var; a finished runner lets the deferred job in', async () => {
    stubPaidAiPlan('pro');
    const fx = await seedTenant();
    const running = await inFlight(fx, 10);
    const queued = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(queued);
    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
    const detail = (verdict as { detail: string }).detail;
    expect(detail).toContain('Pro');
    expect(detail).toContain('10 CI jobs at once');
    expect(detail).not.toContain('500');
    expect(detail).not.toContain('MOTIR_FLEET_ORG_MAX_IN_FLIGHT');
    expect(await statusOf(queued.id)).toBe('pending');

    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: running[0]!.id },
      data: { status: 'completed', settledAt: new Date(), teardownReason: 'job_completed' },
    });
    const again = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect((await ciRunnerAdmissionService.admit(again)).outcome).toBe('admitted');
  });

  it('hosted runs and index containers far above the figure take none of CI’s room', async () => {
    stubPaidAiPlan('standard');
    const fx = await seedTenant();
    for (let i = 0; i < 5; i++) await otherSlot(fx, 'hosted_agent');
    for (let i = 0; i < 3; i++) await otherSlot(fx, 'code_graph_index');

    expect(await admit(fx)).toMatchObject({ outcome: 'admitted', ciInFlight: 0, ciBurstCap: 5 });
  });

  // ⚠️ MUTATION-CHECK: delete the `lockScope` call in `ciRunnerAdmissionService.admit`
  // and both racers read "4 in flight" and both claim.
  it('two concurrent admits one below a Standard figure: exactly one is admitted', async () => {
    stubPaidAiPlan('standard');
    const fx = await seedTenant();
    await inFlight(fx, 4);
    const [a, b] = [await seedIntent(fx), await seedIntent(fx)];

    const verdicts = await Promise.all([
      ciRunnerAdmissionService.admit(a),
      ciRunnerAdmissionService.admit(b),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'admitted')).toHaveLength(1);
    expect(verdicts.filter((v) => v.outcome === 'deferred')).toEqual([
      expect.objectContaining({ reason: 'plan_cap' }),
    ]);
  });
});

describe('the staff override, and the plans that have no figure', () => {
  it('fleetPoolCap = 2 holds a Max org at two, in words saying Motir set it', async () => {
    stubPaidAiPlan('max');
    const fx = await seedTenant({ ciBurstCap: 2 });
    await inFlight(fx, 1);
    expect(await admit(fx)).toMatchObject({ outcome: 'admitted', ciBurstCap: 2 });
    expect(await admit(fx)).toMatchObject({
      outcome: 'deferred',
      reason: 'plan_cap',
      detail: expect.stringContaining('a limit Motir set for it'),
    });
  });

  it('the same override holds an exempt (isMeta) org at two', async () => {
    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({ kind: 'exempt' });
    const fx = await seedTenant({ isMeta: true, ciBurstCap: 2 });
    await inFlight(fx, 2);
    expect(await admit(fx)).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
  });

  it('an exempt org with no override runs past Max’s 25, and the kill switch still stops it', async () => {
    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({ kind: 'exempt' });
    const fx = await seedTenant({ isMeta: true });
    await inFlight(fx, 30);
    expect(await admit(fx)).toMatchObject({ outcome: 'admitted', ciBurstCap: null });
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    expect(await admit(fx)).toMatchObject({ outcome: 'deferred', reason: 'fleet_ceiling' });
  });

  it.each([
    ['an unmatched key, named in the words', 'legacy_tier'],
    ['an unreadable plan', null],
  ] as const)(
    '%s defers plan_unknown whatever the override, and claims nothing',
    async (_, planKey) => {
      // The AI plan gate passes, so the refusal is the caps read's own.
      stubPaidAiPlan('max');
      vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({ kind: 'plan_unknown', planKey });
      const fx = await seedTenant({ ciBurstCap: 40 });
      const intent = await seedIntent(fx);

      const verdict = await ciRunnerAdmissionService.admit(intent);
      expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'plan_unknown' });
      if (planKey) expect((verdict as { detail: string }).detail).toContain(planKey);
      expect(await statusOf(intent.id)).toBe('pending');
    },
  );

  it('no pool remains to hold CI or indexing: a Pro org admits both (MOTIR-9377 deleted the pool)', async () => {
    stubPaidAiPlan('pro');
    const fx = await seedTenant();

    expect((await admit(fx)).outcome).toBe('admitted');
    const index = await codeGraphIndexAdmissionService.admit({
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoRef: 'acme/web',
      dispatchId: 'dispatch-1',
      containerTimeoutMs: 60_000,
    });
    expect(index.outcome).toBe('admitted');
  });
});

describe('indexing counts against no plan figure', () => {
  it('CI runners and hosted runs far above any figure leave an index container admitted', async () => {
    stubPaidAiPlan('standard');
    const fx = await seedTenant();
    await inFlight(fx, 60);
    for (let i = 0; i < 10; i++) await otherSlot(fx, 'hosted_agent');

    const verdict = await codeGraphIndexAdmissionService.admit({
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoRef: 'acme/web',
      dispatchId: 'dispatch-2',
      containerTimeoutMs: 60_000,
    });
    expect(verdict.outcome).toBe('admitted');
  });
});
