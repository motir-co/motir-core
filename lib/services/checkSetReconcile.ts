import type { Prisma } from '@/generated/prisma/client';
import { liveRowsAtLatestSha, type PrCheckRunSlice } from '@/lib/github/prCiState';
import { liveCheckRows } from '@/lib/github/checkSuites';
import {
  readCommitActionsSuites,
  readCommitCheckRuns,
  type ReportedCheckRun,
} from '@/lib/github/checkRuns';
import { githubCheckRunRepository } from '@/lib/repositories/githubCheckRunRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';

// THE RECORDED SET IS NOT THE WHOLE SET (MOTIR-4199).
//
// Every verdict Motir forms about a commit — the feedback comment's summary, the
// aggregate `ciState`, and both promotion edges — is a fold over the check rows
// RECORDED at the head sha. None of them knew how many checks the commit HAS, so
// the absence of a pending row was read as "nothing is pending". GitHub delivers
// check runs one webhook at a time, so the recorded set being a PREFIX of the
// real one is not an edge case: it is the ordinary state of every pull request
// for the first minutes of its life. A commit with five jobs whose first three
// successes were processed before the other two were recorded produced
// `✅ CI passing — all 3 checks succeeded … This work is verified` and promoted
// the card to In Review with the repository's whole test suite still running.
//
// ── THE SHAPE OF THE FIX: A FACT, NOT AN ABSENCE ────────────────────────────
// The same shape MOTIR-3823 chose for its own twin of this trap. Terminality is
// ESTABLISHED by asking the host what check runs the commit has, and the answer
// is written into the SAME table every derivation already reads — as ordinary
// rows, with the ordinary conclusions. Nothing downstream learns a new concept:
// a `pending` row at the head sha already makes `summarizeChecks` render
// `⏳ CI running — 3 of 5 checks complete`, already makes `derivePrCiState`
// return `running`, and `running` is already what both promotion edges withhold
// on. The defect was never in how the folds treat what they see; it was that
// they could not see two of the rows.
//
// ── WHEN THE CALL IS PAID ───────────────────────────────────────────────────
// Exactly when the recorded set CLAIMS to be complete — no live pending row at
// the head sha — because that claim is the only thing this module exists to
// check. In the ordinary case, where the host's `created`/`in_progress`
// deliveries arrive before the slow lanes finish, pending rows are already there
// and no call is made at all: a motir-core pull request carrying ~34 checks pays
// for one round trip on the delivery that would otherwise have asserted a
// verdict, not for thirty-four.
//
// ── WHAT IT DOES NOT ESTABLISH ──────────────────────────────────────────────
// It reads the check runs GitHub has CREATED and — since MOTIR-6946 — every
// GitHub Actions WORKFLOW RUN GitHub has created, as its suite's roll-up row. A
// workflow run that has not created a job yet (queued behind a `concurrency`
// group, say) used to be in no check-run snapshot, and this header said it
// "cannot be"; that was false, because its check SUITE exists from the moment the
// run does. The genuine limit is a workflow that has not been TRIGGERED at all,
// which no read of the provider can see. And a host that cannot be
// reached answers `null`, which is NOT "no checks": the caller then falls back
// to the recorded set, i.e. to the behaviour that shipped before this module, so
// a transient GitHub outage costs the sharper verdict rather than stalling every
// card behind it for ever. `docs/decisions/ci-verdict-expected-check-set.md`
// records both, with the alternative that was measured against them.

/**
 * The commit at which the recorded set ASSERTS that it is the whole set — or
 * `null` when it asserts nothing.
 *
 * A set claims completeness when there is at least one live row at the latest
 * recorded sha and none of them is `pending`, which is precisely the state in
 * which the comment writes a terminal verdict and the promotion fires. A set
 * with a pending row is already interim and already withholding; an empty set
 * claims nothing at all.
 *
 * ⚠️ IT RETURNS THE SHA RATHER THAN A BOOLEAN, and that is not a convenience.
 * A caller needs both answers — *should I ask the host?* and *about which
 * commit?* — and deriving the second separately means a second `null` arm the
 * first has already ruled out: `liveRowsAtLatestSha` is non-empty exactly when
 * the claim holds, so a companion `latestRecordedSha` helper is a branch that
 * cannot be taken and cannot be tested. One function answers both, over the SAME
 * window the verdict is formed at.
 */
export function claimedCompleteSha(checkRuns: PrCheckRunSlice[]): string | null {
  const atHead = liveRowsAtLatestSha(checkRuns);
  if (atHead.length === 0) return null;
  return atHead.every((row) => row.conclusion !== 'pending') ? atHead[0]!.commitSha : null;
}

/** A check row with the clock this module ages it by. `updatedAt` rather than
 *  `createdAt`: a row is written `pending` and REWRITTEN terminal by the
 *  delivery that settles it, so the question *when did this row last hear
 *  anything?* is the one that separates a check still running from a check
 *  whose completion was lost. */
export interface AgedCheckRunSlice extends PrCheckRunSlice {
  updatedAt: Date;
}

/**
 * How long a `pending` row may sit at the head before the recorded set stops
 * being believed and the host is asked (MOTIR-5838).
 *
 * Deliberately the same TEN MINUTES as
 * `PULL_REQUEST_RECONCILE_QUIET_MINUTES`, and deliberately its OWN constant.
 * The two measure different clocks — that one is *nothing has been heard about
 * this pull request row*, this one is *this check row has claimed to be running*
 * — and the number agreeing today is a judgement about how long a real check
 * plausibly runs, not a fact either module may read off the other. A
 * motir-core pull request's slowest lane finishes well inside it.
 */
export const STALE_PENDING_MINUTES = 10;
export const STALE_PENDING_MS = STALE_PENDING_MINUTES * 60_000;

/**
 * The commit whose recorded set claims to be STILL RUNNING and has claimed it
 * for longer than is plausible — or `null` when it makes no such claim
 * (MOTIR-5838).
 *
 * ⚠️ THIS IS `claimedCompleteSha`'s MIRROR, AND THE PAIR IS THE WHOLE POINT.
 * That one distrusts a set asserting *I am whole*; MOTIR-4199 built it and left
 * the set asserting *I am incomplete* trusted absolutely. But `running` is
 * exactly what a LOST completion produces: `derivePrCiState` folds any live
 * `pending` row to `running`, so a webhook that never arrived is
 * indistinguishable, for ever, from a lane that is genuinely still going. The
 * asymmetry was the defect — a green, mergeable pull request held at
 * `ci: running` with no promotion, no approve-to-merge gate, and nothing on the
 * card saying why.
 *
 * ⚠️ AND THE CLAIM TO DISTRUST IS AGE, NOT SHAPE. A fresh pending row is the
 * ordinary state of every pull request for its first minutes and is believed
 * without a call — which is what keeps MOTIR-4199's no-cost property: a set the
 * host has not had time to settle costs nothing here, exactly as before.
 */
export function stalePendingSha(
  checkRuns: AgedCheckRunSlice[],
  now: Date,
  staleAfterMs: number = STALE_PENDING_MS,
): string | null {
  const atHead = liveRowsAtLatestSha(checkRuns);
  if (atHead.length === 0) return null;
  const cutoff = now.getTime() - staleAfterMs;
  const stale = atHead.some(
    (row) => row.conclusion === 'pending' && row.updatedAt.getTime() <= cutoff,
  );
  return stale ? atHead[0]!.commitSha : null;
}

/**
 * The commit this pull request's recorded set should be RE-READ at, by either
 * reason — or `null` when it should not be.
 *
 * One function so a caller states the question once and cannot ask the two
 * halves in an order that lets a set qualify under neither: a set is either
 * claiming completeness it has not earned, or claiming an incompleteness it has
 * held too long, and both are answered by the same host read at the same sha.
 */
export function shaToReReadFromHost(
  checkRuns: AgedCheckRunSlice[],
  now: Date,
  staleAfterMs: number = STALE_PENDING_MS,
): string | null {
  return claimedCompleteSha(checkRuns) ?? stalePendingSha(checkRuns, now, staleAfterMs);
}

/** The same question asked about ONE known sha rather than the latest recorded
 *  one — what the CI-feedback consumer has, since a delivery names its commit. */
export function shaSetClaimsComplete(
  rows: { checkName: string; checkSuiteId: string; conclusion: string }[],
): boolean {
  const live = liveCheckRows(rows);
  return live.length > 0 && live.every((row) => row.conclusion !== 'pending');
}

/**
 * Read every check run the host holds for one commit — the provider half, split
 * out so the callers depend on a function rather than on `fetch`.
 *
 * Returns `null` when the set could not be established; see the module header
 * for why that is not the same answer as an empty array.
 */
export async function readReportedCheckSet(args: {
  installationId: string;
  owner: string;
  name: string;
  commitSha: string;
}): Promise<ReportedCheckRun[] | null> {
  const runs = await readReportedCheckRuns(args);
  if (runs === null) return null;
  // ⚠️ THE WORKFLOW RUNS NO JOB HAS REPORTED FOR YET (MOTIR-6946). A second
  // round trip, paid on the same claim-complete edge as the first. When THIS read
  // has no answer the check runs alone are returned — exactly the set that
  // shipped before it — rather than `null`, which would throw away an answer the
  // first read did get.
  const suites = await readCommitActionsSuites(
    args.installationId,
    args.owner,
    args.name,
    args.commitSha,
  );
  return suites === null ? runs : [...runs, ...suites];
}

/** The commit's CHECK RUNS alone — for a reader that wants checks and never a
 *  suite's roll-up (the merge-queue exit naming its failing check). */
export async function readReportedCheckRuns(args: {
  installationId: string;
  owner: string;
  name: string;
  commitSha: string;
}): Promise<ReportedCheckRun[] | null> {
  return readCommitCheckRuns(args.installationId, args.owner, args.name, args.commitSha);
}

/**
 * Write a row for every reported check the recorded set is missing.
 *
 * ⚠️ IT ONLY EVER CREATES (`createMissing`). The snapshot was taken outside this
 * transaction, so a delivery about one of these checks may have landed in
 * between; the unique key is the arbiter, and a row that already exists wins
 * whatever the snapshot believed about it. That is what lets the reconcile run
 * without a lock of its own, and it is why a `pending` conclusion written here
 * can never overwrite a terminal one written by a delivery.
 *
 * ⚠️ AND IT WRITES THE HOST'S OWN CONCLUSION, not `pending` for everything it
 * did not have. The two transports describe the same checks, so a run the
 * snapshot reports as completed is recorded as completed — which makes the
 * reconcile SELF-HEALING for a webhook delivery that was dropped, instead of
 * leaving a card held at Implemented for ever behind a row nothing will refresh.
 * The webhook's own later delivery upserts the identical value and is a no-op.
 *
 * ⚠️ AND SINCE MOTIR-5838 IT ALSO SETTLES A ROW THAT IS RECORDED `pending` AND
 * THAT THE HOST REPORTS COMPLETE — the case creating-only structurally cannot
 * reach, because such a row is not missing. A lost completion leaves exactly
 * this shape: the row exists, it says `pending`, and nothing will ever refresh
 * it, so `derivePrCiState` folds the pull request to `running` for ever.
 *
 * That write is SAFE IN THE ONE DIRECTION IT MOVES, which is why it does not
 * need the lock `createMissing` avoids. `pending` is the only non-terminal
 * conclusion, so `pending → terminal` can lose no information; the update is
 * guarded on the row still READING `pending` in its own statement, so a
 * delivery that settled it between the snapshot and the write wins exactly as
 * it does above; and a host still reporting the check pending writes nothing at
 * all. A terminal row is never overwritten by this path in any case — which
 * keeps `createMissing`'s stated safety property intact rather than trading it.
 *
 * ⚠️ AND IT RECORDS A HEAD WHOSE WHOLE SET CI DECIDED (Bug MOTIR-10797). This is the one
 * moment Motir knows whether a set of terminal rows is the WHOLE set: when the host reports
 * every check run and workflow run at the commit finished, and nothing recorded there is
 * still running once the writes above have landed, CI has decided the commit, and the pull
 * request's row says so (`githubPullRequestRepository.markCiDecided`, only while the commit
 * is its head). The rows themselves cannot carry that: a quick green recorded before anything
 * running is a set of terminal rows too. The To fix rebuild reads the marker, so a check that
 * starts later at that head answers the head's own verdict rather than an older commit's.
 *
 * Returns how many rows it created and how many it settled — both zero meaning
 * the recorded set was already whole and current, the answer in the healthy case — and
 * whether it confirmed the commit decided.
 */
export async function reconcileRecordedCheckSet(args: {
  pullRequestId: string;
  commitSha: string;
  reported: ReportedCheckRun[];
  recorded: { checkName: string; checkSuiteId: string; conclusion: string }[];
  tx: Prisma.TransactionClient;
}): Promise<{ created: number; settled: number; decided: boolean }> {
  const recordedByIdentity = new Map(
    args.recorded.map((row) => [identity(row.checkName, row.checkSuiteId), row]),
  );

  // ⚠️ A SUITE ROLL-UP IS CREATED ONLY WHILE IT IS PENDING (MOTIR-6946). Its
  // whole job is to make a workflow run that has no check yet VISIBLE, and a
  // finished suite is already recorded by its own `check_suite` delivery; creating
  // a terminal one here would make this read a second writer of a verdict the
  // webhook owns. A finished one still SETTLES the pending row this created —
  // the lost-completion arm below — which is why the reader reports it at all.
  const missing = args.reported.filter(
    (run) =>
      !recordedByIdentity.has(identity(run.checkName, run.checkSuiteId)) &&
      (run.suiteAggregate !== true || run.conclusion === 'pending'),
  );
  const created = await githubCheckRunRepository.createMissing(
    missing.map((run) => ({
      pullRequestId: args.pullRequestId,
      commitSha: args.commitSha,
      checkName: run.checkName,
      checkSuiteId: run.checkSuiteId,
      ...(run.suiteAggregate === true ? { suiteAggregate: true } : {}),
      conclusion: run.conclusion,
      // A finished run's own finish time, so a late pending delivery about it is
      // ordered against the row this writes exactly as against a webhook's (MOTIR-10456).
      conclusionAt: run.conclusion === 'pending' ? null : run.completedAt,
    })),
    args.tx,
  );

  // A row we hold as `pending` that the host says has finished. The host's own
  // conclusion is written, exactly as for a created row: the two transports
  // describe the same check, so a settle here is indistinguishable from the
  // delivery that was lost.
  const lostCompletions = args.reported.filter((run) => {
    if (run.conclusion === 'pending') return false;
    const row = recordedByIdentity.get(identity(run.checkName, run.checkSuiteId));
    return row !== undefined && row.conclusion === 'pending';
  });
  const settled = await githubCheckRunRepository.settlePending(
    lostCompletions.map((run) => ({
      pullRequestId: args.pullRequestId,
      commitSha: args.commitSha,
      checkName: run.checkName,
      checkSuiteId: run.checkSuiteId,
      conclusion: run.conclusion,
      conclusionAt: run.completedAt,
    })),
    args.tx,
  );

  // Decided only when the host has nothing running AND the recorded set agrees once the
  // writes above landed: a commit status (the legacy API, which this read does not cover)
  // or a row a delivery reopened since the snapshot can still be pending there.
  let decided = false;
  if (hostReportsDecided(args.reported)) {
    const recorded = await githubCheckRunRepository.listByPrAndSha(
      args.pullRequestId,
      args.commitSha,
      args.tx,
    );
    if (shaSetClaimsComplete(recorded)) {
      await githubPullRequestRepository.markCiDecided(args.pullRequestId, args.commitSha, args.tx);
      decided = true;
    }
  }

  return { created, settled, decided };
}

/**
 * Whether the host's answer about a commit says CI has DECIDED there (Bug MOTIR-10797): it
 * reports at least one check, and none of its check runs or workflow runs is still pending.
 * An empty answer is not a verdict — a commit no CI has reached yet reads the same.
 *
 * ⚠️ IT TRUSTS THE ANSWER IT IS GIVEN. When the workflow-run read failed,
 * `readReportedCheckSet` returns the check runs alone, and a workflow queued without a job
 * is then invisible; a marker written on that answer drops the Fixing tag for that push, the
 * conservative side — the behaviour before this marker existed.
 */
export function hostReportsDecided(reported: readonly { conclusion: string }[]): boolean {
  return reported.length > 0 && reported.every((run) => run.conclusion !== 'pending');
}

/** The ingestion key's own identity, minus the two members that are fixed for
 *  one `(pull request, commit)` — kept here so the reconcile cannot drift from
 *  the unique index it is filling in. */
function identity(checkName: string, checkSuiteId: string): string {
  return `${checkSuiteId} ${checkName}`;
}
