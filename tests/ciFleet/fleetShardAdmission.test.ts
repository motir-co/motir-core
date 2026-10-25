import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent, FleetShard } from '@/generated/prisma/client';
import {
  OrchestratorApiError,
  OrchestratorCapacityError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  OrchestratorTimeoutError,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SHARD_PAUSE_SECONDS, wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import {
  classifyProvisionRefusal,
  fleetShardAdmissionService,
  HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
  SHARD_CAPACITY_DETAIL,
} from '@/lib/services/fleetShardAdmissionService';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { AGENT_RUNNER_PROVIDER_ENV_VAR } from '@/lib/ciFleet/fleetKindSwitches';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// ADMISSION PICKS THE ACCOUNT PER JOB (Story MOTIR-8953 · MOTIR-8968), against
// real Postgres: the kind's switch, the account with the most headroom, the
// override, the pause, the `shard_capacity` deferral, the selection seam, and a
// genuine race for the last free slot. `fleet-per-org-pool.md` AMENDMENT 1 §A1.5.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-07-15T12:00:00.000Z');

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `shard-admission-${suffix}@example.com`,
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
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

async function seedIntent(
  fx: Fixture,
  overrides: { status?: string; fleetShardId?: string | null } = {},
): Promise<CiRunnerProvisioningIntent> {
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
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: overrides.status ?? 'pending',
      fleetShardId: overrides.fleetShardId ?? null,
    },
  });
}

async function account(
  machineLimit: number,
  overrides: Partial<{
    fleetKind: string;
    role: 'primary' | 'spare';
    admissionCeilingOverride: number | null;
    admissionPausedUntil: Date | null;
  }> = {},
): Promise<FleetShard> {
  const slug = randomToken(6).toLowerCase();
  return adminDb.fleetShard.create({
    data: {
      name: `acct-${slug}`,
      fleetKind: overrides.fleetKind ?? 'ci_runner',
      provider: 'fly',
      role: overrides.role ?? 'primary',
      state: 'active',
      githubOrg: MOTIR_ORG,
      githubInstallationId: '556677',
      flyOrg: 'motir',
      flyApp: `motir-ci-${slug}`,
      flyRegion: 'iad',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      machineLimit,
      admissionCeilingOverride: overrides.admissionCeilingOverride ?? null,
      admissionPausedUntil: overrides.admissionPausedUntil ?? null,
    },
  });
}

/** Fill `count` slots of an account with running intents. */
async function occupy(fx: Fixture, shard: FleetShard, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await seedIntent(fx, { status: 'running', fleetShardId: shard.id });
  }
}

async function rowOf(id: string): Promise<CiRunnerProvisioningIntent> {
  return adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  // A pool large enough that the org's pool never masks the account's ceiling.
  vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '100');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      if (String(url).includes('/v1/usage')) {
        return new Response(JSON.stringify({ balance: 1_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }),
  );
});

afterEach(async () => {
  wireFleetKindSwitch('ci_runner', null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the switch', () => {
  it('a kind whose switch is Fly is claimed with no account, whatever accounts exist', async () => {
    const fx = await seedTenant();
    await account(50);
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'admitted', fleetShardId: null });
    const row = await rowOf(intent.id);
    expect(row.fleetShardId).toBeNull();
    expect(row.fleetShardMoveReason).toBeNull();
  });
});

describe('most headroom, per job', () => {
  it('takes the CI account with the most room, never another kind’s', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const a = await account(5);
    const b = await account(8);
    await account(500, { fleetKind: 'hosted_agent' });
    await occupy(fx, a, 3); // A: 2 free
    await occupy(fx, b, 3); // B: 5 free
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'admitted', fleetShardId: b.id });
    const row = await rowOf(intent.id);
    expect(row).toMatchObject({ status: 'provisioning', fleetShardId: b.id });
    expect(row.fleetShardMoveReason).toBeNull();
  });

  it('breaks a tie on the lowest id', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const a = await account(4);
    const b = await account(4);
    const intent = await seedIntent(fx);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ fleetShardId: a.id < b.id ? a.id : b.id });
  });

  it('uses a lower override, and an override below in-flight takes the account out', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const a = await account(10);
    const b = await account(50, { admissionCeilingOverride: 6 });
    await occupy(fx, a, 3); // A: 7 free
    await occupy(fx, b, 1); // B: 5 free under its override, 49 derived
    expect(fleetShardAdmissionService.effectiveCeiling(b)).toBe(6);

    const first = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(first)).toMatchObject({ fleetShardId: a.id });

    // Lower A's override below its in-flight: the next job goes to B, no restart.
    await adminDb.fleetShard.update({
      where: { id: a.id },
      data: { admissionCeilingOverride: 2 },
    });
    const second = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(second)).toMatchObject({ fleetShardId: b.id });
  });

  it('an account with no recorded limit and no override takes no job', async () => {
    expect(
      fleetShardAdmissionService.effectiveCeiling({
        admissionCeilingOverride: null,
        vcpuQuota: null,
        machineLimit: null,
      }),
    ).toBe(0);
  });
});

describe('every account full — defer, never lost', () => {
  it('defers shard_capacity without a claim, stamps the first deferral once, then admits after a settle', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const a = await account(1);
    const b = await account(1);
    await occupy(fx, a, 1);
    await seedIntent(fx, { status: 'running', fleetShardId: b.id });
    const intent = await seedIntent(fx);

    const first = await ciRunnerAdmissionService.admit(intent);
    expect(first).toEqual({
      outcome: 'deferred',
      reason: 'shard_capacity',
      detail: SHARD_CAPACITY_DETAIL,
    });
    const stamped = await rowOf(intent.id);
    expect(stamped.status).toBe('pending');
    expect(stamped.fleetShardId).toBeNull();
    expect(stamped.shardCapacityDeferredAt).toEqual(NOW);

    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      reason: 'shard_capacity',
    });
    expect((await rowOf(intent.id)).shardCapacityDeferredAt).toEqual(NOW);

    // One container on B settles; the waiting job goes there.
    await adminDb.ciRunnerProvisioningIntent.updateMany({
      where: { fleetShardId: b.id, status: 'running' },
      data: { status: 'completed' },
    });
    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'admitted',
      fleetShardId: b.id,
    });
  });

  it('a paused account is skipped until the pause ends', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const a = await account(3);
    const b = await account(9, {
      admissionPausedUntil: new Date(NOW.getTime() + SHARD_PAUSE_SECONDS * 1000),
    });

    const during = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(during)).toMatchObject({ fleetShardId: a.id });

    vi.setSystemTime(new Date(NOW.getTime() + SHARD_PAUSE_SECONDS * 1000 + 1));
    const after = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(after)).toMatchObject({ fleetShardId: b.id });
  });

  it('two jobs racing for the one free slot: one claimed, one deferred', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const a = await account(2);
    await occupy(fx, a, 1);
    const [x, y] = [await seedIntent(fx), await seedIntent(fx)];

    const verdicts = await Promise.all([
      ciRunnerAdmissionService.admit(x),
      ciRunnerAdmissionService.admit(y),
    ]);

    expect(verdicts.map((v) => v.outcome).sort()).toEqual(['admitted', 'deferred']);
    expect(verdicts.find((v) => v.outcome === 'deferred')).toMatchObject({
      reason: 'shard_capacity',
    });
    expect(
      await adminDb.ciRunnerProvisioningIntent.count({
        where: { fleetShardId: a.id, status: { in: ['provisioning', 'running'] } },
      }),
    ).toBe(2);
  });
});

describe('the selection seam', () => {
  it('a narrowed set changes where the job goes, not how it is chosen', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const a = await account(3);
    await account(30);
    vi.spyOn(fleetShardAdmissionService, 'selectionSetInTx').mockResolvedValue([a]);
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({ fleetShardId: a.id });
  });
});

describe('the Motir spare (MOTIR-9456)', () => {
  /** Make the tenant's org one of Motir's own exempt orgs. */
  async function exempt(fx: Fixture, flag: 'isMeta' | 'internalBilling'): Promise<void> {
    await adminDb.organization.update({
      where: { id: fx.organizationId },
      data: { [flag]: true },
    });
  }

  it('a non-exempt org’s job is claimed on the primary even when the spare has more room', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const primary = await account(3);
    await account(30, { role: 'spare' });
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'admitted',
      fleetShardId: primary.id,
    });
  });

  it('a non-exempt org’s job defers shard_capacity when the primary is full, never onto the spare', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const primary = await account(1);
    await account(30, { role: 'spare' });
    await occupy(fx, primary, 1);

    const placement = await withSystemContext((tx) =>
      fleetShardAdmissionService.chooseInTx(
        { fleetKind: 'ci_runner', organizationId: fx.organizationId },
        NOW,
        tx,
      ),
    );

    expect(placement).toEqual({ deferred: 'shard_capacity', detail: SHARD_CAPACITY_DETAIL });
  });

  it.each(['isMeta', 'internalBilling'] as const)(
    'an exempt (%s) org’s job may take the spare, by the same most-headroom choice',
    async (flag) => {
      wireFleetKindSwitch('ci_runner', () => true);
      const fx = await seedTenant();
      await exempt(fx, flag);
      const primary = await account(3);
      const spare = await account(30, { role: 'spare' });

      const set = await withSystemContext((tx) =>
        fleetShardAdmissionService.selectionSetInTx(
          { fleetKind: 'ci_runner', organizationId: fx.organizationId },
          tx,
        ),
      );
      expect(set.map((s) => s.id).sort()).toEqual([primary.id, spare.id].sort());

      const first = await seedIntent(fx);
      expect(await ciRunnerAdmissionService.admit(first)).toMatchObject({ fleetShardId: spare.id });

      // With the spare fuller than the primary, the primary wins.
      await adminDb.fleetShard.update({
        where: { id: spare.id },
        data: { admissionCeilingOverride: 2 },
      });
      const second = await seedIntent(fx);
      expect(await ciRunnerAdmissionService.admit(second)).toMatchObject({
        fleetShardId: primary.id,
      });
    },
  );

  it('a spare of one kind is never in another kind’s selection set', async () => {
    const fx = await seedTenant();
    await exempt(fx, 'isMeta');
    const ciPrimary = await account(3);
    await account(30, { role: 'spare', fleetKind: 'hosted_agent' });

    const set = await withSystemContext((tx) =>
      fleetShardAdmissionService.selectionSetInTx(
        { fleetKind: 'ci_runner', organizationId: fx.organizationId },
        tx,
      ),
    );

    expect(set.map((s) => s.id)).toEqual([ciPrimary.id]);
  });

  it('promoting the spare puts it in a non-exempt org’s set on the next admission, no restart', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const primary = await account(1);
    const spare = await account(30, { role: 'spare' });
    await occupy(fx, primary, 1);
    const before = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(before)).toMatchObject({ outcome: 'deferred' });

    await withSystemContext((tx) => fleetShardRepository.setRoleInTx(spare.id, 'primary', tx));

    const after = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(after)).toMatchObject({
      outcome: 'admitted',
      fleetShardId: spare.id,
    });
  });
});

describe('a credit refusal after the claim gives the account back', () => {
  it('clears the account with the claim', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    await account(3);
    const intent = await seedIntent(fx);
    vi.spyOn(ciRunnerAdmissionService, 'creditDeferral').mockResolvedValue({
      outcome: 'deferred',
      reason: 'balance_unavailable',
      detail: 'x',
    });

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      reason: 'balance_unavailable',
    });
    expect(await rowOf(intent.id)).toMatchObject({ status: 'pending', fleetShardId: null });
  });
});

describe('the agent runner on its pool (MOTIR-9421)', () => {
  async function hostedSlot(fx: Fixture, shard: FleetShard, ref: string): Promise<void> {
    await adminDb.fleetInFlightSlot.create({
      data: {
        workload: 'hosted_agent',
        ref,
        organizationId: fx.organizationId,
        fleetShardId: shard.id,
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      },
    });
  }

  const choose = (fx: Fixture) =>
    withSystemContext((tx) =>
      fleetShardAdmissionService.chooseInTx(
        { fleetKind: 'hosted_agent', organizationId: fx.organizationId },
        NOW,
        tx,
      ),
    );

  it('counts live hosted slots per account, and never CI intents', async () => {
    const fx = await seedTenant();
    const a = await account(2, { fleetKind: 'hosted_agent' });
    const b = await account(3, { fleetKind: 'hosted_agent' });
    await hostedSlot(fx, a, 'h1');
    // Three running CI intents on B do not touch B's hosted headroom.
    await occupy(fx, b, 3);
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect(await choose(fx)).toEqual({ shardId: b.id });
  });

  it('a full hosted pool defers with the hosted-agent words, not CI’s', async () => {
    const fx = await seedTenant();
    const a = await account(1, { fleetKind: 'hosted_agent' });
    await hostedSlot(fx, a, 'h2');
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    expect(await choose(fx)).toEqual({
      deferred: 'shard_capacity',
      detail: HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
    });
    expect(HOSTED_AGENT_SHARD_CAPACITY_DETAIL).not.toBe(SHARD_CAPACITY_DETAIL);
  });

  it('with the switch off the hosted run goes to Fly', async () => {
    const fx = await seedTenant();
    await account(5, { fleetKind: 'hosted_agent' });
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'fly');
    expect(await choose(fx)).toEqual({ shardId: null });
  });
  it('the generalised move pauses, re-chooses within the kind and hands the row to reassign (MOTIR-9423)', async () => {
    const fx = await seedTenant();
    const a = await account(5, { fleetKind: 'hosted_agent' });
    const b = await account(2, { fleetKind: 'hosted_agent' });
    // A CI account with far more room is never a hosted run's next account.
    await account(50);
    vi.stubEnv(AGENT_RUNNER_PROVIDER_ENV_VAR, 'aws');
    const reassigned: Array<[string, string]> = [];

    const next = await withSystemContext((tx) =>
      fleetShardAdmissionService.moveAfterRefusalInTx(
        { fleetKind: 'hosted_agent', organizationId: fx.organizationId },
        a.id,
        'provider_unavailable',
        new Set([a.id]),
        NOW,
        tx,
        async (nextShardId, reason) => {
          reassigned.push([nextShardId, reason]);
        },
      ),
    );

    expect(next).toBe(b.id);
    expect(reassigned).toEqual([[b.id, 'provider_unavailable']]);
    expect(await adminDb.fleetShard.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      admissionPausedUntil: new Date(NOW.getTime() + SHARD_PAUSE_SECONDS * 1000),
      admissionPausedReason: 'provider_unavailable',
    });

    // Nothing left: null, and reassign is never called.
    const none = await withSystemContext((tx) =>
      fleetShardAdmissionService.moveAfterRefusalInTx(
        { fleetKind: 'hosted_agent', organizationId: fx.organizationId },
        b.id,
        'capacity_refused',
        new Set([a.id, b.id]),
        NOW,
        tx,
        async (nextShardId, reason) => {
          reassigned.push([nextShardId, reason]);
        },
      ),
    );
    expect(none).toBeNull();
    expect(reassigned).toHaveLength(1);
  });
});

describe('classifyProvisionRefusal', () => {
  it.each(['quota_exceeded', 'out_of_stock', 'throttled'] as const)(
    'a capacity error (%s) is capacity_refused',
    (reason) => {
      expect(classifyProvisionRefusal(new OrchestratorCapacityError('fly', 422, reason))).toBe(
        'capacity_refused',
      );
    },
  );

  it('a timeout, a 5xx, a status-less API error and an unconfigured account are provider_unavailable', () => {
    expect(classifyProvisionRefusal(new OrchestratorTimeoutError('fly', 1))).toBe(
      'provider_unavailable',
    );
    expect(classifyProvisionRefusal(new OrchestratorApiError('fly', 503, 'down'))).toBe(
      'provider_unavailable',
    );
    expect(classifyProvisionRefusal(new OrchestratorApiError('fly', null, 'unreachable'))).toBe(
      'provider_unavailable',
    );
    expect(classifyProvisionRefusal(new OrchestratorNotConfiguredError('no token'))).toBe(
      'provider_unavailable',
    );
  });

  it('a 4xx, an unpullable image and anything else are the job’s fault', () => {
    expect(classifyProvisionRefusal(new OrchestratorApiError('fly', 400, 'bad spec'))).toBe(
      'job_fault',
    );
    expect(
      classifyProvisionRefusal(
        new OrchestratorImageUnpullableError('fly', 422, 'ghcr.io/x:y', 'denied'),
      ),
    ).toBe('job_fault');
    expect(classifyProvisionRefusal(new Error('boom'))).toBe('job_fault');
  });
});
