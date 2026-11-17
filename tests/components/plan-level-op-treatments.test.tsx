// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { mergePlanLevel } from '@/components/planning/planLevel';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { planReviewItem } from '../helpers/planReview';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// Part VI's op treatments, drawn by the ONE level builder (MOTIR-6299).
//
// These cases were written against the planning surface's second builder
// (`planChangeLevel.tsx`, MOTIR-1730 / MOTIR-3162 / MOTIR-3206), which drew the
// same promises through its own diff frame. That builder is deleted; the promises
// are not. Each case here is the same claim, now held against `mergePlanLevel` —
// the builder every pane with a plan draws through (`PlanReviewCanvas`, mounted by
// `PlanProposalViews` on both the plan page and the planning surface).
//
// ONE DELIBERATE CHANGE, from MOTIR-6296 (Part XXIII §23.4): `locked` is no longer
// every finished card on a level the plan is pending over. It is a `modify` /
// `remove` whose target is finished, and an untouched `done` sibling is drawn as
// the plain committed card. The old "LOCKS finished work" case is re-stated in
// that form below.

const LEVEL: RoadmapLevelData = {
  items: [
    {
      id: 'wi-12',
      parentId: null,
      identifier: 'PAY-12',
      title: 'Invoice model',
      kind: 'story',
      status: 'done',
      hasChildren: false,
    },
    {
      id: 'wi-21',
      parentId: null,
      identifier: 'PAY-21',
      title: 'Payment reminders',
      kind: 'task',
      status: 'todo',
      hasChildren: false,
    },
    {
      id: 'wi-14',
      parentId: null,
      identifier: 'PAY-14',
      title: 'Send invoice',
      kind: 'task',
      status: 'in_progress',
      hasChildren: false,
    },
  ],
  edges: [],
  offLevelBlockers: [],
};

const ADD = planReviewItem({
  planItemId: 'pi_1',
  nodeId: 'pi_1',
  kind: 'story',
  title: 'Recurring invoices',
});
const MODIFY = planReviewItem({
  planItemId: 'pi_2',
  op: 'modify',
  nodeId: 'wi-21',
  identifier: 'PAY-21',
  title: 'Email reminders',
  status: 'todo',
  statusCategory: 'todo',
  changes: [{ field: 'title', from: 'Payment reminders', to: 'Email reminders' }],
});
const REMOVE = planReviewItem({
  planItemId: 'pi_3',
  op: 'remove',
  nodeId: 'wi-14',
  identifier: 'PAY-14',
  title: 'Send invoice',
  status: 'in_progress',
  statusCategory: 'in_progress',
});
const PLAN = [ADD, MODIFY, REMOVE];

function merge(
  items: PlanReviewItemDto[],
  level: RoadmapLevelData = LEVEL,
  parentId: string | null = null,
  outcome: 'accepted' | 'declined' | null = null,
) {
  return mergePlanLevel(buildWorkItemLevel(level), items, parentId, outcome);
}

function renderNode(level: ReturnType<typeof merge>, id: string) {
  const node = level.nodes.find((n) => n.id === id)!;
  renderWithIntl(<>{node.content}</>);
  return node;
}

afterEach(cleanup);

describe('mergePlanLevel — the op treatments', () => {
  it('leaves every committed node as the roadmap drew it when nothing is proposed', () => {
    const base = buildWorkItemLevel(LEVEL);
    const out = mergePlanLevel(base, [], null);
    expect(out.nodes).toEqual(base.nodes);
    expect(out.deps).toEqual(base.deps);
  });

  it('appends the proposed add as its own node, drawn as an ADD', () => {
    const level = merge(PLAN);

    expect(level.nodes).toHaveLength(4);
    const proposed = level.nodes[3]!;
    expect(proposed.id).toBe('pi_1');
    expect(proposed.searchText).toContain('Recurring invoices');

    renderNode(level, 'pi_1');
    expect(screen.getByTestId('plan-item-node').getAttribute('data-op')).toBe('add');
    expect(screen.getByText('Recurring invoices')).toBeTruthy();
    // Not colour alone: a word, and the placeholder key a proposal has.
    expect(screen.getByText('add')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
  });

  it('re-skins the modified card IN PLACE and names what changed', () => {
    const level = merge(PLAN);
    expect(level.nodes.filter((n) => n.id === 'wi-21')).toHaveLength(1);

    renderNode(level, 'wi-21');
    expect(screen.getByTestId('plan-item-node').getAttribute('data-op')).toBe('modify');
    expect(screen.getByText('change')).toBeTruthy();
    expect(screen.getByTestId('diff-line').textContent).toContain('Email reminders');
    // The real key, because it is the committed card being changed.
    expect(screen.getByText('PAY-21')).toBeTruthy();
  });

  it('marks a REMOVED card with the word and a struck title in secondary ink (MOTIR-4030)', () => {
    const level = merge(PLAN);

    renderNode(level, 'wi-14');
    expect(screen.getByTestId('plan-item-node').getAttribute('data-op')).toBe('remove');
    expect(screen.getByText('remove')).toBeTruthy();
    const title = screen.getByText('Send invoice');
    expect(title.className).toContain('line-through');
    expect(title.className).toContain('text-(--el-text-secondary)');
    expect(title.className).not.toContain('text-(--el-text-muted)');
  });

  it('LOCKS a proposal over finished work, says so, and marks it aria-disabled', () => {
    const overDone = planReviewItem({
      planItemId: 'pi_done',
      op: 'modify',
      nodeId: 'wi-12',
      identifier: 'PAY-12',
      title: 'Invoice model',
      status: 'done',
      statusCategory: 'done',
      changes: [{ field: 'priority', from: 'medium', to: 'high' }],
    });
    const level = merge([overDone]);

    renderNode(level, 'wi-12');
    const node = screen.getByTestId('plan-item-node');
    expect(node.getAttribute('data-locked')).toBe('true');
    expect(node.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('plan-item-lock-hatch')).toBeTruthy();
    // Over the op, never instead of it: the change is still named.
    expect(node.getAttribute('data-op')).toBe('modify');
  });

  it('draws an UNTOUCHED finished card as the plain committed card — no lock (MOTIR-6296)', () => {
    const level = merge(PLAN);
    const untouched = level.nodes.find((n) => n.id === 'wi-12')!;
    const { container } = renderWithIntl(<>{untouched.content}</>);
    expect(screen.queryByTestId('plan-item-node')).toBeNull();
    expect(container.querySelector('[data-testid$="lock-hatch"]')).toBeNull();
    expect(container.querySelector('[aria-disabled]')).toBeNull();
  });

  it('leaves an untouched, unfinished card with no op chrome at all', () => {
    const level = merge([planReviewItem({ nodeId: 'pi_only' })]);

    renderNode(level, 'wi-14');
    expect(screen.queryByTestId('plan-item-node')).toBeNull();
    expect(screen.getByText('Send invoice')).toBeTruthy();
  });

  it('places a proposal parented on an EXISTING card on that card’s level only, and makes the card drillable', () => {
    const child = planReviewItem({
      planItemId: 'pi_9',
      nodeId: 'pi_9',
      parentNodeId: 'wi-21',
      kind: 'subtask',
      title: 'Monthly schedule',
    });

    const top = merge([child]);
    expect(top.nodes).toHaveLength(3);

    const inside = mergePlanLevel({ nodes: [], deps: [] }, [child], 'wi-21');
    expect(inside.nodes.map((n) => n.id)).toEqual(['pi_9']);
    expect(inside.nodes[0]!.parentId).toBe('wi-21');

    // …and the CHILDLESS card it hangs under becomes drillable, or the proposal
    // would be unreachable (bug MOTIR-4266).
    expect(top.nodes.find((n) => n.id === 'wi-21')!.drillable).toBe(true);
    expect(top.nodes.find((n) => n.id === 'wi-14')!.drillable).toBeFalsy();
  });
});

// ── MOTIR-3162 (bug MOTIR-3154) — ONE decided language ──────────────────────
describe('mergePlanLevel — the decided outcome', () => {
  it('draws NOTHING decided while the plan is still pending', () => {
    const level = merge(PLAN);
    renderNode(level, 'pi_1');
    expect(screen.queryByTestId('plan-item-outcome-tab')).toBeNull();
    expect(document.querySelectorAll('[data-testid$="outcome-spine"]')).toHaveLength(0);
  });

  it.each(['accepted', 'declined'] as const)(
    'names the %s outcome on a PROPOSED add, once, with one spine',
    (outcome) => {
      const level = merge(PLAN, LEVEL, null, outcome);
      renderNode(level, 'pi_1');

      expect(screen.getByTestId('plan-item-outcome-tab').textContent).toBe(outcome);
      expect(document.querySelectorAll('[data-testid$="outcome-spine"]')).toHaveLength(1);
    },
  );

  it('names the outcome on a CHANGED committed card too', () => {
    const level = merge(PLAN, LEVEL, null, 'accepted');
    renderNode(level, 'wi-21');
    expect(screen.getByTestId('plan-item-outcome-tab').textContent).toBe('accepted');
  });
});

// ── A MATERIALIZED add lands ON its card (bug MOTIR-3206) ───────────────────
describe('mergePlanLevel — a DECIDED add', () => {
  // The level AFTER the approve: `materialize` created the card, so the
  // per-level read now returns it beside the ones that were already there.
  const LEVEL_AFTER: RoadmapLevelData = {
    ...LEVEL,
    items: [
      ...LEVEL.items,
      {
        id: 'wi-90',
        parentId: null,
        identifier: 'PAY-90',
        title: 'Recurring invoices',
        kind: 'story',
        status: 'todo',
        hasChildren: false,
      },
    ],
  };

  /** The re-read review: `getPlanReview` keys the materialized add by the work
   *  item it became and fills in its identifier (MOTIR-3160). */
  const ACCEPTED = planReviewItem({
    planItemId: 'pi_1',
    nodeId: 'wi-90',
    identifier: 'PAY-90',
    kind: 'story',
    title: 'Recurring invoices',
    status: 'todo',
  });

  it('merges onto the committed node instead of drawing a second copy', () => {
    const level = merge([ACCEPTED], LEVEL_AFTER, null, 'accepted');

    // FOUR nodes, not five: the card is on the canvas exactly once.
    expect(level.nodes).toHaveLength(4);
    expect(level.nodes.filter((n) => n.searchText.includes('Recurring invoices'))).toHaveLength(1);
  });

  it('wears the add treatment and the accepted word, with the REAL key', () => {
    const level = merge([ACCEPTED], LEVEL_AFTER, null, 'accepted');
    const merged = level.nodes.find((n) => n.id === 'wi-90')!;
    // It keeps the committed node's own affordances — it IS a work item now.
    expect(merged.viewable).toBe(true);

    renderNode(level, 'wi-90');
    expect(screen.getByTestId('plan-item-node').getAttribute('data-op')).toBe('add');
    expect(screen.getByTestId('plan-item-outcome-tab').textContent).toBe('accepted');
    // The real key is what Part VI §3 calls the strongest accepted signal.
    expect(screen.getByText('PAY-90')).toBeTruthy();
  });

  it('leaves a DECLINED add as a proposal — it never became anything', () => {
    // A decline materializes nothing, so the review keeps a null identifier and
    // the add stays a proposal node: inventing a key for it would assert a work
    // item that does not exist (Part VI §3).
    const level = merge(PLAN, LEVEL, null, 'declined');
    const declined = level.nodes.find((n) => n.id === 'pi_1')!;
    expect(declined).toBeTruthy();
    renderNode(level, 'pi_1');
    expect(screen.getByText('New')).toBeTruthy();
  });
});
