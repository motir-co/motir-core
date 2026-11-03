import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import {
  fleetOrgCiStorePath,
  type FleetOrgCiCall,
  type FleetOrgCiControl,
  type FleetOrgCiOrgControl,
  type FleetOrgCiStore,
  type FleetOrgCiStoredVariable,
  FLEET_E2E_RUNNER_TOOLS,
} from '@/lib/test-github-fleet-org-ci-mock';
import { adminDb } from './db-reset';

/**
 * THE FLEET SETTINGS JOURNEY's GitHub and seed (Story MOTIR-8699 · MOTIR-8717).
 *
 * The seam (`lib/test-github-fleet-org-ci-mock.ts`) runs in the lane's Next server;
 * these helpers are the spec's half of it: WRITE the control, READ the journal and the
 * variable store, and seed the ONE target `fleetOrgCiSettingService.listTargets` offers.
 *
 * ⚠️ THE WORKFLOWS ARE THE SEAM'S. Since MOTIR-10290 the readiness verdict reads the
 * private repository's workflows at its newest `.github` commit and judges each fleet job
 * against the pinned runner image's tool list — both answered by the seam. So the seeded
 * repository carries ONE fleet workflow whose every command is a tool the seam's image
 * records ({@link FLEET_E2E_RUNNER_TOOLS}), and {@link pickRunnableRepo} throws when that
 * stops being true: a walk that cannot reach a ready verdict must fail, never pass
 * vacuously.
 */

const CONTROL = process.env['E2E_GITHUB_FLEET_ORG_CI_CONTROL'] ?? '';
const JOURNAL = process.env['E2E_GITHUB_FLEET_ORG_CI_JOURNAL'] ?? '';
/** The seeded org — any org but the provisioning one, which the console never offers. */
const FLEET_E2E_ORG = 'motir-fleet-e2e';
const FLEET_E2E_SHA = 'f1ee7e2e10290000000000000000000000000000';
const FLEET_E2E_WORKFLOW = {
  path: '.github/workflows/ci.yml',
  text: [
    'name: CI',
    'on: [push]',
    'jobs:',
    '  test:',
    "    runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}",
    '    steps:',
    '      - run: |',
    '          node --version',
    '          git --version',
    '          echo ok',
    '',
  ].join('\n'),
};

/** The App installation on the seeded org — distinct from every other E2E id. */
export const FLEET_E2E_INSTALLATION_ID = '99087170';
/** The seeded repository's GitHub id. */
export const FLEET_E2E_REPO_ID = 88_717_001;
/** The seeded project's key — what the page, the confirm and the audit target name. */
export const FLEET_E2E_PROJECT_KEY = 'FLEETCI';

const RUNNER_PERMISSION = 'organization_self_hosted_runners';
const VARIABLES_PERMISSION = 'organization_actions_variables';

export interface RunnableRepo {
  owner: string;
  name: string;
  repoRef: string;
  workflowCommit: { sha: string; date: string };
  workflows: Array<{ path: string; text: string }>;
}

/**
 * Case 0's precondition: a PRIVATE repository whose one fleet job the seam's runner
 * image can run. Throws when the fixture names a command the image does not record.
 */
export function pickRunnableRepo(): RunnableRepo {
  const needs = ['node', 'git', 'echo', 'bash'];
  const missing = needs.filter((t) => !FLEET_E2E_RUNNER_TOOLS.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `The fleet E2E runner image records no ${missing.join(', ')} — the fleet settings walk ` +
        'cannot reach a ready verdict, so it fails here rather than passing vacuously.',
    );
  }
  return {
    owner: FLEET_E2E_ORG,
    name: 'api',
    repoRef: `${FLEET_E2E_ORG}/api`,
    workflowCommit: { sha: FLEET_E2E_SHA, date: '2026-11-01T00:00:00Z' },
    workflows: [FLEET_E2E_WORKFLOW],
  };
}

/** What the fake GitHub says when every readiness condition is met. */
export function readyOrgControl(repo: RunnableRepo): FleetOrgCiOrgControl {
  return {
    installationId: FLEET_E2E_INSTALLATION_ID,
    permissions: {
      [RUNNER_PERMISSION]: 'write',
      [VARIABLES_PERMISSION]: 'write',
      actions: 'read',
    },
    events: ['workflow_job', 'pull_request'],
    repositorySelection: 'selected',
    suspendedAt: null,
    repositories: [
      {
        id: FLEET_E2E_REPO_ID,
        name: repo.name,
        private: true,
        // The workflows the verdict judges, at the commit it reads them at.
        workflowCommit: repo.workflowCommit,
        workflows: repo.workflows,
      },
    ],
  };
}

/** The ready control without `Variables: write` — case 3's not-ready verdict. */
export function withoutVariablesWrite(org: FleetOrgCiOrgControl): FleetOrgCiOrgControl {
  const permissions = { ...org.permissions };
  delete permissions[VARIABLES_PERMISSION];
  return { ...org, permissions };
}

/** Write the control the seam reads on every request. */
export function armFleetControl(control: FleetOrgCiControl): void {
  if (!CONTROL) throw new Error('E2E_GITHUB_FLEET_ORG_CI_CONTROL is not set on the runner.');
  writeFileSync(CONTROL, JSON.stringify(control));
}

/** A fresh forced-failure arming for the org's NEXT variable write. */
export function failNextWrite(status: number): { id: string; status: number } {
  return { id: randomUUID(), status };
}

/** Clear the journal and the seam's variable store — the start of a walk. */
export function resetFleetSeam(): void {
  if (!CONTROL || !JOURNAL) {
    throw new Error('The fleet org CI seam paths are not set on the runner.');
  }
  writeFileSync(JOURNAL, '');
  rmSync(fleetOrgCiStorePath(CONTROL), { force: true });
  armFleetControl({});
}

/** Every call the seam answered, in order. */
export function readFleetJournal(): FleetOrgCiCall[] {
  try {
    return readFileSync(JOURNAL, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FleetOrgCiCall);
  } catch {
    return [];
  }
}

/** The variable WRITES (POST, PATCH, DELETE) in the journal. */
export function variableWrites(calls: FleetOrgCiCall[] = readFleetJournal()): FleetOrgCiCall[] {
  return calls.filter((c) => c.method !== 'GET' && /\/actions\/variables(\/|$)/.test(c.path));
}

/** The seam's stored value of an org variable, or null when it does not exist. */
export function readStoredVariable(org: string, name: string): FleetOrgCiStoredVariable | null {
  try {
    const store = JSON.parse(readFileSync(fleetOrgCiStorePath(CONTROL), 'utf8')) as FleetOrgCiStore;
    return store.variables?.[org.toLowerCase()]?.[name] ?? null;
  } catch {
    return null;
  }
}

export interface FleetTargetSeed {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  org: string;
  repo: RunnableRepo;
}

/**
 * The ONE target `listTargets` offers: a META organisation's project with ONE
 * connected, established repository in the manifest's org, mirrored under the App
 * installation the control names, plus the project's synced runner group there.
 *
 * `listTargets`' predicate on this branch: projects whose workspace's organisation
 * `isMeta`; × each owner org of their `created`/`connected` project repositories that
 * carry a mirror row, other than the provisioning org; where the provisioning App is
 * installed (the seam) and at least one repository is private (the seam).
 */
export async function seedMotirCiTarget(repo: RunnableRepo): Promise<FleetTargetSeed> {
  const organization = await adminDb.organization.create({
    data: { name: 'Motir Meta (fleet E2E)', slug: 'motir-meta-fleet-e2e', isMeta: true },
  });
  const workspace = await adminDb.workspace.create({
    data: {
      name: 'Motir Meta fleet',
      slug: 'motir-meta-fleet-e2e-ws',
      organizationId: organization.id,
    },
  });
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Motir CI on the fleet',
      slug: 'motir-ci-fleet-e2e',
      identifier: FLEET_E2E_PROJECT_KEY,
    },
  });
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: FLEET_E2E_INSTALLATION_ID,
      workspaceId: workspace.id,
      organizationId: organization.id,
      accountLogin: repo.owner,
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: workspace.id,
      organizationId: organization.id,
      repoId: String(FLEET_E2E_REPO_ID),
      owner: repo.owner,
      name: repo.name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'api',
      name: repo.name,
      seedSource: SEED_SOURCE_ORGANIZATION,
      state: 'connected',
      position: 'a000',
      githubRepoId: mirror.id,
    },
  });
  await adminDb.projectRunnerGroup.create({
    data: {
      projectId: project.id,
      workspaceId: workspace.id,
      org: repo.owner.toLowerCase(),
      installationId: FLEET_E2E_INSTALLATION_ID,
      runnerGroupId: 87_170,
      runnerGroupName: `motir-${FLEET_E2E_PROJECT_KEY.toLowerCase()}`,
      syncedAt: new Date(),
      syncPending: false,
    },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: FLEET_E2E_PROJECT_KEY,
    org: repo.owner,
    repo,
  };
}

/** The stored setting row for the seeded pair, or null. */
export function readSettingRow(seed: FleetTargetSeed) {
  return adminDb.platformFleetOrgCi.findUnique({
    where: { projectId_org: { projectId: seed.projectId, org: seed.org.toLowerCase() } },
    select: { enabled: true, lastReason: true, updatedByUserId: true },
  });
}

/** How many `fleet.org_ci.*` audit rows exist. */
export function countFleetAuditRows(): Promise<number> {
  return adminDb.platformAuditLog.count({ where: { action: { startsWith: 'fleet.org_ci.' } } });
}
