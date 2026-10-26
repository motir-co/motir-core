// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import type { PlanProgressStep } from '@/lib/plans/planProgress';

// The DRAFTING / LAYING cues on the plan's ONE canvas (Story MOTIR-7820 ·
// MOTIR-7830; design Part XXVI §26.6–26.7). `PlanReviewCanvas` maps the derivation's
// live steps to node cues and to in-flight entries for the arrivals slot; every
// assertion reads rendered output through the real `loadLevel` over a stubbed
// roadmap read, the way the level-band suite does.
//
// The plan page's case throughout: `live` is OFF — the cues read on the steps,
// never on the motion layer.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

//   root  →  EPIC (ARP-1)
//            ├─ LOGIN (ARP-2)  ← pi_c proposed beneath it
//            ├─ RESET (ARP-3)
//            ├─ pi_a (proposed)
//            └─ pi_b (proposed)
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

function step(
  kind: PlanProgressStep['kind'],
  targetNodeId: string | null,
  sessionKey = `s-${targetNodeId ?? kind}`,
): PlanProgressStep {
  return {
    sessionKey,
    kind,
    phrase:
      kind === 'settle'
        ? 'settling'
        : kind === 'lay'
          ? targetNodeId
            ? 'layingChildrenOf'
            : 'layingTopLevel'
          : targetNodeId
            ? 'authoring'
            : 'draftingNew',
    targetRef: targetNodeId,
    targetNodeId,
    targetTitle: targetNodeId ? `title ${targetNodeId}` : null,
    startedAt: '2026-10-08T14:00:00.000Z',
    providerWait: null,
  };
}

const INSIDE_EPIC: CanvasCrumb[] = [{ id: EPIC_ID, label: 'ARP-1 · Authentication' }];

function mount(
  liveSteps: PlanProgressStep[] | null,
  opts: {
    locale?: 'en' | 'zh';
    followTo?: { key: string; trail: CanvasCrumb[] } | null;
    readerHasNavigated?: boolean;
    heldTrail?: CanvasCrumb[];
    movingSteps?: PlanProgressStep[] | null;
  } = {},
) {
  const el = (steps: PlanProgressStep[] | null, moving = opts.movingSteps) => (
    <PlanReviewCanvas
      items={ITEMS}
      projectKey="ARP"
      version={0}
      outcome={null}
      heldTrail={opts.heldTrail ?? INSIDE_EPIC}
      followTo={opts.followTo ?? null}
      readerHasNavigated={opts.readerHasNavigated}
      liveSteps={steps}
      movingSteps={moving}
    />
  );
  const r = render(
    el(liveSteps),
    opts.locale === 'zh' ? { locale: 'zh', messages: zhMessages } : undefined,
  );
  return (next: PlanProgressStep[] | null, moving?: PlanProgressStep[] | null) =>
    r.rerender(el(next, moving));
}

const box = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
const cueOf = (id: string) => box(id)?.getAttribute('data-cue') ?? null;
const pill = () => screen.queryByTestId('canvas-arrivals-offer');
const breadcrumb = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
const loaded = () => screen.findByText('Account recovery');

describe('PlanReviewCanvas — the cues (MOTIR-7830)', () => {
  beforeEach(() => {
    stubRoadmap();
  });

  it('two author steps on the viewed level → two drafting cues', async () => {
    mount([step('author', 'pi_a'), step('author', 'pi_b')]);
    await loaded();
    expect(cueOf('pi_a')).toBe('drafting');
    expect(cueOf('pi_b')).toBe('drafting');
    expect(cueOf(LOGIN_ID)).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Being drafted now' })).toHaveLength(2);
    expect(pill()).toBeNull();
  });

  it('a step moving from A to B across two snapshots moves the cue', async () => {
    const update = mount([step('author', 'pi_a', 's1')]);
    await loaded();
    expect(cueOf('pi_a')).toBe('drafting');
    update([step('author', 'pi_b', 's1')]);
    expect(cueOf('pi_a')).toBeNull();
    expect(cueOf('pi_b')).toBe('drafting');
  });

  it('a lay step on a parent CARD on the viewed level → the laying cue on that card', async () => {
    mount([step('lay', LOGIN_ID)]);
    await loaded();
    await waitFor(() => expect(cueOf(LOGIN_ID)).toBe('laying'));
    expect(screen.getByTestId('canvas-cue-laying').textContent).toBe('Laying its children');
    expect(screen.queryByTestId('canvas-crumb-cue')).toBeNull();
  });

  it('a lay step on the level the reader stands IN → the bar marker, and no pill', async () => {
    mount([step('lay', EPIC_ID)]);
    await loaded();
    const marker = await screen.findByTestId('canvas-crumb-cue');
    expect(breadcrumb().contains(marker)).toBe(true);
    expect(marker.textContent).toBe('Laying this level');
    expect(pill()).toBeNull();
  });

  it('an author step on ANOTHER level is counted in the pill, and the canvas does not drill until it is pressed', async () => {
    mount([step('author', 'pi_c')]);
    await loaded();
    const offer = await waitFor(() => {
      expect(pill()).not.toBeNull();
      return pill()!;
    });
    expect(offer.textContent).toBe('1 being drafted in ARP-2 · Go there');
    // Still inside the epic: nothing moved.
    expect(within(breadcrumb()).getByRole('button', { current: 'page' }).textContent).toContain(
      'ARP-1',
    );
    expect(box('pi_c')).toBeNull();

    await act(async () => {
      fireEvent.click(offer);
    });
    await screen.findByText('Remember me');
    expect(cueOf('pi_c')).toBe('drafting');
    expect(within(breadcrumb()).getByRole('button', { current: 'page' }).textContent).toContain(
      'ARP-2',
    );
    // Standing where it is, the step is no longer off-level.
    expect(pill()).toBeNull();
  });

  it('the pill yields first on a narrow bar: a compact square named by its words (MOTIR-8646)', async () => {
    mount([step('author', 'pi_c')]);
    await loaded();
    const offer = await waitFor(() => {
      expect(pill()).not.toBeNull();
      return pill()!;
    });
    const words = '1 being drafted in ARP-2 · Go there';
    // The bar is the container the compact form queries.
    expect(breadcrumb().className).toContain('@container/canvas-bar');
    // Below 32rem the pill becomes a --height-control square with no padding…
    expect(offer.className).toContain('@max-[32rem]/canvas-bar:size-(--height-control)');
    expect(offer.className).toContain('@max-[32rem]/canvas-bar:p-0');
    // …and its label goes sr-only, never truncated, so its words stay its name.
    const label = within(offer).getByText(words);
    expect(label.className).toBe('@max-[32rem]/canvas-bar:sr-only');
    expect(offer.getAttribute('aria-label')).toBe(words);
    expect(offer.getAttribute('title')).toBe(words);
    expect(screen.getByRole('button', { name: words })).toBe(offer);
  });

  it('two drafting steps on two OTHER levels read "elsewhere", named by the earliest', async () => {
    mount([step('author', 'pi_c', 's1'), step('author', 'pi_d', 's2')]);
    await loaded();
    await waitFor(() => expect(pill()).not.toBeNull());
    expect(pill()!.textContent).toBe('2 being drafted elsewhere · first in ARP-2 · Go there');
  });

  it('a lay on another level reads "Laying …" and Go there drills into it', async () => {
    mount([step('lay', RESET_ID)], {
      heldTrail: [
        { id: EPIC_ID, label: 'ARP-1 · Authentication' },
        { id: LOGIN_ID, label: 'ARP-2 · Login UI' },
      ],
    });
    await screen.findByText('Remember me');
    await waitFor(() => expect(pill()).not.toBeNull());
    expect(pill()!.textContent).toBe('Laying ARP-3 · Go there');
    await act(async () => {
      fireEvent.click(pill()!);
    });
    await screen.findByText('Reset email');
    // Standing inside the parent being laid: the bar's marker, no pill.
    expect(await screen.findByTestId('canvas-crumb-cue')).toBeTruthy();
    expect(pill()).toBeNull();
  });

  it('an off-level drafting step beside a lay on a drawn card: the pill counts only the off-level one', async () => {
    mount([step('author', 'pi_c', 's1'), step('lay', LOGIN_ID, 's2')]);
    await loaded();
    // pi_c is off-level; the lay on LOGIN is a card on this level (no pill entry).
    await waitFor(() => expect(pill()).not.toBeNull());
    expect(pill()!.textContent).toBe('1 being drafted in ARP-2 · Go there');
    expect(cueOf(LOGIN_ID)).toBe('laying');
  });

  it('the follow offer holds the slot', async () => {
    mount([step('author', 'pi_c')], {
      followTo: { key: 'follow-1', trail: [{ id: LOGIN_ID, label: 'ARP-2 · Login UI' }] },
      readerHasNavigated: true,
    });
    await loaded();
    await screen.findByTestId('canvas-follow-offer');
    expect(pill()).toBeNull();
  });

  it('liveSteps: [] → no cue and no in-flight count', async () => {
    mount([]);
    await loaded();
    expect(document.querySelectorAll('[data-cue]')).toHaveLength(0);
    expect(pill()).toBeNull();
    expect(screen.queryByTestId('canvas-crumb-cue')).toBeNull();
  });

  it('untargeted and settle steps draw nothing', async () => {
    mount([step('settle', null), step('lay', null), step('author', null)]);
    await loaded();
    expect(document.querySelectorAll('[data-cue]')).toHaveLength(0);
    expect(pill()).toBeNull();
  });

  it('a committed target with no plan item → its node cue where drawn, and no pill entry', async () => {
    mount([step('author', RESET_ID), step('author', 'wi_elsewhere')]);
    await loaded();
    await waitFor(() => expect(cueOf(RESET_ID)).toBe('drafting'));
    expect(pill()).toBeNull();
  });

  it('zh — the cue name and the in-flight wording', async () => {
    mount([step('author', 'pi_a'), step('author', 'pi_c')], { locale: 'zh' });
    await loaded();
    expect(screen.getByRole('img', { name: '正在起草' }).textContent).toBe('起草中');
    await waitFor(() => expect(pill()).not.toBeNull());
    expect(pill()!.textContent).toBe('ARP-2 中有 1 项正在起草 · 前往');
  });
});

// AT WORK (Story MOTIR-8413 · MOTIR-8416): `movingSteps` says which drafted cards
// MOVE; presence still rides `liveSteps`, so a held step draws its cue, still.
describe('PlanReviewCanvas — the at-work motion (MOTIR-8416)', () => {
  beforeEach(() => {
    stubRoadmap();
  });
  const motionOf = (id: string) => box(id)?.getAttribute('data-cue-motion') ?? null;

  it('a drafted card the moving steps name is at-work; one they do not is drawn still', async () => {
    const steps = [step('author', 'pi_a', 's1'), step('author', 'pi_b', 's2')];
    mount(steps, { movingSteps: [steps[0]!] });
    await loaded();
    expect(cueOf('pi_a')).toBe('drafting');
    expect(motionOf('pi_a')).toBe('at-work');
    expect(cueOf('pi_b')).toBe('drafting');
    expect(motionOf('pi_b')).toBeNull();
  });

  it('held liveSteps with NO moving steps (stalled, reconnecting) → the chip, and no motion', async () => {
    mount([step('author', 'pi_a')], { movingSteps: [] });
    await loaded();
    expect(cueOf('pi_a')).toBe('drafting');
    expect(motionOf('pi_a')).toBeNull();
    expect(screen.getByRole('img', { name: 'Being drafted now' })).toBeTruthy();
  });

  it('a lay step never moves', async () => {
    const lay = step('lay', LOGIN_ID);
    mount([lay], { movingSteps: [lay] });
    await loaded();
    expect(cueOf(LOGIN_ID)).toBe('laying');
    expect(motionOf(LOGIN_ID)).toBeNull();
  });

  it('when the moving card is finished it leaves, then the next one is at work', async () => {
    const a = step('author', 'pi_a', 's1');
    const b = step('author', 'pi_b', 's1');
    const update = mount([a], { movingSteps: [a] });
    await loaded();
    update([b], [b]);
    expect(motionOf('pi_a')).toBe('leaving');
    expect(motionOf('pi_b')).toBe('at-work');
  });
});
