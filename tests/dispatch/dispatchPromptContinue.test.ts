import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { ContinueFromInvalidError } from '@/lib/dispatchRuns/errors';
import {
  agentInstanceRunService,
  type AgentRunEndOutcome,
} from '@/lib/services/agentInstanceRunService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { hostedRunService, type HostedRunEndOutcome } from '@/lib/services/hostedRunService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// `dispatch-prompt?continueFrom=` (Story MOTIR-6526 · MOTIR-6531) — the SERVICE
// half: the run it names is validated against the item, and the branch is the
// open pull request's head, else the one the run recorded on `checkout_ready`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function runOver(
  fx: WorkItemFixture,
  key: string,
  branch: string | null,
  close: 'halted' | 'completed' | null,
) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key, disposition: 'queued' }],
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [{ kind: 'checkout_ready', workItemKey: key, disposition: 'running', data: { branch } }],
    fx.ctx,
  );
  if (close) await dispatchRunService.close(run.id, { stopReason: close }, fx.ctx);
  return run.id;
}

const prompt = (fx: WorkItemFixture, key: string, continueFrom: string) =>
  dispatchPromptService.getDispatchPrompt(fx.projectId, key, fx.ctx, { continueFrom });

describe('getDispatchPrompt with continueFrom', () => {
  it('continues a dead run on the branch its checkout_ready recorded', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    await setStatus(card.id, 'in_progress');
    const runId = await runOver(fx, card.identifier, 'subtask/recorded-branch', 'halted');

    const dto = await prompt(fx, card.identifier, runId);

    expect(dto.branch).toBe('subtask/recorded-branch');
    expect(dto.prompt).toContain('CONTINUE — you are carrying on a run that DIED');
    expect(dto.prompt).toContain('It ended: the agent exited with an error.');
    expect(dto.prompt).toContain('git worktree add ');
    expect(dto.prompt).toContain(' subtask/recorded-branch');
  });

  it('prefers the item’s OPEN pull request head', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    await setStatus(card.id, 'in_progress');
    const runId = await runOver(fx, card.identifier, 'subtask/recorded-branch', 'halted');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/the-pr',
      baseRef: 'main',
      checks: {},
    });

    const dto = await prompt(fx, card.identifier, runId);

    expect(dto.branch).toBe('subtask/the-pr');
    expect(dto.prompt).toContain(`acme/${repo.name} #`);
  });

  it('refuses a run that is still open, one that succeeded, and one that is not this item’s', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'another card' });

    const open = await runOver(fx, card.identifier, 'b1', null);
    const succeeded = await runOver(fx, card.identifier, 'b2', 'completed');
    const foreign = await runOver(fx, other.identifier, 'b3', 'halted');

    for (const [runId, why] of [
      [open, 'still_running'],
      [succeeded, 'succeeded'],
      [foreign, 'unknown'],
      ['run_does_not_exist', 'unknown'],
    ] as const) {
      const err = await prompt(fx, card.identifier, runId).catch((e: unknown) => e);
      expect(err, runId).toBeInstanceOf(ContinueFromInvalidError);
      expect((err as ContinueFromInvalidError).why).toBe(why);
    }
  });

  it('refuses another WORKSPACE’s run exactly as an unknown one', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const theirCard = await createTestWorkItem(theirs, { kind: 'task', title: 'theirs' });
    const theirRun = await runOver(theirs, theirCard.identifier, 'b', 'halted');

    const err = await prompt(fx, card.identifier, theirRun).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContinueFromInvalidError);
    expect((err as ContinueFromInvalidError).code).toBe('CONTINUE_FROM_INVALID');
  });
});

// A dead run's branch PER REPOSITORY (Story MOTIR-6527 · MOTIR-6791): a run that
// spanned two repositories checkpointed a branch in each, and the CONTINUE block
// and workflow name both — not only the first.
describe('getDispatchPrompt with continueFrom — a run across repositories', () => {
  async function twoRepoDeadRun(fx: WorkItemFixture) {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    await setStatus(card.id, 'in_progress');
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { targetRepo: 'core', targetRepos: ['core', 'web'] },
    });
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
      [
        {
          kind: 'checkout_ready',
          workItemKey: card.identifier,
          disposition: 'running',
          data: {
            branches: [
              { repository: 'core', branch: 'task/the-card', workBranch: 'task/the-card' },
              { repository: 'web', branch: 'task/the-card', workBranch: 'task/the-card' },
            ],
          },
        },
      ],
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);
    return { card, runId: run.id };
  }

  it('names both repositories’ branches and ends in a pull request per repository', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await twoRepoDeadRun(fx);

    const dto = await prompt(fx, card.identifier, runId);

    expect(dto.branch).toBe('task/the-card');
    expect(dto.prompt).toContain('Its work spans 2 repositories, on a branch in each:');
    expect(dto.prompt).toContain('    - core: task/the-card');
    expect(dto.prompt).toContain('    - web: task/the-card');
    expect(dto.prompt).toContain('This is a CONTINUE across 2 repositories');
    expect(dto.prompt).toContain('git worktree add ../core-');
    expect(dto.prompt).toContain('git worktree add ../web-');
    expect(dto.prompt).toContain('STOP at the 2 open pull requests — one per repository.');
    expect(dto.prompt).not.toContain('Its work is on the branch');
  });

  it('a repository with an open pull request contributes ITS head, independently of the other', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await twoRepoDeadRun(fx);
    const web = await connectRepairRepo(fx, 'web');
    await deliveredPr(fx, card.id, web, { headRef: 'task/web-pr-head', checks: {} });

    const dto = await prompt(fx, card.identifier, runId);

    expect(dto.branch).toBe('task/the-card');
    expect(dto.prompt).toContain('    - core: task/the-card');
    expect(dto.prompt).toMatch(/ {4}- web: task\/web-pr-head — open pull request #\d+/);
    expect(dto.prompt).toMatch(/for it \(`gh pr list --head task\/web-pr-head`\) — #\d+ is\./);
  });

  it('a one-repository dead run renders exactly the single-branch text', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
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
      [
        {
          kind: 'checkout_ready',
          workItemKey: card.identifier,
          disposition: 'running',
          data: { branches: [{ repository: 'core', branch: 'task/one', workBranch: 'task/one' }] },
        },
      ],
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);
    const legacy = await runOver(fx, card.identifier, 'task/one', 'halted');

    const perRepo = await prompt(fx, card.identifier, run.id);
    const single = await prompt(fx, card.identifier, legacy);

    const norm = (text: string, id: string) =>
      text.replaceAll(id, 'RUN').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TIME');
    expect(norm(perRepo.prompt, run.id)).toBe(norm(single.prompt, legacy));
    expect(perRepo.prompt).toContain('Its work is on the branch task/one.');
  });
});

// HOW THE DEAD RUN ENDED, AS THE CONTINUE PROMPT SAYS IT (MOTIR-7085). Both end
// paths close a stall and the 12-hour backstop `abandoned` — the stop reason a
// lapse writes too — so the sentence is driven through the REAL end paths here,
// never a hand-built `stopReason: null` row.
describe('getDispatchPrompt with continueFrom — how the dead run ended', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openWithBranch(fx: WorkItemFixture, origin: 'local' | 'hosted') {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    await setStatus(card.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin,
        cards: [{ key: card.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'checkout_ready',
          workItemKey: card.identifier,
          disposition: 'running',
          data: { branch: 'subtask/the-work' },
        },
      ],
      fx.ctx,
    );
    return { card, runId: run.id };
  }

  async function endedBy(
    end:
      | { origin: 'hosted'; outcome: HostedRunEndOutcome }
      | { origin: 'instance'; outcome: AgentRunEndOutcome },
  ) {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await openWithBranch(fx, end.origin === 'hosted' ? 'hosted' : 'local');
    if (end.origin === 'hosted') {
      // The revocations call out; every one of them answering "failed" is still an end.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{}', { status: 503 })),
      );
      const ended = await hostedRunService.endHostedRun(runId, end.outcome, 'the end detail');
      expect(ended.closed).toBe(true);
    } else {
      await adminDb.dispatchRun.update({ where: { id: runId }, data: { origin: 'instance' } });
      const ended = await agentInstanceRunService.end(runId, end.outcome, 'the end detail');
      expect(ended.closed).toBe(true);
    }
    return (await prompt(fx, card.identifier, runId)).prompt;
  }

  it.each<[HostedRunEndOutcome, string]>([
    [
      'stall',
      'It ended: the Motir agent run stalled — it produced no output for too long — and was stopped.',
    ],
    ['backstop', 'It ended: the Motir agent run reached its 12-hour time limit and was stopped.'],
    ['lost_supervision', 'It ended: the run stopped reporting (no heartbeat reached Motir).'],
  ])('a hosted run ended %s', async (outcome, sentence) => {
    expect(await endedBy({ origin: 'hosted', outcome })).toContain(sentence);
  });

  it.each<[AgentRunEndOutcome, string]>([
    [
      'stall',
      'It ended: the run in the agent stalled — it produced no output for too long — and was stopped.',
    ],
    ['backstop', 'It ended: the run in the agent reached its 12-hour time limit and was stopped.'],
    ['lapsed', 'It ended: the run stopped reporting (no heartbeat reached Motir).'],
  ])('a run in an agent ended %s', async (outcome, sentence) => {
    expect(await endedBy({ origin: 'instance', outcome })).toContain(sentence);
  });

  it('a local run the lapse reap closed stopped reporting', async () => {
    const fx = await makeWorkItemFixture();
    const { card, runId } = await openWithBranch(fx, 'local');
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { lastHeartbeatAt: new Date(Date.now() - 24 * 60 * 60_000) },
    });
    expect((await dispatchRunSweepService.reapLapsed()).runsReaped).toBe(1);

    const text = (await prompt(fx, card.identifier, runId)).prompt;
    expect(text).toContain('It ended: the run stopped reporting (no heartbeat reached Motir).');
  });

  it('a run in an agent the continue takeover closed stopped reporting', async () => {
    // A hosted run never lapses (its liveness is its supervision); a run in an
    // agent does, and the takeover closes it `timed_out` + `abandoned` with no `end`.
    const fx = await makeWorkItemFixture();
    const { card, runId } = await openWithBranch(fx, 'local');
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { origin: 'instance', lastHeartbeatAt: new Date(Date.now() - 24 * 60 * 60_000) },
    });
    const claim = await workItemContinueService.claimContinue(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(claim).toMatchObject({ outcome: 'claimed' });
    expect(await adminDb.dispatchRun.findUnique({ where: { id: runId } })).toMatchObject({
      status: 'timed_out',
      stopReason: 'abandoned',
    });

    const text = (await prompt(fx, card.identifier, runId)).prompt;
    expect(text).toContain('It ended: the run stopped reporting (no heartbeat reached Motir).');
  });
});
