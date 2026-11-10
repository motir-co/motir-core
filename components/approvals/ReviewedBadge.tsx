'use client';

import { useId, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Bot, Check } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { useInPlaceFindings } from '@/components/approvals/ReviewFindingsInPlace';
import { findingsHrefOf } from '@/lib/agentReview/verdictActivity';
import { cn } from '@/lib/utils/cn';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import type { CardReviewDTO, ReviewReviewerDTO } from '@/lib/dto/reviewState';

// THE REVIEWED BADGE (Story MOTIR-10327 · MOTIR-10341; `design/github/design-notes.md`
// § 32.3, `design/work-items/decision-waiting--review-path.mock.html` M5, M6, M8, M10, M11) —
// one component, two forms; exported for the To approve row too.
//
//   · label — `Pill severity="success"` · the icon pair · *Reviewed*: the board card (after
//     the slot, before the CI badge) and the item header (after the marker);
//   · glyph — an 18px mint disc in the List / Tree status cell, `role="img"`, FOCUSABLE;
//
// A container wears no badge of its own: the *n of m reviewed* container form was dropped
// (its count read every card under a page's epics and ran `/items` past its transaction
// limit).
//
// ⚠️ IT DRAWS ONLY WHAT IT IS GIVEN. The read model returns `reviewed` only at the current
// delivery-set version and never for a Done card — so a push or a Done card simply hand it
// nothing.
//
// ⚠️ THE CARD OPENS ON POINTER HOVER **OR KEYBOARD FOCUS** (§ 32.3), closes on Escape or
// when focus leaves it, and is the badge's `aria-describedby`. On the board card the badge
// is NOT interactive — the whole card is one button — so it carries a `title` and the
// card's own `aria-describedby` names it.

/** The icon pair every form wears: `Bot` with a small check disc at its lower right. */
export function ReviewedGlyph({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)} aria-hidden>
      <Bot className="h-3 w-3" />
      <span className="absolute -right-1 -bottom-1 inline-flex h-2 w-2 items-center justify-center rounded-full bg-(--el-success) text-(--el-text-inverted) ring-1 ring-(--el-page-bg)">
        <Check className="h-1.5 w-1.5" strokeWidth={4} />
      </span>
    </span>
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The hover / focus card's lines (M8, M10). */
function ReviewedCardBody({
  review,
  reviewer,
  at,
}: {
  review: CardReviewDTO;
  reviewer: ReviewReviewerDTO;
  at: string;
}) {
  const t = useTranslations('approvalGate.reviewPath.badge.card');
  const tGate = useTranslations('approvalGate');
  const format = useFormatter();
  const routes = useReaderRoutes();
  const when = new Date(at);
  // ON THE WORKBENCH the card's link opens the review IN PLACE (MOTIR-10460; § 42.3, F8). The
  // card closes as focus leaves it, so focus returns to the badge that opened it.
  const inPlace = useInPlaceFindings();
  const recordRef = review.recordRef;
  const findingsHref = findingsHrefOf(routes.item(review.identifier), review.recordRef);
  return (
    <>
      <p className="m-0 font-medium text-(--el-text)">
        {reviewer.kind === 'hosted'
          ? t('hosted')
          : t('own', { name: reviewer.person?.name ?? tGate('theAssignee') })}
      </p>
      {reviewer.kind === 'own' ? (
        <p className="m-0 text-(--el-text-secondary)">
          {t('harness', { harness: reviewer.harness, model: reviewer.model })}
        </p>
      ) : null}
      <p className="m-0 text-(--el-text-secondary)">
        <time
          dateTime={at}
          title={format.dateTime(when, { dateStyle: 'medium', timeStyle: 'short' })}
        >
          {format.relativeTime(when)}
        </time>
      </p>
      <p className="m-0 mt-1 text-(--el-text-secondary)">{t('commits')}</p>
      <ul className="m-0 list-none p-0">
        {(review.reviewed?.commits ?? []).map((c) => (
          <li key={`${c.repo}#${c.number}`} className="font-mono text-(--el-text-identifier)">
            {`${c.repo}#${c.number} @ ${shortSha(c.headSha)}`}
          </li>
        ))}
      </ul>
      {findingsHref ? (
        <Link
          href={findingsHref}
          aria-haspopup={inPlace ? 'dialog' : undefined}
          onClick={
            inPlace && recordRef
              ? (e) =>
                  inPlace(
                    e,
                    { identifier: review.identifier, title: null, ref: recordRef, earlier: false },
                    e.currentTarget
                      .closest('[data-reviewed-host]')
                      ?.querySelector<HTMLElement>('[data-reviewed-badge]') ?? null,
                  )
              : undefined
          }
          className="mt-1 inline-block text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {t('link')}
        </Link>
      ) : null}
    </>
  );
}

/** The badge plus its hover / focus card, for an interactive surface. */
function WithReviewedCard({
  trigger,
  card,
}: {
  trigger: (props: { 'aria-describedby': string | undefined }) => ReactNode;
  card: ReactNode;
}) {
  const cardId = useId();
  const [open, setOpen] = useState(false);
  const onBlur = (e: FocusEvent<HTMLSpanElement>) => {
    // Focus moving INTO the card (its link) keeps it open.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <span
      data-reviewed-host=""
      className="relative inline-flex min-w-0 shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {trigger({ 'aria-describedby': open ? cardId : undefined })}
      {open ? (
        <span
          id={cardId}
          data-surface="popover"
          data-testid="reviewed-card"
          className="absolute top-full left-0 z-30 mt-1 flex w-max max-w-[18rem] flex-col gap-0.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding-12) text-left text-xs whitespace-normal shadow-(--shadow-elevated)"
        >
          {card}
        </span>
      ) : null}
    </span>
  );
}

export function ReviewedBadge({
  review,
  form = 'label',
  interactive = true,
  id,
}: {
  review: CardReviewDTO;
  /** `label` on a board card and the item header; `glyph` in a List / Tree status cell. */
  form?: 'label' | 'glyph';
  /** False on a board card, which is one button: a title, and no hover card. */
  interactive?: boolean;
  /** For the board card's `aria-describedby`. */
  id?: string;
}) {
  const t = useTranslations('approvalGate.reviewPath.badge');

  const reviewed = review.reviewed;
  if (!reviewed) return null;
  const name = t('reviewedName');
  const card = <ReviewedCardBody review={review} reviewer={reviewed.reviewer} at={reviewed.at} />;

  if (form === 'glyph') {
    return (
      <WithReviewedCard
        card={card}
        trigger={(described) => (
          <span
            id={id}
            role="img"
            tabIndex={0}
            aria-label={name}
            title={name}
            data-reviewed-badge="reviewed"
            className="relative z-10 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-tint-mint) text-(--el-text-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            {...described}
          >
            <ReviewedGlyph />
          </span>
        )}
      />
    );
  }

  const pill = (described: { 'aria-describedby'?: string | undefined } = {}) => (
    <Pill
      id={id}
      severity="success"
      title={name}
      className={cn(
        'shrink-0',
        interactive &&
          'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
      )}
      data-reviewed-badge="reviewed"
      {...(interactive ? { tabIndex: 0, role: 'note', 'aria-label': name } : {})}
      {...described}
    >
      <ReviewedGlyph />
      {t('reviewed')}
    </Pill>
  );
  if (!interactive) return pill();
  return <WithReviewedCard card={card} trigger={(described) => pill(described)} />;
}
