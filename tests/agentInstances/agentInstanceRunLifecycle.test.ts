import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveBoot } from '../helpers/agentBootDriver';
import type { PersistentExecResult } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { AgentInstanceRunActiveError } from '@/lib/agentInstances/errors';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { agentRunStopCommand } from '@/lib/agentInstances/terminal';
import { agentInstanceRunSupervise } from '@/lib/jobs/definitions/agentInstanceRunSupervise';
import { engineJob } from '@/lib/jobs/engine/registry';
import { JobRunDefer } from '@/lib/jobs/engine/defer';
import { jobServices } from '@/lib/jobs/services';
import {
  agentInstanceActivityService,
  RUN_ACTIVITY_BUMP_MS,
} from '@/lib/services/agentInstanceActivityService';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import {
  AGENT_RUN_BACKSTOP_MS,
  AGENT_RUN_END_DETAIL,
  AGENT_RUN_SUPERVISE_POLL_MS,
  agentInstanceRunService as runs,
  agentRunLaunchKey,
  agentRunSuperviseKey,
} from '@/lib/services/agentInstanceRunService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import {
  clock,
  fleet,
  fx,
  MIN,
  otherMember,
  seedRepo,
  setUpHarness,
  stub,
  tearDownHarness,
} from './_harness';

// A LIVE RUN KEEPS ITS AGENT AND ALWAYS ENDS (Story MOTIR-6864 · MOTIR-7027,
// `docs/decisions/agent-instance-run.md` §6) — against a real Postgres and the
// fake persistent fleet, whose `exec` answers as the agent's terminal server.
//
// Every end is asserted by its record: the run's status, its closing line, its
// run token gone, and — where the end reaches the agent — the `stop` exec.

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

const cancelRoute = await import('@/app/api/dispatch-runs/[id]/cancel/route');
const closeRoute = await import('@/app/api/v1/dispatch-runs/[id]/close/route');
const gitCredentialRoute = await import('@/app/api/v1/dispatch-runs/[id]/git-credential/route');
const hibernateRoute = await import('@/app/api/projects/[key]/instances/[id]/hibernate/route');
const deleteRoute = await import('@/app/api/projects/[key]/instances/[id]/route');

const MASTER = 'm'.repeat(48);

/** What the fake agent's terminal server answers; `stopThrows` makes the machine unreachable. */
const agentSide = { stopThrows: false };

function answer(command: readonly string[]): PersistentExecResult {
  const line = command.join(' ');
  const ok = (stdout = ''): PersistentExecResult => ({ exitCode: 0, stdout, stderr: '' });
  if (line.endsWith('motir agent-terminal signin')) {
    return ok('{"profile":"claude","state":"signed_in"}\n');
  }
  if (line.includes('motir agent-terminal run ') && line.includes('--run-id')) {
    return ok('{"session":"sess-1"}\n');
  }
  if (line.includes('motir agent-terminal stop ')) {
    if (agentSide.stopThrows) throw new Error('the exec could not reach the machine');
    return ok('{"result":"stopped"}\n');
  }
  return ok();
}

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  resetRateLimitStore();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  agentSide.stopThrows = false;
  fleet.setExecResponder(answer);
  await seedRepo('acme', 'web');
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KEY = () => fx.projectIdentifier;
const agentRow = async (id: string) => (await adminDb.agentInstance.findUnique({ where: { id } }))!;
const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });
const runTokens = (id: string) => adminDb.apiToken.findMany({ where: { dispatchRunId: id } });
const stops = (runId: string) =>
  fleet.execs.filter((e) => e.command.join(' ') === agentRunStopCommand(runId).join(' '));
const closingLines = async (runId: string) =>
  (
    await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: runId, kind: 'log' },
      orderBy: { seq: 'asc' },
    })
  )
    .map((e) => e.body ?? '')
    .filter((b) => b.includes('run in agent ended'));

/** Move the lifecycle's clock to the real clock (plus `offsetMs`) — run rows are stamped by the database. */
function atRealNow(offsetMs = 0): void {
  clock.advance(Date.now() + offsetMs - clock.now().getTime());
}

async function agent(name = 'yue-claude'): Promise<string> {
  const dto = await lifecycle.create(KEY(), { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('running');
  return dto.id;
}

/** A run started in a fresh agent and launched: its id, its agent, its card and its token. */
async function startedRun(name?: string) {
  const agentId = await agent(name);
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'a card' },
    fx.ctx,
  );
  const started = await runs.start(
    { workItemKey: item.identifier, agentInstanceId: agentId },
    fx.ctx,
  );
  const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
  await engineJob('agent-instance-run/launch')!.handler(
    {
      step,
      event: {
        data: {
          workspaceId: fx.workspaceId,
          dispatchRunId: started.dispatchRunId,
          idempotencyKey: agentRunLaunchKey(started.dispatchRunId),
        },
      },
    } as never,
    jobServices as never,
  );
  const launch = fleet.execs.filter((e) => e.command.includes(started.dispatchRunId)).at(-1)!;
  const token = (JSON.parse(launch.stdin!) as { token: string }).token;
  expect(await runTokens(started.dispatchRunId)).toHaveLength(1);
  return { runId: started.dispatchRunId, agentId, item, token };
}

/** Drive the supervise job's handler for a run, as the engine would. */
async function superviseJob(dispatchRunId: string): Promise<unknown> {
  return engineJob('agent-instance-run/supervise')!.handler(
    {
      event: {
        data: {
          workspaceId: fx.workspaceId,
          dispatchRunId,
          idempotencyKey: agentRunSuperviseKey(dispatchRunId),
        },
      },
    } as never,
    jobServices as never,
  );
}

const cancel = (id: string) =>
  cancelRoute.POST(new Request('http://t/cancel', { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });

/** The CLI's own close, as the agent's CLI sends it: its run token, the v1 route. */
const cliClose = (id: string, token: string) =>
  closeRoute.POST(
    new Request(`http://localhost/api/v1/dispatch-runs/${id}/close`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ stopReason: 'completed' }),
    }),
    { params: Promise.resolve({ id }) },
  );

/** The run token asking for a git credential — what every close must refuse. */
const gitCredential = (id: string, token: string) =>
  gitCredentialRoute.POST(
    new Request(`http://localhost/api/v1/dispatch-runs/${id}/git-credential`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ id }) },
  );

async function expectRevoked(runId: string, token: string): Promise<void> {
  expect(await runTokens(runId)).toEqual([]);
  expect((await gitCredential(runId, token)).status).toBe(401);
}

describe('the start hands the run to its supervision', () => {
  it('enqueues one supervise job per run, keyed by the run, and registers the job', async () => {
    const { runId } = await startedRun();
    const jobs = await adminDb.jobQueueRun.findMany({
      where: { jobId: 'agent-instance-run/supervise' },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotencyKey).toContain(runId);
    expect(agentInstanceRunSupervise.id).toBe('agent-instance-run/supervise');
    expect(engineJob('agent-instance-run/supervise')).toBeDefined();
  });
});

describe('the supervise job (§6)', () => {
  it('defers a minute while the run is live, and a missing run ends it', async () => {
    const { runId } = await startedRun();
    atRealNow();
    const verdict = await runs.supervise(runId);
    expect(verdict).toEqual({
      deferUntil: new Date(clock.now().getTime() + AGENT_RUN_SUPERVISE_POLL_MS),
    });
    await expect(superviseJob(runId)).rejects.toBeInstanceOf(JobRunDefer);
    expect((await runRow(runId)).status).toBe('running');
    expect(await runs.supervise('no-such-run')).toBe('closed');
  });

  it('closes a run silent past the stall window timed_out, stops its session, and a second delivery writes nothing', async () => {
    const { runId, token, item } = await startedRun();
    atRealNow(15 * MIN + 1_000);
    expect(await superviseJob(runId)).toBe('stalled');
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });
    expect(await closingLines(runId)).toEqual([
      `[motir] run in agent ended (stalled): ${AGENT_RUN_END_DETAIL.stall}\n`,
    ]);
    expect(stops(runId)).toHaveLength(1);
    await expectRevoked(runId, token);
    // The card keeps the status the work left it at (`run-death-keeps-work.md` §3).
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_progress',
    );

    // A duplicate delivery of the job: the run is closed, nothing is written twice.
    expect(await superviseJob(runId)).toBe('closed');
    expect(await closingLines(runId)).toHaveLength(1);
    expect(stops(runId)).toHaveLength(1);
    expect((await runRow(runId)).endedAt).toEqual(run.endedAt);
  });

  it('closes a run at the 12-hour backstop timed_out, naming the backstop', async () => {
    const { runId, token } = await startedRun();
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { startedAt: new Date(Date.now() - AGENT_RUN_BACKSTOP_MS - MIN) },
    });
    atRealNow();
    expect(await runs.supervise(runId)).toBe('backstop');
    expect(await runRow(runId)).toMatchObject({ status: 'timed_out' });
    expect((await closingLines(runId))[0]).toMatch(/12-hour backstop/);
    expect(stops(runId)).toHaveLength(1);
    await expectRevoked(runId, token);
  });

  it('closes the run failed when its agent is no longer up — and when the agent is gone', async () => {
    const first = await startedRun('one');
    await adminDb.agentInstance.update({
      where: { id: first.agentId },
      data: { state: 'hibernated' },
    });
    atRealNow();
    expect(await runs.supervise(first.runId)).toBe('failed');
    expect(await runRow(first.runId)).toMatchObject({ status: 'failed', stopReason: 'halted' });
    expect((await closingLines(first.runId))[0]).toContain(AGENT_RUN_END_DETAIL.agentStopped);
    // The machine is not up: no stop is asked of it.
    expect(stops(first.runId)).toEqual([]);
    await expectRevoked(first.runId, first.token);

    const second = await startedRun('two');
    await adminDb.dispatchRun.update({
      where: { id: second.runId },
      data: { agentInstanceId: null },
    });
    expect(await runs.supervise(second.runId)).toBe('failed');
  });

  it('retries a revoke that failed when the CLI closed its run', async () => {
    const { runId, token } = await startedRun();
    const revoke = vi
      .spyOn(runCredentialService, 'revokeRunCredential')
      .mockRejectedValueOnce(new Error('the database blinked'));
    const closed = await cliClose(runId, token);
    expect(closed.status).toBe(200);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(await runTokens(runId)).toHaveLength(1);

    expect(await runs.supervise(runId)).toBe('closed');
    expect(await runTokens(runId)).toEqual([]);
  });
});

describe('the CLI’s own close revokes after it commits', () => {
  it('a run the CLI closes keeps its status, and its token is refused at once', async () => {
    const { runId, token } = await startedRun();
    const res = await cliClose(runId, token);
    expect(res.status).toBe(200);
    expect((await runRow(runId)).status).toBe('succeeded');
    await expectRevoked(runId, token);
    // Nothing the end path writes follows it.
    expect((await runs.end(runId, 'failed', 'late')).closed).toBe(false);
    expect((await runRow(runId)).status).toBe('succeeded');
  });
});

describe('Cancel (§6) — the agent’s owner only', () => {
  it('closes the run cancelled, then stops its session in the agent', async () => {
    const { runId, token } = await startedRun();
    const res = await cancel(runId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatchRunId: runId });
    expect(await runRow(runId)).toMatchObject({ status: 'cancelled', stopReason: 'interrupted' });
    expect(stops(runId)).toHaveLength(1);
    await expectRevoked(runId, token);

    const again = await cancel(runId);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'agent_run_already_ended' });
  });

  it('an unreachable machine still leaves the run closed', async () => {
    const { runId, token } = await startedRun();
    agentSide.stopThrows = true;
    expect((await cancel(runId)).status).toBe(200);
    expect((await runRow(runId)).status).toBe('cancelled');
    await expectRevoked(runId, token);

    // A machine with no handle at all is unreachable the same way.
    expect(await runs.stopSession(runId, null)).toBe('unreachable');
  });

  it('refuses anyone but the owner — a project admin included — and hides it from a non-browser', async () => {
    const { runId } = await startedRun();
    const other = await otherMember();
    const user = await adminDb.user.findUniqueOrThrow({ where: { id: other.userId } });
    session.user = { id: user.id, email: user.email };
    ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
    const refused = await cancel(runId);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'agent_run_cancel_forbidden' });

    vi.spyOn(projectAccessService, 'assertCanBrowse').mockRejectedValueOnce(new Error('no'));
    const hidden = await cancel(runId);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ code: 'agent_run_not_found' });
    expect((await runRow(runId)).status).toBe('running');
    expect(stops(runId)).toEqual([]);
  });

  it('a run in another workspace is not found, and the service refuses a run that is not in an agent', async () => {
    const { runId } = await startedRun();
    const elsewhere = await makeWorkItemFixture();
    await expect(runs.cancel(runId, elsewhere.ctx)).rejects.toMatchObject({
      code: 'agent_run_not_found',
    });
    await expect(runs.cancel('no-such-run', fx.ctx)).rejects.toMatchObject({
      code: 'agent_run_not_found',
    });
    expect((await runRow(runId)).status).toBe('running');
  });

  it('a Cancel racing the CLI’s close: exactly one close and one revoke', async () => {
    const { runId, token } = await startedRun();
    const revoked = vi.spyOn(runCredentialService, 'revokeRunCredential');
    const [cancelled, closed] = await Promise.all([cancel(runId), cliClose(runId, token)]);
    // Each is either the winner, or found the run closed (409 either way round).
    expect([200, 409]).toContain(cancelled.status);
    expect([200, 401, 409]).toContain(closed.status);
    const run = await runRow(runId);
    expect(['cancelled', 'succeeded']).toContain(run.status);
    const endedLines = await closingLines(runId);
    expect(endedLines.length).toBeLessThanOrEqual(1);
    if (run.status === 'succeeded') expect(endedLines).toEqual([]);
    const results = await Promise.all(revoked.mock.results.map((r) => r.value));
    expect(results.reduce((n, r: { revoked: number }) => n + r.revoked, 0)).toBe(1);
    await expectRevoked(runId, token);
  });

  // MOTIR-7489: the race above only opens under load, so it is pinned here
  // deterministically — the CLI's `succeeded` commits at the first statement of
  // the end path's close transaction, after `end()` has read the run `running`.
  it('a CLI close landing inside the end path’s close leaves no closing line on the succeeded run', async () => {
    const { runId } = await startedRun();
    const read = dispatchRunRepository.findByIdWithCards.bind(dispatchRunRepository);
    let raced = false;
    vi.spyOn(dispatchRunRepository, 'findByIdWithCards').mockImplementation(async (id, tx) => {
      if (!raced && id === runId) {
        raced = true;
        await adminDb.dispatchRun.update({
          where: { id: runId },
          data: { status: 'succeeded', stopReason: 'completed', endedAt: new Date() },
        });
      }
      return read(id, tx);
    });
    const ended = await runs.end(runId, 'cancelled', 'cancelled by the agent’s owner');
    expect(raced).toBe(true);
    expect(ended.closed).toBe(false);
    expect((await runRow(runId)).status).toBe('succeeded');
    expect(await closingLines(runId)).toEqual([]);
  });
});

describe('the lifecycle under a live run (§6)', () => {
  it('Hibernate and Delete are refused naming the run, change nothing, and succeed once the run is closed', async () => {
    const { runId, agentId, item } = await startedRun();
    const params = { params: Promise.resolve({ key: KEY(), id: agentId }) };

    const slept = await hibernateRoute.POST(
      new Request(`http://t/api/projects/${KEY()}/instances/${agentId}/hibernate`, {
        method: 'POST',
      }),
      params,
    );
    expect(slept.status).toBe(409);
    expect(await slept.json()).toMatchObject({
      code: 'agent_instance_run_active',
      runId,
      workItemKey: item.identifier,
    });
    const gone = await deleteRoute.DELETE(
      new Request(`http://t/api/projects/${KEY()}/instances/${agentId}`, { method: 'DELETE' }),
      params,
    );
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: 'agent_instance_run_active', runId });
    await expect(lifecycle.beginHibernate(agentId, 'hibernated')).rejects.toBeInstanceOf(
      AgentInstanceRunActiveError,
    );
    expect((await agentRow(agentId)).state).toBe('running');
    expect((await runRow(runId)).status).toBe('running');

    await runs.cancel(runId, fx.ctx);
    expect((await lifecycle.hibernate(KEY(), agentId, fx.ctx)).state).toBe('hibernated');
    await lifecycle.delete(KEY(), agentId, fx.ctx);
    expect((await agentRow(agentId)).deletedAt).not.toBeNull();
  });

  it('the refusal names the run alone when its card is unknown', () => {
    const err = new AgentInstanceRunActiveError('a', 'run-1', null, 'deleted');
    expect(err.message).toContain('run run-1');
    expect(mapAgentInstanceError(err)?.status).toBe(409);
  });

  it('the idle check skips an agent with a running run, and hibernates it on the first check after the run closes', async () => {
    const { runId, agentId } = await startedRun();
    clock.advance(31 * MIN);
    expect(await sweeper.checkIdle(agentId)).toBe('active');
    const summary = await sweeper.sweep();
    expect(summary.hibernated.idle).toBe(0);
    expect(summary.errors).toBe(0);
    expect((await agentRow(agentId)).state).toBe('running');

    await runs.cancel(runId, fx.ctx);
    clock.advance(31 * MIN);
    expect(await sweeper.checkIdle(agentId)).toBe('idle');
  });

  it('the sweep’s backstop closes the run timed_out FIRST, then hibernates the agent', async () => {
    const { runId, agentId, token } = await startedRun();
    clock.advance(12 * 60 * MIN + MIN);
    expect(await sweeper.checkIdle(agentId)).toBe('backstop');
    expect(await runRow(runId)).toMatchObject({ status: 'timed_out' });
    expect((await closingLines(runId))[0]).toMatch(/12-hour backstop/);
    expect(['hibernating', 'hibernated']).toContain((await agentRow(agentId)).state);
    await expectRevoked(runId, token);
  });

  it('a credit refusal closes the run failed, out of credits, then hibernates the agent', async () => {
    const { runId, agentId, token } = await startedRun();
    stub.mayRun = false;
    expect((await sweeper.sweep()).hibernated.credits).toBe(1);
    expect(await runRow(runId)).toMatchObject({ status: 'failed' });
    expect((await closingLines(runId))[0]).toContain(AGENT_RUN_END_DETAIL.outOfCredits);
    expect(['hibernating', 'hibernated']).toContain((await agentRow(agentId)).state);
    await expectRevoked(runId, token);
  });

  it('a platform admin’s stop closes the run cancelled FIRST, then hibernates the agent (MOTIR-7323)', async () => {
    const { runId, agentId, token } = await startedRun();
    const result = await lifecycle.hibernateAllForOrganization(
      fx.workspace.organizationId,
      'admin_stop',
    );
    expect(result).toMatchObject({ hibernated: 1, failures: [] });
    expect(await runRow(runId)).toMatchObject({ status: 'cancelled' });
    expect((await closingLines(runId))[0]).toContain(AGENT_RUN_END_DETAIL.adminStop);
    expect((await agentRow(agentId)).state).toBe('hibernated');
    const closed = await adminDb.agentInstanceInterval.findMany({
      where: { agentInstanceId: agentId, endedAt: { not: null } },
    });
    expect(closed.map((i) => i.endReason)).toEqual(['admin_stop']);
    await expectRevoked(runId, token);
  });

  it('an org owner or admin’s stop closes the run cancelled FIRST, then hibernates the agent (org_admin_stop)', async () => {
    const { runId, agentId, token } = await startedRun();
    const result = await lifecycle.hibernateAllForOrganization(
      fx.workspace.organizationId,
      'org_admin_stop',
    );
    expect(result).toMatchObject({ hibernated: 1, failures: [] });
    expect(await runRow(runId)).toMatchObject({ status: 'cancelled' });
    expect((await closingLines(runId))[0]).toContain(AGENT_RUN_END_DETAIL.orgAdminStop);
    expect((await agentRow(agentId)).state).toBe('hibernated');
    const closed = await adminDb.agentInstanceInterval.findMany({
      where: { agentInstanceId: agentId, endedAt: { not: null } },
    });
    expect(closed.map((i) => i.endReason)).toEqual(['org_admin_stop']);
    await expectRevoked(runId, token);
  });

  it('a machine found lost by reconcile closes its run failed, releases its legs and revokes', async () => {
    const { runId, agentId, token, item } = await startedRun();
    fleet.destroyOutside((await agentRow(agentId)).machineId!);
    expect((await sweeper.sweep()).reconciled).toBe(1);
    expect((await agentRow(agentId)).state).toBe('failed');
    expect(await runRow(runId)).toMatchObject({ status: 'failed' });
    expect((await closingLines(runId))[0]).toContain(AGENT_RUN_END_DETAIL.machineLost);
    const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: runId } });
    expect(legs.every((l) => l.endedAt !== null)).toBe(true);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'in_progress',
    );
    await expectRevoked(runId, token);
    // The agent is free for runs again: no running run holds it.
    expect(
      await adminDb.dispatchRun.count({ where: { agentInstanceId: agentId, status: 'running' } }),
    ).toBe(0);
  });

  it('a machine that stopped behind Motir’s back takes its run with it', async () => {
    const { runId, agentId, token } = await startedRun();
    fleet.stopOutside((await agentRow(agentId)).machineId!);
    expect((await sweeper.sweep()).reconciled).toBe(1);
    expect((await agentRow(agentId)).state).toBe('hibernated');
    expect(await runRow(runId)).toMatchObject({ status: 'failed' });
    expect((await closingLines(runId))[0]).toContain(AGENT_RUN_END_DETAIL.agentStopped);
    await expectRevoked(runId, token);
  });

  it('a boot that fails under a run waiting for it closes the run failed', async () => {
    const agentId = await agent();
    await lifecycle.hibernate(KEY(), agentId, fx.ctx);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a card' },
      fx.ctx,
    );
    fleet.setBootBehaviour('never_start');
    const started = await runs.start(
      { workItemKey: item.identifier, agentInstanceId: agentId },
      fx.ctx,
    );
    expect((await agentRow(agentId)).state).toBe('waking');
    fleet.destroyOutside((await agentRow(agentId)).machineId!);
    expect(await driveBoot(agentId)).toBe('failed');
    expect(await runRow(started.dispatchRunId)).toMatchObject({ status: 'failed' });
    expect((await closingLines(started.dispatchRunId))[0]).toContain(
      'the agent stopped before the run could start',
    );
  });
});

describe('run activity keeps the agent awake (§6)', () => {
  it('an accepted event on a run in an agent bumps the agent, at most once a minute', async () => {
    const { runId, agentId } = await startedRun();
    clock.advance(10 * MIN);
    const before = (await agentRow(agentId)).lastActivityAt;
    await dispatchRunService.appendEvents(runId, [{ kind: 'log', body: 'working\n' }], fx.ctx);
    const bumped = (await agentRow(agentId)).lastActivityAt;
    expect(bumped.getTime()).toBe(clock.now().getTime());
    expect(bumped.getTime()).toBeGreaterThan(before.getTime());

    clock.advance(RUN_ACTIVITY_BUMP_MS / 2);
    await dispatchRunService.appendEvents(runId, [{ kind: 'log', body: 'still\n' }], fx.ctx);
    expect((await agentRow(agentId)).lastActivityAt).toEqual(bumped);

    clock.advance(RUN_ACTIVITY_BUMP_MS);
    await dispatchRunService.appendEvents(runId, [{ kind: 'log', body: 'again\n' }], fx.ctx);
    expect((await agentRow(agentId)).lastActivityAt.getTime()).toBe(clock.now().getTime());
  });

  it('an event on a local run touches no agent, and a bump that fails never refuses the events', async () => {
    const agentId = await agent();
    const before = (await agentRow(agentId)).lastActivityAt;
    const opened = await dispatchRunService.open(
      { projectKey: KEY(), command: 'run', reportedBy: 'cli', origin: 'local', cards: [] },
      fx.ctx,
    );
    const touch = vi.spyOn(agentInstanceActivityService, 'touchRunActivity');
    clock.advance(10 * MIN);
    await dispatchRunService.appendEvents(opened.run.id, [{ kind: 'log', body: 'x\n' }], fx.ctx);
    expect(touch).not.toHaveBeenCalled();
    expect((await agentRow(agentId)).lastActivityAt).toEqual(before);

    const { runId } = await startedRun('second');
    touch.mockRejectedValueOnce(new Error('the database blinked'));
    const appended = await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'log', body: 'y\n' }],
      fx.ctx,
    );
    expect(appended.appended).toBe(1);
  });

  it('a bump for an agent that no longer exists is a no-op', async () => {
    await expect(agentInstanceActivityService.touchRunActivity('no-such-agent')).resolves.toBe(
      undefined,
    );
  });
});

describe('the lapse reap, widened to runs in agents (§6)', () => {
  it('closes a run whose CLI stopped heartbeating through the end path, and races nothing twice', async () => {
    const { runId, token } = await startedRun();
    const lapsedAt = new Date(Date.now() - 6 * MIN);
    await adminDb.dispatchRun.update({ where: { id: runId }, data: { lastHeartbeatAt: lapsedAt } });
    const summary = await dispatchRunSweepService.reapLapsed();
    expect(summary.runsReaped).toBe(1);
    expect(await runRow(runId)).toMatchObject({ status: 'timed_out', stopReason: 'abandoned' });
    expect((await closingLines(runId))[0]).toContain(
      `no heartbeat since ${lapsedAt.toISOString()}`,
    );
    expect(stops(runId)).toHaveLength(1);
    await expectRevoked(runId, token);
  });

  it('counts a run somebody closed between the read and the end as raced', async () => {
    const { runId } = await startedRun();
    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { lastHeartbeatAt: new Date(Date.now() - 6 * MIN) },
    });
    const end = vi.spyOn(runs, 'end').mockResolvedValueOnce({
      closed: false,
      runCredential: 0,
      sessionStop: 'not_asked',
    });
    const summary = await dispatchRunSweepService.reapLapsed();
    expect(end).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ runsReaped: 0, runsRacedByClose: 1 });
  });
});
