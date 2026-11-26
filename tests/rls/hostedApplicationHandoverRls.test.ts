// MOTIR-12126 (Story MOTIR-9800) — row-level security on the two handover tables:
//   - `hosting_tenant_handover_step` is platform-only, like its parent
//     `hosting_tenant_account`: no row is visible and no write lands without
//     `app.system_admin`;
//   - `hosted_application_export` holds a workspace's data, so it takes the house
//     `_active_workspace` shape: a session sees only its own workspace's exports
//     and cannot write into another's.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { TENANT_ACCOUNT_REGION } from '@/lib/ciFleet/hostingTenantAccounts';
import { db } from '@/lib/db';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { hostingTenantHandoverStepRepository } from '@/lib/repositories/hostingTenantHandoverStepRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withSystemContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../helpers/sqlstate';
import { armedTables, rlsEnabledTables } from './policyArms';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Run as the runtime role, bound to one workspace — the test connection is a
 *  superuser and bypasses row-level security. */
function asWorkspace<T>(
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

/** Run as the runtime role with NO context bound at all. */
function asRuntimeRole<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

async function exportIn(identifier: string, storageKey: string) {
  const fx = await makeWorkItemFixture({ name: identifier, identifier });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'app' },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { state: 'created', hostingTarget: 'fly', seedSource: 'initialised' },
  });
  const app = await hostedApplicationService.ensureApplication(row.id);
  const exported = await adminDb.hostedApplicationExport.create({
    data: {
      workspaceId: fx.workspaceId,
      applicationId: app.id,
      kind: 'on_demand',
      requestedByUserId: fx.ownerId,
      storageKey,
      sizeBytes: BigInt(1024),
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
  });
  return { fx, app, exported };
}

describe('the handover tables carry ENABLE and FORCE row-level security', () => {
  it('each is enabled and forced, the step table on the system arm only, the export on the workspace arm', async () => {
    const enabled = await rlsEnabledTables();
    const workspaceArmed = await armedTables('app.workspace_id');
    const systemArmed = await armedTables('app.system_admin');
    expect(enabled.has('hosting_tenant_handover_step')).toBe(true);
    expect(enabled.has('hosted_application_export')).toBe(true);
    expect(systemArmed.has('hosting_tenant_handover_step')).toBe(true);
    expect(workspaceArmed.has('hosting_tenant_handover_step')).toBe(false);
    expect(workspaceArmed.has('hosted_application_export')).toBe(true);
    const forced = await adminDb.$queryRaw<{ relname: string }[]>`
      SELECT relname FROM pg_class
       WHERE relname IN ('hosting_tenant_handover_step', 'hosted_application_export')
         AND relforcerowsecurity
    `;
    expect(forced.map((r) => r.relname).sort()).toEqual([
      'hosted_application_export',
      'hosting_tenant_handover_step',
    ]);
  });
});

describe('hosting_tenant_handover_step RLS — system only', () => {
  async function seedSteps() {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    const account = await withSystemContext((tx) =>
      hostingTenantAccountRepository.ensureRequestedInTx(
        workspace.organizationId,
        TENANT_ACCOUNT_REGION,
        tx,
      ),
    );
    await withSystemContext((tx) =>
      hostingTenantHandoverStepRepository.createAllPending(account.id, tx),
    );
    return { fx, account };
  }

  it('returns no rows to a workspace session or a bare runtime session, and all eight to the system', async () => {
    const { fx, account } = await seedSteps();
    expect(await asWorkspace(fx.workspaceId, (tx) => tx.hostingTenantHandoverStep.count())).toBe(0);
    expect(await asRuntimeRole((tx) => tx.hostingTenantHandoverStep.count())).toBe(0);
    expect(
      await withSystemContext((tx) =>
        hostingTenantHandoverStepRepository.listByTenantAccount(account.id, tx),
      ),
    ).toHaveLength(8);
  });

  it('refuses a write without app.system_admin and changes no row', async () => {
    const { fx, account } = await seedSteps();
    await adminDb.hostingTenantHandoverStep.deleteMany({
      where: { tenantAccountId: account.id, step: 'transfer_repositories' },
    });
    await expect(
      asWorkspace(fx.workspaceId, (tx) =>
        tx.hostingTenantHandoverStep.create({
          data: { tenantAccountId: account.id, step: 'transfer_repositories' },
        }),
      ),
      RLS_DENIAL,
    ).rejects.toSatisfy(isRlsDenial);
    const updated = await asWorkspace(fx.workspaceId, (tx) =>
      tx.hostingTenantHandoverStep.updateMany({
        where: { tenantAccountId: account.id },
        data: { status: 'done' },
      }),
    );
    expect(updated.count).toBe(0);
    expect(
      await adminDb.hostingTenantHandoverStep.count({
        where: { tenantAccountId: account.id, status: 'done' },
      }),
    ).toBe(0);
  });
});

describe('hosted_application_export RLS — the active workspace only', () => {
  it('lets each workspace read its own exports and hides the other’s', async () => {
    const a = await exportIn('AAA', 'exports/a.dump');
    const b = await exportIn('BBB', 'exports/b.dump');
    const ownA = await asWorkspace(a.fx.workspaceId, (tx) => tx.hostedApplicationExport.findMany());
    const ownB = await asWorkspace(b.fx.workspaceId, (tx) => tx.hostedApplicationExport.findMany());
    expect(ownA.map((r) => r.storageKey)).toEqual(['exports/a.dump']);
    expect(ownB.map((r) => r.storageKey)).toEqual(['exports/b.dump']);
    expect(
      await asWorkspace(b.fx.workspaceId, (tx) =>
        tx.hostedApplicationExport.findUnique({ where: { id: a.exported.id } }),
      ),
    ).toBeNull();
    expect(await asRuntimeRole((tx) => tx.hostedApplicationExport.count())).toBe(0);
  });

  it("refuses workspace B's writes into workspace A", async () => {
    const a = await exportIn('AAA', 'exports/a.dump');
    const b = await exportIn('BBB', 'exports/b.dump');
    const insert = asWorkspace(b.fx.workspaceId, (tx) =>
      tx.hostedApplicationExport.create({
        data: {
          workspaceId: a.fx.workspaceId,
          applicationId: a.app.id,
          kind: 'final',
          storageKey: 'exports/evil.dump',
          sizeBytes: BigInt(1),
          expiresAt: new Date('2027-01-01T00:00:00Z'),
        },
      }),
    );
    await expect(insert, RLS_DENIAL).rejects.toSatisfy(isRlsDenial);
    const changed = await asWorkspace(b.fx.workspaceId, async (tx) => ({
      updated: (
        await tx.hostedApplicationExport.updateMany({
          where: { id: a.exported.id },
          data: { storageKey: 'exports/stolen.dump' },
        })
      ).count,
      deleted: (await tx.hostedApplicationExport.deleteMany({ where: { id: a.exported.id } }))
        .count,
    }));
    expect(changed).toEqual({ updated: 0, deleted: 0 });
    const row = await adminDb.hostedApplicationExport.findUniqueOrThrow({
      where: { id: a.exported.id },
    });
    expect(row.storageKey).toBe('exports/a.dump');
  });
});
