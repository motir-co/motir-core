import { afterEach, describe, expect, it, vi } from 'vitest';

// Bug MOTIR-10023 — the reads that now resolve a surface's card links must cost
// NOTHING when the bodies link nothing: no workspace transaction, no row read. And when
// they do link, ONE read covers every body the surface draws together.

const { withWorkspaceServiceContext, findByIdsInWorkspace, getWorkspaceContext } = vi.hoisted(
  () => ({
    withWorkspaceServiceContext: vi.fn(),
    findByIdsInWorkspace: vi.fn(),
    getWorkspaceContext: vi.fn(),
  }),
);
vi.mock('@/lib/workspaces/context', () => ({
  withWorkspaceServiceContext,
  withWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/repositories/workItemRepository', () => ({
  workItemRepository: { findByIdsInWorkspace, findByIdentifiers: vi.fn() },
}));
vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext }));

import { resolveMarkdownBodiesWorkItemRefs } from '@/lib/workItems/resolveWorkItemRefs';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { resolveChatWorkItemRefsAction } from '@/app/(authed)/my-agents/_actions';

const CTX = { userId: 'u1', workspaceId: 'ws1' };

afterEach(() => vi.clearAllMocks());

function resolvesNoRows() {
  findByIdsInWorkspace.mockResolvedValue([]);
  withWorkspaceServiceContext.mockImplementation((_ws: string, fn: (tx: unknown) => unknown) =>
    fn({}),
  );
}

describe('resolveMarkdownBodiesWorkItemRefs', () => {
  it('answers {} with no query when no body links a card', async () => {
    const map = await resolveMarkdownBodiesWorkItemRefs(['plain', null, undefined, ''], CTX);
    expect(map).toEqual({});
    expect(withWorkspaceServiceContext).not.toHaveBeenCalled();
  });

  it('reads every linked id across the bodies in ONE read, skipping absent ones', async () => {
    resolvesNoRows();
    await resolveMarkdownBodiesWorkItemRefs(
      ['See [A-1](motir:id_a).', null, 'And [A-2](motir:id_b), again [A-1](motir:id_a).'],
      CTX,
    );
    expect(findByIdsInWorkspace).toHaveBeenCalledTimes(1);
    expect(findByIdsInWorkspace).toHaveBeenCalledWith(['id_a', 'id_b'], 'ws1', {});
  });
});

describe('workItemTodosService.resolveNotesRefs', () => {
  it('pays nothing for a list whose notes link nothing', async () => {
    const map = await workItemTodosService.resolveNotesRefs(
      [{ notesMd: null }, { notesMd: 'Copy the key.' }],
      CTX,
    );
    expect(map).toEqual({});
    expect(withWorkspaceServiceContext).not.toHaveBeenCalled();
  });

  it("resolves the notes' links in one read", async () => {
    resolvesNoRows();
    await workItemTodosService.resolveNotesRefs(
      [{ notesMd: 'Wait for [A-3](motir:id_c).' }, { notesMd: null }],
      CTX,
    );
    expect(findByIdsInWorkspace).toHaveBeenCalledWith(['id_c'], 'ws1', {});
  });
});

describe('resolveChatWorkItemRefsAction', () => {
  it('answers {} for a reader with no workspace', async () => {
    getWorkspaceContext.mockResolvedValue(null);
    expect(await resolveChatWorkItemRefsAction(['id_a'])).toEqual({});
    expect(withWorkspaceServiceContext).not.toHaveBeenCalled();
  });

  it("resolves the transcript's ids for the reader, de-duplicated and capped", async () => {
    getWorkspaceContext.mockResolvedValue({ userId: 'u1', workspaceId: 'ws1' });
    resolvesNoRows();
    const ids = Array.from({ length: 150 }, (_, i) => `id_${i}`);
    await resolveChatWorkItemRefsAction(['id_0', '', ...ids]);
    const [asked, ws] = findByIdsInWorkspace.mock.calls[0]!;
    expect(ws).toBe('ws1');
    expect(asked).toHaveLength(100);
    expect(asked[0]).toBe('id_0');
  });

  it('asks nothing for an empty id list', async () => {
    getWorkspaceContext.mockResolvedValue({ userId: 'u1', workspaceId: 'ws1' });
    expect(await resolveChatWorkItemRefsAction([])).toEqual({});
    expect(withWorkspaceServiceContext).not.toHaveBeenCalled();
  });
});
