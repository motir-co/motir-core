// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import enMessages from '@/messages/en.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  BoardStoredFilterEditor,
  type BoardStoredFilterEditorProps,
  type BoardStoredFilterLookups,
} from '@/app/(authed)/settings/project/board/_components/BoardStoredFilterEditor';
import { encodeFilterEnvelope, type FilterAst } from '@/lib/filters/ast';
import type { StoredBoardFilterDto } from '@/lib/dto/boards';

// The board settings page's STORED FILTER editor (Story MOTIR-10560 · Subtask
// MOTIR-11334). DB-free under happy-dom: the editor is a client of
// `PATCH /api/boards/:id { filter }`, so fetch is stubbed. Pinned: the none
// state (kanban and scrum copy), seeding from the read's envelope, Unsaved
// changes / Discard / Save, "Show everything" saving `null` in ONE Save, every
// refusal keeping the working copy and the saved filter, the stale and the
// unreadable callouts, and the sequence guard on an overtaken save.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const ts = enMessages.settings.board.storedFilter;

const LOOKUPS: BoardStoredFilterLookups = {
  statuses: [],
  members: [],
  sprints: [],
  customFields: [
    {
      id: 'f-size',
      key: 'size',
      label: 'Size',
      fieldType: 'select',
      description: null,
      position: 'a0',
      options: [{ id: 'o-s', label: 'S', position: 'a0' } as never],
      valueCount: 0,
    },
  ],
  components: [],
  // The project's folders (MOTIR-11669): "Done" and a folder inside it.
  folders: {
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
  },
  referencedLabels: [{ id: 'lab-mobile', name: 'mobile' } as never],
  projectKey: 'ACME',
};

const BUG_AND_MOBILE: FilterAst = {
  combinator: 'and',
  conditions: [
    { field: 'kind', operator: 'is_any_of', value: ['bug'] },
    { field: 'lbl', operator: 'is_any_of', value: ['lab-mobile'] },
  ],
};

function stored(
  ast: FilterAst | null,
  staleConditions: StoredBoardFilterDto['staleConditions'] = [],
): StoredBoardFilterDto {
  return { envelope: ast ? encodeFilterEnvelope(ast) : null, staleConditions, labels: [] };
}

function render(over: Partial<BoardStoredFilterEditorProps> = {}) {
  return renderWithIntl(
    <BoardStoredFilterEditor
      boardId="b1"
      boardType="kanban"
      storedFilter={null}
      lookups={LOOKUPS}
      {...over}
    />,
  );
}

type Reply = { status: number; body?: unknown } | 'throw';
let fetchMock: ReturnType<typeof vi.fn>;
const patches: unknown[] = [];

function reply(r: Reply) {
  if (r === 'throw') return Promise.reject(new Error('offline'));
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.body,
  });
}

function stubPatch(...replies: Reply[]) {
  const queue = [...replies];
  fetchMock = vi.fn((url: string, opts?: { method?: string; body?: string }) => {
    expect(url).toBe('/api/boards/b1');
    expect(opts?.method).toBe('PATCH');
    const body = JSON.parse(opts!.body!) as { filter: unknown };
    patches.push(body);
    const next = queue.shift() ?? {
      status: 200,
      body: {
        id: 'b1',
        name: 'Bugs',
        type: 'kanban',
        swimlaneGroupBy: 'none',
        filter: body.filter,
      },
    };
    return reply(next);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  patches.length = 0;
  refresh.mockReset();
  stubPatch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const editor = () => screen.getByTestId('board-stored-filter-editor');
const saveButton = () => screen.getByTestId('board-stored-filter-save') as HTMLButtonElement;
const conditionRows = () => screen.queryAllByRole('group', { name: /Condition \d/ });

describe('BoardStoredFilterEditor — no stored filter', () => {
  it('says what a kanban board shows and offers Add, with no footer', () => {
    render();
    expect(editor().getAttribute('aria-label')).toBe(ts.title);
    expect(editor().textContent).toContain(ts.subtitle);
    expect(editor().textContent).toContain(ts.none);
    expect(screen.queryByTestId('board-stored-filter-save')).toBeNull();
    expect(screen.queryByTestId('board-stored-filter-unsaved')).toBeNull();
  });

  it('uses the active-sprint sentence on a scrum board', () => {
    render({ boardType: 'scrum' });
    expect(editor().textContent).toContain(ts.noneScrum);
  });

  it('opens an empty builder on Add; a pending row is not a change', () => {
    render();
    fireEvent.click(screen.getByTestId('board-stored-filter-add'));
    expect(screen.queryByText(ts.none)).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect((screen.getByTestId('board-stored-filter-discard') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('BoardStoredFilterEditor — editing and saving', () => {
  it('seeds the builder from the stored envelope, unchanged until edited', () => {
    render({ storedFilter: stored(BUG_AND_MOBILE) });
    expect(conditionRows()).toHaveLength(2);
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByTestId('board-stored-filter-unsaved')).toBeNull();
  });

  it('marks an edit unsaved, saves the committed envelope, adopts the reply and refreshes', async () => {
    render({ storedFilter: stored(BUG_AND_MOBILE) });
    fireEvent.click(screen.getAllByRole('button', { name: /Remove condition/ })[1]!);
    expect(screen.getByTestId('board-stored-filter-unsaved').textContent).toContain(ts.unsaved);
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(patches).toEqual([
      {
        filter: encodeFilterEnvelope({
          combinator: 'and',
          conditions: [BUG_AND_MOBILE.conditions[0]!],
        }),
      },
    ]);
    expect(screen.getByTestId('board-stored-filter-announce').textContent).toBe(ts.savedAnnounce);
    expect(screen.queryByTestId('board-stored-filter-unsaved')).toBeNull();
    expect(conditionRows()).toHaveLength(1);
    expect(saveButton().disabled).toBe(true);
  });

  it('Discard puts the saved filter back', () => {
    render({ storedFilter: stored(BUG_AND_MOBILE) });
    fireEvent.click(screen.getAllByRole('button', { name: /Remove condition/ })[0]!);
    expect(conditionRows()).toHaveLength(1);
    fireEvent.click(screen.getByTestId('board-stored-filter-discard'));
    expect(conditionRows()).toHaveLength(2);
    expect(screen.queryByTestId('board-stored-filter-unsaved')).toBeNull();
  });

  it('Show everything saves nothing by itself, then clears with ONE Save of null', async () => {
    render({ storedFilter: stored(BUG_AND_MOBILE) });
    fireEvent.click(screen.getByTestId('board-stored-filter-clear'));
    expect(patches).toHaveLength(0);
    expect(conditionRows()).toHaveLength(0);
    expect(screen.getByTestId('board-stored-filter-cleared').textContent).toContain(ts.clearedNote);
    expect(screen.queryByTestId('board-stored-filter-add')).toBeNull();

    fireEvent.click(saveButton());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(patches).toEqual([{ filter: null }]);
    // Saved: back to the none state.
    expect(editor().textContent).toContain(ts.none);
    expect(screen.queryByTestId('board-stored-filter-cleared')).toBeNull();
    expect(screen.queryByTestId('board-stored-filter-save')).toBeNull();
  });

  it('Discard after Show everything restores the conditions', () => {
    render({ storedFilter: stored(BUG_AND_MOBILE) });
    fireEvent.click(screen.getByTestId('board-stored-filter-clear'));
    fireEvent.click(screen.getByTestId('board-stored-filter-discard'));
    expect(conditionRows()).toHaveLength(2);
    expect(screen.queryByTestId('board-stored-filter-cleared')).toBeNull();
  });

  it('Add after Show everything reopens an empty builder', () => {
    render();
    fireEvent.click(screen.getByTestId('board-stored-filter-add'));
    fireEvent.click(screen.getByTestId('board-stored-filter-clear'));
    // Nothing was saved, so clearing is no change: the none state returns.
    expect(editor().textContent).toContain(ts.none);
    fireEvent.click(screen.getByTestId('board-stored-filter-add'));
    expect(screen.queryByText(ts.none)).toBeNull();
  });
});

describe('BoardStoredFilterEditor — refusals keep the working copy', () => {
  async function editAndSave() {
    render({ storedFilter: stored(BUG_AND_MOBILE) });
    fireEvent.click(screen.getAllByRole('button', { name: /Remove condition/ })[1]!);
    fireEvent.click(saveButton());
    return screen.findByTestId('board-filter-refusal');
  }

  it('names the refused condition by number, keeps the edit, and an edit clears it', async () => {
    stubPatch({
      status: 422,
      body: { code: 'INVALID_FILTER_VALUE', error: 'a kind it does not know', conditionIndex: 0 },
    });
    const refusal = await editAndSave();
    expect(within(refusal).getByText(ts.refusedTitle)).toBeTruthy();
    expect(refusal.textContent).toContain(
      'Condition 1 can’t be used: a kind it does not know. The board keeps its current filter until you fix or remove it.',
    );
    expect(conditionRows()).toHaveLength(1);
    expect(screen.getByTestId('board-stored-filter-unsaved')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('board-stored-filter-discard'));
    expect(screen.queryByTestId('board-filter-refusal')).toBeNull();
  });

  it('renders the over-cap refusal from the sent condition count', async () => {
    stubPatch({ status: 422, body: { code: 'FILTER_TOO_LARGE', error: 'too many' } });
    const refusal = await editAndSave();
    expect(refusal.textContent).toContain(
      'A board filter holds at most 20 conditions, and this one has 1. The board keeps its current filter until you remove 1 condition.',
    );
  });

  it('renders a whole-filter refusal', async () => {
    stubPatch({ status: 422, body: { code: 'MALFORMED_FILTER', error: 'unreadable' } });
    const refusal = await editAndSave();
    expect(refusal.textContent).toContain('This filter can’t be used: unreadable.');
  });

  it('says a 403 is a permission refusal', async () => {
    stubPatch({ status: 403, body: { code: 'FORBIDDEN', error: 'no' } });
    expect((await editAndSave()).textContent).toContain(ts.refusedForbidden);
  });

  it('says a server error or a lost connection failed', async () => {
    stubPatch({ status: 500, body: {} });
    expect((await editAndSave()).textContent).toContain(ts.refusedFailed);
    cleanup();
    stubPatch('throw');
    expect((await editAndSave()).textContent).toContain(ts.refusedFailed);
  });

  it('clears a refusal when the builder is edited', async () => {
    stubPatch({ status: 403, body: {} });
    await editAndSave();
    fireEvent.click(screen.getAllByRole('button', { name: /Remove condition/ })[0]!);
    expect(screen.queryByTestId('board-filter-refusal')).toBeNull();
  });
});

describe('BoardStoredFilterEditor — the sequence guard', () => {
  it('ignores a save that a Discard overtook', async () => {
    let resolve!: (v: unknown) => void;
    fetchMock = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render({ storedFilter: stored(BUG_AND_MOBILE) });
    fireEvent.click(screen.getAllByRole('button', { name: /Remove condition/ })[1]!);
    fireEvent.click(saveButton());
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    fireEvent.click(screen.getByTestId('board-stored-filter-discard'));
    await act(async () => {
      resolve({
        ok: true,
        status: 200,
        json: async () => ({ id: 'b1', filter: null }),
      });
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(conditionRows()).toHaveLength(2);
    expect(screen.getByTestId('board-stored-filter-announce').textContent).toBe('');
  });
});

describe('BoardStoredFilterEditor — stale and unreadable stored filters', () => {
  it('lists every stale condition by number, field and kind', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [
        { field: 'kind', operator: 'is_any_of', value: ['bug'] },
        { field: 'lbl', operator: 'is_any_of', value: ['lab-gone'] },
        { field: 'cmp', operator: 'is_any_of', value: ['cmp-gone'] },
        { field: 'folder', operator: 'is_any_of', value: ['fld-gone'] },
        { field: 'cf:f-gone', operator: 'is_any_of', value: ['x'] },
        { field: 'cf:f-size', operator: 'is_any_of', value: ['o-gone'] },
      ],
    };
    render({
      storedFilter: stored(ast, [
        { index: 1, field: 'lbl', reason: 'unknown-value' },
        { index: 2, field: 'cmp', reason: 'unknown-value' },
        { index: 3, field: 'folder', reason: 'unknown-value' },
        { index: 4, field: 'cf:f-gone', reason: 'unknown-field' },
        { index: 5, field: 'cf:f-size', reason: 'unknown-value' },
        { index: 0, field: 'kind', reason: 'invalid' },
      ]),
    });
    const callout = screen.getByTestId('board-stored-filter-stale');
    expect(callout.getAttribute('role')).toBe('status');
    const items = within(callout)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(callout.textContent).toContain('6 conditions refer to something that no longer exists');
    expect(callout.textContent).toContain(ts.staleBody);
    expect(items).toEqual([
      'Condition 2 · Label: a label that was deleted',
      'Condition 3 · Component: a component that was deleted',
      'Condition 4 · Folder: a folder that was deleted',
      'Condition 5: a custom field that was deleted',
      'Condition 6 · Size: an option that was deleted',
      'Condition 1 · Kind: this condition can no longer be used',
    ]);
    // An edit is about a filter the stale list no longer describes.
    fireEvent.click(screen.getAllByRole('button', { name: /Remove condition/ })[0]!);
    expect(screen.queryByTestId('board-stored-filter-stale')).toBeNull();
  });

  it('uses the singular title for one stale condition', () => {
    render({
      storedFilter: stored(BUG_AND_MOBILE, [{ index: 1, field: 'lbl', reason: 'unknown-value' }]),
    });
    expect(screen.getByTestId('board-stored-filter-stale').textContent).toContain(
      '1 condition refers to something that no longer exists',
    );
  });

  it('explains an unreadable filter and clears it with Show everything and Save', async () => {
    render({
      storedFilter: {
        envelope: null,
        staleConditions: [{ index: null, field: null, reason: 'invalid' }],
        labels: [],
      },
    });
    const callout = screen.getByTestId('board-stored-filter-stale');
    expect(callout.textContent).toContain(ts.unreadableTitle);
    expect(callout.textContent).toContain(ts.unreadableBody);
    expect(editor().textContent).not.toContain(ts.none);
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(screen.getByTestId('board-stored-filter-clear'));
    expect(screen.queryByTestId('board-stored-filter-stale')).toBeNull();
    expect(screen.getByTestId('board-stored-filter-cleared')).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(patches).toEqual([{ filter: null }]);
    expect(editor().textContent).toContain(ts.none);
  });
});

// The editor's Folder row (Story MOTIR-11666 · MOTIR-11669): the settings page
// passes the project's folders, so a board admin can keep a Folder condition
// as the board's own filter, with the shared row's path picker and every
// non-happy state it ships with.
describe('BoardStoredFilterEditor — the Folder condition (MOTIR-11669)', () => {
  const NOT_DONE: FilterAst = {
    combinator: 'and',
    conditions: [{ field: 'folder', operator: 'is_none_of', value: ['f-done'] }],
  };

  function addFolderRow(): HTMLElement {
    fireEvent.click(screen.getByTestId('board-stored-filter-add'));
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('option', { name: 'Folder' }));
    return row;
  }

  function openValues(row: HTMLElement) {
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Folder values' }));
  }

  it('offers Folder with its four operators and the folders-inside note', () => {
    render();
    const row = addFolderRow();
    expect(within(row).getByText('Folders inside a chosen folder are included.')).toBeTruthy();
    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    expect(screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim())).toEqual([
      'is any of',
      'is none of',
      'is empty',
      'is not empty',
    ]);
  });

  it('saves Folder is none of “Done” through PATCH with Done’s id', async () => {
    render();
    const row = addFolderRow();
    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    fireEvent.click(screen.getByRole('option', { name: 'is none of' }));
    openValues(row);
    expect(screen.getByRole('option', { name: 'Done ▸ Oct 2026' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Done' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(patches).toEqual([{ filter: encodeFilterEnvelope(NOT_DONE) }]);
  });

  it('reopens a stored Folder condition with its row filled in by path', () => {
    render({ storedFilter: stored(NOT_DONE) });
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('Done')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('names a stored sub-folder by its full path, never its id', () => {
    render({
      storedFilter: stored({
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-done-oct'] }],
      }),
    });
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('Done ▸ Oct 2026')).toBeTruthy();
    expect(editor().textContent).not.toContain('f-done-oct');
  });

  it('a project with no folders shows the same empty message as /items', () => {
    render({ lookups: { ...LOOKUPS, folders: { folders: [], truncated: false } } });
    const row = addFolderRow();
    openValues(row);
    expect(screen.getByText('This project has no folders yet.')).toBeTruthy();
  });

  it('a deleted folder shows the Unknown value chip and, read stale, the Folder line in the callout', () => {
    render({
      storedFilter: stored(
        {
          combinator: 'and',
          conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-done', 'f-gone'] }],
        },
        [{ index: 0, field: 'folder', reason: 'unknown-value' }],
      ),
    });
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('Done')).toBeTruthy();
    expect(within(row).getByText('Unknown value')).toBeTruthy();
    expect(screen.getByTestId('board-stored-filter-stale').textContent).toContain(
      'Condition 1 · Folder: a folder that was deleted',
    );
  });

  it('a truncated folder list still lets a person pick, and marks no stored folder past it unknown', async () => {
    render({
      lookups: { ...LOOKUPS, folders: { ...LOOKUPS.folders, truncated: true } },
      storedFilter: stored({
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-past-the-cap'] }],
      }),
    });
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).queryByText('Unknown value')).toBeNull();
    openValues(row);
    expect(screen.getByText('Showing the first 2 folders.')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Done' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(patches).toEqual([
      {
        filter: encodeFilterEnvelope({
          combinator: 'and',
          conditions: [
            { field: 'folder', operator: 'is_any_of', value: ['f-past-the-cap', 'f-done'] },
          ],
        }),
      },
    ]);
  });
});
