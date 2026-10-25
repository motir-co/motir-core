// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { FleetKindSwitchStateDTO } from '@/lib/dto/fleetKindSwitch';

/**
 * The Agent hosting island (MOTIR-9503, design `platform-admin` § Fleet settings
 * · Agent hosting, MOTIR-9534, Panels 1–10). The action is stubbed: its codes
 * have their own suite (`agentHostingAction.test.ts`); here each answer is
 * driven to the state the design draws for it.
 */

const setAgentHostingAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, outcome: 'changed' })),
);
vi.mock('@/app/(admin)/admin/fleet-settings/actions', () => ({ setAgentHostingAction }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { AgentHostingSetting, AgentHostingUnavailable } =
  await import('@/app/(admin)/admin/fleet-settings/_components/AgentHostingSetting');

afterEach(() => {
  cleanup();
  setAgentHostingAction.mockClear();
  refresh.mockClear();
});

const NOW = new Date('2026-10-25T12:00:00.000Z');

const never: FleetKindSwitchStateDTO = {
  onPool: false,
  updatedBy: null,
  updatedAt: null,
  lastReason: null,
};
const onAws: FleetKindSwitchStateDTO = {
  onPool: true,
  updatedBy: { userId: 'u1', email: 'ops@example.test' },
  updatedAt: '2026-10-25T10:00:00.000Z',
  lastReason: 'pool ready',
};

function render(state: FleetKindSwitchStateDTO) {
  return renderWithIntl(<AgentHostingSetting state={state} />, { now: NOW });
}

// `hidden`: an open dialog marks the page behind it aria-hidden.
const theSwitch = () => screen.getByRole('switch', { hidden: true });

async function openConfirm() {
  fireEvent.click(theSwitch());
  return screen.findByRole('alertdialog');
}

async function confirmWith(dialog: HTMLElement, reason: string, button: RegExp) {
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: reason } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: button }));
  });
}

describe('AgentHostingSetting', () => {
  it('never changed ⇒ Fly, the switch off, and the never-changed line', () => {
    render(never);
    expect(theSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('agent-hosting-state').getAttribute('data-state')).toBe('fly');
    expect(screen.getByTestId('agent-hosting-last-changed').textContent).toBe(
      'Never changed — new agents are created on Fly',
    );
    expect(screen.queryByTestId('agent-hosting-on-note')).toBeNull();
  });

  it('ON ⇒ AWS, the on note, and who changed it with the enable audit link', () => {
    render(onAws);
    expect(theSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('agent-hosting-state').getAttribute('data-state')).toBe('aws');
    expect(screen.getByTestId('agent-hosting-on-note')).toBeTruthy();
    const line = screen.getByTestId('agent-hosting-last-changed');
    expect(line.textContent).toContain('by ops@example.test, 2 hours ago — “pool ready”');
    expect(within(line).getByRole('link', { name: 'Audit log' }).getAttribute('href')).toBe(
      '/admin/audit-log?action=fleet.agent_hosting.enable',
    );
  });

  it('flipping on asks to confirm, disabled until a reason is typed, then calls the action', async () => {
    render(never);
    const dialog = await openConfirm();
    expect(within(dialog).getByText('Create new agents on AWS?')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Turn on AWS' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    await confirmWith(dialog, '  pool ready  ', /^Turn on AWS$/);
    expect(setAgentHostingAction).toHaveBeenCalledWith(true, 'pool ready');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('flipping off asks the Fly question and sends false', async () => {
    render(onAws);
    const dialog = await openConfirm();
    expect(within(dialog).getByText('Create new agents on Fly again?')).toBeTruthy();
    await confirmWith(dialog, 'back', /^Turn off AWS$/);
    expect(setAgentHostingAction).toHaveBeenCalledWith(false, 'back');
  });

  it('Cancel closes the dialog and calls nothing', async () => {
    render(never);
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(setAgentHostingAction).not.toHaveBeenCalled();
  });

  it('REASON_REQUIRED keeps the dialog open with the reason-missing error', async () => {
    setAgentHostingAction.mockResolvedValueOnce({ ok: false, code: 'REASON_REQUIRED' });
    render(never);
    const dialog = await openConfirm();
    await confirmWith(dialog, 'x', /^Turn on AWS$/);
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'a reason is required, and it is written to the audit log',
    );
  });

  it('a write that failed keeps the dialog open, with the reason kept and nothing changed', async () => {
    setAgentHostingAction.mockResolvedValueOnce({ ok: false, code: 'FAILED' });
    render(never);
    const dialog = await openConfirm();
    await confirmWith(dialog, 'pool ready', /^Turn on AWS$/);
    const band = within(screen.getByRole('alertdialog')).getByTestId('agent-hosting-write-failed');
    expect(band.textContent).toContain('Not switched to AWS: the change could not be saved.');
    expect(band.textContent).toContain('Nothing changed: new agents are still created on Fly.');
    expect(
      (within(screen.getByRole('alertdialog')).getByLabelText(/Reason/) as HTMLInputElement).value,
    ).toBe('pool ready');
    expect(screen.getByTestId('agent-hosting-state').getAttribute('data-state')).toBe('fly');
  });

  it('unchanged answers "already" on the page, after the dialog closes', async () => {
    setAgentHostingAction.mockResolvedValueOnce({ ok: true, outcome: 'unchanged', onPool: true });
    render(never);
    const dialog = await openConfirm();
    await confirmWith(dialog, 'pool ready', /^Turn on AWS$/);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('agent-hosting-answer').textContent).toContain(
      'Already on AWS — nothing changed.',
    );
  });
});

describe('AgentHostingUnavailable', () => {
  it('draws the error card with Retry and no switch; Retry re-reads the page', async () => {
    renderWithIntl(<AgentHostingUnavailable />);
    expect(screen.getByTestId('agent-hosting-unavailable')).toBeTruthy();
    expect(screen.getByText("Couldn't load agent hosting")).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
