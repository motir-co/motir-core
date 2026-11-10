import { planRepository } from '@/lib/repositories/planRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE STALLED-APPROVAL SWEEP (Bug MOTIR-9006) — the recovery half of the `approving`
// claim, run by the planning-lock sweep every 5 minutes.
//
// An approve CLAIMS its plan (`planned` → `approving`) in a short transaction of its own,
// so every reader sees the approval while the long materialize transaction runs, and it
// gives the claim back itself when that transaction fails (`plansService.approveFailure`).
// What neither covers is an approver that is GONE: a process that died between the claim
// and the commit, a redeploy mid-approve. Its materialize transaction rolled back with the
// connection, so nothing was written — but the committed claim stays, and without this the
// plan would read *Approving…* for ever with every verb refused. Nothing else can tell;
// the only signal left is the passage of time, which `approvingAt` records.
//
// ⚠️ IMPORTS NO SERVICE. It reads and writes one table through its repository, so it can
// sit in the job registry without pulling `plansService`'s import graph behind it.
//
// CROSS-TENANT discovery, PER-TENANT release, exactly like the lapsed-revision pass beside
// it: the read runs under the system context and each release binds the plan's own
// workspace. The release is guarded on the claim's TOKEN (`approvingAt`), so a plan that
// committed in the meantime — or a claim a later approver took — is left alone.

/**
 * How old a claim must be before it is given back. The claim's materialize transaction
 * can run for at most `APPROVE_TX_BUDGET`'s wait plus its timeout (10s + 30s), so a claim
 * five minutes old has no live approver behind it. Generous on purpose: a live approval
 * released early would only be refused by its own token check, but it would read
 * `planned` to everybody while it ran.
 */
export const STALLED_APPROVAL_AFTER_MS = 5 * 60_000;

/** Claims given back per pass; a backlog drains over several passes. */
export const STALLED_APPROVAL_BATCH_SIZE = 200;

/** Give back every `approving` claim older than {@link STALLED_APPROVAL_AFTER_MS}. */
export async function releaseStalledApprovals(
  now: Date = new Date(),
  batchSize: number = STALLED_APPROVAL_BATCH_SIZE,
): Promise<{ released: number; planIds: string[] }> {
  const claimedBefore = new Date(now.getTime() - STALLED_APPROVAL_AFTER_MS);
  const candidates = await withSystemContext((tx) =>
    planRepository.listStalledApprovals(claimedBefore, batchSize, tx),
  );
  const planIds: string[] = [];
  for (const plan of candidates) {
    // The discovery read filters on `approvingAt < claimedBefore`, so it is never null.
    const claimedAt = plan.approvingAt as Date;
    try {
      const released = await withWorkspaceServiceContext(plan.workspaceId, (tx) =>
        planRepository.releaseApprovingClaim(plan.id, claimedAt, tx),
      );
      if (released === 1) planIds.push(plan.id);
    } catch (err) {
      console.warn(
        `[stalledPlanApproval] giving back the approval claim of plan ${plan.id} failed`,
        err,
      );
    }
  }
  return { released: planIds.length, planIds };
}

export const stalledPlanApprovalService = { releaseStalledApprovals };
