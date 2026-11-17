// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { encodeFilterEnvelope, encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';
import type { AppliedSavedFilter } from '@/lib/issues/savedFilterApplied';
import type { StoredBoardFilterDto } from '@/lib/dto/boards';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { Viewer } from '@/app/(authed)/filters/_components/savedFiltersClient';
import { ToastProvider } from '@/components/ui/Toast';
import enMessages from '@/messages/en.json';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The board's header filter controls (MOTIR-11565, design
// board--header-board-filter.mock.html) under happy-dom: the header starts as
// the board's stored filter (seeded into the applied row and the toolbar), the
// Edited state with Save to board filter / Save as / Reset, the confirm and the
// write it sends (body + navigation after), the 422 / 403 / failure toasts,
// the Cleared and saved-filter states, role gating, a Visitor, stale
// conditions, and the board's filtered-empty variants.

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/boards',
}));

import { BoardAppliedFilterBar } from '@/app/(authed)/boards/_components/BoardAppliedFilterBar';
import { BoardFilterControls } from '@/app/(authed)/boards/_components/BoardFilterControls';
import { BoardFilteredEmptyState } from '@/app/(authed)/boards/_components/BoardFilteredEmptyState';
import {
  BoardHeaderFilterProvider,
  useBoardHeaderFilterContext,
  useBoardStoredFilter,
  type PublishedBoardFilter,
} from '@/app/(authed)/boards/_components/BoardHeaderFilterContext';
import {
  SavedFilterSessionProvider,
  useSavedFilterSession,
} from '@/app/(authed)/items/_components/SavedFilterContext';
import {
  AdvancedFilterProvider,
  useAdvancedFilterPopover,
} from '@/app/(authed)/items/_components/AdvancedFilterContext';

const H = enMessages.boards.headerFilter;
const B = enMessages.boards;

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  push.mockReset();
  refresh.mockReset();
  vi.unstubAllGlobals();
  cleanup();
});

const KIND_BUG: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
};
const KIND_BUG_HIGH: FilterAst = {
  combinator: 'and',
  conditions: [
    { field: 'kind', operator: 'is_any_of', value: ['bug'] },
    { field: 'priority', operator: 'is_any_of', value: ['high'] },
  ],
};
const LABEL_MOBILE: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'lbl', operator: 'is_any_of', value: ['lbl_mobile'] }],
};

const NO_FOLDERS: ProjectFoldersDto = { folders: [], truncated: false };

// The project's folders (MOTIR-11667): "Done" and a folder inside it, so a
// summary is told apart from an id by its PATH.
const FOLDERS: ProjectFoldersDto = {
  truncated: false,
  folders: [
    { id: 'f-done', parentFolderId: null, name: 'Done', position: 'a0', path: ['Done'] },
    {
      id: 'f-done-oct',
      parentFolderId: 'f-done',
      name: 'Oct 2026',
      position: 'a0',
      path: ['Done', 'Oct 2026'],
    },
  ],
};
const NOT_DONE: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'folder', operator: 'is_none_of', value: ['f-done'] }],
};
const IN_DONE_OCT: FilterAst = {
  combinator: 'and',
  conditions: [
    { field: 'folder', operator: 'is_none_of', value: ['f-done'] },
    { field: 'folder', operator: 'is_any_of', value: ['f-done-oct'] },
  ],
};

const VIEWER: Viewer = { userId: 'u-alice', canBrowse: true, canShare: true, canManageAny: false };

function stored(ast: FilterAst, extra: Partial<StoredBoardFilterDto> = {}): StoredBoardFilterDto {
  return { envelope: encodeFilterEnvelope(ast), staleConditions: [], labels: [], ...extra };
}

/** Stands in for BoardContainer: publishes the board read into the context. */
function Publish({ value }: { value: PublishedBoardFilter }) {
  const ctx = useBoardHeaderFilterContext();
  const publish = ctx?.publish;
  useEffect(() => {
    publish?.(value);
  }, [publish, value]);
  return null;
}

/** Seeds the saved-filter session, as the [Saved] dropdown would on an apply. */
function Apply({ applied }: { applied: AppliedSavedFilter }) {
  const session = useSavedFilterSession();
  const setApplied = session?.setApplied;
  useEffect(() => {
    setApplied?.(applied);
  }, [setApplied, applied]);
  return null;
}

/** Shows what the session holds, so a test can see it let go. */
function SessionProbe() {
  const session = useSavedFilterSession();
  return <span data-testid="session-applied">{session?.applied?.name ?? 'none'}</span>;
}

/** Shows the context's reload tick, so a test can see a re-read asked for. */
function ReloadProbe() {
  const ctx = useBoardHeaderFilterContext();
  return <span data-testid="reload-tick">{ctx?.reloadTick ?? -1}</span>;
}

/** Shows whether the Advanced builder was asked to open. */
function AdvancedProbe() {
  const popover = useAdvancedFilterPopover();
  return <span data-testid="advanced-open">{popover?.open ? 'open' : 'closed'}</span>;
}

function wrap(children: ReactNode) {
  return (
    <ToastProvider>
      <AdvancedFilterProvider>
        <SavedFilterSessionProvider>
          <BoardHeaderFilterProvider>{children}</BoardHeaderFilterProvider>
        </SavedFilterSessionProvider>
      </AdvancedFilterProvider>
    </ToastProvider>
  );
}

interface BarOpts {
  storedFilter?: StoredBoardFilterDto | null;
  boardType?: 'kanban' | 'scrum';
  filter?: IssueFilter;
  ast?: FilterAst | null;
  boardFilterOff?: boolean;
  canConfigure?: boolean;
  savedFilters?: boolean;
  applied?: AppliedSavedFilter;
  selectedBoardId?: string;
  publishFor?: string | null;
  folders?: ProjectFoldersDto;
}

function renderBar(opts: BarOpts = {}) {
  const value: PublishedBoardFilter = {
    requestedBoardId:
      opts.publishFor === undefined ? (opts.selectedBoardId ?? null) : opts.publishFor,
    boardId: 'brd_1',
    boardType: opts.boardType ?? 'kanban',
    storedFilter: opts.storedFilter === undefined ? stored(KIND_BUG) : opts.storedFilter,
  };
  const ast = opts.ast ?? null;
  const filter = opts.filter ?? { ...EMPTY_FILTER, advanced: ast ? encodeFilterParam(ast) : null };
  return renderWithIntl(
    wrap(
      <>
        <Publish value={value} />
        {opts.applied ? <Apply applied={opts.applied} /> : null}
        <BoardAppliedFilterBar
          selectedBoardId={opts.selectedBoardId}
          projectKey="BRD"
          viewer={VIEWER}
          filter={filter}
          ast={ast}
          statuses={[]}
          members={[]}
          sprints={[]}
          customFields={[]}
          components={[]}
          folders={opts.folders ?? NO_FOLDERS}
          referencedLabels={[]}
          boardFilterOff={opts.boardFilterOff ?? false}
          canConfigure={opts.canConfigure ?? true}
          savedFilters={opts.savedFilters ?? true}
        />
        <SessionProbe />
        <ReloadProbe />
        <AdvancedProbe />
      </>,
    ),
  );
}

function stubFetch(response: { status: number; body?: unknown } | 'throw') {
  const fetchMock = vi.fn(async () => {
    if (response === 'throw') throw new Error('offline');
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const chip = () => screen.getByRole('button', { name: H.chipAria });
const actions = () => screen.queryByTestId('board-filter-actions');

describe('the header starts as the board filter', () => {
  it('opens clean: the Board filter chip and the stored conditions, no Edited, no actions', () => {
    renderBar();
    expect(chip().textContent).toContain(H.chip);
    expect(chip().getAttribute('aria-haspopup')).toBe('dialog');
    expect(screen.getByTestId('board-header-filter').getAttribute('data-mode')).toBe('board');
    // The stored Kind condition is a chip on the row.
    const row = screen.getByTestId('board-header-filter');
    expect(within(row).getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByText(enMessages.savedFilters.applied.edited)).toBeNull();
    expect(actions()).toBeNull();
  });

  it('a board with no stored filter is the shipped bar: nothing until a filter applies', () => {
    const { container } = renderBar({ storedFilter: null });
    expect(screen.queryByTestId('board-header-filter')).toBeNull();
    expect(container.querySelector('[data-board-filter-chip]')).toBeNull();
  });

  it('a read made for another board selection is not used', () => {
    renderBar({ selectedBoardId: 'brd_2', publishFor: 'brd_1' });
    expect(screen.queryByTestId('board-header-filter')).toBeNull();
  });

  it('seeds the toolbar: the Advanced trigger counts the stored conditions', () => {
    renderWithIntl(
      wrap(
        <>
          <Publish
            value={{
              requestedBoardId: null,
              boardId: 'brd_1',
              boardType: 'kanban',
              storedFilter: stored(KIND_BUG_HIGH),
            }}
          />
          <BoardFilterControls
            filter={EMPTY_FILTER}
            ast={null}
            statuses={[]}
            members={[]}
            sprints={[]}
            customFields={[]}
            components={[]}
            folders={NO_FOLDERS}
            referencedLabels={[]}
            projectKey="BRD"
            viewer={VIEWER}
          />
        </>,
      ),
    );
    const advanced = screen.getByRole('button', { name: /advanced/i });
    expect(advanced.textContent).toContain('2');
    // Matching the board filter: no Reset in the builder header.
    fireEvent.click(advanced);
    expect(screen.queryByTestId('board-filter-reset-link')).toBeNull();
  });
});

describe('the Board filter chip', () => {
  it('opens the Advanced builder, as a condition chip does', () => {
    renderBar();
    expect(screen.getByTestId('advanced-open').textContent).toBe('closed');
    fireEvent.click(chip());
    expect(screen.getByTestId('advanced-open').textContent).toBe('open');
  });

  it('names a stored Label condition from the labels the board read carries', () => {
    renderBar({
      storedFilter: stored(LABEL_MOBILE, { labels: [{ id: 'lbl_mobile', name: 'mobile' }] }),
    });
    expect(screen.getByTestId('board-header-filter').textContent).toContain('mobile');
  });
});

describe('an edited header filter', () => {
  it('shows Edited and, for a board admin, Save to board filter · Save as · Reset', () => {
    renderBar({ ast: KIND_BUG_HIGH });
    expect(screen.getByTestId('board-header-filter').getAttribute('data-mode')).toBe('edited');
    expect(screen.getByText(enMessages.savedFilters.applied.edited)).toBeTruthy();
    const row = within(actions()!);
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual([
      H.saveToBoard,
      enMessages.savedFilters.applied.saveAs,
      H.reset,
    ]);
  });

  it('a member without board:configure gets Save as (with the why) and Reset, never Save to board filter', () => {
    renderBar({ ast: KIND_BUG_HIGH, canConfigure: false });
    const row = within(actions()!);
    expect(row.queryByRole('button', { name: H.saveToBoard })).toBeNull();
    expect(row.getByRole('button', { name: enMessages.savedFilters.applied.saveAs })).toBeTruthy();
    expect(row.getByRole('button', { name: H.reset })).toBeTruthy();
  });

  it('a Visitor gets Reset only: no saved filters, no save actions', () => {
    renderBar({ ast: KIND_BUG_HIGH, canConfigure: false, savedFilters: false });
    const row = within(actions()!);
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual([H.reset]);
  });

  it('Reset navigates to the board with no filter params and lets an applied saved filter go', () => {
    renderBar({ ast: KIND_BUG_HIGH, selectedBoardId: 'brd_1' });
    fireEvent.click(screen.getByRole('button', { name: H.reset }));
    expect(push).toHaveBeenCalledWith('/boards?board=brd_1');
  });

  it('Save to board filter confirms, PATCHes the merged conditions and returns to the board filter', async () => {
    const fetchMock = stubFetch({ status: 200, body: {} });
    renderBar({
      ast: KIND_BUG_HIGH,
      filter: { ...EMPTY_FILTER, advanced: encodeFilterParam(KIND_BUG_HIGH) },
    });
    fireEvent.click(screen.getByRole('button', { name: H.saveToBoard }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(H.confirmSaveTitle);
    expect(dialog.textContent).toContain(H.confirmSaveBody);
    // Cancel holds the initial focus: the safe choice is the default.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: H.cancel }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: H.saveToBoard }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/boards/brd_1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      filter: encodeFilterEnvelope(KIND_BUG_HIGH),
    });
    expect(await screen.findByText(H.savedToast)).toBeTruthy();
    expect(push).toHaveBeenCalledWith('/boards');
    expect(screen.getByTestId('reload-tick').textContent).toContain('1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Save as keeps the conditions as the reader’s own filter and applies it', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            filter: {
              id: 'sf_new',
              name: 'Bugs high',
              description: null,
              visibility: 'private',
              owner: { id: 'u-alice', name: 'Alice Chen' },
              starCount: 0,
              starredByMe: false,
              builtin: false,
              updatedAt: '2026-11-17T00:00:00.000Z',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderBar({ ast: KIND_BUG_HIGH, canConfigure: false });
    fireEvent.click(screen.getByRole('button', { name: enMessages.savedFilters.applied.saveAs }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(enMessages.savedFilters.save.nameLabel), {
      target: { value: 'Bugs high' },
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', { name: enMessages.savedFilters.save.submit }),
      );
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).filter).toBe(encodeFilterParam(KIND_BUG_HIGH));
    await waitFor(() =>
      expect(screen.getByTestId('session-applied').textContent).toBe('Bugs high'),
    );
    expect(push).toHaveBeenCalledWith(
      `/boards?filter=${encodeURIComponent(encodeFilterParam(KIND_BUG_HIGH))}`,
    );
  });

  it('a board admin’s Save as opens the save dialog, and its Cancel closes it', async () => {
    renderBar({ ast: KIND_BUG_HIGH });
    fireEvent.click(screen.getByRole('button', { name: enMessages.savedFilters.applied.saveAs }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: enMessages.savedFilters.save.cancel }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Escape closes the confirm', async () => {
    renderBar({ ast: KIND_BUG_HIGH });
    fireEvent.click(screen.getByRole('button', { name: H.saveToBoard }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Cancel closes the confirm and writes nothing', async () => {
    const fetchMock = stubFetch({ status: 200 });
    renderBar({ ast: KIND_BUG_HIGH });
    fireEvent.click(screen.getByRole('button', { name: H.saveToBoard }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: H.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  async function saveAndAnswer(response: Parameters<typeof stubFetch>[0], ast = KIND_BUG_HIGH) {
    stubFetch(response);
    renderBar({ ast });
    fireEvent.click(screen.getByRole('button', { name: H.saveToBoard }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: H.saveToBoard }));
    });
    expect(await screen.findByText(H.failTitle)).toBeTruthy();
    // Nothing changes: no navigation, the edits stay in the bar.
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId('board-header-filter').getAttribute('data-mode')).toBe('edited');
  }

  it('a 422 names the refused condition', async () => {
    await saveAndAnswer({
      status: 422,
      body: { code: 'FILTER_INVALID', error: 'that value is not allowed', conditionIndex: 1 },
    });
    expect(
      screen.getByText(
        'Condition 2 can’t be used: that value is not allowed. The board keeps its current filter.',
      ),
    ).toBeTruthy();
  });

  it('a 422 over the cap uses the settings sentence', async () => {
    await saveAndAnswer({ status: 422, body: { code: 'FILTER_TOO_LARGE', error: 'too many' } });
    expect(
      screen.getAllByText(/holds at most 20 conditions, and this one has 2/).length,
    ).toBeGreaterThan(0);
  });

  it('a 422 without a condition is the generic failure', async () => {
    await saveAndAnswer({ status: 422, body: { code: 'FILTER_INVALID', error: 'bad' } });
    expect(screen.getByText(H.failGeneric)).toBeTruthy();
  });

  it('a 403 says the right was lost and re-reads the page', async () => {
    await saveAndAnswer({ status: 403 });
    expect(screen.getByText(H.failForbidden)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('any other failure, or no answer at all, is the generic failure', async () => {
    await saveAndAnswer({ status: 500 });
    expect(screen.getByText(H.failGeneric)).toBeTruthy();
    cleanup();
    await saveAndAnswer('throw');
    expect(screen.getByText(H.failGeneric)).toBeTruthy();
  });
});

describe('the Cleared state', () => {
  it('says what the board shows and offers Remove board filter (no Save as)', async () => {
    const fetchMock = stubFetch({ status: 200 });
    renderBar({ boardFilterOff: true });
    expect(screen.getByTestId('board-header-filter').getAttribute('data-mode')).toBe('cleared');
    expect(screen.getByText(H.clearedNote)).toBeTruthy();
    const row = within(actions()!);
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual([H.saveToBoard, H.reset]);
    fireEvent.click(row.getByRole('button', { name: H.saveToBoard }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(H.confirmClearTitle);
    expect(dialog.textContent).toContain(H.confirmClearBody);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: H.confirmRemove }));
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ filter: null });
    expect(await screen.findByText(H.removedToast)).toBeTruthy();
    expect(push).toHaveBeenCalledWith('/boards');
  });

  it('a Scrum board names the active sprint', async () => {
    renderBar({ boardFilterOff: true, boardType: 'scrum' });
    expect(screen.getByText(H.clearedNoteScrum)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: H.saveToBoard }));
    expect((await screen.findByRole('dialog')).textContent).toContain(H.confirmClearBodyScrum);
  });
});

describe('a saved filter applied from Saved', () => {
  const applied: AppliedSavedFilter = {
    id: 'sf_1',
    name: 'Mobile',
    ownerName: 'Alice Chen',
    visibility: 'project',
    canOverwrite: true,
    builtin: false,
    envelopeParam: encodeFilterParam(LABEL_MOBILE),
  };

  it('keeps the saved chip, then a divider, Set as board filter (admin) and Reset', async () => {
    const fetchMock = stubFetch({ status: 200 });
    renderBar({ ast: LABEL_MOBILE, applied });
    await screen.findByRole('button', { name: /Mobile/ });
    expect(screen.queryByTestId('board-header-filter')).toBeNull();
    const row = within(actions()!);
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual([H.setAsBoard, H.reset]);
    fireEvent.click(row.getByRole('button', { name: H.setAsBoard }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Set “Mobile” as this board’s filter?');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: H.setAsBoard }));
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ filter: encodeFilterEnvelope(LABEL_MOBILE) });
    expect(await screen.findByText('Board filter set from “Mobile”')).toBeTruthy();
    // The saved-filter chip gives way: the header now IS the board filter.
    expect(screen.getByTestId('session-applied').textContent).toContain('none');
    expect(push).toHaveBeenCalledWith('/boards');
  });

  it('a member never sees Set as board filter', async () => {
    renderBar({ ast: LABEL_MOBILE, applied, canConfigure: false });
    await screen.findByRole('button', { name: /Mobile/ });
    expect(screen.queryByRole('button', { name: H.setAsBoard })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: H.reset }));
    expect(screen.getByTestId('session-applied').textContent).toContain('none');
    expect(push).toHaveBeenCalledWith('/boards');
  });

  it('a saved filter that equals the board filter offers no board actions', async () => {
    renderBar({
      ast: KIND_BUG,
      applied: { ...applied, envelopeParam: encodeFilterParam(KIND_BUG) },
    });
    await screen.findByRole('button', { name: /Mobile/ });
    expect(actions()).toBeNull();
  });
});

describe('stale and unreadable board filters', () => {
  it('marks the stale condition and the Board filter chip, with the admin hint', () => {
    const storedAst: FilterAst = {
      combinator: 'and',
      conditions: [KIND_BUG.conditions[0]!, LABEL_MOBILE.conditions[0]!],
    };
    renderBar({
      storedFilter: stored(storedAst, {
        staleConditions: [{ index: 1, field: 'lbl', reason: 'unknown-value' }],
      }),
    });
    expect(screen.getByTestId('board-filter-chip-stale').getAttribute('aria-label')).toBe(H.stale);
    const staleChips = document.querySelectorAll('[data-stale="true"]');
    expect(staleChips).toHaveLength(1);
    expect(within(staleChips[0] as HTMLElement).getByRole('img', { name: H.stale })).toBeTruthy();
  });

  it('an unreadable envelope shows the chip with the glyph and says it matches nothing', () => {
    renderBar({
      storedFilter: {
        envelope: null,
        staleConditions: [{ index: null, field: null, reason: 'invalid' }],
        labels: [],
      },
    });
    expect(screen.getByTestId('board-filter-chip-stale')).toBeTruthy();
    expect(screen.getByText(H.unreadable)).toBeTruthy();
  });
});

describe('the toolbar popovers carry Reset while the header differs', () => {
  it('the Advanced builder header shows Reset to board filter before Clear all', () => {
    renderWithIntl(
      wrap(
        <>
          <Publish
            value={{
              requestedBoardId: 'brd_1',
              boardId: 'brd_1',
              boardType: 'kanban',
              storedFilter: stored(KIND_BUG),
            }}
          />
          <BoardFilterControls
            selectedBoardId="brd_1"
            filter={{ ...EMPTY_FILTER, advanced: encodeFilterParam(KIND_BUG_HIGH) }}
            ast={KIND_BUG_HIGH}
            statuses={[]}
            members={[]}
            sprints={[]}
            customFields={[]}
            components={[]}
            folders={NO_FOLDERS}
            referencedLabels={[]}
            projectKey="BRD"
            viewer={VIEWER}
            savedFilters={false}
          />
        </>,
      ),
    );
    // A Visitor has no [Saved] trigger.
    expect(screen.queryByRole('button', { name: /saved/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    const reset = screen.getByTestId('board-filter-reset-link');
    expect(reset.textContent).toContain(H.reset);
    fireEvent.click(reset);
    expect(push).toHaveBeenCalledWith('/boards?board=brd_1');
  });

  it('Clear all on a board with a stored filter leads to the Cleared state (boardFilter=off)', () => {
    renderWithIntl(
      wrap(
        <>
          <Publish
            value={{
              requestedBoardId: null,
              boardId: 'brd_1',
              boardType: 'kanban',
              storedFilter: stored(KIND_BUG),
            }}
          />
          <BoardFilterControls
            filter={EMPTY_FILTER}
            ast={null}
            statuses={[]}
            members={[]}
            sprints={[]}
            customFields={[]}
            components={[]}
            folders={NO_FOLDERS}
            referencedLabels={[]}
            projectKey="BRD"
            viewer={VIEWER}
          />
        </>,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    fireEvent.click(screen.getByRole('button', { name: enMessages.issueViews.advancedClearAll }));
    expect(push).toHaveBeenCalledWith('/boards?boardFilter=off');
  });

  it('the quick Filter header shows the short Reset, named in full', () => {
    renderWithIntl(
      wrap(
        <>
          <Publish
            value={{
              requestedBoardId: null,
              boardId: 'brd_1',
              boardType: 'kanban',
              storedFilter: stored(KIND_BUG),
            }}
          />
          <BoardFilterControls
            filter={{ ...EMPTY_FILTER, kinds: ['story'] }}
            ast={null}
            statuses={[]}
            members={[]}
            sprints={[]}
            customFields={[]}
            components={[]}
            folders={NO_FOLDERS}
            referencedLabels={[]}
            projectKey="BRD"
            viewer={VIEWER}
          />
        </>,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /^filter/i }));
    const reset = screen.getByTestId('board-filter-reset-link');
    expect(reset.textContent).toContain(H.resetShort);
    expect(reset.getAttribute('aria-label')).toBe(H.reset);
  });
});

// Every applied summary on the Board names a folder by its PATH (MOTIR-11667):
// the page threads the project's folders into the bar's one lookups object,
// which feeds the stored-filter indicator, the condition chips, the Reset
// tooltip's sentence and the save confirmation alike.
describe('Folder conditions are named by path (MOTIR-11667)', () => {
  it('the stored-filter indicator names a stored Folder condition by its path, never its id', () => {
    renderBar({ storedFilter: stored(NOT_DONE), folders: FOLDERS });
    const row = screen.getByTestId('board-header-filter');
    expect(row.textContent).toContain('Folder');
    expect(row.textContent).toContain('is none of Done');
    expect(row.textContent).not.toContain('f-done');
  });

  it('the applied chips of an edited header name each folder by its full path', () => {
    renderBar({ storedFilter: stored(NOT_DONE), ast: IN_DONE_OCT, folders: FOLDERS });
    const row = screen.getByTestId('board-header-filter');
    expect(row.getAttribute('data-mode')).toBe('edited');
    expect(row.textContent).toContain('is any of Done ▸ Oct 2026');
    expect(row.textContent).not.toContain('f-done-oct');
  });

  it('the Reset to board filter tooltip names the stored folder by path', async () => {
    renderBar({ storedFilter: stored(NOT_DONE), ast: IN_DONE_OCT, folders: FOLDERS });
    act(() => {
      fireEvent.focus(screen.getByTestId('board-filter-reset'));
    });
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Board filter: Folder is none of Done');
    expect(tip.textContent).not.toContain('f-done');
  });

  it('the Save to board filter confirmation names the folders by path', async () => {
    renderBar({ storedFilter: stored(NOT_DONE), ast: IN_DONE_OCT, folders: FOLDERS });
    fireEvent.click(screen.getByRole('button', { name: H.saveToBoard }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('is any of Done ▸ Oct 2026');
    expect(dialog.textContent).not.toContain('f-done-oct');
  });

  it('a saved filter carrying a Folder condition shows its path in the applied bar and in Set as board filter', async () => {
    const applied: AppliedSavedFilter = {
      id: 'sf_folder',
      name: 'Parked work',
      ownerName: 'Alice Chen',
      visibility: 'project',
      canOverwrite: true,
      builtin: false,
      envelopeParam: encodeFilterParam(IN_DONE_OCT),
    };
    renderBar({ ast: IN_DONE_OCT, applied, folders: FOLDERS });
    await screen.findByRole('button', { name: /Parked work/ });
    expect(screen.getByText('is any of Done ▸ Oct 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: H.setAsBoard }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('is none of Done');
    expect(dialog.textContent).not.toContain('f-done');
  });

  it('a stored folder that no longer exists reads Unknown value, and raises no error', () => {
    renderBar({
      storedFilter: stored(
        {
          combinator: 'and',
          conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-gone'] }],
        },
        { staleConditions: [{ index: 0, field: 'folder', reason: 'unknown-value' }] },
      ),
      folders: FOLDERS,
    });
    const row = screen.getByTestId('board-header-filter');
    expect(row.textContent).toContain('is any of Unknown value');
    expect(screen.getByTestId('board-filter-chip-stale')).toBeTruthy();
  });

  it('a truncated folder list names a folder past the window by its id, never as unknown', () => {
    renderBar({
      storedFilter: stored({
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-past-the-cap'] }],
      }),
      folders: { ...FOLDERS, truncated: true },
    });
    const row = screen.getByTestId('board-header-filter');
    expect(row.textContent).toContain('is any of f-past-the-cap');
    expect(row.textContent).not.toContain('Unknown value');
  });
});

describe('useBoardStoredFilter outside a provider', () => {
  function Probe() {
    const read = useBoardStoredFilter();
    read.reloadBoard();
    return <span data-testid="probe">{read.storedFilter === undefined ? 'unknown' : 'known'}</span>;
  }
  it('answers not-yet-known and a no-op reload', () => {
    renderWithIntl(<Probe />);
    expect(screen.getByTestId('probe').textContent).toContain('unknown');
  });
});

describe('BoardFilteredEmptyState variants', () => {
  it('the board filter leaves nothing: its own copy, no action', () => {
    renderWithIntl(wrap(<BoardFilteredEmptyState variant="board" />));
    expect(screen.getByText(B.boardFilterEmptyTitle)).toBeTruthy();
    expect(screen.getByText(B.boardFilterEmptyDescription)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a different header filter leaves nothing: Reset to board filter', () => {
    renderWithIntl(wrap(<BoardFilteredEmptyState selectedBoardId="brd_1" variant="reset" />));
    expect(screen.getByText(B.filteredEmptyDescriptionBoard)).toBeTruthy();
    const link = screen.getByRole('link', { name: B.filteredEmptyReset });
    expect(link.getAttribute('href')).toBe('/boards?board=brd_1');
    fireEvent.click(link);
  });
});
