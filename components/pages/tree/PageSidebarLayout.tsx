'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

// THE PAGE'S SIDEBAR COLUMN (Story MOTIR-5753 · MOTIR-7375) —
// `design/pages/page--tree-sidebar.mock.html` panels 1 and 3, `design-notes.md`
// § The page tree, "The page — sidebar and breadcrumb".
//
// A 248px `<aside>` beside the page, `--el-surface-soft` with a right rule: its
// head links back to `/pages` and holds Hide page tree; its body is the `tree`
// the page hands in (`PageTree` at compact density, the page selected and its
// path open). The breadcrumb row leads with Show page tree whenever the column
// is not showing.
//
// ── WHEN IT SHOWS (panel 3) ────────────────────────────────────────────────
// At **1280px and wider** it shows unless the reader HID it — a per-viewer
// `localStorage` convenience (it may come back empty or throw, and then the
// column shows). **Below 1280px** it starts hidden — the rail, a 248px tree and
// a 760px reading column do not fit — and Show page tree opens the SAME aside as
// an overlay drawer over a scrim, closed by Esc, by the scrim, or by choosing a
// page. Which of the two a width gets is decided by CSS on first paint (`xl:`),
// so the server's HTML is right before any script runs; the stored preference
// and the media query are read through `useSyncExternalStore`, whose server
// snapshot is "shown, wide".
//
// One aside serves both forms, so the tree inside it keeps its state (what the
// reader opened) when the drawer closes or the width changes.

/** The stored "hidden at a wide width" preference — per viewer, per device. */
export const PAGE_SIDEBAR_HIDDEN_STORAGE_KEY = 'motir.pages.sidebar.hidden';

/** At this width and wider the column docks beside the page (`xl`). */
export const PAGE_SIDEBAR_WIDE_QUERY = '(min-width: 1280px)';

// ── The stored preference ─────────────────────────────────────────────────
const hiddenListeners = new Set<() => void>();
let hiddenCache: boolean | undefined;

function readHidden(): boolean {
  if (hiddenCache !== undefined) return hiddenCache;
  try {
    hiddenCache = window.localStorage.getItem(PAGE_SIDEBAR_HIDDEN_STORAGE_KEY) === 'true';
  } catch {
    hiddenCache = false;
  }
  return hiddenCache;
}

function writeHidden(next: boolean): void {
  hiddenCache = next;
  try {
    if (next) window.localStorage.setItem(PAGE_SIDEBAR_HIDDEN_STORAGE_KEY, 'true');
    else window.localStorage.removeItem(PAGE_SIDEBAR_HIDDEN_STORAGE_KEY);
  } catch {
    // Storage is a convenience: the choice still holds for this visit.
  }
  for (const listener of hiddenListeners) listener();
}

function subscribeHidden(listener: () => void): () => void {
  hiddenListeners.add(listener);
  return () => {
    hiddenListeners.delete(listener);
  };
}

/** Test hook — forget the cached preference so the next read goes to storage. */
export function resetPageSidebarPreferenceForTests(): void {
  hiddenCache = undefined;
}

// ── The width ─────────────────────────────────────────────────────────────
function wideQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(PAGE_SIDEBAR_WIDE_QUERY)
    : null;
}

function subscribeWide(listener: () => void): () => void {
  const query = wideQuery();
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

/** Where no media query can be asked, the column is treated as docked. */
function readWide(): boolean {
  return wideQuery()?.matches ?? true;
}

const serverTrue = () => true;
const serverFalse = () => false;

const ICON_BUTTON =
  'inline-flex h-(--height-btn-sm) w-(--height-btn-sm) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export interface PageSidebarLayoutProps {
  /** The sidebar's tree — `PageTree` at compact density, as the page built it. */
  tree: ReactNode;
  /** The breadcrumb, led by Show page tree when the column is not showing. */
  breadcrumb: ReactNode;
  /** The page itself — title, toolbar and editor. */
  children: ReactNode;
}

export function PageSidebarLayout({ tree, breadcrumb, children }: PageSidebarLayoutProps) {
  const t = useTranslations('pages');
  const asideId = useId();
  const hidden = useSyncExternalStore(subscribeHidden, readHidden, serverFalse);
  const wide = useSyncExternalStore(subscribeWide, readWide, serverTrue);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The drawer is the narrow form only: widening the window docks the column.
  const drawer = drawerOpen && !wide;

  const showRef = useRef<HTMLButtonElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    showRef.current?.focus();
  }, []);

  const show = () => {
    if (wide) writeHidden(false);
    else setDrawerOpen(true);
  };
  const hide = () => {
    if (drawer) closeDrawer();
    else writeHidden(true);
  };

  // The drawer takes focus to its first control, and Esc closes it.
  useEffect(() => {
    if (!drawer) return;
    hideRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawer, closeDrawer]);

  // Choosing a page — or the head's way back to `/pages` — closes the drawer.
  const onAsideClick = (e: MouseEvent<HTMLElement>) => {
    if (drawer && (e.target as Element).closest('a')) setDrawerOpen(false);
  };

  return (
    <div className="flex min-w-0 items-start xl:gap-8">
      {drawer ? (
        <div
          aria-hidden
          data-testid="page-sidebar-scrim"
          onClick={closeDrawer}
          className="fixed inset-0 z-40 bg-(--el-overlay-scrim)"
        />
      ) : null}
      <aside
        id={asideId}
        aria-label={t('tree.sidebar.label')}
        role={drawer ? 'dialog' : undefined}
        aria-modal={drawer ? true : undefined}
        data-testid="page-sidebar"
        data-state={drawer ? 'drawer' : hidden ? 'hidden' : 'docked'}
        onClick={onAsideClick}
        className={cn(
          'flex-col gap-0.5 border-r border-(--el-border) bg-(--el-surface-soft) px-2 py-3',
          drawer
            ? 'fixed inset-y-0 left-0 z-50 flex w-[300px] max-w-[85vw] shadow-(--shadow-modal)'
            : hidden
              ? 'hidden'
              : // Docked: flush against the rail and the top bar (the shell's
                // `pt-6` / `lg:px-8` gutter undone), pinned while the page scrolls.
                'sticky top-0 -mt-6 -ml-8 hidden h-[calc(100dvh-3.5rem-1px)] w-[248px] shrink-0 xl:flex',
        )}
      >
        <div className="flex items-center justify-between gap-2 pr-1 pb-2 pl-2">
          <Link
            href="/pages"
            className="rounded-(--radius-control) text-[13px] font-semibold text-(--el-text) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {t('index.title')}
          </Link>
          <button
            ref={hideRef}
            type="button"
            aria-label={t('tree.sidebar.hide')}
            title={t('tree.sidebar.hide')}
            aria-expanded
            aria-controls={asideId}
            onClick={hide}
            className={ICON_BUTTON}
          >
            <PanelLeftClose className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{tree}</div>
      </aside>
      <div className="min-w-0 flex-1">
        {/* A right-hand panel open — History (MOTIR-7387) or Discussion (MOTIR-10874),
            `data-side-panel-open` — widens the column at `xl`, where the panel sits
            BESIDE the page instead of over it. */}
        <div className="mx-auto w-full max-w-[760px] xl:has-[[data-side-panel-open]]:max-w-[1180px]">
          <div className="flex min-w-0 items-center gap-2">
            <button
              ref={showRef}
              type="button"
              aria-label={t('tree.sidebar.show')}
              title={t('tree.sidebar.show')}
              aria-expanded={drawer}
              aria-controls={asideId}
              onClick={show}
              data-testid="page-sidebar-show"
              // Shown whenever the column is not: always below 1280px, and at a
              // wide width only once the reader hid it.
              className={cn(ICON_BUTTON, !hidden && 'xl:hidden')}
            >
              <PanelLeftOpen className="h-4 w-4" aria-hidden />
            </button>
            {breadcrumb}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
