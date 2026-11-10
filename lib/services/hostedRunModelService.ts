import 'server-only';

import {
  getAgentModels,
  type AgentModel,
  type AgentModelsRead,
  type AgentModelDefaultsByDifficulty,
} from '@/lib/ai/motirAiClient';
import { platformRunModelRepository } from '@/lib/repositories/platformRunModelRepository';
import { resolveReviewModel, type OrgHostedModelLayer } from '@/lib/hosted/resolveHostedModel';
import {
  HostedModelNotOfferedError,
  HostedModelsUnavailableError,
  HostedNoModelOfferedError,
} from '@/lib/hostedRuns/errors';

// THE ONE ANSWER TO "WHICH MODELS MAY A HOSTED RUN USE?" (MOTIR-6483;
// `docs/decisions/hosted-agent-run.md` §7, as amended by MOTIR-7522).
//
// The Run hosted picker reads it through `GET /api/hosted-runs/models`, and the
// start path (MOTIR-690) calls `assertOffered` before it opens, mints or boots
// anything. Both go through here, so a model can never appear in the picker and
// then be refused by a second, differently-built check — or the reverse.
//
// ⚠️ THE OFFER IS THE RUN-MODEL LIST ∩ motir-ai's ANSWER, READ FRESH EVERY TIME
// (§7's amendment, MOTIR-7526). motir-ai says which models EXIST; motir-core's
// run-model list (`platform_run_model`, curated in the operator console) says
// which of them MAY be used. Neither is cached: the start path must refuse a
// model withdrawn — or delisted — a minute ago. The list can only NARROW
// motir-ai's answer, so a listed model motir-ai drops is simply not offered.
// A list never initialised narrows nothing: its first read seeds it with the
// whole offer, so the two answers are the same.
//
// ⚠️ "motir-ai IS DOWN" NEVER READS AS "NO MODELS EXIST". The client returns a
// typed `unavailable` for every failure, and it is carried through here as its
// own state, never flattened into an empty list.

/** What the picker is handed: the offered models and the preselected one. */
export type OfferedModels =
  | {
      state: 'ok';
      models: AgentModel[];
      default: string | null;
      /** motir-ai's platform default per difficulty level (MOTIR-6993). */
      defaultsByDifficulty: AgentModelDefaultsByDifficulty;
      /** The platform review-agent model (MOTIR-10843) — null when unset or unlisted. */
      reviewAgentDefault: string | null;
      /** The platform design-run model (MOTIR-10843) — null when unset or unlisted. */
      designRunDefault: string | null;
    }
  | { state: 'unavailable' };

/**
 * An offered model → the id OpenCode is started with: `<provider>/<bare id>`
 * (`docs/decisions/hosted-agent-run.md` §7, *one id, two spellings*, as amended
 * by MOTIR-7206). The provider comes from motir-ai's offered ENTRY, never from
 * parsing the id and never from a list kept here.
 *
 * THE ONE PLACE a provider prefix is written — `tests/hostedRuns/openCodeModelPrefix.test.ts`
 * holds every other module to never writing one. The gateway's allow-list,
 * `DispatchRun.model` and `implementationModel` all hold the BARE id; putting the
 * prefixed form on the key's allow-list gets every model call refused with 403.
 */
export function toOpenCodeModel(model: Pick<AgentModel, 'id' | 'provider'>): string {
  return `${model.provider}/${model.id}`;
}

/** motir-ai's answer narrowed to the run-model list — the one place the two meet. */
async function readOffer(): Promise<AgentModelsRead> {
  const [read, listed] = await Promise.all([
    getAgentModels(),
    platformRunModelRepository.findListedModelsForOffer(),
  ]);
  if (read.state === 'unavailable' || listed === null) return read;
  const allowed = new Set(listed);
  const keep = (id: string | null) => (id !== null && allowed.has(id) ? id : null);
  return {
    ...read,
    models: read.models.filter((m) => allowed.has(m.id)),
    default: keep(read.default),
    defaultsByDifficulty: {
      trivial: keep(read.defaultsByDifficulty.trivial),
      low: keep(read.defaultsByDifficulty.low),
      medium: keep(read.defaultsByDifficulty.medium),
      high: keep(read.defaultsByDifficulty.high),
    },
    reviewAgentDefault: keep(read.reviewAgentDefault),
    designRunDefault: keep(read.designRunDefault),
  };
}

export const hostedRunModelService = {
  /**
   * The offered list — motir-ai's answer narrowed to the run-model list — or
   * `unavailable`. A default that names an unlisted model reads `null`, exactly
   * as an unoffered one does.
   */
  async listOfferedModels(): Promise<OfferedModels> {
    const read = await readOffer();
    if (read.state === 'unavailable') return { state: 'unavailable' };
    return {
      state: 'ok',
      models: read.models,
      default: read.default,
      defaultsByDifficulty: read.defaultsByDifficulty,
      reviewAgentDefault: read.reviewAgentDefault,
      designRunDefault: read.designRunDefault,
    };
  },

  /**
   * Resolves to the OFFERED ENTRY when `model` (a bare gateway id) is on the
   * offered list right now — listed AND offered by motir-ai — so the start path has its provider without a second
   * read of motir-ai. Throws `HostedModelNotOfferedError` when it is not, and
   * `HostedModelsUnavailableError` when motir-ai cannot answer — an unanswered
   * question is never an acceptance.
   */
  async assertOffered(model: string): Promise<AgentModel> {
    const read = await readOffer();
    if (read.state === 'unavailable') throw new HostedModelsUnavailableError(read.reason);
    const offered = read.models.find((m) => m.id === model);
    if (!offered) throw new HostedModelNotOfferedError(model);
    return offered;
  },

  /**
   * The model a run with NOBODY TO CHOOSE takes — a REVIEW run (MOTIR-6820;
   * `hosted-agent-run.md` §7's pointer): the list's default, else the first model offered.
   * Resolves to the offered ENTRY, so its provider travels with it (MOTIR-7208).
   * Throws `HostedModelsUnavailableError` when motir-ai cannot answer, and
   * `HostedNoModelOfferedError` when it answers an empty list — either is a review that
   * could not run, reason _no model_.
   */
  async defaultOffered(): Promise<AgentModel> {
    const read = await readOffer();
    if (read.state === 'unavailable') throw new HostedModelsUnavailableError(read.reason);
    const chosen =
      (read.default ? read.models.find((m) => m.id === read.default) : undefined) ?? read.models[0];
    if (!chosen) throw new HostedNoModelOfferedError();
    return chosen;
  },

  /**
   * The model a hosted REVIEW is asked to run on (MOTIR-10843): the organisation's
   * review-agent model while it qualifies (`org` non-null) and it is offered, else
   * the platform review-agent model, else `undefined` — the review then takes
   * {@link defaultOffered}, exactly as before. Never throws for an unanswered
   * offer: the start path's own model step refuses that.
   */
  async reviewModelFor(
    org: Pick<OrgHostedModelLayer, 'review'> | null,
  ): Promise<string | undefined> {
    const read = await readOffer();
    if (read.state === 'unavailable') return undefined;
    return (
      resolveReviewModel(
        { models: read.models.map((m) => m.id), reviewAgentDefault: read.reviewAgentDefault },
        org,
      )?.model ?? undefined
    );
  },

  toOpenCodeModel,
};
