// @vitest-environment happy-dom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  AnsweredAside,
  ForwardOffer,
  ForwardRefusal,
  ForwardedMarks,
  PendingAsk,
  ProposalRef,
  QueuedLabel,
  refusalKey,
} from '@/components/planning/MidRunTurn';
import {
  PauseRecord,
  PauseReply,
  PauseThread,
  PausedRunIndicator,
  PlannerQuestionTurn,
  ReplanOfferTurn,
} from '@/components/planning/RunPause';
import type { PlanChangeRunPauseDto, PlanChangeTurnDto } from '@/lib/dto/planChange';

// THE MID-RUN PIECES, one at a time (Story MOTIR-7990 · MOTIR-8003). The rail suites
// (`plan-change-mid-run-rail`, `plan-change-run-pause`) draw these pieces INSIDE the
// rail from hand-built state; this file draws each piece on its own in every state
// its props can take, so a branch of `MidRunTurn.tsx` or `RunPause.tsx` that only a
// rare state reaches (a late revision with no plan to link, a reply the hook has not
// matched to an entry yet, a refusal code the catalogue has no line for) is held by
// a test that says what it must look like, and the lane's per-file floor is earned.

afterEach(() => cleanup());

function pause(over: Partial<PlanChangeRunPauseDto> = {}): PlanChangeRunPauseDto {
  return {
    id: 'pause-1',
    jobId: 'run-1',
    kind: 'replan',
    changeTurnIds: ['e1'],
    reason: 'That changes what the whole plan is for.',
    question: null,
    createdAt: '2026-10-09T09:00:00.000Z',
    answer: null,
    answeredAt: null,
    replyText: null,
    delivery: 'pending',
    refusedCode: null,
    mailboxEntryId: null,
    ...over,
  };
}

const unclear = (over: Partial<PlanChangeRunPauseDto> = {}) =>
  pause({ kind: 'unclear', reason: null, question: 'Which part should change?', ...over });

describe('the forwarded marks under a change', () => {
  it('says queued, then read, and claims neither without an entry', () => {
    const { rerender } = renderWithIntl(
      <ForwardedMarks entry={{ id: 'e1', text: 'x', read: false }} acknowledge />,
    );
    expect(screen.getByTestId('plan-change-forwarded-queued')).toBeTruthy();
    expect(screen.getByTestId('plan-change-forwarded')).toBeTruthy();

    rerender(<ForwardedMarks entry={{ id: 'e1', text: 'x', read: true }} acknowledge={false} />);
    expect(screen.getByTestId('plan-change-forwarded-read')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-forwarded')).toBeNull();

    rerender(<ForwardedMarks entry={null} acknowledge />);
    expect(screen.queryByTestId('plan-change-forwarded-queued')).toBeNull();
    expect(screen.queryByTestId('plan-change-forwarded-read')).toBeNull();
    expect(screen.getByTestId('plan-change-forwarded')).toBeTruthy();
  });

  it('a late revision notes the revision, linking the plan only when it knows one', () => {
    const revisedLate = { revisionJobId: 'rev-1' } as PlanChangeTurnDto['revisedLate'];
    const { rerender } = renderWithIntl(
      <ForwardedMarks
        entry={null}
        acknowledge
        revisedLate={revisedLate}
        lateRevision={{ planId: 'plan-1' }}
      />,
    );
    expect(screen.getByTestId('plan-change-revision')).toBeTruthy();
    expect(screen.getByTestId('plan-change-revision-link').getAttribute('href')).toContain(
      'plan-1',
    );

    rerender(<ForwardedMarks entry={null} acknowledge={false} revisedLate={revisedLate} />);
    expect(screen.getByTestId('plan-change-revision')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-revision-link')).toBeNull();
    expect(screen.queryByTestId('plan-change-forwarded')).toBeNull();
  });
});

describe('the small pieces of a mid-run answer', () => {
  it('QueuedLabel reads queued with its glyph, or just the read word', () => {
    const { container, rerender } = renderWithIntl(<QueuedLabel read={false} />);
    expect(container.querySelector('svg')).not.toBeNull();
    rerender(<QueuedLabel read />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('ForwardOffer goes stale once a later turn was not forwarded', () => {
    const turn = { id: 'a1', body: 'Shall I?' } as PlanChangeTurnDto;
    const { rerender } = renderWithIntl(<ForwardOffer turn={turn} stale={false} />);
    expect(screen.getByTestId('plan-change-forward-offer')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-forward-stale')).toBeNull();
    rerender(<ForwardOffer turn={turn} stale />);
    expect(screen.getByTestId('plan-change-forward-stale')).toBeTruthy();
  });

  it('ForwardRefusal gives each code its line, and the generic one to the rest', () => {
    for (const code of [
      'PLAN_CHANGE_JOB_NOT_RUNNING',
      'PLAN_CHANGE_PLAN_DECIDED',
      'PLAN_CHANGE_RUN_STOPPED',
      'PLAN_CHANGE_RUN_FAILED',
      'PLAN_REVISION_IN_FLIGHT',
      'PLAN_CHANGE_NO_PLAN',
    ]) {
      expect(refusalKey(code)).not.toBe('generic');
    }
    expect(refusalKey('SOMETHING_ELSE')).toBe('generic');
    // Not an own property of the table, though it is on every object.
    expect(refusalKey('toString')).toBe('generic');

    const { rerender } = renderWithIntl(
      <ForwardRefusal refusal={{ text: 'add search', code: 'PLAN_CHANGE_RUN_FAILED' }} restored />,
    );
    const restored = screen.getByTestId('plan-change-forward-refusal');
    expect(restored.getAttribute('data-code')).toBe('PLAN_CHANGE_RUN_FAILED');
    expect(restored.textContent).not.toContain('add search');

    rerender(
      <ForwardRefusal refusal={{ text: 'add search', code: 'SOMETHING_ELSE' }} restored={false} />,
    );
    expect(screen.getByTestId('plan-change-forward-refusal').textContent).toContain('add search');
  });

  it('ProposalRef is a button when it can select its node, and text when it cannot', () => {
    const onSelect = vi.fn();
    const { rerender } = renderWithIntl(
      <ProposalRef
        planItemId="pi_1"
        label={['Checkout ', 'story', 3, <em key="e">emphasised</em>] as never}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith('pi_1');
    expect(screen.getByTestId('plan-change-proposal-ref').getAttribute('data-plan-item')).toBe(
      'pi_1',
    );

    rerender(<ProposalRef planItemId="pi_1" label="Checkout story" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('plan-change-proposal-ref').textContent).toContain('Checkout story');
  });

  it('PendingAsk draws the question only when the thread does not already hold it', () => {
    const { rerender } = renderWithIntl(<PendingAsk text="how far along?" inThread={false} />);
    expect(screen.getByTestId('plan-change-pending-ask').textContent).toContain('how far along?');
    expect(screen.getByTestId('plan-change-answering')).toBeTruthy();
    expect(screen.getByTestId('plan-change-answering-marker')).toBeTruthy();
    rerender(<PendingAsk text="how far along?" inThread />);
    expect(screen.queryByTestId('plan-change-pending-ask')).toBeNull();
    expect(screen.getByTestId('plan-change-answering')).toBeTruthy();
  });

  it('PendingAsk draws the question’s quick reply in place of its spinner (MOTIR-11797)', () => {
    const { rerender } = renderWithIntl(<PendingAsk text="how far along?" inThread />);
    const answering = () => screen.getByTestId('plan-change-answering');
    expect(answering().textContent).toBe('');
    rerender(<PendingAsk text="how far along?" inThread ack="You want to know how far it got." />);
    expect(answering().textContent).toBe('You want to know how far it got.');
  });

  it('AnsweredAside is one passive line', () => {
    renderWithIntl(<AnsweredAside />);
    expect(screen.getByTestId('plan-change-answered-aside')).toBeTruthy();
  });
});

describe('the planner’s re-plan offer', () => {
  it('draws the reason and two controls while open, each answering with its choice', () => {
    const onAnswer = vi.fn();
    renderWithIntl(<ReplanOfferTurn pause={pause()} pending={false} onAnswer={onAnswer} />);
    expect(screen.getByTestId('planner-start-over-turn').textContent).toContain(
      'That changes what the whole plan is for.',
    );
    fireEvent.click(screen.getByTestId('planner-start-over-yes'));
    fireEvent.click(screen.getByTestId('planner-start-over-keep'));
    expect(onAnswer.mock.calls).toEqual([['start_over'], ['apply']]);
  });

  it('disables both controls while an answer is in flight, and draws none once answered', () => {
    const onAnswer = vi.fn();
    const { rerender } = renderWithIntl(
      <ReplanOfferTurn pause={pause()} pending onAnswer={onAnswer} />,
    );
    expect((screen.getByTestId('planner-start-over-yes') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('planner-start-over-keep') as HTMLButtonElement).disabled).toBe(
      true,
    );

    rerender(
      <ReplanOfferTurn
        pause={pause({ answer: 'apply', reason: null })}
        pending={false}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.queryByTestId('planner-start-over-offer')).toBeNull();
    expect(screen.getByTestId('planner-start-over-turn')).toBeTruthy();
  });
});

describe('the planner’s question and the reply', () => {
  it('is a bubble with no controls, and a record once answered', () => {
    const { rerender } = renderWithIntl(<PlannerQuestionTurn pause={unclear()} resumed={false} />);
    expect(screen.getByTestId('plan-change-question').textContent).toContain(
      'Which part should change?',
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('planner-question-record')).toBeNull();

    rerender(
      <PlannerQuestionTurn
        pause={unclear({ answer: 'replied', replyText: 'x' })}
        resumed={false}
      />,
    );
    const queued = screen.getByTestId('planner-question-record').textContent;
    rerender(
      <PlannerQuestionTurn pause={unclear({ answer: 'replied', replyText: 'x' })} resumed />,
    );
    expect(screen.getByTestId('planner-question-record').textContent).not.toBe(queued);
  });

  it('PauseReply goes queued, read, and — before the hook holds an entry — queued from the pause', () => {
    const replied = unclear({
      answer: 'replied',
      replyText: 'split it in two',
      delivery: 'delivered',
      mailboxEntryId: 'e9',
    });
    const { rerender } = renderWithIntl(
      <PauseReply pause={replied} entry={{ id: 'e9', text: 'split it in two', read: true }} />,
    );
    expect(screen.getByTestId('planner-pause-reply').textContent).toContain('split it in two');
    expect(screen.getByTestId('plan-change-forwarded-read')).toBeTruthy();

    rerender(<PauseReply pause={replied} entry={null} />);
    expect(screen.getByTestId('plan-change-forwarded-queued')).toBeTruthy();

    // A reloaded rail holds no entry: the pause itself says the run has read it.
    rerender(<PauseReply pause={{ ...replied, entryRead: true }} entry={null} />);
    expect(screen.getByTestId('plan-change-forwarded-read')).toBeTruthy();

    // Delivered, with neither the entry id nor the text on the pause yet.
    rerender(
      <PauseReply pause={unclear({ answer: 'replied', delivery: 'delivered' })} entry={null} />,
    );
    expect(screen.getByTestId('plan-change-forwarded-queued')).toBeTruthy();

    // Not delivered at all: no marks to claim.
    rerender(<PauseReply pause={unclear({ answer: 'replied', replyText: 'x' })} entry={null} />);
    expect(screen.queryByTestId('plan-change-forwarded-queued')).toBeNull();
    expect(screen.queryByTestId('plan-change-forwarded-read')).toBeNull();
  });

  it('PauseThread calls a reloaded, already-read answer "planning resumed"', () => {
    renderWithIntl(
      <PauseThread
        pause={unclear({
          answer: 'replied',
          replyText: 'x',
          delivery: 'delivered',
          entryRead: true,
        })}
        pending={false}
        onAnswer={() => {}}
        replyEntry={null}
        refusalCode={null}
      />,
    );
    expect(screen.getByTestId('planner-question-record').textContent).toContain('planning resumed');
  });
});

describe('what an answered pause leaves behind', () => {
  it('records START OVER, KEEP GOING (with the planner’s own line), and nothing for a reply', () => {
    const { rerender } = renderWithIntl(
      <PauseRecord pause={pause({ answer: 'start_over' })} refusalCode={null} />,
    );
    expect(screen.getByTestId('planner-start-over-record')).toBeTruthy();
    expect(screen.queryByTestId('planner-start-over-applying')).toBeNull();

    rerender(<PauseRecord pause={pause({ answer: 'apply' })} refusalCode={null} />);
    expect(screen.getByTestId('planner-start-over-record')).toBeTruthy();
    expect(screen.getByTestId('planner-start-over-applying')).toBeTruthy();

    rerender(<PauseRecord pause={unclear({ answer: 'replied' })} refusalCode={null} />);
    expect(screen.queryByTestId('planner-start-over-record')).toBeNull();
    expect(screen.queryByTestId('planner-pause-refusal')).toBeNull();
  });

  it('words a refusal by its code, and generically for any other', () => {
    const { rerender } = renderWithIntl(
      <PauseRecord pause={pause({ answer: 'apply' })} refusalCode="PLAN_CHANGE_JOB_NOT_RUNNING" />,
    );
    const ended = screen.getByTestId('planner-pause-refusal').textContent;
    expect(screen.getByTestId('planner-pause-refusal').getAttribute('data-code')).toBe(
      'PLAN_CHANGE_JOB_NOT_RUNNING',
    );
    rerender(<PauseRecord pause={pause({ answer: 'apply' })} refusalCode="SOMETHING_ELSE" />);
    expect(screen.getByTestId('planner-pause-refusal').textContent).not.toBe(ended);
  });
});

describe('the paused run indicator', () => {
  it('words the wait for the offer or for the answer, finishing or not', () => {
    const lines: string[] = [];
    const { rerender } = renderWithIntl(
      <PausedRunIndicator kind="replan" finishing={false} stop={<button>Stop</button>} />,
    );
    for (const [kind, finishing] of [
      ['replan', false],
      ['replan', true],
      ['unclear', false],
      ['unclear', true],
    ] as const) {
      rerender(
        <PausedRunIndicator kind={kind} finishing={finishing} stop={<button>Stop</button>} />,
      );
      expect(screen.getByTestId('plan-change-running-bar').getAttribute('data-paused')).toBe(
        'true',
      );
      expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
      lines.push(screen.getByTestId('plan-change-paused-line').textContent ?? '');
    }
    expect(new Set(lines).size).toBe(4);
  });
});

describe('the pause’s block in the thread', () => {
  it('a re-plan is its offer then its record; a question is the question, the reply, the record', () => {
    const { rerender } = renderWithIntl(
      <PauseThread
        pause={pause({ answer: 'start_over' })}
        pending={false}
        onAnswer={() => {}}
        replyEntry={null}
        refusalCode={null}
      />,
    );
    expect(screen.getByTestId('planner-start-over-turn')).toBeTruthy();
    expect(screen.getByTestId('planner-start-over-record')).toBeTruthy();

    rerender(
      <PauseThread
        pause={unclear()}
        pending={false}
        onAnswer={() => {}}
        replyEntry={null}
        refusalCode={null}
      />,
    );
    expect(screen.getByTestId('plan-change-question')).toBeTruthy();
    expect(screen.queryByTestId('planner-pause-reply')).toBeNull();

    rerender(
      <PauseThread
        pause={unclear({ answer: 'replied', replyText: 'split it', delivery: 'delivered' })}
        pending={false}
        onAnswer={() => {}}
        replyEntry={{ id: 'e9', text: 'split it', read: true }}
        refusalCode={null}
      />,
    );
    expect(screen.getByTestId('planner-pause-reply')).toBeTruthy();
    expect(screen.getByTestId('planner-question-record')).toBeTruthy();
  });
});
