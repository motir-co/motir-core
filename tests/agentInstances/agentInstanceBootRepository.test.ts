import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import {
  agentInstanceBootRepository,
  type AgentInstanceBootStepCreateInput,
} from '@/lib/repositories/agentInstanceBootRepository';
import { toAgentInstanceBootDto } from '@/lib/mappers/agentInstanceMappers';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The boot record (Story MOTIR-7393 · MOTIR-7397, `agent-instances.md`
// AMENDMENT 6), against a real Postgres: the attempt numbered per agent, the
// LEASE's compare-and-set and its race, the per-agent `seq` the stream resumes
// from, the cascade from the agent, and the boot read's DTO.
//
// Fixtures go through `adminDb` (the owner); every subject call runs inside a
// workspace-bound transaction, as the services will — both tables are RLS-gated
// on `app.workspace_id`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let n = 0;

interface Fixture {
  organizationId: string;
  workspaceId: string;
  instanceId: string;
}

async function seed(): Promise<Fixture> {
  const tag = `${n++}-${randomUUID().slice(0, 6)}`;
  const owner = await adminDb.user.create({
    data: { name: 'Yue', email: `yue-${tag}@example.com` },
  });
  const org = await adminDb.organization.create({
    data: { name: `moooon ${tag}`, slug: `moooon-${tag}` },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `moooon ${tag}`, slug: `ws-${tag}`, organizationId: org.id },
  });
  const project = await adminDb.project.create({
    data: {
      name: `Motir ${tag}`,
      slug: `motir-${tag}`,
      identifier: `B${n}`,
      workspaceId: workspace.id,
    },
  });
  const instance = await withWorkspaceServiceContext(workspace.id, (tx) =>
    agentInstanceRepository.create(
      {
        workspaceId: workspace.id,
        organizationId: org.id,
        projectId: project.id,
        ownerId: owner.id,
        name: 'boot-check',
        profileId: 'claude',
        imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
        imageDigest: 'sha256:' + 'a'.repeat(64),
        region: 'iad',
      },
      tx,
    ),
  );
  return { organizationId: org.id, workspaceId: workspace.id, instanceId: instance.id };
}

const T0 = new Date('2026-10-02T12:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

function inWs<T>(f: Fixture, fn: Parameters<typeof withWorkspaceServiceContext<T>>[1]) {
  return withWorkspaceServiceContext(f.workspaceId, fn);
}

function openAttempt(f: Fixture, attempt = 1, kind: 'create' | 'wake' = 'create') {
  return inWs(f, (tx) =>
    agentInstanceBootRepository.createAttempt(
      {
        workspaceId: f.workspaceId,
        organizationId: f.organizationId,
        agentInstanceId: f.instanceId,
        attempt,
        kind,
        startedAt: T0,
      },
      tx,
    ),
  );
}

function plannedRows(
  f: Fixture,
  attemptId: string,
  seqFrom: number,
): AgentInstanceBootStepCreateInput[] {
  const rows: Array<Pick<AgentInstanceBootStepCreateInput, 'step' | 'repository'>> = [
    { step: 'provision', repository: null },
    { step: 'machine_start', repository: null },
    { step: 'clone', repository: 'owner/repo-a' },
    { step: 'clone', repository: 'owner/repo-b' },
    { step: 'terminal_check', repository: null },
    { step: 'ready', repository: null },
  ];
  return rows.map((r, i) => ({
    ...r,
    workspaceId: f.workspaceId,
    bootAttemptId: attemptId,
    seq: seqFrom + i,
    ordinal: i,
    state: 'waiting',
  }));
}

describe('the boot attempt', () => {
  it('is numbered per agent, and the current one is the highest', async () => {
    const f = await seed();
    await openAttempt(f, 1);
    await openAttempt(f, 2, 'wake');
    const current = await inWs(f, (tx) =>
      agentInstanceBootRepository.findCurrentAttempt(f.instanceId, tx),
    );
    expect(current?.attempt).toBe(2);
    expect(current?.kind).toBe('wake');
    const first = await inWs(f, (tx) =>
      agentInstanceBootRepository.findAttempt(f.instanceId, 1, tx),
    );
    expect(first?.kind).toBe('create');
  });

  it('refuses a second attempt with the same number', async () => {
    const f = await seed();
    await openAttempt(f, 1);
    await expect(openAttempt(f, 1)).rejects.toThrow();
  });

  it('closes once, with its outcome, and clears the lease', async () => {
    const f = await seed();
    const a = await openAttempt(f);
    await inWs(f, (tx) => agentInstanceBootRepository.takeLease(a.id, 'run-1', at(60), T0, tx));
    const first = await inWs(f, (tx) =>
      agentInstanceBootRepository.closeAttempt(a.id, { endedAt: at(5), outcome: 'running' }, tx),
    );
    const second = await inWs(f, (tx) =>
      agentInstanceBootRepository.closeAttempt(a.id, { endedAt: at(6), outcome: 'failed' }, tx),
    );
    expect([first, second]).toEqual([1, 0]);
    const row = await adminDb.agentInstanceBootAttempt.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ outcome: 'running', leaseHolder: null, leaseExpiresAt: null });
    expect(row.endedAt?.toISOString()).toBe(at(5).toISOString());
  });
});

describe('the lease (AMENDMENT 6 §4)', () => {
  it('is granted when free, re-granted to its holder, and refused to another while live', async () => {
    const f = await seed();
    const a = await openAttempt(f);
    const take = (holder: string, now: Date) =>
      inWs(f, (tx) =>
        agentInstanceBootRepository.takeLease(
          a.id,
          holder,
          new Date(now.getTime() + 60_000),
          now,
          tx,
        ),
      );
    expect(await take('run-1', T0)).toBe(1);
    expect(await take('run-1', at(10))).toBe(1);
    expect(await take('run-2', at(20))).toBe(0);
    const row = await adminDb.agentInstanceBootAttempt.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.leaseHolder).toBe('run-1');
  });

  it('is granted to another holder once it has expired', async () => {
    const f = await seed();
    const a = await openAttempt(f);
    await inWs(f, (tx) => agentInstanceBootRepository.takeLease(a.id, 'run-1', at(60), T0, tx));
    const taken = await inWs(f, (tx) =>
      agentInstanceBootRepository.takeLease(a.id, 'run-2', at(200), at(61), tx),
    );
    expect(taken).toBe(1);
    const renewedByLoser = await inWs(f, (tx) =>
      agentInstanceBootRepository.renewLease(a.id, 'run-1', at(300), tx),
    );
    expect(renewedByLoser).toBe(0);
    const renewed = await inWs(f, (tx) =>
      agentInstanceBootRepository.renewLease(a.id, 'run-2', at(300), tx),
    );
    expect(renewed).toBe(1);
  });

  it('is never granted on a closed attempt', async () => {
    const f = await seed();
    const a = await openAttempt(f);
    await inWs(f, (tx) =>
      agentInstanceBootRepository.closeAttempt(a.id, { endedAt: at(1), outcome: 'deleted' }, tx),
    );
    expect(
      await inWs(f, (tx) =>
        agentInstanceBootRepository.takeLease(a.id, 'run-1', at(60), at(2), tx),
      ),
    ).toBe(0);
  });

  it('has exactly one winner when two holders race for it', async () => {
    const f = await seed();
    const a = await openAttempt(f);
    for (let round = 0; round < 5; round += 1) {
      await adminDb.agentInstanceBootAttempt.update({
        where: { id: a.id },
        data: { leaseHolder: null, leaseExpiresAt: null },
      });
      const results = await Promise.all(
        ['driver', 'resent-driver'].map((holder) =>
          inWs(f, (tx) =>
            agentInstanceBootRepository.takeLease(a.id, `${holder}-${round}`, at(60), T0, tx),
          ),
        ),
      );
      expect(results.sort()).toEqual([0, 1]);
    }
  });
});

describe('the steps and their seq', () => {
  it('restamps seq on every write, monotonic per agent across attempts', async () => {
    const f = await seed();
    const a1 = await openAttempt(f, 1);
    await inWs(f, (tx) => agentInstanceBootRepository.createSteps(plannedRows(f, a1.id, 1), tx));
    expect(await inWs(f, (tx) => agentInstanceBootRepository.maxSeq(f.instanceId, tx))).toBe(6);

    const steps = await inWs(f, (tx) => agentInstanceBootRepository.listSteps(a1.id, tx));
    const write = (id: string, state: 'in_progress' | 'done') =>
      inWs(f, async (tx) => {
        const seq = (await agentInstanceBootRepository.maxSeq(f.instanceId, tx)) + 1;
        return agentInstanceBootRepository.updateStep(id, { seq, state, startedAt: T0 }, tx);
      });
    const provisioned = await write(steps[0]!.id, 'done');
    const starting = await write(steps[1]!.id, 'in_progress');
    expect([provisioned.seq, starting.seq]).toEqual([7, 8]);

    const since = await inWs(f, (tx) => agentInstanceBootRepository.listStepsSince(a1.id, 6, tx));
    expect(since.map((s) => [s.step, s.seq])).toEqual([
      ['provision', 7],
      ['machine_start', 8],
    ]);
    expect(await inWs(f, (tx) => agentInstanceBootRepository.listStepsSince(a1.id, 8, tx))).toEqual(
      [],
    );

    const a2 = await openAttempt(f, 2, 'wake');
    const seqFrom =
      (await inWs(f, (tx) => agentInstanceBootRepository.maxSeq(f.instanceId, tx))) + 1;
    await inWs(f, (tx) =>
      agentInstanceBootRepository.createSteps(plannedRows(f, a2.id, seqFrom), tx),
    );
    const next = await inWs(f, (tx) => agentInstanceBootRepository.listStepsSince(a2.id, 8, tx));
    expect(next.map((s) => s.seq)).toEqual([9, 10, 11, 12, 13, 14]);
  });

  it('refuses two rows at one ordinal of an attempt', async () => {
    const f = await seed();
    const a = await openAttempt(f);
    const [row] = plannedRows(f, a.id, 1);
    await inWs(f, (tx) => agentInstanceBootRepository.createSteps([row!], tx));
    await expect(
      inWs(f, (tx) => agentInstanceBootRepository.createSteps([{ ...row!, seq: 2 }], tx)),
    ).rejects.toThrow();
  });

  it('cascades both tables away with the agent', async () => {
    const f = await seed();
    const a = await openAttempt(f);
    await inWs(f, (tx) => agentInstanceBootRepository.createSteps(plannedRows(f, a.id, 1), tx));
    await adminDb.agentInstance.delete({ where: { id: f.instanceId } });
    expect(await adminDb.agentInstanceBootAttempt.count()).toBe(0);
    expect(await adminDb.agentInstanceBootStep.count()).toBe(0);
  });

  it('is invisible outside its workspace, and readable by the system read arm', async () => {
    const f = await seed();
    const other = await seed();
    const a = await openAttempt(f);
    await inWs(f, (tx) => agentInstanceBootRepository.createSteps(plannedRows(f, a.id, 1), tx));
    expect(
      await withWorkspaceServiceContext(other.workspaceId, (tx) =>
        agentInstanceBootRepository.findCurrentAttempt(f.instanceId, tx),
      ),
    ).toBeNull();
    const system = await withSystemContext((tx) =>
      agentInstanceBootRepository.findCurrentAttempt(f.instanceId, tx),
    );
    expect(system?.id).toBe(a.id);
  });
});

describe('toAgentInstanceBootDto', () => {
  it('returns steps in ordinal order, with ISO times and null for unset ones', async () => {
    const f = await seed();
    const a = await openAttempt(f);
    const rows = plannedRows(f, a.id, 1);
    // Written out of order, and one step with times.
    rows[0] = { ...rows[0]!, state: 'done', startedAt: T0, endedAt: at(3), detail: null };
    await inWs(f, (tx) => agentInstanceBootRepository.createSteps([...rows].reverse(), tx));
    const steps = await adminDb.agentInstanceBootStep.findMany({ orderBy: { seq: 'desc' } });
    const dto = toAgentInstanceBootDto(a, steps);
    expect(dto).toMatchObject({
      attempt: 1,
      kind: 'create',
      startedAt: T0.toISOString(),
      endedAt: null,
      outcome: null,
    });
    expect(dto.steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(dto.steps[0]).toEqual({
      seq: 1,
      step: 'provision',
      repository: null,
      ordinal: 0,
      state: 'done',
      startedAt: T0.toISOString(),
      endedAt: at(3).toISOString(),
      detail: null,
      waiting: null,
      waited: null,
    });
    expect(dto.steps[2]).toMatchObject({
      repository: 'owner/repo-a',
      startedAt: null,
      endedAt: null,
    });
    expect(JSON.stringify(dto)).not.toContain('lease');
  });
});
