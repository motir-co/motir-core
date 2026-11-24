// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { RawSpendRow } from '@/lib/ai/motirAiClient';

/**
 * The org Usage tab's BY WORKSPACE AND PROJECT table (Story MOTIR-727 · MOTIR-7293):
 * a workspace expands to its projects (read on demand through the audited server
 * action), and the two rows no workspace holds render as their own rows.
 */

const loadMock = vi.fn();
vi.mock('@/app/(admin)/admin/tenants/[orgId]/usageActions', () => ({
  loadWorkspaceProjects: (input: unknown) => loadMock(input),
}));

const { SpendChildrenTable } =
  await import('@/app/(admin)/admin/tenants/[orgId]/_components/SpendChildrenTable');

function row(entityId: string, chargedCredits: number): RawSpendRow {
  const credits = {
    planning_tokens: chargedCredits,
    agent_tokens: 0,
    agent_machine: 0,
    agent_instance: 0,
    agent_storage: 0,
    ci: 0,
    search: 0,
    hosting_production: 0,
  };
  return {
    entityId,
    credits,
    indexingSeconds: 120,
    chargedCredits,
    costMicroUsd: chargedCredits * 435,
    cost: { ...credits, indexing: 0 },
  };
}

function renderTable() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SpendChildrenTable
        orgId="org_1"
        period="2026-09"
        childLevel="workspace"
        rows={[
          { ...row('ws_eng', 90), name: 'Engineering' },
          { ...row('ws_ops', 10), name: 'Ops' },
        ]}
        remainder={{ noProject: row('no_project', 7), orgLevel: row('org_level', 3) }}
        truncated={false}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  loadMock.mockReset();
});

describe('SpendChildrenTable', () => {
  it('expands a workspace to its projects through the audited action, for the tab’s period', async () => {
    loadMock.mockResolvedValue({
      rows: [
        { ...row('pj_mobile', 60), name: 'Mobile' },
        { ...row('pj_web', 30), name: 'Web' },
      ],
      truncated: false,
    });
    const { container } = renderTable();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Engineering/ }));
    });
    expect(loadMock).toHaveBeenCalledWith({
      orgId: 'org_1',
      workspaceId: 'ws_eng',
      period: '2026-09',
    });
    const projects = [...container.querySelectorAll('[data-project-of="ws_eng"]')];
    expect(projects.map((r) => r.children[0]!.textContent)).toEqual(['Mobile', 'Web']);

    fireEvent.click(screen.getByRole('button', { name: /Engineering/ }));
    expect(container.querySelectorAll('[data-project-of="ws_eng"]')).toHaveLength(0);
  });

  it('a project read that fails says so in place', async () => {
    loadMock.mockResolvedValue(null);
    renderTable();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Ops/ }));
    });
    expect(screen.getByRole('status').textContent).toMatch(/can't be shown/);
  });

  it('renders the two rows no workspace holds as their own rows', () => {
    renderTable();
    expect(screen.getByTestId('children-no-project').children[0]!.textContent).toBe(
      'Agent runs with no project',
    );
    expect(screen.getByTestId('children-org-level').children[0]!.textContent).toBe(
      'Org-level (not by project)',
    );
  });
});
