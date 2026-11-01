'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Textarea } from '@/components/ui/Textarea';
import type { WorkItemObsolescenceDto, WorkItemRefMap } from '@/lib/dto/workItems';
import { ObsolescenceBadge } from './ObsolescenceBadge';
import { ObsolescencePicker } from './ObsolescencePicker';

// The body of the OBSOLESCENCE field (Story MOTIR-6575 · MOTIR-6674) — shared by
// the item page's core fields and the quick view's rail, so the two draw one thing
// (`design/work-items/core-fields--obsolescence.mock.html` panels 1, 1b, 1c, 4, V).
// The host owns the card chrome, the read-only rule and the writes; this draws the
// value, the note and — when editing — the Segmented and the note editor.
//
//   · READ: marked → the badge (the header's own pill); unmarked → CURRENT in plain
//     words. The note sits beneath, collapsed to one line with Show more when long,
//     and is absent when there is none.
//   · EDIT: the mark commits on its segment press (optimistic, like Difficulty);
//     the note commits on its own Save.
//   · REFUSED: the host passes the server's sentence; it shows in place, never as
//     a toast.

/** A note longer than this is collapsed to its first line in read mode. */
const LONG_NOTE_CHARS = 90;

export interface ObsolescenceFieldProps {
  value: WorkItemObsolescenceDto | null;
  noteMd: string | null;
  /**
   * The note's `[KEY](motir:<id>)` links, resolved for the reader by the host's
   * read (bug MOTIR-10023). A note usually names the cards that superseded this
   * one, and with no map every one of them draws as deleted.
   */
  workItemRefs: WorkItemRefMap;
  editing: boolean;
  /** The card's status is not in the done category. */
  locked: boolean;
  pending?: boolean;
  /** The server refused the last write (OBSOLESCENCE_REQUIRES_FINISHED). */
  refusal?: string | null;
  onMark: (value: WorkItemObsolescenceDto | null) => void;
  onNote: (noteMd: string | null) => void;
  onCancelNote?: () => void;
}

export function ObsolescenceField({
  value,
  noteMd,
  workItemRefs,
  editing,
  locked,
  pending,
  refusal,
  onMark,
  onNote,
  onCancelNote,
}: ObsolescenceFieldProps) {
  const t = useTranslations('workItems.obsolescence');
  const [expanded, setExpanded] = useState(false);

  const refusalLine = refusal ? (
    <p role="alert" className="text-xs leading-snug text-(--el-danger-on-surface)">
      {refusal}
    </p>
  ) : null;

  if (editing) {
    return (
      <ObsolescenceEditor
        value={value}
        noteMd={noteMd}
        locked={locked}
        pending={pending}
        refusalLine={refusalLine}
        onMark={onMark}
        onNote={onNote}
        onCancelNote={onCancelNote}
      />
    );
  }

  const long = (noteMd?.length ?? 0) > LONG_NOTE_CHARS || (noteMd?.includes('\n') ?? false);
  return (
    <div className="flex flex-col items-start gap-1.5" data-obsolescence-value={value ?? 'current'}>
      {value ? (
        <ObsolescenceBadge mark={value} />
      ) : (
        <span className="text-(--el-text-strong)">{t('value.current')}</span>
      )}
      {refusalLine}
      {noteMd ? (
        <div className="w-full">
          <div
            className={
              long && !expanded
                ? 'line-clamp-1 text-[13px] text-(--el-text-secondary)'
                : 'text-[13px] text-(--el-text-secondary)'
            }
            data-obsolescence-note=""
          >
            <MarkdownView value={noteMd} workItemRefs={workItemRefs} />
          </div>
          {long ? (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              className="mt-0.5 text-xs font-medium text-(--el-link) hover:underline"
            >
              {expanded ? t('note.showLess') : t('note.showMore')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The editing body. Its own component so the note's draft is seeded ONCE, from the
 * note as it stands when the editor opens — the host unmounts it on close, so a
 * reopened editor starts fresh without an effect copying props into state.
 */
function ObsolescenceEditor({
  value,
  noteMd,
  locked,
  pending,
  refusalLine,
  onMark,
  onNote,
  onCancelNote,
}: {
  value: WorkItemObsolescenceDto | null;
  noteMd: string | null;
  locked: boolean;
  pending?: boolean;
  refusalLine: ReactNode;
  onMark: (value: WorkItemObsolescenceDto | null) => void;
  onNote: (noteMd: string | null) => void;
  onCancelNote?: () => void;
}) {
  const t = useTranslations('workItems.obsolescence');
  const [draft, setDraft] = useState(noteMd ?? '');
  const nextNote = draft.trim() === '' ? null : draft;
  return (
    <div className="flex flex-col gap-2.5" data-obsolescence-editor="">
      <ObsolescencePicker value={value} onChange={onMark} locked={locked} disabled={pending} />
      {pending ? (
        <p role="status" className="flex items-center gap-1.5 text-xs text-(--el-text-secondary)">
          <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden />
          {t('editor.saving')}
        </p>
      ) : null}
      {refusalLine}
      <Textarea
        label={t('note.label')}
        placeholder={t('note.placeholder')}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        disabled={pending}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => onNote(nextNote)}
          disabled={pending || nextNote === (noteMd ?? null)}
        >
          {t('editor.save')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setDraft(noteMd ?? '');
            onCancelNote?.();
          }}
          disabled={pending}
        >
          {t('editor.cancel')}
        </Button>
      </div>
    </div>
  );
}
