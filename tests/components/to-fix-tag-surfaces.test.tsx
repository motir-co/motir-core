// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// THE TO FIX TAG ON ITS THREE HOSTS (Story MOTIR-6589 · MOTIR-6610; design
// MOTIR-6608 panels 1, 3 and 4): the List / Tree row's STATUS cell (glyph, after
// the decision glyph), the board card's pill row (label, after the exclusive slot
// and before the CI badge, named by the card's aria-describedby) and the quick
// view's header (label, after the status pill). Each surface draws it from its
// own DTO's `fixReason`, and a done card draws it nowhere.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/(authed)/items/actions', () => ({
  listRootIssuesAction: vi.fn(),
  listChildIssuesAction: vi.fn(),
}));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: () => {},
    openCreateIssue: () => {},
    canCreate: true,
    issuesChangedAt: 0,
  }),
  useNotifyIssuesChanged: () => () => {},
}));

import { IssueListTable } from '@/app/(authed)/items/_components/IssueListTable';
import { toIssueListRows } from '@/app/(authed)/items/_components/issueRows';
import { BoardCard } from '@/app/(authed)/boards/_components/BoardCard';
import {
  IssueQuickViewPanel,
  type QuickViewData,
} from '@/app/(authed)/items/_components/IssueQuickViewPanel';
import type { BoardCardDto } from '@/lib/dto/boards';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { WorkItemTreeRowDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import zhMessages from '@/messages/zh.json';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
});

afterEach(cleanup);

// ── The List / Tree row ──────────────────────────────────────────────────────

const members: WorkspaceMemberDTO[] = [
  { userId: 'u-me', name: 'Me', email: 'me@x.com', workspaceRole: 'manager', customRole: null },
];
const st = (key: string, label: string, category: 'todo' | 'in_progress' | 'done', i: number) => ({
  id: `s-${key}`,
  projectId: 'p1',
  key,
  label,
  category,
  color: null,
  position: `a${i}`,
  isInitial: i === 0,
});
const workflow: WorkflowDto = {
  statuses: [
    st('todo', 'To Do', 'todo', 0),
    st('implemented', 'Implemented', 'in_progress', 1),
    st('in_review', 'In Review', 'in_progress', 2),
    st('done', 'Done', 'done', 3),
  ],
  transitions: [],
  policyMode: 'restricted',
};

function node(over: Partial<WorkItemTreeRowDto> & { id: string; key: number }): WorkItemTreeRowDto {
  return {
    parentId: null,
    kind: 'task',
    type: null,
    identifier: `PROD-${over.key}`,
    title: `Issue ${over.key}`,
    status: 'implemented',
    ciState: null,
    fixReason: null,
    priority: 'medium',
    assigneeId: 'u-me',
    reporterId: 'u-me',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    hasDescription: false,
    obsolescence: null,
    obsolescenceNoteMd: null,
    hasChildren: false,
    ...over,
  };
}

function renderList(items: WorkItemTreeRowDto[], locale?: { locale: string; messages: object }) {
  return render(
    <IssueListTable
      rows={toIssueListRows(items, workflow, members, 'en', {
        c: { state: 'yours', kind: 'design_result', routedToId: 'u-me' },
      })}
      sort={{ column: 'key', direction: 'asc' }}
      filter={EMPTY_FILTER}
      pagination={{ total: items.length, page: 1, pageSize: 50 }}
    />,
    locale as never,
  );
}

function tagIn(rowTestId: string): HTMLElement | null {
  return within(screen.getByTestId(rowTestId)).queryByRole('img', { name: /^To fix|^待修复/ });
}

describe('the List row — the glyph in the STATUS cell', () => {
  it('draws the tag for a reason, names it, and draws nothing for none or done', () => {
    renderList([
      node({ id: 'a', key: 1, fixReason: 'queue_failed', ciState: 'passing' }),
      node({ id: 'b', key: 2 }),
      node({ id: 'd', key: 4, status: 'done', fixReason: 'ci_failed', ciState: 'failing' }),
    ]);
    expect(tagIn('issue-row-PROD-1')?.getAttribute('aria-label')).toBe(
      'To fix · failed in the merge queue',
    );
    expect(tagIn('issue-row-PROD-2')).toBeNull();
    expect(tagIn('issue-row-PROD-4')).toBeNull();
  });

  it('sits in the status cell, OUTSIDE any button, after the decision glyph when both hold', () => {
    renderList([node({ id: 'c', key: 3, fixReason: 'ci_failed', ciState: 'failing' })]);
    const tag = tagIn('issue-row-PROD-3')!;
    expect(tag.closest('button')).toBeNull();
    expect(tag.previousElementSibling?.getAttribute('data-decision-marker')).toBe('yours');
    // The CI glyph stays in the TITLE cell: the two signals are in different cells.
    const ci = screen.getByTestId('issue-row-PROD-3').querySelector('[data-ci-state="failing"]');
    expect(ci).toBeTruthy();
    expect(ci!.parentElement).not.toBe(tag.parentElement);
  });

  it('draws the tag on a conflicting card whose checks are GREEN — independent signals', () => {
    renderList([node({ id: 'e', key: 5, fixReason: 'conflicted', ciState: 'passing' })]);
    expect(tagIn('issue-row-PROD-5')?.getAttribute('aria-label')).toBe(
      'To fix · conflicts with its base branch',
    );
    expect(screen.getByTestId('issue-row-PROD-5').querySelector('[data-ci-state]')).toBeNull();
  });

  it('names the reason in zh', () => {
    renderList([node({ id: 'f', key: 6, fixReason: 'changes_requested' })], {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(tagIn('issue-row-PROD-6')?.getAttribute('aria-label')).toBe('待修复 · 已要求修改');
  });
});

// ── The board card ───────────────────────────────────────────────────────────

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Card ${over.key}`,
    status: 'implemented',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    position: 'a0',
    ready: true,
    readyToStart: false,
    statusLabel: 'To Do',
    hasChildren: false,
    type: null,
    executor: null,
    pendingDecision: null,
    planHold: null,
    ciState: null,
    fixReason: null,
    obsolescence: null,
    statusCategory: 'in_progress',
    ...over,
  };
}

describe('the board card — the label in the pill row', () => {
  it('draws the tag after the exclusive slot and before the CI badge', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 7, fixReason: 'ci_failed', ciState: 'failing', ready: false })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    const tag = document.querySelector('[data-to-fix]') as HTMLElement;
    expect(tag.textContent).toBe('To fix · CI failed');
    // Blocked holds the exclusive slot and survives; the CI badge follows the tag.
    expect(tag.previousElementSibling?.getAttribute('aria-label')).toBe('Blocked');
    expect(tag.nextElementSibling?.getAttribute('data-ci-state')).toBe('failing');
  });

  it("is named by the card's aria-describedby, since the card is one button", () => {
    render(
      <BoardCard
        card={card({ id: 'w2', key: 8, fixReason: 'conflicted' })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    const tag = document.getElementById('to-fix-w2');
    expect(tag).toBeTruthy();
    const describedBy = document
      .querySelector('[aria-describedby]')
      ?.getAttribute('aria-describedby')
      ?.split(' ');
    expect(describedBy).toContain('to-fix-w2');
  });

  it('draws nothing — and describes nothing — for no reason or a done card', () => {
    for (const over of [
      { fixReason: null },
      { fixReason: 'ci_failed' as const, statusCategory: 'done' as const },
    ]) {
      render(
        <BoardCard
          card={card({ id: 'w3', key: 9, ...over })}
          assigneeName={null}
          onOpenQuickView={() => {}}
        />,
      );
      expect(document.querySelector('[data-to-fix]')).toBeNull();
      const describedBy =
        document.querySelector('[aria-describedby]')?.getAttribute('aria-describedby') ?? '';
      expect(describedBy).not.toContain('to-fix-');
      cleanup();
    }
  });
});

// ── The quick-view header ────────────────────────────────────────────────────

const QV: QuickViewData = {
  folderId: null,
  folderPath: [],
  identifier: 'PROD-7',
  title: 'Swimlanes remember their collapsed state',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'task',
  statusLabel: 'In Review',
  statusCategory: 'in_progress',
  fixReason: 'conflicted',
  obsolescence: null,
  obsolescenceNoteMd: null,
  descriptionMd: null,
  explanationMd: null,
  type: null,
  executor: null,
  difficulty: null,
  assigneeName: null,
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
  parent: null,
  readiness: null,
  archived: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: true,
  id: 'cmqvitem00000000000000p7',
  status: 'in_review',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points' as const,
    pointScale: 'fibonacci' as const,
    customScaleValues: [],
    canEdit: true,
  },
};

describe('the quick-view header — the label after the status pill', () => {
  it('draws the tag for a reason', () => {
    render(<IssueQuickViewPanel state="ready" data={QV} />);
    const tag = document.querySelector('[data-to-fix]') as HTMLElement;
    expect(tag.textContent).toBe('To fix · conflicts with its base branch');
    expect(tag.previousElementSibling?.textContent).toBe('In Review');
  });

  it('draws nothing for no reason, or a done card', () => {
    render(<IssueQuickViewPanel state="ready" data={{ ...QV, fixReason: null }} />);
    expect(document.querySelector('[data-to-fix]')).toBeNull();
    cleanup();
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{
          ...QV,
          statusCategory: 'done',
          statusLabel: 'Done',
          fixReason: 'ci_failed' as WorkItemFixReasonDto,
        }}
      />,
    );
    expect(document.querySelector('[data-to-fix]')).toBeNull();
  });
});

// FIXING ON ITS THREE HOSTS (Story MOTIR-10305 · MOTIR-10309; design § 40.2): the same slot
// in the sky tint with a hammer, read from each DTO's `fixing` — absent, the To fix tag.
describe('Fixing (MOTIR-10309) — the same slot on every host', () => {
  const FIXING = 'Fixing · checks are running on a new push';

  it('the List row draws the Fixing glyph in the status cell', () => {
    renderList([
      node({ id: 'f1', key: 31, fixReason: 'ci_failed', fixing: true }),
      node({ id: 'f2', key: 32, fixReason: 'ci_failed' }),
    ]);
    const fixing = screen.getByRole('img', { name: `${FIXING} — To fix · CI failed` });
    expect(fixing.getAttribute('data-to-fix-fixing')).toBe('true');
    expect(document.querySelectorAll('[data-to-fix-fixing]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-to-fix="ci_failed"]')).toHaveLength(1);
  });

  it('the board card draws the Fixing label, still named by aria-describedby', () => {
    render(
      <BoardCard
        card={card({ id: 'w31', key: 31, fixReason: 'ci_failed', fixing: true })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    const tag = document.getElementById('to-fix-w31')!;
    expect(tag.getAttribute('data-to-fix-fixing')).toBe('true');
    expect(tag.textContent).toBe(`${FIXING} — To fix · CI failed`);
    expect(document.querySelector('[data-to-fix]')).toBeNull();
  });

  it('the quick-view header draws the Fixing label after the status pill', () => {
    render(<IssueQuickViewPanel state="ready" data={{ ...QV, fixing: true }} />);
    const tag = document.querySelector('[data-to-fix-fixing]') as HTMLElement;
    expect(tag.textContent).toBe(`${FIXING} — To fix · conflicts with its base branch`);
    expect(tag.previousElementSibling?.textContent).toBe('In Review');
  });
});
