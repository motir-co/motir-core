// @vitest-environment happy-dom
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { WorkItemRefMap, WorkItemRefSummaryDto } from '@/lib/dto/workItems';
import type { PageCommentDto, PageCommentThreadDto } from '@/lib/pages';
import type {
  PageCommentResult,
  PageDiscussionList,
} from '@/app/(authed)/pages/[pageId]/_components/pageCommentsClient';

// The page's DISCUSSION PANEL (Story MOTIR-10866 · MOTIR-10874) — the panel,
// the thread and the comment row at component level: the member, author,
// moderator, viewer and archived tiers; the empty, loading, list-failed and
// write-failed states; the mention token in the sent body; the sequence guard;
// Load more; and the Discussion control on `PageView`, one right-hand panel at a
// time. The network is stubbed at the `pageCommentsClient` module, the way
// `comments-section.test.tsx` stubs the work-item actions; the routes' own
// behaviour belongs to `tests/api/pages-comments-routes.test.ts`.

const client = {
  listPageComments: vi.fn(),
  createPageComment: vi.fn(),
  replyToPageComment: vi.fn(),
  editPageComment: vi.fn(),
  deletePageComment: vi.fn(),
  resolvePageCommentThread: vi.fn(),
  reopenPageCommentThread: vi.fn(),
};

vi.mock('@/app/(authed)/pages/[pageId]/_components/pageCommentsClient', () => ({
  listPageComments: (...args: unknown[]) => client.listPageComments(...args),
  createPageComment: (...args: unknown[]) => client.createPageComment(...args),
  replyToPageComment: (...args: unknown[]) => client.replyToPageComment(...args),
  editPageComment: (...args: unknown[]) => client.editPageComment(...args),
  deletePageComment: (...args: unknown[]) => client.deletePageComment(...args),
  resolvePageCommentThread: (...args: unknown[]) => client.resolvePageCommentThread(...args),
  reopenPageCommentThread: (...args: unknown[]) => client.reopenPageCommentThread(...args),
}));

// The composer embeds the client-only Tiptap MarkdownEditor — a labelled
// textarea stands in, and says how many mention candidates it was handed.
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
    label,
    mentionCandidates,
  }: {
    value: string;
    onChange: (v: string) => void;
    label: string;
    mentionCandidates?: { id: string; name: string }[];
  }) => (
    <textarea
      aria-label={label}
      data-candidates={(mentionCandidates ?? []).map((c) => c.name).join(',')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  // A `motir:` card chip reads the path for its quick-view link.
  usePathname: () => '/pages/page-1',
}));

// For the PageView block: the editor, the strip, the quick view and History's
// list are not this card's; History's panel is a stand-in aside.
// The live editor's stand-in records what it is handed (MOTIR-10901), so a
// PageView case can see the roots it washes and answer their verdicts.
const host = vi.hoisted(() => ({
  props: null as null | {
    inlineThreads?: { id: string; resolvedAt: string | null; anchor: unknown }[];
    onInlineAnchorsResolved?: (
      verdicts: Record<string, { from: number; to: number } | null>,
    ) => void;
    passageComment?: {
      mentionCandidates: unknown[];
      onSubmit: (
        anchor: { bytes: string; quote: string },
        bodyMd: string,
      ) => Promise<string | null>;
    };
  },
}));
vi.mock('@/components/pages/PageEditorHost', () => ({
  default: (props: NonNullable<typeof host.props>) => {
    host.props = props;
    return <div data-testid="editor-stub" />;
  },
}));
vi.mock('@/app/(authed)/pages/[pageId]/_components/LinkedWorkItemsStrip', () => ({
  LinkedWorkItemsStrip: () => null,
}));
vi.mock('@/app/(authed)/items/_components/IssueQuickViewController', () => ({
  IssueQuickViewController: () => null,
}));
vi.mock('@/app/(authed)/pages/[pageId]/_components/PageHistoryPanel', () => ({
  PageHistoryPanel: () => <aside id="page-history" aria-label="History stand-in" />,
  HistoryNotice: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { PageDiscussionPanel } from '@/app/(authed)/pages/[pageId]/_components/PageDiscussionPanel';
import { PageView } from '@/app/(authed)/pages/[pageId]/_components/PageView';

const ME = { id: 'user-me', name: 'Ana Ruiz', image: null };
const BO = { id: 'user-bo', name: 'Bo Philips', image: null };
const CANDIDATES = [{ id: BO.id, name: BO.name, email: 'bo@motir.co' }];

let seq = 0;
function comment(author: typeof ME, overrides: Partial<PageCommentDto> = {}): PageCommentDto {
  seq += 1;
  return {
    id: `c-${seq}`,
    pageId: 'page-1',
    parentCommentId: null,
    author,
    bodyMd: `Body ${seq}`,
    editedAt: null,
    createdAt: new Date(Date.UTC(2026, 10, 1, 12, 0, 0) + seq * 60_000).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    anchor: null,
    ...overrides,
  };
}
function thread(
  author: typeof ME,
  replies: PageCommentDto[] = [],
  overrides: Partial<PageCommentDto> = {},
): PageCommentThreadDto {
  const root = comment(author, overrides);
  return { ...root, replies: replies.map((r) => ({ ...r, parentCommentId: root.id })) };
}
function list(
  threads: PageCommentThreadDto[],
  overrides: Partial<PageDiscussionList> = {},
): PageCommentResult<PageDiscussionList> {
  return {
    ok: true,
    data: {
      threads,
      nextCursor: null,
      counts: { open: threads.length, resolved: 0 },
      capabilities: { canComment: true, canModerate: false },
      workItemRefs: {},
      ...overrides,
    },
  };
}
const ok = <T,>(data: T): PageCommentResult<T> => ({ ok: true, data });
const refused = (status: number, code: string | null) => ({
  ok: false as const,
  status,
  code,
  message: 'refused',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const onClose = vi.fn();
const onOpenCountChange = vi.fn();

async function mountPanel(props: Partial<Parameters<typeof PageDiscussionPanel>[0]> = {}) {
  const utils = render(
    <PageDiscussionPanel
      pageId="page-1"
      archived={false}
      currentUserId={ME.id}
      currentUserName={ME.name}
      mentionCandidates={CANDIDATES}
      onClose={onClose}
      onOpenCountChange={onOpenCountChange}
      {...props}
    />,
  );
  await act(async () => {});
  return utils;
}

const openList = () => screen.getByRole('list', { name: 'Open threads' });
const threadOf = (name: string) =>
  screen.getByRole('article', { name: `Thread started by ${name}` });
const switchButton = (name: 'Open' | 'Resolved') =>
  within(screen.getByRole('group', { name: 'Show open or resolved threads' })).getByRole('button', {
    name: new RegExp(`^${name}`),
  });

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  onClose.mockReset();
  onOpenCountChange.mockReset();
});
afterEach(cleanup);

describe('PageDiscussionPanel — reads', () => {
  it('reads the Open list newest first on open, draws loading with no composer, then the empty state', async () => {
    const pending = deferred<PageCommentResult<PageDiscussionList>>();
    client.listPageComments.mockReturnValueOnce(pending.promise);
    await mountPanel();
    expect(client.listPageComments).toHaveBeenCalledWith('page-1', {
      status: 'open',
      order: 'desc',
    });
    expect(screen.getByRole('status').textContent).toBe('Loading the discussion');
    expect(screen.getByTestId('page-discussion-skeleton')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a comment…' })).toBeNull();
    // Focus moves into the panel.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close discussion' }));

    await act(async () => pending.resolve(list([])));
    expect(screen.getByText('No comments on this page yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a comment…' })).toBeTruthy();
    expect(onOpenCountChange).toHaveBeenLastCalledWith(0);
  });

  it('shows the list-failed state with no composer, and Retry reads again', async () => {
    client.listPageComments
      .mockResolvedValueOnce(refused(500, null))
      .mockResolvedValueOnce(list([thread(BO)]));
    await mountPanel();
    expect(screen.getByText('Couldn’t load the discussion')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a comment…' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(client.listPageComments).toHaveBeenCalledTimes(2);
    expect(threadOf(BO.name)).toBeTruthy();
  });

  it('reads the Resolved list the first time it is shown, with its own empty look', async () => {
    client.listPageComments
      .mockResolvedValueOnce(list([], { counts: { open: 0, resolved: 0 } }))
      .mockResolvedValueOnce(list([], { counts: { open: 0, resolved: 0 } }));
    await mountPanel();
    await act(async () => fireEvent.click(switchButton('Resolved')));
    expect(client.listPageComments).toHaveBeenLastCalledWith('page-1', {
      status: 'resolved',
      order: 'desc',
    });
    expect(screen.getByText('No resolved threads')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a comment…' })).toBeNull();
    // Back to Open: no second read.
    await act(async () => fireEvent.click(switchButton('Open')));
    expect(client.listPageComments).toHaveBeenCalledTimes(2);
  });

  it('draws a thread with its replies, the Edited marker and absolute time on hover', async () => {
    const root = thread(BO, [comment(ME, { bodyMd: 'Agreed.' })], {
      editedAt: new Date().toISOString(),
    });
    client.listPageComments.mockResolvedValueOnce(list([root]));
    await mountPanel();
    const article = threadOf(BO.name);
    expect(within(article).getByText('· Edited')).toBeTruthy();
    expect(within(article).getByRole('list', { name: 'Replies' })).toBeTruthy();
    const time = article.querySelector('time');
    expect(time?.getAttribute('title')).toMatch(/2026/);
    expect(within(article).queryByTestId('page-thread-quote')).toBeNull();
  });

  it("drops a list read that another page's read replaced", async () => {
    const stale = deferred<PageCommentResult<PageDiscussionList>>();
    client.listPageComments
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(list([thread(ME)]));
    const panel = await mountPanel();
    panel.rerender(
      <PageDiscussionPanel
        pageId="page-2"
        archived={false}
        currentUserId={ME.id}
        currentUserName={ME.name}
        mentionCandidates={CANDIDATES}
        onClose={onClose}
      />,
    );
    await act(async () => {});
    await act(async () => stale.resolve(list([thread(BO)])));
    expect(threadOf(ME.name)).toBeTruthy();
    expect(screen.queryByRole('article', { name: `Thread started by ${BO.name}` })).toBeNull();
  });

  it('draws the quote slot only for an inline thread', async () => {
    client.listPageComments.mockResolvedValueOnce(
      list([thread(BO, [], { anchor: { bytes: 'AQID', quote: 'the rollout plan' } })]),
    );
    await mountPanel();
    const quote = screen.getByTestId('page-thread-quote');
    expect(quote.textContent).toBe('the rollout plan');
    // Clamped to three lines visually; the whole quote names the slot.
    expect(quote.querySelector('.line-clamp-3')?.textContent).toBe('the rollout plan');
    expect(quote.getAttribute('aria-label')).toBe('Quoted passage: the rollout plan');
  });
});

describe('PageDiscussionPanel — the inline presentation (MOTIR-10901)', () => {
  const ANCHOR = { bytes: 'AQID', quote: 'the rollout plan' };

  it('draws the Gone note under a gone thread’s quote, keeping its place and every action', async () => {
    const gone = thread(ME, [comment(BO)], { anchor: ANCHOR });
    const present = thread(BO, [], { anchor: { bytes: 'AQIE', quote: 'the budget' } });
    const pageLevel = thread(BO);
    client.listPageComments.mockResolvedValueOnce(list([pageLevel, gone, present]));
    await mountPanel({ goneThreadIds: new Set([gone.id]) });

    const articles = within(openList()).getAllByRole('article');
    expect(articles.map((a) => a.getAttribute('data-thread-anchor'))).toEqual([
      'page',
      'gone',
      'inline',
    ]);
    const row = articles[1]!;
    const note = within(row).getByTestId('page-thread-gone-note');
    expect(note.textContent).toBe('The passage is no longer in this page.');
    expect(note.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(within(row).getByTestId('page-thread-quote').textContent).toBe('the rollout plan');
    for (const name of ['Resolve', 'Reply', 'Edit', 'Delete']) {
      expect(within(row).getAllByRole('button', { name }).length).toBeGreaterThan(0);
    }
    expect(within(articles[2]!).queryByTestId('page-thread-gone-note')).toBeNull();
  });

  it('draws no note for a thread with no answer yet — no set, or an id not in it', async () => {
    const inline = thread(BO, [], { anchor: ANCHOR });
    client.listPageComments.mockResolvedValueOnce(list([inline]));
    await mountPanel();
    expect(screen.queryByTestId('page-thread-gone-note')).toBeNull();
    expect(threadOf(BO.name).getAttribute('data-thread-anchor')).toBe('inline');
    cleanup();
    client.listPageComments.mockResolvedValueOnce(list([inline]));
    await mountPanel({ goneThreadIds: new Set(['someone-else']) });
    expect(screen.queryByTestId('page-thread-gone-note')).toBeNull();
  });

  it('draws no note on a resolved thread, and the note returns when it is reopened still gone', async () => {
    const root = thread(BO, [], { anchor: ANCHOR });
    const onInlineThreadChange = vi.fn();
    client.listPageComments
      .mockResolvedValueOnce(list([root], { counts: { open: 1, resolved: 0 } }))
      .mockResolvedValueOnce(list([], { counts: { open: 1, resolved: 0 } }));
    await mountPanel({ goneThreadIds: new Set([root.id]), onInlineThreadChange });
    await act(async () => fireEvent.click(switchButton('Resolved')));
    await act(async () => fireEvent.click(switchButton('Open')));
    const resolved = { ...root, resolvedAt: new Date().toISOString(), resolvedBy: ME };
    client.resolvePageCommentThread.mockResolvedValueOnce(ok(resolved));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resolve' })));
    const { replies: _r, ...resolvedRoot } = resolved;
    expect(onInlineThreadChange).toHaveBeenLastCalledWith(root.id, resolvedRoot);

    await act(async () => fireEvent.click(switchButton('Resolved')));
    const article = threadOf(BO.name);
    expect(within(article).getByTestId('page-thread-quote')).toBeTruthy();
    expect(within(article).getByText(/^Resolved by Ana Ruiz · /)).toBeTruthy();
    expect(within(article).queryByTestId('page-thread-gone-note')).toBeNull();
    expect(article.getAttribute('data-thread-anchor')).toBe('inline');

    client.reopenPageCommentThread.mockResolvedValueOnce(ok(root));
    await act(async () => fireEvent.click(within(article).getByRole('button', { name: 'Reopen' })));
    const { replies: _r2, ...reopened } = root;
    expect(onInlineThreadChange).toHaveBeenLastCalledWith(root.id, reopened);
    await act(async () => fireEvent.click(switchButton('Open')));
    expect(within(threadOf(BO.name)).getByTestId('page-thread-gone-note')).toBeTruthy();
  });

  it('takes the note away when the id leaves the set, with no re-read', async () => {
    const root = thread(BO, [], { anchor: ANCHOR });
    client.listPageComments.mockResolvedValueOnce(list([root]));
    const utils = await mountPanel({ goneThreadIds: new Set([root.id]) });
    expect(screen.getByTestId('page-thread-gone-note')).toBeTruthy();
    utils.rerender(
      <PageDiscussionPanel
        pageId="page-1"
        archived={false}
        currentUserId={ME.id}
        currentUserName={ME.name}
        mentionCandidates={CANDIDATES}
        onClose={onClose}
        goneThreadIds={new Set()}
      />,
    );
    expect(screen.queryByTestId('page-thread-gone-note')).toBeNull();
    expect(screen.getByTestId('page-thread-quote')).toBeTruthy();
    expect(client.listPageComments).toHaveBeenCalledTimes(1);
  });

  it('reports a deleted root with null, and nothing for a refused write', async () => {
    const mine = thread(ME, [], { anchor: ANCHOR });
    const onInlineThreadChange = vi.fn();
    client.listPageComments.mockResolvedValueOnce(list([mine]));
    await mountPanel({ onInlineThreadChange });
    client.resolvePageCommentThread.mockResolvedValueOnce(refused(500, null));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resolve' })));
    expect(onInlineThreadChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    client.deletePageComment.mockResolvedValueOnce(refused(500, null));
    await act(async () =>
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' })),
    );
    expect(onInlineThreadChange).not.toHaveBeenCalled();
    client.deletePageComment.mockResolvedValueOnce(
      ok({ commentId: mine.id, parentCommentId: null, replyCount: 0 }),
    );
    await act(async () =>
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' })),
    );
    expect(onInlineThreadChange).toHaveBeenCalledWith(mine.id, null);
  });
});

describe('PageDiscussionPanel — tiers', () => {
  it('a member: Reply on roots only, Edit / Delete on their own comments only, Resolve on each thread', async () => {
    client.listPageComments.mockResolvedValueOnce(
      list([thread(BO, [comment(ME), comment(BO)]), thread(ME)]),
    );
    await mountPanel();
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(2);
    // My reply under Bo's thread, and my own root.
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Resolve' })).toHaveLength(2);
    expect(screen.queryByText(/your role can’t comment/)).toBeNull();
  });

  it("a moderator: Edit / Delete on everyone's comments", async () => {
    client.listPageComments.mockResolvedValueOnce(
      list([thread(BO, [comment(BO)])], {
        capabilities: { canComment: true, canModerate: true },
      }),
    );
    await mountPanel();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
  });

  it('a viewer: every thread, both lists, no controls, and the viewer line', async () => {
    const viewerList = (threads: PageCommentThreadDto[]) =>
      list(threads, { capabilities: { canComment: false, canModerate: false } });
    client.listPageComments
      .mockResolvedValueOnce(viewerList([thread(ME, [comment(BO)])]))
      .mockResolvedValueOnce(
        viewerList([thread(BO, [], { resolvedAt: new Date().toISOString(), resolvedBy: BO })]),
      );
    await mountPanel({ mentionCandidates: [] });
    const noControls = () => {
      for (const name of ['Add a comment…', 'Reply', 'Edit', 'Delete', 'Resolve', 'Reopen']) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
      expect(
        screen.getByText('You can read this discussion, but your role can’t comment on it.'),
      ).toBeTruthy();
    };
    expect(threadOf(ME.name)).toBeTruthy();
    noControls();
    await act(async () => fireEvent.click(switchButton('Resolved')));
    expect(threadOf(BO.name)).toBeTruthy();
    noControls();
  });

  it('an archived page: read-only for a moderator too, with the archive line', async () => {
    client.listPageComments.mockResolvedValueOnce(
      list([thread(ME, [comment(BO)])], {
        capabilities: { canComment: false, canModerate: true },
      }),
    );
    await mountPanel({ archived: true, mentionCandidates: [] });
    expect(screen.getByText('This page is archived, so its discussion is read-only.')).toBeTruthy();
    for (const name of ['Add a comment…', 'Reply', 'Edit', 'Delete', 'Resolve']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('PageDiscussionPanel — writes', () => {
  it('posts a comment with the mention token and prepends it, moving both counts', async () => {
    client.listPageComments.mockResolvedValueOnce(list([thread(BO)]));
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add a comment…' }));
    const box = screen.getByRole('textbox', {
      name: 'Comment on this page',
    }) as HTMLTextAreaElement;
    // The picker is handed the roster `page.tsx` read.
    expect(box.dataset.candidates).toBe(BO.name);
    const body = `[@${BO.name}](mention:${BO.id}) can you check this?`;
    fireEvent.change(box, { target: { value: body } });
    const posted = thread(ME, [], { bodyMd: body });
    client.createPageComment.mockResolvedValueOnce(ok(posted));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Comment' })));
    expect(client.createPageComment).toHaveBeenCalledWith('page-1', body);
    const items = within(openList()).getAllByRole('listitem');
    expect(items[0]!.querySelector('article')?.getAttribute('aria-label')).toBe(
      `Thread started by ${ME.name}`,
    );
    const chip = items[0]!.querySelector('.mention-chip');
    expect(chip?.textContent).toBe(`@${BO.name}`);
    expect(switchButton('Open').textContent).toContain('2');
    expect(onOpenCountChange).toHaveBeenLastCalledWith(2);
  });

  it('keeps the text and says what failed when a post is refused', async () => {
    client.listPageComments.mockResolvedValueOnce(list([]));
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add a comment…' }));
    const box = () => screen.getByRole('textbox', { name: 'Comment on this page' });
    fireEvent.change(box(), { target: { value: 'Draft' } });
    for (const [status, code, message] of [
      [500, null, 'Couldn’t post your comment. Your text is still here, so you can try again.'],
      [0, 'NETWORK', 'Couldn’t post your comment. Your text is still here, so you can try again.'],
      [409, 'PAGE_ARCHIVED', 'This page was archived, so its discussion is now read-only.'],
      [403, 'PERMISSION_DENIED', "You don't have permission to do that."],
      [422, 'PAGE_COMMENT_BODY_EMPTY', "A comment can't be empty."],
    ] as const) {
      client.createPageComment.mockResolvedValueOnce(refused(status, code));
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Comment' })));
      expect(screen.getByRole('alert').textContent).toBe(message);
      expect((box() as HTMLTextAreaElement).value).toBe('Draft');
    }
  });

  it('replies from the root, pre-mentioning its author; a reply carries no Reply control', async () => {
    const root = thread(BO);
    client.listPageComments.mockResolvedValueOnce(list([root]));
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    const box = screen.getByRole('textbox', { name: 'Write a reply' }) as HTMLTextAreaElement;
    expect(box.value).toBe(`[@${BO.name}](mention:${BO.id}) `);
    expect(box.dataset.candidates).toBe(BO.name);
    fireEvent.change(box, { target: { value: `${box.value}done` } });
    const reply = comment(ME, { parentCommentId: root.id, bodyMd: 'Done' });
    client.replyToPageComment.mockResolvedValueOnce(ok(reply));
    await act(async () =>
      fireEvent.click(within(threadOf(BO.name)).getAllByRole('button', { name: 'Reply' }).at(-1)!),
    );
    expect(client.replyToPageComment).toHaveBeenCalledWith(
      'page-1',
      root.id,
      `[@${BO.name}](mention:${BO.id}) done`,
    );
    const replies = within(threadOf(BO.name)).getByRole('list', { name: 'Replies' });
    expect(within(replies).getByText('Done')).toBeTruthy();
    expect(within(replies).queryByRole('button', { name: 'Reply' })).toBeNull();
    // The composer closed: only the root's Reply is left.
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
  });

  it('a refused reply keeps the reply composer and its text, with the depth reason', async () => {
    client.listPageComments.mockResolvedValueOnce(list([thread(BO)]));
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    client.replyToPageComment.mockResolvedValueOnce(
      refused(422, 'PAGE_COMMENT_REPLY_DEPTH_EXCEEDED'),
    );
    await act(async () =>
      fireEvent.click(within(threadOf(BO.name)).getAllByRole('button', { name: 'Reply' }).at(-1)!),
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'You can only reply to the first comment in a thread.',
    );
    expect(screen.getByRole('textbox', { name: 'Write a reply' })).toBeTruthy();
    // Cancel closes it.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Write a reply' })).toBeNull();
  });

  it('edits in place: Save sends PATCH and shows the new body with the Edited marker', async () => {
    const mine = thread(
      ME,
      [comment(ME, { bodyMd: 'Reply body' }), comment(BO, { bodyMd: 'Bo says' })],
      {
        bodyMd: 'Old body',
      },
    );
    client.listPageComments.mockResolvedValueOnce(list([mine]));
    await mountPanel();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    const box = screen.getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement;
    expect(box.value).toBe('Old body');
    expect(box.dataset.candidates).toBe(BO.name);
    fireEvent.change(box, { target: { value: 'New body' } });
    client.editPageComment.mockResolvedValueOnce(
      ok({ ...mine, replies: undefined, bodyMd: 'New body', editedAt: new Date().toISOString() }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(client.editPageComment).toHaveBeenCalledWith('page-1', mine.id, 'New body');
    expect(screen.getByText('New body')).toBeTruthy();
    expect(screen.getByText('· Edited')).toBeTruthy();
    // The root's replies survive its edit.
    expect(screen.getByText('Reply body')).toBeTruthy();

    // A reply's edit replaces that reply; a refused edit keeps the editor and says why.
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit comment' }), {
      target: { value: 'Reply, edited' },
    });
    client.editPageComment.mockResolvedValueOnce(refused(500, null));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByRole('alert').textContent).toBe(
      'Couldn’t save your edit. Your text is still here, so you can try again.',
    );
    client.editPageComment.mockResolvedValueOnce(
      ok({ ...mine.replies[0]!, bodyMd: 'Reply, edited', editedAt: new Date().toISOString() }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByText('Reply, edited')).toBeTruthy();
    expect(screen.getByText('Bo says')).toBeTruthy();
  });

  it('drops a write answer that lands after the panel closed', async () => {
    const mine = thread(ME, [], { bodyMd: 'Old body' });
    client.listPageComments.mockResolvedValueOnce(list([mine]));
    const panel = await mountPanel();
    const edit = deferred<PageCommentResult<PageCommentDto>>();
    const resolve = deferred<PageCommentResult<PageCommentThreadDto>>();
    client.editPageComment.mockReturnValueOnce(edit.promise);
    client.resolvePageCommentThread.mockReturnValueOnce(resolve.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit comment' }), {
      target: { value: 'First' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    panel.unmount();
    await act(async () => {
      edit.resolve(ok({ ...mine, bodyMd: 'First' }));
      resolve.resolve(refused(500, null));
    });
    expect(screen.queryByText('First')).toBeNull();
  });

  it('deletes a root with its replies after a confirm that names them, and a reply on its own', async () => {
    const mine = thread(ME, [comment(BO), comment(ME, { bodyMd: 'My reply' })]);
    client.listPageComments.mockResolvedValueOnce(list([mine, thread(BO)]));
    await mountPanel();
    // My reply first: its confirm is the plain one.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]!);
    expect(screen.getByText("Delete this comment? Comments can't be restored.")).toBeTruthy();
    client.deletePageComment.mockResolvedValueOnce(
      ok({ commentId: mine.replies[1]!.id, parentCommentId: mine.id, replyCount: 0 }),
    );
    await act(async () =>
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' })),
    );
    expect(screen.queryByText('My reply')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    // Esc closes the confirm (and only the confirm).
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    expect(
      screen.getByText("Delete this comment? Also deletes 1 reply — comments can't be restored."),
    ).toBeTruthy();
    // A refusal stays in the confirm.
    client.deletePageComment.mockResolvedValueOnce(refused(500, null));
    await act(async () =>
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' })),
    );
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(
      'Something went wrong — please try again.',
    );
    client.deletePageComment.mockResolvedValueOnce(
      ok({ commentId: mine.id, parentCommentId: null, replyCount: 1 }),
    );
    await act(async () =>
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' })),
    );
    expect(client.deletePageComment).toHaveBeenLastCalledWith('page-1', mine.id);
    expect(screen.queryByRole('article', { name: `Thread started by ${ME.name}` })).toBeNull();
    expect(switchButton('Open').textContent).toContain('1');
    expect(onOpenCountChange).toHaveBeenLastCalledWith(1);
  });
});

describe('PageDiscussionPanel — resolve and reopen', () => {
  it('moves a thread to Resolved with the resolved line, and Reopen moves it back', async () => {
    const root = thread(BO, [comment(ME)]);
    client.listPageComments
      .mockResolvedValueOnce(list([root], { counts: { open: 1, resolved: 0 } }))
      .mockResolvedValueOnce(list([], { counts: { open: 1, resolved: 0 } }));
    await mountPanel();
    // The Resolved list is read before the move, so the move lands in it.
    await act(async () => fireEvent.click(switchButton('Resolved')));
    await act(async () => fireEvent.click(switchButton('Open')));
    const resolvedAt = new Date().toISOString();
    client.resolvePageCommentThread.mockResolvedValueOnce(
      ok({ ...root, resolvedAt, resolvedBy: ME }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resolve' })));
    expect(client.resolvePageCommentThread).toHaveBeenCalledWith('page-1', root.id);
    expect(screen.getByText('No comments on this page yet')).toBeTruthy();
    expect(switchButton('Open').textContent).toContain('0');
    expect(switchButton('Resolved').textContent).toContain('1');
    expect(onOpenCountChange).toHaveBeenLastCalledWith(0);

    await act(async () => fireEvent.click(switchButton('Resolved')));
    const article = threadOf(BO.name);
    expect(within(article).getByText(/^Resolved by Ana Ruiz · /)).toBeTruthy();
    // A resolved thread reads: Reopen is its one action.
    for (const name of ['Reply', 'Edit', 'Delete']) {
      expect(within(article).queryByRole('button', { name })).toBeNull();
    }
    client.reopenPageCommentThread.mockResolvedValueOnce(ok(root));
    await act(async () => fireEvent.click(within(article).getByRole('button', { name: 'Reopen' })));
    expect(screen.getByText('No resolved threads')).toBeTruthy();
    expect(switchButton('Open').textContent).toContain('1');
    await act(async () => fireEvent.click(switchButton('Open')));
    expect(threadOf(BO.name)).toBeTruthy();
  });

  it('places a moved thread by its key, and leaves one past the loaded window to Load more', async () => {
    const older = thread(BO, [], {
      resolvedAt: new Date(Date.UTC(2026, 9, 1)).toISOString(),
      resolvedBy: BO,
    });
    const first = thread(ME);
    const second = thread(BO);
    client.listPageComments
      .mockResolvedValueOnce(list([second, first], { counts: { open: 2, resolved: 1 } }))
      .mockResolvedValueOnce(
        list([older], { nextCursor: 'cur-r', counts: { open: 2, resolved: 2 } }),
      );
    await mountPanel();
    await act(async () => fireEvent.click(switchButton('Resolved')));
    // Resolved newest first: the new resolution goes above the older one.
    client.resolvePageCommentThread.mockResolvedValueOnce(
      ok({ ...second, resolvedAt: new Date().toISOString(), resolvedBy: ME }),
    );
    await act(async () => fireEvent.click(switchButton('Open')));
    const resolveIn = (name: string) =>
      within(threadOf(name)).getByRole('button', { name: 'Resolve' });
    await act(async () => fireEvent.click(resolveIn(BO.name)));
    await act(async () => fireEvent.click(switchButton('Resolved')));
    const resolvedList = screen.getByRole('list', { name: 'Resolved threads' });
    expect(
      within(resolvedList)
        .getAllByRole('article')
        .map((a) => a.dataset.testid),
    ).toEqual([`page-thread-${second.id}`, `page-thread-${older.id}`]);
    // Reopening the OLDER one sends it to Open below the loaded newer root.
    client.reopenPageCommentThread.mockResolvedValueOnce(
      ok({ ...older, resolvedAt: null, resolvedBy: null }),
    );
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId(`page-thread-${older.id}`)).getByRole('button', {
          name: 'Reopen',
        }),
      ),
    );
    await act(async () => fireEvent.click(switchButton('Open')));
    expect(
      within(openList())
        .getAllByRole('article')
        .map((a) => a.dataset.testid),
    ).toEqual([`page-thread-${first.id}`, `page-thread-${older.id}`]);
  });

  it('leaves a thread that would land past a paged window for Load more', async () => {
    const newest = thread(BO);
    const old = thread(ME, [], {
      createdAt: new Date(Date.UTC(2020, 0, 1)).toISOString(),
      resolvedAt: new Date().toISOString(),
      resolvedBy: ME,
    });
    client.listPageComments
      .mockResolvedValueOnce(
        list([newest], { nextCursor: 'cur-o', counts: { open: 5, resolved: 1 } }),
      )
      .mockResolvedValueOnce(list([old], { counts: { open: 5, resolved: 1 } }));
    await mountPanel();
    await act(async () => fireEvent.click(switchButton('Resolved')));
    client.reopenPageCommentThread.mockResolvedValueOnce(
      ok({ ...old, resolvedAt: null, resolvedBy: null }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reopen' })));
    await act(async () => fireEvent.click(switchButton('Open')));
    expect(within(openList()).getAllByRole('article')).toHaveLength(1);
    expect(switchButton('Open').textContent).toContain('6');
  });

  it('shows Resolved {time} when the resolver is gone', async () => {
    client.listPageComments.mockResolvedValueOnce(
      list([thread(BO, [], { resolvedAt: new Date().toISOString(), resolvedBy: null })]),
    );
    await mountPanel();
    expect(screen.getByText(/^Resolved (now|in|\d)/)).toBeTruthy();
  });

  it('two quick Resolve / Reopen presses end in the state of the last press', async () => {
    const root = thread(BO);
    client.listPageComments
      .mockResolvedValueOnce(list([root]))
      .mockResolvedValueOnce(list([], { counts: { open: 1, resolved: 0 } }));
    await mountPanel();
    await act(async () => fireEvent.click(switchButton('Resolved')));
    const resolving = deferred<PageCommentResult<PageCommentThreadDto>>();
    const reopening = deferred<PageCommentResult<PageCommentThreadDto>>();
    client.resolvePageCommentThread.mockReturnValueOnce(resolving.promise);
    client.reopenPageCommentThread.mockReturnValueOnce(reopening.promise);
    await act(async () => fireEvent.click(switchButton('Open')));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    // Moved at once: the next press is Reopen, on the Resolved side.
    await act(async () => fireEvent.click(switchButton('Resolved')));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    // The Reopen waits for the Resolve, so the server sees them in press order.
    await act(async () => reopening.resolve(ok(root)));
    expect(client.reopenPageCommentThread).not.toHaveBeenCalled();
    // The resolve's answer is superseded by the later press and is dropped.
    await act(async () =>
      resolving.resolve(ok({ ...root, resolvedAt: new Date().toISOString(), resolvedBy: ME })),
    );
    expect(client.reopenPageCommentThread).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No resolved threads')).toBeTruthy();
    await act(async () => fireEvent.click(switchButton('Open')));
    expect(threadOf(BO.name)).toBeTruthy();
    expect(switchButton('Open').textContent).toContain('1');
    expect(switchButton('Resolved').textContent).toContain('0');
  });

  it('a refused Resolve puts the thread back and says why at its foot', async () => {
    client.listPageComments.mockResolvedValueOnce(list([thread(BO)]));
    await mountPanel();
    client.resolvePageCommentThread.mockResolvedValueOnce(refused(500, null));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Resolve' })));
    expect(within(threadOf(BO.name)).getByRole('alert').textContent).toBe(
      'Couldn’t resolve this thread. Try again.',
    );
    expect(switchButton('Open').textContent).toContain('1');
  });

  it('a refused Reopen puts the thread back on Resolved with its reason', async () => {
    client.listPageComments
      .mockResolvedValueOnce(list([], { counts: { open: 0, resolved: 1 } }))
      .mockResolvedValueOnce(
        list([thread(BO, [], { resolvedAt: new Date().toISOString(), resolvedBy: BO })], {
          counts: { open: 0, resolved: 1 },
        }),
      );
    await mountPanel();
    await act(async () => fireEvent.click(switchButton('Resolved')));
    client.reopenPageCommentThread.mockResolvedValueOnce(refused(409, 'PAGE_ARCHIVED'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reopen' })));
    expect(within(threadOf(BO.name)).getByRole('alert').textContent).toBe(
      'This page was archived, so its discussion is now read-only.',
    );
    client.reopenPageCommentThread.mockResolvedValueOnce(refused(404, 'PAGE_COMMENT_NOT_FOUND'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reopen' })));
    expect(within(threadOf(BO.name)).getByRole('alert').textContent).toBe(
      'This comment no longer exists.',
    );
  });
});

// ── Work-item links (bug MOTIR-10023's rule) ─────────────────────────────────

const LINKED: WorkItemRefSummaryDto = {
  accessible: true,
  id: 'wi_live',
  identifier: 'MOTIR-706',
  title: 'The seed registry',
  kind: 'subtask',
  archived: false,
  status: { key: 'done', label: 'Done', category: 'done' },
  type: null,
  assignee: null,
};
const LATER: WorkItemRefSummaryDto = { ...LINKED, id: 'wi_later', identifier: 'MOTIR-707' };
const REFS: WorkItemRefMap = { wi_live: LINKED };

function chipFor(root: HTMLElement, key: string): Element {
  const chip = Array.from(root.querySelectorAll('.wi-chip')).find((el) =>
    el.querySelector('.wi-key')?.textContent?.includes(key),
  );
  expect(chip, `a chip for ${key}`).toBeTruthy();
  return chip!;
}

describe('PageDiscussionPanel — work-item links', () => {
  it('draws a linked card from the list read in a root and a reply, and a missing one as deleted', async () => {
    const reply = comment(BO, { bodyMd: 'Same as [MOTIR-706](motir:wi_live).' });
    const root = thread(ME, [reply], {
      bodyMd: 'See [MOTIR-706](motir:wi_live) and [MOTIR-1](motir:wi_gone).',
    });
    client.listPageComments.mockResolvedValueOnce(list([root], { workItemRefs: REFS }));
    await mountPanel();
    const item = within(openList()).getAllByRole('listitem')[0]!;
    const rootChip = chipFor(screen.getByTestId(`page-comment-${root.id}`), 'MOTIR-706');
    expect(rootChip.classList.contains('is-deleted')).toBe(false);
    expect(rootChip.textContent).toContain('The seed registry');
    expect(chipFor(item, 'MOTIR-1').classList.contains('is-deleted')).toBe(true);
    const replyChip = chipFor(screen.getByTestId(`page-comment-${reply.id}`), 'MOTIR-706');
    expect(replyChip.classList.contains('is-deleted')).toBe(false);
  });

  it('keeps the links a Load more resolved beside those of the first read', async () => {
    const a = thread(ME, [], { bodyMd: 'First [MOTIR-706](motir:wi_live).' });
    const b = thread(BO, [], { bodyMd: 'Later [MOTIR-707](motir:wi_later).' });
    client.listPageComments.mockResolvedValueOnce(
      list([a], { nextCursor: 'cur-1', counts: { open: 2, resolved: 0 }, workItemRefs: REFS }),
    );
    await mountPanel();
    client.listPageComments.mockResolvedValueOnce(
      list([b], { counts: { open: 2, resolved: 0 }, workItemRefs: { wi_later: LATER } }),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Load more threads' })),
    );
    for (const [id, key] of [
      [a.id, 'MOTIR-706'],
      [b.id, 'MOTIR-707'],
    ] as const) {
      const chip = chipFor(screen.getByTestId(`page-comment-${id}`), key);
      expect(chip.classList.contains('is-deleted')).toBe(false);
    }
  });

  it('draws a card a new comment links from the write answer, and keeps a Load more window', async () => {
    const known = thread(ME, [], { bodyMd: 'As [MOTIR-706](motir:wi_live) says.' });
    const older = thread(BO, [], { bodyMd: 'Older.' });
    client.listPageComments.mockResolvedValueOnce(
      list([known], { nextCursor: 'cur-1', counts: { open: 3, resolved: 0 }, workItemRefs: REFS }),
    );
    await mountPanel();
    client.listPageComments.mockResolvedValueOnce(
      list([older], { nextCursor: 'cur-2', counts: { open: 3, resolved: 0 } }),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Load more threads' })),
    );
    expect(client.listPageComments).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Add a comment…' }));
    const box = screen.getByRole('textbox', { name: 'Comment on this page' });
    const fresh = thread(ME, [], { bodyMd: 'Blocked by [MOTIR-707](motir:wi_later).' });
    fireEvent.change(box, { target: { value: fresh.bodyMd } });
    client.createPageComment.mockResolvedValueOnce(
      ok({ ...fresh, workItemRefs: { wi_later: LATER } }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Comment' })));

    // No list is read again: the thread Load more brought in, and its cursor, stay.
    expect(client.listPageComments).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId(`page-comment-${older.id}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more threads' })).toBeTruthy();
    for (const [id, key] of [
      [fresh.id, 'MOTIR-707'],
      [known.id, 'MOTIR-706'],
    ] as const) {
      const chip = chipFor(screen.getByTestId(`page-comment-${id}`), key);
      expect(chip.classList.contains('is-deleted')).toBe(false);
    }
  });

  it('draws the cards a reply and an edit link from their own answers', async () => {
    const root = thread(BO);
    client.listPageComments.mockResolvedValueOnce(list([root]));
    await mountPanel();
    const row = screen.getByTestId(`page-thread-${root.id}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Reply' }));
    const box = within(row).getByRole('textbox', { name: 'Write a reply' });
    const reply = comment(ME, {
      parentCommentId: root.id,
      bodyMd: 'Tracked in [MOTIR-706](motir:wi_live).',
    });
    fireEvent.change(box, { target: { value: reply.bodyMd } });
    client.replyToPageComment.mockResolvedValueOnce(ok({ ...reply, workItemRefs: REFS }));
    const submit = within(row).getAllByRole('button', { name: 'Reply' });
    await act(async () => fireEvent.click(submit[submit.length - 1]!));
    expect(
      chipFor(screen.getByTestId(`page-comment-${reply.id}`), 'MOTIR-706').classList.contains(
        'is-deleted',
      ),
    ).toBe(false);

    const mine = screen.getByTestId(`page-comment-${reply.id}`);
    fireEvent.click(within(mine).getByRole('button', { name: 'Edit' }));
    const edit = within(mine).getByRole('textbox', { name: 'Edit comment' });
    const edited = {
      ...reply,
      bodyMd: 'Now [MOTIR-707](motir:wi_later).',
      editedAt: reply.createdAt,
    };
    fireEvent.change(edit, { target: { value: edited.bodyMd } });
    client.editPageComment.mockResolvedValueOnce(
      ok({ ...edited, workItemRefs: { wi_later: LATER } }),
    );
    await act(async () => fireEvent.click(within(mine).getByRole('button', { name: 'Save' })));
    expect(
      chipFor(screen.getByTestId(`page-comment-${reply.id}`), 'MOTIR-707').classList.contains(
        'is-deleted',
      ),
    ).toBe(false);
    // Neither write read a list again.
    expect(client.listPageComments).toHaveBeenCalledTimes(1);
  });
});

describe('PageDiscussionPanel — Load more', () => {
  it('reads the next page by cursor, appends it without repeats, and goes at the end', async () => {
    const a = thread(BO);
    const b = thread(ME);
    const c = thread(BO);
    client.listPageComments.mockResolvedValueOnce(
      list([a, b], { nextCursor: 'cur-1', counts: { open: 3, resolved: 0 } }),
    );
    await mountPanel();
    const more = deferred<PageCommentResult<PageDiscussionList>>();
    client.listPageComments.mockReturnValueOnce(more.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Load more threads' }));
    expect(client.listPageComments).toHaveBeenLastCalledWith('page-1', {
      status: 'open',
      order: 'desc',
      cursor: 'cur-1',
    });
    expect(screen.getByRole('button', { name: /Loading…/ })).toBeTruthy();
    // A failed page keeps the threads shown, with a retry.
    await act(async () => more.resolve(refused(500, null)));
    expect(screen.getByText('Couldn’t load more threads.')).toBeTruthy();
    expect(within(openList()).getAllByRole('article')).toHaveLength(2);
    client.listPageComments.mockResolvedValueOnce(
      list([b, c], { nextCursor: null, counts: { open: 3, resolved: 0 } }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(within(openList()).getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more threads' })).toBeNull();
  });

  it('drops a Load more answer that a re-read replaced', async () => {
    client.listPageComments.mockResolvedValueOnce(list([thread(BO)], { nextCursor: 'cur-1' }));
    const panel = await mountPanel();
    const more = deferred<PageCommentResult<PageDiscussionList>>();
    client.listPageComments.mockReturnValueOnce(more.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Load more threads' }));
    panel.unmount();
    // After unmount nothing is applied (and nothing throws).
    await act(async () => more.resolve(list([thread(ME)])));
  });
});

describe('PageDiscussionPanel — closing', () => {
  it('closes by the close button, Esc and the scrim, but not by an Esc inside a composer', async () => {
    client.listPageComments.mockResolvedValueOnce(list([]));
    await mountPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Close discussion' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('page-discussion-scrim'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole('button', { name: 'Add a comment…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment on this page' }), {
      target: { value: 'draft' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Comment on this page' }), {
      key: 'Escape',
    });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(4);
  });
});

describe('PageView — the Discussion control', () => {
  async function mountView(openThreadCount = 0) {
    client.listPageComments.mockResolvedValue(list([]));
    render(
      <Suspense fallback={<p>frame</p>}>
        <PageView
          page={{ id: 'page-1', title: 'Plan', bodyState: 'AAA=', canEdit: false }}
          viewerId={ME.id}
          viewerName={ME.name}
          mentionCandidates={CANDIDATES}
          openThreadCount={openThreadCount}
          titleMaxLength={255}
        />
      </Suspense>,
    );
    await screen.findByTestId('editor-stub');
  }
  const control = () => screen.getByRole('button', { name: /^Discussion/ });

  it('shows the open count in its chip and accessible name, and none at zero', async () => {
    await mountView(3);
    expect(control().getAttribute('aria-label')).toBe('Discussion, 3 open threads');
    expect(screen.getByTestId('page-discussion-count').textContent).toBe('3');
    cleanup();
    await mountView(0);
    expect(control().getAttribute('aria-label')).toBeNull();
    expect(screen.queryByTestId('page-discussion-count')).toBeNull();
  });

  it('opens and closes the panel, and only one right-hand panel is open at a time', async () => {
    await mountView(1);
    expect(control().getAttribute('aria-controls')).toBe('page-discussion');
    expect(control().getAttribute('aria-expanded')).toBe('false');
    await act(async () => fireEvent.click(control()));
    expect(control().getAttribute('aria-expanded')).toBe('true');
    expect(control().className).toContain('bg-(--el-surface)');
    expect(document.getElementById('page-discussion')).toBeTruthy();
    // The panel's read moves the chip.
    await waitFor(() => expect(screen.queryByTestId('page-discussion-count')).toBeNull());

    // History closes Discussion …
    const history = screen.getByRole('button', { name: 'History' });
    await act(async () => fireEvent.click(history));
    expect(document.getElementById('page-discussion')).toBeNull();
    expect(document.getElementById('page-history')).toBeTruthy();
    // … and Discussion closes History.
    await act(async () => fireEvent.click(control()));
    expect(document.getElementById('page-history')).toBeNull();
    expect(document.getElementById('page-discussion')).toBeTruthy();

    // Pressing it again closes it, and focus returns to it.
    await act(async () => fireEvent.click(control()));
    expect(document.getElementById('page-discussion')).toBeNull();
    expect(document.activeElement).toBe(control());
    // So does Esc.
    await act(async () => fireEvent.click(control()));
    await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }));
    expect(document.getElementById('page-discussion')).toBeNull();
  });

  it('hands the live editor the anchored roots and keeps them in step with the panel (MOTIR-10901)', async () => {
    const seeded = comment(BO, { anchor: { bytes: 'AQID', quote: 'the rollout plan' } });
    const other = comment(ME, { anchor: { bytes: 'AQIE', quote: 'the budget' } });
    const posted = thread(ME, [], { anchor: { bytes: 'AQIF', quote: 'a new passage' } });
    const pageLevel = thread(BO);
    host.props = null;
    render(
      <Suspense fallback={<p>frame</p>}>
        <PageView
          page={{ id: 'page-1', title: 'Plan', bodyState: 'AAA=', canEdit: false }}
          viewerId={ME.id}
          viewerName={ME.name}
          mentionCandidates={CANDIDATES}
          openThreadCount={2}
          inlineThreads={[seeded, other]}
          titleMaxLength={255}
        />
      </Suspense>,
    );
    await screen.findByTestId('editor-stub');
    expect(host.props!.inlineThreads!.map((t) => t.id)).toEqual([seeded.id, other.id]);

    // The editor answers: the first passage is gone, the second present.
    await act(async () =>
      host.props!.onInlineAnchorsResolved!({ [seeded.id]: null, [other.id]: { from: 1, to: 4 } }),
    );
    const seededThread = { ...seeded, replies: [] };
    const otherThread = { ...other, replies: [] };
    client.listPageComments.mockResolvedValue(
      list([seededThread, otherThread, posted, pageLevel], { counts: { open: 4, resolved: 0 } }),
    );
    await act(async () => fireEvent.click(control()));
    expect(
      within(screen.getByTestId(`page-thread-${seeded.id}`)).getByTestId('page-thread-gone-note'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId(`page-thread-${other.id}`)).queryByTestId('page-thread-gone-note'),
    ).toBeNull();

    // Resolving hands the editor the route's resolved timestamp.
    const resolvedAt = new Date().toISOString();
    client.resolvePageCommentThread.mockResolvedValueOnce(
      ok({ ...otherThread, resolvedAt, resolvedBy: ME }),
    );
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId(`page-thread-${other.id}`)).getByRole('button', {
          name: 'Resolve',
        }),
      ),
    );
    expect(host.props!.inlineThreads!.find((t) => t.id === other.id)!.resolvedAt).toBe(resolvedAt);

    // A root the page's read did not carry is added; a page-level one is not.
    client.resolvePageCommentThread.mockResolvedValueOnce(
      ok({ ...posted, resolvedAt, resolvedBy: ME }),
    );
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId(`page-thread-${posted.id}`)).getByRole('button', {
          name: 'Resolve',
        }),
      ),
    );
    client.resolvePageCommentThread.mockResolvedValueOnce(
      ok({ ...pageLevel, resolvedAt, resolvedBy: ME }),
    );
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId(`page-thread-${pageLevel.id}`)).getByRole('button', {
          name: 'Resolve',
        }),
      ),
    );
    expect(host.props!.inlineThreads!.map((t) => t.id)).toEqual([seeded.id, other.id, posted.id]);

    // Reopening clears it again.
    client.listPageComments.mockResolvedValueOnce(
      list([{ ...otherThread, resolvedAt, resolvedBy: ME }], { counts: { open: 2, resolved: 1 } }),
    );
    await act(async () => fireEvent.click(switchButton('Resolved')));
    client.reopenPageCommentThread.mockResolvedValueOnce(ok(otherThread));
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId(`page-thread-${other.id}`)).getByRole('button', {
          name: 'Reopen',
        }),
      ),
    );
    expect(host.props!.inlineThreads!.find((t) => t.id === other.id)!.resolvedAt).toBeNull();
    // Nothing here read the list again for any of it.
    expect(client.listPageComments).toHaveBeenCalledTimes(2);
  });

  it('hands an archived page no roster and the archive line', async () => {
    client.listPageComments.mockResolvedValue(
      list([], { capabilities: { canComment: false, canModerate: true } }),
    );
    render(
      <Suspense fallback={<p>frame</p>}>
        <PageView
          page={{
            id: 'page-1',
            title: 'Plan',
            bodyState: 'AAA=',
            canEdit: false,
            archived: {
              archivedAt: new Date().toISOString(),
              archivedBy: null,
              archiveRoot: null,
              canRestore: false,
              canDelete: false,
              subPageCount: 0,
            },
          }}
          viewerId={ME.id}
          viewerName={ME.name}
          mentionCandidates={CANDIDATES}
          titleMaxLength={255}
        />
      </Suspense>,
    );
    await screen.findByTestId('editor-stub');
    await act(async () => fireEvent.click(control()));
    expect(
      await screen.findByText('This page is archived, so its discussion is read-only.'),
    ).toBeTruthy();
  });
});

describe('PageView — comment on a passage (MOTIR-10900)', () => {
  const PASSAGE = { bytes: 'AQIG', quote: 'the launch date' };

  function mountView(over: { mayComment?: boolean; archived?: boolean; openThreadCount?: number }) {
    client.listPageComments.mockResolvedValue(list([]));
    host.props = null;
    render(
      <Suspense fallback={<p>frame</p>}>
        <PageView
          page={{
            id: 'page-1',
            title: 'Plan',
            bodyState: 'AAA=',
            canEdit: false,
            ...(over.archived
              ? {
                  archived: {
                    archivedAt: '2026-11-10T10:00:00.000Z',
                    archivedBy: null,
                    archiveRoot: null,
                    canRestore: false,
                    canDelete: false,
                    subPageCount: 0,
                  },
                }
              : {}),
          }}
          viewerId={ME.id}
          viewerName={ME.name}
          mentionCandidates={CANDIDATES}
          mayComment={over.mayComment}
          openThreadCount={over.openThreadCount ?? 0}
          titleMaxLength={255}
        />
      </Suspense>,
    );
    return screen.findByTestId('editor-stub');
  }
  const submit = (bodyMd = 'When is it?') =>
    act(() => host.props!.passageComment!.onSubmit(PASSAGE, bodyMd));

  it('hands the editor no passage capability without comment:add, or on an archived page', async () => {
    await mountView({});
    expect(host.props!.passageComment).toBeUndefined();
    cleanup();
    await mountView({ mayComment: true, archived: true });
    expect(host.props!.passageComment).toBeUndefined();
  });

  it('posts with the anchor, washes the new root and counts it while the panel is closed', async () => {
    await mountView({ mayComment: true, openThreadCount: 1 });
    expect(host.props!.passageComment!.mentionCandidates).toBe(CANDIDATES);
    const posted = thread(ME, [], { anchor: PASSAGE });
    client.createPageComment.mockResolvedValueOnce(ok({ ...posted, workItemRefs: {} }));
    expect(await submit()).toBeNull();
    expect(client.createPageComment).toHaveBeenCalledWith('page-1', 'When is it?', PASSAGE);
    expect(host.props!.inlineThreads!.map((t) => t.id)).toEqual([posted.id]);
    expect(screen.getByTestId('page-discussion-count').textContent).toBe('2');
  });

  it('puts the new thread on top of an open panel’s Open list, counted once', async () => {
    await mountView({ mayComment: true });
    const older = thread(BO);
    client.listPageComments.mockResolvedValue(list([older], { counts: { open: 1, resolved: 0 } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Discussion/ })));
    await screen.findByTestId(`page-thread-${older.id}`);
    const posted = thread(ME, [], { anchor: PASSAGE });
    client.createPageComment.mockResolvedValueOnce(ok({ ...posted, workItemRefs: {} }));
    expect(await submit()).toBeNull();
    const items = within(screen.getByRole('list', { name: /open/i })).getAllByRole('listitem');
    expect(within(items[0]!).getByTestId(`page-thread-${posted.id}`)).toBeTruthy();
    expect(items).toHaveLength(2);
    expect(screen.getByTestId('page-discussion-count').textContent).toBe('2');
  });

  it('answers each refusal with the composer’s own line and changes nothing', async () => {
    await mountView({ mayComment: true });
    const cases: [ReturnType<typeof refused>, string][] = [
      [
        refused(400, 'PAGE_COMMENT_ANCHOR_INVALID'),
        'This passage can no longer be anchored. Select it again and comment.',
      ],
      [
        refused(400, 'BAD_REQUEST'),
        'This passage can no longer be anchored. Select it again and comment.',
      ],
      [
        refused(409, 'PAGE_ARCHIVED'),
        'This page was archived, so its discussion is now read-only.',
      ],
      [refused(400, 'PAGE_COMMENT_BODY_EMPTY'), "A comment can't be empty."],
      [refused(403, null), "You don't have permission to do that."],
      [
        refused(0, 'NETWORK'),
        'Couldn’t post your comment. Your text is still here, so you can try again.',
      ],
    ];
    for (const [refusal, line] of cases) {
      client.createPageComment.mockResolvedValueOnce(refusal);
      expect(await submit()).toBe(line);
    }
    expect(host.props!.inlineThreads).toEqual([]);
    expect(screen.queryByTestId('page-discussion-count')).toBeNull();
  });
});
