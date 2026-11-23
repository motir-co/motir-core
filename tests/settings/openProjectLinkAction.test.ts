import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE ACTION A PROJECT-SETTINGS LINK OPENS WITH (Bug MOTIR-12169) — over REAL
// Postgres, with only the session, the workspace cookie and the cache
// invalidation stubbed at their module boundaries. It is the link's whole
// server side: the browse-gated, alias-aware resolution of the key, and the
// switcher's switch for another project the reader may enter.

const { getSession, getWorkspaceContext, revalidatePath } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getWorkspaceContext: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext,
}));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidatePath,
}));

import { openProjectLinkAction } from '@/app/(authed)/_project-actions';

beforeEach(async () => {
  await truncateAuthTables();
  revalidatePath.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** An administrator of two projects, AAA and BBB, signed in with AAA active. */
async function twoProjects() {
  const fx = await makeWorkItemFixture({ identifier: 'AAA' });
  const b = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Bravo',
    identifier: 'BBB',
  });
  return { fx, b };
}

function signedIn(userId: string, workspaceId: string) {
  getSession.mockResolvedValue({ user: { id: userId } });
  getWorkspaceContext.mockResolvedValue({ userId, workspaceId });
}

async function activeId(userId: string, workspaceId: string) {
  return (await projectsService.getActiveProject(userId, workspaceId))?.id;
}

describe('openProjectLinkAction (MOTIR-12169)', () => {
  it('switches to another project the reader may enter, and revalidates the shell', async () => {
    const { fx, b } = await twoProjects();
    await projectsService.setActiveProject({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    signedIn(fx.ownerId, fx.workspaceId);

    await expect(openProjectLinkAction('BBB')).resolves.toBe('switched');
    expect(await activeId(fx.ownerId, fx.workspaceId)).toBe(b.id);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('a link naming the active project writes nothing', async () => {
    const { fx } = await twoProjects();
    await projectsService.setActiveProject({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    signedIn(fx.ownerId, fx.workspaceId);

    await expect(openProjectLinkAction('aaa')).resolves.toBe('current');
    expect(await activeId(fx.ownerId, fx.workspaceId)).toBe(fx.projectId);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a lower-case key and a retired key both reach the project', async () => {
    const { fx, b } = await twoProjects();
    signedIn(fx.ownerId, fx.workspaceId);
    await projectsService.setActiveProject({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    await expect(openProjectLinkAction('bbb')).resolves.toBe('switched');
    expect(await activeId(fx.ownerId, fx.workspaceId)).toBe(b.id);

    await projectsService.setActiveProject({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    await projectsService.changeKey({ key: 'BBB', newKey: 'BRAV', ctx: fx.ctx });
    await expect(openProjectLinkAction('BBB')).resolves.toBe('switched');
    expect(await activeId(fx.ownerId, fx.workspaceId)).toBe(b.id);
  });

  it('a project the reader cannot browse is refused like a missing key, and nothing switches', async () => {
    const { fx, b } = await twoProjects();
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    await projectMembersService.setAccessMode({
      key: b.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    await projectsService.setActiveProject({
      userId: member.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    signedIn(member.id, fx.workspaceId);

    await expect(openProjectLinkAction('BBB')).resolves.toBe('refused');
    await expect(openProjectLinkAction('NOPE')).resolves.toBe('refused');
    expect(await activeId(member.id, fx.workspaceId)).toBe(fx.projectId);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a resolver failure that is not a refusal is raised, never read as no access', async () => {
    const { fx } = await twoProjects();
    signedIn(fx.ownerId, fx.workspaceId);
    const spy = vi
      .spyOn(projectsService, 'resolveByKey')
      .mockRejectedValueOnce(new Error('connection reset'));
    try {
      await expect(openProjectLinkAction('BBB')).rejects.toThrow('connection reset');
    } finally {
      spy.mockRestore();
    }
  });

  it('a signed-out caller is refused before any read', async () => {
    getSession.mockResolvedValue(null);
    await expect(openProjectLinkAction('BBB')).rejects.toThrow('UNAUTHENTICATED');
  });
});
