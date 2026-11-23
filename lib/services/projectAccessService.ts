import type { Prisma } from '@/generated/prisma/client';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { composeOwnerReach } from '@/lib/workspaces/membershipGate';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { customRolePermissionsOf } from '@/lib/workspaces/roles';
import type { Project, ProjectAccessMode } from '@/generated/prisma/client';
import {
  canBrowse,
  canComment,
  canEnter,
  canCommentPublicRequest,
  canCreateAttachments,
  canDeleteAllAttachments,
  canEdit,
  canManageProject,
  canManageWatchers,
  canModerateComments,
  canSubmitToTriage,
  canUpvotePublicRequest,
  canViewPages,
  canEditPages,
  canDeletePages,
  type ProjectAccessInputs,
} from '@/lib/projects/access';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  savedFilterCapabilities,
  type SavedFilterProjectCapabilities,
} from '@/lib/savedFilters/access';
import { hasPermission, resolvePermissions } from '@/lib/permissions/resolve';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { toActorPermissionsDTO } from '@/lib/mappers/permissionMappers';
import type { ActorPermissionsDTO } from '@/lib/dto/permissions';
import { isCloud } from '@/lib/billing/availability';
import { VISITOR_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  VISITOR_ACTOR_ID,
  VISITOR_NOT_FOUND,
  type VisitorReadContext,
  type VisitorVerdict,
} from '@/lib/visitor/context';
import { projectVisitorRepository } from '@/lib/repositories/projectVisitorRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { visitorRecordsService } from '@/lib/services/visitorRecordsService';

// projectAccessService — the ENFORCEMENT half of the Story 6.4 access model
// (Subtask 6.4.3). It resolves the three policy inputs (the project's access
// level + the actor's workspace role + their project role) and applies the pure
// `canBrowse` / `canEdit` policy from `lib/projects/access.ts`, throwing typed
// errors the route layer maps to HTTP status codes. This is the gate the rest
// of the PM core has been deferring with `// TODO(6.4)` notes — threaded into
// the project / board / issue READS (canBrowse) and their WRITE paths (canEdit)
// in the same change.
//
// The management write path (add/remove member, set role/access) is 6.4.4's
// `projectMembersService` and is DELIBERATELY separate: that gate is "are you a
// project ADMIN"; this one is "may you browse / edit at all".
//
// `tx` is OPTIONAL on every method, matching the two binding patterns already
// in the codebase:
//   * A caller already inside a transaction (the write paths: createWorkItem,
//     moveCard, …) passes its `tx` so the gate reads share the snapshot AND the
//     RLS workspace GUC the enclosing `withWorkspaceContext` / `db.$transaction`
//     bound — required under the non-bypass motir_app role.
//   * A plain read path (getBoard, getProjectIssuesList, …) calls without `tx`;
//     the gate then opens its OWN `withWorkspaceContext` for the resolution
//     (MOTIR-2527). It used to fall through to the `db` singleton, which bound
//     no GUCs — correct only under a BYPASSRLS role, and under `motir_app` it
//     made every one of the gate's three rows invisible, so a member read as a
//     non-member and the gate 404'd them out of their own project.

/** The minimal actor context the gate needs — satisfied by both ServiceContext and WorkspaceContext. */
export interface AccessActorContext {
  userId: string;
  workspaceId: string;
  /** See {@link ServiceContext.tokenProjectId} — the acting token's project
   *  binding, enforced in {@link resolveInputs}. */
  tokenProjectId?: string;
  /** See {@link ServiceContext.tokenGrant} — read by {@link holdsRecordView}. */
  tokenGrant?: readonly PermissionKey[];
}

/**
 * Whether an actor holds a RECORD-VIEW key (MOTIR-6330) — the role's `held` set
 * AND, for a bearer token, the token's grant. `grant ∩ role` for the one class of
 * key that is consulted after the dispatch door rather than at it
 * (`RECORD_VIEW_PERMISSIONS`, `lib/tokens/grant.ts`).
 */
export function holdsRecordView(
  held: ReadonlySet<PermissionKey>,
  ctx: AccessActorContext,
  key: PermissionKey,
): boolean {
  if (!held.has(key)) return false;
  return ctx.tokenGrant === undefined || ctx.tokenGrant.includes(key);
}

/**
 * Resolve the policy inputs for `(actor, project)`. Throws ProjectNotFoundError
 * (→ 404, no existence leak) when the project is missing OR lives in another
 * workspace — a cross-tenant id must be indistinguishable from a never-existed
 * one (finding #26), so the gate can never confirm a foreign project exists.
 */
async function resolveInputs(
  projectId: string,
  ctx: AccessActorContext,
  tx?: Prisma.TransactionClient,
): Promise<ProjectAccessInputs> {
  // MOTIR-2527: when the caller has no bound transaction, this opens ONE for the
  // whole resolution rather than binding only the membership read. All three rows
  // the gate reads are RLS-gated on `app.workspace_id` — `project` by
  // `project_active_workspace`, `project_membership` by
  // `project_membership_active_workspace`, `workspace_membership` by
  // `membership_visible_active_or_own` — so a per-read binding would leave two of
  // them invisible under the non-bypass role and turn a member into a 404.
  if (!tx) return withWorkspaceContext(ctx, (t) => resolveInputs(projectId, ctx, t));

  // ⚠️ THE TOKEN'S PROJECT BINDING, enforced here and nowhere else (MOTIR-2607).
  // This function is the one place a project id meets an actor — every
  // `assertCanBrowse` / `assertCanEdit` / `assertPermission` / `getPermissions`
  // / `filterBrowsable` in the product resolves through it — so the two bearer
  // seams inherit the check without either re-implementing it, and no route has
  // to remember to ask.
  //
  // The refusal is NOT-FOUND, deliberately. "Forbidden" would confirm the other
  // project exists, turning a deliberately narrowed credential into an oracle
  // for enumerating a workspace; it is indistinguishable here from the
  // cross-tenant case immediately below, which is the point.
  if (ctx.tokenProjectId !== undefined && ctx.tokenProjectId !== projectId) {
    throw new ProjectNotFoundError(projectId);
  }
  const project = await projectRepository.findById(projectId, tx);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  // ONE round trip for the WORKSPACE membership AND the workspace custom role it
  // points at (Story MOTIR-6168 · MOTIR-6459) — the role is the workspace's now,
  // so this is the read that decides the actor's keys in every project. Both
  // tables are RLS-gated on `app.workspace_id`, which this transaction binds.
  const workspaceMembership =
    await workspaceMembershipRepository.findByUserAndWorkspaceWithRoleDefinition(
      ctx.userId,
      ctx.workspaceId,
      tx,
    );
  // THE ORG OWNER'S REACH INTO EVERY PROJECT (MOTIR-6308; `role-model.md` §1):
  // an Owner never added to a workspace reads as a Manager here, so the workspace
  // gate and the project gate agree.
  const workspaceRole = await composeOwnerReach(
    ctx.userId,
    ctx.workspaceId,
    workspaceMembership,
    tx,
  );
  // The project records only whether the actor was ADDED — no project role and
  // no project custom role enters the calculation (`role-model.md` §3).
  const projectMembership = await projectMembershipRepository.findByUserAndProject(
    ctx.userId,
    projectId,
    tx,
  );
  return {
    // The project's stored MODE (Story MOTIR-6169; NOT NULL since MOTIR-6686)
    // and the actor's SCOPE, read off the membership row; an
    // org Owner / Admin composed in as a Manager has no row, and a Manager's
    // scope is never read.
    accessMode: project.accessMode,
    workspaceRole,
    accessScope: workspaceMembership?.accessScope ?? null,
    customRolePermissions: customRolePermissionsOf(workspaceRole, workspaceMembership),
    addedToProject: projectMembership != null,
    // WHICH DOOR (MOTIR-6733). This is the MEMBER door, where a non-entrant holds
    // nothing — with ONE exception: a Visitor's narrowed context
    // (`visitorServiceContext`), whose reads run the rooms' member services but
    // apply the private-epic hidden set themselves and are only ever built from a
    // `visitor` verdict. Its actor id names no user row, so no session can
    // present it.
    readPath: ctx.userId === VISITOR_ACTOR_ID ? 'public' : 'member',
    // A CLOSING organization is read-only for every actor (MOTIR-6396). Read at
    // request time and never stored on a membership, so a cancel reopens every
    // write on the next request with nothing to restore.
    organizationClosing: await isWorkspaceOrgClosing(project.workspaceId, tx),
  };
}

/** Whether the org owning `workspaceId` is closing — see `resolvePermissions`. */
async function isWorkspaceOrgClosing(
  workspaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<boolean> {
  return (await organizationRepository.findClosingSinceByWorkspaceId(workspaceId, tx)) !== null;
}

/**
 * Resolve the policy inputs for a PUBLIC-read actor — the ONE path that bypasses
 * the workspace-equality 404 guard (Story 6.12 · Subtask 6.12.3, ADR §2.2). The
 * existing `resolveInputs` is left UNTOUCHED, so the 404-not-403 cross-tenant
 * posture for non-public projects is fully preserved; THIS function is the single
 * auditable place the org/workspace boundary is crossed for READ, and ONLY for a
 * `public` project.
 *
 * `actorUserId` is NULLABLE: READ on a public project is anonymous (logged out /
 * a crawler), so a null actor resolves to null roles and the leading `public`
 * branch of `canBrowse` grants the read. An authenticated actor (cross-org
 * included) has their roles resolved against the PROJECT'S OWN workspace — a
 * cross-org viewer resolves to null roles (browse still granted by the public
 * branch), while a viewer who also happens to be a member of that workspace keeps
 * their richer role + normal capabilities.
 *
 * A NON-public project throws ProjectNotFoundError (→ 404) for ANY actor here
 * (anonymous or cross-org): it stays indistinguishable from never-existed, no
 * existence leak. Members reach a non-public project through the normal
 * workspace-scoped capability methods, never this public path.
 */
async function resolvePublicInputs(
  projectId: string,
  actorUserId: string | null,
  tx?: Prisma.TransactionClient,
): Promise<ProjectAccessInputs> {
  const project = await projectRepository.findById(projectId, tx);
  if (!project || project.accessMode !== 'public') {
    throw new ProjectNotFoundError(projectId);
  }
  if (!actorUserId) {
    // Unbound: `organization_public_project_read` admits the org of a public
    // project, so an anonymous visitor's public-request writes close too.
    return {
      accessMode: 'public',
      workspaceRole: null,
      accessScope: null,
      addedToProject: false,
      organizationClosing: await isWorkspaceOrgClosing(project.workspaceId, tx),
      readPath: 'public',
    };
  }
  // Every read here runs under the PROJECT'S OWN workspace binding. MOTIR-2684:
  // `project_membership_active_workspace` (and, since MOTIR-6457,
  // `workspace_role_definition_active_workspace`) key PURELY on `app.workspace_id`,
  // so an unbound read returns nothing under `motir_app` and a real member of a
  // public project would silently lose their role on its public page. Binding the
  // workspace is safe HERE and only here: the row has already come back and been
  // proved `public`, so `project.workspaceId` is a value the database handed us,
  // not a guess made on the reader's behalf — and every lookup is keyed on the
  // actor's own `(userId, …)` pair, so the binding makes exactly the actor's own
  // rows visible. A cross-org viewer with no membership still resolves to null.
  //
  // The org Owner's manager tier (MOTIR-6308) is read under the SAME binding and
  // for the same reason.
  const readBound = async (t: Prisma.TransactionClient) => {
    const workspaceMembership =
      await workspaceMembershipRepository.findByUserAndWorkspaceWithRoleDefinition(
        actorUserId,
        project.workspaceId,
        t,
      );
    const role = await composeOwnerReach(actorUserId, project.workspaceId, workspaceMembership, t);
    const projectMembership = await projectMembershipRepository.findByUserAndProject(
      actorUserId,
      projectId,
      t,
    );
    return { workspaceMembership, role, added: projectMembership != null };
  };
  const {
    workspaceMembership,
    role: workspaceRole,
    added,
  } = await (tx
    ? readBound(tx)
    : withWorkspaceContext({ userId: actorUserId, workspaceId: project.workspaceId }, readBound));
  return {
    accessMode: 'public',
    workspaceRole,
    accessScope: workspaceMembership?.accessScope ?? null,
    customRolePermissions: customRolePermissionsOf(workspaceRole, workspaceMembership),
    addedToProject: added,
    organizationClosing: await isWorkspaceOrgClosing(project.workspaceId, tx),
    // The public door (MOTIR-6733): a non-entrant holds the public set HERE, and
    // only here — every caller of this function applies the private-epic hidden
    // set itself. `resolveInputs` above leaves it absent, i.e. the member door.
    readPath: 'public',
  };
}

export const projectAccessService = {
  /**
   * The actor's capabilities on a project — `{ canBrowse, canEdit }`. The
   * non-throwing form, for callers that FILTER rather than reject (the project
   * switcher in 6.4.6 lists only browsable projects) or render edit affordances
   * conditionally. Throws only ProjectNotFoundError (the project must resolve).
   */
  async getCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canEdit: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return { canBrowse: canBrowse(inputs), canEdit: canEdit(inputs) };
  },

  /**
   * The actor's COMMENT-domain capabilities on a project (Story 5.1 · Subtask
   * 5.1.2) — one `resolveInputs` round-trip feeding the three comment gates:
   * `canBrowse` (may they see the issue at all — the 404 gate), `canComment`
   * (Jira's "Add comments"), `canModerate` (Jira's "Edit all / Delete all
   * comments" — project admin or workspace owner/admin). `accessMode` rides
   * along so the caller can scope mention candidates via
   * `assignableMembersService` without re-reading the project. Throws only
   * ProjectNotFoundError (cross-workspace project ids stay hidden).
   */
  async getCommentCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    canBrowse: boolean;
    canComment: boolean;
    canModerate: boolean;
    accessMode: ProjectAccessMode;
  }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return {
      canBrowse: canBrowse(inputs),
      canComment: canComment(inputs),
      canModerate: canModerateComments(inputs),
      accessMode: inputs.accessMode,
    };
  },

  /**
   * The actor's ATTACHMENT-domain capabilities on a project (Story 5.2 ·
   * Subtask 5.2.2) — one `resolveInputs` round-trip feeding the three
   * attachment gates, mirroring `getCommentCapabilities`: `canBrowse` (may
   * they see the issue at all — the 404 gate; browsing implies seeing +
   * downloading its attachments), `canCreate` (Jira's "Create attachments"),
   * `canDeleteAll` (Jira's "Delete all attachments" — project admin or
   * workspace owner/admin; uploaders delete their OWN regardless, checked by
   * the service). Throws only ProjectNotFoundError (cross-workspace project
   * ids stay hidden).
   */
  async getAttachmentCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canCreate: boolean; canDeleteAll: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return {
      canBrowse: canBrowse(inputs),
      canCreate: canCreateAttachments(inputs),
      canDeleteAll: canDeleteAllAttachments(inputs),
    };
  },

  /**
   * The actor's WATCHER-domain capabilities on a project (Story 5.4 · Subtask
   * 5.4.4) — one `resolveInputs` round-trip feeding both watcher gates:
   * `canBrowse` (may they see the issue at all — the 404 gate; browsing is
   * ALL that self watch/unwatch needs, the verified "watching is not editing"
   * split) and `canManageWatchers` (Jira's "Manage watchers" — add/remove
   * OTHERS; project admin or workspace owner/admin). Throws only
   * ProjectNotFoundError (cross-workspace project ids stay hidden).
   */
  async getWatcherCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canManageWatchers: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return { canBrowse: canBrowse(inputs), canManageWatchers: canManageWatchers(inputs) };
  },

  /**
   * The actor's SAVED-FILTER-domain tier on a project (Story 6.2 · Subtask
   * 6.2.1) — one `resolveInputs` round-trip feeding the three saved-filter
   * gates (the getCommentCapabilities pattern): `canBrowse` (the 404 gate;
   * browsing is all that creating/starring PRIVATE filters needs — filters
   * are a read-layer construct, viewers included), `canShare` (role ≥ member
   * — may publish at visibility `project`), `canManageAny` (holds
   * `saved_filter:manage_any` — sees every row, manages the shared ones). The
   * per-row predicates live in lib/savedFilters/access.ts. Throws only
   * ProjectNotFoundError (cross-workspace project ids stay hidden).
   */
  async getSavedFilterCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<SavedFilterProjectCapabilities> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return savedFilterCapabilities(inputs);
  },

  /**
   * Filter a workspace's projects down to the ones the actor may ENTER — the
   * switcher / nav / command-palette / project list / MCP `list_projects` /
   * quick search (Subtask 6.4.6; Story MOTIR-6169) show only these, so a project
   * the actor cannot enter is ABSENT (never shown-then-denied). Takes the
   * already-loaded `Project` rows and resolves the actor in ONE pass — workspace
   * role and scope once, all project memberships in a single query — then applies
   * the pure {@link canEnter} rule in memory (no N+1). A Manager keeps every
   * project; a non-member gets none.
   *
   * ⚠️ `canEnter`, NOT `canBrowse` (MOTIR-6543). They differ on one cell: a
   * Limited person not added to a `public` project BROWSES it (its link behaves
   * as a Visitor's) but does not ENTER it, and it must not appear in their own
   * lists.
   *
   * ⚠️ It honours the token's PROJECT BINDING itself (MOTIR-5763). This batch
   * path never calls {@link resolveInputs}, so the refusal there did not reach
   * it: a project-bound token was LISTED every project it would then 404 on.
   * A bound actor keeps at most its one project, before any role is read.
   */
  async filterBrowsable<T extends Pick<Project, 'id' | 'accessMode'>>(
    projects: T[],
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<T[]> {
    const tokenProjectId = ctx.tokenProjectId;
    if (tokenProjectId !== undefined) {
      projects = projects.filter((p) => p.id === tokenProjectId);
    }
    if (projects.length === 0) return [];
    // MOTIR-2527: one bound transaction for both reads — `project_membership` is gated
    // on `app.workspace_id` too, so binding only the membership read would silently
    // demote every project member to their bare workspace role.
    if (!tx) {
      return withWorkspaceContext(ctx, (t) =>
        projectAccessService.filterBrowsable(projects, ctx, t),
      );
    }
    const workspaceMembership =
      await workspaceMembershipRepository.findByUserAndWorkspaceWithRoleDefinition(
        ctx.userId,
        ctx.workspaceId,
        tx,
      );
    // The org Owner reads as the manager tier here too (MOTIR-6308).
    const workspaceRole = await composeOwnerReach(
      ctx.userId,
      ctx.workspaceId,
      workspaceMembership,
      tx,
    );
    // A Manager always enters everything; a non-member never enters any.
    if (workspaceRole === 'manager') return projects;
    if (workspaceRole == null) return [];
    const memberships = await projectMembershipRepository.findByUserAndProjects(
      ctx.userId,
      projects.map((p) => p.id),
      tx,
    );
    const added = new Set(memberships.map((m) => m.projectId));
    const accessScope = workspaceMembership?.accessScope ?? null;
    return projects.filter((p) =>
      canEnter({
        accessMode: p.accessMode,
        workspaceRole,
        accessScope,
        addedToProject: added.has(p.id),
      }),
    );
  },

  /**
   * Whether the actor may browse the project, given already-resolved inputs.
   * Pure-policy convenience re-export so the switcher filter (6.4.6) can decide
   * over a batch of inputs without a per-project round-trip.
   */
  canBrowse,
  canEnter,
  canEdit,
  canManageProject,

  /**
   * Resolve `canEdit` for MANY users at once (MOTIR-1910) — "which of these
   * people may change this project?", answered by the same policy every single-
   * actor gate uses.
   *
   * Built for team code access (`docs/decisions/project-repository-set.md` §3
   * Q1): a repository Motir created is handed to exactly the members who can
   * already edit the project, so the grant reuses the product's own membership
   * rule rather than inventing a second one for code. Anything else asking "who
   * on this project can act?" belongs here too — the point is that the answer has
   * ONE implementation.
   *
   * ⚠️ TWO FULL MEMBERSHIP READS, not one per user. The policy needs BOTH roles
   * for each candidate (a workspace owner/admin passes regardless of project
   * membership; an `open` project needs no project membership at all), so a
   * per-user resolve would be 2N round-trips to answer one question about a team.
   * The two lists are workspace-bounded and small.
   *
   * A user absent from BOTH lists resolves to `(null, null)` and is denied by the
   * null-workspace-role rail — the correct answer for someone who is not in the
   * workspace, and the reason this cannot accidentally admit a stranger.
   */
  async resolveCanEditForUsers(
    projectId: string,
    userIds: string[],
    ctx: AccessActorContext,
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (userIds.length === 0) return result;

    // MOTIR-2569: the project read moves INSIDE the transaction that was already
    // being opened below, rather than being bound separately — one context, one
    // snapshot, the same move MOTIR-2527 made in `resolveInputs`. It used to run
    // on the `db` singleton, so under the non-bypass role `project_workspace_or_
    // system_read` hid the row and every caller 404'd before the membership
    // lists were ever read.
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        const project = await projectRepository.findById(projectId, tx);
        if (!project || project.workspaceId !== ctx.workspaceId) {
          throw new ProjectNotFoundError(projectId);
        }
        const [workspaceMembers, projectMembers, organizationClosing] = await Promise.all([
          workspaceMembershipRepository.findMembersByWorkspaceWithRoleDefinition(
            ctx.workspaceId,
            tx,
          ),
          projectMembershipRepository.findMembersByProject(projectId, tx),
          // Nobody edits a closing org's projects, so nobody is handed its code
          // (MOTIR-6396).
          isWorkspaceOrgClosing(ctx.workspaceId, tx),
        ]);
        const byUser = new Map(workspaceMembers.map((m) => [m.userId, m]));
        const added = new Set(projectMembers.map((m) => m.userId));

        for (const userId of userIds) {
          const membership = byUser.get(userId) ?? null;
          const workspaceRole = membership?.workspaceRole ?? null;
          result.set(
            userId,
            canEdit({
              accessMode: project.accessMode,
              workspaceRole,
              accessScope: membership?.accessScope ?? null,
              customRolePermissions: customRolePermissionsOf(workspaceRole, membership),
              addedToProject: added.has(userId),
              organizationClosing,
            }),
          );
        }
        return result;
      },
    );
  },

  /**
   * Assert the actor may BROWSE the project — gate the read paths. Throws
   * ProjectAccessDeniedError('browse') (→ 404, hidden) when they cannot.
   */
  async assertCanBrowse(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
  },

  /**
   * Assert the actor may EDIT the project — gate the write paths. A non-browser
   * is rejected as 'browse' FIRST (→ 404, the project stays hidden — never leak
   * "it exists but you can't write" to someone who can't even see it); a browser
   * who can't edit is rejected as 'edit' (→ 403, read-only). One resolve, both
   * checks, so a single round-trip gates the write.
   */
  async assertCanEdit(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
    if (!canEdit(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * Assert the actor may READ the project's pages (MOTIR-7277). Shaped exactly
   * like {@link assertCanEdit}: a non-browser is refused as 'browse' (→ 404,
   * hidden), a browser without `page:view` as 'edit' (→ 403).
   */
  async assertCanViewPages(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
    if (!canViewPages(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * Assert the actor may WRITE the project's pages — create, rename, save
   * (MOTIR-7277). A non-browser is refused as 'browse' (→ 404), a browser
   * without `page:edit` as 'edit' (→ 403).
   */
  async assertCanEditPages(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
    if (!canEditPages(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * Assert the actor may PERMANENTLY DELETE the project's archived pages
   * (MOTIR-7419). The same refusal shape as {@link assertCanEditPages}: a
   * non-browser is refused as 'browse' (→ 404), a browser without `page:delete`
   * as 'edit' (→ 403).
   */
  async assertCanDeletePages(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
    if (!canDeletePages(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * The actor's PAGE capabilities — the non-throwing form, for the read that
   * renders the editor writable or read-only (`pagesService.getPage`'s `canEdit`).
   * Throws only ProjectNotFoundError.
   */
  async getPageCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canViewPages: boolean; canEditPages: boolean; canDeletePages: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    const browse = canBrowse(inputs);
    return {
      canViewPages: browse && canViewPages(inputs),
      canEditPages: browse && canEditPages(inputs),
      canDeletePages: browse && canDeletePages(inputs),
    };
  },

  // --- Public-project access (Story 6.12 · Subtask 6.12.3) -------------------
  // These methods go through `resolvePublicInputs` — the SINGLE place the
  // workspace-equality 404 guard is skipped, and ONLY for a `public` project.
  // `actorUserId` is nullable on the READ paths (anonymous public READ) and
  // REQUIRED on the three write-grant asserts (sign-in-to-act: the route has
  // already gated on a session). The pure grant predicates are also re-exported
  // below so a batch/caller can decide without a per-project round-trip.
  canSubmitToTriage,
  canUpvotePublicRequest,
  canCommentPublicRequest,

  /**
   * The actor's PUBLIC-project capabilities — `{ canBrowse, canSubmitToTriage,
   * canUpvotePublicRequest, canCommentPublicRequest }` (the 6.12.4 view + the
   * 6.12.5 / 6.12.6 write entry points). `actorUserId` is NULLABLE: an anonymous
   * (logged-out) reader resolves to `canBrowse: true`; the write grants are true
   * for any account on a public project (authentication is enforced upstream — the
   * write routes gate on a session). Throws ProjectNotFoundError on a non-public
   * project (no existence leak, cross-org or anonymous).
   */
  async getPublicCapabilities(
    projectId: string,
    actorUserId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    canBrowse: boolean;
    canSubmitToTriage: boolean;
    canUpvotePublicRequest: boolean;
    canCommentPublicRequest: boolean;
  }> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    return {
      canBrowse: canBrowse(inputs),
      canSubmitToTriage: canSubmitToTriage(inputs),
      canUpvotePublicRequest: canUpvotePublicRequest(inputs),
      canCommentPublicRequest: canCommentPublicRequest(inputs),
    };
  },

  /**
   * Assert the actor may BROWSE the public project — the anonymous public-read
   * gate (6.12.4). `actorUserId` nullable (logged out / crawler). Throws
   * ProjectNotFoundError (→ 404) on a non-public project (indistinguishable from
   * never-existed); for a public project `canBrowse` is always true, so the
   * assert resolves and returns.
   */
  async assertCanBrowsePublic(
    projectId: string,
    actorUserId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
  },

  /**
   * Assert the actor may BROWSE the public project AND report whether they are a
   * project MEMBER (Story 6.14 · Subtask 6.14.4). One `resolvePublicInputs`
   * round-trip serves both: the same anonymous/cross-org browse gate as {@link
   * assertCanBrowsePublic}, plus the member/non-member split the epic-privacy
   * exclusion keys off. `isMember` is `true` iff the actor holds ANY role in the
   * project's workspace OR the project itself (a workspace member viewing the
   * public `/p` surface bypasses the exclusion); an anonymous reader, a crawler,
   * and a cross-org account all resolve to `isMember: false` (null roles) — the
   * population a private epic's children must never reach. Throws
   * ProjectNotFoundError (→ 404) on a non-public project (no existence leak).
   */
  async resolvePublicBrowse(
    projectId: string,
    actorUserId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<{ isMember: boolean; canManage: boolean }> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
    return {
      // A MEMBER here is someone who can ENTER the project (MOTIR-6543): a
      // Limited person not added to it reads the public page as a Visitor does.
      isMember: canEnter(inputs),
      // The in-place "Edit" affordance gate for the public page (Subtask 6.16.3)
      // — admin-only; an anonymous / cross-org viewer resolves to `false`.
      canManage: canManageProject(inputs),
    };
  },

  /**
   * THE VISITOR'S ONE RESOLUTION (Story MOTIR-6170 · MOTIR-6642, MOTIR-6666;
   * `public-projects.md` AMENDMENTS 2–3, `visitor-sign-in-and-records.md`). Given
   * the identifier a Visitor URL carries and the request's session (or none),
   * answer who this reader is on that project, asking in THIS order — the order
   * is the privacy boundary:
   *
   * 1. `not_found` when the public surface is off (`isCloud()` false — the same
   *    predicate `publicSurfaceUnavailable` answers), when no public project
   *    carries the identifier, or when the project it names is not `public`. ONE
   *    frozen value, asked BEFORE the session, so a signed-out stranger learns no
   *    more about a private project than a signed-in one.
   * 2. `sign_in` when there is no session: reading the live views needs an
   *    account. It carries only the key, for the way back.
   * 3. `enter` when the session's user can ENTER the project (`canEnter`): they
   *    belong in their own view, and are never asked to consent.
   * 4. `consent` when they cannot enter and have no visitor record for this
   *    project yet: the one-time consent screen comes first. It carries what that
   *    screen says — the project's name and key and the workspace's name — and
   *    nothing from inside the project.
   * 5. `visitor` otherwise, with the {@link VisitorReadContext} every Visitor
   *    read takes (the Visitor key set and the private-epic hidden set), and the
   *    record's latest visit touched on the way (never failing the read).
   *
   * Built ON {@link resolvePublicInputs}, the existing cross-org touch-point, so it
   * is not a third place that grants cross-org read (`public-projects.md` §2).
   */
  async resolveVisitor(
    identifier: string,
    session: { user: { id: string } } | null,
  ): Promise<VisitorVerdict> {
    if (!isCloud()) return VISITOR_NOT_FOUND;
    // The same resolver `publicProjectsService.resolvePublicProject` uses: the one
    // PUBLIC project carrying this key, across workspaces.
    const project = await projectRepository.findPublicByIdentifier(identifier);
    if (!project || project.accessMode !== 'public') return VISITOR_NOT_FOUND;

    if (!session) return { kind: 'sign_in', identifier: project.identifier };
    const actorUserId = session.user.id;

    let inputs: ProjectAccessInputs;
    try {
      inputs = await resolvePublicInputs(project.id, actorUserId);
    } catch (err) {
      // A project that stopped being public between the two reads is the same
      // not-found as one that never was.
      if (err instanceof ProjectNotFoundError) return VISITOR_NOT_FOUND;
      throw err;
    }
    if (canEnter(inputs)) return { kind: 'enter', project };

    // BOUND to the project's own workspace — a value the database handed us above,
    // never the reader's — so the reads see exactly this project's rows under the
    // non-bypass role (the RLS call-site guard's rule for a new caller).
    const { record, hidden, workspace } = await withWorkspaceServiceContext(
      project.workspaceId,
      async (tx) => {
        const found = await projectVisitorRepository.findByProjectAndUser(
          project.id,
          actorUserId,
          tx,
        );
        if (!found) {
          return {
            record: null,
            hidden: [],
            workspace: await workspaceRepository.findById(project.workspaceId, tx),
          };
        }
        return {
          record: found,
          hidden: await workItemRepository.findPublicHiddenDescendantIds(
            project.id,
            project.workspaceId,
            tx,
          ),
          workspace: null,
        };
      },
    );
    if (!record) {
      return {
        kind: 'consent',
        subject: {
          identifier: project.identifier,
          projectName: project.name,
          workspaceName: workspace?.name ?? project.name,
        },
      };
    }

    const ctx: VisitorReadContext = {
      kind: 'visitor',
      project,
      actorUserId,
      permissions: VISITOR_PERMISSIONS,
      hiddenIds: new Set(hidden),
    };
    await visitorRecordsService.touchVisit(ctx, record.lastVisitAt);
    return { kind: 'visitor', ctx };
  },

  /**
   * Assert the (authenticated) actor may SUBMIT a request into the public
   * project's triage (6.12.5). `actorUserId` is REQUIRED — the route has gated on
   * a session (sign-in-to-act). Throws ProjectNotFoundError (→ 404) on a
   * non-public project; ProjectAccessDeniedError('edit') if the grant is denied.
   */
  async assertCanSubmitToTriage(
    projectId: string,
    actorUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canSubmitToTriage(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * Assert the (authenticated) actor may UPVOTE a public request (6.12.6).
   * `actorUserId` REQUIRED. Throws ProjectNotFoundError (→ 404) on a non-public
   * project; ProjectAccessDeniedError('edit') if the grant is denied.
   */
  async assertCanUpvotePublicRequest(
    projectId: string,
    actorUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canUpvotePublicRequest(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * Assert the (authenticated) actor may COMMENT on a public request (6.12.6).
   * `actorUserId` REQUIRED. Throws ProjectNotFoundError (→ 404) on a non-public
   * project; ProjectAccessDeniedError('edit') if the grant is denied.
   */
  async assertCanCommentPublicRequest(
    projectId: string,
    actorUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canCommentPublicRequest(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * The actor's PROJECT-SETTINGS-area capabilities — `{ canBrowse, canEdit,
   * canManage }` in ONE `resolveInputs` round-trip (Story 6.5 · Subtask 6.5.2).
   * Feeds the (authed) shell: `canEdit` drives the `ProjectAccessProvider`
   * edit-affordance gating (unchanged), while `{ canBrowse, canManage }` drive
   * the settings-nav registry's per-entry `access` predicates (a non-browser
   * sees neither nav entry nor page; admin-only entries — Story 6.6 — gate on
   * `canManage`). Replacing the bare `getCapabilities` call in the layout with
   * this keeps the round-trip count at one. Throws only ProjectNotFoundError.
   */
  async getSettingsCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canEdit: boolean; canManage: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return {
      canBrowse: canBrowse(inputs),
      canEdit: canEdit(inputs),
      canManage: canManageProject(inputs),
    };
  },

  /**
   * The actor's project-ADMIN capability — `{ canBrowse, canManage }`. The
   * non-throwing form, for the admin-only settings surfaces (automation rules,
   * Story 6.6) that render their nav entry + page only when `canManage`. Throws
   * only ProjectNotFoundError (the project must resolve; a non-browser still
   * reads as 404 so the surface stays hidden, never "exists but you can't").
   */
  async getManageCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canManage: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return { canBrowse: canBrowse(inputs), canManage: canManageProject(inputs) };
  },

  /**
   * Assert the actor holds `key` on the project — THE administrative gate
   * (Story MOTIR-2256 · Subtask MOTIR-2293). One method that takes the KEY,
   * rather than one method per question: a role is a permission SET, so the
   * number of questions the code can be asked is the size of the catalog, and a
   * method per question does not scale to a catalog that grows (nor to Story
   * MOTIR-2257's custom roles, where the set is chosen by a person).
   *
   * The refusal ORDER is `assertCanManage`'s, unchanged, and it is load-bearing:
   *   1. A NON-BROWSER is rejected as ProjectNotFoundError (→ 404) FIRST. A
   *      settings surface a viewer cannot even see must look MISSING, not
   *      forbidden — the no-existence-leak posture (finding #26). This runs
   *      before the key test, so a 403 never confirms a project the actor may
   *      not browse.
   *   2. A BROWSER who does not hold the key is rejected with a typed 403.
   *
   * ⚠️ THE 403 SHAPE HAS A COMPATIBILITY BRANCH. `project:administer` keeps
   * throwing NotProjectAdminError, so the shipped `NOT_PROJECT_ADMIN` wire code
   * keeps reaching the three places that read it by string (the workflow
   * settings action, `lib/workflows/errors.ts`, and the components-settings
   * editor test). Every OTHER key throws PermissionDeniedError, which carries
   * the key it asked for. Both map to 403 in `projectErrorResponse`. Collapse
   * the branch once nothing reads the old code — see the note on
   * PermissionDeniedError.
   *
   * One `resolveInputs` round-trip; `tx` threads through it so a caller already
   * inside a transaction shares the snapshot AND the RLS workspace GUC that
   * transaction bound.
   */
  async assertPermission(
    projectId: string,
    ctx: AccessActorContext,
    key: PermissionKey,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectNotFoundError(projectId);
    if (hasPermission(inputs, key)) return;
    if (key === 'project:administer') throw new NotProjectAdminError(projectId);
    throw new PermissionDeniedError(projectId, key);
  },

  /**
   * Assert the actor may ADMINISTER the project — gate the project-settings
   * write paths (automation CRUD in Story 6.6). A non-browser is rejected as
   * ProjectNotFoundError FIRST (→ 404, the project stays hidden — the same
   * no-existence-leak rule `assertCanEdit` follows, but a settings surface a
   * viewer can't even see must look missing, not forbidden); a browser who is
   * not an admin is rejected as NotProjectAdminError (→ 403). One resolve, both
   * checks.
   *
   * ⚠️ NOW AN ALIAS for `assertPermission(…, 'project:administer')` — same
   * signature, same errors, same ordering, so every existing call site behaves
   * identically and none had to change. It SURVIVES the MOTIR-2256 split as the
   * gate on the project-level acts that belong to no domain (rename, key change,
   * archive, alias release); a call site that guards a DOMAIN moves to
   * `assertPermission` with that domain's key, one card at a time.
   */
  async assertCanManage(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.assertPermission(projectId, ctx, 'project:administer', tx);
  },

  // --- The permission model (Story MOTIR-2255 · Subtask MOTIR-2262) ---------
  // The GENERAL read the five `getXCapabilities` methods above are specialised
  // versions of. Each of those grew when a story needed access decisions in a
  // new domain — comments, attachments, watchers, saved filters, settings — and
  // each resolves the same three facts to answer three or four booleans. Once a
  // role is a permission SET, `getPermissions` is the read they all specialise,
  // and the pattern stops needing a sixth sibling.
  //
  // ⚠️ The five are DELIBERATELY left alone by this card. They are called from
  // ~40 places; re-pointing them belongs with the surfaces that consume the set
  // (Story MOTIR-2258), not with the card that introduces it. Their agreement
  // with `getPermissions` is asserted by the story test gate (MOTIR-2264).

  /**
   * The actor's full effective permission SET on a project — one `resolveInputs`
   * round trip, then the pure resolution. The general form of every
   * `getXCapabilities` method above: instead of asking "may I comment?" and "may
   * I moderate?" separately, a caller asks once and tests membership.
   *
   * Throws only ProjectNotFoundError — never a 403-shaped error — for a project
   * that is missing OR in another workspace, preserving the shipped
   * no-existence-leak posture (finding #26).
   */
  async getPermissions(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<ReadonlySet<PermissionKey>> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return resolvePermissions(inputs);
  },

  /**
   * Every user who holds `permission` on the project (MOTIR-12106) — who an
   * event about the project tells, when no actor asks. The candidates are the
   * workspace's members and the owners and admins of its organization (who reach
   * every workspace of it as a Manager without a membership); each is then
   * resolved by {@link getPermissions} itself, as that user, so the list and a
   * user's own permission read can never disagree. Ordered by user id.
   *
   * Opens its own reads: call it outside a transaction.
   */
  async listUserIdsWithPermission(
    scope: { projectId: string; workspaceId: string },
    permission: PermissionKey,
  ): Promise<string[]> {
    const { ids: candidates, organizationId } = await withWorkspaceServiceContext(
      scope.workspaceId,
      async (tx) => {
        const members = await workspaceMembershipRepository.findMembersByWorkspace(
          scope.workspaceId,
          tx,
        );
        const workspace = await workspaceRepository.findByIdInTx(scope.workspaceId, tx);
        return {
          ids: new Set(members.map((m) => m.userId)),
          organizationId: workspace?.organizationId ?? null,
        };
      },
    );
    // The org's Owner and Admins are other people's org rows, read in the
    // userless org-service context of the workspace's own organization — a
    // trusted resolution (the workspace row just read), never caller input.
    if (organizationId) {
      const managers = await withOrgServiceWriteContext(organizationId, (tx) =>
        organizationMembershipRepository.findManagerUserIdsByOrganization(organizationId, tx),
      );
      for (const id of managers) candidates.add(id);
    }

    const holders: string[] = [];
    for (const userId of [...candidates].sort()) {
      let held: ReadonlySet<PermissionKey>;
      try {
        held = await this.getPermissions(scope.projectId, {
          userId,
          workspaceId: scope.workspaceId,
        });
      } catch (err) {
        // A candidate who cannot see the project holds nothing on it.
        if (err instanceof ProjectNotFoundError) continue;
        throw err;
      }
      if (held.has(permission)) holders.push(userId);
    }
    return holders;
  },

  /**
   * The actor's own permissions as a serialisable DTO — the set flattened to an
   * array in CATALOG order, which is what crosses to a client island or a Server
   * Component's props. A `Set` cannot; an unsorted array crosses
   * non-deterministically and makes the grid reshuffle for no visible reason.
   */
  async getPermissionsDTO(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<ActorPermissionsDTO> {
    const held = await this.getPermissions(projectId, ctx, tx);
    return toActorPermissionsDTO(projectId, held);
  },
};
