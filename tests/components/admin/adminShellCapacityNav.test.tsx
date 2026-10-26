// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PlatformRole } from '@/generated/prisma/client';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

/**
 * The console rail's PROVIDER CAPACITY row (MOTIR-9614, design `platform-admin`
 * AMENDMENT 2026-10-25 § The door and who sees what): every staff role sees it
 * under Operations, after Monitoring and after the superadmin's Fleet settings.
 */

let pathname = '/admin';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const { AdminShell } = await import('@/app/(admin)/_components/AdminShell');

const shell = en.platformAdmin.shell;
const LABELS = {
  brand: shell.brand,
  area: 'Operator console',
  groupPlatform: shell.groupPlatform,
  groupOperations: shell.groupOperations,
  navOverview: en.platformAdmin.nav.overview,
  navUsage: en.platformAdmin.nav.usage,
  navTenants: en.platformAdmin.nav.tenants,
  navUsers: en.platformAdmin.nav.users,
  navMonitoring: en.platformAdmin.nav.monitoring,
  navFleetSettings: shell.navFleetSettings,
  navCapacity: shell.navCapacity,
  navAiPlanning: shell.navAiPlanning,
  navPlanningLessons: shell.navPlanningLessons,
  navIdeas: shell.navIdeas,
  navRunModels: shell.navRunModels,
  navAuditLog: en.platformAdmin.nav.auditLog,
  staffMarkTitle: 'Platform staff',
  staffMarkSubtitle: 'All reads audited',
  searchPlaceholder: 'Search the estate',
  footerStaff: shell.footerStaff,
  exitToApp: shell.exitToApp,
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

describe('the Provider capacity row', () => {
  it('is labelled from the catalogue, in en and zh', () => {
    expect(en.platformAdmin.shell.navCapacity).toBe('Provider capacity');
    expect(zh.platformAdmin.shell.navCapacity).toBe('服务商容量');
  });

  it.each([
    ['support', LABELS.navMonitoring],
    ['operator', LABELS.navMonitoring],
    ['superadmin', LABELS.navFleetSettings],
  ] as const)('is on the rail for %s, directly after %s', (role, before) => {
    const nav = rail(role, '/admin');
    const row = within(nav).getByRole('link', { name: LABELS.navCapacity });
    expect(row.getAttribute('href')).toBe('/admin/capacity');
    expect(row.getAttribute('aria-current')).toBeNull();
    const names = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent?.trim());
    expect(names[names.indexOf(LABELS.navCapacity) - 1]).toBe(before);
    expect(names[names.indexOf(LABELS.navCapacity) + 1]).toBe(LABELS.navAiPlanning);
  });

  it('is lit on its page, and Monitoring is not', () => {
    const nav = rail('support', '/admin/capacity');
    expect(
      within(nav).getByRole('link', { name: LABELS.navCapacity }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(nav).getByRole('link', { name: LABELS.navMonitoring }).getAttribute('aria-current'),
    ).toBeNull();
  });
});
