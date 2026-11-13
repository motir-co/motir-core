import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { JobTestEngine, spyOnJobDispatch, dispatchedEvents } from '../helpers/jobs';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { ciRunnerProvisionSweep } from '@/lib/jobs/definitions/ciRunnerFleet';
import { ciRunnerBootEvent, dispatchCiRunnerBoot } from '@/lib/ciFleet/bootDispatch';
import { fakeOrchestrator } from '@motir/orchestrator';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken, randomInt } from '../helpers/random';
import { githubWebhookInboxService } from '@/lib/services/githubWebhookInboxService';

// THE HOT-PATH BOOT TRIGGER against real Postgres (Story MOTIR-1916 ·
// MOTIR-1996) — `docs/decisions/ci-runner-fleet.md` §6.
//
// The claim under test is a LATENCY one, and latency is not directly assertable
// in a unit test, so what is asserted is the thing latency reduces to: the boot
// event leaves the webhook IN THE SAME REQUEST that records the intent, instead
// of waiting out a minute-granularity cron. Every assertion is therefore on the
// EVENT, not on a container — except the one that must prove the two triggers
// can race safely, which drives the real provisioner to a real (fake-adapter)
// container and counts them.
//
// What is real here: Postgres, the intent table and its RLS contexts, the whole
// webhook service, the claim's compare-and-set. What is faked: the Inngest
// transport (`inngest.send`, as the whole suite already fakes it) and the
// orchestrator (the `fake` adapter, selected by env exactly as a deployment
// selects Fly).

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '55901';
const PROVIDER_REPO_ID = '99901';
const RUNNER_GROUP_ID = 5099;
const WEBHOOK_SECRET = 'test-webhook-secret';
/** ⚠️ RELATIVE to now, never a pinned calendar instant: boot latency is measured
 *  against the wall clock, so a hardcoded date reads as a FUTURE instant on any
 *  machine whose clock sits before it. */
const QUEUED_AT = new Date(Date.now() - 5_000);

/** Supervision, at test speed — the real loop, tiny deadlines. */
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;

/** One RSA key for the whole file: generating a 2048-bit pair per test costs
 *  more than every assertion in it. */
const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** A `workflow_job` delivery shaped like GitHub's own. Defaults to a fleet job
 *  in a Motir-owned project repo — the one shape that provisions. */
function delivery(
  overrides: {
    action?: string;
    labels?: string[];
    runId?: number | string;
    runAttempt?: number;
    jobId?: number | string;
    repoId?: string;
    repoOwner?: string;
    repoName?: string;
    installationId?: string;
  } = {},
): Record<string, unknown> {
  return {
    action: overrides.action ?? 'queued',
    workflow_job: {
      id: overrides.jobId ?? 44901,
      run_id: overrides.runId ?? 7901,
      run_attempt: overrides.runAttempt ?? 1,
      name: 'build',
      workflow_name: 'CI',
      status: 'queued',
      labels: overrides.labels ?? [MOTIR_RUNNER_LABEL],
      started_at: QUEUED_AT.toISOString(),
    },
    repository: {
      id: Number(overrides.repoId ?? PROVIDER_REPO_ID),
      name: overrides.repoName ?? 'acme-web',
      owner: { login: overrides.repoOwner ?? MOTIR_ORG },
    },
    installation: { id: Number(overrides.installationId ?? INSTALLATION_ID) },
  };
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  githubRepoId: string;
}

/** A tenant with an installation, a mirrored repo in Motir's org, a repo-set row
 *  realizing it, and a provisioned runner group — the shape a real Motir-created
 *  project repo has by the time its CI queues. */
async function seedTenant(
  options: { withProjectRepo?: boolean; email?: string } = {},
): Promise<Fixture> {
  const email = options.email ?? `fleet-hot-${randomToken(6)}@example.com`;
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
  await adminDb.project.update({
    where: { id: project.id },
    data: {
      runnerGroupId: RUNNER_GROUP_ID,
      runnerGroupName: `motir-project-${project.id}`,
      runnerGroupSyncedAt: new Date(),
    },
  });

  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: PROVIDER_REPO_ID,
        owner: MOTIR_ORG,
        name: 'acme-web',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: PROVIDER_REPO_ID },
  });

  if (options.withProjectRepo !== false) {
    await adminDb.projectRepo.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        role: 'web',
        name: 'acme-web',
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        position: 'a0',
        githubRepoId: githubRepo.id,
      },
    });
  }

  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    githubRepoId: githubRepo.id,
  };
}

/** Drive a raw delivery through the webhook the way the route does. */
function handle(payload: Record<string, unknown>) {
  return githubWebhookService.handleEvent('workflow_job', payload);
}

/** The boot events captured off the transport, in order. */
function bootEvents(events: CapturedJobEvent[]): CapturedJobEvent[] {
  return events.filter((e) => e.name === 'system.ci-runner-boot');
}

let captured: { events: CapturedJobEvent[]; restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  fakeOrchestrator.reset();
  // Select the FAKE adapter the same way a deployment selects Fly — the fleet is
  // "configured", which is what the hot-path gate reads.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', APP_PRIVATE_KEY);
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', WEBHOOK_SECRET);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  captured = captureJobEvents();
});

afterEach(() => {
  captured.restore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a RECORDED intent dispatches its boot from the same request', () => {
  it('emits exactly one `system.ci-runner-boot`, carrying the id of the intent just written', async () => {
    // The whole card in one assertion: the event is out before the response is,
    // so §6's budget starts at the webhook rather than at the next cron minute.
    const fx = await seedTenant();

    const result = await handle(delivery());

    expect(result).toEqual({ event: 'workflow_job', outcome: 'recorded' });
    const intent = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    // `workspaceId` is `null`, not `''` — an empty string is not nullish, so it
    // survives `defineJob`'s `?? null`, trips the `job_run` workspace FK and
    // costs the run its ledger row entirely (MOTIR-1998).
    expect(bootEvents(captured.events)).toEqual([
      { name: 'system.ci-runner-boot', data: { intentId: intent.id, workspaceId: null } },
    ]);
  });

  it('emits the byte-identical event the SWEEP emits — one payload, two senders', async () => {
    // The two triggers race by design, so they must be the same event. Built
    // through the shared `ciRunnerBootEvent` precisely so this cannot drift.
    await seedTenant();

    await handle(delivery());

    const intent = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({});
    const [hot] = bootEvents(captured.events);
    expect(hot).toEqual(ciRunnerBootEvent(intent.id));
  });
});

describe('every OTHER outcome dispatches NOTHING', () => {
  it('a `ubuntu-latest` job — the overwhelming majority of deliveries — sends no event', async () => {
    await seedTenant();

    const result = await handle(delivery({ labels: ['ubuntu-latest'] }));

    expect(result).toMatchObject({ outcome: 'not_fleet_job' });
    expect(bootEvents(captured.events)).toHaveLength(0);
  });

  it('a REDELIVERY of a job already recorded sends no SECOND event', async () => {
    // GitHub retries; a second boot event for an intent already dispatched would
    // be a second losing claim at best, and the redelivery is not a new request
    // for compute.
    await seedTenant();

    const first = await handle(delivery());
    const second = await handle(delivery());

    expect(first).toMatchObject({ outcome: 'recorded' });
    expect(second).toMatchObject({ outcome: 'duplicate' });
    expect(bootEvents(captured.events)).toHaveLength(1);
  });

  it('a fleet job in a repo that belongs to NO tenant sends nothing', async () => {
    // Refused upstream (no owner to bill), so there is nothing to boot.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedTenant({ withProjectRepo: false });

    const result = await handle(delivery());

    expect(result).toMatchObject({ outcome: 'unattributed' });
    expect(bootEvents(captured.events)).toHaveLength(0);
  });

  it('a fleet job in an unmirrored repo sends nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedTenant();

    const result = await handle(delivery({ repoId: '424242' }));

    expect(result).toMatchObject({ outcome: 'unknown_repo' });
    expect(bootEvents(captured.events)).toHaveLength(0);
  });

  it('a delivery on an unknown installation sends nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedTenant();

    const result = await handle(delivery({ installationId: '90909' }));

    expect(result).toMatchObject({ outcome: 'unknown_installation' });
    expect(bootEvents(captured.events)).toHaveLength(0);
  });

  it('an `in_progress` job — a runner is already assigned — sends nothing', async () => {
    await seedTenant();

    const result = await handle(delivery({ action: 'in_progress' }));

    // MOTIR-11230: the delivery now stamps job progress for supervision — and
    // still boots nothing.
    expect(result).toMatchObject({ outcome: 'progress_recorded' });
    expect(bootEvents(captured.events)).toHaveLength(0);
  });
});

describe('a FAILING send never costs the delivery its 200', () => {
  it('logs, keeps the `recorded` outcome, and leaves the intent for the sweep', async () => {
    // GitHub retries a 500, and a redelivery cannot re-send an event that failed
    // to send — it would only re-run a handler for an intent that already exists.
    // So the transport failure is swallowed and the sweep is the recovery.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    captured.restore();
    spyOnJobDispatch().mockRejectedValue(new Error('inngest unreachable'));
    const fx = await seedTenant();

    const result = await handle(delivery());

    expect(result).toEqual({ event: 'workflow_job', outcome: 'recorded' });
    // The intent is DURABLE and still pending — exactly what the sweep drains.
    const intent = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(intent.status).toBe('pending');
    expect(error.mock.calls[0]?.[0]).toContain('hot-path boot dispatch');
  });

  it('the ROUTE still acks 2xx, and the stored delivery records the intent', async () => {
    // Since MOTIR-10425 the route answers before anything runs, so the ack no longer
    // depends on the handler at all — and GitHub never retried a failed delivery
    // anyway. The handler runs in the inbox job, and records the intent there.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    captured.restore();
    spyOnJobDispatch().mockRejectedValue(new Error('inngest unreachable'));
    await seedTenant();

    const { POST } = await import('@/app/api/github/webhook/route');
    const rawBody = JSON.stringify(delivery());
    const res = await POST(
      new NextRequest('http://localhost:3000/api/github/webhook', {
        method: 'POST',
        headers: {
          'x-github-event': 'workflow_job',
          'x-github-delivery': 'hot-path-route-delivery',
          'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')}`,
        },
        body: rawBody,
      }),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, deliveryId: 'hot-path-route-delivery' });
    await githubWebhookInboxService.processDelivery({
      deliveryId: 'hot-path-route-delivery',
      generation: 0,
    });
    expect(
      (await githubWebhookInboxService.findDelivery('hot-path-route-delivery'))?.result,
    ).toEqual({ event: 'workflow_job', outcome: 'recorded' });
  });
});

describe('a deployment that cannot boot anything dispatches nothing', () => {
  it('records the intent but sends no event when no orchestrator is configured', async () => {
    // The same condition `listRunnableIntentIds` applies before the sweep fans
    // out: a self-hosted build, or a cloud deploy whose fleet env vars are not
    // set yet, must not emit an event whose only outcome could be
    // `not_configured`. Nothing is lost — the intent is durable.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const fx = await seedTenant();

    const result = await handle(delivery());

    expect(result).toMatchObject({ outcome: 'recorded' });
    expect(bootEvents(captured.events)).toHaveLength(0);
    await expect(
      adminDb.ciRunnerProvisioningIntent.count({ where: { workspaceId: fx.workspaceId } }),
    ).resolves.toBe(1);
    await expect(dispatchCiRunnerBoot('any-intent')).resolves.toBe('not_configured');
  });
});

describe('on the CI runner pool, the Fly fleet is not what the gate reads (MOTIR-10625)', () => {
  // The AWS deployment's shape: CI on its pool, the AWS values a pool boot needs
  // set, and NONE of the Fly fleet's — no `FLY_FLEET_APP`, no
  // `MOTIR_RUNNER_IMAGE`. Every CI job used to stay queued here with no log: the
  // hot path answered `not_configured` and the sweep listed nothing.
  function configureAwsPool(): void {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    vi.stubEnv('MOTIR_FLEET_CI_RUNNER_PROVIDER', 'aws');
    vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', 'ami-0123456789abcdef0');
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::944842271421:role/motir-add-shard');
  }

  it('dispatches the recorded intent from the webhook, and the sweep lists it', async () => {
    configureAwsPool();
    const fx = await seedTenant();

    const result = await handle(delivery());

    expect(result).toEqual({ event: 'workflow_job', outcome: 'recorded' });
    const intent = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId },
    });
    expect(bootEvents(captured.events)).toEqual([ciRunnerBootEvent(intent.id)]);
    expect(await ciRunnerBootService.listRunnableIntentIds()).toEqual([intent.id]);
  });

  it('with the switch back on Fly, the same deployment boots nothing', async () => {
    configureAwsPool();
    vi.stubEnv('MOTIR_FLEET_CI_RUNNER_PROVIDER', 'fly');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedTenant();

    const result = await handle(delivery());

    expect(result).toMatchObject({ outcome: 'recorded' });
    expect(bootEvents(captured.events)).toHaveLength(0);
    expect(await ciRunnerBootService.listRunnableIntentIds()).toEqual([]);
  });
});

describe('the hot event and the sweep event race — and produce ONE container', () => {
  it('the loser gets `already_claimed`, and exactly one machine is ever booted', async () => {
    // The two triggers are designed to overlap; the claim's compare-and-set is
    // what makes that safe, and this asserts it END TO END rather than trusting
    // it. Both events carry the same intent id, so both handlers call
    // `runIntent` with it — the second must spend nothing.
    stubGithubForBoot();
    await seedTenant();

    await handle(delivery());
    const [hot] = bootEvents(captured.events);
    const intentId = (hot!.data as { intentId: string }).intentId;

    // The sweep, a beat later, still sees the intent pending and fans out for it.
    const sweptIds = await ciRunnerBootService.listRunnableIntentIds();
    expect(sweptIds).toEqual([intentId]);

    const first = await ciRunnerBootService.runIntent(intentId, {
      ...FAST,
      sleep: async () => {
        const live = fakeOrchestrator.liveContainerIds();
        if (live[0]) fakeOrchestrator.completeJob(live[0]);
      },
    });
    const second = await ciRunnerBootService.runIntent(intentId, FAST);

    expect(first.outcome).toBe('settled');
    expect(second).toEqual({ outcome: 'already_claimed' });
    // ⚠️ EVERY container the fake was ever asked to boot, not just the live ones:
    // a second machine that was created and destroyed is still a second machine
    // the tenant paid for.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });
});

describe('the SWEEP is unchanged — it still drains a backlog', () => {
  it('fans out one identical boot event per pending intent', async () => {
    // The recovery path is load-bearing: it is what comes back for an intent the
    // hot call dropped AND for every intent the admission gate deferred.
    vi.spyOn(ciRunnerBootService, 'listRunnableIntentIds').mockResolvedValue(['i1', 'i2', 'i3']);
    const send = spyOnJobDispatch();

    const engine = new JobTestEngine({ function: ciRunnerProvisionSweep });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ dispatched: 3 });
    expect(dispatchedEvents(send)).toEqual([
      ciRunnerBootEvent('i1'),
      ciRunnerBootEvent('i2'),
      ciRunnerBootEvent('i3'),
    ]);
  });
});

/** GitHub, for the one test that drives the real provisioner: the provisioning
 *  installation lookup, its token, and the JIT mint. */
function stubGithubForBoot(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (href.endsWith(`/orgs/${MOTIR_ORG}/installation`)) return json({ id: 556677 });
      if (href.includes('/access_tokens')) {
        return json({
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (href.includes('generate-jitconfig')) {
        return json(
          {
            runner: { id: 9001, name: 'motir-runner', status: 'offline' },
            encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
          },
          201,
        );
      }
      void init;
      return new Response(null, { status: 204 });
    }),
  );
}
