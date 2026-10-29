import { withWorkspaceContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import { providerSupportsMerge } from '@/lib/git/provider';
import { MergeChangeRequestError } from '@/lib/git/errors';
import type { GitProviderId, MergeRefusal, MergeRefusalCode } from '@/lib/git/types';
import { pullRequestHead } from '@/lib/github/pullRequestHead';
import { getMessagesFor } from '@/lib/i18n/messages';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import type { PullRequestAutoMergeRequestedData } from '@/lib/jobs/types';
import { commentsService } from './commentsService';

// AUTO MODE — Motir merges a green run target's pull requests with no gate (Story
// MOTIR-4882 · MOTIR-5518; `approval-gates.md` §7, §7a and §4's second amendment,
// decision 9).
//
// One job per `(pull request, head)`, dispatched by the CI promotion AFTER it commits
// (`lib/services/ciPromotion.ts`). The job merges or enqueues through the seam and
// records `merge_authority = 'auto_mode'` on the PULL REQUEST — never a synthetic
// approval on the gate table, which holds only decisions people made. The card moves
// only through the merge webhook, exactly as for a person merging by hand.
//
// ⚠️ NOBODY IS WATCHING AN AUTO MERGE, so a refusal is never silent: it posts ONE
// comment on the run target naming the pull request, what the host refused and what
// to do — the refusal copy the approval frame draws (MOTIR-5512). The same head is
// never retried (the job's idempotency key is the head); a new head that turns green
// is attempted afresh. A host that does not answer is retried by the job's policy, and
// the FINAL attempt posts the comment before it dead-letters.
//
// The comment goes through `commentsService.addComment` as the workspace owner — the
// same writer and author `changeRequestStatusSync` uses for its defer notes.

/** What one auto-merge run did — the job's result on its ledger row. */
export type AutoMergeOutcome =
  | { outcome: 'merged' | 'enqueued'; mergeOutcomeRef: string }
  | { outcome: 'refused'; code: MergeRefusalCode }
  | {
      outcome: 'skipped';
      reason: 'gone' | 'not_open' | 'head_moved' | 'provider_cannot_merge';
    };

/** The seam's refusal → the frame's refusal copy key (`approvalGate.refusal.*`). */
const REFUSAL_COPY: Record<Exclude<MergeRefusalCode, 'subject_changed'>, string> = {
  checks_not_green: 'mergeChecksNotGreen',
  conflict: 'mergeConflict',
  out_of_date: 'mergeOutOfDate',
  branch_protected: 'mergeBranchProtected',
  already_merged: 'mergeAlreadyMerged',
  app_permission_missing: 'mergeAppPermissionMissing',
};

interface RefusalCopy {
  title: string;
  next: string;
  nextUnnamed?: string;
}

/** The comment a refused auto merge posts — the frame's own title and next action. */
export function autoMergeRefusedCommentBody(
  pullRequest: string,
  refusal: MergeRefusal & { code: Exclude<MergeRefusalCode, 'subject_changed'> },
): string {
  const messages = getMessagesFor('en') as {
    approvalGate: { refusal: Record<string, RefusalCopy> };
  };
  const copy = messages.approvalGate.refusal[REFUSAL_COPY[refusal.code]]!;
  const next =
    refusal.code === 'app_permission_missing' && !refusal.permission && copy.nextUnnamed
      ? copy.nextUnnamed
      : copy.next.replace('{permission}', refusal.permission ?? '');
  return `**Motir could not merge ${pullRequest} automatically.** ${copy.title} ${next}`;
}

/** The comment the final attempt posts when the host never answered. */
export function autoMergeUnreachableCommentBody(pullRequest: string): string {
  return (
    `**Motir could not reach GitHub to merge ${pullRequest} automatically.** ` +
    'It tried several times and gave up. The work item stays in review; merge the pull ' +
    'request on GitHub, or push a new commit and Motir tries again once it is green.'
  );
}

export const pullRequestAutoMergeService = {
  /**
   * Merge or enqueue ONE pull request for an auto-mode project, if it is still the
   * question the promotion dispatched: open, and at the head that went green.
   *
   * `finalAttempt` is the job's last retry — the only attempt on which a host that does
   * not answer posts its comment, so a transient blip retried into a success says
   * nothing to anybody.
   */
  async mergeOnGreen(
    data: PullRequestAutoMergeRequestedData,
    opts: { finalAttempt: boolean },
  ): Promise<AutoMergeOutcome> {
    const ctx = { userId: data.actorUserId, workspaceId: data.workspaceId };
    const pr = await withWorkspaceContext(ctx, (tx) =>
      githubPullRequestRepository.findByIdWithInstallation(data.pullRequestId, tx),
    );
    if (!pr) return { outcome: 'skipped', reason: 'gone' };
    if (pr.state !== 'open' || pr.merged) return { outcome: 'skipped', reason: 'not_open' };
    if ((pullRequestHead(pr) ?? undefined) !== data.headSha) {
      return { outcome: 'skipped', reason: 'head_moved' };
    }
    const provider = getGitProvider(pr.repo.provider as GitProviderId);
    if (!providerSupportsMerge(provider)) {
      return { outcome: 'skipped', reason: 'provider_cannot_merge' };
    }

    const name = `${pr.repo.owner}/${pr.repo.name}#${pr.number}`;
    const comment = (bodyMd: string) =>
      commentsService.addComment(data.workItemId, { bodyMd }, ctx);

    let result;
    try {
      result = await provider.mergeChangeRequest({
        installationId: pr.repo.installation.installationId,
        owner: pr.repo.owner,
        name: pr.repo.name,
        number: pr.number,
        expectedHeadSha: data.headSha,
      });
    } catch (err) {
      if (err instanceof MergeChangeRequestError && opts.finalAttempt) {
        await comment(autoMergeUnreachableCommentBody(name));
      }
      throw err;
    }

    if (result.outcome === 'refused') {
      // A head that moved under the merge is not a refusal to report: the new head's
      // own green verdict dispatches its own attempt.
      if (result.refusal.code === 'subject_changed') {
        return { outcome: 'skipped', reason: 'head_moved' };
      }
      const code = result.refusal.code;
      await comment(autoMergeRefusedCommentBody(name, { ...result.refusal, code }));
      return { outcome: 'refused', code };
    }

    const mergeOutcomeRef =
      result.outcome === 'merged' ? result.commitSha : `queue:${result.entryId}`;
    await withWorkspaceContext(ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge(
        pr.id,
        { mergeAuthority: 'auto_mode', mergeOutcomeRef },
        tx,
      ),
    );
    return { outcome: result.outcome, mergeOutcomeRef };
  },
};
