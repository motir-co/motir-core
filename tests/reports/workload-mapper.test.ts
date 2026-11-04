import { describe, expect, it } from 'vitest';
import { toWorkloadDto } from '@/lib/mappers/reportsMappers';

// Story MOTIR-8919 — toWorkloadDto: the segment fields, ranking by the bar's
// TOTAL with the person-less bar last, one-decimal rounding, and the empty /
// window shapes. PURE — no I/O.

const seg = (
  assignedPoints: number,
  assignedCount: number,
  unassignedPoints: number,
  unassignedCount: number,
) => ({ assignedPoints, assignedCount, unassignedPoints, unassignedCount });

describe('toWorkloadDto', () => {
  it('treats a snapshot row (no segment fields) as all-assigned, unassigned 0', () => {
    const dto = toWorkloadDto('story_points', [
      { assigneeId: 'u1', name: 'Bo', points: 5, count: 2 },
      { assigneeId: null, name: null, points: 3, count: 1 },
    ]);
    expect(dto.window).toBeNull();
    expect(dto.assignees[0]).toMatchObject({
      assignedPoints: 5,
      assignedCount: 2,
      unassignedPoints: 0,
      unassignedCount: 0,
    });
    // the person-less bar carries only totals
    expect(dto.assignees[1]).toMatchObject({
      assignedPoints: 0,
      assignedCount: 0,
      unassignedPoints: 0,
      unassignedCount: 0,
    });
  });

  it('carries the windowed segment split and ranks by TOTAL, person-less bar last', () => {
    const dto = toWorkloadDto(
      'story_points',
      [
        { assigneeId: null, name: null, points: 90, count: 9 },
        { assigneeId: 'a', name: 'Ann', points: 10, count: 2, ...seg(10, 2, 0, 0) },
        { assigneeId: 'b', name: 'Ben', points: 12, count: 3, ...seg(4, 1, 8, 2) },
      ],
      {
        daysBack: 30,
        windowStart: new Date('2026-09-18T00:00:00Z'),
        windowEnd: new Date('2026-10-18T00:00:00Z'),
      },
    );
    expect(dto.assignees.map((a) => a.name)).toEqual(['Ben', 'Ann', null]);
    expect(dto.assignees[0]).toMatchObject({
      points: 12,
      assignedPoints: 4,
      unassignedPoints: 8,
      unassignedCount: 2,
    });
    expect(dto.window).toEqual({
      daysBack: 30,
      windowStart: '2026-09-18T00:00:00.000Z',
      windowEnd: '2026-10-18T00:00:00.000Z',
    });
    expect(dto.totalPoints).toBe(112);
    expect(dto.totalCount).toBe(14);
  });

  it('ranks by count when the measure is issue_count', () => {
    const dto = toWorkloadDto('issue_count', [
      { assigneeId: 'a', name: 'Ann', points: 50, count: 1, ...seg(50, 1, 0, 0) },
      { assigneeId: 'b', name: 'Ben', points: 2, count: 4, ...seg(2, 4, 0, 0) },
    ]);
    expect(dto.assignees.map((a) => a.name)).toEqual(['Ben', 'Ann']);
  });

  it('rounds points and segment points to one decimal', () => {
    const dto = toWorkloadDto('story_points', [
      { assigneeId: 'a', name: 'Ann', points: 3.14159, count: 1, ...seg(1.26, 1, 1.88, 0) },
    ]);
    expect(dto.assignees[0]).toMatchObject({
      points: 3.1,
      assignedPoints: 1.3,
      unassignedPoints: 1.9,
    });
    expect(dto.totalPoints).toBe(3.1);
  });

  it('an empty set is zeros, never NaN', () => {
    const dto = toWorkloadDto('story_points', []);
    expect(dto).toEqual({
      measure: 'story_points',
      assignees: [],
      totalPoints: 0,
      totalCount: 0,
      window: null,
    });
  });
});
