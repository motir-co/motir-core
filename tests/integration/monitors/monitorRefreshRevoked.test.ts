import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { MonitorProviderCallError, isPermanentRefreshRefusal } from '@/lib/monitors/errors';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorInstallationRepository } from '@/lib/repositories/monitorInstallationRepository';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';

// A PERMANENT refresh refusal stops the poll (MOTIR-8170).
//
// Production's own Sentry grant lost its refresh token, and from then on every
// five-minute tick polled the binding, asked Sentry to refresh a token Sentry
// said did not exist, re-wrote `degraded` and logged the same warn line — 288
// provider calls a day for a grant only a person could repair. These tests pin
// the three halves of the fix: a permanent refusal leaves the binding out of the
// next tick until a re-authorisation or a successful refresh brings it back; a
// transient one (a timeout, a 5xx) does not; and the refusal is logged once, not
// once per attempt.

const GONE = 'Given refresh token does not exist';
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** One grant whose stored access token has EXPIRED (so the next use refreshes),
 *  with one binding on it. */
async function seedBinding(): Promise<{
  workspaceId: string;
  installationRowId: string;
  providerInstallationId: string;
  connectionId: string;
}> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Revoked ${n}`, identifier: `RVK${n}` });
  const providerInstallationId = `inst-revoked-${n}`;
  const installation = await adminDb.monitorInstallation.create({
    data: {
      provider: 'sentry',
      installationId: providerInstallationId,
      workspaceId: fx.workspaceId,
      accessTokenEncrypted: encryptToken('stored-access'),
      refreshTokenEncrypted: encryptToken('stored-refresh'),
      tokenExpiresAt: new Date(Date.now() - 60_000),
      metadata: { orgSlug: 'fake-org' },
    },
  });
  const connection = await adminDb.monitorConnection.create({
    data: {
      installationId: installation.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      externalProjectId: `ext-${n}`,
      externalProjectSlug: `slug-${n}`,
      boundByUserId: fx.ownerId,
    },
  });
  return {
    workspaceId: fx.workspaceId,
    installationRowId: installation.id,
    providerInstallationId,
    connectionId: connection.id,
  };
}

/** Arm the fake's next refresh to fail with `status` and the provider's words. */
function refuseNextRefresh(status: number, reason: string): void {
  fakeMonitorState().failNextStatus.set('refreshCredential', { status, reason });
}

async function pollableIds(): Promise<string[]> {
  return (await monitorIngestionService.listPollableConnections()).map((c) => c.id);
}

describe('which refresh refusals are PERMANENT', () => {
  it.each([
    [400, true],
    [401, true],
    [403, true],
    [404, true],
    [408, false],
    [429, false],
    [500, false],
    [503, false],
  ])('a %i answer is permanent: %s', (status, permanent) => {
    const error = new MonitorProviderCallError('refreshCredential', status, GONE);
    expect(isPermanentRefreshRefusal(error)).toBe(permanent);
  });

  it('no answer at all (our deadline, a dead host) is never permanent', () => {
    const error = new MonitorProviderCallError(
      'refreshCredential',
      null,
      'No response within 15000ms.',
    );
    expect(isPermanentRefreshRefusal(error)).toBe(false);
  });

  it('an error that is not a provider refusal is never permanent', () => {
    expect(isPermanentRefreshRefusal(new Error('boom'))).toBe(false);
    expect(isPermanentRefreshRefusal(undefined)).toBe(false);
  });
});

describe('a PERMANENTLY refused grant is left out of the next tick', () => {
  it('is not listed for polling after the refusal, and the row records why', async () => {
    const b = await seedBinding();
    expect(await pollableIds()).toEqual([b.connectionId]);

    refuseNextRefresh(401, GONE);
    await expect(monitorCredentialService.getAccessToken(b.installationRowId)).rejects.toThrow(
      GONE,
    );

    expect(await pollableIds()).toEqual([]);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: b.installationRowId },
    });
    expect(row.health).toBe('degraded');
    expect(row.healthReason).toBe(GONE);
    expect(row.refreshRevokedAt).not.toBeNull();
  });

  it('leaves the OTHER grants polled: only the refused grant’s bindings drop out', async () => {
    const refused = await seedBinding();
    const healthy = await seedBinding();

    refuseNextRefresh(401, GONE);
    await expect(
      monitorCredentialService.getAccessToken(refused.installationRowId),
    ).rejects.toBeInstanceOf(MonitorProviderCallError);

    expect(await pollableIds()).toEqual([healthy.connectionId]);
  });

  it('is listed again after a RE-AUTHORISATION of the same installation', async () => {
    const b = await seedBinding();
    refuseNextRefresh(401, GONE);
    await expect(monitorCredentialService.getAccessToken(b.installationRowId)).rejects.toThrow(
      GONE,
    );
    expect(await pollableIds()).toEqual([]);

    // The connect flow's write: a fresh token set on the same provider installation,
    // bound to the grant's workspace as the connect flow's own context is.
    await withWorkspaceServiceContext(b.workspaceId, (tx) =>
      monitorInstallationRepository.upsertByProviderInstallation(
        {
          provider: 'sentry',
          installationId: b.providerInstallationId,
          workspaceId: b.workspaceId,
          accessTokenEncrypted: encryptToken('reauthorised-access'),
          refreshTokenEncrypted: encryptToken('reauthorised-refresh'),
          tokenExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
        },
        tx,
      ),
    );

    expect(await pollableIds()).toEqual([b.connectionId]);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: b.installationRowId },
    });
    expect(row.refreshRevokedAt).toBeNull();
  });

  it('is listed again after a SUCCESSFUL refresh, which also clears `degraded`', async () => {
    const b = await seedBinding();
    refuseNextRefresh(400, 'invalid_grant');
    await expect(monitorCredentialService.getAccessToken(b.installationRowId)).rejects.toThrow(
      'invalid_grant',
    );
    expect(await pollableIds()).toEqual([]);

    // A person's re-check, once the provider accepts the token again.
    await monitorCredentialService.forceRefresh(b.installationRowId);

    expect(await pollableIds()).toEqual([b.connectionId]);
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: b.installationRowId },
    });
    expect(row.health).toBe('connected');
    expect(row.refreshRevokedAt).toBeNull();
  });
});

describe('a TRANSIENT refusal stays pollable', () => {
  it.each([
    ['a timeout', null, 'No response within 15000ms.'],
    ['a 5xx', 502, 'Bad Gateway'],
    ['a rate limit', 429, 'Too Many Requests'],
  ])(
    '%s marks the grant degraded and leaves its binding on the next tick',
    async (_l, status, reason) => {
      const b = await seedBinding();
      // The fake models "no answer" as a thrown provider error with no status,
      // exactly the shape `sentry.ts` throws when its deadline aborts the call.
      if (status === null) {
        vi.spyOn(fakeMonitorProvider, 'refreshCredential').mockRejectedValueOnce(
          new MonitorProviderCallError('refreshCredential', null, reason),
        );
      } else {
        refuseNextRefresh(status, reason);
      }

      await expect(monitorCredentialService.getAccessToken(b.installationRowId)).rejects.toThrow(
        reason,
      );

      expect(await pollableIds()).toEqual([b.connectionId]);
      const row = await adminDb.monitorInstallation.findUniqueOrThrow({
        where: { id: b.installationRowId },
      });
      expect(row.health).toBe('degraded');
      expect(row.healthReason).toBe(reason);
      expect(row.refreshRevokedAt).toBeNull();
    },
  );
});

describe('the permanent refusal is LOGGED ONCE', () => {
  it('writes one warn line for the refusal, not one per attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await seedBinding();

    for (let attempt = 0; attempt < 3; attempt++) {
      refuseNextRefresh(401, GONE);
      await expect(monitorCredentialService.getAccessToken(b.installationRowId)).rejects.toThrow(
        GONE,
      );
    }

    const refusalLines = warn.mock.calls.filter(
      ([line]) => typeof line === 'string' && line.includes('[monitorCredentialService]'),
    );
    expect(refusalLines).toHaveLength(1);
    expect(refusalLines[0]![0]).toContain('permanently refused');
    expect(refusalLines[0]![1]).toEqual({
      installationRowId: b.installationRowId,
      provider: 'sentry',
      providerReason: GONE,
      // The refusal line carries the refresh's duration (MOTIR-8184).
      durationMs: expect.any(Number),
      refreshUncertainSince: null,
    });

    // The later attempts still keep the verdict current without a second line.
    const row = await adminDb.monitorInstallation.findUniqueOrThrow({
      where: { id: b.installationRowId },
    });
    expect(row.health).toBe('degraded');
    expect(row.healthReason).toBe(GONE);
  });

  it('logs a transient refusal every time, as before', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await seedBinding();

    for (let attempt = 0; attempt < 2; attempt++) {
      refuseNextRefresh(503, 'Service Unavailable');
      await expect(monitorCredentialService.getAccessToken(b.installationRowId)).rejects.toThrow(
        'Service Unavailable',
      );
    }

    const refusalLines = warn.mock.calls.filter(
      ([line]) => typeof line === 'string' && line.includes('[monitorCredentialService]'),
    );
    expect(refusalLines).toHaveLength(2);
  });
});
