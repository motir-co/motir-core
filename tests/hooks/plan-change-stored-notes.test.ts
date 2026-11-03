import { describe, expect, it } from 'vitest';

import { withoutStoredNotes } from '@/lib/hooks/usePlanChangeConversation';
import { notesOfJob } from '@/components/planning/ConversationNotes';

// MOTIR-10235 — an answering session's notes stream live as `note` acts AND are
// stored against the conversation; once the answer lands the rail draws the
// stored copy above it, so the record drops the live copy of each stored one.

describe('withoutStoredNotes', () => {
  const acts = [
    { kind: 'note' as const, text: 'Reading the report service.' },
    { kind: 'note' as const, text: 'A note core refused.' },
    { kind: 'starting' as const },
  ];

  it('drops the note acts the settled thread stores, and keeps every other act', () => {
    const kept = withoutStoredNotes(acts, {
      notes: [{ body: 'Reading the report service.' }],
    });
    expect(kept).toEqual([acts[1], acts[2]]);
  });

  it('keeps the record as it is when the thread stores no notes', () => {
    expect(withoutStoredNotes(acts, { notes: [] })).toBe(acts);
    expect(withoutStoredNotes(acts, {})).toBe(acts);
    expect(withoutStoredNotes(acts, null)).toBe(acts);
  });
});

describe('notesOfJob', () => {
  const notes = [
    { jobId: 'a', body: 'one' },
    { jobId: 'b', body: 'two' },
    { jobId: 'a', body: 'three' },
  ];

  it('keeps one job’s notes in their written order', () => {
    expect(notesOfJob(notes, 'a').map((n) => n.body)).toEqual(['one', 'three']);
  });

  it('is empty with no notes or no job', () => {
    expect(notesOfJob(undefined, 'a')).toEqual([]);
    expect(notesOfJob(notes, null)).toEqual([]);
    expect(notesOfJob(notes, undefined)).toEqual([]);
  });
});
