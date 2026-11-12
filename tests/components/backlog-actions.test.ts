import { describe, expect, it } from 'vitest';
import {
  boundaryRankWrite,
  bulkAssignWrite,
  bulkBacklogWrite,
  rangeIds,
  toRowSummary,
} from '@/app/(authed)/backlog/_components/backlogActions';
import type { WorkItemDto } from '@/lib/dto/workItems';

// Pure unit tests for the Subtask-4.2.5 grooming helpers (the side-effect-free
// core the coordinator drives) — the same isolation `backlog-dnd.test.ts` gives
// the drag-resolution core.

describe('rangeIds (shift-range selection)', () => {
  const ordered = ['a', 'b', 'c', 'd', 'e'];

  it('selects the inclusive contiguous range between anchor and target', () => {
    expect(rangeIds(ordered, 'b', 'd')).toEqual(['b', 'c', 'd']);
  });

  it('is order-independent — an upward range matches a downward one', () => {
    expect(rangeIds(ordered, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('a same anchor/target is a single-row range', () => {
    expect(rangeIds(ordered, 'c', 'c')).toEqual(['c']);
  });

  it('collapses to just the target when the anchor is gone (a collapsed region)', () => {
    expect(rangeIds(ordered, 'zzz', 'c')).toEqual(['c']);
  });
});

describe('bulk write builders (4.2.2 endpoints)', () => {
  it('bulkAssignWrite posts the selection to the sprint bulk route', () => {
    expect(bulkAssignWrite('sp1', ['i1', 'i2'])).toEqual({
      url: '/api/sprints/sp1/issues/bulk',
      body: { itemIds: ['i1', 'i2'] },
    });
  });

  it('bulkBacklogWrite posts the selection to the backlog bulk-move route', () => {
    expect(bulkBacklogWrite(['i1', 'i2'])).toEqual({
      url: '/api/backlog/bulk-move',
      body: { itemIds: ['i1', 'i2'] },
    });
  });
});

describe('boundaryRankWrite (⋯ move to top/bottom — 4.1.4 rankIssue)', () => {
  it('top ranks BEFORE the first row (afterId = the first neighbour)', () => {
    expect(boundaryRankWrite('i1', 'top', 'first')).toEqual({
      url: '/api/work-items/i1/rank',
      body: { afterId: 'first' },
    });
  });

  it('bottom ranks AFTER the last row (beforeId = the last neighbour)', () => {
    expect(boundaryRankWrite('i1', 'bottom', 'last')).toEqual({
      url: '/api/work-items/i1/rank',
      body: { beforeId: 'last' },
    });
  });

  it('a null neighbour (empty region) mints the sole key (open bound)', () => {
    expect(boundaryRankWrite('i1', 'top', null)).toEqual({
      url: '/api/work-items/i1/rank',
      body: { afterId: undefined },
    });
  });
});

describe('toRowSummary (created issue → row summary)', () => {
  it('projects the WorkItemDto onto the lighter summary the rows render', () => {
    const dto = {
      id: 'w1',
      projectId: 'p1',
      parentId: null,
      kind: 'story',
      key: 42,
      identifier: 'PROD-42',
      title: 'Groom the backlog',
      descriptionMd: 'body',
      status: 'todo',
      priority: 'medium',
      assigneeId: 'u1',
      reporterId: 'u2',
      position: 'a5',
      estimateMinutes: null,
      storyPoints: 3,
      sprintId: null,
      backlogRank: 'm0',
      subject: 'init',
      archivedAt: null,
      createdAt: '2026-06-09T00:00:00.000Z',
      updatedAt: '2026-06-09T00:00:00.000Z',
    } as unknown as WorkItemDto;

    expect(toRowSummary(dto)).toEqual({
      id: 'w1',
      parentId: null,
      kind: 'story',
      key: 42,
      identifier: 'PROD-42',
      title: 'Groom the backlog',
      status: 'todo',
      priority: 'medium',
      assigneeId: 'u1',
      position: 'a5',
      estimateMinutes: null,
      storyPoints: 3,
      // Carried from the source DTO (MOTIR-11053), never defaulted.
      subject: 'init',
      archivedAt: null,
    });
  });
});
