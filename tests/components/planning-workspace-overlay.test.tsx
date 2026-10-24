// @vitest-environment happy-dom
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { withoutPlanningOverlay } from '@/lib/planning/launcher';
import { SUBSTRATE_POLL_INTERVAL_MS } from '@/lib/planning/substratePoll';
import type { OnboardingSubstrate } from '@/lib/dto/onboardingSubstrate';

// THE PLANNING WORKSPACE OVERLAY (MOTIR-4729, under story MOTIR-4725).
//
// What this file holds in place is not "a dialog renders" — it is the four
// properties the story is FOR, each of which fails silently:
//
//   · the open state is the ADDRESS and nothing else, so Back closes it and no
//     second source of truth can disagree with the address bar;
//   · closing writes the four overlay parameters away and leaves every host
//     parameter byte-identical, with `shallowPush` — because the page underneath
//     must not unmount;
//   · the anchor read degrades to the project conversation, never to an error;
//   · the gates the ROUTE ran on the server still run, from the shell's own
//     provider rather than from a prop.

// The address, mutable — this IS the component's input.
let params = new URLSearchParams();
let pathname = '/backlog';
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));

/**
 * THE ROUTING RUN's own transport (MOTIR-4769) — the overlay dispatches it
 * whenever it opens with a substrate, so every test in this file that supplies
 * one reaches it. Mocked at the CLIENT rather than at `fetch`, because what this
 * suite is about is what the overlay DOES with a resolution, not how the
 * resolution was fetched (`tests/onboarding/routing-verdict.test.ts` owns the
 * parse, and the client owns the polling).
 */
const { resolveOnboardingRouting } = vi.hoisted(() => ({ resolveOnboardingRouting: vi.fn() }));
vi.mock('@/lib/planning/onboardingRoutingClient', () => ({ resolveOnboardingRouting }));

// THE WAIT'S OWN SEAM (MOTIR-4829) — the island asks the server whether the
// index has landed, because `router.refresh()` cannot reach a `useState`-seeded
// island. Mocked at the CLIENT rather than at `fetch`, for the same reason the
// routing client is: what these tests are about is what the WINDOW does with an
// answer, not how the answer is transported.
const { fetchPlanningSubstrate } = vi.hoisted(() => ({ fetchPlanningSubstrate: vi.fn() }));
vi.mock('@/lib/planning/substratePoll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/substratePoll')>()),
  fetchPlanningSubstrate: (...a: unknown[]) => fetchPlanningSubstrate(...a),
}));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));
// A `refused-gate` launch reads its seed first (MOTIR-6210). Its own suite is
// `planning-overlay-refusal-seed.test.tsx`; here the read answers the 404 so the
// launch falls back to the project workspace, which is all the Back case needs.
vi.mock('@/lib/planning/planningSeedClient', () => ({ fetchPlanningSeed: async () => null }));

// The actor's permission set — the shell's provider, which is the whole reason
// the overlay needs no `canManage` prop.
let granted = new Set<string>(['project:browse']);
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: (key: string) => granted.has(key) }),
}));

// The host has its OWN suite. Here it stands in for itself so every assertion is
// about the OVERLAY's decision to mount it, and with what.
//
// ⚠️ The stub carries a per-MOUNT id, seeded in a `useState` initializer — the
// same mechanism the real host seeds its three props with, which is exactly what
// the keyed-remount contract is about. Counting RENDERS instead would report a
// remount on every re-render and prove nothing.
let mountSeq = 0;
/** Stands in for "the host has a pending proposal and raised its guard". */
let vetoClose = false;
vi.mock('@/components/planning/PlanningWorkspaceHost', () => ({
  PlanningWorkspaceHost: ({
    launch,
    anchorId,
    canManage,
    initialTarget,
    initialCanvasTrail,
    onClose,
    closeGuardRef,
    onKeepPlanningAfterBack,
    justReturnedFromOnboarding,
  }: {
    launch: { mode: string; from: string; itemKey: string | null };
    anchorId: string | null;
    canManage?: boolean;
    initialTarget?: { identifier: string } | null;
    initialCanvasTrail?: readonly { id: string }[];
    onClose?: () => void;
    closeGuardRef?: { current: (() => boolean) | null };
    onKeepPlanningAfterBack?: () => void;
    /** MOTIR-4770 — the round trip closed, and the rail says so. */
    justReturnedFromOnboarding?: boolean;
  }) => {
    const [mountId] = useState(() => ++mountSeq);
    // The host registers the close VETO (MOTIR-4731). `vetoClose` lets a test
    // stand in for "there is a pending proposal" without a conversation.
    useEffect(() => {
      if (!closeGuardRef) return;
      closeGuardRef.current = () => !vetoClose;
      return () => {
        closeGuardRef.current = null;
      };
    });
    return (
      <div
        data-testid="host"
        data-mount={String(mountId)}
        data-mode={launch.mode}
        data-from={launch.from}
        data-anchor-id={anchorId ?? ''}
        data-target={initialTarget?.identifier ?? ''}
        data-trail={(initialCanvasTrail ?? []).map((c) => c.id).join(',')}
        {...(justReturnedFromOnboarding ? { 'data-just-returned': 'true' } : {})}
        data-can-manage={String(canManage ?? false)}
      >
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" onClick={onKeepPlanningAfterBack}>
          Keep planning
        </button>
      </div>
    );
  },
}));

vi.mock('@/components/planning/PlanningWorkspaceSkeleton', () => ({
  PlanningWorkspaceSkeleton: () => <div data-testid="skeleton" />,
  PlanningCanvasSkeleton: () => <div />,
}));

const { PlanningWorkspaceOverlay } = await import('@/components/planning/PlanningWorkspaceOverlay');

const ANCHOR = {
  anchor: { id: 'wi_7', identifier: 'MOTIR-7', title: 'The anchor', kind: 'subtask' as const },
  ancestors: [
    { id: 'wi_1', identifier: 'MOTIR-1', title: 'Epic 8' },
    { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story' },
  ],
  hasChildren: false,
};

beforeEach(() => {
  params = new URLSearchParams();
  pathname = '/backlog';
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  fetchPlanningAnchor.mockReset();
  fetchPlanningAnchor.mockResolvedValue(ANCHOR);
  // Default: the verdict has NOT landed yet — which is the state the reading
  // surface exists for, and the one every MOTIR-4768 test is about. A test that
  // is about what happens WHEN it lands drives its own resolution.
  resolveOnboardingRouting.mockReset();
  fetchPlanningSubstrate.mockReset();
  fetchPlanningSubstrate.mockResolvedValue(null);
  resolveOnboardingRouting.mockReturnValue(new Promise(() => {}));
  granted = new Set(['project:browse']);
  mountSeq = 0;
  vetoClose = false;
});
afterEach(cleanup);

/**
 * ⚠️ NO `onboardingRanAt` — the prop is gone (MOTIR-4765).
 *
 * It existed to feed `resolvePlanningHostGate`, which answered `'onboarding'`
 * for a null marker and made this component push the reader out of the window
 * they had just opened. The marker means *"has never had a plan APPROVED"*, so
 * that ejected established, code-bearing projects. The helper takes no override
 * because there is no longer a value that changes what this component does.
 */
function mount(over: { substrate?: OnboardingSubstrate | null } = {}) {
  return render(
    <PlanningWorkspaceOverlay
      projectKey="ACME"
      projectName="Acme"
      // ⚠️ `null` BY DEFAULT — an ESTABLISHED project, which is what this whole
      // suite has always been about. A substrate is the READING state's input
      // (MOTIR-4768) and only a project whose first plan has never been approved
      // has one; the layout resolves it for those and for nobody else.
      substrate={over.substrate ?? null}
    />,
  );
}

/** Put the overlay in the address, as a door's `shallowPush` would. */
function openAt(search: string, path = '/backlog') {
  pathname = path;
  params = new URLSearchParams(search);
}

describe('the OPEN state is the address, and nothing else', () => {
  it('mounts NOTHING when the address does not carry the overlay', async () => {
    openAt('filter=type%3Acode');
    mount();
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('mounts NOTHING for the ROUTE era address — that is the forward’s job', async () => {
    openAt('mode=project&from=project');
    mount();
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
  });

  it('renders the workspace inside a dialog on ANY authed route', async () => {
    for (const path of ['/backlog', '/boards', '/items/MOTIR-9', '/workbench']) {
      openAt('plan=project&planFrom=project', path);
      const view = mount();
      await act(async () => {});

      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByTestId('host').getAttribute('data-mode')).toBe('project');
      view.unmount();
    }
  });

  it('carries the launch through — mode and origin both', async () => {
    openAt('plan=replan&planFrom=roadmap');
    mount();
    await act(async () => {});

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-mode')).toBe('replan');
    expect(host.getAttribute('data-from')).toBe('roadmap');
  });
});

describe('closing writes the address, and only the address', () => {
  it('strips exactly the four overlay parameters and keeps the host’s', async () => {
    openAt('filter=type%3Acode&sort=rank&plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(shallowPush).toHaveBeenCalledTimes(1);
    const written = shallowPush.mock.calls[0]![0] as string;
    expect(written).toBe('/backlog?filter=type%3Acode&sort=rank');
    // …and it is exactly what the launcher's own stripper produces, so the two
    // cannot drift.
    expect(written).toBe(
      withoutPlanningOverlay('/backlog?filter=type%3Acode&sort=rank&plan=project&planFrom=project'),
    );
  });

  it('keeps the roadmap’s drilled level and the quick view', async () => {
    openAt('item=MOTIR-12&plan=replan&planFrom=roadmap', '/roadmap');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(shallowPush).toHaveBeenCalledWith('/roadmap?item=MOTIR-12');
  });

  it('NEVER navigates — the page underneath must not unmount', async () => {
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a GUIDE’s close re-reads the card’s page ONCE, by whatever vector (MOTIR-8576)', async () => {
    openAt('plan=guide&planFrom=guide&planItem=MOTIR-3', '/items/MOTIR-3');
    const view = mount();
    await act(async () => {});
    expect(refresh).not.toHaveBeenCalled();

    // The address loses the overlay — a Close, an Escape or a Back alike.
    params = new URLSearchParams();
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(1);

    // Staying closed asks for nothing more.
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a PLANNING workspace’s close re-reads nothing: its surfaces re-read themselves', async () => {
    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});

    params = new URLSearchParams();
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Escape reaches the same one close', async () => {
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {});

    expect(shallowPush).toHaveBeenCalledWith('/backlog');
  });

  it('a history pop that drops the parameters closes it with NO second write', async () => {
    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});
    expect(screen.getByTestId('host')).toBeTruthy();

    // Back: the address changes under the component, exactly as Next syncs
    // `useSearchParams` with a `popstate`.
    params = new URLSearchParams('');
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    // The pop already happened; writing again would push a second entry and make
    // Back need two presses.
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('returns focus to the door that opened it', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Plan with AI';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});

    params = new URLSearchParams('');
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('the ANCHOR read', () => {
  it('is not made at all for a project launch', async () => {
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    expect(fetchPlanningAnchor).not.toHaveBeenCalled();
    expect(screen.getByTestId('host').getAttribute('data-anchor-id')).toBe('');
  });

  it('shows the skeleton until it settles, then seeds all three from it', async () => {
    let settle: (v: typeof ANCHOR) => void = () => {};
    fetchPlanningAnchor.mockReturnValue(
      new Promise<typeof ANCHOR>((resolve) => {
        settle = resolve;
      }),
    );
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-7');
    mount();
    await act(async () => {});

    expect(screen.getByTestId('skeleton')).toBeTruthy();
    expect(screen.queryByTestId('host')).toBeNull();

    await act(async () => {
      settle(ANCHOR);
    });

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-anchor-id')).toBe('wi_7');
    expect(host.getAttribute('data-target')).toBe('MOTIR-7');
    // A `subtask` anchor is the LEAF case of the arrival rule (MOTIR-6160): it
    // has no inside, so the trail stays the ancestors and the canvas opens on the
    // anchor's OWN level with the anchor ringed. This is MOTIR-2070's arrival,
    // still correct for exactly this kind — the container case below is the one
    // that changed.
    expect(host.getAttribute('data-trail')).toBe('wi_1,wi_3');
    expect(fetchPlanningAnchor).toHaveBeenCalledTimes(1);
    expect(fetchPlanningAnchor.mock.calls[0]![0]).toBe('MOTIR-7');
  });

  it('an anchor WITH CHILDREN opens INSIDE it — the trail ends at the anchor itself', async () => {
    // The change MOTIR-6154 asks for, at the seam that produces it: the canvas
    // loads the level named by the LAST crumb, so appending the anchor is what
    // makes the workspace open on the STORY'S CHILDREN rather than beside it
    // among its siblings.
    fetchPlanningAnchor.mockResolvedValue({
      anchor: { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story', kind: 'story' as const },
      ancestors: [{ id: 'wi_1', identifier: 'MOTIR-1', title: 'Epic 8' }],
      hasChildren: true,
    });
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-3');
    mount();
    await act(async () => {});

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-anchor-id')).toBe('wi_3');
    expect(host.getAttribute('data-trail')).toBe('wi_1,wi_3');
  });

  it('a CHILDLESS story opens BESIDE it — its own level, not an empty one (MOTIR-7621)', async () => {
    fetchPlanningAnchor.mockResolvedValue({
      anchor: { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story', kind: 'story' as const },
      ancestors: [{ id: 'wi_1', identifier: 'MOTIR-1', title: 'Epic 8' }],
      hasChildren: false,
    });
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-3');
    mount();
    await act(async () => {});

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-anchor-id')).toBe('wi_3');
    expect(host.getAttribute('data-trail')).toBe('wi_1');
  });

  it('a 404 opens the PROJECT conversation at the root, with no error surface', async () => {
    fetchPlanningAnchor.mockResolvedValue(null);
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-99999');
    mount();
    await act(async () => {});

    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-anchor-id')).toBe('');
    expect(host.getAttribute('data-target')).toBe('');
    expect(host.getAttribute('data-trail')).toBe('');
    // Never a dead workspace and never an error panel inside a planning surface.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a thrown read degrades the same way — an outage is not an error panel', async () => {
    fetchPlanningAnchor.mockRejectedValue(new Error('502'));
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-7');
    mount();
    await act(async () => {});

    expect(screen.getByTestId('host').getAttribute('data-anchor-id')).toBe('');
  });

  it('a DIFFERENT anchor remounts the host; the same one does not', async () => {
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-7');
    const view = mount();
    await act(async () => {});
    const firstMount = screen.getByTestId('host').getAttribute('data-mount');
    expect(firstMount).toBeTruthy();

    // An approve's `router.refresh()` re-renders with the SAME address. The host
    // seeds three things in `useState` initializers, so a remount here would
    // throw away the conversation and the canvas's drill state.
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});
    expect(screen.getByTestId('host').getAttribute('data-mount')).toBe(firstMount);

    // Re-targeting from inside the workspace IS a different workspace.
    fetchPlanningAnchor.mockResolvedValue({
      anchor: { id: 'wi_8', identifier: 'MOTIR-8', title: 'Another', kind: 'subtask' as const },
      ancestors: [],
      hasChildren: false,
    });
    params = new URLSearchParams('plan=contextual&planFrom=work-item&planItem=MOTIR-8');
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});

    expect(screen.getByTestId('host').getAttribute('data-mount')).not.toBe(firstMount);
    expect(screen.getByTestId('host').getAttribute('data-anchor-id')).toBe('wi_8');
  });
});

describe('the GATES the route ran on the server', () => {
  it('a viewer who cannot browse gets the statement, not a workspace', async () => {
    granted = new Set();
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    // The statement is IN the dialog — the page underneath is still usable, and
    // there is no route to 404.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /access/i })).toBeTruthy();
  });

  // ⚠️ THE TWO TESTS THIS REPLACES ASSERTED THE OPPOSITE, AND THEY WERE RIGHT
  // ABOUT THE BEHAVIOUR THAT SHIPPED (MOTIR-4765). One required
  // `expect(push).toHaveBeenCalledWith('/onboarding')` for a null marker; the
  // other required the same push NOT to fire while the overlay was closed. Both
  // described a forward the product should never have had: `onboardingRanAt` is
  // stamped once, by `plansService.approvePlan`, so `null` means *"has never had
  // a plan APPROVED"* rather than *"has never planned"* — and on the overlay the
  // forward fired seconds AFTER the reader pressed *Plan with AI*.
  //
  // This is not an assertion edited to agree with today (`CLAUDE.md` § the
  // receipt reflex): the behaviour was deliberately removed by a card whose
  // subject is that it was wrong, so the test moves with it. What replaces it is
  // wider than what it replaces — the component must navigate NOWHERE, for any
  // project, open or closed.
  it('a NEVER-ONBOARDED project opens the workspace like any other, and nothing navigates', async () => {
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    expect(screen.getByTestId('host')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('navigates nowhere while the overlay is CLOSED either', async () => {
    openAt('filter=type%3Acode');
    mount();
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('the ACCESS arm still precedes everything, and still navigates nowhere', async () => {
    // The half MOTIR-4765 does not touch, re-asserted beside the change so that
    // widening the gate cannot be read as relaxing it: a viewer who cannot
    // browse is told so, in the dialog, and is not sent anywhere either.
    granted = new Set();
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    expect(screen.getByRole('heading', { name: /access/i })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('gates the audit banner on the permission the SERVER gate asserts, with no prop', async () => {
    // `auditCoverageService.getCoverage` asserts `ai:configure` — so that, and
    // not a rank, is what decides whether the banner is an invitation or a 403.
    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});
    expect(screen.getByTestId('host').getAttribute('data-can-manage')).toBe('false');
    view.unmount();

    granted = new Set(['project:browse', 'ai:configure']);
    mount();
    await act(async () => {});
    expect(screen.getByTestId('host').getAttribute('data-can-manage')).toBe('true');
  });
});

describe('the host may VETO a close (the pending guard’s seam, MOTIR-4731)', () => {
  it('writes nothing when the host refuses', async () => {
    vetoClose = true;
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // The address is untouched, so the workspace is still open and the guard —
    // rendered by the host — is what the reader is answering.
    expect(shallowPush).not.toHaveBeenCalled();
    expect(screen.getByTestId('host')).toBeTruthy();
  });

  it('HOLDS the workspace up after a browser Back the host refuses', async () => {
    vetoClose = true;
    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});

    // Back: the browser has already navigated by the time `popstate` fires, so
    // the overlay reads an address that no longer carries it.
    window.history.pushState(null, '', '/backlog');
    params = new URLSearchParams('');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});

    // Still mounted — the guard needs a workspace to ask over.
    expect(screen.getByTestId('host')).toBeTruthy();
    expect(shallowPush).not.toHaveBeenCalled();
  });

  it('KEEP PLANNING after a Back puts the address back, with ONE write', async () => {
    vetoClose = true;
    openAt('plan=replan&planFrom=roadmap', '/roadmap');
    const view = mount();
    await act(async () => {});

    window.history.pushState(null, '', '/roadmap');
    params = new URLSearchParams('');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));

    // ONE `shallowPush`, so Back means what it says again rather than needing
    // two presses.
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush.mock.calls[0]![0]).toBe('/roadmap?plan=roadmap&planFrom=roadmap');
  });

  it('a Back the host ALLOWS just closes — no hold, no write', async () => {
    openAt('plan=project&planFrom=project');
    const view = mount();
    await act(async () => {});

    params = new URLSearchParams('');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    expect(shallowPush).not.toHaveBeenCalled();
  });
});

describe('coverage · Keep planning after a Back, for every launch shape', () => {
  // `launchContext` turns a parsed launch back into the context the re-push
  // needs. Each origin is its own arm, and only the reader who goes Back on that
  // kind of launch reaches it — so each is driven.
  const CASES = [
    {
      name: 'a work-item launch',
      search: 'plan=replan&planFrom=work-item&planItem=MOTIR-7',
      path: '/items/MOTIR-7',
      expected: '/items/MOTIR-7?plan=replan&planFrom=work-item&planItem=MOTIR-7',
    },
    {
      name: 'a roadmap launch',
      search: 'plan=roadmap&planFrom=roadmap',
      path: '/roadmap',
      expected: '/roadmap?plan=roadmap&planFrom=roadmap',
    },
    {
      name: 'a project re-plan',
      search: 'plan=replan&planFrom=project',
      path: '/backlog',
      expected: '/backlog?plan=replan&planFrom=project',
    },
    {
      // MOTIR-6210 — the address round-trips as the GATE, never the card it
      // resolved to, so a re-push keeps seeding (or resuming) from the refusal.
      name: 'a refused-gate launch',
      search: 'plan=replan&planFrom=refused-gate&planGate=cmg7k2q0',
      path: '/items/MOTIR-7',
      expected: '/items/MOTIR-7?plan=replan&planFrom=refused-gate&planGate=cmg7k2q0',
    },
  ];

  it.each(CASES)('re-pushes $name unchanged', async ({ search, path, expected }) => {
    vetoClose = true;
    openAt(search, path);
    const view = mount();
    await act(async () => {});

    params = new URLSearchParams('');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={null} />,
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));

    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush.mock.calls[0]![0]).toBe(expected);
  });

  it('is a no-op when there was no Back to answer', async () => {
    // *Keep planning* is also what Esc and the scrim mean on the guard. On those
    // vectors the address never changed, so there is nothing to put back — and
    // pushing anyway would add a history entry Back would then have to eat.
    vetoClose = true;
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));
    expect(shallowPush).not.toHaveBeenCalled();
  });
});

describe('the READING state — what the window says while a session decides (MOTIR-4768)', () => {
  const thin = {
    itemCount: 0,
    itemCountTruncated: false,
    repositories: [],
    repositoryConnected: false,
    repositoryIndexed: false,
  } satisfies OnboardingSubstrate;

  const rich = {
    itemCount: 214,
    itemCountTruncated: false,
    repositories: [{ ref: 'acme/widgets', indexed: true }],
    repositoryConnected: true,
    repositoryIndexed: true,
  } satisfies OnboardingSubstrate;

  it('AC1 · a never-onboarded project sees it, naming what is being read', async () => {
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});

    expect(screen.getByTestId('planning-reading-state')).toBeTruthy();
    expect(screen.getByText('acme/widgets')).toBeTruthy();
    expect(screen.getByText('214 work items')).toBeTruthy();
  });

  it('AC5 · an ESTABLISHED project never sees it — the layout resolves no substrate', async () => {
    // `null` is both halves of the answer: nothing to show, and nothing read.
    // The window still OPENS — MOTIR-4765 took the wall down and this prop is
    // not it coming back.
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});

    expect(screen.queryByTestId('planning-reading-state')).toBeNull();
    expect(screen.getByTestId('host')).toBeTruthy();
  });

  it('AC4 · the SUBSTRATE costs no round trip — it arrives as a prop', async () => {
    // The window that used to eject this project now opens it, and the thing it
    // NAMES must not cost a read on mount: the layout already had the project.
    //
    // ⚠️ THE ROUTING DISPATCH IS A DIFFERENT REQUEST AND A DIFFERENT CARD
    // (MOTIR-4769). It is not the substrate being re-read; it is the planner
    // being asked a question, which is the whole reason this surface is on
    // screen. What AC4 forbids is a SECOND read of what was already handed over.
    fetchPlanningAnchor.mockClear();
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});

    expect(fetchPlanningAnchor).not.toHaveBeenCalled();
    expect(screen.getByTestId('planning-reading-state')).toBeTruthy();
  });

  it('AC2 · the THIN substrate still renders it — a sentence, not an empty list', async () => {
    // This is the project most likely to be routed away seconds later, so the
    // sentence it shows is the last thing the user reads before they move.
    openAt('plan=project&planFrom=project');
    mount({ substrate: thin });
    await act(async () => {});

    expect(screen.getByTestId('planning-reading-state')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Having a look at your project' })).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('it renders in place of the workspace, and still navigates NOWHERE', async () => {
    // The reading state replaces what the canvas would show; it does not sit
    // beside a half-drawn workspace. And it changes nothing about MOTIR-4765:
    // no push, from any state of this prop.
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});

    expect(screen.queryByTestId('host')).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('an ANCHORED launch shows the reading state without waiting on the anchor read', async () => {
    // A never-onboarded project has no plan to anchor to and nothing on the
    // canvas to scope, so waiting on `fetchPlanningAnchor` would put a skeleton
    // in front of the one moment the user most needs a sentence.
    openAt('plan=item&planFrom=work-item&planItem=ACME-7');
    mount({ substrate: rich });
    await act(async () => {});

    expect(screen.getByTestId('planning-reading-state')).toBeTruthy();
  });
});

describe('THE WAIT — an unindexed repository holds the window (MOTIR-4829)', () => {
  const unindexed = {
    itemCount: 12,
    itemCountTruncated: false,
    repositories: [{ ref: 'acme/widgets', indexed: false }],
    repositoryConnected: true,
    repositoryIndexed: false,
  } satisfies OnboardingSubstrate;

  const waitVerdict = {
    kind: 'verdict' as const,
    read: {
      ok: true as const,
      verdict: {
        outcome: 'wait_for_index',
        message: "I'm building the index for acme/widgets now — we can start as soon as it's done.",
      },
    },
  };

  it('shows BOTH the banner and the planner’s turn — and NOT the hand-off', async () => {
    // ⚠️ NOBODY IS ROUTED. `wait_for_index` has no destination, so the hand-off
    // (which exists to move somebody) must not be what they meet.
    resolveOnboardingRouting.mockResolvedValue(waitVerdict);
    openAt('plan=project&planFrom=project');
    mount({ substrate: unindexed });
    await act(async () => {});

    expect(screen.getByTestId('planning-indexing-banner')).toBeTruthy();
    expect(screen.getByTestId('planning-indexing-turn')).toBeTruthy();
    expect(screen.queryByTestId('planning-handoff')).toBeNull();
    expect(screen.queryByTestId('host')).toBeNull();
    // …and nothing has moved.
    expect(push).not.toHaveBeenCalled();
  });

  it('names the UNINDEXED repository, not every connected one', async () => {
    resolveOnboardingRouting.mockResolvedValue(waitVerdict);
    openAt('plan=project&planFrom=project');
    mount({
      substrate: {
        ...unindexed,
        repositories: [
          { ref: 'acme/widgets', indexed: false },
          { ref: 'acme/already-read', indexed: true },
        ],
      },
    });
    await act(async () => {});

    const banner = screen.getByTestId('planning-indexing-banner');
    expect(banner.textContent).toContain('acme/widgets');
    // The one that HAS a graph is not something anybody is waiting for.
    expect(banner.textContent).not.toContain('acme/already-read');
  });

  it('THE FINISH — when the graph lands the window ASKS AGAIN rather than deciding', async () => {
    // ⚠️ THE WAIT ENDING IS NOT A VERDICT. The graph exists now; whether it is
    // ENOUGH is the same judgement as before and it is still the planner's
    // (MOTIR-4828). So the window re-fires the routing run rather than opening
    // the workspace on its own authority.
    //
    // ⚠️ AND THE INSTRUMENT IS A POLL BECAUSE `router.refresh()` CANNOT REACH AN
    // ISLAND (`CLAUDE.md` § page state after a mutation, case 3). This drives the
    // seam the island asks through, which is the only thing standing between the
    // wait and the rest of the journey.
    vi.useFakeTimers();
    try {
      resolveOnboardingRouting.mockResolvedValueOnce(waitVerdict).mockResolvedValue({
        kind: 'verdict' as const,
        read: {
          ok: true as const,
          verdict: { outcome: 'continue', message: 'What shall we plan?' },
        },
      });
      // First tick: still nothing. Second: the index has landed.
      fetchPlanningSubstrate.mockResolvedValueOnce(unindexed).mockResolvedValue({
        ...unindexed,
        repositories: [{ ref: 'acme/widgets', indexed: true }],
      });

      openAt('plan=project&planFrom=project');
      mount({ substrate: unindexed });
      await act(async () => {});
      expect(screen.getByTestId('planning-indexing-banner')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUBSTRATE_POLL_INTERVAL_MS * 2 + 10);
      });

      // The wait is over, the verdict was asked a SECOND time, and this project
      // is now plannable — so the workspace opens.
      expect(resolveOnboardingRouting.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.queryByTestId('planning-indexing-banner')).toBeNull();
      expect(screen.getByTestId('host')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the ROUTING VERDICT is HONOURED (MOTIR-4769)', () => {
  const rich = {
    itemCount: 214,
    itemCountTruncated: false,
    repositories: [{ ref: 'acme/widgets', indexed: true }],
    repositoryConnected: true,
    repositoryIndexed: true,
  } satisfies OnboardingSubstrate;

  const verdict = (over: Record<string, unknown> = {}) => ({
    kind: 'verdict' as const,
    read: {
      ok: true as const,
      verdict: { outcome: 'continue', message: 'What shall we plan?', ...over },
    },
  });

  it('`continue` clears the reading state and opens the WORKSPACE — nothing was planned', async () => {
    // The outcome that draws nothing. A regular session waits to be told what to
    // plan, so there is no interstitial to celebrate it with.
    resolveOnboardingRouting.mockResolvedValue(verdict());
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});

    expect(screen.queryByTestId('planning-reading-state')).toBeNull();
    expect(screen.queryByTestId('planning-handoff')).toBeNull();
    expect(screen.getByTestId('host')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('`onboard_new_project` SHOWS the hand-off — it does not redirect out from under them', async () => {
    resolveOnboardingRouting.mockResolvedValue(
      verdict({ outcome: 'onboard_new_project', message: "Let's set your project up first." }),
    );
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});

    const panel = screen.getByTestId('planning-handoff');
    expect(panel.getAttribute('data-outcome')).toBe('onboard_new_project');
    // The planner's own turn is what the user reads.
    expect(screen.getByText("Let's set your project up first.")).toBeTruthy();
    // ⚠️ AND NOTHING HAS MOVED YET. The user presses the button.
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByTestId('host')).toBeNull();
  });

  it('`onboard_existing_project` renders the planner’s missing-list and the kept steps', async () => {
    resolveOnboardingRouting.mockResolvedValue(
      verdict({
        outcome: 'onboard_existing_project',
        message: 'A couple of things first.',
        keptSteps: ['connect', 'discovery'],
        missing: ['The repository is still mostly the starter template.'],
      }),
    );
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});

    expect(screen.getByTestId('planning-handoff').getAttribute('data-outcome')).toBe(
      'onboard_existing_project',
    );
    // Every word of it is the planner's; this surface renders it and writes none.
    expect(screen.getByText('The repository is still mostly the starter template.')).toBeTruthy();
    // What will be asked, and what is already there — the apology this route owes.
    // The wizard no longer walks the questions step (MOTIR-8783), whatever the
    // verdict kept, so the strip must not promise it.
    expect(screen.queryByText('A few questions')).toBeNull();
    expect(screen.getByText('Import work items')).toBeTruthy();
    // The FOUND block names what was read, from the substrate already in hand.
    expect(screen.getByText(/acme\/widgets/)).toBeTruthy();
  });

  it('the move carries the KEPT STEPS and the return address (AC2 · AC6a)', async () => {
    resolveOnboardingRouting.mockResolvedValue(
      verdict({
        outcome: 'onboard_existing_project',
        message: 'A couple of things first.',
        keptSteps: ['connect', 'discovery'],
        missing: [],
      }),
    );
    openAt('plan=item&planFrom=work-item&planItem=ACME-7');
    mount({ substrate: rich });
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fill in the gaps' }));
    });

    const href = push.mock.calls.at(-1)?.[0] as string;
    expect(href.startsWith('/onboarding/migrate?')).toBe(true);
    const q = new URLSearchParams(href.split('?')[1]);
    expect(q.get('via')).toBe('onboard_existing_project');
    expect(q.get('steps')).toBe('connect,discovery');
    // ⚠️ THE RETURN ADDRESS. The move leaves the route group entirely, so
    // MOTIR-4770 has nothing to work with unless it travels here.
    expect(q.get('backKind')).toBe('work-item');
    expect(q.get('backItem')).toBe('ACME-7');
  });

  it('`onboard_new_project` goes to the start-fresh entrance', async () => {
    resolveOnboardingRouting.mockResolvedValue(
      verdict({ outcome: 'onboard_new_project', message: 'm' }),
    );
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up my project' }));
    });
    const href = push.mock.calls.at(-1)?.[0] as string;
    expect(href.startsWith('/onboarding?')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('backKind')).toBe('project');
  });

  it('NOT NOW closes the window instead — a hand-off is not a wall', async () => {
    resolveOnboardingRouting.mockResolvedValue(
      verdict({ outcome: 'onboard_new_project', message: 'm' }),
    );
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    });
    // Closed by writing the address, not by navigating — the page underneath
    // must not unmount.
    expect(push).not.toHaveBeenCalled();
    expect(shallowPush).toHaveBeenCalledWith(
      withoutPlanningOverlay(`/backlog?plan=project&planFrom=project`),
    );
  });

  it('a MALFORMED verdict takes the safe route with Motir’s OWN copy', async () => {
    // Declining a malformed answer is not disagreeing with a well-formed one.
    // The copy is Motir's, deliberately: writing a sentence in the planner's
    // voice about a project it did not read is the thing to avoid.
    resolveOnboardingRouting.mockResolvedValue({
      kind: 'verdict',
      read: { ok: false, outcome: 'onboard_new_project', reason: 'unknown outcome: onboard' },
    });
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});

    expect(screen.getByTestId('planning-handoff').getAttribute('data-outcome')).toBe(
      'onboard_new_project',
    );
    // Motir's own refusal copy, not the heading it happens to echo.
    expect(
      screen.getByText(/A few short questions about what you're building and who it's for/),
    ).toBeTruthy();
  });

  it.each([
    ['a failed run', { kind: 'none' as const, reason: 'job failed' }],
    ['a timeout', { kind: 'none' as const, reason: 'timed out' }],
    ['a dead request', { kind: 'none' as const, reason: 'dispatch failed' }],
  ])('%s opens the WORKSPACE and moves nobody', async (_what, resolution) => {
    // None of these is a finding about the project, and turning one into a
    // hand-off would move a user on the strength of a network error.
    resolveOnboardingRouting.mockResolvedValue(resolution);
    openAt('plan=project&planFrom=project');
    mount({ substrate: rich });
    await act(async () => {});

    expect(screen.getByTestId('host')).toBeTruthy();
    expect(screen.queryByTestId('planning-handoff')).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('AC6 · ONE dispatch per open — a re-render is not a new question', async () => {
    resolveOnboardingRouting.mockResolvedValue(verdict());
    openAt('plan=project&planFrom=project');
    const view = mount({ substrate: rich });
    await act(async () => {});
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={rich} />,
    );
    await act(async () => {});

    expect(resolveOnboardingRouting).toHaveBeenCalledTimes(1);
  });

  it('MOTIR-9414 · a re-render MID-ASK asks again, and applies exactly one verdict', async () => {
    // A route refresh hands the overlay a NEW `substrate` object while the first
    // ask is in flight, and the effect's cleanup aborts that ask. The guard used
    // to stay set, so nothing asked again and the window read "Reading your
    // project" for good. The aborted ask answers LATE here, with a hand-off, to
    // prove a dead ask's answer is never applied either.
    let answerFirst: (r: unknown) => void = () => {};
    const signals: AbortSignal[] = [];
    resolveOnboardingRouting
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        return new Promise((resolve) => (answerFirst = resolve));
      })
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        return Promise.resolve(verdict());
      });
    openAt('plan=project&planFrom=project');
    const view = mount({ substrate: rich });
    await act(async () => {});
    expect(screen.getByTestId('planning-reading-state')).toBeTruthy();

    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={{ ...rich }} />,
    );
    await act(async () => {});
    await act(async () => answerFirst(verdict({ outcome: 'onboard_new_project' })));

    expect(signals[0]?.aborted).toBe(true);
    expect(resolveOnboardingRouting).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('planning-reading-state')).toBeNull();
    expect(screen.queryByTestId('planning-handoff')).toBeNull();
    expect(screen.getByTestId('host')).toBeTruthy();

    // And once it HAS answered, a further re-render is not a new question.
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="ACME" projectName="Acme" substrate={{ ...rich }} />,
    );
    await act(async () => {});
    expect(resolveOnboardingRouting).toHaveBeenCalledTimes(2);
  });

  it('an ESTABLISHED project is never asked at all', async () => {
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});
    expect(resolveOnboardingRouting).not.toHaveBeenCalled();
  });
});

describe('THE ROUND TRIP closes (MOTIR-4770)', () => {
  const rich = {
    itemCount: 214,
    itemCountTruncated: false,
    repositories: [{ ref: 'acme/widgets', indexed: true }],
    repositoryConnected: true,
    repositoryIndexed: true,
  } satisfies OnboardingSubstrate;

  it('AC6 · a RETURNING user is not read and routed again', async () => {
    // They were routed thirty seconds ago and have just done what they were sent
    // to do. Reading them again — and possibly routing them again — is the loop
    // the return marker exists to prevent.
    openAt('plan=project&planFrom=project&planReturned=1');
    mount({ substrate: rich });
    await act(async () => {});

    expect(resolveOnboardingRouting).not.toHaveBeenCalled();
    expect(screen.queryByTestId('planning-reading-state')).toBeNull();
    expect(screen.getByTestId('host')).toBeTruthy();
  });

  it('AC8 · the return is ACKNOWLEDGED, and the flag reaches the rail', async () => {
    openAt('plan=project&planFrom=project&planReturned=1');
    mount({ substrate: rich });
    await act(async () => {});
    // The host is the surface that owns the conversation, so the flag is what
    // travels; the line itself is `PlanChangeRail`'s and is asserted there.
    expect(screen.getByTestId('host').getAttribute('data-just-returned')).toBe('true');
  });

  it('an ordinary open carries NO acknowledgement — nothing was completed', async () => {
    openAt('plan=project&planFrom=project');
    mount();
    await act(async () => {});
    expect(screen.getByTestId('host').getAttribute('data-just-returned')).toBeNull();
  });

  it('the marker alone does NOT open a workspace', async () => {
    // It says *you have just come back*, not *the workspace is open*.
    openAt('planReturned=1');
    mount({ substrate: rich });
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
