import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  ciRunnerBootService,
  FLEET_TIME_BUDGETS,
  MAX_BOOT_ATTEMPTS,
  pollWaitMs,
  type PollResult,
} from '@/lib/services/ciRunnerBootService';
import {
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  OrchestratorTimeoutError,
  fakeOrchestrator,
} from '@motir/orchestrator';
import * as orchestrator from '@/lib/orchestrator';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { hostedRunChargeService } from '@/lib/services/hostedRunChargeService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import {
  runnerJitConfigClient,
  RunnerJitTimeoutError,
  RUNNER_JIT_REQUEST_TIMEOUT_MS,
} from '@/lib/github/runnerJitConfig';
import { withSystemContext } from '@/lib/workspaces/context';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { fleetAttributionService } from '@/lib/services/fleetAttributionService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { SHARD_PAUSE_SECONDS, wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { githubRunnerCallEventRepository } from '@/lib/repositories/githubRunnerCallEventRepository';
import { randomToken, randomInt } from '../helpers/random';

// THE PROVISIONER against real Postgres (Story MOTIR-1916 · MOTIR-1921).
//
// This is where the card's acceptance criteria are answered, and they are almost
// all about what is TRUE AFTER a failure: the container is gone, the runner is
// de-registered, the intent tells the truth about which path it took. Boot
// working is the easy half.
//
// What is real here: Postgres, the intent table and its RLS contexts, the claim's
// concurrency guard, `projectRunnerGroupService`'s refusal, and the whole
// service. What is faked: GitHub (`fetch`) and the orchestrator (the `fake`
// adapter, selected by env exactly as a deployment would select Fly — the
// adapter is production code, not a test double bolted on).
//
// ⚠️ SUPERVISION IS DRIVEN WITH TINY DEADLINES, not with fake timers. The real
// loop polls and sleeps; passing millisecond deadlines exercises the SAME code
// paths at speed, whereas mocking the clock would test a different program.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const RUNNER_GROUP_ID = 5042;
/** GitHub's queue instant for the seeded job, RELATIVE to now.
 *
 * ⚠️ NOT a hardcoded calendar instant. Boot latency is measured as
 * `startedAt - queuedAt` against the wall clock, so a pinned date is a time bomb:
 * it reads as a plausible past instant on the day it is written and as a FUTURE
 * one from any machine whose clock sits before it — which clamps the latency to
 * zero and fails a test the code never broke. */
const QUEUED_AT = new Date(Date.now() - 5_000);

/** Supervision, at test speed. */
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;

interface GithubCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let githubCalls: GithubCall[];
/** Override the JIT mint / delete answers per test. */
let jitHandler: (call: GithubCall) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function mintCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.url.includes('generate-jitconfig'));
}

function deleteRunnerCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.method === 'DELETE' && /\/actions\/runners\/\d+$/.test(c.url));
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(options: { withRunnerGroup?: boolean; email?: string } = {}) {
  const email = options.email ?? `fleet-boot-${randomToken(6)}@example.com`;
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
  if (options.withRunnerGroup !== false) {
    await adminDb.project.update({
      where: { id: project.id },
      data: {
        runnerGroupId: RUNNER_GROUP_ID,
        runnerGroupName: `motir-project-${project.id}`,
        runnerGroupSyncedAt: new Date(),
      },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  } satisfies Fixture;
}

/** The per-call `jobId` counter, shared by every helper in this file that writes
 *  an intent. `@@unique([runId, runAttempt, jobId])` is the constraint, and both
 *  helpers below hold `runAttempt` fixed — so a `jobId` drawn at random was the
 *  only thing keeping two seeded rows apart, at a birthday rate the suite paid
 *  for as a rare unattributable flake (MOTIR-3845). A counter is unique by
 *  construction; one counter for both helpers means their bases cannot meet
 *  either. */
let jobSeq = 0;

/** One pending intent, exactly as MOTIR-1920's handler writes it. */
async function seedIntent(
  fx: Fixture,
  overrides: { jobId?: string; projectId?: string | null; bootAttempts?: number } = {},
) {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: overrides.projectId === undefined ? fx.projectId : overrides.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: overrides.jobId ?? String(44_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: QUEUED_AT,
      status: 'pending',
      bootAttempts: overrides.bootAttempts ?? 0,
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  fakeOrchestrator.reset();
  githubCalls = [];
  jitHandler = (call) => {
    if (call.url.includes('generate-jitconfig')) {
      return json(201, {
        runner: { id: 9001, name: 'motir-runner', status: 'offline' },
        encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
      });
    }
    return new Response(null, { status: 204 });
  };

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  // Select the FAKE adapter the same way a deployment selects Fly.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: GithubCall = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      githubCalls.push(call);
      if (call.url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: 556677 });
      }
      if (call.url.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return jitHandler(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the happy path — ONE intent produces ONE ephemeral runner', () => {
  it("mints a JIT config for the PROJECT's group with exactly the fleet label, boots one container, and destroys it", async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      // Simulate the job finishing right after the first poll — the runner takes
      // its one job, de-registers and exits, and `auto_destroy` removes the
      // machine.
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome.outcome).toBe('settled');
    expect(outcome).toMatchObject({ reason: 'job_completed' });

    // ONE mint, naming the project's group and the single §M label (§7.3/§7.4).
    expect(mintCalls()).toHaveLength(1);
    expect(mintCalls()[0]!.body).toMatchObject({
      runner_group_id: RUNNER_GROUP_ID,
      labels: [MOTIR_RUNNER_LABEL],
    });
    // No registration token is minted anywhere on this card.
    expect(githubCalls.some((c) => c.url.includes('registration-token'))).toBe(false);

    // EXACTLY ONE container, and it is GONE.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns).toEqual([
      { handleId: fakeOrchestrator.provisioned[0]!.id, reason: 'job_completed' },
    ]);

    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('completed');
    expect(settled.teardownReason).toBe('job_completed');
    expect(settled.failureDetail).toBeNull();
    expect(settled.containerProvider).toBe('fake');
    expect(settled.containerId).toBe(fakeOrchestrator.provisioned[0]!.id);
    expect(settled.githubRunnerId).toBe(9001);
    expect(settled.settledAt).not.toBeNull();
  });

  it('the container spec carries `--no-default-labels` and the single fleet label', async () => {
    // The card's acceptance criterion, asserted on what the boot ASKS FOR. The
    // real guarantee is the JIT config's `labels` array (above); this is the
    // second, independent statement of it — the one that still holds if the
    // runner image ever falls back to a `config.sh` path, where GitHub WOULD add
    // `self-hosted`/`Linux`/`X64`.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('never_start');
    await ciRunnerBootService.runIntent(intent.id, FAST);

    const spec = fakeOrchestrator.specs[0]!;
    expect(spec.env['ACTIONS_RUNNER_CONFIG_ARGS']).toBe('--no-default-labels');
    expect(spec.env['MOTIR_RUNNER_LABEL']).toBe(MOTIR_RUNNER_LABEL);
    expect(spec.env['ACTIONS_RUNNER_INPUT_JITCONFIG']).toBe('ZW5jb2RlZC1qaXQ=');
    expect(spec.size).toEqual({ cpuKind: 'performance', cpus: 2, memoryMb: 8192 });
    // MOTIR-8839: the runner's dockerd gets native disk, or `services:` jobs fill
    // the rootfs under the `vfs` fallback.
    expect(spec.dockerVolumeGb).toBe(20);
    expect(fakeOrchestrator.provisioned[0]?.volumeId).toBe(
      `${fakeOrchestrator.provisioned[0]?.id}-docker`,
    );
  });

  it("RECORDS BOOT LATENCY, measured from GitHub's own queue instant", async () => {
    // ADR §6's budget made measurable rather than aspirational — MOTIR-1928
    // measures the real p50/p95 against it, and this is what makes that a query.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.bootLatencyMs).not.toBeNull();
    expect(settled.startedAt).not.toBeNull();
    // Measured from `queuedAt`, not from the boot: the span a USER experiences.
    // A window, never an equality — different clocks, different stamp sites.
    const expected = Date.now() - QUEUED_AT.getTime();
    expect(settled.bootLatencyMs!).toBeGreaterThan(0);
    expect(settled.bootLatencyMs!).toBeLessThanOrEqual(expected + 5_000);
  });

  it('emits a costed container-seconds record attributed to the org', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    // The §5 record rides out on the outcome, which is the job's return value
    // and therefore the `job_run` ledger row — the durable, queryable home for
    // it until MOTIR-1924's table lands.
    expect(outcome.outcome).toBe('settled');
    expect((outcome as Extract<typeof outcome, { outcome: 'settled' }>).usage).toMatchObject({
      orgId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoFullName: `${MOTIR_ORG}/acme-web`,
      teardownReason: 'job_completed',
      // The rate came from the effective-dated table, not a constant in code.
      usdPerSecond: '0.000031636049',
      cpuKind: 'performance',
    });
  });
});

describe('§7.3 — a project with NO runner group is REFUSED', () => {
  it('refuses to provision, and never reaches for the `Default` group', async () => {
    // The card's acceptance criterion. Falling back to `Default` (id 1,
    // `visibility: all`) would silently restore the cross-tenant pickup the
    // per-project group exists to prevent.
    const fx = await seedTenant({ withRunnerGroup: false });
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome.outcome).toBe('no_runner_group');
    expect(mintCalls()).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    // Nothing anywhere named group 1.
    expect(
      githubCalls.some((c) => JSON.stringify(c.body ?? {}).includes('"runner_group_id":1')),
    ).toBe(false);

    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.failureDetail).toContain('no runner group');
  });

  it('refuses an intent that names no project at all', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, { projectId: null });
    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);
    expect(outcome.outcome).toBe('no_runner_group');
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('every failure path destroys the container — one test each', () => {
  it('BOOT REFUSED: no container exists, and the minted JIT runner is DE-REGISTERED', async () => {
    // ⚠️ The card's "minted-but-unused JIT config" criterion.
    // `generate-jitconfig` REGISTERS the runner before any container exists
    // (§7.4, verified), so a boot that never happens leaves a dangling runner
    // unless this path cleans it up — GitHub does not.
    const fx = await seedTenant();
    // The LAST attempt: an earlier one would be re-queued (MOTIR-8941).
    const intent = await seedIntent(fx, { bootAttempts: MAX_BOOT_ATTEMPTS - 1 });
    fakeOrchestrator.failNextProvision();

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome.outcome).toBe('provision_failed');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(deleteRunnerCalls()).toHaveLength(1);
    expect(deleteRunnerCalls()[0]!.url).toMatch(/\/actions\/runners\/9001$/);

    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.teardownReason).toBe('provision_failed');
    // The runner id was persisted BEFORE the boot, which is what makes the
    // crash-in-this-window case recoverable at all.
    expect(settled.githubRunnerId).toBe(9001);
  });

  it('a TRANSIENT boot failure re-queues the intent and the next pass boots it (MOTIR-8941)', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.failNextProvision('volume not found');

    const first = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(first).toEqual({ outcome: 'rate_limited', retryAfterSeconds: null });
    // The minted-but-unused runner is still de-registered.
    expect(deleteRunnerCalls()).toHaveLength(1);
    const requeued = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(requeued.status).toBe('pending');
    expect(requeued.settledAt).toBeNull();
    expect(requeued.bootAttempts).toBe(1);

    const second = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });
    expect(second).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
  });

  it('a boot that keeps failing ends provision_failed after MAX_BOOT_ATTEMPTS (MOTIR-8941)', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const outcomes: string[] = [];
    for (let i = 0; i < MAX_BOOT_ATTEMPTS; i += 1) {
      fakeOrchestrator.failNextProvision('the provider keeps refusing');
      outcomes.push((await ciRunnerBootService.runIntent(intent.id, FAST)).outcome);
    }

    expect(outcomes).toEqual([
      ...Array.from({ length: MAX_BOOT_ATTEMPTS - 1 }, () => 'rate_limited'),
      'provision_failed',
    ]);
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.teardownReason).toBe('provision_failed');
  });

  it('NEVER REGISTERED: a container that never starts is destroyed at the boot deadline', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('never_start');

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'provision_failed' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns).toEqual([
      { handleId: fakeOrchestrator.provisioned[0]!.id, reason: 'provision_failed' },
    ]);
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    // The row says what the container was doing and which image it waited on,
    // so a pull that never finishes is visible without the provider's logs
    // (MOTIR-9348). The fake has no fleet config, so the spec's image is the
    // unconfigured placeholder.
    expect(settled.failureDetail).toBe(
      'the container never started within 0.04 s ' +
        '(last provider state: created; image motir/ci-runner@sha256:unset)',
    );
    // It never ran, so it costs nothing — but it still produced a row.
    expect(outcome).toMatchObject({ billableSeconds: 0, costUsd: '0' });
  });

  it('HUNG PAST THE TIMEOUT: a container that starts and never stops is killed', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('hang');

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      bootDeadlineMs: 40,
      jobTimeoutMs: 30,
      pollIntervalMs: 1,
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_timed_out' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.teardownReason).toBe('job_timed_out');
    // A container that started and timed out keeps the timeout's own detail;
    // the never-started detail (MOTIR-9348) belongs to the boot deadline alone.
    expect(settled.failureDetail ?? '').not.toContain('never started');
    // It DID run, so it costs something — the customer's hung job is Motir's
    // container-seconds either way.
    expect((outcome as { billableSeconds: number }).billableSeconds).toBeGreaterThanOrEqual(0);
  });

  it('a TRANSIENT provider blip does NOT kill a healthy job', async () => {
    // ⚠️ Without read tolerance, one 500 from the provider ends a customer's CI
    // run mid-test for a reason that has nothing to do with their code. The
    // first read fails; the run must survive it and settle normally.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const describe = vi.spyOn(fakeOrchestrator, 'describe');
    describe.mockRejectedValueOnce(new Error('502 from the provider'));

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('SUPERVISION CRASHED: a provider read that keeps throwing still tears the container down', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const describeSpy = vi
      .spyOn(fakeOrchestrator, 'describe')
      .mockRejectedValue(new Error('provider unreachable'));

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_timed_out' });
    describeSpy.mockRestore();
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.failureDetail).toContain('provider unreachable');
  });

  it('TEARDOWN ITSELF FAILED: the intent is LEFT IN FLIGHT for the reaper, not marked settled', async () => {
    // ⚠️ The one case where "tidy up the row" would be actively harmful. Marking
    // it settled would hide a container that may still be running from the one
    // mechanism that can still catch it.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('never_start');
    fakeOrchestrator.failNextTeardown();

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome.outcome).toBe('provision_failed');
    const stuck = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(stuck.status).toBe('running');
    expect(stuck.settledAt).toBeNull();
    expect(fakeOrchestrator.liveContainerIds()).toHaveLength(1);
  });

  it('a malformed job id fails the intent before anything is spent', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, { jobId: 'not-a-number' });
    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);
    expect(outcome).toMatchObject({ outcome: 'provision_failed' });
    expect(mintCalls()).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('the registration ceiling releases the claim rather than failing the job', () => {
  it('returns `rate_limited` and puts the intent back in the PENDING pool', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    jitHandler = (call) =>
      call.url.includes('generate-jitconfig')
        ? json(403, { message: 'secondary rate limit' }, { 'retry-after': '25' })
        : new Response(null, { status: 204 });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toEqual({ outcome: 'rate_limited', retryAfterSeconds: 25 });
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    // Back to pending: the next sweep retries it, which is a retry that costs
    // nothing. Failing it would drop a job GitHub is genuinely waiting on.
    expect(after.status).toBe('pending');
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });
});

describe('a mint that BLOWS ITS DEADLINE is early, not broken (MOTIR-2011)', () => {
  /** The name the boot mints under — deterministic, and the ONLY handle on a
   *  runner GitHub registered before a timed-out mint could report its id. */
  function runnerNameFor(intentId: string): string {
    return `motir-${intentId}`.slice(0, 64);
  }

  /** GitHub's list-runners answer for the by-name lookup. */
  function listing(...runners: Array<{ id: number; name: string }>): Response {
    return json(200, { total_count: runners.length, runners });
  }

  /** The deadline itself is proven at the wire in `runnerJitConfig.test.ts`; what
   *  is asked here is what the BOOT PATH does with it, so the error is injected
   *  rather than waited for — a real 15s stall would buy nothing but 15s. */
  function mintTimesOut(): void {
    vi.spyOn(runnerJitConfigClient, 'mint').mockRejectedValue(
      new RunnerJitTimeoutError('mint', RUNNER_JIT_REQUEST_TIMEOUT_MS),
    );
  }

  it('re-queues the intent and de-registers the dangling runner BY NAME', async () => {
    // §7.4: `generate-jitconfig` registers the runner BEFORE it answers, so a
    // mint that timed out is the one failure that may have created a runner we
    // were never told the id of. Unbounded, this path did not exist at all — the
    // invocation was killed and the runner stayed in the org's list forever.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    mintTimesOut();
    jitHandler = (call) =>
      call.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : listing({ id: 7734, name: runnerNameFor(intent.id) });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    // Retryable, and NOT dead-lettered: with `retryPolicy: 'none'` a failed
    // outcome is where the job would stay.
    expect(outcome).toEqual({ outcome: 'rate_limited', retryAfterSeconds: null });
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after.status).toBe('pending');
    expect(after.settledAt).toBeNull();
    // Nothing was booted, and the runner GitHub had registered is gone.
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(deleteRunnerCalls().map((c) => c.url)).toEqual([
      `https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/7734`,
    ]);
  });

  it('removes nothing when GitHub registered nothing — the timeout that beat the write', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    mintTimesOut();
    jitHandler = () => listing();

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toEqual({ outcome: 'rate_limited', retryAfterSeconds: null });
    expect(deleteRunnerCalls()).toHaveLength(0);
  });

  it('still re-queues the job when the CLEANUP itself refuses', async () => {
    // ⚠️ The cleanup is best-effort by design. A lookup that 500s must not turn a
    // retryable outcome into an untyped throw — that would replace a job GitHub
    // is still waiting on with a dead-lettered run, which is the exact trade the
    // whole card is about.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    mintTimesOut();
    jitHandler = () => json(500, { message: 'Server Error' });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toEqual({ outcome: 'rate_limited', retryAfterSeconds: null });
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after.status).toBe('pending');
  });

  it('a NON-timeout mint failure still FAILS the intent — the two are not collapsed', async () => {
    // MUTATION CHECK on the new branch: widen it to catch every mint error and
    // this fails, because a 422 (a group that does not exist) is not a job that
    // should be retried forever.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    jitHandler = (call) =>
      call.url.includes('generate-jitconfig')
        ? json(422, { message: 'Runner group not found' })
        : new Response(null, { status: 204 });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome.outcome).toBe('provision_failed');
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after.status).toBe('failed');
  });
});

describe('the CLAIM is the concurrency guard', () => {
  it('two concurrent runs of the same intent boot exactly ONE container', async () => {
    // ⚠️ MUTATION CHECK: delete the `status: 'pending'` predicate from
    // `claimPending` and this fails with two containers — which is a runner that
    // has no job to claim, idling to its timeout, billed to the tenant.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('never_start');

    const [a, b] = await Promise.all([
      ciRunnerBootService.runIntent(intent.id, FAST),
      ciRunnerBootService.runIntent(intent.id, FAST),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['already_claimed', 'settled']);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(mintCalls()).toHaveLength(1);
  });

  it('an unknown intent id is a named outcome, not a throw', async () => {
    expect(await ciRunnerBootService.runIntent('does-not-exist', FAST)).toEqual({
      outcome: 'unknown_intent',
    });
  });

  it('an unconfigured deployment provisions nothing and claims nothing', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    expect(await ciRunnerBootService.runIntent(intent.id, FAST)).toEqual({
      outcome: 'not_configured',
    });
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after.status).toBe('pending');
  });
});

describe('the ADMISSION GATE is consulted BEFORE anything is spent (MOTIR-1922)', () => {
  // The wiring assertion, and the one that matters most: a cap that is decided
  // AFTER the JIT config is minted or the container is booted has already cost
  // the money it exists to save. So the assertion is not just the outcome — it
  // is that GitHub was never called and the orchestrator never provisioned.
  it('an org at its CI figure leaves the job QUEUED, with no mint and no container', async () => {
    const fx = await seedTenant();
    // A staff override of the CI burst cap (MOTIR-9375): one CI job at once.
    await adminDb.organization.update({
      where: { id: fx.organizationId },
      data: { fleetPoolCap: 1 },
    });
    // One runner already in flight — the org is at its CI figure.
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: (await seedIntent(fx, { jobId: '90001' })).id },
      data: { status: 'running' },
    });
    const queued = await seedIntent(fx, { jobId: '90002' });

    const result = await ciRunnerBootService.runIntent(queued.id, FAST);

    expect(result).toMatchObject({ outcome: 'gate_deferred', reason: 'plan_cap' });
    expect(mintCalls()).toHaveLength(0);
    expect(fakeOrchestrator.provisioned).toHaveLength(0);
    // PENDING, so the next sweep retries it — queued, never failed.
    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect(after.status).toBe('pending');
  });

  it('boots normally when the gate admits', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    expect((await ciRunnerBootService.runIntent(intent.id, FAST)).outcome).toBe('settled');
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

describe('the REAPER — the backstop for the orchestrator crashing mid-flight', () => {
  // The age cutoff is gone (MOTIR-6925, `fleet-per-org-pool.md` §6): the
  // attribution reconciler kills a CI container once its INTENT's own end —
  // boot + the job timeout + 10 minutes — is a grace behind it, and
  // `reapContainer` settles what it kills.
  it('finds and destroys an orphan the in-process path missed, and settles its intent', async () => {
    // ⚠️ THE CRASH IS SIMULATED FAITHFULLY: the container is booted and recorded,
    // and then the supervising call simply never happens — which is exactly what
    // a process dying between provision and teardown leaves behind. Nothing is
    // stubbed to make the reaper's job easier.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('hang');

    // Boot + record, then "crash": abandon supervision by rejecting the very
    // first describe, and swallow the teardown so the container is left alive.
    fakeOrchestrator.failNextTeardown();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeOrchestrator, 'describe').mockRejectedValue(new Error('process died'));
    await ciRunnerBootService.runIntent(intent.id, FAST);
    vi.restoreAllMocks();

    const orphanId = fakeOrchestrator.provisioned[0]!.id;
    expect(fakeOrchestrator.liveContainerIds()).toEqual([orphanId]);
    const inFlight = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(inFlight.status).toBe('running');

    // Move the clock past the intent's end and the grace, and reconcile.
    const charge = vi.spyOn(hostedRunChargeService, 'chargeMachineTime');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await fleetAttributionService.reconcile({
      now: () => new Date(Date.now() + 3 * 3_600_000),
    });

    expect(result).toMatchObject({
      outcome: 'reconciled',
      killed: [{ machineId: orphanId, reason: 'record_ended', workload: 'ci_runner' }],
    });
    // A CI runner is metered, never CHARGED as a hosted run (MOTIR-6524 AC2).
    expect(charge).not.toHaveBeenCalled();
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.teardownReason).toBe('reaped');
  });

  it('leaves a container whose intent has not ended alone', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    fakeOrchestrator.setBootBehaviour('hang');
    fakeOrchestrator.failNextTeardown();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeOrchestrator, 'describe').mockRejectedValue(new Error('process died'));
    await ciRunnerBootService.runIntent(intent.id, FAST);
    vi.restoreAllMocks();

    const result = await fleetAttributionService.reconcile();
    expect(result).toMatchObject({ outcome: 'reconciled', matched: 1, killed: [] });
    expect(fakeOrchestrator.liveContainerIds()).toHaveLength(1);
  });

  it('sweeps a CLAIMED-BUT-NEVER-BOOTED intent and de-registers its dangling runner', async () => {
    // The crash-between-mint-and-boot window. GitHub holds a registered runner
    // with no machine; the only thing that knows its id is the column written
    // before the boot.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: intent.id },
      data: {
        status: 'provisioning',
        githubRunnerId: 9001,
        runnerName: 'motir-orphan',
        updatedAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    const staleClaims = await ciRunnerBootService.sweepStaleClaims();

    expect(staleClaims).toBe(1);
    expect(deleteRunnerCalls()).toHaveLength(1);
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.failureDetail).toContain('de-registered');
  });

  describe('an in-flight intent whose container is already gone (MOTIR-9347)', () => {
    const LONG_AGO = () => new Date(Date.now() - 3 * 60 * 60_000);

    /** An intent left `running` by a supervision that never settled it, naming a
     *  container the provider no longer holds — the 88 production rows. */
    async function seedOrphanedRunning(
      fx: Fixture,
      overrides: { containerId?: string; startedAt?: Date | null; bootedAt?: Date } = {},
    ) {
      const intent = await seedIntent(fx);
      return adminDb.ciRunnerProvisioningIntent.update({
        where: { id: intent.id },
        data: {
          status: 'running',
          containerProvider: 'fake',
          containerId: overrides.containerId ?? `gone-${intent.id}`,
          containerRegion: 'iad',
          githubRunnerId: 9101,
          runnerName: 'motir-orphan',
          bootedAt: overrides.bootedAt ?? LONG_AGO(),
          startedAt: overrides.startedAt ?? null,
        },
      });
    }

    async function inFlightCount(organizationId: string) {
      return withSystemContext((tx) =>
        ciRunnerProvisioningIntentRepository.countInFlightForOrganization(organizationId, tx),
      );
    }

    it('settles it, names the missing container, and de-registers its runner', async () => {
      const fx = await seedTenant();
      const intent = await seedOrphanedRunning(fx);
      expect(await inFlightCount(fx.organizationId)).toBe(1);

      expect(await ciRunnerBootService.sweepVanishedInFlight()).toBe(1);

      const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(settled.status).toBe('failed');
      expect(settled.teardownReason).toBe('provision_failed');
      expect(settled.failureDetail).toContain(`container ${intent.containerId} no longer exists`);
      expect(deleteRunnerCalls()).toHaveLength(1);
      expect(await inFlightCount(fx.organizationId)).toBe(0);
    });

    it('treats a machine the provider still READS as destroyed as gone', async () => {
      // Fly answers a destroyed machine with `state: destroyed` before its read
      // 404s, and the inventory no longer lists it — the production case.
      const fx = await seedTenant();
      const intent = await seedOrphanedRunning(fx);
      vi.spyOn(fakeOrchestrator, 'describe').mockResolvedValue({
        handleId: intent.containerId!,
        exists: true,
        state: 'destroyed',
        terminal: true,
        createdAt: LONG_AGO(),
        startedAt: null,
        stoppedAt: null,
        exitCode: null,
      });

      expect(await ciRunnerBootService.sweepVanishedInFlight()).toBe(1);

      const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(settled.status).toBe('failed');
    });

    it('settles one that had STARTED as job_timed_out', async () => {
      const fx = await seedTenant();
      const intent = await seedOrphanedRunning(fx, { startedAt: LONG_AGO() });

      expect(await ciRunnerBootService.sweepVanishedInFlight()).toBe(1);

      const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(settled.teardownReason).toBe('job_timed_out');
    });

    it('leaves one whose container STILL EXISTS to the machine-driven kill', async () => {
      const fx = await seedTenant();
      fakeOrchestrator.setBootBehaviour('hang');
      const pending = await seedIntent(fx);
      const booted = await ciRunnerBootService.bootIntent(pending.id, FAST);
      if (booted.phase !== 'supervising') throw new Error('unreachable');
      await adminDb.ciRunnerProvisioningIntent.update({
        where: { id: pending.id },
        data: { bootedAt: LONG_AGO() },
      });

      expect(await ciRunnerBootService.sweepVanishedInFlight()).toBe(0);

      const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(row.status).toBe('running');
      expect(deleteRunnerCalls()).toHaveLength(0);
    });

    it('leaves one still inside its own end alone, container or not', async () => {
      const fx = await seedTenant();
      const intent = await seedOrphanedRunning(fx, { bootedAt: new Date() });

      expect(await ciRunnerBootService.sweepVanishedInFlight()).toBe(0);

      const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(row.status).toBe('running');
    });

    it('never reads an unreadable provider as a missing container', async () => {
      const fx = await seedTenant();
      const intent = await seedOrphanedRunning(fx);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(fakeOrchestrator, 'describe').mockRejectedValue(new Error('provider 500'));

      expect(await ciRunnerBootService.sweepVanishedInFlight()).toBe(0);

      const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(row.status).toBe('running');
      expect(deleteRunnerCalls()).toHaveLength(0);
    });
  });

  it('is inert on a deployment with no orchestrator', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(await ciRunnerBootService.sweepStaleClaims()).toBe(0);
    expect(await ciRunnerBootService.sweepVanishedInFlight()).toBe(0);
    expect(
      await ciRunnerBootService.reapContainer({
        provider: 'fly',
        id: 'machine-1',
        region: 'iad',
        createdAt: new Date(),
      }),
    ).toBe(false);
  });
});

describe('the pending-intent seam', () => {
  it('lists pending intents oldest-QUEUED first, and nothing else', async () => {
    const fx = await seedTenant();
    const older = await seedIntent(fx, { jobId: '1' });
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: older.id },
      data: { queuedAt: new Date(QUEUED_AT.getTime() - 60_000) },
    });
    const newer = await seedIntent(fx, { jobId: '2' });
    const settledAlready = await seedIntent(fx, { jobId: '3' });
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: settledAlready.id },
      data: { status: 'completed' },
    });

    expect(await ciRunnerBootService.listRunnableIntentIds()).toEqual([older.id, newer.id]);
  });

  it('is empty on a deployment with no orchestrator — and SAYS so, naming what is missing', async () => {
    // MOTIR-10625: this answered `[]` without a line, and an AWS deployment queued
    // every CI job for good with nothing in its logs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    const fx = await seedTenant();
    await seedIntent(fx);
    expect(await ciRunnerBootService.listRunnableIntentIds()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      '[ciRunnerBootService] CI runner intents are pending but the CI fleet is not configured',
      { missing: ['FLY_FLEET_API_TOKEN', 'FLY_FLEET_APP', 'MOTIR_RUNNER_IMAGE'] },
    ]);
  });

  it('names the AWS values on the CI runner pool, never the Fly fleet’s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('MOTIR_FLEET_CI_RUNNER_PROVIDER', 'aws');
    vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', '');
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::944842271421:role/motir-add-shard');
    const fx = await seedTenant();
    await seedIntent(fx);
    expect(await ciRunnerBootService.listRunnableIntentIds()).toEqual([]);
    expect(warn.mock.calls[0]?.[1]).toEqual({ missing: ['MOTIR_AWS_RUNNER_AMI_ID'] });
  });

  it('stays quiet when nothing is pending — a self-hosted build has nothing stuck', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(await ciRunnerBootService.listRunnableIntentIds()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ── The remaining refusals, one test each ───────────────────────────────────

describe('the boot’s defensive paths', () => {
  it('runs on its REAL default deadlines when the caller passes none', async () => {
    // Every other test drives supervision with tiny deadlines, so the shipped
    // constants are never the values in force. Here only `sleep` is supplied —
    // the job finishes on the first poll, so the real 120s/3600s/3s defaults are
    // the ones the loop is built with and cannot have rotted into `undefined`.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    // 3600s is the hard kill §11 fixes, and it reaches the container's spec.
    expect(fakeOrchestrator.specs[0]?.timeoutSeconds).toBe(3600);
  });

  it('uses the REAL sleep between polls — a zero interval resolves rather than hanging', async () => {
    const fx = await seedTenant();
    fakeOrchestrator.setBootBehaviour('never_start');
    const intent = await seedIntent(fx);

    // No `sleep` override: the shipped `sleepFor` runs, and its zero-or-less
    // short-circuit is what keeps a tight poll loop from queueing a timer per
    // iteration.
    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      bootDeadlineMs: 5,
      jobTimeoutMs: 20,
      pollIntervalMs: 0,
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'provision_failed' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('a container that goes TERMINAL WITHOUT EVER STARTING is a provisioning failure', async () => {
    // Distinct from the boot-deadline case above: the provider says the machine
    // is gone, and it never ran. "Boot succeeded but nothing came up" is a
    // provisioning failure even though `provision` returned successfully.
    const fx = await seedTenant();
    fakeOrchestrator.setBootBehaviour('never_start');
    const intent = await seedIntent(fx);

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'provision_failed' });
    expect(outcome).toMatchObject({ billableSeconds: 0 });
  });

  it('a provider that keeps failing PAST THE JOB TIMEOUT still ends the container', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    // One good read (so the container is seen RUNNING), then a provider that is
    // down. The deadlines still bind: a provider outage must not extend a
    // container past its timeout.
    let reads = 0;
    const realDescribe = fakeOrchestrator.describe.bind(fakeOrchestrator);
    vi.spyOn(fakeOrchestrator, 'describe').mockImplementation(async (handle) => {
      reads += 1;
      if (reads === 1) return realDescribe(handle);
      throw new Error('the provider is down');
    });

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      bootDeadlineMs: 1_000,
      jobTimeoutMs: 1,
      pollIntervalMs: 1,
    });

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_timed_out' });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('reports a NON-ERROR provider rejection as `unknown` rather than losing it', async () => {
    const fx = await seedTenant();
    // The LAST attempt: an earlier one would be re-queued (MOTIR-8941).
    const intent = await seedIntent(fx, { bootAttempts: MAX_BOOT_ATTEMPTS - 1 });
    vi.spyOn(fakeOrchestrator, 'provision').mockRejectedValue('the provider hung up');

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'provision_failed' });
    expect(outcome).toMatchObject({ detail: expect.stringContaining('unknown') });
    // The minted-but-unused runner is still de-registered — a dangling
    // registered runner is the cost of skipping this.
    expect(deleteRunnerCalls()).toHaveLength(1);
  });

  it('AN UNPULLABLE RUNNER IMAGE settles as its own named condition — through the REAL Fly adapter', async () => {
    // §6.2 of `docs/decisions/fleet-image-pull.md`, and MOTIR-2006's acceptance
    // criterion in one test: the pull is made to ACTUALLY FAIL rather than the
    // classification being asserted by inspection.
    //
    // ⚠️ THE REAL ADAPTER, NOT THE FAKE ONE. This test selects `fly` exactly as a
    // deployment does and lets the machine-create go out over the faked `fetch`,
    // so the path under test is the whole of it: Fly's real body → the adapter's
    // classifier → the typed error → this service's outcome → the intent row. A
    // hand-thrown `OrchestratorImageUnpullableError` would have proven only that
    // an `instanceof` works.
    //
    // The 400 body is Fly's own, measured live on 2026-08-02 (ADR §2.2).
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv(
      'MOTIR_RUNNER_IMAGE',
      'ghcr.io/motir-co/motir-ci-runner@sha256:446c692df68c80367876c65082c60ec3b1c667f32a98811ac53f0dfa8a0e6d1d',
    );
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    jitHandler = (call) => {
      // The runner's Docker volume (MOTIR-8839) is created FIRST and must succeed,
      // so the image pull is what fails — and, once it has, the volume it would
      // have mounted is deleted.
      if (call.url.includes('api.machines.dev') && call.url.includes('/volumes')) {
        return call.method === 'POST'
          ? json(200, { id: 'vol_boot', name: 'motir_ci_docker', region: 'iad' })
          : json(200, {});
      }
      if (call.url.includes('api.machines.dev')) {
        return json(400, {
          error:
            'failed to get manifest ghcr.io/motir-co/motir-ci-runner@sha256:446c692d…: unauthorized',
        });
      }
      if (call.url.includes('generate-jitconfig')) {
        return json(201, {
          runner: { id: 9001, name: 'motir-runner', status: 'offline' },
          encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
        });
      }
      return new Response(null, { status: 204 });
    };

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    // NOT `provision_failed`. A fleet whose image cannot be pulled produces a
    // wall of identical failures, and the name is what lets an operator read
    // that wall as ONE fault with one remedy.
    expect(outcome).toMatchObject({ outcome: 'image_unpullable' });
    expect(outcome).toMatchObject({
      detail: expect.stringContaining('the runner image could not be pulled'),
    });
    expect(
      githubCalls.some((c) => c.method === 'DELETE' && c.url.includes('/volumes/vol_boot')),
    ).toBe(true);

    // The intent tells the truth about WHICH image and WHAT the registry said —
    // this is the row the operator surface renders, so the diagnosis has to
    // survive into it rather than living only in a log line.
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
    expect(settled.failureDetail).toContain('motir-ci-runner');
    expect(settled.failureDetail).toContain('could not PULL');
    // The teardown reason stays the container vocabulary's `provision_failed`:
    // no container ever existed, so nothing ended.
    expect(settled.teardownReason).toBe('provision_failed');

    // And the minted-but-unused JIT runner is still de-registered. This is the
    // per-job cost §6.1's preflight exists to stop paying, which is exactly why
    // the preflight is the detection and this is only the backstop.
    expect(deleteRunnerCalls()).toHaveLength(1);
  });

  it('a JIT mint refused for a NON-rate-limit reason fails the intent, not the fleet', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    jitHandler = (call) =>
      call.url.includes('generate-jitconfig')
        ? json(422, { message: 'runner group not found' })
        : new Response(null, { status: 204 });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'provision_failed' });
    expect(outcome).toMatchObject({
      detail: expect.stringContaining('could not mint a JIT config'),
    });
    expect(fakeOrchestrator.provisioned).toEqual([]);
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('failed');
  });

  it('an UNEXPECTED runner-group failure is refused too, with its own detail', async () => {
    // Not `RunnerGroupNotProvisionedError` — a read that broke. The refusal is
    // the same (never the `Default` group), but the operator needs to see which
    // of the two happened.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(projectRunnerGroupService, 'requireRunnerGroupIdFor').mockRejectedValue(
      new Error('the project read failed'),
    );

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toMatchObject({ outcome: 'no_runner_group' });
    expect(outcome).toMatchObject({
      detail: expect.stringContaining("could not read the project's runner group"),
    });
    expect(mintCalls()).toEqual([]);
  });

  it('RELEASES the claim when the orchestrator disappears between the check and the call', async () => {
    // Both reads are at CALL time (`appAuth`'s contract), so they can disagree
    // across a redeploy. The claim must go back to the pool rather than pinning
    // an intent to an instance that cannot serve it.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(orchestrator, 'getOrchestrator').mockImplementation(() => {
      throw new OrchestratorNotConfiguredError('the fleet credentials went away');
    });

    const outcome = await ciRunnerBootService.runIntent(intent.id, FAST);

    expect(outcome).toEqual({ outcome: 'not_configured' });
    expect(mintCalls()).toEqual([]);
    // Released, so a configured instance can take it.
    expect(
      (await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: intent.id } }))
        .status,
    ).toBe('pending');
  });

  it('LOGS and keeps going when the intent cannot be settled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'settle').mockRejectedValue(
      new Error('the settle write failed'),
    );

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    // The CONTAINER is what costs money, and it is gone. A bookkeeping failure
    // must not propagate out of the path that guarantees that.
    expect(outcome.outcome).toBe('settled');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(error).toHaveBeenCalled();
  });

  it('LOGS and keeps going when de-registration fails — the runner may dangle, the container does not', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    vi.spyOn(runnerJitConfigClient, 'deleteRunner').mockRejectedValue(
      new Error('GitHub refused the delete'),
    );

    const outcome = await ciRunnerBootService.runIntent(intent.id, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });

    expect(outcome.outcome).toBe('settled');
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(error).toHaveBeenCalled();
  });
});

describe('the REAPER’s attribution resolver refuses what it cannot attribute', () => {
  /** Boot a container OUTSIDE the supervised path, so it is left running for the
   *  reaper to find — the crash-mid-flight shape. */
  async function orphan(
    fx: Fixture,
    overrides: { projectId?: string | null; jobId?: string; githubRunnerId?: number | null } = {},
  ) {
    jobSeq += 1;
    const intent = await adminDb.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        projectId: overrides.projectId === undefined ? fx.projectId : overrides.projectId,
        installationId: '556677',
        runId: `orphan-${randomToken(6)}`,
        runAttempt: 1,
        jobId: overrides.jobId ?? String(45_000 + jobSeq),
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: MOTIR_ORG,
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: QUEUED_AT,
        status: 'running',
      },
    });
    const handle = await fakeOrchestrator.provision(
      ciRunnerBootService.buildSpec({
        intent,
        workflowJobId: 1,
        projectId: fx.projectId,
        encodedJitConfig: 'jit',
        timeoutSeconds: 60,
        orchestrator: fakeOrchestrator,
      }),
    );
    await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.recordBoot(
        intent.id,
        {
          containerProvider: handle.provider,
          containerId: handle.id,
          containerRegion: handle.region,
          githubRunnerId: overrides.githubRunnerId === undefined ? 9_777 : overrides.githubRunnerId,
          runnerName: 'motir-orphan',
          bootedAt: new Date(),
        },
        tx,
      ),
    );
    fakeOrchestrator.backdate(handle.id, new Date(Date.now() - 60 * 60_000));
    return { intent, handle };
  }

  it('DESTROYS an orphan whose intent names no project, but emits no cost row for it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = await seedTenant();
    const { handle } = await orphan(fx, { projectId: null });

    await fleetAttributionService.reconcile({ now: () => new Date(Date.now() + 3 * 3_600_000) });

    // An orphan Motir cannot attribute is still an orphan that BILLS, so it is
    // destroyed anyway; a row attributed to nobody would be worse than none.
    expect(fakeOrchestrator.liveContainerIds()).not.toContain(handle.id);
    expect(await adminDb.ciContainerUsage.count()).toBe(0);
  });

  it('DESTROYS an orphan whose job id is malformed, and emits no cost row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fx = await seedTenant();
    const { handle } = await orphan(fx, { jobId: 'not-a-number' });

    await fleetAttributionService.reconcile({ now: () => new Date(Date.now() + 3 * 3_600_000) });

    expect(fakeOrchestrator.liveContainerIds()).not.toContain(handle.id);
    expect(await adminDb.ciContainerUsage.count()).toBe(0);
  });

  it('reaps an orphan with NO registered runner without calling GitHub', async () => {
    const fx = await seedTenant();
    const { handle } = await orphan(fx, { githubRunnerId: null });

    expect(await ciRunnerBootService.reapContainer(handle)).toBe(true);
    // Nothing to de-register: the crash happened before the mint, so there is no
    // runner id to name and no call to make.
    expect(deleteRunnerCalls()).toEqual([]);
  });

  it('settles nothing when the intent vanishes between the reap and the write-back', async () => {
    const fx = await seedTenant();
    const { handle } = await orphan(fx);
    // The row is deleted (a tenant teardown, a cascade) after the container was
    // destroyed. The sweep must not throw over a row that is already gone.
    const findByContainerId = vi.spyOn(ciRunnerProvisioningIntentRepository, 'findByContainerId');
    let call = 0;
    const real = findByContainerId.getMockImplementation();
    findByContainerId.mockImplementation(async (provider, containerId, tx) => {
      call += 1;
      if (call > 1) return null;
      return real
        ? real(provider, containerId, tx)
        : tx.ciRunnerProvisioningIntent.findFirst({
            where: { containerProvider: provider, containerId },
          });
    });

    expect(await ciRunnerBootService.reapContainer(handle)).toBe(true);
    expect(deleteRunnerCalls()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE BOUNDED PHASES (MOTIR-2007) — against real Postgres.
//
// `tests/jobs/ci-runner-fleet.test.ts` drives the Inngest side: that the job
// splits supervision across steps and reaches teardown after a container has
// outlived the invocation ceiling. This is the other half — what each phase
// does on the real table, and the property the whole card rests on: that
// `pollOnce` does ONE provider read and NEVER throws, because a throw would end
// the run without teardown.
// ─────────────────────────────────────────────────────────────────────────────
describe('the boot path is three bounded phases, not one long one', () => {
  it('bootIntent provisions and hands back a JSON-serializable session', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);

    expect(booted.phase).toBe('supervising');
    if (booted.phase !== 'supervising') throw new Error('unreachable');
    const { session } = booted;
    expect(session.intentId).toBe(intent.id);
    expect(session.handle.id).toBe(fakeOrchestrator.liveContainerIds()[0]);
    expect(session.attribution.workspaceId).toBe(fx.workspaceId);

    // ⚠️ IT CROSSES A STEP BOUNDARY, so it must survive a JSON round-trip
    // unchanged. A `Date` here would survive the first pass and arrive as a
    // string on every replayed one — a break that only ever shows up in
    // production, only on long jobs.
    expect(JSON.parse(JSON.stringify(session))).toEqual(session);
    expect(typeof session.bootedAt).toBe('string');
    expect(typeof session.handle.createdAt).toBe('string');
  });

  it('bootIntent reports a terminal outcome and provisions NOTHING when the gate refuses', async () => {
    const booted = await ciRunnerBootService.bootIntent('no-such-intent', FAST);

    expect(booted).toEqual({ phase: 'terminal', outcome: { outcome: 'unknown_intent' } });
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it('pollOnce makes EXACTLY ONE provider read and returns — the step cannot become long', async () => {
    // ⚠️ THE CARD'S STRUCTURAL ASSERTION. The defect was a poll LOOP inside one
    // invocation; the fix is that one poll is one read. Asserted by counting the
    // provider calls one `pollOnce` makes, so a loop reintroduced here fails.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');

    const describeSpy = vi.spyOn(fakeOrchestrator, 'describe');
    const polled = await ciRunnerBootService.pollOnce(booted.session, undefined, FAST);

    expect(describeSpy).toHaveBeenCalledTimes(1);
    expect(polled.done).toBe(false);
  });

  it('pollOnce NEVER throws when the provider does — it returns a typed result instead', async () => {
    // ⚠️ THE LOAD-BEARING PROPERTY. In a stepped world teardown cannot be
    // reached from a catch (the executor finalizes a failed run first —
    // PRODECT_FINDINGS #39), so the only way out of the loop must be a value.
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeOrchestrator, 'describe').mockRejectedValue(new Error('provider 500'));

    let state: Extract<PollResult, { done: false }> = {
      done: false,
      startedAt: null,
      bootLatencyMs: null,
      consecutiveReadFailures: 0,
    };
    // Tolerated blips first — a single 500 must not end a healthy CI run.
    for (let i = 0; i < 3; i += 1) {
      const polled = await ciRunnerBootService.pollOnce(booted.session, state, FAST);
      expect(polled.done).toBe(false);
      if (polled.done) throw new Error('unreachable');
      state = polled;
    }
    expect(warn).toHaveBeenCalled();

    // ...then it gives up on READING, and routes to teardown rather than throwing.
    const final = await ciRunnerBootService.pollOnce(booted.session, state, FAST);
    expect(final.done).toBe(true);
    if (!final.done) throw new Error('unreachable');
    expect(final.reason).toBe('job_timed_out');
    expect(final.failureDetail).toContain('could not be read');
  });

  it('a boot deadline reached on a FAILED read still names the last state a read saw (MOTIR-9348)', async () => {
    const fx = await seedTenant();
    fakeOrchestrator.setBootBehaviour('never_start');
    const intent = await seedIntent(fx);
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const options = { ...FAST, bootDeadlineMs: 60_000 };

    // One good read inside the deadline records the state it saw…
    const first = await ciRunnerBootService.pollOnce(booted.session, undefined, options);
    if (first.done) throw new Error('unreachable');
    expect(first.lastState).toBe('created');

    // …and when the deadline passes while the provider cannot be read, the
    // verdict carries that state rather than `unknown`.
    vi.spyOn(fakeOrchestrator, 'describe').mockRejectedValue(new Error('provider 500'));
    const late = new Date(new Date(booted.session.bootedAt).getTime() + 60_000);
    const verdict = await ciRunnerBootService.pollOnce(booted.session, first, {
      ...options,
      now: () => late,
    });

    expect(verdict).toMatchObject({
      done: true,
      reason: 'provision_failed',
      failureDetail:
        'the container never started within 60 s ' +
        '(last provider state: created; image motir/ci-runner@sha256:unset)',
    });
  });

  it('a session memoised before it carried an image says `unknown` rather than failing (MOTIR-9348)', async () => {
    const fx = await seedTenant();
    fakeOrchestrator.setBootBehaviour('never_start');
    const intent = await seedIntent(fx);
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');
    const { image: _image, ...legacy } = booted.session;
    const late = new Date(new Date(booted.session.bootedAt).getTime() + 1_000);

    const verdict = await ciRunnerBootService.pollOnce(legacy, undefined, {
      ...FAST,
      now: () => late,
    });

    expect(verdict).toMatchObject({
      done: true,
      reason: 'provision_failed',
      failureDetail: expect.stringContaining('image unknown'),
    });
  });

  it('settleSupervision tears down, meters and settles — the stepped form of the finally', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');
    fakeOrchestrator.completeJob(booted.session.handle.id);

    const verdict = await ciRunnerBootService.pollOnce(booted.session, undefined, FAST);
    expect(verdict.done).toBe(true);
    if (!verdict.done) throw new Error('unreachable');

    const outcome = await ciRunnerBootService.settleSupervision(booted.session, verdict, FAST);

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    // The container is gone, the runner de-registered, and the intent settled —
    // the same three guarantees the `finally` used to hold.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(deleteRunnerCalls()).toHaveLength(1);
    const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(row.status).toBe('completed');
    expect(row.settledAt).not.toBeNull();
  });

  it('the poll interval BACKS OFF, and is a pure function of the iteration', async () => {
    // Purity is what makes the durable loop replay-safe: a wall-clock input
    // would make two passes of the same run schedule different sleeps.
    expect(pollWaitMs(1)).toBe(FLEET_TIME_BUDGETS.pollIntervalMs);
    expect(pollWaitMs(2)).toBeGreaterThan(pollWaitMs(1));
    expect(pollWaitMs(1)).toBe(pollWaitMs(1));
    // ...and it is CAPPED, so a long job is ~125 polls rather than 1,200.
    expect(pollWaitMs(999)).toBe(FLEET_TIME_BUDGETS.maxPollIntervalMs);
    for (let i = 1; i < 50; i += 1) {
      expect(pollWaitMs(i)).toBeLessThanOrEqual(FLEET_TIME_BUDGETS.maxPollIntervalMs);
    }
  });
});

describe('the fleet account a container boots in (MOTIR-8964)', () => {
  afterEach(async () => {
    // The account is RESTRICTed while an intent records it.
    await adminDb.ciRunnerProvisioningIntent.deleteMany({});
    await adminDb.fleetShard.deleteMany({});
    orchestrator.resetShardFakes();
    fleetShardOrchestratorService.resetCache();
    wireFleetKindSwitch('ci_runner', null);
  });

  async function createAccount(machineLimit = 50) {
    return fleetShardService.createShard({
      name: `ci-runner-${randomToken(4)}`,
      fleetKind: 'ci_runner',
      provider: 'fly',
      state: 'active',
      githubOrg: MOTIR_ORG,
      githubInstallationId: '556677',
      flyOrg: 'motir',
      flyApp: `motir-ci-${randomToken(4)}`,
      flyRegion: 'ams',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      limits: { machineLimit },
    });
  }

  it('with no account chosen, boots on the process-wide fleet and records none', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');

    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(booted.session.handle.shardId).toBeUndefined();
    const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(row.fleetShardId).toBeNull();
  });

  it('boots in the CHOSEN account, in its region, and every later step reaches it — even once it is disabled', async () => {
    const fx = await seedTenant();
    const account = await createAccount();
    // The CI kind on its pool: admission chooses the one account (MOTIR-8968).
    wireFleetKindSwitch('ci_runner', () => true);
    const fake = orchestrator.fakeOrchestratorForShard(account.id);
    const intent = await seedIntent(fx);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');

    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(fake.provisioned).toHaveLength(1);
    expect(fake.specs[0]!.region).toBe('ams');
    expect(booted.session.handle.shardId).toBe(account.id);
    const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(row.fleetShardId).toBe(account.id);

    // Disabling stops NEW boots; a container already running is still followed.
    await fleetShardService.setState(account.id, 'disabled');
    fake.completeJob(booted.session.handle.id);
    const verdict = await ciRunnerBootService.pollOnce(booted.session, undefined, FAST);
    expect(verdict.done).toBe(true);
    if (!verdict.done) throw new Error('unreachable');
    const outcome = await ciRunnerBootService.settleSupervision(booted.session, verdict, FAST);
    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    expect(fake.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns).toEqual([]);
  });

  // ── THE IN-BOOT MOVE (MOTIR-8968, AMENDMENT 1 §A1.5) ───────────────────────
  async function twoAccounts() {
    wireFleetKindSwitch('ci_runner', () => true);
    const a = await createAccount(10);
    const b = await createAccount(50); // most headroom: chosen first
    return {
      a,
      b,
      fakeA: orchestrator.fakeOrchestratorForShard(a.id),
      fakeB: orchestrator.fakeOrchestratorForShard(b.id),
    };
  }

  it.each(['quota_exceeded', 'out_of_stock', 'throttled'] as const)(
    'a capacity refusal (%s) moves the same boot to the next account with the same runner, and pauses the refuser',
    async (reason) => {
      const fx = await seedTenant();
      const { a, b, fakeA, fakeB } = await twoAccounts();
      fakeB.failNextProvisionForCapacity(reason);
      const intent = await seedIntent(fx);
      const before = Date.now();

      const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
      if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

      expect(fakeB.provisioned).toEqual([]);
      expect(fakeA.provisioned).toHaveLength(1);
      expect(fakeOrchestrator.provisioned).toEqual([]);
      expect(booted.session.handle.shardId).toBe(a.id);
      // ONE mint, in the repo's own org; the move re-used it and deregistered nothing.
      expect(mintCalls()).toHaveLength(1);
      expect(mintCalls()[0]!.url).toContain(`/orgs/${MOTIR_ORG}/`);
      expect(deleteRunnerCalls()).toEqual([]);
      const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(row).toMatchObject({
        status: 'running',
        fleetShardId: a.id,
        fleetShardMoveReason: 'capacity_refused',
      });
      const paused = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: b.id } });
      expect(paused.admissionPausedReason).toBe('capacity_refused');
      expect(paused.admissionPausedUntil!.getTime()).toBeGreaterThanOrEqual(
        before + SHARD_PAUSE_SECONDS * 1000,
      );
    },
  );

  it.each([
    ['a timeout', () => new OrchestratorTimeoutError('fly', 1)],
    ['a 503', () => new OrchestratorApiError('fly', 503, 'down')],
    ['no status', () => new OrchestratorApiError('fly', null, 'unreachable')],
  ])(
    'a provider outage (%s) moves the job too, and the next job skips the paused account',
    async (_label, error) => {
      const fx = await seedTenant();
      const { a, b, fakeA, fakeB } = await twoAccounts();
      vi.spyOn(fakeB, 'provision').mockRejectedValueOnce(error());
      const first = await seedIntent(fx);

      const booted = await ciRunnerBootService.bootIntent(first.id, FAST);
      if (booted.phase !== 'supervising') throw new Error('unreachable');
      expect(booted.session.handle.shardId).toBe(a.id);
      expect(
        await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: first.id } }),
      ).toMatchObject({ fleetShardId: a.id, fleetShardMoveReason: 'provider_unavailable' });
      expect(
        (await adminDb.fleetShard.findUniqueOrThrow({ where: { id: b.id } })).admissionPausedReason,
      ).toBe('provider_unavailable');

      // While the pause holds, the next job is claimed on A directly.
      const second = await seedIntent(fx);
      const next = await ciRunnerBootService.bootIntent(second.id, FAST);
      if (next.phase !== 'supervising') throw new Error('unreachable');
      expect(next.session.handle.shardId).toBe(a.id);
      expect(
        await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: second.id } }),
      ).toMatchObject({ fleetShardId: a.id, fleetShardMoveReason: null });
      expect(fakeB.provision).toHaveBeenCalledTimes(1);
      expect(fakeA.provisioned).toHaveLength(2);
    },
  );

  it('every account refusing defers shard_capacity: runner deregistered, claim released, never Fly, never provision_failed', async () => {
    const fx = await seedTenant();
    const { fakeA, fakeB } = await twoAccounts();
    fakeA.failNextProvisionForCapacity('quota_exceeded');
    fakeB.failNextProvisionForCapacity('out_of_stock');
    const intent = await seedIntent(fx);

    const result = await ciRunnerBootService.bootIntent(intent.id, FAST);

    expect(result).toMatchObject({
      phase: 'terminal',
      outcome: { outcome: 'gate_deferred', reason: 'shard_capacity' },
    });
    expect(fakeOrchestrator.provisioned).toEqual([]);
    expect(mintCalls()).toHaveLength(1);
    expect(deleteRunnerCalls()).toHaveLength(1);
    const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(row).toMatchObject({
      status: 'pending',
      fleetShardId: null,
      fleetShardMoveReason: null,
      teardownReason: null,
    });
    expect(row.shardCapacityDeferredAt).not.toBeNull();
    // The mint that booted nothing still spent GitHub capacity on the repo's org
    // (MOTIR-8969): the ledger holds it, and the deregistration.
    const ledger = await adminDb.githubRunnerCallEvent.findMany({ orderBy: { at: 'asc' } });
    expect(ledger.map((e) => [e.githubOrg, e.kind])).toEqual([
      [MOTIR_ORG, 'mint'],
      [MOTIR_ORG, 'delete'],
    ]);
  });

  it.each([
    ['a 400', () => new OrchestratorApiError('fly', 400, 'bad spec')],
    ['an unpullable image', () => new OrchestratorImageUnpullableError('fly', 422, 'img', 'no')],
  ])('%s on an account does not move or defer — today’s path', async (_label, error) => {
    const fx = await seedTenant();
    const { fakeA, fakeB } = await twoAccounts();
    vi.spyOn(fakeB, 'provision').mockRejectedValueOnce(error());
    const intent = await seedIntent(fx);

    const result = await ciRunnerBootService.bootIntent(intent.id, FAST);

    expect(result.phase).toBe('terminal');
    expect(result).not.toMatchObject({ outcome: { reason: 'shard_capacity' } });
    expect(fakeA.provisioned).toEqual([]);
    expect(deleteRunnerCalls()).toHaveLength(1);
    const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(row.fleetShardMoveReason).toBeNull();
  });

  it('a kind on Fly with accounts present boots on the process-wide fleet, no account touched', async () => {
    const fx = await seedTenant();
    const a = await createAccount();
    const fake = orchestrator.fakeOrchestratorForShard(a.id);
    const intent = await seedIntent(fx);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');

    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fake.provisioned).toEqual([]);
  });

  it('a session memoised before accounts existed resolves to the process-wide fleet', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error('unreachable');
    // The memoised shape of an older run: no `shardId` on the handle.
    const { shardId: _none, ...handle } = booted.session.handle;
    fakeOrchestrator.completeJob(handle.id);

    const verdict = await ciRunnerBootService.pollOnce(
      { ...booted.session, handle },
      undefined,
      FAST,
    );
    expect(verdict.done).toBe(true);
  });
});

describe('the GitHub runner-call ledger (MOTIR-8969)', () => {
  it('records the mint on the happy path, keyed on the repo org', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    await ciRunnerBootService.bootIntent(intent.id, FAST);

    expect(
      (await adminDb.githubRunnerCallEvent.findMany()).map((e) => [e.githubOrg, e.kind]),
    ).toEqual([[MOTIR_ORG, 'mint']]);
  });

  it('a failing ledger write never fails the boot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(githubRunnerCallEventRepository, 'record').mockRejectedValue(new Error('db down'));
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const result = await ciRunnerBootService.bootIntent(intent.id, FAST);

    expect(result.phase).toBe('supervising');
    expect(await adminDb.githubRunnerCallEvent.count()).toBe(0);
  });
});
