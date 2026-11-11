// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE PUBLISH ROW of a Fleet status image card (MOTIR-10886; design MOTIR-10885
// Panels 4–6): the Confirm dialog, the answer it shows when a press starts
// nothing, and the poll that re-reads the page once a run has ended. The two
// actions are replaced at their module; they have their own suite.

const actions = vi.hoisted(() => ({ publish: vi.fn(), ended: vi.fn() }));
vi.mock('@/app/(admin)/admin/fleet-status/actions', () => ({
  publishFleetImageAction: actions.publish,
  fleetImagePublishEndedAction: actions.ended,
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const { PublishControl, POLL_MS } =
  await import('@/app/(admin)/admin/fleet-status/_components/PublishControl');
type Props = Parameters<typeof PublishControl>[0];

const confirm: NonNullable<Props['confirm']> = {
  title: 'Publish runner-v0.2.6?',
  from: 'runner-v0.2.4 · 4a9cb14',
  to: 'runner-v0.2.6 · c22cba5',
  body: 'This starts the runner pin workflow.',
  confirmLabel: 'Publish latest',
  audited: 'Recorded in the audit log as you, ops@example.test.',
};

function renderControl(over: Partial<Props> = {}) {
  return renderWithIntl(
    <PublishControl
      image="runner"
      mode="enabled"
      note="Pins runner-v0.2.6."
      band={null}
      confirm={confirm}
      poll={null}
      {...over}
    />,
  );
}

beforeEach(() => {
  actions.publish.mockReset();
  actions.ended.mockReset();
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function openDialog(name = 'Publish latest') {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

async function pressConfirm() {
  const buttons = screen.getAllByRole('button', { name: 'Publish latest' });
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1]!);
  });
}

describe('PublishControl', () => {
  it('enabled: the note, and Publish latest opens the confirm with From, To and who is recorded', async () => {
    renderControl();
    expect(screen.getByText('Pins runner-v0.2.6.')).toBeTruthy();
    await openDialog();
    expect(screen.getByRole('dialog', { name: 'Publish runner-v0.2.6?' })).toBeTruthy();
    expect(screen.getByText('runner-v0.2.4 · 4a9cb14')).toBeTruthy();
    expect(screen.getByText('runner-v0.2.6 · c22cba5')).toBeTruthy();
    expect(screen.getByText(confirm.audited)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a dispatch closes the dialog and re-reads the page', async () => {
    actions.publish.mockResolvedValue({ outcome: 'dispatched', runUrl: 'u', runNumber: 1 });
    renderControl();
    await openDialog();
    await pressConfirm();
    expect(actions.publish).toHaveBeenCalledWith('runner');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    [{ outcome: 'refused', reason: 'running' }, 'already going'],
    [{ outcome: 'not_permitted' }, 'Only a superadmin can publish'],
  ] as const)(
    'a press that started nothing keeps the dialog open with why',
    async (result, text) => {
      actions.publish.mockResolvedValue(result);
      renderControl();
      await openDialog();
      await pressConfirm();
      const answer = screen.getByTestId('fleet-publish-answer');
      expect(answer.textContent).toContain("Publish latest didn't start.");
      expect(answer.textContent).toContain(text);
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it('a failed dispatch shows GitHub’s words, and closing clears the answer', async () => {
    actions.publish.mockResolvedValue({ outcome: 'failed', detail: 'HTTP 403: not accessible' });
    renderControl();
    await openDialog();
    await pressConfirm();
    expect(screen.getByTestId('fleet-publish-answer').textContent).toContain(
      'HTTP 403: not accessible',
    );
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    await openDialog();
    expect(screen.queryByTestId('fleet-publish-answer')).toBeNull();
  });

  it('disabled, or with no confirm, cannot open anything', () => {
    renderControl({ mode: 'disabled', confirm: null });
    const button = screen.getByRole('button', { name: 'Publish latest' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('failed: Retry opens the same confirm', async () => {
    renderControl({ mode: 'failed', band: <p>the band</p> });
    expect(screen.getByText('the band')).toBeTruthy();
    await openDialog('Retry');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('running: a loading button, and a poll that re-reads the page once the run has ended', async () => {
    vi.useFakeTimers();
    actions.ended.mockResolvedValueOnce({ ended: false }).mockResolvedValue({ ended: true });
    const { unmount } = renderControl({
      mode: 'running',
      confirm: null,
      poll: { runId: 77, target: 'sha256:9f' },
    });
    expect(screen.getByRole('button', { name: /Publishing/ })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(actions.ended).toHaveBeenCalledWith('runner', 77, 'sha256:9f');
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(actions.ended).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('a poll answer that lands after unmount re-reads nothing', async () => {
    vi.useFakeTimers();
    let resolve: (v: { ended: boolean }) => void = () => undefined;
    actions.ended.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = renderControl({
      mode: 'running',
      confirm: null,
      poll: { runId: 77, target: 'x' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    unmount();
    await act(async () => {
      resolve({ ended: true });
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('running with nothing to follow does not poll', async () => {
    vi.useFakeTimers();
    renderControl({ mode: 'running', confirm: null, poll: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });
    expect(actions.ended).not.toHaveBeenCalled();
  });
});
