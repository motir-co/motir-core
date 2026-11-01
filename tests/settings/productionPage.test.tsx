// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { db } from '@/lib/db';
import { hasMotirRepository } from '@/lib/environmentConfig/motirRepositories';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PROJECT_SETTINGS_NAV, visibleSettingsNav } from '@/lib/settings/projectSettingsNav';
import { createTestUser } from '../fixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE /settings/project/production PAGE (Story MOTIR-9797 · MOTIR-10037) — the
// real page module over REAL Postgres: the session, the active project and the
// translator are stubbed at their module boundaries, and everything the page
// decides on the server — the guard, which repositories it offers, and the 404
// for anything else — runs against stored rows, BEFORE the `<Suspense>` streams.
// The panel's own states are `tests/components/productionPanel.test.tsx`'s.

const { getSession, redirect, getActiveProject, notFound, sectionProps } = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  getActiveProject: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  }),
  sectionProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  notFound,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
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
// The streamed section is an async server component, which a client render
// cannot run; the page test records what the page handed it, and the section
// itself is rendered from its own resolved output below.
vi.mock('@/app/(authed)/settings/project/production/_components/ProductionPanelSection', () => ({
  ProductionPanelSection: (props: Record<string, unknown>) => {
    sectionProps.push(props);
    return <div data-testid="section-stub" />;
  },
}));

beforeEach(async () => {
  await truncateAuthTables();
  getSession.mockResolvedValue({ user: { id: 'u' } });
  notFound.mockClear();
  sectionProps.length = 0;
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function setup() {
  const fx = await makeWorkItemFixture();
  const web = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'shop' },
    fx.ctx,
  );
  const api = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'api', name: 'shop-api' },
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
  return { fx, webId: web.id, apiId: api.id, customerId: customer.id, memberId: member.id };
}

function asActor(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, userId: string) {
  getActiveProject.mockResolvedValue({
    userId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: { id: fx.projectId, identifier: fx.projectIdentifier, name: 'Acme' },
  });
}

async function pageTree(searchParams: Record<string, string> = {}): Promise<ReactElement> {
  const mod = await import('@/app/(authed)/settings/project/production/page');
  return (await mod.default({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
}

async function renderPage(searchParams: Record<string, string> = {}) {
  renderWithIntl(await pageTree(searchParams));
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function renderNotFound() {
  const mod = await import('@/app/(authed)/settings/project/production/not-found');
  renderWithIntl((await mod.default()) as ReactElement);
}

describe('the Production page', () => {
  it('an administrator gets the first Motir repository’s panel, headed by its name', async () => {
    const { fx, webId } = await setup();
    asActor(fx, fx.ownerId);
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Production');
    expect(screen.getByTestId('production-panel-header').textContent).toBe('shop');
    expect(sectionProps).toEqual([
      {
        projectKey: fx.projectIdentifier,
        repositoryId: webId,
        repositoryName: 'shop',
        actor: { userId: fx.ownerId, workspaceId: fx.workspaceId },
      },
    ]);
  });

  it('offers only the Motir repositories, and each opens its own panel', async () => {
    const { fx, apiId } = await setup();
    asActor(fx, fx.ownerId);
    await renderPage({ repository: apiId });
    expect(screen.getByTestId('production-panel-header').textContent).toBe('shop-api');
    expect(sectionProps[0]).toMatchObject({ repositoryId: apiId, repositoryName: 'shop-api' });
    fireEvent.click(screen.getByRole('combobox', { name: 'Repository' }));
    await act(async () => {});
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options).toHaveLength(2);
    expect(options.join(' ')).not.toContain('their-api');
  });

  it('a member who can browse the project reads it too', async () => {
    const { fx, memberId } = await setup();
    asActor(fx, memberId);
    await renderPage();
    expect(screen.getByTestId('production-panel-header').textContent).toBe('shop');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('answers 404 — before anything streams — for a customer repository, an unknown id and another project’s row', async () => {
    const { fx, customerId } = await setup();
    const other = await makeWorkItemFixture();
    const elsewhere = await projectRepoSetService.addRow(
      other.projectId,
      { role: 'web', name: 'elsewhere' },
      other.ctx,
    );
    asActor(fx, fx.ownerId);
    for (const repository of [customerId, 'no-such-row', elsewhere.id]) {
      await expect(pageTree({ repository }), repository).rejects.toThrow(
        'NEXT_HTTP_ERROR_FALLBACK;404',
      );
    }
    expect(notFound).toHaveBeenCalledTimes(3);
    expect(sectionProps).toEqual([]);
  });

  it('the not-found state names the room and offers the way back to it', async () => {
    const { fx } = await setup();
    asActor(fx, fx.ownerId);
    await renderNotFound();
    expect(screen.getByTestId('production-not-found').textContent).toContain(
      'Repository not found',
    );
    expect(screen.getByRole('link', { name: 'Back to Production' }).getAttribute('href')).toBe(
      '/settings/project/production',
    );
  });

  it('a project holding no repository Motir hosts has no room: no rail entry, a 404, no way back', async () => {
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
    ).not.toContain('production');

    asActor(fx, fx.ownerId);
    await expect(pageTree()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    await renderNotFound();
    expect(screen.getByTestId('production-not-found')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Back to Production' })).toBeNull();
  });

  it('signs out to sign-in, a missing project to its landing, and an outsider to the guard’s refusal', async () => {
    getSession.mockResolvedValueOnce(null);
    await expect(pageTree()).rejects.toThrow('redirect:/sign-in');

    getActiveProject.mockResolvedValueOnce(null);
    await expect(pageTree()).rejects.toThrow(/^redirect:/);

    const { fx } = await setup();
    const outsider = await createTestUser();
    asActor(fx, outsider.id);
    await renderPage();
    expect(screen.queryByTestId('production-panel-header')).toBeNull();
    expect(sectionProps).toEqual([]);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('the not-found state offers no way back when there is no active project', async () => {
    getActiveProject.mockResolvedValue(null);
    await renderNotFound();
    expect(screen.queryByRole('link', { name: 'Back to Production' })).toBeNull();
    getActiveProject.mockRejectedValue(new Error('boom'));
    cleanup();
    await renderNotFound();
    expect(screen.queryByRole('link', { name: 'Back to Production' })).toBeNull();
  });
});
