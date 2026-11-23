// @vitest-environment happy-dom
import { StrictMode, type ReactElement } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { db } from '@/lib/db';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectLinkGate } from '@/app/(authed)/settings/project/_components/ProjectLinkGate';
import { createTestUser } from '../fixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A PROJECT-SETTINGS LINK MAY NAME ITS PROJECT (Bug MOTIR-12169).
//
// The notification rows whose subject is a project open a project-settings room
// — a refused code access opens Code access, a crashed production app opens the
// event on Production — and the reader may get one about a project that is not
// their active one. Every `/settings/project/*` room resolves its project from
// the ACTIVE project, so before this fix the link opened the active project's
// room: Code access silently showed the wrong project, and Production answered
// 404 because the repository id is not one of the active project's.
//
// The App Router does not re-render a shared layout on a client navigation, so
// the link is honoured by a client gate the area layout wraps around every
// room, reading the URL's own search parameters. This drives that gate with the
// URL changing UNDER a mounted gate — a notification clicked while the reader
// is already in a settings room — and the REAL area layout over REAL Postgres.
// The action's server side is `openProjectLinkAction.test.ts`'s.

const { getSession, redirect, getActiveProject, url, openProjectLinkAction, replace } = vi.hoisted(
  () => ({
    getSession: vi.fn(),
    redirect: vi.fn((to: string) => {
      throw new Error(`redirect:${to}`);
    }),
    getActiveProject: vi.fn(),
    url: { pathname: '/settings/project/code-access', search: '' },
    openProjectLinkAction: vi.fn(),
    replace: vi.fn(),
  }),
);

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => url.pathname,
  useSearchParams: () => new URLSearchParams(url.search),
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
vi.mock('@/app/(authed)/_project-actions', () => ({ openProjectLinkAction }));

const ROOM = <div data-testid="settings-page">the active project’s room</div>;
const REFUSED = <p>You don’t have access to this project</p>;

beforeEach(() => {
  url.pathname = '/settings/project/code-access';
  url.search = '';
  openProjectLinkAction.mockReset();
  openProjectLinkAction.mockResolvedValue('switched');
  replace.mockReset();
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

/** Navigate the (mocked) client router and re-render the mounted gate. */
async function navigate(
  rerender: (ui: ReactElement) => void,
  pathname: string,
  search: string,
): Promise<void> {
  url.pathname = pathname;
  url.search = search;
  rerender(gate());
  await settle();
}

function gate() {
  return <ProjectLinkGate refused={REFUSED}>{ROOM}</ProjectLinkGate>;
}

describe('the link gate around every project-settings room (MOTIR-12169)', () => {
  it('a URL naming no project shows the room and opens nothing', async () => {
    renderWithIntl(gate());
    await settle();
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    expect(openProjectLinkAction).not.toHaveBeenCalled();
  });

  it('the access-refused row’s link hides the room, opens the project, then lands on its Code access', async () => {
    url.search = 'project=BBB';
    renderWithIntl(gate());
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(screen.getByTestId('project-link-switch').getAttribute('aria-busy')).toBe('true');
    await settle();
    expect(openProjectLinkAction).toHaveBeenCalledTimes(1);
    expect(openProjectLinkAction).toHaveBeenCalledWith('BBB');
    expect(replace).toHaveBeenCalledWith('/settings/project/code-access');
  });

  it('the crash row’s link keeps its repository and event, and drops only the project', async () => {
    url.pathname = '/settings/project/production';
    url.search = 'repository=row-1&project=BBB&event=evt-9';
    renderWithIntl(gate());
    await settle();
    expect(replace).toHaveBeenCalledWith(
      '/settings/project/production?repository=row-1&event=evt-9',
    );
  });

  it('a link clicked while ALREADY in a settings room is honoured — the layout does not re-render, the gate does', async () => {
    const { rerender } = renderWithIntl(gate());
    await settle();
    expect(screen.getByTestId('settings-page')).toBeTruthy();

    // The drawer's row, opened from the Members room: a soft navigation into
    // Code access. Only the room below the layout re-renders on the server.
    await navigate(rerender, '/settings/project/code-access', 'project=BBB');
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(openProjectLinkAction).toHaveBeenCalledWith('BBB');
    expect(replace).toHaveBeenCalledWith('/settings/project/code-access');

    // Landed: the URL no longer names a project, the room shows.
    await navigate(rerender, '/settings/project/code-access', '');
    expect(screen.getByTestId('settings-page')).toBeTruthy();

    // The same link again, later, is opened again.
    await navigate(rerender, '/settings/project/production', 'project=BBB&repository=r');
    expect(openProjectLinkAction).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenLastCalledWith('/settings/project/production?repository=r');
  });

  it('a link naming the active project just drops the parameter', async () => {
    openProjectLinkAction.mockResolvedValue('current');
    url.search = 'project=AAA';
    renderWithIntl(gate());
    await settle();
    expect(replace).toHaveBeenCalledWith('/settings/project/code-access');
  });

  it('a project the reader cannot enter answers the no-access state, never the old room', async () => {
    openProjectLinkAction.mockResolvedValue('refused');
    url.search = 'project=NOPE';
    renderWithIntl(gate());
    await settle();
    expect(screen.getByText('You don’t have access to this project')).toBeTruthy();
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a failed open falls back to the no-access state, never the old room', async () => {
    openProjectLinkAction.mockRejectedValue(new Error('PROJECT_NOT_FOUND'));
    url.search = 'project=BBB';
    renderWithIntl(gate());
    await settle();
    expect(screen.getByText('You don’t have access to this project')).toBeTruthy();
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a blank key names no project', async () => {
    url.search = 'project=%20';
    renderWithIntl(gate());
    await settle();
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    expect(openProjectLinkAction).not.toHaveBeenCalled();
  });

  it('opens a link once, even when React runs the mount effect twice', async () => {
    url.search = 'project=BBB';
    renderWithIntl(<StrictMode>{gate()}</StrictMode>);
    await settle();
    expect(openProjectLinkAction).toHaveBeenCalledTimes(1);
  });
});

// ── The real area layout over real Postgres ──────────────────────────────────

/** An administrator of a project, AAA, with it active. */
async function oneProject() {
  const fx = await makeWorkItemFixture({ identifier: 'AAA' });
  return fx;
}

function activeIs(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, userId: string) {
  getActiveProject.mockResolvedValue({
    userId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: { id: fx.projectId, identifier: fx.projectIdentifier, name: 'Acme' },
  });
}

async function renderLayout() {
  const mod = await import('@/app/(authed)/settings/project/layout');
  const tree = (await mod.default({ children: ROOM })) as ReactElement;
  renderWithIntl(tree);
  await settle();
}

describe('the area layout wraps every answer in the link gate (MOTIR-12169)', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    getSession.mockResolvedValue({ user: { id: 'u' } });
  });

  it('renders the room for a browser, and a link in its URL is opened', async () => {
    const fx = await oneProject();
    activeIs(fx, fx.ownerId);
    await renderLayout();
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    cleanup();

    url.search = 'project=BBB';
    await renderLayout();
    expect(screen.queryByTestId('settings-page')).toBeNull();
    expect(openProjectLinkAction).toHaveBeenCalledWith('BBB');
  });

  it('a reader who cannot browse their ACTIVE project gets the no-access state — and a link still opens', async () => {
    const fx = await oneProject();
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    await projectMembersService.setAccessMode({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    activeIs(fx, member.id);
    await renderLayout();
    expect(screen.getByText('You don’t have access to this project')).toBeTruthy();
    expect(screen.queryByTestId('settings-page')).toBeNull();
    cleanup();

    url.search = 'project=BBB';
    await renderLayout();
    expect(openProjectLinkAction).toHaveBeenCalledWith('BBB');
  });

  it('no session goes to sign-in, and no enterable project to the no-project landing', async () => {
    const mod = await import('@/app/(authed)/settings/project/layout');
    getSession.mockResolvedValueOnce(null);
    await expect(mod.default({ children: ROOM })).rejects.toThrow('redirect:/sign-in');

    getActiveProject.mockResolvedValueOnce(null);
    await expect(mod.default({ children: ROOM })).rejects.toThrow(`redirect:${NO_PROJECT_PATH}`);
    expect(openProjectLinkAction).not.toHaveBeenCalled();
  });
});
