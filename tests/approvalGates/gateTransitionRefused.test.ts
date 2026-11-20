import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { applyGateTransition } from '@/lib/approvalGates/gateTransition';
import {
  ApprovalGateTransitionRefusedError,
  type ApprovalGateErrorTag,
} from '@/lib/approvalGates/errors';
import { APPROVAL_GATE_STATUS } from '@/lib/approvalGates/httpStatus';
import type { AppliedGateTransition } from '@/lib/approvalGates/registry';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A GATE DECISION WHOSE STATUS HOP THE WORKFLOW REFUSES IS A NAMED REFUSAL (Bug MOTIR-11835),
// on a real Postgres through the one helper every handler's hop passes.
//
// The incident: a child the story's cascade had closed held an awaiting approve-and-merge
// question; Approve moves the card to `approved`, a restricted workflow has no Done →
// Approved edge, and the status funnel's `IllegalTransitionError` reached the frame as
// `UNEXPECTED` — "check your connection" — three presses running.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { workflowPolicyMode: 'restricted' },
  });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function cardAt(status: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `At ${status}` },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { status } });
  return item;
}

const hop = (workItemId: string, to: string, applied: AppliedGateTransition[] = []) =>
  withWorkspaceContext(fx.ctx, (tx) =>
    applyGateTransition({ ctx: fx.ctx, tx, appliedTransitions: applied }, workItemId, to, {}),
  );

describe('applyGateTransition', () => {
  it('names a closed card: Done has no way back to Approved', async () => {
    const item = await cardAt('done');

    const err = await hop(item.id, 'approved').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApprovalGateTransitionRefusedError);
    expect(err).toMatchObject({
      tag: 'APPROVAL_GATE_TRANSITION_REFUSED',
      workItemId: item.id,
      fromStatusKey: 'done',
      toStatusKey: 'approved',
      closed: true,
    });
    // Nothing moved.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'done',
    );
  });

  it('names a refused move on a card that is not closed, without calling it closed', async () => {
    const item = await cardAt('todo');

    await expect(hop(item.id, 'approved')).rejects.toMatchObject({
      tag: 'APPROVAL_GATE_TRANSITION_REFUSED',
      fromStatusKey: 'todo',
      closed: false,
    });
  });

  it('applies and records a legal hop exactly as before', async () => {
    const item = await cardAt('in_review');
    const applied: AppliedGateTransition[] = [];

    await hop(item.id, 'approved', applied);

    expect(applied).toEqual([
      expect.objectContaining({
        workItemId: item.id,
        fromStatusKey: 'in_review',
        toStatusKey: 'approved',
      }),
    ]);
  });

  it('records nothing for a no-op hop', async () => {
    const item = await cardAt('approved');
    const applied: AppliedGateTransition[] = [];

    await hop(item.id, 'approved', applied);

    expect(applied).toEqual([]);
  });

  it('lets every other failure through untouched', async () => {
    await expect(hop('no-such-item', 'approved')).rejects.not.toBeInstanceOf(
      ApprovalGateTransitionRefusedError,
    );
  });

  it('answers 409 — a well-formed request against a card no longer in a state that admits it', () => {
    const tag: ApprovalGateErrorTag = 'APPROVAL_GATE_TRANSITION_REFUSED';
    expect(APPROVAL_GATE_STATUS[tag]).toBe(409);
  });
});
