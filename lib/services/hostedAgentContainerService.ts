import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  HostedAgentContainerRequestInvalidError,
  HostedAgentContainerUnpricedError,
} from '@/lib/ciFleet/errors';
import { fleetCeilingService, type FleetSlotVerdict } from '@/lib/services/fleetCeilingService';
import {
  classifyProvisionRefusal,
  HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
} from '@/lib/services/fleetShardAdmissionService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { hostedRunChargeService } from '@/lib/services/hostedRunChargeService';
import {
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
  getOrchestrator,
  hostedAgentImage,
  recordContainerAccrual,
  recordContainerUsage,
} from '@/lib/orchestrator';
import {
  buildContainerAccrual,
  resolveContainerRate,
  type ContainerAccrual,
  type ContainerHandle,
  type ContainerOrchestrator,
  type ContainerSize,
  type ContainerSpec,
  type ContainerUsage,
  type ContainerWorkSlice,
  type TeardownReason,
  type UsageAttribution,
} from '@motir/orchestrator';
import {
  driveSupervisionInProcess,
  inProcessMemoSteps,
  type MemoizingSteps,
} from '@/lib/jobs/supervision/inProcessSteps';
import {
  advanceSupervision,
  deferSettledSupervision,
  inMemorySupervisionStore,
  type SupervisionStore,
  type SupervisionTerminalReason,
} from '@/lib/jobs/supervision/driver';

// THE HOSTED-AGENT METERING SEAM (Story MOTIR-4336 · MOTIR-4713) — boot ONE
// container under the `hosted_agent` workload, checkpoint what it costs while it
// runs, and settle it.
//
// ⚠️ WHY THIS EXISTS BEFORE THE AGENT DOES. Every part of the meter was shipped
// ahead of Epic 9 — the workload is in the registry, `agent` is mapped as its cost
// line, `recordContainerAccrual` was written with this workload named in its
// comment, and the rollup has a slot for the line — and nothing ever booted a
// container under it. A meter with no writer reads, from every document, exactly
// like a meter that works. This is the writer, proven against a stand-in image, so
// Epic 9's orchestration (MOTIR-690) COMPOSES a metered lifecycle rather than
// re-deriving one under launch pressure.
//
// ⚠️ IT CARRIES NONE OF THE AGENT'S SEMANTICS, deliberately. No prompt, no
// run-scoped token, no gateway key, no pull request, no run record — those are the
// composer's. What lives here is the MACHINE: how long it existed, what that cost,
// and that its fleet slot is held for exactly that long. Keeping the two apart is
// what stops "is it metered?" depending on "did the orchestration get it right?".
//
// It is `codeGraphIndexDispatchService`'s three-operation shape, and deliberately
// so: BOOT and SETTLE are the side effects a durable step memoizes; POLL is one
// provider read that never throws; `advance` is one pass of the shared supervision
// driver; `run` drives it to completion in-process for a caller with no job row.
//
// ⚠️ THE FOUR THINGS THAT ARE THIS WORKLOAD'S OWN, not inherited from the index loop:
//
//   1. THE SLOT TTL is derived from the REQUEST's run timeout plus a margin
//      ({@link hostedAgentSlotTtlSeconds}) — never the fleet-wide 6 h default,
//      which is shorter than an agent run may legitimately be and would let the
//      ceiling stop counting a container still spending
//      (`code-graph-index-fleet.md` §11.1).
//   2. THE POLL CADENCE backs off to a MINUTE ({@link AGENT_MAX_POLL_INTERVAL_MS}),
//      because a container that lives hours needs neither the index loop's
//      15-second exit-code chase nor fifteen reads a minute.
//   3. AN UNPRICED MACHINE CLASS IS REFUSED BEFORE ANYTHING IS SPENT
//      ({@link HostedAgentContainerUnpricedError}). The meter's zero-rate fallback
//      is right for a container that already ran and wrong for the one workload
//      whose price the lane multiplier depends on.
//   4. A RUN OVER A CARD SET MAY SPAN REPOSITORIES (MOTIR-1790), so the settle can
//      attribute the handle's seconds across repo SLICES (MOTIR-3255's shape).
//
// ⚠️ THE METER STAYS COGS — NO ENTITLEMENT, NO CREDIT MATH AND NO `isMeta` BRANCH
// HERE. What this seam writes is what the machine cost MOTIR, and it measures
// Motir's own org like any tenant (`code-graph-index-fleet.md` §9).
//
// The CUSTOMER'S charge for the same machine time (MOTIR-6514,
// `docs/decisions/hosted-agent-machine-charge.md`) is a SEPARATE READER of the
// settled seconds, `hostedRunChargeService`: this file only CALLS it, once a settle
// that names a run has committed, as its own memoized step after the settle step
// ({@link hostedAgentChargeStepId}). The rate, the rounding and the motir-ai call
// all live there, so a price never feeds back into the meter and the meter's cost
// figure never becomes a price. A charge that cannot reach motir-ai never holds
// the teardown — the container is gone and its slot released before it runs — and
// is retried on the next pass until it lands.

/** This service boots HOSTED-AGENT containers and nothing else. */
const HOSTED_AGENT_WORKLOAD = 'hosted_agent' satisfies FleetWorkloadKind;

/** A hosted-agent container serves no GitHub job — `ContainerSpec.workflowJobId`. */
const NO_WORKFLOW_JOB = null;

/** The supervision kind this service owns on a `job_supervision` row. */
export const HOSTED_AGENT_SUPERVISION_KIND = 'hosted-agent';

/** The memoized step ids a pass replays. Exported because the abandoned-
 *  supervision sweep reads the BOOT memo back by exactly this id. */
export function hostedAgentBootStepId(dispatchId: string): string {
  return `hosted-agent-boot:${dispatchId}`;
}
export function hostedAgentSettleStepId(dispatchId: string): string {
  return `hosted-agent-settle:${dispatchId}`;
}
/** The machine-time charge that follows a settle naming a run (MOTIR-6514). A
 *  step of its own, AFTER the settle step, so a charge that could not land is
 *  retried without the settle's side effects repeating. */
export function hostedAgentChargeStepId(dispatchId: string): string {
  return `hosted-agent-charge:${dispatchId}`;
}

/**
 * How long a pass waits before retrying a machine charge that could not reach
 * motir-ai. A minute, the supervision's own ceiling cadence: the container is
 * already gone, so waiting costs nothing but the charge's latency.
 */
export const HOSTED_AGENT_CHARGE_RETRY_MS = 60_000;

/** Thrown INSIDE the charge step so the engine does not memoize a failure. */
class HostedAgentChargeNotLandedError extends Error {
  constructor(readonly detail: string) {
    super(`the hosted run's machine charge did not land: ${detail}`);
    this.name = 'HostedAgentChargeNotLandedError';
  }
}

/** How long a container has to reach a running state before it is written off as
 *  a boot that never happened — the figure both other fleets use. */
const DEFAULT_BOOT_DEADLINE_MS = 120_000;

/** How soon after boot supervision first asks the provider about the container. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/** The index loop's ceiling. The agent cadence may never be FASTER than it. */
const INDEX_LOOP_MAX_POLL_INTERVAL_MS = 15_000;

/**
 * The ceiling the poll interval backs off to — ONE MINUTE, four times sparser
 * than the index loop's.
 *
 * ⚠️ IT IS ALSO THE BOUND ON UNOBSERVED SPEND, which is why it is a minute and not
 * an hour. Every successful poll writes an absolute-to-date checkpoint, so a
 * supervisor that dies loses at most one interval of visibility before the sweep
 * or the reaper reaches the container. Against the `fly` / `iad` rate row the
 * fleet runs on (`packages/orchestrator/src/rates.ts`):
 *
 *   60 s × $0.000031636049/s = $0.00189816294 (under $0.002) unobserved per
 *   container per interval
 *
 * — on a Fly account with neither a spending cap nor a billing alert
 * (`ci-runner-fleet.md` §9). A container story-shaped at hours is still polled
 * ~60 times an hour, which is nothing next to what it would cost to be blind.
 */
export const AGENT_MAX_POLL_INTERVAL_MS = 60_000;

const POLL_BACKOFF_FACTOR = 2;

/** How many consecutive failed status reads are tolerated before supervision
 *  gives up on reading and tears the container down. */
const MAX_CONSECUTIVE_READ_FAILURES = 3;

/**
 * The longest run this seam will supervise. An agent run is story-shaped (hours);
 * twelve hours is a ceiling on SPEND a dispatcher bug cannot exceed, not an
 * estimate of how long one takes.
 */
export const HOSTED_AGENT_MAX_TIMEOUT_MS = 12 * 60 * 60_000;

/**
 * The total-poll ceiling. It bounds a supervision whose clock does something
 * surprising, and it must clear the longest legal run at the backed-off cadence:
 * 12 h ÷ 60 s = 720 polls, plus the ramp — so 1,000 cannot fire before the
 * timeout does on a healthy run.
 */
const MAX_POLL_ITERATIONS = 1_000;

/** How much longer than the container's own hard kill its fleet slot keeps
 *  counting: the boot deadline plus a settle margin, rounded up. */
const SLOT_TTL_MARGIN_SECONDS = 300;

/** The agent fleet's time budgets, stated once so a suite asserts them. */
export const HOSTED_AGENT_FLEET_TIME_BUDGETS = {
  bootDeadlineMs: DEFAULT_BOOT_DEADLINE_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxPollIntervalMs: AGENT_MAX_POLL_INTERVAL_MS,
  indexLoopMaxPollIntervalMs: INDEX_LOOP_MAX_POLL_INTERVAL_MS,
  maxTimeoutMs: HOSTED_AGENT_MAX_TIMEOUT_MS,
  maxPollIterations: MAX_POLL_ITERATIONS,
  maxConsecutiveReadFailures: MAX_CONSECUTIVE_READ_FAILURES,
  slotTtlMarginSeconds: SLOT_TTL_MARGIN_SECONDS,
} as const;

/**
 * The fleet slot's TTL for a run of `timeoutSeconds` — the container's own hard
 * kill plus the margin, NEVER `DEFAULT_FLEET_SLOT_TTL_SECONDS`. A TTL shorter than
 * the container's real life would stop counting a container that is still
 * spending, which is the one direction the ceiling must never err in.
 */
export function hostedAgentSlotTtlSeconds(timeoutSeconds: number): number {
  return Math.ceil(timeoutSeconds) + SLOT_TTL_MARGIN_SECONDS;
}

/** Seams the tests drive. Defaults are the constants above; a test may only
 *  SHORTEN a budget, never lengthen one past the shipped value. */
export interface HostedAgentSupervisionOptions {
  /** The durable-step seam. A job passes its `ctx.step`; everything else passes nothing. */
  steps?: MemoizingSteps;
  bootDeadlineMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  maxPollIterations?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  supervisionStore?: SupervisionStore;
  /**
   * A session the caller ALREADY booted (MOTIR-690). The hosted start path boots
   * the container in its own request, because the boot's env carries the run's
   * two secrets and a job payload or a step memo is a database row: neither may
   * hold them. Given this, {@link advance}'s boot step memoizes THIS session
   * instead of booting, so the supervision still replays exactly one boot.
   */
  booted?: HostedAgentSession;
  /**
   * An extra verdict read before each poll: a failure detail when the run must
   * end now, `null` while it may go on. The hosted supervisor's STALL read
   * (MOTIR-690) — no run event inside the stall window. A detail settles the
   * container through the ordinary settle (`job_timed_out`), so nothing about the
   * teardown differs from a timeout. A read that throws is treated as alive: an
   * unanswered question never ends a paying run.
   *
   * A verdict may instead name `gate_revoked` (MOTIR-6450): a person cancelled the
   * run, the end path already closed it and revoked its credentials, and the
   * supervisor — the one owner of this container — tears it down at this poll
   * with the cancel's own teardown reason.
   */
  liveness?: (session: HostedAgentSession, now: Date) => Promise<HostedAgentLivenessVerdict>;
}

/** What {@link HostedAgentSupervisionOptions.liveness} answers: `null` while the
 *  run may go on; a detail (settled `job_timed_out`); or a cancel. */
export type HostedAgentLivenessVerdict = string | { reason: 'gate_revoked'; detail: string } | null;

/**
 * ONE hosted-agent container — everything the boot needs, already resolved by
 * the composer. The seam reads no environment of its own for any of it.
 */
export interface HostedAgentContainerRequest {
  /**
   * THE DISPATCH'S OWN IDENTITY — the fleet slot's ref and the supervision's
   * subject. Fixed for a dispatch and different for the next one, so a
   * redelivery re-attaches to its slot rather than taking a second.
   */
  readonly dispatchId: string;
  /** The run this container belongs to — the slot's owner, for an
   *  ownership-checked release. */
  readonly runId: string;
  /**
   * THE `DispatchRun.id` THIS CONTAINER SERVES (MOTIR-6448) — stamped on every
   * cost record the container produces, checkpoint and settle alike, so the fleet
   * meter row names its run and the run's machine time is readable by its id
   * (`docs/decisions/hosted-agent-run.md` §1: one id, everywhere).
   *
   * ⚠️ A REQUIRED KEY WHOSE VALUE MAY BE NULL, and null has exactly one caller:
   * the meter REHEARSAL (`scripts/rehearseHostedAgentMeter.ts`), which boots a
   * stand-in that serves no run. The column is a foreign key onto `dispatch_run`,
   * so a synthetic id would be refused and the whole cost row lost with it; an
   * honest null writes the row unnamed. Every real hosted run (MOTIR-690's start
   * path) passes its `DispatchRun.id`, and omitting the key is a compile error.
   */
  readonly dispatchRunId: string | null;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  /** `owner/name` of the run's PRIMARY repository. */
  readonly repoFullName: string;
  /** Digest-pinned OCI reference. */
  readonly image: string;
  /** Injected at boot. The composer owns what goes in it; this seam adds nothing. */
  readonly env: Readonly<Record<string, string>>;
  readonly region: string;
  readonly size: ContainerSize;
  /** The container's hard kill, in seconds. Bounded by {@link HOSTED_AGENT_MAX_TIMEOUT_MS}. */
  readonly timeoutSeconds: number;
  /**
   * WHAT THE HANDLE'S SECONDS WERE SPENT ON, when one run served more than one
   * repository (MOTIR-1790 · MOTIR-3255). Absent for a one-repo run, which is the
   * degenerate case: its row is exactly attributed by its own columns.
   *
   * ⚠️ ATTACHED AT SETTLE ONLY. Slice seconds are the caller's absolute totals for
   * the finished run; attaching them to a checkpoint would claim a running handle
   * had already done work it has not lived yet. The meter derives idle as the
   * handle's lifetime minus Σ slices, so the reconciliation holds by arithmetic.
   */
  readonly slices?: readonly ContainerWorkSlice[];
}

/**
 * The handle on a container being supervised.
 *
 * ⚠️ JSON-SERIALIZABLE BY CONTRACT — it rides the boot step's memo, and the
 * abandoned-supervision sweep rebuilds it from that memo with no handler running.
 * Every instant is an ISO string.
 */
export interface HostedAgentSession {
  readonly handle: {
    readonly provider: ContainerHandle['provider'];
    readonly id: string;
    readonly region: string;
    /** ISO-8601. */
    readonly createdAt: string;
    /**
     * The agent-runner account the container was booted on (MOTIR-9423). ABSENT
     * for a container on the process-wide fleet — a legacy boot, and every session
     * memoized before accounts existed, which therefore still reads as legacy.
     */
    readonly shardId?: string;
  };
  /** ISO-8601 — when the container was booted; the run timeout runs from it. */
  readonly bootedAt: string;
  readonly dispatchId: string;
  readonly runId: string;
  /** As {@link HostedAgentContainerRequest.dispatchRunId}. */
  readonly dispatchRunId: string | null;
  readonly timeoutSeconds: number;
  readonly size: ContainerSize;
  readonly attribution: {
    readonly orgId: string;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly repoFullName: string;
  };
  /** As {@link HostedAgentContainerRequest.slices}. Absent for a one-repo run. */
  readonly slices?: readonly ContainerWorkSlice[];
}

/** What one poll observed. `done` is the only way out, and it always settles. */
export type HostedAgentPollResult =
  | { done: false; startedAt: string | null; consecutiveReadFailures: number }
  | {
      done: true;
      reason: TeardownReason;
      startedAt: string | null;
      exitCode: number | null;
      failureDetail: string | null;
    };

export type HostedAgentSettleVerdict = Extract<HostedAgentPollResult, { done: true }>;

export const INITIAL_HOSTED_AGENT_POLL_STATE: Extract<HostedAgentPollResult, { done: false }> = {
  done: false,
  startedAt: null,
  consecutiveReadFailures: 0,
};

/** Every way a hosted-agent dispatch can end. */
export type HostedAgentContainerOutcome =
  /** The fleet is at its ceiling (or the count could not be read). Nothing was
   *  booted and nothing is held; the composer queues and asks again. */
  | { outcome: 'admission_deferred'; reason: string; detail: string }
  /** The provider refused the boot. The port guarantees no container remains,
   *  and the slot has been given back. */
  | { outcome: 'provision_failed'; detail: string }
  | { outcome: 'image_unpullable'; detail: string }
  /** Teardown failed. The container may still be running, so its slot stays held
   *  and ages out through its TTL while the reaper does its work. */
  | { outcome: 'teardown_failed'; detail: string }
  | {
      outcome: 'settled';
      reason: TeardownReason;
      containerId: string;
      exitCode: number | null;
      billableSeconds: number;
      /** Decimal string, as the record carries it. */
      costUsd: string;
      usage: ContainerUsage;
      failureDetail: string | null;
    };

export type HostedAgentBootResult =
  | { phase: 'supervising'; session: HostedAgentSession }
  | { phase: 'terminal'; outcome: HostedAgentContainerOutcome }
  /** The dispatch already held its fleet slot (MOTIR-9381): another pass for
   *  the same run is booting it. Nothing was provisioned by this call. */
  | { phase: 'already_booting' };

/** What {@link hostedAgentContainerService.boot} accepts beyond supervision. */
export interface HostedAgentBootOptions extends HostedAgentSupervisionOptions {
  /**
   * Env the container needs that may only exist once the run is ADMITTED
   * (MOTIR-9381) — the run's own credentials, minted after the fleet slot is
   * taken so a run that waited for room boots with credentials valid for its
   * whole container life. Merged over `request.env`.
   */
  envAtAdmission?: () => Promise<Record<string, string>>;
}

/**
 * How long to wait before poll number `pollNumber` (1-based). PURE — a function of
 * the poll number, never the clock, so every replayed pass derives the same wait.
 */
export function hostedAgentPollWaitMs(
  pollNumber: number,
  options: HostedAgentSupervisionOptions = {},
): number {
  const base = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cap = Math.min(
    options.maxPollIntervalMs ?? AGENT_MAX_POLL_INTERVAL_MS,
    AGENT_MAX_POLL_INTERVAL_MS,
  );
  const grown = base * POLL_BACKOFF_FACTOR ** Math.max(0, pollNumber - 1);
  return Math.min(Math.max(base, grown), Math.max(base, cap));
}

/**
 * The attribution every cost record for this container carries — built ONCE, from
 * the session, so the checkpoint and the settle attribute the same container to
 * the same line.
 */
export function hostedAgentUsageAttribution(
  session: HostedAgentSession,
  observedStartedAt: Date | null = null,
): UsageAttribution {
  return {
    orgId: session.attribution.orgId,
    workspaceId: session.attribution.workspaceId,
    projectId: session.attribution.projectId,
    repoFullName: session.attribution.repoFullName,
    workload: HOSTED_AGENT_WORKLOAD,
    workflowJobId: NO_WORKFLOW_JOB,
    size: session.size,
    observedStartedAt,
  };
}

/**
 * A multi-repo handle served an ORG rather than one repo, so its record names no
 * repository (`ContainerUsage.repoFullName`). Applied identically to the checkpoint
 * and the settle, so the row's first write and its final one agree.
 */
function orgScopedWhenSliced<T extends ContainerUsage | ContainerAccrual>(
  record: T,
  session: HostedAgentSession,
): T {
  return session.slices ? { ...record, repoFullName: null } : record;
}

/**
 * Stamp the dispatch run onto a cost record (MOTIR-6448). Applied identically to the
 * checkpoint and the settle, so the row's first write already names its run and the
 * settle keeps it. `?? null` because a session memoized before this field existed is
 * rebuilt from its memo without it; such a row stays unnamed rather than failing.
 */
function forDispatchRun<T extends ContainerUsage | ContainerAccrual>(
  record: T,
  session: HostedAgentSession,
): T {
  return { ...record, dispatchRunId: session.dispatchRunId ?? null };
}

function handleOf(session: HostedAgentSession): ContainerHandle {
  return {
    provider: session.handle.provider,
    id: session.handle.id,
    region: session.handle.region,
    createdAt: new Date(session.handle.createdAt),
  };
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

function sleepFor(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** Where one provision attempt runs: the orchestrator, and the image and region
 *  that orchestrator is asked for. `shardId` null is the process-wide fleet. */
interface BootTarget {
  readonly orchestrator: ContainerOrchestrator;
  readonly image: string;
  readonly region: string;
  readonly shardId: string | null;
}

/**
 * The target a slot's account resolves to (MOTIR-9423). Null is the legacy
 * target, exactly the objects a boot used before accounts: the process-wide
 * orchestrator and the request's own image and region. An account id is that
 * account's orchestrator, the image its provider can pull, and the account's
 * own location — never the Fly fleet's config.
 */
async function resolveBootTarget(
  fleetShardId: string | null,
  request: HostedAgentContainerRequest,
): Promise<BootTarget> {
  if (fleetShardId === null) {
    return {
      orchestrator: getOrchestrator(),
      image: request.image,
      region: request.region,
      shardId: null,
    };
  }
  const shard = await fleetShardService.getShard(fleetShardId);
  const region = shard.provider === 'aws' ? shard.aws?.region : shard.fly?.region;
  if (!region) {
    throw new OrchestratorNotConfiguredError(
      `fleet account ${shard.id} (${shard.provider}) names no region to boot in`,
    );
  }
  return {
    orchestrator: fleetShardOrchestratorService.forShardRow(shard),
    image: hostedAgentImage(shard.provider),
    region,
    shardId: shard.id,
  };
}

const INLINE_STEPS: MemoizingSteps = {
  run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
};

export const hostedAgentContainerService = {
  /**
   * STEP 1 — refuse what cannot be metered, take a fleet slot, and boot exactly
   * one container.
   *
   * THROWS for the two refusals that are about the REQUEST — an unpriced machine
   * class and an out-of-bounds timeout — and for an unconfigured orchestrator.
   * The timeout fires before the slot; the price and the orchestrator are read
   * against the slot's account (MOTIR-9423), so they fire after it and give it
   * back first. No container is provisioned before any of them, so a throw
   * leaks nothing. A REFUSED provision is about this dispatch and comes back as a
   * terminal outcome, with the slot already released.
   */
  async boot(
    request: HostedAgentContainerRequest,
    options: HostedAgentBootOptions = {},
  ): Promise<HostedAgentBootResult> {
    const now = options.now ?? ((): Date => new Date());

    const timeoutMs = request.timeoutSeconds * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > HOSTED_AGENT_MAX_TIMEOUT_MS) {
      throw new HostedAgentContainerRequestInvalidError(
        `timeoutSeconds must be in (0, ${HOSTED_AGENT_MAX_TIMEOUT_MS / 1000}], got ${request.timeoutSeconds}`,
      );
    }

    // ── 1 · Take a fleet slot, sized to THIS run ─────────────────────────────
    // The slot names the account the run boots on (MOTIR-9421): null while the
    // agent runner's switch is Fly.
    const verdict: FleetSlotVerdict = await fleetCeilingService.reserve(
      {
        workload: HOSTED_AGENT_WORKLOAD,
        ref: request.dispatchId,
        ownerRef: request.runId,
        organizationId: request.organizationId,
        workspaceId: request.workspaceId,
        ttlSeconds: hostedAgentSlotTtlSeconds(request.timeoutSeconds),
      },
      now(),
    );
    if (verdict.outcome === 'deferred') {
      return {
        phase: 'terminal',
        outcome: { outcome: 'admission_deferred', reason: verdict.reason, detail: verdict.detail },
      };
    }
    // The dispatch ALREADY holds its slot (MOTIR-9381): another pass for the same
    // run reserved it and is booting it, or booted it. Provisioning here would
    // boot a second container against one slot, so nothing is provisioned.
    if (verdict.outcome === 'already_held') {
      return { phase: 'already_booting' };
    }
    const releaseSlot = (): Promise<boolean> =>
      fleetCeilingService.release(HOSTED_AGENT_WORKLOAD, request.dispatchId, request.runId);

    // ── 0 · Where, and priced there, or not booted ───────────────────────────
    // Resolved against the provider and region that WILL run the machine — the
    // slot's account, or the process-wide fleet — so it runs after the slot and
    // again after every move. A refusal (or an unresolvable target) gives the
    // slot back before anything is provisioned and throws.
    const targetFor = async (fleetShardId: string | null): Promise<BootTarget> => {
      try {
        const target = await resolveBootTarget(fleetShardId, request);
        if (
          !resolveContainerRate(target.orchestrator.provider, request.size, target.region, now())
        ) {
          throw new HostedAgentContainerUnpricedError(
            target.orchestrator.provider,
            request.size,
            target.region,
          );
        }
        return target;
      } catch (err) {
        await releaseSlot();
        throw err;
      }
    };
    let target = await targetFor(verdict.fleetShardId ?? null);

    // ── 1b · The run's credentials, minted only now that it is admitted ──────
    // (MOTIR-9381) A run that waited for room gets credentials whose life starts
    // at admission. A mint that throws gives the slot back and rethrows: no
    // container was provisioned for it. Minted ONCE: a move to another account
    // boots with this same env, never a second mint.
    let env = request.env;
    if (options.envAtAdmission) {
      try {
        env = { ...env, ...(await options.envAtAdmission()) };
      } catch (err) {
        await releaseSlot();
        throw err;
      }
    }

    // ── 2 · Boot exactly one container — moving on an account's refusal ──────
    // An ACCOUNT that refuses for capacity or an outage is paused, and the slot
    // moves (under the admission lock) to the next account not yet tried; the
    // provider call itself never holds that lock. A legacy target never moves.
    const tried = new Set<string>();
    let handle: ContainerHandle;
    for (;;) {
      const spec: ContainerSpec = {
        orgId: request.organizationId,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        repoFullName: request.repoFullName,
        workload: HOSTED_AGENT_WORKLOAD,
        workflowJobId: NO_WORKFLOW_JOB,
        image: target.image,
        size: request.size,
        env,
        timeoutSeconds: request.timeoutSeconds,
        region: target.region,
      };
      try {
        handle = await target.orchestrator.provision(spec);
        break;
      } catch (err) {
        const reason = target.shardId === null ? 'job_fault' : classifyProvisionRefusal(err);
        if (target.shardId === null || reason === 'job_fault') {
          // The port guarantees a failed `provision` left no container, so the
          // slot stands for nothing and goes back now rather than at its TTL.
          await releaseSlot();
          if (err instanceof OrchestratorImageUnpullableError) {
            return {
              phase: 'terminal',
              outcome: {
                outcome: 'image_unpullable',
                detail: `the hosted-agent image could not be pulled: ${detailOf(err)}`,
              },
            };
          }
          return {
            phase: 'terminal',
            outcome: {
              outcome: 'provision_failed',
              detail: `could not boot a hosted-agent container: ${detailOf(err)}`,
            },
          };
        }

        const refusedId = target.shardId;
        tried.add(refusedId);
        console.warn('[hostedAgentContainerService] an account refused the boot — moving the run', {
          dispatchId: request.dispatchId,
          shardId: refusedId,
          reason,
          detail: detailOf(err),
        });
        let nextId: string | null;
        try {
          nextId = await fleetCeilingService.moveHostedSlotAfterRefusal(
            {
              ref: request.dispatchId,
              ownerRef: request.runId,
              organizationId: request.organizationId,
            },
            refusedId,
            reason,
            tried,
            now(),
          );
        } catch (moveErr) {
          await releaseSlot();
          throw moveErr;
        }
        if (nextId === null) {
          // Every account of the pool refused or is full: the same deferral
          // `reserve` answers for a full pool. Never Fly, never a failure.
          await releaseSlot();
          return {
            phase: 'terminal',
            outcome: {
              outcome: 'admission_deferred',
              reason: 'shard_capacity',
              detail: HOSTED_AGENT_SHARD_CAPACITY_DETAIL,
            },
          };
        }
        target = await targetFor(nextId);
      }
    }

    return {
      phase: 'supervising',
      session: {
        handle: {
          provider: handle.provider,
          id: handle.id,
          region: handle.region,
          createdAt: handle.createdAt.toISOString(),
          ...(target.shardId !== null ? { shardId: target.shardId } : {}),
        },
        bootedAt: now().toISOString(),
        dispatchId: request.dispatchId,
        runId: request.runId,
        dispatchRunId: request.dispatchRunId,
        timeoutSeconds: request.timeoutSeconds,
        size: request.size,
        attribution: {
          orgId: request.organizationId,
          workspaceId: request.workspaceId,
          projectId: request.projectId,
          repoFullName: request.repoFullName,
        },
        ...(request.slices ? { slices: request.slices } : {}),
      },
    };
  },

  /**
   * STEP 2 (×N) — ONE provider read, a checkpoint when the container is running,
   * and a return. It NEVER throws: every failure becomes a typed result, and the
   * only exit is a `done` verdict that routes to {@link settle}.
   */
  async poll(
    session: HostedAgentSession,
    previous: Extract<HostedAgentPollResult, { done: false }> = INITIAL_HOSTED_AGENT_POLL_STATE,
    options: HostedAgentSupervisionOptions = {},
  ): Promise<HostedAgentPollResult> {
    const now = options.now ?? ((): Date => new Date());
    const bootDeadlineMs = options.bootDeadlineMs ?? DEFAULT_BOOT_DEADLINE_MS;
    const timeoutMs = session.timeoutSeconds * 1000;
    const bootedAt = new Date(session.bootedAt).getTime();
    let startedAt = previous.startedAt;

    // The boot deadline needs a SUCCESSFUL read (§13.3(b) — "never started" is a
    // claim about what the provider said); the run timeout is anchored to the
    // memoized `bootedAt` and fires on either arm.
    const deadlineVerdict = (readSucceeded: boolean): HostedAgentPollResult | null => {
      const elapsed = now().getTime() - bootedAt;
      if (readSucceeded && !startedAt && elapsed >= bootDeadlineMs) {
        return {
          done: true,
          reason: 'provision_failed',
          startedAt: null,
          exitCode: null,
          failureDetail: 'the container never started',
        };
      }
      if (elapsed >= timeoutMs) {
        return {
          done: true,
          reason: 'job_timed_out',
          startedAt,
          exitCode: null,
          failureDetail: 'the hosted-agent run outlived its timeout',
        };
      }
      return null;
    };

    let orchestrator: ContainerOrchestrator;
    let status;
    try {
      orchestrator = getOrchestrator();
      status = await orchestrator.describe(handleOf(session));
    } catch (err) {
      const consecutiveReadFailures = previous.consecutiveReadFailures + 1;
      if (consecutiveReadFailures > MAX_CONSECUTIVE_READ_FAILURES) {
        return {
          done: true,
          reason: 'job_timed_out',
          startedAt,
          exitCode: null,
          failureDetail: `the container status could not be read: ${detailOf(err)}`,
        };
      }
      console.warn('[hostedAgentContainerService] a container status read failed — retrying', {
        containerId: session.handle.id,
        consecutiveReadFailures,
      });
      return deadlineVerdict(false) ?? { done: false, startedAt, consecutiveReadFailures };
    }

    if (status.startedAt && !startedAt) startedAt = status.startedAt.toISOString();

    // THE CHECKPOINT — the reason this workload's meter has a live write at all.
    // Absolute-to-date, so a replayed poll re-reports the same total and adds
    // nothing; `recordContainerAccrual` never throws, so this path still cannot.
    if (startedAt) {
      await recordContainerAccrual(
        forDispatchRun(
          orgScopedWhenSliced(
            buildContainerAccrual({
              handle: handleOf(session),
              attribution: hostedAgentUsageAttribution(session),
              createdAt: new Date(session.handle.createdAt),
              startedAt: new Date(startedAt),
              observedAt: now(),
            }),
            session,
          ),
          session,
        ),
      );
    }

    if (status.terminal) {
      const observed = startedAt ?? status.startedAt?.toISOString() ?? null;
      return {
        done: true,
        reason: observed ? 'job_completed' : 'provision_failed',
        startedAt: observed,
        exitCode: status.exitCode,
        failureDetail: null,
      };
    }

    return deadlineVerdict(true) ?? { done: false, startedAt, consecutiveReadFailures: 0 };
  },

  /**
   * STEP 3 — teardown, then the cost, then the slot. IN THAT ORDER.
   *
   * Teardown first, because the container being gone is what stops the spend.
   * The usage row second, so the slot a queued dispatch is about to claim is never
   * freed before the spend it stood for is written down. The release last, and
   * only on this path: a FAILED teardown returns without releasing, because that
   * container may still be running and under-counting a live one is the direction
   * the ceiling must never err in.
   */
  async settle(
    session: HostedAgentSession,
    verdict: HostedAgentSettleVerdict,
  ): Promise<HostedAgentContainerOutcome> {
    const handle = handleOf(session);
    const observedStartedAt = verdict.startedAt ? new Date(verdict.startedAt) : null;

    let usage: ContainerUsage;
    try {
      usage = await getOrchestrator().teardown(
        handle,
        verdict.reason,
        hostedAgentUsageAttribution(session, observedStartedAt),
      );
    } catch (err) {
      console.error('[hostedAgentContainerService] could not tear down a hosted-agent container', {
        containerId: handle.id,
        reason: verdict.reason,
      });
      return {
        outcome: 'teardown_failed',
        detail: `teardown failed for container ${handle.id}; left for the reaper: ${detailOf(err)}`,
      };
    }

    const recorded: ContainerUsage = forDispatchRun(
      session.slices ? { ...orgScopedWhenSliced(usage, session), slices: session.slices } : usage,
      session,
    );
    await recordContainerUsage(recorded);

    await fleetCeilingService.release(HOSTED_AGENT_WORKLOAD, session.dispatchId, session.runId);

    return {
      outcome: 'settled',
      reason: verdict.reason,
      containerId: handle.id,
      exitCode: verdict.exitCode,
      billableSeconds: recorded.billableSeconds,
      costUsd: recorded.costUsd,
      usage: recorded,
      failureDetail: verdict.failureDetail,
    };
  },

  /**
   * ONE PASS of a hosted-agent supervision: boot (memoized), then advance the
   * shared driver by exactly one poll. It usually does not return — it throws
   * `JobRunDefer` — and returns only on a terminal transition.
   *
   * This is what Epic 9's durable job composes, with its `ctx.step` as `steps` and
   * its run id as `runId`.
   */
  async advance(
    runId: string,
    request: HostedAgentContainerRequest,
    options: HostedAgentSupervisionOptions = {},
  ): Promise<HostedAgentContainerOutcome> {
    const steps = options.steps ?? INLINE_STEPS;

    const preBooted = options.booted;
    const booted = await steps.run(hostedAgentBootStepId(request.dispatchId), () =>
      preBooted
        ? Promise.resolve<HostedAgentBootResult>({ phase: 'supervising', session: preBooted })
        : this.boot(request, options),
    );
    if (booted.phase === 'terminal') return booted.outcome;
    // Another supervision already holds this dispatch's slot and owns its
    // container: this one boots nothing and supervises nothing.
    if (booted.phase === 'already_booting') {
      return {
        outcome: 'admission_deferred',
        reason: 'already_held',
        detail: 'the dispatch already holds its fleet slot; another pass owns its container',
      };
    }
    const { session } = booted;

    const maxPolls = Math.min(
      options.maxPollIterations ?? MAX_POLL_ITERATIONS,
      MAX_POLL_ITERATIONS,
    );
    const timeoutMs = session.timeoutSeconds * 1000;

    const result = await advanceSupervision<HostedAgentSettleVerdict, HostedAgentContainerOutcome>(
      runId,
      {
        kind: HOSTED_AGENT_SUPERVISION_KIND,
        subject: request.dispatchId,
        workspaceId: request.workspaceId,
        bootedAt: new Date(session.bootedAt),
      },
      {
        maxPolls,
        timeoutMs,
        waitMs: (pollNumber) => hostedAgentPollWaitMs(pollNumber, options),
        ...(options.now ? { now: options.now } : {}),
        ...(options.supervisionStore ? { store: options.supervisionStore } : {}),
        poll: async (state) => {
          const stalled = await livenessVerdict(session, options);
          if (stalled) {
            return {
              done: true,
              verdict: {
                done: true,
                reason: typeof stalled === 'string' ? 'job_timed_out' : stalled.reason,
                startedAt: state.startedAt ? state.startedAt.toISOString() : null,
                exitCode: null,
                failureDetail: typeof stalled === 'string' ? stalled : stalled.detail,
              },
            };
          }
          const polled = await this.poll(
            session,
            {
              done: false,
              startedAt: state.startedAt ? state.startedAt.toISOString() : null,
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
        settle: async (reason, state, verdict) =>
          steps.run(hostedAgentSettleStepId(request.dispatchId), () =>
            this.settle(
              session,
              verdict ?? {
                done: true,
                reason: 'job_timed_out',
                startedAt: state.startedAt ? state.startedAt.toISOString() : null,
                exitCode: null,
                failureDetail: supervisionFailureDetail(reason, maxPolls, timeoutMs),
              },
            ),
          ),
      },
    );

    // THE CHARGE — after the settle step, never inside it. Only a SETTLED
    // container that served a run is charged: CI and index containers never
    // reach this seam, and the rehearsal's stand-in names no run.
    if (result.outcome.outcome === 'settled' && session.dispatchRunId !== null) {
      await this.chargeSettledRun(session.dispatchId, session.dispatchRunId, steps, options);
    }
    return result.outcome;
  },

  /**
   * Charge a settled run's machine time, as a memoized step. A charge that did
   * not land throws inside the step — so the failure is NOT memoized — and the
   * pass is deferred: the next one replays boot and settle from their memos and
   * re-executes only this step. A charge that landed, or that was decided not to
   * happen, is memoized, so a replayed pass never calls motir-ai again.
   */
  async chargeSettledRun(
    dispatchId: string,
    dispatchRunId: string,
    steps: MemoizingSteps,
    options: HostedAgentSupervisionOptions,
  ): Promise<void> {
    const now = options.now ?? ((): Date => new Date());
    try {
      await steps.run(hostedAgentChargeStepId(dispatchId), async () => {
        const charge = await hostedRunChargeService.chargeMachineTime(dispatchRunId, { now });
        if (charge.outcome === 'retryable')
          throw new HostedAgentChargeNotLandedError(charge.detail);
        return charge;
      });
    } catch (err) {
      if (!(err instanceof HostedAgentChargeNotLandedError)) throw err;
      deferSettledSupervision(
        new Date(now().getTime() + HOSTED_AGENT_CHARGE_RETRY_MS),
        `hosted-agent supervision ${dispatchId}: settled, machine charge pending (${err.detail})`,
      );
    }
  },

  /**
   * Boot ONE hosted-agent container and supervise it TO COMPLETION in this process
   * — for a caller with no `job_queue` row: the rehearsal command, a local harness,
   * a test. A wrapper over {@link advance}, never a second composition.
   */
  async run(
    request: HostedAgentContainerRequest,
    options: HostedAgentSupervisionOptions = {},
  ): Promise<HostedAgentContainerOutcome> {
    const sleep = options.sleep ?? sleepFor;
    const now = options.now ?? ((): Date => new Date());
    const supervisionStore = options.supervisionStore ?? inMemorySupervisionStore();
    // One step memo per call, or every pass re-boots — a container per poll.
    const steps = inProcessMemoSteps(options.steps ?? INLINE_STEPS);
    return driveSupervisionInProcess(
      () => this.advance(request.runId, request, { ...options, steps, supervisionStore }),
      { sleep, now },
    );
  },
};

/** The caller's liveness verdict, or `null` — never a throw (see the option). */
async function livenessVerdict(
  session: HostedAgentSession,
  options: HostedAgentSupervisionOptions,
): Promise<HostedAgentLivenessVerdict> {
  if (!options.liveness) return null;
  const now = options.now ?? ((): Date => new Date());
  try {
    return await options.liveness(session, now());
  } catch (err) {
    console.warn('[hostedAgentContainerService] a liveness read failed — treated as alive', {
      containerId: session.handle.id,
      detail: detailOf(err),
    });
    return null;
  }
}

/** The `failureDetail` a supervision writes when it settles for a reason of its
 *  own — `job_timed_out` covers all three, so the detail is where they differ. */
function supervisionFailureDetail(
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
    /* v8 ignore next 4 -- `completed` always carries the poll's own verdict and
       `replayed` always hits the settle memo; enumerated so a new reason fails
       the exhaustiveness check here rather than borrowing this string. */
    case 'completed':
    case 'replayed':
      return `supervision settled (${reason})`;
  }
}
