import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { SharedTenantAccountError } from '@/lib/hosting/tenantHandoverErrors';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';
import { projectRepoTakeoverService } from '@/lib/services/projectRepoTakeoverService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  connectGithub,
  createHandoverFakes,
  seedAwsRepository,
  seedHandoverWorld,
  type HandoverFakes,
  type HandoverWorld,
} from '../helpers/tenantHandoverFixtures';

// ONE AWS REPOSITORY CANNOT LEAVE ALONE (Story MOTIR-9800 · MOTIR-12131). Every
// AWS-target repository of an organisation deploys into its ONE tenant account,
// and the account leaves with all of them. A single takeover is refused before
// it writes anything or reaches GitHub or AWS, naming the others — except while
// the organisation's handover is itself transferring them (`removing`).

let world: HandoverWorld;
let fakes: HandoverFakes;
let fetchCalls: string[];

beforeEach(async () => {
  await truncateAuthTables();
  world = await seedHandoverWorld();
  fakes = createHandoverFakes(world);
  await fakes.seedStacks();
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCalls.push(String(url));
      return new Response('{}', { status: 500 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = () => ({ userId: world.fx.ownerId, workspaceId: world.fx.workspaceId });
const take = (rowId: string) => projectRepoTakeoverService.requestTakeover(rowId, 'acme-co', ctx());

async function snapshot() {
  return {
    repos: await adminDb.projectRepo.findMany({
      where: { id: { in: world.repos.map((r) => r.id) } },
      select: { id: true, takeoverState: true, takeoverTargetOwner: true },
      orderBy: { id: 'asc' },
    }),
    account: await adminDb.hostingTenantAccount.findUniqueOrThrow({
      where: { id: world.tenantAccountId },
    }),
    stacks: [...fakes.clients.cloudformation.stacks.keys()].sort(),
    roles: [...fakes.clients.iamAccount.roles.keys()].sort(),
  };
}

describe('a single takeover of an AWS repository', () => {
  it('is refused naming the other repositories, changing nothing anywhere', async () => {
    const before = await snapshot();
    const [shop] = world.repos;
    const error = await take(shop!.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SharedTenantAccountError);
    expect((error as SharedTenantAccountError).repositories).toEqual(['api']);
    expect((error as SharedTenantAccountError).code).toBe('TAKEOVER_SHARED_AWS_ACCOUNT');
    expect(await snapshot()).toEqual(before);
    expect(fetchCalls).toEqual([]);
    expect(fakes.log).toEqual([]);
  });

  it('is refused for the organisation’s ONLY AWS repository too, naming none, when a project admin who is not an organisation admin asks', async () => {
    // The review of MOTIR-9800: the room routes a lone AWS row to the handover
    // only for an organisation admin, so a project admin fell through to the
    // plain takeover — and the server, counting only OTHER repositories, let it
    // move the repository while its app kept running in Motir's account.
    const [shop, api] = world.repos;
    await adminDb.projectRepo.update({
      where: { id: api!.id },
      data: { takeoverState: 'done', takeoverTargetOwner: 'acme-co' },
    });
    const admin = await createTestUser({ name: 'Project admin' });
    await workspacesService.addMember({
      userId: admin.id,
      workspaceId: world.fx.workspaceId,
      workspaceRole: 'manager',
    });
    await adminDb.organizationMembership.upsert({
      where: {
        organizationId_userId: { organizationId: world.organizationId, userId: admin.id },
      },
      create: { organizationId: world.organizationId, userId: admin.id, role: 'member' },
      update: { role: 'member' },
    });
    await connectGithub(admin.id, 'project-admin');
    const before = await snapshot();

    const error = await projectRepoTakeoverService
      .requestTakeover(shop!.id, 'acme-co', { userId: admin.id, workspaceId: world.fx.workspaceId })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SharedTenantAccountError);
    expect((error as SharedTenantAccountError).code).toBe('TAKEOVER_SHARED_AWS_ACCOUNT');
    expect((error as SharedTenantAccountError).repositories).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(fetchCalls).toEqual([]);
    expect(fakes.log).toEqual([]);
  });

  it('lets a lone AWS repository through when its organisation never had an account created', async () => {
    await adminDb.hostingTenantAccount.update({
      where: { id: world.tenantAccountId },
      data: { awsAccountId: null, state: 'requested' },
    });
    const error = await take(world.repos[0]!.id).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SharedTenantAccountError);
  });

  it('names every other repository, in creation order', async () => {
    await seedAwsRepository(world.fx, 'admin', { application: false });
    const error = await take(world.repos[1]!.id).catch((e: unknown) => e);
    expect((error as SharedTenantAccountError).repositories).toEqual(['shop', 'admin']);
  });

  it('does not name a repository already past its transfer', async () => {
    await adminDb.projectRepo.update({
      where: { id: world.repos[1]!.id },
      data: { takeoverState: 'done', takeoverTargetOwner: 'acme-co' },
    });
    const error = await take(world.repos[0]!.id).catch((e: unknown) => e);
    // Still refused: the account Motir holds goes through the handover even
    // with one repository left in it (the review of MOTIR-9800).
    expect(error).toBeInstanceOf(SharedTenantAccountError);
    expect((error as SharedTenantAccountError).repositories).toEqual([]);
  });

  it('is let through while the organisation’s handover is transferring them', async () => {
    await adminDb.hostingTenantAccount.update({
      where: { id: world.tenantAccountId },
      data: { state: 'removing' },
    });
    const error = await take(world.repos[0]!.id).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SharedTenantAccountError);
  });

  it('does not apply to a repository Motir does not host on AWS', async () => {
    await adminDb.projectRepo.update({
      where: { id: world.repos[0]!.id },
      data: { hostingTarget: 'fly' },
    });
    const error = await take(world.repos[0]!.id).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SharedTenantAccountError);
  });

  it('answers 409 with an empty list for a lone repository', async () => {
    const response = mapProjectRepoError(new SharedTenantAccountError('r1', []));
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({
      code: 'TAKEOVER_SHARED_AWS_ACCOUNT',
      repositories: [],
    });
  });

  it('answers 409 with the other repositories’ names', async () => {
    const response = mapProjectRepoError(new SharedTenantAccountError('r1', ['api', 'admin']));
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({
      code: 'TAKEOVER_SHARED_AWS_ACCOUNT',
      repositories: ['api', 'admin'],
    });
  });
});
