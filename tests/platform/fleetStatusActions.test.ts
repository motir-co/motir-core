import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';

/**
 * The Fleet status page's two Server ACTIONS (MOTIR-10886) — Publish latest and
 * the poll of the run it started. They are TRANSPORT: the rules are
 * `fleetStatusImagesService`'s, which has its own suite against the real
 * database, so the service is replaced at its seam and the TRANSLATION is
 * asserted: the gate is the action's own, a thrown error becomes a result, and
 * only a dispatch re-reads the page.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const service = vi.hoisted(() => ({ publish: vi.fn(), publishEnded: vi.fn() }));
vi.mock('@/lib/services/fleetStatusImagesService', () => ({
  fleetStatusImagesService: service,
}));

let currentPrincipal: PlatformPrincipal | null = null;
vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal || !actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

const { publishFleetImageAction, fleetImagePublishEndedAction } =
  await import('@/app/(admin)/admin/fleet-status/actions');

const superadmin: PlatformPrincipal = {
  userId: 'u1',
  email: 'ops@example.test',
  role: 'superadmin',
};

beforeEach(() => {
  currentPrincipal = superadmin;
  vi.mocked(revalidatePath).mockClear();
  service.publish.mockReset();
  service.publishEnded.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('publishFleetImageAction', () => {
  it('a dispatch is answered as is and re-reads the page', async () => {
    service.publish.mockResolvedValue({ outcome: 'dispatched', runUrl: 'u', runNumber: 3 });
    expect(await publishFleetImageAction('runner')).toEqual({
      outcome: 'dispatched',
      runUrl: 'u',
      runNumber: 3,
    });
    expect(service.publish).toHaveBeenCalledWith(superadmin, 'runner');
    expect(revalidatePath).toHaveBeenCalledWith('/admin/fleet-status');
  });

  it('a refusal or a failure is answered as is, re-reading nothing', async () => {
    service.publish.mockResolvedValueOnce({ outcome: 'refused', reason: 'running' });
    expect(await publishFleetImageAction('hosted')).toEqual({
      outcome: 'refused',
      reason: 'running',
    });
    service.publish.mockResolvedValueOnce({ outcome: 'failed', detail: 'HTTP 403' });
    expect(await publishFleetImageAction('hosted')).toEqual({
      outcome: 'failed',
      detail: 'HTTP 403',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('below superadmin, or refused by the service, is not permitted', async () => {
    currentPrincipal = { ...superadmin, role: 'operator' };
    expect(await publishFleetImageAction('hosted')).toEqual({ outcome: 'not_permitted' });
    expect(service.publish).not.toHaveBeenCalled();
    currentPrincipal = superadmin;
    service.publish.mockRejectedValueOnce(new NotPlatformStaffError());
    expect(await publishFleetImageAction('hosted')).toEqual({ outcome: 'not_permitted' });
  });

  // MOTIR-10986 — the fourth image is one the action knows.
  it('the indexer is pressed like the other images', async () => {
    service.publish.mockResolvedValueOnce({ outcome: 'refused', reason: 'not_read' });
    expect(await publishFleetImageAction('indexer')).toEqual({
      outcome: 'refused',
      reason: 'not_read',
    });
    expect(service.publish).toHaveBeenCalledWith(superadmin, 'indexer');
  });

  it('an image the page does not have is refused without a call', async () => {
    expect(await publishFleetImageAction('gpu' as never)).toEqual({
      outcome: 'refused',
      reason: 'not_read',
    });
    expect(service.publish).not.toHaveBeenCalled();
  });

  it('an unexpected error is a failed result, logged without its detail', async () => {
    service.publish.mockRejectedValueOnce(new Error('the private detail'));
    expect(await publishFleetImageAction('sandbox')).toEqual({
      outcome: 'failed',
      detail: 'the publish could not be started',
    });
    expect(console.error).toHaveBeenCalledWith('[admin] fleet image publish failed', {
      image: 'sandbox',
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private');
  });
});

describe('fleetImagePublishEndedAction', () => {
  it('answers the service', async () => {
    service.publishEnded.mockResolvedValueOnce(false);
    expect(await fleetImagePublishEndedAction('hosted', 77, 'sha256:aa')).toEqual({
      ended: false,
    });
    expect(service.publishEnded).toHaveBeenCalledWith('hosted', 77, 'sha256:aa');
    service.publishEnded.mockResolvedValueOnce(true);
    expect(await fleetImagePublishEndedAction('hosted', 77, 'sha256:aa')).toEqual({ ended: true });
  });

  it('a bad image or run id, or a refused principal, ends the poll', async () => {
    expect(await fleetImagePublishEndedAction('gpu' as never, 77, 'x')).toEqual({ ended: true });
    expect(await fleetImagePublishEndedAction('hosted', 1.5, 'x')).toEqual({ ended: true });
    expect(service.publishEnded).not.toHaveBeenCalled();
    service.publishEnded.mockRejectedValueOnce(new NotPlatformStaffError());
    expect(await fleetImagePublishEndedAction('hosted', 77, 'x')).toEqual({ ended: true });
  });

  it('any other error keeps polling', async () => {
    service.publishEnded.mockRejectedValueOnce(new Error('GitHub down'));
    expect(await fleetImagePublishEndedAction('hosted', 77, 'x')).toEqual({ ended: false });
  });
});
