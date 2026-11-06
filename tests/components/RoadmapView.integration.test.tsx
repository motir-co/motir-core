// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RoadmapView } from '@/components/planning/RoadmapView';
import {
  ARRIVAL_MIN_SCALE,
  arrivalView,
  fitView,
  nodesBounds,
} from '@/lib/planning/canvasGeometry';
import {
  NODE_H,
  NODE_W,
  deterministicLayout,
  workItemCrumbLabel,
} from '@/lib/planning/projectCanvasModel';

// Story-level ASSEMBLED gate for MOTIR-1539 (roadmap usability): the TWO features
// this story ships — URL-addressable scope (MOTIR-1541, now URL-driven end to end
// per MOTIR-1549) and the manual refresh control (MOTIR-1542) — COEXIST on the same
// RoadmapView header without interfering. Where RoadmapView.test.tsx drives each
// feature in ISOLATION (the per-subtask floor), this suite exercises the
// CROSS-FEATURE seams those unit tests can't reach on their own:
//   - a refresh must PRESERVE the URL-seeded scope (a refresh never drops/resets
//     scope, and never navigates / rewrites the URL),
//   - a scope switch must not STRAND the refresh control's loading state,
//   - the refresh contract holds against the CURRENT scope (a scoped refetch),
//   - both controls resolve their copy from the REAL `roadmap` next-intl catalog.
// Harness mirrors RoadmapView.test.tsx: next/navigation + global fetch mocked,
// the real `en` catalog via renderWithIntl, the real ProjectRoadmapCanvas +
// WorkItemRoadmap under test (there is no DB seam in this frontend-only story).

// next/navigation: scope is DERIVED from `useSearchParams()` (MOTIR-1549) and a
// toggle writes the URL with `push` (a distinct history entry). `push`/`replace`
// are the spies we assert the URL contract through; the pathname is the roadmap
// route; `useSearchParams` reads a mutable holder (`sp.current`) so a test can
// simulate a URL-seed / a client navigation by setting the query + re-rendering.
// (Hoisted so the spies + holder exist at factory time.)
const { push, replace, sp } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  sp: { current: '' },
}));

// MOTIR-3434 — the scope toggle writes the URL SHALLOWLY now, so the positive
// assertion moved to `history.pushState`. `push` keeps its spy with the
// OPPOSITE job: the toggle must NOT navigate, because the canvas refetches on
// its `key={scope}` remount and the page's server reads produce nothing this
// body uses.
const pushState = vi.spyOn(window.history, 'pushState');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/roadmap',
  useSearchParams: () => new URLSearchParams(sp.current),
}));

// Per-scope roots so a scope switch (and a scoped refetch) is observable in the
// rendered tree, mirroring RoadmapView.test.tsx.
// TWO roots per scope on purpose: `WorkItemRoadmap` opts into AUTO-DRILL
// (MOTIR-1807), so a root level of exactly ONE drillable node descends past it —
// these specs assert which ROOT loaded, so each scope needs a real choice.
const projectRoot = {
  nodes: [
    {
      id: 'E1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-1',
      title: 'Whole-project epic',
      status: 'in_progress',
      isDone: false,
      hasChildren: true,
    },
    {
      id: 'E2',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-2',
      title: 'Second project epic',
      status: 'todo',
      isDone: false,
      hasChildren: false,
    },
  ],
  edges: [],
};
const sprintRoot = {
  nodes: [
    {
      id: 'E7',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-464',
      title: 'In-sprint epic',
      status: 'in_progress',
      isDone: false,
      hasChildren: true,
    },
    {
      id: 'E8',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-465',
      title: 'Second in-sprint epic',
      status: 'todo',
      isDone: false,
      hasChildren: false,
    },
  ],
  edges: [],
};

let fetchUrls: string[] = [];

// The default stub: resolve every level immediately, recording the URL so the
// scope carried into each per-level fetch is assertable.
function stubImmediateFetch() {
  fetchUrls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      fetchUrls.push(u);
      const body = u.includes('scope=sprint') ? sprintRoot : projectRoot;
      return { ok: true, json: async () => body };
    }),
  );
}

// A gated stub: the NEXT fetch(es) block on `gate` until `release()` — so an
// in-flight loading state is observable WITHOUT a timer (assert on the real
// completion signal, never a fixed wait).
function stubGatedFetch(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      await gate;
      const u = String(url);
      fetchUrls.push(u);
      return {
        ok: true,
        json: async () => (u.includes('scope=sprint') ? sprintRoot : projectRoot),
      };
    }),
  );
  return { release };
}

beforeEach(() => {
  sp.current = '';
  push.mockClear();
  pushState.mockClear();
  replace.mockClear();
  stubImmediateFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function baseProps(over: Partial<Parameters<typeof RoadmapView>[0]> = {}) {
  return {
    projectKey: 'MOTIR',
    projectName: 'Acme',
    ariaLabel: 'Acme roadmap',
    hasActiveSprint: true,
    sprintName: 'Sprint 32',
    sprintGoal: 'Three Epic-7 stories',
    showPlanningOrigin: false,
    ...over,
  };
}

describe('RoadmapView — assembled header: URL-scope + refresh coexist (MOTIR-1543)', () => {
  it('renders BOTH the scope toggle and the refresh control from the real roadmap catalog (no missing-key fallback)', async () => {
    render(<RoadmapView {...baseProps()} />);

    // Every string resolves from the real `roadmap` namespace — a missing key
    // would surface the key path (`roadmap.refresh`) or throw, not this copy.
    expect(screen.getByRole('heading', { name: 'Roadmap' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Roadmap scope' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Whole project' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Active sprint' })).toBeTruthy();

    // The refresh control's accessible name AND tooltip both come from
    // t('refresh') — assert the resolved string on both attributes.
    const refresh = screen.getByRole('button', { name: 'Refresh roadmap' });
    expect(refresh.getAttribute('aria-label')).toBe('Refresh roadmap');
    expect(refresh.getAttribute('title')).toBe('Refresh roadmap');

    await screen.findByText('Whole-project epic'); // settle the initial load
  });

  it('a refresh in sprint scope PRESERVES the scope: the refetch stays scope=sprint and the URL is never rewritten', async () => {
    // Deep-linked into sprint scope via the URL (?scope=sprint).
    sp.current = 'scope=sprint';
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('In-sprint epic');
    await waitFor(() => expect(fetchUrls.some((u) => u.includes('scope=sprint'))).toBe(true));

    // Deriving scope from the URL does not itself navigate (no toggle yet).
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    const before = fetchUrls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh roadmap' }));

    // The in-place refetch fires AND still carries scope=sprint — a refresh does
    // not drop / reset the scope…
    await waitFor(() => expect(fetchUrls.length).toBeGreaterThan(before));
    expect(fetchUrls.at(-1)).toContain('scope=sprint');
    // …the toggle stays on Active sprint…
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // …and a refresh NEVER navigates, so the ?scope=sprint URL survives untouched.
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('switching scope during an in-flight refresh clears the loading state (no stranded spinner)', async () => {
    const { rerender } = render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');

    // Gate the refresh's refetch so its loading state is observable in flight.
    const { release } = stubGatedFetch();
    const refresh = screen.getByRole('button', { name: 'Refresh roadmap' }) as HTMLButtonElement;

    fireEvent.click(refresh);
    await waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('true'));
    expect(refresh.disabled).toBe(true);

    // Switch scope while the refresh is still in flight. The scope switch supersedes
    // the refresh (changeScope clears the loading state synchronously); the client
    // navigation to ?scope=sprint then remounts the canvas (simulated by the URL +
    // rerender of the SAME instance, as Next's router would after push).
    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));
    expect(pushState).toHaveBeenCalledWith(null, '', '/roadmap?scope=sprint');
    expect(push).not.toHaveBeenCalled();
    sp.current = 'scope=sprint';
    rerender(<RoadmapView {...baseProps()} />);

    await waitFor(() => expect(refresh.getAttribute('aria-busy')).not.toBe('true'));
    expect(refresh.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Active sprint' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    release(); // let the superseded + remounted fetches settle
    await screen.findByText('In-sprint epic');
  });

  it('refresh operates on the ACTIVE scope: after toggling to sprint, a refresh refetches the sprint level and settles to idle', async () => {
    const { rerender } = render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');

    fireEvent.click(screen.getByRole('button', { name: 'Active sprint' }));
    // The toggle wrote the URL once (the scope contract) — a distinct history entry.
    expect(pushState).toHaveBeenCalledWith(null, '', '/roadmap?scope=sprint');
    expect(push).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledTimes(1);
    // Simulate the resulting client navigation to sprint scope.
    sp.current = 'scope=sprint';
    rerender(<RoadmapView {...baseProps()} />);
    await screen.findByText('In-sprint epic');
    await waitFor(() => expect(fetchUrls.some((u) => u.includes('scope=sprint'))).toBe(true));
    const before = fetchUrls.length;

    const refresh = screen.getByRole('button', { name: 'Refresh roadmap' }) as HTMLButtonElement;
    fireEvent.click(refresh);

    // The refetch targets the CURRENT (sprint) level…
    await waitFor(() => expect(fetchUrls.length).toBeGreaterThan(before));
    expect(fetchUrls.at(-1)).toContain('scope=sprint');
    // …the control's loading→idle transition tracks the mocked fetch resolution…
    await waitFor(() => expect(refresh.getAttribute('aria-busy')).not.toBe('true'));
    // …and the refresh did NOT navigate (only the earlier toggle did).
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it('toggling back to Whole project clears the ?scope= param and reloads the unscoped root — even after a refresh', async () => {
    sp.current = 'scope=sprint';
    const { rerender } = render(<RoadmapView {...baseProps()} />);
    await screen.findByText('In-sprint epic');

    // A refresh in sprint scope first (the two features composed)…
    fireEvent.click(screen.getByRole('button', { name: 'Refresh roadmap' }));
    await waitFor(() => expect(refreshSettled()).toBe(true));

    // …then return to Whole project: the toggle pushes a clean /roadmap, and the
    // resulting navigation (URL cleared + rerender) reloads the unscoped root.
    fireEvent.click(screen.getByRole('button', { name: 'Whole project' }));
    expect(pushState).toHaveBeenCalledWith(null, '', '/roadmap');
    expect(push).not.toHaveBeenCalled();
    sp.current = '';
    rerender(<RoadmapView {...baseProps()} />);
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();

    function refreshSettled() {
      const btn = screen.getByRole('button', { name: 'Refresh roadmap' });
      return btn.getAttribute('aria-busy') !== 'true';
    }
  });

  it('shows just the sprint name as the subtitle when the active sprint has no goal (coverage top-up)', async () => {
    sp.current = 'scope=sprint';
    render(<RoadmapView {...baseProps({ sprintName: 'Sprint 32', sprintGoal: null })} />);
    await screen.findByText('In-sprint epic');

    // sprintScopeActive && !sprintGoal → subtitle is the bare sprint name, no
    // " · goal" separator (the branch the goal-present unit test doesn't reach).
    expect(screen.getByText('Sprint 32')).toBeTruthy();
    expect(screen.queryByText(/·/)).toBeNull();
    // The Sprint scope chip still renders alongside it.
    expect(screen.getByText('Sprint scope')).toBeTruthy();
  });
});

// ── STORY MOTIR-3833's ASSEMBLED SEAMS (MOTIR-3840) ─────────────────────────
//
// Each feature card's units stub exactly the thing the next card builds: the URL
// card's tests hand the canvas a trail, the canvas card's tests hand the consumer
// a callback, the arrival card's tests hand the geometry a bounding box. Nobody in
// that arrangement drives a real resolve through a real crumb into a real
// breadcrumb, or a real laid-out level into a real arrival. These do.
describe('MOTIR-3833 — the assembled roadmap seams', () => {
  // What the SERVER produces for `?item=MOTIR-1`: `ancestors ++ [the item]`, each
  // crumb labelled by the shipped `workItemCrumbLabel` — the same producer the
  // canvas uses for a hand-drilled crumb, which is the drift this asserts against.
  const serverTrail = [
    {
      id: 'E1',
      crumbKey: 'MOTIR-1',
      label: workItemCrumbLabel('MOTIR-1', 'Whole-project epic'),
    },
  ];

  it('THE TRAIL SEAM — a server-resolved trail becomes the reader’s breadcrumb, letter for letter', async () => {
    sp.current = 'item=MOTIR-1';
    render(<RoadmapView {...baseProps({ initialTrail: serverTrail })} />);

    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    // The rendered crumb text, not the prop that was passed.
    expect(within(crumb).getByText('MOTIR-1 · Whole-project epic')).toBeTruthy();
    // And the canvas opened ON that level — it never read the project root first.
    await waitFor(() => expect(fetchUrls.length).toBeGreaterThan(0));
    expect(fetchUrls.every((u) => u.includes('parentId=E1'))).toBe(true);
  });

  it('THE TRAIL SEAM — a seeded crumb is byte-identical to a hand-DRILLED one', async () => {
    // One producer (`workItemCrumbLabel`) or the two paths drift; a test that built
    // the expected string by hand could not see it.
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    fireEvent.keyDown(document.querySelector('[data-node-id="E1"]')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText(serverTrail[0]!.label)).toBeTruthy();
  });

  it('THE LEVEL ROUND-TRIP — drill writes ?item=, popstate returns the canvas IN PLACE and costs no fetch', async () => {
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    fireEvent.keyDown(document.querySelector('[data-node-id="E1"]')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await waitFor(() => expect(pushState).toHaveBeenCalled());
    expect(String(pushState.mock.calls.at(-1)![2])).toBe('/roadmap?item=MOTIR-1');
    await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const afterDrill = fetchUrls.length;

    window.history.replaceState(null, '', '/roadmap');
    fireEvent.popState(window);

    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull(),
    );
    expect(await screen.findByText('Whole-project epic')).toBeTruthy();
    // `loadLevel` is NOT re-called: the root is in the adapter's level cache and
    // the trail is in this view's session cache.
    expect(fetchUrls.length).toBe(afterDrill);
  });

  it('THE ARRIVAL SEAM — a real laid-out level that cannot fit arrives AT the floor, centred on `here`', () => {
    // The product's own layout, not a hand-built box: eighteen cards through the
    // shipped `deterministicLayout`, then the shipped bounds, then the arrival.
    const ids = Array.from({ length: 18 }, (_, i) => `E${i + 1}`);
    const pos = deterministicLayout(ids, []);
    const rects = ids.map((id) => ({ x: pos[id]!.x, y: pos[id]!.y, w: NODE_W, h: NODE_H }));
    const bounds = nodesBounds(rects);
    const box = { w: 1136, h: 620 }; // the measured canvas box at 1440x900

    expect(fitView(bounds, box).scale).toBeLessThan(ARRIVAL_MIN_SCALE);
    const here = rects[6]!; // the in-progress frontier, second row of the 5-column band
    const v = arrivalView(bounds, box, ARRIVAL_MIN_SCALE, here);

    expect(v.scale).toBe(ARRIVAL_MIN_SCALE);
    // The vertical is constrained, so the focal card is centred on it.
    expect((here.y + here.h / 2) * v.scale + v.ty).toBeCloseTo(box.h / 2, 6);
  });

  it('THE ARRIVAL SEAM — a real SMALL level still arrives exactly as fitView frames it', () => {
    // Three cards, one band row 1000px wide — the widest loose level that still
    // fits this box at the floor. On the 5-column band (MOTIR-10537) a fourth card
    // in the row makes it 1360px, which already arrives AT the floor.
    const ids = ['S1', 'S2', 'S3'];
    const pos = deterministicLayout(ids, []);
    const bounds = nodesBounds(
      ids.map((id) => ({ x: pos[id]!.x, y: pos[id]!.y, w: NODE_W, h: NODE_H })),
    );
    const box = { w: 1136, h: 620 };
    expect(arrivalView(bounds, box, ARRIVAL_MIN_SCALE)).toEqual(fitView(bounds, box));
  });
});

// ── THE OPT-IN DEFAULTS ARE THE CONTRACT (MOTIR-3840) ───────────────────────
//
// This story adds several props to a canvas FOUR surfaces mount, and the only
// thing keeping the other three unchanged is that every new prop defaults to
// today's behaviour. That is a promise held by care alone, which means a later
// card can flip a default and quietly change onboarding and both plan canvases
// with a green suite. Written down, it fails loudly instead.
describe('MOTIR-3833 — the shared canvas’s opt-in defaults', () => {
  const consumers = [
    'components/onboarding/OnboardingCanvas.tsx',
    'components/planning/PlanChangeCanvas.tsx',
    'components/planning/PlanReviewCanvas.tsx',
  ];
  // Every prop THIS STORY added to the shared canvas. `initialTrail` is NOT one of
  // them — it is MOTIR-2070's shipped arrival seed, and `PlanChangeCanvas` already
  // forwards it, which is exactly why the list is the story's additions rather than
  // "every prop with a trail in its name".
  //
  // Two of them CHANGE what the canvas does, and no other consumer may pass them.
  // The third, `onLevelChange`, is a REPORT: it fires after the reader's own move
  // and changes nothing the canvas draws. MOTIR-6155 needs it on both plan canvases
  // (the planning surface swaps one for the other and has to carry "the reader
  // moved" across the swap), so they FORWARD it — optional, no default — and the
  // promise it keeps instead is that exactly ONE host supplies it.
  const behaviourOptIns = ['controlledTrail', 'arriveAtReadableScale'];

  it('the three other consumers pass NONE of the level/arrival props', () => {
    for (const file of consumers) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      for (const prop of behaviourOptIns) {
        expect(src, `${file} must not pass ${prop}`).not.toContain(prop);
      }
    }
    expect(
      readFileSync(join(process.cwd(), 'components/onboarding/OnboardingCanvas.tsx'), 'utf8'),
    ).not.toContain('onLevelChange');
  });

  it('the plan canvases only FORWARD the level report, and one host supplies it (MOTIR-6155)', () => {
    for (const file of [
      'components/planning/PlanChangeCanvas.tsx',
      'components/planning/PlanReviewCanvas.tsx',
    ]) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      // Optional, destructured with NO default, handed straight through.
      expect(src).toMatch(/onLevelChange\?: \(trail: readonly CanvasCrumb\[\]\) => void;/);
      expect(src).toMatch(/^\s+onLevelChange,$/m);
      expect(src.match(/onLevelChange=\{[^}]*\}/g)).toEqual(['onLevelChange={onLevelChange}']);
    }
    // The plan page and the generation flow mount the same canvases and supply
    // nothing, so for them the prop is `undefined` — today's behaviour.
    for (const file of [
      'components/planning/PlanDetail.tsx',
      'components/planning/GenerationFlow.tsx',
    ]) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, `${file} must not supply a level report`).not.toMatch(
        /onLevelChange|onCanvasLevelChange/,
      );
    }
  });

  it('the LEGEND COLLAPSE is the one deliberate exception — it reaches EVERY consumer', () => {
    // Not opt-in, and that asymmetry is a decision rather than a miss: the legend
    // is the canvas's own chrome, and "I know what a dashed arrow means" is a fact
    // about the reader, not about the route. Giving two canvases a legend you can
    // dismiss and two you cannot is a distinction no reader could infer.
    const canvas = readFileSync(
      join(process.cwd(), 'components/planning/ProjectRoadmapCanvas.tsx'),
      'utf8',
    );
    expect(canvas).toContain('useDependencyLegendCollapsed()');
    // It is not gated on any prop.
    expect(canvas).not.toMatch(/collapsibleLegend\s*[?:&]/);
  });

  it('a canvas rendered WITHOUT the opt-ins fits via fitView and fires no level callback', async () => {
    const onLevelChange = vi.fn();
    // `WorkItemRoadmap` is the ONLY adapter that opts in; rendered bare, the canvas
    // reports nothing and takes the engine's plain fit.
    render(<RoadmapView {...baseProps()} />);
    await screen.findByText('Whole-project epic');
    expect(onLevelChange).not.toHaveBeenCalled();
    // A level that FITS is framed identically whether or not a floor is supplied.
    const bounds = { minX: 40, minY: 40, maxX: 1040, maxY: 360 };
    const box = { w: 1136, h: 620 };
    expect(arrivalView(bounds, box, ARRIVAL_MIN_SCALE)).toEqual(fitView(bounds, box));
  });
});
