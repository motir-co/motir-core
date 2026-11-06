// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import { PlanItemNode } from '@/components/planning/PlanItemNode';
import { PlanProposalList } from '@/components/planning/PlanProposalList';
import type { PlanItemChangeDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import zhMessages from '@/messages/zh.json';

// MOTIR-6055 — the plan review draws what AMENDMENT 18 lets a plan say
// (`design/ai-planning/design-notes.md` Part XIX, `plan-review--surgical-edits.mock.html`):
// a card moved under a PROPOSED parent names it `New · <title>` (§19.3), and a
// `remove`'s reason takes the node's bottom slot and a row in the list (§19.5).

afterEach(cleanup);

/** A `parent` change onto an un-created `add` — what the review model emits. */
const MOVE_UNDER_PROPOSED: PlanItemChangeDto = {
  field: 'parent',
  from: 'PROD-7',
  to: 'Webhook delivery guarantees',
  placement: {
    from: { kind: 'workItem', id: 'wi_7', identifier: 'PROD-7' },
    to: {
      kind: 'workItem',
      id: 'planItem:pi_s',
      identifier: null,
      proposedTitle: 'Webhook delivery guarantees',
    },
  },
};

function moved(change: PlanItemChangeDto = MOVE_UNDER_PROPOSED): PlanReviewItemDto {
  return planReviewItem({
    op: 'modify',
    nodeId: 'wi_9',
    identifier: 'PROD-9',
    title: 'Retry a failed delivery',
    changes: [change],
  });
}

function removal(removeReason: string | null): PlanReviewItemDto {
  return planReviewItem({
    op: 'remove',
    nodeId: 'wi_52',
    identifier: 'PROD-52',
    title: 'Legacy CSV export',
    removeReason,
  });
}

const REASON = 'Replaced by the JSON export (PROD-38). Nothing has read the CSV since.';

describe('a card moved under a PROPOSED parent (§19.3)', () => {
  it('the node’s diff line names it `New · <title>`, with the full string in `title`', () => {
    renderWithIntl(<PlanItemNode item={moved()} />);
    const line = screen.getByTestId('diff-line');
    expect(line.textContent).toContain('New · Webhook delivery guarantees');
    expect(line.textContent).not.toContain('planItem:');
    expect(line.querySelector('[title="New · Webhook delivery guarantees"]')).toBeTruthy();
    // The row stays `Parent` — no folder is on either side.
    expect(line.textContent).toContain('Parent');
  });

  it('the list row reads `PROD-7 → New · <title>`', () => {
    renderWithIntl(<PlanProposalList items={[moved()]} outcome={null} />);
    expect(screen.getByText('New · Webhook delivery guarantees')).toBeTruthy();
    expect(document.body.textContent).not.toContain('planItem:');
  });

  it('after approve the side carries the created KEY and reads it', () => {
    const approved: PlanItemChangeDto = {
      ...MOVE_UNDER_PROPOSED,
      to: 'PROD-60',
      placement: {
        from: MOVE_UNDER_PROPOSED.placement!.from,
        to: { kind: 'workItem', id: 'planItem:pi_s', identifier: 'PROD-60' },
      },
    };
    renderWithIntl(<PlanProposalList items={[moved(approved)]} outcome="accepted" />);
    expect(screen.getByText('PROD-60')).toBeTruthy();
    expect(screen.queryByText(/New ·/)).toBeNull();
  });
});

describe('a remove’s REASON (§19.5)', () => {
  it('takes the node’s bottom slot — one line, full text in `title` — and clamps the title', () => {
    renderWithIntl(<PlanItemNode item={removal(REASON)} />);
    const slot = screen.getByTestId('remove-reason');
    expect(slot.textContent).toBe(`Reason${REASON}`);
    expect(slot.querySelector(`[title="${REASON}"]`)?.className).toContain('truncate');
    expect(screen.getByText('Legacy CSV export').className).toContain('truncate');
  });

  it('is a wrapping `Reason` row in the list', () => {
    renderWithIntl(<PlanProposalList items={[removal(REASON)]} outcome={null} />);
    const row = screen.getByTestId('remove-reason');
    expect(row.querySelector('dt')?.textContent).toBe('Reason');
    expect(row.querySelector('dd')?.textContent).toBe(REASON);
    expect(row.querySelector('dd')?.className).not.toContain('truncate');
  });

  // MOTIR-10508: with no footer, the title-only body clamps at three lines.
  it('no reason ⇒ nothing drawn, and the title keeps its three lines', () => {
    renderWithIntl(<PlanItemNode item={removal(null)} />);
    expect(screen.queryByTestId('remove-reason')).toBeNull();
    expect(screen.getByText('Legacy CSV export').className).toContain('line-clamp-3');
    cleanup();
    renderWithIntl(<PlanProposalList items={[removal(null)]} outcome={null} />);
    expect(screen.queryByTestId('remove-reason')).toBeNull();
  });

  it('reads in Chinese as 原因', () => {
    renderWithIntl(<PlanItemNode item={removal(REASON)} />, { locale: 'zh', messages: zhMessages });
    expect(screen.getByTestId('remove-reason').textContent).toContain('原因');
  });
});
