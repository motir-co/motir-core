import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User, WorkItem } from '@/generated/prisma/client';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';

// The resolver behind every `motir:` chip, with its collaborators mocked: this
// file pins the SHAPE (type + assignee on the accessible branch), the
// CARDINALITY (one member read per resolution, none when nothing is assigned,
// none for a row the gate withheld) and the keying. The row-level guarantees on
// the same data are the integration gate's.

const m = vi.hoisted(() => ({
  findByIdentifiers: vi.fn(),
  findByIdsInWorkspace: vi.fn(),
  findByIdentifiersInWorkspace: vi.fn(),
  findByWorkspace: vi.fn(),
  filterBrowsable: vi.fn(),
  getStatusMetaByProjects: vi.fn(),
  findByIds: vi.fn(),
}));

vi.mock('@/lib/repositories/workItemRepository', () => ({
  workItemRepository: {
    findByIdentifiers: m.findByIdentifiers,
    findByIdsInWorkspace: m.findByIdsInWorkspace,
    findByIdentifiersInWorkspace: m.findByIdentifiersInWorkspace,
  },
}));
vi.mock('@/lib/repositories/projectRepository', () => ({
  projectRepository: { findByWorkspace: m.findByWorkspace },
}));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { filterBrowsable: m.filterBrowsable },
}));
vi.mock('@/lib/services/workflowsService', () => ({
  workflowsService: { getStatusMetaByProjects: m.getStatusMetaByProjects },
}));
vi.mock('@/lib/repositories/userRepository', () => ({
  userRepository: { findByIds: m.findByIds },
}));
vi.mock('@/lib/workspaces/context', () => ({
  withWorkspaceServiceContext: (_ws: string, fn: (tx: unknown) => unknown) => fn({}),
}));

const { resolveMarkdownWorkItemRefs, resolveWorkItemRefSummaries, splitKeyTokens } =
  await import('@/lib/workItems/resolveWorkItemRefs');

const ctx = { workspaceId: 'ws1', userId: 'u1' } as ServiceContext;

function row(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    identifier: `MOTIR-${id}`,
    title: `Title ${id}`,
    kind: 'task',
    type: 'code',
    projectId: 'p1',
    status: 'todo',
    assigneeId: null,
    archivedAt: null,
    ...over,
  } as WorkItem;
}

const member = (id: string, name: string | null, image: string | null = null) =>
  ({ id, name, image }) as User;

beforeEach(() => {
  vi.clearAllMocks();
  m.findByIdentifiers.mockResolvedValue([]);
  m.findByIdsInWorkspace.mockResolvedValue([]);
  m.findByIdentifiersInWorkspace.mockResolvedValue([]);
  m.findByWorkspace.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
  m.filterBrowsable.mockImplementation(async (projects: { id: string }[]) =>
    projects.filter((p) => p.id === 'p1'),
  );
  m.getStatusMetaByProjects.mockResolvedValue(new Map());
  m.findByIds.mockResolvedValue([]);
});

describe('resolveWorkItemRefSummaries — type and assignee', () => {
  it('carries the row type and its assignee, keyed by id and by identifier', async () => {
    m.findByIdsInWorkspace.mockResolvedValue([
      row('a', { assigneeId: 'u9' }),
      row('b', { type: null, kind: 'story' }),
    ]);
    m.findByIds.mockResolvedValue([member('u9', 'Ada', 'avatars/ada.png')]);

    const map = await resolveWorkItemRefSummaries({ ids: ['a', 'b'], keys: [] }, 'p1', ctx);

    expect(Object.keys(map).sort()).toEqual(['MOTIR-a', 'MOTIR-b', 'a', 'b']);
    expect(map['a']).toMatchObject({
      accessible: true,
      type: 'code',
      assignee: { id: 'u9', name: 'Ada', image: 'avatars/ada.png' },
    });
    // No type on a container, no assignee on an unassigned item: real nulls.
    expect(map['b']).toMatchObject({ type: null, assignee: null });
    expect(map['MOTIR-a']).toBe(map['a']);
  });

  it('reads the members in ONE call for many references, and none when nothing is assigned', async () => {
    m.findByIdsInWorkspace.mockResolvedValue([
      row('a', { assigneeId: 'u9' }),
      row('b', { assigneeId: 'u9' }),
      row('c', { assigneeId: 'u8' }),
    ]);
    m.findByIds.mockResolvedValue([member('u9', 'Ada'), member('u8', null)]);
    const map = await resolveWorkItemRefSummaries({ ids: ['a', 'b', 'c'], keys: [] }, 'p1', ctx);
    expect(m.findByIds).toHaveBeenCalledTimes(1);
    expect(m.findByIds.mock.calls[0]![0].sort()).toEqual(['u8', 'u9']);
    // A member with no display name reaches the wire as null, not a made-up label.
    expect(map['c']).toMatchObject({ assignee: { id: 'u8', name: null, image: null } });

    m.findByIds.mockClear();
    m.findByIdsInWorkspace.mockResolvedValue([row('d')]);
    await resolveWorkItemRefSummaries({ ids: ['d'], keys: [] }, 'p1', ctx);
    expect(m.findByIds).toHaveBeenCalledWith([]);
  });

  it('writes an unreadable row as exactly { accessible, id } and reads no user for it', async () => {
    m.findByIdsInWorkspace.mockResolvedValue([row('x', { projectId: 'p2', assigneeId: 'u9' })]);
    const map = await resolveWorkItemRefSummaries({ ids: ['x'], keys: [] }, 'p1', ctx);
    expect(Object.keys(map['x']!).sort()).toEqual(['accessible', 'id']);
    expect(Object.keys(map)).toEqual(['x']);
    expect(m.findByIds).toHaveBeenCalledWith([]);
  });

  it('leaves an id that resolves to nothing absent from the map', async () => {
    expect(await resolveWorkItemRefSummaries({ ids: ['gone'], keys: [] }, 'p1', ctx)).toEqual({});
  });
});

describe('resolveWorkItemRefSummaries — the Visitor arm', () => {
  const visitor = {
    kind: 'visitor',
    project: { id: 'p1', workspaceId: 'ws1' },
    hiddenIds: new Set(['h']),
  } as unknown as VisitorReadContext;

  it('resolves type and a name-only assignee from the visible set, and drops hidden / other-project rows', async () => {
    m.findByIdsInWorkspace.mockResolvedValue([
      row('v', { assigneeId: 'u9' }),
      row('h'),
      row('o', { projectId: 'p2' }),
    ]);
    m.findByIds.mockResolvedValue([member('u9', '  ', 'avatars/x.png')]);

    const map = await resolveWorkItemRefSummaries(
      { ids: ['v', 'h', 'o'], keys: [] },
      'p1',
      visitor,
    );

    expect(Object.keys(map).sort()).toEqual(['MOTIR-v', 'v']);
    expect(map['v']).toMatchObject({
      type: 'code',
      // `personName` label, never an avatar — `image: null` means withheld.
      assignee: { id: 'u9', name: 'Project member', image: null },
    });
    expect(m.findByIds).toHaveBeenCalledTimes(1);
    expect(m.findByIds).toHaveBeenCalledWith(['u9']);
  });
});

// Bug MOTIR-11281: a token written with a card's KEY where its id belongs —
// `[MOTIR-9730](motir:MOTIR-9730)` — is resolved as that key across the workspace
// and keyed by the href as written, so a stored body (a sealed decision version
// among them) draws live chips without being rewritten.
describe('resolveWorkItemRefSummaries — key-shaped tokens (MOTIR-11281)', () => {
  it('splits key-shaped tokens from ids, canonicalising each key', () => {
    expect(splitKeyTokens(['cid', 'MOTIR-7', 'motir-7', 'X-2'])).toEqual({
      ids: ['cid'],
      keys: ['MOTIR-7', 'X-2'],
      aliases: new Map([
        ['MOTIR-7', ['MOTIR-7', 'motir-7']],
        ['X-2', ['X-2']],
      ]),
    });
  });

  it('resolves a stored body’s key tokens by identifier, keyed as written, beside id tokens', async () => {
    m.findByIdsInWorkspace.mockResolvedValue([row('a')]);
    m.findByIdentifiersInWorkspace.mockResolvedValue([
      row('7'),
      row('n', { projectId: 'p2', identifier: 'OTHER-1' }),
    ]);

    const map = await resolveMarkdownWorkItemRefs(
      '[a](motir:a) [K](motir:MOTIR-7) [k](motir:motir-7) [O](motir:OTHER-1) [G](motir:MOTIR-99)',
      ctx,
    );

    expect(m.findByIdsInWorkspace).toHaveBeenCalledWith(['a'], 'ws1', {});
    expect(m.findByIdentifiersInWorkspace).toHaveBeenCalledWith(
      ['MOTIR-7', 'OTHER-1', 'MOTIR-99'],
      'ws1',
      {},
    );
    expect(map['a']).toMatchObject({ accessible: true, id: 'a' });
    expect(map['MOTIR-7']).toMatchObject({ accessible: true, id: '7', title: 'Title 7' });
    expect(map['motir-7']).toBe(map['MOTIR-7']);
    // A project the reader cannot browse: the no-access chip, under the token too.
    expect(map['OTHER-1']).toEqual({ accessible: false, id: 'n' });
    // A key naming no card stays absent: the deleted state.
    expect(map['MOTIR-99']).toBeUndefined();
  });

  it('asks for no identifier read when no token is key-shaped', async () => {
    m.findByIdsInWorkspace.mockResolvedValue([row('a')]);
    await resolveMarkdownWorkItemRefs('[a](motir:a)', ctx);
    expect(m.findByIdentifiersInWorkspace).not.toHaveBeenCalled();
  });

  it('keys a Visitor’s visible key token as written, and drops a hidden one', async () => {
    const visitor = {
      kind: 'visitor',
      project: { id: 'p1', workspaceId: 'ws1' },
      hiddenIds: new Set(['6']),
    } as unknown as VisitorReadContext;
    m.findByIdentifiersInWorkspace.mockResolvedValue([row('5'), row('6')]);

    const map = await resolveWorkItemRefSummaries(
      { ids: ['motir-5', 'MOTIR-6'], keys: [] },
      'p1',
      visitor,
    );

    expect(Object.keys(map).sort()).toEqual(['5', 'MOTIR-5', 'motir-5']);
    expect(map['motir-5']).toMatchObject({ id: '5' });
  });
});
