'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowUpRight, History, TriangleAlert } from 'lucide-react';
import { ReviewChecklist } from '@/components/approvals/ReviewChecklist';
import { ReviewedGlyph } from '@/components/approvals/ReviewedBadge';
import { Button } from '@/components/ui/Button';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Spinner } from '@/components/ui/Spinner';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import type { ReviewFindingsDto, ReviewFindingsRefDto } from '@/lib/dto/agentReview';
import type { ReviewFindingsTarget } from '@/components/approvals/ReviewFindingsInPlace';

// THE IN-PLACE FINDINGS VIEW — `ReviewFindingsDialog` (MOTIR-10460;
// `design/workbench/design-notes.md` § 42.1, § 42.4, § 42.7,
// `approvals-row--findings-in-place.mock.html` F1–F9, F11, F12).
//
// The package `Modal` at size `xl`: Radix gives the focus trap, Escape, the scrim press and
// focus return, and a second Radix dialog stacks over the approval overlay so Escape closes
// only this one. It is evidence, never a decision: nothing in it decides.
//
//   head    Findings and checklist · {title} · {key}; the verdict pill, the Earlier commits
//           pill for an earlier review, who reviewed and when, and the commits
//   body    the ONE scroll region (`role="region"`, focusable, focused on open): the
//           earlier-review note, the stored checklist, then the WHOLE findings
//   footer  Open the card · Close
//
// It READS when it opens — never with the list — and draws `loading`, `ready` and `error`;
// *Try again* re-reads in place. A press that a newer read replaced is ignored (`seq`).

/** GET the review through the session door; throws on anything but a 200. */
export async function readReviewFindings(
  identifier: string,
  ref: ReviewFindingsRefDto,
): Promise<ReviewFindingsDto> {
  const query = new URLSearchParams({ kind: ref.kind, id: ref.id });
  const res = await fetch(
    `/api/work-items/${encodeURIComponent(identifier)}/review-findings?${query.toString()}`,
    { headers: { Accept: 'application/json' }, cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`review findings ${res.status}`);
  return (await res.json()) as ReviewFindingsDto;
}

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; review: ReviewFindingsDto }
  | { status: 'error' };

const META = 'flex flex-wrap items-center gap-x-2 gap-y-1';

function ReviewMeta({ review, earlier }: { review: ReviewFindingsDto; earlier: boolean }) {
  const t = useTranslations('approvalGate.reviewPath.view');
  const tActivity = useTranslations('activity');
  const format = useFormatter();
  const at = new Date(review.at);
  const reviewer = review.reviewer;
  const who =
    reviewer.kind === 'hosted'
      ? t('byHosted')
      : reviewer.harness && reviewer.model
        ? t('byOwnHarness', {
            name: reviewer.name ?? tActivity('formerMember'),
            harness: reviewer.harness,
            model: reviewer.model,
          })
        : t('byOwn', { name: reviewer.name ?? tActivity('formerMember') });
  return (
    <div className="-mt-2 mb-(--spacing-md) flex shrink-0 flex-col gap-1 text-xs text-(--el-text-secondary)">
      <div className={META}>
        {review.verdict === 'pass' ? (
          <Pill severity="success" className="shrink-0">
            <ReviewedGlyph />
            {t('verdictPassed')}
          </Pill>
        ) : (
          <Pill severity="warning" className="shrink-0">
            {t('verdictSentBack')}
          </Pill>
        )}
        {earlier ? (
          <Pill tone="neutral" className="shrink-0">
            <History className="h-3 w-3 shrink-0" aria-hidden />
            {t('earlierTag')}
          </Pill>
        ) : null}
        <span>{who}</span>
        <span aria-hidden>·</span>
        <time
          dateTime={review.at}
          title={format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short' })}
        >
          {format.relativeTime(at)}
        </time>
      </div>
      {review.commits.length > 0 ? (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span>{t('commits')}</span>
          {review.commits.map((c) => (
            <span
              key={`${c.repo}#${c.number}`}
              className="font-mono text-(--el-text-identifier)"
            >{`${c.repo}#${c.number} @ ${c.headSha.slice(0, 7)}`}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EarlierNote() {
  const t = useTranslations('approvalGate.reviewPath.view');
  return (
    <p
      role="note"
      className="m-0 flex items-start gap-2 rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px] leading-snug text-(--el-text-strong)"
    >
      <History className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        {t.rich('earlierNote', {
          b: (chunks) => <b className="font-semibold text-(--el-text-strong)">{chunks}</b>,
        })}
      </span>
    </p>
  );
}

function Findings({ review }: { review: ReviewFindingsDto }) {
  const t = useTranslations('approvalGate.reviewPath.view');
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <SectionLabel id={headingId} role="heading" aria-level={3}>
        {t('findingsHeading')}
      </SectionLabel>
      {review.findingsMd ? (
        <MarkdownView
          value={review.findingsMd}
          workItemRefs={review.findingsRefs}
          className="min-w-0 text-sm"
          data-testid="review-findings-body"
        />
      ) : (
        <p className="m-0 text-sm text-(--el-text-secondary)">{t('noFindings')}</p>
      )}
    </section>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('approvalGate.reviewPath.view');
  return (
    <div className="flex min-h-40 flex-col items-start justify-center gap-3">
      <p
        role="alert"
        className="m-0 flex w-full items-start gap-2 rounded-(--radius-control) bg-(--el-danger-surface) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
      >
        <TriangleAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
          aria-hidden
        />
        <span>
          <b className="font-semibold">{t('errorTitle')}</b> {t('errorBody')}
        </span>
      </p>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

export function ReviewFindingsDialog({
  target,
  onClose,
  read = readReviewFindings,
}: {
  target: ReviewFindingsTarget;
  onClose: () => void;
  /** Injected by tests. */
  read?: typeof readReviewFindings;
}) {
  const t = useTranslations('approvalGate.reviewPath.view');
  const routes = useReaderRoutes();
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const { identifier, ref } = target;

  useEffect(() => {
    const mine = ++seq.current;
    read(identifier, ref).then(
      (review) => {
        if (mine === seq.current) setState({ status: 'ready', review });
      },
      () => {
        if (mine === seq.current) setState({ status: 'error' });
      },
    );
  }, [read, identifier, ref, attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  };

  const title = state.status === 'ready' ? state.review.title : target.title;
  const subtitle = title ? t('subtitle', { title, key: identifier }) : identifier;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="xl"
      title={t('title')}
      description={subtitle}
    >
      <div data-review-view={state.status} className="contents">
        {state.status === 'ready' ? (
          <ReviewMeta review={state.review} earlier={target.earlier} />
        ) : null}
        <Modal.Body
          role="region"
          aria-label={t('bodyLabel')}
          aria-busy={state.status === 'loading' || undefined}
          tabIndex={0}
          className="gap-5 rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {state.status === 'loading' ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-(--el-text-secondary)">
              <Spinner size="sm" aria-hidden />
              <span role="status">{t('loading')}</span>
            </div>
          ) : state.status === 'error' ? (
            <LoadError onRetry={retry} />
          ) : (
            <>
              {target.earlier ? <EarlierNote /> : null}
              <ReviewChecklist rows={state.review.checklist} />
              <Findings review={state.review} />
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Link
            href={routes.item(identifier)}
            onClick={onClose}
            className="mr-auto inline-flex items-center gap-1 text-sm text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {t('openCard')}
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </Link>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('close')}
          </Button>
        </Modal.Footer>
      </div>
    </Modal>
  );
}
