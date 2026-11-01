// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import axe from 'axe-core';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DeviceApproval } from '@/app/(auth)/device/_components/DeviceApproval';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import type { DeviceGrantDescriptionDTO } from '@/lib/dto/cliDevice';

// The `/device` page for a `motir auth refresh` code (MOTIR-10189), built to the
// approved design `account-settings--edit-token-permissions.mock.html` Panels
// 10–13: the same island and the same flow as a login, with the token that
// changes named instead of a terminal connecting, the workspace a fact rather
// than a picker, and the changes listed against the CLI's current set.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/** A sign-in minted before the CLI needed `page:edit`. */
const STALE = CLI_TOKEN_GRANT.filter((k) => k !== 'page:edit');

const GRANT: DeviceGrantDescriptionDTO = {
  userCode: 'K4TP9RXM',
  status: 'pending',
  hostname: 'yue-mbp',
  askedAt: '2026-07-30T12:00:00.000Z',
  expiresAt: '2026-07-30T12:15:00.000Z',
  permissions: [...CLI_TOKEN_GRANT],
  clientId: 'motir-cli',
  update: {
    label: 'CLI · yue-mbp',
    tokenPrefix: 'motir_pat_r8',
    workspaceName: 'moooon · Motir',
    expiresAt: '2026-10-28T12:00:00.000Z',
    permissions: STALE,
  },
};

const USER = { name: 'Zhu Yue', email: 'zhuyue11@gmail.com', image: null };
const WORKSPACES = [{ id: 'ws-1', label: 'moooon · Motir' }];

function stubFetch(...responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = responses.shift() ?? { status: 500 };
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.body ?? {},
      } as Response;
    }),
  );
  return calls;
}

async function reachConfirm(
  grant: Partial<DeviceGrantDescriptionDTO> = {},
  ...rest: Array<{ status: number; body?: unknown }>
) {
  const calls = stubFetch({ status: 200, body: { ...GRANT, ...grant } }, ...rest);
  renderWithIntl(
    <DeviceApproval
      initialUserCode="K4TP-9RXM"
      user={USER}
      workspaces={WORKSPACES}
      activeWorkspaceId="ws-1"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Update this terminal’s permissions?' });
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/device — confirm an update (Panel 10)', () => {
  it('names the token, its fixed workspace and expiry, and only what changes', async () => {
    await reachConfirm();

    expect(screen.getByText('Check the token and the changes before you approve.')).toBeTruthy();
    expect(screen.getByText('CLI · yue-mbp')).toBeTruthy();
    expect(screen.getByText('motir_pat_r8…')).toBeTruthy();
    expect(screen.getByText(/same secret, nothing to copy/)).toBeTruthy();
    // The workspace is a fact: no picker for a token that already has one.
    expect(screen.getByText('moooon · Motir')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('The token’s workspace. It doesn’t change.')).toBeTruthy();
    expect(screen.getByText('Unchanged by this update.')).toBeTruthy();

    // Changes: the one key the token lacks, and a count of the rest.
    expect(screen.getByText(/Edit pages/i)).toBeTruthy();
    expect(screen.getByText(`${STALE.length} other permissions stay as they are.`)).toBeTruthy();
  });

  it('warns with the refresh command and the host that asked', async () => {
    await reachConfirm();
    const warning = screen.getByText(/If someone sent you this code/);
    expect(warning.textContent).toContain('motir auth refresh');
    expect(warning.textContent).toContain('yue-mbp');
  });

  it('falls back to the token label in the warning when the terminal reported no host', async () => {
    await reachConfirm({ hostname: null });
    expect(screen.getByText(/If someone sent you this code/).textContent).toContain(
      'CLI · yue-mbp',
    );
  });

  it('omits the expiry block for a token that never expires', async () => {
    await reachConfirm({ update: { ...GRANT.update!, expiresAt: null } });
    expect(screen.queryByText('Unchanged by this update.')).toBeNull();
  });

  it('is clean under axe', async () => {
    await reachConfirm();
    const main = document.createElement('main');
    main.append(...Array.from(document.body.childNodes));
    document.body.appendChild(main);
    const result = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  }, 30_000);
});

describe('/device — the update’s outcomes (Panels 11–13)', () => {
  it('approves with NO workspace, then says the token keeps its secret', async () => {
    const calls = await reachConfirm({}, { status: 200, body: { ok: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve update' }));

    await screen.findByRole('heading', { name: 'Permissions updated' });
    // What was applied, listed once more beside the result.
    expect(screen.getByText(/Edit pages/i)).toBeTruthy();
    expect(calls[1]?.url).toBe('/api/cli/device/approve');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ userCode: 'K4TP9RXM' });
    expect(
      screen.getByText(/now has the CLI’s current permissions and keeps its token/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View tokens' }).getAttribute('href')).toBe(
      '/settings/account/tokens',
    );
  });

  it('a refused update (422) lands on the denied screen: nothing changed', async () => {
    await reachConfirm({}, { status: 422, body: { code: 'DEVICE_UPDATE_REFUSED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve update' }));

    await screen.findByRole('heading', { name: 'Request denied' });
    expect(screen.getByText(/keeps the permissions it had/)).toBeTruthy();
  });

  it('a deny says nothing changed and how to get a fresh code', async () => {
    await reachConfirm({}, { status: 200, body: { success: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await screen.findByRole('heading', { name: 'Request denied' });
    expect(screen.getByText(/keeps the permissions it had/)).toBeTruthy();
    expect(screen.getByText(/Denied it by mistake\?/).textContent).toContain('motir auth refresh');
    fireEvent.click(screen.getByRole('button', { name: 'Enter another code' }));
    expect(screen.getByRole('heading', { name: 'Connect the Motir CLI' })).toBeTruthy();
  });

  it('an expiry mid-approval shows the refresh’s own expired copy', async () => {
    await reachConfirm({}, { status: 410, body: { code: 'DEVICE_GRANT_EXPIRED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve update' }));

    await screen.findByRole('heading', { name: 'That code has expired' });
    expect(screen.getByText(/nothing was changed/).textContent).toContain('motir auth refresh');
    expect(screen.getByText(/reports that the code expired/)).toBeTruthy();
  });

  it('re-reading an already-approved update shows the result without a stale diff', async () => {
    stubFetch({ status: 200, body: { ...GRANT, status: 'approved' } });
    renderWithIntl(
      <DeviceApproval
        initialUserCode="K4TP-9RXM"
        user={USER}
        workspaces={WORKSPACES}
        activeWorkspaceId="ws-1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'Permissions updated' });
    // The token already holds the CLI set by now, so there is no diff to list.
    expect(screen.queryByText(/Edit pages/i)).toBeNull();
  });
});
