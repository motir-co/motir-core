import {
  AWS_MEMBER_ROLE_NAME,
  createFakeTenantClients,
  createTenantHandover,
  type ReleaseHandle,
} from '@motir/orchestrator';
import { encryptToken } from '@/lib/github/tokenCrypto';
import type {
  HandoverRepository,
  TenantHandoverAwsReach,
  TenantHandoverDeps,
} from '@/lib/services/tenantAccountHandoverService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from './adminDb';
import { FakeOrganization } from './addShardFakes';

// THE TAKEOVER HANDOVER'S WORLD (Story MOTIR-9800 · MOTIR-12131), shared by the
// handover's service, route and guard suites: an organisation with a `ready`
// tenant AWS account holding two AWS-target Motir repositories, each with a
// production application, its release and its stacks in the account; and every
// boundary the handover reaches, faked and logged into ONE ordered call log.
//
// The tenant account is the orchestrator's own fake (`createFakeTenantClients`)
// driven through the REAL `createTenantHandover`, so "the production stacks are
// still there" and "Motir's access role is untouched" are read off the account.

export const ACCOUNT = '210987654321';
export const MANAGEMENT = '111122223333';
export const OWNER_EMAIL = 'cloud-owner@acme.example';
export const GITHUB_OWNER = 'acme-co';
export const GITHUB_OWNER_ID = '880001';
const INSTALLATION_ID = '556677';

export interface HandoverWorld {
  fx: WorkItemFixture;
  organizationId: string;
  tenantAccountId: string;
  repos: { id: string; name: string; githubRepoId: string }[];
  apps: { id: string; repoId: string; workspaceId: string }[];
}

let seq = 0;

/** An AWS-target Motir repository (`state: created`) with its realized GitHub
 *  repository, and its production application on a live release. */
export async function seedAwsRepository(
  fx: WorkItemFixture,
  name: string,
  opts: { application?: boolean; domain?: string } = {},
) {
  seq += 1;
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: INSTALLATION_ID },
    create: {
      installationId: INSTALLATION_ID,
      workspaceId: null,
      accountLogin: 'motir-projects',
      accountType: 'Organization',
    },
    update: {},
  });
  const githubRepoId = String(700_000 + seq);
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: githubRepoId,
      owner: 'motir-projects',
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const repo = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name,
      position: `h${seq}`,
      seedSource: 'initialised',
      state: 'created',
      hostingTarget: 'aws',
      githubRepoId: mirror.id,
    },
  });
  let app: { id: string } | null = null;
  if (opts.application !== false) {
    app = await adminDb.hostedApplication.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectRepositoryId: repo.id,
        target: 'aws',
        slug: name,
        productionAddress: `${name}-${seq}--acme.motir.example`,
      },
    });
    const release = await adminDb.hostedRelease.create({
      data: {
        workspaceId: fx.workspaceId,
        applicationId: app.id,
        commitSha: 'a'.repeat(40),
        cause: 'merge',
        state: 'live',
        providerReleaseId: `mh-${repo.id}@1`,
        providerRef: `function:motir-release-mh-${repo.id}`,
      },
    });
    await adminDb.hostedApplication.update({
      where: { id: app.id },
      data: { currentReleaseId: release.id },
    });
    if (opts.domain) {
      await adminDb.publicAddress.create({
        data: {
          workspaceId: fx.workspaceId,
          applicationId: app.id,
          hostname: opts.domain,
          kind: 'custom_domain',
          status: 'issued',
          verificationToken: `motir-verify-${opts.domain}`,
          issuedAt: new Date('2026-11-01T00:00:00Z'),
        },
      });
    }
  }
  return { repo, app, githubRepoId };
}

/** Give a user a connected GitHub identity — what a takeover runs as. */
export async function connectGithub(userId: string, login = 'acme-admin'): Promise<void> {
  await adminDb.githubIdentity.create({
    data: {
      userId,
      githubUserId: `gh-${userId}`,
      githubLogin: login,
      accessTokenEncrypted: encryptToken('gho_user'),
    },
  });
}

/** The organisation, its ready tenant account and two AWS repositories. */
export async function seedHandoverWorld(
  opts: { identity?: boolean; domain?: string } = {},
): Promise<HandoverWorld> {
  const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
  const organizationId = fx.workspace.organizationId;
  if (opts.identity !== false) await connectGithub(fx.ownerId);
  const account = await adminDb.hostingTenantAccount.create({
    data: { organizationId, awsAccountId: ACCOUNT, state: 'ready', region: 'us-east-1' },
  });
  const shop = await seedAwsRepository(fx, 'shop', { domain: opts.domain ?? 'shop.acme.example' });
  const api = await seedAwsRepository(fx, 'api');
  return {
    fx,
    organizationId,
    tenantAccountId: account.id,
    repos: [shop, api].map((r) => ({
      id: r.repo.id,
      name: r.repo.name,
      githubRepoId: r.githubRepoId,
    })),
    apps: [shop, api].map((r) => ({
      id: r.app!.id,
      repoId: r.repo.id,
      workspaceId: fx.workspaceId,
    })),
  };
}

/** A thrown AWS-shaped failure with a typed code. */
export class FakeHandoverFailure extends Error {
  constructor(readonly code: string) {
    super(`the fake refused (${code})`);
    this.name = 'FakeHandoverFailure';
  }
}

/** The mutating calls, by the step that makes them. */
export type HandoverFault =
  | 'destroyPreviewStacks'
  | 'createHandoverDeployRole'
  | 'openUpstream'
  | 'startPrimaryEmailUpdate'
  | 'readStandaloneReadiness'
  | 'removeMotirAccess'
  | 'removeAccountFromOrganization'
  | 'requestTakeover';

/** Every boundary the handover reaches, faked, logging into one ordered list. */
export function createHandoverFakes(world: HandoverWorld) {
  const log: string[] = [];
  const clients = createFakeTenantClients({ accountId: ACCOUNT, region: 'us-east-1' });
  clients.cloudformation.pollsToSettle = 0;
  const realHandover = createTenantHandover({
    clientsFor: () => clients,
    memberIamFor: () => clients.iamAccount.session(AWS_MEMBER_ROLE_NAME),
    region: 'us-east-1',
    managementAccountId: MANAGEMENT,
    options: { sleep: async () => undefined, pollMs: 1, timeoutMs: 60_000 },
  });
  const organization = new FakeOrganization({
    accessKeyId: 'AKIA_FAKE',
    secretAccessKey: 'fake',
    sessionToken: 'fake',
    expiration: new Date('2030-01-01T00:00:00Z'),
  });
  const faults = new Set<HandoverFault>();
  const fail = (name: HandoverFault) => {
    if (faults.delete(name)) throw new FakeHandoverFailure(`FAKE_${name.toUpperCase()}`);
  };
  const enqueued: string[] = [];
  const takeovers: { rowId: string; newOwner: string; ctx: ServiceContext }[] = [];

  const aws: TenantHandoverAwsReach = {
    handover: {
      async destroyPreviewStacks(accountId) {
        log.push('destroy_previews');
        fail('destroyPreviewStacks');
        return realHandover.destroyPreviewStacks(accountId);
      },
      async createHandoverDeployRole(accountId, input) {
        log.push('create_deploy_role');
        fail('createHandoverDeployRole');
        return realHandover.createHandoverDeployRole(accountId, input);
      },
      async removeMotirAccess(accountId) {
        log.push('remove_motir_access');
        fail('removeMotirAccess');
        return realHandover.removeMotirAccess(accountId);
      },
    },
    management: {
      async startPrimaryEmailUpdate(accountId, email) {
        log.push('start_email_update');
        fail('startPrimaryEmailUpdate');
        return organization.startPrimaryEmailUpdate(accountId, email);
      },
      acceptPrimaryEmailUpdate: (a, e, c) => organization.acceptPrimaryEmailUpdate(a, e, c),
      getPrimaryEmail: (a) => organization.getPrimaryEmail(a),
      getPrimaryEmailUpdateStatus: (a) => organization.getPrimaryEmailUpdateStatus(a),
      async readStandaloneReadiness(accountId) {
        log.push('read_standalone');
        fail('readStandaloneReadiness');
        return organization.readStandaloneReadiness(accountId);
      },
      async removeAccountFromOrganization(accountId) {
        log.push('leave_organization');
        fail('removeAccountFromOrganization');
        return organization.removeAccountFromOrganization(accountId);
      },
    },
    async openUpstream(handle: ReleaseHandle) {
      log.push(`open_upstream:${handle.appRef}`);
      fail('openUpstream');
      return { upstreamAddress: `https://${handle.appRef}.open.example` };
    },
  };

  const deps: TenantHandoverDeps = {
    aws: async () => aws,
    githubAccountIdOf: async (login) => {
      log.push(`github_account:${login}`);
      return GITHUB_OWNER_ID;
    },
    removeProductionConfig: async (repo: HandoverRepository) => {
      log.push(`production_config:${repo.id}`);
    },
    requestTakeover: async (rowId, newOwner, ctx) => {
      log.push(`transfer:${rowId}`);
      fail('requestTakeover');
      takeovers.push({ rowId, newOwner, ctx });
      return {};
    },
    enqueueAdvance: async (id) => {
      enqueued.push(id);
    },
  };

  // The account's production stacks — what no handover step may delete — and
  // one preview the first step destroys.
  async function seedStacks() {
    for (const repo of world.repos) {
      await clients.cloudformation.createStack({
        name: `motir-release-mh-${repo.id}`,
        templateBody: 'Resources: {}',
        parameters: {},
        tags: {},
      });
    }
    await clients.cloudformation.createStack({
      name: `motir-release-mh-${world.repos[0]!.id}-pr3`,
      templateBody: 'Resources: {}',
      // A function release's parameter, so the teardown reads its shape.
      parameters: { InvokePrincipalArn: `arn:aws:iam::${ACCOUNT}:role/motir-forwarder` },
      tags: {},
    });
    // Settle every seeded stack to CREATE_COMPLETE, as a deployed one is.
    for (const stack of await clients.cloudformation.listStacks()) {
      await clients.cloudformation.describeStack(stack.name);
    }
  }

  return { aws, deps, log, clients, organization, faults, enqueued, takeovers, seedStacks };
}
export type HandoverFakes = ReturnType<typeof createHandoverFakes>;
