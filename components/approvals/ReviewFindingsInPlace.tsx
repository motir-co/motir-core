'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { ReviewFindingsDialog } from '@/components/approvals/ReviewFindingsDialog';
import type { ReviewFindingsRefDto } from '@/lib/dto/agentReview';

// *FINDINGS AND CHECKLIST* OPENS IN PLACE ON THE WORKBENCH (MOTIR-10460;
// `design/workbench/design-notes.md` § 42.3) — the provider that owns the one view, and the
// switch that turns it on.
//
// ⚠️ IN PLACE ONLY ON THE WORKBENCH. The three links that open the view — the review line on
// an approve-and-merge row, the Reviewed badge's card on that row, and the review line in the
// gate frame inside the approval overlay — are SHARED with the card page, whose Development
// frame keeps going to the card (MOTIR-10458's landing). The approval overlay is mounted ONCE
// in the shell, beside this provider, so it cannot tell by its place in the tree which page
// it is over. So the Workbench page mounts {@link ReviewFindingsInPlace}, and while it is
// mounted {@link useInPlaceFindings} hands each link a click handler; everywhere else it
// hands `null` and the link is the plain card link it always was.
//
// ⚠️ NOT WRITTEN TO THE ADDRESS. A plain primary click opens the view (`usePeekRowClick`'s
// contract); a modified, middle or secondary click keeps the real `href` (the card in a new
// tab). Nothing navigates, so the list underneath keeps its scroll, its rows, any row held
// after a decision and any open overlay. A navigation closes the view: it is drawn only on
// the page it was opened on.

/** What the view reads, and what it can show before the read lands. */
export interface ReviewFindingsTarget {
  identifier: string;
  /** The card's title, when the opener knows it — the subtitle while the read loads. */
  title: string | null;
  ref: ReviewFindingsRefDto;
  /** Opened from *Last reviewed at an earlier commit* (§ 42.4). */
  earlier: boolean;
}

type Opener = (target: ReviewFindingsTarget, returnFocusTo: HTMLElement | null) => void;

const EnableContext = createContext<(() => () => void) | null>(null);
const OpenerContext = createContext<Opener | null>(null);

/** A row door to fall back to when the opener's row is gone by the time the view closes. */
function nextRowDoorOf(opener: HTMLElement | null): HTMLElement | null {
  const row = opener?.closest('[role="row"]');
  const next = row?.nextElementSibling;
  return next?.querySelector<HTMLElement>('a[aria-haspopup="dialog"]') ?? null;
}

export function ReviewFindingsProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [enabled, setEnabled] = useState(0);
  const [open, setOpen] = useState<{ target: ReviewFindingsTarget; pathname: string } | null>(null);
  const returnFocus = useRef<{ opener: HTMLElement | null; fallback: HTMLElement | null }>({
    opener: null,
    fallback: null,
  });

  const enable = useCallback(() => {
    setEnabled((n) => n + 1);
    return () => setEnabled((n) => n - 1);
  }, []);

  const opener = useMemo<Opener | null>(
    () =>
      enabled > 0
        ? (target, returnFocusTo) => {
            returnFocus.current = {
              opener: returnFocusTo,
              fallback: nextRowDoorOf(returnFocusTo),
            };
            setOpen({ target, pathname });
          }
        : null,
    [enabled, pathname],
  );

  const close = useCallback(() => {
    setOpen(null);
    const { opener: from, fallback } = returnFocus.current;
    // Radix returns focus to what was focused before the view opened; a link inside the
    // badge's card is gone by then (the card closes as focus leaves it), and a live update
    // can remove the row. One frame later, put focus back on the opener, or on the next
    // row's door (§ 42.7), unless something already holds it.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (from?.isConnected) from.focus();
      else if (fallback?.isConnected) fallback.focus();
    });
  }, []);

  const shown = open !== null && enabled > 0 && open.pathname === pathname ? open.target : null;

  return (
    <EnableContext.Provider value={enable}>
      <OpenerContext.Provider value={opener}>
        {children}
        {shown ? <ReviewFindingsDialog target={shown} onClose={close} /> : null}
      </OpenerContext.Provider>
    </EnableContext.Provider>
  );
}

/** Mounted by the Workbench page: while it is, the findings links open in place. */
export function ReviewFindingsInPlace() {
  const enable = useContext(EnableContext);
  useEffect(() => enable?.(), [enable]);
  return null;
}

/**
 * The findings link's click handler while the view opens in place, else `null` — the link
 * then navigates to its `href` as it always did. `returnFocusTo` is what takes focus back
 * on close; it defaults to the link pressed.
 */
export function useInPlaceFindings():
  | ((
      event: MouseEvent<HTMLElement>,
      target: ReviewFindingsTarget,
      returnFocusTo?: HTMLElement | null,
    ) => void)
  | null {
  const opener = useContext(OpenerContext);
  return useMemo(
    () =>
      opener
        ? (event, target, returnFocusTo) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            ) {
              return;
            }
            event.preventDefault();
            opener(target, returnFocusTo ?? event.currentTarget);
          }
        : null,
    [opener],
  );
}
