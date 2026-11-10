'use client';

import { useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Popover } from '@/components/ui/Popover';
import type { MentionCandidate } from '@/components/ui/MarkdownEditor';
import type { PageCommentDto } from '@/lib/pages';
import { Avatar } from '@/app/(authed)/items/_components/issueCellPrimitives';
import { CommentComposer } from '@/app/(authed)/items/[key]/_components/CommentComposer';

// ONE PAGE COMMENT (Story MOTIR-10866 · MOTIR-10874), the design's *Root comment*
// / *Reply* with its *Comment meta* and *Comment actions*
// (`design/pages/design-notes.md` § Discussion). It is the work-item
// `CommentRow` composed again from the same parts — the 22px `Avatar`, the
// `MarkdownView` body with its mention chips, the confirm `Popover`, `Button`
// and `CommentComposer` in `edit` mode — because `CommentRow` calls the
// work-item server actions itself. This row calls nothing: `onEdit` and
// `onDelete` are the panel's, which owns the network and the sequence guards.
// They resolve to an error message, or `null` on success.
//
// Controls are PRESENT OR ABSENT, never drawn disabled: the whole action row
// needs `canComment` (a writable thread on a live page), Reply needs
// `onStartReply` (a root), and Edit / Delete need authorship or `canModerate`.

export interface PageCommentItemProps {
  comment: PageCommentDto;
  /** Roots only — how many replies the delete takes with it. */
  replyCount?: number;
  /** The thread is writable for this reader: `comment:add`, a live page, an open thread. */
  canComment: boolean;
  /** Holds `comment:moderate` — Edit / Delete on everyone's comments. */
  canModerate: boolean;
  currentUserId: string;
  mentionCandidates: MentionCandidate[];
  /** Roots only: open the reply composer. A reply has no Reply control. */
  onStartReply?: () => void;
  onEdit: (bodyMd: string) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}

const QUIET_ACTION =
  'text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) font-sans text-xs focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function PageCommentItem({
  comment,
  replyCount = 0,
  canComment,
  canModerate,
  currentUserId,
  mentionCandidates,
  onStartReply,
  onEdit,
  onDelete,
}: PageCommentItemProps) {
  const t = useTranslations('comments');
  const tc = useTranslations('common');
  const format = useFormatter();
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const canModify = comment.author.id === currentUserId || canModerate;
  const createdAt = new Date(comment.createdAt);

  function closeEdit() {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  }

  async function submitEdit(bodyMd: string): Promise<string | null> {
    const error = await onEdit(bodyMd);
    if (error === null) closeEdit();
    return error;
  }

  async function confirmDelete() {
    setDeleteError(null);
    setDeleting(true);
    const error = await onDelete();
    // On success the row is gone; only a refusal leaves anything to update.
    if (error !== null) {
      setDeleting(false);
      setDeleteError(error);
    }
  }

  return (
    <div className="flex items-start gap-2.5" data-testid={`page-comment-${comment.id}`}>
      <Avatar name={comment.author.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-sans text-[13px] font-semibold text-(--el-text)">
            {comment.author.name}
          </span>
          <time
            dateTime={comment.createdAt}
            className="font-sans text-xs text-(--el-text-muted)"
            title={format.dateTime(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
          >
            {format.relativeTime(createdAt)}
          </time>
          {comment.editedAt ? (
            <span
              className="font-sans text-xs text-(--el-text-muted)"
              title={t('editedTitle', {
                time: format.dateTime(new Date(comment.editedAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            >
              {t('edited')}
            </span>
          ) : null}
        </div>

        {editing ? (
          <CommentComposer
            mode="edit"
            label={t('editLabel')}
            submitLabel={t('save')}
            initialValue={comment.bodyMd}
            mentionCandidates={mentionCandidates}
            onSubmit={submitEdit}
            onCancel={closeEdit}
          />
        ) : (
          <MarkdownView value={comment.bodyMd} className="text-sm" />
        )}

        {!editing && canComment && (onStartReply || canModify) ? (
          <div className="flex items-center gap-1.5">
            {onStartReply ? (
              <button type="button" className={QUIET_ACTION} onClick={onStartReply}>
                {t('reply')}
              </button>
            ) : null}
            {canModify ? (
              <>
                {onStartReply ? (
                  <span aria-hidden className="text-xs text-(--el-text-faint)">
                    ·
                  </span>
                ) : null}
                <button
                  ref={editButtonRef}
                  type="button"
                  className={QUIET_ACTION}
                  onClick={() => setEditing(true)}
                >
                  {t('edit')}
                </button>
                <span aria-hidden className="text-xs text-(--el-text-faint)">
                  ·
                </span>
                <Popover
                  open={confirmOpen}
                  onOpenChange={(open) => {
                    setConfirmOpen(open);
                    if (!open) setDeleteError(null);
                  }}
                >
                  <Popover.Trigger className="rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) font-sans text-xs text-(--el-text-muted) hover:bg-(--el-tint-rose) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none">
                    {t('delete')}
                  </Popover.Trigger>
                  <Popover.Content width={300} align="start">
                    <div className="flex flex-col gap-3 p-3.5">
                      <p className="font-sans text-sm leading-snug text-(--el-text)">
                        {replyCount > 0
                          ? t('deleteConfirmWithReplies', { count: replyCount })
                          : t('deleteConfirm')}
                      </p>
                      {deleteError ? (
                        <p
                          role="alert"
                          className="rounded-(--radius-control) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs text-(--el-text-strong)"
                        >
                          {deleteError}
                        </p>
                      ) : null}
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmOpen(false)}
                          disabled={deleting}
                        >
                          {tc('cancel')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void confirmDelete()}
                          loading={deleting}
                        >
                          {t('delete')}
                        </Button>
                      </div>
                    </div>
                  </Popover.Content>
                </Popover>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
