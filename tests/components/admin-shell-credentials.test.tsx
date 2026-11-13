// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PlatformRole } from '@/generated/prisma/client';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

/**
 * The console rail's CREDENTIALS row (MOTIR-9408, design MOTIR-11084): every
 * staff role sees it under Operations directly after Jobs, lit only on its page.
 */

let pathname = '/admin';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const { AdminShell } = await import('@/app/(admin)/_components/AdminShell');

const shell = en.platformAdmin.shell;
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
  navJobs: shell.navJobs,
  navCredentials: shell.navCredentials,
  navFleetSettings: shell.navFleetSettings,
  navFleetStatus: shell.navFleetStatus,
  navServices: shell.navServices,
  navCapacity: shell.navCapacity,
  navAiPlanning: 'AI planning',
  navPlanningLessons: 'Planning lessons',
  navPlannerFindings: 'Planner findings',
  navIdeas: shell.navIdeas,
  navStarters: shell.navStarters,
  navRunModels: 'Motir agent models',
  navAuditLog: 'Audit log',
  staffMarkTitle: 'Platform staff',
  staffMarkSubtitle: 'All reads audited',
  searchPlaceholder: 'Search the estate',
  footerStaff: 'Staff',
  exitToApp: 'Exit to app',
};

afterEach(cleanup);

function rail(role: PlatformRole, at: string) {
  pathname = at;
  render(
    <AdminShell operator={{ email: 'ops@moooon.net', role }} labels={LABELS}>
      <p>page</p>
    </AdminShell>,
  );
  return screen.getByRole('navigation', { name: 'Operator console' });
}

describe('the Credentials row', () => {
  it('is labelled from the catalogue, in en and zh', () => {
    expect(en.platformAdmin.shell.navCredentials).toBe('Credentials');
    expect(zh.platformAdmin.shell.navCredentials).toBe('凭据');
  });

  it.each(['support', 'operator', 'superadmin'] as const)(
    'is on the rail for %s, directly after Jobs',
    (role) => {
      const nav = rail(role, '/admin');
      const row = within(nav).getByRole('link', { name: LABELS.navCredentials });
      expect(row.getAttribute('href')).toBe('/admin/credentials');
      expect(row.getAttribute('aria-current')).toBeNull();
      const names = within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent?.trim());
      expect(names[names.indexOf(LABELS.navCredentials) - 1]).toBe(LABELS.navJobs);
    },
  );

  it('is lit on its page, and Jobs is not', () => {
    const nav = rail('support', '/admin/credentials');
    expect(
      within(nav).getByRole('link', { name: LABELS.navCredentials }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(nav).getByRole('link', { name: LABELS.navJobs }).getAttribute('aria-current'),
    ).toBeNull();
  });
});
