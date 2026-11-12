import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  InvalidPlanStepError,
  PlanNotFoundError,
  PlanNotGeneratingError,
} from '@/lib/plans/errors';
import { PLAN_REGISTRATION_BATCH_MAX } from '@/lib/plans/planAuthorRegistration';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../../helpers/sqlstate';

// MOTIR-11085 — a plan KEEPS every hand-off and rename its author sessions registered
// (`plan_author_registration`), the moment it is registered, and stamps the ones its
// level's amend was handed. A walk that dies and is resumed reads the unrelayed ones
// back and hands them to the amend, so a registration the dead attempt made is never
// lost. Every case drives `plansService` against real Postgres and reads the stored
// rows back through `adminDb`, so a service that refused yet answered cannot pass.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function generatingPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The serverless adapter', kind: 'story' } }],
    fx.ctx,
  );
  return plan.id;
}

const rowsOf = (planId: string) =>
  adminDb.planAuthorRegistration.findMany({ where: { planId }, orderBy: { seq: 'asc' } });

const handOff = {
  op: 'register',
  id: 'r-1',
  kind: 'hand_off',
  session: 'planItem:adapter',
  level: 'planItem:story',
  receiver: 'planItem:deploy',
  what: 'Creating the Lambda execution role `mh-shared-exec`.',
  reason: 'belongs_to_receiver',
};

const rename = {
  op: 'register',
  id: 'r-2',
  kind: 'rename',
  session: 'planItem:bucket',
  level: 'planItem:story',
  from: 'assetsBucket',
  to: 'staticAssetsBucket',
  codeFact: '`infra/storage.ts` already exports `assetsBucket` for the CDN logs bucket.',
};

describe('recordPlanRegistrations — a registration is on the plan before the next session opens', () => {
  it('records each register with a plan-wide seq, in call order, unrelayed', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);

    const first = await plansService.recordPlanRegistrations(
      planId,
      { sessionKey: 'ai:job-1:registrations', registrations: [handOff] },
      fx.ctx,
    );
    expect(first).toEqual({ registered: ['r-1'], alreadyRegistered: [], relayed: [] });
    await plansService.recordPlanRegistrations(
      planId,
      { sessionKey: 'ai:job-2:registrations', registrations: [{ ...rename, level: null }] },
      fx.ctx,
    );

    const rows = await rowsOf(planId);
    expect(rows.map((r) => [r.seq, r.registrationId, r.sessionKey, r.kind])).toEqual([
      [1, 'r-1', 'ai:job-1:registrations', 'hand_off'],
      [2, 'r-2', 'ai:job-2:registrations', 'rename'],
    ]);
    expect(rows[0]).toMatchObject({
      registeredBy: 'planItem:adapter',
      level: 'planItem:story',
      receiver: 'planItem:deploy',
      what: handOff.what,
      handOffReason: 'belongs_to_receiver',
      renameFrom: null,
      renameTo: null,
      codeFact: null,
      relayedAt: null,
      outcome: null,
    });
    expect(rows[1]).toMatchObject({
      registeredBy: 'planItem:bucket',
      level: null,
      receiver: null,
      what: null,
      handOffReason: null,
      renameFrom: 'assetsBucket',
      renameTo: 'staticAssetsBucket',
      codeFact: rename.codeFact,
    });
  });

  it('drops a field of the other kind rather than storing it', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanRegistrations(
      planId,
      { sessionKey: 's', registrations: [{ ...handOff, from: 'a', to: 'b', codeFact: 'c' }] },
      fx.ctx,
    );
    expect(await rowsOf(planId)).toMatchObject([
      { renameFrom: null, renameTo: null, codeFact: null },
    ]);
  });

  it('keeps a repeated register of the same id as it was — a retried report records nothing twice', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanRegistrations(
      planId,
      { sessionKey: 's', registrations: [handOff] },
      fx.ctx,
    );
    const again = await plansService.recordPlanRegistrations(
      planId,
      {
        sessionKey: 's',
        registrations: [{ ...handOff, what: 'reworded' }, rename, { ...rename, to: 'other' }],
      },
      fx.ctx,
    );
    expect(again).toEqual({
      registered: ['r-2'],
      alreadyRegistered: ['r-1', 'r-2'],
      relayed: [],
    });
    const rows = await rowsOf(planId);
    expect(rows.map((r) => [r.registrationId, r.what, r.renameTo])).toEqual([
      ['r-1', handOff.what, null],
      ['r-2', null, 'staticAssetsBucket'],
    ]);
  });

  it('stamps a relay with its outcome, and a register after the amend as already relayed', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanRegistrations(
      planId,
      { sessionKey: 's', registrations: [handOff, rename] },
      fx.ctx,
    );
    const relayed = await plansService.recordPlanRegistrations(
      planId,
      {
        sessionKey: 'amend',
        registrations: [
          { op: 'relay', id: 'r-1', outcome: 'raised_as_gap', reason: 'it changes the purpose' },
          { op: 'relay', id: 'r-2', outcome: 'applied', reason: 'renamed in two bodies' },
          { ...handOff, id: 'r-3', relayed: true },
          { op: 'relay', id: 'r-2', outcome: 'applied', reason: 'renamed in two bodies' },
        ],
      },
      fx.ctx,
    );
    expect(relayed).toEqual({
      registered: ['r-3'],
      alreadyRegistered: [],
      relayed: ['r-1', 'r-2'],
    });
    const rows = await rowsOf(planId);
    expect(
      rows.map((r) => [r.registrationId, r.relayedAt !== null, r.outcome, r.outcomeReason]),
    ).toEqual([
      ['r-1', true, 'raised_as_gap', 'it changes the purpose'],
      ['r-2', true, 'applied', 'renamed in two bodies'],
      ['r-3', true, null, null],
    ]);
  });

  it('relays a registration made earlier in the same call', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const result = await plansService.recordPlanRegistrations(
      planId,
      {
        sessionKey: 's',
        registrations: [handOff, { op: 'relay', id: 'r-1', outcome: 'unsettled' }],
      },
      fx.ctx,
    );
    expect(result).toEqual({ registered: ['r-1'], alreadyRegistered: [], relayed: ['r-1'] });
    expect(await rowsOf(planId)).toMatchObject([{ outcome: 'unsettled', outcomeReason: null }]);
  });

  it('refuses a relay of an id the plan does not hold, and writes nothing from the call', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await expect(
      plansService.recordPlanRegistrations(
        planId,
        {
          sessionKey: 's',
          registrations: [
            handOff,
            { op: 'relay', id: 'nope', outcome: 'applied' },
            { op: 'relay', id: 'nope', outcome: 'applied' },
          ],
        },
        fx.ctx,
      ),
    ).rejects.toThrow(/does not hold \(nope\)/);
    await expect(
      plansService.recordPlanRegistrations(
        planId,
        {
          sessionKey: 's',
          registrations: [
            { op: 'relay', id: 'a', outcome: 'applied' },
            { op: 'relay', id: 'b', outcome: 'applied' },
          ],
        },
        fx.ctx,
      ),
    ).rejects.toThrow(/registrations this plan does not hold \(a, b\)/);
    expect(await rowsOf(planId)).toEqual([]);
  });

  it('refuses a malformed batch whole', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const refused = [
      [],
      Array.from({ length: PLAN_REGISTRATION_BATCH_MAX + 1 }, (_, i) => ({
        ...handOff,
        id: `r${i}`,
      })),
      [{ ...handOff, receiver: '  ' }],
      [{ ...rename, codeFact: undefined }],
      [{ ...handOff, kind: 'move' }],
      [{ ...handOff, op: 'close' }],
      [{ op: 'relay', id: 'r-1', outcome: 'done' }],
    ];
    for (const registrations of refused) {
      await expect(
        plansService.recordPlanRegistrations(planId, { sessionKey: 's', registrations }, fx.ctx),
      ).rejects.toBeInstanceOf(InvalidPlanStepError);
    }
    await expect(
      plansService.recordPlanRegistrations(
        planId,
        { sessionKey: '', registrations: [handOff] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await rowsOf(planId)).toEqual([]);
  });

  it('is refused once the plan is no longer generating', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      plansService.recordPlanRegistrations(
        planId,
        { sessionKey: 's', registrations: [handOff] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlanNotGeneratingError);
    expect(await rowsOf(planId)).toEqual([]);
  });

  it('is the seventh exclusive form of reportPlanStep, and names no target', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const result = await plansService.reportPlanStep(
      planId,
      { sessionKey: 's', targetRef: null, registrations: [handOff] },
      fx.ctx,
    );
    expect(result).toEqual({
      kind: 'registrations',
      registrations: { registered: ['r-1'], alreadyRegistered: [], relayed: [] },
    });
    await expect(
      plansService.reportPlanStep(
        planId,
        { sessionKey: 's', targetRef: 'planItem:x', registrations: [rename] },
        fx.ctx,
      ),
    ).rejects.toThrow(/names no target/);
    await expect(
      plansService.reportPlanStep(
        planId,
        { sessionKey: 's', targetRef: null, gaps: [], registrations: [rename] },
        fx.ctx,
      ),
    ).rejects.toThrow(/`lessonCalls` or `registrations`/);
    expect(await rowsOf(planId)).toHaveLength(1);
  });
});

describe('listPlanAuthorRegistrations — the record a resumed walk reads', () => {
  it('reads every registration back in order with its relay state, on a decided plan too', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanRegistrations(
      planId,
      { sessionKey: 's', registrations: [handOff, rename] },
      fx.ctx,
    );
    await plansService.recordPlanRegistrations(
      planId,
      {
        sessionKey: 'amend',
        registrations: [{ op: 'relay', id: 'r-2', outcome: 'applied', reason: 'renamed' }],
      },
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    const registrations = await plansService.listPlanAuthorRegistrations(planId, fx.ctx);
    expect(registrations.map((r) => [r.seq, r.id, r.kind, r.relayed, r.outcome])).toEqual([
      [1, 'r-1', 'hand_off', false, null],
      [2, 'r-2', 'rename', true, { kind: 'applied', reason: 'renamed' }],
    ]);
    expect(registrations[0]).toMatchObject({
      sessionKey: 's',
      session: 'planItem:adapter',
      level: 'planItem:story',
      receiver: 'planItem:deploy',
      what: handOff.what,
      reason: 'belongs_to_receiver',
      from: null,
      to: null,
      codeFact: null,
      relayedAt: null,
    });
    expect(registrations[1]).toMatchObject({
      from: 'assetsBucket',
      to: 'staticAssetsBucket',
      codeFact: rename.codeFact,
    });
    expect(typeof registrations[0]!.registeredAt).toBe('string');
    expect(typeof registrations[1]!.relayedAt).toBe('string');
  });

  it('answers another workspace’s plan as not found', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await expect(plansService.listPlanAuthorRegistrations(planB, a.ctx)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
  });

  it('cascades away with the plan', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanRegistrations(
      planId,
      { sessionKey: 's', registrations: [handOff] },
      fx.ctx,
    );
    await adminDb.plan.delete({ where: { id: planId } });
    expect(await rowsOf(planId)).toEqual([]);
  });
});

describe('the hosted planner’s two doors — written through the step, read back on resume', () => {
  it('records through recordPlanStepForJob and reads back on readPlanProposals', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await adminDb.plan.update({ where: { id: planId }, data: { sourceJobId: 'job-resume' } });
    const auth = { ctx: fx.ctx, projectId: fx.projectId };

    const written = await aiGenerationService.recordPlanStepForJob(
      {
        jobId: 'job-resume',
        planId,
        sessionKey: 'ai:job-dead:registrations',
        targetRef: null,
        registrations: [handOff],
      },
      auth,
    );
    expect(written).toEqual({
      planId,
      registrations: { registered: ['r-1'], alreadyRegistered: [], relayed: [] },
    });

    const read = await aiGenerationService.readPlanProposals('job-resume', fx.ctx);
    expect(read.id).toBe(planId);
    expect(read.raisedGaps).toEqual([]);
    expect(read.authorRegistrations.map((r) => [r.id, r.kind, r.relayed, r.receiver])).toEqual([
      ['r-1', 'hand_off', false, 'planItem:deploy'],
    ]);
  });
});

describe('plan_author_registration RLS — the gate is the parent plan', () => {
  async function asAppRole<T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return fn(tx);
    });
  }

  it('another workspace’s registrations are neither readable nor writable', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await plansService.recordPlanRegistrations(
      planB,
      { sessionKey: 'b', registrations: [handOff] },
      b.ctx,
    );

    expect(await asAppRole(a.workspaceId, (tx) => tx.planAuthorRegistration.findMany())).toEqual(
      [],
    );
    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.planAuthorRegistration.create({
          data: {
            planId: planB,
            registrationId: 'x',
            sessionKey: 'x',
            seq: 99,
            kind: 'hand_off',
            registeredBy: 'smuggled',
          },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    expect(
      await asAppRole(b.workspaceId, (tx) => tx.planAuthorRegistration.findMany()),
    ).toHaveLength(1);
  });
});
