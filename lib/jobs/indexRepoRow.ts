import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import type { JobContext } from './defineJob';

// THE INDEX JOB'S REPOSITORY-ROW WRITES (MOTIR-12035) — moved verbatim out of
// `indexFleetSteps.ts`, because the index handoff (`indexHandoffSteps.ts`,
// MOTIR-11883) shares them and they outlive the container fleet. Each still
// never throws and still runs under `withSystemContext`.

/** The two jobs that drive {@link runIndexFleetSteps}. */
export type IndexFleetJobId = 'system.code-graph-index' | 'system.code-graph-refresh';

/**
 * Stamp the repository as indexing and read the head it is being indexed AT
 * (MOTIR-4724). Returns that head, or null when it is not known — a repository
 * nobody has pushed to since the column landed has none, and null is what stops
 * the settle below inventing a comparand.
 *
 * ⚠️ NEVER THROWS. It runs under `withSystemContext` for the reason every other
 * job-runtime read here does — no workspace is bound — and swallows its own
 * failure, because an index that ran is a fact and this is a note about it.
 */
export async function claimIndexingRepo(
  ctx: JobContext,
  repoRef: string,
  organizationId: string,
  ledger: { functionId: IndexFleetJobId; eventId: string },
): Promise<string | null> {
  try {
    return await withSystemContext(async (tx) => {
      const [owner, name] = repoRef.split('/');
      if (!owner || !name) return null;
      const repo = await tx.githubRepo.findFirst({
        where: { owner, name, organizationId },
        select: { defaultBranchHeadSha: true },
      });
      // ⚠️ THE CLAIM NAMES THE LEDGER ROW, NOT THE QUEUE ROW (Bug MOTIR-9454).
      // Every reader joins `indexing_run_id` to `job_run` ids — the running set
      // says `indexing`, the terminal set says `failed`. `ctx.runId` is the
      // `job_queue` row id on this engine, which is in neither set, so a claim
      // stamped from it read `queued` while the index ran and after it failed.
      // The ledger row is found the way the terminal-failure path finds it: by
      // `(functionId, eventId)`, and `dispatchId` IS the ledger's `eventId`
      // (`ledgerIdentity`). No row — `recordStart` returns none for a tenant that
      // vanished — keeps the queue id, so the repository still reads claimed.
      const ledgerRunId = await jobRunRepository.findUnsettledIdByEventId(
        ledger.eventId,
        ledger.functionId,
        tx,
      );
      await githubRepoRepository.markIndexStarted(
        repoRef,
        organizationId,
        ledgerRunId ?? ctx.runId,
        tx,
      );
      return repo?.defaultBranchHeadSha ?? null;
    });
  } catch (err) {
    console.error('[index-fleet] could not claim the indexing repo', repoRef, err);
    return null;
  }
}

/** Release the claim, recording what was indexed when there is something to
 *  record. A run with no known head clears the claim and writes no sha — the row
 *  keeps its last real answer rather than gaining a false one. */
export async function settleIndexingRepo(
  repoRef: string,
  organizationId: string,
  headAtStart: string | null,
): Promise<void> {
  try {
    await withSystemContext((tx) =>
      githubRepoRepository.markIndexSettled(repoRef, organizationId, { headSha: headAtStart }, tx),
    );
  } catch (err) {
    console.error('[index-fleet] could not settle the indexing repo', repoRef, err);
  }
  // This is only reached on the INDEXED path, so a repository brought back under
  // the supported maximum shows its normal status after this run (MOTIR-7130).
  await clearRefusal(repoRef);
}

/** Record a hard-stop pause on the repository (MOTIR-4593). Never throws: the
 *  run's own `indexed: false` verdict still carries the reason if this write
 *  fails. */
export async function pauseIndexingRepo(
  repoRef: string,
  organizationId: string,
  reason: string,
): Promise<void> {
  try {
    await withSystemContext((tx) =>
      githubRepoRepository.markIndexPaused(repoRef, organizationId, { reason }, tx),
    );
  } catch (err) {
    console.error('[index-fleet] could not record the index pause', repoRef, err);
  }
}

/** Lift a recorded pause once the allowance lets a dispatch boot (MOTIR-4593).
 *  Never throws. */
export async function liftIndexingPause(repoRef: string): Promise<void> {
  try {
    await withSystemContext((tx) => githubRepoRepository.clearIndexPause(repoRef, tx));
  } catch (err) {
    console.error('[index-fleet] could not lift the index pause', repoRef, err);
  }
}

/** Clear a recorded size refusal once a run has actually indexed (MOTIR-7130).
 *  Never throws. Only a run that indexed clears it: a run that failed for any
 *  other reason has not shown the graph got smaller. */
async function clearRefusal(repoRef: string): Promise<void> {
  try {
    await withSystemContext((tx) => githubRepoRepository.clearIndexRefusal(repoRef, tx));
  } catch (err) {
    console.error('[index-fleet] could not clear the size refusal', repoRef, err);
  }
}
