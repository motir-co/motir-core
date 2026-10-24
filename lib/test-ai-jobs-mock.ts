// Node-only motir-ai JOBS boundary mock for E2E (Story MOTIR-1343 · MOTIR-1823).
//
// The ask journey crosses the motir-core → motir-ai seam THREE times, and only
// one of the three is reachable from a browser-level `page.route`:
//
//   - `POST /api/ai/ask` calls `submitJob` inside the Next server;
//   - `GET  /api/ai/ask/:jobId/stream` RELAYS `streamJob` — the browser sees the
//     relay, not the upstream;
//   - `POST /api/ai/ask/settle` calls `getJob` inside the Next server.
//
// A spec could stub the two core ROUTES at the browser boundary, and that is
// what the shipped plan-change spec does for its single submit. It does not
// work here, and the reason is the assertion this card exists for: **step 4
// reloads the workspace and expects the answer to still be on the thread.** An
// answer the browser faked was never written, so a stub at that boundary would
// make the persistence claim untestable by the very spec that has to prove it.
//
// So this mock sits UNDER the routes, at the same seam `test-code-health-mock` /
// `test-billing-mock` use: an undici intercept installed by `instrumentation.ts`
// behind an `E2E_TEST_AI_JOBS=1` env gate, dormant everywhere else. The real
// route, the real service, the real repository and the real Postgres all run.
//
// What it intercepts (on the MOTIR_AI_URL origin the E2E lane points at — an
// unresolvable host, so a MISSING intercept fails loud rather than escaping):
//   - POST /v1/jobs                 → `{ jobId }`, and RECORDS the kind it was
//     asked for, which is how a spec proves an ask ran an `ask_project` job and
//     a plan change ran the shipped `augment` one.
//   - GET  /v1/jobs/:id             → the settled result, from the fixture.
//   - GET  /v1/jobs/:id/stream      → the SSE the relay forwards.
//
// A FAILED planning run settles with `ai_job_failed` unless its outcome declares
// `problemCode: 'ai_job_abandoned'` (Story MOTIR-8301 · MOTIR-8311) — the problem
// motir-ai's reaper writes when the machine holding a job stopped renewing its
// lease. Without that arm the lane could not reach a LOST MACHINE at all: core's
// lost-machine fact read `false` on every failure, nothing was ever resumed
// automatically, and a spec asserting the automatic resume would have gone green
// on code that never resumes.
//
// The fixture is a JSON FILE (MOTIR_AI_JOBS_FIXTURE_PATH), re-read on EVERY
// request, so a spec can rewrite it between turns — one question answers with
// citations, the next answers honestly with none, the third redirects to a plan
// change — without a second harness and without a timing assumption.

import type { CarriedAnswers } from '@/lib/ai/types';
import { readFixtureFileSync, writeFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

/** What the next `ask_project` job should settle as. */
/** THE LOG-A-BUG OFFER (Story MOTIR-9220 · MOTIR-9328), in motir-ai's shape
 *  (MOTIR-9321's `AskLogBugOffer`): the bug drafted from the read, and the one card
 *  a yes writes to. Core re-checks all of it at settle. */
export interface AskLogBugOfferFixture {
  kind: 'log_bug';
  title: string;
  acceptanceCriteria: string[];
  draft: Record<string, unknown>;
  target: { kind: 'new' | 'anchored' | 'existing'; key: string | null };
  contextRefs: string[];
}

export interface AskJobOutcome {
  /** `debug` / `new_session` are no longer produced by motir-ai (AMENDMENT 5 ·
   *  MOTIR-9231); a spec declares one only to model a result settled across the
   *  deploy, which core answers `silent`. */
  intent: 'ask' | 'plan_change' | 'debug' | 'new_session';
  answer?: string | null;
  citations?: string[];
  /** An anchor echoed on the result; core no longer reads it (MOTIR-9231). */
  anchorKey?: string;
  /**
   * RUN MODE (Story MOTIR-7990 · MOTIR-8004), declared only by a spec that types
   * into a planning run still in progress. Each is passed onto `result.ask`
   * exactly as `intent` / `answer` / `citations` are, and ONLY when declared, so
   * every other reply is byte-identical to before.
   *
   * `forward` — on a `plan_change`, the words to forward to the RUNNING planner;
   * core only compares it to two texts it already holds.
   * `offerForward` — on an `ask`, the turn the handler was unsure was a change.
   * `run` — whether the answering session could read the run snapshot.
   */
  forward?: { text: string } | null;
  offerForward?: { text: string } | null;
  run?: { readable: boolean; reason?: string | null } | null;
  /**
   * THE PLAN OFFER (Story MOTIR-9219 · MOTIR-9297): the answer envelope's one offer
   * field, in motir-ai's shape (`{ kind, requestText, targetKey?, immediate }`), and
   * the typed reply read against the pending offer (`{ seq, kind, decision }`). Each
   * is passed onto `result.ask` only when declared, so every other reply is
   * byte-identical to before.
   */
  offer?:
    | { kind: 'plan'; requestText: string; targetKey?: string; immediate?: boolean }
    | AskLogBugOfferFixture
    | null;
  offerReply?: { seq: number; kind: 'plan' | 'log_bug'; decision: 'agree' | 'decline' } | null;
  /**
   * The code graph could not be read for this answer (Story MOTIR-8136 · MOTIR-8144):
   * the result carries motir-ai's top-level `codeUnreadable` signal beside the answer.
   * Present only when declared, so every other reply is byte-identical to before.
   * `true` sends the default reason (`snapshot_integrity`); a reason names which
   * outage it was — `hydrate_failed` (the graph is unavailable) or `not_indexed` (the
   * repository has no graph yet) — so a spec reaches each (Story MOTIR-9216 · MOTIR-9234).
   */
  codeUnreadable?: boolean | CodeUnreadableReason;
  /**
   * `out_of_credits` refuses the SUBMIT with motir-ai's `402` (Story MOTIR-9216 ·
   * MOTIR-9234), the guide's arm for an ask: no job is created. Consumed per
   * submit attempt, like the guide's.
   */
  submit?: 'accepted' | 'out_of_credits';
}

/** The outage reasons motir-ai's `codeUnreadable` signal names. */
export type CodeUnreadableReason = 'snapshot_integrity' | 'hydrate_failed' | 'not_indexed';

/**
 * What the next ROUTING run should decide (Story MOTIR-4753 · MOTIR-4762).
 *
 * ⚠️ THE LANE COULD NOT REACH THESE STATES BEFORE, which is the check
 * MOTIR-4762 asks for BEFORE a line of spec is written: every `plan` job settled
 * as a plain success here, so a plan window asking for a verdict got none and
 * every journey ended in the workspace. A lane that cannot reach the asserted
 * state does not go red — it goes green on the unfixed code.
 */
export interface RoutingJobOutcome {
  // ⚠️ FOUR SINCE MOTIR-4828. `wait_for_index` is the outcome with no
  // destination: the repository is connected, its graph does not exist yet, and
  // the window HOLDS the person rather than routing them. The acceptance lane
  // cannot drive that journey at all without an arm here — which is the
  // *a named fixture that was never built* trap, so the arm ships with the spec
  // that needs it.
  outcome: 'continue' | 'onboard_new_project' | 'onboard_existing_project' | 'wait_for_index';
  message: string;
  keptSteps?: string[];
  missing?: string[];
}

/** What the next `author_bug` job should settle as (MOTIR-5852 / MOTIR-5853). */
export interface AuthorBugJobOutcome {
  status?: 'succeeded' | 'failed' | 'running';
  authoredBug?: unknown;
}

/**
 * What the next `guide_work_item` job should do (Story MOTIR-7459 · MOTIR-7468).
 * A submit the fixture may refuse out of credits, and the job's `guideTurn` — `{ messageMd, actions }` — which
 * the settle validates and lands. A spec names real row ids in it by rewriting
 * the fixture after it reads the card, since the file is re-read every request.
 */
export interface GuideJobOutcome {
  /**
   * `'late'` (MOTIR-9255) CREATES the job and then answers the submit with a 503,
   * as a Fly proxy does when the conversation machine wakes after motir-core gave
   * up: the job exists, motir-core never heard of it, and its re-send under the
   * same `idempotencyKey` is answered with that job.
   */
  submit?: 'accepted' | 'out_of_credits' | 'late';
  /** Absent ⇒ a success with NO result, which the settle reports as failed. */
  guideTurn?: unknown;
}

/**
 * What the next `translate` job should do (Story MOTIR-7735 · MOTIR-8119) — the
 * shapes of {@link GuideJobOutcome} and {@link AuthorBugJobOutcome} together: a
 * submit the fixture may refuse out of credits, then a job that settles
 * `succeeded`, `failed` (motir-ai's `ai_job_failed`) or stays `running` for as
 * long as the entry says so — the hung job the door's deadline turns into
 * `timeout`.
 */
export interface TranslateJobOutcome {
  submit?: 'accepted' | 'out_of_credits';
  status?: 'succeeded' | 'failed' | 'running';
  /**
   * The job's `translations` result unit, as given. Absent on a success ⇒ the
   * mock ECHOES the submitted fields as `[<targetLanguage>] <text>`, one per
   * `fieldRef` in the order sent, so a spec need not know the door's field refs
   * to see a translation land.
   */
  translations?: unknown;
}

/**
 * A PLANNING run's outcome (Story MOTIR-7630 · MOTIR-7645). Absent ⇒ the run
 * progresses and closes as a plain success, which is every spec before this one.
 * `failed` sends the terminal `status: failed` frame motir-ai sends for a run
 * that died, and settles the job with its error — the frame the stream relays
 * end the session on (AMENDMENT 23 §2).
 */
export interface PlanJobOutcome {
  /**
   * `running` HOLDS the run in progress (Story MOTIR-7990 · MOTIR-8004): `GET
   * /v1/jobs/:id` answers `running` with no result, and the stream never reaches
   * a terminal frame — it hands the relay back `done { timedOut: true }` windows,
   * which `followJobStream` follows by subscribing again, exactly as it does for a
   * long real run. A spec ENDS the run by rewriting this entry to `succeeded` (or
   * `failed`). ⚠️ The lane had no run that was ever *in progress* before this:
   * every `plan` job settled as an instant success and closed its stream at once.
   */
  status?: 'succeeded' | 'failed' | 'running';
  /**
   * On a `succeeded` run: send the terminal `status` frame motir-ai sends when a
   * job ends. Off by default (the shipped success stream is `search`, `done`), so
   * every existing reply is unchanged; a spec that needs the rail to SEE the walk
   * end — which is what fires the late-changes claim — turns it on.
   */
  statusFrame?: boolean;
  /**
   * The planner's UTTERANCE for a succeeded run (Story MOTIR-7797 · MOTIR-7809),
   * returned as `result.turn` — the shape `readPlanningTurn`
   * (`lib/planning/plannerTurn.ts`) reads. Absent ⇒ `result` is `{}`, as before,
   * so the run records no narration.
   */
  turn?: { message: string; question?: string | null };
  /**
   * Where a FAILED run stopped (Story MOTIR-7905 · MOTIR-7920), carried on the settled
   * `error` exactly as motir-ai's `Problem.walkStop` is, and announced by a `walk_position`
   * progress frame before the terminal `status: failed` frame. Absent ⇒ the failure names no
   * stop point, as before.
   */
  walkStop?: {
    phase: 'lay' | 'author';
    target: string | null;
    targetTitle?: string | null;
    depth: number;
    planId?: string | null;
    reasonCode: string;
    detail?: string;
  };
  /**
   * The run HALTED on an unreadable code graph and wrote no plan (Story MOTIR-8136 ·
   * MOTIR-8144): `result` is motir-ai's halt envelope — an empty delta and the
   * `codeUnreadable` signal, no `turn`. Wins over `turn` when both are declared.
   */
  codeUnreadable?: boolean;
  /**
   * The run STOPPED before planning because a TARGET repository's code cannot be SEARCHED
   * (Story MOTIR-9165 · MOTIR-9171): `result` is motir-ai's pre-planning envelope — an
   * empty delta and `codeUnsearchable: { repos }`, no `turn`. Wins over `turn` when both
   * are declared.
   */
  codeUnsearchable?: Array<{ repoRef: string; state: string }>;
  /**
   * The problem a FAILED run settles with (Story MOTIR-8301 · MOTIR-8311). Absent ⇒
   * `ai_job_failed`, the handler's own rejection, so every existing reply is
   * byte-identical. `ai_job_abandoned` is motir-ai's REAPER problem — the machine
   * holding the job stopped renewing its lease — copied from `ABANDONED` in
   * motir-ai `src/jobs/reaper.ts` (with `problem()` in `src/problem.ts`). The stream
   * keeps its `status: failed` frame either way, as motir-ai's does.
   */
  problemCode?: 'ai_job_failed' | 'ai_job_abandoned';
}

/** motir-ai's `codeUnreadable` signal, as `CodeUnreadableEnvelope` shapes it. */
const CODE_UNREADABLE_SIGNAL = {
  halt: 'code_unreadable',
  repoRef: 'acme/web',
  repoRefs: ['acme/web'],
  reason: 'snapshot_integrity',
} as const;

/** The signal an ask outcome declared, with the reason it named. */
function codeUnreadableSignal(declared: boolean | CodeUnreadableReason) {
  return declared === true
    ? CODE_UNREADABLE_SIGNAL
    : { ...CODE_UNREADABLE_SIGNAL, reason: declared };
}

/** One recorded `POST /v1/jobs` (diagnostic; the spec owns the fixture file). */
export interface SubmittedJob {
  kind: string;
  hasCode?: boolean;
  refused?: boolean;
  /** The id this seam answered with — absent on a refused submit. */
  jobId?: string;
  /** The submit's `idempotencyKey` (MOTIR-9255), when it carried one. */
  idempotencyKey?: string;
  /**
   * The job token motir-core minted into the envelope (`readBackToken`), kept
   * for a `plan` submit (MOTIR-7809) so a spec can call a job-token route —
   * `POST /api/internal/ai/log-bug` — exactly as motir-ai would for that job.
   */
  readBackToken?: string;
  /**
   * The `resume` a `plan` submit carried (MOTIR-7910/7920) — how a spec proves a Resume press
   * was sent, and for the SAME plan.
   */
  resume?: { planId: string; fromJobId: string };
  /**
   * The RUN SNAPSHOT an `ask_project` submit carried (`context.run`, Story
   * MOTIR-7990 · MOTIR-8004): the plan the typed-into run is writing, and whether
   * the answering session could read it. Present only on a mid-run ask, so a spec
   * can tell a question typed into a run from one typed into none.
   */
  runPlanId?: string;
  runReadable?: boolean;
  /** A `plan` submit's `context.planId` — set on a REVISION of that plan, absent
   *  on a run that starts a plan of its own. */
  planId?: string;
  /** A `translate` submit's `context.translate` (MOTIR-8119) — what was sent, and
   *  what the default success echoes back. */
  translate?: { targetLanguage: string; fields: { fieldRef: string; text: string }[] };
  /**
   * The two LANGUAGES the envelope's tenant carried (Story MOTIR-7734 · MOTIR-8750):
   * the organisation's content language and the requesting person's saved account
   * language (`''` when no person started the job). Recorded off `tenant` as sent,
   * so a spec proves which languages a planner would have been told to write in.
   * Absent when the tenant named none.
   */
  contentLanguage?: string;
  personLanguage?: string;
  /** A `plan` submit's `context.carriedAnswers` (Story MOTIR-9221 · MOTIR-9319) — what
   *  the conversation's grilling settled before the run, as motir-core sent it. */
  carriedAnswers?: CarriedAnswers;
}

/**
 * What the next `generate_explanation` job streams (Story MOTIR-7734 · MOTIR-8750):
 * the draft, as `token` frames and then motir-ai's terminal `explanation` frame
 * `{ explanationMd, language }` — the frame `useExplanationDraft` reads the draft's
 * language off. `language` absent ⇒ the frame names none, as an older motir-ai's
 * does. With NO entry declared the stream is the general `search`, `done`, as before.
 */
export interface GenerateExplanationJobOutcome {
  explanationMd: string;
  language?: string;
}

export interface AiJobsFixture {
  /**
   * The `ask_project` outcomes, CONSUMED IN ORDER — one per ask job submitted.
   * The last entry repeats once the queue is exhausted, so a spec only declares
   * the turns it actually cares about.
   */
  ask?: AskJobOutcome[];
  /**
   * The ROUTING verdicts, CONSUMED IN ORDER — one per run that ASKED for one
   * (`context.routeOnboarding`). The last entry repeats, same as `ask`.
   *
   * ⚠️ A `plan` submit that did NOT ask is untouched and settles as before. That
   * is the product's own discriminator, not a test convenience: the migrate
   * wizard's own generate step reaches the same submit and must never be routed.
   */
  routing?: RoutingJobOutcome[];
  /**
   * The `author_bug` results (Story MOTIR-4930 · MOTIR-5852 / MOTIR-5853),
   * CONSUMED IN ORDER — one per author job submitted, the last repeating. Each
   * names the job's STATUS and, for a success, the `authoredBug` answer the
   * enrichment writes onto the bug. Absent ⇒ a job that succeeds with NO answer,
   * which the write-back refuses as `invalid-answer` — so a spec that forgot to
   * declare one sees an unenriched card rather than an invented one.
   */
  authorBug?: AuthorBugJobOutcome[];
  /** The `guide_work_item` outcomes, CONSUMED IN ORDER — one per submit attempt,
   *  the last repeating (MOTIR-7468). */
  guide?: GuideJobOutcome[];
  /** The `translate` outcomes, CONSUMED IN ORDER — one per submit attempt, the
   *  last repeating (MOTIR-8119). */
  translate?: TranslateJobOutcome[];
  /** The `plan` run outcomes, CONSUMED IN ORDER — one per planning submit that
   *  is not a routing run, the last repeating (MOTIR-7645). */
  plan?: PlanJobOutcome[];
  /** The `generate_explanation` drafts, CONSUMED IN ORDER — one per submit, the
   *  last repeating (MOTIR-8750). */
  generateExplanation?: GenerateExplanationJobOutcome[];
  /** Appended to by the mock: the job kind of every submit, in order — and
   *  whether it carried a repository set (`context.code`), which is how a walk
   *  shows a CODE-BLIND project's dispatch went without one (MOTIR-5853). */
  submitted?: SubmittedJob[];
}

const json = { headers: { 'content-type': 'application/json' } } as const;

/** How long one held-run stream window lasts before the relay subscribes again. */
const HELD_WINDOW_MS = 400;

function fixturePath(): string | null {
  return process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? null;
}

function readFixture(): AiJobsFixture {
  const p = fixturePath();
  if (!p) return {};
  try {
    return JSON.parse(readFixtureFileSync(p)) as AiJobsFixture;
  } catch {
    // An unreadable/absent fixture reads as "nothing declared" rather than
    // throwing: the ask then settles as an answer with no citations, which is a
    // legible surface instead of a 500 from the boundary.
    return {};
  }
}

/** How many submits of `kind` came before this one — its queue ordinal. */
function submitOrdinal(kind: string): number {
  return (readFixture().submitted ?? []).filter((s) => s.kind === kind).length;
}

/** Record a submit so the SPEC can read back which job kinds actually ran. */
function recordSubmit(kind: string, rawBody: string, refused = false): number {
  const p = fixturePath();
  const f = readFixture();
  const index = (f.submitted ?? []).filter((s) => s.kind === kind).length;
  if (!p) return index;
  try {
    const token = kind === 'plan' && !refused ? readBackTokenOf(rawBody) : null;
    const resume = kind === 'plan' && !refused ? resumeOf(rawBody) : null;
    const snapshot = submitContext(rawBody);
    const translate = kind === 'translate' ? translateContextOf(rawBody) : null;
    const entry: SubmittedJob = {
      kind,
      hasCode: submitCarriesCode(rawBody),
      ...(refused ? { refused } : { jobId: jobIdFor(kind, index) }),
      ...(token ? { readBackToken: token } : {}),
      ...(resume ? { resume } : {}),
      ...(snapshot.runPlanId !== undefined ? { runPlanId: snapshot.runPlanId } : {}),
      ...(snapshot.runReadable !== undefined ? { runReadable: snapshot.runReadable } : {}),
      ...(kind === 'plan' && snapshot.planId !== undefined ? { planId: snapshot.planId } : {}),
      ...(kind === 'plan' && carriedAnswersOf(rawBody)
        ? { carriedAnswers: carriedAnswersOf(rawBody)! }
        : {}),
      ...(translate ? { translate } : {}),
      ...tenantLanguagesOf(rawBody),
      ...(idempotencyKeyOf(rawBody) ? { idempotencyKey: idempotencyKeyOf(rawBody)! } : {}),
    };
    f.submitted = [...(f.submitted ?? []), entry];
    writeFixtureFileSync(p, JSON.stringify(f, null, 2));
  } catch {
    // Recording is diagnostic only — never fail the request over it.
  }
  return index;
}

/** The ask outcome for the `n`-th ask job, with the last entry repeating. */
function askOutcomeAt(n: number): AskJobOutcome {
  const queue = readFixture().ask ?? [];
  if (queue.length === 0) return { intent: 'ask', answer: 'No answer was declared.' };
  return queue[Math.min(n, queue.length - 1)]!;
}

/** The `idempotencyKey` a submit body carried (MOTIR-9255), or null. */
function idempotencyKeyOf(rawBody: string): string | null {
  try {
    const key = (JSON.parse(rawBody) as { idempotencyKey?: unknown }).idempotencyKey;
    return typeof key === 'string' && key !== '' ? key : null;
  } catch {
    return null;
  }
}

/** The job an earlier ACCEPTED submit created under `rawBody`'s key, or null —
 *  motir-ai answers a repeated key with that job and creates none (MOTIR-9255). */
function jobForRepeatedKey(rawBody: string): string | null {
  const key = idempotencyKeyOf(rawBody);
  if (!key) return null;
  const earlier = (readFixture().submitted ?? []).find(
    (s) => !s.refused && s.idempotencyKey === key && s.jobId,
  );
  return earlier?.jobId ?? null;
}

/** The job token the envelope carried (`readBackToken`), or null. */
function readBackTokenOf(rawBody: string): string | null {
  try {
    const token = (JSON.parse(rawBody) as { readBackToken?: unknown }).readBackToken;
    return typeof token === 'string' && token !== '' ? token : null;
  } catch {
    return null;
  }
}

/** The `resume` a submit body carried, or null. */
function resumeOf(rawBody: string): { planId: string; fromJobId: string } | null {
  try {
    const r = (JSON.parse(rawBody) as { resume?: { planId?: unknown; fromJobId?: unknown } })
      .resume;
    return typeof r?.planId === 'string' && typeof r.fromJobId === 'string'
      ? { planId: r.planId, fromJobId: r.fromJobId }
      : null;
  } catch {
    return null;
  }
}

/** The run snapshot (`context.run`) and plan (`context.planId`) a submit carried. */
function submitContext(rawBody: string): {
  runPlanId?: string;
  runReadable?: boolean;
  planId?: string;
} {
  try {
    const context = (JSON.parse(rawBody) as { context?: Record<string, unknown> }).context ?? {};
    const run = context['run'];
    const runRecord =
      typeof run === 'object' && run !== null ? (run as Record<string, unknown>) : null;
    const runPlanId = runRecord?.['planId'];
    const runReadable = runRecord?.['readable'];
    const planId = context['planId'];
    return {
      ...(typeof runPlanId === 'string' ? { runPlanId } : {}),
      ...(typeof runReadable === 'boolean' ? { runReadable } : {}),
      ...(typeof planId === 'string' ? { planId } : {}),
    };
  } catch {
    return {};
  }
}

/** The `context.carriedAnswers` a submit body carried, or null. */
function carriedAnswersOf(rawBody: string): CarriedAnswers | null {
  try {
    const carried = (JSON.parse(rawBody) as { context?: { carriedAnswers?: unknown } }).context
      ?.carriedAnswers;
    return typeof carried === 'object' && carried !== null ? (carried as CarriedAnswers) : null;
  } catch {
    return null;
  }
}

/** Whether a submit body carried a repository set — `context.code`. */
function submitCarriesCode(rawBody: string): boolean {
  try {
    const body = JSON.parse(rawBody) as { context?: { code?: unknown } };
    return body.context?.code !== undefined && body.context.code !== null;
  } catch {
    return false;
  }
}

/** The tenant's two languages a submit body carried, each only when it is a string. */
function tenantLanguagesOf(rawBody: string): { contentLanguage?: string; personLanguage?: string } {
  try {
    const tenant = (JSON.parse(rawBody) as { tenant?: Record<string, unknown> }).tenant ?? {};
    const content = tenant['contentLanguage'];
    const person = tenant['personLanguage'];
    return {
      ...(typeof content === 'string' ? { contentLanguage: content } : {}),
      ...(typeof person === 'string' ? { personLanguage: person } : {}),
    };
  } catch {
    return {};
  }
}

/** The draft for the `n`-th `generate_explanation` job, the last repeating; null when none
 *  is declared. */
function explanationOutcomeAt(n: number): GenerateExplanationJobOutcome | null {
  const queue = readFixture().generateExplanation ?? [];
  if (queue.length === 0) return null;
  return queue[Math.min(n, queue.length - 1)]!;
}

/** A declared draft as motir-ai streams it: two `token` deltas, then the terminal
 *  `explanation` frame, the `succeeded` status and the close. */
function explanationStream(draft: GenerateExplanationJobOutcome): string {
  const half = Math.ceil(draft.explanationMd.length / 2);
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    frame('token', { text: draft.explanationMd.slice(0, half) }),
    frame('token', { text: draft.explanationMd.slice(half) }),
    frame('explanation', {
      explanationMd: draft.explanationMd,
      ...(draft.language !== undefined ? { language: draft.language } : {}),
    }),
    frame('status', { status: 'succeeded' }),
    frame('done', {}),
  ].join('');
}

/** The author outcome for the `n`-th `author_bug` job, with the last entry repeating. */
function authorBugOutcomeAt(n: number): AuthorBugJobOutcome {
  const queue = readFixture().authorBug ?? [];
  if (queue.length === 0) return { status: 'succeeded' };
  return queue[Math.min(n, queue.length - 1)]!;
}

/** The guide outcome for the `n`-th `guide_work_item` submit attempt, the last repeating. */
function guideOutcomeAt(n: number): GuideJobOutcome {
  const queue = readFixture().guide ?? [];
  if (queue.length === 0) return {};
  return queue[Math.min(n, queue.length - 1)]!;
}

/** The translate outcome for the `n`-th `translate` submit attempt, the last repeating. */
function translateOutcomeAt(n: number): TranslateJobOutcome {
  const queue = readFixture().translate ?? [];
  if (queue.length === 0) return {};
  return queue[Math.min(n, queue.length - 1)]!;
}

/**
 * How many `translate` jobs motir-ai would have BILLED (MOTIR-8459): accepted
 * submits whose outcome at their own ordinal settles `succeeded`. A refused,
 * `failed` or still-`running` submit counts zero. Exported so the billing mock's
 * derived translation block follows this queue's rule rather than a copy of it.
 */
export function succeededTranslateJobCount(): number {
  const translateSubmits = (readFixture().submitted ?? []).filter((s) => s.kind === 'translate');
  return translateSubmits.filter(
    (s, i) => !s.refused && (translateOutcomeAt(i).status ?? 'succeeded') === 'succeeded',
  ).length;
}

/** The `context.translate` a submit body carried, or null. */
function translateContextOf(rawBody: string): SubmittedJob['translate'] | null {
  try {
    const unit = (JSON.parse(rawBody) as { context?: { translate?: unknown } }).context?.translate;
    if (typeof unit !== 'object' || unit === null) return null;
    const { targetLanguage, fields } = unit as { targetLanguage?: unknown; fields?: unknown };
    if (typeof targetLanguage !== 'string' || !Array.isArray(fields)) return null;
    return { targetLanguage, fields: fields as { fieldRef: string; text: string }[] };
  } catch {
    return null;
  }
}

/** The settled `GET /v1/jobs/:id` body of the `index`-th `translate` job. */
function translateJobBody(id: string, index: number): Record<string, unknown> {
  const outcome = translateOutcomeAt(index);
  const status = outcome.status ?? 'succeeded';
  if (status === 'running') return { status, result: null };
  if (status === 'failed') {
    return {
      status,
      result: null,
      error: {
        type: 'about:blank',
        title: 'AI job failed',
        status: 502,
        code: 'ai_job_failed',
        detail: 'The fixture declared this translate job failed.',
      },
    };
  }
  const sent = (readFixture().submitted ?? []).find((s) => s.jobId === id)?.translate;
  const translations =
    outcome.translations !== undefined
      ? outcome.translations
      : (sent?.fields ?? []).map((f) => ({
          fieldRef: f.fieldRef,
          text: `[${sent!.targetLanguage}] ${f.text}`,
        }));
  return { status, result: { translations } };
}

/** The outcome for the `n`-th planning run, with the last entry repeating. */
function planOutcomeAt(n: number): PlanJobOutcome {
  const queue = readFixture().plan ?? [];
  if (queue.length === 0) return {};
  return queue[Math.min(n, queue.length - 1)]!;
}

/** Whether this job is a planning run the fixture declared failed. */
function planRunFails(jobId: string): boolean {
  const { kind, index } = kindOf(jobId);
  return kind === 'plan' && planOutcomeAt(index).status === 'failed';
}

/** Whether a succeeded planning run should also send the terminal `status` frame. */
function planRunReportsStatus(jobId: string): boolean {
  const { kind, index } = kindOf(jobId);
  if (kind !== 'plan') return false;
  const outcome = planOutcomeAt(index);
  return (
    outcome.statusFrame === true && outcome.status !== 'failed' && outcome.status !== 'running'
  );
}

/** Whether this job is a planning run the fixture is HOLDING in progress. */
function planRunHeld(jobId: string): boolean {
  const { kind, index } = kindOf(jobId);
  return kind === 'plan' && planOutcomeAt(index).status === 'running';
}

/** The routing verdict for the `n`-th routing run, with the last entry repeating. */
function routingOutcomeAt(n: number): RoutingJobOutcome {
  const queue = readFixture().routing ?? [];
  if (queue.length === 0) {
    // Nothing declared reads as *no verdict on the envelope*, which the consumer
    // treats as "this run was never asked for one" — the workspace opens and
    // nobody is routed. A legible surface rather than a 500 from the boundary.
    return { outcome: 'continue', message: '' };
  }
  return queue[Math.min(n, queue.length - 1)]!;
}

/**
 * THE KIND THIS SUBMIT ACTUALLY IS.
 *
 * ⚠️ `jobKind` ALONE CANNOT TELL A ROUTING RUN FROM A PLANNING ONE — both are
 * `plan` (ADR `session-model.md` §6 step 2: one planning kind, and motir-ai reads
 * WHAT a run is about off the context bag). `context.routeOnboarding` is the
 * product's own discriminator, so the mock reads the same field the service
 * writes rather than inventing a second one.
 */
function kindOfSubmit(rawBody: string): string {
  try {
    const body = JSON.parse(rawBody) as {
      jobKind?: string;
      context?: { routeOnboarding?: unknown };
    };
    const kind = body.jobKind ?? 'unknown';
    return kind === 'plan' && body.context?.routeOnboarding === true ? 'plan_routing' : kind;
  } catch {
    return 'unknown';
  }
}

/** A job id that CARRIES its kind and ordinal, so a failure names what it was. */
function jobIdFor(kind: string, index: number): string {
  return `e2e-${kind}-${index}`;
}

function kindOf(jobId: string): { kind: string; index: number } {
  const m = /^e2e-(.+)-(\d+)$/.exec(jobId);
  return m ? { kind: m[1]!, index: Number(m[2]) } : { kind: 'unknown', index: 0 };
}

/**
 * A side effect ANOTHER seam wants on a `POST /v1/jobs`, without intercepting it.
 *
 * ⚠️ THIS EXISTS BECAUSE TWO SEAMS CANNOT SHARE ONE UNDICI PATH (MOTIR-4137).
 * `test-lessons-mock` used to register its own `/v1/jobs` interceptors on this
 * same origin to record a lesson capture. undici matches interceptors in
 * REGISTRATION ORDER and `instrumentation.ts` installs the lessons seam first,
 * so with both flags on the lessons seam answered the whole jobs protocol —
 * a constant `job_lessons_e2e` id and a `{ operations: [] }` result — and this
 * seam's own replies were unreachable. The ask journey reads its outcome out of
 * the job id and the settled `result`, so it went silent on every turn.
 *
 * An observer is the shape that cannot regress that way: it names the effect a
 * neighbouring seam needs (the write) without claiming the reply (the protocol),
 * so the two are no longer competing for the same interceptor.
 */
type JobSubmitObserver = (rawBody: string) => void;

const submitObservers: JobSubmitObserver[] = [];

/** Attach a side effect to every `POST /v1/jobs` this seam answers. */
export function observeAiJobSubmit(observer: JobSubmitObserver): void {
  submitObservers.push(observer);
}

function notifySubmitObservers(rawBody: string): void {
  for (const observe of submitObservers) {
    try {
      observe(rawBody);
    } catch {
      // An observer is a neighbouring seam's bookkeeping — never fail the
      // request (and never skip the remaining observers) over it.
    }
  }
}

export function installAiJobsBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  // POST /v1/jobs — accept any kind and answer with an id that encodes it.
  pool
    .intercept({ path: (p) => p === '/v1/jobs' || p.startsWith('/v1/jobs?'), method: 'POST' })
    .reply((req) => {
      const rawBody = String(req.body ?? '{}');
      const kind = kindOfSubmit(rawBody);
      notifySubmitObservers(rawBody);
      // A repeated idempotency key answers the job it already created (MOTIR-9255).
      const repeated = jobForRepeatedKey(rawBody);
      if (repeated) return { statusCode: 202, data: { jobId: repeated }, responseOptions: json };
      // The refusal this seam models at the submit (the guide's MOTIR-7468, then
      // the translate's and the ask's): motir-ai's own `402 out_of_credits`
      // problem, so the real
      // client maps it.
      if (
        (kind === 'guide_work_item' &&
          guideOutcomeAt(submitOrdinal(kind)).submit === 'out_of_credits') ||
        (kind === 'ask_project' && askOutcomeAt(submitOrdinal(kind)).submit === 'out_of_credits') ||
        (kind === 'translate' &&
          translateOutcomeAt(submitOrdinal(kind)).submit === 'out_of_credits')
      ) {
        recordSubmit(kind, rawBody, true);
        const problem: Record<string, unknown> = {
          type: 'about:blank',
          title: 'Out of credits',
          status: 402,
          code: 'out_of_credits',
          detail: `The fixture declared this ${kind} submit out of credits.`,
        };
        return {
          statusCode: 402,
          data: problem,
          responseOptions: { headers: { 'content-type': 'application/problem+json' } },
        };
      }
      const late =
        kind === 'guide_work_item' && guideOutcomeAt(submitOrdinal(kind)).submit === 'late';
      const index = recordSubmit(kind, rawBody);
      // The job exists; the answer is lost behind a machine that woke too late.
      if (late) return { statusCode: 503, data: 'machine waking' };
      const accepted: Record<string, unknown> = { jobId: jobIdFor(kind, index) };
      return { statusCode: 202, data: accepted, responseOptions: json };
    })
    .persist();

  // GET /v1/jobs/:id/stream for a planning run the fixture HOLDS in progress.
  //
  // ⚠️ REGISTERED BEFORE THE GENERAL STREAM ON PURPOSE: undici tries interceptors
  // in registration order and this one's path predicate is true only for a held
  // run, so every other job falls through to the general reply below untouched.
  // A held run answers each subscription with `status: running` and the stream
  // WINDOW's `done { timedOut: true }`, which the relay (`followJobStream`) follows
  // by subscribing again — the same loop a long real run makes. The delay is what
  // keeps that loop from spinning: one window is a few hundred milliseconds, not a
  // busy poll of this file. Rewriting the run to `succeeded` / `failed` makes the
  // predicate false, so the NEXT window gets the terminal reply.
  pool
    .intercept({
      path: (p) => {
        const m = /^\/v1\/jobs\/([^/?]+)\/stream(\?|$)/.exec(p);
        return m ? planRunHeld(decodeURIComponent(m[1]!)) : false;
      },
      method: 'GET',
    })
    .reply(() => ({
      statusCode: 200,
      data: `event: search\ndata: {}\n\nevent: status\ndata: {"status":"running"}\n\nevent: done\ndata: {"timedOut":true}\n\n`,
      responseOptions: { headers: { 'content-type': 'text/event-stream' } },
    }))
    .delay(HELD_WINDOW_MS)
    .persist();

  // GET /v1/jobs/:id/stream — the SSE the relay forwards to the rail.
  //
  // ⚠️ It carries the REAL frame vocabulary rather than assistant tokens: the
  // stream is NOT the answer (the settle is), so what a spec should see here is
  // a run progressing and closing, exactly as motir-ai sends it.
  pool
    .intercept({ path: (p) => /^\/v1\/jobs\/[^/]+\/stream(\?|$)/.test(p), method: 'GET' })
    .reply((req) => {
      const id = decodeURIComponent(req.path.split('?')[0]!.split('/').slice(-2)[0]!);
      // A declared `generate_explanation` draft (MOTIR-8750) streams its tokens and its
      // terminal `explanation` frame; with none declared the reply below is unchanged.
      const explained = kindOf(id);
      const draft =
        explained.kind === 'generate_explanation' ? explanationOutcomeAt(explained.index) : null;
      if (draft) {
        return {
          statusCode: 200,
          data: explanationStream(draft),
          responseOptions: { headers: { 'content-type': 'text/event-stream' } },
        };
      }
      // A planning run the fixture declared FAILED ends the way motir-ai ends a
      // dead run: a terminal `status: failed` frame, then the close.
      const stop = planRunFails(id) ? planOutcomeAt(kindOf(id).index).walkStop : undefined;
      const position = stop
        ? `event: walk_position\ndata: ${JSON.stringify({
            phase: stop.phase,
            target: stop.target,
            targetTitle: stop.targetTitle ?? null,
            depth: stop.depth,
          })}\n\n`
        : '';
      const data = planRunFails(id)
        ? `event: search\ndata: {}\n\n${position}event: status\ndata: {"status":"failed"}\n\nevent: done\ndata: {}\n\n`
        : planRunReportsStatus(id)
          ? `event: search\ndata: {}\n\nevent: status\ndata: {"status":"succeeded"}\n\nevent: done\ndata: {}\n\n`
          : `event: search\ndata: {}\n\nevent: done\ndata: {}\n\n`;
      return {
        statusCode: 200,
        data,
        responseOptions: { headers: { 'content-type': 'text/event-stream' } },
      };
    })
    .persist();

  // GET /v1/jobs/:id — the settled result. `ask_project` reads its outcome from
  // the fixture queue; every other kind settles as a plain success, which is
  // what the shipped plan-change path expects (its proposals arrive through the
  // Plan, never through the job result).
  pool
    .intercept({ path: (p) => /^\/v1\/jobs\/[^/]+(\?|$)/.test(p), method: 'GET' })
    .reply((req) => {
      const id = decodeURIComponent(req.path.split('?')[0]!.split('/').pop()!);
      const { kind, index } = kindOf(id);
      // ONE shape for both arms. undici infers the reply type from what this
      // callback returns, so two differently-shaped `result` objects leave the
      // overload unresolvable — and a `result` that is sometimes absent is
      // exactly what the ENVELOPE contract says anyway (per-kind, additive).
      const outcome = askOutcomeAt(index);
      const routing = routingOutcomeAt(index);
      if (planRunHeld(id)) {
        const held: Record<string, unknown> = { status: 'running', result: null };
        return { statusCode: 200, data: held, responseOptions: json };
      }
      if (planRunFails(id)) {
        const failure = planOutcomeAt(index);
        const data: Record<string, unknown> = {
          status: 'failed',
          result: null,
          error:
            failure.problemCode === 'ai_job_abandoned'
              ? {
                  // motir-ai's reaper problem, as `problem('ai_job_abandoned')` builds it and
                  // the reap statement extends it with the job id and its detail.
                  type: 'https://motir.co/errors/ai_job_abandoned',
                  title: 'Planning job abandoned',
                  status: 500,
                  code: 'ai_job_abandoned',
                  jobId: id,
                  detail:
                    'the worker holding this job stopped renewing its lease (claimedBy e2e-lost-machine); nothing about the request was judged, so a resubmit is the right response',
                }
              : {
                  type: 'about:blank',
                  title: 'AI job failed',
                  status: 502,
                  code: 'ai_job_failed',
                  detail: 'The fixture declared this planning run failed.',
                  ...(failure.walkStop ? { walkStop: failure.walkStop } : {}),
                },
        };
        return { statusCode: 200, data, responseOptions: json };
      }
      if (kind === 'translate') {
        return { statusCode: 200, data: translateJobBody(id, index), responseOptions: json };
      }
      if (kind === 'author_bug') {
        const author = authorBugOutcomeAt(index);
        const status = author.status ?? 'succeeded';
        // Typed as the same loose record the arm below returns — undici infers
        // the reply type from EVERY return, so two shapes leave it unresolvable.
        const data: Record<string, unknown> =
          status === 'failed'
            ? {
                status,
                result: null,
                error: {
                  type: 'about:blank',
                  title: 'AI job failed',
                  status: 502,
                  code: 'ai_job_failed',
                  detail: 'The fixture declared this author_bug job failed.',
                },
              }
            : {
                status,
                result:
                  status === 'succeeded' && author.authoredBug !== undefined
                    ? { authoredBug: author.authoredBug }
                    : null,
              };
        return { statusCode: 200, data, responseOptions: json };
      }
      const result: Record<string, unknown> =
        kind === 'ask_project'
          ? {
              ask: {
                intent: outcome.intent,
                answer: outcome.answer ?? null,
                citations: outcome.citations ?? [],
                ...(outcome.anchorKey ? { anchorKey: outcome.anchorKey } : {}),
                // Run mode (MOTIR-8004): present only when the fixture declared them.
                ...(outcome.forward !== undefined ? { forward: outcome.forward } : {}),
                ...(outcome.offerForward !== undefined
                  ? { offerForward: outcome.offerForward }
                  : {}),
                ...(outcome.run !== undefined ? { run: outcome.run } : {}),
                // The plan offer (MOTIR-9297): present only when the fixture declared them.
                ...(outcome.offer !== undefined ? { offer: outcome.offer } : {}),
                ...(outcome.offerReply !== undefined ? { offerReply: outcome.offerReply } : {}),
              },
              ...(outcome.codeUnreadable
                ? { codeUnreadable: codeUnreadableSignal(outcome.codeUnreadable) }
                : {}),
            }
          : kind === 'guide_work_item' && guideOutcomeAt(index).guideTurn !== undefined
            ? { guideTurn: guideOutcomeAt(index).guideTurn }
            : kind === 'plan_routing' && routing.message !== ''
              ? {
                  // The HALT's envelope (MOTIR-4767): nothing was planned, and the
                  // verdict is the whole result. motir-ai also sends an EMPTY plan
                  // delta, because its `ResultEnvelope` type requires that field;
                  // it is omitted here because nothing in THIS tree reads one — the
                  // single proposal→tree write path is `approvePlan` →
                  // `materialize`, and `planChangeArchitecture` asserts repo-wide
                  // that no second one exists, this mock included.
                  onboardingRouting: {
                    outcome: routing.outcome,
                    message: routing.message,
                    ...(routing.keptSteps ? { keptSteps: routing.keptSteps } : {}),
                    ...(routing.missing ? { missing: routing.missing } : {}),
                  },
                }
              : kind === 'plan' && planOutcomeAt(index).codeUnreadable
                ? // The HALT on an unreadable code graph (MOTIR-8144): no plan, no turn — only the
                  // signal (the delta field is left out for the reason the routing arm gives).
                  {
                    codeUnreadable: CODE_UNREADABLE_SIGNAL,
                  }
                : kind === 'plan' && planOutcomeAt(index).codeUnsearchable
                  ? // The STOP on a target repository whose code cannot be searched (MOTIR-9171):
                    // no plan, no turn — only the blocked list, as motir-ai's envelope shapes it.
                    { codeUnsearchable: { repos: planOutcomeAt(index).codeUnsearchable } }
                  : kind === 'plan' && planOutcomeAt(index).turn
                    ? // The planner's utterance (MOTIR-7809), read by `readPlanningTurn`.
                      { turn: planOutcomeAt(index).turn }
                    : {};
      const settled: Record<string, unknown> = { status: 'succeeded', result };
      return { statusCode: 200, data: settled, responseOptions: json };
    })
    .persist();
}
