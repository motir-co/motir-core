// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { EditCapacityLimitsDialog } from '@/app/(admin)/admin/capacity/_components/EditCapacityLimitsDialog';
import {
  CAPACITY_VIEW_ROUTE,
  CapacityScreen,
} from '@/app/(admin)/admin/capacity/_components/CapacityScreen';
import type { CapacityLimitsActionResult } from '@/app/(admin)/admin/capacity/actions';
import { CAPACITY_SCREEN_REFRESH_MS } from '@/lib/capacity/screenRefresh';
import type { PlatformCapacityEditInput } from '@/lib/dto/platformCapacity';
import { liveView, qwenEntry } from '../../fixtures/capacityViewFixtures';

/**
 * The EDIT DIALOG (MOTIR-9614, design `platform-admin` AMENDMENT 2026-10-25,
 * Panels 12–14). The action is a fake: each closed result code is driven to the
 * line the design draws for it.
 */

const editLimits =
  vi.fn<
    (
      provider: string,
      model: string,
      edit: PlatformCapacityEditInput,
    ) => Promise<CapacityLimitsActionResult>
  >();
const onSaved = vi.fn();
const onClose = vi.fn();

const STORED = {
  provider: 'qwen' as const,
  model: 'qwen-example-1',
  tierNote: '',
  unknownNote: '',
  planningSharePercent: 40,
  limits: [],
  updatedAt: '2026-10-25T12:01:00.000Z',
};

beforeEach(() => {
  editLimits.mockReset();
  editLimits.mockResolvedValue({ ok: true, entry: STORED });
});

afterEach(() => {
  cleanup();
  onSaved.mockClear();
  onClose.mockClear();
  vi.unstubAllGlobals();
});

function open() {
  renderWithIntl(
    <EditCapacityLimitsDialog
      entry={qwenEntry()}
      editLimits={editLimits}
      onSaved={onSaved}
      onClose={onClose}
    />,
  );
  return screen.getByRole('dialog');
}

const save = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: /^Save$|Saving/ });

async function clickSave(dialog: HTMLElement) {
  await act(async () => {
    fireEvent.click(save(dialog));
  });
}

describe('EditCapacityLimitsDialog', () => {
  it('draws one field per enforced unit and folds the rest', () => {
    const dialog = open();
    expect(within(dialog).getByText('Edit limits · qwen-example-1')).toBeTruthy();
    expect((within(dialog).getByLabelText('Requests / min') as HTMLInputElement).value).toBe('600');
    expect(within(dialog).getByLabelText('Tokens / min')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Concurrency')).toBeNull();
    expect(within(dialog).getByTestId('capacity-not-enforced').textContent).toContain('(4)');
    expect((within(dialog).getByLabelText('Planning share %') as HTMLInputElement).value).toBe(
      '40',
    );
    expect(within(dialog).getByText('0 / 1000')).toBeTruthy();
  });

  it('disables Save while nothing changed', () => {
    const dialog = open();
    expect((save(dialog) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), { target: { value: '700' } });
    expect((save(dialog) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), { target: { value: '600' } });
    expect((save(dialog) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends only the changed keys — an untouched tier note is not sent', async () => {
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), { target: { value: '700' } });
    await clickSave(dialog);
    expect(editLimits).toHaveBeenCalledWith('qwen', 'qwen-example-1', { rpm: 700 });
    expect(onSaved).toHaveBeenCalledWith('qwen-example-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('a ticked Unknown sends null', async () => {
    const dialog = open();
    const field = within(dialog).getByTestId('capacity-edit-rpm');
    fireEvent.click(within(field).getByRole('checkbox', { name: 'Unknown' }));
    await clickSave(dialog);
    expect(editLimits).toHaveBeenCalledWith('qwen', 'qwen-example-1', { rpm: null });
  });

  it('a limit set from Unknown, a share and a tier note are each sent', async () => {
    const dialog = open();
    const tpm = within(dialog).getByTestId('capacity-edit-tpm');
    fireEvent.click(within(tpm).getByRole('checkbox', { name: 'Unknown' }));
    fireEvent.change(within(dialog).getByLabelText('Tokens / min'), {
      target: { value: '1200000' },
    });
    fireEvent.change(within(dialog).getByLabelText('Planning share %'), {
      target: { value: '45' },
    });
    fireEvent.change(within(dialog).getByLabelText('Tier note'), { target: { value: 'Tier 3' } });
    expect(within(dialog).getByText('6 / 1000')).toBeTruthy();
    await clickSave(dialog);
    expect(editLimits).toHaveBeenCalledWith('qwen', 'qwen-example-1', {
      tpm: 1_200_000,
      planningSharePercent: 45,
      tierNote: 'Tier 3',
    });
  });

  it('INVALID_VALUE on rpm: the message under rpm, the typed values kept, the dialog open', async () => {
    editLimits.mockResolvedValue({ ok: false, code: 'INVALID_VALUE', field: 'rpm' });
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), { target: { value: '700' } });
    fireEvent.change(within(dialog).getByLabelText('Tier note'), { target: { value: 'kept' } });
    await clickSave(dialog);
    const rpm = within(dialog).getByLabelText('Requests / min') as HTMLInputElement;
    expect(rpm.value).toBe('700');
    expect(rpm.getAttribute('aria-invalid')).toBe('true');
    const describedBy = rpm.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)!.textContent).toBe(
      'Requests / min must be a whole number of 0 or more.',
    );
    expect((within(dialog).getByLabelText('Tier note') as HTMLTextAreaElement).value).toBe('kept');
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rpm);
  });

  it.each([
    [
      'planning_share_percent',
      'Planning share %',
      'Planning share must be a whole number from 0 to 100.',
    ],
    ['tier_note', 'Tier note', 'The tier note can be at most 1000 characters.'],
  ])('a refused %s lands on its own input', async (field, label, message) => {
    editLimits.mockResolvedValue({ ok: false, code: 'INVALID_VALUE', field });
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), { target: { value: '700' } });
    await clickSave(dialog);
    const input = within(dialog).getByLabelText(label);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe(
      message,
    );
  });

  it('a field the form does not draw falls back to the dialog-level line', async () => {
    editLimits.mockResolvedValue({ ok: false, code: 'INVALID_BODY', field: 'max_concurrency' });
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), { target: { value: '700' } });
    await clickSave(dialog);
    expect(within(dialog).getByTestId('capacity-edit-error').textContent).toBe(
      'The gateway could not read this edit. Nothing was changed.',
    );
  });

  it.each([
    [
      'UNKNOWN_MODEL',
      'This model is no longer in the gateway’s limits table. Nothing was changed; close and refresh.',
    ],
    ['UNKNOWN_PROVIDER', 'The gateway does not know this provider. Nothing was changed.'],
    ['CREDENTIAL', 'The gateway credential is not accepted, so nothing was saved.'],
    ['UNAVAILABLE', 'The gateway did not answer. Nothing was saved; try again.'],
    ['STORE_ERROR', 'The gateway could not save the change. Nothing was changed; try again.'],
    ['NOT_PERMITTED', 'Your role cannot edit limits, so nothing was saved.'],
    ['FAILED', 'The limits could not be saved. Nothing was changed; try again.'],
    ['EMPTY_EDIT', 'The gateway could not read this edit. Nothing was changed.'],
  ] as const)('%s is one dialog-level line', async (code, message) => {
    editLimits.mockResolvedValue({ ok: false, code });
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), { target: { value: '700' } });
    await clickSave(dialog);
    expect(within(dialog).getByTestId('capacity-edit-error').textContent).toBe(message);
    expect((within(dialog).getByLabelText('Requests / min') as HTMLInputElement).value).toBe('700');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a whole number without a round trip', async () => {
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), { target: { value: '-1' } });
    await clickSave(dialog);
    expect(editLimits).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText('Requests / min must be a whole number of 0 or more.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), {
      target: { value: '99999999999999999999' },
    });
    await clickSave(dialog);
    expect(editLimits).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText('Requests / min is larger than the gateway can store.'),
    ).toBeTruthy();
  });
});

describe('a save from the screen', () => {
  it('closes the dialog, says it saved, and re-reads the route', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => liveView() }) as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithIntl(
      <CapacityScreen
        initialView={liveView()}
        refreshMs={CAPACITY_SCREEN_REFRESH_MS}
        editLimits={editLimits}
        setAlertShare={vi.fn()}
      />,
    );
    const entry = screen.getByTestId('capacity-entry-qwen-qwen-example-1');
    fireEvent.click(within(entry).getByRole('button', { name: 'Edit limits' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Requests / min'), { target: { value: '700' } });
    await clickSave(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Limits saved for qwen-example-1.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(CAPACITY_VIEW_ROUTE, { cache: 'no-store' });
  });
});
