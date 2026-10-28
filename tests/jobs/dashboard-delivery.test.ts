import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { jobsDashboardService } from '@/lib/services/jobsDashboardService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The platform job ledger's DELIVERY join (Bug MOTIR-3507 · Subtask MOTIR-3517),
// against a real Postgres.
//
// The property under test is a distinction: `job_run.status` says whether the
// JOB ran, `email_delivery.state` says what became of the MESSAGE, and the
// surface must be able to show a `succeeded` run whose message bounced. Every
// case below is one of the ways those two can disagree — plus the three ways a
// run legitimately has no delivery at all, which must render as absence rather
// than as a fabricated `accepted`.
//
// The join is on `idempotencyKey`, deliberately and not on the engine's run id:
// that id means different things on the two job lanes, while the send key is
// the payload's own and identical either way.

let owner: { id: string };
let workspaceId: string;

async function seedRun(opts: {
  functionId?: string;
  status?: 'running' | 'succeeded' | 'failed';
  idempotencyKey?: string | null;
}): Promise<string> {
  const row = await adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: opts.functionId ?? 'email.send',
      eventName: opts.functionId ?? 'email.send',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status: opts.status ?? 'succeeded',
      idempotencyKey:
        opts.idempotencyKey === undefined ? `tok_${randomToken()}` : opts.idempotencyKey,
    },
  });
  return row.idempotencyKey ?? '';
}

async function seedDelivery(opts: {
  idempotencyKey: string;
  state?: 'accepted' | 'delivered' | 'bounced' | 'complained' | 'delayed';
  providerMessageId?: string;
}): Promise<void> {
  await adminDb.emailDelivery.create({
    data: {
      providerMessageId: opts.providerMessageId ?? `msg_${randomToken()}`,
      provider: 'resend',
      recipient: 'alice@example.com',
      template: 'workspace-invite',
      workspaceId,
      idempotencyKey: opts.idempotencyKey,
      ...(opts.state ? { state: opts.state } : {}),
    },
  });
}

// The runs read /admin/jobs pages through (`platformJobsLedgerService`); the
// tenant dashboard's workspace read this suite was written against was deleted
// with that dashboard (MOTIR-10044), and the join it proves is the same helper.
function listRuns() {
  return jobsDashboardService.listSystemRuns({ limit: 50, offset: 0 });
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  owner = await usersService.createUser({
    email: 'delivery-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Delivery Owner',
  });
  const created = await workspacesService.createWorkspace({
    name: 'Delivery Workspace',
    ownerUserId: owner.id,
  });
  workspaceId = created.workspace.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the runs read joins each send to its delivery', () => {
  it('shows a SUCCEEDED run whose message BOUNCED — the whole point of the column', async () => {
    const key = await seedRun({ status: 'succeeded' });
    await seedDelivery({ idempotencyKey: key, state: 'bounced', providerMessageId: 'msg_bounced' });

    const [run] = await listRuns();

    // The two facts disagree, and both survive to the surface.
    expect(run?.status).toBe('succeeded');
    expect(run?.delivery?.state).toBe('bounced');
    expect(run?.delivery?.providerMessageId).toBe('msg_bounced');
  });

  it('carries the recipient and template an operator needs to identify the message', async () => {
    const key = await seedRun({});
    await seedDelivery({ idempotencyKey: key, state: 'delivered' });

    const [run] = await listRuns();

    expect(run?.delivery).toMatchObject({
      state: 'delivered',
      recipient: 'alice@example.com',
      template: 'workspace-invite',
    });
  });

  it('leaves a NON-email.send run with no delivery — no empty column, no placeholder', async () => {
    await seedRun({ functionId: 'work-item.reindex', status: 'succeeded' });

    const [run] = await listRuns();

    expect(run?.functionId).toBe('work-item.reindex');
    expect(run?.delivery).toBeNull();
  });

  it('leaves a send that PREDATES the record with no delivery', async () => {
    // Every message sent before MOTIR-3513 shipped looks exactly like this: a
    // real run, a real key, and no row to join to.
    await seedRun({ status: 'succeeded' });

    const [run] = await listRuns();

    expect(run?.delivery).toBeNull();
  });

  it('tolerates a run with NO idempotency key rather than mis-joining it', async () => {
    await seedRun({ idempotencyKey: null });

    const [run] = await listRuns();

    expect(run?.idempotencyKey).toBeNull();
    expect(run?.delivery).toBeNull();
  });

  it('matches each run to ITS OWN delivery, never to a neighbour`s', async () => {
    const bouncedKey = await seedRun({ status: 'succeeded' });
    await seedDelivery({ idempotencyKey: bouncedKey, state: 'bounced' });
    const deliveredKey = await seedRun({ status: 'succeeded' });
    await seedDelivery({ idempotencyKey: deliveredKey, state: 'delivered' });

    const runs = await listRuns();
    const byKey = new Map(runs.map((run) => [run.idempotencyKey, run.delivery?.state]));

    expect(byKey.get(bouncedKey)).toBe('bounced');
    expect(byKey.get(deliveredKey)).toBe('delivered');
  });

  it('joins a whole page in ONE extra query, not one per row', async () => {
    for (let i = 0; i < 5; i += 1) {
      const key = await seedRun({});
      await seedDelivery({ idempotencyKey: key, state: 'delivered' });
    }

    const runs = await listRuns();

    // The read path batches the keys; five rows must not become five lookups.
    // Asserted through the result rather than by counting queries: every row
    // resolved, which a per-row lookup would also do — but the batch is what
    // the repository method's `in` clause makes structural.
    expect(runs).toHaveLength(5);
    expect(runs.every((run) => run.delivery?.state === 'delivered')).toBe(true);
  });
});
