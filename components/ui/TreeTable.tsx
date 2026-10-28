'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

// TreeTable — the reusable, presentational tree-grid primitive (Subtask 2.5.2).
// The issue-list route (2.5.3) composes it, but it is GENERIC: it takes typed
// `columns` (header + per-row `cell` render-prop) and a nested `rows` model and
// emits the WAI-ARIA `treegrid` markup the design's hierarchical issue table
// needs (design/work-items/tree.png). There is no other table primitive in
// components/ui — WorkflowEditor hand-rolls a local
// `<table>`; this is the shared one a tree view reaches for.
//
// PURELY PRESENTATIONAL: it renders already-shaped data + render-props and
// issues NO queries and imports NO Server Actions (the CLAUDE.md layer rule).
// Expansion is controllable by the consumer (the 2.5.3 route holds it in URL/
// client state); an uncontrolled mode with `defaultExpandedIds` backs the
// specimen + simple callers. Inline editable cells (2.5.5) drop their controls
// into a column's `cell` render-prop and raise them above the row's stretched
// navigation link with `relative z-10`.
//
// A11y — the WAI-ARIA treegrid pattern (hand-rolled like Combobox):
//   role="treegrid" › rowgroup › row[aria-level/posinset/setsize/expanded] ›
//   gridcell. Exactly ONE row is in the tab sequence (roving tabindex); arrow
//   keys move focus and expand/collapse, Enter activates the row's link. Inner
//   controls (the chevron) are tabIndex=-1 — operated via the row keyboard +
//   mouse, never a second tab stop.
//
// VIRTUALIZATION (Subtask 2.5.15) — a deeply-expanded forest can hold thousands
// of rows. To keep the DOM bounded, the body WINDOWS its rows: only the rows in
// (or near) the viewport mount; off-view rows are removed; the rowgroup keeps its
// FULL height and each mounted row is absolutely positioned at `index * ROW_PX`,
// so the page scrollbar stays honest. It is INVISIBLE — a windowed row is
// identical to a non-windowed one — and A11Y-HONEST: every mounted row keeps its
// true `aria-level/posinset/setsize/expanded` from the flat model, so a screen
// reader announces the real position though only a window exists. The roving
// keyboard model is unchanged: arrow-moving to an off-window row scrolls it into
// view (which mounts it) and then focuses it. The scroll viewport is the nearest
// scrollable ANCESTOR (the shell `<main>`; no internal scrollbar, no layout
// change) — or a `getScrollElement` the caller supplies. When no viewport can be
// measured (SSR, or a viewport-less test) it degrades to rendering EVERY row, so
// the markup is identical with or without a live scroll container.

/** A column definition. The FIRST column is the tree column (indent + chevron). */
export interface TreeTableColumn<Row> {
  /** Stable key (React key for the cell + a11y id seed). */
  key: string;
  /** Column header content (rendered uppercase by the table). */
  header: ReactNode;
  /** Accessible header text when `header` is not a plain string. */
  headerLabel?: string;
  /** Render the cell body for a row. */
  cell: (row: Row) => ReactNode;
  /**
   * Fixed pixel width. Omit for the flexible tree column (there must be exactly
   * one flexible column — the first/tree column by convention).
   */
  width?: number;
  /** Right-align the cell + header (for the trailing meta columns if wanted). */
  align?: 'start' | 'end';
  /**
   * `aria-sort` for this column's header (Subtask 2.5.14) — when the header is a
   * sort button, the columnheader cell carries the sort state. Omit for
   * non-sortable columns (no `aria-sort` rendered).
   */
  ariaSort?: 'ascending' | 'descending' | 'none';
}

/** A node in the nested rows model. `children` may be omitted/empty for a leaf. */
export interface TreeTableRow<Row> {
  id: string;
  data: Row;
  children?: TreeTableRow<Row>[];
  /**
   * Override "has children" — for a LAZY parent whose children aren't loaded yet
   * (Subtask 2.5.14): the chevron shows from this flag, not from `children`.
   * Defaults to `children?.length > 0`.
   */
  hasChildren?: boolean;
  /** `aria-busy` on the row — a lazy node whose children are being fetched. */
  busy?: boolean;
  /**
   * Override the derived `aria-posinset` / `aria-setsize` (1-based position +
   * the FULL sibling total). Needed for paged lazy levels, where the rendered
   * sibling count ≠ the true total (e.g. row 19 of 128 with only 50 loaded).
   */
  posinset?: number;
  setsize?: number;
}

export interface TreeTableProps<Row> {
  /** The accessible name of the grid (e.g. "Issues"). */
  label: string;
  /** Column set; the first column renders the tree (indent + chevron + cell). */
  columns: TreeTableColumn<Row>[];
  /** The nested rows. */
  rows: TreeTableRow<Row>[];
  /** Controlled expansion: the set of expanded row ids. Pair with onExpandedChange. */
  expandedIds?: ReadonlySet<string>;
  /** Called with the next expanded set when the user toggles a row (controlled mode). */
  onExpandedChange?: (next: Set<string>) => void;
  /** Uncontrolled initial expansion (ignored when `expandedIds` is supplied). */
  defaultExpandedIds?: Iterable<string>;
  /** Whole-row navigation target; when set the row becomes a link to this href. */
  getRowHref?: (row: Row) => string | undefined;
  /** Accessible label for the row link — REQUIRED whenever getRowHref is set. */
  getRowLabel?: (row: Row) => string;
  /**
   * Intercept a click on the whole-row LINK (the stretched `getRowHref` anchor)
   * — e.g. to open a quick-view peek on a plain click while leaving the real
   * href for ⌘/ctrl/middle-click (MOTIR-1306). The handler owns the
   * `preventDefault` decision; the primitive stays navigation-only and unaware
   * of what the click does. Ignored when `getRowHref` is unset.
   */
  onRowLinkClick?: (e: React.MouseEvent<HTMLAnchorElement>, row: Row) => void;
  /**
   * Activate a NON-link row (no `getRowHref`) on Enter / click — e.g. the lazy
   * "Load more children" row (2.5.14). Keyboard Enter on the row + a mouse click
   * on the row both route here. Link rows ignore this (Enter clicks the link).
   */
  onRowActivate?: (id: string, data: Row) => void;
  /** Optional per-row `data-testid` (handy for E2E hooks). */
  getRowTestId?: (row: Row) => string | undefined;
  /**
   * The scroll viewport the body windows against (Subtask 2.5.15). Defaults to
   * the nearest scrollable ANCESTOR of the table (the shell `<main>`); supply a
   * custom resolver to point at a different element (or to drive the window
   * deterministically in tests). Return `null` to disable windowing (render all).
   */
  getScrollElement?: () => HTMLElement | null;
  /**
   * The CSS min-width of the flexible (first/tree) column's `minmax(<min>, 1fr)`
   * track. Defaults to `'0'` (the track may collapse fully). Pass a floor (e.g.
   * `'10rem'`) when the tree column holds non-shrinkable content that must not
   * spill into the next column under width pressure — the issue list/tree passes
   * `ISSUE_TITLE_MIN_TRACK` so the Title never collapses onto the Type chip
   * (bug MOTIR-1307).
   */
  flexMin?: string;
  /** Extra classes on the outer container. */
  className?: string;
}

export const INDENT_PX = 22; // per-level indent (design/work-items/tree.pen)
const ROW_PX = 40; // fixed row height — the windowing unit (design/work-items/tree-scale.mock.html)
const OVERSCAN = 8; // rows mounted beyond each viewport edge so fast scroll never flashes a gap

/** A row flattened for rendering, carrying the tree metadata aria needs. */
interface FlatRow<Row> {
  id: string;
  data: Row;
  depth: number; // 1 = root
  hasChildren: boolean;
  expanded: boolean;
  busy: boolean;
  posinset: number; // 1-based among siblings
  setsize: number;
  parentId: string | null;
}

/** The windowed slice of the flat rows: `[start, end)` indices currently mounted. */
interface RowWindow {
  start: number;
  end: number;
}

/** Depth-first flatten of the visible rows, honoring the expanded set. */
function flattenVisible<Row>(
  rows: TreeTableRow<Row>[],
  expanded: ReadonlySet<string>,
  depth: number,
  parentId: string | null,
  out: FlatRow<Row>[],
): void {
  rows.forEach((row, i) => {
    // `hasChildren` can be overridden for a lazy parent whose children aren't
    // loaded yet (chevron from the flag, not the — still empty — children array).
    const hasChildren = row.hasChildren ?? (!!row.children && row.children.length > 0);
    const isExpanded = hasChildren && expanded.has(row.id);
    out.push({
      id: row.id,
      data: row.data,
      depth,
      hasChildren,
      expanded: isExpanded,
      busy: row.busy ?? false,
      posinset: row.posinset ?? i + 1,
      setsize: row.setsize ?? rows.length,
      parentId,
    });
    // Recurse into any LOADED children (a lazy parent may be expanded with none
    // loaded yet — the consumer injects a synthetic "loading" child row).
    if (isExpanded && row.children && row.children.length > 0) {
      flattenVisible(row.children, expanded, depth + 1, row.id, out);
    }
  });
}

/** Walk up from `el` to the nearest ancestor that scrolls vertically. */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
    node = node.parentElement;
  }
  return null;
}

export function TreeTable<Row>({
  label,
  columns,
  rows,
  expandedIds,
  onExpandedChange,
  defaultExpandedIds,
  getRowHref,
  getRowLabel,
  onRowLinkClick,
  getRowTestId,
  onRowActivate,
  getScrollElement,
  flexMin = '0',
  className,
}: TreeTableProps<Row>) {
  const isControlled = expandedIds !== undefined;
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
    () => new Set(defaultExpandedIds ?? []),
  );
  const expanded = isControlled ? expandedIds : internalExpanded;

  const visible = useMemo(() => {
    const out: FlatRow<Row>[] = [];
    flattenVisible(rows, expanded, 1, null, out);
    return out;
  }, [rows, expanded]);

  // Roving tabindex: exactly one row sits in the tab sequence. `focusedId` is
  // the user's last explicit focus; `activeId` DERIVES the actually-tabbable row
  // — it falls back to the first visible row when the focused one was collapsed
  // away (so we never need to reconcile state inside an effect).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const activeId = useMemo(() => {
    if (focusedId && visible.some((r) => r.id === focusedId)) return focusedId;
    return visible[0]?.id ?? null;
  }, [focusedId, visible]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());

  // ── Windowing (Subtask 2.5.15) ───────────────────────────────────────────
  // `rowWindow` null = not virtualizing → render every row (SSR / no measurable
  // viewport / the existing small-tree tests). Otherwise only [start,end) mount.
  const scrollElRef = useRef<HTMLElement | null>(null);
  const [rowWindow, setRowWindow] = useState<RowWindow | null>(null);

  // Distance (px) from the scroll viewport's top edge to the row at index 0.
  // Scroll-invariant, so reading it on every recompute self-corrects when the
  // content ABOVE the table (page header, toolbar) changes height.
  const bodyOffset = useCallback((): number => {
    const scrollEl = scrollElRef.current;
    const body = bodyRef.current;
    if (!scrollEl || !body) return 0;
    return (
      body.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
    );
  }, []);

  const recomputeWindow = useCallback(() => {
    const scrollEl = scrollElRef.current;
    const viewportH = scrollEl?.clientHeight ?? 0;
    if (!scrollEl || viewportH <= 0) {
      setRowWindow(null); // no measurable viewport → render all
      return;
    }
    const top = scrollEl.scrollTop - bodyOffset(); // px from the body's top to the viewport's top
    const first = Math.floor(top / ROW_PX) - OVERSCAN;
    const last = Math.ceil((top + viewportH) / ROW_PX) + OVERSCAN;
    setRowWindow((prev) =>
      prev && prev.start === first && prev.end === last ? prev : { start: first, end: last },
    );
  }, [bodyOffset]);

  // Resolve + observe the scroll viewport once mounted; re-window on scroll/resize.
  useLayoutEffect(() => {
    const scrollEl = getScrollElement ? getScrollElement() : findScrollParent(bodyRef.current);
    scrollElRef.current = scrollEl;
    if (!scrollEl) {
      setRowWindow(null);
      return;
    }
    recomputeWindow();
    const onScroll = () => recomputeWindow();
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => recomputeWindow());
      resizeObserver.observe(scrollEl);
    }
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      resizeObserver?.disconnect();
    };
  }, [getScrollElement, recomputeWindow]);

  // The visible-row count changes when a node expands/collapses, so the window
  // must be recomputed against the new total height.
  useLayoutEffect(() => {
    recomputeWindow();
  }, [visible.length, recomputeWindow]);

  const total = visible.length;
  const windowing = rowWindow !== null && total > 0;
  const start = windowing ? Math.max(0, Math.min(rowWindow.start, total)) : 0;
  const end = windowing ? Math.max(start, Math.min(rowWindow.end, total)) : total;
  const windowRows = windowing ? visible.slice(start, end) : visible;

  const setExpanded = useCallback(
    (next: Set<string>) => {
      if (isControlled) onExpandedChange?.(next);
      else setInternalExpanded(next);
    },
    [isControlled, onExpandedChange],
  );

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setExpanded(next);
    },
    [expanded, setExpanded],
  );

  // Scroll a row's index into the viewport (windowing only) so an off-window row
  // mounts before we try to focus it. A no-op when not virtualizing.
  const scrollIndexIntoView = useCallback(
    (index: number) => {
      const scrollEl = scrollElRef.current;
      if (!scrollEl || rowWindow === null) return;
      const rowTop = bodyOffset() + index * ROW_PX;
      const rowBottom = rowTop + ROW_PX;
      const viewTop = scrollEl.scrollTop;
      const viewBottom = viewTop + scrollEl.clientHeight;
      let next = viewTop;
      if (rowTop < viewTop) next = rowTop;
      else if (rowBottom > viewBottom) next = rowBottom - scrollEl.clientHeight;
      if (next !== viewTop) {
        scrollEl.scrollTop = next;
        recomputeWindow(); // setting scrollTop doesn't always fire 'scroll' synchronously
      }
    },
    [rowWindow, bodyOffset, recomputeWindow],
  );

  // The row id we want focused once it has mounted (set when an arrow key lands
  // on a row outside the current window; cleared by the effect below).
  const pendingFocusId = useRef<string | null>(null);

  const focusRowAt = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, visible.length - 1));
      const target = visible[clamped];
      if (!target) return;
      setFocusedId(target.id);
      scrollIndexIntoView(clamped);
      const el = rowRefs.current.get(target.id);
      if (el) {
        el.focus();
        pendingFocusId.current = null;
      } else {
        // Off-window: it will mount after the scroll re-windows; focus it then.
        pendingFocusId.current = target.id;
      }
    },
    [visible, scrollIndexIntoView],
  );

  // After a re-window, focus a row an arrow key landed on that hadn't mounted yet
  // (so the roving tabindex stays intact across the virtualization boundary).
  useEffect(() => {
    const id = pendingFocusId.current;
    if (!id) return;
    const el = rowRefs.current.get(id);
    if (el) {
      el.focus();
      pendingFocusId.current = null;
    }
  }, [rowWindow, visible]);

  const onRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, row: FlatRow<Row>, index: number) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focusRowAt(index + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          focusRowAt(index - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusRowAt(0);
          break;
        case 'End':
          e.preventDefault();
          focusRowAt(visible.length - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (row.hasChildren && !row.expanded) toggle(row.id);
          else if (row.hasChildren && row.expanded) focusRowAt(index + 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (row.hasChildren && row.expanded) {
            toggle(row.id);
          } else if (row.parentId) {
            const parentIndex = visible.findIndex((r) => r.id === row.parentId);
            if (parentIndex >= 0) focusRowAt(parentIndex);
          }
          break;
        case 'Enter': {
          // Activate the row's stretched link (if any). Space is intentionally
          // NOT bound — it scrolls, and inner controls own their own keys.
          const link = linkRefs.current.get(row.id);
          if (link) {
            e.preventDefault();
            link.click();
          } else if (onRowActivate) {
            // A non-link row (e.g. "Load more children") activates via Enter.
            e.preventDefault();
            onRowActivate(row.id, row.data);
          }
          break;
        }
        default:
          break;
      }
    },
    [focusRowAt, toggle, visible, onRowActivate],
  );

  const treeColumn = columns[0];
  const restColumns = columns.slice(1);
  // The grid template: the tree column flexes (floored at `flexMin` so it can't
  // collapse its content into the next column under width pressure — bug
  // MOTIR-1307), the rest take their fixed widths.
  const gridTemplate = [
    `minmax(${flexMin},1fr)`,
    ...restColumns.map((c) => (c.width ? `${c.width}px` : 'max-content')),
  ].join(' ');

  return (
    <div
      // `data-tilt` floats this panel under the 3D / Immersive style (7.3.39).
      // It is a large surface, so the tilt engine size-gates it: deep resting
      // shadow (it lifts off the immersive canvas), no cursor tilt. Inert under
      // every other style + reduced motion.
      data-tilt=""
      // surface-material hook so the tree panel (work-item tree, etc.) picks up a
      // surface-material style (glass frost / aurora glow), matching the list
      // panel. Inert under non-material styles. 7.3.38.
      data-surface="card"
      className={cn(
        'overflow-hidden rounded-(--radius-card) border border-(--el-border)',
        className,
      )}
    >
      <div role="treegrid" aria-label={label} className="w-full text-sm">
        {/* Header */}
        <div role="rowgroup">
          <div
            role="row"
            // A MINIMUM height: a header label longer than its fixed track (a
            // translated "Osoba odpowiedzialna") wraps at a word boundary and
            // grows the band instead of being cut off (MOTIR-7759).
            className="sticky top-0 z-20 grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) py-1 pr-7 pl-4"
            style={{ gridTemplateColumns: gridTemplate, minHeight: ROW_PX }}
          >
            {columns.map((col) => (
              <div
                key={col.key}
                role="columnheader"
                aria-sort={col.ariaSort}
                className={cn(
                  'min-w-0 overflow-hidden text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase hyphens-auto',
                  col.align === 'end' && 'text-right',
                )}
              >
                {col.header}
              </div>
            ))}
          </div>
        </div>

        {/* Body — omitted entirely when there are no rows (the consumer renders
            its own empty state; an empty rowgroup adds nothing to convey). When
            windowing, the rowgroup keeps the FULL height so the scrollbar stays
            honest, and each mounted row is absolutely positioned at its index. */}
        {total > 0 ? (
          <div
            role="rowgroup"
            ref={bodyRef}
            style={windowing ? { position: 'relative', height: total * ROW_PX } : undefined}
          >
            {windowRows.map((row, i) => {
              const index = start + i;
              const href = getRowHref?.(row.data);
              const rowLabel = getRowLabel?.(row.data);
              const testId = getRowTestId?.(row.data);
              return (
                <div
                  key={row.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.id, el);
                    else rowRefs.current.delete(row.id);
                  }}
                  role="row"
                  aria-level={row.depth}
                  aria-posinset={row.posinset}
                  aria-setsize={row.setsize}
                  aria-expanded={row.hasChildren ? row.expanded : undefined}
                  aria-busy={row.busy || undefined}
                  tabIndex={row.id === activeId ? 0 : -1}
                  data-testid={testId}
                  onKeyDown={(e) => onRowKeyDown(e, row, index)}
                  onFocus={() => setFocusedId(row.id)}
                  onClick={
                    !href && onRowActivate ? () => onRowActivate(row.id, row.data) : undefined
                  }
                  className={cn(
                    'group relative grid items-center gap-x-4 border-b border-(--el-border) pr-7 pl-4 hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:-outline-offset-2',
                    // Strip the trailing border only when EVERY row renders — a
                    // windowed slice's last DOM row usually has rows below it.
                    !windowing && 'last:border-b-0',
                  )}
                  style={{
                    gridTemplateColumns: gridTemplate,
                    height: ROW_PX,
                    ...(windowing
                      ? { position: 'absolute', top: index * ROW_PX, left: 0, right: 0 }
                      : null),
                  }}
                >
                  {/* Tree column — indent + chevron slot + the consumer's cell. */}
                  <div
                    role="gridcell"
                    className="flex min-w-0 items-center gap-2"
                    style={{ paddingLeft: (row.depth - 1) * INDENT_PX }}
                  >
                    {/* Stretched link covers the whole ROW (row is the positioned
                      ancestor); the cell is static so inset-0 escapes it. */}
                    {href ? (
                      <a
                        ref={(el) => {
                          if (el) linkRefs.current.set(row.id, el);
                          else linkRefs.current.delete(row.id);
                        }}
                        href={href}
                        aria-label={rowLabel}
                        tabIndex={-1}
                        onClick={onRowLinkClick ? (e) => onRowLinkClick(e, row.data) : undefined}
                        className="absolute inset-0 z-0 focus:outline-none"
                      />
                    ) : null}

                    {row.hasChildren ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={row.expanded ? 'Collapse row' : 'Expand row'}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggle(row.id);
                        }}
                        className="relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:text-(--el-text)"
                      >
                        <ChevronRight
                          className={cn(
                            'h-3 w-3 transition-transform',
                            row.expanded && 'rotate-90',
                          )}
                          aria-hidden
                        />
                      </button>
                    ) : (
                      // Reserved 16px slot so leaf rows align with parents' content.
                      <span className="h-4 w-4 shrink-0" aria-hidden />
                    )}

                    {/* The tree cell's content stays BELOW the stretched link
                        (no z-raise) so clicking the title/identifier navigates
                        the row — only genuinely interactive bits (the chevron
                        above; inline-edit controls in 2.5.5) raise themselves
                        with `relative z-10` to intercept their own clicks. */}
                    <div className="flex min-w-0 flex-1 items-center">
                      {treeColumn?.cell(row.data)}
                    </div>
                  </div>

                  {/* The remaining fixed columns. */}
                  {restColumns.map((col) => (
                    <div
                      key={col.key}
                      role="gridcell"
                      className={cn(
                        'flex min-w-0 items-center',
                        col.align === 'end' && 'justify-end',
                      )}
                    >
                      {col.cell(row.data)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
