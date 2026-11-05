import { type GithubCheckRun, type Prisma } from '@/generated/prisma/client';

// GitHub check-run repository — single Prisma operations on the
// `github_check_run` table (Story 7.10 · Subtask 7.10.6 / MOTIR-894). One row per
// terminal CI check of a linked PR, keyed on the unique
// `(pull_request_id, commit_sha, check_name, check_suite_id)` — the INGESTION
// idempotency key: a redelivery of the same check of the same RUN at the same
// head commit converges on this row rather than recording a second one.
//
// ⚠️ THE SUITE IS IN THE KEY, AND THAT IS THE POINT (MOTIR-3209). It used to be
// `(pull_request_id, commit_sha, check_name)`, which reads a check's NAME as its
// identity. `cancel-in-progress` (MOTIR-3106) makes two workflow runs at one
// commit ordinary, the two runs do not use the same names — a matrix job
// cancelled before expansion reports the literal `${{ matrix.* }}` template —
// and so the cancelled run's rows outlived the run that replaced them wherever
// the names differ. Merging them was never idempotency; it was two runs written
// into one. Which rows still get a VOTE is `lib/github/checkSuites.ts`.
//
// ⚠️ THE FEEDBACK COMMENT'S IDENTITY IS NOT HERE ANY MORE, AND NEITHER IS ITS
// COLUMN (MOTIR-3770 → MOTIR-3863 → MOTIR-3803). It was `feedback_comment_id`, a scalar on a
// table whose grain is one row PER CHECK: never keyed at this grain (MOTIR-2946
// made every row at one `(pull_request_id, commit_sha)` point at the same
// comment), and unable to name more than one card however many a pull request
// delivers. `github_ci_feedback_comment` supersedes it, keyed on
// `(pull request, head commit, work item)` — read THAT.
//
// The COLUMN IS GONE. It was retired over the three phases
// `docs/decisions/delivery-reader-migration.md` §6a specifies: MOTIR-3863
// `@ignore`d the field so the generated client stopped selecting it — including
// through the bare relation includes nobody can grep for — MOTIR-3864 verified
// that build had reached every machine, and MOTIR-3803 then dropped the column
// and its FK. Doing the last two in one release is MOTIR-3852, an outage.

export interface UpsertGithubCheckRunInput {
  pullRequestId: string;
  commitSha: string;
  checkName: string;
  /** The CI run — `''` where the provider reports none. Never null: Postgres
   *  treats NULLs in a unique index as distinct, so a nullable member would
   *  stop the upsert converging (see the schema's note). */
  checkSuiteId: string;
  /** A suite's own roll-up row, not a check (MOTIR-6274) — see the schema's
   *  note. Omitted = a check, which is every row but a GitHub `check_suite`'s. */
  suiteAggregate?: boolean;
  conclusion: string;
  /** The provider's time for `conclusion` — a pending check's start, a terminal
   *  one's finish (MOTIR-10456). Omitted / null = unknown; see the schema's note. */
  conclusionAt?: Date | null;
}

export const githubCheckRunRepository = {
  /** One check row by its `(pullRequest, commitSha, checkName, checkSuiteId)`
   *  identity, or null. */
  async findByKey(
    pullRequestId: string,
    commitSha: string,
    checkName: string,
    checkSuiteId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCheckRun | null> {
    return tx.githubCheckRun.findUnique({
      where: {
        pullRequestId_commitSha_checkName_checkSuiteId: {
          pullRequestId,
          commitSha,
          checkName,
          checkSuiteId,
        },
      },
    });
  },

  /** Every check row recorded for a PR at one head commit — EVERY run's,
   *  including a superseded one's. The verdict is derived from the surviving
   *  subset (`liveCheckRows`), and the caller needs the whole set to derive it.
   *  Ordered oldest-first so the answer is deterministic. */
  async listByPrAndSha(
    pullRequestId: string,
    commitSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCheckRun[]> {
    return tx.githubCheckRun.findMany({
      where: { pullRequestId, commitSha },
      orderBy: [{ createdAt: 'asc' }, { checkName: 'asc' }],
    });
  },

  /**
   * Record rows for checks the host reports and we have NOT recorded — and only
   * those (MOTIR-4199).
   *
   * ⚠️ IT CREATES, IT NEVER UPDATES, AND THAT IS THE WHOLE OF ITS SAFETY.
   * `upsert` above refreshes a row's conclusion, which is right for a delivery
   * about that check and wrong for a reconcile: the reconcile's snapshot was
   * taken before the write, so a delivery that landed in between would be
   * overwritten by a staler answer read from a different transport. `createMany`
   * with `skipDuplicates` makes the unique key itself the arbiter — a row that
   * exists wins, whatever this call believed about it — so the reconcile can run
   * with no lock of its own.
   *
   * Returns how many rows it actually created, which is what a caller reports:
   * zero means the recorded set was already whole.
   */
  async createMissing(
    inputs: UpsertGithubCheckRunInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (inputs.length === 0) return 0;
    const { count } = await tx.githubCheckRun.createMany({ data: inputs, skipDuplicates: true });
    return count;
  },

  /**
   * Settle rows we hold as `pending` that the host reports COMPLETE — the lost
   * completion (MOTIR-5838).
   *
   * ⚠️ IT UPDATES, WHICH `createMissing` REFUSES TO DO — and the guard is what
   * makes that safe rather than a reversal of its rule. `conclusion: 'pending'`
   * is in the WHERE, so the arbiter is still the row's own current value read
   * in this statement rather than the snapshot's belief about it: a delivery
   * that settled the check between the read and this write leaves a terminal
   * conclusion, this matches nothing, and the staler answer is discarded. It
   * can only ever move a row `pending → terminal`, and `pending` is the only
   * non-terminal conclusion there is, so no information can be lost in that
   * direction.
   *
   * Returns how many rows it actually settled — zero being the healthy answer,
   * and a non-zero one meaning a check-completion delivery was lost.
   */
  async settlePending(
    inputs: UpsertGithubCheckRunInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    let settled = 0;
    for (const input of inputs) {
      const { count } = await tx.githubCheckRun.updateMany({
        where: {
          pullRequestId: input.pullRequestId,
          commitSha: input.commitSha,
          checkName: input.checkName,
          checkSuiteId: input.checkSuiteId,
          conclusion: 'pending',
        },
        // The host's finish time, which a late pending delivery is ordered against.
        data: { conclusion: input.conclusion, conclusionAt: input.conclusionAt },
      });
      settled += count;
    }
    return settled;
  },

  /**
   * Move an EXISTING row to `pending` — unless it already holds a terminal
   * conclusion this pending state predates (MOTIR-10456).
   *
   * ⚠️ `upsert` IS WRONG FOR THIS, AND THAT WAS THE DEFECT. It refreshes the
   * conclusion unconditionally, so a `pending` delivery processed after the same
   * check's terminal one — GitHub never promised order, and the webhook inbox
   * re-runs a lost or failed delivery minutes to hours late — turned `success` /
   * `failure` back into `pending`, and the card read `running` until the
   * reconcile tick settled it again. Like `settlePending`, the arbiter is the
   * row's own current value read IN THIS STATEMENT, never a snapshot of it:
   *
   * - a row still `pending` is refreshed (a redelivery converges, as before);
   * - a terminal row is reopened only by a pending state that STARTED AFTER the
   *   terminal one finished (`conclusion_at < occurredAt`) — a RE-RUN of the check
   *   under the same name and suite, which must read running while it runs;
   * - a row with no recorded time cannot be ordered and is refreshed, which is
   *   the behaviour every row had before the column existed;
   * - and a pending event with no time of its own is written unguarded for the
   *   same reason — refusing it would hide a genuine re-run, which nothing heals,
   *   whereas a wrongly-reopened row is settled again by the reconcile.
   *
   * It never creates — `createMissing` does, and the caller tries that first.
   * Returns how many rows it moved: zero on an existing row means the delivery
   * was STALE and nothing changed.
   */
  async reopenAsPending(
    input: UpsertGithubCheckRunInput & { conclusion: 'pending' },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const occurredAt = input.conclusionAt ?? null;
    const { count } = await tx.githubCheckRun.updateMany({
      where: {
        pullRequestId: input.pullRequestId,
        commitSha: input.commitSha,
        checkName: input.checkName,
        checkSuiteId: input.checkSuiteId,
        ...(occurredAt === null
          ? {}
          : {
              OR: [
                { conclusion: 'pending' },
                { conclusionAt: null },
                { conclusionAt: { lt: occurredAt } },
              ],
            }),
      },
      data: {
        conclusion: 'pending',
        conclusionAt: occurredAt,
        suiteAggregate: input.suiteAggregate === true,
      },
    });
    return count;
  },

  /** Create-or-refresh a check row, keyed on the unique
   *  `(pull_request_id, commit_sha, check_name, check_suite_id)`. Refreshes
   *  `conclusion` so a REDELIVERY of one run's check converges on one row —
   *  while a DIFFERENT run's check of the same name gets its own row, which is
   *  what lets the derivation retire the loser. */
  async upsert(
    input: UpsertGithubCheckRunInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubCheckRun> {
    const { pullRequestId, commitSha, checkName, checkSuiteId, ...rest } = input;
    return tx.githubCheckRun.upsert({
      where: {
        pullRequestId_commitSha_checkName_checkSuiteId: {
          pullRequestId,
          commitSha,
          checkName,
          checkSuiteId,
        },
      },
      create: { pullRequestId, commitSha, checkName, checkSuiteId, ...rest },
      update: rest,
    });
  },
};
