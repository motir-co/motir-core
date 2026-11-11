import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPageComment,
  readPageThread,
  deletePageComment,
  editPageComment,
  listPageComments,
  reopenPageCommentThread,
  replyToPageComment,
  resolvePageCommentThread,
} from '@/app/(authed)/pages/[pageId]/_components/pageCommentsClient';

// The discussion's NETWORK HELPERS (Story MOTIR-10866 · MOTIR-10874): each call's
// URL, method and body, and how an answer becomes `{ ok, data }` or a refusal.
// The routes' own behaviour belongs to `tests/api/pages-comments-routes.test.ts`.

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined];

describe('pageCommentsClient', () => {
  it('lists with status, order and cursor, and answers the DTO', async () => {
    const body = { threads: [], nextCursor: null, counts: { open: 0, resolved: 0 } };
    fetchMock.mockResolvedValueOnce(json(body));
    expect(
      await listPageComments('pg 1', { status: 'resolved', order: 'desc', cursor: 'c/1' }),
    ).toEqual({ ok: true, data: body });
    expect(lastCall()[0]).toBe(
      '/api/pages/pg%201/comments?status=resolved&order=desc&cursor=c%2F1',
    );
    fetchMock.mockResolvedValueOnce(json(body));
    await listPageComments('p', { status: 'open' });
    expect(lastCall()[0]).toBe('/api/pages/p/comments?status=open');
  });

  it('reads one thread by a comment id, escaping both ids (MOTIR-10902)', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'r' }));
    expect(await readPageThread('p 1', 'c/1')).toEqual({ ok: true, data: { id: 'r' } });
    expect(lastCall()[0]).toBe('/api/pages/p%201/comments/c%2F1/thread');
    expect(lastCall()[1]).toBeUndefined();
  });

  it('sends every write to its route with its method and body', async () => {
    const cases: [() => Promise<unknown>, string, string, unknown][] = [
      [() => createPageComment('p', 'Hi'), '/api/pages/p/comments', 'POST', { bodyMd: 'Hi' }],
      [
        () => createPageComment('p', 'On this', { bytes: 'AQI=', quote: 'the passage' }),
        '/api/pages/p/comments',
        'POST',
        { bodyMd: 'On this', anchor: { bytes: 'AQI=', quote: 'the passage' } },
      ],
      [
        () => replyToPageComment('p', 'r', 'Yes'),
        '/api/pages/p/comments/r/replies',
        'POST',
        { bodyMd: 'Yes' },
      ],
      [
        () => editPageComment('p', 'c', 'New'),
        '/api/pages/p/comments/c',
        'PATCH',
        { bodyMd: 'New' },
      ],
      [() => deletePageComment('p', 'c'), '/api/pages/p/comments/c', 'DELETE', undefined],
      [
        () => resolvePageCommentThread('p', 'r'),
        '/api/pages/p/comments/r/resolution',
        'POST',
        undefined,
      ],
      [
        () => reopenPageCommentThread('p', 'r'),
        '/api/pages/p/comments/r/resolution',
        'DELETE',
        undefined,
      ],
    ];
    for (const [run, url, method, body] of cases) {
      fetchMock.mockResolvedValueOnce(json({ id: 'x' }, 201));
      expect(await run()).toEqual({ ok: true, data: { id: 'x' } });
      const [sent, init] = lastCall();
      expect(sent).toBe(url);
      expect(init?.method).toBe(method);
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
    }
  });

  it("answers a refusal with the route's status, code and message", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ code: 'PAGE_ARCHIVED', error: 'This page is archived.' }, 409),
    );
    expect(await createPageComment('p', 'x')).toEqual({
      ok: false,
      status: 409,
      code: 'PAGE_ARCHIVED',
      message: 'This page is archived.',
    });
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 502 }));
    expect(await createPageComment('p', 'x')).toEqual({
      ok: false,
      status: 502,
      code: null,
      message: 'HTTP 502',
    });
  });

  it('answers a request that never arrived as a NETWORK refusal', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await deletePageComment('p', 'c')).toEqual({
      ok: false,
      status: 0,
      code: 'NETWORK',
      message: 'Failed to fetch',
    });
    fetchMock.mockRejectedValueOnce('down');
    expect(await deletePageComment('p', 'c')).toMatchObject({
      code: 'NETWORK',
      message: 'Network error',
    });
  });
});
