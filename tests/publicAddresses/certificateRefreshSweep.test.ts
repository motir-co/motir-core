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
let answer: { configured: boolean; issued: boolean; expiresAt?: Date | null } | Error = {
  configured: true,
  issued: false,
};
/** What the stubbed resolver answers for `_motir-verify.<host>`: by default the
 *  row's own token (see `seed`), i.e. ownership still proven. */
let txt: (name: string) => string[] | Error = (name) => [
  `motir-verify-${name.replace(/^_motir-verify\./, '')}`,
];
let txtReads = 0;

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('FLY_CERTS_TOKEN', 'test-token');
  vi.stubEnv('FLY_CERTS_APP', 'motir-marketing');
  answer = { configured: true, issued: false };
  txt = (name) => [`motir-verify-${name.replace(/^_motir-verify\./, '')}`];
  txtReads = 0;
  vi.stubEnv('MOTIR_PUBLIC_ADDRESS_CNAME_TARGET', 'motir-edge.fly.dev');
  vi.stubEnv('MOTIR_PUBLIC_ADDRESS_A_RECORDS', '66.241.125.1');

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
      return { hostname, expiresAt: null, ...answer, dnsRequirements: [], checkedAt: new Date() };
    },
    remove: async () => {},
  });
  vi.spyOn(providers, 'dnsResolver').mockReturnValue({
    resolveTxt: async (name: string) => {
      txtReads += 1;
      const records = txt(name);
      if (records instanceof Error) throw records;
      return records;
    },
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

describe('the certificate EXPIRY is read, never computed (MOTIR-9526)', () => {
  const EXPIRY = new Date('2027-01-28T12:00:00.000Z');

  it('stores the reading’s date on a healthy issued row without moving status, issuedAt or kind', async () => {
    const a = await seed('live.acme.test', 'issued', { hoursAgo: 2 });
    const issuedAt = new Date(Date.now() - 86_400_000);
    await adminDb.publicAddress.update({ where: { id: a.id }, data: { issuedAt } });
    answer = { configured: true, issued: true, expiresAt: EXPIRY };

    const summary = await publicAddressCertificatesService.refreshDueAddresses();
    expect(summary.changed).toBe(0);
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.certificateExpiresAt?.toISOString()).toBe(EXPIRY.toISOString());
    expect([row.status, row.failureKind]).toEqual(['issued', null]);
    expect(row.issuedAt?.toISOString()).toBe(issuedAt.toISOString());
  });

  it('carries the date on the transition INTO issued', async () => {
    const a = await seed('pending.acme.test', 'pending_certificate');
    answer = { configured: true, issued: true, expiresAt: EXPIRY };
    await publicAddressCertificatesService.refreshDueAddresses();
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('issued');
    expect(row.certificateExpiresAt?.toISOString()).toBe(EXPIRY.toISOString());
  });

  it('a reading with NO date keeps the stored one — it is not evidence there is none', async () => {
    const a = await seed('live.acme.test', 'issued', { hoursAgo: 2 });
    await adminDb.publicAddress.update({
      where: { id: a.id },
      data: { certificateExpiresAt: EXPIRY },
    });
    answer = { configured: true, issued: true, expiresAt: null };
    await publicAddressCertificatesService.refreshDueAddresses();
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.certificateExpiresAt?.toISOString()).toBe(EXPIRY.toISOString());
  });

  it('a row that has never had a date reads back null', async () => {
    const a = await seed('live.acme.test', 'issued', { hoursAgo: 2 });
    answer = { configured: true, issued: true, expiresAt: null };
    await publicAddressCertificatesService.refreshDueAddresses();
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.certificateExpiresAt).toBeNull();
  });
});

describe('a live domain RE-PROVES its owner’s side (MOTIR-9526)', () => {
  it('a lost ownership TXT fails the row as txt_lost, naming the record and the token', async () => {
    const a = await seed('live.acme.test', 'issued', { hoursAgo: 2 });
    answer = { configured: true, issued: true };
    txt = () => [];

    const summary = await publicAddressCertificatesService.refreshDueAddresses();
    expect(summary.changed).toBe(1);
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('failed');
    expect(row.failureKind).toBe('txt_lost');
    expect(row.failureReason).toContain('_motir-verify.live.acme.test');
    expect(row.failureReason).toContain('motir-verify-live.acme.test');
  });

  it('a CHANGED TXT is a miss too — only the row’s own token proves it', async () => {
    const a = await seed('live.acme.test', 'issued', { hoursAgo: 2 });
    answer = { configured: true, issued: true };
    txt = () => ['motir-verify-someone-else'];
    await publicAddressCertificatesService.refreshDueAddresses();
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.failureKind).toBe('txt_lost');
  });

  it('lost POINTING fails a subdomain as pointing_lost naming its CNAME', async () => {
    const a = await seed('live.acme.test', 'issued', { hoursAgo: 2 });
    answer = { configured: false, issued: true };
    await publicAddressCertificatesService.refreshDueAddresses();
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('failed');
    expect(row.failureKind).toBe('pointing_lost');
    expect(row.failureReason).toContain('CNAME motir-edge.fly.dev');
  });

  it('…and an APEX as pointing_lost naming its A record', async () => {
    const a = await seed('acme-roadmap.test', 'issued', { hoursAgo: 2 });
    answer = { configured: false, issued: true };
    await publicAddressCertificatesService.refreshDueAddresses();
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.failureKind).toBe('pointing_lost');
    expect(row.failureReason).toContain('A 66.241.125.1');
    expect(row.failureReason).not.toContain('CNAME');
  });

  it('ISSUED → EXPIRED now carries certificate_lost', async () => {
    const a = await seed('live.acme.test', 'issued', { hoursAgo: 2 });
    answer = { configured: false, issued: false };
    await publicAddressCertificatesService.refreshDueAddresses();
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('expired');
    expect(row.failureKind).toBe('certificate_lost');
  });

  it('RECOVERS: a txt_lost row whose TXT is back returns to issued, kind and reason cleared, issuedAt kept', async () => {
    const a = await seed('live.acme.test', 'failed', { hoursAgo: 2 });
    const issuedAt = new Date(Date.now() - 86_400_000);
    await adminDb.publicAddress.update({
      where: { id: a.id },
      data: { failureKind: 'txt_lost', failureReason: 'gone', issuedAt },
    });
    answer = { configured: true, issued: true };

    await publicAddressCertificatesService.refreshDueAddresses();
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('issued');
    expect(row.failureKind).toBeNull();
    expect(row.failureReason).toBeNull();
    expect(row.issuedAt?.toISOString()).toBe(issuedAt.toISOString());
  });

  it('a RESOLVER ERROR is not a miss: nothing moves, the failure is counted, the run goes on', async () => {
    const flaky = await seed('flaky.acme.test', 'issued', { hoursAgo: 2 });
    const other = await seed('pending.acme.test', 'pending_certificate');
    answer = { configured: true, issued: true };
    txt = (name) => (name.includes('flaky') ? new Error('SERVFAIL') : []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await publicAddressCertificatesService.refreshDueAddresses();
    expect(summary.failed).toBe(1);
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: flaky.id } });
    expect(row.status).toBe('issued');
    expect(row.failureKind).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('flaky.acme.test'))).toBe(true);
    // The in-flight row is not re-proved, and is still processed.
    expect(
      (await adminDb.publicAddress.findUniqueOrThrow({ where: { id: other.id } })).status,
    ).toBe('issued');
  });

  it('an issuance failure (a failed row with NO kind) is not re-proved', async () => {
    await seed('broken.acme.test', 'failed', { hoursAgo: 2 });
    answer = { configured: false, issued: false };
    await publicAddressCertificatesService.refreshDueAddresses();
    expect(txtReads).toBe(0);
  });

  it('updateStatus with a cleared reason clears the kind — the lifecycle Re-check needs no edit', async () => {
    const a = await seed('live.acme.test', 'failed');
    await adminDb.publicAddress.update({
      where: { id: a.id },
      data: { failureKind: 'pointing_lost', failureReason: 'gone' },
    });
    const { withSystemContext } = await import('@/lib/workspaces/context');
    await withSystemContext((tx) =>
      publicAddressRepository.updateStatus(a.id, { status: 'issued', failureReason: null }, tx),
    );
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.failureKind).toBeNull();
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
          expiresAt: null,
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
