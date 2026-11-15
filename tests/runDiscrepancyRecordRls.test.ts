import type { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { workItemsService } from '@/lib/services/workItemsService';

// `run_discrepancy_record` / `run_discrepancy_entry` RLS (Task MOTIR-11361) — the
// record holds agent-written customer text, so it must be no more visible than the
// card comment it mirrors: its OWN workspace only, on BOTH tables (RLS does not follow
// the entry's FK to its record), and no public-read or system-admin arm.
//
// ⚠️ The test database connects as a BYPASSRLS superuser, so every assertion drops to
// `motir_app` inside its transaction (`tests/dispatch-run-rls.test.ts` explains).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function asAppRole<T>(
  workspaceId: string | undefined,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

async function seed(fx: WorkItemFixture, text: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Card' },
    fx.ctx,
  );
  return adminDb.runDiscrepancyRecord.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      pointCount: 1,
      decisionCount: 0,
      entries: {
        create: [
          {
            workspaceId: fx.workspaceId,
            kind: 'point',
            position: 1,
            planText: text,
            outcomeText: 'built',
            why: 'why',
          },
        ],
      },
    },
  });
}

describe('run discrepancy record RLS', () => {
  it('both tables show a workspace only its own rows', async () => {
    const a = await makeWorkItemFixture({ name: 'A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'B', identifier: 'BBB' });
    const ra = await seed(a, 'secret of A');
    const rb = await seed(b, 'secret of B');

    const seen = (ws: string | undefined) =>
      asAppRole(ws, async (tx) => ({
        records: (await tx.runDiscrepancyRecord.findMany()).map((r) => r.id),
        entries: (await tx.runDiscrepancyEntry.findMany()).map((e) => e.planText),
      }));
    expect(await seen(a.workspaceId)).toEqual({ records: [ra.id], entries: ['secret of A'] });
    expect(await seen(b.workspaceId)).toEqual({ records: [rb.id], entries: ['secret of B'] });
    // No bound workspace reads nothing — no public or system arm opens it.
    expect(await seen(undefined)).toEqual({ records: [], entries: [] });
  });

  it('refuses a write into another workspace on either table', async () => {
    const a = await makeWorkItemFixture({ name: 'A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'B', identifier: 'BBB' });
    const rb = await seed(b, 'secret of B');
    const item = await adminDb.workItem.findFirstOrThrow({ where: { workspaceId: b.workspaceId } });

    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.runDiscrepancyRecord.create({
          data: {
            workspaceId: b.workspaceId,
            projectId: b.projectId,
            workItemId: item.id,
            pointCount: 0,
            decisionCount: 0,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.runDiscrepancyEntry.create({
          data: {
            workspaceId: b.workspaceId,
            recordId: rb.id,
            kind: 'point',
            position: 2,
            planText: 'x',
            outcomeText: 'y',
            why: 'z',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('the shape constraints hold: no alternatives on a point, no negative count', async () => {
    const a = await makeWorkItemFixture({ name: 'A', identifier: 'AAA' });
    const ra = await seed(a, 'x');
    await expect(
      adminDb.runDiscrepancyEntry.create({
        data: {
          workspaceId: a.workspaceId,
          recordId: ra.id,
          kind: 'point',
          position: 2,
          planText: 'x',
          outcomeText: 'y',
          why: 'z',
          alternatives: 'not on a point',
        },
      }),
    ).rejects.toThrow(/run_discrepancy_entry_alternatives_check/);
    await expect(
      adminDb.runDiscrepancyRecord.update({
        where: { id: ra.id },
        data: { pointCount: -1 },
      }),
    ).rejects.toThrow(/run_discrepancy_record_counts_check/);
  });
});
