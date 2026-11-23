// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import { readerAccessView } from '@/components/github/readerAccessLine';
import { CODE_ACCESS_HREF } from '@/components/github/AccessLine';
import type {
  LinkedPullRequestDto,
  LinkedPullRequestPreviewDto,
  LinkedPullRequestReaderAccessDto,
} from '@/lib/dto/github';
import { AWAITING_MERGE_GATE } from '../helpers/howToTestFixtures';

// THE PULL-REQUEST ROW PER READER (Story MOTIR-4881 · MOTIR-12116; design
// `design/github/design-notes.md` § 35, `github--pr-row-reader-access.mock.html` Panels
// A1–A9). A pure render of the row's `readerAccess`: whether the code link-out is drawn,
// and the access line under the preview line — one case per row of § 35.4's table, then
// the same row through each host's props.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(cleanup);

const INVITATION = 'https://github.com/motir-projects/shop-web/invitations';
const OPEN_ON_GITHUB = en.github.development.openOnGithub;
const A = en.github.development.access;

function preview(state: string): LinkedPullRequestPreviewDto {
  const host = 'pr-41--shop-web.preview.motir.site';
  return { state, host, failureReason: null, url: `https://${host}` };
}

function access(
  o: Partial<LinkedPullRequestReaderAccessDto> = {},
): LinkedPullRequestReaderAccessDto {
  return { state: 'accepted', reason: null, invitationUrl: null, ...o };
}

function pr(over: Partial<LinkedPullRequestDto> = {}): LinkedPullRequestDto {
  return {
    id: 'pr-41',
    title: 'Export the invoice list as CSV',
    repo: 'motir-projects/shop-web',
    number: 41,
    state: 'open',
    ci: 'passing',
    headSha: null,
    url: 'https://github.com/motir-projects/shop-web/pull/41',
    githubReview: null,
    preview: preview('ready'),
    readerAccess: null,
    baseRef: 'main',
    conflicted: false,
    ...over,
  };
}

/** The catalogue sentence with its rich tags removed — what the line reads as text. */
const plain = (s: string) => s.replace(/<\/?(link|tone)>/g, '');

function renderRow(row: LinkedPullRequestDto) {
  return render(<DevelopmentSectionBody pullRequests={[row]} itemIdentifier="ACME-412" />);
}

const linkOut = () => screen.queryByRole('link', { name: OPEN_ON_GITHUB });
const line = () => screen.queryByTestId('pr-row-access');

describe('readerAccessView — § 35.4, total over the reader states', () => {
  it('a null access fact is the row as today', () => {
    expect(readerAccessView(pr())).toEqual({ showLinkOut: true, line: null });
  });

  it('accepted with no reason is the row as today', () => {
    expect(readerAccessView(pr({ readerAccess: access() }))).toEqual({
      showLinkOut: true,
      line: null,
    });
  });

  it('invited keeps the link-out, and links the code-access page when no address is stored', () => {
    expect(
      readerAccessView(
        pr({ readerAccess: access({ state: 'invited', invitationUrl: INVITATION }) }),
      ),
    ).toEqual({ showLinkOut: true, line: 'invited' });
    expect(readerAccessView(pr({ readerAccess: access({ state: 'invited' }) }))).toEqual({
      showLinkOut: true,
      line: 'invitedNoLink',
    });
  });

  it('not_invited keeps the link-out', () => {
    expect(readerAccessView(pr({ readerAccess: access({ state: 'not_invited' }) }))).toEqual({
      showLinkOut: true,
      line: 'notInvited',
    });
  });

  it.each(['accepted', 'invited', 'not_invited'] as const)(
    'role_cannot_edit withholds the link-out on a %s record — the reason wins',
    (state) => {
      expect(
        readerAccessView(
          pr({
            readerAccess: access({ state, reason: 'role_cannot_edit', invitationUrl: INVITATION }),
          }),
        ),
      ).toEqual({ showLinkOut: false, line: 'roleCannotEdit' });
    },
  );

  it('no_github_identity names the preview only when it is ready', () => {
    const noGh = access({ state: 'not_invited', reason: 'no_github_identity' });
    expect(readerAccessView(pr({ readerAccess: noGh }))).toEqual({
      showLinkOut: false,
      line: 'noGithubPreview',
    });
    for (const p of [
      null,
      preview('building'),
      preview('starting'),
      preview('failed'),
      preview('closed'),
      preview('paused'),
    ]) {
      expect(readerAccessView(pr({ readerAccess: noGh, preview: p }))).toEqual({
        showLinkOut: false,
        line: 'noGithubNoPreview',
      });
    }
  });
});

describe('the row draws the table', () => {
  it('no_github_identity with a ready preview: no link-out, the line names the preview above', () => {
    renderRow(pr({ readerAccess: access({ state: 'not_invited', reason: 'no_github_identity' }) }));
    expect(linkOut()).toBeNull();
    expect(line()!.dataset.accessVariant).toBe('noGithubPreview');
    expect(line()!.textContent).toBe(plain(A.noGithubPreview));
    // It names the preview line above and does not repeat its host link.
    expect(within(line()!).queryByRole('link')).toBeNull();
  });

  it.each([
    ['no preview', null],
    ['building', preview('building')],
    ['starting', preview('starting')],
    ['failed', preview('failed')],
    ['closed', preview('closed')],
  ])('no_github_identity with %s: no link-out, no preview is available', (_label, p) => {
    renderRow(
      pr({
        preview: p,
        readerAccess: access({ state: 'not_invited', reason: 'no_github_identity' }),
      }),
    );
    expect(linkOut()).toBeNull();
    expect(line()!.dataset.accessVariant).toBe('noGithubNoPreview');
    expect(line()!.textContent).toBe(plain(A.noGithubNoPreview));
  });

  it.each(['accepted', 'invited', 'not_invited'] as const)(
    'role_cannot_edit on a %s record: no link-out, the role line',
    (state) => {
      renderRow(pr({ readerAccess: access({ state, reason: 'role_cannot_edit' }) }));
      expect(linkOut()).toBeNull();
      expect(line()!.dataset.accessVariant).toBe('roleCannotEdit');
      expect(line()!.textContent).toBe(A.roleCannotEdit);
      expect(within(line()!).queryByRole('link')).toBeNull();
    },
  );

  it('invited: the link-out is drawn and the line links the stored invitation in a new tab', () => {
    renderRow(pr({ readerAccess: access({ state: 'invited', invitationUrl: INVITATION }) }));
    expect(linkOut()).not.toBeNull();
    expect(line()!.dataset.accessVariant).toBe('invited');
    expect(line()!.textContent).toBe(plain(A.invited));
    const link = within(line()!).getByRole('link', { name: 'Accept the invitation' });
    expect(link.getAttribute('href')).toBe(INVITATION);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('invited with no stored address: the line links the code-access page instead', () => {
    renderRow(pr({ readerAccess: access({ state: 'invited' }) }));
    expect(linkOut()).not.toBeNull();
    expect(line()!.dataset.accessVariant).toBe('invitedNoLink');
    const link = within(line()!).getByRole('link', { name: 'Go to Code access' });
    expect(link.getAttribute('href')).toBe(CODE_ACCESS_HREF);
  });

  it('not_invited: the link-out is drawn and the line links the code-access page', () => {
    renderRow(pr({ readerAccess: access({ state: 'not_invited' }) }));
    expect(linkOut()).not.toBeNull();
    expect(line()!.dataset.accessVariant).toBe('notInvited');
    expect(line()!.textContent).toBe(plain(A.notInvited));
    const link = within(line()!).getByRole('link', { name: 'Go to Code access' });
    expect(link.getAttribute('href')).toBe('/settings/project/code-access');
    expect(link.getAttribute('target')).toBeNull();
  });

  it.each([
    ['null', null],
    ['accepted', access()],
  ])('readerAccess %s: the row exactly as before', (_label, readerAccess) => {
    const before = renderRow(pr()).container.innerHTML;
    cleanup();
    const after = renderRow(pr({ readerAccess })).container.innerHTML;
    expect(after).toBe(before);
    expect(linkOut()).not.toBeNull();
    expect(line()).toBeNull();
  });

  it('a drawn link-out keeps the stored url — a GitLab merge request opens on GitLab', () => {
    const url = 'https://gitlab.com/acme/shop-web/-/merge_requests/41';
    renderRow(pr({ url, readerAccess: access({ state: 'invited', invitationUrl: INVITATION }) }));
    expect(linkOut()!.getAttribute('href')).toBe(url);
  });

  it('sits directly after the preview line, in the text column, outside the pill group', () => {
    renderRow(pr({ readerAccess: access({ state: 'not_invited' }) }));
    const previewLine = screen.getByTestId('pr-row-preview');
    expect(previewLine.nextElementSibling).toBe(line());
    expect(line()!.parentElement).toBe(previewLine.parentElement);
    expect(line()!.closest('[class*="order-last"]')).toBeNull();
  });

  it('carries no muted or faint ink — both fail AA on the row’s surface', () => {
    for (const reason of ['no_github_identity', 'role_cannot_edit'] as const) {
      renderRow(pr({ readerAccess: access({ reason }) }));
      expect(line()!.outerHTML).not.toContain('--el-text-muted');
      expect(line()!.outerHTML).not.toContain('--el-text-faint');
      cleanup();
    }
  });

  it('reads the zh catalogue', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[pr({ readerAccess: access({ reason: 'no_github_identity' }) })]}
        itemIdentifier="ACME-412"
      />,
      { locale: 'zh', messages: zh },
    );
    expect(line()!.textContent).toBe(plain(zh.github.development.access.noGithubPreview));
  });
});

describe('the same row on the three hosts', () => {
  const ROW = pr({ readerAccess: access({ state: 'not_invited', reason: 'no_github_identity' }) });
  const CONNECTED = pr({
    id: 'pr-88',
    repo: 'acme/shop-api',
    number: 88,
    url: 'https://github.com/acme/shop-api/pull/88',
    preview: null,
    readerAccess: null,
  });

  function snapshot() {
    const rows = screen.getAllByRole('listitem');
    const out = rows.map((row) => ({
      linkOut:
        within(row).queryByRole('link', { name: OPEN_ON_GITHUB })?.getAttribute('href') ?? null,
      access: within(row).queryByTestId('pr-row-access')?.textContent ?? null,
    }));
    cleanup();
    return out;
  }

  it('reads the same in the peek, on the item page and in the approval overlay', () => {
    // The quick-view peek: read-only, no row action.
    render(<DevelopmentSectionBody pullRequests={[ROW, CONNECTED]} itemIdentifier="ACME-412" />);
    const peek = snapshot();

    // The item page's Development card: manual linking and the remove control.
    render(
      <DevelopmentSectionBody
        pullRequests={[ROW, CONNECTED]}
        itemIdentifier="ACME-412"
        manualLinkable
        rowAction={(row) => <button type="button">Remove {row.number}</button>}
      />,
    );
    const page = snapshot();

    // The approval overlay's Development port: the merge gate frames the rows.
    render(
      <DevelopmentSectionBody
        pullRequests={[ROW, CONNECTED]}
        itemIdentifier="ACME-412"
        mergeGate={{
          gate: AWAITING_MERGE_GATE,
          canDecide: true,
          routedToLabel: 'Yue',
          stamp: 'v1',
        }}
        gateLayout="fill"
      />,
    );
    const overlay = snapshot();

    expect(peek).toEqual([
      { linkOut: null, access: plain(A.noGithubPreview) },
      { linkOut: CONNECTED.url, access: null },
    ]);
    expect(page).toEqual(peek);
    expect(overlay).toEqual(peek);
  });
});
