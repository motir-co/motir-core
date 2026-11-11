import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { PageCommentCreatedData } from '@/lib/jobs/types';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { mentionExcerpt } from '@/lib/mentions/excerpt';
import { NOTIFICATION_EVENT_TYPE } from '@/lib/notifications/preferences';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { pageStoreFor } from '@/lib/pages';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { resolveRecipientLocales } from '@/lib/services/emailRecipientLocale';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Page comment → email fan-out (Story MOTIR-10868 · MOTIR-10925). The business
// logic behind the `page-comment-email/comment.created` job: given one
// `page/comment.created` payload, decide who gets an email NOW and enqueue one
// `email.send` per recipient. The email channel's OWN resolution — the in-app
// fan-in (`notificationFanInService.fanInPageComment`) resolves its rows
// independently, and neither channel reads or writes the other's state.
//
// THE RECIPIENTS, in the order the rules run:
//   1. the author is removed from everything (never email someone their own write);
//   2. the MENTION set is the event's validated mention ids → the `mention` variant;
//   3. on a reply, the REPLY set is the thread root's author plus the author of
//      every reply ordered BEFORE this one, read from the page's comments at
//      fan-out time, minus the mention set → the `reply` variant. A participant
//      the reply also mentions is mailed once, as a mention;
//   4. page access re-checked AS each candidate (`canViewPages`); a vanished
//      project is zero sends, not a failure;
//   5. each set gated by its OWN settings cell on the email channel — `mentioned`
//      for the mention set, `commented` for the reply set.
//
// IDEMPOTENCY: ONE key per comment × recipient, `page-comment:<commentId>:<userId>`,
// whichever variant it renders. An edit that adds a mention re-fires the same
// comment id; on a reply that re-computes the same participants, and a key per
// variant would mail them all again. One key collapses their second send at the
// `email.send` dedup while the newly added person — never keyed before — still
// gets theirs. The job has no event-level idempotency for the same reason.
//
// SEND-TIME READS, never carried on the event: the page's current title (a
// renamed page notifies under its new name), the comment's body (an edited
// comment quotes its current words), the thread's people, and each recipient's
// language in ONE batch. Opens no write transaction; returns a plain
// JSON-serializable summary (the job step memoizes it).

export type PageCommentEmailFanOutInput = PageCommentCreatedData;

export interface PageCommentEmailFanOutResult {
  /** The user ids an email was enqueued for (post send-time validation). */
  notifiedUserIds: string[];
}

type Variant = 'mention' | 'reply';

const NONE: PageCommentEmailFanOutResult = { notifiedUserIds: [] };

/** The settings cell that gates each variant's email. */
const VARIANT_TYPE: Record<Variant, string> = {
  mention: NOTIFICATION_EVENT_TYPE.mentioned,
  reply: NOTIFICATION_EVENT_TYPE.commented,
};

export const pageCommentEmailService = {
  /**
   * Re-validate and enqueue the emails for one page comment. Resolves (never
   * throws) when the comment, its thread root, its page or its project vanished,
   * or every candidate fails send-time validation.
   */
  async fanOut(input: PageCommentEmailFanOutInput): Promise<PageCommentEmailFanOutResult> {
    // USERLESS: a job has no session, so the reads bind the WORKSPACE tier from the
    // trusted id the emitting service stamped on the event.
    const subject = await withWorkspaceServiceContext(input.workspaceId, async (tx) => {
      const comment = await pageStoreFor(tx).findPageComment(input.commentId);
      if (!comment || comment.pageId !== input.pageId) return null;
      // Archived pages come back too: the thread stays readable, so it still notifies.
      const page = await pageRepository.findById(comment.pageId, tx);
      if (!page) return null;
      const participants: string[] = [];
      // An edit tells only the people it ADDED: the thread heard about this reply when
      // it was posted, so its participants get nothing further (MOTIR-10925).
      if (input.isReply && !input.isEdit) {
        const root = await pageStoreFor(tx).findPageComment(input.threadRootCommentId);
        if (!root) return null;
        participants.push(root.authorId);
        // Oldest first — only the people who spoke BEFORE this reply hear about it.
        for (const reply of await pageStoreFor(tx).findPageCommentReplies([root.id])) {
          if (reply.id === comment.id) break;
          participants.push(reply.authorId);
        }
      }
      return { comment, page, participants };
    });
    if (!subject) return NONE;
    const { comment, page, participants } = subject;

    const variantOf = new Map<string, Variant>();
    for (const userId of input.mentionedUserIds) {
      if (userId !== input.authorId && !variantOf.has(userId)) variantOf.set(userId, 'mention');
    }
    for (const userId of participants) {
      if (userId !== input.authorId && !variantOf.has(userId)) variantOf.set(userId, 'reply');
    }
    if (variantOf.size === 0) return NONE;

    // Page access, AS each candidate, against the page's OWN project — the page is
    // the record of where its permissions come from, so a stale event cannot aim
    // the gate at another project.
    let viewable: string[];
    try {
      const checks = await Promise.all(
        [...variantOf.keys()].map(async (userId) => {
          const caps = await projectAccessService.getPageCapabilities(page.projectId, {
            workspaceId: input.workspaceId,
            userId,
          });
          return caps.canViewPages ? userId : null;
        }),
      );
      viewable = checks.filter((id): id is string => id !== null);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) return NONE;
      throw err;
    }

    // Each set through its own cell: one person's mention and reply emails are two
    // settings rows, and one call cannot answer for both.
    const enabled = new Set<string>();
    for (const variant of ['mention', 'reply'] as const) {
      const ids = viewable.filter((id) => variantOf.get(id) === variant);
      if (ids.length === 0) continue;
      for (const id of await notificationPreferencesService.filterChannelEnabled(
        ids,
        VARIANT_TYPE[variant],
        'email',
      )) {
        enabled.add(id);
      }
    }
    // Candidate order (mentions first, in body order), not the gate's.
    const recipientIds = viewable.filter((id) => enabled.has(id));
    if (recipientIds.length === 0) return NONE;

    const [author] = await userRepository.findByIds([input.authorId]);
    const users = new Map((await userRepository.findByIds(recipientIds)).map((u) => [u.id, u]));
    const localeByUserId = await resolveRecipientLocales(recipientIds);
    const excerpt = mentionExcerpt(comment.bodyMd);
    const threadUrl =
      `${resolveBaseUrlTrimmed()}/pages/${encodeURIComponent(input.pageId)}` +
      `?thread=${encodeURIComponent(input.threadRootCommentId)}`;

    const notifiedUserIds: string[] = [];
    for (const userId of recipientIds) {
      const recipient = users.get(userId);
      if (!recipient) continue;
      await sendEvent('email.send', {
        workspaceId: input.workspaceId,
        // One delivery per comment × user, whichever variant (see the header).
        idempotencyKey: `page-comment:${comment.id}:${recipient.id}`,
        to: recipient.email,
        template: 'page-comment-notification',
        data: {
          recipientName: recipient.name,
          authorName: author?.name ?? 'Someone',
          pageTitle: page.title,
          variant: variantOf.get(userId)!,
          excerpt,
          threadUrl,
          locale: localeByUserId.get(recipient.id),
        },
      });
      notifiedUserIds.push(recipient.id);
    }
    return { notifiedUserIds };
  },
};
