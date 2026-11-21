'use client';

import { useRef, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Popover } from '@/components/ui/Popover';
import type { MentionCandidate } from '@/components/ui/MarkdownEditor';
import type { CommentAuthorDTO, CommentDTO } from '@/lib/dto/comments';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { Avatar } from '../../_components/issueCellPrimitives';
import { CommentComposer } from './CommentComposer';
import { deleteCommentAction, editCommentAction } from '../commentActions';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// One comment row (Subtask 5.1.5), per `comments.mock.html` panel 1: 22px
// initial-letter Avatar · author · relative time (absolute on hover via
// `title`) · the "· Edited" tag (only when `editedAt` is set — latest version
// only, no history) · the MarkdownView body (mention chips inline) · the quiet
// action row. Role-dependent actions render present/absent, never
// disabled-but-visible (panel 2): Reply needs the commenting role; Edit/Delete
// need authorship or the moderator capability (the Jira "own / all" split the
// 5.1.2 service re-checks server-side regardless — the affordance is not the
// gate). Edit swaps the body for the composer in place (panel 4); Delete
// anchors the RemoveLinkButton confirm-Popover pattern, a root naming the
// reply count its hard-delete cascade takes with it (panel 8).

export function CommentRow({
  comment,
  replyCount = 0,
  canComment,
  canModerate,
  currentUserId,
  mentionCandidates,
  workItemRefs,
  onStartReply,
  onEdited,
  onDeleted,
}: {
  comment: CommentDTO;
  /** Root rows only — how many replies the delete cascade would take. */
  replyCount?: number;
  canComment: boolean;
  canModerate: boolean;
  currentUserId: string;
  mentionCandidates: MentionCandidate[];
  /** Resolved `motir:` references in the comment body (Subtask 5.8.6) → chips. */
  workItemRefs?: WorkItemRefMap;
  /** Open the thread's reply composer, pre-mentioning this row's author. */
  onStartReply?: (author: CommentAuthorDTO) => void;
  onEdited: (updated: CommentDTO) => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('comments');
  const tc = useTranslations('common');
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, startDelete] = useTransition();
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const isOwn = comment.author.id === currentUserId;
  const canModify = isOwn || canModerate;
  const createdAt = new Date(comment.createdAt);

  function closeEdit() {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  }

  async function submitEdit(bodyMd: string): Promise<string | null> {
    const res = await editCommentAction({ commentId: comment.id, bodyMd });
    if (!res.ok) return res.error;
    onEdited(res.comment);
    closeEdit();
    return null;
  }

  function confirmDelete() {
    setDeleteError(null);
    startDelete(async () => {
      const res = await deleteCommentAction({ commentId: comment.id });
      if (res.ok) {
        setConfirmOpen(false);
        onDeleted();
      } else {
        setDeleteError(res.error);
      }
    });
  }

  const quietAction =
    'text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) font-sans text-xs focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

  return (
    <div className="flex items-start gap-2.5">
      <Avatar name={comment.author.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-(--el-text) font-sans text-[13px] font-semibold">
            {comment.author.name}
          </span>
          <span
            className="text-(--el-text-muted) font-sans text-xs"
            title={format.dateTime(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
          >
            {relativeTime(createdAt)}
          </span>
          {comment.editedAt ? (
            <span
              className="text-(--el-text-muted) font-sans text-xs"
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
          <MarkdownView value={comment.bodyMd} className="text-sm" workItemRefs={workItemRefs} />
        )}

        {/* The whole action row is gated on the commenting role — a viewer
            sees NO affordances at all (panel 9, the 6.4 read-only grammar). */}
        {!editing && canComment ? (
          <div className="flex items-center gap-1.5">
            {onStartReply ? (
              <button
                type="button"
                className={quietAction}
                onClick={() => onStartReply(comment.author)}
              >
                {t('reply')}
              </button>
            ) : null}
            {canModify ? (
              <>
                {onStartReply ? (
                  <span aria-hidden className="text-(--el-text-faint) text-xs">
                    ·
                  </span>
                ) : null}
                <button
                  ref={editButtonRef}
                  type="button"
                  className={quietAction}
                  onClick={() => setEditing(true)}
                >
                  {t('edit')}
                </button>
                <span aria-hidden className="text-(--el-text-faint) text-xs">
                  ·
                </span>
                <Popover
                  open={confirmOpen}
                  onOpenChange={(open) => {
                    setConfirmOpen(open);
                    if (!open) setDeleteError(null);
                  }}
                >
                  <Popover.Trigger
                    className={
                      'text-(--el-text-muted) hover:bg-(--el-tint-rose) hover:text-(--el-danger) rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) font-sans text-xs focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none'
                    }
                  >
                    {t('delete')}
                  </Popover.Trigger>
                  <Popover.Content width={300} align="start">
                    <div className="flex flex-col gap-3 p-3.5">
                      <p className="text-(--el-text) font-sans text-sm leading-snug">
                        {replyCount > 0
                          ? t('deleteConfirmWithReplies', { count: replyCount })
                          : t('deleteConfirm')}
                      </p>
                      {deleteError ? (
                        <p className="text-(--el-text-strong) bg-(--el-tint-rose) rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs">
                          {deleteError}
                        </p>
                      ) : null}
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmOpen(false)}
                          disabled={isDeleting}
                        >
                          {tc('cancel')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={confirmDelete}
                          loading={isDeleting}
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
