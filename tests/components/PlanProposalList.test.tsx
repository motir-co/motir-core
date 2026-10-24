// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PlanProposalList } from '@/components/planning/PlanProposalList';

// MOTIR-3239 — the plan detail's LIST body, built to
// `design/ai-planning/design-notes.md` Part VIII §3 and
// `plan-detail-list-view.mock.html` panel 2.
//
// The canvas answers where a proposal LANDS. This answers what exactly is being
// approved, which is a question about a SET — and the two properties worth
// pinning are the ones a screenshot would agree with while being wrong: that
// ALL THREE ops are shown, and that a `modify`'s diff is spelled out rather than
// signalled.

afterEach(cleanup);

const add = (over = {}) =>
  planReviewItem({
    planItemId: 'a1',
    op: 'add',
    title: 'A proposed story',
    kind: 'story',
    ...over,
  });
const modify = (over = {}) =>
  planReviewItem({
    planItemId: 'm1',
    op: 'modify',
    identifier: 'MOTIR-812',
    title: 'Payout ledger',
    changes: [{ field: 'title', from: 'Payout ledger', to: 'Payout ledger + reconciliation' }],
    ...over,
  });
const remove = (over = {}) =>
  planReviewItem({
    planItemId: 'r1',
    op: 'remove',
    identifier: 'MOTIR-851',
    title: 'Legacy CSV export',
    ...over,
  });

describe('the list shows ALL THREE ops (MOTIR-3239)', () => {
  it('renders Adds, Updates AND Archives, each as its own section', () => {
    // ⚠️ THE LOAD-BEARING ONE. A list showing two ops under a row whose item
    // count includes three is a surface arguing with itself — and that count is
    // on the row that got the reader here. `remove` is rare, not excluded.
    renderWithIntl(<PlanProposalList items={[add(), modify(), remove()]} outcome={null} />);

    expect(screen.getByText('Adds')).toBeTruthy();
    expect(screen.getByText('Updates')).toBeTruthy();
    expect(screen.getByText('Archives')).toBeTruthy();
    expect(screen.getByText('Legacy CSV export')).toBeTruthy();
    // The row CHIP says panel B's word, not the header's — the header names a
    // group, the chip names what happens to this card.
    // These are the SHIPPED canvas badge strings, reused rather than restated —
    // `remove`, not a fourth word for the same op.
    expect(screen.getByText('add')).toBeTruthy();
    expect(screen.getByText('change')).toBeTruthy();
    expect(screen.getByText('remove')).toBeTruthy();
  });

  it('a section with nothing in it does not render', () => {
    renderWithIntl(<PlanProposalList items={[add()]} outcome={null} />);

    expect(screen.getByText('Adds')).toBeTruthy();
    expect(screen.queryByText('Updates')).toBeNull();
    expect(screen.queryByText('Archives')).toBeNull();
  });

  it('each section carries its own count', () => {
    renderWithIntl(
      <PlanProposalList
        items={[add(), add({ planItemId: 'a2', title: 'Another' }), modify()]}
        outcome={null}
      />,
    );

    const adds = screen.getByText('Adds').closest('h3')!;
    expect(within(adds).getByText('2')).toBeTruthy();
  });
});

describe('the row (MOTIR-3239)', () => {
  it('an `add` has NO KEY and says so rather than leaving a gap', () => {
    // `identifier` is null until approve materializes it. An empty slot in a
    // column of keys reads as a missing value; this reads as the fact it is.
    renderWithIntl(<PlanProposalList items={[add()]} outcome={null} />);

    expect(screen.getByText('no key yet')).toBeTruthy();
  });

  it('a `modify` shows its key, and a `remove` strikes its title', () => {
    renderWithIntl(<PlanProposalList items={[modify(), remove()]} outcome={null} />);

    expect(screen.getByText('MOTIR-812')).toBeTruthy();
    expect(screen.getByText('Legacy CSV export').className).toContain('line-through');
  });

  it('carries the facts a reviewer decides on', () => {
    renderWithIntl(
      <PlanProposalList
        items={[
          add({ type: 'code', storyPoints: 5, estimateMinutes: 90, targetRepo: 'motir-core' }),
        ]}
        outcome={null}
      />,
    );

    expect(screen.getByText(/story · code · 5 pts · 90 min · motir-core/)).toBeTruthy();
  });

  it('names WHERE it lands, and marks an intra-plan parent as proposed', () => {
    renderWithIntl(
      <PlanProposalList
        items={[
          add({ parentNodeId: 'pi_0', parentIdentifier: null, parentTitle: 'A proposed story' }),
        ]}
        outcome={null}
      />,
    );

    // The container does not exist yet either, and a reader deciding on this row
    // should know that.
    expect(screen.getByText(/under A proposed story/)).toBeTruthy();
    expect(screen.getByText('(proposed)')).toBeTruthy();
  });

  it('flags a stale proposal', () => {
    renderWithIntl(
      <PlanProposalList
        items={[add({ stale: true, staleReasons: ['parent_removed'] })]}
        outcome={null}
      />,
    );

    expect(screen.getByText('may be out of date')).toBeTruthy();
  });
});

describe('a `modify`’s diff is SPELLED OUT, not signalled (MOTIR-3239)', () => {
  it('shows the field, the old value struck through, and the new one', () => {
    // The canvas's overlay answers *this node is changing* inside a ~280px card:
    // it is a SIGNAL. The list answers *changing to WHAT*, at pane width, for a
    // reader deciding whether to approve.
    renderWithIntl(<PlanProposalList items={[modify()]} outcome={null} />);

    // The LABEL, not the wire name — see the field-label totality guard.
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('Payout ledger + reconciliation')).toBeTruthy();
    // The TITLE is also 'Payout ledger', so pick the one inside the diff line.
    const old = screen.getAllByText('Payout ledger').find((n) => n.closest('dd') != null)!;
    expect(old.className).toContain('line-through');
  });

  it('a BODY-valued field is NAMED, not quoted', () => {
    // A rewritten description is not a diff a review list can carry, and a
    // truncated one is worse than a pointer.
    renderWithIntl(
      <PlanProposalList
        items={[
          modify({
            changes: [{ field: 'description', from: 'old body…', to: 'a completely new body…' }],
          }),
        ]}
        outcome={null}
      />,
    );

    expect(screen.getByText('Description')).toBeTruthy();
    expect(screen.getByText('rewritten — open the item to read it')).toBeTruthy();
    expect(screen.queryByText(/a completely new body/)).toBeNull();
  });

  it('a change with no OLD value shows only the new one', () => {
    renderWithIntl(
      <PlanProposalList
        items={[modify({ changes: [{ field: 'priority', from: null, to: 'high' }] })]}
        outcome={null}
      />,
    );

    expect(screen.getByText('high')).toBeTruthy();
  });
});

describe('the row’s remaining arms (MOTIR-3242 — the story gate’s top-up)', () => {
  it('falls back to the parent IDENTIFIER when the title is not carried', () => {
    renderWithIntl(
      <PlanProposalList
        items={[add({ parentNodeId: 'wi_p', parentIdentifier: 'MOTIR-653', parentTitle: null })]}
        outcome={null}
      />,
    );

    expect(screen.getByText(/under MOTIR-653/)).toBeTruthy();
    // A committed parent is NOT marked proposed.
    expect(screen.queryByText('(proposed)')).toBeNull();
  });

  it('renders a row that carries a live STATUS', () => {
    renderWithIntl(
      <PlanProposalList
        items={[
          modify({
            status: 'in_progress',
            statusLabel: 'In Progress',
            statusCategory: 'in_progress',
          }),
        ]}
        outcome={null}
      />,
    );

    expect(screen.getByText('In Progress')).toBeTruthy();
  });

  it('a change that REMOVES a value shows the em-dash, not an empty slot', () => {
    // `to: null` is the shape a `modify` takes when it clears a field. An empty
    // cell in a diff reads as a rendering failure.
    renderWithIntl(
      <PlanProposalList
        items={[modify({ changes: [{ field: 'priority', from: 'high', to: null }] })]}
        outcome={null}
      />,
    );

    expect(screen.getByText('—')).toBeTruthy();
  });

  it('a row with NO facts at all still renders', () => {
    // Every fact is optional on the DTO; a proposal with none must not produce an
    // empty separator line.
    renderWithIntl(
      <PlanProposalList
        items={[
          add({
            kind: '',
            type: null,
            storyPoints: null,
            estimateMinutes: null,
            targetRepo: null,
            parentNodeId: null,
            parentIdentifier: null,
            parentTitle: null,
          }),
        ]}
        outcome={null}
      />,
    );

    expect(screen.getByText('A proposed story')).toBeTruthy();
  });

  it('every member of the op enum has a section — asserted at BUILD time', () => {
    // ⚠️ THE RUNTIME TEST THIS REPLACES WAS WRONG, and writing it is what found
    // the gap. It asserted that an unrecognised op "renders no chip rather than
    // throwing" — and the row does not render AT ALL, because the list is built
    // by iterating the three sections. A proposal that silently never appears,
    // under an item count that includes it, is precisely the self-contradiction
    // the three-section decision exists to prevent.
    //
    // So the guarantee is moved to the compiler: `AssertTotalListOps` in
    // `PlanProposalList.tsx` makes a fourth `PlanItemOpDto` member a BUILD error
    // rather than an invisible row. This test states that the three the enum has
    // today all reach a section, so the runtime half is covered too.
    renderWithIntl(<PlanProposalList items={[add(), modify(), remove()]} outcome={null} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('an unknown KIND falls back to the task glyph rather than throwing', () => {
    renderWithIntl(<PlanProposalList items={[add({ kind: 'epicish' })]} outcome={null} />);

    expect(screen.getByText('A proposed story')).toBeTruthy();
  });
});

describe('the states (MOTIR-3239)', () => {
  // ⚠️ AMENDED by MOTIR-4146, and the amendment is the point rather than a
  // string update. This case read *"says what approving it would do"* and
  // asserted *"Nothing will change if you approve it"* — a sentence about a
  // control that, since MOTIR-4146, is not on the screen: the rail renders no
  // Approve over an empty plan. Copy describing an absent button is how a
  // reader is sent looking for one. What the pane owes now is the move that IS
  // available, which is the same one the rail's own empty hint names.
  it('EMPTY — a plan that proposes nothing names the move that is left', () => {
    renderWithIntl(<PlanProposalList items={[]} outcome={null} />);

    expect(screen.getByText('No proposals')).toBeTruthy();
    expect(screen.getByText(/Declining ends it/)).toBeTruthy();
    expect(screen.queryByText(/if you approve it/)).toBeNull();
  });

  it('APPROVED — the list is a RECORD, in the past tense', () => {
    // Part VI made this pane a record of what was accepted. The list is the same
    // pane's other body, so it says the same thing in the same tense.
    renderWithIntl(<PlanProposalList items={[add(), modify(), remove()]} outcome="accepted" />);

    // The SECTION headers move to the past tense…
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('Applied')).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.queryByText('Adds')).toBeNull();
    // …and so do the row CHIPS, which carry panel B's vocabulary rather than the
    // header's.
    expect(screen.getByText('created')).toBeTruthy();
    expect(screen.queryByText('add')).toBeNull();
  });
});

describe('the THREE-VALUED outcome, all nine cells (MOTIR-4495)', () => {
  // `decided` was a BOOLEAN over a three-valued axis, so a DECLINE took the
  // APPROVE arm and the list said `Created` / `Applied` / `Archived` about work
  // that never happened. Reproduced on `origin/main` through this same door:
  //
  //   HEADINGS: ["Created1","Applied1","Archived1"]
  //   ROWS:     "no key yet … subtask · code · 3 pts created"   ← the `add` row
  //             contradicting itself inside one line
  //
  // The nine cells are asserted as a MATRIX rather than as three more cases,
  // because the defect was that two of the three columns were the same column.
  const HEADINGS = {
    null: ['Adds', 'Updates', 'Archives'],
    accepted: ['Created', 'Applied', 'Archived'],
    declined: ['Adds', 'Updates', 'Archives'],
  } as const;
  const CHIPS = {
    null: ['add', 'change', 'remove'],
    accepted: ['created', 'applied', 'archived'],
    declined: ['add', 'change', 'remove'],
  } as const;

  it.each([
    ['a PENDING plan', null, 'null'],
    ['an APPROVED plan', 'accepted', 'accepted'],
    ['a DECLINED plan', 'declined', 'declined'],
  ] as const)('%s renders its own three headings and three chips', (_label, outcome, key) => {
    renderWithIntl(<PlanProposalList items={[add(), modify(), remove()]} outcome={outcome} />);

    for (const heading of HEADINGS[key]) expect(screen.getByText(heading)).toBeTruthy();
    for (const chip of CHIPS[key]) expect(screen.getByText(chip)).toBeTruthy();
  });

  it('a DECLINED plan says NOTHING in the past tense — the defect, asserted directly', () => {
    // Per Part VIII §3: *"A declined plan's list keeps the proposal tense and
    // adds no outcome chip: nothing happened to those cards."*
    renderWithIntl(<PlanProposalList items={[add(), modify(), remove()]} outcome="declined" />);

    for (const word of ['Created', 'Applied', 'Archived', 'created', 'applied', 'archived']) {
      expect(screen.queryByText(word), word).toBeNull();
    }
  });

  it("a DECLINED `add`'s row does not claim a creation beside its own `no key yet`", () => {
    // The sharpest cell: the row that contradicted itself in one line.
    renderWithIntl(<PlanProposalList items={[add()]} outcome="declined" />);
    const row = screen.getByRole('listitem').textContent ?? '';
    expect(row).toContain('no key yet');
    expect(row).toContain('add');
    expect(row).not.toContain('created');
  });
});

describe('the field LABEL, not the wire name (MOTIR-3242)', () => {
  it('renders the catalogue label for a camelCase wire field', () => {
    // `storyPoints` would otherwise read as STORYPOINTS — the shape that once put
    // `planReview.field_storyPoints` on the canvas in front of a reviewer.
    renderWithIntl(
      <PlanProposalList
        items={[modify({ changes: [{ field: 'storyPoints', from: '3', to: '5' }] })]}
        outcome={null}
      />,
    );

    expect(screen.getByText('Story points')).toBeTruthy();
    expect(screen.queryByText('storyPoints')).toBeNull();
  });

  it('a field with NO copy degrades to the wire name rather than leaking a key path', () => {
    // `PlanItemChangeDto.field` is deliberately a plain `string`: a client bundle
    // can be older than the server that answered it, and a surface that cannot
    // represent an unknown field cannot fall back for one.
    renderWithIntl(
      <PlanProposalList
        items={[modify({ changes: [{ field: 'somethingNew', from: 'a', to: 'b' }] })]}
        outcome={null}
      />,
    );

    expect(screen.getByText('somethingNew')).toBeTruthy();
    expect(screen.queryByText(/planReview\.field_/)).toBeNull();
  });
});

// ── THE HEADLINE IS THE PROPOSED TITLE (MOTIR-4018, design Part XIII §1) ──────
//
// The producer now reports the title the proposal is ASKING for, so the row's
// headline names the card as the plan leaves it. What must NOT follow is the
// change line losing the outgoing name: Part VIII §3 split these deliberately —
// the headline says what the card will BE, the `TITLE` line says what it is
// leaving — and a row showing the new name twice would take the old one off the
// only surface that spells it.
describe('a renaming modify (MOTIR-4018)', () => {
  const renaming = () =>
    planReviewItem({
      planItemId: 'm-rename',
      op: 'modify',
      identifier: 'MOTIR-812',
      // As `getPlanReview` now emits it: the PROPOSED title.
      title: 'Invoice templates + branding',
      changes: [{ field: 'title', from: 'Invoice templates', to: 'Invoice templates + branding' }],
    });

  it('shows the PROPOSED title as the headline, beside the committed key', () => {
    renderWithIntl(<PlanProposalList items={[renaming()]} outcome={null} />);
    // The proposed title appears TWICE on the row, and that is the design: once
    // as the headline (what the card will BE) and once as the `to` side of the
    // TITLE change line (what it is changing to). Take the first — the headline.
    const headline = screen.getAllByText('Invoice templates + branding')[0]!;
    expect(headline.className).toContain('text-sm');
    const row = headline.closest('li') as HTMLElement;
    expect(within(row).getByText('MOTIR-812')).toBeTruthy();
  });

  it('still spells `old → new` on the TITLE change line', () => {
    renderWithIntl(<PlanProposalList items={[renaming()]} outcome={null} />);
    const row = screen
      .getAllByText('Invoice templates + branding')[0]!
      .closest('li') as HTMLElement;
    // The OUTGOING name survives, exactly once, and on the line whose job it is.
    const struck = within(row).getByText('Invoice templates');
    expect(struck.className).toContain('line-through');
  });
});

// ── A LIST ROW OPENS ITS PROPOSAL (MOTIR-4022, design Part XIII §7) ───────────
//
// The row was an inert `<li>`: no handler, no role, no key binding — and
// `ProposalQuickView` was built, shipped, and mounted only by the canvas. So the
// list was the one body of the two that can say what a card CONTAINS and the only
// one that could not open it.
describe('the row opens its proposal', () => {
  it('carries exactly ONE control, and it is the title', () => {
    renderWithIntl(<PlanProposalList items={[add(), modify(), remove()]} outcome={null} />);
    // One tab stop per row. A row of buttons is the shipped listbox-rows a11y
    // lesson, and the chips beside the title stay non-interactive text.
    const rows = screen.getAllByRole('listitem');
    for (const row of rows) {
      expect(within(row).getAllByRole('button')).toHaveLength(1);
    }
  });

  it('names itself `Open <key> · <title>`, and `New · <title>` when the card has no key yet', () => {
    renderWithIntl(<PlanProposalList items={[add(), modify()]} outcome={null} />);
    // The visible title is contained in the accessible name (WCAG 2.5.3), and an
    // `add` is named the way this surface already names a keyless card.
    expect(screen.getByRole('button', { name: 'Open MOTIR-812 · Payout ledger' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open New · A proposed story' })).toBeTruthy();
  });

  it('opens the SAME quick view the canvas’s View pill opens, and closes again', async () => {
    renderWithIntl(<PlanProposalList items={[add()]} outcome={null} />);
    expect(screen.queryByTestId('proposal-peek')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open New · A proposed story' }));
    expect(await screen.findByTestId('proposal-peek')).toBeTruthy();

    // ⚠️ ONE close affordance. The shipped modal rendered TWO controls named
    // `Close` — the base `Modal`'s corner x beside the header's own button — and
    // this is the assertion that keeps `hideClose` from being dropped.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('button', { name: /close/i })).toHaveLength(1);
  });

  it('stretches its hit area over the whole row, so the row is the target', () => {
    renderWithIntl(<PlanProposalList items={[modify()]} outcome={null} />);
    const button = screen.getByRole('button', { name: /^Open MOTIR-812/ });
    // `after:inset-0` is what makes the row clickable without wrapping the `<dl>`
    // of change lines in a `<button>`, which would be invalid markup.
    expect(button.className).toContain('after:absolute');
    expect(button.className).toContain('after:inset-0');
    const row = button.closest('li') as HTMLElement;
    expect(row.className).toContain('relative');
    // The ring frames the ROW, not the title's text box.
    expect(row.className).toContain('focus-within:ring-2');
  });
});

// ── THE PEEK-ROUTING SEAM (MOTIR-4025) ───────────────────────────────────────
//
// The property that stops the two bodies diverging: for the SAME proposal, the
// list and the canvas open the SAME modal. The canvas half is asserted in
// `plan-review-canvas.test.tsx`; this is the list half, run over all four item
// shapes — because the row's accessible name is built from `identifier`, and an
// `add` before and after materialization are the two cases that differ.
//
// ⚠️ AMENDED (bug MOTIR-4471). This block used to expect `proposal-peek` for ALL
// FOUR shapes, which asserted the very divergence its own header forbids: the
// canvas routes a MATERIALIZED `add` to the ordinary work-item peek
// (`PlanReviewCanvas.onView`, MOTIR-3161) because the proposal has become a
// card, so a list expecting proposal mode for that shape was opening a DIFFERENT
// modal from the canvas, not the same one. The seam is unchanged; the per-shape
// expectation is what was wrong.
describe('every item shape opens the same read view as the canvas', () => {
  const shapes: [string, ReturnType<typeof planReviewItem>, 'proposal' | 'committed'][] = [
    ['an add with no key yet', add(), 'proposal'],
    [
      'an add that has MATERIALIZED',
      planReviewItem({
        planItemId: 'a2',
        op: 'add',
        identifier: 'MOTIR-901',
        title: 'Created card',
      }),
      // It IS a work item now — `identifier != null` on an `add` is what says so.
      'committed',
    ],
    ['a modify', modify(), 'proposal'],
    ['a remove', remove(), 'proposal'],
  ];

  for (const [label, item, door] of shapes) {
    it(`opens for ${label}`, async () => {
      renderWithIntl(<PlanProposalList items={[item]} outcome={null} />);
      const row = screen.getByRole('button', { name: /^Open / });
      fireEvent.click(row);
      // One close, on every shape — not only on the one the fix was written for.
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getAllByRole('button', { name: /close/i })).toHaveLength(1);
      if (door === 'proposal') {
        expect(await screen.findByTestId('proposal-peek')).toBeTruthy();
      } else {
        expect(screen.queryByTestId('proposal-peek')).toBeNull();
        expect(screen.queryByTestId('quick-view-op')).toBeNull();
      }
    });
  }
});

// ── CLOSING RETURNS FOCUS TO THE ROW (MOTIR-4022 · MOTIR-4026) ────────────────
//
// The E2E walk found this and it is asserted here too, because the E2E is a
// RECEIPT and this is the regression surface: after opening a row with Enter and
// pressing Escape, focus was returned to NOTHING and a keyboard user had to Tab
// from the top of the page. The dialog is mounted inside this list, so its
// unmount lands in the same commit that re-renders the rows and the shipped
// `Modal`'s own restore fires before the row it should return to is settled.
describe('closing the quick view', () => {
  it('returns focus to the row that opened it', async () => {
    renderWithIntl(<PlanProposalList items={[add(), modify()]} outcome={null} />);
    const row = screen.getByRole('button', { name: 'Open New · A proposed story' });

    row.focus();
    fireEvent.click(row);
    expect(await screen.findByTestId('proposal-peek')).toBeTruthy();

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /close/i }));

    // The restore is deferred one frame, past the unmount it would otherwise race.
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(row);
  });

  it('returns focus to the RIGHT row when a second one was opened', async () => {
    // The ref must follow the trigger, not the first row that ever opened one —
    // the failure mode a single-row test cannot see.
    renderWithIntl(<PlanProposalList items={[add(), modify()]} outcome={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open New · A proposed story' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /close/i }));
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    const second = screen.getByRole('button', { name: /^Open MOTIR-812/ });
    fireEvent.click(second);
    expect(await screen.findByTestId('proposal-peek')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /close/i }));
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(second);
  });
});

describe('the list reserves the floating confirm bar (MOTIR-7726)', () => {
  // On the planning surface the confirm bar FLOATS over the pane's bottom edge and
  // the host publishes its height as `--canvas-foot-inset` (MOTIR-6186). A scroller
  // that ignores it ends its scroll range UNDER the bar — a list that fits the box
  // but not the space above the bar has no scrollbar at all, and its last rows
  // cannot be reached. happy-dom lays nothing out, so the geometry is pinned by
  // `regression-plan-surface-views.spec.ts`; this pins the wiring, both boxes, and
  // the `0px` fallback that keeps the plan page (which sets no inset) unchanged.
  const INSET = 'var(--canvas-foot-inset,0px)';

  it('the scroller pads its own end by the inset, on top of its resting padding', () => {
    renderWithIntl(<PlanProposalList items={[add()]} outcome={null} />);

    const list = screen.getByTestId('plan-proposal-list');
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain(`pb-[calc(--spacing(3)+${INSET})]`);
  });

  it('the empty state centres itself in the space ABOVE the bar, not under it', () => {
    renderWithIntl(<PlanProposalList items={[]} outcome={null} />);

    const box = screen.getByText('No proposals').closest('div.h-full');
    expect(box?.className).toContain(`pb-[calc(--spacing(8)+${INSET})]`);
  });
});
