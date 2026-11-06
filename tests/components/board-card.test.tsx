// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { BoardCard } from '@/app/(authed)/boards/_components/BoardCard';
import type { BoardCardDto } from '@/lib/dto/boards';

// BoardCard (Subtask 3.2.3) is a pure presentational card: it REUSES the issue
// primitives (IssueTypeIcon, PriorityValue, Avatar) and opens the existing
// IssueQuickView via the onOpenQuickView callback the board wires. Rendered with
// the real `en` catalog so the priority / blocked / assignee strings are exact.

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Card ${over.key}`,
    status: 'todo',
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
    statusCategory: 'todo',
    ...over,
  };
}

afterEach(cleanup);

describe('BoardCard', () => {
  it('renders the identifier, title, priority chip and estimate', () => {
    render(
      <BoardCard
        card={card({
          id: 'w1',
          key: 7,
          title: 'Wire OAuth',
          priority: 'high',
          estimateMinutes: 90,
        })}
        assigneeName="Yue Zhu"
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByText('PROD-7')).toBeTruthy();
    expect(screen.getByText('Wire OAuth')).toBeTruthy();
    // Priority chip uses the shared PRIORITY_META label (labels.priority.high).
    expect(screen.getByText('High')).toBeTruthy();
    // Estimate chip is the shared formatDurationMinutes output.
    expect(screen.getByText('1h 30m')).toBeTruthy();
  });

  // MOTIR-2618 — the board card rendered NO story points for two months while
  // this file's first case asserted it "renders … and estimate" and passed, because
  // the estimate it renders is the TIME estimate. The two chips are adjacent, share
  // a treatment, and had one assertion between them; each now has its own.
  it('renders the story-point chip beside the time estimate (MOTIR-2618)', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 7, storyPoints: 5, estimateMinutes: 90 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    // The `.pts` chip: the bare figure, per design/boards/board.mock.html.
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByTitle('5 story points')).toBeTruthy();
    expect(screen.getByLabelText('5 story points')).toBeTruthy();
    // …and it did not displace the time estimate — both render.
    expect(screen.getByText('1h 30m')).toBeTruthy();
    // The `hash` glyph that tells the two adjacent mono figures apart is
    // DECORATIVE — the chip's accessible name is the label alone, never "# 5".
    const glyph = screen.getByLabelText('5 story points').querySelector('svg');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  it('omits the story-point chip when the card is unpointed', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 7, storyPoints: null, estimateMinutes: 90 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.queryByTitle(/story points$/)).toBeNull();
    // No empty placeholder either — the slot collapses, as the estimate's does.
    expect(screen.getByText('1h 30m')).toBeTruthy();
  });

  it('formats a fractional story-point value the way every other surface does', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 7, storyPoints: 0.5 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByText('0.5')).toBeTruthy();
  });

  // MOTIR-2618's stated NON-goal, held from the code side. The board card's own
  // surface is the drag-handle `<button>`, so `EstimateBadge`'s editable arm — a
  // button — cannot nest inside it; putting the interactive chip on the board
  // needs the overlay-vs-handle design decision first, and until that exists the
  // board renders the static span. `EstimateBadge`'s header comment names the
  // four real call sites and this asserts the board is not quietly a fifth.
  it('nothing under app/(authed)/boards imports EstimateBadge — the static chip is deliberate', () => {
    const root = join(process.cwd(), 'app/(authed)/boards');
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      /\.tsx?$/.test(f),
    );
    // The whole tree, not just _components — and matched on the IMPORT / the JSX
    // element, so a comment explaining why the board doesn't use it (BoardCard has
    // one) is not a false positive.
    const offenders = sources.filter((f) =>
      /import[^;]*\bEstimateBadge\b|<EstimateBadge\b/.test(readFileSync(join(root, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
    expect(sources.length).toBeGreaterThan(10); // the scan actually read the tree
  });

  it('omits the estimate chip when the card has no estimate', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 1 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    // The medium-priority chip shows, but the estimate chip (titled "Estimate …")
    // is absent.
    expect(screen.getByText('Medium')).toBeTruthy();
    expect(screen.queryByTitle(/^Estimate/)).toBeNull();
  });

  // THE DECISION-WAITING MARKER (MOTIR-5877; design MOTIR-5875) — it took the
  // retired `Awaiting acceptance` pill's slot. The exclusive slot's precedence is
  // Yours › Blocked › Someone else's › priority.
  it('a decision waiting on YOU shows the LOUD marker in place of the priority', () => {
    render(
      <BoardCard
        card={card({
          id: 's1',
          key: 3,
          kind: 'story',
          priority: 'high',
          pendingDecision: { state: 'yours', kind: 'design_result', routedToId: 'u-me' },
        })}
        assigneeName={null}
        routedToName="Me"
        onOpenQuickView={() => {}}
      />,
    );
    const marker = document.querySelector('[data-decision-marker="yours"]');
    expect(marker?.textContent).toBe('Awaiting you');
    expect(marker?.getAttribute('data-decision-kind')).toBe('design_result');
    expect(screen.queryByText('High')).toBeNull(); // the marker takes the slot
  });

  it('a decision waiting on someone else shows the QUIET marker naming them — a different treatment, not only different words', () => {
    render(
      <BoardCard
        card={card({
          id: 's2',
          key: 8,
          kind: 'story',
          priority: 'high',
          pendingDecision: { state: 'others', kind: 'acceptance_result', routedToId: 'u-ana' },
        })}
        assigneeName={null}
        routedToName="Ana Ruiz"
        onOpenQuickView={() => {}}
      />,
    );
    const quiet = document.querySelector('[data-decision-marker="others"]');
    expect(quiet?.textContent).toBe('Waiting on Ana Ruiz');
    // The tone differs on the element itself (fill + ink), and so does the glyph.
    expect(quiet?.className).toContain('--el-chip-bg');
    expect(quiet?.className).not.toContain('--el-tint-yellow');
    expect(quiet?.querySelector('.lucide-hourglass')).toBeTruthy();
    expect(quiet?.querySelector('.lucide-stamp')).toBeNull();
    expect(screen.queryByText('High')).toBeNull();
  });

  it('a routed person the board cannot name reads as this work item’s assignee', () => {
    render(
      <BoardCard
        card={card({
          id: 's3',
          key: 9,
          pendingDecision: { state: 'others', kind: 'acceptance_result', routedToId: 'u-ana' },
        })}
        assigneeName={null}
        routedToName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(document.querySelector('[data-decision-marker="others"]')?.textContent).toBe(
      "Waiting on this work item's assignee",
    );
  });

  it('with no decision waiting the priority chip shows and no marker renders', () => {
    render(
      <BoardCard
        card={card({ id: 't1', key: 4, kind: 'task', priority: 'high' })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(document.querySelector('[data-decision-marker]')).toBeNull();
    expect(screen.getByText('High')).toBeTruthy();
    expect(
      screen.getByTestId('board-card-PROD-4').getAttribute('aria-describedby') ?? '',
    ).not.toMatch(/decision-marker/);
  });

  it('PRECEDENCE — a BLOCKED card with a gate that is yours shows the marker, not Blocked', () => {
    render(
      <BoardCard
        card={card({
          id: 'b1',
          key: 10,
          ready: false,
          pendingDecision: { state: 'yours', kind: 'design_result', routedToId: 'u-me' },
        })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(document.querySelector('[data-decision-marker="yours"]')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Blocked' })).toBeNull();
  });

  it('PRECEDENCE — a BLOCKED card with someone else’s gate shows Blocked, not the quiet marker', () => {
    render(
      <BoardCard
        card={card({
          id: 'b2',
          key: 11,
          ready: false,
          pendingDecision: { state: 'others', kind: 'acceptance_result', routedToId: 'u-ana' },
        })}
        assigneeName={null}
        routedToName="Ana Ruiz"
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByRole('img', { name: 'Blocked' })).toBeTruthy();
    expect(document.querySelector('[data-decision-marker]')).toBeNull();
    expect(
      screen.getByTestId('board-card-PROD-11').getAttribute('aria-describedby') ?? '',
    ).not.toMatch(/decision-marker/);
  });

  it('the card button is DESCRIBED BY its marker, which its own label would otherwise hide', () => {
    render(
      <BoardCard
        card={card({
          id: 'd1',
          key: 12,
          pendingDecision: { state: 'yours', kind: 'design_result', routedToId: 'u-me' },
        })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    // JOINED with dnd-kit's own instructions id, never replacing it.
    const ids = (
      screen.getByTestId('board-card-PROD-12').getAttribute('aria-describedby') ?? ''
    ).split(' ');
    const markerIds = ids.filter((id) =>
      document.getElementById(id)?.hasAttribute('data-decision-marker'),
    );
    expect(markerIds).toHaveLength(1);
    expect(document.getElementById(markerIds[0]!)?.getAttribute('data-decision-marker')).toBe(
      'yours',
    );
  });

  it('shows the assignee initial avatar when assigned', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 1, assigneeId: 'u1' })}
        assigneeName="Ana Ruiz"
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByTitle('Assigned to Ana Ruiz')).toBeTruthy();
  });

  it('shows the unassigned placeholder when there is no assignee', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 1 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByLabelText('Unassigned')).toBeTruthy();
  });

  it('shows the blocked pill instead of the priority chip when not ready', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 1, priority: 'high', ready: false })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByRole('img', { name: 'Blocked' })).toBeTruthy();
    // The priority chip is swapped out, not shown alongside.
    expect(screen.queryByText('High')).toBeNull();
  });

  it('calls onOpenQuickView with the identifier on click', () => {
    const onOpen = vi.fn();
    render(
      <BoardCard card={card({ id: 'w1', key: 9 })} assigneeName={null} onOpenQuickView={onOpen} />,
    );
    fireEvent.click(screen.getByTestId('board-card-PROD-9'));
    expect(onOpen).toHaveBeenCalledWith('PROD-9');
  });
});

// ── THE CI BADGE (Story MOTIR-5469 · MOTIR-5474) ──────────────────────────────
// Design: `design/boards/board-card--ci-badge.mock.html`, spec
// `design/boards/design-notes.md` § *The CI badge (MOTIR-5471)*.
//
// The badge is an ADDITIONAL pill in the card's existing pill row, immediately
// after the exclusive one — so it can never hide `Blocked` or `Awaiting
// acceptance`, which is the question the design card was asked to answer.
describe('BoardCard — the CI badge (MOTIR-5474)', () => {
  it('renders the text AND the glyph for failing and for running', () => {
    // State is carried by text and icon, never colour alone (finding #35), so
    // both halves are asserted rather than just the string.
    for (const [state, label] of [
      ['failing', 'Checks failing'],
      ['running', 'Checks running'],
    ] as const) {
      render(
        <BoardCard
          card={card({ id: `c-${state}`, key: 1, ciState: state })}
          assigneeName={null}
          onOpenQuickView={vi.fn()}
        />,
      );
      const badge = screen.getByText(label);
      expect(badge).toBeTruthy();
      // The glyph rides inside the same pill, and the two states use DIFFERENT
      // shapes — which is what lets the row's icon-only form stay legible.
      const pill = badge.closest('[data-ci-state]');
      expect(pill?.getAttribute('data-ci-state')).toBe(state);
      expect(pill?.querySelector('svg')).toBeTruthy();
      cleanup();
    }
  });

  it('renders NO badge for passing or for null', () => {
    // `passing` earns none because green CI is what moves a card to In Review —
    // a green badge would restate the column. `null` is "no checks", not a state.
    for (const ciState of ['passing', null] as const) {
      render(
        <BoardCard
          card={card({ id: 'c-none', key: 2, ciState })}
          assigneeName={null}
          onOpenQuickView={vi.fn()}
        />,
      );
      expect(screen.queryByText(/^Checks /)).toBeNull();
      expect(document.querySelector('[data-ci-state]')).toBeNull();
      cleanup();
    }
  });

  it('renders NOTHING on a done-category card, whatever the column says', () => {
    // The rule is the status CATEGORY, not the column: a board maps statuses to
    // columns many-to-one, and a done card's old red is not actionable. The value
    // stays STORED — it is simply not drawn.
    render(
      <BoardCard
        card={card({ id: 'c-done', key: 3, ciState: 'failing', statusCategory: 'done' })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    expect(screen.queryByText('Checks failing')).toBeNull();
  });

  it('renders the badge BESIDE Blocked — neither hides the other', () => {
    // The case the design card was asked about. `ready: false` is what swaps the
    // priority chip for `Blocked`; the badge is added rather than substituted, so
    // both survive.
    render(
      <BoardCard
        card={card({ id: 'c-blocked', key: 4, ciState: 'failing', ready: false })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    expect(screen.getByRole('img', { name: 'Blocked' })).toBeTruthy();
    expect(screen.getByText('Checks failing')).toBeTruthy();
  });

  it('renders the badge BESIDE the decision-waiting marker — neither hides the other', () => {
    render(
      <BoardCard
        card={card({
          id: 'c-await',
          key: 5,
          ciState: 'running',
          pendingDecision: { state: 'yours', kind: 'design_result', routedToId: 'u-me' },
        })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    expect(screen.getByText('Awaiting you')).toBeTruthy();
    expect(screen.getByText('Checks running')).toBeTruthy();
  });

  it('WRAPS its pill row, so a second pill cannot overflow the card', () => {
    // ⚠️ This is the change rendering found and reading did not: `BoardCard.tsx`
    // carried no `flex-wrap`, so at the board's 288px column a second pill pushed
    // the story-point chip and the avatar past the card's right edge. Asserted on
    // the class because a happy-dom render has no layout to measure.
    const { container } = render(
      <BoardCard
        card={card({
          id: 'c-wrap',
          key: 6,
          ciState: 'running',
          pendingDecision: { state: 'yours', kind: 'design_result', routedToId: 'u-me' },
        })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    const row = container.querySelector('[data-ci-state]')?.parentElement;
    expect(row?.className).toContain('flex-wrap');
  });

  it('pins the badge label against breaking inside the chip', () => {
    // The other rendering find: `Pill` sets no `whitespace-nowrap`, so "Checks
    // failing" broke onto two lines inside the chip with the glyph orphaned.
    render(
      <BoardCard
        card={card({ id: 'c-nowrap', key: 7, ciState: 'failing' })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-ci-state]')?.className).toContain('whitespace-nowrap');
  });
});

// MOTIR-6170 · MOTIR-6648 — a Visitor's PRIVATE epic card wears "Not public"; a
// card without the mark (every member read) never does.
describe('BoardCard — a Visitor’s private epic', () => {
  it('shows the Not public pill only on a card marked childrenHidden', () => {
    render(
      <BoardCard
        card={{ ...card({ id: 'e1', key: 1 }), kind: 'epic', childrenHidden: true }}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByTestId('epic-not-public-pill').textContent).toContain('Not public');
    cleanup();
    render(
      <BoardCard
        card={{ ...card({ id: 'e2', key: 2 }), kind: 'epic' }}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.queryByTestId('epic-not-public-pill')).toBeNull();
  });
});

// Story MOTIR-6575 · MOTIR-6677 — the OBSOLESCENCE badge, per
// `design/boards/board-card--obsolescence.mock.html`: the item header's own Pill,
// an ADDITIONAL member of the pill row after the exclusive slot and before the CI
// badge. It takes no slot and hides nothing.
describe('BoardCard — the obsolescence badge (MOTIR-6677)', () => {
  it.each([
    ['outdated', 'Outdated'],
    ['deprecated', 'Deprecated'],
  ] as const)('a %s card wears the badge — word AND glyph', (mark, word) => {
    render(
      <BoardCard
        card={card({
          id: 'c-m',
          key: 1,
          status: 'done',
          statusCategory: 'done',
          obsolescence: mark,
        })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    const badge = document.querySelector(`[data-obsolescence="${mark}"]`)!;
    expect(badge.textContent).toBe(word);
    expect(badge.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('an unmarked card wears nothing new', () => {
    render(
      <BoardCard
        card={card({ id: 'c-u', key: 2 })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-obsolescence]')).toBeNull();
  });

  it('sits after the exclusive slot and before the CI badge, hiding neither (a legacy open row)', () => {
    render(
      <BoardCard
        card={card({
          id: 'c-l',
          key: 3,
          ready: false,
          ciState: 'failing',
          statusCategory: 'in_progress',
          obsolescence: 'deprecated',
        })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    const mark = document.querySelector('[data-obsolescence]')!;
    const ci = document.querySelector('[data-ci-state]')!;
    const blocked = screen.getByRole('img', { name: 'Blocked' });
    expect(mark.parentElement).toBe(ci.parentElement);
    expect(blocked.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mark.compareDocumentPosition(ci) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
