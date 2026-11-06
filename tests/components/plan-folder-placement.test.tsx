// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { planReview, planReviewItem } from '../helpers/planReview';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import { mergePlanLevel } from '@/components/planning/planLevel';
import { collapseFolderPath, PlacementLine } from '@/components/planning/FolderPlacement';
import type { PlanItemChangeDto } from '@/lib/dto/planReview';

// The plan review SHOWS where a card will be filed (Story MOTIR-5310 · MOTIR-5418),
// built to `design/ai-planning/design-notes.md` Part XVII and
// `plan-folder-placement.mock.html` panels 1–5. The review model's folder fields
// are MOTIR-5415's; the approve refusal is MOTIR-5423's.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PARKED = ['Parked', '2025'];
const DEEP = ['Company', 'Platform', 'Parked', 'Ideas', '2025'];

const filedAdd = (over = {}) =>
  planReviewItem({
    planItemId: 'pi_filed',
    nodeId: 'pi_filed',
    kind: 'story',
    title: 'Importer retries with backoff',
    folderId: 'fold_2025',
    folderPath: PARKED,
    ...over,
  });

const placementChange = (
  from: NonNullable<PlanItemChangeDto['placement']>['from'],
  to: NonNullable<PlanItemChangeDto['placement']>['to'],
): PlanItemChangeDto => ({
  field: 'parent',
  from:
    from.kind === 'workItem' ? from.identifier : from.kind === 'folder' ? 'Parked ▸ 2025' : null,
  to: to.kind === 'workItem' ? to.identifier : to.kind === 'folder' ? 'Parked ▸ 2025' : null,
  placement: { from, to },
});

const FOLDER_SIDE = {
  kind: 'folder' as const,
  folderId: 'fold_2025',
  folderPath: PARKED,
  folderMissing: false,
  folderTrail: [],
};

describe('the count-based collapse rule (Part XVII §17.6)', () => {
  it('keeps a path whole up to the ceiling and collapses to first ▸ … ▸ last past it', () => {
    expect(collapseFolderPath(PARKED, 3)).toEqual(PARKED);
    expect(collapseFolderPath(['A', 'B', 'C'], 3)).toEqual(['A', 'B', 'C']);
    expect(collapseFolderPath(['A', 'B', 'C', 'D'], 3)).toEqual(['A', '…', 'D']);
    expect(collapseFolderPath(['A', 'B', 'C', 'D'], 4)).toEqual(['A', 'B', 'C', 'D']);
    expect(collapseFolderPath(DEEP, 4)).toEqual(['Company', '…', '2025']);
  });
});

describe('panel 1 — a filed add on the canvas', () => {
  // ⚠️ RESTATED by Part XVIII decision 2 (Bug MOTIR-5782). Part XVII drew a
  // filed add AMONG THE ROOTS with a placement line, because no canvas level was a
  // folder. Both planning canvases now draw it ON its folder's level, where the
  // breadcrumb says where the reader stands — so the node spends no slot on it and
  // keeps its full title (three lines with no footer since MOTIR-10508). The line's own contract (path, collapse, copy) still
  // ships, on `PlacementLine`, and is asserted there below.
  it('spends NO bottom slot on its folder — the breadcrumb says where it is — and keeps the three-line title', () => {
    renderWithIntl(<PlanItemNode item={filedAdd()} />);
    expect(screen.queryByTestId('placement-line')).toBeNull();
    expect(screen.getByText('Importer retries with backoff').className).toContain('line-clamp-3');
  });

  it('PlacementLine names the folder a card is filed in, destination last', () => {
    renderWithIntl(<PlacementLine folderPath={['Parked', '2025']} folderMissing={false} />);
    const line = screen.getByTestId('placement-line');
    expect(line?.textContent).toContain('Parked▸2025');
    // The full sentence is the accessible name; the full path is the hover title.
    expect(within(line).getByText('Filed in Parked ▸ 2025')).toBeTruthy();
    expect(within(line).getByTestId('folder-path')?.getAttribute('title')).toBe('Parked ▸ 2025');
    // The LAST segment is the destination.
    const segments = within(line).getAllByTestId('folder-path-segment');
    expect(segments.at(-1)?.textContent).toContain('2025');
    expect(segments.at(-1)?.className).toContain('text-(--el-text)');
  });

  it('draws no line for a root add with no folder, and keeps the three-line title', () => {
    renderWithIntl(<PlanItemNode item={planReviewItem({ title: 'An unfiled root' })} />);
    expect(screen.queryByTestId('placement-line')).toBeNull();
    expect(screen.getByText('An unfiled root').className).toContain('line-clamp-3');
  });

  it('collapses a five-segment path to first ▸ … ▸ last and still reads it whole (panel 5)', () => {
    renderWithIntl(<PlacementLine folderPath={DEEP} folderMissing={false} />);
    const line = screen.getByTestId('placement-line');
    expect(
      within(line)
        .getAllByTestId('folder-path-segment')
        .map((s) => s.textContent),
    ).toEqual(['Company', '…', '2025']);
    expect(within(line).getByTestId('folder-path')?.getAttribute('title')).toBe(
      'Company ▸ Platform ▸ Parked ▸ Ideas ▸ 2025',
    );
    expect(
      within(line).getByText('Filed in Company ▸ Platform ▸ Parked ▸ Ideas ▸ 2025'),
    ).toBeTruthy();
  });

  it('renders the Chinese copy', () => {
    renderWithIntl(<PlacementLine folderPath={['Parked', '2025']} folderMissing={false} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByText('归档于文件夹 Parked ▸ 2025')).toBeTruthy();
  });
});

describe('panel 2 — mixed placements', () => {
  // RESTATED by Part XVIII decision 2: the node carries no placement line any
  // more. WHICH level a filed card is merged onto is MOTIR-5795's (the plan-review
  // canvas keys it on its folder); this asserts only what the node draws.
  // RESTATED by MOTIR-5795: the filed card sits on its FOLDER's level, not the root.
  it('draws the filed card on its folder level with NO placement line — every host builds its level here', () => {
    const plain = planReviewItem({ planItemId: 'pi_plain', nodeId: 'pi_plain', title: 'Plain' });
    const root = mergePlanLevel({ nodes: [], deps: [] }, [filedAdd(), plain], null);
    expect(root.nodes.map((n) => n.id)).toEqual(['pi_plain']);
    const level = mergePlanLevel({ nodes: [], deps: [] }, [filedAdd(), plain], 'folder:fold_2025');
    expect(level.nodes.map((n) => n.id)).toEqual(['pi_filed']);
    renderWithIntl(
      <>
        {level.nodes.map((n) => (
          <div key={n.id}>{n.content}</div>
        ))}
      </>,
    );
    expect(screen.queryAllByTestId('placement-line')).toHaveLength(0);
  });

  it('puts the folder where `under {parent}` sits on the list row, and keeps a parented row unchanged', () => {
    const parented = planReviewItem({
      planItemId: 'pi_under',
      nodeId: 'pi_under',
      title: 'Under an epic',
      parentNodeId: 'wi_epic',
      parentIdentifier: 'MOTIR-7',
      parentTitle: 'An epic',
    });
    renderWithIntl(
      <PlanProposalList items={[filedAdd({ folderPath: DEEP }), parented]} outcome={null} />,
    );
    const fact = screen.getByTestId('list-folder-fact');
    expect(fact?.textContent).toContain('in');
    // The list's ceiling is FOUR, so five segments collapse there too.
    expect(
      within(fact)
        .getAllByTestId('folder-path-segment')
        .map((s) => s.textContent),
    ).toEqual(['Company', '…', '2025']);
    expect(within(fact).getByText('in Company ▸ Platform ▸ Parked ▸ Ideas ▸ 2025')).toBeTruthy();
    expect(screen.getByText('under An epic')).toBeTruthy();
    expect(screen.getAllByTestId('list-folder-fact')).toHaveLength(1);
  });
});

describe('panel 3 — a move into or out of a folder under Show changes', () => {
  it('labels the canvas diff `Placement` and draws the folder side with its path', () => {
    renderWithIntl(
      <PlanItemNode
        item={planReviewItem({
          op: 'modify',
          identifier: 'MOTIR-42',
          title: 'Filed into a folder',
          changes: [
            placementChange({ kind: 'workItem', id: 'wi_7', identifier: 'MOTIR-7' }, FOLDER_SIDE),
          ],
        })}
      />,
    );
    const diff = screen.getByTestId('diff-line');
    expect(diff?.textContent).toContain('Placement');
    expect(diff?.textContent).not.toContain('Parent');
    expect(within(diff).getByText('MOTIR-7').className).toContain('line-through');
    expect(within(diff).getByTestId('folder-path')?.getAttribute('title')).toBe('Parked ▸ 2025');
  });

  it('reads `Project root` beside a folder, never an empty cell', () => {
    renderWithIntl(
      <PlanItemNode
        item={planReviewItem({
          op: 'modify',
          identifier: 'MOTIR-42',
          changes: [placementChange(FOLDER_SIDE, { kind: 'root' })],
        })}
      />,
    );
    expect(within(screen.getByTestId('diff-line')).getByText('Project root')).toBeTruthy();
  });

  it('keeps a work item → work item move as the shipped `Parent` row', () => {
    renderWithIntl(
      <PlanItemNode
        item={planReviewItem({
          op: 'modify',
          identifier: 'MOTIR-42',
          changes: [
            placementChange(
              { kind: 'workItem', id: 'wi_7', identifier: 'MOTIR-7' },
              { kind: 'workItem', id: 'wi_9', identifier: 'MOTIR-9' },
            ),
          ],
        })}
      />,
    );
    expect(screen.getByTestId('diff-line')?.textContent).toContain('Parent');
    expect(screen.queryByTestId('folder-path')).toBeNull();
  });

  it('spells the from → to placement on the list', () => {
    renderWithIntl(
      <PlanProposalList
        items={[
          planReviewItem({
            op: 'modify',
            identifier: 'MOTIR-42',
            title: 'Taken out of a folder',
            changes: [
              placementChange(FOLDER_SIDE, { kind: 'workItem', id: 'wi_7', identifier: 'MOTIR-7' }),
            ],
          }),
        ]}
        outcome={null}
      />,
    );
    expect(screen.getByText('Placement')).toBeTruthy();
    expect(screen.getByTestId('folder-path')?.getAttribute('title')).toBe('Parked ▸ 2025');
    expect(screen.getByText('MOTIR-7')).toBeTruthy();
  });
});

describe('panel 4 — the stale folder', () => {
  const deleted = () => filedAdd({ folderPath: null, folderMissing: true });

  it('wears the shipped Out of date badge with the folder reason, and says Folder deleted', () => {
    renderWithIntl(<PlanItemNode item={deleted()} />);
    expect(screen.getByTestId('stale-badge')?.getAttribute('title')).toBe(
      'Folder deleted since planned',
    );
    const line = screen.getByTestId('placement-line');
    expect(line?.getAttribute('data-folder-missing')).toBe('true');
    expect(line?.textContent).toContain('Folder deleted');
  });

  it('marks the list row out of date with the Folder deleted fact', () => {
    renderWithIntl(<PlanProposalList items={[deleted()]} outcome={null} />);
    expect(screen.getByTestId('list-folder-missing')?.textContent).toContain('Folder deleted');
    expect(screen.getByText('may be out of date')).toBeTruthy();
  });

  it('disables Approve on a planned plan, names the exits, and lists the proposal in the summary', () => {
    renderWithIntl(
      <PlanReviewRail
        review={planReview([deleted(), planReviewItem({ planItemId: 'pi_ok', nodeId: 'pi_ok' })])}
        onApprove={() => {}}
        onDecline={() => {}}
        busy={false}
        errorCode={null}
      />,
    );
    expect(screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: /Decline/ }) as HTMLButtonElement).toHaveProperty(
      'disabled',
      false,
    );
    expect(
      screen.getByText(
        'Approve is unavailable while 1 item is filed into a deleted folder. Ask Motir to revise the plan, or decline it.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('stale-summary')?.textContent).toContain(
      'Folder deleted since planned',
    );
  });

  it('shows the keyed refusal copy naming the proposal after a refused approve, not the generic error', () => {
    renderWithIntl(
      <PlanReviewRail
        review={planReview([deleted()])}
        onApprove={() => {}}
        onDecline={() => {}}
        busy={false}
        errorCode="PLAN_FOLDER_MISSING"
        errorPlanItemId="pi_filed"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert?.textContent).toContain(
      'Nothing was created — “Importer retries with backoff” is filed into a folder that was deleted after this plan was written.',
    );
    // The plan stays open — the decide gate is still there.
    expect(screen.getByRole('button', { name: /Decline/ })).toBeTruthy();
  });

  it('renders the refusal in Chinese', () => {
    renderWithIntl(
      <PlanReviewRail
        review={planReview([deleted()])}
        onApprove={() => {}}
        onDecline={() => {}}
        busy={false}
        errorCode="PLAN_FOLDER_MISSING"
        errorPlanItemId="pi_filed"
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByRole('alert')?.textContent).toContain(
      '未创建任何内容 —“Importer retries with backoff”归档到的文件夹在计划写好后已被删除。',
    );
  });
});

// RESTATED by Part XVIII decision 5 (MOTIR-5795): MOTIR-5418's text-only folder
// segment is RETIRED. A folder is a level on this canvas now, so the drilled chain
// leads with the folder's own crumbs — `/roadmap`'s, and they navigate.
describe('the folder crumbs (Part XVIII decision 5, superseding Part XVII §17.2)', () => {
  it('leads the drilled chain with NAVIGABLE folder crumbs, and draws no text segment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ nodes: [], edges: [], offLevelBlockers: [] }),
        } as Response),
      ),
    );
    const story = filedAdd({
      hasChildren: true,
      folderTrail: [
        { id: 'fold_parked', name: 'Parked' },
        { id: 'fold_2025', name: '2025' },
      ],
    });
    const child = (n: number) =>
      planReviewItem({
        planItemId: `pi_c${n}`,
        nodeId: `pi_c${n}`,
        parentNodeId: 'pi_filed',
        kind: 'subtask',
        title: `Child ${n}`,
      });
    renderWithIntl(
      <PlanReviewCanvas
        items={[story, child(1), child(2)]}
        projectKey="MOTIR"
        version={0}
        ariaLabel="Plan canvas"
      />,
    );
    const crumb = await waitFor(() => screen.getByRole('button', { name: /Parked/ }));
    expect(crumb).toBeTruthy();
    expect(screen.getByRole('button', { name: /2025/ })).toBeTruthy();
    expect(screen.queryByTestId('crumb-folder')).toBeNull();
  });
});
