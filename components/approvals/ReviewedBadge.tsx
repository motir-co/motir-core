'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Bot, Check } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
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
// when focus leaves it, and is the badge's `aria-describedby`. It is portalled, so no list
// that clips its rows can cut it off (MOTIR-11327). An interactive badge carries NO `title`:
// the card is its description, and a browser tooltip on top of it said the same thing twice.
// On the board card the badge is NOT interactive — the whole card is one button — so it
// carries a `title` and the card's own `aria-describedby` names it.

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
  const host = useContext(ReviewedHostContext);
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
                    badgeIn(host?.current),
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

/**
 * THE BADGE'S HOST, for the card's *Findings and checklist* link: the in-place view hands focus
 * back to the badge when it closes, and the card is portalled, so the link cannot find the
 * badge by walking up its own DOM.
 */
const ReviewedHostContext = createContext<RefObject<HTMLSpanElement | null> | null>(null);

/** The badge inside a host — the element focus returns to. */
function badgeIn(host: HTMLElement | null | undefined): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-reviewed-badge]') ?? null;
}

/** How long the card stays open after the pointer leaves, so it can cross onto the card. */
export const REVIEWED_CARD_CLOSE_DELAY_MS = 120;

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

function tabbablesIn(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    // Radix's focus guards bracket the page while a layer is open; they are not a stop.
    (el) => el.tabIndex >= 0 && !el.hasAttribute('data-radix-focus-guard'),
  );
}

/** The first tabbable AFTER the host in document order, outside the host and the card. */
function nextTabbableAfter(host: HTMLElement, card: HTMLElement | null): HTMLElement | null {
  return (
    tabbablesIn(host.ownerDocument).find(
      (el) =>
        !host.contains(el) &&
        !card?.contains(el) &&
        (host.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ) ?? null
  );
}

/** Open state with a short, cancellable close, so the pointer can cross the gap onto the card. */
function useHoverIntent() {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const show = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const hide = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);
  const hideSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(hide, REVIEWED_CARD_CLOSE_DELAY_MS);
  }, [cancelClose, hide]);
  useEffect(() => cancelClose, [cancelClose]);
  return { open, show, hide, hideSoon };
}

/**
 * Tab across a portalled card in the order the in-place card had: from the badge forward into
 * the card, from the card's first stop back to the badge, from its last stop on to whatever
 * follows the badge in the page. Answers the element to focus, or null to leave Tab alone.
 */
function tabTarget(
  host: HTMLElement,
  cardEl: HTMLElement,
  target: HTMLElement,
  backwards: boolean,
): { next: HTMLElement | null; leaves: boolean } {
  const inCard = tabbablesIn(cardEl);
  const from = inCard.indexOf(target);
  if (from === -1) return { next: backwards ? null : (inCard[0] ?? null), leaves: false };
  if (backwards && from === 0) return { next: badgeIn(host), leaves: false };
  if (!backwards && from === inCard.length - 1) {
    return { next: nextTabbableAfter(host, cardEl), leaves: true };
  }
  return { next: null, leaves: false };
}

/** The host's focus, blur and key handling, and the layer's outside-interaction guard. */
function useCardInteractions(
  hostRef: RefObject<HTMLSpanElement | null>,
  cardRef: RefObject<HTMLDivElement | null>,
  { open, show, hide }: { open: boolean; show: () => void; hide: () => void },
) {
  // Escape hands focus back to the badge; that focus must not open the card again.
  const refocusing = useRef(false);
  const within = (node: EventTarget | null) =>
    node instanceof Node &&
    (hostRef.current?.contains(node) === true || cardRef.current?.contains(node) === true);

  const onFocus = () => {
    if (!refocusing.current) show();
  };
  const onBlur = (e: FocusEvent<HTMLSpanElement>) => {
    // Focus moving INTO the card (its link) keeps it open.
    if (!within(e.relatedTarget)) hide();
  };
  const onEscape = (e: KeyboardEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    const fromCard = cardRef.current?.contains(e.target as Node) === true;
    hide();
    if (!fromCard) return;
    refocusing.current = true;
    badgeIn(hostRef.current)?.focus();
    refocusing.current = false;
  };
  const onTab = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (!hostRef.current || !cardRef.current) return;
    const { next, leaves } = tabTarget(
      hostRef.current,
      cardRef.current,
      e.target as HTMLElement,
      e.shiftKey,
    );
    if (!next) return;
    e.preventDefault();
    if (leaves) hide();
    next.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (!open) return; // Escape and Tab on a closed card are left for the page.
    if (e.key === 'Escape') onEscape(e);
    else if (e.key === 'Tab') onTab(e);
  };
  // The badge itself is not outside the card's layer: focusing or pressing it keeps it open.
  const keepIfOnHost = (e: { target: EventTarget | null; preventDefault: () => void }) => {
    if (within(e.target)) e.preventDefault();
  };
  return { onFocus, onBlur, onKeyDown, keepIfOnHost };
}

/**
 * The badge plus its hover / focus card, for an interactive surface.
 *
 * ⚠️ THE CARD IS PORTALLED (MOTIR-11327) through the design system's `Popover`, anchored on the
 * badge. Drawn in place it was clipped by every `overflow-hidden` list that holds a row (the
 * Workbench's To approve list, `/approvals`) and painted UNDER the next row's badge, whose
 * `relative z-10` wrapper starts a stacking context the card's own z-index could not leave.
 * A portal reproduces the in-place card's behaviour by hand: React carries focus and pointer
 * events from the card up to the host, so the host still sees focus move INTO the link; the
 * pointer gets {@link REVIEWED_CARD_CLOSE_DELAY_MS} to cross onto the card; and Tab from the
 * badge moves into the card and on past the badge, in the order the in-place card had.
 */
function WithReviewedCard({
  trigger,
  card,
}: {
  trigger: (props: { 'aria-describedby': string | undefined }) => ReactNode;
  card: ReactNode;
}) {
  const cardId = useId();
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const intent = useHoverIntent();
  const { open, show, hide, hideSoon } = intent;
  const { onFocus, onBlur, onKeyDown, keepIfOnHost } = useCardInteractions(
    hostRef,
    cardRef,
    intent,
  );

  return (
    <ReviewedHostContext.Provider value={hostRef}>
      <Popover open={open} onOpenChange={(next) => (next ? show() : hide())} modal={false}>
        <Popover.Anchor asChild>
          <span
            ref={hostRef}
            data-reviewed-host=""
            className="relative inline-flex min-w-0 shrink-0"
            onMouseEnter={show}
            onMouseLeave={hideSoon}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
          >
            {trigger({ 'aria-describedby': open ? cardId : undefined })}
            {open ? (
              <Popover.Content
                ref={cardRef}
                id={cardId}
                // A description of the badge, not a dialog (Radix's default role).
                role={undefined}
                data-testid="reviewed-card"
                align="start"
                sideOffset={4}
                collisionPadding={8}
                width="max-content"
                onMouseEnter={show}
                onMouseLeave={hideSoon}
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => e.preventDefault()}
                onFocusOutside={keepIfOnHost}
                onPointerDownOutside={keepIfOnHost}
                className="flex max-w-[18rem] flex-col gap-0.5 p-(--spacing-card-padding-12) text-left text-xs whitespace-normal"
              >
                {card}
              </Popover.Content>
            ) : null}
          </span>
        </Popover.Anchor>
      </Popover>
    </ReviewedHostContext.Provider>
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
      // The card replaces the browser tooltip on an interactive badge (MOTIR-11327): both
      // opened at once. The board card's badge has no card, so it keeps its title.
      title={interactive ? undefined : name}
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
