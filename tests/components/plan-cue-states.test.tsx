// @vitest-environment happy-dom
//
// THINKING · DRAFTING · CHECKING ON EVERY SURFACE (Task MOTIR-11254; design
// `design/ai-planning/design-notes.md` Part XXXI, `plan-review--thinking-cue.mock.html`).
//
// What is real: the clock (`usePlanProgressReading`), `PlanProposalViews`' one
// derivation and its two-read hold (`lib/planning/cueState.ts`), and the canvas
// (`PlanReviewCanvas` → `ProjectRoadmapCanvas` → `PlanningCanvas`), the list
// (`PlanProposalList`) and the quick view (`ProposalPeek` → `IssueQuickViewPanel`).
// What is mocked: the poll — each read is a re-render with the next snapshot and a
// NEW `inFlightDrafts` array, exactly as a read that arrived hands them down — and
// the roadmap level read (`fetch`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { PlanProposalViews } from '@/components/planning/PlanProposalViews';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanItemDraftDto } from '@/lib/dto/plans';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import type { LiveDrafts } from '@/lib/planning/liveDraft';
import {
  PLAN_STALLED_AFTER_MS,
  type PlanProgressSnapshot,
  type PlanProgressStep,
} from '@/lib/plans/planProgress';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { ProposalPeek } from '@/components/planning/ProposalPeek';

const EPIC_ID = 'wi_epic';
const LOGIN_ID = 'wi_login';
const RESET_ID = 'wi_reset';

function wireNode(over: Record<string, unknown>) {
  return {
    parentId: null,
    kind: 'story',
    type: null,
    executor: null,
    status: 'todo',
    statusLabel: null,
    statusCategory: null,
    isDone: false,
    hasChildren: false,
    progress: null,
    ready: false,
    ...over,
  };
}

const WIRE_LEVELS: Record<string, unknown> = {
  __root__: {
    nodes: [
      wireNode({
        id: EPIC_ID,
        kind: 'epic',
        identifier: 'ARP-1',
        title: 'Authentication',
        hasChildren: true,
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  [EPIC_ID]: {
    nodes: [
      wireNode({
        id: LOGIN_ID,
        parentId: EPIC_ID,
        identifier: 'ARP-2',
        title: 'Login UI',
        hasChildren: true,
      }),
      wireNode({ id: RESET_ID, parentId: EPIC_ID, identifier: 'ARP-3', title: 'Password Reset' }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  [LOGIN_ID]: { nodes: [], edges: [], offLevelBlockers: [] },
};

function stubRoadmap() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const parentId = url.searchParams.get('parentId') ?? '__root__';
    const body = WIRE_LEVELS[parentId] ?? { nodes: [], edges: [], offLevelBlockers: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const EPIC_TRAIL = [{ id: EPIC_ID, identifier: 'ARP-1', title: 'Authentication' }];

function proposal(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return {
    planItemId: 'pi_add',
    op: 'add',
    nodeId: 'pi_add',
    parentNodeId: EPIC_ID,
    parentIdentifier: 'ARP-1',
    parentTitle: 'Authentication',
    parentKind: 'epic',
    parentTrail: EPIC_TRAIL,
    folderId: null,
    folderPath: null,
    folderMissing: false,
    folderTrail: [],
    blockedByNodeIds: [],
    blockedByRemovedNodeIds: [],
    committedBlockedBy: [],
    blockerStubs: [],
    identifier: null,
    title: 'Account recovery',
    kind: 'story',
    priority: null,
    type: null,
    descriptionMd: null,
    explanationMd: null,
    explanationSource: null,
    storyPoints: null,
    estimateMinutes: null,
    difficulty: null,
    targetRepo: null,
    targetRepos: [],
    targetRepositories: null,
    targetRepositoryRef: null,
    targetRepoRole: null,
    executor: null,
    planningProvenance: null,
    subject: null,
    initRepositoryName: null,
    status: null,
    statusLabel: null,
    statusCategory: null,
    hasChildren: false,
    changes: [],
    stale: false,
    staleReasons: [],
    revised: false,
    targetMissing: false,
    removeReason: null,
    todos: null,
    proposal: {
      op: 'add',
      identifier: null,
      changedFields: [],
      settableRailFields: [],
      todos: null,
    },
    ...over,
  };
}

const LOGIN_TRAIL = [
  { id: EPIC_ID, identifier: 'ARP-1', title: 'Authentication' },
  { id: LOGIN_ID, identifier: 'ARP-2', title: 'Login UI' },
];
const ITEMS: PlanReviewItemDto[] = [
  proposal({ planItemId: 'pi_a', nodeId: 'pi_a', title: 'Account recovery' }),
  proposal({ planItemId: 'pi_b', nodeId: 'pi_b', title: 'Session timeout' }),
  proposal({
    planItemId: 'pi_c',
    nodeId: 'pi_c',
    title: 'Remember me',
    parentNodeId: LOGIN_ID,
    parentIdentifier: 'ARP-2',
    parentTitle: 'Login UI',
    parentKind: 'story',
    parentTrail: LOGIN_TRAIL,
    kind: 'subtask',
  }),
  proposal({
    planItemId: 'pi_d',
    nodeId: 'pi_d',
    title: 'Reset email',
    parentNodeId: RESET_ID,
    parentIdentifier: 'ARP-3',
    parentTitle: 'Password Reset',
    parentKind: 'story',
    parentTrail: [
      { id: EPIC_ID, identifier: 'ARP-1', title: 'Authentication' },
      { id: RESET_ID, identifier: 'ARP-3', title: 'Password Reset' },
    ],
    kind: 'subtask',
  }),
];

const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function step(
  kind: PlanProgressStep['kind'],
  targetNodeId: string | null,
  sessionKey = `s-${kind}-${targetNodeId ?? 'none'}`,
): PlanProgressStep {
  return {
    sessionKey,
    kind,
    phrase: kind === 'check' ? 'checkingCard' : 'authoring',
    targetRef: targetNodeId,
    targetNodeId,
    targetTitle: targetNodeId ? `title ${targetNodeId}` : null,
    startedAt: iso(T0 - 30_000),
    lastActivityAt: iso(T0 - 30_000),
    providerWait: null,
  } satisfies PlanProgressStep;
}

function snap(steps: PlanProgressStep[]): PlanProgressSnapshot {
  return {
    startedAt: iso(T0 - 5 * 60_000),
    lastActivityAt: iso(T0 - 10_000),
    observedAt: iso(T0),
    authored: 1,
    proposed: 4,
    autoResume: null,
    steps,
  };
}

function draft(planItemId: string, over: Partial<PlanItemDraftDto> = {}): PlanItemDraftDto {
  return {
    planItemId,
    sessionKey: `s-author-${planItemId}`,
    seq: 1,
    title: 'Account rec',
    descriptionMd: null,
    explanationMd: null,
    updatedAt: iso(T0),
    ...over,
  };
}

const INSIDE_EPIC: CanvasCrumb[] = [{ id: EPIC_ID, label: 'ARP-1 · Authentication' }];
const INSIDE_LOGIN: CanvasCrumb[] = [
  { id: EPIC_ID, label: 'ARP-1 · Authentication' },
  { id: LOGIN_ID, label: 'ARP-2 · Login UI' },
];

interface Read {
  steps: PlanProgressStep[];
  drafts?: PlanItemDraftDto[];
  failing?: boolean;
}

/** The pane as a host mounts it. Each call to the returned `next` is ONE READ. */
function mount(
  first: Read,
  opts: {
    live?: boolean;
    view?: 'canvas' | 'list';
    trail?: CanvasCrumb[];
    locale?: 'zh';
  } = {},
) {
  const el = (r: Read, progress: PlanProgressSnapshot | null = snap(r.steps)) => (
    <PlanProposalViews
      items={ITEMS}
      outcome={null}
      projectKey="ARP"
      version={0}
      ariaLabel="Proposed plan"
      view={opts.view ?? 'canvas'}
      onViewChange={() => {}}
      live={opts.live ?? true}
      liveFailing={r.failing ?? false}
      canvasHeldTrail={opts.trail ?? INSIDE_EPIC}
      progress={progress}
      progressFailing={r.failing ?? false}
      // A NEW array per read — what a host hands down when a read arrives.
      inFlightDrafts={[...(r.drafts ?? [])]}
    />
  );
  const view = render(
    el(first),
    opts.locale === 'zh' ? { locale: 'zh', messages: zhMessages } : undefined,
  );
  return {
    next: (r: Read) => view.rerender(el(r)),
    /** A re-render that is NOT a read: the same props object handed down again. */
    rerender: view.rerender,
    el,
  };
}

const box = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
const cueOf = (id: string) => box(id)?.getAttribute('data-cue') ?? null;
const motionOf = (id: string) => box(id)?.getAttribute('data-cue-motion') ?? null;
const chipOf = (id: string) => box(id)?.querySelector<HTMLElement>('.canvas-cue-chip') ?? null;
const loaded = () => screen.findByText('Account recovery');

beforeEach(() => {
  stubRoadmap();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the canvas node box — three states (§31.1, §31.2)', () => {
  it('an author step with no draft reads THINKING: dashed-ring class, brain chip, its own name, never moving', async () => {
    mount({ steps: [step('author', 'pi_a')] });
    await loaded();
    expect(cueOf('pi_a')).toBe('thinking');
    expect(box('pi_a')!.className).toContain('canvas-node--thinking');
    const chip = chipOf('pi_a')!;
    expect(chip.textContent).toBe('Thinking');
    expect(chip.getAttribute('data-testid')).toBe('canvas-cue-thinking');
    expect(chip.querySelector('svg')!.getAttribute('class')).toContain('lucide-brain');
    expect(screen.getByRole('img', { name: 'Being thought through — nothing written yet' })).toBe(
      chip,
    );
    expect(box('pi_a')!.getAttribute('aria-describedby')).toBe(chip.id);
    // Static — the at-work motion is Drafting's alone.
    expect(motionOf('pi_a')).toBeNull();
  });

  it('the same card reads DRAFTING from the first read that carries a draft, and moves', async () => {
    const { next } = mount({ steps: [step('author', 'pi_a')] });
    await loaded();
    next({ steps: [step('author', 'pi_a')], drafts: [draft('pi_a')] });
    expect(cueOf('pi_a')).toBe('drafting');
    expect(chipOf('pi_a')!.textContent).toBe('Drafting');
    expect(chipOf('pi_a')!.querySelector('svg')!.getAttribute('class')).toContain(
      'lucide-pen-line',
    );
    expect(motionOf('pi_a')).toBe('at-work');
  });

  it('a draft cleared mid-step: ONE empty read is held, the second falls back to Thinking and settles', async () => {
    const { next } = mount({ steps: [step('author', 'pi_a')], drafts: [draft('pi_a')] });
    await loaded();
    expect(cueOf('pi_a')).toBe('drafting');
    next({ steps: [step('author', 'pi_a')], drafts: [] });
    expect(cueOf('pi_a')).toBe('drafting');
    next({ steps: [step('author', 'pi_a')], drafts: [] });
    expect(cueOf('pi_a')).toBe('thinking');
    // T4: the wash lifts on the shipped leaving keyframes; the cue never left.
    expect(motionOf('pi_a')).toBe('settling');
    expect(chipOf('pi_a')!.textContent).toBe('Thinking');
  });

  it('the settling mark is released on its own clock', async () => {
    vi.useRealTimers();
    const { next } = mount({ steps: [step('author', 'pi_a')], drafts: [draft('pi_a')] });
    await loaded();
    next({ steps: [step('author', 'pi_a')], drafts: [] });
    next({ steps: [step('author', 'pi_a')], drafts: [] });
    expect(motionOf('pi_a')).toBe('settling');
    await act(() => new Promise((r) => setTimeout(r, 800)));
    expect(cueOf('pi_a')).toBe('thinking');
    expect(motionOf('pi_a')).toBeNull();
  });

  it('a re-render that is not a read does not advance the hold (no flicker on the clock)', async () => {
    const { next, rerender, el } = mount({
      steps: [step('author', 'pi_a')],
      drafts: [draft('pi_a')],
    });
    await loaded();
    const emptyRead = el({ steps: [step('author', 'pi_a')], drafts: [] });
    rerender(emptyRead);
    expect(cueOf('pi_a')).toBe('drafting');
    rerender(emptyRead);
    rerender(emptyRead);
    expect(cueOf('pi_a')).toBe('drafting');
    next({ steps: [step('author', 'pi_a')], drafts: [] });
    expect(cueOf('pi_a')).toBe('thinking');
  });

  it('the step ends: the cue leaves, whichever state it was in (T5)', async () => {
    const { next } = mount({ steps: [step('author', 'pi_a'), step('author', 'pi_b')] });
    await loaded();
    expect(cueOf('pi_a')).toBe('thinking');
    next({ steps: [step('author', 'pi_b')] });
    expect(cueOf('pi_a')).toBeNull();
    expect(chipOf('pi_a')).toBeNull();
  });

  it('a level authored in parallel shows each card its own state', async () => {
    mount({
      steps: [step('author', 'pi_a'), step('author', 'pi_b')],
      drafts: [draft('pi_b', { title: null, descriptionMd: 'Sess' })],
    });
    await loaded();
    expect(cueOf('pi_a')).toBe('thinking');
    expect(cueOf('pi_b')).toBe('drafting');
  });

  it('the final check marks its card CHECKING, and the tag moves to the next card as the check does', async () => {
    const { next } = mount({ steps: [step('check', 'pi_a')] });
    await loaded();
    expect(cueOf('pi_a')).toBe('checking');
    expect(box('pi_a')!.className).toContain('canvas-node--checking');
    const chip = chipOf('pi_a')!;
    expect(chip.textContent).toBe('Checking');
    expect(chip.querySelector('svg')!.getAttribute('class')).toContain('lucide-search-check');
    expect(screen.getByRole('img', { name: 'Being reviewed in the final check' })).toBe(chip);
    expect(motionOf('pi_a')).toBeNull();
    next({ steps: [step('check', 'pi_b')] });
    expect(cueOf('pi_a')).toBeNull();
    expect(cueOf('pi_b')).toBe('checking');
    // The check ends and the fix names no card: no tag anywhere.
    next({ steps: [step('repair', null)] });
    expect(document.querySelectorAll('[data-cue]')).toHaveLength(0);
  });

  it('the container review: seen from above, the story reads Checking its cards', async () => {
    mount({ steps: [step('check', LOGIN_ID)] });
    await screen.findByText('Login UI');
    expect(cueOf(LOGIN_ID)).toBe('checking');
    expect(chipOf(LOGIN_ID)!.textContent).toBe('Checking its items');
    expect(
      screen.getByRole('img', {
        name: 'Its items are being reviewed together in the final check',
      }),
    ).toBeTruthy();
  });

  it('the container review: inside the story, the bar reads Checking this level', async () => {
    mount({ steps: [step('check', LOGIN_ID)] }, { trail: INSIDE_LOGIN });
    const crumb = await screen.findByTestId('canvas-crumb-cue');
    expect(crumb.getAttribute('data-cue')).toBe('checking');
    expect(crumb.textContent).toBe('Checking this level');
    expect(crumb.querySelector('svg')!.getAttribute('class')).toContain('lucide-search-check');
  });

  it('the plan page (not live) shows all three states too', async () => {
    mount(
      {
        steps: [step('author', 'pi_a'), step('author', 'pi_b')],
        drafts: [draft('pi_b')],
      },
      { live: false },
    );
    await loaded();
    expect(cueOf('pi_a')).toBe('thinking');
    expect(cueOf('pi_b')).toBe('drafting');
  });

  it('a dropped read keeps every card in its state', async () => {
    const { next } = mount({ steps: [step('author', 'pi_a')], drafts: [draft('pi_a')] });
    await loaded();
    next({ steps: [step('author', 'pi_a')], drafts: [draft('pi_a')], failing: true });
    expect(cueOf('pi_a')).toBe('drafting');
    expect(motionOf('pi_a')).toBeNull(); // nothing plays
  });

  it('a stall freezes each card at its last state, static', async () => {
    mount({
      steps: [step('author', 'pi_a'), step('author', 'pi_b')],
      drafts: [draft('pi_b')],
    });
    await loaded();
    act(() => {
      vi.advanceTimersByTime(PLAN_STALLED_AFTER_MS);
    });
    expect(cueOf('pi_a')).toBe('thinking');
    expect(cueOf('pi_b')).toBe('drafting');
    expect(motionOf('pi_b')).toBeNull();
  });

  it('Chinese: 思考中 / 检查中 on the chips', async () => {
    mount({ steps: [step('author', 'pi_a'), step('check', 'pi_b')] }, { locale: 'zh' });
    await screen.findByText('Account recovery');
    expect(chipOf('pi_a')!.textContent).toBe('思考中');
    expect(chipOf('pi_b')!.textContent).toBe('检查中');
  });
});

describe('the list view — the row cue chip (§31.6)', () => {
  const row = (title: string) => screen.getByText(title).closest('li')!;

  it("each row carries its card's state, first in the right cluster, with the canvas name", () => {
    mount(
      {
        steps: [step('author', 'pi_a'), step('author', 'pi_b'), step('check', 'pi_d')],
        drafts: [draft('pi_b')],
      },
      { view: 'list' },
    );
    const a = within(row('Account recovery')).getByTestId('list-cue-thinking');
    expect(a.getAttribute('role')).toBe('img');
    expect(a.getAttribute('aria-label')).toBe('Being thought through — nothing written yet');
    expect(a.textContent).toBe('Thinking');
    expect(a.parentElement!.firstElementChild).toBe(a);
    const b = within(row('Session timeout')).getByTestId('list-cue-drafting');
    expect(b.getAttribute('aria-label')).toBe('Being drafted now');
    const d = within(row('Reset email')).getByTestId('list-cue-checking');
    expect(d.getAttribute('aria-label')).toBe('Being reviewed in the final check');
    expect(within(row('Remember me')).queryByRole('img', { name: /Being/ })).toBeNull();
  });

  it('the container review marks no row', () => {
    mount({ steps: [step('check', LOGIN_ID)] }, { view: 'list' });
    expect(document.querySelectorAll('[data-testid^="list-cue-"]')).toHaveLength(0);
  });

  it('the row chip follows the same hold as the canvas', () => {
    const { next } = mount(
      { steps: [step('author', 'pi_a')], drafts: [draft('pi_a')] },
      { view: 'list' },
    );
    expect(screen.getByTestId('list-cue-drafting')).toBeTruthy();
    next({ steps: [step('author', 'pi_a')], drafts: [] });
    expect(screen.getByTestId('list-cue-drafting')).toBeTruthy();
    next({ steps: [step('author', 'pi_a')], drafts: [] });
    expect(screen.getByTestId('list-cue-thinking')).toBeTruthy();
    next({ steps: [] });
    expect(screen.queryByTestId('list-cue-thinking')).toBeNull();
  });
});

describe('the quick view — the header cue (§31.7)', () => {
  const ITEM = ITEMS[0]!;
  const cueLine = () => screen.getByTestId('quick-view-live-cue');
  const live = (over: Partial<LiveDrafts>): LiveDrafts => ({
    drafts: [],
    authoring: new Set<string>(),
    ...over,
  });
  const peek = (liveDrafts: LiveDrafts | null) => (
    <ProposalPeek item={ITEM} live liveDrafts={liveDrafts} onClose={() => {}} />
  );

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('authored with no partial yet → brain + Thinking, in the one status region', () => {
    render(peek(live({ authoring: new Set(['pi_a']), cues: new Map([['pi_a', 'thinking']]) })));
    const line = cueLine();
    expect(line.getAttribute('role')).toBe('status');
    expect(line.getAttribute('data-live-cue')).toBe('thinking');
    expect(line.textContent).toBe('Thinking');
    expect(line.querySelector('svg')!.getAttribute('class')).toContain('lucide-brain');
  });

  it('Thinking → Being written on the first partial, in the SAME element (announced once each)', () => {
    const view = render(
      peek(live({ authoring: new Set(['pi_a']), cues: new Map([['pi_a', 'thinking']]) })),
    );
    const first = cueLine();
    view.rerender(
      peek(
        live({
          authoring: new Set(['pi_a']),
          drafts: [draft('pi_a')],
          cues: new Map([['pi_a', 'drafting']]),
        }),
      ),
    );
    expect(cueLine()).toBe(first);
    expect(cueLine().getAttribute('data-live-cue')).toBe('writing');
    expect(cueLine().textContent).toBe('Being written');
  });

  it('the final check on the card → search-check + Checking; it leaving announces nothing', () => {
    const view = render(peek(live({ cues: new Map([['pi_a', 'checking']]) })));
    expect(cueLine().getAttribute('data-live-cue')).toBe('checking');
    expect(cueLine().textContent).toBe('Checking');
    expect(cueLine().querySelector('svg')!.getAttribute('class')).toContain('lucide-search-check');
    view.rerender(peek(live({})));
    expect(cueLine().getAttribute('data-live-cue')).toBe('idle');
    expect(cueLine().textContent).toBe('');
  });

  it('without a planner cue the line reads as it shipped', () => {
    render(peek(live({ authoring: new Set(['pi_a']) })));
    expect(cueLine().getAttribute('data-live-cue')).toBe('writing');
  });
});
