import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Workspace settings › Public address — the server side (Story MOTIR-4528 ·
// MOTIR-9514). The page's gates, and the body's two derived props: `canManage`
// from the WORKSPACE role (the service's own predicate) and a null DTO for a
// workspace with no name.

const mocks = vi.hoisted(() => ({
  isCloud: vi.fn(() => true),
  getSession: vi.fn(async () => ({ user: { id: 'u_1' } })),
  getWorkspaceContext: vi.fn(async () => ({ workspaceId: 'ws_1', userId: 'u_1' })),
  isTenantDomainConfigured: vi.fn(() => true),
  getForWorkspace: vi.fn(),
  getMemberRole: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/auth', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/billing/availability', () => ({ isCloud: mocks.isCloud }));
vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext: mocks.getWorkspaceContext }));
vi.mock('@/lib/publicAddresses/tenantDomain', () => ({
  isTenantDomainConfigured: mocks.isTenantDomainConfigured,
  tenantBaseDomain: () => 'motir.site',
}));
vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: { getMemberRole: mocks.getMemberRole },
}));
vi.mock('@/lib/services/publicSubdomainService', () => ({
  publicSubdomainService: { getForWorkspace: mocks.getForWorkspace },
  roleMayManageAddress: (role: string | null) => role === 'owner' || role === 'admin',
}));

import WorkspacePublicAddressPage from '@/app/(authed)/settings/workspace/public-address/page';
import { PublicAddressBody } from '@/app/(authed)/settings/workspace/public-address/_components/PublicAddressBody';

type ControlProps = {
  subdomain: unknown;
  canManage: boolean;
  loadFailed: boolean;
  baseDomain: string;
  workspaceId: string;
};

async function body(): Promise<ControlProps> {
  const el = (await PublicAddressBody({
    workspaceId: 'ws_1',
    actorUserId: 'u_1',
  })) as ReactElement<ControlProps>;
  return el.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isCloud.mockReturnValue(true);
  mocks.isTenantDomainConfigured.mockReturnValue(true);
});

describe('the page gates', () => {
  it('is absent off-cloud — notFound before any session read', async () => {
    mocks.isCloud.mockReturnValue(false);
    await expect(WorkspacePublicAddressPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('explains the operator state rather than 404ing when no base domain is configured', async () => {
    mocks.isTenantDomainConfigured.mockReturnValue(false);
    const page = await WorkspacePublicAddressPage();
    const text = JSON.stringify(page, (_k, v) => (typeof v === 'function' ? undefined : v));
    expect(text).toContain('unavailable.title');
    expect(mocks.getForWorkspace).not.toHaveBeenCalled();
  });
});

describe('the body', () => {
  it('passes a null DTO for a workspace with no name', async () => {
    mocks.getForWorkspace.mockResolvedValue(null);
    mocks.getMemberRole.mockResolvedValue('owner');
    const props = await body();
    expect(props.subdomain).toBeNull();
    expect(props.baseDomain).toBe('motir.site');
    expect(props.loadFailed).toBe(false);
  });

  it('derives canManage from the WORKSPACE role', async () => {
    mocks.getForWorkspace.mockResolvedValue(null);
    mocks.getMemberRole.mockResolvedValue('admin');
    expect((await body()).canManage).toBe(true);
    mocks.getMemberRole.mockResolvedValue('member');
    expect((await body()).canManage).toBe(false);
  });

  it('renders the load-error state when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getForWorkspace.mockRejectedValue(new Error('db down'));
    mocks.getMemberRole.mockResolvedValue('owner');
    const props = await body();
    expect(props.loadFailed).toBe(true);
    expect(props.canManage).toBe(false);
  });
});
