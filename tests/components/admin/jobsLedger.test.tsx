// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import type { JobRunDlqDTO, PlatformDlqListDTO, ReplayAllResultDTO } from '@/lib/dto/jobs';

/**
 * The /admin/jobs page's islands and role-dependent controls (MOTIR-9987,
 * design `platform-admin` AMENDMENT 2026-10-28 § Jobs). The actions are
 * stubbed: their codes and the service refusal behind them have their own
 * real-Postgres suite (`tests/admin/jobsActions.test.ts`).
 */

const replayDeadLetterAction = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<unknown>>(async () => ({ ok: true, outcome: 'replayed' })),
);
const replayAllDeadLettersAction = vi.hoisted(() => vi.fn<(fn: string) => Promise<unknown>>());
vi.mock('@/app/(admin)/admin/jobs/actions', () => ({
  replayDeadLetterAction,
  replayAllDeadLettersAction,
}));
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast }) }));

const { FunctionFilter } = await import('@/app/(admin)/admin/jobs/_components/FunctionFilter');
const { DeadLettersSection } =
  await import('@/app/(admin)/admin/jobs/_components/DeadLettersSection');
const { ReplayAllControl } = await import('@/app/(admin)/admin/jobs/_components/ReplayAllControl');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const NOW = new Date('2026-10-28T12:00:00.000Z');
const METER = 'system.platform-meter-report';
const ROLLUP = 'system.usage-rollup';

function dlq(id: string, over: Partial<JobRunDlqDTO> = {}): JobRunDlqDTO {
  return {
    id,
    workspaceId: null,
    functionId: METER,
    eventName: METER,
    eventData: {},
    failure: { message: 'MOTIR_AI_UNAVAILABLE' },
    attempts: 5,
    firstFailedAt: '2026-10-28T10:00:00.000Z',
    lastFailedAt: '2026-10-28T11:00:00.000Z',
    replayedAt: null,
    ...over,
  } as JobRunDlqDTO;
}

const list: PlatformDlqListDTO = {
  rows: [
    dlq('d1'),
    dlq('d2', { workspaceId: 'ws_tenant', functionId: ROLLUP, eventName: ROLLUP }),
    dlq('d3', { replayedAt: '2026-10-28T11:30:00.000Z' }),
  ],
  functions: [
    { functionId: METER, unreplayed: 109 },
    { functionId: ROLLUP, unreplayed: 55 },
  ],
  unreplayedTotal: 164,
  replayedRecently: 1,
};

const replayButtons = () => screen.queryAllByRole('button', { name: /^Replay .* dead letter$/ });

describe('FunctionFilter', () => {
  it('offers All functions with the total, then only the functions passed in, with their counts', () => {
    renderWithIntl(<FunctionFilter functions={list.functions} total={164} value={null} />);
    const trigger = screen.getByRole('combobox', { name: 'Function' });
    expect(trigger.textContent).toContain('All functions');
    fireEvent.click(trigger);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toHaveLength(3);
    expect(options[0]).toContain('All functions');
    expect(options[0]).toContain('164');
    expect(options[1]).toContain(METER);
    expect(options[1]).toContain('109');
    expect(options[2]).toContain(ROLLUP);
    expect(options[2]).toContain('55');
  });

  it('reads a function the list no longer has as All functions', () => {
    renderWithIntl(
      <FunctionFilter functions={list.functions} total={164} value="system.gone-away" />,
    );
    expect(screen.getByRole('combobox', { name: 'Function' }).textContent).toContain(
      'All functions',
    );
  });

  it('navigates to the chosen function, and back to the plain tab for All functions', () => {
    renderWithIntl(<FunctionFilter functions={list.functions} total={164} value={METER} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Function' }));
    fireEvent.click(screen.getByRole('option', { name: /usage-rollup/ }));
    expect(push).toHaveBeenLastCalledWith(`/admin/jobs?tab=dlq&fn=${encodeURIComponent(ROLLUP)}`);
    fireEvent.click(screen.getByRole('combobox', { name: 'Function' }));
    fireEvent.click(screen.getByRole('option', { name: /All functions/ }));
    expect(push).toHaveBeenLastCalledWith('/admin/jobs?tab=dlq');
  });
});

describe('the Dead letters tab by role', () => {
  it('support: every row, the Read-only notice, no Row Replay and no Replay all', () => {
    renderWithIntl(
      <DeadLettersSection
        list={list}
        fn={METER}
        canReplay={false}
        replayAllCount={null}
        now={NOW}
      />,
      { now: NOW },
    );
    expect(screen.getByRole('note').textContent).toBe(
      'Read-only. Replaying a dead letter needs the operator role.',
    );
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(replayButtons()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Replay all/ })).toBeNull();
    // A replayed row shows its Pill to support too.
    expect(screen.getByText(/^Replayed /)).toBeTruthy();
    // The workspace-less rows are kept and marked.
    expect(screen.getAllByText('No workspace')).toHaveLength(2);
  });

  it('operator on All functions: a Row Replay per waiting row, none on the replayed one, no Replay all', () => {
    renderWithIntl(
      <DeadLettersSection list={list} fn={null} canReplay replayAllCount={null} now={NOW} />,
      { now: NOW },
    );
    expect(screen.queryByRole('note')).toBeNull();
    expect(replayButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      `Replay ${METER} dead letter`,
      `Replay ${ROLLUP} dead letter`,
    ]);
    expect(screen.queryByRole('button', { name: /Replay all/ })).toBeNull();
    expect(screen.getByText('164 waiting · 1 replayed in the last 7 days')).toBeTruthy();
  });

  it('operator with one function chosen: Replay all with its count', () => {
    renderWithIntl(
      <DeadLettersSection list={list} fn={METER} canReplay replayAllCount={109} now={NOW} />,
      { now: NOW },
    );
    expect(screen.getByRole('button', { name: 'Replay all 109' })).toBeTruthy();
    expect(screen.getByText('109 waiting · 1 replayed in the last 7 days')).toBeTruthy();
  });

  it('a Row Replay that fails keeps the row unreplayed with an inline line', async () => {
    replayDeadLetterAction.mockResolvedValueOnce({ ok: false, code: 'FAILED' });
    renderWithIntl(
      <DeadLettersSection list={list} fn={null} canReplay replayAllCount={null} now={NOW} />,
      { now: NOW },
    );
    await act(async () => {
      fireEvent.click(replayButtons()[0]!);
    });
    expect(replayDeadLetterAction).toHaveBeenCalledWith('d1');
    expect(screen.getByText('The replay failed')).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a Row Replay that lands re-reads the page', async () => {
    renderWithIntl(
      <DeadLettersSection list={list} fn={null} canReplay replayAllCount={null} now={NOW} />,
      { now: NOW },
    );
    await act(async () => {
      fireEvent.click(replayButtons()[1]!);
    });
    expect(replayDeadLetterAction).toHaveBeenCalledWith('d2');
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'success', title: 'Dead letter replayed' }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('ReplayAllControl', () => {
  async function openConfirm() {
    renderWithIntl(<ReplayAllControl functionId={METER} count={109} />);
    fireEvent.click(screen.getByRole('button', { name: 'Replay all 109' }));
    return screen.findByRole('alertdialog');
  }

  it('confirms with the count and the function, Cancel first', async () => {
    const dialog = await openConfirm();
    expect(within(dialog).getByText(`Replay 109 dead letters of ${METER}?`)).toBeTruthy();
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons.indexOf('Cancel')).toBeLessThan(buttons.indexOf('Replay 109'));
  });

  it('holds the dialog open while it runs, then shows the counts and re-reads on Done', async () => {
    let finish!: (value: unknown) => void;
    replayAllDeadLettersAction.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const dialog = await openConfirm();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Replay 109' }));
    });
    expect(replayAllDeadLettersAction).toHaveBeenCalledWith(METER);
    expect(within(dialog).getByRole('status').textContent).toBe(
      'Replaying 109 dead letters, 50 at a time. Keep this open until it finishes.',
    );
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    const result: ReplayAllResultDTO = {
      functionId: METER,
      replayed: 104,
      alreadyReplayed: 1,
      failed: ['a', 'b', 'c', 'd'],
    };
    await act(async () => finish({ ok: true, result }));
    const done = screen.getByRole('alertdialog');
    expect(within(done).getByText('Replay finished with failures')).toBeTruthy();
    const lines = within(done)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines).toEqual([
      '104 replayed',
      '1 already replayed by someone else',
      '4 could not be replayed. They stay in the list; replay them one by one.',
    ]);
    fireEvent.click(within(done).getByRole('button', { name: 'Done' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a repeat run that found everything already replayed says so', async () => {
    replayAllDeadLettersAction.mockResolvedValueOnce({
      ok: true,
      result: { functionId: METER, replayed: 0, alreadyReplayed: 108, failed: [] },
    });
    const dialog = await openConfirm();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Replay 109' }));
    });
    const done = screen.getByRole('alertdialog');
    expect(within(done).getByText('Replay finished')).toBeTruthy();
    expect(
      within(done)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['0 replayed — all 108 were already replayed']);
  });
});
