import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { ciSpotSettingReader } from '@/lib/services/ciSpotSettingReader';
import { MOTIR_ON_DEMAND_RUNNER_LABEL, MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { CI_SPOT_SETTING_SCOPE } from '@/lib/repositories/platformCiSpotSettingRepository';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// THE "NEVER SPOT" LABEL AT BOOT (MOTIR-11727), against real Postgres: an intent
// whose job asked for `motir-on-demand` boots on-demand whatever the CI Spot
// setting says, and its runner is registered with both fleet labels — while
// every other intent keeps the one fleet label and the setting's capacity.
//
// What is real: Postgres, the setting's row and its system read, the intent and
// the whole boot service. What is faked: GitHub (`fetch`, which also records the
// JIT mint's request) and the orchestrator (the shipped `fake` adapter).

const MOTIR_ORG = 'motir-projects';
const RUNNER_GROUP_ID = 5042;
/** Supervision, at test speed — the boot path is what is under test. */
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;

let jobSeq = 0;
/** Every JIT mint's request body, in order. */
let mintBodies: Array<{ labels?: string[] }>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The CI Spot setting as a superadmin would have saved it. */
async function saveSetting(enabled: boolean, instanceTypes: string[]): Promise<void> {
  await adminDb.platformCiSpotSetting.upsert({
    where: { scope: CI_SPOT_SETTING_SCOPE },
    create: { scope: CI_SPOT_SETTING_SCOPE, enabled, instanceTypes, lastReason: 'test' },
    update: { enabled, instanceTypes },
  });
}

async function seedIntent(requestedLabels: string[] = [MOTIR_RUNNER_LABEL]) {
  const email = `fleet-spot-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'O' });
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
  await adminDb.project.update({
    where: { id: project.id },
    data: {
      runnerGroupId: RUNNER_GROUP_ID,
      runnerGroupName: `motir-project-${project.id}`,
      runnerGroupSyncedAt: new Date(),
    },
  });
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      projectId: project.id,
      installationId: '556677',
      runId: '8101',
      runAttempt: 1,
      jobId: String(61_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels,
      queuedAt: new Date(Date.now() - 5_000),
      status: 'pending',
    },
  });
}

/** Boot one intent to a never-starting container, and read the intent back. */
async function bootAndRead(intentId: string) {
  fakeOrchestrator.setBootBehaviour('never_start');
  await ciRunnerBootService.runIntent(intentId, FAST);
  return adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: intentId } });
}

/** Make the fake's handle report `capacity`, as an adapter with Spot does. */
function handlesReport(capacity: 'spot' | 'on_demand') {
  const provision = fakeOrchestrator.provision.bind(fakeOrchestrator);
  vi.spyOn(fakeOrchestrator, 'provision').mockImplementation(async (spec) => ({
    ...(await provision(spec)),
    capacity,
  }));
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformCiSpotSetting.deleteMany();
  fakeOrchestrator.reset();
  mintBodies = [];
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      if (href.endsWith(`/orgs/${MOTIR_ORG}/installation`)) return json(200, { id: 556677 });
      if (href.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (href.includes('generate-jitconfig')) {
        mintBodies.push(JSON.parse(String(init?.body ?? '{}')) as { labels?: string[] });
        return json(201, {
          runner: { id: 9101, name: 'motir-runner', status: 'offline' },
          encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.platformCiSpotSetting.deleteMany();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const BOTH = [MOTIR_RUNNER_LABEL, MOTIR_ON_DEMAND_RUNNER_LABEL];

describe('an intent that asked for the on-demand label boots on-demand, whatever the setting', () => {
  it('setting ON: the on-demand intent asks for on_demand, never spot', async () => {
    await saveSetting(true, ['m6i.large', 'm7i.large']);
    handlesReport('on_demand');
    const intent = await seedIntent(BOTH);

    const read = await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.capacity).toBe('on_demand');
    expect(read.capacity).toBe('on_demand');
  });

  it('setting ON: an intent without the label still asks for spot', async () => {
    await saveSetting(true, ['m6i.large']);
    handlesReport('spot');
    const intent = await seedIntent();

    const read = await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs[0]!.capacity).toBe('spot');
    expect(read.capacity).toBe('spot');
  });

  it('setting OFF: the on-demand intent still says on_demand outright', async () => {
    await saveSetting(false, ['m6i.large']);
    const intent = await seedIntent(BOTH);

    const read = await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs[0]!.capacity).toBe('on_demand');
    expect(read.capacity).toBe('on_demand');
  });

  it('the label in another case still forces on_demand, and the setting is never read for it', async () => {
    await saveSetting(true, ['m6i.large']);
    const read = vi.spyOn(ciSpotSettingReader, 'read');
    const intent = await seedIntent([MOTIR_RUNNER_LABEL, ' Motir-On-Demand ']);

    await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs[0]!.capacity).toBe('on_demand');
    expect(read).not.toHaveBeenCalled();
  });

  it('buildSpec says on_demand for an on-demand intent even when handed spot', async () => {
    const intent = await seedIntent(BOTH);
    const base = {
      intent,
      workflowJobId: 1,
      projectId: intent.projectId!,
      encodedJitConfig: 'x',
      timeoutSeconds: 60,
      orchestrator: fakeOrchestrator,
    };

    expect(ciRunnerBootService.buildSpec({ ...base, capacity: 'spot' }).capacity).toBe('on_demand');
    expect(ciRunnerBootService.buildSpec(base).capacity).toBe('on_demand');
  });
});

describe('the JIT mint registers the runner with exactly the labels its job asked the fleet for', () => {
  it('an on-demand intent: exactly [motir-runner, motir-on-demand]', async () => {
    await saveSetting(true, ['m6i.large']);
    const intent = await seedIntent(BOTH);

    await bootAndRead(intent.id);

    expect(mintBodies).toHaveLength(1);
    expect(mintBodies[0]!.labels).toEqual(['motir-runner', 'motir-on-demand']);
  });

  it('every other intent: exactly [motir-runner], whatever else its job listed', async () => {
    const plain = await seedIntent();
    const selfHosted = await seedIntent(['self-hosted', MOTIR_RUNNER_LABEL]);
    const nearMiss = await seedIntent([MOTIR_RUNNER_LABEL, 'motir-on-demand-x']);

    await bootAndRead(plain.id);
    await bootAndRead(selfHosted.id);
    await bootAndRead(nearMiss.id);

    expect(mintBodies.map((b) => b.labels)).toEqual([
      ['motir-runner'],
      ['motir-runner'],
      ['motir-runner'],
    ]);
  });
});
