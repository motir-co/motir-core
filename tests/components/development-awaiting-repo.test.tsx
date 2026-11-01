// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import messages from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';

// The Development section's ONE new element (Story MOTIR-2725 · MOTIR-2415,
// design `repository-set.mock.html` panel 1): a row for a repository the item
// CARRIES that has no pull request to show.
//
// It exists because the shipped section lists the pull requests that EXIST, and
// the whole point of the repository set is that a repository whose PR was never
// opened is invisible to anything counting rows — which is the state the
// completion gate holds an item for.
//
// The second property here is the boundary: the prop DEFAULTS to empty, so the
// quick view (which does not pass it until MOTIR-2416) renders byte-identically.

const t = messages.github.development;

afterEach(cleanup);

const merged: LinkedPullRequestDto = {
  id: 'pr-merged-2118',
  title: 'feat(work-items): the repository SET',
  repo: 'moooon/motir-core',
  number: 2118,
  state: 'merged',
  ci: 'passing',
  headSha: null,
  url: 'https://github.com/moooon/motir-core/pull/2118',
  githubReview: null,
  preview: null,
  baseRef: 'main',
  conflicted: false,
};

const awaiting = (repo: string, state: RepoDelivery['state'] = 'awaiting'): RepoDelivery => ({
  repo,
  state,
  primary: false,
});

describe('a repository with no pull request yet', () => {
  it('renders a row AFTER the real pull requests, naming the repository', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[merged]}
        itemIdentifier="MOTIR-2725"
        repoDelivery={[awaiting('moooon/motir-ai')]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The real PR first, the placeholder after — the same order the rail reads.
    expect(within(rows[0]!).getByText(merged.title)).toBeTruthy();
    expect(within(rows[1]!).getByText(t.noPullRequestYet)).toBeTruthy();
    expect(within(rows[1]!).getByText('moooon/motir-ai')).toBeTruthy();
    expect(within(rows[1]!).getByText(t.repoState.awaiting)).toBeTruthy();
  });

  it('says the branch is UNRECORDED for a merged PR whose base Motir never stored', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[merged]}
        itemIdentifier="MOTIR-2725"
        repoDelivery={[awaiting('moooon/motir-ai', 'unknown')]}
      />,
    );
    expect(screen.getByText(t.mergedBranchUnknown)).toBeTruthy();
    expect(screen.getByText(t.repoState.unknown)).toBeTruthy();
    // It must not claim the repository is simply outstanding — that is a
    // different, and false, statement about a merge that may have landed.
    expect(screen.queryByText(t.noPullRequestYet)).toBeNull();
  });

  it('says a CHILD delivered it — never "No pull request yet" (MOTIR-8811)', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[merged]}
        itemIdentifier="MOTIR-8699"
        repoDelivery={[awaiting('moooon/motir-ai', 'delivered_by_child')]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The merge is linked to the child card, so the story has no row of its own
    // for it — the placeholder says where it landed instead of "awaiting".
    expect(within(rows[1]!).getByText(t.deliveredByChildPullRequest)).toBeTruthy();
    expect(within(rows[1]!).getByText(t.repoState.delivered_by_child)).toBeTruthy();
    expect(screen.queryByText(t.noPullRequestYet)).toBeNull();
    expect(screen.queryByText(t.repoState.awaiting)).toBeNull();
  });

  it('replaces the big EmptyState when the item carries repositories but has NO pull requests', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[]}
        itemIdentifier="MOTIR-2725"
        repoDelivery={[awaiting('moooon/motir-core'), awaiting('moooon/motir-ai')]}
      />,
    );
    // Two placeholder rows say more than "no linked pull request" — they say
    // WHICH repositories are owed one.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(t.emptyTitle)).toBeNull();
  });

  it('still shows the EmptyState when the item carries NOTHING and has no pull requests', () => {
    render(<DevelopmentSectionBody pullRequests={[]} itemIdentifier="MOTIR-2725" />);
    expect(screen.getByText(t.emptyTitle)).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});

// MOTIR-3036 — A REPOSITORY WITH A PULL REQUEST IS NOT AWAITING A ROW.
//
// `awaiting` answers "has this repository's work MERGED?" — correct for the
// completion gate, and true for the whole life of every open pull request. Read
// as "no pull request exists" it drew a row saying "No pull request yet"
// directly beneath the pull request it was saying it about (observed on
// MOTIR-2903's quick view, 2026-08-18).
//
// The two sides also NAME the repository differently: the item stores the bare
// `motir-core` and the PR DTO carries `moooon-B-V/motir-core`, so every fixture
// here uses the real pair. A cross-reference on the raw strings matches nothing
// and this whole block passes only by accident of matching names.
const openPr: LinkedPullRequestDto = {
  id: 'pr-open-2120',
  title: 'feat(advisories): flag a card whose deliverable…',
  repo: 'moooon-B-V/motir-core',
  number: 2120,
  state: 'open',
  ci: 'running',
  headSha: null,
  url: 'https://github.com/moooon-B-V/motir-core/pull/2120',
  githubReview: null,
  preview: null,
  baseRef: 'main',
  conflicted: false,
};

describe('a repository whose pull request is already on the list', () => {
  it('renders ONLY the pull request row — no "No pull request yet" beneath it', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[openPr]}
        itemIdentifier="MOTIR-2903"
        repoDelivery={[awaiting('motir-core')]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText(openPr.title)).toBeTruthy();
    expect(within(rows[0]!).getByText(`${openPr.repo} · #${openPr.number}`)).toBeTruthy();
    expect(within(rows[0]!).getByText(t.prState.open)).toBeTruthy();
    expect(screen.queryByText(t.noPullRequestYet)).toBeNull();
  });

  it('keeps the row for the OTHER repository, the one that really has none', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[openPr]}
        itemIdentifier="MOTIR-2903"
        repoDelivery={[awaiting('motir-core'), awaiting('motir-ai')]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(openPr.title)).toBeTruthy();
    // Exactly one placeholder, and it names the repository that has no PR.
    expect(within(rows[1]!).getByText(t.noPullRequestYet)).toBeTruthy();
    expect(within(rows[1]!).getByText('motir-ai')).toBeTruthy();
    expect(within(rows[1]!).getByText(t.repoState.awaiting)).toBeTruthy();
    expect(screen.queryByText('motir-core')).toBeNull();
  });

  it('suppresses the row for a MERGED pull request too — the key is that one EXISTS', () => {
    // `merged` is still `awaiting` whenever the merge did not land on the
    // repository's default branch, so this is not a hypothetical shape: it is
    // the completion gate's own "merged onto a side branch" case. The row keys
    // on the pull request existing, never on its state.
    render(
      <DevelopmentSectionBody
        pullRequests={[{ ...openPr, state: 'merged' }]}
        itemIdentifier="MOTIR-2903"
        repoDelivery={[awaiting('motir-core')]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText(t.noPullRequestYet)).toBeNull();
  });

  it('falls back to the EmptyState when the set is fully covered by pull requests', () => {
    // The gate has to read the DERIVED rows, not the raw set: one repository,
    // one pull request, nothing else to draw.
    render(
      <DevelopmentSectionBody
        pullRequests={[]}
        itemIdentifier="MOTIR-2903"
        repoDelivery={[{ repo: 'motir-core', state: 'delivered', primary: true }]}
      />,
    );
    expect(screen.getByText(t.emptyTitle)).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});

describe('the prop is OPT-IN — the quick view is unchanged until MOTIR-2416', () => {
  it('renders byte-identically with the prop omitted and with it empty', () => {
    // MOTIR-2415's scope is the detail page. This component is mounted on BOTH
    // surfaces, so the new behaviour ships as a prop with an empty default and
    // the peek's output cannot move by accident.
    const withoutProp = render(
      <DevelopmentSectionBody pullRequests={[merged]} itemIdentifier="MOTIR-2725" />,
    ).container.innerHTML;
    cleanup();
    const withEmptyProp = render(
      <DevelopmentSectionBody
        pullRequests={[merged]}
        itemIdentifier="MOTIR-2725"
        repoDelivery={[]}
      />,
    ).container.innerHTML;
    expect(withEmptyProp).toBe(withoutProp);
  });
});
