// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReview, planReviewItem } from '../helpers/planReview';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { WorkItemRefMap, WorkItemRefSummaryDto } from '@/lib/dto/workItems';

// Bug MOTIR-9697 — a plan's SUMMARY (the briefing) drew every work-item link
// struck through as "This work item no longer exists". Nothing resolved the
// `motir:` ids in `plan.summary`: the review rail rendered it with no map at all,
// and the overlay's briefing bubble with the chat session's map, which is built
// from the turns only. The review now carries `summaryRefs`, and both surfaces
// render the summary's chips from it.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));

import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';

afterEach(cleanup);

const LIVE: WorkItemRefSummaryDto = {
  accessible: true,
  id: 'wi_live',
  identifier: 'MOTIR-673',
  title: 'Hosted agent',
  kind: 'epic',
  archived: false,
  status: { key: 'in_progress', label: 'In Progress', category: 'in_progress' },
  type: null,
  assignee: null,
};
const HIDDEN: WorkItemRefSummaryDto = { accessible: false, id: 'wi_hidden' };

const SUMMARY = [
  '## 1. What was asked and the problem found',
  'Builds on [MOTIR-673](motir:wi_live), not on [MOTIR-1](motir:wi_gone).',
  '',
  '## 2. What the plan does',
  'Touches [MOTIR-42](motir:wi_hidden).',
].join('\n');

const SUMMARY_REFS: WorkItemRefMap = { wi_live: LIVE, wi_hidden: HIDDEN };

function reviewWith(summaryRefs?: WorkItemRefMap): PlanReviewDto {
  return planReview([planReviewItem({ planItemId: 'pi_a', title: 'Add a thing' })], {
    status: 'planned',
    summary: SUMMARY,
    ...(summaryRefs ? { summaryRefs } : {}),
  });
}

function chipFor(root: HTMLElement, key: string): Element {
  const chip = Array.from(root.querySelectorAll('.wi-chip')).find((el) =>
    el.querySelector('.wi-key')?.textContent?.includes(key),
  );
  expect(chip, `a chip for ${key}`).toBeTruthy();
  return chip!;
}

function expectChips(root: HTMLElement) {
  const live = chipFor(root, 'MOTIR-673');
  expect(live.classList.contains('is-deleted')).toBe(false);
  expect(live.textContent).toContain('Hosted agent');
  // A link to a card that is really gone still draws struck through.
  expect(chipFor(root, 'MOTIR-1').classList.contains('is-deleted')).toBe(true);
  // A card the reader cannot view is the no-access chip, with no title.
  const hidden = chipFor(root, 'MOTIR-42');
  expect(hidden.classList.contains('is-noaccess')).toBe(true);
  expect(hidden.classList.contains('is-deleted')).toBe(false);
}

describe('the plan review rail’s summary (MOTIR-9697)', () => {
  it('draws a summary link to a live card as a live chip, from the review’s summaryRefs', () => {
    const { container } = renderWithIntl(
      <PlanReviewRail
        review={reviewWith(SUMMARY_REFS)}
        onApprove={() => {}}
        onDecline={() => {}}
        busy={false}
        errorCode={null}
      />,
    );
    expectChips(container);
  });
});

function railState(review: PlanReviewDto, sessionRefs: WorkItemRefMap | null) {
  return {
    phase: 'review',
    session: sessionRefs ? { workItemRefs: sessionRefs } : null,
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
  } as unknown as PlanChangeConversationState;
}

function renderOverlay(review: PlanReviewDto, sessionRefs: WorkItemRefMap | null = null) {
  return renderWithIntl(
    <PlanChangeRail
      launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
      projectName="PayFlow"
      state={railState(review, sessionRefs)}
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
  );
}

describe('the planning overlay’s briefing bubble (MOTIR-9697)', () => {
  it('draws the summary’s live chip although no chat turn mentions the card', () => {
    renderOverlay(reviewWith(SUMMARY_REFS));
    expectChips(screen.getByTestId('plan-change-briefing'));
  });

  it('lays the summary’s refs over the session’s turn map', () => {
    // The session resolved a DIFFERENT id from a turn; the summary's own refs
    // still win for the ids the summary links.
    const other: WorkItemRefSummaryDto = { ...LIVE, id: 'wi_other', identifier: 'MOTIR-5' };
    renderOverlay(reviewWith(SUMMARY_REFS), { wi_other: other });
    expectChips(screen.getByTestId('plan-change-briefing'));
  });
});
