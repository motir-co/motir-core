// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { db } from '@/lib/db';
import { hasMotirRepository } from '@/lib/environmentConfig/motirRepositories';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PROJECT_SETTINGS_NAV, visibleSettingsNav } from '@/lib/settings/projectSettingsNav';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { createTestUser } from '../fixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE /settings/project/environment PAGE (Story MOTIR-9795 · MOTIR-9966) — the
// real page module over REAL Postgres: the session, the active project and the
// translator are stubbed at their module boundaries, and everything the page
// decides on the server — the guard, the write key, which repositories it offers,
// the not-found state — runs against stored rows. The island's behaviour is
// `tests/components/environment-room.test.tsx`'s; here its fetches answer empty.

const { getSession, redirect, getActiveProject } = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  getActiveProject: vi.fn(),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
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

beforeEach(async () => {
  await truncateAuthTables();
  getSession.mockResolvedValue({ user: { id: 'u' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function setup() {
  const fx = await makeWorkItemFixture();
  const web = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'acme-web' },
    fx.ctx,
  );
  const customer = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'api', name: 'their-api' },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: customer.id },
    data: { seedSource: SEED_SOURCE_ORGANIZATION },
  });
  const member = await createTestUser();
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  return { fx, webId: web.id, customerId: customer.id, memberId: member.id };
}

function asActor(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, userId: string) {
  getActiveProject.mockResolvedValue({
    userId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: { id: fx.projectId, identifier: fx.projectIdentifier, name: 'Acme' },
  });
}

async function renderPage(searchParams: Record<string, string> = {}) {
  const mod = await import('@/app/(authed)/settings/project/environment/page');
  const tree = (await mod.default({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
  renderWithIntl(tree);
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('the Environment page', () => {
  it('an administrator gets the room for the Motir repository, editable, without the Release tab', async () => {
    const { fx, webId } = await setup();
    asActor(fx, fx.ownerId);
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Environment');
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Production', 'Preview']);
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBeNull();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      `/api/projects/${fx.projectIdentifier}/repositories/${webId}/environments/production/entries`,
    );
  });

  it('never offers the customer repository in the selector', async () => {
    const { fx } = await setup();
    asActor(fx, fx.ownerId);
    await renderPage();
    fireEvent.click(screen.getByRole('combobox', { name: 'Repository' }));
    await act(async () => {});
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options).toHaveLength(1);
    expect(options[0]).toContain('acme-web');
    expect(options.join(' ')).not.toContain('their-api');
  });

  it('a customer repository’s address, and an unknown one, answer the not-found state', async () => {
    const { fx, customerId } = await setup();
    asActor(fx, fx.ownerId);
    await renderPage({ repository: customerId });
    expect(screen.getByTestId('environment-not-found').textContent).toContain(
      'Repository not found',
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    cleanup();
    await renderPage({ repository: 'no-such-row' });
    expect(screen.getByTestId('environment-not-found')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Environment' }).getAttribute('href')).toBe(
      '/settings/project/environment',
    );
  });

  it('a member without repository:manage reads it with the note and disabled controls', async () => {
    const { fx, memberId } = await setup();
    asActor(fx, memberId);
    await renderPage();
    expect(screen.getByRole('note').textContent).toBe(
      'You can read these values. Only project administrators can change them.',
    );
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('a release request falls back to Production while the Release tab is not shown', async () => {
    const { fx } = await setup();
    asActor(fx, fx.ownerId);
    await renderPage({ environment: 'release' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Production');
  });

  it('a project holding no repository Motir hosts has no room: no rail entry, and the not-found state', async () => {
    const fx = await makeWorkItemFixture();
    const only = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'theirs' },
      fx.ctx,
    );
    await adminDb.projectRepo.update({
      where: { id: only.id },
      data: { seedSource: SEED_SOURCE_ORGANIZATION },
    });
    // The layout's own computation, over the stored set.
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    const present = hasMotirRepository(rows);
    expect(present).toBe(false);
    const held = await projectAccessService.getPermissions(fx.projectId, fx.ctx);
    expect(
      visibleSettingsNav(held, PROJECT_SETTINGS_NAV, {
        publicProjectsAvailable: true,
        hostedRunsAvailable: true,
        motirRepositoriesPresent: present,
      }).map((e) => e.id),
    ).not.toContain('environment');

    asActor(fx, fx.ownerId);
    await renderPage();
    expect(screen.getByTestId('environment-not-found')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Back to Environment' })).toBeNull();
  });
});
