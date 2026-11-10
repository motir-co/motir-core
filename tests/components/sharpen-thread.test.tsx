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
    outOfCredits: false,
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
    notes: [],
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

  // MOTIR-10254: a naming, placement or connections question is drawn like any WHAT
  // question — no technical-thread chip, every reading offered.
  it('draws a product_fit question like any other WHAT question', () => {
    render({
      session: session({
        pendingQuestion: {
          ...QUESTION,
          text: 'Where do saved presets appear?',
          topic: 'product_fit',
        },
      }),
    });
    const drawn = screen.getByTestId('sharpen-question');
    expect(drawn.textContent).toContain('Where do saved presets appear?');
    expect(drawn.textContent).not.toContain('Your thread');
    expect(screen.getByTestId('sharpen-reading-ra')).toBeTruthy();
    expect(screen.getByTestId('sharpen-reading-rb')).toBeTruthy();
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

  it('a decision settled from research links every source it names (MOTIR-10284)', () => {
    const recommendation =
      'Only the filtered view. — as shipped products do: Linear (https://linear.app/docs/exporting-data); Jira (https://support.atlassian.com/jira/docs/export-issues/)';
    render({
      session: session({
        ...ENDED,
        endReason: 'finished',
        assumptions: [{ ...ENDED.assumptions![0]!, recommendation }],
      }),
    });
    const assumed = screen.getByTestId('sharpen-summary-assumptions');
    const links = [...assumed.querySelectorAll('a')];
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      'https://linear.app/docs/exporting-data',
      'https://support.atlassian.com/jira/docs/export-issues/',
    ]);
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(assumed.textContent).toContain(recommendation);
  });

  it('groups a product_fit answer under Behaviour (MOTIR-10254)', () => {
    render({
      session: session({
        ...ENDED,
        endReason: 'finished',
        settled: [
          {
            questionId: 'q4',
            question: 'Where do saved presets appear?',
            answer: 'In the board toolbar',
            topic: 'product_fit',
            readingId: 'ra',
            source: 'person',
          },
        ],
        assumptions: [],
      }),
    });
    expect(screen.getByTestId('sharpen-summary-behaviour').textContent).toContain(
      'In the board toolbar',
    );
    expect(screen.queryByTestId('sharpen-summary-scopeEdge')).toBeNull();
    expect(screen.queryByTestId('sharpen-summary-acceptance')).toBeNull();
    expect(screen.queryByTestId('sharpen-summary-constraints')).toBeNull();
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

  // MOTIR-10233 — a run's re-plan the planner could not plan closes its plan before it
  // is written, and any grilling on it ends there. Nothing failed, so the person is
  // never shown the Failed state or its Copy answers button — even though the stored
  // write-back says `ok: false`, because nothing WAS written.
  it('says plainly the plan closed before it was written — never the Failed state', () => {
    render({
      session: session({
        ...ENDED,
        endReason: 'finished',
        writeBack: { ok: false, planClosed: true, error: 'closed' },
      }),
    });
    expect(screen.getByTestId('sharpen-plan-closed').textContent).toBe(
      'The plan was closed before it was written, so these answers were not needed.',
    );
    expect(screen.queryByTestId('sharpen-write-failed')).toBeNull();
    expect(screen.queryByTestId('sharpen-written')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy answers' })).toBeNull();
  });
});

// ── THE NOTES (MOTIR-10235) ──────────────────────────────────────────────────
describe('what the grilling says while it reads', () => {
  const reading = (extra: Partial<SharpenSessionDto> = {}) =>
    session({
      pendingQuestion: null,
      inFlight: { turnId: 't-start', jobId: 'job-live' },
      turns: [turn('person', 'Start.', { action: 'start', jobId: 'job-live' })],
      ...extra,
    });

  it('draws the in-flight job’s own notes in place of the fixed reading line, latest on the strong ink', () => {
    render({
      pending: true,
      session: reading({
        notes: [
          { jobId: 'job-live', body: 'Reading the export service.' },
          { jobId: 'job-live', body: 'Checking the decision page on presets.' },
        ],
      }),
    });
    expect(screen.queryByTestId('sharpen-reading')).toBeNull();
    const box = screen.getByTestId('conversation-notes');
    expect(box.getAttribute('data-live')).toBe('true');
    expect(box.getAttribute('aria-live')).toBe('off');
    const items = screen.getAllByTestId('conversation-note');
    expect(items.map((li) => li.textContent)).toEqual([
      'Reading the export service.',
      'Checking the decision page on presets.',
    ]);
    expect(items[0]!.className).toContain('text-(--el-text-secondary)');
    expect(items[1]!.className).toContain('text-(--el-text)');
    expect(items[1]!.getAttribute('dir')).toBe('auto');
  });

  it('keeps the fixed reading line while the job has said nothing yet', () => {
    render({ pending: true, session: reading() });
    expect(screen.getByTestId('sharpen-reading').textContent).toBe('Reading your request…');
    expect(screen.queryByTestId('conversation-notes')).toBeNull();
  });

  it('keeps Stop reachable while a read runs with no question on screen', () => {
    const h = render({ pending: true, session: reading() });
    fireEvent.click(screen.getByTestId('sharpen-stop'));
    expect(h.onStop).toHaveBeenCalledTimes(1);
  });

  it('takes Stop away once the person has pressed it: the job running is the stop’s own', () => {
    render({
      pending: true,
      session: reading({
        turns: [turn('person', '', { action: 'stop', jobId: 'sj-stop' })],
        inFlight: { turnId: 't-stop', jobId: 'sj-stop' },
      }),
    });
    expect(screen.queryByTestId('sharpen-stop')).toBeNull();
  });

  it('keeps what a read a Stop superseded said, though no reply will ever carry it', () => {
    render({
      pending: true,
      session: reading({
        turns: [
          turn('person', 'Start', { action: 'start', jobId: 'sj-read' }),
          turn('person', '', { action: 'stop', jobId: 'sj-stop' }),
        ],
        inFlight: { turnId: 't-stop', jobId: 'sj-stop' },
        notes: [{ jobId: 'sj-read', body: 'Reading the export card.' }] as never,
      }),
    });
    const drawn = screen.getAllByTestId('conversation-note').map((n) => n.textContent);
    expect(drawn).toEqual(['Reading the export card.']);
  });

  it('offers no extra Stop when nothing is reading', () => {
    render({ session: reading({ inFlight: null }) });
    expect(screen.queryByTestId('sharpen-stop')).toBeNull();
  });

  it('draws a landed job’s notes above the question it produced, finished', () => {
    render({
      session: session({
        turns: [
          turn('person', 'Start.', { action: 'start', jobId: 'job-1' }),
          turn('planner', 'Who can use a shared preset?', { jobId: 'job-1' }),
          turn('person', 'Everyone in the project', { readingId: 'r1', jobId: 'job-2' }),
          turn('planner', QUESTION.text, { jobId: 'job-2' }),
        ],
        notes: [
          { jobId: 'job-1', body: 'Read the export service.' },
          { jobId: 'job-2', body: 'Read who owns presets.' },
        ],
      }),
    });
    const boxes = screen.getAllByTestId('conversation-notes');
    expect(boxes.map((b) => b.textContent)).toEqual([
      'Read the export service.',
      'Read who owns presets.',
    ]);
    expect(boxes.every((b) => b.getAttribute('data-live') === 'false')).toBe(true);
    // Each job's notes sit before what it produced.
    const thread = screen.getByTestId('sharpen-thread').textContent!;
    expect(thread.indexOf('Read the export service.')).toBeLessThan(
      thread.indexOf('Who can use a shared preset?'),
    );
  });
});

// ── AN ANSWERED QUESTION WHILE THE NEXT TURN IS READ (MOTIR-10862) ────────────
// The server keeps `pendingQuestion` set until the next planner turn replaces it,
// so for the whole read the answered question is still the stored one. It is drawn
// in the history, above the answer, and the reply row is gone.
describe('an answered question while the next turn is read', () => {
  const Q1 = { ...QUESTION, id: 'q1', text: 'Who can use a shared preset?', because: null };
  const answered = (answer: SharpenTurnDto, extra: Partial<SharpenSessionDto> = {}) =>
    session({
      pendingQuestion: Q1,
      inFlight: { turnId: answer.id, jobId: 'job-2' },
      notes: [{ jobId: 'job-2', body: 'Reading the review gate.' }],
      turns: [
        turn('person', 'Start.', { action: 'start', jobId: 'job-1' }),
        turn('planner', Q1.text, { jobId: 'job-1' }),
        answer,
      ],
      ...extra,
    });
  const order = (...needles: string[]) => {
    const thread = screen.getByTestId('sharpen-thread').textContent ?? '';
    const at = needles.map((n) => thread.indexOf(n));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  };

  it.each([
    ['a picked reading', 'answer', 'Keep copies', 'Keep copies'],
    ['an own-words answer', 'own_words', 'Then it is 3 settings', 'Then it is 3 settings'],
    ['You decide', 'you_decide', 'You decide.', 'You decide'],
  ] as const)('draws the question, then %s, then the read’s notes', (_, action, body, drawn) => {
    render({
      pending: true,
      session: answered(turn('person', body, { action, jobId: 'job-2' }), {
        ...(action === 'you_decide'
          ? {
              assumptions: [
                {
                  questionId: 'q1',
                  question: Q1.text,
                  recommendation: 'Remove everywhere',
                  why: '',
                  source: 'planner' as const,
                },
              ],
            }
          : {}),
      }),
    });
    expect(screen.queryByTestId('sharpen-question')).toBeNull();
    for (const id of ['sharpen-reading-ra', 'sharpen-skip', 'sharpen-you-decide']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    order('asking · question 1', Q1.text, drawn, 'Reading the review gate.');
    if (action === 'you_decide') order(Q1.text, 'Remove everywhere', 'Reading the review gate.');
    // Stop stays reachable: no question on screen carries it now.
    expect(screen.getAllByTestId('sharpen-stop')).toHaveLength(1);
  });

  it('draws a skipped question above its marker', () => {
    render({
      pending: true,
      session: answered(turn('person', 'Skip.', { action: 'skip', jobId: 'job-2' })),
    });
    expect(screen.queryByTestId('sharpen-question')).toBeNull();
    order(Q1.text, 'Skipped — the planner will assume this one.');
  });

  it('numbers the next question after the answered one once it lands', () => {
    render({
      session: answered(turn('person', 'Keep copies', { action: 'answer', jobId: 'job-2' }), {
        inFlight: null,
        pendingQuestion: QUESTION,
        turns: [
          turn('person', 'Start.', { action: 'start', jobId: 'job-1' }),
          turn('planner', Q1.text, { jobId: 'job-1' }),
          turn('person', 'Keep copies', { action: 'answer', jobId: 'job-2' }),
          turn('planner', QUESTION.text, { jobId: 'job-2' }),
        ],
      }),
    });
    expect(screen.getAllByTestId('sharpen-question')).toHaveLength(1);
    expect(screen.getByTestId('sharpen-question').textContent).toContain('asking · question 2');
    order(Q1.text, 'Keep copies', QUESTION.text);
  });

  it('keeps a stored question that no planner turn has drawn yet', () => {
    render({
      session: session({
        pendingQuestion: Q1,
        turns: [turn('person', 'Start.', { action: 'start', jobId: 'job-1' })],
      }),
    });
    expect(screen.getByTestId('sharpen-question').textContent).toContain('asking · question 1');
  });

  it('offers Stop under a failed read of the answer, with no question left to carry it', () => {
    render({
      error: 'failed',
      session: session({
        scope: { kind: 'conversation', conversationId: 'c1' },
        pendingQuestion: Q1,
        turns: [
          turn('person', 'Start.', { action: 'start', jobId: 'job-1' }),
          turn('planner', Q1.text, { jobId: 'job-1' }),
          turn('person', 'Keep copies', { action: 'answer', jobId: 'job-2' }),
          turn('planner', '', { jobId: 'job-2', failed: true }),
        ],
      }),
    });
    expect(screen.queryByTestId('sharpen-question')).toBeNull();
    order(Q1.text, 'Keep copies');
    expect(screen.getAllByTestId('sharpen-stop')).toHaveLength(1);
  });
});
