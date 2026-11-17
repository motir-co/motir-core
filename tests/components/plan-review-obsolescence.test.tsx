// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PLAN_ITEM_SETTABLE_RAIL_FIELDS } from '@/lib/dto/planReview';
import type { PlanItemChangeDto, PlanRefChipDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { QuickViewData } from '@/lib/dto/quickView';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// Story MOTIR-6577 · MOTIR-6632 — the plan review RENDERS a proposed obsolescence
// mark, built to `design/ai-planning/plan-review--obsolescence.mock.html` and
// `design-notes.md` Part XXIV (§24.3–§24.11). One block per surface the design
// draws: the canvas card, the list row, the peek's rail, and the empty state. The
// review model itself is asserted against the real service in
// `tests/integration/plans/planReviewObsolescence.test.ts`; this file drives the
// renderers off that shape.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { PlanItemNode, isLockedProposal } from '@/components/planning/PlanItemNode';
import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { ProposalPeek } from '@/components/planning/ProposalPeek';
import { ObsolescencePill } from '@/components/issues/ObsolescencePill';

// ── Fixtures ────────────────────────────────────────────────────────────────

const committed = (identifier: string, title: string, kind = 'story'): PlanRefChipDto => ({
  identifier,
  title,
  kind,
  proposed: false,
});
const proposal = (planItemId: string, title: string, kind = 'subtask'): PlanRefChipDto => ({
  identifier: null,
  title,
  kind,
  proposed: true,
  planItemId,
});

const NEW_CARD = proposal('pi_new', 'Deliver webhooks exactly once with an idempotency key');
const PROD_52 = committed('PROD-52', 'Backoff schedule for webhook retries', 'task');
const PROD_44 = committed('PROD-44', 'Receive bank events by push webhook');
const PROD_21 = committed('PROD-21', 'Deliver webhooks at most once per event');
const PROD_9 = committed('PROD-9', 'Poll the bank feed every five minutes');

const markRow = (from: string, to: string): PlanItemChangeDto => ({
  field: 'obsolescence',
  from,
  to,
});
const noteRow = (to: string | null): PlanItemChangeDto => ({
  field: 'obsolescenceNote',
  from: null,
  to,
});
const edgeRow = (
  field: 'supersedes' | 'supersededBy',
  added: PlanRefChipDto[],
  removed: PlanRefChipDto[] = [],
): PlanItemChangeDto => ({
  field,
  from: null,
  to: [
    ...added.map((c) => `+${c.identifier ?? c.title}`),
    ...removed.map((c) => `−${c.identifier}`),
  ].join(' · '),
  refs: { added, removed },
});

/** A `modify` of a FINISHED card — the only card a plan may mark (§24.1). */
function markModify(
  changes: PlanItemChangeDto[],
  over: Partial<PlanReviewItemDto> = {},
): PlanReviewItemDto {
  return planReviewItem({
    planItemId: 'pi_mod',
    op: 'modify',
    nodeId: 'wi_21',
    identifier: 'PROD-21',
    kind: 'story',
    title: 'Deliver webhooks at most once per event',
    status: 'done',
    statusLabel: 'Done',
    statusCategory: 'done',
    changes,
    ...over,
    proposal: {
      op: 'modify',
      identifier: over.identifier ?? 'PROD-21',
      changedFields: changes.map(
        (c) => c.field as PlanReviewItemDto['proposal']['changedFields'][number],
      ),
      settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
      todos: null,
      markChanges: changes.filter((c) =>
        ['obsolescence', 'obsolescenceNote', 'supersedes', 'supersededBy'].includes(c.field),
      ),
    },
  });
}

function supersedingAdd(refs: PlanRefChipDto[], over: Partial<PlanReviewItemDto> = {}) {
  return planReviewItem({
    planItemId: 'pi_new',
    op: 'add',
    kind: 'subtask',
    type: 'code',
    title: 'Deliver webhooks exactly once with an idempotency key',
    difficulty: 'medium',
    supersedesRefs: refs,
    ...over,
    proposal: {
      op: 'add',
      identifier: null,
      changedFields: [],
      settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
      todos: null,
      supersedesRefs: refs,
    },
  });
}

const LONG_NOTE =
  'Delivery moved from polling to the bank’s push webhook in PROD-44, so the five-minute poll no longer runs anywhere. ' +
  'The fallback poller was removed with it; nothing reads the old schedule. ' +
  'Do not build on this card: the push contract in PROD-44 is the one to follow, and its retry rules differ. ' +
  'The retry rules differ in their backoff, in their ceiling and in what they do when the bank answers 429.';

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// ── isLockedProposal (§24.4) ────────────────────────────────────────────────

describe('isLockedProposal — locked means "approve will refuse this", and nothing else', () => {
  it('a MARK modify of a finished card is NOT locked', () => {
    for (const changes of [
      [markRow('current', 'outdated')],
      [markRow('outdated', 'deprecated'), noteRow('why')],
      [markRow('deprecated', 'current')],
      [edgeRow('supersededBy', [NEW_CARD])],
      [noteRow('only the note')],
    ]) {
      expect(isLockedProposal({ op: 'modify', statusCategory: 'done', changes })).toBe(false);
    }
  });

  it('a modify of a finished card carrying ANY other row stays locked', () => {
    expect(
      isLockedProposal({
        op: 'modify',
        statusCategory: 'done',
        changes: [markRow('current', 'outdated'), { field: 'title', from: 'a', to: 'b' }],
      }),
    ).toBe(true);
    // No rows at all is not a mark modify — it marks nothing.
    expect(isLockedProposal({ op: 'modify', statusCategory: 'done', changes: [] })).toBe(true);
    // A caller holding only op × category keeps the pre-mark answer.
    expect(isLockedProposal({ op: 'modify', statusCategory: 'done' })).toBe(true);
  });

  it('a remove of a finished card is locked; an add never is', () => {
    expect(isLockedProposal({ op: 'remove', statusCategory: 'done' })).toBe(true);
    expect(isLockedProposal({ op: 'add', statusCategory: 'done' })).toBe(false);
  });

  it('a modify that SETS a mark on an UNFINISHED (reopened) target IS locked', () => {
    for (const statusCategory of ['todo', 'in_progress'] as const) {
      expect(
        isLockedProposal({
          op: 'modify',
          statusCategory,
          changes: [markRow('current', 'outdated')],
        }),
      ).toBe(true);
    }
    // …but a CLEAR there is legal (`null` is not restricted), and so is an edge.
    expect(
      isLockedProposal({
        op: 'modify',
        statusCategory: 'in_progress',
        changes: [markRow('outdated', 'current')],
      }),
    ).toBe(false);
    expect(
      isLockedProposal({
        op: 'modify',
        statusCategory: 'todo',
        changes: [edgeRow('supersedes', [PROD_52])],
      }),
    ).toBe(false);
  });
});

// ── The ObsolescencePill (§24.5) ────────────────────────────────────────────

describe('the ObsolescencePill', () => {
  it('outdated is the neutral Pill with History; deprecated the archived Pill with Ban', () => {
    render(
      <>
        <ObsolescencePill mark="outdated" />
        <ObsolescencePill mark="deprecated" size="node" srPrefix="Proposed mark" />
      </>,
    );
    const outdated = document.querySelector('[data-obsolescence="outdated"]')!;
    expect(outdated.textContent).toBe('Outdated');
    expect(outdated.className).toContain('bg-(--el-chip-bg)');
    expect(outdated.querySelector('svg')!.getAttribute('class')).toContain('lucide-history');
    const deprecated = document.querySelector('[data-obsolescence="deprecated"]')!;
    expect(deprecated.textContent).toBe('Proposed mark Deprecated');
    expect(deprecated.className).toContain('bg-(--el-archived-pill-bg)');
    expect(deprecated.className).toContain('text-[11px]');
    expect(deprecated.querySelector('svg')!.getAttribute('class')).toContain('lucide-ban');
    expect(deprecated.querySelector('.sr-only')!.textContent).toBe('Proposed mark ');
  });
});

// ── The canvas card (§24.3–§24.5, §24.8) ────────────────────────────────────

describe('the canvas card', () => {
  it('SETS Outdated on a Done card: pill before the status, Mark leads the diff line, not locked', () => {
    render(
      <PlanItemNode
        item={markModify([
          markRow('current', 'outdated'),
          noteRow('Delivery is now exactly-once.'),
          edgeRow('supersededBy', [NEW_CARD]),
        ])}
      />,
    );
    const node = screen.getByTestId('plan-item-node');
    expect(node.getAttribute('data-locked')).toBeNull();
    expect(node.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByTestId('plan-item-lock-hatch')).toBeNull();

    const pill = within(node).getByTestId('plan-item-obsolescence');
    expect(pill.getAttribute('data-obsolescence')).toBe('outdated');
    expect(pill.textContent).toBe('Proposed mark Outdated');
    // Directly before the card's own status pill (which a mark never moves).
    expect(pill.nextElementSibling?.textContent).toContain('Done');

    const line = screen.getByTestId('diff-line');
    expect(line.textContent).toBe('MarkCurrentOutdated+2 more');
    expect(within(line).getByText('Current').className).toContain('line-through');
  });

  it('CHANGES Outdated → Deprecated on a Cancelled card', () => {
    render(
      <PlanItemNode
        item={markModify([markRow('outdated', 'deprecated')], {
          status: 'cancelled',
          statusLabel: 'Cancelled',
        })}
      />,
    );
    expect(screen.getByTestId('diff-line').textContent).toBe('MarkOutdatedDeprecated');
    expect(document.querySelector('[data-obsolescence="deprecated"]')).not.toBeNull();
    expect(screen.getByTestId('plan-item-node').getAttribute('data-locked')).toBeNull();
  });

  it('CLEARS a mark: no pill (the card will carry none), `Deprecated → Current`', () => {
    render(<PlanItemNode item={markModify([markRow('deprecated', 'current')])} />);
    expect(document.querySelector('[data-obsolescence]')).toBeNull();
    expect(screen.getByTestId('diff-line').textContent).toBe('MarkDeprecatedCurrent');
  });

  it('a target REOPENED since the plan was written is drawn LOCKED, still showing the mark', () => {
    render(
      <PlanItemNode
        item={markModify([markRow('current', 'outdated'), noteRow('n')], {
          status: 'in_progress',
          statusLabel: 'In Progress',
          statusCategory: 'in_progress',
        })}
      />,
    );
    const node = screen.getByTestId('plan-item-node');
    expect(node.getAttribute('data-locked')).toBe('true');
    expect(node.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('plan-item-lock-hatch')).toBeTruthy();
    expect(node.querySelector('[data-obsolescence="outdated"]')).not.toBeNull();
  });

  it('an edges-only modify leads with its edge row, as words — no canvas edge', () => {
    render(<PlanItemNode item={markModify([edgeRow('supersedes', [PROD_52, NEW_CARD])])} />);
    const line = screen.getByTestId('diff-line');
    expect(line.textContent).toBe(
      'Supersedes+PROD-52 · +New · Deliver webhooks exactly once with an idempotency key',
    );
    expect(document.querySelector('[data-obsolescence]')).toBeNull();
  });

  it('an `add` superseding two cards shows the `Supersedes 2` glyph, keys in title', () => {
    render(<PlanItemNode item={supersedingAdd([PROD_21, PROD_9])} />);
    const count = screen.getByTestId('plan-item-supersedes');
    // The tag row's give-way form (MOTIR-11545 on a decided card, MOTIR-11549 on
    // every card): `Supersedes 2` beside `New`, `+ add` and the difficulty ran
    // 19.8px past the fixed 280px card, so the chip is its glyph, named on
    // `aria-label`, and the difficulty leaves the row for the quick view.
    expect(count.textContent).toBe('');
    expect(count.getAttribute('role')).toBe('img');
    expect(count.getAttribute('aria-label')).toBe('Supersedes 2');
    expect(count.getAttribute('title')).toBe('Supersedes PROD-21 · PROD-9');
    expect(screen.queryByTestId('plan-item-difficulty')).toBeNull();
    expect(count.querySelector('svg')!.getAttribute('class')).toContain('lucide-replace');
    // The bottom slot is not spent.
    expect(screen.queryByTestId('diff-line')).toBeNull();
  });

  it('an `add` superseding a proposal names it `New · <title>` in the title', () => {
    render(<PlanItemNode item={supersedingAdd([NEW_CARD])} />);
    expect(screen.getByTestId('plan-item-supersedes').getAttribute('title')).toBe(
      'Supersedes New · Deliver webhooks exactly once with an idempotency key',
    );
  });

  it('an `add` without refs draws no count', () => {
    render(<PlanItemNode item={supersedingAdd([])} />);
    expect(screen.queryByTestId('plan-item-supersedes')).toBeNull();
  });
});

// ── The list row (§24.3, §24.4, §24.6, §24.7, §24.9) ────────────────────────

function rowOf(label: string): HTMLElement {
  const term = Array.from(document.querySelectorAll('dt')).find(
    (dt) => dt.textContent?.trim() === label,
  );
  if (!term) throw new Error(`no row ${label}`);
  return term.nextElementSibling as HTMLElement;
}

describe('the list row', () => {
  it('a SET: Mark old struck → new, the note’s first line, a proposed Superseded-by chip, and the holds line', () => {
    render(
      <PlanProposalList
        items={[
          markModify([
            markRow('current', 'outdated'),
            noteRow('Delivery is now exactly-once.\nSecond line never shown here.'),
            edgeRow('supersededBy', [NEW_CARD]),
          ]),
        ]}
        outcome={null}
      />,
    );
    const mark = rowOf('Mark');
    expect(mark.textContent).toBe('Current→Outdated');
    expect(within(mark).getByText('Current').className).toContain('line-through');

    const note = rowOf('Note').firstElementChild as HTMLElement;
    expect(note.textContent).toBe('Delivery is now exactly-once.');
    expect(note.getAttribute('title')).toBe(
      'Delivery is now exactly-once.\nSecond line never shown here.',
    );
    expect(note.className).toContain('truncate');

    const chip = within(rowOf('Superseded by')).getByTestId('supersedes-chip');
    expect(chip.getAttribute('data-ref')).toBe('proposal');
    expect(chip.getAttribute('data-delta')).toBe('+');
    expect(chip.textContent).toBe('Adds +NewDeliver webhooks exactly once with an idempotency key');
    // The row already opens the peek: no second control inside it.
    expect(within(rowOf('Superseded by')).queryByRole('button')).toBeNull();

    expect(screen.getByTestId('mark-holds-status').textContent?.trim()).toBe(
      'Stays Done while marked',
    );
    // The label column is one subgrid per proposal (§24.9).
    const dl = mark.closest('dl')!;
    expect(dl.className).toContain('grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)]');
    expect(mark.parentElement!.className).toContain('grid-cols-subgrid');
  });

  it('a CHANGE on a Cancelled card says it stays Cancelled', () => {
    render(
      <PlanProposalList
        items={[
          markModify([markRow('outdated', 'deprecated'), noteRow(LONG_NOTE)], {
            status: 'cancelled',
            statusLabel: 'Cancelled',
          }),
        ]}
        outcome={null}
      />,
    );
    expect(rowOf('Mark').textContent).toBe('Outdated→Deprecated');
    expect(screen.getByTestId('mark-holds-status').textContent?.trim()).toBe(
      'Stays Cancelled while marked',
    );
  });

  it('a CLEAR with a removed edge: `Deprecated → Current`, `—` for the note, a struck `−` chip, no holds line', () => {
    render(
      <PlanProposalList
        items={[
          markModify([
            markRow('deprecated', 'current'),
            noteRow(null),
            edgeRow('supersededBy', [], [PROD_52]),
          ]),
        ]}
        outcome={null}
      />,
    );
    expect(rowOf('Mark').textContent).toBe('Deprecated→Current');
    expect(rowOf('Note').textContent).toBe('—');
    const chip = within(rowOf('Superseded by')).getByTestId('supersedes-chip');
    expect(chip.getAttribute('data-delta')).toBe('−');
    expect(chip.textContent).toContain('Removes');
    expect(within(chip).getByText('Backoff schedule for webhook retries').className).toContain(
      'line-through',
    );
    expect(screen.queryByTestId('mark-holds-status')).toBeNull();
  });

  it('an edges-only modify: three chips, then `+N more`, and no holds line', () => {
    render(
      <PlanProposalList
        items={[
          markModify([
            edgeRow('supersedes', [
              PROD_52,
              NEW_CARD,
              committed('PROD-18', 'Retry a failed delivery three times', 'task'),
              PROD_9,
              PROD_44,
            ]),
          ]),
        ]}
        outcome={null}
      />,
    );
    const row = rowOf('Supersedes');
    expect(within(row).getAllByTestId('supersedes-chip')).toHaveLength(3);
    expect(row.textContent).toContain('+2 more');
    expect(screen.queryByTestId('mark-holds-status')).toBeNull();
  });

  it('a DECIDED plan forecasts nothing — no holds line', () => {
    render(
      <PlanProposalList
        items={[markModify([markRow('current', 'outdated')])]}
        outcome="accepted"
      />,
    );
    expect(screen.queryByTestId('mark-holds-status')).toBeNull();
  });

  it('an `add` with supersedesRefs gets an unsigned SUPERSEDES row; without, none', () => {
    render(
      <PlanProposalList
        items={[
          supersedingAdd([PROD_21, PROD_9]),
          supersedingAdd([], { planItemId: 'pi_other', title: 'Expose delivery attempts' }),
        ]}
        outcome={null}
      />,
    );
    const rows = screen.getAllByTestId('supersedes-row');
    expect(rows).toHaveLength(1);
    const chips = within(rows[0]!).getAllByTestId('supersedes-chip');
    expect(chips.map((c) => c.getAttribute('data-delta'))).toEqual([null, null]);
    expect(chips.map((c) => c.getAttribute('data-ref'))).toEqual(['committed', 'committed']);
    expect(
      within(chips[0]!).getByTestId('planning-target-chip').getAttribute('data-target-key'),
    ).toBe('PROD-21');
  });

  it('renders in Chinese', () => {
    render(
      <PlanProposalList
        items={[markModify([markRow('current', 'outdated'), edgeRow('supersededBy', [NEW_CARD])])]}
        outcome={null}
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(rowOf('失效状态').textContent).toBe('有效→已过时');
    expect(rowOf('被取代').textContent).toContain('新');
    expect(screen.getByTestId('mark-holds-status').textContent?.trim()).toBe('标记期间保持Done');
  });
});

// ── The peek's rail (§24.10) ────────────────────────────────────────────────

const TARGET_PAYLOAD: QuickViewData = {
  folderId: null,
  folderPath: [],
  id: 'wi_21',
  identifier: 'PROD-21',
  title: 'Deliver webhooks at most once per event',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'story',
  status: 'done',
  statusLabel: 'Done',
  statusCategory: 'done',
  fixReason: null,
  descriptionMd: null,
  explanationMd: null,
  type: 'code',
  executor: 'coding_agent',
  difficulty: null,
  obsolescence: null,
  obsolescenceNoteMd: null,
  assigneeName: null,
  assigneeId: null,
  reporterName: 'Zhu Yue',
  priority: 'high',
  labels: [],
  components: [],
  dueLabel: null,
  dueDate: null,
  sprintName: null,
  sprintId: null,
  storyPoints: null,
  estimateMinutes: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  archived: null,
  parent: null,
  parentId: null,
  readiness: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: false,
  workflow: { statuses: [], transitions: [], policyMode: 'open' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points',
    pointScale: 'fibonacci',
    customScaleValues: [],
    canEdit: false,
  },
};

function railTerms(peek: HTMLElement): string[] {
  return Array.from(peek.querySelectorAll('dt')).map((dt) =>
    (dt.textContent ?? '').replace('changed', '').trim(),
  );
}

function railRow(peek: HTMLElement, label: string) {
  const term = Array.from(peek.querySelectorAll('dt')).find((dt) =>
    (dt.textContent ?? '').startsWith(label),
  );
  if (!term) return null;
  return { term: term as HTMLElement, value: term.nextElementSibling as HTMLElement };
}

describe('the peek', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => TARGET_PAYLOAD })),
    );
  });

  it('a SET: Mark and Note directly under Status, Superseded by last, 3 of the 11', async () => {
    const onOpen = vi.fn();
    render(
      <ProposalPeek
        item={markModify([
          markRow('current', 'outdated'),
          noteRow('Delivery is now exactly-once; the at-most-once contract is replaced.'),
          edgeRow('supersededBy', [NEW_CARD]),
        ])}
        onClose={() => {}}
        onOpenProposal={onOpen}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const peek = screen.getByTestId('proposal-peek');
    const terms = railTerms(peek);
    expect(terms.slice(0, 3)).toEqual(['Status', 'Mark', 'Note']);
    // The supersedes row is after every shipped row.
    expect(terms.indexOf('Superseded by')).toBeGreaterThan(terms.indexOf('Estimate'));

    const mark = railRow(peek, 'Mark')!;
    expect(within(mark.term).getByText('changed')).toBeTruthy();
    expect(mark.value.querySelector('[data-obsolescence="outdated"]')?.textContent).toBe(
      'Outdated',
    );
    expect(within(mark.value).getByTestId('mark-holds-status').textContent).toBe(
      'Stays Done while marked',
    );

    const note = railRow(peek, 'Note')!;
    expect(within(note.term).getByText('changed')).toBeTruthy();
    expect(within(note.value).getByTestId('mark-note').className).not.toContain('line-clamp-3');
    expect(within(note.value).queryByRole('button')).toBeNull();

    const by = railRow(peek, 'Superseded by')!;
    const chip = within(by.value).getByTestId('supersedes-chip');
    expect(chip.getAttribute('data-ref')).toBe('proposal');
    // A proposed chip opens THAT proposal's peek (§24.7).
    fireEvent.click(within(chip).getByTestId('supersedes-chip-open'));
    expect(onOpen).toHaveBeenCalledWith('pi_new');

    expect(screen.getByTestId('quick-view-proposal-foot').textContent).toContain(
      'This plan changes 3 of the 11 fields it can set.',
    );
  });

  it('a long note is clamped to three lines with Show all / Show less', async () => {
    render(
      <ProposalPeek
        item={markModify([markRow('outdated', 'deprecated'), noteRow(LONG_NOTE)], {
          status: 'cancelled',
          statusLabel: 'Cancelled',
        })}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const note = railRow(screen.getByTestId('proposal-peek'), 'Note')!;
    const text = within(note.value).getByTestId('mark-note');
    expect(text.className).toContain('line-clamp-3');
    const toggle = within(note.value).getByRole('button', { name: 'Show all' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(text.className).not.toContain('line-clamp-3');
    expect(
      within(note.value).getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('a CLEAR reads `Current` in secondary ink, with no holds line', async () => {
    render(
      <ProposalPeek item={markModify([markRow('deprecated', 'current')])} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const mark = railRow(screen.getByTestId('proposal-peek'), 'Mark')!;
    expect(mark.value.textContent).toBe('Current');
    expect(mark.value.querySelector('[data-obsolescence]')).toBeNull();
    expect(within(mark.value).queryByTestId('mark-holds-status')).toBeNull();
  });

  it('a committed chip is not a control', async () => {
    render(
      <ProposalPeek
        item={markModify([edgeRow('supersededBy', [PROD_44])])}
        onClose={() => {}}
        onOpenProposal={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const by = railRow(screen.getByTestId('proposal-peek'), 'Superseded by')!;
    expect(within(by.value).queryByTestId('supersedes-chip-open')).toBeNull();
    expect(within(by.value).getByTestId('planning-target-chip').textContent).toContain('PROD-44');
  });

  it('an `add` shows only an unsigned Supersedes row, last, with no changed mark', async () => {
    render(<ProposalPeek item={supersedingAdd([PROD_21, PROD_9])} onClose={() => {}} />);
    const peek = screen.getByTestId('proposal-peek');
    const terms = railTerms(peek);
    expect(terms).not.toContain('Mark');
    expect(terms).not.toContain('Note');
    const row = railRow(peek, 'Supersedes')!;
    expect(within(row.term).queryByText('changed')).toBeNull();
    const chips = within(row.value).getAllByTestId('supersedes-chip');
    expect(chips).toHaveLength(2);
    expect(chips.every((c) => c.getAttribute('data-delta') === null)).toBe(true);
  });
});

// ── Empty (§24.11) ──────────────────────────────────────────────────────────

describe('a plan with no marks renders exactly as today', () => {
  it('no Mark row, no pill, no chips, no holds line, no lock change', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => TARGET_PAYLOAD })),
    );
    const plain = markModify([{ field: 'priority', from: 'medium', to: 'high' }], {
      status: 'in_progress',
      statusLabel: 'In Progress',
      statusCategory: 'in_progress',
    });
    const { unmount } = render(
      <>
        <PlanItemNode item={plain} />
        <PlanItemNode item={supersedingAdd([])} />
        <PlanProposalList items={[plain]} outcome={null} />
      </>,
    );
    expect(document.querySelector('[data-obsolescence]')).toBeNull();
    expect(screen.queryByTestId('plan-item-supersedes')).toBeNull();
    expect(screen.queryByTestId('supersedes-chip')).toBeNull();
    expect(screen.queryByTestId('mark-holds-status')).toBeNull();
    expect(screen.queryByText('Mark')).toBeNull();
    expect(
      screen.getAllByTestId('plan-item-node').every((n) => n.getAttribute('data-locked') === null),
    ).toBe(true);
    unmount();

    render(<ProposalPeek item={plain} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    const terms = railTerms(screen.getByTestId('proposal-peek'));
    for (const t of ['Mark', 'Note', 'Supersedes', 'Superseded by']) expect(terms).not.toContain(t);
  });
});

// ── Copy (§24.14) ───────────────────────────────────────────────────────────

describe('every new string exists in both catalogs', () => {
  const KEYS = [
    'field_obsolescence',
    'field_obsolescenceNote',
    'field_supersedes',
    'field_supersededBy',
    'obsolescenceCurrent',
    'markHoldsStatus',
    'nodeProposedMark',
    'nodeSupersedes',
    'nodeSupersedesTitle',
    'edgeAdds',
    'edgeRemoves',
    'noteShowAll',
    'noteShowLess',
  ] as const;
  it.each([
    ['en', enMessages],
    ['zh', zhMessages],
  ] as const)('%s', (_locale, messages) => {
    const block = messages.planReview as Record<string, unknown>;
    for (const key of KEYS) expect(block[key], key).toBeTruthy();
  });
  it('the design’s own words', () => {
    expect(enMessages.planReview.markHoldsStatus).toBe('Stays {status} while marked');
    expect(zhMessages.planReview.markHoldsStatus).toBe('标记期间保持{status}');
    expect(zhMessages.planReview.field_obsolescence).toBe('失效状态');
    expect(zhMessages.planReview.nodeSupersedes).toBe('取代 {n} 项');
  });
});
