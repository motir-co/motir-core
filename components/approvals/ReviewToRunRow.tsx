'use client';

import type { MouseEvent, ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Bot, ScanSearch, Sparkles } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { ReviewCommand } from '@/components/approvals/ReviewCommand';
import {
  ReviewHostedRefusalNotice,
  ReviewHostedRow,
  useReviewWithMotirAgent,
} from '@/components/github/ReviewHostedDoor';
import { ModelsEmpty, ModelsUnavailable } from '@/components/hosted/ContinueHostedControl';
import { useHostedModels } from '@/components/hosted/HostedModelsProvider';
import { useSurfaceTitleText } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { useRelativeLabel } from './useRelativeLabel';
import { useOpenApproval } from './useOpenApproval';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { usePeekRowClick } from '@/app/(authed)/items/_components/IssueQuickView';
import type { ReviewToRunRowDTO } from '@/lib/dto/reviewState';

// A REVIEW TO RUN on Waiting on you (Story MOTIR-10327 · MOTIR-10342; source-free words since
// Story MOTIR-11941 · MOTIR-11947) — a card whose review waits for someone to START it, listed
// AS A REVIEW TO RUN, NOT AN APPROVAL. LAID OUT LIKE A TO FIX ROW since MOTIR-12032
// (`design/workbench/design-notes.md` § 45, `approvals-row--review-to-run-as-fix.mock.html`):
//
//   LINE 1 — the work item, on the approvals grid: the `Bot` on the 18px yellow disc (an
//            approval row has its kind glyph), the key, the title; an EMPTY DETAILS cell (kept
//            so WAITED and the tag stay under their headers); WAITED; the *Review to run* tag.
//   LINE 2 — WHY on the left (*Waiting for a review.* …), WHAT STARTS IT on the right: door 1
//            *Review with Motir agent* (the review doors' own, § 33.4) for a reader who may run
//            the card hosted, then the `motir review {key}` chip, which keeps the right edge;
//            the credits note under door 1, and its refusals in the full-width slot below.
//
// ⚠️ PRESSING THE ROW OPENS THE `agent_review` APPROVAL OVERLAY IN PLACE (Bug MOTIR-11983;
// `design/github/design-notes.md` § 34), as every other Waiting on you row opens its own —
// never a trip to the item page. The overlay holds the review's state, *Review in my agent*
// and *Continue without the review*. A modifier or non-primary click keeps the link's native
// meaning (the item, in a new tab), which is why the href stays real. Line 2's right group
// sits ABOVE the stretched link (`relative z-10`), so pressing a door or the chip never opens
// the overlay.
//
// THE TITLE IS A DOOR (Task MOTIR-12064), as an approval row's is (`ApprovalRow.tsx`
// `SentenceTitle`; `design/workbench/design-notes.md` § 28, DECISION 3): the work item's QUICK
// VIEW over the Workbench, with `usePeekRowClick`'s contract — a modified, middle or secondary
// click keeps the real `href` (the item in a new tab). It sits above the stretched link on
// `z-10`, so the rest of the row still opens the overlay, and only the door under the pointer
// underlines.

export function ReviewToRunRow({
  row,
  gridTemplate,
  onChanged,
}: {
  row: ReviewToRunRowDTO;
  gridTemplate: string;
  /** Re-read the list: a review started (the row leaves the tab) or the page went stale. */
  onChanged?: () => void;
}) {
  const t = useTranslations('approvalGate.reviewPath.toRun');
  const locale = useLocale();
  const routes = useReaderRoutes();
  const relativeLabel = useRelativeLabel();
  // The title in the reader's language where the project auto-translates, as `ApprovalRow`'s.
  const shownTitle = useSurfaceTitleText(row.workItemId, row.title);
  const sentenceText = t.markup('sentence', { name: shownTitle, title: (chunks) => chunks });
  const openApproval = useOpenApproval();
  const peekRowClick = usePeekRowClick();
  function onRowClick(e: MouseEvent<HTMLAnchorElement>) {
    // `ApprovalRow`'s exact condition: keyboard Enter on the anchor dispatches a primary
    // click, so it takes this same path.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openApproval({ workItem: { identifier: row.identifier }, kind: 'agent_review' });
  }
  return (
    <div
      role="row"
      data-testid={`review-to-run-row-${row.gateId}`}
      data-review-to-run=""
      className="group relative flex flex-col gap-1 border-b border-(--el-border) px-4 py-2.5 last:border-b-0 hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2 md:pt-0 md:pr-4 md:pb-2.5 md:pl-4"
    >
      {/* LINE 1 — the To fix line 1's title-cell grammar on the approvals grid. */}
      <div
        role="presentation"
        className="flex flex-col gap-1 md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div role="cell" className="flex min-w-0 items-center gap-2">
          <Link
            href={routes.item(row.identifier)}
            aria-haspopup="dialog"
            aria-label={t('open', { key: row.identifier, sentence: sentenceText })}
            onClick={onRowClick}
            className="absolute inset-0 z-0 focus:outline-none"
          />
          <span
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-tint-yellow) text-(--el-text-strong)"
            aria-hidden
          >
            <Bot className="h-3 w-3" />
          </span>
          <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
            {row.identifier}
          </span>
          <span className="flex min-w-0 flex-1">
            <Link
              href={routes.item(row.identifier)}
              data-testid={`review-to-run-title-${row.identifier}`}
              onClick={(e) => peekRowClick(e, row.identifier)}
              className="relative z-10 min-w-0 truncate text-sm text-(--el-text) hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {shownTitle}
            </Link>
          </span>
        </div>
        <div role="presentation" className="flex flex-wrap items-center gap-2 pl-6 md:contents">
          {/* DETAILS — empty (§ 45.1): the command moved to line 2's right end. */}
          <div
            role="cell"
            data-testid={`review-to-run-details-${row.identifier}`}
            className="hidden min-w-0 md:flex"
          />
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
      </div>
      <ReviewToRunLine row={row} onChanged={onChanged} />
    </div>
  );
}

/** LINE 2 (§ 45.2) — why it waits, and what starts the review. */
function ReviewToRunLine({ row, onChanged }: { row: ReviewToRunRowDTO; onChanged?: () => void }) {
  const t = useTranslations('approvalGate.reviewPath.toRun');
  const hosted = useHostedModels();
  const press = useReviewWithMotirAgent(row.identifier, {
    onStarted: onChanged,
    onStateMoved: onChanged,
  });
  // Door 1 is the reader's who may run the card hosted, under the list's models provider;
  // the hosted kill-switch (`ORG_FEATURE_DISABLED`) hides it, as on the review doors.
  const hostedShown = row.canReviewHosted && hosted !== null && press.refusal?.kind !== 'laneOff';
  const b = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;
  return (
    <div
      role="cell"
      data-testid={`review-to-run-line-${row.identifier}`}
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-6 text-xs"
    >
      <p className="m-0 flex min-w-0 items-center gap-1.5 text-(--el-text)">
        <ScanSearch className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
        <span className="min-w-0 truncate">{t.rich('reason', { b })}</span>
      </p>
      <span className="relative z-10 ml-auto flex flex-wrap items-center justify-end gap-2">
        {hostedShown ? (
          <ReviewHostedRow
            starting={press.starting}
            onPress={() => void press.start()}
            refused={press.refusal?.kind === 'noCapacity'}
          />
        ) : null}
        <ReviewCommand command={row.command} identifier={row.identifier} />
      </span>
      {hostedShown ? (
        <p
          className="m-0 inline-flex basis-full items-start justify-end gap-1.5 text-xs leading-normal text-(--el-text-secondary)"
          data-testid="review-to-run-credits-note"
        >
          <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{t('creditsNote')}</span>
        </p>
      ) : null}
      {hostedShown ? <HostedSlot refusal={press.refusal} /> : null}
    </div>
  );
}

/** The full-width slot under line 2 (§ 45.3): a refusal, or why no model can be picked. */
function HostedSlot({
  refusal,
}: {
  refusal: ReturnType<typeof useReviewWithMotirAgent>['refusal'];
}) {
  const models = useHostedModels();
  let body: ReactNode = null;
  if (refusal) body = <ReviewHostedRefusalNotice refusal={refusal} />;
  else if (models?.models.state === 'unavailable') {
    body = <ModelsUnavailable onRetry={models.reloadModels} testIdPrefix="review-hosted" />;
  } else if (models?.models.state === 'ok' && models.models.models.length === 0) {
    body = <ModelsEmpty testIdPrefix="review-hosted" />;
  }
  if (!body) return null;
  return <div className="relative z-10 basis-full">{body}</div>;
}
