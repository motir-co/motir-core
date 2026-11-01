import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';

// MOTIR-10104 — the migration that repairs the item links a card's SAVED body
// still carries in the proposal scheme. Against a REAL Postgres:
//
//   * MOTIR-5781's pre-fix body shape — three siblings linked by an OLD plan's
//     plan-item ids with no `planItem:` prefix — reads `motir:<cardId>` for the
//     three cards those proposals became;
//   * a link whose id resolves to nothing is REPORTED (a notice naming the card,
//     the field and the token) and left exactly as it was — never guessed;
//   * a plan item in ANOTHER workspace never resolves a link;
//   * a second run changes nothing.
//
// ⚠️ The migration is READ FROM ITS FILE and executed verbatim. A test that
// retyped it would pass while the shipped SQL drifted away.

const DB_TEST_TIMEOUT_MS = 30_000;
const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261030020000_work_item_body_motir_ref_link_repair/migration.sql',
);

/** Run the migration on its own connection and return the notices it raised. */
async function runMigration(): Promise<string[]> {
  const notices: string[] = [];
  const client = new Client({ connectionString: currentWorkerAdminUrl() });
  client.on('notice', (n) => notices.push(n.message ?? ''));
  await client.connect();
  try {
    await client.query(readFileSync(MIGRATION, 'utf8'));
  } finally {
    await client.end();
  }
  return notices;
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** An approved plan whose `add`s became the given cards; returns each add's id. */
async function seedApprovedPlan(f: WorkItemFixture, cardIds: string[]): Promise<string[]> {
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      status: 'approved',
      decidedById: f.ctx.userId,
      decidedAt: new Date(),
    },
  });
  const ids: string[] = [];
  for (const workItemId of cardIds) {
    const item = await adminDb.planItem.create({
      data: {
        workspaceId: f.workspaceId,
        planId: plan.id,
        op: 'add',
        workItemId,
        proposedFields: { title: 'proposal' },
      },
    });
    ids.push(item.id);
  }
  return ids;
}

async function bodyOf(id: string) {
  return adminDb.workItem.findUniqueOrThrow({
    where: { id },
    select: { descriptionMd: true, explanationMd: true, updatedAt: true },
  });
}

describe('the motir-ref body link repair migration (MOTIR-10104)', () => {
  it(
    'rewrites MOTIR-5781’s three old plan-item links to the cards they became',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const host = await createTestWorkItem(fx, { kind: 'task', title: 'The host card' });
      const serving = await createTestWorkItem(fx, { kind: 'task', title: 'Serving' });
      const gate = await createTestWorkItem(fx, { kind: 'task', title: 'The vitest gate' });
      const [hostPi, servingPi, gatePi] = await seedApprovedPlan(fx, [
        host.id,
        serving.id,
        gate.id,
      ]);
      const card = await createTestWorkItem(fx, { kind: 'task', title: 'Story E2E' });
      await adminDb.workItem.update({
        where: { id: card.id },
        data: {
          descriptionMd:
            `Builds on [the host card](motir-ref:${hostPi}) and [serving](motir-ref:${servingPi}).\n` +
            `Gated by [the vitest gate](motir-ref:${gatePi}); again [the host card](motir-ref:${hostPi}).`,
          explanationMd: `Proves [serving](motir-ref:planItem:${servingPi}) end to end.`,
        },
      });
      const before = await bodyOf(card.id);

      const notices = await runMigration();

      const after = await bodyOf(card.id);
      expect(after.descriptionMd).toBe(
        `Builds on [the host card](motir:${host.id}) and [serving](motir:${serving.id}).\n` +
          `Gated by [the vitest gate](motir:${gate.id}); again [the host card](motir:${host.id}).`,
      );
      // The canonical token approve left inert resolves the same way.
      expect(after.explanationMd).toBe(`Proves [serving](motir:${serving.id}) end to end.`);
      // A repair approve owed, not an edit of the card.
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(notices).toEqual([
        'MOTIR-10104 summary: rewrote 4 link(s) on 1 card(s); 0 link(s) resolve to no card',
      ]);
    },
  );

  it(
    'reports a link that resolves to nothing and leaves it unchanged',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const real = await createTestWorkItem(fx, { kind: 'task', title: 'Real' });
      const [realPi] = await seedApprovedPlan(fx, [real.id]);
      // A plan item of another workspace's plan, whose card that workspace owns.
      const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
      const foreign = await createTestWorkItem(other, { kind: 'task', title: 'Foreign' });
      const [foreignPi] = await seedApprovedPlan(other, [foreign.id]);
      // A `modify` row names a card too, but it is not the card a proposal became.
      const modified = await createTestWorkItem(fx, { kind: 'task', title: 'Modified' });
      const plan = await adminDb.plan.create({
        data: { workspaceId: fx.workspaceId, projectId: fx.projectId, status: 'approved' },
      });
      const modifyPi = await adminDb.planItem.create({
        data: {
          workspaceId: fx.workspaceId,
          planId: plan.id,
          op: 'modify',
          workItemId: modified.id,
          patch: {},
        },
      });

      const card = await createTestWorkItem(fx, { kind: 'task', title: 'Mixed' });
      const description =
        `[gone](motir-ref:pi_does_not_exist) [foreign](motir-ref:${foreignPi}) ` +
        `[modified](motir-ref:${modifyPi.id}) [real](motir-ref:${realPi}) ` +
        '[syntax](motir-ref:<id>)';
      await adminDb.workItem.update({
        where: { id: card.id },
        data: { descriptionMd: description },
      });

      const notices = await runMigration();

      expect((await bodyOf(card.id)).descriptionMd).toBe(
        `[gone](motir-ref:pi_does_not_exist) [foreign](motir-ref:${foreignPi}) ` +
          `[modified](motir-ref:${modifyPi.id}) [real](motir:${real.id}) ` +
          '[syntax](motir-ref:<id>)',
      );
      expect([...notices].sort()).toEqual(
        [
          `MOTIR-10104 ${card.identifier} descriptionMd: [gone](motir-ref:pi_does_not_exist) resolves to no card — left unchanged`,
          `MOTIR-10104 ${card.identifier} descriptionMd: [foreign](motir-ref:${foreignPi}) resolves to no card — left unchanged`,
          `MOTIR-10104 ${card.identifier} descriptionMd: [modified](motir-ref:${modifyPi.id}) resolves to no card — left unchanged`,
          'MOTIR-10104 summary: rewrote 1 link(s) on 1 card(s); 3 link(s) resolve to no card',
        ].sort(),
      );
      // The other workspace's own card is untouched by a link it never carried.
      expect((await bodyOf(foreign.id)).descriptionMd).toBeNull();
    },
  );

  it('is idempotent: a second run changes nothing', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const [pi] = await seedApprovedPlan(fx, [target.id]);
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Linker' });
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { descriptionMd: `See [it](motir-ref:${pi}).` },
    });

    await runMigration();
    const once = await bodyOf(card.id);
    const notices = await runMigration();

    expect(await bodyOf(card.id)).toEqual(once);
    expect(once.descriptionMd).toBe(`See [it](motir:${target.id}).`);
    expect(notices).toEqual([
      'MOTIR-10104 summary: rewrote 0 link(s) on 0 card(s); 0 link(s) resolve to no card',
    ]);
  });
});
