import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { statusDerivationOnTransitioned } from '@/lib/jobs/definitions/statusDerivation';
import type { WorkItemTransitionedData } from '@/lib/jobs/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents, JobTestEngine } from '../../helpers/jobs';

// A GATE DECISION RE-DERIVES THE PARENT (Bug MOTIR-9415) — against a real Postgres,
// through the real decide door and the real `status-derivation/transitioned` job.
//
// The defect: Mark done on a story's LAST manual child moved the child to Done inside
// the decide door's transaction, and nothing emitted `work-item/transitioned` for it. The
// parent rollup rides that event, so the story stayed In Progress with every child
// built — `motir fix` then refused it `not_implemented`, and the Workbench listed it
// under To resume instead of To fix (MOTIR-9364, 2026-10-23).

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { manualWorkGateService } = await import('@/lib/services/manualWorkGateService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

let fx: WorkItemFixture;
let capture: ReturnType<typeof captureJobEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  capture = captureJobEvents();
});

afterEach(() => capture.restore());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

/** The card's reproduction: a story In Progress, one leaf Implemented, and one manual
 *  leaf a run reached and could not do, awaiting its `manual_work` gate. */
async function storyWaitingOnItsManualLeaf() {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Host, a new regular plan' },
    fx.ctx,
  );
  const built = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Add the plan' },
    fx.ctx,
  );
  const manual = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      parentId: story.id,
      title: 'Create the Host prices in Stripe',
      type: 'manual',
      executor: 'human',
    },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(built.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(built.id, 'implemented', fx.ctx);
  await withWorkspaceContext(fx.ctx, (tx) =>
    manualWorkGateService.raise(manual.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
  );
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: manual.id, kind: 'manual_work', state: 'awaiting' },
  });
  return { story, manual, gate };
}

describe('Mark done on the last manual child re-derives its story', () => {
  it('moves the story to Implemented through status-derivation/transitioned', async () => {
    const { story, manual, gate } = await storyWaitingOnItsManualLeaf();
    capture.events.length = 0;

    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    );
    expect(await statusOf(manual.id)).toBe('done');

    // The decision announced the child's move — and nothing has derived the story yet.
    const transitioned = capture.events
      .filter((event) => event.name === 'work-item/transitioned')
      .map((event) => event.data as WorkItemTransitionedData)
      .filter((data) => data.workItemId === manual.id);
    expect(transitioned.map((data) => data.toStatusKey)).toContain('done');
    expect(await statusOf(story.id)).toBe('in_progress');

    // The derivation job each event starts, in emission order: the rollup's
    // `implemented` rung now matches — one child Implemented, the other Done.
    for (const data of transitioned) {
      const { error } = await new JobTestEngine({
        function: statusDerivationOnTransitioned,
        events: [{ name: 'work-item/transitioned', data }],
      }).execute();
      expect(error).toBeUndefined();
    }
    expect(await statusOf(story.id)).toBe('implemented');
  });
});
