import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  motirOwnedOrgLogins,
  ownedOrgTargetFor,
  resetOwnedOrgCache,
} from '@/lib/ciMetering/ownedOrgs';
import { isMotirOwnedRepo } from '@/lib/ciMetering/config';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { githubAppRoleForRepo } from '@/lib/github/appRoleForRepo';
import { GithubAppTokenError } from '@/lib/github/appAuth';
import { OrgTargetAuthError } from '@/lib/github/orgTarget';
import { repoCollaboratorClient } from '@/lib/github/repoCollaborators';
import { fleetShardService, type CreateFleetShardInput } from '@/lib/services/fleetShardService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE OWNED-ORG SET FROM THE FLEET ACCOUNT ROWS (Story MOTIR-8953 · MOTIR-8974),
// against real Postgres. A tenant's hosted repositories may live in a fleet
// account's GitHub org, so every "is this repository Motir's?" reader answers
// from the provisioning org PLUS every account's org — and every reader that acts
// with the provisioning credential acts in the repository's OWN org.

const mintInstallationToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken,
}));

const FALLBACK = 'motir-projects';
const SHARD_ORG = 'Motir-Shard-1';
const SHARD_INSTALLATION = '77001';

function account(overrides: Partial<CreateFleetShardInput> = {}): CreateFleetShardInput {
  return {
    name: 'ci-runner-shard-1',
    fleetKind: 'ci_runner',
    provider: 'fly',
    state: 'active',
    githubOrg: SHARD_ORG,
    githubInstallationId: SHARD_INSTALLATION,
    flyOrg: 'motir',
    flyApp: 'motir-ci-shard-1',
    flyRegion: 'iad',
    credentialRef: 'FLEET_SHARD_TEST_TOKEN',
    limits: { machineLimit: 50 },
    ...overrides,
  };
}

beforeEach(async () => {
  await adminDb.fleetShard.deleteMany({});
  resetOwnedOrgCache();
  mintInstallationToken.mockReset();
  vi.stubEnv('GITHUB_FALLBACK_ORG', FALLBACK);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await adminDb.fleetShard.deleteMany({});
  resetOwnedOrgCache();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('motirOwnedOrgLogins', () => {
  it('with no account rows is exactly the provisioning org, as before', async () => {
    expect(await motirOwnedOrgLogins()).toEqual([FALLBACK]);
  });

  it('is empty with neither the variable nor a row — a self-hosted build owns nothing', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    expect(await motirOwnedOrgLogins()).toEqual([]);
  });

  it('adds every non-disabled account org, lowercased and de-duplicated', async () => {
    await fleetShardService.createShard(account());
    await fleetShardService.createShard(
      account({
        name: 'ci-runner-shard-1b',
        flyApp: 'motir-ci-shard-1b',
        githubOrg: 'motir-shard-1',
      }),
    );
    await fleetShardService.createShard(
      account({ name: 'ci-runner-fallback', flyApp: 'motir-ci-fb', githubOrg: 'MOTIR-PROJECTS' }),
    );
    const disabled = await fleetShardService.createShard(
      account({
        name: 'ci-runner-shard-2',
        flyApp: 'motir-ci-shard-2',
        githubOrg: 'motir-shard-2',
      }),
    );
    await fleetShardService.setState(disabled.id, 'disabled');

    expect((await motirOwnedOrgLogins()).sort()).toEqual([FALLBACK, 'motir-shard-1']);
  });

  it('includes a spare account’s org — the spare runs Motir’s own jobs there (MOTIR-9456)', async () => {
    await fleetShardService.createShard(
      account({
        name: 'ci-runner-spare',
        flyApp: 'motir-ci-spare',
        githubOrg: 'motir-spare-1',
        role: 'spare',
      }),
    );

    expect((await motirOwnedOrgLogins()).sort()).toEqual([FALLBACK, 'motir-spare-1']);
  });

  it("reads in SYSTEM context — a tenant's context, which cannot see the rows, still gets every org", async () => {
    await fleetShardService.createShard(account());
    const user = await usersService.createUser({
      email: 'owned-orgs@example.com',
      password: 'hunter2hunter2',
      name: 'Tenant',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Owned orgs WS',
      ownerUserId: user.id,
    });

    // The tenant's own reach: as the non-bypass role, with its workspace bound,
    // `fleet_shard` shows nothing.
    const seenByTenant = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.fleetShard.findMany();
    });
    expect(seenByTenant).toEqual([]);

    const fromInsideTenant = await withWorkspaceContext(
      { userId: user.id, workspaceId: workspace.id },
      () => motirOwnedOrgLogins(),
    );
    expect(fromInsideTenant.sort()).toEqual([FALLBACK, 'motir-shard-1']);
  });
});

describe('the hosted-repo discriminator answers from the set', () => {
  beforeEach(async () => {
    await fleetShardService.createShard(account());
  });

  it('isMotirHostedOwner and isMotirOwnedRepo: shard org and provisioning org yes, a tenant org no', async () => {
    const owners = await motirOwnedOrgLogins();
    expect(isMotirHostedOwner('motir-shard-1', owners)).toBe(true);
    expect(isMotirHostedOwner('MOTIR-PROJECTS', owners)).toBe(true);
    expect(isMotirHostedOwner('acme-inc', owners)).toBe(false);
    expect(await isMotirOwnedRepo('Motir-Shard-1')).toBe(true);
    expect(await isMotirOwnedRepo(FALLBACK)).toBe(true);
    expect(await isMotirOwnedRepo('acme-inc')).toBe(false);
  });

  it("the App-role resolver mints a shard-org repo's credential through the provisioning App", async () => {
    const owners = await motirOwnedOrgLogins();
    expect(githubAppRoleForRepo({ owner: 'motir-shard-1' }, owners)).toBe('provisioning');
    expect(githubAppRoleForRepo({ owner: 'acme-inc' }, owners)).toBe('user-facing');
  });

  it("ownedOrgTargetFor names the account's installation; the provisioning org and a tenant org get none", async () => {
    expect(await ownedOrgTargetFor('motir-shard-1')).toEqual({
      org: SHARD_ORG,
      installationId: SHARD_INSTALLATION,
      role: 'provisioning',
    });
    expect(await ownedOrgTargetFor(FALLBACK)).toBeUndefined();
    expect(await ownedOrgTargetFor('acme-inc')).toBeUndefined();
  });
});

describe('a collaborator invite acts in the repository’s own org', () => {
  beforeEach(async () => {
    await fleetShardService.createShard(account());
  });

  it("invites to a shard-org repo through THAT account's installation, never the provisioning org's", async () => {
    mintInstallationToken.mockResolvedValue({ token: 'ghs_shard', expiresAt: new Date() });
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ html_url: 'https://github.com/invite/1' }), {
          status: 201,
        });
      }),
    );

    const result = await repoCollaboratorClient.invite({
      owner: 'motir-shard-1',
      repo: 'acme-web',
      login: 'octocat',
      permission: 'admin',
    });

    expect(result).toEqual({
      alreadyHasAccess: false,
      invitationUrl: 'https://github.com/invite/1',
    });
    expect(mintInstallationToken).toHaveBeenCalledWith(SHARD_INSTALLATION, 'provisioning');
    expect(urls).toEqual([
      'https://api.github.com/repos/motir-shard-1/acme-web/collaborators/octocat',
    ]);
  });

  it('a failed mint is OrgTargetAuthError — no fallback to the provisioning org', async () => {
    mintInstallationToken.mockRejectedValue(new GithubAppTokenError('not installed', 404));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      repoCollaboratorClient.hasAccepted({ owner: 'motir-shard-1', repo: 'acme-web', login: 'o' }),
    ).rejects.toBeInstanceOf(OrgTargetAuthError);
    expect(mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
