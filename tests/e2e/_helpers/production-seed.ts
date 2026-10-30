import { writeFileSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { adminDb } from './db-reset';
import { E2E_PROVISIONING_ORG } from './github-const';
import { postSignedWebhook } from './github-seed';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ProductionReleaseControl } from '@/lib/test-production-release-mock';
import { linkProjectRepo } from '../../helpers/projectRepoLink';
import { setWorkspaceRoleFor } from '../../helpers/workspaceRoleFixtures';

// Seed and drivers for Story MOTIR-9797's E2E + acceptance recording (Subtask
// MOTIR-10040).
//
// The state the journey STARTS from and nothing further: a project with two
// repositories Motir hosts on Fly, switched on for production with a production
// address the way enablement (MOTIR-10027) records it, and one repository the
// customer imported (organisation-seeded); an ADMINISTRATOR and a MEMBER. No
// release is seeded — every release is made by a merge delivered through the
// real webhook, and released by the job worker against the fake hosting port.
//
// ⚠️ The administrator is a workspace ADMIN, never the owner, as in the
// environment seed: the owner rides the always-pass rail, so a member's missing
// control would be the only thing telling the two roles apart.
//
// THE DRIVERS. `deliverMerge` POSTs a signed `production-image` workflow_run to
// `/api/github/webhook`. `holdHosting` / `releaseHosting` write the hosting fake's
// HOLD sidecar (`packages/orchestrator/src/adapters/fake/hosting.ts`): a held
// operation waits in whichever process runs it — the worker's deploy, the
// webServer's rollback — until the spec lets it go, so the in-flight state is on
// screen for as long as the spec needs it.

export const PRODUCTION_PASSWORD = 'production-e2e-pass-9797';
export const PRODUCTION_PROJECT_KEY = 'PROD';
/** The App installation the seeded repositories are mirrored under. */
export const PRODUCTION_INSTALLATION_ID = '99979701';

/** A manifest with a database, so each release creates it and migrates first. */
export const PRODUCTION_MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
};

export interface ProductionRepo {
  id: string;
  name: string;
  providerRepoId: string;
  /** The production host, without scheme; null for the customer repository. */
  address: string | null;
}

export interface ProductionSeed {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  adminEmail: string;
  adminName: string;
  memberEmail: string;
  password: string;
  /** The repository the walk releases and rolls back. */
  web: ProductionRepo;
  /** A second Motir repository, released once. */
  api: ProductionRepo;
  /** The customer's imported repository — never offered, never addressable. */
  customer: ProductionRepo;
}

export async function seedProductionRoom(slug: string): Promise<ProductionSeed> {
  const owner = await usersService.createUser({
    email: `prod-owner-${slug}@example.com`,
    password: PRODUCTION_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Production Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Acme Shop',
    identifier: PRODUCTION_PROJECT_KEY,
  });

  // Each run gets its own provider ids, so a GitHub id a previous run mirrored
  // can never resolve to this run's rows.
  const base = 880_000_000 + (Date.now() % 1_000_000) * 10;
  const mirrored = [
    { key: 'web', name: `shop-web-${slug}`, providerRepoId: String(base + 1) },
    { key: 'api', name: `shop-api-${slug}`, providerRepoId: String(base + 2) },
    { key: 'customer', name: `their-api-${slug}`, providerRepoId: String(base + 3) },
  ] as const;
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: PRODUCTION_INSTALLATION_ID,
      accountLogin: E2E_PROVISIONING_ORG,
      accountType: 'Organization',
    },
    repos: mirrored.map((r) => ({
      providerRepoId: r.providerRepoId,
      owner: E2E_PROVISIONING_ORG,
      name: r.name,
      defaultBranch: 'main',
      archived: false,
    })),
  });

  async function repo(entry: (typeof mirrored)[number]): Promise<ProductionRepo> {
    const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
      where: { workspaceId: workspace.id, repoId: entry.providerRepoId },
    });
    const row = await linkProjectRepo({
      workspaceId: workspace.id,
      projectId: project.id,
      githubRepoId: githubRepo.id,
      name: entry.name,
      role: entry.key === 'web' ? 'web' : 'api',
    });
    const customer = entry.key === 'customer';
    await adminDb.projectRepo.update({
      where: { id: row.id },
      data: {
        state: 'created',
        seedSource: customer ? SEED_SOURCE_ORGANIZATION : 'nextjs-prisma-fly-starter',
        hostingTarget: 'fly',
      },
    });
    if (customer) {
      return { id: row.id, name: entry.name, providerRepoId: entry.providerRepoId, address: null };
    }
    // Production switched on, as enablement records it: the app name the
    // workflow pushes to, when, and the address the workspace's label gives it.
    const address = `${entry.key === 'web' ? 'shop' : 'shop-api'}--acme-${slug}.motir.site`;
    const app = await hostedApplicationService.ensureApplication(row.id);
    await adminDb.hostedApplication.update({
      where: { id: app.id },
      data: {
        productionAppName: `mh-${row.id}`,
        productionEnabledAt: new Date(),
        productionAddress: address,
      },
    });
    return { id: row.id, name: entry.name, providerRepoId: entry.providerRepoId, address };
  }

  const [web, api, customer] = [
    await repo(mirrored[0]),
    await repo(mirrored[1]),
    await repo(mirrored[2]),
  ];
  writeProductionReleaseControl({
    installations: { [E2E_PROVISIONING_ORG]: 99_100_001 },
    manifests: Object.fromEntries(
      [web, api].map((r) => [`${E2E_PROVISIONING_ORG}/${r.name}`, PRODUCTION_MANIFEST]),
    ),
  });

  async function persona(label: string, name: string, role: 'admin' | 'member') {
    const email = `prod-${label}-${slug}@example.com`;
    const user = await usersService.createUser({ email, password: PRODUCTION_PASSWORD, name });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await adminDb.projectMembership.create({
      data: { userId: user.id, projectId: project.id, workspaceId: workspace.id },
    });
    await setWorkspaceRoleFor(user.id, workspace.id, role);
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
    return email;
  }

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    adminEmail: await persona('admin', 'Ada Admin', 'admin'),
    adminName: 'Ada Admin',
    memberEmail: await persona('member', 'Max Member', 'member'),
    password: PRODUCTION_PASSWORD,
    web,
    api,
    customer,
  };
}

// ── The GitHub seam's control ────────────────────────────────────────────────

function envPath(name: string): string {
  const path = process.env[name];
  if (!path) throw new Error(`${name} is not set — is this the acceptance lane?`);
  return path;
}

/** What the worker's GitHub answers (`lib/test-production-release-mock.ts`). */
export function writeProductionReleaseControl(control: ProductionReleaseControl): void {
  writeFileSync(envPath('MOTIR_PRODUCTION_RELEASE_CONTROL_PATH'), JSON.stringify(control));
}

// ── The hosting fake's hold ──────────────────────────────────────────────────

type HoldableOperation = 'deploy' | 'rollback';

/** Hold these hosting operations, in every process, until `releaseHosting()`. */
export function holdHosting(...held: HoldableOperation[]): void {
  writeFileSync(`${envPath('MOTIR_FAKE_HOSTING_STATE_PATH')}.hold.json`, JSON.stringify({ held }));
}

/** Let every held hosting operation run. */
export function releaseHosting(): void {
  holdHosting();
}

// ── The merge entry ──────────────────────────────────────────────────────────

let runSeq = 0;

/** A 40-hex commit sha whose short form reads as the number it carries. */
export function commit(n: number): string {
  return `${String(n).padStart(4, '0')}abc`.padEnd(40, 'e');
}

/**
 * Deliver GitHub's `workflow_run` completed for the repository's
 * `production-image` workflow on a push to `main`, signed, through the REAL
 * webhook route. The route awaits the whole handling — the release job is
 * enqueued — before it answers.
 */
export async function deliverMerge(
  request: Page['request'] | APIRequestContext,
  repo: ProductionRepo,
  headSha: string,
  conclusion: 'success' | 'failure' = 'success',
): Promise<number> {
  runSeq += 1;
  const res = await postSignedWebhook(request, 'workflow_run', {
    action: 'completed',
    workflow_run: {
      id: 9_100_000_000 + (Date.now() % 1_000_000) * 100 + runSeq,
      name: 'production-image',
      head_branch: 'main',
      head_sha: headSha,
      path: '.github/workflows/production-image.yml',
      event: 'push',
      status: 'completed',
      conclusion,
      run_attempt: 1,
      run_started_at: new Date(Date.now() - 120_000).toISOString(),
      created_at: new Date(Date.now() - 120_000).toISOString(),
      updated_at: new Date().toISOString(),
    },
    workflow: { name: 'production-image', path: '.github/workflows/production-image.yml' },
    repository: {
      id: Number(repo.providerRepoId),
      name: repo.name,
      full_name: `${E2E_PROVISIONING_ORG}/${repo.name}`,
      private: true,
      owner: { login: E2E_PROVISIONING_ORG, type: 'Organization' },
      default_branch: 'main',
    },
    organization: { login: E2E_PROVISIONING_ORG },
    installation: { id: Number(PRODUCTION_INSTALLATION_ID) },
  });
  return res.status();
}

// ── Authoritative reads ──────────────────────────────────────────────────────

/** The repository's releases, newest first: commit and state. */
export async function releasesOf(repo: ProductionRepo) {
  const rows = await adminDb.hostedRelease.findMany({
    where: { application: { projectRepositoryId: repo.id } },
    orderBy: { createdAt: 'desc' },
    select: { commitSha: true, state: true },
  });
  return rows.map((r) => ({ commit: r.commitSha, state: r.state }));
}
