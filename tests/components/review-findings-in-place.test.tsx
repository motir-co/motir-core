// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// *FINDINGS AND CHECKLIST* IN PLACE (MOTIR-10460), built to
// `design/workbench/approvals-row--findings-in-place.mock.html` F0–F12 and
// `design/workbench/design-notes.md` § 42: the doors (the review line's two links and the
// Reviewed badge's card), the provider's switch, every state of the view, the checklist part,
// and its use in the card page's Activity entry.

const nav = vi.hoisted(() => ({ pathname: '/workbench' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));

import {
  ReviewFindingsInPlace,
  ReviewFindingsProvider,
  useInPlaceFindings,
} from '@/components/approvals/ReviewFindingsInPlace';
import {
  ReviewFindingsDialog,
  readReviewFindings,
} from '@/components/approvals/ReviewFindingsDialog';
import { ReviewChecklist, evidenceParts } from '@/components/approvals/ReviewChecklist';
import { ReviewLine } from '@/components/approvals/ReviewLine';
import { ReviewedBadge } from '@/components/approvals/ReviewedBadge';
import { AgentVerdictActivityRow } from '@/app/(authed)/items/[key]/_components/AgentVerdictActivityRow';
import type { ReviewChecklistRowDto, ReviewFindingsDto } from '@/lib/dto/agentReview';
import type { ActivityAgentVerdictPartDto, ActivityEntryDto } from '@/lib/dto/activity';
import type { ReviewLineDTO } from '@/lib/dto/reviewState';
import zhMessages from '@/messages/zh.json';

/** The footer's Close — the panel's own X carries the same accessible name. */
function footerClose(): HTMLElement {
  const found = screen
    .getAllByRole('button', { name: 'Close' })
    .find((b) => b.textContent?.trim() === 'Close');
  if (!found) throw new Error('no footer Close button');
  return found;
}

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

const NOW = new Date('2026-11-05T15:34:00Z');
const ROWS: ReviewChecklistRowDto[] = [
  {
    key: 'ACME-412',
    criterion: 'Export downloads every invoice.',
    status: 'met',
    evidence: '`exportRoute.ts` streams it; `export.test.ts` covers it.',
  },
  { key: 'ACME-413', criterion: 'Dates are ISO 8601.', status: 'met', evidence: 'asserted.' },
  {
    key: 'ACME-413',
    criterion: 'Amounts keep two decimals.',
    status: 'not_met',
    evidence: 'de-DE writes 1.234,50.',
  },
  {
    key: 'ACME-414',
    criterion: '50,000 rows in ten seconds.',
    status: 'cannot_tell',
    evidence: null,
  },
];

function review(over: Partial<ReviewFindingsDto> = {}): ReviewFindingsDto {
  return {
    identifier: 'ACME-412',
    title: 'Export the invoice list as CSV',
    ref: { kind: 'record', id: 'rec-1' },
    verdict: 'pass',
    reviewer: {
      kind: 'own',
      name: 'Kenji Mori',
      harness: 'Claude Code',
      model: 'claude-sonnet-5-5',
    },
    at: '2026-11-05T13:34:00Z',
    subjectVersion: 'acme/web#88@3f2a9c1aaaa,acme/api#41@9b07de4bbbb',
    commits: [
      { repo: 'acme/web', number: 88, headSha: '3f2a9c1aaaa' },
      { repo: 'acme/api', number: 41, headSha: '9b07de4bbbb' },
    ],
    findingsMd: 'The export works end to end.',
    findingsRefs: {},
    checklist: ROWS,
    ...over,
  };
}

function stubFetch(...answers: Array<ReviewFindingsDto | number>) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    return typeof next === 'number'
      ? new Response('{}', { status: next })
      : new Response(JSON.stringify(next), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lineOf(over: Partial<ReviewLineDTO>): ReviewLineDTO {
  return {
    value: 'reviewed_by_agent',
    actor: null,
    reason: null,
    reviewer: { kind: 'hosted', model: null },
    at: '2026-11-05T13:34:00Z',
    githubApprovals: [],
    lastReviewedVersion: null,
    lastReviewedRef: null,
    command: null,
    ...over,
  };
}

function Workbench({ children, inPlace = true }: { children: ReactNode; inPlace?: boolean }) {
  return (
    <ReviewFindingsProvider>
      {inPlace ? <ReviewFindingsInPlace /> : null}
      {children}
    </ReviewFindingsProvider>
  );
}

const dialog = () => screen.queryByRole('dialog');

describe('ReviewChecklist — the stored rows (§ 42.2)', () => {
  it('counts, orders, and marks every status by words, glyph and fill', () => {
    render(<ReviewChecklist rows={ROWS} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Checklist' })).toBeTruthy();
    expect(document.body.textContent).toContain('4 criteria · 2 met · 1 not met · 1 can’t tell');
    const items = [...document.querySelectorAll('li[data-checklist-status]')];
    expect(items.map((li) => li.getAttribute('data-checklist-status'))).toEqual([
      'met',
      'met',
      'not_met',
      'cannot_tell',
    ]);
    // The rows span three cards, so each criterion carries its card's key.
    expect(items[0]!.textContent).toContain('ACME-412Export downloads every invoice.');
    expect(within(items[2] as HTMLElement).getByText('Not met')).toBeTruthy();
    expect(within(items[3] as HTMLElement).getByText('Can’t tell')).toBeTruthy();
    expect(items[3]!.textContent).toContain('No evidence given.');
    // Code spans in the evidence are inline chips.
    expect([...items[0]!.querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'exportRoute.ts',
      'export.test.ts',
    ]);
    expect(items[0]!.querySelector('p')!.className).toContain('text-sm');
  });

  it('leaves a zero count out, omits the key on a one-card checklist, and is compact in Activity', () => {
    render(
      <ReviewChecklist
        rows={[{ key: 'ACME-1', criterion: 'One.', status: 'not_met', evidence: null }]}
        compact
      />,
    );
    expect(document.body.textContent).toContain('1 criterion · 1 not met');
    expect(document.body.textContent).not.toContain('0 met');
    expect(document.body.textContent).not.toContain('ACME-1');
    expect(document.querySelector('li p')!.className).toContain('text-[13px]');
  });

  it('draws nothing for no rows', () => {
    const { container } = render(<ReviewChecklist rows={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('an unpaired backtick is text, as Markdown reads it', () => {
    const { container } = render(<p>{evidenceParts('a `b` c `d')}</p>);
    expect(container.querySelectorAll('code')).toHaveLength(1);
    expect(container.textContent).toBe('a b c `d');
  });

  it('renders in zh', () => {
    render(<ReviewChecklist rows={ROWS} />, { messages: zhMessages, locale: 'zh' });
    expect(document.body.textContent).toContain('检查清单');
    expect(document.body.textContent).toContain('未满足');
  });
});

describe('ReviewFindingsDialog — every state (§ 42.1, F1–F7)', () => {
  const target = {
    identifier: 'ACME-412',
    title: 'Export the invoice list as CSV',
    ref: { kind: 'record' as const, id: 'rec-1' },
    earlier: false,
  };

  it('loading, then the review: verdict, who, when, commits, checklist, whole findings', async () => {
    let resolve!: (r: ReviewFindingsDto) => void;
    const read = vi.fn(() => new Promise<ReviewFindingsDto>((r) => (resolve = r)));
    render(<ReviewFindingsDialog target={target} onClose={vi.fn()} read={read} />, { now: NOW });

    const region = screen.getByRole('region', { name: 'The review' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Loading the review…');
    expect(screen.getByText('Export the invoice list as CSV · ACME-412')).toBeTruthy();
    expect(read).toHaveBeenCalledWith('ACME-412', { kind: 'record', id: 'rec-1' });

    await act(async () => resolve(review()));
    expect(region.getAttribute('aria-busy')).toBeNull();
    expect(document.querySelector('[data-review-view]')!.getAttribute('data-review-view')).toBe(
      'ready',
    );
    const text = dialog()!.textContent!;
    expect(text).toContain('Passed');
    expect(text).toContain("Kenji Mori's own agent · Claude Code · claude-sonnet-5-5");
    expect(text).toContain('2 hours ago');
    expect(text).toContain('At these commits');
    expect(text).toContain('acme/web#88 @ 3f2a9c1');
    expect(text).toContain('acme/api#41 @ 9b07de4');
    expect(screen.getByRole('heading', { name: 'Checklist' })).toBeTruthy();
    expect(screen.getByTestId('review-findings-body').textContent).toContain(
      'The export works end to end.',
    );
    // Checklist first, then the findings.
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Checklist', 'Findings']);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the work item' }).getAttribute('href')).toBe(
      '/items/ACME-412',
    );
  });

  it('a hosted review whose checklist is a table in its findings: no rows section, the table renders', async () => {
    const read = vi.fn(async () =>
      review({
        reviewer: { kind: 'hosted', model: null },
        checklist: [],
        findingsMd: '| Criterion | Result |\n|---|---|\n| Export | Met |',
      }),
    );
    render(<ReviewFindingsDialog target={target} onClose={vi.fn()} read={read} />);
    await screen.findByText("Motir's hosted agent");
    expect(screen.queryByRole('heading', { name: 'Checklist' })).toBeNull();
    expect(screen.getByTestId('review-findings-body').querySelector('table')).not.toBeNull();
  });

  it('checklist rows with no findings say the review wrote none', async () => {
    const read = vi.fn(async () => review({ findingsMd: null }));
    render(<ReviewFindingsDialog target={target} onClose={vi.fn()} read={read} />);
    expect(await screen.findByText('The review wrote no findings.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Checklist' })).toBeTruthy();
  });

  it('an earlier review is marked three times, and a send-back reads Asked for changes', async () => {
    const read = vi.fn(async () =>
      review({
        verdict: 'changes_requested',
        reviewer: { kind: 'own', name: null, harness: '', model: '' },
        commits: [{ repo: 'acme/web', number: 88, headSha: '1c4e2aa' }],
      }),
    );
    render(
      <ReviewFindingsDialog target={{ ...target, earlier: true }} onClose={vi.fn()} read={read} />,
    );
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('An earlier review.');
    expect(note.className).toContain('bg-(--el-tint-yellow)');
    const text = dialog()!.textContent!;
    expect(text).toContain('Earlier commits');
    expect(text).toContain('Asked for changes');
    expect(text).toContain('acme/web#88 @ 1c4e2aa');
    // An own agent with no harness named, by someone who has left.
    expect(text).toContain("Former member's own agent");
  });

  it('could not load: one alert, Try again re-reads in place', async () => {
    const read = vi
      .fn<typeof readReviewFindings>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(review());
    render(<ReviewFindingsDialog target={target} onClose={vi.fn()} read={read} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The review could not be loaded. Nothing changed. Try again.');
    expect(alert.className).toContain('bg-(--el-danger-surface)');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('status').textContent).toBe('Loading the review…');
    expect(await screen.findByRole('heading', { name: 'Checklist' })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('Close, Open the work item and Escape all close it', async () => {
    const onClose = vi.fn();
    render(<ReviewFindingsDialog target={target} onClose={onClose} read={async () => review()} />);
    await screen.findByRole('heading', { name: 'Checklist' });
    fireEvent.click(footerClose());
    fireEvent.click(screen.getByRole('link', { name: 'Open the work item' }));
    fireEvent.keyDown(dialog()!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('with no title known before the read, the subtitle is the key; zh renders', async () => {
    let resolve!: (r: ReviewFindingsDto) => void;
    render(
      <ReviewFindingsDialog
        target={{ ...target, title: null }}
        onClose={vi.fn()}
        read={() => new Promise((r) => (resolve = r))}
      />,
      { messages: zhMessages, locale: 'zh' },
    );
    expect(screen.getByText('发现和检查清单')).toBeTruthy();
    expect(screen.getByText('ACME-412')).toBeTruthy();
    await act(async () => resolve(review()));
    expect(screen.getByText('Export the invoice list as CSV · ACME-412')).toBeTruthy();
  });
});

describe('readReviewFindings — the session door', () => {
  it('GETs the review by kind and id, and throws on a refusal', async () => {
    const fetchMock = stubFetch(review(), 404);
    await expect(
      readReviewFindings('ACME-412', { kind: 'gate', id: 'g 1' }),
    ).resolves.toMatchObject({
      identifier: 'ACME-412',
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/work-items/ACME-412/review-findings?kind=gate&id=g+1',
    );
    await expect(readReviewFindings('ACME-412', { kind: 'record', id: 'r' })).rejects.toThrow(
      'review findings 404',
    );
  });
});

describe('the doors open the review in place, only on the Workbench (§ 42.3, F0, F5, F8, F9)', () => {
  it('the review line’s Findings and checklist opens the view; closing it puts focus back', async () => {
    stubFetch(review());
    render(
      <Workbench>
        <ReviewLine
          line={lineOf({})}
          identifier="ACME-412"
          title="Export the invoice list as CSV"
          recordRef={{ kind: 'record', id: 'rec-1' }}
        />
      </Workbench>,
    );
    const link = screen.getByRole('link', { name: 'Findings and checklist' });
    expect(link.getAttribute('href')).toBe('/items/ACME-412?activity=all#agent-verdict-rec-1');
    expect(link.getAttribute('aria-haspopup')).toBe('dialog');
    link.focus();
    fireEvent.click(link);
    expect(dialog()).not.toBeNull();
    expect(screen.getByText('Export the invoice list as CSV · ACME-412')).toBeTruthy();
    await screen.findByRole('heading', { name: 'Checklist' });
    fireEvent.click(footerClose());
    expect(dialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  it('a modified or middle click keeps the card link', () => {
    const fetchMock = stubFetch(review());
    render(
      <Workbench>
        <ReviewLine
          line={lineOf({})}
          identifier="ACME-412"
          recordRef={{ kind: 'record', id: 'r' }}
        />
      </Workbench>,
    );
    const link = screen.getByRole('link', { name: 'Findings and checklist' });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { button: 1 });
    expect(dialog()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Last reviewed at an earlier commit opens the earlier review, marked as earlier', async () => {
    const fetchMock = stubFetch(review({ ref: { kind: 'gate', id: 'g-0' } }));
    render(
      <Workbench>
        <ReviewLine
          line={lineOf({
            value: 'not_reviewed',
            reviewer: null,
            at: null,
            lastReviewedVersion: 'acme/web#88@1c4e2aa',
            lastReviewedRef: { kind: 'gate', id: 'g-0' },
          })}
          identifier="ACME-412"
          recordRef={null}
        />
      </Workbench>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Last reviewed at an earlier commit' }));
    expect(await screen.findByRole('note')).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('kind=gate&id=g-0');
  });

  it('off the Workbench the links are the plain card links they were', () => {
    const fetchMock = stubFetch(review());
    render(
      <Workbench inPlace={false}>
        <ReviewLine
          line={lineOf({})}
          identifier="ACME-412"
          recordRef={{ kind: 'record', id: 'r' }}
        />
      </Workbench>,
    );
    const link = screen.getByRole('link', { name: 'Findings and checklist' });
    expect(link.getAttribute('aria-haspopup')).toBeNull();
    fireEvent.click(link);
    expect(dialog()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with no provider at all (the visitor shell) the hook answers null', () => {
    function Probe() {
      const handler = useInPlaceFindings();
      return <span data-testid="probe">{handler === null ? 'none' : 'handler'}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('none');
  });

  it('the Reviewed badge’s card link opens the view and focus returns to the badge', async () => {
    stubFetch(review());
    render(
      <Workbench>
        <ReviewedBadge
          review={{
            identifier: 'ACME-412',
            marker: null,
            reviewed: {
              reviewer: { kind: 'hosted', model: null },
              at: '2026-11-05T13:34:00Z',
              commits: [],
            },
            recordRef: { kind: 'record', id: 'rec-1' },
          }}
        />
      </Workbench>,
    );
    const badge = document.querySelector('[data-reviewed-badge]') as HTMLElement;
    fireEvent.mouseEnter(badge.parentElement!);
    const link = screen.getByRole('link', { name: 'Findings and checklist' });
    expect(link.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(link);
    expect(dialog()).not.toBeNull();
    // The card closes as the pointer leaves it; the link is gone by the time the view closes.
    fireEvent.mouseLeave(badge.parentElement!);
    await screen.findByRole('heading', { name: 'Checklist' });
    fireEvent.click(footerClose());
    await waitFor(() => expect(document.activeElement).toBe(badge));
  });

  it('a row that went away hands focus to the next row’s door', async () => {
    stubFetch(review());
    function Rows({ first }: { first: boolean }) {
      return (
        <Workbench>
          <div>
            {first ? (
              <div role="row">
                <ReviewLine
                  line={lineOf({})}
                  identifier="ACME-1"
                  recordRef={{ kind: 'record', id: 'r' }}
                />
              </div>
            ) : null}
            <div role="row">
              <Link href="/items/ACME-2" aria-haspopup="dialog">
                next door
              </Link>
            </div>
          </div>
        </Workbench>
      );
    }
    const { rerender } = render(<Rows first />);
    fireEvent.click(screen.getByRole('link', { name: 'Findings and checklist' }));
    await screen.findByRole('heading', { name: 'Checklist' });
    rerender(<Rows first={false} />);
    fireEvent.click(footerClose());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('link', { name: 'next door' })),
    );
  });

  it('a navigation away closes the view: it is drawn only on the page it opened on', async () => {
    stubFetch(review());
    const ui = (
      <Workbench>
        <ReviewLine
          line={lineOf({})}
          identifier="ACME-412"
          recordRef={{ kind: 'record', id: 'r' }}
        />
      </Workbench>
    );
    const { rerender } = render(ui);
    fireEvent.click(screen.getByRole('link', { name: 'Findings and checklist' }));
    expect(dialog()).not.toBeNull();
    nav.pathname = '/items/ACME-412';
    rerender(<Workbench>{ui}</Workbench>);
    expect(dialog()).toBeNull();
  });
});

describe('the card page’s Activity entry draws the stored rows (§ 42.5, F10)', () => {
  function part(over: Partial<ActivityAgentVerdictPartDto>): ActivityAgentVerdictPartDto {
    return {
      kind: 'agentVerdict',
      recordId: 'rec-1',
      verdict: 'pass',
      outcome: 'recorded',
      hosted: false,
      harness: 'Claude Code',
      model: 'claude-sonnet-5-5',
      subjectVersion: 'acme/web#88@3f2a9c1aaaa',
      findingsExcerpt: 'The export works.',
      notified: null,
      checklist: ROWS,
      ...over,
    };
  }
  function entryOf(p: ActivityAgentVerdictPartDto): ActivityEntryDto {
    return {
      id: 'rev-1',
      workItemId: 'wi-1',
      changeKind: 'agent_verdict',
      changedAt: '2026-11-05T13:34:00Z',
      actor: { userId: 'u-1', name: 'Kenji Mori', image: null },
      parts: [p],
    };
  }

  it('the toggle reads Findings and checklist and opens the findings, then the rows', () => {
    const p = part({});
    render(<AgentVerdictActivityRow entry={entryOf(p)} part={p} />);
    const toggle = screen.getByRole('button', { name: 'Findings and checklist' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.textContent).toContain('The export works.');
    expect(document.querySelectorAll('li[data-checklist-status]')).toHaveLength(4);
    expect(document.querySelector('li p')!.className).toContain('text-[13px]');
  });

  it('rows and no findings: the toggle still draws and opens to the rows alone', () => {
    const p = part({ findingsExcerpt: null });
    render(<AgentVerdictActivityRow entry={entryOf(p)} part={p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Findings and checklist' }));
    expect(screen.queryByTestId('agent-verdict-findings')).toBeNull();
    expect(document.querySelectorAll('li[data-checklist-status]')).toHaveLength(4);
  });

  it('a record with no rows is unchanged: Findings only', () => {
    const p = part({ checklist: [] });
    render(<AgentVerdictActivityRow entry={entryOf(p)} part={p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Findings' }));
    expect(document.querySelector('[data-review-checklist]')).toBeNull();
  });

  it('a late verdict still draws no toggle', () => {
    const p = part({ outcome: 'late' });
    render(<AgentVerdictActivityRow entry={entryOf(p)} part={p} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
