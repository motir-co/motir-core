// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PlatformRole } from '@/generated/prisma/client';
import en from '@/messages/en.json';

/**
 * The console rail's FLEET SETTINGS row (Story MOTIR-8699 · MOTIR-8715, design
 * `platform-admin` AMENDMENT 2026-10 § Fleet settings): a superadmin sees it
 * under Operations directly after Monitoring; a support or operator principal
 * does not see it at all (the route 404s for them — the Audit log row's rule).
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
  navFleetSettings: en.platformAdmin.shell.navFleetSettings,
  navCapacity: en.platformAdmin.shell.navCapacity,
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

describe('the Fleet settings row', () => {
  it('is labelled from the catalogue', () => {
    expect(LABELS.navFleetSettings).toBe('Fleet settings');
  });

  it('is on the rail for a superadmin, directly after Monitoring', () => {
    const rail = renderShell('superadmin', '/admin');
    const row = within(rail).getByRole('link', { name: LABELS.navFleetSettings });
    expect(row.getAttribute('href')).toBe('/admin/fleet-settings');
    expect(row.getAttribute('aria-current')).toBeNull();
    const names = within(rail)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim());
    expect(names[names.indexOf(LABELS.navMonitoring) + 1]).toBe(LABELS.navFleetSettings);
    expect(names[names.indexOf(LABELS.navFleetSettings) + 1]).toBe(LABELS.navCapacity);
  });

  it.each(['support', 'operator'] as const)('is absent for %s', (role) => {
    const rail = renderShell(role, '/admin');
    expect(within(rail).queryByRole('link', { name: LABELS.navFleetSettings })).toBeNull();
  });

  it('is lit on its page, and Monitoring is not', () => {
    const rail = renderShell('superadmin', '/admin/fleet-settings');
    expect(
      within(rail)
        .getByRole('link', { name: LABELS.navFleetSettings })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(rail).getByRole('link', { name: LABELS.navMonitoring }).getAttribute('aria-current'),
    ).toBeNull();
  });
});
