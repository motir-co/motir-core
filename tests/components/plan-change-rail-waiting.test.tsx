// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

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
import { RESUME_REASON_CODES } from '../../app/(authed)/workbench/_components/planningSessionWords';

// A SESSION THAT WAITS, in the rail (Story MOTIR-7905 · MOTIR-7918), drawn to
// `design/ai-chat/planning-workspace--waiting-on-you.mock.html`: a failed hosted attempt read as
// WAITING TO RESUME (not Closed) with Resume in place of Try again, and the planner's pending
// question focused on open. The rail is presentational: each case hands it the server's row.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const t = en.workbench.planningSession;
const tw = en.planningWorkspace.waiting;

function turn(
  seq: number,
  body: string,
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  return {
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
    ...extra,
  };
}

function session(turns: PlanChangeTurnDto[], extra: Partial<PlanChangeSessionDto> = {}) {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-14'],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    turns,
    workItemRefs: {},
    ...extra,
  } as PlanChangeSessionDto;
}

const FAILURE: PlanSessionFailureDto = {
  failedAt: '2026-07-27T11:00:00.000Z',
  reason: 'internal',
  stopPhase: 'author',
  stopRef: 'ACME-20',
  stopTitle: 'Export a report',
};

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: session([]),
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

const onResume = vi.fn();
const onRetry = vi.fn();
const handlers = {
  onSend: vi.fn(),
  onCorrectTurn: vi.fn(),
  onApprove: vi.fn(),
  onDiscard: vi.fn(),
  onAddTarget: vi.fn(),
  onRemoveTarget: vi.fn(),
};

function renderRail(
  state: Partial<PlanChangeConversationState> = {},
  props: { canResume?: boolean; locale?: 'en' | 'zh' } = {},
) {
  const merged = { ...BASE, ...state };
  const locale = props.locale ?? 'en';
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="Acme"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      {...handlers}
      onRetry={onRetry}
      onResume={onResume}
      {...(props.canResume === undefined ? {} : { canResume: props.canResume })}
    />,
    { locale, messages: locale === 'zh' ? zh : en },
  );
}

const waitingSession = (failure = FAILURE) =>
  session([turn(0, 'Add an export for the report page.')], { failure });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a failed hosted attempt reads as WAITING TO RESUME, not Closed', () => {
  it('draws the stop in words, the reason, when — and Resume, with no Retry and no end marker', () => {
    renderRail({ session: waitingSession(), errorCode: 'FAILED' });
    const block = screen.getByTestId('planning-failed-waiting');
    expect(within(block).getByText(tw.failedHead)).toBeTruthy();
    expect(within(block).getByText(t.waitingToResume)).toBeTruthy();
    expect(within(block).getByText('Writing Export a report')).toBeTruthy();
    expect(within(block).getByText('because something went wrong on our side')).toBeTruthy();
    expect(within(block).getByText(tw.kept)).toBeTruthy();
    expect(within(block).getByTestId('planning-resume').textContent).toBe('Resume');
    // …and none of the Closed face, nor the generic retryable error.
    expect(screen.queryByTestId('planning-session-end')).toBeNull();
    expect(screen.queryByTestId('planning-failed-closed')).toBeNull();
    expect(screen.queryByText('Start a new session')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  // `rate_limited` is worded as the provider limit instead (MOTIR-9622), pinned in
  // `plan-change-rail-provider-limit.test.tsx`.
  it.each(RESUME_REASON_CODES.filter((code) => code !== 'rate_limited'))(
    'the %s reason reads in its own words',
    (code) => {
      renderRail({ session: waitingSession({ ...FAILURE, reason: code }) });
      expect(screen.getByText(`because ${t.reason[code]}`)).toBeTruthy();
    },
  );

  it('an unknown reason code reads as the `internal` sentence, never the raw code', () => {
    renderRail({
      session: waitingSession({ ...FAILURE, reason: 'quantum_flux' as unknown as 'internal' }),
    });
    expect(screen.getByText(`because ${t.reason.internal}`)).toBeTruthy();
    expect(screen.queryByText(/quantum_flux/)).toBeNull();
  });

  it('Resume calls onResume, and reads *Resuming…* disabled while in flight', () => {
    const { rerender } = renderRail({ session: waitingSession() });
    fireEvent.click(screen.getByTestId('planning-resume'));
    expect(onResume).toHaveBeenCalledTimes(1);
    cleanup();
    renderRail({ session: waitingSession(), resuming: true });
    const button = screen.getByTestId('planning-resume') as HTMLButtonElement;
    expect(button.textContent).toBe(t.resuming);
    expect(button.disabled).toBe(true);
    expect(rerender).toBeTruthy();
  });

  it('the composer is held (no ordinary turn while a half-written walk waits)', () => {
    renderRail({ session: waitingSession() });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('a refusal says *could not start* in that code’s words and keeps the failure line + Resume', () => {
    renderRail({ session: waitingSession(), resumeError: 'NOT_SESSION_OWNER' });
    const block = screen.getByTestId('planning-failed-waiting');
    expect(within(block).getByRole('alert').textContent).toContain(t.refusal.notOwner);
    expect(within(block).getByTestId('planning-resume')).toBeTruthy();
  });

  it('a session that ended meanwhile drops Resume and says so', () => {
    renderRail({ session: waitingSession(), resumeError: 'PLAN_SESSION_ENDED' });
    const block = screen.getByTestId('planning-failed-waiting');
    expect(within(block).getByRole('alert').textContent).toContain(t.refusal.ended);
    expect(within(block).queryByTestId('planning-resume')).toBeNull();
  });

  it('a second failure with a newer time carries the quiet *Second attempt* note', () => {
    const { rerender } = renderRail({ session: waitingSession() });
    expect(screen.queryByText(t.second)).toBeNull();
    const later = {
      ...FAILURE,
      failedAt: '2026-07-27T12:00:00.000Z',
      reason: 'model_unavailable' as const,
    };
    rerender(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="Acme"
        state={{ ...BASE, session: waitingSession(later) }}
        index={indexPlanReview(null)}
        targets={[]}
        {...handlers}
        onRetry={onRetry}
        onResume={onResume}
      />,
    );
    expect(screen.getByText(t.second)).toBeTruthy();
    expect(screen.getByText(`because ${t.reason.model_unavailable}`)).toBeTruthy();
  });

  it('a viewer who neither started it nor manages the project reads it read-only (panel 3c)', () => {
    renderRail(
      {
        session: waitingSession(),
        reopened: {
          startedBy: { id: 'u2', name: 'Dana Whitfield' },
          mine: false,
          lastActivityAt: FAILURE.failedAt,
        },
      },
      { canResume: false },
    );
    expect(screen.queryByTestId('planning-resume')).toBeNull();
    expect(screen.getByTestId('planning-resume-not-yours').textContent).toBe(
      'Only Dana Whitfield or a project manager can resume this.',
    );
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a failure on an ENDED session stays the Closed face (legacy), not this one', () => {
    renderRail({
      session: session([turn(0, 'x')], {
        endedAt: '2026-07-27T11:00:00.000Z',
        endReason: 'failed',
        failure: FAILURE,
        startedByViewer: true,
      }),
      errorCode: 'FAILED',
    });
    expect(screen.queryByTestId('planning-failed-waiting')).toBeNull();
    expect(screen.getByTestId('planning-failed-closed')).toBeTruthy();
  });
});

describe('opened on the planner’s pending question', () => {
  const asked = session([
    turn(0, 'Add an export for the report page.'),
    turn(1, 'One question first.', {
      role: 'assistant',
      question: 'Should the export include archived cards?',
      jobId: 'job-1',
      authorId: null,
    }),
  ]);

  it('scrolls the question into view and focuses the composer — once', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderRail({ session: asked });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  it('a session with no pending question changes neither', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderRail({ session: session([turn(0, 'Add an export.')]) });
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  });
});

describe('zh', () => {
  it('draws the failure block in Chinese with no English leaking in', () => {
    renderRail({ session: waitingSession() }, { locale: 'zh' });
    const block = screen.getByTestId('planning-failed-waiting');
    expect(within(block).getByText(zh.planningWorkspace.waiting.failedHead)).toBeTruthy();
    expect(within(block).getByText('正在撰写「Export a report」')).toBeTruthy();
    expect(within(block).getByTestId('planning-resume').textContent).toBe('继续');
    expect(block.textContent).not.toMatch(/Resume|Writing|because|stopped/);
  });
});

describe('the waiting parts on their own (branches the rail’s sheets do not reach)', () => {
  it('a stop with no title reads the top-level phrase, and a viewer with no named starter gets the anonymous sentence', async () => {
    const { FailedWaitingNotice, AlsoWaitingPlan } =
      await import('@/components/planning/SessionWaitingParts');
    renderWithIntl(
      <FailedWaitingNotice
        failure={{ ...FAILURE, stopPhase: 'lay', stopTitle: null }}
        failedAgain={false}
        resuming={false}
        resumeError={null}
        canResume={false}
        starterName={null}
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByText("Laying the project's top level")).toBeTruthy();
    expect(screen.getByTestId('planning-resume-not-yours').textContent).toBe(tw.onlyStarterAnon);
    cleanup();
    // …and the waiting-plan link: nothing without one, an ellipsis for an untitled one.
    const base = { id: 's1', targetKeys: [] } as never;
    const none = renderWithIntl(
      <AlsoWaitingPlan session={{ ...(base as object), waitingPlan: null } as never} />,
    );
    expect(none.container.textContent).toBe('');
    cleanup();
    renderWithIntl(
      <AlsoWaitingPlan
        session={
          {
            ...(base as object),
            waitingPlan: { planId: 'p', title: null, status: 'stale' },
          } as never
        }
      />,
    );
    expect(screen.getByRole('link').textContent).toBe('…');
  });
});
