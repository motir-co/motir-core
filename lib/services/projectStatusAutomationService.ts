import type { Prisma } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { reconcileInheritedDeliveriesForProject } from '@/lib/services/inheritedDeliveryService';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { InvalidStatusAutomationSettingsError, ProjectNotFoundError } from '@/lib/projects/errors';
import { toProjectStatusAutomationDto } from '@/lib/mappers/projectStatusAutomationMappers';
import type {
  ProjectStatusAutomationDto,
  UpdateProjectStatusAutomationInput,
} from '@/lib/dto/projectStatusAutomation';

// Project STATUS-AUTOMATION settings service (Story MOTIR-1615 · Subtask
// MOTIR-1618) — the business logic over the two derivation switches on `project`
// (`autoRollupParentStatus` / `autoCompleteChildrenOnParentDone`), decided in
// `docs/decisions/status-derivation.md` §2.
//
// Two independent booleans rather than one combined switch, because the two
// directions carry different risk: the upward rollup only ever reflects work that
// genuinely happened, while the downward cascade auto-completes children —
// including unstarted ones. One switch could not express upward-only, which is
// the commonest preference. Both default ON: two-way sync is Motir's opinion, and
// a toggle turns its direction off rather than opting into it.
//
// 4-layer (CLAUDE.md): the repository does the single Prisma ops, this service
// owns the transaction + the gate + validation, the mapper produces the DTO.
// Reads are browse-scoped (any member of a browsable project may see the
// configuration); WRITES ask `automation:manage` via `assertPermission`
// (MOTIR-2297 — behaviour-neutral; it was `assertCanManage`, i.e. the same
// `project:administer` answer, and the key now says WHICH grant is required)
// — exactly like `projectAiSettingsService` / `projectsService.updateDetails`,
// since flipping a derivation switch changes how every status move in the project
// behaves.
//
// NOTE the derivation SERVICES do not come through here. `parentStatusRollupService`
// (MOTIR-1620) and `childStatusCascadeService` (MOTIR-1647) read
// `projectRepository.findStatusAutomation` directly: they run under a system
// context with no browsing user, so the browse gate this service applies would be
// wrong for them, and they need the raw switch, not a DTO.

export const projectStatusAutomationService = {
  /**
   * Read a project's status-automation settings by project key. Browse-gated: a
   * missing, cross-workspace, or non-browsable project all read as
   * `ProjectNotFoundError` (404, no existence leak — finding #26).
   *
   * Throws: `ProjectNotFoundError` (404).
   */
  async getStatusAutomation(
    key: string,
    ctx: WorkspaceContext,
  ): Promise<ProjectStatusAutomationDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const project = await resolveProjectByKeyInTx(key, ctx.workspaceId, tx);
      await projectAccessService.assertCanBrowse(project.id, ctx, tx);
      const settings = await projectRepository.findStatusAutomation(project.id, tx);
      // The row was just resolved inside this transaction, so a null here would
      // mean it vanished mid-transaction; treat it as not-found rather than
      // returning a half-shape.
      if (!settings) throw new ProjectNotFoundError(key);
      return toProjectStatusAutomationDto(settings);
    });
  },

  /**
   * Update a project's status-automation settings. Admin-gated
   * (`automation:manage`). A PARTIAL patch: an ABSENT field is left untouched, so
   * the panel can save one toggle without clobbering the other.
   *
   * Values are validated BEFORE the transaction opens (no DB touch on a rejected
   * edit). Returns the updated settings — the inline save reads the success
   * response as its confirmation, with no whole-tree refresh (CLAUDE.md § page
   * state).
   *
   * Throws: `ProjectNotFoundError` (404), `NotProjectAdminError` (403),
   * `InvalidStatusAutomationSettingsError` (422).
   */
  async updateStatusAutomation(
    key: string,
    patch: UpdateProjectStatusAutomationInput,
    ctx: WorkspaceContext,
  ): Promise<ProjectStatusAutomationDto> {
    const data = validateStatusAutomationPatch(patch);

    return withWorkspaceContext(ctx, async (tx) => {
      const project = await resolveProjectByKeyInTx(key, ctx.workspaceId, tx);
      await projectAccessService.assertPermission(project.id, ctx, 'automation:manage', tx);
      const before = await projectRepository.findStatusAutomation(project.id, tx);
      const updated = await projectRepository.updateStatusAutomation(project.id, data, tx);
      // The switch is the rule a parent's inherited deliveries follow, so flipping it
      // writes them or takes them back across the project's open pull requests, in
      // this transaction (MOTIR-11839).
      if (before?.autoCompleteChildrenOnParentDone !== updated.autoCompleteChildrenOnParentDone) {
        await reconcileInheritedDeliveriesForProject(project.id, tx);
      }
      return toProjectStatusAutomationDto(updated);
    });
  },
};

/**
 * Resolve a project by its workspace-unique key inside the caller's transaction.
 * Deliberately alias-BLIND, mirroring `projectAiSettingsService`'s resolver: a
 * settings surface addresses the live project, never a retired key. A key naming
 * a project in another workspace and a never-existed key are indistinguishable —
 * both `ProjectNotFoundError` (no existence leak).
 */
async function resolveProjectByKeyInTx(
  key: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<{ id: string }> {
  const identifier = key.trim().toUpperCase();
  const project = await projectRepository.findByIdentifier(workspaceId, identifier, tx);
  if (!project) throw new ProjectNotFoundError(key);
  return project;
}

/**
 * Validate the patch and return the Prisma update payload (only the supplied
 * fields). Both switches are plain booleans, so the only check is that they ARE
 * booleans — a truthy `"false"` string flipped through unchecked would silently
 * enable a direction the admin was turning off.
 */
function validateStatusAutomationPatch(patch: UpdateProjectStatusAutomationInput): {
  autoRollupParentStatus?: boolean;
  autoCompleteChildrenOnParentDone?: boolean;
} {
  const data: {
    autoRollupParentStatus?: boolean;
    autoCompleteChildrenOnParentDone?: boolean;
  } = {};

  if (patch.autoRollupParentStatus !== undefined) {
    if (typeof patch.autoRollupParentStatus !== 'boolean') {
      throw new InvalidStatusAutomationSettingsError('autoRollupParentStatus');
    }
    data.autoRollupParentStatus = patch.autoRollupParentStatus;
  }

  if (patch.autoCompleteChildrenOnParentDone !== undefined) {
    if (typeof patch.autoCompleteChildrenOnParentDone !== 'boolean') {
      throw new InvalidStatusAutomationSettingsError('autoCompleteChildrenOnParentDone');
    }
    data.autoCompleteChildrenOnParentDone = patch.autoCompleteChildrenOnParentDone;
  }

  return data;
}
