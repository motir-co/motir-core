// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import {
  PageEditorHost,
  openWorkItemPeek,
  renderPageWorkItemChip,
  toInlineThreadViews,
} from '@/components/pages/PageEditorHost';
import {
  anchorFromSelection,
  applyUpdate,
  emptyState,
  markdownToUpdate,
  type PageCommentDto,
} from '@/lib/pages';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// The page editor host's MENTION binding (Story MOTIR-5747 · MOTIR-7574): the
// real `<PageEditor>` behind the real host, under the real en catalogue, with
// only `fetch` stubbed. It holds what the host owes the package — the search
// narrowed to the page's project, `PageDto.workItemRefs` as the chips' data, the
// shipped `motir:` chip and `MentionList` row as the renderers, and the copy.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/pages/page-1',
}));

/** A page body mentioning three items, as the editor stores it (id only). */
function bodyState(markdown: string): string {
  const empty = emptyState();
  return Buffer.from(applyUpdate(empty, markdownToUpdate(empty, markdown))).toString('base64');
}
const BODY = bodyState('See [](motir:ckLive), [](motir:ckOld) and [](motir:ckHidden).\n');

const REFS: WorkItemRefMap = {
  ckLive: {
    accessible: true,
    id: 'ckLive',
    identifier: 'MOTIR-1188',
    title: 'Page export to Markdown',
    kind: 'task',
    archived: false,
    status: { key: 'done', label: 'Done', category: 'done' },
    type: null,
    assignee: null,
  },
  ckOld: {
    accessible: true,
    id: 'ckOld',
    identifier: 'MOTIR-919',
    title: 'Old outline approach',
    kind: 'task',
    archived: true,
    status: null,
    type: null,
    assignee: null,
  },
  ckHidden: { accessible: false, id: 'ckHidden' },
};

const ROW = {
  id: 'ck805',
  parentId: null,
  kind: 'story',
  key: 805,
  identifier: 'MOTIR-805',
  title: 'Issue-tree generation',
  status: 'in_progress',
  priority: 'medium',
  assigneeId: null,
  position: 'a0',
  estimateMinutes: null,
  storyPoints: null,
  obsolescence: null,
  obsolescenceNoteMd: null,
  archivedAt: null,
};

const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function mount(
  props: Partial<Parameters<typeof PageEditorHost>[0]> = {},
  messages?: Record<string, unknown>,
) {
  const utils = renderWithIntl(
    <PageEditorHost
      pageId="page-1"
      bodyState={BODY}
      canEdit
      projectId="proj-1"
      workItemRefs={REFS}
      {...props}
    />,
    messages ? { locale: 'zh', messages } : {},
  );
  const surface = await screen.findByRole('textbox');
  await act(async () => {});
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  return { ...utils, surface, editor };
}

/** Type `text` at the end of the first paragraph and let the suggestion open. */
async function type(editor: Editor, text: string) {
  act(() => {
    editor
      .chain()
      .focus()
      .setTextSelection(editor.state.doc.child(0).nodeSize - 1)
      .insertContent(text)
      .run();
  });
  await act(async () => {});
}

/** Wait out the picker's debounce and the answer. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/pages/page-1');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the chips read PageDto.workItemRefs', () => {
  it('draws the shipped chip for a live and an archived item, and hides a no-access one', async () => {
    const { surface } = await mount({ canEdit: false });
    const live = surface.querySelector('[data-work-item-id="ckLive"] a.wi-chip')!;
    expect(live.getAttribute('href')).toBe('/items/MOTIR-1188');
    expect(live.textContent).toBe('MOTIR-1188Page export to Markdown');
    expect(live.querySelector('.wi-dot.s-done')).not.toBeNull();
    expect(
      surface.querySelector('[data-work-item-id="ckOld"] .wi-chip.is-archived'),
    ).not.toBeNull();
    const hidden = surface.querySelector('[data-work-item-id="ckHidden"]')!;
    expect(hidden.textContent).toBe('Unavailable work item');
    expect(hidden.textContent).not.toContain('MOTIR');
    expect(hidden.querySelector('.wi-chip')!.getAttribute('title')).toBe(
      'This work item was deleted, or you can’t see it.',
    );
  });

  it('draws every chip unavailable when no refs are passed', async () => {
    const { surface } = await mount({ canEdit: false, workItemRefs: undefined });
    expect(surface.querySelectorAll('.wi-chip.is-unavailable')).toHaveLength(3);
  });

  it('opens the peek for a click the chip itself did not take', async () => {
    const { surface } = await mount({ canEdit: false });
    // The shipped chip opens the peek itself.
    fireEvent.click(surface.querySelector('[data-work-item-id="ckLive"] a.wi-chip')!);
    expect(window.location.search).toBe('?peek=MOTIR-1188');
    window.history.replaceState(null, '', '/pages/page-1?view=x');
    // A click on the chip's frame, outside the link, opens it through the host.
    fireEvent.click(surface.querySelector('[data-work-item-id="ckLive"]')!);
    expect(window.location.search).toBe('?view=x&peek=MOTIR-1188');
  });

  it('writes the peek param over whatever is there', () => {
    window.history.replaceState(null, '', '/pages/page-1?peek=OLD-1');
    openWorkItemPeek('MOTIR-2');
    expect(window.location.search).toBe('?peek=MOTIR-2');
  });

  it('titles a chip with its title alone when it has no status', () => {
    const chip = renderPageWorkItemChip({
      accessible: true,
      id: 'ck1',
      identifier: 'MOTIR-1',
      title: 'No status',
      kind: 'task',
      archived: false,
      status: null,
      type: null,
      assignee: null,
    });
    expect((chip as { props: { content: string } }).props.content).toBe('No status');
    const withStatus = renderPageWorkItemChip({
      accessible: true,
      id: 'ck2',
      identifier: 'MOTIR-2',
      title: 'Has status',
      kind: 'task',
      archived: false,
      status: { label: 'To Do', category: 'todo' },
      type: null,
      assignee: null,
    });
    expect((withStatus as { props: { content: string } }).props.content).toBe('Has status · To Do');
  });
});

describe('the picker searches the page’s project', () => {
  it('passes projectId to the mention search and draws MentionList’s row', async () => {
    const { editor } = await mount();
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json([ROW]));
    await type(editor, ' @is');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      '/api/work-items/mention-search?q=is&projectId=proj-1',
    );
    const picker = screen.getByRole('listbox', { name: 'Mention a work item' });
    const option = within(picker).getByRole('option');
    expect(option.textContent).toContain('MOTIR-805');
    expect(option.textContent).toContain('Issue-tree generation');
    expect(option.textContent).toContain('In Progress');

    fireEvent.mouseDown(option);
    await act(async () => {});
    // The chip inserted this session draws from the picked row, with its status dot.
    const inserted = document.querySelector('[data-work-item-id="ck805"] a.wi-chip')!;
    expect(inserted.textContent).toBe('MOTIR-805Issue-tree generation');
    expect(inserted.querySelector('.wi-dot.s-inprogress')).not.toBeNull();
  });

  it('says the search failed when the route refuses it, and retries', async () => {
    const { editor } = await mount();
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json({ code: 'INTERNAL' }, 500));
    await type(editor, ' @is');
    await settle();
    const picker = screen.getByRole('listbox', { name: 'Mention a work item' });
    expect(within(picker).getByRole('alert').textContent).toBe('Couldn’t search work items.');
    fetchMock.mockResolvedValueOnce(json([]));
    fireEvent.mouseDown(within(picker).getByRole('option', { name: 'Try again' }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('No work items match “is”.')).toBeTruthy();
  });

  it('offers the toolbar door, in zh too', async () => {
    await mount({}, zhMessages);
    const button = screen.getByRole('button', { name: '提及工作项' });
    expect(button.textContent).toBe('工作项');
    expect(button.getAttribute('title')).toBe('提及工作项 — 或在正文中输入 @');
  });

  it('offers no door without a project, and none on a read-only page', async () => {
    await mount({ projectId: undefined });
    expect(screen.queryByRole('button', { name: 'Mention a work item' })).toBeNull();
    cleanup();
    await mount({ canEdit: false });
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});

describe('the passage wash (MOTIR-10899)', () => {
  const state = Buffer.from(BODY, 'base64');
  // "See" — the first three characters of the first paragraph.
  const anchor = anchorFromSelection(new Uint8Array(state), 1, 4)!;
  const root = (over: Partial<PageCommentDto> = {}): PageCommentDto => ({
    id: 'root-1',
    pageId: 'page-1',
    parentCommentId: null,
    author: { id: 'u1', name: 'Ann Lee', image: null },
    bodyMd: 'About this',
    editedAt: null,
    createdAt: '2026-11-10T10:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    anchor: { bytes: Buffer.from(anchor.bytes).toString('base64'), quote: anchor.quote },
    ...over,
  });

  it('maps every anchored root to the editor’s view, decoding the bytes, and drops page-level ones', () => {
    const resolvedAt = '2026-11-10T11:00:00.000Z';
    expect(
      toInlineThreadViews([
        root(),
        root({ id: 'page-level', anchor: null }),
        root({ id: 'r2', resolvedAt }),
      ]),
    ).toEqual([
      { id: 'root-1', anchor: anchor.bytes, quote: 'See', authorName: 'Ann Lee', resolvedAt: null },
      { id: 'r2', anchor: anchor.bytes, quote: 'See', authorName: 'Ann Lee', resolvedAt },
    ]);
  });

  it('washes the passage in the live editor, reports its verdict and names the author in the tooltip', async () => {
    const verdicts: unknown[] = [];
    const onClick = vi.fn();
    const { surface } = await mount({
      inlineThreads: [root()],
      onInlineAnchorsResolved: (v) => verdicts.push(v),
      onInlineThreadClick: onClick,
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const wash = surface.querySelector<HTMLElement>('[data-wash-ids]')!;
    expect(wash.textContent).toBe('See');
    expect(verdicts.at(-1)).toEqual({ 'root-1': { from: 1, to: 4 } });
    act(() => {
      fireEvent.mouseOver(wash);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('Comment by Ann Lee');
    fireEvent.click(wash);
    expect(onClick).toHaveBeenCalledWith('root-1');
  });

  it('draws no wash where the host is given no inline roots', async () => {
    const { surface } = await mount({ canEdit: false });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(surface.querySelector('[data-wash-ids]')).toBeNull();
  });
});

describe('comment on a passage (MOTIR-10900)', () => {
  const frames = () =>
    act(async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((r) => requestAnimationFrame(() => r(null)));
    });

  /** Select "See" — the first three characters of the body — as a reader's drag would. */
  async function selectSee(surface: HTMLElement) {
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent ?? '').startsWith('See')) node = walker.nextNode();
    document.getSelection()!.setBaseAndExtent(node!, 0, node!, 3);
    document.dispatchEvent(new Event('selectionchange'));
    await frames();
  }

  afterEach(() => document.getSelection()?.removeAllRanges());

  it('offers no action without the capability', async () => {
    const { surface } = await mount({ canEdit: false });
    await selectSee(surface);
    expect(screen.queryByRole('button', { name: 'Comment on the selected text' })).toBeNull();
  });

  it('opens the shipped composer on the passage, posts with its anchor and closes on success', async () => {
    const onSubmit = vi
      .fn<(anchor: { bytes: string; quote: string }, bodyMd: string) => Promise<string | null>>()
      .mockResolvedValueOnce('This passage can no longer be anchored. Select it again and comment.')
      .mockResolvedValueOnce(null);
    const { surface } = await mount({
      canEdit: false,
      passageComment: { mentionCandidates: [], onSubmit },
    });
    await selectSee(surface);
    const action = screen.getByRole('button', { name: 'Comment on the selected text' });
    expect(action.textContent).toBe('Comment');
    fireEvent.click(action);
    await frames();
    const group = screen.getByRole('group', { name: 'Comment on this passage' });
    expect(within(group).getByTestId('passage-composer-quote').textContent).toBe('See');
    expect(within(group).getByRole('button', { name: 'Close' })).toBeTruthy();
    const field = await within(group).findByRole('textbox', { name: 'Comment on this passage' });
    await act(async () => {
      (field as HTMLElement & { editor: Editor }).editor.commands.insertContent('Why this word?');
    });
    const submit = within(group).getByRole('button', { name: 'Comment' });
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [anchor, bodyMd] = onSubmit.mock.calls[0]!;
    expect(anchor.quote).toBe('See');
    expect(bodyMd).toBe('Why this word?');
    const state = new Uint8Array(Buffer.from(BODY, 'base64'));
    expect(anchor.bytes).toBe(
      Buffer.from(anchorFromSelection(state, 1, 4)!.bytes).toString('base64'),
    );
    // A refusal keeps the composer open with its line.
    expect(within(group).getByRole('alert').textContent).toContain('can no longer be anchored');
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(screen.queryByRole('group', { name: 'Comment on this passage' })).toBeNull();
  });

  it('closes on Cancel without posting', async () => {
    const onSubmit = vi.fn();
    const { surface } = await mount({ passageComment: { mentionCandidates: [], onSubmit } });
    await selectSee(surface);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on the selected text' }));
    await frames();
    const group = screen.getByRole('group', { name: 'Comment on this passage' });
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Comment on this passage' })).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
