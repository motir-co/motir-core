// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { FleetStopResultDTO } from '@/lib/dto/platformFleetStop';

/**
 * The STOP CONTAINERS confirmation (MOTIR-7320 · design `tenant--stop-containers.mock.html`
 * S3 e–j, S4 k–n).
 *
 * ⚠️ THE REASON GATE IS ASSERTED FROM THE SIDE THAT CAN FAIL — the click on a
 * blank-reason primary must call nothing — and the server's REASON_REQUIRED is
 * shown inline with the dialog left open. The result is written on the card,
 * one line per workload, with a partial failure named where it fell short.
 */

const previewStopAction = vi.hoisted(() => vi.fn());
const stopContainersAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/(admin)/admin/tenants/[orgId]/actions', () => ({
  previewStopAction,
  stopContainersAction,
}));

const { StopContainersDialog } =
  await import('@/app/(admin)/admin/tenants/[orgId]/_components/StopContainersDialog');

const PREVIEW = {
  ok: true as const,
  preview: { ciRuns: 2, ciContainers: 3, hostedRuns: 0, agentInstances: 2, indexContainers: 1 },
  countedAt: '2026-10-02T14:32:00.000Z',
};

function done(overrides: Partial<FleetStopResultDTO> = {}): FleetStopResultDTO {
  return {
    runsCancelled: 2,
    ciContainersStopped: 3,
    hostedRunsEnded: 1,
    agentInstancesHibernated: 2,
    failures: { ci: 0, hosted: 0, instances: 0 },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  previewStopAction.mockReset();
  stopContainersAction.mockReset();
});

function renderDialog(canStop = true) {
  render(
    <ToastProvider>
      <StopContainersDialog
        orgId="org_1"
        orgName="Acme Corp"
        canStop={canStop}
        footNote={<p id="foot">explainer</p>}
        footNoteId="foot"
      />
    </ToastProvider>,
  );
}

async function openWithPreview() {
  previewStopAction.mockResolvedValue(PREVIEW);
  renderDialog();
  fireEvent.click(screen.getByRole('button', { name: /Stop containers/i }));
  const dialog = await screen.findByRole('alertdialog');
  await within(dialog).findByTestId('stop-effects');
  return dialog;
}

const confirmButton = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: /^Stop containers$/ });

describe('StopContainersDialog', () => {
  it('a disabled control opens nothing and asks for no preview', () => {
    renderDialog(false);
    const button = screen.getByRole('button', { name: /Stop containers/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('foot');
    fireEvent.click(button);
    expect(previewStopAction).not.toHaveBeenCalled();
  });

  it('shows the preview counts — zeros kept — the index line and the not-a-suspension line (S3 e)', async () => {
    const dialog = await openWithPreview();
    expect(previewStopAction).toHaveBeenCalledWith('org_1');
    expect(within(dialog).getByText('Stop Acme Corp’s containers?')).toBeTruthy();
    expect(within(dialog).getByTestId('stop-effect-ci').textContent).toBe(
      '2CI runs cancelled and 3 CI containers destroyed',
    );
    expect(within(dialog).getByTestId('stop-effect-hosted').textContent).toBe(
      '0Motir agent runs ended',
    );
    expect(within(dialog).getByTestId('stop-effect-instances').textContent).toBe(
      '2agent instances hibernated',
    );
    expect(within(dialog).getByTestId('stop-effect-index').textContent).toContain(
      'index container left to finish',
    );
    expect(within(dialog).getByText(/Nothing is blocked: Acme Corp’s next CI run/)).toBeTruthy();
  });

  it('cannot be submitted with a blank or whitespace reason — the click calls nothing (S3 h)', async () => {
    const dialog = await openWithPreview();
    const confirm = confirmButton(dialog);
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);

    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: '   ' } });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    expect(stopContainersAction).not.toHaveBeenCalled();
  });

  it('shows the server’s REASON_REQUIRED inline and keeps the dialog open (S3 i)', async () => {
    stopContainersAction.mockResolvedValue({ ok: false, code: 'REASON_REQUIRED' });
    const dialog = await openWithPreview();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'x' } });
    fireEvent.click(confirmButton(dialog));

    expect(await within(dialog).findByText('Enter a reason. Nothing was stopped.')).toBeTruthy();
    expect(
      within(dialog)
        .getByLabelText(/Reason/)
        .getAttribute('aria-invalid'),
    ).toBe('true');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('submits the TRIMMED reason, closes, and writes the result on the card (S4 k)', async () => {
    stopContainersAction.mockResolvedValue({ ok: true, result: done() });
    const dialog = await openWithPreview();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: '  Running, not debited  ' },
    });
    fireEvent.click(confirmButton(dialog));

    const result = await screen.findByTestId('stop-result');
    expect(stopContainersAction).toHaveBeenCalledWith('org_1', 'Running, not debited');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(result.getAttribute('data-partial')).toBe('false');
    expect(result.textContent).toContain('Containers stopped');
    expect(within(result).getByTestId('stop-result-ci').textContent).toBe(
      '2 CI runs cancelled · 3 CI containers destroyed',
    );
    expect(within(result).getByTestId('stop-result-hosted').textContent).toBe(
      '1 Motir agent run ended',
    );
    expect(within(result).getByTestId('stop-result-instances').textContent).toBe(
      '2 agent instances hibernated',
    );
  });

  it('a partial failure names each workload that fell short (S4 l)', async () => {
    stopContainersAction.mockResolvedValue({
      ok: true,
      result: done({
        ciContainersStopped: 2,
        agentInstancesHibernated: 1,
        failures: { ci: 1, hosted: 0, instances: 1 },
      }),
    });
    const dialog = await openWithPreview();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'leak' } });
    fireEvent.click(confirmButton(dialog));

    const result = await screen.findByTestId('stop-result');
    expect(result.getAttribute('data-partial')).toBe('true');
    expect(result.textContent).toContain('Stopped, with failures');
    expect(within(result).getByTestId('stop-result-ci').textContent).toBe(
      'CI: 2 runs cancelled · 2 of 3 containers destroyed1 could not be stopped — the reconciler will retry.',
    );
    expect(within(result).getByTestId('stop-result-hosted').textContent).toBe(
      'Motir agent runs: 1 ended',
    );
    expect(within(result).getByTestId('stop-result-instances').textContent).toBe(
      'Agent instances: 1 of 2 hibernated1 could not be stopped — the reconciler will retry.',
    );
  });

  it('NOT_PERMITTED closes the dialog and says nothing was stopped (S4 m)', async () => {
    stopContainersAction.mockResolvedValue({ ok: false, code: 'NOT_PERMITTED' });
    const dialog = await openWithPreview();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'leak' } });
    fireEvent.click(confirmButton(dialog));

    expect(await screen.findByText('You can’t stop containers')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByTestId('stop-result')).toBeNull();
  });

  it('FAILED does not claim nothing happened (S4 n)', async () => {
    stopContainersAction.mockResolvedValue({ ok: false, code: 'FAILED' });
    const dialog = await openWithPreview();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'leak' } });
    fireEvent.click(confirmButton(dialog));

    expect(await screen.findByText('Couldn’t finish the stop')).toBeTruthy();
    expect(screen.getByText(/Some containers may have stopped before the error/)).toBeTruthy();
  });

  it('a failed preview REPLACES the primary with Try again, which re-reads (S3 g)', async () => {
    previewStopAction.mockResolvedValueOnce({ ok: false, code: 'FAILED' });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Stop containers/i }));
    const dialog = await screen.findByRole('alertdialog');

    expect(await within(dialog).findByText('Couldn’t count what is running')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Stop containers$/ })).toBeNull();

    previewStopAction.mockResolvedValueOnce(PREVIEW);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByTestId('stop-effects')).toBeTruthy();
    expect(previewStopAction).toHaveBeenCalledTimes(2);
  });

  it('an unreadable CI run count says so instead of drawing a zero', async () => {
    previewStopAction.mockResolvedValue({
      ...PREVIEW,
      preview: { ...PREVIEW.preview, ciRuns: null },
    });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Stop containers/i }));
    const dialog = await screen.findByRole('alertdialog');
    const ci = await within(dialog).findByTestId('stop-effect-ci');
    expect(ci.textContent).toContain('—');
    expect(ci.textContent).toContain('GitHub could not be read');
  });

  // ── MOTIR-7321's coverage top-up ───────────────────────────────────────────

  it('NOT_FOUND closes the dialog with its own error, and writes no result', async () => {
    stopContainersAction.mockResolvedValue({ ok: false, code: 'NOT_FOUND' });
    const dialog = await openWithPreview();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'leak' } });
    fireEvent.click(confirmButton(dialog));

    expect(await screen.findByText('Organization not found')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByTestId('stop-result')).toBeNull();
  });

  it('Cancel closes it, and a preview still in flight is discarded — it never paints the next opening', async () => {
    let stale: (value: typeof PREVIEW) => void = () => undefined;
    previewStopAction
      .mockReturnValueOnce(
        new Promise<typeof PREVIEW>((resolve) => {
          stale = resolve;
        }),
      )
      .mockReturnValueOnce(new Promise(() => undefined));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Stop containers/i }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Reopened: its own preview is still counting when the first one answers.
    fireEvent.click(screen.getByRole('button', { name: /Stop containers/i }));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      stale(PREVIEW);
    });
    expect(within(dialog).queryByTestId('stop-effects')).toBeNull();
    expect(previewStopAction).toHaveBeenCalledTimes(2);
  });

  it('Escape closes it, and reopening asks for a fresh preview', async () => {
    const dialog = await openWithPreview();
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Stop containers/i }));
    expect(
      await within(await screen.findByRole('alertdialog')).findByTestId('stop-effects'),
    ).toBeTruthy();
    expect(previewStopAction).toHaveBeenCalledTimes(2);
  });
});
