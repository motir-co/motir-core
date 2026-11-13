import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { ciRunnerProvisioningService } from '@/lib/services/ciRunnerProvisioningService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// The runner-FLEET entry point against real Postgres (Story MOTIR-1916 ·
// MOTIR-1920) — `docs/decisions/ci-minutes-allowance.md`'s 2026-07-31 amendment.
//
// Nothing is stubbed: this path makes NO network call at all (unlike the meter,
// which reads the jobs API), so the attribution chain, the RLS contexts, the
// unique index and the label gate all run for real. Every acceptance criterion
// on the card is about what the DATABASE ends up holding.

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '55501';
const PROVIDER_REPO_ID = '99001';
const QUEUED_AT = '2026-08-01T09:00:00.000Z';

/** A `workflow_job` delivery shaped like GitHub's own. Defaults to a fleet job
 *  in a Motir-owned project repo. */
function delivery(
  overrides: {
    action?: string;
    labels?: string[];
    runId?: number | string;
    runAttempt?: number;
    jobId?: number | string;
    jobName?: string;
    workflowName?: string;
    repoId?: string;
    repoOwner?: string;
    repoName?: string;
    installationId?: string;
  } = {},
): Record<string, unknown> {
  return {
    action: overrides.action ?? 'queued',
    workflow_job: {
      id: overrides.jobId ?? 44001,
      run_id: overrides.runId ?? 7001,
      run_attempt: overrides.runAttempt ?? 1,
      name: overrides.jobName ?? 'build',
      workflow_name: overrides.workflowName ?? 'CI',
      status: 'queued',
      labels: overrides.labels ?? [MOTIR_RUNNER_LABEL],
      started_at: QUEUED_AT,
    },
    repository: {
      id: Number(overrides.repoId ?? PROVIDER_REPO_ID),
      name: overrides.repoName ?? 'acme-web',
      owner: { login: overrides.repoOwner ?? MOTIR_ORG },
    },
    installation: { id: Number(overrides.installationId ?? INSTALLATION_ID) },
  };
}

/** A `moooon-B-V` job the way one really arrives — Motir's OWN CI, on the same
 *  installation, `ubuntu-latest`, from a repo with no project row. This is the
 *  card's first test case (§J/§O): it must produce NOTHING. */
function moooonBvDelivery(jobName: string, jobId: number): Record<string, unknown> {
  return {
    action: 'queued',
    workflow_job: {
      id: jobId,
      run_id: 88002,
      run_attempt: 1,
      name: jobName,
      workflow_name: 'CI',
      status: 'queued',
      labels: ['ubuntu-latest'],
      started_at: QUEUED_AT,
    },
    repository: { id: 12345, name: 'motir-core', owner: { login: 'moooon-B-V' } },
    installation: { id: Number(INSTALLATION_ID) },
  };
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  githubRepoId: string;
}

/** A tenant with a GitHub installation, a connected repo in MOTIR'S org, and a
 *  repo-set row realizing it — the shape every Motir-created project repo has. */
async function seedTenant(options?: {
  email?: string;
  repoOwner?: string;
  repoName?: string;
  installationId?: string;
  providerRepoId?: string;
  withProjectRepo?: boolean;
}): Promise<Fixture> {
  const email = options?.email ?? 'ci-fleet@example.com';
  const repoOwner = options?.repoOwner ?? MOTIR_ORG;
  const repoName = options?.repoName ?? 'acme-web';
  const installationId = options?.installationId ?? INSTALLATION_ID;
  const providerRepoId = options?.providerRepoId ?? PROVIDER_REPO_ID;

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

  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: repoOwner, accountType: 'Organization' },
    repos: [
      { providerRepoId, owner: repoOwner, name: repoName, defaultBranch: 'main', archived: false },
    ],
  });
  const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: providerRepoId },
  });

  if (options?.withProjectRepo !== false) {
    await adminDb.projectRepo.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        role: 'web',
        name: repoName,
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

/** Drive a raw delivery through the webhook the way the route does — the seam
 *  the fleet actually runs on, not just the service beneath it. */
function handle(payload: Record<string, unknown>) {
  return githubWebhookService.handleEvent('workflow_job', payload);
}

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

describe('the §O LABEL GATE — the whole point of the card', () => {
  it('a `ubuntu-latest` job shaped like a real moooon-B-V job produces NO intent', async () => {
    // THE card's first test case. `workflow_job` `queued` fires for
    // GitHub-hosted jobs too, on the same installation, and Motir's own CI is
    // 31 of them per run. A handler that provisioned on event RECEIPT would
    // migrate Motir's release path onto infrastructure Motir is still building.
    await seedTenant();

    const results = await Promise.all([
      handle(moooonBvDelivery('lint', 90001)),
      handle(moooonBvDelivery('typecheck', 90002)),
      handle(moooonBvDelivery('vitest (shard 1)', 90003)),
      handle(moooonBvDelivery('e2e (shard 7)', 90004)),
    ]);

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({ event: 'workflow_job', outcome: 'not_fleet_job' })),
    );
    const ciRunnerProvisioningIntentCount = await adminDb.ciRunnerProvisioningIntent.count();
    expect(ciRunnerProvisioningIntentCount).toBe(0);
  });

  it('drops a non-fleet job BEFORE any tenant lookup — the gate is free', async () => {
    // The ordering is the design, not an optimisation detail: every motir-core
    // job delivers here, and none should cost a query. Proven by dropping the
    // job in a repo Motir has no mirror row for at all — an `unknown_repo`
    // outcome would mean the resolution chain ran before the label was checked.
    const result = await handle({
      ...delivery({ labels: ['ubuntu-latest'] }),
      installation: { id: 999999 },
    });
    expect(result).toEqual({ event: 'workflow_job', outcome: 'not_fleet_job' });
  });

  it('provisions for a job that lists the fleet label alongside others', async () => {
    const fx = await seedTenant();
    expect(await handle(delivery({ labels: ['self-hosted', MOTIR_RUNNER_LABEL] }))).toEqual({
      event: 'workflow_job',
      outcome: 'recorded',
    });
    const intent = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow();
    expect(intent.requestedLabels).toEqual(['self-hosted', MOTIR_RUNNER_LABEL]);
    expect(intent.organizationId).toBe(fx.organizationId);
  });
});

describe('the happy path — one attributed, persisted intent', () => {
  it('records exactly one intent, attributed to the right org', async () => {
    const fx = await seedTenant();

    expect(await handle(delivery())).toEqual({ event: 'workflow_job', outcome: 'recorded' });

    const intents = await adminDb.ciRunnerProvisioningIntent.findMany();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      provider: 'github',
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      githubRepoId: fx.githubRepoId,
      installationId: INSTALLATION_ID,
      runId: '7001',
      runAttempt: 1,
      jobId: '44001',
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      status: 'pending',
    });
    // The QUEUE instant, not the receipt instant — the age of an unclaimed
    // intent is what a stuck-queue alarm reads.
    expect(intents[0]?.queuedAt).toEqual(new Date(QUEUED_AT));
  });

  it('⚠️ a repository used by TWO projects still provisions — for the ORG, with no project', async () => {
    // Story MOTIR-4669 · MOTIR-4648 dropped `ProjectRepo.githubRepoId @unique`,
    // so this lookup can return N rows. The disposition, and it is deliberate on
    // both halves:
    //
    //   * PROVISIONING IS NOT REFUSED. A repository the organisation owns and two
    //     projects work on is the ordinary shape after this story; refusing its
    //     jobs would turn a supported model into an outage.
    //   * THE PROJECT IS NULL, not whichever row came back first. The organisation
    //     owns the fleet cost and is charged either way; the project is genuinely
    //     unknown, and `project_id` is nullable on the intent precisely for this.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fx = await seedTenant();
    const second = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: (await adminDb.user.findFirstOrThrow()).id,
      name: 'Beacon',
      identifier: `B${randomInt(100, 1000)}`,
    });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: second.id,
        role: 'web',
        name: 'acme-web',
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        position: 'a0',
        githubRepoId: fx.githubRepoId,
      },
    });

    expect(await handle(delivery())).toEqual({ event: 'workflow_job', outcome: 'recorded' });

    const intents = await adminDb.ciRunnerProvisioningIntent.findMany();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: null,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('used by several projects'),
      expect.objectContaining({ projectCount: 2 }),
    );
  });

  it('gives EVERY job of one run its own intent — a runner is per job', async () => {
    // The idempotency key is `(run_id, run_attempt, job_id)`, not the meter's
    // `(run_id, run_attempt)`. A run-level key would collapse a matrix into a
    // single intent and starve every job but the first.
    await seedTenant();

    for (const [i, name] of ['lint', 'typecheck', 'build', 'e2e'].entries()) {
      expect(await handle(delivery({ jobId: 44001 + i, jobName: name }))).toEqual({
        event: 'workflow_job',
        outcome: 'recorded',
      });
    }

    const intents = await adminDb.ciRunnerProvisioningIntent.findMany({
      orderBy: { jobId: 'asc' },
    });
    expect(intents.map((i) => i.jobName)).toEqual(['lint', 'typecheck', 'build', 'e2e']);
  });

  it('exposes the pending intents to the provisioner — the MOTIR-1921 seam', async () => {
    // A table nothing can read is a write-only log, not a seam (`notes.html`
    // #179). Oldest-QUEUED first, so a redelivered or delayed webhook cannot let
    // a fresh job jump ahead of one GitHub has already been holding.
    await seedTenant();
    await handle({
      ...delivery({ jobId: 44002, jobName: 'late' }),
      workflow_job: {
        ...(delivery({ jobId: 44002, jobName: 'late' })['workflow_job'] as object),
        started_at: '2026-08-01T09:05:00.000Z',
      },
    });
    await handle(delivery({ jobId: 44001, jobName: 'early' }));

    const pending = await ciRunnerProvisioningService.listPendingIntents();
    expect(pending.map((i) => i.jobName)).toEqual(['early', 'late']);
  });
});

describe('attribution failures — logged, never provisioned', () => {
  it('a fleet job on an unknown installation produces none, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedTenant();

    expect(await handle(delivery({ installationId: '999999' }))).toEqual({
      event: 'workflow_job',
      outcome: 'unknown_installation',
    });
    const ciRunnerProvisioningIntentCount = await adminDb.ciRunnerProvisioningIntent.count();
    expect(ciRunnerProvisioningIntentCount).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('a fleet job in a repo Motir does not mirror produces none, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedTenant();

    expect(await handle(delivery({ repoId: '777777' }))).toEqual({
      event: 'workflow_job',
      outcome: 'unknown_repo',
    });
    const ciRunnerProvisioningIntentCount = await adminDb.ciRunnerProvisioningIntent.count();
    expect(ciRunnerProvisioningIntentCount).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('a fleet job that resolves to no project produces none, and warns', async () => {
    // A repo in Motir's org with no repo-set row: real compute asked for on
    // nobody's behalf. Unlike the meter's §5.4 case (where GitHub has already
    // charged and the cost must be recorded), the money is not spent yet — so
    // this is REFUSED, and the warning is the only signal that a repo escaped
    // the repo-set path.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedTenant({ withProjectRepo: false });

    expect(await handle(delivery())).toEqual({
      event: 'workflow_job',
      outcome: 'unattributed',
    });
    const ciRunnerProvisioningIntentCount = await adminDb.ciRunnerProvisioningIntent.count();
    expect(ciRunnerProvisioningIntentCount).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no attributable project'),
      expect.objectContaining({ repoName: 'acme-web' }),
    );
  });

  it('a delivery with no installation object is a fast no-op', async () => {
    const payload = delivery();
    delete payload['installation'];
    expect(await handle(payload)).toEqual({
      event: 'workflow_job',
      outcome: 'unknown_installation',
    });
  });
});

describe('idempotency — redelivery vs. re-run', () => {
  it('a REDELIVERY of the same webhook is a no-op', async () => {
    await seedTenant();

    expect(await handle(delivery())).toEqual({ event: 'workflow_job', outcome: 'recorded' });
    expect(await handle(delivery())).toEqual({ event: 'workflow_job', outcome: 'duplicate' });
    const ciRunnerProvisioningIntentCount = await adminDb.ciRunnerProvisioningIntent.count();
    expect(ciRunnerProvisioningIntentCount).toBe(1);
  });

  it('a RE-RUN (run_attempt: 2) produces a NEW intent', async () => {
    // A re-run is genuinely new work: its jobs need their own ephemeral runners,
    // because the first attempt's runners de-registered after their single job.
    await seedTenant();

    await handle(delivery({ runAttempt: 1 }));
    expect(await handle(delivery({ runAttempt: 2 }))).toEqual({
      event: 'workflow_job',
      outcome: 'recorded',
    });

    const intents = await adminDb.ciRunnerProvisioningIntent.findMany({
      orderBy: { runAttempt: 'asc' },
    });
    expect(intents.map((i) => i.runAttempt)).toEqual([1, 2]);
  });

  it('CONCURRENT deliveries of the same job insert exactly ONE intent', async () => {
    // Whichever way the two interleave, the outcome set is the same: one
    // records, one reports duplicate, and the table holds a single row. Both
    // legitimate resolutions are accepted (one racer may lose at the pre-check
    // rather than at the index) — pinning a single one would be pinning a
    // scheduling accident. The index itself is proven deterministically below.
    await seedTenant();

    const results = await Promise.all([handle(delivery()), handle(delivery())]);

    const outcomes = results
      .map((r) => (r as { outcome: string }).outcome)
      .sort((a, b) => a.localeCompare(b));
    expect(outcomes).toEqual(['duplicate', 'recorded']);
    const ciRunnerProvisioningIntentCount = await adminDb.ciRunnerProvisioningIntent.count();
    expect(ciRunnerProvisioningIntentCount).toBe(1);
  });

  it('the UNIQUE INDEX — not the pre-check — is what guarantees once', async () => {
    // The pre-check is a round-trip saver, and two genuinely simultaneous
    // deliveries both miss it. This forces exactly that window open — the
    // pre-check reports "nothing yet" while a row already exists — so the insert
    // reaches the `(run_id, run_attempt, job_id)` index and the P2002 it raises
    // is what produces `duplicate`.
    //
    // It matters more here than for the meter: a lost race that fell through to
    // a second intent would boot a SECOND ephemeral runner for one job, and the
    // second would idle to its timeout with no job to claim.
    //
    // Mutation-check: drop the unique index from the migration and this fails
    // with a count of 2 (the pre-check alone cannot catch it).
    await seedTenant();
    expect(await handle(delivery())).toEqual({ event: 'workflow_job', outcome: 'recorded' });

    vi.spyOn(ciRunnerProvisioningIntentRepository, 'findByJobKey').mockResolvedValueOnce(null);

    expect(await handle(delivery())).toEqual({ event: 'workflow_job', outcome: 'duplicate' });
    const ciRunnerProvisioningIntentCount = await adminDb.ciRunnerProvisioningIntent.count();
    expect(ciRunnerProvisioningIntentCount).toBe(1);
  });
});

describe('the event surface', () => {
  it.each(['in_progress', 'completed'])('records NO intent for the `%s` action', async (action) => {
    // MOTIR-11230: these actions now stamp job PROGRESS on existing intents
    // (tests/ciFleet/workflowJobProgress.test.ts) — and still provision nothing.
    await seedTenant();
    expect(await handle(delivery({ action }))).toEqual({
      event: 'workflow_job',
      outcome: 'progress_recorded',
    });
    const ciRunnerProvisioningIntentCount2 = await adminDb.ciRunnerProvisioningIntent.count();
    expect(ciRunnerProvisioningIntentCount2).toBe(0);
  });

  it('acks — never 500s — when the write throws for a reason that is NOT a duplicate', async () => {
    // An ack that 500s makes GitHub retry, and a retry cannot fix a dead DB
    // connection. The idempotency key means a later redelivery records it
    // exactly once, so dropping this one loses nothing.
    //
    // The failure is injected at the REPOSITORY, not at the service, so this
    // also proves the service re-throws a non-P2002 error rather than
    // swallowing it as a duplicate — a catch that treated every failure as
    // "already recorded" would silently drop jobs forever.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedTenant();
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'create').mockRejectedValueOnce(
      new Error('database is on fire'),
    );

    expect(await handle(delivery())).toEqual({ event: 'workflow_job', outcome: 'failed' });
    const ciRunnerProvisioningIntentCount = await adminDb.ciRunnerProvisioningIntent.count();
    expect(ciRunnerProvisioningIntentCount).toBe(0);
    expect(error).toHaveBeenCalled();
  });

  it('a malformed workflow_job body is ignored, not an error', async () => {
    expect(await handle({ action: 'queued', repository: {} })).toEqual({
      event: 'workflow_job',
      outcome: 'ignored_action',
    });
  });
});
