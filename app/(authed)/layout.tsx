import { Suspense, type CSSProperties, type ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { assertTwoFactorCompliance } from '@/lib/auth/twoFactorGate';
import { getWorkspaceContext } from '@/lib/workspaces';
import { redirectIfOrganizationSuspended } from '@/lib/organizations/suspensionRedirect';
import { workspacesService } from '@/lib/services/workspacesService';
import { platformStaffRepository } from '@/lib/repositories/platformStaffRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { orgCan } from '@/lib/organizations/capabilities';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { onboardingSubstrateService } from '@/lib/services/onboardingSubstrateService';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { notificationsService } from '@/lib/services/notificationsService';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { resumeGateEnabled } from '@/lib/onboarding/resumeVisibility';
import { isCloud, isCloudBilling } from '@/lib/billing/availability';
import { isHostedRunsAvailable } from '@/lib/hostedRuns/availability';
import { hasMotirRepository } from '@/lib/environmentConfig/motirRepositories';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveReconsentHold } from '@/lib/legal/reconsentGate';
import { legalIndexUrl as resolveLegalIndexUrl } from '@/lib/legal/links';
import { docsIndexUrl as resolveDocsIndexUrl } from '@/lib/docs/links';
import { toWorkspaceSummaryDTO } from '@/lib/mappers/workspaceMappers';
import { ToastProvider } from '@/components/ui/Toast';
import { AppLayout } from '@/components/ui/AppLayout';
import { SidebarDrawer } from '@/components/ui/SidebarDrawer';
import { TopNav } from './_components/TopNav';
import { StaffSessionBar } from './_components/StaffSessionBar';
import { hasStaffSessionCookie } from '@/lib/platform/staffSession';
import { SidebarNav } from './_components/SidebarNav';
import { HelpMenu } from './_components/HelpMenu';
import { ShellTierNav } from './_components/ShellTierNav';
import { CommandPaletteProvider } from './_components/CommandPaletteProvider';
import { CreateIssueProvider } from './_components/CreateIssueProvider';
import { ProjectAccessProvider } from './_components/ProjectAccessProvider';
import { ReportProvider } from './_components/ReportProvider';
import { AppCommandPalette } from './_components/AppCommandPalette';
import { OnboardingResumeProvider } from './_components/OnboardingResumeProvider';
import { WorkbenchLive } from './workbench/_components/WorkbenchLive';
import { CoordinatedRefreshProvider } from '@/lib/navigation/coordinatedRefresh';
// The drawer's utility strip (MOTIR-2373) renders the SAME three controls the
// top bar's four-slot budget displaced below `md` — not copies of them.
import { ReportButton } from './_components/ReportButton';
import { ThemeToggle } from './_components/ThemeToggle';
import { BuildInPublicButton } from './_components/build-in-public/BuildInPublicButton';
import { BuildingInPublicHeaderLink } from './_components/build-in-public/BuildingInPublicHeaderLink';
import { PlanWithAIFab } from '@/components/planning/PlanWithAIFab';
import { PlanningWorkspaceOverlay } from '@/components/planning/PlanningWorkspaceOverlay';
import { ApprovalOverlay } from '@/components/approvals/ApprovalOverlay';
import { AccountDeletionBanner } from './_components/AccountDeletionBanner';
import { OrganizationClosingBanner } from './_components/OrganizationClosingBanner';
import {
  isWorkspaceTierRevealed,
  preferredOrganizationId,
  scopeWorkspacesToActiveOrg,
} from '@/lib/workspaces/tierDisclosure';
import { AI_PLANNING_REQUIREMENT, satisfiesRequirement } from '@/lib/settings/projectNavAccess';

// Layout for every authenticated route. Story 1.5 migrates this from a bare
// top-nav + centered <main> into the full AppLayout shell: a full-width top
// nav, a persistent project-nav sidebar (≥md) / off-canvas drawer (<md), and
// the content region. The proxy.ts gate already bounces unauthenticated
// requests to /sign-in; we re-check here because the proxy only does an
// optimistic cookie-presence check, and we need the session to populate the
// user menu + workspace switcher anyway.
//
// Data flow into the shell slots:
//   - TopNav   ← workspaces + active workspace + user + THE PROJECT. The
//                project switcher came BACK from the sidebar in MOTIR-2556:
//                the bar carries the whole context path (`org › workspace ›
//                project`), so the switcher, the archived state and the
//                create-first door all live in its tier nav now.
//   - SidebarNav ← the active project only, for its nav sections and the
//                settings-area header swap. It no longer takes `projects` or
//                `aiConfigured`: the rail has no project control to feed.
//   - SidebarDrawer's header ← the same ShellTierNav at placement="drawer",
//                which carries the ANCESTORS (`org › workspace`) at every
//                width — that is where the bar's below-md band sends them.

export default async function AuthedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) {
    // A STALE staff "View as" session (MOTIR-749): the gate answers a session
    // that is over as signed out — fail closed — and this sends the operator
    // through the door that records its end, clears the cookie and lands them
    // on the ended page, instead of a sign-in screen they do not need.
    if (await hasStaffSessionCookie()) redirect('/api/staff-session/clear');
    redirect('/sign-in');
  }
  // Inside a staff session the TARGET's identity is `session.user`; the
  // operator's own is `session.impersonation.operator`.
  const staffSession = session.impersonation ?? null;

  // ⚠️ THE GATE ABOVE STAYS FIRST AND STAYS SEQUENTIAL (MOTIR-3433). Everything
  // below runs only for a request that already has a session; `getSession()` is
  // awaited and the redirect thrown before any of it is started, so nothing
  // tenant-scoped is even STARTED for an unauthenticated visitor.
  // `tests/components/authed-layout-gate.test.ts` asserts the ordering rather
  // than leaving it to inspection.
  //
  // (This clause used to add "which is what keeps `app/(authed)/loading.tsx`
  // inside the gate". There is no group `loading.tsx` any more — it was removed
  // because a boundary here flushes a 200 response head before the page runs
  // and destroys the `notFound()` 404 on every route beneath it (MOTIR-3492
  // carries the finding and what the frame owes). The ordering rule above
  // stands on its own.)
  //
  // These four are INDEPENDENT of each other and were four sequential round
  // trips — which is what a TYPED URL pays before any HTML body exists at all,
  // and therefore before the skeleton that is supposed to appear immediately
  // can be rendered. The boundary alone would not have answered the reported
  // case; this is why. One `Promise.all`, so the shell's own reads cost one
  // round trip instead of four:
  //
  //   · getWorkspaceContext()      — resolves the active workspace. Reaches
  //                                  `getSession()` again, but through the
  //                                  request-memoised helper (MOTIR-2453), so
  //                                  it is not a second validation.
  //   · listUserWorkspaces()       — the switcher's list.
  //   · findStandingByUserId()     — platform standing; the ONLY thing that
  //     (MOTIR-2896)                 surfaces the account menu's staff-only
  //                                  "Platform admin" door. Read fresh per
  //                                  request off `platformRole` rather than
  //                                  carried in the session, so a revoked
  //                                  operator loses the door on their next
  //                                  request, not their next sign-in
  //                                  (`docs/decisions/platform-staff-auth.md`
  //                                  §1). A boolean crosses into the client:
  //                                  the ROLE is a server-side identity
  //                                  assertion and nothing in the shell renders
  //                                  it.
  //   · cookies()                  — the org cookie, read here rather than at
  //                                  its use site below.
  //
  // Everything AFTER this point depends on `ctx` or on one of these results and
  // keeps its existing order. This is the only performance work in the card: no
  // query changed, no index, no cache, and the shell renders exactly what it
  // rendered before.
  //   · resolveReconsentHold()      — THE RE-CONSENT HOLD (Story 8.4 ·
  //     (MOTIR-1135)                    MOTIR-1135). Joined to this wave rather
  //                                     than added as a fifth sequential round
  //                                     trip, for the reason the paragraph above
  //                                     gives: it runs on every signed-in page
  //                                     load. One indexed read of at most three
  //                                     rows, and `null` — carry on — for every
  //                                     reader who is current, which is all of
  //                                     them until a document moves.
  //   · assertTwoFactorCompliance()  — the 2FA enforcement gate (Story MOTIR-1215
  //     (MOTIR-3648)                    · MOTIR-3648), held in this wave for the
  //                                     same reason and at the same cost. It
  //                                     redirects by THROWING, so its rejection
  //                                     leaves the `Promise.all` and the
  //                                     framework answers it — nothing below here
  //                                     runs for a visitor being held, which is
  //                                     exactly how it wins the ordering the
  //                                     comment under the wave records.
  const [ctx, workspaceModels, platformStanding, cookieStore, reconsentHold] = await Promise.all([
    // A SUSPENDED organization (MOTIR-748) refuses its members at the access
    // gate; on a page that refusal is the notice redirect, thrown from inside
    // this wave exactly as the 2FA gate's is.
    redirectIfOrganizationSuspended(getWorkspaceContext()),
    workspacesService.listUserWorkspaces(session.user.id),
    platformStaffRepository.findStandingByUserId(session.user.id),
    cookies(),
    // A staff session (MOTIR-749) holds the operator to neither of the
    // CUSTOMER's personal gates: agreeing to terms and enrolling a second
    // factor are the customer's acts, never staff's on their behalf (and both
    // are refused inside a session). The operator's own 2FA is enforced at the
    // console.
    staffSession ? null : resolveReconsentHold(session.user.id),
    staffSession ? undefined : assertTwoFactorCompliance(session.user.id),
  ]);

  // ⚠️ ENFORCED AFTER THE WAVE, NOT INSIDE IT — and that placement is the
  // recorded answer to `design/auth/design-notes.md`'s planning flag 4, which
  // asks MOTIR-1135 to ORDER the two full-page holds that both want this slot
  // rather than discover the ordering later. **2FA first, re-consent second**:
  // who is signing in, then what they are agreeing to. A gate that throws Next's
  // redirect sentinel from inside the `Promise.all` above short-circuits it
  // before this line is reached, so it wins by construction — which is the shape
  // Story MOTIR-1215's enforcement gate takes. `lib/legal/reconsentGate.ts`
  // carries the full reasoning; the split into resolve-then-enforce exists for
  // this and nothing else.
  if (reconsentHold) redirect(reconsentHold.destination);

  const isPlatformStaff = platformStanding?.platformRole != null;

  // The active ORGANIZATION (Story 6.10.5 — the shell org control). It must
  // agree with the active WORKSPACE: a user who belongs to workspaces across
  // MULTIPLE orgs (e.g. they accepted an invite into another org's workspace)
  // has an active org === the org that owns the workspace they're actually in,
  // so the shell's org + workspace tiers never disagree. The org cookie is only
  // the fallback when there's no active workspace (e.g. an org-only member);
  // the service re-validates membership, so a stale/forged id falls back to the
  // user's first org. PROGRESSIVE DISCLOSURE: the org is ALWAYS the anchor, but
  // the WORKSPACE switcher shows only when the active org has ≥2 workspaces — so
  // the workspace list handed to the shell is scoped to the active org, and ITS
  // length is the reveal test (in ShellTierNav).
  const orgCookie = cookieStore.get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const activeWorkspaceModel = ctx
    ? (workspaceModels.find((w) => w.id === ctx.workspaceId) ?? null)
    : null;
  // The ONE rule for "the active org" — `resolveActiveOrganizationAsShell` and
  // every org settings pane compose the same helper (MOTIR-8776).
  const preferredOrgId = preferredOrganizationId(activeWorkspaceModel, orgCookie);
  const currentOrg = await organizationsService.resolveActiveOrganization(
    session.user.id,
    preferredOrgId,
  );
  const activeOrg = currentOrg
    ? {
        id: currentOrg.organization.id,
        name: currentOrg.organization.name,
        role: currentOrg.role,
      }
    : null;
  // The org list and whether this account may create an org (§4.5 — the org
  // menu's "Create organization" door, MOTIR-8779) are independent reads, so
  // they share one round trip. Both are skipped for an account with no org,
  // whose shell renders no org control at all.
  const [orgs, canCreateOrganization] = currentOrg
    ? await Promise.all([
        organizationsService.listUserOrganizations(session.user.id),
        entitlementsService.canCreateOrganization(session.user.id),
      ])
    : [[], false];
  // Whether this is a Motir cloud build — gates the org menu's "Billing & plans"
  // row (Story 8.1.7); off-cloud the commercial surface does not exist (ADR §6).
  const cloudBilling = isCloudBilling();
  const scopedWorkspaceModels = scopeWorkspacesToActiveOrg(workspaceModels, activeOrg?.id ?? null);
  const workspaces = scopedWorkspaceModels.map(toWorkspaceSummaryDTO);
  // PROGRESSIVE DISCLOSURE of the workspace tier (MOTIR-3502 · organization-tier
  // §6). One number, computed here from the org-scoped list, threaded to every
  // entry point that names the tier — the switcher (via ShellTierNav), the user
  // menu's "Workspace settings" row, the rail's no-project settings door — so
  // the shell cannot disagree with itself. `/settings/workspace` re-derives the
  // SAME verdict server-side via `resolveWorkspaceTierDisclosure`, which shares
  // these two helpers; a shell that hides a door to a page that still renders is
  // the failure a second predicate would produce.
  const workspaceTierRevealed = isWorkspaceTierRevealed(scopedWorkspaceModels.length);
  // Where the Help menu's `Legal documents` row points — `null` on a
  // deployment that has configured no legal documents, and then the row does
  // not render at all (MOTIR-4010; re-homed off the rail by MOTIR-4239).
  // Resolved here because the manifest is a server-side read and `HelpMenu` is
  // a client component. It is a synchronous parse of one environment value, so
  // it joins no wave and costs no round trip.
  const legalIndexUrl = resolveLegalIndexUrl();
  // Where the Help menu's `Docs` row points — `null` on a deployment that has
  // configured no documentation url, and then that row does not render either
  // (MOTIR-4167; re-homed off the rail by MOTIR-4239). The same shape as the
  // line above, for the same reason: the documentation left this repository
  // with the public reading surface (MOTIR-3932), so the row reads the
  // operator's configuration, server-side.
  const docsIndexUrl = resolveDocsIndexUrl();

  // Project data — only meaningful when there's an active workspace. Without
  // one the sidebar hides the project header + project-scoped nav, so skip
  // the queries entirely.
  const projects = ctx ? await projectsService.listProjects(ctx.workspaceId, session.user.id) : [];
  const activeProject = ctx
    ? await projectsService.getActiveProject(session.user.id, ctx.workspaceId)
    : null;
  // With NO active project — a reader who can enter none of the workspace's
  // projects (Story MOTIR-6169 · MOTIR-6548) — the empty switcher offers
  // "Create project" only to someone who could enter what they made. Read only
  // in that state, so the everyday request pays nothing for it.
  const canCreateProject =
    ctx && !activeProject
      ? await projectsService.canOfferCreateProject(session.user.id, ctx.workspaceId)
      : true;

  // The actor's PERMISSION SET on the active project — ONE round-trip
  // (`getPermissionsDTO`, Story MOTIR-2255) feeding three consumers:
  //   * the whole set → ProjectAccessProvider (Subtask MOTIR-2466): every
  //     role-gated affordance can ask the permission its action needs by name.
  //   * `canEdit` → the create-issue / report providers (Story 6.4.6):
  //     the affordances render disabled with a tooltip for a viewer / a member
  //     on a limited project.
  //   * the keys → SidebarNav's settings-nav registry filter (Subtask
  //     MOTIR-2468): which rail entries render inside the project-settings area,
  //     whether the bottom nav offers the AREA DOOR at all, and which ⌘K deep
  //     links the palette offers. Each registry entry names the key its own
  //     destination's server gate asserts.
  // No active project → there's nothing to edit (the affordances are hidden) and
  // no settings area to enter.
  //
  // ⚠️ This REPLACED the three-boolean settings-capabilities read (Subtask
  // 6.5.2) rather than joining it — two calls would double the round trip for
  // no gain, and MOTIR-2466's gate asserts this file names no other
  // `projectAccessService` method. The substitution is provably
  // behaviour-neutral, not merely believed to be: `lib/projects/access.ts`
  // defines each of the three booleans as `hasPermission(i, <key>)`, and
  // `hasPermission` is `resolvePermissions(i).has(key)` over the very set
  // resolved here. `tests/components/project-access-provider.test.tsx` asserts
  // the equivalence across every access level × workspace role × project role.
  const actorPermissions =
    ctx && activeProject
      ? await projectAccessService.getPermissionsDTO(activeProject.id, {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        })
      : null;
  // An empty set for "no active project" — the same direction the removed
  // `?? false` defaults had: nothing resolved grants nothing.
  const permissions = actorPermissions?.permissions ?? [];
  const held = new Set<PermissionKey>(permissions);
  const canEdit = held.has('work_item:edit');
  // The project-admin MANAGE gate — the work-item ⋯ menu's Delete action (2.8.4)
  // consumes it via ProjectAccessProvider, mirroring deleteWorkItem's assertCanManage.
  const canManage = held.has('project:administer');
  // The keys the shell's registry-driven surfaces filter on (Subtask
  // MOTIR-2468): the settings rail, its area door, and the ⌘K deep links. The
  // ARRAY crosses to the client islands (a Set cannot); they rebuild the Set.
  // `undefined` with no active project — there is no area to enter.
  const settingsPermissions = actorPermissions?.permissions;

  // The single stateful build-in-public header slot (Story 6.17 · design
  // §6.17.6 · Panel 12), resolved server-side here so TopNav needs no client
  // access read and a single `router.refresh()` after a toggle swaps its state
  // (the slot is server-rendered — page-state-after-mutation surface kind 2):
  //
  // - `buildInPublicProjectKey` (Subtask 6.17.3) — the PRIMARY "Build in public"
  //   CTA, shown only to a project ADMIN on a project that is NOT yet `public`.
  //   Null otherwise (no project / non-admin / already public).
  // - `buildingInPublic` (Subtask 6.17.7) — true once the active project IS
  //   `public`, when the SAME slot becomes the clickable "Building in public"
  //   status indicator linking to settings. Shown to ALL team members (no
  //   `canManage` read — status to the team, control gated at the destination;
  //   the GitHub / Linear / Notion model, design §6.17.6c).
  //
  // The two are mutually exclusive by construction (a project is either public
  // or not), so the slot renders exactly ONE — never both, never empty.
  //
  // ⚠️ BOTH are additionally gated on `isCloud()` (MOTIR-4035). Build-in-public
  // is a CLOUD capability: off-cloud `app/api/public/*` serves nothing, so the
  // CTA would invite a publish that the service refuses, and the "Building in
  // public" indicator would link a team to a reading surface that answers 404.
  // The slot is then simply empty, which is the correct rendering of a
  // capability this build does not have.
  const publicProjectsAvailable = isCloud();
  // The settings registry's hosted-runs axis (MOTIR-6995): the Hosted agent room
  // exists only on a build that runs hosted agents. A build fact, not a live read.
  const hostedRunsAvailable = isHostedRunsAvailable();
  // The settings registry's project axis (MOTIR-9966): the Environment room exists
  // only for a project holding a repository Motir hosts. One read of the set, and
  // only for an actor who may browse the project at all.
  const motirRepositoriesPresent =
    ctx && activeProject && held.has('project:browse')
      ? hasMotirRepository(
          await projectRepoSetService.listByProject(activeProject.id, {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
          }),
        )
      : false;
  const buildInPublicProjectKey =
    publicProjectsAvailable && canManage && activeProject && activeProject.accessMode !== 'public'
      ? activeProject.identifier
      : null;
  const buildingInPublic =
    publicProjectsAvailable && !!activeProject && activeProject.accessMode === 'public';

  const activeWorkspaceId = ctx?.workspaceId ?? null;

  // The "Plan with AI" universal launcher (MOTIR-1299) — the hero entrance to
  // the AI planning workspace. Shown only when AI planning is wired (the
  // cloud/self-host gate, the same `isMotirAiConfigured` probe the create
  // modal's "Draft with AI" uses) AND there's an active project to plan into.
  // A server-side boolean so the client launcher needs no `server-only` read.
  const aiPlanningConfigured = isMotirAiConfigured();
  // MOTIR-6175 — AND an actor who may plan: `ai:plan`, the key every planning
  // write asserts and the one the ⌘K twin already checks. The pill and the orb
  // opened the planning workspace for a Viewer, whose first message was refused.
  const showPlanWithAi =
    aiPlanningConfigured &&
    Boolean(activeProject) &&
    satisfiesRequirement(AI_PLANNING_REQUIREMENT, held);

  // The server-cheap gate for the labeled "Resume onboarding" door (MOTIR-1533;
  // design MOTIR-1548): AI configured, an active project, and its onboarding
  // never finished (`onboardingRanAt` still null). Only when this holds does the
  // OnboardingResumeProvider do the client `/api/ai/pre-plan` read that reveals
  // the sidebar row + ⌘K twin — so no motir-ai call is added to a page render
  // that could never show the door.
  const resumeOnboardingEnabled = resumeGateEnabled({
    aiPlanningConfigured,
    hasActiveProject: Boolean(activeProject),
    onboardingRanAt: activeProject?.onboardingRanAt,
  });

  // WHAT THE PLAN WINDOW WILL SAY IT IS READING (MOTIR-4768) — resolved HERE,
  // once, by the Server Component that already has the project, and handed down
  // as a prop. The overlay is a client island and may not reach a service; it
  // also must add no request to its own open, which is why this is a prop rather
  // than a fetch on mount (AC4).
  //
  // ⚠️ `null` FOR AN ESTABLISHED PROJECT, AND THAT IS BOTH HALVES OF THE ANSWER.
  // A project whose first plan has been approved has no reading state to show
  // (AC5) — and it also pays for no read, because the question is not asked. The
  // marker is the right discriminator for THAT question and only that one: it
  // says whether this project has ever had a plan approved, which is exactly
  // what decides whether a session is about to read the project for the first
  // time. It is NOT a gate on the window (MOTIR-4765 removed that, and it is not
  // coming back through this prop) — a never-onboarded project opens the
  // workspace either way; this only decides what it SAYS while it opens.
  const planningSubstrate =
    ctx && activeProject && !activeProject.onboardingRanAt
      ? await onboardingSubstrateService.readOnboardingSubstrate(activeProject.id, {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        })
      : null;

  // The notification bell's initial unread badge (Subtask 5.7.5) — the cheap
  // partial-index aggregate (5.7.4 getUnreadCount), resolved once here and
  // threaded into TopNav so the badge paints without a client round-trip; the
  // bell then polls + refreshes on navigation. Null when there's no active
  // workspace (the per-workspace bell is hidden).
  const initialUnreadCount = ctx
    ? (
        await notificationsService.getUnreadCount({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        })
      ).unreadCount
    : null;

  return (
    <ToastProvider>
      {/* CommandPaletteProvider owns the ⌘K palette + `?` cheatsheet open state
          and registers their global shortcuts; it wraps the whole shell so the
          TopNav "Search" trigger and the AppCommandPalette below share one
          context. */}
      <CommandPaletteProvider>
        <CreateIssueProvider canEdit={canEdit} aiConfigured={isMotirAiConfigured()}>
          <ProjectAccessProvider permissions={permissions}>
            {/* ReportProvider (Subtask 6.11.7) owns the in-app report-widget
                modal + open state, mounted once so the top-nav and inbox-header
                "Report" triggers drive the same dialog. The widget posts to the
                6.11.4 intake for the active project; mounted only when there's a
                project the actor can edit (the intake rejects a viewer 403). */}
            <ReportProvider
              projectKey={activeProject?.identifier ?? null}
              canEdit={canEdit}
              // The report widget's "Debug with Motir AI" offer (MOTIR-7050)
              // rides the ORB's gate, so the two can never disagree about who
              // may start a Motir AI turn.
              canDebug={showPlanWithAi}
            >
              {/* OnboardingResumeProvider (MOTIR-1533) resolves the in-progress
                  onboarding signal ONCE and shares it with the SidebarNav rail
                  row + the ⌘K twin below, so neither fetches on its own. */}
              <OnboardingResumeProvider
                enabled={resumeOnboardingEnabled}
                activeProjectId={activeProject?.id ?? null}
              >
                {/* ⚠️ THE WORKBENCH'S LIVE HOST, AND IT BELONGS HERE RATHER THAN IN
                  THE WORKBENCH PAGE (Story MOTIR-5238 · MOTIR-5242, moved by
                  MOTIR-5245). The approval overlay below is mounted ONCE at this
                  level — it opens over any authed page from its address — so a
                  provider inside `/workbench` is not an ancestor of it, and the
                  overlay read the context's QUIET default and was never told its
                  subject had moved. Everything that reads the signal is inside
                  this: `{children}` (so the Workbench's five lists and its strip
                  are) and `<ApprovalOverlay />` (so an open approval is).

                  ⚠️ IT OPENS NO CONNECTION ANYWHERE ELSE. The component gates its
                  own subscription on a live surface being on screen — the
                  Workbench, or an open approval — and refreshes only on the
                  Workbench, so mounting it in the shell does not make the item
                  page, the board, the backlog or the roadmap live. That boundary
                  is the story's own, and it is enforced in the component rather
                  than by where it is mounted.

                  ⚠️ AND IT SITS INSIDE `CoordinatedRefreshProvider`, which holds
                  the shell's `router.refresh()` calls to ONE in flight (bug
                  MOTIR-6640). The nudge and the planning overlay's approve both
                  refresh for the same write, and two overlapping refreshes can
                  make Next fall back to a full document load. */}
                <CoordinatedRefreshProvider>
                  <WorkbenchLive>
                    <AppLayout
                      /* THE APP-WIDE DELETION BANNER (MOTIR-3704) — design
                     DECISION 4's second cancel door, mounted ONCE here rather
                     than per page, because *"a grace period is only reachable
                     if the reader can find it"* and a reader who changes their
                     mind on day nine opens the app, not Settings › Data &
                     privacy. It renders `null` for the overwhelming majority of
                     requests (no open deletion request), and it is a SERVER
                     component so that a cancel from EITHER door clears it on a
                     `router.refresh()` — see its own file for why an island
                     seeded at mount could not do that.

                     THE ORGANIZATION CLOSING BAR (MOTIR-6403) sits beneath it —
                     both may show, account bar first, two lines never merged
                     (design MOTIR-6390 panel 5). It renders `null` unless the
                     active organization is closing. */
                      banner={
                        <>
                          {/* THE STAFF SESSION BAR (MOTIR-749, design Panel 5) —
                              first, above every other banner and the TopNav, on
                              every page of a staff "View as" session. Not
                              dismissible: it is the operator's constant reminder
                              that this is the customer's live app. */}
                          {staffSession ? <StaffSessionBar session={staffSession.session} /> : null}
                          <AccountDeletionBanner userId={session.user.id} />
                          {activeOrg ? (
                            <OrganizationClosingBanner
                              userId={session.user.id}
                              organizationId={activeOrg.id}
                              orgName={activeOrg.name}
                              isOwner={orgCan(activeOrg.role, 'deleteOrganization')}
                            />
                          ) : null}
                        </>
                      }
                      topNav={
                        <TopNav
                          activeOrg={activeOrg}
                          orgs={orgs}
                          workspaces={workspaces}
                          activeWorkspaceId={activeWorkspaceId}
                          activeProject={activeProject}
                          canCreateProject={canCreateProject}
                          projects={projects}
                          aiConfigured={aiPlanningConfigured}
                          user={{ name: session.user.name, email: session.user.email }}
                          platformStaff={isPlatformStaff}
                          initialUnreadCount={initialUnreadCount}
                          buildInPublicProjectKey={buildInPublicProjectKey}
                          buildingInPublic={buildingInPublic}
                          cloudBilling={cloudBilling}
                          canCreateOrganization={canCreateOrganization}
                          showPlanWithAi={showPlanWithAi}
                        />
                      }
                      sidebar={
                        <SidebarNav
                          activeProject={activeProject}
                          variant="rail"
                          settingsPermissions={settingsPermissions}
                          user={{ name: session.user.name, email: session.user.email }}
                          organization={
                            activeOrg
                              ? {
                                  name: activeOrg.name,
                                  isOrgAdmin: orgCan(activeOrg.role, 'manageOrgSettings'),
                                }
                              : null
                          }
                          workspace={
                            activeWorkspaceModel ? { name: activeWorkspaceModel.name } : null
                          }
                          billingAvailable={cloudBilling}
                          workspaceTierRevealed={workspaceTierRevealed}
                          publicProjectsAvailable={publicProjectsAvailable}
                          hostedRunsAvailable={hostedRunsAvailable}
                          motirRepositoriesPresent={motirRepositoriesPresent}
                          helpMenu={
                            <HelpMenu docsIndexUrl={docsIndexUrl} legalIndexUrl={legalIndexUrl} />
                          }
                        />
                      }
                    >
                      {/* The content column RESERVES the floating orb's footprint
                      (MOTIR-2763). `PlanWithAIFab` below is `fixed right-5
                      bottom-5 h-14 w-14 z-40`, so it owns the bottom-right
                      viewport rect `y ∈ [bottom−76, bottom−20]` on every screen
                      it mounts on — while participating in NO page's flow. At
                      the end of a scrolled page the last block used to land
                      inside that band, and a bottom-anchored control there
                      (the /items pager, /home's Next) stopped receiving its own
                      clicks: still perfectly visible, but the orb won the hit
                      test.

                      The reservation is made ONCE, here, at the mount that
                      creates the obstruction — not on each pager, which would
                      be a growing list every future bottom-anchored control has
                      to remember to join. It is conditional on the same
                      `showPlanWithAi` that decides whether the orb ships at all,
                      so a workspace with AI planning unconfigured pays nothing.

                      It travels as a CUSTOM PROPERTY rather than a bare padding
                      class because the surfaces that size themselves against the
                      fold have to subtract the same amount, and one of them
                      (`packages/design-system/theme.css`'s 3d-immersive board
                      column) is a stylesheet that cannot read a React prop.
                      6rem = the orb's 76px reach + a visible gap. See
                      `design/shell/design-notes.md`. */}
                      {/* KEYED ON THE ACTIVE PROJECT (Story MOTIR-6169 · MOTIR-6548): when
                      a reader's project stops being enterable — their scope
                      changed, the project went Members only, they were removed —
                      the next request resolves another project or none, and a
                      client island seeded from the old one's props must not keep
                      rendering it. A new key remounts every island below; an
                      unchanged one costs nothing (the lesson: a tenant-context
                      switch invalidates client islands the way a mutation does). */}
                      <div
                        key={activeProject?.id ?? 'no-project'}
                        style={
                          {
                            '--shell-bottom-clearance': showPlanWithAi ? '6rem' : '1.5rem',
                          } as CSSProperties
                        }
                        className="px-4 pt-6 pb-(--shell-bottom-clearance) sm:px-6 lg:px-8"
                      >
                        {children}
                      </div>
                    </AppLayout>

                    {/* Mobile off-canvas nav — opened by the TopNav hamburger (<md). The
            drawer is portaled, so it lives at the layout root rather than in an
            AppLayout slot. Its header carries the same tenancy-tier cluster (org
            control + the workspace switcher at ≥2 workspaces) the top nav shows,
            since the drawer replaces the top nav on mobile. */}
                    <SidebarDrawer
                      header={
                        <ShellTierNav
                          activeOrg={activeOrg}
                          orgs={orgs}
                          workspaces={workspaces}
                          activeWorkspaceId={activeWorkspaceId}
                          cloudBilling={cloudBilling}
                          canCreateOrganization={canCreateOrganization}
                          placement="drawer"
                        />
                      }
                      // The utility strip (MOTIR-2373 · design/shell Panel D): the
                      // room for the controls the below-md bar's four-slot budget
                      // displaced. Each one is the SAME component the bar renders,
                      // re-homed — build-in-public (labelled, truncating), then
                      // Help (MOTIR-4239 — the drawer has no footer of its own, so
                      // its trigger lives here instead), report, then theme. The
                      // Plan-with-AI pill is deliberately absent: PlanWithAIFab
                      // below is already its phone-width door.
                      footer={
                        <>
                          <div className="min-w-0 flex-1">
                            {buildInPublicProjectKey ? (
                              <BuildInPublicButton
                                projectKey={buildInPublicProjectKey}
                                placement="drawer"
                              />
                            ) : buildingInPublic ? (
                              <BuildingInPublicHeaderLink placement="drawer" />
                            ) : null}
                          </div>
                          <HelpMenu
                            placement="drawer"
                            docsIndexUrl={docsIndexUrl}
                            legalIndexUrl={legalIndexUrl}
                          />
                          <ReportButton display="drawer" />
                          <ThemeToggle placement="drawer" />
                        </>
                      }
                    >
                      <SidebarNav
                        activeProject={activeProject}
                        variant="drawer"
                        settingsPermissions={settingsPermissions}
                        user={{ name: session.user.name, email: session.user.email }}
                        organization={
                          activeOrg
                            ? {
                                name: activeOrg.name,
                                isOrgAdmin: orgCan(activeOrg.role, 'manageOrgSettings'),
                              }
                            : null
                        }
                        workspace={
                          activeWorkspaceModel ? { name: activeWorkspaceModel.name } : null
                        }
                        billingAvailable={cloudBilling}
                        workspaceTierRevealed={workspaceTierRevealed}
                        publicProjectsAvailable={publicProjectsAvailable}
                        hostedRunsAvailable={hostedRunsAvailable}
                        motirRepositoriesPresent={motirRepositoriesPresent}
                      />
                    </SidebarDrawer>

                    {/* The ⌘K palette UI — fed the same workspace/project data the shell
            above already resolved, so navigation + switch actions stay in sync
            without a second fetch. */}
                    <AppCommandPalette
                      workspaces={workspaces}
                      activeWorkspaceId={activeWorkspaceId}
                      projects={projects}
                      activeProjectId={activeProject?.id ?? null}
                      settingsPermissions={settingsPermissions}
                      aiPlanningConfigured={aiPlanningConfigured}
                      publicProjectsAvailable={publicProjectsAvailable}
                      hostedRunsAvailable={hostedRunsAvailable}
                      motirRepositoriesPresent={motirRepositoriesPresent}
                      isOrgAdmin={activeOrg ? orgCan(activeOrg.role, 'manageOrgSettings') : false}
                    />

                    {/* The floating "M" entrance (MOTIR-1299) — the second of the two
                  planning-workspace doors the design ships (alongside the
                  header pill). A fixed bottom-right orb, mounted once at the
                  layout root, under the same gate as the pill. */}
                    {showPlanWithAi ? <PlanWithAIFab /> : null}

                    {/* THE PLANNING WORKSPACE, as an OVERLAY (MOTIR-4729 · story
                  MOTIR-4725). Mounted ONCE here, beside the orb — but NOT behind
                  the orb's gate; see the note below — and open only when the
                  address carries the overlay's namespaced query, so on every page
                  that does not, this renders `null` and costs a `useSearchParams`
                  read.

                  It sits INSIDE `ProjectAccessProvider` deliberately: the
                  `(planning)` route group lived outside it and had to pass
                  `canManage` down by prop, which is the coupling this mount
                  removes. It is also inside `CreateIssueProvider`, so a later
                  card can bump the issues tick when an approve commits work
                  items behind an open board (CLAUDE.md § page state after a
                  mutation).

                  ⚠️ THE MOUNT IS `activeProject`, NOT `showPlanWithAi`, and
                  the difference is load-bearing (found by
                  `plan-change-planner-turn.spec.ts` in the AI-OFF main lane).
                  The DOOR is gated — no pill, no orb, no palette row where AI
                  planning is unconfigured, exactly as before — but the ADDRESS
                  still opens the workspace, because that is what the retired
                  `app/(planning)/planning/page.tsx` did: it gated on session,
                  active project and `canBrowse`, and never on
                  `isMotirAiConfigured()`. Mounting behind the door's own gate
                  narrowed it, and a `/planning` forward that lands on a page
                  where nothing mounts is not a forward. What a reader sees when
                  they arrive is `resolvePlanningHostGate`'s business, here as it
                  was there.

                  `activeProject` is what the gate's `no-project` arm would
                  answer, so it is checked here rather than rendered. */}
                    {activeProject ? (
                      // ⚠️ THE `<Suspense>` IS NOT DECORATION. This is the first
                      // component mounted at LAYOUT level that reads
                      // `useSearchParams()`, and Next refuses to build a route where
                      // that read is not inside a boundary
                      // (`missing-suspense-with-csr-bailout`). This layout is dynamic
                      // today — it awaits `getSession()` and `cookies()` — so the
                      // error does not fire; the boundary is here so that a later
                      // change to what this layout awaits cannot break every authed
                      // route's build at once. `null` is the right fallback: an
                      // overlay that has not resolved its address yet is a closed
                      // overlay, which is what the reader should see.
                      <>
                        <Suspense fallback={null}>
                          <PlanningWorkspaceOverlay
                            projectKey={activeProject.identifier}
                            projectName={activeProject.name}
                            substrate={planningSubstrate}
                          />
                        </Suspense>
                        {/* THE APPROVAL OVERLAY (Story MOTIR-5214 · Subtask MOTIR-5224) —
                        mounted ONCE, beside the planning overlay and for the same
                        reasons: it opens over ANY authed page from its address, so
                        the Workbench's row (MOTIR-5225) and the item page's control
                        (MOTIR-5215) are two doors into ONE room rather than two
                        rooms. Behind `activeProject` because its one read resolves a
                        key against the active project; in its own `<Suspense>`
                        because it reads `useSearchParams()` too. */}
                        <Suspense fallback={null}>
                          <ApprovalOverlay />
                        </Suspense>
                      </>
                    ) : null}
                  </WorkbenchLive>
                </CoordinatedRefreshProvider>
              </OnboardingResumeProvider>
            </ReportProvider>
          </ProjectAccessProvider>
        </CreateIssueProvider>
      </CommandPaletteProvider>
    </ToastProvider>
  );
}
