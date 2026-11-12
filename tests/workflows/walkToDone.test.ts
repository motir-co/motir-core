import { describe, expect, it } from 'vitest';
import type { StatusCategoryDto, WorkflowDto } from '@/lib/dto/workflows';
import { walkToDone } from '@/lib/workflows/walkToDone';

// The shortest road to Done over a workflow the caller already read (MOTIR-10162):
// the walk the init-card completion and the guided landing share.

function status(key: string, category: StatusCategoryDto) {
  return {
    id: `s-${key}`,
    projectId: 'p',
    key,
    label: key,
    category,
    color: null,
    position: key,
    isInitial: key === 'todo',
  };
}

function wf(edges: [string, string][], extra: Partial<WorkflowDto> = {}): WorkflowDto {
  return {
    statuses: [
      status('todo', 'todo'),
      status('in_progress', 'in_progress'),
      status('implemented', 'in_progress'),
      status('cancelled', 'done'),
      status('done', 'done'),
    ],
    transitions: edges.map(([from, to], i) => ({
      id: `t${i}`,
      projectId: 'p',
      fromStatusId: `s-${from}`,
      toStatusId: `s-${to}`,
    })),
    policyMode: 'restricted',
    ...extra,
  };
}

describe('walkToDone', () => {
  it('walks the declared edges, shortest first, never jumping todo → done', () => {
    const w = wf([
      ['todo', 'in_progress'],
      ['in_progress', 'implemented'],
      ['implemented', 'done'],
      ['in_progress', 'done'],
    ]);
    expect(walkToDone(w, 'todo')).toEqual(['in_progress', 'done']);
  });

  it('never walks THROUGH another terminal status', () => {
    const w = wf([
      ['todo', 'cancelled'],
      ['cancelled', 'done'],
    ]);
    expect(walkToDone(w, 'todo')).toBeNull();
  });

  it('answers [] at Done, the target directly under an open policy', () => {
    const w = wf([], { policyMode: 'open' });
    expect(walkToDone(w, 'done')).toEqual([]);
    expect(walkToDone(w, 'todo')).toEqual(['done']);
  });

  it('falls back to the first non-cancelled done-category status', () => {
    const w = wf([['todo', 'shipped']]);
    w.statuses = w.statuses.filter((s) => s.key !== 'done').concat(status('shipped', 'done'));
    expect(walkToDone(w, 'todo')).toEqual(['shipped']);
  });

  it('answers null with no target, an unknown status, or no road', () => {
    const noDone = wf([]);
    noDone.statuses = noDone.statuses.filter((s) => s.category !== 'done');
    expect(walkToDone(noDone, 'todo')).toBeNull();
    expect(walkToDone(wf([]), 'nowhere')).toBeNull();
    expect(walkToDone(wf([['todo', 'in_progress']]), 'todo')).toBeNull();
  });
});
