// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type {
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
  ApprovalRecordsPageDto,
} from '@/lib/dto/approvalGate';
import { canOfferNavDestination, PROJECT_NAV_ACCESS } from '@/lib/settings/projectNavAccess';

// THE APPROVAL RECORDS ROOM's LIST (Story MOTIR-5299 · MOTIR-5302), built to
// `design/approvals/design-notes.md`.
//
// What this file holds in place:
//
//   · the two sections, pending ABOVE decided, each with its heading and its total;
//   · the PERSON cell exists only when the read says `fullView` — the list never
//     re-checks a permission, so this is the only input that can add it;
//   · a decided row names WHICH version was decided, and its state pill;
//   · the three empty states, none of them permission-shaped;
//   · every row is the ONE approvals row, and opens the same overlay the tab does;
//   · the door: `/approvals` is `browse-only` in the one nav map.

const { push, shallowPush, nav } = vi.hoisted(() => ({
  push: vi.fn(),
  shallowPush: vi.fn(),
  // The room's own query, settable per test — the title door must keep it (MOTIR-6001).
  nav: { params: new URLSearchParams(''), pathname: '/approvals' },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push }),
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { ApprovalRecordsList } =
  await import('../../app/(authed)/approvals/_components/ApprovalRecordsList');
const { approvalRecordsHref } = await import('@/lib/approvals/recordsAddress');
const { ReaderRoutesProvider } = await import('@/lib/visitor/useReaderRoutes');

const SUBJECT = {
  kind: 'design_result' as const,
  designEvidenceId: 'ev-1',
  producedByKey: 'MOTIR-5300',
  commitSha: 'aaaaaaaa1111',
  assetCount: 2,
  noteExcerpt: 'The room.',
};

function awaitingRow(over: Partial<ApprovalQueueRowDto> = {}): ApprovalQueueRowDto {
  return {
    gateId: 'gate-a',
    kind: 'design_result',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Mara Member',
    waitingSince: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    workItem: {
      id: 'wi-a',
      key: 1,
      identifier: 'MOTIR-1',
      title: 'Pending thing',
      kind: 'subtask',
      type: 'design',
    },
    subject: SUBJECT,
    ...over,
  };
}

function decidedRow(over: Partial<ApprovalRecordDecidedRowDto> = {}): ApprovalRecordDecidedRowDto {
  return {
    gateId: 'gate-d',
    kind: 'design_result',
    state: 'changes_requested',
    decidedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    decidedByLabel: 'Otto Other <otto@ex.com>',
    decisionSource: null,
    subjectVersion: 'b33c4e45d0f9e8',
    waitingSince: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    workItem: {
      id: 'wi-d',
      key: 2,
      identifier: 'MOTIR-2',
      title: 'Decided thing',
      kind: 'subtask',
      type: 'design',
    },
    subject: SUBJECT,
    confirmedRecord: null,
    refusalVerdict: null,
    refusalReason: null,
    chosenOption: null,
    ...over,
  };
}

function page(over: Partial<ApprovalRecordsPageDto> = {}): ApprovalRecordsPageDto {
  return {
    fullView: false,
    scope: 'mine',
    views: ['mine'],
    sections: {
      awaiting: { items: [awaitingRow()], total: 1 },
      decided: { items: [decidedRow()], total: 1 },
    },
    total: 2,
    page: 1,
    pageSize: 25,
    ...over,
  };
}

beforeEach(() => {
  push.mockReset();
  shallowPush.mockReset();
});
afterEach(cleanup);

describe('the two sections', () => {
  it('draws Awaiting a decision ABOVE Decided, each with its section total', () => {
    renderWithIntl(<ApprovalRecordsList records={page()} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    const awaitingAt = headers.findIndex((h) => h?.startsWith('Awaiting a decision'));
    const decidedAt = headers.findIndex((h) => h?.startsWith('Decided'));
    expect(awaitingAt).toBeGreaterThanOrEqual(0);
    expect(decidedAt).toBeGreaterThan(awaitingAt);
    expect(headers[awaitingAt]).toBe('Awaiting a decision1');

    const awaiting = screen.getByTestId('approval-records-awaiting');
    const decided = screen.getByTestId('approval-records-decided');
    expect(within(awaiting).getByText('Pending thing')).toBeTruthy();
    expect(within(decided).getByText('Decided thing')).toBeTruthy();
  });

  it('a decided row names the version it was decided on, and its state — never "Approved" for changes', () => {
    renderWithIntl(<ApprovalRecordsList records={page()} />);
    const decided = screen.getByTestId('approval-records-decided');
    expect(within(decided).getByText('b33c4e45')).toBeTruthy();
    expect(within(decided).getByText('b33c4e45').closest('[title]')?.getAttribute('title')).toBe(
      'b33c4e45d0f9e8',
    );
    expect(within(decided).getByText('Changes requested')).toBeTruthy();
    expect(within(decided).queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('a decided row with no recorded version says so rather than rendering blank', () => {
    const records = page({
      sections: {
        awaiting: { items: [], total: 0 },
        decided: { items: [decidedRow({ subjectVersion: null, state: 'approved' })], total: 1 },
      },
      total: 1,
    });
    renderWithIntl(<ApprovalRecordsList records={records} />);
    expect(screen.getByText('no version')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('renders an empty section as a heading with 0 and its line — both headings stay', () => {
    const records = page({
      sections: {
        awaiting: { items: [], total: 0 },
        decided: { items: [decidedRow()], total: 1 },
      },
      total: 1,
    });
    renderWithIntl(<ApprovalRecordsList records={records} />);
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    expect(screen.getByText('Decided thing')).toBeTruthy();
  });

  it('a page starting inside the decided half draws only the Decided heading', () => {
    const records = page({
      sections: {
        awaiting: { items: [], total: 2 },
        decided: { items: [decidedRow()], total: 3 },
      },
      total: 5,
      page: 2,
      pageSize: 2,
    });
    renderWithIntl(<ApprovalRecordsList records={records} />);
    expect(screen.queryByTestId('approval-records-awaiting')).toBeNull();
    expect(screen.getByTestId('approval-records-decided')).toBeTruthy();
  });
});

describe('the PERSON cell follows the read’s `fullView`, and nothing else', () => {
  it('is absent for a reader whose read was not the full view', () => {
    renderWithIntl(<ApprovalRecordsList records={page({ fullView: false })} />);
    expect(screen.queryByText('Otto Other <otto@ex.com>')).toBeNull();
    expect(screen.queryByText('Decided by')).toBeNull();
  });

  it('names who was asked and who decided in the full view, with No one for nobody', () => {
    const records = page({
      fullView: true,
      sections: {
        awaiting: { items: [awaitingRow({ routedToName: null })], total: 1 },
        decided: { items: [decidedRow()], total: 1 },
      },
    });
    renderWithIntl(<ApprovalRecordsList records={records} />);
    expect(screen.getByText('Otto Other <otto@ex.com>')).toBeTruthy();
    expect(screen.getByText('No one')).toBeTruthy();
    expect(screen.getAllByText('Decided by').length).toBeGreaterThan(0);
  });

  it('a SYSTEM approval names the setting, never "No one" (MOTIR-702)', () => {
    // `design-result--system-approved.mock.html` panel 4: a gate the design-approval
    // switch approved has no decider, and the room says what did decide it.
    const records = page({
      fullView: true,
      sections: {
        awaiting: { items: [], total: 0 },
        decided: {
          items: [
            decidedRow({ state: 'approved', decidedByLabel: null, decisionSource: 'system' }),
          ],
          total: 1,
        },
      },
      total: 1,
    });
    renderWithIntl(<ApprovalRecordsList records={records} />);
    expect(screen.getByText('Approved automatically · design approval off')).toBeTruthy();
    expect(screen.queryByText('No one')).toBeNull();
  });

  it('uses the full-view grid only in the full view', () => {
    const { unmount } = renderWithIntl(<ApprovalRecordsList records={page({ fullView: true })} />);
    expect(screen.getByTestId('approval-row-gate-d').getAttribute('style')).toContain('200px');
    unmount();
    renderWithIntl(<ApprovalRecordsList records={page({ fullView: false })} />);
    expect(screen.getByTestId('approval-row-gate-d').getAttribute('style')).toContain('220px');
  });
});

describe('every row is the ONE approvals row, and its door is the overlay', () => {
  it('a pending row opens the overlay over this page, as the tab’s row does', () => {
    renderWithIntl(<ApprovalRecordsList records={page()} />);
    fireEvent.click(screen.getByRole('link', { name: /^Review MOTIR-1 / }), { button: 0 });
    expect(shallowPush).toHaveBeenCalledWith(
      '/approvals?approval=MOTIR-1&approvalKind=design_result',
    );
  });

  it('a decided row opens it too — nothing in the room decides', () => {
    renderWithIntl(<ApprovalRecordsList records={page()} />);
    fireEvent.click(screen.getByRole('link', { name: /^Review MOTIR-2 / }), { button: 0 });
    expect(shallowPush).toHaveBeenCalledWith(
      '/approvals?approval=MOTIR-2&approvalKind=design_result',
    );
  });

  it('a row’s TITLE opens the quick view, keeping the room’s own page — and not the overlay (MOTIR-6001)', () => {
    nav.params = new URLSearchParams('page=2');
    try {
      renderWithIntl(<ApprovalRecordsList records={page()} />);
      const title = screen.getByRole('link', { name: 'Pending thing' });
      expect(title.getAttribute('href')).toBe('/items/MOTIR-1');
      fireEvent.click(title, { button: 0 });
      expect(shallowPush).toHaveBeenCalledTimes(1);
      expect(shallowPush).toHaveBeenCalledWith('/approvals?page=2&peek=MOTIR-1');
      // A modified click is the browser's: the card in a new tab.
      expect(fireEvent.click(title, { button: 0, ctrlKey: true })).toBe(true);
      expect(shallowPush).toHaveBeenCalledTimes(1);
    } finally {
      nav.params = new URLSearchParams('');
    }
  });

  it('the pager writes only the page', () => {
    renderWithIntl(<ApprovalRecordsList records={page({ total: 60, page: 1, pageSize: 25 })} />);
    expect(approvalRecordsHref(1)).toBe('/approvals');
    expect(approvalRecordsHref(3)).toBe('/approvals?page=3');
    // MOTIR-6333 — a page turn keeps the served view when the reader has the switch.
    expect(approvalRecordsHref(3, 'mine')).toBe('/approvals?view=mine&page=3');
    expect(approvalRecordsHref(1, 'project')).toBe('/approvals?view=project');
  });

  // MOTIR-6891 — the room's list is shared with the Visitor tree
  // (`app/(visitor)/p/[identifier]/approvals`). A page turn there must stay on the
  // public project's Visitor path; the member `/approvals?page=N` renders the
  // READER's own project whenever the `motir_visitor` cookie that `proxy.ts`'s
  // rescue needs is gone. The Visitor layout provides the identifier, so the test
  // does too, with the pathname the Visitor tree serves.
  it('on a Visitor view the pager pushes the Visitor path, with no cookie to rescue it (MOTIR-6891)', () => {
    nav.pathname = '/p/X/approvals';
    try {
      renderWithIntl(
        <ReaderRoutesProvider identifier="X">
          <ApprovalRecordsList records={page({ total: 80, page: 2, pageSize: 25 })} />
        </ReaderRoutesProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: /next page/i }));
      expect(push).toHaveBeenLastCalledWith('/p/X/approvals?page=3');
      fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
      expect(push).toHaveBeenLastCalledWith('/p/X/approvals');
      fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
      expect(push).toHaveBeenLastCalledWith('/p/X/approvals?page=4');
    } finally {
      nav.pathname = '/approvals';
    }
  });

  it('on the member room the pager pushes the member address, unchanged (MOTIR-6891)', () => {
    renderWithIntl(<ApprovalRecordsList records={page({ total: 80, page: 2, pageSize: 25 })} />);
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(push).toHaveBeenLastCalledWith('/approvals?page=3');
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(push).toHaveBeenLastCalledWith('/approvals');
  });

  it('`git grep` finds ONE approvals row component in the repo', () => {
    const ROOT = process.cwd();
    const hits = execFileSync(
      'git',
      ['grep', '--untracked', '-l', 'role="row"', '--', 'app', 'components'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter((f) => f && readFileSync(join(ROOT, f), 'utf8').includes('approval-row-'));
    // `PlanningSessionRow` is ApprovalRow's own variant for the card-less `planning_session` kind
    // (MOTIR-7913): ApprovalRow dispatches to it, so it is not a second list's row.
    expect(hits).toEqual([
      'components/approvals/ApprovalRow.tsx',
      'components/approvals/PlanningSessionRow.tsx',
    ]);
  });
});

describe('the room decides nothing about access, and its door is browse-only', () => {
  const ROOT = process.cwd();

  it('the room’s files name no role and never re-check the key', () => {
    const out = (() => {
      try {
        return execFileSync(
          'git',
          [
            'grep',
            '--untracked',
            '-n',
            '-e',
            'isWorkspaceManager',
            '-e',
            'workspaceRole',
            '-e',
            'role ===',
            '-e',
            'approval:view_any',
            '--',
            'app/(authed)/approvals',
          ],
          { cwd: ROOT, encoding: 'utf8' },
        );
      } catch {
        return '';
      }
    })();
    expect(out).toBe('');
  });

  it('the page hands the read the page number and the REQUESTED view — nothing else reaches the scope', () => {
    // MOTIR-6333: the reader may now ASK for a view (`?view=`); the read still
    // decides what that request may show. No other parameter reaches it.
    // The page's body is `_view.tsx` since MOTIR-6643.
    const src = readFileSync(join(ROOT, 'app/(authed)/approvals/_view.tsx'), 'utf8');
    const readParams = [...src.matchAll(/params\[([^\]]+)\]/g)].map((m) => m[1]);
    expect(readParams.sort()).toEqual(["'page'", 'ROOM_VIEW_PARAM'].sort());
    expect(src).toMatch(
      /listRecords\(ctx, \{\s*page: parsePage\(params\['page'\]\),\s*view: requested,\s*\}\)/,
    );
  });

  it('`/approvals` is in the one nav map, opening on the view key OR a way to act (MOTIR-6332)', () => {
    const entry = PROJECT_NAV_ACCESS.find((e) => e.href === '/approvals');
    expect(entry?.evidence).toContain('approval:view_any');
    // Browse alone is a room empty by construction, so it is no longer offered.
    expect(canOfferNavDestination('/approvals', new Set(['project:browse']))).toBe(false);
    expect(
      canOfferNavDestination('/approvals', new Set(['project:browse', 'approval:view_any'])),
    ).toBe(true);
    expect(
      canOfferNavDestination('/approvals', new Set(['project:browse', 'work_item:edit'])),
    ).toBe(true);
  });
});

// THE APPROVAL-RECORD LINE (MOTIR-10338; `approvals-row--review-path.mock.html` panel A3).
describe('an approved merge names the review it stood on', () => {
  const merge = (review: ApprovalRecordDecidedRowDto['review']) =>
    decidedRow({
      kind: 'pull_request_approval',
      state: 'approved',
      subject: null,
      review,
    });

  it('draws the line under the row, spanning it, and lets the row grow', () => {
    renderWithIntl(
      <ApprovalRecordsList
        records={page({
          sections: {
            awaiting: { items: [], total: 0 },
            decided: {
              items: [merge({ kind: 'reviewed', commits: 'acme/web#88 @ 3f2a9c1' })],
              total: 1,
            },
          },
          total: 1,
        })}
      />,
    );
    const row = screen.getByTestId('approval-row-gate-d');
    const line = within(row).getByTestId('approval-review-line');
    expect(line.textContent).toBe(
      'Approved by Otto Other · reviewed by agent at acme/web#88 @ 3f2a9c1',
    );
    expect(line.parentElement?.className).toContain('md:col-span-full');
    // The fixed one-line height gives way, or the line would be clipped.
    expect(row.className).not.toContain('md:h-11');
  });

  it('draws no line, and keeps the one-line row, where the record carries none', () => {
    renderWithIntl(
      <ApprovalRecordsList
        records={page({
          sections: {
            awaiting: { items: [], total: 0 },
            decided: { items: [merge(null)], total: 1 },
          },
          total: 1,
        })}
      />,
    );
    const row = screen.getByTestId('approval-row-gate-d');
    expect(within(row).queryByTestId('approval-review-line')).toBeNull();
    expect(row.className).toContain('md:h-11');
  });
});
