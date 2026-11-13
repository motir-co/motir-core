import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerProvisioningService } from '@/lib/services/ciRunnerProvisioningService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// A fleet job's PROGRESS on its intents (MOTIR-11230), against real Postgres.
//
// The `workflow_job` `in_progress` / `completed` deliveries stamp the two facts
// the boot service's supervision reads to retire a runner with no job:
//
//   • `jobPickedUpAt` — on the intent whose RUNNER GitHub assigned the job to,
//     which is often NOT the intent booted for that job: a fleet runner takes
//     whichever queued job carries its label.
//   • `jobCompletedAt` — on the intents booted FOR the job, whoever ran it.

let jobSeq = 0;

async function seedTenant() {
  const email = `fleet-progress-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'O' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `P${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

async function seedIntent(
  fx: Awaited<ReturnType<typeof seedTenant>>,
  githubRunnerId: number | null,
) {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(51_000 + jobSeq),
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(),
      status: githubRunnerId === null ? 'pending' : 'running',
      githubRunnerId,
    },
  });
}

function delivery(
  action: string,
  job: { jobId: string; runnerId?: number | null; completedAt?: string; labels?: string[] },
) {
  return {
    action,
    workflow_job: {
      id: Number(job.jobId),
      run_id: 7001,
      run_attempt: 1,
      labels: job.labels ?? [MOTIR_RUNNER_LABEL],
      runner_id: job.runnerId ?? null,
      ...(job.completedAt ? { completed_at: job.completedAt } : {}),
    },
    repository: { id: 99001, name: 'acme-web', owner: { login: 'motir-projects' } },
    installation: { id: 556677 },
  };
}

const read = (id: string) =>
  adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('workflow_job progress stamps the intents supervision reads', () => {
  it('in_progress stamps the intent of the runner that TOOK the job — not the one booted for it', async () => {
    const fx = await seedTenant();
    const bootedFor = await seedIntent(fx, 9001); // booted for the job, its runner idle
    const tookIt = await seedIntent(fx, 9002); // booted for another job, took this one

    const result = await githubWebhookService.handleWorkflowJob(
      delivery('in_progress', { jobId: bootedFor.jobId, runnerId: 9002 }),
    );

    expect(result).toEqual({ event: 'workflow_job', outcome: 'progress_recorded' });
    expect((await read(tookIt.id)).jobPickedUpAt).not.toBeNull();
    expect((await read(bootedFor.id)).jobPickedUpAt).toBeNull();
    expect((await read(bootedFor.id)).jobCompletedAt).toBeNull();
  });

  it('completed stamps the job as done on the intent booted for it, with GitHub’s instant', async () => {
    const fx = await seedTenant();
    const bootedFor = await seedIntent(fx, 9001);
    const tookIt = await seedIntent(fx, 9002);

    await githubWebhookService.handleWorkflowJob(
      delivery('completed', {
        jobId: bootedFor.jobId,
        runnerId: 9002,
        completedAt: '2026-11-13T10:00:00Z',
      }),
    );

    const done = await read(bootedFor.id);
    expect(done.jobCompletedAt).toEqual(new Date('2026-11-13T10:00:00Z'));
    expect(done.jobPickedUpAt).toBeNull();
    expect((await read(tookIt.id)).jobPickedUpAt).not.toBeNull();
  });

  it('the stamps are write-once — a redelivery moves neither', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, 9001);
    const first = new Date('2026-11-13T10:00:00Z');
    await ciRunnerProvisioningService.recordJobProgress(
      {
        action: 'completed',
        runId: '7001',
        runAttempt: 1,
        jobId: intent.jobId,
        runnerId: 9001,
        repoOwner: 'motir-projects',
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        completedAt: first,
      },
      first,
    );
    const again = await ciRunnerProvisioningService.recordJobProgress(
      {
        action: 'completed',
        runId: '7001',
        runAttempt: 1,
        jobId: intent.jobId,
        runnerId: 9001,
        repoOwner: 'motir-projects',
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        completedAt: null,
      },
      new Date('2026-11-13T11:00:00Z'),
    );

    expect(again).toEqual({ outcome: 'recorded', pickedUp: 0, completed: 0 });
    const row = await read(intent.id);
    expect(row.jobPickedUpAt).toEqual(first);
    expect(row.jobCompletedAt).toEqual(first);
  });

  it('a completed job with no instant and no runner stamps the receipt time and no pickup', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, null);
    const now = new Date('2026-11-13T12:00:00Z');

    const result = await ciRunnerProvisioningService.recordJobProgress(
      {
        action: 'completed',
        runId: '7001',
        runAttempt: 1,
        jobId: intent.jobId,
        runnerId: null,
        repoOwner: 'motir-projects',
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        completedAt: null,
      },
      now,
    );

    expect(result).toEqual({ outcome: 'recorded', pickedUp: 0, completed: 1 });
    expect((await read(intent.id)).jobCompletedAt).toEqual(now);
  });

  it('a job outside the fleet’s labels is ignored before any write', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx, 9001);

    const result = await githubWebhookService.handleWorkflowJob(
      delivery('completed', { jobId: intent.jobId, runnerId: 9001, labels: ['ubuntu-latest'] }),
    );

    expect(result).toEqual({ event: 'workflow_job', outcome: 'not_fleet_job' });
    const row = await read(intent.id);
    expect(row.jobPickedUpAt).toBeNull();
    expect(row.jobCompletedAt).toBeNull();
  });

  it('an action supervision does not read is ignored', async () => {
    expect(
      await githubWebhookService.handleWorkflowJob(delivery('waiting', { jobId: '1' })),
    ).toEqual({ event: 'workflow_job', outcome: 'ignored_action' });
  });

  it('a stamp that fails is logged and the delivery is still acked', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(ciRunnerProvisioningService, 'recordJobProgress').mockRejectedValue(
      new Error('db down'),
    );

    const result = await githubWebhookService.handleWorkflowJob(
      delivery('in_progress', { jobId: '1', runnerId: 9001 }),
    );

    expect(result).toEqual({ event: 'workflow_job', outcome: 'failed' });
    expect(error.mock.calls[0]?.[0]).toContain('job-progress stamp failed');
  });
});
