import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { bindOrganizationContext } from '@/lib/organizations/context';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { agentInstanceIntervalRepository } from '@/lib/repositories/agentInstanceIntervalRepository';
import {
  AGENT_INSTANCE_STATES,
  AGENT_INSTANCE_TRANSITIONS,
  RUNNING_STATES,
  intervalBillableSeconds,
  intervalChargeReference,
  isLegalTransition,
  statesThatMayEnter,
} from '@/lib/agentInstances/stateMachine';
import { toAgentInstanceDto, toAgentInstanceIntervalDto } from '@/lib/mappers/agentInstanceMappers';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The agent instance record (Story MOTIR-6860 · MOTIR-6870), against a real
// Postgres: the §4 transition table, the GUARDED transition and its race, the
// owner scoping, the running counts for §6's caps, and the interval that opens
// once, closes once and carries ⌈end − start⌉.
//
// Fixtures go through `adminDb` (the owner); every subject call runs inside a
// workspace-bound transaction, as the service will — the tables are RLS-gated on
// `app.workspace_id`, and a read outside one returns an empty list.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

interface Fixture {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  ownerId: string;
  otherUserId: string;
}

async function seedFixture(): Promise<Fixture> {
  const tag = `${seq++}-${randomUUID().slice(0, 6)}`;
  const owner = await adminDb.user.create({
    data: { name: 'Yue', email: `yue-${tag}@example.com` },
  });
  const other = await adminDb.user.create({
    data: { name: 'Ann', email: `ann-${tag}@example.com` },
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
      identifier: `P${seq}`,
      workspaceId: workspace.id,
    },
  });
  return {
    organizationId: org.id,
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: owner.id,
    otherUserId: other.id,
  };
}

function createInstance(f: Fixture, over: { name?: string; ownerId?: string } = {}) {
  return withWorkspaceServiceContext(f.workspaceId, (tx) =>
    agentInstanceRepository.create(
      {
        workspaceId: f.workspaceId,
        organizationId: f.organizationId,
        projectId: f.projectId,
        ownerId: over.ownerId ?? f.ownerId,
        name: over.name ?? 'yue-claude',
        profileId: 'claude',
        imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
        imageDigest: 'sha256:' + 'a'.repeat(64),
        region: 'iad',
      },
      tx,
    ),
  );
}

describe('the §4 transition table', () => {
  it('names every state, and every successor is itself a state', () => {
    expect(Object.keys(AGENT_INSTANCE_TRANSITIONS).sort()).toEqual(
      [...AGENT_INSTANCE_STATES].sort(),
    );
    for (const [from, tos] of Object.entries(AGENT_INSTANCE_TRANSITIONS)) {
      for (const to of tos) expect(AGENT_INSTANCE_STATES, `${from} → ${to}`).toContain(to);
    }
  });

  it('allows exactly the decision’s pairs', () => {
    const legal = AGENT_INSTANCE_STATES.flatMap((from) =>
      AGENT_INSTANCE_STATES.filter((to) => isLegalTransition(from, to)).map(
        (to) => `${from}→${to}`,
      ),
    ).sort();
    expect(legal).toEqual(
      [
        'starting→running',
        'starting→failed',
        'running→hibernating',
        'running→hibernated',
        'running→failed',
        'running→deleting',
        'hibernating→hibernated',
        'hibernating→failed',
        'hibernated→waking',
        'hibernated→deleting',
        'waking→running',
        'waking→failed',
        'failed→waking',
        'failed→deleting',
        // AMENDMENT 4 (MOTIR-7341) — a boot or a stop that never settles is deletable.
        'starting→deleting',
        'waking→deleting',
        'hibernating→deleting',
        // agent-image-update.md Q6 — the update's own four.
        'running→updating',
        'hibernated→updating',
        'updating→running',
        'updating→failed',
      ].sort(),
    );
  });

  // AMENDMENT 4: every state's Delete answer, pinned one by one — the service's
  // guard, the sweep's plan-lapse delete and the panel all read this table.
  it.each([
    ['starting', true],
    ['running', true],
    ['hibernating', true],
    ['hibernated', true],
    ['waking', true],
    ['failed', true],
    ['deleting', false],
    ['updating', false],
  ] as const)('Delete from %s → %s', (state, legal) => {
    expect(isLegalTransition(state, 'deleting')).toBe(legal);
  });

  it('derives the prior-state set a guarded update names', () => {
    expect(statesThatMayEnter('deleting').sort()).toEqual([
      'failed',
      'hibernated',
      'hibernating',
      'running',
      'starting',
      'waking',
    ]);
    expect(statesThatMayEnter('running').sort()).toEqual(['starting', 'updating', 'waking']);
    expect(statesThatMayEnter('starting')).toEqual([]);
  });

  it('bills ⌈end − start⌉ seconds, never negative, and keys the charge on the interval', () => {
    const start = new Date('2026-09-28T10:00:00.000Z');
    expect(intervalBillableSeconds(start, new Date('2026-09-28T10:00:59.001Z'))).toBe(60);
    expect(intervalBillableSeconds(start, new Date('2026-09-28T10:01:00.000Z'))).toBe(60);
    expect(intervalBillableSeconds(start, start)).toBe(0);
    expect(intervalBillableSeconds(start, new Date('2026-09-28T09:59:00.000Z'))).toBe(0);
    expect(intervalChargeReference('abc')).toBe('agent-instance-interval:abc');
  });
});

describe('agentInstanceRepository', () => {
  it('creates at `starting` and maps without the Fly handle or tenancy columns', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    expect(row.state).toBe('starting');
    expect(row.deletedAt).toBeNull();
    const dto = toAgentInstanceDto(row, { imageVersion: '0.9.0', update: null });
    expect(dto).toMatchObject({
      name: 'yue-claude',
      profileId: 'claude',
      state: 'starting',
      region: 'iad',
    });
    expect(Object.keys(dto)).not.toContain('machineId');
    expect(Object.keys(dto)).not.toContain('workspaceId');
    expect(Object.keys(dto)).not.toContain('ownerId');
  });

  it('refuses a second LIVE instance with the same (owner, project, name), and frees the name on delete', async () => {
    const f = await seedFixture();
    const first = await createInstance(f);
    await expect(createInstance(f)).rejects.toThrow();
    // Another owner may use the same name on the same project.
    await expect(createInstance(f, { ownerId: f.otherUserId })).resolves.toBeTruthy();

    await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
      expect(
        await agentInstanceRepository.transition(
          first.id,
          ['starting'],
          'running',
          new Date(),
          {},
          tx,
        ),
      ).toBe(1);
      expect(
        await agentInstanceRepository.transition(
          first.id,
          ['running'],
          'deleting',
          new Date(),
          {},
          tx,
        ),
      ).toBe(1);
      expect(await agentInstanceRepository.markDeleted(first.id, new Date(), tx)).toBe(1);
    });
    await expect(createInstance(f)).resolves.toBeTruthy();
  });

  it('a guarded transition from the wrong prior state changes nothing and reports 0', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    const moved = await withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceRepository.transition(row.id, ['hibernated'], 'waking', new Date(), {}, tx),
    );
    expect(moved).toBe(0);
    const after = await withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceRepository.findById(row.id, tx),
    );
    expect(after?.state).toBe('starting');
    expect(after?.stateChangedAt.getTime()).toBe(row.stateChangedAt.getTime());
  });

  it('a transition guarded on an image digest moves only while the row still carries it (MOTIR-7340)', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    const stale = await withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceRepository.transition(row.id, ['starting'], 'running', new Date(), {}, tx, {
        imageDigest: 'sha256:not-the-one-it-runs',
      }),
    );
    expect(stale).toBe(0);
    const current = await withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceRepository.transition(row.id, ['starting'], 'running', new Date(), {}, tx, {
        imageDigest: row.imageDigest,
      }),
    );
    expect(current).toBe(1);
  });

  it('TWO CONCURRENT transitions from the same state: exactly one wins', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    await withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceRepository.transition(row.id, ['starting'], 'running', new Date(), {}, tx),
    );
    // A click racing the idle sweep: both read `running`, both ask to hibernate,
    // on two connections at once. The conditional UPDATE lets exactly one through.
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all(
        [0, 1].map(() =>
          withWorkspaceServiceContext(f.workspaceId, (tx) =>
            agentInstanceRepository.transition(
              row.id,
              ['running'],
              'hibernating',
              new Date(),
              {},
              tx,
            ),
          ),
        ),
      );
      expect(results.sort()).toEqual([0, 1]);
      // Put it back for the next round through the legal path.
      await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
        await agentInstanceRepository.transition(
          row.id,
          ['hibernating'],
          'hibernated',
          new Date(),
          {},
          tx,
        );
        await agentInstanceRepository.transition(
          row.id,
          ['hibernated'],
          'waking',
          new Date(),
          {},
          tx,
        );
        await agentInstanceRepository.transition(row.id, ['waking'], 'running', new Date(), {}, tx);
      });
    }
  });

  it('writes the failure reason and the idle signal with the state, and clears the reason on wake', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    const at = new Date('2026-09-28T12:00:00.000Z');
    await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
      await agentInstanceRepository.transition(
        row.id,
        ['starting'],
        'failed',
        at,
        { failureReason: 'no capacity' },
        tx,
      );
      const failed = await agentInstanceRepository.findById(row.id, tx);
      expect(failed).toMatchObject({
        state: 'failed',
        failureReason: 'no capacity',
        stateChangedAt: at,
      });
      await agentInstanceRepository.transition(
        row.id,
        ['failed'],
        'waking',
        at,
        { failureReason: null, lastActivityAt: at },
        tx,
      );
      const waking = await agentInstanceRepository.findById(row.id, tx);
      expect(waking).toMatchObject({ state: 'waking', failureReason: null, lastActivityAt: at });
      expect(
        await agentInstanceRepository.touchActivity(row.id, new Date(at.getTime() + 1000), tx),
      ).toBe(1);
    });
  });

  it('records the persistent handle, and only marks a `deleting` row deleted', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
      expect(
        await agentInstanceRepository.setHandle(
          row.id,
          { flyApp: 'motir-inst-x', machineId: 'm1', volumeId: 'v1' },
          tx,
        ),
      ).toBe(1);
      expect(await agentInstanceRepository.markDeleted(row.id, new Date(), tx)).toBe(0);
      const back = await agentInstanceRepository.findById(row.id, tx);
      expect(back).toMatchObject({
        flyApp: 'motir-inst-x',
        machineId: 'm1',
        volumeId: 'v1',
        deletedAt: null,
      });
    });
  });

  it('lists ONLY the caller’s own live instances, paginated with a total; another user’s is not found by id', async () => {
    const f = await seedFixture();
    const mine: Awaited<ReturnType<typeof createInstance>>[] = [];
    for (const name of ['a', 'b', 'c']) mine.push(await createInstance(f, { name }));
    const theirs = await createInstance(f, { name: 'theirs', ownerId: f.otherUserId });

    await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
      const page1 = await agentInstanceRepository.listLiveForOwner(
        { ownerId: f.ownerId, projectId: f.projectId, take: 2, skip: 0 },
        tx,
      );
      const page2 = await agentInstanceRepository.listLiveForOwner(
        { ownerId: f.ownerId, projectId: f.projectId, take: 2, skip: 2 },
        tx,
      );
      expect([...page1, ...page2].map((r) => r.name).sort()).toEqual(['a', 'b', 'c']);
      expect(page1).toHaveLength(2);
      expect(
        await agentInstanceRepository.countLiveForOwner(
          { ownerId: f.ownerId, projectId: f.projectId },
          tx,
        ),
      ).toBe(3);
      // Without a project, the owner's agents across every project.
      expect(
        await agentInstanceRepository.listLiveForOwner(
          { ownerId: f.ownerId, take: 10, skip: 0 },
          tx,
        ),
      ).toHaveLength(3);
      expect(await agentInstanceRepository.countLiveForOwner({ ownerId: f.ownerId }, tx)).toBe(3);
      expect(await agentInstanceRepository.findLiveForOwner(theirs.id, f.ownerId, tx)).toBeNull();
      expect(
        await agentInstanceRepository.findLiveForOwner(mine[0]!.id, f.ownerId, tx),
      ).not.toBeNull();
    });
  });

  it('counts running instances fleet-wide (system context) and per organisation', async () => {
    const f = await seedFixture();
    const g = await seedFixture();
    const a = await createInstance(f, { name: 'a' });
    await createInstance(f, { name: 'b' });
    const c = await createInstance(g, { name: 'c' });
    // `a` hibernates — it no longer counts.
    await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
      await agentInstanceRepository.transition(a.id, ['starting'], 'running', new Date(), {}, tx);
      await agentInstanceRepository.transition(a.id, ['running'], 'hibernated', new Date(), {}, tx);
    });
    expect(RUNNING_STATES).not.toContain('hibernated');

    expect(await withSystemContext((tx) => agentInstanceRepository.countRunning({}, tx))).toBe(2);
    expect(
      await withSystemContext((tx) =>
        agentInstanceRepository.countRunning({ organizationId: f.organizationId }, tx),
      ),
    ).toBe(1);
    expect(
      await withSystemContext((tx) =>
        agentInstanceRepository.countLiveForOwnerEverywhere(f.ownerId, tx),
      ),
    ).toBe(2);
    const discovered = await withSystemContext((tx) =>
      agentInstanceRepository.listLiveInStates(['starting'], 10, tx),
    );
    expect(discovered.map((r) => r.id)).toContain(c.id);
    // A bound tenant read never sees the other workspace.
    expect(
      await withWorkspaceServiceContext(f.workspaceId, (tx) =>
        agentInstanceRepository.findById(c.id, tx),
      ),
    ).toBeNull();
  });

  it('counts the org members at the per-person figure, live instances in any project (MOTIR-9660)', async () => {
    const f = await seedFixture();
    await adminDb.organizationMembership.createMany({
      data: [
        { organizationId: f.organizationId, userId: f.ownerId, role: 'owner' },
        { organizationId: f.organizationId, userId: f.otherUserId },
      ],
    });
    await createInstance(f, { name: 'a' });
    await createInstance(f, { name: 'b' });
    await createInstance(f, { name: 'c', ownerId: f.otherUserId });
    const atFigure = (figure: number) =>
      // `organization_membership` is visible only under the org's own GUC.
      withSystemContext(async (tx) => {
        await bindOrganizationContext(tx, f.organizationId);
        return agentInstanceRepository.countMembersAtLiveFigure(f.organizationId, figure, tx);
      });
    expect(await atFigure(1)).toBe(2);
    expect(await atFigure(2)).toBe(1);
    expect(await atFigure(3)).toBe(0);
    // No row back reads as nobody.
    const empty = { $queryRaw: async () => [] } as unknown as Parameters<
      typeof agentInstanceRepository.countMembersAtLiveFigure
    >[2];
    expect(await agentInstanceRepository.countMembersAtLiveFigure(f.organizationId, 1, empty)).toBe(
      0,
    );
  });
});

describe('agentInstanceIntervalRepository', () => {
  function open(f: Fixture, instanceId: string, startedAt: Date) {
    const id = randomUUID();
    return withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceIntervalRepository.open(
        {
          id,
          workspaceId: f.workspaceId,
          organizationId: f.organizationId,
          agentInstanceId: instanceId,
          runId: id,
          runStartedAt: startedAt,
          startedAt,
          chargeReference: intervalChargeReference(id),
        },
        tx,
      ),
    );
  }

  it('opens one interval per instance at a time — a second open is refused by the database', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    await open(f, row.id, new Date());
    await expect(open(f, row.id, new Date())).rejects.toThrow();
  });

  it('closes with ⌈end − start⌉ billable seconds, once; a second close changes nothing', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    const startedAt = new Date('2026-09-28T10:00:00.000Z');
    const endedAt = new Date('2026-09-28T10:02:30.400Z');
    const interval = await open(f, row.id, startedAt);

    await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
      const billableSeconds = intervalBillableSeconds(startedAt, endedAt);
      expect(
        await agentInstanceIntervalRepository.close(
          interval.id,
          { endedAt, endReason: 'hibernated', billableSeconds },
          tx,
        ),
      ).toBe(1);
      expect(
        await agentInstanceIntervalRepository.close(
          interval.id,
          {
            endedAt: new Date(endedAt.getTime() + 60_000),
            endReason: 'idle',
            billableSeconds: 999,
          },
          tx,
        ),
      ).toBe(0);
      const back = await agentInstanceIntervalRepository.findById(interval.id, tx);
      expect(back).toMatchObject({
        endReason: 'hibernated',
        billableSeconds: 151,
        chargeOutcome: 'pending',
      });
      expect(back?.endedAt?.toISOString()).toBe(endedAt.toISOString());
      expect(await agentInstanceIntervalRepository.findOpen(row.id, tx)).toBeNull();
    });
    // …and a new interval may open once the old one is closed.
    await expect(open(f, row.id, new Date())).resolves.toBeTruthy();
  });

  it('correctStart moves a run-opening interval and its run start together — never a rolled one', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    const opened = new Date('2026-09-28T10:00:00.000Z');
    const flyStart = new Date('2026-09-28T10:00:07.000Z');
    const first = await open(f, row.id, opened);
    await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
      expect(await agentInstanceIntervalRepository.correctStart(first.id, flyStart, tx)).toBe(1);
      const back = await agentInstanceIntervalRepository.findById(first.id, tx);
      expect(back?.startedAt.toISOString()).toBe(flyStart.toISOString());
      expect(back?.runStartedAt.toISOString()).toBe(flyStart.toISOString());

      // A roll: close the first, open the next interval of the SAME run.
      await agentInstanceIntervalRepository.close(
        first.id,
        {
          endedAt: new Date('2026-09-28T10:30:07.000Z'),
          endReason: 'rolled',
          billableSeconds: 1800,
        },
        tx,
      );
      const nextId = randomUUID();
      await agentInstanceIntervalRepository.open(
        {
          id: nextId,
          workspaceId: f.workspaceId,
          organizationId: f.organizationId,
          agentInstanceId: row.id,
          runId: first.id,
          runStartedAt: flyStart,
          startedAt: new Date('2026-09-28T10:30:07.000Z'),
          chargeReference: intervalChargeReference(nextId),
        },
        tx,
      );
      expect(await agentInstanceIntervalRepository.correctStart(nextId, opened, tx)).toBe(0);
    });
  });

  it('records a charge once — a replay cannot overwrite it — and the backstop finds only pending ones', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    const a = await open(f, row.id, new Date('2026-09-28T10:00:00.000Z'));
    await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
      // An OPEN interval takes no charge.
      expect(
        await agentInstanceIntervalRepository.recordCharge(
          a.id,
          { outcome: 'charged', credits: 3 },
          tx,
        ),
      ).toBe(0);
      await agentInstanceIntervalRepository.close(
        a.id,
        {
          endedAt: new Date('2026-09-28T10:03:00.000Z'),
          endReason: 'deleted',
          billableSeconds: 180,
        },
        tx,
      );
    });
    const pending = await withSystemContext((tx) =>
      agentInstanceIntervalRepository.listPendingCharges(10, tx),
    );
    expect(pending.map((i) => i.id)).toEqual([a.id]);

    await withWorkspaceServiceContext(f.workspaceId, async (tx) => {
      const at = new Date();
      expect(
        await agentInstanceIntervalRepository.recordCharge(
          a.id,
          { outcome: 'charged', credits: 3, chargedAt: at },
          tx,
        ),
      ).toBe(1);
      expect(
        await agentInstanceIntervalRepository.recordCharge(
          a.id,
          { outcome: 'refused', detail: 'x' },
          tx,
        ),
      ).toBe(0);
      const back = await agentInstanceIntervalRepository.findById(a.id, tx);
      expect(back).toMatchObject({
        chargeOutcome: 'charged',
        credits: 3,
        chargeAttempts: 1,
        chargeDetail: null,
      });
      expect(toAgentInstanceIntervalDto(back!)).toMatchObject({
        credits: 3,
        billableSeconds: 180,
        endReason: 'deleted',
      });
    });
    expect(
      await withSystemContext((tx) => agentInstanceIntervalRepository.listPendingCharges(10, tx)),
    ).toEqual([]);
  });

  it('lists the intervals that overlap a period — open ones and those ended since', async () => {
    const f = await seedFixture();
    const row = await createInstance(f);
    const old = await open(f, row.id, new Date('2026-08-01T00:00:00.000Z'));
    await withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceIntervalRepository.close(
        old.id,
        { endedAt: new Date('2026-08-01T01:00:00.000Z'), endReason: 'idle', billableSeconds: 3600 },
        tx,
      ),
    );
    const current = await open(f, row.id, new Date('2026-09-28T09:00:00.000Z'));
    const since = new Date('2026-09-01T00:00:00.000Z');
    const rows = await withWorkspaceServiceContext(f.workspaceId, (tx) =>
      agentInstanceIntervalRepository.listForInstancesSince([row.id], since, tx),
    );
    expect(rows.map((r) => r.id)).toEqual([current.id]);
    expect(
      await withWorkspaceServiceContext(f.workspaceId, (tx) =>
        agentInstanceIntervalRepository.listForInstancesSince([], since, tx),
      ),
    ).toEqual([]);
  });
});
