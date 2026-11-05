'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Bot } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { ReviewCommand } from '@/components/approvals/ReviewCommand';
import { useRelativeLabel } from './useRelativeLabel';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import type { ReviewToRunRowDTO } from '@/lib/dto/reviewState';

// A REVIEW TO RUN on To approve (Story MOTIR-10327 · MOTIR-10342; `design/github/design-notes.md`
// § 32.5, `approvals-row--review-path.mock.html` A2) — a card whose review waits on the
// reader's OWN agent, listed AS A REVIEW TO RUN, NOT AN APPROVAL. Told apart from an approval
// row by every cell: a `Bot` on the 18px yellow disc (an approval row has its kind glyph), the
// sentence *Review {title} with your agent*, the command chip in the DETAILS track, the
// *Review to run* tag in the Decide track (where an approval row has *Review*), and the second
// line *Not an approval yet…*. Pressing the row opens the card — there is no overlay for it.
// Copy is the one verb.

export function ReviewToRunRow({
  row,
  gridTemplate,
}: {
  row: ReviewToRunRowDTO;
  gridTemplate: string;
}) {
  const t = useTranslations('approvalGate.reviewPath.toRun');
  const locale = useLocale();
  const routes = useReaderRoutes();
  const relativeLabel = useRelativeLabel();
  const titleChunk = (chunks: ReactNode) => (
    <span className="font-medium text-(--el-text)">{chunks}</span>
  );
  const sentenceText = t.markup('sentence', { name: row.title, title: (chunks) => chunks });
  return (
    <div
      role="row"
      data-testid={`review-to-run-row-${row.gateId}`}
      data-review-to-run=""
      className="group relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0 hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2 md:grid md:items-center md:gap-x-4 md:gap-y-1 md:py-2 md:pr-4 md:pl-4"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        <Link
          href={routes.item(row.identifier)}
          aria-label={t('open', { key: row.identifier, sentence: sentenceText })}
          className="absolute inset-0 z-0 focus:outline-none"
        />
        <span
          className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-tint-yellow) text-(--el-text-strong)"
          aria-hidden
        >
          <Bot className="h-3 w-3" />
        </span>
        <span className="min-w-0 truncate text-sm text-(--el-text-secondary)">
          {t.rich('sentence', { name: row.title, title: titleChunk })}
        </span>
        <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
          {row.identifier}
        </span>
      </div>
      <div role="presentation" className="flex flex-wrap items-center gap-2 pl-6 md:contents">
        <div role="cell" className="relative z-10 flex min-w-0 items-center">
          <ReviewCommand command={row.command} identifier={row.identifier} />
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          <span
            className="truncate text-xs text-(--el-text-secondary)"
            title={new Date(row.raisedAt).toLocaleString(locale)}
          >
            {relativeLabel(row.raisedAt)}
          </span>
        </div>
        <div role="cell" className="flex min-w-0 items-center md:justify-end">
          <Pill tone="awaiting" className="whitespace-nowrap">
            {t('tag')}
          </Pill>
        </div>
      </div>
      <div role="cell" className="min-w-0 pl-6 md:col-span-full md:col-start-1">
        <span className="text-xs text-(--el-text-secondary)">{t('details')}</span>
      </div>
    </div>
  );
}
