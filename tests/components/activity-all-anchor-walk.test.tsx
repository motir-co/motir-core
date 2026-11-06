// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type {
  ActivityAllEntryDto,
  ActivityAllPageDto,
  ActivityEntryPartDto,
} from '@/lib/dto/activity';

// A VERDICT LINK TO AN OLDER ACTIVITY ENTRY (MOTIR-10463). The link lands on
// `?activity=all#agent-verdict-<id>`; the All tab server-renders only its first page, so an
// older entry was never on the page and nothing opened. The tab now walks the next pages
// (bounded) until the entry arrives, which then lands itself with its findings open; a
// record the walk does not reach leaves the page as it was, with no error.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/items/PROD-7',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/items/[key]/commentActions', () => ({
  addCommentAction: vi.fn(),
  editCommentAction: vi.fn(),
  deleteCommentAction: vi.fn(),
}));
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: () => null,
}));
vi.mock('@/components/ui/MarkdownView', () => ({
  MarkdownView: ({ value, ...rest }: { value: string; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']}>{value}</div>
  ),
}));

const { ActivitySection } = await import('@/app/(authed)/items/[key]/_components/ActivitySection');
const { bumpActivity } = await import('@/lib/hooks/useActivityRevision');
const { resetCommentsSortForTests } = await import('@/lib/hooks/useCommentsSort');

let seq = 0;
function historyEntry(parts: ActivityEntryPartDto[]): ActivityAllEntryDto {
  seq += 1;
  return {
    type: 'history',
    entry: {
      id: `rev-${seq}`,
      workItemId: 'wi-1',
      changeKind: 'updated',
      changedAt: new Date(Date.now() - seq * 60_000).toISOString(),
      actor: { userId: 'u-bo', name: 'Bo Philips', image: null },
      parts,
    },
  };
}
const filler = () =>
  historyEntry([
    {
      kind: 'field',
      field: 'priority',
      from: { type: 'text', text: 'Low' },
      to: { type: 'text', text: `High ${seq + 1}` },
    },
  ]);
const verdict = (recordId: string) =>
  historyEntry([
    {
      kind: 'agentVerdict',
      recordId,
      verdict: 'changes_requested',
      outcome: 'decided',
      hosted: true,
      harness: '',
      model: '',
      subjectVersion: 'moooon/acme#88@3f2a9c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      findingsExcerpt: 'The export button still does nothing on Safari.',
      checklist: [],
      notified: null,
      checklist: [],
    },
  ]);

function page(
  entries: ActivityAllEntryDto[],
  nextCursor: string | null,
  totalChanges = 45,
): ActivityAllPageDto {
  return { entries, nextCursor, totalComments: 0, totalChanges, workItemRefs: {} };
}
function respond(body: ActivityAllPageDto): Response {
  return { ok: true, json: async () => body } as Response;
}

function renderAll(initialAll: ActivityAllPageDto) {
  return render(
    <ActivitySection
      workItemId="wi-1"
      tab="all"
      workflowStatuses={[]}
      comments={{
        canComment: false,
        canModerate: false,
        currentUserId: 'u-me',
        currentUserName: 'Me',
        mentionCandidates: [],
      }}
      initialComments={null}
      initialHistory={null}
      initialAll={initialAll}
    />,
  );
}

const firstPage = () => page([filler(), filler()], 'cursor-1');
const scrolled = vi.fn();
const originalScroll = Element.prototype.scrollIntoView;

describe('All tab — a verdict link to an entry past the first page (MOTIR-10463)', () => {
  beforeEach(() => {
    seq = 0;
    resetCommentsSortForTests();
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn());
    Element.prototype.scrollIntoView = scrolled;
  });
  afterEach(() => {
    cleanup();
    window.location.hash = '';
    Element.prototype.scrollIntoView = originalScroll;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('walks the next pages until the entry arrives, then shows it in view with its findings open', async () => {
    window.location.hash = '#agent-verdict-rec-old';
    const initial = firstPage();
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(page([filler()], 'cursor-2')))
      .mockResolvedValueOnce(respond(page([filler(), verdict('rec-old')], 'cursor-3')));

    renderAll(initial);

    const findings = await screen.findByTestId('agent-verdict-findings');
    expect(findings.textContent).toContain('The export button still does nothing on Safari.');
    expect(document.getElementById('agent-verdict-rec-old')).not.toBeNull();
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      '/api/work-items/wi-1/activity/all?order=desc&cursor=cursor-1',
      '/api/work-items/wi-1/activity/all?order=desc&cursor=cursor-2',
    ]);
    // Every page the walk read is drawn — the feed stays one unbroken run — and Show more
    // carries on from where the walk stopped.
    expect(screen.getAllByText(/High/)).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(vi.mocked(fetch).mock.calls[2]?.[0]).toBe(
      '/api/work-items/wi-1/activity/all?order=desc&cursor=cursor-3',
    );
  });

  it('does not fetch when the entry is already on the first page', async () => {
    window.location.hash = '#agent-verdict-rec-new';
    renderAll(page([verdict('rec-new'), filler()], 'cursor-1'));

    expect(await screen.findByTestId('agent-verdict-findings')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not walk for an address that names no verdict', async () => {
    window.location.hash = '#development';
    renderAll(firstPage());
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not walk when the first page is the whole trail', async () => {
    window.location.hash = '#agent-verdict-rec-gone';
    renderAll(page([filler()], null, 1));
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a record the walk never reaches leaves the page as it was, with no error', async () => {
    window.location.hash = '#agent-verdict-rec-gone';
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(page([filler()], 'cursor-2')))
      .mockResolvedValueOnce(respond(page([filler()], null)));

    renderAll(firstPage());

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getAllByText(/High/)).toHaveLength(2);
    expect(screen.queryByText(/Couldn.t load/)).toBeNull();
    expect(screen.queryByTestId('agent-verdict-findings')).toBeNull();
    // The first page's Show more still continues from its own cursor.
    expect(screen.getByRole('button', { name: /Show more/ })).toBeTruthy();
  });

  it('a failed read during the walk leaves the page as it was, with no error', async () => {
    window.location.hash = '#agent-verdict-rec-old';
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    renderAll(firstPage());

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.getAllByText(/High/)).toHaveLength(2);
    expect(screen.queryByText(/Couldn.t load/)).toBeNull();
  });

  it('a verdict link followed later on the same page walks too', async () => {
    renderAll(firstPage());
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();

    vi.mocked(fetch).mockResolvedValueOnce(respond(page([verdict('rec-old')], null)));
    await act(async () => {
      window.location.hash = '#agent-verdict-rec-old';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(await screen.findByTestId('agent-verdict-findings')).toBeTruthy();
  });

  it('a walk whose window moved on meanwhile appends nothing', async () => {
    window.location.hash = '#agent-verdict-rec-old';
    let release: (r: Response) => void = () => {};
    vi.mocked(fetch)
      .mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)))
      // the refresh a save triggers: a new first page with a different cursor
      .mockResolvedValueOnce(respond(page([filler()], 'cursor-fresh')));

    renderAll(firstPage());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      bumpActivity('wi-1');
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await act(async () => {
      release(respond(page([verdict('rec-old')], null)));
    });

    expect(screen.queryByTestId('agent-verdict-findings')).toBeNull();
    expect(screen.getAllByText(/High/)).toHaveLength(1);
  });
  it('does not walk when the first page failed to load', async () => {
    window.location.hash = '#agent-verdict-rec-old';
    render(
      <ActivitySection
        workItemId="wi-1"
        tab="all"
        workflowStatuses={[]}
        comments={{
          canComment: false,
          canModerate: false,
          currentUserId: 'u-me',
          currentUserName: 'Me',
          mentionCandidates: [],
        }}
        initialComments={null}
        initialHistory={null}
        initialAll={null}
      />,
    );
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a walk still in flight when the tab unmounts applies nothing', async () => {
    window.location.hash = '#agent-verdict-rec-old';
    let release: (r: Response) => void = () => {};
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));

    const { unmount } = renderAll(firstPage());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      release(respond(page([verdict('rec-old')], null)));
    });

    expect(screen.queryByTestId('agent-verdict-findings')).toBeNull();
  });
});
