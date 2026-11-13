import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  agentInstanceRunService,
  type AgentRunEndOutcome,
} from '@/lib/services/agentInstanceRunService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { hostedRunService, type HostedRunEndOutcome } from '@/lib/services/hostedRunService';
import { endedHow, workItemContinueService } from '@/lib/services/workItemContinueService';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { setStatus } from '../helpers/repairFixtures';

// HOW A RUN DIED, IN WORDS (Story MOTIR-6526 · MOTIR-6537) — the reason the *run
// died* marker's first line gives (`diedReason`, design D3) and the sentence the
// CONTINUE prompt hands the next agent (`endedHow`), for every way a run ends
// without succeeding. Both read the SAME row; the view is exercised over real
// Postgres because a hosted `timed_out` is split by its closing log line.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Ending = {
  status: 'running' | 'failed' | 'cancelled' | 'timed_out';
  stopReason: 'interrupted' | 'abandoned' | 'halted' | null;
  origin: 'local' | 'hosted' | 'instance';
  log?: string;
};

async function viewAfter(ending: Ending) {
  const fx = await makeWorkItemFixture();
  const card = await createTestWorkItem(fx, { kind: 'task', title: 'a card whose run ended' });
  await setStatus(card.id, 'in_progress');
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  if (ending.log) {
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'log', data: { message: ending.log } }],
      fx.ctx,
    );
  }
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: {
      status: ending.status,
      stopReason: ending.stopReason,
      origin: ending.origin,
      endedAt: ending.status === 'running' ? null : new Date(),
      // A running row is read as lapsed only once its heartbeat is old.
      lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
    },
  });
  return workItemContinueService.getContinueView(card.id, fx.ctx);
}

describe('the died reason (the marker’s first line)', () => {
  it.each<[string, Ending, string]>([
    [
      'a lapsed local run, not yet swept',
      { status: 'running', stopReason: null, origin: 'local' },
      'lapsed',
    ],
    ['a swept one', { status: 'timed_out', stopReason: 'abandoned', origin: 'local' }, 'lapsed'],
    ['Ctrl-C', { status: 'cancelled', stopReason: 'interrupted', origin: 'local' }, 'interrupted'],
    ['an agent error', { status: 'failed', stopReason: 'halted', origin: 'local' }, 'failed'],
    ['a cancel', { status: 'cancelled', stopReason: null, origin: 'local' }, 'cancelled'],
    [
      'the hosted 12-hour backstop',
      {
        status: 'timed_out',
        stopReason: null,
        origin: 'hosted',
        log: 'reached its 12-hour backstop',
      },
      'backstop',
    ],
    [
      'the hosted stall watchdog',
      { status: 'timed_out', stopReason: null, origin: 'hosted', log: 'no output for 15 minutes' },
      'stalled',
    ],
    [
      // The lapse sweep and the continue takeover close with this line and no `end`.
      'a hosted run closed as lapsed (abandoned, no end on its log line)',
      {
        status: 'timed_out',
        stopReason: 'abandoned',
        origin: 'hosted',
        log: 'no heartbeat since 2026-09-30T10:00:00.000Z',
      },
      'lapsed',
    ],
    [
      'a local timed_out with no reason',
      { status: 'timed_out', stopReason: null, origin: 'local' },
      'lapsed',
    ],
  ])('%s → %s', async (_label, ending, reason) => {
    const view = await viewAfter(ending);
    expect(view).toMatchObject({ state: 'died', reason });
  });
});

/**
 * A run closed by its REAL end path — the rows `endHostedRun` and the agent end
 * path actually write (MOTIR-7061), rather than a hand-built log line: both close a
 * timeout `abandoned`, and the hosted one names its end only in `data.end`.
 */
async function viewAfterEnd(
  end:
    | { origin: 'hosted'; outcome: HostedRunEndOutcome }
    | { origin: 'instance'; outcome: AgentRunEndOutcome },
) {
  const fx = await makeWorkItemFixture();
  const card = await createTestWorkItem(fx, { kind: 'task', title: 'a card whose run ended' });
  await setStatus(card.id, 'in_progress');
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      origin: end.origin === 'hosted' ? 'hosted' : 'local',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  if (end.origin === 'hosted') {
    // The revocations call out; every one of them answering "failed" is still an end.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    const ended = await hostedRunService.endHostedRun(run.id, end.outcome, 'the end detail');
    expect(ended.closed).toBe(true);
  } else {
    // A run in an agent without the agent row: the reader keys on the origin alone.
    await adminDb.dispatchRun.update({ where: { id: run.id }, data: { origin: 'instance' } });
    const ended = await agentInstanceRunService.end(run.id, end.outcome, 'the end detail');
    expect(ended.closed).toBe(true);
  }
  return workItemContinueService.getContinueView(card.id, fx.ctx);
}

describe('the died reason of a run closed by its real end path (MOTIR-7061)', () => {
  it.each<[HostedRunEndOutcome, string]>([
    ['backstop', 'backstop'],
    ['stall', 'stalled'],
    ['lost_supervision', 'lapsed'],
    ['failed', 'failed'],
    ['cancelled', 'interrupted'],
  ])('a hosted run ended %s → %s', async (outcome, reason) => {
    const view = await viewAfterEnd({ origin: 'hosted', outcome });
    expect(view).toMatchObject({ state: 'died', reason });
  });

  it.each<[AgentRunEndOutcome, string]>([
    ['backstop', 'backstop'],
    ['stall', 'stalled'],
    ['lapsed', 'lapsed'],
    ['failed', 'failed'],
  ])('a run in an agent ended %s → %s', async (outcome, reason) => {
    const view = await viewAfterEnd({ origin: 'instance', outcome });
    expect(view).toMatchObject({ state: 'died', reason });
  });
});

describe('endedHow (the CONTINUE prompt’s sentence)', () => {
  // The prompt-level rows driven through the REAL end paths are in
  // `tests/dispatch/dispatchPromptContinue.test.ts` (MOTIR-7085); this is the
  // sentence table over the `timeout` its caller resolves.
  it.each<[Ending, 'stalled' | 'backstop' | null, RegExp]>([
    [{ status: 'running', stopReason: null, origin: 'local' }, null, /stopped reporting/],
    [{ status: 'timed_out', stopReason: 'abandoned', origin: 'local' }, null, /stopped reporting/],
    [
      { status: 'cancelled', stopReason: 'interrupted', origin: 'local' },
      null,
      /stopped from its terminal/,
    ],
    [{ status: 'failed', stopReason: null, origin: 'local' }, null, /exited with an error/],
    [{ status: 'cancelled', stopReason: null, origin: 'local' }, null, /was cancelled/],
    [
      { status: 'timed_out', stopReason: 'abandoned', origin: 'hosted' },
      'stalled',
      /^the Motir agent run stalled — it produced no output/,
    ],
    [
      { status: 'timed_out', stopReason: 'abandoned', origin: 'hosted' },
      'backstop',
      /^the Motir agent run reached its 12-hour time limit/,
    ],
    [
      { status: 'timed_out', stopReason: 'abandoned', origin: 'instance' },
      'stalled',
      /^the run in the agent stalled — it produced no output/,
    ],
    [
      { status: 'timed_out', stopReason: 'abandoned', origin: 'instance' },
      'backstop',
      /^the run in the agent reached its 12-hour time limit/,
    ],
    // A lapse closes `abandoned` too, and resolves no timeout.
    [{ status: 'timed_out', stopReason: 'abandoned', origin: 'hosted' }, null, /stopped reporting/],
    [
      { status: 'timed_out', stopReason: 'abandoned', origin: 'instance' },
      null,
      /stopped reporting/,
    ],
    [
      { status: 'timed_out', stopReason: null, origin: 'hosted' },
      null,
      /Motir agent run stalled or reached its time limit/,
    ],
    [
      { status: 'timed_out', stopReason: null, origin: 'instance' },
      null,
      /run in the agent stalled or reached its time limit/,
    ],
    [{ status: 'timed_out', stopReason: null, origin: 'local' }, null, /ended timed_out/],
  ])('%o, timeout %s', (ending, timeout, sentence) => {
    expect(endedHow(ending, timeout)).toMatch(sentence);
  });
});

describe('where the work is, when no checkout was recorded (the fallbacks)', () => {
  it('a card’s leg that recorded only its SESSION branch names that branch', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'a leg of a session' });
    await setStatus(card.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'log', workItemKey: card.identifier, sessionBranch: 'motir/auto-20260927-1000' }],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    const view = await workItemContinueService.getContinueView(card.id, fx.ctx);
    expect(view).toMatchObject({ state: 'died', branch: 'motir/auto-20260927-1000' });
  });

  it('a CONTAINER, which holds no leg of its own, names the session branch its legs recorded', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'a story run as one' });
    const child = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'its child',
      parentId: story.id,
    });
    await setStatus(story.id, 'in_progress');
    await setStatus(child.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: story.identifier,
        cards: [{ key: child.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'log', workItemKey: child.identifier, sessionBranch: 'motir/auto-20260927-1100' }],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    const view = await workItemContinueService.getContinueView(story.id, fx.ctx);
    expect(view).toMatchObject({
      state: 'died',
      branch: 'motir/auto-20260927-1100',
      refusal: null,
    });
  });
});

describe('the edges', () => {
  it('a hosted timed_out with no closing log line reads as the stall watchdog', async () => {
    const view = await viewAfter({ status: 'timed_out', stopReason: null, origin: 'hosted' });
    expect(view).toMatchObject({ state: 'died', reason: 'stalled' });
  });

  it('a claim on a card nobody was assigned to names no previous assignee', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'unassigned' });
    await setStatus(card.id, 'in_progress');
    await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: null } });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'checkout_ready', workItemKey: card.identifier, data: { branch: 'subtask/x' } }],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    const claim = await workItemContinueService.claimContinue(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(claim).toMatchObject({ outcome: 'claimed', previousAssignee: null });
  });

  it('a view of an id that is not a work item is the ordinary not-found', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemContinueService.getContinueView('not-a-work-item', fx.ctx),
    ).rejects.toThrow();
  });
});
