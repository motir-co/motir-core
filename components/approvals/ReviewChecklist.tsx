'use client';

import { useId, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Check, CircleHelp, X } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { cn } from '@/lib/utils/cn';
import type { ReviewChecklistRowDto, ReviewChecklistStatus } from '@/lib/dto/agentReview';

// THE CHECKLIST ROWS of a review verdict record (MOTIR-10460; `design/workbench/design-notes.md`
// § 42.2, `approvals-row--findings-in-place.mock.html` F1, F3, F10) — ONE part, drawn in the
// in-place findings view and, `compact`, in the card page's agent-verdict Activity entry.
//
// - the heading: *Checklist* (a `SectionLabel`, `role="heading"` level 3) and the count —
//   *4 criteria · 2 met · 1 not met · 1 can’t tell*, a zero count left out;
// - one `<li>` per stored row, in stored order: the status pill (words, glyph AND fill
//   differ, so the status is never colour alone), the criterion — after its card's key when
//   the rows span more than one card — and the evidence under it in secondary ink, its code
//   spans as inline chips. A row with no evidence says so.
// - below `sm` the row stacks, the pill above the criterion (F11).
//
// ⚠️ Evidence is NOT passed through the block prose renderer, which would force `text-sm`
// `--el-text` on it; only its inline code is lifted out.

const STATUS_ORDER: readonly ReviewChecklistStatus[] = ['met', 'not_met', 'cannot_tell'];

function StatusPill({ status }: { status: ReviewChecklistStatus }) {
  const t = useTranslations('approvalGate.reviewPath.view');
  const glyph = 'h-3 w-3 shrink-0';
  switch (status) {
    case 'met':
      return (
        <Pill severity="success" className="shrink-0">
          <Check className={glyph} aria-hidden />
          {t('statusMet')}
        </Pill>
      );
    case 'not_met':
      return (
        <Pill severity="warning" className="shrink-0">
          <X className={glyph} aria-hidden />
          {t('statusNotMet')}
        </Pill>
      );
    case 'cannot_tell':
      return (
        <Pill tone="neutral" className="shrink-0">
          <CircleHelp className={glyph} aria-hidden />
          {t('statusCannotTell')}
        </Pill>
      );
  }
}

/** Evidence text with its `code` spans lifted into inline chips. */
export function evidenceParts(evidence: string): ReactNode[] {
  const parts = evidence.split('`');
  // An unpaired backtick leaves an even number of segments: the last one opened a code span
  // nothing closes, so it is text — with its backtick — as Markdown reads it.
  const unpaired = parts.length % 2 === 0;
  return parts.map((part, index) => {
    const last = index === parts.length - 1;
    if (index % 2 === 1 && !(unpaired && last)) {
      return (
        <code
          key={index}
          className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-tooltip-x) font-mono text-[11.5px] text-(--el-code-text)"
        >
          {part}
        </code>
      );
    }
    return <span key={index}>{unpaired && last ? `\`${part}` : part}</span>;
  });
}

function ChecklistRow({
  row,
  showKey,
  compact,
}: {
  row: ReviewChecklistRowDto;
  showKey: boolean;
  compact: boolean;
}) {
  const t = useTranslations('approvalGate.reviewPath.view');
  return (
    <li
      data-checklist-status={row.status}
      className="grid grid-cols-1 gap-x-3 gap-y-1 border-b border-(--el-border-soft) py-(--spacing-control-y-8) last:border-b-0 sm:grid-cols-[6.75rem_minmax(0,1fr)]"
    >
      <span className="pt-px">
        <StatusPill status={row.status} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className={cn('m-0 leading-snug text-(--el-text)', compact ? 'text-[13px]' : 'text-sm')}>
          {showKey && row.key ? (
            <span className="mr-1.5 font-mono text-xs text-(--el-text-identifier)">{row.key}</span>
          ) : null}
          {row.criterion}
        </p>
        <p className="m-0 min-w-0 text-xs leading-relaxed [overflow-wrap:anywhere] text-(--el-text-secondary)">
          {row.evidence ? evidenceParts(row.evidence) : t('noEvidence')}
        </p>
      </div>
    </li>
  );
}

export function ReviewChecklist({
  rows,
  compact = false,
}: {
  rows: readonly ReviewChecklistRowDto[];
  /** The Activity entry's size (`text-[13px]` criteria). */
  compact?: boolean;
}) {
  const t = useTranslations('approvalGate.reviewPath.view');
  const headingId = useId();
  if (rows.length === 0) return null;
  const counts = STATUS_ORDER.map((status) => ({
    status,
    n: rows.filter((r) => r.status === status).length,
  })).filter((c) => c.n > 0);
  const countKey = {
    met: 'countMet',
    not_met: 'countNotMet',
    cannot_tell: 'countCannotTell',
  } as const;
  const summary = [
    t('checklistTotal', { total: rows.length }),
    ...counts.map((c) => t(countKey[c.status], { n: c.n })),
  ].join(' · ');
  // The key is the row's card: worth printing only when the rows span more than one card.
  const showKey = new Set(rows.map((r) => r.key)).size > 1;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5" data-review-checklist="">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <SectionLabel id={headingId} role="heading" aria-level={3}>
          {t('checklistHeading')}
        </SectionLabel>
        <span className="text-xs text-(--el-text-secondary)">{summary}</span>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((row, index) => (
          <ChecklistRow key={index} row={row} showKey={showKey} compact={compact} />
        ))}
      </ul>
    </section>
  );
}
