import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFleetInventory, fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { fleetStopService } from '@/lib/services/fleetStopService';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { fleetReadinessService } from '@/lib/services/fleetReadinessService';
import { fleetOrgCiSettingService } from '@/lib/services/fleetOrgCiSettingService';
import {
  fleetAttributionService,
  FLEET_ATTRIBUTION_GRACE_MS,
} from '@/lib/services/fleetAttributionService';
import { _resetAiPlanCache } from '@/lib/services/aiPlanGateService';
import { actionsVariableClient } from '@/lib/github/actionsVariables';
import { runnerGroupClient } from '@/lib/github/runnerGroups';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { MOTIR_RUNNER_LABEL, MOTIR_RUNNER_VARIABLE } from '@/lib/ciFleet/config';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { withSystemContext } from '@/lib/workspaces/context';
import { _resetRunnerImageToolsCache } from '@/lib/services/runnerImageToolsService';
import { _resetWorkflowCoverageCache } from '@/lib/services/workflowCoverageService';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { createRunnerGroupFake, type RunnerGroupFake } from '../helpers/runnerGroupFake';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// THE STORY GATE for "Motir's own private repositories' CI on the shared runner
// fleet" (Story MOTIR-8699 · MOTIR-8716) — the ASSEMBLED connected-org path.
//
// Every sibling card shipped its own real-Postgres suite with its NEIGHBOUR
// faked: the intake (MOTIR-8720) stopped at the intent row, the group card
// (MOTIR-8712) at the `project_runner_group` row, the boot card (MOTIR-8711)
// started from a hand-inserted group row and a hand-inserted intent, the switch
// (MOTIR-8714) mocked the readiness verdict. Each boundary between them is where
// an org login, an installation id or a group id can drift silently. Here ONE
// fixture is driven through all of them, in the shape `fleetStoryGate.test.ts`
// (MOTIR-1927) gives the fleet's own story gate.
//
// What is REAL: Postgres; every service and repository; the webhook service, the
// intake's connected-org fallback, admission with its lock and claim, the
// shipped plan and credit checks, the group sync, the boot, the settle, the cost
// meter, the reconciler, the org stop, the setting service, the readiness verdict
// and the audit chain.
// What is FAKED, at its client only: GitHub (global `fetch` — one runner-group
// fake and one actions-variable fake PER ORG, keyed by the org in the URL), the
// job transport (`captureJobEvents`), motir-ai's plan/balance reads (global
// `fetch`) and the orchestrator (the `fake` adapter and its inventory, selected
// by env exactly as a deployment selects Fly).
//
// One seam is NOT GitHub and is stubbed anyway, for a stated reason:
//   * `getSession()` (`@/lib/auth`) — the one mock `CLAUDE.md` allows: a test has
//     no cookie, and the platform gate reads the operator from the session.
//
// The readiness verdict's image coverage (MOTIR-10290) reads the connected
// repository's workflows at its newest `.github` commit — answered by the same
// GitHub fake — and the pinned runner image's tool list, answered by a registry
// fake on its own host.

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const PASSWORD = 'hunter2hunter2';
/** The provisioning org — the shipped tenant path. */
const MOTIR_ORG = 'motir-projects';
const PROVISIONING_INSTALLATION = '556677';
/** The CONNECTED org — a fixture name, never Motir's real org. */
const CONNECTED_ORG = 'acme-connected';
/** The provisioning App's installation on the connected org: the one every
 *  `workflow_job` delivery from there arrives on, and the one with NO
 *  `github_installation` row. */
const DELIVERY_INSTALLATION = '880011';
/** The user-facing App's installation the connected repo is MIRRORED under. */
const MIRROR_INSTALLATION = '55501';
const CONNECTED_REPO = 'acme-core';
const CONNECTED_REPO_ID = '99001';
const WORKFLOW_SHA = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
const RUNNER_REGISTRY = 'registry.story-gate.test';
const RUNNER_IMAGE = `${RUNNER_REGISTRY}/motir-ci-runner@sha256:${'5a'.repeat(32)}`;
const CONNECTED_WORKFLOW = [
  'on: [pull_request]',
  'jobs:',
  '  build:',
  "    runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}",
  '    steps:',
  '      - run: git status && echo ok',
  '',
].join('\n');
const TENANT_REPO = 'acme-web';
const TENANT_REPO_ID = '99901';
const TENANT_INSTALLATION = '55901';

/** Relative to now: boot latency is measured against the wall clock. */
const QUEUED_AT = new Date(Date.now() - 5_000);
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;

const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

interface GithubCall {
  url: string;
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  authorization: string;
}

let githubCalls: GithubCall[];
let groups: Record<string, RunnerGroupFake>;
let variables: Record<string, ActionsVariableFake>;
let captured: { events: CapturedJobEvent[]; restore: () => void };
let mintedRunnerSeq: number;
/** The connected repository's CodeQL default setup (MOTIR-10289): configured,
 *  on `standard` until a flip moves it. */
let defaultSetup: { runner_type: 'standard' | 'labeled'; runner_label: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The token the fake mints for an installation — so a request's Authorization
 *  header names the installation it came from. */
function tokenFor(installationId: string): string {
  return `ghs_inst_${installationId}`;
}

function installGitHubAndMotirAi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const u = new URL(url);
      const method = init?.method ?? 'GET';

      // The pinned runner image's registry: a manifest, then a config whose
      // label records the tools the connected repository's job needs.
      if (u.host === RUNNER_REGISTRY) {
        if (u.pathname.includes('/manifests/')) {
          return json(200, { schemaVersion: 2, config: { digest: 'sha256:cfg' }, layers: [] });
        }
        return json(200, {
          config: { Labels: { 'co.motir.ci-runner.tools': 'bash,echo,git,sh' } },
        });
      }
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;

      // motir-ai (plan and balance) — the other side of the open-core boundary.
      // A paid plan with figures (MOTIR-9375: the CI gate reads the plan's CI burst cap).
      if (u.pathname === '/v1/stripe/subscription') {
        return json(200, {
          status: 'active',
          planTier: { key: 'max_x2', name: 'Max ×2', monthlyCreditAllotment: 60_000 },
        });
      }
      if (u.pathname === '/v1/usage') return json(200, { balance: 1_000 });

      const call: GithubCall = {
        url,
        path: u.pathname,
        method,
        body,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
      };
      githubCalls.push(call);

      // App-JWT reads of the App's installation on an org.
      if (u.pathname === `/orgs/${MOTIR_ORG}/installation`) {
        return json(200, { id: Number(PROVISIONING_INSTALLATION) });
      }
      if (u.pathname === `/orgs/${CONNECTED_ORG}/installation`) {
        return json(200, {
          id: Number(DELIVERY_INSTALLATION),
          permissions: {
            organization_self_hosted_runners: 'write',
            organization_actions_variables: 'write',
          },
          events: ['workflow_job'],
          repository_selection: 'selected',
          suspended_at: null,
        });
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(u.pathname);
      if (mint) {
        return json(201, {
          token: tokenFor(mint[1]!),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (u.pathname === '/installation/repositories') {
        return json(200, {
          total_count: 1,
          repositories:
            call.authorization === `Bearer ${tokenFor(DELIVERY_INSTALLATION)}`
              ? [{ id: Number(CONNECTED_REPO_ID) }]
              : [],
        });
      }
      if (u.pathname === `/repos/${CONNECTED_ORG}/${CONNECTED_REPO}/commits`) {
        return json(200, [
          { sha: WORKFLOW_SHA, commit: { committer: { date: '2026-09-30T00:00:00Z' } } },
        ]);
      }
      if (u.pathname === `/repos/${CONNECTED_ORG}/${CONNECTED_REPO}/git/trees/${WORKFLOW_SHA}`) {
        return json(200, {
          truncated: false,
          tree: [{ type: 'blob', path: '.github/workflows/ci.yml' }],
        });
      }
      if (
        u.pathname === `/repos/${CONNECTED_ORG}/${CONNECTED_REPO}/contents/.github/workflows/ci.yml`
      ) {
        return json(200, {
          encoding: 'base64',
          content: Buffer.from(CONNECTED_WORKFLOW).toString('base64'),
        });
      }
      // The minute meter's workflow-jobs read.
      if (
        /\/actions\/runs\/[^/]+\/attempts\/\d+\/jobs$|\/actions\/runs\/[^/]+\/jobs$/.test(
          u.pathname,
        )
      ) {
        return json(200, { total_count: 0, jobs: [] });
      }
      // The connected repository's CodeQL default setup — the flip moves it too.
      if (u.pathname === `/repos/${CONNECTED_ORG}/${CONNECTED_REPO}/code-scanning/default-setup`) {
        if (method === 'PATCH') {
          defaultSetup = {
            runner_type: body?.['runner_type'] === 'labeled' ? 'labeled' : 'standard',
            runner_label: String(body?.['runner_label'] ?? ''),
          };
          return json(200, {});
        }
        return json(200, { state: 'configured', ...defaultSetup });
      }
      const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
      if (repo && method === 'GET') return json(200, { name: repo[2], private: true });

      // The per-org fakes. Each answers ONLY its own org's URLs (`null` otherwise).
      for (const org of [CONNECTED_ORG, MOTIR_ORG]) {
        const group = await groups[org]!.handle(url, method, body);
        if (group) return group;
        const variable = variables[org]!.handle(url, method, body);
        if (variable) return variable;
      }

      // Runner registration and removal, in whichever org the URL names.
      const jit = /^\/orgs\/([^/]+)\/actions\/runners\/generate-jitconfig$/.exec(u.pathname);
      if (jit && method === 'POST') {
        mintedRunnerSeq += 1;
        return json(201, {
          runner: { id: 9_000 + mintedRunnerSeq, name: String(body?.['name'] ?? 'motir-runner') },
          encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
        });
      }
      if (/^\/orgs\/[^/]+\/actions\/runners\/\d+$/.test(u.pathname) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (/^\/orgs\/[^/]+\/actions\/runners$/.test(u.pathname) && method === 'GET') {
        return json(200, { total_count: 0, runners: [] });
      }
      return json(599, { message: `unexpected fetch in the story gate: ${method} ${url}` });
    }),
  );
}

// ── Fixtures ────────────────────────────────────────────────────────────────

interface ConnectedFixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  projectKey: string;
  githubRepoId: string;
  /** The `ProjectRunnerGroup` row the REAL sync wrote. */
  runnerGroupId: number;
  superadmin: PlatformPrincipal;
}

interface TenantFixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedWorkspace(label: string) {
  const suffix = `${label}-${randomInt(1_000_000)}`;
  const user = await usersService.createUser({
    email: `fleet-connected-gate-${suffix}@example.com`,
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
    name: label,
    identifier: `${label.slice(0, 1).toUpperCase()}${randomInt(100, 1000)}`,
  });
  return { user, workspace, project };
}

/**
 * Motir's shape, under a fixture name: a META organisation whose project's
 * private repository lives in a CONNECTED org, mirrored under the user-facing
 * App's installation, with no `github_installation` row for the provisioning
 * App's installation the deliveries arrive on — and a runner group in that org
 * created by the REAL sync against the runner-group fake.
 */
async function seedConnected(): Promise<ConnectedFixture> {
  const { workspace, project } = await seedWorkspace('Motir');
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { isMeta: true },
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: MIRROR_INSTALLATION,
      accountLogin: CONNECTED_ORG,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: CONNECTED_REPO_ID,
        owner: CONNECTED_ORG,
        name: CONNECTED_REPO,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const mirror = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: CONNECTED_REPO_ID },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'web',
      name: CONNECTED_REPO,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      position: 'a0',
      githubRepoId: mirror.id,
      state: 'connected',
    },
  });

  const sync = await projectRunnerGroupService.syncForProject({
    projectId: project.id,
    workspaceId: workspace.id,
  });
  const connected = sync.outcome === 'synced' ? sync.connectedOrgs?.[0] : undefined;
  if (!connected || connected.outcome !== 'synced') {
    throw new Error(`the connected-org sync did not sync: ${JSON.stringify(sync)}`);
  }
  const row = await adminDb.projectRunnerGroup.findFirstOrThrow({
    where: { projectId: project.id },
  });
  expect(row).toMatchObject({
    org: CONNECTED_ORG,
    installationId: DELIVERY_INSTALLATION,
    runnerGroupId: connected.runnerGroupId,
    syncPending: false,
  });

  const admin = await usersService.createUser({
    email: `fleet-superadmin-${randomInt(1_000_000)}@example.com`,
    password: PASSWORD,
    name: 'Platform admin',
  });
  await adminDb.user.update({ where: { id: admin.id }, data: { platformRole: 'superadmin' } });

  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
    projectKey: project.identifier,
    githubRepoId: mirror.id,
    runnerGroupId: row.runnerGroupId,
    superadmin: { userId: admin.id, email: admin.email, role: 'superadmin' },
  };
}

/** An ordinary paid tenant on the shipped path: a repository in the
 *  provisioning org, its group synced into `Project.runnerGroupId`. */
async function seedTenant(): Promise<TenantFixture> {
  const { workspace, project } = await seedWorkspace('Tenant');
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: TENANT_INSTALLATION,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: TENANT_REPO_ID,
        owner: MOTIR_ORG,
        name: TENANT_REPO,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const mirror = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: TENANT_REPO_ID } });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      role: 'web',
      name: TENANT_REPO,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      position: 'a0',
      githubRepoId: mirror.id,
      state: 'created',
    },
  });
  await projectRunnerGroupService.syncForProject({
    projectId: project.id,
    workspaceId: workspace.id,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

/** A `workflow_job` `queued` delivery shaped like GitHub's own. */
function delivery(
  repo: { owner: string; name: string; id: string },
  installationId: string,
  labels: string[] = [MOTIR_RUNNER_LABEL],
): { body: Record<string, unknown>; jobId: string } {
  jobSeq += 1;
  const jobId = 71_000 + jobSeq;
  return {
    jobId: String(jobId),
    body: {
      action: 'queued',
      workflow_job: {
        id: jobId,
        run_id: 81_000 + jobSeq,
        run_attempt: 1,
        name: 'build',
        workflow_name: 'CI',
        status: 'queued',
        labels,
        started_at: QUEUED_AT.toISOString(),
      },
      repository: { id: Number(repo.id), name: repo.name, owner: { login: repo.owner } },
      installation: { id: Number(installationId) },
    },
  };
}

const connectedRepo = { owner: CONNECTED_ORG, name: CONNECTED_REPO, id: CONNECTED_REPO_ID };
const tenantRepo = { owner: MOTIR_ORG, name: TENANT_REPO, id: TENANT_REPO_ID };

/** Deliver through the webhook service and return the recorded intent. */
async function deliver(repo: typeof connectedRepo, installationId: string) {
  const { body, jobId } = delivery(repo, installationId);
  const result = await githubWebhookService.handleWorkflowJob(body);
  expect(result).toEqual({ event: 'workflow_job', outcome: 'recorded' });
  return adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({ where: { jobId } });
}

function runToCompletion(intentId: string) {
  return ciRunnerBootService.runIntent(intentId, {
    ...FAST,
    sleep: async () => {
      const live = fakeOrchestrator.liveContainerIds();
      if (live[0]) fakeOrchestrator.completeJob(live[0]);
    },
  });
}

// ── Assertions over the recorded GitHub traffic ─────────────────────────────

const connectedRunners = `/orgs/${CONNECTED_ORG}/actions/runners`;

function runnerCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.path.includes('/actions/runners'));
}

function mintCalls(): GithubCall[] {
  return githubCalls.filter((c) => c.path.endsWith('/generate-jitconfig'));
}

function deregisterPaths(): string[] {
  return githubCalls
    .filter((c) => c.method === 'DELETE' && /\/actions\/runners\/\d+$/.test(c.path))
    .map((c) => c.path);
}

/** Every runner request named the connected org and carried the token minted for
 *  the DELIVERY's installation. */
function expectRunnersActedInConnectedOrg(): void {
  const runners = runnerCalls();
  expect(runners.length).toBeGreaterThan(0);
  for (const call of runners) {
    expect(call.path.startsWith(`${connectedRunners}/`), call.path).toBe(true);
    expect(call.authorization, call.path).toBe(`Bearer ${tokenFor(DELIVERY_INSTALLATION)}`);
  }
}

/** The provisioning org was never touched, and its installation never resolved. */
function expectNoProvisioningOrgTraffic(): void {
  const touched = githubCalls.filter(
    (c) =>
      c.path.startsWith(`/orgs/${MOTIR_ORG}/`) ||
      c.path === `/orgs/${MOTIR_ORG}/installation` ||
      c.path.includes(`/installations/${PROVISIONING_INSTALLATION}/`),
  );
  expect(
    touched.map((c) => `${c.method} ${c.path}`),
    'no request may reach the provisioning org on the connected path',
  ).toEqual([]);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_workflow_run_usage", "ci_period_usage", "ci_container_usage", "ci_container_period_cost", "fleet_in_flight_slot" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fakeOrchestrator.reset();
  fakeFleetInventory.reset();
  _resetAiPlanCache();
  githubCalls = [];
  mintedRunnerSeq = 0;
  defaultSetup = { runner_type: 'standard', runner_label: '' };
  currentSession = null;
  groups = {
    [CONNECTED_ORG]: createRunnerGroupFake(CONNECTED_ORG),
    [MOTIR_ORG]: createRunnerGroupFake(MOTIR_ORG),
  };
  variables = {
    [CONNECTED_ORG]: createActionsVariableFake(CONNECTED_ORG),
    [MOTIR_ORG]: createActionsVariableFake(MOTIR_ORG),
  };

  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', APP_PRIVATE_KEY);
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', APP_PRIVATE_KEY);
  vi.stubEnv('MOTIR_AI_URL', 'https://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
  _resetRunnerImageToolsCache();
  _resetWorkflowCoverageCache();
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  captured = captureJobEvents();
  installGitHubAndMotirAi();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

// ════════════════════════════════════════════════════════════════════════════

describe('A1 — a connected-org delivery becomes an intent', () => {
  it('records through the intake fallback, with the fixture tenant and the DELIVERY installation', async () => {
    const fx = await seedConnected();
    // The sync cached the positive installation lookup; forget it so the intake's
    // own proof is observable.
    _resetProvisioningInstallationCache();
    githubCalls = [];

    const intent = await deliver(connectedRepo, DELIVERY_INSTALLATION);

    expect(intent).toMatchObject({
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      githubRepoId: fx.githubRepoId,
      repoOwner: CONNECTED_ORG,
      repoName: CONNECTED_REPO,
      installationId: DELIVERY_INSTALLATION,
      status: 'pending',
    });
    // Precondition the fallback exists for: NO mirror row for this installation.
    expect(
      await adminDb.githubInstallation.count({ where: { installationId: DELIVERY_INSTALLATION } }),
    ).toBe(0);
    // The proof the fallback keys on — one App-JWT read of the connected org.
    expect(githubCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /orgs/${CONNECTED_ORG}/installation`,
    ]);
    // …and the hot path dispatched its boot.
    const dispatched = captured.events
      .filter((e) => e.name === 'system.ci-runner-boot')
      .map((e) => (e.data as { intentId: string }).intentId);
    expect(dispatched).toEqual([intent.id]);
    expectNoProvisioningOrgTraffic();
  });
});

describe('A2 — admission through the shipped paths', () => {
  it("admits the connected job from the meta org's own pool; a paid tenant beside it is admitted from ITS pool", async () => {
    const fx = await seedConnected();
    const tenant = await seedTenant();
    githubCalls = [];
    const plan = vi.spyOn(fleetCeilingService, 'planDeferral');
    const entitlement = vi.spyOn(ciAllowanceService, 'getEntitlementState');

    const intent = await deliver(connectedRepo, DELIVERY_INSTALLATION);
    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({ outcome: 'admitted', ciInFlight: 0 });
    // The plan check answered no deferral, the credit check `bypassed` — the
    // shipped paths, which no code in this story touches.
    expect(plan).toHaveBeenCalledWith(fx.organizationId);
    expect(await plan.mock.results[0]!.value).toBeNull();
    const metaEntitlement = entitlement.mock.calls.findIndex(([org]) => org === fx.organizationId);
    expect(await entitlement.mock.results[metaEntitlement]!.value).toMatchObject({
      state: 'bypassed',
    });

    const count = (org: string) =>
      withSystemContext((tx) => fleetCeilingService.orgCensus(org, new Date(), tx));
    expect((await count(fx.organizationId)).total).toBe(1);
    expect((await count(tenant.organizationId)).total).toBe(0);

    // The ordinary paid tenant, beside it: its own pool, unaffected by the meta
    // org's claim.
    const tenantIntent = await deliver(tenantRepo, TENANT_INSTALLATION);
    const tenantVerdict = await ciRunnerAdmissionService.admit(tenantIntent);
    expect(tenantVerdict).toMatchObject({ outcome: 'admitted', ciInFlight: 0 });
    const tenantEntitlement = entitlement.mock.calls.findIndex(
      ([org]) => org === tenant.organizationId,
    );
    expect(await entitlement.mock.results[tenantEntitlement]!.value).not.toMatchObject({
      state: 'bypassed',
    });
    expect((await count(tenant.organizationId)).total).toBe(1);
    expect((await count(fx.organizationId)).total).toBe(1);

    for (const id of [intent.id, tenantIntent.id]) {
      const row = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('provisioning');
    }
    expectNoProvisioningOrgTraffic();
  });
});

describe('A3 + A4 + A6 — boot, meter and teardown in the connected org', () => {
  it('mints in acme-connected through the delivery installation, into the synced group; settles one usage row; de-registers there', async () => {
    const fx = await seedConnected();
    const intent = await deliver(connectedRepo, DELIVERY_INSTALLATION);
    // The sync minted (and cached) this installation's token; forget it so the
    // boot's own mint is observable.
    _resetInstallationTokenCache();
    githubCalls = [];

    const outcome = await runToCompletion(intent.id);

    // A3 — the mint.
    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    expect(mintCalls()).toHaveLength(1);
    expect(mintCalls()[0]!.path).toBe(`${connectedRunners}/generate-jitconfig`);
    expect(mintCalls()[0]!.body).toMatchObject({
      runner_group_id: fx.runnerGroupId,
      labels: [MOTIR_RUNNER_LABEL],
    });
    // The group id is the one the REAL sync wrote — and GitHub holds that group
    // in the connected org, access-listing the connected repository.
    expect(groups[CONNECTED_ORG]!.onlyGroup()).toMatchObject({
      id: fx.runnerGroupId,
      repositoryIds: [Number(CONNECTED_REPO_ID)],
    });
    // Both fakes number their groups from the same base, so the provisioning org
    // holds a group with the SAME id — which is exactly why the org segment, not
    // the id, decides where a runner lands. That group never lists this repo.
    for (const group of groups[MOTIR_ORG]!.groups.values()) {
      expect(group.repositoryIds).not.toContain(Number(CONNECTED_REPO_ID));
    }
    // The token was minted for the DELIVERY's installation.
    expect(githubCalls.filter((c) => c.path.endsWith('/access_tokens')).map((c) => c.path)).toEqual(
      [`/app/installations/${DELIVERY_INSTALLATION}/access_tokens`],
    );

    // A6 — the settle de-registers in the same org, through the same installation.
    expect(deregisterPaths()).toEqual([`${connectedRunners}/9001`]);
    expectRunnersActedInConnectedOrg();
    expectNoProvisioningOrgTraffic();

    // A4 — the settle wrote exactly ONE usage row, attributed to the fixture org.
    const usage = await adminDb.ciContainerUsage.findMany();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      containerProvider: 'fake',
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workflowJobId: intent.jobId,
      repoFullName: `${CONNECTED_ORG}/${CONNECTED_REPO}`,
      workload: 'ci',
      teardownReason: 'job_completed',
    });
    const rollups = await adminDb.ciContainerPeriodCost.findMany();
    expect(rollups).toEqual([
      expect.objectContaining({ organizationId: fx.organizationId, containerCount: 1 }),
    ]);

    // The real MINUTE meter, on the same run: it meters only repositories in the
    // provisioning org (what Motir pays GitHub for, §5.1), so a connected-org run
    // is `foreign_owner` and writes no `ci_workflow_run_usage` row. The fleet's
    // record of this job is the container row above.
    const minutes = await ciMinutesMeterService.meterWorkflowRun(
      {
        providerRepoId: CONNECTED_REPO_ID,
        runId: String(intent.runId),
        attempt: 1,
        repoOwner: CONNECTED_ORG,
        repoName: CONNECTED_REPO,
        workflowName: 'CI',
        completedAt: new Date(),
      },
      DELIVERY_INSTALLATION,
    );
    expect(minutes).toEqual({ outcome: 'not_metered', reason: 'foreign_owner' });
    expect(await adminDb.ciWorkflowRunUsage.count()).toBe(0);
  });
});

describe('A5 — the reconciler spares the live connected-org machine', () => {
  it('keeps the booted container past the grace, and destroys the unattributed one', async () => {
    await seedConnected();
    const intent = await deliver(connectedRepo, DELIVERY_INSTALLATION);
    githubCalls = [];

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`boot did not supervise: ${booted.phase}`);
    const liveId = booted.session.handle.id;
    expect(fakeOrchestrator.liveContainerIds()).toEqual([liveId]);
    fakeFleetInventory.addStray({ app: 'fake-fleet', machineId: 'm-stray', createdAt: new Date() });

    const pass = await fleetAttributionService.reconcile({
      now: () => new Date(Date.now() + FLEET_ATTRIBUTION_GRACE_MS + 60_000),
    });

    expect(pass).toMatchObject({
      outcome: 'reconciled',
      matched: 1,
      killed: [expect.objectContaining({ machineId: 'm-stray', reason: 'no_record' })],
    });
    // The negative control: the reconciler RAN and destroyed something…
    expect(fakeFleetInventory.strayMachineIds()).toEqual([]);
    // …and the paying org's live machine is still there.
    expect(fakeOrchestrator.liveContainerIds()).toEqual([liveId]);
    expectRunnersActedInConnectedOrg();
    expectNoProvisioningOrgTraffic();
  });
});

describe('A6 — an admin stop de-registers in the connected org', () => {
  it("stops the org's booted intent and removes its runner from acme-connected", async () => {
    const fx = await seedConnected();
    const intent = await deliver(connectedRepo, DELIVERY_INSTALLATION);
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`boot did not supervise: ${booted.phase}`);
    githubCalls = [];

    const stop = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(stop).toMatchObject({ containersStopped: 1, failures: 0 });
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled).toMatchObject({ status: 'failed', teardownReason: 'admin_stop' });
    expect(deregisterPaths()).toEqual([`${connectedRunners}/${booted.session.githubRunnerId}`]);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expectRunnersActedInConnectedOrg();
    expectNoProvisioningOrgTraffic();
  });
});

describe('A7 — the switch, the variable and the readiness verdict, assembled', () => {
  it("ON writes MOTIR_RUNNER on acme-connected only; OFF deletes it there; motir-projects' variable never moves", async () => {
    const fx = await seedConnected();
    // The provisioning org already holds its own variable — the tenant path's.
    variables[MOTIR_ORG]!.seed({
      name: MOTIR_RUNNER_VARIABLE,
      value: MOTIR_RUNNER_LABEL,
      visibility: 'private',
    });
    const motirBefore = JSON.stringify([...variables[MOTIR_ORG]!.variables.entries()]);
    currentSession = { user: { id: fx.superadmin.userId } };
    const readiness = vi.spyOn(fleetReadinessService, 'readinessFor');
    githubCalls = [];

    const on = await fleetOrgCiSettingService.setEnabled(
      fx.superadmin,
      { projectId: fx.projectId, org: CONNECTED_ORG },
      true,
      'Move Motir CI onto the fleet',
    );

    expect(on.outcome).toBe('changed');
    // The REAL verdict was asked, and every one of its nine conditions was met
    // from the fixture: installation body, mirror rows, the synced group row and
    // the fixture manifest.
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(readiness).toHaveBeenCalledWith({
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      org: CONNECTED_ORG,
    });
    const verdict = await readiness.mock.results[0]!.value;
    expect(verdict.ready).toBe(true);
    expect(verdict.conditions).toHaveLength(9);
    expect(verdict.conditions.filter((c: { state: string }) => c.state !== 'met')).toEqual([]);
    expect(
      verdict.conditions.find((c: { key: string }) => c.key === 'delivery_attributable').params,
    ).toMatchObject({ path: 'unmirrored' });

    expect([...variables[CONNECTED_ORG]!.variables.values()]).toEqual([
      { name: MOTIR_RUNNER_VARIABLE, value: MOTIR_RUNNER_LABEL, visibility: 'private' },
    ]);
    for (const write of variables[CONNECTED_ORG]!.writeCalls()) {
      expect(write.url).toContain(`/orgs/${CONNECTED_ORG}/actions/variables`);
    }
    expect(JSON.stringify([...variables[MOTIR_ORG]!.variables.entries()])).toBe(motirBefore);
    // CodeQL default setup travelled with the variable (MOTIR-10289).
    expect(defaultSetup).toEqual({ runner_type: 'labeled', runner_label: MOTIR_RUNNER_LABEL });

    const off = await fleetOrgCiSettingService.setEnabled(
      fx.superadmin,
      { projectId: fx.projectId, org: CONNECTED_ORG },
      false,
      'Fall back to GitHub-hosted runners',
    );

    expect(off.outcome).toBe('changed');
    expect(variables[CONNECTED_ORG]!.variables.size).toBe(0);
    expect(JSON.stringify([...variables[MOTIR_ORG]!.variables.entries()])).toBe(motirBefore);
    // OFF never waits on readiness.
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(defaultSetup).toEqual({ runner_type: 'standard', runner_label: '' });

    const audit = await adminDb.platformAuditLog.findMany({
      where: { action: { startsWith: 'fleet.org_ci.' } },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((row) => row.action)).toEqual(['fleet.org_ci.enable', 'fleet.org_ci.disable']);
    expect(audit.every((row) => row.targetId === `${fx.projectId}:${CONNECTED_ORG}`)).toBe(true);

    // No variable endpoint of the provisioning org was ever asked.
    expect(variables[MOTIR_ORG]!.calls).toEqual([]);
    expectNoProvisioningOrgTraffic();
  });
});

describe('the per-org fakes key state by the org in the URL', () => {
  it('a write sent to the WRONG org lands there and is invisible under the right one', async () => {
    const wrong = {
      org: MOTIR_ORG,
      installationId: DELIVERY_INSTALLATION,
      role: 'provisioning' as const,
    };
    const right = {
      org: CONNECTED_ORG,
      installationId: DELIVERY_INSTALLATION,
      role: 'provisioning' as const,
    };

    await actionsVariableClient.ensureOrgVariable(MOTIR_RUNNER_VARIABLE, MOTIR_RUNNER_LABEL, wrong);
    expect(variables[MOTIR_ORG]!.variables.has(MOTIR_RUNNER_VARIABLE)).toBe(true);
    expect(variables[CONNECTED_ORG]!.variables.size).toBe(0);
    expect(await actionsVariableClient.getOrgVariable(MOTIR_RUNNER_VARIABLE, right)).toBeNull();

    const group = await runnerGroupClient.createGroup(
      { name: 'motir-project-wrong-org', selectedRepositoryIds: [1] },
      wrong,
    );
    expect(groups[MOTIR_ORG]!.groups.has(group.id)).toBe(true);
    expect(groups[CONNECTED_ORG]!.groups.size).toBe(0);
    expect(await runnerGroupClient.getGroup(group.id, right)).toBeNull();
  });
});

describe('A8 — regression: the tenant path is untouched', () => {
  it('a motir-projects delivery records, boots into Project.runnerGroupId and mints in motir-projects with no target', async () => {
    const tenant = await seedTenant();
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: tenant.projectId } });
    expect(project.runnerGroupId).not.toBeNull();
    expect(await adminDb.projectRunnerGroup.count()).toBe(0);
    githubCalls = [];

    const intent = await deliver(tenantRepo, TENANT_INSTALLATION);
    expect(intent).toMatchObject({
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      repoOwner: MOTIR_ORG,
      installationId: TENANT_INSTALLATION,
    });
    const mint = vi.spyOn(runnerJitConfigClient, 'mint');

    const outcome = await runToCompletion(intent.id);

    expect(outcome).toMatchObject({ outcome: 'settled', reason: 'job_completed' });
    // No target: the shipped call shape.
    expect(mint.mock.calls[0]![1]).toBeUndefined();
    expect(mintCalls().map((c) => c.path)).toEqual([
      `/orgs/${MOTIR_ORG}/actions/runners/generate-jitconfig`,
    ]);
    expect(mintCalls()[0]!.body).toMatchObject({ runner_group_id: project.runnerGroupId });
    // Through the provisioning installation, resolved the shipped way.
    expect(mintCalls()[0]!.authorization).toBe(`Bearer ${tokenFor(PROVISIONING_INSTALLATION)}`);
    expect(deregisterPaths()).toEqual([`/orgs/${MOTIR_ORG}/actions/runners/9001`]);
    expect(githubCalls.some((c) => c.path.startsWith(`/orgs/${CONNECTED_ORG}/`))).toBe(false);
  });
});
