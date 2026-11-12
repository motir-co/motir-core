// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { WorkItemNode } from '@/components/planning/WorkItemNode';
import {
  mergePlanLevel,
  proposalsAtLevel,
  withProjectedCoverage,
} from '@/components/planning/planLevel';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { arrivalLevel } from '@/components/planning/PlanReviewCanvas';
import type { PlanCanvasLevel } from '@/components/planning/planLevel';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

// Component tests for the plan-detail op treatments (Subtask 7.4.5 / MOTIR-847)
// under happy-dom. The DTO assembly is covered by the real-DB
// planReviewService suite; here we assert the canvas node renders each `op`
// distinctly (add / modify-with-diff / remove) + the stale badge, and that the
// pure LEVEL transform merges a plan's proposals into the committed level the
// roadmap read returned (MOTIR-3083).

afterEach(cleanup);

function item(over: Partial<PlanReviewItemDto>): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: null,
    parentIdentifier: null,
    parentTitle: null,
    parentKind: null,
    parentTrail: [],
    // The FOLDER placement (MOTIR-5415) — none by default.
    folderId: null,
    folderPath: null,
    folderMissing: false,
    folderTrail: [],
    blockedByNodeIds: [],
    blockedByRemovedNodeIds: [],
    committedBlockedBy: [],
    blockerStubs: [],
    identifier: null,
    title: 'A proposed item',
    kind: 'task',
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

describe('PlanItemNode', () => {
  it('renders an add with the add badge + "New" placeholder identifier', () => {
    renderWithIntl(<PlanItemNode item={item({ op: 'add', title: 'Marketplace payouts' })} />);
    expect(screen.getByText('add')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Marketplace payouts')).toBeTruthy();
    expect(screen.getByTestId('plan-item-node').getAttribute('data-op')).toBe('add');
  });

  it('renders a modify with the change badge + an old→new diff line', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_1',
          identifier: 'PROD-14',
          title: 'Seller onboarding',
          status: 'in_progress',
          statusLabel: null,
          statusCategory: null,
          changes: [
            { field: 'priority', from: 'medium', to: 'high' },
            { field: 'title', from: 'old', to: 'new' },
          ],
        })}
      />,
    );
    expect(screen.getByText('change')).toBeTruthy();
    // ⚠️ The KEY, where an `add` shows "New" (bug MOTIR-3191). Between the two,
    // that is what lets a reviewer read "this amends PROD-14" off the node
    // without opening it — and it is the half that a `modify` drawn at the
    // project root made unreadable, because a card at the root reads as a
    // proposed EPIC whatever its badge says.
    expect(screen.getByText('PROD-14')).toBeTruthy();
    expect(screen.queryByText('New')).toBeNull();
    expect(screen.getByTestId('diff-line')).toBeTruthy();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    // A second change is summarised, not dumped.
    expect(screen.getByText('+1 more')).toBeTruthy();
  });

  // MOTIR-4030 — the diff-line's field label and struck OLD value were painted
  // `--el-text-muted` at `text-xs` on a `--el-surface` card (4.12–4.34:1, below
  // AA). Both now resolve `--el-text-secondary` (6.18–6.80:1); the strike stays,
  // because `line-through` — a non-hue channel — is what carries "old".
  it('draws the diff-line label and struck old value in secondary ink, not muted', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_aa',
          identifier: 'PROD-40',
          title: 'Seller onboarding',
          status: 'todo',
          statusLabel: null,
          statusCategory: null,
          changes: [{ field: 'title', from: 'Invoice templates', to: 'Billing setup' }],
        })}
      />,
    );

    const label = screen.getByText('Title');
    expect(label.className).toContain('text-(--el-text-secondary)');
    expect(label.className).not.toContain('text-(--el-text-muted)');

    const struck = screen.getByText('Invoice templates');
    expect(struck.className).toContain('text-(--el-text-secondary)');
    expect(struck.className).toContain('line-through');
    expect(struck.className).not.toContain('text-(--el-text-muted)');
  });

  it('renders a remove with a struck-through title + status pill', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'remove',
          nodeId: 'wi_2',
          identifier: 'PROD-19',
          title: 'Manual payout export',
          status: 'todo',
          statusLabel: null,
          statusCategory: null,
        })}
      />,
    );
    expect(screen.getByText('remove')).toBeTruthy();
    const title = screen.getByText('Manual payout export');
    expect(title.className).toContain('line-through');
  });

  // ── The STATUS chip is the SHARED one (bug MOTIR-3170) ──────────────────
  //
  // This node used to keep its OWN six-member status literal and coerce
  // anything else to `todo`, so a `modify` whose live target had an open pull
  // request drew as "To Do" on the plan-detail canvas. There is now ONE
  // resolver — `WorkItemStatusPill` → `lib/workflows/canvasStatusMeta.ts` —
  // and these assert on the rendered TEXT, which is what a reviewer reads.
  it('renders a modify whose live target is at `implemented` as "Implemented"', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_impl',
          identifier: 'PROD-31',
          title: 'Seller onboarding',
          status: 'implemented',
          statusLabel: 'Implemented',
          statusCategory: 'in_progress',
        })}
      />,
    );
    expect(screen.getByText('Implemented')).toBeTruthy();
    expect(screen.queryByText('To Do')).toBeNull();
  });

  it("renders a target at a CUSTOM workflow status with that status's own label", () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_custom',
          identifier: 'PROD-32',
          title: 'Seller onboarding',
          status: 'awaiting_legal',
          statusLabel: 'Awaiting legal',
          statusCategory: 'todo',
        })}
      />,
    );
    expect(screen.getByText('Awaiting legal')).toBeTruthy();
    expect(screen.queryByText('To Do')).toBeNull();
  });

  it('draws the chip from the SAME resolver as the roadmap node — same key, same fill', () => {
    // The AC is "no second copy of the mapping in `components/planning/`". A
    // rendered comparison is what proves it: if this file ever grows its own map
    // again, the two fills diverge here rather than in production.
    const proposal = renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_same',
          identifier: 'PROD-33',
          title: 'Seller onboarding',
          status: 'implemented',
          statusLabel: 'Implemented',
          statusCategory: 'in_progress',
        })}
      />,
    );
    const onProposal = proposal.container.querySelector(
      '[data-status="implemented"]',
    ) as HTMLElement;
    const chipClass = onProposal.className;
    const chipText = onProposal.textContent;
    cleanup();

    const node = renderWithIntl(
      <WorkItemNode
        item={{
          id: 'wi_same',
          identifier: 'PROD-33',
          title: 'Seller onboarding',
          kind: 'subtask',
          status: 'implemented',
          statusLabel: 'Implemented',
          statusCategory: 'in_progress',
        }}
      />,
    );
    const onNode = node.container.querySelector('[data-status="implemented"]') as HTMLElement;
    // The committed card wears the TAG-ROW form of the chip (MOTIR-10508: `min-w-0`,
    // a truncating label); the resolver's fill and ink are the same on both.
    const tone = (cls: string) =>
      cls.split(/\s+/).filter((c) => c.startsWith('bg-(') || c.startsWith('text-('));
    expect(tone(onNode.className)).toEqual(tone(chipClass));
    expect(tone(onNode.className)).toEqual(['bg-(--el-tint-rose)', 'text-(--el-text-strong)']);
    expect(onNode.textContent).toBe(chipText);
  });

  it('shows a stale badge with the reasons in the tooltip', () => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          stale: true,
          staleReasons: [{ code: 'parent_removed', parentId: 'wi_9' }],
        })}
      />,
    );
    const badge = screen.getByTestId('stale-badge');
    expect(badge.getAttribute('title')).toContain('Parent removed');
  });

  // MOTIR-3151 — the SIZING rows. `buildChanges` has emitted `storyPoints` /
  // `estimateMinutes` since MOTIR-1532, and neither had a message in the
  // `planReview` catalog, so `DiffLine`'s `t(`field_${first.field}`)` rendered
  // the KEY PATH. `DiffLine` shows `changes[0]` only, so a patch that changes
  // ONLY the sizing put the leak first; one that also changed the title hid it.
  // Guarded on the ABSENCE of the key path as well as the presence of the word —
  // a label that renders `planReview.field_storyPoints` is the defect, and a
  // present-only assertion would pass on it.
  it.each([
    ['storyPoints', '3', '5', 'Story points'] as const,
    ['estimateMinutes', '30', '90', 'Estimate'] as const,
  ])('labels a %s-only re-scope with a word, not a message key', (field, from, to, label) => {
    renderWithIntl(
      <PlanItemNode
        item={item({
          op: 'modify',
          nodeId: 'wi_size',
          identifier: 'PROD-21',
          title: 'Seller onboarding',
          status: 'todo',
          statusLabel: null,
          statusCategory: null,
          changes: [{ field, from, to }],
        })}
      />,
    );
    const line = screen.getByTestId('diff-line');
    expect(line.textContent).not.toContain(`field_${field}`);
    expect(line.textContent).toContain(label);
  });

  // ⚠️ EDITING IS REMOVED (MOTIR-3084). MOTIR-1370's inline-edit pencil and its
  // modal are gone: a proposal is READ (the canvas peek) and changed by
  // re-planning, not hand-corrected. Guarded on ABSENCE, on every op — the
  // affordance must not come back on any of them.
  it('carries NO edit affordance on any op', () => {
    for (const op of ['add', 'modify', 'remove'] as const) {
      renderWithIntl(<PlanItemNode item={item({ op, nodeId: `wi_${op}`, title: op })} />);
      expect(screen.queryByTestId('edit-proposal')).toBeNull();
      cleanup();
    }
  });
});

// ── MOTIR-3161 (bug MOTIR-3154) — the DECIDED axis ──────────────────────────
//
// `design/ai-planning/design-notes.md` Part VI §3: the outcome CROSSES the three
// op languages rather than joining them (every op can be accepted and every op
// can be declined ⇒ six renderings), so the op frame is untouched and the
// outcome rides the chip's second SEGMENT plus a decorative spine.

describe('PlanItemNode — the decided outcome', () => {
  const OPS = ['add', 'modify', 'remove'] as const;

  it.each(OPS)('names the outcome in TEXT on a %s, for both decisions', (op) => {
    for (const [outcome, word] of [
      ['accepted', 'accepted'],
      ['declined', 'declined'],
    ] as const) {
      renderWithIntl(<PlanItemNode item={item({ op })} outcome={outcome} />);
      // Queried by TEXT, not by class: the word is the whole of the meaning, and
      // the a11y rule this asset holds itself to is that state is never carried
      // by colour alone.
      expect(screen.getByTestId('plan-item-outcome').textContent).toBe(word);
      // …and the op is STILL named beside it — the chip reads op × outcome.
      expect(screen.getByTestId('plan-item-op-chip').textContent).toContain(word);
      cleanup();
    }
  });

  it('leaves the op frame untouched — the axis CROSSES it, it does not replace it', () => {
    for (const op of OPS) {
      renderWithIntl(<PlanItemNode item={item({ op })} />);
      const undecided = screen.getByTestId('plan-item-node').className;
      cleanup();

      renderWithIntl(<PlanItemNode item={item({ op })} outcome="accepted" />);
      const decided = screen.getByTestId('plan-item-node').className;
      cleanup();

      // Every class the op treatment sets is still set. The only additions are
      // the ones the decided axis owns.
      for (const cls of undecided.split(/\s+/).filter((c) => c && c !== 'opacity-80')) {
        expect(decided.split(/\s+/)).toContain(cls);
      }
    }
  });

  it('renders NOTHING new while the plan is still planned', () => {
    renderWithIntl(<PlanItemNode item={item({ op: 'add' })} />);
    expect(screen.queryByTestId('plan-item-outcome')).toBeNull();
    expect(screen.queryByTestId('plan-item-outcome-spine')).toBeNull();
    // The undecided badge is the shipped one, byte for byte — no chip wrapper.
    expect(screen.queryByTestId('plan-item-op-chip')).toBeNull();
    expect(screen.getByText('add')).toBeTruthy();
  });

  it('carries NO fade on a remove, decided or not (MOTIR-4475)', () => {
    // ⚠️ REVERSED FROM WHAT THIS TEST ASSERTED (MOTIR-4260 pinned the fade on
    // the UNDECIDED arm; MOTIR-4475 removed it from both). `opacity` composites
    // the element AND its subtree, so the fade dimmed the frame and every string
    // inside it at 0.8 over the board's `--el-canvas` — the title at 3.95:1, the
    // identifier and the status pill at 3.95:1, the op badge at 3.98:1, all under
    // AA, and all of it surviving MOTIR-4260's re-inking because opacity scales
    // whatever ink you pick (the MOTIR-2495 rule, at a second site).
    //
    // Nothing is lost: `remove` still speaks through the strong border, the muted
    // fill and the strike, and PENDING vs DECIDED is carried by the two signals a
    // decided node ADDS — the spine and the outcome segment — which is how `add`
    // and `modify` distinguish the same two states without dimming anything.
    renderWithIntl(<PlanItemNode item={item({ op: 'remove' })} />);
    expect(screen.getByTestId('plan-item-node').className).not.toContain('opacity-');
    // …and the PENDING node still says nothing about an outcome, which is what
    // makes it legible as pending.
    expect(screen.queryByTestId('plan-item-outcome')).toBeNull();
    expect(screen.queryByTestId('plan-item-outcome-spine')).toBeNull();
    cleanup();

    renderWithIntl(<PlanItemNode item={item({ op: 'remove' })} outcome="declined" />);
    const node = screen.getByTestId('plan-item-node');
    expect(node.className).not.toContain('opacity-');
    // …and the strike stays: a declined remove is the one place a reader could be
    // misled, which is exactly why the word must be there to correct it.
    expect(screen.getByText('A proposed item').className).toContain('line-through');
    expect(screen.getByTestId('plan-item-outcome').textContent).toBe('declined');
  });

  it('carries the spine as DECORATION only', () => {
    renderWithIntl(<PlanItemNode item={item({ op: 'add' })} outcome="accepted" />);
    const spine = screen.getByTestId('plan-item-outcome-spine');
    expect(spine.getAttribute('aria-hidden')).toBe('true');
    expect(spine.textContent).toBe('');
  });
});

describe('mergePlanLevel', () => {
  /** A committed level as the roadmap read returns it. */
  function committed(ids: string[], deps: PlanCanvasLevel['deps'] = []): PlanCanvasLevel {
    return {
      nodes: ids.map((id) => ({
        id,
        parentId: 'parent_1',
        searchText: id,
        crumbLabel: id,
        drillable: false,
        content: <span>{id}</span>,
      })),
      deps,
    };
  }

  it('keeps EVERY committed sibling — including one nothing depends on', () => {
    // The point of the level model: a sibling is on the canvas because it is a
    // CHILD of the focused parent, never because something depends on it.
    const level = mergePlanLevel(
      committed(['wi_a', 'wi_b', 'wi_c']),
      [item({ planItemId: 'p1', nodeId: 'p1', op: 'add', parentNodeId: 'parent_1' })],
      'parent_1',
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['wi_a', 'wi_b', 'wi_c', 'p1']);
    // No edge anywhere, and all three siblings still render.
    expect(level.deps).toEqual([]);
  });

  it('re-skins a modify/remove IN PLACE rather than adding a ghost node', () => {
    const level = mergePlanLevel(
      committed(['wi_a', 'wi_b']),
      [item({ planItemId: 'p1', nodeId: 'wi_b', op: 'remove', parentNodeId: 'parent_1' })],
      'parent_1',
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['wi_a', 'wi_b']);
  });

  it('keeps the committed edges and adds a proposal edge when both ends are at this level', () => {
    const level = mergePlanLevel(
      committed(['wi_a'], [{ from: 'wi_a', to: 'wi_b', variant: 'firm' }]),
      [
        item({
          planItemId: 'p1',
          nodeId: 'p1',
          op: 'add',
          parentNodeId: 'parent_1',
          blockedByNodeIds: ['wi_a', 'off_level'],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([
      { from: 'wi_a', to: 'wi_b', variant: 'firm' },
      // `off_level` has no node here and no stub to name it by, so its edge is
      // dropped. A blocker that CAN be named takes the off-level treatment
      // instead (bug MOTIR-5387).
      { from: 'wi_a', to: 'p1', variant: 'pending' },
    ]);
  });

  it('only merges the proposals that belong at THIS level', () => {
    const items = [
      item({ planItemId: 'p1', nodeId: 'p1', op: 'add', parentNodeId: 'parent_1' }),
      item({ planItemId: 'p2', nodeId: 'p2', op: 'add', parentNodeId: 'other_parent' }),
      item({ planItemId: 'p3', nodeId: 'p3', op: 'add', parentNodeId: null }),
    ];

    expect(proposalsAtLevel(items, 'parent_1').map((i) => i.nodeId)).toEqual(['p1']);
    expect(proposalsAtLevel(items, null).map((i) => i.nodeId)).toEqual(['p3']);
    expect(mergePlanLevel(committed([]), items, 'parent_1').nodes.map((n) => n.id)).toEqual(['p1']);
  });

  it('holds exactly ONE node per approved add — on the work item it became', () => {
    // MOTIR-3160 keys a materialized `add` by its work item, so the proposal now
    // MATCHES the committed node and the treatment lands ON it. Before that it
    // never matched and was pushed out as a second, keyless node beside the real
    // one — two nodes for one thing, on a canvas whose job is the tree's shape.
    const level = mergePlanLevel(
      committed(['wi_new', 'wi_sibling']),
      [
        item({
          planItemId: 'pi_1',
          nodeId: 'wi_new',
          op: 'add',
          identifier: 'MOTIR-3166',
          parentNodeId: 'parent_1',
          status: 'todo',
        }),
      ],
      'parent_1',
      'accepted',
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['wi_new', 'wi_sibling']);
    expect(level.nodes.filter((n) => n.id === 'wi_new')).toHaveLength(1);
    expect(level.nodes.some((n) => n.id === 'pi_1')).toBe(false);

    renderWithIntl(<>{level.nodes[0]!.content}</>);
    expect(screen.getByTestId('plan-item-outcome').textContent).toBe('accepted');
    expect(screen.getByText('MOTIR-3166')).toBeTruthy();
  });

  it('draws a DECLINED plan proposals in the declined treatment, re-skinning modify/remove in place', () => {
    const level = mergePlanLevel(
      committed(['wi_mod', 'wi_untouched']),
      [
        item({ planItemId: 'pi_a', nodeId: 'pi_a', op: 'add', parentNodeId: 'parent_1' }),
        item({
          planItemId: 'pi_b',
          nodeId: 'wi_mod',
          op: 'modify',
          identifier: 'MOTIR-9',
          parentNodeId: 'parent_1',
        }),
      ],
      'parent_1',
      'declined',
    );

    // The modify re-skinned IN PLACE; the add appended; the untouched sibling
    // left alone. No ghosts.
    expect(level.nodes.map((n) => n.id)).toEqual(['wi_mod', 'wi_untouched', 'pi_a']);

    renderWithIntl(<>{level.nodes[0]!.content}</>);
    expect(screen.getByTestId('plan-item-outcome').textContent).toBe('declined');
    cleanup();

    renderWithIntl(<>{level.nodes[2]!.content}</>);
    expect(screen.getByTestId('plan-item-outcome').textContent).toBe('declined');
    cleanup();

    // The committed neighbour the plan decided NOTHING about carries no outcome.
    renderWithIntl(<>{level.nodes[1]!.content}</>);
    expect(screen.queryByTestId('plan-item-outcome')).toBeNull();
  });

  it('renders the proposals alone when the committed level is empty', () => {
    // The degraded path: a pre-project run, or a roadmap read that failed. The
    // surface still shows the plan rather than blanking.
    const level = mergePlanLevel(
      { nodes: [], deps: [] },
      [item({ planItemId: 'p1', nodeId: 'p1', op: 'add', hasChildren: true })],
      null,
    );

    expect(level.nodes.map((n) => n.id)).toEqual(['p1']);
    expect(level.nodes[0]!.drillable).toBe(true);
  });
});

// ── bug MOTIR-3191 — where the canvas OPENS on a plan of amendments ───────────
//
// `mergePlanLevel` above has always re-skinned a `modify` in place once the
// canvas is on the right level. What decides which level that is, is
// `arrivalLevel` — and a `modify` reached it with a null parent, because it
// carries no `parentRef` and could not. So the canvas opened at the project
// ROOT, where the target is not a child, and the amendment fell through to the
// pushed branch as a node of its own beside the epics.
//
// ⚠️ These pass on `main` too, and that is the finding rather than a gap in
// them: `arrivalLevel` was never the broken half. It reads `parentNodeId` /
// `parentTrail` and does the right thing with whatever it is given — it was
// given null. So this locks the CONSUMER side of the contract the review model
// now satisfies, and the failing-without-the-fix half lives one layer down, in
// `planReviewService`'s own suite, where the null was produced.
// MOTIR-3260 threaded the PROPOSED-crumb word through as an argument, because
// `arrivalLevel` is pure and the word is a translated string the component owns.
// These cases have no proposed ancestor, so the value is never rendered by them;
// it is passed for the signature.
const NEW = 'New';

describe('arrivalLevel', () => {
  it('opens a MODIFY-only plan at its target’s level, not at the root', () => {
    const arrival = arrivalLevel(
      [
        item({
          planItemId: 'pi_1',
          nodeId: 'wi_target',
          op: 'modify',
          identifier: 'MOTIR-3181',
          title: 'An existing card',
          parentNodeId: 'wi_story',
          parentIdentifier: 'MOTIR-3070',
          parentTitle: 'Plan review',
          parentTrail: [
            { id: 'wi_epic', identifier: 'MOTIR-2200', title: 'The agent loop' },
            { id: 'wi_story', identifier: 'MOTIR-3070', title: 'Plan review' },
          ],
        }),
      ],
      NEW,
    );

    expect(arrival?.id).toBe('wi_story');
    // The whole committed chain, so the breadcrumb names the branch the card
    // lives on rather than starting at the level the plan does not touch.
    expect(arrival?.trail.map((c) => c.id)).toEqual(['wi_epic', 'wi_story']);
  });

  it('still opens at the ROOT when the plan genuinely proposes roots', () => {
    // A null parent is now a STATEMENT ("this card is a root"), not the absence
    // of an answer — so the root arrival has to keep working.
    expect(arrivalLevel([item({ op: 'add', parentNodeId: null })], NEW)).toBeNull();
  });

  it('a PROPOSED container counts — the story-and-its-subtasks shape (MOTIR-3260)', () => {
    // ⚠️ THE DEFECT THIS CARD FIXES. `getPlanReview` nulls `parentIdentifier` for
    // an intra-plan (`planItem:`) parent — deliberately, because such a parent is
    // drawn ON the canvas rather than in the breadcrumb — and `arrivalLevel`
    // skipped any item without one. So a plan proposing a story under a committed
    // epic PLUS five subtasks under that story scored ONE edge and opened on the
    // epic, with the five cards it is actually about one undiscoverable drill
    // away.
    const story = item({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      op: 'add',
      title: 'Payout reconciliation',
      parentNodeId: 'wi_epic',
      parentIdentifier: 'MOTIR-653',
      parentTitle: 'Epic 8',
      parentTrail: [{ id: 'wi_epic', identifier: 'MOTIR-653', title: 'Epic 8' }],
    });
    const subs = [0, 1, 2, 3, 4].map((i) =>
      item({
        planItemId: `pi_sub_${i}`,
        nodeId: `pi_sub_${i}`,
        op: 'add',
        title: `Subtask ${i}`,
        parentNodeId: 'pi_story',
        parentIdentifier: null,
        parentTitle: null,
        parentTrail: [],
      }),
    );

    const arrival = arrivalLevel([story, ...subs], NEW);

    expect(arrival?.id).toBe('pi_story');
    // The committed chain, then a crumb for the PROPOSED story — which keeps the
    // committed `KEY · Title` grammar with the word `New` where the key would go,
    // because an un-materialized `add` has no key by construction.
    expect(arrival?.trail.map((c) => c.label)).toEqual([
      'MOTIR-653 · Epic 8',
      'New · Payout reconciliation',
    ]);
  });

  it('resolves a chain nested MORE than one proposal deep, with no gap', () => {
    const epic = item({
      planItemId: 'pi_epic',
      nodeId: 'pi_epic',
      op: 'add',
      title: 'A proposed epic',
      parentNodeId: null,
      parentIdentifier: null,
      parentTrail: [],
    });
    const story = item({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      op: 'add',
      title: 'A proposed story',
      parentNodeId: 'pi_epic',
      parentIdentifier: null,
      parentTrail: [],
    });
    const subs = [0, 1].map((i) =>
      item({
        planItemId: `pi_sub_${i}`,
        nodeId: `pi_sub_${i}`,
        op: 'add',
        parentNodeId: 'pi_story',
        parentIdentifier: null,
        parentTrail: [],
      }),
    );

    const arrival = arrivalLevel([epic, story, ...subs], NEW);

    expect(arrival?.id).toBe('pi_story');
    expect(arrival?.trail.map((c) => c.label)).toEqual([
      'New · A proposed epic',
      'New · A proposed story',
    ]);
  });

  it('the TIE-BREAK is the deeper level, whatever the item order', () => {
    const story = item({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      op: 'add',
      title: 'A story',
      parentNodeId: 'wi_epic',
      parentIdentifier: 'MOTIR-653',
      parentTitle: 'Epic 8',
      parentTrail: [{ id: 'wi_epic', identifier: 'MOTIR-653', title: 'Epic 8' }],
    });
    const sub = item({
      planItemId: 'pi_sub',
      nodeId: 'pi_sub',
      op: 'add',
      parentNodeId: 'pi_story',
      parentIdentifier: null,
      parentTrail: [],
    });

    // 1–1. The shipped code kept whichever the `Map` yielded first.
    expect(arrivalLevel([story, sub], NEW)?.id).toBe('pi_story');
    expect(arrivalLevel([sub, story], NEW)?.id).toBe('pi_story');
  });

  it('an ARCHIVED ancestor still yields a breadcrumb rather than none', () => {
    // `parentTrail: []` beside a non-null `parentNodeId` is the degrade. The
    // single crumb the parent fields still name is what keeps the canvas from
    // arriving with no breadcrumb at all.
    const arrival = arrivalLevel(
      [
        item({
          planItemId: 'pi_1',
          nodeId: 'pi_1',
          op: 'add',
          parentNodeId: 'wi_gone',
          parentIdentifier: 'MOTIR-900',
          parentTitle: 'An archived parent',
          parentTrail: [],
        }),
      ],
      NEW,
    );

    expect(arrival?.id).toBe('wi_gone');
    expect(arrival?.trail.map((c) => c.label)).toEqual(['MOTIR-900 · An archived parent']);
  });

  it('takes the level carrying the MOST proposals when a mixed plan spans two', () => {
    const at = (nodeId: string, parent: string, key: string) =>
      item({
        planItemId: `pi_${nodeId}`,
        nodeId,
        parentNodeId: parent,
        parentIdentifier: key,
        parentTitle: 'A parent',
        parentTrail: [{ id: parent, identifier: key, title: 'A parent' }],
      });

    const arrival = arrivalLevel(
      [at('a', 'wi_p1', 'MOTIR-1'), at('b', 'wi_p2', 'MOTIR-2'), at('c', 'wi_p2', 'MOTIR-2')],
      NEW,
    );

    expect(arrival?.id).toBe('wi_p2');
  });

  it('names a ROOT epic ONCE when the plan both modifies it and adds a story under it (bug MOTIR-6078)', () => {
    // The epic is in the plan through a `modify`, keyed by its work item
    // (MOTIR-3160), so the walk reaches it as a plan node, crumbs it with its
    // key (MOTIR-4266) and runs out at its null parent. The fall-through then
    // prepended the CONTAINER's `parentTrail` — the story's, which already ends
    // at the epic — so the epic was named twice. The TOPMOST item's trail is the
    // one that sits above the walk, and a root's is empty.
    const epic = item({
      planItemId: 'pi_epic',
      nodeId: 'wi_epic',
      op: 'modify',
      identifier: 'MOTIR-6010',
      title: 'Refine AI planning',
      parentNodeId: null,
      parentIdentifier: null,
      parentTrail: [],
    });
    const story = item({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      op: 'add',
      title: 'A refusal story',
      parentNodeId: 'wi_epic',
      parentIdentifier: 'MOTIR-6010',
      parentTitle: 'Refine AI planning',
      parentTrail: [{ id: 'wi_epic', identifier: 'MOTIR-6010', title: 'Refine AI planning' }],
    });
    const subs = [0, 1, 2].map((i) =>
      item({
        planItemId: `pi_sub_${i}`,
        nodeId: `pi_sub_${i}`,
        op: 'add',
        parentNodeId: 'pi_story',
        parentIdentifier: null,
        parentTrail: [],
      }),
    );

    const arrival = arrivalLevel([epic, story, ...subs], NEW);

    expect(arrival?.id).toBe('pi_story');
    expect(arrival?.trail.map((c) => c.id)).toEqual(['wi_epic', 'pi_story']);
    expect(arrival?.trail.map((c) => c.label)).toEqual([
      'MOTIR-6010 · Refine AI planning',
      'New · A refusal story',
    ]);
  });
});

// ── THE REMOVED EDGE (bug MOTIR-4092) ────────────────────────────────────────
//
// `mergePlanLevel` started from the committed deps VERBATIM, so an edge a plan
// proposes to delete kept rendering exactly like one it keeps. The shape that
// makes that wrong rather than merely incomplete is an EDGE SWAP — the
// correction for an inverted dependency, and the standard output of the run-time
// correction path. It is necessarily two `modify` proposals, so with the removal
// unread the canvas drew BOTH directions: a mutual block, i.e. a cycle the
// approve will not produce.
//
// ⚠️ THE ANSWER IS SUBTRACTION (bug MOTIR-4098), reversing the first fix, which kept
// the edge and marked it as going away. A drawn arrow is read as STRUCTURE
// however it is skinned — what blocks what — so a canvas carrying lines the
// reader must decode as *ignore me* is the confusing picture the marking was
// meant to fix. The words for the change live in the `links` diff row; the graph
// draws what approving would LEAVE BEHIND.
describe('mergePlanLevel — an edge the plan REMOVES', () => {
  function committed(ids: string[], deps: PlanCanvasLevel['deps'] = []): PlanCanvasLevel {
    return {
      nodes: ids.map((id) => ({
        id,
        parentId: 'parent_1',
        searchText: id,
        crumbLabel: id,
        drillable: false,
        content: <span>{id}</span>,
      })),
      deps,
    };
  }

  it('DROPS the committed dep — it does not draw it in any variant', () => {
    // Not re-skinned, not faded, not struck: gone. The canvas is read for its
    // shape, and an edge the approve deletes is not part of the shape.
    const level = mergePlanLevel(
      committed(['wi_a', 'wi_b'], [{ from: 'wi_a', to: 'wi_b' }]),
      [
        item({
          planItemId: 'p1',
          nodeId: 'wi_b',
          op: 'modify',
          parentNodeId: 'parent_1',
          blockedByRemovedNodeIds: ['wi_a'],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([]);
  });

  it('leaves a committed dep the plan does NOT name alone', () => {
    const level = mergePlanLevel(
      committed(
        ['wi_a', 'wi_b', 'wi_c'],
        [
          { from: 'wi_a', to: 'wi_b' },
          { from: 'wi_b', to: 'wi_c' },
        ],
      ),
      [
        item({
          planItemId: 'p1',
          nodeId: 'wi_b',
          op: 'modify',
          parentNodeId: 'parent_1',
          blockedByRemovedNodeIds: ['wi_a'],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([{ from: 'wi_b', to: 'wi_c' }]);
  });

  it('an EDGE SWAP renders as ONE arrow, NOT as a mutual block', () => {
    // The fixture is the live one this bug was found on: plan
    // `cmtijiwul00a1hvn8dek1ok8w` proposes `modify MOTIR-4058` removing its
    // blocker MOTIR-4057, and `modify MOTIR-4057` adding MOTIR-4058 — the
    // inverted-dependency correction. Before the fix the canvas drew a → b AND
    // b → a with nothing to tell them apart.
    const level = mergePlanLevel(
      committed(['wi_4057', 'wi_4058'], [{ from: 'wi_4057', to: 'wi_4058' }]),
      [
        item({
          planItemId: 'p_4058',
          nodeId: 'wi_4058',
          op: 'modify',
          parentNodeId: 'parent_1',
          blockedByRemovedNodeIds: ['wi_4057'],
        }),
        item({
          planItemId: 'p_4057',
          nodeId: 'wi_4057',
          op: 'modify',
          parentNodeId: 'parent_1',
          blockedByNodeIds: ['wi_4058'],
        }),
      ],
      'parent_1',
    );

    // The assertion that actually names the defect: the swap draws the ONE edge
    // the approve leaves behind, pointing the corrected way. There is no reading
    // of this picture that shows a mutual block, because only one line exists.
    expect(level.deps).toEqual([{ from: 'wi_4058', to: 'wi_4057', variant: 'pending' }]);
  });

  it('ignores a removal naming an edge that is not on this level', () => {
    // A `blockedByRemove` whose edge is not among the committed deps subtracts
    // nothing — the same tolerance the ADD carrier already has.
    const level = mergePlanLevel(
      committed(['wi_a', 'wi_b'], [{ from: 'wi_a', to: 'wi_b' }]),
      [
        item({
          planItemId: 'p1',
          nodeId: 'wi_b',
          op: 'modify',
          parentNodeId: 'parent_1',
          blockedByRemovedNodeIds: ['wi_elsewhere'],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([{ from: 'wi_a', to: 'wi_b' }]);
  });
});

// ── bug MOTIR-4951 — a card the plan RE-PARENTS onto a level brings its EDGES ─
//
// Reported by Yue while reviewing a real plan: *"before I approved the plan I
// don't see the edge from 4942 to 4925, after I approved the plan I see the
// edge."* Nothing about the edge changed at any point — it was committed before
// the plan was written and untouched by it. Only the DRAWING changed.
//
// `mergePlanLevel` seeds its dep list from the COMMITTED level it is handed, and
// that level is the destination's CURRENT children. A card the plan is moving is
// exactly the card that is not among them yet, so its committed edges are in
// `committed.deps` nowhere — and they are in neither PLAN carrier either, since
// a relocation proposes no edge. The card arrived as a NODE and never as an
// ENDPOINT.
//
// ⚠️ THE FAILURE IS BIASED TOWARD FALSE CONFIDENCE, which is why it is worth a
// block of its own. A missing arrow is not a blank space: the canvas is read for
// its SHAPE, so an absent edge asserts *these are independent* — a claim, not an
// absence — and a reviewer has no way to tell it from a real one. A relocation
// plan, whose whole subject is moving cards into a container so they can be
// worked in some order, rendered as a handful of unrelated cards side by side.
//
// It is the SAME COMMITTED-only trap `mergePlanLevel`'s own MOTIR-4266 comment
// names for `drillable`, one field over and from the identical cause.
describe('mergePlanLevel — a RE-PARENTED card’s committed edges', () => {
  function committed(ids: string[], deps: PlanCanvasLevel['deps'] = []): PlanCanvasLevel {
    return {
      nodes: ids.map((id) => ({
        id,
        parentId: 'parent_1',
        searchText: id,
        crumbLabel: id,
        drillable: false,
        content: <span>{id}</span>,
      })),
      deps,
    };
  }

  it('draws the committed edge between two cards the plan moves onto this level', () => {
    // The reported fixture, at the shape the model sees it: MOTIR-4925
    // `blocked_by` MOTIR-4942, both re-parented onto MOTIR-4878's level by one
    // plan. Neither is a committed child of that level yet, so `committed` holds
    // only the level's own fifteen — here, one stand-in.
    const level = mergePlanLevel(
      committed(['wi_existing']),
      [
        item({
          planItemId: 'p_4942',
          nodeId: 'wi_4942',
          op: 'modify',
          identifier: 'MOTIR-4942',
          parentNodeId: 'parent_1',
        }),
        item({
          planItemId: 'p_4925',
          nodeId: 'wi_4925',
          op: 'modify',
          identifier: 'MOTIR-4925',
          parentNodeId: 'parent_1',
          committedBlockedBy: [{ nodeId: 'wi_4942', isDone: false }],
        }),
      ],
      'parent_1',
    );

    // Both relocated cards are on the level…
    expect(level.nodes.map((n) => n.id)).toEqual(['wi_existing', 'wi_4942', 'wi_4925']);
    // …and so is the arrow between them, BEFORE anybody approves anything.
    expect(level.deps).toEqual([{ from: 'wi_4942', to: 'wi_4925', variant: 'pending' }]);
  });

  it('draws it as a COMMITTED edge — `firm` once the blocker is done, never a proposal', () => {
    // Approving creates nothing here, so the edge must not be drawn the way an
    // edge approving WOULD create is drawn. `buildWorkItemLevel`'s rule for every
    // within-level committed edge is status-derived, and this is the same rule:
    // a `done` blocker draws `firm`. The proposed loop, by contrast, pushes
    // `pending` unconditionally — which is what makes the two distinguishable.
    const level = mergePlanLevel(
      committed([]),
      [
        item({ planItemId: 'p_a', nodeId: 'wi_a', op: 'modify', parentNodeId: 'parent_1' }),
        item({
          planItemId: 'p_b',
          nodeId: 'wi_b',
          op: 'modify',
          parentNodeId: 'parent_1',
          committedBlockedBy: [{ nodeId: 'wi_a', isDone: true }],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([{ from: 'wi_a', to: 'wi_b', variant: 'firm' }]);
  });

  it('draws NOTHING for an off-level blocker the review model could not NAME', () => {
    // A card moved in alone keeps a blocker that is still somewhere else. With a
    // stub, that blocker takes the off-level treatment (bug MOTIR-5387, below);
    // WITHOUT one — archived, deleted, out of reach — there is nothing to put on
    // an anchor, so nothing is drawn rather than a `—` standing in for it.
    const level = mergePlanLevel(
      committed(['wi_existing']),
      [
        item({
          planItemId: 'p_moved',
          nodeId: 'wi_moved',
          op: 'modify',
          parentNodeId: 'parent_1',
          committedBlockedBy: [{ nodeId: 'wi_elsewhere', isDone: false }],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([]);
  });

  it('still DROPS one the plan removes — MOTIR-4092 / MOTIR-4098 are not regressed', () => {
    // The property the widening could most easily have broken, and the reason
    // the new loop runs AFTER the removal filter and consults `removedPairs`
    // itself: a committed edge that reaches the level through this new door must
    // be as removable as one that reaches it through `committed.deps`. Without
    // the second check the edge would be filtered out of the seed list and put
    // straight back by the loop below it.
    const level = mergePlanLevel(
      committed([]),
      [
        item({ planItemId: 'p_a', nodeId: 'wi_a', op: 'modify', parentNodeId: 'parent_1' }),
        item({
          planItemId: 'p_b',
          nodeId: 'wi_b',
          op: 'modify',
          parentNodeId: 'parent_1',
          committedBlockedBy: [{ nodeId: 'wi_a', isDone: false }],
          blockedByRemovedNodeIds: ['wi_a'],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([]);
  });

  it('does not double-draw an edge the committed level already carries', () => {
    // A `modify` that does NOT re-parent has its target among the level's
    // committed children, so the same edge arrives from both sources. It is one
    // arrow, in the variant the committed read gave it — the new loop must not
    // append a second, nor re-decide the first.
    const level = mergePlanLevel(
      committed(['wi_a', 'wi_b'], [{ from: 'wi_a', to: 'wi_b', variant: 'firm' }]),
      [
        item({
          planItemId: 'p_b',
          nodeId: 'wi_b',
          op: 'modify',
          parentNodeId: 'parent_1',
          committedBlockedBy: [{ nodeId: 'wi_a', isDone: false }],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([{ from: 'wi_a', to: 'wi_b', variant: 'firm' }]);
  });

  it('leaves a PROPOSED edge on the same pair as the one arrow the plan means', () => {
    // A plan may propose an edge that is already wired (the canvas has always
    // tolerated it). The committed reading wins, because it is the true one:
    // approving does not create this edge, and drawing it `pending` when its
    // blocker is done would say it does.
    const level = mergePlanLevel(
      committed([]),
      [
        item({ planItemId: 'p_a', nodeId: 'wi_a', op: 'modify', parentNodeId: 'parent_1' }),
        item({
          planItemId: 'p_b',
          nodeId: 'wi_b',
          op: 'modify',
          parentNodeId: 'parent_1',
          committedBlockedBy: [{ nodeId: 'wi_a', isDone: true }],
          blockedByNodeIds: ['wi_a'],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([{ from: 'wi_a', to: 'wi_b', variant: 'firm' }]);
  });

  it('ignores a self-edge, as the proposed loop does', () => {
    const level = mergePlanLevel(
      committed([]),
      [
        item({
          planItemId: 'p_a',
          nodeId: 'wi_a',
          op: 'modify',
          parentNodeId: 'parent_1',
          committedBlockedBy: [{ nodeId: 'wi_a', isDone: false }],
        }),
      ],
      'parent_1',
    );

    expect(level.deps).toEqual([]);
  });
});

// ── A BLOCKER THE PLAN MOVES ONTO THE LEVEL (bug MOTIR-4952) ────────────────
//
// The block above is the same plan shape with the endpoints the other way round,
// and it fails differently: not by omission, but by drawing the wrong thing.
//
// There the plan re-parents the BLOCKED card, whose committed edges reach no
// carrier at all. Here it re-parents the BLOCKER, and the edge is already in
// `committed.deps` — correctly derived, and wrong one step later. `buildWorkItemLevel`
// asked *is the blocker among this level's children?*, got a truthful NO, and
// applied the whole cross-story treatment: a red `cross` arrow, the `crossBlocked`
// ring on the dependent, and a GHOST ANCHOR standing in for the blocker. Then
// `mergePlanLevel` put the blocker on the level — re-skinning that very anchor,
// because its node id IS the blocker's work-item id — and revisited none of it.
//
// ⚠️ THIS ONE FAILS TOWARD FALSE ALARM, which is the mirror of MOTIR-4951's bias
// and just as misleading. `cross` is not a neutral skin: this module's own comment
// calls it *"the CROSS-STORY tangle (a bad plan)"*. So the surface a plan is
// approved from raised its bad-plan flag in the one case where the plan's whole
// purpose is to REMOVE that condition by moving the blocker in.
//
// The repair is at the SOURCE rather than in `mergePlanLevel`, because two of the
// three effects are unreachable downstream: the ring is baked into the dependent's
// rendered `content`, and the anchor has already been minted. Told which blockers
// are arriving, the builder emits none of the three, and `mergePlanLevel`'s ordinary
// proposal push supplies the node from the proposal itself.
describe('buildWorkItemLevel — a blocker the plan MOVES ONTO this level', () => {
  function level(over: Partial<RoadmapLevelData> = {}): RoadmapLevelData {
    return {
      items: [
        {
          id: 'wi_committed',
          parentId: 'parent_1',
          identifier: 'MOTIR-1',
          title: 'A committed child',
          kind: 'subtask',
          status: 'todo',
          hasChildren: false,
        },
      ],
      edges: [{ blockedId: 'wi_committed', blockerId: 'wi_relocated' }],
      offLevelBlockers: [
        {
          id: 'wi_relocated',
          identifier: 'MOTIR-2',
          title: 'The blocker the plan moves in',
          parentTitle: null,
          isDone: false,
        },
      ],
      ...over,
    };
  }

  /** The `modify` that relocates the blocker onto `parent_1`. */
  function relocating(status: string | null = 'todo'): PlanReviewItemDto {
    return item({
      planItemId: 'p_relocated',
      nodeId: 'wi_relocated',
      op: 'modify',
      identifier: 'MOTIR-2',
      title: 'The blocker the plan moves in',
      parentNodeId: 'parent_1',
      status,
    });
  }

  it('draws the committed edge WITHIN the level, not as the cross-story tangle', () => {
    const merged = mergePlanLevel(
      buildWorkItemLevel(level(), {
        arrivingBlockers: new Map([['wi_relocated', false]]),
      }),
      [relocating()],
      'parent_1',
    );

    expect(merged.nodes.map((n) => n.id)).toEqual(['wi_committed', 'wi_relocated']);
    expect(merged.deps).toEqual([{ from: 'wi_relocated', to: 'wi_committed', variant: 'pending' }]);
  });

  it('draws it `firm` when the relocating blocker is done — the within-level rule', () => {
    // Status-derived, exactly as every other committed edge is, so the arrow the
    // reviewer sees before approve is the arrow the tree draws after it.
    const built = buildWorkItemLevel(level(), {
      arrivingBlockers: new Map([['wi_relocated', true]]),
    });

    expect(built.deps).toEqual([{ from: 'wi_relocated', to: 'wi_committed', variant: 'firm' }]);
  });

  it('leaves the dependent WITHOUT the off-level ring, and mints no ghost anchor', () => {
    // The two effects `mergePlanLevel` cannot reach: `crossBlocked` is baked into
    // the dependent's rendered content, and the anchor is a node that already
    // exists by the time the merge runs. Neither is emitted at all now — the only
    // node the builder returns is the committed child, and the blocker's node
    // arrives from the proposal.
    const built = buildWorkItemLevel(level(), {
      arrivingBlockers: new Map([['wi_relocated', false]]),
    });

    expect(built.nodes.map((n) => n.id)).toEqual(['wi_committed']);
    renderWithIntl(<>{built.nodes[0]!.content}</>);
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();

    // …and the node the reviewer ends up with is the PROPOSAL's, not a re-skinned
    // anchor: it carries the plan's parent and its own search text, where the
    // anchor was minted `parentId: null` with the stub's.
    const merged = mergePlanLevel(built, [relocating()], 'parent_1');
    const node = merged.nodes.find((n) => n.id === 'wi_relocated')!;
    expect(node.parentId).toBe('parent_1');
    expect(node.searchText).toBe('MOTIR-2 The blocker the plan moves in');
  });

  it('leaves a blocker that genuinely STAYS off the level alone — cross, ring and anchor', () => {
    // The control criterion 2 asks for. The narrowing keys on the blocker being a
    // proposal AT THIS LEVEL, never on a node with that id being present: the
    // ghost anchor has always carried the blocker's own work-item id, so a
    // presence test would have silenced every cross-story edge on the canvas.
    const built = buildWorkItemLevel(level());

    expect(built.deps).toEqual([{ from: 'wi_relocated', to: 'wi_committed', variant: 'cross' }]);
    expect(built.nodes.map((n) => n.id)).toEqual(['wi_committed', 'wi_relocated']);
    renderWithIntl(<>{built.nodes[0]!.content}</>);
    expect(screen.getByTestId('cross-blocked-flag')).toBeTruthy();
  });

  it('is inert for a blocker that is already a committed child of the level', () => {
    // A `modify` that does NOT re-parent: its target is on the level already, so
    // the within-level branch answers first and the new map is never consulted.
    const built = buildWorkItemLevel(
      {
        items: [
          {
            id: 'wi_a',
            parentId: 'parent_1',
            identifier: 'MOTIR-1',
            title: 'The blocker',
            kind: 'subtask',
            status: 'done',
            hasChildren: false,
          },
          {
            id: 'wi_b',
            parentId: 'parent_1',
            identifier: 'MOTIR-2',
            title: 'The dependent',
            kind: 'subtask',
            status: 'todo',
            hasChildren: false,
          },
        ],
        edges: [{ blockedId: 'wi_b', blockerId: 'wi_a' }],
        offLevelBlockers: [],
      },
      { arrivingBlockers: new Map([['wi_a', false]]) },
    );

    // `firm` from the level's OWN status read, not `pending` from the map.
    expect(built.deps).toEqual([{ from: 'wi_a', to: 'wi_b', variant: 'firm' }]);
  });
});

// ── A CARD THE PLAN MOVES OFF THE LEVEL (bug MOTIR-5006) ─────────────────────
//
// The two blocks above are this plan shape read from the DESTINATION. This one
// reads it from the ORIGIN, and it is the field neither of them is about: not the
// card's arrows or its skin, but whether the card is on the level at all.
//
// `planReviewService`'s `parentNodeIdOf` reports a re-parented card at its NEW
// parent — correctly, and for a reason its own comment states: drawing it in its
// old level *"would be the plan review showing the approver the opposite of what
// approving does."* The consequence at the origin was never taken: the card fell
// out of `proposalsAtLevel`, so nothing re-skinned it, nothing dropped it, and it
// sat among its siblings with its committed arrows intact — indistinguishable
// from a card nobody proposed to touch, on a level whose membership may be the
// plan's whole subject.
//
// THE DISPOSITION, stated in full in `mergePlanLevel`'s own comment: the card
// leaves the level and its edges take the OFF-LEVEL path. That is what the level
// looks like after approve — no such child, and a cross-container blocker where
// the arrow used to be — and it is the rule MOTIR-4098 already settled here for a
// removed edge (*"the graph draws what approving would LEAVE BEHIND"*), applied to
// the stronger claim a NODE makes.
//
// At the SOURCE, like MOTIR-4952 and for its reason: the `crossBlocked` ring is
// baked into the dependent's rendered content and the anchor is minted before the
// merge runs, so neither is reachable from `mergePlanLevel`.
describe('buildWorkItemLevel — a card the plan MOVES OFF this level', () => {
  function level(over: Partial<RoadmapLevelData> = {}): RoadmapLevelData {
    return {
      items: [
        {
          id: 'wi_stays',
          parentId: 'parent_1',
          identifier: 'MOTIR-1',
          title: 'The child that stays',
          kind: 'subtask',
          status: 'todo',
          hasChildren: false,
        },
        {
          id: 'wi_leaving',
          parentId: 'parent_1',
          identifier: 'MOTIR-2',
          title: 'The child the plan moves out',
          kind: 'subtask',
          status: 'todo',
          hasChildren: false,
        },
      ],
      edges: [{ blockedId: 'wi_stays', blockerId: 'wi_leaving' }],
      offLevelBlockers: [],
      ...over,
    };
  }

  /** The `modify` that re-parents `wi_leaving` onto some OTHER level. */
  function relocating(): PlanReviewItemDto {
    return item({
      planItemId: 'p_leaving',
      nodeId: 'wi_leaving',
      op: 'modify',
      identifier: 'MOTIR-2',
      title: 'The child the plan moves out',
      parentNodeId: 'parent_2',
      status: 'todo',
    });
  }

  it('takes the departing card OFF the level it is leaving', () => {
    // Criterion 1. Before this, both nodes were drawn and the departing one still
    // carried the COMMITTED content the read supplied — not a `PlanItemNode` — so
    // nothing on the level said it was going anywhere.
    const merged = mergePlanLevel(
      buildWorkItemLevel(level(), { departingIds: new Set(['wi_leaving']) }),
      [relocating()],
      'parent_1',
    );

    expect(merged.nodes.map((n) => n.id)).toEqual(['wi_stays', 'wi_leaving']);
    // …and the second is the ghost ANCHOR, not a child: an anchor is minted
    // `parentId: null` and is not drillable, where the committed row was a child
    // of `parent_1`.
    const anchor = merged.nodes.find((n) => n.id === 'wi_leaving')!;
    expect(anchor.parentId).toBeNull();
    expect(anchor.drillable).toBe(false);
    expect(anchor.searchText).toBe('MOTIR-2 The child the plan moves out');
  });

  it('draws the edge to a card that stays as the cross-container tangle', () => {
    // Criterion 2 — the nodes and the arrows cannot disagree about whether the
    // card is there. The edge is NOT kept as the within-level `pending` arrow it
    // was, and it is not dropped either: it is what the level draws after approve.
    const built = buildWorkItemLevel(level(), { departingIds: new Set(['wi_leaving']) });

    expect(built.deps).toEqual([{ from: 'wi_leaving', to: 'wi_stays', variant: 'cross' }]);
    renderWithIntl(<>{built.nodes[0]!.content}</>);
    expect(screen.getByTestId('cross-blocked-flag')).toBeTruthy();
  });

  it('drops an edge whose BLOCKED end is the one departing', () => {
    // The other direction. After approve the blocked card is not on this level, so
    // neither is its arrow — the same answer the roadmap read gives unaided, which
    // is why no new branch is needed for it.
    const built = buildWorkItemLevel(
      level({ edges: [{ blockedId: 'wi_leaving', blockerId: 'wi_stays' }] }),
      { departingIds: new Set(['wi_leaving']) },
    );

    expect(built.deps).toEqual([]);
    expect(built.nodes.map((n) => n.id)).toEqual(['wi_stays']);
  });

  it('leaves a `modify` that does NOT re-parent exactly where it was', () => {
    // The control criterion 4 asks for. The narrowing keys on the proposal's
    // `parentNodeId` DIFFERING from the level being built, never on the card being
    // named by the plan — so an ordinary in-place `modify` is untouched: both
    // children stay, the committed arrow stays within the level, and the target is
    // re-skinned as the proposal.
    const inPlace = item({
      planItemId: 'p_stays',
      nodeId: 'wi_leaving',
      op: 'modify',
      identifier: 'MOTIR-2',
      title: 'The child the plan re-titles',
      parentNodeId: 'parent_1',
      status: 'todo',
    });
    const merged = mergePlanLevel(
      buildWorkItemLevel(level(), { departingIds: new Set() }),
      [inPlace],
      'parent_1',
    );

    expect(merged.nodes.map((n) => n.id)).toEqual(['wi_stays', 'wi_leaving']);
    expect(merged.nodes.find((n) => n.id === 'wi_leaving')!.parentId).toBe('parent_1');
    expect(merged.deps).toEqual([{ from: 'wi_leaving', to: 'wi_stays', variant: 'pending' }]);
  });

  it('is inert when no plan supplies the set — every consumer but the review canvas', () => {
    // Absent / empty is the pre-MOTIR-5006 behaviour, which is what keeps the
    // roadmap, the onboarding canvas and the plan-change canvas untouched.
    const built = buildWorkItemLevel(level());

    expect(built.nodes.map((n) => n.id)).toEqual(['wi_stays', 'wi_leaving']);
    expect(built.deps).toEqual([{ from: 'wi_leaving', to: 'wi_stays', variant: 'pending' }]);
  });
});

// ── bug MOTIR-5387 — a PROPOSAL blocked by a card OFF this level ─────────────
//
// The roadmap draws an off-level blocker with three effects — a `cross` arrow, a
// viewable ghost anchor naming the blocker, and the dependent's "blocked
// elsewhere" chip — and `buildWorkItemLevel` is where they come from. A
// proposal's OWN edges never reached that branch: `mergePlanLevel` dropped every
// one whose blocker was not on the level, so a plan adding a cross-container
// dependency drew nothing until it was approved, which is the moment the warning
// stops being able to change the decision.
describe('mergePlanLevel — a proposal blocked by a card OFF this level (bug MOTIR-5387)', () => {
  /** Story `wi-s`'s level as the roadmap read returns it BEFORE approve. */
  function storyLevel(over: Partial<RoadmapLevelData> = {}): RoadmapLevelData {
    return {
      items: [
        {
          id: 'wi-a',
          parentId: 'wi-s',
          identifier: 'MOTIR-1',
          title: 'A committed child',
          kind: 'subtask',
          status: 'todo',
          hasChildren: false,
        },
      ],
      edges: [],
      offLevelBlockers: [],
      ...over,
    };
  }

  /** The committed read's stub for `wi-x`, the blocker under another story. */
  const ROADMAP_STUB = {
    id: 'wi-x',
    identifier: 'MOTIR-9',
    title: 'The blocker under another story',
    parentTitle: null,
    isDone: false,
  };

  /** The review model's stub for the same blocker. */
  const OFF_STUB = {
    nodeId: 'wi-x',
    identifier: 'MOTIR-9',
    title: 'The blocker under another story',
    isDone: false,
    parentNodeId: 'wi-other',
  };

  function added(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
    return item({
      planItemId: 'pi_1',
      nodeId: 'pi_1',
      op: 'add',
      title: 'The new card',
      parentNodeId: 'wi-s',
      blockedByNodeIds: ['wi-x'],
      blockerStubs: [OFF_STUB],
      ...over,
    });
  }

  /** Does this node's rendered content carry the "blocked elsewhere" chip? */
  function flagged(node: ProjectCanvasNode | undefined): boolean {
    renderWithIntl(<>{node?.content}</>);
    const hit = screen.queryByTestId('cross-blocked-flag') !== null;
    cleanup();
    return hit;
  }

  /** The text of the ONE anchor the level draws for `id`. */
  function anchorText(level: PlanCanvasLevel, id: string): string {
    const anchors = level.nodes.filter((n) => n.id === id);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.viewable).toBe(true);
    const { container } = renderWithIntl(<>{anchors[0]!.content}</>);
    const text = container.textContent ?? '';
    cleanup();
    return text;
  }

  it('draws the SAME three effects before approve that the roadmap draws after it', () => {
    // AFTER approve: the add is a committed child, and the edge + stub come off
    // the roadmap read. This half passed on the unfixed code — it is the target.
    const after = buildWorkItemLevel(
      storyLevel({
        items: [
          ...storyLevel().items,
          {
            id: 'wi-new',
            parentId: 'wi-s',
            identifier: 'MOTIR-10',
            title: 'The new card',
            kind: 'subtask',
            status: 'todo',
            hasChildren: false,
          },
        ],
        edges: [{ blockedId: 'wi-new', blockerId: 'wi-x' }],
        offLevelBlockers: [ROADMAP_STUB],
      }),
    );
    expect(after.deps).toEqual([{ from: 'wi-x', to: 'wi-new', variant: 'cross' }]);
    expect(anchorText(after, 'wi-x')).toContain('MOTIR-9');
    expect(flagged(after.nodes.find((n) => n.id === 'wi-new'))).toBe(true);

    // BEFORE approve: the same card, the same dependency, on the same level. On
    // the unfixed code `deps` came back EMPTY here.
    const before = mergePlanLevel(buildWorkItemLevel(storyLevel()), [added()], 'wi-s');
    expect(before.deps).toEqual([{ from: 'wi-x', to: 'pi_1', variant: 'cross' }]);
    const text = anchorText(before, 'wi-x');
    expect(text).toContain('MOTIR-9');
    expect(text).toContain('The blocker under another story');
    expect(flagged(before.nodes.find((n) => n.id === 'pi_1'))).toBe(true);
  });

  it('draws them for a MODIFY whose `patch.blockedByAdd` names an off-level card — on the re-skinned node', () => {
    // `blockedByNodeIds` is where the review model resolves `patch.blockedByAdd`
    // to (MOTIR-3366), so the modify carries the edge exactly as an add does.
    const before = mergePlanLevel(
      buildWorkItemLevel(storyLevel()),
      [added({ planItemId: 'pi_mod', nodeId: 'wi-a', op: 'modify', identifier: 'MOTIR-1' })],
      'wi-s',
    );

    expect(before.deps).toEqual([{ from: 'wi-x', to: 'wi-a', variant: 'cross' }]);
    expect(anchorText(before, 'wi-x')).toContain('MOTIR-9');
    renderWithIntl(<>{before.nodes.find((n) => n.id === 'wi-a')?.content}</>);
    expect(screen.getByTestId('plan-item-node').getAttribute('data-op')).toBe('modify');
    expect(screen.getByTestId('cross-blocked-flag')).toBeTruthy();
  });

  it('draws them for a card the plan RE-PARENTS here whose committed blocker stays elsewhere', () => {
    const before = mergePlanLevel(
      buildWorkItemLevel(storyLevel()),
      [
        added({
          planItemId: 'pi_moved',
          nodeId: 'wi-moved',
          op: 'modify',
          identifier: 'MOTIR-5',
          blockedByNodeIds: [],
          committedBlockedBy: [{ nodeId: 'wi-x', isDone: true }],
        }),
      ],
      'wi-s',
    );

    // `cross` whatever the blocker's status — the roadmap's off-level variant.
    expect(before.deps).toEqual([{ from: 'wi-x', to: 'wi-moved', variant: 'cross' }]);
    expect(flagged(before.nodes.find((n) => n.id === 'wi-moved'))).toBe(true);
  });

  it('names a blocker that is itself a PROPOSAL by the proposed word, never by a key', () => {
    const before = mergePlanLevel(
      buildWorkItemLevel(storyLevel()),
      [
        added({
          blockedByNodeIds: ['pi_elsewhere'],
          blockerStubs: [
            {
              nodeId: 'pi_elsewhere',
              identifier: null,
              title: 'A card the plan adds elsewhere',
              isDone: false,
              parentNodeId: 'wi-other',
            },
          ],
        }),
      ],
      'wi-s',
    );

    expect(before.deps).toEqual([{ from: 'pi_elsewhere', to: 'pi_1', variant: 'cross' }]);
    const text = anchorText(before, 'pi_elsewhere');
    expect(text).toContain('New');
    expect(text).toContain('A card the plan adds elsewhere');
    expect(text).not.toMatch(/MOTIR-/);
  });

  it('leaves a blocker ON the level as it was — a plain `pending` arrow, no chip, no anchor', () => {
    const before = mergePlanLevel(
      buildWorkItemLevel(storyLevel()),
      [
        added({
          blockedByNodeIds: ['wi-a'],
          blockerStubs: [
            {
              nodeId: 'wi-a',
              identifier: 'MOTIR-1',
              title: 'A committed child',
              isDone: false,
              parentNodeId: 'wi-s',
            },
          ],
        }),
      ],
      'wi-s',
    );

    expect(before.deps).toEqual([{ from: 'wi-a', to: 'pi_1', variant: 'pending' }]);
    expect(before.nodes.map((n) => n.id)).toEqual(['wi-a', 'pi_1']);
    expect(flagged(before.nodes.find((n) => n.id === 'pi_1'))).toBe(false);
  });

  it('draws no chip about a blocker the plan MOVES ONTO this level (MOTIR-4952, for a proposal)', () => {
    const relocating = item({
      planItemId: 'pi_reloc',
      nodeId: 'wi-x',
      op: 'modify',
      identifier: 'MOTIR-9',
      title: 'The blocker under another story',
      parentNodeId: 'wi-s',
    });
    const before = mergePlanLevel(
      buildWorkItemLevel(storyLevel()),
      [relocating, added({ blockerStubs: [{ ...OFF_STUB, parentNodeId: 'wi-s' }] })],
      'wi-s',
    );

    expect(before.deps).toEqual([{ from: 'wi-x', to: 'pi_1', variant: 'pending' }]);
    expect(before.nodes.map((n) => n.id)).toEqual(['wi-a', 'wi-x', 'pi_1']);
    expect(flagged(before.nodes.find((n) => n.id === 'pi_1'))).toBe(false);
  });

  it('treats a blocker the capped read DROPPED from this level as a member, not as elsewhere (MOTIR-5043)', () => {
    const before = mergePlanLevel(
      buildWorkItemLevel(storyLevel()),
      [
        added({
          blockedByNodeIds: ['wi-capped'],
          blockerStubs: [
            {
              nodeId: 'wi-capped',
              identifier: 'MOTIR-300',
              title: 'A sibling past the cap',
              isDone: false,
              parentNodeId: 'wi-s',
            },
          ],
        }),
      ],
      'wi-s',
    );

    expect(before.deps).toEqual([{ from: 'wi-capped', to: 'pi_1', variant: 'pending' }]);
    expect(before.nodes.some((n) => n.id === 'wi-capped')).toBe(false);
    expect(flagged(before.nodes.find((n) => n.id === 'pi_1'))).toBe(false);
  });

  it('mints ONE anchor per blocker — shared with a committed sibling the builder already anchored', () => {
    const level = storyLevel({
      edges: [{ blockedId: 'wi-a', blockerId: 'wi-x' }],
      offLevelBlockers: [ROADMAP_STUB],
    });
    const before = mergePlanLevel(
      buildWorkItemLevel(level),
      [added(), added({ planItemId: 'pi_2', nodeId: 'pi_2', title: 'A second new card' })],
      'wi-s',
    );

    expect(before.nodes.filter((n) => n.id === 'wi-x')).toHaveLength(1);
    expect(before.deps).toEqual([
      { from: 'wi-x', to: 'wi-a', variant: 'cross' },
      { from: 'wi-x', to: 'pi_1', variant: 'cross' },
      { from: 'wi-x', to: 'pi_2', variant: 'cross' },
    ]);
    expect(flagged(before.nodes.find((n) => n.id === 'pi_1'))).toBe(true);
    expect(flagged(before.nodes.find((n) => n.id === 'pi_2'))).toBe(true);
  });

  it('keeps the chip on a committed card a MODIFY re-skins — and drops it when the plan deletes that edge', () => {
    const level = storyLevel({
      edges: [{ blockedId: 'wi-a', blockerId: 'wi-x' }],
      offLevelBlockers: [ROADMAP_STUB],
    });
    const amend = (over: Partial<PlanReviewItemDto> = {}) =>
      item({
        planItemId: 'pi_mod',
        nodeId: 'wi-a',
        op: 'modify',
        identifier: 'MOTIR-1',
        title: 'A committed child',
        parentNodeId: 'wi-s',
        ...over,
      });

    const kept = mergePlanLevel(buildWorkItemLevel(level), [amend()], 'wi-s');
    expect(flagged(kept.nodes.find((n) => n.id === 'wi-a'))).toBe(true);

    const deleted = mergePlanLevel(
      buildWorkItemLevel(level),
      [amend({ blockedByRemovedNodeIds: ['wi-x'] })],
      'wi-s',
    );
    expect(deleted.deps).toEqual([]);
    expect(flagged(deleted.nodes.find((n) => n.id === 'wi-a'))).toBe(false);
  });
});

// ── bug MOTIR-5389 — the ANCHOR of an edge the plan deletes ──────────────────
//
// MOTIR-5387 took the "blocked elsewhere" chip off a card when the plan deletes
// its only `cross` edge. The ghost anchor at the other end of that edge is a
// node in `committed.nodes`, and the node map passed it through untouched — so
// the level drew a red "elsewhere in the plan" anchor with no arrow attached,
// where the roadmap after approve draws no anchor at all.
describe('mergePlanLevel — the anchor of a `cross` edge the plan DELETES (bug MOTIR-5389)', () => {
  const ROADMAP_STUB = {
    id: 'wi-x',
    identifier: 'MOTIR-9',
    title: 'The blocker under another story',
    parentTitle: null,
    isDone: false,
  };

  function child(id: string, identifier: string): RoadmapLevelData['items'][number] {
    return {
      id,
      parentId: 'wi-s',
      identifier,
      title: `Committed ${identifier}`,
      kind: 'subtask',
      status: 'todo',
      hasChildren: false,
    };
  }

  /** `wi-a` (and optionally `wi-b`) blocked by `wi-x`, which sits under another story. */
  function level(blocked: string[] = ['wi-a']): PlanCanvasLevel {
    return buildWorkItemLevel({
      items: [child('wi-a', 'MOTIR-1'), child('wi-b', 'MOTIR-2')],
      edges: blocked.map((id) => ({ blockedId: id, blockerId: 'wi-x' })),
      offLevelBlockers: [ROADMAP_STUB],
    });
  }

  function unblock(nodeId: string, identifier: string): PlanReviewItemDto {
    return item({
      planItemId: `pi_${nodeId}`,
      nodeId,
      op: 'modify',
      identifier,
      parentNodeId: 'wi-s',
      blockedByRemovedNodeIds: ['wi-x'],
    });
  }

  it('drops the anchor when the plan deletes the ONLY edge out of it — the level approve leaves behind', () => {
    const built = level();
    // The fixture really does start with an anchor and its edge.
    expect(built.nodes.map((n) => n.id)).toEqual(['wi-a', 'wi-b', 'wi-x']);
    expect(built.deps).toEqual([{ from: 'wi-x', to: 'wi-a', variant: 'cross' }]);

    const merged = mergePlanLevel(built, [unblock('wi-a', 'MOTIR-1')], 'wi-s');

    expect(merged.deps).toEqual([]);
    expect(merged.nodes.map((n) => n.id)).toEqual(['wi-a', 'wi-b']);
  });

  it('keeps the anchor, once, while a SECOND committed child is still blocked by it', () => {
    const merged = mergePlanLevel(level(['wi-a', 'wi-b']), [unblock('wi-a', 'MOTIR-1')], 'wi-s');

    expect(merged.deps).toEqual([{ from: 'wi-x', to: 'wi-b', variant: 'cross' }]);
    expect(merged.nodes.filter((n) => n.id === 'wi-x')).toHaveLength(1);
  });

  it('keeps the anchor, once, while a PROPOSAL at the level carries its own off-level edge to it (MOTIR-5387)', () => {
    const merged = mergePlanLevel(
      level(),
      [
        unblock('wi-a', 'MOTIR-1'),
        item({
          planItemId: 'pi_new',
          nodeId: 'pi_new',
          op: 'add',
          title: 'The new card',
          parentNodeId: 'wi-s',
          blockedByNodeIds: ['wi-x'],
          blockerStubs: [
            {
              nodeId: 'wi-x',
              identifier: 'MOTIR-9',
              title: 'The blocker under another story',
              isDone: false,
              parentNodeId: 'wi-other',
            },
          ],
        }),
      ],
      'wi-s',
    );

    expect(merged.deps).toEqual([{ from: 'wi-x', to: 'pi_new', variant: 'cross' }]);
    expect(merged.nodes.filter((n) => n.id === 'wi-x')).toHaveLength(1);
  });

  it('never removes a committed node that is not an anchor, referenced by a dep or not', () => {
    // `wi-b` has no edge at all, before or after; `wi-a` loses its only one.
    const merged = mergePlanLevel(level(), [unblock('wi-a', 'MOTIR-1')], 'wi-s');

    expect(merged.nodes.some((n) => n.id === 'wi-a')).toBe(true);
    expect(merged.nodes.some((n) => n.id === 'wi-b')).toBe(true);
  });
});

// ── MOTIR-6362 · a proposal's off-level edge draws by its PROJECTED disposition ─
// The review model judges each proposal blocker over the projected tree
// (`planReviewService`, pinned in tests/integration/plans/planReviewEdgeCoverage);
// the merge only reads `stub.coverage`, exactly as the builder reads the roadmap's.
describe('mergePlanLevel — projected edge disposition (MOTIR-6362)', () => {
  const STUB = {
    nodeId: 'wi-y',
    identifier: 'MOTIR-804',
    title: 'Tokenise a card',
    isDone: false,
    parentNodeId: 'wi-a',
  };
  const committed = (): PlanCanvasLevel =>
    buildWorkItemLevel({
      items: [
        {
          id: 'wi-x',
          parentId: 'wi-b',
          identifier: 'MOTIR-812',
          title: 'Charge',
          kind: 'subtask',
          status: 'todo',
          hasChildren: false,
        },
      ],
      edges: [],
      offLevelBlockers: [],
    });
  const proposal = (coverage?: 'covered' | 'exempt' | 'uncovered' | 'cross_level') =>
    item({
      planItemId: 'pi_r',
      nodeId: 'pi_r',
      parentNodeId: 'wi-b',
      blockedByNodeIds: ['wi-y'],
      blockerStubs: [{ ...STUB, ...(coverage ? { coverage } : {}) }],
    });
  const chip = (level: PlanCanvasLevel, id: string) => {
    renderWithIntl(<>{level.nodes.find((n) => n.id === id)!.content}</>);
    const hit = screen.queryByTestId('cross-blocked-flag') !== null;
    cleanup();
    return hit;
  };

  it('UNCOVERED keeps the flag: cross dep, anchor, chip', () => {
    const level = mergePlanLevel(committed(), [proposal('uncovered')], 'wi-b');
    expect(level.deps).toContainEqual({ from: 'wi-y', to: 'pi_r', variant: 'cross' });
    expect(level.nodes.some((n) => n.id === 'wi-y')).toBe(true);
    expect(chip(level, 'pi_r')).toBe(true);
  });

  it('no disposition (a decided plan, an older server) keeps the flag', () => {
    const level = mergePlanLevel(committed(), [proposal()], 'wi-b');
    expect(level.deps).toContainEqual({ from: 'wi-y', to: 'pi_r', variant: 'cross' });
  });

  it('COVERED draws nothing: no dep, no anchor, no chip', () => {
    const level = mergePlanLevel(committed(), [proposal('covered')], 'wi-b');
    expect(level.deps.filter((d) => d.from === 'wi-y')).toEqual([]);
    expect(level.nodes.some((n) => n.id === 'wi-y')).toBe(false);
    expect(chip(level, 'pi_r')).toBe(false);
  });

  it('EXEMPT: a pending arrow from a NEUTRAL anchor, and no chip', () => {
    const level = mergePlanLevel(committed(), [proposal('exempt')], 'wi-b');
    expect(level.deps).toContainEqual({ from: 'wi-y', to: 'pi_r', variant: 'pending' });
    const anchor = level.nodes.find((n) => n.id === 'wi-y')!;
    expect(anchor.anchor).toBe(true);
    renderWithIntl(<>{anchor.content}</>);
    expect(document.querySelector('[data-anchor-tone]')?.getAttribute('data-anchor-tone')).toBe(
      'neutral',
    );
    cleanup();
    expect(chip(level, 'pi_r')).toBe(false);
  });

  it('a committed NEUTRAL anchor is recognised as an anchor, not a card on the level', () => {
    const withExempt = buildWorkItemLevel({
      items: [
        {
          id: 'wi-r',
          parentId: null,
          identifier: 'MOTIR-870',
          title: 'Rotate',
          kind: 'task',
          status: 'todo',
          hasChildren: false,
        },
      ],
      edges: [{ blockedId: 'wi-r', blockerId: 'wi-f', coverage: 'exempt' }],
      offLevelBlockers: [
        { id: 'wi-f', identifier: 'MOTIR-871', title: 'Secrets', parentTitle: null },
      ],
    });
    // A proposal blocked by the SAME filed blocker takes the off-level path
    // (so its own disposition decides), rather than a within-level arrow to a
    // node that is only an anchor.
    const p = item({
      planItemId: 'pi_n',
      nodeId: 'pi_n',
      parentNodeId: null,
      blockedByNodeIds: ['wi-f'],
      blockerStubs: [
        {
          nodeId: 'wi-f',
          identifier: 'MOTIR-871',
          title: 'Secrets',
          isDone: false,
          parentNodeId: null,
          coverage: 'exempt',
        },
      ],
    });
    const level = mergePlanLevel(withExempt, [p], null);
    expect(level.nodes.filter((n) => n.id === 'wi-f')).toHaveLength(1);
    expect(level.deps).toContainEqual({ from: 'wi-f', to: 'pi_n', variant: 'pending' });
  });

  it('withProjectedCoverage overrides exactly the re-judged committed edges', () => {
    const data: RoadmapLevelData = {
      items: [],
      edges: [
        { blockedId: 'b1', blockerId: 'a1', coverage: 'covered' },
        { blockedId: 'b2', blockerId: 'a2', coverage: 'uncovered' },
      ],
      offLevelBlockers: [],
    };
    expect(withProjectedCoverage(data, new Map())).toBe(data);
    expect(withProjectedCoverage(data, new Map([['b1 a1', 'uncovered']])).edges).toEqual([
      { blockedId: 'b1', blockerId: 'a1', coverage: 'uncovered' },
      { blockedId: 'b2', blockerId: 'a2', coverage: 'uncovered' },
    ]);
  });
});
