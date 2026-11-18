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

// The backlog filter UI (Story 8.8 · Subtask 8.8.18) under happy-dom. It REUSES
// the /items filter components verbatim — exactly as the board did (6.15.3) —
// so the value this suite adds is the BACKLOG wiring: the formerly-disabled
// `[Filter]` seam is now an ENABLED trigger, and the injected backlog-scoped
// buildHref makes every facet toggle navigate to `/backlog?…` (NO `?board=`, no
// view/sort). We stub next/navigation and assert the pushed URLs, the same shape
// the board-filter suite uses.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/backlog',
}));

import { BacklogFilterControls } from '@/app/(authed)/backlog/_components/BacklogFilterControls';
import { BacklogAppliedFilterBar } from '@/app/(authed)/backlog/_components/BacklogAppliedFilterBar';
import { BacklogFilteredEmptyState } from '@/app/(authed)/backlog/_components/BacklogFilteredEmptyState';

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

// The project's folders (MOTIR-11668): two roots, each with a folder inside, so
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

function withAst(ast: FilterAst | undefined): IssueFilter {
  return ast ? { ...EMPTY_FILTER, advanced: encodeFilterParam(ast) } : EMPTY_FILTER;
}

function renderControls(
  opts: { filter?: IssueFilter; ast?: FilterAst; folders?: ProjectFoldersDto } = {},
) {
  return renderWithIntl(
    <ToastProvider>
      <BacklogFilterControls
        filter={opts.filter ?? withAst(opts.ast)}
        ast={opts.ast ?? null}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={[]}
        customFields={[]}
        components={[]}
        folders={opts.folders ?? FOLDERS}
        referencedLabels={[]}
        projectKey="BKL"
        viewer={VIEWER}
      />
    </ToastProvider>,
  );
}

describe('BacklogFilterControls — the wired seam reuses the /items primitives', () => {
  it('renders the ENABLED Filter, Advanced and Saved triggers (the seam is wired)', () => {
    renderControls();
    const filter = screen.getByRole('button', { name: 'Filter' }) as HTMLButtonElement;
    // The formerly-disabled seam is now an enabled trigger (8.8.18).
    expect(filter.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Advanced' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Saved filters/i })).toBeTruthy();
  });

  it('toggling a kind facet pushes a BACKLOG-scoped href (/backlog?kind=bug)', () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const kindList = screen.getByRole('listbox', { name: 'Kind' });
    fireEvent.click(within(kindList).getByRole('option', { name: 'Bug' }));
    // The backlog-scoped buildHref navigates to /backlog (NOT /items, NOT a
    // board href) — there is no view/sort/board companion.
    expect(push).toHaveBeenCalledWith('/backlog?kind=bug');
  });

  it('toggling a status facet composes /backlog?status=', () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const statusList = screen.getByRole('listbox', { name: 'Status' });
    fireEvent.click(within(statusList).getByRole('option', { name: 'In Progress' }));
    expect(push).toHaveBeenCalledWith('/backlog?status=in_progress');
  });
});

// The Folder condition on the backlog (Story MOTIR-11666 · MOTIR-11668): the
// page passes the project's folders to both hosts it mounts, so the shared
// builder offers Folder and the applied bar names each folder by its path.
describe('BacklogFilterControls — the Folder condition (MOTIR-11668)', () => {
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

  /** The AST the last backlog navigation carried in its `?filter=`. */
  function lastPushedAst(): FilterAst | null {
    const href = push.mock.calls.at(-1)?.[0] as string | undefined;
    const param = href ? new URL(`http://x${href}`).searchParams.get('filter') : null;
    if (!param) return null;
    const decoded = decodeFilterParam(param);
    return decoded.ok ? decoded.ast : null;
  }

  it('offers Folder with is any of, is none of, is empty and is not empty', () => {
    renderControls();
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

  it('lists the folders by path with the folders-inside note, and a pick narrows the backlog', () => {
    renderControls();
    openAdvanced();
    const row = addFolderRow();
    expect(within(row).getByText('Folders inside a chosen folder are included.')).toBeTruthy();
    openValues(row);
    expect(screen.getByRole('option', { name: 'Done ▸ Oct 2026' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Done' }));
    const href = push.mock.calls.at(-1)?.[0] as string;
    expect(href.startsWith('/backlog?')).toBe(true);
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-done'] }],
    });
  });

  it('reopens a Folder filter from the URL (a reload, or a saved filter) with its row filled in by path', () => {
    renderControls({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-todo', 'f-todo-oct'] }],
      },
    });
    openAdvanced();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('To do')).toBeTruthy();
    expect(within(row).getByText('To do ▸ Oct 2026')).toBeTruthy();
    expect(within(row).queryByText('f-todo')).toBeNull();
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
        conditions: [{ field: 'folder', operator: 'is_none_of', value: ['f-elsewhere'] }],
      },
    });
    openAdvanced();
    const row = screen.getByRole('group', { name: 'Condition 1' });
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
    fireEvent.click(screen.getByRole('option', { name: 'To do' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-past-the-cap', 'f-todo'] }],
    });
  });
});

describe('BacklogAppliedFilterBar — Folder chips by path (MOTIR-11668)', () => {
  function renderBar(ast: FilterAst, folders: ProjectFoldersDto = FOLDERS) {
    return renderWithIntl(
      <ToastProvider>
        <BacklogAppliedFilterBar
          projectKey="BKL"
          viewer={VIEWER}
          filter={withAst(ast)}
          ast={ast}
          statuses={STATUSES}
          members={MEMBERS}
          sprints={[]}
          customFields={[]}
          components={[]}
          folders={folders}
          referencedLabels={[]}
        />
      </ToastProvider>,
    );
  }

  it('names each chosen folder by its full path, never its id', () => {
    renderBar({
      combinator: 'and',
      conditions: [
        { field: 'folder', operator: 'is_none_of', value: ['f-done'] },
        { field: 'folder', operator: 'is_any_of', value: ['f-todo-oct'] },
      ],
    });
    expect(screen.getByText('is none of Done')).toBeTruthy();
    expect(screen.getByText('is any of To do ▸ Oct 2026')).toBeTruthy();
    expect(document.body.textContent).not.toContain('f-todo-oct');
  });

  it('names a deleted folder Unknown value, and empty / not empty need no folder', () => {
    renderBar({
      combinator: 'and',
      conditions: [
        { field: 'folder', operator: 'is_any_of', value: ['f-gone'] },
        { field: 'folder', operator: 'is_not_empty', value: null },
      ],
    });
    expect(screen.getByText('is any of Unknown value')).toBeTruthy();
    expect(screen.getByText('is not empty')).toBeTruthy();
  });

  it('a truncated list names a folder past the window by its id, never as unknown', () => {
    renderBar(
      {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-past-the-cap'] }],
      },
      { ...FOLDERS, truncated: true },
    );
    expect(screen.getByText('is any of f-past-the-cap')).toBeTruthy();
    expect(screen.queryByText(/Unknown value/)).toBeNull();
  });
});

describe('BacklogFilteredEmptyState — distinct "no match" state with a Clear CTA', () => {
  it('renders the filtered-empty copy + a backlog Clear link', () => {
    renderWithIntl(<BacklogFilteredEmptyState />);
    expect(screen.getByText('No work items match this filter')).toBeTruthy();
    const clear = screen.getByRole('link', { name: 'Clear filter' }) as HTMLAnchorElement;
    // Clears to the bare /backlog (no filter) — the backlog has no selection axis.
    expect(clear.getAttribute('href')).toBe('/backlog');
  });
});
