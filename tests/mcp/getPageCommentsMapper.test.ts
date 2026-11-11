import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  PageCommentCursorInvalidError,
  PageNotFoundError,
  anchorDocument,
  anchorFromSelection,
  applyUpdate,
  emptyState,
  markdownToUpdate,
  type PageCommentDto,
  type PageCommentThreadDto,
} from '@/lib/pages';
import { fromBase64, toBase64 } from '@/lib/mappers/pageMappers';

// `get_page_comments` (MOTIR-10978) — the FIXTURE-ONLY spec: the anchored
// verdict's three cases and the id-bearing text render, over built DTOs and a
// page document encoded from a fixture. No database and no request: the two
// services and the project lookup are stubbed, so the adapter's own wiring (two
// lists, two cursors, one body read only when a root has a passage) is pinned
// here too. The DB-backed seam is the integration gate's.

const svc = vi.hoisted(() => ({
  listPageThreads: vi.fn(),
  getPage: vi.fn(),
  getByKey: vi.fn(),
}));
vi.mock('@/lib/services/pageCommentsService', () => ({
  pageCommentsService: { listPageThreads: svc.listPageThreads },
}));
vi.mock('@/lib/services/pagesService', () => ({ pagesService: { getPage: svc.getPage } }));
vi.mock('@/lib/services/projectsService', () => ({ projectsService: { getByKey: svc.getByKey } }));

const {
  GET_PAGE_COMMENTS_TOOL_NAME,
  anchoredVerdict,
  registerGetPageComments,
  renderPageCommentText,
  renderPageCommentsText,
  runGetPageComments,
  toPageCommentThreadView,
  toPageCommentView,
} = await import('@/lib/mcp/tools/getPageComments');

// ── Fixtures ────────────────────────────────────────────────────────────────

const PASSAGE = 'Brave new world.';
const BODY = `An opening line.\n\nBefore the passage. ${PASSAGE} After it.`;
const BODY_WITHOUT_PASSAGE = 'An opening line.\n\nBefore the passage.  After it.';

/** A stored `bodyState` made the way `create_page` makes one: markdown onto an empty state. */
function stateOf(markdown: string): Uint8Array {
  const empty = emptyState();
  return applyUpdate(empty, markdownToUpdate(empty, markdown));
}

/** The state after a save that rewrites the body to `markdown` (the `update_page` path). */
const saved = (state: Uint8Array, markdown: string) =>
  applyUpdate(state, markdownToUpdate(state, markdown));

function rangeOf(doc: ProseMirrorNode, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text!.indexOf(needle);
    if (at >= 0) found = { from: pos + at, to: pos + at + needle.length };
    return false;
  });
  if (!found) throw new Error(`"${needle}" is not in the page`);
  return found;
}

/** A page body holding the passage, and the anchor a reader's selection of it makes. */
function anchoredPage() {
  const state = stateOf(BODY);
  const d = anchorDocument(state);
  const { from, to } = rangeOf(d.doc, PASSAGE);
  const selection = anchorFromSelection(d, from, to);
  expect(selection).not.toBeNull();
  return { state, selection: selection! };
}

const ada = { id: 'usr_ada', name: 'Ada', image: null };
const grace = { id: 'usr_grace', name: 'Grace', image: 'https://img/grace.png' };

function comment(over: Partial<PageCommentDto> = {}): PageCommentDto {
  return {
    id: 'cmt_root',
    pageId: 'pg_1',
    parentCommentId: null,
    author: ada,
    bodyMd: 'Is this right, @[Grace](user:usr_grace)? See motir:cmwork123.',
    editedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    anchor: null,
    ...over,
  };
}

function thread(
  over: Partial<PageCommentDto> = {},
  replies: PageCommentDto[] = [],
): PageCommentThreadDto {
  return { ...comment(over), replies };
}

const reply = comment({
  id: 'cmt_reply',
  parentCommentId: 'cmt_root',
  author: grace,
  bodyMd: 'Yes — checked.',
  createdAt: '2026-11-01T11:00:00.000Z',
});

// ── The anchored verdict ────────────────────────────────────────────────────

describe('the anchored verdict — resolved against the page’s current stored body', () => {
  it('a passage still in the page answers anchored true, with its quote', () => {
    const { state, selection } = anchoredPage();
    const root = thread({ anchor: { bytes: toBase64(selection.bytes), quote: selection.quote } });

    const view = toPageCommentThreadView(root, anchorDocument(state));

    expect(selection.quote).toBe(PASSAGE);
    expect(view.quote).toBe(PASSAGE);
    expect(view.anchored).toBe(true);
  });

  it('once the passage is deleted and saved, the SAME root keeps its quote and answers false', () => {
    const { state, selection } = anchoredPage();
    const root = thread({ anchor: { bytes: toBase64(selection.bytes), quote: selection.quote } });
    const before = structuredClone(root);

    const after = saved(state, BODY_WITHOUT_PASSAGE);
    const view = toPageCommentThreadView(root, anchorDocument(after));

    expect(view.id).toBe('cmt_root');
    expect(view.quote).toBe(PASSAGE);
    expect(view.anchored).toBe(false);
    // The read changes nothing about the row it was handed.
    expect(root).toEqual(before);

    // And the text render lists it among the PAGE-LEVEL threads, quote kept.
    const text = renderPageCommentsText({
      pageId: 'pg_1',
      counts: { open: 1, resolved: 0 },
      open: { threads: [view], nextCursor: null },
      resolved: { threads: [], nextCursor: null },
    });
    expect(text).not.toContain('### On a passage');
    expect(text).toContain('### Page-level');
    expect(text.indexOf('[comment cmt_root]')).toBeGreaterThan(text.indexOf('### Page-level'));
    expect(text).toContain(`its passage is no longer in the page; it quoted: > ${PASSAGE}`);
  });

  it('a comment that never had a passage carries no quote and a null verdict — never false', () => {
    const { state } = anchoredPage();
    for (const document of [anchorDocument(state), null]) {
      const view = toPageCommentThreadView(thread(), document);
      expect(view.quote).toBeNull();
      expect(view.anchored).toBeNull();
    }
  });

  it('unreadable anchor bytes, or no document to read them against, answer false — never a failed read', () => {
    const { state } = anchoredPage();
    const broken = comment({ anchor: { bytes: toBase64(new Uint8Array([9, 9, 9])), quote: 'x' } });
    expect(anchoredVerdict(broken, anchorDocument(state))).toBe(false);
    expect(anchoredVerdict(broken, null)).toBe(false);
  });

  it('a reply is mapped one level deep with a null verdict and null resolved fields', () => {
    const { state, selection } = anchoredPage();
    const root = thread({ anchor: { bytes: toBase64(selection.bytes), quote: selection.quote } }, [
      reply,
    ]);
    const view = toPageCommentThreadView(root, anchorDocument(state));
    expect(view.replies).toEqual([
      {
        id: 'cmt_reply',
        parentCommentId: 'cmt_root',
        author: grace,
        bodyMd: 'Yes — checked.',
        createdAt: '2026-11-01T11:00:00.000Z',
        editedAt: null,
        resolvedAt: null,
        resolvedBy: null,
        quote: null,
        anchored: null,
      },
    ]);
  });
});

describe('toPageCommentView — the shape the write tool returns too', () => {
  it('carries every field the read promises, the body verbatim, and no raw anchor bytes', () => {
    const view = toPageCommentView(
      comment({
        editedAt: '2026-11-02T09:00:00.000Z',
        resolvedAt: '2026-11-03T09:00:00.000Z',
        resolvedBy: grace,
      }),
      null,
    );
    expect(view).toEqual({
      id: 'cmt_root',
      parentCommentId: null,
      author: ada,
      bodyMd: 'Is this right, @[Grace](user:usr_grace)? See motir:cmwork123.',
      createdAt: '2026-11-01T10:00:00.000Z',
      editedAt: '2026-11-02T09:00:00.000Z',
      resolvedAt: '2026-11-03T09:00:00.000Z',
      resolvedBy: grace,
      quote: null,
      anchored: null,
    });
    expect(view).not.toHaveProperty('anchor');
  });

  it('ignores a verdict handed for a comment with no passage', () => {
    expect(toPageCommentView(comment(), true).anchored).toBeNull();
  });
});

// ── The text render ─────────────────────────────────────────────────────────

describe('the text render — a thread listing that carries every comment id', () => {
  it('renders one comment with its id, author, times, resolution, quote and body', () => {
    const text = renderPageCommentText(
      toPageCommentView(
        comment({
          editedAt: '2026-11-02T09:00:00.000Z',
          resolvedAt: '2026-11-03T09:00:00.000Z',
          resolvedBy: grace,
          anchor: { bytes: 'AA==', quote: PASSAGE },
          bodyMd: 'line one\n\nline two',
        }),
        true,
      ),
    );
    expect(text).toBe(
      [
        '[comment cmt_root] · Ada (usr_ada) · 2026-11-01T10:00:00.000Z · edited 2026-11-02T09:00:00.000Z',
        'resolved 2026-11-03T09:00:00.000Z by Grace (usr_grace)',
        `on the passage: > ${PASSAGE}`,
        '  line one',
        '',
        '  line two',
      ].join('\n'),
    );
  });

  it('falls back to the id for a nameless person, and omits a deleted resolver', () => {
    const text = renderPageCommentText(
      toPageCommentView(
        comment({
          author: { id: 'usr_x', name: '', image: null },
          resolvedAt: '2026-11-03T09:00:00.000Z',
        }),
        null,
      ),
    );
    expect(text).toContain('[comment cmt_root] · usr_x (usr_x)');
    expect(text).toContain('resolved 2026-11-03T09:00:00.000Z\n');
    expect(text).not.toContain(' by ');
  });

  it('lists both lists, splits inline from page-level, prints every id and the next cursor', () => {
    const { state, selection } = anchoredPage();
    const document = anchorDocument(state);
    const inline = toPageCommentThreadView(
      thread(
        { id: 'cmt_inline', anchor: { bytes: toBase64(selection.bytes), quote: selection.quote } },
        [{ ...reply, parentCommentId: 'cmt_inline' }],
      ),
      document,
    );
    const pageLevel = toPageCommentThreadView(thread({ id: 'cmt_page' }), document);
    const text = renderPageCommentsText({
      pageId: 'pg_1',
      counts: { open: 3, resolved: 0 },
      open: { threads: [pageLevel, inline], nextCursor: 'cur_open' },
      resolved: { threads: [], nextCursor: null },
    });

    expect(text).toContain('# Discussion on page pg_1 — 3 open, 0 resolved');
    expect(text).toContain('## Open — showing 2 of 3');
    for (const id of ['cmt_inline', 'cmt_page', 'cmt_reply']) {
      expect(text).toContain(`[comment ${id}]`);
    }
    expect(text).toContain('  ↳ reply [comment cmt_reply]');
    const passage = text.indexOf('### On a passage');
    const page = text.indexOf('### Page-level');
    expect(passage).toBeGreaterThan(-1);
    expect(text.indexOf('[comment cmt_inline]')).toBeGreaterThan(passage);
    expect(text.indexOf('[comment cmt_inline]')).toBeLessThan(page);
    expect(text.indexOf('[comment cmt_page]')).toBeGreaterThan(page);
    expect(text).toContain('More open threads: pass openCursor "cur_open".');
    expect(text).toContain('## Resolved — showing 0 of 0\n\nNo threads.');
  });
});

describe('fromBase64 — the mirror of toBase64', () => {
  it('round-trips a stored state byte for byte', () => {
    const state = stateOf(BODY);
    expect(Array.from(fromBase64(toBase64(state)))).toEqual(Array.from(state));
  });
});

// ── The adapter, over stubbed services ──────────────────────────────────────

const ctx = { userId: 'usr_ada', workspaceId: 'ws_1' } as never;
const PROJECT = { id: 'prj_1', identifier: 'ACME' };

function listAnswer(
  threads: PageCommentThreadDto[],
  nextCursor: string | null,
  counts = { open: 0, resolved: 0 },
) {
  return {
    threads,
    nextCursor,
    counts,
    capabilities: { canComment: true, canModerate: false },
    workItemRefs: {},
  };
}

describe('runGetPageComments — both lists, their own cursors, one body read', () => {
  beforeEach(() => {
    svc.listPageThreads.mockReset();
    svc.getPage.mockReset();
    svc.getByKey.mockReset().mockResolvedValue(PROJECT);
  });

  it('answers an empty discussion as a success — empty lists, zero counts, null cursors — with no body read', async () => {
    svc.listPageThreads.mockResolvedValue(listAnswer([], null));

    const result = await runGetPageComments({ projectKey: ' acme ', pageId: 'pg_1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      pageId: 'pg_1',
      counts: { open: 0, resolved: 0 },
      open: { threads: [], nextCursor: null },
      resolved: { threads: [], nextCursor: null },
    });
    expect(svc.getByKey).toHaveBeenCalledWith('ACME', ctx);
    expect(svc.getPage).not.toHaveBeenCalled();
  });

  it('spends each cursor only on its own list, passes the limit, and takes counts from the open answer', async () => {
    svc.listPageThreads.mockImplementation(async (_ctx: unknown, input: { status: string }) =>
      input.status === 'open'
        ? listAnswer([thread({ id: 'cmt_o' })], 'next_open', { open: 7, resolved: 2 })
        : listAnswer(
            [thread({ id: 'cmt_r', resolvedAt: '2026-11-03T09:00:00.000Z', resolvedBy: grace })],
            null,
            {
              open: 8,
              resolved: 1,
            },
          ),
    );

    const result = await runGetPageComments(
      { projectKey: 'ACME', pageId: 'pg_1', limit: 5, openCursor: 'oc', resolvedCursor: 'rc' },
      ctx,
    );

    expect(svc.listPageThreads).toHaveBeenCalledTimes(2);
    expect(svc.listPageThreads).toHaveBeenCalledWith(ctx, {
      projectId: 'prj_1',
      pageId: 'pg_1',
      limit: 5,
      status: 'open',
      cursor: 'oc',
    });
    expect(svc.listPageThreads).toHaveBeenCalledWith(ctx, {
      projectId: 'prj_1',
      pageId: 'pg_1',
      limit: 5,
      status: 'resolved',
      cursor: 'rc',
    });
    const payload = result.structuredContent as {
      counts: unknown;
      open: { threads: { id: string }[]; nextCursor: string | null };
      resolved: { threads: { id: string; resolvedBy: unknown }[]; nextCursor: string | null };
    };
    expect(payload.counts).toEqual({ open: 7, resolved: 2 });
    expect(payload.open.threads.map((t) => t.id)).toEqual(['cmt_o']);
    expect(payload.open.nextCursor).toBe('next_open');
    expect(payload.resolved.threads[0]).toMatchObject({ id: 'cmt_r', resolvedBy: grace });
    expect(payload.resolved.nextCursor).toBeNull();
    expect(svc.getPage).not.toHaveBeenCalled();
  });

  it('reads the page body ONCE when a root carries a passage, and resolves every root against it', async () => {
    const { state, selection } = anchoredPage();
    const anchor = { bytes: toBase64(selection.bytes), quote: selection.quote };
    svc.listPageThreads.mockImplementation(async (_ctx: unknown, input: { status: string }) =>
      input.status === 'open'
        ? listAnswer([thread({ id: 'cmt_a', anchor }), thread({ id: 'cmt_p' })], null)
        : listAnswer([thread({ id: 'cmt_b', anchor })], null),
    );
    svc.getPage.mockResolvedValue({ bodyState: toBase64(state) });

    const result = await runGetPageComments({ projectKey: 'ACME', pageId: 'pg_1' }, ctx);

    expect(svc.getPage).toHaveBeenCalledTimes(1);
    expect(svc.getPage).toHaveBeenCalledWith(ctx, { projectId: 'prj_1', pageId: 'pg_1' });
    const payload = result.structuredContent as {
      open: { threads: { id: string; anchored: boolean | null }[] };
      resolved: { threads: { id: string; anchored: boolean | null }[] };
    };
    expect(payload.open.threads.map((t) => [t.id, t.anchored])).toEqual([
      ['cmt_a', true],
      ['cmt_p', null],
    ]);
    expect(payload.resolved.threads.map((t) => [t.id, t.anchored])).toEqual([['cmt_b', true]]);
    expect((result.content[0] as { text: string }).text).toContain('### On a passage');
  });

  it('a cursor for the other list is refused PAGE_COMMENT_CURSOR_INVALID by the shipped arm', async () => {
    svc.listPageThreads.mockRejectedValue(new PageCommentCursorInvalidError());
    const result = await runGetPageComments(
      { projectKey: 'ACME', pageId: 'pg_1', openCursor: 'bad' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^PAGE_COMMENT_CURSOR_INVALID: /);
  });

  it('an unknown or foreign page is PAGE_NOT_FOUND', async () => {
    svc.listPageThreads.mockRejectedValue(new PageNotFoundError('pg_other'));
    const result = await runGetPageComments({ projectKey: 'ACME', pageId: 'pg_other' }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^PAGE_NOT_FOUND: /);
  });
});

describe('registerGetPageComments', () => {
  it('registers the tool under its name and routes a call through the adapter', async () => {
    svc.getByKey.mockReset().mockResolvedValue(PROJECT);
    svc.listPageThreads.mockReset().mockResolvedValue(listAnswer([], null));
    const registerTool = vi.fn();
    const resolveContext = vi.fn(() => ctx);
    registerGetPageComments({ registerTool } as never, resolveContext as never);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [name, config, handler] = registerTool.mock.calls[0]!;
    expect(name).toBe(GET_PAGE_COMMENTS_TOOL_NAME);
    expect(config.title).toBe('Get page comments');
    expect(Object.keys(config.inputSchema)).toEqual([
      'projectKey',
      'pageId',
      'limit',
      'openCursor',
      'resolvedCursor',
    ]);
    const result = await handler({ projectKey: 'ACME', pageId: 'pg_1' }, {});
    expect(resolveContext).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });
});
