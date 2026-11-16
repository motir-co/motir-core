import { z } from 'zod';
import {
  PLANNER_FINDING_ATTRIBUTIONS,
  PLANNER_FINDING_OUTCOMES,
  PLANNER_FINDING_PLANNERS,
  PLANNER_FINDING_PREDICTIONS,
  PLANNER_FINDING_SOURCES,
  PLANNER_FINDING_VERDICT_STATES,
} from '@/lib/ai/motirAiClient';

/**
 * The request shapes of `/api/platform/planner-findings/**` (Story MOTIR-11455 ·
 * MOTIR-11458). The routes parse with these BEFORE any service call, so a
 * malformed request causes no upstream work. Every object is `strict()`: an
 * unknown key is a 400 naming it, never silently dropped.
 *
 * They check SHAPE only. motir-ai owns the store's rules (a verdict names every
 * finding of its record once, a known attribution with a why) and answers its own
 * `validation_error` naming the problem; these do not repeat them.
 */

/** Findings per record — motir-ai's `FINDINGS_BATCH_MAX`. */
export const PLANNER_FINDING_RECORD_MAX_FINDINGS = 100;

const ID_MAX = 200;
const TEXT_MAX = 20_000;

const id = z.string().trim().min(1).max(ID_MAX);
const text = z.string().trim().min(1).max(TEXT_MAX);

const findingSchema = z
  .object({
    site: text,
    prediction: z.enum(PLANNER_FINDING_PREDICTIONS),
    whatHappened: text,
    evidence: text,
    outcome: z.enum(PLANNER_FINDING_OUTCOMES),
    cardRef: text.optional(),
    authorSessionKey: text.optional(),
    correction: text.optional(),
    rule: text.optional(),
    defectClass: text.optional(),
    attribution: z.enum(PLANNER_FINDING_ATTRIBUTIONS).optional(),
    why: text.optional(),
    hostedCell: text.optional(),
    planpyCell: text.optional(),
    fixDirection: text.optional(),
  })
  .strict();

/**
 * `POST /api/platform/planner-findings/records`. `planId` is a CORE plan id;
 * when it names no plan, or is absent, `projectKey` names the project instead,
 * resolved in `workspaceId` (or the token's own workspace). Which of the two is
 * required is a service rule, because it depends on whether the plan exists.
 */
export const createPlannerFindingRecordBodySchema = z
  .object({
    planId: id.optional(),
    projectKey: z.string().trim().min(1).max(40).optional(),
    workspaceId: id.optional(),
    planner: z.enum(PLANNER_FINDING_PLANNERS),
    planSessionId: id.optional(),
    jobId: id.optional(),
    planTitle: text.optional(),
    authorModel: text.optional(),
    baseline: z.object({ branch: text.optional(), commit: text.optional() }).strict().optional(),
    findings: z.array(findingSchema).min(1).max(PLANNER_FINDING_RECORD_MAX_FINDINGS),
  })
  .strict();

export type CreatePlannerFindingRecordBody = z.infer<typeof createPlannerFindingRecordBodySchema>;

/** `POST /api/platform/planner-findings/records/:id/verdict`. */
export const plannerFindingRecordVerdictBodySchema = z
  .object({
    verdicts: z
      .array(
        z
          .object({
            findingId: id,
            attribution: z.enum(PLANNER_FINDING_ATTRIBUTIONS),
            why: text,
            hostedCell: text.optional(),
            planpyCell: text.optional(),
            fixDirection: text.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(PLANNER_FINDING_RECORD_MAX_FINDINGS),
    replace: z.boolean().optional(),
  })
  .strict();

export type PlannerFindingRecordVerdictBody = z.infer<typeof plannerFindingRecordVerdictBodySchema>;

const isoDate = z.string().datetime({ offset: true });

/** `GET /api/platform/planner-findings/records` — passed through to motir-ai as given. */
export const plannerFindingRecordQuerySchema = z
  .object({
    verdictState: z.enum(PLANNER_FINDING_VERDICT_STATES).optional(),
    planner: z.enum(PLANNER_FINDING_PLANNERS).optional(),
    source: z.enum(PLANNER_FINDING_SOURCES).optional(),
    planId: id.optional(),
    createdFrom: isoDate.optional(),
    createdTo: isoDate.optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type PlannerFindingRecordQuery = z.infer<typeof plannerFindingRecordQuerySchema>;
