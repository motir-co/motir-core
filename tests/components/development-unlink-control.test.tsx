// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, fireEvent, within } from '@testing-library/react';

// happy-dom + the repo's own matchers — there is no jest-dom in this suite, so
// assertions read off `textContent` / node identity rather than `toBeInTheDocument`.
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { LinkedPullRequestDto } from '@/lib/dto/github';

// MOTIR-4878 · MOTIR-5005 — REMOVING a linked pull request from the Development
// section (`design/github/design-notes.md` Panels 5d–5f).
//
// Every assertion here failed before this card, and each one failed for its own
// reason rather than all of them for one:
//
//   * the control did not exist at all — `unlinkPullRequest` shipped with the
//     MCP tool as its only caller, so an agent could retract a delivery and a
//     person could not, while the completion gate's own note told the reader on
//     the card to "unlink it";
//   * the row had no way to ADDRESS a pull request — `LinkedPullRequestDto`
//     carried no `id`, which is what the service takes;
//   * and the read-only peek shares this component, so a control added without
//     a host seam would have appeared on a surface whose contract is
//     "Read-only — editing lives on the full page".
//
// The gating case is therefore not a courtesy test: it is the one that keeps
// the shared component honest, and it asserts ABSENCE rather than a disabled
// control, which is design Q4's decision.

const linkPullRequestAction = vi.fn();
const listPullRequestCandidatesAction = vi.fn();
const unlinkPullRequestAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(authed)/items/[key]/actions', () => ({
  linkPullRequestAction: (...args: unknown[]) => linkPullRequestAction(...args),
  listPullRequestCandidatesAction: (...args: unknown[]) => listPullRequestCandidatesAction(...args),
  unlinkPullRequestAction: (...args: unknown[]) => unlinkPullRequestAction(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import {
  DevelopmentLinkProvider,
  RemovePullRequestLinkButton,
} from '@/app/(authed)/items/[key]/_components/DevelopmentLinkControl';

const PR: LinkedPullRequestDto = {
  id: 'pr-131',
  title: 'Add per-route rate limiting',
  repo: 'moooon/motir-core',
  number: 131,
  state: 'merged',
  ci: 'passing',
  headSha: null,
  url: 'https://github.com/moooon/motir-core/pull/131',
  githubReview: null,
  preview: null,
  baseRef: 'main',
  conflicted: false,
};

const REMOVE_ARIA = 'Remove the link to moooon/motir-core · #131';

beforeEach(() => {
  unlinkPullRequestAction.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

/** The DETAIL-page host: the section with the control supplied per row. */
function renderWithControl() {
  return render(
    <DevelopmentLinkProvider currentItemId="wi-1" identifier="MOTIR-5005">
      <DevelopmentSectionBody
        pullRequests={[PR]}
        itemIdentifier="MOTIR-5005"
        manualLinkable
        rowAction={(pr) => (
          <RemovePullRequestLinkButton
            pullRequestId={pr.id}
            target={`${pr.repo} · #${pr.number}`}
          />
        )}
      />
    </DevelopmentLinkProvider>,
  );
}

describe('the per-row REMOVE control (design Panels 5d–5f)', () => {
  it('draws an icon-only control on the row, named by aria-label, AFTER the link-out', () => {
    renderWithControl();
    const remove = screen.getByRole('button', { name: REMOVE_ARIA });

    // Icon-only, and its accessible name is the aria-label — NOT an sr-only
    // span, for the reason PullRequestRow's own comment gives (an sr-only span
    // is position:absolute and stretches the root scroller).
    expect(remove.textContent).toBe('');

    // LAST in the row, after the GitHub link-out — the relationships panel's
    // order, where the destructive action terminates the row.
    const row = remove.closest('li');
    expect(row).not.toBeNull();
    const linkOut = within(row!).getByRole('link', { name: 'Open on GitHub' });
    expect(linkOut.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws NO control — not a disabled one — when the host supplies none (the peek, and a reader without edit)', () => {
    render(<DevelopmentSectionBody pullRequests={[PR]} itemIdentifier="MOTIR-5005" />);

    // The row still renders, with its link-out…
    expect(screen.getByRole('link', { name: 'Open on GitHub' })).toBeTruthy();
    // …and nothing that removes anything, in any state.
    expect(screen.queryByRole('button', { name: /Remove the link/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove link/ })).toBeNull();
  });

  it('CONFIRMS before it writes — the press opens a confirm and calls nothing', () => {
    renderWithControl();
    fireEvent.click(screen.getByRole('button', { name: REMOVE_ARIA }));

    expect(unlinkPullRequestAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('the confirm SAYS the pull request is not touched on GitHub, and names the row', () => {
    renderWithControl();
    fireEvent.click(screen.getByRole('button', { name: REMOVE_ARIA }));

    // The reader's actual fear is not "will this delete a record?" but "will
    // this do something to my pull request on GitHub?" — so the copy answers
    // that one. This assertion is what keeps the promise true if the service
    // ever changes what an unlink touches.
    const confirm = screen.getByText(/isn’t touched on GitHub/);
    expect(confirm.textContent).toContain('moooon/motir-core · #131');
    expect(confirm.textContent).toMatch(/only the link/);
  });

  it('writes on confirm — the pull request id, the item, and a refresh', async () => {
    unlinkPullRequestAction.mockResolvedValue({ ok: true });
    renderWithControl();
    fireEvent.click(screen.getByRole('button', { name: REMOVE_ARIA }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));

    await vi.waitFor(() => expect(unlinkPullRequestAction).toHaveBeenCalledTimes(1));
    expect(unlinkPullRequestAction).toHaveBeenCalledWith({
      currentItemId: 'wi-1',
      identifier: 'MOTIR-5005',
      pullRequestId: 'pr-131',
    });
    // The rows are server-rendered, so the card reconciles by refresh — the
    // same mechanism the LINK arm on this surface uses.
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('CANCEL writes nothing', () => {
    renderWithControl();
    fireEvent.click(screen.getByRole('button', { name: REMOVE_ARIA }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(unlinkPullRequestAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a REJECTED write keeps the confirm open and shows the reason', async () => {
    unlinkPullRequestAction.mockResolvedValue({
      ok: false,
      error: 'That pull request could not be found.',
    });
    renderWithControl();
    fireEvent.click(screen.getByRole('button', { name: REMOVE_ARIA }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));

    expect(await screen.findByText('That pull request could not be found.')).toBeTruthy();
    // Still open, so the message is where the user last looked.
    expect(screen.getByRole('button', { name: 'Remove link' })).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});
