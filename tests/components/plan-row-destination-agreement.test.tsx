// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { PlanApprovalSubjectSummaryDTO } from '@/lib/dto/approvalGate';
import type { SessionRowView } from '@/app/(authed)/plans/_components/types';

// ONE RULE, TWO ROWS (Story MOTIR-6043 · MOTIR-6045; design Part XXI §21.1, ADR
// `approval-gates.md` §11.5b).
//
// ⚠️ THIS SUITE DRIVES BOTH COMPONENTS AND COMPARES THEM, and that is the point
// of it rather than a convenience. Two look-alike suites — one per row, each
// asserting the address it expects — is exactly the shape that let the two lists
// disagree in the first place: both would have passed while the Plans page sent a
// decided plan into a stale conversation. What is asserted here is AGREEMENT, so
// the test fails when one row moves and the other does not.
//
// The two rows are mounted on DIFFERENT hosts on purpose (`/plans` and
// `/workbench`), because the surface address is composed onto the page the row
// sits on. So the comparison is of the overlay's own parameters, not of the whole
// string — comparing the strings would assert the hosts are equal, which they
// must not be.

const { shallowPush, push, nav } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  push: vi.fn(),
  nav: { path: '/plans', params: new URLSearchParams('planState=planned') },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => nav.path,
  useSearchParams: () => nav.params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { SessionRow } = await import('@/app/(authed)/plans/_components/SessionRow');
const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');

afterEach(() => {
  cleanup();
  shallowPush.mockReset();
  push.mockReset();
  nav.path = '/plans';
  nav.params = new URLSearchParams('planState=planned');
});

/** The three facts the rule reads, as ONE fixture both rows are built from. */
interface PlanFacts {
  planId: string;
  sessionId: string | null;
  anchorKey: string | null;
}

const FACTS: PlanFacts = { planId: 'p_31', sessionId: 's_1', anchorKey: 'MOTIR-6010' };

function sessionView(
  facts: PlanFacts,
  status: SessionRowView['latestPlan'] & object,
): SessionRowView {
  return {
    id: facts.sessionId ?? 's_unused',
    origin: 'conversation',
    title: 'Where a plans row goes',
    targetKeys: facts.anchorKey ? [facts.anchorKey] : [],
    activeLabel: '12 minutes ago',
    startedByName: 'Yue',
    latestPlan: status,
    planCount: 1,
    seed: null,
    state: status.status,
    end: null,
    copiedFrom: null,
  };
}

function approvalSubject(facts: PlanFacts): PlanApprovalSubjectSummaryDTO {
  return {
    kind: 'plan_approval',
    planId: facts.planId,
    sessionId: facts.sessionId,
    // Deliberately FALSE on both rows below: the turn count decides nothing any
    // more, so leaving it true would hide a regression that reintroduced it.
    sessionHasTurns: false,
    title: 'Where a plans row goes',
    projectName: 'Motir',
    targets: facts.anchorKey ? [{ key: facts.anchorKey, title: 'Refine AI planning' }] : [],
    proposalCount: 4,
    author: { source: 'native', harness: null, origin: 'user' },
    held: null,
    approving: false,
  };
}

/** The overlay parameters the row wrote, host stripped. */
function overlayOf(href: string): Record<string, string> {
  const url = new URL(href, 'http://x');
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (k.startsWith('plan')) out[k] = v;
  // The host's own filter is not part of the rule's answer, and both rows carry
  // their own; drop it so the comparison is of the overlay alone.
  delete out.planState;
  return out;
}

function plansRowAddress(view: SessionRowView): string {
  nav.path = '/plans';
  nav.params = new URLSearchParams('planState=planned');
  renderWithIntl(<SessionRow view={view} />);
  return screen.getByRole('link', { name: view.title }).getAttribute('href')!;
}

function approvalsRowAddress(subject: PlanApprovalSubjectSummaryDTO): string {
  nav.path = '/workbench';
  nav.params = new URLSearchParams('tab=approvals');
  renderWithIntl(
    <ApprovalRow
      record={{
        section: 'awaiting',
        row: {
          gateId: 'gate-1',
          kind: 'plan_approval',
          state: 'awaiting',
          canDecide: true,
          routedToName: 'Yue',
          waitingSince: new Date().toISOString(),
          workItem: null,
          subject,
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: en.workbench.approvals.review }));
  return shallowPush.mock.calls.at(-1)![0] as string;
}

describe('an UNDECIDED plan: both rows open the SAME conversation', () => {
  it('the two overlay addresses agree, apart from the entrance each row records', () => {
    const fromPlans = overlayOf(
      plansRowAddress(sessionView(FACTS, { id: 'p_31', status: 'planned' })),
    );
    cleanup();
    const fromApprovals = overlayOf(approvalsRowAddress(approvalSubject(FACTS)));

    // The To-approve row alone carries `planVia`, so the reopened line can say
    // which list it came from (§22.2). Everything else must be identical.
    expect(fromApprovals.planVia).toBe('approvals');
    expect(fromPlans.planVia).toBeUndefined();
    const { planVia: _via, ...rest } = fromApprovals;
    expect(rest).toEqual(fromPlans);
    expect(fromPlans.planSession).toBe('s_1');
    expect(fromPlans.planItem).toBe('MOTIR-6010');
  });

  it('a PROJECT-WIDE session agrees on both rows too', () => {
    const facts = { ...FACTS, anchorKey: null };
    const fromPlans = overlayOf(
      plansRowAddress(sessionView(facts, { id: 'p_31', status: 'planned' })),
    );
    cleanup();
    const fromApprovals = overlayOf(approvalsRowAddress(approvalSubject(facts)));

    expect(fromPlans.planFrom).toBe('project');
    expect(fromApprovals.planFrom).toBe('project');
    expect(fromPlans.planItem).toBeUndefined();
    expect(fromApprovals.planItem).toBeUndefined();
  });
});

describe('the TAG says the same thing on both rows', () => {
  it('undecided: both read `Opens the conversation`', () => {
    renderWithIntl(<SessionRow view={sessionView(FACTS, { id: 'p_31', status: 'planned' })} />);
    expect(screen.getByTestId('plan-destination').textContent).toContain(
      en.planDestination.conversation,
    );
    expect(screen.getByTestId('plan-destination').getAttribute('data-destination')).toBe(
      'planning-surface',
    );
    cleanup();

    nav.path = '/workbench';
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: {
            gateId: 'gate-2',
            kind: 'plan_approval',
            state: 'awaiting',
            canDecide: true,
            routedToName: 'Yue',
            waitingSince: new Date().toISOString(),
            workItem: null,
            subject: approvalSubject(FACTS),
          },
        }}
      />,
    );
    expect(screen.getByTestId('plan-destination').textContent).toContain(
      en.planDestination.conversation,
    );
  });

  it('a DECIDED Plans row reads `Opens the plan`, and its row goes to the page', () => {
    renderWithIntl(<SessionRow view={sessionView(FACTS, { id: 'p_31', status: 'approved' })} />);
    const tag = screen.getByTestId('plan-destination');
    expect(tag.textContent).toContain(en.planDestination.plan);
    expect(tag.getAttribute('data-destination')).toBe('plan-page');
    expect(screen.getByRole('link', { name: 'Where a plans row goes' }).getAttribute('href')).toBe(
      '/plans/p_31',
    );
  });

  it('a To-approve row with NO SESSION reads the plain plan form, and says nothing more (MOTIR-7885)', () => {
    nav.path = '/workbench';
    renderWithIntl(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: {
            gateId: 'gate-3',
            kind: 'plan_approval',
            state: 'awaiting',
            canDecide: true,
            routedToName: 'Yue',
            waitingSince: new Date().toISOString(),
            workItem: null,
            subject: approvalSubject({ ...FACTS, sessionId: null }),
          },
        }}
      />,
    );
    const tag = screen.getByTestId('plan-destination');
    expect(tag.textContent).toContain(en.planDestination.plan);
    expect(tag.getAttribute('data-destination')).toBe('plan-page');
    // The retired copy, inlined because its key is gone (Story MOTIR-7883).
    expect(tag.textContent).not.toContain('no conversation');
    expect(tag.hasAttribute('title')).toBe(false);
  });
});

describe('THE CHIP RULE — the arrow means somewhere the row does not go (§21.5)', () => {
  // Story MOTIR-7883 · MOTIR-7889: the plan page no longer decides anything.
  it('UNDECIDED: the chip opens the same overlay as the row', () => {
    renderWithIntl(<SessionRow view={sessionView(FACTS, { id: 'p_31', status: 'planned' })} />);
    const chip = screen.getByRole('link', {
      name: `Open the plan — ${en.aiPlanning.sessions.planState.planned}`,
    });
    const title = screen.getAllByRole('link')[0]!;
    expect(chip.getAttribute('href')).toBe(title.getAttribute('href'));
    expect(new URL(chip.getAttribute('href')!, 'http://x').searchParams.get('planSession')).toBe(
      's_1',
    );
  });

  it('DECIDED: the chip is a plain label — no link, no second tab stop', () => {
    renderWithIntl(<SessionRow view={sessionView(FACTS, { id: 'p_31', status: 'approved' })} />);
    expect(
      screen.queryByRole('link', {
        name: `Open the plan — ${en.aiPlanning.sessions.planState.approved}`,
      }),
    ).toBeNull();
    // The state is still SAID — only the door is gone.
    expect(screen.getByText(en.aiPlanning.sessions.planState.approved)).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
