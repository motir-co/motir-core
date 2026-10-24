import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  ciRunnerProvisioningIntentRepository as intents,
  CI_RUNNER_INTENT_COMPLETED,
  CI_RUNNER_INTENT_FAILED,
} from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import {
  ciContainerUsageRepository,
  type LiveAgentUsage,
} from '@/lib/repositories/ciContainerUsageRepository';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { hostedRunChargeService } from '@/lib/services/hostedRunChargeService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import {
  ciRunnerAdmissionService,
  type AdmissionDeferralReason,
} from '@/lib/services/ciRunnerAdmissionService';
import {
  projectRunnerGroupService,
  RunnerGroupNotProvisionedError,
} from '@/lib/services/projectRunnerGroupService';
import {
  runnerJitConfigClient,
  RunnerJitTimeoutError,
  RunnerRegistrationRateLimitedError,
  RUNNER_JIT_REQUEST_TIMEOUT_MS,
} from '@/lib/github/runnerJitConfig';
import { dispatchCiRunnerBoot, type CiRunnerBootDispatchOutcome } from '@/lib/ciFleet/bootDispatch';
import {
  driveSupervisionInProcess,
  inProcessMemoSteps,
} from '@/lib/jobs/supervision/inProcessSteps';
import {
  advanceSupervision,
  inMemorySupervisionStore,
  type SupervisionStore,
  type SupervisionTerminalReason,
} from '@/lib/jobs/supervision/driver';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { ciDockerVolumeGb } from '@/lib/ciFleet/limits';
import { fleetRunnerTargetFor } from '@/lib/ciFleet/runnerTarget';
import { OrgTargetAuthError, type GithubOrgTarget } from '@/lib/github/orgTarget';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  ORCHESTRATOR_REQUEST_TIMEOUT_MS,
  OrchestratorImageUnpullableError,
  fleetRunnerImage,
  fleetRunnerRegion,
  getOrchestrator,
  isOrchestratorConfigured,
  recordContainerUsage,
} from '@/lib/orchestrator';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import {
  githubRunnerCallLedgerService as runnerCallLedger,
  runnerCallReachedGithub,
} from '@/lib/services/githubRunnerCallLedgerService';
import {
  classifyProvisionRefusal,
  fleetShardAdmissionService,
  SHARD_CAPACITY_DETAIL,
} from '@/lib/services/fleetShardAdmissionService';
import {
  ciFleetAdmissionLockRepository as locks,
  FLEET_ADMISSION_SCOPE,
} from '@/lib/repositories/ciFleetAdmissionLockRepository';
import {
  FLEET_CONTAINER_SIZE,
  type ContainerHandle,
  type ContainerOrchestrator,
  type ContainerSpec,
  type ContainerUsage,
  type TeardownReason,
  type UsageAttribution,
} from '@motir/orchestrator';

// THE PROVISIONER (Story MOTIR-1916 · MOTIR-1921) — one provisioning intent
// becomes exactly one single-use ephemeral runner, and is guaranteed to stop
// costing money afterwards.
//
// `docs/decisions/ci-runner-fleet.md` §10 scopes this card: the port, the Fly
// adapter, the fake adapter, `reap()` and its schedule. This service is what
// drives them.
//
// ⚠️ TEARDOWN IS THE CORRECTNESS PROPERTY, NOT BOOT. Boot failing is visible and
// cheap — a job queues and someone notices. Teardown failing is invisible and
// bills forever. So the shape of this file is deliberately lopsided: the boot is
// a handful of straight-line calls, and everything else is the four independent
// mechanisms that make sure nothing survives it.
//
//   1. The JIT CONFIG — the runner takes exactly one job, de-registers, exits.
//   2. `auto_destroy: true` + `restart: { policy: 'no' }` in the Fly adapter — an
//      exiting process is a destroyed machine, not a restarted one.
//   3. THE POLL LOOP CANNOT EXIT EXCEPT INTO {@link ciRunnerBootService.settleSupervision}
//      — every path out of supervision tears the container down, including the
//      ones that failed. See the note below on what changed here (MOTIR-2007).
//   4. {@link ciRunnerBootService.reapOrphans} — the backstop for the ONE case
//      guarantee 3 cannot cover: the supervisor dying between provision and
//      teardown.
//
// They are independent on purpose. Any one of them can fail without leaking a
// container, which is the only useful definition of "guaranteed" for something
// whose failure is silent.
//
// ⚠️ GUARANTEE 3 WAS A `finally`, THEN A STEP, AND IS A `finally` AGAIN — and
// the round trip is worth reading in full, because the INCIDENT is not reversed
// even though its remedy is (MOTIR-2007, then MOTIR-3485).
//
// Supervision watches a container for up to {@link DEFAULT_JOB_TIMEOUT_MS} =
// 3,600s. It used to do that synchronously inside ONE SERVERLESS invocation,
// whose ceiling was `maxDuration = 300` in `app/api/inngest/route.ts` — twelve
// times shorter. So every CI job longer than ~5 minutes had its supervisor killed
// mid-loop with `FUNCTION_INVOCATION_TIMEOUT`: the `finally` never ran, the intent
// stayed `running` and held a fleet slot against BOTH the per-project cap and the
// fail-CLOSED cross-workload ceiling (both since folded into the org's pool,
// MOTIR-6907) until the reaper aged it out 70 minutes
// later, the run dead-lettered while the job had actually succeeded, and the
// container's cost was recorded late and coarsely or not at all. A spend guard
// turning into an outage. **All of that happened, and none of it is in doubt.**
//
// MOTIR-2007's fix was to make supervision a DURABLE POLL LOOP owned by the job,
// so no STEP approached `maxDuration` while the RUN spanned an hour across many
// invocations. **The ceiling that made a `finally` untrustworthy has since gone:**
// `Dockerfile` ends `CMD ["node", "server.js"]` and motir-core has run as a
// long-lived Fly process since MOTIR-2384, so nothing kills a supervisor
// mid-loop. {@link ciRunnerBootService.runIntent} is the composition again — one
// of it, not two kept in agreement by hand — and its teardown is an ordinary
// `try`/`finally`, which now reaches a THIRD exit the stepped form could not: a
// throw from inside the loop.
//
// The three individually-BOUNDED operations stay, and are what the job still
// memoizes: {@link ciRunnerBootService.bootIntent},
// {@link ciRunnerBootService.pollOnce}, {@link ciRunnerBootService.settleSupervision}.
// What decides which of them keeps a `step.run` is
// `docs/decisions/job-queue-foundation.md` §13 — the SIDE EFFECT, never the WAIT
// — and the answer is boot and settle, because a worker restart replaying either
// would mint a second runner or destroy a machine twice.
//
// ⚠️ AND {@link ciRunnerBootService.pollOnce} STILL MUST NEVER THROW. Its REASON
// changed and the requirement did not, which is the distinction worth keeping.
// It used to be that a step scheduled from a `catch` is never executed by the
// Inngest executor — it finalizes the run as failed first (`PRODECT_FINDINGS`
// #39, the trap that made `defineJob` move its dead-letter write to `onFailure`)
// — so teardown was unreachable from one. Teardown is reachable from a `catch`
// now. But a poll that threw would still end the pass with no verdict and no
// diagnosis, and the structural version is the stronger property: `pollOnce`
// converts every failure it can meet into a TYPED result, so the only way out of
// the loop is a `done` verdict, and a `done` verdict goes to
// `settleSupervision`.
//
// ⚠️ WHO DECIDES WHETHER THIS RUNS AT ALL. §10 puts the ADMISSION GATE — the
// org's in-flight pool (MOTIR-6907, which replaced MOTIR-1922's per-project cap
// and fleet-wide ceiling) and the `ci_credits_exhausted` refusal — in MOTIR-1922, "consulted BEFORE this card
// provisions". It has landed as `ciRunnerAdmissionService`, and {@link
// ciRunnerBootService.runIntent} consults it EXACTLY WHERE THE CLAIM USED TO BE:
// the gate decides and claims in one locked transaction, because the claim is
// what makes an intent count as in-flight and a gate that did not own it would be
// deciding from a count that excludes the decisions already made. This service
// still reads no cap, no ceiling and no balance itself — it asks, and it obeys.
//
// ⚠️ THE PENDING-INTENT SWEEP IS NO LONGER A TRIGGER OF ANYTHING (this paragraph
// used to say it "remains the trigger"). Both halves moved to events, one card
// each, and what is left on the cron is recovery:
//
//   * a QUEUED job reaches the gate from the `workflow_job` webhook, in the same
//     request that records the intent (MOTIR-1996, `lib/ciFleet/bootDispatch.ts`)
//     — a minute-granularity cron cannot meet §6's ≤30s p50 budget;
//   * a DEFERRED job reaches it from the admission WAKE, the moment the slot it
//     was waiting for is released (MOTIR-2852,
//     {@link ciRunnerBootService.dispatchNextPendingForProject}) — see
//     `settleIntent`, which is the one funnel every terminal transition uses.

/**
 * WHAT THIS SERVICE BOOTS (MOTIR-2025). The orchestrator port carries a workload
 * now, and this is the only producer of a `ci_runner` one — index and agent
 * containers are dispatched by their own services onto the same port.
 *
 * Named once rather than repeated at the four sites that need it, so a reader
 * asking "does this service ever boot anything else?" gets the answer from one
 * grep instead of four string literals.
 */
const CI_RUNNER_WORKLOAD = 'ci_runner' satisfies FleetWorkloadKind;
/** The workload a hosted run's container is booted under — the reaper settles it
 *  too (MOTIR-6524). */
const HOSTED_AGENT_WORKLOAD = 'hosted_agent' satisfies FleetWorkloadKind;
/** The failure detail a reaped container's run ends with. */
const REAPED_DETAIL = 'the container outlived its supervisor and was reaped';

/** How long a container has to reach a running state before it is written off as
 *  a boot that never happened. §6 budgets p95 ≤ 60s end to end; double that is a
 *  deadline that cannot fire on a merely-slow boot. */
const DEFAULT_BOOT_DEADLINE_MS = 120_000;

/** The hard kill. GitHub's own ceiling is a 5-day job; a CI job that has not
 *  finished in an hour on 2-core hardware is not going to, and every further
 *  second is billed to Motir. §11 leaves what happens to the JOB (re-queue,
 *  surface, leave it to the user's re-run) to the fleet's operational story; what
 *  is fixed here is that the CONTAINER stops. */
const DEFAULT_JOB_TIMEOUT_MS = 3_600_000;

/** How soon after boot supervision first asks the provider what the container is
 *  doing. Short, because a fast job should settle fast: the sooner a terminal
 *  container is observed, the sooner it is torn down and metered. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * The ceiling the poll interval backs off to.
 *
 * ⚠️ THIS EXISTS BECAUSE THE WAIT IS NOW A STEP. A fixed 3s interval across a
 * 3,600s job is 1,200 `step.sleep` + `step.run` pairs — 2,400 steps for ONE CI
 * job, each a checkpoint Inngest persists and re-invokes through. Backing off to
 * {@link MAX_POLL_INTERVAL_MS} makes a full-length job ~125 polls instead, and
 * costs only DETECTION latency: the container is destroyed by `auto_destroy`
 * when the runner exits either way, so a later observation delays the teardown
 * call and the usage row, not the machine stopping.
 *
 * Kept well under {@link DEFAULT_BOOT_DEADLINE_MS} so the boot deadline is still
 * observed with granularity rather than overshot by a whole interval.
 */
const MAX_POLL_INTERVAL_MS = 30_000;

/** How much the poll interval grows each time it is not yet terminal, until it
 *  reaches {@link MAX_POLL_INTERVAL_MS}. */
const POLL_BACKOFF_FACTOR = 2;

/**
 * A hard ceiling on poll iterations, independent of the clock.
 *
 * {@link pollOnce} already terminates on {@link DEFAULT_JOB_TIMEOUT_MS}, so this
 * is not the bound that matters — it is the bound that still holds if the clock
 * does something surprising (a frozen `now`, a test seam, a provider that never
 * reports terminal). A loop with no static bound is a runaway that bills per
 * iteration, so it gets one.
 *
 * ⚠️ SINCE MOTIR-3485 IT IS A PER-PASS GUARD, NOT A BOUND ON TOTAL POLLS PER
 * CONTAINER. The counter is in-memory, so a worker restart resets it — accepted
 * rather than repaired (`docs/decisions/job-queue-foundation.md` §13.3(a)),
 * because the sentence above already said this was never the bound that mattered.
 */
const MAX_POLL_ITERATIONS = 2_000;

/**
 * How many CONSECUTIVE provider status reads may fail before supervision gives
 * up and tears the container down.
 *
 * Not zero, because a single 500 from the provider would otherwise end a
 * customer's healthy CI run for a reason that has nothing to do with their code.
 * Not unbounded, because a provider that is genuinely unreachable must not leave
 * this loop watching a container forever — and the deadlines still bound it
 * either way, since a failed read falls through to the same checks.
 */
const MAX_CONSECUTIVE_READ_FAILURES = 3;

/** How long a claimed-but-never-booted intent may sit before the sweep writes it
 *  off and de-registers its runner. Comfortably past the boot deadline, so a
 *  slow-but-live provision is never swept out from under itself. */
const STALE_CLAIM_MS = 15 * 60_000;

/**
 * How many times one intent's boot may be attempted before a transient provider
 * failure settles it `provision_failed` (MOTIR-8941). A fleet runner is
 * interchangeable, so an intent lost for good takes one runner away from the
 * jobs queued at GitHub and one of them waits for ever; a re-queued intent boots
 * on the next sweep instead.
 */
export const MAX_BOOT_ATTEMPTS = 3;

/** A CI intent's OWN end: boot + the job timeout + 10 minutes. It used to be an
 *  age cutoff on the machine (the reaper's); since MOTIR-6925 it is a property of
 *  the RECORD, read by the attribution reconciler (`fleet-per-org-pool.md` §6).
 *  Past the job timeout, so the reconciler only ever sees containers supervision
 *  genuinely failed to reach — not ones it is about to. */
const DEFAULT_REAP_AFTER_MS = DEFAULT_JOB_TIMEOUT_MS + 10 * 60_000;

/**
 * THE FLEET'S TIME BUDGETS, AND HOW THEY RELATE TO THE PLATFORM CEILING — stated
 * ONCE, here, and asserted in `tests/ciFleet/fleetTimeBudgets.test.ts`
 * (MOTIR-2007). `docs/jobs.md` rule 2 asks for exactly this inequality; the fleet
 * was the case it did not hold for.
 *
 * ⚠️ CORRECTED (MOTIR-3485) — NOT ONE VALUE MOVED, AND THE CEILING TWO OF THEM
 * WERE READ AGAINST IS GONE. `maxDuration` (300s, `app/api/inngest/route.ts`) is
 * a Vercel route-segment directive, and motir-core runs as a long-lived Fly
 * process (`Dockerfile`, MOTIR-2384). What each budget is actually for, now that
 * it is not licensed by the stepping:
 *
 *   • `stepWorkBudgetMs`
 *        The bound on what any ONE step of the boot path does. `pollOnce` is one
 *        provider read; `settleSupervision` is a teardown plus its bookkeeping.
 *        It used to be read as `≤ maxDuration · 1000` — the constraint that
 *        regressed into an hour-long step before. It still earns its place for a
 *        reason that has nothing to do with a platform: a MEMOIZED step should be
 *        SMALL, because that is what makes a resumed run cheap. The assertion in
 *        `tests/ciFleet/fleetTimeBudgets.test.ts` is deliberately left reading the
 *        route's number until `docs/jobs.md` rule 1 is restated (MOTIR-3488) —
 *        one inequality, not two places to correct it.
 *
 *   • `jobTimeoutMs` (3,600s)
 *        The CONTAINER's hard kill, and always was. It bounds SPEND, never an
 *        invocation, and it is anchored on the memoized `session.bootedAt` so it
 *        survives a worker restart (`docs/decisions/job-queue-foundation.md`
 *        §13.2). This block used to justify it as *"legal ONLY because the RUN is
 *        stepped"* and warn that shortening it to fit one invocation was the
 *        tempting non-fix — the warning stands, and its premise has evaporated.
 *
 *   • `pollIntervalMs` ≤ `maxPollIntervalMs` < `bootDeadlineMs` < `jobTimeoutMs`
 *        The boot deadline must be observable at poll granularity, and it must be
 *        able to fire before the job timeout does.
 *
 *   • `reapAfterMs` > `jobTimeoutMs`
 *        The reaper stays the BACKSTOP: it may only ever see containers
 *        supervision has already given up on, never ones it is about to settle.
 *
 *   • `mintDeadlineMs` + `containerCallDeadlineMs` ≤ `stepWorkBudgetMs`
 *        RULE 3's inequality, for the one path that did not hold it (MOTIR-2011).
 *        Rule 2 bounds the SHAPE of a step; this bounds its CLOCK. The boot step
 *        makes exactly two external calls — mint, then provision — and their
 *        deadlines are what turn "this step does one small thing" from a claim
 *        about the code into a bound on its wall time. They are IMPORTED from
 *        the two clients rather than restated, so a client that lengthens its
 *        deadline has to come past the assertion.
 *
 * Change one of these and the assertion makes you look at the others.
 */
export const FLEET_TIME_BUDGETS = {
  bootDeadlineMs: DEFAULT_BOOT_DEADLINE_MS,
  jobTimeoutMs: DEFAULT_JOB_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
  reapAfterMs: DEFAULT_REAP_AFTER_MS,
  maxPollIterations: MAX_POLL_ITERATIONS,
  /**
   * What ONE step of the boot path is allowed to spend. Not a timer this code
   * enforces — a budget the steps are SHAPED to respect (one provider call each),
   * and which the test still asserts against the route's `maxDuration`. See the
   * corrected block above for why that comparison survives the collapse as an
   * inequality with one home rather than two.
   */
  stepWorkBudgetMs: 120_000,
  /** The GitHub `generate-jitconfig` deadline — the boot step's first call. */
  mintDeadlineMs: RUNNER_JIT_REQUEST_TIMEOUT_MS,
  /** The container provider's per-call deadline — the boot step's second call,
   *  and the only call a poll or a teardown step makes. */
  containerCallDeadlineMs: ORCHESTRATOR_REQUEST_TIMEOUT_MS,
} as const;

/**
 * How long to wait before poll number `iteration` (1-based).
 *
 * PURE, and deliberately a function of the iteration rather than of the clock:
 * the durable loop re-derives it on every replay pass, so a wall-clock input
 * would make two passes of the same run schedule different sleeps.
 */
export function pollWaitMs(iteration: number, options: SupervisionOptions = {}): number {
  const base = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cap = options.maxPollIntervalMs ?? MAX_POLL_INTERVAL_MS;
  const grown = base * POLL_BACKOFF_FACTOR ** Math.max(0, iteration - 1);
  return Math.min(Math.max(base, grown), Math.max(base, cap));
}

/**
 * THE DURABLE SEAM (MOTIR-3485) — the subset of a job's `ctx.step` that
 * {@link ciRunnerBootService.runIntent} composes against.
 *
 * ⚠️ IT CARRIES `run` AND NOT `sleep`. `docs/decisions/job-queue-foundation.md`
 * §13 settles what a supervision loop keeps durable: the SIDE EFFECT, never the
 * WAIT. A supervisor that forgets it was sleeping re-attaches to the same
 * container out of the memoized boot; a supervisor that forgets it BOOTED mints a
 * SECOND GitHub runner registration and provisions a second billed machine.
 *
 * Structurally identical to the index fleet's `SupervisionSteps` and deliberately
 * NOT shared with it: the two services share no file today (which is why
 * MOTIR-3484 and MOTIR-3485 are siblings rather than a chain), and a common type
 * would couple two fleets whose only real similarity is that they both watch a
 * container. If a third arrives, extract it then.
 */
export interface RunnerSupervisionSteps {
  run<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
}

/** The no-op seam: execute, do not memoize. The default for every non-job caller. */
export const INLINE_RUNNER_STEPS: RunnerSupervisionSteps = {
  run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
};

/** Seams the tests drive. Defaults are the constants above; nothing else may
 *  pass them, which is why they are optional and undocumented in the API. */
export interface SupervisionOptions {
  bootDeadlineMs?: number;
  jobTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /**
   * The per-pass poll ceiling. Bounded by {@link MAX_POLL_ITERATIONS} — a test
   * may LOWER it to drive the ceiling branch in milliseconds, never raise it past
   * the shipped guard.
   */
  maxPollIterations?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The durable-step seam (MOTIR-3485). The `system.ci-runner-boot` job passes
   * its `ctx.step`; everything else passes nothing and gets
   * {@link INLINE_RUNNER_STEPS}.
   */
  steps?: RunnerSupervisionSteps;
  /**
   * WHERE the supervision's per-pass state lives
   * (`lib/jobs/supervision/driver.ts`). Omitted by the job, which gets the
   * durable `job_supervision` row; supplied by
   * {@link ciRunnerBootService.runIntent}, which drives a supervision to
   * completion for a caller with no `job_queue` row to hang one off.
   */
  supervisionStore?: SupervisionStore;
}

/**
 * The handle on a container currently being supervised — what {@link
 * ciRunnerBootService.bootIntent} hands to every later step.
 *
 * ⚠️ JSON-SERIALIZABLE BY CONTRACT. It crosses a `ctx.step.run` boundary, so
 * Inngest round-trips it through JSON: every instant is an ISO STRING, not a
 * `Date`, because a `Date` survives the first pass and arrives as a string on
 * every replayed one — a difference that would otherwise show up as a
 * `.getTime is not a function` only in production, only on long jobs.
 */
export interface SupervisionSession {
  readonly intentId: string;
  readonly handle: {
    readonly provider: ContainerHandle['provider'];
    readonly id: string;
    readonly region: string;
    /** ISO-8601. */
    readonly createdAt: string;
    /** The runner's Docker volume (MOTIR-8839), so the settle's teardown can
     *  delete it after the machine destroyed itself. OPTIONAL on read: a session
     *  memoised before it existed has none, and teardown reads the mounts. */
    readonly volumeId?: string;
    /** The fleet account the container was booted in (MOTIR-8964), so every
     *  later step reaches the same provider account. OPTIONAL on read: a session
     *  memoised before it existed has none, and resolves to the process-wide
     *  fleet — where every such container was booted. */
    readonly shardId?: string;
  };
  readonly githubRunnerId: number | null;
  /**
   * The org the runner was minted in, when it is NOT the provisioning org
   * (Story MOTIR-8699 · MOTIR-8711) — `fleetRunnerTargetFor(intent)` at boot.
   * `null` for a provisioning-org job. OPTIONAL on read: a session memoised
   * before this field existed has none, and every such session is a
   * provisioning-org job, so it de-registers through the default.
   */
  readonly runnerTarget?: GithubOrgTarget | null;
  /** The image reference the container was booted from, so a container that never
   *  starts can say which image it was waiting on (MOTIR-9348). OPTIONAL on read: a
   *  session memoised before it existed has none. */
  readonly image?: string;
  /** ISO-8601 — when the container was booted, the origin both deadlines run from. */
  readonly bootedAt: string;
  /** ISO-8601 — GitHub's own queue instant, which boot latency is measured from. */
  readonly queuedAt: string;
  readonly attribution: {
    readonly orgId: string;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly repoFullName: string;
    readonly workflowJobId: number;
  };
}

/** What one poll observed. `done` is the ONLY way out of the loop, and it always
 *  leads to {@link ciRunnerBootService.settleSupervision}. */
export type PollResult =
  | {
      done: false;
      /** ISO-8601, once the container has been seen running. */
      startedAt: string | null;
      bootLatencyMs: number | null;
      /** Carried forward so the next poll can apply {@link MAX_CONSECUTIVE_READ_FAILURES}. */
      consecutiveReadFailures: number;
      /** The provider state the last successful read reported, carried so a boot
       *  deadline reached on a failed read can still name it. */
      lastState?: string;
    }
  | {
      done: true;
      reason: TeardownReason;
      startedAt: string | null;
      bootLatencyMs: number | null;
      /** Set when the loop ended because the provider could not be read, so the
       *  settled intent can say so rather than reporting a bare timeout. */
      failureDetail: string | null;
    };

/** What {@link ciRunnerBootService.bootIntent} returns: either nothing was
 *  provisioned and the run is over, or a container is up and must be supervised
 *  to its end. */
export type BootResult =
  | { phase: 'terminal'; outcome: RunIntentOutcome }
  | { phase: 'supervising'; session: SupervisionSession };

/** The starting point of the poll loop — no reads yet, nothing observed. */
export const INITIAL_POLL_STATE: Extract<PollResult, { done: false }> = {
  done: false,
  startedAt: null,
  bootLatencyMs: null,
  consecutiveReadFailures: 0,
};

export type RunIntentOutcome =
  /** No such intent — it was deleted, or the id was stale. */
  | { outcome: 'unknown_intent' }
  /** Another provisioner claimed it first. NOT an error: the compare-and-set
   *  worked exactly as intended. */
  | { outcome: 'already_claimed' }
  /** THE ADMISSION GATE (MOTIR-1922) declined. The intent is still PENDING and
   *  the next sweep retries it — a job left queued, never a job failed, which is
   *  what a cap is supposed to feel like. */
  | { outcome: 'gate_deferred'; reason: AdmissionDeferralReason; detail: string }
  /** This deployment provisions no containers (self-hosted, or unwired). The
   *  claim is RELEASED so a configured instance can take it. */
  | { outcome: 'not_configured' }
  /**
   * GitHub could not be asked to register a runner right now. RETRYABLE — the
   * claim is released and the intent stays pending for the next sweep.
   *
   * THREE causes, deliberately one outcome (MOTIR-2011, MOTIR-8941): a boot that
   * failed transiently and has attempts left re-queues the same way.
   * The first two: the registration ceiling
   * is exhausted (`retryAfterSeconds` set, when GitHub said when), or the mint
   * did not answer inside its deadline (`retryAfterSeconds: null`). They differ
   * in what caused the wait and not at all in what the fleet should DO — the job
   * is early, not broken — and the typed error each path logs is what tells an
   * operator which one happened.
   */
  | { outcome: 'rate_limited'; retryAfterSeconds: number | null }
  /** The intent names no project, so there is no runner group and no tenant to
   *  bill. Refused (§7.3), never provisioned into the `Default` group. */
  | { outcome: 'no_runner_group'; detail: string }
  /** The container never existed: the mint or the boot was refused. */
  | { outcome: 'provision_failed'; detail: string }
  /**
   * THE RUNNER IMAGE COULD NOT BE PULLED — §6.2 of
   * `docs/decisions/fleet-image-pull.md`, split out of `provision_failed` so it
   * is a NAMED condition rather than one more generic provider 400.
   *
   * It earns its own arm because the remedy is categorically different from
   * every other provisioning failure: nothing about the job, the tenant or the
   * retry changes anything — a human has to fix the image's visibility, its
   * digest, or the mirror. Every queued job hits it identically, so a fleet in
   * this state produces a wall of failures that all say the same thing, and the
   * name is what lets an operator read that wall as ONE fault. The boot-time
   * preflight (`verifyFleetBootable()`, §6.1) is what should have caught it
   * first; this is the case where it was pullable then and is not now.
   */
  | { outcome: 'image_unpullable'; detail: string }
  /** A container ran and was torn down. `reason` says how it ended. */
  | {
      outcome: 'settled';
      reason: TeardownReason;
      containerId: string;
      billableSeconds: number;
      costUsd: string;
      bootLatencyMs: number | null;
      /** The §5 container-seconds record. Carried on the outcome so it reaches
       *  the `job_run` ledger, which stays the PER-RUN operational trail; since
       *  MOTIR-1924 the same record is also persisted to `ci_container_usage`
       *  by the sink, which is where it is queryable and attributed. */
      usage: ContainerUsage;
    };

/**
 * What one {@link ciRunnerBootService.dispatchNextPendingForProject} did. A
 * superset of {@link CiRunnerBootDispatchOutcome}, because a wake can decline
 * before it ever reaches the transport.
 */
export type CiRunnerAdmissionWakeOutcome =
  | CiRunnerBootDispatchOutcome
  /** The freed slot belonged to no project, so there is no project queue to wake;
   *  the org's other pending jobs are the sweep's. */
  | 'no_project'
  /** The queue for that project is empty — the ordinary case, and the reason this
   *  is cheap: one indexed read per teardown, not one per minute forever. */
  | 'no_pending'
  /** The queue could not be read. Logged and swallowed; the sweep still covers
   *  the intent. */
  | 'read_failed';

function sleepFor(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/**
 * Boot latency, RE-DERIVED rather than carried across a pass.
 *
 * `pollContainerOnce` computes it as `startedAt − session.queuedAt` — GitHub's
 * own queue instant, because §6's budget is the span a USER experiences as "CI
 * is slow to start". Both halves survive a defer already: `startedAt` is on the
 * supervision row and `queuedAt` rides the memoized boot, so a column for the
 * difference would be a third copy of a fact two places hold (§16.2).
 */
function bootLatencyFrom(session: SupervisionSession, startedAt: string | null): number | null {
  if (!startedAt) return null;
  return Math.max(0, new Date(startedAt).getTime() - new Date(session.queuedAt).getTime());
}

/**
 * The `failureDetail` a supervision writes when it settles for a reason of its
 * OWN rather than because the container stopped.
 *
 * One function rather than a ternary at the call site, because each string is
 * what an operator reads off a settled intent to tell four cases apart — and
 * `job_timed_out` is the `TeardownReason` for all four, so the detail is the
 * only place the distinction survives.
 */
function runnerSupervisionFailureDetail(
  reason: SupervisionTerminalReason,
  maxPolls: number,
  timeoutMs: number,
): string {
  switch (reason) {
    case 'poll_ceiling':
      return `supervision hit the ${maxPolls}-poll ceiling`;
    case 'deadline':
      return `supervision passed its ${timeoutMs}ms deadline before this pass polled`;
    case 'failed':
      return 'a poll threw; the container is torn down before the failure propagates';
    /* v8 ignore next 6 -- `completed` always carries the poll's own verdict and
       `replayed` always hits the caller's `settle-runner` memo, so neither
       reaches this fallback. They are enumerated rather than left to a `default`
       so a new reason added to the union fails the exhaustiveness check here
       instead of silently taking a string written for something else. */
    case 'completed':
    case 'replayed':
      return `supervision settled (${reason})`;
  }
}

export const ciRunnerBootService = {
  /**
   * STEP 1 OF THE DURABLE POLL LOOP — admit, mint, boot, and hand back a session
   * (MOTIR-2007).
   *
   * Everything that has to happen exactly once and costs money: the admission
   * gate + claim, the runner group, the JIT mint, the container boot. Bounded by
   * construction — a fixed handful of calls, no loop, no wait — so it fits inside
   * one invocation with room to spare.
   *
   * Returns `terminal` when nothing was provisioned (the run is over and the
   * caller returns the outcome), or `supervising` with the JSON-serializable
   * {@link SupervisionSession} every later step needs. Never throws for an
   * outcome it can name, for the reason {@link runIntent} never did: the caller
   * is a background job, and a throw is a retry that would mint a second runner.
   */
  async bootIntent(intentId: string, options: SupervisionOptions = {}): Promise<BootResult> {
    const outcome = await bootOnce(intentId, options);
    return outcome;
  },

  /**
   * STEP 2 (×N) — ONE provider read, and return.
   *
   * ⚠️ THIS IS THE WHOLE POINT OF THE CARD. It does exactly one
   * `orchestrator.describe`, applies the deadlines to what came back, and
   * returns. No loop, no sleep, no second call — so the step it runs in is
   * milliseconds, and the constraint cannot silently regress into a long step
   * again. The WAITING between polls is `ctx.step.sleep`, which costs no
   * invocation at all.
   *
   * ⚠️ AND IT NEVER THROWS. In a stepped world teardown cannot be reached from a
   * catch (see the module header), so guarantee 3 is structural: every failure
   * this can meet becomes a typed result, and the only exit is a `done` verdict
   * that the caller takes to {@link settleSupervision}.
   */
  async pollOnce(
    session: SupervisionSession,
    previous: Extract<PollResult, { done: false }> = INITIAL_POLL_STATE,
    options: SupervisionOptions = {},
  ): Promise<PollResult> {
    return pollContainerOnce(session, previous, options);
  },

  /**
   * STEP 3 — THE TEARDOWN, and the only way the loop ends.
   *
   * Destroys the container, de-registers the runner, records the container-seconds
   * and settles the intent — i.e. everything that used to live in `runIntent`'s
   * `finally`, now reachable as an ordinary step on the terminal branch rather
   * than as a language construct in a process that may already be dead.
   */
  async settleSupervision(
    session: SupervisionSession,
    verdict: Extract<PollResult, { done: true }>,
    options: SupervisionOptions = {},
  ): Promise<RunIntentOutcome> {
    return settleSupervisedContainer(session, verdict, options);
  },

  /**
   * ONE PASS of an intent's supervision: boot, then advance the state machine by
   * exactly one poll (Story MOTIR-3778 · Subtask MOTIR-3829).
   *
   * ⚠️ IT USUALLY DOES NOT RETURN — it THROWS `JobRunDefer`. Each pass does one
   * provider read and hands its own `job_queue` row back at the next poll
   * instant, so the worker's slot is held for the duration of one `describe`
   * rather than for the duration of a container
   * (`docs/decisions/job-queue-foundation.md` §16). It RETURNS only on a
   * terminal transition, with the run outcome.
   *
   * ⚠️ THE COMMENT ABOVE THIS METHOD HAS BEEN CORRECTED TWICE AND BOTH ARE KEPT,
   * because a reader has to be able to see that the world changed rather than
   * that the code did.
   *
   *   1. It first said this composition was NOT the production path, because
   *      "calling this from a job would rebuild the hour-long invocation
   *      MOTIR-2007 removed" — a statement about `maxDuration = 300`, a Vercel
   *      ceiling that went with the platform.
   *   2. MOTIR-3485 then made it the only composition, with an ordinary `for`
   *      loop and a `finally`, on the ground that a long-lived worker makes both
   *      trustworthy again. **That is still true, and it was never the argument
   *      that mattered here.** What the loop costs is OCCUPANCY, not durability:
   *      one of `POOL_SIZE` in-flight slots held for a container's whole life.
   *
   * ⚠️ AND MOTIR-2007'S FINDING IS STILL NOT REVERSED. That incident was real —
   * an hour-long supervision inside one serverless invocation meant every CI job
   * over ~5 minutes had its supervisor killed with no teardown, the intent stuck
   * holding a fleet slot, and the run dead-lettered while the job had actually
   * passed. Every guarantee it bought is kept:
   *
   *   • BOOT and SETTLE are still memoized `step.run`s. `bootIntent` admits,
   *     claims the intent, mints a JIT runner registration and provisions a
   *     machine; a resumed pass replays it and re-attaches rather than
   *     registering a second runner.
   *   • The wall clock is still anchored on the memoized `session.bootedAt`, so
   *     `jobTimeoutMs` bounds a container across a restart (§13.2).
   *   • **GUARANTEE 3 CHANGES ITS MECHANISM AND KEEPS ITS CONTENT.** It read
   *     *"the poll loop cannot exit except into `settleSupervision`"*, and there
   *     is no loop to exit. It is now: **the machine has exactly one terminal
   *     transition, reached from three named places and from nothing else, and a
   *     DEFER reaches none of them** (§16.4). There is no `finally` here at all —
   *     which is the point, because a defer is a THROW and a `finally` would
   *     tear the container down on the first suspension, exactly as §15.4
   *     measured.
   *
   * ⚠️ AND `retryPolicy: 'none'` STILL SURVIVES A RESTART. It is the one job in
   * the tree whose budget is exactly ONE, so the difference between resuming and
   * dead-lettering is whether a suspension spends an attempt. A defer refunds it
   * exactly as `reclaimExpiredLeases` and `releaseClaims` do — asserted against
   * the worker's real settle path rather than cited, which is what §13.4 asked
   * for when this mechanism last changed and asks for again now.
   */
  async advanceIntent(
    /** The `job_queue` row this supervision hangs off — `ctx.runId` for a job. */
    runId: string,
    intentId: string,
    options: SupervisionOptions = {},
  ): Promise<RunIntentOutcome> {
    const steps = options.steps ?? INLINE_RUNNER_STEPS;
    // Bounded by the shipped guard: a test may LOWER it, never raise it. A TOTAL
    // bound again rather than the per-pass runaway guard §13.3(a) demoted it to,
    // because the count lives in `job_supervision` now.
    const maxPolls = Math.min(
      options.maxPollIterations ?? MAX_POLL_ITERATIONS,
      MAX_POLL_ITERATIONS,
    );
    const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

    const booted = await steps.run('boot-runner', () => this.bootIntent(intentId, options));
    if (booted.phase === 'terminal') return booted.outcome;
    const { session } = booted;

    const result = await advanceSupervision<Extract<PollResult, { done: true }>, RunIntentOutcome>(
      runId,
      {
        kind: 'ci-runner',
        // ONE intent is ONE container — no fan-out — so the subject is the
        // intent. It is still a subject rather than an implicit singleton,
        // because the row's identity is `(run_id, subject)` for both fleets and
        // one shared shape is what makes these two conversions the same
        // conversion.
        subject: intentId,
        workspaceId: session.attribution.workspaceId,
        bootedAt: new Date(session.bootedAt),
      },
      {
        maxPolls,
        timeoutMs: jobTimeoutMs,
        waitMs: (pollNumber) => pollWaitMs(pollNumber, options),
        ...(options.now ? { now: options.now } : {}),
        ...(options.supervisionStore ? { store: options.supervisionStore } : {}),
        // ONE provider read. `pollOnce` is unchanged, including its own
        // boot-deadline arm — which stays there, where a SUCCESSFUL read is
        // available, because §13.3(b) forbids reaching that verdict from the
        // absence of an observation.
        //
        // ⚠️ `bootLatencyMs` IS RE-DERIVED, NOT CARRIED. It is
        // `startedAt − session.queuedAt` — one field from the supervision row and
        // one from the memoized boot — so a column for it would be a third copy
        // of a fact two places already hold (§16.2).
        poll: async (state) => {
          const startedAt = state.startedAt ? state.startedAt.toISOString() : null;
          const polled = await this.pollOnce(
            session,
            {
              done: false,
              startedAt,
              bootLatencyMs: bootLatencyFrom(session, startedAt),
              consecutiveReadFailures: state.consecutiveReadFailures,
            },
            options,
          );
          if (polled.done) return { done: true, verdict: polled };
          return {
            done: false,
            startedAt: polled.startedAt ? new Date(polled.startedAt) : null,
            consecutiveReadFailures: polled.consecutiveReadFailures,
          };
        },
        // THE TEARDOWN, still a memoized step, and still the only thing that
        // destroys the container, de-registers the runner, meters it, settles
        // the intent and fires the admission wake.
        settle: async (reason, state, verdict) =>
          steps.run('settle-runner', () => {
            const startedAt = state.startedAt ? state.startedAt.toISOString() : null;
            return this.settleSupervision(
              session,
              verdict ?? {
                done: true,
                reason: 'job_timed_out',
                startedAt,
                bootLatencyMs: bootLatencyFrom(session, startedAt),
                failureDetail: runnerSupervisionFailureDetail(reason, maxPolls, jobTimeoutMs),
              },
              options,
            );
          }),
      },
    );
    return result.outcome;
  },

  /**
   * Boot ONE intent and supervise it TO COMPLETION, in this process — for a
   * caller that has no `job_queue` row to hang a supervision off.
   *
   * ⚠️ A WRAPPER, NOT A SECOND COMPOSITION. Every ordering, every transition and
   * the suspension invariant live in {@link advanceIntent} and the driver
   * beneath it; this supplies an in-process store and an in-process step memo,
   * and `driveSupervisionInProcess` turns each defer back into a wait. Two copies
   * of a supervision loop kept in agreement by hand is the defect MOTIR-3485
   * spent a card deleting.
   *
   * Its callers are scripts, local harnesses and the tests that drive this
   * service directly. `system.ci-runner-boot` goes through {@link advanceIntent}.
   */
  async runIntent(intentId: string, options: SupervisionOptions = {}): Promise<RunIntentOutcome> {
    const sleep = options.sleep ?? sleepFor;
    const now = options.now ?? ((): Date => new Date());
    // ONE store and ONE memo per call: their lifetime is this loop. Without the
    // memo every pass would re-execute the BOOT — which on this fleet means a
    // second JIT runner registration and a second billed machine.
    const supervisionStore = options.supervisionStore ?? inMemorySupervisionStore();
    const steps = inProcessMemoSteps(options.steps ?? INLINE_RUNNER_STEPS);
    // The loop lives in `lib/jobs/supervision/`, not here: `eslint.config`'s
    // `JOB_ENGINE_RESTRICTION` confines `@/lib/jobs/engine/*` to `lib/jobs/**`,
    // so this file may not name the deferral signal — and re-exporting the
    // predicate one folder over would be exactly the walk-around that rule's own
    // comment refuses.
    return driveSupervisionInProcess(
      () => this.advanceIntent(intentId, intentId, { ...options, steps, supervisionStore }),
      { sleep, now },
    );
  },

  /**
   * TEAR DOWN ONE container the attribution reconciler has judged — the half of
   * the old reaper that SETTLES what it destroys (§4, §7.1's third guarantee;
   * `fleet-per-org-pool.md` §6).
   *
   * The reconciler (`fleetAttributionService`) decides WHETHER a machine dies:
   * nothing attributes it, or its record says it should have stopped. Age alone
   * is no longer a reason (§6: `DEFAULT_REAP_AFTER_MS` survives only as a CI
   * intent's own end instant). What stays here is what the reconciler cannot do
   * from a provider listing: tear the container down THROUGH the port so a usage
   * row is produced, settle the CI intent that was holding it, and — for a
   * hosted-agent machine attributed from its own live row (MOTIR-6524) — release
   * its slot, charge its machine time and end its run.
   *
   * Answers `false` when Motir holds nothing to settle against (no intent and no
   * live hosted row, or one it cannot attribute), leaving the plain destroy to
   * the caller — a row attributed to nobody would pollute the meter.
   */
  async reapContainer(
    handle: ContainerHandle,
    options: {
      now?: () => Date;
      /** The fleet account the container was LISTED in (MOTIR-8964). Absent =
       *  the account its intent recorded; null = the process-wide fleet. */
      shardId?: string | null;
    } = {},
  ): Promise<boolean> {
    const now = options.now ?? (() => new Date());
    const resolved = await resolveReapAttribution(handle);
    if (!resolved) return false;
    const shardId = options.shardId !== undefined ? options.shardId : resolved.shardId;
    if (shardId === null && !isOrchestratorConfigured()) return false;
    const orchestrator = await fleetShardOrchestratorService.forShard(shardId);
    if (orchestrator.provider !== handle.provider) return false;
    const usage = await orchestrator.teardown(handle, 'reaped', resolved.attribution);

    if (resolved.hosted) {
      const { hosted } = resolved;
      await recordContainerUsage({
        ...usage,
        repoFullName: hosted.repoFullName,
        dispatchRunId: hosted.dispatchRunId,
      });
      // The terminal transition its supervisor would have taken — AFTER the usage
      // row is written, so a run whose last container this was reads as settled
      // and is charged once: the slot released, the machine time charged (motir-ai
      // dedupes on the run id), then the one end path (MOTIR-6450).
      await fleetCeilingService.release(
        HOSTED_AGENT_WORKLOAD,
        hostedRunDispatchId(hosted.dispatchRunId),
      );
      await hostedRunChargeService.chargeMachineTime(hosted.dispatchRunId, { now });
      await hostedRunService.endHostedRun(hosted.dispatchRunId, 'lost_supervision', REAPED_DETAIL);
      return true;
    }

    await recordContainerUsage(usage);
    const intent = await withSystemContext((tx) =>
      intents.findByContainerId(usage.provider, usage.handleId, tx),
    );
    // The row vanished between the teardown and the write-back (a tenant
    // teardown, a cascade): the container is gone, which is what mattered.
    if (!intent) return true;
    await deregisterQuietly(intent.githubRunnerId, intent.id, fleetRunnerTargetFor(intent));
    await settleIntent(intent.id, intent.projectId, {
      status: CI_RUNNER_INTENT_FAILED,
      teardownReason: 'reaped',
      settledAt: now(),
      failureDetail: REAPED_DETAIL,
    });
    return true;
  },

  /**
   * Write off every intent claimed but never booted — the crash between the JIT
   * mint and the boot, which leaves GitHub holding a registered runner with no
   * machine. Runs on the attribution reconciler's schedule (MOTIR-6925), which
   * replaced the reaper's.
   */
  async sweepStaleClaims(options: { now?: () => Date } = {}): Promise<number> {
    if (!isOrchestratorConfigured()) return 0;
    return sweepStaleClaims(options.now ?? (() => new Date()));
  },

  /**
   * Settle every in-flight intent past its own end whose container no longer
   * exists (MOTIR-9347). The reconciler judges machines, so an intent whose
   * supervision died AFTER its machine destroyed itself is never visited and
   * stays `running` for ever, holding an org-pool slot. A container that still
   * exists is left alone: the reconciler's machine-driven kill settles it with
   * its usage row. Runs on the reconciler's schedule; returns how many it settled.
   */
  async sweepVanishedInFlight(options: { now?: () => Date } = {}): Promise<number> {
    if (!isOrchestratorConfigured()) return 0;
    return sweepVanishedInFlight(options.now ?? (() => new Date()));
  },

  /**
   * The provisioning SPEC for one intent — the port's provider-neutral shape.
   *
   * Exported (rather than inlined) because it is what MOTIR-1927's label-scoping
   * guard asserts against: the env the container receives, the single label the
   * JIT config was minted with, and the size §M fixes are all decided here, in
   * one readable place, and none of them is a Fly concept.
   */
  buildSpec(input: {
    intent: CiRunnerProvisioningIntent;
    workflowJobId: number;
    projectId: string;
    encodedJitConfig: string;
    timeoutSeconds: number;
    orchestrator: ContainerOrchestrator;
    /** The region to boot in — the account's (MOTIR-8964). Absent = the
     *  process-wide fleet's; empty = the orchestrator's own default. */
    region?: string;
  }): ContainerSpec {
    const { intent, workflowJobId, projectId, encodedJitConfig, timeoutSeconds } = input;
    // Provider-neutral: the image is the fleet's, whichever account boots it, and
    // the region is the account's — read through the composition root, so this
    // service names no adapter's config (MOTIR-8964).
    const image = fleetRunnerImage();
    const region = input.region ?? fleetRunnerRegion();

    return {
      orgId: intent.organizationId,
      workspaceId: intent.workspaceId,
      projectId,
      repoFullName: `${intent.repoOwner}/${intent.repoName}`,
      // This service boots CI RUNNERS and nothing else. Saying so is what keeps
      // the machine's name and its fleet tag exactly what they were before the
      // port learned a second workload (MOTIR-2025).
      workload: CI_RUNNER_WORKLOAD,
      workflowJobId,
      image,
      size: FLEET_CONTAINER_SIZE,
      timeoutSeconds,
      region,
      // Native disk for the runner's Docker daemon (MOTIR-8839): on the Machine's
      // rootfs it can only use `vfs`, which fills the disk on the first
      // `services:` job.
      dockerVolumeGb: ciDockerVolumeGb(),
      env: {
        // The credential, injected at boot and never baked into the image (§4).
        ACTIONS_RUNNER_INPUT_JITCONFIG: encodedJitConfig,
        // ⚠️ `--no-default-labels`, which the card requires the boot to name.
        // The REAL guarantee is the JIT config: its `labels` array is the
        // runner's complete label set and GitHub adds no defaults to a JIT
        // runner. This flag is the second, independent statement of the same
        // requirement — the one that would still hold if the runner image ever
        // fell back to a `config.sh` path, where GitHub WOULD add
        // `self-hosted`/`Linux`/`X64` and a fleet runner would start matching
        // other tenants' `runs-on: self-hosted`.
        ACTIONS_RUNNER_CONFIG_ARGS: '--no-default-labels',
        MOTIR_RUNNER_LABEL,
        MOTIR_INTENT_ID: intent.id,
        MOTIR_WORKFLOW_JOB_ID: String(workflowJobId),
      },
    };
  },

  /** The pending-intent sweep — the BACKSTOP trigger (see the module header: the
   *  hot path is the webhook's, and admission latency is the wake's). Returns what
   *  it dispatched so the job can log it. */
  async listRunnableIntentIds(limit = 25): Promise<string[]> {
    if (!isOrchestratorConfigured()) return [];
    const pending = await withSystemContext((tx) => intents.listPending(limit, tx));
    return pending.map((intent) => intent.id);
  },

  /**
   * THE ADMISSION WAKE (MOTIR-2852) — a slot in this project just freed, so boot
   * whatever has been waiting for one.
   *
   * The moment a slot frees is an event this service ALREADY OBSERVES: an intent
   * leaving the in-flight set is a write it makes itself. Before this existed the
   * only thing that came back for a deferred intent was
   * `system.ci-runner-provision-sweep`, so the worst-case wait between a slot
   * freeing and a deferred job being admitted was the cron's cadence — which is
   * why that cadence had to be one minute, and why a database that suspends on
   * idle was billed around the clock to hold it. Dispatching here makes the cron a
   * genuine backstop rather than the mechanism.
   *
   * ⚠️ BEST-EFFORT, AND THAT IS STRUCTURAL RATHER THAN DEFENSIVE. Every caller is
   * a TEARDOWN, and a teardown that throws leaves a container's bookkeeping
   * half-written — the exact failure `settleSupervisedContainer`'s guarantee
   * exists to prevent. So nothing in here propagates: a read that throws and a
   * send that throws both resolve to an outcome the caller ignores, and the sweep
   * covers what was missed. The outcome is RETURNED rather than only logged so the
   * seam is assertable without reading stdout.
   *
   * ⚠️ IT DISPATCHES, IT DOES NOT ADMIT. The event re-enters the gate like any
   * other, so a wake fired into a fleet that is still at its ceiling is deferred
   * again and costs one refused boot. What it must never do is fire on a
   * DEFERRAL — see the `no wake on a deferral` note at `bootOnce`.
   */
  async dispatchNextPendingForProject(
    projectId: string | null,
  ): Promise<CiRunnerAdmissionWakeOutcome> {
    // No project means no project queue to wake. The slot is the ORG's (MOTIR-6907),
    // so another project's job may now fit — the provisioning sweep picks it up.
    if (!projectId) return 'no_project';
    if (!isOrchestratorConfigured()) return 'not_configured';
    try {
      const next = await withSystemContext((tx) =>
        intents.findNextPendingForProject(projectId, tx),
      );
      if (!next) return 'no_pending';
      return await dispatchCiRunnerBoot(next.id, 'admission-wake');
    } catch (err) {
      console.error('[ciRunnerBootService] the admission wake could not read its queue', {
        projectId,
        detail: detailOf(err),
      });
      return 'read_failed';
    }
  },
};

// ── the three bounded phases the durable poll loop drives ──────────────────

/**
 * The BOOT phase — admit + claim, resolve, mint, provision, record.
 *
 * This is the old `runIntent` up to and including `recordBoot`, unchanged in
 * behaviour and in the order it spends things. What changed is where it STOPS:
 * it hands back a session instead of falling into an hour-long supervision loop,
 * so it can live in a step.
 */
async function bootOnce(intentId: string, options: SupervisionOptions): Promise<BootResult> {
  const now = options.now ?? (() => new Date());
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const terminal = (outcome: RunIntentOutcome): BootResult => ({ phase: 'terminal', outcome });

  const intent = await withSystemContext((tx) => intents.findById(intentId, tx));
  if (!intent) return terminal({ outcome: 'unknown_intent' });

  if (!isOrchestratorConfigured()) return terminal({ outcome: 'not_configured' });

  // THE ADMISSION GATE, which also takes THE CLAIM (atomic `pending →
  // provisioning`; the loser simply stops — see `claimPending` for why the
  // predicate is the whole guard). Nothing below this line is reachable for an
  // intent the caps or the credit state declined, which is the point: every
  // line after it costs money.
  //
  // ⚠️ AND IT IS NOW INSIDE A STEP, which is what finally makes the claim
  // taken ONCE PER RUN rather than once per durable-replay pass (the defect
  // MOTIR-2002 had to carry a memo column to work around). Step memoization
  // gives that for free.
  const verdict = await ciRunnerAdmissionService.admit(intent);
  if (verdict.outcome === 'already_claimed') return terminal({ outcome: 'already_claimed' });
  if (verdict.outcome === 'deferred') {
    // ⚠️ NO WAKE ON A DEFERRAL, AND THAT IS A DECISION WITH A PROOF (MOTIR-2852).
    //
    // The obvious symmetry — a deferral means work is queued, so dispatch the
    // next pending intent for the project — DOES NOT TERMINATE. A deferral takes
    // no claim, so this intent is still `pending`, and it is ordinarily the
    // OLDEST pending intent for its project: `findNextPendingForProject` would
    // hand back the very row that just deferred, the boot would re-enter a gate
    // whose caps have not moved, and the two would trade events with no wait
    // between them. Excluding the trigger does not fix it either — two queued
    // intents then ping-pong. `tests/ciFleet/ciRunnerAdmissionWake.test.ts`
    // demonstrates the first turn of that loop against the real queue.
    //
    // Nor would it buy anything: a deferral IS the statement that no slot is
    // free, so there is nothing for a wake to admit. The event that changes the
    // answer is a slot being RELEASED, which is where the wake lives — see
    // `settleIntent`. Until then the intent waits, and the sweep is what comes
    // back for it.
    console.warn('[ciRunnerBootService] the admission gate deferred an intent', {
      intentId,
      reason: verdict.reason,
      detail: verdict.detail,
    });
    return terminal({ outcome: 'gate_deferred', reason: verdict.reason, detail: verdict.detail });
  }

  // ── Everything the boot needs, resolved before anything is spent ──────────
  if (!intent.projectId) {
    // No project means no runner group (§7.3) and no tenant the container's
    // cost could be attributed to. Both are disqualifying on their own.
    await settleFailed(intentId, null, 'provision_failed', 'the intent names no project');
    return terminal({ outcome: 'no_runner_group', detail: 'the intent names no project' });
  }

  const workflowJobId = Number(intent.jobId);
  if (!Number.isInteger(workflowJobId) || workflowJobId <= 0) {
    await settleFailed(
      intentId,
      intent.projectId,
      'provision_failed',
      'the intent has a malformed job id',
    );
    return terminal({ outcome: 'provision_failed', detail: 'the intent has a malformed job id' });
  }

  let runnerGroupId: number;
  try {
    // ⚠️ REFUSES rather than falling back. §7.3: never the `Default` group (id
    // 1, `visibility: "all"`), which would silently restore the cross-tenant
    // pickup the per-project group exists to prevent — a runner booted for
    // project X taking project Y's job, including one the gate DECLINED.
    //
    // Read in the org that owns the job's repository (MOTIR-8711): the same
    // `intent.repoOwner` `fleetRunnerTargetFor` keys the mint on, so the group
    // and the runner cannot land in different orgs.
    runnerGroupId = await projectRunnerGroupService.requireRunnerGroupIdFor(
      { projectId: intent.projectId, workspaceId: intent.workspaceId },
      intent.repoOwner,
    );
  } catch (err) {
    const detail =
      err instanceof RunnerGroupNotProvisionedError
        ? err.message
        : `could not read the project's runner group: ${detailOf(err)}`;
    await settleFailed(intentId, intent.projectId, 'provision_failed', detail);
    return terminal({ outcome: 'no_runner_group', detail });
  }

  // WHICH ACCOUNT boots it — the one admission chose and wrote at the claim
  // (MOTIR-8968); `null` = the process-wide fleet, today's path for a kind whose
  // switch is Fly. On the Fly path an unconfigured orchestrator is handled as a
  // process with none: claim released. An ACCOUNT that cannot be reached is a
  // provider outage and moves the job (below).
  let bootShardId: string | null = verdict.fleetShardId;
  let bootShard: FleetShardDTO | null = null;
  let orchestrator: ContainerOrchestrator | null = null;
  let accountUnreachable: unknown = null;
  if (bootShardId === null) {
    try {
      orchestrator = getOrchestrator();
    } catch (err) {
      await releaseClaim(intentId);
      console.warn('[ciRunnerBootService] no orchestrator is configured — claim released', {
        intentId,
        detail: detailOf(err),
      });
      return terminal({ outcome: 'not_configured' });
    }
  } else {
    try {
      bootShard = await fleetShardService.getShard(bootShardId);
      orchestrator = fleetShardOrchestratorService.forShardRow(bootShard);
    } catch (err) {
      accountUnreachable = err;
    }
  }

  // ── 1 · Mint the JIT config ───────────────────────────────────────────────
  // The credential the container receives. ONE runner, ONE config, no
  // registration capability inside the container (§7.4).
  const runnerName = runnerNameFor(intent);
  // The org the runner is registered in — the job repository's own, through the
  // installation the delivery arrived on; `undefined` for the provisioning org.
  const runnerTarget = fleetRunnerTargetFor(intent);
  let jit: Awaited<ReturnType<typeof runnerJitConfigClient.mint>>;
  try {
    jit = await runnerJitConfigClient.mint(
      {
        name: runnerName,
        runnerGroupId,
        // EXACTLY the one §M-compliant label. Not `self-hosted`, not `linux`, not
        // `x64`: a runner carrying GitHub's defaults would match some unrelated
        // tenant's `runs-on: self-hosted`, which is §7.3's cross-tenant pickup
        // arriving through the label axis instead of the group axis.
        labels: [MOTIR_RUNNER_LABEL],
      },
      runnerTarget,
    );
  } catch (err) {
    // THE LEDGER (MOTIR-8969): a refusal GitHub answered still spent a call on the
    // runner's org. A timeout or transport failure is not recorded.
    if (runnerCallReachedGithub(err)) {
      await runnerCallLedger.recordForTargetQuietly(runnerTarget, 'mint', verdict.fleetShardId);
    }
    if (err instanceof RunnerRegistrationRateLimitedError) {
      // Early, not broken. Release the claim and let the next sweep try — a
      // burst against GitHub's 1,500-per-5-minutes ceiling is the gate's
      // problem to shape (§6), not a reason to fail a job.
      await releaseClaim(intentId);
      return terminal({ outcome: 'rate_limited', retryAfterSeconds: err.retryAfterSeconds });
    }
    if (err instanceof RunnerJitTimeoutError) {
      // THE MINT WHOSE ANSWER NEVER CAME (MOTIR-2011). GitHub registers the
      // runner BEFORE it responds (§7.4), so a blown deadline is the one failure
      // that may have created a runner we were never told the id of — a dangling
      // registered runner with nothing to name it by. It is hunted down by NAME
      // first, because the alternative is an offline runner sitting in the org's
      // list indistinguishable from a wedged fleet runner.
      //
      // Then treated exactly like the ceiling: the job is EARLY, not broken.
      // Failing it would dead-letter a run whose only sin is that a third party
      // was slow, and `retryPolicy: 'none'` means dead-lettered is where it would
      // stay.
      await deregisterByNameQuietly(runnerName, intentId, runnerTarget);
      await releaseClaim(intentId);
      console.warn('[ciRunnerBootService] the JIT mint blew its deadline — claim released', {
        intentId,
        runnerName,
        timeoutMs: err.timeoutMs,
      });
      return terminal({ outcome: 'rate_limited', retryAfterSeconds: null });
    }
    if (err instanceof OrgTargetAuthError) {
      // The installation token for a connected org could not be minted
      // (MOTIR-8711). GitHub UNREACHABLE is early, not broken — the same answer
      // as a blown deadline. A REFUSAL (403, 404, …) is the installation lacking
      // the grant or the App being gone: no retry fixes that, so the job settles
      // with the org, the installation and the status named. Never a token.
      if (err.status === null) {
        await releaseClaim(intentId);
        console.warn(
          '[ciRunnerBootService] GitHub unreachable minting an org token — claim released',
          {
            intentId,
            org: err.org,
            installationId: err.installationId,
          },
        );
        return terminal({ outcome: 'rate_limited', retryAfterSeconds: null });
      }
      const detail =
        `could not mint a JIT config in ${err.org}: installation ${err.installationId} ` +
        `was refused a token (HTTP ${err.status})`;
      await settleFailed(intentId, intent.projectId, 'provision_failed', detail);
      return terminal({ outcome: 'provision_failed', detail });
    }
    const detail = `could not mint a JIT config: ${detailOf(err)}`;
    await settleFailed(intentId, intent.projectId, 'provision_failed', detail);
    return terminal({ outcome: 'provision_failed', detail });
  }

  await runnerCallLedger.recordForTargetQuietly(runnerTarget, 'mint', verdict.fleetShardId);

  // Persist the runner id BEFORE booting. `generate-jitconfig` has already
  // registered the runner (§7.4), so from here on a crash without this column
  // would leave a dangling registered runner nobody can name.
  await withSystemContext((tx) =>
    intents.recordMintedRunner(
      intentId,
      { githubRunnerId: jit.runnerId, runnerName: jit.runnerName },
      tx,
    ),
  );

  // ── 2 · Boot exactly one container ────────────────────────────────────────
  const specFor = (shard: FleetShardDTO | null, through: ContainerOrchestrator) =>
    ciRunnerBootService.buildSpec({
      intent,
      workflowJobId,
      projectId: intent.projectId!,
      encodedJitConfig: jit.encodedJitConfig,
      timeoutSeconds: Math.ceil(jobTimeoutMs / 1000),
      orchestrator: through,
      ...(shard ? { region: shard.fly?.region ?? shard.aws?.region ?? '' } : {}),
    });

  // THE IN-BOOT MOVE (AMENDMENT 1, MOTIR-8968). An account that refuses for
  // capacity or is down is paused, and the SAME boot moves to the next account
  // of the kind with the SAME JIT config — the runner's GitHub org is the repo's
  // whichever account boots it, so nothing is re-minted. With no account left
  // the job defers `shard_capacity`; it is never `provision_failed` for a
  // capacity reason and never sent to Fly.
  const tried = new Set<string>();
  let spec: ContainerSpec | null = null;
  let handle: ContainerHandle | null = null;
  for (;;) {
    let refusal: unknown = accountUnreachable;
    if (refusal === null) {
      spec = specFor(bootShard, orchestrator!);
      try {
        handle = await orchestrator!.provision(spec);
        break;
      } catch (err) {
        refusal = err;
      }
    }
    accountUnreachable = null;

    const reason = bootShardId === null ? 'job_fault' : classifyProvisionRefusal(refusal);
    if (bootShardId === null || reason === 'job_fault') {
      return failedProvision(refusal);
    }

    const refusedId = bootShardId;
    tried.add(refusedId);
    console.warn('[ciRunnerBootService] an account refused the provision — moving the job', {
      intentId,
      shardId: refusedId,
      reason,
      detail: detailOf(refusal),
    });
    const nextId = await withSystemContext(async (tx) => {
      await locks.ensureScope(FLEET_ADMISSION_SCOPE, tx);
      if (!(await locks.lockScope(FLEET_ADMISSION_SCOPE, tx))) {
        throw new Error('the fleet admission lock could not be taken');
      }
      return fleetShardAdmissionService.moveAfterRefusalInTx(
        intent,
        refusedId,
        reason,
        tried,
        now(),
        tx,
      );
    });
    if (nextId === null) {
      await deregisterQuietly(jit.runnerId, intentId, runnerTarget);
      await ciRunnerAdmissionService.releaseClaimForShardCapacity(intentId, now());
      console.warn('[ciRunnerBootService] every account of the kind refused — deferred', {
        intentId,
        tried: [...tried],
      });
      return terminal({
        outcome: 'gate_deferred',
        reason: 'shard_capacity',
        detail: SHARD_CAPACITY_DETAIL,
      });
    }
    bootShardId = nextId;
    bootShard = null;
    try {
      bootShard = await fleetShardService.getShard(nextId);
      orchestrator = fleetShardOrchestratorService.forShardRow(bootShard);
    } catch (err) {
      accountUnreachable = err;
    }
  }

  async function failedProvision(err: unknown): Promise<BootResult> {
    // A MINTED-BUT-UNUSED JIT CONFIG. The runner is registered at GitHub and no
    // container will ever claim it, so it is de-registered here rather than
    // left to GitHub — which does not clean it up (§7.4, verified).
    await deregisterQuietly(jit.runnerId, intentId, runnerTarget);

    // ⚠️ §6.2 of `docs/decisions/fleet-image-pull.md` — AN UNPULLABLE IMAGE IS
    // ITS OWN NAMED CONDITION, not a generic boot failure. It is the one
    // provisioning failure that is about the DEPLOYMENT rather than about this
    // job, so it settles with a detail that says which image and what the
    // registry said, and returns an outcome an operator can filter on.
    //
    // The teardown reason stays `provision_failed`: that column records how a
    // CONTAINER ended, and here there was never a container to end. Widening it
    // would put a boot-time diagnosis in a teardown vocabulary — and every
    // consumer of that enum would have to learn a value it can never observe.
    if (err instanceof OrchestratorImageUnpullableError) {
      const detail = `the runner image could not be pulled: ${detailOf(err)}`;
      console.error('[ciRunnerBootService] the runner image is not pullable', {
        intentId,
        image: err.imageReference,
        detail: detailOf(err),
      });
      await settleFailed(intentId, intent!.projectId, 'provision_failed', detail);
      return terminal({ outcome: 'image_unpullable', detail });
    }

    const detail = `could not boot a container: ${detailOf(err)}`;
    // A provider refusal or a blown deadline is transient until it repeats: the
    // intent goes back to the pool rather than taking a runner away from the jobs
    // queued at GitHub (MOTIR-8941).
    const attempt = intent!.bootAttempts + 1;
    if (attempt < MAX_BOOT_ATTEMPTS) {
      await ciRunnerAdmissionService.releaseClaimForRetry(intentId);
      console.warn('[ciRunnerBootService] the boot failed — claim released for another attempt', {
        intentId,
        attempt,
        detail,
      });
      return terminal({ outcome: 'rate_limited', retryAfterSeconds: null });
    }
    await settleFailed(intentId, intent!.projectId, 'provision_failed', detail);
    return terminal({ outcome: 'provision_failed', detail });
  }

  if (!handle || !spec) throw new Error('unreachable: the boot loop exits only with a handle');
  const bootedAt = now();
  await withSystemContext((tx) =>
    intents.recordBoot(
      intentId,
      {
        containerProvider: handle.provider,
        containerId: handle.id,
        containerRegion: handle.region,
        githubRunnerId: jit.runnerId,
        runnerName: jit.runnerName,
        bootedAt,
        fleetShardId: bootShardId,
      },
      tx,
    ),
  );

  // ── 3 · Hand the loop everything it needs, as JSON ────────────────────────
  return {
    phase: 'supervising',
    session: {
      intentId,
      handle: {
        provider: handle.provider,
        id: handle.id,
        region: handle.region,
        createdAt: handle.createdAt.toISOString(),
        ...(handle.volumeId ? { volumeId: handle.volumeId } : {}),
        ...(bootShardId ? { shardId: bootShardId } : {}),
      },
      githubRunnerId: jit.runnerId,
      runnerTarget: runnerTarget ?? null,
      image: spec.image,
      bootedAt: bootedAt.toISOString(),
      queuedAt: intent.queuedAt.toISOString(),
      attribution: {
        orgId: intent.organizationId,
        workspaceId: intent.workspaceId,
        projectId: intent.projectId,
        repoFullName: `${intent.repoOwner}/${intent.repoName}`,
        workflowJobId,
      },
    },
  };
}

/**
 * ONE provider read, the deadlines applied to it, and a return.
 *
 * ⚠️ NEVER THROWS — see the module header. Every failure becomes a typed result,
 * because the only exit from the loop must be one the caller can take to
 * teardown.
 */
async function pollContainerOnce(
  session: SupervisionSession,
  previous: Extract<PollResult, { done: false }>,
  options: SupervisionOptions,
): Promise<PollResult> {
  const now = options.now ?? (() => new Date());
  const bootDeadlineMs = options.bootDeadlineMs ?? DEFAULT_BOOT_DEADLINE_MS;
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const bootedAt = new Date(session.bootedAt).getTime();
  const queuedAt = new Date(session.queuedAt).getTime();

  let startedAt = previous.startedAt;
  let bootLatencyMs = previous.bootLatencyMs;

  /** The deadline check both the happy and the failed-read paths fall through
   *  to, so a provider that is down can never extend a container past its
   *  timeout. */
  const deadlineVerdict = (
    failureDetail: string | null,
    lastState: string | undefined,
  ): PollResult | null => {
    const elapsed = now().getTime() - bootedAt;
    if (!startedAt && elapsed >= bootDeadlineMs) {
      // ⚠️ NAME WHAT THE CONTAINER WAS DOING (MOTIR-9348). A bare
      // `provision_failed` is indistinguishable from every other boot failure,
      // and the usual cause — a pull that never finishes — is visible only in
      // the provider's own logs. The state and the image say it on the intent.
      return {
        done: true,
        reason: 'provision_failed',
        startedAt: null,
        bootLatencyMs: null,
        failureDetail:
          `the container never started within ${bootDeadlineMs / 1000} s ` +
          `(last provider state: ${lastState || 'unknown'}; image ${session.image ?? 'unknown'})`,
      };
    }
    if (elapsed >= jobTimeoutMs) {
      return { done: true, reason: 'job_timed_out', startedAt, bootLatencyMs, failureDetail };
    }
    return null;
  };

  let status;
  try {
    status = await (
      await orchestratorFor(session)
    ).describe({
      provider: session.handle.provider,
      id: session.handle.id,
      region: session.handle.region,
      createdAt: new Date(session.handle.createdAt),
      ...(session.handle.volumeId ? { volumeId: session.handle.volumeId } : {}),
    });
  } catch (err) {
    // ⚠️ A SINGLE PROVIDER BLIP MUST NOT KILL A CUSTOMER'S JOB. Without this
    // tolerance one 500 from the provider ends a healthy CI run for a reason
    // that has nothing to do with the customer's code. The deadlines are still
    // the real bound — this only buys the loop the right to MISS a few reads,
    // never the right to run longer.
    const consecutiveReadFailures = previous.consecutiveReadFailures + 1;
    const detail = detailOf(err);
    if (consecutiveReadFailures > MAX_CONSECUTIVE_READ_FAILURES) {
      // Give up on reading, but NOT on tearing down: a `done` verdict is what
      // routes this to teardown, which is why this returns rather than throws.
      return {
        done: true,
        reason: 'job_timed_out',
        startedAt,
        bootLatencyMs,
        failureDetail: `the container status could not be read: ${detail}`,
      };
    }
    console.warn('[ciRunnerBootService] a container status read failed — retrying', {
      containerId: session.handle.id,
      provider: session.handle.provider,
      consecutiveReadFailures,
      detail,
    });
    return (
      deadlineVerdict(null, previous.lastState) ?? {
        done: false,
        startedAt,
        bootLatencyMs,
        consecutiveReadFailures,
        ...(previous.lastState !== undefined ? { lastState: previous.lastState } : {}),
      }
    );
  }

  if (status.startedAt && !startedAt) {
    startedAt = status.startedAt.toISOString();
    // ⚠️ MEASURED FROM `queuedAt`, GitHub's own instant — not from our receipt
    // of the webhook and not from the boot. §6's budget is the span a USER
    // experiences as "CI is slow to start", and the queue time before Motir even
    // heard about the job is part of that.
    bootLatencyMs = Math.max(0, status.startedAt.getTime() - queuedAt);
  }

  if (status.terminal) {
    // Gone or stopped. If it never started, the runner never registered — the
    // "boot succeeded but nothing came up" path, which is a provisioning
    // failure even though the provider reported success.
    const observed = startedAt ?? status.startedAt?.toISOString() ?? null;
    return {
      done: true,
      reason: observed ? 'job_completed' : 'provision_failed',
      startedAt: observed,
      bootLatencyMs,
      failureDetail: null,
    };
  }

  return (
    deadlineVerdict(null, status.state) ?? {
      done: false,
      startedAt,
      bootLatencyMs,
      consecutiveReadFailures: 0,
      lastState: status.state,
    }
  );
}

/**
 * TEARDOWN — what used to be `runIntent`'s `finally`, as an ordinary step on the
 * loop's only exit.
 */
async function settleSupervisedContainer(
  session: SupervisionSession,
  verdict: Extract<PollResult, { done: true }>,
  options: SupervisionOptions,
): Promise<RunIntentOutcome> {
  const now = options.now ?? (() => new Date());
  const { intentId } = session;
  const observedStartedAt = verdict.startedAt ? new Date(verdict.startedAt) : null;
  const handle: ContainerHandle = {
    provider: session.handle.provider,
    id: session.handle.id,
    region: session.handle.region,
    createdAt: new Date(session.handle.createdAt),
    ...(session.handle.volumeId ? { volumeId: session.handle.volumeId } : {}),
  };

  // The started instant is recorded here rather than mid-loop: it is known once
  // and only matters once, and a write per poll would be a write per step.
  if (observedStartedAt && verdict.bootLatencyMs !== null) {
    await withSystemContext((tx) =>
      intents.recordStarted(intentId, observedStartedAt, verdict.bootLatencyMs as number, tx),
    );
  }

  let orchestrator: ContainerOrchestrator;
  try {
    orchestrator = await orchestratorFor(session);
  } catch (err) {
    // No orchestrator to tear down THROUGH. Leave the intent in flight for the
    // reaper rather than settling a container that may still be running.
    console.error('[ciRunnerBootService] no orchestrator at teardown — left for the reaper', {
      intentId,
      containerId: handle.id,
      detail: detailOf(err),
    });
    return {
      outcome: 'provision_failed',
      detail: `no orchestrator at teardown for container ${handle.id}; left for the reaper`,
    };
  }

  // ⚠️ THE GUARANTEE. Every path out of supervision arrives here — completed,
  // timed out, never started, and unreadable. `teardown` is idempotent, so the
  // reaper reaching the same container later is harmless.
  const usage = await teardownQuietly(orchestrator, handle, verdict.reason, {
    orgId: session.attribution.orgId,
    workspaceId: session.attribution.workspaceId,
    projectId: session.attribution.projectId,
    repoFullName: session.attribution.repoFullName,
    workload: CI_RUNNER_WORKLOAD,
    workflowJobId: session.attribution.workflowJobId,
    size: FLEET_CONTAINER_SIZE,
    observedStartedAt,
  });
  await deregisterQuietly(session.githubRunnerId, intentId, session.runnerTarget ?? undefined);

  if (usage) {
    await recordContainerUsage(usage);
    await settleIntent(intentId, session.attribution.projectId, {
      status:
        verdict.reason === 'job_completed' ? CI_RUNNER_INTENT_COMPLETED : CI_RUNNER_INTENT_FAILED,
      teardownReason: verdict.reason,
      settledAt: now(),
      failureDetail: verdict.failureDetail,
      startedAt: observedStartedAt,
      bootLatencyMs: verdict.bootLatencyMs,
    });
    return {
      outcome: 'settled',
      reason: verdict.reason,
      containerId: handle.id,
      billableSeconds: usage.billableSeconds,
      costUsd: usage.costUsd,
      bootLatencyMs: verdict.bootLatencyMs,
      usage,
    };
  }

  // Teardown itself failed. The intent stays IN FLIGHT deliberately: marking it
  // settled would hide a container that may still be running from the one
  // mechanism that can still catch it. The reaper owns it now.
  console.error(
    '[ciRunnerBootService] teardown failed — the intent is left in flight for the reaper',
    { intentId, containerId: handle.id, provider: handle.provider },
  );
  return {
    outcome: 'provision_failed',
    detail: `teardown failed for container ${handle.id}; left for the reaper`,
  };
}

/** The orchestrator a session's container lives on — its account's, or the
 *  process-wide fleet's for a session with none (MOTIR-8964). Re-read per step
 *  rather than carried across the boundary, because an adapter is not
 *  serializable — the handle is, which is exactly why the port made it opaque. */
async function orchestratorFor(session: SupervisionSession): Promise<ContainerOrchestrator> {
  return fleetShardOrchestratorService.forShard(session.handle.shardId ?? null);
}

// ── internals ─────────────────────────────────────────────────────────────

/** Tear down, swallowing a failure into null. The caller decides what a null
 *  means; what it must NOT do is propagate out of a `finally` and mask the
 *  reason the code got there. */
async function teardownQuietly(
  orchestrator: ContainerOrchestrator,
  handle: ContainerHandle,
  reason: TeardownReason,
  attribution: UsageAttribution,
) {
  try {
    return await orchestrator.teardown(handle, reason, attribution);
  } catch (err) {
    console.error('[ciRunnerBootService] could not tear down a container', {
      containerId: handle.id,
      provider: handle.provider,
      reason,
      detail: detailOf(err),
    });
    return null;
  }
}

/** De-register the GitHub runner. Idempotent and best-effort: on the happy path
 *  the ephemeral runner already de-registered itself and GitHub answers 404,
 *  which the client treats as success. */
async function deregisterQuietly(
  runnerId: number | null,
  intentId: string,
  target: GithubOrgTarget | undefined,
): Promise<void> {
  if (runnerId === null) return;
  try {
    await runnerJitConfigClient.deleteRunner(runnerId, target);
    await runnerCallLedger.recordForTargetQuietly(target, 'delete', null);
  } catch (err) {
    if (runnerCallReachedGithub(err)) {
      await runnerCallLedger.recordForTargetQuietly(target, 'delete', null);
    }
    console.error(
      '[ciRunnerBootService] could not de-register a runner — it may be left dangling',
      { intentId, runnerId, detail: detailOf(err) },
    );
  }
}

/**
 * De-register the runner a TIMED-OUT mint may have registered — the only cleanup
 * path that has no id to work from (MOTIR-2011).
 *
 * Quiet for the same reason {@link deregisterQuietly} is: this runs on a failure
 * path whose job is already going back in the queue, and a cleanup that throws
 * would replace a retryable outcome with an untyped one. A runner that could not
 * be removed is logged loudly and left to `sweepStaleClaims`.
 */
async function deregisterByNameQuietly(
  runnerName: string,
  intentId: string,
  target: GithubOrgTarget | undefined,
): Promise<void> {
  try {
    const removed = await runnerJitConfigClient.deleteRunnersNamed(runnerName, target);
    // One `delete` per runner it removed (MOTIR-8969).
    await runnerCallLedger.recordForTargetQuietly(target, 'delete', null, removed.length);
    if (removed.length > 0) {
      console.warn('[ciRunnerBootService] de-registered a runner left by a timed-out mint', {
        intentId,
        runnerName,
        runnerIds: removed,
      });
    }
  } catch (err) {
    console.error(
      '[ciRunnerBootService] could not de-register a timed-out mint — a runner may be dangling',
      { intentId, runnerName, detail: detailOf(err) },
    );
  }
}

/**
 * Move one intent to a terminal status — AND WAKE ITS PROJECT (MOTIR-2852).
 *
 * ⚠️ `projectId` IS REQUIRED, POSITIONALLY, AND THAT IS THE POINT. Every settle is
 * an intent leaving the in-flight set (`provisioning` / `running`), which is
 * exactly what {@link ciRunnerProvisioningIntentRepository.countInFlightForOrganization}
 * counts — so every settle frees a slot, and there is no such thing as a settle
 * that should not wake. Threading the project through the ONE funnel every path
 * already goes through makes that total by construction: a new terminal path
 * cannot be added without the compiler asking whose slot it just freed. Pass
 * `null` only where the intent genuinely names no project.
 *
 * The wake runs only when the settle COMMITTED. A settle that threw freed no
 * slot — the intent is still in flight, and waking on it would dispatch a boot
 * into capacity that is still occupied.
 */
async function settleIntent(
  intentId: string,
  projectId: string | null,
  record: {
    status: string;
    teardownReason: string | null;
    settledAt: Date;
    failureDetail: string | null;
    startedAt?: Date | null;
    bootLatencyMs?: number | null;
  },
): Promise<void> {
  try {
    await withSystemContext((tx) => intents.settle(intentId, record, tx));
  } catch (err) {
    console.error('[ciRunnerBootService] could not settle an intent', {
      intentId,
      detail: detailOf(err),
    });
    return;
  }
  await ciRunnerBootService.dispatchNextPendingForProject(projectId);
}

async function settleFailed(
  intentId: string,
  projectId: string | null,
  reason: TeardownReason,
  detail: string,
): Promise<void> {
  await settleIntent(intentId, projectId, {
    status: CI_RUNNER_INTENT_FAILED,
    teardownReason: reason,
    settledAt: new Date(),
    failureDetail: detail.slice(0, 300),
  });
}

/** Put a claimed intent back in the pending pool — for refusals that are about
 *  the ENVIRONMENT (unconfigured, rate-limited) rather than about the job. The
 *  gate releases the same way for a credit refusal, through the same repository
 *  method, so a re-queued intent looks identical whichever path re-queued it. */
async function releaseClaim(intentId: string): Promise<void> {
  await ciRunnerAdmissionService.releaseClaim(intentId);
}

/**
 * The attribution a torn-down container's usage row carries, recovered from the
 * PERSISTED record — the CI intent that names it, or, for a hosted-agent machine,
 * its own live checkpoint row (MOTIR-6524). Null when nothing owns it, or when
 * what owns it cannot be attributed (a deleted project, a malformed job id).
 */
async function resolveReapAttribution(handle: ContainerHandle): Promise<{
  attribution: UsageAttribution;
  hosted: LiveAgentUsage | null;
  /** The account the CI intent recorded its container in; null otherwise. */
  shardId: string | null;
} | null> {
  const intent = await withSystemContext((tx) =>
    intents.findByContainerId(handle.provider, handle.id, tx),
  );
  if (!intent) {
    const hosted = await withSystemContext((tx) =>
      ciContainerUsageRepository.findLiveAgentUsageByHandle(handle.provider, handle.id, tx),
    );
    // A deleted project leaves nothing to attribute to — the same null an intent
    // without one answers.
    if (!hosted?.projectId) return null;
    return {
      hosted,
      shardId: null,
      attribution: {
        orgId: hosted.organizationId,
        workspaceId: hosted.workspaceId,
        projectId: hosted.projectId,
        // Overwritten with the row's own value (null for a multi-repo handle)
        // before the usage is recorded.
        repoFullName: hosted.repoFullName ?? '',
        workload: HOSTED_AGENT_WORKLOAD,
        workflowJobId: null,
        size: {
          cpuKind: hosted.cpuKind === 'performance' ? 'performance' : 'shared',
          cpus: hosted.cpus,
          memoryMb: hosted.memoryMb,
        },
        observedStartedAt: hosted.containerStartedAt,
      },
    };
  }
  if (!intent.projectId) return null;
  const workflowJobId = Number(intent.jobId);
  if (!Number.isInteger(workflowJobId)) return null;
  return {
    hosted: null,
    shardId: intent.fleetShardId,
    attribution: {
      orgId: intent.organizationId,
      workspaceId: intent.workspaceId,
      projectId: intent.projectId,
      repoFullName: `${intent.repoOwner}/${intent.repoName}`,
      workload: CI_RUNNER_WORKLOAD,
      workflowJobId,
      size: FLEET_CONTAINER_SIZE,
      // A reaped container's start instant is whatever the provider still
      // reports; this process never observed it (that is what made it an orphan).
      observedStartedAt: intent.startedAt,
    },
  };
}

/**
 * Intents claimed but never booted — the crash-between-mint-and-boot window.
 *
 * The container (if any) is the provider's problem and the reaper's; what is
 * left HERE is a registered GitHub runner with no machine, which is exactly the
 * dangling-JIT case §7.4 requires be de-registered rather than left. This is
 * where the `githubRunnerId` written before the boot earns its column.
 */
async function sweepStaleClaims(now: () => Date): Promise<number> {
  const claimedBefore = new Date(now().getTime() - STALE_CLAIM_MS);
  const stale = await withSystemContext((tx) => intents.listStaleClaims(claimedBefore, 50, tx));
  for (const intent of stale) {
    await deregisterQuietly(intent.githubRunnerId, intent.id, fleetRunnerTargetFor(intent));
    await settleIntent(intent.id, intent.projectId, {
      status: CI_RUNNER_INTENT_FAILED,
      teardownReason: 'provision_failed',
      settledAt: now(),
      failureDetail: 'claimed but never booted; the minted runner was de-registered',
    });
  }
  return stale.length;
}

/** How many in-flight intents one vanished-container sweep checks — a ceiling, so
 *  a backlog drains across passes instead of one pass making hundreds of reads. */
const VANISHED_SWEEP_BATCH = 50;

/** The grace past an intent's end before its missing container is believed: the
 *  same ten minutes the reconciler gives a machine (`fleet-per-org-pool.md` §5). */
const VANISHED_SWEEP_GRACE_MS = 10 * 60_000;

/** Provider states that mean the container is being or has been destroyed even
 *  though the provider still answers a read for it. */
const VANISHED_STATES: ReadonlySet<string> = new Set(['destroyed', 'destroying']);

async function sweepVanishedInFlight(now: () => Date): Promise<number> {
  const bootedBefore = new Date(now().getTime() - DEFAULT_REAP_AFTER_MS - VANISHED_SWEEP_GRACE_MS);
  const candidates = await withSystemContext((tx) =>
    intents.listInFlightBootedBefore(bootedBefore, VANISHED_SWEEP_BATCH, tx),
  );
  let settled = 0;
  for (const intent of candidates) {
    if (!intent.containerId) continue;
    let gone: boolean;
    try {
      // Asked of the account the container was booted in (MOTIR-8964).
      const orchestrator = await fleetShardOrchestratorService.forIntent(intent);
      // A container another provider booted cannot be asked about here; the
      // deployment that owns that provider sweeps it.
      if (intent.containerProvider !== orchestrator.provider) continue;
      const status = await orchestrator.describe({
        provider: orchestrator.provider,
        id: intent.containerId,
        region: intent.containerRegion ?? '',
        createdAt: intent.bootedAt ?? intent.createdAt,
      });
      // ⚠️ A DESTROYED MACHINE CAN STILL BE READ. Fly answers a destroyed
      // machine with its record (`state: destroyed`) for a while before the
      // read 404s, and the inventory no longer lists it — so the reconciler
      // cannot reach it either. Treat that record as gone, not as alive.
      gone = !status.exists || VANISHED_STATES.has(status.state);
    } catch (err) {
      // An unreadable provider is never evidence the container is gone.
      console.warn(
        '[ciRunnerBootService] could not read an in-flight container — left for the next pass',
        {
          intentId: intent.id,
          containerId: intent.containerId,
          detail: detailOf(err),
        },
      );
      continue;
    }
    if (!gone) continue;

    await deregisterQuietly(intent.githubRunnerId, intent.id, fleetRunnerTargetFor(intent));
    await settleIntent(intent.id, intent.projectId, {
      status: CI_RUNNER_INTENT_FAILED,
      teardownReason: intent.startedAt ? 'job_timed_out' : 'provision_failed',
      settledAt: now(),
      failureDetail:
        `container ${intent.containerId} no longer exists and its supervision never settled ` +
        'the intent; settled by the fleet sweep and its runner de-registered',
    });
    settled += 1;
  }
  return settled;
}

/**
 * The runner's NAME at GitHub. Deterministic and attributable, for the reason
 * `runnerGroupNameFor` is: an offline runner left in the org's list is traceable
 * to the job it was minted for with no reverse lookup.
 *
 * GitHub caps runner names at 64 characters, and a cuid intent id plus the prefix
 * fits comfortably — but it is truncated rather than trusted, because a name
 * GitHub refuses would fail the mint and queue the job for 24 hours.
 */
function runnerNameFor(intent: CiRunnerProvisioningIntent): string {
  return `motir-${intent.id}`.slice(0, 64);
}
