// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// THE REVIEW MARKERS AND THE REVIEWED BADGE ON THEIR HOSTS (Story MOTIR-10327 ·
// MOTIR-10341; design § 32.1, § 32.3, mock M1–M7): the board card's EXCLUSIVE SLOT (a
// decision waiting on you › Blocked › a review marker or a decision waiting on someone
// else › priority) with the Reviewed badge after it and before the CI badge, both named by
// the card's `aria-describedby`; and the List / Tree STATUS cell, glyph forms, after the
// status pill. The command is never on a board card — the card is one button.

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
import { toIssueListRows, toIssueRows } from '@/app/(authed)/items/_components/issueRows';
import { BoardCard } from '@/app/(authed)/boards/_components/BoardCard';
import type { BoardCardDto } from '@/lib/dto/boards';
import {
  decisionBesideReview,
  type CardReviewDTO,
  type CardReviewMap,
} from '@/lib/dto/reviewState';
import type { WorkItemTreeNodeDto, WorkItemTreeRowDto } from '@/lib/dto/workItems';
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
});

afterEach(cleanup);

const REVIEWED: CardReviewDTO = {
  identifier: 'PROD-1',
  marker: null,
  reviewed: {
    reviewer: { kind: 'hosted', model: null },
    at: '2026-11-05T09:00:00.000Z',
    commits: [{ repo: 'acme/web', number: 88, headSha: '3f2a9c1aaaa' }],
  },
  recordRef: { kind: 'record', id: 'r1' },
};
const WAITING_YOURS: CardReviewDTO = {
  identifier: 'PROD-2',
  marker: {
    kind: 'waiting_for_own_agent',
    routedTo: { id: 'u-me', name: 'Me' },
    forViewer: true,
    command: 'motir review PROD-2',
  },
  reviewed: null,
  recordRef: null,
};

// ── The board card ───────────────────────────────────────────────────────────

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Card ${over.key}`,
    status: 'implemented',
    priority: 'high',
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
    review: null,
    ...over,
  };
}

function renderCard(c: BoardCardDto, locale?: { locale: string; messages: object }) {
  return render(
    <BoardCard card={c} assigneeName={null} routedToName={null} onOpenQuickView={() => {}} />,
    locale as never,
  );
}

function describedBy(): string[] {
  return (
    document.querySelector('[aria-describedby]')?.getAttribute('aria-describedby') ?? ''
  ).split(' ');
}

describe('the board card — the review marker in the exclusive slot', () => {
  it('takes the slot in place of the priority, is named by the card, and offers no command', () => {
    renderCard(card({ id: 'c2', key: 2, review: WAITING_YOURS }));
    const marker = document.querySelector('[data-review-marker]') as HTMLElement;
    expect(marker.textContent).toBe('Waiting for your review agent');
    expect(marker.hasAttribute('data-review-loud')).toBe(true);
    expect(screen.queryByText('High')).toBeNull();
    expect(describedBy()).toContain(marker.id);
    expect(screen.queryByRole('button', { name: /Copy motir review/ })).toBeNull();
    expect(screen.queryByText('motir review PROD-2')).toBeNull();
  });

  it('Blocked outranks it, and the priority returns when there is no marker', () => {
    renderCard(card({ id: 'c3', key: 3, ready: false, review: { ...WAITING_YOURS } }));
    expect(document.querySelector('[data-review-marker]')).toBeNull();
    expect(screen.getByRole('img', { name: 'Blocked' })).toBeTruthy();
    cleanup();

    renderCard(card({ id: 'c4', key: 4 }));
    expect(document.querySelector('[data-review-marker]')).toBeNull();
    expect(screen.getByText('High')).toBeTruthy();
  });

  it('a decision waiting on YOU outranks it', () => {
    renderCard(
      card({
        id: 'c5',
        key: 5,
        pendingDecision: { state: 'yours', kind: 'design_result', routedToId: 'u-me' },
        review: WAITING_YOURS,
      }),
    );
    expect(document.querySelector('[data-decision-marker="yours"]')).toBeTruthy();
    expect(document.querySelector('[data-review-marker]')).toBeNull();
  });

  it('the awaiting agent_review gate is the review marker’s own fact — its decision marker steps aside (MOTIR-10345)', () => {
    renderCard(
      card({
        id: 'c6',
        key: 6,
        status: 'in_review',
        pendingDecision: { state: 'yours', kind: 'agent_review', routedToId: 'u-me' },
        review: WAITING_YOURS,
      }),
    );
    expect(document.querySelector('[data-decision-marker]')).toBeNull();
    expect(document.querySelector('[data-review-marker]')?.textContent).toBe(
      'Waiting for your review agent',
    );
    cleanup();

    // With no review marker (the gate off), the agent_review gate keeps its decision marker.
    renderCard(
      card({
        id: 'c7',
        key: 7,
        pendingDecision: { state: 'yours', kind: 'agent_review', routedToId: 'u-me' },
        review: REVIEWED,
      }),
    );
    expect(document.querySelector('[data-decision-marker="yours"]')).toBeTruthy();
    expect(document.querySelector('[data-review-marker]')).toBeNull();
  });

  it('the Reviewed badge sits after the slot and before the CI badge, named by the card', () => {
    renderCard(card({ id: 'c1', key: 1, review: REVIEWED, ciState: 'failing' }));
    const badge = document.querySelector('[data-reviewed-badge]') as HTMLElement;
    expect(badge.textContent).toBe('Reviewed');
    expect(badge.hasAttribute('tabindex')).toBe(false);
    expect(describedBy()).toContain(badge.id);
    const ci = document.querySelector('[data-ci-state="failing"]')!;
    expect(badge.compareDocumentPosition(ci) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByText('High').compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Not interactive: no hover card on a card that is one button.
    fireEvent.mouseEnter(badge);
    expect(screen.queryByTestId('reviewed-card')).toBeNull();
  });

  it('a marker without a Reviewed state adds no badge id to the description', () => {
    renderCard(card({ id: 'c7', key: 7, review: WAITING_YOURS }));
    expect(describedBy().some((id) => id.startsWith('reviewed-badge-'))).toBe(false);
  });

  it('in zh', () => {
    renderCard(card({ id: 'c8', key: 8, review: WAITING_YOURS }), {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(document.querySelector('[data-review-marker]')?.textContent).toBe('等待你的审查智能体');
  });
});

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
  statuses: [st('todo', 'To Do', 'todo', 0), st('implemented', 'Implemented', 'in_progress', 1)],
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

function renderList(items: WorkItemTreeRowDto[], reviews: CardReviewMap) {
  return render(
    <IssueListTable
      rows={toIssueListRows(items, workflow, members, 'en', {}, reviews)}
      sort={{ column: 'key', direction: 'asc' }}
      filter={EMPTY_FILTER}
      pagination={{ total: items.length, page: 1, pageSize: 50 }}
    />,
  );
}

describe('the List row — glyphs in the STATUS cell', () => {
  it('draws the marker glyph and the Reviewed glyph where the read model answered, nothing elsewhere', () => {
    renderList([node({ id: 'a', key: 1 }), node({ id: 'b', key: 2 }), node({ id: 'c', key: 3 })], {
      a: REVIEWED,
      b: WAITING_YOURS,
    });
    const reviewed = within(screen.getByTestId('issue-row-PROD-1')).getByRole('img', {
      name: 'Reviewed by an agent at the current commits',
    });
    expect(reviewed.tabIndex).toBe(0);
    expect(reviewed.closest('button')).toBeNull();
    const waiting = within(screen.getByTestId('issue-row-PROD-2')).getByRole('img', {
      name: 'Waiting for your review agent — run motir review PROD-2',
    });
    expect(waiting.closest('button')).toBeNull();
    const row3 = screen.getByTestId('issue-row-PROD-3');
    expect(row3.querySelector('[data-review-marker]')).toBeNull();
    expect(row3.querySelector('[data-reviewed-badge]')).toBeNull();
  });

  it('the Reviewed glyph opens its card on focus, inside the row', () => {
    renderList([node({ id: 'a', key: 1 })], { a: REVIEWED });
    const glyph = screen.getByRole('img', { name: 'Reviewed by an agent at the current commits' });
    fireEvent.focus(glyph);
    expect(screen.getByTestId('reviewed-card').textContent).toContain('acme/web#88 @ 3f2a9c1');
  });
});

describe('the row shaping carries each row its review answer', () => {
  it('toIssueRows maps every level of the tree by id', () => {
    const child: WorkItemTreeNodeDto = {
      ...node({ id: 'k', key: 9 }),
      depth: 1,
      matched: true,
      children: [],
    };
    const root: WorkItemTreeNodeDto = {
      ...node({ id: 'r', key: 8 }),
      depth: 0,
      matched: true,
      children: [child],
    };
    const [row] = toIssueRows([root], workflow, members, 'en', {}, { k: REVIEWED });
    expect(row!.data.review).toBeNull();
    expect(row!.children![0]!.data.review).toBe(REVIEWED);
  });

  it('the defaults carry no review at all', () => {
    expect(toIssueListRows([node({ id: 'a', key: 1 })], workflow, members)[0]!.review).toBeNull();
  });
});

describe('decisionBesideReview — which decision marker draws beside a review', () => {
  const agentReview = { state: 'yours' as const, kind: 'agent_review', routedToId: 'u-me' };
  const design = { state: 'others' as const, kind: 'design_result', routedToId: 'u-b' };
  it('drops only the agent_review gate, and only when a review marker tells it', () => {
    expect(decisionBesideReview(agentReview, WAITING_YOURS)).toBeNull();
    expect(decisionBesideReview(agentReview, REVIEWED)).toBe(agentReview);
    expect(decisionBesideReview(agentReview, null)).toBe(agentReview);
    expect(decisionBesideReview(design, WAITING_YOURS)).toBe(design);
    expect(decisionBesideReview(null, WAITING_YOURS)).toBeNull();
    expect(decisionBesideReview(undefined, undefined)).toBeNull();
  });
});
