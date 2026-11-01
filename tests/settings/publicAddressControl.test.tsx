// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PublicAddressControl } from '@/app/(authed)/settings/workspace/public-address/_components/PublicAddressControl';
import type { PublicSubdomainDto, SubdomainChangePreviewDto } from '@/lib/dto/publicAddresses';

// THE WORKSPACE ADDRESS CONTROL (Story MOTIR-4528 · MOTIR-9514), rendered —
// `design/workspace-address/workspace-address.mock.html` panels 1–12.
//
// The dated confirm is the point of the control: the return date a customer
// reads must be the preview route's, so every dialog assertion below drives the
// preview fetch and reads the date it returned.

const refreshMock = vi.fn();
vi.mock('next/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/navigation')>();
  return { ...actual, useRouter: () => ({ refresh: refreshMock, push: vi.fn() }) };
});

const toastMock = vi.fn();
vi.mock('@/components/ui/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/Toast')>();
  return { ...actual, useToast: () => ({ toast: toastMock }) };
});

const claimed: PublicSubdomainDto = {
  label: 'acme',
  hostname: 'acme.motir.site',
  url: 'https://acme.motir.site',
  claimedAt: '2026-09-01T00:00:00.000Z',
  nextChangeAllowedAt: null,
};

const quarantinePreview: SubdomainChangePreviewDto = {
  host: 'acme.motir.site',
  outcome: 'quarantine',
  returnsAt: '2027-01-26T09:00:00.000Z',
  changeAllowed: true,
  nextChangeAllowedAt: null,
};

function render(
  opts: { subdomain?: PublicSubdomainDto | null; canManage?: boolean; loadFailed?: boolean } = {},
) {
  return renderWithIntl(
    <PublicAddressControl
      workspaceId="ws_1"
      baseDomain="motir.site"
      subdomain={opts.subdomain === undefined ? null : opts.subdomain}
      canManage={opts.canManage ?? true}
      loadFailed={opts.loadFailed}
    />,
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refreshMock.mockReset();
  toastMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('unclaimed — the field (panels 1, 2)', () => {
  it('shows the suffix and a LIVE preview of the host as typed', () => {
    render();
    expect(screen.getByText('.motir.site')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'acme' } });
    expect(screen.getByText('Readers will find you at acme.motir.site')).toBeTruthy();
  });

  it('disables Claim while the field is empty or refused, with each grammar refusal in its own words', () => {
    render();
    const claim = screen.getByRole('button', { name: 'Claim name' });
    expect(claim).toHaveProperty('disabled', true);

    const field = screen.getByLabelText('Name');
    fireEvent.change(field, { target: { value: 'ac' } });
    expect(screen.getByText('Use at least 3 characters.')).toBeTruthy();
    expect(claim).toHaveProperty('disabled', true);

    fireEvent.change(field, { target: { value: 'acme_inc' } });
    expect(screen.getByText('Use only lowercase letters, digits and hyphens.')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'acme--inc' } });
    expect(screen.getByText(/two hyphens in a row/)).toBeTruthy();

    fireEvent.change(field, { target: { value: 'a'.repeat(31) } });
    expect(screen.getByText('Use 30 characters or fewer.')).toBeTruthy();
    expect(claim).toHaveProperty('disabled', true);

    fireEvent.change(field, { target: { value: 'acme' } });
    expect(claim).toHaveProperty('disabled', false);
  });

  it('claims with PUT, toasts and refreshes from the server', async () => {
    fetchMock.mockResolvedValueOnce(json(201, claimed));
    render();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Claim name' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/workspaces/ws_1/public-subdomain');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ label: 'acme' });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'success', title: 'acme.motir.site is yours' }),
    );
  });

  it('puts a quarantined refusal on the field WITH its return date, mapped from the code', async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, {
        error: 'English the pane must never render',
        code: 'NAME_QUARANTINED',
        hostname: 'globex.motir.site',
        returnsAt: '2027-01-26T09:00:00.000Z',
      }),
    );
    render();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'globex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Claim name' }));

    expect(
      await screen.findByText(
        'globex.motir.site was released recently and is held until January 26, 2027. Anyone can claim it from then.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/English the pane must never render/)).toBeNull();
    // The field keeps its text — the control is back where it was.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('globex');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('maps reserved and taken refusals to their own copy', async () => {
    fetchMock.mockResolvedValueOnce(json(422, { code: 'RESERVED_LABEL', refusal: 'reserved' }));
    render();
    const field = screen.getByLabelText('Name');
    fireEvent.change(field, { target: { value: 'wwww' } });
    fireEvent.click(screen.getByRole('button', { name: 'Claim name' }));
    expect(await screen.findByText('“wwww” is reserved. Choose another name.')).toBeTruthy();

    fetchMock.mockResolvedValueOnce(
      json(409, { code: 'HOSTNAME_TAKEN', hostname: 'globex.motir.site' }),
    );
    fireEvent.change(field, { target: { value: 'globex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Claim name' }));
    expect(await screen.findByText('globex.motir.site is taken. Try another name.')).toBeTruthy();
  });
});

describe('claimed — one row, no aliases, no counter (panel 3)', () => {
  it('shows exactly one address row with host, Live, copy and open', () => {
    render({ subdomain: claimed });
    expect(screen.getAllByText('acme.motir.site')).toHaveLength(1);
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in a new tab' }).getAttribute('href')).toBe(
      'https://acme.motir.site',
    );
    expect(screen.queryByText(/Redirects/)).toBeNull();
    expect(screen.queryByText(/renames? left/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Release' })).toHaveProperty('disabled', false);
  });

  it('disables Rename and Release under the 30-day lock and states the date', () => {
    render({ subdomain: { ...claimed, nextChangeAllowedAt: '2026-11-27T09:00:00.000Z' } });
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Release' })).toHaveProperty('disabled', true);
    expect(screen.getByTestId('address-lock').textContent).toBe(
      'You can change the name again on November 27, 2026. A rename and a release each count as one change, once every 30 days.',
    );
  });

  it('renders every address and NO control for a reader who cannot manage (panel 9)', () => {
    render({ subdomain: claimed, canManage: false });
    expect(screen.getByText('Only workspace owners and admins can change this.')).toBeTruthy();
    expect(screen.getByText('acme.motir.site')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeTruthy();
  });

  it('offers no field and no Claim to a reader who cannot manage an unclaimed workspace', () => {
    render({ canManage: false });
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Claim name' })).toBeNull();
    expect(screen.getByText('No name claimed yet.')).toBeTruthy();
  });
});

describe('the dated confirm (panels 5–7)', () => {
  async function openRename(newLabel: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText('New name');
    expect((field as HTMLInputElement).value).toBe('acme');
    fireEvent.change(field, { target: { value: newLabel } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  }

  it('opens only after the preview resolves, and shows the preview’s return date', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolve = r)));
    render({ subdomain: claimed });
    await openRename('acme-labs');

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/workspaces/ws_1/public-subdomain/preview');
    // Not open while the preview is in flight.
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await act(async () => resolve(json(200, quarantinePreview)));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Rename to acme-labs.motir.site?');
    expect(dialog.textContent).toContain('acme.motir.site stops answering now.');
    expect(dialog.textContent).toContain('Anyone can claim it from January 26, 2027.');
    expect(dialog.textContent).toContain('Nothing redirects from the old address to the new one');
  });

  it('says the name returns at once for a `return_now` preview, with no date', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { ...quarantinePreview, outcome: 'return_now', returnsAt: null }),
    );
    render({ subdomain: claimed });
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Release acme.motir.site?');
    expect(dialog.textContent).toContain(
      'Anyone can claim it right away — you held it for less than 24 hours.',
    );
    expect(dialog.textContent).not.toContain('Anyone can claim it from');
  });

  it('confirming a rename sends PUT with the new label, toasts and refreshes', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, quarantinePreview))
      .mockResolvedValueOnce(
        json(200, { ...claimed, label: 'acme-labs', hostname: 'acme-labs.motir.site' }),
      );
    render({ subdomain: claimed });
    await openRename('acme-labs');
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ label: 'acme-labs' });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Renamed to acme-labs.motir.site',
        description: 'acme.motir.site no longer answers.',
      }),
    );
  });

  it('confirming a release sends DELETE and leaves a notice with the return date', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, quarantinePreview))
      .mockResolvedValueOnce(json(200, { returnsAt: '2027-01-26T09:00:00.000Z' }));
    const view = render({ subdomain: claimed });
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Release name' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[1]![1].method).toBe('DELETE');

    // The refreshed page hands down `subdomain: null`.
    view.rerender(
      <PublicAddressControl
        workspaceId="ws_1"
        baseDomain="motir.site"
        subdomain={null}
        canManage
      />,
    );
    expect(
      screen.getByText(
        'acme.motir.site was released. It is held until January 26, 2027, then anyone can claim it.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/the next change is allowed on/)).toBeTruthy();
    // The field never keeps the released label.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toMatch(/for ever|forever/i);
  });

  it('a change-limit refusal closes the dialog and toasts the next-change date', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, quarantinePreview))
      .mockResolvedValueOnce(
        json(409, { code: 'SUBDOMAIN_CHANGE_LIMIT', nextAllowedAt: '2026-11-27T09:00:00.000Z' }),
      );
    render({ subdomain: claimed });
    await openRename('acme-labs');
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'error',
          title: 'Name not changed',
          description: 'You can change it again on November 27, 2026.',
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // Back in its prior state: the rename editor, with the typed name.
    expect((screen.getByLabelText('New name') as HTMLInputElement).value).toBe('acme-labs');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('a failed preview shows the load error with a retry, never an undated dialog', async () => {
    fetchMock
      .mockResolvedValueOnce(json(500, {}))
      .mockResolvedValueOnce(json(200, quarantinePreview));
    render({ subdomain: claimed });
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));

    expect(await screen.findByText('The address couldn’t be loaded.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('load error (panel 11)', () => {
  it('renders the error and its retry re-requests the data', () => {
    render({ loadFailed: true });
    expect(screen.getByText('The address couldn’t be loaded.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});
