import 'server-only';

import { deploymentIdentity } from '@/lib/deployment/identity';
import { deploymentStatusProvider } from '@/lib/deployment/providers';
import type {
  PlatformHealthDTO,
  PlatformOverdueScheduleDTO,
  PlatformQueueHealthDTO,
  PlatformSignalDTO,
} from '@/lib/dto/platformHealth';
import { GATEWAY_STATUS_TIMEOUT_MS } from '@/lib/gateway/statusClient';
import { GatewayStatusMalformedError } from '@/lib/gateway/statusErrors';
import { gatewayStatusReader } from '@/lib/gateway/statusProvider';
import { serverSentryDsn } from '@/lib/monitoring/config';
import { errorCountReader } from '@/lib/monitoring/errorCountProvider';
import { SENTRY_ERROR_COUNT_WINDOW_HOURS } from '@/lib/monitoring/sentryErrorCount';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { databaseHealthRepository } from '@/lib/repositories/databaseHealthRepository';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { jobScheduleHealthService } from '@/lib/services/jobScheduleHealthService';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * The day-1 system-health glance — design `platform-admin/design-notes.md`
 * **Panel 8**, card MOTIR-1167.
 *
 * ⚠️ THE RULE THIS SERVICE EXISTS TO KEEP: an unreachable probe must never read
 * as a zero. The asset states it in situ, on the card that demonstrates it:
 *
 * > The Errors card says "No response from Sentry" and "this is **not** an error
 * > count of zero" — a green card reading "0 errors" while the probe is down is
 * > the failure this panel exists to prevent.
 *
 * So every probe below is INDIVIDUALLY guarded, and a probe that throws yields
 * `state: 'unreachable'` with an EMPTY `values` bag. There is no `?? 0` anywhere
 * in this file, and adding one would be the whole defect.
 *
 * ⚠️ AND ONE FAILING PROBE MUST NOT TAKE THE BOARD DOWN. The design's argument
 * for putting all three tones on ONE board is that *"an operator's real screen is
 * mixed"* — which is only true if the mixed screen renders. Each probe absorbs
 * its own failure through `probe()` below, so the seven run concurrently and none
 * of them can reject; that is why the gather is a plain `Promise.all` and why
 * `probe()` is the ONE place a throw becomes `unreachable`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE AUDIT ROW IS WRITTEN OUTSIDE A `withPlatformRead` TRANSACTION
 * ---------------------------------------------------------------------------
 * The ADR's §3a contract — *"the audit row is INSERTed as the first statement
 * inside the same transaction as the read"* — binds a CROSS-TENANT read to its
 * trail, so that a read cannot commit without one. This service reads no tenant
 * row at all: the signals come from the job ledger, the dead-letter set, the
 * gateway's status endpoint and the deployment's own environment, which is exactly why `health.read` is its
 * own action rather than an `estate.read`. The row is still written FIRST and
 * unconditionally, so the trail cannot be missing; what it is not is transacted
 * with reads that are not tenant reads and do not share its client.
 *
 * ---------------------------------------------------------------------------
 * READ AND LINK, NEVER REMEDIATE
 * ---------------------------------------------------------------------------
 * There is no replay here, no redeploy, no cancel. Every card carries a link-out
 * to the provider's own dashboard, which is 10.2's *integrate-not-rebuild* stance
 * applied one story early — and it is why nothing in this file needs a write.
 */

/**
 * The synthetic event name the daily health check's cron ticks are recorded
 * under — `defineJob` writes `scheduled.{id}` for every scheduled run.
 *
 * A LITERAL here rather than an import of the job definition, deliberately.
 * `jobScheduleHealthService`'s own header records why that module is not
 * imported from a service: `registry → definitions/dailyHealthCheck →
 * jobScheduleHealthService → registry` is an ESM cycle, and importing the
 * definition from here would evaluate the same chain for one string. The pair is
 * pinned instead by `tests/platform/platformHealthService.test.ts`, which
 * imports the definition and asserts the two agree — the same guard
 * `tests/monitoring/sentry-wiring.test.ts` puts on its own cross-file constant.
 */
const DAILY_HEALTH_CHECK_EVENT_NAME = 'scheduled.system.daily-health-check';

/** How many overdue schedules the list renders before the pager elides the rest. */
const OVERDUE_PAGE_SIZE = 10;

/**
 * The window the "Failed jobs" card counts ARRIVALS over.
 *
 * ⚠️ A WINDOW ANSWERS A RATE AND CANNOT ANSWER A BACKLOG (MOTIR-5840). This
 * constant is correct for the question it was written for — *how many jobs died
 * today?* — and it is the reason the card read `0 dead-lettered · 24h` in green
 * while 1,381 unreplayed rows stood behind it, the newest of them four days old.
 * The fix was not to widen it: a wider window is still a window, and a backlog
 * has no age at which it stops mattering. The card carries STANDING depth beside
 * this, read with no time bound at all.
 */
const DLQ_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Standing unreplayed dead letters at or above this read as a BACKLOG.
 *
 * One, deliberately: a dead letter that nobody has replayed is a job whose work
 * never happened, so there is no count of them that is fine. It is a named
 * constant rather than a literal `> 0` because the threshold is exactly the knob
 * a paging policy would want to raise, and the reading publishes it so a consumer
 * can apply its own (MOTIR-3765 owns the external alert; MOTIR-5845 owns whether
 * a dead letter should file a work item).
 */
const DLQ_BACKLOG_THRESHOLD = 1;

/**
 * Above this, the database ping reads as `degraded` rather than `healthy`.
 *
 * 500ms is not a service-level objective and is not presented as one — it is the
 * point past which "reachable" stops being the useful answer to an operator
 * looking at this board during an incident. The real latency is always rendered
 * beside it, so the operator judges the number and not this constant.
 */
const DB_SLOW_MS = 500;

/**
 * Above this, the gateway's status read reads as `degraded` rather than
 * `healthy` (MOTIR-742).
 *
 * 1000ms, twice the database's bar, because this read crosses a network hop to
 * another app rather than pinging a pooled connection — and, like `DB_SLOW_MS`,
 * it is not an SLO. `/api/status` does no work beyond serialising a config map,
 * so a second spent on it says the gateway's process or its network is struggling,
 * which is when every coding run's model calls start to suffer too. The real
 * latency is rendered beside the verdict, and the threshold rides in `values` so
 * the card's detail can name it.
 */
const GATEWAY_SLOW_MS = 1000;

/**
 * At or above this many errors in 24 hours, the Errors card reads `degraded`
 * rather than `healthy` (MOTIR-740). Inclusive, so the threshold itself is
 * already worth a look.
 *
 * 100 is not an SLO and is not presented as one — like `DB_SLOW_MS`, it is the
 * point past which an operator glancing at this board should open Sentry. A
 * quiet day for a deployment this size is a handful of errors; a hundred in a
 * day is a spike or a new crash loop, and the issues link-out beside the number
 * is where an operator learns which. The real count is always rendered beside the
 * verdict, and the threshold rides in `values` so the card's detail can name it.
 */
const ERRORS_24H_DEGRADED = 100;

/**
 * How long the OLDEST claimable run may wait before the queue reads `stalled`.
 *
 * ⚠️ AGE IS THE SIGNAL AND DEPTH IS THE CONTEXT, which is the whole shape of
 * this check. A deep queue draining fast is healthy; a queue three rows deep
 * that has not moved in twenty minutes is not, and only one of those two numbers
 * can tell them apart.
 *
 * Five minutes, and the reasoning is arithmetic rather than taste. A DUE row is
 * claimable immediately: the worker's idle poll ceiling is `IDLE_MAX_MS` = 5 s
 * (`lib/jobs/engine/worker.ts`), and a `NOTIFY` normally beats even that. A row
 * that is backed off after a failure, debounced, or scheduled for later is NOT
 * due, so none of those explain a wait here — `readDueBacklog` filters on
 * `run_at <= now()` precisely so that this constant has one meaning. Five
 * minutes is therefore sixty poll intervals of slack, which is generous enough
 * that a deploy, a slow reclaim or a long claim transaction cannot reach it, and
 * tight enough that the 2026-08-28 stall — 30 minutes unclaimed, 139 rows deep
 * — would have fired twenty-five minutes before anybody asked why the tree
 * looked broken.
 */
const QUEUE_STALL_MS = 5 * 60 * 1000;

export const platformHealthService = {
  /**
   * The whole glance, for one platform principal.
   *
   * Takes the principal as its FIRST parameter and re-asserts the ladder (ADR
   * §3's layer table): the `(admin)` layout gates the PAGES, and a service that
   * trusted it would be one server action away from being reachable without it.
   * `support` is the minimum — the drill-down and the glance are read surfaces,
   * and only Panel 9's two writes ask for `operator`.
   */
  async read(principal: PlatformPrincipal, now: Date = new Date()): Promise<PlatformHealthDTO> {
    await requirePlatformStaff('support');
    await platformAuditService.record(principal, {
      action: 'health.read',
      targetKind: 'platform',
    });

    const schedules = probe(() => jobScheduleHealthService.check(now));
    const [database, hosting, gateway, scheduleSignal, failedJobs, errors, lastHealthCheck] =
      await Promise.all([
        databaseSignal(),
        hostingSignal(),
        gatewaySignal(),
        scheduleSignalFrom(schedules),
        failedJobsSignal(now),
        errorsSignal(),
        lastHealthCheckSignal(now),
      ]);

    const report = await schedules;
    const overdue: PlatformOverdueScheduleDTO[] = (report?.overdue ?? []).map((entry) => ({
      functionId: entry.functionId,
      cron: entry.cron,
      lastRunAt: entry.lastRunAt,
      expectedAt: entry.judgedAgainst,
    }));

    return {
      checkedAt: now.toISOString(),
      // Gateway third, after Hosting, so the three infrastructure cards read as one
      // row at three columns (design-notes § Panel 8 — Story 10.2 delta).
      signals: [database, hosting, gateway, scheduleSignal, failedJobs, errors, lastHealthCheck],
      overdue: overdue.slice(0, OVERDUE_PAGE_SIZE),
      overdueTotal: overdue.length,
      schedulesChecked: report?.entries.length ?? 0,
    };
  },

  /**
   * THE QUEUE BACKLOG (Subtask MOTIR-3764) — the one reading on this service
   * that is NOT part of {@link read}'s glance, and not gated by a staff session.
   *
   * ⚠️ IT IS COMPUTED BY A DIRECT QUERY, NOT BY A JOB, NOT FROM A CACHE, AND NOT
   * FROM A COUNTER THE WORKER HOLDS. On 2026-08-28 the queue stopped being
   * claimed at 10:15:16 and the only thing that noticed was a person wondering
   * why six work items had not moved. Nothing else could have: the check that
   * would report it, `system.daily-health-check`, is itself a job — so a wedged
   * worker takes the alarm down with the thing it is meant to alarm on. Every
   * signal above was green throughout, because a queue 139 rows deep with a
   * healthy worker, a current lease and zero failures is green on all six.
   *
   * ⚠️ AND IT THROWS RATHER THAN ABSORBING. `probe()` exists so one dead card
   * cannot take the board down, which is right for a board and wrong here: the
   * caller is a machine deciding whether to page somebody, and an unreadable
   * database must reach it as a failure rather than as a healthy-looking reading
   * with a reason in it. The route turns the throw into a 503.
   */
  async readQueueHealth(now: Date = new Date()): Promise<PlatformQueueHealthDTO> {
    const { depth, oldestRunAt } = await withSystemContext((tx) =>
      jobQueueRepository.readDueBacklog(tx),
    );

    // ⚠️ THE DEAD-LETTER LIMB IS TOLERANT WHERE THE QUEUE READ ABOVE IS NOT, and
    // the asymmetry is the decision (MOTIR-5840). The queue verdict is what pages
    // somebody, so an unreadable database must reach the caller as a 503 — that
    // is the header's rule and it is unchanged. The backlog reading is a second,
    // slower question riding along on the same request, and letting IT throw
    // would take down the page-worthy signal to report a ticket-worthy one. So it
    // absorbs its own failure and SAYS SO, in the only way that cannot be
    // mistaken for good news: `state: 'unreadable'` with a null count.
    const standing = await probe(() =>
      withSystemContext((tx) => jobRunDlqRepository.countActiveSince(null, tx)),
    );
    const deadLetters: PlatformQueueHealthDTO['deadLetters'] =
      standing === null
        ? { state: 'unreadable', unreplayed: null, threshold: DLQ_BACKLOG_THRESHOLD }
        : {
            state: standing >= DLQ_BACKLOG_THRESHOLD ? 'backlogged' : 'healthy',
            unreplayed: standing,
            threshold: DLQ_BACKLOG_THRESHOLD,
          };
    // `max(0, …)` because `run_at` is a DUE time, and a row due one millisecond
    // ago has a negative age against a clock read a moment earlier.
    const oldestPendingAgeMs =
      oldestRunAt === null ? null : Math.max(0, now.getTime() - oldestRunAt.getTime());

    return {
      // AGE decides, never depth. An empty queue has no age and is healthy.
      state:
        oldestPendingAgeMs !== null && oldestPendingAgeMs > QUEUE_STALL_MS ? 'stalled' : 'healthy',
      depth,
      oldestPendingAgeMs,
      stallThresholdMs: QUEUE_STALL_MS,
      checkedAt: now.toISOString(),
      deadLetters,
    };
  },
};

/**
 * Run one probe and turn a throw into `null` rather than a rejection.
 *
 * The single place a probe's failure is absorbed, so that `unreachable` is
 * produced in exactly one way and can never be confused with a measured zero.
 */
async function probe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** An unreachable card — no number, and a `reason` the copy names in words. */
function unreachable(id: PlatformSignalDTO['id'], reason: string, linkOut: string | null) {
  return { id, state: 'unreachable', values: { reason }, linkOut } satisfies PlatformSignalDTO;
}

async function databaseSignal(): Promise<PlatformSignalDTO> {
  const startedAt = Date.now();
  const ok = await probe(async () => {
    await withSystemContext((tx) => databaseHealthRepository.ping(tx));
    return true;
  });
  if (!ok) return unreachable('database', 'unreachable', neonConsoleUrl());

  const ms = Date.now() - startedAt;
  return {
    id: 'database',
    state: ms > DB_SLOW_MS ? 'degraded' : 'healthy',
    values: { ms, region: databaseRegion() },
    linkOut: neonConsoleUrl(),
  };
}

/**
 * Where the app is running, and whether all of it is (MOTIR-1167, MOTIR-7332).
 *
 * ⚠️ THE PROVIDER KNOWLEDGE IS NOT HERE, AND MUST NOT COME BACK.
 * `docs/decisions/ci-runner-fleet.md` §4 rule 1 keeps `lib/` provider-agnostic,
 * and `tests/ciFleet/orchestratorPortBoundary.test.ts` enforces it by scanning
 * SOURCE — so this service reads a neutral `DeploymentIdentity` (where THIS
 * process is) and a neutral `DeploymentStatus` (how many of its siblings run,
 * through the port in `lib/deployment/deploymentStatus.ts`), and names no
 * platform, no environment variable and no dashboard host.
 *
 * (This service failed that guard on its first push, with three raw `FLY_*`
 * reads inline. The guard was right and the fix is the accessor, not an
 * exemption for a service.)
 *
 * The verdict, in order:
 * - not on a managed host → `unreachable` / `notManaged`, unchanged;
 * - no read credential → `unreachable` / `noReadCredential`, still carrying the
 *   process's own identity (app, region, machine), which is a reading taken from
 *   inside and counts nothing;
 * - the read throws → `unreachable` / `readFailed`, never an empty fleet;
 * - a group short of its expectation → `degraded` / `shortGroup`;
 * - running machines on more than one release → `degraded` / `mixedReleases`;
 * - otherwise `healthy`.
 */
async function hostingSignal(): Promise<PlatformSignalDTO> {
  const deployment = deploymentIdentity();
  if (!deployment.app) return unreachable('hosting', 'notManaged', null);

  const identity = {
    app: deployment.app,
    region: deployment.region ?? '—',
    machineId: deployment.instanceId ?? '—',
  };
  const provider = await deploymentStatusProvider();
  if (!provider || !provider.configured()) {
    return {
      id: 'hosting',
      state: 'unreachable',
      values: { reason: 'noReadCredential', ...identity },
      linkOut: deployment.dashboardUrl,
    };
  }

  const status = await probe(() => provider.read());
  if (!status) return unreachable('hosting', 'readFailed', deployment.dashboardUrl);

  const counts: Record<string, number> = {};
  for (const group of status.groups) {
    counts[`${group.name}Started`] = group.started;
    counts[`${group.name}Expected`] = group.expected;
  }
  const release = status.releases[0] ?? '—';
  const values: Record<string, string | number> = { ...identity, ...counts, release };

  const short = status.groups.find((group) => group.started < group.expected);
  if (short) {
    return {
      id: 'hosting',
      state: 'degraded',
      values: {
        ...values,
        reason: 'shortGroup',
        group: short.name,
        started: short.started,
        expected: short.expected,
      },
      linkOut: deployment.dashboardUrl,
    };
  }
  if (status.releases.length > 1) {
    return {
      id: 'hosting',
      state: 'degraded',
      values: { ...values, reason: 'mixedReleases', count: status.releases.length },
      linkOut: deployment.dashboardUrl,
    };
  }
  return { id: 'hosting', state: 'healthy', values, linkOut: deployment.dashboardUrl };
}

/**
 * Is motir-gateway answering, how fast, and which build (MOTIR-742).
 *
 * Every coding run's model calls go through the gateway, and before this card
 * the console asked it nothing: an outage showed up only as runs failing one by
 * one, each looking like its own problem, under an all-green board.
 *
 * ⚠️ THREE UNREACHABLE REASONS, AND THEY ARE NOT THE SAME SENTENCE. A deployment
 * with no `MOTIR_GATEWAY_URL` runs no gateway — a self-hosted instance, a dev box
 * — and that is `notConfigured`, an expected state. A configured gateway that
 * gives no answer — the deadline passed, the connection failed — is `noAnswer`,
 * which is an incident on the way TO the gateway. A gateway that ANSWERED, with a
 * non-2xx or a body the client rejects, is `badAnswer` (MOTIR-9641): an incident
 * in the gateway's payload or its deploy, and saying "no answer" there sent an
 * operator chasing the network for a gateway that replied in 100 ms. None carries
 * a latency or a version: `values` holds the reason and, for `noAnswer`, the
 * deadline the copy names ("no answer within {timeout} s") — a setting of this
 * probe, never a measurement of the gateway — and, for `badAnswer`, `why` (the
 * rejection's code) and, on an HTTP rejection, `status` as a string.
 *
 * ⚠️ THE LINK-OUT IS THE STATUS ENDPOINT ITSELF, not a hosting dashboard. Naming
 * the gateway's hosting provider here would leak it into `lib/`, which
 * `tests/ciFleet/orchestratorPortBoundary.test.ts` forbids; the endpoint the probe
 * read is provider-neutral and shows an operator exactly what the card measured.
 */
async function gatewaySignal(): Promise<PlatformSignalDTO> {
  const reader = gatewayStatusReader();
  if (!reader.configured()) return unreachable('gateway', 'notConfigured', null);

  // A configured-but-malformed URL (e.g. one ending in `/v1`) throws here; the
  // read below fails on the same URL, so the card is `noAnswer` with no link
  // rather than a link to an address that cannot be right.
  const linkOut = await probe(async () => reader.statusUrl());
  // A rejected ANSWER resolves rather than throws, so `probe()` stays the one
  // place a throw becomes `unreachable` and only a missing answer reaches it.
  const read = await probe(() =>
    reader.read().then(
      (status) => ({ status, rejected: null }),
      (err: unknown) => {
        if (err instanceof GatewayStatusMalformedError) return { status: null, rejected: err };
        throw err;
      },
    ),
  );
  if (read?.rejected) return badAnswer(read.rejected, linkOut);
  const status = read?.status ?? null;
  if (status === null) {
    return {
      id: 'gateway',
      state: 'unreachable',
      // The deadline crosses as TEXT: it is a setting, not a reading, and the
      // board's rule is that no unreachable card carries a number (MOTIR-744).
      values: { reason: 'noAnswer', timeout: String(GATEWAY_STATUS_TIMEOUT_MS / 1000) },
      linkOut,
    };
  }

  return {
    id: 'gateway',
    state: status.latencyMs > GATEWAY_SLOW_MS ? 'degraded' : 'healthy',
    values: {
      ms: status.latencyMs,
      version: status.version,
      since: status.startTime,
      threshold: GATEWAY_SLOW_MS,
    },
    linkOut,
  };
}

/**
 * The gateway answered, and the answer was rejected (MOTIR-9641). `why` is the
 * rejection's code, which the copy names in words; an HTTP rejection adds the
 * status it answered with — as TEXT, under the same no-number rule as the
 * deadline above, because the card measured nothing.
 */
function badAnswer(rejected: GatewayStatusMalformedError, linkOut: string | null) {
  const values: Record<string, string> = { reason: 'badAnswer', why: rejected.why };
  if (rejected.httpStatus !== null) values['status'] = String(rejected.httpStatus);
  return { id: 'gateway', state: 'unreachable', values, linkOut } satisfies PlatformSignalDTO;
}

async function scheduleSignalFrom(
  report: Promise<Awaited<ReturnType<typeof jobScheduleHealthService.check>> | null>,
): Promise<PlatformSignalDTO> {
  const resolved = await report;
  if (!resolved) return unreachable('schedules', 'probeFailed', null);

  return {
    id: 'schedules',
    state: resolved.overdue.length > 0 ? 'degraded' : 'healthy',
    values: { overdue: resolved.overdue.length, total: resolved.entries.length },
    linkOut: null,
  };
}

async function failedJobsSignal(now: Date): Promise<PlatformSignalDTO> {
  const since = new Date(now.getTime() - DLQ_WINDOW_MS);
  // ⚠️ ONE probe for BOTH numbers, not one each. `probe()` is the single place a
  // failure becomes `unreachable`, and two of them could half-succeed — which
  // would put a real number beside an invented one on the same card, the precise
  // shape this panel's three-state rule exists to forbid. Either the card reports
  // both readings or it reports neither.
  const read = await probe(() =>
    withSystemContext(async (tx) => ({
      count: await jobRunDlqRepository.countActiveSince(since, tx),
      standing: await jobRunDlqRepository.countActiveSince(null, tx),
    })),
  );
  if (read === null) return unreachable('failedJobs', 'probeFailed', null);

  return {
    id: 'failedJobs',
    // STANDING depth decides, and the windowed count is context — the inversion
    // of the queue card one field down, where age decides and depth is context.
    // A backlog nobody has touched for a week is the case this card was blind to,
    // so a zero in the window may not make it green on its own.
    state: read.standing >= DLQ_BACKLOG_THRESHOLD || read.count > 0 ? 'degraded' : 'healthy',
    values: { count: read.count, standing: read.standing },
    linkOut: null,
  };
}

/**
 * The error-monitoring signal — how many errors Motir's own Sentry project
 * accepted in the last 24 hours (MOTIR-740).
 *
 * It reads through a PLATFORM credential (`SENTRY_READ_TOKEN`, provisioned by
 * MOTIR-739: an internal integration with read scopes only), never through a
 * tenant's Sentry App grant, so one workspace disconnecting its integration
 * cannot blind the operator console. See `lib/monitoring/sentryErrorCount.ts`.
 *
 * ⚠️ THREE UNREACHABLE REASONS, AND NONE OF THEM IS A ZERO.
 * - `notConfigured` — no DSN and no read credential: this deployment reports no
 *   errors anywhere (a self-hosted instance).
 * - `noReadCredential` — errors ARE reported (a DSN is set), but this console
 *   holds no read token to count them.
 * - `readFailed` — the credential is set and Sentry did not answer cleanly (a
 *   401, a 5xx, a malformed body, a timeout).
 * Each carries only its `reason`; a measured zero is `healthy` with `count: 0`,
 * and only a clean read can produce one.
 */
async function errorsSignal(): Promise<PlatformSignalDTO> {
  const reader = errorCountReader();
  if (!reader.configured()) {
    const reason = serverSentryDsn() ? 'noReadCredential' : 'notConfigured';
    return unreachable('errors', reason, SENTRY_ISSUES_URL);
  }

  const reading = await probe(() => reader.read());
  if (reading === null) return unreachable('errors', 'readFailed', SENTRY_ISSUES_URL);

  return {
    id: 'errors',
    state: reading.count >= ERRORS_24H_DEGRADED ? 'degraded' : 'healthy',
    values: {
      count: reading.count,
      windowHours: SENTRY_ERROR_COUNT_WINDOW_HOURS,
      threshold: ERRORS_24H_DEGRADED,
    },
    linkOut: reader.issuesUrl(reading),
  };
}

/**
 * When the daily health check last ran, and whether that tick passed.
 *
 * ⚠️ THREE OUTCOMES, NOT TWO, and collapsing the last two is the bug this card
 * is about. "The probe threw" and "the ledger holds no such run" are BOTH absent
 * numbers and they mean opposite things: the first says this console cannot see
 * the ledger, the second says the check has never fired — which is itself the
 * loudest thing this board could tell an operator. `probe()` returns `null` for
 * a throw and the read returns `null` for no row, so the two are wrapped to keep
 * them distinguishable rather than compared against the same literal.
 */
async function lastHealthCheckSignal(now: Date): Promise<PlatformSignalDTO> {
  void now;
  const read = await probe(async () => ({
    run: await withSystemContext((tx) =>
      jobRunRepository.findLatestByEventName(DAILY_HEALTH_CHECK_EVENT_NAME, tx),
    ),
  }));
  if (read === null) return unreachable('lastHealthCheck', 'probeFailed', null);
  if (read.run === null) return unreachable('lastHealthCheck', 'never', null);

  return {
    id: 'lastHealthCheck',
    state: read.run.status === 'succeeded' ? 'healthy' : 'degraded',
    values: { ranAt: read.run.startedAt.toISOString(), status: read.run.status },
    linkOut: null,
  };
}

/**
 * The Neon project the app talks to, named from `DATABASE_URL`'s HOST rather
 * than from a decision record.
 *
 * The host is the one identifier that is true of the connection actually open —
 * an ADR records where the project was created, and a deployment pointed
 * somewhere else would still read `iad` out of it. Neon encodes the region in
 * the hostname (`…-<region>.aws.neon.tech`), so the substring is a reading and
 * not a lookup; anything else renders as the raw host, which is still the truth.
 */
function databaseRegion(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) return '—';
  try {
    const host = new URL(url).hostname;
    const match = /-([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host);
    return match?.[1] ?? host;
  } catch {
    return '—';
  }
}

/**
 * The Neon console, or null when this deployment is not on Neon.
 *
 * There is no project id in the connection string, so the link is to the
 * console's project list rather than to this project — a deliberate under-claim.
 * A constructed deep link that 404s during an incident is worse than a list.
 */
function neonConsoleUrl(): string | null {
  const url = process.env['DATABASE_URL'];
  return url?.includes('neon.tech') ? 'https://console.neon.tech/app/projects' : null;
}

/**
 * ⚠️ THE JOB SIGNALS HAVE NO LINK-OUT, AND THAT IS THE CORRECTION MOTIR-3418
 * MAKES RATHER THAN AN OMISSION.
 *
 * They used to point at a vendor dashboard —
 * `app.inngest.com/env/production/{functions,runs}` — carrying the design's own
 * deliberate inaccuracy, kept because it was the design's:
 *
 * > "Failed after their retries. Inngest has no literal DLQ — this is the
 * > failed-set, and replay happens there."
 *
 * That was already half wrong when it was written (`job_run_dlq` is Motir's own
 * table, and a job on the Postgres engine never reached the vendor at all), and
 * it is wholly wrong now: the account is being closed, so the link would take an
 * operator mid-incident to a page with nothing on it — or to a login for a
 * product this company no longer uses.
 *
 * ⚠️ AND THE REPLACEMENT IS NOT A DIFFERENT URL. The per-run detail an operator
 * actually wants lives on the staff ledger at `/admin/jobs` (the tenant
 * per-WORKSPACE page this note once named was retired by Story MOTIR-9982), not
 * a vendor URL this console could construct. A link-out this console cannot honestly construct is `null`,
 * which the DTO already models (`hostingSignal` returns one on a deployment that
 * is not managed) and which the card renders as text without an affordance.
 */
const SENTRY_ISSUES_URL = 'https://sentry.io/issues/';
