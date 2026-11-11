import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { MissingAuditReasonError, NotPlatformStaffError } from '@/lib/platform/errors';

/**
 * The agent hosting Server ACTION (MOTIR-9503) — its result codes.
 *
 * The action is TRANSPORT: every rule lives in `agentHostingSettingService`,
 * which has its own suite against the real database. So the service is replaced
 * at its seam here, and what is asserted is the TRANSLATION into the codes the
 * section draws differently.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), setContext: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({
  captureException: sentry.captureException,
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setLevel: vi.fn(), setTag: vi.fn(), setContext: sentry.setContext }),
}));

const setOnPool = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/agentHostingSettingService', () => ({
  agentHostingSettingService: { setOnPool },
}));

let currentPrincipal: PlatformPrincipal | null = null;

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
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

const { setAgentHostingAction } = await import('@/app/(admin)/admin/fleet-settings/actions');

const principal = (role: PlatformPrincipal['role']): PlatformPrincipal => ({
  userId: `user-${role}`,
  email: `${role}@example.test`,
  role,
});

const stored = (onPool: boolean) => ({
  onPool,
  updatedBy: { userId: 'u1', email: 'ops@example.test' },
  updatedAt: '2026-10-25T10:00:00.000Z',
  lastReason: 'Because',
});

beforeEach(() => {
  setOnPool.mockReset();
  vi.mocked(revalidatePath).mockClear();
  currentPrincipal = principal('superadmin');
});

describe('setAgentHostingAction', () => {
  it('changed — calls the service once and revalidates the page', async () => {
    setOnPool.mockResolvedValueOnce({ outcome: 'changed', state: stored(true) });
    expect(await setAgentHostingAction(true, 'pool ready')).toEqual({
      ok: true,
      outcome: 'changed',
    });
    expect(setOnPool).toHaveBeenCalledWith(currentPrincipal, true, 'pool ready');
    expect(revalidatePath).toHaveBeenCalledWith('/admin/fleet-settings');
  });

  it('unchanged — carries the state the switch already holds', async () => {
    setOnPool.mockResolvedValueOnce({ outcome: 'unchanged', state: stored(false) });
    expect(await setAgentHostingAction(false, 'x')).toEqual({
      ok: true,
      outcome: 'unchanged',
      onPool: false,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/fleet-settings');
  });

  it('REASON_REQUIRED — the service refused a blank reason', async () => {
    setOnPool.mockRejectedValueOnce(new MissingAuditReasonError('fleet.agent_hosting.enable'));
    expect(await setAgentHostingAction(true, '  ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
  });

  it.each(['operator', 'support'] as const)(
    'NOT_PERMITTED — a %s principal is refused and the service is never called',
    async (role) => {
      currentPrincipal = principal(role);
      expect(await setAgentHostingAction(true, 'x')).toEqual({ ok: false, code: 'NOT_PERMITTED' });
      expect(setOnPool).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('FAILED — an unexpected error is logged and reported with its direction, never its secret (MOTIR-10972)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    sentry.captureException.mockClear();
    const token = 'ghs_abcdefghijklmnopqrstuvwxyz0123';
    setOnPool.mockRejectedValueOnce(new Error(`boom ${token}`));
    const result = await setAgentHostingAction(true, 'x');
    expect(result).toEqual({ ok: false, code: 'FAILED' });
    expect(log).toHaveBeenCalledWith('[admin] agent hosting action failed', {
      onPool: true,
      error: { name: 'Error', code: null, message: 'boom [redacted]' },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.setContext).toHaveBeenCalledWith('server_action', {
      action: 'setAgentHostingAction',
      onPool: true,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
