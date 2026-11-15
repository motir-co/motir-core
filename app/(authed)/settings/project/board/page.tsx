import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Columns3, SearchX } from 'lucide-react';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workflowsService } from '@/lib/services/workflowsService';
import { boardsService } from '@/lib/services/boardsService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { componentsService } from '@/lib/services/componentsService';
import { BoardNotFoundError } from '@/lib/boards/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { BoardSwitcher } from '../../../boards/_components/BoardSwitcher';
import { BoardConfigEditor, type BoardConfigModel } from './_components/BoardConfigEditor';
import { BoardStoredFilterEditor } from './_components/BoardStoredFilterEditor';
import { guardSettingsPage } from '../_guard';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

// Board settings — server component (Subtask 3.6.3, made PER-BOARD by 3.7.8).
// The board ADMINISTRATION surface: a project admin manages a board's COLUMNS
// (add / rename / reorder / delete) and the COLUMN ↔ STATUS mapping the 3.2.6
// unmapped tray points at, and renames the board. SIBLING of the Workflow editor
// (settings/project/workflow, Story 2.2.5) — Workflow owns statuses +
// transitions; Board owns how those statuses map onto columns.
//
// PER-BOARD (Subtask 3.7.8, per `design/boards/per-board-settings.mock.html`):
// with multiple boards per project (Story 3.7) each board carries its OWN columns
// / mapping / swimlane group-by / WIP, so this page targets the SELECTED board.
// It reads `?board=<id>` (defaulting to the project's default board when absent;
// a board outside the active project/workspace → a tenant-safe not-found, never a
// cross-tenant read — the 3.7.5 guard), builds its model from THAT board's
// projection, and renders a header that NAMES the board + a board switcher
// (`variant="settings"`) so the admin sees which board they're editing and can
// switch (which re-targets `?board=` and re-lays the editor). 3.7.5 already taught
// `boardsService.getBoard` to take a `boardId`, and the 3.6.2 config writes are
// already board-scoped — so this is a UI/URL threading of the selected board, no
// service/schema change.
//
// Mirrors the Workflow page grammar: resolve the active project + the caller's
// admin role (owner == project admin in v1, finding #36 / TODO(6.4)) + the
// board's current config, then hand typed serializable data to the client
// `BoardConfigEditor`. Every WRITE is re-gated server-side in boardsService
// (3.6.2), so a non-owner who reaches the page (read-only) still can't mutate;
// `isAdmin` here only governs whether the edit affordances render.
//
// The initial model is built from the Story-3.1.4 board projection
// (`boardsService.getBoard` — columns + their mapped status KEYS + per-column
// card counts + `unmappedStatuses`) joined to the project's full status list so
// each mapped status resolves to its {id,label} (the projection gives keys; map
// / unmap need the id).

/**
 * The page's `?board=` parsing (Subtask 3.7.8): a blank / whitespace-only value
 * is treated as ABSENT (→ the project's default board), a non-blank value is the
 * selected board id. Exported so the resolution is unit-testable.
 */
export function resolveSelectedBoardId(raw: string | undefined): string | undefined {
  return raw?.trim() || undefined;
}

export default async function ProjectBoardSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `board`, never re-declared here.
  const refused = await guardSettingsPage('board', ctx);
  if (refused) return refused;

  // The selected board (Subtask 3.7.8) — `?board=<id>` picks WHICH board to
  // configure; absent → the project's default board.
  const sp = await searchParams;
  const selectedBoardId = resolveSelectedBoardId(sp.board);

  // MOTIR-2473 retired the private admin derivation that used to sit here — a
  // WORKSPACE-OWNER check (`isLegacyOwnerRole`) standing in for "may configure this",
  // which was both a second policy and a tighter one than the key the service
  // actually asserts. The page is reached only by an actor who holds its registry
  // key (the guard above), so the edit affordances are simply on.
  const isAdmin = true;

  // MOTIR-3558 — allocation row 2: SERIAL → CONCURRENT, plus the frame, plus the
  // family's one no-shift hazard.
  //
  // ⚠️ TWO BOUNDARIES, ONE PROMISE — the shape `app/(authed)/items/[key]` already
  // ships (MOTIR-3436, `motir-core/CLAUDE.md`). The board read is started HERE
  // and awaited nowhere on this line: the breadcrumb boundary and the body
  // boundary both consume the same promise, so the page still issues exactly one
  // `getBoard`. Awaiting it here instead would put the whole page back behind it.
  //
  // WHY the breadcrumb needs a boundary of its own: `BoardSettingsHeader` renders
  // its `text-xs` crumb ABOVE the <h1>, and only when `boardName` is present —
  // and `boardName` comes from this read. It is tier-2 CONTENT sitting in a
  // tier-1 POSITION, which is the one place in the family where that happens. A
  // single boundary below the header could never fill it (streamed tier-1 markup
  // does not re-render), and a single boundary above the header would hide a
  // title that is perfectly knowable. So the crumb gets its own small boundary
  // whose fallback is the reserved `h-4` line the asset asks for, and the title
  // row beside it paints from the gate. This is NOT the "third tier" AC 6 rules
  // out — that means content arriving AFTER the page, and row 6 is the family's
  // only one.
  //
  // ⚠️ ONE BEHAVIOUR CHANGE, on the two EMPTY paths, and it is a consequence of
  // streaming rather than a choice about them. Before this card the no-board case
  // rendered a DIFFERENT header — `PlainHeader`, with no board switcher, on the
  // reasoning that there is nothing to switch between. A streamed page commits its
  // header before it knows whether a board exists, so both empty paths now render
  // the standard header, switcher included. The switcher is self-fetching and
  // renders empty; nothing else about either empty state moves. Recorded on
  // MOTIR-3443 — the alternative is to hold the whole header behind the read,
  // which is the wait this card exists to remove.
  const boardPromise = boardsService.getBoard(
    ctx.projectId,
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    selectedBoardId,
  );
  const statusesPromise = workflowsService.listStatusesByProject(ctx.projectId, ctx.workspaceId);
  // The stored-filter editor's builder lookups (MOTIR-10560 · MOTIR-11334) —
  // the reads the board toolbar makes for the same builder (no Folder field: no
  // board surface offers one). None of them needs the board, so they start here
  // and join the board read's wave.
  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const lookupsPromise = allSettledOrThrow([
    assignableMembersService.list({
      projectId: ctx.projectId,
      accessMode: ctx.project.accessMode,
      ctx: wsCtx,
    }),
    sprintsService.listByProject(ctx.projectId, wsCtx),
    customFieldsService.listFields({
      key: ctx.project.identifier,
      actorUserId: ctx.userId,
      ctx: wsCtx,
    }),
    componentsService.listComponents(ctx.project.identifier, wsCtx),
  ]);

  return (
    <div className="mx-auto flex max-w-[52rem] flex-col gap-6">
      <BoardSettingsHeader
        projectName={ctx.project.name}
        boardName={boardPromise.then((p) => p.name).catch(() => undefined)}
      />
      <Suspense fallback={<SettingsPaneFrame />}>
        <BoardPaneBody
          boardPromise={boardPromise}
          statusesPromise={statusesPromise}
          lookupsPromise={lookupsPromise}
          projectKey={ctx.project.identifier}
          selectedBoardId={selectedBoardId}
          isAdmin={isAdmin}
        />
      </Suspense>
    </div>
  );
}

/**
 * The board's two reads, below the boundary and now in ONE wave.
 *
 * `allSettledOrThrow` rather than a bare `Promise.all`: `getBoard` rejects on the
 * ORDINARY not-found path (a stale / cross-project `?board=`), and both arms open
 * a transaction — so `Promise.all` would abandon the statuses read mid-flight on
 * every refused board (MOTIR-3066). Array order also makes the rejection the
 * caller sees deterministic: the board's error, not whichever failed first.
 */
async function BoardPaneBody({
  boardPromise,
  statusesPromise,
  lookupsPromise,
  projectKey,
  selectedBoardId,
  isAdmin,
}: {
  boardPromise: ReturnType<typeof boardsService.getBoard>;
  statusesPromise: ReturnType<typeof workflowsService.listStatusesByProject>;
  lookupsPromise: Promise<
    [
      Awaited<ReturnType<typeof assignableMembersService.list>>,
      Awaited<ReturnType<typeof sprintsService.listByProject>>,
      Awaited<ReturnType<typeof customFieldsService.listFields>>,
      Awaited<ReturnType<typeof componentsService.listComponents>>,
    ]
  >;
  projectKey: string;
  selectedBoardId: string | undefined;
  isAdmin: boolean;
}) {
  const t = await getTranslations('settings');

  let projection;
  let statuses;
  let lookups;
  try {
    [projection, statuses, lookups] = await allSettledOrThrow([
      boardPromise,
      statusesPromise,
      lookupsPromise,
    ]);
  } catch (err) {
    if (err instanceof BoardNotFoundError) {
      // A stale / cross-project / cross-workspace `?board=` id → a tenant-safe
      // not-found (3.7.5), with the switcher still present so the admin can pick a
      // real board. When NO `?board=` was supplied the project simply has no
      // default board yet — the original no-board empty state (no switcher to
      // show, since there are no boards).
      if (selectedBoardId) {
        return (
          <EmptyState
            icon={<SearchX />}
            title={t('board.notFoundTitle')}
            description={t('board.notFoundDescription')}
          />
        );
      }
      return (
        <EmptyState title={t('board.noBoardTitle')} description={t('board.noBoardDescription')} />
      );
    }
    throw err;
  }

  // Resolve each column's mapped status KEYS (from the projection) to {id,label}
  // via the project's full status list — map / unmap are keyed by status id.
  const statusByKey = new Map(statuses.map((s) => [s.key, s] as const));

  const model: BoardConfigModel = {
    boardId: projection.boardId,
    boardName: projection.name,
    columns: projection.columns.map((c) => ({
      id: c.id,
      name: c.name,
      position: c.position,
      cardCount: c.totalCount,
      statuses: c.statusKeys
        .map((key) => statusByKey.get(key))
        .filter((s): s is (typeof statuses)[number] => s != null)
        .map((s) => ({ id: s.id, label: s.label })),
    })),
    unmapped: projection.unmappedStatuses.map((s) => ({ id: s.id, label: s.label })),
  };

  // The labels the stored filter names come with the board read itself
  // (`storedFilter.labels`, resolved with the filter's referents), so no read
  // here waits for the board.
  const [members, sprints, customFields, components] = lookups;
  const referencedLabels = projection.storedFilter?.labels ?? [];

  // Key by boardId so switching the configured board (the `?board=` change)
  // REMOUNTS each editor with the new board's model, rather than leaving its
  // mount-seeded state on the previous board. The stored-filter editor sits at
  // the top of the page, above the column editor (the approved design, panel 5).
  return (
    <div className="flex flex-col gap-6">
      <BoardStoredFilterEditor
        key={`filter-${model.boardId}`}
        boardId={model.boardId}
        boardType={projection.type}
        storedFilter={projection.storedFilter}
        lookups={{
          statuses,
          members,
          sprints,
          customFields,
          components,
          referencedLabels,
          projectKey,
        }}
      />
      <BoardConfigEditor key={model.boardId} model={model} isAdmin={isAdmin} />
    </div>
  );
}

// The board-scoped settings header (Subtask 3.7.8, re-cut by MOTIR-3558) — the
// crumb + a head-row whose LEFT is the serif title + subtitle and whose RIGHT is
// the "Configuring board" label + the board switcher (`variant="settings"`:
// switch-only, no New/manage — picking a board re-targets `?board=` and re-lays
// this page). Per `design/boards/per-board-settings.mock.html` panel 0.
//
// ⚠️ It renders ABOVE the page's boundary, because everything in the head-row is
// knowable at the gate. The CRUMB is not: it names the board, which is the
// pending read. So the crumb alone sits behind its own small boundary whose
// fallback is the reserved `h-4` line, and the title beside it paints
// immediately. `boardName` is therefore a PROMISE, not a string — resolving it
// here would put the title back behind the read.
async function BoardSettingsHeader({
  projectName,
  boardName,
}: {
  projectName: string;
  boardName: Promise<string | undefined>;
}) {
  const t = await getTranslations('settings');
  return (
    <header className="flex flex-col gap-2">
      {/* THE RESERVED LINE (design/settings/design-notes.md § the no-shift
          hazard). The crumb is one `text-xs` line; the fallback is an `h-4`
          block of the same height in the same position, so the title does not
          jump when the board name lands. This is the only tier-1 REGION in the
          settings family that changes on settle. */}
      <Suspense fallback={<div className="h-4 w-64 rounded-(--radius-control) bg-(--el-muted)" />}>
        <BoardCrumb projectName={projectName} boardName={boardName} />
      </Suspense>
      {/* Side-by-side, NON-wrapping head-row (title left, switcher right) per the
          design mock. The left block shrinks (`min-w-0`) and the switcher block
          holds its width (`shrink-0`) so the switcher stays on the SAME row — a
          wrap here would push the whole board-config editor down far enough that
          the column-reorder drag's target lands at the viewport bottom and dnd
          autoscroll never settles (it never fires the reorder PATCH). */}
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-center gap-2.5 font-serif text-3xl font-semibold text-(--el-text)">
            <Columns3 className="text-(--el-text-muted) size-6 shrink-0" aria-hidden />
            {t('board.title')}
          </h1>
          <p className="text-(--el-text-muted) max-w-[34rem] font-sans text-sm">
            {t('board.subtitle')}
          </p>
        </div>
        {/* The per-board switcher — NAMES which board is being configured + lets
            the admin switch which board they edit. */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <SectionLabel label={t('board.configuringBoardLabel')} />
          <BoardSwitcher variant="settings" />
        </div>
      </div>
    </header>
  );
}

/** The crumb itself — awaits the shared board promise and renders nothing when
 *  there is no board to name (the not-found and no-board paths both land here). */
async function BoardCrumb({
  projectName,
  boardName,
}: {
  projectName: string;
  boardName: Promise<string | undefined>;
}) {
  const name = await boardName;
  if (!name) return null;
  const t = await getTranslations('settings');
  return (
    <p className="text-xs text-(--el-text-muted)">
      {t('board.breadcrumb', { project: projectName, board: name })}
    </p>
  );
}
