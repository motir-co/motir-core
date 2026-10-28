// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ChatRow } from '@/app/(authed)/my-agents/_components/chat/transcriptModel';
import type { WorkItemRefMap, WorkItemRefSummaryDto } from '@/lib/dto/workItems';

// THE CARD LINKS IN AN AGENT CHAT (bug MOTIR-10023) — the transcript's hook and the
// Server Action it asks, under the agent-instances lane's per-file floor. The
// transcript's own suites never link a card, so neither file is reached there.

const workspace = vi.hoisted(() => ({
  ctx: null as { userId: string; workspaceId: string } | null,
}));
vi.mock('@/lib/workspaces', () => ({
  getWorkspaceContext: async () => workspace.ctx,
}));

const resolver = vi.hoisted(() => ({
  calls: [] as unknown[][],
  answer: {} as Record<string, unknown>,
}));
vi.mock('@/lib/workItems/resolveWorkItemRefs', () => ({
  resolveWorkItemRefSummaries: async (...args: unknown[]) => {
    resolver.calls.push(args);
    return resolver.answer;
  },
}));

const { resolveChatWorkItemRefsAction } = await import('@/app/(authed)/my-agents/_actions');

describe('resolveChatWorkItemRefsAction', () => {
  beforeEach(() => {
    workspace.ctx = { userId: 'u1', workspaceId: 'w1' };
    resolver.calls = [];
    resolver.answer = {};
  });

  it('answers nothing, and reads nothing, for a reader with no workspace', async () => {
    workspace.ctx = null;
    await expect(resolveChatWorkItemRefsAction(['a'])).resolves.toEqual({});
    expect(resolver.calls).toHaveLength(0);
  });

  it('resolves the asked ids once each, as the reader, across the workspace', async () => {
    resolver.answer = { a: { accessible: false } };
    const map = await resolveChatWorkItemRefsAction(['a', 'b', 'a', '']);
    expect(map).toEqual({ a: { accessible: false } });
    expect(resolver.calls).toEqual([
      [{ ids: ['a', 'b'], keys: [] }, '', { userId: 'u1', workspaceId: 'w1' }],
    ]);
  });

  it('drops anything that is not an id string, and caps one call at 100 ids', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id${i}`);
    await resolveChatWorkItemRefsAction([...ids, 7 as unknown as string]);
    const [refs] = resolver.calls[0] as [{ ids: string[] }];
    expect(refs.ids).toHaveLength(100);
    expect(refs.ids[0]).toBe('id0');
    expect(refs.ids[99]).toBe('id99');
  });
});

// ── the hook, with the action at its module boundary ────────────────────────
const action = {
  calls: [] as string[][],
  next: [] as Array<() => Promise<WorkItemRefMap>>,
};

const summary = (id: string, identifier: string): WorkItemRefSummaryDto =>
  ({
    accessible: true,
    id,
    identifier,
    title: `Card ${identifier}`,
    kind: 'task',
    archived: false,
    status: null,
  }) as unknown as WorkItemRefSummaryDto;

const text = (key: string, body: string): ChatRow => ({ type: 'text', key, text: body });

describe('useChatWorkItemRefs', () => {
  let useChatWorkItemRefs: (rows: readonly ChatRow[]) => WorkItemRefMap;

  beforeEach(async () => {
    action.calls = [];
    action.next = [];
    vi.resetModules();
    vi.doMock('@/app/(authed)/my-agents/_actions', () => ({
      resolveChatWorkItemRefsAction: (ids: string[]) => {
        action.calls.push(ids);
        const answer = action.next.shift();
        return answer ? answer() : Promise.resolve({});
      },
    }));
    ({ useChatWorkItemRefs } =
      await import('@/app/(authed)/my-agents/_components/chat/useChatWorkItemRefs'));
  });

  afterEach(() => {
    vi.doUnmock('@/app/(authed)/my-agents/_actions');
  });

  it('asks nothing for a transcript that links no card, nor for rows that are not text', () => {
    const rows: ChatRow[] = [
      { type: 'user', key: 'u', text: 'see [MOTIR-1](motir:abc)' },
      text('t', 'no links here'),
      { type: 'other', key: 'o', name: 'x' },
    ];
    const { result } = renderHook(() => useChatWorkItemRefs(rows));
    expect(result.current).toEqual({});
    expect(action.calls).toHaveLength(0);
  });

  it('asks for each id once, and merges every answer into the chips', async () => {
    action.next.push(async () => ({ abc: summary('abc', 'MOTIR-1') }));
    action.next.push(async () => ({ def: summary('def', 'MOTIR-2') }));
    let rows: ChatRow[] = [text('t1', 'see [MOTIR-1](motir:abc) and [MOTIR-1](motir:abc)')];
    const { result, rerender } = renderHook(() => useChatWorkItemRefs(rows));
    await waitFor(() => expect(result.current.abc).toBeDefined());
    expect(action.calls).toEqual([['abc']]);

    // A second row streams in: only the id not yet asked for is asked.
    rows = [...rows, text('t2', 'and [MOTIR-2](motir:def), again [MOTIR-1](motir:abc)')];
    rerender();
    await waitFor(() => expect(result.current.def).toBeDefined());
    expect(action.calls).toEqual([['abc'], ['def']]);
    expect(Object.keys(result.current).sort()).toEqual(['abc', 'def']);

    // Re-rendering the same ids asks nothing more.
    rerender();
    await act(async () => {});
    expect(action.calls).toHaveLength(2);
  });

  it('a failed read leaves the chips as drawn and never asks for that id again', async () => {
    action.next.push(() => Promise.reject(new Error('offline')));
    let rows: ChatRow[] = [text('t1', '[MOTIR-3](motir:ghi)')];
    const { result, rerender } = renderHook(() => useChatWorkItemRefs(rows));
    await act(async () => {});
    expect(result.current).toEqual({});
    rows = [text('t1', '[MOTIR-3](motir:ghi) still')];
    rerender();
    await act(async () => {});
    expect(action.calls).toEqual([['ghi']]);
  });
});
