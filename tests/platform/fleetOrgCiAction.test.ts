import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  FleetOrgCiCodeScanningError,
  FleetOrgCiGithubWriteError,
  FleetOrgCiNotReadyError,
  FleetOrgCiTargetUnknownError,
  MissingAuditReasonError,
  NotPlatformStaffError,
} from '@/lib/platform/errors';

/**
 * The fleet org CI Server ACTION (MOTIR-8715) — its result codes.
 *
 * The action is TRANSPORT: every rule lives in `fleetOrgCiSettingService`, which
 * has its own suite against the real database and a stubbed GitHub. So the
 * service is replaced at its seam here, as the card asks, and what is asserted
 * is the TRANSLATION: each answer the page draws differently reaches it as its
 * own code, the gate is the action's own, and nothing secret rides a result.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), setContext: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({
  captureException: sentry.captureException,
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setContext: sentry.setContext }),
}));

const setEnabled = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/fleetOrgCiSettingService', () => ({
  fleetOrgCiSettingService: { setEnabled },
}));

let currentPrincipal: PlatformPrincipal | null = null;

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The degree is honoured, so NOT_PERMITTED is the action's own gate.
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

const { setFleetOrgCiAction } = await import('@/app/(admin)/admin/fleet-settings/actions');

const SECRET = 'ghs_s3cr3tInstallationToken';
const PROJECT = 'proj_1';
const ORG = 'acme-ci';

const principal = (role: PlatformPrincipal['role']): PlatformPrincipal => ({
  userId: `user-${role}`,
  email: `${role}@example.test`,
  role,
});

const stored = (enabled: boolean) => ({
  enabled,
  updatedBy: { userId: 'u1', email: 'ops@example.test' },
  updatedAt: '2026-10-15T10:00:00.000Z',
  lastReason: 'Because',
});

beforeEach(() => {
  setEnabled.mockReset();
  vi.mocked(revalidatePath).mockClear();
  currentPrincipal = principal('superadmin');
});

describe('setFleetOrgCiAction', () => {
  it('changed — calls the service once with the pair and revalidates the page', async () => {
    setEnabled.mockResolvedValueOnce({ outcome: 'changed', state: stored(true) });
    expect(await setFleetOrgCiAction(PROJECT, ORG, true, 'Moving CI')).toEqual({
      ok: true,
      outcome: 'changed',
    });
    expect(setEnabled).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledWith(
      currentPrincipal,
      { projectId: PROJECT, org: ORG },
      true,
      'Moving CI',
    );
    expect(revalidatePath).toHaveBeenCalledWith('/admin/fleet-settings');
  });

  it('unchanged — information, carrying the state the pair already holds', async () => {
    setEnabled.mockResolvedValueOnce({ outcome: 'unchanged', state: stored(false) });
    expect(await setFleetOrgCiAction(PROJECT, ORG, false, 'x')).toEqual({
      ok: true,
      outcome: 'unchanged',
      enabled: false,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/fleet-settings');
  });

  it('NOT_READY — every condition not met, without its English message; revalidates', async () => {
    setEnabled.mockRejectedValueOnce(
      new FleetOrgCiNotReadyError(PROJECT, ORG, [
        {
          key: 'app_variables_permission',
          state: 'unmet',
          reasonCode: 'permission_missing',
          message: `holds none (${SECRET})`,
        },
        { key: 'app_installed', state: 'unknown', reasonCode: 'read_failed', message: 'HTTP 502' },
      ]),
    );
    const result = await setFleetOrgCiAction(PROJECT, ORG, true, 'x');
    expect(result).toEqual({
      ok: false,
      code: 'NOT_READY',
      conditions: [
        { key: 'app_variables_permission', state: 'unmet', reasonCode: 'permission_missing' },
        { key: 'app_installed', state: 'unknown', reasonCode: 'read_failed' },
      ],
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/fleet-settings');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    [403, 'set'],
    [null, 'delete'],
    [502, 'read'],
  ] as const)(
    'GITHUB_WRITE_FAILED — carries org, status %s and operation %s',
    async (status, operation) => {
      setEnabled.mockRejectedValueOnce(new FleetOrgCiGithubWriteError(ORG, status, operation));
      expect(await setFleetOrgCiAction(PROJECT, ORG, operation !== 'delete', 'x')).toEqual({
        ok: false,
        code: 'GITHUB_WRITE_FAILED',
        org: ORG,
        status,
        operation,
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([
    [403, 'write', 'fleet'],
    [null, 'write', 'github_hosted'],
    [502, 'read', 'fleet'],
  ] as const)(
    'CODE_SCANNING_FAILED — names the repository, status %s, operation %s, towards %s (MOTIR-10289)',
    async (status, operation, to) => {
      setEnabled.mockRejectedValueOnce(
        new FleetOrgCiCodeScanningError(ORG, 'motir-ai', status, operation, to),
      );
      expect(await setFleetOrgCiAction(PROJECT, ORG, to === 'fleet', 'x')).toEqual({
        ok: false,
        code: 'CODE_SCANNING_FAILED',
        org: ORG,
        repo: 'motir-ai',
        status,
        operation,
        to,
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('REASON_REQUIRED — the service refused a blank reason', async () => {
    setEnabled.mockRejectedValueOnce(new MissingAuditReasonError('fleet.org_ci.enable'));
    expect(await setFleetOrgCiAction(PROJECT, ORG, true, '   ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
  });

  it('TARGET_UNKNOWN — a pair the console does not offer', async () => {
    setEnabled.mockRejectedValueOnce(new FleetOrgCiTargetUnknownError(PROJECT, ORG));
    expect(await setFleetOrgCiAction(PROJECT, ORG, true, 'x')).toEqual({
      ok: false,
      code: 'TARGET_UNKNOWN',
    });
  });

  it('NOT_PERMITTED — the service re-gates and refuses', async () => {
    setEnabled.mockRejectedValueOnce(new NotPlatformStaffError());
    expect(await setFleetOrgCiAction(PROJECT, ORG, true, 'x')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
  });

  it.each(['operator', 'support'] as const)(
    'NOT_PERMITTED — a %s principal is refused and the service is never called',
    async (role) => {
      currentPrincipal = principal(role);
      expect(await setFleetOrgCiAction(PROJECT, ORG, true, 'x')).toEqual({
        ok: false,
        code: 'NOT_PERMITTED',
      });
      expect(setEnabled).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('NOT_PERMITTED — no platform standing at all', async () => {
    currentPrincipal = null;
    expect(await setFleetOrgCiAction(PROJECT, ORG, false, 'x')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('FAILED — an unexpected error is logged and reported with the pair and direction, never its secret (MOTIR-10972)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    sentry.captureException.mockClear();
    sentry.setContext.mockClear();
    const expired = Object.assign(
      new Error(`A query cannot be executed on an expired transaction near ${SECRET}`),
      { code: 'P2028' },
    );
    setEnabled.mockRejectedValueOnce(expired);
    const result = await setFleetOrgCiAction(PROJECT, ORG, true, 'x');
    expect(result).toEqual({ ok: false, code: 'FAILED' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(log).toHaveBeenCalledWith('[admin] fleet org CI action failed', {
      projectId: PROJECT,
      org: ORG,
      enabled: true,
      to: 'fleet',
      error: {
        name: 'Error',
        code: 'P2028',
        message: 'A query cannot be executed on an expired transaction near [redacted]',
      },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.setContext).toHaveBeenCalledWith('server_action', {
      action: 'setFleetOrgCiAction',
      projectId: PROJECT,
      org: ORG,
      enabled: true,
      to: 'fleet',
    });
    log.mockRestore();
  });

  it('FAILED — turning OFF reports the github_hosted direction', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    sentry.setContext.mockClear();
    setEnabled.mockRejectedValueOnce(new Error('boom'));
    expect(await setFleetOrgCiAction(PROJECT, ORG, false, 'x')).toEqual({
      ok: false,
      code: 'FAILED',
    });
    expect(sentry.setContext).toHaveBeenCalledWith(
      'server_action',
      expect.objectContaining({ enabled: false, to: 'github_hosted' }),
    );
    log.mockRestore();
  });
});
