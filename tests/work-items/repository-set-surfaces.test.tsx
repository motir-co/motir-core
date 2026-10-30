// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RepositorySetField } from '@/components/workItems/RepositorySetField';
import { DevelopmentSection } from '@/components/github/DevelopmentSection';
import type { RepoDelivery, RepoDeliveryState } from '@/lib/workItems/repoDelivery';
import type { LinkedPullRequestDto } from '@/lib/dto/github';
import enMessages from '@/messages/en.json';

// The two SURFACES that publish a card's repositories (Story MOTIR-2732 ·
// MOTIR-3042). The card no longer carries a repository NAME, it carries a
// reference to a row that has its own life — so both surfaces must draw all
// FIVE of ADR §A5's delivery states, and following a repository must land on
// that row rather than on a host repository a `proposed` row does not have.
//
// Asserted against the real `en` catalog through `renderWithIntl`, so a copy
// change that skips the catalog fails here rather than shipping.

afterEach(cleanup);

function row(repo: string, state: RepoDeliveryState, primary = false): RepoDelivery {
  return { repo, state, primary };
}

describe('RepositorySetField · the five delivery states', () => {
  it('renders every repository as a link to its OWN row, not to the host', () => {
    renderWithIntl(
      <RepositorySetField
        delivery={[row('motir-core', 'delivered', true), row('motir-ai', 'awaiting')]}
      />,
    );
    // The destination is the project's repository row, anchored by name (design
    // MOTIR-3038 panel 2d). A `proposed` row has no host repository at all, so
    // a link out to GitHub would be dead for exactly the state this redraw
    // exists to express — which is why NO row links to the host.
    expect(screen.getByRole('link', { name: 'motir-core' }).getAttribute('href')).toBe(
      '/settings/project/repositories#motir-core',
    );
    expect(screen.getByRole('link', { name: 'motir-ai' }).getAttribute('href')).toBe(
      '/settings/project/repositories#motir-ai',
    );
  });

  it('encodes a name that is not URL-safe rather than emitting it raw', () => {
    renderWithIntl(<RepositorySetField delivery={[row('my repo/api', 'awaiting', true)]} />);
    expect(screen.getByRole('link', { name: 'my repo/api' }).getAttribute('href')).toBe(
      '/settings/project/repositories#my%20repo%2Fapi',
    );
  });

  it('chips the two states that are properties of the ROW, and only those', () => {
    renderWithIntl(
      <RepositorySetField
        delivery={[
          row('motir-core', 'delivered', true),
          row('motir-ai', 'awaiting'),
          row('motir-gateway', 'unknown'),
          row('motir-docs', 'unestablished'),
          row('motir-infra', 'excluded'),
        ]}
      />,
    );
    // `Not created` and `Skipped` say something no pull-request state can say.
    // `getAllBy`: the chip's own <span> nests the text inside Pill's wrapper, so
    // the query matches both elements. What is asserted is that the word is
    // DRAWN, not how many nodes carry it.
    expect(
      screen.getAllByText(enMessages.issueViews.repositoryDelivery.unestablished).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(enMessages.issueViews.repositoryDelivery.excluded).length,
    ).toBeGreaterThan(0);
    // The other three carry a GLYPH, not a visible word — an ordinary repository
    // needs no chip announcing that it exists. Every state is still NAMED for a
    // screen reader, which is the pre-existing `sr-only` span, so the check is
    // on what is drawn, not on what is in the accessibility tree.
    for (const state of ['awaiting', 'delivered', 'unknown'] as const) {
      const word = enMessages.issueViews.repositoryDelivery[state];
      const nodes = screen.queryAllByText(word);
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.every((n) => n.className.includes('sr-only'))).toBe(true);
    }
    expect(screen.getAllByRole('link')).toHaveLength(5);
  });

  it('shows the ROLE on the detail page and drops it in the compact peek row', () => {
    const delivery = [
      { repo: 'motir-core', state: 'delivered' as const, primary: true, role: 'web' },
      { repo: 'motir-ai', state: 'awaiting' as const, primary: false, role: 'api' },
    ];
    const detail = renderWithIntl(<RepositorySetField delivery={delivery} />);
    expect(detail.getAllByText('web').length).toBeGreaterThan(0);
    expect(detail.getAllByText('api').length).toBeGreaterThan(0);
    cleanup();
    // The peek's rail is MEASURED (design MOTIR-3038 / MOTIR-2414), and the role
    // is the one thing there a reader can get by following the link — so
    // compression drops it rather than truncating the name it sits beside.
    const peek = renderWithIntl(<RepositorySetField delivery={delivery} compact />);
    expect(peek.queryAllByText('web')).toHaveLength(0);
    expect(peek.getByRole('link', { name: 'motir-core' })).toBeTruthy();
  });

  it('carries no role chip for a name that points at no row', () => {
    // The compatibility rung (ADR §5): a project with no repository set still
    // pins by NAME, and a name has no role. The chip is absent, not empty.
    renderWithIntl(<RepositorySetField delivery={[row('legacy-repo', 'awaiting', true)]} />);
    expect(screen.getByRole('link', { name: 'legacy-repo' })).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(1);
  });

  it('keeps the empty set reading as None, not as a repository named nothing', () => {
    renderWithIntl(<RepositorySetField delivery={[]} />);
    expect(screen.getByText(enMessages.issueViews.none)).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

function pr(repo: string, state: LinkedPullRequestDto['state']): LinkedPullRequestDto {
  return {
    id: `pr-${repo}-7`,
    title: `Wire ${repo}`,
    repo: `moooon-B-V/${repo}`,
    number: 7,
    state,
    ci: null,
    headSha: null,
    url: `https://github.com/moooon-B-V/${repo}/pull/7`,
    githubReview: null,
    preview: null,
    baseRef: 'main',
    conflicted: false,
  };
}

describe('DevelopmentSection · a repository with no pull request', () => {
  function devSection(delivery: RepoDelivery[], pullRequests: LinkedPullRequestDto[] = []) {
    return renderWithIntl(
      <DevelopmentSection
        pullRequests={pullRequests}
        itemIdentifier="MOTIR-2732"
        repoDelivery={delivery}
      />,
    );
  }

  it('shows ONE row for a repository whose pull request is open — never both', () => {
    // MOTIR-3036's defect, guarded here so rewriting this component cannot bring
    // it back: `awaiting` means "not merged", which is TRUE of an open pull
    // request, so a per-surface `state !== delivered` filter drew "No pull
    // request yet" directly under the pull request itself.
    const delivery = [row('motir-core', 'awaiting', true)];
    devSection(delivery, [pr('motir-core', 'open')]);
    expect(screen.getAllByText('Wire motir-core').length).toBe(1);
    expect(screen.queryAllByText(enMessages.github.development.noPullRequestYet)).toHaveLength(0);
    cleanup();
    // The OTHER surface, from the SAME value: one row per repository, drawn from
    // the delivery the server resolved once. Both surfaces are asserted here
    // together because the claim is about the shared derivation, not about
    // either component — two tests could pass while the two disagreed.
    const rail = renderWithIntl(<RepositorySetField delivery={delivery} />);
    expect(rail.getAllByRole('link', { name: 'motir-core' })).toHaveLength(1);
  });

  it('still grows a row for a repository the pull requests do not cover', () => {
    devSection(
      [row('motir-core', 'awaiting', true), row('motir-ai', 'awaiting')],
      [pr('motir-core', 'open')],
    );
    expect(screen.getAllByText(enMessages.github.development.noPullRequestYet).length).toBe(1);
    expect(screen.getAllByText('motir-ai').length).toBeGreaterThan(0);
  });

  it('says the repository does not exist yet, rather than that a PR is awaited', () => {
    devSection([row('motir-docs', 'unestablished', true)]);
    // The defect this replaces: `proposed` classified off names alone read as
    // `awaiting`, telling the reader to wait for a pull request against a
    // repository that does not exist.
    expect(
      screen.getAllByText(enMessages.github.development.repositoryNotCreated).length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByText(enMessages.github.development.noPullRequestYet)).toHaveLength(0);
    expect(
      screen.getAllByText(enMessages.github.development.repoState.unestablished).length,
    ).toBeGreaterThan(0);
  });

  it('says a skipped repository was skipped, and does not hold it open', () => {
    devSection([row('motir-infra', 'excluded', true)]);
    expect(
      screen.getAllByText(enMessages.github.development.repositorySkipped).length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByText(enMessages.github.development.noPullRequestYet)).toHaveLength(0);
    expect(
      screen.getAllByText(enMessages.github.development.repoState.excluded).length,
    ).toBeGreaterThan(0);
  });

  it('still draws the two pull-request states it always drew', () => {
    devSection([row('motir-core', 'awaiting', true), row('motir-ai', 'unknown')]);
    expect(
      screen.getAllByText(enMessages.github.development.noPullRequestYet).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(enMessages.github.development.mergedBranchUnknown).length,
    ).toBeGreaterThan(0);
  });

  it('gives each of the four rows its own words — no two states read alike', () => {
    devSection([
      row('a', 'awaiting', true),
      row('b', 'unknown'),
      row('c', 'unestablished'),
      row('d', 'excluded'),
    ]);
    const dev = enMessages.github.development;
    const titles = [
      dev.noPullRequestYet,
      dev.mergedBranchUnknown,
      dev.repositoryNotCreated,
      dev.repositorySkipped,
    ];
    expect(new Set(titles).size).toBe(4);
    for (const title of titles) expect(screen.getAllByText(title).length).toBeGreaterThan(0);
  });
});
