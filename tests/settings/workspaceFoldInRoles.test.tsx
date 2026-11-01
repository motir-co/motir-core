// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// The one-workspace fold-in's ROLE branches (Story MOTIR-6168 · MOTIR-6465 /
// MOTIR-6466, design panel 4b): what `WorkspaceFoldInSection` decides from the
// role context and the migration report it reads — not what each card renders
// (each card owns its own tests). The cards are stubbed and record the props the
// section hands them.
//
//   * the migration notice mounts only when a report page has rows;
//   * an org Owner / Admin's Leave is locked by the org role, naming both tiers;
//   * the Roles door counts the workspace's custom roles;
//   * a workspace that went away between the reads renders nothing;
//   * the Members card gets the pending invitations only for a viewer who may
//     invite, and none when the read fails (MOTIR-9997);
//   * the Public address door (Story MOTIR-4528 · MOTIR-9514) mounts only on
//     cloud with a base domain, and names the workspace's host when it has one.

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

const svc = vi.hoisted(() => ({
  summary: null as { id: string; name: string } | null,
  migration: null as { entries: unknown[]; total: number; nextCursor: string | null } | null,
  invites: [] as unknown[],
  invitesFail: false,
  context: {
    canManageRoles: true,
    canInvite: true,
    orgManagedUserIds: [] as string[],
    organizationName: 'Acme',
    customRoles: [] as { id: string; name: string }[],
  },
  lockedByOrganization: false,
  cloud: false,
  tenantDomain: false,
  subdomain: null as { hostname: string } | null,
  subdomainReads: 0,
}));
const props = vi.hoisted(() => ({
  danger: null as Record<string, unknown> | null,
  twoFactor: null as Record<string, unknown> | null,
  door: null as Record<string, unknown> | null,
  members: null as Record<string, unknown> | null,
  addressDoor: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/services/workspaceInvitesService', () => ({
  workspaceInvitesService: {
    listPendingInvites: async () => {
      if (svc.invitesFail) throw new Error('read failed');
      return svc.invites;
    },
  },
}));

vi.mock('@/lib/billing/availability', () => ({ isCloud: () => svc.cloud }));
vi.mock('@/lib/publicAddresses/tenantDomain', () => ({
  isTenantDomainConfigured: () => svc.tenantDomain,
}));
vi.mock('@/lib/services/publicSubdomainService', () => ({
  publicSubdomainService: {
    getForWorkspace: async () => {
      svc.subdomainReads += 1;
      return svc.subdomain;
    },
  },
}));
vi.mock('@/app/(authed)/settings/organization/_components/PublicAddressDoorCard', () => ({
  PublicAddressDoorCard: (p: Record<string, unknown>) => {
    props.addressDoor = p;
    return <div data-testid="address-door" />;
  },
}));

vi.mock('@/lib/services/roleMigrationReportService', () => ({
  roleMigrationReportService: { firstPageForViewer: async () => svc.migration },
}));
vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: {
    getWorkspaceSummary: async () => svc.summary,
    listMembers: async () => [{ userId: 'u1' }, { userId: 'u2' }],
    getMemberRole: async () => 'manager',
    getMemberRoleContext: async () => svc.context,
  },
}));
vi.mock('@/lib/services/twoFactorPolicyService', () => ({
  twoFactorPolicyService: {
    getWorkspacePolicy: async () => ({
      requiresTwoFactor: false,
      lockedByOrganization: svc.lockedByOrganization,
      organizationName: 'Acme',
    }),
  },
}));
vi.mock('@/app/(authed)/settings/workspace/security/actions', () => ({
  setWorkspaceRequireTwoFactorAction: vi.fn(),
}));
vi.mock('@/app/(authed)/settings/workspace/_components/NameCard', () => ({
  NameCard: () => <div data-testid="name" />,
}));
vi.mock('@/app/(authed)/settings/workspace/_components/MembersCard', () => ({
  MembersCard: (p: Record<string, unknown>) => {
    props.members = p;
    return <div data-testid="members" />;
  },
}));
vi.mock('@/app/(authed)/settings/workspace/_components/RoleMigrationNotice', () => ({
  RoleMigrationNotice: () => <div data-testid="migration-notice" />,
}));
vi.mock('@/app/(authed)/settings/workspace/_components/DangerZoneCard', () => ({
  DangerZoneCard: (p: Record<string, unknown>) => {
    props.danger = p;
    return <div data-testid="danger" />;
  },
}));
vi.mock('@/app/(authed)/settings/organization/_components/RequireTwoFactorCard', () => ({
  RequireTwoFactorCard: (p: Record<string, unknown>) => {
    props.twoFactor = p;
    return <div data-testid="two-factor" />;
  },
}));
vi.mock('@/app/(authed)/settings/organization/_components/RolesDoorCard', () => ({
  RolesDoorCard: (p: Record<string, unknown>) => {
    props.door = p;
    return <div data-testid="roles-door" />;
  },
}));

import { WorkspaceFoldInSection } from '@/app/(authed)/settings/organization/_components/WorkspaceFoldInSection';

const section = () =>
  WorkspaceFoldInSection({
    workspaceId: 'ws1',
    actorUserId: 'u1',
    workspaceCount: 1,
    canManageWorkspaces: true,
  });

beforeEach(() => {
  svc.summary = { id: 'ws1', name: 'Northwind' };
  svc.migration = null;
  svc.invites = [];
  svc.invitesFail = false;
  svc.context = {
    canManageRoles: true,
    canInvite: true,
    orgManagedUserIds: [],
    organizationName: 'Acme',
    customRoles: [],
  };
  svc.lockedByOrganization = false;
  svc.cloud = false;
  svc.tenantDomain = false;
  svc.subdomain = null;
  svc.subdomainReads = 0;
  props.danger = props.twoFactor = props.door = props.members = props.addressDoor = null;
});
afterEach(() => cleanup());

describe('the fold-in’s role branches', () => {
  it('mounts the migration notice only when the report page has rows', async () => {
    render(<>{await section()}</>);
    expect(screen.queryByTestId('migration-notice')).toBeNull();
    cleanup();

    svc.migration = { entries: [], total: 0, nextCursor: null };
    render(<>{await section()}</>);
    expect(screen.queryByTestId('migration-notice')).toBeNull();
    cleanup();

    svc.migration = { entries: [{ id: 'e1' }], total: 1, nextCursor: null };
    render(<>{await section()}</>);
    expect(screen.getByTestId('migration-notice')).toBeTruthy();
  });

  it('locks Leave for an org-managed actor, naming the org and the workspace', async () => {
    render(<>{await section()}</>);
    expect(props.danger?.['leaveLockedByOrg']).toBeNull();
    cleanup();

    svc.context = { ...svc.context, orgManagedUserIds: ['u1'] };
    render(<>{await section()}</>);
    expect(props.danger?.['leaveLockedByOrg']).toEqual({
      organizationName: 'Acme',
      workspaceName: 'Northwind',
    });
  });

  it('the Roles door counts the workspace’s custom roles', async () => {
    svc.context = {
      ...svc.context,
      customRoles: [
        { id: 'r1', name: 'Reviewer' },
        { id: 'r2', name: 'Contractor' },
      ],
    };
    render(<>{await section()}</>);
    expect(screen.getByTestId('roles-door')).toBeTruthy();
    expect(props.door).toEqual({ customRoleCount: 2 });
  });

  it('the 2FA card is locked by the org when the org requires it', async () => {
    svc.lockedByOrganization = true;
    render(<>{await section()}</>);
    expect(props.twoFactor?.['lockedBy']).toBe('Acme');
    expect(props.twoFactor?.['canManage']).toBe(true);
  });

  it('hands the Members card the pending invitations only when the viewer may invite', async () => {
    svc.invites = [{ id: 'inv-1' }];
    render(<>{await section()}</>);
    expect(props.members?.['pendingInvites']).toEqual([{ id: 'inv-1' }]);
    cleanup();

    svc.context = { ...svc.context, canInvite: false };
    render(<>{await section()}</>);
    expect(props.members?.['pendingInvites']).toEqual([]);
  });

  it('a failed pending-invitations read draws the card without them', async () => {
    svc.invitesFail = true;
    render(<>{await section()}</>);
    expect(screen.getByTestId('members')).toBeTruthy();
    expect(props.members?.['pendingInvites']).toEqual([]);
  });

  it('a workspace that went away between the reads renders nothing', async () => {
    svc.summary = null;
    expect(await section()).toBeNull();
  });

  it('the Public address door mounts only on cloud with a base domain, and reads nothing otherwise', async () => {
    render(<>{await section()}</>);
    expect(screen.queryByTestId('address-door')).toBeNull();
    cleanup();

    svc.cloud = true;
    render(<>{await section()}</>);
    expect(screen.queryByTestId('address-door')).toBeNull();
    expect(svc.subdomainReads).toBe(0);
    cleanup();

    svc.tenantDomain = true;
    render(<>{await section()}</>);
    expect(screen.getByTestId('address-door')).toBeTruthy();
    expect(props.addressDoor).toEqual({ hostname: null });
    expect(svc.subdomainReads).toBe(1);
  });

  it('the Public address door names the workspace’s host once one is claimed', async () => {
    svc.cloud = svc.tenantDomain = true;
    svc.subdomain = { hostname: 'acme.motir.site' };
    render(<>{await section()}</>);
    expect(props.addressDoor).toEqual({ hostname: 'acme.motir.site' });
  });
});
