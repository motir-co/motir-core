import { describe, expect, it } from 'vitest';
import {
  isBlockedNotStarted,
  isReadyToStart,
  isToPlanItem,
  statusSlotOf,
} from '@/lib/workItems/statusSlot';

// The status slot's precedence (MOTIR-10534; design MOTIR-10508): Done › To plan ›
// Ready › the status chip — the one rule the canvas, the board, the quick view and
// the item page all draw from. The canvas's You are here is no part of it: since
// MOTIR-10630 it is a tab on the card, and the here card's slot is its own.

const task = { kind: 'task', status: 'in_progress', statusCategory: 'in_progress' as const };

describe('statusSlotOf', () => {
  it('Done is the done key, unless the item is blocked', () => {
    const done = { ...task, status: 'done', statusCategory: 'done' as const };
    expect(statusSlotOf(done, { ready: false, blocked: false })).toBe('done');
    expect(statusSlotOf(done, { ready: false, blocked: true })).toBe('status');
  });

  it('To plan outranks Ready', () => {
    const story = {
      kind: 'story',
      status: 'todo',
      statusCategory: 'todo' as const,
      hasChildren: false,
    };
    expect(statusSlotOf(story, { ready: true, blocked: false })).toBe('to-plan');
  });

  // MOTIR-10861: a childless todo-category epic is To plan too, ready or not.
  it('a childless To Do epic is To plan, ready or not', () => {
    const epic = {
      kind: 'epic',
      status: 'todo',
      statusCategory: 'todo' as const,
      hasChildren: false,
    };
    expect(statusSlotOf(epic, { ready: true, blocked: false })).toBe('to-plan');
    expect(statusSlotOf(epic, { ready: false, blocked: false })).toBe('to-plan');
    expect(statusSlotOf({ ...epic, hasChildren: true }, { ready: true, blocked: false })).toBe(
      'ready',
    );
  });

  it('Ready, then the status chip', () => {
    expect(statusSlotOf(task, { ready: true, blocked: false })).toBe('ready');
    expect(statusSlotOf(task, { ready: false, blocked: false })).toBe('status');
  });
});

// MOTIR-11546: a story HELD out of planning — blocked by an unfinished story with
// no subtasks yet — is not To plan on any surface; it falls through to the chip.
describe('a story held out of planning', () => {
  const story = {
    kind: 'story',
    status: 'todo',
    statusCategory: 'todo' as const,
    hasChildren: false,
  };

  it('is not To plan, and its slot is the status chip', () => {
    expect(isToPlanItem({ ...story, planHeld: true })).toBe(false);
    // Held means an open blocker, so the story is never ready.
    expect(statusSlotOf({ ...story, planHeld: true }, { ready: false, blocked: true })).toBe(
      'status',
    );
  });

  it('released, or never computed, it is To plan as before', () => {
    expect(isToPlanItem({ ...story, planHeld: false })).toBe(true);
    expect(isToPlanItem(story)).toBe(true);
    expect(statusSlotOf({ ...story, planHeld: false }, { ready: false, blocked: true })).toBe(
      'to-plan',
    );
  });
});

describe('isToPlanItem', () => {
  it('is a childless story in the todo category', () => {
    expect(
      isToPlanItem({
        kind: 'story',
        status: 'backlog',
        statusCategory: 'todo',
        hasChildren: false,
      }),
    ).toBe(true);
    expect(
      isToPlanItem({
        kind: 'story',
        status: 'todo',
        statusCategory: 'in_progress',
        hasChildren: false,
      }),
    ).toBe(false);
  });

  it('is a childless epic in the todo category, Blocked included (MOTIR-10861)', () => {
    const epic = {
      kind: 'epic',
      status: 'todo',
      statusCategory: 'todo' as const,
      hasChildren: false,
    };
    expect(isToPlanItem(epic)).toBe(true);
    expect(isToPlanItem({ ...epic, status: 'blocked' })).toBe(true);
    expect(isToPlanItem({ ...epic, hasChildren: true })).toBe(false);
    expect(isToPlanItem({ kind: 'epic', status: 'todo', statusCategory: 'todo' })).toBe(false);
    expect(
      isToPlanItem({ ...epic, status: 'in_progress', statusCategory: 'in_progress' as const }),
    ).toBe(false);
    expect(isToPlanItem({ ...epic, status: 'done', statusCategory: 'done' as const })).toBe(false);
  });

  it.each(['task', 'bug', 'subtask'])('is never a %s, a leaf', (kind) => {
    expect(isToPlanItem({ kind, status: 'todo', statusCategory: 'todo', hasChildren: false })).toBe(
      false,
    );
  });

  it('needs hasChildren KNOWN false, and a story or an epic', () => {
    expect(isToPlanItem({ kind: 'story', status: 'todo', statusCategory: 'todo' })).toBe(false);
    expect(
      isToPlanItem({ kind: 'story', status: 'todo', statusCategory: 'todo', hasChildren: true }),
    ).toBe(false);
    expect(
      isToPlanItem({ kind: 'task', status: 'todo', statusCategory: 'todo', hasChildren: false }),
    ).toBe(false);
  });

  it('falls back to the default todo key when the category is missing, never a custom key', () => {
    expect(isToPlanItem({ kind: 'story', status: 'todo', hasChildren: false })).toBe(true);
    expect(isToPlanItem({ kind: 'story', status: 'backlog', hasChildren: false })).toBe(false);
  });
});

describe('isReadyToStart', () => {
  it('is a todo-category status that is fully unblocked', () => {
    expect(isReadyToStart('todo', true)).toBe(true);
    expect(isReadyToStart('todo', false)).toBe(false);
    expect(isReadyToStart('in_progress', true)).toBe(false);
    expect(isReadyToStart(null, true)).toBe(false);
    expect(isReadyToStart(undefined, true)).toBe(false);
  });
});

// MOTIR-11323 — the Blocked flag rule: a todo-CATEGORY item with an open blocker.
describe('isBlockedNotStarted', () => {
  it('flags a built-in todo-category status (To Do, Blocked) with an open blocker', () => {
    expect(isBlockedNotStarted('todo', false)).toBe(true);
  });

  it('flags a custom todo-category status exactly like the built-in ones', () => {
    // The helper takes the CATEGORY, so a custom "Ready for dev" in the todo
    // category reaches it as 'todo' and flags the same way.
    const customReadyForDev = { key: 'ready_for_dev', category: 'todo' as const };
    expect(isBlockedNotStarted(customReadyForDev.category, false)).toBe(true);
  });

  it('never flags an in-progress-category status, built-in or custom', () => {
    expect(isBlockedNotStarted('in_progress', false)).toBe(false);
    const customQaReview = { key: 'qa_review', category: 'in_progress' as const };
    expect(isBlockedNotStarted(customQaReview.category, false)).toBe(false);
  });

  it('never flags a done-category status, nor an unknown category', () => {
    expect(isBlockedNotStarted('done', false)).toBe(false);
    expect(isBlockedNotStarted(null, false)).toBe(false);
    expect(isBlockedNotStarted(undefined, false)).toBe(false);
  });

  it('never flags an unblocked item', () => {
    expect(isBlockedNotStarted('todo', true)).toBe(false);
  });
});
