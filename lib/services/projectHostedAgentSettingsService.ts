import type { Prisma } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { hostedRunModelService } from '@/lib/services/hostedRunModelService';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { HostedModelNotOfferedError, HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import {
  highestDifficulty,
  isDesignRun,
  resolveHostedModel,
  type HostedModelOffer,
  type OrgHostedModelLayer,
} from '@/lib/hosted/resolveHostedModel';
import { orgHostedModelResolutionService } from '@/lib/services/orgHostedModelResolutionService';
import {
  toHostedModelOverrideColumns,
  toHostedModelOverrides,
  toProjectHostedAgentSettingsDto,
} from '@/lib/mappers/projectHostedAgentSettingsMappers';
import type {
  HostedAgentOfferedModelDto,
  ProjectHostedAgentSettingsDto,
  ResolvedWorkItemHostedModelDto,
  UpdateProjectHostedAgentSettingsInput,
} from '@/lib/dto/projectHostedAgentSettings';

// A project's HOSTED-AGENT settings (Story MOTIR-6989 · MOTIR-6993): which model
// a hosted run uses for each leaf difficulty. The project stores only its
// OVERRIDES (four nullable columns); the platform defaults and the offered list
// are motir-ai's (`GET /v1/agent-models`), read fresh on every call through
// `hostedRunModelService` — never cached, never copied.
//
// Every effective model this service reports comes from `resolveHostedModel`,
// the one rule the Run hosted picker and the start path also call.
//
// Gates follow the settings room's two keys (design MOTIR-6991): a READ asks for
// `work_item:edit` (the room's VIEW key), a WRITE for `ai:configure`. A save refuses a model motir-ai
// does not offer (`HostedModelNotOfferedError`, 422) and writes nothing; while
// motir-ai cannot answer, nothing can be read or saved
// (`HostedModelsUnavailableError`, 503) — an unanswered list is never "empty".

/** motir-ai's offer plus each model's provider, or the typed error that it could not be read. */
async function readOfferWithModels(): Promise<{
  offer: HostedModelOffer;
  models: HostedAgentOfferedModelDto[];
}> {
  const offered = await hostedRunModelService.listOfferedModels();
  if (offered.state === 'unavailable') {
    throw new HostedModelsUnavailableError('motir-ai could not be reached');
  }
  return {
    offer: {
      models: offered.models.map((m) => m.id),
      default: offered.default,
      defaultsByDifficulty: offered.defaultsByDifficulty,
      reviewAgentDefault: offered.reviewAgentDefault,
      designRunDefault: offered.designRunDefault,
    },
    models: offered.models.map((m) => ({ id: m.id, provider: m.provider })),
  };
}

/** motir-ai's offer, or the typed error that it could not be read. */
async function readOffer(): Promise<HostedModelOffer> {
  return (await readOfferWithModels()).offer;
}

/** The organisation's run-side layer while it qualifies (MOTIR-10843), else null. */
async function readLayer(ctx: WorkspaceContext): Promise<OrgHostedModelLayer | null> {
  return (await orgHostedModelResolutionService.readOrgLayer(ctx)).layer;
}

async function resolveProjectByKeyInTx(
  key: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<{ id: string }> {
  const project = await projectRepository.findByIdentifier(
    workspaceId,
    key.trim().toUpperCase(),
    tx,
  );
  if (!project) throw new ProjectNotFoundError(key);
  return project;
}

/** Validate a patch against the offered list: `null` / blank resets, anything else must be offered. */
function validatePatch(
  patch: UpdateProjectHostedAgentSettingsInput,
  offer: HostedModelOffer,
): UpdateProjectHostedAgentSettingsInput {
  const out: UpdateProjectHostedAgentSettingsInput = {};
  for (const level of WORK_ITEM_DIFFICULTIES) {
    const value: unknown = patch[level];
    if (value === undefined) continue;
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      out[level] = null;
      continue;
    }
    const model = typeof value === 'string' ? value.trim() : String(value);
    if (!offer.models.includes(model)) throw new HostedModelNotOfferedError(model);
    out[level] = model;
  }
  return out;
}

export const projectHostedAgentSettingsService = {
  /**
   * Every level's override, whether it is still offered, the platform default and
   * the effective model. Gated on `work_item:edit` — the settings room's VIEW key
   * (MOTIR-6995, design MOTIR-6991) and the key the hosted START asserts:
   * whoever may press Run hosted may read which model it runs on. A non-browser
   * gets 404 (no existence leak); a browser without the key, 403.
   *
   * Throws: `ProjectNotFoundError` (404), `PermissionDeniedError` (403),
   * `HostedModelsUnavailableError` (503).
   */
  async get(projectKey: string, ctx: WorkspaceContext): Promise<ProjectHostedAgentSettingsDto> {
    const row = await withWorkspaceContext(ctx, async (tx) => {
      const project = await resolveProjectByKeyInTx(projectKey, ctx.workspaceId, tx);
      await projectAccessService.assertPermission(project.id, ctx, 'work_item:edit', tx);
      const overrides = await projectRepository.findHostedModelOverrides(project.id, tx);
      if (!overrides) throw new ProjectNotFoundError(projectKey);
      return overrides;
    });
    const [{ offer, models }, org] = await Promise.all([readOfferWithModels(), readLayer(ctx)]);
    return toProjectHostedAgentSettingsDto(row, offer, models, org);
  },

  /**
   * Set or reset any subset of the four levels. A partial patch: an absent level
   * is untouched, `null` resets it to the platform default. Asserts
   * `ai:configure`; a model motir-ai does not offer is refused before anything
   * is written.
   *
   * Throws: `ProjectNotFoundError` (404), `PermissionDeniedError` (403),
   * `HostedModelNotOfferedError` (422), `HostedModelsUnavailableError` (503).
   */
  async update(
    projectKey: string,
    patch: UpdateProjectHostedAgentSettingsInput,
    ctx: WorkspaceContext,
  ): Promise<ProjectHostedAgentSettingsDto> {
    const { offer, models } = await readOfferWithModels();
    const valid = validatePatch(patch, offer);
    const row = await withWorkspaceContext(ctx, async (tx) => {
      const project = await resolveProjectByKeyInTx(projectKey, ctx.workspaceId, tx);
      await projectAccessService.assertPermission(project.id, ctx, 'ai:configure', tx);
      return projectRepository.updateHostedModelOverrides(
        project.id,
        toHostedModelOverrideColumns(valid),
        tx,
      );
    });
    return toProjectHostedAgentSettingsDto(row, offer, models, await readLayer(ctx));
  },

  /**
   * The model a hosted run on this card uses: a leaf's difficulty, or a parent's
   * highest difficulty among its unfinished leaf descendants, resolved against
   * the project's overrides, the organisation's run-side layer (while it
   * qualifies) and motir-ai's offer; a design run (every unfinished leaf a design
   * card) takes the design-run branch first. `null` when nothing is offered.
   * Reads only — the caller has already authorized the card. Pass `offer` when
   * the caller already holds motir-ai's answer, so one request asks it once.
   *
   * Throws: `HostedModelsUnavailableError` (motir-ai cannot answer and no `offer`).
   */
  async resolveForWorkItem(
    workItemId: string,
    ctx: WorkspaceContext,
    offer?: HostedModelOffer,
  ): Promise<ResolvedWorkItemHostedModelDto | null> {
    const read = await withWorkspaceContext(ctx, async (tx) => {
      const [item] = await workItemRepository.findByIds([workItemId], tx);
      if (!item) return null;
      const children = await workItemRepository.findChildren(item.id, tx);
      const leaves = await workItemRepository.findUnfinishedLeafDifficulties(
        item.id,
        ctx.workspaceId,
        tx,
      );
      const overrides = await projectRepository.findHostedModelOverrides(item.projectId, tx);
      return { fromLeaves: children.length > 0, leaves, overrides };
    });
    if (!read || !read.overrides) return null;
    const difficulty = highestDifficulty(
      read.leaves.map((l) => l.difficulty),
      WORK_ITEM_DIFFICULTIES,
    );
    const design = isDesignRun(read.leaves);
    const [offered, org] = await Promise.all([offer ?? readOffer(), readLayer(ctx)]);
    const resolved = resolveHostedModel({
      difficulty,
      overrides: toHostedModelOverrides(read.overrides),
      offered,
      org,
      design,
    });
    if (!resolved) return null;
    return { ...resolved, difficulty, fromLeaves: read.fromLeaves, design };
  },
};
