// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import enMessages from '@/messages/en.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { BoardSummaryDto } from '@/lib/dto/boards';
import {
  applyDefault,
  applyDelete,
  resolveActiveBoardId,
  sortBoards,
  upsertBoard,
} from '@/app/(authed)/boards/_components/multiBoardState';
import { BoardSwitcher } from '@/app/(authed)/boards/_components/BoardSwitcher';
import type { BoardFilterLookups } from '@/app/(authed)/boards/_components/BoardFilterSection';
import { encodeFilterEnvelope, type FilterAst } from '@/lib/filters/ast';

// BoardSwitcher (Subtask 3.7.4) — driven under happy-dom (DB-free): the switcher
// is a pure client consumer of the 3.7.3 board REST endpoints, so we stub global
// fetch + next/navigation and assert (a) the switcher renders + lists boards
// (active checked, default badged), (b) picking a board writes `?board=<id>`,
// (c) the create / rename / set-default flows fire the right 3.7.3 write, and
// (d) the last-board guard disables Delete with the explanation while a normal
// delete shows the confirm. The optimistic-state helpers are unit-tested
// separately. dnd is not involved (the switcher is keyboard/click only).

const push = vi.fn();
let searchParamsValue = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/boards',
  useSearchParams: () => searchParamsValue,
}));

function board(over: Partial<BoardSummaryDto> = {}): BoardSummaryDto {
  return { id: 'b1', name: 'Team board', type: 'kanban', isDefault: true, position: 'a0', ...over };
}

const TWO_BOARDS: BoardSummaryDto[] = [
  board({ id: 'b1', name: 'Team board', isDefault: true, position: 'a0' }),
  board({ id: 'b2', name: 'Triage', isDefault: false, position: 'a1' }),
];

let fetchMock: ReturnType<typeof vi.fn>;
function ok(body: unknown, status = 200) {
  return { ok: true, status, json: async () => body };
}
function stubFetch(boards: BoardSummaryDto[]) {
  const byId = new Map(boards.map((b) => [b.id, b]));
  fetchMock = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = opts?.method ?? 'GET';
    if (u === '/api/boards' && method === 'GET') return ok({ boards });
    if (u === '/api/boards' && method === 'POST') {
      const { name, type } = JSON.parse(opts!.body!);
      return ok({ id: 'b-new', name, type, isDefault: false, position: 'a9' }, 201);
    }
    const m = u.match(/^\/api\/boards\/([^/?]+)$/);
    if (m && method === 'PATCH') {
      const base = byId.get(m[1]!) ?? board({ id: m[1]! });
      const body = JSON.parse(opts!.body!);
      return ok(
        body.isDefault === true ? { ...base, isDefault: true } : { ...base, name: body.name },
      );
    }
    if (m && method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({ code: 'NOT_FOUND' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

beforeEach(() => {
  searchParamsValue = new URLSearchParams();
});
afterEach(() => {
  cleanup();
  push.mockClear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('BoardSwitcher (3.7.4) — render + select', () => {
  it('renders the trigger with the active (default) board + its Default badge', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    const trigger = await screen.findByTestId('board-switcher-trigger');
    expect(trigger.textContent).toContain('Team board');
    expect(screen.getByTestId('board-switcher-active-default').textContent).toContain('Default');
  });

  it('opens the menu listing all boards — active checked, default badged', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));

    const active = await screen.findByTestId('board-switcher-pick-b1');
    expect(active.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('board-switcher-pick-b2').getAttribute('aria-checked')).toBe('false');
    // the default board carries the badge in its row
    expect(screen.getByTestId('board-switcher-default-b1')).toBeTruthy();
    expect(screen.queryByTestId('board-switcher-default-b2')).toBeNull();
  });

  it('the menu content is overflow-visible so the manage flyout is not clipped', async () => {
    // Regression guard: the per-board manage [⋯] menu is absolutely positioned
    // INSIDE Popover.Content, whose primitive base is overflow-hidden — that
    // clipped the flyout ("3-dots menu cut off"). We override to overflow-visible
    // (twMerge wins), so assert the resolved class never reverts to hidden.
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    const menu = await screen.findByTestId('board-switcher-menu');
    expect(menu.className).toContain('overflow-visible');
    expect(menu.className).not.toContain('overflow-hidden');
  });

  it('picking a board writes ?board=<id> (preserving other params)', async () => {
    searchParamsValue = new URLSearchParams('peek=PROD-7');
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-pick-b2'));

    expect(push).toHaveBeenCalledTimes(1);
    const target = String(push.mock.calls[0]![0]);
    expect(target).toContain('board=b2');
    expect(target).toContain('peek=PROD-7'); // other params preserved
  });
});

describe('BoardSwitcher (3.7.4) — create', () => {
  it('creates a board (POST /api/boards) and switches to it', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-new'));

    const name = (await screen.findByTestId('board-new-name')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Roadmap' } });
    fireEvent.click(screen.getByTestId('board-new-submit'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, opts]) => String(url) === '/api/boards' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post![1].body)).toMatchObject({ name: 'Roadmap', type: 'kanban' });
    });
    // switched to the new board
    await waitFor(() => expect(String(push.mock.calls.at(-1)?.[0])).toContain('board=b-new'));
  });

  it('creates a Scrum board when the Scrum type is selected (POST {type:scrum})', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-new'));

    const name = (await screen.findByTestId('board-new-name')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Sprint board' } });

    // The Scrum tile is a real, enabled radio option (the "Epic 4" seam is gone).
    const scrumTile = screen.getByTestId('board-type-scrum');
    expect(scrumTile.getAttribute('aria-disabled')).toBeNull();
    expect(scrumTile.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(scrumTile);
    expect(scrumTile.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('board-type-kanban').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByTestId('board-new-submit'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, opts]) => String(url) === '/api/boards' && opts?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post![1].body)).toMatchObject({ name: 'Sprint board', type: 'scrum' });
    });
  });

  it('selects the type via arrow keys (radiogroup roving focus)', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-new'));

    const kanbanTile = await screen.findByTestId('board-type-kanban');
    const scrumTile = screen.getByTestId('board-type-scrum');
    // Kanban is the default selection; ArrowRight moves to Scrum, ArrowLeft back.
    expect(kanbanTile.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(kanbanTile, { key: 'ArrowRight' });
    expect(scrumTile.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(scrumTile, { key: 'ArrowLeft' });
    expect(kanbanTile.getAttribute('aria-checked')).toBe('true');
  });

  it('blocks an empty name client-side (no POST)', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-new'));
    fireEvent.click(await screen.findByTestId('board-new-submit'));

    await screen.findByText('Enter a board name.');
    expect(
      fetchMock.mock.calls.find(([u, o]) => String(u) === '/api/boards' && o?.method === 'POST'),
    ).toBeFalsy();
  });
});

describe('BoardSwitcher (3.7.4) — manage: rename / set-default', () => {
  it('renames a board (PATCH {name})', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-manage-b2'));
    fireEvent.click(await screen.findByTestId('board-switcher-rename-b2'));

    const name = (await screen.findByTestId('board-rename-name')) as HTMLInputElement;
    expect(name.value).toBe('Triage'); // prefilled
    fireEvent.change(name, { target: { value: 'Bugs' } });
    fireEvent.click(screen.getByTestId('board-rename-submit'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, opts]) => String(url) === '/api/boards/b2' && opts?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch![1].body)).toMatchObject({ name: 'Bugs' });
    });
  });

  it('sets a non-default board as default (PATCH {isDefault:true})', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-manage-b2'));
    fireEvent.click(await screen.findByTestId('board-switcher-setdefault-b2'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, opts]) => String(url) === '/api/boards/b2' && opts?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch![1].body)).toMatchObject({ isDefault: true });
    });
  });

  it('disables Set-as-default on the already-default board', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-manage-b1'));
    const item = await screen.findByTestId('board-switcher-setdefault-b1');
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('BoardSwitcher (3.7.4) — delete + last-board guard', () => {
  it('shows the delete confirm for a non-last board and fires DELETE', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-manage-b2'));
    fireEvent.click(await screen.findByTestId('board-switcher-delete-b2'));

    fireEvent.click(await screen.findByTestId('board-delete-confirm'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.find(
          ([url, opts]) => String(url) === '/api/boards/b2' && opts?.method === 'DELETE',
        ),
      ).toBeTruthy(),
    );
  });

  it('disables Delete with the last-board note when only one board exists', async () => {
    stubFetch([board()]);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-manage-b1'));

    const del = await screen.findByTestId('board-switcher-delete-b1');
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('board-switcher-lastboard-note')).toBeTruthy();
  });
});

describe('BoardSwitcher (3.7.4) — read-only (non-manager, 6.4 seam)', () => {
  it('hides New + the per-board manage affordance when canManage is false', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher canManage={false} />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    // can still switch boards…
    expect(await screen.findByTestId('board-switcher-pick-b2')).toBeTruthy();
    // …but no create / manage affordances
    expect(screen.queryByTestId('board-switcher-new')).toBeNull();
    expect(screen.queryByTestId('board-switcher-manage-b1')).toBeNull();
  });
});

describe('BoardSwitcher (3.7.8) — manage: Board settings deep-link', () => {
  it('the manage menu has a Board settings item linking to /settings/project/board?board=<id>', async () => {
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-manage-b2'));

    const link = await screen.findByTestId('board-switcher-settings-b2');
    // It is a navigation Link (anchor), not a button — the Jira-faithful
    // reached-FROM-the-board path into THIS board's config.
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/settings/project/board?board=b2');
    expect(link.getAttribute('role')).toBe('menuitem');
    expect(link.textContent).toContain('Board settings');
  });
});

describe('BoardSwitcher (3.7.8) — settings variant (switch-only)', () => {
  it('renders the switcher on the settings route but hides New + per-row manage', async () => {
    // The settings page mounts the switcher with `variant="settings"` to
    // re-target WHICH board is being configured; creating / renaming / deleting a
    // board stays the /boards switcher's job (per the 3.7.7 design notes).
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher variant="settings" />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    // can still switch which board to configure…
    expect(await screen.findByTestId('board-switcher-pick-b2')).toBeTruthy();
    // …but no New board and no per-row manage [⋯] (so no Board-settings item either)
    expect(screen.queryByTestId('board-switcher-new')).toBeNull();
    expect(screen.queryByTestId('board-switcher-manage-b1')).toBeNull();
    expect(screen.queryByTestId('board-switcher-manage-b2')).toBeNull();
  });

  it('picking a board re-targets ?board=<id> on the current (settings) route', async () => {
    // usePathname is mocked to /boards here, but selectBoard preserves the
    // pathname + sets ?board= — so on the real settings route it re-lays the page.
    stubFetch(TWO_BOARDS);
    render(<BoardSwitcher variant="settings" />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-pick-b2'));

    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0]![0])).toContain('board=b2');
  });
});

describe('boardSwitcher helpers (3.7.4)', () => {
  it('resolveActiveBoardId prefers the param, falls back to default', () => {
    expect(resolveActiveBoardId(TWO_BOARDS, 'b2')).toBe('b2');
    expect(resolveActiveBoardId(TWO_BOARDS, null)).toBe('b1'); // default
    expect(resolveActiveBoardId(TWO_BOARDS, 'nope')).toBe('b1'); // stale param → default
    expect(resolveActiveBoardId([], null)).toBeNull();
  });

  it('applyDefault sets exactly one default (the one-default invariant)', () => {
    const next = applyDefault(TWO_BOARDS, 'b2');
    expect(next.filter((b) => b.isDefault).map((b) => b.id)).toEqual(['b2']);
  });

  it('applyDelete promotes the next board when the deleted one was default', () => {
    const { boards, promotedDefaultId } = applyDelete(TWO_BOARDS, 'b1');
    expect(boards.map((b) => b.id)).toEqual(['b2']);
    expect(promotedDefaultId).toBe('b2');
    expect(boards[0]!.isDefault).toBe(true);
  });

  it('sortBoards orders by fractional-index position; upsertBoard inserts + re-sorts', () => {
    const unsorted = [
      board({ id: 'b2', position: 'a1', isDefault: false }),
      board({ id: 'b1', position: 'a0' }),
    ];
    expect(sortBoards(unsorted).map((b) => b.id)).toEqual(['b1', 'b2']);
    const added = upsertBoard(TWO_BOARDS, board({ id: 'b3', position: 'a05', isDefault: false }));
    expect(added.map((b) => b.id)).toEqual(['b1', 'b3', 'b2']);
  });
});

// ── The create dialog's Board filter section (Story MOTIR-10560 · MOTIR-11333) ──
// The section hosts the shared `FilterConditionBuilder` as form state; "Start
// from a saved filter" COPIES the resolved saved filter's conditions in (and
// resolves the labels they name through `/labels?ids=`); the POST carries the
// committed envelope as `filter`, or no `filter` key at all; a 422 stays in the
// dialog, every other failure keeps the toast.

const tb = enMessages.boards;
const tiv = enMessages.issueViews;

const LOOKUPS: BoardFilterLookups = {
  statuses: [],
  members: [],
  sprints: [],
  customFields: [],
  components: [],
  referencedLabels: [],
  projectKey: 'ACME',
};

const BUG_OR_MOBILE: FilterAst = {
  combinator: 'or',
  conditions: [
    { field: 'kind', operator: 'is_any_of', value: ['bug'] },
    { field: 'lbl', operator: 'is_any_of', value: ['lab-mobile'] },
  ],
};
const GONE_LABEL: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'lbl', operator: 'is_any_of', value: ['lab-gone'] }],
};
// Two complete conditions; the server (stubbed) refuses the second by index.
const BAD_SECOND: FilterAst = {
  combinator: 'and',
  conditions: [
    { field: 'kind', operator: 'is_any_of', value: ['bug'] },
    { field: 'priority', operator: 'is_any_of', value: ['high'] },
  ],
};

function savedFilter(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    visibility: 'project' as const,
    owner: { id: 'u1', name: 'Dana' },
    starCount: 0,
    starredByMe: false,
    builtin: false as const,
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const SAVED = {
  'sf-mobile': { summary: savedFilter('sf-mobile', 'Mobile work'), ast: BUG_OR_MOBILE },
  'sf-gone': { summary: savedFilter('sf-gone', 'Old labels'), ast: GONE_LABEL },
  'sf-bad': { summary: savedFilter('sf-bad', 'Odd kinds'), ast: BAD_SECOND },
  'sf-broken': { summary: savedFilter('sf-broken', 'Broken'), ast: null },
} as const;

type PostReply = { status: number; body: unknown };

function stubFilterFetch(post: PostReply = { status: 201, body: null }) {
  const posts: unknown[] = [];
  fetchMock = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = opts?.method ?? 'GET';
    if (u === '/api/boards' && method === 'GET') return ok({ boards: TWO_BOARDS });
    if (u === '/api/boards' && method === 'POST') {
      const body = JSON.parse(opts!.body!);
      posts.push(body);
      if (post.status === 201) {
        return ok(
          { id: 'b-new', name: body.name, type: body.type, isDefault: false, position: 'a9' },
          201,
        );
      }
      return { ok: false, status: post.status, json: async () => post.body };
    }
    if (u.startsWith('/api/projects/ACME/saved-filters?')) {
      return ok({
        items: Object.values(SAVED).map((f) => f.summary),
        nextCursor: null,
        total: 4,
        builtins: [],
      });
    }
    const resolved = u.match(/^\/api\/projects\/ACME\/saved-filters\/([^/?]+)$/);
    if (resolved) {
      const f = SAVED[resolved[1] as keyof typeof SAVED];
      return ok({
        filter: f.summary,
        ast: f.ast,
        astError: f.ast ? null : { kind: 'malformed', message: 'bad envelope' },
        capabilities: {},
      });
    }
    if (u.startsWith('/api/projects/ACME/labels?')) {
      const ids = new URL(`http://x${u}`).searchParams.get('ids')!.split(',');
      const known = [{ id: 'lab-mobile', name: 'mobile' }];
      return ok({ labels: known.filter((l) => ids.includes(l.id)) });
    }
    return { ok: false, status: 404, json: async () => ({ code: 'NOT_FOUND' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return posts;
}

/** Open New board; `null` mounts the switcher with no lookups at all. */
async function openCreateDialog(lookups: BoardFilterLookups | null = LOOKUPS) {
  render(<BoardSwitcher canManage filterLookups={lookups ?? undefined} />);
  fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
  fireEvent.click(await screen.findByTestId('board-switcher-new'));
  fireEvent.change(await screen.findByTestId('board-new-name'), { target: { value: 'Bugs' } });
}

async function copySaved(name: string) {
  fireEvent.click(await screen.findByRole('combobox', { name: tb.filterStartFromSaved }));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

describe('BoardSwitcher — the create dialog’s Board filter section (MOTIR-11333)', () => {
  it('shows the optional section collapsed below the board type, and opens the shared builder', async () => {
    stubFilterFetch();
    await openCreateDialog();
    const section = screen.getByTestId('board-filter-section');
    expect(section.textContent).toContain(tb.filterSectionLabel);
    expect(section.textContent).toContain(tb.filterSectionOptional);
    expect(section.textContent).toContain(tb.filterSectionEmptyHint);
    // Below the board-type radio group.
    const radios = screen.getByRole('radiogroup');
    expect(radios.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByTestId('board-filter-add'));
    expect(await screen.findByText(tb.filterSectionIntro)).toBeTruthy();
    expect(screen.getByRole('button', { name: new RegExp(tiv.advancedAddCondition) })).toBeTruthy();
    // The form host's foot line: nothing applies until Create.
    expect(screen.getByText('0 of 20 conditions')).toBeTruthy();

    fireEvent.click(screen.getByTestId('board-filter-remove'));
    expect(screen.getByTestId('board-filter-add')).toBeTruthy();
  });

  it('posts { name, type } with no filter key when the section holds no complete condition', async () => {
    const posts = stubFilterFetch();
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    // A pending row (no value yet) is dropped from the committed filter.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(tiv.advancedAddCondition) }));
    fireEvent.click(screen.getByTestId('board-new-submit'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ name: 'Bugs', type: 'kanban' });
    expect(Object.keys(posts[0] as object)).not.toContain('filter');
  });

  it('copies a saved filter’s conditions, names its labels, and posts only the copy as the envelope', async () => {
    const posts = stubFilterFetch();
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    await copySaved('Mobile work');

    const copied = await screen.findByTestId('board-filter-copied');
    expect(copied.textContent).toContain('Mobile work');
    // The copied label resolves by name; nothing is flagged as deleted.
    expect(await screen.findByText('mobile')).toBeTruthy();
    expect(screen.queryByText(tiv.advancedStaleNote)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/ACME/labels?ids=lab-mobile',
      expect.anything(),
    );
    // The conditions are the builder's own, editable: two condition groups.
    expect(screen.getAllByRole('group', { name: /Condition \d/ })).toHaveLength(2);

    fireEvent.click(screen.getByTestId('board-new-submit'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      name: 'Bugs',
      type: 'kanban',
      filter: encodeFilterEnvelope(BUG_OR_MOBILE),
    });
    expect(JSON.stringify(posts[0])).not.toContain('sf-mobile');
  });

  it('flags a copied label that no longer exists as stale', async () => {
    stubFilterFetch();
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    await copySaved('Old labels');
    await screen.findByTestId('board-filter-copied');
    expect(await screen.findByText(tiv.advancedStaleNote)).toBeTruthy();
  });

  it('copies nothing from a saved filter whose conditions no longer read, and says so', async () => {
    stubFilterFetch();
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    await copySaved('Mobile work');
    await screen.findByTestId('board-filter-copied');
    await copySaved('Broken');

    const error = await screen.findByTestId('board-filter-copy-error');
    expect(error.textContent).toContain('“Broken” can’t be used');
    // The builder keeps what it held.
    expect(screen.getAllByRole('group', { name: /Condition \d/ })).toHaveLength(2);
    expect(screen.queryByTestId('board-filter-copied')).toBeNull();
  });

  it('says so when copying fails, and copies nothing', async () => {
    stubFilterFetch();
    const base = fetchMock.getMockImplementation() as (url: string, opts?: unknown) => unknown;
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) =>
      String(url).includes('/labels?')
        ? { ok: false, status: 500, json: async () => ({}) }
        : base(url, opts),
    );
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    await copySaved('Mobile work');
    const error = await screen.findByTestId('board-filter-copy-error');
    expect(error.textContent).toContain(tb.filterStartFromSavedFailed);
    expect(screen.queryAllByRole('group', { name: /Condition \d/ })).toHaveLength(0);
  });

  it('keeps the dialog open on a 422 and names the failing condition inside the section', async () => {
    stubFilterFetch({
      status: 422,
      body: { code: 'INVALID_FILTER_VALUE', error: 'that kind is unknown', conditionIndex: 1 },
    });
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    await copySaved('Odd kinds');
    await screen.findByTestId('board-filter-copied');
    fireEvent.click(screen.getByTestId('board-new-submit'));

    const refusal = await screen.findByTestId('board-filter-refusal');
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(within(refusal).getByText(tb.filterRefusedTitle)).toBeTruthy();
    expect(refusal.textContent).toContain('Condition 2 can’t be used: that kind is unknown.');
    // Open, unchanged, and no generic toast.
    expect((screen.getByTestId('board-new-name') as HTMLInputElement).value).toBe('Bugs');
    expect(screen.getAllByRole('group', { name: /Condition \d/ })).toHaveLength(2);
    expect(screen.queryByText(tb.boardCreateErrorDescription)).toBeNull();
    expect(push).not.toHaveBeenCalled();

    // An edit clears the refusal.
    fireEvent.click(screen.getAllByRole('button', { name: /Remove condition/ })[1]!);
    expect(screen.queryByTestId('board-filter-refusal')).toBeNull();
  });

  it('renders a whole-filter refusal and the over-cap refusal', async () => {
    stubFilterFetch({ status: 422, body: { code: 'MALFORMED_FILTER', error: 'unreadable' } });
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    await copySaved('Mobile work');
    await screen.findByTestId('board-filter-copied');
    fireEvent.click(screen.getByTestId('board-new-submit'));
    expect((await screen.findByTestId('board-filter-refusal')).textContent).toContain(
      'This filter can’t be used: unreadable.',
    );

    cleanup();
    stubFilterFetch({
      status: 422,
      body: { code: 'FILTER_TOO_LARGE', error: 'Filter has 21 conditions; the cap is 20' },
    });
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    await copySaved('Mobile work');
    await screen.findByTestId('board-filter-copied');
    fireEvent.click(screen.getByTestId('board-new-submit'));
    expect((await screen.findByTestId('board-filter-refusal')).textContent).toContain(
      'A board filter holds at most 20 conditions, and this one has 2. Remove 1 condition to continue.',
    );
  });

  it('searches the saved filters as the person types', async () => {
    stubFilterFetch();
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    fireEvent.click(await screen.findByRole('combobox', { name: tb.filterStartFromSaved }));
    fireEvent.change(await screen.findByPlaceholderText(tb.filterStartFromSavedSearch), {
      target: { value: 'Mob' },
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url).startsWith('/api/projects/ACME/saved-filters?') &&
            String(url).includes('q=Mob'),
        ),
      ).toBe(true),
    );
  });

  it('shows the empty picker when the saved filters cannot be listed', async () => {
    stubFilterFetch();
    const base = fetchMock.getMockImplementation() as (url: string, opts?: unknown) => unknown;
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) =>
      String(url).includes('/saved-filters?')
        ? { ok: false, status: 500, json: async () => ({ code: 'INTERNAL' }) }
        : base(url, opts),
    );
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    fireEvent.click(await screen.findByRole('combobox', { name: tb.filterStartFromSaved }));
    expect(await screen.findByText(tb.filterStartFromSavedEmpty)).toBeTruthy();
  });

  it('does not repeat a label the page already resolved', async () => {
    stubFilterFetch();
    await openCreateDialog({
      ...LOOKUPS,
      referencedLabels: [{ id: 'lab-mobile', name: 'mobile' }],
    });
    fireEvent.click(screen.getByTestId('board-filter-add'));
    await copySaved('Mobile work');
    await screen.findByTestId('board-filter-copied');
    expect(await screen.findAllByText('mobile')).toHaveLength(1);
  });

  it('still shows a refusal inside the section when the 422 body cannot be read', async () => {
    stubFilterFetch();
    const base = fetchMock.getMockImplementation() as (url: string, opts?: unknown) => unknown;
    fetchMock.mockImplementation(async (url: string, opts?: { method?: string }) =>
      String(url) === '/api/boards' && opts?.method === 'POST'
        ? {
            ok: false,
            status: 422,
            json: async () => {
              throw new SyntaxError('not json');
            },
          }
        : base(url, opts),
    );
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-filter-add'));
    await copySaved('Mobile work');
    await screen.findByTestId('board-filter-copied');
    fireEvent.click(screen.getByTestId('board-new-submit'));
    expect((await screen.findByTestId('board-filter-refusal')).textContent).toContain(
      'This filter can’t be used',
    );
  });

  it('keeps the generic toast for a failure that is not a 422', async () => {
    stubFilterFetch({ status: 500, body: { code: 'INTERNAL' } });
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-new-submit'));
    expect(await screen.findByText(tb.boardCreateErrorDescription)).toBeTruthy();
    expect(screen.queryByTestId('board-filter-refusal')).toBeNull();
  });

  it('a successful create closes the dialog, selects and announces the new board', async () => {
    stubFilterFetch();
    await openCreateDialog();
    fireEvent.click(screen.getByTestId('board-new-submit'));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/boards?board=b-new', { scroll: false }),
    );
    expect(screen.queryByTestId('board-filter-section')).toBeNull();
    expect(screen.getByTestId('board-switcher-live').textContent).toContain('Bugs');
  });

  it('the rename dialog, and a switcher without lookups, show no Filter section', async () => {
    stubFilterFetch();
    render(<BoardSwitcher canManage filterLookups={LOOKUPS} />);
    fireEvent.click(await screen.findByTestId('board-switcher-trigger'));
    fireEvent.click(await screen.findByTestId('board-switcher-manage-b1'));
    fireEvent.click(await screen.findByTestId('board-switcher-rename-b1'));
    await screen.findByTestId('board-rename-name');
    expect(screen.queryByTestId('board-filter-section')).toBeNull();
    cleanup();

    stubFilterFetch();
    await openCreateDialog(null);
    expect(screen.queryByTestId('board-filter-section')).toBeNull();
  });
});
