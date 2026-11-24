import { describe, expect, it } from 'vitest';
import { buildDefaultBoard, DEFAULT_BOARD_NAME } from '@/lib/boards/defaultBoard';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

// Pure-builder unit tests for the default-board spec (Story 3.1 · Subtask
// 3.1.2). No DB — buildDefaultBoard is a pure function of its input, exactly
// like the defaultWorkflow constant. The snapshot pins the seven-column default
// projected from the seven default statuses (2.2.2, plus MOTIR-2425's
// `planning`, then MOTIR-3003's `implemented`).

// The seven default statuses as the DTOs the service feeds buildDefaultBoard —
// derived from the SAME DEFAULT_STATUSES constant createProject seeds, with
// synthetic stable ids so the snapshot is deterministic.
const defaultStatusDtos: WorkflowStatusDto[] = DEFAULT_STATUSES.map((s, i) => ({
  id: `status-${i}`,
  projectId: 'project-1',
  key: s.key,
  label: s.label,
  category: s.category,
  color: null,
  position: s.position,
  isInitial: s.isInitial,
}));

describe('buildDefaultBoard', () => {
  it('projects one Kanban board named "Board" with one column per status', () => {
    const spec = buildDefaultBoard(defaultStatusDtos);
    expect(spec.name).toBe(DEFAULT_BOARD_NAME);
    expect(spec.type).toBe('kanban');
    expect(spec.columns).toHaveLength(defaultStatusDtos.length);
  });

  it('column name + position mirror the status; each column maps its single status key', () => {
    const spec = buildDefaultBoard(defaultStatusDtos);
    expect(spec.columns.map((c) => c.name)).toEqual([
      'To Do',
      'Blocked',
      'In Progress',
      'Implemented',
      'Planning',
      'To plan',
      'In Review',
      'Approved',
      'Done',
      'Cancelled',
    ]);
    // statusKeys are the workflow keys in display order, one per column (1:1).
    expect(spec.columns.map((c) => c.statusKeys)).toEqual([
      ['todo'],
      ['blocked'],
      ['in_progress'],
      ['implemented'],
      ['planning'],
      ['to_plan'],
      ['in_review'],
      ['approved'],
      ['done'],
      ['cancelled'],
    ]);
    // Column positions mirror the source statuses' positions verbatim.
    expect(spec.columns.map((c) => c.position)).toEqual(defaultStatusDtos.map((s) => s.position));
  });

  it('orders columns by status.position regardless of input order (defensive sort)', () => {
    // Addressed BY KEY rather than by index (MOTIR-5139): the positional form
    // silently re-pointed every comment when `approved` was inserted at 6, which
    // is a shuffle that still passes while testing something else.
    const byKey = (key: string) => defaultStatusDtos.find((s) => s.key === key)!;
    const shuffled = [
      byKey('done'),
      byKey('todo'),
      byKey('approved'),
      byKey('in_progress'),
      byKey('cancelled'),
      byKey('planning'),
      byKey('blocked'),
      byKey('in_review'),
      byKey('implemented'),
    ];
    const spec = buildDefaultBoard(shuffled);
    expect(spec.columns.map((c) => c.statusKeys[0])).toEqual([
      'todo',
      'blocked',
      'in_progress',
      'implemented',
      'planning',
      'in_review',
      'approved',
      'done',
      'cancelled',
    ]);
  });

  it('is pure — does not mutate the input array', () => {
    const input = [...defaultStatusDtos];
    const snapshot = input.map((s) => s.key);
    buildDefaultBoard(input);
    expect(input.map((s) => s.key)).toEqual(snapshot);
  });

  it('matches the canonical ten-column default (snapshot)', () => {
    // Snapshot the meaningful projection — name, type, and each column's label
    // + mapped keys. The opaque fractional-index `position` is an
    // implementation detail of the workflow seed (asserted to mirror the status
    // verbatim above), so it's normalized out to keep the snapshot stable
    // across position-encoding changes.
    const spec = buildDefaultBoard(defaultStatusDtos);
    const normalized = {
      name: spec.name,
      type: spec.type,
      columns: spec.columns.map((c) => ({ name: c.name, statusKeys: c.statusKeys })),
    };
    expect(normalized).toMatchInlineSnapshot(`
      {
        "columns": [
          {
            "name": "To Do",
            "statusKeys": [
              "todo",
            ],
          },
          {
            "name": "Blocked",
            "statusKeys": [
              "blocked",
            ],
          },
          {
            "name": "In Progress",
            "statusKeys": [
              "in_progress",
            ],
          },
          {
            "name": "Implemented",
            "statusKeys": [
              "implemented",
            ],
          },
          {
            "name": "Planning",
            "statusKeys": [
              "planning",
            ],
          },
          {
            "name": "To plan",
            "statusKeys": [
              "to_plan",
            ],
          },
          {
            "name": "In Review",
            "statusKeys": [
              "in_review",
            ],
          },
          {
            "name": "Approved",
            "statusKeys": [
              "approved",
            ],
          },
          {
            "name": "Done",
            "statusKeys": [
              "done",
            ],
          },
          {
            "name": "Cancelled",
            "statusKeys": [
              "cancelled",
            ],
          },
        ],
        "name": "Board",
        "type": "kanban",
      }
    `);
  });
});
