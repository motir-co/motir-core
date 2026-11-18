// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import { decodeFilterParam, encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';
import type { Viewer } from '@/app/(authed)/filters/_components/savedFiltersClient';
import { ToastProvider } from '@/components/ui/Toast';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The board filter UI (Story 6.15 · Subtask 6.15.3) under happy-dom. It REUSES
// the /items filter components verbatim — the value this suite adds over
// issue-filter-bar.test.tsx is the BOARD wiring: the injected board-scoped
// buildHref (every facet toggle preserves `?board=`, never drops it) and the
// filtered-empty CTA state. We stub next/navigation and assert URLs
// + behaviour, the same shape the issue-filter-bar suite uses.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/boards',
}));

import { BoardFilterControls } from '@/app/(authed)/boards/_components/BoardFilterControls';
import { BoardFilteredEmptyState } from '@/app/(authed)/boards/_components/BoardFilteredEmptyState';

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
  cleanup();
});

const STATUSES: WorkflowStatusDto[] = [
  {
    id: 's1',
    projectId: 'p',
    key: 'todo',
    label: 'To Do',
    category: 'todo',
    color: null,
    position: 'a',
    isInitial: true,
  },
  {
    id: 's2',
    projectId: 'p',
    key: 'in_progress',
    label: 'In Progress',
    category: 'in_progress',
    color: null,
    position: 'b',
    isInitial: false,
  },
];

const MEMBERS: WorkspaceMemberDTO[] = [
  {
    userId: 'u-alice',
    name: 'Alice Chen',
    email: 'alice@acme.test',
    workspaceRole: 'manager',
    customRole: null,
  },
];

const VIEWER: Viewer = { userId: 'u-alice', canBrowse: true, canShare: true, canManageAny: false };

// The project's folders (MOTIR-11667): two roots, each with a folder inside, so
// options and chips are told apart by PATH.
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
    { id: 'f-todo', parentFolderId: null, name: 'To do', position: 'a1', path: ['To do'] },
    {
      id: 'f-todo-oct',
      parentFolderId: 'f-todo',
      name: 'Oct 2026',
      position: 'a0',
      path: ['To do', 'Oct 2026'],
    },
  ],
};

function renderControls(
  opts: {
    boardId?: string;
    filter?: IssueFilter;
    ast?: FilterAst;
    folders?: ProjectFoldersDto;
  } = {},
) {
  const ast = opts.ast ?? null;
  const filter =
    opts.filter ?? (ast ? { ...EMPTY_FILTER, advanced: encodeFilterParam(ast) } : EMPTY_FILTER);
  const controls = (
    <BoardFilterControls
      selectedBoardId={opts.boardId}
      filter={filter}
      ast={ast}
      statuses={STATUSES}
      members={MEMBERS}
      sprints={[]}
      customFields={[]}
      components={[]}
      folders={opts.folders ?? FOLDERS}
      referencedLabels={[]}
      projectKey="BRD"
      viewer={VIEWER}
    />
  );
  return renderWithIntl(<ToastProvider>{controls}</ToastProvider>);
}

describe('BoardFilterControls — reuses the /items primitives on the board toolbar', () => {
  it('renders the Filter, Advanced and Saved triggers (the builder + saved picker)', () => {
    renderControls();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Advanced' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Saved filters/i })).toBeTruthy();
  });

  it('toggling a kind facet pushes a board-scoped href, PRESERVING ?board=', () => {
    renderControls({ boardId: 'brd_1' });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const kindList = screen.getByRole('listbox', { name: 'Kind' });
    fireEvent.click(within(kindList).getByRole('option', { name: 'Bug' }));
    // The board-scoped buildHref kept the selection (a plain buildIssueListHref
    // would have dropped it and emitted just `?kind=bug`).
    expect(push).toHaveBeenCalledWith('/boards?board=brd_1&kind=bug');
  });

  it('toggling a status facet with NO board selected still composes /boards?status=', () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const statusList = screen.getByRole('listbox', { name: 'Status' });
    fireEvent.click(within(statusList).getByRole('option', { name: 'In Progress' }));
    expect(push).toHaveBeenCalledWith('/boards?status=in_progress');
  });
});

// The Folder condition on the board toolbar (Story MOTIR-11666 · MOTIR-11667):
// the page passes the project's folders, so the shared builder offers Folder
// with its path-labelled picker and every non-happy state it ships with.
describe('BoardFilterControls — the Folder condition (MOTIR-11667)', () => {
  function openAdvanced() {
    fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));
  }

  function addFolderRow(): HTMLElement {
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('option', { name: 'Folder' }));
    return row;
  }

  function openValues(row: HTMLElement) {
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Folder values' }));
  }

  /** The AST the last board navigation carried in its `?filter=`. */
  function lastPushedAst(): FilterAst | null {
    const href = push.mock.calls.at(-1)?.[0] as string | undefined;
    const param = href ? new URL(`http://x${href}`).searchParams.get('filter') : null;
    if (!param) return null;
    const decoded = decodeFilterParam(param);
    return decoded.ok ? decoded.ast : null;
  }

  it('offers Folder with is any of, is none of, is empty and is not empty', () => {
    renderControls({ boardId: 'brd_1' });
    openAdvanced();
    const row = addFolderRow();
    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    expect(screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim())).toEqual([
      'is any of',
      'is none of',
      'is empty',
      'is not empty',
    ]);
  });

  it('lists the folders by path with the folders-inside note, and a pick narrows the board', () => {
    renderControls({ boardId: 'brd_1' });
    openAdvanced();
    const row = addFolderRow();
    expect(within(row).getByText('Folders inside a chosen folder are included.')).toBeTruthy();
    openValues(row);
    expect(screen.getByRole('option', { name: 'Done ▸ Oct 2026' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'To do ▸ Oct 2026' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'To do' }));
    // The board-scoped navigation keeps ?board= and carries the Folder condition.
    const href = push.mock.calls.at(-1)?.[0] as string;
    expect(href.startsWith('/boards?board=brd_1&')).toBe(true);
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-todo'] }],
    });
  });

  it('reopens a Folder filter from the URL (a reload, or a saved filter) with its row filled in by path', () => {
    renderControls({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_none_of', value: ['f-done-oct'] }],
      },
    });
    openAdvanced();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('Done ▸ Oct 2026')).toBeTruthy();
    expect(within(row).queryByText('f-done-oct')).toBeNull();
  });

  it('a project with no folders shows the same empty message as /items', () => {
    renderControls({ folders: { folders: [], truncated: false } });
    openAdvanced();
    const row = addFolderRow();
    openValues(row);
    expect(screen.getByText('This project has no folders yet.')).toBeTruthy();
  });

  it('a deleted or other project’s folder shows the Unknown value chip and raises no error', () => {
    renderControls({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-done', 'f-elsewhere'] }],
      },
    });
    openAdvanced();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('Done')).toBeTruthy();
    expect(within(row).getByText('Unknown value')).toBeTruthy();
  });

  it('a truncated folder list still lets a person pick, and marks no folder past it unknown', () => {
    renderControls({
      folders: { ...FOLDERS, truncated: true },
      ast: {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-past-the-cap'] }],
      },
    });
    openAdvanced();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).queryByText('Unknown value')).toBeNull();
    openValues(row);
    expect(screen.getByText('Showing the first 4 folders.')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Done' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-past-the-cap', 'f-done'] }],
    });
  });
});

describe('BoardFilteredEmptyState — distinct "no match" state with a Clear CTA', () => {
  it('renders the filtered-empty copy + a board-scoped Clear link', () => {
    renderWithIntl(<BoardFilteredEmptyState selectedBoardId="brd_1" />);
    expect(screen.getByText('No work items match this filter')).toBeTruthy();
    const clear = screen.getByRole('link', { name: 'Clear filter' }) as HTMLAnchorElement;
    // Clears to the board with no filter, preserving the selection.
    expect(clear.getAttribute('href')).toBe('/boards?board=brd_1');
  });

  it('clears to the bare /boards when no board is selected', () => {
    renderWithIntl(<BoardFilteredEmptyState />);
    const clear = screen.getByRole('link', { name: 'Clear filter' }) as HTMLAnchorElement;
    expect(clear.getAttribute('href')).toBe('/boards');
  });
});
