// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanAnswerOfferDto, PlanChangeTurnDto } from '@/lib/dto/planChange';

// THE REQUIREMENT IN THE LEFT PANE (Story MOTIR-9430 · MOTIR-9437), drawn to
// `design/ai-chat/plan-offer--requirement.mock.html`. The host derives a layer from the
// thread alone (`requirementPaneOf`); the roadmap canvas is stubbed and stays mounted
// beneath it, which is the whole property Decline's "back to where you were" rests on.

const { push, refresh, reread } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  reread: vi.fn(),
}));
/** The host's `onClose` is REQUIRED since MOTIR-4732 — there is no `backHref`
 *  fallback left, because the reader never leaves the page. */
const noop = () => {};
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
// The Workbench behind the overlay is asked to re-read itself (MOTIR-8576).
vi.mock('@/lib/workbench/workbenchReread', () => ({ useRequestWorkbenchReread: () => reread }));

// The `@`-mention search is the ONE network-backed thing inside the real
// composer. Stubbed so the picker can be driven without a debounce and a
// endpoint — what is under test is that the HOST adds what the composer hands
// it, not what the search returns. Inert unless a test types an `@` query.
const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));

vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: (query: string, enabled: boolean) => ({
    results:
      enabled && query.trim().length >= 2
        ? [{ id: 'wi_9', identifier: 'MOTIR-9', title: 'Billing', kind: 'story' }]
        : [],
    loading: false,
    tooShort: query.trim().length < 2,
  }),
}));

// MOTIR-6186 — the surface now mounts the plan page's own List | Canvas for a
// proposed or decided plan, so this suite needs the review canvas stubbed for the
// same reason the change canvas is: it reads its own level over the network.
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: ({ outcome, ariaLabel }: { outcome?: string | null; ariaLabel?: string }) => (
    <div data-testid="review-canvas-stub" data-outcome={outcome ?? ''} aria-label={ariaLabel} />
  ),
}));

vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: ({
    projectKey,
    ariaLabel,
    diffKey,
    targetIds,
    initialTrail,
    followTo,
    loadingFallback,
    emptyRoot,
    onToggleTarget,
    canAddTarget,
  }: {
    projectKey: string;
    ariaLabel?: string;
    diffKey: string | number;
    targetIds?: readonly string[];
    initialTrail?: readonly { id: string; label: string }[];
    followTo?: { key: string; trail: readonly { id: string; label: string }[] } | null;
    loadingFallback?: ReactNode;
    emptyRoot?: ReactNode;
    onToggleTarget?: (
      target: { id: string; identifier: string; title: string; kind: string },
      isTarget: boolean,
    ) => void;
    canAddTarget?: boolean;
  }) => (
    <div
      data-testid="canvas-stub"
      data-project={projectKey}
      data-diff-key={String(diffKey)}
      data-targets={(targetIds ?? []).join(',')}
      data-trail={(initialTrail ?? []).map((c) => c.id).join(',')}
      // THE FOLLOW-MOVE's request (MOTIR-6161) — the host DERIVES it; the canvas
      // decides whether to honour it, and has its own suite for that.
      data-follow-key={followTo?.key ?? ''}
      data-follow-trail={(followTo?.trail ?? []).map((c) => c.id).join(',')}
      aria-label={ariaLabel}
    >
      {/* The two states the host DELEGATES to the canvas (MOTIR-2069). The real
          canvas picks between them off the level it reads itself; the stub
          renders both so the host's side of that contract is assertable. */}
      {/* The canvas's Set as target (MOTIR-6898): the real button lives in
          `ProjectRoadmapCanvas` and has its own suite; the stub hands the HOST
          the call the canvas would make for the card in `stubCard`. */}
      {onToggleTarget ? (
        <button
          type="button"
          data-testid="stub-toggle-target"
          data-can-add={String(canAddTarget)}
          onClick={() =>
            onToggleTarget(stubCard.current, (targetIds ?? []).includes(stubCard.current.id))
          }
        >
          toggle
        </button>
      ) : null}
      <div data-testid="canvas-loading-slot">{loadingFallback}</div>
      <div data-testid="canvas-empty-slot">{emptyRoot}</div>
    </div>
  ),
}));

// The card the canvas stub's toggle acts on — a hoisted box, so a test can move
// it between presses.
const { stubCard } = vi.hoisted(() => ({
  stubCard: {
    current: { id: 'wi_c1', identifier: 'MOTIR-51', title: 'Canvas card', kind: 'story' },
  },
}));

const { conversation } = vi.hoisted(() => ({
  conversation: {
    state: null as PlanChangeConversationState | null,
    send: vi.fn(),
    retry: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
    onApproved: null as ((r: unknown) => void) | null,
    anchorId: null as string | null,
    seedGateId: null as string | null,
    requestRestart: vi.fn(),
    answerRestartConfirm: vi.fn(),
    onRestarted: null as ((sessionId: string) => void) | null,
  },
}));

vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: ({
    onApproved,
    anchorId,
    seedGateId,
    onRestarted,
  }: {
    onApproved?: (r: unknown) => void;
    anchorId?: string | null;
    seedGateId?: string | null;
    onRestarted?: (sessionId: string) => void;
  } = {}) => {
    conversation.onApproved = onApproved ?? null;
    conversation.onRestarted = onRestarted ?? null;
    conversation.anchorId = anchorId ?? null;
    conversation.seedGateId = seedGateId ?? null;
    return conversation;
  },
}));

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';

const IDLE: PlanChangeConversationState = {
  phase: 'idle',
  session: {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '',
    updatedAt: '',
    turns: [],
    workItemRefs: {},
  },
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

afterEach(() => {
  cleanup();
  conversation.state = null;
});

const t = enMessages.planningWorkspace.requirementPane;

const REQUIREMENT = {
  outcome: 'People export the board as CSV.',
  behaviour: 'An Export button downloads every visible card.',
  scopeEdge: '',
  constraints: 'Reuses the download route.',
  acceptance: 'The file has the same row count.',
  assumptions: [
    { id: 'r1', text: 'Archived cards are left out.' },
    { id: 'r2', text: 'UTF-8 with a header row.' },
  ],
};

function offer(extra: Partial<PlanAnswerOfferDto> = {}): PlanAnswerOfferDto {
  return {
    kind: 'plan',
    requestMd: 'Export the board',
    targetKey: null,
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

function turn(
  seq: number,
  role: PlanChangeTurnDto['role'],
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body: role === 'user' ? 'Plan an export' : 'I can plan that.',
    jobId: role === 'assistant' ? 'job-1' : null,
    question: null,
    confirm: null,
    isAnswer: role === 'assistant',
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-24T10:00:00.000Z',
    ...extra,
  };
}

/** A thread: the person asks, Motir answers with `o`. */
function thread(o: PlanAnswerOfferDto | null, extra: Partial<PlanChangeTurnDto>[] = []) {
  const turns = [
    turn(0, 'user'),
    turn(1, 'assistant', { offer: o }),
    ...extra.map((e, i) => turn(2 + i, e.role ?? 'user', e)),
  ];
  return { ...IDLE, session: { ...IDLE.session!, turns, turnCount: turns.length } };
}

function element() {
  return (
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
      anchorId={null}
      onClose={noop}
      initialTarget={null}
      canManage={false}
    />
  );
}

function renderHost(state: PlanChangeConversationState, locale?: 'zh') {
  conversation.state = state;
  return locale
    ? renderWithIntl(element(), { locale, messages: zhMessages })
    : renderWithIntl(element());
}

const region = () => screen.queryByRole('region', { name: t.label });

describe('the requirement document', () => {
  it('fills the pane on first render with the title, six headings in order, assumption rows and the hint', () => {
    renderHost(thread(offer({ requirement: REQUIREMENT })));
    const pane = region()!;
    expect(pane).toBeTruthy();
    expect(within(pane).getByRole('heading', { level: 2 }).textContent).toBe('Export the board');
    expect(
      within(pane)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      t.headings.outcome,
      t.headings.behaviour,
      t.headings.scopeEdge,
      t.headings.constraints,
      t.headings.acceptance,
      t.headings.assumptions,
    ]);
    expect(pane.textContent).toContain('An Export button downloads every visible card.');
    expect(
      within(pane)
        .getAllByTestId('requirement-assumption')
        .map((r) => r.textContent),
    ).toEqual(['r1Archived cards are left out.', 'r2UTF-8 with a header row.']);
    expect(within(pane).getByTestId('requirement-correction-hint').textContent).toBe(
      t.correctionHint,
    );
  });

  it('is read-only: no textbox and no Confirm or Decline in the pane, while the rail still offers both', () => {
    renderHost(thread(offer({ requirement: REQUIREMENT })));
    const pane = region()!;
    expect(within(pane).queryByRole('textbox')).toBeNull();
    expect(within(pane).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('plan-offer-confirm')).toBeTruthy();
    expect(screen.getByTestId('plan-offer-decline')).toBeTruthy();
  });

  it('keeps all six headings and says none for an empty part and for no assumptions', () => {
    renderHost(thread(offer({ requirement: { ...REQUIREMENT, assumptions: [] } })));
    const pane = region()!;
    expect(within(pane).getAllByRole('heading', { level: 3 })).toHaveLength(6);
    const none = within(pane).getAllByTestId('requirement-none');
    expect(none).toHaveLength(2);
    expect(none.every((n) => n.textContent === t.none)).toBe(true);
  });

  it('scrolls as the whole pane, with the title pinned', () => {
    renderHost(thread(offer({ requirement: REQUIREMENT })));
    expect(region()!.className).toContain('overflow-y-auto');
    expect(within(region()!).getByRole('heading', { level: 2 }).className).toContain('sticky');
  });

  it('shows the notice, and no document, for an offer that carries no requirement', () => {
    renderHost(thread(offer()));
    const pane = region()!;
    expect(within(pane).getByTestId('requirement-notice').textContent).toBe(t.notice);
    expect(within(pane).queryByTestId('requirement-document')).toBeNull();
  });

  it('draws the six headings in Chinese for the zh locale', () => {
    renderHost(thread(offer({ requirement: REQUIREMENT })), 'zh');
    const pane = screen.getByRole('region', {
      name: zhMessages.planningWorkspace.requirementPane.label,
    });
    expect(
      within(pane)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['结果', '行为', '范围边界', '约束', '验收', '假设']);
  });
});

describe('the layer over the pane', () => {
  it('marks the pane beneath inert and hidden while the layer is up, and only then', () => {
    const { rerender } = renderHost(thread(offer({ requirement: REQUIREMENT })));
    const body = screen.getByTestId('canvas-stub');
    expect(body.hasAttribute('inert')).toBe(true);
    expect(body.getAttribute('aria-hidden')).toBe('true');
    conversation.state = thread(offer({ declinedAt: '2026-10-24T10:05:00.000Z' }));
    rerender(element());
    expect(region()).toBeNull();
    expect(screen.getByTestId('canvas-stub').hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('canvas-stub').getAttribute('aria-hidden')).toBeNull();
  });

  it('keeps the canvas mounted across the offer and Decline, with the level it was given', () => {
    const trail = [{ id: 'wi_1', label: 'Roadmap' }];
    conversation.state = thread(offer({ requirement: REQUIREMENT }));
    const { rerender } = renderWithIntl(
      <PlanningWorkspaceHost
        projectKey="ACME"
        projectName="Acme"
        launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
        anchorId={null}
        onClose={noop}
        initialTarget={null}
        initialCanvasTrail={trail}
        canManage={false}
      />,
    );
    const canvas = screen.getByTestId('canvas-stub');
    expect(canvas.getAttribute('data-trail')).toBe('wi_1');
    conversation.state = thread(offer({ declinedAt: '2026-10-24T10:05:00.000Z' }));
    rerender(
      <PlanningWorkspaceHost
        projectKey="ACME"
        projectName="Acme"
        launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
        anchorId={null}
        onClose={noop}
        initialTarget={null}
        initialCanvasTrail={trail}
        canManage={false}
      />,
    );
    expect(region()).toBeNull();
    expect(screen.getByTestId('canvas-stub')).toBe(canvas);
    expect(canvas.getAttribute('data-trail')).toBe('wi_1');
  });

  it('swaps to a newer offer’s requirement, then drops when a newer answer carries no offer', () => {
    const { rerender } = renderHost(thread(offer({ requirement: REQUIREMENT })));
    expect(region()!.textContent).toContain('People export the board as CSV.');
    const newer = { ...REQUIREMENT, outcome: 'People export a weekly CSV.' };
    conversation.state = thread(offer({ requirement: REQUIREMENT }), [
      { role: 'user' },
      { role: 'assistant', offer: offer({ requirement: newer }) },
    ]);
    rerender(element());
    expect(region()!.textContent).toContain('People export a weekly CSV.');
    expect(region()!.textContent).not.toContain('People export the board as CSV.');
    conversation.state = thread(offer({ requirement: REQUIREMENT }), [
      { role: 'user' },
      { role: 'assistant', offer: null },
    ]);
    rerender(element());
    expect(region()).toBeNull();
  });

  it('stays while Confirm is in flight, and drops once the offer reads confirmed', () => {
    const { rerender } = renderHost({
      ...thread(offer({ requirement: REQUIREMENT })),
      offerAnsweringTurnId: 't1',
    });
    expect(region()).not.toBeNull();
    conversation.state = thread(
      offer({
        requirement: REQUIREMENT,
        confirmedAt: '2026-10-24T10:06:00.000Z',
        confirmedSessionId: 's2',
      }),
    );
    rerender(element());
    expect(region()).toBeNull();
  });

  it('appears for a targeted offer that carries a requirement (MOTIR-9878)', () => {
    renderHost(thread(offer({ targetKey: 'ACME-40', requirement: REQUIREMENT })));
    expect(region()!.textContent).toContain('People export the board as CSV.');
  });

  it.each([
    ['a targeted offer with no requirement', offer({ targetKey: 'ACME-40' })],
    ['a log_bug offer', offer({ kind: 'log_bug', requirement: REQUIREMENT })],
    ['no offer', null],
  ])('does not appear for %s', (_label, o) => {
    renderHost(thread(o));
    expect(region()).toBeNull();
    expect(screen.getByTestId('canvas-stub').hasAttribute('inert')).toBe(false);
  });
});
