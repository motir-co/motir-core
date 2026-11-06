// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(''),
}));

import { WorkItemNode } from '@/components/planning/WorkItemNode';
import { BoardCard } from '@/app/(authed)/boards/_components/BoardCard';
import {
  IssueQuickViewPanel,
  type QuickViewData,
} from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import { ItemHeaderStateTags } from '@/app/(authed)/items/[key]/_components/ItemHeaderStateTags';
import { WorkItemStatusPill } from '@/components/workItems/WorkItemStateTags';
import type { BoardCardDto } from '@/lib/dto/boards';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import type { StatusCategoryDto, WorkflowStatusDto } from '@/lib/dto/workflows';
import { isReadyToStart } from '@/lib/workItems/statusSlot';

// ONE ITEM, FOUR SURFACES (MOTIR-10534 AC5). The canvas card's tag row — the
// status slot (Done › To plan › Ready › the status chip), the Manual chip and the
// blocked flag — is now the drawing the /boards card, the quick view header and
// the item page eyebrow use too. Each fixture below is rendered through all four
// from the facts each surface's read carries, and every surface must draw the SAME
// slot pill (same kind, same name, same classes), the same Manual chip and the same
// blocked flag. A surface that drew status its own way would differ in one of them.

afterEach(cleanup);

interface Fixture {
  name: string;
  kind: 'story' | 'task';
  status: string;
  statusLabel: string;
  category: StatusCategoryDto;
  hasChildren: boolean;
  /** Readiness: own blockers done and every ancestor ready. */
  unblocked: boolean;
  type?: WorkItemTypeDto | null;
  executor?: ExecutorDto | null;
  /** What the slot must draw: a pill's test id, or `status:<key>` for the chip. */
  slot: string;
  manual: boolean;
}

const FIXTURES: Fixture[] = [
  {
    name: 'a blocked To Do task keeps its status chip',
    kind: 'task',
    status: 'todo',
    statusLabel: 'To Do',
    category: 'todo',
    hasChildren: false,
    unblocked: false,
    slot: 'status:todo',
    manual: false,
  },
  {
    name: 'an In Progress task',
    kind: 'task',
    status: 'in_progress',
    statusLabel: 'In Progress',
    category: 'in_progress',
    hasChildren: false,
    unblocked: true,
    slot: 'status:in_progress',
    manual: false,
  },
  {
    name: 'an Implemented task',
    kind: 'task',
    status: 'implemented',
    statusLabel: 'Implemented',
    category: 'in_progress',
    hasChildren: false,
    unblocked: true,
    slot: 'status:implemented',
    manual: false,
  },
  {
    name: 'a Done task wears the Done stamp',
    kind: 'task',
    status: 'done',
    statusLabel: 'Done',
    category: 'done',
    hasChildren: false,
    unblocked: true,
    slot: 'done-pill',
    manual: false,
  },
  {
    name: 'a childless To Do story is To plan',
    kind: 'story',
    status: 'todo',
    statusLabel: 'To Do',
    category: 'todo',
    hasChildren: false,
    unblocked: true,
    slot: 'to-plan-pill',
    manual: false,
  },
  {
    name: 'a startable, unblocked item is Ready',
    kind: 'story',
    status: 'todo',
    statusLabel: 'To Do',
    category: 'todo',
    hasChildren: true,
    unblocked: true,
    slot: 'ready-pill',
    manual: false,
  },
  {
    name: 'a blocked In Progress item keeps its chip and gets the flag',
    kind: 'task',
    status: 'in_progress',
    statusLabel: 'In Progress',
    category: 'in_progress',
    hasChildren: false,
    unblocked: false,
    slot: 'status:in_progress',
    manual: false,
  },
  {
    name: 'a blocked done item does not wear the Done stamp',
    kind: 'task',
    status: 'done',
    statusLabel: 'Done',
    category: 'done',
    hasChildren: false,
    unblocked: false,
    slot: 'status:done',
    manual: false,
  },
  {
    name: 'a manual item gets the Manual chip after its slot',
    kind: 'task',
    status: 'todo',
    statusLabel: 'To Do',
    category: 'todo',
    hasChildren: false,
    unblocked: true,
    type: 'manual',
    executor: 'human',
    slot: 'ready-pill',
    manual: true,
  },
  {
    name: 'a human-executed code item is Manual too',
    kind: 'task',
    status: 'in_progress',
    statusLabel: 'In Progress',
    category: 'in_progress',
    hasChildren: false,
    unblocked: true,
    type: 'code',
    executor: 'human',
    slot: 'status:in_progress',
    manual: true,
  },
  {
    name: "a custom status takes its category's tone and its own label",
    kind: 'task',
    status: 'qa_review',
    statusLabel: 'QA review',
    category: 'in_progress',
    hasChildren: false,
    unblocked: true,
    slot: 'status:qa_review',
    manual: false,
  },
];

const SLOT_SELECTOR =
  '[data-testid="done-pill"],[data-testid="to-plan-pill"],[data-testid="ready-pill"],[data-status]';

/** What a surface drew in the tag row, read the same way on every surface. */
function readTags(container: HTMLElement) {
  const slot = container.querySelector<HTMLElement>(SLOT_SELECTOR);
  if (!slot) throw new Error('no status slot drawn');
  const testId = slot.getAttribute('data-testid');
  const row = slot.parentElement as HTMLElement;
  return {
    slot: testId ?? `status:${slot.getAttribute('data-status')}`,
    name: slot.getAttribute('title'),
    className: slot.className,
    manual: Array.from(row.children).some((c) => c.textContent === 'Manual'),
    blocked: container.querySelector('[data-testid="cross-blocked-flag"]') !== null,
  };
}

function renderTags(ui: ReactElement) {
  const { container } = render(ui);
  const tags = readTags(container);
  cleanup();
  return tags;
}

function canvas(f: Fixture) {
  return renderTags(
    <WorkItemNode
      item={{
        id: 'w1',
        identifier: 'PROD-7',
        title: 'Card',
        kind: f.kind,
        status: f.status,
        statusLabel: f.statusLabel,
        statusCategory: f.category,
        hasChildren: f.hasChildren,
        type: f.type ?? null,
        executor: f.executor ?? null,
      }}
      // The roadmap read's `RoadmapNodeDto.ready` is `isReadyToStart` over the
      // cascaded readiness; an unready node off the level draws the blocked flag.
      ready={isReadyToStart(f.category, f.unblocked)}
      crossBlocked={!f.unblocked}
    />,
  );
}

function board(f: Fixture) {
  const card: BoardCardDto = {
    id: 'w1',
    key: 7,
    projectId: 'p1',
    parentId: null,
    kind: f.kind,
    identifier: 'PROD-7',
    title: 'Card',
    status: f.status,
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    position: 'a0',
    ready: f.unblocked,
    readyToStart: isReadyToStart(f.category, f.unblocked),
    statusLabel: f.statusLabel,
    hasChildren: f.hasChildren,
    type: f.type ?? null,
    executor: f.executor ?? null,
    pendingDecision: null,
    planHold: null,
    ciState: null,
    fixReason: null,
    obsolescence: null,
    statusCategory: f.category,
  };
  return renderTags(<BoardCard card={card} assigneeName={null} onOpenQuickView={() => {}} />);
}

function quickView(f: Fixture) {
  const data: QuickViewData = {
    folderId: null,
    folderPath: [],
    identifier: 'PROD-7',
    title: 'Card',
    projectIdentifier: 'PROD',
    workItemRefs: {},
    kind: f.kind,
    statusLabel: f.statusLabel,
    statusCategory: f.category,
    fixReason: null,
    descriptionMd: null,
    explanationMd: null,
    type: f.type ?? null,
    executor: f.executor ?? null,
    difficulty: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    assigneeName: null,
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
    readiness: { ready: f.unblocked, blockers: [], blockedByAncestor: null },
    archived: null,
    pullRequests: [],
    repoDelivery: [],
    deliveries: [],
    hasChildren: f.hasChildren,
    canPlan: true,
    id: 'cmqvitem00000000000000p7',
    status: f.status,
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
      estimationStatistic: 'story_points' as const,
      pointScale: 'fibonacci' as const,
      customScaleValues: [],
      canEdit: true,
    },
  } as QuickViewData;
  return renderTags(<IssueQuickViewPanel state="ready" data={data} />);
}

function statusesFor(f: Fixture): WorkflowStatusDto[] {
  return [
    {
      id: 's1',
      projectId: 'p1',
      key: f.status,
      label: f.statusLabel,
      category: f.category,
      color: null,
      position: 'a0',
      isInitial: false,
    },
  ];
}

function itemPage(f: Fixture) {
  return renderTags(
    <div>
      <span>PROD-7</span>
      <ItemHeaderStateTags
        item={{
          kind: f.kind,
          status: f.status,
          type: f.type ?? null,
          executor: f.executor ?? null,
        }}
        statuses={statusesFor(f)}
        hasChildren={f.hasChildren}
        unblocked={f.unblocked}
      />
    </div>,
  );
}

describe('the work item state tags — one item reads the same on every surface (MOTIR-10534)', () => {
  it.each(FIXTURES)('$name', (f) => {
    const drawn = {
      canvas: canvas(f),
      board: board(f),
      quickView: quickView(f),
      itemPage: itemPage(f),
    };
    for (const [surface, tags] of Object.entries(drawn)) {
      expect({ surface, slot: tags.slot }).toEqual({ surface, slot: f.slot });
      expect({ surface, manual: tags.manual }).toEqual({ surface, manual: f.manual });
      expect({ surface, blocked: tags.blocked }).toEqual({ surface, blocked: !f.unblocked });
      // The same pill: the same name, and the same tint + ink + shape classes.
      expect({ surface, name: tags.name }).toEqual({ surface, name: drawn.canvas.name });
      expect({ surface, className: tags.className }).toEqual({
        surface,
        className: drawn.canvas.className,
      });
    }
    if (f.slot.startsWith('status:')) expect(drawn.canvas.name).toBe(f.statusLabel);
  });

  it('the item page eyebrow draws a status its workflow list does not hold under the neutral chip', () => {
    const { container } = render(
      <ItemHeaderStateTags
        item={{ kind: 'task', status: 'legacy_key', type: null, executor: null }}
        statuses={[]}
        hasChildren={false}
        unblocked
      />,
    );
    // No category, so never Ready, never To plan: the status chip for its key.
    expect(readTags(container).slot).toBe('status:legacy_key');
  });

  it("the item page rail's read-only status is the same chip, outside the slot", () => {
    const { container } = render(
      <WorkItemStatusPill status="qa_review" label="QA review" category="in_progress" />,
    );
    const pill = container.querySelector('[data-status="qa_review"]') as HTMLElement;
    expect(pill.textContent).toBe('QA review');
    // The category's tone, never To Do's: the same tint the canvas chip for the
    // shipped in_progress key wears.
    cleanup();
    const ref = render(<WorkItemStatusPill status="in_progress" category="in_progress" />);
    const inProgress = ref.container.querySelector('[data-status="in_progress"]') as HTMLElement;
    const tone = (el: HTMLElement) =>
      el.className.split(' ').filter((c) => c.startsWith('bg-') || c.startsWith('text-('));
    expect(tone(pill)).toEqual(tone(inProgress));
  });

  it('a status with no per-key treatment and no category takes the neutral chip under its own name', () => {
    const { container } = render(<WorkItemStatusPill status="mystery" label="Mystery" />);
    const neutral = container.querySelector('[data-status="mystery"]') as HTMLElement;
    // Its own label, never "To Do": the neutral chip is an honest unknown.
    expect(neutral.textContent).toBe('Mystery');
    cleanup();
    const ref = render(<WorkItemStatusPill status="in_progress" category="in_progress" />);
    const inProgress = ref.container.querySelector('[data-status="in_progress"]') as HTMLElement;
    // And no lifecycle tone it has not earned.
    expect(neutral.className).not.toBe(inProgress.className);
  });
});
