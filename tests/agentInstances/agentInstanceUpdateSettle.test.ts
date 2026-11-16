import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { AGENT_UPDATE_POLL_MS, UPDATE_SWEEP_AFTER_MS } from '@/lib/agentInstances/config';
import {
  FAKE_BASE_VERSION,
  fakeDigestFor,
  imageCatalogSeam,
} from '@/lib/agentInstances/imageCatalog';
import { pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import { sandboxImageTag } from '@/lib/agentInstances/profiles';
import { isJobRunDefer, type JobRunDefer } from '@/lib/jobs/engine/defer';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { agentInstanceUpdateSettle } from '@/lib/jobs/definitions/agentInstanceUpdateSettle';
import type { AgentInstanceUpdateSettleData } from '@/lib/jobs/types';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import {
  agentInstanceLifecycleService as lifecycle,
  agentUpdateEventKey,
  UPDATE_START_DEADLINE_MS,
} from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { adminDb } from '../helpers/adminDb';
import { updateDriver } from '../helpers/agentBootDriver';
import { MIN, clock, fleet, fx, setUpHarness, tearDownHarness } from './_harness';

// THE UPDATE DRIVER (MOTIR-8954; `docs/decisions/agent-image-update.md` Q6) — an
// Update, and a wake that applies a pinned update, answers at `updating` and the
// `agent-instance/update-settle` job settles it the moment the machine allows.
//
// The defect this file was written against: the request waited 20 s inline, and
// the sweep skipped an update younger than ten minutes, so a machine that took
// 29 s to pull and start (production, 2026-10-18) sat `updating` for ten minutes
// with nothing left to wait for. Every test below drives a machine that starts
// 30 s after the move — `never_start`, then `completeBoot` at +30 s — and runs
// the job's own handler the way the engine runs it, with no sweep anywhere.

const NEW = '1.1.0';
const NEW_DIGEST = fakeDigestFor('claude', NEW);
const BASE_DIGEST = fakeDigestFor('claude', FAKE_BASE_VERSION);
const ref = (digest: string) => pinnedImageReference(sandboxImageTag('claude'), digest);

beforeEach(async () => {
  await setUpHarness();
  imageCatalogSeam.reset();
});
afterEach(async () => {
  imageCatalogSeam.reset();
  await tearDownHarness();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const row = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });

async function agent() {
  const dto = await lifecycle.create(
    fx.projectIdentifier,
    { name: 'yue-claude', profileId: 'claude' },
    fx.ctx,
  );
  return row(dto.id);
}

/** One delivery of the job, as the engine runs it: its answer, or the defer it threw. */
async function runPass(data: AgentInstanceUpdateSettleData): Promise<unknown> {
  const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
  try {
    return await engineJob('agent-instance/update-settle')!.handler(
      { step, runId: 'job-run-1', attempt: 1, event: { data } } as never,
      jobServices as never,
    );
  } catch (err) {
    return err;
  }
}

/** An Update on a running agent whose new image starts only when the test says so. */
async function slowUpdate() {
  const a = await agent();
  imageCatalogSeam.setFakeNewest('claude', NEW);
  fleet.setBootBehaviour('never_start');
  updateDriver.inline = false;
  return a;
}

describe('the agent-instance/update-settle job', () => {
  it('is registered, keyed once per update, and safe to retry', () => {
    expect(agentInstanceUpdateSettle.id).toBe('agent-instance/update-settle');
    expect(jobDefinitions).toContain(agentInstanceUpdateSettle);
    const def = engineJob('agent-instance/update-settle')!;
    expect(def.trigger).toBe('agent-instance/update-settle');
    expect(def.retryPolicy).toBe('idempotent');
    expect(def.idempotency).toBe('event.data.idempotencyKey');
    const at = new Date('2026-10-18T22:55:04.000Z');
    expect(agentUpdateEventKey('agent-1', at)).toBe(
      'agent-instance-update:agent-1:2026-10-18T22:55:04.000Z',
    );
  });
});

describe('an update whose machine starts 30 s after the move (AC1)', () => {
  it('a RUNNING agent: Update answers at once, and the driver settles it running on the target', async () => {
    const a = await slowUpdate();
    const pressedAt = clock.now().getTime();

    const dto = await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);

    // The request no longer waits: it answers `updating` with no time passed.
    expect(dto.state).toBe('updating');
    expect(clock.now().getTime()).toBe(pressedAt);
    const updating = await row(a.id);
    expect(updateDriver.sent).toEqual([
      {
        workspaceId: a.workspaceId,
        instanceId: a.id,
        idempotencyKey: agentUpdateEventKey(a.id, updating.stateChangedAt),
      },
    ]);
    const data = updateDriver.sent[0]!;

    // While the new image starts, each pass defers one poll.
    clock.advance(20_000);
    const deferred = await runPass(data);
    expect(isJobRunDefer(deferred)).toBe(true);
    expect((deferred as JobRunDefer).resumeAt).toEqual(
      new Date(clock.now().getTime() + AGENT_UPDATE_POLL_MS),
    );
    expect((await row(a.id)).state).toBe('updating');

    // +30 s: the machine is started, and the very next pass settles it.
    clock.advance(10_000);
    fleet.completeBoot(a.machineId!);
    expect(await runPass(data)).toBe('running');
    expect(await row(a.id)).toMatchObject({
      state: 'running',
      imageDigest: NEW_DIGEST,
      imageVersion: NEW,
      targetImageDigest: null,
      updateFailureReason: null,
      volumeId: a.volumeId,
    });
    expect(clock.now().getTime() - pressedAt).toBe(30_000);
    expect(fleet.machineImage(a.machineId!)).toBe(ref(NEW_DIGEST));
  });

  it('a HIBERNATED agent: the wake that applies the pinned update answers at once and is settled the same way', async () => {
    const a = await agent();
    await lifecycle.hibernate(fx.projectIdentifier, a.id, fx.ctx);
    imageCatalogSeam.setFakeNewest('claude', NEW);
    const pinned = await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);
    expect(pinned).toMatchObject({ state: 'hibernated', pendingImageVersion: NEW });
    // Pinning a hibernated agent moves no machine, so it hands nothing to the driver.
    expect(updateDriver.sent).toEqual([]);

    fleet.setBootBehaviour('never_start');
    updateDriver.inline = false;
    const pressedAt = clock.now().getTime();
    const woken = await lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx);
    expect(woken.state).toBe('updating');
    expect(clock.now().getTime()).toBe(pressedAt);
    expect(updateDriver.sent).toHaveLength(1);
    const data = updateDriver.sent[0]!;
    expect(data.idempotencyKey).toBe(agentUpdateEventKey(a.id, (await row(a.id)).stateChangedAt));

    clock.advance(20_000);
    expect(isJobRunDefer(await runPass(data))).toBe(true);
    clock.advance(10_000);
    fleet.completeBoot(a.machineId!);
    expect(await runPass(data)).toBe('running');
    expect(await row(a.id)).toMatchObject({
      state: 'running',
      imageDigest: NEW_DIGEST,
      imageVersion: NEW,
      targetImageDigest: null,
      volumeId: a.volumeId,
    });
  });

  it('two updates of one agent get two drivers, never one swallowed as the other', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    updateDriver.inline = true;
    await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);
    clock.advance(MIN);
    imageCatalogSeam.setFakeNewest('claude', '1.2.0');
    await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);
    const keys = updateDriver.sent.map((e) => e.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(await row(a.id)).toMatchObject({ state: 'running', imageVersion: '1.2.0' });
  });

  it('an update a concurrent settle already finished is not handed to a driver', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    // Between the move and the hand-over, something else settles the update.
    const move = fleet.moveImage.bind(fleet);
    vi.spyOn(fleet, 'moveImage').mockImplementationOnce(async (handle, image, options) => {
      await move(handle, image, options);
      await adminDb.agentInstance.update({ where: { id: a.id }, data: { state: 'running' } });
    });
    const dto = await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);
    expect(dto.state).toBe('running');
    expect(updateDriver.sent).toEqual([]);
  });
});

describe('an update whose new image never starts (AC2)', () => {
  it('is rolled back at the start deadline with its reason, and the rollback is driven to running', async () => {
    const a = await slowUpdate();
    await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);
    const data = updateDriver.sent[0]!;

    clock.advance(UPDATE_START_DEADLINE_MS - 1_000);
    expect(isJobRunDefer(await runPass(data))).toBe(true);
    expect((await row(a.id)).updateFailureReason).toBeNull();

    clock.advance(1_000);
    expect(isJobRunDefer(await runPass(data))).toBe(true);
    const rolling = await row(a.id);
    expect(rolling.state).toBe('updating');
    expect(rolling.updateFailureReason).toBe(
      'The update to 1.1.0 didn’t work: the new version did not start within 5 minutes. ' +
        'Your agent is back on 1.0.0.',
    );
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));

    // The old image comes back up: the next pass settles the rollback.
    fleet.completeBoot(a.machineId!);
    clock.advance(AGENT_UPDATE_POLL_MS);
    expect(await runPass(data)).toBe('running');
    expect(await row(a.id)).toMatchObject({
      state: 'running',
      imageDigest: BASE_DIGEST,
      updateFailureReason: rolling.updateFailureReason,
      volumeId: a.volumeId,
    });
  });

  it('a pass past the driver window stops deferring and leaves the update to the sweep', async () => {
    const a = await slowUpdate();
    // The provider cannot be read, so the settle can decide nothing.
    vi.spyOn(fleet, 'describePersistent').mockRejectedValue(new Error('provider unreachable'));
    await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);
    const data = updateDriver.sent[0]!;
    clock.advance(UPDATE_SWEEP_AFTER_MS - 1_000);
    expect(isJobRunDefer(await runPass(data))).toBe(true);
    clock.advance(1_000);
    expect(await runPass(data)).toBe('swept');
    expect((await row(a.id)).state).toBe('updating');
  });

  it('a pass for an agent that is no longer updating does nothing', async () => {
    const a = await agent();
    const data = {
      workspaceId: a.workspaceId,
      instanceId: a.id,
      idempotencyKey: agentUpdateEventKey(a.id, a.stateChangedAt),
    };
    expect(await runPass(data)).toBe('noop');
    expect(await runPass({ ...data, instanceId: 'no-such-agent' })).toBe('noop');
    expect((await row(a.id)).state).toBe('running');
  });
});

describe('the sweep and the driver racing one update (AC3)', () => {
  /** Count the guarded moves out of `updating` that actually moved the row. */
  function countTransitions() {
    const moved: string[] = [];
    const transition = agentInstanceRepository.transition.bind(agentInstanceRepository);
    vi.spyOn(agentInstanceRepository, 'transition').mockImplementation(async (...args) => {
      const n = await transition(...args);
      if (n === 1 && args[1].includes('updating')) moved.push(args[2]);
      return n;
    });
    return moved;
  }

  it('settling a started machine: exactly one transition to running', async () => {
    const a = await slowUpdate();
    await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);
    const data = updateDriver.sent[0]!;
    fleet.completeBoot(a.machineId!);
    // Both owners at once: the driver's last pass and a sweep past its gate.
    clock.advance(UPDATE_SWEEP_AFTER_MS);
    const moved = countTransitions();
    const [pass, summary] = await Promise.all([runPass(data), sweeper.sweep()]);

    expect(moved).toEqual(['running']);
    expect(['running', 'noop']).toContain(pass);
    expect(summary.errors).toBe(0);
    expect(await row(a.id)).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST });
  });

  it('beginning a rollback: the machine is moved back exactly once', async () => {
    const a = await slowUpdate();
    await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);
    const data = updateDriver.sent[0]!;
    clock.advance(UPDATE_SWEEP_AFTER_MS);
    const moves = () => fleet.operations.filter((o) => o.startsWith('machine:move:')).length;
    const before = moves();

    await Promise.all([runPass(data), sweeper.sweep(), runPass(data)]);

    expect(moves() - before).toBe(1);
    const rolling = await row(a.id);
    expect(rolling.state).toBe('updating');
    expect(rolling.updateFailureReason).toContain('did not start within 5 minutes');
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
  });

  it('a settle that read the row before a racing settle began the rollback does not fail the agent', async () => {
    const a = await slowUpdate();
    await lifecycle.update(fx.projectIdentifier, a.id, fx.ctx);
    clock.advance(UPDATE_SWEEP_AFTER_MS);
    // The stale pass reads the row, then — before it reads the machine — the
    // racing pass records the failure and moves the machine back. Without the
    // re-read, the stale pass saw the record's digest past the rollback deadline
    // (measured from its stale `updating` entry) and failed the agent.
    const real = fleet.describePersistent.bind(fleet);
    vi.spyOn(fleet, 'describePersistent').mockImplementationOnce(async (handle) => {
      expect(await lifecycle.settleUpdate(a.id)).toBe('pending');
      return real(handle);
    });

    expect(await lifecycle.settleUpdate(a.id)).toBe('pending');

    const rolling = await row(a.id);
    expect(rolling.state).toBe('updating');
    expect(rolling.updateFailureReason).toContain('did not start within 5 minutes');
    expect(fleet.operations.filter((o) => o.startsWith('machine:move:'))).toHaveLength(2);
  });
});
