import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { clock, fleet, fx, intervals, MIN, setUpHarness, tearDownHarness } from './_harness';

// A PLATFORM ADMIN'S STOP of one organisation's agents (Story MOTIR-6905 ·
// MOTIR-7323) — against a real Postgres and the fake persistent fleet. The run in
// an agent half (a running card closed `cancelled` first) is pinned beside the
// other forced stops in `agentInstanceRunLifecycle.test.ts`.

beforeEach(setUpHarness);
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const row = async (id: string) => (await adminDb.agentInstance.findUnique({ where: { id } }))!;

async function running(fixture: WorkItemFixture, name: string): Promise<string> {
  const dto = await lifecycle.create(
    fixture.projectIdentifier,
    { name, profileId: 'claude' },
    fixture.ctx,
  );
  expect(dto.state).toBe('running');
  return dto.id;
}

describe('hibernateAllForOrganization', () => {
  it('hibernates every running instance of the org with admin_stop, and a second call stops nothing', async () => {
    const a = await running(fx, 'yue-a');
    const b = await running(fx, 'yue-b');
    clock.advance(10 * MIN);

    const first = await lifecycle.hibernateAllForOrganization(
      fx.workspace.organizationId,
      'admin_stop',
    );
    expect(first).toEqual({
      hibernated: 2,
      alreadyResting: 0,
      inMotion: 0,
      failures: [],
      hibernatedInstanceIds: [a, b],
    });
    expect((await row(a)).state).toBe('hibernated');
    expect((await row(b)).state).toBe('hibernated');
    expect((await intervals()).map((i) => i.endReason)).toEqual(['admin_stop', 'admin_stop']);

    const second = await lifecycle.hibernateAllForOrganization(
      fx.workspace.organizationId,
      'admin_stop',
    );
    expect(second).toEqual({
      hibernated: 0,
      alreadyResting: 2,
      inMotion: 0,
      failures: [],
      hibernatedInstanceIds: [],
    });
  });

  it('counts an instance already hibernated as resting and moves nothing of it', async () => {
    const a = await running(fx, 'yue-a');
    await lifecycle.hibernate(fx.projectIdentifier, a, fx.ctx);
    const b = await running(fx, 'yue-b');

    const result = await lifecycle.hibernateAllForOrganization(
      fx.workspace.organizationId,
      'admin_stop',
    );
    expect(result).toEqual({
      hibernated: 1,
      alreadyResting: 1,
      inMotion: 0,
      failures: [],
      hibernatedInstanceIds: [b],
    });
    const reasons = Object.fromEntries(
      (await intervals()).map((i) => [i.agentInstanceId, i.endReason]),
    );
    expect(reasons).toEqual({ [a]: 'hibernated', [b]: 'admin_stop' });
  });

  it('never touches another organisation’s running instance', async () => {
    const mine = await running(fx, 'yue-a');
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const theirs = await running(elsewhere, 'theirs');

    const result = await lifecycle.hibernateAllForOrganization(
      fx.workspace.organizationId,
      'admin_stop',
    );
    expect(result.hibernated).toBe(1);
    expect((await row(mine)).state).toBe('hibernated');
    expect((await row(theirs)).state).toBe('running');
    const open = await adminDb.agentInstanceInterval.findMany({
      where: { agentInstanceId: theirs },
    });
    expect(open.map((i) => i.endedAt)).toEqual([null]);
  });

  it('a provider stop that throws is a counted failure, never a throw, and the next instance is still stopped', async () => {
    const a = await running(fx, 'yue-a');
    const b = await running(fx, 'yue-b');
    fleet.failNextStop();

    const result = await lifecycle.hibernateAllForOrganization(
      fx.workspace.organizationId,
      'admin_stop',
    );
    expect(result.hibernated).toBe(1);
    expect(result.failures).toEqual([
      { instanceId: a, detail: expect.stringContaining('hibernating') },
    ]);
    expect((await row(a)).state).toBe('hibernating');
    expect((await row(b)).state).toBe('hibernated');
  });
});
