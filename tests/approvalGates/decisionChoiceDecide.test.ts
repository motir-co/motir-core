import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced } from '../helpers/transitionedEvents';

// THE DECIDE DOOR TAKES A CHOICE (Story MOTIR-4914 · Subtask MOTIR-5893; ADR
// `approval-gates.md` §1's MOTIR-5887 amendment, points 5–7). Real Postgres, the
// real route and the real server action: `choose` + `optionId` on a waiting
// `decision_choice` gate writes `done`, records the option's id as `outcomeRef`
// and stamps `chosenOption` in the deciding write — which the immutability
// trigger then holds. A verb the gate does not offer is a NAMED 400.

const signedIn = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));
const session = { current: null as { user: { id: string; email: string; name: string } } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
const activeProject = { current: null as unknown };
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeProject.current,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { ApprovalGateDecidedImmutableError, ApprovalGateVerbNotOfferedError } =
  await import('@/lib/approvalGates/errors');
const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');
const { decideApprovalGateAction } = await import('@/app/(authed)/items/[key]/approvalGateActions');

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  signedIn.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: fx.owner.name } };
  activeProject.current = { ...fx.ctx, projectId: fx.projectId, project: fx.project };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const COMPLETE = [
  '## Question',
  'Where do exported reports live?',
  '## Why this is a choice',
  '**Situation:** two workflows',
  'The requirement names both a download and a shared link.',
  '## Options',
  '### Managed object storage',
  '**Best if you want:** less to operate',
  'The provider runs it.',
  '### Our own Postgres',
  '**Best if you want:** more cost-effective',
  'No new vendor.',
  '## What this choice gates',
  'The export story, laid once the store is known.',
].join('\n');

async function waitingChoice() {
  seq += 1;
  const item = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Choose ${seq}`,
      type: 'choice',
      executor: 'human',
      descriptionMd: COMPLETE,
    },
    fx.ctx,
  );
  const read = await approvalGatesService.getForWorkItem(
    { workItemId: item.id, kind: 'decision_choice' },
    fx.ctx,
  );
  expect(read.gate?.state).toBe('awaiting');
  return { item, gateId: read.gate!.id, stamp: read.stamp! };
}

function post(gateId: string, body: Record<string, unknown>) {
  return decideRoute(
    new Request(`http://localhost/api/approval-gates/${gateId}/decide`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: gateId }) },
  );
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

const CHOSEN = {
  optionId: 'our-own-postgres',
  label: 'Our own Postgres',
  bestFor: 'more cost-effective',
  followUp: 'The export story, laid once the store is known.',
  situation: 'two_workflows',
};

describe('choose — the route', () => {
  it('writes done, records the option as outcomeRef and stamps chosenOption', async () => {
    const { item, gateId, stamp } = await waitingChoice();
    // The `done` it writes is announced after the commit (Bug MOTIR-9415).
    const { result: res, hops } = await expectEachHopAnnounced(
      item.id,
      { workspaceId: fx.workspaceId, actorId: fx.ownerId },
      () => post(gateId, { decision: 'choose', optionId: 'our-own-postgres', stamp }),
    );
    expect(hops).toEqual([{ fromStatusKey: 'in_review', toStatusKey: 'done' }]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { gate: { state: string; chosenOption: unknown } };
    expect(body.gate.state).toBe('approved');
    expect(body.gate.chosenOption).toEqual(CHOSEN);

    expect(await statusOf(item.id)).toBe('done');
    const row = await gateRow(gateId);
    expect(row).toMatchObject({ state: 'approved', outcomeRef: 'our-own-postgres' });
    expect(row.chosenOption).toEqual(CHOSEN);
  });

  it('needs an optionId with choose — a 400 before anything is read', async () => {
    const { gateId, stamp } = await waitingChoice();
    const res = await post(gateId, { decision: 'choose', stamp });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    expect((await gateRow(gateId)).state).toBe('awaiting');
  });

  it('an option the choice does not hold is a NAMED 400, and nothing is written', async () => {
    const { item, gateId, stamp } = await waitingChoice();
    const res = await post(gateId, { decision: 'choose', optionId: 'a-cdn', stamp });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
      reason: 'unknown_option',
    });
    expect((await gateRow(gateId)).state).toBe('awaiting');
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('approve sent to a choice is a NAMED 400 — a choice recommends nothing', async () => {
    const { gateId, stamp } = await waitingChoice();
    const res = await post(gateId, { decision: 'approve', stamp });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'APPROVAL_GATE_VERB_NOT_OFFERED',
      reason: 'approve_on_choice',
    });
    expect((await gateRow(gateId)).state).toBe('awaiting');
  });

  it('a stale stamp is the shipped stale refusal', async () => {
    const { item, gateId, stamp } = await waitingChoice();
    // Rewording the question moves the description half of the stamp but not
    // the gate's subject version — the gate stands and the press is stale.
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: COMPLETE.replace('Where do exported', 'Where should exported') },
      fx.ctx,
    );
    const res = await post(gateId, { decision: 'choose', optionId: 'our-own-postgres', stamp });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'APPROVAL_GATE_STALE_SUBJECT' });
    expect((await gateRow(gateId)).state).toBe('awaiting');
  });

  it('None of these is changes_requested, moves nothing and stamps no pick', async () => {
    const { item, gateId, stamp } = await waitingChoice();
    // A decision that writes no status announces none.
    const { result: res, hops } = await expectEachHopAnnounced(
      item.id,
      { workspaceId: fx.workspaceId, actorId: fx.ownerId },
      () =>
        post(gateId, {
          decision: 'request_changes',
          noteMd: 'Neither — what about the customer’s own bucket?',
          stamp,
        }),
    );
    expect(hops).toEqual([]);
    expect(res.status).toBe(200);
    const row = await gateRow(gateId);
    expect(row).toMatchObject({ state: 'changes_requested', outcomeRef: null });
    expect(row.chosenOption).toBeNull();
    expect(await statusOf(item.id)).toBe('in_review');
  });
});

describe('choose — the server action mirrors the route', () => {
  it('a press through the action writes the same record', async () => {
    const { item, gateId, stamp } = await waitingChoice();
    const result = await decideApprovalGateAction({
      gateId,
      decision: 'choose',
      optionId: 'managed-object-storage',
      identifier: item.identifier,
      stamp,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.gate.outcomeRef).toBe('managed-object-storage');
    expect(await statusOf(item.id)).toBe('done');
  });

  it('refuses an unknown option in the frame’s vocabulary', async () => {
    const { item, gateId, stamp } = await waitingChoice();
    const result = await decideApprovalGateAction({
      gateId,
      decision: 'choose',
      optionId: 'a-cdn',
      identifier: item.identifier,
      stamp,
    });
    expect(result).toEqual({ ok: false, refusal: { tag: 'APPROVAL_GATE_VERB_NOT_OFFERED' } });
  });
});

describe('choose sent to a gate that asks no choice', () => {
  it('is refused as a verb the gate does not offer', async () => {
    // A `design_result` gate on an ordinary card — the door's check reads the KIND
    // under the lock, so no design evidence is needed to reach it.
    seq += 1;
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `Design ${seq}`, type: 'design' },
      fx.ctx,
    );
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.createAwaitingIfAbsent(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'design_result',
          subjectId: 'evidence-1',
          routedToId: fx.ownerId,
        },
        tx,
      ),
    );
    const gate = await adminDb.approvalGate.findFirstOrThrow({ where: { workItemId: item.id } });
    await expect(
      approvalGatesService.decide(
        {
          gateId: gate.id,
          decision: 'choose',
          optionId: 'anything',
          source: 'ui',
          stamp: DECIDED_WITHOUT_A_READER,
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject(new ApprovalGateVerbNotOfferedError(gate.id, 'choose_on_other_kind'));
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });
});

describe('the record is immutable once decided', () => {
  it('an UPDATE of chosenOption on a decided row is refused by the trigger', async () => {
    const { gateId, stamp } = await waitingChoice();
    expect(
      (await post(gateId, { decision: 'choose', optionId: 'our-own-postgres', stamp })).status,
    ).toBe(200);
    await expect(
      adminDb.approvalGate.update({
        where: { id: gateId },
        data: { chosenOption: { ...CHOSEN, optionId: 'managed-object-storage' } },
      }),
    ).rejects.toThrow(/AG_DECIDED_IMMUTABLE/);
    // …and through the repository the same refusal arrives typed.
    const row = await gateRow(gateId);
    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.decide(
          gateId,
          {
            state: 'approved',
            decidedById: fx.ownerId,
            decidedAt: new Date(),
            noteMd: null,
            subjectVersion: row.subjectVersion,
            decidedByLabel: row.decidedByLabel,
            decidedUnderAuthority: 'assignee',
            decisionSource: 'ui',
            outcomeRef: 'managed-object-storage',
            confirmedRecord: null,
            refusalVerdict: null,
            chosenOption: {
              ...CHOSEN,
              optionId: 'managed-object-storage',
              situation: 'two_workflows',
            },
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ApprovalGateDecidedImmutableError);
  });
});
