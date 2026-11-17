// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// MOTIR-7050 — the SURFACE SEED, end to end through the real host and rail: the
// two doors that open the one Motir AI surface with words in it.
//
//  · the report widget's accept is the ONE seeded send (ADR AMENDMENT 1, A1.3):
//    it goes out once, through the ask door with the triage bug as its anchor,
//    and a remount, a reopen or a StrictMode double effect never sends it again;
//  · the orb's "Debug with Motir AI" row pre-fills the composer and SENDS NOTHING.
//
// The conversation hook is stubbed (the host test's own shape) so what the host
// hands it — and how often — is the assertion.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: () => ({ results: [], loading: false, tooShort: true }),
}));
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="review-canvas-stub" />,
}));

const { conversation } = vi.hoisted(() => ({
  conversation: {
    state: null as PlanChangeConversationState | null,
    send: vi.fn(),
    retry: vi.fn(),
    correctTurn: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
    stop: vi.fn(),
  },
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: () => conversation,
}));

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';
import { resetPickAutoSendClaimsForTests } from '@/lib/planning/pickAutoSend';
import {
  firstLineCaret,
  handSurfaceSeed,
  peekSurfaceSeed,
  resetSurfaceSeedForTests,
} from '@/lib/planning/surfaceSeed';

const IDLE: PlanChangeConversationState = {
  phase: 'idle',
  session: {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-09-30T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '',
    updatedAt: '',
    turns: [],
    workItemRefs: {},
  },
  progress: null,
  acts: [],
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
};

const REPORT =
  'Board drag drops the card one column short\n\nDragging a card into the rightmost column puts it in the column to its left.';
const PREFILL = 'Something is broken. What happens: \nWhat should happen instead: ';

function host(search: Record<string, string> = { mode: 'project', from: 'project' }) {
  return (
    <PlanningWorkspaceHost
      projectKey="PROD"
      projectName="Prod"
      launch={parsePlanningLaunch(search)}
      anchorId={null}
      onClose={() => {}}
      initialTarget={null}
      canManage={false}
    />
  );
}

beforeEach(() => {
  conversation.state = IDLE;
  resetSurfaceSeedForTests();
  resetPickAutoSendClaimsForTests();
});

afterEach(() => {
  cleanup();
  conversation.send.mockReset();
});

describe('the widget’s seeded send', () => {
  it('is sent ONCE through the ask door, anchored on the triage bug, and the seed is taken', () => {
    handSurfaceSeed({ kind: 'send', body: REPORT, anchorKey: 'PROD-412' });
    renderWithIntl(host());

    expect(conversation.send).toHaveBeenCalledTimes(1);
    // An EMPTY target set — the project thread, whose one door classifies the
    // turn — with the bug as the ask's anchor. No intent rides it.
    expect(conversation.send).toHaveBeenCalledWith(REPORT, [], { anchorKey: 'PROD-412' });
    expect(peekSurfaceSeed()).toBeNull();
    // Nothing waits in the composer: the words went out as the person's turn.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('survives a StrictMode double render and double effect as one send', () => {
    handSurfaceSeed({ kind: 'send', body: REPORT, anchorKey: 'PROD-412' });
    renderWithIntl(<StrictMode>{host()}</StrictMode>);
    expect(conversation.send).toHaveBeenCalledTimes(1);
  });

  it('a REOPEN (a second host on the same page) does not send it again', () => {
    handSurfaceSeed({ kind: 'send', body: REPORT, anchorKey: 'PROD-412' });
    const first = renderWithIntl(host());
    first.unmount();
    renderWithIntl(host());

    expect(conversation.send).toHaveBeenCalledTimes(1);
  });

  it('even a seed somehow handed TWICE for the same bug sends once — the page claim holds', () => {
    handSurfaceSeed({ kind: 'send', body: REPORT, anchorKey: 'PROD-412' });
    renderWithIntl(host()).unmount();
    handSurfaceSeed({ kind: 'send', body: REPORT, anchorKey: 'PROD-412' });
    renderWithIntl(host());

    expect(conversation.send).toHaveBeenCalledTimes(1);
  });

  it('is not taken by an ITEM-anchored workspace, which has no ask door', () => {
    handSurfaceSeed({ kind: 'send', body: REPORT, anchorKey: 'PROD-412' });
    renderWithIntl(host({ mode: 'contextual', from: 'work-item', item: 'PROD-7' }));

    expect(conversation.send).not.toHaveBeenCalled();
  });
});

describe('the orb row’s pre-fill', () => {
  it('puts the template in the composer, focused at the end of its first line, and sends NOTHING', () => {
    handSurfaceSeed({ kind: 'draft', text: PREFILL, caret: firstLineCaret(PREFILL) });
    renderWithIntl(host());

    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(field.value).toBe(PREFILL);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(PREFILL.indexOf('\n'));
    expect(conversation.send).not.toHaveBeenCalled();
    expect(peekSurfaceSeed()).toBeNull();
  });

  it('a reopen starts with an empty composer — the pre-fill is not carried in the address', () => {
    handSurfaceSeed({ kind: 'draft', text: PREFILL, caret: firstLineCaret(PREFILL) });
    renderWithIntl(host()).unmount();
    renderWithIntl(host());

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    expect(conversation.send).not.toHaveBeenCalled();
  });
});
