import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { DispatchCardDisposition, DispatchStopReason } from '@/generated/prisma/client';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import {
  dispatchRunService,
  type AppendDispatchRunEventInput,
} from '@/lib/services/dispatchRunService';
import { runRecordReadService } from '@/lib/services/runRecordReadService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { setStatus } from '../helpers/repairFixtures';

// A RUN WITH A FAILED LEG IS NOT A SUCCESS (MOTIR-10984), over real Postgres.
//
// The defect: an adopted scope drains with `keepGoing` (MOTIR-6558), so a card that
// fails does not halt the loop — the drain skips its dependents and closes `drained`.
// The close derived the status from the stop reason alone, so a story run that built
// one card of four was stored `succeeded`. The close now reads the legs it already
// holds in its own transaction: any leg REPORTED `failed` makes the run `failed`,
// and the stop reason is still stored as sent — it says why the loop ended.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Leg =
  | { disposition: Exclude<DispatchCardDisposition, 'skipped'> }
  | { disposition: 'skipped'; skipReason: 'blocked_in_scope' | 'needs_human' };

interface OpenedRun {
  runId: string;
  keys: string[];
  ids: string[];
}

/**
 * Open a local run over one in-progress card per leg, put each on its own branch,
 * and REPORT each leg's outcome the way the CLI does — `checkout_ready`, then
 * `card_settled` with the disposition — so the close sees what a real run leaves.
 */
async function runWithLegs(legs: readonly Leg[]): Promise<OpenedRun> {
  const cards = [];
  for (let i = 0; i < legs.length; i += 1) {
    const card = await createTestWorkItem(fx, {
      kind: 'task',
      title: `card ${i + 1} ${randomToken(4)}`,
    });
    await setStatus(card.id, 'in_progress');
    cards.push(card);
  }
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run_scope',
      reportedBy: 'cli',
      cards: cards.map((c) => ({ key: c.identifier, disposition: 'queued' as const })),
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    cards.flatMap((card, i): AppendDispatchRunEventInput[] => {
      const leg = legs[i]!;
      if (leg.disposition === 'skipped') {
        return [
          {
            kind: 'card_settled' as const,
            workItemKey: card.identifier,
            disposition: 'skipped' as const,
            skipReason: leg.skipReason,
          },
        ];
      }
      return [
        {
          kind: 'checkout_ready' as const,
          workItemKey: card.identifier,
          disposition: 'running' as const,
          data: { branch: `subtask/${card.identifier}-work` },
        },
        ...(leg.disposition === 'running'
          ? []
          : [
              {
                kind: 'card_settled' as const,
                workItemKey: card.identifier,
                disposition: leg.disposition,
              },
            ]),
      ];
    }),
    fx.ctx,
  );
  return { runId: run.id, keys: cards.map((c) => c.identifier), ids: cards.map((c) => c.id) };
}

/** The production shape: one leg integrated, one failed, two skipped behind it. */
const STORY_RUN: readonly Leg[] = [
  { disposition: 'integrated' },
  { disposition: 'failed' },
  { disposition: 'skipped', skipReason: 'blocked_in_scope' },
  { disposition: 'skipped', skipReason: 'blocked_in_scope' },
];

async function storedRun(runId: string) {
  return adminDb.dispatchRun.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true, stopReason: true },
  });
}

describe('criterion 1 — a run with a failed leg is stored failed, its stop reason as sent', () => {
  it('reproduces the production run: integrated + failed + 2 skipped, closed `drained`', async () => {
    const { runId } = await runWithLegs(STORY_RUN);

    const closed = await dispatchRunService.close(runId, { stopReason: 'drained' }, fx.ctx);

    // Before MOTIR-10984 this read `succeeded` / `drained`.
    expect(closed).toMatchObject({ status: 'failed', stopReason: 'drained' });
    expect(await storedRun(runId)).toEqual({ status: 'failed', stopReason: 'drained' });
    // The legs themselves are left exactly as reported.
    expect(closed.cards.map((c) => c.disposition)).toEqual([
      'integrated',
      'failed',
      'skipped',
      'skipped',
    ]);
  });

  it.each<DispatchStopReason>([
    'completed',
    'drained',
    'max',
    'replanned',
    'gated',
    'interrupted',
    'halted',
  ])('stop reason `%s` with a failed leg → failed', async (stopReason) => {
    const { runId } = await runWithLegs([{ disposition: 'integrated' }, { disposition: 'failed' }]);

    await dispatchRunService.close(runId, { stopReason }, fx.ctx);

    expect(await storedRun(runId)).toEqual({ status: 'failed', stopReason });
  });

  it('a server-side close that STATES `cancelled` is corrected too; `timed_out` stands', async () => {
    const cancelled = await runWithLegs([{ disposition: 'failed' }]);
    await dispatchRunService.close(
      cancelled.runId,
      { stopReason: 'interrupted', status: 'cancelled' },
      fx.ctx,
    );
    expect(await storedRun(cancelled.runId)).toEqual({
      status: 'failed',
      stopReason: 'interrupted',
    });

    // The reap's word for a run that died says more than `failed` would.
    const reaped = await runWithLegs([{ disposition: 'failed' }]);
    await dispatchRunService.close(reaped.runId, { stopReason: 'abandoned' }, fx.ctx);
    expect(await storedRun(reaped.runId)).toEqual({
      status: 'timed_out',
      stopReason: 'abandoned',
    });
  });

  it('a leg only the CLOSE settles to failed does not turn a stop reason into a failure', async () => {
    // An agent was on the card and nothing reported an outcome: the stop reason
    // already says what happened to it (Ctrl-C), so the run stays `cancelled`.
    const { runId } = await runWithLegs([{ disposition: 'running' }]);

    const closed = await dispatchRunService.close(runId, { stopReason: 'interrupted' }, fx.ctx);

    expect(closed.status).toBe('cancelled');
    expect(closed.cards[0]!.disposition).toBe('failed');
  });
});

describe('criterion 2 — a run with no failed leg keeps today’s status for each stop reason', () => {
  const CLEAN: readonly Leg[] = [
    { disposition: 'integrated' },
    { disposition: 'implemented' },
    { disposition: 'replanned' },
    { disposition: 'skipped', skipReason: 'needs_human' },
  ];

  it.each<[DispatchStopReason, string]>([
    ['completed', 'succeeded'],
    ['drained', 'succeeded'],
    ['replanned', 'succeeded'],
    ['gated', 'succeeded'],
    ['halted', 'failed'],
    ['interrupted', 'cancelled'],
    ['abandoned', 'timed_out'],
  ])('`%s` → %s', async (stopReason, status) => {
    const { runId } = await runWithLegs(CLEAN);

    await dispatchRunService.close(runId, { stopReason }, fx.ctx);

    expect(await storedRun(runId)).toEqual({ status, stopReason });
  });
});

describe('criterion 3 — every surface that reads the run shows it failed', () => {
  it('the run list, the card’s run section and get_run_record', async () => {
    const { runId, keys } = await runWithLegs(STORY_RUN);
    await dispatchRunService.close(runId, { stopReason: 'drained' }, fx.ctx);

    // The project's Runs list, and its `failed` filter.
    const list = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10 },
      fx.ctx,
    );
    expect(list.runs.find((r) => r.id === runId)?.status).toBe('failed');
    const failedOnly = await dispatchRunService.listRunsForProject(
      fx.projectIdentifier,
      { take: 10, statuses: ['failed'] },
      fx.ctx,
    );
    expect(failedOnly.runs.map((r) => r.id)).toEqual([runId]);

    // The card's Run section — on the card that failed and on one that landed.
    for (const key of [keys[1]!, keys[0]!]) {
      const section = await dispatchRunService.listRunsForWorkItemKey(key, { take: 5 }, fx.ctx);
      expect(section.map((r) => [r.id, r.status])).toEqual([[runId, 'failed']]);
    }

    // `get_run_record`'s read.
    const record = await runRecordReadService.readRun(fx.projectId, runId, fx.ctx);
    expect(record).toMatchObject({ outcome: 'found' });
    expect(JSON.stringify(record)).toContain('"status":"failed"');
  });
});

describe('criterion 4 — the continue and fix doors admit it exactly as they admit a halted run', () => {
  async function closedFailedRun(stopReason: DispatchStopReason) {
    const opened = await runWithLegs([{ disposition: 'integrated' }, { disposition: 'failed' }]);
    await dispatchRunService.close(opened.runId, { stopReason }, fx.ctx);
    return opened;
  }

  async function doorsFor(opened: OpenedRun) {
    const failedKey = opened.keys[1]!;
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: opened.ids[1]! } });
    const prompt = await dispatchPromptService.getDispatchPrompt(fx.projectId, failedKey, fx.ctx, {
      continueFrom: opened.runId,
    });
    const view = await workItemContinueService.getContinueView(opened.ids[1]!, fx.ctx);
    const claim = await workItemContinueService.claimContinue(fx.projectId, failedKey, fx.ctx);
    return {
      // To fix — the reason `motir continue` (and Fix on the Workbench) is offered by.
      fixReason: card.fixReason,
      repair: (card.fixDetail as Record<string, unknown> | null)?.['repair'] ?? null,
      // `continueFrom` refuses a `succeeded` run; it accepts this one.
      promptBranch: prompt.branch,
      diedLine: prompt.prompt.includes('It ended: the agent exited with an error.'),
      viewState: view.state,
      viewReason: view.state === 'died' ? view.reason : null,
      claimOutcome: claim.outcome,
      claimBranch: claim.branch,
    };
  }

  it('a `drained` run with a failed leg is continued like a `halted` one', async () => {
    const drained = await doorsFor(await closedFailedRun('drained'));
    await truncateAuthTables();
    fx = await makeWorkItemFixture();
    const halted = await doorsFor(await closedFailedRun('halted'));

    expect(drained).toMatchObject({
      fixReason: 'run_died',
      repair: 'continue',
      diedLine: true,
      viewState: 'died',
      viewReason: 'failed',
      claimOutcome: 'claimed',
    });
    expect(drained.promptBranch).toMatch(/^subtask\/.+-work$/);
    expect(drained.claimBranch).toBe(drained.promptBranch);
    // Side by side, the two runs open every door the same way.
    expect({ ...drained, promptBranch: null, claimBranch: null }).toEqual({
      ...halted,
      promptBranch: null,
      claimBranch: null,
    });
  });
});
