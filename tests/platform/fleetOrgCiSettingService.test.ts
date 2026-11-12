import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  FleetOrgCiCodeScanningError,
  FleetOrgCiGithubWriteError,
  FleetOrgCiNotReadyError,
  FleetOrgCiTargetUnknownError,
  MissingAuditReasonError,
  NotPlatformStaffError,
} from '@/lib/platform/errors';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { ORG_VARIABLE_VISIBILITY } from '@/lib/github/actionsVariables';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { platformFleetOrgCiRepository } from '@/lib/repositories/platformFleetOrgCiRepository';
import type { FleetReadiness } from '@/lib/services/fleetReadinessService';
import type { PlatformRole } from '@/generated/prisma/client';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET ORG CI SETTING (Story MOTIR-8699 · MOTIR-8714) against a real
// Postgres: the setting row, the meta-org project and its repositories, and the
// hash-chained audit trail are real. GitHub is a fake at `fetch` (the variable,
// the repositories' visibility, the installation token), the provisioning-App
// lookup and the readiness verdict are faked at their seams.

const ORG = 'acme-connected';
const PROVISIONING_ORG = 'motir-projects';
const INSTALLATION = '880011';
const VARIABLE_PATH = `/orgs/${ORG}/actions/variables/MOTIR_RUNNER`;

vi.mock('@/lib/github/repoProvisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/repoProvisioning')>()),
  findProvisioningInstallationId: vi.fn(async (org: string) =>
    org.toLowerCase() === ORG ? INSTALLATION : null,
  ),
}));

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError: Refused } = await import('@/lib/platform/errors');
        throw new Refused();
      }
      return currentPrincipal;
    },
  };
});

const {
  fleetOrgCiSettingService: service,
  plannedDefaultSetupMoves,
  flipTransactionTimeoutMs,
  FLIP_TRANSACTION_BASE_MS,
  FLIP_GITHUB_REQUEST_BUDGET_MS,
} = await import('@/lib/services/fleetOrgCiSettingService');
const { codeScanningDefaultSetupClient } = await import('@/lib/github/codeScanningDefaultSetup');
const { fleetReadinessService } = await import('@/lib/services/fleetReadinessService');
const { findProvisioningInstallationId, RepoProvisioningApiError } =
  await import('@/lib/github/repoProvisioning');
const { RepoVisibilityApiError, repoVisibilityClient } =
  await import('@/lib/github/repoVisibility');
const { actionsVariableClient } = await import('@/lib/github/actionsVariables');

interface World {
  variable: { value: string; visibility: string } | null;
  /** Fail the next write of this method with this status (`null` = unreachable). */
  failWrite: { method: string; status: number | null } | null;
  failRead: number | null;
  calls: string[];
  /** Each repository's CodeQL default setup, by name; absent → not configured. */
  setups: Record<string, GithubDefaultSetup>;
  /** Fail the next default-setup call of this method on this repository. */
  failSetup: { repo: string; method: string; status: number | null; message?: string } | null;
  setupCalls: Array<{ method: string; repo: string; body: Record<string, unknown> | null }>;
}

interface GithubDefaultSetup {
  state: 'configured' | 'not-configured';
  runner_type: 'standard' | 'labeled' | null;
  runner_label: string | null;
}

const LABELED: GithubDefaultSetup = {
  state: 'configured',
  runner_type: 'labeled',
  runner_label: MOTIR_RUNNER_LABEL,
};
const STANDARD: GithubDefaultSetup = {
  state: 'configured',
  runner_type: 'standard',
  runner_label: '',
};
const NOT_CONFIGURED: GithubDefaultSetup = {
  state: 'not-configured',
  runner_type: 'standard',
  runner_label: null,
};

let world: World;
let fx: WorkItemFixture;
let superadmin: PlatformPrincipal;

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      if (/\/app\/installations\/\d+\/access_tokens$/.test(u.pathname)) {
        return json(200, {
          token: 'ghs_setting_secret',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const setup = /^\/repos\/([^/]+)\/([^/]+)\/code-scanning\/default-setup$/.exec(u.pathname);
      if (setup) return defaultSetupCall(setup[2]!, method, init?.body);
      const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
      if (repo) return json(200, { private: !repo[2]!.startsWith('site') });
      if (u.pathname.startsWith(`/orgs/${ORG}/actions/variables`)) {
        world.calls.push(method);
        if (method === 'GET') {
          if (world.failRead !== null) return json(world.failRead, { message: 'nope' });
          return world.variable
            ? json(200, { name: 'MOTIR_RUNNER', ...world.variable })
            : json(404, { message: 'Not Found' });
        }
        if (world.failWrite && world.failWrite.method === method) {
          if (world.failWrite.status === null) throw new TypeError('fetch failed');
          return json(world.failWrite.status, { message: 'Resource not accessible' });
        }
        const body = init?.body ? (JSON.parse(init.body) as Record<string, string>) : {};
        if (method === 'POST') {
          if (world.variable) return json(409, { message: 'exists' });
          world.variable = { value: body['value']!, visibility: body['visibility']! };
          return json(201, {});
        }
        if (method === 'PATCH' && u.pathname === VARIABLE_PATH) {
          if (!world.variable) return json(404, { message: 'Not Found' });
          world.variable = { value: body['value']!, visibility: body['visibility']! };
          return new Response(null, { status: 204 });
        }
        if (method === 'DELETE' && u.pathname === VARIABLE_PATH) {
          if (!world.variable) return json(404, { message: 'Not Found' });
          world.variable = null;
          return new Response(null, { status: 204 });
        }
      }
      return json(500, { message: `unexpected fetch ${method} ${u.href}` });
    }),
  );
}

function defaultSetupCall(repo: string, method: string, raw?: string): Response {
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  world.setupCalls.push({ method, repo, body });
  const fail = world.failSetup;
  if (fail && fail.repo === repo && fail.method === method) {
    world.failSetup = null;
    if (fail.status === null) throw new TypeError('fetch failed');
    return json(fail.status, { message: fail.message ?? 'Resource not accessible by integration' });
  }
  const current = world.setups[repo] ?? NOT_CONFIGURED;
  if (method === 'GET') return json(200, { languages: ['actions'], ...current });
  if (current.state !== 'configured') return json(422, { message: 'not configured' });
  world.setups[repo] = {
    state: 'configured',
    runner_type: body?.['runner_type'] === 'labeled' ? 'labeled' : 'standard',
    runner_label: typeof body?.['runner_label'] === 'string' ? body['runner_label'] : '',
  };
  return json(202, { run_id: 1, run_url: 'https://api.github.com/x' });
}

function setupWrites() {
  return world.setupCalls.filter((c) => c.method !== 'GET');
}

function readiness(ready: boolean): FleetReadiness {
  return {
    ready,
    org: ORG,
    checkedAt: new Date().toISOString(),
    conditions: [
      {
        key: 'kill_switch',
        state: 'met',
        reasonCode: 'kill_switch_off',
        message: 'off',
        params: {},
      },
      ready
        ? {
            key: 'runner_group',
            state: 'met',
            reasonCode: 'runner_group_synced',
            message: 'ok',
            params: {},
          }
        : {
            key: 'runner_group',
            state: 'unmet',
            reasonCode: 'no_runner_group',
            message: 'No runner group exists for this project in acme-connected.',
            params: {},
          },
      ...(ready
        ? []
        : [
            {
              key: 'app_repositories' as const,
              state: 'unknown' as const,
              reasonCode: 'read_failed',
              message: 'GitHub could not be reached.',
              params: {},
            },
          ]),
    ],
  } as FleetReadiness;
}

let seq = 0;
async function connectRepo(owner: string, name: string): Promise<void> {
  seq += 1;
  const installationId = `inst-${owner}-${fx.workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: String(820_000 + seq),
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: (['web', 'api', 'mobile', 'shared', 'infra', 'other'] as const)[seq % 6]!,
      name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'connected',
      position: `a${String(seq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
}

async function principal(role: PlatformRole): Promise<PlatformPrincipal> {
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role };
}

function pair() {
  return { projectId: fx.projectId, org: ORG };
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({
    where: { action: { startsWith: 'fleet.org_ci.' } },
    orderBy: { seq: 'asc' },
  });
}

async function storedRow() {
  return adminDb.platformFleetOrgCi.findUnique({
    where: { projectId_org: { projectId: fx.projectId, org: ORG } },
  });
}

function writes(): string[] {
  return world.calls.filter((m) => m !== 'GET');
}

beforeEach(async () => {
  await truncateAuthTables();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', PROVISIONING_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  world = {
    variable: null,
    failWrite: null,
    failRead: null,
    calls: [],
    setups: {},
    failSetup: null,
    setupCalls: [],
  };
  installGitHub();
  fx = await makeWorkItemFixture({ name: 'Motir', identifier: 'MOTIR' });
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { isMeta: true },
  });
  await connectRepo(ORG, 'api');
  await connectRepo(ORG, 'site');
  await connectRepo(PROVISIONING_ORG, 'motir-web');
  superadmin = await principal('superadmin');
  currentPrincipal = superadmin;
  vi.spyOn(fleetReadinessService, 'readinessFor').mockResolvedValue(readiness(true));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('who may read and flip', () => {
  it.each(['support', 'operator'] as const)(
    'a %s is refused on read and write, before any GitHub call',
    async (role) => {
      currentPrincipal = await principal(role);
      await expect(service.getState(currentPrincipal, pair())).rejects.toBeInstanceOf(
        NotPlatformStaffError,
      );
      await expect(
        service.setEnabled(currentPrincipal, pair(), true, 'move CI'),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
      await expect(service.listTargets(currentPrincipal)).rejects.toBeInstanceOf(
        NotPlatformStaffError,
      );
      expect(world.calls).toEqual([]);
      expect(await auditRows()).toHaveLength(0);
    },
  );
});

describe('listTargets', () => {
  it('offers the connected org with a private repository, never the provisioning org', async () => {
    const targets = await service.listTargets(superadmin);
    expect(targets).toEqual([
      {
        projectId: fx.projectId,
        projectKey: 'MOTIR',
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        org: ORG,
        installationId: INSTALLATION,
      },
    ]);
  });

  it('offers nothing for a project outside the meta organisation', async () => {
    await adminDb.organization.update({
      where: { id: fx.workspace.organizationId },
      data: { isMeta: false },
    });
    expect(await service.listTargets(superadmin)).toEqual([]);
  });
});

describe('setEnabled — ON', () => {
  it('a blank reason is refused before any transaction', async () => {
    await expect(service.setEnabled(superadmin, pair(), true, '   ')).rejects.toBeInstanceOf(
      MissingAuditReasonError,
    );
    expect(writes()).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
    expect(await storedRow()).toBeNull();
  });

  it('not ready ⇒ refused naming every condition not met, no variable call, nothing stored', async () => {
    vi.mocked(fleetReadinessService.readinessFor).mockResolvedValue(readiness(false));
    const err = await service
      .setEnabled(superadmin, pair(), true, 'move CI')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetOrgCiNotReadyError);
    expect((err as FleetOrgCiNotReadyError).conditions).toEqual([
      {
        key: 'runner_group',
        state: 'unmet',
        reasonCode: 'no_runner_group',
        message: 'No runner group exists for this project in acme-connected.',
      },
      {
        key: 'app_repositories',
        state: 'unknown',
        reasonCode: 'read_failed',
        message: 'GitHub could not be reached.',
      },
    ]);
    expect(world.calls).toEqual([]);
    expect(await storedRow()).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('ready ⇒ writes MOTIR_RUNNER on the org, stores ON, one enable row with from/to/reason', async () => {
    const result = await service.setEnabled(superadmin, pair(), true, 'move CI onto the fleet');
    expect(result.outcome).toBe('changed');
    expect(result.state).toMatchObject({
      enabled: true,
      lastReason: 'move CI onto the fleet',
      updatedBy: { userId: superadmin.userId, email: superadmin.email },
    });
    expect(world.variable).toEqual({
      value: MOTIR_RUNNER_LABEL,
      visibility: ORG_VARIABLE_VISIBILITY,
    });
    expect(writes()).toEqual(['POST']);
    expect((await storedRow())?.enabled).toBe(true);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'fleet.org_ci.enable',
      targetKind: 'platform',
      targetId: `${fx.projectId}:${ORG}`,
      targetLabel: `MOTIR · ${ORG}`,
      organizationId: fx.workspace.organizationId,
      reason: 'move CI onto the fleet',
      actorUserId: superadmin.userId,
      metadata: {
        projectId: fx.projectId,
        projectKey: 'MOTIR',
        org: ORG,
        from: false,
        to: true,
        variableOutcome: 'created',
      },
    });
  });

  it('never leaks the installation token into an error, a row or a log', async () => {
    world.failWrite = { method: 'POST', status: 403 };
    const err = await service.setEnabled(superadmin, pair(), true, 'x').catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain('ghs_');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('ghs_');
  });
});

describe('setEnabled — OFF', () => {
  beforeEach(async () => {
    await service.setEnabled(superadmin, pair(), true, 'on first');
    world.calls = [];
  });

  it('deletes the variable, never reads readiness (even one that would throw), one disable row', async () => {
    const readinessSpy = vi
      .mocked(fleetReadinessService.readinessFor)
      .mockRejectedValue(new Error('readiness must not be read on OFF'));
    readinessSpy.mockClear();
    const result = await service.setEnabled(superadmin, pair(), false, 'fleet broke');
    expect(result.outcome).toBe('changed');
    expect(readinessSpy).not.toHaveBeenCalled();
    expect(world.variable).toBeNull();
    expect(writes()).toEqual(['DELETE']);
    expect((await storedRow())?.enabled).toBe(false);
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['fleet.org_ci.enable', 'fleet.org_ci.disable']);
    expect(rows[1]!.metadata).toMatchObject({ from: true, to: false, variableOutcome: 'deleted' });
  });

  it("an 'absent' variable still completes the flip", async () => {
    world.variable = null;
    const result = await service.setEnabled(superadmin, pair(), false, 'fleet broke');
    expect(result.outcome).toBe('changed');
    expect((await storedRow())?.enabled).toBe(false);
    expect((await auditRows())[1]!.metadata).toMatchObject({ variableOutcome: 'absent' });
  });
});

describe('a flip to the state already held', () => {
  it('repeat OFF ⇒ unchanged, zero writes, zero rows', async () => {
    const result = await service.setEnabled(superadmin, pair(), false, 'again');
    expect(result).toEqual({
      outcome: 'unchanged',
      state: { enabled: false, updatedBy: null, updatedAt: null, lastReason: null },
    });
    expect(world.calls).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('repeat ON ⇒ unchanged, zero writes, one row only (the first flip)', async () => {
    await service.setEnabled(superadmin, pair(), true, 'on');
    world.calls = [];
    const result = await service.setEnabled(superadmin, pair(), true, 'on again');
    expect(result.outcome).toBe('unchanged');
    expect(result.state.enabled).toBe(true);
    expect(world.calls).toEqual([]);
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('GitHub refuses', () => {
  it.each([
    ['a 403', 403],
    ['a transport failure', null],
  ] as const)(
    '%s on the write ⇒ FleetOrgCiGithubWriteError, row and chain unchanged',
    async (_l, status) => {
      world.failWrite = { method: 'POST', status };
      const chainBefore = await adminDb.platformAuditLog.count();
      const err = await service.setEnabled(superadmin, pair(), true, 'x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FleetOrgCiGithubWriteError);
      expect(err).toMatchObject({ org: ORG, status, operation: 'set' });
      expect(await storedRow()).toBeNull();
      expect(await adminDb.platformAuditLog.count()).toBe(chainBefore);
      expect(world.variable).toBeNull();
    },
  );

  it('a failed read of the variable ⇒ refused before the transaction', async () => {
    world.failRead = 502;
    const err = await service.setEnabled(superadmin, pair(), true, 'x').catch((e: unknown) => e);
    expect(err).toMatchObject({ org: ORG, status: 502, operation: 'read' });
    expect(writes()).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('the commit failing after GitHub wrote ⇒ the variable is restored to what was read', async () => {
    world.variable = { value: 'ubuntu-latest', visibility: 'private' };
    vi.spyOn(platformFleetOrgCiRepository, 'upsert').mockRejectedValueOnce(
      new Error('commit failed'),
    );
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toThrow(
      'commit failed',
    );
    expect(writes()).toEqual(['PATCH', 'PATCH']);
    expect(world.variable).toEqual({ value: 'ubuntu-latest', visibility: 'private' });
    expect(await storedRow()).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('a failed restore logs the disagreement with the pair and re-throws the original', async () => {
    vi.spyOn(platformFleetOrgCiRepository, 'upsert').mockRejectedValueOnce(
      new Error('commit failed'),
    );
    world.failWrite = null;
    const original = installGitHubFailingDelete();
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toThrow(
      'commit failed',
    );
    original();
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      expect.stringContaining('GitHub and the stored state now disagree'),
      expect.objectContaining({
        projectId: fx.projectId,
        org: ORG,
        from: false,
        to: true,
        actorUserId: superadmin.userId,
      }),
    );
  });
});

/** After the POST lands, every DELETE fails — the compensation cannot run. */
function installGitHubFailingDelete(): () => void {
  const real = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'DELETE') return json(500, { message: 'boom' });
      return real(url, init as RequestInit);
    }),
  );
  return () => vi.stubGlobal('fetch', real);
}

describe('pairs the console does not offer', () => {
  it.each([
    ['the provisioning org', PROVISIONING_ORG],
    ['an unknown org', 'someone-else'],
  ])('%s ⇒ FleetOrgCiTargetUnknownError, no GitHub variable call', async (_l, org) => {
    await expect(
      service.setEnabled(superadmin, { projectId: fx.projectId, org }, true, 'x'),
    ).rejects.toBeInstanceOf(FleetOrgCiTargetUnknownError);
    expect(world.calls).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('getState', () => {
  it('answers the stored state, the readiness verdict and the variable read back', async () => {
    await service.setEnabled(superadmin, pair(), true, 'move CI');
    const state = await service.getState(superadmin, pair());
    expect(state).toMatchObject({
      enabled: true,
      lastReason: 'move CI',
      updatedBy: { userId: superadmin.userId },
      readiness: { ready: true },
      variable: { state: 'present', value: MOTIR_RUNNER_LABEL },
    });
  });

  it('shows drift: stored ON while GitHub holds no variable, and an unreadable variable', async () => {
    await service.setEnabled(superadmin, pair(), true, 'move CI');
    world.variable = null;
    expect((await service.getState(superadmin, pair())).variable).toEqual({ state: 'absent' });
    world.failRead = 503;
    expect((await service.getState(superadmin, pair())).variable).toEqual({
      state: 'unknown',
      status: 503,
    });
  });
});

describe('the remaining edges (MOTIR-8716)', () => {
  const lookup = vi.mocked(findProvisioningInstallationId);
  const defaultLookup = async (org: string) => (org.toLowerCase() === ORG ? INSTALLATION : null);
  afterEach(() => {
    lookup.mockImplementation(defaultLookup);
  });

  it('offers several connected orgs sorted by org, skips one without the App and one with only public repositories', async () => {
    await connectRepo('Zeta-Org', 'zeta-api');
    await connectRepo('beta-org', 'beta-api');
    await connectRepo('no-app-org', 'quiet-api');
    await connectRepo('public-org', 'site-docs');
    const ids: Record<string, string> = { [ORG]: '1001', 'beta-org': '1002', 'zeta-org': '1003' };
    lookup.mockImplementation(async (org: string) =>
      org.toLowerCase() === 'no-app-org' ? null : (ids[org.toLowerCase()] ?? '1009'),
    );
    const targets = await service.listTargets(superadmin);
    expect(targets.map((t) => [t.org, t.installationId])).toEqual([
      [ORG, '1001'],
      ['beta-org', '1002'],
      ['Zeta-Org', '1003'],
    ]);
  });

  it('with no provisioning org configured, every connected org is a candidate', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    lookup.mockImplementation(async (org: string) => (org === ORG ? INSTALLATION : '1004'));
    const targets = await service.listTargets(superadmin);
    expect(targets.map((t) => t.org).sort()).toEqual([ORG, PROVISIONING_ORG]);
    await expect(
      service.setEnabled(superadmin, { projectId: fx.projectId, org: '   ' }, true, 'x'),
    ).rejects.toBeInstanceOf(FleetOrgCiTargetUnknownError);
  });

  it('a GitHub failure finding the installation is a read error carrying its status', async () => {
    lookup.mockRejectedValueOnce(new RepoProvisioningApiError(503, 'unavailable'));
    const err = await service.listTargets(superadmin).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetOrgCiGithubWriteError);
    expect(err).toMatchObject({ org: ORG, status: 503, operation: 'read' });
  });

  it('a non-GitHub failure finding the installation is re-thrown as it is', async () => {
    const boom = new RangeError('not GitHub');
    lookup.mockRejectedValueOnce(boom);
    await expect(service.listTargets(superadmin)).rejects.toBe(boom);
  });

  it('a visibility read GitHub refuses is a read error; any other failure is re-thrown', async () => {
    const spy = vi.spyOn(repoVisibilityClient, 'isPrivate');
    spy.mockRejectedValueOnce(new RepoVisibilityApiError(404, 'Not Found'));
    await expect(service.listTargets(superadmin)).rejects.toMatchObject({
      status: 404,
      operation: 'read',
    });
    const boom = new TypeError('not GitHub');
    spy.mockRejectedValueOnce(boom);
    await expect(service.listTargets(superadmin)).rejects.toBe(boom);
  });

  it('a stored row nobody is recorded against names no updater', async () => {
    await adminDb.platformFleetOrgCi.create({
      data: { projectId: fx.projectId, org: ORG, enabled: true, lastReason: 'seeded' },
    });
    const state = await service.getState(superadmin, pair());
    expect(state).toMatchObject({ enabled: true, updatedBy: null, lastReason: 'seeded' });
  });

  it('getState re-throws a failure reading the variable that is not GitHub’s', async () => {
    const boom = new Error('not GitHub');
    vi.spyOn(actionsVariableClient, 'getOrgVariable').mockRejectedValueOnce(boom);
    await expect(service.getState(superadmin, pair())).rejects.toBe(boom);
  });

  it('a reason that is not a string is a missing reason', async () => {
    await expect(
      service.setEnabled(superadmin, pair(), true, undefined as unknown as string),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(world.calls).toEqual([]);
  });

  it('setEnabled re-throws non-GitHub failures of the read and of the write, writing nothing', async () => {
    const readBoom = new Error('read: not GitHub');
    vi.spyOn(actionsVariableClient, 'getOrgVariable').mockRejectedValueOnce(readBoom);
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toBe(readBoom);

    const writeBoom = new Error('write: not GitHub');
    vi.spyOn(actionsVariableClient, 'ensureOrgVariable').mockRejectedValueOnce(writeBoom);
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toBe(writeBoom);
    expect(writes()).toEqual([]);
    expect(await storedRow()).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('concurrency (real database)', () => {
  it('two racing ON flips ⇒ one changed, one unchanged, one audit row', async () => {
    const outcomes = await Promise.all([
      service.setEnabled(superadmin, pair(), true, 'first'),
      service.setEnabled(superadmin, pair(), true, 'second'),
    ]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['changed', 'unchanged']);
    expect(await auditRows()).toHaveLength(1);
    expect((await storedRow())?.enabled).toBe(true);
  });

  it('racing opposite flips ⇒ the stored state is the last committed flip, one row per flip', async () => {
    await service.setEnabled(superadmin, pair(), true, 'on');
    await Promise.all([
      service.setEnabled(superadmin, pair(), false, 'off'),
      service.setEnabled(superadmin, pair(), false, 'off again'),
      service.setEnabled(superadmin, pair(), true, 'on again'),
    ]);
    const rows = await auditRows();
    const last = rows[rows.length - 1]!;
    expect((await storedRow())?.enabled).toBe(last.action === 'fleet.org_ci.enable');
    // Every committed row is a real flip: actions alternate.
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.action).not.toBe(rows[i - 1]!.action);
  });
});

describe('the table', () => {
  it('refuses a second row for one pair, and cascades with its project', async () => {
    await service.setEnabled(superadmin, pair(), true, 'on');
    await expect(
      adminDb.platformFleetOrgCi.create({
        data: { projectId: fx.projectId, org: ORG, enabled: false },
      }),
    ).rejects.toThrow();
    await adminDb.project.delete({ where: { id: fx.projectId } });
    expect(await adminDb.platformFleetOrgCi.count()).toBe(0);
  });
});

describe('CodeQL default setup travels with the flip (MOTIR-10289)', () => {
  beforeEach(async () => {
    // `api` is fixture's own; `site-docs` is PUBLIC (the fake: a `site` prefix).
    await connectRepo(ORG, 'gateway');
    await connectRepo(ORG, 'meta');
    await connectRepo(ORG, 'docs');
    await connectRepo(ORG, 'custom');
    await connectRepo(ORG, 'site-docs');
  });

  it('OFF moves every private repository on the fleet label to standard, and nothing else', async () => {
    await adminDb.platformFleetOrgCi.create({
      data: { projectId: fx.projectId, org: ORG, enabled: true, lastReason: 'seeded' },
    });
    world.variable = { value: MOTIR_RUNNER_LABEL, visibility: ORG_VARIABLE_VISIBILITY };
    world.setups = {
      api: { ...LABELED },
      meta: { ...LABELED },
      gateway: { ...STANDARD },
      docs: { ...NOT_CONFIGURED },
      custom: { state: 'configured', runner_type: 'labeled', runner_label: 'big-box' },
      'site-docs': { ...LABELED },
    };

    const result = await service.setEnabled(superadmin, pair(), false, 'back to hosted');

    expect(result.outcome).toBe('changed');
    expect(setupWrites()).toEqual([
      { method: 'PATCH', repo: 'api', body: { runner_type: 'standard' } },
      { method: 'PATCH', repo: 'meta', body: { runner_type: 'standard' } },
    ]);
    // No private repository is left requesting the fleet.
    for (const name of ['api', 'meta', 'gateway', 'docs', 'custom']) {
      expect(world.setups[name]).not.toMatchObject({ runner_label: MOTIR_RUNNER_LABEL });
    }
    // Already on standard, not configured, another label: exactly as they were.
    expect(world.setups['gateway']).toEqual(STANDARD);
    expect(world.setups['docs']).toEqual(NOT_CONFIGURED);
    expect(world.setups['custom']).toMatchObject({ runner_label: 'big-box' });
    // The public repository is never read, never written.
    expect(world.setupCalls.some((c) => c.repo === 'site-docs')).toBe(false);
    const rows = await auditRows();
    expect(rows.at(-1)!.metadata).toMatchObject({ codeScanningMoved: ['api', 'meta'] });
  });

  it('ON moves configured repositories onto the fleet label; one not configured stays not configured', async () => {
    world.setups = {
      api: { ...STANDARD },
      gateway: { ...LABELED },
      meta: { state: 'configured', runner_type: null, runner_label: null },
      docs: { ...NOT_CONFIGURED },
    };

    await service.setEnabled(superadmin, pair(), true, 'onto the fleet');

    const fleet = { runner_type: 'labeled', runner_label: MOTIR_RUNNER_LABEL };
    expect(setupWrites()).toEqual([
      { method: 'PATCH', repo: 'api', body: fleet },
      { method: 'PATCH', repo: 'meta', body: fleet },
    ]);
    expect(world.setups['docs']).toEqual(NOT_CONFIGURED);
    expect(world.setups['custom']).toBeUndefined();
    const state = await service.getState(superadmin, pair());
    expect(state.codeScanning).toEqual([
      { repo: 'api', state: 'fleet' },
      { repo: 'custom', state: 'not_configured' },
      { repo: 'docs', state: 'not_configured' },
      { repo: 'gateway', state: 'fleet' },
      { repo: 'meta', state: 'fleet' },
    ]);
  });

  const NO_RUNNER_WITH_LABEL =
    'Code scanning default setup can only be enabled if a runner with the specified label is assigned to this repository.';

  it('ON defers a repository GitHub refuses for want of a runner with the label, and turns on', async () => {
    world.setups = { api: { ...STANDARD }, gateway: { ...STANDARD } };
    world.failSetup = {
      repo: 'gateway',
      method: 'PATCH',
      status: 422,
      message: NO_RUNNER_WITH_LABEL,
    };

    const result = await service.setEnabled(superadmin, pair(), true, 'onto the fleet');

    expect(result.outcome).toBe('changed');
    expect((await storedRow())?.enabled).toBe(true);
    expect(world.variable).toMatchObject({ value: MOTIR_RUNNER_LABEL });
    expect(world.setups['api']).toMatchObject({ runner_label: MOTIR_RUNNER_LABEL });
    expect(world.setups['gateway']).toEqual(STANDARD);
    expect((await auditRows()).at(-1)!.metadata).toMatchObject({
      codeScanningMoved: ['api'],
      codeScanningDeferred: ['gateway'],
    });
    const { codeScanning } = await service.getState(superadmin, pair());
    expect(codeScanning.find((c) => c.repo === 'gateway')).toEqual({
      repo: 'gateway',
      state: 'pending_fleet',
    });
  });

  it('a 422 that is not about the runner label still refuses the flip', async () => {
    world.setups = { api: { ...STANDARD } };
    world.failSetup = { repo: 'api', method: 'PATCH', status: 422, message: 'Validation Failed' };
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toMatchObject({
      repo: 'api',
      status: 422,
      operation: 'write',
    });
    expect(await storedRow()).toBeNull();
    expect(world.variable).toBeNull();
  });

  it('OFF never defers: the same refusal moving back to standard refuses the flip', async () => {
    await adminDb.platformFleetOrgCi.create({
      data: { projectId: fx.projectId, org: ORG, enabled: true, lastReason: 'seeded' },
    });
    world.variable = { value: MOTIR_RUNNER_LABEL, visibility: ORG_VARIABLE_VISIBILITY };
    world.setups = { api: { ...LABELED } };
    world.failSetup = { repo: 'api', method: 'PATCH', status: 422, message: NO_RUNNER_WITH_LABEL };
    await expect(service.setEnabled(superadmin, pair(), false, 'x')).rejects.toMatchObject({
      repo: 'api',
      status: 422,
      to: 'github_hosted',
    });
    expect((await storedRow())?.enabled).toBe(true);
  });

  it.each([
    ['a 403', 403],
    ['a transport failure', null],
  ] as const)(
    '%s moving one repository refuses the flip naming it, and puts back what had moved',
    async (_l, status) => {
      world.setups = { api: { ...STANDARD }, gateway: { ...STANDARD } };
      world.failSetup = { repo: 'gateway', method: 'PATCH', status };
      const chainBefore = await adminDb.platformAuditLog.count();

      const err = await service.setEnabled(superadmin, pair(), true, 'x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FleetOrgCiCodeScanningError);
      expect(err).toMatchObject({
        org: ORG,
        repo: 'gateway',
        status,
        operation: 'write',
        to: 'fleet',
      });
      expect((err as Error).message).toContain(`${ORG}/gateway`);
      // The setting's rule for a failed GitHub write: nothing stored, no row,
      // and GitHub put back — the variable AND the repository already moved.
      expect(await storedRow()).toBeNull();
      expect(await adminDb.platformAuditLog.count()).toBe(chainBefore);
      expect(world.variable).toBeNull();
      expect(world.setups['api']).toEqual(STANDARD);
      expect(world.setups['gateway']).toEqual(STANDARD);
    },
  );

  it('a failed read of a default setup refuses the flip before any write', async () => {
    world.setups = { api: { ...STANDARD } };
    world.failSetup = { repo: 'api', method: 'GET', status: 502 };
    const err = await service.setEnabled(superadmin, pair(), true, 'x').catch((e: unknown) => e);
    expect(err).toMatchObject({ repo: 'api', status: 502, operation: 'read', to: 'fleet' });
    expect(writes()).toEqual([]);
    expect(setupWrites()).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it("a missing App permission on the read is an error, never read as 'no default setup'", async () => {
    world.failSetup = { repo: 'api', method: 'GET', status: 403 };
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toMatchObject({
      repo: 'api',
      status: 403,
      operation: 'read',
    });
  });

  it('a repository without code scanning is skipped by the flip and shown as unavailable', async () => {
    world.setups = { meta: { ...STANDARD } };
    world.failSetup = {
      repo: 'api',
      method: 'GET',
      status: 403,
      message: 'Advanced Security must be enabled for this repository to use code scanning.',
    };
    await service.setEnabled(superadmin, pair(), true, 'x');
    expect(setupWrites()).toEqual([
      {
        method: 'PATCH',
        repo: 'meta',
        body: { runner_type: 'labeled', runner_label: MOTIR_RUNNER_LABEL },
      },
    ]);
    world.failSetup = {
      repo: 'api',
      method: 'GET',
      status: 403,
      message: 'Code Security is not enabled',
    };
    expect((await service.getState(superadmin, pair())).codeScanning[0]).toEqual({
      repo: 'api',
      state: 'unavailable',
    });
  });

  it('getState shows a default setup it could not read as unknown, with the status', async () => {
    world.setups = { api: { ...LABELED }, docs: { ...STANDARD } };
    world.failSetup = { repo: 'custom', method: 'GET', status: null };
    const { codeScanning } = await service.getState(superadmin, pair());
    expect(codeScanning).toEqual([
      { repo: 'api', state: 'fleet' },
      { repo: 'custom', state: 'unknown', status: null },
      { repo: 'docs', state: 'github_hosted' },
      { repo: 'gateway', state: 'not_configured' },
      { repo: 'meta', state: 'not_configured' },
    ]);
  });

  it('getState re-throws a default-setup failure that is not GitHub’s', async () => {
    const boom = new RangeError('not GitHub');
    vi.spyOn(codeScanningDefaultSetupClient, 'get').mockRejectedValueOnce(boom);
    await expect(service.getState(superadmin, pair())).rejects.toBe(boom);
  });

  it('setEnabled re-throws non-GitHub failures of a default-setup read and write', async () => {
    world.setups = { api: { ...STANDARD } };
    const readBoom = new RangeError('read: not GitHub');
    vi.spyOn(codeScanningDefaultSetupClient, 'get').mockRejectedValueOnce(readBoom);
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toBe(readBoom);
    const writeBoom = new RangeError('write: not GitHub');
    vi.spyOn(codeScanningDefaultSetupClient, 'setRunner').mockRejectedValueOnce(writeBoom);
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toBe(writeBoom);
    expect(await storedRow()).toBeNull();
    expect(world.variable).toBeNull();
  });

  it('a default setup that cannot be put back is logged with the pair and the repository', async () => {
    world.setups = { api: { ...STANDARD } };
    vi.spyOn(platformFleetOrgCiRepository, 'upsert').mockRejectedValueOnce(
      new Error('commit failed'),
    );
    const real = codeScanningDefaultSetupClient.setRunner.bind(codeScanningDefaultSetupClient);
    vi.spyOn(codeScanningDefaultSetupClient, 'setRunner')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('restore failed'));
    await expect(service.setEnabled(superadmin, pair(), true, 'x')).rejects.toThrow(
      'commit failed',
    );
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      expect.stringContaining('CodeQL default setups could not be put back'),
      expect.objectContaining({ projectId: fx.projectId, org: ORG, repositories: ['api'] }),
    );
  });

  it('a visibility read GitHub refuses while listing the pair’s repositories is a read error', async () => {
    const spy = vi.spyOn(repoVisibilityClient, 'isPrivate');
    // listTargets' own read (via resolveTarget) passes; the pair's repository read fails.
    spy.mockResolvedValueOnce(true).mockRejectedValueOnce(new RepoVisibilityApiError(503, 'x'));
    await expect(service.getState(superadmin, pair())).rejects.toMatchObject({
      org: ORG,
      status: 503,
      operation: 'read',
    });
    spy.mockReset();
    spy.mockResolvedValueOnce(true).mockRejectedValueOnce(new TypeError('not GitHub'));
    await expect(service.getState(superadmin, pair())).rejects.toBeInstanceOf(TypeError);
  });
});

/** Every GitHub WRITE (the variable's and each default setup's) answers after
 *  `ms`; reads and the installation token stay instant, as they run before the
 *  flip's transaction opens. */
function slowGithubWrites(ms: number): void {
  const real = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET' && !String(url).includes('/access_tokens')) {
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return real(url, init as RequestInit);
    }),
  );
}

describe('a flip whose GitHub writes are slow (MOTIR-10972)', () => {
  beforeEach(async () => {
    // With the fixture's `api`, three private repositories to move; `site` is public.
    await connectRepo(ORG, 'gateway');
    await connectRepo(ORG, 'meta');
  });

  // Four writes of 2 s each (the variable's create, three default-setup PATCHes)
  // inside the transaction: 8 s, past Prisma's 5 s interactive default. Before
  // the fix this flip died with an expired transaction that the action answered
  // as a bare FAILED, with everything compensated and nothing stored.
  it('ON moving three default setups at 2 s per GitHub call completes, stores ON and writes one row', async () => {
    world.setups = { api: { ...STANDARD }, gateway: { ...STANDARD }, meta: { ...STANDARD } };
    slowGithubWrites(2_000);

    const result = await service.setEnabled(superadmin, pair(), true, 'onto the fleet');

    expect(result.outcome).toBe('changed');
    expect((await storedRow())?.enabled).toBe(true);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      variableOutcome: 'created',
      codeScanningMoved: ['api', 'gateway', 'meta'],
    });
    expect(world.variable).toEqual({
      value: MOTIR_RUNNER_LABEL,
      visibility: ORG_VARIABLE_VISIBILITY,
    });
    for (const name of ['api', 'gateway', 'meta']) {
      expect(world.setups[name]).toMatchObject({
        runner_type: 'labeled',
        runner_label: MOTIR_RUNNER_LABEL,
      });
    }
  }, 30_000);

  it('OFF moving three default setups back at 2 s per GitHub call completes the same way', async () => {
    await adminDb.platformFleetOrgCi.create({
      data: { projectId: fx.projectId, org: ORG, enabled: true, lastReason: 'seeded' },
    });
    world.variable = { value: MOTIR_RUNNER_LABEL, visibility: ORG_VARIABLE_VISIBILITY };
    world.setups = { api: { ...LABELED }, gateway: { ...LABELED }, meta: { ...LABELED } };
    slowGithubWrites(2_000);

    const result = await service.setEnabled(superadmin, pair(), false, 'back to hosted');

    expect(result.outcome).toBe('changed');
    expect((await storedRow())?.enabled).toBe(false);
    expect(await auditRows()).toHaveLength(1);
    expect(world.variable).toBeNull();
    for (const name of ['api', 'gateway', 'meta']) expect(world.setups[name]).toEqual(STANDARD);
  }, 30_000);
});

describe('flipTransactionTimeoutMs', () => {
  it('covers the variable write and one request per move, on top of the fixed work', () => {
    expect(flipTransactionTimeoutMs(0)).toBe(
      FLIP_TRANSACTION_BASE_MS + 3 * FLIP_GITHUB_REQUEST_BUDGET_MS,
    );
    expect(flipTransactionTimeoutMs(3) - flipTransactionTimeoutMs(0)).toBe(
      3 * FLIP_GITHUB_REQUEST_BUDGET_MS,
    );
    // Never below Prisma's own default, and never shrunk by a nonsense count.
    expect(flipTransactionTimeoutMs(0)).toBeGreaterThan(5_000);
    expect(flipTransactionTimeoutMs(-2)).toBe(flipTransactionTimeoutMs(0));
  });
});

describe('plannedDefaultSetupMoves', () => {
  it('moves only configured repositories that are not where the flip wants them', () => {
    const repo = (name: string) => ({ owner: ORG, name });
    const reads = [
      {
        repo: repo('a'),
        setup: { state: 'configured' as const, runner: { type: 'standard' as const } },
      },
      {
        repo: repo('b'),
        setup: {
          state: 'configured' as const,
          runner: { type: 'labeled' as const, label: MOTIR_RUNNER_LABEL },
        },
      },
      { repo: repo('c'), setup: { state: 'not-configured' as const } },
      { repo: repo('d'), setup: { state: 'unavailable' as const } },
    ];
    expect(plannedDefaultSetupMoves(reads, true).map((m) => m.repo.name)).toEqual(['a']);
    expect(plannedDefaultSetupMoves(reads, false).map((m) => [m.repo.name, m.to])).toEqual([
      ['b', { type: 'standard' }],
    ]);
  });
});
