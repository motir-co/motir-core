// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-40',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type {
  PlanAnswerOfferDto,
  PlanChangeSessionDto,
  PlanChangeTurnDto,
} from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// No jest-dom (project convention): assertions read the DOM directly.
// THE PLAN OFFER ON A DECIDED CONVERSATION (Story MOTIR-11515 · MOTIR-11521), drawn to
// MOTIR-11527's `design/ai-chat/plan-offer--after-decision.mock.html`: each kept too-far
// request offered below the end marker, one at a time, with the decided copy. The rail is
// presentational, so each state is asserted by handing it the thread core served.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const en = enMessages.planningWorkspace.planOffer;
const ad = en.afterDecision;

function turn(
  seq: number,
  role: PlanChangeTurnDto['role'] = 'user',
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body: role === 'user' ? 'How does export work?' : 'Export runs nightly.',
    jobId: role === 'assistant' ? 'job-1' : null,
    question: null,
    confirm: null,
    isAnswer: role === 'assistant',
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...extra,
  };
}

function offer(extra: Partial<PlanAnswerOfferDto> = {}): PlanAnswerOfferDto {
  return {
    kind: 'plan',
    requestMd: 'Add a CSV export to the reports page.',
    targetKey: 'ACME-40',
    declinedAt: null,
    declinedById: null,
    confirmedAt: null,
    confirmedById: null,
    confirmedSessionId: null,
    state: 'undecided',
    cannotStart: null,
    ...extra,
  };
}

function session(
  turns: PlanChangeTurnDto[],
  extra: Partial<PlanChangeSessionDto> = {},
): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-40'],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-22T10:00:00.000Z',
    origin: 'conversation',
    startedByViewer: true,
    createdAt: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    turns,
    workItemRefs: {},
    ...extra,
  };
}

/** A thread whose latest turn is the answer carrying `o`. */
function offered(o: PlanAnswerOfferDto | null, extra: Partial<PlanChangeSessionDto> = {}) {
  return session([turn(0), turn(1, 'assistant', { offer: o })], extra);
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: offered(offer()),
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: null,
  readOnly: false,
  acts: [],
};

const onConfirmPlanOffer = vi.fn();
const onDeclinePlanOffer = vi.fn();

function rail(
  state: Partial<PlanChangeConversationState> = {},
  opts: {
    withActions?: boolean;
    answering?: string | null;
    refusal?: { turnId: string; code: string } | null;
  } = {},
) {
  const merged = { ...BASE, ...state };
  return (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onStop={vi.fn()}
      {...(opts.withActions === false ? {} : { onConfirmPlanOffer, onDeclinePlanOffer })}
      offerAnsweringTurnId={opts.answering ?? null}
      offerRefusal={opts.refusal ?? null}
    />
  );
}

function renderRail(...args: Parameters<typeof rail>) {
  return renderWithIntl(rail(...args));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const AT = '2026-10-22T11:00:00.000Z';

/** A kept request's offer, as the decision wrote it. */
function keptOffer(position: number, total: number, extra: Partial<PlanAnswerOfferDto> = {}) {
  return offer({
    requestMd: `Kept request ${position}.`,
    targetKey: null,
    afterDecision: { position, total },
    ...extra,
  });
}

/** A conversation the decision ended, with `offers` written after it. */
function decided(
  offers: PlanAnswerOfferDto[],
  endReason: 'approved' | 'declined' = 'approved',
  extra: Partial<PlanChangeSessionDto> = {},
) {
  return session(
    [
      turn(0),
      turn(1, 'assistant'),
      ...offers.map((o, i) =>
        turn(2 + i, 'assistant', { offer: o, body: 'stored english body', jobId: null }),
      ),
    ],
    { endedAt: AT, endReason, endedBy: { id: 'u1', name: 'Dana' }, ...extra },
  );
}

const rows = () => document.body.querySelectorAll('[data-testid]');
const order = () =>
  [...rows()]
    .map((el) => el.getAttribute('data-testid'))
    .filter((id) => id === 'planning-session-end' || id === 'plan-offer');

describe('after Approve or Decline', () => {
  it.each(['approved', 'declined'] as const)(
    'after %s the end marker sits ABOVE the live offer turn, which keeps Confirm and Decline',
    (reason) => {
      renderRail({ session: decided([keptOffer(1, 3)], reason) });
      expect(order()).toEqual(['planning-session-end', 'plan-offer']);
      expect(screen.getAllByTestId('planning-session-end')).toHaveLength(1);
      expect(screen.getByTestId('planning-session-end').getAttribute('data-end-reason')).toBe(
        reason,
      );
      expect(screen.getByTestId('plan-offer-confirm')).toBeTruthy();
      expect(screen.getByTestId('plan-offer-decline')).toBeTruthy();
      expect(screen.getByTestId('plan-offer-no-target')).toBeTruthy();
      const panel = screen.getByTestId('plan-offer');
      expect(panel.textContent).toContain(`${ad.confirmHelp} ${ad.declineHelp}`);
      expect(panel.textContent).not.toContain(en.confirmHelpNoTarget);
    },
  );

  it('draws the catalogue lead line, never the stored body, and the 1-of-3 cue', () => {
    renderRail({ session: decided([keptOffer(1, 3)]) });
    expect(screen.getByTestId('plan-offer-after-decision-lead').textContent).toBe(ad.lead);
    expect(screen.queryByText('stored english body')).toBeNull();
    expect(screen.getByTestId('plan-offer-after-decision-cue').textContent).toBe(
      ad.cue.replace('{position}', '1').replace('{total}', '3'),
    );
  });

  it('the last of several says so, and a single kept request draws no cue', () => {
    renderRail({
      session: decided([keptOffer(1, 2, { state: 'declined', declinedAt: AT }), keptOffer(2, 2)]),
    });
    expect(screen.getByTestId('plan-offer-after-decision-cue').textContent).toBe(
      ad.cueLast.replace('{position}', '2').replace('{total}', '2'),
    );
    cleanup();
    renderRail({ session: decided([keptOffer(1, 1)]) });
    expect(screen.queryByTestId('plan-offer-after-decision-cue')).toBeNull();
  });

  it('fires Confirm and Decline with the offer turn id', () => {
    renderRail({ session: decided([keptOffer(1, 2)]) });
    fireEvent.click(screen.getByTestId('plan-offer-confirm'));
    expect(onConfirmPlanOffer).toHaveBeenCalledWith('t2');
    fireEvent.click(screen.getByTestId('plan-offer-decline'));
    expect(onDeclinePlanOffer).toHaveBeenCalledWith('t2');
  });

  it('a confirmed offer links the new conversation instead of saying it runs here', () => {
    renderRail({
      session: decided([
        keptOffer(1, 2, {
          state: 'confirmed',
          confirmedAt: AT,
          confirmedSessionId: 's-new',
        }),
        keptOffer(2, 2),
      ]),
    });
    const [first] = screen.getAllByTestId('plan-offer');
    const line = within(first!).getByTestId('plan-offer-started-elsewhere');
    expect(line.textContent).toBe('Planning runs in a new conversation. Open it');
    expect(line.querySelector('a')?.getAttribute('href')).toContain('s-new');
    expect(within(first!).queryByText(en.startedHere)).toBeNull();
    // Only the live (second) offer draws a cue, and settled offers draw none.
    expect(screen.getAllByTestId('plan-offer-after-decision-cue')).toHaveLength(1);
    expect(screen.getAllByTestId('plan-offer-confirm')).toHaveLength(1);
  });

  it('a cannot-start offer keeps its panel and Decline, with the lock line in Confirm’s place', () => {
    renderRail({ session: decided([keptOffer(1, 3, { cannotStart: 'planning_unavailable' })]) });
    const panel = screen.getByTestId('plan-offer');
    expect(within(panel).getByTestId('plan-offer-cannot-start').textContent).toContain(
      en.cannotStart.planningUnavailable,
    );
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('plan-offer-decline'));
    expect(onDeclinePlanOffer).toHaveBeenCalledWith('t2');
    expect(panel.textContent).toContain(ad.cannotStartHelp);
    expect(screen.getByTestId('plan-offer-after-decision-cue')).toBeTruthy();
  });

  it('a held target on a cannot-start offer draws the being-planned line, Decline kept', () => {
    renderRail({ session: decided([keptOffer(1, 1, { cannotStart: 'target_held' })]) });
    expect(screen.getByTestId('plan-offer-cannot-start').textContent).toContain(
      en.beingPlanned.replace('{key}', ''),
    );
    expect(screen.getByTestId('plan-offer-decline')).toBeTruthy();
  });

  it('another member sees the turns and cue but no controls', () => {
    renderRail({ session: decided([keptOffer(1, 3)]), readOnly: true });
    expect(screen.getByTestId('plan-offer')).toBeTruthy();
    expect(screen.getByTestId('plan-offer-after-decision-cue')).toBeTruthy();
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
    expect(screen.queryByTestId('plan-offer-decline')).toBeNull();
  });

  it('a shipped offer on a decided conversation stays a record, and the marker stays last', () => {
    renderRail({ session: decided([offer({ targetKey: null })]) });
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
    expect(order()).toEqual(['plan-offer', 'planning-session-end']);
  });

  it('every other ended conversation keeps the marker as its last row', () => {
    renderRail({ session: decided([keptOffer(1, 1)], 'approved', { endReason: 'idle' }) });
    expect(order()).toEqual(['plan-offer', 'planning-session-end']);
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
  });

  it('draws Chinese at locale zh', () => {
    renderWithIntl(rail({ session: decided([keptOffer(1, 2)]) }), {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByTestId('plan-offer-after-decision-lead').textContent).toBe(
      zhMessages.planningWorkspace.planOffer.afterDecision.lead,
    );
  });
});
