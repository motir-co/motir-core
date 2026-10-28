import { getTranslations } from 'next-intl/server';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { NameCard } from '../../workspace/_components/NameCard';
import { MembersCard } from '../../workspace/_components/MembersCard';
import { RoleMigrationNotice } from '../../workspace/_components/RoleMigrationNotice';
import { roleMigrationReportService } from '@/lib/services/roleMigrationReportService';
import { DangerZoneCard } from '../../workspace/_components/DangerZoneCard';
import { setWorkspaceRequireTwoFactorAction } from '../../workspace/security/actions';
import { RequireTwoFactorCard } from './RequireTwoFactorCard';
import { RolesDoorCard } from './RolesDoorCard';
import { PublicAddressDoorCard } from './PublicAddressDoorCard';
import { isCloud } from '@/lib/billing/availability';
import { isTenantDomainConfigured } from '@/lib/publicAddresses/tenantDomain';
import { publicSubdomainService } from '@/lib/services/publicSubdomainService';

// §6d's SETTINGS COLLAPSE (MOTIR-3502 · design/org-admin panel 2). Below the
// workspace-tier reveal threshold there is no `/settings/workspace` area — it
// 404s — so this org Settings home HOSTS that area's sections instead.
//
// It is a MOUNT, not a rewrite. These are the same three components
// `/settings/workspace` renders, with the same Server Actions writing to the
// same `Workspace` row underneath — which is exactly what §6 means by "routes
// each edit to its own tier": the tier keeps working, it just stops being a
// place the user has to know about. Redrawing them here would fork the workspace
// settings UI in two, and the design asset says so outright: they "are NOT
// redrawn in this org-admin asset (they're owned by their own design areas); the
// org settings page simply hosts them", "rendered below the org-scoped cards as
// the same `stack` grammar".
//
// This REPLACED `WorkspaceConfigCard`, whose entire content was an explanatory
// note plus an "Open workspace settings" button. That card rendered only at one
// workspace, so the affordance built FOR the collapsed state was the loudest
// thing advertising the surface the collapsed state exists to hide.
export async function WorkspaceFoldInSection({
  workspaceId,
  actorUserId,
  workspaceCount,
  canManageWorkspaces,
}: {
  workspaceId: string;
  actorUserId: string;
  workspaceCount: number;
  /** `manageWorkspaces` on the org — read off the role the page already holds.
   *  Only decides the danger zone's pointer at the Workspaces card above. */
  canManageWorkspaces: boolean;
}) {
  const t = await getTranslations('orgAdmin');

  // `allSettledOrThrow`, never a bare `Promise.all`: every arm opens a
  // transaction, so a rejection on one must not leave the others running
  // unobserved (MOTIR-3066). The two arms MOTIR-3647 added are what make this a
  // four-arm wave; the pair before it predates the rule and moves with it.
  // Story MOTIR-4528 · MOTIR-9514 — the Public address door. Cloud only, and
  // only where a base domain is configured: off-cloud the room 404s, and with no
  // base domain the door would name nothing.
  const offersAddress = isCloud() && isTenantDomainConfigured();
  const [workspace, members, policy, role, roleContext, migration, subdomain, invites] =
    await allSettledOrThrow([
      workspacesService.getWorkspaceSummary(workspaceId, actorUserId),
      workspacesService.listMembers(workspaceId, actorUserId),
      // Story MOTIR-1215 · MOTIR-3647 — the workspace require-2FA control's SECOND
      // home. Below the reveal threshold `/settings/workspace/security` 404s, so
      // this is the only place a single-workspace org can reach it, which is the
      // common case rather than the edge one.
      twoFactorPolicyService.getWorkspacePolicy(workspaceId, actorUserId),
      workspacesService.getMemberRole(actorUserId, workspaceId),
      // The Members role column and the migration report fold in with Members
      // (Story MOTIR-6168 · MOTIR-6465, design panel 4b).
      workspacesService.getMemberRoleContext(workspaceId, actorUserId),
      roleMigrationReportService.firstPageForViewer(workspaceId, actorUserId),
      offersAddress
        ? publicSubdomainService.getForWorkspace(workspaceId, actorUserId)
        : Promise.resolve(null),
      // The Members card's pending invitations fold in with it (MOTIR-9997), read
      // as `/settings/workspace` reads them: the read refuses a viewer who may not
      // invite, and a failed read draws the card without the block.
      workspaceInvitesService
        .listPendingInvites({ userId: actorUserId, workspaceId })
        .catch(() => []),
    ]);
  // The caller resolved this workspace from the actor's OWN membership list, so
  // a null here means it went away between the two reads. Nothing to host.
  if (!workspace) return null;
  const pendingInvites = roleContext.canInvite ? invites : [];

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="font-sans text-base font-semibold text-(--el-text)">
          {t('settings.workspaceConfig')}
        </h2>
        <p className="text-(--el-text-secondary) font-sans text-sm">
          {t('settings.workspaceConfigSub', { count: workspaceCount })}
        </p>
      </div>

      <NameCard initialName={workspace.name} />

      {migration && migration.total > 0 ? <RoleMigrationNotice initial={migration} /> : null}

      <MembersCard
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        members={members}
        currentUserId={actorUserId}
        roleContext={roleContext}
        pendingInvites={pendingInvites}
      />

      <RolesDoorCard customRoleCount={roleContext.customRoles.length} />

      {offersAddress ? <PublicAddressDoorCard hostname={subdomain?.hostname ?? null} /> : null}

      {/* ⚠️ RELOCATING A SURFACE PRESERVES ITS GATE, AND THIS SECTION DOES NOT
          CARRY THIS ONE. This host renders for ANY member of the workspace —
          MOTIR-3519 moved the org refusal down to the org-scoped cards precisely
          so a plain org member could still reach **Leave workspace**. The
          require-2FA control is not that kind of section: it is a workspace
          MANAGER control, so it resolves `isWorkspaceManager` for itself and a
          `member` / `viewer` sees it READ-ONLY. A control that inherited its
          host's gate is how a viewer ends up able to change a security policy. */}
      <RequireTwoFactorCard
        requiresTwoFactor={policy.requiresTwoFactor}
        lockedBy={policy.lockedByOrganization ? policy.organizationName : null}
        description={t('security.cardBodyWorkspace')}
        stateOnLabel={t('security.stateOnWorkspace', { workspace: workspace.name })}
        canManage={isWorkspaceManager(role)}
        tierName={workspace.name}
        onSave={setWorkspaceRequireTwoFactorAction}
      />

      <DangerZoneCard
        isLastMember={members.length <= 1}
        canRemoveWorkspace={canManageWorkspaces}
        placement="foldIn"
        leaveLockedByOrg={
          roleContext.orgManagedUserIds.includes(actorUserId)
            ? { organizationName: roleContext.organizationName, workspaceName: workspace.name }
            : null
        }
      />
    </>
  );
}
