import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Project settings › Public address — the server page that echoes the workspace
// address (Story MOTIR-4528 · MOTIR-9515). ADR §8 AMENDMENT 5 (MOTIR-11287): it
// reads the service's eligibility answer beside the subdomain and hands it to the
// echo, so a workspace with no Motir repository is not invited to claim a name.

const mocks = vi.hoisted(() => ({
  getForWorkspace: vi.fn(),
  getClaimEligibility: vi.fn(),
  guard: vi.fn(async () => null as unknown),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => Object.assign((key: string) => key, { rich: (key: string) => key }),
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => ({ user: { id: 'u_1' } }) }));
vi.mock('@/lib/billing/availability', () => ({ isCloud: () => true }));
vi.mock('@/lib/projects', () => ({
  getActiveProject: async () => ({
    workspaceId: 'ws_1',
    userId: 'u_1',
    project: { name: 'Roadmap', identifier: 'ROADMAP' },
  }),
}));
vi.mock('@/lib/publicAddresses/tenantDomain', () => ({ isTenantDomainConfigured: () => true }));
vi.mock('@/lib/publicProjects/urls', () => ({
  publicSiteOrigin: () => 'https://motir.co',
  publicProjectPath: (key: string) => `/p/${key}`,
}));
vi.mock('@/app/(authed)/settings/project/_guard', () => ({ guardSettingsPage: mocks.guard }));
vi.mock('@/lib/services/publicSubdomainService', () => ({
  publicSubdomainService: {
    getForWorkspace: mocks.getForWorkspace,
    getClaimEligibility: mocks.getClaimEligibility,
  },
}));

import ProjectPublicAddressPage from '@/app/(authed)/settings/project/public-address/page';
import { PublicAddressEcho } from '@/app/(authed)/settings/project/public-address/_components/PublicAddressEcho';

type EchoProps = { subdomain: unknown; eligible: boolean; projectAddress: string };

async function echoProps(): Promise<EchoProps> {
  const page = (await ProjectPublicAddressPage()) as ReactElement<{ children: ReactElement[] }>;
  const echo = page.props.children.find((c) => c?.type === PublicAddressEcho) as
    | ReactElement<EchoProps>
    | undefined;
  if (!echo) throw new Error('no echo rendered');
  return echo.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getForWorkspace.mockResolvedValue(null);
});

describe('the project echo page', () => {
  it('passes the eligibility answer to the echo, read for the active workspace', async () => {
    mocks.getClaimEligibility.mockResolvedValue({ eligible: false });
    const props = await echoProps();
    expect(props.eligible).toBe(false);
    expect(props.subdomain).toBeNull();
    expect(props.projectAddress).toBe('motir.co/p/ROADMAP');
    expect(mocks.getClaimEligibility).toHaveBeenCalledWith('ws_1', 'u_1');

    mocks.getClaimEligibility.mockResolvedValue({ eligible: true });
    expect((await echoProps()).eligible).toBe(true);
  });

  it('reads nothing when the destination guard refuses', async () => {
    mocks.guard.mockResolvedValueOnce('refused');
    expect(await ProjectPublicAddressPage()).toBe('refused');
    expect(mocks.getClaimEligibility).not.toHaveBeenCalled();
  });
});
