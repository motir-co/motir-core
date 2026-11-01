// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import { AWAITING_MERGE_GATE } from '../helpers/howToTestFixtures';

// THE DECISION PORT OVER A PAGE (Story MOTIR-5761 · MOTIR-7436;
// `design/github/design-notes.md` § The decision port over a PAGE,
// `decision-port--page.mock.html` deltas 1–3). The Development block is mounted whole with
// no pull request; the document is a published page VERSION.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
  usePathname: () => '/items/ACME-12',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const dec = en.approvalGate.decision;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
const plain = (text: string) => ['<b>', '</b>'].reduce((out, tag) => out.split(tag).join(''), text);

const AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  id: 'gate-decision-page',
  kind: 'decision_approval',
  subjectId: 'wi-acme-12',
  subjectVersion: 'page:page-1@version-3',
};
const APPROVED: ApprovalGateDTO = {
  ...AWAITING,
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-19T15:02:00.000Z',
  outcomeRef: 'approved',
};

const PAGE: Extract<DecisionDocumentViewDTO, { outcome: 'page' }> = {
  outcome: 'page',
  pageId: 'page-1',
  versionId: 'version-3',
  versionNumber: 3,
  title: 'How a page stores its body',
  markdown: '# How a page stores its body\n\nStore the body as a Yjs document.',
  workItemRefs: {},
  pageUrl: '/pages/page-1',
  versionUrl: '/pages/page-1?version=3',
  compareUrl: '/pages/page-1?history=open&version=3',
  authorName: 'Mara S.',
  savedAt: '2026-09-18T10:00:00.000Z',
  frozen: false,
  changedSince: false,
};

function renderPort(gate: ApprovalGateDTO = AWAITING, document: DecisionDocumentViewDTO = PAGE) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[]}
      itemIdentifier="ACME-12"
      mergeGate={{
        gate,
        canDecide: true,
        routedToLabel: 'Mara S.',
        members: [],
        stamp: 'v1.stamp',
      }}
      gateActions={{ decide: vi.fn(), approveAndMerge: vi.fn(), retryMember: vi.fn() } as never}
      decision={{ document, gate }}
    />,
  );
}

describe('a published page version, awaiting (delta 1)', () => {
  it('names the page and the version, links to that version, and renders its text', () => {
    renderPort();
    const slot = screen.getByTestId('decision-document');
    const meta = within(slot).getByTestId('decision-page-meta');
    expect(meta.textContent).toContain(PAGE.title);
    expect(meta.textContent).toContain('Version 3 · Mara S.');
    expect(within(meta).getByRole('link', { name: dec.page.open }).getAttribute('href')).toBe(
      PAGE.versionUrl,
    );
    expect(within(slot).getByRole('heading', { name: PAGE.title })).toBeTruthy();
    // Not frozen yet, and nothing has changed since.
    expect(within(slot).queryByText(dec.page.frozen)).toBeNull();
    expect(within(slot).queryByTestId('decision-page-changed')).toBeNull();
  });

  it('says there is no pull request, and what approving does', () => {
    renderPort();
    expect(document.body.textContent).toContain(fill(dec.headMeta.pageNoRun, { number: 3 }));
    expect(document.body.textContent).toContain(
      plain(fill(dec.consequencePage, { number: 3, key: 'ACME-12' })),
    );
  });

  it('draws no pull-request group and no "No linked pull request" prompt', () => {
    renderPort();
    expect(
      screen.queryByRole('group', { name: en.github.development.pullRequestsGroup }),
    ).toBeNull();
    expect(screen.queryByText(en.github.development.emptyTitle)).toBeNull();
  });
});

describe('band 3 over a page (delta 1)', () => {
  it('the verb is Approve — never Approve and merge — and its confirm step names the freeze', () => {
    renderPort();
    expect(
      screen.queryByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.approve }));
    expect(screen.getByText(dec.confirm.records)).toBeTruthy();
    expect(screen.getByText(fill(dec.confirm.freezesPage, { number: 3 }))).toBeTruthy();
    expect(screen.getByText(fill(dec.confirm.movesDone, { key: 'ACME-12' }))).toBeTruthy();
  });
});

describe('the page moved on after the version was published (delta 2)', () => {
  it('says so, and links to the compare view', () => {
    renderPort(AWAITING, { ...PAGE, changedSince: true });
    const notice = screen.getByTestId('decision-page-changed');
    expect(notice.textContent).toContain(plain(fill(dec.page.changedSince, { number: 3 })));
    expect(
      within(notice).getByRole('link', { name: dec.page.compareWithCurrent }).getAttribute('href'),
    ).toBe(PAGE.compareUrl);
  });
});

describe('approved (delta 3)', () => {
  it('shows the version frozen and the card done, with no verb', () => {
    renderPort(APPROVED, { ...PAGE, frozen: true, changedSince: true });
    const slot = screen.getByTestId('decision-document');
    expect(within(slot).getByText(dec.page.frozen)).toBeTruthy();
    expect(screen.getByTestId('decision-page-changed').textContent).toContain(
      plain(fill(dec.page.changedSinceApproved, { number: 3 })),
    );
    expect(screen.getByText(fill(dec.page.approvedVersion, { number: 3 }))).toBeTruthy();
    expect(document.body.textContent).toContain(
      plain(fill(dec.page.approvedTail, { number: 3, key: 'ACME-12' })),
    );
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.requestChanges })).toBeNull();
  });
});
