import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planRepository } from '@/lib/repositories/planRepository';
import { resolveJobState } from '@/lib/services/aiPlanEditsService';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import {
  endSessionForAbandonedPlan,
  recordFailureWithin,
  releaseUnresumableAttempt,
  releaseLapsedRevision,
  resumeAutomaticallySafely,
  settleFailedJob,
} from '@/lib/services/planSessionEndService';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import {
  isReopenedByRevision,
  revisionLeaseOf,
  REVISION_ENDED_KIND,
  REVISION_STARTED_KIND,
} from '@/lib/planChange/revisionLease';
import { cancelJob, getJob } from '@/lib/ai/motirAiClient';
import { failureRecordFrom, type JobWalkStop } from '@/lib/planChange/failureRecord';
import {
  FAILURE_DETAIL_MAX,
  autoResumeCauseOf,
  sessionWaitingState,
  type PlanSessionFailureRecord,
  type SessionWaitingRow,
  type SessionWaitingState,
} from '@/lib/planChange/sessionWaitingState';
import type { PlanJobStateDto } from '@/lib/dto/plans';
import type { AutoResumeOutcome } from '@/lib/services/planSessionResumeService';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';

// ABANDONED-PLAN reconciliation (MOTIR-3064) — the recovery half of the
// generation lifecycle, and the answer to a hole MOTIR-3051 named and left open
// on purpose.
//
// THE DEFECT. Nothing writes a terminal `Plan` status when a motir-ai job dies:
// motir-ai's inbound seams into core are the success path (`appendProposals` /
// `patchProposal`), so a job that fails, is canceled, or whose process vanishes
// changes nothing about the plan it was producing into. That plan sits at
// `generating` — and `planRepository.findUndecidedByProject` reads `generating`
// as UNDECIDED, which is the pending-proposal gate `autoPlanCadenceService`
// checks FIRST. So a dead job silently paused that project's auto-plan cadence
// permanently, with the AI-planning settings page reporting a proposal waiting
// for a decision nobody could make.
//
// WHY IT IS A SWEEP AND NOT A CALLBACK. The card offered two shapes, and only one
// of them exists. Writing the terminal status "on job failure" needs a failure
// callback, and there is none: core learns a job's outcome by ASKING
// (`resolveJobState` → `GET /v1/jobs/:id`) or by holding an SSE stream open.
// Adding an inbound failure route would still not cover the case that matters
// most — a motir-ai process that dies mid-job writes no callback at all
// (`src/jobs/worker.ts` marks `failed` only when the HANDLER throws; a claimed
// job whose worker vanishes stays `running`). A sweep that asks covers both, so
// it is the whole fix rather than half of one.
//
// WHY IT CANNOT BE A WIDER GATE PREDICATE — the thing MOTIR-3051 could do and
// this cannot. That card excluded the orphan with NO producer, which is judgeable
// from the row itself. This orphan carries a `sourceJobId`, so it is byte-for-byte
// what a healthy generation looks like between `createPlan` and its first append.
// The discriminator is not in the plan table; it is whether the job behind it is
// still alive. `docs/decisions/agent-authored-plans.md` AMENDMENT 2 records the
// decision and the rejected alternatives.
//
// ⚠️ IT IS NO LONGER EMPTY-ONLY (MOTIR-3189, AMENDMENT 6). AMENDMENT 2 left
// PARTIAL plans alone on the ground that one is *"a real proposal a person can
// read and decline"*. Read, yes — decline, no: `declinePlan` and `approvePlan`
// each re-read under their row lock and refused anything but `planned`, so there
// was no path out of `generating` for anyone, and every partial plan was
// stranded exactly as permanently as the empty ones this sweep was written for.
// The valve exists now (`declinePlan` accepts `generating` and records
// `discarded`), and this sweep takes the partial plans nobody is coming back to.
// Nothing else about the decision table moved: the three KEEP arms terminate
// nothing, the 15-minute grace still holds the sweep out of the
// submit→first-append window, and a partial plan behind a LIVE job is left
// alone by `job_in_flight` exactly as an empty one is.
//
// ⚠️ AND THE SELECTION HAS MOVED OUT OF SQL (MOTIR-3236, AMENDMENT 7). The
// paragraph above says a wider GATE predicate cannot work, and that is still
// true of `findUndecidedByProject`. What changed is this sweep's DISCOVERY
// predicate, which used to carry `sourceJobId: { not: null }` and so could never
// see an MCP-authored plan at all — one has no generation job by construction
// (`create_plan`, MOTIR-2982), so the two sets were disjoint and the hourly pass
// ran past those rows for ever. AMENDMENT 4 named that debt and declined to pay
// it; this is where it is paid.
//
// The fix is a RE-SHAPE, not a fourth widening. The predicate had become a
// whitelist of the plan shapes the sweep knew how to judge, so every newly
// recognised shape cost a query change (MOTIR-3051, MOTIR-3064, MOTIR-3189,
// then this). Now the predicate selects every `generating` plan past the grace
// and `classifyAbandonedCandidate` DECIDES — `sourceJobId` is an input to the
// table, not a condition of selection. The next unrecognised shape is a new arm
// in a pure function with a unit test.
//
// The new arm was `no_producer` (both it and `max_age` are retired below): nothing to ask, so the only signal is the
// passage of time — which is precisely the argument `max_age` already makes for
// a crashed worker, and it reused that arm's 24-hour max age rather than
// inventing a second threshold. Under the max age it is `no_producer_recent`
// and kept, because an author mid-skeleton looks exactly like one who stopped.
// `docs/decisions/agent-authored-plans.md` AMENDMENT 7 records it, including
// the sentence in AMENDMENT 6 it supersedes.
//
// System-scoped: the discovery read spans workspaces (the plan policy's
// `FOR SELECT` `app.system_admin` arm, added by this card's migration for exactly
// this), and every WRITE then re-binds `app.workspace_id` to that row's own
// workspace — so no write is ever untenanted and the cross-tenant write refusal
// stays load-bearing.

// ⚠️ AND THE CLOCK IS SILENCE, NOT AGE (MOTIR-8132; MOTIR-8130's decision). The
// two paragraphs above judged a plan by `now - createdAt` against a 15-minute grace
// and a 24-hour max age, while the rail judged the same plan by
// `now - lastActivityAt > PLAN_STALLED_AFTER_MS` — so the two disagreed for up to a
// day, and a plan the rail called stalled at minute 16 sat `generating` until the
// next morning. Now there is ONE threshold and ONE fact: a `generating` plan is dead
// when it has been SILENT past `PLAN_STALLED_AFTER_MS`, whoever writes it, job or no
// job. The motir-ai ask survives only as a FAST PATH — a job that already failed,
// was canceled, finished without closing the plan, or is gone, is dead at once —
// and no longer keeps a plan alive: `running` / `queued` and an unreachable
// motir-ai fall through to the silence rule. And dead is RECORDED on the plan's
// `conversation` / `mcp` session rather than declined, so the plan keeps its
// proposals and its held cards, waits in To resume, and the producer's next write
// clears the record (`plansService`'s activity stamp). Origins with no To resume
// entry keep the decline. `docs/decisions/agent-authored-plans.md` AMENDMENT 7 is
// amended accordingly.

// ⚠️ AND A JOB MOTIR-AI REPORTS `running` KEEPS ITS PLAN AGAIN (MOTIR-11258;
// `docs/decisions/agent-authored-plans.md` AMENDMENT 30). The paragraph above let
// `running` fall through to the silence rule on the ground that a worker that died
// mid-job leaves its row `running` for good. That stopped being true with MOTIR-8303:
// READING a job in motir-ai reaps it when its lease has lapsed (`getJobView` runs
// `reapAbandonedJob`; the lease is `LEASE_TTL_SECONDS` = 120 s, renewed by the live
// worker), so the sweep's own `resolveJobState` reads a dead worker's job `failed`
// and the fast path ends it as `job_terminal`. A `running` answer therefore means a
// worker renewed the lease in the last two minutes — the producer is ALIVE, however
// long its plan has been quiet. And plan silence is not job death: one step can run
// past `PLAN_STALLED_AFTER_MS` without writing (a final check's review sessions; a
// 17-minute lay, MOTIR-11184), and judging that silence dead cancelled a live job
// mid-check and declined its plan. So the silence rule now judges only the plans the
// sweep CANNOT ask: motir-ai unreachable, or no job (`sourceJobId` null). The rail's
// `stalled` is a separate reading of the same threshold and can now disagree with
// the sweep, deliberately: a quiet plan behind a live job reads stalled on the rail
// and is kept here.

/**
 * How long the REVISION backstop lets a revision's job stay non-terminal before it
 * fails the revision anyway (MOTIR-7936) — the crashed-worker window for a lease, and
 * the one place a day-long window survives: MOTIR-8130 changed how a `generating`
 * plan is judged and left the revision backstop as it was. A `generating` plan is
 * judged by `PLAN_STALLED_AFTER_MS` alone.
 */
export const REVISION_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Plans reconciled per pass — bounded, so a backlog drains over successive
 *  ticks rather than holding one long pass over a large slice of the table. */
export const ABANDONED_PLAN_SWEEP_BATCH_SIZE = 50;

/** Why a candidate was terminated. Every one of these means the producer is not
 *  coming back; they differ only in how we found out. */
export type AbandonReason =
  /** The job reached a terminal state — the reported case (`failed`), plus the
   *  two that are equally final (`canceled`, and a `succeeded` job that
   *  nonetheless never marked the plan `planned` — whether it appended nothing
   *  or stopped part-way). The FAST PATH: dead at once, however recent the
   *  plan's last write. */
  | 'job_terminal'
  /** motir-ai has no such job (404). The producer is gone, not merely quiet —
   *  the fast path's other arm. */
  | 'job_gone'
  /** The plan has written nothing for longer than `PLAN_STALLED_AFTER_MS`
   *  (MOTIR-8132), and nobody could say its producer is alive. It replaces
   *  `max_age` (a job that never answered for a day) and `no_producer` (a job-less
   *  plan a day old). Since MOTIR-11258 only an unreachable motir-ai and no job at
   *  all are judged by it — a job motir-ai reports `running` is kept
   *  (`job_running`). */
  | 'silent'
  /** A REVISION's job never reached a terminal state within
   *  {@link REVISION_JOB_MAX_AGE_MS} — the revision backstop's crashed-worker arm
   *  (MOTIR-7936). Never a `generating` plan's verdict. */
  | 'max_age'
  /** A revision that RE-OPENED its plan wrote nothing for the whole lease window,
   *  and nobody could be asked about it — an MCP-driven revision has no job (Bug
   *  MOTIR-8208). The window is the lease's own verdict, so the plan is given
   *  back to `planned` as it stands. */
  | 'lease_lapsed';

/** Why a candidate was left alone. */
export type KeepReason =
  /** The plan wrote inside `PLAN_STALLED_AFTER_MS` and no fast-path answer says
   *  its producer is gone (MOTIR-8132) — it is being written. Replaces
   *  `job_in_flight` and `no_producer_recent` for a `generating` plan. Since
   *  MOTIR-11258 it is the verdict only for a plan whose job could not be asked
   *  (unreachable, or none): a reachable `running` job reads `job_running`. */
  | 'writing'
  /** motir-ai reports the plan's job `running` (MOTIR-11258) — the producer is
   *  ALIVE, however long the plan has been quiet. The read that answered reaps a
   *  lapsed lease first (MOTIR-8303), so `running` means a worker renewed the lease
   *  within `LEASE_TTL_SECONDS`; a worker that died reads `failed`, and the fast
   *  path takes it as `job_terminal` on the next pass. */
  | 'job_running'
  /** motir-ai reports the plan's job `queued` — it has not started, so the plan's
   *  silence says nothing about its producer (MOTIR-9065). A job that never leaves
   *  the queue is motir-ai's to fail (MOTIR-9064), and the fast path takes it then. */
  | 'job_queued'
  /** A REVISION's job is `queued` / `running` inside {@link REVISION_JOB_MAX_AGE_MS}
   *  (MOTIR-7936). Never a `generating` plan's verdict. */
  | 'job_in_flight'
  /** motir-ai could not be reached about a REVISION's job, and the next tick asks
   *  again (MOTIR-7936). For a `generating` plan unreachable is no longer a keep:
   *  it falls through to the silence rule. */
  | 'ai_unreachable'
  /** The row changed under us between discovery and the write — proposals
   *  arrived, the plan wrote again, or somebody decided it. */
  | 'row_moved'
  /** The plan's session is WAITING — failed and waiting to resume, or awaiting its
   *  person — so the plan is not abandoned: a person is coming back to it
   *  (MOTIR-7912; AMENDMENT 23's 2026-10-09 sub-amendment). */
  | 'session_waiting'
  /** A revision holds the plan right now (Bug MOTIR-8208) — the plan is
   *  `generating` because a revision re-opened it, and the lease says the
   *  revision is still writing. Not abandoned; the revision closes it. */
  | 'revision_held';

/** What became of the cancel the sweep sends when it gives up on a job it judged by
 *  silence (MOTIR-9065): sent and answered, or the reason it could not be. */
export type JobCancelOutcome = { cancelled: true } | { cancelled: false; why: string };

export type AbandonedPlanOutcome =
  | {
      planId: string;
      projectId: string;
      outcome: 'declined';
      reason: AbandonReason;
      /** Present only when a `silent` verdict gave up on a job (MOTIR-9065). */
      jobCancel?: JobCancelOutcome;
    }
  /** A failure nobody watched, RECORDED on the open session — the plan stays
   *  `generating` and the session waits in To resume (MOTIR-7912). */
  | {
      planId: string;
      projectId: string;
      outcome: 'awaiting_resume';
      reason: AbandonReason;
      /** `true` only when the plan has a job, that job was read, and motir-ai reports it
       *  lost its machine (MOTIR-8304). Silence alone reads `false`: as motir-ai sees
       *  it, that job is still running. */
      lostMachine: boolean;
      /** The automatic resume the recording started or skipped (MOTIR-8307) — attempted only
       *  when the job read said lost machine; `null` otherwise. */
      autoResume: AutoResumeOutcome | null;
      /** Present only when a `silent` verdict gave up on a job (MOTIR-9065). */
      jobCancel?: JobCancelOutcome;
    }
  | { planId: string; projectId: string; outcome: 'left_as_is'; reason: KeepReason }
  /** A revision whose job died and whose failure no relay saw: its lease is given back and
   *  the failure recorded on the plan's session (MOTIR-7936). */
  | { planId: string; projectId: string; outcome: 'revision_failed'; reason: AbandonReason }
  /** A revision whose job ended without a failure (canceled, or finished without closing
   *  its lease): the lease is given back, nothing recorded (MOTIR-7936). */
  | { planId: string; projectId: string; outcome: 'revision_released'; reason: AbandonReason };

export interface AbandonedPlanSweepSummary {
  /** Candidate plans examined this pass. */
  scanned: number;
  /** Candidates moved to `declined`. */
  declined: number;
  outcomes: AbandonedPlanOutcome[];
}

/** The job resolver, behind a seam so a unit test can drive the decision table
 *  without a live motir-ai. Production uses the shipped one. */
export interface AbandonedPlanDeps {
  resolveJobState: typeof resolveJobState;
  /** The session end (MOTIR-7638), behind the same seam so a test can prove a
   *  failed end leaves the sweep running. Absent means the shipped one. */
  endSessionForAbandonedPlan?: typeof endSessionForAbandonedPlan;
  /** Where the failed job's walk stopped (MOTIR-7912) and whether it lost its machine
   *  (MOTIR-8304), behind the same seam as {@link resolveJobState}. Absent means a
   *  `getJob` read that tolerates failure. */
  getFailedJobFacts?: (
    jobId: string,
    coreProjectId: string,
  ) => Promise<{ walkStop: JobWalkStop | null; lostMachine: boolean; resumable?: boolean | null }>;
  /** The cancel sent to motir-ai for a job the sweep gave up on (MOTIR-9065), behind
   *  the same seam. Absent means the shipped {@link cancelJob}. */
  cancelJob?: (jobId: string, coreProjectId: string) => Promise<unknown>;
}

const defaultDeps: AbandonedPlanDeps = {
  resolveJobState: (jobId, coreProjectId) => resolveJobState(jobId, coreProjectId),
};

/** motir-ai's terminal job states. A job in ANY of them is done talking — the
 *  plan it was producing into will never be finished, whichever way it ended and
 *  however much of it the job managed to append first. */
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

/** The FAST PATH: whether what motir-ai said about a job already proves its producer
 *  is gone, before any clock is read. `dead: false` proves nothing either way. */
function jobFastPath(
  job: PlanJobStateDto,
): { dead: true; reason: 'job_terminal' | 'job_gone' } | { dead: false } {
  // A 404 is the one unreachable-shaped answer that IS evidence: motir-ai
  // answered, and its answer was that no such job exists.
  if (!job.reachable) {
    return job.failure?.code === 'MOTIR_AI_JOB_NOT_FOUND'
      ? { dead: true, reason: 'job_gone' }
      : { dead: false };
  }
  if (job.status && TERMINAL_JOB_STATUSES.has(job.status)) {
    return { dead: true, reason: 'job_terminal' };
  }
  return { dead: false };
}

/**
 * The DECISION TABLE for a `generating` plan, pure and separated from the I/O so it
 * can be read as one thing (MOTIR-8132): given what the job said, if anything, and
 * how long the plan has been SILENT (`now - lastActivityAt`), is its producer coming
 * back?
 *
 *   * a job that is `failed` / `canceled` / `succeeded` (the plan is still
 *     `generating`, so a success never closed it) → dead at once, `job_terminal`;
 *   * a job motir-ai says does not exist (404) → dead at once, `job_gone`;
 *   * a job motir-ai reports `queued` → kept, `job_queued`: it has not started, so
 *     silence proves nothing (MOTIR-9065);
 *   * a job motir-ai reports `running` → kept, `job_running`, at any silence: the
 *     read reaps a lapsed lease first (MOTIR-8303), so `running` is a live worker,
 *     and a quiet plan behind it is a long step, not a dead one (MOTIR-11258);
 *   * motir-ai unreachable, or no job to ask (`sourceJobId` null) → the silence
 *     rule: dead (`silent`) when `silentMs > PLAN_STALLED_AFTER_MS`, otherwise kept
 *     (`writing`). Without an answer the sweep cannot tell live from dead, so the
 *     plan's own writes are the only evidence left.
 *
 * The silence rule is `readPlanProgress`'s comparison exactly — equal is not
 * stalled, one millisecond more is. It is no longer the only reading: the rail
 * shows a quiet plan behind a live job as stalled, and the sweep keeps it, because
 * the sweep also asks the job and the rail does not.
 */
export function classifyAbandonedCandidate(
  job: PlanJobStateDto | null,
  silentMs: number,
): { abandoned: true; reason: AbandonReason } | { abandoned: false; reason: KeepReason } {
  if (job) {
    const fast = jobFastPath(job);
    if (fast.dead) return { abandoned: true, reason: fast.reason };
    // A QUEUED job has not started (MOTIR-9065): the plan is silent because nothing
    // has run yet, not because its producer died. Recording it failed told a person
    // the session had stopped while the job waited for a planning machine — and the
    // job then started later against a session that no longer expected it.
    if (job.reachable && job.status === 'queued') {
      return { abandoned: false, reason: 'job_queued' };
    }
    // A RUNNING job is alive (MOTIR-11258): motir-ai's read reaps a lapsed lease before
    // it answers (MOTIR-8303), so a worker that died reads `failed` and the fast path
    // above already took it. The plan's silence here is one long step — a final
    // check's review sessions write nothing for longer than the threshold — and
    // cancelling the job threw the whole check away.
    if (job.reachable && job.status === 'running') {
      return { abandoned: false, reason: 'job_running' };
    }
  }
  if (silentMs > PLAN_STALLED_AFTER_MS) return { abandoned: true, reason: 'silent' };
  return { abandoned: false, reason: 'writing' };
}

/**
 * What the sweep does with a dead candidate that is the LATEST plan of an open
 * `conversation` or `mcp` session — the sessions To resume lists — a second pure
 * table, composed AFTER {@link classifyAbandonedCandidate} (MOTIR-7912; widened to
 * every verdict and both origins by MOTIR-8132):
 *
 *   * the session is waiting (failed, or awaiting its person) → `keep`;
 *   * otherwise the producer is gone, however we found out → `record` the failure on
 *     the session: the plan is not declined and the session is not ended, so the
 *     producer's next write picks the plan up where it stopped.
 */
export function classifySessionCandidate(
  waiting: SessionWaitingState,
  verdict: { abandoned: true; reason: AbandonReason },
): { action: 'keep'; reason: 'session_waiting' } | { action: 'record'; reason: AbandonReason } {
  if (waiting === 'failed' || waiting === 'awaiting_person') {
    return { action: 'keep', reason: 'session_waiting' };
  }
  return { action: 'record', reason: verdict.reason };
}

/** The session origins whose failed-waiting sessions To resume lists, so a failure
 *  recorded on one is seen by somebody (MOTIR-8132). Every other origin — a
 *  `generation`, `expand` or `cadence` session — keeps the decline: a failure nobody
 *  can see would hold a cadence plan's project paused for ever (MOTIR-3064). */
export const RECORDABLE_SESSION_ORIGINS: ReadonlySet<string> = new Set(['conversation', 'mcp']);

/**
 * The decision table for a REVISION whose lease was never closed (MOTIR-7936), pure: given
 * what the revision's job says and how long the lease has been open, what became of it?
 * MOTIR-8132 left it as it was: the fast path first; then a lease older than
 * {@link REVISION_JOB_MAX_AGE_MS} fails it, and a `queued` / `running` job or an
 * unreachable motir-ai keeps it. The one distinction a revision needs — a `failed` (or
 * vanished, or aged-out) job is a failure to record; a `canceled` or `succeeded` one only
 * owes its lease back.
 */
export function classifyRevisionCandidate(
  job: PlanJobStateDto,
  ageMs: number,
):
  | { action: 'fail'; reason: AbandonReason }
  | { action: 'release'; reason: AbandonReason }
  | { action: 'keep'; reason: KeepReason } {
  const fast = jobFastPath(job);
  if (fast.dead) {
    if (fast.reason === 'job_terminal' && job.status !== 'failed') {
      return { action: 'release', reason: fast.reason };
    }
    return { action: 'fail', reason: fast.reason };
  }
  if (!job.reachable) return { action: 'keep', reason: 'ai_unreachable' };
  if (ageMs >= REVISION_JOB_MAX_AGE_MS) return { action: 'fail', reason: 'max_age' };
  return { action: 'keep', reason: 'job_in_flight' };
}

/** Whether a sweep candidate is `generating` because a revision re-opened it (MOTIR-8208). */
async function reopenedByRevision(plan: {
  id: string;
  workspaceId: string;
  status: string;
}): Promise<boolean> {
  if (plan.status !== 'generating') return false;
  return withWorkspaceServiceContext(plan.workspaceId, async (tx) =>
    isReopenedByRevision(plan, await planRevisionRepository.listByPlan(plan.id, tx)),
  );
}

/** The job the OPEN revision was started by, when it names one — the latest
 *  `revision_started` with no `revision_ended` after it. */
function openRevisionJobId(
  trail: readonly { changeKind: string; diff?: unknown }[],
): string | null {
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const row = trail[i]!;
    if (row.changeKind === REVISION_ENDED_KIND) return null;
    if (row.changeKind !== REVISION_STARTED_KIND) continue;
    const jobId = (row.diff as { jobId?: unknown } | null)?.jobId;
    return typeof jobId === 'string' ? jobId : null;
  }
  return null;
}

/** The one `getJob` read the sweep makes for a failed job; any throw reads as nothing known. */
async function readFailedJobFacts(
  jobId: string,
  coreProjectId: string,
): Promise<{ walkStop: JobWalkStop | null; lostMachine: boolean; resumable?: boolean | null }> {
  try {
    const view = await getJob(jobId, coreProjectId);
    return {
      walkStop: view.walkStop ?? null,
      lostMachine: view.lostMachine ?? false,
      resumable: view.resumable ?? null,
    };
  } catch {
    return { walkStop: null, lostMachine: false };
  }
}

/** The open `conversation` / `mcp` session a candidate is the LATEST plan of — the session arm's
 *  subject (MOTIR-7912) — or null when there is none. */
async function findRecordableSession(plan: {
  id: string;
  workspaceId: string;
  sessionId: string | null;
}) {
  if (!plan.sessionId) return null;
  return withWorkspaceServiceContext(plan.workspaceId, async (tx) => {
    const row = await planChangeSessionRepository.findById(plan.sessionId!, plan.workspaceId, tx);
    if (!row || row.endedAt || !RECORDABLE_SESSION_ORIGINS.has(row.origin)) return null;
    const latest = await planRepository.findLatestIdBySession(row.id, tx);
    return latest === plan.id ? row : null;
  });
}

/**
 * The record for a `silent` verdict (MOTIR-9065): the reason is the sweep's own,
 * `stalled`, and the detail says what the sweep knew about the job — never the job
 * read's error mapped to a reason. An unreachable read is not evidence about the
 * model provider, and recording it as `model_unavailable` sent a person to wait on a
 * healthy one. Pure; the stop point and everything else in `record` stand.
 */
export function silentFailureRecord(
  record: PlanSessionFailureRecord,
  job: PlanJobStateDto | null,
  silentMs: number,
): PlanSessionFailureRecord {
  const minutes = Math.floor(silentMs / 60_000);
  const silence = `The plan wrote nothing for ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const detail = !job
    ? `${silence}.`
    : !job.reachable
      ? `${silence}, and its job could not be read: ${job.failure?.message ?? job.failure?.code ?? 'motir-ai did not answer'}.`
      : `${silence}, while motir-ai reported its job ${job.status ?? 'in an unknown state'}.`;
  return {
    ...record,
    failureReason: 'stalled',
    failureDetail: detail.slice(0, FAILURE_DETAIL_MAX),
  };
}

/** Cancel the job the sweep gave up on (MOTIR-9065), so a job still waiting in motir-ai
 *  cannot start against a session already recorded failed. Never throws: a cancel that
 *  could not be made is reported, with why, in the outcome and the log. */
async function cancelAbandonedJob(
  deps: AbandonedPlanDeps,
  jobId: string,
  plan: { id: string; projectId: string },
): Promise<JobCancelOutcome> {
  try {
    await (deps.cancelJob ?? cancelJob)(jobId, plan.projectId);
    return { cancelled: true };
  } catch (err) {
    const why = err instanceof Error ? err.message || err.name : String(err);
    console.warn(
      `[abandoned-plan-sweep] could not cancel job ${jobId} of plan ${plan.id} in motir-ai — ${why}`,
    );
    return { cancelled: false, why };
  }
}

/**
 * Whether the session ALREADY holds the answer the job ask would bring, so the ask is
 * pointless (MOTIR-8407). A session awaiting its person is kept whatever the job says, and
 * a failed-waiting one whose recorded failure is for THIS plan's job is kept whatever the
 * job says — the job cannot become less dead. A failure recorded for another job, or none,
 * still asks. The outcome is the one {@link classifySessionCandidate} would reach.
 */
export function sessionAlreadyAnswers(
  session: SessionWaitingRow & { failedJobId: string | null },
  sourceJobId: string | null,
): boolean {
  const state = sessionWaitingState(session);
  if (state === 'awaiting_person') return true;
  return state === 'failed' && sourceJobId !== null && session.failedJobId === sourceJobId;
}

export const abandonedPlanService = {
  /**
   * One reconciliation pass: read every `generating` plan, stalest first, ask
   * motir-ai about the ones with a job, and settle the ones whose producer is not
   * coming back — a plan whose job already ended (MOTIR-8132), or one silent past
   * `PLAN_STALLED_AFTER_MS` that nobody could vouch for: a job motir-ai reports
   * `running` or `queued` keeps its plan however quiet it is (MOTIR-11258). Empty or PARTIAL alike since MOTIR-3189. The latest plan of
   * an open `conversation` / `mcp` session is RECORDED as failed on that session
   * and stays `generating`; every other plan is DECLINED, as below.
   *
   * WHY `declined` AND NOT A NEW `failed` STATE — the decision this card was
   * asked to make, recorded in full in AMENDMENT 2 and in one line here because
   * this is where a reader meets it. `PlanStatus` is a PUBLIC vocabulary: the v1
   * work-loop `planStatusSchema`, the MCP tool descriptions, `PlanStatusDto` and
   * four display switches plus the i18n catalogue and its zh-parity gate. A new
   * member is a product decision about what people are shown, larger than this
   * defect and owed its own card — and nothing downstream would branch on it,
   * because every consumer of this row is asking "is it decided?", which
   * `declined` answers. The honesty lives in the ACTOR: `decidedById` is NULL,
   * which on this very table already means *nobody* (`Plan.createdById` is null ⟺
   * nobody asked, the cadence case, documented in the schema). The failure itself
   * is not lost — `sourceJobId` still points at the job, whose state and error
   * stay readable through {@link resolveJobState}, and each outcome is logged.
   *
   * ⚠️ AND SINCE MOTIR-3189 IT IS ALSO RECORDED, not merely derivable: the write
   * sets `decisionReason: 'abandoned'`. That paragraph's fallback — the null
   * decider — was doing the work of a column, and `declined` covers three
   * different histories (a person rejected a finished plan; a person discarded
   * one mid-generation; this sweep terminated a dead producer) that the review
   * surface rendered identically. `PlanStatus` is still not the place to say so,
   * for every reason above; a PRIVATE column is.
   *
   * PLANNING-TARGET LOCKS are released by ENDING THE SESSION (AMENDMENT 23 §2;
   * MOTIR-7638): the one end operation gives back what the attempt's session
   * held, signed by its starter, so this sweep no longer leaves the cards to the
   * lease. A plan with no session still leaves its locks to the lock sweep.
   */
  async reconcileAbandoned(
    opts: { now?: Date; batchSize?: number; deps?: AbandonedPlanDeps } = {},
  ): Promise<AbandonedPlanSweepSummary> {
    const now = opts.now ?? new Date();
    const batchSize = opts.batchSize ?? ABANDONED_PLAN_SWEEP_BATCH_SIZE;
    const deps = opts.deps ?? defaultDeps;
    const candidates = await withSystemContext((tx) =>
      planRepository.listAbandonedCandidates(batchSize, tx),
    );
    const outcomes: AbandonedPlanOutcome[] = [];
    for (const plan of candidates) {
      // ⚠️ A PLAN A REVISION RE-OPENED IS NOT A GENERATION (Bug MOTIR-8208). It is
      // `generating` while the revision writes it — judged here, a live revision
      // would be declined as abandoned. The revision backstop below owns it, and gives
      // it back to `planned` when its revision dies.
      if (await reopenedByRevision(plan)) continue;
      // ASK only when there is somebody to ask (MOTIR-3236). A candidate with no
      // `sourceJobId` gets NO `resolveJobState` call: asking motir-ai about a job
      // id that does not exist is a request that can only 404, and a 404 already
      // MEANS something else here — `job_gone`, the producer that existed and is
      // now provably dead. Sending one would launder "there was never a job" into
      // "the job died", on every pass, for every MCP-authored plan.
      //
      // When there IS one, the ask happens outside any transaction: it is a
      // network call to motir-ai, and a slow one must never be holding a row. It is
      // asked even inside the silence threshold, because the fast path is the whole
      // reason to ask (MOTIR-8132).
      //
      // EXCEPT where the plan's session already holds the answer (MOTIR-8407). A plan waiting
      // in To resume stays `generating` for ever by design, and asking motir-ai about its
      // dead job on every 5-minute pass is a request that resets motir-ai's 300 s idle clock
      // each time, so a planning machine never suspends.
      const waitingSession = await findRecordableSession(plan);
      if (waitingSession && sessionAlreadyAnswers(waitingSession, plan.sourceJobId)) {
        outcomes.push({
          planId: plan.id,
          projectId: plan.projectId,
          outcome: 'left_as_is',
          reason: 'session_waiting',
        });
        continue;
      }
      const job = plan.sourceJobId
        ? await deps.resolveJobState(plan.sourceJobId, plan.projectId)
        : null;
      // SILENCE, from the one fact every write stamps (MOTIR-8132). Never null — the
      // column defaults to the plan's creation — so a plan that never wrote reads
      // silent from its `createdAt`, which is what the old grace did.
      const silentMs = now.getTime() - plan.lastActivityAt.getTime();
      const verdict = classifyAbandonedCandidate(job, silentMs);
      // The job the sweep is GIVING UP ON (MOTIR-9065): one judged by silence, so as far
      // as motir-ai knows it may still run. A job the fast path found ended has nothing
      // left to cancel. Since MOTIR-11258 a silent verdict with a job means motir-ai
      // could not be read: a job it reports `running` is kept, never cancelled.
      const giveUpJobId =
        verdict.abandoned && verdict.reason === 'silent' ? plan.sourceJobId : null;

      if (!verdict.abandoned) {
        outcomes.push({
          planId: plan.id,
          projectId: plan.projectId,
          outcome: 'left_as_is',
          reason: verdict.reason,
        });
        continue;
      }

      // THE SESSION ARM (MOTIR-7912; widened by MOTIR-8132). A plan that is the
      // LATEST of an open `conversation` or `mcp` session — the two To resume lists —
      // is judged by the second table: a waiting session is spared, and a dead
      // producer is RECORDED on it rather than the plan being declined. Every other
      // plan falls through to the decline.
      const session = await findRecordableSession(plan);
      if (session) {
        const decision = classifySessionCandidate(sessionWaitingState(session), verdict);
        if (decision.action === 'keep') {
          outcomes.push({
            planId: plan.id,
            projectId: plan.projectId,
            outcome: 'left_as_is',
            reason: decision.reason,
          });
          continue;
        }
        // A walk stop that cannot be read is no stop point, never a failed sweep. A
        // plan with no job has none to read: it is recorded with `failedJobId: null`,
        // `internal` and no stop point (MOTIR-8130 §3), which To resume lists and
        // Resume does not offer — its producer resumes by writing again.
        let facts: {
          walkStop: JobWalkStop | null;
          lostMachine: boolean;
          resumable?: boolean | null;
        } = {
          walkStop: null,
          lostMachine: false,
        };
        if (plan.sourceJobId) {
          try {
            facts = await (deps.getFailedJobFacts ?? readFailedJobFacts)(
              plan.sourceJobId,
              plan.projectId,
            );
          } catch {
            facts = { walkStop: null, lostMachine: false };
          }
        }
        const { walkStop } = facts;
        const fromJob = failureRecordFrom({
          failedJobId: plan.sourceJobId,
          now,
          walkStop,
          lastPosition: null,
          error: job?.failure ?? null,
          // A job that has not ended (judged by silence) has no verdict yet: unknown, not `false`.
          resumable: facts.resumable ?? null,
        });
        // A job that ENDED tells its own story; a plan judged by SILENCE is recorded as
        // the sweep's verdict, whatever the job read said (MOTIR-9065).
        const record =
          verdict.reason === 'silent' ? silentFailureRecord(fromJob, job, silentMs) : fromJob;
        // GUARDED on the silence it was judged by: a write that landed since the
        // candidate was read moved `lastActivityAt`, and that producer is alive.
        const recorded = await withWorkspaceServiceContext(plan.workspaceId, (tx) =>
          recordFailureWithin(tx, session.id, plan.workspaceId, record, {
            onlyPlanId: plan.id,
            lastActivityAt: plan.lastActivityAt,
          }),
        );
        if (recorded === 'recorded') {
          console.warn(
            `[abandoned-plan-sweep] plan ${plan.id} (project ${plan.projectId}) recorded as failed on session ${session.id} — ${decision.reason}; ${plan._count.items} proposal(s) retained`,
          );
        }
        // NOTHING TO RESUME (MOTIR-9121): motir-ai said the job failed before its conversation
        // settled, so its cards are given back now rather than held for a Resume it will refuse.
        const unresumable = recorded === 'recorded' && record.failureResumable === false;
        if (unresumable) await releaseUnresumableAttempt(session.id, plan.workspaceId);
        const jobCancel =
          recorded === 'recorded' && giveUpJobId
            ? await cancelAbandonedJob(deps, giveUpJobId, plan)
            : null;
        // A LOST MACHINE is resumed by core itself (MOTIR-8307), and so, once per session, is
        // an UNAVAILABLE PROVIDER (MOTIR-10968); every other recording waits. A plan judged by
        // silence is recorded `stalled`, so only a job that ended tells the provider cause.
        const cause =
          recorded === 'recorded'
            ? autoResumeCauseOf({ lostMachine: facts.lostMachine, ...record })
            : null;
        const autoResume = cause
          ? await resumeAutomaticallySafely({
              sessionId: session.id,
              workspaceId: plan.workspaceId,
              projectId: plan.projectId,
              cause,
            })
          : null;
        if (autoResume?.started) {
          console.warn(
            `[abandoned-plan-sweep] plan ${plan.id} resumed automatically on session ${session.id} — job ${autoResume.jobId} (${autoResume.count})`,
          );
        }
        outcomes.push(
          recorded === 'recorded'
            ? {
                planId: plan.id,
                projectId: plan.projectId,
                outcome: 'awaiting_resume',
                reason: decision.reason,
                lostMachine: facts.lostMachine,
                autoResume,
                ...(jobCancel ? { jobCancel } : {}),
              }
            : {
                planId: plan.id,
                projectId: plan.projectId,
                outcome: 'left_as_is',
                reason: 'row_moved',
              },
        );
        continue;
      }

      const written = await withWorkspaceServiceContext(plan.workspaceId, async (tx) => {
        // RE-READ under the transaction that will act. The candidate came out of
        // a different transaction's snapshot and the network call above took real
        // time, so a human decision could have landed since.
        const fresh = await planRepository.findById(plan.id, plan.workspaceId, tx);
        if (!fresh || fresh.status !== 'generating') return false;
        // A revision that re-opened the plan since discovery owns it now (MOTIR-8208).
        if (isReopenedByRevision(fresh, await planRevisionRepository.listByPlan(plan.id, tx))) {
          return false;
        }
        // A WRITE since discovery means the producer is alive (MOTIR-8132) — the same
        // guard the recording arm takes, and the one that also sees a step signal,
        // which writes no proposal.
        if (fresh.lastActivityAt.getTime() !== plan.lastActivityAt.getTime()) return false;
        // AND RE-COUNT, comparing against what discovery saw (MOTIR-3189). This
        // used to read `items > 0`, which was correct only while the predicate
        // guaranteed zero; a partial plan is now a legitimate candidate, so the
        // question is no longer "does it hold anything" but "did it MOVE". A
        // proposal that arrived during the ask means the producer was alive after
        // the job said otherwise — leave it, exactly as before. It is also what
        // makes an RLS blind spot in the cross-workspace discovery scan fail
        // SAFE: a hidden proposal reads the count low there and this re-count,
        // bound to the plan's own workspace, disagrees.
        const items = await tx.planItem.count({ where: { planId: plan.id } });
        if (items !== plan._count.items) return false;
        await planRepository.update(
          plan.id,
          // No `decidedById`: nobody decided this. See the method doc. The
          // `decisionReason` is what says so on the row rather than leaving it to
          // be inferred from which timestamps are null.
          { status: 'declined', decidedAt: now, decisionReason: 'abandoned' },
          tx,
        );
        return true;
      });

      if (!written) {
        outcomes.push({
          planId: plan.id,
          projectId: plan.projectId,
          outcome: 'left_as_is',
          reason: 'row_moved',
        });
        continue;
      }

      // The attempt is over, so its SESSION ends `failed` too (AMENDMENT 23 §2;
      // MOTIR-7638) — the backstop for an attempt whose failure no relay saw. It
      // gives the session's cards back, and it is idempotent with the relay.
      // Best-effort: the plan's decline above is already committed, and the
      // lock sweep's lease still clears a hold this fails to release.
      await (deps.endSessionForAbandonedPlan ?? endSessionForAbandonedPlan)(plan).catch(
        (err: unknown) =>
          console.warn(`[abandoned-plan-sweep] ending the session of plan ${plan.id} failed`, err),
      );

      // `warn`, not `info`: the repo's lint allows only warn/error, and the level
      // is right anyway — a plan terminated with nobody's decision behind it is
      // the operator-visible record of a job that died, not routine chatter.
      // The producer half of the line tells the truth about which of the two
      // shapes this was: a job that was asked about and reported something, or a
      // plan that never had one. Printing `job null` and a job status for a
      // job-less plan would read as a failed lookup rather than an absent
      // producer, which is the distinction the sweep's no-ask path turns on.
      const jobCancel = giveUpJobId ? await cancelAbandonedJob(deps, giveUpJobId, plan) : null;
      const producer = job
        ? `job ${plan.sourceJobId}; job status ${job.status ?? 'unreachable'}${
            job.failure ? ` (${job.failure.code})` : ''
          }`
        : 'no producer (agent-authored — no generation job to ask about)';
      console.warn(
        `[abandoned-plan-sweep] plan ${plan.id} (project ${plan.projectId}) declined as abandoned — ${verdict.reason}; ${plan._count.items} proposal(s) retained; ${producer}`,
      );
      outcomes.push({
        planId: plan.id,
        projectId: plan.projectId,
        outcome: 'declined',
        reason: verdict.reason,
        ...(jobCancel ? { jobCancel } : {}),
      });
    }

    // THE REVISION BACKSTOP (MOTIR-7936): a `planned` / `stale` plan whose revision lease was
    // opened by a job that died unseen. The relay settles the ordinary case at once; this
    // gives the lease back — and records the failure — for the one nobody was watching.
    // Its discovery window is `PLAN_STALLED_AFTER_MS` — the same fifteen minutes the
    // retired generation grace gave it, so the backstop's candidates are unchanged.
    const stale = await withSystemContext((tx) =>
      planRepository.listStaleRevisionCandidates(
        new Date(now.getTime() - PLAN_STALLED_AFTER_MS),
        batchSize,
        tx,
      ),
    );
    for (const plan of stale) {
      // A `generating` plan is here only when a revision RE-OPENED it (Bug MOTIR-8208);
      // a generation with a revision lease over it is the main loop's, as before.
      const trail = await withWorkspaceServiceContext(plan.workspaceId, (tx) =>
        planRevisionRepository.listByPlan(plan.id, tx),
      );
      const reopened = isReopenedByRevision(plan, trail);
      if (plan.status === 'generating' && !reopened) continue;
      // WHO TO ASK. The plan's `sourceJobId` is the revision's job only when the open
      // revision says so — an MCP-driven revision (`hold_plan_revision`) has no job and
      // leaves `sourceJobId` naming the generation that wrote the plan, which says
      // nothing about whether the revision is alive. With no job of its own to ask, a
      // re-opened plan is judged by the lease's window alone.
      const revisionJobId = openRevisionJobId(trail);
      if (reopened && (!plan.sourceJobId || revisionJobId !== plan.sourceJobId)) {
        if (revisionLeaseOf(trail, now)) {
          outcomes.push({
            planId: plan.id,
            projectId: plan.projectId,
            outcome: 'left_as_is',
            reason: 'revision_held',
          });
          continue;
        }
        let released = false;
        try {
          released = await releaseLapsedRevision(plan.id, plan.workspaceId, now);
        } catch (err) {
          console.warn(
            `[abandoned-plan-sweep] releasing the lapsed revision of plan ${plan.id} failed`,
            err,
          );
        }
        outcomes.push(
          released
            ? {
                planId: plan.id,
                projectId: plan.projectId,
                outcome: 'revision_released',
                reason: 'lease_lapsed',
              }
            : {
                planId: plan.id,
                projectId: plan.projectId,
                outcome: 'left_as_is',
                reason: 'row_moved',
              },
        );
        continue;
      }
      if (!plan.sourceJobId) continue;
      const job = await deps.resolveJobState(plan.sourceJobId, plan.projectId);
      const decision = classifyRevisionCandidate(
        job,
        now.getTime() - new Date(plan.leaseStartedAt).getTime(),
      );
      if (decision.action === 'keep') {
        outcomes.push({
          planId: plan.id,
          projectId: plan.projectId,
          outcome: 'left_as_is',
          reason: decision.reason,
        });
        continue;
      }
      let settled: Awaited<ReturnType<typeof settleFailedJob>> | null;
      try {
        settled = await settleFailedJob(
          plan.sourceJobId,
          { userId: '', workspaceId: plan.workspaceId, projectId: plan.projectId },
          { status: decision.action === 'fail' ? 'failed' : 'canceled' },
          deps.getFailedJobFacts
            ? {
                readJob: async (jobId, projectId) => ({
                  error: job?.failure ?? null,
                  ...(await deps.getFailedJobFacts!(jobId, projectId)),
                }),
              }
            : {},
        );
      } catch (err) {
        console.warn(`[abandoned-plan-sweep] settling the revision of plan ${plan.id} failed`, err);
        settled = null;
      }
      outcomes.push(
        settled
          ? {
              planId: plan.id,
              projectId: plan.projectId,
              outcome: decision.action === 'fail' ? 'revision_failed' : 'revision_released',
              reason: decision.reason,
            }
          : {
              planId: plan.id,
              projectId: plan.projectId,
              outcome: 'left_as_is',
              reason: 'row_moved',
            },
      );
    }

    return {
      scanned: outcomes.length,
      declined: outcomes.filter((o) => o.outcome === 'declined').length,
      outcomes,
    };
  },
};
