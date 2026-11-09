import { defineJob } from '../defineJob';
import type { ScheduleHealthReportDTO } from '@/lib/dto/jobSchedules';
import type { FleetBootableVerdict } from '@/lib/orchestrator';
import type { ContainerAiAddressVerdict } from '@/lib/ai/containerAiAddress';
import type { FleetOriginsVerdict } from '@/lib/ai/fleetOrigins';
import type { IndexRebuildStreakVerdictDTO } from '@/lib/dto/indexRebuildStreak';
import type { MonitorConfigVerdict } from '@/lib/monitors';
import type { CredentialExpiryVerdict } from '@/lib/health/credentialExpiryProbe';
import type { HostedRunProbeVerdictDTO } from '@/lib/dto/hostedRunProbe';
import type { FleetImageCoverageVerdictDTO } from '@/lib/dto/fleetImageCoverage';
import type {
  RunnerAmiFreshnessDTO,
  RunnerImageFreshnessVerdictDTO,
  RunnerImageUnreleasedChangeDTO,
} from '@/lib/dto/runnerImageFreshness';
import type { RunnerVersionSupportVerdictDTO } from '@/lib/dto/runnerVersionSupport';
import { runnerVersionSentence } from '@/lib/ciFleet/runnerVersionSupport';
import {
  PROBE_INDETERMINATE_STREAK_CODE,
  type IndeterminateStreakFailureData,
  type IndeterminateStreakVerdictDTO,
} from '@/lib/dto/indeterminateStreak';
import type { IndeterminateProbeReading } from '@/lib/services/indeterminateStreakService';

// The canonical SCHEDULED job (Story 1.6 · Subtask 1.6.4) — the reference for
// the cron primitive, and the replacement for the 1.6.2 `system.ping` smoke
// job. Runs daily at 09:00, enqueued by the engine's own scheduler
// (`lib/jobs/engine/scheduler.ts`). It is still the worked example docs/jobs.md →
// "Scheduled jobs" points at, and still proves the scheduled path end-to-end
// (cron → scheduler → a `job_run` row whose `event_name` is the synthetic
// `scheduled.system.daily-health-check`).
//
// It began as a deliberate no-op. As of MOTIR-1970 it carries a real probe: the
// SCHEDULE-HEALTH CHECK, which fails the run when a cron job has stopped firing.
// It was written as the detection seam for a stale vendor app registry — the
// fault where a hosted scheduler's registered function list falls behind the
// deployed build, so a cron fires for nothing, in complete silence. That
// particular fault died with the vendor (MOTIR-3418): the schedule now comes out
// of the same image as the handler. The probe SURVIVES because the question it
// asks is engine-agnostic and still worth asking daily — a job whose `cron` was
// edited to an expression that never fires, a scheduler tick that stopped, a
// worker process nobody noticed had been down — and because the answer lands
// somewhere a person looks. `jobScheduleHealthService` carries the full
// reasoning.
//
// As of MOTIR-2006 it carries a SECOND probe: the FLEET BOOT PREFLIGHT (§6.1 of
// `docs/decisions/fleet-image-pull.md`) — does the registry actually serve the
// runner image this deployment is pinned to? It is here rather than in a new job
// for the reason that governs everything below: this job already has a LOUD,
// HUMAN-VISIBLE failure surface, and the fault it now also watches for is one
// whose entire history is having had none. MOTIR-1980's fleet shipped
// code-complete and unable to boot a single container while every predicate in
// the codebase answered "configured"; the only thing that would have caught it
// is a scheduled assertion that fails somewhere a person looks.
//
// The probes are independent faults sharing one surface, not one check: a
// stale registry strands functions, an unpullable image strands containers.
//
// It briefly carried a THIRD probe, the LANE RECONCILIATION (MOTIR-3716): the
// checked-in declaration of which lane each job ran on against the live
// `MOTIR_POSTGRES_JOB_IDS` that actually decided it. MOTIR-3418 removed it with
// the second lane — there is nothing left to declare and nothing left to
// reconcile. It is named here rather than deleted silently because the fault it
// caught (four jobs drifting in ~34 hours, each running on the wrong engine with
// every code-side signal green) is the argument for putting the NEXT
// deployment-wide assertion in this job too.
//
// As of MOTIR-2030 the boot preflight is TWO probes, because the fleet has two
// pull paths. MOTIR-1989 added the indexer image, and §5's third constraint on
// its mirror is explicit: "It is a second pull path. The fleet then has two, and
// each needs §6's preflight independently." They are reported separately rather
// than merged for the reason the verdict is not a boolean — the operator surface
// is a MESSAGE, and a message naming the wrong image is worse than none. §5's
// second constraint is why the indexer's matters most: `registry.fly.io`
// garbage-collects unreferenced images, and a fleet whose machines are ephemeral
// by design references nothing between jobs.
//
// As of MOTIR-4518 it carries a FOURTH probe, and it is the first one that is
// not about an image. Both boot preflights ask whether a container can BOOT;
// neither ever asked whether the booted container can REACH anything. For two
// weeks every index container booted from a perfectly pullable image, built a
// 45 MB graph over nineteen minutes, and then died on
// `getaddrinfo ENOTFOUND motir-ai.internal` one call before it could upload it —
// because motir-core handed it motir-core's OWN private motir-ai address, and
// the container runs in a different organization. Both preflights were green the
// whole time, correctly: they were answering the question they were asked. This
// probe asks the other one. It is here for the reason every probe in this job is
// here — the fault's entire history is having had no loud surface.
//
// As of MOTIR-5027 it carries a FIFTH probe, and it is the first one that reads
// the LEDGER rather than a registry or an address — and the first that asks
// whether a feature is DOING what it claims rather than whether a run
// SUCCEEDED. The four above all ask a question about capability: can a container
// boot, can it reach anything. "Build once, sync forever" is a claim about WHICH
// of two paths a successful run took, so a deployment that rebuilds the entire
// graph on every single run satisfies every one of them — correctly, because
// none of them was asking. It ran that way twice: 2026-08-21 → 09-04
// (MOTIR-4415) and 2026-08-21 → 09-10 (MOTIR-5009), both found by accident by a
// person reading logs for something else. The mode had been on the ledger since
// MOTIR-4945 with no reader; this is the reader. Same reason as every probe
// above it — the fault's entire history is having had no loud surface.
//
// ⚠️ AND IT IS THE FIRST PROBE HERE WITH A DECLARED BLIND SPOT. motir-core
// records whether it OFFERED a snapshot, not what the container did with one, so
// a run that was offered one and rebuilt anyway is recorded as `sync` and is
// invisible to this check. That boundary rides on the verdict and in the error
// message (`INDEX_REBUILD_STREAK_BLIND_SPOT`), and MOTIR-5058 is the card that
// closes the arm. Do not let a later reader take a green verdict here for a
// guarantee it was never able to make.
//
// As of MOTIR-5831 it carries a SIXTH probe, and it is the first one that asks a
// question about THIS PROCESS'S OWN ENVIRONMENT rather than about a registry, an
// address or the ledger. `SENTRY_APP_CLIENT_SECRET` was absent from production
// for SEVEN DAYS after MOTIR-5257's close-out recorded four values staged and
// read back; three of its four siblings really were there, and the plausible
// cause is a clipboard import losing a line break. Every human check available
// had already been performed and passed. What was never performed is a check the
// running process could make ABOUT ITSELF — and the only thing that would have
// held is a scheduled assertion that fails where a person looks. That is the same
// sentence MOTIR-2006's preflight is here for, one integration over, and it is
// why this probe is in THIS job rather than in a new one or on the platform
// health board: this job already has a LOUD, HUMAN-VISIBLE failure surface, and
// the fault it now also watches for is one whose entire history is having had
// none.
//
// ⚠️ IT REPORTS NAMES, NEVER VALUES. Not the value, not its length, not a digest.
// The DLQ row is rendered to a human, and a probe that printed a length would put
// a secret-adjacent artifact on an operator surface to answer a question that
// only ever needed a yes or a no.
//
// ⚠️ AND IT HAS A DECLARED BLIND SPOT, like MOTIR-5027's. It infers OPT-IN from
// PARTIAL configuration, so a provider that lost EVERY declared name reads as
// never-configured and is not flagged here — that case surfaces at the OAuth
// start route instead, which now refuses before a person approves an install.
// The boundary rides on the verdict and in the error message, for the reason
// stated there: a reader who takes a green verdict for "the monitor is
// configured" will be wrong.
//
// As of MOTIR-1933 it carries a SEVENTH probe, CREDENTIAL EXPIRY, and it is the
// first one whose subject is a DATE somebody declared rather than a live system:
// `lib/health/credentialRegistry.ts` lists every platform credential that lapses
// silently, with the day it lapses. A lapsed `GITHUB_BILLING_TOKEN` is still SET,
// so the reconciliation keeps calling GitHub with a refused token and the audit
// that falsifies meter drift stops with nothing red. This probe fails thirty
// days ahead instead (`LEAD_TIME_DAYS`).
//
// ⚠️ WHAT AN OPERATOR DOES WHEN IT FIRES. The DLQ row and the Sentry email are
// the alert (`lib/monitoring/jobFailureAlert.ts`); the message names the
// variable, its date and the registry entry's `renewal` sentence, which says
// what to renew and where. Renew it, set the new value with `fly secrets set`,
// and move the entry's `expiresAt` in the same change — the date is DECLARED,
// so a renewed token with a stale entry keeps firing.
//
// ⚠️ AN UNSET VARIABLE IS SKIPPED, NOT FAILED, for the reason the monitor probe
// does not fail on `not_applicable`: an unset credential is its feature's own
// "not configured" state, and a check that fails on every deployment that never
// wanted the feature is a check somebody silences.
//
// As of MOTIR-1934 it carries an EIGHTH probe, HOSTED RUNS IN AN OWNED ORG: a
// metered CI run in a Motir-owned GitHub org (`lib/ciMetering/ownedOrgs.ts`)
// completed in the last day on anything other than Motir's own runner fleet.
// The $0 GitHub budget does not stop such a run (included minutes never count
// against it), so without this probe a cleared runner variable is found by
// whoever eventually reads a bill.
//
// ⚠️ WHAT AN OPERATOR DOES WHEN IT FIRES: this firing means `vars.MOTIR_RUNNER`
// is missing or cleared at the org or the repo level, so `runs-on` fell back to
// `ubuntu-latest` (MOTIR-1925). Check that variable FIRST — on the org, then on
// the repository the row names.
//
// ⚠️ RESIDUAL EXPOSURE: detection is AFTER THE FACT. The probe reads completed,
// metered runs, so by the time it fires the included minutes are already spent,
// and it says so in the message. It is a fail-loud signal, not a stop — the
// stop is MOTIR-1907's, and it is not this job's to perform.
//
// As of MOTIR-10290 it carries a NINTH probe, FLEET IMAGE COVERAGE: readiness
// condition 9 asked of every pair the fleet console offers — each private
// repository's jobs at its newest `.github` commit, judged against the tool list
// the pinned runner image records about itself. A job the image cannot run holds
// the Motir-CI-on-fleet switch off, and before a probe the only way to learn it
// was to open /admin/fleet-settings: motir-infra#7's `verify` job sat unnoticed
// for five days that way (MOTIR-10211, whose snapshot-drift probe this replaces).
//
// ⚠️ WHAT AN OPERATOR DOES WHEN IT FIRES: the message names the repository,
// workflow, job and tool. Add the tool to the runner image and release it, or
// move the job off the fleet. A pinned image with no tool list is released again
// from current motir-core and its digest pinned.
//
// As of MOTIR-10706 it carries the RUNNER-VERSION SUPPORT probe: the Actions
// runner the fleet is built with (`ARG RUNNER_VERSION` in
// `infra/ci-runner/Dockerfile` on the default branch) judged against GitHub's
// releases. The runner runs with self-update off, and GitHub stops serving jobs
// to such a runner 30 days after a newer release; on 2026-11-08 every AWS fleet
// runner connected, was told "v2.336.0 is deprecated and cannot receive
// messages", and powered off with its job still queued. The probe fails 14 days
// before that cut-off and names it.
//
// ⚠️ WHAT AN OPERATOR DOES WHEN IT FIRES: set RUNNER_VERSION and RUNNER_SHA256 to
// the release the message names, release `runner-v*` and `ci-runner-ami-v*`, and
// pin MOTIR_RUNNER_IMAGE and MOTIR_AWS_RUNNER_AMI_ID to what they publish.
//
// As of MOTIR-10429 it carries an ESCALATION over every probe above that has an
// `indeterminate` arm, and it is not a probe of anything outside this job: it
// reads this job's own recent rows. One `indeterminate` stays quiet, as each
// probe's own comment below argues. But nothing ever read the run of them, so a
// read that failed every morning for a reason that would not clear by itself —
// an expired token, a revoked App installation, anonymous GitHub reads
// rate-limited on a shared egress IP — hid the fault its probe exists to find,
// for as long as it lasted. A probe that is `indeterminate` on the last
// `INDETERMINATE_STREAK_THRESHOLD` runs now fails the check, naming the probe,
// the streak and the read that failed.
//
// ⚠️ A NEW PROBE IS COVERED BY BEING IN `DAILY_HEALTH_CHECK_PROBES`, and it
// cannot be left out: the table is typed over every field of the result, so a
// new verdict field does not compile without an entry, and an entry for a
// verdict with an `indeterminate` arm must say how to describe it.
// `tests/jobs/daily-health-check-indeterminate-streak.test.ts` checks the
// table's step ids against the handler's.
//
// `retryPolicy: 'none'` (run at most once): a health check is a point-in-time
// probe — retrying it minutes later would record a stale verdict, so a failed
// tick dead-letters immediately rather than retrying. That is also what makes
// the failure LOUD: the operator ledger's Dead letters tab gets a row naming
// every overdue job, instead of a queue that quietly consumes nothing.
// THE DLQ ROW IS THE SURFACE — `/admin/jobs` → Dead letters, which counts it
// and renders the failure message. That is why
// every error thrown here writes its diagnosis into its MESSAGE: the message is
// the whole of what a human reads, and no operator should have to open
// orchestrator logs to learn which image the registry refused.

/** The cron expression — 09:00 every day. Exported so the test asserts wiring. */
export const DAILY_HEALTH_CHECK_CRON = '0 9 * * *';

/** What the job resolves to on a healthy tick — persisted on the `job_run` row. */
export interface DailyHealthCheckResult {
  ok: true;
  check: 'daily-health-check';
  schedules: ScheduleHealthReportDTO;
  /** The fleet boot preflight's verdict (MOTIR-2006). Recorded on the healthy
   *  tick too, so the ledger answers "was the runner image pullable yesterday?"
   *  — a green run that says `not_applicable` and one that says `bootable` are
   *  very different states, and a result that only appeared on failure could not
   *  tell them apart. */
  fleet: FleetBootableVerdict;
  /** The INDEXER image's preflight verdict (MOTIR-2030) — the fleet's second
   *  pull path, recorded beside the runner's rather than merged into it. A
   *  deployment that runs CI but does not index reports `not_applicable` here
   *  while `fleet` says `bootable`, and the ledger can tell those apart. */
  indexFleet: FleetBootableVerdict;
  /** The HOSTED-AGENT image's preflight verdict (MOTIR-9420) — the third pull
   *  path, probed ANONYMOUSLY the way an agent-runner VM pulls it, and recorded
   *  beside the other two. A deployment that runs no hosted agent reports
   *  `not_applicable`. */
  hostedAgentImage: FleetBootableVerdict;
  /** Whether the address an index container would be GIVEN for motir-ai can work
   *  for it (MOTIR-4518) — recorded on the healthy tick too, so the ledger can
   *  answer "was the container's motir-ai address sane yesterday?". A deployment
   *  that indexes reports `reachable`, `private_address` or `indeterminate`; one
   *  that does not reports `not_applicable` beside a `not_applicable`
   *  `indexFleet`. */
  indexContainerAi: ContainerAiAddressVerdict;
  /** Whether the THREE addresses every fleet machine is handed — core's public
   *  origin, motir-ai's container-facing origin and the gateway's run-lane
   *  origin — can work for it (Story MOTIR-9714), one reading per origin.
   *  Recorded on the healthy tick too, so the ledger answers "were the fleet's
   *  addresses sane yesterday?". A deployment on the fake orchestrator reports
   *  `not_applicable`. */
  fleetOrigins: FleetOriginsVerdict;
  /** Whether any repository has been denied a snapshot N consecutive times
   *  (MOTIR-5027) — recorded on the healthy tick too, so the ledger answers
   *  "was the index still incremental yesterday?". It is the first probe here
   *  that reads the LEDGER rather than a registry or an address, and the first
   *  that asks whether a feature is DOING what it claims rather than whether a
   *  run succeeded. Its `blindSpot` rides on every arm; read it before drawing
   *  any conclusion from a green one. */
  indexRebuildStreak: IndexRebuildStreakVerdictDTO;
  /** Whether every partly-configured monitor provider carries every environment
   *  variable it DECLARED it needs (MOTIR-5831) — recorded on the healthy tick
   *  too, so the ledger answers "was the Sentry integration fully configured
   *  yesterday?". A deployment that never connected a monitor reports
   *  `not_applicable`; one that did reports `complete`, and the ledger can tell
   *  those apart, which a result that only appeared on failure could not. Its
   *  `blindSpot` rides on every arm; read it before drawing any conclusion from a
   *  green one. NAMES only — no value, length or digest is ever on this row. */
  monitorConfig: MonitorConfigVerdict;
  /** Every registered credential's distance from its DECLARED expiry
   *  (MOTIR-1933) — recorded on the healthy tick too, so the ledger answers
   *  "how long did the billing token have left yesterday?". `skipped` names the
   *  registered credentials this deployment does not set. NAMES only. */
  credentialExpiry: CredentialExpiryVerdict;
  /** Every metered run in a Motir-owned org in the last day, judged against the
   *  fleet (MOTIR-1934) — recorded on the healthy tick too, with how many runs it
   *  read, so a green `ok` over zero runs is distinguishable from one over many. */
  hostedRuns: HostedRunProbeVerdictDTO;
  /** Whether every job a connected org sends to the fleet can run on the pinned
   *  runner image (MOTIR-10290) — recorded on the healthy tick too, with each
   *  pair's condition, so `runnable` is distinguishable from `indeterminate` or
   *  `not_applicable`. */
  fleetImageCoverage: FleetImageCoverageVerdictDTO;
  /** Whether the pinned runner image was built from a commit that contains the
   *  newest default-branch change to every file it is built from (MOTIR-10393) —
   *  recorded on the healthy tick too, with the build commit and where it was
   *  read, and with the AMI's state, so `current` is distinguishable from
   *  `indeterminate` or `not_applicable`. */
  runnerImageFreshness: RunnerImageFreshnessVerdictDTO;
  /** Whether the Actions runner the default branch pins is inside GitHub's
   *  support window, and how many days it has left (MOTIR-10706) — recorded on
   *  the healthy tick too, so `supported` with 20 days left is readable before
   *  it turns `expiring`. */
  runnerVersionSupport: RunnerVersionSupportVerdictDTO;
  /** How many runs in a row each probe has been `indeterminate` (MOTIR-10429) —
   *  recorded on the healthy tick too, so a probe two runs into a streak is
   *  readable before it fails the check on the third. */
  indeterminateStreak: IndeterminateStreakVerdictDTO;
}

/** The stable half of the resolved payload. Exported for the test. */
export const DAILY_HEALTH_CHECK_PAYLOAD = { ok: true, check: 'daily-health-check' } as const;

/**
 * Thrown when at least one cron job has missed more than one consecutive tick.
 * Its message names the offenders because that message is what lands in the DLQ
 * row's `failure` — an operator should not have to open a database to learn
 * WHICH job stopped.
 */
export class ScheduledJobsOverdueError extends Error {
  constructor(readonly report: ScheduleHealthReportDTO) {
    const detail = report.overdue
      .map((e) => `${e.functionId} (cron ${e.cron}; last run ${e.lastRunAt ?? 'never'})`)
      .join(', ');
    super(
      `${report.overdue.length} scheduled job(s) have not run since their previous tick: ${detail}. ` +
        `Check that the worker process group is running and that its scheduler is ticking ` +
        `(\`fly status -a motir-core\`, then the worker log's \`[job-scheduler]\` lines); a cron ` +
        `expression edited to one that never fires looks identical from here (MOTIR-1970).`,
    );
    this.name = 'ScheduledJobsOverdueError';
  }
}

/**
 * Thrown when the deployment's configured runner image cannot be pulled — §6.1
 * of `docs/decisions/fleet-image-pull.md`, and the assertion MOTIR-1980 lacked.
 *
 * Its message names the IMAGE REFERENCE and the REGISTRY'S OWN WORDS, because
 * that message is the DLQ row's `failure` and therefore the entire thing an
 * operator reads. "The fleet is unhealthy" would be true and useless; "ghcr.io
 * refused an anonymous pull token for <ref>" is a fix.
 */
export class FleetImageUnpullableError extends Error {
  constructor(readonly verdict: Extract<FleetBootableVerdict, { verdict: 'unpullable' }>) {
    super(
      `The fleet's runner image cannot be pulled: ${verdict.reference} — ${verdict.detail}. ` +
        `No CI container can boot until this is fixed. Check the image's registry visibility ` +
        `and that MOTIR_RUNNER_IMAGE names a digest that still exists ` +
        `(docs/decisions/fleet-image-pull.md §1 makes the CI runner image PUBLIC on GHCR; ` +
        `a closed image mirrors into registry.fly.io per §5).`,
    );
    this.name = 'FleetImageUnpullableError';
  }
}

/**
 * Thrown when the deployment's configured INDEXER image cannot be pulled
 * (MOTIR-2030) — §5's third constraint, given the loud surface §6 requires.
 *
 * A SEPARATE error from {@link FleetImageUnpullableError}, and the message is
 * the reason: it names the INDEXER's reference, the INDEXER's variable, and the
 * failure mode peculiar to that path. §5's second constraint makes the likely
 * cause a GARBAGE-COLLECTED mirror rather than a visibility mistake — Fly cleans
 * up unreferenced images and a fleet of ephemeral machines references nothing
 * between jobs — so the message says to re-run the mirror step, which is a
 * different fix from "check the package's visibility". Telling an operator to
 * check GHCR visibility for an image Fly quietly collected would send them to
 * the wrong registry entirely.
 */
export class IndexFleetImageUnpullableError extends Error {
  constructor(readonly verdict: Extract<FleetBootableVerdict, { verdict: 'unpullable' }>) {
    super(
      `The fleet's INDEXER image cannot be pulled: ${verdict.reference} — ${verdict.detail}. ` +
        `No code-graph index container can boot until this is fixed; CI is unaffected ` +
        `(it pulls a different image). Check that MOTIR_INDEXER_IMAGE names a digest that ` +
        `still exists, and suspect the mirror first: registry.fly.io garbage-collects ` +
        `UNREFERENCED images and the fleet's machines are ephemeral, so re-run the ` +
        `release lane's registry-to-registry copy (docs/decisions/fleet-image-pull.md §5).`,
    );
    this.name = 'IndexFleetImageUnpullableError';
  }
}

/**
 * Thrown when the HOSTED-AGENT image cannot be pulled anonymously (MOTIR-9420).
 *
 * A separate error, like the indexer's, so the message names the right image and
 * the right fix: an agent-runner VM has no instance profile and no Fly org
 * credential, so the image must stay PUBLIC on GHCR — a private package, or a
 * mirror to `registry.fly.io` or ECR, strands every hosted run on AWS.
 */
export class HostedAgentImageUnpullableError extends Error {
  constructor(readonly verdict: Extract<FleetBootableVerdict, { verdict: 'unpullable' }>) {
    super(
      `The HOSTED-AGENT image cannot be pulled anonymously: ${verdict.reference} — ${verdict.detail}. ` +
        `No hosted agent run can boot on an agent-runner VM until this is fixed: the VM pulls ` +
        `anonymously (no instance profile, no Fly org credential), so MOTIR_HOSTED_AGENT_IMAGE ` +
        `must name a digest that still exists on a PUBLIC registry — the image stays public on ` +
        `GHCR (docs/decisions/hosted-agent-run.md §6, docs/decisions/fleet-image-pull.md §1).`,
    );
    this.name = 'HostedAgentImageUnpullableError';
  }
}

/**
 * Thrown when the address this deployment would hand an index container cannot
 * work for it (MOTIR-4518) — either unset, or PRIVATE and therefore unresolvable
 * from the fleet's organization.
 *
 * A SEPARATE error from the two image ones, and the message is the reason. Those
 * two send an operator to a REGISTRY; this one sends them to motir-core's own
 * value and the stack output it must equal (Story MOTIR-9714), and the fix is a
 * different change in a different place. Telling
 * someone to re-run the image mirror for a name-resolution fault would send them
 * to the wrong system entirely — which is precisely what happened for two weeks
 * while both image probes reported green.
 *
 * It is loud on the two DEFINITE arms only. `indeterminate` means this process
 * could not reach the address, which is a statement about motir-core's network
 * rather than about the address, and failing on it would teach an operator that
 * this row is noise — the failure mode every probe in this job is written to
 * avoid.
 */
export class IndexContainerAiAddressError extends Error {
  constructor(
    readonly verdict: Extract<
      ContainerAiAddressVerdict,
      { verdict: 'unconfigured' | 'private_address' }
    >,
  ) {
    super(
      `An index container cannot reach motir-ai: ${verdict.detail} ` +
        `No code-graph index can be published until this is fixed — the container will still ` +
        `boot, download the repository and build the whole graph, and then throw it away at the ` +
        `upload grant. Set MOTIR_AI_CONTAINER_URL on motir-core's web and worker to the ` +
        `motir-infra services stack output AiContainerOrigin (its container-facing routes are ` +
        `gated on the run-scoped credential either way). It is deliberately not ` +
        `MOTIR_AI_URL, which is motir-core's own private seam and must stay that way ` +
        `(MOTIR-3277 · MOTIR-4518).`,
    );
    this.name = 'IndexContainerAiAddressError';
  }
}

/**
 * Thrown when any of the three addresses every fleet machine is handed is a
 * DEFINITE failure (Story MOTIR-9714 · MOTIR-10750): unset, malformed, or a
 * private or Fly-owned host. The message names, per failing origin, the
 * variable, what is wrong with it and the motir-infra stack output it must
 * equal — the one place the right value is published — never a Fly secret.
 *
 * Loud on the definite arms only: an `indeterminate` origin is core's probe
 * failing to get an answer, which the streak below escalates instead.
 */
export class FleetOriginsError extends Error {
  constructor(readonly verdict: Extract<FleetOriginsVerdict, { verdict: 'failed' }>) {
    const sentences = verdict.failures.map(
      (f) =>
        `${f.variable}: ${f.detail} Set it on motir-core's web and worker to the motir-infra ` +
        `services stack output ${f.output}.`,
    );
    super(
      `${verdict.failures.length} fleet origin(s) cannot work for a fleet machine: ` +
        `${sentences.join(' ')} Every fleet kind (CI runner, indexer, agent runner, hoster) is ` +
        `handed these addresses, and a machine handed a wrong one boots, is billed and fails ` +
        `late (MOTIR-4518 · MOTIR-4916).`,
    );
    this.name = 'FleetOriginsError';
  }
}

/**
 * Thrown when a repository's index has been REBUILDING from scratch for the
 * threshold number of consecutive runs (MOTIR-5027) — the assertion "build
 * once, sync forever" never had.
 *
 * A SEPARATE error from the three above, and the message is the reason. Those
 * send an operator to a registry or to a Fly secret because a container cannot
 * BOOT or cannot REACH anything. This one fires when every container booted
 * perfectly, reached motir-ai, built a real graph and published it — and did the
 * expensive thing every single time. Nothing else in this job can be red for
 * that, which is the entire defect: MOTIR-4415 and MOTIR-5009 each ran for
 * weeks with every probe here green.
 *
 * ⚠️ THE MESSAGE CARRIES THE BLIND SPOT, and that is not padding. The DLQ row's
 * `failure` is the whole of what a human reads, and a reader who takes this
 * check to mean *the index is incremental* will read its silence as a guarantee
 * it cannot make. So the sentence that says what it did NOT measure travels with
 * the sentence that says what it did.
 */
export class IndexRebuildStreakError extends Error {
  constructor(readonly verdict: Extract<IndexRebuildStreakVerdictDTO, { verdict: 'rebuilding' }>) {
    const offenders = verdict.offenders
      .map((o) => `${o.repoRef} (${o.consecutiveRebuilds} of its last ${o.modeRuns} runs)`)
      .join(', ');
    super(
      `${verdict.offenders.length} repositor${verdict.offenders.length === 1 ? 'y has' : 'ies have'} ` +
        `rebuilt the code graph from scratch on ${verdict.threshold}+ consecutive runs: ${offenders}. ` +
        `"Build once, sync forever" is off — every one of those runs paid a full re-parse. ` +
        `Two systems to fork on: ${verdict.candidates.join(' AND ')}. ` +
        `Start with \`fly logs -a motir-ai\` for the withholding line, and compare ` +
        `MOTIR_INDEXER_IMAGE's engine against the \`CodeRepo.codegraphVersion\` rows. ` +
        `⚠️ SCOPE: ${verdict.blindSpot}`,
    );
    this.name = 'IndexRebuildStreakError';
  }
}

/**
 * Thrown when a monitor provider this deployment has PARTLY configured is missing
 * an environment variable it declared (MOTIR-5831) — the assertion the seven-day
 * `SENTRY_APP_CLIENT_SECRET` outage never had.
 *
 * A SEPARATE error from the five above, and the message is the reason. Those send
 * an operator to a registry, to a Fly secret for an ADDRESS, or to the indexer's
 * engine. This one sends them to a Fly secret for a CREDENTIAL, with the NAME
 * they have to set — and the fix is `fly secrets set` on a specific app, which is
 * a different command in a different place from every one of them.
 *
 * ⚠️ THE MESSAGE NAMES THE VARIABLE AND THE PROVIDER AND NOTHING ELSE. It carries
 * no value, no length and no digest: the DLQ row is the whole of what a human
 * reads, and the question it answers is whether the name is set.
 *
 * ⚠️ AND IT CARRIES THE BLIND SPOT, for the reason {@link IndexRebuildStreakError}
 * states in the same words. A reader who takes this check's silence to mean *the
 * monitor is configured* will be wrong, because a provider that lost every name
 * at once reads as never-configured. So the sentence that says what it did NOT
 * measure travels with the sentence that says what it did.
 */
export class MonitorConfigIncompleteError extends Error {
  constructor(readonly verdict: Extract<MonitorConfigVerdict, { verdict: 'incomplete' }>) {
    const offenders = verdict.offenders
      .map((p) => `${p.providerId} is missing ${p.missing.join(' and ')}`)
      .join('; ');
    super(
      `${verdict.offenders.length} monitor provider(s) are PARTLY configured: ${offenders}. ` +
        `Somebody installed these values and at least one did not land — a partly-set ` +
        `provider is never a deliberate state. Nobody will find out otherwise until a ` +
        `person clicks Connect and approves an install in their OWN monitor organisation, ` +
        `which is where the failure used to arrive (MOTIR-5831). Set the named variable ` +
        `with \`fly secrets set <NAME>=… -a motir-core\` and read it back from the ` +
        `PLATFORM (\`fly secrets list -a motir-core\`), never from a config file. ` +
        `⚠️ SCOPE: ${verdict.blindSpot}`,
    );
    this.name = 'MonitorConfigIncompleteError';
  }
}

function describeCredentials(
  entries: Extract<CredentialExpiryVerdict, { verdict: 'expiring' }>['offenders'],
): string {
  return entries
    .map(
      (e) =>
        `${e.envVar} (${e.name}) expires ${e.expiresAt}` +
        ` — ${e.daysRemaining < 0 ? `${-e.daysRemaining} day(s) ago` : `in ${e.daysRemaining} day(s)`}` +
        `; to renew: ${e.renewal} [expiry declared by ${e.source}]`,
    )
    .join('; ');
}

/**
 * Thrown when a registered platform credential is within its lead time of its
 * DECLARED expiry (MOTIR-1933) and its variable is set.
 *
 * A SEPARATE error from {@link CredentialExpiredError}, and the message is the
 * reason: nothing is broken YET, and the fix is a calm renewal rather than an
 * outage. The message names the variable, the date and the renewal pointer —
 * never the value.
 */
export class CredentialExpiringError extends Error {
  constructor(readonly verdict: Extract<CredentialExpiryVerdict, { verdict: 'expiring' }>) {
    super(
      `${verdict.offenders.length} platform credential(s) expire within the lead time: ` +
        `${describeCredentials(verdict.offenders)}. Nothing has failed yet — renew it before the ` +
        `date, then move the entry's expiresAt in lib/health/credentialRegistry.ts (the date is ` +
        `declared, not read from the token, so a renewed token with a stale entry keeps firing).`,
    );
    this.name = 'CredentialExpiringError';
  }
}

/**
 * Thrown when a registered platform credential is PAST its declared expiry and
 * its variable is still set (MOTIR-1933) — the feature behind it is calling its
 * provider with a dead token right now.
 */
export class CredentialExpiredError extends Error {
  constructor(readonly verdict: Extract<CredentialExpiryVerdict, { verdict: 'expired' }>) {
    const also =
      verdict.expiring.length > 0
        ? ` Also within the lead time: ${describeCredentials(verdict.expiring)}.`
        : '';
    super(
      `${verdict.offenders.length} platform credential(s) are PAST their declared expiry and ` +
        `still set: ${describeCredentials(verdict.offenders)}. The feature reading each one is ` +
        `failing against its provider now. Renew it, then move the entry's expiresAt in ` +
        `lib/health/credentialRegistry.ts; if the token was in fact renewed earlier, the ` +
        `entry is what is stale.${also}`,
    );
    this.name = 'CredentialExpiredError';
  }
}

/**
 * Thrown when a metered CI run in a Motir-owned GitHub org ran on anything but
 * Motir's runner fleet (MOTIR-1934). The message names the org, repository, run
 * id and the runner families it ran on, the check to make first, and that the
 * minutes are already spent.
 */
export class HostedRunInOwnedOrgError extends Error {
  constructor(readonly verdict: Extract<HostedRunProbeVerdictDTO, { verdict: 'hosted_runs' }>) {
    const runs = verdict.offenders
      .map(
        (run) =>
          `${run.org}/${run.repo} run ${run.runId} (attempt ${run.runAttempt}, completed ` +
          `${run.completedAt}) ran on ${run.families.join(', ')}`,
      )
      .join('; ');
    super(
      `${verdict.offenders.length} metered CI run(s) in a Motir-owned org ran OFF the runner ` +
        `fleet since ${verdict.windowStart}: ${runs}. Check \`vars.MOTIR_RUNNER\` first — it is ` +
        `missing or cleared at the org or the repository level, so runs-on fell back to ` +
        `ubuntu-latest. Detected after the fact: these minutes are already spent, and the $0 ` +
        `GitHub budget does not stop the next run.`,
    );
    this.name = 'HostedRunInOwnedOrgError';
  }
}

/**
 * Thrown when a job a connected org sends to the fleet cannot run on the pinned
 * runner image, or the image records no tool list (MOTIR-10290): readiness reads
 * image coverage as unmet, so the Motir-CI-on-fleet switch cannot be turned on.
 * The message is each pair's own condition message, which names the repository,
 * workflow, job and tool.
 */
export class FleetImageCoverageGapError extends Error {
  constructor(readonly verdict: Extract<FleetImageCoverageVerdictDTO, { verdict: 'gap' }>) {
    const gaps = verdict.pairs
      .filter((p) => p.state === 'unmet')
      .map((p) => `${p.projectKey} on ${p.org}: ${p.message}`)
      .join(' | ');
    super(
      `The fleet runner image cannot run every job sent to it, so the Motir-CI-on-fleet ` +
        `switch cannot be turned on. ${gaps} Add the tool to infra/ci-runner/Dockerfile and ` +
        `release the runner image, or move the job off the fleet ` +
        `(docs/research/fleet-job-inventory.md).`,
    );
    this.name = 'FleetImageCoverageGapError';
  }
}

/**
 * Thrown when a change to a file the runner image is built from has merged, but
 * the image `MOTIR_RUNNER_IMAGE` pins was built from a commit that does not
 * contain it (MOTIR-10393): the fix is on the default branch and the fleet boots
 * the old image. The message names the pinned image, its build commit, each
 * unreleased commit and the release step, because it is the whole DLQ row an
 * operator reads. Releasing and pinning stay a person's step.
 */
/** One stale pin's changes, as the error sentences list them. */
function describeUnreleased(unreleased: readonly RunnerImageUnreleasedChangeDTO[], what: string) {
  return unreleased
    .map(
      (c) =>
        `${c.commit.slice(0, 12)} (${c.committedAt}, "${c.subject}", changes ${c.paths.join(', ')}` +
        `${c.relation === 'diverged' ? `; the ${what} was built from a branch without it` : ''})`,
    )
    .join('; ');
}

/** The sentence a stale runner AMI is reported in (MOTIR-10395). */
function amiStaleSentence(ami: Extract<RunnerAmiFreshnessDTO, { state: 'stale' }>): string {
  const { build, unreleased } = ami;
  const newest = unreleased[0]!.commit;
  return (
    `The pinned runner AMI ${build.amiId}${build.name ? ` (${build.name})` : ''} was built from ` +
    `${build.commit.slice(0, 12)} (read from its ${build.source}, in fleet account ${build.account}), ` +
    `which does not contain ${unreleased.length} merged change(s) to the AMI: ` +
    `${describeUnreleased(unreleased, 'AMI')}. The AWS fleet still boots the old AMI. Build it — ` +
    `\`git tag ci-runner-ami-v<next> ${newest} && git push origin ci-runner-ami-v<next>\` ` +
    `(.github/workflows/release-ci-runner-ami.yml) — then set poolAccount.images.ci_runner in ` +
    `motir-infra and MOTIR_AWS_RUNNER_AMI_ID to the AMI id the build's job summary prints.`
  );
}

export class RunnerImageStaleError extends Error {
  constructor(readonly verdict: Extract<RunnerImageFreshnessVerdictDTO, { verdict: 'stale' }>) {
    const { build, unreleased } = verdict;
    const newest = unreleased[0]!.commit;
    super(
      `The pinned runner image ${build.image} was built from ${build.commit.slice(0, 12)} ` +
        `(read from its ${build.source === 'label' ? 'org.opencontainers.image.revision label' : 'sha- registry tag'}), ` +
        `which does not contain ${unreleased.length} merged change(s) to the image: ` +
        `${describeUnreleased(unreleased, 'image')}. ` +
        `The fleet still boots the old image. Release it — \`git tag runner-v<next> ${newest} && ` +
        `git push origin runner-v<next>\` (.github/workflows/release-runner-image.yml) — then set ` +
        `MOTIR_RUNNER_IMAGE to the digest the release's job summary prints.` +
        // Both pins can be stale at once; one run names both (MOTIR-10395).
        (verdict.ami.state === 'stale' ? ` ${amiStaleSentence(verdict.ami)}` : ''),
    );
    this.name = 'RunnerImageStaleError';
  }
}

/**
 * Thrown when a probe has been `indeterminate` — its read did not answer — on
 * the threshold number of consecutive runs (MOTIR-10429). One such verdict is a
 * blip and stays quiet; a streak is a read that is broken, and while it lasts
 * the fault the probe watches for is invisible.
 *
 * The message names each probe and its step, how many runs in a row and since
 * when, and the phase and detail of the latest read, because the DLQ row is the
 * whole of what an operator reads. The blind spot travels with it, for the
 * reason {@link IndexRebuildStreakError} gives.
 */
export class ProbeIndeterminateStreakError extends Error {
  /** Lands on the failed row's `failure.code`, so a later run knows this row. */
  readonly code = PROBE_INDETERMINATE_STREAK_CODE;
  /** Lands on the failed row's `failure.data`: every probe that could not tell on
   *  THIS run, which is how the next run's streak counts through this one. */
  readonly failureData: IndeterminateStreakFailureData;

  constructor(readonly verdict: Extract<IndeterminateStreakVerdictDTO, { verdict: 'persistent' }>) {
    const offenders = verdict.offenders
      .map(
        (o) =>
          `${o.probe} (step ${o.step}) on ${o.consecutive} runs in a row since ${o.since}; ` +
          `latest read failed at ${o.phase}: ${o.detail}`,
      )
      .join(' | ');
    super(
      `${verdict.offenders.length} health probe(s) could not tell on ${verdict.threshold}+ ` +
        `consecutive runs: ${offenders}. While a probe's read keeps failing, the fault it ` +
        `watches for cannot be seen. Fix the read — a token, an App installation, a registry ` +
        `path or a rate limit — not the verdict. ⚠️ SCOPE: ${verdict.blindSpot}`,
    );
    this.name = 'ProbeIndeterminateStreakError';
    this.failureData = { indeterminateProbes: verdict.streaks.map((s) => s.probe) };
  }
}

/** The probe verdict fields of the result — everything but the stable payload
 *  and the streak read itself. */
type DailyHealthCheckProbeKey = Exclude<
  keyof DailyHealthCheckResult,
  keyof typeof DAILY_HEALTH_CHECK_PAYLOAD | 'indeterminateStreak'
>;

type IndeterminateArm<K extends DailyHealthCheckProbeKey> = Extract<
  DailyHealthCheckResult[K],
  { verdict: 'indeterminate' }
>;

/** What the streak needs of one probe: its step id, and — when its verdict has an
 *  `indeterminate` arm — how to say which read failed and what it said. A verdict
 *  with no such arm takes `null`; one with the arm cannot. */
type DailyHealthCheckProbe<K extends DailyHealthCheckProbeKey> = {
  step: string;
  describeIndeterminate: [IndeterminateArm<K>] extends [never]
    ? null
    : (verdict: IndeterminateArm<K>) => { phase: string; detail: string };
};

const describeImage = (v: { reference: string; detail: string }) => ({
  phase: 'registry',
  detail: `${v.reference}: ${v.detail}`,
});

/**
 * Every probe of the check, keyed by its field on the result (MOTIR-10429).
 * Typed over EVERY field, so a probe added to the result does not compile until
 * it is listed here — which is what makes the streak cover it.
 */
export const DAILY_HEALTH_CHECK_PROBES: {
  [K in DailyHealthCheckProbeKey]: DailyHealthCheckProbe<K>;
} = {
  schedules: { step: 'schedule-health', describeIndeterminate: null },
  fleet: { step: 'fleet-boot-preflight', describeIndeterminate: describeImage },
  indexFleet: { step: 'index-fleet-boot-preflight', describeIndeterminate: describeImage },
  hostedAgentImage: { step: 'hosted-agent-image-preflight', describeIndeterminate: describeImage },
  indexContainerAi: {
    step: 'index-container-ai-address',
    describeIndeterminate: (v) => ({ phase: 'address', detail: `${v.address}: ${v.detail}` }),
  },
  fleetOrigins: {
    step: 'fleet-origins',
    describeIndeterminate: (v) => ({ phase: 'address', detail: v.detail }),
  },
  indexRebuildStreak: { step: 'index-rebuild-streak', describeIndeterminate: null },
  monitorConfig: { step: 'monitor-config-preflight', describeIndeterminate: null },
  credentialExpiry: { step: 'credential-expiry', describeIndeterminate: null },
  hostedRuns: { step: 'hosted-run-probe', describeIndeterminate: null },
  fleetImageCoverage: {
    step: 'fleet-image-coverage',
    describeIndeterminate: (v) =>
      v.targetsUnreadable
        ? {
            phase: 'targets',
            detail: `GitHub answered ${v.targetsUnreadable.status ?? 'nothing'} listing the pairs`,
          }
        : {
            phase: 'pairs',
            detail: v.pairs
              .filter((p) => p.state === 'unknown')
              .map((p) => `${p.projectKey} on ${p.org}: ${p.message}`)
              .join('; '),
          },
  },
  runnerImageFreshness: {
    step: 'runner-image-freshness-v2',
    describeIndeterminate: (v) => ({ phase: v.phase, detail: `${v.image}: ${v.detail}` }),
  },
  runnerVersionSupport: {
    step: 'runner-version-support',
    describeIndeterminate: (v) => ({ phase: v.phase, detail: v.detail }),
  },
};

/**
 * Judgements NESTED inside one probe's verdict that carry an `indeterminate`
 * state of their own — one step that judges two things. Each is read as its own
 * probe, keyed by its path on the result, so a read that keeps failing on the
 * nested judgement alone is not hidden behind a definite outer verdict. The
 * runner AMI (MOTIR-10395) is judged inside `runner-image-freshness-v2`, and its
 * read can stay `indeterminate` while the image itself is `current`.
 */
export const DAILY_HEALTH_CHECK_NESTED_PROBES: ReadonlyArray<{
  probe: string;
  step: string;
  read: (
    verdicts: Pick<DailyHealthCheckResult, DailyHealthCheckProbeKey>,
  ) => { phase: string; detail: string } | null;
}> = [
  {
    probe: 'runnerImageFreshness.ami',
    step: 'runner-image-freshness-v2',
    read: ({ runnerImageFreshness: { ami } }) =>
      ami.state === 'indeterminate'
        ? { phase: `ami ${ami.phase}`, detail: `${ami.amiId}: ${ami.detail}` }
        : null,
  },
];

/** This run's verdicts, as the streak reads them: one reading per probe that has
 *  an `indeterminate` arm, and one per nested judgement. Exported for the test. */
export function indeterminateReadings(
  verdicts: Pick<DailyHealthCheckResult, DailyHealthCheckProbeKey>,
): IndeterminateProbeReading[] {
  const nested = DAILY_HEALTH_CHECK_NESTED_PROBES.map(({ probe, step, read }) => ({
    probe,
    step,
    indeterminate: read(verdicts),
  }));
  const top = (Object.keys(DAILY_HEALTH_CHECK_PROBES) as DailyHealthCheckProbeKey[]).flatMap(
    (key) => {
      const { step, describeIndeterminate } = DAILY_HEALTH_CHECK_PROBES[key];
      if (!describeIndeterminate) return [];
      const verdict = verdicts[key] as { verdict?: unknown };
      const describe = describeIndeterminate as (v: unknown) => { phase: string; detail: string };
      return [
        {
          probe: key,
          step,
          indeterminate: verdict.verdict === 'indeterminate' ? describe(verdict) : null,
        },
      ];
    },
  );
  return [...top, ...nested];
}

/**
 * Thrown when the Actions runner the fleet is built with is past GitHub's
 * support window, or inside the warning margin before it (MOTIR-10706). Its own
 * error, because the fix is a PIN BUMP, not a release of what is already
 * merged: the freshness errors send an operator to tag a release; this one sends
 * them to the Dockerfile first.
 */
export class RunnerVersionUnsupportedError extends Error {
  constructor(
    readonly verdict: Extract<
      RunnerVersionSupportVerdictDTO,
      { verdict: 'expiring' | 'unsupported' }
    >,
  ) {
    super(runnerVersionSentence(verdict));
    this.name = 'RunnerVersionUnsupportedError';
  }
}

/** The runner AMI is stale while the image is not (MOTIR-10395). */
export class RunnerAmiStaleError extends Error {
  constructor(readonly ami: Extract<RunnerAmiFreshnessDTO, { state: 'stale' }>) {
    super(amiStaleSentence(ami));
    this.name = 'RunnerAmiStaleError';
  }
}

export const dailyHealthCheck = defineJob(
  {
    id: 'system.daily-health-check',
    cron: DAILY_HEALTH_CHECK_CRON,
    // `latest` — and this job is the one where the disposition feeds back into
    // the probe it carries (`docs/decisions/job-queue-foundation.md` §11.7).
    // `judge()` forgives exactly one missed tick, so catching up on restart
    // stamps `lastRunAt` and keeps that tolerance meaning what it was designed to
    // mean. Under `skip`, a routine worker restart spanning 09:00 would leave this
    // job two ticks stale and its own first act the next day would be to report
    // ITSELF overdue and dead-letter — a fault manufactured by the schedule
    // rather than observed.
    catchUp: 'latest',
    retryPolicy: 'none',
  },
  async (ctx, services): Promise<DailyHealthCheckResult> => {
    // `step.run` memoizes the read, so the verdict is captured once per run
    // rather than re-derived on every replay of the handler body.
    const schedules = await ctx.step.run('schedule-health', () =>
      services.jobScheduleHealth.check(),
    );
    const fleet = await ctx.step.run('fleet-boot-preflight', () => services.fleetPreflight.check());
    const indexFleet = await ctx.step.run('index-fleet-boot-preflight', () =>
      services.fleetPreflight.checkIndexFleet(),
    );
    const hostedAgentImage = await ctx.step.run('hosted-agent-image-preflight', () =>
      services.fleetPreflight.checkHostedAgentImage(),
    );
    const indexContainerAi = await ctx.step.run('index-container-ai-address', () =>
      services.fleetPreflight.checkIndexContainerAiAddress(),
    );
    const fleetOrigins = await ctx.step.run('fleet-origins', () =>
      services.fleetPreflight.checkFleetOrigins(),
    );
    const indexRebuildStreak = await ctx.step.run('index-rebuild-streak', () =>
      services.indexRebuildStreak.check(),
    );
    const monitorConfig = await ctx.step.run('monitor-config-preflight', () =>
      services.monitorConfigPreflight.check(),
    );
    const credentialExpiry = await ctx.step.run('credential-expiry', () =>
      services.credentialExpiry.check(),
    );
    const hostedRuns = await ctx.step.run('hosted-run-probe', () =>
      services.hostedRunProbe.check(),
    );
    const fleetImageCoverage = await ctx.step.run('fleet-image-coverage', () =>
      services.fleetImageCoverage.check(),
    );
    // `-v2`: MOTIR-10395 replaced the AMI's `not_read` arm with a judged verdict.
    const runnerImageFreshness = await ctx.step.run('runner-image-freshness-v2', () =>
      services.runnerImageFreshness.check(),
    );
    const runnerVersionSupport = await ctx.step.run('runner-version-support', () =>
      services.runnerVersionSupport.check(),
    );
    const verdicts = {
      schedules,
      fleet,
      indexFleet,
      hostedAgentImage,
      indexContainerAi,
      fleetOrigins,
      indexRebuildStreak,
      monitorConfig,
      credentialExpiry,
      hostedRuns,
      fleetImageCoverage,
      runnerImageFreshness,
      runnerVersionSupport,
    };
    // The ESCALATION (MOTIR-10429), read after every probe and before any throw:
    // how many runs in a row each probe has been unable to tell.
    const indeterminateStreak = await ctx.step.run('indeterminate-streak', () =>
      services.indeterminateStreak.check(indeterminateReadings(verdicts)),
    );
    // ⚠️ EVERY PROBE RUNS BEFORE ANY OF THEM THROWS. A stopped schedule, an
    // unpullable runner image and an unpullable indexer image are independent
    // faults, and a run that reported only the first would hide the rest for as
    // many days as the first took to fix. So all the reads are taken above and
    // only the reporting is ordered. This is why MOTIR-2030's probe is a second
    // `step.run` rather than a branch inside the first one.
    //
    // This job's own ledger row is written by `recordStart` BEFORE the handler
    // body runs, so the check always sees a fresh run for
    // `system.daily-health-check` itself and can never flag itself as overdue.
    if (schedules.overdue.length > 0) throw new ScheduledJobsOverdueError(schedules);

    // ⚠️ ONLY `unpullable` IS LOUD. `indeterminate` means the probe could not
    // REACH the registry — a network statement, not an image one — and failing
    // on it would page an operator about ghcr.io's uptime and, worse, teach them
    // that this row is usually noise. The verdict is still recorded on the
    // `job_run` row either way, and a STREAK of them is the alarm instead: the
    // `indeterminate-streak` read above fails the run once the same probe has
    // not answered on the last `INDETERMINATE_STREAK_THRESHOLD` runs (MOTIR-10429).
    if (fleet.verdict === 'unpullable') throw new FleetImageUnpullableError(fleet);

    // The INDEXER path, reported after the runner's and on exactly the same
    // terms: only a DEFINITE refusal is loud, and `not_applicable` — a deployment
    // that runs CI but has not wired `MOTIR_INDEXER_IMAGE` — is a green state,
    // not a fault. Runner first only because a deployment that cannot boot CI has
    // the larger outage; both verdicts are on the row either way.
    if (indexFleet.verdict === 'unpullable') throw new IndexFleetImageUnpullableError(indexFleet);

    // The HOSTED-AGENT path (MOTIR-9420), on the same terms: only a definite
    // refusal is loud, and `not_applicable` is a deployment with no hosted agent.
    if (hostedAgentImage.verdict === 'unpullable') {
      throw new HostedAgentImageUnpullableError(hostedAgentImage);
    }

    // The REACHABILITY probe, reported last and on the same terms: only the two
    // DEFINITE arms are loud. `indeterminate` is this process failing to reach an
    // address, not the address failing; `not_applicable` is a deployment that
    // does not index. Both are recorded on the row either way.
    if (
      indexContainerAi.verdict === 'unconfigured' ||
      indexContainerAi.verdict === 'private_address'
    ) {
      throw new IndexContainerAiAddressError(indexContainerAi);
    }

    // The FLEET ORIGINS (Story MOTIR-9714), on the same terms: only `failed` is
    // loud, and `indeterminate` is core's probe failing to get an answer, which
    // the streak escalates. After the index container's own address, so a bad
    // motir-ai address keeps its more specific message; both name the stack
    // output it must equal.
    if (fleetOrigins.verdict === 'failed') throw new FleetOriginsError(fleetOrigins);

    // The LEDGER probe, reported last and on the same terms as every one above
    // it: only the DEFINITE arm is loud. `not_applicable` is a deployment that
    // has never indexed, and `ok` can still carry `unknownRepoRefs` — repos
    // whose runs recorded no mode at all, which is UNMEASURED rather than
    // healthy and is deliberately not an alarm.
    //
    // ⚠️ WHY `unknown` IS NOT LOUD, stated because the opposite reading is
    // reasonable and wrong. On the day this shipped 844 of 899 succeeded runs
    // carried no mode, so failing on it would dead-letter this job every
    // morning over a state no operator can act on — and a check that cries wolf
    // is a check somebody silences, which is how MOTIR-3606 spent 23 days red
    // with nobody reading it. It is REPORTED on the row instead, in its own
    // field, so a reader can see what was not measured without being paged.
    if (indexRebuildStreak.verdict === 'rebuilding') {
      throw new IndexRebuildStreakError(indexRebuildStreak);
    }

    // The ENVIRONMENT probe, reported last and on exactly the same terms as every
    // one above it: only the DEFINITE arm is loud. `not_applicable` is a
    // deployment that has not connected an error monitor — a green state, not a
    // fault — and it is by far the common case for a self-hosted build, where
    // `sentry` is registered at import in every image whether or not anybody
    // intends to use it.
    //
    // ⚠️ WHY `not_applicable` IS NOT LOUD, stated because the opposite reading is
    // reasonable and wrong. Failing on "Sentry's names are unset" would
    // dead-letter this job every morning on every deployment that never wanted an
    // error monitor, over a state their operator chose deliberately — and a check
    // that cries wolf is a check somebody silences, which is how MOTIR-3606 spent
    // 23 days red with nobody reading it. The discriminator is PARTIAL
    // configuration, which is the shape the defect actually had: three of four
    // names present, one missing. It is REPORTED on the row either way, so a
    // reader can see what was not measured without being paged.
    if (monitorConfig.verdict === 'incomplete') {
      throw new MonitorConfigIncompleteError(monitorConfig);
    }

    // The CREDENTIAL probe, reported last and on the same terms: an unset
    // variable is `skipped` inside the verdict, never a fault. EXPIRED outranks
    // EXPIRING because the first is an outage and the second is a reminder.
    if (credentialExpiry.verdict === 'expired') throw new CredentialExpiredError(credentialExpiry);
    if (credentialExpiry.verdict === 'expiring') {
      throw new CredentialExpiringError(credentialExpiry);
    }

    // The HOSTED-RUN probe. `not_applicable` (no owned org configured — every
    // self-hosted build) is an answer, not a fault, exactly as the monitor probe
    // treats an unconfigured provider.
    if (hostedRuns.verdict === 'hosted_runs') throw new HostedRunInOwnedOrgError(hostedRuns);

    // The IMAGE-COVERAGE probe (MOTIR-10290). Only `gap` is loud: `indeterminate`
    // is a read GitHub or the registry refused, and `not_applicable` a deployment
    // that runs no fleet. Both are on the row either way.
    if (fleetImageCoverage.verdict === 'gap') {
      throw new FleetImageCoverageGapError(fleetImageCoverage);
    }

    // The RUNNER-VERSION probe (MOTIR-10706), before freshness: a pin GitHub
    // refuses is an outage of the whole fleet, and its fix (a pin bump) comes
    // before any release. `expiring` is loud too — that is the point of the
    // margin. `indeterminate` and `not_applicable` are on the row either way.
    if (
      runnerVersionSupport.verdict === 'unsupported' ||
      runnerVersionSupport.verdict === 'expiring'
    ) {
      throw new RunnerVersionUnsupportedError(runnerVersionSupport);
    }

    // The FRESHNESS probe (MOTIR-10393). Only `stale` is loud: `indeterminate` is
    // a registry or GitHub read that did not answer — never a pass, and on the
    // row with the read it failed — and `not_applicable` a deployment that pins
    // no runner image.
    if (runnerImageFreshness.verdict === 'stale') {
      throw new RunnerImageStaleError(runnerImageFreshness);
    }
    // The AMI arm (MOTIR-10395) is loud on the same terms: `stale` only.
    if (runnerImageFreshness.ami.state === 'stale') {
      throw new RunnerAmiStaleError(runnerImageFreshness.ami);
    }

    // The STREAK, reported last: every definite fault above is the more
    // actionable message. A run that throws one of them records no verdicts and
    // is skipped by the next run's read; a run that throws THIS records which
    // probes could not tell on `failure.data`, so the streak keeps counting.
    if (indeterminateStreak.verdict === 'persistent') {
      throw new ProbeIndeterminateStreakError(indeterminateStreak);
    }

    return { ...DAILY_HEALTH_CHECK_PAYLOAD, ...verdicts, indeterminateStreak };
  },
);
