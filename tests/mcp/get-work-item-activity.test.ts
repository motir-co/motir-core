import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import {
  GET_WORK_ITEM_ACTIVITY_TOOL_NAME,
  summarizeActivity,
} from '@/lib/mcp/tools/getWorkItemActivity';
import { activityService } from '@/lib/services/activityService';
import { commentsService, COMMENT_PAGE_SIZE } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type {
  ActivityAllPageDto,
  ActivityEntryDto,
  ActivityHistoryPageDto,
} from '@/lib/dto/activity';
import type { CommentsPageDTO } from '@/lib/dto/comments';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `get_work_item_activity` (MOTIR-1999) over real Postgres — the DISCUSSION
// read the MCP surface never had. `add_comment` has shipped since 7.8.5 and
// nothing could read a comment back, so the planner's own archive rationale was
// write-only.
//
// The assertions, in order of what would hurt most if it broke:
//  1. TENANCY — a token bound to workspace A can read neither B's comments nor
//     B's history, and an unknown key is indistinguishable from a forbidden one
//     (404-not-403). Structural: the workspace comes from the token context.
//  2. NO RE-PROJECTION — each view's `structuredContent` is compared to the very
//     service call the UI route makes, so a future service change cannot drift
//     the tool silently. This is also the comment-VISIBILITY proof: the tool
//     shows exactly what `commentsService.listComments` shows, because it is the
//     same call — no second `isPublic` filter, no invented projection.
//  3. NO TRUNCATION — the MOTIR-1709 regression. A long body survives whole in
//     both the structured payload and the text block.
//  4. PAGING is pass-through — `nextCursor` round-trips, re-reads nothing, and
//     the summary never reads as "that's everything" while a cursor remains.
//
// Built with a FIXED-context resolver over the in-memory transport (the
// tools.test.ts pattern): the bearer plumbing lives in auth.test.ts and the
// scope narrowing in scope-gate.test.ts, so this file exercises the tool.

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate). */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'activity-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Call the tool through the transport with a throwaway client. */
async function callActivity(
  ctx: ServiceContext,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const client = await connectClient(ctx);
  try {
    return (await client.callTool({
      name: GET_WORK_ITEM_ACTIVITY_TOOL_NAME,
      arguments: args,
    })) as CallToolResult;
  } finally {
    await client.close();
  }
}

/** The successful result's structured page. */
function pageOf<T>(res: CallToolResult): T {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as T;
}

/** The result's text block (the human-readable half of the dual content). */
function textOf(res: CallToolResult): string {
  return (res.content as { type: string; text: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * The wire form of a service page. The tool hands the DTO to the transport,
 * which JSON-encodes it, so the round-tripped service value is the right thing
 * to compare against — anything BEYOND that encoding is a re-projection, which
 * is exactly what these assertions forbid.
 */
function onTheWire<T>(page: T): T {
  return JSON.parse(JSON.stringify(page)) as T;
}

async function makeItem(fx: WorkItemFixture, title: string): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: dto.id, key: dto.identifier };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('get_work_item_activity — registration', () => {
  it('is advertised with an input schema and is a `read`-scoped tool', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();

    const tool = tools.find((t) => t.name === GET_WORK_ITEM_ACTIVITY_TOOL_NAME);
    expect(tool, 'get_work_item_activity is not registered').toBeTruthy();
    expect(tool!.inputSchema).toBeTruthy();
    // In the exported list, so the scope map's totality guard covers it.
    expect(MCP_TOOL_NAMES).toContain(GET_WORK_ITEM_ACTIVITY_TOOL_NAME);
    expect(TOOL_SCOPES[GET_WORK_ITEM_ACTIVITY_TOOL_NAME]).toBe('read');
    await client.close();
  });
});

describe('get_work_item_activity — the three views return the shipped page, unaltered', () => {
  it('`comments` returns exactly what commentsService.listComments returns', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Discussed');
    await commentsService.addComment(item.id, { bodyMd: 'first thought' }, fx.ctx);
    await commentsService.addComment(item.id, { bodyMd: 'second thought' }, fx.ctx);

    const res = await callActivity(fx.ctx, { key: item.key, view: 'comments' });
    const page = pageOf<CommentsPageDTO>(res);
    const service = await commentsService.listComments(item.id, {}, fx.ctx);

    expect(page).toEqual(onTheWire(service));
    expect(page.threads.map((t) => t.bodyMd)).toEqual(['first thought', 'second thought']);
    expect(page.totalCount).toBe(2);
  });

  it('`history` returns exactly what activityService.listHistory returns', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Moved');
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);

    const res = await callActivity(fx.ctx, { key: item.key, view: 'history' });
    const page = pageOf<ActivityHistoryPageDto>(res);
    const service = await activityService.listHistory(item.id, {}, fx.ctx);

    expect(page).toEqual(onTheWire(service));
    // The status move is in the trail, rendered as typed parts (not raw diff).
    expect(page.entries.some((e) => e.parts.some((p) => p.kind === 'field'))).toBe(true);
  });

  it('`all` — the DEFAULT view — returns exactly what activityService.listAll returns', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Both streams');
    await commentsService.addComment(item.id, { bodyMd: 'a word' }, fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);

    // No `view` argument at all — the default must be `all`.
    const res = await callActivity(fx.ctx, { key: item.key });
    const page = pageOf<ActivityAllPageDto>(res);
    const service = await activityService.listAll(item.id, {}, fx.ctx);

    expect(page).toEqual(onTheWire(service));
    // Both sources are present and interleaved, each in its native shape.
    const types = page.entries.map((e) => e.type);
    expect(types).toContain('comment');
    expect(types).toContain('history');
    expect(page.totalComments).toBe(1);
    expect(page.totalChanges).toBeGreaterThan(0);
    // An explicit view: 'all' is the same page as the omitted one.
    const explicit = await callActivity(fx.ctx, { key: item.key, view: 'all' });
    expect(pageOf<ActivityAllPageDto>(explicit).entries.length).toBe(page.entries.length);
  });

  it('`order` passes straight through — asc is the reverse walk of desc', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Ordered');
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);

    const desc = pageOf<ActivityHistoryPageDto>(
      await callActivity(fx.ctx, { key: item.key, view: 'history', order: 'desc' }),
    );
    const asc = pageOf<ActivityHistoryPageDto>(
      await callActivity(fx.ctx, { key: item.key, view: 'history', order: 'asc' }),
    );
    expect(asc).toEqual(
      onTheWire(await activityService.listHistory(item.id, { order: 'asc' }, fx.ctx)),
    );
    expect(asc.entries.map((e) => e.id)).toEqual([...desc.entries.map((e) => e.id)].reverse());
  });
});

describe('get_work_item_activity — the empty page', () => {
  it('an item with nothing said returns a well-formed EMPTY page, not an error', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Silent');
    // Creation writes a `created` revision, so clear the trail to reach the
    // genuine zero-comments AND zero-displayable-revisions case.
    await adminDb.workItemRevision.deleteMany({ where: { workItemId: item.id } });

    const all = pageOf<ActivityAllPageDto>(await callActivity(fx.ctx, { key: item.key }));
    expect(all.entries).toEqual([]);
    expect(all.totalComments).toBe(0);
    expect(all.totalChanges).toBe(0);
    expect(all.nextCursor).toBeNull();

    const comments = pageOf<CommentsPageDTO>(
      await callActivity(fx.ctx, { key: item.key, view: 'comments' }),
    );
    expect(comments.threads).toEqual([]);
    expect(comments.totalCount).toBe(0);
    expect(comments.nextCursor).toBeNull();

    const history = pageOf<ActivityHistoryPageDto>(
      await callActivity(fx.ctx, { key: item.key, view: 'history' }),
    );
    expect(history.entries).toEqual([]);
    expect(history.totalCount).toBe(0);
    expect(history.nextCursor).toBeNull();

    // "Nothing was said" reads as such — never as a failure to look.
    const text = textOf(await callActivity(fx.ctx, { key: item.key }));
    expect(text).toContain('nothing recorded yet');
    expect(text).toContain('End of the stream');
  });
});

describe('get_work_item_activity — paging is pass-through in both directions', () => {
  it('a full page hands back a cursor; the next call continues and re-reads nothing', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Chatty');
    const total = COMMENT_PAGE_SIZE + 3;
    for (let i = 0; i < total; i++) {
      await commentsService.addComment(item.id, { bodyMd: `comment ${i}` }, fx.ctx);
    }

    const first = pageOf<CommentsPageDTO>(
      await callActivity(fx.ctx, { key: item.key, view: 'comments' }),
    );
    expect(first.threads).toHaveLength(COMMENT_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    expect(first.totalCount).toBe(total);

    const second = pageOf<CommentsPageDTO>(
      await callActivity(fx.ctx, {
        key: item.key,
        view: 'comments',
        cursor: first.nextCursor as string,
      }),
    );
    expect(second.threads).toHaveLength(total - COMMENT_PAGE_SIZE);
    expect(second.nextCursor).toBeNull();

    // No overlap: the two pages together are the whole stream, each item once.
    const ids = [...first.threads, ...second.threads].map((t) => t.id);
    expect(new Set(ids).size).toBe(total);
  });

  it('the `all` cursor is OPAQUE — echoed back verbatim, and never re-encoded', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Long stream');
    for (let i = 0; i < COMMENT_PAGE_SIZE + 2; i++) {
      await commentsService.addComment(item.id, { bodyMd: `c${i}` }, fx.ctx);
    }

    const first = pageOf<ActivityAllPageDto>(await callActivity(fx.ctx, { key: item.key }));
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    // The tool returns the service's token byte-for-byte — no re-encoding.
    const service = await activityService.listAll(item.id, {}, fx.ctx);
    expect(cursor).toBe(service.nextCursor);

    const second = pageOf<ActivityAllPageDto>(
      await callActivity(fx.ctx, { key: item.key, cursor: cursor as string }),
    );
    const keyOf = (e: ActivityAllPageDto['entries'][number]) =>
      e.type === 'comment' ? e.thread.id : e.entry.id;
    const firstKeys = new Set(first.entries.map(keyOf));
    for (const entry of second.entries) {
      expect(firstKeys.has(keyOf(entry)), 'the second page re-read an entry').toBe(false);
    }
  });

  it('a SHORT page with a non-null cursor is a pass, and the summary says MORE REMAINS', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Short page');
    for (let i = 0; i < COMMENT_PAGE_SIZE + 1; i++) {
      await commentsService.addComment(item.id, { bodyMd: `c${i}` }, fx.ctx);
    }
    const res = await callActivity(fx.ctx, { key: item.key });
    const page = pageOf<ActivityAllPageDto>(res);
    expect(page.nextCursor).not.toBeNull();
    // The text must not imply the page is the whole story.
    expect(textOf(res)).toContain('MORE REMAINS');
    expect(textOf(res)).not.toContain('End of the stream');
  });

  it('a malformed `all` cursor is a clean INVALID_ACTIVITY_CURSOR tool error', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Bad cursor');
    const res = await callActivity(fx.ctx, { key: item.key, cursor: 'not-a-real-cursor' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('INVALID_ACTIVITY_CURSOR');
  });
});

describe('get_work_item_activity — no truncation (the MOTIR-1709 regression)', () => {
  it('a very long comment body survives whole in BOTH the payload and the text block', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Verbose');
    // Longer than every excerpt threshold the other tools use (280 / 500 / 800).
    const long = `Archive rationale: ${'x'.repeat(1200)} END`;
    await commentsService.addComment(item.id, { bodyMd: long }, fx.ctx);

    const res = await callActivity(fx.ctx, { key: item.key, view: 'comments' });
    const page = pageOf<CommentsPageDTO>(res);
    expect(page.threads[0]!.bodyMd).toBe(long);
    // The human-readable half carries it in full too — no ellipsis, no cut.
    expect(textOf(res)).toContain(long);
    expect(textOf(res)).not.toContain('…');
  });

  it('an EDITED comment reads back as edited, carrying the new body in full', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Revised');
    const original = await commentsService.addComment(item.id, { bodyMd: 'first draft' }, fx.ctx);
    await commentsService.editComment(original.id, { bodyMd: 'the corrected rationale' }, fx.ctx);

    const res = await callActivity(fx.ctx, { key: item.key, view: 'comments' });
    const page = pageOf<CommentsPageDTO>(res);
    expect(page.threads[0]!.bodyMd).toBe('the corrected rationale');
    expect(page.threads[0]!.editedAt).not.toBeNull();
    const text = textOf(res);
    expect(text).toContain('(edited)');
    expect(text).toContain('the corrected rationale');
    expect(text).not.toContain('first draft');
  });

  it('a multi-line body keeps every line', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Multiline');
    const body = '## Why\n\n- reason one\n- reason two\n\nSee MOTIR-1.';
    await commentsService.addComment(item.id, { bodyMd: body }, fx.ctx);

    const text = textOf(await callActivity(fx.ctx, { key: item.key, view: 'comments' }));
    for (const line of body.split('\n').filter((l) => l.length > 0)) {
      expect(text).toContain(line);
    }
  });
});

describe('get_work_item_activity — tenancy (404-not-403), against real Postgres', () => {
  it("a token bound to workspace A cannot read workspace B's comments or history", async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const b = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });

    const secret = await makeItem(b, "B's card");
    await commentsService.addComment(secret.id, { bodyMd: 'B internal secret' }, b.ctx);

    // A aims at B's key directly — denied, and nothing of B's leaks.
    for (const view of ['all', 'comments', 'history']) {
      const res = await callActivity(a.ctx, { key: secret.key, view });
      expect(res.isError, `${view} must deny a cross-tenant read`).toBe(true);
      expect(JSON.stringify(res)).not.toContain('B internal secret');
      expect(JSON.stringify(res)).not.toContain('Rival');
    }

    // B still reads its own card fine — the denial is A's, not a broken read.
    const own = pageOf<CommentsPageDTO>(
      await callActivity(b.ctx, { key: secret.key, view: 'comments' }),
    );
    expect(own.threads[0]!.bodyMd).toBe('B internal secret');
  });

  it('an unknown key is indistinguishable from a forbidden one', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const b = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const real = await makeItem(b, "B's real card");

    // A key in a project A cannot see, and a key in a project that exists for
    // nobody — the two error texts must be the same shape (no existence leak).
    const forbidden = await callActivity(a.ctx, { key: real.key });
    const unknown = await callActivity(a.ctx, { key: 'ZZZ-9999' });
    expect(forbidden.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(textOf(forbidden)).toBe(textOf(unknown));

    // A key inside A's OWN project that simply does not exist is also not-found.
    const missingInOwn = await callActivity(a.ctx, { key: 'PROD-9999' });
    expect(missingInOwn.isError).toBe(true);
  });
});

describe('get_work_item_activity — the dogfood loop: a rationale written over MCP reads back', () => {
  it('archive a card with an add_comment rationale, then read that rationale back in one call', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Superseded by the re-plan');
    const rationale =
      'Archived by the REPLAN ACTION: superseded by PROD-2 — the card straddled two repos.';

    const client = await connectClient(fx.ctx);
    // Exactly the two writes a re-plan performs, over the MCP surface itself.
    const commented = await client.callTool({
      name: 'add_comment',
      arguments: { key: item.key, body: rationale },
    });
    expect((commented as CallToolResult).isError).toBeFalsy();
    const archived = await client.callTool({
      name: 'archive_work_item',
      arguments: { key: item.key },
    });
    expect((archived as CallToolResult).isError).toBeFalsy();

    // The loop that was write-only, closed: ONE read returns the rationale.
    const res = (await client.callTool({
      name: GET_WORK_ITEM_ACTIVITY_TOOL_NAME,
      arguments: { key: item.key },
    })) as CallToolResult;
    const page = pageOf<ActivityAllPageDto>(res);
    const comment = page.entries.find((e) => e.type === 'comment');
    expect(comment, 'the archive rationale is not in the stream').toBeTruthy();
    expect(comment!.type === 'comment' && comment!.thread.bodyMd).toBe(rationale);
    // The archive itself is in the same stream, as history.
    expect(
      page.entries.some(
        (e) => e.type === 'history' && e.entry.parts.some((p) => p.kind === 'archived'),
      ),
    ).toBe(true);
    await client.close();
  });

  it('a REPLY rides along with its root thread, in full', async () => {
    const fx = await makeWorkItemFixture();
    const item = await makeItem(fx, 'Threaded');
    const root = await commentsService.addComment(item.id, { bodyMd: 'the question' }, fx.ctx);
    await commentsService.addComment(
      item.id,
      { bodyMd: 'the answer', parentCommentId: root.id },
      fx.ctx,
    );

    const res = await callActivity(fx.ctx, { key: item.key, view: 'comments' });
    const page = pageOf<CommentsPageDTO>(res);
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]!.replies.map((r) => r.bodyMd)).toEqual(['the answer']);
    const text = textOf(res);
    expect(text).toContain('the question');
    expect(text).toContain('the answer');
    expect(text).toContain('↳ reply');
  });
});

// ───────────────────── the text renderer, branch by branch ─────────────────────
//
// The summary is total over the two closed unions the DTOs expose
// (`ActivityValueDto` and `ActivityEntryPartDto`), and driving all of them
// through real Postgres would mean manufacturing a revision per diff key. These
// are pure-function checks against synthetic DTOs — the same shapes the mappers
// emit — so every branch is pinned without the fixture cost.

/** A history entry carrying exactly the given parts. */
function entry(parts: ActivityEntryDto['parts']): ActivityEntryDto {
  return {
    id: 'rev_1',
    workItemId: 'wi_1',
    changeKind: 'updated',
    changedAt: '2026-08-02T10:00:00.000Z',
    actor: { userId: 'u_1', name: 'Yue', image: null },
    parts,
  };
}

function historyPage(entries: ActivityEntryDto[]): ActivityHistoryPageDto {
  return { entries, nextCursor: null, totalCount: entries.length };
}

describe('summarizeActivity — every part kind and value form renders', () => {
  it('renders each part kind as its own sentence fragment', () => {
    const text = summarizeActivity(
      'PROD-7',
      'history',
      historyPage([
        entry([{ kind: 'created' }]),
        entry([{ kind: 'archived' }]),
        entry([{ kind: 'unarchived' }]),
        entry([
          {
            kind: 'field',
            field: 'status',
            from: { type: 'status', key: 'todo', label: 'To Do' },
            to: { type: 'status', key: 'done', label: null },
          },
        ]),
        entry([{ kind: 'fieldEdited', field: 'description' }]),
        entry([
          {
            kind: 'link',
            op: 'added',
            linkKind: 'is_blocked_by',
            target: { type: 'issue', workItemId: 'wi_9', identifier: 'PROD-9' },
          },
        ]),
        entry([{ kind: 'collection', field: 'labels', op: 'removed', items: ['bug', 'ui'] }]),
        entry([
          {
            kind: 'commentDeleted',
            author: { type: 'user', userId: 'u_2', name: 'Mo', image: null },
            replyCount: 2,
          },
        ]),
        entry([{ kind: 'generic', key: 'mystery', from: null, to: 'x' }]),
      ]),
    );

    expect(text).toContain('created the item');
    expect(text).toContain('archived the item');
    expect(text).toContain('restored the item');
    expect(text).toContain('changed status: To Do → done'); // a null label falls back to the key
    // A body edit says so plainly — it is the trail's shape, not a truncation.
    expect(text).toContain('edited description (body not shown');
    expect(text).toContain('added is_blocked_by link → PROD-9');
    expect(text).toContain('removed labels: bug, ui');
    expect(text).toContain('deleted a comment by Mo (2 replies)');
    expect(text).toContain('mystery: — → x');
    expect(text).toContain('Yue'); // the resolved actor, on every line
  });

  it('a dismissed review names the commits and the reason, every line kept (MOTIR-10434)', () => {
    const text = summarizeActivity(
      'PROD-7',
      'history',
      historyPage([
        entry([
          {
            kind: 'reviewDismissed',
            dismissalId: 'dis_1',
            subjectVersion: 'moooon/acme#88@3f2a9c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            reasonMd: 'Out of scope.\nThe header is kept upstream.',
          },
        ]),
      ]),
    );
    expect(text).toContain("dismissed the agent's review at moooon/acme#88 @ 3f2a9c1");
    expect(text).toContain('reason: Out of scope.\n    The header is kept upstream.');
  });

  it('degrades to stored ids when the actor is gone and a generic diff side is null', () => {
    const gone: ActivityEntryDto = {
      ...entry([{ kind: 'generic', key: 'mystery', from: 'a', to: null }]),
      actor: { userId: 'u_deleted', name: null, image: null },
    };
    const text = summarizeActivity('PROD-7', 'history', historyPage([gone]));
    // A former member reads as their stored id, never as a crash or a blank.
    expect(text).toContain('u_deleted');
    expect(text).toContain('mystery: a → —');
  });

  it('renders every ActivityValueDto form, falling back to the stored id when a referent is gone', () => {
    const text = summarizeActivity(
      'PROD-7',
      'history',
      historyPage([
        entry([
          { kind: 'field', field: 'a', from: { type: 'none' }, to: { type: 'text', text: 'hi' } },
          {
            kind: 'field',
            field: 'b',
            from: { type: 'user', userId: 'u_gone', name: null, image: null },
            to: { type: 'user', userId: 'u_2', name: 'Odie', image: null },
          },
          {
            kind: 'field',
            field: 'c',
            from: { type: 'date', date: '2026-01-01' },
            to: { type: 'sprint', sprintId: 's_gone', name: null },
          },
          {
            kind: 'field',
            field: 'd',
            from: { type: 'sprint', sprintId: 's_1', name: 'Sprint 3' },
            to: { type: 'issue', workItemId: 'wi_gone', identifier: null },
          },
        ]),
      ]),
    );

    expect(text).toContain('changed a: — → hi');
    expect(text).toContain('changed b: u_gone → Odie'); // deleted user → its id
    expect(text).toContain('changed c: 2026-01-01 → s_gone'); // deleted sprint → its id
    expect(text).toContain('changed d: Sprint 3 → wi_gone'); // deleted issue → its id
  });

  it('the header reports the page size against the totals, per view', () => {
    const emptyAll: ActivityAllPageDto = {
      entries: [],
      nextCursor: 'opaque',
      totalComments: 4,
      totalChanges: 9,
      workItemRefs: {},
    };
    const allText = summarizeActivity('PROD-7', 'all', emptyAll);
    expect(allText).toContain('0 on this page');
    expect(allText).toContain('4 comments · 9 changes in total');
    expect(allText).toContain('MORE REMAINS');

    const commentsText = summarizeActivity('PROD-7', 'comments', {
      threads: [],
      totalCount: 4,
      nextCursor: null,
      order: 'asc',
      workItemRefs: {},
    });
    expect(commentsText).toContain('4 comments in total');
    expect(commentsText).toContain('End of the stream');

    const historyText = summarizeActivity('PROD-7', 'history', historyPage([]));
    expect(historyText).toContain('0 changes in total');
  });
});
