import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  platformJobReplayService,
  REPLAY_ALL_BATCH_SIZE,
} from '@/lib/services/platformJobReplayService';
import { PlatformJobsReadForbiddenError, SystemReplayForbiddenError } from '@/lib/jobs/errors';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// MOTIR-9986 — Replay all for ONE function: keyset batches of
// REPLAY_ALL_BATCH_SIZE, one `replayOne` (one transaction, one audit row) per
// row, a throwing row counted in `failed` without touching its neighbours, and a
// raced row counted already-replayed.

const METER = 'system.platform-meter-report';
const OTHER = 'system.usage-rollup';
const NOW = Date.parse('2026-10-28T12:00:00Z');
const MIN = 60_000;

let operator: PlatformPrincipal;
let support: PlatformPrincipal;
let workspaceId: string;

function dlqRow(
  i: number,
  opts: { functionId?: string; workspaceId?: string | null; minutesAgo: number },
) {
  const functionId = opts.functionId ?? METER;
  const at = new Date(NOW - opts.minutesAgo * MIN);
  return {
    workspaceId: opts.workspaceId ?? null,
    functionId,
    eventName: functionId,
    eventData: { containerId: `c-${i}`, idempotencyKey: `key-${functionId}-${i}` },
    failure: { message: 'boom' },
    attempts: 5,
    firstFailedAt: at,
    lastFailedAt: at,
  };
}

const replayAuditCount = () =>
  adminDb.platformAuditLog.count({ where: { action: 'jobs.dlq_replay' } });

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  const op = await usersService.createUser({
    email: 'operator@motir.test',
    password: 'hunter2hunter2',
    name: 'Platform Operator',
  });
  const sup = await usersService.createUser({
    email: 'support@motir.test',
    password: 'hunter2hunter2',
    name: 'Platform Support',
  });
  await adminDb.user.update({ where: { id: op.id }, data: { platformRole: 'operator' } });
  await adminDb.user.update({ where: { id: sup.id }, data: { platformRole: 'support' } });
  operator = { userId: op.id, email: 'operator@motir.test', role: 'operator' };
  support = { userId: sup.id, email: 'support@motir.test', role: 'support' };
  const owner = await usersService.createUser({
    email: 'tenant-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Tenant Owner',
  });
  workspaceId = (await workspacesService.createWorkspace({ name: 'Tenant', ownerUserId: owner.id }))
    .workspace.id;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('replayAllDeadLettersForFunction', () => {
  it('refuses support before any read: nothing replayed, nothing audited', async () => {
    await adminDb.jobRunDlq.createMany({ data: [dlqRow(0, { minutesAgo: 1 })] });
    const replayOne = vi.spyOn(platformJobReplayService, 'replayOne');

    await expect(
      platformJobReplayService.replayAllDeadLettersForFunction({
        functionId: METER,
        principal: support,
      }),
    ).rejects.toBeInstanceOf(SystemReplayForbiddenError);

    expect(replayOne).not.toHaveBeenCalled();
    expect(await adminDb.jobRunDlq.count({ where: { replayedAt: { not: null } } })).toBe(0);
    expect(await replayAuditCount()).toBe(0);
  });

  it('replays all 120 rows of one function across batches, workspace rows too, older than the newest 200 overall', async () => {
    expect(REPLAY_ALL_BATCH_SIZE).toBe(50);
    await adminDb.jobRunDlq.createMany({
      data: [
        ...Array.from({ length: 120 }, (_, i) =>
          dlqRow(i, { workspaceId: i % 3 === 0 ? workspaceId : null, minutesAgo: 1000 + i }),
        ),
        ...Array.from({ length: 210 }, (_, i) => dlqRow(i, { functionId: OTHER, minutesAgo: i })),
      ],
    });

    const count = await platformJobReplayService.countUnreplayedDeadLetters({
      functionId: METER,
      principal: support,
    });
    const result = await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId: METER,
      principal: operator,
    });

    expect(count).toBe(120);
    expect(result).toEqual({ functionId: METER, replayed: 120, alreadyReplayed: 0, failed: [] });
    expect(await adminDb.jobRunDlq.count({ where: { functionId: METER, replayedAt: null } })).toBe(
      0,
    );
    expect(
      await adminDb.jobRunDlq.count({ where: { functionId: OTHER, replayedAt: { not: null } } }),
    ).toBe(0);
    expect(await replayAuditCount()).toBe(120);

    const sample = await adminDb.jobRunDlq.findFirstOrThrow({
      where: { functionId: METER, workspaceId },
    });
    const event = await adminDb.jobEvent.findFirstOrThrow({
      where: { idempotencyKey: { endsWith: `:replay:${sample.id}` } },
    });
    expect(event.workspaceId).toBe(workspaceId);
  });

  it('a second run replays nothing and writes no audit rows', async () => {
    await adminDb.jobRunDlq.createMany({
      data: [dlqRow(0, { minutesAgo: 1 }), dlqRow(1, { minutesAgo: 2 })],
    });
    await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId: METER,
      principal: operator,
    });

    const again = await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId: METER,
      principal: operator,
    });

    expect(again).toEqual({ functionId: METER, replayed: 0, alreadyReplayed: 0, failed: [] });
    expect(await replayAuditCount()).toBe(2);
  });

  it('counts a row replayed between enumeration and its turn as already replayed, with a single audit row', async () => {
    await adminDb.jobRunDlq.createMany({
      data: [
        dlqRow(0, { minutesAgo: 1 }),
        dlqRow(1, { minutesAgo: 2 }),
        dlqRow(2, { minutesAgo: 3 }),
      ],
    });
    const raced = (await adminDb.jobRunDlq.findMany({ orderBy: { lastFailedAt: 'asc' } }))[0]!.id;
    const real = platformJobReplayService.replayOne.bind(platformJobReplayService);
    let first = true;
    vi.spyOn(platformJobReplayService, 'replayOne').mockImplementation(async (input) => {
      if (first) {
        // Someone else replays the oldest row while this run is on the newest.
        first = false;
        await real({ dlqId: raced, principal: operator });
      }
      return real(input);
    });

    const result = await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId: METER,
      principal: operator,
    });

    expect(result).toEqual({ functionId: METER, replayed: 2, alreadyReplayed: 1, failed: [] });
    expect(
      await adminDb.platformAuditLog.count({
        where: { action: 'jobs.dlq_replay', targetId: raced },
      }),
    ).toBe(1);
  });

  it('a row that throws is reported in failed, stays unreplayed, is not read again, and its neighbours are replayed', async () => {
    await adminDb.jobRunDlq.createMany({
      data: Array.from({ length: REPLAY_ALL_BATCH_SIZE + 5 }, (_, i) =>
        dlqRow(i, { minutesAgo: i + 1 }),
      ),
    });
    const ordered = await adminDb.jobRunDlq.findMany({
      orderBy: [{ lastFailedAt: 'desc' }, { id: 'desc' }],
    });
    const broken = ordered[3]!.id;
    const real = platformJobReplayService.replayOne.bind(platformJobReplayService);
    const seen: string[] = [];
    vi.spyOn(platformJobReplayService, 'replayOne').mockImplementation(async (input) => {
      seen.push(input.dlqId);
      if (input.dlqId === broken) throw new Error('publish failed');
      return real(input);
    });

    const result = await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId: METER,
      principal: operator,
    });

    expect(result).toEqual({
      functionId: METER,
      replayed: REPLAY_ALL_BATCH_SIZE + 4,
      alreadyReplayed: 0,
      failed: [broken],
    });
    expect(seen.filter((id) => id === broken)).toHaveLength(1);
    expect(seen).toHaveLength(REPLAY_ALL_BATCH_SIZE + 5);
    expect(
      (await adminDb.jobRunDlq.findUniqueOrThrow({ where: { id: broken } })).replayedAt,
    ).toBeNull();
    expect(await replayAuditCount()).toBe(REPLAY_ALL_BATCH_SIZE + 4);
  });

  it('a function with nothing waiting returns zero counts', async () => {
    await expect(
      platformJobReplayService.replayAllDeadLettersForFunction({
        functionId: METER,
        principal: operator,
      }),
    ).resolves.toEqual({ functionId: METER, replayed: 0, alreadyReplayed: 0, failed: [] });
  });
});

describe('countUnreplayedDeadLetters', () => {
  it('counts one function only, workspace rows included, and refuses a principal below support', async () => {
    await adminDb.jobRunDlq.createMany({
      data: [
        dlqRow(0, { minutesAgo: 1 }),
        dlqRow(1, { minutesAgo: 2, workspaceId: 'placeholder' }),
        dlqRow(2, { functionId: OTHER, minutesAgo: 3 }),
      ].map((r) => (r.workspaceId === 'placeholder' ? { ...r, workspaceId } : r)),
    });

    await expect(
      platformJobReplayService.countUnreplayedDeadLetters({
        functionId: METER,
        principal: operator,
      }),
    ).resolves.toBe(2);
    await expect(
      platformJobReplayService.countUnreplayedDeadLetters({
        functionId: METER,
        // A principal is only ever minted for staff; a null role is the shape a
        // tenant session would carry if one were forged.
        principal: { ...support, role: null as never },
      }),
    ).rejects.toBeInstanceOf(PlatformJobsReadForbiddenError);
  });
});
