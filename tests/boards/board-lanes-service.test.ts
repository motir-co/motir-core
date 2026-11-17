import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import { InvalidBoardLaneError } from '@/lib/boards/errors';

// The FIELD lane builders' edges (MOTIR-11585) that a real database cannot reach
// — a value whose name row is gone between two reads, a Visitor's name-only
// reporter labels, a member with no name — with the repositories stubbed. The
// real-Postgres contract (predicates, counts, order) is
// `swimlane-field-lanes.test.ts`; this file only pins the fallbacks.

const repos = vi.hoisted(() => ({
  aggregateBoardLanesByField: vi.fn(),
  aggregateBoardLanesByTag: vi.fn(),
  findLaneTagValues: vi.fn(),
  findUsers: vi.fn(),
  findLabels: vi.fn(),
  findComponents: vi.fn(),
  listRepos: vi.fn(),
}));

vi.mock('@/lib/workspaces/context', () => ({
  withWorkspaceServiceContext: (_ws: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@/lib/repositories/workItemRepository', () => ({
  workItemRepository: {
    aggregateBoardLanesByField: repos.aggregateBoardLanesByField,
    aggregateBoardLanesByTag: repos.aggregateBoardLanesByTag,
    findLaneTagValues: repos.findLaneTagValues,
  },
}));
vi.mock('@/lib/repositories/userRepository', () => ({
  userRepository: { findByIds: repos.findUsers },
}));
vi.mock('@/lib/repositories/labelRepository', () => ({
  labelRepository: { findByIds: repos.findLabels },
}));
vi.mock('@/lib/repositories/componentRepository', () => ({
  componentRepository: { findByIds: repos.findComponents },
}));
vi.mock('@/lib/repositories/projectRepoRepository', () => ({
  projectRepoRepository: { listByProject: repos.listRepos },
}));

const { buildFieldSwimlanes, isFieldGroupBy, resolveFieldLane, resolveFieldLaneKeys } =
  await import('@/lib/services/boardLanesService');

const scope = (over: { nameOnly?: boolean } = {}) => ({
  projectId: 'p1',
  workspaceId: 'ws1',
  statusKeys: ['todo'],
  nameOnly: over.nameOnly ?? false,
});
const row = (over: Partial<WorkItem> & { id: string }) => over as WorkItem;

beforeEach(() => vi.clearAllMocks());

describe('isFieldGroupBy / resolveFieldLane', () => {
  it('owns the eight field dimensions and none of the shipped four', () => {
    for (const g of ['reporter', 'type', 'difficulty', 'executor', 'kind'] as const)
      expect(isFieldGroupBy(g)).toBe(true);
    for (const g of ['label', 'component', 'repository'] as const)
      expect(isFieldGroupBy(g)).toBe(true);
    for (const g of ['none', 'assignee', 'epic', 'priority'] as const)
      expect(isFieldGroupBy(g)).toBe(false);
  });

  it('refuses a dimension it does not own, and parses a tag lane', () => {
    expect(() => resolveFieldLane('assignee', 'u1')).toThrow(InvalidBoardLaneError);
    expect(resolveFieldLane('component', 'k1')).toEqual({
      kind: 'tag',
      tag: 'component',
      valueId: 'k1',
    });
    expect(resolveFieldLane('executor', 'human')).toEqual({
      kind: 'field',
      field: 'executor',
      value: 'human',
    });
  });
});

describe('resolveFieldLaneKeys', () => {
  it('keys nothing for no rows, or for a dimension it does not own', async () => {
    expect((await resolveFieldLaneKeys('type', 'p1', [], 'ws1')).size).toBe(0);
    expect((await resolveFieldLaneKeys('assignee', 'p1', [row({ id: 'w1' })], 'ws1')).size).toBe(0);
    expect(repos.findLaneTagValues).not.toHaveBeenCalled();
  });

  it('reads a single-value field off the row, the catch-all for a null', async () => {
    const keys = await resolveFieldLaneKeys(
      'difficulty',
      'p1',
      [row({ id: 'w1', difficulty: 'high' }), row({ id: 'w2', difficulty: null })],
      'ws1',
    );
    expect([...keys]).toEqual([
      ['w1', 'high'],
      ['w2', BOARD_SWIMLANE_NO_VALUE],
    ]);
  });

  it('a value with no name row ranks after every named one', async () => {
    repos.findLaneTagValues.mockResolvedValue([
      { cardId: 'w1', valueId: 'gone' },
      { cardId: 'w1', valueId: 'l1' },
      { cardId: 'w2', valueId: 'gone' },
    ]);
    repos.findLabels.mockResolvedValue([{ id: 'l1', name: 'ui' }]);
    const keys = await resolveFieldLaneKeys(
      'label',
      'p1',
      [row({ id: 'w1' }), row({ id: 'w2' })],
      'ws1',
    );
    expect(keys.get('w1')).toBe('l1');
    expect(keys.get('w2')).toBe('gone');
  });
});

describe('buildFieldSwimlanes', () => {
  it('builds nothing for a dimension it does not own', async () => {
    expect(await buildFieldSwimlanes('none', scope())).toEqual([]);
  });

  it('reporter labels: a member’s name or email, a Visitor’s name only, a vanished user named', async () => {
    repos.aggregateBoardLanesByField.mockResolvedValue([
      { value: 'u1', count: 2 },
      { value: 'u2', count: 1 },
      { value: 'u3', count: 1 },
    ]);
    repos.findUsers.mockResolvedValue([
      { id: 'u1', name: 'Ana', email: 'ana@example.com' },
      { id: 'u2', name: ' ', email: 'bob@example.com' },
    ]);
    const member = await buildFieldSwimlanes('reporter', scope());
    expect(member.map((l) => [l.key, l.label])).toEqual([
      ['u1', 'Ana'],
      ['u2', 'bob@example.com'],
      ['u3', 'Unknown user'],
    ]);
    const visitor = await buildFieldSwimlanes('reporter', scope({ nameOnly: true }));
    expect(visitor.find((l) => l.key === 'u2')!.label).not.toContain('@');
    expect(visitor.find((l) => l.key === 'u1')!.label).toBe('Ana');
  });

  it('tag lanes: a value whose name row is gone keeps its id and sorts last; no catch-all when every card has one', async () => {
    repos.aggregateBoardLanesByTag.mockResolvedValue([
      { valueId: 'gone', count: 1 },
      { valueId: 'k2', count: 1 },
      { valueId: 'k1', count: 3 },
    ]);
    repos.findComponents.mockResolvedValue([
      { id: 'k1', name: 'billing' },
      { id: 'k2', name: 'Auth' },
    ]);
    const lanes = await buildFieldSwimlanes('component', scope());
    expect(lanes.map((l) => [l.key, l.label, l.count])).toEqual([
      ['k2', 'Auth', 1],
      ['k1', 'billing', 3],
      ['gone', 'gone', 1],
    ]);
  });

  it('repository lanes: the realized GitHub name when there is one, else the planned name', async () => {
    repos.aggregateBoardLanesByTag.mockResolvedValue([
      { valueId: 'r2', count: 1 },
      { valueId: 'r1', count: 1 },
      { valueId: null, count: 2 },
    ]);
    repos.listRepos.mockResolvedValue([
      { id: 'r1', name: 'web', githubRepo: { name: 'acme-web' } },
      { id: 'r2', name: 'api', githubRepo: null },
    ]);
    const lanes = await buildFieldSwimlanes('repository', scope());
    expect(lanes.map((l) => [l.key, l.label])).toEqual([
      ['r1', 'acme-web'],
      ['r2', 'api'],
      [BOARD_SWIMLANE_NO_VALUE, 'No repository'],
    ]);
  });

  it('no lanes at all when the board holds no card', async () => {
    repos.aggregateBoardLanesByTag.mockResolvedValue([]);
    expect(await buildFieldSwimlanes('label', scope())).toEqual([]);
    expect(repos.findLabels).not.toHaveBeenCalled();
  });
});
