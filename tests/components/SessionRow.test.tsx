// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush }));
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans',
  useSearchParams: () => new URLSearchParams('planState=none'),
}));

import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SessionRow } from '@/app/(authed)/plans/_components/SessionRow';
import type { SessionRowView } from '@/app/(authed)/plans/_components/types';
import { planRowDestination } from '@/lib/planning/planDestination';

// MOTIR-6025 — one Plans-list row, ONE CONVERSATION (design Part XIX §19.2–§19.3a).

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  shallowPush.mockReset();
  push.mockReset();
  vi.unstubAllGlobals();
});

function view(over: Partial<SessionRowView> = {}): SessionRowView {
  const latestPlan: SessionRowView['latestPlan'] =
    'latestPlan' in over ? (over.latestPlan ?? null) : { id: 'p_31', status: 'planned' };
  return {
    id: 's_1',
    origin: 'conversation',
    title: 'Split invoicing out of billing',
    targetKeys: ['MOTIR-812'],
    activeLabel: '12 minutes ago',
    startedByName: 'Mara Lind',
    latestPlan,
    planCount: 2,
    seed: null,
    // An OPEN session reads its latest plan's state (AMENDMENT 23 §1).
    state: latestPlan?.status ?? 'none',
    failure: null,
    end: null,
    copiedFrom: null,
    ...over,
  };
}

const row = () => document.querySelector('.relative.flex')!;

describe('the two destinations (§19.2 change 2–3)', () => {
  it('the TITLE opens the conversation over this page, filter kept, by its id', () => {
    renderWithIntl(<SessionRow view={view()} />);

    const link = screen.getByRole('link', { name: 'Split invoicing out of billing' });
    const href = new URL(link.getAttribute('href')!, 'http://x');
    expect(href.pathname).toBe('/plans');
    expect(href.searchParams.get('planState')).toBe('none');
    expect(href.searchParams.get('planSession')).toBe('s_1');
    expect(href.searchParams.get('planItem')).toBe('MOTIR-812');

    fireEvent.click(link);
    expect(shallowPush).toHaveBeenCalledWith(link.getAttribute('href'));
  });

  it('a project-wide conversation opens the project overlay', () => {
    renderWithIntl(<SessionRow view={view({ targetKeys: [] })} />);
    const href = new URL(screen.getAllByRole('link')[0]!.getAttribute('href')!, 'http://x');
    expect(href.searchParams.get('planFrom')).toBe('project');
    expect(href.searchParams.get('planSession')).toBe('s_1');
    expect(href.searchParams.get('planItem')).toBeNull();
  });

  // Story MOTIR-7883 · MOTIR-7889: the chip opens the PLAN in the overlay — the
  // title's own address — and the row already holds every fact, so no read.
  it('the CHIP is a separate link to the plan in the overlay, named for its state', () => {
    renderWithIntl(<SessionRow view={view()} />);
    const title = screen.getByRole('link', { name: 'Split invoicing out of billing' });
    const chip = screen.getByRole('link', { name: 'Open the plan — Waiting for approval' });
    expect(chip.getAttribute('href')).toBe(title.getAttribute('href'));
    expect(chip.className).toContain('z-10');

    expect(fireEvent.click(chip, { button: 0 })).toBe(false);
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(title.getAttribute('href'));
    expect(push).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('`No plan yet` is a plain chip — no plan link, no fresh-start control (§19.3a)', () => {
    renderWithIntl(<SessionRow view={view({ latestPlan: null, planCount: 0 })} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText('No plan yet')).toBeTruthy();
    expect(screen.queryByText(/Plan with AI/)).toBeNull();
  });
});

describe('the chip map is TOTAL (§19.3)', () => {
  // ⚠️ AMENDED by Story MOTIR-6043 · MOTIR-6045 (design Part XXI §21.5), and the
  // amendment is deliberately NARROW: what this block is FOR is that every plan
  // status gets its own chip LABEL, and that is asserted unchanged below. What
  // moved is whether the chip is also a LINK — it is now, and only, where the
  // row's own door goes somewhere else. So the two decided statuses assert the
  // label and the ABSENCE of the door, and the detector that used to live in
  // this `getByRole('link')` is preserved inverted, here and in
  // `plan-row-destination-agreement.test.tsx`'s own chip-rule block.
  it.each([
    ['generating', 'Writing', true],
    ['planned', 'Waiting for approval', true],
    // Bug MOTIR-9006 — being approved reads as such, never Waiting for approval, and
    // its chip still opens the overlay, where the progress is drawn.
    ['approving', 'Approving…', true],
    ['stale', 'Stale', true],
    ['approved', 'Approved', false],
    ['declined', 'Declined', false],
  ] as const)('%s → %s (chip is a door: %s)', (status, label, isDoor) => {
    renderWithIntl(<SessionRow view={view({ latestPlan: { id: 'p', status } })} />);
    expect(screen.getByText(label)).toBeTruthy();
    const door = screen.queryByRole('link', { name: `Open the plan — ${label}` });
    if (isDoor) expect(door).toBeTruthy();
    else expect(door).toBeNull();
  });

  it('only `Waiting for approval` carries the accent border', () => {
    renderWithIntl(<SessionRow view={view({ latestPlan: { id: 'p', status: 'approved' } })} />);
    expect(row().className).toContain('border-(--el-border)');
    cleanup();
    renderWithIntl(<SessionRow view={view()} />);
    expect(row().className).toContain('border-(--el-accent)');
  });

  it('`+N earlier plans` precedes the chip only when there was more than one', () => {
    renderWithIntl(<SessionRow view={view({ planCount: 3 })} />);
    expect(screen.getByText('+2 earlier plans')).toBeTruthy();
    cleanup();
    renderWithIntl(<SessionRow view={view({ planCount: 1 })} />);
    expect(screen.queryByText(/earlier plan/)).toBeNull();
  });
});

describe('the meta line', () => {
  it('names the anchor, the last activity and the starter', () => {
    renderWithIntl(<SessionRow view={view()} />);
    expect(screen.getByText('MOTIR-812')).toBeTruthy();
    expect(screen.getByText('active 12 minutes ago')).toBeTruthy();
    expect(screen.getByTitle('Mara Lind').textContent).toBe('Mara Lind');
  });

  it('collapses many anchors to `first +N`, the full set in its title', () => {
    renderWithIntl(<SessionRow view={view({ targetKeys: ['A-1', 'A-2', 'A-3'] })} />);
    expect(screen.getByTitle('A-1, A-2, A-3').textContent).toBe('A-1 +2');
  });

  it('reads `Whole project` with no anchor', () => {
    renderWithIntl(<SessionRow view={view({ targetKeys: [] })} />);
    expect(screen.getByText('Whole project')).toBeTruthy();
  });

  it('names the ORIGIN for every door but a conversation', () => {
    renderWithIntl(<SessionRow view={view({ origin: 'mcp' })} />);
    expect(screen.getByText('Agent plan')).toBeTruthy();
    cleanup();
    renderWithIntl(<SessionRow view={view()} />);
    expect(screen.queryByText('Agent plan')).toBeNull();
  });

  it('a cadence session has no starter and reads its label alone', () => {
    renderWithIntl(<SessionRow view={view({ origin: 'cadence', startedByName: null })} />);
    const meta = screen.getByText('Auto-planned').parentElement!;
    expect(within(meta).queryByText('·')).toBeNull();
  });

  it('a conversation whose starter left renders no starter entry at all', () => {
    renderWithIntl(<SessionRow view={view({ startedByName: null })} />);
    expect(document.querySelector('b')).toBeNull();
  });

  it('an untitled session still has a name to click', () => {
    renderWithIntl(<SessionRow view={view({ title: '' })} />);
    expect(screen.getByRole('link', { name: 'Untitled conversation' })).toBeTruthy();
  });

  it.each(['generation', 'expand', 'legacy'] as const)('origin %s is labelled', (origin) => {
    renderWithIntl(<SessionRow view={view({ origin })} />);
    const label = { generation: 'Generated plan', expand: 'Expanded plan', legacy: 'Earlier plan' };
    expect(screen.getByText(label[origin])).toBeTruthy();
  });
});

describe('the SEED link — Re-plan of {KEY} · {verb} (MOTIR-6209, design MOTIR-6206)', () => {
  it.each([
    ['decision_approval', 'Request changes'],
    ['decision_confirmation', 'Overturn'],
    ['decision_choice', 'None of these'],
  ] as const)('%s reads `Re-plan of ACME-44 · %s` and opens the work item', (gateKind, verb) => {
    renderWithIntl(
      <SessionRow
        view={view({
          seed: { cardKey: 'ACME-44', gateKind, origin: 'refusal', chosenLabel: null },
        })}
      />,
    );

    const link = screen.getByRole('link', {
      name: 'Open ACME-44, the work item this conversation re-plans',
    });
    expect(link.getAttribute('href')).toBe('/items/ACME-44');
    expect(link.textContent).toBe(`Re-plan of ACME-44·${verb}`);
    // The key in mono, like the anchor; the separator decorative.
    expect(within(link).getByText('ACME-44').className).toBe('font-mono');
    expect(within(link).getByText('·').getAttribute('aria-hidden')).toBe('true');
  });

  it('is raised above the stretched title link, so the two doors do not collide', () => {
    renderWithIntl(
      <SessionRow
        view={view({
          seed: {
            cardKey: 'ACME-44',
            gateKind: 'decision_approval',
            origin: 'refusal',
            chosenLabel: null,
          },
        })}
      />,
    );
    const link = screen.getByTestId('plan-session-seed');
    expect(link.className).toContain('relative');
    expect(link.className).toContain('z-10');
    // The meta line's LAST item.
    expect(link.parentElement!.lastElementChild).toBe(link);
    // Pressing it is the browser's navigation, never the conversation opener.
    fireEvent.click(link);
    expect(shallowPush).not.toHaveBeenCalled();
    // The title still opens the conversation.
    expect(
      screen.getByRole('link', { name: 'Split invoicing out of billing' }).getAttribute('href'),
    ).toContain('planSession=s_1');
  });

  it('zh reads `ACME-44 的重新规划 · 推翻`', () => {
    renderWithIntl(
      <SessionRow
        view={view({
          seed: {
            cardKey: 'ACME-44',
            gateKind: 'decision_confirmation',
            origin: 'refusal',
            chosenLabel: null,
          },
        })}
      />,
      { locale: 'zh', messages: zhMessages },
    );
    const link = screen.getByRole('link', { name: '打开 ACME-44，即此对话重新规划的工作项' });
    expect(link.textContent).toBe('ACME-44 的重新规划·推翻');
  });

  it('a PICK reads `Follow-up to ACME-42 · chose {label}`, opens the CHOICE, and never says re-plan (MOTIR-6434)', () => {
    renderWithIntl(
      <SessionRow
        view={view({
          seed: {
            cardKey: 'ACME-42',
            gateKind: 'decision_choice',
            origin: 'pick',
            chosenLabel: 'Managed object storage',
          },
        })}
      />,
    );
    const link = screen.getByRole('link', {
      name: 'Open ACME-42, the choice this conversation is the follow-up to (chose Managed object storage)',
    });
    expect(link.getAttribute('href')).toBe('/items/ACME-42');
    expect(link.textContent).toBe('Follow-up to ACME-42·chose Managed object storage');
    expect(link.textContent).not.toMatch(/re-plan|none of these/i);
    expect(within(link).getByText('ACME-42').className).toBe('font-mono');
    expect(within(link).getByText('chose Managed object storage').className).toContain('truncate');
  });

  const guideSeed = {
    cardKey: 'ACME-31',
    gateKind: null,
    origin: 'guide',
    chosenLabel: null,
  } as const;

  it('a GUIDE seed reads `From the guide on ACME-31`, opens the GUIDED card, and names no gate verb (MOTIR-8697)', () => {
    renderWithIntl(<SessionRow view={view({ seed: guideSeed })} />);
    const link = screen.getByRole('link', {
      name: 'Open ACME-31, the work item Motir AI was guiding you through when it offered this re-plan',
    });
    expect(link.getAttribute('href')).toBe('/items/ACME-31');
    expect(link.getAttribute('data-seed-origin')).toBe('guide');
    expect(link.textContent).toBe('From the guide on ACME-31');
    expect(link.textContent).not.toMatch(
      /re-plan|follow-up|·|request changes|overturn|none of these/i,
    );
    expect(within(link).getByText('ACME-31').className).toBe('font-mono');
    // The label truncates as the pick row's does; the accessible name is whole.
    expect(link.firstElementChild!.className).toContain('truncate');
    // Raised above the stretched title link, the meta line's last item.
    expect(link.className).toContain('z-10');
    expect(link.parentElement!.lastElementChild).toBe(link);
    fireEvent.click(link);
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('zh reads `来自对 ACME-31 的引导`', () => {
    renderWithIntl(<SessionRow view={view({ seed: guideSeed })} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    const link = screen.getByRole('link', {
      name: '打开 ACME-31，即 Motir AI 提出此重新规划时正在引导你完成的工作项',
    });
    expect(link.getAttribute('href')).toBe('/items/ACME-31');
    expect(link.textContent).toBe('来自对 ACME-31 的引导');
  });

  it('a row with no seed draws nothing extra — the same meta line and links as before', () => {
    renderWithIntl(<SessionRow view={view()} />);
    expect(screen.queryByTestId('plan-session-seed')).toBeNull();
    expect(screen.queryByText(/Re-plan of/)).toBeNull();
    // Title + chip, exactly the two doors the shipped row has.
    expect(screen.getAllByRole('link')).toHaveLength(2);
    // Anchor, activity, starter and the destination tag — nothing after it.
    const meta = screen.getByText('active 12 minutes ago').parentElement!;
    expect(meta.children).toHaveLength(4);
    expect(meta.lastElementChild!.getAttribute('data-testid')).toBe('plan-destination');
  });
});

// MOTIR-7642 — Closed on the Plans page, built to MOTIR-7634's
// `plans-tabbed-list--closed.mock.html` (AMENDMENT 23 §1).
describe('an ENDED session (MOTIR-7642)', () => {
  const end = (over: Partial<NonNullable<SessionRowView['end']>> = {}) => ({
    reason: 'failed' as const,
    timeLabel: '18:34',
    fullLabel: 'Oct 5, 2026, 18:34',
    endedByName: null,
    endedByViewer: false,
    ...over,
  });
  const closed = (over: Partial<SessionRowView> = {}) =>
    view({
      latestPlan: { id: 'p_31', status: 'declined' },
      state: 'closed',
      end: end(),
      ...over,
    });

  it('a Closed row wears the peach Closed chip — a plain Pill, never a door', () => {
    renderWithIntl(<SessionRow view={closed()} />);
    const chip = screen.getByText('Closed');
    expect(chip.closest('[class*="tint-peach"]')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open the plan/ })).toBeNull();
    expect(screen.queryByText('Declined')).toBeNull();
  });

  it('a Closed row opens its CONVERSATION, not the abandoned plan’s page', () => {
    renderWithIntl(<SessionRow view={closed()} />);
    const link = screen.getByRole('link', { name: 'Split invoicing out of billing' });
    const href = new URL(link.getAttribute('href')!, 'http://x');
    expect(href.pathname).toBe('/plans');
    expect(href.searchParams.get('planSession')).toBe('s_1');
    expect(document.querySelector('[data-destination]')?.getAttribute('data-destination')).toBe(
      'planning-surface',
    );
  });

  // Story MOTIR-7883 · MOTIR-7889: an ended session whose latest plan is still
  // UNDECIDED is not closed — that plan is decided in the overlay, row and chip.
  it.each(['planned', 'stale', 'generating'] as const)(
    'a Closed row whose latest plan is %s opens THAT PLAN in the overlay, chip too',
    (status) => {
      renderWithIntl(
        <SessionRow
          view={closed({ latestPlan: { id: 'p_31', status }, end: end({ reason: 'restarted' }) })}
        />,
      );
      const title = screen.getByRole('link', { name: 'Split invoicing out of billing' });
      const expected = planRowDestination({
        planStatus: status,
        planId: 'p_31',
        sessionId: 's_1',
        host: '/plans?planState=none',
        anchorKey: 'MOTIR-812',
      });
      expect(expected.kind).toBe('planning-surface');
      expect(title.getAttribute('href')).toBe(expected.href);
      expect(document.querySelector('[data-destination]')?.getAttribute('data-destination')).toBe(
        'planning-surface',
      );
      const chip = screen.getByRole('link', { name: /Open the plan/ });
      expect(chip.getAttribute('href')).toBe(expected.href);

      fireEvent.click(title, { button: 0 });
      fireEvent.click(chip, { button: 0 });
      expect(shallowPush.mock.calls).toEqual([[expected.href], [expected.href]]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['declined', { id: 'p_31', status: 'declined' }],
    ['approved', { id: 'p_31', status: 'approved' }],
    ['no plan', null],
  ] as const)('a Closed row with %s keeps the conversation read and a plain chip', (_, plan) => {
    renderWithIntl(<SessionRow view={closed({ latestPlan: plan })} />);
    const href = new URL(
      screen.getByRole('link', { name: 'Split invoicing out of billing' }).getAttribute('href')!,
      'http://x',
    );
    expect(href.pathname).toBe('/plans');
    expect(href.searchParams.get('planSession')).toBe('s_1');
    expect(screen.queryByRole('link', { name: /Open the plan/ })).toBeNull();
  });

  it.each([
    [{ reason: 'failed' }, 'Closed · the attempt failed · 18:34'],
    [{ reason: 'idle' }, 'Closed · idle · 18:34'],
    [{ reason: 'restarted', endedByViewer: true }, 'Closed · you started something new · 18:34'],
    [{ reason: 'restarted', endedByName: 'Ada' }, 'Closed · Ada started something new · 18:34'],
  ] as const)('the end line reads %o → %s, replacing `active`', (over, text) => {
    renderWithIntl(<SessionRow view={closed({ end: end(over) })} />);
    const line = screen.getByTestId('plan-session-end');
    expect(line.textContent).toBe(text);
    expect(line.getAttribute('title')).toBe('Oct 5, 2026, 18:34');
    expect(screen.queryByText(/^active /)).toBeNull();
  });

  it.each([
    ['declined', { endedByName: 'Ada' }, 'Declined by Ada · 18:34'],
    ['declined', { endedByViewer: true }, 'Declined by you · 18:34'],
    ['declined', {}, 'Declined · 18:34'],
    ['approved', { endedByName: 'Ada' }, 'Approved by Ada · 18:34'],
    ['approved', { endedByViewer: true }, 'Approved by you · 18:34'],
  ] as const)(
    'a person’s %s keeps its chip and the shipped plan-page door, with its end line',
    (reason, over, text) => {
      renderWithIntl(
        <SessionRow
          view={view({
            latestPlan: { id: 'p_31', status: reason },
            state: reason,
            end: end({ reason, ...over }),
          })}
        />,
      );
      expect(screen.getByTestId('plan-session-end').textContent).toBe(text);
      expect(
        screen.getByRole('link', { name: 'Split invoicing out of billing' }).getAttribute('href'),
      ).toBe('/plans/p_31');
    },
  );

  it('an OPEN row keeps `active {when}` and has no end line', () => {
    renderWithIntl(<SessionRow view={view()} />);
    expect(screen.getByText('active 12 minutes ago')).toBeTruthy();
    expect(screen.queryByTestId('plan-session-end')).toBeNull();
  });

  it('a COPY links to the conversation it continues, above the title link', () => {
    renderWithIntl(<SessionRow view={view({ copiedFrom: { id: 's_0', whenLabel: '18:34' } })} />);
    const link = screen.getByRole('link', {
      name: 'Open the conversation this one continues, closed 18:34',
    });
    expect(link.textContent).toBe('Continued from the 18:34 conversation');
    expect(link.className).toContain('z-10');
    const href = new URL(link.getAttribute('href')!, 'http://x');
    expect(href.searchParams.get('planSession')).toBe('s_0');
    fireEvent.click(link);
    expect(shallowPush).toHaveBeenCalledWith(link.getAttribute('href'));
  });

  it('ships in zh', () => {
    renderWithIntl(
      <SessionRow view={closed({ copiedFrom: { id: 's_0', whenLabel: '18:34' } })} />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByText('已关闭')).toBeTruthy();
    expect(screen.getByTestId('plan-session-end').textContent).toBe('已关闭 · 尝试失败 · 18:34');
    expect(screen.getByText('接续 18:34 的对话')).toBeTruthy();
  });
});

// ── A SESSION WHOSE ATTEMPT FAILED (Story MOTIR-7905 · MOTIR-7921 / MOTIR-7944) ────────────────
// Drawn to `plans-tabbed-list--waiting-to-resume.mock.html` and `…--situation-2.mock.html`.

describe('Waiting to resume (MOTIR-7921)', () => {
  const walk = (over: Partial<SessionRowView> = {}) =>
    view({
      state: 'waiting',
      latestPlan: { id: 'p_9', status: 'generating' },
      failure: {
        kind: 'walk',
        reason: 'rate_limited',
        stopPhase: 'author',
        stopTitle: 'Export a report',
        timeLabel: '5 minutes ago',
        fullLabel: 'Oct 10, 2026, 8:00 AM',
      },
      ...over,
    });

  it('reads the awaiting chip, the stop line in the To resume words — and not “active {when}”', () => {
    renderWithIntl(<SessionRow view={walk()} />);
    expect(screen.getByText('Waiting to resume').className).toContain('tint-yellow');
    expect(screen.getByTestId('plans-stop-line').textContent).toBe(
      'Stopped at Writing Export a report · because the model was rate-limited · 5 minutes ago',
    );
    expect(screen.getByTestId('plans-stop-line').getAttribute('title')).toBe(
      'Oct 10, 2026, 8:00 AM',
    );
    expect(screen.queryByText(/^active /)).toBeNull();
  });

  it('the chip is a PLAIN pill — one control, one tab stop; the row’s own door opens the overlay', () => {
    renderWithIntl(<SessionRow view={walk()} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    const door = screen.getByRole('link', { name: 'Split invoicing out of billing' });
    expect(fireEvent.click(door)).toBe(false);
    const url = new URL(shallowPush.mock.calls[0]![0] as string, 'http://x');
    expect(url.searchParams.get('planSession')).toBe('s_1');
  });

  it('a waiting row with NO plan yet reads the same, naming where it stopped', () => {
    renderWithIntl(
      <SessionRow
        view={walk({
          latestPlan: null,
          planCount: 0,
          title: '',
          targetKeys: [],
          failure: {
            kind: 'walk',
            reason: 'model_unavailable',
            stopPhase: 'lay',
            stopTitle: null,
            timeLabel: '5 minutes ago',
            fullLabel: '',
          },
        })}
      />,
    );
    expect(screen.getByText('Waiting to resume')).toBeTruthy();
    expect(screen.getByTestId('plans-stop-line').textContent).toBe(
      "Stopped at Laying the project's top level · because the AI provider was unavailable · 5 minutes ago",
    );
  });

  it('renders in zh with no English', () => {
    renderWithIntl(
      <SessionRow
        view={walk({
          failure: {
            kind: 'walk',
            reason: 'rate_limited',
            stopPhase: 'author',
            stopTitle: 'Export a report',
            timeLabel: '5 分钟前',
            fullLabel: '',
          },
        })}
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByText('待继续')).toBeTruthy();
    expect(screen.getByTestId('plans-stop-line').textContent).toBe(
      '停在正在撰写「Export a report」 · 原因：请求过于频繁 · 5 分钟前',
    );
  });
});

describe('a failure beside a waiting plan (MOTIR-7944)', () => {
  const beside = (status: 'planned' | 'stale') =>
    view({
      state: status,
      latestPlan: { id: 'p_9', status },
      failure: {
        kind: 'change',
        reason: 'internal',
        stopPhase: null,
        stopTitle: null,
        timeLabel: '5 minutes ago',
        fullLabel: '',
      },
    });

  it('reads the PLAN’s state — never Closed, not Waiting to resume — and the change line', () => {
    renderWithIntl(<SessionRow view={beside('planned')} />);
    expect(screen.getByTestId('plans-stop-line').textContent).toBe(
      'Your last change could not be made · 5 minutes ago',
    );
    expect(screen.queryByText('Closed')).toBeNull();
    expect(screen.queryByText('Waiting to resume')).toBeNull();
    // An undecided plan keeps its chip door (MOTIR-7889).
    expect(screen.getByRole('link', { name: 'Open the plan — Waiting for approval' })).toBeTruthy();
  });

  it('a stale plan reads Stale with the same line', () => {
    renderWithIntl(<SessionRow view={beside('stale')} />);
    expect(screen.getByText('Stale')).toBeTruthy();
    expect(screen.getByTestId('plans-stop-line')).toBeTruthy();
  });
});
