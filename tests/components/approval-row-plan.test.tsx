// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type {
  ApprovalGateDTO,
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
  PlanApprovalSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';

// THE PLAN's TO-APPROVE ROW (Story MOTIR-6012 · Subtask MOTIR-6037), built to
// `design/workbench/approvals-row--plan.mock.html` and `design/ai-planning/design-notes.md`
// Part XXII §22.2–§22.3. A `plan_approval` gate belongs to NO work item, so everything the
// row draws is its SUBJECT: the four leading-line forms, the details, the Being-rewritten
// hold, the decided records — and a door that returns the reader to the PLANNING SURFACE
// (`planSession` + `planVia=approvals`), never the approval overlay, or to `/plans/<id>`
// when the plan has no conversation.

const { shallowPush, push, nav } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  push: vi.fn(),
  nav: { params: new URLSearchParams('tab=approvals') },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => nav.params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
// A plain anchor: the row's native navigation is the BROWSER's, and this suite asserts
// only whether the row let it happen (`defaultPrevented`).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');
const { ApprovalsList } = await import('@/app/(authed)/workbench/_components/ApprovalsList');
const { announceGateDecided, clearGatePressPending, markGatePressPending } =
  await import('@/lib/approvals/decidedGates');

const row = en.approvalGate.planApproval.row;

function subject(over: Partial<PlanApprovalSubjectSummaryDTO> = {}): PlanApprovalSubjectSummaryDTO {
  return {
    kind: 'plan_approval',
    planId: 'plan-41',
    sessionId: 'session-41',
    sessionHasTurns: true,
    title: 'Gate plan approval like every other approval',
    projectName: 'Motir',
    targets: [{ key: 'MOTIR-6010', title: 'Refine AI planning' }],
    proposalCount: 6,
    author: { source: 'native', harness: null, origin: 'user' },
    held: null,
    approving: false,
    ...over,
  };
}

let seq = 0;
function waiting(
  over: Partial<PlanApprovalSubjectSummaryDTO> = {},
  rowOver: Partial<ApprovalQueueRowDto> = {},
): ApprovalQueueRowDto {
  seq += 1;
  return {
    gateId: `gate-plan-${seq}`,
    kind: 'plan_approval',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Yue',
    waitingSince: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    workItem: null,
    subject: subject(over),
    ...rowOver,
  };
}

function decided(
  over: Partial<ApprovalRecordDecidedRowDto> = {},
  subjectOver: Partial<PlanApprovalSubjectSummaryDTO> = {},
): ApprovalRecordDecidedRowDto {
  seq += 1;
  return {
    gateId: `gate-plan-${seq}`,
    kind: 'plan_approval',
    state: 'declined',
    decidedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    decidedByLabel: 'Yue <yue@example.com>',
    decisionSource: 'ui',
    subjectVersion: `plan.v1.3f9a0c12${'e'.repeat(56)}`,
    waitingSince: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    workItem: null,
    subject: subject(subjectOver),
    chosenOption: null,
    confirmedRecord: null,
    refusalVerdict: null,
    refusalReason: null,
    ...over,
  };
}

function gateDto(id: string, state: ApprovalGateDTO['state']): ApprovalGateDTO {
  return {
    id,
    workItemId: null,
    kind: 'plan_approval',
    subjectId: 'plan-41',
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
    chosenOption: null,
    confirmedRecord: null,
    refusalVerdict: null,
    offersRefusalVerdict: false,
    replanOwed: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
}

/** The stretched row door — the first link, labelled for the row. */
function door(): HTMLElement {
  return screen.getAllByRole('link')[0]!;
}

function openedAddress(): URL {
  expect(shallowPush).toHaveBeenCalledTimes(1);
  return new URL(shallowPush.mock.calls[0]![0] as string, 'http://x');
}

beforeEach(() => {
  shallowPush.mockReset();
  push.mockReset();
  nav.params = new URLSearchParams('tab=approvals');
});
afterEach(cleanup);

describe('the LEADING LINE — what the plan is about, in four forms (§22.3, Panel 1)', () => {
  it('one target: *Plan for {target title}*, the title is the target’s quick-view door, the key follows', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />);
    expect(screen.getByText('Plan for')).toBeTruthy();
    const title = screen.getByRole('link', { name: 'Refine AI planning' });
    expect(title.getAttribute('href')).toBe('/items/MOTIR-6010');
    expect(screen.getByText('MOTIR-6010')).toBeTruthy();
    expect(door().getAttribute('aria-label')).toBe('Review plan — Plan for Refine AI planning');
    expect(door().getAttribute('href')).toBe('/plans/plan-41');
    expect(door().getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('several targets: leads with the first, the key cell says `+n` with every key in its title', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: waiting({
            targets: [
              { key: 'ACME-12', title: 'Billing' },
              { key: 'ACME-31', title: 'Invoices' },
              { key: 'ACME-40', title: 'Dunning' },
            ],
          }),
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Billing' })).toBeTruthy();
    const keys = screen.getByText('ACME-12 +2');
    expect(keys.getAttribute('title')).toBe('ACME-12, ACME-31, ACME-40');
    expect(screen.queryByText('Invoices')).toBeNull();
  });

  it('no target, a title: *Plan — {plan title}*, plain text — a plan has no quick view', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: waiting({ targets: [], title: 'three stories for Reporting' }),
        }}
      />,
    );
    expect(screen.getByText('Plan —')).toBeTruthy();
    expect(screen.getByText('three stories for Reporting').tagName).toBe('SPAN');
    // Only the row door is a link: no title door, no key cell.
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(door().getAttribute('aria-label')).toBe(
      'Review plan — Plan — three stories for Reporting',
    );
  });

  it('no target, no title: *Plan for {project name}* — never a blank, never a bare id', () => {
    renderWithIntl(
      <ApprovalRow record={{ section: 'awaiting', row: waiting({ targets: [], title: null }) }} />,
    );
    expect(screen.getByText('Plan for')).toBeTruthy();
    expect(screen.getByText('Motir')).toBeTruthy();
    expect(screen.queryByText(/plan-41/)).toBeNull();
    expect(door().getAttribute('aria-label')).toBe('Review plan — Plan for Motir');
  });

  it('a target whose title no longer resolves falls to the plan’s title — the key still names it', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: waiting({ targets: [{ key: 'MOTIR-1', title: null }], title: 'A plan' }),
        }}
      />,
    );
    expect(screen.getByText('Plan —')).toBeTruthy();
    expect(screen.getByText('A plan')).toBeTruthy();
    expect(screen.getByText('MOTIR-1')).toBeTruthy();
  });

  it('zh keeps the catalogue’s order — the title first', () => {
    const view = renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />, {
      locale: 'zh',
      messages: zh,
    });
    expect(view.container.textContent).toContain('Refine AI planning的计划');
  });
});

describe('the DETAILS — how much it proposes and who wrote it', () => {
  it.each([
    [
      'Motir',
      { source: 'native' as const, harness: null, origin: 'user' as const },
      '6 proposed items · written by Motir AI',
    ],
    [
      'an agent',
      { source: 'mcp' as const, harness: 'Claude Code', origin: 'user' as const },
      '6 proposed items · written by Claude Code',
    ],
    [
      'the cadence',
      { source: 'native' as const, harness: null, origin: 'cadence' as const },
      '6 proposed items · planned automatically',
    ],
  ])('written by %s', (_label, author, line) => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting({ author }) }} />);
    const details = screen.getByText(line);
    expect(details.getAttribute('title')).toBe('Gate plan approval like every other approval');
  });

  it('one proposal is singular, and an untitled plan carries no details title', () => {
    renderWithIntl(
      <ApprovalRow
        record={{ section: 'awaiting', row: waiting({ proposalCount: 1, title: null }) }}
      />,
    );
    expect(
      screen.getByText('1 proposed item · written by Motir AI').getAttribute('title'),
    ).toBeNull();
  });
});

describe('the STATES in To approve (Panel 2)', () => {
  it('awaiting: the Review button', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />);
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('BEING REWRITTEN: a sky word with its reason, no verb — and the row still opens', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: waiting({
            held: {
              reason: 'revision_in_flight',
              heldBy: null,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        }}
      />,
    );
    const pill = screen.getByText(row.rewriting);
    expect(pill.className).toContain('bg-(--el-tint-sky)');
    expect(pill.getAttribute('title')).toBe(row.rewritingTitle);
    expect(screen.queryByRole('button')).toBeNull();
    // Not § 26's held row.
    expect(screen.queryByText(en.workbench.approvals.live.decidedElsewhere)).toBeNull();
    fireEvent.click(door());
    expect(shallowPush).toHaveBeenCalledTimes(1);
  });

  // Bug MOTIR-9006 — the gate stays `awaiting` until an approval commits, so a plan being
  // approved used to offer Review on a plan halfway through being written.
  it('BEING APPROVED (the read says so): *Approving…* with its reason, no verb — the row still opens', () => {
    renderWithIntl(
      <ApprovalRow record={{ section: 'awaiting', row: waiting({ approving: true }) }} />,
    );
    const pill = screen.getByText(row.approving);
    expect(pill.className).toContain('bg-(--el-tint-sky)');
    expect(pill.getAttribute('title')).toBe(row.approvingTitle);
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.click(door());
    expect(shallowPush).toHaveBeenCalledTimes(1);
  });

  it('BEING APPROVED from THIS page: the press in flight reads *Approving…* before any re-read', () => {
    const r = waiting();
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: r }} />);
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
    act(() => markGatePressPending(r.gateId));
    expect(screen.getByText(row.approving)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    // …and the decision, once announced, settles it — Approved, not Approving.
    act(() => {
      announceGateDecided({ gate: gateDto(r.gateId, 'approved'), filesKept: null });
      clearGatePressPending(r.gateId);
    });
    expect(screen.queryByText(row.approving)).toBeNull();
    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
  });

  it('see but not decide: the shipped Awaiting pill, no button', () => {
    renderWithIntl(
      <ApprovalRow record={{ section: 'awaiting', row: waiting({}, { canDecide: false }) }} />,
    );
    expect(screen.getByText(en.approvalGate.state.awaiting)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['approved', en.approvalGate.state.approved, 'bg-(--el-tint-mint)'],
    ['declined', en.approvalGate.state.declined, 'bg-(--el-tint-peach)'],
  ] as const)(
    'settles IN PLACE when decided on the planning surface — %s',
    (state, label, tint) => {
      const r = waiting();
      renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: r }} />);
      act(() => announceGateDecided({ gate: gateDto(r.gateId, state), filesKept: null }));
      const pill = screen.getByText(label);
      expect(pill.className).toContain(tint);
      expect(screen.queryByRole('button')).toBeNull();
      // Settled ink on the title.
      expect(screen.getByRole('link', { name: 'Refine AI planning' }).className).toContain(
        'text-(--el-text-secondary)',
      );
    },
  );

  it('a row that left the set while looked at reads Decided elsewhere (§ 26)', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'held', row: waiting() }} />);
    expect(screen.getByText(en.workbench.approvals.live.decidedElsewhere)).toBeTruthy();
  });

  it('arrived while looking carries New', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} arrived />);
    expect(screen.getByText(en.workbench.approvals.live.new)).toBeTruthy();
  });
});

describe('the DOOR — the planning surface, never the approval overlay (§22.2)', () => {
  it('a targeted plan: a plain click opens the planning overlay at its conversation, from To approve', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />);
    const notPrevented = fireEvent.click(door());
    expect(notPrevented).toBe(false);
    const href = openedAddress();
    expect(href.pathname).toBe('/workbench');
    expect(href.searchParams.get('tab')).toBe('approvals');
    expect(href.searchParams.get('plan')).toBe('contextual');
    expect(href.searchParams.get('planFrom')).toBe('work-item');
    expect(href.searchParams.get('planItem')).toBe('MOTIR-6010');
    expect(href.searchParams.get('planSession')).toBe('session-41');
    expect(href.searchParams.get('planVia')).toBe('approvals');
    expect(href.searchParams.has('approval')).toBe(false);
  });

  it('an untargeted plan opens the project conversation — via the Review button too', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting({ targets: [] }) }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const href = openedAddress();
    expect(href.searchParams.get('plan')).toBe('project');
    expect(href.searchParams.get('planFrom')).toBe('project');
    expect(href.searchParams.has('planItem')).toBe(false);
    expect(href.searchParams.get('planVia')).toBe('approvals');
  });

  it('NO SESSION: the row lets the real navigation to /plans/<id> happen; Review pushes it', () => {
    renderWithIntl(
      <ApprovalRow
        record={{ section: 'awaiting', row: waiting({ sessionId: null, sessionHasTurns: false }) }}
      />,
    );
    expect(fireEvent.click(door())).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(push).toHaveBeenCalledWith('/plans/plan-41');
  });

  // ⚠️ AMENDED by Story MOTIR-6043 · MOTIR-6045, and it is a BEHAVIOUR CHANGE rather
  // than a rewritten assertion: this case used to sit in the row above, asserting the
  // plan page. `docs/decisions/mcp-authored-plan-review.md` decided that an agent's
  // plan is reviewed in the planning phase *"turns or no turns"*, so a session with an
  // empty transcript now opens the SURFACE like any other.
  it('a session with NO TURNS still opens the conversation (mcp-authored-plan-review.md)', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: waiting({ sessionId: 'session-41', sessionHasTurns: false }),
        }}
      />,
    );
    fireEvent.click(door());
    expect(openedAddress().searchParams.get('planSession')).toBe('session-41');
    expect(push).not.toHaveBeenCalled();
  });

  it('the target’s title is its QUICK VIEW, not the planning surface', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />);
    fireEvent.click(screen.getByRole('link', { name: 'Refine AI planning' }));
    const href = openedAddress();
    expect(href.searchParams.get('peek')).toBe('MOTIR-6010');
    expect(href.searchParams.has('planSession')).toBe(false);
  });

  it('a modified or middle click keeps its native meaning — the plan page in a new tab', () => {
    renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row: waiting() }} />);
    expect(fireEvent.click(door(), { metaKey: true })).toBe(true);
    expect(fireEvent.click(door(), { button: 1 })).toBe(true);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('a card-less row of any other kind still draws nothing', () => {
    const view = renderWithIntl(
      <ApprovalRow record={{ section: 'awaiting', row: { ...waiting(), subject: null } }} />,
    );
    expect(view.container.textContent).toBe('');
  });
});

describe('DECIDED RECORDS in the Approvals room (Panel 3)', () => {
  it('declined WITH a reason: its first line replaces the details', () => {
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'decided',
          row: decided(
            { refusalReason: 'We are doing Reporting next quarter instead\nand more' },
            { targets: [], title: 'three stories for Reporting' },
          ),
        }}
        person={{ label: 'Decided by', value: 'Yue' }}
      />,
    );
    expect(screen.getByText('“We are doing Reporting next quarter instead”')).toBeTruthy();
    expect(screen.getByText(en.approvalGate.state.declined)).toBeTruthy();
    expect(screen.getByText('Yue')).toBeTruthy();
  });

  it('declined WITHOUT one: *Declined without a reason · on {version}*, the digest’s first 8', () => {
    const r = decided();
    renderWithIntl(<ApprovalRow record={{ section: 'decided', row: r }} />);
    const version = screen.getByText('3f9a0c12');
    expect(version.className).toContain('font-mono');
    const cell = version.parentElement!;
    expect(cell.textContent).toBe('Declined without a reason · on 3f9a0c12');
    expect(cell.getAttribute('title')).toBe(r.subjectVersion);
  });

  it('declined with no recorded version says so', () => {
    renderWithIntl(
      <ApprovalRow record={{ section: 'decided', row: decided({ subjectVersion: null }) }} />,
    );
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'SPAN' &&
          /^Declined without a reason · on no version$/i.test(el.textContent ?? ''),
      ),
    ).toBeTruthy();
  });

  it('approved: the details line and the Approved pill', () => {
    renderWithIntl(
      <ApprovalRow record={{ section: 'decided', row: decided({ state: 'approved' }) }} />,
    );
    expect(screen.getByText('6 proposed items · written by Motir AI')).toBeTruthy();
    expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy();
  });
});

describe('the TAB passes a plan row through — nothing kind-specific in the list', () => {
  it('ApprovalsList renders the plan row among the others', () => {
    const r = waiting();
    renderWithIntl(<ApprovalsList rows={[r]} label="To approve" ceiling={null} empty={null} />);
    const table = screen.getByRole('table', { name: 'To approve' });
    expect(within(table).getByTestId(`approval-row-${r.gateId}`)).toBeTruthy();
    expect(within(table).getByText('Plan for')).toBeTruthy();
  });
});
