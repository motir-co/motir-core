// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { withPlanningOverlay } from '@/lib/planning/launcher';

// EVERY DOOR OPENS THE OVERLAY IN PLACE (MOTIR-4730, under story MOTIR-4725).
//
// The doors already shared one resolver, and they still do. What this file holds
// in place is the three properties that changed underneath them, each of which
// fails silently:
//
//   · a plain click writes the CURRENT address plus the overlay's parameters,
//     shallowly — the page underneath must not re-render;
//   · a MODIFIED click is left alone, so ⌘-click / middle-click / *Open in new
//     tab* still work and now produce the cold deep link;
//   · the host page's own query survives the merge — which is what makes the
//     roadmap's drilled level and the quick view outlive a planning session.

let pathname = '/backlog';
let searchParams = new URLSearchParams();
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
  useRouter: () => ({ push, refresh }),
}));

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { PlanWithAILauncher } = await import('@/components/planning/PlanWithAILauncher');
const { WorkItemPlanEntrance } = await import('@/components/planning/WorkItemPlanEntrance');
const { useOpenPlanningWorkspace } = await import('@/lib/hooks/useOpenPlanningWorkspace');

beforeEach(() => {
  pathname = '/backlog';
  searchParams = new URLSearchParams();
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
});
afterEach(cleanup);

function pill() {
  return screen.getByRole('link', { name: 'Plan with AI' });
}

function itemPill() {
  return screen.getByTestId('work-item-plan-entrance');
}

/** The per-item door, in the state that makes it a `Plan` (not `Re-plan`). */
function renderItemPill(itemKey = 'MOTIR-12') {
  return renderWithIntl(
    <WorkItemPlanEntrance
      itemKey={itemKey}
      hasChildren={false}
      kind="subtask"
      hasDescription={false}
      canPlan
      archived={false}
      statusCategory="todo"
    />,
  );
}

describe('the header pill', () => {
  it('carries the CURRENT address plus the overlay parameters', () => {
    pathname = '/backlog';
    searchParams = new URLSearchParams('filter=type%3Acode&sort=rank');
    renderWithIntl(<PlanWithAILauncher context={{ kind: 'project' }} />);

    const href = pill().getAttribute('href');
    expect(href).toBe(
      withPlanningOverlay('/backlog?filter=type%3Acode&sort=rank', { kind: 'project' }),
    );
    // The host page's own query is untouched — that is what the reader comes
    // back to.
    expect(href).toContain('filter=type%3Acode');
    expect(href).toContain('sort=rank');
    // …and it is no longer a destination.
    expect(href).not.toContain('/planning');
  });

  it('opens IN PLACE on a plain click, and never navigates', () => {
    renderWithIntl(<PlanWithAILauncher context={{ kind: 'project' }} />);

    fireEvent.click(pill(), { button: 0 });

    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush.mock.calls[0]![0]).toBe('/backlog?plan=project&planFrom=project');
    // `router.push` would re-render the page the overlay is about to sit on.
    expect(push).not.toHaveBeenCalled();
  });

  it('leaves a MODIFIED click to the browser', () => {
    renderWithIntl(<PlanWithAILauncher context={{ kind: 'project' }} />);

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      fireEvent.click(pill(), { button: 0, ...modifier });
    }
    // Middle click, too — it arrives as a click with button 1.
    fireEvent.click(pill(), { button: 1 });

    expect(shallowPush).not.toHaveBeenCalled();
  });

  it("keeps the roadmap's drilled level", () => {
    pathname = '/roadmap';
    searchParams = new URLSearchParams('item=MOTIR-12');
    renderWithIntl(<PlanWithAILauncher context={{ kind: 'roadmap' }} />);

    const href = pill().getAttribute('href');
    expect(href).toContain('item=MOTIR-12');
    expect(href).toContain('plan=roadmap');
    expect(href).toContain('planFrom=roadmap');
  });

  it('carries the mode the context resolves to, not a fixed one', () => {
    // The `/plans` empty-state door passes `hasPlan: false`, which is what makes
    // it a generation entrance rather than the coarse project one.
    renderWithIntl(<PlanWithAILauncher context={{ kind: 'project', hasPlan: false }} />);
    expect(pill().getAttribute('href')).toContain('plan=generation');
  });

  it('adds NO pending affordance — there is nothing to wait for', () => {
    renderWithIntl(<PlanWithAILauncher context={{ kind: 'project' }} />);
    fireEvent.click(pill(), { button: 0 });

    // The visual half of the `shallowPush` rule (`design/shell/design-notes.md`
    // § THE SWITCH RULE): no spinner, no disabled state, no aria-busy.
    const link = pill();
    expect(link.getAttribute('aria-disabled')).toBeNull();
    expect(link.getAttribute('aria-busy')).toBeNull();
    expect(link.querySelector('[role="status"]')).toBeNull();
  });
});

describe('the per-item Plan / Re-plan pill', () => {
  it('carries the anchor in the overlay address', () => {
    renderItemPill('MOTIR-12');

    const href = itemPill().getAttribute('href');
    expect(href).toContain('plan=contextual');
    expect(href).toContain('planFrom=work-item');
    expect(href).toContain('planItem=MOTIR-12');
  });

  it('opens in place, and does not navigate', () => {
    renderItemPill('MOTIR-12');

    fireEvent.click(itemPill(), { button: 0 });

    expect(shallowPush).toHaveBeenCalledWith(
      // `planAsk=1` (MOTIR-10624): this button opens on the start prompt.
      '/backlog?plan=contextual&planFrom=work-item&planItem=MOTIR-12&planAsk=1',
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('KEEPS the quick view open behind it — the design decided this case', () => {
    // ⚠️ THE DECISION, named here so a later change is deliberate: the workspace
    // opens ABOVE the `?peek=` quick view and the peek STAYS in the address, so
    // closing the workspace returns the reader to the peek they launched from.
    // (`design/ai-chat/design-notes.md` § *Opening & exiting* → *LAUNCHED FROM
    // INSIDE THE QUICK VIEW*.) The peek is NOT dismissed on open — the entrance
    // no longer receives the quick view's close.
    pathname = '/items';
    searchParams = new URLSearchParams('peek=MOTIR-12');
    renderItemPill('MOTIR-12');

    expect(itemPill().getAttribute('href')).toBe(
      '/items?peek=MOTIR-12&plan=contextual&planFrom=work-item&planItem=MOTIR-12&planAsk=1',
    );

    fireEvent.click(itemPill(), { button: 0 });
    expect(shallowPush.mock.calls[0]![0]).toContain('peek=MOTIR-12');
  });

  it('still fires `onActivate` for a host that has something to do first', () => {
    const onActivate = vi.fn();
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-12"
        hasChildren={false}
        kind="subtask"
        hasDescription={false}
        canPlan
        archived={false}
        statusCategory="todo"
        onActivate={onActivate}
      />,
    );

    fireEvent.click(itemPill(), { button: 0 });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledTimes(1);
  });

  it('wears the RE-PLAN face and its mode when the item already has children', () => {
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-12"
        hasChildren
        kind="story"
        hasDescription
        canPlan
        archived={false}
        statusCategory="todo"
      />,
    );
    expect(itemPill().getAttribute('href')).toContain('plan=replan');
  });

  it('is not drawn at all for an actor who may not plan — the hook does not change that', () => {
    renderWithIntl(
      <WorkItemPlanEntrance
        itemKey="MOTIR-12"
        hasChildren={false}
        kind="subtask"
        hasDescription={false}
        canPlan={false}
        archived={false}
        statusCategory="todo"
      />,
    );
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });
});

describe('the doors resolve through ONE module', () => {
  it('no app source builds a planning path of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { execSync } = await import('node:child_process');

    // The card's own acceptance criterion, as a test: the only remaining
    // reference to the route-era builder is its deprecated definition.
    const hits = execSync("git grep -n 'planningWorkspaceHref(' -- app components lib || true", {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      // Its own definition, and the prose that explains the retirement.
      .filter((line) => !line.startsWith('lib/planning/launcher.ts:'))
      .filter((line) => !/^\S+:\d+:\s*(\/\/|\*|--)/.test(line));

    expect(hits, `still building a route-era href:\n${hits.join('\n')}`).toEqual([]);

    // …and the registry stayed framework-free, which is why the href is passed
    // in rather than resolved there.
    const registry = readFileSync(join(process.cwd(), 'lib/planning/aiCallout.ts'), 'utf8');
    expect(registry).not.toMatch(/from ['"]react/);
    expect(registry).not.toMatch(/from ['"]next\//);
  });
});

describe('coverage · the opener called WITHOUT a click event', () => {
  it('opens in place — the ⌘K path, which has no anchor to intercept', () => {
    // The palette closes itself and then calls `open()` with no argument: there
    // is no link and no default to prevent, so the handler must still write the
    // address. This arm is only reached from a keyboard action.
    const seen: string[] = [];
    function Probe() {
      const { open } = useOpenPlanningWorkspace({ kind: 'project' });
      return (
        <button
          type="button"
          onClick={() => {
            open();
            seen.push('called');
          }}
        >
          ⌘K Plan with AI
        </button>
      );
    }

    renderWithIntl(<Probe />);
    fireEvent.click(screen.getByRole('button', { name: '⌘K Plan with AI' }));

    expect(seen).toEqual(['called']);
    expect(shallowPush).toHaveBeenCalledWith('/backlog?plan=project&planFrom=project');
  });
});

describe('coverage · a named session reopened from an entrance (MOTIR-6024 · MOTIR-6037)', () => {
  type Ctx = Parameters<typeof useOpenPlanningWorkspace>[0];

  function Probe({ context }: { context: Ctx }) {
    const { href } = useOpenPlanningWorkspace(context);
    return <a href={href}>reopen</a>;
  }

  function hrefOf() {
    return screen.getByRole('link', { name: 'reopen' }).getAttribute('href');
  }

  it('re-derives the address when ONLY the entrance changes — `planVia` is part of the key', () => {
    // The memo is keyed on the context's VALUE; a key that left `via` out would hand
    // back the Plans-page address for a session reopened from To approve.
    const { rerender } = renderWithIntl(
      <Probe context={{ kind: 'project', hasPlan: true, sessionId: 'sess-1' }} />,
    );
    const plain = hrefOf();
    expect(plain).toBe(
      withPlanningOverlay('/backlog', { kind: 'project', hasPlan: true, sessionId: 'sess-1' }),
    );
    expect(plain).toContain('planSession=sess-1');
    expect(plain).not.toContain('planVia');

    rerender(
      <Probe context={{ kind: 'project', hasPlan: true, sessionId: 'sess-1', via: 'approvals' }} />,
    );
    expect(hrefOf()).toContain('planSession=sess-1');
    expect(hrefOf()).toContain('planVia=approvals');
  });

  it('a card’s session carries its key, its session and its entrance', () => {
    const context: Ctx = {
      kind: 'work-item',
      itemKey: 'MOTIR-12',
      hasPlan: false,
      sessionId: 'sess-2',
      via: 'approvals',
    };
    renderWithIntl(<Probe context={context} />);
    expect(hrefOf()).toBe(withPlanningOverlay('/backlog', context));
    expect(hrefOf()).toContain('planVia=approvals');
  });

  it('an explicitly EMPTY session or entrance reads as none', () => {
    const context: Ctx = { kind: 'project', sessionId: undefined, via: undefined };
    renderWithIntl(<Probe context={context} />);
    expect(hrefOf()).toBe('/backlog?plan=project&planFrom=project');
  });
});

describe('coverage · a refused gate’s seeded launch (MOTIR-6210 · MOTIR-6212)', () => {
  function Probe({ gateId }: { gateId: string }) {
    const { href } = useOpenPlanningWorkspace({ kind: 'refused-gate', gateId });
    return <a href={href}>re-plan</a>;
  }

  it('re-derives the address when ONLY the gate changes — `planGate` is part of the key', () => {
    // Two refusals on one page: a key that left the gate out would hand the second
    // door the first gate's address, and seed the planner from the wrong refusal.
    const { rerender } = renderWithIntl(<Probe gateId="gate-1" />);
    const link = () => screen.getByRole('link', { name: 're-plan' }).getAttribute('href');
    expect(link()).toBe(
      withPlanningOverlay('/backlog', { kind: 'refused-gate', gateId: 'gate-1' }),
    );
    expect(link()).toContain('planGate=gate-1');

    rerender(<Probe gateId="gate-2" />);
    expect(link()).toContain('planGate=gate-2');
    expect(link()).not.toContain('gate-1');
  });
});
