import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { pagesService } from '@/lib/services/pagesService';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { MCP_TOOL_REFERENCE_PAGE_URL, mcpToolDocAnchor } from '@/lib/apiDocs/mcpToolReference';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { createTestProject } from '../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { mcpRouteFetch } from '../helpers/mcpRouteFetch';

// THE RECEIPT for Story MOTIR-10869 (MOTIR-10981) — `get_page_comments` and
// `add_page_comment` reached the way an agent reaches them: through the REAL
// `/api/mcp` route, with a bearer minted by `apiTokensService.create`.
//
// The two tool cards (MOTIR-10978, MOTIR-10979) prove their adapters with a
// context handed in, which skips exactly the half of the door that decides
// whether a real credential gets through: `withMcpAuth` + `verifyMcpToken`, the
// production context and grant resolvers, and the dispatch gate. Every call in
// this file goes through `mcpRouteFetch` (the same harness as
// `story-roundtrip.test.ts`), so all of that is in the path. Real Postgres; the
// fixtures are seeded through the shipped page and page-comment services; every
// "nothing was written" claim is a READ over the same route, never a mock.
//
// Seven cases: the served surface · the read over the wire · the paged walk ·
// post-then-read-back · every refusal by its own code · the two credential
// shapes · and this file read for what it reaches.

const ENDPOINT = 'http://localhost/api/mcp';
const READ = 'get_page_comments';
const WRITE = 'add_page_comment';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Harness ─────────────────────────────────────────────────────────────────

/** An official MCP client on the real route, carrying `token` as its bearer. */
async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'page-comments-receipt', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** A PAT on the fixture's workspace, owned by its owner, granted exactly `grant`. */
async function mintToken(
  fx: WorkItemFixture,
  grant: readonly PermissionKey[],
  label: string,
): Promise<string> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label,
    fixedGrant: [...grant],
  });
  return token;
}

const fullGrant = () => [...GRANTABLE_PERMISSIONS] as PermissionKey[];

function textOf(res: unknown): string {
  const content = (res as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

/** The code a refusal leads with — the `CODE: message` shape `toolError` renders. */
function codeOf(res: unknown): string | null {
  if ((res as CallToolResult).isError !== true) return null;
  return /^([A-Z][A-Z0-9_]+):/.exec(textOf(res))?.[1] ?? null;
}

interface Person {
  id: string;
  name: string;
  image: string | null;
}
interface CommentView {
  id: string;
  parentCommentId: string | null;
  author: Person;
  bodyMd: string;
  createdAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: Person | null;
  quote: string | null;
  anchored: boolean | null;
}
interface ThreadView extends CommentView {
  replies: CommentView[];
}
interface ListView {
  threads: ThreadView[];
  nextCursor: string | null;
}
interface DiscussionView {
  pageId: string;
  counts: { open: number; resolved: number };
  open: ListView;
  resolved: ListView;
}

/** `get_page_comments` over the route; fails the test unless it answered. */
async function readDiscussion(
  client: Client,
  args: { projectKey: string; pageId: string; limit?: number; openCursor?: string },
): Promise<DiscussionView> {
  const res = await client.callTool({ name: READ, arguments: args });
  expect(res.isError, textOf(res)).toBeFalsy();
  return (res as CallToolResult).structuredContent as unknown as DiscussionView;
}

/** Whatever `get_page_comments` answers for a page — its view, or its refusal code. */
async function snapshot(client: Client, projectKey: string, pageId: string): Promise<unknown> {
  const res = await client.callTool({ name: READ, arguments: { projectKey, pageId } });
  return res.isError ? { refused: codeOf(res) } : (res as CallToolResult).structuredContent;
}

const ownerPerson = (fx: WorkItemFixture): Person => ({
  id: fx.owner.id,
  name: fx.owner.name,
  image: fx.owner.image ?? null,
});

const mentionOf = (fx: WorkItemFixture) => `[@${fx.owner.name}](mention:${fx.ownerId})`;

function newPage(fx: WorkItemFixture, title: string, projectId = fx.projectId) {
  return pagesService.createPage(fx.ctx, { projectId, title });
}

/** A second project in the fixture's workspace — the owner can browse it. */
async function secondProject(fx: WorkItemFixture) {
  return createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    identifier: 'OTHR',
  });
}

/** Every thread id an answer's open list carries, replies included. */
const idsIn = (list: ListView) =>
  list.threads.flatMap((t) => [t.id, ...t.replies.map((r) => r.id)]);

// ── 1 · The served surface ─────────────────────────────────────────────────

function referenceSentence(name: string): string {
  return `Reference: ${MCP_TOOL_REFERENCE_PAGE_URL}#${mcpToolDocAnchor(name)}`;
}

function servedTool(tools: Tool[], name: string): Tool {
  const matches = tools.filter((t) => t.name === name);
  expect(matches, `${name} in tools/list`).toHaveLength(1);
  return matches[0]!;
}

describe('page comments receipt — the served surface', () => {
  it('tools/list serves both tools with their titles, reference sentences, annotations and arguments', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connect(await mintToken(fx, fullGrant(), 'surface'));
    const { tools } = await client.listTools();

    const read = servedTool(tools, READ);
    expect(read.title).toBe('Get page comments');
    expect(read.description?.endsWith(`\n\n${referenceSentence(READ)}`)).toBe(true);
    expect(read.annotations).toEqual({
      title: 'Get page comments',
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(read.annotations).toEqual({ title: read.title, ...TOOL_ANNOTATIONS[READ] });
    expect(Object.keys(read.inputSchema.properties ?? {}).sort()).toEqual(
      ['limit', 'openCursor', 'pageId', 'projectKey', 'resolvedCursor'].sort(),
    );
    expect([...(read.inputSchema.required ?? [])].sort()).toEqual(['pageId', 'projectKey']);

    const write = servedTool(tools, WRITE);
    expect(write.title).toBe('Add page comment');
    expect(write.description?.endsWith(`\n\n${referenceSentence(WRITE)}`)).toBe(true);
    expect(write.annotations).toEqual({
      title: 'Add page comment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(write.annotations).toEqual({ title: write.title, ...TOOL_ANNOTATIONS[WRITE] });
    expect(Object.keys(write.inputSchema.properties ?? {}).sort()).toEqual(
      ['body', 'pageId', 'projectKey', 'rootCommentId'].sort(),
    );
    // `rootCommentId` is declared and optional.
    expect([...(write.inputSchema.required ?? [])].sort()).toEqual([
      'body',
      'pageId',
      'projectKey',
    ]);
    await client.close();
  });
});

// ── 2 · The read over the wire ─────────────────────────────────────────────

/** One open thread with a mention and a reply, and one resolved thread. */
async function seedDiscussion(fx: WorkItemFixture) {
  const page = await newPage(fx, 'Discussed page');
  const scope = { projectId: fx.projectId, pageId: page.id };
  const openBody = `First thought, for ${mentionOf(fx)} — \`<b>\` & *stars* stay.\n\nTwo.`;
  const open = await pageCommentsService.postPageComment(fx.ctx, { ...scope, bodyMd: openBody });
  const reply = await pageCommentsService.postPageReply(fx.ctx, {
    ...scope,
    parentCommentId: open.id,
    bodyMd: 'A reply, one level down.',
  });
  const done = await pageCommentsService.postPageComment(fx.ctx, {
    ...scope,
    bodyMd: 'Settled already.',
  });
  const resolved = await pageCommentsService.resolvePageThread(fx.ctx, {
    ...scope,
    commentId: done.id,
  });
  return { page, open, openBody, reply, done, resolved };
}

const blankResolve = { resolvedAt: null, resolvedBy: null, quote: null, anchored: null };

describe('page comments receipt — the read over the wire', () => {
  it('get_page_comments answers both lists, every field intact and the mention token unparsed', async () => {
    const fx = await makeWorkItemFixture();
    const seed = await seedDiscussion(fx);
    const client = await connect(await mintToken(fx, fullGrant(), 'read'));
    const view = await readDiscussion(client, {
      projectKey: fx.projectIdentifier,
      pageId: seed.page.id,
    });
    const owner = ownerPerson(fx);

    expect(view.pageId).toBe(seed.page.id);
    expect(view.counts).toEqual({ open: 1, resolved: 1 });
    expect(view.open).toEqual({
      nextCursor: null,
      threads: [
        {
          id: seed.open.id,
          parentCommentId: null,
          author: owner,
          bodyMd: seed.openBody,
          createdAt: seed.open.createdAt,
          editedAt: null,
          ...blankResolve,
          replies: [
            {
              id: seed.reply.id,
              parentCommentId: seed.open.id,
              author: owner,
              bodyMd: 'A reply, one level down.',
              createdAt: seed.reply.createdAt,
              editedAt: null,
              ...blankResolve,
            },
          ],
        },
      ],
    });
    // Byte for byte — the `[@Name](mention:<userId>)` token is not rendered.
    expect(view.open.threads[0]!.bodyMd).toContain(mentionOf(fx));

    expect(seed.resolved.resolvedAt).not.toBeNull();
    expect(view.resolved).toEqual({
      nextCursor: null,
      threads: [
        {
          id: seed.done.id,
          parentCommentId: null,
          author: owner,
          bodyMd: 'Settled already.',
          createdAt: seed.done.createdAt,
          editedAt: null,
          resolvedAt: seed.resolved.resolvedAt,
          resolvedBy: owner,
          quote: null,
          anchored: null,
          replies: [],
        },
      ],
    });
    await client.close();
  });
});

// ── 3 · The paged walk ─────────────────────────────────────────────────────

describe('page comments receipt — the paged walk', () => {
  it('twelve open threads walk as 5, 5 and 2 on the open cursor, each id exactly once', async () => {
    const fx = await makeWorkItemFixture();
    const page = await newPage(fx, 'Busy page');
    const seeded: string[] = [];
    for (let i = 1; i <= 12; i += 1) {
      const root = await pageCommentsService.postPageComment(fx.ctx, {
        projectId: fx.projectId,
        pageId: page.id,
        bodyMd: `Thread ${i}`,
      });
      seeded.push(root.id);
    }
    const client = await connect(await mintToken(fx, fullGrant(), 'walk'));
    const base = { projectKey: fx.projectIdentifier, pageId: page.id, limit: 5 };

    const first = await readDiscussion(client, base);
    expect(first.open.nextCursor).not.toBeNull();
    const second = await readDiscussion(client, { ...base, openCursor: first.open.nextCursor! });
    expect(second.open.nextCursor).not.toBeNull();
    const third = await readDiscussion(client, { ...base, openCursor: second.open.nextCursor! });

    const answers = [first, second, third];
    expect(answers.map((a) => a.open.threads.length)).toEqual([5, 5, 2]);
    expect(third.open.nextCursor).toBeNull();
    const walked = answers.flatMap((a) => idsIn(a.open));
    expect(walked).toHaveLength(12);
    expect(new Set(walked).size).toBe(12);
    expect([...walked].sort()).toEqual([...seeded].sort());
    for (const answer of answers) {
      expect(answer.counts).toEqual({ open: 12, resolved: 0 });
      expect(answer.resolved).toEqual({ threads: [], nextCursor: null });
    }
    await client.close();
  });
});

// ── 4 · Post, then read back ───────────────────────────────────────────────

describe('page comments receipt — post, then read back', () => {
  it('a page-level comment and a reply posted over the route come back out of the read', async () => {
    const fx = await makeWorkItemFixture();
    const page = await newPage(fx, 'Page to post on');
    const client = await connect(await mintToken(fx, fullGrant(), 'post'));
    const at = { projectKey: fx.projectIdentifier, pageId: page.id };
    const owner = ownerPerson(fx);

    const body = `Posted by an agent for ${mentionOf(fx)}.\n\n- one\n- two`;
    const posted = await client.callTool({ name: WRITE, arguments: { ...at, body } });
    expect(posted.isError, textOf(posted)).toBeFalsy();
    const root = (posted as CallToolResult).structuredContent as unknown as CommentView;
    expect(root).toEqual({
      id: expect.any(String),
      parentCommentId: null,
      author: owner,
      bodyMd: body,
      createdAt: expect.any(String),
      editedAt: null,
      ...blankResolve,
    });

    const afterRoot = await readDiscussion(client, at);
    expect(afterRoot.counts).toEqual({ open: 1, resolved: 0 });
    expect(afterRoot.open.threads).toEqual([{ ...root, replies: [] }]);

    const replyBody = `Reply to ${mentionOf(fx)}, as written.`;
    const replied = await client.callTool({
      name: WRITE,
      arguments: { ...at, body: replyBody, rootCommentId: root.id },
    });
    expect(replied.isError, textOf(replied)).toBeFalsy();
    const reply = (replied as CallToolResult).structuredContent as unknown as CommentView;
    expect(reply).toEqual({
      id: expect.any(String),
      parentCommentId: root.id,
      author: owner,
      bodyMd: replyBody,
      createdAt: expect.any(String),
      editedAt: null,
      ...blankResolve,
    });

    const afterReply = await readDiscussion(client, at);
    // Still ONE thread: the reply sits under its root, never as a root of its own.
    expect(afterReply.counts).toEqual({ open: 1, resolved: 0 });
    expect(afterReply.open.threads).toEqual([{ ...root, replies: [reply] }]);
    await client.close();
  });
});

// ── 5 · Every refusal by its own code ──────────────────────────────────────

/** The refusal world: a seeded page, a sibling page, an archived page, a foreign project's page. */
async function seedRefusalWorld(fx: WorkItemFixture) {
  const page = await newPage(fx, 'Target page');
  const scope = { projectId: fx.projectId, pageId: page.id };
  const root = await pageCommentsService.postPageComment(fx.ctx, { ...scope, bodyMd: 'Root' });
  const reply = await pageCommentsService.postPageReply(fx.ctx, {
    ...scope,
    parentCommentId: root.id,
    bodyMd: 'Reply',
  });
  const sibling = await newPage(fx, 'Sibling page');
  const siblingRoot = await pageCommentsService.postPageComment(fx.ctx, {
    projectId: fx.projectId,
    pageId: sibling.id,
    bodyMd: 'Elsewhere',
  });
  const archived = await newPage(fx, 'Archived page');
  await pageCommentsService.postPageComment(fx.ctx, {
    projectId: fx.projectId,
    pageId: archived.id,
    bodyMd: 'Before the archive',
  });
  await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: archived.id });
  const other = await secondProject(fx);
  const foreign = await newPage(fx, 'Foreign page', other.id);
  return { page, root, reply, sibling, siblingRoot, archived, other, foreign };
}

describe('page comments receipt — every refusal by its own code, nothing written', () => {
  it('six refused writes answer the package codes and leave every discussion as it was', async () => {
    const fx = await makeWorkItemFixture();
    const w = await seedRefusalWorld(fx);
    const client = await connect(await mintToken(fx, fullGrant(), 'refusals'));
    const key = fx.projectIdentifier;
    const cases: { args: Record<string, unknown>; code: string; reads: [string, string][] }[] = [
      {
        args: { pageId: w.page.id, body: 'Too deep', rootCommentId: w.reply.id },
        code: 'PAGE_COMMENT_REPLY_DEPTH_EXCEEDED',
        reads: [[key, w.page.id]],
      },
      {
        args: { pageId: w.page.id, body: ' \n\t  ' },
        code: 'PAGE_COMMENT_BODY_EMPTY',
        reads: [[key, w.page.id]],
      },
      {
        args: { pageId: w.page.id, body: 'Wrong thread', rootCommentId: w.siblingRoot.id },
        code: 'PAGE_COMMENT_NOT_FOUND',
        reads: [
          [key, w.page.id],
          [key, w.sibling.id],
        ],
      },
      {
        args: { pageId: w.archived.id, body: 'Too late' },
        code: 'PAGE_ARCHIVED',
        reads: [
          [key, w.page.id],
          [key, w.archived.id],
        ],
      },
      {
        args: { pageId: w.foreign.id, body: 'Wrong project' },
        code: 'PAGE_NOT_FOUND',
        reads: [
          [key, w.page.id],
          [w.other.identifier, w.foreign.id],
        ],
      },
      {
        args: { pageId: 'cm-no-such-page-0000000000', body: 'Nowhere' },
        code: 'PAGE_NOT_FOUND',
        reads: [[key, w.page.id]],
      },
    ];

    const codes: (string | null)[] = [];
    for (const c of cases) {
      const before = await Promise.all(c.reads.map(([k, id]) => snapshot(client, k, id)));
      // A refusal is a tool RESULT — `callTool` resolves; a JSON-RPC error would reject.
      const res = await client.callTool({ name: WRITE, arguments: { projectKey: key, ...c.args } });
      expect(res.isError, `${c.code}: ${textOf(res)}`).toBe(true);
      codes.push(codeOf(res));
      const after = await Promise.all(c.reads.map(([k, id]) => snapshot(client, k, id)));
      expect(after, `${c.code} wrote nothing`).toEqual(before);
    }
    expect(codes).toEqual(cases.map((c) => c.code));

    // The target page still holds exactly its seeded thread.
    const target = await readDiscussion(client, { projectKey: key, pageId: w.page.id });
    expect(target.counts).toEqual({ open: 1, resolved: 0 });
    expect(idsIn(target.open)).toEqual([w.root.id, w.reply.id]);
    await client.close();
  });
});

// ── 6 · The two credential shapes ──────────────────────────────────────────

describe('page comments receipt — the credential a token really holds', () => {
  it('CLI_TOKEN_GRANT, the set a device login mints, holds both tool keys', () => {
    expect(CLI_TOKEN_GRANT).toContain('page:view');
    expect(CLI_TOKEN_GRANT).toContain('comment:add');
  });

  it('a page:view-only token reads and is refused the write by the gate, writing nothing', async () => {
    const fx = await makeWorkItemFixture();
    const seed = await seedDiscussion(fx);
    const client = await connect(await mintToken(fx, ['page:view'], 'view-only'));
    const at = { projectKey: fx.projectIdentifier, pageId: seed.page.id };

    const before = await readDiscussion(client, at);
    expect(before.counts).toEqual({ open: 1, resolved: 1 });
    expect(idsIn(before.open)).toEqual([seed.open.id, seed.reply.id]);

    const res = await client.callTool({ name: WRITE, arguments: { ...at, body: 'Not allowed' } });
    expect(res.isError).toBe(true);
    expect(codeOf(res)).toBe(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('"comment:add"');

    expect(await readDiscussion(client, at)).toEqual(before);
    await client.close();
  });

  it('a token at the device grant calls both tools', async () => {
    const fx = await makeWorkItemFixture();
    const page = await newPage(fx, 'Device-granted page');
    const client = await connect(await mintToken(fx, CLI_TOKEN_GRANT, 'device-grant'));
    const at = { projectKey: fx.projectIdentifier, pageId: page.id };

    const posted = await client.callTool({ name: WRITE, arguments: { ...at, body: 'From a CLI' } });
    expect(posted.isError, textOf(posted)).toBeFalsy();
    const comment = (posted as CallToolResult).structuredContent as unknown as CommentView;

    const view = await readDiscussion(client, at);
    expect(view.counts).toEqual({ open: 1, resolved: 0 });
    expect(view.open.threads).toEqual([{ ...comment, replies: [] }]);
    await client.close();
  });
});

// ── 7 · This file, read for what it reaches ────────────────────────────────

describe('page comments receipt — the suite reaches the door and nothing behind it', () => {
  // Each needle is assembled from parts, so this block does not match itself.
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  const join = (...parts: string[]) => parts.join('');

  it('imports neither tool adapter, builds no server and hand-builds no context', () => {
    expect(source).not.toContain(join('lib/mcp/tools/', 'getPageComments'));
    expect(source).not.toContain(join('lib/mcp/tools/', 'addPageComment'));
    expect(source).not.toContain(join('buildMcp', 'Server'));
    expect(source).not.toContain(join('Service', 'Context'));
    expect(source).not.toContain(join('InMemory', 'Transport'));
  });

  it('every tool call rides one client over mcpRouteFetch with a minted token, and nothing is mocked', () => {
    const transports = source.match(
      new RegExp(join('new Streamable', 'HTTPClientTransport\\('), 'g'),
    );
    expect(transports).toHaveLength(1);
    expect(source).toContain(join('fetch: mcp', 'RouteFetch(token)'));
    expect(source.match(new RegExp(join('apiTokens', 'Service\\.create\\('), 'g'))).toHaveLength(1);
    expect(source).not.toContain(join('vi', '.mock'));
    expect(source).not.toContain(join('vi', '.fn'));
    expect(source).not.toContain(join('vi', '.spyOn'));
  });
});
