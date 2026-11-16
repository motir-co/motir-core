'use client';

import { useRef, type ReactNode, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { useColumnArrows, useDragToPan } from './boardHorizontalNav';

// The column arrows (MOTIR-11323), built to design MOTIR-11326
// (`design/boards/board--column-arrows.mock.html`, design-notes § *Placement*,
// § *The button treatment*, § *The states*). Two gutters BESIDE the board scroll
// row — never over it, so no arrow covers a card, a column header or its controls:
//
//   [ left arrow gutter ] [ board scroll row (+ pager below sm) ] [ right arrow gutter ]
//
// Each gutter is the 32px arrow plus the row's 8px separation, `hidden` below `sm`
// (the shipped dot pager stays the phone's control). The arrow sits level with the
// column-header row (`sticky top-0 pt-[5px]` centres the 32px button on the ~42px
// header strip on both boards). At an end the arrow is DISABLED, not hidden, so the
// pair does not jump; when nothing overflows neither arrow nor gutter renders. The
// left gutter precedes the row in the DOM and the right one follows it, matching
// what the eye reads. The wrapper also binds drag-to-pan on the row.

export function BoardColumnArrows({
  rowRef,
  contentKey,
  settle = false,
  children,
}: {
  /** The board scroll row the arrows move. */
  rowRef: RefObject<HTMLElement | null>;
  /** Changes when the row's columns change, so the overflow is measured again. */
  contentKey: unknown;
  /** Settle a pan on the nearest column edge — for a row that scroll-snaps. */
  settle?: boolean;
  /** The row itself (and, on the flat board, the pager below it). */
  children: ReactNode;
}) {
  const t = useTranslations('boards');
  const navRef = useRef<HTMLDivElement>(null);
  const { overflowing, atStart, atEnd, step } = useColumnArrows(rowRef, navRef, contentKey);
  // Drag-to-pan rides the same mount as the arrows: this wrapper renders with the
  // row, so the row is in the DOM when the gesture binds to it.
  useDragToPan(rowRef, { settle });

  return (
    <div ref={navRef} data-board-nav="" className="flex min-w-0 items-stretch gap-2">
      {overflowing ? (
        <ColumnArrow
          direction="previous"
          label={t('columnArrowPrevious')}
          disabled={atStart}
          onPress={() => step('previous')}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
      {overflowing ? (
        <ColumnArrow
          direction="next"
          label={t('columnArrowNext')}
          disabled={atEnd}
          onPress={() => step('next')}
        />
      ) : null}
    </div>
  );
}

function ColumnArrow({
  direction,
  label,
  disabled,
  onPress,
}: {
  direction: 'previous' | 'next';
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const Icon = direction === 'previous' ? ChevronLeft : ChevronRight;
  return (
    <div className="hidden shrink-0 sm:block" data-column-arrow-gutter={direction}>
      <div className="sticky top-0 pt-[5px]">
        <Tooltip content={label} side="top">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-(--height-btn-sm) px-0"
            aria-label={label}
            data-column-arrow={direction}
            data-testid={`board-column-arrow-${direction}`}
            disabled={disabled}
            onClick={onPress}
          >
            <Icon className="size-4" aria-hidden />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
