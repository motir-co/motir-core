// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import type { FailedUsageGroupDTO, FailedUsageReplayDTO } from '@/lib/dto/failedUsage';

/**
 * Usage & cost's Failed usage island (MOTIR-11794; design MOTIR-11793 Panels
 * 1–7 and 10). The Replay action is stubbed: its codes, the operator rule and
 * the audit row have their own real-Postgres suite
 * (`tests/platform/platformFailedUsage.test.ts`).
 *
 * happy-dom applies no stylesheet, so the table (from `sm`) and the group cards
 * (below it) are both in the tree; each assertion scopes to the one it means.
 */

const replayFailedUsageAction = vi.hoisted(() => vi.fn<(error: unknown) => Promise<unknown>>());
vi.mock('@/app/(admin)/admin/usage/actions', () => ({ replayFailedUsageAction }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { FailedUsageGroups } =
  await import('@/app/(admin)/admin/usage/_components/FailedUsageGroups');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const OVERFLOW =
  'Invalid `tx.usageMonthly.upsert()` invocation:\n\nValue out of range for the type integer.';
const NO_RATE = 'No rate for model kimi-k2.5 (Moonshot AI) in the agent-run tokens category.';
const CONFLICT = 'Credit balance write conflicted with another write.';

const g = (
  error: string,
  rows: number,
  organizations: number,
  newest = '2026-11-14T22:51:00.000Z',
): FailedUsageGroupDTO => ({
  error,
  rows,
  organizations,
  oldestReceivedAt: '2026-11-12T03:18:00.000Z',
  newestReceivedAt: newest,
});

const GROUPS = [g(OVERFLOW, 7352, 41), g(NO_RATE, 18, 2, '2026-11-18T16:40:00.000Z'), g('', 3, 1)];

const table = () => screen.getByTestId('usage-failed-groups');
const tableRows = () => within(table()).getAllByTestId('failed-group');
const replayIn = (row: HTMLElement) => within(row).getByTestId('failed-group-replay');

function replayDTO(over: Partial<FailedUsageReplayDTO>): FailedUsageReplayDTO {
  return { error: OVERFLOW, reset: 7352, applied: 7352, failedAgain: 0, pending: 0, ...over };
}

async function confirmReplay(row: HTMLElement) {
  fireEvent.click(replayIn(row));
  const dialog = await screen.findByRole('alertdialog');
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: /^Replay [\d,]+ rows?$/ }));
  });
}

describe('FailedUsageGroups — the table', () => {
  it('lists every group with its counts and UTC times, and a Replay named by its rows', () => {
    renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    expect(within(table()).getByText('Failed usage, grouped by error')).toBeTruthy();
    const [first] = tableRows();
    const cells = within(first!)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells.slice(1, 5)).toEqual(['7,352', '41', 'Nov 12, 03:18', 'Nov 14, 22:51']);
    const cell = first!.querySelector('[title]');
    expect(cell?.getAttribute('title')).toBe(OVERFLOW);
    expect(cell?.textContent).toBe(
      'Invalid `tx.usageMonthly.upsert()` invocation: Value out of range for the type integer.',
    );
    expect(replayIn(first!).getAttribute('aria-label')).toBe(
      'Replay 7,352 rows that failed with this error',
    );
    expect(within(table()).getAllByRole('columnheader')).toHaveLength(6);
  });

  it('opens and closes a group’s full error', () => {
    renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    const toggle = within(tableRows()[0]!).getByRole('button', { name: 'Show the full error' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const full = within(table()).getByTestId('failed-group-full-error');
    expect(full.querySelector('pre')?.textContent).toBe(OVERFLOW);
    const hide = within(tableRows()[0]!).getByRole('button', { name: 'Hide the full error' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hide);
    expect(within(table()).queryByTestId('failed-group-full-error')).toBeNull();
  });

  it('support sees no Replay column and no Replay', () => {
    renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay={false} />);
    expect(within(table()).getAllByRole('columnheader')).toHaveLength(5);
    expect(screen.queryAllByTestId('failed-group-replay')).toHaveLength(0);
  });
});

describe('FailedUsageGroups — Replay', () => {
  it('confirms first: names the group and its counts, Cancel focused, nothing sent', async () => {
    renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    fireEvent.click(replayIn(tableRows()[0]!));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Replay 7,352 rows of failed usage?')).toBeTruthy();
    expect(within(dialog).getByText('7,352 rows · 41 organizations')).toBeTruthy();
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(replayFailedUsageAction).not.toHaveBeenCalled();
  });

  it('shows the group busy while it replays, and only that group', async () => {
    let finish!: (value: unknown) => void;
    replayFailedUsageAction.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    await confirmReplay(tableRows()[0]!);

    expect(replayFailedUsageAction).toHaveBeenCalledWith(OVERFLOW);
    const [busy, other] = tableRows();
    expect(busy!.getAttribute('aria-busy')).toBe('true');
    expect(replayIn(busy!).hasAttribute('disabled')).toBe(true);
    expect(replayIn(busy!).textContent).toContain('Replaying…');
    expect(within(busy!).getByText('Replaying 7,352 rows')).toBeTruthy();
    expect(replayIn(other!).hasAttribute('disabled')).toBe(false);

    await act(async () => finish({ ok: true, replay: replayDTO({}) }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('every row recorded: the group stays as Replayed with its result after the re-read drops it', async () => {
    replayFailedUsageAction.mockResolvedValueOnce({ ok: true, replay: replayDTO({}) });
    const view = renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    await confirmReplay(tableRows()[0]!);

    view.rerender(<FailedUsageGroups groups={GROUPS.slice(1)} canReplay />);
    const [replayed] = tableRows();
    expect(replayed!.getAttribute('data-replayed')).toBe('true');
    expect(within(replayed!).getByText('Replayed')).toBeTruthy();
    expect(within(replayed!).queryByTestId('failed-group-replay')).toBeNull();
    const result = within(table()).getByTestId('failed-group-result');
    expect(
      within(result)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Replayed: 7,352 rows recorded.', 'None failed again.']);
  });

  it('failed again under a NEW error: says so, and the new group is listed by size', async () => {
    replayFailedUsageAction.mockResolvedValueOnce({
      ok: true,
      replay: replayDTO({ applied: 7340, failedAgain: 12 }),
    });
    const view = renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    await confirmReplay(tableRows()[0]!);

    view.rerender(
      <FailedUsageGroups groups={[GROUPS[1]!, g(CONFLICT, 12, 3), GROUPS[2]!]} canReplay />,
    );
    const order = tableRows().map((r) => within(r).getAllByRole('cell')[1]!.textContent);
    expect(order).toEqual(['7,352', '18', '12', '3']);
    const lines = within(within(table()).getByTestId('failed-group-result'))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines).toEqual([
      'Replayed: 7,340 rows recorded.',
      '12 rows failed again. They are listed under their new error.',
    ]);
  });

  it('failed again with the SAME error: the group stays live with its new count and its Replay', async () => {
    replayFailedUsageAction.mockResolvedValueOnce({
      ok: true,
      replay: replayDTO({ error: NO_RATE, reset: 18, applied: 14, failedAgain: 4 }),
    });
    const view = renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    await confirmReplay(tableRows()[1]!);

    view.rerender(
      <FailedUsageGroups groups={[GROUPS[0]!, g(NO_RATE, 4, 1), GROUPS[2]!]} canReplay />,
    );
    const row = tableRows()[1]!;
    expect(row.getAttribute('data-replayed')).toBeNull();
    expect(within(row).getAllByRole('cell')[1]!.textContent).toBe('4');
    expect(replayIn(row).getAttribute('aria-label')).toBe(
      'Replay 4 rows that failed with this error',
    );
    expect(within(table()).getByTestId('failed-group-result').textContent).toContain(
      '4 rows failed again. They stay in this group.',
    );
  });

  it('a replay that did not finish keeps the group’s Replay and says what happens next', async () => {
    replayFailedUsageAction.mockResolvedValueOnce({ ok: false, code: 'FAILED' });
    renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    await confirmReplay(tableRows()[2]!);
    const row = tableRows()[2]!;
    expect(replayIn(row).hasAttribute('disabled')).toBe(false);
    expect(within(table()).getByTestId('failed-group-result').textContent).toBe(
      'The replay did not finish. Rows it did not record are still listed here, so replaying again records each of them once.',
    );
  });

  it('an action that throws is the same unfinished line', async () => {
    replayFailedUsageAction.mockRejectedValueOnce(new Error('network'));
    renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    await confirmReplay(tableRows()[0]!);
    expect(within(table()).getByTestId('failed-group-result').textContent).toContain(
      'The replay did not finish.',
    );
  });
});

describe('FailedUsageGroups — order and dismissal', () => {
  it('a replayed group keeps its place among groups of the same size, newest first', async () => {
    replayFailedUsageAction.mockResolvedValueOnce({
      ok: true,
      replay: replayDTO({ error: NO_RATE, reset: 18, applied: 18 }),
    });
    const older = g(CONFLICT, 18, 1, '2026-11-13T00:00:00.000Z');
    const view = renderWithIntl(<FailedUsageGroups groups={[GROUPS[1]!, older]} canReplay />);
    await confirmReplay(tableRows()[0]!);
    view.rerender(<FailedUsageGroups groups={[older]} canReplay />);
    expect(tableRows().map((r) => r.getAttribute('data-replayed'))).toEqual(['true', null]);
  });

  it('Escape closes the confirm without replaying', async () => {
    renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    fireEvent.click(replayIn(tableRows()[0]!));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(replayFailedUsageAction).not.toHaveBeenCalled();
  });
});

describe('FailedUsageGroups — group cards (phone)', () => {
  it('draws each group as a card with its facts, full error and Replay', async () => {
    replayFailedUsageAction.mockResolvedValueOnce({ ok: true, replay: replayDTO({}) });
    renderWithIntl(<FailedUsageGroups groups={GROUPS} canReplay />);
    const list = screen.getByTestId('usage-failed-list');
    const [card] = within(list).getAllByTestId('failed-group-card');
    expect(within(card!).getByText('Organizations').nextElementSibling?.textContent).toBe('41');
    fireEvent.click(within(card!).getByRole('button', { name: 'Show the full error' }));
    expect(card!.querySelector('pre')?.textContent).toBe(OVERFLOW);
    await confirmReplay(card!);
    expect(within(card!).getByRole('status').textContent).toContain(
      'Replayed: 7,352 rows recorded.',
    );
  });
});
