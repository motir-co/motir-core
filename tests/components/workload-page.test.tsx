// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// `/reports/workload` reads its window as Days back ONLY (MOTIR-10346): the bars
// have no time buckets, so a `?period=` — from an old shared link — is ignored,
// and Days back reaches 180 / 365 without one. The page is an async Server
// Component, so it is CALLED; the services and the client body are mocked at
// module level, as `sprint-report-page.test.tsx` does.

const getWorkload = vi.fn();
const bodyProps = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${JSON.stringify(v)}` : k,
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => ({ user: { id: 'usr_1' } }) }));
vi.mock('@/lib/projects', () => ({
  getActiveProject: async () => ({
    userId: 'usr_1',
    workspaceId: 'ws_1',
    projectId: 'prj_1',
    project: { identifier: 'PROD', name: 'Prodect' },
  }),
}));
vi.mock('@/lib/services/reportsService', () => ({
  reportsService: { getWorkload: (...a: unknown[]) => getWorkload(...a) },
}));
vi.mock('@/lib/services/savedFiltersService', () => ({
  savedFiltersService: { list: async () => ({ items: [] }) },
}));
vi.mock('@/app/(authed)/reports/_components/ReportPageChrome', () => ({
  ReportPageChrome: ({ subLine, children }: { subLine: string; children: React.ReactNode }) => (
    <div>
      <p data-testid="sub-line">{subLine}</p>
      {children}
    </div>
  ),
}));
vi.mock('@/app/(authed)/reports/_components/WorkloadReport', () => ({
  WorkloadReport: (props: Record<string, unknown>) => {
    bodyProps(props);
    return <div data-testid="workload" />;
  },
}));

const { default: WorkloadPage } = await import('@/app/(authed)/reports/workload/page');

const open = (sp: Record<string, string>) => WorkloadPage({ searchParams: Promise.resolve(sp) });

beforeEach(() => {
  getWorkload.mockReset();
  bodyProps.mockReset();
  getWorkload.mockResolvedValue({
    state: 'ok',
    data: { measure: 'story_points', assignees: [], totalPoints: 0, totalCount: 0, window: null },
  });
});
afterEach(() => cleanup());

describe('the Workload page ignores ?period=', () => {
  it.each([['week'], ['day'], ['month'], ['bogus']])(
    'reads ?period=%s&daysBack=90 as the 90-day window with no period',
    async (period) => {
      render(await open({ period, daysBack: '90' }));
      expect(getWorkload).toHaveBeenCalledWith(
        { projectId: 'prj_1' },
        { measure: 'story_points', window: { daysBack: 90 } },
        { userId: 'usr_1', workspaceId: 'ws_1' },
      );
      const props = bodyProps.mock.calls[0]![0] as Record<string, unknown>;
      expect(props.daysBack).toBe(90);
      expect(props).not.toHaveProperty('period');
    },
  );

  it('keeps 365 days back under the old default Daily period — no 120-day cap', async () => {
    render(await open({ period: 'day', daysBack: '365' }));
    expect(getWorkload.mock.calls[0]![1]).toEqual({
      measure: 'story_points',
      window: { daysBack: 365 },
    });
    expect(screen.getByTestId('sub-line').textContent).toContain('"days":365');
  });

  it('the bare path is the 30-day window', async () => {
    render(await open({}));
    expect(getWorkload.mock.calls[0]![1]).toEqual({
      measure: 'story_points',
      window: { daysBack: 30 },
    });
  });
});
