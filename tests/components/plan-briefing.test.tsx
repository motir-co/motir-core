// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { PlanBriefing, splitBriefing } from '@/components/planning/PlanBriefing';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { planReview, planReviewItem } from '../helpers/planReview';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// THE BRIEFING IN THE OVERLAY (MOTIR-8172). `review.summary` is the planner's
// six-section Markdown briefing (MOTIR-8149). The rail must draw it as Markdown in
// place of the canned "N added" / "can't change done work" pair, keep sections 3–5
// folded so the gate stays reachable, and fall back to the canned pair when a plan
// has no summary. The plan detail page renders the same text as Markdown too.

afterEach(cleanup);

const BRIEFING = [
  '## 1. What was asked and the problem found',
  'The **premise** is wrong.',
  '',
  '## 2. What the plan does',
  'Adds ten cards.',
  '',
  '## 3. What was left untouched',
  'Finished cards stay as they are.',
  '',
  '## 4. Decisions taken',
  'Chose the narrow shape.',
  '',
  '## 5. Gaps still open',
  'None remain.',
  '',
  '## 6. Counts',
  '10 added.',
].join('\n');

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const CANNED_SUMMARY = /added — it’s on the canvas|added — it's on the canvas/;
const CANNED_LOCKED = /I can't change done work|I can’t change done work/;

function reviewWith(summary: string | null): PlanReviewDto {
  return planReview([planReviewItem({ planItemId: 'pi_a', title: 'Add a thing' })], {
    status: 'planned',
    summary,
  });
}

function railState(review: PlanReviewDto): PlanChangeConversationState {
  return {
    phase: 'review',
    session: null,
    progress: null,
    review,
    liveReview: null,
    liveVersion: 0,
    liveFailing: false,
    discardedReview: null,
    decided: null,
    jobId: null,
    planId: 'plan-1',
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
}

function renderRail(
  summary: string | null,
  opts: { locale?: string; messages?: Record<string, unknown> } = {},
) {
  const review = reviewWith(summary);
  return renderWithIntl(
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={railState(review)}
      index={indexPlanReview(review)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      gateView={{ kind: 'decide' }}
      approveProgress={null}
    />,
    opts,
  );
}

describe('splitBriefing', () => {
  it('splits on numbered headings and ignores ones inside a code fence', () => {
    const parts = splitBriefing('## 1. A\nx\n```\n## 3. not a heading\n```\n## 2. B\ny');
    expect(parts.map((p) => p.number)).toEqual([1, 2]);
    expect(parts[0]!.body).toContain('## 3. not a heading');
  });

  it('keeps prose with no numbered headings as one block', () => {
    const parts = splitBriefing('Just a paragraph.\n\n## Unnumbered');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.number).toBeNull();
  });
});

describe('PlanBriefing', () => {
  it('opens sections 1, 2 and 6 and folds 3–5 behind their headings', () => {
    renderWithIntl(<PlanBriefing summary={BRIEFING} />);
    for (const n of [1, 2, 6]) {
      expect(screen.getByTestId(`plan-briefing-section-${n}`).tagName).toBe('SECTION');
    }
    for (const n of [3, 4, 5]) {
      const el = screen.getByTestId(`plan-briefing-section-${n}`) as HTMLDetailsElement;
      expect(el.tagName).toBe('DETAILS');
      expect(el.open).toBe(false);
    }
    expect(screen.getByText('3. What was left untouched').tagName).toBe('SUMMARY');
  });
});

describe('the overlay rail', () => {
  it('draws a pending review’s summary as Markdown, with no canned pair', () => {
    renderRail(BRIEFING);
    const briefing = screen.getByTestId('plan-change-briefing');
    expect(briefing.querySelector('strong')?.textContent).toBe('premise');
    expect(briefing.textContent).not.toContain('**premise**');
    expect(screen.queryByText(CANNED_SUMMARY)).toBeNull();
    expect(screen.queryByText(CANNED_LOCKED)).toBeNull();
    // The gate stays below the briefing.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('starts sections 3–5 collapsed', () => {
    renderRail(BRIEFING);
    const open = Array.from(
      screen.getByTestId('plan-change-briefing').querySelectorAll('details'),
    ).map((d) => d.open);
    expect(open).toEqual([false, false, false]);
  });

  it.each([null, '   '])('falls back to the canned pair for summary %j', (summary) => {
    renderRail(summary);
    expect(screen.queryByTestId('plan-change-briefing')).toBeNull();
    expect(screen.getByText(CANNED_SUMMARY)).toBeTruthy();
    expect(screen.getByText(CANNED_LOCKED)).toBeTruthy();
  });

  it('renders in zh: the canned fallback is translated, the briefing text is not', () => {
    const fallback = renderRail(null, { locale: 'zh', messages: zhMessages });
    expect(screen.getByText(zhMessages.planningWorkspace.conversation.lockedNote)).toBeTruthy();
    fallback.unmount();

    renderRail(BRIEFING, { locale: 'zh', messages: zhMessages });
    expect(screen.getByTestId('plan-change-briefing').textContent).toContain(
      'The premise is wrong.',
    );
    expect(screen.queryByText(zhMessages.planningWorkspace.conversation.lockedNote)).toBeNull();
  });
});

describe('a plan.py briefing written since MOTIR-9978', () => {
  // plan.py keeps its target record in `plannerRecord` now; the summary carries
  // one readable line per target and no `motir-targets` JSON fence.
  const SUMMARY = `${BRIEFING}\n\n## Targets the planner settled\n\n- MOTIR-9793 (lay): planned in plan-1`;

  it('shows one readable line per target, and no JSON code block', () => {
    renderRail(SUMMARY);
    const briefing = screen.getByTestId('plan-change-briefing');
    expect(briefing.textContent).toContain('MOTIR-9793 (lay): planned in plan-1');
    expect(briefing.querySelector('pre')).toBeNull();
    expect(briefing.querySelector('code')).toBeNull();
    for (const key of ['"slice"', '"conflict"', 'motir-targets']) {
      expect(briefing.textContent).not.toContain(key);
    }
  });
});

describe('the plan detail rail', () => {
  it.each([
    ['en', enMessages],
    ['zh', zhMessages],
  ])('renders the summary as Markdown, not raw text (%s)', (locale, messages) => {
    const { container } = renderWithIntl(
      <PlanReviewRail
        review={reviewWith(BRIEFING)}
        onApprove={() => {}}
        onDecline={() => {}}
        busy={false}
        errorCode={null}
      />,
      { locale, messages },
    );
    expect(container.querySelector('h2')?.textContent).not.toBeUndefined();
    expect(container.querySelector('strong')?.textContent).toBe('premise');
    expect(container.textContent).not.toContain('**premise**');
  });
});
