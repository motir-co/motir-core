import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import {
  DispatchRunAgentBusyError,
  DispatchRunAgentInstanceMismatchError,
} from '@/lib/dispatchRuns/errors';
import { toDispatchRunAgentInstanceDto, toDispatchRunDto } from '@/lib/mappers/dispatchRunMappers';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { isRunAlive, RUN_HEARTBEAT_LAPSE_MS } from '@/lib/runs/runLiveness';
import { dispatchRunService, namedAgentBusy } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE RUN RECORD KNOWS ITS AGENT (Story MOTIR-6864 · MOTIR-7023,
// `docs/decisions/agent-instance-run.md` §5), against a real Postgres.
//
// `origin: instance` + `agentInstanceId` on the run, at most one RUNNING run per
// agent enforced by the DATABASE (a partial unique index), the active-run read by
// agent, and the DTO carrying the agent's name and coding agent. The race is
// driven for real: a serial test passes without the index and proves nothing.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedAgent(name: string, profileId = 'claude'): Promise<string> {
  const row = await adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId!,
      projectId: fx.projectId,
      ownerId: fx.ownerId,
      name,
      profileId,
      imageTag: 't',
      imageDigest: 'sha256:x',
      region: 'iad',
      state: 'running',
    },
  });
  return row.id;
}

async function seedCard(title = 'A card run in an agent'): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.identifier;
}

async function openIn(agentInstanceId: string, key?: string) {
  return dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      origin: 'instance',
      agentInstanceId,
      agent: 'claude',
      cards: [{ key: key ?? (await seedCard()), disposition: 'queued' }],
    },
    fx.ctx,
  );
}

function bound<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withWorkspaceContext({ userId: fx.ownerId, workspaceId: fx.workspaceId }, fn);
}

describe('the record holds a run in an agent', () => {
  it('an `instance` run carries its agent — name, profile and the profile’s label', async () => {
    const agentId = await seedAgent('yue-claude');
    const { run, created } = await openIn(agentId);

    expect(created).toBe(true);
    expect(run.origin).toBe('instance');
    expect(run.agent).toBe('claude');
    expect(run.model).toBeNull();
    expect(run.agentInstance).toEqual({
      id: agentId,
      name: 'yue-claude',
      profile: 'claude',
      profileLabel: 'Claude Code',
    });

    // Every read that carries the legs carries the agent too.
    expect((await dispatchRunService.getRun(run.id, fx.ctx)).agentInstance?.name).toBe(
      'yue-claude',
    );
    const detail = await dispatchRunService.getRunDetail(run.id, fx.ctx);
    expect(detail.agentInstance?.profileLabel).toBe('Claude Code');
    // A run in an agent has no token cost to read (§5): the hosted cost is never
    // asked for, so no `cost` key rides on the detail.
    expect(detail).not.toHaveProperty('cost');
    // …but its END is read like a hosted run's (MOTIR-7028): nothing yet while live.
    expect(detail.hostedEnd).toEqual({ outcome: null, detail: null, exitCode: null });
  });

  it('an ended `instance` run’s detail quotes the end path’s recorded reason (MOTIR-7028)', async () => {
    const agentId = await seedAgent('yue-claude');
    const { run } = await openIn(agentId);
    // The agent end path's own closing line (`agentInstanceRunService.end`).
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'log',
          body: '[motir] run in agent ended (stalled): stalled: no agent output for 15 minutes\n',
          data: { end: 'stall', message: 'stalled: no agent output for 15 minutes' },
        },
      ],
      fx.ctx,
    );
    await dispatchRunService.close(
      run.id,
      { stopReason: 'abandoned', status: 'timed_out' },
      fx.ctx,
    );
    const detail = await dispatchRunService.getRunDetail(run.id, fx.ctx);
    expect(detail.hostedEnd).toEqual({
      outcome: 'stall',
      detail: 'stalled: no agent output for 15 minutes',
      exitCode: null,
    });
  });

  it('`local` and `hosted` runs read back unchanged, with `agentInstance: null`', async () => {
    const local = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: await seedCard(), disposition: 'queued' }],
      },
      fx.ctx,
    );
    const hosted = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin: 'hosted',
        cards: [{ key: await seedCard(), disposition: 'queued' }],
      },
      fx.ctx,
    );
    expect(local.run).toMatchObject({ origin: 'local', agentInstance: null });
    expect(hosted.run).toMatchObject({ origin: 'hosted', agentInstance: null });
    expect((await dispatchRunService.getRun(local.run.id, fx.ctx)).agentInstance).toBeNull();
  });

  it('an agent row removed under a run leaves the run, with a null agent (`SET NULL`)', async () => {
    const agentId = await seedAgent('gone');
    const { run } = await openIn(agentId);
    await dispatchRunService.close(run.id, { stopReason: 'completed' }, fx.ctx);
    await adminDb.agentInstance.delete({ where: { id: agentId } });

    const after = await dispatchRunService.getRun(run.id, fx.ctx);
    expect(after.origin).toBe('instance');
    expect(after.agentInstance).toBeNull();
  });
});

describe('an `instance` open names its agent, and only it does', () => {
  it('refuses an `instance` open with no agent, and a `local` open naming one', async () => {
    const agentId = await seedAgent('yue-claude');
    const key = await seedCard();
    await expect(
      dispatchRunService.open(
        {
          projectKey: fx.projectIdentifier,
          command: 'run',
          reportedBy: 'cli',
          origin: 'instance',
          cards: [{ key, disposition: 'queued' }],
        },
        fx.ctx,
      ),
    ).rejects.toThrow(DispatchRunAgentInstanceMismatchError);
    await expect(
      dispatchRunService.open(
        {
          projectKey: fx.projectIdentifier,
          command: 'run',
          reportedBy: 'cli',
          agentInstanceId: agentId,
          cards: [{ key, disposition: 'queued' }],
        },
        fx.ctx,
      ),
    ).rejects.toThrow(/A local run cannot name an agent/);
    expect(await adminDb.dispatchRun.count()).toBe(0);
  });

  it('the database CHECK refuses an agent on a run that is not `instance`', async () => {
    const agentId = await seedAgent('yue-claude');
    await expect(
      adminDb.dispatchRun.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          command: 'run',
          origin: 'local',
          agentInstanceId: agentId,
        },
      }),
    ).rejects.toThrow(/dispatch_run_agent_instance_origin_check/);
  });
});

describe('at most one RUNNING run per agent — enforced by the database', () => {
  it('a second open on a busy agent is refused, naming the running run', async () => {
    const agentId = await seedAgent('yue-claude');
    const first = await openIn(agentId);

    const refusal = await openIn(agentId).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(DispatchRunAgentBusyError);
    expect(refusal).toMatchObject({
      code: 'agent_instance_run_active',
      agentInstanceId: agentId,
      runId: first.run.id,
    });
    expect(await adminDb.dispatchRun.count()).toBe(1);
  });

  it('two CONCURRENT opens on one agent: exactly one wins, the other names the winner', async () => {
    const agentId = await seedAgent('yue-claude');
    const [a, b] = [await seedCard('A'), await seedCard('B')];

    const results = await Promise.allSettled([openIn(agentId, a), openIn(agentId, b)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    // Either caller may win — both outcomes are legitimate; exactly one is not optional.
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof openIn>>>).value;
    const reason = (lost[0] as PromiseRejectedResult).reason as unknown;
    expect(reason).toBeInstanceOf(DispatchRunAgentBusyError);
    expect(reason).toMatchObject({ runId: winner.run.id });
    expect(await adminDb.dispatchRun.count({ where: { status: 'running' } })).toBe(1);

    // After the winner closes, the agent takes a new run.
    await dispatchRunService.close(winner.run.id, { stopReason: 'completed' }, fx.ctx);
    const again = await openIn(agentId);
    expect(again.created).toBe(true);
  });

  it('the INDEX is the arbiter: an insert racing past the read is translated, then named', async () => {
    // Drive the race deterministically. Transaction A opens a run and HOLDS its
    // commit; B's read cannot see A's uncommitted row, so B reaches the insert,
    // which PostgreSQL makes WAIT on A's index entry. A commits; B's insert fails
    // on the partial unique index — the `P2002` path, not the read's.
    const agentId = await seedAgent('yue-claude');
    const [a, b] = [await seedCard('A'), await seedCard('B')];

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let aOpened!: (id: string) => void;
    const aId = new Promise<string>((resolve) => (aOpened = resolve));

    const txA = bound(async (tx) => {
      const opened = await dispatchRunService.openWithin(
        fx.projectId,
        {
          command: 'run',
          reportedBy: 'cli',
          origin: 'instance',
          agentInstanceId: agentId,
          cards: [{ key: a, disposition: 'queued' }],
        },
        fx.ctx,
        tx,
      );
      aOpened(opened.run.id);
      await held;
      return opened.run.id;
    });
    const winnerId = await aId;

    const openB = openIn(agentId, b).catch((err: unknown) => err);
    // B is waiting on A's index entry — an authoritative signal, not a sleep.
    await expect
      .poll(
        async () =>
          (
            await adminDb.$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND query ILIKE '%dispatch_run%'`
          )[0]!.n,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    release();
    expect(await txA).toBe(winnerId);

    const refusal = await openB;
    expect(refusal).toBeInstanceOf(DispatchRunAgentBusyError);
    // Named from a fresh transaction — the violation had aborted B's own.
    expect(refusal).toMatchObject({ runId: winnerId });
    expect(await adminDb.dispatchRun.count()).toBe(1);
  });

  it('two running runs in two DIFFERENT agents coexist', async () => {
    const one = await openIn(await seedAgent('yue-claude'));
    const two = await openIn(await seedAgent('yue-codex', 'codex'));
    expect(one.run.status).toBe('running');
    expect(two.run.status).toBe('running');
    expect(two.run.agentInstance?.profileLabel).toBe('Codex');
  });

  it('`namedAgentBusy` passes every other error, and a named refusal, through unchanged', async () => {
    const other = new Error('boom');
    const bind = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    expect(await namedAgentBusy(other, bind)).toBe(other);
    const named = new DispatchRunAgentBusyError('agent', 'run-1');
    expect(await namedAgentBusy(named, bind)).toBe(named);
    // A lost race whose winner has already closed keeps its unnamed refusal.
    const unnamed = new DispatchRunAgentBusyError(await seedAgent('idle'), null);
    expect(await namedAgentBusy(unnamed, bind)).toBe(unnamed);
    expect(unnamed.message).toMatch(/already running a run/);
  });
});

describe('the active-run read by agent', () => {
  it('answers one agent, and null for an idle one', async () => {
    const busy = await seedAgent('busy');
    const idle = await seedAgent('idle');
    const { run } = await openIn(busy);

    const found = await bound((tx) => dispatchRunRepository.findRunningByAgentInstance(busy, tx));
    expect(found).toMatchObject({ id: run.id, agentInstanceId: busy, command: 'run' });
    expect(
      await bound((tx) => dispatchRunRepository.findRunningByAgentInstance(idle, tx)),
    ).toBeNull();
  });

  it('answers a LIST of agents in ONE query, and only their RUNNING runs', async () => {
    const [a, b, c] = [await seedAgent('a'), await seedAgent('b'), await seedAgent('c')];
    const runA = await openIn(a);
    const runB = await openIn(b);
    const runC = await openIn(c);
    await dispatchRunService.close(runC.run.id, { stopReason: 'completed' }, fx.ctx);

    // Count every model operation and raw statement the read issues through the
    // transaction it is handed — each is one round trip; a per-agent read would
    // show up as three.
    let calls = 0;
    const counting = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof prop === 'string' && prop.startsWith('$') && typeof value === 'function') {
            return (...args: unknown[]) => {
              calls += 1;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          if (typeof value !== 'object' || value === null) return value;
          return new Proxy(value, {
            get(model, op, r) {
              const fn = Reflect.get(model, op, r) as unknown;
              if (typeof fn !== 'function') return fn;
              return (...args: unknown[]) => {
                calls += 1;
                return (fn as (...a: unknown[]) => unknown).apply(model, args);
              };
            },
          });
        },
      });

    const rows = await bound((tx) =>
      dispatchRunRepository.findRunningByAgentInstances([a, b, c], counting(tx)),
    );
    expect(calls).toBe(1);
    expect(rows.map((r) => r.id).sort()).toEqual([runA.run.id, runB.run.id].sort());
    expect(rows.every((r) => [a, b].includes(r.agentInstanceId))).toBe(true);

    expect(await bound((tx) => dispatchRunRepository.findRunningByAgentInstances([], tx))).toEqual(
      [],
    );
  });
});

describe('the DTO, the liveness rule and the refusal’s status', () => {
  it('maps a missing or unknown-profile agent', () => {
    expect(toDispatchRunAgentInstanceDto(null)).toBeNull();
    expect(toDispatchRunAgentInstanceDto(undefined)).toBeNull();
    expect(toDispatchRunAgentInstanceDto({ id: 'i', name: 'n', profileId: 'mystery' })).toEqual({
      id: 'i',
      name: 'n',
      profile: 'mystery',
      profileLabel: 'mystery',
    });
  });

  it('a row read without the agent include maps to `agentInstance: null`', () => {
    const now = new Date();
    const dto = toDispatchRunDto(
      {
        id: 'r',
        workspaceId: 'w',
        projectId: 'p',
        command: 'run',
        origin: 'local',
        scopeWorkItemId: null,
        scopeLabel: null,
        status: 'running',
        stopReason: null,
        agent: null,
        model: null,
        startedAt: now,
        endedAt: null,
        lastHeartbeatAt: null,
        reportedBy: 'cli',
        createdById: null,
        idempotencyKey: null,
        agentInstanceId: null,
        fleetShardId: null,
        createdAt: now,
        updatedAt: now,
        cards: [],
      },
      0,
    );
    expect(dto.agentInstance).toBeNull();
    // Q3.3 — the run DTO still names no cost, token or credit.
    expect(Object.keys(dto).filter((k) => /cost|token|credit/i.test(k))).toEqual([]);
  });

  it('an `instance` run lapses by the heartbeat rule, as a local run does (§6)', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    const base = {
      status: 'running',
      origin: 'instance' as const,
      startedAt: new Date(now.getTime() - 60 * 60 * 1000),
    };
    expect(isRunAlive({ ...base, lastHeartbeatAt: new Date(now.getTime() - 60_000) }, now)).toBe(
      true,
    );
    expect(
      isRunAlive(
        { ...base, lastHeartbeatAt: new Date(now.getTime() - RUN_HEARTBEAT_LAPSE_MS - 1) },
        now,
      ),
    ).toBe(false);
  });

  it('the agent routes answer the refusal 409, naming the run', async () => {
    const res = mapAgentInstanceError(new DispatchRunAgentBusyError('agent', 'run-1'));
    expect(res).toBeInstanceOf(NextResponse);
    expect(res!.status).toBe(409);
    expect(await res!.json()).toMatchObject({ code: 'agent_instance_run_active', runId: 'run-1' });
  });
});
