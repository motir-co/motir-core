import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import {
  AgentImageCatalogUnavailableError,
  AgentInstanceNotFoundError,
  AgentInstanceRunActiveError,
  AgentInstanceStateConflictError,
  AgentInstanceUpToDateError,
} from '@/lib/agentInstances/errors';
import {
  FAKE_BASE_VERSION,
  fakeDigestFor,
  imageCatalog,
  imageCatalogSeam,
} from '@/lib/agentInstances/imageCatalog';
import { pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import {
  AGENT_LIVENESS_COMMANDS,
  OFFERED_AGENT_PROFILES,
  livenessCommandFor,
  sandboxImageTag,
} from '@/lib/agentInstances/profiles';
import { isLegalTransition, RUNNING_STATES } from '@/lib/agentInstances/stateMachine';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import {
  MIN,
  clock,
  fleet,
  fx,
  intervals,
  otherMember,
  setUpHarness,
  slots,
  tearDownHarness,
} from './_harness';

// UPDATE AN AGENT TO A NEWER SANDBOX IMAGE (Story MOTIR-6862 · MOTIR-6952,
// `docs/decisions/agent-image-update.md` Q2–Q8) — over the real services and a
// real Postgres, on the FAKE persistent fleet, with the catalog's fake-fleet
// stand-in naming every agent's create-time digest `FAKE_BASE_VERSION` and a test
// making 1.1.0 the newest.
//
// ⚠️ THE VOLUME IS THE ASSERTION THAT MATTERS on every branch: the same volume
// id before and after, whatever the update did.

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
const updateRoute = await import('@/app/api/projects/[key]/instances/[id]/update/route');

const NEW = '1.1.0';
const NEW_DIGEST = fakeDigestFor('claude', NEW);
const BASE_DIGEST = fakeDigestFor('claude', FAKE_BASE_VERSION);
const ref = (digest: string) => pinnedImageReference(sandboxImageTag('claude'), digest);

beforeEach(async () => {
  await setUpHarness();
  imageCatalogSeam.reset();
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
});
afterEach(async () => {
  vi.restoreAllMocks();
  imageCatalogSeam.reset();
  await tearDownHarness();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function agent(name = 'yue-claude') {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  return adminDb.agentInstance.findUniqueOrThrow({ where: { id: dto.id } });
}
const row = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
const update = (id: string) => lifecycle.update(fx.projectIdentifier, id, fx.ctx);

describe('a RUNNING agent (Q2, Q3, Q7)', () => {
  it('moves to the newest image on the same machine and volume, and comes back running on it', async () => {
    const a = await agent();
    expect(a).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST, imageVersion: '1.0.0' });
    const before = await intervals();
    imageCatalogSeam.setFakeNewest('claude', NEW);

    const dto = await update(a.id);

    expect(dto).toMatchObject({
      state: 'running',
      imageDigest: NEW_DIGEST,
      imageVersion: NEW,
      update: null,
      pendingImageVersion: null,
      updateFailureReason: null,
    });
    const after = await row(a.id);
    expect(after).toMatchObject({
      machineId: a.machineId,
      volumeId: a.volumeId,
      targetImageDigest: null,
      targetImageVersion: null,
    });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(NEW_DIGEST));
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
    // Q7: the open interval and its slot are kept — nothing closed, nothing opened.
    const now = await intervals();
    expect(now.map((i) => i.id)).toEqual(before.map((i) => i.id));
    expect(now[0]!.endedAt).toBeNull();
    expect(await slots()).toHaveLength(1);
  });

  it('rolls back to the old image when the new one fails its liveness check, saying why', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.markImageFailing(ref(NEW_DIGEST));

    const dto = await update(a.id);

    expect(dto.state).toBe('running');
    expect(dto.imageDigest).toBe(BASE_DIGEST);
    expect(dto.imageVersion).toBe('1.0.0');
    expect(dto.updateFailureReason).toBe(
      'The update to 1.1.0 didn’t work: claude --version exited 127 (command not found). ' +
        'Your agent is back on 1.0.0.',
    );
    // The update is still offered: a fixed release can be tried again.
    expect(dto.update).toEqual({ version: NEW, digest: NEW_DIGEST });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
    expect((await row(a.id)).targetImageDigest).toBeNull();
  });

  it('a move the provider refuses leaves the agent running on its old image, with the refusal in words', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.failNextMove('version mismatch');
    const dto = await update(a.id);
    expect(dto).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST });
    expect(dto.updateFailureReason).toContain('version mismatch');
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
  });

  it('a later successful update clears the last failure', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.markImageFailing(ref(NEW_DIGEST));
    await update(a.id);
    imageCatalogSeam.setFakeNewest('claude', '1.2.0');
    const dto = await update(a.id);
    expect(dto).toMatchObject({ imageVersion: '1.2.0', updateFailureReason: null });
  });
});

describe('a HIBERNATED agent (Q5)', () => {
  async function hibernated() {
    const a = await agent();
    await lifecycle.hibernate(fx.projectIdentifier, a.id, fx.ctx);
    expect((await row(a.id)).state).toBe('hibernated');
    return a;
  }

  it('stays hibernated with the target recorded, its machine untouched; the next wake applies it', async () => {
    const a = await hibernated();
    imageCatalogSeam.setFakeNewest('claude', NEW);

    const dto = await update(a.id);
    expect(dto).toMatchObject({
      state: 'hibernated',
      imageDigest: BASE_DIGEST,
      pendingImageVersion: NEW,
    });
    expect(await row(a.id)).toMatchObject({
      targetImageDigest: NEW_DIGEST,
      targetImageVersion: NEW,
    });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
    expect((await fleet.describePersistent({ ...handleOf(a) })).state).toBe('stopped');

    const woken = await lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx);
    expect(woken).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST, imageVersion: NEW });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(NEW_DIGEST));
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
    expect((await row(a.id)).targetImageDigest).toBeNull();
  });

  it('a wake whose new image fails rolls back BEFORE it reports running', async () => {
    const a = await hibernated();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.markImageFailing(ref(NEW_DIGEST));
    await update(a.id);

    const woken = await lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx);
    expect(woken).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST });
    expect(woken.updateFailureReason).toContain('exited 127');
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it.each([
    [NEW, 'The update to 1.1.0 didn’t work: '],
    [null, 'The update to the newer version didn’t work: '],
  ])(
    'a wake whose move to the target (%s) is refused boots the old image and says why',
    async (targetVersion, opening) => {
      const a = await hibernated();
      imageCatalogSeam.setFakeNewest('claude', NEW);
      await update(a.id);
      await adminDb.agentInstance.update({
        where: { id: a.id },
        data: { targetImageVersion: targetVersion },
      });
      fleet.failNextMove('the provider refused the image');

      const woken = await lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx);
      expect(woken).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST });
      expect(woken.updateFailureReason).toContain(opening);
      expect(woken.updateFailureReason).toContain('Your agent is back on 1.0.0.');
      expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
      expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
    },
  );

  it('a wake that cannot put the agent back on its own image (no update pending) fails it in words', async () => {
    const a = await hibernated();
    // The stopped machine holds an image other than the record's (a rollback that never ran).
    await fleet.moveImage(handleOf(a), ref(NEW_DIGEST), { launch: false });
    fleet.failNextMove('the provider refused the image');
    const woken = await lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx);
    expect(woken.state).toBe('failed');
    expect(woken.failureReason).toContain('The machine could not start');
    expect(woken.failureReason).toContain('the provider refused the image');
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it('an agent never updated keeps its digest across hibernate and wake', async () => {
    const a = await hibernated();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    const woken = await lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx);
    expect(woken).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
  });
});

function handleOf(a: { flyApp: string | null; machineId: string | null; volumeId: string | null }) {
  return {
    provider: 'fake' as const,
    app: a.flyApp!,
    machineId: a.machineId!,
    volumeId: a.volumeId!,
    region: 'iad',
    createdAt: new Date(),
  };
}

describe('the refusals (Q8) — each moves nothing', () => {
  async function expectUntouched(id: string, before: Awaited<ReturnType<typeof row>>) {
    const after = await row(id);
    expect(after.state).toBe(before.state);
    expect(after.imageDigest).toBe(before.imageDigest);
    expect(after.targetImageDigest).toBeNull();
    expect(fleet.machineImage(before.machineId!)).toBe(ref(before.imageDigest));
  }

  it('already on the newest image', async () => {
    const a = await agent();
    await expect(update(a.id)).rejects.toThrow(AgentInstanceUpToDateError);
    await expect(update(a.id)).rejects.toThrow(
      'This agent already runs the newest version (1.0.0).',
    );
    await expectUntouched(a.id, a);
  });

  it('a run is running in the agent — the refusal names it', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a card' },
      fx.ctx,
    );
    await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin: 'instance',
        agentInstanceId: a.id,
        agent: 'claude',
        cards: [{ key: item.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    const err = await update(a.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentInstanceRunActiveError);
    expect((err as Error).message).toBe(
      `This agent is running ${item.identifier}, so it can’t be updated. Cancel the run first.`,
    );
    await expectUntouched(a.id, a);
  });

  it.each(['starting', 'waking', 'hibernating', 'deleting', 'failed', 'updating'] as const)(
    'an agent that is %s',
    async (state) => {
      const a = await agent();
      imageCatalogSeam.setFakeNewest('claude', NEW);
      await adminDb.agentInstance.update({ where: { id: a.id }, data: { state } });
      const err = await update(a.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentInstanceStateConflictError);
      expect((err as Error).message).toBe(
        `This agent is ${state}, so it can't be updated right now.`,
      );
      expect(await row(a.id)).toMatchObject({ state, imageDigest: BASE_DIGEST });
    },
  );

  it('another person’s agent is not found — the same answer as no agent at all', async () => {
    const other = await otherMember();
    const theirs = await lifecycle.create(
      fx.projectIdentifier,
      { name: 'theirs', profileId: 'claude' },
      { ...fx.ctx, userId: other.userId },
    );
    imageCatalogSeam.setFakeNewest('claude', NEW);
    await expect(update(theirs.id)).rejects.toThrow(AgentInstanceNotFoundError);
    await expect(update('no-such-agent')).rejects.toThrow(AgentInstanceNotFoundError);
  });

  it('a registry that cannot be asked is a wait, never "up to date"', async () => {
    const a = await agent();
    vi.spyOn(imageCatalog, 'newestFor').mockResolvedValue('unknown');
    await expect(update(a.id)).rejects.toThrow(AgentImageCatalogUnavailableError);
    await expectUntouched(a.id, a);
  });
});

describe('real concurrency — every move is a guarded compare-and-set', () => {
  it('two Updates at once: exactly one moves the machine, the other is refused', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    const results = await Promise.allSettled([update(a.id), update(a.id)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    // Either the second arrived after the first settled (up to date) or raced it (conflict).
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = (lost[0] as PromiseRejectedResult).reason;
    expect(
      reason instanceof AgentInstanceStateConflictError ||
        reason instanceof AgentInstanceUpToDateError,
    ).toBe(true);
    expect(await row(a.id)).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST });
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it.each(['hibernate', 'delete'] as const)(
    'Update racing %s: one wins, the loser is refused, and the agent lands in one coherent state',
    async (other) => {
      const a = await agent();
      imageCatalogSeam.setFakeNewest('claude', NEW);
      const results = await Promise.allSettled([
        update(a.id),
        other === 'hibernate'
          ? lifecycle.hibernate(fx.projectIdentifier, a.id, fx.ctx)
          : lifecycle.delete(fx.projectIdentifier, a.id, fx.ctx),
      ]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      for (const r of results) {
        if (r.status === 'rejected') {
          // The update loses a hibernate only at the guarded move. Against a delete it can also
          // lose before it starts: a delete that commits before the update's first read leaves no
          // live agent, and an agent that is gone is not found (MOTIR-10291).
          const refused =
            r.reason instanceof AgentInstanceStateConflictError ||
            (other === 'delete' && r.reason instanceof AgentInstanceNotFoundError);
          expect(refused, `unexpected refusal: ${String(r.reason)}`).toBe(true);
        }
      }
      const final = await row(a.id);
      expect(['running', 'hibernated', 'deleting']).toContain(
        final.deletedAt ? 'deleting' : final.state,
      );
      expect(final.state).not.toBe('updating');
    },
  );

  it('an Update after the delete has committed is not found, and leaves the agent deleted', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    await lifecycle.delete(fx.projectIdentifier, a.id, fx.ctx);
    await expect(update(a.id)).rejects.toThrow(AgentInstanceNotFoundError);
    const final = await row(a.id);
    expect(final.deletedAt).not.toBeNull();
    expect(final.state).not.toBe('updating');
  });
});

describe('the sweep resolves an agent left mid-update (Q6)', () => {
  it('a machine that came up on the new image after the inline wait: liveness, then running on it', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    const dto = await update(a.id);
    expect(dto.state).toBe('updating');
    fleet.completeBoot(a.machineId!);

    // Fresh: the inline settle's, not the sweep's.
    await sweeper.sweep();
    expect((await row(a.id)).state).toBe('updating');

    clock.advance(11 * MIN);
    await sweeper.sweep();
    expect(await row(a.id)).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST });
  });

  it('a new image that never starts is rolled back; a rollback that never starts ends failed, the volume kept', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);

    clock.advance(11 * MIN);
    await sweeper.sweep();
    const rolling = await row(a.id);
    expect(rolling.state).toBe('updating');
    expect(rolling.updateFailureReason).toContain('did not start within 5 minutes');
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));

    clock.advance(6 * MIN);
    await sweeper.sweep();
    const failed = await row(a.id);
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toContain('couldn’t be brought back on 1.0.0');
    expect(failed.imageDigest).toBe(BASE_DIGEST);
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it('an updating agent’s interval rolls like a running one’s', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);
    clock.advance(3 * MIN);
    expect(await lifecycle.rollInterval(a.id)).toBe('rolled');
  });
});

describe('settling an update, branch by branch (Q4, Q6)', () => {
  /** An agent recorded `updating` toward 1.1.0 while its machine still runs the old image. */
  async function interrupted(targetVersion: string | null) {
    const a = await agent();
    await adminDb.agentInstance.update({
      where: { id: a.id },
      data: { state: 'updating', targetImageDigest: NEW_DIGEST, targetImageVersion: targetVersion },
    });
    return a;
  }

  it('nothing to settle: an agent that is not updating, or does not exist', async () => {
    const a = await agent();
    expect(await lifecycle.settleUpdate(a.id)).toBe('noop');
    expect(await lifecycle.settleUpdate('no-such-agent')).toBe('noop');
  });

  it('a machine lost mid-update fails the agent in words, the volume kept', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);
    fleet.destroyOutside(a.machineId!);

    expect(await lifecycle.settleUpdate(a.id)).toBe('failed');
    const after = await row(a.id);
    expect(after.state).toBe('failed');
    expect(after.failureReason).toContain('The machine was lost during the update');
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it.each([
    [NEW, 'The update to 1.1.0 was interrupted. Your agent is still on 1.0.0.'],
    [null, 'The update to the newer version was interrupted. Your agent is still on 1.0.0.'],
  ])(
    'an update interrupted before the move (target %s): back to running on the old image, saying so',
    async (targetVersion, reason) => {
      const a = await interrupted(targetVersion);
      expect(await lifecycle.settleUpdate(a.id)).toBe('running');
      expect(await row(a.id)).toMatchObject({
        state: 'running',
        imageDigest: BASE_DIGEST,
        targetImageDigest: null,
        updateFailureReason: reason,
      });
      expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
    },
  );

  it('a machine left stopped mid-rollback is put back on the old image and started', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);
    clock.advance(6 * MIN);
    // The new image never started: the rollback begins.
    expect(await lifecycle.settleUpdate(a.id)).toBe('pending');
    expect((await row(a.id)).updateFailureReason).toContain('did not start within 5 minutes');

    // …and the machine is found stopped, still holding the new image.
    fleet.stopOutside(a.machineId!);
    await fleet.moveImage(handleOf(a), ref(NEW_DIGEST), { launch: false });
    fleet.setBootBehaviour('start');
    expect(await lifecycle.settleUpdate(a.id)).toBe('pending');
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));

    expect(await lifecycle.settleUpdate(a.id)).toBe('running');
    expect(await row(a.id)).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST });
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it('a rollback that cannot even be asked for fails the agent in words, the volume kept', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);
    await adminDb.agentInstance.update({ where: { id: a.id }, data: { targetImageVersion: null } });
    clock.advance(6 * MIN);
    fleet.failNextMove('the provider refused the image');
    expect(await lifecycle.settleUpdate(a.id)).toBe('pending');
    const after = await row(a.id);
    expect(after.state).toBe('failed');
    expect(after.failureReason).toContain(
      'The update to the newer version didn’t work, and your agent couldn’t be brought back on 1.0.0',
    );
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it('a rollback names "its previous build" when the old version was never known', async () => {
    const a = await agent();
    const unnamed = 'sha256:' + 'e'.repeat(64);
    await adminDb.agentInstance.update({
      where: { id: a.id },
      data: { imageVersion: null, imageDigest: unnamed },
    });
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.markImageFailing(ref(NEW_DIGEST));
    const dto = await update(a.id);
    expect(dto.updateFailureReason).toContain('Your agent is back on its previous build.');
    expect(dto.imageDigest).toBe(unnamed);
  });

  it('an interrupted update whose machine stays stopped waits, then fails past the deadline', async () => {
    const a = await interrupted(null);
    fleet.stopOutside(a.machineId!);
    expect(await lifecycle.settleUpdate(a.id)).toBe('pending');
    expect((await row(a.id)).state).toBe('updating');

    clock.advance(6 * MIN);
    expect(await lifecycle.settleUpdate(a.id)).toBe('failed');
    const after = await row(a.id);
    expect(after.state).toBe('failed');
    expect(after.failureReason).toContain(
      'The update to the newer version didn’t work, and your agent couldn’t be brought back on 1.0.0: it did not start.',
    );
    expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
  });

  it('rolling the interval is for a running or updating agent only', async () => {
    const a = await agent();
    await lifecycle.hibernate(fx.projectIdentifier, a.id, fx.ctx);
    expect(await lifecycle.rollInterval(a.id)).toBe('noop');
    expect(await lifecycle.rollInterval('no-such-agent')).toBe('noop');
  });

  it('a stopped machine whose restart is refused waits for the next pass', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);
    clock.advance(6 * MIN);
    await lifecycle.settleUpdate(a.id);
    fleet.stopOutside(a.machineId!);
    fleet.failNextStart();
    expect(await lifecycle.settleUpdate(a.id)).toBe('pending');
    expect((await row(a.id)).state).toBe('updating');
  });
});

describe('the terminal must survive the update (Q3)', () => {
  it('a new image that drops the terminal server is rolled back, saying so', async () => {
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', 'm'.repeat(48));
    const a = await agent();
    expect(a.terminalServer).toBe('present');
    imageCatalogSeam.setFakeNewest('claude', NEW);
    // The coding agent still runs on the new image; its terminal server is gone.
    fleet.setExecResponder((command) => ({
      exitCode: command.join(' ') === 'motir agent-terminal --help' ? 1 : 0,
      stdout: '',
      stderr: '',
    }));
    try {
      const dto = await update(a.id);
      expect(dto.state).toBe('running');
      expect(dto.imageDigest).toBe(BASE_DIGEST);
      expect(dto.updateFailureReason).toBe(
        'The update to 1.1.0 didn’t work: the new version has no terminal server. ' +
          'Your agent is back on 1.0.0.',
      );
      expect(fleet.liveVolumeIds()).toEqual([a.volumeId]);
    } finally {
      fleet.setExecResponder(null);
      vi.unstubAllEnvs();
    }
  });
});

describe('the lost races — every guarded move refuses rather than overwrites (Q8)', () => {
  it('a run opened between the check and the move is caught inside the move, which is undone', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a card' },
      fx.ctx,
    );
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin: 'instance',
        agentInstanceId: a.id,
        agent: 'claude',
        cards: [{ key: item.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    // The first look (outside the move) misses the run; the one inside it does not.
    vi.spyOn(dispatchRunRepository, 'findRunningByAgentInstance').mockResolvedValueOnce(null);
    const err = await update(a.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentInstanceRunActiveError);
    expect(err).toMatchObject({ runId: run.id, workItemKey: item.identifier });
    expect(await row(a.id)).toMatchObject({ state: 'running', imageDigest: BASE_DIGEST });
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
  });

  it('a running agent moved by someone else first is a state conflict', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    vi.spyOn(agentInstanceRepository, 'transition').mockResolvedValueOnce(0);
    await expect(update(a.id)).rejects.toThrow(AgentInstanceStateConflictError);
    expect(fleet.machineImage(a.machineId!)).toBe(ref(BASE_DIGEST));
  });

  it('a hibernated agent woken by someone else first is a state conflict', async () => {
    const a = await agent();
    await lifecycle.hibernate(fx.projectIdentifier, a.id, fx.ctx);
    imageCatalogSeam.setFakeNewest('claude', NEW);
    vi.spyOn(agentInstanceRepository, 'patchImage').mockResolvedValueOnce(0);
    await expect(update(a.id)).rejects.toThrow(AgentInstanceStateConflictError);
    expect((await row(a.id)).targetImageDigest).toBeNull();
  });

  it('a settle that loses the race to another settle changes nothing', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);
    fleet.completeBoot(a.machineId!);
    vi.spyOn(agentInstanceRepository, 'transition').mockResolvedValueOnce(0);
    expect(await lifecycle.settleUpdate(a.id)).toBe('noop');
    // The winner's settle still lands.
    expect(await lifecycle.settleUpdate(a.id)).toBe('running');
  });

  it('an interrupted-update settle that loses the race changes nothing', async () => {
    const a = await agent();
    await adminDb.agentInstance.update({
      where: { id: a.id },
      data: { state: 'updating', targetImageDigest: NEW_DIGEST, targetImageVersion: NEW },
    });
    vi.spyOn(agentInstanceRepository, 'transition').mockResolvedValueOnce(0);
    expect(await lifecycle.settleUpdate(a.id)).toBe('noop');
    expect((await row(a.id)).state).toBe('updating');
  });

  it('a rollback another settle already recorded is not begun twice', async () => {
    const a = await agent();
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.setBootBehaviour('never_start');
    await update(a.id);
    clock.advance(6 * MIN);
    vi.spyOn(agentInstanceRepository, 'patchImage').mockResolvedValueOnce(0);
    const moves = () => fleet.operations.filter((o) => o.startsWith('machine:move:')).length;
    const before = moves();
    expect(await lifecycle.settleUpdate(a.id)).toBe('pending');
    expect(moves()).toBe(before);
  });
});

describe('an agent with no recorded version (created before versions were recorded)', () => {
  it('is named from the catalog at the press, and the name is recorded with the update', async () => {
    const a = await agent();
    await adminDb.agentInstance.update({ where: { id: a.id }, data: { imageVersion: null } });
    imageCatalogSeam.setFakeNewest('claude', NEW);
    fleet.markImageFailing(ref(NEW_DIGEST));
    const dto = await update(a.id);
    // Rolled back to the old image, which now carries the version the catalog named.
    expect(dto).toMatchObject({
      state: 'running',
      imageDigest: BASE_DIGEST,
      imageVersion: '1.0.0',
    });
    expect((await row(a.id)).imageVersion).toBe('1.0.0');
  });

  it('an agent created while the catalog cannot be read records no version', async () => {
    imageCatalogSeam.setFakeUnavailable(true);
    const a = await agent();
    expect(a.imageVersion).toBeNull();
  });

  it('a digest the catalog cannot name is still offered the update', async () => {
    const a = await agent();
    await adminDb.agentInstance.update({
      where: { id: a.id },
      data: { imageVersion: null, imageDigest: 'sha256:' + 'e'.repeat(64) },
    });
    imageCatalogSeam.setFakeNewest('claude', NEW);
    const dto = await update(a.id);
    expect(dto).toMatchObject({ state: 'running', imageDigest: NEW_DIGEST, imageVersion: NEW });
  });
});

describe('POST /api/projects/[key]/instances/[id]/update', () => {
  const params = (id: string) => ({ params: Promise.resolve({ key: fx.projectIdentifier, id }) });
  const post = (id: string) =>
    new Request(`http://test/api/projects/${fx.projectIdentifier}/instances/${id}/update`, {
      method: 'POST',
    });

  it('200 with the updated agent; 409 in words when it is already on the newest', async () => {
    const a = await agent();
    const refused = await updateRoute.POST(post(a.id), params(a.id));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'agent_instance_up_to_date',
      error: 'This agent already runs the newest version (1.0.0).',
      version: '1.0.0',
    });

    imageCatalogSeam.setFakeNewest('claude', NEW);
    const res = await updateRoute.POST(post(a.id), params(a.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { instance: { imageVersion: string } }).instance).toMatchObject({
      imageVersion: NEW,
      state: 'running',
    });
  });

  it('404 for an agent that is not the caller’s', async () => {
    const res = await updateRoute.POST(post('nope'), params('nope'));
    expect(res.status).toBe(404);
  });
});

describe('the state table and the liveness commands', () => {
  it('updating is entered from running and hibernated only, leaves to running or failed, and holds a slot', () => {
    expect(isLegalTransition('running', 'updating')).toBe(true);
    expect(isLegalTransition('hibernated', 'updating')).toBe(true);
    expect(isLegalTransition('failed', 'updating')).toBe(false);
    expect(isLegalTransition('updating', 'running')).toBe(true);
    expect(isLegalTransition('updating', 'failed')).toBe(true);
    expect(isLegalTransition('updating', 'hibernating')).toBe(false);
    expect(isLegalTransition('updating', 'deleting')).toBe(false);
    expect(RUNNING_STATES).toContain('updating');
  });

  it('each offered profile’s liveness command is the sandbox smoke’s, word for word (Q3 drift guard)', () => {
    const smoke = JSON.parse(
      readFileSync(join(process.cwd(), 'packages/cli/sandbox/smoke/profiles.json'), 'utf8'),
    ) as
      | { profiles: Array<{ id: string; liveness: string }> }
      | Array<{ id: string; liveness: string }>;
    const list = Array.isArray(smoke) ? smoke : smoke.profiles;
    for (const profile of OFFERED_AGENT_PROFILES) {
      const published = list.find((p) => p.id === profile.id);
      expect(published, profile.id).toBeDefined();
      expect(AGENT_LIVENESS_COMMANDS[profile.id]).toEqual(published!.liveness.split(/\s+/));
    }
  });

  it('a profile with no published liveness command is checked with `motir --version`', () => {
    expect(livenessCommandFor('claude')).toEqual(AGENT_LIVENESS_COMMANDS['claude']);
    expect(livenessCommandFor('not-a-profile')).toEqual(['motir', '--version']);
  });

  it('the up-to-date refusal names the version when it is known, and reads whole without it', () => {
    expect(new AgentInstanceUpToDateError('a1', '0.5.0').message).toBe(
      'This agent already runs the newest version (0.5.0).',
    );
    expect(new AgentInstanceUpToDateError('a1', null).message).toBe(
      'This agent already runs the newest version.',
    );
  });
});
