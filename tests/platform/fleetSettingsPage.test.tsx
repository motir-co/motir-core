// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { db } from '@/lib/db';
import en from '@/messages/en.json';
import type { FleetOrgCiStateDTO, FleetOrgCiTargetDTO } from '@/lib/dto/fleetOrgCiSetting';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { agentHostingSettingService } from '@/lib/services/agentHostingSettingService';
import { fleetOrgCiSettingService } from '@/lib/services/fleetOrgCiSettingService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { renderToHtml } from '../helpers/serverPageHarness';

// THE CONSOLE'S FLEET SETTINGS PAGE (Story MOTIR-8699 · MOTIR-8715; MOTIR-8716
// part B). The page gate runs for real over a real session and the real
// `platformRole` column — the session is the one thing mocked. The service's two
// reads are stubbed at the service object so each branch the page renders can be
// reached: the service itself (and its GitHub reads) has its own suite.

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

let currentSession: { user: { id: string } } | null = null;
const refresh = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: Page } = await import('@/app/(admin)/admin/fleet-settings/page');
const { FleetSettingsUnavailable } =
  await import('@/app/(admin)/admin/fleet-settings/_components/FleetSettingsUnavailable');

let seq = 0;

function target(org: string): FleetOrgCiTargetDTO {
  return {
    projectId: 'proj_1',
    projectKey: 'MOTIR',
    workspaceId: 'ws_1',
    organizationId: 'org_1',
    org,
    installationId: '42',
  };
}

function stateFor(org: string): FleetOrgCiStateDTO {
  return {
    enabled: false,
    updatedBy: null,
    updatedAt: null,
    lastReason: null,
    variable: { state: 'absent' },
    readiness: {
      ready: true,
      org,
      checkedAt: '2026-10-15T11:59:00.000Z',
      conditions: [
        {
          key: 'kill_switch',
          state: 'met',
          reasonCode: 'kill_switch_off',
          params: {},
          message: '',
        },
      ],
    },
  };
}

async function signInAs(role: 'support' | 'operator' | 'superadmin'): Promise<void> {
  const user = await createTestUser({ email: `ops+fleet-page-${role}-${++seq}@example.test` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id } };
}

beforeEach(async () => {
  currentSession = null;
  await truncateAuthTables();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  refresh.mockClear();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the fleet settings page', () => {
  // These cases are about the per-org Motir-CI section, and count its switches:
  // the Agent hosting section beside it (MOTIR-9503) is held at its error card,
  // which draws no switch. Its own cases are below.
  beforeEach(() => {
    vi.spyOn(agentHostingSettingService, 'getState').mockRejectedValue(new Error('held'));
  });

  it.each(['support', 'operator'] as const)(
    'a %s gets the 404, and nothing is read',
    async (role) => {
      await signInAs(role);
      const list = vi.spyOn(fleetOrgCiSettingService, 'listTargets');
      await expect(Page()).rejects.toBeInstanceOf(NotFoundSentinel);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('no offered pair renders the empty state', async () => {
    await signInAs('superadmin');
    vi.spyOn(fleetOrgCiSettingService, 'listTargets').mockResolvedValue([]);
    const html = await renderToHtml(await Page());
    expect(html).toContain('Fleet settings');
    expect(html).toContain('data-testid="fleet-settings-empty"');
    expect(html).not.toContain('fleet-settings-unavailable');
  });

  it('a failed target read renders the error card, logging no detail', async () => {
    await signInAs('superadmin');
    vi.spyOn(fleetOrgCiSettingService, 'listTargets').mockRejectedValue(
      new Error('the private detail'),
    );
    const html = await renderToHtml(await Page());
    expect(html).toContain('data-testid="fleet-settings-unavailable"');
    expect(html).not.toContain('role="switch"');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('the private detail');
  });

  it('one setting per pair, in the service order; a pair whose state cannot be read is the error card', async () => {
    await signInAs('superadmin');
    vi.spyOn(fleetOrgCiSettingService, 'listTargets').mockResolvedValue([
      target('acme-one'),
      target('acme-two'),
    ]);
    vi.spyOn(fleetOrgCiSettingService, 'getState').mockImplementation(async (_p, pair) => {
      if (pair.org === 'acme-two') throw new Error('GitHub down');
      return stateFor(pair.org);
    });
    const html = await renderToHtml(await Page());
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).toContain('Project MOTIR · GitHub organisation acme-one');
    expect(html.match(/data-testid="fleet-settings-unavailable"/g)).toHaveLength(1);
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      '[admin] fleet settings state could not be read',
      { projectId: 'proj_1', org: 'acme-two' },
    );
  });

  it('a NotPlatformStaffError from either read is not swallowed into the error card', async () => {
    await signInAs('superadmin');
    const list = vi.spyOn(fleetOrgCiSettingService, 'listTargets');
    list.mockRejectedValueOnce(new NotPlatformStaffError());
    await expect(renderToHtml(await Page())).rejects.toBeInstanceOf(NotPlatformStaffError);

    list.mockResolvedValueOnce([target('acme-one')]);
    vi.spyOn(fleetOrgCiSettingService, 'getState').mockRejectedValueOnce(
      new NotPlatformStaffError(),
    );
    await expect(renderToHtml(await Page())).rejects.toBeInstanceOf(NotPlatformStaffError);
  });
});

describe('the Agent hosting section', () => {
  const motirCiEmpty = () =>
    vi.spyOn(fleetOrgCiSettingService, 'listTargets').mockResolvedValue([]);

  it('renders after the Motir-CI section from the stored row: never changed ⇒ Fly', async () => {
    await signInAs('superadmin');
    motirCiEmpty();
    const html = await renderToHtml(await Page());
    expect(html).toContain('data-testid="agent-hosting"');
    expect(html.indexOf('fleet-settings-empty')).toBeLessThan(html.indexOf('agent-hosting'));
    expect(html).toContain('data-state="fly"');
    expect(html).toContain('Never changed — new agents are created on Fly');
    expect(html.match(/role="switch"/g)).toHaveLength(1);
  });

  it('a stored ON row renders AWS, the on note and who changed it', async () => {
    await signInAs('superadmin');
    motirCiEmpty();
    const flipper = await createTestUser({ email: 'ops+flipper@example.test' });
    await adminDb.platformFleetKindSwitch.create({
      data: {
        fleetKind: 'agent_instance',
        onPool: true,
        lastReason: 'pool ready',
        updatedByUserId: flipper.id,
      },
    });
    const html = await renderToHtml(await Page());
    expect(html).toContain('data-state="aws"');
    expect(html).toContain('data-testid="agent-hosting-on-note"');
    expect(html).toContain('ops+flipper@example.test');
    expect(html).toContain('/admin/audit-log?action=fleet.agent_hosting.enable');
  });

  it('a failed read renders its own error card and no switch, leaving the Motir-CI section', async () => {
    await signInAs('superadmin');
    motirCiEmpty();
    vi.spyOn(agentHostingSettingService, 'getState').mockRejectedValue(
      new Error('the private detail'),
    );
    const html = await renderToHtml(await Page());
    expect(html).toContain('data-testid="agent-hosting-unavailable"');
    expect(html).toContain('data-testid="fleet-settings-empty"');
    expect(html).not.toContain('role="switch"');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('the private detail');
  });

  it('a NotPlatformStaffError from its read is not swallowed into the error card', async () => {
    await signInAs('superadmin');
    motirCiEmpty();
    vi.spyOn(agentHostingSettingService, 'getState').mockRejectedValue(new NotPlatformStaffError());
    await expect(renderToHtml(await Page())).rejects.toBeInstanceOf(NotPlatformStaffError);
  });
});

describe('FleetSettingsUnavailable', () => {
  it('offers Retry, which re-runs the server read, and no switch', async () => {
    renderWithIntl(<FleetSettingsUnavailable />);
    expect(screen.getByText("Couldn't load the fleet setting")).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
