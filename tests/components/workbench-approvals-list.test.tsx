// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { announceGateDecided } from '@/lib/approvals/decidedGates';
import type {
  ApprovalGateDTO,
  ApprovalQueueRowDto,
  DesignResultSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';
import type { ReviewToRunRowDTO } from '@/lib/dto/reviewState';

// THE APPROVALS TAB'S LIST (Story MOTIR-4879 · Subtask MOTIR-4794), RE-SCOPED by
// Subtask MOTIR-5225 (Story MOTIR-5214): the row no longer discloses a frame, it
// OPENS THE APPROVAL OVERLAY (`design/workbench/design-notes.md` § 22 Panel 9).
//
// What this file holds in place:
//
//   · the row is a REAL link to the card, and only a plain primary click is
//     turned into the overlay's address — every other click keeps its native
//     meaning (`usePeekRowClick`'s contract);
//   · the address is written OVER this page, with `shallowPush`, keeping the
//     tab's own query — so closing returns to exactly this page of the list;
//   · every row has the door, and the decision is withheld where it must be,
//     never the look;
//   · a gate decided in the overlay SETTLES its row in place, through the signal
//     a `router.refresh()` cannot deliver to a client island.
//
// happy-dom + the repo's own matchers (no jest-dom here), so assertions read
// `.toBeTruthy()` / `.textContent`.

const { push, refresh, shallowPush } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  shallowPush: vi.fn(),
}));
let params = new URLSearchParams('tab=approvals&page=2');

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => '/workbench',
  useSearchParams: () => params,
}));

vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { ApprovalsList } = await import('../../app/(authed)/workbench/_components/ApprovalsList');

/** The empty state a tab's list draws when it holds nothing (MOTIR-5245). */
const EMPTY = <p>Nothing is waiting</p>;

function designRow(over: Partial<ApprovalQueueRowDto> = {}): ApprovalQueueRowDto {
  return {
    gateId: 'gate-1',
    kind: 'design_result',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Mara S.',
    waitingSince: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    workItem: {
      id: 'wi-1',
      key: 5147,
      identifier: 'MOTIR-5147',
      title: 'Design — the To-approve row',
      kind: 'subtask',
      type: 'design',
    },
    subject: {
      kind: 'design_result',
      designEvidenceId: 'ev-1',
      producedByKey: 'MOTIR-5147',
      commitSha: '9840d00ea1b2',
      assetCount: 3,
      noteExcerpt: 'The row opens the overlay.',
    },
    ...over,
  };
}

const OPENED = '/workbench?tab=approvals&page=2&approval=MOTIR-5147&approvalKind=design_result';

function renderRows(rows: ApprovalQueueRowDto[]) {
  return renderWithIntl(
    <ApprovalsList rows={rows} label="To approve" ceiling={null} empty={EMPTY} />,
  );
}

/** The whole-row door — named for the row, so it never reads as a second "Review". */
function rowDoor(key = 'MOTIR-5147') {
  return screen.getByRole('link', { name: new RegExp(`^Review ${key} `) });
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  params = new URLSearchParams('tab=approvals&page=2');
});
afterEach(cleanup);

describe('the Approvals list — the row', () => {
  it('reads as a SENTENCE about the work item, its key after it, the details beside (MOTIR-5999)', () => {
    renderRows([designRow()]);

    // The sentence — its frame words and the title, in one accessible name.
    expect(screen.getByText('Design for')).toBeTruthy();
    expect(screen.getByText('Design — the To-approve row')).toBeTruthy();
    expect(rowDoor().getAttribute('aria-label')).toBe(
      'Review MOTIR-5147 — Design for Design — the To-approve row',
    );
    expect(screen.getByText('MOTIR-5147')).toBeTruthy();
    // The details are what the kind printed after its label, unchanged.
    expect(screen.getByText(/3 files/)).toBeTruthy();
    expect(screen.getByText(/9840d00e/)).toBeTruthy();
    // The KIND label is gone from the row.
    expect(screen.queryByText('Design result')).toBeNull();
  });

  it('renders rows in the order the read returned them — the read orders, the list does not re-sort', () => {
    const older = designRow({ gateId: 'gate-old', waitingSince: '2026-09-01T10:00:00.000Z' });
    const newer = designRow({ gateId: 'gate-new', waitingSince: '2026-09-10T10:00:00.000Z' });

    renderRows([older, newer]);

    const rendered = screen.getAllByTestId(/^approval-row-/).map((el) => el.dataset['testid']);
    expect(rendered).toEqual(['approval-row-gate-old', 'approval-row-gate-new']);
  });

  it('reads a short wait in HOURS and a long one in DAYS', () => {
    renderRows([
      designRow({
        gateId: 'gate-hours',
        waitingSince: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      }),
      designRow({ gateId: 'gate-days' }),
    ]);

    const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
    expect(screen.getByText(fmt.format(-3, 'hour'))).toBeTruthy();
    expect(screen.getByText(fmt.format(-4, 'day'))).toBeTruthy();
  });

  it('says NO VERSION for a design published without a commit', () => {
    const subject = { ...designRow().subject, commitSha: null } as DesignResultSubjectSummaryDTO;
    renderRows([designRow({ subject })]);

    expect(screen.getByText(/no version/)).toBeTruthy();
  });

  it('the work item is the sentence’s subject, not a column — the Details column holds the rest (MOTIR-5999)', () => {
    renderRows([designRow()]);

    expect(screen.getByRole('columnheader', { name: 'Details' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Work item' })).toBeNull();
  });
});

describe('the Approvals list — the TITLE is the quick-view door (MOTIR-6001, § 28 DECISION 3)', () => {
  const titleDoor = () => screen.getByRole('link', { name: 'Design — the To-approve row' });

  it('a plain click on the title writes `?peek=<key>`, keeping the tab — and NOT the overlay', () => {
    renderRows([designRow()]);

    const door = titleDoor();
    expect(door.getAttribute('href')).toBe('/items/MOTIR-5147');
    fireEvent.click(door, { button: 0 });

    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith('/workbench?tab=approvals&page=2&peek=MOTIR-5147');
  });

  it('a plain click on the row outside the title still opens the APPROVAL — no `?peek=`', () => {
    renderRows([designRow()]);

    fireEvent.click(rowDoor(), { button: 0 });

    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith(OPENED);
    expect(shallowPush.mock.calls[0]![0]).not.toContain('peek=');
  });

  it('a ⌘-click or a middle click on the title is left to the browser — the card in a new tab', () => {
    renderRows([designRow()]);

    expect(fireEvent.click(titleDoor(), { button: 0, metaKey: true })).toBe(true);
    expect(fireEvent.click(titleDoor(), { button: 1 })).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('the title and Review are two distinct, distinctly named stops', () => {
    renderRows([designRow()]);

    expect(titleDoor()).not.toBe(rowDoor());
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
    expect(titleDoor().textContent).not.toMatch(/^Review/);
  });
});

describe('the Approvals list — the row OPENS THE APPROVAL OVERLAY', () => {
  it('is a real link to the card, announced as opening a dialog — and no longer a disclosure', () => {
    const { container } = renderRows([designRow()]);

    const door = rowDoor();
    expect(door.getAttribute('href')).toBe('/items/MOTIR-5147');
    expect(door.getAttribute('aria-haspopup')).toBe('dialog');
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  it('a plain primary click writes the overlay address OVER this page, keeping its query', () => {
    renderRows([designRow()]);

    const proceeded = fireEvent.click(rowDoor(), { button: 0 });

    expect(proceeded).toBe(false); // the navigation to the card was intercepted
    expect(shallowPush).toHaveBeenCalledWith(OPENED);
    // A shallow write: nothing asked the server for the page again.
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['⌘', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
  ])('a %s-click is left to the browser — the card, in a new tab', (_label, modifier) => {
    renderRows([designRow()]);

    const proceeded = fireEvent.click(rowDoor(), { button: 0, ...modifier });

    expect(proceeded).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a non-primary click is left to the browser too', () => {
    renderRows([designRow()]);

    // Dispatched straight at the handler's condition: a middle click arrives as
    // `auxclick` in a real browser and never reaches `onClick` at all.
    const proceeded = fireEvent.click(rowDoor(), { button: 1 });

    expect(proceeded).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('the Review button is the labelled door, to the same address', () => {
    renderRows([designRow()]);

    const review = screen.getByRole('button', { name: 'Review' });
    expect(review.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(review);

    expect(shallowPush).toHaveBeenCalledWith(OPENED);
  });

  it('renders NO frame in the list, opened or not — the overlay is where a gate is decided', () => {
    renderRows([designRow()]);

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));

    expect(screen.queryByRole('group', { name: en.approvalGate.port.label })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getAllByTestId(/^approval-row-/)).toHaveLength(1);
  });

  it('keeps a host page with no query of its own clean', () => {
    params = new URLSearchParams();
    renderRows([designRow()]);

    fireEvent.click(rowDoor());

    expect(shallowPush).toHaveBeenCalledWith(
      '/workbench?approval=MOTIR-5147&approvalKind=design_result',
    );
  });
});

describe('the Approvals list — rows with no subject to show', () => {
  it('says a kind is NOT BUILT YET, offers nothing to decide, and still opens — on its own kind', () => {
    const row = designRow({
      gateId: 'gate-approval',
      // The one declared hole left — RETIRED by MOTIR-5616. (`decision_approval` stood
      // here until MOTIR-5676 registered it; its row is MOTIR-5679's.)
      kind: 'pull_request_merge',
      subject: { kind: 'pull_request_merge' },
    });
    renderRows([row]);

    // The NEUTRAL sentence — the build has no word for this kind — still names the work
    // item (MOTIR-5999, design-notes § 28).
    expect(screen.getByText('Approval for')).toBeTruthy();
    expect(screen.getByText('Design — the To-approve row')).toBeTruthy();
    expect(screen.queryByText('Pull-request merge')).toBeNull();
    expect(screen.getByText('Not built yet')).toBeTruthy();
    expect(screen.getByText('Motir cannot show this kind yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();

    // The overlay draws this arm (§ 22 Panel 4a), so the row has the door.
    fireEvent.click(rowDoor());
    expect(shallowPush).toHaveBeenCalledWith(
      '/workbench?tab=approvals&page=2&approval=MOTIR-5147&approvalKind=pull_request_merge',
    );
  });

  it('draws ONE row for a card delivered by two pull requests, and names BOTH in it', () => {
    // Bug MOTIR-5603 · MOTIR-5615, the delta mock's panel 1: a card holds ONE
    // approve-to-merge gate over its whole delivery set, so the tab lists ONE
    // decision and its subject cell names every member.
    const row = designRow({
      gateId: 'gate-approval',
      kind: 'pull_request_approval',
      subject: {
        kind: 'pull_request_approval',
        members: [
          { repo: 'moooon/motir-core', number: 131, headSha: 'aa11bb22', state: 'open' },
          { repo: 'moooon/motir-gateway', number: 57, headSha: 'cc33dd44', state: 'open' },
        ],
      },
    });
    renderRows([row]);

    // The data rows, not the header: one card, one decision, one row.
    expect(screen.getAllByTestId(/^approval-row-/)).toHaveLength(1);
    // The sentence, and the set named by its repositories — the numbers in the title.
    expect(screen.getByText('is finished')).toBeTruthy();
    const set = screen.getByText('In motir-core, motir-gateway');
    expect(set.getAttribute('title')).toBe('moooon/motir-core · #131, moooon/motir-gateway · #57');
  });

  it('gives a MERGE gate no row treatment of its own — the per-pull-request row is gone', () => {
    // MOTIR-5615: the kind's arm was deleted from `ApprovalRow`. Nothing raises it
    // (MOTIR-5611) and every row it left is superseded (MOTIR-5614), so the only way
    // to reach one is by hand — and it falls in with the kinds this build does not
    // draw rather than being named as a pull request.
    // Since MOTIR-5616 the kind is UNREGISTERED, so its summary is the kind alone —
    // the same answer every kind this build does not render gets.
    const row = designRow({
      gateId: 'gate-merge',
      kind: 'pull_request_merge',
      subject: { kind: 'pull_request_merge' },
    });
    renderRows([row]);

    // ⚠️ THE PILL IS NOT THE POINT — the ROW is. `notBuiltYet` still ships for
    // `decision_approval`, which genuinely has no decide surface yet; what went is any
    // row naming one pull request as a decision of its own.
    expect(screen.queryByText(/pull request$/)).toBeNull();
    expect(screen.getByText('Motir cannot show this kind yet')).toBeTruthy();
  });

  it('says the SUBJECT IS GONE — a different row from not-built-yet — and still opens', () => {
    const row = designRow({ gateId: 'gate-gone', subject: null });
    renderRows([row]);

    expect(screen.getByText('The design this asked about is gone')).toBeTruthy();
    // Still a `design_result` — the kind IS built, so it keeps its own sentence…
    expect(screen.getByText('Design for')).toBeTruthy();
    // …and its Decide cell says GONE, never *Not built yet* (design-notes § 28,
    // DECISION 4: § 20's "look alike and are opposite", corrected on the record).
    expect(screen.getByText('Gone')).toBeTruthy();
    expect(screen.queryByText('Not built yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();

    fireEvent.click(rowDoor());
    expect(shallowPush).toHaveBeenCalledWith(OPENED);
  });
});

describe('the Approvals list — SEE but not DECIDE', () => {
  it("renders the row's state and NO decide control, and the row still opens", () => {
    renderRows([designRow({ canDecide: false })]);

    // No Review button — the decision is withheld.
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.getByText('Awaiting')).toBeTruthy();

    // …but the LOOK is not: the overlay draws the frame's state `B`.
    fireEvent.click(rowDoor());
    expect(shallowPush).toHaveBeenCalledWith(OPENED);
  });
});

/** A decision as the overlay announces it (MOTIR-5570). The row reads only its state. */
function decision(id: string, state: ApprovalGateDTO['state']) {
  const gate: ApprovalGateDTO = {
    id,
    workItemId: 'wi-1',
    kind: 'design_result',
    subjectId: 'ev-1',
    state,
    decidedById: null,
    decidedAt: null,
    noteMd: null,
    supersededCause: null,
    subjectVersion: null,
    decidedByLabel: null,
    routedToId: null,
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
  return { gate, filesKept: null };
}

describe('the Approvals list — a gate decided in the OVERLAY settles its row', () => {
  // The store outlives a render, as it does in the product, so each case decides
  // a gate no other case uses.

  it('swaps the Decide cell for the state pill, in place — the row neither vanishes nor moves', () => {
    const decided = designRow({ gateId: 'gate-settle-a' });
    const other = designRow({
      gateId: 'gate-settle-b',
      workItem: { ...designRow().workItem!, id: 'wi-2', identifier: 'MOTIR-9', title: 'Other' },
    });
    renderRows([decided, other]);
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(2);

    act(() => announceGateDecided(decision('gate-settle-a', 'approved')));

    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
    const rows = screen.getAllByTestId(/^approval-row-/).map((el) => el.dataset['testid']);
    expect(rows).toEqual(['approval-row-gate-settle-a', 'approval-row-gate-settle-b']);
    // Its verb is gone; the OTHER row's is untouched.
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(1);
    // A settled row keeps its door — the overlay draws the decided record.
    expect(rowDoor().getAttribute('href')).toBe('/items/MOTIR-5147');
  });

  it('draws Changes requested for a gate sent back', () => {
    renderRows([designRow({ gateId: 'gate-settle-c' })]);

    act(() => announceGateDecided(decision('gate-settle-c', 'changes_requested')));

    expect(screen.getByText(en.approvalGate.state.changesRequested)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('draws a WITHDRAWN question colourless — `superseded` is the product’s write, not a person’s', () => {
    renderRows([designRow({ gateId: 'gate-settle-f' })]);

    act(() => announceGateDecided(decision('gate-settle-f', 'superseded')));

    expect(screen.getByText(en.approvalGate.state.withdrawn)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('ignores `awaiting` — it is not a decision', () => {
    renderRows([designRow({ gateId: 'gate-settle-d' })]);

    act(() => announceGateDecided(decision('gate-settle-d', 'awaiting')));

    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('settles a row that mounts AFTER the decision, too', () => {
    act(() => announceGateDecided(decision('gate-settle-e', 'approved')));

    renderRows([designRow({ gateId: 'gate-settle-e' })]);

    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
  });
});

describe('the Approvals list — NO PAGER, and the CEILING line (MOTIR-5998, design-notes § 28)', () => {
  it('lists thirty rows on one tab and draws no pager', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      designRow({
        gateId: `gate-${i}`,
        workItem: { ...designRow().workItem!, id: `wi-${i}`, identifier: `MOTIR-${9000 + i}` },
      }),
    );
    renderRows(rows);

    expect(
      screen.getAllByRole('row').filter((r) => r.dataset.testid?.startsWith('approval-row-')),
    ).toHaveLength(30);
    expect(screen.queryByRole('button', { name: 'Page 2' })).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('under the last row, says how many are shown of how many, and links to the Approvals room', () => {
    renderWithIntl(
      <ApprovalsList
        rows={[designRow()]}
        label="To approve"
        ceiling={{ shown: 500, total: 514 }}
        empty={EMPTY}
      />,
    );

    const note = screen.getByRole('note');
    expect(note.textContent).toBe('Showing the first 500 of 514. Approvals lists every one.');
    expect(within(note).getByRole('link', { name: 'Approvals' }).getAttribute('href')).toBe(
      '/approvals',
    );
  });

  it('says it in zh too', () => {
    renderWithIntl(
      <ApprovalsList
        rows={[designRow()]}
        label="待审批"
        ceiling={{ shown: 500, total: 514 }}
        empty={EMPTY}
      />,
      { locale: 'zh', messages: zh },
    );

    expect(screen.getByRole('note').textContent).toBe(
      '仅显示前 500 项，共 514 项。审批中列出了全部。',
    );
  });
});

describe('the Approvals list — the PULL-REQUEST row (MOTIR-5485, design-notes § 23)', () => {
  const MEMBERS = [
    { repo: 'moooon/motir-core', number: 140 },
    { repo: 'moooon/motir-ai', number: 91 },
    { repo: 'moooon/motir-gateway', number: 12 },
  ];

  function pullRequestRow(count: number, over: Partial<ApprovalQueueRowDto> = {}) {
    return designRow({
      gateId: `gate-pr-${count}`,
      kind: 'pull_request_approval',
      workItem: {
        ...designRow().workItem!,
        identifier: 'ACME-12',
        title: 'Throttle the public API',
        kind: 'story',
        type: null,
      },
      subject: {
        kind: 'pull_request_approval',
        members: MEMBERS.slice(0, count).map((m) => ({
          ...m,
          headSha: 'abc123',
          state: 'open' as const,
        })),
      },
      ...over,
    });
  }

  it.each([
    [1, 'In motir-core'],
    [2, 'In motir-core, motir-ai'],
    [3, 'In motir-core, motir-ai, +1 more'],
  ])(
    'a %i-repository set names its REPOSITORIES by the truncation rule — no numbers (MOTIR-5999)',
    (count, line) => {
      renderRows([pullRequestRow(count)]);

      const subject = screen.getByText(line);
      // The whole list is always in the cell's title.
      expect(subject.getAttribute('title')).toBe(
        MEMBERS.slice(0, count)
          .map((m) => `${m.repo} · #${m.number}`)
          .join(', '),
      );
    },
  );

  it("shows the kind's LIVE glyph and its sentence, and no Not built yet pill", () => {
    renderRows([pullRequestRow(2)]);

    const row = screen.getByTestId('approval-row-gate-pr-2');
    // The approve-to-merge kind reads *{title} is finished* (MOTIR-5999).
    expect(screen.getByText('Throttle the public API')).toBeTruthy();
    expect(screen.getByText('is finished')).toBeTruthy();
    expect(row.querySelector('svg')!.getAttribute('class')).toContain('--el-accent-on-surface');
    expect(screen.queryByText('Not built yet')).toBeNull();
    expect(screen.queryByText('Motir cannot show this kind yet')).toBeNull();
  });

  // ⚠️ AMENDED BY MOTIR-5440 (design-notes § 24's *The ACCESS PATH*): the row used to
  // send the reader to the card, because the overlay could not render this kind. It can
  // now, so the row opens it — *Open work item* becomes *Review*, exactly as § 23 said it
  // would, and the row behaves like every other renderable row.
  it('the row OPENS THE OVERLAY on a plain primary click, and Review is its labelled door', () => {
    renderRows([pullRequestRow(2)]);

    const door = screen.getByRole('link', { name: /^Review ACME-12 / });
    expect(door.getAttribute('href')).toBe('/items/ACME-12');
    expect(door.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(door, { button: 0 });
    expect(shallowPush).toHaveBeenCalledWith(
      expect.stringContaining('approval=ACME-12&approvalKind=pull_request_approval'),
    );
    expect(screen.queryByRole('button', { name: 'Open work item' })).toBeNull();

    shallowPush.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(shallowPush).toHaveBeenCalledWith(
      expect.stringContaining('approval=ACME-12&approvalKind=pull_request_approval'),
    );
  });

  it('a MODIFIED click keeps the href — the card in a new tab, nothing intercepted', () => {
    renderRows([pullRequestRow(2)]);

    const door = screen.getByRole('link', { name: /^Review ACME-12 / });
    expect(fireEvent.click(door, { button: 0, metaKey: true })).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a reader who may not decide sees Awaiting and no door control — and the row still leads to the card', () => {
    renderRows([pullRequestRow(1, { canDecide: false })]);

    expect(screen.getByText('Awaiting')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.getByRole('link', { name: /^Review ACME-12 / }).getAttribute('href')).toBe(
      '/items/ACME-12',
    );
  });
});

// MOTIR-12032 (`design/workbench/design-notes.md` § 45.2): a review to run offers *Review with
// Motir agent* to a reader who may run the card hosted, so the list mounts ONE model list —
// and asks for none when no row offers the door.
describe('the Approvals list — the reviews to run and the hosted door', () => {
  const toRun = (canReviewHosted: boolean): ReviewToRunRowDTO => ({
    kind: 'review_to_run',
    gateId: 'g-run',
    workItemId: 'wi-run',
    identifier: 'ACME-30',
    title: 'Export the totals row',
    subjectVersion: 'v1',
    raisedAt: new Date(Date.now() - 3_600_000).toISOString(),
    command: 'motir review ACME-30',
    canReviewHosted,
  });
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ models: [{ id: 'm-1', provider: 'anthropic' }], default: 'm-1' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  );
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderToRun(row: ReviewToRunRowDTO) {
    return renderWithIntl(
      <ApprovalsList
        rows={[]}
        reviewsToRun={[row]}
        label="To approve"
        ceiling={null}
        empty={EMPTY}
      />,
    );
  }

  it('a row that offers the door mounts the models list once, and the door draws', async () => {
    renderToRun(toRun(true));
    await act(async () => {});
    expect(screen.getByTestId('review-with-motir-agent')).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/hosted-runs/models')),
    ).toHaveLength(1);
  });

  it('no row offering the door asks for no models and draws the command only', async () => {
    renderToRun(toRun(false));
    await act(async () => {});
    expect(screen.queryByTestId('review-with-motir-agent')).toBeNull();
    expect(screen.getByTestId('review-command-copy-ACME-30')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
