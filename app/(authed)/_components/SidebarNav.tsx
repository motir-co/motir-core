'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  CircleDot,
  CirclePlay,
  Code,
  Columns3,
  History,
  House,
  Inbox,
  LayoutDashboard,
  LayoutList,
  Map,
  NotebookText,
  Settings,
  Sparkles,
  Waypoints,
  SquareTerminal,
  Stamp,
} from 'lucide-react';
import { Sidebar, type SidebarItem, type SidebarSection } from '@/components/ui/Sidebar';
import { ONBOARDING_RESUME_PATH } from '@/lib/onboarding/resumeVisibility';
import { useOnboardingResume } from './OnboardingResumeProvider';
import { SidebarToggle } from '@/components/ui/SidebarToggle';
import { useSidebarCollapsed } from '@/lib/hooks/useSidebarCollapsed';
import type { ProjectDTO } from '@/lib/dto/projects';
import {
  groupSettingsNav,
  isProjectSettingsPath,
  isSettingsEntryActive,
  PROJECT_SETTINGS_NAV,
  toSettingsNavPermissions,
  visibleSettingsNav,
} from '@/lib/settings/projectSettingsNav';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { canOfferNavDestination } from '@/lib/settings/projectNavAccess';
import {
  ACCOUNT_SETTINGS_NAV,
  groupAccountSettingsNav,
  isAccountSettingsEntryActive,
  isAccountSettingsPath,
} from '@/lib/settings/accountSettingsNav';
import {
  groupOrganizationSettingsNav,
  isOrganizationSettingsEntryActive,
  isOrganizationSettingsPath,
  visibleOrganizationSettingsNav,
} from '@/lib/settings/organizationSettingsNav';
import { SettingsSidebarHeader } from './SettingsSidebarHeader';
import {
  groupWorkspaceSettingsNav,
  isWorkspaceSettingsEntryActive,
  isWorkspaceSettingsPath,
  visibleWorkspaceSettingsNav,
} from '@/lib/settings/workspaceSettingsNav';
import { AccountSidebarHeader } from './AccountSidebarHeader';
import { OrganizationSidebarHeader } from './OrganizationSidebarHeader';
import { WorkspaceSidebarHeader } from './WorkspaceSidebarHeader';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The signed-in navigation rail. Composes the 1.5.2 Sidebar primitive with the
// route-aware nav sections — and, in the settings and account AREAS, that
// area's own header. The DEFAULT area has no header: the project context it
// used to hold is the top bar's context path since MOTIR-2556. Active
// detection is client-side (usePathname), which is why the whole rail is a
// client component rather than the layout building <Sidebar sections={…} />
// directly — section `active` flags can't be computed in the server layout.
//
// Section shape (PRODECT_FINDINGS #29):
//   - active project (archived or not) → primary [Dashboard, Issues, Boards,
//     Reports] + bottom [Settings → /settings/project, Security, Job runs,
//     Git]. The project-scoped nav stays visible even when archived (#29.2);
//     the stub pages render the "this project is archived" empty state
//     themselves. Docs and Legal documents left this section for the Help
//     menu in the footer (MOTIR-4239).
//   - no project (#29.1) → only the bottom section, with Settings deep-
//     linking to the WORKSPACE settings (there's no project to configure).
//
// #29's THIRD state — the create-first CTA — is no longer here: it moved with
// the project control into the bar's project tier (`ProjectTier`), which is
// also where the archived pill and the switcher went.
//
// Settings AREA swap (Story 6.5 · Subtask 6.5.2): when the route is inside the
// project-settings area (`/settings/project*`) and a project is active, the rail
// REPLACES the project nav with the grouped settings nav rendered FROM the
// `projectSettingsNav` registry (filtered by the actor's permission set) and
// swaps the header for the SettingsSidebarHeader (back-to-project + identity).
// This is the design's "same rail" decision — one rail, no double chrome — which
// the App Router forces into THIS component (the rail lives here, not in a
// nested layout under <main>). The drawer variant inherits the swap for free.
//
// Two variants: `rail` (the persistent desktop rail, follows the shared
// collapse store, carries the footer collapse toggle) and `drawer` (the
// <md off-canvas body, always expanded, no footer — the drawer chrome owns
// its own close affordance).

export interface SidebarNavProps {
  activeProject: ProjectDTO | null;
  variant?: 'rail' | 'drawer';
  /**
   * The actor's resolved permission keys for the active project (Subtask
   * MOTIR-2468), resolved once in the (authed) layout. Drives BOTH the
   * settings-nav registry's per-entry filter when the rail is in the
   * project-settings area AND whether the bottom nav renders the Project
   * settings door at all. Omitted when there is no active project; an absent
   * value defaults CLOSED, so a missing prop never leaks an entry or a door.
   */
  settingsPermissions?: readonly PermissionKey[];
  /**
   * The signed-in user's identity (Subtask 7.8.12) — drives the account-settings
   * area rail header (initial avatar + name + email) when the rail is inside the
   * `/settings/account*` area. Resolved once in the (authed) layout from the
   * session (the same `{ name, email }` the TopNav user menu shows).
   */
  user: { name: string; email: string };
  /**
   * The ACTIVE ORGANISATION (Story MOTIR-4669 · MOTIR-4710) — its name for the
   * organisation-settings area rail header, and whether the actor administers it
   * for the registry's row filter. Resolved once in the (authed) layout, from the
   * same `resolveActiveOrganization` call the top bar's org control already makes.
   *
   * ⚠️ ABSENT DEFAULTS CLOSED, exactly as `settingsPermissions` does: with no
   * organisation the area rail renders its General group alone rather than
   * revealing four admin rows to a caller that forgot to thread the prop.
   */
  organization?: { name: string; isOrgAdmin: boolean } | null;
  /**
   * The ACTIVE workspace (Story MOTIR-4843 · MOTIR-4846) — drives the
   * workspace-settings area's rail header, which names the tenant that area
   * configures, exactly as `organization` drives the organisation area's.
   *
   * Optional and nullable for the same reason `organization` is: the rail
   * renders with no workspace context on the cold-start paths, and the branch
   * below simply omits the header rather than refusing to render the rail.
   */
  workspace?: { name: string } | null;
  /**
   * Whether this build has the commercial surface (`isCloudBilling()`) — gates
   * the organisation nav's `Billing & plans` row, which `notFound()`s off cloud.
   * The SAME predicate the org menu already gates its own Billing row on, so the
   * two doors onto that page cannot disagree about whether it exists.
   */
  billingAvailable?: boolean;
  /**
   * The active org reveals the WORKSPACE tier (≥2 workspaces the viewer belongs
   * to — `lib/workspaces/tierDisclosure.ts`). Retargets the no-project settings
   * door: `/settings/workspace` above the threshold, `/settings/organization`
   * at or below it, where that page hosts the folded-in workspace sections
   * (`docs/decisions/organization-tier.md` §6d).
   *
   * The Job runs and Git rows below are NOT gated on this and must not be: they
   * are workspace-SCOPED but not workspace-NAMED, and §6 reveals a tier rather
   * than relocating every page beneath it.
   *
   * Defaults FALSE — an omitted prop points the door at the home that exists at
   * every count, so a caller that forgets to thread it fails closed.
   */
  workspaceTierRevealed?: boolean;
  /**
   * Whether public projects exist on this BUILD (`isCloud()`, MOTIR-3908) —
   * resolved on the server in `app/(authed)/layout.tsx`, where `MOTIR_CLOUD`
   * lives, and threaded here because this is a client component.
   *
   * The settings registry's second axis (MOTIR-4243): it drops every
   * `cloudOnly` entry — today the **Public page** room — so a self-hosted rail
   * never offers a row whose route answers 404.
   *
   * Defaults FALSE, like `workspaceTierRevealed` above and for the same reason:
   * a caller that forgets to thread it hides a room rather than promising one.
   */
  publicProjectsAvailable?: boolean;
  /**
   * Whether this build runs hosted agents (`isHostedRunsAvailable()`, MOTIR-6995)
   * — the registry's `hostedRunsAvailable` axis, which drops the **Hosted agent**
   * room off a build without them. Defaults FALSE, like the flag above.
   */
  hostedRunsAvailable?: boolean;
  /**
   * Whether the active project holds a repository Motir hosts (MOTIR-9966) — the
   * registry's project axis, which drops the **Environment** room from a project
   * holding only customer repositories. Defaults FALSE, like the flags above.
   */
  motirRepositoriesPresent?: boolean;
  /**
   * The Help control for the rail's FOOTER (MOTIR-4239) — a ready-made
   * `<HelpMenu placement="footer" />`, built by the layout so this component
   * stays agnostic of `docsIndexUrl` / `legalIndexUrl` (the Docs and Legal
   * rows left this file's own bottom section for that menu). Rendered only
   * when `!isDrawer`: the drawer has no footer slot, and the drawer's own
   * trigger is a separate `<HelpMenu placement="drawer" />` the layout mounts
   * directly in `SidebarDrawer`'s utility strip.
   */
  helpMenu?: ReactNode;
}

function isActive(pathname: string, match: string): boolean {
  return pathname === match || pathname.startsWith(`${match}/`);
}

/** The "Resume onboarding" row's in-progress indicator (MOTIR-1533). A compact
 *  accent dot — a text chip would truncate the 17-char label at the 240px rail
 *  width — with a visually-hidden label so the state reaches assistive tech by
 *  text, not colour alone (finding #35). */
function ResumeInProgressBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center">
      <span className="sr-only">{label}</span>
      <span aria-hidden className="h-2 w-2 rounded-full bg-(--el-accent)" />
    </span>
  );
}

export function SidebarNav({
  activeProject,
  variant = 'rail',
  settingsPermissions,
  user,
  organization = null,
  billingAvailable = false,
  workspace = null,
  workspaceTierRevealed = false,
  publicProjectsAvailable = false,
  hostedRunsAvailable = false,
  motirRepositoriesPresent = false,
  helpMenu,
}: SidebarNavProps) {
  const t = useTranslations('shell');
  const ts = useTranslations('settings');
  const pathname = usePathname();
  const [storeCollapsed] = useSidebarCollapsed();
  // The "Resume onboarding" signal (MOTIR-1533) — read unconditionally (before
  // the settings/account early returns) to respect the rules of hooks.
  const canResume = useOnboardingResume();
  const isDrawer = variant === 'drawer';
  // The drawer always renders expanded; the rail follows the shared store.
  const collapsed = isDrawer ? false : storeCollapsed;
  // The footer, shared by all three areas (default / settings / account) this
  // component can render (MOTIR-4239): the Help trigger leading, the collapse
  // toggle keeping the trailing edge it had alone before — a row at full width,
  // stacked and centred once the collapsed rail has no room for two controls
  // side by side. The drawer has no footer at all; its own Help trigger is a
  // separate `<HelpMenu placement="drawer" />` the layout mounts directly in
  // the utility strip.
  const footer = isDrawer ? undefined : (
    <div
      className={
        collapsed ? 'flex flex-col items-center gap-0.5' : 'flex items-center justify-between'
      }
    >
      {helpMenu}
      <SidebarToggle variant="footer" />
    </div>
  );

  // The actor's keys in membership-test form, used by BOTH the settings-area
  // rail below and the bottom nav's Project settings door. Built once, before
  // the two early returns, so the door and the rows it opens onto can never
  // disagree about what the area contains.
  const held = toSettingsNavPermissions(settingsPermissions);
  // The registry's SECOND axis (MOTIR-4243) — what this BUILD has, beside what
  // this actor holds. Built here with `held`, for the same reason: the rail and
  // the area door must filter on one answer, not two.
  const availability = { publicProjectsAvailable, hostedRunsAvailable, motirRepositoriesPresent };

  // WORKSPACE-settings AREA (Story MOTIR-4843 · MOTIR-4846): the FOURTH and last
  // settings tier to become an area. Like the account and organisation branches
  // it does NOT gate on an active project — a workspace is configured with no
  // project selected — and the header names the WORKSPACE.
  //
  // ⚠️ ITS ONE FILTER AXIS IS THE REVEAL, AND BELOW IT THE RAIL IS EMPTY. All
  // three routes `notFound()` below the threshold and their capabilities are
  // hosted on `/settings/organization`, gated per SECTION (§6d) — so the honest
  // rendering here is NO rows, not fewer. `visibleWorkspaceSettingsNav` returns
  // an empty list and `groupWorkspaceSettingsNav` drops every group with it, so
  // nothing marks the gap: no empty heading, no disabled row.
  if (isWorkspaceSettingsPath(pathname)) {
    const workspaceSections: SidebarSection[] = groupWorkspaceSettingsNav(
      visibleWorkspaceSettingsNav(workspaceTierRevealed, undefined, availability),
    ).map(({ group, entries }) => ({
      id: `workspace-settings-${group}`,
      label: ts(`workspace.nav.group.${group}`),
      items: entries.map((entry) => ({
        icon: <entry.icon />,
        label: ts(`workspace.nav.${entry.labelKey}`),
        href: entry.href,
        active: isWorkspaceSettingsEntryActive(entry, pathname),
      })),
    }));
    return (
      <Sidebar
        aria-label={ts('workspace.eyebrow')}
        header={
          workspace ? (
            <WorkspaceSidebarHeader workspace={workspace} collapsed={collapsed} />
          ) : undefined
        }
        sections={workspaceSections}
        footer={footer}
        collapsed={isDrawer ? false : undefined}
      />
    );
  }

  // ORGANISATION-settings AREA (Story MOTIR-4669 · MOTIR-4710): the third and
  // last settings tier to become an area. Like the account branch it does NOT
  // gate on an active project — an organisation is configured with no project
  // selected, and the rail's own bottom `Settings` row points here in exactly
  // that state — and the header names the ORGANISATION rather than the project
  // or the user.
  //
  // ⚠️ THE ROW FILTER IS NOT THE PAGE'S GATE. `organization-tier.md` §6d gates
  // this area PER SECTION, because below the workspace-tier reveal the index page
  // hosts two tiers' sections; the registry decides which ROWS exist and the
  // index page keeps its own per-section treatment untouched. That is why
  // `organization` (the index row) carries no admin flag: it is the only route to
  // the folded-in workspace sections, and Leave workspace has no other surface
  // anywhere in the product.
  if (isOrganizationSettingsPath(pathname)) {
    const orgSections: SidebarSection[] = groupOrganizationSettingsNav(
      visibleOrganizationSettingsNav(
        { isOrgAdmin: organization?.isOrgAdmin ?? false, workspaceTierRevealed },
        undefined,
        { billingAvailable },
      ),
    ).map(({ group, entries }) => ({
      id: `org-settings-${group}`,
      label: ts(`organization.nav.group.${group}`),
      items: entries.map((entry) => ({
        icon: <entry.icon />,
        label: ts(`organization.nav.${entry.labelKey}`),
        href: entry.href,
        active: isOrganizationSettingsEntryActive(entry, pathname),
      })),
    }));
    return (
      <Sidebar
        aria-label={ts('organization.eyebrow')}
        header={
          organization ? (
            <OrganizationSidebarHeader organization={organization} collapsed={collapsed} />
          ) : undefined
        }
        sections={orgSections}
        footer={footer}
        collapsed={isDrawer ? false : undefined}
      />
    );
  }

  // Account-settings AREA (Subtask 7.8.12): swap the project nav for the
  // registry-driven account-settings nav. Unlike the project area this does NOT
  // gate on an active project — account settings are personal, reachable with no
  // project selected — and the header shows the USER, not the project.
  if (isAccountSettingsPath(pathname)) {
    const accountSections: SidebarSection[] = groupAccountSettingsNav(ACCOUNT_SETTINGS_NAV).map(
      ({ group, entries }) => ({
        id: `account-settings-${group}`,
        label: ts(`account.nav.group.${group}`),
        items: entries.map((entry) => ({
          icon: <entry.icon />,
          label: ts(`account.nav.${entry.labelKey}`),
          href: entry.href,
          active: isAccountSettingsEntryActive(entry, pathname),
        })),
      }),
    );
    return (
      <Sidebar
        aria-label={ts('account.eyebrow')}
        header={<AccountSidebarHeader user={user} collapsed={collapsed} />}
        sections={accountSections}
        footer={footer}
        collapsed={isDrawer ? false : undefined}
      />
    );
  }

  // Settings AREA: swap the project nav for the registry-driven settings nav.
  if (activeProject && isProjectSettingsPath(pathname)) {
    const settingsSections: SidebarSection[] = groupSettingsNav(
      visibleSettingsNav(held, PROJECT_SETTINGS_NAV, availability),
    ).map(({ group, entries }) => ({
      id: `settings-${group}`,
      label: ts(`nav.group.${group}`),
      items: entries.map((entry) => ({
        icon: <entry.icon />,
        label: ts(entry.labelKey),
        href: entry.href,
        active: isSettingsEntryActive(entry, pathname),
      })),
    }));
    return (
      <Sidebar
        aria-label={ts('nav.eyebrow')}
        header={<SettingsSidebarHeader activeProject={activeProject} collapsed={collapsed} />}
        sections={settingsSections}
        footer={footer}
        collapsed={isDrawer ? false : undefined}
      />
    );
  }

  const sections: SidebarSection[] = [];

  // ⚠️ NO LONGER GATED (MOTIR-4873). This was `if (hasProject)`; every member is
  // inside a project (MOTIR-4870), so the primary section always renders and
  // the rail never collapses to its bottom section.
  {
    const primaryItems: SidebarItem[] = [
      {
        // The signed-in landing surface (Story MOTIR-2649 · MOTIR-2654,
        // renamed by MOTIR-4777 · MOTIR-4782, `design/workbench/` Panel A) —
        // the FIRST primary entry, because it is where signing in lands and
        // where a reader goes to ask "what am I doing, and what have I just
        // done". `/dashboard` keeps its route AND a row of its own: nothing is
        // re-homed. (This clause named Dashboard as the row directly below
        // until MOTIR-4799 demoted it under Backlog; the Workbench still leads
        // the rail, which is the half that was load-bearing.)
        //
        // ⚠️ PROJECT-scoped, like every row under it (MOTIR-2761) — which is
        // why this section is the ONLY place it is rendered. It used to be
        // workspace-scoped and carried a duplicate row in the no-project block
        // below; both are gone.
        icon: <House />,
        label: t('nav.workbench'),
        href: AUTHED_LANDING_PATH,
        active: isActive(pathname, AUTHED_LANDING_PATH),
      },
      {
        icon: <CircleDot />,
        label: t('nav.issues'),
        href: '/items',
        active: isActive(pathname, '/items'),
      },
      {
        // PAGES (Story MOTIR-5752 · MOTIR-7300) — the project's written pages, a
        // top-level project view and so a primary entry, per
        // `design/pages/design-notes.md` § THE ACCESS PATH. It sits directly after
        // Work Items: work items are the work and pages are what is written about
        // it, and they are the two surfaces that share the project's folder system
        // (MOTIR-5753). It sits ABOVE Ready → Runs → My agents so that run of rows
        // still reads as one flow. The glyph is `NotebookText`, unused elsewhere —
        // not `FileText`, which is the `content` work-item type's glyph, and not
        // `BookOpen` (the Help menu's Docs) or `NotebookPen` (AI planning
        // settings). Offered on `page:view` (`projectNavAccess.ts`), so a viewer
        // keeps it.
        icon: <NotebookText />,
        label: t('nav.pages'),
        href: '/pages',
        active: isActive(pathname, '/pages'),
      },
      {
        // The AI dispatch surface (Subtask 7.0.6) — sits BETWEEN Issues and
        // Boards. `CirclePlay` (run/dispatch) is the 7.0.1-locked glyph (Zap
        // is taken by the epic issue type). No count badge: the readiness set
        // is a computed predicate that scanned on EVERY authed route, so the
        // count is resolved only when you land on /ready (MOTIR-1284).
        icon: <CirclePlay />,
        label: t('nav.ready'),
        href: '/ready',
        active: isActive(pathname, '/ready'),
      },
      {
        // The RUNS index (Story MOTIR-1789 / MOTIR-3923) — its own primary nav
        // entry, per `design/runs/design-notes.md` § THE ACCESS PATH: every
        // top-level project view here is a primary entry, and a runs index is a
        // peer of those. It sits directly after Ready because "Ready is where
        // you dispatch, Runs is where you watch". The glyph is `Waypoints` — a
        // path through ordered nodes, which is what a run over a SET is — chosen
        // because `CirclePlay` is Ready's, `Zap` is the epic issue type's,
        // `Code` is the Code room's and `History` is Resume onboarding's.
        // (`Activity` was Code health's until MOTIR-4643 freed it.)
        icon: <Waypoints />,
        label: t('nav.runs'),
        href: '/runs',
        active: isActive(pathname, '/runs'),
      },
      {
        // MY AGENTS (Story MOTIR-6860 · MOTIR-6874) — the reader's own agent
        // instances, directly after Runs per `design/my-agents/design-notes.md`
        // panel 0: Runs is where an agent works on a card, My agents is where your
        // own agents live. `SquareTerminal` — a terminal in a frame — is unused
        // elsewhere; not `Bot` (the run area's agent mark). Offered only to a
        // reader holding `instance:use` (`projectNavAccess.ts`).
        icon: <SquareTerminal />,
        label: t('nav.myAgents'),
        href: '/my-agents',
        active: isActive(pathname, '/my-agents'),
      },
      {
        icon: <Columns3 />,
        label: t('nav.boards'),
        href: '/boards',
        active: isActive(pathname, '/boards'),
      },
      {
        // The persistent project Roadmap view (Subtask 7.20.5 / MOTIR-1011) —
        // its own primary nav entry (the access path, per the ai-planning
        // design §5 "drawn beside the other project nav surfaces"; NOT a
        // Board↔Roadmap toggle). The folded-map glyph matches the roadmap
        // design's view icon. Sits after Boards, as a sibling work view.
        icon: <Map />,
        label: t('nav.roadmap'),
        href: '/roadmap',
        active: isActive(pathname, '/roadmap'),
      },
      {
        // The AI Plans index (Story 7.21 · Subtask 7.21.1 / MOTIR-1338) — the
        // list of every AI-generated plan (proposal bundle) for the project,
        // from which the user reviews + approves/declines one. The access path
        // per the ai-planning design §5 (a planning surface reached from a
        // left-nav entry beside the other project nav surfaces). `Sparkles` is
        // the Motir-AI mark the shipped `PlanWithAILauncher` already uses. Sits
        // beside Roadmap, the adjacent planning surface.
        icon: <Sparkles />,
        label: t('nav.plans'),
        href: '/plans',
        active: isActive(pathname, '/plans'),
      },
      {
        // The backlog / sprint-planning surface (Subtask 4.2.3), with the
        // layout-list glyph (4.2.1 design notes). It sits after Plans and, since
        // MOTIR-4799, immediately before Dashboard — the line here read "between
        // Boards and Reports" until then, which had already stopped being true
        // when Roadmap, Plans and Triage arrived between the two.
        icon: <LayoutList />,
        label: t('nav.backlog'),
        href: '/backlog',
        active: isActive(pathname, '/backlog'),
      },
      {
        // ⚠️ DEMOTED here from second place, below Backlog (MOTIR-4799). Yue:
        // "move the Dashboard nav item all the way down after Backlog in the
        // left nav, the reason is dashboard is not important" — a product
        // judgement, recorded so the next reader knows this position was DECIDED
        // rather than inherited. The row sat directly under Home from the day
        // MOTIR-2654 added Home above it, which encoded the opposite claim: that
        // Dashboard is the second thing a reader wants. `/dashboard` keeps its
        // route and its row; only the position moved.
        //
        // The ordered list is asserted in
        // `tests/components/SidebarNav-primary-order.test.tsx`, off the rendered
        // rail — before that file this array's order was decided in comments and
        // checked nowhere.
        icon: <LayoutDashboard />,
        label: t('nav.dashboard'),
        href: '/dashboard',
        active: isActive(pathname, '/dashboard'),
      },
      {
        // The incoming-work front door (Story 6.11 · Subtask 6.11.6) — the
        // inbox of un-acted-on bug reports & feature requests. `Inbox` is the
        // 6.11 design-notes glyph; sits after Dashboard (it followed Backlog
        // directly until MOTIR-4799 moved Dashboard between them). Called
        // Triage, at `/triage`: MOTIR-6772 renamed it Requested features and
        // MOTIR-7043 renamed it back — the Visitor's view of the same requests
        // keeps that name (`docs/decisions/public-request-board-retired.md`
        // Decision 4, AMENDMENT 1).
        icon: <Inbox />,
        label: t('nav.triage'),
        href: '/triage',
        active: isActive(pathname, '/triage'),
      },
      {
        icon: <BarChart3 />,
        label: t('nav.reports'),
        href: '/reports',
        active: isActive(pathname, '/reports'),
      },
      {
        // Approval records (Story MOTIR-5299 · MOTIR-5302) — every approval record
        // the reader may see, pending first then decided. Placed after Reports
        // on `design/approvals/design-notes.md` § The ENTRANCE's argument: beside
        // the Workbench it would read as a second queue, and the Workbench's To
        // approve tab already is that queue; down here it reads as a record you
        // consult. `Stamp` is unused elsewhere — `Inbox`, `ClipboardCheck` and
        // `ShieldCheck` each already point at another surface. No badge: the
        // Workbench strip already counts what waits on you.
        icon: <Stamp />,
        label: t('nav.approvalRecords'),
        href: '/approvals',
        active: isActive(pathname, '/approvals'),
      },
      {
        // Code (MOTIR-1768 · MOTIR-4643) — the project's repository set and its
        // index freshness, with the shipped code-health audit as its second
        // section. Sits after Reports, exactly where `Code health` was.
        //
        // ⚠️ ONE ROW APPEARS AND ONE ROW LEAVES. Three surfaces answered one
        // question — *what code does Motir know about, and is it healthy?* — from
        // two rail sections with opposite gating, and a user looking for their
        // repositories had to know the answer was spelled `Git` and lived below a
        // horizontal rule beside Job runs and Security. This is the door; the
        // page is MOTIR-1768's.
        //
        // ⚠️ THE GLYPH IS `Code`, AND `Activity` IS FREED. `Activity` was Code
        // health's — a pulse, which named the AUDIT rather than the room. The
        // room is about code, and its first section is a list of repositories.
        icon: <Code />,
        label: t('nav.code'),
        href: '/code',
        active: isActive(pathname, '/code'),
      },
    ];
    // The labeled "Resume onboarding" re-entry door (MOTIR-1533; design
    // MOTIR-1548) leads the primary nav when the active project has an
    // in-progress onboarding — the highest-priority next action. It routes to
    // /onboarding, which resumes at the real persisted step (MOTIR-1487).
    if (canResume) {
      primaryItems.unshift({
        icon: <History />,
        label: t('nav.resumeOnboarding'),
        href: ONBOARDING_RESUME_PATH,
        emphasis: true,
        badge: <ResumeInProgressBadge label={t('nav.resumeOnboardingInProgress')} />,
      });
    }
    // MOTIR-2471 — the same gate the ⌘K navigations use, from the same map, so
    // the two surfaces cannot drift. A row whose destination refuses the actor
    // outright is not rendered and the rows below close up; nothing marks the
    // gap (design panel 4). The Resume-onboarding row above carries its own
    // `canResume` gate and is deliberately not in the map — it is a state, not a
    // permission.
    const offered = primaryItems.filter(
      (item) => item.href === ONBOARDING_RESUME_PATH || canOfferNavDestination(item.href, held),
    );
    sections.push({ id: 'primary', items: offered });
  }

  // NO ACTIVE PROJECT — and no primary section at all. There WAS a second,
  // duplicate Home row here (Subtask MOTIR-2654), justified by "Home is
  // workspace-scoped: it works with no project" — which is precisely the
  // property MOTIR-2761 removed. Once `/home` needs a project, a row offering it
  // to a reader who has none is a row promising a room the product cannot open,
  // so Home joins every other primary entry in being correctly absent and the
  // rail keeps only its bottom section. `/home` stays reachable by URL and
  // renders the create-first door there; nothing redirects
  // (`docs/decisions/home-scope.md` §2.1–2.2).
  //
  // The row was also the tell, not merely a consequence: a special case invented
  // to make a new surface fit its slot is a signal about the slot
  // (`notes.html` #263 / MOTIR-2762). Curing the mismatch retires it.

  // THE AREA DOOR (Subtask MOTIR-2468, design panel 1). With an active project
  // the Settings row deep-links into the project-settings area — so it renders
  // only when that area has something behind it for this actor. An actor whose
  // every entry filters away gets NO row: the rows below simply close up and the
  // footer is one shorter, with nothing marking the gap (no disabled row, no
  // tooltip — an entry point is a promise about a room, and a disabled row is a
  // promise the product then refuses).
  //
  // ⚠️ THE NO-PROJECT ARM IS GONE (MOTIR-4873). It read: "With NO active project
  // the row still targets workspace settings and is ALWAYS rendered", which was
  // right for a state the product no longer has. What survives is the arm that
  // was always taken for a reader with a project.
  //
  // ⚠️ AND THE DOOR'S DESTINATION IS THE SAME READ (MOTIR-5319). It deep-linked
  // to `PROJECT_SETTINGS_ROOT` unconditionally — the Details room, gated on
  // `project:administer` — while its VISIBILITY came from the view-gated filter.
  // So a hand-composed role that could open some room but not Details (Boards on
  // `board:configure`, Workflow on `workflow:manage`) got a door, pressed it, and
  // landed on `Admins only`. Both halves now come from ONE `visibleSettingsNav`
  // call: the door renders exactly when that list has a first entry, and goes to
  // it. For an administrator that entry is still Details, so the admin's door is
  // unchanged.
  const settingsDoorHref = visibleSettingsNav(held, PROJECT_SETTINGS_NAV, availability)[0]?.href;

  // ⚠️ BOTH WORKSPACE ROWS LEFT THIS SECTION (Story MOTIR-4843 · MOTIR-4847 ·
  // `design/shell/rail-bottom-section.mock.html`, amended by MOTIR-4845).
  //
  // `Security` and `Job runs` were workspace-tier panes rendered as loose rows
  // in the PROJECT's rail — a tenancy mismatch that taught the wrong model
  // twice. Both capabilities are RELOCATED, never removed, which is what
  // `organization-tier.md` §6 requires of a hiding rule: above the reveal they
  // are rows in the workspace area's own rail (`lib/settings/workspaceSettingsNav.ts`),
  // and below it they are folded into `/settings/organization` — Security by
  // `WorkspaceFoldInSection` (MOTIR-3502) and Job runs by `JobRunsFoldInSection`
  // (MOTIR-4861, the fold-in this card waited on). The door into both is the
  // workspace SWITCHER's new `Workspace settings` row.
  //
  // ⚠️ AND `Git` HAS NOW LEFT IT TOO (Story MOTIR-1754 · MOTIR-1768). MOTIR-4640
  // took it out of the design asset above; MOTIR-4643 folded Code health + Git
  // into the one primary `Codebase` entry, and this branch is where that landed.
  // The consequence is that the note this paragraph used to carry — "this
  // section always has at least one row" — is FALSE from here on: `Settings` is
  // conditional, so the section can be empty, and the asset's FLOOR arm (the
  // section absent entirely) is reachable rather than merely drawn. The guard
  // below was written ahead of that and is now load-bearing: a section that can
  // vanish must not ship as an empty container with a stray separator.
  const bottomItems = [
    ...(settingsDoorHref !== undefined
      ? [
          {
            icon: <Settings />,
            label: t('nav.settings'),
            // Deep-links to the first project-settings room this actor can open
            // (MOTIR-5319) — Details for an administrator.
            //
            // ⚠️ THE NO-PROJECT ARM IS GONE (MOTIR-4873), and this is the ONE
            // edit MOTIR-4843's restructure needs on this branch. It read
            // "deep-link to project settings when a project is active;
            // otherwise there's nothing project-scoped to configure, so go to
            // the settings HOME — which one depends on progressive disclosure
            // (MOTIR-3502 · organization-tier §6d)". That reasoning was right
            // for a reader the product no longer has: every member is inside a
            // project (MOTIR-4870), so `hasProject` is not a prop of this
            // component any more and the ternary cannot be written, let alone
            // taken. `workspaceTierRevealed` still decides the org/workspace
            // rows below, so the disclosure rule itself is untouched — only its
            // use HERE, which existed solely to serve the projectless case.
            href: settingsDoorHref,
            // Stay un-highlighted when a more-specific row in this same section
            // is the active route, so only one row ever reads current.
            //
            // ⚠️ TWO CLAUSES WENT WITH THEIR ROWS (MOTIR-4847). This predicate
            // used to negate `/settings/workspace/security` and
            // `/settings/workspace/jobs` as well. Both are now unreachable from
            // here in TWO independent ways — the rows they yielded to are gone,
            // and `isWorkspaceSettingsPath` returns the workspace area's own
            // Sidebar before this block is ever built — so a clause that can
            // never fire is not a safe extra: it is an untested branch that
            // still reads as covered (MOTIR-4368's finding about this very
            // predicate).
            //
            // ⚠️ AND THE THIRD, `Git`'s, WENT TOO (MOTIR-5319). It negated
            // `/settings/organization/git` after `Git` left this section
            // (MOTIR-4643), and that path returns the organisation area's own
            // Sidebar before this block is built — the same double
            // unreachability. Its test asserted it gone and passed only because
            // the source slice it read was empty.
            active: isActive(pathname, '/settings'),
          },
        ]
      : []),
    // ⚠️ THE `Git` ROW LEFT THIS SECTION TOO (MOTIR-4643 · design/shell
    // § *The rail's bottom section*, amended by MOTIR-4640) — so this whole
    // entry is gone, and with it the last row MOTIR-4847 left standing beside
    // `Settings`.
    //
    // It pointed at the organisation's Git settings — the connection
    // LIFECYCLE, an org-admin act at the tenant that owns it — while the
    // question a project member actually brings to the rail is *what code does
    // Motir know about?*, which the `Codebase` row in the PRIMARY section now
    // answers.
    //
    // ⚠️ REMOVING A ROW MAY REMOVE A CONCEPT AND MAY NOT REMOVE A CAPABILITY,
    // and both actions that lived behind this one are carried forward, to the
    // tenant that owns each:
    //
    //   · configure which repositories exist — ORG ADMIN — Settings →
    //     Organisation → Git, still reachable from the settings area's own
    //     navigation;
    //   · connect YOUR OWN account — ANY MEMBER — Settings → Account → Git,
    //     because `GithubIdentity` is `userId @unique` and a personal
    //     credential belongs beside `/settings/account/tokens`. This is the one
    //     `projectSettingsNav.ts` calls "the one action nobody can take on [a
    //     member's] behalf", so it is the one that must not lose its door.
    //
    // Neither is gone; both moved off a PROJECT rail that was never the right
    // place for an administrative door.
    //
    // Docs and Legal documents LEFT this section for the Help menu
    // (MOTIR-4239 · design/shell/help-menu.mock.html): the authed shell now
    // has a footer to put them in, and a bottom section that keeps growing
    // with every non-product door was the tell, not merely a symptom.
    //
    // ⚠️ THE FLOOR IS NOW `Settings` ALONE. `Security` and `Job runs` left with
    // MOTIR-4847, `Git` leaves here, and the count is RE-TAKEN rather than
    // inherited — the previous line in this comment recorded a floor nobody
    // had re-measured, which is the mistake it warns about.
  ];

  // NOTHING MARKS THE GAP, INCLUDING THE SECTION ITSELF (MOTIR-4847). When the
  // last row filters away the section is ABSENT — no heading, no separator, no
  // empty state — rather than an empty container. Pushing `{ items: [] }` would
  // render the separator `Sidebar` draws between sections above a row that is
  // not there, which reads as a loading error rather than as policy.
  //
  // ⚠️ AND THAT IS REACHABLE NOW, WHICH IT BARELY WAS BEFORE (MOTIR-4643). With
  // `Git` gone, `Settings` is the only row left — so an actor without the
  // settings door gets NO bottom section at all, and this branch stops being
  // defensive and starts being the ordinary member's rail.
  if (bottomItems.length > 0) {
    sections.push({ id: 'bottom', items: bottomItems });
  }

  return (
    <Sidebar
      // NO header in the default area (MOTIR-2556 · design/shell § *The rail
      // head, after the project leaves*). The rail answers "where inside this
      // project can I go"; its head was answering "which project am I in",
      // which is the top bar's context path now — and is why this slot needed
      // three states (a create-first card, an archived pill, a collapsed
      // avatar) that no rail ROW needs. The settings and account areas keep
      // their own headers above; only the project one left.
      sections={sections}
      footer={footer}
      collapsed={isDrawer ? false : undefined}
    />
  );
}
