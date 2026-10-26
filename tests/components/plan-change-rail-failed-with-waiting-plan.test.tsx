// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));
vi.mock('@/lib/hooks/useOpenPlanOverlay', () => ({
  useOpenPlanOverlay: (planId: string) => ({ href: `/plan-overlay/${planId}`, open: vi.fn() }),
}));

import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type {
  PlanChangeSessionDto,
  PlanChangeTurnDto,
  PlanSessionFailureDto,
} from '@/lib/dto/planChange';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// THE OVERLAY ON AN OPEN FAILED SESSION WHOSE PLAN WAITS — situation 2 (Story MOTIR-7905 ·
// MOTIR-7941), drawn to `design/ai-chat/planning-workspace--failed-with-waiting-plan.mock.html`:
// ONE current failure line, an OPEN composer, and NO Resume / Try again / Start a new session /
// Closed marker (the session is open and the next turn continues it) — against the failed walk
// BESIDE a waiting plan, which keeps Resume and the held composer and names the waiting plan.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const tw = en.planningWorkspace.waiting;

const turn = (seq: number, body: string): PlanChangeTurnDto => ({
  id: `t${seq}`,
  seq,
  role: 'user',
  body,
  jobId: null,
  question: null,
  isAnswer: false,
  intent: null,
  intentCorrected: false,
  citations: [],
  authorId: 'u1',
  createdAt: '2026-07-27T10:00:00.000Z',
});

const FAILURE: PlanSessionFailureDto = {
  failedAt: '2026-07-27T11:00:00.000Z',
  reason: 'internal',
  stopPhase: null,
  stopRef: null,
  stopTitle: null,
};

function session(extra: Partial<PlanChangeSessionDto> = {}): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-14'],
    turnCount: 1,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns: [turn(0, 'Also include the archived cards.')],
    workItemRefs: {},
    ...extra,
  } as PlanChangeSessionDto;
}

const WAITING = { planId: 'plan-w', title: 'Import contacts', status: 'planned' as const };
const reply = (over: Partial<PlanSessionFailureDto> = {}) =>
  session({
    failure: { ...FAILURE, resumable: false, ...over },
    failedWaiting: 'reply',
    waitingPlan: WAITING,
  });
const walk = () =>
  session({
    failure: { ...FAILURE, resumable: true, stopPhase: 'author', stopTitle: 'Export a report' },
    failedWaiting: 'resume',
    waitingPlan: WAITING,
  });

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session(),
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

const handlers = {
  onSend: vi.fn(),
  onRetry: vi.fn(),
  onCorrectTurn: vi.fn(),
  onApprove: vi.fn(),
  onDiscard: vi.fn(),
  onAddTarget: vi.fn(),
  onRemoveTarget: vi.fn(),
  onResume: vi.fn(),
};

function renderRail(state: Partial<PlanChangeConversationState>, locale: 'en' | 'zh' = 'en') {
  const merged = { ...BASE, ...state };
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="Acme"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      {...handlers}
    />,
    { locale, messages: locale === 'zh' ? zh : en },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("situation 2 — an OPEN session failed beside a waiting plan ('reply')", () => {
  it('draws ONE current failure line and nothing of the walk’s or the ended session’s faces', () => {
    renderRail({ session: reply(), errorCode: 'FAILED' });
    const line = screen.getByTestId('planning-failure-line');
    expect(line.textContent).toMatch(/^Your last change to this plan could not be made · /);
    expect(screen.getAllByTestId('planning-failure-line')).toHaveLength(1);
    expect(screen.queryByTestId('planning-resume')).toBeNull();
    expect(screen.queryByTestId('planning-failed-waiting')).toBeNull();
    expect(screen.queryByTestId('planning-session-end')).toBeNull();
    expect(screen.queryByText('Start a new session')).toBeNull();
    // The generic error and its Try again are replaced by the line.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the composer ENABLED — the next turn is the way on', () => {
    renderRail({ session: reply() });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('a second failure with a newer time reads *could not be made again*, for the NEW failure only', () => {
    const { rerender } = renderRail({ session: reply() });
    expect(screen.getByTestId('planning-failure-line').getAttribute('data-again')).toBeNull();
    rerender(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="Acme"
        state={{ ...BASE, session: reply({ failedAt: '2026-07-27T12:00:00.000Z' }) }}
        index={indexPlanReview(null)}
        targets={[]}
        {...handlers}
      />,
    );
    const line = screen.getByTestId('planning-failure-line');
    expect(line.getAttribute('data-again')).toBe('true');
    expect(line.textContent).toMatch(/could not be made again/);
    expect(screen.getAllByTestId('planning-failure-line')).toHaveLength(1);
  });

  it('carries no danger ink — the warning role', () => {
    renderRail({ session: reply() });
    expect(screen.getByTestId('planning-failure-line').outerHTML).not.toMatch(/danger|destructive/);
  });
});

// MOTIR-9121 — motir-ai said the attempt cannot be resumed and nothing waits beside it: its
// cards were given back, so the same line says the next message plans again — no Resume, and
// an open composer.
const planAgain = (over: Partial<PlanSessionFailureDto> = {}) =>
  session({
    failure: { ...FAILURE, resumable: false, ...over },
    failedWaiting: 'reply',
    waitingPlan: null,
  });

describe('an attempt that cannot be resumed, with nothing waiting (MOTIR-9121)', () => {
  it('draws the plan-again line, no Resume, and an ENABLED composer', () => {
    renderRail({ session: planAgain(), errorCode: 'FAILED' });
    const line = screen.getByTestId('planning-failure-line');
    expect(line.textContent).toMatch(/^This attempt could not be continued · /);
    expect(line.textContent).toMatch(/Your next message plans it again\.$/);
    expect(screen.queryByTestId('planning-resume')).toBeNull();
    expect(screen.queryByTestId('planning-failed-waiting')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('a newer failure reads *again*', () => {
    const { rerender } = renderRail({ session: planAgain() });
    rerender(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="Acme"
        state={{ ...BASE, session: planAgain({ failedAt: '2026-07-27T12:00:00.000Z' }) }}
        index={indexPlanReview(null)}
        targets={[]}
        {...handlers}
      />,
    );
    expect(screen.getByTestId('planning-failure-line').textContent).toMatch(
      /^This attempt could not be continued again · /,
    );
  });

  it('renders in Chinese', () => {
    renderRail({ session: planAgain() }, 'zh');
    expect(screen.getByTestId('planning-failure-line').textContent).toMatch(/^这次尝试无法继续 · /);
  });
});

describe('the failed WALK beside a waiting plan (panel 6)', () => {
  it('keeps Resume and the held composer, and names the waiting plan through the one door', () => {
    renderRail({ session: walk() });
    expect(screen.getByTestId('planning-resume')).toBeTruthy();
    expect(screen.queryByTestId('planning-failure-line')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(tw.holdReason)).toBeTruthy();
    const also = screen.getByTestId('planning-also-waiting');
    expect(within(also).getByRole('link', { name: 'Import contacts' }).getAttribute('href')).toBe(
      '/plan-overlay/plan-w',
    );
  });

  it('a turn refused SESSION_AWAITING_RESUME says so in place, with no Try again', () => {
    renderRail({ session: walk(), errorCode: 'SESSION_AWAITING_RESUME' });
    expect(screen.getByRole('alert').textContent).toBe(
      en.planningWorkspace.conversation.error.awaitingResume,
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('the two refusals of a turn are said in place', () => {
  it('PLAN_REVISION_IN_FLIGHT reads its own sentence, keeps the failure line, offers no Try again', () => {
    renderRail({ session: reply(), errorCode: 'PLAN_REVISION_IN_FLIGHT' });
    expect(screen.getByRole('alert').textContent).toBe(
      en.planningWorkspace.conversation.error.revisionInFlight,
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByTestId('planning-failure-line')).toBeTruthy();
  });
});

describe('zh', () => {
  it('draws the failure line and the refusal in Chinese with no English leaking in', () => {
    renderRail({ session: reply(), errorCode: 'PLAN_REVISION_IN_FLIGHT' }, 'zh');
    expect(screen.getByTestId('planning-failure-line').textContent).toContain(
      '你上一次对这个计划的修改没能完成',
    );
    expect(screen.getByRole('alert').textContent).toBe(
      zh.planningWorkspace.conversation.error.revisionInFlight,
    );
    expect(screen.getByTestId('planning-failure-line').textContent).not.toMatch(/Your last change/);
  });

  it('fires nothing on its own', () => {
    renderRail({ session: reply() }, 'zh');
    expect(fireEvent).toBeTruthy();
    expect(handlers.onResume).not.toHaveBeenCalled();
  });
});
