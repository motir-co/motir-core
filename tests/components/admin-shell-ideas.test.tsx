// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PlatformRole } from '@/generated/prisma/client';
import en from '@/messages/en.json';

/**
 * The console rail's IDEAS row (Story MOTIR-7664 · MOTIR-7680, design
 * `platform-admin` § Ideas): every staff role sees it under Operations, it is
 * lit on the list and on an idea's detail, and the rest of the rail is
 * unchanged by it — the superadmin-only Audit log stays the superadmin's.
 */

let pathname = '/admin';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

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
  navIdeas: en.platformAdmin.shell.navIdeas,
  navRunModels: 'Hosted-run models',
  navAuditLog: 'Audit log',
  staffMarkTitle: 'Platform staff',
  staffMarkSubtitle: 'All reads audited',
  searchPlaceholder: 'Search the estate',
  footerStaff: 'Staff',
  exitToApp: 'Exit to app',
};

afterEach(cleanup);

function renderShell(role: PlatformRole, at: string) {
  pathname = at;
  render(
    <AdminShell operator={{ email: 'ops@moooon.net', role }} labels={LABELS}>
      <p>page</p>
    </AdminShell>,
  );
  return screen.getByRole('navigation', { name: 'Operator console' });
}

describe('the Ideas row', () => {
  it.each(['support', 'operator', 'superadmin'] as const)('is on the rail for %s', (role) => {
    const rail = renderShell(role, '/admin');
    const row = within(rail).getByRole('link', { name: LABELS.navIdeas });
    expect(row.getAttribute('href')).toBe('/admin/ideas');
    expect(row.getAttribute('aria-current')).toBeNull();
  });

  it('is lit on the list and on an idea’s detail, and Overview is not', () => {
    for (const at of ['/admin/ideas', '/admin/ideas/stop-returns']) {
      const rail = renderShell('support', at);
      expect(
        within(rail).getByRole('link', { name: LABELS.navIdeas }).getAttribute('aria-current'),
      ).toBe('page');
      expect(
        within(rail).getByRole('link', { name: 'Overview' }).getAttribute('aria-current'),
      ).toBeNull();
      cleanup();
    }
  });

  it('leaves the Audit log to the superadmin', () => {
    expect(
      within(renderShell('operator', '/admin')).queryByRole('link', { name: 'Audit log' }),
    ).toBeNull();
    cleanup();
    expect(
      within(renderShell('superadmin', '/admin/audit-log')).getByRole('link', {
        name: 'Audit log',
      }),
    ).toBeTruthy();
  });
});
