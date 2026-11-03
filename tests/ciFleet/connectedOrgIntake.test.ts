import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { ciRunnerProvisioningService } from '@/lib/services/ciRunnerProvisioningService';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import type { NormalizedWorkflowJobEvent } from '@/lib/git/types';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// The fleet intake's CONNECTED-ORG fallback (Story MOTIR-8699 · MOTIR-8720),
// against real Postgres. A fleet-labelled job delivered on the PROVISIONING App's
// installation in an org whose repositories are mirrored under ANOTHER
// installation (Motir Integration's, for a `connected` repo) is attributed
// through the repository's own mirror row — but only once GitHub has confirmed
// the delivery's installation IS the provisioning App's on that owner.
//
// `fetch` is the only fake (the App-JWT read of `GET /orgs/{owner}/installation`).
// `withSystemContext` is wrapped, not replaced, so the suite can prove no HTTP
// call happens while a transaction is open.

const inTransaction = vi.hoisted(() => ({ depth: 0 }));
vi.mock('@/lib/workspaces/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces/context')>();
  return {
    ...actual,
    withSystemContext: async (...args: Parameters<typeof actual.withSystemContext>) => {
      inTransaction.depth += 1;
      try {
        return await actual.withSystemContext(...args);
      } finally {
        inTransaction.depth -= 1;
      }
    },
  };
});

const PASSWORD = 'hunter2hunter2';
const CONNECTED_ORG = 'Acme-Connected';
const MIRROR_INSTALLATION = '55501';
const STUDIO_INSTALLATION = '77001';
const PROVIDER_REPO_ID = '99001';

let githubAnswers: (url: string) => Response;
let fetchCalls: { url: string; duringTransaction: boolean }[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function event(overrides: Partial<NormalizedWorkflowJobEvent> = {}): NormalizedWorkflowJobEvent {
  return {
    runId: '7001',
    runAttempt: 1,
    jobId: String(randomInt(10_000, 99_999)),
    jobName: 'build',
    workflowName: 'CI',
    requestedLabels: [MOTIR_RUNNER_LABEL],
    providerRepoId: PROVIDER_REPO_ID,
    repoOwner: CONNECTED_ORG.toLowerCase(),
    repoName: 'motir-core',
    queuedAt: new Date('2026-10-15T09:00:00.000Z'),
    ...overrides,
  };
}

interface Fixture {
  organizationId: string;
  projectId: string;
  githubRepoId: string;
}

/** A workspace whose repository is mirrored under `installationId` (the
 *  user-facing App's), linked to a project. */
async function seedMirror(options?: {
  email?: string;
  installationId?: string;
  owner?: string;
}): Promise<Fixture> {
  const email = options?.email ?? 'connected@example.com';
  const owner = options?.owner ?? CONNECTED_ORG;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Motir',
    identifier: `M${randomInt(100, 1000)}`,
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: options?.installationId ?? MIRROR_INSTALLATION,
      accountLogin: owner,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: PROVIDER_REPO_ID,
        owner,
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
    where: {
      repoId: PROVIDER_REPO_ID,
      installation: { installationId: options?.installationId ?? MIRROR_INSTALLATION },
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'web',
      name: 'motir-core',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      position: 'a0',
      githubRepoId: githubRepo.id,
    },
  });
  return {
    organizationId: workspace.organizationId,
    projectId: project.id,
    githubRepoId: githubRepo.id,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  fetchCalls = [];
  githubAnswers = () => json(200, { id: Number(STUDIO_INSTALLATION) });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetProvisioningInstallationCache();
  _resetInstallationTokenCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCalls.push({ url: String(url), duringTransaction: inTransaction.depth > 0 });
      return githubAnswers(String(url));
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

describe('the connected-org fallback', () => {
  it('records the job when GitHub confirms the installation, through the one mirror row', async () => {
    const fx = await seedMirror();

    const result = await ciRunnerProvisioningService.recordQueuedJob(event(), STUDIO_INSTALLATION);

    expect(result).toMatchObject({
      outcome: 'recorded',
      organizationId: fx.organizationId,
      projectId: fx.projectId,
    });
    const intent = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow();
    expect(intent).toMatchObject({
      installationId: STUDIO_INSTALLATION,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      githubRepoId: fx.githubRepoId,
    });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      `https://api.github.com/orgs/${CONNECTED_ORG.toLowerCase()}/installation`,
    ]);
  });

  it('never calls GitHub while a transaction is open', async () => {
    await seedMirror();
    await ciRunnerProvisioningService.recordQueuedJob(event(), STUDIO_INSTALLATION);
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls.every((c) => !c.duringTransaction)).toBe(true);
  });

  it('refuses when GitHub answers a DIFFERENT installation id', async () => {
    await seedMirror();
    githubAnswers = () => json(200, { id: 12345 });
    expect(await ciRunnerProvisioningService.recordQueuedJob(event(), STUDIO_INSTALLATION)).toEqual(
      { outcome: 'unknown_installation' },
    );
    expect(await adminDb.ciRunnerProvisioningIntent.count()).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown installation'),
      expect.objectContaining({ reason: 'installation_mismatch' }),
    );
  });

  it.each([
    ['github_unreachable', () => Promise.reject(new Error('ECONNRESET'))],
    ['github_status_404', () => json(404, { message: 'Not Found' })],
  ] as const)('refuses with reason %s', async (reason, answer) => {
    await seedMirror();
    githubAnswers = answer as unknown as (url: string) => Response;
    expect(await ciRunnerProvisioningService.recordQueuedJob(event(), STUDIO_INSTALLATION)).toEqual(
      { outcome: 'unknown_installation' },
    );
    expect(await adminDb.ciRunnerProvisioningIntent.count()).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason }),
    );
  });

  it('refuses with not_configured when the Studio key is unwired', async () => {
    await seedMirror();
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '');
    expect(await ciRunnerProvisioningService.recordQueuedJob(event(), STUDIO_INSTALLATION)).toEqual(
      { outcome: 'unknown_installation' },
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'not_configured' }),
    );
  });

  it('refuses when no mirror row exists for the repository', async () => {
    expect(await ciRunnerProvisioningService.recordQueuedJob(event(), STUDIO_INSTALLATION)).toEqual(
      { outcome: 'unknown_repo' },
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'no_mirror_row' }),
    );
  });

  it('refuses when TWO mirror rows exist — it never takes the first', async () => {
    await seedMirror();
    // A second installation mirroring the SAME GitHub repository — inserted
    // directly, as the service write path would move the row rather than copy it.
    const first = await adminDb.githubRepo.findFirstOrThrow({
      where: { repoId: PROVIDER_REPO_ID },
    });
    const installation = await adminDb.githubInstallation.findUniqueOrThrow({
      where: { id: first.installationId },
    });
    const second = await adminDb.githubInstallation.create({
      data: {
        installationId: '55502',
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        workspaceId: installation.workspaceId,
        organizationId: installation.organizationId,
      },
    });
    await adminDb.githubRepo.create({
      data: {
        installationId: second.id,
        workspaceId: first.workspaceId,
        organizationId: first.organizationId,
        repoId: PROVIDER_REPO_ID,
        owner: first.owner,
        name: first.name,
        defaultBranch: first.defaultBranch,
      },
    });
    expect(await ciRunnerProvisioningService.recordQueuedJob(event(), STUDIO_INSTALLATION)).toEqual(
      { outcome: 'unknown_repo' },
    );
    expect(await adminDb.ciRunnerProvisioningIntent.count()).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'ambiguous_mirror_rows' }),
    );
  });

  it("refuses when the one mirror row's owner is not the delivery's", async () => {
    await seedMirror({ owner: 'someone-else' });
    expect(await ciRunnerProvisioningService.recordQueuedJob(event(), STUDIO_INSTALLATION)).toEqual(
      { outcome: 'unknown_repo' },
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'owner_mismatch' }),
    );
  });
});

describe('boot scoping is the label, never the fleet switch (MOTIR-10289)', () => {
  // The switch moves what jobs REQUEST — the org variable and, since MOTIR-10289,
  // CodeQL default setup. A job that still requests the label (a default setup
  // nobody moved, a hand-edited workflow) is served whatever the switch says
  // (`lib/ciFleet/config.ts`, "AND NOT BY TENANT FLAG").
  it.each([
    ['stored off', false],
    ['stored on', true],
  ])('a fleet-labelled job is recorded with the switch %s', async (_l, enabled) => {
    const fx = await seedMirror();
    await adminDb.platformFleetOrgCi.create({
      data: { projectId: fx.projectId, org: CONNECTED_ORG.toLowerCase(), enabled },
    });

    const result = await ciRunnerProvisioningService.recordQueuedJob(
      event({ jobName: 'Analyze (javascript-typescript)', workflowName: 'CodeQL' }),
      STUDIO_INSTALLATION,
    );

    expect(result).toMatchObject({ outcome: 'recorded', projectId: fx.projectId });
    expect(await adminDb.ciRunnerProvisioningIntent.count()).toBe(1);
  });
});

describe('the paths the fallback must not touch', () => {
  it('a job that is not fleet-labelled reads nothing and calls nothing', async () => {
    const findMany = vi.spyOn(adminDb.githubRepo, 'findMany');
    expect(
      await ciRunnerProvisioningService.recordQueuedJob(
        event({ requestedLabels: ['ubuntu-latest'] }),
        STUDIO_INSTALLATION,
      ),
    ).toEqual({ outcome: 'not_fleet_job', requestedLabels: ['ubuntu-latest'] });
    expect(fetchCalls).toHaveLength(0);
    expect(inTransaction.depth).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('a job whose installation HAS a mirror row takes today’s path with no GitHub call', async () => {
    const fx = await seedMirror();
    const result = await ciRunnerProvisioningService.recordQueuedJob(event(), MIRROR_INSTALLATION);
    expect(result).toMatchObject({ outcome: 'recorded', organizationId: fx.organizationId });
    expect(fetchCalls).toHaveLength(0);
  });
});
