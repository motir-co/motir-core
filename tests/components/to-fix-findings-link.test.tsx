// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// *FINDINGS AND CHECKLIST* ON A CARD THE REVIEW AGENT SENT BACK (MOTIR-11234), built to
// `design/workbench/design-notes.md` § 43: the one link the Workbench's To fix row and the
// item page's To fix banner draw — when it shows (§ 43.1, § 43.4), what it opens and how
// (§ 43.2), and that the item page switches on THIS link alone, never the other findings
// links on that page.

const nav = vi.hoisted(() => ({ pathname: '/workbench' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

import {
  ReviewFindingsInPlace,
  ReviewFindingsProvider,
  type InPlaceFindingsScope,
} from '@/components/approvals/ReviewFindingsInPlace';
import {
  SentBackFindingsLink,
  sentBackFindingsRefOf,
} from '@/components/approvals/SentBackFindingsLink';
import { ReviewLine } from '@/components/approvals/ReviewLine';
import { WorkbenchFixLine } from '@/app/(authed)/workbench/_components/WorkbenchFixLine';
import { ToFixBanner } from '@/app/(authed)/items/[key]/_components/ToFixBanner';
import type { ReviewFindingsDto, ReviewFindingsRefDto } from '@/lib/dto/agentReview';
import type { FixDetailDto, FixGroupPointerDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { OpenRepairRunDto } from '@/lib/dto/workItemRepair';
import type { ReviewLineDTO } from '@/lib/dto/reviewState';
import zhMessages from '@/messages/zh.json';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nav.pathname = '/workbench';
});

const RECORD: ReviewFindingsRefDto = { kind: 'record', id: 'rec-7' };
const GATE: ReviewFindingsRefDto = { kind: 'gate', id: 'gate-7' };

function detail(over: Partial<FixDetailDto> = {}): FixDetailDto {
  return {
    groupKey: null,
    repair: 'fix',
    check: null,
    queueReason: null,
    base: null,
    reviewerName: 'Review agent',
    notePreview: "Two of the card's acceptance criteria are not met yet.",
    gate: 'agent_review',
    reviewRef: RECORD,
    lastHeardAt: null,
    ranByName: null,
    branch: null,
    branches: null,
    pushed: null,
    continueKey: null,
    diedReason: null,
    affected: 1,
    total: 1,
    fixing: false,
    raisedHeads: null,
    ...over,
  };
}

const HOSTED_RUN: OpenRepairRunDto = {
  id: 'run_fix_1',
  label: 'motir fix · 2026-11-04 10:02 UTC',
  hosted: true,
  holder: { id: 'usr_mara', name: 'Mara S.' },
  byViewer: false,
  startedAt: new Date().toISOString(),
};

function findings(over: Partial<ReviewFindingsDto> = {}): ReviewFindingsDto {
  return {
    identifier: 'ACME-412',
    title: 'Export the invoice list as CSV',
    ref: RECORD,
    verdict: 'changes_requested',
    reviewer: { kind: 'hosted', model: null },
    at: '2026-11-05T13:34:00Z',
    subjectVersion: 'acme/web#88@3f2a9c1aaaa',
    commits: [{ repo: 'acme/web', number: 88, headSha: '3f2a9c1aaaa' }],
    findingsMd: "Two of the card's acceptance criteria are not met yet.",
    findingsRefs: {},
    checklist: [
      {
        key: 'ACME-412',
        criterion: 'Amounts keep two decimals.',
        status: 'not_met',
        evidence: 'de-DE writes 1.234,50.',
      },
    ],
    ...over,
  } as ReviewFindingsDto;
}

function stubFetch(answer: ReviewFindingsDto = findings()) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(answer), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Shell({
  children,
  scope = 'all',
  inPlace = true,
}: {
  children: ReactNode;
  scope?: InPlaceFindingsScope;
  inPlace?: boolean;
}) {
  return (
    <ReviewFindingsProvider>
      {inPlace ? <ReviewFindingsInPlace scope={scope} /> : null}
      {children}
    </ReviewFindingsProvider>
  );
}

const dialog = () => screen.queryByRole('dialog');
const findingsLink = (key = 'ACME-412') => screen.queryByTestId(`to-fix-findings-${key}`);

function row(
  reason: WorkItemFixReasonDto,
  over: Partial<FixDetailDto> = {},
  props: { held?: boolean; repairRun?: OpenRepairRunDto | null; carried?: boolean } = {},
) {
  return (
    <WorkbenchFixLine
      itemKey="ACME-412"
      title="Export the invoice list as CSV"
      reason={reason}
      detail={detail(over)}
      held={props.held ?? false}
      repairRun={props.repairRun ?? null}
      carried={props.carried ? { kind: 'prs', count: 2 } : null}
    />
  );
}

function banner(
  reason: WorkItemFixReasonDto,
  over: Partial<FixDetailDto> = {},
  props: { repairRun?: OpenRepairRunDto | null; fixGroup?: FixGroupPointerDto | null } = {},
) {
  return (
    <ToFixBanner
      identifier="ACME-412"
      title="Export the invoice list as CSV"
      fixReason={reason}
      fixDetail={detail(over)}
      statusCategory="in_progress"
      repairRun={props.repairRun ?? null}
      fixGroup={props.fixGroup ?? null}
    />
  );
}

describe('sentBackFindingsRefOf — only the review agent’s send-back with a stored ref (§ 43.1, § 43.4)', () => {
  it('answers the stored ref for changes_requested on agent_review', () => {
    expect(sentBackFindingsRefOf('changes_requested', detail())).toEqual(RECORD);
    expect(sentBackFindingsRefOf('changes_requested', detail({ reviewRef: GATE }))).toEqual(GATE);
  });

  it('is null for every other case', () => {
    expect(sentBackFindingsRefOf(null, detail())).toBeNull();
    expect(sentBackFindingsRefOf('changes_requested', null)).toBeNull();
    expect(sentBackFindingsRefOf('ci_failed', detail())).toBeNull();
    expect(
      sentBackFindingsRefOf('changes_requested', detail({ gate: 'pull_request_approval' })),
    ).toBeNull();
    expect(
      sentBackFindingsRefOf('changes_requested', detail({ gate: 'acceptance_result' })),
    ).toBeNull();
    expect(sentBackFindingsRefOf('changes_requested', detail({ reviewRef: null }))).toBeNull();
  });
});

describe('the Workbench To fix row (§ 43.1)', () => {
  it('draws the link after the sentence, at the review’s address on the card', () => {
    render(<Shell>{row('changes_requested')}</Shell>);
    const link = findingsLink()!;
    expect(link.textContent).toBe('Findings and checklist');
    expect(link.getAttribute('href')).toBe('/items/ACME-412?activity=all#agent-verdict-rec-7');
    expect(link.className).toContain('text-(--el-link)');
    expect(link.className).toContain('whitespace-nowrap');
    // Outside the truncating sentence, so it never truncates.
    expect(link.closest('.truncate')).toBeNull();
  });

  it('a gate ref with no record falls back to the Development section, as the review line does', () => {
    render(<Shell>{row('changes_requested', { reviewRef: GATE })}</Shell>);
    expect(findingsLink()!.getAttribute('href')).toBe('/items/ACME-412#development');
  });

  it.each([
    ['Fixing', {}, { repair: 'fix' as const, fixing: true }],
    ['a running hosted repair', { repairRun: HOSTED_RUN }, {}],
    ['a held row', { held: true }, {}],
    ['a row carrying others', { carried: true }, {}],
  ])('stays on %s', (_name, props, over) => {
    render(<Shell>{row('changes_requested', over, props)}</Shell>);
    expect(findingsLink()).not.toBeNull();
  });

  it.each([
    ['a person’s Request changes', 'changes_requested', { gate: 'pull_request_approval' }],
    ['an acceptance Re-run', 'changes_requested', { gate: 'acceptance_result' }],
    ['a row stored before the ref existed', 'changes_requested', { reviewRef: null }],
    ['another reason', 'ci_failed', { check: 'typecheck' }],
  ] as const)('draws nothing for %s', (_name, reason, over) => {
    render(<Shell>{row(reason, over as Partial<FixDetailDto>)}</Shell>);
    expect(findingsLink()).toBeNull();
    expect(screen.queryByRole('link', { name: 'Findings and checklist' })).toBeNull();
  });

  it('a plain click opens the view for exactly that review; a modified or middle click keeps the link', async () => {
    const fetchMock = stubFetch();
    render(<Shell>{row('changes_requested')}</Shell>);
    const link = findingsLink()!;
    expect(link.getAttribute('aria-haspopup')).toBe('dialog');

    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { button: 1 });
    expect(dialog()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    link.focus();
    fireEvent.click(link);
    expect(dialog()).not.toBeNull();
    expect(screen.getByText('Export the invoice list as CSV · ACME-412')).toBeTruthy();
    await screen.findByRole('heading', { name: 'Checklist' });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('kind=record&id=rec-7');
    // A send-back is this review itself, never marked as an earlier one.
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('with no in-place view mounted it is the plain card link', () => {
    const fetchMock = stubFetch();
    render(<Shell inPlace={false}>{row('changes_requested')}</Shell>);
    const link = findingsLink()!;
    expect(link.getAttribute('aria-haspopup')).toBeNull();
    fireEvent.click(link);
    expect(dialog()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads 发现和检查清单 in zh', () => {
    render(<Shell>{row('changes_requested')}</Shell>, { locale: 'zh', messages: zhMessages });
    expect(findingsLink()!.textContent).toBe('发现和检查清单');
  });
});

describe('the item page To fix banner (§ 43.1, § 43.3)', () => {
  function linkRowOf(link: HTMLElement) {
    return link.parentElement!;
  }

  it('leads the link row, before the Development link, in the banner’s own link form', () => {
    nav.pathname = '/items/ACME-412';
    render(<Shell scope="toFix">{banner('changes_requested')}</Shell>);
    const link = findingsLink()!;
    expect(link.className).toContain('text-(--el-text-strong)');
    expect(link.className).not.toContain('text-(--el-link)');
    const links = within(linkRowOf(link)).getAllByRole('link');
    expect(links[0]).toBe(link);
    expect(links).toHaveLength(2);
    expect(linkRowOf(link).className).toContain('flex-wrap');
  });

  it.each([
    ['Fixing', { fixing: true }, {}],
    ['a running hosted repair', {}, { repairRun: HOSTED_RUN }],
    [
      'a carried card',
      {},
      {
        fixGroup: {
          kind: 'prs',
          headKey: 'ACME-400',
          isHead: false,
          carriedKeys: ['ACME-412'],
        } as FixGroupPointerDto,
      },
    ],
  ])('stays on %s', (_name, over, props) => {
    nav.pathname = '/items/ACME-412';
    render(<Shell scope="toFix">{banner('changes_requested', over, props)}</Shell>);
    expect(findingsLink()).not.toBeNull();
  });

  it.each([
    ['a person’s Request changes', { gate: 'pull_request_approval' as const }],
    ['an acceptance Re-run', { gate: 'acceptance_result' as const }],
    ['a row stored before the ref existed', { reviewRef: null }],
  ])('draws nothing for %s — and keeps the Development link alone', (_name, over) => {
    nav.pathname = '/items/ACME-412';
    render(<Shell scope="toFix">{banner('changes_requested', over)}</Shell>);
    expect(findingsLink()).toBeNull();
    expect(screen.getByTestId('to-fix-banner').querySelectorAll('a').length).toBeGreaterThan(0);
  });

  it('in the Fixing state the Development link keeps its press beside the findings link', () => {
    nav.pathname = '/items/ACME-412';
    const section = document.createElement('section');
    section.id = 'development';
    section.tabIndex = -1;
    const scroll = vi.fn();
    section.scrollIntoView = scroll;
    document.body.appendChild(section);
    render(<Shell scope="toFix">{banner('changes_requested', { fixing: true })}</Shell>);
    const dev = screen.getByRole('link', { name: /See its pull requests/ });
    expect(dev.parentElement).toBe(findingsLink()!.parentElement);
    fireEvent.click(dev);
    expect(scroll).toHaveBeenCalled();
    expect(dialog()).toBeNull();
    section.remove();
  });

  it('the item page’s toFix scope opens this link in place, and leaves the review line’s links card links', async () => {
    nav.pathname = '/items/ACME-412';
    const fetchMock = stubFetch();
    const line: ReviewLineDTO = {
      value: 'reviewed_by_agent',
      actor: null,
      reason: null,
      reviewer: { kind: 'hosted', model: null },
      at: '2026-11-05T13:34:00Z',
      githubApprovals: [],
      lastReviewedVersion: null,
      lastReviewedRef: null,
      command: null,
    };
    render(
      <Shell scope="toFix">
        {banner('changes_requested')}
        <ReviewLine line={line} identifier="ACME-412" recordRef={{ kind: 'record', id: 'r-1' }} />
      </Shell>,
    );

    const lineLink = screen
      .getAllByRole('link', { name: 'Findings and checklist' })
      .find((a) => a !== findingsLink())!;
    expect(lineLink.getAttribute('aria-haspopup')).toBeNull();
    fireEvent.click(lineLink);
    expect(dialog()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const link = findingsLink()!;
    expect(link.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(link);
    expect(dialog()).not.toBeNull();
    await screen.findByRole('heading', { name: 'Checklist' });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('kind=record&id=rec-7');
  });

  it('the view closes when the page it opened on is left', async () => {
    nav.pathname = '/items/ACME-412';
    stubFetch();
    const { rerender } = render(<Shell scope="toFix">{banner('changes_requested')}</Shell>);
    fireEvent.click(findingsLink()!);
    expect(dialog()).not.toBeNull();
    nav.pathname = '/items/ACME-413';
    rerender(<Shell scope="toFix">{banner('changes_requested')}</Shell>);
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('SentBackFindingsLink alone, with no title, opens with the key as the subtitle', async () => {
    stubFetch();
    render(
      <Shell>
        <SentBackFindingsLink identifier="ACME-412" reviewRef={GATE} variant="banner" />
      </Shell>,
    );
    fireEvent.click(findingsLink()!);
    expect(dialog()).not.toBeNull();
  });
});
