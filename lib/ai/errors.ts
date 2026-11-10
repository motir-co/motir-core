// Typed errors for the motir-ai client boundary. Services catch these and the
// route layer maps the stable `code` to an HTTP status (per CLAUDE.md). They
// translate the contract's problem+json taxonomy (§5) — and the transport
// failures that sit underneath it — into motir-core typed errors, so no caller
// ever branches on a raw HTTP status or an upstream JSON shape.

import type { JobWalkStop } from '@/lib/planChange/failureRecord';
import type { Problem, JobStatus, PlannerModelListReason, ResultEnvelope } from './types';

export abstract class MotirAiError extends Error {
  abstract readonly code: string;
}

// motir-ai is unreachable / 5xx / a transport failure — retryable, not the
// caller's fault.
export class MotirAiUnavailableError extends MotirAiError {
  readonly code = 'MOTIR_AI_UNAVAILABLE' as const;
  // `options.cause` carries the underlying transport error. It rides the
  // standard `Error.cause` — which the error monitor records as a linked
  // exception — and NOT the message, because the v1 API returns the message to
  // the caller and the cause's text names private hosts and addresses.
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`motir-ai is unavailable: ${detail}`, options);
    this.name = 'MotirAiUnavailableError';
  }
}

// Missing/invalid config (URL or service token) — a deploy misconfiguration.
export class MotirAiConfigError extends MotirAiError {
  readonly code = 'MOTIR_AI_CONFIG' as const;
  constructor(detail: string) {
    super(`motir-ai client is misconfigured: ${detail}`);
    this.name = 'MotirAiConfigError';
  }
}

// The service credential was rejected (401/403) — a misconfigured shared secret,
// never a browser-reachable condition.
export class MotirAiUnauthorizedError extends MotirAiError {
  readonly code = 'MOTIR_AI_UNAUTHORIZED' as const;
  constructor(detail: string) {
    super(`motir-ai rejected the service credential: ${detail}`);
    this.name = 'MotirAiUnauthorizedError';
  }
}

// motir-ai rejected the request envelope (400) — a bug on the core side.
export class MotirAiBadRequestError extends MotirAiError {
  readonly code = 'MOTIR_AI_BAD_REQUEST' as const;
  // `httpStatus` is the problem's own HTTP status when the error was built from a
  // response (`errorFromProblem`); absent for the callers that construct one by
  // hand. It lets a caller tell "the request CONTENT was refused" (400/413/422)
  // from a 4xx that is about the caller or the moment (401/403/429), which this
  // class otherwise collapses — see {@link isPerInputRejection}.
  // `detail` is the problem's own sentence, kept apart from the message so a
  // caller that shows it (a near-duplicate lesson names the existing one) need
  // not parse it back out.
  constructor(
    readonly detail: string,
    readonly httpStatus?: number,
  ) {
    super(`motir-ai rejected the request: ${detail}`);
    this.name = 'MotirAiBadRequestError';
  }
}

/** The 4xx statuses that mean "this request's CONTENT was refused". */
const PER_INPUT_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * Whether a failed embedding call was refused for the CONTENT of its inputs — the
 * only class a sweep may isolate to one item (MOTIR-8227). It is a status test on
 * the typed error, never a message match. Everything else is an outage-class
 * error and must fail the run: a network failure or 5xx (`MotirAiUnavailableError`),
 * 401/403 (`MotirAiUnauthorizedError`), 429 and any unknown error, none of which
 * says anything about one item.
 *
 * An error with no recorded status (one built by hand) is NOT a per-input
 * rejection: the safe answer to "cannot tell" is "treat it as an outage".
 */
export function isPerInputRejection(err: unknown): err is MotirAiBadRequestError {
  return (
    err instanceof MotirAiBadRequestError &&
    err.httpStatus !== undefined &&
    PER_INPUT_REJECTION_STATUSES.has(err.httpStatus)
  );
}

// No such job (404).
export class MotirAiJobNotFoundError extends MotirAiError {
  readonly code = 'MOTIR_AI_JOB_NOT_FOUND' as const;
  constructor(jobId: string) {
    super(`motir-ai has no job ${jobId}`);
    this.name = 'MotirAiJobNotFoundError';
  }
}

// The org is OUT OF CREDITS (402 `out_of_credits`, motir-ai's `OutOfCreditsError`,
// src/problem.ts) — the credit gate refused a planning/generation job at balance
// ≤ 0 (its pre-flight or per-turn check; Subtask 7.2.8). This is a distinct,
// browser-reachable, NON-retryable condition: the remedy is to buy/top-up credits,
// not to retry. It carries a stable `code` so the AI-boundary paywall (Subtask
// 8.1.8) can branch the SSE terminal `error` frame to the upgrade prompt instead
// of a generic "AI unavailable" error. Kept distinct from MotirAiUnavailableError
// (which a default-mapped 402 would otherwise collapse into a bad-request).
export class MotirAiOutOfCreditsError extends MotirAiError {
  readonly code = 'MOTIR_AI_OUT_OF_CREDITS' as const;
  constructor(detail: string) {
    super(`motir-ai refused the job — out of credits: ${detail}`);
    this.name = 'MotirAiOutOfCreditsError';
  }
}

// A planning job itself failed (its terminal `error`). Carries the upstream
// problem for diagnostics.
export class MotirAiJobFailedError extends MotirAiError {
  readonly code = 'MOTIR_AI_JOB_FAILED' as const;
  constructor(
    detail: string,
    readonly problem: Problem,
  ) {
    super(`motir-ai job failed: ${detail}`);
    this.name = 'MotirAiJobFailedError';
  }
}

// ⚠️ THE TWO DEADLINES DISAGREED (Bug MOTIR-4923). A run credential motir-ai
// minted for LESS time than the container it authorizes is allowed to run is a
// contract mismatch, not a transport failure and not a scope refusal — and the
// only moment it is cheaply visible is at the mint, before a machine is billed.
// Left undetected it is invisible for the whole run and then arrives as the
// container's exit `50`, which reads as `credential_refused` and cannot be told
// apart from a genuine scope refusal without a forensic dig: on 2026-09-08 a
// container built `moooon-B-V/motir-core`'s graph for 20 min 41 s against a
// 15-minute credential and was refused at the upload, twice, for a total of
// 2 388 billable seconds that produced nothing.
//
// It is a CONFIG-class failure — the two numbers are set in two repositories and
// nothing but this check makes them one decision — so it fails LOUDLY rather
// than degrading: there is no shorter run to fall back to, and booting anyway is
// exactly what produced the fixture above.
export class CodeGraphRunCredentialTooShortError extends MotirAiError {
  readonly code = 'CODE_GRAPH_CREDENTIAL_TOO_SHORT' as const;
  constructor(
    readonly credentialExpiresAt: string,
    readonly requiredUntil: string,
  ) {
    super(
      `motir-ai minted a code-graph run credential expiring at ${credentialExpiresAt}, ` +
        `which is BEFORE this run's container deadline of ${requiredUntil} — the container ` +
        'would build its graph and then be refused at the upload. Check that motir-ai honours ' +
        "the requested `ttlSeconds` and that its ceiling covers motir-core's index timeout.",
    );
    this.name = 'CodeGraphRunCredentialTooShortError';
  }
}

// A planner-model write named a model motir-ai does not OFFER for planning
// (`PUT /v1/planner-model-settings` → `validation_error`; MOTIR-7227). Offered
// means a servable catalogue row plus a `planning`-lane rate in force, read by
// motir-ai at request time — so a model that was offered when the console page
// loaded can stop being offered before its save lands.
export class PlannerModelNotOfferedError extends MotirAiError {
  readonly code = 'PLANNER_MODEL_NOT_OFFERED' as const;
  constructor(
    readonly model: string,
    detail?: string,
  ) {
    super(`"${model}" is not offered for planning${detail ? `: ${detail}` : ''}`);
    this.name = 'PlannerModelNotOfferedError';
  }
}

// A planner-model write whose one-token PROBE failed (`model_unreachable`, 422;
// motir-ai MOTIR-7236). Nothing was written. `reason` is the probe's own words
// (the provider key was refused, no enabled channel serves the model, a timeout).
export class PlannerModelUnreachableError extends MotirAiError {
  readonly code = 'PLANNER_MODEL_UNREACHABLE' as const;
  constructor(
    readonly model: string,
    readonly reason: string,
  ) {
    super(`"${model}" is not reachable for the planner: ${reason}`);
    this.name = 'PlannerModelUnreachableError';
  }
}

// A run-side platform default write named a model motir-ai would not store
// (`PUT /v1/admin/run-model-defaults` → `validation_error`; MOTIR-10840): not in
// the run-model list motir-core sent, or no longer offered for agent runs.
export class RunModelDefaultNotOfferedError extends MotirAiError {
  readonly code = 'RUN_MODEL_DEFAULT_NOT_OFFERED' as const;
  constructor(
    readonly model: string,
    detail?: string,
  ) {
    super(`"${model}" is not offered for hosted runs${detail ? `: ${detail}` : ''}`);
    this.name = 'RunModelDefaultNotOfferedError';
  }
}

// An ORG model-choice write motir-ai refused because the org does not qualify
// (`PUT /v1/orgs/:id/planner-model-overrides` → `permission_denied`; MOTIR-10845):
// below Pro and not the meta org, or an org motir-ai has never seen. The client
// maps it BEFORE `errorFromProblem`, which reads `permission_denied` as a rejected
// service credential — a Standard org's refused save is not a deploy fault.
export class OrgModelChoiceNotQualifiedError extends MotirAiError {
  readonly code = 'ORG_MODEL_CHOICE_NOT_QUALIFIED' as const;
  constructor(readonly coreOrganizationId: string) {
    super(`organization ${coreOrganizationId} does not qualify for its own model choices`);
    this.name = 'OrgModelChoiceNotQualifiedError';
  }
}

// motir-ai cannot answer (transport, timeout, 5xx) or is not configured in this
// deployment — the two conditions an org surface shows as "models unreadable"
// rather than an error page (MOTIR-10845).
export function isMotirAiUnreadable(err: unknown): boolean {
  return err instanceof MotirAiUnavailableError || err instanceof MotirAiConfigError;
}

// A PLANNING-MODEL LIST add named a model motir-ai would not plan with right now
// (`PUT /v1/planner-model-list` → `validation_error`, "cannot be allowed for
// planning: …"; motir-ai MOTIR-7520 · core MOTIR-7524). `reason` is the
// machine-readable cause when motir-ai's wording names one, else null; `detail`
// is motir-ai's own sentence, kept whole for the page.
export class PlannerModelNotQualifiedError extends MotirAiError {
  readonly code = 'PLANNER_MODEL_NOT_QUALIFIED' as const;
  constructor(
    readonly model: string,
    readonly reason: PlannerModelListReason | null,
    readonly detail: string,
  ) {
    super(`"${model}" cannot be allowed for planning: ${detail}`);
    this.name = 'PlannerModelNotQualifiedError';
  }
}

// A PLANNING-MODEL LIST remove named a model an audience is set to (MOTIR-7524).
// motir-ai refuses it under every audience row's lock; `audiences` are the ones
// it named, so the page can say which to move first.
export class PlannerModelListEntryInUseError extends MotirAiError {
  readonly code = 'PLANNER_MODEL_LIST_ENTRY_IN_USE' as const;
  constructor(
    readonly model: string,
    readonly audiences: readonly string[],
  ) {
    super(`"${model}" is the planning model of: ${audiences.join(', ')}`);
    this.name = 'PlannerModelListEntryInUseError';
  }
}

// A PLANNING-MODEL LIST remove named the planner's FALLBACK (`claude-opus-5-5`),
// which motir-ai keeps listed so every audience always has a model to fall back
// to (MOTIR-7524).
export class PlannerModelListFallbackError extends MotirAiError {
  readonly code = 'PLANNER_MODEL_LIST_FALLBACK' as const;
  constructor(readonly model: string) {
    super(`"${model}" is the planner's fallback and must stay on the planning-model list`);
    this.name = 'PlannerModelListFallbackError';
  }
}

// Any other `validation_error` motir-ai answers a planning-model list write with —
// a body it could not read, an action it does not know. Its detail is kept whole
// rather than guessed into one of the three above.
export class PlannerModelListRefusedError extends MotirAiError {
  readonly code = 'PLANNER_MODEL_LIST_REFUSED' as const;
  constructor(
    readonly model: string,
    readonly detail: string,
  ) {
    super(`motir-ai refused the planning-model list change for "${model}": ${detail}`);
    this.name = 'PlannerModelListRefusedError';
  }
}

// A PLATFORM lesson read or curate named a lesson motir-ai does not have
// (`/v1/admin/lessons/:id` → `not_found`; MOTIR-1411). Its own class rather than
// the generic `not_found` mapping, which names a JOB: the console turns this one
// into the app 404 on a detail read and into "this lesson no longer exists" on
// a write.
export class PlatformLessonNotFoundError extends MotirAiError {
  readonly code = 'PLATFORM_LESSON_NOT_FOUND' as const;
  constructor(readonly lessonId: string) {
    super(`no lesson "${lessonId}"`);
    this.name = 'PlatformLessonNotFoundError';
  }
}

// `GET` / `PATCH /v1/admin/planner-findings/:id` answered `not_found` — no
// finding with that id in motir-ai's store (MOTIR-10516). Its own class, as a
// lesson's is, so the console can render a not-found page rather than an outage.
export class PlannerFindingNotFoundError extends MotirAiError {
  readonly code = 'PLANNER_FINDING_NOT_FOUND' as const;
  constructor(readonly findingId: string) {
    super(`no planner finding "${findingId}"`);
    this.name = 'PlannerFindingNotFoundError';
  }
}

// A staff credit ADJUSTMENT would take the org's balance below zero
// (`POST /v1/admin/credits` → 409 `conflict` with a detail starting
// `insufficient_balance:`; MOTIR-747). A detail PREFIX, not a code — the §5 union
// is closed — so `adminWriteCredits` recognises it before the generic switch.
// Nothing was written.
export class MotirAiInsufficientBalanceError extends MotirAiError {
  readonly code = 'MOTIR_AI_INSUFFICIENT_BALANCE' as const;
  constructor(readonly detail: string) {
    super(`motir-ai refused the adjustment — it would overdraw the balance: ${detail}`);
    this.name = 'MotirAiInsufficientBalanceError';
  }
}

// Any other 409 `conflict` from a staff credit op (MOTIR-747): a `requestId`
// reused for a different amount / tier / org / kind, or an offboarded org
// (`org_erased: …`). Nothing was written. Kept distinct from
// `MotirAiBadRequestError` because it is a STATE refusal, not a malformed body.
export class MotirAiConflictError extends MotirAiError {
  readonly code = 'MOTIR_AI_CONFLICT' as const;
  constructor(readonly detail: string) {
    super(`motir-ai refused the write as a conflict: ${detail}`);
    this.name = 'MotirAiConflictError';
  }
}

// The GET /v1/jobs/:id result as the client returns it: status + result, with a
// failed job's `error` already mapped to a motir-core typed error.
export interface JobView {
  jobId: string;
  status: JobStatus;
  result: ResultEnvelope | null;
  error: MotirAiError | null;
  /** Where a failed planning walk stopped, parsed from `error.walkStop`; `null` when
   *  absent or malformed (MOTIR-7912) — a motir-ai that predates it still works. */
  walkStop?: JobWalkStop | null;
  /**
   * Whether motir-ai failed this job because the MACHINE holding it stopped renewing
   * its lease (its reaper's `ai_job_abandoned`, MOTIR-8304) — so nothing about the
   * request was judged. Read from the raw problem before `errorFromProblem` maps it to
   * the same `MotirAiUnavailableError` an outage gets, which is why it rides beside
   * `error` rather than in it. Optional, and absent reads as `false`.
   */
  lostMachine?: boolean;
  /**
   * motir-ai's verdict on whether a FAILED planning job can be resumed (MOTIR-9121) —
   * `false` when it failed before its conversation settled, so a resume would be refused.
   * Absent when motir-ai did not say (any other status, or an older motir-ai).
   */
  resumable?: boolean;
}

/** The problem code motir-ai's reaper fails an abandoned job with (`src/jobs/reaper.ts`). */
export const AI_JOB_ABANDONED_PROBLEM_CODE = 'ai_job_abandoned';

// Map a problem+json (from a non-2xx response or a failed job's error) onto the
// right typed error, keyed by the contract §5 `code` (falling back to HTTP
// status class for an unrecognized code).
/**
 * Why motir-ai refused a change of AI plan (MOTIR-8396 / MOTIR-8398). Each is the
 * `<code>:` prefix of a `validation_error` detail, except `org_closing`, which is
 * a `conflict`'s.
 */
export const PLAN_CHANGE_REFUSAL_REASONS = [
  'no_live_plan',
  'same_plan',
  'unknown_plan',
  'not_an_upgrade',
  'not_a_downgrade',
  'second_plan',
  'preview_expired',
  'payment_failed',
  'org_closing',
] as const;
export type PlanChangeRefusalReason = (typeof PLAN_CHANGE_REFUSAL_REASONS)[number];

// A change of plan motir-ai refused with a reason the dialog draws (MOTIR-8399).
// Not retryable as sent: the remedy depends on the reason.
export class MotirAiPlanChangeRefusedError extends MotirAiError {
  readonly code = 'MOTIR_AI_PLAN_CHANGE_REFUSED' as const;
  constructor(
    readonly reason: PlanChangeRefusalReason,
    detail: string,
  ) {
    super(`motir-ai refused the plan change: ${detail}`);
    this.name = 'MotirAiPlanChangeRefusedError';
  }
}

/**
 * The plan-change refusal a problem carries, or `null` when it carries none: a
 * `validation_error` or `conflict` whose detail opens with a known `<reason>:`.
 */
export function planChangeRefusalOf(p: Problem): MotirAiPlanChangeRefusedError | null {
  if (p.code !== 'validation_error' && p.code !== 'conflict') return null;
  const prefix = /^([a-z_]+):/.exec(p.detail ?? '')?.[1];
  const reason = PLAN_CHANGE_REFUSAL_REASONS.find((r) => r === prefix);
  return reason ? new MotirAiPlanChangeRefusedError(reason, p.detail ?? p.title) : null;
}

// ── The calculator's own answers (MOTIR-8637) ─────────────────────────────────
//
// The engine's public calculator (`/v1/public/calculator/*`, motir-ai MOTIR-8627)
// answers every outage as ONE `internal_error` whose detail starts
// `calculator_unavailable:` — the §5 union is closed, so the DETAIL PREFIX is the
// only carrier of "the engine cannot estimate right now". `errorFromProblem` maps
// `internal_error` and `rate_limited` alike to MotirAiUnavailableError, so these
// recognizers run BEFORE it, the way `planChangeRefusalOf` does.

/** motir-ai's `CALCULATOR_UNAVAILABLE_DETAIL_PREFIX` (`src/services/calculatorService.ts`). */
export const CALCULATOR_UNAVAILABLE_DETAIL_PREFIX = 'calculator_unavailable';

// The engine cannot estimate right now — its own `unavailable` answer, or its
// per-client rate limit. Both mean ASK AGAIN, and neither carries a number.
export class CalculatorUnavailableError extends MotirAiError {
  readonly code = 'CALCULATOR_UNAVAILABLE' as const;
  constructor(detail: string) {
    super(`the calculator cannot estimate right now: ${detail}`);
    this.name = 'CalculatorUnavailableError';
  }
}

// A calculator request refused as sent — by motir-core's own schema before the
// boundary, or by the engine's `validation_error`. `field` names the offending
// input when it is known (`plannedPerMonth.low`, `categories.0`, `quantity`).
export class CalculatorRequestRefusedError extends MotirAiError {
  readonly code = 'CALCULATOR_REQUEST_INVALID' as const;
  constructor(
    readonly field: string | null,
    detail: string,
  ) {
    super(`the calculator refused the request: ${detail}`);
    this.name = 'CalculatorRequestRefusedError';
  }
}

/** The engine's unavailable answer a problem carries, or `null` when it carries none. */
export function calculatorUnavailableOf(p: Problem): CalculatorUnavailableError | null {
  if (p.code === 'rate_limited') return new CalculatorUnavailableError(p.detail ?? p.title);
  if (p.code !== 'internal_error') return null;
  const detail = p.detail ?? '';
  return detail.startsWith(`${CALCULATOR_UNAVAILABLE_DETAIL_PREFIX}:`)
    ? new CalculatorUnavailableError(detail)
    : null;
}

/**
 * The engine's refusal of a calculator request, or `null`. The field is read off
 * the engine's own wording — `unknown field '<name>'`, or a detail opening with
 * the dotted field it names (an index segment such as `categories.0` included) — and is `null` when the wording names none.
 */
export function calculatorRefusalOf(p: Problem): CalculatorRequestRefusedError | null {
  if (p.code !== 'validation_error') return null;
  const detail = p.detail ?? p.title;
  const field =
    /^unknown field '([^']+)'/.exec(detail)?.[1] ??
    /^([a-zA-Z]+(?:\.[a-zA-Z0-9]+)*) (?:must|is) /.exec(detail)?.[1] ??
    null;
  return new CalculatorRequestRefusedError(field, detail);
}

/**
 * A FAILED JOB's terminal problem, mapped (MOTIR-8569). The same as
 * {@link errorFromProblem} except for `ai_job_failed`, which a job's terminal error
 * means *the handler ran and refused* — so it is a {@link MotirAiJobFailedError},
 * not the {@link MotirAiUnavailableError} a synchronous `ai_job_failed` response
 * still maps to. Read as unavailable, a planning session that died on a core
 * read-back was recorded as `model_unavailable` and told the person the AI
 * provider was down, with the detail prefixed "motir-ai is unavailable:".
 */
export function jobErrorFromProblem(p: Problem): MotirAiError {
  if (p.code === 'ai_job_failed') return new MotirAiJobFailedError(p.detail ?? p.title, p);
  return errorFromProblem(p);
}

// A coding-convention save over a version that moved (409 `conflict` carrying the
// `conventionConflict` extension member, motir-ai MOTIR-9080). The editor loaded
// version N and N+1 landed first; nothing was written. Not retryable as sent.
export class MotirAiConventionConflictError extends MotirAiError {
  readonly code = 'MOTIR_AI_CONVENTION_CONFLICT' as const;
  constructor(readonly latestVersion: number) {
    super(`motir-ai refused the convention save: the convention is at v${latestVersion}`);
    this.name = 'MotirAiConventionConflictError';
  }
}

export function errorFromProblem(p: Problem): MotirAiError {
  if (p.conventionConflict?.code === 'CONVENTION_VERSION_CONFLICT') {
    return new MotirAiConventionConflictError(p.conventionConflict.latestVersion);
  }
  switch (p.code) {
    case 'service_unauthorized':
    case 'token_expired':
    case 'token_invalid':
    case 'permission_denied':
      return new MotirAiUnauthorizedError(p.detail ?? p.title);
    case 'validation_error':
    case 'unsupported_version':
    // `model_unreachable` (422; motir-ai MOTIR-7236) — a planner-model save whose
    // probe failed. Named so a reader sees it is NOT retryable: the remedy is a
    // different model or a gateway fix. `setPlannerModel` maps it to its own
    // typed error before this generic switch is reached.
    case 'model_unreachable':
      return new MotirAiBadRequestError(p.detail ?? p.title, p.status);
    case 'not_found':
      return new MotirAiJobNotFoundError(p.jobId ?? '(unknown)');
    case 'out_of_credits':
      return new MotirAiOutOfCreditsError(p.detail ?? p.title);
    case 'rate_limited':
    case 'ai_job_failed':
    // `ai_job_abandoned` (MOTIR-3222) — the machine holding the job stopped
    // renewing its lease and motir-ai's reaper failed it. Named EXPLICITLY rather
    // than left to the 5xx fallback below, which would produce the same class by
    // accident: the point of the distinct code is that a reader of this switch
    // can see the case exists and that a resubmit is the right response to it,
    // where `ai_job_failed` means the handler ran and rejected something. The
    // lost-machine distinction itself is kept on `JobView.lostMachine` (MOTIR-8304).
    case 'ai_job_abandoned':
    case 'internal_error':
      return new MotirAiUnavailableError(p.detail ?? p.title);
    default:
      return p.status >= 500
        ? new MotirAiUnavailableError(p.detail ?? p.title)
        : new MotirAiBadRequestError(p.detail ?? p.title, p.status);
  }
}
