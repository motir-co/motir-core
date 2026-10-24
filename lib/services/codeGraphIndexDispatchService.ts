import {
  checkIndexAllowance,
  drawIndexAllowance,
  fetchCodeGraphRunVerdict,
  GRAPH_TOO_LARGE_FAILURE,
  mintCodeGraphRunCredential,
  motirAiContainerBaseUrl,
} from '@/lib/ai/motirAiClient';
import {
  indexDrawKey,
  indexPauseReasonFor,
  type IndexPauseReason,
} from '@/lib/ciFleet/indexAllowance';
import { CodeGraphRunCredentialTooShortError } from '@/lib/ai/errors';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import {
  codeGraphIndexAdmissionService,
  type IndexAdmission,
  type IndexAdmissionDeferralReason,
  type IndexAdmissionVerdict,
} from '@/lib/services/codeGraphIndexAdmissionService';
import { getGitProvider, requireRepoTarballUrlResolver } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
// TYPE-ONLY, and it has to stay that way: `codeGraphIndexService` is the READ
// half this service is dispatched BY, so a value import would close a cycle. The
// phase vocabulary lives there because that is where the ledger's result type
// lives, and both halves must name the same three spans (MOTIR-4413).
import type { IndexCorePhase, IndexMode } from '@/lib/services/codeGraphIndexService';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  OrchestratorImageUnpullableError,
  getOrchestrator,
  indexFleetConfig,
  recordContainerAccrual,
  recordContainerUsage,
  type IndexFleetConfig,
} from '@/lib/orchestrator';
import {
  FLEET_CONTAINER_SIZE,
  buildContainerAccrual,
  type ContainerHandle,
  type ContainerOrchestrator,
  type ContainerSpec,
  type ContainerUsage,
  type TeardownReason,
  type UsageAttribution,
} from '@motir/orchestrator';
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

// THE INDEX DISPATCH SERVICE (Story MOTIR-1981 · MOTIR-2026) — boot ONE index
// container, supervise it in BOUNDED steps, and turn what happened into a typed
// outcome.
//
// `docs/decisions/code-graph-index-fleet.md` §2 (a container, not a function),
// §4 (credential scope is the isolation boundary), §5 (the container builds;
// motir-ai is control plane), §10 (no GitHub credential).
//
// ⚠️ IT OWNS THE SUPERVISION COMPOSITION, AND SINCE MOTIR-3484 THERE IS ONLY ONE
// OF IT. {@link codeGraphIndexDispatchService.runIndexContainer} composes the
// three individually-BOUNDED operations —
// {@link codeGraphIndexDispatchService.bootIndexContainer} /
// {@link codeGraphIndexDispatchService.pollIndexContainer} /
// {@link codeGraphIndexDispatchService.settleIndexContainer} — and the JOB drives
// that composition through an optional step seam rather than re-implementing it.
//
// ⚠️ CORRECTED, BECAUSE THE CONSTRAINT WENT AWAY RATHER THAN THE CODE MERELY
// CHANGING. This block used to say the split existed because "an index run is
// minutes … and `app/api/inngest/route.ts` pins `maxDuration = 300`", so
// "supervision inside ONE invocation is exactly the defect MOTIR-2007 fixed for
// the CI fleet". Every word of that was true of VERCEL. `Dockerfile` ends
// `CMD ["node", "server.js"]` and motir-core has run as a long-lived Fly process
// since MOTIR-2384, so no invocation ceiling applies to a run at all — which is
// why MOTIR-2027's stepped driver could be collapsed back into this file, and
// why the three-way split now earns its place on different grounds:
//
//   • Each operation is the unit a durable STEP memoizes
//     (`docs/decisions/job-queue-foundation.md` §13) — boot and settle are the
//     things that must not happen twice across a worker restart.
//   • An index run is still minutes (a whole-repo tarball fetch plus a build
//     measured at 924 MB peak RSS, MOTIR-1515), so the loop still has to be
//     resumable — the property survives, its mechanism changed.
//
// ⚠️ AND {@link codeGraphIndexDispatchService.pollIndexContainer} STILL NEVER
// THROWS. Its reason ALSO changed and the guarantee did not: it used to be that
// a step scheduled from a `catch` is never executed by the Inngest executor, so
// teardown was unreachable from one. Teardown is now an ordinary `finally` in
// `runIndexContainer`, which a long-lived process makes trustworthy again — but a
// poll that threw would still end the pass without a verdict, and the structural
// version (every failure becomes a TYPED result, the only exit is a `done`
// verdict that routes to teardown) is the stronger property. `ciRunnerBootService`
// is the shipped shape this mirrors, and MOTIR-3485 collapses it the same way.
//
// ⚠️ ONE CONTAINER PER (REPO × PROJECT), AND THE LEDGER IS STILL PER REPO. The
// shipped indexer image reads exactly ONE `MOTIR_INDEX_RUN_CREDENTIAL` and
// returns exactly ONE pointer, and `runCredential` binds a credential to ONE
// `aiProjectId` resolved AT MINT TIME — "a container never names it"
// (`motir-ai/docs/contract.md`: nothing in a request body can name a project).
// `codeGraphIndexService.resolveIndexTarget` fans out over every project of the
// repo's workspace, so indexing one repo into N projects needs N credentials and
// therefore N containers. That does NOT weaken §6: §6 forbids batching several
// REPOS into one container, because one `output.repoRef` for N repos leaves N−1
// reading as never-indexed forever. One container per (repo × project) never
// batches repos, so the ledger stays one `job_run` per repo with one
// `output.repoRef` — the contract `listSucceededCodeGraphIndexRepoRefs` and the
// onboarding wizard's per-repo rows read. This service dispatches ONE
// (repo × project); who loops and who writes the ledger row is MOTIR-2027's.
//
// ⚠️ THE SPEC IS A SECURITY BOUNDARY, NOT A CONFIG BLOB. §4 makes credential
// scope the isolation mechanism for a fleet whose org is SHARED with CI runners
// executing customer-authored code, so what a container holds is the whole of its
// blast radius. {@link codeGraphIndexDispatchService.buildIndexSpec} therefore
// takes every value as an ARGUMENT and reads no environment of its own: the four
// variables the image's boot contract names are the four it emits, and the test
// asserts the key SET rather than its members, so a fifth variable added later
// fails rather than passing unnoticed. Above all there is no Fly token in it — a
// container ingesting untrusted source with one could provision in the shared
// fleet org (MOTIR-1918 §7.4).
//
// ⚠️ NO `isMeta` BRANCH EXISTS ANYWHERE IN THIS PATH — §8/§9, and it is
// load-bearing rather than an omission. Motir's own repos dispatch through this
// identical code, into the same org, with the same credential shape; `isMeta`
// decides only whether the metered cost is CHARGED (§9.1: read every `isMeta`
// branch as "should this be un-charged?", never as "should this run somewhere
// else?"). A meta-only path would mean the tested path is the one nobody runs.
//
// ⚠️ NOTHING BOOTS WITHOUT AN ADMISSION (MOTIR-1990). `bootIndexContainer`
// REQUIRES an {@link IndexAdmission} — the granted ticket
// `codeGraphIndexAdmissionService.admit` returns once it has taken a
// `fleet_in_flight_slot` under the fleet lock. That is the same compile-time
// trick the repository layer uses with `tx` (CLAUDE.md: *"required so TypeScript
// catches missing-tx bugs"*): booting an index container outside the cap is a
// type error rather than a review comment. NO concurrency number is inlined in
// this file — every one of them is config, read in `lib/ciFleet/limits.ts`.
//
// The slot's LIFETIME is this service's: taken by the admission, released by
// {@link codeGraphIndexDispatchService.settleIndexContainer} once the container
// is really gone — and by `bootIndexContainer` itself on every path where the
// boot did not leave a container behind, so a failed mint or an unpullable image
// gives capacity straight back instead of holding it until the TTL.
//
// ⚠️ WHAT THIS DELIBERATELY DOES NOT DO. `system.code-graph-refresh` and
// motir-ai's hydrate-on-read path are
//
// ⚠️ THE COGS METER IS NOW WIRED (MOTIR-1995). MOTIR-2026 carried the usage record
// OUT on the outcome and wrote no row, because attributing it was this card's. It
// is attributed here, at the two moments a container's cost becomes knowable, and
// both go through `usageSink` — never the meter service directly, so the port keeps
// knowing nothing about tenancy:
//
//   * {@link codeGraphIndexDispatchService.settleIndexContainer} → `recordContainerUsage`.
//     Teardown produces the record and the port makes that unskippable.
//   * {@link codeGraphIndexDispatchService.pollIndexContainer} → `recordContainerAccrual`.
//     A CHECKPOINT while the container still runs. An index container is job-shaped
//     and would survive without it; it is here because the supervision loop is where
//     a live container's seconds are observable at all, and Epic 9's agent container
//     — story-shaped, HOURS — reaches teardown far too late to be the first write.
//     Building it while the loop is being written costs nothing; retrofitting it
//     after Epic 9 ships costs a migration and a period of blind spend.
//
// Neither call can throw (`usageSink`'s contract), which is what lets them sit on a
// path documented to never throw and inside the `finally`-shaped settle.
//
// ⚠️ NO `isMeta` BRANCH HERE EITHER, and now none in the meter it feeds. Motir's own
// repos dispatch through this identical code into the same org; the meter measures
// them like any tenant and reads their cost back as its own line. See §9.1 and the
// meter's header: `isMeta` decides whether spend is CHARGED, never whether it is
// MEASURED.

/** This service dispatches INDEX containers and nothing else. Named once so the
 *  answer to "does it ever boot anything else?" is one grep, not four literals. */
const CODE_GRAPH_INDEX_WORKLOAD = 'code_graph_index' satisfies FleetWorkloadKind;

/**
 * An index container has NO GitHub job — §11: "no runner registers, no `runs-on`
 * resolves, no `workflow_job` fires". The port made `workflowJobId` nullable for
 * exactly this workload (MOTIR-2025); filling it would name the machine after a
 * job that does not exist and tag it as a CI runner to the reaper.
 */
const NO_WORKFLOW_JOB = null;

/**
 * The attribution every cost record for this container carries — built ONCE from
 * the session (MOTIR-1995), because the checkpoint and the teardown must attribute
 * the SAME container the same way or the settle's delta would land on a different
 * rollup line than the accrual it is reconciling.
 *
 * `observedStartedAt` is the caller's own observation, which for an index container
 * is usually the ONLY start instant available: `auto_destroy` means a healthy run
 * ends with the machine deleting itself, taking its event log with it, so without
 * this the best-behaved containers would produce the zero-second rows.
 */
function indexUsageAttribution(
  session: IndexSession,
  observedStartedAt: Date | null = null,
): UsageAttribution {
  return {
    orgId: session.attribution.orgId,
    workspaceId: session.attribution.workspaceId,
    projectId: session.attribution.projectId,
    repoFullName: session.attribution.repoFullName,
    workload: CODE_GRAPH_INDEX_WORKLOAD,
    workflowJobId: NO_WORKFLOW_JOB,
    size: FLEET_CONTAINER_SIZE,
    observedStartedAt,
  };
}

/** How long a container has to reach a running state before it is written off as
 *  a boot that never happened. Same figure the CI fleet uses: a deadline that
 *  cannot fire on a merely-slow boot. */
const DEFAULT_BOOT_DEADLINE_MS = 120_000;

/**
 * The hard kill on ONE index run.
 *
 * Half an hour, not the CI fleet's hour. §11.1 fixes the asymmetry the number
 * comes from: an index container is JOB-shaped (minutes) where an agent container
 * is story-shaped (hours), and the measured run is a tarball fetch plus a build
 * that peaks at 924 MB RSS (MOTIR-1515) — an order of magnitude under this. What
 * is fixed here is not how long an index may take but that the CONTAINER STOPS:
 * every further second is billed to Motir with, per §7.2, nothing but Motir's own
 * counter in front of the invoice.
 */
const DEFAULT_INDEX_TIMEOUT_MS = 1_800_000;

/**
 * How much longer than the container's own hard kill its motir-ai credential
 * must live (Bug MOTIR-4923).
 *
 * ⚠️ THE CREDENTIAL'S LIFETIME IS DERIVED FROM {@link DEFAULT_INDEX_TIMEOUT_MS},
 * NOT SET BESIDE IT. Until this card the mint carried no `ttlSeconds` at all, so
 * motir-ai's own default applied — FIFTEEN MINUTES, against a container this
 * side permits THIRTY. That is a mismatch that fails BY REPOSITORY SIZE and
 * therefore only on the big repos: every run that finishes inside fifteen
 * minutes succeeds, every run that does not builds its whole graph and is
 * refused at the upload with exit `50`. Measured, twice, on 2026-09-08:
 * `moooon-B-V/motir-core` ran 19 m 52 s and 19 m 56 s against credentials that
 * expired at 15 m 00 s, while `moooon-B-V/motir-ai` — 2 m 07 s on the same
 * deployment, the same public ingress and the same credential scope — uploaded
 * and recorded its pointer. The two numbers were never one decision, so nobody
 * had to change one to break the other.
 *
 * The grace covers what happens OUTSIDE the container's own clock and after its
 * last second of work: the mint precedes `bootedAt`, the machine takes seconds
 * to start, and the upload grant plus the pointer record are two round trips a
 * container makes at the very END of a run it may have spent the full timeout
 * on. Five minutes is generous against every one of those and still leaves the
 * total (35 min) far inside motir-ai's own hour-long ceiling.
 *
 * ⚠️ RENEWAL WAS THE OTHER ANSWER AND IS THE WRONG ONE HERE. MOTIR-3288 repaired
 * the planning job token by RENEWING it while the work runs (`refreshJobToken`),
 * deliberately not by raising it, because a short blast radius is what a leaked
 * token's lifetime is for. That answer does not transfer: the holder is a
 * container that ingests UNTRUSTED SOURCE, and handing it a renewal endpoint
 * would give it the one thing a fixed expiry denies it — the ability to extend
 * its own grant. Here the blast radius is bounded by SCOPE instead (one project,
 * one repo, one run, two operations — `docs/decisions/code-graph-index-fleet.md`
 * §4), and the deadline to cover is a number this side already owns.
 */
const CREDENTIAL_GRACE_MS = 300_000;

/**
 * The credential lifetime ONE index run needs, derived from the deadline that
 * run is actually given.
 *
 * Exported so the assertion below, the mint and the suite all read the same
 * derivation — the point of the card is that these numbers stop being written
 * down twice.
 */
export function runCredentialTtlSeconds(indexTimeoutMs: number): number {
  return Math.ceil((indexTimeoutMs + CREDENTIAL_GRACE_MS) / 1000);
}

/** How soon after boot supervision first asks the provider what the container is
 *  doing. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * The ceiling the poll interval backs off to — DELIBERATELY HALF THE CI FLEET'S.
 *
 * For a CI runner, detection latency is nearly free: the runner reports to
 * GitHub, `auto_destroy` stops the machine either way, and a later observation
 * delays only the teardown call and the usage row. FOR AN INDEX CONTAINER IT IS
 * NOT FREE, because the exit code is the entire diagnostic channel and it is
 * READABLE ONLY WHILE THE MACHINE STILL EXISTS — the Fly adapter's `describe`
 * reports `exitCode: null` for a machine that is gone ("GONE takes the exit code
 * with it"). Every second of extra poll spacing is a second in which a finished
 * container can self-destroy unobserved and turn a knowable `30` into
 * {@link IndexExitClass} `exit_unobserved`. So the backoff still bounds the step
 * count on a long run, but it stops sooner.
 */
const MAX_POLL_INTERVAL_MS = 15_000;

/** How much the poll interval grows each time the container is not yet terminal,
 *  until it reaches {@link MAX_POLL_INTERVAL_MS}. */
const POLL_BACKOFF_FACTOR = 2;

/**
 * A hard ceiling on poll iterations, independent of the clock — the bound that
 * still holds if the clock does something surprising (a frozen `now`, a provider
 * that never reports terminal). A loop with no static bound is a runaway that
 * bills per iteration. At the interval above it is many times the timeout.
 *
 * ⚠️ SINCE MOTIR-3484 IT IS A PER-PASS GUARD, NOT A BOUND ON TOTAL POLLS PER
 * CONTAINER. The loop counter is in-memory now, so a worker restart resets it —
 * and that is accepted rather than repaired (`docs/decisions/job-queue-foundation.md`
 * §13.3(a)), because this was never the bound that mattered.
 * {@link codeGraphIndexDispatchService.pollIndexContainer} measures `elapsed`
 * from `session.bootedAt`, which rides the MEMOIZED boot result, so the first
 * poll of a resumed pass settles a container already past
 * {@link DEFAULT_INDEX_TIMEOUT_MS} instead of watching it for another 500.
 * Deriving the count from elapsed time instead was refused: it would make the
 * guard depend on the very clock it exists to be independent of.
 */
const MAX_POLL_ITERATIONS = 500;

/**
 * How many containers ONE dispatch may boot before a `redispatchable` exit is
 * final (MOTIR-6586, `docs/decisions/code-graph-index-fleet.md` §21).
 *
 * ⚠️ THE JOB'S OWN RETRY CANNOT STAND IN FOR THIS, which is why it exists. A
 * settle RETURNS its verdict rather than throwing, so `index-settle:<pid>` is
 * memoized, and a job retry does not clear the step ledger — attempts 2–5 of
 * the job replay the failed verdict out of `job_step` without booting anything.
 * So the second container has to be asked for HERE, under step ids of its own.
 *
 * Two, not more: a class the classifier calls re-dispatchable is a transient
 * (an expired tarball URL, a dropped PUT), and one fresh container either
 * clears it or says it was not transient. Every attempt is a billed container.
 */
export const MAX_DISPATCH_ATTEMPTS = 2;

/**
 * The supervision SUBJECT of dispatch attempt `attempt` (1-based) — and so the
 * suffix of its `index-admit:` / `index-boot:` / `index-settle:` step ids and of
 * its `job_supervision` row.
 *
 * ⚠️ ATTEMPT 1 IS THE BARE `projectId`, BYTE-IDENTICAL TO EVERY ID WRITTEN
 * BEFORE MOTIR-6586. A run in flight across the deploy resumes on the memos it
 * already holds; a suffix on attempt 1 would re-execute `index-boot` and bill a
 * second container for a run that never failed. The abandoned-supervision sweep
 * reads the boot memo back as `index-boot:<subject>`, so the same string names
 * the row and the memo for every attempt.
 */
export function indexAttemptSubject(projectId: string, attempt: number): string {
  return attempt <= 1 ? projectId : `${projectId}:r${attempt}`;
}

/**
 * How many CONSECUTIVE provider status reads may fail before supervision gives up
 * and tears the container down. Not zero, because one 500 from the provider must
 * not end a healthy index; not unbounded, because a provider that is genuinely
 * unreachable must not leave this loop watching a container forever.
 */
const MAX_CONSECUTIVE_READ_FAILURES = 3;

/**
 * THE INDEX FLEET'S TIME BUDGETS, stated once and asserted in the suite.
 *
 * ⚠️ CORRECTED (MOTIR-3484) — THESE NUMBERS ARE UNCHANGED AND THE CEILING THEY
 * WERE READ AGAINST IS GONE. This block used to open: *"Read `maxDuration`
 * (300s, `app/api/inngest/route.ts`) as the ceiling on ONE INVOCATION — i.e. on
 * one step — never on a run"*, and then justified `indexTimeoutMs` as
 * *"DELIBERATE and only safe because the RUN is stepped"*. That was a fact about
 * Vercel. motir-core runs as a long-lived Fly process (`Dockerfile`, MOTIR-2384),
 * the worker renews a 60 s lease every 20 s, and a run of half an hour is the
 * engine's documented NORMAL case — so nothing caps an invocation and no budget
 * here is licensed by the stepping any more.
 *
 * ⚠️ NOT ONE VALUE MOVED, and that is the point: they were never really about the
 * platform. What each is actually for:
 *
 *   • Each of boot / poll / settle is a fixed, small amount of work: a handful of
 *     external calls, no loop and no sleep inside any of them. That keeps a
 *     memoized step SMALL, which is what makes a resumed run cheap — and it is
 *     why they are separate operations rather than one.
 *   • `indexTimeoutMs` (30 min) is the CONTAINER'S hard kill and always was. It
 *     bounds spend, not an invocation, and it is anchored to `session.bootedAt`
 *     so it survives a worker restart (`docs/decisions/job-queue-foundation.md`
 *     §13.2).
 *   • `pollIntervalMs` ≤ `maxPollIntervalMs` < `bootDeadlineMs` < `indexTimeoutMs`,
 *     so the boot deadline is observable at poll granularity and can fire before
 *     the run timeout does.
 *   • `maxPollIterations` is now a PER-PASS runaway guard rather than a bound on
 *     total polls per container: a restart resets the counter, and the
 *     `bootedAt`-anchored wall clock above is the real bound (§13.3(a)).
 */
export const INDEX_FLEET_TIME_BUDGETS = {
  bootDeadlineMs: DEFAULT_BOOT_DEADLINE_MS,
  indexTimeoutMs: DEFAULT_INDEX_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
  maxPollIterations: MAX_POLL_ITERATIONS,
  maxConsecutiveReadFailures: MAX_CONSECUTIVE_READ_FAILURES,
} as const;

/** The first wait after a deferred admission. */
const ADMISSION_RETRY_BASE_MS = 5_000;

/** The ceiling the admission wait backs off to. A minute is short next to the
 *  half-hour a container may hold its slot for, so a freed slot is claimed
 *  promptly rather than after an idle lane. */
const ADMISSION_RETRY_MAX_MS = 60_000;

const ADMISSION_RETRY_FACTOR = 2;

/**
 * How many times a dispatch asks for admission before it gives up WAITING.
 *
 * ⚠️ OVER THE CAP MEANS WAIT, NEVER DROP — that is the card's rule and the reason
 * this number is what it is. Dropping an index leaves a repo permanently
 * unindexed behind a `succeeded`-looking ledger, which is the exact failure §6's
 * one-row-per-repo contract exists to remove.
 *
 * Sixty attempts on the backoff above is a little under an hour of waiting, which
 * is DELIBERATELY LONGER THAN THE LONGEST CONTAINER: {@link
 * DEFAULT_INDEX_TIMEOUT_MS} hard-kills at thirty minutes, so every container
 * holding a slot when this dispatch first queued has certainly ended before the
 * budget runs out — the lane cannot still be full for the same reason it was
 * full at the start. Exhausting it therefore means something is wrong with the
 * FLEET rather than busy, and that is a loud failure (a failed `job_run` an
 * operator can see), never a silent skip.
 *
 * A bound rather than an unbounded wait for the same reason the poll loop has
 * one: a durable loop with no static ceiling is a runaway, and Inngest's own
 * retry budget is the outer recovery for the case this one hits.
 */
const MAX_ADMISSION_ATTEMPTS = 60;

/** The admission-side budgets, stated once and asserted in the suite. */
export const INDEX_ADMISSION_BUDGETS = {
  maxAttempts: MAX_ADMISSION_ATTEMPTS,
  baseWaitMs: ADMISSION_RETRY_BASE_MS,
  maxWaitMs: ADMISSION_RETRY_MAX_MS,
} as const;

/**
 * THE DURABLE SEAM (MOTIR-3484) — the subset of a job's `ctx.step` that the
 * supervision composition below uses.
 *
 * ⚠️ IT CARRIES `run` AND NOT `sleep`, and that omission is the decision this
 * card applies rather than an oversight. `docs/decisions/job-queue-foundation.md`
 * §13 settles what a supervision loop keeps durable: the SIDE EFFECT, never the
 * WAIT. A supervisor that forgets it was sleeping re-attaches to the same
 * container out of the memoized boot and carries on watching; a supervisor that
 * forgets it BOOTED provisions a second billed container. So the operations that
 * PROVISION, CLAIM or TEAR DOWN are memoized and the interval is an ordinary
 * `await`.
 *
 * A caller that passes nothing gets {@link INLINE_STEPS} — every operation
 * executed once, in this process, memoized by nothing. That is what a script, a
 * local harness or a test wants, and it is what this composition did for its
 * whole life before a job could drive it.
 */
export interface SupervisionSteps {
  run<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
}

/** The no-op seam: execute, do not memoize. The default for every non-job caller. */
export const INLINE_STEPS: SupervisionSteps = {
  run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
};

/** Seams the tests drive. Defaults are the constants above. */
export interface IndexSupervisionOptions {
  /**
   * The durable-step seam (MOTIR-3484). A job passes its `ctx.step`; everything
   * else passes nothing and gets {@link INLINE_STEPS}.
   */
  steps?: SupervisionSteps;
  bootDeadlineMs?: number;
  indexTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** The admission backoff's base + ceiling, so a queueing test is milliseconds. */
  admissionWaitMs?: number;
  maxAdmissionWaitMs?: number;
  /** How many times the in-process composition asks for admission before giving
   *  up. Bounded by {@link MAX_ADMISSION_ATTEMPTS} — a test may lower it, never
   *  raise it past the shipped ceiling. */
  maxAdmissionAttempts?: number;
  /** The per-pass poll ceiling. Bounded by {@link MAX_POLL_ITERATIONS} the same
   *  way and for the same reason — a test may lower it to drive the ceiling
   *  branch in milliseconds, never raise it past the shipped guard. */
  maxPollIterations?: number;
  /** How many containers one dispatch may boot for a `redispatchable` exit
   *  (MOTIR-6586). Bounded by {@link MAX_DISPATCH_ATTEMPTS} the same way — a
   *  test may lower it (to 1, to watch a single container), never raise it. */
  maxDispatchAttempts?: number;
  /**
   * The run-verdict read an `upload_failed` attempt consults to learn whether
   * motir-ai refused the graph for SIZE (MOTIR-7130). Defaults to
   * {@link fetchCodeGraphRunVerdict}; injectable so a test needs no HTTP.
   */
  readRunVerdict?: typeof fetchCodeGraphRunVerdict;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /**
   * WHERE the supervision's per-pass state lives
   * (`lib/jobs/supervision/driver.ts`). Omitted by every job-driven caller,
   * which gets the durable `job_supervision` row; supplied by
   * {@link codeGraphIndexDispatchService.runIndexContainer}, which drives a
   * supervision to completion in one call for a caller that has no `job_queue`
   * row to hang one off.
   */
  supervisionStore?: SupervisionStore;
}

/** ONE (repo × project) dispatch — everything the boot needs, already resolved.
 *  It is the shape `codeGraphIndexService`'s phase-1 read produces, plus the run
 *  the credential is minted for. */
export interface IndexDispatchInput {
  /** The host installation id — the token-minting key for the URL resolve. The
   *  token itself never leaves this process (§10). */
  readonly installationId: string;
  readonly providerId: GitProviderId;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repoOwner: string;
  readonly repoName: string;
  /** `owner/name` — the SAME key the ledger and the enqueue gate match on. */
  readonly repoRef: string;
  /** The ref to index — the repo's default branch. */
  readonly defaultBranch: string;
  /** The dispatching run, carried into the credential for attribution. */
  readonly runId: string;
  /**
   * THE DISPATCH'S OWN IDENTITY (MOTIR-2160) — the triggering event's id, which
   * is fixed for a run and different for the next one. It owns the admission slot,
   * so this dispatch's replays keep their capacity while a SECOND dispatch for the
   * same (repo × project) waits instead of booting beside a live container.
   *
   * ⚠️ NOT `runId`, though a run has exactly one of each. `runId` is read at the
   * top of the handler on EVERY durable-replay pass, which is fine for the
   * credential (minted once, inside a memoized step) and wrong for an ownership
   * token that must still be recognisable several passes later. The event's id is
   * the identity `defineJob` already correlates the ledger row by
   * (`event.id ?? ctx.runId`), and the one MOTIR-2002 chose for the same problem.
   */
  readonly dispatchId: string;
}

/**
 * The handle on an index container being supervised.
 *
 * ⚠️ JSON-SERIALIZABLE BY CONTRACT. It crosses a `ctx.step.run` boundary, so
 * Inngest round-trips it through JSON: every instant is an ISO STRING, never a
 * `Date` — a `Date` survives the first pass and arrives as a string on every
 * replayed one, a difference that shows up as `.getTime is not a function` only
 * in production and only on long runs.
 */
export interface IndexSession {
  readonly handle: {
    readonly provider: ContainerHandle['provider'];
    readonly id: string;
    readonly region: string;
    /** ISO-8601. */
    readonly createdAt: string;
  };
  /** ISO-8601 — when the container was booted; both deadlines run from it. */
  readonly bootedAt: string;
  /** ISO-8601 — when this run's motir-ai credential stops working. Carried so a
   *  post-mortem can tell an expiry apart from a scope refusal, both of which the
   *  container reports as `50`. */
  readonly credentialExpiresAt: string;
  readonly runId: string;
  /** The dispatch that owns this container's admission slot (MOTIR-2160) —
   *  carried on the session for the same reason `slotRef` is: the release happens
   *  in a different step, minutes later, and it is refused unless it names the
   *  dispatch that took the slot. */
  readonly dispatchId: string;
  readonly repoRef: string;
  /**
   * The `fleet_in_flight_slot` this container occupies (MOTIR-1990).
   *
   * Carried on the SESSION, not held in a closure, precisely because the session
   * is the only thing that crosses the step boundary: the admission happens in
   * one durable step and the release happens in another, minutes later, possibly
   * in a different invocation. A slot whose ref lived only in memory would be a
   * slot nothing could ever give back.
   */
  readonly slotRef: string;
  /**
   * WHETHER motir-ai GRANTED THIS RUN A SYNC (MOTIR-4945) — `true` when the boot
   * was handed a `previousSnapshotUrl`, `false` when it was not.
   *
   * Carried on the SESSION for exactly the reason `slotRef` and
   * `credentialExpiresAt` are: the grant is known at BOOT and the ledger row is
   * written at SETTLE, minutes and often several invocations later, and the
   * session is the only thing that crosses that boundary. A boolean living in a
   * closure would be a boolean no replay could see.
   *
   * ⚠️ OPTIONAL, AND THAT IS NOT DEFENSIVENESS — IT IS THE ROLLOUT. This field
   * lands in the `index-boot:<projectId>` memo, and every run already in flight
   * holds a memo written before it existed. Those replay the OLD shape, so this
   * arrives `undefined` for as long as they live, and a run in that state must
   * report NO mode rather than a plausible one. Defaulting the absence to
   * `rebuild` would be the worst available answer: it is the commoner mode, so
   * the wrong value would look right, and the first measurement anybody takes of
   * what a sync saves would be polluted by runs that never reported.
   */
  readonly syncGranted?: boolean;
  /**
   * THE FLEET ACCOUNT the container was booted on (MOTIR-9448) — the admission's
   * `shardId`, copied at boot so poll and settle reach the SAME account's
   * orchestrator. A plain id, never an adapter: `orchestratorFor` rebuilds the
   * orchestrator from it per step.
   *
   * ⚠️ OPTIONAL, FOR THE ROLLOUT, as `syncGranted` is. A run in flight across the
   * deploy replays an `index-boot:<projectId>` memo written without it, and a
   * session with no account means the process-wide fleet — exactly where that
   * run's container was booted.
   */
  readonly shardId?: string;
  readonly attribution: {
    readonly orgId: string;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly repoFullName: string;
  };
}

/** What one poll observed. `done` is the ONLY way out of the loop, and it always
 *  leads to {@link codeGraphIndexDispatchService.settleIndexContainer}. */
export type IndexPollResult =
  | {
      done: false;
      /** ISO-8601, once the container has been seen running. */
      startedAt: string | null;
      /** Carried forward so the next poll can apply the read-failure tolerance. */
      consecutiveReadFailures: number;
    }
  | {
      done: true;
      reason: TeardownReason;
      startedAt: string | null;
      /** The container's own exit status, when the provider still reported one. */
      exitCode: number | null;
      /** Set when supervision ended for a reason of its own (a deadline, an
       *  unreadable provider) rather than because the container stopped. */
      failureDetail: string | null;
      /** The container stopped because its image could not be pulled — learned
       *  after `provision` returned, on a provider that pulls on its VM (AWS,
       *  MOTIR-9446). The settle reports `image_unpullable`. Absent on every
       *  memo written before it existed, which reads as "not known". */
      imageUnpullable?: boolean;
    };

/** The starting point of the poll loop — no reads yet, nothing observed. */
export const INITIAL_INDEX_POLL_STATE: Extract<IndexPollResult, { done: false }> = {
  done: false,
  startedAt: null,
  consecutiveReadFailures: 0,
};

/**
 * WHAT THE RUN DID, named from the image's own taxonomy
 * (`motir-ai/src/indexer/exitCodes.ts`) rather than left as a number.
 *
 * The container writes no ledger row and its logs are the operator's, so the exit
 * code is the entire diagnostic channel: "the repo could not be fetched", "the
 * parser died on this tree" and "motir-ai refused the pointer" are three
 * different on-call responses and must be three different values here.
 */
export type IndexExitClass =
  /** `0` — built, uploaded, pointer recorded. The ONLY class that indexed. */
  | 'indexed'
  /** `10` — a required variable was missing or blank; NOTHING was attempted. A
   *  bug in this dispatcher: a retry with the same spec fails identically. */
  | 'dispatch_malformed'
  /** `20` — the repo could not be obtained (URL refused, transfer failed, or the
   *  archive was unreadable). Often an expired pre-signed URL. */
  | 'repo_unfetchable'
  /** `30` — the source arrived and the engine could not build a graph from it. */
  | 'graph_unbuildable'
  /** `40` — object storage refused or dropped the PUT to the granted key. */
  | 'upload_failed'
  /** `41` — the object landed and motir-ai refused to move the pointer. Inert:
   *  the key is derived from the commit, so a retry overwrites it. */
  | 'pointer_unrecorded'
  /** `50` — the run-scoped credential was REFUSED (expired, or out of scope). */
  | 'credential_refused'
  /** `137` — the KERNEL OOM-killed it: the machine was too small for this tree.
   *  A different fact from `graph_unbuildable`, and never merged into it. */
  | 'out_of_memory'
  /** `70`, or any code the taxonomy does not name. */
  | 'unclassified'
  /** The container stopped and no exit code was observable — `auto_destroy` took
   *  it with the machine. A third outcome beside "exited 0" and "exited 30". */
  | 'exit_unobserved'
  /** The container never started: the boot deadline fired first. */
  | 'never_started'
  /** Supervision gave up — its own deadline, or a provider it could not read. */
  | 'supervision_timed_out';

/** The exit, classified: what happened, and what a caller may conclude from it. */
export interface IndexExitVerdict {
  readonly exitClass: IndexExitClass;
  /** The raw code, kept beside the class so an unnamed number is still legible. */
  readonly exitCode: number | null;
  /**
   * ⚠️ TRUE ONLY FOR EXIT `0`. Everything downstream that claims a repo has a
   * code graph — the `job_run` ledger row, `listSucceededCodeGraphIndexRepoRefs`,
   * the wizard's per-repo rows — gates on this, so an unobserved or ambiguous
   * exit must never set it. §6: a run that records `output.repoRef` says "this
   * repoRef is indexed", forever, to every reader.
   */
  readonly indexed: boolean;
  /**
   * Would dispatching this same (repo × project) again plausibly succeed?
   * READ by {@link codeGraphIndexDispatchService.advanceIndexContainer}, which
   * boots a fresh container for it, up to {@link MAX_DISPATCH_ATTEMPTS}
   * (MOTIR-6586 — for months it had no reader at all).
   */
  readonly redispatchable: boolean;
  /** One sentence an operator can act on. */
  readonly detail: string;
}

/**
 * The answer to "may this organisation's next index container boot?" — what
 * {@link codeGraphIndexDispatchService.askIndexAllowance} returns (MOTIR-4593).
 *
 * JSON-serializable: the job memoizes it in a step, so a replay pass acts on the
 * answer the first pass got rather than asking again mid-run.
 */
export type IndexAllowanceAsk =
  | {
      proceed: true;
      /** The verdict that let it boot; `null` when the allowance could not be
       *  asked, or was not asked because this run's container was already booted. */
      outcome: string | null;
    }
  | { proceed: false; outcome: string; reason: IndexPauseReason };

/** What {@link codeGraphIndexDispatchService.bootIndexContainer} returns: either
 *  nothing was provisioned and the dispatch is over, or a container is up and
 *  must be supervised to its end. */
export type IndexBootResult =
  | { phase: 'terminal'; outcome: IndexDispatchOutcome }
  | { phase: 'supervising'; session: IndexSession };

export type IndexDispatchOutcome =
  /** The provider refused to boot the container. No container exists — the port
   *  requires a `provision` that throws to leave none behind. */
  | { outcome: 'provision_failed'; detail: string }
  /**
   * ADMISSION WAS NEVER GRANTED — the caps held for the whole waiting budget
   * (MOTIR-1990). Its own outcome, not folded into `provision_failed`, because
   * nothing was provisioned and nothing about THIS repo is wrong: the fleet was
   * full, for longer than any container may live, which is a fleet fault an
   * operator must see. The run FAILS on it rather than recording a success —
   * §6's ledger contract is what makes "skipped quietly" the unacceptable
   * alternative.
   */
  | { outcome: 'admission_deferred'; reason: IndexAdmissionDeferralReason; detail: string }
  /**
   * THE INDEXER IMAGE COULD NOT BE PULLED — `fleet-image-pull.md` §6.2, split out
   * of `provision_failed` because the remedy is categorically different: nothing
   * about this repo, this tenant or a retry changes anything, a human has to fix
   * the image's visibility, its digest or the mirror, and every queued index hits
   * it identically. The name is what lets an operator read a wall of failures as
   * ONE fault.
   */
  | { outcome: 'image_unpullable'; detail: string }
  /**
   * The container ran and was torn down. `verdict` says what the RUN did;
   * `reason` says how the CONTAINER ended, and they are deliberately separate
   * vocabularies — `TeardownReason` records the fleet's view of a machine, and
   * widening it to carry an indexer diagnosis would make every consumer of that
   * enum learn values it can never observe.
   */
  | {
      outcome: 'settled';
      reason: TeardownReason;
      verdict: IndexExitVerdict;
      containerId: string;
      billableSeconds: number;
      costUsd: string;
      /** The §5 container-seconds record, produced BY the teardown and PERSISTED
       *  by it (MOTIR-1995). Still carried out: this outcome is the durable step's
       *  return value and becomes the run's `job_run` ledger entry, which is a
       *  different record from the queryable cost row — per-run trail vs.
       *  aggregated tenant-attributed cost. */
      usage: ContainerUsage;
      failureDetail: string | null;
      /**
       * THE CORE-SIDE SPANS FOR THIS CONTAINER (MOTIR-4413), in milliseconds.
       *
       * ⚠️ ATTACHED BY {@link codeGraphIndexDispatchService.advanceIndexContainer}
       * AFTER the settle step returns — deliberately NOT part of what
       * `index-settle:<pid>` memoizes. A span belongs to the DISPATCH, not to the
       * teardown, and widening the settle memo would freeze these numbers into a
       * `job_step` row whose shape a hundred in-flight runs already hold.
       * Re-deriving them on every pass from the memoized admit result, the
       * memoized session and the `job_supervision` row costs nothing and cannot
       * disagree with itself.
       *
       * Absent when nothing could be computed — telemetry never fails a run.
       */
      coreTimings?: IndexCoreSpans;
      /**
       * WHAT THIS CONTAINER DID — `sync` or `rebuild` (MOTIR-4945).
       *
       * ⚠️ ATTACHED BESIDE {@link IndexDispatchOutcome.coreTimings}, by
       * {@link codeGraphIndexDispatchService.advanceIndexContainer} AFTER the
       * settle step returns, and for the same reason: the mode belongs to the
       * DISPATCH, not to the teardown, so widening the `index-settle:<pid>` memo
       * would freeze it into a `job_step` row whose shape in-flight runs already
       * hold. It is re-derived on every pass from the memoized SESSION, which
       * cannot disagree with itself.
       *
       * Absent when the session carries no grant — an in-flight run whose
       * `index-boot` memo predates this card. Absent means UNKNOWN, never
       * `rebuild`.
       */
      indexMode?: IndexMode;
    }
  /**
   * Teardown itself failed, so the container may still be running. Reported
   * rather than swallowed, and NOT dressed up as a settled run: the reaper is the
   * backstop that still destroys it.
   */
  | { outcome: 'teardown_failed'; detail: string };

/**
 * What {@link codeGraphIndexDispatchService.advanceIndexContainer} returns: the
 * LAST attempt's outcome, plus how many attempts it took when that was more than
 * one (MOTIR-6586).
 *
 * ⚠️ A SEPARATE TYPE, NOT A FIELD ON {@link IndexDispatchOutcome}. That union is
 * what `index-boot:` and `index-settle:` MEMOIZE, and its shape is pinned by id
 * (`tests/jobs/stepResultShapePins.ts`); widening it would change the memo
 * shape of two steps that provision and tear down, which may not take new ids.
 * The count is attached after the steps return, like `coreTimings`.
 */
export type IndexAdvanceOutcome = IndexDispatchOutcome & {
  /** Absent on a first-attempt outcome; `2..MAX_DISPATCH_ATTEMPTS` otherwise. */
  readonly attempts?: number;
  /**
   * MOTIR-7130 — set only on a SETTLED `upload_failed` attempt whose run motir-ai
   * recorded as refused for size (`GRAPH_TOO_LARGE`): the graph's uncompressed
   * size and the supported maximum, in bytes. Attached after the steps return,
   * like `attempts`, so no memoized shape widens.
   */
  readonly refusedForSize?: IndexSizeRefusal;
};

/** A graph motir-ai refused at the upload grant for being over the supported maximum. */
export interface IndexSizeRefusal {
  readonly sizeBytes: number;
  readonly capBytes: number;
}

/** Bytes in binary units with at most one decimal — `1.4 GiB`, `1 GiB`. */
function formatBinaryBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.floor(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${units[unit]}`;
}

/** One container's core-side spans: the `phasesMs` map, plus the sum of what is in it. */
export interface IndexCoreSpans {
  phasesMs: Partial<Record<IndexCorePhase, number>>;
  totalMs?: number;
}

/**
 * A span between two ISO instants, or `undefined` when it cannot be computed.
 *
 * ⚠️ IT NEVER THROWS AND NEVER GUESSES, which is the whole contract
 * (MOTIR-4413). `logPhaseTimings`'s header states the same rule for the motir-ai
 * half — *"a run must not fail on its own telemetry"* — and here the stakes are
 * higher: the ledger row this ends up on is a permanent claim that the repo is
 * indexed (`docs/decisions/code-graph-index-fleet.md` §6), so a malformed
 * instant must cost a missing FIELD, never a failed run.
 *
 * Four ways a span is refused, and each of them is a real state rather than a
 * defensive flourish:
 *
 *   • an instant is ABSENT — an in-flight run whose `index-admit` memo was
 *     written before this card shipped replays the OLD shape, so `from` arrives
 *     `undefined` for as long as those runs live;
 *   • an instant is UNPARSEABLE — `new Date(x).getTime()` is `NaN`, which
 *     compares false against everything and would otherwise flow into the total;
 *   • the span is NEGATIVE — the container clock and this process's clock are
 *     not the same clock, and a negative duration is a fact about that, not
 *     about the fleet;
 *   • the span is not FINITE.
 */
function spanMs(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const ms = end - start;
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined;
}

/**
 * Assemble the `phasesMs` map from spans that may each be absent, and total ONLY
 * what is present.
 *
 * ⚠️ AN ABSENT PHASE IS OMITTED FROM THE MAP, NOT WRITTEN AS ZERO. The two are
 * opposite claims — "this took no time" versus "this could not be measured" —
 * and a reader diagnosing a slow refresh has to be able to tell them apart. For
 * the same reason `totalMs` is the sum of the spans PRESENT and is itself absent
 * when the map is empty: a total over an incomplete map is a number that invites
 * exactly the subtraction it cannot support.
 */
function coreSpansOf(spans: Partial<Record<IndexCorePhase, number | undefined>>): IndexCoreSpans {
  const phasesMs: Partial<Record<IndexCorePhase, number>> = {};
  for (const [phase, ms] of Object.entries(spans) as [IndexCorePhase, number | undefined][]) {
    if (typeof ms === 'number') phasesMs[phase] = ms;
  }
  const present = Object.values(phasesMs);
  return present.length === 0
    ? { phasesMs }
    : { phasesMs, totalMs: present.reduce((sum, ms) => sum + ms, 0) };
}

function sleepFor(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/**
 * How long to wait before poll number `iteration` (1-based).
 *
 * PURE, and a function of the ITERATION rather than of the clock: the durable
 * loop re-derives it on every replay pass, and a wall-clock input would make two
 * passes of the same run schedule different sleeps.
 */
export function indexPollWaitMs(iteration: number, options: IndexSupervisionOptions = {}): number {
  const base = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const cap = options.maxPollIntervalMs ?? MAX_POLL_INTERVAL_MS;
  const grown = base * POLL_BACKOFF_FACTOR ** Math.max(0, iteration - 1);
  return Math.min(Math.max(base, grown), Math.max(base, cap));
}

/**
 * How long to wait before admission attempt number `attempt` (1-based).
 *
 * PURE, and a function of the ATTEMPT rather than of the clock — the same
 * contract {@link indexPollWaitMs} has and for the same reason: the durable loop
 * re-derives every wait on a replay pass, and a wall-clock input would make two
 * passes of one run schedule different sleeps.
 */
export function indexAdmissionWaitMs(
  attempt: number,
  options: IndexSupervisionOptions = {},
): number {
  const base = options.admissionWaitMs ?? ADMISSION_RETRY_BASE_MS;
  const cap = options.maxAdmissionWaitMs ?? ADMISSION_RETRY_MAX_MS;
  const grown = base * ADMISSION_RETRY_FACTOR ** Math.max(0, attempt - 1);
  return Math.min(Math.max(base, grown), Math.max(base, cap));
}

/**
 * The exit code → what happened. The one place the number is interpreted; the
 * port deliberately does not (§4 rule 1 — it makes the code observable and stops
 * there).
 */
export function classifyIndexExit(exitCode: number | null): IndexExitVerdict {
  const verdict = (
    exitClass: IndexExitClass,
    flags: { indexed?: boolean; redispatchable?: boolean },
    detail: string,
  ): IndexExitVerdict => ({
    exitClass,
    exitCode,
    indexed: flags.indexed ?? false,
    redispatchable: flags.redispatchable ?? false,
    detail,
  });

  switch (exitCode) {
    case 0:
      return verdict(
        'indexed',
        { indexed: true },
        'the graph was built, uploaded and its pointer recorded',
      );
    case 10:
      // A dispatcher bug. Re-dispatching sends the same spec and fails the same
      // way, so calling it re-dispatchable would loop on our own defect.
      return verdict(
        'dispatch_malformed',
        {},
        'the container was booted with a missing or blank variable; nothing was attempted',
      );
    case 20:
      // The one class where an immediate re-dispatch is usually right: the
      // pre-signed tarball URL is short-lived by design, and a fresh dispatch
      // resolves a fresh one.
      return verdict(
        'repo_unfetchable',
        { redispatchable: true },
        'the repo could not be obtained — the tarball URL was refused or expired, or the archive was unreadable',
      );
    case 30:
      return verdict(
        'graph_unbuildable',
        {},
        'the source arrived but the engine could not build a graph from it',
      );
    case 40:
      return verdict(
        'upload_failed',
        { redispatchable: true },
        'the graph was built but object storage refused or dropped the upload',
      );
    case 41:
      // Inert rather than corrupting: the snapshot key is derived from the
      // commit, so a retry overwrites the orphaned object.
      return verdict(
        'pointer_unrecorded',
        { redispatchable: true },
        'the graph landed in object storage but motir-ai refused to move the pointer',
      );
    case 50:
      // ⚠️ NEVER RETRY WITH ANOTHER IDENTITY (§4). A refusal is a scope or
      // configuration fault, and re-dispatching with a freshly minted credential
      // would mask exactly the failure the credential boundary exists to make
      // loud.
      return verdict(
        'credential_refused',
        {},
        'the run-scoped credential was refused — expired, or out of scope for the operation attempted; do NOT retry with a broader identity',
      );
    case 137:
      // The kernel killed the process, so nothing in the image's own taxonomy
      // ran. "The machine was too small for this tree" is a different fact from
      // "the engine rejected it", and a retry at the same size repeats it.
      return verdict(
        'out_of_memory',
        {},
        'the kernel OOM-killed the container — the machine was too small for this tree',
      );
    case null:
      // ⚠️ COMMON BY CONSTRUCTION, WHICH IS WHY IT IS NOT RE-DISPATCHABLE. A
      // machine that finishes destroys itself, and a destroyed machine reports no
      // exit code — so a poll that arrives after the exit sees "stopped, code
      // unknown". Treating that as a retry signal would re-index every repo that
      // ever finished between two polls, on a fleet with nothing but Motir's own
      // counter in front of the invoice (§7.2). It is equally not a success:
      // `indexed` stays false, so nothing downstream may claim the repo has a
      // graph.
      return verdict(
        'exit_unobserved',
        {},
        'the container stopped before its exit code could be read; whether it indexed is unknown',
      );
    default:
      return verdict(
        'unclassified',
        {},
        `the container exited ${exitCode}, which the indexer's taxonomy does not name`,
      );
  }
}

/** The verdict for a supervision outcome that is not a container exit at all. */
function supervisionVerdict(
  exitClass: 'never_started' | 'supervision_timed_out',
): IndexExitVerdict {
  return exitClass === 'never_started'
    ? {
        // Nothing ran: the machine never left the provider's boot. A fresh one
        // is cheap — the boot deadline is minutes — and usually lands.
        exitClass,
        exitCode: null,
        indexed: false,
        redispatchable: true,
        detail: 'the container was provisioned but never started',
      }
    : {
        exitClass,
        exitCode: null,
        indexed: false,
        // ⚠️ NOT RE-DISPATCHABLE, since the flag gained a reader (MOTIR-6586).
        // The deadline and the poll ceiling are the ENTIRE index budget, so a
        // container here already cost the most any container may cost; a fresh
        // one on the same tree at the same size mostly repeats it, like `137`.
        // It was `true` for as long as nothing read it. The next push re-indexes.
        redispatchable: false,
        detail: 'supervision gave up on the container before it reported a terminal state',
      };
}

export const codeGraphIndexDispatchService = {
  /**
   * ASK THE INDEX ALLOWANCE BEFORE ANYTHING BOOTS (MOTIR-4593 · Story MOTIR-4335).
   *
   * Only a HARD STOP refuses (`isIndexHardStop` — the outcome FAMILY, so a stop
   * motir-ai adds later is refused with no change here). `soft_gate_crossed`
   * BOOTS: a paid tier past its allowance keeps indexing and motir-ai records the
   * crossing. `exempt` (a meta organisation) and `no_allowance_configured` boot.
   *
   * ⚠️ NO ENTITLEMENT CHECK (decision A, MOTIR-4541). On cloud every connected
   * repository is indexed; nothing here asks whether the organisation has an AI
   * plan or has ever run an AI job. motir-ai provisions its billing identity on
   * the ask itself.
   *
   * ⚠️ "COULD NOT ASK" BOOTS. The client returns `null` for an unreachable,
   * unconfigured or older motir-ai, and a dispatcher that refused on `null` would
   * stop every index in the fleet on a transport blip — and on the day this lands
   * ahead of motir-ai's route. The container is still metered as COGS either way.
   *
   * Never throws.
   */
  async askIndexAllowance(organizationId: string): Promise<IndexAllowanceAsk> {
    const verdict = await checkIndexAllowance(organizationId);
    if (!verdict) return { proceed: true, outcome: null };
    const reason = indexPauseReasonFor(verdict.outcome);
    return reason
      ? { proceed: false, outcome: verdict.outcome, reason }
      : { proceed: true, outcome: verdict.outcome };
  },

  /**
   * STEP 0 — THE ADMISSION CAP (MOTIR-1990). Ask for a slot; do not boot without
   * one.
   *
   * Bounded by construction: one locked transaction, four counted reads, no
   * external call and no wait — so the step it runs in is milliseconds even when
   * the answer is "wait". THE WAITING IS THE CALLER'S, and deliberately so: a
   * gate that slept inside itself would hold an Inngest invocation open for the
   * duration, which is the shape MOTIR-2007 removed from this fleet. The step
   * driver sleeps with `ctx.step.sleep` (no invocation at all) and asks again;
   * {@link runIndexContainer} does the in-process equivalent.
   *
   * Thin by design — the decision, the lock and every number live in
   * `codeGraphIndexAdmissionService` / `lib/ciFleet/limits.ts`. This is the seam
   * that puts them on the dispatch path, so the job never has to know that a
   * `fleet_in_flight_slot` exists.
   */
  async admitIndexContainer(
    input: IndexDispatchInput,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexAdmissionVerdict> {
    return codeGraphIndexAdmissionService.admit({
      projectId: input.projectId,
      repoRef: input.repoRef,
      // WHICH DISPATCH is asking (MOTIR-2160). The slot ref names the
      // (repo × project) and nothing else, so this is what tells this run's own
      // replay apart from a second run arriving on a later push while the first
      // container is still building — the first keeps its capacity, the second waits.
      dispatchId: input.dispatchId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      // The container's REAL hard kill, which the slot's safety net is derived
      // from. A shorter value would stop counting a container that is still
      // running and spending — the one direction the ceiling must never err in.
      containerTimeoutMs: options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS,
    });
  },

  /**
   * STEP 1 — resolve, mint, boot, and hand back a session.
   *
   * Everything that has to happen exactly once and costs money: the config gate,
   * the run-scoped credential, the pre-signed URL, the container. Bounded by
   * construction — three external calls, no loop, no wait.
   *
   * ⚠️ IT THROWS FOR THE THREE FAILURES THAT ARE NOT ABOUT THIS CONTAINER, and
   * that asymmetry with `ciRunnerBootService.bootIntent` (which never throws for
   * an outcome it can name) is deliberate. There, a throw is a retry that mints a
   * SECOND GitHub runner. Here nothing has been provisioned or registered when
   * any of the three fires, so a throw leaks nothing — and each of them must be
   * loud:
   *
   *   • THE FLEET IS UNCONFIGURED — {@link indexFleetConfig} names every missing
   *     variable at once. A path that quietly returned "nothing to do" would let
   *     the job record a `succeeded` `job_run` carrying an `output.repoRef` for a
   *     repo nothing ever indexed, which is indistinguishable from success
   *     everywhere downstream, forever (§5's ledger constraint).
   *
   *     ⚠️ `MOTIR_AI_CONTAINER_URL` JOINS IT (MOTIR-4518), through
   *     {@link motirAiContainerBaseUrl}, and joins it HERE rather than as a
   *     default. It is the address the container reaches motir-ai at, and it is
   *     NOT motir-core's own — the two callers are in different organizations.
   *     Unset it throws, which costs one dead-lettered run and no machine;
   *     defaulted to motir-core's private address it costs nineteen minutes of
   *     billed container per run, for ever, under a green ledger. That is not a
   *     hypothetical: it is what happened, twice a refresh, for two weeks.
   *   • THE CREDENTIAL COULD NOT BE MINTED — there is NO fallback. Not
   *     `MOTIR_AI_SERVICE_TOKEN`, not any broader token: motir-ai's
   *     container-facing routes refuse the service token by design
   *     (`ServiceTokenNotAcceptedError`), so reaching for one would be a silent
   *     privilege escalation that the closed layer would then refuse anyway.
   *   • THE TARBALL URL COULD NOT BE RESOLVED — the lenient alternative would be
   *     to buffer a whole repo into this function's heap, which is the OOM (§2:
   *     `motir-core`, 5/5 attempts) that moving indexing onto containers exists
   *     to remove. (The byte-fetching provider method that made that alternative
   *     reachable is gone since MOTIR-2124.)
   *
   *     ⚠️ A HOST THAT CAN *NEVER* RESOLVE ONE SHOULD NOT REACH THIS FUNCTION AT
   *     ALL. Throwing is right for a resolve that FAILED; it is wrong as the
   *     discovery mechanism for a host that structurally cannot, because a throw
   *     here costs five retries and a dead-letter per trigger and explains
   *     nothing. `codeGraphIndexService.resolveIndexTarget` refuses those up
   *     front (`provider_cannot_index`), so what still throws here is a GitHub
   *     repo whose resolve genuinely broke — which IS worth the retry budget.
   *
   * A PROVISION that fails is different in kind — it is about this dispatch, the
   * port guarantees no container was left behind, and its reason is diagnostic —
   * so it comes back as a terminal outcome the ledger can record.
   *
   * ⚠️ `admission` IS REQUIRED, and that is the cap's enforcement (MOTIR-1990).
   * It is the ticket {@link admitIndexContainer} hands back once a
   * `fleet_in_flight_slot` is really taken, so there is no way to reach this
   * function without having been counted — the same compile-time shape the
   * repository layer gets from a non-optional `tx`. NOTHING here re-checks a cap:
   * the decision was made under the lock, and re-deciding outside it would be the
   * TOCTOU the lock exists to close.
   *
   * ⚠️ AND EVERY FAILURE PATH GIVES THE SLOT BACK. A mint that throws, an
   * unresolvable URL, a refused provision — none of them leaves a container
   * behind, so none of them may leave capacity held. Without this the slot would
   * sit until its TTL ages it out, and a deployment failing every boot would
   * silently shrink the fleet to nothing while booting no containers at all.
   */
  async bootIndexContainer(
    input: IndexDispatchInput,
    admission: IndexAdmission,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexBootResult> {
    const now = options.now ?? (() => new Date());
    const indexTimeoutMs = options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;

    let fleet: IndexFleetConfig;
    let aiBaseUrl: string;
    let orchestrator: ContainerOrchestrator | undefined;
    let credential: Awaited<ReturnType<typeof mintCodeGraphRunCredential>>;
    let tarballUrl: string;

    // ── The admitted ACCOUNT's orchestrator (MOTIR-9448), before anything is
    // spent. An account that cannot be reached (its row gone, its credential
    // unset) is a failed boot that gives the slot back — never a throw that
    // strands it until the TTL, and never a quiet fall back to the process-wide
    // fleet, which the admission did not count it against.
    if (admission.shardId) {
      try {
        orchestrator = await fleetShardOrchestratorService.forShard(admission.shardId);
      } catch (err) {
        await codeGraphIndexAdmissionService.release(admission.slotRef, input.dispatchId);
        const detail = `the fleet account ${admission.shardId} could not be reached: ${detailOf(err)}`;
        return { phase: 'terminal', outcome: { outcome: 'provision_failed', detail } };
      }
    }

    try {
      // ── 0 · The deployment gate, BEFORE anything is spent ──────────────────
      fleet = indexFleetConfig();
      // ⚠️ THE *CONTAINER'S* ACCESSOR, NOT motir-core's OWN (MOTIR-4518). These
      // are two different addresses for one service because the two callers sit
      // in two different organizations: motir-core reaches motir-ai at
      // `MOTIR_AI_URL` (a 6PN name, resolvable only inside `moooon`, until
      // 2026-10-02; the public origin since — application-hosting.md
      // Amendment 9), while the machine booted below runs in the FLEET's
      // organization, where a 6PN name is NXDOMAIN. This line read `motirAiBaseUrl()` until 2026-09-04 and handed
      // the container motir-core's own private address; every run since
      // 2026-08-21 built its graph and then died at
      // `getaddrinfo ENOTFOUND motir-ai.internal`, one call before the upload
      // grant, while the ledger recorded success. There is NO fallback between
      // the two: unset is a throw, here, before a machine is billed.
      aiBaseUrl = motirAiContainerBaseUrl();
      orchestrator ??= getOrchestrator();

      // ── 1 · Mint THIS run's motir-ai credential ────────────────────────────
      // Scoped to one (project, repo, run) for minutes, and the only motir-ai
      // credential the container is given. Its LIFETIME is derived from the
      // deadline this same call is about to give the container — see
      // {@link CREDENTIAL_GRACE_MS} for why that derivation exists and why
      // renewal is not the answer for this holder.
      credential = await mintCodeGraphRunCredential({
        coreOrganizationId: input.organizationId,
        coreWorkspaceId: input.workspaceId,
        coreProjectId: input.projectId,
        repoRef: input.repoRef,
        runId: input.runId,
        ttlSeconds: runCredentialTtlSeconds(indexTimeoutMs),
      });

      // ⚠️ ASKING IS NOT AGREEING — CHECK WHAT CAME BACK (MOTIR-4923). The TTL
      // above is a REQUEST: motir-ai clamps it to its own [60, 3600] window and
      // an older motir-ai ignores the field entirely, so the only thing that
      // makes the two deadlines one decision is reading the answer against ours.
      // A shortfall here is the whole defect, twenty minutes earlier and for
      // nothing: the alternative is a container that builds a graph it will not
      // be allowed to hand back, and a `credential_refused` an operator cannot
      // tell from a scope refusal. Nothing is provisioned yet, and the catch
      // below returns the admission slot.
      const requiredUntil = now().getTime() + indexTimeoutMs;
      const grantedUntil = Date.parse(credential.expiresAt);
      if (!Number.isFinite(grantedUntil) || grantedUntil < requiredUntil) {
        throw new CodeGraphRunCredentialTooShortError(
          credential.expiresAt,
          new Date(requiredUntil).toISOString(),
        );
      }

      // ── 2 · Resolve the pre-signed tarball URL ─────────────────────────────
      // AFTER the mint, deliberately: the URL is the shorter-lived of the two
      // secrets, so its clock starts as late as possible before the boot. Reached
      // through the REQUIRE helper, which is what turns "this host cannot" into a
      // refusal instead of a fallback to downloading the bytes.
      const resolveTarballUrl = requireRepoTarballUrlResolver(getGitProvider(input.providerId));
      tarballUrl = await resolveTarballUrl(
        input.installationId,
        input.repoOwner,
        input.repoName,
        input.defaultBranch,
      );
    } catch (err) {
      // The three loud failures still throw — the ledger must never record a
      // success for a repo nothing indexed — but the capacity goes back first.
      await codeGraphIndexAdmissionService.release(admission.slotRef, input.dispatchId);
      throw err;
    }

    // ── 3 · Boot exactly one container ───────────────────────────────────────
    const spec = codeGraphIndexDispatchService.buildIndexSpec({
      target: input,
      fleet,
      aiBaseUrl,
      tarballUrl,
      runCredential: credential.credential,
      // MOTIR-3252 — present only when motir-ai decided this run may sync
      // (a snapshot exists AND its engine version matches the container's).
      // Forwarded, never inspected: this side cannot tell a good grant from a
      // bad one and has no business trying.
      ...(credential.previousSnapshotUrl
        ? { previousSnapshotUrl: credential.previousSnapshotUrl }
        : {}),
      timeoutSeconds: Math.ceil(indexTimeoutMs / 1000),
    });

    let handle: ContainerHandle;
    try {
      handle = await orchestrator.provision(spec);
    } catch (err) {
      // The port guarantees a failed `provision` left no container behind, so
      // the slot stands for nothing and is released rather than aged out.
      await codeGraphIndexAdmissionService.release(admission.slotRef, input.dispatchId);
      if (err instanceof OrchestratorImageUnpullableError) {
        const detail = `the indexer image could not be pulled: ${detailOf(err)}`;
        console.error('[codeGraphIndexDispatchService] the indexer image is not pullable', {
          repoRef: input.repoRef,
          projectId: input.projectId,
          image: err.imageReference,
        });
        return { phase: 'terminal', outcome: { outcome: 'image_unpullable', detail } };
      }
      const detail = `could not boot an index container: ${detailOf(err)}`;
      return { phase: 'terminal', outcome: { outcome: 'provision_failed', detail } };
    }

    return {
      phase: 'supervising',
      session: {
        handle: {
          provider: handle.provider,
          id: handle.id,
          region: handle.region,
          createdAt: handle.createdAt.toISOString(),
        },
        bootedAt: now().toISOString(),
        credentialExpiresAt: credential.expiresAt,
        runId: input.runId,
        dispatchId: input.dispatchId,
        repoRef: input.repoRef,
        slotRef: admission.slotRef,
        ...(admission.shardId ? { shardId: admission.shardId } : {}),
        // MOTIR-4945 — the MODE, recorded at the only moment it is knowable.
        //
        // ⚠️ THE SAME PREDICATE THE SPEC BRANCHED ON, deliberately, and it must
        // stay that way: `buildIndexSpec` above forwards `previousSnapshotUrl`
        // under a TRUTHINESS test, so a falsy value means the container was NOT
        // handed a snapshot and did NOT sync. Recording the mode off a different
        // test (`!== undefined`, say) would let the ledger claim `sync` for a run
        // that provably rebuilt — a wrong answer that no signal would ever
        // contradict, on the one field this card exists to make trustworthy.
        // `motirAiClient` already normalises an empty string to `undefined`, so
        // today the two tests agree; this line does not depend on that.
        syncGranted: Boolean(credential.previousSnapshotUrl),
        attribution: {
          orgId: input.organizationId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          repoFullName: input.repoRef,
        },
      },
    };
  },

  /**
   * STEP 2 (×N) — ONE provider read, and return.
   *
   * Exactly one `describe`, the deadlines applied to what came back, and a
   * return. No loop, no sleep, no second call — so the step it runs in is
   * milliseconds and the constraint cannot silently regress into a long step. The
   * WAITING between polls is `ctx.step.sleep`, which costs no invocation at all.
   *
   * ⚠️ AND IT NEVER THROWS. In a stepped world teardown cannot be reached from a
   * catch — the executor finalizes a terminally-failed step before anything
   * scheduled from a `catch` could run — so the guarantee is structural instead:
   * every failure becomes a typed result, and the only exit is a `done` verdict
   * the caller takes to {@link settleIndexContainer}.
   */
  async pollIndexContainer(
    session: IndexSession,
    previous: Extract<IndexPollResult, { done: false }> = INITIAL_INDEX_POLL_STATE,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexPollResult> {
    const now = options.now ?? (() => new Date());
    const bootDeadlineMs = options.bootDeadlineMs ?? DEFAULT_BOOT_DEADLINE_MS;
    const indexTimeoutMs = options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;
    const bootedAt = new Date(session.bootedAt).getTime();

    let startedAt = previous.startedAt;

    /**
     * The deadline check BOTH the happy and the failed-read paths fall through
     * to, so a provider that is down can never extend a container past its
     * timeout.
     *
     * ⚠️ THE BOOT DEADLINE NEEDS A SUCCESSFUL READ; THE RUN TIMEOUT DOES NOT
     * (MOTIR-3482 §13.3(b)). "The container never started" is a claim about what
     * the provider SAID, and its only evidence is `startedAt` being absent from a
     * status we actually got. On the failed-read path there is no such status, so
     * `!startedAt` there means *either* "it never started" *or* "this pass has not
     * managed to ask yet" — and after the collapse the second reading is
     * reachable at ANY elapsed time, because a worker restart resets the loop's
     * in-memory `startedAt` and only a successful read re-heals it. A container
     * running healthily for twenty minutes, met by a reclaim and one failed read,
     * would otherwise be classified `never_started` and re-dispatched.
     *
     * The RUN timeout is unconditional in both arms, because it is derived from
     * `session.bootedAt` — a field on the memoized boot result — and depends on
     * no in-memory observation at all. So an unreadable provider still cannot
     * extend a container past its timeout, which is the property this function
     * exists for.
     *
     * This is also a latent defect on the SHIPPED code, not one the collapse
     * introduces: a first read failing after `bootDeadlineMs` on a slow-but-live
     * boot misclassifies today too. What the collapse changes is how often the
     * second reading is reachable.
     */
    const deadlineVerdict = (
      failureDetail: string | null,
      readSucceeded: boolean,
    ): IndexPollResult | null => {
      const elapsed = now().getTime() - bootedAt;
      if (readSucceeded && !startedAt && elapsed >= bootDeadlineMs) {
        return {
          done: true,
          reason: 'provision_failed',
          startedAt: null,
          exitCode: null,
          failureDetail: failureDetail ?? 'the container never started',
        };
      }
      if (elapsed >= indexTimeoutMs) {
        return {
          done: true,
          reason: 'job_timed_out',
          startedAt,
          exitCode: null,
          failureDetail: failureDetail ?? 'the index run outlived its timeout',
        };
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
      });
    } catch (err) {
      // A single provider blip must not end an index that is running fine. The
      // deadlines remain the real bound — this buys the loop the right to MISS a
      // few reads, never the right to run longer.
      const consecutiveReadFailures = previous.consecutiveReadFailures + 1;
      const detail = `${detailOf(err)}${onAccount(session)}`;
      if (consecutiveReadFailures > MAX_CONSECUTIVE_READ_FAILURES) {
        // Give up on READING, but not on tearing down: a `done` verdict is what
        // routes this to teardown, which is why it returns rather than throws.
        return {
          done: true,
          reason: 'job_timed_out',
          startedAt,
          exitCode: null,
          failureDetail: `the container status could not be read: ${detail}`,
        };
      }
      console.warn('[codeGraphIndexDispatchService] a container status read failed — retrying', {
        containerId: session.handle.id,
        provider: session.handle.provider,
        consecutiveReadFailures,
      });
      // The FAILED-READ arm: no status came back, so only the run timeout may
      // fire here — see `deadlineVerdict`'s own note.
      return deadlineVerdict(null, false) ?? { done: false, startedAt, consecutiveReadFailures };
    }

    if (status.startedAt && !startedAt) startedAt = status.startedAt.toISOString();

    // THE CHECKPOINT (MOTIR-1995) — what this container has cost SO FAR, recorded
    // before it stops. Only once it has been seen running: a container that has not
    // started has accrued nothing, and Fly bills a Machine on its RUNNING seconds.
    //
    // ⚠️ IT IS SAFE ON THIS PATH FOR TWO INDEPENDENT REASONS, and both are needed.
    // `recordContainerAccrual` never throws, so it cannot break the never-throws
    // contract above. And the figure it reports is ABSOLUTE-to-date rather than a
    // delta, so a durable step that REPLAYS this poll — the normal case, not an edge
    // one — re-reports the same total and adds nothing. A delta here would have made
    // every replay overstate Motir's own cost, invisibly.
    if (startedAt) {
      await recordContainerAccrual(
        buildContainerAccrual({
          handle: {
            provider: session.handle.provider,
            id: session.handle.id,
            region: session.handle.region,
            createdAt: new Date(session.handle.createdAt),
          },
          attribution: indexUsageAttribution(session),
          createdAt: new Date(session.handle.createdAt),
          startedAt: new Date(startedAt),
          observedAt: now(),
        }),
      );
    }

    if (status.terminal) {
      // Gone or stopped. If it was never seen running, the container is a boot
      // that never happened — a provisioning failure even though the provider
      // reported success.
      const observed = startedAt ?? status.startedAt?.toISOString() ?? null;
      if (status.imagePullFailed) {
        // The VM booted but could not pull the image (MOTIR-9446): the same
        // condition a create-time refusal reports, so it ends the same way.
        return {
          done: true,
          reason: 'provision_failed',
          startedAt: observed,
          exitCode: null,
          failureDetail: 'the indexer image could not be pulled on the VM',
          imageUnpullable: true,
        };
      }
      return {
        done: true,
        reason: observed ? 'job_completed' : 'provision_failed',
        startedAt: observed,
        // ⚠️ THE EXIT CODE IS READ HERE OR NOT AT ALL. Once the machine is torn
        // down there is nothing left to ask, and `describe` on a machine that
        // already destroyed itself answers `null` — which is why the poll cadence
        // above is tighter than the CI fleet's.
        exitCode: status.exitCode,
        failureDetail: null,
      };
    }

    // The read SUCCEEDED, so `startedAt` above is the provider's own answer and
    // the boot deadline is decidable from it.
    return deadlineVerdict(null, true) ?? { done: false, startedAt, consecutiveReadFailures: 0 };
  },

  /**
   * STEP 3 — THE TEARDOWN, and the only way supervision ends.
   *
   * Destroys the container and classifies what it did. Teardown is what PRODUCES
   * the usage record — the port made that unskippable so a container cannot be
   * destroyed without its cost row existing — and the record rides out on the
   * outcome for MOTIR-1995's meter to persist.
   *
   * ⚠️ AND IT GIVES THE ADMISSION SLOT BACK — but ONLY once the container is
   * really gone (MOTIR-1990). A teardown that FAILED means the container may
   * still be running and still spending, so its slot deliberately stays: it ages
   * out through `expires_at` while the reaper does its work. Releasing there
   * would under-count a live container, which is the one direction the ceiling
   * must never err in. A teardown that had no orchestrator to reach is the same
   * case for the same reason.
   */
  async settleIndexContainer(
    session: IndexSession,
    verdict: Extract<IndexPollResult, { done: true }>,
  ): Promise<IndexDispatchOutcome> {
    const handle: ContainerHandle = {
      provider: session.handle.provider,
      id: session.handle.id,
      region: session.handle.region,
      createdAt: new Date(session.handle.createdAt),
    };
    const observedStartedAt = verdict.startedAt ? new Date(verdict.startedAt) : null;

    let orchestrator: ContainerOrchestrator;
    try {
      orchestrator = await orchestratorFor(session);
    } catch (err) {
      console.error('[codeGraphIndexDispatchService] no orchestrator at teardown', {
        containerId: handle.id,
        repoRef: session.repoRef,
        shardId: session.shardId ?? null,
      });
      if (session.shardId) {
        // ⚠️ AN ACCOUNT THAT CAN NO LONGER BE REACHED (MOTIR-9448) — its row
        // gone or its key unreadable — will not become reachable on a retry, so
        // its slot is given back rather than held to the TTL. The container may
        // still run: the outcome says so and leaves it to the orphan reaper.
        await codeGraphIndexAdmissionService.release(session.slotRef, session.dispatchId);
        return {
          outcome: 'teardown_failed',
          detail: `the fleet account ${session.shardId} could not be reached at teardown for container ${handle.id}; left for the reaper: ${detailOf(err)}`,
        };
      }
      return {
        outcome: 'teardown_failed',
        detail: `no orchestrator at teardown for container ${handle.id}; left for the reaper: ${detailOf(err)}`,
      };
    }

    // ⚠️ THE GUARANTEE. Every path out of supervision arrives here — indexed,
    // failed, never started and unreadable alike. `teardown` is idempotent, so
    // the reaper reaching the same container later is harmless.
    let usage: ContainerUsage;
    try {
      usage = await orchestrator.teardown(
        handle,
        verdict.reason,
        indexUsageAttribution(session, observedStartedAt),
      );
    } catch (err) {
      console.error('[codeGraphIndexDispatchService] could not tear down an index container', {
        containerId: handle.id,
        provider: handle.provider,
        reason: verdict.reason,
      });
      return {
        outcome: 'teardown_failed',
        detail: `teardown failed for container ${handle.id}; left for the reaper: ${detailOf(err)}`,
      };
    }

    // PERSIST THE COST (MOTIR-1995) — the record teardown just produced, RECONCILED
    // against whatever the checkpoints already accrued for this container. It runs
    // after teardown rather than beside it because the container being gone is the
    // property that actually stops the spend; the sink never throws, so a write
    // failure cannot turn "destroyed and unrecorded" into "possibly still running".
    //
    // The record still rides out on the outcome as well. It is not redundant: the
    // outcome is the durable step's return value and lands in the `job_run` ledger
    // as this run's operational trail, while the row this writes is the queryable,
    // aggregated, tenant-attributed one the margin readout reads.
    await recordContainerUsage(usage);

    const exitVerdict = exitVerdictFor(verdict);

    // DRAW THE INDEX ALLOWANCE (MOTIR-4593) — ONE draw per container, here and only
    // here. Teardown is reached on every path out of supervision, so a FAILED
    // container draws exactly like an indexed one: it ran, and its seconds were
    // Motir's.
    //
    // ⚠️ NOT ON THE ACCRUAL. `recordContainerAccrual` writes `billable_seconds` as a
    // TOTAL to date, never a delta; drawing there as well would attribute the same
    // seconds twice.
    //
    // ⚠️ Motir does not charge for code indexing. This is internal accounting, and
    // it cannot move the organisation's visible credit balance — motir-ai has no
    // path from the draw to the ledger. The client is total and the key is the
    // container, so a replayed settle attributes once and a failed draw never
    // fails a teardown.
    await drawAllowanceForContainer(session, handle, usage, exitVerdict);

    // AND GIVE THE CAPACITY BACK (MOTIR-1990). After the cost is recorded, so the
    // slot a queued dispatch is about to claim is never freed before the spend it
    // stood for has been written down. The container is provably gone, so the
    // capacity is provably free — which is only true on THIS path: a failed
    // teardown returned above without releasing, because that container may still
    // be running and under-counting a live one is the direction the ceiling must
    // never err in.
    //
    // ⚠️ AND ONLY THIS DISPATCH'S OWN SLOT (MOTIR-2160). `session.dispatchId` makes the
    // delete ownership-checked, which is the same invariant read from the other
    // side: "provably gone" is a statement about THIS container, and the slot ref
    // names a (repo × project) that another run could be holding. Passing the ref
    // alone is how a settle used to free a live container's capacity.
    await codeGraphIndexAdmissionService.release(session.slotRef, session.dispatchId);

    if (verdict.imageUnpullable) {
      // Reported as the boot-time refusal is: a human fixes the image, and every
      // queued index would hit it the same way. The cost row is written above.
      console.error('[codeGraphIndexDispatchService] the indexer image is not pullable', {
        repoRef: session.repoRef,
        containerId: handle.id,
      });
      return {
        outcome: 'image_unpullable',
        detail: verdict.failureDetail ?? 'the indexer image could not be pulled',
      };
    }

    return {
      outcome: 'settled',
      reason: verdict.reason,
      verdict: exitVerdict,
      containerId: handle.id,
      billableSeconds: usage.billableSeconds,
      costUsd: usage.costUsd,
      usage,
      failureDetail: verdict.failureDetail,
    };
  },

  /**
   * The provisioning SPEC for one (repo × project) index run — the port's
   * provider-neutral shape, and the security boundary of the whole feature.
   *
   * ⚠️ PURE: every value arrives as an argument and no environment is read here.
   * That is what lets the test assert the env KEY SET without a deployment, and
   * it is what keeps the four variables the image's boot contract names
   * (`motir-ai/infra/indexer/README.md`) the only four that can be in it.
   *
   * ⚠️ FOUR VARIABLES, OR FIVE (MOTIR-3252). The fifth —
   * `MOTIR_INDEX_SNAPSHOT_URL` — appears only when motir-ai offered this run its
   * previous snapshot, and it is a third pre-signed URL rather than a widening:
   * one object, one method, minutes. Everything in the list below is still absent.
   *
   * ⚠️ WHAT IS DELIBERATELY ABSENT, since the absence is the decision (§4, §10):
   * no GitHub App key and no installation token — the pre-signed URL is
   * self-authorizing and strictly less privilege; no `DATABASE_URL`; no
   * object-storage credential — motir-ai mints a single-key upload grant instead
   * (§5); no `MOTIR_AI_SERVICE_TOKEN`; and no Fly token, which a container
   * ingesting untrusted source could use to provision in the shared fleet org.
   *
   * ⚠️ AND `FLEET_CONTAINER_SIZE`, NOT A SMALLER INDEX CLASS. The image's
   * measured floor is 2 vCPU / 4096 MB (924 MB peak RSS, 861 MB of it off-heap —
   * MOTIR-1515), which 8192 clears; and it is the only class `CONTAINER_RATES`
   * prices, so a container booted at it is COSTED rather than recorded unpriced.
   * A dedicated 4 GB index class is a rate row someone must add first, which is
   * the meter's call (MOTIR-1995), not this service's.
   */
  buildIndexSpec(args: {
    target: IndexDispatchInput;
    fleet: IndexFleetConfig;
    /**
     * motir-ai's base URL AS THE CONTAINER MUST REACH IT — without the service
     * token, and NOT the address motir-core itself uses (MOTIR-4518). It comes
     * from `motirAiContainerBaseUrl()`; see that accessor for why the two differ.
     */
    aiBaseUrl: string;
    /** The resolved pre-signed, single-repo, short-lived archive URL. */
    tarballUrl: string;
    /** This run's motir-ai credential — opaque, and the only one in the spec. */
    runCredential: string;
    /**
     * OPTIONAL (MOTIR-3252) — the pre-signed, single-key GET for the repo's
     * PREVIOUS snapshot, when motir-ai offered one. Its presence is what turns
     * this run into a SYNC rather than a whole-tree rebuild; its absence is the
     * behaviour this container had unconditionally before it existed.
     */
    previousSnapshotUrl?: string;
    timeoutSeconds: number;
  }): ContainerSpec {
    const { target, fleet, aiBaseUrl, tarballUrl, runCredential, timeoutSeconds } = args;
    return {
      orgId: target.organizationId,
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      repoFullName: target.repoRef,
      workload: CODE_GRAPH_INDEX_WORKLOAD,
      workflowJobId: NO_WORKFLOW_JOB,
      image: fleet.image,
      size: FLEET_CONTAINER_SIZE,
      timeoutSeconds,
      region: fleet.region,
      env: {
        MOTIR_INDEX_TARBALL_URL: tarballUrl,
        MOTIR_INDEX_REPO_REF: target.repoRef,
        MOTIR_AI_BASE_URL: aiBaseUrl,
        MOTIR_INDEX_RUN_CREDENTIAL: runCredential,
        // A FIFTH variable, and only sometimes — the one exception to the key set
        // above, added deliberately (MOTIR-3252). It is another PRE-SIGNED URL,
        // which is the same class of thing as the tarball: self-authorizing,
        // scoped to one object, minutes long, and useless for anything else. It
        // is NOT a new credential class, and the paragraph above stands unchanged:
        // still no GitHub key, no `DATABASE_URL`, no object-storage credential, no
        // service token, no Fly token.
        ...(args.previousSnapshotUrl ? { MOTIR_INDEX_SNAPSHOT_URL: args.previousSnapshotUrl } : {}),
      },
    };
  },

  /**
   * ONE PASS of a (repo × project) dispatch — {@link advanceIndexAttempt} for
   * attempt 1, and again for a fresh container while the last one settled with
   * a `redispatchable` verdict, up to {@link MAX_DISPATCH_ATTEMPTS} (MOTIR-6586).
   *
   * ⚠️ THE ATTEMPT NUMBER IS RE-DERIVED ON EVERY PASS, NEVER STORED. A pass
   * enters at attempt 1: a settled attempt replays its `index-settle:<subject>`
   * memo and polls nothing, so walking past it costs a memo read, and the first
   * attempt that has not settled advances by one poll and throws `JobRunDefer`
   * exactly as a single attempt always has. Which attempt a run is on is
   * therefore a fact of `job_step`, and a restart cannot lose it.
   *
   * ⚠️ ONLY A SETTLED, UN-INDEXED, RE-DISPATCHABLE VERDICT GOES ROUND AGAIN.
   * Every other outcome — an index, a non-re-dispatchable class, a deferred
   * admission, a refused provision, a failed teardown — is returned as it
   * stands, from whichever attempt produced it.
   *
   * ⚠️ AND A SIZE REFUSAL DOES NOT GO ROUND AGAIN (MOTIR-7130). `upload_failed`
   * is re-dispatchable, and it is also what a grant refusal exits with — so a
   * graph over the supported maximum used to boot {@link MAX_DISPATCH_ATTEMPTS}
   * containers, each cloning, building more than a gibibyte and being refused
   * again. On an `upload_failed` settle the attempt now reads the run's verdict;
   * a `GRAPH_TOO_LARGE` failure ends the dispatch with `refusedForSize`. Every
   * other answer — another class, `null` from an older or unreachable motir-ai,
   * a read that threw — is a plain `upload_failed` and goes round as before.
   * The read is MEMOIZED per attempt (`index-size-refusal:<subject>`), so a
   * later pass replays the decision the first one made and can never discover a
   * refusal after a second container has already booted.
   */
  async advanceIndexContainer(
    /** The `job_queue` row this supervision hangs off — `ctx.runId` for a job. */
    runId: string,
    input: IndexDispatchInput,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexAdvanceOutcome> {
    const maxAttempts = Math.max(
      1,
      Math.min(options.maxDispatchAttempts ?? MAX_DISPATCH_ATTEMPTS, MAX_DISPATCH_ATTEMPTS),
    );
    for (let attempt = 1; ; attempt += 1) {
      const subject = indexAttemptSubject(input.projectId, attempt);
      const outcome = await this.advanceIndexAttempt(runId, input, subject, options);
      const refusedForSize = await this.readSizeRefusal(input, subject, outcome, options);
      if (refusedForSize && outcome.outcome === 'settled') {
        return {
          ...outcome,
          ...(attempt === 1 ? {} : { attempts: attempt }),
          refusedForSize,
          failureDetail:
            `motir-ai refused the graph at the upload grant: it is ` +
            `${formatBinaryBytes(refusedForSize.sizeBytes)} uncompressed (${refusedForSize.sizeBytes} bytes), ` +
            `over the supported maximum of ${formatBinaryBytes(refusedForSize.capBytes)} ` +
            `(${refusedForSize.capBytes} bytes)`,
        };
      }
      const again =
        outcome.outcome === 'settled' &&
        !outcome.verdict.indexed &&
        outcome.verdict.redispatchable &&
        attempt < maxAttempts;
      if (!again) return attempt === 1 ? outcome : { ...outcome, attempts: attempt };
    }
  },

  /**
   * Was this settled attempt refused for SIZE (MOTIR-7130)? Asked only of an
   * un-indexed `upload_failed` settle — the one exit class a grant refusal
   * produces — so every other path costs no HTTP call and no step.
   *
   * ⚠️ NEVER THROWS, and a read that fails answers "no": the attempt is then a
   * plain `upload_failed`, exactly as before this card. ⚠️ MEMOIZED under
   * `index-size-refusal:<subject>` — the answer decides whether another BILLED
   * container boots, so it must not change between passes of one run.
   */
  async readSizeRefusal(
    input: IndexDispatchInput,
    subject: string,
    outcome: IndexDispatchOutcome,
    options: IndexSupervisionOptions,
  ): Promise<IndexSizeRefusal | null> {
    if (
      outcome.outcome !== 'settled' ||
      outcome.verdict.indexed ||
      outcome.verdict.exitClass !== 'upload_failed'
    ) {
      return null;
    }
    const steps = options.steps ?? INLINE_STEPS;
    const read = options.readRunVerdict ?? fetchCodeGraphRunVerdict;
    const memo = await steps.run(`index-size-refusal:${subject}`, async () => {
      try {
        const verdict = await read({
          coreWorkspaceId: input.workspaceId,
          coreProjectId: input.projectId,
          repoRef: input.repoRef,
          runId: input.runId,
        });
        const failure = verdict?.failure;
        if (
          failure?.failureClass === GRAPH_TOO_LARGE_FAILURE &&
          failure.sizeBytes !== null &&
          failure.capBytes !== null
        ) {
          return { refusedForSize: { sizeBytes: failure.sizeBytes, capBytes: failure.capBytes } };
        }
      } catch (err) {
        console.error('[index-fleet] could not read the run verdict after upload_failed', err);
      }
      return { refusedForSize: null };
    });
    return memo.refusedForSize;
  },

  /**
   * ONE PASS of ONE dispatch attempt's supervision: admit, boot, and then advance
   * the state machine by exactly one poll (Story MOTIR-3778 · MOTIR-3828).
   *
   * `subject` names the attempt ({@link indexAttemptSubject}): it keys the three
   * memoized steps and the `job_supervision` row, and for attempt 1 it is the
   * bare `projectId` every id before MOTIR-6586 was built from. Until MOTIR-6586
   * this method WAS `advanceIndexContainer`, and the header below is its own.
   *
   * ⚠️ IT USUALLY DOES NOT RETURN — it THROWS `JobRunDefer`, and that is the
   * whole shape. `docs/decisions/job-queue-foundation.md` §16 replaces the loop
   * that used to live here with a state machine over RUNS: each pass does one
   * provider read and hands its own `job_queue` row back at the next poll
   * instant, so the worker's slot is held for the duration of one `describe`
   * rather than for the duration of a container. It RETURNS only on a terminal
   * transition, with the dispatch outcome.
   *
   * ⚠️ THE HEADER ABOVE THIS METHOD HAS NOW BEEN CORRECTED TWICE, and both
   * corrections are kept because a reader has to be able to see that the world
   * changed rather than that the code did.
   *
   *   1. It first said this composition was NOT the production path, because
   *      "calling this from a job would rebuild the hour-long invocation
   *      MOTIR-2007 removed for CI" — a statement about `maxDuration = 300`, a
   *      Vercel ceiling that went with the platform.
   *   2. MOTIR-3484 then made it the ONLY composition, with an ordinary `while`
   *      loop and a `finally`, on the ground that a long-lived worker makes both
   *      trustworthy again. **Every word of that is still true, and it was never
   *      the argument that mattered here.** What the loop costs is not
   *      durability, it is OCCUPANCY: one of `POOL_SIZE` in-flight slots held
   *      for a container's whole life (`docs/decisions/job-lane-occupancy.md`).
   *      §15.4 measured the two shapes that release it and §16 decided this one.
   *
   * What SURVIVES, unchanged, and is the reason this is a re-shaping rather than
   * a rewrite:
   *
   *   • ADMIT, BOOT and SETTLE are still memoized `step.run`s. A pass replays
   *     the boot from `job_step` and re-attaches to the same container — the
   *     property §13.2 records, bought exactly where it is bought today and
   *     nowhere twice.
   *   • The ADMISSION BACKOFF is still INSIDE the admit step (§13.3(c)), not a
   *     defer loop of its own. §16.6 decides that explicitly: a resume that
   *     re-asked admission after the settle step had released the slot would be
   *     granted a fresh one and never release it.
   *   • `indexPollWaitMs`, `INDEX_FLEET_TIME_BUDGETS` and
   *     `INDEX_ADMISSION_BUDGETS` are READ, never edited. The wait moves from an
   *     in-process `await` to a `run_at`; the numbers do not move at all.
   *
   * What CHANGES: the poll loop, the iteration counter, the observed
   * `startedAt`, the read-failure tally and the project cursor all move into
   * `job_supervision` — and the `finally` goes, because teardown is a terminal
   * transition now (§16.4) and a `finally` would tear the container down on the
   * first suspension, which is exactly what §15.4 measured.
   */
  async advanceIndexAttempt(
    runId: string,
    input: IndexDispatchInput,
    /** The attempt's supervision subject — {@link indexAttemptSubject}. */
    subject: string,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexDispatchOutcome> {
    const sleep = options.sleep ?? sleepFor;
    const steps = options.steps ?? INLINE_STEPS;
    const now = options.now ?? ((): Date => new Date());

    // ── 0 · QUEUE FOR ADMISSION — over the cap means WAIT, never drop ─────────
    // ONE memoized step containing the whole backoff, unchanged (§13.3(c)).
    //
    // ⚠️ THE TWO INSTANTS RIDE THE MEMO, AND THAT IS THE ONLY REASON THE SPAN
    // EXISTS (MOTIR-4413). `advanceIndexContainer` is re-entered from the top on
    // every pass and usually leaves by throwing `JobRunDefer`, so a duration
    // accumulated in a local here would be discarded on the very first
    // suspension and read as zero for ever after. Written INSIDE the step, the
    // pair is captured once — on the pass that actually queued — and every later
    // pass replays the same two strings out of `job_step` and derives the same
    // number. `session.bootedAt` is the shipped precedent for exactly this, and
    // this is the second instance of it rather than a new idea.
    //
    // ⚠️ `waitForAdmission` ITSELF IS UNTOUCHED. The instants are taken around
    // the call rather than inside it, because `IndexAdmissionVerdict` is the
    // admission service's vocabulary and is asserted on by suites that have
    // nothing to do with timing. The spread preserves `outcome`, `reason` and
    // `admission`, so both branches below read exactly as they did.
    const admitted = await steps.run(`index-admit:${subject}`, async () => {
      const requestedAt = now().toISOString();
      const verdict = await this.waitForAdmission(input, sleep, options);
      return { ...verdict, requestedAt, admittedAt: now().toISOString() };
    });
    if (admitted.outcome === 'deferred') {
      return {
        outcome: 'admission_deferred',
        reason: admitted.reason,
        detail: admitted.detail,
      };
    }

    const booted = await steps.run(`index-boot:${subject}`, () =>
      this.bootIndexContainer(input, admitted.admission, options),
    );
    if (booted.phase === 'terminal') return booted.outcome;
    const { session } = booted;

    // Bounded by the shipped guard: a test may LOWER it, never raise it. It is a
    // TOTAL bound again rather than the per-pass runaway guard §13.3(a) demoted
    // it to, because the count lives in the row now.
    const maxPolls = Math.min(
      options.maxPollIterations ?? MAX_POLL_ITERATIONS,
      MAX_POLL_ITERATIONS,
    );
    const indexTimeoutMs = options.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;

    const result = await advanceSupervision<
      Extract<IndexPollResult, { done: true }>,
      IndexDispatchOutcome
    >(
      runId,
      {
        kind: 'index',
        subject,
        workspaceId: input.workspaceId,
        // From the MEMOIZED boot, so the wall clock stays anchored to the
        // SESSION and a resumed pass settles a container already past its
        // timeout instead of watching it afresh (§13.2).
        bootedAt: new Date(session.bootedAt),
      },
      {
        maxPolls,
        timeoutMs: indexTimeoutMs,
        waitMs: (pollNumber) => indexPollWaitMs(pollNumber, options),
        ...(options.now ? { now: options.now } : {}),
        ...(options.supervisionStore ? { store: options.supervisionStore } : {}),
        // ONE provider read. `pollIndexContainer` is unchanged, including its
        // own boot-deadline arm — which stays HERE, where a successful read is
        // available, because §13.3(b) forbids reaching that verdict from the
        // absence of an observation.
        poll: async (state) => {
          const polled = await this.pollIndexContainer(
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
        // THE TEARDOWN, still a memoized step. The driver calls it from three
        // named transitions and from nowhere else, and never on a defer.
        settle: async (reason, state, verdict) =>
          steps.run(`index-settle:${subject}`, () =>
            this.settleIndexContainer(
              session,
              verdict ?? {
                done: true,
                reason: 'job_timed_out',
                startedAt: state.startedAt ? state.startedAt.toISOString() : null,
                exitCode: null,
                failureDetail: supervisionFailureDetail(reason, maxPolls, indexTimeoutMs),
              },
            ),
          ),
      },
    );

    // ── 8 · THE CORE-SIDE SPANS (MOTIR-4413) ──────────────────────────────────
    // Derived HERE, after the supervision has settled, from three sources that
    // every one of them survives a `JobRunDefer`:
    //
    //   • `admitted.requestedAt` / `admitted.admittedAt` — the `index-admit:<pid>`
    //     MEMO, replayed identically on every pass;
    //   • `session.bootedAt` — the `index-boot:<pid>` MEMO, which is also what
    //     anchors the supervision's wall clock (§13.2), so the two agree by
    //     construction;
    //   • `result.pollNumber` — the `job_supervision` row, keyed `(runId,
    //     subject)`, which a terminal transition advances not at all, so the
    //     completing pass and every replay read the same number.
    //
    // Nothing is counted in this function's own scope, which is the point: a
    // pass typically enters here, replays three memos and returns, and the
    // numbers it reports are the same numbers the pass that did the work would
    // have reported.
    //
    // ⚠️ `indexPollWaitMs` IS READ, NEVER EDITED. It is pure and a function of
    // the ITERATION, so calling it here re-derives the interval that preceded
    // the detecting poll without moving a single cadence constant — §16.6 forbids
    // moving them and this card does not.
    const coreTimings = coreSpansOf({
      admissionWait: spanMs(admitted.requestedAt, admitted.admittedAt),
      boot: spanMs(admitted.admittedAt, session.bootedAt),
      pollToDetect: indexPollWaitMs(result.pollNumber, options),
    });

    // ── 9 · THE MODE (MOTIR-4945) ─────────────────────────────────────────────
    // Read off the `index-boot:<projectId>` MEMO, which every pass replays
    // identically — so this is the same derivation on the pass that did the work
    // and on every pass that follows it.
    //
    // ⚠️ `undefined` PROPAGATES AS `undefined`. A session whose memo predates
    // this card carries no `syncGranted`, and the honest report is then NO mode
    // at all. Collapsing that to `rebuild` would be indistinguishable from a run
    // that really did rebuild, which is exactly the ambiguity this field exists
    // to remove.
    const indexMode: IndexMode | undefined =
      session.syncGranted === undefined ? undefined : session.syncGranted ? 'sync' : 'rebuild';

    // ⚠️ ONLY THE `settled` ARM CARRIES THEM, and the guard is a type narrowing
    // rather than a check: the other outcomes are dispatches that never ran a
    // container, so spans over them would describe a boot that did not happen.
    // The mode rides the same arm for the same reason — a dispatch that never
    // booted has no mode, not `rebuild`.
    return result.outcome.outcome === 'settled'
      ? { ...result.outcome, coreTimings, ...(indexMode ? { indexMode } : {}) }
      : result.outcome;
  },

  /**
   * Boot ONE index container and supervise it TO COMPLETION, in this process —
   * for a caller that has no `job_queue` row to hang a supervision off.
   *
   * ⚠️ IT IS A WRAPPER, NOT A SECOND COMPOSITION, and the difference is the
   * whole reason it is three lines. Every ordering, every transition and the
   * suspension invariant live in {@link advanceIndexContainer} and the driver
   * beneath it; this loop supplies an in-process store and turns each defer back
   * into a wait. Two copies of a supervision loop kept in agreement by hand is
   * the defect MOTIR-3484 spent a card deleting, and it is not being
   * reintroduced one layer up.
   *
   * Its callers are scripts, local harnesses and the tests that drive the
   * dispatch service directly. `system.code-graph-index` and
   * `system.code-graph-refresh` go through {@link advanceIndexContainer}.
   */
  async runIndexContainer(
    input: IndexDispatchInput,
    options: IndexSupervisionOptions = {},
  ): Promise<IndexDispatchOutcome> {
    const sleep = options.sleep ?? sleepFor;
    const now = options.now ?? ((): Date => new Date());
    // ONE store per call: its lifetime is this loop, and sharing one across
    // calls would make two unrelated supervisions collide on their key.
    const supervisionStore = options.supervisionStore ?? inMemorySupervisionStore();
    // ⚠️ AND ONE STEP MEMO PER CALL, WHICH IS NOT OPTIONAL. Each iteration
    // re-enters `advanceIndexContainer` from the top, so without a memo the
    // admission and the BOOT re-execute on every poll — measured at 502 `admit`
    // calls for a 500-poll supervision, and a container per poll had the
    // orchestrator not been a fake. On the job path `job_step` is what makes the
    // replay free; here this is (`lib/jobs/supervision/inProcessSteps.ts`).
    const steps = inProcessMemoSteps(options.steps ?? INLINE_STEPS);
    // ⚠️ THE LOOP LIVES IN `lib/jobs/supervision/`, NOT HERE, and that is a
    // BOUNDARY rather than a preference. `eslint.config`'s
    // `JOB_ENGINE_RESTRICTION` confines `@/lib/jobs/engine/*` to `lib/jobs/**`,
    // so this file may not name the deferral signal — and its own comment says
    // why that rule is stated over our module graph: *"a boundary that can be
    // walked around by importing one file over is a convention, not a guard."*
    // Re-exporting the predicate one folder over would be exactly that walk.
    return driveSupervisionInProcess(
      () =>
        this.advanceIndexContainer(input.runId, input, {
          ...options,
          steps,
          supervisionStore,
        }),
      { sleep, now },
    );
  },

  /**
   * Ask for admission until it is granted or the waiting budget runs out — the
   * IN-PROCESS half of "over the cap means WAIT, never drop" (MOTIR-1990).
   *
   * ⚠️ THERE IS NO LONGER A SECOND, STEPPED COPY OF THIS LOOP (MOTIR-3484). This
   * comment used to say the production path was `lib/jobs/indexFleetSteps.ts`
   * implementing the same loop with `ctx.step.sleep`, "which costs no
   * invocation" — true of Vercel's `maxDuration = 300`, and true of nothing
   * since MOTIR-2384. `admitWithBackoff` is gone from that file, and this loop is
   * what every caller drives; {@link runIndexContainer} wraps the WHOLE of it in
   * ONE memoized step, so a resumed run replays the granted admission rather than
   * re-asking for it after its slot was released (MOTIR-3482 §13.3(c)).
   *
   * A `gate_unavailable` deferral is retried like any other: the gate failing
   * closed is a transient it must be allowed to recover from, and refusing to
   * wait on it would turn one bad read into a dropped index — the outcome the
   * whole rule exists to forbid.
   */
  async waitForAdmission(
    input: IndexDispatchInput,
    sleep: (ms: number) => Promise<void>,
    options: IndexSupervisionOptions = {},
  ): Promise<
    | Extract<IndexAdmissionVerdict, { outcome: 'admitted' | 'already_held' }>
    | Extract<IndexAdmissionVerdict, { outcome: 'deferred' }>
  > {
    const attempts = Math.min(
      options.maxAdmissionAttempts ?? MAX_ADMISSION_ATTEMPTS,
      MAX_ADMISSION_ATTEMPTS,
    );
    let last: Extract<IndexAdmissionVerdict, { outcome: 'deferred' }> = {
      outcome: 'deferred',
      reason: 'gate_unavailable',
      detail: 'admission was never attempted',
    };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const verdict = await this.admitIndexContainer(input, options);
      if (verdict.outcome !== 'deferred') return verdict;
      // ⚠️ `ai_plan_required` IS AN ANSWER, NOT A BUSY FLEET (MOTIR-8235). Every
      // other deferral is a count that a finishing container changes, so waiting
      // is how it clears. The org's plan is not: the gate read it and said no,
      // and asking sixty more times over the next hour changes nothing — that
      // wait used to end in an `IndexDispatchFailedError` the monitor filed as a
      // production error. Returned on the first refusal; the caller turns it
      // into a recorded pause, and the catch-up sweep asks again later.
      // `plan_unknown` stays on the wait: an unreadable plan is a transient.
      if (verdict.reason === 'ai_plan_required') return verdict;
      last = verdict;
      // No wait after the LAST attempt — nothing would observe it.
      if (attempt < attempts) await sleep(indexAdmissionWaitMs(attempt, options));
    }
    return {
      ...last,
      detail: `index admission was refused for ${attempts} attempts (${last.reason}): ${last.detail}`,
    };
  },
};

/**
 * One torn-down container's draw against its organisation's index allowance
 * (MOTIR-4593). Never throws: the client is total, and this only logs.
 *
 * ⚠️ A FAILED CONTAINER IS LOGGED AS ONE. It draws like any other — it ran — but
 * a run of failures must read as failures rather than as ordinary consumption
 * (MOTIR-4519: 259 rows said `succeeded` while every observed run exited 40). The
 * line carries the organisation, the exit class and what was attributed, so a
 * search for it groups one organisation's failing containers.
 */
async function drawAllowanceForContainer(
  session: IndexSession,
  handle: ContainerHandle,
  usage: ContainerUsage,
  exitVerdict: IndexExitVerdict,
): Promise<void> {
  const drawn = await drawIndexAllowance({
    coreOrganizationId: session.attribution.orgId,
    containerSeconds: Math.max(0, Math.floor(usage.billableSeconds)),
    idempotencyKey: indexDrawKey(handle.provider, handle.id),
  });
  if (!drawn) {
    console.error('[codeGraphIndexDispatchService] index allowance draw not recorded', {
      organizationId: session.attribution.orgId,
      containerId: handle.id,
      billableSeconds: usage.billableSeconds,
    });
    return;
  }
  if (!exitVerdict.indexed) {
    console.warn(
      '[codeGraphIndexDispatchService] index allowance drawn by a container that did not index',
      {
        organizationId: session.attribution.orgId,
        repoRef: session.repoRef,
        containerId: handle.id,
        exitClass: exitVerdict.exitClass,
        attributedCredits: drawn.attributedCredits,
        outcome: drawn.outcome,
      },
    );
  }
}

/**
 * The `failureDetail` a supervision writes when it settles for a reason of its
 * OWN rather than because the container stopped.
 *
 * One function rather than a ternary at the call site, because each string is
 * what an operator reads off a failed `job_run` to tell four different things
 * apart — and `job_timed_out` is the `TeardownReason` for all four, so the
 * detail is the only place the distinction survives.
 */
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
    /* v8 ignore next 6 -- `completed` always carries the poll's own verdict and
       `replayed` always hits the caller's `index-settle` memo, so neither
       reaches this fallback. They are enumerated rather than left to a `default`
       so that a new reason added to the union fails the exhaustiveness check
       here instead of silently taking a string written for something else. */
    case 'completed':
    case 'replayed':
      return `supervision settled (${reason})`;
  }
}

/** What a `done` verdict means for the RUN, as opposed to for the container. */
function exitVerdictFor(verdict: Extract<IndexPollResult, { done: true }>): IndexExitVerdict {
  if (verdict.reason === 'provision_failed') return supervisionVerdict('never_started');
  if (verdict.reason !== 'job_completed') return supervisionVerdict('supervision_timed_out');
  return classifyIndexExit(verdict.exitCode);
}

/** The orchestrator a session's container lives on. Re-read per step rather than
 *  carried across the boundary: an adapter is not serializable, and the handle is
 *  — which is exactly why the port made it opaque. */
async function orchestratorFor(session: IndexSession): Promise<ContainerOrchestrator> {
  // A session with no account — every Fly run, and every memo from before
  // MOTIR-9448 — is the process-wide fleet; `forShard(null)` is that.
  return fleetShardOrchestratorService.forShard(session.shardId ?? null);
}

/** `" on fleet account <id>"` for a session booted on one, for a failure detail. */
function onAccount(session: IndexSession): string {
  return session.shardId ? ` on fleet account ${session.shardId}` : '';
}
