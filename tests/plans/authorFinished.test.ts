import { describe, expect, it } from 'vitest';
import { hasBodyBeyondBoundary } from '@/lib/plans/authorFinished';

// MOTIR-10490 — the body test the hand-written stamp (and the carry-over card,
// MOTIR-10491) asks: does a proposal's body hold anything beyond its boundary?

const BOUNDARY = '## Scope BOUNDARY\n\nIt starts at the parser and ends at the door.';

describe('hasBodyBeyondBoundary', () => {
  it('an empty, blank or missing body is not beyond its boundary', () => {
    expect(hasBodyBeyondBoundary(undefined, 'task', 'code')).toBe(false);
    expect(hasBodyBeyondBoundary(null, 'task', 'code')).toBe(false);
    expect(hasBodyBeyondBoundary('', 'task', 'code')).toBe(false);
    expect(hasBodyBeyondBoundary('  \n\n ', 'task', 'code')).toBe(false);
  });

  it('a body holding only its boundary is not beyond it — nor is an empty boundary heading', () => {
    expect(hasBodyBeyondBoundary(BOUNDARY, 'task', 'code')).toBe(false);
    expect(hasBodyBeyondBoundary('## Scope BOUNDARY\n', 'task', 'code')).toBe(false);
    expect(hasBodyBeyondBoundary('## Scope BOUNDARY:\n\n  \n', 'subtask', null)).toBe(false);
  });

  it('a boundary containing a third-level heading or a fenced block is still only a boundary', () => {
    const withSubheading = `${BOUNDARY}\n\n### It owns\n\n- the stored fact\n\n### It hands on\n\n- the readers`;
    expect(hasBodyBeyondBoundary(withSubheading, 'task', 'code')).toBe(false);
    const withFence = `${BOUNDARY}\n\n\`\`\`md\n## Acceptance criteria\n\n- not a real heading\n\`\`\``;
    expect(hasBodyBeyondBoundary(withFence, 'task', 'code')).toBe(false);
  });

  it('framing before the boundary is beyond it', () => {
    expect(hasBodyBeyondBoundary(`Why this card exists.\n\n${BOUNDARY}`, 'task', 'code')).toBe(
      true,
    );
  });

  it('another registry section is beyond it, even when the body still lacks required ones', () => {
    const partial = `${BOUNDARY}\n\n## Acceptance criteria\n\n- It stores the key.`;
    expect(hasBodyBeyondBoundary(partial, 'task', 'code')).toBe(true);
  });

  it('a heading no registry section defines is beyond it (`otherSections`)', () => {
    expect(
      hasBodyBeyondBoundary(`${BOUNDARY}\n\n## Notes\n\nA person wrote this.`, 'task', null),
    ).toBe(true);
  });

  it('a body with no headings at all is prose somebody wrote — beyond its boundary', () => {
    expect(hasBodyBeyondBoundary('Just a paragraph of prose.', 'subtask', 'code')).toBe(true);
  });

  it('reads every kind: an epic and a story judge the boundary the same way', () => {
    expect(hasBodyBeyondBoundary(BOUNDARY, 'epic', null)).toBe(false);
    expect(hasBodyBeyondBoundary(`Framing.\n\n${BOUNDARY}`, 'epic', null)).toBe(true);
    expect(hasBodyBeyondBoundary(BOUNDARY, 'story', 'code')).toBe(false);
    expect(
      hasBodyBeyondBoundary(`${BOUNDARY}\n\n## Verification recipe\n\nRun it.`, 'story', null),
    ).toBe(true);
  });

  it('never throws on a kind or type the registry has no cell for', () => {
    expect(() => hasBodyBeyondBoundary(BOUNDARY, 'initiative', 'code')).not.toThrow();
    expect(hasBodyBeyondBoundary(BOUNDARY, 'initiative', 'code')).toBe(false);
    expect(hasBodyBeyondBoundary(`Framing.\n\n${BOUNDARY}`, 'initiative', 'not-a-type')).toBe(true);
    expect(hasBodyBeyondBoundary(BOUNDARY, null, undefined)).toBe(false);
    expect(hasBodyBeyondBoundary(BOUNDARY, 'task', 'not-a-type')).toBe(false);
  });
});
