'use server';
import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ProjectDTO } from '@/lib/dto/projects';

// Server Actions for the top-nav project switcher + project surfaces.
// HTTP/transport layer (per CLAUDE.md, Server Actions are the route-layer
// equivalent): read the session, resolve the active workspace from the
// existing cookie-backed context, and call exactly one service method.
// No db.* and no $transaction here — those belong to the service.
//
// Why the active project is NOT cookie-backed (unlike the workspace
// switcher): the active project lives on WorkspaceMembership.activeProjectId,
// so the pointer survives across devices/sessions and reads via the
// projectsService.getActiveProject() resolver. Server-side resolution
// removes the cookie/db sync problem the workspace cookie has to defend
// against in middleware.

interface ResolvedContext {
  userId: string;
  workspaceId: string;
}

async function requireContext(): Promise<ResolvedContext> {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHENTICATED');
  const ctx = await getWorkspaceContext();
  if (!ctx) throw new Error('NO_WORKSPACE');
  return { userId: session.user.id, workspaceId: ctx.workspaceId };
}

/**
 * Persist the active project selection on the caller's membership row.
 * The service's setActiveProject asserts membership AND that the project
 * belongs to the active workspace, so a forged projectId can't pin to a
 * project in a workspace the user can't access.
 */
export async function setActiveProjectAction(projectId: string): Promise<void> {
  const { userId, workspaceId } = await requireContext();
  await projectsService.setActiveProject({ userId, workspaceId, projectId });
  // The active project is DB-backed (WorkspaceMembership.activeProjectId), not a
  // cookie — so, unlike the workspace/org switch, mutating it gives Next no
  // signal to invalidate the client Router Cache. Without this, a caller that
  // navigates after switching (the switchers push to the signed-in landing —
  // MOTIR-1559, re-pointed by MOTIR-5132) would
  // re-render the cached authed layout with the OLD active project (stale
  // switcher / nav). revalidatePath invalidates the layout tree so the pushed
  // route re-renders against the new active project, matching how the cookie
  // write auto-invalidates for the workspace/org switch.
  revalidatePath('/', 'layout');
}

/** What opening a project-settings link that names a project did (MOTIR-12169). */
export type ProjectLinkOutcome =
  /** The named project is already the reader's active one: nothing was written. */
  | 'current'
  /** The reader may enter it, and it is now their active project. */
  | 'switched'
  /** No project the reader may enter carries the key — a private project and a
   * missing one answer alike, so the link cannot probe for existence. */
  | 'refused';

/**
 * Open a project-settings link that names its project (`?project=<KEY>`, Bug
 * MOTIR-12169): resolve the key with the browse-gated, alias-aware resolver
 * the project routes use, and — when it names a project the reader may enter
 * that is not their active one — make the switcher's own switch.
 *
 * A POST, so it runs only when the reader opens the link (never on a prefetch),
 * and it is the switch's own `project:browse` check: `setActiveProject` alone
 * asserts only membership (MOTIR-6319).
 */
export async function openProjectLinkAction(projectKey: string): Promise<ProjectLinkOutcome> {
  const { userId, workspaceId } = await requireContext();
  let projectId: string;
  try {
    ({
      project: { id: projectId },
    } = await projectsService.resolveByKey(projectKey, { userId, workspaceId }));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return 'refused';
    throw err;
  }
  const active = await projectsService.getActiveProject(userId, workspaceId);
  if (active?.id === projectId) return 'current';
  await projectsService.setActiveProject({ userId, workspaceId, projectId });
  // As for the switcher: the shell above the settings area renders the active
  // project, and only a layout revalidation reaches it.
  revalidatePath('/', 'layout');
  return 'switched';
}

export interface CreateProjectActionInput {
  name: string;
  identifier?: string;
}

/**
 * Create a new project in the active workspace and pin it as the caller's
 * active project. createProject already asserts membership and derives a
 * workspace-unique identifier; the follow-up setActiveProject is a separate
 * transaction because projectsService.createProject doesn't pin the new
 * project on the membership itself (the membership write would couple two
 * concerns inside the create txn). Returning the DTO lets the client reflect
 * the new project immediately before router.refresh() re-renders the tree.
 */
export async function createProjectAction(input: CreateProjectActionInput): Promise<ProjectDTO> {
  const { userId, workspaceId } = await requireContext();
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error('EMPTY_NAME');

  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: userId,
    name: trimmedName,
    identifier: input.identifier,
  });

  await projectsService.setActiveProject({
    userId,
    workspaceId,
    projectId: project.id,
  });

  return project;
}

/**
 * "Plan a new project with AI" — the in-app onboarding door (MOTIR-1486).
 *
 * AI-native onboarding is idea-first (Principle #1) and always plans a NEW
 * project, so this mints a fresh DRAFT project, pins it active, and hands off
 * to the shipped `/onboarding` fork (MOTIR-1461/1462), which scopes discovery
 * to the active project. It deliberately does NOT reuse whatever project is
 * currently active — routing straight to `/onboarding` would plan INTO the
 * existing project (or bounce to /roadmap if that project already onboarded),
 * which is the wrong journey for a "new project" affordance.
 *
 * The name is provisional ("Untitled project"): the user hasn't described the
 * idea yet at click time (the idea textarea lives on the onboarding entrance),
 * and a fresh project has `onboardingRanAt == null`, so the entrance shows and
 * discovery/materialize plans into THIS project. Renaming the draft from the
 * generated AI plan is a separate follow-up (the plan output carries no
 * suggested project name today); until then the user can rename in settings.
 */
export async function startNewAiProjectAction(): Promise<void> {
  const { userId, workspaceId } = await requireContext();
  const t = await getTranslations('shell');

  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: userId,
    name: t('project.untitled'),
  });
  await projectsService.setActiveProject({ userId, workspaceId, projectId: project.id });

  // redirect() throws NEXT_REDIRECT — keep it outside any try/catch.
  redirect(ONBOARDING_ENTRY_PATH);
}

/**
 * Archive (soft-delete) a project owned by the active workspace. The
 * service stamps archivedAt and the existing getActiveProject resolver
 * falls back to the first remaining non-archived project — or null when
 * none remain, which the route-level empty-state branch surfaces.
 */
export async function archiveProjectAction(projectId: string): Promise<void> {
  const { userId, workspaceId } = await requireContext();
  await projectsService.archiveProject({
    projectId,
    workspaceId,
    actorUserId: userId,
  });
}
