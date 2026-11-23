import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunSchema } from '@/lib/api/v1/workLoop/schema';
import { DispatchRunAgentBusyError } from '@/lib/dispatchRuns/errors';
import { toDispatchRunRepairDto } from '@/lib/mappers/dispatchRunMappers';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { isRunAlive } from '@/lib/runs/runLiveness';
import {
  workItemRepairService,
  type AgentRepairOpening,
} from '@/lib/services/workItemRepairService';
import { createTestWorkItem } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';
import { fx, seedRepo, setUpHarness, tearDownHarness } from '../agentInstances/_harness';

// THE AGENT DOOR'S REPAIR OPENING (Story MOTIR-8981 · MOTIR-9049) —
// `workItemRepairService.openAgentRepair` over real Postgres: one claim under the
// card's row lock that IS the `fix` run in the person's own agent.
//
// ⚠️ THE ABSENCES ARE THE ASSERTIONS for every refusal: no run, and the card's
// `DispatchRun` count stays where it was. Every run is closed through
// `dispatchRunService.close`, never by waiting on a sweep.

beforeEach(async () => {
  await setUpHarness();
  await seedRepo('acme', 'web');
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function agent(name: string): Promise<{ id: string; profileId: string }> {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  return { id: dto.id, profileId: 'claude' };
}

const opening = (a: { id: string; profileId: string }, idem?: string): AgentRepairOpening => ({
  origin: 'instance',
  agent: a.profileId,
  agentInstanceId: a.id,
  idempotencyKey: idem ?? `fix-${++seq}`,
});

const press = (key: string, a: { id: string; profileId: string }, idem?: string) =>
  workItemRepairService.openAgentRepair(fx.projectId, key, fx.ctx, opening(a, idem));

const fixRuns = (workItemId: string) =>
  adminDb.dispatchRun.findMany({
    where: { command: 'fix', cards: { some: { workItemId } } },
    orderBy: { startedAt: 'asc' },
  });

/** A card at `status` with one open pull request carrying `checks`. */
async function cardWith(
  status: string,
  checks: Record<string, 'success' | 'failure' | 'pending'>,
  repos = 1,
) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: `card ${randomToken(4)}` });
  await setStatus(card.id, status);
  await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
  for (let i = 0; i < repos; i++) {
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    await deliveredPr(fx, card.id, repo, { headRef: `subtask/${card.identifier}-${i}`, checks });
  }
  return card;
}

const redCard = (repos = 1) => cardWith('implemented', { Vitest: 'failure' }, repos);

describe('openAgentRepair — the run the claim opens', () => {
  it('opens ONE fix run in the agent, with the claim’s decision on its one run_opened and a first beat', async () => {
    const a = await agent('yue-claude');
    const card = await redCard(2);
    const claim = await press(card.identifier, a, 'k1');

    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'ci' });
    const runs = await fixRuns(card.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: claim.runId,
      command: 'fix',
      origin: 'instance',
      agentInstanceId: a.id,
      agent: 'claude',
      status: 'running',
    });
    // The first beat puts the run on the lapse rule, not the twelve-hour age.
    expect(runs[0]!.lastHeartbeatAt).not.toBeNull();
    expect(isRunAlive(runs[0]!)).toBe(true);

    const events = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: runs[0]!.id, kind: 'run_opened' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      command: 'fix',
      origin: 'instance',
      agent: 'claude',
      agentInstanceId: a.id,
      repairClass: 'ci',
    });
    const repair = toDispatchRunRepairDto(events[0]!.data);
    expect(repair?.repairClass).toBe('ci');
    expect(repair?.pullRequests).toHaveLength(2);
    for (const pr of repair!.pullRequests) {
      expect(pr.branch).toMatch(/^subtask\//);
      expect(typeof pr.number).toBe('number');
      expect(pr.url).toBeTruthy();
    }
  });

  it('records each pull request’s mergeability with the decision, and the run read serves it on the wire (Bug MOTIR-12096)', async () => {
    const a = await agent('yue-claude');
    const card = await createTestWorkItem(fx, { kind: 'task', title: `stale ${randomToken(4)}` });
    await setStatus(card.id, 'implemented');
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const head = 'c'.repeat(40);
    const green = { checks: { Vitest: 'success' as const } };
    const behind = await deliveredPr(fx, card.id, repo, { headRef: 'subtask/behind', ...green });
    const dirty = await deliveredPr(fx, card.id, repo, { headRef: 'subtask/dirty', ...green });
    await adminDb.githubPullRequest.update({
      where: { id: behind.id },
      data: { mergeableState: 'behind', mergeableStateHeadSha: head },
    });
    await adminDb.githubPullRequest.update({
      where: { id: dirty.id },
      data: { mergeableState: 'dirty', mergeableStateHeadSha: head },
    });

    const claim = await press(card.identifier, a);
    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'ci' });

    // The read a run ADOPTING it makes (`GET …/dispatch-runs/{id}`) — the same DTO the route
    // answers with, held to the v1 schema so the two fields are on the wire, not only stored.
    const run = await dispatchRunService.getRun(claim.runId!, fx.ctx);
    const parsed = dispatchRunSchema.safeParse(JSON.parse(JSON.stringify(run)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    const byBranch = Object.fromEntries(
      (parsed.data?.repair?.pullRequests ?? []).map((pr) => [
        pr.branch,
        { conflicted: pr.conflicted, outOfDate: pr.outOfDate },
      ]),
    );
    expect(byBranch).toEqual({
      'subtask/behind': { conflicted: false, outOfDate: true },
      'subtask/dirty': { conflicted: true, outOfDate: false },
    });
  });

  it('writes no status and no assignee on the card', async () => {
    const a = await agent('yue-claude');
    const card = await redCard();
    await press(card.identifier, a);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after).toMatchObject({ status: 'implemented', assigneeId: fx.ownerId });
  });

  it('admits the review class too — the agent door answers not_sent_back on no path', async () => {
    const a = await agent('yue-claude');
    const card = await cardWith('in_review', { Vitest: 'success' });
    const deliveries = await adminDb.workItemDelivery.findMany({
      where: { workItemId: card.id },
      include: { pullRequest: true, repo: true },
    });
    const version = deliveries
      .map((d) => `${d.repo.owner}/${d.repo.name}#${d.pullRequest.number}@${'c'.repeat(40)}`)
      .sort()
      .join(',');
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: 'agent_review',
        subjectId: card.id,
        subjectVersion: version,
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date('2026-09-29T10:00:00Z'),
        decidedByLabel: 'Review agent',
        decisionSource: 'ui',
        decidedUnderAuthority: 'review_agent',
        noteMd: '1. The new route has no tenant check.',
      },
    });
    const claim = await press(card.identifier, a);
    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'review' });
    const event = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: claim.runId!, kind: 'run_opened' },
    });
    expect(toDispatchRunRepairDto(event.data)?.repairClass).toBe('review');
  });

  it('admits the acceptance re-run class (green checks, reviewer asked to run again)', async () => {
    const a = await agent('yue-claude');
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Exports list' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'The empty state',
      parentId: story.id,
    });
    await setStatus(child.id, 'implemented');
    await setStatus(story.id, 'implemented');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    await deliveredPr(fx, story.id, repo, {
      headRef: 'parent/exports-list',
      checks: { Vitest: 'success' },
    });
    const receipt = await adminDb.acceptanceEvidence.create({
      data: { workspaceId: fx.workspaceId, workItemId: story.id, status: 'changes_requested' },
    });
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        kind: 'acceptance_result',
        subjectId: receipt.id,
        subjectVersion: 'c'.repeat(40),
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date('2026-09-26T10:00:00Z'),
        decidedByLabel: 'Yue Zhu',
        decisionSource: 'ui',
        decidedUnderAuthority: 'assignee',
        noteMd: 'The empty board should say how to add the first card.',
        refusalVerdict: 'revise',
      },
    });
    const claim = await press(story.identifier, a);
    expect(claim).toMatchObject({ outcome: 'claimed', repairClass: 'acceptance_rerun' });
  });
});

describe('openAgentRepair — refusals open nothing', () => {
  it('answers the predicate’s own reason for a card that is not repairable', async () => {
    const a = await agent('yue-claude');
    const green = await cardWith('implemented', { Vitest: 'success' });
    const claim = await press(green.identifier, a);
    expect(claim).toMatchObject({ outcome: 'not_repairable', reason: 'not_failing', runId: null });
    expect(await fixRuns(green.id)).toEqual([]);

    const pending = await cardWith('implemented', { Vitest: 'pending' });
    expect(await press(pending.identifier, a)).toMatchObject({ reason: 'ci_running' });

    const todo = await cardWith('todo', { Vitest: 'failure' });
    expect(await press(todo.identifier, a)).toMatchObject({ reason: 'not_implemented' });

    const bare = await createTestWorkItem(fx, { kind: 'task', title: 'no pull request' });
    await setStatus(bare.id, 'implemented');
    expect(await press(bare.identifier, a)).toMatchObject({ reason: 'no_pull_requests' });

    expect(await adminDb.dispatchRun.count({ where: { command: 'fix' } })).toBe(0);
  });

  it('answers taken with the holder and start while a repair is open, from another agent', async () => {
    const first = await agent('first');
    const second = await agent('second');
    const card = await redCard();
    const opened = await press(card.identifier, first);

    const again = await press(card.identifier, second);
    expect(again).toMatchObject({ outcome: 'taken', runId: opened.runId });
    expect(again.holder).not.toBeNull();
    expect(again.startedAt).toBe(opened.startedAt);
    expect(await fixRuns(card.id)).toHaveLength(1);
  });

  it('the same agent pressed again is refused as busy, naming the BUSY run’s own card', async () => {
    const a = await agent('yue-claude');
    const busyCard = await redCard();
    const otherCard = await redCard();
    await press(busyCard.identifier, a);

    const err = await press(otherCard.identifier, a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchRunAgentBusyError);
    expect((err as DispatchRunAgentBusyError).workItemKey).toBe(busyCard.identifier);
    expect(await fixRuns(otherCard.id)).toEqual([]);
  });

  it('a repeated key answers the run already opened rather than taken', async () => {
    const a = await agent('yue-claude');
    const card = await redCard();
    const opened = await press(card.identifier, a, 'same-key');
    const again = await press(card.identifier, a, 'same-key');
    expect(again).toMatchObject({ outcome: 'claimed', runId: opened.runId });
    expect(await fixRuns(card.id)).toHaveLength(1);
  });
});

describe('openAgentRepair — the claim is free again once the run ends', () => {
  const ENDS = [
    { name: 'failed', input: { stopReason: 'halted', status: 'failed' }, gaveUp: true },
    { name: 'cancelled', input: { stopReason: 'interrupted', status: 'cancelled' }, gaveUp: false },
    { name: 'timed_out', input: { stopReason: 'halted', status: 'timed_out' }, gaveUp: false },
  ] as const;

  for (const end of ENDS) {
    it(`a run closed ${end.name} lets a fresh press claim and the view reads offer`, async () => {
      const a = await agent('yue-claude');
      const card = await redCard();
      const first = await press(card.identifier, a);
      await dispatchRunService.close(first.runId!, { ...end.input }, fx.ctx);

      const view = await workItemRepairService.getRepairView(card.id, fx.ctx);
      expect(view.state).toBe('offer');
      if (view.state === 'offer') {
        if (end.gaveUp) expect(view.lastGaveUp).not.toBeNull();
        else expect(view.lastGaveUp).toBeNull();
      }

      const second = await press(card.identifier, a);
      expect(second.outcome).toBe('claimed');
      expect(second.runId).not.toBe(first.runId);
      expect(await fixRuns(card.id)).toHaveLength(2);
    });
  }
});

describe('the hosted lane is unchanged', () => {
  it('a hosted opening still writes a run whose agent is opencode and an event with no agent key', async () => {
    const card = await redCard();
    const claim = await workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx, {
      opening: {
        origin: 'hosted',
        agent: 'opencode',
        model: 'claude-opus-5-5',
        idempotencyKey: 'hosted-1',
      },
    });
    expect(claim.outcome).toBe('claimed');
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: claim.runId! } });
    expect(run).toMatchObject({ origin: 'hosted', agent: 'opencode', command: 'fix' });
    const event = await adminDb.dispatchRunEvent.findFirstOrThrow({
      where: { dispatchRunId: run.id, kind: 'run_opened' },
    });
    expect(event.data).toMatchObject({ origin: 'hosted', model: 'claude-opus-5-5' });
    expect(event.data).not.toHaveProperty('agent');
    expect(event.data).not.toHaveProperty('agentInstanceId');
  });

  it('still calls admit before anything is written and rolls the claim back on its throw', async () => {
    const card = await redCard();
    await expect(
      workItemRepairService.claimRepair(fx.projectId, card.identifier, fx.ctx, {
        opening: {
          origin: 'hosted',
          agent: 'opencode',
          model: 'm',
          idempotencyKey: 'hosted-2',
        },
        admit: () => {
          throw new Error('not a review');
        },
      }),
    ).rejects.toThrow('not a review');
    expect(await fixRuns(card.id)).toEqual([]);
  });
});
