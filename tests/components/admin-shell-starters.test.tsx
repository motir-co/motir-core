// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PlatformRole } from '@/generated/prisma/client';
import en from '@/messages/en.json';

/**
 * The console rail's STARTERS row (Story MOTIR-704 · MOTIR-712, design
 * `starter-library` §2.1, MOTIR-705): operator and superadmin see it under
 * Operations, directly after Ideas; support does not (the page 404s for them);
 * and it is lit on the library and on the promote form.
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
  navStarters: en.platformAdmin.shell.navStarters,
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

describe('the Starters row', () => {
  it.each(['operator', 'superadmin'] as const)('is on the rail for %s, after Ideas', (role) => {
    const rail = renderShell(role, '/admin');
    const row = within(rail).getByRole('link', { name: LABELS.navStarters });
    expect(row.getAttribute('href')).toBe('/admin/starters');
    const links = within(rail)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(links.indexOf(LABELS.navStarters)).toBe(links.indexOf(LABELS.navIdeas) + 1);
  });

  it('is absent for support', () => {
    expect(
      within(renderShell('support', '/admin')).queryByRole('link', { name: LABELS.navStarters }),
    ).toBeNull();
  });

  it('is lit on the library and on the promote form', () => {
    for (const at of ['/admin/starters', '/admin/starters/promote']) {
      const rail = renderShell('operator', at);
      expect(
        within(rail).getByRole('link', { name: LABELS.navStarters }).getAttribute('aria-current'),
      ).toBe('page');
      cleanup();
    }
  });
});
