import { type Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `fleet_in_flight_slot` isolation — direct-DB RLS proof (Story MOTIR-1916 ·
// MOTIR-1997).
//
// ⚠️ WHY THIS TABLE NEEDS ITS OWN PROOF EVEN THOUGH IT IS NOT TENANT DATA. It
// carries `organization_id` / `workspace_id` columns, which is exactly the shape
// a workspace-scoped table has — and it is deliberately NOT one: those columns
// are ATTRIBUTION for an operator's breakdown of who is filling the fleet, never
// a tenancy boundary. The ceiling's own read is unscoped, under the `fleet`
// lock, because the invoice it bounds is Motir's own.
//
// So the property to prove is not "tenant A cannot see tenant B's rows" but the
// stronger one: NO TENANT CONTEXT REACHES THIS TABLE AT ALL, in either
// direction. A row a tenant could DELETE would be a way to mint fleet capacity
// on an account with no provider-side spending cap
// (`docs/decisions/ci-runner-fleet.md` §9); a row a tenant could INSERT would be
// a way to deny it to everyone else. Both are asserted below.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE ROW
// LEVEL SECURITY. Every assertion therefore runs inside a transaction that
// `SET LOCAL ROLE motir_app`. Without the role switch each assertion would
// assert the OPPOSITE of reality.

const EXPIRES_AT = new Date('2026-08-02T18:00:00.000Z');

interface Fixture {
  userId: string;
  workspaceId: string;
  organizationId: string;
  slotId: string;
}

async function seed(): Promise<Fixture> {
  const user = await usersService.createUser({
    email: 'fleet-slot-rls@example.com',
    password: 'hunter2hunter2',
    name: 'Slot Tenant',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Slot WS',
    ownerUserId: user.id,
  });
  const slot = await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'hosted_agent',
      ref: 'hosted-run-1',
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      expiresAt: EXPIRES_AT,
    },
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    slotId: slot.id,
  };
}

/** Run `fn` with the given GUCs bound, as the non-bypass `motir_app` role —
 *  the role switch is what makes RLS actually bite. Reverts at txn end. */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.systemAdmin === true) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('fleet_in_flight_slot RLS — system context only', () => {
  it('with NO GUC set, the motir_app role sees zero slots', async () => {
    await seed();
    expect(await asAppRole({}, (tx) => tx.fleetInFlightSlot.findMany())).toEqual([]);
  });

  // ⚠️ THE ASSERTION THAT MAKES THIS TABLE DIFFERENT FROM ITS SIBLINGS. Binding
  // the workspace whose id is ON THE ROW still shows nothing: `workspace_id` here
  // is attribution, not a gate, and the policy deliberately does not consult it.
  // If this ever goes green through the workspace GUC, the table has quietly
  // become tenant-readable and the columns have quietly become a boundary.
  it("binding the row's OWN workspace GUC still shows nothing", async () => {
    const fx = await seed();
    expect(
      await asAppRole({ userId: fx.userId, workspaceId: fx.workspaceId }, (tx) =>
        tx.fleetInFlightSlot.findMany(),
      ),
    ).toEqual([]);
  });

  // A tenant that could DELETE a slot could mint fleet capacity for itself on an
  // account with no provider-side spending cap.
  it('a tenant context cannot DELETE a slot', async () => {
    const fx = await seed();
    const deleted = await asAppRole({ userId: fx.userId, workspaceId: fx.workspaceId }, (tx) =>
      tx.fleetInFlightSlot.deleteMany({ where: { id: fx.slotId } }),
    );
    expect(deleted.count).toBe(0);
    const fleetInFlightSlotCount = await adminDb.fleetInFlightSlot.count();
    expect(fleetInFlightSlotCount).toBe(1);
  });

  // ...and one that could INSERT could deny the fleet to everyone else.
  it('a tenant context cannot INSERT a slot', async () => {
    const fx = await seed();
    await expect(
      asAppRole({ userId: fx.userId, workspaceId: fx.workspaceId }, (tx) =>
        tx.fleetInFlightSlot.create({
          data: {
            workload: 'hosted_agent',
            ref: 'forged',
            organizationId: fx.organizationId,
            workspaceId: fx.workspaceId,
            expiresAt: EXPIRES_AT,
          },
        }),
      ),
    ).rejects.toThrow();
    const fleetInFlightSlotCount = await adminDb.fleetInFlightSlot.count();
    expect(fleetInFlightSlotCount).toBe(1);
  });

  // The system context — the ONLY reach every caller of this table has, since
  // CI admission and Epic 9's agent dispatch run under
  // `withSystemContext` with no session and no active workspace.
  it('the system_admin GUC sees and mutates slots', async () => {
    const fx = await seed();
    const rows = await asAppRole({ systemAdmin: true }, (tx) => tx.fleetInFlightSlot.findMany());
    expect(rows.map((r) => r.ref)).toEqual(['hosted-run-1']);

    const deleted = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.fleetInFlightSlot.deleteMany({ where: { id: fx.slotId } }),
    );
    expect(deleted.count).toBe(1);
  });
});
