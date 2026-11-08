import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ACK_MAX_CHARS,
  conversationAckText,
  FRAME_DISPOSITIONS,
  PLAN_CHANGE_FRAME_KINDS,
} from '@/lib/planning/planChangeFrames';
import { conversationAckFor } from '@/lib/planning/planRunPhase';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// PART 1's QUICK REPLY (MOTIR-10738): `event: conversation_ack` → `{ text }`. Core
// accepts the kind before motir-ai emits it, reads its text defensively, and the
// conversation bubble draws it only for the run on screen while it converses.

describe('the `conversation_ack` frame kind', () => {
  it('is listed, in the sweep’s sorted place, and quiet with a reason', () => {
    const at = PLAN_CHANGE_FRAME_KINDS.indexOf('conversation_ack');
    expect(at).toBeGreaterThan(-1);
    expect(PLAN_CHANGE_FRAME_KINDS[at - 1]).toBe('conversation');
    const disposition = FRAME_DISPOSITIONS.conversation_ack;
    expect(disposition).toHaveProperty('quiet');
    expect((disposition as { quiet: string }).quiet).toMatch(/bubble/);
  });
});

describe('conversationAckText', () => {
  it('trims the text', () => {
    expect(conversationAckText({ text: '  You want CSV.\n' })).toBe('You want CSV.');
  });

  it('reads no usable text as null', () => {
    expect(conversationAckText(null)).toBeNull();
    expect(conversationAckText('text')).toBeNull();
    expect(conversationAckText({})).toBeNull();
    expect(conversationAckText({ text: 7 })).toBeNull();
    expect(conversationAckText({ text: ' \n ' })).toBeNull();
  });

  it(`holds the text to ${CONVERSATION_ACK_MAX_CHARS} characters`, () => {
    const long = `${'a'.repeat(CONVERSATION_ACK_MAX_CHARS - 1)} ${'b'.repeat(50)}`;
    const text = conversationAckText({ text: long })!;
    expect(text.length).toBeLessThanOrEqual(CONVERSATION_ACK_MAX_CHARS);
    expect(text).toBe('a'.repeat(CONVERSATION_ACK_MAX_CHARS - 1));
  });
});

type AckState = Parameters<typeof conversationAckFor>[0];
const base: AckState = {
  phase: 'streaming',
  planId: 'plan-1',
  jobId: 'job-1',
  settledJobId: null,
  liveReview: null,
  session: null,
  conversationAck: { jobId: 'job-1', text: 'You want payments.' },
};
const with_ = (over: Partial<AckState>): AckState => ({ ...base, ...over });

describe('conversationAckFor', () => {
  it('answers the reply of the job on screen while it converses', () => {
    expect(conversationAckFor(base)).toBe('You want payments.');
  });

  it('answers null with no reply, an older job’s reply, a settled run, or no plan run', () => {
    expect(conversationAckFor(with_({ conversationAck: null }))).toBeNull();
    expect(conversationAckFor(with_({ conversationAck: undefined }))).toBeNull();
    expect(conversationAckFor(with_({ jobId: 'job-2' }))).toBeNull();
    expect(conversationAckFor(with_({ settledJobId: 'job-1' }))).toBeNull();
    expect(conversationAckFor(with_({ planId: null }))).toBeNull();
    expect(conversationAckFor(with_({ jobId: null }))).toBeNull();
  });

  it('answers a REOPENED run’s reply by the session’s latest job', () => {
    const reopened = with_({
      phase: 'idle',
      jobId: null,
      liveReview: {
        id: 'plan-1',
        status: 'generating',
        authorSource: 'native',
      } as PlanChangeConversationState['liveReview'],
      session: { lastJobId: 'job-1' } as PlanChangeConversationState['session'],
    });
    expect(conversationAckFor(reopened)).toBe('You want payments.');
    expect(
      conversationAckFor({ ...reopened, conversationAck: { jobId: 'job-0', text: 'old' } }),
    ).toBeNull();
  });
});
