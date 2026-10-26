// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanNarrationReadDto } from '@/lib/dto/plans';
import en from '@/messages/en.json';
import { narrationEntry, narrationRead, narrationSession } from '../helpers/planNarration';

// THE PLANNER'S NARRATION ON THE PLAN PAGE (Story MOTIR-8060 · MOTIR-8064).
// `/plans/[id]` and a Visitor's `/p/<key>/plans/<id>` host `PlanReviewRail`, not
// the overlay's `PlanChangeRail`, so the narration has to be drawn here from the
// review the page polls — the same groups, heads and collapse-all, live and
// finished. The finer drawing rules are `plan-narration.test.tsx`'s.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const NS = 'planningWorkspace.conversation';
type T = (key: string, values?: Record<string, string | number>) => string;
const t = createTranslator({ locale: 'en', messages: en, namespace: NS }) as unknown as T;

const A = narrationSession('s-a', 'author', 'Move token refresh into SessionStore');
const B = narrationSession('s-b', 'author', 'Expire idle sessions server-side');

function review(
  narration: PlanNarrationReadDto | undefined,
  over: Partial<PlanReviewDto> = {},
): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned',
    title: 'Session hardening',
    summary: null,
    itemCount: 2,
    createdAt: '2026-10-09T00:00:00.000Z',
    plannedAt: '2026-10-09T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
    revision: null,
    ...(narration ? { narration } : {}),
    ...over,
  };
}

function renderRail(r: PlanReviewDto) {
  return renderWithIntl(
    <PlanReviewRail
      review={r}
      onApprove={() => {}}
      onDecline={() => {}}
      busy={false}
      errorCode={null}
    />,
  );
}

const groups = () => screen.getAllByTestId('plan-narration-group');

describe('the plan page draws the planner narration (MOTIR-8064)', () => {
  it('groups each sentence under its own session head, finished on a planned plan', () => {
    renderRail(
      review(
        narrationRead(
          [A, B],
          [
            narrationEntry(1, 's-a', 'Reading the session store.'),
            narrationEntry(2, 's-b', 'Looking at idle timeouts.'),
            narrationEntry(3, 's-a', 'Writing the refresh card.'),
          ],
        ),
      ),
    );
    const [ga, gb] = groups();
    expect(ga!.getAttribute('data-session')).toBe('finished');
    expect(within(ga!).getByTestId('plan-narration-head-title').textContent).toBe(A.targetTitle);
    expect(within(ga!).getByTestId('plan-narration-done').textContent).toBe(t('narration.done'));
    expect(
      within(ga!)
        .getAllByTestId('plan-narration-message')
        .map((m) => m.textContent),
    ).toEqual(['Reading the session store.', 'Writing the refresh card.']);
    expect(
      within(gb!)
        .getAllByTestId('plan-narration-message')
        .map((m) => m.textContent),
    ).toEqual(['Looking at idle timeouts.']);
    expect(screen.getByTestId('plan-narration-toggle-all').textContent).toContain(
      t('narration.hideAll', { count: 3 }),
    );
  });

  it('shows a session live while the plan generates and it holds a step', () => {
    renderRail(
      review(narrationRead([A], [narrationEntry(1, 's-a', 'Reading the session store.')]), {
        status: 'generating',
        plannedAt: null,
        inFlightSteps: [
          {
            sessionKey: 's-a',
            kind: 'author',
            targetRef: 'ref-s-a',
            startedAt: '2026-10-09T10:00:00.000Z',
            providerWait: null,
          },
        ],
      }),
    );
    const [ga] = groups();
    expect(ga!.getAttribute('data-session')).toBe('live');
    expect(within(ga!).queryByTestId('plan-narration-done')).toBeNull();
  });

  it('folds every group from the collapse-all control', () => {
    renderRail(review(narrationRead([A], [narrationEntry(1, 's-a', 'One.')])));
    const toggle = screen.getByTestId('plan-narration-toggle-all');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('plan-narration-messages').hidden).toBe(true);
  });

  it('draws nothing when the read carries no narration', () => {
    renderRail(review(undefined));
    expect(screen.queryByTestId('plan-narration')).toBeNull();
  });

  it('loads the earlier page through the paged read and keeps it above the window', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ entries: [narrationEntry(1, 's-a', 'The first one.')], earlierCount: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderRail(review(narrationRead([A], [narrationEntry(2, 's-a', 'The second one.')])));
    const earlier = screen.getByTestId('plan-narration-earlier');
    expect(earlier.textContent).toContain(t('narration.earlier', { count: 1 }));
    await act(async () => {
      fireEvent.click(earlier);
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/plans/plan_1/narration?beforeSeq=2');
    expect(screen.getAllByTestId('plan-narration-message').map((m) => m.textContent)).toEqual([
      'The first one.',
      'The second one.',
    ]);
    expect(screen.queryByTestId('plan-narration-earlier')).toBeNull();
  });

  it('leaves the affordance in place when the earlier page fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    renderRail(review(narrationRead([A], [narrationEntry(2, 's-a', 'The second one.')])));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-narration-earlier'));
    });
    expect(screen.getByTestId('plan-narration-earlier')).toBeTruthy();
    expect(screen.getAllByTestId('plan-narration-message')).toHaveLength(1);
  });
});
