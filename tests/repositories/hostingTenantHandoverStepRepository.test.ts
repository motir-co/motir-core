import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { TENANT_ACCOUNT_REGION, TENANT_HANDOVER_STEPS } from '@/lib/ciFleet/hostingTenantAccounts';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { hostingTenantHandoverStepRepository as repo } from '@/lib/repositories/hostingTenantHandoverStepRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { isRlsDenial } from '../helpers/sqlstate';

// THE HANDOVER'S STEP ROWS (Story MOTIR-9800 · MOTIR-12126), against the real
// database: one row per step per account, created idempotently, listed in run
// order, taken under a lease only one worker can hold, and readable by the system
// context alone.

let orgSeq = 0;
async function seedAccount(): Promise<string> {
  orgSeq += 1;
  const org = await adminDb.organization.create({
    data: { name: `Handover org ${orgSeq}`, slug: `handover-org-${orgSeq}-${Date.now()}` },
  });
  const row = await withSystemContext((tx) =>
    hostingTenantAccountRepository.ensureRequestedInTx(org.id, TENANT_ACCOUNT_REGION, tx),
  );
  return row.id;
}

const NOW = new Date('2026-11-23T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('hostingTenantHandoverStepRepository', () => {
  it('creates every step pending once, and a replay changes nothing', async () => {
    const account = await seedAccount();
    expect(await withSystemContext((tx) => repo.createAllPending(account, tx))).toBe(8);
    await withSystemContext((tx) =>
      repo.tryClaim(account, 'destroy_previews', 'w1', NOW, later(60_000), tx),
    );
    expect(await withSystemContext((tx) => repo.createAllPending(account, tx))).toBe(0);
    const rows = await withSystemContext((tx) => repo.listByTenantAccount(account, tx));
    expect(rows.map((r) => r.step)).toEqual([...TENANT_HANDOVER_STEPS]);
    expect(rows[0]).toMatchObject({ status: 'running', attempts: 1 });
    expect(rows.slice(1).every((r) => r.status === 'pending' && r.attempts === 0)).toBe(true);
  });

  it('lists steps in run order even when they were written out of it', async () => {
    const account = await seedAccount();
    for (const step of [...TENANT_HANDOVER_STEPS].reverse()) {
      await adminDb.hostingTenantHandoverStep.create({ data: { tenantAccountId: account, step } });
    }
    const rows = await withSystemContext((tx) => repo.listByTenantAccount(account, tx));
    expect(rows.map((r) => r.step)).toEqual([...TENANT_HANDOVER_STEPS]);
  });

  it('lets one holder take a step, refuses a second until the lease expires, and counts each attempt', async () => {
    const account = await seedAccount();
    await withSystemContext((tx) => repo.createAllPending(account, tx));
    const claim = (holder: string, at: Date) =>
      withSystemContext((tx) =>
        repo.tryClaim(account, 'move_email', holder, at, new Date(at.getTime() + 60_000), tx),
      );
    expect(await claim('w1', NOW)).toBe(true);
    expect(await claim('w2', later(30_000))).toBe(false);
    expect(await claim('w2', later(60_000))).toBe(true);
    const row = await adminDb.hostingTenantHandoverStep.findUniqueOrThrow({
      where: { tenantAccountId_step: { tenantAccountId: account, step: 'move_email' } },
    });
    expect(row).toMatchObject({ status: 'running', leaseHolder: 'w2', attempts: 2 });
    expect(row.startedAt).toEqual(later(60_000));
  });

  it('hands a step to exactly one of two concurrent claimers', async () => {
    const account = await seedAccount();
    await withSystemContext((tx) => repo.createAllPending(account, tx));
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        withSystemContext((tx) =>
          repo.tryClaim(account, 'open_upstream', `w${i}`, NOW, later(60_000), tx),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await adminDb.hostingTenantHandoverStep.findUniqueOrThrow({
      where: { tenantAccountId_step: { tenantAccountId: account, step: 'open_upstream' } },
    });
    expect(row.attempts).toBe(1);
  });

  it('lets only the holder finish a step; done stamps completion and is never taken again', async () => {
    const account = await seedAccount();
    await withSystemContext((tx) => repo.createAllPending(account, tx));
    await withSystemContext((tx) =>
      repo.tryClaim(account, 'remove_access', 'w1', NOW, later(60_000), tx),
    );
    expect(
      await withSystemContext((tx) =>
        repo.setStatus(account, 'remove_access', { status: 'done' }, 'w2', tx),
      ),
    ).toBe(false);
    expect(
      await withSystemContext((tx) =>
        repo.setStatus(account, 'remove_access', { status: 'done' }, 'w1', tx),
      ),
    ).toBe(true);
    const row = await adminDb.hostingTenantHandoverStep.findUniqueOrThrow({
      where: { tenantAccountId_step: { tenantAccountId: account, step: 'remove_access' } },
    });
    expect(row).toMatchObject({
      status: 'done',
      leaseHolder: null,
      leaseExpiresAt: null,
      lastError: null,
    });
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(
      await withSystemContext((tx) =>
        repo.tryClaim(account, 'remove_access', 'w3', later(120_000), later(180_000), tx),
      ),
    ).toBe(false);
  });

  it('records a failure by error name and frees the step for the next attempt', async () => {
    const account = await seedAccount();
    await withSystemContext((tx) => repo.createAllPending(account, tx));
    await withSystemContext((tx) =>
      repo.tryClaim(account, 'leave_organization', 'w1', NOW, later(60_000), tx),
    );
    await withSystemContext((tx) =>
      repo.setStatus(
        account,
        'leave_organization',
        { status: 'failed', lastError: 'ConstraintViolationException' },
        'w1',
        tx,
      ),
    );
    const failed = await adminDb.hostingTenantHandoverStep.findUniqueOrThrow({
      where: { tenantAccountId_step: { tenantAccountId: account, step: 'leave_organization' } },
    });
    expect(failed).toMatchObject({
      status: 'failed',
      lastError: 'ConstraintViolationException',
      leaseHolder: null,
      completedAt: null,
    });
    expect(
      await withSystemContext((tx) =>
        repo.tryClaim(account, 'leave_organization', 'w2', later(2_000), later(62_000), tx),
      ),
    ).toBe(true);
  });

  it('records a failure with no error name as null', async () => {
    const account = await seedAccount();
    await withSystemContext((tx) => repo.createAllPending(account, tx));
    await withSystemContext((tx) =>
      repo.tryClaim(account, 'create_deploy_role', 'w1', NOW, later(60_000), tx),
    );
    await withSystemContext((tx) =>
      repo.setStatus(account, 'create_deploy_role', { status: 'failed' }, 'w1', tx),
    );
    const row = await adminDb.hostingTenantHandoverStep.findUniqueOrThrow({
      where: { tenantAccountId_step: { tenantAccountId: account, step: 'create_deploy_role' } },
    });
    expect(row).toMatchObject({ status: 'failed', lastError: null });
  });

  it('parks a step waiting on the organisation without an error', async () => {
    const account = await seedAccount();
    await withSystemContext((tx) => repo.createAllPending(account, tx));
    await withSystemContext((tx) =>
      repo.tryClaim(account, 'await_standalone', 'w1', NOW, later(60_000), tx),
    );
    await withSystemContext((tx) =>
      repo.setStatus(
        account,
        'await_standalone',
        { status: 'waiting_on_you', lastError: 'ignored' },
        'w1',
        tx,
      ),
    );
    const row = await adminDb.hostingTenantHandoverStep.findUniqueOrThrow({
      where: { tenantAccountId_step: { tenantAccountId: account, step: 'await_standalone' } },
    });
    expect(row).toMatchObject({ status: 'waiting_on_you', lastError: null, completedAt: null });
  });

  it('refuses an unknown step or status at the database, and one row per step', async () => {
    const account = await seedAccount();
    await expect(
      adminDb.hostingTenantHandoverStep.create({
        data: { tenantAccountId: account, step: 'close_account' },
      }),
    ).rejects.toThrow();
    await expect(
      adminDb.hostingTenantHandoverStep.create({
        data: { tenantAccountId: account, step: 'move_email', status: 'skipped' },
      }),
    ).rejects.toThrow();
    await adminDb.hostingTenantHandoverStep.create({
      data: { tenantAccountId: account, step: 'move_email' },
    });
    await expect(
      adminDb.hostingTenantHandoverStep.create({
        data: { tenantAccountId: account, step: 'move_email' },
      }),
    ).rejects.toThrow();
  });

  it('is readable and writable by the system context alone', async () => {
    const account = await seedAccount();
    await withSystemContext((tx) => repo.createAllPending(account, tx));
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.hostingTenantHandoverStep.count();
    });
    expect(seen).toBe(0);
    const write = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.hostingTenantHandoverStep.create({
        data: { tenantAccountId: account, step: 'destroy_previews' },
      });
    });
    await expect(write).rejects.toSatisfy(isRlsDenial);
  });
});
