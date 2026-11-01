import { z } from 'zod/v4';
import { RUN_DISCREPANCY_FIELD_MAX, RUN_DISCREPANCY_POINTS_MAX } from '@/lib/dispatchRuns/errors';
import { RUN_STOP_COMMENT_MAX, RUN_STOP_FIELD_MAX } from '@/lib/dispatchRuns/stopComment';
import type { RecordDiscrepancyResult } from '@/lib/services/runDiscrepancyService';
import type { ReportStopResult } from '@/lib/services/runStopReportService';

// The RUN doors for what the dispatch prompt asks an agent to tell Motir (MOTIR-8722) —
// `POST /api/v1/dispatch-runs/{id}/discrepancy` and `POST /api/v1/dispatch-runs/{id}/stop`.
// The CLI posts them with the run's own credential from what the agent wrote into
// `$MOTIR_AGENT_REPORT`, because a hosted or agent-instance run's agent holds no Motir
// token and `/api/mcp` refuses a run token. MOTIR-8698's `…/unbuildable` is the sibling.

const discrepancyPointSchema = z
  .object({
    planAsked: z.string().trim().min(1).max(RUN_DISCREPANCY_FIELD_MAX),
    built: z.string().trim().min(1).max(RUN_DISCREPANCY_FIELD_MAX),
    why: z.string().trim().min(1).max(RUN_DISCREPANCY_FIELD_MAX),
  })
  .strict();

/** One decision the agent made where the plan was silent (MOTIR-10000). */
const decisionPointSchema = z
  .object({
    planSaid: z.string().trim().min(1).max(RUN_DISCREPANCY_FIELD_MAX),
    chose: z.string().trim().min(1).max(RUN_DISCREPANCY_FIELD_MAX),
    why: z.string().trim().min(1).max(RUN_DISCREPANCY_FIELD_MAX),
    alternatives: z.string().trim().max(RUN_DISCREPANCY_FIELD_MAX).optional(),
  })
  .strict();

/**
 * What the CLI sends for a build-through: the card and every point, in one call — and the
 * decisions the agent made where the plan was silent, beside them or alone (MOTIR-10000).
 * At least one entry, of either kind.
 */
export const runDiscrepancyBodySchema = z
  .object({
    /** The card that was built through, `KEY-<n>` — a card the run holds. */
    key: z.string().trim().min(1),
    points: z.array(discrepancyPointSchema).max(RUN_DISCREPANCY_POINTS_MAX).optional(),
    decisions: z.array(decisionPointSchema).max(RUN_DISCREPANCY_POINTS_MAX).optional(),
  })
  .strict()
  .refine((body) => (body.points?.length ?? 0) + (body.decisions?.length ?? 0) > 0, {
    message: 'Send at least one point or one decision.',
    path: ['points'],
  });
export type V1RunDiscrepancyBody = z.infer<typeof runDiscrepancyBodySchema>;

/** The answer — the same acknowledgement `record_run_discrepancy` gives. */
export const runDiscrepancyAcknowledgementSchema = z.object({
  commentId: z.string(),
  recorded: z.boolean(),
});
export type V1RunDiscrepancyAcknowledgement = z.infer<typeof runDiscrepancyAcknowledgementSchema>;

export function presentRunDiscrepancyAcknowledgement(
  result: RecordDiscrepancyResult,
): V1RunDiscrepancyAcknowledgement {
  return { commentId: result.commentId, recorded: result.recorded };
}

const briefField = z.string().max(RUN_STOP_FIELD_MAX);

/** The agent's re-plan brief — motir-ai's six `SettledRequirement` fields, each optional here. */
const stopRequirementSchema = z
  .object({
    outcome: briefField.optional(),
    behaviour: briefField.optional(),
    scopeEdge: briefField.optional(),
    constraints: briefField.optional(),
    acceptance: briefField.optional(),
    assumptions: briefField.optional(),
  })
  .strict();

/** What the CLI sends for a STOP: the card, the finding, whether to re-plan, the brief. */
export const runStopReportBodySchema = z
  .object({
    /** The card the agent stopped on, `KEY-<n>` — a card the run holds. */
    key: z.string().trim().min(1),
    /** The agent's finding — what is false, and the evidence. */
    comment: z.string().trim().min(1).max(RUN_STOP_COMMENT_MAX),
    /** Move the card to Planning: the run re-plans. */
    toPlanning: z.boolean(),
    requirement: stopRequirementSchema.optional(),
  })
  .strict();
export type V1RunStopReportBody = z.infer<typeof runStopReportBodySchema>;

export const runStopReportAcknowledgementSchema = z.object({
  commentId: z.string(),
  movedToPlanning: z.boolean(),
});
export type V1RunStopReportAcknowledgement = z.infer<typeof runStopReportAcknowledgementSchema>;

export function presentRunStopReportAcknowledgement(
  result: ReportStopResult,
): V1RunStopReportAcknowledgement {
  return { commentId: result.commentId, movedToPlanning: result.movedToPlanning };
}
