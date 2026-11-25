// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import {
  MergeOutcomeProvider,
  rowKey,
  type RowMergeOutcome,
} from '@/components/github/MergeOutcomeSlot';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import { CORE_PR } from '../helpers/howToTestFixtures';
import messages from '@/messages/en.json';

// THE ROW BETWEEN THE PRESS AND THE RE-READ (Bug MOTIR-12232). The press puts its outcome in
// the frame's client state at once; the rows are still the ones the page read BEFORE the press
// until `router.refresh()` lands. Before the fix that window drew **Open** beside **Merged** —
// the card's deterministic reproduction, rendered here: a row delivered `open` inside a
// provider holding `{ kind: 'merged' }` for it.

const PR_STATE = messages.github.development.prState;
const OUTCOME = messages.approvalGate.pullRequestApproval.outcome;
const CI_PASSING = messages.github.development.ciState.passing;

afterEach(cleanup);

function renderRow(pr: LinkedPullRequestDto, outcome: RowMergeOutcome | null) {
  const body = <DevelopmentSectionBody pullRequests={[pr]} itemIdentifier="ACME-12" />;
  render(
    outcome ? (
      <MergeOutcomeProvider value={new Map([[rowKey(pr.repo, pr.number), outcome]])}>
        {body}
      </MergeOutcomeProvider>
    ) : (
      body
    ),
  );
  return within(screen.getByText(pr.title).closest('li')!);
}

describe('a row the host answered `merged` for (Bug MOTIR-12232)', () => {
  it('still delivered open: the row reads Merged ONCE and never Open', () => {
    const row = renderRow(CORE_PR, { kind: 'merged' });
    expect(row.getAllByText(PR_STATE.merged)).toHaveLength(1);
    expect(row.queryByText(PR_STATE.open)).toBeNull();
    // The slot empties for a merge exactly as it does for a row delivered merged.
    expect(row.queryByText(CI_PASSING)).toBeNull();
  });

  it('delivered merged (the re-read, or the webhook, landed first): Merged once', () => {
    const row = renderRow({ ...CORE_PR, state: 'merged' }, { kind: 'merged' });
    expect(row.getAllByText(PR_STATE.merged)).toHaveLength(1);
    expect(row.queryByText(PR_STATE.open)).toBeNull();
  });

  it('a row the host later delivered CLOSED keeps the host’s word', () => {
    const row = renderRow({ ...CORE_PR, state: 'closed' }, { kind: 'merged' });
    expect(row.getByText(PR_STATE.closed)).toBeTruthy();
    expect(row.queryByText(PR_STATE.merged)).toBeNull();
  });
});

describe('every other outcome leaves the state pill as delivered', () => {
  it('an enqueued press draws Open with the Queued pill, unchanged', () => {
    const row = renderRow(CORE_PR, { kind: 'queued' });
    expect(row.getByText(PR_STATE.open)).toBeTruthy();
    expect(row.getByText(OUTCOME.queued)).toBeTruthy();
    expect(row.queryByText(PR_STATE.merged)).toBeNull();
  });

  it('no outcome at all: Open with the CI pill', () => {
    const row = renderRow(CORE_PR, null);
    expect(row.getByText(PR_STATE.open)).toBeTruthy();
    expect(row.getByText(CI_PASSING)).toBeTruthy();
  });
});
