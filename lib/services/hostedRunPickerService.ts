import type { AgentModel } from '@/lib/ai/motirAiClient';
import type { AgentCapacityVerdict } from '@/lib/hostedRuns/agentCapacityVerdict';
import { agentRunCapacityService } from '@/lib/services/agentRunCapacityService';
import { hostedRunModelService } from '@/lib/services/hostedRunModelService';
import { projectHostedAgentSettingsService } from '@/lib/services/projectHostedAgentSettingsService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import type { HostedModelOffer } from '@/lib/hosted/resolveHostedModel';
import type {
  HostedModelCapacityDto,
  HostedPickerModelDto,
  HostedPickerModelsDto,
  ResolvedWorkItemHostedModelDto,
} from '@/lib/dto/projectHostedAgentSettings';

// THE RUN HOSTED PICKER'S READ (MOTIR-6483; Story MOTIR-6989 · MOTIR-6996) —
// what `GET /api/hosted-runs/models` answers.
//
// motir-ai's offered list and its single default, exactly as before, plus —
// when the picker names its card — that card's resolved preselection and WHY
// (`projectHostedAgentSettingsService.resolveForWorkItem`, the same rule the
// start path runs, so the picker opens on the model a model-less start would
// use). motir-ai is asked ONCE for both.
//
// ⚠️ THE RESOLUTION NEVER BLOCKS THE PICKER. A card the caller cannot browse, a
// key that names nothing, or a failing read answers `resolved: null`, and the
// picker preselects as it always did. Only motir-ai's own silence is
// `unavailable` — the one state that disables the door.
//
// Each offered model carries its agent-run CAPACITY (Story MOTIR-9541 ·
// MOTIR-9629), from the same `agentRunCapacityService` the launch check reads, so
// the picker's label and the start's refusal cannot disagree. ⚠️ THE CAPACITY
// NEVER BLOCKS THE PICKER EITHER: the service fails open, and should it reject
// anyway every model reads `available`.

/** The project key a `MOTIR-<n>` identifier belongs to. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** A refusal that means "not yours to read" — no resolution, and nothing to log. */
function isExpectedRefusal(err: unknown): boolean {
  return (
    err instanceof ProjectNotFoundError ||
    err instanceof WorkItemNotFoundError ||
    err instanceof PermissionDeniedError ||
    err instanceof ProjectAccessDeniedError
  );
}

/** The card's resolved model, browse-gated, or null when it cannot be told. */
async function resolveQuietly(
  workItemKey: string,
  offer: HostedModelOffer,
  ctx: ServiceContext,
): Promise<ResolvedWorkItemHostedModelDto | null> {
  try {
    const identifier = workItemKey.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    return await projectHostedAgentSettingsService.resolveForWorkItem(item.id, ctx, offer);
  } catch (err) {
    if (!isExpectedRefusal(err)) {
      console.error(
        '[hosted-models] resolving the card model failed; preselecting the default',
        err,
      );
    }
    return null;
  }
}

/** The verdict as the wire carries it: `verdict`, and `reason` when held — nothing else. */
function toCapacityDto(verdict: AgentCapacityVerdict | undefined): HostedModelCapacityDto {
  if (verdict?.verdict === 'no_capacity') {
    return { verdict: 'no_capacity', reason: verdict.reason };
  }
  return { verdict: 'available' };
}

/** Every offered model with its capacity, from ONE verdict read; a rejection reads available. */
async function withCapacity(models: AgentModel[]): Promise<HostedPickerModelDto[]> {
  let verdicts = new Map<string, AgentCapacityVerdict>();
  try {
    verdicts = await agentRunCapacityService.verdictsFor(models);
  } catch (err) {
    console.error('[hosted-models] capacity verdict failed; reading every model available', err);
  }
  return models.map((m) => ({
    id: m.id,
    provider: m.provider,
    capacity: toCapacityDto(verdicts.get(m.id)),
  }));
}

export const hostedRunPickerService = {
  /**
   * The offered models and default; with `workItemKey`, also `resolved` — the
   * card's preselection, or null when it could not be resolved. Without it the
   * answer is exactly the pre-MOTIR-6996 shape (no `resolved` key). Every model
   * carries `capacity` either way (MOTIR-9629).
   */
  async readModels(
    workItemKey: string | null,
    ctx: ServiceContext,
  ): Promise<HostedPickerModelsDto> {
    const offered = await hostedRunModelService.listOfferedModels();
    if (offered.state === 'unavailable') return { state: 'unavailable' };
    const base = { state: 'ok' as const, default: offered.default };
    if (workItemKey === null) return { ...base, models: await withCapacity(offered.models) };
    const offer: HostedModelOffer = {
      models: offered.models.map((m) => m.id),
      default: offered.default,
      defaultsByDifficulty: offered.defaultsByDifficulty,
    };
    const [models, resolved] = await Promise.all([
      withCapacity(offered.models),
      resolveQuietly(workItemKey, offer, ctx),
    ]);
    return { ...base, models, resolved };
  },
};
