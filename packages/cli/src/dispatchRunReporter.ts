import type {
  DispatchCardDisposition,
  DispatchRunCardInput,
  DispatchRunEventInput,
  DispatchSkipReason,
  DispatchStopReason,
  MotirClient,
} from './client.js';
import type { AgentDecisionPoint, AgentStopReport } from './agentRun.js';
import {
  ApiRefusalError,
  NetworkError,
  RateLimitError,
  ResponseShapeError,
  ServerFailureError,
} from './errors.js';

// THE DISPATCH RUN REPORTER (Story MOTIR-1789 · MOTIR-1794) — what turns a local
// run into a watchable object, built to `docs/decisions/dispatch-run-record.md`.
//
// ── ITS MOST IMPORTANT PROPERTY IS WHAT IT REFUSES TO BREAK ────────────────
// A person running `motir auto` overnight is doing REAL WORK; the run record is
// an OBSERVATION of that work. If a flaky network, an expired token or a 500
// could abort a dispatch, move a card's status or change an exit code, the
// feature would have made the product less reliable in exchange for a nicer
// page — and the first time it happened nobody would trust it again.
//
// So: **every method here swallows its own failure.** Nothing throws, nothing
// returns a rejected promise, and no caller is ever asked to handle a reporting
// error. That is the side-effect-failure-must-not-fail-the-request rule, applied
// client-side. `tests/dispatchRunReporter.test.ts` drives it with a client that
// throws on every call and asserts each method still resolves.
//
// ── OFFLINE IS A FIRST-CLASS STATE, NOT AN ERROR — AND ONLY A DEFINITIVE END
//    TAKES THE REPORTER THERE (MOTIR-10705) ────────────────────────────────
// When the server says reporting CANNOT continue — the credential is refused
// (401/403), the run is closed or gone (409/404), the CLI and server disagree on
// the contract — the reporter prints ONE warning naming that run reporting is
// off for this session and stops trying for the rest of the run. A warning per
// event would bury the agent's own output — which is the thing the operator is
// actually watching — under telemetry noise.
//
// ⚠️ EVERY OTHER FAILURE KEEPS IT REPORTING, because silence is no longer free.
// It used to go offline on the FIRST failure of any kind, on the premise that
// "the run itself is unaffected". A HOSTED run disproves it: the server ends a
// hosted run as a STALL when its newest event is fifteen minutes old
// (`hostedRunService.stallDetail`), so a reporter that went quiet over one
// refused batch killed a run whose agent was still working. Now a refused batch
// (413/422) is narrowed to the event the server refuses, which alone is dropped;
// a transient failure (5xx, network, timeout, an exhausted rate-limit wait) is
// retried with backoff and, if it persists, left queued for the next flush.
// {@link classifyReportingFailure} is the one place that sorts them.
//
// ── IT READS NOTHING (MOTIR-3204) ─────────────────────────────────────────
// Every fact it sends is ALREADY in the process: the claim's answer, the frozen
// snapshot, the dispatch payload, the agent's exit, the CI verdict the watch
// already read. The CLI's run shape is pinned by guards — one fresh agent
// process per card, NO ready query after the claim — and a reporter that quietly
// ran a query to draw a nicer picture would trade the run's correctness for the
// page's completeness. If a payload this wants is not in hand, that is a finding
// for the ingest's shape, never a new query here.

/**
 * How many events the queue holds before it starts dropping.
 *
 * ⚠️ BOUNDED, AND IT DROPS THE OLDEST. An unbounded buffer on a machine whose
 * network is down is a memory leak that grows for as long as the run does —
 * which on `motir auto` is hours. Dropping the oldest keeps the tail, and the
 * tail is the half an operator opens a run page for.
 */
export const REPORTER_QUEUE_LIMIT = 500;

/** How many events one flush sends. Matches the ingest's own batch ceiling. */
export const REPORTER_BATCH_LIMIT = 200;

/**
 * The events that are SENT THE MOMENT THEY ARE QUEUED rather than at the next
 * flush (Bug MOTIR-7329).
 *
 * ⚠️ THEY ARE THE EVENTS A DEAD RUN IS READ BY. `motir continue` finds a dead
 * run's branch on its newest `checkout_ready` (`dispatchRunEventRepository`), and
 * every leg queues that event and then awaits its agent for the whole run. A
 * SIGKILL, a lost sandbox or a dead laptop runs no handler — `close()` never
 * flushes — so an event that waits for a flush is exactly the event a hard death
 * loses, and the commits the checkpoint pushes are stranded on a branch Motir
 * cannot name. `run_opened` is here for the same reason: it is what says the
 * run started at all.
 *
 * Kept SHORT on purpose: an ordinary event (a log line above all) still waits for
 * a flush, so a chatty agent is never one request per line.
 */
export const FLUSH_ON_ENQUEUE: ReadonlySet<DispatchRunEventInput['kind']> = new Set([
  'run_opened',
  'checkout_ready',
]);

/** The one warning, printed once per session when reporting ends for good. */
export const REPORTER_OFFLINE_WARNING =
  'motir: run reporting is unavailable — this run will not appear in Motir. ' +
  'The run itself is unaffected.';

/** Printed once per session, the first time the server refuses an event it will never
 *  take (an over-size body, a malformed event). Reporting carries on without it. */
export const REPORTER_EVENT_REFUSED_WARNING =
  'motir: Motir refused a run event, which was dropped. Reporting continues.';

/** Printed once when the run reaches the server's event ceiling (422
 *  `DISPATCH_RUN_EVENT_LIMIT`): no further event is recorded, the run can still close. */
export const REPORTER_EVENT_LIMIT_WARNING =
  'motir: this run reached Motir’s event limit — later output is not recorded. ' +
  'The run itself is unaffected.';

/**
 * The waits between the attempts of ONE reporting call that failed TRANSIENTLY
 * (MOTIR-10705): three retries, doubling, about seven seconds in all. Short on purpose —
 * `close()` awaits a flush, and an outage longer than this is not waited out here:
 * the batch stays queued and the next flush (at the latest the next heartbeat) tries
 * again, which the queue bound keeps from growing.
 */
export const REPORTER_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * What a failed reporting call means for the reporter (MOTIR-10705):
 *
 * - `end` — reporting cannot continue this session: a refused credential (401/403), a
 *   run the server has closed (409) or does not know (404), a client the server does not
 *   speak to, or a failure this client's transport did not raise. The reporter goes
 *   OFFLINE.
 * - `capped` — the run reached the server's event ceiling. No later event can land, but
 *   the run can still be closed, so only EVENTS stop.
 * - `refused` — the server will never take THIS request (413, 422 and the other 4xx).
 *   Sending it again is pointless; the next one may well be fine.
 * - `delivered` — a 2xx whose body this client could not read. The server took the
 *   request, so it must not be sent again.
 * - `transient` — the request may succeed if repeated: a 5xx, a network failure or
 *   timeout, a rate limit the transport stopped waiting out.
 */
export type ReportingFailure = 'end' | 'capped' | 'refused' | 'delivered' | 'transient';

export function classifyReportingFailure(err: unknown): ReportingFailure {
  if (err instanceof ApiRefusalError) {
    if (err.code === 'DISPATCH_RUN_EVENT_LIMIT') return 'capped';
    // A 409 on the reporter's calls is a run that is not open for them; the terminal
    // case is already typed below, and any other conflict is no more recoverable.
    if (err.status === 409) return 'end';
    return 'refused';
  }
  if (
    err instanceof NetworkError ||
    err instanceof ServerFailureError ||
    err instanceof RateLimitError
  ) {
    return 'transient';
  }
  if (err instanceof ResponseShapeError) return 'delivered';
  // Everything else is a definitive answer: an auth or permission refusal, a run closed
  // or not found, a contract the two sides do not share — and any failure the transport
  // did not classify, which is a defect in this client rather than a state of the
  // network, so repeating the call could not help.
  return 'end';
}

/**
 * How often an open run tells the server it is alive (MOTIR-6530).
 *
 * The SERVER's number, restated: `RUN_HEARTBEAT_INTERVAL_MS` in
 * `lib/runs/runLiveness.ts`, which reads a local run as DEAD after five missed
 * beats. The CLI cannot import the server's module, so
 * `tests/cli/runHeartbeatInterval.test.ts` pins the two to each other.
 */
export const RUN_HEARTBEAT_INTERVAL_MS = 60_000;

/** The one line printed when the server has closed the run under us. */
export const REPORTER_RUN_CLOSED_WARNING =
  'motir: Motir closed this run — it heard nothing from it for five minutes. ' +
  'The work on this machine continues; it is no longer reported.';

/** What a command hands the reporter when it opens a run. */
export interface OpenDispatchRunInput {
  projectKey: string;
  command: 'next' | 'run' | 'run_scope' | 'batch' | 'auto' | 'fix' | 'continue' | 'review';
  /** `runIdFromDate`'s id — carried, never re-minted. */
  runId: string;
  /**
   * The SET, in the run's own order. EMPTY for `motir auto`, which holds no
   * plan and appends a leg per iteration — materialising a list to report would
   * break the property that loop exists to have.
   */
  cards: DispatchRunCardInput[];
  scopeKey?: string;
  scopeLabel?: string;
  agent?: string;
  model?: string;
}

export interface DispatchRunReporter {
  /** Open the run. Safe to call once; a second call is ignored. */
  open(input: OpenDispatchRunInput): Promise<void>;
  /**
   * Report into a run the SERVER already opened, instead of opening one —
   * `motir fix`'s repair claim (MOTIR-5464) opens its `fix` run inside the same
   * transaction that locks the card, so the CLI must not open a second. Ignored
   * once the reporter holds a run. `addCard` stays a no-op on an adopted run: the
   * set is the claim's, and it was complete when the run was opened.
   */
  adopt(runId: string): void;
  /** Append a leg mid-run — `motir auto`'s per-iteration discovery. */
  addCard(card: DispatchRunCardInput): Promise<void>;
  /** Queue one event. Never awaits the network; never throws. */
  event(event: DispatchRunEventInput): void;
  /** Send whatever is queued. Never throws. */
  flush(): Promise<void>;
  /** Flush, then close the run with its stop reason, and stop the heartbeat. Never
   *  throws; a second call is a no-op. */
  close(stopReason: DispatchStopReason): Promise<void>;
  /**
   * Report that the agent stopped because `targetKey` is UNBUILDABLE (MOTIR-8698) —
   * the run-found report, made by the CLI with the run's own credential so it
   * reaches Motir in every lane (a hosted agent holds no Motir token; a local one
   * may have no Motir MCP). Awaited, so it lands before the leg settles; never
   * throws. A no-op when no run is held.
   *
   * OPTIONAL so a hand-written fake that predates it still type-checks; the real
   * reporter always has it.
   */
  reportUnbuildable?(targetKey: string, reason: string): Promise<void>;
  /**
   * Record the agent's BUILD-THROUGH points on `key` (MOTIR-8722), and the decisions it made
   * where the plan was silent (MOTIR-10000), with the run's own credential. Awaited, never
   * throws, a no-op when no run is held. OPTIONAL, as above.
   */
  reportDiscrepancy?(
    key: string,
    points: { planAsked: string; built: string; why: string }[],
    decisions?: AgentDecisionPoint[],
  ): Promise<void>;
  /**
   * Make the agent's STOP writes on `key` (MOTIR-8722) — its comment and, with
   * `toPlanning`, the move to Planning — with the run's own credential. Awaited, never
   * throws, a no-op when no run is held. OPTIONAL, as above.
   */
  reportStop?(key: string, stop: AgentStopReport): Promise<void>;
  /** True once a failure has taken reporting down for this session. */
  readonly offline: boolean;
  /** The run this reporter opened, or null when it never opened one. */
  readonly runId: string | null;
  /**
   * Whether the operator asked for log BODIES (`--report-log`).
   *
   * ⚠️ THIS IS NOT A SECOND PRIVACY CHECK, and it must never become one. The
   * strip stays in {@link DispatchRunReporter.event} — one place, so a call
   * site that forgot cannot leak. This flag answers a different question, for
   * the PRODUCER side: is it worth CAPTURING the agent's output at all? With
   * the opt-in off the answer is no, because every body captured would be
   * stripped a moment later, so `agentLogTee` reads this to skip the work
   * rather than to decide the policy.
   */
  readonly wantsLogBodies: boolean;
}

export interface DispatchRunReporterDeps {
  /**
   * `heartbeatDispatchRun` is OPTIONAL so a test fake that predates the heartbeat
   * still type-checks; production always passes the real client, which has it.
   */
  client: Pick<MotirClient, 'openDispatchRun' | 'appendDispatchRunEvents' | 'closeDispatchRun'> &
    Partial<
      Pick<
        MotirClient,
        | 'heartbeatDispatchRun'
        | 'reportDispatchRunUnbuildable'
        | 'recordDispatchRunDiscrepancy'
        | 'reportDispatchRunStop'
      >
    >;
  /** Where the single offline warning goes. `console.error` in production. */
  warn?: (message: string) => void;
  /**
   * Whether to send opt-in LOG BODIES (ADR Q4).
   *
   * ⚠️ DEFAULT FALSE, and the default is the promise. A BYOK run executes on the
   * operator's own machine, against a checkout Motir has never seen, under a key
   * Motir does not hold — its log carries file paths, source excerpts, error
   * output and possibly environment secrets. With this off, `body` is STRIPPED
   * from every event before it leaves the process, which is why the stripping
   * happens here rather than at each call site: a call site that forgot would
   * leak, and there are dozens of them.
   */
  reportLogBodies?: boolean;
  /** Waits between retries. A real timer in production; overridden only by the tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The retry schedule. {@link REPORTER_RETRY_DELAYS_MS} in production. */
  retryDelaysMs?: readonly number[];
}

/** A wait that never keeps a finished process alive. */
function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * A reporter that does NOTHING, successfully.
 *
 * The default everywhere, so wiring the reporter into a pipeline is not a
 * behaviour change until a command opens a run, and so every existing test that
 * calls those pipelines keeps passing without learning about run reporting.
 */
export const nullDispatchRunReporter: DispatchRunReporter = {
  async open() {},
  adopt() {},
  async addCard() {},
  event() {},
  async flush() {},
  async close() {},
  offline: false,
  runId: null,
  wantsLogBodies: false,
};

export function createDispatchRunReporter(deps: DispatchRunReporterDeps): DispatchRunReporter {
  const warn = deps.warn ?? ((message: string) => console.error(message));
  const sleep = deps.sleep ?? unrefSleep;
  const retryDelays = deps.retryDelaysMs ?? REPORTER_RETRY_DELAYS_MS;
  const queue: DispatchRunEventInput[] = [];
  let runId: string | null = null;
  /** The open call's own arguments, kept so `addCard` can re-issue it. */
  let opened: OpenDispatchRunInput | null = null;
  let offline = false;
  /** Set when the run hit the server's event ceiling: events stop, the close does not. */
  let eventsCapped = false;
  /** Whether the one refused-event warning has been printed. */
  let warnedRefused = false;
  /** Set by the first `close`; every later one is a no-op (an interrupt and the
   *  command's own close can both reach it). */
  let closed = false;
  /** Serialises flushes, so two callers cannot interleave a batch's order. */
  let inFlight: Promise<void> = Promise.resolve();
  /** A flush queued behind the one in flight and not yet started. A later caller joins
   *  it rather than chaining another: it drains whatever is queued WHEN it starts, so a
   *  second one could add nothing, and a chatty agent on a slow link would otherwise
   *  build an ever-longer chain of pending flushes. */
  let pendingFlush: Promise<void> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function stopHeartbeat(): void {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
  }

  /**
   * THE HEARTBEAT (Story MOTIR-6526 · MOTIR-6530) — while this reporter holds an
   * open run, tell the server at once, and then every {@link RUN_HEARTBEAT_INTERVAL_MS},
   * that the run is alive. The reporter owns the run's lifetime, so it owns the heartbeat: no
   * command has to remember to send one.
   *
   * ⚠️ A FAILED BEAT DOES NOT TAKE THE REPORTER OFFLINE, and that is a deliberate
   * departure from the rule every other call here follows. Offline is for the
   * session; one lost beat is a blip the next beat repairs. Going offline on it
   * would stop every later beat, and the server would then read a run that is
   * working as DEAD and offer it to somebody else to continue — the one outcome
   * this timer exists to prevent. So a failure is swallowed and the next tick
   * tries again. Only `closed` (the server has already closed the run) stops it.
   *
   * ⚠️ THE FIRST BEAT GOES AT ONCE, NOT ONE INTERVAL LATER (MOTIR-7328). The
   * server reads a run with no heartbeat at all as a LEGACY run — a CLI too old to
   * heartbeat — and keeps it alive for 12 hours (`lib/runs/runLiveness.ts`). A run
   * killed inside its first interval used to have sent nothing, so it fell into
   * that population and `motir continue` refused it as `run_alive` for half a day,
   * in exactly the minute runs most often die. Beating at open means every run
   * this CLI holds carries a `lastHeartbeatAt` from its first second, and the
   * five-minute lapse governs it however early it dies.
   *
   * ⚠️ EACH BEAT ALSO FLUSHES THE QUEUE (MOTIR-7329). A run killed hard runs no
   * handler, so whatever is still queued when it dies is lost; flushing on the
   * beat bounds that loss to one interval instead of the whole run.
   *
   * `unref`: the timer must never be the thing that keeps a finished process
   * alive.
   */
  function startHeartbeat(id: string): void {
    const client = deps.client;
    if (client.heartbeatDispatchRun === undefined || heartbeat !== null) return;
    const beat = (): void => {
      void flushQueue();
      // Called directly (not through a hoisted, pre-bound local): the run-token
      // route table's CLI scan (`tests/hostedRuns/runTokenRouteTable.test.ts`)
      // finds a call by the literal text `client.<operation>(`, on any run path
      // this reporter serves — local and hosted alike (MOTIR-6558).
      if (client.heartbeatDispatchRun === undefined) return;
      void client.heartbeatDispatchRun(id).then(
        (answer) => {
          if (answer === 'closed' && heartbeat !== null) {
            stopHeartbeat();
            warn(REPORTER_RUN_CLOSED_WARNING);
          }
        },
        () => undefined,
      );
    };
    // The timer is armed BEFORE the first beat, so a `closed` answer to that beat
    // finds it and stops it.
    heartbeat = setInterval(beat, RUN_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    beat();
  }

  /** Take the reporter down for the rest of the session, once, with one line. */
  function goOffline(): void {
    if (offline) return;
    offline = true;
    queue.length = 0;
    warn(REPORTER_OFFLINE_WARNING);
  }

  /** Stop sending events for the rest of the run, once, with one line. */
  function capEvents(): void {
    if (eventsCapped) return;
    eventsCapped = true;
    queue.length = 0;
    warn(REPORTER_EVENT_LIMIT_WARNING);
  }

  /**
   * Make one reporting call, retrying a TRANSIENT failure on the backoff schedule, and
   * answer how it ended. Never throws.
   */
  async function call(fn: () => Promise<unknown>): Promise<'ok' | ReportingFailure> {
    for (let retry = 0; ; retry += 1) {
      try {
        await fn();
        return 'ok';
      } catch (err) {
        const failure = classifyReportingFailure(err);
        const wait = retryDelays[retry];
        if (failure !== 'transient' || wait === undefined || offline) return failure;
        await sleep(wait);
      }
    }
  }

  /**
   * Run one call that is not an event append — the open, a leg, the close — swallowing
   * everything.
   *
   * ⚠️ THE SWALLOW IS THE FEATURE. Every failure mode a headless machine has — a 500, a
   * timeout, an expired PAT, no network at all — arrives here, and none of them may
   * reach the run. Only a DEFINITIVE end takes the reporter offline (`orOffline` widens
   * that to any failure, for the open: a run that never opened has nothing to report
   * into).
   */
  async function attempt(fn: () => Promise<unknown>, orOffline = false): Promise<void> {
    if (offline) return;
    const outcome = await call(fn);
    // (For the open even a `delivered` is a failure: the run id is in the body it could
    // not read.)
    if (outcome === 'end' || (orOffline && outcome !== 'ok')) {
      goOffline();
    } else if (outcome === 'capped') {
      capEvents();
    }
  }

  /**
   * Append ONE batch, and say what is left of it (MOTIR-10705).
   *
   * ⚠️ A REFUSED BATCH IS NARROWED, NEVER ABANDONED. The server refuses a batch WHOLE for
   * one bad event — an over-size body, a malformed event — and the answer does not say
   * which. So the batch is split in half and each half sent again, down to the single
   * event the server will not take, which alone is dropped: one bad event costs about
   * log₂(batch) extra requests, and every good event around it — `agent_exited` among
   * them — still lands.
   *
   * `stop` ends this flush: the reporter went offline or hit the event ceiling, or a
   * transient failure outlasted its retries. `unsent` is what to put back at the head of
   * the queue in that last case, so the next flush tries it again.
   */
  async function sendBatch(
    id: string,
    batch: DispatchRunEventInput[],
  ): Promise<{ stop: boolean; unsent: DispatchRunEventInput[] }> {
    const outcome = await call(() =>
      deps.client.appendDispatchRunEvents({ runId: id, events: batch }),
    );
    switch (outcome) {
      case 'ok':
      case 'delivered':
        return { stop: false, unsent: [] };
      case 'end':
        goOffline();
        return { stop: true, unsent: [] };
      case 'capped':
        capEvents();
        return { stop: true, unsent: [] };
      case 'transient':
        return { stop: true, unsent: batch };
      case 'refused': {
        if (batch.length === 1) {
          if (!warnedRefused) {
            warnedRefused = true;
            warn(REPORTER_EVENT_REFUSED_WARNING);
          }
          return { stop: false, unsent: [] };
        }
        const half = Math.ceil(batch.length / 2);
        const first = await sendBatch(id, batch.slice(0, half));
        if (first.stop) return { stop: true, unsent: [...first.unsent, ...batch.slice(half)] };
        return sendBatch(id, batch.slice(half));
      }
    }
  }

  /**
   * Send whatever is queued, behind any send already in flight.
   *
   * ⚠️ NO EARLY RETURN ON AN EMPTY QUEUE. Since MOTIR-7329 a send can start in
   * the background (an event in {@link FLUSH_ON_ENQUEUE}, a heartbeat), so an
   * empty queue no longer means nothing is on its way — the batch may already
   * have been spliced off and be awaiting the network. Chaining onto `inFlight`
   * regardless is what stops `close()` from reaching the server ahead of the
   * events it is closing over.
   */
  function flushQueue(): Promise<void> {
    const id = runId;
    if (offline || eventsCapped || id === null) return Promise.resolve();
    if (pendingFlush !== null) return pendingFlush;
    const send = inFlight.then(async () => {
      pendingFlush = null;
      while (!offline && !eventsCapped && queue.length > 0) {
        const batch = queue.splice(0, REPORTER_BATCH_LIMIT);
        const { stop, unsent } = await sendBatch(id, batch);
        if (!stop) continue;
        // Put a batch that could not be sent back at the HEAD — it is the oldest — and
        // keep the bound: past it the oldest go first, exactly as `event` drops them.
        if (!offline && !eventsCapped) {
          queue.unshift(...unsent);
          if (queue.length > REPORTER_QUEUE_LIMIT) {
            queue.splice(0, queue.length - REPORTER_QUEUE_LIMIT);
          }
        }
        break;
      }
    });
    pendingFlush = send;
    inFlight = send;
    return send;
  }

  return {
    get offline() {
      return offline;
    },
    get runId() {
      return runId;
    },
    // Read by the PRODUCER side (`agentLogTee`) to decide whether capturing the
    // agent's output is worth doing. The strip below is still the only thing
    // that decides whether a body LEAVES.
    wantsLogBodies: deps.reportLogBodies === true,

    async open(input) {
      if (runId !== null) return;
      await attempt(async () => {
        const result = await deps.client.openDispatchRun({
          projectKey: input.projectKey,
          command: input.command,
          // ⚠️ THE RUN'S OWN ID, CARRIED. `runIdFromDate` already produced it,
          // `sessionBranchName` derives the branch from it and the session
          // pull-request body prints it — so a reviewer's branch, the pull
          // request they read and the run row in Motir all name the same run.
          // A second identity minted here would be a second answer to "which run
          // was this?".
          idempotencyKey: input.runId,
          cards: input.cards,
          ...(input.scopeKey === undefined ? {} : { scopeKey: input.scopeKey }),
          ...(input.scopeLabel === undefined ? {} : { scopeLabel: input.scopeLabel }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.model === undefined ? {} : { model: input.model }),
        });
        runId = result.runId;
        opened = input;
      }, true);
      if (runId !== null) startHeartbeat(runId);
    },

    adopt(id) {
      if (runId !== null) return;
      runId = id;
      startHeartbeat(id);
    },

    async addCard(card) {
      const input = opened;
      if (runId === null || input === null) return;
      // ⚠️ A LEG IS APPENDED THROUGH THE **OPEN**, not through an event.
      //
      // `motir auto` holds no plan and discovers its set one card per iteration,
      // so its legs necessarily arrive after the run does — and the open is the
      // ONLY operation that takes a card set at all. An EVENT may never add a
      // card to a run, because the set IS the plan the run published; letting it
      // grow behind that plan would defeat the record.
      //
      // Re-issuing the open is safe precisely because it is idempotent on
      // `idempotencyKey`: the server finds the run it already has and adds the
      // leg. That is the same mechanism that makes a RETRY safe, used on purpose
      // rather than borrowed.
      await attempt(async () => {
        await deps.client.openDispatchRun({
          projectKey: input.projectKey,
          command: input.command,
          idempotencyKey: input.runId,
          cards: [card],
        });
      });
    },

    event(event) {
      if (offline || eventsCapped || runId === null) return;
      // The opt-in, enforced HERE rather than at each call site: a site that
      // forgot would leak, and there are dozens of them.
      const scrubbed: DispatchRunEventInput = deps.reportLogBodies
        ? event
        : (({ body: _body, ...rest }) => rest)(event);
      queue.push(scrubbed);
      // Drop the OLDEST, so the tail survives — the half an operator opens a run
      // page for.
      while (queue.length > REPORTER_QUEUE_LIMIT) queue.shift();
      // Sent now, not awaited: `event` never waits on the network, and the send
      // completes while the caller's agent works (MOTIR-7329).
      if (FLUSH_ON_ENQUEUE.has(event.kind)) void flushQueue();
    },

    async flush() {
      await flushQueue();
    },

    async reportUnbuildable(targetKey, reason) {
      const id = runId;
      const client = deps.client;
      if (id === null || closed || client.reportDispatchRunUnbuildable === undefined) return;
      // ⚠️ NOT through `attempt`, and NOT gated on `offline`. This is not telemetry:
      // it is the one way a planner's mistake found by this run reaches Motir, so a
      // lost event batch earlier in the run must not silence it, and its own failure
      // must not take the rest of the reporting down. Swallowed all the same — a
      // report that cannot land never changes what the run did.
      try {
        await client.reportDispatchRunUnbuildable({ runId: id, targetKey, reason });
      } catch {
        warn(`motir: could not report ${targetKey} as unbuildable to Motir. The run continues.`);
      }
    },

    // The agent's other two writes (MOTIR-8722), on the same terms as the report above: not
    // telemetry, so neither through `attempt` nor gated on `offline`, and swallowed with one
    // warning, because a write that cannot land never changes what the run did.
    async reportDiscrepancy(key, points, decisions = []) {
      const id = runId;
      const client = deps.client;
      if (id === null || closed || client.recordDispatchRunDiscrepancy === undefined) return;
      try {
        await client.recordDispatchRunDiscrepancy({
          runId: id,
          key,
          points,
          ...(decisions.length > 0 ? { decisions } : {}),
        });
      } catch {
        warn(`motir: could not record the discrepancies on ${key} in Motir. The run continues.`);
      }
    },

    async reportStop(key, stop) {
      const id = runId;
      const client = deps.client;
      if (id === null || closed || client.reportDispatchRunStop === undefined) return;
      try {
        await client.reportDispatchRunStop({
          runId: id,
          key,
          comment: stop.comment,
          toPlanning: stop.toPlanning,
          ...(stop.requirement ? { requirement: stop.requirement } : {}),
        });
      } catch {
        warn(
          `motir: could not comment on ${key}` +
            (stop.toPlanning ? ' or move it to Planning' : '') +
            ' in Motir. The run continues.',
        );
      }
    },

    async close(stopReason) {
      const id = runId;
      if (id === null || closed) return;
      closed = true;
      stopHeartbeat();
      await this.flush();
      await attempt(() => deps.client.closeDispatchRun({ runId: id, stopReason }));
    },
  };
}

/** The leg dispositions a verdict maps to, so no call site invents one. */
export const DISPOSITION: Record<string, DispatchCardDisposition> = {
  claimed: 'running',
  integrated: 'integrated',
  implemented: 'implemented',
  failed: 'failed',
  replanned: 'replanned',
};

/** The skip reasons the CLI's own vocabularies map to, one for one. */
export type ReporterSkipReason = DispatchSkipReason;
