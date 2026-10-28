import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Check,
  ExternalLink,
  FileQuestionMark,
  FileX,
  Files,
  History,
  Notebook,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { FrozenPill } from '@/components/pages/FrozenPill';
import { MarkdownView } from '@/components/ui/MarkdownView';
import type {
  DecisionDocumentViewDTO,
  DecisionDocumentViewReason,
} from '@/lib/dto/decisionDocument';

// THE DECISION SLOT (Story MOTIR-4907 · Subtask MOTIR-5678; `design/github/design-notes.md`
// §27, `approve-and-merge--decision.mock.html`). A decision card's document, drawn FIRST in
// the Development block's port — where a design card's result sits — with the pull
// requests beneath it.
//
// ⚠️ NO HOW TO TEST, in any state (§27, *Revised on review*, Yue 2026-09-19). A decision
// card ships a document, not something to run; a How-to-test part here would be an empty
// or invented section standing between the reader and the question. The block that hosts
// this slot leaves the part out for a decision, and this file draws none.
//
// ⚠️ DISPLAY-READY, AND READ ON THE SERVER. The Markdown and the file's link arrive in the
// DTO (`decisionDocumentService.readViewForWorkItem`); this component calls nothing. So
// do the summaries of the work items the document links (`workItemRefs`, bug
// MOTIR-10020): both `MarkdownView`s take them, or every chip draws as deleted.

const mono = (chunks: ReactNode) => <span className="font-mono text-xs">{chunks}</span>;
const bold = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;

/** The mark each reason is drawn with — the mock's three: a file that is not there, more
 *  than one file, and a file Motir could not look at. */
const REASON_ICON: Record<DecisionDocumentViewReason, typeof FileX> = {
  none: FileX,
  gone_at_head: FileX,
  several: Files,
  unreadable: FileQuestionMark,
  host_unreachable: FileQuestionMark,
  too_large: FileQuestionMark,
  not_connected: FileQuestionMark,
};

/** The copy key a reason renders. `unreadable` — the CAPTURE could not look — says the same
 *  as the READ's `host_unreachable`: both mean *Motir could not look* (§27, the mapping). */
function reasonCopyKey(
  reason: DecisionDocumentViewReason,
): Exclude<DecisionDocumentViewReason, 'unreadable'> {
  return reason === 'unreadable' ? 'host_unreachable' : reason;
}

/** Is there a document on screen to approve? The frame disables Approve whenever not. */
export function decisionDocumentShown(document: DecisionDocumentViewDTO | null): boolean {
  return document?.outcome === 'resolved' || document?.outcome === 'page';
}

export function DecisionDocumentSlot({
  document,
  acceptedLine = null,
}: {
  /** Null — nothing captured yet: the slot says the document cannot be read yet. */
  document: DecisionDocumentViewDTO | null;
  /**
   * Panel 5b — a push that left the document alone: the decision's answer STANDS, and it is
   * a line here, above the document, while the merge question leads the frame.
   */
  acceptedLine?: ReactNode;
}) {
  const t = useTranslations('approvalGate.decision');
  return (
    <div
      role="group"
      aria-label={t('portTitle')}
      data-testid="decision-document"
      className="flex min-w-0 flex-col gap-2 pb-1"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-[13px] font-semibold text-(--el-text)">{t('portTitle')}</h4>
      </div>
      {acceptedLine ? (
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-(--el-text-secondary)">
          <Check className="h-3.5 w-3.5 flex-none" aria-hidden />
          <span>{acceptedLine}</span>
        </span>
      ) : null}
      {document?.outcome === 'page' ? (
        <PageDocument document={document} />
      ) : document?.outcome === 'resolved' ? (
        <>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-(--el-text-secondary)">
            <span className="font-mono text-xs">{document.path}</span>
            <span>
              {document.headSha
                ? t.rich('meta', {
                    blob: document.blobSha.slice(0, 7),
                    head: document.headSha.slice(0, 7),
                    mono,
                  })
                : t.rich('metaNoHead', { blob: document.blobSha.slice(0, 7), mono })}
            </span>
            <HostLink href={document.hostUrl} />
          </span>
          <MarkdownView
            value={document.markdown}
            workItemRefs={document.workItemRefs}
            className="motir-how-to-test min-w-0"
          />
        </>
      ) : (
        <ReasonCallout
          reason={document?.outcome === 'unresolvable' ? document.reason : 'unreadable'}
          paths={document?.outcome === 'unresolvable' ? document.paths : []}
          hostUrl={document?.outcome === 'unresolvable' ? document.hostUrl : null}
        />
      )}
    </div>
  );
}

/**
 * A PUBLISHED PAGE VERSION (Story MOTIR-5761 · MOTIR-7436; `decision-port--page.mock.html`
 * deltas 1–3): the meta line — the page's title, *Version N · author · time*, the Frozen
 * chip once approved, *Open page* to that VERSION — then the changed-since notice when the
 * page has moved on, then the version's own stored text. Never the live page.
 */
function PageDocument({
  document,
}: {
  document: Extract<DecisionDocumentViewDTO, { outcome: 'page' }>;
}) {
  const t = useTranslations('approvalGate.decision.page');
  const format = useFormatter();
  const when = document.savedAt
    ? format.dateTime(new Date(document.savedAt), { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  return (
    <>
      <span
        data-testid="decision-page-meta"
        className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-(--el-text-secondary)"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Notebook className="h-3.5 w-3.5 flex-none" aria-hidden />
          <span className="font-semibold text-(--el-text)">{document.title}</span>
        </span>
        <span>
          {t('meta', {
            number: document.versionNumber,
            author: document.authorName ?? '',
            when,
          })}
        </span>
        {document.frozen ? <FrozenPill>{t('frozen')}</FrozenPill> : null}
        <Link
          href={document.versionUrl}
          className="inline-flex items-center gap-1 font-semibold text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {t('open')}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </span>
      {document.changedSince ? (
        <div
          role="status"
          data-testid="decision-page-changed"
          className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-warning-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-[13px] leading-normal text-(--el-text-strong)"
        >
          <History className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {t.rich(document.frozen ? 'changedSinceApproved' : 'changedSince', {
              number: document.versionNumber,
              b: bold,
            })}{' '}
            <Link
              href={document.compareUrl}
              className="inline-flex items-center gap-1 font-semibold text-(--el-link) hover:text-(--el-link-pressed)"
            >
              {t('compareWithCurrent')}
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </span>
        </div>
      ) : null}
      <MarkdownView
        value={document.markdown}
        workItemRefs={document.workItemRefs}
        className="motir-how-to-test min-w-0"
      />
    </>
  );
}

function HostLink({ href }: { href: string }) {
  const t = useTranslations('approvalGate.decision');
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-semibold text-(--el-link) hover:text-(--el-link-pressed)"
    >
      {t('viewOnHost')}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

/** Panels 3a–3d — the block's missing-state callout, with the reason in words. */
function ReasonCallout({
  reason,
  paths,
  hostUrl,
}: {
  reason: DecisionDocumentViewReason;
  paths: readonly string[];
  hostUrl: string | null;
}) {
  const t = useTranslations('approvalGate.decision');
  const Icon = REASON_ICON[reason];
  const key = reasonCopyKey(reason);
  return (
    <div
      role="status"
      data-reason={reason}
      className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-callout-bg) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-[13px] leading-normal text-(--el-callout-text)"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        {key === 'several'
          ? t.rich('unresolvable.several', {
              count: paths.length,
              paths: paths.join(', '),
              b: bold,
            })
          : t.rich(`unresolvable.${key}`, { b: bold, mono })}
        {hostUrl ? (
          <>
            {' '}
            <HostLink href={hostUrl} />
          </>
        ) : null}
      </span>
    </div>
  );
}
