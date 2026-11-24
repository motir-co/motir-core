import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { ApprovalGateSupersededError } from '@/lib/approvalGates/errors';
import { RUNG_RANK, rankOfStatus, withdrawsPendingQuestion } from '@/lib/workItems/statusLadder';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// PULLING THE WORK BACK WITHDRAWS THE QUESTION (Story MOTIR-4887 · Subtask
// MOTIR-5527; ADR `docs/decisions/approval-gates.md` §6d AMENDMENT, rules 6 and 8).
//
// Two things are proven, and the second is the one an argument cannot settle:
//
//   · THE WITHDRAW. A hand move out of the review band, or to Cancelled,
//     supersedes the item's `awaiting` gates in the funnel's own transaction —
//     and writes `state` only, so the audit never reads it as a decision.
//     `→ blocked` keeps the question; a system write withdraws nothing; a decided
//     gate is never touched.
//   · THE LOCK ORDER. An approval and a pull-back racing on one card must not
//     deadlock (`40P01`), and each run must land on one of the two consistent
//     outcomes. Driven with genuine concurrency over repeated runs — a serial
//     assertion passes with the locks in either order, which is precisely the bug.
//
// Real Postgres, per the repo convention.

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

/** A design subtask walked to `stopAt`, with an `awaiting` gate raised at
 *  `raiseAt` on the way (so a gate can predate review). */
async function gatedItem(
  opts: { stopAt?: 'in_progress' | 'in_review'; raiseAt?: 'in_progress' | 'in_review' } = {},
) {
  seq += 1;
  const stopAt = opts.stopAt ?? 'in_review';
  const raiseAt = opts.raiseAt ?? stopAt;
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: `Story ${seq}` },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: `Design ${seq}` },
    fx.ctx,
  );
  const raise = () =>
    withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'design_result',
          subjectId: `subject-${item.id}`,
        },
        tx,
      ),
    );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  let gate = raiseAt === 'in_progress' ? await raise() : null;
  if (stopAt === 'in_review') {
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    gate ??= await raise();
  }
  return { itemId: item.id, gateId: gate!.id };
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

describe('a hand move that pulls the work back withdraws the question', () => {
  it('`in_review → in_progress` supersedes the gate, and records no decision', async () => {
    const { itemId, gateId } = await gatedItem();

    await workItemsService.updateStatus(itemId, 'in_progress', fx.ctx);

    const row = await gateRow(gateId);
    expect(row.state).toBe('superseded');
    expect(row.decidedById).toBeNull();
    expect(row.decidedAt).toBeNull();
    expect(row.noteMd).toBeNull();
  });

  it('`in_review → cancelled` supersedes the gate', async () => {
    const { itemId, gateId } = await gatedItem();
    await workItemsService.updateStatus(itemId, 'cancelled', fx.ctx);
    expect((await gateRow(gateId)).state).toBe('superseded');
  });

  it('`in_review → blocked` KEEPS the question — blocking pauses, it does not abandon', async () => {
    const { itemId, gateId } = await gatedItem();
    await workItemsService.updateStatus(itemId, 'blocked', fx.ctx);
    expect(await statusOf(itemId)).toBe('blocked');
    expect((await gateRow(gateId)).state).toBe('awaiting');
  });

  it('a move that never leaves the review band keeps it — `in_progress → todo`', async () => {
    const { itemId, gateId } = await gatedItem({ stopAt: 'in_progress', raiseAt: 'in_progress' });
    await workItemsService.updateStatus(itemId, 'todo', fx.ctx);
    expect(await statusOf(itemId)).toBe('todo');
    expect((await gateRow(gateId)).state).toBe('awaiting');
  });

  it('a SYSTEM write withdraws nothing', async () => {
    const { itemId, gateId } = await gatedItem();
    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemsService.applyStatusTransition(itemId, 'in_progress', fx.ctx, tx, { system: true }),
    );
    expect((await gateRow(gateId)).state).toBe('awaiting');
  });

  it('a DECIDED gate is never touched', async () => {
    const { itemId, gateId } = await gatedItem();
    await adminDb.approvalGate.update({ where: { id: gateId }, data: { state: 'approved' } });

    await workItemsService.updateStatus(itemId, 'in_progress', fx.ctx);

    expect((await gateRow(gateId)).state).toBe('approved');
  });
});

describe('`withdrawsPendingQuestion` — the predicate, on its own', () => {
  const statuses = [
    { key: 'todo', category: 'todo' as const },
    { key: 'blocked', category: 'todo' as const },
    { key: 'in_progress', category: 'in_progress' as const },
    { key: 'in_review', category: 'in_progress' as const },
    { key: 'done', category: 'done' as const },
    { key: 'cancelled', category: 'done' as const },
  ];
  const keys = { reviewKey: 'in_review', implementedKey: null, approvedKey: null, toPlanKey: null };
  const w = (fromKey: string, toKey: string, system = false) =>
    withdrawsPendingQuestion({ fromKey, toKey, statuses, keys, system });

  it('is keyed on the review rung, not on a category', () => {
    expect(rankOfStatus('in_review', statuses, keys)).toBe(RUNG_RANK.in_review);
    expect(w('in_review', 'in_progress')).toBe(true);
    expect(w('in_review', 'todo')).toBe(true);
    expect(w('done', 'in_progress')).toBe(true);
    expect(w('in_progress', 'todo')).toBe(false);
    expect(w('in_progress', 'in_review')).toBe(false);
  });

  it('cancelling always withdraws; blocking never does; a system write never does', () => {
    expect(w('in_progress', 'cancelled')).toBe(true);
    expect(w('in_review', 'blocked')).toBe(false);
    expect(w('in_review', 'in_progress', true)).toBe(false);
    expect(w('in_review', 'cancelled', true)).toBe(false);
  });
});

describe('an approval and a pull-back RACING on one card (rule 8, the lock order)', () => {
  it('never deadlocks, and every run lands on one of the two consistent outcomes', async () => {
    const outcomes = { approvedFirst: 0, pulledBackFirst: 0 };

    for (let run = 0; run < 8; run += 1) {
      const { itemId, gateId } = await gatedItem();

      // The barrier: both operations are created before either is awaited, so
      // their transactions open together on separate pooled connections.
      const [decided, moved] = await Promise.allSettled([
        approvalGatesService.decide(
          { stamp: DECIDED_WITHOUT_A_READER, gateId, decision: 'approve', source: 'ui' },
          fx.ctx,
        ),
        workItemsService.updateStatus(itemId, 'in_progress', fx.ctx),
      ]);

      for (const r of [decided, moved]) {
        if (r.status === 'rejected') {
          expect(String((r.reason as { code?: string })?.code ?? r.reason)).not.toContain('40P01');
          expect(String(r.reason)).not.toMatch(/deadlock/i);
        }
      }

      const gate = await gateRow(gateId);
      const status = await statusOf(itemId);

      if (gate.state === 'approved') {
        // The approval won: it wrote `done`; the pull-back then applied as a
        // reopen (`done → in_progress`, a declared edge) and withdrew nothing,
        // because nothing was awaiting any more.
        expect(decided.status).toBe('fulfilled');
        expect(moved.status).toBe('fulfilled');
        expect(status).toBe('in_progress');
        outcomes.approvedFirst += 1;
      } else {
        // The pull-back won: the question was withdrawn, and the door refused a
        // superseded gate rather than approving work no longer on offer.
        expect(gate.state).toBe('superseded');
        expect(status).toBe('in_progress');
        expect(moved.status).toBe('fulfilled');
        expect(decided.status).toBe('rejected');
        expect((decided as PromiseRejectedResult).reason).toBeInstanceOf(
          ApprovalGateSupersededError,
        );
        outcomes.pulledBackFirst += 1;
      }
    }

    expect(outcomes.approvedFirst + outcomes.pulledBackFirst).toBe(8);
  });
});
