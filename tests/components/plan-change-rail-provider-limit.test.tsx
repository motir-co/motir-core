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

// THE PLAN OVERLAY WHEN THE MODEL PROVIDER IS AT ITS LIMIT (Story MOTIR-9540 · MOTIR-9622),
// drawn to `design/ai-chat/planning-workspace--provider-limit.mock.html`: the retrying banner
// while a provider-429 retry waits, and the `rate_limited` failure worded as the provider limit
// INSIDE each of the three shipped failed faces — never a second panel, never a second Resume.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const tw = en.planningWorkspace.waiting;
const tl = en.planningWorkspace.providerLimit;
const zl = zh.planningWorkspace.providerLimit;

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
  reason: 'rate_limited',
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

function rail(
  state: Partial<PlanChangeConversationState>,
  providerLimit: 'retrying' | null = null,
) {
  const merged = { ...BASE, ...state };
  return (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="Acme"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      providerLimit={providerLimit}
      {...handlers}
    />
  );
}

function renderRail(
  state: Partial<PlanChangeConversationState>,
  providerLimit: 'retrying' | null = null,
  locale: 'en' | 'zh' = 'en',
) {
  return renderWithIntl(rail(state, providerLimit), {
    locale,
    messages: locale === 'zh' ? zh : en,
  });
}

const planAgainSession = (over: Partial<PlanSessionFailureDto> = {}) =>
  session({
    failure: { ...FAILURE, resumable: false, ...over },
    failedWaiting: 'reply',
    waitingPlan: null,
  });

const walkAlone = (over: Partial<PlanSessionFailureDto> = {}) =>
  session({
    failure: {
      ...FAILURE,
      resumable: true,
      stopPhase: 'author',
      stopTitle: 'Export a report',
      ...over,
    },
    failedWaiting: 'resume',
    waitingPlan: null,
  });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the provider-limit retrying banner (panels 2–5)', () => {
  it('a wait with no failure draws the banner: a polite status, the design’s words, nothing to press', () => {
    renderRail({ phase: 'streaming' }, 'retrying');
    const banner = screen.getByTestId('provider-limit-retrying');
    expect(banner.getAttribute('role')).toBe('status');
    expect(screen.getByRole('status', { name: tl.retryingTitle })).toBe(banner);
    expect(banner.textContent).toBe(`${tl.retryingTitle}${tl.retryingBody}`);
    expect(within(banner).queryByRole('button')).toBeNull();
    expect(banner.textContent).not.toMatch(/\d/);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('sits between the head and the log, outside the log’s scroll', () => {
    renderRail({ phase: 'streaming' }, 'retrying');
    const banner = screen.getByTestId('provider-limit-retrying');
    const log = screen.getByRole('log');
    expect(log.contains(banner)).toBe(false);
    expect(banner.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('clears when the wait is gone, with no success line left behind', () => {
    const { rerender } = renderRail({ phase: 'streaming' }, 'retrying');
    expect(screen.getByTestId('provider-limit-retrying')).toBeTruthy();
    rerender(rail({ phase: 'streaming' }, null));
    expect(screen.queryByTestId('provider-limit-retrying')).toBeNull();
    expect(screen.queryByRole('status', { name: tl.retryingTitle })).toBeNull();
  });

  it('uses the info tone and no danger ink', () => {
    renderRail({ phase: 'streaming' }, 'retrying');
    const html = screen.getByTestId('provider-limit-retrying').outerHTML;
    expect(html).toMatch(/--el-notice-info-bg/);
    expect(html).not.toMatch(/danger|destructive/);
  });

  it('a failure wins: no banner beside a failed face, even if a wait is passed', () => {
    renderRail({ session: walkAlone() }, 'retrying');
    expect(screen.queryByTestId('provider-limit-retrying')).toBeNull();
    expect(screen.getByTestId('planning-failed-waiting')).toBeTruthy();
  });

  it('an ENDED session draws no banner', () => {
    renderRail({ session: session({ endedAt: '2026-07-27T12:00:00.000Z' }) }, 'retrying');
    expect(screen.queryByTestId('provider-limit-retrying')).toBeNull();
  });

  it('reads in Chinese', () => {
    renderRail({ phase: 'streaming' }, 'retrying', 'zh');
    const banner = screen.getByTestId('provider-limit-retrying');
    expect(banner.textContent).toBe(`${zl.retryingTitle}${zl.retryingBody}`);
    expect(banner.textContent).not.toMatch(/[A-Za-z]/);
  });
});

describe('the provider-limit stopped wording — the failed walk (panels 6, 7, 8b)', () => {
  it('words the stop and the kept sentence as the provider limit, with ONE Resume and the held composer', () => {
    renderRail({ session: walkAlone() });
    const block = screen.getByTestId('planning-failed-waiting');
    expect(within(block).getByTestId('provider-limit-because').textContent).toBe(tl.walkBecause);
    expect(within(block).getByTestId('provider-limit-kept').textContent).toBe(tl.walkKept);
    expect(block.textContent).not.toMatch(/rate-limited/);
    expect(within(block).queryByText(tw.kept)).toBeNull();
    expect(screen.getAllByTestId('planning-resume')).toHaveLength(1);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    expect(block.outerHTML).not.toMatch(/danger|destructive/);
  });

  it('failed again keeps the face’s Second attempt pill beside the provider-limit words', () => {
    const { rerender } = renderRail({ session: walkAlone() });
    rerender(rail({ session: walkAlone({ failedAt: '2026-07-27T12:00:00.000Z' }) }));
    const block = screen.getByTestId('planning-failed-waiting');
    expect(block.getAttribute('data-state')).toBe('failed-again');
    expect(within(block).getByText(en.workbench.planningSession.second)).toBeTruthy();
    expect(within(block).getByTestId('provider-limit-because')).toBeTruthy();
    expect(screen.getAllByTestId('planning-resume')).toHaveLength(1);
  });

  it('while Resume is pending the shipped resuming face is drawn, without the provider-limit words', () => {
    renderRail({ session: walkAlone(), resuming: true });
    const block = screen.getByTestId('planning-failed-waiting');
    expect(block.getAttribute('data-state')).toBe('resuming');
    expect(within(block).queryByTestId('provider-limit-because')).toBeNull();
    expect(within(block).queryByTestId('provider-limit-kept')).toBeNull();
    expect((within(block).getByTestId('planning-resume') as HTMLButtonElement).disabled).toBe(true);
  });

  it('pressing Resume calls the one resume handler', () => {
    renderRail({ session: walkAlone() });
    fireEvent.click(screen.getByTestId('planning-resume'));
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
  });

  it('once the session is no longer failed, the stopped wording is gone', () => {
    const { rerender } = renderRail({ session: walkAlone() });
    rerender(rail({ session: session(), phase: 'streaming' }));
    expect(screen.queryByTestId('planning-failed-waiting')).toBeNull();
    expect(screen.queryByTestId('provider-limit-because')).toBeNull();
  });

  it('reads in Chinese with no English left in the provider-limit words', () => {
    renderRail({ session: walkAlone() }, null, 'zh');
    const block = screen.getByTestId('planning-failed-waiting');
    expect(within(block).getByTestId('provider-limit-because').textContent).toBe(zl.walkBecause);
    expect(within(block).getByTestId('provider-limit-kept').textContent).toBe(zl.walkKept);
  });
});

describe('the provider-limit stopped wording — the line faces (panels 9, 10)', () => {
  const when = /\S+/;
  it('the failure line beside a waiting plan says the provider was at its limit; no Resume, open composer', () => {
    renderRail({ session: reply() });
    const line = screen.getByTestId('planning-failure-line');
    expect(line.getAttribute('data-provider-limit')).toBe('true');
    expect(line.textContent).toMatch(
      /^Your last change to this plan could not be made: the model provider is at its limit · .+\. Send it again when you are ready\.$/,
    );
    expect(screen.queryByTestId('planning-resume')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
    expect(line.textContent).toMatch(when);
  });

  it('a newer failure reads the again form', () => {
    const { rerender } = renderRail({ session: reply() });
    rerender(rail({ session: reply({ failedAt: '2026-07-27T12:00:00.000Z' }) }));
    expect(screen.getByTestId('planning-failure-line').textContent).toMatch(
      /^Your last change could not be made again: the model provider is at its limit · /,
    );
  });

  it('the plan-again line, and its again form', () => {
    const { rerender } = renderRail({ session: planAgainSession() });
    expect(screen.getByTestId('planning-failure-line').textContent).toMatch(
      /^This attempt could not be continued: the model provider is at its limit · .+\. Your next message plans it again\.$/,
    );
    rerender(rail({ session: planAgainSession({ failedAt: '2026-07-27T12:00:00.000Z' }) }));
    expect(screen.getByTestId('planning-failure-line').textContent).toMatch(
      /^This attempt could not be continued again: the model provider is at its limit · /,
    );
    expect(screen.queryByTestId('planning-resume')).toBeNull();
  });

  it('the line faces read in Chinese', () => {
    renderRail({ session: planAgainSession() }, null, 'zh');
    expect(screen.getByTestId('planning-failure-line').textContent).toMatch(
      /^这次尝试无法继续：模型服务已达到使用上限 · /,
    );
  });
});

describe('a non-rate failure draws the shipped face, with no provider-limit element (panel 11)', () => {
  it.each(['internal', 'job_failed', 'out_of_credits'] as const)('%s', (reason) => {
    const { unmount } = renderRail({ session: walkAlone({ reason }) }, 'retrying');
    expect(screen.queryByTestId('provider-limit-retrying')).toBeNull();
    expect(screen.queryByTestId('provider-limit-because')).toBeNull();
    expect(screen.getByText(tw.kept)).toBeTruthy();
    unmount();
    renderRail({ session: reply({ reason }) });
    const line = screen.getByTestId('planning-failure-line');
    expect(line.getAttribute('data-provider-limit')).toBeNull();
    expect(line.textContent).not.toMatch(/provider/);
  });
});
