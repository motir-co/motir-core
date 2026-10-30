import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// The certificate sweep — Story MOTIR-3878 · Subtask MOTIR-4219.
//
// The job that carries platform state home. Its value is entirely in the
// transitions NOBODY IS WATCHING FOR: a certificate that issued after the
// customer closed the tab, and one that expired weeks later. Both are asserted.

const { db } = await import('@/lib/db');
const { publicAddressCertificatesService } =
  await import('@/lib/services/publicAddressCertificatesService');
const providers = await import('@/lib/publicAddresses/providers');
const flyCerts = await import('@/lib/publicAddresses/adapters/fly/flyCertificates');
const { publicAddressRepository } = await import('@/lib/repositories/publicAddressRepository');
const { createTestWorkspace } = await import('../fixtures');

let workspaceId: string;
/** What the stubbed port reports for every hostname this run. */
let answer: { configured: boolean; issued: boolean } | Error = { configured: true, issued: false };

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('FLY_CERTS_TOKEN', 'test-token');
  vi.stubEnv('FLY_CERTS_APP', 'motir-marketing');
  answer = { configured: true, issued: false };

  const { workspace } = await createTestWorkspace({ name: 'Acme' });
  workspaceId = workspace.id;
  await adminDb.project.create({
    data: {
      workspaceId,
      name: 'Acme',
      slug: 'acme',
      identifier: 'ACME',
      ...projectAccessData('public'),
    },
  });

  vi.spyOn(providers, 'certificateProvider').mockResolvedValue({
    request: async () => {
      throw new Error('the sweep must never REQUEST a certificate');
    },
    check: async (hostname: string) => {
      if (answer instanceof Error) throw answer;
      return { hostname, ...answer, dnsRequirements: [], checkedAt: new Date() };
    },
    remove: async () => {},
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the not-configured exit', () => {
  it('performs NO repository read at all with FLY_CERTS_TOKEN unset', async () => {
    // A self-hosted build schedules this job like every other and must do
    // nothing — not read, not log per row, not touch a database it may have no
    // addresses in.
    vi.unstubAllEnvs();
    const spy = vi.spyOn(publicAddressRepository, 'listByStatusOlderThan');
    const summary = await publicAddressCertificatesService.refreshDueAddresses();
    expect(summary.skipped).toBe('not-configured');
    expect(spy).not.toHaveBeenCalled();
    expect(flyCerts.isFlyCertsConfigured()).toBe(false);
  });
});

describe('the transitions that matter', () => {
  it('PENDING → ISSUED, stamping issuedAt exactly once', async () => {
    // The one the customer who closed the tab is waiting on.
    const a = await seed('pending.acme.test', 'pending_certificate');
    answer = { configured: true, issued: true };

    const first = await publicAddressCertificatesService.refreshDueAddresses();
    expect(first.changed).toBe(1);
    const afterFirst = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(afterFirst.status).toBe('issued');
    expect(afterFirst.issuedAt).not.toBeNull();
    expect(afterFirst.lastCheckedAt).not.toBeNull();

    // A second sweep must not re-stamp it: a renewal is not a new issuance from
    // the customer's point of view, and overwriting would lose when the address
    // actually went live.
    await adminDb.publicAddress.update({
      where: { id: a.id },
      data: { lastCheckedAt: new Date(Date.now() - 7200_000) },
    });
    await publicAddressCertificatesService.refreshDueAddresses();
    const afterSecond = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(afterSecond.issuedAt?.toISOString()).toBe(afterFirst.issuedAt?.toISOString());
  });

  it('ISSUED → EXPIRED when the platform stops reporting a certificate', async () => {
    // ⚠️ THE TRANSITION NOBODY IS WATCHING FOR, and the whole reason a backstop
    // sweep exists: a customer edits DNS, the certificate lapses, and no request
    // path can observe it.
    const a = await seed('live.acme.test', 'issued', { hoursAgo: 2 });
    answer = { configured: false, issued: false };

    const summary = await publicAddressCertificatesService.refreshDueAddresses();
    expect(summary.changed).toBe(1);
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('expired');
    expect(row.failureReason).toContain('no longer active');
  });

  it('a healthy ISSUED row is left alone, but its lastCheckedAt moves', async () => {
    // No transition is still a CHECK. Recording it is what stops the row being
    // re-read every sweep for ever, and what lets the pane say when it looked.
    const a = await seed('live.acme.test', 'issued', { hoursAgo: 2 });
    answer = { configured: true, issued: true };
    const before = (await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } }))
      .lastCheckedAt;

    const summary = await publicAddressCertificatesService.refreshDueAddresses();
    expect(summary.changed).toBe(0);
    expect(summary.scanned).toBe(1);
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('issued');
    expect(row.lastCheckedAt!.getTime()).toBeGreaterThan(before!.getTime());
  });
});

describe('what the sweep does NOT touch', () => {
  it('leaves unverified, active, alias and revoked rows unread', async () => {
    // `unverified` waits on the CUSTOMER, not the platform; `active`/`alias` are
    // subdomains the wildcard covers; `revoked` is terminal until somebody acts.
    await seed('unverified.acme.test', 'unverified');
    await seed('revoked.acme.test', 'revoked');
    await adminDb.publicAddress.create({
      data: {
        workspaceId,
        hostname: 'acme.motir.example',
        kind: 'workspace_subdomain',
        status: 'active',
      },
    });
    answer = { configured: true, issued: true };

    const summary = await publicAddressCertificatesService.refreshDueAddresses();
    expect(summary.scanned).toBe(0);
    expect(summary.changed).toBe(0);
  });

  it('never REQUESTS a certificate — it only reads', async () => {
    // The stub throws on `request`. The lifecycle asks; this carries answers home.
    await seed('pending.acme.test', 'pending_certificate');
    answer = { configured: true, issued: true };
    await expect(publicAddressCertificatesService.refreshDueAddresses()).resolves.toMatchObject({
      failed: 0,
    });
  });
});

describe('one bad hostname does not wedge the sweep', () => {
  it('counts the failure, leaves that row, and checks the others', async () => {
    const bad = await seed('bad.acme.test', 'pending_certificate');
    const good = await seed('good.acme.test', 'pending_certificate');

    let calls = 0;
    vi.spyOn(providers, 'certificateProvider').mockResolvedValue({
      request: async () => {
        throw new Error('unused');
      },
      check: async (hostname: string) => {
        calls += 1;
        if (hostname === 'bad.acme.test') throw new Error('platform unreachable');
        return {
          hostname,
          configured: true,
          issued: true,
          dnsRequirements: [],
          checkedAt: new Date(),
        };
      },
      remove: async () => {},
    });

    const summary = await publicAddressCertificatesService.refreshDueAddresses();
    expect(calls, 'both rows must be attempted').toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.changed).toBe(1);

    expect((await adminDb.publicAddress.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe(
      'pending_certificate',
    );
    expect((await adminDb.publicAddress.findUniqueOrThrow({ where: { id: good.id } })).status).toBe(
      'issued',
    );
  });
});

async function seed(
  hostname: string,
  status:
    | 'unverified'
    | 'verifying'
    | 'pending_certificate'
    | 'issued'
    | 'failed'
    | 'expired'
    | 'revoked',
  opts: { hoursAgo?: number } = {},
) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId,
      hostname,
      kind: 'custom_domain',
      status,
      verificationToken: `motir-verify-${hostname}`,
      ...(status === 'issued' ? { issuedAt: new Date(Date.now() - 86_400_000) } : {}),
      ...(opts.hoursAgo ? { lastCheckedAt: new Date(Date.now() - opts.hoursAgo * 3_600_000) } : {}),
    },
  });
}
