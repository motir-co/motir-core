import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { agentReviewViewService } from '@/lib/services/agentReviewViewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE AGENT REVIEW AS THE DEVELOPMENT BLOCK READS IT (Story MOTIR-1626 · MOTIR-6825;
// `design/github/design-notes.md` § 30) — against a REAL Postgres.
//
// What is load-bearing here:
//
//   · ONE READ carries what the frame draws that the gate read does not: the could-not-run
//     reason on the row (§12.6) and the review RUN the band links, found by the key prefix
//     every review run of the gate is opened under.
//   · THE RUN IS THE GATE'S LATEST, in any status, and never another gate's.
//   · A DECIDED gate's reason is history: only an awaiting gate carries one.
//   · A card with no `agent_review` reads null, and the frame is as it was.

let fx: WorkItemFixture;
let itemId: string;

const SET = [
  'moooon/motir-core#131@3f2a91c0000000000000000000000000000000aa',
  'moooon/motir-gateway#57@aa11bb2000000000000000000000000000000000',
].join(',');

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Throttle the public API end to end' },
    fx.ctx,
  );
  itemId = item.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedGate(over: {
  state?: 'awaiting' | 'approved' | 'changes_requested';
  reason?: string | null;
  noteMd?: string | null;
}) {
  const decided = over.state === 'approved' || over.state === 'changes_requested';
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: itemId,
      kind: 'agent_review',
      subjectId: `subject-${Math.random()}`,
      state: over.state ?? 'awaiting',
      subjectVersion: SET,
      reviewUnavailableReason: over.reason ?? null,
      noteMd: over.noteMd ?? null,
      decidedById: decided ? fx.ctx.userId : null,
      decidedByLabel: decided ? 'Ada L.' : null,
      decidedAt: decided ? new Date('2026-09-29T09:52:00Z') : null,
      decidedUnderAuthority: decided ? 'review_agent' : null,
      decisionSource: decided ? 'api' : null,
    },
  });
}

async function seedRun(key: string, startedAt: Date) {
  return adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'review',
      origin: 'hosted',
      createdById: fx.ctx.userId,
      idempotencyKey: key,
      startedAt,
    },
  });
}

describe('agentReviewViewService.readForWorkItem', () => {
  it('reads null for a card that never had an agent review', async () => {
    expect(await agentReviewViewService.readForWorkItem(itemId, fx.ctx)).toBeNull();
  });

  it('carries the gate, the reason on the row and the LATEST run of THAT gate', async () => {
    const gate = await seedGate({ reason: 'hosted_run_out_of_credits' });
    const other = await seedGate({ state: 'approved' });
    await seedRun(`agent-review:${gate.id}:raise`, new Date('2026-09-29T09:41:00Z'));
    const again = await seedRun(
      `agent-review:${gate.id}:again:1`,
      new Date('2026-09-29T10:02:00Z'),
    );
    // Another gate's run, newer still, is not this gate's.
    await seedRun(`agent-review:${other.id}:raise`, new Date('2026-09-29T11:00:00Z'));
    // The OTHER gate is newer by creation, so make the awaiting one the latest.
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { createdAt: new Date(Date.now() + 60_000) },
    });

    const view = await agentReviewViewService.readForWorkItem(itemId, fx.ctx);
    expect(view?.gate.id).toBe(gate.id);
    expect(view?.gate.kind).toBe('agent_review');
    expect(view?.reviewUnavailableReason).toBe('hosted_run_out_of_credits');
    expect(view?.run?.id).toBe(again.id);
    expect(view?.run?.label).toBe('motir review · 2026-09-29 10:02 UTC');
    expect(view?.run?.startedAt).toBe('2026-09-29T10:02:00.000Z');
    // The run's own facts the frame decides its state from (MOTIR-11948): a hosted run the
    // reader started, its status as stored (the default `running`), no agent name.
    expect(view?.run).toMatchObject({
      status: 'running',
      origin: 'hosted',
      agentName: null,
      byViewer: true,
    });
    // The fixture's member is an admin: the routed authority answers, and the stamp is handed.
    expect(typeof view?.canDecide).toBe('boolean');
  });

  it('a decided gate carries its findings and no reason', async () => {
    await seedGate({
      state: 'changes_requested',
      reason: 'no_verdict',
      noteMd: 'Two criteria are not met.',
    });
    const view = await agentReviewViewService.readForWorkItem(itemId, fx.ctx);
    expect(view?.gate.state).toBe('changes_requested');
    expect(view?.gate.noteMd).toBe('Two criteria are not met.');
    expect(view?.gate.decidedUnderAuthority).toBe('review_agent');
    expect(view?.reviewUnavailableReason).toBeNull();
    expect(view?.run).toBeNull();
  });
});
