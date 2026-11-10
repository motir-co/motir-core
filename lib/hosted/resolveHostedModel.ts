import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';

// WHICH MODEL A HOSTED RUN USES (Story MOTIR-6989 · MOTIR-6993, extended by story
// MOTIR-10838 · MOTIR-10843) — the ONE rule the settings room, the Run hosted
// picker and the start path all read, so the three can never disagree about a
// card's model.
//
// Pure: no I/O, no clock, no Prisma. The caller supplies what motir-ai offers
// (narrowed to the run-model list), the project's four overrides, the
// ORGANISATION's run-side layer (or null when the org does not qualify for its own
// choices) and whether the card is a DESIGN run; the answer names the model and
// WHY it won.
//
// Precedence, first set-and-offered value wins:
//   DESIGN BRANCH — only for a design run (a design leaf, or a parent whose every
//   unfinished leaf is a design card). The design-run model is its own function
//   and replaces the difficulty mapping, so it comes before the project's
//   per-difficulty override:
//     1. `org_design`        — the organisation's design-run model;
//     2. `platform_design`   — motir-ai's platform design-run model.
//   THEN THE DIFFICULTY RULE (every card; a design run with neither value set):
//     3. `override`          — the project's override for the level;
//     4. `org_level`         — the organisation's default for the level;
//     5. `platform_level`    — motir-ai's default for the level;
//     6. `platform_default`  — motir-ai's single `default`;
//     7. `first_offered`     — the first model on the offered list.
// A card with no difficulty skips 3–5. A stored value motir-ai (or the run-model
// list) has since WITHDRAWN is skipped at its layer, never an error — the rooms
// flag it instead. With nothing offered at all the answer is `null`: there is no
// model to run. The person's own pick in the picker sits OUTSIDE this rule: the
// start path takes it before resolving.

/** The four per-level values, keyed by difficulty. */
export type HostedModelsByDifficulty = Record<WorkItemDifficultyDto, string | null>;

/** Why the resolved model won. */
export type HostedModelSource =
  | 'org_design'
  | 'platform_design'
  | 'override'
  | 'org_level'
  | 'platform_level'
  | 'platform_default'
  | 'first_offered';

export interface HostedModelOffer {
  /** The offered bare ids, in motir-ai's order. */
  models: readonly string[];
  /** motir-ai's single default — already null when it is not offered. */
  default: string | null;
  /** motir-ai's per-level defaults — each already null when it is not offered. */
  defaultsByDifficulty: HostedModelsByDifficulty;
  /** motir-ai's platform review-agent model — null when unset or not offered. */
  reviewAgentDefault: string | null;
  /** motir-ai's platform design-run model — null when unset or not offered. */
  designRunDefault: string | null;
}

/** An organisation's own run-side choices — passed only while the org qualifies. */
export interface OrgHostedModelLayer {
  levels: HostedModelsByDifficulty;
  review: string | null;
  design: string | null;
}

export interface ResolveHostedModelInput {
  difficulty: WorkItemDifficultyDto | null;
  overrides: HostedModelsByDifficulty;
  offered: HostedModelOffer;
  /** The org's layer, or null when it does not qualify (or the caller has none). */
  org: OrgHostedModelLayer | null;
  /** Whether the card is a design run. */
  design: boolean;
}

export type ResolvedHostedModel = { model: string; source: HostedModelSource } | null;

export function resolveHostedModel({
  difficulty,
  overrides,
  offered,
  org,
  design,
}: ResolveHostedModelInput): ResolvedHostedModel {
  const isOffered = (id: string | null | undefined): id is string =>
    typeof id === 'string' && offered.models.includes(id);

  if (design) {
    if (isOffered(org?.design)) return { model: org.design, source: 'org_design' };
    if (isOffered(offered.designRunDefault)) {
      return { model: offered.designRunDefault, source: 'platform_design' };
    }
  }
  if (difficulty !== null) {
    const override = overrides[difficulty];
    if (isOffered(override)) return { model: override, source: 'override' };
    const orgLevel = org?.levels[difficulty];
    if (isOffered(orgLevel)) return { model: orgLevel, source: 'org_level' };
    const level = offered.defaultsByDifficulty[difficulty];
    if (isOffered(level)) return { model: level, source: 'platform_level' };
  }
  if (isOffered(offered.default)) return { model: offered.default, source: 'platform_default' };
  const first = offered.models[0];
  return first === undefined ? null : { model: first, source: 'first_offered' };
}

/**
 * The model a hosted REVIEW runs on when nobody chooses (MOTIR-10843): the
 * organisation's review-agent model while it qualifies and it is offered, else the
 * platform review-agent model, else null — the caller then takes the run default
 * (`hostedRunModelService.defaultOffered()`).
 */
export function resolveReviewModel(
  offered: Pick<HostedModelOffer, 'models' | 'reviewAgentDefault'>,
  org: Pick<OrgHostedModelLayer, 'review'> | null,
): { model: string; source: 'org_review' | 'platform_review' } | null {
  const isOffered = (id: string | null | undefined): id is string =>
    typeof id === 'string' && offered.models.includes(id);
  if (isOffered(org?.review)) return { model: org.review, source: 'org_review' };
  if (isOffered(offered.reviewAgentDefault)) {
    return { model: offered.reviewAgentDefault, source: 'platform_review' };
  }
  return null;
}

/**
 * Whether a card is a DESIGN run: every unfinished leaf it resolves over is a
 * `design` card, and there is at least one. A leaf is its own row, so a design
 * leaf qualifies; a parent with one non-design unfinished leaf does not.
 */
export function isDesignRun(leaves: readonly { type: string | null }[]): boolean {
  return leaves.length > 0 && leaves.every((l) => l.type === 'design');
}

/**
 * The difficulty a PARENT card runs on: the highest among its unfinished leaf
 * descendants (easiest → hardest is `WORK_ITEM_DIFFICULTIES`' order). A leaf with
 * no difficulty adds nothing; `null` when no unfinished leaf carries one.
 */
export function highestDifficulty(
  levels: readonly (WorkItemDifficultyDto | null)[],
  order: readonly WorkItemDifficultyDto[],
): WorkItemDifficultyDto | null {
  let best = -1;
  for (const level of levels) {
    if (level === null) continue;
    best = Math.max(best, order.indexOf(level));
  }
  return best < 0 ? null : (order[best] ?? null);
}
