import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { organizationRepoService } from '@/lib/services/organizationRepoService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE PROJECT ROOM'S INSTALL RETURN (Bug MOTIR-9828) — `Connect a new one` in a
// project's Repositories room promises the organisation connection AND the
// project link in one act. The setup handler now calls
// `linkInstallReturnIntoProject` when the signed state names a project; this
// suite pins which repositories that call links:
//
//   · ONLY the ones the round trip connected — a row of THIS installation whose
//     organisation connection is at or after the moment the link was minted;
//   · never one the organisation held before (that is the picker's other
//     segment), never one of another installation, never one already held;
//   · each with the picker's `other` role, through the org-admin gate.
//
// Real Postgres. The organisation half (`linkExistingInstallation`) is stubbed:
// it is a call to api.github.com, and its own suites pin it. What it guarantees
// this call — the selected repositories exist as rows when it returns — is
// stood in for by seeding them.

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;
let otherInstallationRowId: string;
let linkSpy: ReturnType<typeof vi.spyOn>;

const SINCE = new Date('2026-10-27T11:30:00.000Z');
const BEFORE = new Date(SINCE.getTime() - 60_000);
const AFTER = new Date(SINCE.getTime() + 60_000);

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;
  installationRowId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: orgId,
        accountLogin: 'motir-co',
        accountType: 'Organization',
        provider: 'github',
      },
    })
  ).id;
  otherInstallationRowId = (
    await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-other-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        organizationId: orgId,
        accountLogin: 'someone-else',
        accountType: 'User',
        provider: 'github',
      },
    })
  ).id;
  linkSpy = vi.spyOn(githubInstallationService, 'linkExistingInstallation').mockResolvedValue({
    installation: {
      id: installationRowId,
      provider: 'github',
      installationId: `inst-${fx.workspaceId}`,
      accountLogin: 'motir-co',
      accountType: 'Organization',
      repos: [],
      createdAt: BEFORE.toISOString(),
    },
    claimed: [],
    released: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function seedRepo(name: string, createdAt: Date, installationId = installationRowId) {
  return adminDb.githubRepo.create({
    data: {
      installationId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId: `id-${name}`,
      owner: 'motir-co',
      name,
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
      createdAt,
    },
  });
}

function call(ctx: ServiceContext = fx.ctx) {
  return organizationRepoService.linkInstallReturnIntoProject({
    projectKey: fx.project.identifier,
    organizationId: orgId,
    installationId: `inst-${fx.workspaceId}`,
    since: SINCE,
    ctx,
  });
}

async function heldNames(): Promise<string[]> {
  const rows = await adminDb.projectRepo.findMany({
    where: { projectId: fx.projectId },
    orderBy: { name: 'asc' },
  });
  return rows.map((row) => row.name);
}

describe('linkInstallReturnIntoProject — the repositories the round trip connected', () => {
  it('links a repository connected after the link was minted, with the picker’s role', async () => {
    const fresh = await seedRepo('motir-infra', AFTER);

    const { linked } = await call();

    expect(linked.map((row) => row.realizedRepo?.id)).toEqual([fresh.id]);
    const [row] = await adminDb.projectRepo.findMany({ where: { projectId: fx.projectId } });
    expect(row?.githubRepoId).toBe(fresh.id);
    expect(row?.role).toBe('other');
    expect(row?.state).toBe('connected');
  });

  it('runs the organisation link first, through the org branch, for the state’s workspace', async () => {
    await call();
    expect(linkSpy).toHaveBeenCalledWith({
      organizationId: orgId,
      actorUserId: fx.ctx.userId,
      installationId: `inst-${fx.workspaceId}`,
      via: 'install_return',
      workspaceIdHint: fx.workspaceId,
      requireHintInOrganization: true,
    });
  });

  it('leaves a repository the organisation held BEFORE the link was minted unlinked', async () => {
    await seedRepo('motir-core', BEFORE);
    await seedRepo('motir-infra', AFTER);

    await call();

    expect(await heldNames()).toEqual(['motir-infra']);
  });

  it('leaves a repository of ANOTHER installation unlinked, however new', async () => {
    await seedRepo('elsewhere', AFTER, otherInstallationRowId);
    await seedRepo('motir-infra', AFTER);

    await call();

    expect(await heldNames()).toEqual(['motir-infra']);
  });

  it('skips one the project already holds and still links the rest', async () => {
    const held = await seedRepo('motir-ai', AFTER);
    await organizationRepoService.linkExistingRepo(
      fx.projectId,
      { githubRepoId: held.id, role: 'api' },
      fx.ctx,
    );
    await seedRepo('motir-infra', AFTER);

    const { linked } = await call();

    expect(linked.map((row) => row.name)).toEqual(['motir-infra']);
    expect(await heldNames()).toEqual(['motir-ai', 'motir-infra']);
  });

  it('links nothing, and does not throw, when the round trip connected nothing new', async () => {
    await seedRepo('motir-core', BEFORE);
    const { linked } = await call();
    expect(linked).toEqual([]);
    expect(await heldNames()).toEqual([]);
  });

  it('refuses an actor who manages the project but does not administer the organisation', async () => {
    await seedRepo('motir-infra', AFTER);
    const user = await adminDb.user.create({
      data: { email: `pa-${Date.now()}@example.com`, name: 'Project admin', emailVerified: true },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: user.id, workspaceRole: 'manager' },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: user.id, role: ORGANIZATION_ROLE.member },
    });

    await expect(call({ userId: user.id, workspaceId: fx.workspaceId })).rejects.toThrow();
    expect(await heldNames()).toEqual([]);
  });
});
