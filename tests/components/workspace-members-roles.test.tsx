// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { MemberRoleContextDTO, WorkspaceMemberWithAccessDTO } from '@/lib/dto/workspaces';

// The workspace Members page's role column (Story MOTIR-6168 · MOTIR-6465;
// `design/workspaces/workspace-roles.mock.html` panels 1a–1f, 6a, 6c): a Manager
// changes a role in place, everyone else reads it, the only Manager and an org
// Owner / Admin are locked with their reasons, and a Manager stepping down on
// their own row is asked first. The server actions are the one seam mocked.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const setMemberRoleAction = vi.fn();
vi.mock('@/app/(authed)/settings/workspace/actions', () => ({
  resendInviteAction: vi.fn(async () => ({ ok: true })),
  setMemberRoleAction: (...a: unknown[]) => setMemberRoleAction(...a),
  removeMemberAction: vi.fn(async () => ({ ok: true })),
  setMemberAccessScopeAction: vi.fn(async () => ({ ok: true })),
  listMemberAddedProjectsAction: vi.fn(async () => ({ ok: true, projects: [] })),
  openProjectAccessAction: vi.fn(async () => undefined),
}));

import { MembersCard } from '@/app/(authed)/settings/workspace/_components/MembersCard';

const ME = 'u-me';
const members: WorkspaceMemberWithAccessDTO[] = [
  {
    userId: ME,
    name: 'Zhu Yue',
    email: 'zhuyue@motir.co',
    workspaceRole: 'manager',
    customRole: null,
    accessScope: 'full',
    addedProjectCount: 1,
  },
  {
    userId: 'u-bo',
    name: 'Bo Philips',
    email: 'bo@motir.co',
    workspaceRole: 'manager',
    customRole: null,
    accessScope: 'full',
    addedProjectCount: 1,
  },
  {
    userId: 'u-odie',
    name: 'Odie',
    email: 'odie@motir.co',
    workspaceRole: 'viewer',
    customRole: null,
    accessScope: 'full',
    addedProjectCount: 1,
  },
  {
    userId: 'u-julian',
    name: 'Julian',
    email: 'julian@motir.co',
    workspaceRole: 'member',
    customRole: { id: 'role-contractor', name: 'Contractor' },
    accessScope: 'full',
    addedProjectCount: 1,
  },
];

function context(overrides: Partial<MemberRoleContextDTO> = {}): MemberRoleContextDTO {
  return {
    canManageRoles: true,
    canInvite: true,
    inviteProjects: [],
    orgManagedUserIds: [],
    organizationName: 'moooon',
    customRoles: [{ id: 'role-contractor', name: 'Contractor' }],
    ...overrides,
  };
}

function renderCard(
  props: { members?: WorkspaceMemberWithAccessDTO[]; roleContext?: MemberRoleContextDTO } = {},
) {
  return render(
    <ToastProvider>
      <MembersCard
        workspaceId="ws1"
        workspaceName="Sales"
        members={props.members ?? members}
        currentUserId={ME}
        roleContext={props.roleContext ?? context()}
      />
    </ToastProvider>,
  );
}

const picker = (name: string) => screen.getByRole('combobox', { name: `Role for ${name}` });

beforeEach(() => {
  setMemberRoleAction.mockReset();
  refresh.mockReset();
});
afterEach(() => cleanup());

describe('a Manager (1a–1b)', () => {
  it('draws a picker on every row — their own included — under a Person / Workspace role header', () => {
    renderCard();
    expect(screen.getByText('Person')).toBeTruthy();
    expect(screen.getByText('Workspace role')).toBeTruthy();
    for (const m of members) expect(picker(m.name)).toBeTruthy();
    expect(picker('Julian').textContent).toContain('Contractor');
    expect(screen.queryByText('Only a workspace Manager can change roles and access.')).toBeNull();
  });

  it('offers the built-ins with their descriptions, then the custom roles under their own heading', async () => {
    renderCard();
    fireEvent.click(picker('Odie'));
    expect(await screen.findByText('Built-in')).toBeTruthy();
    expect(screen.getByText('Custom roles')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Manager/ })).toBeTruthy();
    expect(
      screen.getAllByText('Reads every project and its reports. Changes nothing.').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('option', { name: /Contractor/ })).toBeTruthy();
  });

  it('changing Viewer → Member calls the action, repaints the row at once and refreshes', async () => {
    setMemberRoleAction.mockResolvedValue({ ok: true });
    renderCard();
    fireEvent.click(picker('Odie'));
    fireEvent.click(await screen.findByRole('option', { name: /^Member/ }));
    expect(setMemberRoleAction).toHaveBeenCalledWith('u-odie', 'member', null);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(picker('Odie').textContent).toContain('Member');
    expect(await screen.findByText('Odie is now a Member in every project of Sales')).toBeTruthy();
  });

  it('assigning a custom role sends its id at the member tier', async () => {
    setMemberRoleAction.mockResolvedValue({ ok: true });
    renderCard();
    fireEvent.click(picker('Odie'));
    fireEvent.click(await screen.findByRole('option', { name: /Contractor/ }));
    expect(setMemberRoleAction).toHaveBeenCalledWith('u-odie', 'member', 'role-contractor');
  });

  it('a last-Manager refusal snaps the picker back and says who stays a Manager (1d)', async () => {
    setMemberRoleAction.mockResolvedValue({ ok: false, code: 'LAST_MANAGER', error: 'x' });
    renderCard();
    fireEvent.click(picker('Bo Philips'));
    fireEvent.click(await screen.findByRole('option', { name: /^Viewer/ }));
    expect(await screen.findByText('Couldn’t change the role')).toBeTruthy();
    expect(
      screen.getByText('A workspace needs at least one Manager. Bo Philips is still a Manager.'),
    ).toBeTruthy();
    await waitFor(() => expect(picker('Bo Philips').textContent).toContain('Manager'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('any other failure reverts and names the person (1e)', async () => {
    setMemberRoleAction.mockResolvedValue({ ok: false, code: 'NOT_A_MEMBER', error: 'x' });
    renderCard();
    fireEvent.click(picker('Odie'));
    fireEvent.click(await screen.findByRole('option', { name: /^Member/ }));
    expect(await screen.findByText('Couldn’t change Odie’s role')).toBeTruthy();
    expect(screen.getByText('Nothing changed — they are still a Viewer. Try again.')).toBeTruthy();
    await waitFor(() => expect(picker('Odie').textContent).toContain('Viewer'));
  });
});

describe('the locked rows (1c, 6a)', () => {
  it('the only Manager is locked with the reason that names what unlocks it', () => {
    renderCard({ members: [members[0]!, members[2]!] });
    expect((picker('Zhu Yue') as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        'You\u2019re the only Manager. Make someone else a Manager before changing your own role.',
      ),
    ).toBeTruthy();
    expect((picker('Odie') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an org Owner / Admin is locked at Manager, whatever their stored role, with where it changes', () => {
    renderCard({
      members: [members[0]!, { ...members[2]!, workspaceRole: 'member' }],
      roleContext: context({ orgManagedUserIds: ['u-odie'] }),
    });
    const odie = picker('Odie') as HTMLButtonElement;
    expect(odie.disabled).toBe(true);
    expect(odie.textContent).toContain('Manager');
    expect(
      screen.getByText(
        'Organization Admin — a Manager in every workspace of moooon. Change it on the organization’s Members page.',
      ),
    ).toBeTruthy();
  });
});

describe('a Manager stepping down on their own row is asked first (6c)', () => {
  it('opens the confirmation, and Keep Manager changes nothing', async () => {
    renderCard();
    fireEvent.click(picker('Zhu Yue'));
    fireEvent.click(await screen.findByRole('option', { name: /^Member/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Make yourself a Member?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Manager' }));
    expect(setMemberRoleAction).not.toHaveBeenCalled();
  });

  it('confirming commits the change', async () => {
    setMemberRoleAction.mockResolvedValue({ ok: true });
    renderCard();
    fireEvent.click(picker('Zhu Yue'));
    fireEvent.click(await screen.findByRole('option', { name: /^Member/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make me a Member' }));
    await waitFor(() => expect(setMemberRoleAction).toHaveBeenCalledWith(ME, 'member', null));
  });
});

describe('a Member or a Viewer (1f)', () => {
  it('reads every role as text, with no role control in the DOM, and one note says why', () => {
    renderCard({ roleContext: context({ canManageRoles: false }) });
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getByText('Only a workspace Manager can change roles and access.')).toBeTruthy();
    expect(screen.getByLabelText('Role for Julian: Contractor')).toBeTruthy();
    expect(screen.getByLabelText('Role for Odie: Viewer')).toBeTruthy();
    // No lock reasons for a reader — they cannot act on them.
    expect(screen.queryByText(/only Manager/)).toBeNull();
  });
});

// Bug MOTIR-6317: removing another member is a Manager's act, and never reaches
// an org Owner / Admin. The server refuses both; the row HIDES the entry point
// (the permission-gated UI rule) — only an aria-hidden spacer stays for layout.
describe('pending invitations (MOTIR-9997)', () => {
  it('a Manager with nothing pending sees no Pending block — the card is as before', () => {
    renderCard();
    expect(screen.queryByText('Pending invitations')).toBeNull();
    expect(screen.queryByRole('button', { name: /Resend/ })).toBeNull();
  });
});

describe('who is offered Remove (MOTIR-6317)', () => {
  const removeButtons = () => screen.queryAllByRole('button', { name: 'Remove' });

  it('a Manager sees Remove on every row but their own', () => {
    renderCard();
    expect(removeButtons()).toHaveLength(members.length - 1);
  });

  it('a Member or a Viewer sees no Remove at all', () => {
    renderCard({ roleContext: context({ canManageRoles: false }) });
    expect(removeButtons()).toHaveLength(0);
  });

  it('a Manager sees no Remove on an org Owner / Admin row', () => {
    renderCard({ roleContext: context({ orgManagedUserIds: ['u-odie'] }) });
    expect(removeButtons()).toHaveLength(members.length - 2);
  });
});
