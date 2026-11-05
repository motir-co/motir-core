import type { ReviewBotPostKind, ReviewVerdictRecord } from '@/generated/prisma/client';
import {
  botDismissalMessage,
  botReviewBody,
  cardUrl,
  type BotDismissalReason,
} from '@/lib/agentReview/botReviewBody';
import { getGitProvider } from '@/lib/git';
import type { PullRequestReviewPostEvent } from '@/lib/git/types';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  reviewBotPostRepository,
  type LiveRequestChangesPost,
} from '@/lib/repositories/reviewBotPostRepository';
import { reviewDismissalRepository } from '@/lib/repositories/reviewDismissalRepository';
import { reviewVerdictRecordRepository } from '@/lib/repositories/reviewVerdictRecordRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { deferUntilCommit } from '@/lib/workspaces/afterCommit';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// MOTIR'S APP BOT ON THE PULL REQUEST (Story MOTIR-10327 · MOTIR-10335;
// `approval-gates.md` §12 rules 7 and 8). Every agent verdict that ANSWERS its version is
// posted as ONE review on each open pull request of the card's set, as the repository's
// own App; and the bot's own Request changes is dismissed again once a later pass, a
// person's Dismiss or the project's posting switch turning off retires it.
//
// ⚠️ NEVER INSIDE A TRANSACTION, AND NEVER THE VERDICT'S. The verdict door and the Dismiss
// action only emit an event after their own commit; this service runs in that event's
// job. Each GitHub call is made outside any transaction (a call inside one holds a pooled
// connection on GitHub's latency), and the post row is written in its own short one
// AFTER GitHub answered. A failure throws, the job retries, and the verdict it was
// posting is never touched.
//
// ⚠️ THE ROW IS THE IDEMPOTENCY RECORD. A (pull request, verdict record) pair with a row
// is skipped, so a retried job posts only on the pull requests its first attempt did not
// reach, and a crash between GitHub's answer and the write is the one window that can
// post twice — the narrowest a host without idempotency keys allows.
//
// ⚠️ THE RECONCILE READS STORED STATE, NOT ITS TRIGGER. It asks, for every Request changes
// still standing on the card, whether anything retires it now. So a missed event is
// repaired by the next one, and running it twice dismisses once.

const PROVIDER = 'github' as const;

/** What one post job did. */
export type ReviewBotPostOutcome =
  | { outcome: 'posted'; posted: number; dismissed: number }
  | {
      outcome: 'skipped';
      reason: 'no_record' | 'not_answering' | 'posting_off' | 'unsupported';
      dismissed: number;
    };

/** One open pull request a verdict is posted on. */
type PostTarget = Awaited<
  ReturnType<typeof workItemDeliveryRepository.listOpenGithubTargetsByWorkItem>
>[number];

/** What the post job found to do, read in one transaction. */
type PostPlan =
  | {
      skip: 'no_record' | 'not_answering' | 'posting_off';
      /** The card to reconcile anyway — absent when the record is gone. */
      workItemId?: string;
    }
  | { record: ReviewVerdictRecord; identifier: string; todo: PostTarget[] };

/** One standing Request changes the reconcile retires, and why. */
interface Retirement {
  post: LiveRequestChangesPost;
  reason: BotDismissalReason;
}

/** The kind a post is recorded as, from the event GitHub took. */
function kindOf(event: PullRequestReviewPostEvent): ReviewBotPostKind {
  return event === 'REQUEST_CHANGES' ? 'request_changes' : 'comment';
}

async function retirementsFor(
  workspaceId: string,
  workItemId: string,
): Promise<{ identifier: string; retire: Retirement[] }> {
  return withWorkspaceServiceContext(workspaceId, async (tx) => {
    const live = await reviewBotPostRepository.listLiveRequestChangesByWorkItem(workItemId, tx);
    const item = live.length > 0 ? await workItemRepository.findById(workItemId, tx) : null;
    if (!item) return { identifier: '', retire: [] };
    const project = await projectRepository.findById(item.projectId, tx);
    const retire: Retirement[] = [];
    for (const post of live) {
      const record = post.reviewVerdictRecord;
      let reason: BotDismissalReason | null = null;
      if (!project?.reviewBotPostsEnabled) reason = 'posting_off';
      else if (
        await reviewVerdictRecordRepository.hasAnsweringPassAfter(item.id, record.createdAt, tx)
      )
        reason = 'passed';
      else if (await reviewDismissalRepository.findAt(item.id, record.subjectVersion, tx))
        reason = 'dismissed';
      if (reason) retire.push({ post, reason });
    }
    return { identifier: item.identifier, retire };
  });
}

export const reviewBotPostService = {
  /**
   * Ask for the post of an ANSWERING verdict once the caller's transaction commits — the
   * one line the verdict door and the hosted verdict path add. A rollback posts nothing.
   */
  requestPostAfterCommit(workspaceId: string, recordId: string): void {
    deferUntilCommit(() => sendEvent('review-bot/post.requested', { workspaceId, recordId }));
  },

  /** Ask for a reconcile of each card once the caller's transaction commits. */
  requestReconcileAfterCommit(workspaceId: string, workItemIds: readonly string[]): void {
    for (const workItemId of workItemIds) {
      deferUntilCommit(() =>
        sendEvent('review-bot/reconcile.requested', { workspaceId, workItemId }),
      );
    }
  },

  /**
   * THE `review-bot/post` JOB's body — post one answering verdict on each open pull
   * request of its card's set, then reconcile the card. A late or second verdict is
   * history and posts nothing; neither does a project whose posting switch is off. A
   * failure to post THROWS, so the job retries; what was posted stays posted.
   */
  async postVerdict(data: {
    workspaceId: string;
    recordId: string;
  }): Promise<ReviewBotPostOutcome> {
    const { workspaceId } = data;
    const plan = await withWorkspaceServiceContext(workspaceId, async (tx): Promise<PostPlan> => {
      const record = await reviewVerdictRecordRepository.findById(data.recordId, tx);
      if (!record) return { skip: 'no_record' };
      if (record.outcome !== 'decided' && record.outcome !== 'recorded') {
        return { skip: 'not_answering', workItemId: record.workItemId };
      }
      const project = await projectRepository.findById(record.projectId, tx);
      if (!project?.reviewBotPostsEnabled) {
        return { skip: 'posting_off', workItemId: record.workItemId };
      }
      const item = await workItemRepository.findById(record.workItemId, tx);
      /* v8 ignore next -- the record cascades with its card. */
      if (!item) return { skip: 'no_record' };
      const targets = await workItemDeliveryRepository.listOpenGithubTargetsByWorkItem(item.id, tx);
      const todo: PostTarget[] = [];
      for (const target of targets) {
        const done = await reviewBotPostRepository.findByPullRequestAndRecord(
          target.pullRequestId,
          record.id,
          tx,
        );
        if (!done) todo.push(target);
      }
      return { record, identifier: item.identifier, todo };
    });
    if (!('record' in plan)) {
      const dismissed =
        plan.workItemId === undefined
          ? 0
          : await reviewBotPostService.reconcile({ workspaceId, workItemId: plan.workItemId });
      return { outcome: 'skipped', reason: plan.skip, dismissed };
    }

    const provider = getGitProvider(PROVIDER);
    const create = provider.createPullRequestReview?.bind(provider);
    /* v8 ignore next 4 -- the GitHub provider always declares it; the seam keeps it
       optional for hosts that have no App bot. */
    if (!create) {
      return { outcome: 'skipped', reason: 'unsupported', dismissed: 0 };
    }

    const { record } = plan;
    const body = botReviewBody(record, plan.identifier, cardUrl(plan.identifier));
    const wanted: PullRequestReviewPostEvent =
      record.verdict === 'changes_requested' ? 'REQUEST_CHANGES' : 'COMMENT';
    let posted = 0;
    for (const target of plan.todo) {
      const address = {
        installationId: target.installationId,
        owner: target.owner,
        repo: target.name,
        number: target.number,
        body,
      };
      let event = wanted;
      let answer = await create({ ...address, event });
      // GitHub will not take an App's Request changes on a pull request that App authored
      // (a Motir-created repository's run pushes as that App): post it as a comment.
      if (answer.kind === 'own_pull_request') {
        event = 'COMMENT';
        answer = await create({ ...address, event });
      }
      /* v8 ignore next 3 -- a COMMENT is never refused as own-authored. */
      if (answer.kind !== 'posted') {
        throw new Error('the host refused a comment review as own-authored');
      }
      const reviewId = answer.reviewId;
      await withWorkspaceServiceContext(workspaceId, (tx) =>
        reviewBotPostRepository.create(
          {
            workspaceId,
            projectId: record.projectId,
            workItemId: record.workItemId,
            reviewVerdictRecordId: record.id,
            githubPullRequestId: target.pullRequestId,
            kind: kindOf(event),
            githubReviewId: reviewId,
            postedAt: new Date(),
          },
          tx,
        ),
      );
      posted += 1;
    }

    // A pass retires the earlier Request changes; a send-back posted after a pass or a
    // Dismiss that raced it is retired here too, since the reconcile reads stored state.
    const dismissed = await reviewBotPostService.reconcile({
      workspaceId,
      workItemId: record.workItemId,
    });
    return { outcome: 'posted', posted, dismissed };
  },

  /**
   * THE `review-bot/reconcile` JOB's body — dismiss every Request changes the bot posted
   * on the card that something now retires: a later answering pass, a person's Dismiss of
   * that send-back, or the project's posting switch being off. Returns how many it
   * dismissed. A dismissal GitHub did not take is counted on its row and the job THROWS
   * after trying the rest, so it is retried; one that is already gone is marked done.
   */
  async reconcile(data: { workspaceId: string; workItemId: string }): Promise<number> {
    const { workspaceId } = data;
    const { identifier, retire } = await retirementsFor(workspaceId, data.workItemId);
    if (retire.length === 0) return 0;
    const provider = getGitProvider(PROVIDER);
    const dismiss = provider.dismissPullRequestReview?.bind(provider);
    /* v8 ignore next -- the GitHub provider always declares it. */
    if (!dismiss) return 0;

    let dismissed = 0;
    const failures: string[] = [];
    for (const { post, reason } of retire) {
      /* v8 ignore next -- a post row is written only with GitHub's review id. */
      if (!post.githubReviewId) continue;
      try {
        await dismiss({
          installationId: post.pullRequest.repo.installation.installationId,
          owner: post.pullRequest.repo.owner,
          repo: post.pullRequest.repo.name,
          number: post.pullRequest.number,
          reviewId: post.githubReviewId,
          message: botDismissalMessage(reason, identifier, cardUrl(identifier)),
        });
        await withWorkspaceServiceContext(workspaceId, (tx) =>
          reviewBotPostRepository.markDismissed(post.id, new Date(), tx),
        );
        dismissed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        failures.push(message);
        await withWorkspaceServiceContext(workspaceId, (tx) =>
          reviewBotPostRepository.recordDismissFailure(post.id, message, tx),
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `could not dismiss ${failures.length} of Motir's own Request changes reviews: ` +
          failures.join('; '),
      );
    }
    return dismissed;
  },
};
