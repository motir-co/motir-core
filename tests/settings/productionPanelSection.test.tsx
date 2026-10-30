// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { db } from '@/lib/db';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { ProductionPanelSection } from '@/app/(authed)/settings/project/production/_components/ProductionPanelSection';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE PRODUCTION PANEL'S SERVER READ (Story MOTIR-9797 · MOTIR-10037) — the async
// section the page streams behind its skeleton, over REAL Postgres: it seeds the
// island with the routes' own payload, and a read that fails renders the error
// state with nothing shown as live.

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('ProductionPanelSection', () => {
  it('seeds the panel from the read: a Motir repository that never released is empty', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'shop' },
      fx.ctx,
    );
    const tree = (await ProductionPanelSection({
      projectKey: fx.projectIdentifier,
      repositoryId: row.id,
      repositoryName: 'shop',
      actor: fx.ctx,
    })) as ReactElement;
    renderWithIntl(tree);
    expect(screen.getByTestId('production-panel')).toBeTruthy();
    expect(screen.getByTestId('production-empty-state').textContent).toContain(
      'Nothing in production yet',
    );
  });

  it('renders the error state, nothing as live, when the read fails', async () => {
    const fx = await makeWorkItemFixture();
    const tree = (await ProductionPanelSection({
      projectKey: fx.projectIdentifier,
      repositoryId: 'no-such-row',
      repositoryName: 'shop',
      actor: fx.ctx,
    })) as ReactElement;
    renderWithIntl(tree);
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load the releases');
    expect(screen.queryByTestId('production-state-pill')).toBeNull();
  });
});
