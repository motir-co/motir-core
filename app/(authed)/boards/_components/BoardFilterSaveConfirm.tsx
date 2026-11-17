'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { encodeFilterEnvelope, FILTER_ROW_CAP, type FilterAst } from '@/lib/filters/ast';
import type { BoardTypeDto } from '@/lib/dto/boards';
import {
  AdvancedFilterSummary,
  type AdvancedFilterSummaryProps,
} from '../../items/_components/AdvancedFilterSummary';

// The confirm before a header filter is written as the board's own filter
// (MOTIR-11565, design `board--header-board-filter.mock.html` panels 7–8). Save
// to board filter and Set as board filter overwrite what every reader of the
// board sees, so both ask first; Reset does not (it changes only the reader's
// own view). The write is the one board settings makes — `PATCH /api/boards/:id`
// with `{ filter }`, the envelope or `null` to remove it — and a toast reports
// every answer. A 403 means `board:configure` was lost: the page re-reads the
// reader's rights so the bar drops its admin actions, with the edits intact.

export type BoardFilterSaveKind = 'save' | 'set' | 'clear';

export interface BoardFilterSaveConfirmProps {
  kind: BoardFilterSaveKind;
  boardId: string;
  boardType: BoardTypeDto | null;
  /** The conditions to store; ignored (and sent as `null`) for `clear`. */
  ast: FilterAst | null;
  /** The applied saved filter's name, for `set`. */
  name?: string;
  /** The vocabularies the condition chips are named with. */
  lookups: Omit<AdvancedFilterSummaryProps, 'ast'>;
  onClose: () => void;
  /** The write succeeded: the header should return to the board filter. */
  onSaved: () => void;
}

/** What the write answered, typed. */
export type BoardFilterWriteResult =
  | { kind: 'ok' }
  | { kind: 'refused'; code: string; error: string; conditionIndex?: number }
  | { kind: 'forbidden' }
  | { kind: 'failed' };

/** Store `ast` as the board's filter (`null` or no conditions removes it). */
export async function writeBoardFilter(
  boardId: string,
  ast: FilterAst | null,
): Promise<BoardFilterWriteResult> {
  const sent = ast && ast.conditions.length > 0 ? encodeFilterEnvelope(ast) : null;
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ filter: sent }),
    });
    if (res.ok) return { kind: 'ok' };
    if (res.status === 422) {
      const body = (await res.json()) as { code: string; error: string; conditionIndex?: number };
      return { kind: 'refused', ...body };
    }
    if (res.status === 403) return { kind: 'forbidden' };
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export function BoardFilterSaveConfirm({
  kind,
  boardId,
  boardType,
  ast,
  name = '',
  lookups,
  onClose,
  onSaved,
}: BoardFilterSaveConfirmProps) {
  const t = useTranslations('boards.headerFilter');
  const tStored = useTranslations('settings.board.storedFilter');
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const scrum = boardType === 'scrum';
  const sent = kind === 'clear' ? null : ast;

  const title =
    kind === 'save'
      ? t('confirmSaveTitle')
      : kind === 'set'
        ? t('confirmSetTitle', { name })
        : t('confirmClearTitle');
  const body =
    kind === 'save'
      ? t('confirmSaveBody')
      : kind === 'set'
        ? t('confirmSetBody', { name })
        : scrum
          ? t('confirmClearBodyScrum')
          : t('confirmClearBody');
  const action =
    kind === 'save' ? t('saveToBoard') : kind === 'set' ? t('setAsBoard') : t('confirmRemove');

  async function confirm() {
    setSaving(true);
    const result = await writeBoardFilter(boardId, sent);
    setSaving(false);
    onClose();
    if (result.kind === 'ok') {
      if (kind === 'clear') {
        toast({ variant: 'success', title: t('removedToast'), description: t('removedToastBody') });
      } else {
        toast({
          variant: 'success',
          title: kind === 'set' ? t('setToast', { name }) : t('savedToast'),
          description: t('savedToastBody'),
        });
      }
      onSaved();
      return;
    }
    let description: string;
    if (result.kind === 'forbidden') {
      description = t('failForbidden');
      // The reader's rights changed: re-read them so the bar drops the admin
      // actions. The header filter is in the URL, so the edits stay.
      router.refresh();
    } else if (result.kind === 'refused' && result.code === 'FILTER_TOO_LARGE') {
      const count = sent?.conditions.length ?? 0;
      description = tStored('refusedTooMany', {
        cap: FILTER_ROW_CAP,
        count,
        extra: Math.max(count - FILTER_ROW_CAP, 1),
      });
    } else if (result.kind === 'refused' && result.conditionIndex !== undefined) {
      description = t('failInvalid', { n: result.conditionIndex + 1, reason: result.error });
    } else {
      description = t('failGeneric');
    }
    toast({ variant: 'error', title: t('failTitle'), description });
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      title={title}
      size="sm"
      onOpenAutoFocus={(event) => {
        // Cancel takes the initial focus: the dialog overwrites shared state,
        // so the safe choice is the default.
        event.preventDefault();
        cancelRef.current?.focus();
      }}
    >
      <Modal.Body className="gap-3" data-testid="board-filter-save-confirm">
        <p className="text-sm text-(--el-text-secondary)">{body}</p>
        {sent && sent.conditions.length > 0 ? (
          <AdvancedFilterSummary ast={sent} {...lookups} />
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button ref={cancelRef} variant="secondary" onClick={onClose} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button variant="primary" onClick={() => void confirm()} loading={saving}>
          {saving ? t('saving') : action}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
