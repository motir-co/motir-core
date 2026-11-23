import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  _resetAiPlanCache,
  aiPlanGateService,
  AI_PLAN_REQUIRED_ADMISSION_DETAIL,
  AI_PLAN_REQUIRED_ESTABLISH_MESSAGE,
} from '@/lib/services/aiPlanGateService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { AiPlanRequiredError } from '@/lib/projectRepos/errors';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// AN ORG A PLATFORM ADMIN PUT ON A PAID TIER, WITH NO SUBSCRIPTION (bug MOTIR-8985).
//
// The admin console's **Change plan** sets `AiOrganization.planTierId` through
// motir-ai's tier assignment and touches no Stripe object, so for such an org
// motir-ai answers exactly what this file fakes: the subscription read is the
// EMPTY shape (`status: null`, no tier — `getOrgSubscription` resolves the tier
// only from a subscription row), and the usage read names the assigned tier with
// the credits staff granted.
//
// The decided answer is ONE answer: **not paid** (`aiPlanGateService`'s header).
// Every door that spends the fleet asks the same gate, so each one refuses it the
// same way — and each is asserted here against that one faked read, so a door
// that grew its own reading of the tier would fail this file rather than drift.
// The agent lane's create and wake ask the same gate, and are asserted with the
// same answer in `tests/agentInstances/agentInstanceLifecycleService.test.ts`
// (the agent fixture lives there).
//
// Real Postgres throughout; the ONLY fake is motir-ai's HTTP boundary (`fetch`),
// and every refusal also asserts nothing was taken.

const NOW = new Date('2026-07-15T12:00:00.000Z');

/** The tier the admin assigned — what motir-ai's usage read reports for the org. */
const ASSIGNED_TIER = { key: 'pro', name: 'Pro', monthlyCreditAllotment: 15_000 };

let calls: string[];

/** motir-ai, as it answers for an org on an admin-assigned tier. Any other
 *  request (GitHub above all) is recorded and refused, so a door that reached
 *  past the gate shows up in `calls`. */
function stubAdminAssignedOrg(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/v1/stripe/subscription')) {
        return json({ status: null, currentPeriodEnd: null, priceId: null, planTier: null });
      }
      if (url.includes('/v1/usage')) {
        return json({ balance: 5_300, tier: ASSIGNED_TIER });
      }
      return new Response('not faked', { status: 599 });
    }),
  );
}

const outsideMotirAi = () => calls.filter((u) => !u.startsWith('https://ai.test/'));

let fx: WorkItemFixture;
let jobSeq = 0;

async function seedIntent(): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(80_000 + jobSeq),
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

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetAiPlanCache();
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  fx = await makeWorkItemFixture();
  stubAdminAssignedOrg();
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

describe('an admin-assigned paid tier with no subscription is NOT a paid plan — at every door', () => {
  it('hasPaidAiPlan answers false, and the org row carries no exemption', async () => {
    const org = await adminDb.organization.findUniqueOrThrow({
      where: { id: fx.workspace.organizationId },
    });
    expect({ isMeta: org.isMeta, internalBilling: org.internalBilling }).toEqual({
      isMeta: false,
      internalBilling: false,
    });

    expect(await aiPlanGateService.hasPaidAiPlan(fx.workspace.organizationId)).toBe(false);
  });

  it('hosted-repository creation refuses ai_plan_required before touching GitHub', async () => {
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'acme-web' },
      fx.ctx,
    );

    const attempt = projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    await expect(attempt).rejects.toBeInstanceOf(AiPlanRequiredError);
    await expect(attempt).rejects.toThrow(AI_PLAN_REQUIRED_ESTABLISH_MESSAGE);
    expect(outsideMotirAi()).toEqual([]);
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows.find((r) => r.id === row.id)).toMatchObject({ established: false });
  });

  it('CI admission defers ai_plan_required and claims nothing', async () => {
    const intent = await seedIntent();

    expect(await ciRunnerAdmissionService.admit(intent)).toEqual({
      outcome: 'deferred',
      reason: 'ai_plan_required',
      detail: AI_PLAN_REQUIRED_ADMISSION_DETAIL,
    });
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after.status).toBe('pending');
  });

  it('a hosted-agent pool reservation defers ai_plan_required and takes no slot', async () => {
    const verdict = await fleetCeilingService.reserve(
      {
        workload: 'hosted_agent',
        ref: 'run-1',
        organizationId: fx.workspace.organizationId,
        workspaceId: fx.workspaceId,
        ttlSeconds: 600,
      },
      NOW,
    );

    expect(verdict).toMatchObject({
      outcome: 'deferred',
      reason: 'ai_plan_required',
      detail: AI_PLAN_REQUIRED_ADMISSION_DETAIL,
    });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('classifying the same org as internal billing is what makes every door answer yes', async () => {
    await adminDb.organization.update({
      where: { id: fx.workspace.organizationId },
      data: { internalBilling: true },
    });

    expect(await aiPlanGateService.hasPaidAiPlan(fx.workspace.organizationId)).toBe(true);
    expect(await ciRunnerAdmissionService.admit(await seedIntent())).toMatchObject({
      outcome: 'admitted',
    });
  });
});
