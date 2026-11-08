import { describe, expect, it } from 'vitest';
import { isReadyToStart, isToPlanStory, statusSlotOf } from '@/lib/workItems/statusSlot';

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

  it('Ready, then the status chip', () => {
    expect(statusSlotOf(task, { ready: true, blocked: false })).toBe('ready');
    expect(statusSlotOf(task, { ready: false, blocked: false })).toBe('status');
  });
});

describe('isToPlanStory', () => {
  it('is a childless story in the todo category', () => {
    expect(
      isToPlanStory({
        kind: 'story',
        status: 'backlog',
        statusCategory: 'todo',
        hasChildren: false,
      }),
    ).toBe(true);
    expect(
      isToPlanStory({
        kind: 'story',
        status: 'todo',
        statusCategory: 'in_progress',
        hasChildren: false,
      }),
    ).toBe(false);
  });

  it('needs hasChildren KNOWN false, and a story', () => {
    expect(isToPlanStory({ kind: 'story', status: 'todo', statusCategory: 'todo' })).toBe(false);
    expect(
      isToPlanStory({ kind: 'story', status: 'todo', statusCategory: 'todo', hasChildren: true }),
    ).toBe(false);
    expect(
      isToPlanStory({ kind: 'task', status: 'todo', statusCategory: 'todo', hasChildren: false }),
    ).toBe(false);
  });

  it('falls back to the default todo key when the category is missing, never a custom key', () => {
    expect(isToPlanStory({ kind: 'story', status: 'todo', hasChildren: false })).toBe(true);
    expect(isToPlanStory({ kind: 'story', status: 'backlog', hasChildren: false })).toBe(false);
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
