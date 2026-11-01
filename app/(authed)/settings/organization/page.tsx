import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationDeletionService } from '@/lib/services/organizationDeletionService';
import { organizationContentLanguageService } from '@/lib/services/organizationContentLanguageService';
import {
  isWorkspaceTierRevealed,
  preferredOrganizationId,
  scopeWorkspacesToActiveOrg,
} from '@/lib/workspaces/tierDisclosure';
import { getWorkspaceContext } from '@/lib/workspaces';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { orgCan } from '@/lib/organizations/capabilities';
import type { Locale } from '@/lib/i18n/locales';
import { isCloudBilling } from '@/lib/billing/availability';
import { EmptyState } from '@/components/ui/EmptyState';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { OrgGeneralCard } from './_components/OrgGeneralCard';
import { BillingCard } from './_components/BillingCard';
import { WorkspaceFoldInSection } from './_components/WorkspaceFoldInSection';
import { DangerZoneCard } from './_components/DangerZoneCard';
import { DELETE_ORGANIZATION_DIALOG } from './_components/deleteOrganizationDialogParam';
import { OrgWorkspacesCard } from './_components/OrgWorkspacesCard';
import { ORG_WORKSPACES_PAGE_SIZE } from './_components/workspacesPageSize';

// Organization settings (Story 6.10.5, design/org-admin panel 2) — the
// org-scoped Settings home. The org-scoped cards are owner/admin only, and a
// plain org member sees them ABSENT — not panel 5d's forbidden card, which
// MOTIR-6312 retired (the refused-not-hidden shape) — keeping only the folded-in
// workspace sections below the reveal, and a 404 above it. The active org is resolved from the
// org cookie (the shell switcher sets it). NO billing/credit surface here —
// that is 7.12.5 / Epic 8 (only a passive "Coming soon" placeholder).

export default async function OrganizationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    /** MOTIR-6314's deep link names the org to open (the one blocking an account
     *  deletion), which need not be the active one. Honoured only for an org the
     *  viewer belongs to — `resolveActiveOrganization` checks membership. */
    org?: string;
    /** `transfer-ownership` opens the Owner's transfer dialog on arrival
     *  (MOTIR-6313); `delete-organization` opens the Delete organization dialog
     *  (MOTIR-6402). Both ignored for a viewer without `transferOwnership`. */
    dialog?: string;
  }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('orgAdmin');

  // ⚠️ RESOLVE THE ACTIVE ORG THE WAY THE SHELL DOES — the ACTIVE WORKSPACE's org
  // wins, and the cookie is only the fallback for a user with no active workspace
  // (an org-only member). This page used to read the cookie ALONE, so it could
  // disagree with the header about which org is active: a user whose org cookie
  // still pointed at their own org, while their active workspace lived in
  // another, saw the header say `Acme` and this page render a different org's
  // settings.
  //
  // That was survivable while the page was whole-page admin-gated — the users it
  // could happen to were refused anyway. §6d's fold-in is what makes it bite: the
  // page now hosts the ACTIVE workspace's sections, so resolving a different org
  // means hosting the wrong workspace's Name / Members / Danger zone. Both
  // MOTIR-3502 E2E failures were this, not the gate.
  //
  // `preferredOrganizationId` is the same helper the (authed) layout composes, so
  // the two cannot drift again.
  const [ctx, myWorkspaces, cookieStore, query] = await Promise.all([
    getWorkspaceContext(),
    workspacesService.listUserWorkspaces(session.user.id),
    cookies(),
    searchParams,
  ]);
  const activeWorkspace = ctx ? (myWorkspaces.find((w) => w.id === ctx.workspaceId) ?? null) : null;
  const orgCookie = cookieStore.get(ORGANIZATION_COOKIE_NAME)?.value ?? null;
  const current = await organizationsService.resolveActiveOrganization(
    session.user.id,
    query.org || preferredOrganizationId(activeWorkspace, orgCookie),
  );

  if (!current) {
    return (
      <div className="mx-auto max-w-[45rem]">
        <EmptyState
          title={t('states.noActiveOrgTitle')}
          description={t('states.noActiveOrgDescription')}
        />
      </div>
    );
  }

  const org = current.organization;
  const isAdmin = orgCan(current.role, 'manageOrgSettings');
  // The Danger zone is the OWNER's (design MOTIR-6303 panels 2–3): an Admin holds
  // org settings but not `transferOwnership`, and gets no card at all.
  const canTransfer = orgCan(current.role, 'transferOwnership');
  const canManageWorkspaces = orgCan(current.role, 'manageWorkspaces');

  // ⚠️ GATED PER SECTION, NOT PER PAGE (MOTIR-3519 · organization-tier.md §6d).
  //
  // This used to `return` panel 5d's forbidden EmptyState for the whole page.
  // That was right while the page carried ORG-scoped cards only — per-page and
  // per-section were then the same rule. §6d's fold-in is what makes them
  // differ: below the workspace-tier reveal threshold this page HOSTS the
  // workspace's Name / Members / Danger-zone sections, and those are gated on
  // WORKSPACE MEMBERSHIP, not on the org role. Keeping the whole-page refusal
  // would have closed the only remaining route to them — including the only
  // route in the product to **Leave workspace** — for a plain org member, who is
  // exactly what a workspace invitee is (§5's upward invariant joins them as
  // `member`).
  //
  // So the refusal moves DOWN to the org-scoped cards, and the rule it applies
  // is the general one §6d states: relocating a surface preserves its GATE. A
  // hidden tier changes what the product NAMES, never what a user may DO.
  //
  // A non-member of the org never reaches here at all — `resolveActiveOrganization`
  // returns null for them and the no-active-org state above answers, which keeps
  // the 404-not-403 posture intact.

  // Counts for the general-card footer + the fold-in (membership-scoped to the
  // active org — the same population the shell's reveal test counts, via the
  // same helper, so this page and the nav can never disagree about the tier).
  const orgWorkspaces = scopeWorkspacesToActiveOrg(myWorkspaces, org.id);
  // §6d: below the reveal threshold `/settings/workspace` does not exist (it
  // 404s), so this page hosts its sections instead. An org-only member with no
  // workspace at all has nothing to fold in.
  const foldInWorkspace = isWorkspaceTierRevealed(orgWorkspaces.length)
    ? null
    : (orgWorkspaces[0] ?? null);

  // A plain org MEMBER with nothing folded in — 2+ workspaces, or none — has
  // nothing on this page at all: every org-scoped card is absent for them. So
  // the page answers 404, matching the non-member posture, rather than render
  // an empty page or panel 5d's refusal (MOTIR-6312 · panel 3d). The rail row
  // and the org menu's `Settings` row follow the same rule, so no door leads
  // here.
  if (!isAdmin && !foldInWorkspace) notFound();
  // MOTIR-3448 — allocation row 13: the frame, and (once) a wave.
  //
  // ⚠️ THE WAVE IS GONE, AND SO IS ITS REASON (MOTIR-5172). The asset counted
  // three serial reads here and the genuine win was two — `listMembers` and
  // `getAiAccess`. `getAiAccess` fed exactly one consumer, the acceptance-video
  // card, and that card left this page when the switch moved to
  // `Project settings ▸ Approvals` (`design/org-admin/design-notes.md` panel 7b).
  // A read with no consumer is not kept for symmetry, so the pane is one read.
  //
  // `resolveActiveOrganization` stays ABOVE the boundary: it decides the
  // no-active-org state AND supplies the org name the header interpolates.
  return (
    <div className="mx-auto flex max-w-[45rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('settings.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {isAdmin
            ? t('settings.subtitle', { org: org.name })
            : t('settings.subtitleMember', { org: org.name })}
        </p>
      </header>

      <Suspense fallback={<SettingsPaneFrame />}>
        <OrgPaneBody
          orgId={org.id}
          orgName={org.name}
          contentLanguage={org.contentLanguage}
          role={current.role}
          isAdmin={isAdmin}
          canTransfer={canTransfer}
          openTransfer={canTransfer && query.dialog === 'transfer-ownership'}
          openDelete={canTransfer && query.dialog === DELETE_ORGANIZATION_DIALOG}
          sessionSignedInAt={new Date(session.session.createdAt).toISOString()}
          canManageWorkspaces={canManageWorkspaces}
          activeWorkspaceId={ctx?.workspaceId ?? null}
          actorUserId={session.user.id}
          orgWorkspaceCount={orgWorkspaces.length}
          foldInWorkspace={foldInWorkspace}
        />
      </Suspense>
    </div>
  );
}

/**
 * The org pane's ONE read, below the boundary.
 *
 * It was two, in one `allSettledOrThrow` wave (MOTIR-3066); the second —
 * `billingService.getAiAccess` — existed only for the acceptance-video card,
 * which MOTIR-5172 removed with the switch's move to the project tier.
 */
async function OrgPaneBody({
  orgId,
  orgName,
  contentLanguage,
  role,
  isAdmin,
  canTransfer,
  openTransfer,
  openDelete,
  sessionSignedInAt,
  canManageWorkspaces,
  activeWorkspaceId,
  actorUserId,
  orgWorkspaceCount,
  foldInWorkspace,
}: {
  orgId: string;
  orgName: string;
  contentLanguage: Locale;
  role: React.ComponentProps<typeof OrgGeneralCard>['role'];
  isAdmin: boolean;
  canTransfer: boolean;
  openTransfer: boolean;
  openDelete: boolean;
  /** When the viewer's session was created — the passwordless step-up's proof. */
  sessionSignedInAt: string;
  canManageWorkspaces: boolean;
  activeWorkspaceId: string | null;
  actorUserId: string;
  orgWorkspaceCount: number;
  foldInWorkspace: { id: string } | null;
}) {
  // The org-scoped reads, for an Owner/Admin only — a Member's view of this
  // page is the fold-in alone, and neither read is theirs to make.
  // `allSettledOrThrow`, never a bare `Promise.all`: each arm opens a
  // transaction (MOTIR-3066).
  const [members, workspacesPage, latestContentLanguageChange] = isAdmin
    ? await allSettledOrThrow([
        organizationsService.listMembers({ organizationId: orgId, actorUserId, limit: 1 }),
        canManageWorkspaces
          ? workspacesService.listOrganizationWorkspaces({
              organizationId: orgId,
              actorUserId,
              limit: ORG_WORKSPACES_PAGE_SIZE,
            })
          : Promise.resolve(null),
        // The Content language row's attribution line (MOTIR-8095).
        organizationContentLanguageService.getLatestContentLanguageChange({
          organizationId: orgId,
          actorUserId,
        }),
      ])
    : [null, null, null];

  // The Owner's Danger zone reads (Story MOTIR-6306 · MOTIR-6402): the open
  // deletion request, and — only while there is none — the dialog's step-1
  // consequences. Sequential, not parallel: the second is not needed once the
  // first answers "scheduled".
  const deletionState = canTransfer
    ? await organizationDeletionService.getOrganizationDeletion(orgId, actorUserId)
    : null;
  const consequences =
    canTransfer && !deletionState?.request
      ? await organizationDeletionService.getConsequences(
          orgId,
          actorUserId,
          new Date(sessionSignedInAt),
        )
      : null;

  return (
    <>
      {isAdmin && members ? (
        <>
          <OrgGeneralCard
            orgId={orgId}
            initialName={orgName}
            role={role}
            workspaceCount={orgWorkspaceCount}
            memberCount={members.total}
            contentLanguage={contentLanguage}
            canEdit={isAdmin}
            latestContentLanguageChange={latestContentLanguageChange}
          />

          {/* The org-tier home for creating and removing workspaces (MOTIR-6312 ·
              panel 1), directly under General. */}
          {workspacesPage ? (
            <OrgWorkspacesCard
              orgId={orgId}
              orgName={orgName}
              initialPage={workspacesPage}
              activeWorkspaceId={activeWorkspaceId}
            />
          ) : null}

          {/* The live billing "door" (8.1.7, design/billing panel 1) replaces the
              passive placeholder — cloud-only (ADR §6): off-cloud there is no
              billing surface at all, so the card simply doesn't render. */}
          {isCloudBilling() ? <BillingCard /> : null}
        </>
      ) : null}

      {foldInWorkspace ? (
        <WorkspaceFoldInSection
          workspaceId={foldInWorkspace.id}
          actorUserId={actorUserId}
          workspaceCount={orgWorkspaceCount}
          canManageWorkspaces={canManageWorkspaces}
        />
      ) : null}

      {canTransfer ? (
        <DangerZoneCard
          orgId={orgId}
          orgName={orgName}
          openTransfer={openTransfer}
          openDelete={openDelete}
          deletion={deletionState?.request ?? null}
          scheduledByName={deletionState?.scheduledByName ?? null}
          consequences={consequences}
        />
      ) : null}
    </>
  );
}
