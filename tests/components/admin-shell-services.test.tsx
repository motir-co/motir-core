// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PlatformRole } from '@/generated/prisma/client';
import en from '@/messages/en.json';

/**
 * The console rail's SERVICES row (MOTIR-10890, design MOTIR-10889): a
 * superadmin sees it under Operations directly after Fleet settings and before
 * Provider capacity; a support or operator principal does not see it at all
 * (the route 404s for them).
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
  navJobs: en.platformAdmin.shell.navJobs,
  navCredentials: en.platformAdmin.shell.navCredentials,
  navFleetSettings: en.platformAdmin.shell.navFleetSettings,
  navFleetStatus: en.platformAdmin.shell.navFleetStatus,
  navServices: en.platformAdmin.shell.navServices,
  navCapacity: en.platformAdmin.shell.navCapacity,
  navAiPlanning: 'AI planning',
  navPlanningLessons: 'Planning lessons',
  navPlannerFindings: 'Planner findings',
  navIdeas: en.platformAdmin.shell.navIdeas,
  navStarters: en.platformAdmin.shell.navStarters,
  navRunModels: 'Motir agent models',
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

describe('the Services row', () => {
  it('is labelled from the catalogue', () => {
    expect(LABELS.navServices).toBe('Services');
  });

  it('is on the rail for a superadmin, between Fleet status and Provider capacity', () => {
    const rail = renderShell('superadmin', '/admin');
    const row = within(rail).getByRole('link', { name: LABELS.navServices });
    expect(row.getAttribute('href')).toBe('/admin/services');
    expect(row.getAttribute('aria-current')).toBeNull();
    const names = within(rail)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim());
    expect(names[names.indexOf(LABELS.navServices) - 1]).toBe(LABELS.navFleetStatus);
    expect(names[names.indexOf(LABELS.navServices) + 1]).toBe(LABELS.navCapacity);
  });

  it.each(['support', 'operator'] as const)('is absent for %s', (role) => {
    const rail = renderShell(role, '/admin');
    expect(within(rail).queryByRole('link', { name: LABELS.navServices })).toBeNull();
  });

  it('is lit on its page, and Fleet settings is not', () => {
    const rail = renderShell('superadmin', '/admin/services');
    expect(
      within(rail).getByRole('link', { name: LABELS.navServices }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(rail)
        .getByRole('link', { name: LABELS.navFleetSettings })
        .getAttribute('aria-current'),
    ).toBeNull();
  });
});
