// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  PlanRestartDialog,
  type PlanRestartDialogProps,
} from '@/components/planning/PlanRestartDialog';

// THE PLAN SOMETHING NEW DIALOG on its own (MOTIR-11261; design MOTIR-11260,
// `planning-workspace--plan-something-new--modal.mock.html`). The rail's wiring —
// opening it, the restart, focus — is `plan-change-rail-restart.test.tsx`; this
// pins the presentational panels: the plain question, the two plan lines, the
// in-flight state that nothing dismisses, and the failure with *Try again*.

const onKeepPlanning = vi.fn();
const onConfirm = vi.fn();

function renderDialog(
  props: Partial<PlanRestartDialogProps> = {},
  opts: { messages?: Record<string, unknown> } = {},
) {
  return renderWithIntl(
    <PlanRestartDialog
      open
      plan={null}
      confirming={false}
      failed={false}
      onKeepPlanning={onKeepPlanning}
      onConfirm={onConfirm}
      {...props}
    />,
    opts.messages ? { messages: opts.messages, locale: 'zh' } : {},
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the question (panel 2)', () => {
  it('is an alertdialog titled and described by the catalogue, with the safe answer first', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: 'Start something new?' });
    expect(dialog.textContent).toContain(
      'This closes the current planning session and gives its work items back.',
    );
    const buttons = within(dialog)
      .getAllByRole('button')
      .filter((b) => b.dataset['testid']?.startsWith('planning-restart-'));
    expect(buttons.map((b) => b.dataset['testid'])).toEqual([
      'planning-restart-keep',
      'planning-restart-confirm',
    ]);
    expect(buttons[0]!.textContent).toBe('Keep planning');
    expect(buttons[1]!.textContent).toContain('Start something new');
    expect(screen.queryByTestId('planning-restart-dialog-plan')).toBeNull();
    expect(screen.queryByTestId('planning-restart-dialog-error')).toBeNull();
  });

  it('renders nothing while closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Keep planning and Start something new each call their handler', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('planning-restart-keep'));
    expect(onKeepPlanning).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('planning-restart-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Escape and the close control are Keep planning', () => {
    renderDialog();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onKeepPlanning).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onKeepPlanning).toHaveBeenCalledTimes(2);
  });
});

describe('the plan line (panels 3 and 3b)', () => {
  it('names a plan being written, and is part of the description', () => {
    renderDialog({ plan: 'writing' });
    const line = screen.getByTestId('planning-restart-dialog-plan');
    expect(line.getAttribute('data-plan')).toBe('writing');
    expect(line.textContent).toBe(
      'Motir AI is writing a plan in this session. It stops, and what it has written so far is discarded.',
    );
    const describedBy = screen.getByRole('alertdialog').getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toContain(line.id);
  });

  it('names a plan waiting for review', () => {
    renderDialog({ plan: 'waiting' });
    const line = screen.getByTestId('planning-restart-dialog-plan');
    expect(line.getAttribute('data-plan')).toBe('waiting');
    expect(line.textContent).toBe(
      'The plan waiting for your review stays. Open the earlier session to keep working on it.',
    );
  });
});

describe('in flight (panel 4)', () => {
  it('disables Keep planning, marks the body busy, and nothing dismisses it', () => {
    renderDialog({ plan: 'writing', confirming: true, failed: true });
    const dialog = screen.getByRole('alertdialog');
    expect(
      (within(dialog).getByTestId('planning-restart-keep') as HTMLButtonElement).disabled,
    ).toBe(true);
    const confirm = within(dialog).getByTestId('planning-restart-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    // The plan line and an earlier error clear while the retry runs.
    expect(screen.queryByTestId('planning-restart-dialog-plan')).toBeNull();
    expect(screen.queryByTestId('planning-restart-dialog-error')).toBeNull();
    expect(confirm.textContent).toContain('Start something new');
    expect(dialog.querySelector('[aria-busy="true"]')).toBeTruthy();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onKeepPlanning).not.toHaveBeenCalled();
  });
});

describe('the failure (panel 7)', () => {
  it('shows the error line as an alert and turns the confirm into Try again', () => {
    renderDialog({ failed: true });
    const error = screen.getByTestId('planning-restart-dialog-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe(
      'Something new could not be started. Nothing has changed: try again, or keep planning.',
    );
    const retry = screen.getByTestId('planning-restart-confirm');
    expect(retry.textContent).toContain('Try again');
    fireEvent.click(retry);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('focus on close', () => {
  it('hands the close to the caller', async () => {
    const onCloseAutoFocus = vi.fn((e: Event) => e.preventDefault());
    const view = renderDialog({ onCloseAutoFocus });
    view.rerender(
      <PlanRestartDialog
        open={false}
        plan={null}
        confirming={false}
        failed={false}
        onKeepPlanning={onKeepPlanning}
        onConfirm={onConfirm}
        onCloseAutoFocus={onCloseAutoFocus}
      />,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledTimes(1));
  });
});

describe('zh', () => {
  it('reads the zh catalogue', () => {
    renderDialog({ plan: 'writing', failed: true }, { messages: zhMessages });
    const dialog = screen.getByRole('alertdialog', { name: '开始新的规划？' });
    expect(dialog.textContent).toContain('Motir AI 正在这个会话中编写计划。');
    expect(within(dialog).getByTestId('planning-restart-confirm').textContent).toContain('重试');
    expect(within(dialog).getByTestId('planning-restart-keep').textContent).toBe('继续规划');
  });
});
