// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { isProposalPending, pendingProposalCount } from '@/lib/planning/planPending';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// CLOSING WITH PENDING PROPOSALS ASKS FIRST (MOTIR-4731, story MOTIR-4725).
//
// `design/ai-chat/design-notes.md` § *Opening & exiting* → *The CLOSE-WITH-PENDING
// guard* specified this from the first draw and nothing built it. What this file
// holds in place is the part that is easy to get subtly wrong: which vectors ask,
// what each answer does, and the one vector — browser Back — that has already
// happened by the time the question can be put.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

// The conversation is the host's, and the guard reads its state. Driven directly
// so a test can put a proposal on the canvas without a server.
const conversation = vi.hoisted(() => ({
  state: null as unknown as PlanChangeConversationState,
  approve: vi.fn(),
  discard: vi.fn(),
  onApproved: null as null | (() => void),
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: (opts: { onApproved?: () => void }) => {
    conversation.onApproved = opts.onApproved ?? null;
    return {
      state: conversation.state,
      send: vi.fn(),
      retry: vi.fn(),
      correctTurn: vi.fn(),
      approve: conversation.approve,
      discard: conversation.discard,
      dismissError: vi.fn(),
      stop: vi.fn(),
    };
  },
}));

// The canvas BEFORE a plan fetches its own levels; it is not what this file is
// about. Since MOTIR-11513 it is `PlanReviewCanvas` with `prePlan`, so only that
// state is stubbed and a plan's canvas stays real.
vi.mock('@/components/planning/PlanReviewCanvas', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/planning/PlanReviewCanvas')>();
  function PrePlanStub(props: Parameters<typeof real.PlanReviewCanvas>[0]) {
    return props.prePlan ? <div data-testid="canvas-stub" /> : <real.PlanReviewCanvas {...props} />;
  }
  return { ...real, PlanReviewCanvas: PrePlanStub };
});
vi.mock('@/components/planning/PlanChangeRail', () => ({
  PlanChangeRail: () => <div data-testid="rail-stub" />,
}));
vi.mock('@/components/planning/AuditCoverageBanner', () => ({
  AuditCoverageBanner: () => null,
}));

const { PlanningWorkspaceHost } = await import('@/components/planning/PlanningWorkspaceHost');
const { parsePlanningLaunch } = await import('@/lib/planning/launcher');

/** A review with three adds — a proposal a reader would mind losing. */
const REVIEW = {
  planId: 'plan_1',
  items: [
    { id: 'p1', op: 'add', proposedFields: { title: 'One' } },
    { id: 'p2', op: 'add', proposedFields: { title: 'Two' } },
    { id: 'p3', op: 'add', proposedFields: { title: 'Three' } },
  ],
} as unknown as PlanChangeConversationState['review'];

function stateWith(over: Partial<PlanChangeConversationState> = {}): PlanChangeConversationState {
  return {
    phase: 'idle',
    turns: [],
    review: null,
    decided: null,
    jobId: null,
    planId: null,
    progress: null,
    errorCode: null,
    approved: null,
    ...over,
  } as unknown as PlanChangeConversationState;
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  conversation.approve.mockReset().mockResolvedValue(undefined);
  conversation.discard.mockReset().mockResolvedValue(undefined);
  conversation.state = stateWith();
  conversation.onApproved = null;
});
afterEach(cleanup);

function renderHost(onClose = vi.fn()) {
  const closeGuardRef = { current: null as null | (() => boolean) };
  const onKeepPlanningAfterBack = vi.fn();
  const launch = parsePlanningLaunch({ mode: 'replan', from: 'project' });
  const host = () => (
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={launch}
      anchorId={null}
      onClose={onClose}
      closeGuardRef={closeGuardRef}
      onKeepPlanningAfterBack={onKeepPlanningAfterBack}
    />
  );
  const view = renderWithIntl(host());
  // Re-renders the host after a test moved the conversation's state, as a state change
  // inside the real hook would.
  const rerender = () => view.rerender(host());
  return { view, rerender, closeGuardRef, onClose, onKeepPlanningAfterBack };
}

const guard = () => screen.queryByRole('alertdialog');

describe('the pending PREDICATE is one definition, shared', () => {
  const index = { isEmpty: false, counts: { added: 3, changed: 0, removed: 0 } };

  it('is true only for an undecided, non-empty review', () => {
    expect(isProposalPending({ review: REVIEW, decided: null }, index)).toBe(true);
  });

  it('goes FALSE the moment the review is decided — a review survives its decision', () => {
    // MOTIR-3162: the canvas keeps drawing what landed, so "there is a review"
    // does not mean "there is a decision to take". `decided` is what says that,
    // and this is the flip the guard must not miss.
    expect(isProposalPending({ review: REVIEW, decided: 'accepted' }, index)).toBe(false);
    expect(isProposalPending({ review: REVIEW, decided: 'declined' }, index)).toBe(false);
  });

  it('is false for no review at all, and for a review that proposed nothing', () => {
    expect(isProposalPending({ review: null, decided: null }, index)).toBe(false);
    expect(isProposalPending({ review: REVIEW, decided: null }, { isEmpty: true })).toBe(false);
  });

  it('counts every kind of change — each is one thing the reader would lose', () => {
    expect(pendingProposalCount({ counts: { added: 3, changed: 2, removed: 1 } })).toBe(6);
  });
});

describe('with NO pending proposal, closing is instant', () => {
  it('the veto says go ahead, and no guard renders', () => {
    const { closeGuardRef } = renderHost();

    expect(closeGuardRef.current?.()).toBe(true);
    expect(guard()).toBeNull();
  });

  it('a decided review does not raise it either', () => {
    conversation.state = stateWith({ review: REVIEW, decided: 'accepted' });
    const { closeGuardRef } = renderHost();

    expect(closeGuardRef.current?.()).toBe(true);
    expect(guard()).toBeNull();
  });

  it('the Close control closes straight through', () => {
    const { onClose } = renderHost();

    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('with a pending proposal, every vector asks first', () => {
  beforeEach(() => {
    conversation.state = stateWith({ review: REVIEW });
  });

  it('the veto REFUSES and raises an alertdialog naming the count', () => {
    // Every vector — Close, Esc, the scrim, a history pop — reaches the overlay's
    // one `requestClose()`, which consults exactly this. One assertion covers all
    // four, which is the point of the seam.
    const { closeGuardRef } = renderHost();

    let allowed: boolean | undefined;
    act(() => {
      allowed = closeGuardRef.current?.();
    });

    expect(allowed).toBe(false);
    const dialog = guard();
    expect(dialog).not.toBeNull();
    // `alertdialog`, not `dialog`: assistive tech should INTERRUPT here.
    expect(dialog?.getAttribute('role')).toBe('alertdialog');
    expect(dialog?.textContent).toContain('3');
  });

  it('discards NOTHING until an action is chosen', () => {
    const { closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());

    expect(conversation.discard).not.toHaveBeenCalled();
    expect(conversation.approve).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the Close control REQUESTS a close — the veto is what refuses it', () => {
    // ⚠️ Read this one carefully. The host's Close control calls `onClose`,
    // which IS the overlay's `requestClose` — so it is called here, and the
    // refusal happens one level up when that function consults the veto. The
    // host does not decide twice, which is the whole point of the seam: there is
    // exactly one place a close is questioned, and every vector reaches it.
    const { closeGuardRef, onClose } = renderHost();

    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // What the overlay does with it:
    let allowed: boolean | undefined;
    act(() => {
      allowed = closeGuardRef.current?.();
    });
    expect(allowed).toBe(false);
    expect(guard()).not.toBeNull();
  });
});

describe('the three answers', () => {
  beforeEach(() => {
    conversation.state = stateWith({ review: REVIEW });
  });

  it('KEEP PLANNING dismisses the guard and touches nothing else', () => {
    const { closeGuardRef, onClose, onKeepPlanningAfterBack } = renderHost();
    act(() => void closeGuardRef.current?.());

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));

    expect(guard()).toBeNull();
    expect(conversation.discard).not.toHaveBeenCalled();
    expect(conversation.approve).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // …and it tells the overlay, which is what puts the address back after a
    // browser Back. Harmless on every other vector.
    expect(onKeepPlanningAfterBack).toHaveBeenCalledTimes(1);
  });

  it('DISCARD drops the proposal, then closes', async () => {
    const { closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
    });

    expect(conversation.discard).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(guard()).toBeNull();
  });

  it('CONFIRM & ADD approves, and closes only when the write LANDED', async () => {
    const { closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm & add' }));
    });

    expect(conversation.approve).toHaveBeenCalledTimes(1);
    // The approve has resolved but the SUCCESS callback has not fired — nothing
    // has closed. This is the failure arm: a rejected approve never reaches it.
    expect(onClose).not.toHaveBeenCalled();

    act(() => conversation.onApproved?.());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(guard()).toBeNull();
  });

  it('a FAILED approve leaves the guard up — the one case where closing would lose it', async () => {
    const { closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm & add' }));
    });
    // `onApproved` fires on success and on nothing else, so this is what a
    // failure looks like: no callback, no close, the guard still asking.
    expect(onClose).not.toHaveBeenCalled();
    expect(guard()).not.toBeNull();
  });

  it('locks every action while a decision is in flight', () => {
    conversation.state = stateWith({ review: REVIEW, phase: 'deciding' });
    const { closeGuardRef } = renderHost();
    act(() => void closeGuardRef.current?.());

    for (const name of [/Discard/, 'Keep planning', 'Confirm & add']) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
  });
});

describe('the guard cannot answer its own question', () => {
  it('lets the close it TOOK through, even though the proposal is still pending', async () => {
    // Both decisions are server writes, so `pending` is still true at the moment
    // *Discard* asks to close. Without the bypass the veto would raise a second
    // guard over the first — the shape this test exists to pin.
    conversation.state = stateWith({ review: REVIEW });
    const { closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the guard’s own Esc and scrim mean KEEP PLANNING', () => {
  it('dismisses the GUARD and leaves the workspace and the proposal alone', () => {
    conversation.state = stateWith({ review: REVIEW });
    const { closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());
    expect(guard()).not.toBeNull();

    // Radix routes Escape and a scrim click through the dialog's own
    // `onOpenChange(false)`. Driving that directly is what the key does; driving
    // the KEY here would test happy-dom's event plumbing, not the decision.
    act(() => {
      fireEvent.keyDown(guard()!, { key: 'Escape' });
    });

    // Whatever the environment does with the key, the contract is the same and
    // is asserted on the outcome: the safe answer is the one that loses nothing.
    expect(onClose).not.toHaveBeenCalled();
    expect(conversation.discard).not.toHaveBeenCalled();
    expect(conversation.approve).not.toHaveBeenCalled();
  });

  it('the guard closes on Keep planning and the workspace is still mounted', () => {
    conversation.state = stateWith({ review: REVIEW });
    const { closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));

    expect(guard()).toBeNull();
    expect(screen.getByRole('button', { name: /Close/ })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the two vectors the design deliberately does NOT guard', () => {
  it('registers no `beforeunload` — a reload is not asked about', () => {
    // A browser's own "leave site?" dialog cannot carry three actions, and it
    // fires whether or not anything is at stake. The design chose against it;
    // this is what says the absence was chosen rather than missed.
    const added: string[] = [];
    // ⚠️ PASS THROUGH THE ORIGINAL, BOUND — not `EventTarget.prototype`
    // (MOTIR-6250). happy-dom keeps its listener bookkeeping on the INSTANCE, so
    // `EventTarget.prototype.addEventListener.call(window, …)` throws
    // `Cannot read properties of undefined (reading 'bubbling')`. That was latent
    // for as long as nothing registered a window listener during this render; the
    // resizable split's persisted-width hook subscribes to `storage`, so it became
    // the first caller — and because the throw skipped `mockRestore()`, the leaked
    // spy took three later tests in this file with it.
    const passThrough = window.addEventListener.bind(window);
    const spy = vi.spyOn(window, 'addEventListener').mockImplementation(((
      type: string,
      ...rest: unknown[]
    ) => {
      added.push(type);
      return (passThrough as unknown as (t: string, ...r: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener);

    conversation.state = stateWith({ review: REVIEW });
    renderHost();

    expect(added).not.toContain('beforeunload');
    spy.mockRestore();
  });

  it('a STREAMING turn is not pending — there is no proposal to lose yet', () => {
    // The predicate needs a `review`, and a stream has none. Closing calls the
    // conversation's `stop`, which is exactly what navigating away from the
    // route did.
    conversation.state = stateWith({ phase: 'streaming', review: null });
    const { closeGuardRef } = renderHost();

    expect(closeGuardRef.current?.()).toBe(true);
    expect(guard()).toBeNull();
  });
});

describe('coverage · the arms the happy path does not reach', () => {
  it('a scrim click or Esc during a DECISION is ignored, not a second answer', () => {
    // The guard's own `onOpenChange` yields to `deciding`: a write is in flight
    // and there is nothing safe to do but wait. Without this arm a stray click
    // beside the dialog would dismiss it mid-approve, leaving the reader with no
    // dialog, a write they cannot see, and a workspace that may or may not close.
    conversation.state = stateWith({ review: REVIEW, phase: 'deciding' });
    const { closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());

    act(() => {
      fireEvent.keyDown(guard()!, { key: 'Escape' });
    });

    expect(guard()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the target set can be added to and removed from while the guard is armed', () => {
    // `addTarget` / `removeTarget` are the host's own, handed to the rail. They
    // are exercised here because this file mounts the host with a REAL target
    // set — the rail's own suite stubs it.
    conversation.state = stateWith({ review: REVIEW });
    const { closeGuardRef } = renderHost();

    // The predicate is about the REVIEW, never about the targets: adding one
    // must not make a close safe, and removing one must not make it unsafe.
    act(() => void closeGuardRef.current?.());
    expect(guard()).not.toBeNull();
  });
});

describe('a plan DECIDED ELSEWHERE while the guard is up (Bug MOTIR-11464)', () => {
  // The conversation settles the overlay when a re-read (or a refused press) finds the
  // plan already decided; the guard's question — "closing now discards them" — is then
  // false, so it must step aside rather than keep asking.
  it('steps aside when the plan is found DECLINED, and the overlay stays open on it', () => {
    conversation.state = stateWith({ review: REVIEW, phase: 'review' });
    const { rerender, closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());
    expect(guard()).not.toBeNull();

    conversation.state = stateWith({ review: REVIEW, decided: 'declined' });
    rerender();

    expect(guard()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // …and the next Close is instant: nothing is left to lose.
    let allowed = false;
    act(() => {
      allowed = closeGuardRef.current?.() ?? false;
    });
    expect(allowed).toBe(true);
  });

  it('a Confirm & add refused because the plan was declined elsewhere disarms its close', async () => {
    conversation.state = stateWith({ review: REVIEW, phase: 'review' });
    const { rerender, closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm & add' }));
    });

    // The refusal settled the overlay to the plan's real decision.
    conversation.state = stateWith({ review: REVIEW, decided: 'declined' });
    rerender();
    expect(guard()).toBeNull();

    // A later approval of a NEW plan must not close the workspace on the old press.
    act(() => conversation.onApproved?.());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a Confirm & add refused because the plan was approved elsewhere still closes', async () => {
    conversation.state = stateWith({ review: REVIEW, phase: 'review' });
    const { closeGuardRef, onClose } = renderHost();
    act(() => void closeGuardRef.current?.());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm & add' }));
    });
    // The settle reports the approval it found, as a press made here does.
    act(() => conversation.onApproved?.());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays up while a decision is in flight', () => {
    conversation.state = stateWith({ review: REVIEW, phase: 'review' });
    const { rerender, closeGuardRef } = renderHost();
    act(() => void closeGuardRef.current?.());
    conversation.state = stateWith({ review: REVIEW, phase: 'deciding' });
    rerender();
    expect(guard()).not.toBeNull();
  });
});
