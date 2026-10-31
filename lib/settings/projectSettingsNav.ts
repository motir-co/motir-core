import {
  Activity,
  Bot,
  Box,
  Bug,
  Cloud,
  Columns3,
  FolderGit2,
  Gauge,
  Globe,
  KeyRound,
  Languages,
  Link2,
  Rocket,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Users,
  Variable,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PermissionKey } from '@/lib/permissions/catalog';

// The project-settings navigation REGISTRY (Story 6.5 · Subtask 6.5.2) — ONE
// typed entry per project-settings page. It is the single source that drives
// three surfaces, so they can never drift apart:
//   1. the settings AREA nav (the rail, rendered by SidebarNav when in the area)
//   2. the command-palette deep links (AppCommandPalette)
//   3. the TOTALITY test (every `settings/project/**/page.tsx` route has EXACTLY
//      one registry entry, and vice versa — the mistake #29 totality guard;
//      `tests/settings/projectSettingsNav.test.ts` enumerates the filesystem).
//
// A later admin story mounts its page by ADDING an entry here — no layout change.
// The Automation slot below was the worked example of the OTHER route in: a slot
// reserved ahead of its page for Story 6.6, drawn disabled until 6.6.5 lit it up.
// That reservation mechanism is RETIRED (MOTIR-4324) — with Automation live the
// reserved set was empty, leaving the flag, its rail rendering and its filter
// unreachable from the product. Reserving a slot again is a deliberate
// re-introduction with its first real user, not a field to set. The asset of
// record is
// `design/projects/settings-area.mock.html` (6.5.1).
//
// This module is pure data + pure helpers (no JSX, no React state), so it is
// importable from both the server (the totality test, a future server filter)
// and the client (SidebarNav, the command palette) and is unit-testable in
// isolation. `icon` is the lucide COMPONENT (not a rendered element); the
// consumer renders `<entry.icon />`.

export type SettingsNavGroup = 'general' | 'access' | 'work' | 'automation';

/** Rail order of the groups (General → Access → Work → Automation). */
export const SETTINGS_NAV_GROUP_ORDER: SettingsNavGroup[] = [
  'general',
  'access',
  'work',
  'automation',
];

/**
 * The actor's resolved permission set, as the registry reads it (Story
 * MOTIR-2258 · Subtask MOTIR-2468). `ProjectAccessProvider` carries the array
 * across the server/client boundary; every consumer here wants membership tests,
 * so it is a Set by the time it reaches `visibleSettingsNav`.
 */
export type SettingsNavPermissions = ReadonlySet<PermissionKey>;

/** Build the membership-test form from the DTO's array (or any key list). */
export function toSettingsNavPermissions(
  keys: Iterable<PermissionKey> = [],
): SettingsNavPermissions {
  return new Set<PermissionKey>(keys);
}

/**
 * What this DEPLOYMENT has, as distinct from what this ACTOR holds (Story
 * MOTIR-3875 · MOTIR-4243). The registry is static and the permission set is
 * per-actor; a capability that a whole BUILD does not have is neither, so the
 * caller supplies it.
 *
 * It carries named fields rather than a bare boolean so the next capability
 * joins it without changing a signature — which is how `hostedRunsAvailable`
 * (MOTIR-6995) joined `publicProjectsAvailable`.
 */
export interface SettingsNavAvailability {
  /**
   * Whether public projects exist on this build — `isCloud()`, resolved on the
   * SERVER (`app/(authed)/layout.tsx` already resolves it for the header slot)
   * and threaded to the client surfaces that filter the registry.
   */
  publicProjectsAvailable: boolean;
  /**
   * Whether this build runs HOSTED AGENTS at all — `isHostedRunsAvailable()`,
   * resolved on the SERVER beside `publicProjectsAvailable` (Story MOTIR-6989 ·
   * MOTIR-6995; `design/settings/design-notes.md` § Hosted agent room). It drops
   * every {@link SettingsNavEntry.hostedRunsOnly} row.
   *
   * OPTIONAL, and absent means `false`: it defaults CLOSED like the field above,
   * so a caller that has not threaded it hides the room rather than offering a
   * door onto a route that answers 404.
   *
   * ⚠️ A BUILD fact, never Motir AI's live health: an outage keeps the row and
   * the room draws it (its unavailable state).
   */
  hostedRunsAvailable?: boolean;
  /**
   * Whether the ACTIVE PROJECT holds at least one repository Motir hosts — a row
   * whose `seedSource` is not the organisation's (Story MOTIR-9795 · MOTIR-9966;
   * `design/environment/design-notes.md`, panel 19). It drops every
   * {@link SettingsNavEntry.motirRepositoriesOnly} row: a project holding only
   * customer repositories has nothing to set in the Environment room.
   *
   * A PROJECT fact rather than a build fact, so the layout resolves it per
   * request beside the actor's permissions. OPTIONAL, and absent means `false`,
   * closed like the two fields above.
   */
  motirRepositoriesPresent?: boolean;
}

/**
 * The DEFAULT, and it fails CLOSED on purpose: a caller that forgets to thread
 * the deployment fact drops every {@link SettingsNavEntry.cloudOnly} row rather
 * than offering one. The opposite default would put a rail row and a ⌘K action
 * on a self-hosted build in front of a route that answers 404 — the "door onto a
 * corridor" {@link hasVisibleSettingsArea} exists to refuse, one row down.
 *
 * The same shape as `SidebarNav`'s own `workspaceTierRevealed` prop, and for the
 * same reason.
 */
const NO_CLOUD_CAPABILITIES: SettingsNavAvailability = {
  publicProjectsAvailable: false,
  hostedRunsAvailable: false,
  motirRepositoriesPresent: false,
};

/** Whether `entry` exists at all on a deployment with these capabilities. */
export function isSettingsEntryAvailable(
  entry: SettingsNavEntry,
  available: SettingsNavAvailability,
): boolean {
  if (entry.cloudOnly && !available.publicProjectsAvailable) return false;
  if (entry.hostedRunsOnly && available.hostedRunsAvailable !== true) return false;
  if (entry.motirRepositoriesOnly && available.motirRepositoriesPresent !== true) return false;
  return true;
}

export interface SettingsNavEntry {
  /** Stable id — also the command-palette action id (`settings-<id>`). */
  id: string;
  group: SettingsNavGroup;
  /** The preserved settings route this entry navigates to. Every entry is a real route. */
  href: string;
  /** The lucide icon COMPONENT (the consumer renders it). */
  icon: LucideIcon;
  /** i18n key under the `settings` namespace (e.g. `nav.details`). */
  labelKey: string;
  /**
   * The WRITE key — the catalog permission this room's CONTROLS require, READ OFF
   * the destination's own server gate, never inferred from the entry's name. A
   * rail row that hides on a key the page does not check is a new bug wearing the
   * shape of a fix, and it fails in the worst direction: it hides a room the actor
   * could have used. Every pairing's evidence is in the table above.
   *
   * It is ALSO the VIEW key whenever {@link viewPermission} is absent — which is
   * every entry that does not say otherwise — so for such an entry this one key
   * still gates the rail row, the area door and the destination exactly as it did
   * before a second key existed.
   *
   * REQUIRED, so a settings page added later cannot ship an ungated door — the
   * omission is a compile error, not a silently-visible entry.
   */
  permission: PermissionKey;
  /**
   * The VIEW key — may this actor ENTER the room and READ it — for a room where
   * that is a different question from whether they may CHANGE it (Task
   * MOTIR-5193). Absent, the view key IS {@link permission};
   * {@link settingsEntryViewKey} is the one place that default is applied, and
   * every consumer reads through it.
   *
   * ⚠️ A THIRD QUESTION, NOT A LOOSER PERMISSION. With {@link cloudOnly} beside
   * it, an entry answers three things: `cloudOnly` — *does this room exist on
   * this deployment*; `viewPermission` — *may this actor stand in it*;
   * `permission` — *may they change anything once there*. The rail row, the area
   * door and the destination guard gate on the VIEW key. The write key gates
   * nothing on arrival; it is what the page reads, through the registry, to
   * decide which controls to render.
   *
   * ⚠️ AND IT RE-OPENS THE DRIFT THE ONE-KEY MODEL WAS BUILT TO PREVENT. With one
   * key, the row that hides a page and the page that refuses an actor could not
   * disagree. With two, the view key must still be the key the destination's READ
   * asserts, and the page must still take its write key from here rather than
   * re-typing it. Care is what stops working once there are two keys to align, so
   * `tests/settings/projectSettingsNav.test.ts` holds both as a test, proven to
   * fire on a fixture that drifts on purpose — declare one only with its evidence
   * row there.
   *
   * ⚠️ DECLARING ONE CHANGES A DERIVED POPULATION. {@link hasVisibleSettingsArea}
   * is a `some()` over the view-gated rows, and every actor who reaches the
   * settings shell holds `project:browse` — so a browse-visible room brings the
   * area door back for every member of every project, and falsifies every suite
   * that pins *a member is offered no settings area*. That is a product decision
   * with its own card, never a field set in passing.
   */
  viewPermission?: PermissionKey;
  /**
   * Active ONLY on an exact pathname match. Set for Details, whose href
   * (`/settings/project`) is a prefix of every sub-route — without this it would
   * read as active on every settings page.
   */
  exact?: boolean;
  /**
   * This room exists ONLY on a cloud build (`isCloud()`), so the row is ABSENT
   * off-cloud rather than merely gated — Story MOTIR-3908's ruling that
   * public projects are not a hidden feature on a self-hosted Motir but an
   * ABSENT one (`lib/publicProjects/cloudGate.ts`).
   *
   * ⚠️ IT IS A SECOND AXIS, NOT A SECOND PERMISSION. {@link permission} answers
   * *may THIS ACTOR use the room*; this answers *does the room exist on THIS
   * DEPLOYMENT at all*. They compose — a cloud-only row still needs its key —
   * and they fail differently: a permission a reader lacks hides a room that is
   * there, while an absent capability has nothing behind the door. Keeping them
   * apart is what lets the destination answer `notFound()` off-cloud (the
   * billing page's precedent) rather than the refusal state, which would say
   * *this exists and you may not see it* about a build where it does not exist.
   *
   * The registry is static, so the DEPLOYMENT fact has to be supplied by the
   * caller: {@link visibleSettingsNav} and {@link hasVisibleSettingsArea} take a
   * {@link SettingsNavAvailability} and it DEFAULTS CLOSED, so a surface that
   * forgets to thread it drops the row rather than offering a door onto a
   * corridor. The route ↔ registry totality test pairs the route with this entry
   * regardless of the flag: the page exists in the tree either way.
   */
  cloudOnly?: true;
  /**
   * This room exists ONLY on a build that runs hosted agents
   * ({@link SettingsNavAvailability.hostedRunsAvailable}) — the same second axis
   * as {@link cloudOnly}, one capability over (Story MOTIR-6989 · MOTIR-6995).
   * Absent off such a build whatever the actor holds, and the destination answers
   * `notFound()`; the totality test pairs the route regardless.
   */
  hostedRunsOnly?: true;
  /**
   * This room exists ONLY for a project holding a repository Motir hosts
   * ({@link SettingsNavAvailability.motirRepositoriesPresent}) — the same second
   * axis as {@link cloudOnly}, decided per project (MOTIR-9966). The destination
   * still renders for a project without one (its not-found state), and the
   * totality test pairs the route regardless.
   */
  motirRepositoriesOnly?: true;
  /**
   * Routes reached by DRILLING DOWN from this entry, which deliberately get no
   * rail row of their own (Subtask MOTIR-2263 — the role DETAIL screen). Each
   * must be a strict sub-path of {@link href}: this field declares a nested
   * destination, it is not a second way to register an unrelated page.
   *
   * ⚠️ WHY THIS EXISTS RATHER THAN A WEAKER TOTALITY TEST. The 6.5.2 guard pairs
   * every on-disk `settings/project/**​/page.tsx` 1:1 with a registry entry, so a
   * page that ships with no way to reach it fails the build. A drill-down is the
   * first honest exception — a second `page.tsx` whose door is its PARENT's row,
   * not a row of its own — and the answer is to teach the registry about it, not
   * to relax the assertion until it passes. The guard still pairs the filesystem
   * 1:1 with `PROJECT_SETTINGS_ROUTE_PATHS` (hrefs PLUS declared nested routes),
   * so an undeclared new page still fails exactly as before.
   *
   * `isSettingsEntryActive` already lights the parent row on these, since a
   * non-`exact` entry matches its own sub-paths.
   */
  nestedRoutes?: string[];
}

/** The project-settings root — the Details landing route. */
export const PROJECT_SETTINGS_ROOT = '/settings/project';

/**
 * The registry. Order within a group is the rail order. Routes are PRESERVED
 * (every existing settings URL resolves unchanged inside the area chrome); only
 * `/settings/project` changes meaning (hub → Details landing). Icons mirror
 * `design/projects/settings-area.mock.html` + the app-nav glyphs (Boards reuses
 * `Columns3`; Workflow is the connected-box glyph, NOT GitBranch).
 */
export const PROJECT_SETTINGS_NAV: SettingsNavEntry[] = [
  {
    id: 'details',
    group: 'general',
    href: PROJECT_SETTINGS_ROOT,
    icon: SlidersHorizontal,
    labelKey: 'nav.details',
    // VERIFIED: the page resolves `projectAccessService.getManageCapabilities`,
    // whose predicate is `project:administer`, and gates every editable
    // affordance plus the danger zone on it. Details IS the project-level
    // administration that belongs to no domain — rename, key, avatar, archive —
    // so the key its own gate asserts is the right door key. A read-only Details
    // for someone who can change nothing on it is exactly the treatment the
    // 2026-08-08 amendment supersedes.
    permission: 'project:administer',
    exact: true,
  },
  {
    id: 'repositories',
    group: 'general',
    href: '/settings/project/repositories',
    icon: FolderGit2,
    labelKey: 'nav.repositories',
    // Story MOTIR-1775 · MOTIR-1939 — the TAKE-IT-OVER room, and the PERMANENT
    // way back to it. The other two doors (the ownership promise's `How moving
    // it works` link, the billing panel's `Move repositories` button) are both
    // moments the user passes through; a `transfer_pending` that sits for days
    // has to be reachable from somewhere that is always there, which is what
    // this row is (design/repository-set §14.4, door 3).
    //
    // VERIFIED: `projectRepoSetService` and `projectRepoTakeoverService` both
    // assert `repository:manage`; the room's whole purpose is establishing and
    // taking over the set. (Was browse-gated so "a member SEES where the code
    // lives" — retired by the 2026-08-08 amendment, which supersedes read-only
    // views of an administrative surface.)
    permission: 'repository:manage',
  },
  {
    id: 'environment',
    group: 'general',
    href: '/settings/project/environment',
    // `Variable` — the glyph the approved design draws (MOTIR-9959).
    icon: Variable,
    labelKey: 'nav.environment',
    // Story MOTIR-9795 · MOTIR-9966, drawn by MOTIR-9959
    // (`design/environment/environment.mock.html` · `design/environment/
    // design-notes.md` § Where it lives). A Motir repository's values per
    // environment. DIRECTLY UNDER Repositories: both rooms are about the
    // project's repositories, and this one is its own room rather than a section
    // there because Repositories is hidden from members and this room has a
    // member view.
    //
    // VERIFIED (write key): every `environmentConfigService` write (`set`,
    // `delete`) asserts `repository:manage`. It gates the add row and the Edit,
    // Replace and Delete controls; the page reads it through
    // `settingsEntryKeys('environment')`.
    permission: 'repository:manage',
    // ⚠️ A DISTINCT VIEW KEY, DECIDED BY THE APPROVED DESIGN (MOTIR-9959): a member
    // who can browse the project may read what its app runs with, secrets shown
    // only as Set. VERIFIED: `environmentConfigService.list` and `listChanges`
    // assert `project:browse`. Its evidence row is in
    // `tests/settings/projectSettingsNav.test.ts`'s VIEW_KEY_EVIDENCE.
    viewPermission: 'project:browse',
    // A PROJECT fact: absent from a project holding no repository Motir hosts.
    motirRepositoriesOnly: true,
  },
  {
    id: 'production',
    group: 'general',
    href: '/settings/project/production',
    // `Rocket` — the glyph the approved design draws (MOTIR-10024).
    icon: Rocket,
    labelKey: 'nav.production',
    // Story MOTIR-9797 · MOTIR-10037, drawn by MOTIR-10024
    // (`design/hosting/production.mock.html` · `design/hosting/design-notes.md`
    // § Where it lives). What is live in production for a Motir repository, its
    // release history and Roll back. DIRECTLY UNDER Environment, its own room for
    // the same reason Environment is: it has a member view.
    //
    // VERIFIED (write key): `productionRollbackService` refuses an actor without
    // `project:administer` (`RollbackNotPermittedError`), and the panel read
    // reports it as `isAdministrator`. The key is named here so the rail row and
    // the guard read one source.
    permission: 'project:administer',
    // ⚠️ A DISTINCT VIEW KEY, DECIDED BY THE APPROVED DESIGN (MOTIR-10024): every
    // member who can browse the project reads its releases. VERIFIED:
    // `productionPanelService.getProductionPanel` asserts `project:browse`. Its
    // evidence row is in `tests/settings/projectSettingsNav.test.ts`'s
    // VIEW_KEY_EVIDENCE.
    viewPermission: 'project:browse',
    // A PROJECT fact: absent from a project holding no repository Motir hosts.
    motirRepositoriesOnly: true,
  },
  {
    id: 'monitoring',
    group: 'general',
    href: '/settings/project/monitoring',
    icon: Activity,
    labelKey: 'nav.monitoring',
    // Story MOTIR-4928 · MOTIR-5262 — the error-monitor room: a third party's
    // CREDENTIAL plus the inventory of what it is bound to, with a destructive
    // action per binding. That is the shape of `Repositories`, so it sits
    // directly beneath it in `general` rather than in `automation`, which holds
    // rooms that configure Motir's own behaviour (design/monitoring §6).
    //
    // VERIFIED: every `monitorConnectionService` method, and
    // `monitorCredentialService.probeHealth` behind the room's Re-check, asserts
    // `integration:manage` on the project.
    permission: 'integration:manage',
  },
  {
    id: 'members',
    group: 'access',
    href: '/settings/project/members',
    icon: Users,
    labelKey: 'nav.members',
    // VERIFIED: `projectMembersService` asserts `member:manage` for the roster
    // writes (and `project:manage_access` for the access level). `member:manage`
    // is the one that makes the page useful at all — the access control is a
    // single card on it.
    permission: 'member:manage',
  },
  {
    id: 'public-page',
    group: 'access',
    href: '/settings/project/public',
    icon: Globe,
    labelKey: 'nav.publicPage',
    // Story MOTIR-3875 · MOTIR-4243, drawn by MOTIR-4205
    // (`design/projects/public-page.mock.html` Panel A frame ①,
    // `design/projects/design-notes.md` § *The entrance — three doors*). Where a
    // project admin edits the tagline, tags and README that `motir.co/p/<key>`
    // renders. It sits DIRECTLY UNDER Members & access: that room owns the
    // public concerns (the make-public control, the share link, the Hero &
    // overview door) and is the row a reader arrives from.
    //
    // `Globe`, and NOT `Megaphone` — that glyph is the *Building in public*
    // STATUS badge in the top bar, and a room and a status must not share a mark.
    //
    // VERIFIED: the room's write is `projectsService.setPublicOverview`, which
    // asserts `projectAccessService.assertCanManage` — an alias for
    // `assertPermission(…, 'project:administer')` (`projectAccessService.ts`).
    // The key-routed door the room saves through
    // (`publicProjectsService.setPublicOverview`, `PATCH
    // /api/projects/{key}/public-overview`) refuses a non-admin ahead of it and
    // re-runs the same assertion inside the write transaction. Read off the
    // destination's own gate, per this file's rule. No read-only view: the
    // 2026-08-08 amendment supersedes read-only administrative rooms.
    permission: 'project:administer',
    // CLOUD-ONLY (MOTIR-3908). Off-cloud there are no public projects, so this
    // is a room with nothing behind it — the row is absent and the page 404s.
    cloudOnly: true,
  },
  {
    id: 'public-address',
    group: 'access',
    href: '/settings/project/public-address',
    icon: Link2,
    labelKey: 'nav.publicAddress',
    // Story MOTIR-3878 · MOTIR-4221, drawn by MOTIR-4211
    // (`design/projects/public-address.mock.html` panels 0–2, 8, 9 ·
    // `design/projects/design-notes.md` § *Public address*). Where a workspace
    // echoes its workspace's subdomain (customer domains moved to workspace
    // settings, MOTIR-9529).
    //
    // ⚠️ THE ORDER IS THE ASSET'S, NOT THE CARD'S, AND THAT IS A RUNG-2 READING
    // BEATING A RUNG-3 ONE. MOTIR-4221 says the row goes "between Members &
    // access and Roles"; that slot was taken by *Public page* (MOTIR-4243) while
    // this story was in flight. Two public rooms either side of one door is the
    // coherent shape, so the asset draws — and this is —
    //   Members & access → Public page → Public address → Roles → Code access
    // The card's intent (the `access` group, adjacent to Members & access) is
    // honoured; only the neighbour changed.
    //
    // `Link2`, and NOT `Globe` — that glyph is *Public page*, one row up. Two
    // rooms in the same group sharing a mark is exactly what MOTIR-4243's own
    // note refuses between a room and a status badge, applied between two rooms.
    //
    // VERIFIED, and this key is the one thing the design asset deliberately did
    // NOT decide (its planning flag 1: "MOTIR-4221's to READ OFF its own service
    // gate"). The room's writes were `customDomainService.{add,verify,remove}`,
    // every one of which asserted
    // `assertPermission(…, 'project:manage_access')`. Since MOTIR-9529 a customer
    // domain is managed in WORKSPACE settings and this room is a read-only echo;
    // the key stays the Access group's, which the project's access-mode writes
    // (`projectMembersService`) assert.
    //
    // ⚠️ AND `project:browse` WOULD HAVE BEEN THE WRONG READING, though the
    // subdomain half of the room is readable by any workspace member. No settings
    // entry is gated on it, so adding the first one would hand every project
    // VIEWER a settings door — the 2026-08-08 amendment's "no read-only
    // administrative rooms" refuses that, and the asset's panel 8 says so in
    // terms: a member who can read but not administer never reaches this row.
    //
    // THE READ-ONLY ARM IS THE OTHER CASE, and it is real rather than defensive:
    // the subdomain's own writes are gated on the WORKSPACE role (owner/admin,
    // `publicSubdomainService`), which is a different axis from the project
    // permission above. A project admin who is a workspace *member* holds the
    // door key and not the write key, so the pane renders the address with every
    // control ABSENT (panel 8). `roleMayManageAddress` is exported from that
    // service so the rule has one home.
    permission: 'project:manage_access',
    // CLOUD-ONLY (ADR §11): a self-hosted build has no public projects, so this
    // is a room with nothing behind it. The flag is MOTIR-4243's — this entry
    // USES it and does not re-introduce it, which the asset flagged as a build
    // dependency precisely so two cards could not add one field twice.
    cloudOnly: true,
  },
  // ⚠️ NO `roles` ROW (Story MOTIR-6168 · MOTIR-6466). Roles live on the
  // WORKSPACE — one per person, the same in every project — so the Roles room
  // moved to Workspace settings → Access, and every `/settings/project/roles/**`
  // route redirects there (design `workspace-roles.mock.html` panel 4c).
  {
    id: 'code-access',
    group: 'access',
    href: '/settings/project/code-access',
    icon: KeyRound,
    labelKey: 'nav.codeAccess',
    // Story MOTIR-1775 · MOTIR-1945 — who on the team can clone the project's
    // code. A SIBLING pane rather than a section inside Members & access
    // (design/repository-set §15.3): it is a table with six per-member states,
    // four page states and a second per-repository dimension, and the registry
    // is what gives it a door that cannot silently disappear (the totality
    // test). BROWSE-gated on purpose — unlike the members pane, this one has
    // something a NON-admin can do: connect their own GitHub, which is the one
    // action nobody can take on their behalf (ADR §3 Q3).
    //
    // ⚠️ THAT COMMENT IS RETIRED, DELIBERATELY, AND IT IS THE CLOSEST CALL IN
    // THIS FILE. VERIFIED: `projectRepoAccessService` asserts
    // `repository:manage_access`, and the page's own source says a non-admin
    // "sees the same data, plus the one action that is theirs alone: connecting
    // their own GitHub". But that action does not live here — the page links out
    // to `GITHUB_SETTINGS_PATH` (`/settings/workspace/github`), reached from the
    // bottom nav's own `Git` row, which this story does not touch. So gating the
    // row takes NOTHING a member could do; it takes a read-only view of who else
    // has been invited, which is precisely what the 2026-08-08 amendment
    // supersedes. Keeping it browse-gated would also make the story's headline
    // unreachable: every actor who reaches this shell holds `project:browse`, so
    // one browse-gated entry means the settings AREA door never disappears for
    // anyone. Reversible in one line if the read-only matrix is judged worth it.
    permission: 'repository:manage_access',
  },
  {
    id: 'workflow',
    group: 'work',
    href: '/settings/project/workflow',
    icon: Workflow,
    labelKey: 'nav.workflow',
    // VERIFIED: `workflowsService`'s module-private `assertProjectAdmin` asserts
    // `workflow:manage` (the helper's NAME predates MOTIR-2256's split — reading
    // the body rather than the name is the point, `notes.html` #231).
    permission: 'workflow:manage',
  },
  {
    id: 'approvals',
    group: 'work',
    href: '/settings/project/approvals',
    icon: ShieldCheck,
    labelKey: 'nav.approvals',
    // VERIFIED: `approvalGateSettingsService`'s `getSettings` / `updateSettings`
    // both assert `workflow:manage` through `projectAccessService.assertPermission`
    // (Story MOTIR-4925 · Subtask MOTIR-5170). The key is the shipped one for
    // *may you configure how work moves through this project* — a status graph and
    // an approval gate are the two things that decide when work may move, which is
    // also why this row sits directly after `workflow` rather than inside it. A
    // dedicated `gate:manage` is a reasonable later split and is NOT made here.
    //
    // ⚠️ MANAGE-ONLY, AND DECIDED (2026-09-13 · `design/projects/design-notes.md`
    // § ⭐ Approvals §6 · MOTIR-5394). MOTIR-5278 gave this entry a `project:browse`
    // VIEW key, which opened the room read-only to every browser and brought the
    // settings door back for every member. That is reverted: there is no read-only
    // view to show, so do not declare a view key here without a new decision.
    permission: 'workflow:manage',
  },
  {
    id: 'board',
    group: 'work',
    href: '/settings/project/board',
    icon: Columns3,
    labelKey: 'nav.board',
    // VERIFIED: `boardsService`'s module-private `assertBoardConfigAdmin` asserts
    // `board:configure` — again a name that predates the split.
    permission: 'board:configure',
  },
  {
    id: 'estimation',
    group: 'work',
    href: '/settings/project/estimation',
    icon: Gauge,
    labelKey: 'nav.estimation',
    // VERIFIED: `estimationService.assertEstimationAdmin` asserts
    // `estimation:manage`.
    permission: 'estimation:manage',
  },
  {
    id: 'fields',
    group: 'work',
    href: '/settings/project/fields',
    icon: Tag,
    labelKey: 'nav.fields',
    // VERIFIED: `customFieldsService`'s module-private `assertCanManage` asserts
    // `field:manage`.
    permission: 'field:manage',
  },
  {
    id: 'components',
    group: 'work',
    href: '/settings/project/components',
    icon: Box,
    labelKey: 'nav.components',
    // VERIFIED: `componentsService`'s module-private `assertCanManage` asserts
    // `component:manage`.
    permission: 'component:manage',
  },
  {
    id: 'bugs',
    group: 'work',
    href: '/settings/project/bugs',
    icon: Bug,
    labelKey: 'nav.bugs',
    // Story MOTIR-4927 · MOTIR-4938 — where Motir files the bugs it creates on its
    // own (`design/projects/design-notes.md` § Bugs). LAST in `work`, directly
    // under `components`: like `fields` and `components` it shapes where in the
    // tree a kind of work item is created, which is neither a credential
    // (`general`) nor Motir's own behaviour (`automation`) — §3.
    //
    // VERIFIED: `bugDestinationService.getSettings` and `setDestination` both
    // assert `project:administer` (§4 — there is no `bug:*` key to take).
    permission: 'project:administer',
  },
  {
    id: 'ai-planning',
    group: 'automation',
    href: '/settings/project/ai-planning',
    icon: Sparkles,
    labelKey: 'nav.aiPlanning',
    // Story 7.13 · MOTIR-919 — the AI-planning cadence page (auto-plan, AI
    // sprint planning, planner model + drafted explanations). Registered ABOVE
    // Rules in the Automation group: cadence configures the automatic planner,
    // the same family as automation rules. Browse-gated on purpose — every
    // member SEES the configuration, a non-admin reads it read-only (the design
    // asset's role-state; the write is re-gated in projectAiSettingsService).
    // The entry lights BOTH doors at once — the settings rail row AND the ⌘K
    // deep link (`settings-ai-planning`) — and keeps the route↔registry
    // totality test green.
    //
    // VERIFIED: `projectAiSettingsService.updateAiSettings` asserts
    // `ai:configure`. (Was browse-gated so "a non-admin reads it read-only" —
    // retired by the 2026-08-08 amendment. `ai:plan`, which a member DOES hold,
    // gates running the planner, not configuring it.)
    permission: 'ai:configure',
    // MOTIR-3332 / MOTIR-3338 add the LESSON LIBRARY as a DRILL-DOWN, the same
    // shape `roles` uses: the AI-planning page carries a read-only card that
    // previews what the planner has learned and links here; the library itself
    // needs a page that can be as long as it needs, and a settings page with a
    // Save footer is not one. `nestedRoutes` rather than a second entry, so no
    // new Automation row competes with the settings the library belongs to and
    // the rail keeps THIS row active on both screens (non-`exact` matching).
    //
    // ⚠️ The entry's key stays `ai:configure` and the destinations assert
    // `lesson:view` ON TOP of it, in `projectLessonsService` — before any call
    // to motir-ai. The two are deliberately not the same question: `ai:configure`
    // is "may you open the AI-planning area", `lesson:view` is "may you read what
    // this project taught its planner". Both sit at `admin` today, so nothing
    // observable moves; they come apart for a custom role composed by hand,
    // which is the case MOTIR-3336 split the keys to make expressible.
    nestedRoutes: [
      '/settings/project/ai-planning/lessons',
      '/settings/project/ai-planning/lessons/[lessonId]',
    ],
  },
  {
    id: 'hosted-agent',
    group: 'automation',
    href: '/settings/project/hosted-agent',
    // `Cloud` — the glyph the Run hosted button carries, so the row and the door
    // it configures read as one thing (design panel 0).
    icon: Cloud,
    labelKey: 'nav.hostedAgent',
    // Story MOTIR-6989 · MOTIR-6995, drawn by MOTIR-6991
    // (`design/settings/hosted-agent.mock.html` · `design/settings/design-notes.md`
    // § Hosted agent room). Which model a hosted run uses per difficulty. DIRECTLY
    // UNDER AI planning: both rooms choose a model Motir runs on this project's
    // behalf. Its own room rather than a card there — a different consumer, a
    // different audience (the view key below) and a different failure face.
    //
    // VERIFIED: `projectHostedAgentSettingsService.update` asserts `ai:configure`
    // — the key AI planning's writes assert. It gates the selects, Reset and the
    // Save footer; the page reads it through `settingsEntryKeys('hosted-agent')`.
    permission: 'ai:configure',
    // ⚠️ A DISTINCT VIEW KEY, DECIDED BY THE APPROVED DESIGN (MOTIR-6991), AND IT
    // BRINGS THE AREA DOOR BACK FOR ORDINARY MEMBERS on a hosted build.
    // `work_item:edit` is the key the hosted START asserts (`assertCanEdit` in
    // `hostedRunService`): whoever may press Run hosted may read which model it
    // will run on, and a member who sees *Project override for High* on the
    // picker has somewhere to find out what it means (the read-only panel 5).
    // VERIFIED: `projectHostedAgentSettingsService.get` asserts
    // `work_item:edit`. Its evidence row is in
    // `tests/settings/projectSettingsNav.test.ts`'s VIEW_KEY_EVIDENCE, and the
    // suites that pinned *a member is offered no settings area* now say which
    // build they mean.
    viewPermission: 'work_item:edit',
    // A BUILD fact (MOTIR-6995): absent off a deployment that runs no hosted
    // agents, and the route 404s there. Motir AI being DOWN keeps the row.
    hostedRunsOnly: true,
  },
  {
    id: 'translation',
    group: 'automation',
    href: '/settings/project/translation',
    icon: Languages,
    labelKey: 'nav.translation',
    // Story MOTIR-7738 · MOTIR-8830, drawn by MOTIR-8822
    // (`design/settings/auto-translate.mock.html` · `design/settings/design-notes.md`
    // § Auto-translate room). The project's Auto-translate work content switch and
    // the read-back of who changed it. DIRECTLY UNDER Hosted agent, above Rules: the
    // rooms that configure what Motir does on this project's behalf, and what it
    // costs, sit together; Rules is user-authored automation and stays last.
    //
    // VERIFIED (write key): `projectAutoTranslateSettingsService.updateSettings`
    // asserts `project:administer`. It gates the switch; the page reads it through
    // `settingsEntryKeys('translation')`.
    permission: 'project:administer',
    // ⚠️ A DISTINCT VIEW KEY, DECIDED BY THE PROJECT OWNER (2026-10-17, recorded in
    // the design notes), AND IT BRINGS THE AREA DOOR BACK FOR EVERY ACTOR WHO CAN
    // BROWSE THE PROJECT, viewers included, on EVERY build (the room has no build
    // flag). Seeing the setting follows reading the project's work items, which
    // `project:browse` gates: every role that reads them may read whether they are
    // auto-translated.
    // VERIFIED: `projectAutoTranslateSettingsService.getSettings` asserts
    // `project:browse`. Its evidence row is in
    // `tests/settings/projectSettingsNav.test.ts`'s VIEW_KEY_EVIDENCE, and the
    // suites that pinned *a member is offered no settings area* now say what they
    // mean.
    viewPermission: 'project:browse',
  },
  {
    id: 'automation',
    group: 'automation',
    href: '/settings/project/automation',
    icon: Bot,
    labelKey: 'nav.rules',
    // Story 6.6 lights up the reserved slot: a real route, ADMIN-ONLY end to end
    // (the verified Jira scope — no member/viewer read-only variant). The entry,
    // the page, and every route gate on the shipped 6.4.3 manage-project
    // predicate, so a non-admin never sees the nav row.
    //
    // VERIFIED, and the only entry already correct before this card: the PAGE
    // itself reads `getPermissions` and returns the no-access state unless
    // `held.has('automation:manage')`, and `automationRulesService` asserts the
    // same key. The row now names what the page already checks.
    permission: 'automation:manage',
  },
];

/**
 * The route entries — the set the totality test pairs 1:1 with the on-disk
 * `settings/project/**​/page.tsx` routes.
 *
 * This USED to be `PROJECT_SETTINGS_NAV` minus the reserved-slot entries, and it
 * is now the whole registry: MOTIR-4324 retired the reservation mechanism, so
 * every entry is a real route by construction. The name is kept because it is
 * what its call sites read it AS — "the destinations", the question the totality
 * test and the palette are asking — and because a route/row distinction
 * returning is a filter to restore here rather than a symbol to re-thread. The
 * live row/route distinction is {@link PROJECT_SETTINGS_ROUTE_PATHS} below, which
 * is a different one: nested drill-down routes are reachable but are not rows.
 */
export const PROJECT_SETTINGS_ROUTES: SettingsNavEntry[] = PROJECT_SETTINGS_NAV;

/**
 * EVERY reachable settings destination — each real entry's own `href` plus the
 * drill-down routes it declares in {@link SettingsNavEntry.nestedRoutes}. This is
 * the set the totality test pairs 1:1 with the on-disk
 * `settings/project/**​/page.tsx` routes.
 *
 * The distinction from {@link PROJECT_SETTINGS_ROUTES} is exactly the rail's: a
 * nested route is REACHABLE (so it must be accounted for) but is not a ROW (so it
 * has no icon, no label, and no place in the nav or the command palette).
 */
export const PROJECT_SETTINGS_ROUTE_PATHS: string[] = PROJECT_SETTINGS_ROUTES.flatMap((entry) => [
  entry.href,
  ...(entry.nestedRoutes ?? []),
]);

/** Whether `pathname` is inside the project-settings area. */
export function isProjectSettingsPath(pathname: string): boolean {
  return pathname === PROJECT_SETTINGS_ROOT || pathname.startsWith(`${PROJECT_SETTINGS_ROOT}/`);
}

/** Whether a registry entry is the active route for `pathname`. */
export function isSettingsEntryActive(entry: SettingsNavEntry, pathname: string): boolean {
  if (!entry.href) return false;
  if (entry.exact) return pathname === entry.href;
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}

/**
 * The key that opens an entry's DOOR — its {@link SettingsNavEntry.viewPermission}
 * when it declares one, else its {@link SettingsNavEntry.permission} (Task
 * MOTIR-5193).
 *
 * The ONE place that default is applied. The rail row, the area door and the
 * destination guard (`_guard.tsx`) all read the view key through here, so they
 * cannot disagree about what opens a room — the property the one-key model had
 * structurally, kept by routing every reader through one function.
 */
export function settingsEntryViewKey(entry: SettingsNavEntry): PermissionKey {
  return entry.viewPermission ?? entry.permission;
}

/**
 * The entries visible to an actor holding `held`. Every entry gates on its VIEW
 * key ({@link settingsEntryViewKey}) — which is its `permission` unless it
 * declares a distinct `viewPermission` — so an actor holding no key that opens a
 * room sees NOTHING: the whole area filters away, no nav leak.
 *
 * ⚠️ HIDING IS PRESENTATION, NEVER ENFORCEMENT. A row this drops is still
 * reachable by URL; what refuses it is the destination's own guard (MOTIR-2469)
 * and, behind that, the service gate whose key the entry names. Do not read a
 * filtered rail as a security boundary.
 *
 * `available` is the second axis (MOTIR-4243): a {@link SettingsNavEntry.cloudOnly}
 * row is dropped on a build that does not have the capability, whatever the
 * actor holds. It DEFAULTS CLOSED — see {@link SettingsNavAvailability}.
 */
export function visibleSettingsNav(
  held: SettingsNavPermissions,
  entries: SettingsNavEntry[] = PROJECT_SETTINGS_NAV,
  available: SettingsNavAvailability = NO_CLOUD_CAPABILITIES,
): SettingsNavEntry[] {
  return entries.filter(
    (entry) => isSettingsEntryAvailable(entry, available) && held.has(settingsEntryViewKey(entry)),
  );
}

/**
 * Whether the project-settings AREA has anything behind it for this actor — the
 * predicate the shell's **Project settings** door gates on (design panel 1).
 *
 * A per-entry filter does not cover this on its own: filtering every entry away
 * leaves a perfectly valid EMPTY rail behind a perfectly valid link, which is a
 * door onto a corridor. Expressed here, beside the filter it quantifies over, so
 * the door and the rows can never disagree about what the area contains — which
 * is why it takes the SAME `available` argument (MOTIR-4243) rather than
 * quantifying over a rail the caller is not going to render, and reads the SAME
 * view key ({@link settingsEntryViewKey}) the rows gate on (MOTIR-5193).
 *
 * `entries` defaults to the registry; it is injectable for the same reason
 * {@link visibleSettingsNav}'s is — so the predicate is assertable over a fixture.
 */
export function hasVisibleSettingsArea(
  held: SettingsNavPermissions,
  available: SettingsNavAvailability = NO_CLOUD_CAPABILITIES,
  entries: SettingsNavEntry[] = PROJECT_SETTINGS_NAV,
): boolean {
  return entries.some(
    (entry) => isSettingsEntryAvailable(entry, available) && held.has(settingsEntryViewKey(entry)),
  );
}

/**
 * Group a flat entry list into the rail's ordered, non-empty groups. Used by the
 * nav (one `SidebarSection` per group) and assertable in isolation.
 */
export function groupSettingsNav(
  entries: SettingsNavEntry[],
): { group: SettingsNavGroup; entries: SettingsNavEntry[] }[] {
  return SETTINGS_NAV_GROUP_ORDER.map((group) => ({
    group,
    entries: entries.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}

/**
 * The RETIRED project-settings routes — pages that exist on disk only to
 * PERMANENTLY redirect (Story MOTIR-6168 · MOTIR-6466: the Roles room moved to
 * workspace settings). Not destinations, so not in
 * {@link PROJECT_SETTINGS_ROUTE_PATHS}, the rail or the palette; listed so the
 * route ↔ registry totality test still accounts for every `page.tsx`.
 */
export const PROJECT_SETTINGS_RETIRED_ROUTES: string[] = [
  '/settings/project/roles',
  '/settings/project/roles/[roleKey]',
  '/settings/project/roles/[roleKey]/edit',
  '/settings/project/roles/new',
];
