'use client';

import { SurfaceTitle } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { CheckCheck, CircleX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { Textarea } from '@/components/ui/Textarea';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { AttachmentGlyph } from '@/app/(authed)/items/[key]/_components/AttachmentGlyph';
import type { TriageItemDetailDto } from '@/lib/dto/triage';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { CommentDTO } from '@/lib/dto/comments';
import { TriageAvatar } from './TriageAvatar';
import { PromotePopover, type PromoteTarget } from './PromotePopover';
import { MergePicker } from './MergePicker';
import { SnoozePopover } from './SnoozePopover';

// The right detail pane of the triage inbox (Subtask 6.11.6, design panel 1) —
// kind line, title, attribution card, body, attachments, read-only comments,
// then the sticky action bar (the 6.11.5 taxonomy: Accept · Promote · Mark
// duplicate · Snooze · Decline, with Decline pushed right and danger-tinted).
// Every action is delegated up to TriageInbox (which owns the optimistic
// seq-guarded mutation + toast); this component is presentation + the per-action
// pickers/popovers.

/** The terminal-action handlers, each bound to the work-item id at call time
 *  (so the set is referentially stable in the parent — no per-detail closures). */
export interface TriageActionHandlers {
  onAccept: (id: string) => void;
  onPromote: (id: string, target: PromoteTarget, placement: 'top' | 'bottom') => void;
  onMerge: (id: string, canonicalId: string, canonicalKey: string) => void;
  onSnooze: (id: string, snoozedUntilIso: string) => void;
  onDecline: (id: string, comment: string) => void;
}

export interface TriageDetailProps {
  detail: TriageItemDetailDto;
  busy: boolean;
  handlers: TriageActionHandlers;
}

function CommentRowReadOnly({
  comment,
  workItemRefs,
}: {
  comment: CommentDTO;
  workItemRefs: WorkItemRefMap;
}) {
  const format = useFormatter();
  return (
    <div className="flex gap-2">
      <TriageAvatar name={comment.author.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-(--el-text)">{comment.author.name}</span>
          <span className="text-xs text-(--el-text-secondary)">
            {format.relativeTime(new Date(comment.createdAt))}
          </span>
        </div>
        <MarkdownView
          value={comment.bodyMd}
          workItemRefs={workItemRefs}
          className="text-sm text-(--el-text-secondary)"
        />
      </div>
    </div>
  );
}

export function TriageDetail({ detail, busy, handlers }: TriageDetailProps) {
  const t = useTranslations('triage');
  const format = useFormatter();
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineComment, setDeclineComment] = useState('');
  const id = detail.id;

  const kindLabel = detail.kind === 'bug' ? t('bugReport') : t('featureRequest');
  const submitterName = detail.submitter.name ?? t('unknownSubmitter');
  const metaLine =
    detail.submitter.kind === 'member'
      ? t('memberMeta')
      : t('externalMeta', { name: submitterName });

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-(--spacing-card-padding)">
        {/* Kind line */}
        <div className="flex items-center gap-2 text-sm text-(--el-text-muted)">
          <IssueTypeIcon type={detail.kind} className="h-4 w-4" />
          <span className="font-medium text-(--el-text-secondary)">{kindLabel}</span>
          <span aria-hidden>·</span>
          <span>{format.relativeTime(new Date(detail.triagedAt))}</span>
        </div>

        {/* Title */}
        <h2 className="font-serif text-xl text-(--el-text)">
          <SurfaceTitle id={detail.id} title={detail.title} layout="clamp" />
        </h2>

        {/* Attribution card */}
        <div className="flex items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding)">
          <TriageAvatar name={submitterName} size="lg" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-(--el-text)">{submitterName}</span>
            <span className="text-xs text-(--el-text-secondary)">{metaLine}</span>
          </div>
        </div>

        {/* Body */}
        {detail.descriptionMd ? (
          <MarkdownView
            value={detail.descriptionMd}
            workItemRefs={detail.workItemRefs}
            className="text-sm text-(--el-text-secondary)"
          />
        ) : null}

        {/* Attachments */}
        {detail.attachments.length > 0 ? (
          <div className="flex flex-col gap-2">
            <SectionLabel label={t('attachmentsLabel')} />
            <ul className="flex flex-col gap-1.5">
              {detail.attachments.map((a) => (
                <li key={a.id}>
                  <a
                    href={a.blobUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-2 rounded-(--radius-control) border border-(--el-border) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-link) hover:bg-(--el-surface)"
                  >
                    <AttachmentGlyph mimeType={a.mimeType} className="h-4 w-4 shrink-0" />
                    <span className="truncate">{a.filename}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Comments (read-only) */}
        <div className="flex flex-col gap-3">
          <SectionLabel label={t('commentsLabel')} />
          {detail.comments.length === 0 ? (
            <p className="text-sm text-(--el-text-muted)">{t('noComments')}</p>
          ) : (
            detail.comments.map((c) => (
              <CommentRowReadOnly key={c.id} comment={c} workItemRefs={detail.workItemRefs} />
            ))
          )}
        </div>
      </div>

      {/* Sticky action bar */}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-(--el-border) bg-(--el-page-bg) p-3">
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          onClick={() => handlers.onAccept(id)}
          leftIcon={<CheckCheck className="h-4 w-4" />}
        >
          {t('actions.accept')}
        </Button>
        <PromotePopover
          busy={busy}
          onPromote={(target, placement) => handlers.onPromote(id, target, placement)}
        />
        <MergePicker
          excludeId={id}
          busy={busy}
          onMerge={(canonicalId, canonicalKey) => handlers.onMerge(id, canonicalId, canonicalKey)}
        />
        <SnoozePopover busy={busy} onSnooze={(iso) => handlers.onSnooze(id, iso)} />

        <div className="ml-auto">
          <Popover open={declineOpen} onOpenChange={setDeclineOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                disabled={busy}
                className="inline-flex h-(--height-btn-sm) items-center gap-2 rounded-(--radius-btn) bg-(--el-tint-rose) px-(--spacing-control-x-12) text-xs font-medium text-(--el-text-strong) transition-colors hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
              >
                <CircleX className="h-4 w-4 text-(--el-danger)" aria-hidden />
                {t('actions.decline')}
              </button>
            </Popover.Trigger>
            <Popover.Content align="end" width={300} className="flex flex-col gap-2 p-3">
              <p className="text-sm font-medium text-(--el-text)">{t('declinePopover.heading')}</p>
              <Textarea
                value={declineComment}
                onChange={(e) => setDeclineComment(e.target.value)}
                placeholder={t('declinePopover.commentPlaceholder')}
                rows={3}
                aria-label={t('declinePopover.commentPlaceholder')}
              />
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                onClick={() => {
                  setDeclineOpen(false);
                  handlers.onDecline(id, declineComment);
                  setDeclineComment('');
                }}
                leftIcon={<CircleX className="h-4 w-4" />}
              >
                {t('declinePopover.confirm')}
              </Button>
            </Popover.Content>
          </Popover>
        </div>
      </div>
    </div>
  );
}
