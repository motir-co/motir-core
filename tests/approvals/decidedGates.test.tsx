// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import {
  announceGateDecided,
  announceGateStateDecided,
  clearGatePressPending,
  markGatePressPending,
  useDecidedGate,
  useDecidedGateState,
  useGatePressPending,
} from '@/lib/approvals/decidedGates';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// THE DECIDED-GATE SIGNAL (Story MOTIR-5214 · Subtask MOTIR-5225) — how a decision
// made in the approval overlay reaches the To-approve row's client island
// (`design/workbench/design-notes.md` § 22 planning flag 2), and since Story
// MOTIR-5215 · Subtask MOTIR-5570 the item page underneath it too. The store is
// module-level, as it is in the product, so every case uses its own gate id.

const GATE: ApprovalGateDTO = {
  id: 'gate-x',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: '9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  offersRefusalVerdict: false,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

function decision(
  id: string,
  state: ApprovalGateDTO['state'],
  extra: { outcomeRef?: string | null; filesKept?: boolean | null } = {},
) {
  return {
    gate: { ...GATE, id, state, outcomeRef: extra.outcomeRef ?? null },
    filesKept: extra.filesKept ?? null,
  };
}

function Probe({ gateId }: { gateId: string }) {
  const state = useDecidedGateState(gateId);
  return <span data-testid={gateId}>{state ?? 'none'}</span>;
}

function WholeProbe({ gateId }: { gateId: string }) {
  const entry = useDecidedGate(gateId);
  return (
    <span data-testid={`whole-${gateId}`}>
      {entry
        ? `${entry.gate.state}|${entry.gate.outcomeRef ?? 'null'}|${String(entry.filesKept)}`
        : 'none'}
    </span>
  );
}

afterEach(cleanup);

describe('the decided-gate signal (MOTIR-5225)', () => {
  it('reads null for a gate nobody decided', () => {
    render(<Probe gateId="g-none" />);
    expect(screen.getByTestId('g-none').textContent).toBe('none');
  });

  it('wakes a mounted watcher with the state its gate reached — and only that gate', () => {
    render(
      <>
        <Probe gateId="g-a" />
        <Probe gateId="g-b" />
      </>,
    );

    act(() => announceGateDecided(decision('g-a', 'approved')));

    expect(screen.getByTestId('g-a').textContent).toBe('approved');
    expect(screen.getByTestId('g-b').textContent).toBe('none');
  });

  it('does not treat `awaiting` as a decision', () => {
    render(<Probe gateId="g-await" />);
    act(() => announceGateDecided(decision('g-await', 'awaiting')));
    expect(screen.getByTestId('g-await').textContent).toBe('none');
  });

  it('renders null on the server, whatever this tab has seen', () => {
    act(() => announceGateDecided(decision('g-server', 'changes_requested')));
    expect(renderToString(<Probe gateId="g-server" />)).toContain('none');
  });
});

describe('the decided-gate signal carries the WHOLE decision (MOTIR-5570)', () => {
  it('hands the decided row, its outcomeRef and filesKept to a watcher', () => {
    render(<WholeProbe gateId="g-whole" />);
    expect(screen.getByTestId('whole-g-whole').textContent).toBe('none');

    act(() =>
      announceGateDecided(decision('g-whole', 'approved', { outcomeRef: 'done', filesKept: true })),
    );

    expect(screen.getByTestId('whole-g-whole').textContent).toBe('approved|done|true');
  });

  it('a repeat of the same decided state is not a change — the first entry stands', () => {
    act(() => announceGateDecided(decision('g-repeat', 'approved', { filesKept: true })));
    render(<WholeProbe gateId="g-repeat" />);
    act(() => announceGateDecided(decision('g-repeat', 'approved', { filesKept: false })));
    expect(screen.getByTestId('whole-g-repeat').textContent).toBe('approved|null|true');
  });

  it('renders null on the server for the whole decision too', () => {
    act(() => announceGateDecided(decision('g-whole-server', 'approved')));
    expect(renderToString(<WholeProbe gateId="g-whole-server" />)).toContain('none');
  });
});

describe('a STATE-only announcement (MOTIR-6037 — a plan decided from the planning rail)', () => {
  it('settles the row that reads the state, and invents no decided row for the whole-decision readers', () => {
    render(
      <>
        <Probe gateId="g-plan" />
        <WholeProbe gateId="g-plan" />
      </>,
    );
    act(() => announceGateStateDecided('g-plan', 'declined'));
    expect(screen.getByTestId('g-plan').textContent).toBe('declined');
    expect(screen.getByTestId('whole-g-plan').textContent).toBe('none');
  });

  it('does not treat `awaiting` as a decision either', () => {
    render(<Probe gateId="g-plan-await" />);
    act(() => announceGateStateDecided('g-plan-await', 'awaiting'));
    expect(screen.getByTestId('g-plan-await').textContent).toBe('none');
  });
});

describe('a PRESS IN FLIGHT on this page (MOTIR-9696)', () => {
  function PendingProbe({ gateId }: { gateId: string }) {
    return <span data-testid={`pending-${gateId}`}>{String(useGatePressPending(gateId))}</span>;
  }

  it('marks and clears one gate, and only that gate', () => {
    render(
      <>
        <PendingProbe gateId="g-press" />
        <PendingProbe gateId="g-other" />
      </>,
    );
    expect(screen.getByTestId('pending-g-press').textContent).toBe('false');

    act(() => markGatePressPending('g-press'));
    expect(screen.getByTestId('pending-g-press').textContent).toBe('true');
    expect(screen.getByTestId('pending-g-other').textContent).toBe('false');

    act(() => clearGatePressPending('g-press'));
    expect(screen.getByTestId('pending-g-press').textContent).toBe('false');
  });

  it('a second mark and a clear of an unmarked gate change nothing', () => {
    render(<PendingProbe gateId="g-twice" />);
    act(() => markGatePressPending('g-twice'));
    act(() => markGatePressPending('g-twice'));
    expect(screen.getByTestId('pending-g-twice').textContent).toBe('true');
    // One clear undoes it: the mark is a set, not a count.
    act(() => clearGatePressPending('g-twice'));
    act(() => clearGatePressPending('g-twice'));
    expect(screen.getByTestId('pending-g-twice').textContent).toBe('false');
  });

  it('renders false on the server, whatever this tab is pressing', () => {
    act(() => markGatePressPending('g-press-server'));
    expect(renderToString(<PendingProbe gateId="g-press-server" />)).toContain('false');
  });
});
