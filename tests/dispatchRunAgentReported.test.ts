import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  AgentRunEventKindNotAllowedError,
  AgentRunNoOpenRunError,
  AgentRunNotClaimedError,
  AgentRunNotYoursError,
  AgentRunReportInvalidError,
  DispatchRunNotFoundError,
} from '@/lib/dispatchRuns/errors';
import { isRunAlive } from '@/lib/runs/runLiveness';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { randomToken } from './helpers/random';

// AN AGENT-REPORTED RUN (Story MOTIR-7446 · MOTIR-7450,
// `docs/decisions/agent-reported-runs.md`) — the run an agent opens about ITSELF,
// over a card it holds, against a real Postgres.
//
// Organised by the record's sections: the open over a claim (§2), the report and
// its run resolution from the card (§3), the close and its provenance stamp (§4),
// and the liveness window and the reap's end time (§5).

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function member(name: string): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: `${name.toLowerCase().replace(/\W/g, '')}+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

/** Put a card where a claim leaves it: In Progress, assigned to `userId`. */
async function hold(item: WorkItem, userId: string = fx.ownerId, status = 'in_progress') {
  await adminDb.workItem.update({ where: { id: item.id }, data: { status, assigneeId: userId } });
}

/** A held leaf. */
async function heldLeaf(title = 'a leaf the agent builds'): Promise<WorkItem> {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await hold(item);
  return item;
}

/** A held story with `count` held subtasks, in their order. */
async function heldStory(count: number): Promise<{ story: WorkItem; children: WorkItem[] }> {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'a story' });
  await hold(story);
  const children: WorkItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: `child ${i + 1}`,
      parentId: story.id,
    });
    await hold(child);
    children.push(child);
  }
  return { story, children };
}

const start = (key: string, ctx: ServiceContext = fx.ctx, model: string | null = 'model-x') =>
  dispatchRunService.openAgentRun({ key, harness: 'Claude Code', model }, ctx);

async function eventsOf(runId: string) {
  return adminDb.dispatchRunEvent.findMany({
    where: { dispatchRunId: runId },
    orderBy: { seq: 'asc' },
  });
}

describe('openAgentRun — over a claim the caller holds (§2)', () => {
  it('a held leaf opens ONE `run` with one leg, reported by the agent, born heartbeating', async () => {
    const leaf = await heldLeaf();

    const { outcome, run } = await start(leaf.identifier);

    expect(outcome).toBe('opened');
    expect(run).toMatchObject({
      command: 'run',
      origin: 'local',
      reportedBy: 'agent',
      agent: 'Claude Code',
      model: 'model-x',
      status: 'running',
      seq: 1,
    });
    expect(run.cards.map((c) => c.key)).toEqual([leaf.identifier]);
    expect(run.lastHeartbeatAt).not.toBeNull();

    const events = await eventsOf(run.id);
    expect(events.map((e) => [e.kind, e.reportedBy])).toEqual([['run_opened', 'agent']]);
    expect(events[0]!.data).toMatchObject({ harness: 'Claude Code', model: 'model-x' });
  });

  it('a held container opens ONE `run_scope` whose legs are its children in order, done ones left out', async () => {
    const { story, children } = await heldStory(3);
    await adminDb.workItem.update({ where: { id: children[1]!.id }, data: { status: 'done' } });

    const { run, legs } = await start(story.identifier);

    expect(legs).toEqual([
      { key: children[0]!.identifier, title: children[0]!.title },
      { key: children[2]!.identifier, title: children[2]!.title },
    ]);
    expect(run.command).toBe('run_scope');
    expect(run.scopeWorkItemId).toBe(story.id);
    expect(run.cards.map((c) => c.key)).toEqual([children[0]!.identifier, children[2]!.identifier]);
  });

  it('refuses a card the caller does not hold, and writes nothing', async () => {
    const other = await member('Not Holder');
    const leaf = await heldLeaf();

    await expect(start(leaf.identifier, other)).rejects.toBeInstanceOf(AgentRunNotClaimedError);
    const todo = await createTestWorkItem(fx, { kind: 'task', title: 'never claimed' });
    await expect(start(todo.identifier)).rejects.toBeInstanceOf(AgentRunNotClaimedError);

    expect(await adminDb.dispatchRun.count()).toBe(0);
  });

  it('refuses a container one of whose open children the caller does not hold, naming it', async () => {
    const other = await member('Child Holder');
    const { story, children } = await heldStory(2);
    await hold(children[1]!, other.userId);

    const refusal = await start(story.identifier).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(AgentRunNotClaimedError);
    expect((refusal as AgentRunNotClaimedError).offenderKey).toBe(children[1]!.identifier);
    expect(await adminDb.dispatchRun.count()).toBe(0);
  });

  it('a second start by the holder answers `mine` with the SAME run', async () => {
    const leaf = await heldLeaf();

    const first = await start(leaf.identifier);
    const second = await start(leaf.identifier);

    expect(second.outcome).toBe('mine');
    expect(second.run.id).toBe(first.run.id);
    expect(second.legs).toEqual([{ key: leaf.identifier, title: leaf.title }]);
    expect(await adminDb.dispatchRun.count()).toBe(1);
  });

  it('a card started again after its run closed opens a NEW run', async () => {
    const leaf = await heldLeaf();
    const first = await start(leaf.identifier);
    await dispatchRunService.closeAgentRun(
      { key: leaf.identifier, runId: first.run.id, stopReason: 'halted' },
      fx.ctx,
    );

    const again = await start(leaf.identifier);

    expect(again.outcome).toBe('opened');
    expect(again.run.id).not.toBe(first.run.id);
  });

  it('every other door still writes `cli`', async () => {
    const leaf = await heldLeaf();
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: leaf.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'card_claimed', workItemKey: leaf.identifier }],
      fx.ctx,
    );

    expect(run.reportedBy).toBe('cli');
    expect((await eventsOf(run.id)).map((e) => e.reportedBy)).toEqual(['cli']);
  });
});

describe('reportAction — a step, a milestone, or a heartbeat (§3)', () => {
  it('writes the step as an `agent_action` on the leg, reported by the agent, and heartbeats the run', async () => {
    const leaf = await heldLeaf();
    const { run } = await start(leaf.identifier);
    const stale = new Date(Date.now() - 30 * 60_000);
    await adminDb.dispatchRun.update({ where: { id: run.id }, data: { lastHeartbeatAt: stale } });

    const reported = await dispatchRunService.reportAction(
      { key: leaf.identifier, action: '  run the changed tests  ' },
      fx.ctx,
    );

    expect(reported).toEqual({
      kind: 'reported',
      runId: run.id,
      runReportedBy: 'agent',
      appended: 1,
      seq: 2,
    });
    const step = (await eventsOf(run.id)).at(-1)!;
    expect(step).toMatchObject({
      kind: 'agent_action',
      body: 'run the changed tests',
      reportedBy: 'agent',
      dispatchRunCardId: run.cards[0]!.id,
    });
    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.lastHeartbeatAt!.getTime()).toBeGreaterThan(stale.getTime());
  });

  it('writes milestones through the shared append path, moving the leg, before the step', async () => {
    const leaf = await heldLeaf();
    const { run } = await start(leaf.identifier);

    await dispatchRunService.reportAction(
      {
        key: leaf.identifier,
        action: 'open the pull request',
        events: [
          {
            kind: 'checkout_ready',
            data: { branch: 'subtask/x' },
            disposition: 'running',
            sessionBranch: 'subtask/x',
          },
        ],
      },
      fx.ctx,
    );

    const events = await eventsOf(run.id);
    expect(events.map((e) => [e.seq, e.kind, e.reportedBy])).toEqual([
      [1, 'run_opened', 'agent'],
      [2, 'checkout_ready', 'agent'],
      [3, 'agent_action', 'agent'],
    ]);
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({
      where: { dispatchRunId: run.id },
    });
    expect(leg).toMatchObject({ disposition: 'running', sessionBranch: 'subtask/x' });
  });

  it('reports a step into a CLI run the caller is inside, and refuses its milestones', async () => {
    const leaf = await heldLeaf();
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: leaf.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );

    const reported = await dispatchRunService.reportAction(
      { key: leaf.identifier, action: 'read the card' },
      fx.ctx,
    );
    expect(reported).toMatchObject({ runId: run.id, runReportedBy: 'cli' });
    expect((await eventsOf(run.id)).map((e) => [e.kind, e.reportedBy])).toEqual([
      ['agent_action', 'agent'],
    ]);

    const refusal = await dispatchRunService
      .reportAction(
        { key: leaf.identifier, events: [{ kind: 'delivery_linked', data: { url: 'u' } }] },
        fx.ctx,
      )
      .catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(AgentRunEventKindNotAllowedError);
    expect(refusal).toMatchObject({ kind: 'delivery_linked', why: 'cli_run' });
  });

  it('refuses a card with no open run of the caller’s, by name', async () => {
    const leaf = await heldLeaf();
    const other = await member('Somebody Else');
    await start(leaf.identifier);

    await expect(
      dispatchRunService.reportAction({ key: leaf.identifier, action: 'x' }, other),
    ).rejects.toBeInstanceOf(AgentRunNoOpenRunError);
    const quiet = await heldLeaf('no run here');
    await expect(
      dispatchRunService.reportAction({ key: quiet.identifier, action: 'x' }, fx.ctx),
    ).rejects.toBeInstanceOf(AgentRunNoOpenRunError);
  });

  it('refuses a step over 500 characters, an empty one, and a step without a key', async () => {
    const leaf = await heldLeaf();
    const { run } = await start(leaf.identifier);

    await expect(
      dispatchRunService.reportAction({ key: leaf.identifier, action: 'x'.repeat(501) }, fx.ctx),
    ).rejects.toMatchObject({ reason: 'action_too_long' });
    await expect(
      dispatchRunService.reportAction({ key: leaf.identifier, action: '   ' }, fx.ctx),
    ).rejects.toMatchObject({ reason: 'action_empty' });
    await expect(dispatchRunService.reportAction({ action: 'x' }, fx.ctx)).rejects.toBeInstanceOf(
      AgentRunReportInvalidError,
    );
    await dispatchRunService.reportAction(
      { key: leaf.identifier, action: 'x'.repeat(500) },
      fx.ctx,
    );
    expect(await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: run.id } })).toBe(2);
  });

  it('refuses every kind but the four milestones, naming it', async () => {
    const leaf = await heldLeaf();
    await start(leaf.identifier);

    for (const kind of ['run_closed', 'ci_verdict', 'agent_exited', 'bug_filed', 'log'] as const) {
      const refusal = await dispatchRunService
        .reportAction({ key: leaf.identifier, events: [{ kind }] }, fx.ctx)
        .catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(AgentRunEventKindNotAllowedError);
      expect(refusal).toMatchObject({ kind, why: 'kind' });
    }
  });

  it('with no arguments, heartbeats each of the caller’s open runs, of either reporter', async () => {
    const leaf = await heldLeaf();
    const other = await heldLeaf('second');
    const agentRun = (await start(leaf.identifier)).run;
    const { run: cliRun } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: other.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    const stale = new Date(Date.now() - 10 * 60_000);
    await adminDb.dispatchRun.updateMany({ data: { lastHeartbeatAt: stale } });

    const reported = await dispatchRunService.reportAction({}, fx.ctx);

    expect(reported).toEqual({ kind: 'heartbeat', touched: 2 });
    for (const id of [agentRun.id, cliRun.id]) {
      const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });
      expect(row.lastHeartbeatAt!.getTime()).toBeGreaterThan(stale.getTime());
    }
  });
});

describe('a `needs_human` settle raises the manual-work gate only on a READY card (MOTIR-9500)', () => {
  // The agent path the bug was seen on: a story run opened over every child, a manual
  // child settled `needs_human` while the sibling it waits on is still open. §6 would
  // withdraw that gate as `not_ready`, so the raise must not open it.
  async function storyWithManualChild() {
    const { story, children } = await heldStory(1);
    const [code] = children;
    const manual = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'issue the certificate',
      parentId: story.id,
      type: 'manual',
      executor: 'human',
    });
    await hold(manual);
    await adminDb.workItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        fromId: manual.id,
        toId: code!.id,
        kind: 'is_blocked_by',
        createdById: fx.ownerId,
      },
    });
    return { story, code: code!, manual };
  }

  const settleNeedsHuman = (key: string) =>
    dispatchRunService.reportAction(
      {
        key,
        events: [{ kind: 'card_settled', disposition: 'skipped', skipReason: 'needs_human' }],
      },
      fx.ctx,
    );
  const manualGatesOf = (workItemId: string) =>
    adminDb.approvalGate.findMany({ where: { workItemId, kind: 'manual_work' } });

  it('raises no gate while the sibling blocker is open', async () => {
    const { story, manual } = await storyWithManualChild();
    await start(story.identifier);

    await settleNeedsHuman(manual.identifier);

    expect(await manualGatesOf(manual.id)).toEqual([]);
  });

  it('raises it once the blocker is done', async () => {
    const { story, code, manual } = await storyWithManualChild();
    await start(story.identifier);
    await adminDb.workItem.update({ where: { id: code.id }, data: { status: 'done' } });

    await settleNeedsHuman(manual.identifier);

    expect(await manualGatesOf(manual.id)).toEqual([
      expect.objectContaining({ state: 'awaiting', routedToId: fx.ownerId }),
    ]);
  });
});

describe('heartbeatCallerRuns — every Motir call keeps the agent’s run alive (§5)', () => {
  it('touches only the caller’s open AGENT runs, and skips one beaten under a minute ago', async () => {
    const leaf = await heldLeaf();
    const other = await heldLeaf('cli card');
    const { run } = await start(leaf.identifier);
    const { run: cliRun } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: other.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );

    // Just opened: inside the throttle, so nothing is written.
    expect(await dispatchRunService.heartbeatCallerRuns(fx.ctx)).toBe(0);

    const stale = new Date(Date.now() - 2 * 60_000);
    await adminDb.dispatchRun.updateMany({ data: { lastHeartbeatAt: stale } });
    expect(await dispatchRunService.heartbeatCallerRuns(fx.ctx)).toBe(1);
    const cli = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: cliRun.id } });
    expect(cli.lastHeartbeatAt!.getTime()).toBe(stale.getTime());
    const agent = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(agent.lastHeartbeatAt!.getTime()).toBeGreaterThan(stale.getTime());

    const stranger = await member('No Runs');
    expect(await dispatchRunService.heartbeatCallerRuns(stranger)).toBe(0);
  });
});

describe('closeAgentRun — the close and its provenance stamp (§4)', () => {
  it('`completed` stamps byok, the harness and the model on each implemented leg, in the close', async () => {
    const { story, children } = await heldStory(2);
    const { run } = await start(story.identifier);
    await adminDb.workItem.update({
      where: { id: children[0]!.id },
      data: { status: 'implemented' },
    });

    const closed = await dispatchRunService.closeAgentRun(
      { key: story.identifier, runId: run.id, stopReason: 'completed' },
      fx.ctx,
    );

    expect(closed.run).toMatchObject({ status: 'succeeded', stopReason: 'completed' });
    expect(closed).toMatchObject({ stamped: [children[0]!.identifier], alreadyClosed: false });
    const built = await adminDb.workItem.findUniqueOrThrow({ where: { id: children[0]!.id } });
    expect(built).toMatchObject({
      implementationSource: 'byok',
      implementationHarness: 'Claude Code',
      implementationModel: 'model-x',
      status: 'implemented',
    });
    const unbuilt = await adminDb.workItem.findUniqueOrThrow({ where: { id: children[1]!.id } });
    expect(unbuilt.implementationSource).toBeNull();
    expect(unbuilt.status).toBe('in_progress');
  });

  it('leaves a model the run does not know as it is on the card', async () => {
    const leaf = await heldLeaf();
    await adminDb.workItem.update({
      where: { id: leaf.id },
      data: { implementationModel: 'kept-model' },
    });
    const { run } = await start(leaf.identifier, fx.ctx, null);
    await hold(leaf, fx.ownerId, 'implemented');

    await dispatchRunService.closeAgentRun(
      { key: leaf.identifier, runId: run.id, stopReason: 'drained' },
      fx.ctx,
    );

    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: leaf.id } });
    expect(card).toMatchObject({ implementationSource: 'byok', implementationModel: 'kept-model' });
  });

  it('`halted` stamps nothing, and a second close writes nothing', async () => {
    const leaf = await heldLeaf();
    const { run } = await start(leaf.identifier);
    await hold(leaf, fx.ownerId, 'implemented');

    const first = await dispatchRunService.closeAgentRun(
      { key: leaf.identifier, runId: run.id, stopReason: 'halted' },
      fx.ctx,
    );
    const second = await dispatchRunService.closeAgentRun(
      { key: leaf.identifier, runId: run.id, stopReason: 'completed' },
      fx.ctx,
    );

    expect(first).toMatchObject({ stamped: [], alreadyClosed: false });
    expect(first.run).toMatchObject({ status: 'failed', stopReason: 'halted' });
    expect(second).toMatchObject({ stamped: [], alreadyClosed: true });
    expect(second.run).toMatchObject({
      status: 'failed',
      stopReason: 'halted',
      endedAt: first.run.endedAt,
    });
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: leaf.id } });
    expect(card.implementationSource).toBeNull();
  });

  it('refuses somebody else’s run, a run not on the key, a CLI run and `abandoned`', async () => {
    const leaf = await heldLeaf();
    const elsewhere = await heldLeaf('another card');
    const { run } = await start(leaf.identifier);
    const other = await member('Closer');
    const { run: cliRun } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: elsewhere.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );

    await expect(
      dispatchRunService.closeAgentRun(
        { key: leaf.identifier, runId: run.id, stopReason: 'completed' },
        other,
      ),
    ).rejects.toBeInstanceOf(AgentRunNotYoursError);
    await expect(
      dispatchRunService.closeAgentRun(
        { key: elsewhere.identifier, runId: run.id, stopReason: 'completed' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DispatchRunNotFoundError);
    await expect(
      dispatchRunService.closeAgentRun(
        { key: elsewhere.identifier, runId: cliRun.id, stopReason: 'completed' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DispatchRunNotFoundError);
    await expect(
      dispatchRunService.closeAgentRun(
        // @ts-expect-error — `abandoned` is the reap's alone, and the type says so too.
        { key: leaf.identifier, runId: run.id, stopReason: 'abandoned' },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ reason: 'abandoned' });

    const row = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe('running');
  });
});

describe('liveness — sixty minutes for an agent, five for a CLI (§5)', () => {
  it('`isRunAlive` reads the window from the reporter', () => {
    const now = new Date();
    const base = {
      status: 'running',
      origin: 'local' as const,
      startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
      lastHeartbeatAt: new Date(now.getTime() - 30 * 60_000),
    };
    expect(isRunAlive({ ...base, reportedBy: 'agent' }, now)).toBe(true);
    expect(isRunAlive({ ...base, reportedBy: 'cli' }, now)).toBe(false);
    expect(isRunAlive({ ...base }, now)).toBe(false);
  });

  it('the reap closes an agent run silent for 60 minutes at its LAST HEARTBEAT, and leaves a younger one', async () => {
    const quiet = await heldLeaf('quiet');
    const busy = await heldLeaf('busy');
    const { run: dead } = await start(quiet.identifier);
    const { run: alive } = await start(busy.identifier);
    const lastHeard = new Date(Date.now() - 61 * 60_000);
    await adminDb.dispatchRun.update({
      where: { id: dead.id },
      data: { lastHeartbeatAt: lastHeard },
    });
    await adminDb.dispatchRun.update({
      where: { id: alive.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 30 * 60_000) },
    });

    const summary = await dispatchRunSweepService.reapLapsed();

    expect(summary.runsReaped).toBe(1);
    const reaped = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dead.id } });
    expect(reaped).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });
    expect(reaped.endedAt!.getTime()).toBe(lastHeard.getTime());
    const leg = await adminDb.dispatchRunCard.findFirstOrThrow({
      where: { dispatchRunId: dead.id },
    });
    expect(leg.endedAt!.getTime()).toBe(lastHeard.getTime());
    const kept = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: alive.id } });
    expect(kept.status).toBe('running');
  });

  it('a CLI run keeps the 5-minute window and ends at the reap', async () => {
    const leaf = await heldLeaf();
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: leaf.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    const lastHeard = new Date(Date.now() - 6 * 60_000);
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: lastHeard },
    });

    const before = Date.now();
    await dispatchRunSweepService.reapLapsed();

    const reaped = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(reaped.stopReason).toBe('abandoned');
    expect(reaped.endedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });
});
