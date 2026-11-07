import { withSystemContext } from '@/lib/workspaces/context';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { deferRun } from '../engine/defer';

// THE SUPERVISION DRIVER (Story MOTIR-3778 · Subtask MOTIR-3827) — one shared
// advance-once state machine, and the only place either container supervisor's
// loop lives after the conversions.
//
// ===========================================================================
// What it does, in one sentence
// ===========================================================================
// Read the supervision's row, do EXACTLY ONE poll, and then either write the
// advanced state and DEFER the run (`lib/jobs/engine/defer.ts`), or take a
// terminal transition and settle. `docs/decisions/job-queue-foundation.md` §16
// is the decision it implements.
//
// ===========================================================================
// ⚠️ THE SUSPENSION INVARIANT, AND WHY IT IS STRUCTURAL RATHER THAN A GUARD
// ===========================================================================
// **A DEFER IS A SUSPENSION, NOT A PATH OUT OF SUPERVISION.** Teardown is
// reachable from exactly THREE named transitions and from nothing else:
//
//   1. the poll returned a `done` verdict — the container ended;
//   2. a DEADLINE fired — either the wall clock measured from the SESSION's
//      `bootedAt`, or the total-poll ceiling. Two triggers, one transition:
//      both mean "this supervision may not continue", and each carries its own
//      reason and its own test;
//   3. the poll THREW — a failure settles FIRST and re-throws after, which is
//      the arm a stepped loop could never cover.
//
// **There is no `try`/`finally` in this file, and that absence is the
// mechanism.** §15.4 recorded what a `finally` costs a shape that suspends by
// throwing: *"a yielding poll loop would have called `settleIndexContainer` on
// its first suspension and torn down the container it was watching."* A defer is
// a throw too. A guard that says "unless it is a defer" is one edit from being
// wrong for ever; a file with nothing to unwind through cannot make the mistake.
// The defer is thrown from the tail, outside every `try` here, and
// `settles no container on the defer path` asserts the negative directly.
//
// ===========================================================================
// ⚠️ THE POLL CEILING IS A TOTAL BOUND AGAIN — a property REGAINED
// ===========================================================================
// §13.3(a) accepted that `maxPollIterations` had become a per-PASS runaway
// guard rather than a bound on total polls, because a worker restart reset the
// in-memory counter and the wall clock anchored on `session.bootedAt` was the
// bound that actually mattered. **The count lives in `job_supervision` now**, so
// a supervision resumed across a hundred passes reaches the ceiling at the same
// cumulative number it would have reached in one. That is a property coming
// back, not a behaviour change hidden in a refactor — and §16.5's disposition
// table says so at the call site.
//
// ===========================================================================
// What this module is NOT allowed to know
// ===========================================================================
//   * **No timing constant appears here.** `waitMs`, `maxPolls` and `timeoutMs`
//     are all supplied by the caller — `indexPollWaitMs` /
//     `INDEX_FLEET_TIME_BUDGETS` for one supervisor, `pollWaitMs` /
//     `FLEET_TIME_BUDGETS` for the other — precisely so this file cannot become
//     a second place a cadence lives. §16.6 forbids changing any of them.
//   * **No container, no orchestrator, no admission slot.** It calls the
//     `settle` hook it was given. The caller wraps that hook in its own memoized
//     `step.run`, which is what makes a teardown idempotent across passes.
//   * **WHERE the state lives is a SEAM, not a fact of this file** — see
//     {@link SupervisionStore}. The durable store is the default and is what
//     production runs on; the in-memory one exists so a caller with no
//     `job_queue` row (a script, a local harness, every non-job test) drives the
//     SAME machine rather than a second copy of it. One composition is what
//     MOTIR-3484 bought and this file may not spend.
//   * **No BOOT DEADLINE.** The deadline this file evaluates is the OVERALL one,
//     measured from `bootedAt` — a quantity that depends on no in-memory
//     observation and is therefore safe to evaluate on a failed read. The
//     boot-deadline verdict stays inside the caller's `poll`, where §13.3(b)'s
//     requirement can be met: it may only be reached from a SUCCESSFUL provider
//     read, because after the collapse *"we have not seen it start"* and *"we
//     have forgotten that we saw it start"* are indistinguishable. Every pass
//     now begins with `startedAt` unknown until the row is read, so that
//     requirement binds harder here than it did in the loop.

/**
 * True when a thrown value is Prisma's unique-constraint violation.
 *
 * A local copy, exactly as `lib/jobs/engine/step.ts` carries one: the check is
 * two lines, and importing it would make a shared helper out of a predicate
 * whose only correct consumers are the two places that RACE on a write.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * EVERY SUPERVISOR THAT CAN OWN A `job_supervision` ROW (MOTIR-4713).
 *
 * `JobSupervision.kind` is TEXT so a new supervisor is a registry edit rather
 * than a migration, and this closed union is the registry: the abandoned-
 * supervision sweep keys its boot-step and settle dispatch on
 * `Record<SupervisionKind, …>`, so a supervisor added here without a settle path
 * is a COMPILE error there rather than a row handed to another fleet's teardown.
 */
export const SUPERVISION_KINDS = ['index', 'ci-runner', 'hosted-agent'] as const;
export type SupervisionKind = (typeof SUPERVISION_KINDS)[number];

/** Narrow a `job_supervision.kind` read back from the database. */
export function isSupervisionKind(kind: string): kind is SupervisionKind {
  return (SUPERVISION_KINDS as readonly string[]).includes(kind);
}

/** Which supervision, and the session instant its clock is anchored to. */
export interface SupervisionKey {
  /**
   * Which supervisor — a {@link SupervisionKind}. Recorded on the row for the
   * sweep's attribution. Typed as the column is (TEXT), because the sweep reads it
   * back from the database and narrows it with {@link isSupervisionKind}.
   */
  kind: string;
  /**
   * WHAT is being supervised, within this run: the `projectId` for the index
   * fleet, the intent id for the CI fleet. It is the second half of the row's
   * identity and the string the caller's step ids are built from, so it names
   * the UNIT OF WORK and never a loop position (§13.1 limb 4).
   */
  subject: string;
  workspaceId: string | null;
  /**
   * When the container was booted — from the caller's MEMOIZED boot, never from
   * this pass. The wall clock is anchored to the SESSION rather than to the
   * loop, which is the property §13.2 records and the reason a resumed pass
   * settles a container already past its timeout instead of watching it afresh.
   */
  bootedAt: Date;
}

/** The state one pass is handed. `pollNumber` is the number of the poll it is ABOUT to perform (1-based). */
export interface SupervisionPollState {
  pollNumber: number;
  /** The observed container start, or null while nothing has successfully read one. */
  startedAt: Date | null;
  consecutiveReadFailures: number;
}

/** What the caller's ONE provider read observed. `V` is the caller's own verdict type. */
export type SupervisionPollResult<V> =
  | {
      done: false;
      startedAt: Date | null;
      consecutiveReadFailures: number;
    }
  | { done: true; verdict: V };

/**
 * Why a terminal transition was entered. Three transitions (see the header);
 * `deadline` and `poll_ceiling` are the two triggers of the second one.
 *
 * `replayed` is not a fourth transition: it means the supervision reached one on
 * an EARLIER pass, and this pass is reading the outcome back out of the caller's
 * memo. It exists because a fan-out re-enters every already-settled subject on
 * every later pass, and a pass that polled a destroyed container to rediscover
 * that would cost one provider read per settled subject per pass — which is the
 * linearity the whole shape is for.
 */
export type SupervisionTerminalReason =
  | 'completed'
  | 'deadline'
  | 'poll_ceiling'
  | 'failed'
  | 'replayed';

/** The caller's half. `V` is its poll verdict; `O` is its settled outcome. */
export interface SupervisionHooks<V, O> {
  /**
   * ONE provider read. No loop, no sleep, no second call — the whole point of
   * the shape is that a pass costs one round trip.
   */
  poll(state: SupervisionPollState): Promise<SupervisionPollResult<V>>;
  /**
   * The caller's teardown. Invoked from exactly one place in this file, and
   * expected to be wrapped by the caller in its own memoized `step.run`
   * (`index-settle:<subject>` / `settle-runner`) so a replayed pass returns the
   * stored outcome rather than destroying a container twice.
   */
  settle(
    reason: SupervisionTerminalReason,
    state: SupervisionPollState,
    verdict: V | null,
  ): Promise<O>;
  /**
   * The caller's existing backoff — `indexPollWaitMs` / `pollWaitMs`, unchanged.
   * `waitMs(n)` is the wait BEFORE poll n, which is how both loops this replaces
   * call it (`await sleep(pollWaitMs(iteration))` at the top of the body).
   */
  waitMs(pollNumber: number): number;
  /** The caller's total-poll ceiling. */
  maxPolls: number;
  /** How long the supervision may run, measured from `bootedAt`. The caller's own budget. */
  timeoutMs: number;
  /**
   * WHERE the per-pass state lives. Defaults to {@link durableSupervisionStore}
   * — the `job_supervision` table — which is what every job-driven supervision
   * uses. A caller with no `job_queue` row passes {@link inMemorySupervisionStore}.
   */
  store?: SupervisionStore;
  /** Injectable clock, for the tests. Production passes nothing. */
  now?: () => Date;
}

/** The three fields a pass reads back, plus where the machine is in its lifecycle. */
export interface SupervisionRow {
  pollNumber: number;
  startedAt: Date | null;
  consecutiveReadFailures: number;
  state: 'watching' | 'settling' | 'settled';
}

/**
 * What `open` returns: the row, plus whether THIS call is the one that created
 * it.
 *
 * ⚠️ `created` IS WHAT KEEPS THE CADENCE IDENTICAL, and it is not derivable from
 * `pollNumber`. Both loops this replaces wait BEFORE their first poll —
 * `await sleep(pollWaitMs(iteration))` is the first statement of the `for` body,
 * so the sequence is boot, wait, poll 1, wait, poll 2 — and a container cannot
 * have started in the instant after `provision` returned, so poll 1 fired
 * immediately would be a guaranteed-wasted provider read on every supervision.
 * The pass that OPENS a supervision therefore defers without polling. It cannot
 * decide that from `pollNumber === 0`, because that is equally true of the pass
 * that arrives after the first wait and is owed poll 1.
 */
export type SupervisionOpened = SupervisionRow & { created: boolean };

/**
 * WHERE a supervision's per-pass state lives.
 *
 * ⚠️ IT IS A SEAM RATHER THAN AN ABSTRACTION FOR ITS OWN SAKE, and the reason is
 * concrete. The durable row FKs to `job_queue`, so a caller with no run — a
 * script, a local harness, and the ~30 test call sites that drive
 * `runIndexContainer` / `runIntent` straight through — cannot write one. The
 * alternative to this seam is a SECOND in-process composition of the loop beside
 * the driven one, which is precisely the shape MOTIR-3484 spent a card
 * deleting: *"two copies of a supervision loop kept in agreement by hand is a
 * defect waiting for the first divergence."*
 *
 * So the ordering, the transitions and the invariant live here, once, and only
 * the storage differs.
 */
export interface SupervisionStore {
  /**
   * Open the supervision, or return the one already open, WITHOUT resetting a
   * single observation. Tolerates a concurrent opener.
   */
  open(runId: string, key: SupervisionKey, nextPollAt: Date): Promise<SupervisionOpened>;
  /**
   * Record one advanced poll — but ONLY if the row still reads
   * `expectedPollNumber` and is still `watching`. The check and the write are
   * one atomic act; a caller that lost the race writes nothing.
   */
  advanceIfUnchanged(
    runId: string,
    subject: string,
    expectedPollNumber: number,
    observation: { startedAt: Date | null; consecutiveReadFailures: number; nextPollAt: Date },
  ): Promise<void>;
  /**
   * Claim the terminal transition: move `watching` → `settling` atomically.
   * Returns true when THIS caller made the move, false when somebody else
   * already had.
   */
  claimTerminal(runId: string, subject: string): Promise<boolean>;
  /** Mark the teardown finished. Only ever called by the claimant. */
  markSettled(runId: string, subject: string): Promise<void>;
}

/**
 * THE DEFAULT — the `job_supervision` table, reached through `withSystemContext`
 * exactly as `lib/jobs/engine/step.ts` reaches `job_step`.
 */
export const durableSupervisionStore: SupervisionStore = {
  async open(runId, key, nextPollAt) {
    // Read FIRST, so `created` is a fact rather than an inference. A row that is
    // already here is the overwhelmingly common case — every pass after the
    // first — and it costs one indexed lookup either way.
    const existing = await withSystemContext((tx) =>
      jobSupervisionRepository.findByRunAndSubject(runId, key.subject, tx),
    );
    if (existing) return { ...existing, created: false };

    // ⚠️ ITS OWN TRANSACTION, AND A UNIQUE VIOLATION IS A NORMAL OUTCOME — the
    // same shape the step shim uses, for the same reason. Two passes can
    // legitimately reach the FIRST pass of one supervision at once (a lease
    // reclaim overlapping the previous claimant), and an upsert whose update arm
    // is empty is a find-then-insert rather than one atomic statement, so the
    // loser's insert collides. The winner's row is the one BOTH go on to use —
    // and the catch has to sit OUTSIDE the transaction, because a failed
    // statement aborts the transaction it is in, so reading the winner from
    // inside the same one is not available.
    let created = true;
    try {
      await withSystemContext((tx) =>
        jobSupervisionRepository.open(
          {
            runId,
            subject: key.subject,
            kind: key.kind,
            nextPollAt,
            workspaceId: key.workspaceId,
          },
          tx,
        ),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent pass created it between the read above and this write. It
      // is the creator; this one is not, so it polls rather than deferring —
      // one extra provider read in a race that needs a lease reclaim to happen
      // at all.
      created = false;
    }
    const row = await withSystemContext((tx) =>
      jobSupervisionRepository.findByRunAndSubject(runId, key.subject, tx),
    );
    /* v8 ignore next -- `open` has just written the row (or lost the race to a
       pass that did), so the read cannot miss. The throw is here because the
       repository's type is honestly nullable and a silent `!` would turn a
       future regression into a `TypeError` three lines later. */
    if (!row) throw new Error(`job_supervision row for run ${runId} / ${key.subject} vanished`);
    return { ...row, created };
  },

  async advanceIfUnchanged(runId, subject, expectedPollNumber, observation) {
    await withSystemContext(async (tx) => {
      const locked = await jobSupervisionRepository.findByRunAndSubjectForUpdate(
        runId,
        subject,
        tx,
      );
      if (!locked || locked.pollNumber !== expectedPollNumber || locked.state !== 'watching')
        return;
      await jobSupervisionRepository.advance(runId, subject, observation, tx);
    });
  },

  async claimTerminal(runId, subject) {
    return withSystemContext(async (tx) => {
      const locked = await jobSupervisionRepository.findByRunAndSubjectForUpdate(
        runId,
        subject,
        tx,
      );
      if (!locked || locked.state !== 'watching') return false;
      await jobSupervisionRepository.markState(runId, subject, 'settling', tx);
      return true;
    });
  },

  async markSettled(runId, subject) {
    await withSystemContext((tx) =>
      jobSupervisionRepository.markState(runId, subject, 'settled', tx),
    );
  },
};

/**
 * An in-process store, for a caller that has no `job_queue` row to hang a
 * supervision off.
 *
 * ⚠️ ONE PER RUN-TO-COMPLETION CALL, never a module-level singleton: its whole
 * lifetime is the wrapper loop that created it, and sharing one across calls
 * would make two unrelated supervisions collide on `(runId, subject)`.
 *
 * Its concurrency guarantees are trivially met because there is no concurrency:
 * one wrapper drives one supervision to completion on one call stack. That is
 * not a weaker implementation of the same contract — it is the same contract in
 * a setting where the race it defends against cannot occur.
 */
export function inMemorySupervisionStore(): SupervisionStore {
  const rows = new Map<string, SupervisionRow>();
  const at = (runId: string, subject: string): string => `${runId}\u0000${subject}`;
  return {
    async open(runId, key) {
      const k = at(runId, key.subject);
      const existing = rows.get(k);
      if (existing) return { ...existing, created: false };
      const fresh: SupervisionRow = {
        pollNumber: 0,
        startedAt: null,
        consecutiveReadFailures: 0,
        state: 'watching',
      };
      rows.set(k, fresh);
      return { ...fresh, created: true };
    },
    async advanceIfUnchanged(runId, subject, expectedPollNumber, observation) {
      const row = rows.get(at(runId, subject));
      if (!row || row.pollNumber !== expectedPollNumber || row.state !== 'watching') return;
      rows.set(at(runId, subject), {
        pollNumber: row.pollNumber + 1,
        startedAt: observation.startedAt,
        consecutiveReadFailures: observation.consecutiveReadFailures,
        state: 'watching',
      });
    },
    async claimTerminal(runId, subject) {
      const row = rows.get(at(runId, subject));
      if (!row || row.state !== 'watching') return false;
      rows.set(at(runId, subject), { ...row, state: 'settling' });
      return true;
    },
    async markSettled(runId, subject) {
      const row = rows.get(at(runId, subject));
      if (row) rows.set(at(runId, subject), { ...row, state: 'settled' });
    },
  };
}

/**
 * Give a supervision's run back to the queue AFTER its terminal transition, due
 * at `at` — for work a caller owes on a settled subject that could not finish on
 * this pass (a hosted run's machine charge, MOTIR-6514).
 *
 * The next pass re-enters from the top, finds the row terminal and REPLAYS the
 * settle memo — no poll, no second teardown — so the only thing it repeats is the
 * caller's own unfinished step. It is `deferRun`, named for this folder so a
 * service never imports the engine (`eslint.config`'s `JOB_ENGINE_RESTRICTION`);
 * in-process, `driveSupervisionInProcess` turns it back into a wait.
 */
export function deferSettledSupervision(at: Date, reason: string): never {
  deferRun(at, reason);
}

/**
 * Give a run that is QUEUED FOR ADMISSION back to the queue, due at its next
 * attempt (MOTIR-10600) — the wait between two admission asks spent as a
 * `run_at` instead of an in-process sleep that holds one of the worker's
 * `POOL_SIZE` slots.
 *
 * Nothing is supervised yet and nothing is held: the caller memoizes each ASK,
 * so the next pass replays the refusals already given and asks once more. It is
 * `deferRun`, named for this folder so a service never imports the engine
 * (`eslint.config`'s `JOB_ENGINE_RESTRICTION`); in-process,
 * `driveSupervisionInProcess` turns it back into a wait.
 */
export function deferQueuedAdmission(at: Date, reason: string): never {
  deferRun(at, reason);
}

/** What a pass that SETTLED returns. A pass that suspended throws `JobRunDefer` instead and returns nothing. */
export interface SupervisionSettled<O> {
  status: 'settled';
  reason: SupervisionTerminalReason;
  outcome: O;
  /**
   * True when this pass found the row already `settling` / `settled` — a
   * concurrent pass (a lease reclaim overlapping the previous claimant) got
   * there first. The `settle` hook is still called, because the caller's memo is
   * what makes that free and correct; this flag is how a caller or a test can
   * SEE the race rather than infer it.
   */
  raced: boolean;
  /**
   * THE NUMBER OF THE POLL THIS SUPERVISION ENDED ON (1-based) — the poll that
   * observed the container done, or the one that would have run next when a
   * deadline or the ceiling fired instead (MOTIR-4413).
   *
   * ⚠️ IT IS STABLE ACROSS PASSES, which is the whole reason it is worth
   * returning rather than counting. It is `row.pollNumber + 1` read from
   * `job_supervision`, and a terminal transition ADVANCES NOTHING — `terminate`
   * writes `settling` and then `settled` and never touches the count — so the
   * completing pass and every later replayed pass derive the same number from the
   * same row. A caller may therefore turn it into a duration (its own
   * `waitMs(pollNumber)`, which is pure) and get the same answer on every pass,
   * where a counter kept in memory across a `JobRunDefer` would get zero.
   */
  pollNumber: number;
}

export async function advanceSupervision<V, O>(
  runId: string,
  key: SupervisionKey,
  hooks: SupervisionHooks<V, O>,
): Promise<SupervisionSettled<O>> {
  const now = hooks.now ?? ((): Date => new Date());
  const store = hooks.store ?? durableSupervisionStore;

  // ── 1 · OPEN OR RE-OPEN, AND READ WHAT THE LAST PASS LEFT ─────────────────
  // Re-entering a LIVE supervision does not reset a single observation — the
  // whole reason the row exists, since a defer checkpoints nothing.
  const row = await store.open(runId, key, now());

  const state: SupervisionPollState = {
    pollNumber: row.pollNumber + 1,
    startedAt: row.startedAt,
    consecutiveReadFailures: row.consecutiveReadFailures,
  };

  // ── 2 · ALREADY TERMINAL? REPLAY, AND POLL NOTHING ────────────────────────
  // A fan-out re-enters every already-settled subject on every later pass. A
  // pass that polled a destroyed container to rediscover that would cost one
  // provider read per settled subject per pass — the linearity this whole shape
  // is for. The `settle` hook is the caller's memoized step, so this reads the
  // stored outcome back and touches nothing.
  if (row.state !== 'watching') {
    return {
      status: 'settled',
      reason: 'replayed',
      outcome: await hooks.settle('replayed', state, null),
      raced: true,
      // ⚠️ THE SAME NUMBER THE COMPLETING PASS REPORTED, not a fresh count. The
      // terminal transition advanced nothing, so `row.pollNumber` still holds
      // what the last ADVANCE wrote and this expression reproduces the
      // completing pass's value exactly — which is what lets a caller derive a
      // span here and get the answer it got then (MOTIR-4413).
      pollNumber: state.pollNumber,
    };
  }

  // ── 4 · THE DEADLINE TRANSITION, BEFORE THE POLL ──────────────────────────
  // Checked first so a resumed pass meeting a container that is already past its
  // timeout settles it at once rather than watching it for another N polls —
  // §13.3(a)'s property, which the session-anchored clock is what buys.
  const elapsed = now().getTime() - key.bootedAt.getTime();
  if (elapsed >= hooks.timeoutMs) {
    return terminate(runId, key.subject, 'deadline', state, null, hooks, store);
  }
  if (row.pollNumber >= hooks.maxPolls) {
    return terminate(runId, key.subject, 'poll_ceiling', state, null, hooks, store);
  }

  // ── 5 · THE PASS THAT OPENED IT WAITS, AND POLLS NOTHING ──────────────────
  // Boot, wait, poll 1, wait, poll 2 — the sequence both loops this replaces
  // have, with `await sleep(waitMs(iteration))` as the first statement of the
  // `for` body. A container cannot have started in the instant after
  // `provision` returned, so polling here would be a guaranteed-wasted provider
  // read on every supervision, and the cadence would shift by one interval —
  // which §16.6 forbids.
  //
  // ⚠️ IT SITS AFTER THE TERMINAL CHECKS, NOT BEFORE THEM. On a genuine first
  // pass `elapsed` is a few hundred milliseconds and neither can fire, so the
  // order is unobservable there. It is observable in one state: the row was
  // DELETED while the boot memo survived, so a later pass re-creates it with
  // the session already past its deadline. Deferring first would spend one more
  // interval watching a container that must be torn down; the deadline is
  // unconditional, so it goes first.
  if (row.created) {
    deferRun(
      new Date(now().getTime() + hooks.waitMs(1)),
      `${key.kind} supervision ${key.subject}: booted, first poll pending`,
    );
  }

  // ── 6 · ONE POLL, OUTSIDE EVERY TRANSACTION ───────────────────────────────
  // Outside, for the reason `lib/jobs/engine/worker.ts` gives about the claim: a
  // provider read takes seconds, Prisma cannot nest interactive transactions,
  // and holding one across it would pin a pooled connection for the duration.
  let polled: SupervisionPollResult<V>;
  try {
    polled = await hooks.poll(state);
  } catch (err) {
    // THE THIRD TRANSITION. Settle FIRST, then let the error propagate — a
    // container nothing tears down is the failure every guarantee in the two
    // supervisors exists to prevent, and this is the arm a step reachable only
    // from the loop's two normal exits could never cover (§13.4).
    await terminate(runId, key.subject, 'failed', state, null, hooks, store);
    throw err;
  }

  if (polled.done) {
    return terminate(runId, key.subject, 'completed', state, polled.verdict, hooks, store);
  }

  // ── 7 · ADVANCE AND DEFER ─────────────────────────────────────────────────
  // ⚠️ THE STORE LOCKS AND RE-READS BEFORE THE WRITE. The poll number this pass
  // writes is derived from the one it read, and two workers can legitimately
  // hold one run at once: `reclaimExpiredLeases` hands it to a second while the
  // first is still inside a provider call it has not returned from. Without the
  // lock both read N and both write N+1, so the ceiling silently stops bounding
  // anything. With it, the loser observes the winner's row and declines to
  // advance — its poll was a wasted read, which is the correct price.
  // `waitMs(n)` is the wait BEFORE poll n, so the pass that just performed poll
  // n owes the wait before poll n+1. Getting this off by one would silently
  // re-phase the whole backoff.
  const nextPollAt = new Date(now().getTime() + hooks.waitMs(state.pollNumber + 1));
  await store.advanceIfUnchanged(runId, key.subject, row.pollNumber, {
    startedAt: polled.startedAt,
    consecutiveReadFailures: polled.consecutiveReadFailures,
    nextPollAt,
  });

  // ⚠️ THE TAIL, OUTSIDE EVERY `try` IN THIS FILE. Nothing here can intercept
  // the throw and mistake a suspension for an exit — the invariant in the
  // header, expressed as the shape of the function rather than as a check.
  deferRun(nextPollAt, `${key.kind} supervision ${key.subject}: poll ${state.pollNumber} done`);
}

/**
 * THE TERMINAL TRANSITION — the only place `settle` is called, from the three
 * named entrances above and from nowhere else.
 *
 * It moves the row to `settling` BEFORE the teardown and to `settled` after,
 * which is what stops the abandoned-supervision sweep (MOTIR-3830) entering a
 * teardown a live pass is in the middle of. A pass that finds the row already
 * past `watching` lost that race: it still calls `settle`, because the caller
 * wraps it in a memoized step and the memo is what makes a second call free and
 * correct, and it reports `raced: true` so the fact is observable rather than
 * inferred.
 */
async function terminate<V, O>(
  runId: string,
  subject: string,
  reason: SupervisionTerminalReason,
  state: SupervisionPollState,
  verdict: V | null,
  hooks: SupervisionHooks<V, O>,
  store: SupervisionStore,
): Promise<SupervisionSettled<O>> {
  const won = await store.claimTerminal(runId, subject);
  const outcome = await hooks.settle(reason, state, verdict);
  if (won) await store.markSettled(runId, subject);
  return { status: 'settled', reason, outcome, raced: !won, pollNumber: state.pollNumber };
}
