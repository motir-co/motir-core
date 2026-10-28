// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import type { PublicSubdomainDto } from '@/lib/dto/publicAddresses';

// THE PROJECT-SETTINGS ECHO (Story MOTIR-4528 · MOTIR-9515) —
// `design/projects/public-address--workspace-echo.mock.html` panels A–C. The
// workspace's address, read-only, with a link to the control in workspace
// settings; the same for every role.

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
}));

import { PublicAddressEcho } from '@/app/(authed)/settings/project/public-address/_components/PublicAddressEcho';

const claimed: PublicSubdomainDto = {
  label: 'acme',
  hostname: 'acme.motir.site',
  url: 'https://acme.motir.site',
  claimedAt: '2026-09-01T00:00:00.000Z',
  nextChangeAllowedAt: null,
};

async function render(subdomain: PublicSubdomainDto | null) {
  const el = await PublicAddressEcho({
    subdomain,
    projectAddress: 'motir.co/p/ROADMAP',
    projectUrl: 'https://motir.co/p/ROADMAP',
  });
  return renderWithIntl(el);
}

afterEach(cleanup);

describe('the workspace address echo', () => {
  it('claimed: the workspace HOST, the project page line, and the way to change it', async () => {
    await render(claimed);
    expect(screen.getByText('Workspace address')).toBeTruthy();
    expect(screen.getByText('acme.motir.site')).toBeTruthy();
    expect(screen.queryByText(/acme\.motir\.site\/ROADMAP/)).toBeNull();
    expect(screen.getByText("This project's public page is at motir.co/p/ROADMAP.")).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Change in workspace settings →' });
    expect(link.getAttribute('href')).toBe('/settings/workspace/public-address');
  });

  it('claimed: Copy and open only — no Live pill, no Rename, no Release, no field', async () => {
    await render(claimed);
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in a new tab' }).getAttribute('href')).toBe(
      'https://acme.motir.site',
    );
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.queryByRole('button', { name: /Rename|Release|Remove/ })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('unclaimed: the project’s motir.co address and the way to claim a name', async () => {
    await render(null);
    expect(screen.getByText('Your workspace has no name yet.')).toBeTruthy();
    expect(screen.getByText('motir.co/p/ROADMAP')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Claim a name for the workspace →' });
    expect(link.getAttribute('href')).toBe('/settings/workspace/public-address');
  });
});
