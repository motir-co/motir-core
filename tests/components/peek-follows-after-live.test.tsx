// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { planReviewItem } from '../helpers/planReview';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import { currentPeekedProposal } from '@/lib/planning/peekedProposal';

// Bug MOTIR-11320 — an OPEN peek keeps its proposal's NEWEST copy when the plan
// leaves `generating`.
//
// A reader opened a proposal while it was still its outline, watched the walk
// write its body, and when the plan was proposed the peek went back to the
// outline: off `live` it fell back to the copy taken at open. Each door (the
// list and the canvas) is driven the way the reader drove it: open on the
// outline while live, the written body arrives, `live` flips false.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/plans/p1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/(authed)/items/[key]/edit/actions', () => ({
  updateIssueAction: vi.fn(),
  changeStatusAction: vi.fn(),
}));

import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';

const OUTLINE = planReviewItem({
  planItemId: 'pi_add',
  nodeId: 'pi_add',
  op: 'add',
  identifier: null,
  title: 'May the closed gateway consume the design system?',
  descriptionMd: '## Scope BOUNDARY\n\nThe outline only.',
  explanationMd: null,
  proposal: { op: 'add', identifier: null, changedFields: [], settableRailFields: [], todos: null },
});
const WRITTEN: PlanReviewItemDto = {
  ...OUTLINE,
  descriptionMd: '## Scope BOUNDARY\n\nThe outline only.\n\n## Question\n\nThe written body.',
};

const peekText = () => screen.getByTestId('proposal-peek').textContent ?? '';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ nodes: [], edges: [], offLevelBlockers: [] }),
        }) as unknown as Response,
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('an open peek keeps the written body once the plan is proposed (MOTIR-11320)', () => {
  it('through the list', async () => {
    const r = render(<PlanProposalList items={[OUTLINE]} outcome={null} live />);
    fireEvent.click(screen.getByRole('button', { name: /Open / }));
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    expect(peekText()).not.toContain('The written body.');

    r.rerender(<PlanProposalList items={[WRITTEN]} outcome={null} live />);
    expect(peekText()).toContain('The written body.');

    // The plan leaves `generating`: the snapshot is a new array, `live` is off.
    r.rerender(<PlanProposalList items={[{ ...WRITTEN }]} outcome={null} live={false} />);
    expect(peekText()).toContain('The written body.');
  });

  it('through the canvas', async () => {
    const r = render(<PlanReviewCanvas items={[OUTLINE]} projectKey="MOTIR" version={0} live />);
    const node = await waitFor(() => {
      const found = document.querySelector('[data-node-id="pi_add"]');
      if (!found) throw new Error('the canvas has not drawn its level yet');
      return found as HTMLElement;
    });
    fireEvent.keyDown(node, { key: 'Enter' });
    fireEvent.click(within(node).getByTestId('view-button'));
    await waitFor(() => expect(screen.getByTestId('proposal-peek')).toBeTruthy());
    expect(peekText()).not.toContain('The written body.');

    r.rerender(<PlanReviewCanvas items={[WRITTEN]} projectKey="MOTIR" version={0} live />);
    expect(peekText()).toContain('The written body.');

    r.rerender(
      <PlanReviewCanvas items={[{ ...WRITTEN }]} projectKey="MOTIR" version={1} live={false} />,
    );
    await waitFor(() => expect(peekText()).toContain('The written body.'));
  });
});

describe('currentPeekedProposal', () => {
  it('is null when no proposal is open', () => {
    expect(currentPeekedProposal([WRITTEN], null)).toBeNull();
  });

  it('answers the newest copy in the snapshot', () => {
    expect(currentPeekedProposal([WRITTEN], OUTLINE)).toBe(WRITTEN);
  });

  it('keeps the open-time copy of a proposal withdrawn mid-view', () => {
    expect(currentPeekedProposal([], OUTLINE)).toBe(OUTLINE);
  });
});
