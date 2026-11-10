// @vitest-environment happy-dom
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { clearToastTimersAfterEach } from '../helpers/toastTimers';
import { ToastProvider } from '@/components/ui/Toast';
import { PageView, type PageViewPage } from '@/app/(authed)/pages/[pageId]/_components/PageView';
import type { PageVersionListItemDto } from '@/lib/dto/pages';

// PageView's own ⋯ and the archived banner read the router (MOTIR-7423).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// RESTORE from the history panel (Story MOTIR-5754 · MOTIR-7388) —
// `design/pages/page--history.mock.html` states 7–13, driven under happy-dom
// with the REAL editor host for the live page and the version beside it. Only
// `fetch` is stubbed: restore is `POST /api/pages/<id>/versions/<n>/restore`.

const EMPTY_STATE = 'AAA=';
/** One paragraph: "Tag the commit, then push the tag." */
const BODY_STATE =
  'AQONzd2iCwAHAQdkZWZhdWx0AwlwYXJhZ3JhcGgHAI3N3aILAAYEAI3N3aILASJUYWcgdGhlIGNvbW1pdCwgdGhlbiBwdXNoIHRoZSB0YWcuAA==';
const VIEWER = 'user-ada';

type Answer = Response | Error | Promise<Response>;
const answers: Record<string, Answer[]> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  const key = Object.keys(answers).find((suffix) => url.endsWith(suffix));
  const next = key ? answers[key]!.shift() : undefined;
  if (!next) throw new Error(`unanswered fetch: ${url}`);
  if (next instanceof Error) throw next;
  return next;
});
function answer(suffix: string, ...responses: Answer[]) {
  (answers[suffix] ??= []).push(...responses);
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const calls = (suffix: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix));

function version(
  number: number,
  over: Partial<PageVersionListItemDto> = {},
): PageVersionListItemDto {
  const savedAt = new Date(Date.now() - number * 60_000).toISOString();
  return {
    number,
    authorId: 'user-grace',
    authorName: 'Grace Hopper',
    startedAt: savedAt,
    savedAt,
    restoredFromNumber: null,
    restoredFromKept: false,
    isCurrent: false,
    ...over,
  };
}
const THREE = {
  items: [version(3, { isCurrent: true }), version(2), version(1)],
  nextBefore: null,
};
const V1 = { ...THREE.items[2]!, bodyState: BODY_STATE };
const RESTORED = {
  revision: 9,
  version: version(4, {
    isCurrent: true,
    authorId: VIEWER,
    authorName: 'Ada Lovelace',
    restoredFromNumber: 1,
    restoredFromKept: true,
  }),
  bodyState: BODY_STATE,
};
const AFTER = {
  items: [RESTORED.version, { ...THREE.items[0]!, isCurrent: false }, ...THREE.items.slice(1)],
  nextBefore: null,
};

const liveSurface = () => screen.getAllByRole('textbox', { name: 'Page body' })[0]!;
const editorOf = (surface: HTMLElement) => (surface as HTMLElement & { editor: Editor }).editor;
const restoreButton = () => screen.queryByRole('button', { name: 'Restore this version' });

async function mount(page: Partial<PageViewPage> = {}) {
  renderWithIntl(
    <ToastProvider>
      <Suspense fallback={<p>frame</p>}>
        <PageView
          page={{ id: 'page-1', title: 'Runbook', bodyState: EMPTY_STATE, canEdit: true, ...page }}
          viewerId={VIEWER}
          titleMaxLength={255}
        />
      </Suspense>
    </ToastProvider>,
  );
  await screen.findByRole('textbox', { name: 'Page body' });
  await act(async () => {});
}

/** Open History and select v{number}, waiting for its content. */
async function openVersion(number: number) {
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  const list = await screen.findByRole('list', { name: 'Versions of this page' });
  const rows = within(list).getAllByRole('button');
  fireEvent.click(rows[THREE.items.findIndex((v) => v.number === number)]!);
  const view = screen.getByTestId('page-version-view');
  await within(view).findByText('Tag the commit, then push the tag.');
  return view;
}

async function confirmRestore() {
  fireEvent.click(restoreButton()!);
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain('Restore v1?');
  expect(dialog.textContent).toContain(
    'The page will show v1’s content as a new version. Nothing is deleted.',
  );
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore v1' }));
  });
}

clearToastTimersAfterEach();

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('who sees Restore', () => {
  it('an editor viewing v1 sees Restore', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/1', json(V1));
    await mount();
    await openVersion(1);
    expect(restoreButton()).toBeTruthy();
    expect(restoreButton()!.hasAttribute('disabled')).toBe(false);
  });

  it('a viewer sees no Restore, and nothing drawn disabled', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/1', json(V1));
    await mount({ canEdit: false });
    await openVersion(1);
    expect(restoreButton()).toBeNull();
  });

  it('a version that is current offers no Restore', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/1', json({ ...V1, isCurrent: true }));
    await mount();
    await openVersion(1);
    expect(restoreButton()).toBeNull();
  });
});

describe('restoring', () => {
  it('sends one POST, remounts the live editor on the returned state, lists the restore first and toasts', async () => {
    answer('/api/pages/page-1/versions', json(THREE), json(AFTER));
    answer('/api/pages/page-1/versions/1', json(V1));
    answer('/api/pages/page-1/versions/1/restore', json(RESTORED));
    await mount();
    const before = liveSurface();
    expect(before.textContent).not.toContain('Tag the commit');
    await openVersion(1);
    await confirmRestore();

    expect(calls('/versions/1/restore')).toHaveLength(1);
    expect(calls('/versions/1/restore')[0]![1]).toMatchObject({ method: 'POST' });
    // Compare closes; the live editor is a NEW editor showing the restored content.
    await waitFor(() => expect(screen.queryByTestId('page-version-view')).toBeNull());
    await waitFor(() => expect(liveSurface().textContent).toContain('Tag the commit'));
    expect(liveSurface()).not.toBe(before);
    expect(liveSurface().getAttribute('contenteditable')).toBe('true');

    const list = screen.getByRole('list', { name: 'Versions of this page' });
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(4));
    const first = within(list).getAllByRole('button')[0]!;
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(first.textContent).toContain('Restored from v1');
    expect(first.className).toContain('bg-(--el-tint-mint)');
    expect(screen.getByText('Restored v1 as v4.')).toBeTruthy();
  });

  it('cancelling the confirm sends nothing', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/1', json(V1));
    await mount();
    await openVersion(1);
    fireEvent.click(restoreButton()!);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls('/restore')).toHaveLength(0);
    // Compare is still open: the dialog took its own Esc-less close.
    expect(screen.getByTestId('page-version-view')).toBeTruthy();
  });

  it('while restoring the panel is inert and the confirm cannot be dismissed', async () => {
    let release!: (res: Response) => void;
    answer('/api/pages/page-1/versions', json(THREE), json(AFTER));
    answer('/api/pages/page-1/versions/1', json(V1));
    answer(
      '/api/pages/page-1/versions/1/restore',
      new Promise<Response>((resolve) => (release = resolve)),
    );
    await mount();
    await openVersion(1);
    fireEvent.click(restoreButton()!);
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restore v1' }));
    });
    expect(dialog.textContent).toContain('Restoring…');
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(
      true,
    );
    const panel = screen.getByRole('complementary', { hidden: true });
    expect(panel.getAttribute('aria-busy')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    await act(async () => release(json(RESTORED)));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('complementary').getAttribute('aria-busy')).toBeNull();
  });
});

describe('refusals leave the page as it was', () => {
  it('a 413 shows the too-large message and disables Restore for that version', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/1', json(V1));
    answer(
      '/api/pages/page-1/versions/1/restore',
      json({ code: 'PAGE_BODY_TOO_LARGE', limit: 1, size: 2 }, 413),
    );
    await mount();
    const before = liveSurface();
    await openVersion(1);
    await confirmRestore();

    const view = screen.getByTestId('page-version-view');
    const alert = await within(view).findByRole('alert');
    expect(alert.textContent).toContain(
      'v1 can’t be restored: the page would pass its 2 MB limit. Nothing was changed.',
    );
    expect(restoreButton()!.hasAttribute('disabled')).toBe(true);
    expect(restoreButton()!.getAttribute('aria-describedby')).toBe('page-restore-note');
    expect(liveSurface()).toBe(before);
    expect(before.textContent).not.toContain('Tag the commit');
    expect(calls('/api/pages/page-1/versions')).toHaveLength(1);
  });

  it('a 404 PAGE_VERSION_NOT_FOUND shows "no longer kept", re-reads the list and closes compare', async () => {
    answer(
      '/api/pages/page-1/versions',
      json(THREE),
      json({ items: THREE.items.slice(0, 2), nextBefore: null }),
    );
    answer('/api/pages/page-1/versions/1', json(V1));
    answer('/api/pages/page-1/versions/1/restore', json({ code: 'PAGE_VERSION_NOT_FOUND' }, 404));
    await mount();
    const before = liveSurface();
    await openVersion(1);
    await confirmRestore();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('v1 is no longer kept');
    await waitFor(() => expect(calls('/api/pages/page-1/versions')).toHaveLength(2));
    expect(screen.queryByTestId('page-version-view')).toBeNull();
    expect(liveSurface()).toBe(before);
  });

  it('a 403 or a network failure says nothing was changed', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/1', json(V1));
    answer(
      '/api/pages/page-1/versions/1/restore',
      json({ code: 'FORBIDDEN' }, 403),
      new TypeError('Failed to fetch'),
    );
    await mount();
    const before = liveSurface();
    await openVersion(1);
    await confirmRestore();
    const view = screen.getByTestId('page-version-view');
    expect((await within(view).findByRole('alert')).textContent).toContain(
      'v1 couldn’t be restored. Nothing was changed — try again.',
    );
    // Restore stays available after an ordinary failure.
    expect(restoreButton()!.hasAttribute('disabled')).toBe(false);
    await confirmRestore();
    expect(calls('/versions/1/restore')).toHaveLength(2);
    expect(within(view).getByRole('alert').textContent).toContain('couldn’t be restored');
    expect(liveSurface()).toBe(before);
  });
});

describe('held while edits are unsaved', () => {
  it('disables Restore with the explanation while saving, and enables it once saved', async () => {
    let releaseSave!: (res: Response) => void;
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/1', json(V1));
    answer(
      '/api/pages/page-1/updates',
      new Promise<Response>((resolve) => (releaseSave = resolve)),
    );
    await mount();
    await openVersion(1);

    const editor = editorOf(liveSurface());
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'Draft');
    });
    expect(restoreButton()!.hasAttribute('disabled')).toBe(true);
    expect(restoreButton()!.getAttribute('aria-describedby')).toBe('page-restore-note');
    expect(document.getElementById('page-restore-note')!.textContent).toContain(
      'Restore is held until your edits are saved.',
    );
    fireEvent.click(restoreButton()!);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await waitFor(() => expect(calls('/api/pages/page-1/updates')).toHaveLength(1), {
      timeout: 3_000,
    });
    await act(async () => releaseSave(json({ revision: 2 })));
    await waitFor(() => expect(restoreButton()!.hasAttribute('disabled')).toBe(false));
    expect(document.getElementById('page-restore-note')).toBeNull();
    expect(calls('/restore')).toHaveLength(0);
  });
});
