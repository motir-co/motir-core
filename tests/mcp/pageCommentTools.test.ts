import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { db } from '@/lib/db';
import {
  anchorDocument,
  anchorFromSelection,
  PageArchivedError,
  PageCommentBodyEmptyError,
  PageCommentNotFoundError,
  PageCommentReplyDepthError,
  PageNotFoundError,
  type PageCommentDto,
  type PageCommentThreadDto,
} from '@/lib/pages';
import { fromBase64, toBase64 } from '@/lib/mappers/pageMappers';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import { pagesService } from '@/lib/services/pagesService';
import {
  runGetPageComments,
  type PageCommentView,
  type PageCommentsView,
} from '@/lib/mcp/tools/getPageComments';
import { runAddPageComment } from '@/lib/mcp/tools/addPageComment';
import { runGetPage } from '@/lib/mcp/tools/getPage';
import { runAddComment } from '@/lib/mcp/tools/addComment';
import { runEditComment } from '@/lib/mcp/tools/editComment';
import { runDeleteComment } from '@/lib/mcp/tools/deleteComment';
import { runGetWorkItemActivity } from '@/lib/mcp/tools/getWorkItemActivity';
import { TOOL_PAYLOADS, isDerivedTool } from '@/lib/mcp/payloads/registry';
import { isExemptTool } from '@/lib/mcp/payloads/exemptions';
import { checkPayloadDrift } from '@/lib/mcp/payloads/driftGuard';
import { createTestProject } from '../fixtures/projectFixtures';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The INTEGRATION GATE of Story MOTIR-10869 (MOTIR-10980): both page-comment
// tools driven through their exported runners, over the SHIPPED
// `pageCommentsService` and `pagesService`, against real Postgres.
//
// The two tool cards (MOTIR-10978 / MOTIR-10979) prove their adapters with the
// service stubbed; `tests/services/pageCommentsService.integration.test.ts`
// proves the service's own rules. This suite is the seam between them, and only
// asks questions a fixture cannot answer — about ROWS and about the STORED Yjs
// document:
//
//   1. a comment an adapter writes is the row a member's own read returns;
//   2. the anchored verdict is RECOMPUTED against the stored body, never
//      remembered — a real save in between, the comment row untouched;
//   3. a refusal raised inside the service's transaction leaves the page's
//      threads and counts exactly as they were;
//   4. the cursor walk returns every thread once when Postgres answers.
//
// It also owns the story's unchanged-payload criterion: `get_page`,
// `add_comment`, `edit_comment`, `get_work_item_activity` and `delete_comment`
// measured over LIVE payloads from real rows.
//
// One layer BELOW the door on purpose — no MCP route, no `buildMcpServer`, no
// token: the request path is the end-to-end receipt card's subject.

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }));

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PCT' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Seeds and reads ──────────────────────────────────────────────────────────

const PASSAGE = 'The rollout starts on Monday.';
const BODY = [
  '# Launch plan',
  '',
  `${PASSAGE}`,
  '',
  'Every dashboard must be green before we flip the flag.',
].join('\n');

const mention = () => `[@Owner](mention:${fx.ownerId})`;

async function seedPage(title = 'Plan', projectId = fx.projectId): Promise<string> {
  const page = await pagesService.createPageFromMarkdown(fx.ctx, {
    projectId,
    title,
    markdown: BODY,
  });
  return page.id;
}

const on = (pageId: string, projectId = fx.projectId) => ({ projectId, pageId });

/** Where `needle` sits in the decoded ProseMirror body — the selection a reader makes. */
function rangeOf(doc: ProseMirrorNode, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text!.indexOf(needle);
    if (at >= 0) found = { from: pos + at, to: pos + at + needle.length };
    return false;
  });
  if (!found) throw new Error(`the body holds no "${needle}"`);
  return found;
}

/**
 * Anchor `needle` on the page's STORED body, as the editor captures it: the
 * state `pagesService.getPage` returns, decoded by `anchorDocument`, the range
 * walked out of that document, encoded by `anchorFromSelection` — a real
 * passage, never bytes that merely look like one.
 */
async function anchorOn(pageId: string, needle: string) {
  const page = await pagesService.getPage(fx.ctx, on(pageId));
  const document = anchorDocument(fromBase64(page.bodyState));
  const range = rangeOf(document.doc, needle);
  const anchor = anchorFromSelection(document, range.from, range.to);
  if (!anchor) throw new Error(`the codec captured nothing for "${needle}"`);
  return { bytes: anchor.bytes, quote: anchor.quote };
}

/** A tool's `structuredContent`, typed as the page-comments read answers it. */
const view = (result: CallToolResult) => {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as unknown as PageCommentsView;
};
const commentView = (result: CallToolResult) => {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as unknown as PageCommentView;
};
const structured = (result: CallToolResult) => {
  expect(result.isError).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
};
const text = (result: CallToolResult) => {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : '';
};

const read = (pageId: string, extra: { limit?: number; openCursor?: string } = {}) =>
  runGetPageComments({ projectKey: fx.projectIdentifier, pageId, ...extra }, fx.ctx);

/**
 * Every comment row of a page and the page's own revision, read straight off
 * the tables with the admin client — a path that cannot itself write, so it can
 * say "nothing was written" about a read or a refusal.
 */
async function rowsOf(pageId: string) {
  const [page, comments] = await Promise.all([
    adminDb.page.findUniqueOrThrow({
      where: { id: pageId },
      select: { revision: true, updatedAt: true },
    }),
    adminDb.pageComment.findMany({
      where: { pageId },
      orderBy: { id: 'asc' },
    }),
  ]);
  return { revision: page.revision, updatedAt: page.updatedAt.toISOString(), comments };
}

/** The fields the tool and the member's read must agree on, comment by comment. */
function rowFields(c: PageCommentDto | PageCommentView) {
  return {
    id: c.id,
    parentCommentId: c.parentCommentId,
    author: { id: c.author.id, name: c.author.name, image: c.author.image },
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    resolvedAt: c.resolvedAt,
    resolvedBy: c.resolvedBy,
    bodyMd: c.bodyMd,
  };
}

/** Every root and every reply of a list, flattened into the agreed fields. */
function flatten(
  threads: readonly (PageCommentThreadDto | PageCommentsView['open']['threads'][number])[],
) {
  return threads.map((t) => ({
    ...rowFields(t),
    replies: t.replies.map((r) => rowFields(r)),
  }));
}

/** The text render's Open section, split into its inline and page-level parts. */
function openSections(rendered: string) {
  const open = rendered.split('\n## Resolved')[0]!.split('## Open')[1] ?? '';
  const [beforePageLevel, pageLevel = ''] = open.split('### Page-level');
  const inline = beforePageLevel!.split('### On a passage')[1] ?? '';
  return { inline, pageLevel };
}

/** A refusal's code off the `isError` text `toolError` renders (`CODE: message`). */
function refusalCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return text(result).split(':')[0]!;
}

// ── Case 1 — the tool's answer and the member's read resolve the SAME rows ────

describe('get_page_comments over real rows', () => {
  it('answers both lists and the counts, row-for-row what the service returns', async () => {
    const pageId = await seedPage();
    const pageLevelBody = `Who owns the rollback? ${mention()} please confirm.`;
    const pageLevel = await pageCommentsService.postPageComment(fx.ctx, {
      ...on(pageId),
      bodyMd: pageLevelBody,
    });
    const reply = await pageCommentsService.postPageReply(fx.ctx, {
      ...on(pageId),
      parentCommentId: pageLevel.id,
      bodyMd: 'I do.',
    });
    const anchor = await anchorOn(pageId, PASSAGE);
    expect(anchor.quote).toBe(PASSAGE);
    const inline = await pageCommentsService.postPageComment(fx.ctx, {
      ...on(pageId),
      bodyMd: 'Monday is a holiday.',
      anchor,
    });
    const toResolve = await pageCommentsService.postPageComment(fx.ctx, {
      ...on(pageId),
      bodyMd: 'Is the flag named yet?',
    });
    await pageCommentsService.resolvePageThread(fx.ctx, { ...on(pageId), commentId: toResolve.id });

    const answer = view(await read(pageId));
    const [svcOpen, svcResolved] = await Promise.all([
      pageCommentsService.listPageThreads(fx.ctx, { ...on(pageId), status: 'open' }),
      pageCommentsService.listPageThreads(fx.ctx, { ...on(pageId), status: 'resolved' }),
    ]);

    expect(answer.pageId).toBe(pageId);
    expect(answer.counts).toEqual({ open: 2, resolved: 1 });
    expect(answer.counts).toEqual(svcOpen.counts);

    // Both directions: the same rows in the same order, and no row on either
    // side the other lacks — every root and every reply, field by field.
    expect(flatten(answer.open.threads)).toEqual(flatten(svcOpen.threads));
    expect(flatten(answer.resolved.threads)).toEqual(flatten(svcResolved.threads));
    expect(answer.open.threads.map((t) => t.id).sort()).toEqual([inline.id, pageLevel.id].sort());
    expect(answer.resolved.threads.map((t) => t.id)).toEqual([toResolve.id]);

    const openById = new Map(answer.open.threads.map((t) => [t.id, t]));
    const root = openById.get(pageLevel.id)!;
    // The reply sits inside its root, and in no root list.
    expect(root.replies.map((r) => r.id)).toEqual([reply.id]);
    const rootIds = [...answer.open.threads, ...answer.resolved.threads].map((t) => t.id);
    expect(rootIds).not.toContain(reply.id);
    expect(root.replies[0]!.parentCommentId).toBe(pageLevel.id);

    // The mention token, byte for byte.
    expect(root.bodyMd).toBe(pageLevelBody);
    expect(Buffer.from(root.bodyMd).equals(Buffer.from(pageLevelBody))).toBe(true);
    // Nothing was edited.
    for (const c of [root, ...root.replies, openById.get(inline.id)!]) {
      expect(c.editedAt).toBeNull();
    }

    // Resolution: who and when on the resolved root, matching the service; null elsewhere.
    const resolved = answer.resolved.threads[0]!;
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedBy?.id).toBe(fx.ownerId);
    expect({ at: resolved.resolvedAt, by: resolved.resolvedBy }).toEqual({
      at: svcResolved.threads[0]!.resolvedAt,
      by: svcResolved.threads[0]!.resolvedBy,
    });
    for (const c of [root, root.replies[0]!, openById.get(inline.id)!]) {
      expect(c.resolvedAt).toBeNull();
      expect(c.resolvedBy).toBeNull();
    }

    // Page-level roots carry no quote and a null verdict; the inline root its sentence, true.
    expect([root.quote, root.anchored]).toEqual([null, null]);
    expect([resolved.quote, resolved.anchored]).toEqual([null, null]);
    expect(root.replies[0]!.anchored).toBeNull();
    const inlineView = openById.get(inline.id)!;
    expect(inlineView.quote).toBe(PASSAGE);
    expect(inlineView.anchored).toBe(true);
    // The verdict was computed over the bytes the service actually stored.
    const svcInline = svcOpen.threads.find((t) => t.id === inline.id)!;
    expect(svcInline.anchor).toEqual({ bytes: toBase64(anchor.bytes), quote: PASSAGE });
  });

  // ── Case 2 — the verdict is recomputed against the stored body ─────────────

  it('recomputes the anchored verdict after a real save, the comment row untouched', async () => {
    const pageId = await seedPage();
    const anchor = await anchorOn(pageId, PASSAGE);
    const inline = await pageCommentsService.postPageComment(fx.ctx, {
      ...on(pageId),
      bodyMd: 'Monday is a holiday.',
      anchor,
    });

    const before1 = await rowsOf(pageId);
    const first = await read(pageId);
    expect(await rowsOf(pageId)).toEqual(before1);
    const firstView = view(first);
    expect(firstView.open.threads[0]!.anchored).toBe(true);
    expect(openSections(text(first)).inline).toContain(`[comment ${inline.id}]`);

    // Delete the quoted sentence through the app's own whole-body save, stating
    // the revision the markdown read returned.
    const markdown = await pagesService.getPageMarkdown(fx.ctx, on(pageId));
    expect(markdown.markdown).toContain(PASSAGE);
    await pagesService.savePageMarkdown(fx.ctx, {
      ...on(pageId),
      markdown: markdown.markdown.replace(PASSAGE, ''),
      expectedRevision: markdown.revision,
    });
    const saved = await rowsOf(pageId);
    expect(saved.revision).toBeGreaterThan(markdown.revision);
    // The comment row was not touched by the save.
    expect(saved.comments).toEqual(before1.comments);

    const second = await read(pageId);
    expect(await rowsOf(pageId)).toEqual(saved);
    const root = view(second).open.threads[0]!;
    expect(root.id).toBe(inline.id);
    expect(root.quote).toBe(PASSAGE);
    expect(root.anchored).toBe(false);
    // The stored anchor bytes are the ones posted, unmoved by the save.
    const row = saved.comments.find((c) => c.id === inline.id)!;
    expect(Buffer.from(row.anchor!).equals(Buffer.from(anchor.bytes))).toBe(true);
    expect(row.anchorQuote).toBe(PASSAGE);
    // The render now lists it among the page-level threads.
    const sections = openSections(text(second));
    expect(sections.pageLevel).toContain(`[comment ${inline.id}]`);
    expect(sections.inline).not.toContain(`[comment ${inline.id}]`);
    expect(sections.pageLevel).toContain('its passage is no longer in the page');

    // The page's revision advanced by the save, never by a read.
    const page = await pagesService.getPage(fx.ctx, on(pageId));
    expect(page.revision).toBe(saved.revision);
    expect(page.revision).toBeGreaterThan(markdown.revision);
  });

  // ── Case 3 — the cursor walk over Postgres ─────────────────────────────────

  it('walks twelve open threads in pages of 5, 5 and 2, each thread once', async () => {
    const pageId = await seedPage();
    const seeded: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const t = await pageCommentsService.postPageComment(fx.ctx, {
        ...on(pageId),
        bodyMd: `Thread ${i + 1}`,
      });
      seeded.push(t.id);
    }

    const pages: PageCommentsView[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const answer = view(
        await read(pageId, { limit: 5, ...(cursor ? { openCursor: cursor } : {}) }),
      );
      pages.push(answer);
      cursor = answer.open.nextCursor ?? undefined;
    }

    expect(pages.map((p) => p.open.threads.length)).toEqual([5, 5, 2]);
    const walked = pages.flatMap((p) => p.open.threads.map((t) => t.id));
    expect(new Set(walked).size).toBe(12);
    expect(walked).toHaveLength(12);
    expect([...walked].sort()).toEqual([...seeded].sort());
    expect(pages[0]!.open.nextCursor).not.toBeNull();
    expect(pages[1]!.open.nextCursor).not.toBeNull();
    expect(pages[2]!.open.nextCursor).toBeNull();
    for (const p of pages) {
      expect(p.counts).toEqual({ open: 12, resolved: 0 });
      expect(p.resolved).toEqual({ threads: [], nextCursor: null });
    }
  });
});

// ── Case 4 — the write, read back through the tool AND through the service ───

describe('add_page_comment over real rows', () => {
  it('writes a page-level comment and a reply that the read and the service both return', async () => {
    const pageId = await seedPage();
    const seededRoot = await pageCommentsService.postPageComment(fx.ctx, {
      ...on(pageId),
      bodyMd: 'A seeded thread.',
    });

    const body = `Can we move it to Tuesday? ${mention()}`;
    const written = commentView(
      await runAddPageComment({ projectKey: fx.projectIdentifier, pageId, body }, fx.ctx),
    );
    expect(written.id).toEqual(expect.any(String));
    expect(written.parentCommentId).toBeNull();
    expect(written.author.id).toBe(fx.ctx.userId);
    expect(Number.isNaN(Date.parse(written.createdAt))).toBe(false);
    expect(written.editedAt).toBeNull();
    expect(written.bodyMd).toBe(body);
    expect([written.resolvedAt, written.resolvedBy, written.quote, written.anchored]).toEqual([
      null,
      null,
      null,
      null,
    ]);

    const afterRoot = view(await read(pageId));
    const listedRoot = afterRoot.open.threads.find((t) => t.id === written.id)!;
    expect(listedRoot).toBeDefined();
    expect(rowFields(listedRoot)).toEqual(rowFields(written));

    const replyBody = `Tuesday works. ${mention()}`;
    const reply = commentView(
      await runAddPageComment(
        { projectKey: fx.projectIdentifier, pageId, body: replyBody, rootCommentId: seededRoot.id },
        fx.ctx,
      ),
    );
    expect(reply.parentCommentId).toBe(seededRoot.id);
    expect(reply.author.id).toBe(fx.ctx.userId);
    expect(reply.editedAt).toBeNull();
    expect(reply.bodyMd).toBe(replyBody);

    const afterReply = view(await read(pageId));
    const thread = afterReply.open.threads.find((t) => t.id === seededRoot.id)!;
    expect(thread.replies.map((r) => rowFields(r))).toEqual([rowFields(reply)]);
    expect(afterReply.open.threads.map((t) => t.id)).not.toContain(reply.id);
    expect(afterReply.counts).toEqual({ open: 2, resolved: 0 });

    // What the SERVICE stored, not what the adapter echoed.
    const stored = await pageCommentsService.listPageThreads(fx.ctx, {
      ...on(pageId),
      status: 'open',
    });
    const storedRoot = stored.threads.find((t) => t.id === written.id)!;
    expect(storedRoot.bodyMd).toBe(body);
    expect(storedRoot.author.id).toBe(fx.ctx.userId);
    const storedThread = stored.threads.find((t) => t.id === seededRoot.id)!;
    expect(storedThread.replies.map((r) => [r.id, r.bodyMd])).toEqual([[reply.id, replyBody]]);
    expect(stored.threads.map((t) => t.id)).not.toContain(reply.id);
  });
});

// ── Cases 5 and 6 — refusals that write nothing ──────────────────────────────

describe('refusals over real rows', () => {
  it('names each of six refusals by the package’s own code and writes nothing', async () => {
    // A page for each refusal, with a thread and a reply on it.
    async function seeded(title: string) {
      const pageId = await seedPage(title);
      const root = await pageCommentsService.postPageComment(fx.ctx, {
        ...on(pageId),
        bodyMd: `Root on ${title}`,
      });
      const reply = await pageCommentsService.postPageReply(fx.ctx, {
        ...on(pageId),
        parentCommentId: root.id,
        bodyMd: `Reply on ${title}`,
      });
      return { pageId, root, reply };
    }

    const depth = await seeded('Depth');
    const blank = await seeded('Blank');
    const foreignComment = await seeded('Foreign comment');
    const elsewhere = await seeded('Elsewhere');
    const archived = await seeded('Archived');
    await pagesService.archivePage(fx.ctx, on(archived.pageId));
    const second = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PCU',
      name: 'Second',
    });
    const foreignPageId = await seedPage('Second project', second.id);
    await pageCommentsService.postPageComment(fx.ctx, {
      ...on(foreignPageId, second.id),
      bodyMd: 'Root in the second project',
    });
    const missingPageId = 'cmnopage000000000000000000';

    const add = (pageId: string, body: string, rootCommentId?: string) =>
      runAddPageComment(
        {
          projectKey: fx.projectIdentifier,
          pageId,
          body,
          ...(rootCommentId ? { rootCommentId } : {}),
        },
        fx.ctx,
      );

    const cases: {
      name: string;
      call: () => Promise<CallToolResult>;
      expected: string;
      /** The page whose discussion the call must leave as it was, and its project key. */
      watch: { pageId: string; projectKey: string };
    }[] = [
      {
        name: 'a reply to a reply',
        call: () => add(depth.pageId, 'Too deep', depth.reply.id),
        expected: new PageCommentReplyDepthError(depth.reply.id).code,
        watch: { pageId: depth.pageId, projectKey: fx.projectIdentifier },
      },
      {
        name: 'a whitespace-only body',
        call: () => add(blank.pageId, '   \n\t  '),
        expected: new PageCommentBodyEmptyError().code,
        watch: { pageId: blank.pageId, projectKey: fx.projectIdentifier },
      },
      {
        name: 'a root that belongs to another page',
        call: () => add(foreignComment.pageId, 'Wrong thread', elsewhere.root.id),
        expected: new PageCommentNotFoundError(elsewhere.root.id).code,
        watch: { pageId: foreignComment.pageId, projectKey: fx.projectIdentifier },
      },
      {
        name: 'a write to an archived page',
        call: () => add(archived.pageId, 'Too late'),
        expected: new PageArchivedError(archived.pageId).code,
        watch: { pageId: archived.pageId, projectKey: fx.projectIdentifier },
      },
      {
        name: 'a page in a second project of the same workspace',
        call: () => add(foreignPageId, 'Wrong project'),
        expected: new PageNotFoundError(foreignPageId).code,
        watch: { pageId: foreignPageId, projectKey: second.identifier },
      },
      {
        name: 'an id that names no page',
        call: () => add(missingPageId, 'Nowhere'),
        expected: new PageNotFoundError(missingPageId).code,
        watch: { pageId: depth.pageId, projectKey: fx.projectIdentifier },
      },
    ];

    expect(cases.map((c) => c.expected)).toEqual([
      'PAGE_COMMENT_REPLY_DEPTH_EXCEEDED',
      'PAGE_COMMENT_BODY_EMPTY',
      'PAGE_COMMENT_NOT_FOUND',
      'PAGE_ARCHIVED',
      'PAGE_NOT_FOUND',
      'PAGE_NOT_FOUND',
    ]);

    const readWatched = (w: { pageId: string; projectKey: string }) =>
      runGetPageComments({ projectKey: w.projectKey, pageId: w.pageId }, fx.ctx);
    const everyRow = () => adminDb.pageComment.findMany({ orderBy: { id: 'asc' } });

    for (const c of cases) {
      const before = view(await readWatched(c.watch));
      const rowsBefore = await everyRow();

      const result = await c.call();
      expect(refusalCode(result), c.name).toBe(c.expected);
      // Through the shipped `PageError` arm — never an internal error.
      expect(text(result), c.name).not.toMatch(/INTERNAL/);

      const after = view(await readWatched(c.watch));
      expect(after.counts, c.name).toEqual(before.counts);
      expect(flatten(after.open.threads), c.name).toEqual(flatten(before.open.threads));
      expect(flatten(after.resolved.threads), c.name).toEqual(flatten(before.resolved.threads));
      // And no row anywhere was written, read through a path that cannot write.
      expect(await everyRow(), c.name).toEqual(rowsBefore);
    }
  });

  it('still lists an archived page’s discussion while refusing a write to it', async () => {
    const pageId = await seedPage();
    const root = await pageCommentsService.postPageComment(fx.ctx, {
      ...on(pageId),
      bodyMd: 'Before the archive.',
    });
    const done = await pageCommentsService.postPageComment(fx.ctx, {
      ...on(pageId),
      bodyMd: 'Settled.',
    });
    await pageCommentsService.resolvePageThread(fx.ctx, { ...on(pageId), commentId: done.id });
    await pagesService.archivePage(fx.ctx, on(pageId));

    const listed = view(await read(pageId));
    expect(listed.counts).toEqual({ open: 1, resolved: 1 });
    expect(listed.open.threads.map((t) => t.id)).toEqual([root.id]);
    expect(listed.resolved.threads.map((t) => t.id)).toEqual([done.id]);

    const before = await rowsOf(pageId);
    const refused = await runAddPageComment(
      { projectKey: fx.projectIdentifier, pageId, body: 'After the archive.' },
      fx.ctx,
    );
    expect(refusalCode(refused)).toBe(new PageArchivedError(pageId).code);
    expect(await rowsOf(pageId)).toEqual(before);
  });
});

// ── Case 7 — the neighbours' payloads, unchanged, over live rows ─────────────

describe('the five neighbouring tools keep their payloads', () => {
  // The top-level keys each EXEMPT payload carries, as the two adapters read at
  // motir-core 22a48fdd. No schema recomputes an exempt payload, so the set is
  // measured off a live call below and compared to this record.
  const GET_PAGE_KEYS = [
    'archivedAt',
    'id',
    'latestVersion',
    'markdown',
    'placement',
    'projectId',
    'revision',
    'title',
    'updatedAt',
  ];
  const DELETE_COMMENT_KEYS = ['commentId', 'parentCommentId', 'replyCount', 'workItemKey'];

  it('derived payloads pass the drift guard; exempt ones keep their key sets', async () => {
    const pageId = await seedPage();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Payload host' });

    // add_comment — derived.
    const added = structured(
      await runAddComment({ key: item.identifier, body: 'First words.' }, fx.ctx),
    );
    expect(isDerivedTool('add_comment')).toBe(true);
    expect(checkPayloadDrift(TOOL_PAYLOADS.add_comment!, added)).toEqual([]);
    expect(added.bodyMd).toBe('First words.');
    const commentId = added.id as string;

    // edit_comment — derived.
    const edited = structured(await runEditComment({ commentId, body: 'Second words.' }, fx.ctx));
    expect(isDerivedTool('edit_comment')).toBe(true);
    expect(checkPayloadDrift(TOOL_PAYLOADS.edit_comment!, edited)).toEqual([]);
    expect(edited.id).toBe(commentId);
    expect(edited.bodyMd).toBe('Second words.');

    // get_work_item_activity — derived; the comment thread it acted on is in it.
    const activity = structured(
      await runGetWorkItemActivity({ key: item.identifier, view: 'comments' }, fx.ctx),
    );
    expect(isDerivedTool('get_work_item_activity')).toBe(true);
    expect(checkPayloadDrift(TOOL_PAYLOADS.get_work_item_activity!, activity)).toEqual([]);
    const threads = activity.threads as { id: string; bodyMd: string }[];
    expect(threads.map((t) => [t.id, t.bodyMd])).toEqual([[commentId, 'Second words.']]);

    // get_page — exempt; its key set measured off the live payload.
    const page = structured(await runGetPage({ projectKey: fx.projectIdentifier, pageId }, fx.ctx));
    expect(isDerivedTool('get_page')).toBe(false);
    expect(isExemptTool('get_page')).toBe(true);
    expect(Object.keys(page).sort()).toEqual(GET_PAGE_KEYS);
    expect(page.id).toBe(pageId);
    expect(page.markdown).toContain(PASSAGE);

    // delete_comment — exempt; its key set measured off the live payload.
    const deleted = structured(await runDeleteComment({ commentId }, fx.ctx));
    expect(isDerivedTool('delete_comment')).toBe(false);
    expect(isExemptTool('delete_comment')).toBe(true);
    expect(Object.keys(deleted).sort()).toEqual(DELETE_COMMENT_KEYS);
    expect(deleted).toEqual({
      commentId,
      workItemKey: item.identifier,
      parentCommentId: null,
      replyCount: 0,
    });
  });
});
