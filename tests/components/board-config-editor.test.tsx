// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// BoardConfigEditor (Subtask 3.6.3) — the board-administration UI. Driven under
// happy-dom (DB-free): the editor is a pure client consumer of the 3.6.2 REST
// endpoints, so we stub global fetch and assert (a) the column manager + status
// mapping render, (b) the NON-DRAG keyboard path — the per-column "Add status"
// picker menu maps a status (and the × unmaps it), each firing the right 3.6.2
// write with an optimistic move, and (c) the read-only (non-admin) treatment.
// dnd is the pointer ENHANCEMENT over these accessible controls; the drag path
// itself (jsdom can't synthesise it) is covered by the 3.6.4 Playwright E2E.

import {
  BoardConfigEditor,
  computeColumnReorder,
  mapStatusOptimistic,
  unmapStatusOptimistic,
  type BoardConfigModel,
} from '@/app/(authed)/settings/project/board/_components/BoardConfigEditor';

function model(over: Partial<BoardConfigModel> = {}): BoardConfigModel {
  return {
    boardId: 'b1',
    boardName: 'motir board',
    columns: [
      {
        id: 'c1',
        name: 'To Do',
        position: 'a0',
        cardCount: 0,
        statuses: [{ id: 's-todo', label: 'To Do' }],
      },
      {
        id: 'c2',
        name: 'In Progress',
        position: 'a1',
        cardCount: 0,
        statuses: [{ id: 's-prog', label: 'In Progress' }],
      },
    ],
    unmapped: [{ id: 's-triage', label: 'Needs Triage' }],
    ...over,
  };
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

let fetchMock: ReturnType<typeof vi.fn>;
function stubFetchOk() {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      id: 'real-col',
      name: 'New column',
      position: 'a9',
      wipLimit: null,
      boardId: 'b1',
      columnId: 'c1',
      statusId: 's-triage',
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  stubFetchOk();
});

describe('BoardConfigEditor (3.6.3) — render', () => {
  it('renders the column manager: columns, mapped status chips, and the unmapped rail', () => {
    render(<BoardConfigEditor model={model()} isAdmin />);
    expect(screen.getByTestId('board-config-column-c1')).toBeTruthy();
    expect(screen.getByTestId('board-config-column-c2')).toBeTruthy();
    // mapped chip + rail chip
    expect(screen.getByTestId('board-config-chip-s-todo')).toBeTruthy();
    expect(screen.getByTestId('board-config-rail-chip-s-triage')).toBeTruthy();
    // the add-column ghost + per-column add-status affordance (admin)
    expect(screen.getByTestId('board-config-add-column')).toBeTruthy();
    expect(screen.getByTestId('board-config-add-status-c1')).toBeTruthy();
  });
});

describe('BoardConfigEditor (3.6.3) — status mapping (keyboard / non-drag path, #35)', () => {
  it('maps an unmapped status into a column via the per-column "Add status" picker', async () => {
    render(<BoardConfigEditor model={model()} isAdmin />);

    // Open the picker on column c1, then choose the unmapped status.
    fireEvent.click(screen.getByTestId('board-config-add-status-c1'));
    const pick = await screen.findByTestId('board-config-pick-s-triage');
    fireEvent.click(pick);

    // Optimistic move: the chip now lives in c1, and the rail is empty.
    await waitFor(() => expect(screen.getByTestId('board-config-chip-s-triage')).toBeTruthy());
    expect(screen.queryByTestId('board-config-rail-chip-s-triage')).toBeNull();

    // The 3.6.2 map write fired (PUT …/columns/c1/statuses {boardId, statusId}).
    const put = fetchMock.mock.calls.find(
      ([url, opts]) => String(url) === '/api/board/columns/c1/statuses' && opts?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    expect(JSON.parse(put![1].body)).toMatchObject({ boardId: 'b1', statusId: 's-triage' });
  });

  it('unmaps a status via the chip × — it returns to the rail and DELETE fires', async () => {
    render(<BoardConfigEditor model={model()} isAdmin />);

    fireEvent.click(screen.getByTestId('board-config-unmap-s-todo'));

    await waitFor(() => expect(screen.getByTestId('board-config-rail-chip-s-todo')).toBeTruthy());
    expect(screen.queryByTestId('board-config-chip-s-todo')).toBeNull();

    const del = fetchMock.mock.calls.find(
      ([url, opts]) =>
        String(url).startsWith('/api/board/columns/c1/statuses/s-todo') &&
        opts?.method === 'DELETE',
    );
    expect(del).toBeTruthy();
    expect(String(del![0])).toContain('boardId=b1');
  });
});

describe('BoardConfigEditor (3.6.3) — board rename', () => {
  it('auto-saves the board name on Enter (PATCH /api/board) and shows Saved', async () => {
    render(<BoardConfigEditor model={model()} isAdmin />);
    const input = screen.getByDisplayValue('motir board') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Roadmap' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByTestId('board-name-saved')).toBeTruthy());
    const patch = fetchMock.mock.calls.find(
      ([url, opts]) => String(url) === '/api/board' && opts?.method === 'PATCH',
    );
    expect(patch).toBeTruthy();
    expect(JSON.parse(patch![1].body)).toMatchObject({ boardId: 'b1', name: 'Roadmap' });
  });
});

describe('BoardConfigEditor (3.6.3) — column delete confirm + guard', () => {
  it('shows the normal delete confirm for an empty column and fires DELETE', async () => {
    render(<BoardConfigEditor model={model()} isAdmin />);
    fireEvent.click(screen.getByTestId('board-config-delete-c1'));
    const confirm = await screen.findByTestId('board-config-delete-confirm');
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.find(
          ([url, opts]) => String(url) === '/api/board/columns/c1' && opts?.method === 'DELETE',
        ),
      ).toBeTruthy(),
    );
  });

  it('a refused delete restores the column under a failed-CHANGE toast, not a failed load (MOTIR-11550)', async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'COLUMN_NOT_EMPTY' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<BoardConfigEditor model={model()} isAdmin />);
    fireEvent.click(screen.getByTestId('board-config-delete-c1'));
    fireEvent.click(await screen.findByTestId('board-config-delete-confirm'));

    expect(await screen.findByText('Couldn’t save the change')).toBeTruthy();
    expect(
      screen.getByText('“To Do” still holds work items — remap its statuses first.'),
    ).toBeTruthy();
    expect(screen.queryByText('Couldn’t load board settings')).toBeNull();
    // The column is back.
    expect(screen.getByTestId('board-config-delete-c1')).toBeTruthy();
  });

  it('shows the guard (no delete) when a mapped status still holds work items', async () => {
    const m = model({
      columns: [
        {
          id: 'c1',
          name: 'In Progress',
          position: 'a0',
          cardCount: 12,
          statuses: [{ id: 's-prog', label: 'In Progress' }],
        },
        { id: 'c2', name: 'Done', position: 'a1', cardCount: 0, statuses: [] },
      ],
    });
    render(<BoardConfigEditor model={m} isAdmin />);
    fireEvent.click(screen.getByTestId('board-config-delete-c1'));
    // The guard variant renders an acknowledge button, NOT the destructive confirm.
    await waitFor(() => expect(screen.getByText(/Can’t delete/)).toBeTruthy());
    expect(screen.queryByTestId('board-config-delete-confirm')).toBeNull();
    expect(screen.getByText(/12 work items/)).toBeTruthy();
  });
});

describe('BoardConfigEditor (3.6.3) — read-only (non-admin)', () => {
  it('shows the read-only banner and hides every write affordance', () => {
    render(<BoardConfigEditor model={model()} isAdmin={false} />);
    expect(screen.getByText(/read-only access to board settings/)).toBeTruthy();
    // columns still render (read-only), but no edit affordances
    expect(screen.getByTestId('board-config-column-c1')).toBeTruthy();
    expect(screen.queryByTestId('board-config-add-column')).toBeNull();
    expect(screen.queryByTestId('board-config-add-status-c1')).toBeNull();
    expect(screen.queryByTestId('board-config-delete-c1')).toBeNull();
    expect(screen.queryByTestId('board-config-unmap-s-todo')).toBeNull();
  });
});

describe('BoardConfigEditor (3.6.3) — optimistic-state helpers', () => {
  it('mapStatusOptimistic MOVES a status (never duplicates) — the @@unique invariant', () => {
    const cols = [
      { id: 'c1', name: 'A', position: 'a0', cardCount: 0, statuses: [{ id: 's1', label: 'S1' }] },
      { id: 'c2', name: 'B', position: 'a1', cardCount: 0, statuses: [] },
    ];
    const next = mapStatusOptimistic(cols, [], 's1', 'c2');
    const all = next.columns.flatMap((c) => c.statuses.map((s) => `${c.id}:${s.id}`));
    expect(all).toEqual(['c2:s1']); // exactly one column holds it
  });

  it('unmapStatusOptimistic returns the status to the rail', () => {
    const cols = [
      { id: 'c1', name: 'A', position: 'a0', cardCount: 0, statuses: [{ id: 's1', label: 'S1' }] },
    ];
    const next = unmapStatusOptimistic(cols, [], 's1');
    expect(next.columns[0]!.statuses).toEqual([]);
    expect(next.unmapped.map((s) => s.id)).toEqual(['s1']);
  });

  it('computeColumnReorder yields a sort key strictly between the new neighbours', () => {
    const cols = [
      { id: 'c1', name: 'A', position: 'a0', cardCount: 0, statuses: [] },
      { id: 'c2', name: 'B', position: 'a1', cardCount: 0, statuses: [] },
      { id: 'c3', name: 'C', position: 'a2', cardCount: 0, statuses: [] },
    ];
    // Move c1 to where c3 is (drop onto c3).
    const result = computeColumnReorder(cols, 'c1', 'c3');
    expect(result).not.toBeNull();
    expect(result!.columns.map((c) => c.id)).toEqual(['c2', 'c3', 'c1']);
    expect(result!.position > 'a2').toBe(true);
  });
});
