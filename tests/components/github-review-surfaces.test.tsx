// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { LinkedPullRequestDto } from '@/lib/dto/github';

// THE SURFACES SAY IT HAPPENED ON GITHUB (Story MOTIR-4910 · MOTIR-5599; design
// `design/github/design-notes.md` § 23, Panels G1–G3).
//
// ⚠️ THE CHIP SAYS THE STATE AND NOTHING ELSE (Yue, design review 2026-09-17). It names
// neither the host — the row is already a GitHub pull request, and the pill beside it says
// *Checks passing*, not *Checks passing on GitHub* — nor a reviewer, because a pull request
// can carry SEVERAL reviewers and one login would be a claim the row cannot make. These
// tests assert that absence as deliberately as they assert the words.

afterEach(cleanup);

function pr(githubReview: LinkedPullRequestDto['githubReview']): LinkedPullRequestDto {
  return {
    id: 'pr-131',
    title: 'Rate-limit the public API per key',
    repo: 'moooon/motir-core',
    number: 131,
    state: 'open',
    ci: 'passing',
    headSha: null,
    url: 'https://github.com/moooon/motir-core/pull/131',
    githubReview,
    preview: null,
    baseRef: 'main',
    conflicted: false,
  };
}

const renderRow = (review: LinkedPullRequestDto['githubReview']) =>
  render(<DevelopmentSectionBody pullRequests={[pr(review)]} itemIdentifier="MOTIR-11" />);

describe('the review chip, one case per githubReview value (MOTIR-5599)', () => {
  it('renders Approved, and REPLACES the CI pill rather than joining it', () => {
    renderRow({ state: 'approved', atCurrentHead: true });

    expect(screen.getByText('Approved')).toBeTruthy();
    // The gate is raised only on an all-green set, so on a reviewed row *Checks passing*
    // has nothing left to say — and drawn as a third pill it costs the row its title.
    expect(screen.queryByText('Checks passing')).toBeNull();
    // Neither the host nor a reviewer is named.
    expect(screen.queryByText(/on GitHub/i)).toBeNull();
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('renders Changes requested', () => {
    renderRow({ state: 'changes_requested', atCurrentHead: true });

    expect(screen.getByText('Changes requested')).toBeTruthy();
    expect(screen.queryByText('Checks passing')).toBeNull();
    expect(screen.queryByText(/on GitHub/i)).toBeNull();
  });

  it('renders an approval at an EARLIER commit, said in words rather than dropped', () => {
    renderRow({ state: 'approved', atCurrentHead: false });

    // It counts for nothing — but a reader who can see an approval exists and cannot see
    // that it is stale would conclude Motir had lost it (design § 23, Panel G2).
    expect(screen.getByText('Approved an earlier commit')).toBeTruthy();
  });

  it('renders NOTHING for a null review, and the row keeps its CI pill', () => {
    renderRow(null);

    // Absence of a countable review is not a state, exactly as `ci: null` draws no pill.
    expect(screen.queryByText('Approved')).toBeNull();
    expect(screen.queryByText('Changes requested')).toBeNull();
    expect(screen.getByText('Checks passing')).toBeTruthy();
  });

  it('renders nothing for a STALE changes-requested — a reported design gap, not an invention', () => {
    renderRow({ state: 'changes_requested', atCurrentHead: false });

    // § 23 draws an earlier-commit chip for an APPROVAL only, and its copy says "Approved
    // an earlier commit", which would be false here. It counts for nothing either way, so
    // the row falls back to its CI pill until the design answers it.
    expect(screen.queryByText('Approved an earlier commit')).toBeNull();
    expect(screen.queryByText('Changes requested')).toBeNull();
    expect(screen.getByText('Checks passing')).toBeTruthy();
  });

  it('leaves the row READABLE — title, repo meta and link-out all survive a chip', () => {
    renderRow({ state: 'approved', atCurrentHead: true });

    expect(screen.getByText('Rate-limit the public API per key')).toBeTruthy();
    expect(screen.getByText(/moooon\/motir-core/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /github/i })).toBeTruthy();
  });
});
