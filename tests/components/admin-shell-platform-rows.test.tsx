// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PlatformRole } from '@/generated/prisma/client';

/**
 * The console rail's PLATFORM group after the Contact-sales removal (Story
 * MOTIR-9385 · MOTIR-9386): Motir has no Enterprise plan, so the rail carries no
 * row for the requests that plan's card used to send. Platform is Overview,
 * Usage & cost, Tenants and Users — the same for every staff role — and no link
 * anywhere on the rail leads to the removed console pages.
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/admin' }));

const { AdminShell } = await import('@/app/(admin)/_components/AdminShell');

const LABELS = {
  brand: 'Motir',
  area: 'Operator console',
  groupPlatform: 'Platform',
  groupOperations: 'Operations',
  navOverview: 'Overview',
  navUsage: 'Usage & cost',
  navTenants: 'Tenants',
  navUsers: 'Users',
  navMonitoring: 'Monitoring',
  navJobs: 'Jobs',
  navFleetSettings: 'Fleet settings',
  navCapacity: 'Provider capacity',
  navAiPlanning: 'AI planning',
  navPlanningLessons: 'Planning lessons',
  navIdeas: 'Ideas',
  navRunModels: 'Hosted-run models',
  navAuditLog: 'Audit log',
  staffMarkTitle: 'Platform staff',
  staffMarkSubtitle: 'All reads audited',
  searchPlaceholder: 'Search the estate',
  footerStaff: 'Staff',
  exitToApp: 'Exit to app',
};

afterEach(cleanup);

function renderRail(role: PlatformRole) {
  render(
    <AdminShell operator={{ email: 'ops@moooon.net', role }} labels={LABELS}>
      <p>page</p>
    </AdminShell>,
  );
  return screen.getByRole('navigation', { name: 'Operator console' });
}

describe('the Platform group', () => {
  it.each(['support', 'operator', 'superadmin'] as const)(
    'for %s ends at Users, with no row for sales requests',
    (role) => {
      const rail = renderRail(role);
      const hrefs = within(rail)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href') ?? '');
      expect(hrefs.slice(0, 4)).toEqual([
        '/admin',
        '/admin/usage',
        '/admin/tenants',
        '/admin/users',
      ]);
      expect(hrefs.filter((h) => /enterprise/i.test(h))).toEqual([]);
      expect(within(rail).queryByText(/enterprise/i)).toBeNull();
    },
  );
});
