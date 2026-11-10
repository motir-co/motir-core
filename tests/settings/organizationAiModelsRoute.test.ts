import { isValidElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings › Organization › AI models — the ROUTE (MOTIR-10846). Transport only,
 * with the services mocked: the page decides existence before anything renders,
 * gates NO role (a plain member gets the read-only room from the routes), and
 * hands the island the org and the two copy facts. The room-context service's own
 * fall-backs are asserted below with its two reads mocked.
 */

class NotFoundSentinel extends Error {}
class RedirectSentinel extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}

const getSession = vi.hoisted(() => vi.fn());
const isCloudBilling = vi.hoisted(() => vi.fn(() => true));
const resolveActiveOrganizationForPane = vi.hoisted(() => vi.fn());
const context = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/billing/availability', () => ({ isCloudBilling }));
vi.mock('@/lib/workspaces/tierDisclosure.server', () => ({ resolveActiveOrganizationForPane }));
vi.mock('@/lib/services/orgAiModelsRoomService', () => ({
  orgAiModelsRoomService: { context },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new NotFoundSentinel();
  }),
  redirect: vi.fn((to: string) => {
    throw new RedirectSentinel(to);
  }),
}));

const { default: OrganizationAiModelsPage } =
  await import('@/app/(authed)/settings/organization/ai-models/page');
const { OrgAiModelsRoom } =
  await import('@/app/(authed)/settings/organization/ai-models/_components/OrgAiModelsRoom');

afterEach(() => {
  vi.clearAllMocks();
  isCloudBilling.mockReturnValue(true);
});

describe('the page', () => {
  it('404s off-cloud without reading the session', async () => {
    isCloudBilling.mockReturnValue(false);
    await expect(OrganizationAiModelsPage()).rejects.toBeInstanceOf(NotFoundSentinel);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in', async () => {
    getSession.mockResolvedValue(null);
    await expect(OrganizationAiModelsPage()).rejects.toMatchObject({ to: '/sign-in' });
  });

  it('says there is no active organisation, reading nothing', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    resolveActiveOrganizationForPane.mockResolvedValue(null);
    const node = (await OrganizationAiModelsPage()) as ReactElement<{ children: ReactElement }>;
    expect(isValidElement(node.props.children)).toBe(true);
    expect((node.props.children.props as { title: string }).title).toBe('states.noActiveOrgTitle');
    expect(context).not.toHaveBeenCalled();
  });

  it.each(['owner', 'member'])('renders the room for a %s, with no role gate', async (role) => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    resolveActiveOrganizationForPane.mockResolvedValue({
      organization: { id: 'org_1', name: 'Acme' },
      role,
    });
    context.mockResolvedValue({ isMeta: true, planName: 'Pro' });
    const node = (await OrganizationAiModelsPage()) as ReactElement<Record<string, unknown>>;
    expect(node.type).toBe(OrgAiModelsRoom);
    expect(node.props).toEqual({ orgId: 'org_1', orgName: 'Acme', isMeta: true, planName: 'Pro' });
    expect(context).toHaveBeenCalledWith('org_1');
  });
});
