'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext, WORKSPACE_COOKIE_NAME } from '@/lib/workspaces';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { roleMigrationReportService } from '@/lib/services/roleMigrationReportService';
import { projectsService } from '@/lib/services/projectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { MemberAddedProjectDTO, RoleMigrationPageDTO } from '@/lib/dto/workspaces';
import {
  AccessScopeForbiddenError,
  InvalidAccessScopeError,
  InvalidWorkspaceRoleError,
  InviteExpiredOrMissingError,
  InviteNotAllowedForScopeError,
  InviteRateLimitedError,
  InviteScopeForbiddenError,
  InviteTargetAlreadyMemberError,
  LastManagerError,
  LastMemberError,
  NotAMemberError,
  OrgManagedWorkspaceRoleError,
  ScopeNotApplicableError,
  WorkspaceMemberNotFoundError,
  WorkspaceRoleForbiddenError,
} from '@/lib/workspaces/errors';
import { RoleDefinitionNotFoundError } from '@/lib/permissions/errors';
import type { WorkspaceRole } from '@/lib/workspaces/roles';
import type { WorkspaceAccessScope } from '@/generated/prisma/client';

// Server Actions for the workspace settings page. HTTP/transport layer:
// each reads the session + active workspace, calls exactly one service
// method, and translates the result into a return value or a redirect.
// No db.* / $transaction here — the service owns those.

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** The typed refusal's code, when the caller draws a message of its own (MOTIR-6465). */
  code?: string;
}

async function requireContext() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/dashboard');
  return { userId: session.user.id, workspaceId: ctx.workspaceId };
}

/**
 * These cards render on TWO routes, not one (MOTIR-3502). `/settings/workspace`
 * is the standalone area, shown once the workspace tier is revealed; below the
 * threshold that route 404s and `/settings/organization` HOSTS the very same
 * `NameCard` / `MembersCard` / `DangerZoneCard` via `WorkspaceFoldInSection`
 * (`docs/decisions/organization-tier.md` §6d).
 *
 * So revalidating only the workspace path leaves the folded-in copy stale after
 * a save — on the exact surface the collapsed state makes the ONLY one the user
 * can reach, which is where the bug would be invisible to anyone testing at two
 * workspaces. Revalidating a path that is currently 404 is a no-op, so both are
 * always safe to send.
 */
function revalidateWorkspaceSettingsSurfaces(): void {
  revalidatePath('/settings/workspace');
  revalidatePath('/settings/organization');
}

export async function renameWorkspaceAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  const name = String(formData.get('name') ?? '').trim();
  if (!name)
    return { ok: false, error: (await getErrorsTranslator())('actions.workspaceNameEmpty') };

  await workspacesService.renameWorkspace({ workspaceId, actorUserId: userId, name });
  // Re-render the settings page + the top-nav switcher (in the shared
  // layout) so the new name shows everywhere without a hard reload.
  revalidateWorkspaceSettingsSurfaces();
  revalidatePath('/', 'layout');
  return { ok: true };
}

/**
 * After leaving or deleting, the user's active workspace is gone. Resolve
 * a remaining membership to switch to; if none remain, clear the cookie
 * so getWorkspaceContext() returns null and the UI shows the
 * create-first-workspace empty state.
 */
async function switchToRemainingOrClear(userId: string): Promise<void> {
  const remaining = await workspacesService.listUserWorkspaces(userId);
  const cookieStore = await cookies();
  if (remaining.length > 0) {
    cookieStore.set(WORKSPACE_COOKIE_NAME, remaining[0]!.id, {
      httpOnly: false,
      sameSite: 'lax',
      secure: shouldUseSecureCookies(),
      path: '/',
    });
  } else {
    cookieStore.delete(WORKSPACE_COOKIE_NAME);
  }
}

/**
 * Remove another member from the active workspace — a Manager's act
 * (MOTIR-6317). The service asserts the actor's role in the actor's own RLS
 * context; this action only translates its refusals. Refuses to remove yourself
 * here — that's the Leave flow — so the contract stays clear even though the
 * service would treat it as a leave.
 */
export async function removeMemberAction(targetUserId: string): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  const t = await getErrorsTranslator();
  if (targetUserId === userId) {
    return { ok: false, error: t('actions.useLeaveToRemoveSelf') };
  }
  try {
    await workspacesService.removeMember({ actorUserId: userId, targetUserId, workspaceId });
  } catch (err) {
    if (err instanceof LastMemberError) {
      return { ok: false, error: t('actions.cannotRemoveLastMember') };
    }
    if (err instanceof WorkspaceRoleForbiddenError || err instanceof NotAMemberError) {
      return { ok: false, error: t('actions.removeMemberManagerOnly') };
    }
    if (err instanceof OrgManagedWorkspaceRoleError) {
      return { ok: false, error: t('actions.removeMemberOrgManaged') };
    }
    if (err instanceof LastManagerError) {
      return { ok: false, error: t('actions.lastManager') };
    }
    throw err;
  }
  revalidateWorkspaceSettingsSurfaces();
  return { ok: true };
}

/**
 * Resend a pending invitation (MOTIR-9996): a fresh link and email, the old link
 * retired. The service owns every refusal; this action hands back its `code` and
 * no text — the Members card draws each message itself, as it does for an invite.
 */
export async function resendInviteAction(inviteId: string): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  const session = await getSession();
  try {
    await workspaceInvitesService.resendInvite({
      actorUserId: userId,
      actorName: session?.user.name ?? '',
      workspaceId,
      inviteId,
    });
  } catch (err) {
    if (
      err instanceof InviteRateLimitedError ||
      err instanceof InviteTargetAlreadyMemberError ||
      err instanceof InviteNotAllowedForScopeError ||
      err instanceof InviteScopeForbiddenError ||
      err instanceof InviteExpiredOrMissingError ||
      err instanceof NotAMemberError
    ) {
      return { ok: false, code: err.code };
    }
    throw err;
  }
  revalidateWorkspaceSettingsSurfaces();
  return { ok: true };
}

/**
 * Change a member's WORKSPACE role (Story MOTIR-6168 · MOTIR-6463) — a built-in
 * (`role`) or one of the workspace's custom roles (`roleDefinitionId`). The
 * service asserts the actor is the Manager and guards the last Manager; every
 * refusal comes back as `{ ok: false, error }` and changes nothing, so the Members
 * page leaves the picker on the role the member still holds.
 */
export async function setMemberRoleAction(
  targetUserId: string,
  role: WorkspaceRole,
  roleDefinitionId?: string | null,
): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  const t = await getErrorsTranslator();
  try {
    await workspacesService.setMemberRole({
      actorUserId: userId,
      workspaceId,
      targetUserId,
      role,
      roleDefinitionId: roleDefinitionId ?? null,
    });
  } catch (err) {
    if (err instanceof LastManagerError) {
      return { ok: false, error: t('actions.lastManager'), code: err.code };
    }
    if (err instanceof WorkspaceRoleForbiddenError || err instanceof NotAMemberError) {
      return { ok: false, error: t('actions.rolesManagerOnly'), code: err.code };
    }
    if (err instanceof OrgManagedWorkspaceRoleError) {
      return { ok: false, error: t('actions.orgManagedRole'), code: err.code };
    }
    if (
      err instanceof WorkspaceMemberNotFoundError ||
      err instanceof RoleDefinitionNotFoundError ||
      err instanceof InvalidWorkspaceRoleError
    ) {
      return { ok: false, error: t('actions.roleChangeFailed'), code: err.code };
    }
    throw err;
  }
  revalidateWorkspaceSettingsSurfaces();
  return { ok: true };
}

/**
 * Set a member's ACCESS SCOPE — Full or Limited (Story MOTIR-6169 · MOTIR-6545).
 * Manager-only, the role action's twin: a refusal comes back as `{ ok: false,
 * error }`, and a success revalidates the same settings surfaces.
 */
export async function setMemberAccessScopeAction(
  targetUserId: string,
  scope: WorkspaceAccessScope,
): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  const t = await getErrorsTranslator();
  try {
    await workspacesService.setMemberAccessScope({
      actorUserId: userId,
      workspaceId,
      targetUserId,
      scope,
    });
  } catch (err) {
    if (err instanceof AccessScopeForbiddenError || err instanceof NotAMemberError) {
      return { ok: false, error: t('actions.scopeManagerOnly'), code: err.code };
    }
    if (err instanceof ScopeNotApplicableError) {
      return { ok: false, error: t('actions.scopeNotApplicable'), code: err.code };
    }
    if (err instanceof WorkspaceMemberNotFoundError || err instanceof InvalidAccessScopeError) {
      return { ok: false, error: t('actions.scopeChangeFailed'), code: err.code };
    }
    throw err;
  }
  revalidateWorkspaceSettingsSurfaces();
  return { ok: true };
}

/**
 * The projects one member was added to, for the Members page's "N projects"
 * popover (Story MOTIR-6169 · MOTIR-6551, design W3) — a READ, fetched when the
 * popover opens. The service narrows it to the projects the viewer can enter.
 */
export async function listMemberAddedProjectsAction(
  targetUserId: string,
): Promise<{ ok: true; projects: MemberAddedProjectDTO[] } | { ok: false; error: string }> {
  const { userId, workspaceId } = await requireContext();
  try {
    return {
      ok: true,
      projects: await workspacesService.listMemberAddedProjects(workspaceId, userId, targetUserId),
    };
  } catch (err) {
    if (err instanceof NotAMemberError) {
      return { ok: false, error: (await getErrorsTranslator())('actions.memberProjectsFailed') };
    }
    throw err;
  }
}

/**
 * Go to ONE project's Access & members page (Story MOTIR-6169 · MOTIR-6551,
 * design W3 / W10). That page edits the ACTIVE project, so the door makes this
 * project active first — through `setActiveProject`, which refuses a project the
 * actor cannot enter (MOTIR-6319) — and then lands there. A form action, so it
 * answers nothing: a key the actor cannot resolve (gone, renamed away, or not
 * theirs to enter) simply leaves them where they are, exactly as a key that
 * never existed would.
 */
export async function openProjectAccessAction(projectKey: string): Promise<void> {
  const { userId, workspaceId } = await requireContext();
  try {
    const project = await projectsService.getByKey(projectKey, { userId, workspaceId });
    await projectsService.setActiveProject({ userId, workspaceId, projectId: project.id });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return;
    throw err;
  }
  revalidatePath('/', 'layout');
  redirect('/settings/project/members');
}

/**
 * Dismiss one row of the migration report (MOTIR-6465). Manager-only — the
 * service asserts it; a refusal comes back as `{ ok: false, error }`.
 */
export async function dismissRoleMigrationEntryAction(entryId: string): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  try {
    await roleMigrationReportService.dismiss(workspaceId, userId, entryId);
  } catch (err) {
    if (err instanceof WorkspaceRoleForbiddenError || err instanceof NotAMemberError) {
      return { ok: false, error: (await getErrorsTranslator())('actions.rolesManagerOnly') };
    }
    throw err;
  }
  revalidateWorkspaceSettingsSurfaces();
  return { ok: true };
}

/** The next page of the migration report, for the notice's "Show more" (a READ). */
export async function loadRoleMigrationPageAction(
  cursor: string,
): Promise<{ ok: true; page: RoleMigrationPageDTO } | { ok: false; error: string }> {
  const { userId, workspaceId } = await requireContext();
  try {
    return {
      ok: true,
      page: await roleMigrationReportService.listOpen(workspaceId, userId, cursor),
    };
  } catch (err) {
    if (err instanceof WorkspaceRoleForbiddenError || err instanceof NotAMemberError) {
      return { ok: false, error: (await getErrorsTranslator())('actions.rolesManagerOnly') };
    }
    throw err;
  }
}

export async function leaveWorkspaceAction(): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  try {
    await workspacesService.leaveWorkspace({ userId, workspaceId });
  } catch (err) {
    if (err instanceof LastMemberError) {
      return {
        ok: false,
        error: (await getErrorsTranslator())('actions.cannotLeaveLastMember'),
      };
    }
    throw err;
  }
  await switchToRemainingOrClear(userId);
  redirect('/dashboard');
}
