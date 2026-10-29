import { type ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { toPlatformOperatorDTO } from '@/lib/mappers/platformMappers';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { assertTwoFactorCompliance } from '@/lib/auth/twoFactorGate';
import { AdminShell } from './_components/AdminShell';

/**
 * The platform-admin route group — `docs/decisions/platform-staff-auth.md` §4.
 *
 * A sibling of `(authed)` / `(auth)` / `(public)` / `(onboarding)` /
 * `(onboarding)`, inside motir-core, because the console reuses the shipped auth,
 * the app shell, the design system and the `--el-*` / shape tokens (design
 * `console.mock.html` composes them with no bespoke admin CSS). It is operator
 * UI over motir-core's own data and holds no metering, so nothing about it
 * belongs on the closed side (Principle #19).
 *
 * ⚠️ THE GATE IS HERE, AND IT ANSWERS 404. This layout is the single choke
 * point for every page in the group: it resolves the platform principal before
 * rendering anything, and calls `notFound()` when there is none. A non-staff
 * principal — INCLUDING a workspace owner and an org owner — gets the ordinary
 * app 404, indistinguishable from a route that does not exist. There is no 403,
 * no "forbidden" body, no redirect, and no log line naming `/admin`.
 *
 * ⚠️ AND `/admin` IS DELIBERATELY ABSENT FROM `proxy.ts`'s matcher (ADR §2).
 * The proxy's optimistic check REDIRECTS a cookie-less request to
 * `/sign-in?next=<path>` — a response visibly different from an unknown path's
 * 404, and therefore a proof that `/admin` is real. An anonymous request must
 * instead reach this layout and be answered here. This is the one place where
 * following the established authed-route pattern would break the posture. It
 * costs nothing: the session read below is the same one every authed page
 * already makes.
 *
 * ⚠️ A LAYOUT DOES NOT PROTECT A ROUTE HANDLER. Every `app/api/admin/**`
 * handler calls `requirePlatformStaff()` itself, and so does every
 * platform-scoped service method (§2's two-layer rule). This gate protects the
 * PAGES; it is not the only assertion.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const principal = await requirePlatformStaffPage();

  // The 2FA enforcement gate (MOTIR-3648) — after the staff gate, before the
  // audit write and before any tenant-scoped read.
  //
  // ⚠️ PLATFORM STAFF ARE NOT EXEMPT, and that is the decision rather than an
  // oversight: this console reaches every tenant's data, so it is the LAST place
  // a second factor should be optional. The exemption list in `twoFactorGate.ts`
  // names surfaces that RESOLVE the hold, and nothing here does.
  await assertTwoFactorCompliance(principal.userId);

  // Entering the console IS an audited event — the first question a SOC-2-style
  // reviewer asks the trail is who was in it, and when. One row per admin page
  // view, written inside the platform transaction that binds
  // `app.platform_staff` (the audit row is subject to the gate it records).
  await platformAuditService.record(principal, {
    action: 'console.open',
    targetKind: 'platform',
  });

  const t = await getTranslations('platformAdmin');

  return (
    <AdminShell
      operator={toPlatformOperatorDTO(principal)}
      labels={{
        brand: t('shell.brand'),
        area: t('shell.area'),
        groupPlatform: t('shell.groupPlatform'),
        groupOperations: t('shell.groupOperations'),
        navOverview: t('nav.overview'),
        navUsage: t('nav.usage'),
        navTenants: t('nav.tenants'),
        navUsers: t('nav.users'),
        navMonitoring: t('nav.monitoring'),
        navJobs: t('shell.navJobs'),
        navFleetSettings: t('shell.navFleetSettings'),
        navCapacity: t('shell.navCapacity'),
        navAiPlanning: t('shell.navAiPlanning'),
        navPlanningLessons: t('shell.navPlanningLessons'),
        navIdeas: t('shell.navIdeas'),
        navStarters: t('shell.navStarters'),
        navRunModels: t('shell.navRunModels'),
        navAuditLog: t('nav.auditLog'),
        staffMarkTitle: t('topBar.staffMark'),
        staffMarkSubtitle: t('topBar.allReadsAudited'),
        searchPlaceholder: t('topBar.searchPlaceholder'),
        footerStaff: t('shell.footerStaff'),
        exitToApp: t('shell.exitToApp'),
      }}
    >
      {children}
    </AdminShell>
  );
}
