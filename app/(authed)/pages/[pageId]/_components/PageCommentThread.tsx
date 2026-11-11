'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { CircleCheck, RotateCcw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { MentionCandidate } from '@/components/ui/MarkdownEditor';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { PageCommentThreadDto } from '@/lib/pages';
import { CommentComposer } from '@/app/(authed)/items/[key]/_components/CommentComposer';
import { PageCommentItem } from './PageCommentItem';

// ONE THREAD of a page's discussion (Story MOTIR-10866 · MOTIR-10874), the
// design's *Thread* (`design/pages/design-notes.md` § Discussion): the resolved
// line on a resolved thread, the quote slot, the root comment, its replies on
// the shipped reply rail, the reply composer at the rail's foot, the
// write-failed line and the thread action (Resolve or Reopen).
//
// ⚠️ THE QUOTE SLOT is drawn only for a thread that carries an `anchor` (an
// inline thread, MOTIR-10867); a page-level thread draws none. Its text is
// clamped to three lines, visually only — the whole quote stays in the DOM and
// in the slot's accessible name (`design/pages/design-notes.md` § Commenting on
// a passage, the Quote slot).
//
// ⚠️ THE GONE NOTE (MOTIR-10901) says the passage is no longer in the page. It is
// drawn only when the page's editor ANSWERED that the passage resolves to
// nothing (`gone`) and only on an unresolved thread — a resolved thread
// highlights nothing, and "no answer yet" is not gone. `data-thread-anchor`
// reads what the row shows: `page`, `inline` or `gone`.
//
// ⚠️ A RESOLVED THREAD READS UNTIL IT IS REOPENED: no Reply, Edit or Delete in
// it — Reopen is its one action.

export interface PageCommentThreadProps {
  thread: PageCommentThreadDto;
  /** `comment:add` on a live page — the composer, Reply, Resolve and Reopen. */
  canWrite: boolean;
  /** `comment:moderate` (only consulted while `canWrite`). */
  canModerate: boolean;
  currentUserId: string;
  mentionCandidates: MentionCandidate[];
  /** The work items the page's threads link (the list read's `workItemRefs`). */
  workItemRefs: WorkItemRefMap;
  /**
   * The page's editor answered that this thread's passage resolves to nothing.
   * Drawn as the Gone note only while the thread is unresolved.
   */
  gone?: boolean;
  /** A failed Resolve / Reopen, shown at the thread's foot. */
  error?: string | null;
  onReply: (bodyMd: string) => Promise<string | null>;
  onEdit: (commentId: string, bodyMd: string) => Promise<string | null>;
  onDelete: (commentId: string) => Promise<string | null>;
  onResolve: () => void;
  onReopen: () => void;
}

export function PageCommentThread({
  thread,
  canWrite,
  canModerate,
  currentUserId,
  mentionCandidates,
  workItemRefs,
  gone = false,
  error = null,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onReopen,
}: PageCommentThreadProps) {
  const t = useTranslations('pages.discussion');
  const tc = useTranslations('comments');
  const [replying, setReplying] = useState(false);
  const resolved = thread.resolvedAt !== null;
  const writable = canWrite && !resolved;
  const moderates = writable && canModerate;

  async function submitReply(bodyMd: string): Promise<string | null> {
    const failure = await onReply(bodyMd);
    if (failure === null) setReplying(false);
    return failure;
  }

  const rail = thread.replies.length > 0 || (writable && replying);
  const showGone = thread.anchor !== null && gone && !resolved;

  return (
    <article
      aria-label={t('threadLabel', { name: thread.author.name })}
      data-testid={`page-thread-${thread.id}`}
      data-thread-anchor={thread.anchor === null ? 'page' : showGone ? 'gone' : 'inline'}
      className="flex flex-col gap-3 border-b border-(--el-border-soft) py-4 last:border-b-0"
    >
      {resolved ? <ResolvedLine thread={thread} /> : null}
      {thread.anchor ? (
        <div className="flex flex-col gap-1.5">
          <blockquote
            data-testid="page-thread-quote"
            aria-label={t('inline.quoteLabel', { quote: thread.anchor.quote })}
            className="rounded-(--radius-control) border-l-2 border-(--el-border-strong) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px] text-(--el-text-secondary)"
          >
            <span className="line-clamp-3">{thread.anchor.quote}</span>
          </blockquote>
          {showGone ? (
            <p
              data-testid="page-thread-gone-note"
              className="flex items-center gap-1.5 text-[12.5px] text-(--el-text-secondary)"
            >
              <Unlink className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('inline.gone')}
            </p>
          ) : null}
        </div>
      ) : null}
      <PageCommentItem
        comment={thread}
        replyCount={thread.replies.length}
        canComment={writable}
        canModerate={moderates}
        currentUserId={currentUserId}
        mentionCandidates={mentionCandidates}
        workItemRefs={workItemRefs}
        onStartReply={() => setReplying(true)}
        onEdit={(bodyMd) => onEdit(thread.id, bodyMd)}
        onDelete={() => onDelete(thread.id)}
      />
      {rail ? (
        <div className="ml-[11px] flex flex-col gap-4 border-l-2 border-(--el-border-soft) pl-3.5">
          {thread.replies.length > 0 ? (
            <ul aria-label={tc('repliesAria')} className="flex list-none flex-col gap-4">
              {thread.replies.map((reply) => (
                <li key={reply.id}>
                  <PageCommentItem
                    comment={reply}
                    canComment={writable}
                    canModerate={moderates}
                    currentUserId={currentUserId}
                    mentionCandidates={mentionCandidates}
                    workItemRefs={workItemRefs}
                    onEdit={(bodyMd) => onEdit(reply.id, bodyMd)}
                    onDelete={() => onDelete(reply.id)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {writable && replying ? (
            <CommentComposer
              mode="reply"
              label={tc('replyLabel')}
              submitLabel={tc('reply')}
              initialValue={`[@${thread.author.name}](mention:${thread.author.id}) `}
              mentionCandidates={mentionCandidates}
              onSubmit={submitReply}
              onCancel={() => setReplying(false)}
            />
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-(--radius-control) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs text-(--el-text-strong)"
        >
          {error}
        </p>
      ) : null}
      {canWrite ? (
        <div className="flex">
          <Button
            size="sm"
            variant="ghost"
            leftIcon={
              resolved ? (
                <RotateCcw className="h-3.5 w-3.5" />
              ) : (
                <CircleCheck className="h-3.5 w-3.5" />
              )
            }
            onClick={resolved ? onReopen : onResolve}
          >
            {resolved ? t('reopen') : t('resolve')}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** Who resolved the thread and when; the resolver's account may be gone. */
function ResolvedLine({ thread }: { thread: PageCommentThreadDto }) {
  const t = useTranslations('pages.discussion');
  const format = useFormatter();
  const at = new Date(thread.resolvedAt!);
  const time = format.relativeTime(at);
  return (
    <p className="flex items-center gap-1.5 text-[12.5px] text-(--el-text-secondary)">
      <CircleCheck className="h-3.5 w-3.5 shrink-0 text-(--el-success)" aria-hidden />
      <span title={format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short' })}>
        {thread.resolvedBy
          ? t('resolvedBy', { name: thread.resolvedBy.name, time })
          : t('resolvedByUnknown', { time })}
      </span>
    </p>
  );
}
