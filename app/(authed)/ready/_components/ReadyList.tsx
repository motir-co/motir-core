'use client';

import {
  SurfaceTitle,
  useSurfaceTitleName,
  useSurfaceTitleText,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Copy, FileX, ScrollText } from 'lucide-react';
import type { ReadyContainerDto, ReadyItemDto } from '@/lib/dto/ready';
import { isManualReadyItem } from '@/lib/dto/ready';
import { useRowWindow } from '@/components/ui/useRowWindow';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { MarkdownView } from '@/components/ui/MarkdownView';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemTypeChip } from '@/components/issues/WorkItemTypeChip';
import { Avatar, PriorityValue } from '../../items/_components/issueCellPrimitives';
import { usePeekOpen } from '../../items/_components/IssueQuickView';
import { cn } from '@/lib/utils/cn';
import { loadMoreReadyBugsAction, loadMoreReadyLeavesAction } from '../_actions';

// The /ready dispatch list (Subtask 7.0.6, design/ready panel 1). A NEW
// arrangement of shipped primitives — IssueTypeIcon (hued), the priority
// PriorityValue chip, the initial-letter Avatar (+ the dashed-circle unassigned
// placeholder, mirroring BoardCard), and a hover copy button with its Tooltip —
// NOT a new card vocabulary.
//
// Scale shape (finding #57): the page server-renders the FIRST cursor page; this
// virtualizes the loaded rows via the 2.5.15/3.2.5 `useRowWindow` primitive (only
// viewport rows mount; degrades to render-all under no measurable viewport, e.g.
// SSR/tests) AND streams subsequent cursor pages on demand via
// the lane's load-more action when a bottom sentinel nears the viewport — so
// neither the DOM nor the initial payload grows with the backlog.
//
// ONE READY LANE per list (Story MOTIR-6829 · MOTIR-6834, `design/ready/
// ready--lanes.mock.html`): the rows arrive in the service's lane order, GROUPED
// by their runnable `container`. A group renders as a collapsible container row
// (TreeTable's chevron grammar) over its ready leaves, indented one level; a row
// with no container stands alone, its 16px chevron slot reserved so every icon
// aligns. The list never re-sorts: a group is contiguous by construction, and a
// group a page boundary split merges back into ONE header as the next page
// arrives. Expand state is keyed by container id and survives a load.
//
// Row interaction (notes.html #7): the whole card opens the existing
// `IssueQuickView` peek (`?peek=<key>`), NOT a full-page navigation — the title
// is a stretched-`::after` button covering the card; the copy button is raised
// above it (`relative z-10`) so it doesn't trigger the peek.

const ROW_ESTIMATE_PX = 44;
/** One tree level — `TreeTable`'s `INDENT_PX` (design/work-items/tree.pen). */
const INDENT_CLASS = 'ml-[22px]';
const ROW_GAP_PX = 8;
// Prefetch the next cursor page this far before the list bottom enters view, so a
// fast scroll never stalls on an empty tail.
const LOAD_AHEAD_PX = 600;

export interface ReadyListProps {
  initialItems: ReadyItemDto[];
  initialCursor: string | null;
  /** The card links in the first page's manual instructions (bug MOTIR-10023); each
   *  later page's map is merged in as it loads. */
  initialWorkItemRefs: WorkItemRefMap;
  /** Which ready lane this list pages — picks the load-more action and the copy. */
  lane?: 'leaf' | 'bug';
}

/** One rendered row of a lane: a container header, or a leaf (standalone or a child). */
type DisplayRow =
  | { type: 'container'; container: ReadyContainerDto; expanded: boolean }
  | { type: 'leaf'; item: ReadyItemDto; child: boolean };

/**
 * GROUP the lane's rows by container and flatten them into what renders. The
 * input is the service's order, so a group is contiguous — but a page boundary
 * can split one, which is why grouping is by id over the WHOLE loaded list
 * rather than by adjacency: the second half of a split group joins the first.
 */
export function laneDisplayRows(
  items: readonly ReadyItemDto[],
  expanded: ReadonlySet<string>,
): DisplayRow[] {
  const order: string[] = [];
  const groups = new Map<string, { container: ReadyContainerDto | null; items: ReadyItemDto[] }>();
  for (const item of items) {
    const container = item.container ?? null;
    const head = container?.id ?? item.id;
    let group = groups.get(head);
    if (!group) {
      group = { container, items: [] };
      groups.set(head, group);
      order.push(head);
    }
    group.items.push(item);
  }
  const rows: DisplayRow[] = [];
  for (const head of order) {
    const group = groups.get(head)!;
    if (!group.container) {
      for (const item of group.items) rows.push({ type: 'leaf', item, child: false });
      continue;
    }
    const open = expanded.has(group.container.id);
    rows.push({ type: 'container', container: group.container, expanded: open });
    if (open) for (const item of group.items) rows.push({ type: 'leaf', item, child: true });
  }
  return rows;
}

export function ReadyList({
  initialItems,
  initialCursor,
  initialWorkItemRefs,
  lane = 'leaf',
}: ReadyListProps) {
  const t = useTranslations('ready');
  const [items, setItems] = useState<ReadyItemDto[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [workItemRefs, setWorkItemRefs] = useState<WorkItemRefMap>(initialWorkItemRefs);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const rows = laneDisplayRows(items, expanded);
  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [isPending, startTransition] = useTransition();
  // Guards re-entrancy: the IntersectionObserver can fire repeatedly while the
  // sentinel sits in view; only one load is in flight at a time.
  const loadingRef = useRef(false);

  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: rows.length,
    estimateRowHeight: ROW_ESTIMATE_PX,
    gap: ROW_GAP_PX,
  });

  const loadMore = useCallback(() => {
    if (loadingRef.current || cursor === null) return;
    loadingRef.current = true;
    startTransition(async () => {
      try {
        const next = await (lane === 'bug' ? loadMoreReadyBugsAction : loadMoreReadyLeavesAction)(
          cursor,
        );
        setItems((prev) => [...prev, ...next.items]);
        setWorkItemRefs((prev) => ({ ...prev, ...next.workItemRefs }));
        setCursor(next.nextCursor);
      } finally {
        loadingRef.current = false;
      }
    });
  }, [cursor, lane]);

  // Stream the next page as a bottom sentinel nears the viewport. Re-armed each
  // time the cursor advances; torn down at the tail (cursor === null).
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || cursor === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: `${LOAD_AHEAD_PX}px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  const indices: number[] = [];
  if (windowing) {
    for (let i = range.start; i < range.end; i++) indices.push(i);
  } else {
    for (let i = 0; i < rows.length; i++) indices.push(i);
  }

  if (items.length === 0) {
    return (
      <p className="py-(--spacing-control-y) text-sm text-(--el-text-secondary)">
        {lane === 'bug' ? t('lanes.bugs.empty') : t('lanes.main.empty')}
      </p>
    );
  }

  return (
    <div>
      <div
        ref={containerRef}
        role="list"
        aria-label={lane === 'bug' ? t('lanes.bugs.listAria') : t('listAria')}
        className={windowing ? 'relative' : 'flex flex-col gap-2'}
        style={windowing ? { height: totalSize } : undefined}
      >
        {indices.map((index) => {
          const row = rows[index]!;
          return (
            <div
              key={row.type === 'container' ? `c-${row.container.id}` : row.item.id}
              role="listitem"
              ref={measureElement(index)}
              style={
                windowing
                  ? { position: 'absolute', top: getOffset(index), left: 0, right: 0 }
                  : undefined
              }
            >
              {row.type === 'container' ? (
                <ReadyContainerRow
                  container={row.container}
                  expanded={row.expanded}
                  onToggle={toggle}
                />
              ) : (
                <ReadyRow item={row.item} child={row.child} workItemRefs={workItemRefs} />
              )}
            </div>
          );
        })}
      </div>

      {/* Cursor sentinel — present only while more pages remain. */}
      {cursor !== null ? <div ref={sentinelRef} aria-hidden className="h-px w-full" /> : null}
      {isPending ? (
        <p className="mt-2 text-center text-xs text-(--el-text-muted)" role="status">
          {t('loadingMore')}
        </p>
      ) : null}
    </div>
  );
}

/** One dispatch card — a flat arrangement of the shipped issue primitives. */
function ReadyRow({
  item,
  child = false,
  workItemRefs,
}: {
  item: ReadyItemDto;
  child?: boolean;
  workItemRefs: WorkItemRefMap;
}) {
  const openPeek = usePeekOpen();
  const shownTitleName = useSurfaceTitleName(item.id, item.title);
  // A MANUAL row (human work) carries no `motir run` command (8.8.5/8.8.10):
  // its action slot is the always-visible *Show instruction* button + modal
  // instead of the hover-revealed agent copy button. ONE predicate with the
  // mapper's payload decision (`isManualReadyItem`), so they never drift.
  const isManual = isManualReadyItem(item);

  return (
    <div
      // surface-material hook (glass frost / aurora glow); inert under
      // non-material styles. 7.3.38.
      data-surface="card"
      className={cn(
        'group relative flex min-h-(--height-control) items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong) hover:bg-(--el-surface-soft)',
        child && INDENT_CLASS,
      )}
    >
      {/* TreeTable's reserved 16px chevron slot, so a leaf's icon aligns with a
          container's. */}
      <span className="h-4 w-4 shrink-0" aria-hidden />
      <IssueTypeIcon type={item.kind} className="h-[18px] w-[18px] shrink-0" />
      <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">{item.key}</span>
      {/* Stretched-`::after` button: the whole card opens the peek (notes.html #7). */}
      <button
        type="button"
        onClick={() => openPeek(item.key)}
        aria-label={`${item.key} ${shownTitleName}`}
        className="min-w-0 flex-1 truncate rounded-(--radius-control) text-left text-sm text-(--el-text) after:absolute after:inset-0 after:content-[''] group-hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <SurfaceTitle id={item.id} title={item.title} />
      </button>
      {/* Meta cluster — `[type chip] · [priority] · [assignee] · [action]`. The
          chip + priority + avatar are non-interactive, so a click falls through
          to the stretched peek overlay; only the action button is raised above it. */}
      <div className="flex shrink-0 items-center gap-3">
        {/* `type: null` (a childless story/epic in the set) omits the chip — a
            flex row needs no placeholder filler (per design/ready notes). */}
        {item.type ? <WorkItemTypeChip type={item.type} /> : null}
        <PriorityValue priority={item.priority} />
        <ReadyAssignee assignee={item.assignee} />
        {isManual ? (
          <ShowInstructionAction item={item} workItemRefs={workItemRefs} />
        ) : (
          <CopyCommandAction item={item} />
        )}
      </div>
    </div>
  );
}

/** The agent action — the hover-revealed copy button that puts `motir run/plan
 *  <key>` on the clipboard. Raised above the stretched peek overlay. */
function CopyCommandAction({
  item,
  container = false,
}: {
  item: Pick<ReadyItemDto, 'key' | 'kind'>;
  /** A runnable CONTAINER row — its command is the parent run, `motir run <KEY>`. */
  container?: boolean;
}) {
  const t = useTranslations('ready');
  const { toast } = useToast();
  // Container kinds (epic / story) are *planned/deepened*, not executed — they
  // only enter the ready set while childless (the `NOT EXISTS (children)` ready
  // predicate), and the action a user takes on one is `motir plan <key>`.
  // Executable leaves (task / subtask / bug) dispatch with `motir run <key>`, and
  // so does a runnable container's row: `motir run <KEY>` is its parent run.
  const verb = !container && (item.kind === 'epic' || item.kind === 'story') ? 'plan' : 'run';
  const command = `motir ${verb} ${item.key}`;

  const copy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(command);
      toast({
        variant: 'success',
        title: t('toast.title'),
        description: t('toast.body', { command }),
      });
    },
    [command, t, toast],
  );

  return (
    <span className="relative z-10">
      <Tooltip
        content={t.rich('copyTooltip', {
          command,
          cmd: (chunks) => <code className="font-mono">{chunks}</code>,
        })}
      >
        <button
          type="button"
          onClick={copy}
          aria-label={
            container
              ? t('container.copyAria', { key: item.key })
              : t('copyAria', { key: item.key })
          }
          className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) opacity-0 transition-[opacity,color,background-color] hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:text-(--el-text) focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Copy className="h-4 w-4" aria-hidden />
        </button>
      </Tooltip>
    </span>
  );
}

/** The manual-row action (8.8.5/8.8.10) — an ALWAYS-visible *Show instruction*
 *  button (a human task can't be run, so reading the instruction is the only
 *  affordance and must not hide behind hover) that opens the instruction modal. */
function ShowInstructionAction({
  item,
  workItemRefs,
}: {
  item: ReadyItemDto;
  workItemRefs: WorkItemRefMap;
}) {
  const t = useTranslations('ready');
  const [open, setOpen] = useState(false);
  return (
    <span className="relative z-10">
      <Tooltip content={t('manualTooltip')}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<ScrollText className="h-[15px] w-[15px]" aria-hidden />}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          aria-label={t('showInstructionAria', { key: item.key })}
          className="border border-(--el-border) text-(--el-text-secondary)"
        >
          {t('showInstruction')}
        </Button>
      </Tooltip>
      <InstructionModal
        item={item}
        workItemRefs={workItemRefs}
        open={open}
        onOpenChange={setOpen}
      />
    </span>
  );
}

/** The instruction modal — the manual item's `descriptionMd` rendered as the
 *  same Markdown stack as the issue detail page (`Modal` + `MarkdownView`). */
function InstructionModal({
  item,
  workItemRefs,
  open,
  onOpenChange,
}: {
  item: ReadyItemDto;
  workItemRefs: WorkItemRefMap;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('ready');
  const tc = useTranslations('common');
  const body = item.descriptionMd?.trim() ? item.descriptionMd : null;
  const shownTitle = useSurfaceTitleText(item.id, item.title);
  return (
    <Modal open={open} onOpenChange={onOpenChange} size="lg" title={shownTitle}>
      {/* Subhead: key · Manual chip · "Human task · assigned to {name}". */}
      <div className="-mt-1 mb-(--spacing-md) flex shrink-0 flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-(--el-text-muted)">{item.key}</span>
        {item.type ? <WorkItemTypeChip type={item.type} /> : null}
        <span className="text-sm text-(--el-text-secondary)">
          {item.assignee
            ? t('instruction.assigned', { name: item.assignee.name })
            : t('instruction.unassigned')}
        </span>
      </div>
      <Modal.Body>
        {body ? (
          <MarkdownView
            value={body}
            workItemRefs={workItemRefs}
            aria-label={t('instruction.bodyAria')}
          />
        ) : (
          // Empty: point the reader at the fix rather than showing a blank pane.
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-(--spacing-lg) text-center">
            <FileX className="h-10 w-10 text-(--el-text-faint)" aria-hidden />
            <p className="text-sm font-medium text-(--el-text)">{t('instruction.empty.title')}</p>
            <p className="max-w-prose text-sm text-(--el-text-muted)">
              {t('instruction.empty.body')}
            </p>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {tc('close')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Assignee cell — initial-letter Avatar + name, or the dashed-circle
 *  unassigned placeholder (mirrors BoardCard's convention). */
function ReadyAssignee({ assignee }: { assignee: ReadyItemDto['assignee'] }) {
  const t = useTranslations('ready');
  if (!assignee) {
    return (
      <span
        aria-label={t('unassigned')}
        className="inline-flex h-[22px] w-[22px] shrink-0 rounded-full border border-dashed border-(--el-border-strong) bg-(--el-muted)"
      />
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={assignee.name} />
      <span className="hidden truncate text-sm text-(--el-text-secondary) sm:inline">
        {assignee.name}
      </span>
    </span>
  );
}

/**
 * A RUNNABLE-CONTAINER row (MOTIR-6834): TreeTable's chevron toggle, then the
 * dispatch-card anatomy with a "{ready} of {children} ready" hint and the
 * parent-run copy. The chevron expands; the rest of the card opens the peek.
 */
function ReadyContainerRow({
  container,
  expanded,
  onToggle,
}: {
  container: ReadyContainerDto;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const t = useTranslations('ready');
  const openPeek = usePeekOpen();
  const shownTitleName = useSurfaceTitleName(container.id, container.title);
  return (
    <div
      data-surface="card"
      data-testid={`ready-container-${container.key}`}
      className="group relative flex min-h-(--height-control) items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong) hover:bg-(--el-surface-soft)"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={
          expanded
            ? t('container.collapse', { key: container.key })
            : t('container.expand', { key: container.key })
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggle(container.id);
        }}
        className="relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <ChevronRight
          className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')}
          aria-hidden
        />
      </button>
      <IssueTypeIcon type={container.kind} className="h-[18px] w-[18px] shrink-0" />
      <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">{container.key}</span>
      <button
        type="button"
        onClick={() => openPeek(container.key)}
        aria-label={`${container.key} ${shownTitleName}`}
        className="min-w-0 flex-1 truncate rounded-(--radius-control) text-left text-sm text-(--el-text) after:absolute after:inset-0 after:content-[''] group-hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <SurfaceTitle id={container.id} title={container.title} />
      </button>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-xs text-(--el-text-secondary)">
          {t('container.hint', { ready: container.readyLeafCount, total: container.childCount })}
        </span>
        <PriorityValue priority={container.priority} />
        <ReadyAssignee assignee={container.assignee} />
        <CopyCommandAction item={container} container />
      </div>
    </div>
  );
}
