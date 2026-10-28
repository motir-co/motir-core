// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { ChoiceGateFrame } from '@/components/approvals/ChoiceGate';
import { parseChoiceOptions } from '@/lib/approvalGates/choiceOptions';
import type { ApprovalGateDTO, DecisionChoicePortDTO } from '@/lib/dto/approvalGate';

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-42',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn() }));

const { ChoiceSection } = await import('@/app/(authed)/items/[key]/_components/ChoiceSection');

// THE CHOICE PORT (Story MOTIR-4914 · Subtask MOTIR-5896), built to
// `design/work-items/approval-control--choice.mock.html`. The port is rendered in
// the SHARED frame, so these assert what the choice adds — the option rows with
// what each is best for, select-then-commit, the read-only and defect states, and
// the record read from `chosenOption` — and that a 2-option and a 4-option choice
// go through the same component.

afterEach(cleanup);

function body(options: Array<[label: string, bestFor: string, why: string]>): string {
  return [
    '## Question',
    'Where do exported reports live?',
    '## Why this is a choice',
    '**Situation:** better than your decision',
    '**You said:** "Store the exports in our own Postgres."',
    'Research found a cheaper store.',
    '## Options',
    ...options.flatMap(([label, bestFor, why]) => [
      `### ${label}`,
      `**Best if you want:** ${bestFor}`,
      why,
    ]),
    '## What this choice gates',
    'The export story.',
  ].join('\n');
}

function portOf(md: string): DecisionChoicePortDTO {
  const parse = parseChoiceOptions(md);
  if (!parse.ok) throw new Error(JSON.stringify(parse.defects));
  const { ok: _ok, ...port } = parse;
  return port;
}

const TWO = portOf(
  body([
    ['Managed object storage', 'less to operate', 'The provider runs it.'],
    ['Our own Postgres', 'more cost-effective', 'No new vendor.'],
  ]),
);
const FOUR = portOf(
  body([
    ['Managed object storage', 'less to operate', 'A.'],
    ['Our own Postgres', 'more cost-effective', 'B.'],
    ["The customer's own bucket", 'more customisable later', 'C.'],
    ['Email the file, keep nothing', 'faster to the goal', 'D.'],
  ]),
);

const AWAITING: ApprovalGateDTO = {
  id: 'gate-c1',
  workItemId: 'wi-42',
  kind: 'decision_choice',
  subjectId: 'wi-42',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: 'a'.repeat(64),
  decidedByLabel: null,
  routedToId: 'user-1',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  offersRefusalVerdict: false,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const CHOSEN: ApprovalGateDTO = {
  ...AWAITING,
  state: 'approved',
  decidedById: 'user-1',
  decidedAt: '2026-09-21T14:02:00.000Z',
  decidedByLabel: 'Yue',
  decidedUnderAuthority: 'assignee',
  decisionSource: 'ui',
  outcomeRef: 'managed-object-storage',
  confirmedRecord: null,
  refusalVerdict: null,
  replanOwed: null,
  chosenOption: {
    optionId: 'managed-object-storage',
    label: 'Managed object storage',
    bestFor: 'less to operate',
    followUp: 'The export story.',
    situation: 'better_than_your_decision',
  },
};

function renderFrame(
  props: Partial<React.ComponentProps<typeof ChoiceGateFrame>> = {},
  onDecide = vi.fn(async () => null),
) {
  renderWithIntl(
    <ChoiceGateFrame
      gate={AWAITING}
      port={TWO}
      workItemRefs={{}}
      canDecide
      routedToLabel="Yue"
      identifier="ACME-42"
      onDecide={onDecide}
      {...props}
    />,
  );
  return onDecide;
}

describe('the port — every option with what it is best for, 2 or 4 through ONE component', () => {
  it.each([
    ['two', TWO],
    ['four', FOUR],
  ] as const)('%s options: one radio per option, each showing its best-for chip', (_n, port) => {
    renderFrame({ port });
    const group = screen.getByRole('radiogroup');
    expect(within(group).getAllByRole('radio')).toHaveLength(port.options.length);
    for (const option of port.options) {
      expect(screen.getByText(option.label)).toBeTruthy();
      expect(screen.getByText(option.bestFor)).toBeTruthy();
    }
    expect(screen.getAllByText('best if you want')).toHaveLength(port.options.length);
    // The question, WHY it is a choice, and what it gates — in the port.
    expect(screen.getByText('Where do exported reports live?')).toBeTruthy();
    expect(screen.getByText('A better option than your decision')).toBeTruthy();
    expect(screen.getByText('The export story.')).toBeTruthy();
  });
});

describe('band 3 — select, then commit', () => {
  it('before a pick, Choose is disabled and the reason is the consequence line', () => {
    renderFrame();
    const choose = screen.getByRole('button', { name: 'Choose' }) as HTMLButtonElement;
    expect(choose.disabled).toBe(true);
    expect(screen.getByText(/Pick an option above to choose it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'None of these — revise the options' })).toBeTruthy();
  });

  it('picking a row names it on the verb; confirming sends choose + its optionId', async () => {
    const onDecide = renderFrame();
    fireEvent.click(screen.getByRole('radio', { name: /Our own Postgres/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose Our own Postgres' }));
    expect(screen.getByText('Choosing this will:')).toBeTruthy();
    expect(
      screen.getByText(
        'Record Our own Postgres (best if you want more cost-effective) as the answer.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, choose Our own Postgres' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('choose', 'our-own-postgres'));
  });

  it('None of these ASKS WHY, refuses an empty press in place, and sends the reason (MOTIR-6075)', async () => {
    const onDecide = renderFrame();
    fireEvent.click(screen.getByRole('button', { name: 'None of these — revise the options' }));
    // The confirm band opens with the reason field — nothing is sent on the press.
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.reason.choice.proceed }));
    expect(screen.getByText(en.approvalGate.reason.choice.required)).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(en.approvalGate.reason.choice.label), {
      target: { value: 'We need our own bucket.' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.reason.choice.proceed }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith(
        'request_changes',
        undefined,
        'We need our own bucket.',
      ),
    );
  });
});

describe('the read-only state and the record', () => {
  it('a reader who may not decide sees every option and NO verb', () => {
    renderFrame({ canDecide: false });
    for (const option of TWO.options) expect(screen.getByText(option.label)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Waiting on Yue.')).toBeTruthy();
  });

  it('the record is read from chosenOption — an edited body does not change its words', () => {
    // The body now offers different options entirely; the record still says what was picked.
    const edited = portOf(
      body([
        ['A CDN', 'faster to the goal', 'X.'],
        ['Tape backup', 'more cost-effective', 'Y.'],
      ]),
    );
    renderFrame({ gate: CHOSEN, port: { ...edited, followUpMd: 'Something else now.' } });
    expect(screen.getAllByText('Chosen').length).toBeGreaterThan(0);
    expect(screen.getByText(/Chosen by Yue/)).toBeTruthy();
    expect(screen.getByText('Managed object storage')).toBeTruthy();
    // What the choice gates stays on the record as information; the *owed* sentence is
    // gone (MOTIR-6436). The lead is bold, so the line is matched by its whole text.
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'SPAN' && el.textContent === 'What this choice gates — The export story.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/planning owed/)).toBeNull();
    expect(screen.getByText('Asked because')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('None of these records that the options will be revised', () => {
    renderFrame({
      gate: {
        ...AWAITING,
        state: 'changes_requested',
        decidedByLabel: 'Yue',
        decidedAt: AWAITING.createdAt,
      },
    });
    expect(screen.getByText('the options will be revised')).toBeTruthy();
  });
});

describe('the item page — the Choice section', () => {
  it('a defective body shows the named reason, the options as parsed, and NO verb', () => {
    const md = body([
      ['Managed object storage', 'less to operate', 'A.'],
      ['Our own Postgres', 'more cost-effective', 'B.'],
    ]).replace('**Best if you want:** more cost-effective\n', '');
    const parse = parseChoiceOptions(md);
    if (parse.ok) throw new Error('expected a defect');
    renderWithIntl(
      <ChoiceSection
        workItemRefs={{}}
        body={{ ok: false, defects: parse.defects, draft: parse.draft }}
        gate={null}
        canDecide={false}
        routedToLabel={null}
        routedToViewer={false}
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.getByText("Can't be decided yet")).toBeTruthy();
    expect(
      screen.getByText(
        '“Our own Postgres” says what it is, not when it is the best pick. Every option needs a Best if you want: line.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Missing — add a Best if you want: line')).toBeTruthy();
    expect(screen.getByText('Managed object storage')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('an awaiting choice for its decider shows the options and ONE door — Review & choose', () => {
    renderWithIntl(
      <ChoiceSection
        workItemRefs={{}}
        body={{ ok: true, port: TWO }}
        gate={AWAITING}
        canDecide
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.getByRole('link', { name: /Review & choose/ })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('the remaining shapes (MOTIR-5898 coverage)', () => {
  it('the chosen option, still in the body, is marked Chosen with its glyph; an unlabelled decider reads blank', () => {
    renderFrame({ gate: { ...CHOSEN, decidedByLabel: null } });
    const row = document.querySelector('[data-option-id="managed-object-storage"]')!;
    expect(row.textContent).toContain('Chosen');
    expect(row.querySelector('svg')).toBeTruthy();
    expect(
      document.querySelector('[data-option-id="our-own-postgres"]')!.textContent,
    ).not.toContain('Chosen');
  });

  it('a bare draft — no question, no why, no follow-up — renders its options and each defect sentence', () => {
    renderWithIntl(
      <ChoiceSection
        workItemRefs={{}}
        body={{
          ok: false,
          defects: [
            { reason: 'fewer_than_two_options' },
            { reason: 'unknown_situation', value: 'the team prefers it' },
          ],
          draft: {
            question: '',
            why: null,
            options: [{ id: 'only', label: 'Only', bestFor: 'x', whyMd: '' }],
            followUpMd: '',
          },
        }}
        gate={null}
        canDecide={false}
        routedToLabel={null}
        routedToViewer={false}
        itemIdentifier="ACME-42"
      />,
    );
    expect(
      screen.getByText('This choice lists only one option. A choice needs at least two.'),
    ).toBeTruthy();
    expect(
      screen.getByText(/“the team prefers it” is not one of the three situations/),
    ).toBeTruthy();
    expect(screen.getByText('Only')).toBeTruthy();
    expect(screen.queryByText('Question')).toBeNull();
    expect(screen.queryByText('What this choice gates')).toBeNull();
  });

  it('a situation-3 why quotes nothing, and a gate with no body yet renders the options read-only', () => {
    renderWithIntl(
      <ChoiceSection
        workItemRefs={{}}
        body={{
          ok: true,
          port: { ...TWO, why: { situation: 'two_workflows', youSaid: null, evidenceMd: '' } },
        }}
        gate={null}
        canDecide={false}
        routedToLabel={null}
        routedToViewer={false}
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.getByText('Your requirement allows two workflows')).toBeTruthy();
    expect(screen.queryByText('You said')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('a decided choice whose body stopped parsing still shows its record', () => {
    renderWithIntl(
      <ChoiceSection
        workItemRefs={{}}
        body={{
          ok: false,
          defects: [{ reason: 'no_follow_up_section' }],
          draft: { question: 'Q', why: null, options: [], followUpMd: '' },
        }}
        gate={CHOSEN}
        canDecide={false}
        routedToLabel="Yue"
        routedToViewer={false}
        itemIdentifier="ACME-42"
      />,
    );
    // What the choice gates stays on the record as information; the *owed* sentence is
    // gone (MOTIR-6436). The lead is bold, so the line is matched by its whole text.
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'SPAN' && el.textContent === 'What this choice gates — The export story.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/planning owed/)).toBeNull();
    expect(screen.queryByText("Can't be decided yet")).toBeNull();
  });
});
