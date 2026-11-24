import { describe, expect, it } from 'vitest';
import { statusElVar, statusDotColor } from '@/lib/workflows/statusColor';

// MOTIR-1273 · 1266.2 — the shared status-dot colour helper that replaced the
// four duplicated `STATUS_CATEGORY_EL` (category-only) maps. The point of the
// change is that in_review / blocked / cancelled no longer collapse onto their
// lifecycle category's hue, so those keys must resolve to their OWN token.

describe('statusElVar — per-status --el-* token name', () => {
  it('maps each default-workflow status KEY to its dedicated --el-status-* token', () => {
    expect(statusElVar({ key: 'todo', category: 'todo' })).toBe('--el-status-todo');
    expect(statusElVar({ key: 'blocked', category: 'todo' })).toBe('--el-status-blocked');
    expect(statusElVar({ key: 'in_progress', category: 'in_progress' })).toBe(
      '--el-status-in-progress',
    );
    expect(statusElVar({ key: 'in_review', category: 'in_progress' })).toBe(
      '--el-status-in-review',
    );
    expect(statusElVar({ key: 'done', category: 'done' })).toBe('--el-status-done');
    expect(statusElVar({ key: 'cancelled', category: 'done' })).toBe('--el-status-cancelled');
  });

  it('un-collapses the statuses that share a lifecycle category', () => {
    // blocked shares category `todo` with todo; in_review shares `in_progress`;
    // cancelled shares `done`. Each must be DISTINCT from its category-mate.
    expect(statusElVar({ key: 'blocked', category: 'todo' })).not.toBe(
      statusElVar({ key: 'todo', category: 'todo' }),
    );
    expect(statusElVar({ key: 'in_review', category: 'in_progress' })).not.toBe(
      statusElVar({ key: 'in_progress', category: 'in_progress' }),
    );
    expect(statusElVar({ key: 'cancelled', category: 'done' })).not.toBe(
      statusElVar({ key: 'done', category: 'done' }),
    );
  });

  it('gives To plan its own hue, not In Progress or Planning (MOTIR-12174)', () => {
    // An in_progress-category status with no key entry would wear In Progress's
    // dot in the status picker — the collapse the planning entry exists to avoid.
    const toPlan = statusElVar({ key: 'to_plan', category: 'in_progress' });
    expect(toPlan).toBe('--el-status-to-plan');
    expect(toPlan).not.toBe(statusElVar({ key: 'in_progress', category: 'in_progress' }));
    expect(toPlan).not.toBe(statusElVar({ key: 'planning', category: 'in_progress' }));
  });

  it('falls back to the lifecycle CATEGORY token for a custom (non-default) key', () => {
    expect(statusElVar({ key: 'qa-review', category: 'in_progress' })).toBe(
      '--el-status-in-progress',
    );
    expect(statusElVar({ key: 'shipped', category: 'done' })).toBe('--el-status-done');
  });

  it('falls back to --el-status-todo for an unknown key AND category', () => {
    expect(statusElVar({ key: 'weird', category: 'mystery' as never })).toBe('--el-status-todo');
  });
});

describe('statusDotColor — resolved dot colour', () => {
  it('returns a var(--el-status-*) reference (full strength) when no hex override', () => {
    expect(statusDotColor({ key: 'in_review', category: 'in_progress', color: null })).toBe(
      'var(--el-status-in-review)',
    );
  });

  it('returns the per-status hex override verbatim when set (custom workflow colour)', () => {
    expect(statusDotColor({ key: 'todo', category: 'todo', color: '#ff8800' })).toBe('#ff8800');
  });

  it('never emits a Tier-0 --color-* token (swap-layer compliant)', () => {
    for (const s of [
      { key: 'todo', category: 'todo' as const },
      { key: 'in_review', category: 'in_progress' as const },
      { key: 'cancelled', category: 'done' as const },
    ]) {
      expect(statusDotColor({ ...s, color: null })).not.toMatch(/--color-/);
    }
  });
});
