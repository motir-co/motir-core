// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { LinkedPullRequestDto } from '@/lib/dto/github';

// Story 7.10 · MOTIR-1596 — the display side of the explicit item→PR link on the
// shared Development body. It asserted the quiet "linked manually" provenance
// suffix until MOTIR-4894 removed it: the flag distinguished a declared link from
// one the MOTIR-892 resolver inferred, and MOTIR-3674 deleted the inferring half,
// so every row qualified and the label fired hardest on the ordinary case — a run
// linking its own pull request over `link_pull_request`. The first test is
// inverted rather than deleted, because "no row carries a provenance suffix" is
// the claim the removal makes and it needs somewhere to fail. The second is
// untouched: the detail host (`manualLinkable`) still names the in-panel
// "+ Link pull request" door that the peek does not expose (design Panel 5a).

afterEach(cleanup);

const webhookPr: LinkedPullRequestDto = {
  id: 'pr-webhook-11',
  title: 'Ingested by the webhook',
  repo: 'moooon/motir-core',
  number: 11,
  state: 'open',
  ci: null,
  headSha: null,
  url: 'https://github.com/moooon/motir-core/pull/11',
  githubReview: null,
  preview: null,
  baseRef: 'main',
  conflicted: false,
};
const pickerPr: LinkedPullRequestDto = {
  id: 'pr-picker-57',
  title: 'Linked from the picker',
  repo: 'moooon/motir-gateway',
  number: 57,
  state: 'merged',
  ci: null,
  headSha: null,
  url: 'https://github.com/moooon/motir-gateway/pull/57',
  githubReview: null,
  preview: null,
  baseRef: 'main',
  conflicted: false,
};

describe('DevelopmentSectionBody — the pr-meta line (MOTIR-1596 · MOTIR-4894)', () => {
  it('carries NO provenance suffix — every meta line is repo and number alone', () => {
    render(
      <DevelopmentSectionBody pullRequests={[webhookPr, pickerPr]} itemIdentifier="MOTIR-11" />,
    );
    // Asserted on the RENDERED TEXT rather than on the retired i18n key, so this
    // stays true however a future suffix is spelled: the claim is that the row
    // says what pull request it is and stops.
    expect(screen.queryByText('linked manually')).toBeNull();
    expect(document.body.textContent).not.toContain('linked manually');

    // …and the two rows are otherwise indistinguishable, which is the point: one
    // was ingested by the webhook and one picked by hand, and the surface no
    // longer claims to know which.
    const metas = screen
      .getAllByText(/#(11|57)/)
      .map((el) => el.textContent!.replace(/\s+/g, ' ').trim());
    expect(metas).toEqual(['moooon/motir-core · #11', 'moooon/motir-gateway · #57']);
  });

  it('the detail host caption names its explicit link affordance; the peek names its own doors', () => {
    const { rerender } = render(
      <DevelopmentSectionBody
        pullRequests={[webhookPr]}
        itemIdentifier="MOTIR-11"
        manualLinkable
      />,
    );
    expect(document.body.textContent).toContain('+ Link pull request here');
    expect(document.body.textContent).toContain('link_pull_request over the MCP');

    rerender(<DevelopmentSectionBody pullRequests={[webhookPr]} itemIdentifier="MOTIR-11" />);
    expect(document.body.textContent).not.toContain('+ Link pull request here');
    expect(document.body.textContent).toContain('motir auto session branch');
  });
});
