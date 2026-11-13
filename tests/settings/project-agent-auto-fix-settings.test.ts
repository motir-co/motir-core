import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectAgentAutoFixSettingsService as service } from '@/lib/services/projectAgentAutoFixSettingsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// MOTIR-9060 — the agent auto-fix switch's service over the REAL stack: the READ
// takes `work_item:edit` and the WRITE `ai:configure` (the Motir agent room's two
// keys), and a patch naming the held value writes nothing.

const PASSWORD = 'agent-auto-fix-pass-123';

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

const ctxFor = (userId: string, workspaceId: string): WorkspaceContext => ({ userId, workspaceId });

interface Seeded {
  projectId: string;
  workspaceId: string;
  admin: WorkspaceContext;
  member: WorkspaceContext;
  /** A workspace member with no role on a PRIVATE project — cannot browse it. */
  outsider: WorkspaceContext;
}

async function seed(slug: string): Promise<Seeded> {
  const user = (email: string, name: string) =>
    usersService.createUser({ email, password: PASSWORD, name });

  const owner = await user(`owner-${slug}@ex.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);
  await projectMembersService.setAccessMode({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    mode: 'members',
  });

  async function projectActor(role: 'admin' | 'member') {
    const u = await user(`${role}-${slug}@ex.com`, role);
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return ctxFor(u.id, workspace.id);
  }

  const outsider = await user(`outsider-${slug}@ex.com`, 'Outsider');
  await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

  return {
    projectId: project.id,
    workspaceId: workspace.id,
    admin: await projectActor('admin'),
    member: await projectActor('member'),
    outsider: ctxFor(outsider.id, workspace.id),
  };
}

const stored = async (projectId: string) =>
  (await adminDb.project.findUniqueOrThrow({ where: { id: projectId } })).agentAutoFixEnabled;

describe('access: the Motir agent room’s two keys', () => {
  it('a project MEMBER reads the stored value (off on a fresh project)', async () => {
    const s = await seed('member-read');
    await expect(service.getSettings(s.projectId, s.member)).resolves.toEqual({
      agentAutoFixEnabled: false,
    });
  });

  it('a non-browser’s read is refused', async () => {
    const s = await seed('outsider-read');
    await expect(service.getSettings(s.projectId, s.outsider)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('a member’s write is refused naming ai:configure, and nothing changes', async () => {
    const s = await seed('member-write');
    await expect(
      service.updateSettings(s.projectId, { agentAutoFixEnabled: true }, s.member),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await stored(s.projectId)).toBe(false);
  });

  it('an administrator flips it on and off, and the row holds what was written', async () => {
    const s = await seed('admin-flip');
    await expect(
      service.updateSettings(s.projectId, { agentAutoFixEnabled: true }, s.admin),
    ).resolves.toEqual({ agentAutoFixEnabled: true });
    expect(await stored(s.projectId)).toBe(true);
    await expect(service.getSettings(s.projectId, s.member)).resolves.toEqual({
      agentAutoFixEnabled: true,
    });
    await service.updateSettings(s.projectId, { agentAutoFixEnabled: false }, s.admin);
    expect(await stored(s.projectId)).toBe(false);
  });
});

describe('a patch naming the held value is a read', () => {
  it.each([true, false])('performs no column write when already %s', async (held) => {
    const s = await seed(`noop-${held}`);
    if (held) await service.updateSettings(s.projectId, { agentAutoFixEnabled: true }, s.admin);
    const spy = vi.spyOn(projectRepository, 'updateAgentAutoFixEnabled');
    await expect(
      service.updateSettings(s.projectId, { agentAutoFixEnabled: held }, s.admin),
    ).resolves.toEqual({ agentAutoFixEnabled: held });
    expect(spy).not.toHaveBeenCalled();
    await service.updateSettings(s.projectId, { agentAutoFixEnabled: !held }, s.admin);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
