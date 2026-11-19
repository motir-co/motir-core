// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import type { WorkItem } from '@/generated/prisma/client';
import type { WorkspaceContext } from '@/lib/workspaces';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { renderWithIntl as render } from '../../helpers/renderWithIntl';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';

// Story MOTIR-6894 — the coverage + integration GATE (Subtask MOTIR-6899).
//
// The per-card suites each stub the half they do not own: the composer's spec
// stubs `fetch`, the host's spec stubs the canvas, the canvas's spec stubs the
// host. This file joins the halves, against the REAL database:
//
//   1. a bare number typed in the target search travels the REAL
//      `GET /api/work-items/mention-search` → `quickSearch` (MOTIR-6896), and the
//      picked row becomes a `PlanningTarget` in the HOST's set — the one a turn
//      is sent with;
//   2. Set as target on the REAL canvas adds and removes that same target, the
//      tray and the ring agree, and the canvas does not move (MOTIR-6898);
//   3. every consumer of the shared search finds the key-N item first for N;
//   4. the guards: the Roadmap page's canvas stays opt-out, a `mentions={false}`
//      composer has no Search control, and no code reads an inline `@query` out
//      of the message any more (MOTIR-6897).
//
// Mocked, and only these: the session resolver (the test has no cookies), the
// conversation hook (no planner runs here), the roadmap LEVEL read (served from
// the rows this file seeds, so the canvas draws real ids), the anchor read, the
// onboarding and substrate reads the overlay makes, and the quick-view panel.

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

let params = new URLSearchParams();
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/backlog',
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));

const { fetchRoadmapLevel } = vi.hoisted(() => ({ fetchRoadmapLevel: vi.fn() }));
vi.mock('@/lib/planning/roadmapClient', () => ({ fetchRoadmapLevel }));

const { resolveOnboardingRouting } = vi.hoisted(() => ({ resolveOnboardingRouting: vi.fn() }));
vi.mock('@/lib/planning/onboardingRoutingClient', () => ({ resolveOnboardingRouting }));

const { fetchPlanningSubstrate } = vi.hoisted(() => ({ fetchPlanningSubstrate: vi.fn() }));
vi.mock('@/lib/planning/substratePoll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/substratePoll')>()),
  fetchPlanningSubstrate: (...a: unknown[]) => fetchPlanningSubstrate(...a),
}));

vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: () => true }),
}));
vi.mock('@/app/(authed)/items/_components/IssueQuickViewPanel', () => ({
  IssueQuickViewPanel: () => null,
}));

const { conversation } = vi.hoisted(() => ({
  conversation: {
    state: null as unknown,
    send: vi.fn(),
    retry: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
  },
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: () => conversation,
}));

const { GET: mentionSearch } = await import('@/app/api/work-items/mention-search/route');
const { PlanningWorkspaceOverlay } = await import('@/components/planning/PlanningWorkspaceOverlay');
const { WorkItemRoadmap } = await import('@/components/planning/WorkItemRoadmap');
const { PlanChangeComposer } = await import('@/components/planning/PlanChangeComposer');

const BASE = 'http://localhost:3000';

// The conversation's IDLE state, in the shape the rail reads (as the arrival
// gate carries it — a partial stub crashes the rail rather than failing).
const IDLE = {
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

/** A seeded row as the roadmap level read carries it. */
function levelItem(row: WorkItem) {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    kind: row.kind,
    status: 'todo',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    hasChildren: false,
    type: null,
    executor: null,
    assigneeName: null,
    ready: false,
    progress: null,
  };
}

let fx: WorkItemFixture;
let rows: WorkItem[];
/** The key-12 item: the one a bare `12` must find first. */
let twelfth: WorkItem;

beforeEach(async () => {
  await truncateAuthTables();
  params = new URLSearchParams();
  vi.clearAllMocks();
  conversation.state = { ...IDLE };
  resolveOnboardingRouting.mockResolvedValue({ decision: 'continue' });

  fx = await makeWorkItemFixture({ identifier: 'PROD' });
  ctxRef.current = { userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId };
  rows = [];
  for (let i = 1; i <= 12; i++) {
    rows.push(
      await createTestWorkItem(fx, {
        kind: 'story',
        // PROD-3's TITLE carries the digits: a title match the number must beat.
        title: i === 3 ? 'Release 12 notes' : i === 12 ? 'The twelfth story' : `Story ${i}`,
      }),
    );
  }
  twelfth = rows[11]!;

  // The canvas draws the seeded rows — real ids, so a toggle names a real item.
  fetchRoadmapLevel.mockImplementation((_project: string, parentId: string | null) =>
    Promise.resolve(
      parentId === null
        ? { items: rows.slice(9).map(levelItem), edges: [], offLevelBlockers: [] }
        : { items: [], edges: [], offLevelBlockers: [] },
    ),
  );

  // `fetch` reaches the REAL route for the target search; nothing else in this
  // surface goes over `fetch` once the reads above are mocked.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/work-items/mention-search')) {
        return mentionSearch(new Request(`${BASE}${url}`));
      }
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function mountSurface() {
  params = new URLSearchParams('plan=replan&planFrom=project');
  render(<PlanningWorkspaceOverlay projectKey="PROD" projectName="Prod" substrate={null} />);
  await act(async () => {});
}

const message = () => document.querySelector('form textarea') as HTMLTextAreaElement;
const chips = () =>
  screen.queryAllByTestId('planning-target-chip').map((c) => c.getAttribute('data-target-key'));

describe('SEAM 1 — a bare number, through the REAL route, into the HOST’s target set', () => {
  it('`12` in the search lists PROD-12 first; Enter makes it the target the turn is sent with', async () => {
    await mountSurface();

    fireEvent.click(screen.getByRole('button', { name: 'Search work items to plan' }));
    fireEvent.change(screen.getByTestId('planning-target-search-field'), {
      target: { value: '12' },
    });

    const options = await screen.findAllByRole('option', {}, { timeout: 5000 });
    // The exact number first, then the title that merely contains the digits.
    expect(options[0]!.textContent).toContain('PROD-12');
    expect(options[1]!.textContent).toContain('PROD-3');

    fireEvent.keyDown(screen.getByTestId('planning-target-search-field'), { key: 'Enter' });
    expect(chips()).toEqual(['PROD-12']);

    // The HOST's set is what a turn carries — asserted where it leaves.
    fireEvent.change(message(), { target: { value: 'Split this.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(conversation.send).toHaveBeenCalledWith(
      'Split this.',
      [{ id: twelfth.id, identifier: 'PROD-12', title: 'The twelfth story', kind: 'story' }],
      {},
    );
  });
});

describe('SEAM 2 — Set as target on the REAL canvas, into the same set', () => {
  it('adds and removes the card’s item; the tray and the ring agree; the canvas does not move', async () => {
    await mountSurface();
    const node = await waitFor(() => {
      const found = document.querySelector(`[data-node-id="${twelfth.id}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    const levelBefore = Array.from(document.querySelectorAll('[data-node-id]')).map((n) =>
      n.getAttribute('data-node-id'),
    );

    fireEvent.keyDown(node, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('target-toggle-button'));

    expect(chips()).toEqual(['PROD-12']);
    await waitFor(() => expect(within(node).queryByTestId('planning-target-node')).not.toBeNull());
    // Same level, and no follow was ever asked for.
    expect(
      Array.from(document.querySelectorAll('[data-node-id]')).map((n) =>
        n.getAttribute('data-node-id'),
      ),
    ).toEqual(levelBefore);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(fetchPlanningAnchor).not.toHaveBeenCalled();

    // The same card, now a target, removes it.
    fireEvent.keyDown(document.querySelector(`[data-node-id="${twelfth.id}"]`)!, {
      key: 'Enter',
    });
    const toggle = await screen.findByTestId('target-toggle-button');
    expect(toggle.textContent).toBe('Remove target');
    fireEvent.click(toggle);

    expect(chips()).toEqual([]);
    await waitFor(() =>
      expect(document.querySelector('[data-testid="planning-target-node"]')).toBeNull(),
    );
  });
});

describe('SEAM 3 — every consumer of the shared search finds key N first, on the real database', () => {
  it('the mention route', async () => {
    const res = await mentionSearch(new Request(`${BASE}/api/work-items/mention-search?q=12`));
    const body = (await res.json()) as { id: string }[];
    expect(body[0]?.id).toBe(twelfth.id);
  });

  it('the create-link candidates', async () => {
    const found = await workItemsService.listCreateLinkCandidates('#12', fx.ctx);
    expect(found[0]?.id).toBe(twelfth.id);
  });

  it('the item page’s link picker — with its own exclusions still applied', async () => {
    const found = await workItemsService.listLinkCandidates(
      rows[0]!.id,
      'blocked_by',
      '12',
      fx.ctx,
    );
    expect(found[0]?.id).toBe(twelfth.id);
    expect(found.map((r) => r.id)).not.toContain(rows[0]!.id);
    // Linking FROM the key-12 item excludes it from its own candidates.
    const self = await workItemsService.listLinkCandidates(twelfth.id, 'blocked_by', '12', fx.ctx);
    expect(self.map((r) => r.id)).not.toContain(twelfth.id);
  });
});

describe('GUARDS', () => {
  it('the Roadmap page’s canvas (`WorkItemRoadmap`) offers NO target action', async () => {
    render(<WorkItemRoadmap projectKey="PROD" />);
    const node = await waitFor(() => {
      const found = document.querySelector(`[data-node-id="${twelfth.id}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.keyDown(node, { key: 'Enter' });

    expect(await screen.findByTestId('view-button')).toBeTruthy();
    expect(screen.queryByTestId('target-toggle-button')).toBeNull();
  });

  it('a `mentions={false}` composer has no Search control, no shortcut and no combobox', () => {
    render(
      <PlanChangeComposer
        draft=""
        onDraftChange={() => {}}
        targets={[]}
        onAddTarget={() => {}}
        onRemoveTarget={() => {}}
        onSubmit={() => {}}
        mentions={false}
      />,
    );
    expect(screen.queryByTestId('planning-target-trigger')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    // …and the one shipped host that passes it still does.
    const hosts = execFileSync(
      'git',
      ['grep', '-l', 'mentions={false}', '--', 'components', 'app'],
      {
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n');
    expect(hosts).toContain('components/planning/PlanReviewRail.tsx');
  });

  it('NO code reads an inline `@query` out of the message any more', () => {
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        [
          'grep',
          '-n',
          '-E',
          'findMentionQuery|clearMentionQuery|MentionQueryRange',
          '--',
          'lib',
          'components',
          'app',
        ],
        { encoding: 'utf8' },
      );
    } catch {
      // `git grep` exits 1 on no match — the state this guard wants.
      hits = '';
    }
    expect(hits).toBe('');
  });
});
