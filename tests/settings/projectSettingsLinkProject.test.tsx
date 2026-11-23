// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { db } from '@/lib/db';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectsService } from '@/lib/services/projectsService';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A PROJECT-SETTINGS LINK MAY NAME ITS PROJECT (Bug MOTIR-12169).
//
// The notification rows whose subject is a project open a project-settings page
// — a refused code access opens Code access, a crashed production app opens the
// event on Production — and the reader may get one about a project that is not
// their active one. Every `/settings/project/*` page resolves its project from
// the ACTIVE project, so before this fix the link opened the active project's
// room: Code access silently showed the wrong project, and Production answered
// 404 because the repository id is not one of the active project's.
//
// This drives the REAL area layout over REAL Postgres, with the request path the
// proxy forwards, the session and the active project stubbed at their module
// boundaries — the pattern `productionPage.test.tsx` uses — and the switch the
// layout hands to the browser rendered and run.

const { getSession, redirect, getActiveProject, currentPath, setActiveProjectAction, replace } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    redirect: vi.fn((to: string) => {
      throw new Error(`redirect:${to}`);
    }),
    getActiveProject: vi.fn(),
    currentPath: { value: null as string | null },
    setActiveProjectAction: vi.fn(),
    replace: vi.fn(),
  }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/headers')>()),
  headers: async () =>
    new Headers(currentPath.value === null ? {} : { 'x-current-path': currentPath.value }),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/app/(authed)/_project-actions', () => ({ setActiveProjectAction }));

const PAGE = <div data-testid="settings-page">the active project’s room</div>;

beforeEach(async () => {
  await truncateAuthTables();
  getSession.mockResolvedValue({ user: { id: 'u' } });
  currentPath.value = null;
  setActiveProjectAction.mockReset();
  setActiveProjectAction.mockResolvedValue(undefined);
  replace.mockReset();
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** An administrator of two projects, A and B, with A active. */
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

function activeIs(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, userId: string) {
  getActiveProject.mockResolvedValue({
    userId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: { id: fx.projectId, identifier: fx.projectIdentifier, name: 'Acme' },
  });
}

async function renderLayout(path: string | null) {
  currentPath.value = path;
  const mod = await import('@/app/(authed)/settings/project/layout');
  const tree = (await mod.default({ children: PAGE })) as ReactElement;
  renderWithIntl(tree);
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('a project-settings link that names another project (MOTIR-12169)', () => {
  it('the access-refused row’s link switches to the named project, then lands on its Code access', async () => {
    const { fx, b } = await twoProjects();
    activeIs(fx, fx.ownerId);
    await renderLayout('/settings/project/code-access?project=BBB');

    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(setActiveProjectAction).toHaveBeenCalledTimes(1);
    expect(setActiveProjectAction).toHaveBeenCalledWith(b.id);
    expect(replace).toHaveBeenCalledWith('/settings/project/code-access');
  });

  it('the crash row’s link keeps its repository and event, and drops only the project', async () => {
    const { fx, b } = await twoProjects();
    activeIs(fx, fx.ownerId);
    await renderLayout('/settings/project/production?repository=row-1&project=BBB&event=evt-9');

    expect(setActiveProjectAction).toHaveBeenCalledWith(b.id);
    expect(replace).toHaveBeenCalledWith(
      '/settings/project/production?repository=row-1&event=evt-9',
    );
  });

  it('a lower-case key and a retired key both reach the project', async () => {
    const { fx, b } = await twoProjects();
    activeIs(fx, fx.ownerId);
    await renderLayout('/settings/project/code-access?project=bbb');
    expect(setActiveProjectAction).toHaveBeenLastCalledWith(b.id);

    cleanup();
    await projectsService.changeKey({
      key: 'BBB',
      newKey: 'BRAV',
      ctx: fx.ctx,
    });
    await renderLayout('/settings/project/code-access?project=BBB');
    expect(setActiveProjectAction).toHaveBeenLastCalledWith(b.id);
  });

  it('a link naming the ACTIVE project renders the room in place and switches nothing', async () => {
    const { fx } = await twoProjects();
    activeIs(fx, fx.ownerId);
    await renderLayout('/settings/project/code-access?project=AAA');

    expect(screen.getByTestId('settings-page')).toBeTruthy();
    expect(setActiveProjectAction).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a link naming no project — or no path at all — renders the active project’s room', async () => {
    const { fx } = await twoProjects();
    activeIs(fx, fx.ownerId);
    for (const path of ['/settings/project/code-access', null, '/settings/project?project=']) {
      await renderLayout(path);
      expect(screen.getByTestId('settings-page')).toBeTruthy();
      cleanup();
    }
    expect(setActiveProjectAction).not.toHaveBeenCalled();
  });

  it('a project the reader cannot enter answers the no-access state, and nothing switches', async () => {
    const { fx, b } = await twoProjects();
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    await projectMembersService.setAccessMode({
      key: b.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    activeIs(fx, member.id);
    await renderLayout('/settings/project/code-access?project=BBB');

    expect(screen.getByText('You don’t have access to this project')).toBeTruthy();
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(setActiveProjectAction).not.toHaveBeenCalled();
  });

  it('a key no project carries answers the same no-access state — existence is not leaked', async () => {
    const { fx } = await twoProjects();
    activeIs(fx, fx.ownerId);
    await renderLayout('/settings/project/code-access?project=NOPE');

    expect(screen.getByText('You don’t have access to this project')).toBeTruthy();
    expect(setActiveProjectAction).not.toHaveBeenCalled();
  });

  it('a switch the server refuses after all falls back to the no-access state, never the old room', async () => {
    const { fx } = await twoProjects();
    activeIs(fx, fx.ownerId);
    setActiveProjectAction.mockRejectedValue(new Error('PROJECT_NOT_FOUND'));
    await renderLayout('/settings/project/code-access?project=BBB');

    expect(screen.getByText('You don’t have access to this project')).toBeTruthy();
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a resolver failure that is not a refusal is raised, never read as no access', async () => {
    const { fx } = await twoProjects();
    activeIs(fx, fx.ownerId);
    const spy = vi
      .spyOn(projectsService, 'resolveByKey')
      .mockRejectedValueOnce(new Error('connection reset'));
    try {
      currentPath.value = '/settings/project/code-access?project=BBB';
      const mod = await import('@/app/(authed)/settings/project/layout');
      await expect(mod.default({ children: PAGE })).rejects.toThrow('connection reset');
    } finally {
      spy.mockRestore();
    }
    expect(setActiveProjectAction).not.toHaveBeenCalled();
  });
});

describe('the area layout’s own guards still hold around the link (MOTIR-12169)', () => {
  it('no session goes to sign-in, and no enterable project to the no-project landing', async () => {
    const mod = await import('@/app/(authed)/settings/project/layout');
    currentPath.value = '/settings/project/code-access?project=BBB';

    getSession.mockResolvedValueOnce(null);
    await expect(mod.default({ children: PAGE })).rejects.toThrow('redirect:/sign-in');

    getActiveProject.mockResolvedValueOnce(null);
    await expect(mod.default({ children: PAGE })).rejects.toThrow(`redirect:${NO_PROJECT_PATH}`);
    expect(setActiveProjectAction).not.toHaveBeenCalled();
  });

  it('a reader who cannot browse their ACTIVE project still gets the no-access state', async () => {
    const { fx } = await twoProjects();
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    await projectMembersService.setAccessMode({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    activeIs(fx, member.id);
    await renderLayout('/settings/project/code-access');

    expect(screen.getByText('You don’t have access to this project')).toBeTruthy();
    expect(screen.queryByTestId('settings-page')).toBeNull();
  });
});
