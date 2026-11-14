import { z } from 'zod';
import type { PlanSessionFailureReason } from '@/generated/prisma/client';
import { PLAN_WALK_PHASE_VALUES, type PlanWalkPhaseDto } from '@/lib/dto/plans';

import {
  FAILURE_DETAIL_MAX,
  PLAN_SESSION_FAILURE_REASONS,
  type PlanSessionFailureRecord,
} from '@/lib/planChange/sessionWaitingState';

// THE FAILURE RECORD'S SOURCE (Story MOTIR-7905 · MOTIR-7912) — turning what core
// learned about a failed hosted attempt into the record `markFailed` stores.
//
// PURE: no repository, no client, no clock. The relays and the abandoned-plan sweep
// both build the record here, so the same failure reads the same whichever of them
// saw it first (they race, and `markFailed` is idempotent in effect).
//
// ⚠️ THE REASON IS A STABLE CODE, NEVER motir-ai's ENGLISH. `failureReason` is the
// closed enum the render cards translate; an unrecognised `reasonCode`, a missing
// `walkStop`, and an error class nobody mapped all fall to `internal` rather than
// being stored as prose or refused (a record that throws while recording a failure
// would turn one failure into two).
//
// The LOST-MACHINE fact (`FailedJobFacts.lostMachine`, MOTIR-8304) deliberately
// does not reach the record or its reason: a reaped job still reads
// `model_unavailable` to a person. It is handed back to the settle paths' callers,
// which decide whether to resume.

/** Where a walk stopped, as motir-ai's terminal `Problem.walkStop` carries it. */
export const jobWalkStopSchema = z.object({
  // `amend` / `check` / `repair` since MOTIR-11256; an unknown phase fails the parse,
  // and the stop reads as none rather than as a lay.
  phase: z.enum(PLAN_WALK_PHASE_VALUES),
  target: z.string().nullable(),
  targetTitle: z.string().nullable().optional(),
  depth: z.number().int().nonnegative(),
  planId: z.string().nullable().optional(),
  reasonCode: z.string(),
  detail: z.string().optional(),
  // The cards the halt left unplanned, worded for the person (motir-ai#929, MOTIR-10209).
  // A malformed value is IGNORED, never allowed to fail the whole walk stop: the stop
  // point and reason must still reach the record when this one field is bad.
  notPlannedYet: z.array(z.string()).optional().catch(undefined),
});

/** Parse a wire `walkStop`; a missing or malformed member reads `null` and never throws. */
export function parseJobWalkStop(raw: unknown): z.output<typeof jobWalkStopSchema> | null {
  if (raw === undefined || raw === null) return null;
  const parsed = jobWalkStopSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The latest `walk_position` frame a relay saw — the stop point when the terminal
 *  `Problem` carries none (`ai_job_abandoned` after the machine died). */
export interface JobWalkPosition {
  phase: PlanWalkPhaseDto;
  target: string | null;
  targetTitle?: string | null;
  depth: number;
}

/** Read a `walk_position` frame's data; anything malformed is `null`. */
export function parseWalkPosition(raw: unknown): JobWalkPosition | null {
  const parsed = z
    .object({
      phase: z.enum(PLAN_WALK_PHASE_VALUES),
      target: z.string().nullable(),
      targetTitle: z.string().nullable().optional(),
      depth: z.number().int().nonnegative(),
    })
    .safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type JobWalkStop = NonNullable<ReturnType<typeof parseJobWalkStop>>;

/** What core reads about a failed job, in the one shape both settle paths use (MOTIR-8304). */
export interface FailedJobFacts {
  error: { code: string; message?: string } | null;
  walkStop: JobWalkStop | null;
  /** motir-ai failed the job because its machine stopped renewing the lease. */
  lostMachine: boolean;
  /** motir-ai's verdict on whether the job can be resumed (MOTIR-9121); `null` when it
   *  did not say. */
  resumable: boolean | null;
}

const REASONS: ReadonlySet<string> = new Set(PLAN_SESSION_FAILURE_REASONS);

/**
 * The TOTAL map from a typed motir-ai error to the stable reason. `error` is only
 * its `code` (and optional `message`), so the sweep can hand in a
 * `PlanJobStateDto.failure` as readily as a relay hands in a `MotirAiError`.
 */
export function reasonCodeFromError(
  error: { code: string } | null | undefined,
): PlanSessionFailureReason {
  switch (error?.code) {
    case 'MOTIR_AI_OUT_OF_CREDITS':
      return 'out_of_credits';
    case 'MOTIR_AI_UNAUTHORIZED':
      return 'token_expired';
    // ⚠️ A JOB THAT FAILED IS NOT THE PROVIDER BEING DOWN (MOTIR-8569). motir-ai's
    // terminal `ai_job_failed` means its handler ran and refused — a read-back from
    // core it could not make, a precondition it would not plan past — and no model
    // may ever have been called. Reading it as `model_unavailable` sent a person to
    // wait on a healthy provider. `getJob` maps that problem to MotirAiJobFailedError.
    //
    // The same holds for a terminal job whose problem is `validation_error` (any 4xx),
    // which `getJob` maps to MotirAiBadRequestError (MOTIR-9127): motir-ai's handler
    // refused the job — a read token that expired in the queue — and no model was
    // called. Every caller hands this map a FAILED job's error; a refused submit
    // throws before any job exists and never reaches it.
    case 'MOTIR_AI_JOB_FAILED':
    case 'MOTIR_AI_BAD_REQUEST':
      return 'job_failed';
    case 'MOTIR_AI_UNAVAILABLE':
      return 'model_unavailable';
    default:
      return 'internal';
  }
}

export interface FailureRecordInput {
  /** `null` when the plan has no job (MOTIR-8132). */
  failedJobId: string | null;
  now: Date;
  walkStop: JobWalkStop | null;
  lastPosition: JobWalkPosition | null;
  error: { code: string; message?: string } | null;
  /** motir-ai's resumable verdict (MOTIR-9121); absent or `null` when unknown. */
  resumable?: boolean | null;
}

/**
 * The record `markFailed` writes. The stop point is `walkStop`, else the last
 * relayed position, else null; the reason is `walkStop.reasonCode` when it is one
 * of the closed set, else the mapped error; the detail is `walkStop.detail`, else the
 * error's message, capped (the data card's schema caps again on write). The "not planned
 * yet" lines are the walk stop's, verbatim and in order, else none.
 */
export function failureRecordFrom(input: FailureRecordInput): PlanSessionFailureRecord {
  const { walkStop, lastPosition, error } = input;
  const stop = walkStop ?? lastPosition;
  const reason =
    walkStop && REASONS.has(walkStop.reasonCode)
      ? (walkStop.reasonCode as PlanSessionFailureReason)
      : reasonCodeFromError(error);
  const detail = walkStop?.detail ?? error?.message ?? null;
  return {
    failedAt: input.now,
    failedJobId: input.failedJobId,
    failureReason: reason,
    failureDetail: detail === null ? null : detail.slice(0, FAILURE_DETAIL_MAX),
    failureStopPhase: stop?.phase ?? null,
    failureStopRef: stop?.target ?? null,
    failureStopTitle: stop?.targetTitle ?? null,
    failureResumable: input.resumable ?? null,
    // Only the walk stop carries them; a relayed position or a bare error has none.
    failureNotPlannedYet: walkStop?.notPlannedYet ?? [],
  };
}
