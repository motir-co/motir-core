// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { parseDecisionRecord } from '@/lib/approvalGates/decisionRecord';
import type {
  ApprovalGateDTO,
  ConfirmedRecordDTO,
  DecisionConfirmationBodyDTO,
} from '@/lib/dto/approvalGate';

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-42',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn() }));

const { DecisionConfirmGateFrame } = await import('@/components/approvals/DecisionConfirmGate');
const { DecisionConfirmSection } =
  await import('@/app/(authed)/items/[key]/_components/DecisionConfirmSection');

// THE CONFIRM PORT (Story MOTIR-5871 · Subtask MOTIR-5960), built to
// `design/work-items/approval-control--decision-confirm.mock.html`. The port renders in
// the SHARED frame, so these assert what the kind adds: the four sections, the record
// link or its absence, Overturn's REQUIRED note refused in place, and every state the
// gate can be in — confirmed (with, without, and a removed record), overturned (the
// note, the owed re-plan, the Re-plan door), read-only, withdrawn and defective.

afterEach(cleanup);

const t = en.approvalGate.decisionConfirm;

const BODY = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** workflow · less requirement',
  'The approved plan kept exports in Postgres.',
  '## Supersedes',
  'ACME-6 and ACME-9',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

const RECORD: ConfirmedRecordDTO = {
  kind: 'attachment',
  attachmentId: 'att-1',
  originalFilename: 'decision.md',
  mimeType: 'text/markdown',
  sizeBytes: 2048,
  createdAt: '2026-09-20T10:00:00.000Z',
};
function port(record: ConfirmedRecordDTO = RECORD, recordCount = 2) {
  const parse = parseDecisionRecord(BODY);
  if (!parse.ok) throw new Error(parse.defect.reason);
  const { ok: _ok, ...sections } = parse;
  return {
    ...sections,
    record,
    recordCount,
    presentRecordIds: record.kind === 'attachment' ? [record.attachmentId] : [],
    // ACME-9 names nothing in the project — plain mono text, never a defect.
    supersedesItems: [
      { key: 'ACME-6', title: 'Postgres export table' },
      { key: 'ACME-9', title: null },
    ],
  };
}

const AWAITING: ApprovalGateDTO = {
  id: 'gate-d1',
  workItemId: 'wi-42',
  kind: 'decision_confirmation',
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
const DECIDED = {
  decidedById: 'user-1',
  decidedAt: '2026-09-21T14:02:00.000Z',
  decidedByLabel: 'Yue',
  decidedUnderAuthority: 'assignee' as const,
  decisionSource: 'ui' as const,
};
const CONFIRMED: ApprovalGateDTO = {
  ...AWAITING,
  ...DECIDED,
  state: 'approved',
  outcomeRef: 'done',
  confirmedRecord: RECORD,
};
const OVERTURNED: ApprovalGateDTO = {
  ...AWAITING,
  ...DECIDED,
  state: 'overturned',
  outcomeRef: 'cancelled',
  noteMd: 'We agreed to keep Postgres and add a cache.',
  replanOwed: { keys: ['ACME-6', 'ACME-9'] },
};

function renderFrame(
  props: Partial<React.ComponentProps<typeof DecisionConfirmGateFrame>> = {},
  onDecide = vi.fn(async () => null),
) {
  const p = port();
  renderWithIntl(
    <DecisionConfirmGateFrame
      gate={AWAITING}
      view={p}
      workItemRefs={{}}
      record={p.record}
      recordCount={p.recordCount}
      presentRecordIds={p.presentRecordIds}
      canDecide
      routedToLabel="Yue"
      identifier="ACME-42"
      onDecide={onDecide}
      {...props}
    />,
  );
  return onDecide;
}

describe('the port — the four sections and the record (Panel 1)', () => {
  it('renders the decision, one chip per change, the superseded chips and the direction', () => {
    renderFrame();
    expect(screen.getByText('Exports move to managed object storage.')).toBeTruthy();
    expect(screen.getAllByText('workflow').length).toBeGreaterThan(0);
    expect(screen.getAllByText('less requirement').length).toBeGreaterThan(0);
    expect(screen.getByText('The approved plan kept exports in Postgres.')).toBeTruthy();
    // A resolved key is a LINK with its title; an unresolved one is plain text.
    const linked = screen.getByRole('link', { name: /ACME-6/ });
    expect(linked.getAttribute('href')).toBe('/items/ACME-6');
    expect(within(linked).getByText('Postgres export table')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /ACME-9/ })).toBeNull();
    expect(screen.getByText('ACME-9')).toBeTruthy();
    expect(screen.getByText('Every export is written to the bucket.')).toBeTruthy();
  });

  it('links the written record with its size and which of several it chose', () => {
    renderFrame();
    const link = screen.getByRole('link', { name: /decision\.md/ });
    expect(link.getAttribute('href')).toBe('/api/attachments/att-1/content');
    expect(screen.getByText(/newest of 2 markdown attachments/)).toBeTruthy();
  });

  it('with no record, says so in one sentence — never an empty slot', () => {
    const p = port({ kind: 'none' }, 0);
    renderFrame({ record: p.record, recordCount: 0, presentRecordIds: [] });
    expect(screen.getByText(t.record.none)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /\.md/ })).toBeNull();
  });
});

describe('band 3 — Overturn · Confirm (Panel 2)', () => {
  it('Confirm opens its own confirm list and sends approve', async () => {
    const onDecide = renderFrame();
    fireEvent.click(screen.getByRole('button', { name: t.verb.confirm }));
    expect(screen.getByText(t.confirmStep.title)).toBeTruthy();
    expect(
      screen.getByText(
        'Record that you confirmed this decision, with its written record decision.md.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Move ACME-42 to Done.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t.confirmStep.proceed }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve'));
  });

  it('Confirm with no record words its list without a file', () => {
    const p = port({ kind: 'none' }, 0);
    renderFrame({ record: p.record, recordCount: 0, presentRecordIds: [] });
    fireEvent.click(screen.getByRole('button', { name: t.verb.confirm }));
    expect(screen.getByText(t.confirmStep.recordWithout)).toBeTruthy();
  });

  it('Overturn with an EMPTY note is refused in place and never reaches the door', async () => {
    const onDecide = renderFrame();
    fireEvent.click(screen.getByRole('button', { name: t.verb.overturn }));
    expect(screen.getByText(t.overturnStep.title)).toBeTruthy();
    expect(
      screen.getByText(
        'Leave a re-plan owed for ACME-6, ACME-9. Nothing else changes until someone re-plans.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText(t.note.label)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t.overturnStep.proceed }));
    expect(await screen.findByText(t.note.required)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t.note.label), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: t.overturnStep.proceed }));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('Overturn with a note sends overturn and the trimmed note', async () => {
    const onDecide = renderFrame();
    fireEvent.click(screen.getByRole('button', { name: t.verb.overturn }));
    fireEvent.click(screen.getByRole('button', { name: t.overturnStep.proceed }));
    await screen.findByText(t.note.required);
    // Typing clears the refusal.
    fireEvent.change(screen.getByLabelText(t.note.label), {
      target: { value: '  Keep Postgres.  ' },
    });
    expect(screen.queryByText(t.note.required)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t.overturnStep.proceed }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith('overturn', undefined, 'Keep Postgres.'),
    );
  });

  it('Cancel leaves the confirm band and decides nothing', () => {
    const onDecide = renderFrame();
    fireEvent.click(screen.getByRole('button', { name: t.verb.overturn }));
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.confirm.cancel }));
    expect(screen.queryByText(t.overturnStep.title)).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe('the decided bands — read from the STAMP (Panels 3–4)', () => {
  it('Confirmed with a written record: the pill, the lead and the file as a link', () => {
    renderFrame({ gate: CONFIRMED, canDecide: false });
    expect(screen.getByText(t.state.confirmed)).toBeTruthy();
    expect(screen.getByText(/Confirmed by Yue/)).toBeTruthy();
    expect(screen.getByText(t.band.withRecord)).toBeTruthy();
    expect(screen.getByRole('link', { name: /decision\.md/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.verb.confirm })).toBeNull();
  });

  it('Confirmed without a written record says so — never an error', () => {
    renderFrame({ gate: { ...CONFIRMED, confirmedRecord: { kind: 'none' } }, canDecide: false });
    expect(screen.getByText(t.band.withoutRecord)).toBeTruthy();
  });

  it('record removed: the stamped filename, NO link, and the removed line', () => {
    renderFrame({ gate: CONFIRMED, canDecide: false, presentRecordIds: [] });
    expect(screen.getByText('decision.md')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /decision\.md/ })).toBeNull();
    expect(screen.getByText(t.band.recordRemoved)).toBeTruthy();
  });

  it('Overturned: its own pill, the note quoted, the owed re-plan chips and Re-plan with AI', () => {
    renderFrame({ gate: OVERTURNED, canDecide: false, replan: { canReplan: true } });
    expect(screen.getByText(en.approvalGate.state.overturned)).toBeTruthy();
    expect(screen.queryByText(en.approvalGate.state.changesRequested)).toBeNull();
    expect(screen.getByText(/Overturned by Yue/)).toBeTruthy();
    expect(screen.getByText('“We agreed to keep Postgres and add a cache.”')).toBeTruthy();
    expect(screen.getByText(t.band.replanOwed)).toBeTruthy();
    expect(screen.getAllByText('ACME-9').length).toBeGreaterThan(0);
    // MOTIR-6211: the SEEDED door on this decision replaced the plain epic entrance.
    expect(screen.getByTestId('refusal-replan-door').textContent).toBe(
      en.approvalGate.replanDoor.label,
    );
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
    expect(screen.queryByText('Exports (ACME-1)')).toBeNull();
  });

  it('Overturned for a reader who may not plan draws no door, and no note when none was stored', () => {
    renderFrame({
      gate: { ...OVERTURNED, noteMd: null, replanOwed: null },
      canDecide: false,
    });
    expect(screen.getByText(t.band.replanOwed)).toBeTruthy();
    expect(screen.queryByTestId('refusal-replan-door')).toBeNull();
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });
});

describe('read-only and withdrawn (Panel 6)', () => {
  it('a reader who may not decide sees the sections and NO verb', () => {
    renderFrame({ canDecide: false });
    expect(screen.getByText('Exports move to managed object storage.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.verb.confirm })).toBeNull();
    expect(screen.queryByRole('button', { name: t.verb.overturn })).toBeNull();
  });

  it('a superseded gate renders the withdrawn state, not a blank', () => {
    renderFrame({
      gate: { ...AWAITING, state: 'superseded', supersededCause: 'republished' },
      canDecide: false,
    });
    expect(screen.getByText(en.approvalGate.state.withdrawn)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.verb.confirm })).toBeNull();
  });
});

describe('the item page — the Decision section', () => {
  function body(record: ConfirmedRecordDTO = RECORD): DecisionConfirmationBodyDTO {
    return { ok: true, port: port(record) };
  }

  it('a defective body shows the reason, the tail and the sections — NO verb', () => {
    const parse = parseDecisionRecord(BODY.replace('ACME-6 and ACME-9', 'nothing'));
    if (parse.ok) throw new Error('expected a defect');
    renderWithIntl(
      <DecisionConfirmSection
        workItemRefs={{}}
        body={{
          ok: false,
          defect: parse.defect,
          draft: parse.draft,
          record: { kind: 'none' },
          recordCount: 0,
          presentRecordIds: [],
          supersedesItems: [],
        }}
        gate={null}
        canDecide
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.getByText(t.defect.title)).toBeTruthy();
    expect(screen.getByText(t.defect.empty_supersedes)).toBeTruthy();
    expect(screen.getByText(t.defect.tail)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.verb.confirm })).toBeNull();
  });

  it('an unknown change names the value it could not read', () => {
    const parse = parseDecisionRecord(BODY.replace('less requirement', 'a new vendor'));
    if (parse.ok) throw new Error('expected a defect');
    renderWithIntl(
      <DecisionConfirmSection
        workItemRefs={{}}
        body={{
          ok: false,
          defect: parse.defect,
          draft: parse.draft,
          record: { kind: 'none' },
          recordCount: 0,
          presentRecordIds: [],
          supersedesItems: [],
        }}
        gate={null}
        canDecide
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.getByText(/“a new vendor” is not a change a decision records/)).toBeTruthy();
  });

  it('an awaiting decision for its decider shows the sections and ONE door — Review & confirm', () => {
    renderWithIntl(
      <DecisionConfirmSection
        workItemRefs={{}}
        body={body()}
        gate={AWAITING}
        canDecide
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.getByText('Exports move to managed object storage.')).toBeTruthy();
    expect(screen.getByRole('link', { name: t.cta.button })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.verb.confirm })).toBeNull();
  });

  it('no gate yet renders the sections read-only with the record line', () => {
    renderWithIntl(
      <DecisionConfirmSection
        workItemRefs={{}}
        body={body({ kind: 'none' })}
        gate={null}
        canDecide
        routedToLabel="Yue"
        routedToViewer
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.getByText(t.record.none)).toBeTruthy();
    expect(screen.queryByRole('link', { name: t.cta.button })).toBeNull();
  });

  it('a decided gate whose body stopped parsing still shows its record band', () => {
    const parse = parseDecisionRecord('## Decision\nOnly this.');
    if (parse.ok) throw new Error('expected a defect');
    renderWithIntl(
      <DecisionConfirmSection
        workItemRefs={{}}
        body={{
          ok: false,
          defect: parse.defect,
          draft: parse.draft,
          record: { kind: 'none' },
          recordCount: 0,
          presentRecordIds: [],
          supersedesItems: [],
        }}
        gate={{ ...CONFIRMED, confirmedRecord: { kind: 'none' } }}
        canDecide={false}
        routedToLabel="Yue"
        routedToViewer={false}
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.getByText(t.band.withoutRecord)).toBeTruthy();
    expect(screen.queryByText(t.defect.title)).toBeNull();
  });

  it('an awaiting decision routed to someone else is the frame with who it waits on', () => {
    renderWithIntl(
      <DecisionConfirmSection
        workItemRefs={{}}
        body={body()}
        gate={AWAITING}
        canDecide={false}
        routedToLabel="Ada Lovelace"
        routedToViewer={false}
        itemIdentifier="ACME-42"
      />,
    );
    expect(screen.getByText(/Ada Lovelace/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.verb.confirm })).toBeNull();
  });
});
