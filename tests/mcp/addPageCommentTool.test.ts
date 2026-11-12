import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PageArchivedError,
  PageCommentBodyEmptyError,
  PageCommentNotFoundError,
  PageCommentReplyDepthError,
  PageNotFoundError,
  type PageCommentDto,
  type PageCommentThreadDto,
} from '@/lib/pages';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// `add_page_comment` (MOTIR-10979) — the FIXTURE-ONLY spec: the adapter routes
// to the right service method, hands the body over byte for byte, answers ONE
// comment shape from both paths, and lets every refusal reach the tool result
// by its own code. No database: the comments service and the project lookup are
// stubbed, so what is pinned is the adapter adding nothing of its own. That a
// real row landed, or a real refusal wrote none, is the integration gate's.

const svc = vi.hoisted(() => ({
  postPageComment: vi.fn(),
  postPageReply: vi.fn(),
  getByKey: vi.fn(),
}));
vi.mock('@/lib/services/pageCommentsService', () => ({
  pageCommentsService: { postPageComment: svc.postPageComment, postPageReply: svc.postPageReply },
}));
vi.mock('@/lib/services/projectsService', () => ({ projectsService: { getByKey: svc.getByKey } }));

const { ADD_PAGE_COMMENT_TOOL_NAME, registerAddPageComment, runAddPageComment } =
  await import('@/lib/mcp/tools/addPageComment');

const ctx = { userId: 'usr_agent', workspaceId: 'ws_1' } as unknown as ServiceContext;
const agent = { id: 'usr_agent', name: 'Agent Owner', image: null };
const BODY = 'Checked this with [@Grace Hopper](mention:usr_grace) — `<b>` & *stars* stay.\n\nTwo.';

function comment(over: Partial<PageCommentDto> = {}): PageCommentDto {
  return {
    id: 'cmt_new',
    pageId: 'pg_1',
    parentCommentId: null,
    author: agent,
    bodyMd: BODY,
    editedAt: null,
    createdAt: '2026-11-11T12:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    anchor: null,
    ...over,
  };
}

const threadAnswer: PageCommentThreadDto & { workItemRefs: object } = {
  ...comment(),
  replies: [],
  workItemRefs: { cmwork123: { key: 'ACME-1' } },
};
const replyAnswer = {
  ...comment({ id: 'cmt_reply', parentCommentId: 'cmt_root' }),
  workItemRefs: {},
};

const textOf = (r: { content: unknown }) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  svc.getByKey.mockResolvedValue({ id: 'prj_1', identifier: 'ACME' });
  svc.postPageComment.mockResolvedValue(threadAnswer);
  svc.postPageReply.mockResolvedValue(replyAnswer);
});

const VIEW_KEYS = [
  'anchored',
  'author',
  'bodyMd',
  'createdAt',
  'editedAt',
  'id',
  'parentCommentId',
  'quote',
  'resolvedAt',
  'resolvedBy',
];

describe('add_page_comment — routing', () => {
  it('without rootCommentId posts a page-level thread through postPageComment, context first', async () => {
    const result = await runAddPageComment(
      { projectKey: ' acme ', pageId: 'pg_1', body: BODY },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(svc.getByKey).toHaveBeenCalledTimes(1);
    expect(svc.getByKey).toHaveBeenCalledWith('ACME', ctx);
    expect(svc.postPageComment).toHaveBeenCalledTimes(1);
    expect(svc.postPageComment).toHaveBeenCalledWith(ctx, {
      projectId: 'prj_1',
      pageId: 'pg_1',
      bodyMd: BODY,
    });
    expect(svc.postPageReply).not.toHaveBeenCalled();
    // The body reaches the service byte for byte — the mention token unparsed.
    expect(svc.postPageComment.mock.calls[0]![1].bodyMd).toBe(BODY);

    const payload = result.structuredContent as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(VIEW_KEYS);
    expect(payload).toEqual({
      id: 'cmt_new',
      parentCommentId: null,
      author: agent,
      bodyMd: BODY,
      createdAt: '2026-11-11T12:00:00.000Z',
      editedAt: null,
      resolvedAt: null,
      resolvedBy: null,
      quote: null,
      anchored: null,
    });
    const text = textOf(result);
    expect(text).toContain('Commented on page pg_1 · comment id: cmt_new');
    expect(text).toContain('[comment cmt_new]');
    expect(text).toContain('[@Grace Hopper](mention:usr_grace)');
  });

  it('with rootCommentId replies through postPageReply, the id as parentCommentId', async () => {
    const result = await runAddPageComment(
      { projectKey: 'ACME', pageId: 'pg_1', body: BODY, rootCommentId: 'cmt_root' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(svc.postPageReply).toHaveBeenCalledTimes(1);
    expect(svc.postPageReply).toHaveBeenCalledWith(ctx, {
      projectId: 'prj_1',
      pageId: 'pg_1',
      parentCommentId: 'cmt_root',
      bodyMd: BODY,
    });
    expect(svc.postPageComment).not.toHaveBeenCalled();

    const payload = result.structuredContent as Record<string, unknown>;
    // ONE shape from both paths: the same keys, no `replies`, no chip map.
    expect(Object.keys(payload).sort()).toEqual(VIEW_KEYS);
    expect(payload.id).toBe('cmt_reply');
    expect(payload.parentCommentId).toBe('cmt_root');
    expect(payload.bodyMd).toBe(BODY);
    expect(textOf(result)).toContain(
      'Replied on page pg_1 in thread cmt_root · comment id: cmt_reply',
    );
  });
});

describe('add_page_comment — every refusal arrives by its own code', () => {
  const cases: [string, () => Error, Record<string, string>][] = [
    ['PAGE_NOT_FOUND', () => new PageNotFoundError('pg_1'), {}],
    ['PAGE_ARCHIVED', () => new PageArchivedError('pg_1'), {}],
    [
      'PAGE_COMMENT_REPLY_DEPTH_EXCEEDED',
      () => new PageCommentReplyDepthError('cmt_reply'),
      { rootCommentId: 'cmt_reply' },
    ],
    ['PAGE_COMMENT_BODY_EMPTY', () => new PageCommentBodyEmptyError(), {}],
    [
      'PAGE_COMMENT_NOT_FOUND',
      () => new PageCommentNotFoundError('cmt_foreign'),
      { rootCommentId: 'cmt_foreign' },
    ],
    ['PERMISSION_DENIED', () => new PermissionDeniedError('prj_1', 'comment:add'), {}],
  ];

  it.each(cases)('%s', async (code, make, extra) => {
    const err = make();
    const method = extra.rootCommentId ? svc.postPageReply : svc.postPageComment;
    method.mockRejectedValueOnce(err);

    const result = await runAddPageComment(
      { projectKey: 'ACME', pageId: 'pg_1', body: '  ', ...extra },
      ctx,
    );

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain(code);
    expect(text).toContain(err.message);
    // The adapter issues no write of its own, and never retries down the other path.
    expect(svc.postPageComment.mock.calls.length + svc.postPageReply.mock.calls.length).toBe(1);
  });

  it('a project the token cannot see is refused before any write', async () => {
    svc.getByKey.mockRejectedValueOnce(new ProjectNotFoundError('NOPE'));
    const result = await runAddPageComment({ projectKey: 'NOPE', pageId: 'pg_1', body: 'x' }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PROJECT_NOT_FOUND');
    expect(svc.postPageComment).not.toHaveBeenCalled();
    expect(svc.postPageReply).not.toHaveBeenCalled();
  });
});

describe('add_page_comment — registration', () => {
  it('registers under its name with the inputs and a handler bound to the resolved context', async () => {
    const registerTool = vi.fn();
    const resolveContext = vi.fn(() => ctx);
    registerAddPageComment({ registerTool } as never, resolveContext);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [name, config, handler] = registerTool.mock.calls[0]!;
    expect(name).toBe(ADD_PAGE_COMMENT_TOOL_NAME);
    expect(name).toBe('add_page_comment');
    expect(config.title).toBe('Add page comment');
    expect(Object.keys(config.inputSchema).sort()).toEqual([
      'body',
      'pageId',
      'projectKey',
      'rootCommentId',
    ]);
    for (const code of [
      'PAGE_NOT_FOUND',
      'PAGE_ARCHIVED',
      'PAGE_COMMENT_NOT_FOUND',
      'PAGE_COMMENT_REPLY_DEPTH_EXCEEDED',
      'PAGE_COMMENT_BODY_EMPTY',
      'PERMISSION_DENIED',
    ]) {
      expect(config.description).toContain(code);
    }

    const extra = { authInfo: {} };
    const result = await handler({ projectKey: 'ACME', pageId: 'pg_1', body: BODY }, extra);
    expect(resolveContext).toHaveBeenCalledWith(extra);
    expect(result.isError).toBeFalsy();
    expect(svc.postPageComment).toHaveBeenCalledTimes(1);
  });

  it('the body field refuses an empty string and rootCommentId is optional', async () => {
    const registerTool = vi.fn();
    registerAddPageComment({ registerTool } as never, vi.fn());
    const schema = registerTool.mock.calls[0]![1].inputSchema;
    expect(schema.body.safeParse('').success).toBe(false);
    expect(schema.rootCommentId.safeParse(undefined).success).toBe(true);
    expect(schema.rootCommentId.safeParse('  ').success).toBe(false);
  });
});
