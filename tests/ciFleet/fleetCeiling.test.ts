import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import {
  fleetCeilingService,
  describeFleetCensus,
  type FleetInFlightCensus,
  type FleetSlotVerdict,
} from '@/lib/services/fleetCeilingService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { ciFleetAdmissionLockRepository } from '@/lib/repositories/ciFleetAdmissionLockRepository';
import {
  FLEET_WORKLOADS,
  FLEET_WORKLOAD_KINDS,
  SLOT_BACKED_WORKLOADS,
  type FleetWorkloadKind,
} from '@/lib/ciFleet/workloads';
import { withSystemContext } from '@/lib/workspaces/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { grantPaidAiPlan, stubPaidAiPlan } from '../helpers/paidAiPlan';
import { randomInt, randomToken } from '../helpers/random';
import { fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
import { AGENT_RUNNER_PROVIDER_ENV_VAR } from '@/lib/ciFleet/fleetKindSwitches';
import {
  fleetShardAdmissionService,
  HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
} from '@/lib/services/fleetShardAdmissionService';
import type { FleetShard } from '@/generated/prisma/client';

// THE PER-ORGANISATION FLEET POOL against real Postgres (Story MOTIR-6906 ·
// MOTIR-6907, re-cutting MOTIR-1916 · MOTIR-1997;
// `docs/decisions/fleet-per-org-pool.md`).
//
// ⚠️ WHAT THIS SUITE HAS TO PROVE. An organisation's pool is ONE number over CI
// *and* the workloads that write no runner intent — index containers and hosted
// agents — so every case mixes workloads on purpose (the 2026-08-02 lesson: two
// per-workload caps do not compose into a bound). And it is PER ORGANISATION: one
// org's burst must never queue another's, so the race cases mix ORGS too.
//
// Everything load-bearing is REAL: Postgres, the shared `fleet` admission lock
// and its `FOR UPDATE`, both counted tables, the claim's compare-and-set and the
// slot's `ON CONFLICT`. The ONE thing stubbed is the motir-ai HTTP boundary
// (global `fetch`), because the CI gate's third guard reads a credit balance
// that is by definition on the other side of it.
//
// ⚠️ THE CLOCK IS PINNED because slot expiry is a real comparison against a
// Date the service binds. An unpinned clock would make the expiry cases race the
// wall clock instead of asserting the branch.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-08-02T12:00:00.000Z');
/** Longer than any container Motir boots — the shipped default's shape. */
const TTL_SECONDS = 3_600;

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
    email: `fleet-ceiling-${suffix}@example.com`,
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
  // A staff override of the CI burst cap (MOTIR-9375) — a small CI figure
  // without inventing a plan.
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

async function seedIntent(
  fx: Fixture,
  overrides: { status?: string } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '9001',
      runAttempt: 1,
      jobId: String(90_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: overrides.status ?? 'pending',
    },
  });
}

let refSeq = 0;

/** Reserve one container for a NON-CI workload through the real path — the
 *  admission every future workload gets by calling `reserve` and nothing more. */
async function reserve(
  workload: FleetWorkloadKind,
  fx: Fixture,
  ref = `run-${(refSeq += 1)}`,
  at: Date = NOW,
): Promise<{ ref: string; verdict: FleetSlotVerdict }> {
  const verdict = await fleetCeilingService.reserve(
    {
      workload,
      ref,
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      ttlSeconds: TTL_SECONDS,
    },
    at,
  );
  return { ref, verdict };
}

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

async function census(): Promise<FleetInFlightCensus> {
  return withSystemContext((tx) => fleetCeilingService.census(NOW, tx));
}

async function orgCensus(fx: Fixture, at: Date = NOW): Promise<FleetInFlightCensus> {
  return withSystemContext((tx) => fleetCeilingService.orgCensus(fx.organizationId, at, tx));
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  // No kill switch unless a case sets one.
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  stubMotirAi();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // ⚠️ AND AFTER, NOT ONLY BEFORE. `fleet_in_flight_slot` carries no foreign key,
  // by design, so a slot outlives whatever it pointed at — which means no
  // `TRUNCATE "workspace" CASCADE` reaches it and the NEXT FILE IN THIS WORKER
  // does not clean up after this one. Clearing it before our own tests protects
  // us; clearing it after protects everyone else.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The registry, and the totality guard that keeps it honest ───────────────

describe('the fleet workload REGISTRY', () => {
  // The compile-time guard is the `Record<FleetWorkloadKind, …>` itself; this is
  // the runtime half — a counter that was registered but wired to nothing would
  // type-check and count nothing.
  it('gives EVERY workload kind a fleet-wide AND a per-org counter', async () => {
    const fx = await seedTenant();
    expect(FLEET_WORKLOAD_KINDS.length).toBeGreaterThanOrEqual(3);
    for (const kind of FLEET_WORKLOAD_KINDS) {
      expect(FLEET_WORKLOADS[kind].kind).toBe(kind);
      expect(FLEET_WORKLOADS[kind].label).toBeTruthy();
      const counted = await withSystemContext((tx) => FLEET_WORKLOADS[kind].countInFlight(NOW, tx));
      expect(counted).toBe(0);
      const forOrg = await withSystemContext((tx) =>
        FLEET_WORKLOADS[kind].countInFlightForOrg(fx.organizationId, NOW, tx),
      );
      expect(forOrg).toBe(0);
    }
    expect(Object.keys((await orgCensus(fx)).byWorkload).sort()).toEqual(
      [...FLEET_WORKLOAD_KINDS].sort(),
    );
  });

  // CI counts its OWN table and writes no slot — the union is what makes both
  // representations legal at once, and this is the assertion that says so.
  it('counts CI from the intent table and every other workload from the slot table', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });
    await reserve('code_graph_index', fx);

    const seen = await orgCensus(fx);
    expect(seen.byWorkload['ci_runner']).toBe(1);
    expect(seen.byWorkload['code_graph_index']).toBe(1);
    expect(seen.total).toBe(2);
    expect((await census()).total).toBe(2);
    const fleetInFlightSlotCount = await adminDb.fleetInFlightSlot.count({
      where: { workload: 'ci_runner' },
    });
    expect(fleetInFlightSlotCount).toBe(0);
    expect(SLOT_BACKED_WORKLOADS).not.toContain('ci_runner');
  });

  // The org census counts ONE org; the fleet census counts them all.
  it("an org's census never counts another org's containers", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await seedIntent(a, { status: 'running' });
    await reserve('hosted_agent', b);
    await reserve('code_graph_index', b);

    expect((await orgCensus(a)).total).toBe(1);
    expect((await orgCensus(b)).total).toBe(2);
    expect((await census()).total).toBe(3);
  });

  it('names each workload in the operator breakdown', async () => {
    const described = describeFleetCensus(await census());
    for (const kind of FLEET_WORKLOAD_KINDS) {
      expect(described).toContain(FLEET_WORKLOADS[kind].label);
    }
  });
});

// ── One pool per organisation, over ALL its workloads ───────────────────────

describe("each workload is held to its OWN figure, never the org's summed pool", () => {
  // MOTIR-9375: the CI gate judges the org's CI runners alone, so ITS index and
  // agent containers no longer take CI's room.
  it("admits an org's CI job however many index and agent containers it holds", async () => {
    const fx = await seedTenant({ ciBurstCap: 4 });
    await reserve('code_graph_index', fx);
    await reserve('code_graph_index', fx);
    await reserve('hosted_agent', fx);
    await reserve('hosted_agent', fx);

    const verdict = await ciRunnerAdmissionService.admit(await seedIntent(fx));

    expect(verdict).toMatchObject({ outcome: 'admitted', ciInFlight: 0, ciBurstCap: 4 });
  });

  // ...and a CI job over the figure still WAITS, with the breakdown an operator
  // acts on.
  it("defers an org's CI job at its CI figure, queued, with the per-workload breakdown", async () => {
    const fx = await seedTenant({ ciBurstCap: 2 });
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'running' });
    await reserve('hosted_agent', fx);

    const queued = await seedIntent(fx);
    const verdict = await ciRunnerAdmissionService.admit(queued);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect(after.status).toBe('pending');
    const detail = (verdict as { detail: string }).detail;
    expect(detail).toContain('runs 2 CI jobs at once');
    expect(detail).toContain('hosted agents 1');
  });

  // MOTIR-9373: `reserve` no longer judges the summed pool. An index slot taken
  // through it is held by no plan figure.
  it("reserve no longer refuses an INDEX slot because the org's CI runners filled its pool", async () => {
    const fx = await seedTenant({ ciBurstCap: 3 });
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'running' });
    await seedIntent(fx, { status: 'provisioning' });

    const { verdict } = await reserve('code_graph_index', fx);

    expect(verdict).toMatchObject({ outcome: 'reserved', pool: null });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(1);
  });

  // ⚠️ THE POINT OF THE CARD (criterion 1): another org at its figure is NOT
  // this org's problem.
  it('admits org B while org A is at its CI figure', async () => {
    const a = await seedTenant({ ciBurstCap: 1 });
    const b = await seedTenant({ ciBurstCap: 1 });
    await seedIntent(a, { status: 'running' });
    await reserve('hosted_agent', a);

    expect(await ciRunnerAdmissionService.admit(await seedIntent(a))).toMatchObject({
      reason: 'plan_cap',
    });
    expect((await reserve('hosted_agent', b)).verdict).toMatchObject({ outcome: 'reserved' });
    expect((await ciRunnerAdmissionService.admit(await seedIntent(b))).outcome).toBe('admitted');
  });

  // MOTIR-9373: a hosted run is judged against its plan's figure (Max ×2: 5)
  // and its OWN count, and the reservation reports the figure it used.
  it('reserves a hosted run against its plan figure and reports the figure it used', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { status: 'running' });
    await reserve('code_graph_index', fx);

    const { verdict } = await reserve('hosted_agent', fx);

    expect(verdict).toMatchObject({ outcome: 'reserved', pool: 5, census: { total: 2 } });
    expect((await orgCensus(fx)).total).toBe(3);
  });

  // The org row's `fleetPoolCap` overrides CI's figure alone, never a hosted run's.
  it("the org's CI override does not move a hosted run's verdict", async () => {
    const fx = await seedTenant();
    await adminDb.organization.update({
      where: { id: fx.organizationId },
      data: { fleetPoolCap: 0 },
    });
    for (let i = 0; i < 5; i += 1) {
      expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
        outcome: 'reserved',
        pool: 5,
      });
    }
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ reason: 'plan_cap' });
  });

  // An `own`-pool workload is bounded by its guard alone (agent-instances.md
  // AMENDMENT 2): it neither counts toward nor is refused by the org's pool.
  it('agent instances are bounded by their guard and counted in no shared total', async () => {
    const fx = await seedTenant();
    await reserve('hosted_agent', fx);

    const { verdict } = await reserve('agent_instance', fx);
    expect(verdict).toMatchObject({ outcome: 'reserved', pool: null });
    expect((await orgCensus(fx)).total).toBe(1);
  });
});

// ── The kill switch (§6) ────────────────────────────────────────────────────

describe('MOTIR_FLEET_MAX_IN_FLIGHT is the kill switch, and only that', () => {
  it('ZERO stops EVERY workload of every org', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const fx = await seedTenant();

    for (const workload of ['code_graph_index', 'hosted_agent', 'agent_instance'] as const) {
      expect((await reserve(workload, fx)).verdict).toMatchObject({
        outcome: 'deferred',
        reason: 'fleet_ceiling',
        detail: expect.stringContaining('kill switch'),
      });
    }
    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'fleet_ceiling',
    });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  // The retired default (24) an environment may still carry, or any positive
  // number, imposes NO platform ceiling: 30 containers across two orgs boot.
  it.each(['', '24', '2'])('a value of %j imposes no platform ceiling', async (raw) => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', raw);
    const a = await seedTenant();
    const b = await seedTenant();
    // Hosted runs stop at the plan's figure (Max ×2: 5, MOTIR-9373), so the
    // bulk is index slots, which no plan figure holds.
    for (let i = 0; i < 5; i += 1) {
      expect((await reserve('hosted_agent', a)).verdict.outcome).toBe('reserved');
    }
    for (let i = 0; i < 10; i += 1) {
      expect((await reserve('code_graph_index', a)).verdict.outcome).toBe('reserved');
    }
    for (let i = 0; i < 15; i += 1) {
      expect((await reserve('code_graph_index', b)).verdict.outcome).toBe('reserved');
    }
    expect((await census()).total).toBe(30);
  });
});

// ── An org-less request is refused ──────────────────────────────────────────

describe('a slot with no organisation is refused (criterion 5)', () => {
  it.each(['', '   '])('refuses organizationId %j and writes nothing', async (organizationId) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const verdict = await fleetCeilingService.reserve(
      { workload: 'hosted_agent', ref: 'orgless', organizationId, ttlSeconds: TTL_SECONDS },
      NOW,
    );
    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'organization_required' });
    expect(error).toHaveBeenCalled();
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('refuses a request whose organizationId is missing at runtime', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const verdict = await fleetCeilingService.reserve(
      { workload: 'code_graph_index', ref: 'orgless-2' } as unknown as Parameters<
        typeof fleetCeilingService.reserve
      >[0],
      NOW,
    );
    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'organization_required' });
  });

  // The column itself enforces it too, so no writer can slip one past the type.
  it('the slot table refuses a row with no organisation', async () => {
    await expect(
      adminDb.$executeRawUnsafe(
        `INSERT INTO "fleet_in_flight_slot" ("id","workload","ref","claimed_at","expires_at","created_at","updated_at")
         VALUES ('orgless-row','hosted_agent','x',NOW(),NOW() + interval '1 hour',NOW(),NOW())`,
      ),
    ).rejects.toThrow();
  });
});

// ── Completion frees a slot, whoever's container it was ─────────────────────

describe('completion frees a slot for ANY workload of the org', () => {
  it('a CI runner ending lets the same org’s queued CI job through', async () => {
    const fx = await seedTenant({ ciBurstCap: 1 });
    const running = await seedIntent(fx, { status: 'running' });
    const queued = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(queued)).toMatchObject({ reason: 'plan_cap' });

    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: running.id },
      data: { status: 'completed', settledAt: new Date(), teardownReason: 'job_completed' },
    });

    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect((await ciRunnerAdmissionService.admit(after)).outcome).toBe('admitted');
  });

  it('a hosted run ending lets the same org’s next hosted run through', async () => {
    stubPaidAiPlan('standard');
    const fx = await seedTenant();
    const { ref } = await reserve('hosted_agent', fx);

    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ reason: 'plan_cap' });

    await fleetCeilingService.release('hosted_agent', ref);

    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      outcome: 'reserved',
    });
  });

  it('releasing a slot that was never held is visible, not silent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fleetCeilingService.release('hosted_agent', 'never-taken')).toBe(false);
  });

  it('LOGS and keeps going when the release write fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetInFlightSlotRepository, 'release').mockRejectedValue(new Error('conn reset'));

    expect(await fleetCeilingService.release('code_graph_index', 'whatever')).toBe(false);
    expect(error).toHaveBeenCalled();
  });
});

// ── The real-concurrency contract ───────────────────────────────────────────

describe('the pool holds under REAL concurrency (notes.html #35)', () => {
  // ⚠️ MUTATION-CHECK THIS TEST: comment out the `lockScope` call in
  // `fleetCeilingService.reserve` (and/or in `ciRunnerAdmissionService.admit`)
  // and it MUST go red. Every racer then reads the same "0 in flight" snapshot
  // and all of them take a slot.
  //
  // It races TWO ORGS at once (criterion 1): org A's CI bursts past its CI
  // figure at the CI gate while org B's CI and hosted runs burst inside theirs,
  // in the same instant. Org A is held to exactly its figure; every one of org
  // B's containers is admitted. (A hosted run's own race is in
  // planCapAdmission.test.ts.)
  it("holds org A at its CI figure while org B's concurrent burst is admitted in full", async () => {
    const a = await seedTenant({ ciBurstCap: 4 });
    const b = await seedTenant({ ciBurstCap: 4 });
    const aIntents = await Promise.all([1, 2, 3, 4, 5, 6].map(() => seedIntent(a)));
    const bIntents = await Promise.all([1, 2].map(() => seedIntent(b)));

    const [aResults, bResults] = await Promise.all([
      Promise.all(aIntents.map((intent) => ciRunnerAdmissionService.admit(intent))),
      Promise.all([
        ...bIntents.map((intent) => ciRunnerAdmissionService.admit(intent)),
        ...[1, 2].map(() => reserve('hosted_agent', b).then((r) => r.verdict)),
      ]),
    ]);

    const wonA = aResults.filter((r) => r.outcome === 'admitted');
    const lostA = aResults.filter((r) => r.outcome === 'deferred');
    expect(wonA).toHaveLength(4);
    expect(lostA).toHaveLength(2);
    for (const lost of lostA) expect(lost).toMatchObject({ reason: 'plan_cap' });

    // Org B was never deferred for org A's load.
    expect(bResults.every((r) => r.outcome === 'admitted' || r.outcome === 'reserved')).toBe(true);

    expect((await orgCensus(a)).total).toBe(4);
    expect((await orgCensus(b)).total).toBe(4);
    expect((await census()).total).toBe(8);
  });

  it('two reservations of the SAME ref take exactly one slot', async () => {
    const fx = await seedTenant();

    const verdicts = await Promise.all([
      reserve('code_graph_index', fx, 'same-run').then((r) => r.verdict),
      reserve('code_graph_index', fx, 'same-run').then((r) => r.verdict),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'reserved')).toHaveLength(1);
    expect(verdicts.filter((v) => v.outcome === 'already_held')).toHaveLength(1);
    expect((await orgCensus(fx)).total).toBe(1);
  });

  // A redelivery of a job that is ALREADY running must not be judged against the
  // pool: it occupies capacity it already holds.
  it('an already-held ref is admitted even when the org is at its plan figure', async () => {
    stubPaidAiPlan('standard');
    const fx = await seedTenant();
    const { ref } = await reserve('hosted_agent', fx, 'redelivered');
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ reason: 'plan_cap' });

    const { verdict } = await reserve('hosted_agent', fx, ref);

    expect(verdict).toMatchObject({ outcome: 'already_held' });
    expect((await orgCensus(fx)).total).toBe(1);
  });
});

// ── Fail CLOSED ─────────────────────────────────────────────────────────────

describe('the pool fails CLOSED', () => {
  it('DECLINES AND LOGS a reservation when a workload counter throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(
      ciRunnerProvisioningIntentRepository,
      'countInFlightForOrganization',
    ).mockRejectedValue(new Error('connection reset'));
    const fx = await seedTenant();

    const { verdict } = await reserve('code_graph_index', fx);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(error).toHaveBeenCalled();
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  // A NON-CI counter failing must stop a CI boot, which is only true because
  // the org's pool is one number over every workload.
  it('DECLINES a CI admission when the SLOT counter throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetInFlightSlotRepository, 'countLiveForWorkloadInOrganization').mockRejectedValue(
      new Error('connection reset'),
    );
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after.status).toBe('pending');
    expect(error).toHaveBeenCalled();
  });

  // An org whose pool cannot be READ is not handed the default.
  it("DECLINES when the org's pool cannot be read", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(organizationRepository, 'findFleetPoolCapInTx').mockRejectedValue(
      new Error('connection reset'),
    );
    const fx = await seedTenant();

    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      outcome: 'deferred',
      reason: 'gate_unavailable',
    });
    expect(error).toHaveBeenCalled();
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('DECLINES AND LOGS when the shared admission lock cannot be taken', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ciFleetAdmissionLockRepository, 'lockScope').mockResolvedValue(false);
    const fx = await seedTenant();

    const { verdict } = await reserve('code_graph_index', fx);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(error).toHaveBeenCalled();
  });
});

// ── No bypass ───────────────────────────────────────────────────────────────

describe('nothing bypasses a staff override of the CI figure', () => {
  // A staff override holds Motir's own orgs at the CI gate too (MOTIR-9375).
  // (A hosted run's plan figure exempts them — `planCapAdmission.test.ts`.)
  it('the META org is held by its CI override', async () => {
    const meta = await seedTenant({ isMeta: true, ciBurstCap: 2 });
    await seedIntent(meta, { status: 'running' });
    await seedIntent(meta, { status: 'running' });

    expect(await ciRunnerAdmissionService.admit(await seedIntent(meta))).toMatchObject({
      outcome: 'deferred',
      reason: 'plan_cap',
    });
  });

  it('MOTIR_CLOUD=false does not lift it either', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const fx = await seedTenant({ ciBurstCap: 1 });
    await seedIntent(fx, { status: 'running' });

    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'plan_cap',
    });
  });

  // §6: the per-project tier caps are retired — one project may use its org's
  // whole CI figure.
  it('one project may use the whole org CI figure (no per-project cap)', async () => {
    const fx = await seedTenant({ ciBurstCap: 5 });
    for (let i = 0; i < 5; i += 1) {
      expect((await ciRunnerAdmissionService.admit(await seedIntent(fx))).outcome).toBe('admitted');
    }
    expect(await ciRunnerAdmissionService.admit(await seedIntent(fx))).toMatchObject({
      reason: 'plan_cap',
    });
  });
});

// ── The expiry safety net ───────────────────────────────────────────────────

describe('the expiry safety net', () => {
  it('stops counting a slot whose safety net has passed', async () => {
    stubPaidAiPlan('standard');
    const fx = await seedTenant();
    await reserve('hosted_agent', fx);
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ reason: 'plan_cap' });

    const later = new Date(NOW.getTime() + (TTL_SECONDS + 60) * 1_000);
    const { verdict } = await reserve('hosted_agent', fx, 'after-expiry', later);

    expect(verdict).toMatchObject({ outcome: 'reserved' });
  });

  it('keeps counting a slot that is still inside its budget', async () => {
    const fx = await seedTenant();
    await reserve('code_graph_index', fx);

    const almost = new Date(NOW.getTime() + (TTL_SECONDS - 60) * 1_000);
    expect((await orgCensus(fx, almost)).byWorkload['code_graph_index']).toBe(1);
  });

  it('sweeps expired rows without touching live ones', async () => {
    const fx = await seedTenant();
    const { ref: stale } = await reserve('code_graph_index', fx);
    const later = new Date(NOW.getTime() + (TTL_SECONDS + 60) * 1_000);
    await reserve('hosted_agent', fx, 'live', later);

    expect(await fleetCeilingService.sweepExpired(later)).toBe(1);
    expect(
      await withSystemContext((tx) =>
        fleetInFlightSlotRepository.findByRef('code_graph_index', stale, tx),
      ),
    ).toBeNull();
    expect(
      await withSystemContext((tx) =>
        fleetInFlightSlotRepository.findByRef('hosted_agent', 'live', tx),
      ),
    ).not.toBeNull();
  });
});

// ── The reserve path's remaining edges ──────────────────────────────────────

describe('the slot reservation’s defaults and its own race', () => {
  it('falls back to the CONFIGURED TTL when the caller names none', async () => {
    vi.stubEnv('MOTIR_FLEET_SLOT_TTL_SECONDS', '120');
    const fx = await seedTenant();
    const before = Date.now();

    const verdict = await fleetCeilingService.reserve({
      workload: 'code_graph_index',
      ref: 'ttl-default-1',
      organizationId: fx.organizationId,
    });

    expect(verdict.outcome).toBe('reserved');
    const slot = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.findByRef('code_graph_index', 'ttl-default-1', tx),
    );
    expect(slot?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000 - 5_000);
    expect(slot?.expiresAt.getTime()).toBeLessThanOrEqual(before + 120_000 + 5_000);
    expect(slot?.organizationId).toBe(fx.organizationId);
  });

  it('a LOST INSERT RACE reports `already_held`, never a second slot', async () => {
    const fx = await seedTenant();
    await fleetCeilingService.reserve({
      workload: 'hosted_agent',
      ref: 'raced-ref',
      organizationId: fx.organizationId,
    });
    vi.spyOn(fleetInFlightSlotRepository, 'findByRef').mockResolvedValue(null);

    const verdict = await fleetCeilingService.reserve({
      workload: 'hosted_agent',
      ref: 'raced-ref',
      organizationId: fx.organizationId,
    });

    expect(verdict).toEqual({ outcome: 'already_held' });
    const held = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.countLiveForWorkload('hosted_agent', new Date(), tx),
    );
    expect(held).toBe(1);
  });

  it('reports a NON-ERROR rejection as `unknown` rather than losing it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    vi.spyOn(ciFleetAdmissionLockRepository, 'ensureScope').mockRejectedValue('a bare string');

    const verdict = await fleetCeilingService.reserve({
      workload: 'code_graph_index',
      ref: 'non-error-1',
      organizationId: fx.organizationId,
    });

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'gate_unavailable' });
    expect(verdict).toMatchObject({ detail: expect.stringContaining('unknown') });
    expect(error).toHaveBeenCalled();
  });
});

describe('adopt — the transition winner takes a held slot (MOTIR-7492)', () => {
  const findSlot = (ref: string) =>
    withSystemContext((tx) => fleetInFlightSlotRepository.findByRef('agent_instance', ref, tx));

  it('RESTAMPS a slot another run reserved, so that run’s release removes nothing', async () => {
    const fx = await seedTenant();
    await fleetCeilingService.reserve(
      {
        workload: 'agent_instance',
        ref: 'inst-1',
        ownerRef: 'run-loser',
        organizationId: fx.organizationId,
        workspaceId: fx.workspaceId,
        ttlSeconds: TTL_SECONDS,
      },
      NOW,
    );
    const later = new Date(NOW.getTime() + 60_000);

    const adopted = await fleetCeilingService.adopt(
      {
        workload: 'agent_instance',
        ref: 'inst-1',
        ownerRef: 'run-winner',
        organizationId: fx.organizationId,
        workspaceId: fx.workspaceId,
        ttlSeconds: TTL_SECONDS,
      },
      later,
    );

    expect(adopted).toBe(true);
    const slot = await findSlot('inst-1');
    expect(slot?.ownerRef).toBe('run-winner');
    expect(slot?.expiresAt.getTime()).toBe(later.getTime() + TTL_SECONDS * 1_000);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fleetCeilingService.release('agent_instance', 'inst-1', 'run-loser')).toBe(false);
    expect(await fleetCeilingService.release('agent_instance', 'inst-1', 'run-winner')).toBe(true);
    expect(await findSlot('inst-1')).toBeNull();
  });

  it('PUTS BACK a slot the losing run already released', async () => {
    const fx = await seedTenant();

    expect(
      await fleetCeilingService.adopt({
        workload: 'agent_instance',
        ref: 'inst-2',
        ownerRef: 'run-winner',
        organizationId: fx.organizationId,
        workspaceId: fx.workspaceId,
        ttlSeconds: TTL_SECONDS,
      }),
    ).toBe(true);

    const all = await adminDb.fleetInFlightSlot.findMany({ where: { ref: 'inst-2' } });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      workload: 'agent_instance',
      ownerRef: 'run-winner',
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
    });
  });

  it('fails soft: a write that throws is logged and reported, never thrown', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    vi.spyOn(fleetInFlightSlotRepository, 'adopt').mockRejectedValue(new Error('db down'));

    expect(
      await fleetCeilingService.adopt({
        workload: 'agent_instance',
        ref: 'inst-3',
        ownerRef: 'run-winner',
        organizationId: fx.organizationId,
      }),
    ).toBe(false);
    expect(error).toHaveBeenCalledWith(
      '[fleetCeilingService] could not adopt a fleet slot',
      expect.objectContaining({ ref: 'inst-3', detail: 'db down' }),
    );
  });
});

// ── WHICH AGENT-RUNNER ACCOUNT a hosted run boots on (MOTIR-9421) ───────────
//
// `reserve` chooses the account inside its locked transaction and writes it on
// the slot, so the per-account count is the slots carrying that account. The
// switch is `MOTIR_FLEET_AGENT_RUNNER_PROVIDER`, read on every admission.

async function hostedAccount(
  machineLimit: number,
  fleetKind: 'hosted_agent' | 'ci_runner' = 'hosted_agent',
): Promise<FleetShard> {
  const slug = randomToken(6).toLowerCase();
  return adminDb.fleetShard.create({
    data: {
      name: `acct-${slug}`,
      fleetKind,
      provider: 'fly',
      state: 'active',
      githubOrg: MOTIR_ORG,
      githubInstallationId: '556677',
      flyOrg: 'motir',
      flyApp: `motir-agents-${slug}`,
      flyRegion: 'iad',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      machineLimit,
    },
  });
}

/** `count` live hosted slots on `shard`, for orgs other than the one reserving. */
async function liveHostedOn(shard: FleetShard, count: number, expiresAt?: Date): Promise<void> {
  const other = await seedTenant();
  for (let i = 0; i < count; i += 1) {
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'hosted_agent',
          ref: `live-${shard.id}-${(refSeq += 1)}`,
          organizationId: other.organizationId,
          fleetShardId: shard.id,
          expiresAt: expiresAt ?? new Date(NOW.getTime() + TTL_SECONDS * 1_000),
        },
        tx,
      ),
    );
  }
}

async function slotShard(workload: string, ref: string): Promise<string | null | undefined> {
  const row = await adminDb.fleetInFlightSlot.findUnique({
    where: { workload_ref: { workload, ref } },
  });
  return row?.fleetShardId;
}

describe('a hosted run is placed on an agent-runner account (MOTIR-9421)', () => {
  it('switch unset or fly: reserved on Fly with no account, whatever accounts exist', async () => {
    await hostedAccount(10);
    const fx = await seedTenant();
    for (const value of ['', 'fly']) {
      vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, value);
      const { ref, verdict } = await reserve('hosted_agent', fx);
      expect(verdict).toMatchObject({ outcome: 'reserved', fleetShardId: null });
      expect(await slotShard('hosted_agent', ref)).toBeNull();
    }
  });

  it('switch aws: the hosted account with the most headroom, never a CI account', async () => {
    const a = await hostedAccount(2);
    const b = await hostedAccount(5);
    const ci = await hostedAccount(50, 'ci_runner');
    await liveHostedOn(a, 1);
    await liveHostedOn(b, 1);
    // A CI intent on B is not a hosted slot: it does not count against B.
    const fx = await seedTenant();
    const intent = await seedIntent(fx, { status: 'running' });
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: intent.id },
      data: { fleetShardId: b.id },
    });
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');

    const { ref, verdict } = await reserve('hosted_agent', fx);

    expect(verdict).toMatchObject({ outcome: 'reserved', fleetShardId: b.id });
    expect(await slotShard('hosted_agent', ref)).toBe(b.id);
    expect(await slotShard('hosted_agent', ref)).not.toBe(ci.id);
  });

  it('switch aws, every account full: shard_capacity, no slot; a release frees A', async () => {
    const a = await hostedAccount(1);
    const b = await hostedAccount(1);
    await liveHostedOn(a, 1);
    await liveHostedOn(b, 1);
    const fx = await seedTenant();
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');

    const { ref, verdict } = await reserve('hosted_agent', fx);
    expect(verdict).toEqual({
      outcome: 'deferred',
      reason: 'shard_capacity',
      detail: HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
    });
    expect(await slotShard('hosted_agent', ref)).toBeUndefined();

    const onA = await adminDb.fleetInFlightSlot.findFirstOrThrow({ where: { fleetShardId: a.id } });
    await fleetCeilingService.release('hosted_agent', onA.ref);
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      outcome: 'reserved',
      fleetShardId: a.id,
    });
  });

  it('switch aws, no hosted account at all: shard_capacity, never Fly', async () => {
    await hostedAccount(50, 'ci_runner');
    const fx = await seedTenant();
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    const { verdict } = await reserve('hosted_agent', fx);
    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'shard_capacity' });
  });

  it('an org at its plan figure with a full pool is told plan_cap; the kill switch still wins', async () => {
    const a = await hostedAccount(1);
    await liveHostedOn(a, 1);
    const fx = await seedTenant();
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    // The org's own five hosted runs (Max: agentRunsInParallel 5), on Fly before the flip.
    for (let i = 0; i < 5; i += 1) {
      vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'fly');
      expect((await reserve('hosted_agent', fx)).verdict.outcome).toBe('reserved');
    }
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      outcome: 'deferred',
      reason: 'plan_cap',
    });

    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const readShards = vi.spyOn(fleetShardAdmissionService, 'chooseInTx');
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
    });
    expect(readShards).not.toHaveBeenCalled();
  });

  it('two orgs racing for the one free slot: one reserved, one shard_capacity', async () => {
    const a = await hostedAccount(2);
    await liveHostedOn(a, 1);
    const x = await seedTenant();
    const y = await seedTenant();
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');

    const results = await Promise.all([reserve('hosted_agent', x), reserve('hosted_agent', y)]);
    const outcomes = results.map((r) => r.verdict.outcome).sort();
    expect(outcomes).toEqual(['deferred', 'reserved']);
    expect(results.find((r) => r.verdict.outcome === 'deferred')?.verdict).toMatchObject({
      reason: 'shard_capacity',
    });
    expect(await adminDb.fleetInFlightSlot.count({ where: { fleetShardId: a.id } })).toBe(2);
  });

  it('a flip between two reserves changes the second placement, and no other kind', async () => {
    const a = await hostedAccount(5);
    const fx = await seedTenant();
    const before = await Promise.all(
      (['ci_runner', 'code_graph_index', 'agent_instance'] as const).map((k) => fleetKindOnPool(k)),
    );
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'fly');
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ fleetShardId: null });
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ fleetShardId: a.id });
    const after = await Promise.all(
      (['ci_runner', 'code_graph_index', 'agent_instance'] as const).map((k) => fleetKindOnPool(k)),
    );
    expect(after).toEqual(before);
    expect(after).toEqual([false, false, false]);
  });

  it('an agent_instance slot carries no account, with the switch on', async () => {
    await hostedAccount(5);
    const fx = await seedTenant();
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    const { ref, verdict } = await reserve('agent_instance', fx);
    expect(verdict).toMatchObject({ outcome: 'reserved', fleetShardId: null });
    expect(await slotShard('agent_instance', ref)).toBeNull();
  });
});

describe('fleetInFlightSlotRepository and the account column (MOTIR-9421)', () => {
  const expiresAt = new Date(NOW.getTime() + TTL_SECONDS * 1_000);

  it('take writes the account; adopt without one keeps it', async () => {
    const a = await hostedAccount(5);
    const fx = await seedTenant();
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'hosted_agent',
          ref: 'r1',
          ownerRef: 'run-1',
          organizationId: fx.organizationId,
          fleetShardId: a.id,
          expiresAt,
        },
        tx,
      ),
    );
    expect(await slotShard('hosted_agent', 'r1')).toBe(a.id);
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.adopt(
        {
          workload: 'hosted_agent',
          ref: 'r1',
          ownerRef: 'run-2',
          organizationId: fx.organizationId,
          workspaceId: null,
          expiresAt,
        },
        tx,
      ),
    );
    const row = await adminDb.fleetInFlightSlot.findUniqueOrThrow({
      where: { workload_ref: { workload: 'hosted_agent', ref: 'r1' } },
    });
    expect(row).toMatchObject({ ownerRef: 'run-2', fleetShardId: a.id });
  });

  it('the per-account count excludes expired rows and other workloads', async () => {
    const a = await hostedAccount(5);
    await liveHostedOn(a, 2);
    await liveHostedOn(a, 1, new Date(NOW.getTime() - 1_000));
    const fx = await seedTenant();
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'code_graph_index',
          ref: 'idx',
          organizationId: fx.organizationId,
          fleetShardId: a.id,
          expiresAt,
        },
        tx,
      ),
    );
    const count = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.countLiveForWorkloadOnShardInTx('hosted_agent', a.id, NOW, tx),
    );
    expect(count).toBe(2);
  });

  it('reassignShardInTx moves only the row its owner holds', async () => {
    const a = await hostedAccount(5);
    const b = await hostedAccount(5);
    const fx = await seedTenant();
    await withSystemContext((tx) =>
      fleetInFlightSlotRepository.take(
        {
          workload: 'hosted_agent',
          ref: 'r2',
          ownerRef: 'run-a',
          organizationId: fx.organizationId,
          fleetShardId: a.id,
          expiresAt,
        },
        tx,
      ),
    );
    const moved = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.reassignShardInTx('hosted_agent', 'r2', 'run-b', b.id, tx),
    );
    expect(moved).toBe(false);
    expect(await slotShard('hosted_agent', 'r2')).toBe(a.id);
    const movedOwn = await withSystemContext((tx) =>
      fleetInFlightSlotRepository.reassignShardInTx('hosted_agent', 'r2', 'run-a', b.id, tx),
    );
    expect(movedOwn).toBe(true);
    expect(await slotShard('hosted_agent', 'r2')).toBe(b.id);
  });
});
