import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { platformJobsLedgerService } from '@/lib/services/platformJobsLedgerService';
import { platformJobReplayService } from '@/lib/services/platformJobReplayService';
import { jobsDashboardService } from '@/lib/services/jobsDashboardService';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import {
  DlqEntryNotFoundError,
  PlatformJobsReadForbiddenError,
  SystemReplayForbiddenError,
} from '@/lib/jobs/errors';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { PlatformRole } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// MOTIR-9988 — the assembled platform job ledger seam against the real
// datastore: one seeded ledger driven through read, single replay, bulk replay,
// audit and re-read, so the cross-service claims (a replay changes what the next
// read and count return; each audit row matches the row replayed) are asserted
// where the per-service tests cannot see them. It also pins the shipped tenant
// and system doors beneath the dashboard as unchanged on the same data.
//
// The per-method edge cases live in the sibling tests
// (tests/services/platformJobsLedgerService.test.ts,
// tests/integration/platformJobReplay.test.ts,
// tests/jobs/replayAllDeadLetters.test.ts); this file asserts sequences.

const METER = 'system.platform-meter-report';
const ROLLUP = 'system.usage-rollup';
const INDEX = 'workspace.search-index';
const DIGEST = 'workspace.email-digest';
const NOW = new Date('2026-10-28T12:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let owner: { id: string };
let workspaceA: string;
let workspaceB: string;
const principals = {} as Record<PlatformRole, PlatformPrincipal>;

const ago = (ms: number) => new Date(NOW.getTime() - ms);

function dlq(
  i: number,
  opts: { functionId: string; workspaceId: string | null; at: Date; replayedAt?: Date },
) {
  return {
    workspaceId: opts.workspaceId,
    functionId: opts.functionId,
    eventName: opts.functionId,
    eventData: { n: i, idempotencyKey: `${opts.functionId}-${i}` },
    failure: { message: 'boom' },
    attempts: 5,
    firstFailedAt: opts.at,
    lastFailedAt: opts.at,
    replayedAt: opts.replayedAt ?? null,
  };
}

/** 109 old meter rows (no workspace) under 250 newer rows of two other functions. */
async function seedLedger(): Promise<void> {
  await adminDb.jobRunDlq.createMany({
    data: [
      ...Array.from({ length: 109 }, (_, i) =>
        dlq(i, { functionId: METER, workspaceId: null, at: ago(10 * DAY + i * MIN) }),
      ),
      ...Array.from({ length: 250 }, (_, i) =>
        dlq(i, {
          functionId: i % 2 === 0 ? INDEX : ROLLUP,
          workspaceId: i % 2 === 0 ? (i % 4 === 0 ? workspaceA : workspaceB) : null,
          at: ago(i * MIN),
        }),
      ),
    ],
  });
}

const auditRows = (where: object = {}) =>
  adminDb.platformAuditLog.findMany({ where: { action: 'jobs.dlq_replay', ...where } });

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  for (const role of ['support', 'operator', 'superadmin'] as const) {
    const email = `${role}@motir.test`;
    const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: role });
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
    principals[role] = { userId: user.id, email, role };
  }
  owner = await usersService.createUser({
    email: 'owner@example.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  workspaceA = (await workspacesService.createWorkspace({ name: 'A', ownerUserId: owner.id }))
    .workspace.id;
  workspaceB = (await workspacesService.createWorkspace({ name: 'B', ownerUserId: owner.id }))
    .workspace.id;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  vi.useRealTimers();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('reads', () => {
  it('pages runs of two workspaces and none, filtered by status, without dropping a workspace-less run', async () => {
    const rows = [
      { workspaceId: workspaceA, status: 'succeeded' as const },
      { workspaceId: null, status: 'failed' as const },
      { workspaceId: workspaceB, status: 'failed' as const },
      { workspaceId: null, status: 'succeeded' as const },
      { workspaceId: null, status: 'running' as const },
    ];
    for (const [i, r] of rows.entries()) {
      await adminDb.jobRun.create({
        data: {
          ...r,
          functionId: r.workspaceId ? INDEX : ROLLUP,
          eventName: 'e',
          eventId: `evt-${i}`,
          lane: 'engine',
          attempt: 1,
          startedAt: ago(i * MIN),
        },
      });
    }

    const seen: (string | null)[] = [];
    let offset = 0;
    for (;;) {
      const page = await platformJobsLedgerService.listRuns({
        platformRole: 'support',
        limit: 2,
        offset,
      });
      seen.push(...page.rows.map((r) => r.workspaceId));
      if (!page.hasMore) break;
      offset += 2;
    }
    expect(seen).toEqual([workspaceA, null, workspaceB, null, null]);

    const failed = await platformJobsLedgerService.listRuns({
      platformRole: 'support',
      status: 'failed',
      limit: 10,
      offset: 0,
    });
    expect(failed.rows.map((r) => r.workspaceId)).toEqual([null, workspaceB]);
  });

  it('lists dead letters of both kinds, then the 7-day replayed segment, without the 10-day-old replay', async () => {
    await adminDb.jobRunDlq.createMany({
      data: [
        dlq(0, { functionId: INDEX, workspaceId: workspaceA, at: ago(1 * MIN) }),
        dlq(1, { functionId: METER, workspaceId: null, at: ago(2 * MIN) }),
        dlq(2, {
          functionId: ROLLUP,
          workspaceId: null,
          at: ago(3 * DAY),
          replayedAt: ago(2 * DAY),
        }),
        dlq(3, {
          functionId: DIGEST,
          workspaceId: workspaceB,
          at: ago(11 * DAY),
          replayedAt: ago(10 * DAY),
        }),
      ],
    });

    const list = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'support',
      now: NOW,
    });

    expect(list.rows.map((r) => r.functionId)).toEqual([INDEX, METER, ROLLUP]);
    expect(list.functions.map((f) => f.functionId)).toEqual([METER, INDEX]);
  });

  it('caps the unfiltered list at 200 yet reaches all 109 rows of the chosen function', async () => {
    await seedLedger();

    const all = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'support',
      now: NOW,
    });
    const chosen = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'support',
      functionId: METER,
      now: NOW,
    });

    expect(all.rows).toHaveLength(200);
    expect(all.functions).toContainEqual({ functionId: METER, unreplayed: 109 });
    expect(all.unreplayedTotal).toBe(359);
    expect(chosen.rows).toHaveLength(109);
  });
});

describe('role refusals at every entrypoint', () => {
  it('reads refuse a null role; replays refuse support before any write; operator and superadmin pass', async () => {
    const dlqId = (
      await adminDb.jobRunDlq.create({
        data: dlq(0, { functionId: METER, workspaceId: null, at: ago(MIN) }),
      })
    ).id;

    await expect(
      platformJobsLedgerService.listRuns({ platformRole: null, limit: 1, offset: 0 }),
    ).rejects.toBeInstanceOf(PlatformJobsReadForbiddenError);
    await expect(
      platformJobsLedgerService.listDeadLetters({ platformRole: null }),
    ).rejects.toBeInstanceOf(PlatformJobsReadForbiddenError);
    for (const role of ['support', 'operator', 'superadmin'] as const) {
      await expect(
        platformJobsLedgerService.listDeadLetters({ platformRole: role }),
      ).resolves.toBeDefined();
      await expect(
        platformJobReplayService.countUnreplayedDeadLetters({
          functionId: METER,
          principal: principals[role],
        }),
      ).resolves.toBe(1);
    }

    await expect(
      platformJobReplayService.replayOne({ dlqId, principal: principals.support }),
    ).rejects.toBeInstanceOf(SystemReplayForbiddenError);
    await expect(
      platformJobReplayService.replayAllDeadLettersForFunction({
        functionId: METER,
        principal: principals.support,
      }),
    ).rejects.toBeInstanceOf(SystemReplayForbiddenError);
    expect(
      (await adminDb.jobRunDlq.findUniqueOrThrow({ where: { id: dlqId } })).replayedAt,
    ).toBeNull();
    expect(await auditRows()).toHaveLength(0);

    for (const role of ['operator', 'superadmin'] as const) {
      await expect(
        platformJobReplayService.replayAllDeadLettersForFunction({
          functionId: METER,
          principal: principals[role],
        }),
      ).resolves.toBeDefined();
    }
  });
});

describe('single replay', () => {
  it('replays a workspace-less row and a workspace row, each with one matching audit row', async () => {
    const [bare, owned] = await Promise.all([
      adminDb.jobRunDlq.create({
        data: dlq(0, { functionId: METER, workspaceId: null, at: ago(MIN) }),
      }),
      adminDb.jobRunDlq.create({
        data: dlq(1, { functionId: INDEX, workspaceId: workspaceA, at: ago(MIN) }),
      }),
    ]);

    for (const row of [bare, owned]) {
      const result = await platformJobReplayService.replayOne({
        dlqId: row.id,
        principal: principals.operator,
      });
      expect(result.outcome).toBe('replayed');
      const event = await adminDb.jobEvent.findFirstOrThrow({ where: { name: row.eventName } });
      expect(event.idempotencyKey).toBe(
        `${row.functionId}-${row.functionId === METER ? 0 : 1}:replay:${row.id}`,
      );
      const [audit] = await auditRows({ targetId: row.id });
      expect(audit).toMatchObject({
        actorUserId: principals.operator.userId,
        targetLabel: row.functionId,
        metadata: {
          dlqId: row.id,
          functionId: row.functionId,
          eventName: row.eventName,
          hasWorkspace: row.workspaceId !== null,
          workspaceId: row.workspaceId,
        },
      });
    }
  });

  it('an unknown id writes no audit row; a second replay is already-replayed and writes none', async () => {
    const row = await adminDb.jobRunDlq.create({
      data: dlq(0, { functionId: METER, workspaceId: null, at: ago(MIN) }),
    });
    await expect(
      platformJobReplayService.replayOne({ dlqId: 'missing', principal: principals.operator }),
    ).rejects.toBeInstanceOf(DlqEntryNotFoundError);

    const first = await platformJobReplayService.replayOne({
      dlqId: row.id,
      principal: principals.operator,
    });
    const second = await platformJobReplayService.replayOne({
      dlqId: row.id,
      principal: principals.operator,
    });

    expect(second.outcome).toBe('already-replayed');
    expect(second.entry.replayedAt).toBe(first.entry.replayedAt);
    expect(await adminDb.jobEvent.count()).toBe(1);
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('Replay all, then re-read', () => {
  it('replays all 109 in three batches, audits each, and the next read reflects it', async () => {
    await seedLedger();
    const before = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'support',
      now: NOW,
    });
    const count = await platformJobReplayService.countUnreplayedDeadLetters({
      functionId: METER,
      principal: principals.operator,
    });

    const result = await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId: METER,
      principal: principals.operator,
    });

    expect(count).toBe(109);
    expect(result).toEqual({ functionId: METER, replayed: 109, alreadyReplayed: 0, failed: [] });
    const audits = await auditRows();
    expect(new Set(audits.map((a) => a.targetId)).size).toBe(109);
    expect(audits.every((a) => a.targetLabel === METER)).toBe(true);
    expect(
      await adminDb.jobRunDlq.count({
        where: { functionId: { not: METER }, replayedAt: { not: null } },
      }),
    ).toBe(0);

    const after = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'support',
      now: NOW,
    });
    expect(after.functions.map((f) => f.functionId)).not.toContain(METER);
    expect(after.unreplayedTotal).toBe(before.unreplayedTotal - 109);
    expect(after.replayedRecently).toBe(109);
    const chosen = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'support',
      functionId: METER,
      now: NOW,
    });
    expect(chosen.rows).toHaveLength(109);
    expect(chosen.rows.every((r) => r.replayedAt !== null)).toBe(true);

    const rerun = await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId: METER,
      principal: principals.operator,
    });
    expect(rerun).toEqual({ functionId: METER, replayed: 0, alreadyReplayed: 0, failed: [] });
    expect(await auditRows()).toHaveLength(109);
  });

  it('counts a row replayed mid-run as already replayed, with a single audit row', async () => {
    await adminDb.jobRunDlq.createMany({
      data: Array.from({ length: 3 }, (_, i) =>
        dlq(i, { functionId: METER, workspaceId: null, at: ago((i + 1) * MIN) }),
      ),
    });
    const oldest = (await adminDb.jobRunDlq.findMany({ orderBy: { lastFailedAt: 'asc' } }))[0]!.id;
    const real = platformJobReplayService.replayOne.bind(platformJobReplayService);
    let raced = false;
    vi.spyOn(platformJobReplayService, 'replayOne').mockImplementation(async (input) => {
      if (!raced) {
        raced = true;
        await real({ dlqId: oldest, principal: principals.superadmin });
      }
      return real(input);
    });

    const result = await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId: METER,
      principal: principals.operator,
    });

    expect(result).toMatchObject({ replayed: 2, alreadyReplayed: 1, failed: [] });
    expect(await auditRows({ targetId: oldest })).toHaveLength(1);
  });

  it('isolates a row whose enqueue throws: neighbours replayed and audited, it stays unreplayed and is read once', async () => {
    await adminDb.jobRunDlq.createMany({
      data: Array.from({ length: 60 }, (_, i) =>
        dlq(i, { functionId: METER, workspaceId: null, at: ago((i + 1) * MIN) }),
      ),
    });
    const broken = (await adminDb.jobRunDlq.findMany({ orderBy: { lastFailedAt: 'desc' } }))[10]!
      .id;
    const realCreate = jobEventRepository.create.bind(jobEventRepository);
    let attempts = 0;
    vi.spyOn(jobEventRepository, 'create').mockImplementation(async (data, tx) => {
      if (
        typeof data.idempotencyKey === 'string' &&
        data.idempotencyKey.endsWith(`:replay:${broken}`)
      ) {
        attempts += 1;
        throw new Error('enqueue failed');
      }
      return realCreate(data, tx);
    });

    const result = await platformJobReplayService.replayAllDeadLettersForFunction({
      functionId: METER,
      principal: principals.operator,
    });

    expect(result).toEqual({
      functionId: METER,
      replayed: 59,
      alreadyReplayed: 0,
      failed: [broken],
    });
    expect(attempts).toBe(1);
    expect(
      (await adminDb.jobRunDlq.findUniqueOrThrow({ where: { id: broken } })).replayedAt,
    ).toBeNull();
    expect(await auditRows()).toHaveLength(59);
    expect(await auditRows({ targetId: broken })).toHaveLength(0);
  });
});

describe('the kept runs read is unchanged on the same ledger', () => {
  // The tenant dashboard's dead-letter list and its two replay doors were
  // deleted with that dashboard (Story MOTIR-9982 · MOTIR-10044); the one read
  // of `jobsDashboardService` left is the runs read this ledger pages through.
  it('listSystemRuns reads the same ledger and writes no audit row', async () => {
    await seedLedger();

    await expect(jobsDashboardService.listSystemRuns({ limit: 5, offset: 0 })).resolves.toEqual([]);

    expect(await auditRows()).toHaveLength(0);
  });
});
