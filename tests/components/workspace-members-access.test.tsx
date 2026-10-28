// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { MemberRoleContextDTO, WorkspaceMemberWithAccessDTO } from '@/lib/dto/workspaces';

// The workspace Members page's ACCESS column and the invite's access choice
// (Story MOTIR-6169 · MOTIR-6551 ·
// `design/workspaces/workspace-roles--access-scope.mock.html` W1–W9). The server
// actions and the invite POST are the seams mocked; everything else is the real
// card.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const setMemberAccessScopeAction = vi.fn();
const listMemberAddedProjectsAction = vi.fn();
vi.mock('@/app/(authed)/settings/workspace/actions', () => ({
  resendInviteAction: vi.fn(async () => ({ ok: true })),
  setMemberRoleAction: vi.fn(async () => ({ ok: true })),
  removeMemberAction: vi.fn(async () => ({ ok: true })),
  setMemberAccessScopeAction: (...a: unknown[]) => setMemberAccessScopeAction(...a),
  listMemberAddedProjectsAction: (...a: unknown[]) => listMemberAddedProjectsAction(...a),
  openProjectAccessAction: vi.fn(async () => undefined),
}));

import { MembersCard } from '@/app/(authed)/settings/workspace/_components/MembersCard';

const ME = 'u-me';
const m = (
  userId: string,
  name: string,
  over: Partial<WorkspaceMemberWithAccessDTO> = {},
): WorkspaceMemberWithAccessDTO => ({
  userId,
  name,
  email: `${userId}@motir.co`,
  workspaceRole: 'member',
  customRole: null,
  accessScope: 'full',
  addedProjectCount: 0,
  ...over,
});

const members: WorkspaceMemberWithAccessDTO[] = [
  m(ME, 'Zhu Yue', { workspaceRole: 'manager' }),
  m('u-ada', 'Ada', { workspaceRole: 'member' }),
  m('u-cy', 'Cy Contractor', { accessScope: 'limited', addedProjectCount: 2 }),
  m('u-nia', 'Nia', { accessScope: 'limited', addedProjectCount: 0 }),
  m('u-oz', 'Oz OrgAdmin', { workspaceRole: 'member' }),
];

function context(overrides: Partial<MemberRoleContextDTO> = {}): MemberRoleContextDTO {
  return {
    canManageRoles: true,
    canInvite: true,
    inviteProjects: [
      { id: 'p-a', name: 'Alpha', identifier: 'ALP' },
      { id: 'p-b', name: 'Beta', identifier: 'BET' },
    ],
    orgManagedUserIds: ['u-oz'],
    organizationName: 'moooon',
    customRoles: [],
    ...overrides,
  };
}

function renderCard(roleContext: MemberRoleContextDTO = context()) {
  return render(
    <ToastProvider>
      <MembersCard
        workspaceId="ws1"
        workspaceName="Sales"
        members={members}
        currentUserId={ME}
        roleContext={roleContext}
      />
    </ToastProvider>,
  );
}

const accessPicker = (name: string) =>
  screen.queryByRole('combobox', { name: `Access for ${name}` });
const rowOf = (name: string) => screen.getByText(name).closest('li')!;

const fetchMock = vi.fn();
beforeEach(() => {
  setMemberAccessScopeAction.mockReset().mockResolvedValue({ ok: true });
  listMemberAddedProjectsAction.mockReset();
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the Access column, as a Manager (W1 / W2 / W4 / W5)', () => {
  it('adds an Access column; a Member row carries a Full / Limited picker', () => {
    renderCard();
    expect(screen.getByText('Access')).toBeTruthy();
    expect(accessPicker('Ada')?.textContent).toContain('Full');
    expect(accessPicker('Cy Contractor')?.textContent).toContain('Limited');
  });

  it('switching a Member to Limited calls the action and the row shows Limited at once', async () => {
    renderCard();
    fireEvent.click(accessPicker('Ada')!);
    fireEvent.click(await screen.findByRole('option', { name: /Limited/ }));
    await waitFor(() =>
      expect(setMemberAccessScopeAction).toHaveBeenCalledWith('u-ada', 'limited'),
    );
    expect(accessPicker('Ada')?.textContent).toContain('Limited');
    // Limited and added to nothing: the warning chip and its help line.
    expect(within(rowOf('Ada')).getByText('No projects')).toBeTruthy();
    expect(
      within(rowOf('Ada')).getByText(
        'Limited and added to no project — Ada can’t open anything in Sales yet.',
      ),
    ).toBeTruthy();
  });

  it('a refusal reverts the cell and says why (SCOPE_NOT_APPLICABLE)', async () => {
    setMemberAccessScopeAction.mockResolvedValue({
      ok: false,
      code: 'SCOPE_NOT_APPLICABLE',
      error: 'x',
    });
    renderCard();
    fireEvent.click(accessPicker('Ada')!);
    fireEvent.click(await screen.findByRole('option', { name: /Limited/ }));
    expect(
      await screen.findByText(
        'Ada was just made a Manager, and Managers open every project. Their access stays Full.',
      ),
    ).toBeTruthy();
    expect(accessPicker('Ada')?.textContent).toContain('Full');
  });

  it('a Manager row and an org Admin row are LOCKED at "Full · Manager", with the reason', () => {
    renderCard();
    for (const name of ['Zhu Yue', 'Oz OrgAdmin']) {
      expect(accessPicker(name)).toBeNull();
      const chip = within(rowOf(name)).getByLabelText(
        /^Full · Manager: Managers open every project/,
      );
      expect(chip.getAttribute('tabindex')).toBe('0');
    }
  });

  it('a Limited row with no projects shows the 0-projects warning; one with some shows the count', () => {
    renderCard();
    expect(within(rowOf('Nia')).getByText('No projects')).toBeTruthy();
    expect(within(rowOf('Cy Contractor')).getByRole('button', { name: '2 projects' })).toBeTruthy();
    expect(within(rowOf('Cy Contractor')).queryByText('No projects')).toBeNull();
  });

  it('"N projects" reads the list when it opens, and names each project (W3)', async () => {
    listMemberAddedProjectsAction.mockResolvedValue({
      ok: true,
      projects: [
        { id: 'p-a', name: 'Alpha', identifier: 'ALP' },
        { id: 'p-b', name: 'Beta', identifier: 'BET' },
      ],
    });
    renderCard();
    expect(listMemberAddedProjectsAction).not.toHaveBeenCalled();
    fireEvent.click(within(rowOf('Cy Contractor')).getByRole('button', { name: '2 projects' }));
    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(screen.getByText('BET')).toBeTruthy();
    expect(listMemberAddedProjectsAction).toHaveBeenCalledWith('u-cy');
    expect(
      screen.getByText('Add or remove Cy Contractor on each project’s Access & members page.'),
    ).toBeTruthy();
  });
});

describe('read-only, as a non-Manager (W6)', () => {
  it('every Access cell is text, and the count still opens', async () => {
    listMemberAddedProjectsAction.mockResolvedValue({ ok: true, projects: [] });
    renderCard(context({ canManageRoles: false, inviteProjects: [] }));
    expect(accessPicker('Ada')).toBeNull();
    expect(within(rowOf('Ada')).getByLabelText('Access for Ada: Full')).toBeTruthy();
    expect(screen.getByText('Only a workspace Manager can change roles and access.')).toBeTruthy();
    fireEvent.click(within(rowOf('Cy Contractor')).getByRole('button', { name: '2 projects' }));
    await waitFor(() => expect(listMemberAddedProjectsAction).toHaveBeenCalledWith('u-cy'));
  });
});

describe('the invite (W7 / W8 / W9)', () => {
  const openInvite = () => fireEvent.click(screen.getByRole('button', { name: /Invite/ }));
  const inviteBody = () =>
    JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);

  it('a Manager invites Limited into the projects they pick', async () => {
    renderCard();
    openInvite();
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Email address'), {
      target: { value: 'cy@ex.com' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Limited/ }));
    // An empty pick is allowed, and warned about.
    expect(
      within(dialog).getByText(
        'They won’t be able to open anything until a Manager adds them to a project.',
      ),
    ).toBeTruthy();
    fireEvent.focus(within(dialog).getByRole('combobox', { name: 'Projects to join' }));
    fireEvent.click(await within(dialog).findByRole('option', { name: /Alpha · ALP/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/workspaces/ws1/invites');
    expect(inviteBody()).toEqual({
      email: 'cy@ex.com',
      accessScope: 'limited',
      projectIds: ['p-a'],
    });
  });

  it('a project refusal renders as the picker’s field error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'INVITE_PROJECT_INVALID' }),
    });
    renderCard();
    openInvite();
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Email address'), {
      target: { value: 'cy@ex.com' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Limited/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(
      await within(dialog).findByText('One of those projects can’t be joined. Pick them again.'),
    ).toBeTruthy();
  });

  it('a Full non-Manager is offered NO access choice, and sends a Full invite', async () => {
    renderCard(context({ canManageRoles: false, inviteProjects: [] }));
    openInvite();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('radiogroup', { name: 'Access' })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Email address'), {
      target: { value: 'f@ex.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(inviteBody()).toEqual({ email: 'f@ex.com', accessScope: 'full' });
  });

  it('a Limited member gets no Invite button at all', () => {
    renderCard(context({ canManageRoles: false, canInvite: false, inviteProjects: [] }));
    expect(screen.queryByRole('button', { name: /Invite/ })).toBeNull();
  });

  it('a Limited member gets no Pending invitations block and no Resend, even if invites were passed', () => {
    render(
      <ToastProvider>
        <MembersCard
          workspaceId="ws1"
          workspaceName="Sales"
          members={members}
          currentUserId={ME}
          roleContext={context({ canManageRoles: false, canInvite: false, inviteProjects: [] })}
          pendingInvites={[
            {
              id: 'inv-1',
              email: 'pending@example.com',
              accessScope: 'full',
              projectCount: 0,
              invitedBy: { userId: ME, name: 'Zhu Yue' },
              sentAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 86_400_000 * 3).toISOString(),
              deliveryState: 'queued',
              canResend: false,
            },
          ]}
        />
      </ToastProvider>,
    );
    expect(screen.queryByText('Pending invitations')).toBeNull();
    expect(screen.queryByRole('button', { name: /Resend/ })).toBeNull();
  });
});

describe('the edges of the Access column and the invite', () => {
  it('re-picking the scope a row already has writes nothing', async () => {
    renderCard();
    fireEvent.click(accessPicker('Ada')!);
    fireEvent.click(await screen.findByRole('option', { name: /^Full/ }));
    expect(setMemberAccessScopeAction).not.toHaveBeenCalled();
  });

  it('a failed "N projects" read says so in the popover', async () => {
    listMemberAddedProjectsAction.mockResolvedValue({
      ok: false,
      error: 'Couldn’t load their projects.',
    });
    renderCard();
    fireEvent.click(within(rowOf('Cy Contractor')).getByRole('button', { name: '2 projects' }));
    expect(await screen.findByText('Couldn’t load their projects.')).toBeTruthy();
  });

  it('closing the popover reads nothing more', async () => {
    listMemberAddedProjectsAction.mockResolvedValue({ ok: true, projects: [] });
    renderCard();
    const count = within(rowOf('Cy Contractor')).getByRole('button', { name: '2 projects' });
    fireEvent.click(count);
    await waitFor(() => expect(listMemberAddedProjectsAction).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(listMemberAddedProjectsAction).toHaveBeenCalledTimes(1));
  });

  it('a picked project can be taken back out of a Limited invite', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Invite/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Email address'), {
      target: { value: 'cy@ex.com' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Limited/ }));
    fireEvent.focus(within(dialog).getByRole('combobox', { name: 'Projects to join' }));
    fireEvent.click(await within(dialog).findByRole('option', { name: /Alpha · ALP/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Alpha · ALP' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string)).toEqual({
      email: 'cy@ex.com',
      accessScope: 'limited',
      projectIds: [],
    });
  });

  it('an invite the inviter may not send says who can', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ code: 'INVITE_SCOPE_FORBIDDEN' }),
    });
    renderCard(context({ canManageRoles: false, inviteProjects: [] }));
    fireEvent.click(screen.getByRole('button', { name: /Invite/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Email address'), {
      target: { value: 'x@ex.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(
      await within(dialog).findByText(
        'You can’t send this invite. Only a workspace Manager can invite with Limited access.',
      ),
    ).toBeTruthy();
  });
});
