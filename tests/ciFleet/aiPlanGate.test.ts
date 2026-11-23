import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  _resetAiPlanCache,
  aiPlanGateService,
  isPaidAiSubscriptionStatus,
  AI_PLAN_REQUIRED_ADMISSION_DETAIL,
  PLAN_UNKNOWN_ADMISSION_DETAIL,
} from '@/lib/services/aiPlanGateService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// THE PAID-AI-PLAN GATE (Story MOTIR-6906 · MOTIR-6909) against real Postgres —
// `docs/decisions/fleet-per-org-pool.md`: the fleet is paid-AI-plan only.
//
// The org rows, the admission lock and the intent's compare-and-set are REAL; the
// one thing stubbed is motir-ai's HTTP boundary (global `fetch`), because the
// subscription is by definition on the other side of it. Every admission case
// asserts the intent is still PENDING and no slot was taken: a plan refusal is a
// deferral that spends nothing, never a claim that is then given back.

const PASSWORD = 'hunter2hunter2';
const NOW = new Date('2026-07-15T12:00:00.000Z');

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(
  flags: { isMeta?: boolean; internalBilling?: boolean } = {},
): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `ai-plan-gate-${suffix}@example.com`,
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
  if (flags.isMeta || flags.internalBilling) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: flags.isMeta ?? false, internalBilling: flags.internalBilling ?? false },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

async function seedIntent(fx: Fixture): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(90_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: 'pending',
    },
  });
}

/** motir-ai: the subscription read answers `status` (or fails with `subscriptionHttp`);
 *  the balance read always has credit, so only the PLAN can refuse. */
function stubMotirAi(
  opts: { status?: string | null; subscriptionHttp?: number } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const u = String(url);
    if (u.includes('/v1/stripe/subscription')) {
      if (opts.subscriptionHttp) {
        return new Response(
          JSON.stringify({ type: 'about:blank', code: 'internal_error', status: 500 }),
          {
            status: opts.subscriptionHttp,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }
      return new Response(
        JSON.stringify({
          status: opts.status === undefined ? 'active' : opts.status,
          currentPeriodEnd: null,
          priceId: null,
          // A real tier, so a paid org's hosted run reads real plan figures
          // (MOTIR-9373) once the gate lets it through.
          planTier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 15_000 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/v1/usage')) {
      return new Response(JSON.stringify({ balance: 1_000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function subscriptionCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([u]) => String(u).includes('/v1/stripe/subscription')).length;
}

async function statusOf(intentId: string): Promise<string> {
  const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
    where: { id: intentId },
  });
  return row.status;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetAiPlanCache();
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The question itself ─────────────────────────────────────────────────────

describe('aiPlanGateService.hasPaidAiPlan — the three answers', () => {
  it('a paid subscription (active, past_due) is a paid plan', async () => {
    for (const status of ['active', 'past_due']) {
      _resetAiPlanCache();
      const fx = await seedTenant();
      stubMotirAi({ status });
      expect(await aiPlanGateService.hasPaidAiPlan(fx.organizationId)).toBe(true);
    }
  });

  it('trialing, canceled and no subscription at all are NOT a paid plan', async () => {
    for (const status of ['trialing', 'canceled', null]) {
      _resetAiPlanCache();
      const fx = await seedTenant();
      stubMotirAi({ status });
      expect(await aiPlanGateService.hasPaidAiPlan(fx.organizationId)).toBe(false);
    }
  });

  it("answers 'unknown' when motir-ai cannot be read — never a guessed yes", async () => {
    const fx = await seedTenant();
    stubMotirAi({ subscriptionHttp: 500 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await aiPlanGateService.hasPaidAiPlan(fx.organizationId)).toBe('unknown');
  });

  it("answers 'unknown' for an organisation row that does not exist", async () => {
    const fetchMock = stubMotirAi();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await aiPlanGateService.hasPaidAiPlan('00000000-0000-4000-8000-000000000000')).toBe(
      'unknown',
    );
    expect(subscriptionCalls(fetchMock)).toBe(0);
  });

  it("answers 'unknown' when the organisation row cannot be read", async () => {
    stubMotirAi();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Not a uuid, so Postgres refuses the read itself.
    expect(await aiPlanGateService.hasPaidAiPlan('not-a-uuid')).toBe('unknown');
  });

  it("Motir's own organisations (isMeta, internalBilling) pass WITHOUT asking motir-ai", async () => {
    const meta = await seedTenant({ isMeta: true });
    const internal = await seedTenant({ internalBilling: true });
    // motir-ai is DOWN: were either asked, it would fail closed.
    const fetchMock = stubMotirAi({ subscriptionHttp: 500 });

    expect(await aiPlanGateService.hasPaidAiPlan(meta.organizationId)).toBe(true);
    expect(await aiPlanGateService.hasPaidAiPlan(internal.organizationId)).toBe(true);
    expect(subscriptionCalls(fetchMock)).toBe(0);
  });

  it('a self-hosted build has no billing, so every org passes with no read at all', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const fetchMock = stubMotirAi({ status: null });
    expect(await aiPlanGateService.hasPaidAiPlan('any-org')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches a yes/no for 30s, and never caches 'unknown'", async () => {
    const fx = await seedTenant();
    const fetchMock = stubMotirAi({ status: 'active' });

    await aiPlanGateService.hasPaidAiPlan(fx.organizationId);
    await aiPlanGateService.hasPaidAiPlan(fx.organizationId);
    expect(subscriptionCalls(fetchMock)).toBe(1);

    vi.setSystemTime(new Date(NOW.getTime() + 31_000));
    await aiPlanGateService.hasPaidAiPlan(fx.organizationId);
    expect(subscriptionCalls(fetchMock)).toBe(2);

    // An unreadable plan is re-asked straight away, so recovery is immediate.
    _resetAiPlanCache();
    const failing = stubMotirAi({ subscriptionHttp: 500 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await aiPlanGateService.hasPaidAiPlan(fx.organizationId)).toBe('unknown');
    expect(await aiPlanGateService.hasPaidAiPlan(fx.organizationId)).toBe('unknown');
    expect(subscriptionCalls(failing)).toBe(2);
  });

  it('isPaidAiSubscriptionStatus is the one list both the panel and the fleet read', () => {
    expect(isPaidAiSubscriptionStatus('active')).toBe(true);
    expect(isPaidAiSubscriptionStatus('past_due')).toBe(true);
    expect(isPaidAiSubscriptionStatus('trialing')).toBe(false);
    expect(isPaidAiSubscriptionStatus('canceled')).toBe(false);
    expect(isPaidAiSubscriptionStatus(null)).toBe(false);
  });
});

// ── Every fleet door asks it — plan, then pool ──────────────────────────────

describe('CI admission — plan before pool', () => {
  it('defers ai_plan_required, with the §4 words, and claims nothing', async () => {
    const fx = await seedTenant();
    stubMotirAi({ status: 'canceled' });
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toEqual({
      outcome: 'deferred',
      reason: 'ai_plan_required',
      detail: AI_PLAN_REQUIRED_ADMISSION_DETAIL,
    });
    expect(await statusOf(intent.id)).toBe('pending');
  });

  it('defers plan_unknown (fail-closed) when the plan cannot be read', async () => {
    const fx = await seedTenant();
    stubMotirAi({ subscriptionHttp: 503 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toEqual({
      outcome: 'deferred',
      reason: 'plan_unknown',
      detail: PLAN_UNKNOWN_ADMISSION_DETAIL,
    });
    expect(await statusOf(intent.id)).toBe('pending');
  });

  it('admits a paid org', async () => {
    const fx = await seedTenant();
    stubMotirAi({ status: 'active' });
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({ outcome: 'admitted' });
  });

  it('admits the meta org with motir-ai unreachable', async () => {
    const fx = await seedTenant({ isMeta: true });
    stubMotirAi({ subscriptionHttp: 500 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({ outcome: 'admitted' });
  });

  it('the kill switch still answers first', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const fx = await seedTenant();
    const fetchMock = stubMotirAi({ status: 'canceled' });
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      reason: 'fleet_ceiling',
    });
    expect(subscriptionCalls(fetchMock)).toBe(0);
  });
});

describe('a shared-pool reservation (hosted-agent runs) — plan before pool', () => {
  function reserve(fx: Fixture) {
    return fleetCeilingService.reserve(
      {
        workload: 'hosted_agent',
        ref: 'run-1',
        organizationId: fx.organizationId,
        workspaceId: fx.workspaceId,
        ttlSeconds: 600,
      },
      NOW,
    );
  }

  it('defers ai_plan_required and takes no slot', async () => {
    const fx = await seedTenant();
    stubMotirAi({ status: 'trialing' });

    expect(await reserve(fx)).toMatchObject({
      outcome: 'deferred',
      reason: 'ai_plan_required',
      detail: AI_PLAN_REQUIRED_ADMISSION_DETAIL,
    });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('defers plan_unknown and takes no slot', async () => {
    const fx = await seedTenant();
    stubMotirAi({ subscriptionHttp: 500 });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await reserve(fx)).toMatchObject({ outcome: 'deferred', reason: 'plan_unknown' });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('reserves for a paid org', async () => {
    const fx = await seedTenant();
    stubMotirAi({ status: 'active' });

    expect(await reserve(fx)).toMatchObject({ outcome: 'reserved' });
  });
});
