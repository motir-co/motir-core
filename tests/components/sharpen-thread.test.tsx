// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SharpenThread, type SharpenThreadProps } from '@/components/planning/SharpenThread';
import type { SharpenSessionDto, SharpenTurnDto } from '@/lib/dto/sharpen';

// THE GRILLING TURNS AND THE SETTLED-ANSWERS SUMMARY (Task MOTIR-1101 · Subtask
// MOTIR-8177; design G3–G5). The thread is presentational over the session the
// control's driver holds, so each state is asserted by handing it that session.
// Component tests read the DOM directly (no jest-dom, the project convention).

let seq = 0;
function turn(role: 'person' | 'planner', body: string, extra: Partial<SharpenTurnDto> = {}) {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    role,
    action: role === 'person' ? 'answer' : null,
    body,
    readingId: null,
    jobId: null,
    failed: false,
    createdAt: '2026-10-13T10:00:00.000Z',
    ...extra,
  } as SharpenTurnDto;
}

const QUESTION = {
  id: 'q2',
  text: 'What happens when a preset is deleted?',
  topic: 'non_happy' as const,
  because: 'Everyone in the project',
  quote: null,
  readings: [
    { id: 'rb', label: 'Keep copies', detail: 'Users keep their own.', recommended: false },
    { id: 'ra', label: 'Remove everywhere', detail: 'One source.', recommended: true },
  ],
};

function session(overrides: Partial<SharpenSessionDto> = {}): SharpenSessionDto {
  return {
    id: 'sh1',
    scope: { kind: 'plan', planId: 'plan-1' },
    status: 'open',
    endReason: null,
    pendingQuestion: QUESTION,
    settled: [],
    assumptions: [],
    writeBack: null,
    inFlight: null,
    turns: [
      turn('person', 'Start.', { action: 'start' }),
      turn('planner', 'Who can use a shared preset?'),
      turn('person', 'Everyone in the project', { action: 'answer', readingId: 'r1' }),
      turn('planner', QUESTION.text),
    ],
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: '2026-10-13T10:00:00.000Z',
    lastActivityAt: '2026-10-13T10:00:00.000Z',
    ...overrides,
  };
}

const ENDED: Partial<SharpenSessionDto> = {
  status: 'ended',
  pendingQuestion: null,
  settled: [
    {
      questionId: 'q1',
      question: 'Who can use a shared preset?',
      answer: 'Everyone in the project',
      topic: 'workflow',
      readingId: 'r1',
      source: 'person',
    },
    {
      questionId: 'q3',
      question: 'Export one preset or many?',
      answer: 'One at a time',
      topic: 'alternative',
      readingId: null,
      source: 'person',
    },
  ],
  assumptions: [
    {
      questionId: 'q2',
      question: 'What happens when a preset is deleted?',
      recommendation: 'Remove everywhere',
      why: 'One source of truth.',
      source: 'planner',
    },
  ],
};

function render(props: Partial<SharpenThreadProps> = {}) {
  const handlers = {
    onAct: vi.fn(),
    onStop: vi.fn(),
    onSomethingElse: vi.fn(),
    onRetry: vi.fn(),
  };
  renderWithIntl(
    <SharpenThread session={session()} pending={false} error={null} {...handlers} {...props} />,
  );
  return handlers;
}

afterEach(cleanup);

describe('the question turn', () => {
  it('draws one question with its readings in the session order, the recommended one marked', () => {
    render();
    expect(screen.getAllByTestId('sharpen-question')).toHaveLength(1);
    const ids = [...document.querySelectorAll('[data-testid^="sharpen-reading-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['sharpen-reading-rb', 'sharpen-reading-ra']);
    expect(screen.getByTestId('sharpen-reading-ra').getAttribute('aria-label')).toBe(
      'Remove everywhere (recommended)',
    );
    expect(screen.getByTestId('sharpen-question').textContent).toContain(
      'Because you chose “Everyone in the project”…',
    );
    expect(screen.getByTestId('sharpen-question').textContent).toContain('asking · question 2');
  });

  it('keeps the earlier question and the answer in the thread, under the opening marker', () => {
    render();
    expect(screen.getByTestId('sharpen-opening').textContent).toContain('Grill me is on');
    const thread = screen.getByTestId('sharpen-thread').textContent ?? '';
    expect(thread).toContain('Who can use a shared preset?');
    expect(thread).toContain('Everyone in the project');
    expect(thread).not.toContain('Start.');
  });

  it('a turn with no readings still offers an own-words answer', () => {
    const h = render({ session: session({ pendingQuestion: { ...QUESTION, readings: [] } }) });
    expect(document.querySelectorAll('[data-testid^="sharpen-reading-"]')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('sharpen-something-else'));
    expect(h.onSomethingElse).toHaveBeenCalledTimes(1);
  });

  it('a reading, Skip and You decide each send one act', () => {
    const h = render();
    fireEvent.click(screen.getByTestId('sharpen-reading-ra'));
    fireEvent.click(screen.getByTestId('sharpen-skip'));
    fireEvent.click(screen.getByTestId('sharpen-you-decide'));
    expect(h.onAct.mock.calls).toEqual([['answer', { readingId: 'ra' }], ['skip'], ['you_decide']]);
  });

  it('disables every act while one is in flight, and keeps Stop', () => {
    const h = render({ pending: true });
    for (const id of ['sharpen-reading-ra', 'sharpen-skip', 'sharpen-you-decide']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByTestId('sharpen-stop'));
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sharpen-reading').textContent).toBe('Reading your request…');
  });

  it('a failed send says so, keeps the answers so far, and offers Try again', () => {
    const h = render({ error: 'failed' });
    expect(screen.getByRole('alert').textContent).toBe(
      "That question didn't arrive. Your answers so far are kept — try again.",
    );
    expect(screen.getByTestId('sharpen-thread').textContent).toContain('Everyone in the project');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
  });

  it('draws a skip as its marker, and You decide as the planner’s assumption card', () => {
    render({
      session: session({
        turns: [
          turn('planner', 'Who can use a shared preset?'),
          turn('person', 'Skip.', { action: 'skip' }),
          turn('planner', 'What happens when a preset is deleted?'),
          turn('person', 'You decide.', { action: 'you_decide' }),
          turn('planner', QUESTION.text),
        ],
        assumptions: ENDED.assumptions!,
      }),
    });
    expect(screen.getByTestId('sharpen-thread').textContent).toContain(
      'Skipped — the planner will assume this one.',
    );
    const card = screen.getByTestId('sharpen-assumption');
    expect(card.textContent).toContain("Planner's assumption");
    expect(card.textContent).toContain('Remove everywhere');
  });
});

describe('the end and the summary', () => {
  it('nothing to ask: one planner turn, no question and no summary', () => {
    render({
      session: session({ status: 'ended', endReason: 'nothing_to_ask', pendingQuestion: null }),
    });
    expect(screen.getByTestId('sharpen-nothing-to-ask').textContent).toContain(
      "I have nothing to ask — this is clear enough to plan. I'm writing the plan now.",
    );
    expect(screen.queryByTestId('sharpen-question')).toBeNull();
    expect(screen.queryByTestId('sharpen-summary')).toBeNull();
  });

  it('a stop with nothing settled says nothing was written', () => {
    render({ session: session({ status: 'ended', endReason: 'stopped', pendingQuestion: null }) });
    expect(screen.getByTestId('sharpen-stopped').textContent).toBe(
      'You stopped the grilling before any answer. Nothing was written.',
    );
    expect(screen.queryByTestId('sharpen-summary')).toBeNull();
  });

  it('a stop keeps everything settled so far, answers and assumptions in distinct groups', () => {
    render({ session: session({ ...ENDED, endReason: 'stopped' }) });
    expect(screen.getByTestId('sharpen-stopped').textContent).toBe('You stopped the grilling.');
    const summary = screen.getByTestId('sharpen-summary');
    expect(summary.textContent).toContain("2 answers · 1 planner's assumption");
    expect(screen.getByTestId('sharpen-summary-behaviour').textContent).toContain(
      'Everyone in the project',
    );
    expect(screen.getByTestId('sharpen-summary-scopeEdge').textContent).toContain('One at a time');
    expect(screen.queryByTestId('sharpen-summary-acceptance')).toBeNull();
    const assumed = screen.getByTestId('sharpen-summary-assumptions');
    expect(assumed.textContent).toContain("Planner's assumption");
    expect(assumed.textContent).toContain('Remove everywhere');
  });

  it('names the plan alone as where the answers were written — never a card (MOTIR-9314)', () => {
    render({
      session: session({ ...ENDED, endReason: 'finished', writeBack: { ok: true } }),
    });
    expect(screen.getByTestId('sharpen-completed').textContent).toBe(
      "That's everything I needed to ask.",
    );
    const written = screen.getByTestId('sharpen-written');
    expect(written.textContent).toBe("Written to the plan's requirement.");
    expect(written.querySelector('a')).toBeNull();
  });

  it('says it is writing until the write-back reports, and says so when it failed', () => {
    render({ session: session({ ...ENDED, endReason: 'finished' }) });
    expect(screen.getByTestId('sharpen-writing').textContent).toBe(
      "Writing your answers to the plan's requirement…",
    );
    cleanup();
    render({
      session: session({ ...ENDED, endReason: 'finished', writeBack: { ok: false, error: 'x' } }),
    });
    expect(screen.getByTestId('sharpen-write-failed').textContent).toContain(
      "Your answers weren't written.",
    );
    expect(screen.getByRole('button', { name: 'Copy answers' })).toBeTruthy();
  });
});
