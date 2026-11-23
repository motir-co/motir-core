// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';

// ⚠️ THE PLANNING DOORS READ THE ADDRESS (MOTIR-4730). Every surface that mounts
// one — and this tree mounts one — now calls `usePathname` / `useSearchParams`,
// because the workspace opens OVER the page you are on rather than navigating to
// `/planning`. Outside a router context the real hooks return `null` and the
// door throws on its first render, so the mock is no longer optional here.
const nav = vi.hoisted(() => ({
  pathname: '/dashboard',
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
}));

// WorkItemRoadmap mounts the work-item quick-view peek (MOTIR-1352), whose body
// reuses the shipped IssueQuickViewPanel (useTranslations) — so the tree needs a
// NextIntl provider (renderWithIntl). The peek is LOCAL-state-driven (no `?peek`),
// so no next/navigation mock is required.

// A condensed peek payload the /api/work-items/peek read returns for MOTIR-1.
const PEEK = {
  folderId: null,
  folderPath: [],
  identifier: 'MOTIR-1',
  title: 'Epic one',
  kind: 'epic',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  descriptionMd: 'The first epic.',
  type: null,
  executor: null,
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  parent: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  hasChildren: false,
  canPlan: true,
  // MOTIR-2562 widened the payload with the editor inputs. They ride the same
  // read, so a stub that omits them is not a leaner fixture — it is a payload
  // the route can never return, and the rail dereferences `estimation`.
  id: 'cmqvroadmap00000000000e1',
  projectIdentifier: 'MOTIR',
  workItemRefs: {},
  archived: null,
  status: 'in_progress',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points',
    pointScale: 'fibonacci',
    customScaleValues: [],
    canEdit: true,
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The per-level roadmap endpoint, served from a tiny in-memory tree:
//   roots → [Epic one (drillable), Epic two (leaf)];  E1's children → [Story one (leaf)].
// TWO roots on purpose: this adapter opts into AUTO-DRILL (MOTIR-1807), so a root
// level of exactly ONE drillable node would descend past it and these tests — which
// are all about acting on the ROOT level by hand — would have nothing to act on. A
// level with a real choice is also the shape the auto-descend must leave untouched.
const root = {
  nodes: [
    {
      id: 'E1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-1',
      title: 'Epic one',
      status: 'in_progress',
      isDone: false,
      hasChildren: true,
    },
    {
      id: 'E2',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-3',
      title: 'Epic two',
      status: 'todo',
      isDone: false,
      hasChildren: false,
    },
  ],
  edges: [],
};
const e1Children = {
  nodes: [
    {
      id: 'S1',
      parentId: 'E1',
      kind: 'story',
      identifier: 'MOTIR-2',
      title: 'Story one',
      status: 'done',
      isDone: true,
      hasChildren: false,
    },
  ],
  edges: [],
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
      if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
      return { ok: true, json: async () => root };
    }),
  );
});

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

describe('WorkItemRoadmap', () => {
  it('selects a node, then drills via its Open affordance, fetching its children', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    expect(await screen.findByText('Epic one')).toBeTruthy();
    fireEvent.keyDown(el('E1')!, { key: 'Enter' }); // select (no drill yet)
    expect(el('S1')).toBeNull();
    fireEvent.click(await screen.findByTestId('drill-button')); // Open → drill
    expect(await screen.findByText('Story one')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy(); // S1 status pill
  });

  it('selecting a leaf calls onSelect and offers no drill affordance', async () => {
    const onSelect = vi.fn();
    render(<WorkItemRoadmap projectKey="MOTIR" onSelect={onSelect} />);
    await screen.findByText('Epic one');
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button')); // drill into E1
    await screen.findByText('Story one');
    fireEvent.keyDown(el('S1')!, { key: 'Enter' }); // S1 is a leaf → just selects
    expect(onSelect).toHaveBeenCalledWith('S1');
    expect(screen.queryByTestId('drill-button')).toBeNull(); // a leaf can't drill
  });

  it('opens the work-item quick-view peek from the selected card View button (MOTIR-1352)', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    // No peek until a card is selected and View is clicked.
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(el('E1')!, { key: 'Enter' }); // select
    fireEvent.click(await screen.findByTestId('view-button')); // View → opens the peek
    // The peek modal opens and streams the item in from /api/work-items/peek.
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe(
        '/items/MOTIR-1',
      ),
    );
    // Closing via the header × dismisses the peek (local state, no URL).
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers the search overlay', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    expect(screen.getByPlaceholderText('Search the roadmap')).toBeTruthy();
  });

  // The onboarding-ran gate (Subtask 7.4 / MOTIR-1264): the planning-origin
  // cluster (MOTIR-1013) is pinned at the ROOT level ONLY for a project that
  // actually onboarded — the caller passes `showPlanningOrigin` from the
  // project's immutable onboarding-ran marker.
  it('pins the planning-origin cluster at the root when showPlanningOrigin is set', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
    await screen.findByText('Epic one');
    expect(screen.getByTestId('planning-origin')).toBeTruthy();
    expect(el('__planning_origin__')).not.toBeNull();
  });

  it('omits the planning-origin cluster for a never-onboarded project (default off)', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('planning-origin')).toBeNull();
    expect(el('__planning_origin__')).toBeNull();
  });

  // The cluster is the WHOLE-PROJECT road's origin: it says where the project's
  // tree came from. The sprint slice (MOTIR-1382) is a window onto the sprint's
  // committed work, so the project's planning journey does not belong on it —
  // even for an onboarded project whose caller passes `showPlanningOrigin`.
  it('omits the planning-origin cluster in SPRINT scope even when showPlanningOrigin is set', async () => {
    render(<WorkItemRoadmap projectKey="MOTIR" scope="sprint" showPlanningOrigin />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('planning-origin')).toBeNull();
    expect(el('__planning_origin__')).toBeNull();
  });

  it('renders the cross-story signal: a ghost anchor + a flagged node for an off-level blocker', async () => {
    // A level where T1 is blocked_by X, and X is NOT in the level → off-level.
    const crossLevel = {
      nodes: [
        {
          id: 'T1',
          parentId: null,
          // An EPIC, so it stays on the road under MOTIR-3490's root grouping —
          // this fixture's subject is the cross-story anchor, not the root's kind
          // composition. (It was a parentless `subtask`, which the kind-parent
          // trigger refuses at the root anyway: `prisma/sql/work_item_triggers.sql`
          // admits only epic/story/task/bug there.)
          kind: 'epic',
          identifier: 'MOTIR-5',
          title: 'Wire it',
          status: 'todo',
          isDone: false,
          hasChildren: false,
        },
      ],
      edges: [{ blockedId: 'T1', blockerId: 'X9' }],
      offLevelBlockers: [
        {
          id: 'X9',
          identifier: 'MOTIR-42',
          title: 'Migrate tokens',
          parentTitle: 'Auth hardening',
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => crossLevel })),
    );
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    // the blocked node carries the cross-story flag — its blocked TAB (MOTIR-12158)…
    expect(await screen.findByTestId('blocked-tab')).toBeTruthy();
    // …and the off-level blocker is anchored by a named ghost node.
    expect(screen.getByText('MOTIR-42')).toBeTruthy();
    expect(screen.getByText('in Auth hardening ↗')).toBeTruthy();
    expect(document.querySelector('[data-node-id="X9"]')).not.toBeNull();
  });

  it('peeks the off-level blocker from its ghost anchor View button (MOTIR-1586)', async () => {
    // T1 is blocked_by X9 (off-level). X9's ghost anchor is now a viewable,
    // peekable card: selecting it shows the View button (a bare click only selects,
    // like every card), and View opens the WorkItemQuickView for the BLOCKER,
    // resolved by its identifier (MOTIR-42).
    const crossLevel = {
      nodes: [
        {
          id: 'T1',
          parentId: null,
          // An EPIC, so it stays on the road under MOTIR-3490's root grouping —
          // this fixture's subject is the cross-story anchor, not the root's kind
          // composition. (It was a parentless `subtask`, which the kind-parent
          // trigger refuses at the root anyway: `prisma/sql/work_item_triggers.sql`
          // admits only epic/story/task/bug there.)
          kind: 'epic',
          identifier: 'MOTIR-5',
          title: 'Wire it',
          status: 'todo',
          isDone: false,
          hasChildren: false,
        },
      ],
      edges: [{ blockedId: 'T1', blockerId: 'X9' }],
      offLevelBlockers: [
        {
          id: 'X9',
          identifier: 'MOTIR-42',
          title: 'Migrate tokens',
          parentTitle: 'Auth hardening',
        },
      ],
    };
    // The peek read resolves the BLOCKER by its identifier (MOTIR-42), not T1.
    const PEEK42 = { ...PEEK, identifier: 'MOTIR-42', title: 'Migrate tokens' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK42 };
        return { ok: true, json: async () => crossLevel };
      }),
    );
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    expect(await screen.findByText('MOTIR-42')).toBeTruthy(); // the ghost anchor
    expect(screen.queryByRole('dialog')).toBeNull(); // nothing peeked yet
    // Selecting the anchor surfaces the View affordance but does NOT open the peek
    // (a bare click only selects, exactly like every other card — AC #1).
    fireEvent.keyDown(el('X9')!, { key: 'Enter' });
    expect(await screen.findByTestId('view-button')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Clicking View opens the peek and streams the BLOCKER in by its identifier.
    fireEvent.click(screen.getByTestId('view-button'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe(
        '/items/MOTIR-42',
      ),
    );
  });
  // ── SUBTREE ROOT (MOTIR-2287) ─────────────────────────────────────────────
  // The adapter's ROOT level can be one work item's children instead of the
  // project's roots. Opt-in: absent, every assertion above still holds.

  describe('subtreeRootId', () => {
    it('roots the first level at the item: level 0 reads that item, a drill reads the child', async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          calls.push(u);
          if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => root };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" />);
      await screen.findByText('Epic one');
      // The canvas asked for its ROOT level; the adapter asked the API for P9's
      // children — never the project roots (`parentId=` with no value).
      const levelCalls = calls.filter((u) => u.includes('/roadmap'));
      expect(levelCalls.length).toBe(1);
      expect(levelCalls[0]).toContain('parentId=P9');
      // A drill from that level is unchanged — it carries the drilled node's id.
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      expect(await screen.findByText('Story one')).toBeTruthy();
      expect(calls.some((u) => u.includes('parentId=E1'))).toBe(true);
    });

    it('never pins the planning-origin cluster, even when showPlanningOrigin is set', async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          calls.push(String(url));
          return { ok: true, json: async () => root };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" showPlanningOrigin />);
      await screen.findByText('Epic one');
      expect(screen.queryByTestId('planning-origin')).toBeNull();
      expect(el('__planning_origin__')).toBeNull();
      // …and the pre-plan read that feeds its badge is never fired.
      expect(calls.some((u) => u.includes('preplan'))).toBe(false);
    });

    it('does NOT auto-descend a single drillable child (MOTIR-1807 opted out)', async () => {
      // ONE drillable node at the level. Unrooted, the adapter descends past it
      // (that is MOTIR-1807). Rooted, it must show the item's only child AS the
      // level — descending would be showing a different item's children.
      const onlyChild = { nodes: [root.nodes[0]], edges: [] };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => onlyChild };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" />);
      expect(await screen.findByText('Epic one')).toBeTruthy();
      expect(el('E1')).not.toBeNull();
      expect(screen.queryByText('Story one')).toBeNull(); // no silent descent
    });

    it('unrooted, the same single-drillable level DOES auto-descend (the opt-out is the root)', async () => {
      const onlyChild = { nodes: [root.nodes[0]], edges: [] };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => onlyChild };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" />);
      expect(await screen.findByText('Story one')).toBeTruthy();
    });

    it("labels the breadcrumb root with the caller's label once drilled", async () => {
      render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" rootLabel="MOTIR-2284" />);
      await screen.findByText('Epic one');
      fireEvent.keyDown(el('E1')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Story one');
      const crumbs = screen.getByLabelText('Breadcrumb');
      expect(crumbs.textContent).toContain('MOTIR-2284');
      expect(crumbs.textContent).not.toContain('Roadmap'); // not the project default
    });

    it('keys the level cache by root, so a rooted and an unrooted mount cannot share a root level', async () => {
      const rootedLevel = {
        nodes: [
          {
            id: 'C1',
            parentId: 'P9',
            kind: 'subtask',
            identifier: 'MOTIR-77',
            title: 'Rooted child',
            status: 'todo',
            isDone: false,
            hasChildren: false,
          },
        ],
        edges: [],
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('parentId=P9')) return { ok: true, json: async () => rootedLevel };
          return { ok: true, json: async () => root };
        }),
      );
      const rooted = render(<WorkItemRoadmap projectKey="MOTIR" subtreeRootId="P9" />);
      expect(await screen.findByText('Rooted child')).toBeTruthy();
      rooted.unmount();
      render(<WorkItemRoadmap projectKey="MOTIR" />);
      // The unrooted mount reads the PROJECT roots — it must not be served the
      // rooted mount's cached level (a per-mount ref, plus a root-keyed entry).
      expect(await screen.findByText('Epic one')).toBeTruthy();
      expect(screen.queryByText('Rooted child')).toBeNull();
    });
  });

  // ── the paths the story gate (MOTIR-2289) found uncovered ────────────────
  // These are pre-existing behaviours of the adapter that no suite exercised;
  // the story puts this file under the per-file coverage gate, so they are
  // asserted rather than left as an untested branch.

  describe('the planning-origin DOOR + the manual refresh', () => {
    const PREPLAN = {
      docs: [{ kind: 'discovery' }, { kind: 'vision' }],
    };

    function stubWithPreplan() {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('/api/ai/pre-plan')) return { ok: true, json: async () => PREPLAN };
          if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => root };
        }),
      );
    }

    it('drills the phase card into a SYNTHETIC pre-plan station level (no roadmap read)', async () => {
      stubWithPreplan();
      render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
      await screen.findByText('Epic one');
      // The badge's read has landed, so the card reports what the journey produced.
      await screen.findByText('2 of 4 docs');
      fireEvent.keyDown(el('__planning_origin__')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      // The stations are built from the pre-plan read, not from a roadmap level —
      // no work item backs them, so asking the API for ORIGIN_ID's children would
      // be a request for an id it has never heard of.
      expect(await screen.findByText('Understanding your project')).toBeTruthy();
      const calls = (
        globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('__planning_origin__'))).toBe(false);
    });

    it('opens the tier doc from a produced station’s View, and closes it', async () => {
      stubWithPreplan();
      render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
      await screen.findByText('Epic one');
      await screen.findByText('2 of 4 docs');
      fireEvent.keyDown(el('__planning_origin__')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      await screen.findByText('Understanding your project');
      // A produced station is `viewable`, so the canvas's own View button surfaces
      // on it — and the adapter routes a TIER id to the doc modal rather than to
      // the work-item peek (work-item ids are cuids and never a tier kind).
      fireEvent.keyDown(el('discovery')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('view-button'));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('a FAILED pre-plan read leaves the card chip-less and the level upcoming', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('/api/ai/pre-plan')) throw new Error('offline');
          if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
          return { ok: true, json: async () => root };
        }),
      );
      render(<WorkItemRoadmap projectKey="MOTIR" showPlanningOrigin />);
      await screen.findByText('Epic one');
      // `null` is the honest "we do not know": no chip, never an error on the
      // roadmap, and the card still paints (the read never blocks first paint).
      expect(screen.getByTestId('planning-origin')).toBeTruthy();
      expect(screen.queryByTestId('planning-origin-chip')).toBeNull();
      // The drilled level still renders — its four stations, all `upcoming`.
      fireEvent.keyDown(el('__planning_origin__')!, { key: 'Enter' });
      fireEvent.click(await screen.findByTestId('drill-button'));
      expect(await screen.findByText('Understanding your project')).toBeTruthy();
    });

    it('a refreshSignal bump refetches the CURRENT level in place and settles', async () => {
      const onRefreshSettled = vi.fn();
      const fetchSpy = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('parentId=E1')) return { ok: true, json: async () => e1Children };
        return { ok: true, json: async () => root };
      });
      vi.stubGlobal('fetch', fetchSpy);
      const view = render(
        <WorkItemRoadmap
          projectKey="MOTIR"
          refreshSignal={0}
          onRefreshSettled={onRefreshSettled}
        />,
      );
      await screen.findByText('Epic one');
      const before = fetchSpy.mock.calls.length;
      expect(onRefreshSettled).not.toHaveBeenCalled(); // an initial load never settles
      view.rerender(
        <WorkItemRoadmap
          projectKey="MOTIR"
          refreshSignal={1}
          onRefreshSettled={onRefreshSettled}
        />,
      );
      await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(before));
      // The refresh drops the cache and re-reads — and reports settled on the real
      // fetch-completion signal, which is what lets a caller clear its spinner
      // without a timer.
      await waitFor(() => expect(onRefreshSettled).toHaveBeenCalled());
      expect(await screen.findByText('Epic one')).toBeTruthy(); // same level, in place
    });
  });
});

// ── MOTIR-3490 · the ROOT level's non-epic rows ──────────────────────────────
// The roadmap's root read selects on `parentId IS NULL` and nothing else, so a
// parentless bug/task/story drew on the road beside the epics; and the read is
// capped at 200 key-ascending, so overflow dropped the NEWEST epics silently.
// Design: `design/roadmap/root-non-epic-rows.*` (MOTIR-3493).
describe('the root level groups its NON-EPIC rows (MOTIR-3490)', () => {
  const epic = (id: string, key: string, title: string) => ({
    id,
    parentId: null,
    kind: 'epic',
    identifier: key,
    title,
    status: 'in_progress',
    isDone: false,
    hasChildren: true,
  });
  const looseRow = (id: string, key: string, title: string, kind: string) => ({
    id,
    parentId: null,
    kind,
    identifier: key,
    title,
    status: 'todo',
    isDone: false,
    hasChildren: false,
  });

  // Two epics on the road; a parentless bug AND a parentless task beside them.
  const mixedRoot = {
    nodes: [
      epic('E1', 'MOTIR-1', 'Epic one'),
      looseRow('B9', 'MOTIR-9', 'A parentless defect', 'bug'),
      looseRow('T7', 'MOTIR-7', 'A parentless task', 'task'),
      epic('E2', 'MOTIR-2', 'Epic two'),
    ],
    edges: [],
    offLevelBlockers: [],
    levelTotal: 4,
  };

  function stubRoot(body: unknown, extra?: (u: string) => unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
        const hit = extra?.(u);
        if (hit) return { ok: true, json: async () => hit };
        return { ok: true, json: async () => body };
      }),
    );
  }

  it('draws no bug or task node beside the epics — they collapse into one grouped node', async () => {
    stubRoot(mixedRoot);
    render(<WorkItemRoadmap projectKey="MOTIR" />);

    // The epics stay on the road.
    expect(await screen.findByText('Epic one')).toBeTruthy();
    expect(screen.getByText('Epic two')).toBeTruthy();

    // Neither non-epic row is a sibling of them any more — this is AC 1.
    expect(screen.queryByText('A parentless defect')).toBeNull();
    expect(screen.queryByText('A parentless task')).toBeNull();

    // Exactly one grouped node, carrying the COUNT of what it holds.
    const group = screen.getByTestId('level-group-node');
    expect(within(group).getByText('Not in an epic')).toBeTruthy();
    expect(within(group).getByText('2 items')).toBeTruthy();
  });

  it('the grouped node drills in, revealing its rows with their own treatment (AC 2)', async () => {
    stubRoot(mixedRoot);
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');

    fireEvent.keyDown(el('__not_in_an_epic__')!, { key: 'Enter' }); // select
    fireEvent.click(await screen.findByTestId('drill-button')); // Open → drill

    // Both grouped rows are behind the door, as ordinary work-item nodes.
    expect(await screen.findByText('A parentless defect')).toBeTruthy();
    expect(screen.getByText('A parentless task')).toBeTruthy();
    // And the epics are not — we are one level down.
    expect(screen.queryByText('Epic one')).toBeNull();
  });

  it('serves the drilled level from the ALREADY-FETCHED root read — no second request', async () => {
    stubRoot(mixedRoot);
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    fireEvent.keyDown(el('__not_in_an_epic__')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('A parentless defect');

    // The rows were in the root read; grouping only decided where to draw them.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  // ── THE REFRESH INSIDE THE DOOR (bug MOTIR-4426) ───────────────────────────
  // The two tests above pin the door's two halves as MOTIR-3490 shipped them: the
  // level opens, and it opens WITHOUT a second request. Together they say the level
  // is served from the cached root read — which is also the whole defect, because
  // the manual refresh (MOTIR-1542) clears that cache at the top of the very
  // callback that reads it back.
  //
  // ⚠️ THE RE-RENDER IS THE TEST. A fresh mount at `refreshSignal={1}` passes on the
  // UNFIXED code — it loads the root first, so the cache is warm by the time the
  // door is opened — and a guard that cannot go red is not evidence. So the refresh
  // is delivered to the SAME mounted component, standing INSIDE the group, which is
  // where the reader was.
  it('a refresh INSIDE the grouped level re-reads it — never "No items at this level"', async () => {
    stubRoot(mixedRoot);
    const view = render(<WorkItemRoadmap projectKey="MOTIR" refreshSignal={0} />);
    await screen.findByText('Epic one');

    fireEvent.keyDown(el('__not_in_an_epic__')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    expect(await screen.findByText('A parentless defect')).toBeTruthy();

    // The reader presses the header's Refresh while standing on the grouped level.
    view.rerender(<WorkItemRoadmap projectKey="MOTIR" refreshSignal={1} />);

    // The rows come back. Asserted on the EMPTY-STATE COPY as well as on the rows,
    // because the copy is what the reader actually saw: `emptyDrilled` is an
    // assertion that the level has nothing on it, and it was false.
    await waitFor(() => expect(screen.queryByText('No items at this level')).toBeNull());
    expect(await screen.findByText('A parentless defect')).toBeTruthy();
    expect(screen.getByText('A parentless task')).toBeTruthy();
  });

  it('that refresh is a real RE-READ, and it settles the caller', async () => {
    stubRoot(mixedRoot);
    const onRefreshSettled = vi.fn();
    const view = render(
      <WorkItemRoadmap projectKey="MOTIR" refreshSignal={0} onRefreshSettled={onRefreshSettled} />,
    );
    await screen.findByText('Epic one');
    fireEvent.keyDown(el('__not_in_an_epic__')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('A parentless defect');
    const roadmapCalls = () =>
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
        String(c[0]).includes('/roadmap'),
      ).length;
    const before = roadmapCalls();
    expect(onRefreshSettled).not.toHaveBeenCalled(); // an initial load never settles

    view.rerender(
      <WorkItemRoadmap projectKey="MOTIR" refreshSignal={1} onRefreshSettled={onRefreshSettled} />,
    );

    // A REAL fetch, not a cache entry the refresh was excused from clearing —
    // otherwise the control would report having refreshed rows it had not re-read.
    await waitFor(() => expect(roadmapCalls()).toBeGreaterThan(before));
    // And the header's spinner clears on that fetch completing, exactly as it does
    // on a real level: the synthetic branch now awaits, and `loadLevel`'s `finally`
    // is what reports it.
    await waitFor(() => expect(onRefreshSettled).toHaveBeenCalled());
  });

  it('a grouped row stays PEEKABLE after that refresh — the re-read rows are registered', async () => {
    stubRoot(mixedRoot);
    const view = render(<WorkItemRoadmap projectKey="MOTIR" refreshSignal={0} />);
    await screen.findByText('Epic one');
    fireEvent.keyDown(el('__not_in_an_epic__')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('A parentless defect');

    view.rerender(<WorkItemRoadmap projectKey="MOTIR" refreshSignal={1} />);
    await waitFor(() => expect(screen.queryByText('No items at this level')).toBeNull());

    // View resolves the peek key off the id -> identifier map `registerItems` fills;
    // an UNREGISTERED id resolves to nothing and `onView` opens nothing at all
    // (`useWorkItemQuickView.onView`). The root load filled that map before the
    // refresh; the grouped branch now fills it too, so this level no longer depends
    // on a load it did not make. The PEEK REQUEST is the assertion, because it
    // carries the identifier the id resolved TO — the harness serves one canned peek
    // body for every key, so the rendered peek cannot tell us which row was asked for.
    fireEvent.keyDown(el('B9')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('view-button'));
    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
          String(c[0]).includes('/api/work-items/peek?key=MOTIR-9'),
        ),
      ).toBe(true),
    );
  });

  it('a single grouped row reads "1 item", not "1 items"', async () => {
    stubRoot({ ...mixedRoot, nodes: [epic('E1', 'MOTIR-1', 'Epic one'), mixedRoot.nodes[1]] });
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    expect(within(screen.getByTestId('level-group-node')).getByText('1 item')).toBeTruthy();
  });

  // The degenerate case the design's predicate assumed away, and which the shipped
  // auto-drill suite already encoded: when EVERY row would group there is no road
  // left to keep clear, so grouping would replace the whole roadmap with one grey
  // box and put an extra hop in front of what used to be the first thing on screen.
  it('does NOT group when the partition would take the WHOLE level', async () => {
    stubRoot({
      nodes: [
        looseRow('S1', 'MOTIR-1', 'A parentless story', 'story'),
        looseRow('B9', 'MOTIR-9', 'A parentless defect', 'bug'),
      ],
      edges: [],
      offLevelBlockers: [],
      levelTotal: 2,
    });
    render(<WorkItemRoadmap projectKey="MOTIR" />);

    expect(await screen.findByText('A parentless story')).toBeTruthy();
    expect(screen.getByText('A parentless defect')).toBeTruthy();
    expect(screen.queryByTestId('level-group-node')).toBeNull();
  });

  it('leaves a level with no non-epic root untouched — no grouped node at all', async () => {
    stubRoot({ ...mixedRoot, nodes: [epic('E1', 'MOTIR-1', 'Epic one')] });
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    expect(screen.queryByTestId('level-group-node')).toBeNull();
  });

  // SPRINT SCOPE — the conjunct MOTIR-3490 did not anticipate (design decision 6).
  // The sprint read re-roots the level at the topmost IN-SPRINT members, which are
  // usually stories and subtasks. Grouping on `kind !== 'epic'` alone would have
  // swept the sprint's own work into one node.
  it('groups a committed parentless defect but NOT a re-rooted member story (AC 5)', async () => {
    stubRoot({
      nodes: [
        // A root of the SPRINT VIEW only: it has a parent (an epic the sprint did
        // not commit to), so it is the sprint's actual work and stays on the road.
        {
          id: 'S5',
          parentId: 'E1',
          kind: 'story',
          identifier: 'MOTIR-5',
          title: 'A committed member story',
          status: 'in_progress',
          isDone: false,
          hasChildren: true,
        },
        // A root of the TREE: parentless, non-epic → grouped.
        looseRow('B9', 'MOTIR-9', 'A committed parentless defect', 'bug'),
      ],
      edges: [],
      offLevelBlockers: [],
      levelTotal: 2,
    });
    render(<WorkItemRoadmap projectKey="MOTIR" scope="sprint" />);

    expect(await screen.findByText('A committed member story')).toBeTruthy();
    expect(screen.queryByText('A committed parentless defect')).toBeNull();
    expect(within(screen.getByTestId('level-group-node')).getByText('1 item')).toBeTruthy();
  });

  it('keeps the dependency signal when an on-road epic is blocked by a grouped row', async () => {
    stubRoot({
      ...mixedRoot,
      // E1 is blocked_by the parentless defect, which the partition just moved
      // off-level. The flag must survive the move.
      edges: [{ blockedId: 'E1', blockerId: 'B9' }],
    });
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');
    expect(screen.getByTestId('blocked-tab')).toBeTruthy();
    // The ghost anchor NAMES the grouped blocker rather than showing an anonymous
    // chip — the row was in hand, so its stub is built from it.
    expect(screen.getByText('MOTIR-9')).toBeTruthy();
  });

  // ── MOTIR-3557 · the two faces of the un-scoped edge list ──────────────────
  // The test directly above is the case that MUST keep working: the blocked end
  // (an on-road epic) is still on the level, so the anchor is right. These two
  // are the cases where it is NOT, and both shipped.

  it('draws no anchor at the root when BOTH ends of an edge were grouped', async () => {
    stubRoot({
      ...mixedRoot,
      // The shipped instance: MOTIR-3490 `blocked_by` MOTIR-3493, both parentless,
      // both grouped. The blocker minted a red "blocked elsewhere" card beside the
      // epics for a row sitting one hop inside the group — and its arrow pointed
      // at a node the canvas does not draw, so nothing was attached to it.
      edges: [{ blockedId: 'T7', blockerId: 'B9' }],
    });
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');

    expect(screen.queryByText('MOTIR-9')).toBeNull();
    expect(screen.queryByTestId('blocked-tab')).toBeNull();
    // The road is the two epics and the door — nothing else.
    expect(screen.queryByText('A parentless defect')).toBeNull();
    expect(screen.getByTestId('level-group-node')).toBeTruthy();
  });

  it('the grouped level draws none of the ROOT EPICS as "blocked elsewhere" ghosts', async () => {
    // The reported defect. The root's edge list is the edges of the whole root
    // level, so handing it to the synthetic grouped level made every root epic an
    // off-level blocker of a level it has nothing to do with — 12 of them on
    // Motir's own tree — each drawn as an ANONYMOUS anchor, because an epic is ON
    // the root level and so is never in `offLevelBlockers` to be named from.
    stubRoot({
      ...mixedRoot,
      edges: [
        { blockedId: 'E2', blockerId: 'E1' }, // the epic roadmap's own chain
        { blockedId: 'T7', blockerId: 'B9' }, // the one edge the group owns
      ],
    });
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic one');

    fireEvent.keyDown(el('__not_in_an_epic__')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await screen.findByText('A parentless defect');

    // No anchor at all — and in particular not the anonymous one, whose identifier
    // is an em dash over the "Blocked across stories" fallback.
    expect(screen.queryByText('Blocked across stories')).toBeNull();
    expect(screen.queryByText('MOTIR-1')).toBeNull();
    expect(screen.queryByText('MOTIR-2')).toBeNull();
    expect(screen.queryByTestId('blocked-tab')).toBeNull();
    // The edge the level DOES own is drawn, between its own two rows.
    expect(screen.getByText('A parentless task')).toBeTruthy();
  });
});

describe('a truncated level says so (MOTIR-3490 · AC 3)', () => {
  const manyRoots = {
    nodes: Array.from({ length: 3 }, (_, i) => ({
      id: `E${i}`,
      parentId: null,
      kind: 'epic',
      identifier: `MOTIR-${i}`,
      title: `Epic ${i}`,
      status: 'todo',
      isDone: false,
      hasChildren: true,
    })),
    edges: [],
    offLevelBlockers: [],
    // The read returned 3 of 250 — the cap dropped the rest, silently until now.
    levelTotal: 250,
  };

  it('draws the "+ N more" tile with an honest Showing N of M', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/work-items/peek'))
          return { ok: true, json: async () => PEEK };
        return { ok: true, json: async () => manyRoots };
      }),
    );
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    const tile = await screen.findByTestId('level-truncation-tile');
    expect(within(tile).getByText('+ 247 more')).toBeTruthy();
    expect(within(tile).getByText('Showing 3 of 250')).toBeTruthy();
    expect(within(tile).getByText('Show all')).toBeTruthy();
  });

  it('renders NO tile when the level came back whole', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/work-items/peek'))
          return { ok: true, json: async () => PEEK };
        return { ok: true, json: async () => ({ ...manyRoots, levelTotal: 3 }) };
      }),
    );
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    await screen.findByText('Epic 0');
    expect(screen.queryByTestId('level-truncation-tile')).toBeNull();
  });

  it('activating the tile re-reads the level with all=1, so every epic is reachable', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
        seen.push(u);
        if (u.includes('all=1')) {
          return {
            ok: true,
            json: async () => ({
              ...manyRoots,
              nodes: [
                ...manyRoots.nodes,
                {
                  id: 'E250',
                  parentId: null,
                  kind: 'epic',
                  identifier: 'MOTIR-250',
                  title: 'The newest epic',
                  status: 'todo',
                  isDone: false,
                  hasChildren: true,
                },
              ],
              levelTotal: 4,
            }),
          };
        }
        return { ok: true, json: async () => manyRoots };
      }),
    );
    render(<WorkItemRoadmap projectKey="MOTIR" />);
    const tile = await screen.findByTestId('level-truncation-tile');
    expect(seen.some((u) => u.includes('all=1'))).toBe(false); // not before it is asked for

    fireEvent.keyDown(tile.closest('[data-node-id]')!, { key: 'Enter' });

    // The epic the cap had been dropping is now on the canvas, and the tile is gone.
    expect(await screen.findByText('The newest epic')).toBeTruthy();
    expect(seen.some((u) => u.includes('all=1'))).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('level-truncation-tile')).toBeNull());
  });

  it('does not forward the tile activation to onSelect — it is not a work item', async () => {
    const onSelect = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/work-items/peek'))
          return { ok: true, json: async () => PEEK };
        return { ok: true, json: async () => manyRoots };
      }),
    );
    render(<WorkItemRoadmap projectKey="MOTIR" onSelect={onSelect} />);
    const tile = await screen.findByTestId('level-truncation-tile');
    fireEvent.keyDown(tile.closest('[data-node-id]')!, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalledWith('__level_more__');
  });
});

// ── MOTIR-4501 · the tile is drawn at EVERY level, so it must uncap EVERY level ──
// The block above pins the ROOT level, which is the only place the affordance was
// ever exercised — and the only place it worked, because there the level's own
// cache key and `rootCacheKey()` are the same string. A DRILLED level's key is a
// different string, so marking the root's key left the drilled level capped, its
// cached copy intact, and the reload that followed served from that cache: no
// request was issued at all. `design/roadmap/design-notes.md` DECISION 7 asks for
// the tile "at every level, not only the root"; this is the activation half of it.
describe('a truncated DRILLED level uncaps ITSELF, not the root (MOTIR-4501)', () => {
  // TWO drillable roots, so AUTO-DRILL (MOTIR-1807) leaves the root level alone and
  // there is a real drill to perform. The ROOT is WHOLE (`levelTotal` equals its row
  // count) — only the DRILLED level overflows, which is the shape the cap actually
  // bites in: an epic accumulates children far faster than a project accumulates
  // epics.
  const twoRoots = {
    nodes: [
      {
        id: 'E1',
        parentId: null,
        kind: 'epic',
        identifier: 'MOTIR-1',
        title: 'Epic one',
        status: 'in_progress',
        isDone: false,
        hasChildren: true,
      },
      {
        id: 'E2',
        parentId: null,
        kind: 'epic',
        identifier: 'MOTIR-3',
        title: 'Epic two',
        status: 'todo',
        isDone: false,
        hasChildren: true,
      },
    ],
    edges: [],
    offLevelBlockers: [],
    levelTotal: 2,
  };
  // E1's children as the CAPPED read returns them: 3 rows of a level of 205.
  const cappedChildren = {
    nodes: Array.from({ length: 3 }, (_, i) => ({
      id: `S${i}`,
      parentId: 'E1',
      kind: 'story',
      identifier: `MOTIR-1${i}`,
      title: `Story ${i}`,
      status: 'todo',
      isDone: false,
      hasChildren: false,
    })),
    edges: [],
    offLevelBlockers: [],
    levelTotal: 205,
  };
  // The same level read whole: the row the cap had been dropping is on it, and
  // `levelTotal` now equals the row count, so no tile is emitted for it.
  const wholeChildren = {
    ...cappedChildren,
    nodes: [
      ...cappedChildren.nodes,
      {
        id: 'S205',
        parentId: 'E1',
        kind: 'story',
        identifier: 'MOTIR-205',
        title: 'The newest story',
        status: 'todo',
        isDone: false,
        hasChildren: false,
      },
    ],
    levelTotal: 4,
  };

  function stubLevels(seen: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/work-items/peek')) return { ok: true, json: async () => PEEK };
        seen.push(u);
        if (u.includes('parentId=E1')) {
          return {
            ok: true,
            json: async () => (u.includes('all=1') ? wholeChildren : cappedChildren),
          };
        }
        return { ok: true, json: async () => twoRoots };
      }),
    );
  }

  it('activating the tile on a DRILLED level re-reads THAT level with all=1, drops the tile, and leaves the root alone', async () => {
    const seen: string[] = [];
    stubLevels(seen);
    render(<WorkItemRoadmap projectKey="MOTIR" />);

    // Drill into E1 — the level whose 205 children the cap truncates to 3.
    expect(await screen.findByText('Epic one')).toBeTruthy();
    expect(screen.queryByTestId('level-truncation-tile')).toBeNull(); // the root is whole
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));

    // EMISSION is per-level and always was — the tile draws on the drilled level.
    const tile = await screen.findByTestId('level-truncation-tile');
    expect(within(tile).getByText('+ 202 more')).toBeTruthy();
    expect(within(tile).getByText('Showing 3 of 205')).toBeTruthy();
    expect(seen.some((u) => u.includes('all=1'))).toBe(false); // not before it is asked for

    fireEvent.keyDown(tile.closest('[data-node-id]')!, { key: 'Enter' });

    // AC 1 — the re-read is ISSUED, and it names the DRILLED level, not the root.
    expect(await screen.findByText('The newest story')).toBeTruthy();
    await waitFor(() =>
      expect(seen.some((u) => u.includes('parentId=E1') && u.includes('all=1'))).toBe(true),
    );
    // AC 2 — the reader's escape is complete: the level came back whole, so the
    // tile is gone rather than still sitting there promising a way out.
    await waitFor(() => expect(screen.queryByTestId('level-truncation-tile')).toBeNull());

    // AC 3 — the ROOT was never marked `all` and never evicted. Going Back issues
    // no `all=1` read of a level nobody complained about, and the root still
    // renders its own rows.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Epic one')).toBeTruthy();
    expect(screen.getByText('Epic two')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Story 0')).toBeNull());
    // A ROOT read carries no `parentId`; none of them may carry `all=1`.
    expect(seen.filter((u) => !u.includes('parentId=')).some((u) => u.includes('all=1'))).toBe(
      false,
    );
  });
});
