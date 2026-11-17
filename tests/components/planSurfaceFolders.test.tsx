// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  PlanReviewCanvas,
  type PlanReviewCanvasPrePlan,
} from '@/components/planning/PlanReviewCanvas';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import { mergePlanLevel } from '@/components/planning/planLevel';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import { planReview, planReviewItem } from '../helpers/planReview';

// Bug MOTIR-5782 · MOTIR-5794 — the plan-change OVERLAY's canvas draws folders.
//
// `design/ai-planning/design-notes.md` Part XVIII: the committed tree is
// `/roadmap`'s (decision 1), a proposal is drawn on the level where it will SIT —
// its folder when it is folder-placed (decision 2), a closed folder holding
// proposals carries a `changes` badge (decision 3), a folder move is drawn once,
// at its destination (decision 4), the folder crumb navigates (decision 5), and a
// proposal whose folder was deleted stays at the root (decision 6).
//
// ⚠️ MOTIR-6299 · MOTIR-11513: the overlay's "no plan" state is `PlanReviewCanvas`
// with `prePlan` set (it was a component of its own until MOTIR-11513), so the
// over-the-wire cases below assert the folder tree it draws with NO plan
// (decisions 1 and 5). Where a proposal sits in a folder, and the badge on the
// folder holding it (decisions 2, 3), are drawn by `PlanReviewCanvas` — the pane
// every plan is shown in — and are held in `planReviewCanvasFolders.test.tsx`.

/** The planning surface's canvas BEFORE a plan exists (MOTIR-11513). */
function PrePlanCanvas({
  version = 0,
  targetIds = [],
  onToggleTarget,
  canAddTarget,
}: {
  version?: number;
  targetIds?: readonly string[];
  onToggleTarget?: (target: PlanningTarget, isTarget: boolean) => void;
  canAddTarget?: boolean;
}) {
  const prePlan: PlanReviewCanvasPrePlan = { targetIds, onToggleTarget, canAddTarget };
  return <PlanReviewCanvas items={[]} projectKey="MOTIR" version={version} prePlan={prePlan} />;
}

const PARKED = { id: 'f1', name: 'Parked' };
const Y2025 = { id: 'f2', name: '2025' };

function filedAdd(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return planReviewItem({
    planItemId: 'pi_filed',
    nodeId: 'pi_filed',
    title: 'Importer retries with backoff',
    kind: 'story',
    folderId: Y2025.id,
    folderPath: ['Parked', '2025'],
    folderTrail: [PARKED, Y2025],
    ...over,
  });
}

function moveIntoParked(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return planReviewItem({
    planItemId: 'pi_move',
    nodeId: 'wi_moving',
    op: 'modify',
    identifier: 'MOTIR-4210',
    title: 'Bulk re-import from a saved mapping',
    kind: 'story',
    folderId: PARKED.id,
    folderPath: ['Parked'],
    folderTrail: [PARKED],
    changes: [
      {
        field: 'parent',
        from: null,
        to: 'Parked',
        placement: {
          from: { kind: 'root' },
          to: { kind: 'folder', folderId: PARKED.id, folderPath: ['Parked'], folderMissing: false },
        },
      },
    ],
    ...over,
  });
}

function wireNode(
  id: string,
  title: string,
  kind: RoadmapLevelData['items'][number]['kind'] = 'story',
  hasChildren = false,
) {
  return {
    id,
    parentId: null,
    kind,
    type: null,
    executor: null,
    identifier: `MOTIR-${id}`,
    title,
    status: 'todo',
    statusLabel: null,
    statusCategory: null,
    isDone: false,
    hasChildren,
    progress: null,
    ready: false,
  };
}

const wireFolder = (id: string, name: string, childFolderCount: number, itemCount: number) => ({
  id,
  parentFolderId: null,
  name,
  position: 'a0',
  childFolderCount,
  itemCount,
});

function levelData(items: RoadmapLevelData['items'], folders: RoadmapLevelData['folders'] = []) {
  return { items, edges: [], offLevelBlockers: [], folders } as RoadmapLevelData;
}

/** Serve levels keyed by the request's address: `folderId`, else `parentId`, else root. */
function serve(tree: Record<string, unknown>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://localhost');
    if (u.pathname === '/api/work-items/peek') return { ok: false, status: 404 } as Response;
    const key = u.searchParams.get('folderId') ?? u.searchParams.get('parentId') ?? '__root__';
    return {
      ok: true,
      json: async () => tree[key] ?? { nodes: [], edges: [], offLevelBlockers: [] },
    } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const el = (id: string) => document.querySelector(`[data-node-id="${id}"]`);

async function drill(id: string) {
  fireEvent.keyDown(el(id)!, { key: 'Enter' });
  fireEvent.click(within(el(id) as HTMLElement).getByTestId('drill-button'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Each add's canvas parent — the level it is drawn on — by its plan item id. */
const levels = (index: ReturnType<typeof indexPlanReview>) =>
  Object.fromEntries(index.adds.map((a) => [a.item.planItemId, a.parentNodeId]));

// The folder MOVE (decision 4) is not indexed here any more: MOTIR-6342 removed the
// `relocations` list nothing read. It is drawn once, at its destination, by
// `mergePlanLevel` (the block below) and taken off its source by
// `PlanReviewCanvas` (`planReviewCanvasFolders.test.tsx`).
describe('indexPlanReview — where a proposal SITS (decisions 2, 6)', () => {
  it('keys a filed add on its folder LEVEL, and leaves an unfiled root add at the root', () => {
    const plain = planReviewItem({ planItemId: 'pi_plain', nodeId: 'pi_plain', title: 'Plain' });
    const index = indexPlanReview(planReview([filedAdd(), plain]));

    expect(levels(index)).toEqual({ pi_filed: 'folder:f2', pi_plain: null });
  });

  it('keeps a proposal whose folder was DELETED at the root — there is no level to put it on', () => {
    const stale = filedAdd({ folderPath: null, folderMissing: true, folderTrail: [] });
    const index = indexPlanReview(planReview([stale]));

    expect(levels(index)).toEqual({ pi_filed: null });
    expect(index.folderChanges.size).toBe(0);
  });

  it('counts DEEP: every folder on each proposal’s trail, once per proposal', () => {
    const index = indexPlanReview(planReview([filedAdd(), moveIntoParked()]));

    expect(index.folderChanges.get(PARKED.id)).toBe(2);
    expect(index.folderChanges.get(Y2025.id)).toBe(1);
  });

  it('tolerates a payload with no trail (an older server) — no folder, no throw', () => {
    const legacy = { ...filedAdd() } as Partial<PlanReviewItemDto>;
    delete legacy.folderTrail;
    expect(() => indexPlanReview(planReview([legacy as PlanReviewItemDto]))).not.toThrow();
  });
});

// Re-homed from the deleted `planChangeLevel.tsx` onto the one level builder.
// The SOURCE half — the moving card taken off the root — is `PlanReviewCanvas`'s
// `departingIds` pass, held over the wire in `planReviewCanvasFolders.test.tsx`
// ("draws a move into a folder once — off the root, onto the folder").
describe('mergePlanLevel — a folder move is drawn once, at its DESTINATION (decision 4)', () => {
  it('draws it on the destination folder’s level with its Placement line', () => {
    const folderRead = levelData([], []);
    const level = mergePlanLevel(buildWorkItemLevel(folderRead), [moveIntoParked()], 'folder:f1');
    expect(level.nodes.map((n) => n.id)).toEqual(['wi_moving']);
    render(<>{level.nodes[0]!.content}</>);
    expect(screen.getByTestId('diff-line').textContent).toContain('Placement');
  });

  it('once APPROVED the read already carries it there, and it is not drawn a second time', () => {
    const folderRead = levelData([wireNode('wi_moving', 'Bulk re-import from a saved mapping')]);
    const level = mergePlanLevel(buildWorkItemLevel(folderRead), [moveIntoParked()], 'folder:f1');
    expect(level.nodes.filter((n) => n.id === 'wi_moving')).toHaveLength(1);
  });
});

describe('the pre-plan canvas — folders over the wire, with no plan (decisions 1, 5)', () => {
  const tree = {
    __root__: {
      nodes: [wireNode('E1', 'Road epic', 'epic', true)],
      edges: [],
      offLevelBlockers: [],
      folders: [wireFolder('f1', 'Parked', 1, 1), wireFolder('f0', 'Later', 0, 0)],
    },
    f1: {
      nodes: [wireNode('B9', 'Filed bug', 'bug')],
      edges: [],
      offLevelBlockers: [],
      folders: [wireFolder('f2', '2025', 0, 0)],
    },
    f2: { nodes: [], edges: [], offLevelBlockers: [], folders: [] },
    f0: { nodes: [], edges: [], offLevelBlockers: [], folders: [] },
  };

  it('reads the folder-aware root and draws the folder cards — with no change badge', async () => {
    const spy = serve(tree);
    render(<PrePlanCanvas />);

    expect(await screen.findByText('Parked')).toBeTruthy();
    await act(async () => {});
    expect(String(spy.mock.calls[0]![0])).toBe('/api/projects/MOTIR/roadmap?folders=1');
    expect(el('folder:f1')).toBeTruthy();
    expect(el('folder:f0')).toBeTruthy();
    // No plan, so no folder claims to hold a proposal.
    expect(document.querySelector('[data-testid="folder-changes"]')).toBeNull();
  });

  it('drills folder by folder, reading each level by folderId, and a folder crumb navigates back', async () => {
    const spy = serve(tree);
    render(<PrePlanCanvas />);
    await screen.findByText('Parked');

    await drill('folder:f1');
    expect(await screen.findByText('Filed bug')).toBeTruthy();
    expect(el('folder:f2')).toBeTruthy();
    await waitFor(() =>
      expect(spy.mock.calls.map(([u]) => String(u))).toContain(
        '/api/projects/MOTIR/roadmap?folders=1&folderId=f1',
      ),
    );

    await drill('folder:f2');
    await waitFor(() =>
      expect(spy.mock.calls.map(([u]) => String(u))).toContain(
        '/api/projects/MOTIR/roadmap?folders=1&folderId=f2',
      ),
    );
    expect(await screen.findByText('This folder is empty')).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const parkedCrumb = within(nav).getByRole('button', { name: /Parked/ });
    fireEvent.click(parkedCrumb);
    await waitFor(() => expect(el('B9')).toBeTruthy());
    expect(el('folder:f2')).toBeTruthy();
  });

  it('an EMPTY folder’s level says so in folder words', async () => {
    serve(tree);
    render(<PrePlanCanvas />);
    await screen.findByText('Later');
    await drill('folder:f0');
    expect(await screen.findByText('This folder is empty')).toBeTruthy();
  });
});

// MOTIR-6898 — Set as target on the planning surface's committed-tree canvas.
// The button itself is `ProjectRoadmapCanvas`'s (its own suite); what is ruled on
// here is this canvas's half: WHICH nodes are eligible (the work items its levels
// drew, never a folder) and WHAT the host is handed (the item, and whether it is
// already a target).
describe('the pre-plan canvas — the target action over the wire (MOTIR-6898)', () => {
  const tree = {
    __root__: {
      nodes: [wireNode('E1', 'Road epic', 'epic', true)],
      edges: [],
      offLevelBlockers: [],
      folders: [wireFolder('f1', 'Parked', 0, 0)],
    },
  };

  it('is OFF without `onToggleTarget`', async () => {
    serve(tree);
    render(<PrePlanCanvas />);
    await screen.findByText('Road epic');
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });

    await screen.findByTestId('drill-button');
    expect(screen.queryByTestId('target-toggle-button')).toBeNull();
  });

  it('hands the host the card’s WORK ITEM, and whether it is a target already', async () => {
    serve(tree);
    const onToggleTarget = vi.fn();
    const { rerender } = render(<PrePlanCanvas onToggleTarget={onToggleTarget} />);
    await screen.findByText('Road epic');
    fireEvent.keyDown(el('E1')!, { key: 'Enter' });

    fireEvent.click(await screen.findByTestId('target-toggle-button'));
    expect(onToggleTarget).toHaveBeenCalledWith(
      { id: 'E1', identifier: 'MOTIR-E1', title: 'Road epic', kind: 'epic' },
      false,
    );
    expect(screen.getByTestId('target-toggle-button').getAttribute('aria-label')).toBe(
      'Set MOTIR-E1 as the planning target',
    );

    rerender(
      <PrePlanCanvas targetIds={['E1']} onToggleTarget={onToggleTarget} canAddTarget={false} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('target-toggle-button').textContent).toBe('Remove target'),
    );
    fireEvent.click(screen.getByTestId('target-toggle-button'));
    expect(onToggleTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ identifier: 'MOTIR-E1' }),
      true,
    );
  });

  it('a DRILLED work-item level registers its items too — its cards are targets', async () => {
    serve({
      ...tree,
      E1: {
        nodes: [wireNode('S1', 'A story')],
        edges: [],
        offLevelBlockers: [],
      },
    });
    const onToggleTarget = vi.fn();
    render(<PrePlanCanvas onToggleTarget={onToggleTarget} />);
    await screen.findByText('Road epic');
    await drill('E1');
    await screen.findByText('A story');
    fireEvent.keyDown(el('S1')!, { key: 'Enter' });

    fireEvent.click(await screen.findByTestId('target-toggle-button'));
    expect(onToggleTarget).toHaveBeenCalledWith(
      { id: 'S1', identifier: 'MOTIR-S1', title: 'A story', kind: 'story' },
      false,
    );
  });

  it('a NEW version (an approve) re-reads the level on screen', async () => {
    const spy = serve(tree);
    const { rerender } = render(<PrePlanCanvas onToggleTarget={vi.fn()} />);
    await screen.findByText('Road epic');
    const before = spy.mock.calls.length;

    rerender(<PrePlanCanvas version={1} onToggleTarget={vi.fn()} />);

    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('Road epic')).toBeTruthy();
  });

  it('a FOLDER tile is never a target', async () => {
    serve(tree);
    render(<PrePlanCanvas onToggleTarget={vi.fn()} />);
    await screen.findByText('Parked');
    fireEvent.keyDown(el('folder:f1')!, { key: 'Enter' });

    await screen.findByTestId('drill-button');
    expect(screen.queryByTestId('target-toggle-button')).toBeNull();
  });
});
