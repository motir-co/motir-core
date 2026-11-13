// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// THE REVIEW PATH ON TO APPROVE AND IN THE GATE FRAME (Story MOTIR-10327 · MOTIR-10342;
// `design/github/design-notes.md` § 32.4–32.8, mocks A1–A2 and G1–G7): the review line's
// four values with the GitHub approvals beside them, the review-to-run row, the Dismiss the
// review control and its dialog states, the author note, and the read-model slices that feed
// them. Each is asserted in en and, where the copy is the design's, in zh.

const toast = vi.fn();
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

import { ReviewLine } from '@/components/approvals/ReviewLine';
import { ReaderRoutesProvider } from '@/lib/visitor/useReaderRoutes';
import { ReviewToRunRow } from '@/components/approvals/ReviewToRunRow';
import { AuthorNote } from '@/components/approvals/AuthorNote';
import { ApprovalRow } from '@/components/approvals/ApprovalRow';
import type { ApprovalQueueRowDto } from '@/lib/dto/approvalGate';
import {
  DismissReviewControl,
  dismissReviewRequest,
  type DismissOutcome,
} from '@/components/approvals/DismissReview';
import {
  toApprovalRowReviewDto,
  toGateReviewPathDto,
  type ReviewLineDTO,
  type ReviewStateDTO,
  type ReviewToRunRowDTO,
} from '@/lib/dto/reviewState';
import zhMessages from '@/messages/zh.json';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
});
beforeEach(() => toast.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ANA = { id: 'u2', name: 'Ana Ruiz' };
const NOW = new Date('2026-11-05T12:00:00Z');

function lineOf(over: Partial<ReviewLineDTO>): ReviewLineDTO {
  return {
    value: 'not_reviewed',
    actor: null,
    reason: null,
    reviewer: null,
    at: null,
    githubApprovals: [],
    lastReviewedVersion: null,
    lastReviewedRef: null,
    command: null,
    ...over,
  };
}

function lineEl() {
  return document.querySelector('[data-review-line]') as HTMLElement;
}

describe('ReviewLine — the four values', () => {
  it('Reviewed by agent: the hosted agent, when, and Findings and checklist', () => {
    render(
      <ReviewLine
        line={lineOf({
          value: 'reviewed_by_agent',
          reviewer: { kind: 'hosted', model: null },
          at: '2026-11-05T11:00:00Z',
        })}
        identifier="ACME-412"
        recordRef={{ kind: 'record', id: 'rec-1' }}
      />,
      { now: NOW },
    );
    const el = lineEl();
    expect(el.getAttribute('data-review-line')).toBe('reviewed_by_agent');
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-label')).toBe('Agent review');
    expect(el.textContent).toContain('Reviewed by agent');
    expect(el.textContent).toContain('Motir agent');
    expect(el.textContent).toContain('1 hour ago');
    expect(el.className).toContain('text-xs');
    const link = screen.getByRole('link', { name: 'Findings and checklist' });
    expect(link.getAttribute('href')).toBe('/items/ACME-412?activity=all#agent-verdict-rec-1');
  });

  it('Reviewed by agent: a person’s own agent names them and the harness; no ref draws no link', () => {
    render(
      <ReviewLine
        line={lineOf({
          value: 'reviewed_by_agent',
          reviewer: { kind: 'own', person: ANA, harness: 'Claude Code', model: 'm' },
          at: null,
        })}
        identifier="ACME-412"
        recordRef={null}
        size="frame"
      />,
    );
    expect(lineEl().textContent).toContain("Ana Ruiz's agent · Claude Code");
    expect(lineEl().className).toContain('text-[12.5px]');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('Reviewed by agent with no reviewer falls back to the hosted words; an unnamed person is the assignee', () => {
    render(
      <ReviewLine
        line={lineOf({ value: 'reviewed_by_agent', reviewer: null })}
        identifier="ACME-1"
        recordRef={null}
      />,
    );
    expect(lineEl().textContent).toContain('Motir agent');
    cleanup();
    render(
      <ReviewLine
        line={lineOf({
          value: 'reviewed_by_agent',
          reviewer: { kind: 'own', person: null, harness: 'Codex', model: 'm' },
        })}
        identifier="ACME-1"
        recordRef={null}
      />,
    );
    expect(lineEl().textContent).toContain('· Codex');
  });

  it('Review skipped and Review dismissed carry the person and their reason', () => {
    render(
      <ReviewLine
        line={lineOf({ value: 'review_skipped', actor: ANA, reason: 'Docs only' })}
        identifier="ACME-1"
        recordRef={null}
      />,
    );
    expect(lineEl().textContent).toContain('Ana Ruiz');
    expect(lineEl().textContent).toContain('Docs only');
    cleanup();
    render(
      <ReviewLine
        line={lineOf({ value: 'review_dismissed', actor: ANA, reason: 'Out of scope' })}
        identifier="ACME-1"
        recordRef={null}
      />,
    );
    expect(lineEl().getAttribute('data-review-line')).toBe('review_dismissed');
    expect(lineEl().textContent).toContain('Out of scope');
  });

  it('Not reviewed: the earlier-commit link and the command chip, and the GitHub logins after the divider', () => {
    render(
      <ReviewLine
        line={lineOf({
          value: 'not_reviewed',
          lastReviewedVersion: 'v1',
          lastReviewedRef: { kind: 'record', id: 'old' },
          command: 'motir review ACME-412',
          githubApprovals: [
            { login: 'dana', repo: 'r', number: 1 },
            { login: 'dana', repo: 'r', number: 2 },
            { login: 'li', repo: 'r', number: 2 },
          ],
        })}
        identifier="ACME-412"
        recordRef={null}
      />,
    );
    expect(lineEl().textContent).toContain('Not reviewed by an agent');
    expect(
      screen.getByRole('link', { name: 'Last reviewed at an earlier commit' }).getAttribute('href'),
    ).toBe('/items/ACME-412?activity=all#agent-verdict-old');
    expect(screen.getByTestId('review-command-copy-ACME-412')).toBeTruthy();
    const github = document.querySelector('[data-review-github]') as HTMLElement;
    expect(github.textContent).toContain('Approved on GitHub');
    expect(github.textContent).toContain('@dana, @li');
  });

  it('on the Visitor tree both links keep the reader’s own route, on the All tab (MOTIR-10458)', () => {
    render(
      <ReaderRoutesProvider identifier="acme">
        <ReviewLine
          line={lineOf({
            value: 'reviewed_by_agent',
            reviewer: { kind: 'hosted', model: null },
            at: null,
          })}
          identifier="ACME-412"
          recordRef={{ kind: 'record', id: 'rec-1' }}
        />
        <ReviewLine
          line={lineOf({
            value: 'not_reviewed',
            lastReviewedVersion: 'v1',
            lastReviewedRef: { kind: 'record', id: 'old' },
          })}
          identifier="ACME-412"
          recordRef={null}
        />
      </ReaderRoutesProvider>,
    );
    expect(screen.getByRole('link', { name: 'Findings and checklist' }).getAttribute('href')).toBe(
      '/p/acme/items/ACME-412?activity=all#agent-verdict-rec-1',
    );
    expect(
      screen.getByRole('link', { name: 'Last reviewed at an earlier commit' }).getAttribute('href'),
    ).toBe('/p/acme/items/ACME-412?activity=all#agent-verdict-old');
  });

  it('Not reviewed with no earlier pass and no command draws neither', () => {
    render(
      <ReviewLine
        line={lineOf({ value: 'not_reviewed', lastReviewedVersion: 'v1', lastReviewedRef: null })}
        identifier="ACME-1"
        recordRef={null}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('review-command-copy-ACME-1')).toBeNull();
    expect(document.querySelector('[data-review-github]')).toBeNull();
  });

  it('renders the design’s zh copy', () => {
    render(
      <ReviewLine line={lineOf({ value: 'not_reviewed' })} identifier="ACME-1" recordRef={null} />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(lineEl().getAttribute('aria-label')).toBe('智能体审查');
    expect(lineEl().textContent).toContain('未经智能体审查');
  });
});

const TO_RUN: ReviewToRunRowDTO = {
  kind: 'review_to_run',
  gateId: 'g-9',
  workItemId: 'w-9',
  identifier: 'ACME-9',
  title: 'Export button',
  subjectVersion: 'v2',
  raisedAt: '2026-11-05T11:00:00Z',
  command: 'motir review ACME-9',
};

describe('ReviewToRunRow', () => {
  it('is a review to run, not an approval: sentence, key, command, tag and second line', () => {
    render(<ReviewToRunRow row={TO_RUN} gridTemplate="1fr auto auto auto" />, { now: NOW });
    const row = screen.getByTestId('review-to-run-row-g-9');
    expect(row.hasAttribute('data-review-to-run')).toBe(true);
    expect(row.textContent).toContain('Review Export button with your agent');
    expect(row.textContent).toContain('ACME-9');
    expect(row.textContent).toContain('Review to run');
    expect(row.textContent).toContain('Not an approval yet');
    expect(screen.getByTestId('review-command-copy-ACME-9')).toBeTruthy();
    const door = screen.getByRole('link', {
      name: 'Open ACME-9: Review Export button with your agent',
    });
    expect(door.getAttribute('href')).toBe('/items/ACME-9');
  });

  it('renders in zh', () => {
    render(<ReviewToRunRow row={TO_RUN} gridTemplate="1fr" />, {
      locale: 'zh',
      messages: zhMessages,
    });
    const row = screen.getByTestId('review-to-run-row-g-9');
    expect(row.textContent).toContain('用你的智能体审查Export button');
    expect(row.textContent).toContain('待运行审查');
  });
});

describe('AuthorNote', () => {
  it('is a note, never a warning', () => {
    render(<AuthorNote />);
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('GitHub will not let you approve');
    cleanup();
    render(<AuthorNote />, { locale: 'zh', messages: zhMessages });
    expect(screen.getByRole('note').textContent).toContain('GitHub 不允许你批准自己的拉取请求');
  });
});

describe('DismissReviewControl and its dialog', () => {
  function open(request: (...a: never[]) => Promise<DismissOutcome>, onDismissed = vi.fn()) {
    render(
      <DismissReviewControl
        identifier="ACME-412"
        subjectVersion="v3"
        onDismissed={onDismissed}
        request={request as typeof dismissReviewRequest}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the review' }));
    return onDismissed;
  }
  const confirm = () =>
    screen
      .getAllByRole('button', { name: 'Dismiss the review' })
      .find((b) => b.getAttribute('type') === 'submit') as HTMLButtonElement;
  const reason = () => screen.getByRole('textbox') as HTMLTextAreaElement;

  it('shows the To fix note beside the button', () => {
    render(
      <DismissReviewControl identifier="ACME-412" subjectVersion="v3" onDismissed={vi.fn()} />,
    );
    expect(screen.getByTestId('dismiss-review').textContent).toContain(
      'An agent review you asked for sent this back',
    );
  });

  it('empty: the confirm is disabled until a reason is typed; whitespace does not count', () => {
    open(vi.fn());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(confirm().disabled).toBe(true);
    fireEvent.change(reason(), { target: { value: '   ' } });
    expect(confirm().disabled).toBe(true);
    fireEvent.change(reason(), { target: { value: 'Out of scope' } });
    expect(confirm().disabled).toBe(false);
  });

  it('submitting then success: sends the trimmed reason at the version, closes, hides the control and re-reads', async () => {
    let resolve!: (o: DismissOutcome) => void;
    const request = vi.fn(() => new Promise<DismissOutcome>((r) => (resolve = r)));
    const onDismissed = open(request);
    fireEvent.change(reason(), { target: { value: '  Out of scope ' } });
    fireEvent.submit(reason().closest('form')!);
    expect(request).toHaveBeenCalledWith('ACME-412', {
      subjectVersion: 'v3',
      reason: 'Out of scope',
    });
    await waitFor(() => expect(reason().disabled).toBe(true));
    expect(screen.getByText('Dismissing…')).toBeTruthy();
    await act(async () => resolve({ ok: true }));
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('dismiss-review')).toBeNull();
  });

  it('error: an alert, the reason kept, no re-read offered', async () => {
    const onDismissed = open(vi.fn(async () => ({ ok: false, refusal: 'error' }) as const));
    fireEvent.change(reason(), { target: { value: 'Out of scope' } });
    await act(async () => {
      fireEvent.submit(reason().closest('form')!);
    });
    expect(screen.getByRole('alert').textContent).toContain('The review could not be dismissed');
    expect(reason().value).toBe('Out of scope');
    expect(screen.queryByRole('button', { name: 'Show the current version' })).toBeNull();
    expect(onDismissed).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', 'New commits arrived'],
    ['already', 'already dismissed'],
    ['notStanding', 'no longer stands'],
  ] as const)(
    '%s: the alert offers Show the current version, which re-reads',
    async (refusal, words) => {
      const onDismissed = open(vi.fn(async () => ({ ok: false, refusal }) as const));
      fireEvent.change(reason(), { target: { value: 'x' } });
      await act(async () => {
        fireEvent.submit(reason().closest('form')!);
      });
      expect(screen.getByRole('alert').textContent).toContain(words);
      fireEvent.click(screen.getByRole('button', { name: 'Show the current version' }));
      expect(onDismissed).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('dismiss-review')).toBeTruthy();
    },
  );

  it('Cancel closes the dialog without a request', () => {
    const request = vi.fn();
    open(request);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('Escape closes the dialog; an empty submit sends nothing', () => {
    const request = vi.fn();
    open(request);
    fireEvent.submit(reason().closest('form')!);
    expect(request).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the dialog in zh', () => {
    render(
      <DismissReviewControl identifier="ACME-412" subjectVersion="v3" onDismissed={vi.fn()} />,
      { locale: 'zh', messages: zhMessages },
    );
    fireEvent.click(screen.getByRole('button', { name: '驳回审查' }));
    expect(screen.getByRole('dialog').textContent).toContain('驳回智能体的审查？');
  });
});

describe('dismissReviewRequest — the session door', () => {
  function stubFetch(impl: () => Promise<Response>) {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const answer = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('POSTs the body to the key’s route and answers ok on 200', async () => {
    const f = stubFetch(() => answer(200, { dismissed: true }));
    await expect(
      dismissReviewRequest('ACME-412', { subjectVersion: 'v3', reason: 'r' }),
    ).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledWith('/api/work-items/ACME-412/review-dismissal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectVersion: 'v3', reason: 'r' }),
    });
  });

  it.each([
    ['REVIEW_DISMISSAL_STALE', 'stale'],
    ['REVIEW_SENDBACK_ALREADY_DISMISSED', 'already'],
    ['NO_STANDING_REVIEW_SENDBACK', 'notStanding'],
    ['PERMISSION_DENIED', 'error'],
  ])('maps %s to %s', async (code, refusal) => {
    stubFetch(() => answer(409, { code }));
    await expect(
      dismissReviewRequest('ACME-1', { subjectVersion: 'v', reason: 'r' }),
    ).resolves.toEqual({ ok: false, refusal });
  });

  it('a body with no code, an unparseable body and a network failure are errors', async () => {
    stubFetch(() => answer(500, {}));
    await expect(
      dismissReviewRequest('ACME-1', { subjectVersion: 'v', reason: 'r' }),
    ).resolves.toEqual({ ok: false, refusal: 'error' });
    stubFetch(() => Promise.resolve(new Response('nope', { status: 500 })));
    await expect(
      dismissReviewRequest('ACME-1', { subjectVersion: 'v', reason: 'r' }),
    ).resolves.toEqual({ ok: false, refusal: 'error' });
    stubFetch(() => Promise.reject(new Error('offline')));
    await expect(
      dismissReviewRequest('ACME-1', { subjectVersion: 'v', reason: 'r' }),
    ).resolves.toEqual({ ok: false, refusal: 'error' });
  });
});

function stateOf(over: Partial<ReviewStateDTO>): ReviewStateDTO {
  return {
    workItemId: 'w1',
    identifier: 'ACME-1',
    currentVersion: 'v3',
    marker: null,
    reviewed: null,
    reviewLine: null,
    recordRef: null,
    sentBack: false,
    sentBackRecord: null,
    reviewToRun: null,
    authorOfEveryPr: false,
    routedTo: null,
    viewerIsRouted: false,
    ...over,
  };
}

describe('the read-model slices', () => {
  it('toGateReviewPathDto carries the frame’s fields', () => {
    const sentBackRecord = { recordId: 'r1', findingsMd: 'fix it', at: '2026-11-05T10:00:00Z' };
    const line = lineOf({ value: 'not_reviewed' });
    expect(
      toGateReviewPathDto(
        stateOf({ reviewLine: line, viewerIsRouted: true, authorOfEveryPr: true, sentBackRecord }),
      ),
    ).toEqual({
      identifier: 'ACME-1',
      currentVersion: 'v3',
      line,
      recordRef: null,
      viewerIsRouted: true,
      authorOfEveryPr: true,
      sentBackRecord,
    });
  });

  it('toApprovalRowReviewDto: null with no line; the badge only when reviewed, never a marker', () => {
    expect(toApprovalRowReviewDto(stateOf({}))).toBeNull();
    const line = lineOf({ value: 'not_reviewed' });
    expect(
      toApprovalRowReviewDto(stateOf({ reviewLine: line, marker: { kind: 'agent_reviewing' } })),
    ).toEqual({ line, recordRef: null, badge: null });
    const reviewed = {
      reviewer: { kind: 'hosted' as const, model: null },
      at: '2026-11-05T10:00:00Z',
      commits: [],
    };
    const row = toApprovalRowReviewDto(
      stateOf({
        reviewLine: line,
        reviewed,
        recordRef: { kind: 'record', id: 'r' },
        marker: { kind: 'agent_reviewing' },
      }),
    );
    expect(row?.badge).toMatchObject({ reviewed, marker: null, identifier: 'ACME-1' });
  });
});

describe('ApprovalRow — an approve-and-merge row wears its review', () => {
  const mergeRow = (over: Partial<ApprovalQueueRowDto> = {}): ApprovalQueueRowDto =>
    ({
      gateId: 'gate-m',
      kind: 'pull_request_approval',
      state: 'awaiting',
      canDecide: true,
      routedToName: 'Yue',
      waitingSince: new Date(Date.now() - 3_600_000).toISOString(),
      workItem: {
        id: 'wi-1',
        key: 61,
        identifier: 'ACME-61',
        title: 'Export button',
        kind: 'task',
        type: null,
      },
      subject: {
        kind: 'pull_request_approval',
        members: [{ repo: 'moooon/motir-core', number: 412, headSha: 'a', state: 'open' }],
      },
      ...over,
    }) as ApprovalQueueRowDto;

  it('draws the review line as its second row and the Reviewed badge after the key', () => {
    render(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: mergeRow({
            review: {
              line: lineOf({
                value: 'reviewed_by_agent',
                reviewer: { kind: 'hosted', model: null },
              }),
              recordRef: { kind: 'record', id: 'r1' },
              badge: {
                identifier: 'ACME-61',
                marker: null,
                reviewed: {
                  reviewer: { kind: 'hosted', model: null },
                  at: '2026-11-05T11:00:00Z',
                  commits: [],
                },
                recordRef: { kind: 'record', id: 'r1' },
              },
            },
          }),
        }}
      />,
    );
    expect(lineEl().getAttribute('data-review-line')).toBe('reviewed_by_agent');
    expect(document.body.textContent).toContain('Reviewed');
  });

  it('a row with no review draws no line', () => {
    render(<ApprovalRow record={{ section: 'awaiting', row: mergeRow() }} />);
    expect(document.querySelector('[data-review-line]')).toBeNull();
  });
});

// A STORY RUN'S ACCEPTANCE ROW (Bug MOTIR-10533) — its press merges the story's delivery set,
// so it wears the same review line and badge the approve-and-merge row does; the server hands
// it a `review` only when the story has pull requests. Other kinds still draw none.
describe('ApprovalRow — a story run’s acceptance row wears its review too (MOTIR-10533)', () => {
  const acceptanceRow = (over: Partial<ApprovalQueueRowDto> = {}): ApprovalQueueRowDto =>
    ({
      gateId: 'gate-a',
      kind: 'acceptance_result',
      state: 'awaiting',
      canDecide: true,
      routedToName: 'Yue',
      waitingSince: new Date(Date.now() - 3_600_000).toISOString(),
      workItem: {
        id: 'wi-2',
        key: 62,
        identifier: 'ACME-62',
        title: 'Accept the export story',
        kind: 'story',
        type: null,
      },
      subject: {
        kind: 'acceptance_result',
        acceptanceEvidenceId: 'ae',
        producedByKey: null,
        commitSha: '000042cd',
        chapterCount: 3,
      },
      ...over,
    }) as ApprovalQueueRowDto;

  it.each([
    lineOf({ value: 'not_reviewed', command: 'motir review ACME-62' }),
    lineOf({ value: 'reviewed_by_agent', reviewer: { kind: 'hosted', model: null } }),
    lineOf({ value: 'review_skipped', actor: ANA, reason: 'Docs only.' }),
    lineOf({ value: 'review_dismissed', actor: ANA, reason: 'Out of scope.' }),
  ])('draws the $value line as its second row', (line) => {
    render(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: acceptanceRow({ review: { line, recordRef: null, badge: null } }),
        }}
      />,
    );
    expect(lineEl().getAttribute('data-review-line')).toBe(line.value);
  });

  it('offers the copyable command on a not-reviewed acceptance', () => {
    render(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: acceptanceRow({
            review: {
              line: lineOf({ value: 'not_reviewed', command: 'motir review ACME-62' }),
              recordRef: null,
              badge: null,
            },
          }),
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Copy motir review ACME-62' })).toBeTruthy();
  });

  it('an acceptance with no delivery set has no review, and draws no line', () => {
    render(<ApprovalRow record={{ section: 'awaiting', row: acceptanceRow() }} />);
    expect(document.querySelector('[data-review-line]')).toBeNull();
  });

  it('a design row draws no line even if handed one', () => {
    render(
      <ApprovalRow
        record={{
          section: 'awaiting',
          row: acceptanceRow({
            kind: 'design_result',
            subject: null,
            review: {
              line: lineOf({ value: 'not_reviewed', command: 'motir review ACME-62' }),
              recordRef: null,
              badge: null,
            },
          }),
        }}
      />,
    );
    expect(document.querySelector('[data-review-line]')).toBeNull();
  });
});
