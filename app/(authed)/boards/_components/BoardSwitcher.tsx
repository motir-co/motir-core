'use client';

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Check,
  ChevronDown,
  Info,
  MoreHorizontal,
  Pencil,
  Plus,
  SlidersHorizontal,
  Star,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { BoardSummaryDto } from '@/lib/dto/boards';
import {
  applyDefault,
  applyDelete,
  resolveActiveBoardId,
  sortBoards,
  upsertBoard,
} from './multiBoardState';
import { BOARD_TYPE_ICON, BoardTypeIcon } from './boardTypeIcon';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import {
  BoardFilterSection,
  useBoardFilterDraft,
  type BoardFilterLookups,
  type BoardFilterRefusal,
} from './BoardFilterSection';
import type { FilterAst, FilterEnvelope } from '@/lib/filters/ast';

// BoardSwitcher (Subtask 3.7.4) — the multi-board switcher + create / rename /
// set-default / delete UI on `/boards`, per `design/boards/multi-board.mock.html`
// (3.7.1) + the "Multiple boards (Story 3.7)" design notes. A PURE CONSUMER of
// the 3.7.3 board API:
//   - GET    /api/boards          → the project's boards as switcher rows
//   - POST   /api/boards          → create (seeds default columns; non-default)
//   - PATCH  /api/boards/[id]     → rename ({name}) / set-default ({isDefault:true})
//   - DELETE /api/boards/[id]     → delete (guards: last-board 409, promote-default)
//
// The selected board is URL-addressable via `?board=<id>` (mirroring the 2.5.19
// `?peek` pattern — shareable, reload-safe), defaulting to the project's
// `isDefault` board when absent. Picking a board pushes `?board=<id>`;
// `BoardContainer` reads that param and re-lays from the selected board's
// projection (the server read is wired by Subtask 3.7.5 — until then the GET
// returns the default board, so the switch updates the URL + refetches but the
// projection is the default's; the switcher UI itself is complete).
//
// Lives in the board page header (always present — independent of the board
// PROJECTION's loading / error / empty states, so you can always switch away),
// at the left of the toolbar before the disabled [Filter] seam + [+ New issue].
//
// Writes are optimistic-with-reconcile against the 3.7.3 endpoints; a failed
// write reverts the optimistic list + a danger Toast. Outcomes (switch, create,
// delete-and-promote) are announced via an aria-live region. Colour strictly via
// `--el-*` (the Default badge = the neutral Pill, the active-board check + the
// New-board action via `--el-accent`, the delete callout via `--el-tint-sky`,
// danger Delete via `--el-danger`); shape via element-semantic tokens; the
// switcher is a `role="menu"` with `menuitemradio` rows, no nested buttons (a
// row is a div holding the pick + manage buttons as siblings).
//
// Permissions (MOTIR-6174): board CRUD asserts `board:configure` (`boardsService`,
// the key the `/settings/project/board` room also asks for). An actor without it
// sees the switcher to SWITCH, with New and the per-board manage menu — rename,
// set default, Board settings, delete — HIDDEN: they are entry points (the
// permission-gated UI rule, rows 1 and 5). The server re-gates every write.
//
// Board filter (Story MOTIR-10560 · Subtask MOTIR-11333): given `filterLookups`
// (the builder's lookups, from the `/boards` page), the create dialog carries the
// optional Board filter section (`BoardFilterSection`) and posts its committed
// envelope as `filter`. A 422 refusal comes back to the dialog, which shows it in
// the section and stays open; every other failure keeps the generic toast.

type BoardType = 'kanban' | 'scrum';

/** A board-create result the dialog acts on: created, or a typed 422 refusal of
 * the stored filter (any other failure throws, for the generic toast). */
type CreateOutcome = { ok: true } | { ok: false; refusal: BoardFilterRefusal };

const NAME_MAX = 80;

export function BoardSwitcher({
  // Defaults to the actor's own `board:configure` (the layout's one permission
  // resolution); a caller may still pass it explicitly.
  canManage: canManageProp,
  // `variant` (Subtask 3.7.8) — `'board'` (default, on `/boards`): the full
  // switcher with New / manage [⋯] (rename / set-default / Board settings /
  // delete). `'settings'` (on `/settings/project/board`): a SWITCH-ONLY switcher
  // that re-targets WHICH board you're configuring — picking a row pushes
  // `?board=<id>` on the settings route (the same selectBoard logic, since it
  // preserves the pathname), so the server page re-resolves that board's config.
  // It hides New + the per-board manage menu (creating / renaming / deleting a
  // board stays the `/boards` switcher's job, per the 3.7.7 design notes).
  variant = 'board',
  // The Board filter section's lookups (MOTIR-11333). Absent — the settings
  // variant, which has no New — the create dialog has no Filter section.
  filterLookups,
}: {
  canManage?: boolean;
  variant?: 'board' | 'settings';
  filterLookups?: BoardFilterLookups;
}) {
  const t = useTranslations('boards');
  // In the settings variant the switcher only SWITCHES which board is configured
  // — no New, no per-row manage menu (those live on `/boards`).
  const isSettings = variant === 'settings';
  const { can } = useProjectAccess();
  const canManage = canManageProp ?? can('board:configure');
  const showManage = canManage && !isSettings;
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const boardParam = searchParams?.get('board') ?? null;

  // null = the board list is still loading (skeleton trigger); the load error is
  // a separate flag so a failed list load shows the inline retry, never blanks.
  const [boards, setBoards] = useState<BoardSummaryDto[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [menuOpen, setMenuOpen] = useState(false);
  // Which row's manage [⋯] submenu is open (an id, or null). Lives INSIDE the
  // switcher Popover content (absolutely positioned within the row), so it never
  // dismisses the outer popover.
  const [manageId, setManageId] = useState<string | null>(null);

  // Modal targets (null = closed). Rename / delete carry the board they act on.
  const [newOpen, setNewOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<BoardSummaryDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BoardSummaryDto | null>(null);

  const [live, setLive] = useState('');
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Plain handlers (no manual useCallback): React Compiler auto-memoizes this
  // component, so manual memoization is redundant here and the deps are inferred.
  const announce = (message: string) => {
    setLive(message);
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => setLive(''), 4000);
  };
  useEffect(() => () => void (liveTimer.current && clearTimeout(liveTimer.current)), []);

  // Load the project's boards (independent of the board projection BoardContainer
  // fetches). Re-runs on retry.
  useEffect(() => {
    let active = true;
    fetch('/api/boards', { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`boards ${res.status}`);
        const data = (await res.json()) as { boards: BoardSummaryDto[] };
        if (active) {
          setBoards(sortBoards(data.boards));
          setLoadError(false);
        }
      })
      .catch(() => {
        if (active) {
          setBoards(null);
          setLoadError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  // Navigate to a board by writing `?board=<id>`, preserving every other param
  // (mirrors usePeekOpen, Subtask 2.5.19). BoardContainer reads the param and
  // re-lays. Closes the menu.
  const selectBoard = (id: string) => {
    const params = new URLSearchParams(searchParams?.toString());
    params.set('board', id);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
    setMenuOpen(false);
    setManageId(null);
  };

  const activeId = boards ? resolveActiveBoardId(boards, boardParam) : null;
  const activeBoard = boards?.find((b) => b.id === activeId) ?? null;
  const isLastBoard = (boards?.length ?? 0) <= 1;

  // ── Create ────────────────────────────────────────────────────────────────
  const createBoard = async (
    name: string,
    type: BoardType,
    filter?: FilterEnvelope,
  ): Promise<CreateOutcome> => {
    const res = await fetch('/api/boards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // No `filter` key at all when the section holds no complete condition: the
      // board is created with no stored filter, exactly as before.
      body: JSON.stringify(filter ? { name, type, filter } : { name, type }),
    });
    if (res.status === 422) {
      const body = (await res.json().catch(() => ({}))) as Partial<BoardFilterRefusal>;
      return {
        ok: false,
        refusal: {
          code: body.code ?? 'UNKNOWN',
          error: body.error ?? '',
          ...(typeof body.conditionIndex === 'number'
            ? { conditionIndex: body.conditionIndex }
            : {}),
        },
      };
    }
    if (!res.ok) throw new Error(`create ${res.status}`);
    const created = (await res.json()) as BoardSummaryDto;
    setBoards((prev) => upsertBoard(prev ?? [], created));
    setNewOpen(false);
    announce(t('boardCreatedAnnounce', { name: created.name }));
    selectBoard(created.id);
    return { ok: true };
  };

  // ── Rename ──────────────────────────────────────────────────────────────── (optimistic + reconcile)
  const renameBoard = async (board: BoardSummaryDto, name: string) => {
    const snapshot = boards;
    setBoards((prev) => (prev ?? []).map((b) => (b.id === board.id ? { ...b, name } : b)));
    setRenameTarget(null);
    try {
      const res = await fetch(`/api/boards/${board.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`rename ${res.status}`);
      const dto = (await res.json()) as BoardSummaryDto;
      setBoards((prev) => upsertBoard(prev ?? [], dto));
      announce(t('boardRenamedAnnounce', { name: dto.name }));
    } catch {
      if (snapshot) setBoards(snapshot);
      toast({
        variant: 'error',
        title: t('boardWriteErrorTitle'),
        description: t('boardRenameErrorDescription'),
      });
    }
  };

  // ── Set default ───────────────────────────────────────────────────────────
  const setDefaultBoard = async (board: BoardSummaryDto) => {
    const snapshot = boards;
    setBoards((prev) => applyDefault(prev ?? [], board.id));
    setManageId(null);
    try {
      const res = await fetch(`/api/boards/${board.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });
      if (!res.ok) throw new Error(`set-default ${res.status}`);
      const dto = (await res.json()) as BoardSummaryDto;
      setBoards((prev) => applyDefault(upsertBoard(prev ?? [], dto), dto.id));
      announce(t('boardSetDefaultAnnounce', { name: dto.name }));
    } catch {
      if (snapshot) setBoards(snapshot);
      toast({
        variant: 'error',
        title: t('boardWriteErrorTitle'),
        description: t('boardSetDefaultErrorDescription'),
      });
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────── (issues survive on the project)
  const deleteBoard = async (board: BoardSummaryDto) => {
    const snapshot = boards;
    const wasActive = board.id === activeId;
    const { boards: next, promotedDefaultId } = applyDelete(boards ?? [], board.id);
    setBoards(next);
    setDeleteTarget(null);
    setMenuOpen(false);
    try {
      const res = await fetch(`/api/boards/${board.id}`, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`delete ${res.status}`);
      const fallback = promotedDefaultId ?? next.find((b) => b.isDefault)?.id ?? next[0]?.id;
      announce(
        t('boardDeletedAnnounce', {
          name: board.name,
          current: next.find((b) => b.id === fallback)?.name ?? '',
        }),
      );
      // If the deleted board was the one being viewed, switch to the promoted
      // default so the board page isn't left pointing at a gone board.
      if (wasActive && fallback) selectBoard(fallback);
    } catch {
      if (snapshot) setBoards(snapshot);
      toast({
        variant: 'error',
        title: t('boardWriteErrorTitle'),
        description: t('boardDeleteErrorDescription'),
      });
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <button
        type="button"
        data-testid="board-switcher-retry"
        onClick={() => {
          setBoards(null);
          setLoadError(false);
          setReloadKey((k) => k + 1);
        }}
        className="inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) text-sm text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {t('boardListErrorRetry')}
      </button>
    );
  }

  if (!boards || !activeBoard) {
    // Skeleton trigger while the board list resolves (design: states section).
    return (
      <div
        data-testid="board-switcher-skeleton"
        aria-hidden
        className="h-(--height-control) w-40 animate-pulse rounded-(--radius-input) bg-(--el-muted)"
      />
    );
  }

  return (
    <div className="flex items-center">
      <Popover
        open={menuOpen}
        onOpenChange={(o) => {
          setMenuOpen(o);
          if (!o) setManageId(null);
        }}
      >
        <Popover.Trigger
          aria-label={isSettings ? t('configureBoardTriggerAria') : t('switcherTriggerAria')}
          aria-haspopup="menu"
          data-testid="board-switcher-trigger"
          className="inline-flex h-(--height-control) max-w-[260px] items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) font-sans text-sm font-semibold text-(--el-text-strong) hover:border-(--el-border-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none data-[state=open]:border-(--el-border-strong) data-[state=open]:shadow-(--shadow-subtle)"
        >
          <BoardTypeIcon
            type={activeBoard.type}
            className="h-[15px] w-[15px] shrink-0 text-(--el-text-muted)"
            aria-hidden
            data-testid="board-switcher-trigger-icon"
          />
          <span className="truncate">{activeBoard.name}</span>
          {activeBoard.isDefault ? (
            // The badge keeps its word on one line; a long board NAME (user
            // data) is what gives way, through its own `truncate` (MOTIR-7761).
            <Pill
              tone="neutral"
              className="shrink-0 whitespace-nowrap"
              data-testid="board-switcher-active-default"
            >
              {t('defaultBadge')}
            </Pill>
          ) : null}
          <ChevronDown className="ml-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
        </Popover.Trigger>

        <Popover.Content
          align="start"
          width={300}
          role="menu"
          aria-label={isSettings ? t('configureBoardMenuAria') : t('switcherMenuAria')}
          data-testid="board-switcher-menu"
          // overflow-visible (twMerge overrides the primitive's base overflow-hidden)
          // so the per-board manage `[⋯]` flyout — absolutely positioned inside this
          // content — isn't CLIPPED by the popover box (it opens below/right of a row).
          className="overflow-visible p-0"
        >
          <div className="flex flex-col gap-0.5 p-1.5">
            <p className="px-2 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
              {t('switcherMenuCap')}
            </p>

            {boards.map((board) => {
              const isActive = board.id === activeId;
              return (
                <div
                  key={board.id}
                  role="presentation"
                  className={`relative flex items-center gap-0.5 rounded-(--radius-control) ${
                    isActive ? 'bg-(--el-muted)' : 'hover:bg-(--el-muted)'
                  }`}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    data-testid={`board-switcher-pick-${board.id}`}
                    onClick={() => selectBoard(board.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13.5px] text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                  >
                    <Check
                      className={`h-[15px] w-[15px] shrink-0 text-(--el-accent-on-surface) ${
                        isActive ? '' : 'invisible'
                      }`}
                      aria-hidden
                    />
                    <BoardTypeIcon
                      type={board.type}
                      className="h-[15px] w-[15px] shrink-0 text-(--el-text-muted)"
                      aria-hidden
                      data-testid={`board-switcher-type-icon-${board.id}`}
                    />
                    <span className="truncate">{board.name}</span>
                    {board.isDefault ? (
                      <Pill tone="neutral" data-testid={`board-switcher-default-${board.id}`}>
                        {t('defaultBadge')}
                      </Pill>
                    ) : null}
                  </button>

                  {showManage ? (
                    <button
                      type="button"
                      aria-label={t('manageBoardAria', { name: board.name })}
                      aria-haspopup="menu"
                      aria-expanded={manageId === board.id}
                      data-testid={`board-switcher-manage-${board.id}`}
                      onClick={() => setManageId((cur) => (cur === board.id ? null : board.id))}
                      className="mr-0.5 inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                    >
                      <MoreHorizontal className="h-4 w-4" aria-hidden />
                    </button>
                  ) : null}

                  {manageId === board.id ? (
                    <div
                      role="menu"
                      aria-label={t('manageBoardAria', { name: board.name })}
                      data-testid={`board-switcher-manage-menu-${board.id}`}
                      data-menu-surface=""
                      className="absolute top-8 right-0 z-10 flex w-56 flex-col gap-0.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding-4) shadow-(--shadow-elevated)"
                    >
                      <ManageItem
                        icon={<Pencil className="h-4 w-4" aria-hidden />}
                        label={t('renameBoard')}
                        testId={`board-switcher-rename-${board.id}`}
                        onClick={() => {
                          setManageId(null);
                          setMenuOpen(false);
                          setRenameTarget(board);
                        }}
                      />
                      <ManageItem
                        icon={<Star className="h-4 w-4" aria-hidden />}
                        label={t('setDefaultBoard')}
                        testId={`board-switcher-setdefault-${board.id}`}
                        disabled={board.isDefault}
                        onClick={() => void setDefaultBoard(board)}
                      />
                      {/* Board settings (Subtask 3.7.8) — the Jira-faithful
                          reached-FROM-the-board path: deep-links to that board's
                          config (`?board=<id>`). A Link, not a button, so the whole
                          row is one navigation target (no nested button). */}
                      <ManageItem
                        icon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}
                        label={t('boardSettings')}
                        testId={`board-switcher-settings-${board.id}`}
                        href={`/settings/project/board?board=${encodeURIComponent(board.id)}`}
                        onClick={() => {
                          setManageId(null);
                          setMenuOpen(false);
                        }}
                      />
                      <div className="mx-0.5 my-1 h-px bg-(--el-border)" />
                      <ManageItem
                        icon={<Trash2 className="h-4 w-4" aria-hidden />}
                        label={t('deleteBoard')}
                        testId={`board-switcher-delete-${board.id}`}
                        danger
                        disabled={isLastBoard}
                        onClick={() => {
                          setManageId(null);
                          setMenuOpen(false);
                          setDeleteTarget(board);
                        }}
                      />
                      {isLastBoard ? (
                        <p
                          data-testid="board-switcher-lastboard-note"
                          className="px-2 pt-1 pb-0.5 text-[11.5px] leading-snug text-(--el-text-secondary)"
                        >
                          {t('lastBoardNote')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {showManage ? (
              <>
                <div className="mx-0.5 my-1 h-px bg-(--el-border)" />
                <button
                  type="button"
                  role="menuitem"
                  data-testid="board-switcher-new"
                  onClick={() => {
                    setMenuOpen(false);
                    setManageId(null);
                    setNewOpen(true);
                  }}
                  className="flex items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13.5px] font-medium text-(--el-accent-on-surface) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                >
                  <Plus className="h-4 w-4 shrink-0" aria-hidden />
                  {t('newBoard')}
                </button>
              </>
            ) : null}
          </div>
        </Popover.Content>
      </Popover>

      {/* aria-live: switch / create / rename / delete-and-promote outcomes. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="board-switcher-live">
        {live}
      </span>

      {newOpen ? (
        <BoardFormModal
          mode="create"
          filterLookups={filterLookups}
          onClose={() => setNewOpen(false)}
          onSubmit={async (name, type, filter) => {
            try {
              return await createBoard(name, type, filter);
            } catch {
              toast({
                variant: 'error',
                title: t('boardWriteErrorTitle'),
                description: t('boardCreateErrorDescription'),
              });
              return undefined;
            }
          }}
        />
      ) : null}

      {renameTarget ? (
        <BoardFormModal
          mode="rename"
          initialName={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          onSubmit={async (name) => renameBoard(renameTarget, name)}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteBoardModal
          name={deleteTarget.name}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void deleteBoard(deleteTarget)}
        />
      ) : null}
    </div>
  );
}

function ManageItem({
  icon,
  label,
  testId,
  onClick,
  disabled,
  danger,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** When set, the item is a navigation Link (e.g. Board settings) rather than a
   *  button — the whole row is one accessible target, no nested button. */
  href?: string;
}) {
  const className = `flex items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[13.5px] focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 ${
    danger
      ? 'text-(--el-danger) hover:bg-(--el-tint-rose)'
      : 'text-(--el-text) hover:bg-(--el-muted)'
  }`;
  const body = (
    <>
      <span className={`shrink-0 ${danger ? 'text-(--el-danger)' : 'text-(--el-text-muted)'}`}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        role="menuitem"
        data-testid={testId}
        onClick={onClick}
        className={className}
      >
        {body}
      </Link>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={className}
    >
      {body}
    </button>
  );
}

// The create / rename modal — an Input (name) + (create only) a Kanban/Scrum
// type picker. Both types are real, selectable options (the Scrum board view
// landed in Story 4.5, so the old "Epic 4" disabled seam is gone); Kanban stays
// the default. Submitting hands the trimmed name (+ chosen type) up; an empty
// name is blocked client-side (mirrors the service guard). In create mode with
// `filterLookups`, it also carries the optional Board filter section
// (MOTIR-11333): the dialog widens to `xl` once a filter is added, posts the
// section's committed envelope, and on a 422 refusal shows it in the section and
// stays open with every field as typed.
function BoardFormModal({
  mode,
  initialName = '',
  filterLookups,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'rename';
  initialName?: string;
  filterLookups?: BoardFilterLookups;
  onClose: () => void;
  onSubmit: (
    name: string,
    type: BoardType,
    filter?: FilterEnvelope,
  ) => void | CreateOutcome | undefined | Promise<void | CreateOutcome | undefined>;
}) {
  const t = useTranslations('boards');
  const showFilter = mode === 'create' && filterLookups !== undefined;
  const filterDraft = useBoardFilterDraft(filterLookups ?? NO_LOOKUPS);
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<BoardType>('kanban');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The two board types as a single-selection radio group (Kanban default).
  const typeOptions: { value: BoardType; icon: LucideIcon; label: string }[] = [
    { value: 'kanban', icon: BOARD_TYPE_ICON.kanban, label: t('boardTypeKanban') },
    { value: 'scrum', icon: BOARD_TYPE_ICON.scrum, label: t('boardTypeScrum') },
  ];
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow-key roving focus across the radio group: move selection AND focus to
  // the neighbour, wrapping at the ends (the WAI-ARIA radiogroup pattern).
  function moveType(from: number, delta: number) {
    const to = (from + delta + typeOptions.length) % typeOptions.length;
    const option = typeOptions[to];
    if (!option) return;
    setType(option.value);
    tileRefs.current[to]?.focus();
  }
  function onTileKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveType(index, 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveType(index, -1);
    }
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('boardNameRequired'));
      return;
    }
    const committed: { ast: FilterAst; envelope: FilterEnvelope } | null = showFilter
      ? filterDraft.committedFilter()
      : null;
    setSaving(true);
    try {
      const outcome = await onSubmit(trimmed, type, committed?.envelope);
      if (outcome && !outcome.ok && committed) {
        filterDraft.setRefusal(outcome.refusal, committed.ast);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size={showFilter && filterDraft.open ? 'xl' : 'sm'}
      title={mode === 'create' ? t('newBoardTitle') : t('renameBoardTitle')}
    >
      {/* Modal.Body owns the scroll: with the Board filter section's builder
          (up to 20 conditions, MOTIR-11333) the create dialog has no bounded
          height, so its footer must stay reachable on a short viewport. */}
      <Modal.Body className="flex flex-col gap-4">
        <Input
          label={t('boardNameLabel')}
          autoFocus
          value={name}
          maxLength={NAME_MAX}
          error={error ?? undefined}
          data-testid={mode === 'create' ? 'board-new-name' : 'board-rename-name'}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />

        {mode === 'create' ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-(--el-text-secondary)">
              {t('boardTypeLabel')}
            </legend>
            <div
              role="radiogroup"
              aria-label={t('boardTypeLabel')}
              className="grid grid-cols-2 gap-2"
            >
              {typeOptions.map(({ value, icon: Icon, label }, index) => {
                const selected = type === value;
                return (
                  <button
                    key={value}
                    ref={(el) => {
                      tileRefs.current[index] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    data-testid={`board-type-${value}`}
                    onClick={() => setType(value)}
                    onKeyDown={(e) => onTileKeyDown(e, index)}
                    className={`flex items-center gap-2 rounded-(--radius-input) border px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${
                      selected
                        ? 'border-(--el-accent) bg-(--el-muted) font-medium text-(--el-text)'
                        : 'border-(--el-border) text-(--el-text)'
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${selected ? 'text-(--el-accent-on-surface)' : 'text-(--el-text-muted)'}`}
                      aria-hidden
                    />
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="mt-0.5 text-[11.5px] leading-snug text-(--el-text-muted)">
              {t('newBoardSeedHint')}
            </p>
          </fieldset>
        ) : null}

        {showFilter && filterLookups ? (
          <BoardFilterSection draft={filterDraft} lookups={filterLookups} />
        ) : null}
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          loading={saving}
          onClick={() => void submit()}
          data-testid={mode === 'create' ? 'board-new-submit' : 'board-rename-submit'}
        >
          {mode === 'create' ? t('createBoard') : t('save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Empty lookups for a dialog with no Filter section (the hook still runs, so
 * the hook order never depends on the mode). */
const NO_LOOKUPS: BoardFilterLookups = {
  statuses: [],
  members: [],
  sprints: [],
  customFields: [],
  components: [],
  folders: { folders: [], truncated: false },
  referencedLabels: [],
  projectKey: '',
};

// The destructive delete confirm — a danger title + an info callout making the
// board-≠-issue-owner contract explicit (issues survive on the project), then a
// danger confirm. The callout puts the hue in the tinted BACKGROUND with
// `--el-text-strong` (finding #35).
function DeleteBoardModal({
  name,
  onClose,
  onConfirm,
}: {
  name: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('boards');
  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="sm"
      title={t('deleteBoardTitle', { name })}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-(--el-text-secondary)">{t('deleteBoardBody')}</p>
        <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) text-sm text-(--el-text-strong)">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <b>{t('deleteBoardCalloutLead')}</b> {t('deleteBoardCalloutBody')}
          </span>
        </div>
      </div>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="danger"
          leftIcon={<Trash2 className="h-4 w-4" />}
          data-testid="board-delete-confirm"
          onClick={onConfirm}
        >
          {t('deleteBoardConfirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
