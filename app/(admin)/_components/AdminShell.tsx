'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BookOpen,
  Bot,
  Building2,
  Coins,
  Gauge,
  Layers,
  Lightbulb,
  LogOut,
  ScrollText,
  Search,
  Server,
  ServerCog,
  Shield,
  Sparkles,
  UserSearch,
  Workflow,
} from 'lucide-react';
import { Sidebar, type SidebarSection } from '@/components/ui/Sidebar';
import type { PlatformOperatorDTO } from '@/lib/dto/platform';

/**
 * The operator console shell — design `platform-admin/console.mock.html`
 * **Panel 2** (`.admin-nav` rail + `.adminbar` operator top bar), the frame
 * every console screen renders inside.
 *
 * Composed from the shipped primitives, per the asset's own "Primitives
 * composed (no hand-rolling)" section: `Sidebar` for the rail (brand header,
 * grouped rows — every one live now that the reserved Governance row became the
 * superadmin's Audit log (MOTIR-752) — the operator footer + "Exit to app"). No
 * bespoke admin CSS, and every
 * colour routes through `--el-*` — the tint-sky operator bar with an `--el-info`
 * rule and shield is the asset's colour-roles table, not a choice made here.
 *
 * The rail is FULL-HEIGHT beside the bar rather than under it, which is why
 * this does not compose `AppLayout`: `AppLayout` puts its `topNav` above BOTH
 * columns, and the asset draws the operator bar inside the main column only.
 * That is a deliberate difference from the tenant shell — the bar carries the
 * "all reads audited" marker, which belongs over the content it qualifies.
 *
 * Client-side only for `usePathname` (the active row) and the collapse store.
 * It receives an operator DTO — an email and a role — never a
 * `PlatformPrincipal`.
 */
export interface AdminShellLabels {
  brand: string;
  area: string;
  groupPlatform: string;
  groupOperations: string;
  navOverview: string;
  navUsage: string;
  navTenants: string;
  navUsers: string;
  navMonitoring: string;
  /** Operations → Jobs (MOTIR-9987), visible to every staff role. */
  navJobs: string;
  /** Operations → Fleet settings (MOTIR-8715), superadmin only. */
  navFleetSettings: string;
  /** Operations → Provider capacity (MOTIR-9614), visible to every staff role. */
  navCapacity: string;
  /** Operations → AI planning (MOTIR-7231), visible to every staff role. */
  navAiPlanning: string;
  navPlanningLessons: string;
  /** Operations → Ideas (MOTIR-7680), visible to every staff role. */
  navIdeas: string;
  /** Operations → Starters (MOTIR-712), operator and superadmin only. */
  navStarters: string;
  /** Operations → Hosted-run models (MOTIR-7528), visible to every staff role. */
  navRunModels: string;
  /** Operations → Audit log (MOTIR-752), superadmin only. */
  navAuditLog: string;
  staffMarkTitle: string;
  staffMarkSubtitle: string;
  searchPlaceholder: string;
  footerStaff: string;
  exitToApp: string;
}

export interface AdminShellProps {
  operator: PlatformOperatorDTO;
  labels: AdminShellLabels;
  children: ReactNode;
}

export function AdminShell({ operator, labels, children }: AdminShellProps) {
  const pathname = usePathname();

  // The rail's two groups, exactly as the asset draws them.
  //
  // ⚠️ Every destination except Overview is `disabled` + a version tag, and the
  // tag names the story that builds it. The asset draws Monitoring / Governance
  // that way already (10.2 / 10.3); this foundation extends the SAME grammar to
  // Usage & cost and Tenants, because it does not build those either —
  // MOTIR-732 and MOTIR-733 do, on top of MOTIR-730's cross-tenant read layer.
  // The alternative was a live row pointing at a route with no page, which
  // renders the app's 404 — a door that opens onto the "this does not exist"
  // answer the gate uses for a REFUSAL, from inside the console. Two different
  // things must not produce the same screen. The `Sidebar` primitive already
  // renders a disabled row as non-interactive with its state carried by the
  // badge rather than by colour alone.
  const sections: SidebarSection[] = [
    {
      id: 'platform',
      label: labels.groupPlatform,
      items: [
        {
          icon: <Activity />,
          label: labels.navOverview,
          href: '/admin',
          active: pathname === '/admin',
        },
        {
          icon: <Coins />,
          label: labels.navUsage,
          href: '/admin/usage',
          // LIVE since MOTIR-732: the estate's spend by category and model.
          active: pathname.startsWith('/admin/usage'),
        },
        // The TENANT hierarchy, LIVE at its org level since MOTIR-4566. The row
        // has pointed at `/admin/tenants` since this shell was written and was
        // badged `10.1` because nothing served it; the org lookup and the org
        // page now do, so the badge goes and the route is real.
        //
        // ⚠️ THE ROW IS THE ORG LEVEL ONLY. The workspace and project levels
        // BELOW an org are MOTIR-733's, and the org page draws them as reserved
        // regions rather than as content — the allocation the merged design
        // asset carries. A row that is live for one level and silent about the
        // rest is the honest shape: the alternative is a disabled row beside a
        // page that already exists.
        {
          icon: <Building2 />,
          label: labels.navTenants,
          href: '/admin/tenants',
          active: pathname.startsWith('/admin/tenants'),
        },
        // The USER lookup (MOTIR-1167) — Panel 9's door, and a LIVE row.
        //
        // ⚠️ It is a row of its own rather than the top bar's ⌘K box, which
        // stays inert. That box is Panel 3's ESTATE search: it groups results
        // into Organizations / Workspaces / Projects / Users, and three of those
        // four read tenant tables that have no `platform_staff` policy arm yet
        // (MOTIR-730 owns them). A ⌘K palette that silently answered one of its
        // four groups would be worse than one that says it is not wired.
        {
          icon: <UserSearch />,
          label: labels.navUsers,
          href: '/admin/users',
          active: pathname.startsWith('/admin/users'),
        },
      ],
    },
    {
      id: 'operations',
      label: labels.groupOperations,
      items: [
        {
          icon: <Server />,
          label: labels.navMonitoring,
          href: '/admin/monitoring',
          active: pathname === '/admin/monitoring',
        },
        // The platform job ledger (MOTIR-9987, design `platform-admin`
        // AMENDMENT 2026-10-28 § Jobs): directly after Monitoring, for every
        // staff role, lit on the page and below it.
        {
          icon: <Workflow />,
          label: labels.navJobs,
          href: '/admin/jobs',
          active: pathname === '/admin/jobs' || pathname.startsWith('/admin/jobs/'),
        },
        // The fleet's one WRITE beside its read surface (MOTIR-8715, design
        // `platform-admin` AMENDMENT 2026-10 § Fleet settings): directly after
        // Monitoring. It follows the Audit log row's rule, not Monitoring's —
        // `superadmin` only; for the other roles the row is absent and the route
        // 404s.
        ...(operator.role === 'superadmin'
          ? [
              {
                icon: <ServerCog />,
                label: labels.navFleetSettings,
                href: '/admin/fleet-settings',
                active: pathname === '/admin/fleet-settings',
              },
            ]
          : []),
        // Each provider model's usage against its limits (MOTIR-9614, design
        // `platform-admin` AMENDMENT 2026-10-25 § Provider capacity): after
        // Monitoring and after the superadmin's Fleet settings row. Every staff
        // role reads it; only the edits are gated.
        {
          icon: <Gauge />,
          label: labels.navCapacity,
          href: '/admin/capacity',
          active: pathname === '/admin/capacity',
        },
        {
          icon: <Sparkles />,
          label: labels.navAiPlanning,
          href: '/admin/ai-planning',
          active: pathname === '/admin/ai-planning',
        },
        // The platform's hosted-run model list (MOTIR-7528), directly after
        // AI planning (design `platform-admin` AMENDMENT 2026-10-04, Panel 5).
        {
          icon: <Bot />,
          label: labels.navRunModels,
          href: '/admin/run-models',
          active: pathname === '/admin/run-models',
        },
        // The planner's captured lessons across every organisation (MOTIR-1411,
        // design MOTIR-1409). `startsWith` so a lesson's detail keeps it lit.
        {
          icon: <BookOpen />,
          label: labels.navPlanningLessons,
          href: '/admin/planning-lessons',
          active: pathname.startsWith('/admin/planning-lessons'),
        },
        // The idea store motir.co shows under Ideas to build (MOTIR-7680, design
        // `platform-admin` § Ideas, MOTIR-7679), directly after Planning lessons:
        // both are curated content Motir's own staff keep. Every staff role reads
        // it; the writes on its detail are the operator's. `startsWith` so an
        // idea's detail keeps it lit.
        {
          icon: <Lightbulb />,
          label: labels.navIdeas,
          href: '/admin/ideas',
          active: pathname.startsWith('/admin/ideas'),
        },
        // The starter library (MOTIR-712, design `starter-library` §2.1, MOTIR-705),
        // directly after Ideas: another catalogue Motir's own staff keep. Operator
        // and superadmin only (R97) — for support the row is absent and the route
        // 404s. `startsWith` so the promote form keeps it lit.
        ...(operator.role === 'operator' || operator.role === 'superadmin'
          ? [
              {
                icon: <Layers />,
                label: labels.navStarters,
                href: '/admin/starters',
                active: pathname.startsWith('/admin/starters'),
              },
            ]
          : []),
        // The reserved `Governance · 10.3` row goes LIVE as the audit log
        // (design `platform-admin` AMENDMENT 2026-10-03 § 3, MOTIR-752). Every
        // other 10.3 write sits on the org or user page it targets; the log is
        // the one estate-wide surface. `superadmin` only — for the other roles
        // the row is absent and the route 404s (design § Roles).
        ...(operator.role === 'superadmin'
          ? [
              {
                icon: <ScrollText />,
                label: labels.navAuditLog,
                href: '/admin/audit-log',
                active: pathname.startsWith('/admin/audit-log'),
              },
            ]
          : []),
      ],
    },
  ];

  return (
    // `relative` for the reason in `components/ui/AppLayout.tsx` (MOTIR-3286):
    // a clipping box that is not a containing block does not clip an `absolute`
    // descendant that anchors to the INITIAL containing block, and such a
    // descendant lengthens the DOCUMENT instead. Same shell shape, same gap.
    //
    // `data-app-shell` for the same reason one level over (MOTIR-4230): this is
    // the second full-viewport opaque canvas in the tree, so it masks a style's
    // `body`-level atmosphere exactly as the signed-in shell did. Same shell
    // shape, same hook — a shell that opts out is a shell that goes flat.
    <div data-app-shell="" className="relative flex h-dvh overflow-hidden bg-(--el-page-bg)">
      <a
        href="#admin-main"
        className="sr-only z-[100] focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:rounded-(--radius-control) focus:bg-(--el-page-bg) focus:px-(--spacing-control-x-16) focus:py-(--spacing-control-y-8) focus:font-sans focus:text-sm focus:text-(--el-text) focus:shadow-(--shadow-elevated) focus:outline-none focus:ring-2 focus:ring-(--focus-ring-color)"
      >
        Skip to content
      </a>

      <div className="hidden w-[240px] shrink-0 md:block">
        <Sidebar
          aria-label={labels.area}
          collapsed={false}
          header={<AdminBrand brand={labels.brand} area={labels.area} />}
          sections={sections}
          footer={
            <AdminRailFooter
              operator={operator}
              staffLabel={labels.footerStaff}
              exitLabel={labels.exitToApp}
            />
          }
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <AdminTopBar
          operator={operator}
          markTitle={labels.staffMarkTitle}
          markSubtitle={labels.staffMarkSubtitle}
          searchPlaceholder={labels.searchPlaceholder}
        />
        <main
          id="admin-main"
          tabIndex={-1}
          className="relative min-h-0 flex-1 overflow-y-auto focus:outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/** The rail's brand header — the asset's `.brand` block. */
function AdminBrand({ brand, area }: { brand: string; area: string }) {
  return (
    <div className="flex items-center gap-2 px-(--spacing-control-x) py-(--spacing-control-y)">
      <span
        aria-hidden
        className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-text) font-sans text-sm font-semibold text-(--el-text-inverted)"
      >
        M
      </span>
      <span className="min-w-0">
        <span className="block truncate font-sans text-sm font-semibold text-(--el-text)">
          {brand}
        </span>
        <span className="block truncate font-sans text-xs text-(--el-text-secondary)">{area}</span>
      </span>
    </div>
  );
}

/** The rail footer — operator identity, then the door back out to the app. */
function AdminRailFooter({
  operator,
  staffLabel,
  exitLabel,
}: {
  operator: PlatformOperatorDTO;
  staffLabel: string;
  exitLabel: string;
}) {
  const initials = operator.email.trim().slice(0, 2).toUpperCase();
  return (
    <div className="flex flex-col gap-1 border-t border-(--el-sidebar-border) pt-3">
      <div className="flex items-center gap-2 px-(--spacing-control-x) py-(--spacing-control-y)">
        <span
          aria-hidden
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-(--el-tint-sky) font-sans text-[11px] font-semibold text-(--el-text-strong)"
        >
          {initials}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-sans text-xs font-medium text-(--el-text)">
            {staffLabel}
          </span>
          <span className="block truncate font-sans text-xs text-(--el-text-secondary)">
            {operator.email}
          </span>
        </span>
      </div>
      <Link
        href="/"
        className="flex h-(--height-control) items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) font-sans text-sm text-(--el-text-secondary) transition-colors hover:bg-(--el-sidebar-item-bg-hover) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <LogOut aria-hidden className="h-[18px] w-[18px] shrink-0 text-(--el-icon-muted)" />
        {exitLabel}
      </Link>
    </div>
  );
}

/**
 * The operator top bar — the asset's `.adminbar`.
 *
 * `--el-tint-sky` ground with an `--el-info` bottom rule and shield, per the
 * asset's colour-roles table. Ink is `--el-text-strong` throughout: on a tint,
 * `--el-text-muted` fails AA (CLAUDE.md's measured pair table), and the marker
 * is the one thing on this bar that must be readable on every screen.
 *
 * ⚠️ THE SEARCH BOX IS INERT IN THIS BUILD, and says so rather than pretending.
 * The asset draws it on every console screen (Panel 3), but the estate search it
 * calls reads ACROSS TENANTS — which is MOTIR-730's read layer and MOTIR-731's
 * surface, and which this card's acceptance criteria forbid. Rendering a live
 * box over a search that cannot run would be the worse half of both options. It
 * carries `disabled` + `aria-disabled`, so it reads as a designed-for control
 * that is not yet wired — the same disposition the rail's reserved 10.2 / 10.3
 * rows take, in the vocabulary the design already established for them.
 */
function AdminTopBar({
  operator,
  markTitle,
  markSubtitle,
  searchPlaceholder,
}: {
  operator: PlatformOperatorDTO;
  markTitle: string;
  markSubtitle: string;
  searchPlaceholder: string;
}) {
  const initials = operator.email.trim().slice(0, 2).toUpperCase();
  return (
    <div className="flex shrink-0 items-center gap-4 border-b-2 border-(--el-info) bg-(--el-tint-sky) px-4 py-2">
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-page-bg) text-(--el-info)"
        >
          <Shield className="h-4 w-4" />
        </span>
        <span className="leading-tight">
          <span className="block font-sans text-xs font-semibold text-(--el-text-strong)">
            {markTitle}
          </span>
          <span className="block font-sans text-[11px] text-(--el-text-strong)">
            {markSubtitle}
          </span>
        </span>
      </span>

      <button
        type="button"
        disabled
        aria-disabled
        className="flex h-(--height-control) min-w-0 flex-1 items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) text-left font-sans text-sm text-(--el-text-muted) disabled:pointer-events-none"
      >
        <Search aria-hidden className="h-4 w-4 shrink-0 text-(--el-text-faint)" />
        <span className="truncate">{searchPlaceholder}</span>
        <kbd className="ml-auto shrink-0 rounded-(--radius-kbd) border border-(--el-border) bg-(--el-surface) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[10px] text-(--el-text-secondary)">
          ⌘K
        </kbd>
      </button>

      <span
        aria-hidden
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-(--el-page-bg) font-sans text-[11px] font-semibold text-(--el-text-strong)"
      >
        {initials}
      </span>
    </div>
  );
}
