// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

/**
 * The console rail's MODEL SERVING row (MOTIR-11280; design MOTIR-11279,
 * `platform-admin/design-notes.md` § Model serving, Placement): directly after
 * Motir agent models, for every staff role, lit on its own route only.
 */

const pathname = vi.hoisted(() => ({ current: '/admin/model-serving' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

const { AdminShell } = await import('@/app/(admin)/_components/AdminShell');

const LABELS = {
  brand: 'Motir',
  area: 'Operator console',
  groupPlatform: 'Platform',
  groupOperations: 'Operations',
  navOverview: 'Overview',
  navUsage: 'Usage & cost',
  navCosts: 'Costs',
  navTenants: 'Tenants',
  navUsers: 'Users',
  navMonitoring: 'Monitoring',
  navJobs: 'Jobs',
  navCredentials: 'Credentials',
  navFleetSettings: 'Fleet settings',
  navFleetStatus: 'Fleet status',
  navServices: 'Services',
  navCapacity: 'Provider capacity',
  navAiPlanning: 'AI planning',
  navPlanningLessons: 'Planning lessons',
  navPlannerFindings: 'Planner findings',
  navIdeas: 'Ideas',
  navStarters: 'Starters',
  navRunModels: 'Motir agent models',
  navModelServing: 'Model serving',
  navAuditLog: 'Audit log',
  staffMarkTitle: 'Platform staff',
  staffMarkSubtitle: 'All reads audited',
  searchPlaceholder: 'Search the estate',
  footerStaff: 'Staff',
  exitToApp: 'Exit to app',
};

afterEach(() => cleanup());

function rail() {
  render(
    <AdminShell operator={{ email: 'ops@moooon.net', role: 'support' }} labels={LABELS}>
      <p>page</p>
    </AdminShell>,
  );
  return screen.getByRole('navigation', { name: 'Operator console' });
}

describe('the Model serving row', () => {
  it('follows Motir agent models and is lit on /admin/model-serving', () => {
    const hrefs = within(rail())
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    const at = hrefs.indexOf('/admin/model-serving');
    expect(at).toBeGreaterThan(0);
    expect(hrefs[at - 1]).toBe('/admin/run-models');
    const link = screen.getByRole('link', { name: 'Model serving' });
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('is not lit elsewhere', () => {
    pathname.current = '/admin/run-models';
    rail();
    expect(
      screen.getByRole('link', { name: 'Model serving' }).getAttribute('aria-current'),
    ).toBeNull();
  });
});
