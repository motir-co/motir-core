import { Boxes, Globe, Link2, Shield, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// The WORKSPACE-settings navigation REGISTRY (Story MOTIR-4843 · MOTIR-4846).
//
// The FOURTH and last of Motir's settings tiers to become an AREA.
// `settings/project/`, `settings/account/` and — since MOTIR-4710 —
// `settings/organization/` each had an area layout, a registry and a
// `SidebarNav` branch; `settings/workspace/` had none of the three. Its routes
// appeared as loose rows scattered through the rail's no-project bottom section,
// and the surface's own door was a row inside the ACCOUNT menu.
//
// The design of record is `design/settings/workspace-settings.mock.html`
// (MOTIR-4844), which draws the rail, both reveal arms and the switcher row.
//
// Like its three siblings, one source drives the surfaces that therefore cannot
// drift: the area rail, and the route ↔ registry TOTALITY test
// (`tests/settings/workspaceSettingsNav.test.ts`).
//
// ── ⚠️ ONE FILTER AXIS, AND IT IS THE REVEAL — NOT A ROLE ───────────────────
// `visibleWorkspaceSettingsNav(revealed)` returns every row or none. There
// is deliberately **no role axis**, and that is a DISPOSITION rather than an
// omission: all three routes check a session and a workspace context and **no
// role at all** (`workspacesService.renameWorkspace` asserts membership only —
// the Delete row's action is org-Admin-gated since MOTIR-6309, and that row
// moves to the org tier with MOTIR-6312). `docs/decisions/organization-tier.md`
// §6d forbids a relocation that NARROWS a gate, so an `adminOnly` flag here
// would take a shipped capability away silently.
//
// It DEFAULTS CLOSED for the reason `organizationSettingsNav.ts` records for its
// own axes: a surface that forgets to thread it drops the row rather than
// offering a door onto a route that `notFound()`s.
//
// ── ⚠️ THE `Job runs` ROW IS GONE, AND SO IS ITS GROUP ─────────────────────
// The registry carried a `jobs` row in a third group, `operations`, for the
// tenant Job runs dashboard at `/settings/workspace/jobs`. Story MOTIR-9982
// retired that surface by decision (MOTIR-4896): the ledger is staff-only at
// `/admin/jobs`, and the route has no page, so it answers the ordinary 404. Row,
// page and group left in one change, because the totality test pairs them.
//
// ⚠️ TAKE THE BOOLEAN, NOT A WORKSPACE LIST. The predicate is computed ONCE in
// `lib/workspaces/tierDisclosure.ts`; this must not become a fifth reader of it.
//
// Pure data + pure helpers (no JSX, no React state), so it is importable from
// both the server (the totality test) and the client (SidebarNav). `icon` is the
// lucide COMPONENT; the consumer renders `<entry.icon />`.

export type WorkspaceSettingsNavGroup = 'general' | 'access';

/**
 * Rail order of the groups (General → Access), mirroring the organisation's.
 * A group whose rows all filter away is not rendered.
 */
export const WORKSPACE_SETTINGS_NAV_GROUP_ORDER: WorkspaceSettingsNavGroup[] = [
  'general',
  'access',
];

export interface WorkspaceSettingsNavEntry {
  /** Stable id — also the command-palette action id, should one ever be wired. */
  id: string;
  group: WorkspaceSettingsNavGroup;
  /** The route this entry navigates to. Every entry is a real route. */
  href: string;
  /** The lucide icon COMPONENT (the consumer renders it). */
  icon: LucideIcon;
  /** i18n key under the `settings.workspace.nav` namespace. */
  labelKey: string;
  /** Active ONLY on an exact pathname match — the area root needs this. */
  exact?: true;
  /** Drill-down routes reached FROM this row, which keep it active (the Roles room). */
  nestedRoutes?: string[];
  /**
   * The room exists only on a CLOUD build (Story MOTIR-4528 · MOTIR-9514), so
   * off-cloud the row is ABSENT and the page 404s — the same deployment axis
   * `projectSettingsNav.ts` names `cloudOnly`. It composes with the reveal: a
   * cloud-only row still needs the tier revealed.
   */
  cloudOnly?: true;
}

/** What this BUILD has — the deployment axis beside the reveal. */
export interface WorkspaceSettingsNavAvailability {
  publicProjectsAvailable: boolean;
}

/** The workspace-settings area root — a real page, not a redirect. */
export const WORKSPACE_SETTINGS_ROOT = '/settings/workspace';

/**
 * The registry. Order within a group is the rail order.
 *
 * The glyphs are NOT free choices. `ShieldCheck` is **carried unchanged** from
 * `SidebarNav.tsx`'s bottom section, where that row rendered it — two doors
 * onto one room that disagree about its icon are
 * two rooms. `Boxes` is the design's own choice for the index row and is
 * deliberately NOT `Building2`, which `organizationSettingsNav.ts` has taken for
 * the organisation: a workspace is the CONTAINER its projects and teammates live
 * in, so its glyph is a set of things held together, where the organisation's is
 * the company itself.
 */
export const WORKSPACE_SETTINGS_NAV: WorkspaceSettingsNavEntry[] = [
  {
    id: 'workspace',
    group: 'general',
    href: WORKSPACE_SETTINGS_ROOT,
    icon: Boxes,
    labelKey: 'workspace',
    // EXACT, because every other entry's href is a prefix-sibling under this
    // one: without it the area root would read as active on every route at
    // once. The same reason `organizationSettingsNav.ts` gives.
    exact: true,
  },
  {
    id: 'security',
    group: 'access',
    href: '/settings/workspace/security',
    icon: ShieldCheck,
    labelKey: 'security',
  },
  {
    // Story MOTIR-6168 · MOTIR-6466 — the Roles room, moved up from project
    // settings with the roles themselves. `Shield` is the glyph the project rail
    // gave the same room, so the two doors agree (design panel 4a). A drill-down:
    // the detail, the editor and New role keep this row active.
    //
    // ⚠️ ITS ROUTES ANSWER AT EVERY WORKSPACE COUNT (the design's one reveal
    // carve-out, panel 4b) — the ROW follows the reveal like its siblings, and
    // below it the org page's fold-in carries a door card instead.
    id: 'roles',
    group: 'access',
    href: '/settings/workspace/roles',
    icon: Shield,
    labelKey: 'roles',
    nestedRoutes: [
      '/settings/workspace/roles/[roleKey]',
      '/settings/workspace/roles/[roleKey]/edit',
      '/settings/workspace/roles/new',
    ],
  },
  {
    // Story MOTIR-4528 · MOTIR-9514 — the workspace's one public name, moved up
    // from project settings because a subdomain is a property of the WORKSPACE
    // (ADR §3). `Link2` is the glyph the project rail gave the same room, so the
    // two doors agree. Placed after Roles, as `design/workspace-address` panel 0
    // draws it.
    //
    // ⚠️ ITS PAGE ANSWERS AT EVERY WORKSPACE COUNT, like Roles: below the reveal
    // the org page carries a door card to it instead of this row.
    id: 'public-address',
    group: 'access',
    href: '/settings/workspace/public-address',
    icon: Link2,
    labelKey: 'publicAddress',
    cloudOnly: true,
  },
  {
    // Story MOTIR-4533 · MOTIR-9529 — the workspace's customer domains, directly
    // under Public address (`design/workspace-address/custom-domains.mock.html`
    // panel 0). A customer domain is the WORKSPACE's (ADR MOTIR-9521 §1), so its
    // room is here, not in project settings. Cloud-only, like its neighbour.
    id: 'custom-domains',
    group: 'access',
    href: '/settings/workspace/custom-domains',
    icon: Globe,
    labelKey: 'customDomains',
    cloudOnly: true,
  },
];

/** The destinations — what the totality test pairs 1:1 with the on-disk panes. */
export const WORKSPACE_SETTINGS_ROUTES: WorkspaceSettingsNavEntry[] = WORKSPACE_SETTINGS_NAV;

/** Whether `pathname` is inside the workspace-settings area. */
export function isWorkspaceSettingsPath(pathname: string): boolean {
  return pathname === WORKSPACE_SETTINGS_ROOT || pathname.startsWith(`${WORKSPACE_SETTINGS_ROOT}/`);
}

/** Whether a registry entry is the active route for `pathname`. */
export function isWorkspaceSettingsEntryActive(
  entry: WorkspaceSettingsNavEntry,
  pathname: string,
): boolean {
  if (!entry.href) return false;
  if (entry.exact) return pathname === entry.href;
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}

/**
 * The rows this actor may see — the registry filtered on its ONE axis, which
 * DEFAULTS CLOSED.
 *
 * Below the reveal the workspace tier is not taught at all: every one of these
 * routes `notFound()`s and their capabilities are hosted on
 * `/settings/organization`, gated per SECTION. So the honest answer there is an
 * EMPTY list, not a shorter one — and a row that filters away is ABSENT, never
 * disabled: an entry point is a promise about a room, and a disabled row is a
 * promise the product then refuses (MOTIR-2468).
 */
export function visibleWorkspaceSettingsNav(
  revealed: boolean = false,
  entries: WorkspaceSettingsNavEntry[] = WORKSPACE_SETTINGS_NAV,
  available: WorkspaceSettingsNavAvailability = { publicProjectsAvailable: false },
): WorkspaceSettingsNavEntry[] {
  if (!revealed) return [];
  // The deployment axis also DEFAULTS CLOSED: a caller that forgets it drops the
  // cloud-only row rather than pointing at a room that 404s off-cloud.
  return entries.filter((entry) => !entry.cloudOnly || available.publicProjectsAvailable);
}

/**
 * Group a flat entry list into the rail's ordered, NON-EMPTY groups.
 *
 * A group whose rows all filtered away is not rendered — no empty heading. Below
 * the reveal that is every group, so the rail renders no workspace rows at all.
 */
export function groupWorkspaceSettingsNav(
  entries: WorkspaceSettingsNavEntry[],
): { group: WorkspaceSettingsNavGroup; entries: WorkspaceSettingsNavEntry[] }[] {
  return WORKSPACE_SETTINGS_NAV_GROUP_ORDER.map((group) => ({
    group,
    entries: entries.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}
