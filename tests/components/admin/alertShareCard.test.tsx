// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { AlertShareCard } from '@/app/(admin)/admin/capacity/_components/AlertShareCard';
import type { CapacityAlertShareActionResult } from '@/app/(admin)/admin/capacity/actions';

/**
 * The ALERT-SHARE CARD (MOTIR-9614, design `platform-admin` AMENDMENT
 * 2026-10-25, Panels 15–16). The action is a fake; its codes are driven to the
 * plain-words lines the design draws.
 */

const setAlertShare = vi.fn<(percent: number) => Promise<CapacityAlertShareActionResult>>();
const onSaved = vi.fn();

beforeEach(() => {
  setAlertShare.mockReset();
  setAlertShare.mockResolvedValue({ ok: true, alertShare: { percent: 90, isDefault: false } });
});

afterEach(() => {
  cleanup();
  onSaved.mockClear();
});

function render(canEdit = true) {
  renderWithIntl(
    <AlertShareCard
      alertShare={{ percent: 80, isDefault: true }}
      canEdit={canEdit}
      setAlertShare={setAlertShare}
      onSaved={onSaved}
    />,
  );
  return screen.getByTestId('capacity-alert-share');
}

function edit(card: HTMLElement, value: string) {
  fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
  fireEvent.change(within(card).getByLabelText('Alert when any one limit reaches'), {
    target: { value },
  });
}

async function save(card: HTMLElement) {
  await act(async () => {
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
  });
}

describe('AlertShareCard', () => {
  it('reads the share, notes it is the default, and the once-a-minute line', () => {
    const card = render();
    expect(within(card).getByTestId('capacity-alert-share-value').textContent).toBe('80 %');
    expect(within(card).getByText('default')).toBeTruthy();
    expect(
      within(card).getByText('Checked once a minute, and each time this page loads.'),
    ).toBeTruthy();
  });

  it('read-only without canEdit: no Edit and no input in the DOM', () => {
    const card = render(false);
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).queryByRole('textbox')).toBeNull();
  });

  it('saves a whole number, shows it with the next-evaluation note, and re-reads', async () => {
    const card = render();
    edit(card, '90');
    await save(card);
    expect(setAlertShare).toHaveBeenCalledWith(90);
    expect(within(card).getByTestId('capacity-alert-share-value').textContent).toBe('90 %');
    expect(within(card).getByRole('status').textContent).toBe(
      'Saved. The next evaluation uses 90 %.',
    );
    expect(within(card).queryByText('default')).toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('refuses a value outside 1–100 inline, keeping it, without a round trip', async () => {
    const card = render();
    edit(card, '120');
    await save(card);
    expect(setAlertShare).not.toHaveBeenCalled();
    const input = within(card).getByLabelText(
      'Alert when any one limit reaches',
    ) as HTMLInputElement;
    expect(input.value).toBe('120');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(within(card).getByRole('alert').textContent).toBe('Enter a whole number from 1 to 100.');
  });

  it.each([
    ['INVALID_VALUE', 'Enter a whole number from 1 to 100.'],
    ['UNCHANGED', 'That is already the alert share. Nothing was changed.'],
    ['NOT_PERMITTED', 'Your role cannot change the alert share, so nothing was saved.'],
    ['FAILED', 'The alert share could not be saved. Nothing was changed; try again.'],
  ] as const)('%s reads in plain words with the typed value kept', async (code, message) => {
    setAlertShare.mockResolvedValue({ ok: false, code });
    const card = render();
    edit(card, '90');
    await save(card);
    expect(within(card).getByRole('alert').textContent).toBe(message);
    expect(
      (within(card).getByLabelText('Alert when any one limit reaches') as HTMLInputElement).value,
    ).toBe('90');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('Cancel puts the stored share back', () => {
    const card = render();
    edit(card, '55');
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).getByTestId('capacity-alert-share-value').textContent).toBe('80 %');
  });
});
