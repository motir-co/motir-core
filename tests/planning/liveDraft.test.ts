import { describe, expect, it } from 'vitest';
import {
  IDLE_CUE,
  authoringTargets,
  grewLast,
  liveDraftFor,
  nextLiveCue,
  partialMarkdown,
  storedKey,
  type LiveDrafts,
} from '@/lib/planning/liveDraft';
import type { PlanItemDraftDto } from '@/lib/dto/plans';

// THE PURE RULES OF A CARD BEING WRITTEN (Story MOTIR-11190 · Subtask MOTIR-11201;
// design `design/ai-planning/design-notes.md` Part XXIX §29.2–§29.4).

function draft(over: Partial<PlanItemDraftDto> = {}): PlanItemDraftDto {
  return {
    planItemId: 'pi_1',
    sessionKey: 's1',
    seq: 1,
    title: null,
    descriptionMd: null,
    explanationMd: null,
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...over,
  };
}
const live = { live: true, proposal: true };

describe('authoringTargets', () => {
  it('takes the bare proposal id of each author step', () => {
    expect(
      [
        ...authoringTargets([
          { kind: 'author', targetRef: 'planItem:pi_1' },
          { kind: 'author', targetRef: 'pi_2' },
          { kind: 'author', targetRef: null },
          { kind: 'lay', targetRef: 'planItem:pi_3' },
        ]),
      ].sort(),
    ).toEqual(['pi_1', 'pi_2']);
  });

  it('is empty for no steps', () => {
    expect(authoringTargets(null).size).toBe(0);
    expect(authoringTargets(undefined).size).toBe(0);
  });
});

describe('liveDraftFor', () => {
  const drafts: LiveDrafts = {
    drafts: [draft({ title: 'Remember', descriptionMd: '' })],
    authoring: new Set(['pi_2']),
  };

  it('carries only the fields the draft holds', () => {
    expect(liveDraftFor(drafts, 'pi_1', live)).toEqual({
      writing: true,
      fields: { title: 'Remember', descriptionMd: '' },
    });
  });

  it('is writing with no fields when only an author step targets it', () => {
    expect(liveDraftFor(drafts, 'pi_2', live)).toEqual({ writing: true, fields: {} });
  });

  it('is null for a card nobody writes, off the overlay, or on a committed host', () => {
    expect(liveDraftFor(drafts, 'pi_9', live)).toBeNull();
    expect(liveDraftFor(drafts, 'pi_1', { live: false, proposal: true })).toBeNull();
    expect(liveDraftFor(drafts, 'pi_1', { live: true, proposal: false })).toBeNull();
    expect(liveDraftFor(null, 'pi_1', live)).toBeNull();
  });
});

describe('grewLast', () => {
  it('is the last field in reading order whose partial changed', () => {
    expect(grewLast(null, { title: 'a', descriptionMd: 'b' })).toBe('descriptionMd');
    expect(grewLast({ title: 'a', descriptionMd: 'b' }, { title: 'ab', descriptionMd: 'b' })).toBe(
      'title',
    );
    expect(grewLast({ title: 'a' }, { title: 'a', descriptionMd: 'b', explanationMd: 'c' })).toBe(
      'explanationMd',
    );
  });

  it('is null when nothing changed', () => {
    expect(grewLast({ title: 'a' }, { title: 'a' })).toBeNull();
    expect(grewLast(null, {})).toBeNull();
  });
});

describe('partialMarkdown', () => {
  it('leaves finished markdown alone', () => {
    expect(partialMarkdown('A **bold** and `code` and [a](b).')).toBe(
      'A **bold** and `code` and [a](b).',
    );
  });

  it('withholds an open strong run, an open code run and a half link at the cut', () => {
    expect(partialMarkdown('revoked by **Sign out')).toBe('revoked by Sign out');
    expect(partialMarkdown('call `revoke')).toBe('call revoke');
    expect(partialMarkdown('see [the docs')).toBe('see the docs');
    expect(partialMarkdown('see [the docs](https://exa')).toBe('see the docs');
  });

  it('withholds a block that has begun with nothing in it', () => {
    expect(partialMarkdown('Rules:\n\n- one\n- ')).toBe('Rules:\n\n- one');
    expect(partialMarkdown('Intro\n## ')).toBe('Intro');
    expect(partialMarkdown('1. ')).toBe('');
  });

  it('leaves an open fence to render as code', () => {
    const text = 'Run:\n\n```sh\nnpm run **';
    expect(partialMarkdown(text)).toBe(text);
    expect(partialMarkdown('```\na\n```\nthen **b')).toBe('```\na\n```\nthen b');
    expect(partialMarkdown('~~~\na\n```\nb')).toBe('~~~\na\n```\nb');
  });

  it('trims the trailing whitespace of the last line', () => {
    expect(partialMarkdown('Keep the  ')).toBe('Keep the');
  });
});

describe('nextLiveCue', () => {
  const A = storedKey({ title: 'T', descriptionMd: null, explanationMd: null });
  const B = storedKey({ title: 'T', descriptionMd: 'D', explanationMd: null });

  it('is writing while the card is written, and keeps its object across equal reads', () => {
    const w = nextLiveCue(IDLE_CUE, { writing: true, stored: A });
    expect(w).toEqual({ state: 'writing', storedAtWriting: A });
    expect(nextLiveCue(w, { writing: true, stored: A })).toBe(w);
    expect(nextLiveCue(w, { writing: true, stored: B })).toEqual({
      state: 'writing',
      storedAtWriting: B,
    });
  });

  it('hands over when the stored card changed, else returns to idle', () => {
    const w = nextLiveCue(IDLE_CUE, { writing: true, stored: A });
    expect(nextLiveCue(w, { writing: false, stored: B })).toEqual({
      state: 'written',
      storedAtWriting: null,
    });
    expect(nextLiveCue(w, { writing: false, stored: A })).toBe(IDLE_CUE);
  });

  it('is unchanged when not writing and not just stopped', () => {
    expect(nextLiveCue(IDLE_CUE, { writing: false, stored: A })).toBe(IDLE_CUE);
    const done = { state: 'written' as const, storedAtWriting: null };
    expect(nextLiveCue(done, { writing: false, stored: B })).toBe(done);
  });
});
