import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import * as sendEventModule from '@/lib/jobs/sendEvent';
import type { WorkspaceContext } from '@/lib/workspaces';
import {
  AgentRunReviewTargetRequiredError,
  ReviewInMyAgentNotOfferedError,
} from '@/lib/agentInstances/errors';
import { agentRunLaunchCommand } from '@/lib/agentInstances/terminal';
import { ReviewStartNotOfferedError } from '@/lib/agentReview/errors';
import { ownDeliverySetVersion } from '@/lib/agentReview/ownVersion';
import { reviewInFlightUnderLock } from '@/lib/agentReview/reviewOpenGuard';
import {
  reviewAgentRunKey,
  reviewItemRunKeyPrefix,
  reviewRunKeyPrefix,
} from '@/lib/agentReview/reviewRunKey';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { agentReviewStartService } from '@/lib/services/agentReviewStartService';
import { reviewInMyAgentService } from '@/lib/services/reviewInMyAgentService';
import { reviewStateService } from '@/lib/services/reviewStateService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { randomToken } from '../helpers/random';
import { fleet, fx, otherMember, seedRepo, setUpHarness, stub, tearDownHarness } from './_harness';

// *REVIEW IN MY AGENT* — the server half (Story MOTIR-11941 · MOTIR-11945;
// `approval-gates.md` §12.18). The door's read and start, the `review` run command in an
// agent, one review of an item at a time across both doors, and a superseded gate ending an
// own-agent review — over the REAL services and database. Only the session resolvers the
// vitest env cannot provide are stubbed (the agent-runs route suite's precedent), and the
// fleet is the harness's fake.

const session = { user: null as { id: string; email: string } | null };
const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctxRef.current,
}));

const doorRoute = await import('@/app/api/work-items/[id]/review-in-my-agent/route');

const MASTER = 'm'.repeat(48);

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  fleet.setExecResponder((command) => ({
    exitCode: 0,
    stdout: command.includes('signin') ? '{"profile":"claude","state":"signed_in"}\n' : '',
    stderr: '',
  }));
  await seedRepo('acme', 'web');
  await signInAs(fx.ownerId);
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function signInAs(userId: string): Promise<void> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: userId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const readRoute = (key: string) =>
  doorRoute.GET(new Request(`http://test/api/work-items/${key}/review-in-my-agent`), params(key));
const pressRoute = (key: string, body?: unknown) =>
  doorRoute.POST(
    new Request(`http://test/api/work-items/${key}/review-in-my-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params(key),
  );

async function agent(name = 'yue-claude'): Promise<string> {
  return (await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx)).id;
}

const versionOf = (item: { id: string; parentId: string | null }) =>
  withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    ownDeliverySetVersion(item, fx.workspaceId, tx),
  );

/**
 * An item In review, assigned to the owner, delivered by one green pull request. With
 * `reviewOn` the project's Review switch is on and the item's `agent_review` gate awaits at
 * its current version.
 */
async function reviewable(opts: { reviewOn: boolean; status?: string; delivered?: boolean }) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `review me ${randomToken(4)}` },
    fx.ctx,
  );
  await setStatus(item.id, opts.status ?? 'in_review');
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
  if (opts.delivered !== false) {
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    await deliveredPr(fx, item.id, repo, {
      headRef: `subtask/${item.identifier}`,
      checks: { Vitest: 'success' },
    });
  }
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { reviewAgentEnabled: opts.reviewOn },
  });
  const version = opts.delivered === false ? null : await versionOf(item);
  const gate =
    opts.reviewOn && version !== null
      ? await adminDb.approvalGate.create({
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            workItemId: item.id,
            kind: 'agent_review',
            subjectId: item.id,
            subjectVersion: version,
            state: 'awaiting',
          },
        })
      : null;
  return { item, version, gate };
}

const runRows = () =>
  adminDb.dispatchRun.findMany({
    include: { cards: true, events: { where: { kind: 'run_opened' } } },
    orderBy: { startedAt: 'asc' },
  });

const gateRows = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { id: 'asc' } });

/** A RUNNING hosted review run of the item, keyed as the hosted door keys it. */
async function hostedReviewRunning(item: { id: string; identifier: string }, key: string) {
  return adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'review',
      origin: 'hosted',
      idempotencyKey: key,
      createdById: fx.ownerId,
      cards: {
        create: {
          workspaceId: fx.workspaceId,
          workItemId: item.id,
          workItemKey: item.identifier,
          position: 0,
        },
      },
    },
  });
}

describe('the review run command in an agent', () => {
  it('opens ONE review run that claims nothing, stamps nothing and names its gate and version', async () => {
    const id = await agent();
    const { item, gate, version } = await reviewable({ reviewOn: true });
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    const gatesBefore = await gateRows(item.id);

    const sent = vi.spyOn(sendEventModule, 'sendEvent');
    const res = await pressRoute(item.identifier, { agentInstanceId: id, idempotencyKey: 'p-1' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { dispatchRunId: string; created: boolean };
    expect(body.created).toBe(true);

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({
      id: body.dispatchRunId,
      command: 'review',
      origin: 'instance',
      agentInstanceId: id,
      status: 'running',
      idempotencyKey: reviewAgentRunKey(gate!.id, 'p-1'),
    });
    expect(run.idempotencyKey!.startsWith(reviewRunKeyPrefix(gate!.id))).toBe(true);
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0]).toMatchObject({ workItemId: item.id, disposition: 'queued' });
    expect(run.events[0]!.data).toMatchObject({
      command: 'review',
      key: item.identifier,
      origin: 'instance',
      gateId: gate!.id,
      subjectVersion: version,
    });

    // Nothing claimed, moved or stamped; no gate decided, withdrawn or raised.
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe(before.status);
    expect(after.assigneeId).toBe(before.assigneeId);
    expect(after.implementationSource).toBe(before.implementationSource);
    expect(after.implementationHarness).toBe(before.implementationHarness);
    expect(await gateRows(item.id)).toEqual(gatesBefore);

    // The launch asks the agent for a review session.
    expect(agentRunLaunchCommand(item.identifier, run.id, run.command)).toEqual([
      ...agentRunLaunchCommand(item.identifier, run.id),
      '--command',
      'review',
    ]);
    expect(sent.mock.calls.map(([name]) => name)).toEqual([
      'agent-instance-run/launch',
      'agent-instance-run/supervise',
    ]);

    // The marker reads the review as running, exactly as for a hosted one.
    expect((await reviewStateService.forCard(fx.projectId, item.id, fx.ctx))?.marker).toEqual({
      kind: 'agent_reviewing',
    });
  });

  it('a review start with no review target is refused and opens nothing', async () => {
    const id = await agent();
    const { item } = await reviewable({ reviewOn: true });
    await expect(
      agentInstanceRunService.start(
        { workItemKey: item.identifier, agentInstanceId: id, command: 'review' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(AgentRunReviewTargetRequiredError);
    expect(await adminDb.dispatchRun.count()).toBe(0);
  });

  it('with Review off, opens a run under the item’s gate-off key with a null gate', async () => {
    const id = await agent();
    const { item, version } = await reviewable({ reviewOn: false });

    const read = await reviewInMyAgentService.readDoor(item.identifier, fx.ctx);
    expect(read).toMatchObject({ offered: true, gateId: null, subjectVersion: version });

    const res = await pressRoute(item.identifier, { agentInstanceId: id });
    expect(res.status).toBe(201);
    const [run] = await runRows();
    expect(run!.idempotencyKey!.startsWith(reviewItemRunKeyPrefix(item.id, version!))).toBe(true);
    expect(run!.events[0]!.data).toMatchObject({ gateId: null, subjectVersion: version });
    expect(await gateRows(item.id)).toEqual([]);
  });
});

describe('the door’s read — every reason, in order', () => {
  it('offers the door with the chosen agent and what it would review', async () => {
    const id = await agent();
    const { item, gate, version } = await reviewable({ reviewOn: true });
    const res = await readRoute(item.identifier);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      offered: true,
      agent: expect.objectContaining({ id, name: 'yue-claude', profileId: 'claude' }),
      lastUsedOnItem: false,
      gateId: gate!.id,
      subjectVersion: version,
    });
  });

  it('not_in_review comes first, even with no pull request', async () => {
    await agent();
    const { item } = await reviewable({ reviewOn: true, status: 'implemented', delivered: false });
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toEqual({
      offered: false,
      reason: 'not_in_review',
      run: null,
      refusal: null,
    });
  });

  it('no_pull_request before gate_not_awaiting', async () => {
    await agent();
    const { item } = await reviewable({ reviewOn: true, delivered: false });
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
      offered: false,
      reason: 'no_pull_request',
    });
  });

  it('gate_not_awaiting: no gate, a decided gate, or a gate at another version', async () => {
    await agent();
    const none = await reviewable({ reviewOn: true });
    await adminDb.approvalGate.delete({ where: { id: none.gate!.id } });
    const decided = await reviewable({ reviewOn: true });
    await adminDb.approvalGate.update({
      where: { id: decided.gate!.id },
      data: { state: 'approved', decidedAt: new Date(), decidedById: fx.ownerId },
    });
    const stale = await reviewable({ reviewOn: true });
    await adminDb.approvalGate.update({
      where: { id: stale.gate!.id },
      data: { subjectVersion: 'an-older-version' },
    });
    for (const { item } of [none, decided, stale]) {
      expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
        offered: false,
        reason: 'gate_not_awaiting',
      });
    }
  });

  it('review_in_flight for a hosted review carries no run; an own-agent one carries it', async () => {
    await agent();
    const hosted = await reviewable({ reviewOn: true });
    await hostedReviewRunning(hosted.item, `${reviewRunKeyPrefix(hosted.gate!.id)}press:1`);
    expect(await reviewInMyAgentService.readDoor(hosted.item.identifier, fx.ctx)).toEqual({
      offered: false,
      reason: 'review_in_flight',
      run: null,
      refusal: null,
    });

    // An own-agent review, started by the viewer: the run, its label and its agent.
    await adminDb.dispatchRun.deleteMany({});
    const id = await agent('second');
    const own = await reviewable({ reviewOn: true });
    const started = await reviewInMyAgentService.start(
      own.item.identifier,
      { agentInstanceId: id },
      fx.ctx,
    );
    const read = await reviewInMyAgentService.readDoor(own.item.identifier, fx.ctx);
    const run = await adminDb.dispatchRun.findUniqueOrThrow({
      where: { id: started.dispatchRunId },
    });
    expect(read).toEqual({
      offered: false,
      reason: 'review_in_flight',
      run: {
        id: started.dispatchRunId,
        label: expect.stringMatching(/^motir review · /),
        startedAt: run.startedAt.toISOString(),
        agentName: 'second',
        byViewer: true,
      },
      refusal: null,
    });

    // Another member sees the same review in flight, not as theirs and with no agent name.
    const other = await otherMember();
    const seen = await reviewInMyAgentService.readDoor(own.item.identifier, other);
    expect(seen).toMatchObject({
      reason: 'review_in_flight',
      run: { id: started.dispatchRunId, agentName: null, byViewer: false },
    });
  });

  it('with Review off, any running review with a leg on the item is in flight', async () => {
    await agent();
    const { item } = await reviewable({ reviewOn: false });
    await hostedReviewRunning(item, `agent-review-item:${item.id}:another-version:1`);
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
      offered: false,
      reason: 'review_in_flight',
    });
  });

  it('cannot_decide: outside the routed set with Review on; without work_item:edit with Review off', async () => {
    const on = await reviewable({ reviewOn: true });
    const member = await otherMember();
    expect(await reviewInMyAgentService.readDoor(on.item.identifier, member)).toMatchObject({
      offered: false,
      reason: 'cannot_decide',
    });
    await signInAs(member.userId);
    const pressed = await pressRoute(on.item.identifier, { agentInstanceId: 'any' });
    expect(pressed.status).toBe(409);
    expect(await pressed.json()).toMatchObject({
      code: 'review_in_my_agent_not_offered',
      reason: 'cannot_decide',
    });
    expect(await adminDb.dispatchRun.count()).toBe(0);
    await signInAs(fx.ownerId);

    const off = await reviewable({ reviewOn: false });
    // With Review off there is no gate to route: a member holding work_item:edit is offered
    // (and, having no agent, reads no_agent) …
    expect(await reviewInMyAgentService.readDoor(off.item.identifier, member)).toMatchObject({
      reason: 'no_agent',
    });
    // … and a viewer, who cannot edit the item, cannot decide.
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: member.userId, workspaceId: fx.workspaceId } },
      data: { workspaceRole: 'viewer' },
    });
    expect(await reviewInMyAgentService.readDoor(off.item.identifier, member)).toMatchObject({
      offered: false,
      reason: 'cannot_decide',
    });
  });

  it('no_agent for a viewer with no own agent; agent_unusable with the agent’s refusal', async () => {
    const { item } = await reviewable({ reviewOn: true });
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
      offered: false,
      reason: 'no_agent',
    });
    const id = await agent();
    // An agent moving to a new image takes no run.
    await adminDb.agentInstance.update({ where: { id }, data: { state: 'updating' } });
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toEqual({
      offered: false,
      reason: 'agent_unusable',
      run: null,
      refusal: 'agent_instance_state_conflict',
    });
  });

  it('prefers the agent this viewer last used on the item, while it is usable', async () => {
    const ids = [await agent('first'), await agent('second')];
    const { item } = await reviewable({ reviewOn: true });
    // With no run on the item, the first usable agent of the viewer's list …
    const plain = await reviewInMyAgentService.readDoor(item.identifier, fx.ctx);
    const defaultId = (plain as Extract<typeof plain, { offered: true }>).agent.id;
    const lastUsed = ids.find((i) => i !== defaultId)!;

    // … gives way to the agent the item's last run used (`resumeTargetForCard`).
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        origin: 'instance',
        status: 'succeeded',
        agentInstanceId: lastUsed,
        createdById: fx.ownerId,
        endedAt: new Date(),
        cards: {
          create: {
            workspaceId: fx.workspaceId,
            workItemId: item.id,
            workItemKey: item.identifier,
            position: 0,
          },
        },
      },
    });
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
      offered: true,
      agent: { id: lastUsed },
      lastUsedOnItem: true,
    });

    // A review in it that ended without a verdict leaves the door offered again, on it.
    const started = await reviewInMyAgentService.start(
      item.identifier,
      { agentInstanceId: lastUsed },
      fx.ctx,
    );
    await agentInstanceRunService.end(started.dispatchRunId, 'failed', 'no verdict');
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
      offered: true,
      agent: { id: lastUsed },
      lastUsedOnItem: true,
    });

    // Unusable, it gives way to the first usable one.
    await adminDb.agentInstance.update({ where: { id: lastUsed }, data: { state: 'updating' } });
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
      offered: true,
      agent: { id: defaultId },
      lastUsedOnItem: false,
    });
    // And with every agent unusable, the refusal named is the last-used agent's.
    await adminDb.agentInstance.update({
      where: { id: defaultId },
      data: { state: 'hibernating' },
    });
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
      offered: false,
      reason: 'agent_unusable',
      refusal: 'agent_instance_state_conflict',
    });
  });

  it('after the gate is decided by any door the read answers gate_not_awaiting', async () => {
    const id = await agent();
    const { item, gate } = await reviewable({ reviewOn: true });
    await reviewInMyAgentService.start(item.identifier, { agentInstanceId: id }, fx.ctx);
    await adminDb.approvalGate.update({
      where: { id: gate!.id },
      data: { state: 'superseded', decidedAt: new Date(), decidedById: fx.ownerId },
    });
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
      reason: 'gate_not_awaiting',
    });
  });
});

describe('one review at a time', () => {
  it('a press while a review runs opens nothing; the same key again answers its first run', async () => {
    const id = await agent();
    const other = await agent('other');
    const { item } = await reviewable({ reviewOn: true });

    const first = await pressRoute(item.identifier, { agentInstanceId: id, idempotencyKey: 'k' });
    expect(first.status).toBe(201);
    const { dispatchRunId } = (await first.json()) as { dispatchRunId: string };

    const again = await pressRoute(item.identifier, { agentInstanceId: id, idempotencyKey: 'k' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ dispatchRunId, created: false });

    const second = await pressRoute(item.identifier, { agentInstanceId: other });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ reason: 'review_in_flight' });
    expect(await adminDb.dispatchRun.count()).toBe(1);
  });

  it('two concurrent presses with different keys leave exactly one review running', async () => {
    const a = await agent('a');
    const b = await agent('b');
    const { item } = await reviewable({ reviewOn: false });
    const [one, two] = await Promise.all([
      reviewInMyAgentService
        .start(item.identifier, { agentInstanceId: a, idempotencyKey: 'ka' }, fx.ctx)
        .then(() => 'opened' as const)
        .catch((err: unknown) => err),
      reviewInMyAgentService
        .start(item.identifier, { agentInstanceId: b, idempotencyKey: 'kb' }, fx.ctx)
        .then(() => 'opened' as const)
        .catch((err: unknown) => err),
    ]);
    const outcomes = [one, two];
    expect(outcomes.filter((o) => o === 'opened')).toHaveLength(1);
    const refused = outcomes.find((o) => o !== 'opened');
    expect(refused).toBeInstanceOf(ReviewInMyAgentNotOfferedError);
    expect((refused as ReviewInMyAgentNotOfferedError).reason).toBe('review_in_flight');
    expect(
      await adminDb.dispatchRun.count({ where: { command: 'review', status: 'running' } }),
    ).toBe(1);
  });

  it('the hosted door sees an own-agent review in flight, and the open lock refuses a second', async () => {
    const id = await agent();
    const { item } = await reviewable({ reviewOn: true });
    await reviewInMyAgentService.start(item.identifier, { agentInstanceId: id }, fx.ctx);
    const hosted = await agentReviewStartService
      .startRequested({ workItemKey: item.identifier }, fx.ctx)
      .catch((err: unknown) => err);
    expect(hosted).toBeInstanceOf(ReviewStartNotOfferedError);
    expect((hosted as ReviewStartNotOfferedError).reason).toBe('review_in_flight');

    // The lock's own read: the running review refuses a new key, a key already used passes.
    const [run] = await runRows();
    const held = await withWorkspaceServiceContext(fx.workspaceId, async (tx) => ({
      fresh: await reviewInFlightUnderLock(tx, {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        idempotencyKey: 'a-new-key',
      }),
      repeat: await reviewInFlightUnderLock(tx, {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        idempotencyKey: run!.idempotencyKey!,
      }),
    }));
    expect(held.fresh).toMatchObject({ id: run!.id });
    expect(held.repeat).toBeNull();
  });
});

describe('a superseded gate ends an own-agent review in the agent', () => {
  it('cancelRunsForGates ends an instance run through the agent end path', async () => {
    const id = await agent();
    const { item, gate } = await reviewable({ reviewOn: true });
    const started = await reviewInMyAgentService.start(
      item.identifier,
      { agentInstanceId: id },
      fx.ctx,
    );
    const end = vi.spyOn(agentInstanceRunService, 'end');
    const ended = await agentReviewStartService.cancelRunsForGates(fx.workspaceId, [gate!.id]);
    expect(ended).toEqual([started.dispatchRunId]);
    expect(end).toHaveBeenCalledWith(started.dispatchRunId, 'cancelled', expect.any(String), {
      stopSession: true,
    });
    const run = await adminDb.dispatchRun.findUniqueOrThrow({
      where: { id: started.dispatchRunId },
    });
    expect(run.status).not.toBe('running');
    // Ended without a verdict, the door is offered again.
    expect(await reviewInMyAgentService.readDoor(item.identifier, fx.ctx)).toMatchObject({
      offered: true,
    });
  });
});

describe('the route', () => {
  it('answers 404 with no existence leak to a caller who may not browse the item', async () => {
    const { item } = await reviewable({ reviewOn: true });
    const stranger = await adminDb.user.create({
      data: { name: 'Stranger', email: `stranger-${randomToken(6)}@example.com` },
    });
    await signInAs(stranger.id);
    for (const res of [
      await readRoute(item.identifier),
      await readRoute(`${fx.projectIdentifier}-99999`),
      await pressRoute(item.identifier, { agentInstanceId: 'x' }),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'WORK_ITEM_NOT_FOUND', error: 'Not found.' });
    }
  });

  it('answers 400 for a press with no agent or a bad request key', async () => {
    const { item } = await reviewable({ reviewOn: true });
    for (const body of [
      undefined,
      {},
      { agentInstanceId: '  ' },
      { agentInstanceId: 'a', idempotencyKey: 7 },
      { agentInstanceId: 'a', idempotencyKey: 'k'.repeat(201) },
    ]) {
      expect((await pressRoute(item.identifier, body)).status).toBe(400);
    }
    expect(await adminDb.dispatchRun.count()).toBe(0);
  });

  it('passes the agent’s own refusals through, as the agent-runs route answers them', async () => {
    const { item } = await reviewable({ reviewOn: true });
    const missing = await pressRoute(item.identifier, { agentInstanceId: 'not-an-agent' });
    expect(missing.status).toBe(404);
    expect(await adminDb.dispatchRun.count()).toBe(0);
  });

  it('answers the session gate’s own refusal to a caller who is not signed in', async () => {
    const { item } = await reviewable({ reviewOn: true });
    session.user = null;
    ctxRef.current = null;
    expect((await readRoute(item.identifier)).status).toBe(401);
    expect((await pressRoute(item.identifier, { agentInstanceId: 'x' })).status).toBe(401);
  });

  it('answers 404 for an item of a project that does not exist', async () => {
    expect((await readRoute('NOPE-1')).status).toBe(404);
  });

  it('a review needs its repositories READABLE, refused by the hosted pre-flight’s code', async () => {
    const id = await agent();
    const { item } = await reviewable({ reviewOn: true });
    stub.installation['acme/web'] = 404;
    const res = await pressRoute(item.identifier, { agentInstanceId: id, idempotencyKey: null });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'hosted_repository_not_readable' });
    expect(await adminDb.dispatchRun.count()).toBe(0);
  });
});
