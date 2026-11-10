import { describe, expect, it } from 'vitest';

// MOTIR-10865 — the server's own read of "has the person already acted on the
// question the last planner turn asked?". `act` refuses a second answer on it,
// because a failed read leaves the answered question stored.

import type { SharpenTurn } from '@/generated/prisma/client';
import { questionActedOn } from '@/lib/mappers/sharpenMappers';

function turn(
  seq: number,
  role: SharpenTurn['role'],
  extra: Partial<SharpenTurn> = {},
): SharpenTurn {
  return {
    id: `st${seq}`,
    workspaceId: 'w1',
    sessionId: 'sh1',
    seq,
    role,
    action: role === 'person' ? 'answer' : null,
    body: 'body',
    readingId: null,
    jobId: `sj${seq}`,
    record: null,
    authorId: role === 'person' ? 'u1' : null,
    createdAt: new Date('2026-11-10T10:00:00.000Z'),
    ...extra,
  };
}

const start = turn(1, 'person', { action: 'start' });
const asked = turn(2, 'planner', { record: { kind: 'question' } });
const answered = turn(3, 'person');
const failed = turn(4, 'planner', { record: { failed: true, reason: 'turn_failed' } });

describe('questionActedOn', () => {
  it('is false with no planner turn yet, and while the asked question waits', () => {
    expect(questionActedOn([])).toBe(false);
    expect(questionActedOn([start])).toBe(false);
    expect(questionActedOn([start, asked])).toBe(false);
  });

  it('is true once a person turn follows the question, while its read runs or after it failed', () => {
    expect(questionActedOn([start, asked, answered])).toBe(true);
    expect(questionActedOn([start, asked, answered, failed])).toBe(true);
  });

  it('a failed first read leaves nothing asked to act on', () => {
    expect(questionActedOn([start, turn(2, 'planner', { record: { failed: true } })])).toBe(false);
  });

  it('is false again once the next planner turn asks a new question', () => {
    const next = turn(5, 'planner', { record: { kind: 'question' } });
    expect(questionActedOn([start, asked, answered, failed, next])).toBe(false);
  });
});
