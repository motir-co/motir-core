import { getGitProvider } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
import { checkRowsAtHead } from '@/lib/github/pullRequestHead';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { promoteIfCiAlreadyGreen } from './ciPromotion';
import { readReportedCheckSet, reReadCheckSetFromHost } from './checkSetReconcile';
import { pullRequestMergeabilityService } from './pullRequestMergeabilityService';

// A CHANGED DELIVERY SET IS AN OCCASION TO PROMOTE (MOTIR-12094).
//
// CI green is one trigger of the promotion (`ciPromotion`'s edge 1). The other is the
// delivery set itself changing: a pull request that is ALREADY green being linked to a
// card, or the last red member being unlinked from one. No CI event follows either —
// the verdict predates the change — and the link door used to settle the set (withdraw
// the old question, recompute the card's `ciState`) and then promote only by accident:
// through the link-time resync's `in_progress → implemented` hop, when that resync ran
// at all. A card at `implemented` (the resync is a no-op), a link that CREATED the pull
// request's row (no resync), a row of unknown draft-ness (the resync declines) all
// waited 10 to 15 minutes for the reconcile sweep.
//
// So every link and unlink door hands the cards whose set it changed to
// {@link promoteAfterDeliverySetChange} after its transaction commits. It adds an
// OCCASION, never a rule: the body is `promoteIfCiAlreadyGreen`, the same latch with the
// same `isPromotable` and the same gate raise every other trigger uses.
//
// ⚠️ A ROW THE LATCH CANNOT READ IS ASKED ABOUT FIRST. The row a link creates is a
// placeholder: it knows neither its head nor whether it is a draft (MOTIR-5002). And a
// pull request no card delivered has no check rows — its check deliveries had no card
// to settle — so its green verdict is invisible to the latch. Either way the latch
// would withhold until some later delivery arrived, for ever when none does.
// `hydrateFromHost` asks the host once, as the reconcile tick would: the head and
// mergeability (`settleReading`) and the draft flag (filled only while the row does not
// know it) when they are missing, then the check set at that head when none is stored.
//
// ⚠️ BEST-EFFORT, AFTER COMMIT. The link is the durable fact. Nothing here can fail it:
// every failure is logged and the reconcile sweep stays the backstop.

/** What a host read of the check set is — injectable, as `promoteIfCiAlreadyGreen`'s. */
type ReadCheckSet = typeof readReportedCheckSet;

/**
 * After a link or unlink committed: bring a placeholder pull-request row up to date from
 * the host (when `pullRequestId` names one), then run the green latch for every card whose
 * delivery set changed. Answers the ids it promoted; never throws.
 */
export async function promoteAfterDeliverySetChange(
  args: {
    workItemIds: readonly string[];
    /** The pull request the door linked — hydrated from the host when no delivery has
     *  spoken for it. Omitted by an unlink, which removes a row rather than adding one. */
    pullRequestId?: string;
  },
  ctx: ServiceContext,
  readCheckSet: ReadCheckSet = readReportedCheckSet,
): Promise<string[]> {
  if (args.pullRequestId) await hydrateFromHost(args.pullRequestId, ctx.workspaceId, readCheckSet);
  const promoted: string[] = [];
  for (const id of new Set(args.workItemIds)) {
    try {
      if (await promoteIfCiAlreadyGreen(id, ctx, readCheckSet)) promoted.push(id);
    } catch (err) {
      console.warn('[linkPromotion] could not promote after a delivery-set change', {
        workItemId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return promoted;
}

/**
 * Does this row owe the host a question before the latch can read it? An open row that
 * does not know its head or its draft flag — what `linkPullRequestByCoordinates` writes
 * when the link is first — or one with no check rows at its head: the host's checks on
 * a pull request no card delivered were never recorded, so a green verdict that predates
 * the link is invisible until it is read.
 */
function needsHostRead(pr: {
  state: string;
  merged: boolean;
  draft: boolean | null;
  headSha: string | null;
  checkRuns: Parameters<typeof checkRowsAtHead>[0]['checkRuns'];
}): boolean {
  if (pr.state !== 'open' || pr.merged) return false;
  if (pr.draft === null || pr.headSha === null) return true;
  return checkRowsAtHead({ headSha: pr.headSha, checkRuns: pr.checkRuns }).length === 0;
}

/**
 * Ask the host about ONE linked row and record what it says: head and mergeability and
 * the draft flag when the row does not know them, then the check set at that head when
 * none is recorded there. Every write is one the reconcile tick already makes from the
 * same answers; a host that cannot be reached leaves the row exactly as it was.
 */
async function hydrateFromHost(
  pullRequestId: string,
  workspaceId: string,
  readCheckSet: ReadCheckSet,
): Promise<void> {
  try {
    const pr = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      return githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
    });
    if (!pr || !needsHostRead(pr)) return;
    // A provider with no merge path has nothing to read here (GitLab), and its rows
    // keep waiting on their deliveries, as before.
    if (!getGitProvider(pr.repo.provider as GitProviderId).readChangeRequestMergeability) return;

    let headSha = pr.headSha;
    if (pr.draft === null || headSha === null) {
      const reading = await pullRequestMergeabilityService.readFromHost(pullRequestId);
      if (!reading) return;
      // Head first, through the door every host read uses: a computed reading is stored
      // at that head (a conflict withdraws, as anywhere), an uncomputed one stores the head.
      await pullRequestMergeabilityService.settleReading(workspaceId, pullRequestId, reading);
      const { draft } = reading;
      if (typeof draft === 'boolean') {
        await withSystemContext(async (tx) => {
          await bindWorkspaceContext(tx, workspaceId);
          await githubPullRequestRepository.setDraftIfUnknown(pullRequestId, draft, tx);
        });
      }
      headSha = reading.headSha;
    }
    // An uncomputed reading still names a head; only a reading with NO head leaves the
    // check set unaddressable.
    if (!headSha) return;
    if (checkRowsAtHead({ headSha, checkRuns: pr.checkRuns }).length > 0) return;
    await reReadCheckSetFromHost(
      {
        pullRequestId,
        commitSha: headSha,
        installationId: pr.repo.installation.installationId,
        owner: pr.repo.owner,
        name: pr.repo.name,
      },
      workspaceId,
      readCheckSet,
    );
  } catch (err) {
    console.warn('[linkPromotion] could not read a linked pull request from the host', {
      pullRequestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
