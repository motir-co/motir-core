import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ACK_MAX_CHARS,
  conversationAckText,
  FRAME_DISPOSITIONS,
  PLAN_CHANGE_FRAME_KINDS,
} from '@/lib/planning/planChangeFrames';
import {
  askAckFor,
  conversationAckFor,
  reopenedAskAckFor,
  reopenedAskJobId,
} from '@/lib/planning/planRunPhase';
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

// AN ASK TURN'S QUICK REPLY (MOTIR-11797): the ask job's own `conversation_ack`, drawn
// as the turn's first assistant bubble while this screen streams it, and replayed for a
// viewer who reopens the thread while the turn is still being answered.

describe('askAckFor', () => {
  const ask = with_({ planId: null, conversationAck: { jobId: 'job-1', text: 'You want CSV.' } });

  it('answers the reply of the ask job this screen streams', () => {
    expect(askAckFor(ask)).toBe('You want CSV.');
  });

  it('answers null with no reply, another job’s reply, no stream, or a plan run on screen', () => {
    expect(askAckFor({ ...ask, conversationAck: null })).toBeNull();
    expect(askAckFor({ ...ask, conversationAck: undefined })).toBeNull();
    expect(askAckFor({ ...ask, jobId: 'job-2' })).toBeNull();
    expect(askAckFor({ ...ask, phase: 'idle' })).toBeNull();
    // A plan run draws the reply in its own conversation bubble instead.
    expect(askAckFor(with_({}))).toBeNull();
  });
});

type ReopenState = Parameters<typeof reopenedAskAckFor>[0];
type Turn = NonNullable<ReopenState['session']>['turns'][number];
const userTurn = (over: Partial<Turn> = {}) =>
  ({ role: 'user', jobId: 'ask-1', intent: 'ask', runJobId: null, ...over }) as Turn;
const answer = (jobId: string) => ({ role: 'assistant', jobId }) as Turn;
const reopened = (turns: Turn[], over: Partial<ReopenState> = {}): ReopenState => ({
  phase: 'idle',
  session: { endedAt: null, turns } as unknown as ReopenState['session'],
  conversationAck: { jobId: 'ask-1', text: 'You want CSV.' },
  ...over,
});

describe('reopenedAskJobId', () => {
  it('names the ask job of the last, unanswered person turn', () => {
    expect(reopenedAskJobId(reopened([answer('ask-0'), userTurn()]))).toBe('ask-1');
    // An unclassified turn (no intent yet) is still an ask being read.
    expect(reopenedAskJobId(reopened([userTurn({ intent: null })]))).toBe('ask-1');
  });

  it('names none while streaming, on no or an ended session, or for a turn that is not an open ask', () => {
    expect(reopenedAskJobId(reopened([userTurn()], { phase: 'streaming' }))).toBeNull();
    expect(reopenedAskJobId({ phase: 'idle', session: null })).toBeNull();
    expect(
      reopenedAskJobId({
        phase: 'idle',
        session: { endedAt: '2026-11-19T00:00:00.000Z', turns: [userTurn()] },
      } as unknown as ReopenState),
    ).toBeNull();
    expect(reopenedAskJobId(reopened([]))).toBeNull();
    expect(reopenedAskJobId(reopened([answer('ask-0')]))).toBeNull();
    expect(reopenedAskJobId(reopened([userTurn({ jobId: null })]))).toBeNull();
    expect(reopenedAskJobId(reopened([userTurn({ intent: 'plan_change' })]))).toBeNull();
    expect(
      reopenedAskJobId(reopened([userTurn({ runJobId: 'plan-job' } as Partial<Turn>)])),
    ).toBeNull();
    expect(reopenedAskJobId(reopened([userTurn(), answer('ask-1')]))).toBeNull();
  });
});

describe('reopenedAskAckFor', () => {
  it('answers the replayed reply under the turn it belongs to', () => {
    expect(reopenedAskAckFor(reopened([userTurn()]), 'ask-1')).toBe('You want CSV.');
  });

  it('answers null for another turn, no reply, or once the turn is answered', () => {
    expect(reopenedAskAckFor(reopened([userTurn()]), 'ask-0')).toBeNull();
    expect(reopenedAskAckFor(reopened([userTurn()]), null)).toBeNull();
    expect(reopenedAskAckFor(reopened([userTurn()]), undefined)).toBeNull();
    expect(
      reopenedAskAckFor(reopened([userTurn()], { conversationAck: null }), 'ask-1'),
    ).toBeNull();
    expect(
      reopenedAskAckFor(
        reopened([userTurn()], { conversationAck: { jobId: 'x', text: 't' } }),
        'x',
      ),
    ).toBeNull();
    expect(reopenedAskAckFor(reopened([userTurn(), answer('ask-1')]), 'ask-1')).toBeNull();
  });
});
