import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetShardAccountRefusedError } from '@/lib/ciFleet/errors';
import { TenantAccountRefusedError } from '@/lib/ciFleet/headroomErrors';
import { tenantAccountName } from '@/lib/ciFleet/hostingTenantAccounts';
import { refusalBackoffMs } from '@/lib/ciFleet/poolGrowthPolicy';
import { hostingTenantAccountReconcile } from '@/lib/jobs/definitions/hostingTenantAccountReconcile';
import type { FleetHeadroomAlert } from '@/lib/monitoring/fleetShardHeadroomAlert';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import {
  hostingTenantAccountService as service,
  type TenantReconcileDeps,
} from '@/lib/services/hostingTenantAccountService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE TENANT ACCOUNT ENSURE AND RECONCILE (Story MOTIR-9792 · MOTIR-9942), against
// the real database for the row and the lease, with fake create and bootstrap
// steps standing in for the two AWS-facing services.

const T0 = new Date('2026-10-28T12:00:00Z');
const ACCOUNT_ID = '400000000123';
const SECRET = 'SESSION_SECRET_never_printed';
const EMAIL_MARK = 'distinctive-template.example';
const LEASE_ID = 'hosting-tenant-account-reconcile';

let orgSeq = 0;
let alerts: FleetHeadroomAlert[];
let logs: string[];
let creates: string[];
let bootstraps: string[];
/** What the next create call throws, once. */
let createFailure: Error | null;
/** What the next bootstrap call throws, once. */
let bootstrapFailure: Error | null;
/** Create calls that made an account (a replay finds it). */
let accountsMade: Set<string>;

async function seedOrg() {
  orgSeq += 1;
  return adminDb.organization.create({
    data: { name: `Tenant org ${orgSeq}`, slug: `tenant-svc-${orgSeq}-${Date.now()}` },
  });
}

function deps(at: Date = T0): TenantReconcileDeps {
  return {
    now: () => at,
    alert: (a) => alerts.push(a),
    create: async (organizationId) => {
      creates.push(organizationId);
      if (createFailure) {
        const failure = createFailure;
        createFailure = null;
        throw failure;
      }
      accountsMade.add(organizationId);
      await withSystemContext(async (tx) => {
        await hostingTenantAccountRepository.recordAccountInTx(
          organizationId,
          ACCOUNT_ID,
          'ou-1',
          tx,
        );
      });
      return { accountId: ACCOUNT_ID };
    },
    bootstrap: async (organizationId) => {
      bootstraps.push(organizationId);
      if (bootstrapFailure) {
        const failure = bootstrapFailure;
        bootstrapFailure = null;
        throw failure;
      }
      return { roleCreated: true };
    },
  };
}

const rowOf = (organizationId: string) =>
  withSystemContext((tx) =>
    hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
  );

const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

const refusal = (organizationId: string) =>
  new FleetShardAccountRefusedError(tenantAccountName(organizationId), 'ACCOUNT_LIMIT_EXCEEDED');

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetGrowthPassLease.deleteMany({ where: { id: LEASE_ID } });
  alerts = [];
  creates = [];
  bootstraps = [];
  createFailure = null;
  bootstrapFailure = null;
  accountsMade = new Set();
  logs = [];
  for (const level of ['info', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await adminDb.fleetGrowthPassLease.deleteMany({ where: { id: LEASE_ID } });
});

describe('ensureForOrganization', () => {
  it('writes one requested row, answers not ready, and is idempotent under concurrency', async () => {
    const org = await seedOrg();
    expect(await service.ensureForOrganization(org.id)).toEqual({
      state: 'requested',
      ready: false,
      accountId: null,
    });
    const again = await Promise.all(
      Array.from({ length: 4 }, () => service.ensureForOrganization(org.id)),
    );
    expect(new Set(again.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(await adminDb.hostingTenantAccount.count({ where: { organizationId: org.id } })).toBe(1);
    expect(creates).toEqual([]);
  });
});

describe('runReconcile', () => {
  it('walks a requested row to ready in one pass, then calls nothing', async () => {
    const org = await seedOrg();
    await service.ensureForOrganization(org.id);
    const shardsBefore = await adminDb.fleetShard.count();

    const summary = await service.runReconcile(deps());
    expect(summary).toEqual({
      ran: true,
      organizations: [{ organizationId: org.id, outcome: 'ready' }],
      failures: 0,
    });
    expect(creates).toEqual([org.id]);
    expect(bootstraps).toEqual([org.id]);
    expect(await service.ensureForOrganization(org.id)).toEqual({
      state: 'ready',
      ready: true,
      accountId: ACCOUNT_ID,
    });

    expect(await service.runReconcile(deps(minutes(1)))).toEqual({
      ran: true,
      organizations: [],
      failures: 0,
    });
    expect(await service.reconcileOrganization(org.id, deps(minutes(2)))).toEqual({
      organizationId: org.id,
      outcome: 'already_ready',
    });
    expect(creates).toHaveLength(1);
    expect(bootstraps).toHaveLength(1);
    expect(await adminDb.fleetShard.count()).toBe(shardsBefore);
  });

  it('leaves the row where it was when create throws, and the next pass finishes it', async () => {
    const org = await seedOrg();
    await service.ensureForOrganization(org.id);
    createFailure = Object.assign(new Error(`boom ${SECRET}`), { name: 'AwsManagementApiError' });

    const first = await service.runReconcile(deps());
    expect(first).toMatchObject({ failures: 1 });
    expect(first.organizations).toEqual([{ organizationId: org.id, outcome: 'failed' }]);
    expect((await rowOf(org.id))!.state).toBe('creating');
    expect(logs.join('\n')).toContain('AwsManagementApiError');
    expect(logs.join('\n')).not.toContain(SECRET);

    await service.runReconcile(deps(minutes(1)));
    expect((await rowOf(org.id))!.state).toBe('ready');
    expect(accountsMade.size).toBe(1);
    expect(bootstraps).toHaveLength(1);
  });

  it('a row reaches ready only after bootstrap returns; until then ensure answers not ready', async () => {
    const org = await seedOrg();
    await service.ensureForOrganization(org.id);
    bootstrapFailure = new Error('bootstrap cut off');

    await service.runReconcile(deps());
    expect(await service.ensureForOrganization(org.id)).toEqual({
      state: 'bootstrapping',
      ready: false,
      accountId: ACCOUNT_ID,
    });

    await service.runReconcile(deps(minutes(1)));
    expect(creates).toHaveLength(1);
    expect(bootstraps).toHaveLength(2);
    expect(await service.ensureForOrganization(org.id)).toMatchObject({
      state: 'ready',
      ready: true,
    });
  });

  it.each(['creating', 'bootstrapping', 'ready'] as const)(
    'a pass cut off right after writing %s is finished by the next',
    async (cutAfter) => {
      const org = await seedOrg();
      await service.ensureForOrganization(org.id);
      const original = hostingTenantAccountRepository.setStateInTx.bind(
        hostingTenantAccountRepository,
      );
      let cut = false;
      vi.spyOn(hostingTenantAccountRepository, 'setStateInTx').mockImplementation(
        async (organizationId, state, tx) => {
          const row = await original(organizationId, state, tx);
          if (state === cutAfter && !cut) {
            cut = true;
            throw new Error('cut off');
          }
          return row;
        },
      );

      await service.runReconcile(deps());
      await service.runReconcile(deps(minutes(1)));
      expect((await rowOf(org.id))!.state).toBe('ready');
      expect(accountsMade.size).toBe(1);
      expect(await adminDb.hostingTenantAccount.count()).toBe(1);
    },
  );

  it('records a refusal, alerts, backs off from the stored row, and clears on success', async () => {
    const org = await seedOrg();
    await service.ensureForOrganization(org.id);
    createFailure = refusal(org.id);

    expect((await service.runReconcile(deps())).organizations).toEqual([
      { organizationId: org.id, outcome: 'refused' },
    ]);
    expect(await rowOf(org.id)).toMatchObject({
      state: 'refused',
      refusedCount: 1,
      lastRefusedAt: T0,
    });
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as TenantAccountRefusedError;
    expect(alert).toBeInstanceOf(TenantAccountRefusedError);
    expect(alert).toMatchObject({
      organizationId: org.id,
      accountName: tenantAccountName(org.id),
      reason: 'ACCOUNT_LIMIT_EXCEEDED',
      consecutiveRefusals: 1,
    });

    // Inside the backoff: nothing is called — a fresh read of the stored row.
    const inside = new Date(T0.getTime() + refusalBackoffMs(1) - 1);
    expect((await service.runReconcile(deps(inside))).organizations).toEqual([
      { organizationId: org.id, outcome: 'backing_off' },
    ]);
    expect(creates).toHaveLength(1);

    // After it: retried; refused again counts 2.
    const after = new Date(T0.getTime() + refusalBackoffMs(1));
    createFailure = refusal(org.id);
    await service.runReconcile(deps(after));
    expect(await rowOf(org.id)).toMatchObject({ state: 'refused', refusedCount: 2 });
    expect(alerts.map((a) => (a as TenantAccountRefusedError).consecutiveRefusals)).toEqual([1, 2]);

    const later = new Date(after.getTime() + refusalBackoffMs(2));
    await service.runReconcile(deps(later));
    expect(await rowOf(org.id)).toMatchObject({ state: 'ready', refusedCount: 0 });

    for (const a of alerts) expect(a.message).not.toMatch(new RegExp(`${SECRET}|${EMAIL_MARK}`));
  });

  it('returns ran: false and calls nothing while another holder has the lease', async () => {
    const org = await seedOrg();
    await service.ensureForOrganization(org.id);
    await adminDb.fleetGrowthPassLease.create({
      data: { id: LEASE_ID, holder: 'other', heldUntil: minutes(5) },
    });
    expect(await service.runReconcile(deps())).toEqual({
      ran: false,
      organizations: [],
      failures: 0,
    });
    expect(creates).toEqual([]);
  });

  it('releases the lease after a failing organisation, and still reconciles the others', async () => {
    const failing = await seedOrg();
    const fine = await seedOrg();
    await service.ensureForOrganization(failing.id);
    await service.ensureForOrganization(fine.id);
    const d = deps();
    const create = d.create!;
    d.create = async (organizationId) => {
      if (organizationId === failing.id) throw new TypeError('broken');
      return create(organizationId);
    };

    const summary = await service.runReconcile(d);
    expect(summary.failures).toBe(1);
    expect(new Map(summary.organizations.map((o) => [o.organizationId, o.outcome]))).toEqual(
      new Map([
        [failing.id, 'failed'],
        [fine.id, 'ready'],
      ]),
    );
    expect((await rowOf(failing.id))!.state).toBe('creating');
    expect(await adminDb.fleetGrowthPassLease.findUnique({ where: { id: LEASE_ID } })).toBeNull();
    expect((await service.runReconcile(deps(minutes(1)))).ran).toBe(true);
  });
});

describe('the schedule', () => {
  it('runs every minute, catching up only the latest, with no retry', () => {
    expect(hostingTenantAccountReconcile).toMatchObject({
      id: 'system.hosting-tenant-account-reconcile',
      cron: '* * * * *',
      catchUp: 'latest',
      retryPolicy: 'none',
    });
  });
});

describe('isolation from the fleet', () => {
  it('reaches none of the fleet shard services or repository', () => {
    for (const file of [
      'lib/services/hostingTenantAccountService.ts',
      'tests/services/hostingTenantAccountService.test.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      const imports = source.match(/from '[^']+'/g) ?? [];
      for (const forbidden of [
        'fleetShardService',
        'fleetShardProvisioningService',
        'fleetShardRepository',
      ]) {
        expect(imports.filter((i) => i.includes(forbidden))).toEqual([]);
      }
    }
  });
});
