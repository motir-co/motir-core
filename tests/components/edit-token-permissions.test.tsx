// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ApiTokensManager } from '@/app/(authed)/settings/account/_components/ApiTokensManager';
import { EditTokenPermissionsModal } from '@/app/(authed)/settings/account/_components/EditTokenPermissionsModal';
import {
  PermissionChangeSummary,
  diffGrant,
} from '@/app/(authed)/settings/account/_components/PermissionChangeSummary';
import type { ApiTokenDto } from '@/app/(authed)/settings/account/_components/apiTokensClient';
import type { TokenScopeOrgDTO } from '@/lib/dto/apiTokens';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { permissionSlug, type PermissionKey } from '@/lib/permissions/catalog';

// The edit-permissions surface on Settings → Account → API tokens (MOTIR-10188,
// design `account-settings--edit-token-permissions.mock.html`). `fetch` is
// stubbed and nothing else is, so the PATCH body is asserted through the real
// `apiTokensClient`. Copy is read from `en.json`, never repeated.

const T = enMessages.settings.apiTokens;
const E = T.edit;
const LABEL = (key: PermissionKey) =>
  (enMessages.permissions as unknown as Record<string, { label: string }>)[permissionSlug(key)]!
    .label;

const GRANT: PermissionKey[] = ['project:browse', 'comment:add', 'work_item:edit'];

function token(over: Partial<ApiTokenDto> = {}): ApiTokenDto {
  return {
    id: 'tok-1',
    label: 'claude-code',
    tokenPrefix: 'motir_pat_Ab',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    project: { id: 'p-1', name: 'Acme Core' },
    workspace: { id: 'ws-1', name: 'Default' },
    organization: { id: 'org-1', name: 'Acme' },
    permissions: GRANT,
    ...over,
  };
}

const ORGS: TokenScopeOrgDTO[] = [
  {
    id: 'org-1',
    name: 'Acme',
    workspaces: [
      {
        id: 'ws-1',
        name: 'Default',
        projects: [
          { id: 'p-1', key: 'ACME', name: 'Acme Core', grantable: [...GRANTABLE_PERMISSIONS] },
        ],
      },
    ],
  },
];

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function openModal(props: Partial<Parameters<typeof EditTokenPermissionsModal>[0]> = {}): {
  onClose: ReturnType<typeof vi.fn>;
  onUpdated: ReturnType<typeof vi.fn>;
  onGone: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onUpdated = vi.fn();
  const onGone = vi.fn();
  renderWithIntl(
    <ToastProvider>
      <EditTokenPermissionsModal
        token={token()}
        conferrable={GRANTABLE_PERMISSIONS}
        onClose={onClose}
        onUpdated={onUpdated}
        onGone={onGone}
        {...props}
      />
    </ToastProvider>,
  );
  return { onClose, onUpdated, onGone };
}

const switchFor = (key: PermissionKey) =>
  screen.getByRole('switch', { name: LABEL(key) }) as HTMLButtonElement;
const saveButton = () => screen.getByRole('button', { name: E.save }) as HTMLButtonElement;
const changes = () => screen.getByRole('status');

describe('diffGrant', () => {
  it('lists added and removed keys in catalogue order, whatever order they were flipped in', () => {
    const { added, removed } = diffGrant(
      ['project:browse', 'work_item:edit'],
      ['page:edit', 'project:browse', 'page:view'],
    );
    expect(added).toEqual(
      GRANTABLE_PERMISSIONS.filter((k) => k === 'page:view' || k === 'page:edit'),
    );
    expect(removed).toEqual(['work_item:edit']);
  });
});

describe('PermissionChangeSummary', () => {
  it('compact drops its own box and label but keeps the lines', () => {
    renderWithIntl(<PermissionChangeSummary added={['page:view']} removed={[]} compact />);
    const status = screen.getByRole('status');
    expect(within(status).queryByText(E.changes.label)).toBeNull();
    expect(within(status).getByText(E.changes.adding)).toBeTruthy();
    expect(within(status).queryByText(E.changes.removing)).toBeNull();
  });

  it('sorts a key outside the grantable catalogue last', () => {
    const { added } = diffGrant(
      [],
      ['not:a_grantable_key' as unknown as PermissionKey, 'project:browse'],
    );
    expect(added).toEqual(['project:browse', 'not:a_grantable_key']);
  });
});

describe('the edit modal', () => {
  it('opens on the current grant with the fixed facts, the same-secret note and nothing to save', () => {
    openModal();
    expect(screen.getByText(E.title)).toBeTruthy();
    expect(screen.getByText('claude-code')).toBeTruthy();
    expect(screen.getByText('motir_pat_Ab…')).toBeTruthy();
    expect(screen.getByText('Default · Acme Core')).toBeTruthy();
    expect(screen.getByText(T.expiresNever)).toBeTruthy();
    expect(screen.getByText(E.sameSecret)).toBeTruthy();
    for (const key of GRANTABLE_PERMISSIONS) {
      expect(switchFor(key).getAttribute('aria-checked')).toBe(
        GRANT.includes(key) ? 'true' : 'false',
      );
    }
    expect(within(changes()).getByText(E.changes.none)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('shows an expiry date and a device credential’s workspace alone', () => {
    openModal({ token: token({ expiresAt: '2027-01-15T00:00:00.000Z', project: null }) });
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.queryByText(T.expiresNever)).toBeNull();
  });

  it('lists changes live and sends exactly the new list', async () => {
    const updated = token({ permissions: ['project:browse', 'comment:add', 'page:view'] });
    fetchMock.mockResolvedValueOnce(json(200, { token: updated }));
    const { onUpdated, onClose } = openModal();

    fireEvent.click(switchFor('page:view'));
    fireEvent.click(switchFor('work_item:edit'));
    expect(within(changes()).getByText(E.changes.adding)).toBeTruthy();
    expect(within(changes()).getByText(LABEL('page:view'))).toBeTruthy();
    expect(within(changes()).getByText(E.changes.removing)).toBeTruthy();
    expect(within(changes()).getByText(LABEL('work_item:edit'))).toBeTruthy();

    fireEvent.click(saveButton());
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(updated));
    expect(onClose).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/me/api-tokens/tok-1');
    expect((init as RequestInit).method).toBe('PATCH');
    const sent = JSON.parse((init as RequestInit).body as string) as { permissions: string[] };
    expect([...sent.permissions].sort()).toEqual(['comment:add', 'page:view', 'project:browse']);
    expect(await screen.findByText(E.updatedTitle)).toBeTruthy();
  });

  it('flipping a switch back clears the change', () => {
    openModal();
    fireEvent.click(switchFor('page:view'));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(switchFor('page:view'));
    expect(saveButton().disabled).toBe(true);
  });

  it('refuses an empty grant before it reaches the server', () => {
    openModal();
    for (const key of GRANT) fireEvent.click(switchFor(key));
    expect(screen.getByText(E.emptyError)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    fireEvent.submit(saveButton().closest('form')!);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens a held key the owner can no longer grant LOCKED and lists it under Removing', () => {
    openModal({ conferrable: ['project:browse', 'comment:add', 'page:view'] });
    expect(switchFor('work_item:edit').getAttribute('aria-checked')).toBe('false');
    expect(within(changes()).getByText(E.changes.removing)).toBeTruthy();
    expect(within(changes()).getByText(LABEL('work_item:edit'))).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });

  it('a refused permission shows the banner, locks that row and keeps the rest', async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, { code: 'API_TOKEN_INVALID_PERMISSION', permissions: ['page:view'] }),
    );
    const { onUpdated } = openModal();
    fireEvent.click(switchFor('page:view'));
    fireEvent.click(switchFor('page:edit'));
    fireEvent.click(saveButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(LABEL('page:view'));
    expect(alert.textContent).toContain('Acme Core');
    expect(switchFor('page:view').getAttribute('aria-checked')).toBe('false');
    expect(switchFor('page:edit').getAttribute('aria-checked')).toBe('true');
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('a token revoked elsewhere shows the gone state, and Close removes the row', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { code: 'API_TOKEN_NOT_FOUND' }));
    const { onGone, onClose } = openModal();
    fireEvent.click(switchFor('page:view'));
    fireEvent.click(saveButton());

    expect(await screen.findByText(E.gone.title)).toBeTruthy();
    fireEvent.click(
      screen
        .getAllByRole('button', { name: E.gone.close })
        .find((b) => b.textContent === E.gone.close)!,
    );
    expect(onGone).toHaveBeenCalledWith('tok-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('a staff-session refusal toasts its own reason and keeps the modal', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { code: 'IMPERSONATION_CREDENTIAL_REFUSED' }));
    const { onClose } = openModal();
    fireEvent.click(switchFor('page:view'));
    fireEvent.click(saveButton());
    expect(await screen.findByText(E.staffUnavailable)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
  });

  it('any other failure toasts the generic error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    openModal();
    fireEvent.click(switchFor('page:view'));
    fireEvent.click(saveButton());
    expect(await screen.findByText(E.errorGeneric)).toBeTruthy();
  });

  it("the dialog's own close works, but not while a save is in flight", async () => {
    let resolve: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (resolve = r)));
    const { onClose } = openModal();
    fireEvent.click(switchFor('page:view'));
    fireEvent.click(saveButton());
    const dialogClose = () =>
      screen.getAllByRole('button', { name: E.gone.close }).find((b) => b.textContent === '')!;
    fireEvent.click(dialogClose());
    expect(onClose).not.toHaveBeenCalled();
    resolve(json(500, {}));
    await screen.findByText(E.errorGeneric);
    fireEvent.click(dialogClose());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Cancel closes without a request', () => {
    const { onClose, onGone } = openModal();
    fireEvent.click(screen.getByRole('button', { name: E.cancel }));
    expect(onClose).toHaveBeenCalled();
    expect(onGone).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the tokens list', () => {
  function renderList(tokens: ApiTokenDto[], staffSession = false) {
    renderWithIntl(
      <ToastProvider>
        <ApiTokensManager
          initialTokens={tokens}
          scopeOrgs={ORGS}
          activeWorkspaceId="ws-1"
          activeProjectId="p-1"
          staffSession={staffSession}
        />
      </ToastProvider>,
    );
  }
  const editButton = (label: string) =>
    screen.getByRole('button', { name: T.editAria.replace('{label}', label) }) as HTMLButtonElement;

  it('puts Edit before Revoke and replaces the row with the updated grant', async () => {
    renderList([token({ permissions: ['project:browse'] })]);
    const cell = editButton('claude-code').closest('td')!;
    const buttons = within(cell).getAllByRole('button');
    expect(buttons[0]!.getAttribute('aria-label')).toBe(
      T.editAria.replace('{label}', 'claude-code'),
    );
    expect(buttons[1]!.getAttribute('aria-label')).toBe(
      T.revokeAria.replace('{label}', 'claude-code'),
    );

    fetchMock.mockResolvedValueOnce(
      json(200, { token: token({ permissions: [...GRANTABLE_PERMISSIONS] }) }),
    );
    fireEvent.click(editButton('claude-code'));
    fireEvent.click(switchFor('page:view'));
    fireEvent.click(saveButton());
    // The row's summary pill now reads the new grant.
    expect(await screen.findByText(T.scopes.summary.full)).toBeTruthy();
    expect(screen.queryByText(E.title)).toBeNull();
  });

  it('removes the row when the token turns out to be gone', async () => {
    renderList([token()]);
    fetchMock.mockResolvedValueOnce(json(404, { code: 'API_TOKEN_NOT_FOUND' }));
    fireEvent.click(editButton('claude-code'));
    fireEvent.click(switchFor('page:view'));
    fireEvent.click(saveButton());
    await screen.findByText(E.gone.title);
    fireEvent.click(
      screen
        .getAllByRole('button', { name: E.gone.close })
        .find((b) => b.textContent === E.gone.close)!,
    );
    await waitFor(() => expect(screen.queryByText('claude-code')).toBeNull());
  });

  it('offers nothing when the bound project is no longer in the tree', () => {
    renderList([token({ project: { id: 'p-gone', name: 'Gone' } })]);
    fireEvent.click(editButton('claude-code'));
    for (const key of GRANTABLE_PERMISSIONS) {
      expect(switchFor(key).getAttribute('aria-checked')).toBe('false');
    }
  });

  it('a CLI sign-in row keeps the pencil, inert, pointing at motir auth refresh', () => {
    renderList([
      token({ id: 'cli', label: 'CLI · box', project: null, permissions: [...CLI_TOKEN_GRANT] }),
    ]);
    const pencil = editButton('CLI · box');
    expect(pencil.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(pencil);
    expect(screen.queryByText(E.title)).toBeNull();
  });

  it('a staff session disables every pencil', () => {
    renderList([token()], true);
    const pencil = editButton('claude-code');
    expect(pencil.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(pencil);
    expect(screen.queryByText(E.title)).toBeNull();
  });
});
