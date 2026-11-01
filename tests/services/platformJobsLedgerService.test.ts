import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  platformJobsLedgerService,
  PLATFORM_DLQ_LIST_CAP,
} from '@/lib/services/platformJobsLedgerService';
import { PlatformJobsReadForbiddenError } from '@/lib/jobs/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// MOTIR-9984 — the READ half of the platform job ledger at /admin/jobs.
//
// Both reads run under `withSystemContext`, which bypasses tenant RLS, so the
// service's own role check is the whole gate, and a workspace's rows sit in the
// same list as the workspace-less ones. The dead-letter cap is per SELECTION:
// choosing a function reaches its rows however old they are next to every other
// function's (the 200-newest defect, MOTIR-9957), and the counts are true counts.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-28T12:00:00Z');
const METER = 'system.platform-meter-report';

let workspaceId: string;

async function seedRun(opts: {
  workspaceId: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'abandoned';
  startedAt: Date;
}) {
  return adminDb.jobRun.create({
    data: {
      workspaceId: opts.workspaceId,
      functionId: opts.workspaceId ? 'workspace.search-index' : 'system.usage-rollup',
      eventName: 'test/event',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      lane: 'engine',
      attempt: 1,
      status: opts.status,
      startedAt: opts.startedAt,
    },
  });
}

function dlqRow(opts: {
  workspaceId: string | null;
  functionId: string;
  lastFailedAt: Date;
  replayedAt?: Date | null;
}) {
  return {
    workspaceId: opts.workspaceId,
    functionId: opts.functionId,
    eventName: opts.functionId,
    eventData: {},
    failure: { message: 'boom' },
    attempts: 5,
    firstFailedAt: opts.lastFailedAt,
    lastFailedAt: opts.lastFailedAt,
    replayedAt: opts.replayedAt ?? null,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  const owner = await usersService.createUser({
    email: 'ledger-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Ledger Owner',
  });
  const created = await workspacesService.createWorkspace({
    name: 'Ledger Workspace',
    ownerUserId: owner.id,
  });
  workspaceId = created.workspace.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the role gate', () => {
  it('refuses a caller with no platform role on both reads', async () => {
    await expect(
      platformJobsLedgerService.listRuns({ platformRole: null, limit: 10, offset: 0 }),
    ).rejects.toBeInstanceOf(PlatformJobsReadForbiddenError);
    await expect(
      platformJobsLedgerService.listDeadLetters({ platformRole: null }),
    ).rejects.toBeInstanceOf(PlatformJobsReadForbiddenError);
  });

  it.each(['support', 'operator', 'superadmin'] as const)('accepts %s', async (platformRole) => {
    await expect(
      platformJobsLedgerService.listRuns({ platformRole, limit: 10, offset: 0 }),
    ).resolves.toEqual({ rows: [], hasMore: false });
    await expect(platformJobsLedgerService.listDeadLetters({ platformRole })).resolves.toEqual({
      rows: [],
      functions: [],
      unreplayedTotal: 0,
      replayedRecently: 0,
    });
  });
});

describe('listRuns', () => {
  it('lists workspace and workspace-less runs together, filters by status and pages with hasMore', async () => {
    await seedRun({ workspaceId, status: 'succeeded', startedAt: new Date(NOW.getTime() - 1000) });
    await seedRun({
      workspaceId: null,
      status: 'failed',
      startedAt: new Date(NOW.getTime() - 2000),
    });
    await seedRun({
      workspaceId: null,
      status: 'succeeded',
      startedAt: new Date(NOW.getTime() - 3000),
    });

    const all = await platformJobsLedgerService.listRuns({
      platformRole: 'support',
      limit: 10,
      offset: 0,
    });
    expect(all.hasMore).toBe(false);
    expect(all.rows.map((r) => r.workspaceId)).toEqual([workspaceId, null, null]);

    const failed = await platformJobsLedgerService.listRuns({
      platformRole: 'support',
      status: 'failed',
      limit: 10,
      offset: 0,
    });
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]!.workspaceId).toBeNull();

    const page1 = await platformJobsLedgerService.listRuns({
      platformRole: 'support',
      limit: 2,
      offset: 0,
    });
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await platformJobsLedgerService.listRuns({
      platformRole: 'support',
      limit: 2,
      offset: 2,
    });
    expect(page2.rows).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });
});

describe('listDeadLetters', () => {
  it('lists workspace and workspace-less rows, unreplayed newest first, then those replayed within 7 days', async () => {
    await adminDb.jobRunDlq.createMany({
      data: [
        dlqRow({
          workspaceId,
          functionId: 'workspace.search-index',
          lastFailedAt: new Date(NOW.getTime() - 1 * DAY_MS),
        }),
        dlqRow({
          workspaceId: null,
          functionId: METER,
          lastFailedAt: new Date(NOW.getTime() - 2 * DAY_MS),
        }),
        dlqRow({
          workspaceId: null,
          functionId: 'system.usage-rollup',
          lastFailedAt: new Date(NOW.getTime() - 3 * DAY_MS),
          replayedAt: new Date(NOW.getTime() - 2 * DAY_MS),
        }),
        dlqRow({
          workspaceId,
          functionId: 'workspace.email-digest',
          lastFailedAt: new Date(NOW.getTime() - 11 * DAY_MS),
          replayedAt: new Date(NOW.getTime() - 10 * DAY_MS),
        }),
      ],
    });

    const list = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'support',
      now: NOW,
    });

    expect(list.rows.map((r) => [r.functionId, r.workspaceId, r.replayedAt !== null])).toEqual([
      ['workspace.search-index', workspaceId, false],
      [METER, null, false],
      ['system.usage-rollup', null, true],
    ]);
    expect(list.unreplayedTotal).toBe(2);
    expect(list.replayedRecently).toBe(1);
    // A function whose every row is replayed is absent from the filter's options.
    expect(list.functions).toEqual([
      { functionId: METER, unreplayed: 1 },
      { functionId: 'workspace.search-index', unreplayed: 1 },
    ]);
  });

  it('caps per selection: a chosen function reaches all of its rows older than the newest 200 overall', async () => {
    const older = Array.from({ length: 109 }, (_, i) =>
      dlqRow({
        workspaceId: null,
        functionId: METER,
        lastFailedAt: new Date(NOW.getTime() - (10 + i) * DAY_MS),
      }),
    );
    const newer = Array.from({ length: 250 }, (_, i) =>
      dlqRow({
        workspaceId: i % 2 === 0 ? workspaceId : null,
        functionId: i % 2 === 0 ? 'workspace.search-index' : 'system.usage-rollup',
        lastFailedAt: new Date(NOW.getTime() - i * 60_000),
      }),
    );
    await adminDb.jobRunDlq.createMany({ data: [...older, ...newer] });

    const all = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'operator',
      now: NOW,
    });
    expect(all.rows).toHaveLength(PLATFORM_DLQ_LIST_CAP);
    expect(all.rows.some((r) => r.functionId === METER)).toBe(false);
    expect(all.unreplayedTotal).toBe(359);
    expect(all.functions).toEqual([
      { functionId: 'system.usage-rollup', unreplayed: 125 },
      { functionId: 'workspace.search-index', unreplayed: 125 },
      { functionId: METER, unreplayed: 109 },
    ]);

    const chosen = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'operator',
      functionId: METER,
      now: NOW,
    });
    expect(chosen.rows).toHaveLength(109);
    expect(chosen.rows.every((r) => r.functionId === METER)).toBe(true);
    // The totals stay the whole ledger's, so the filter's counts do not change with the selection.
    expect(chosen.unreplayedTotal).toBe(359);
    expect(chosen.functions).toEqual(all.functions);
  });

  it('narrows the replayed half to the chosen function too', async () => {
    await adminDb.jobRunDlq.createMany({
      data: [
        dlqRow({
          workspaceId: null,
          functionId: METER,
          lastFailedAt: new Date(NOW.getTime() - DAY_MS),
          replayedAt: new Date(NOW.getTime() - DAY_MS),
        }),
        dlqRow({
          workspaceId,
          functionId: 'workspace.search-index',
          lastFailedAt: new Date(NOW.getTime() - DAY_MS),
          replayedAt: new Date(NOW.getTime() - DAY_MS),
        }),
      ],
    });

    const chosen = await platformJobsLedgerService.listDeadLetters({
      platformRole: 'support',
      functionId: METER,
      now: NOW,
    });
    expect(chosen.rows.map((r) => r.functionId)).toEqual([METER]);
    expect(chosen.replayedRecently).toBe(1);
  });
});
