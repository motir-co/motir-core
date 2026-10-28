import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  platformJobReplayService,
  DLQ_REPLAY_AUDIT_REASON,
} from '@/lib/services/platformJobReplayService';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import { DlqEntryNotFoundError, SystemReplayForbiddenError } from '@/lib/jobs/errors';
import type { PlatformPrincipal } from '@/lib/platform/auth';
// Side-effect import: `email.send` declares an idempotency template, so its
// replay has a dedup key and the already-replayed case tests the real dedup.
import '@/lib/jobs/definitions/emailSend';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// MOTIR-9985 — the platform job ledger's replay door: an `operator` replays one
// dead letter, a workspace's or a workspace-less one, under `withSystemContext`,
// and a `replayed` outcome writes one `jobs.dlq_replay` platform audit row AFTER
// the replay commits (the two contexts bind different GUCs and never nest).

const METER = 'system.platform-meter-report';

let operator: PlatformPrincipal;
let support: PlatformPrincipal;
let workspaceId: string;

async function seedDlq(opts: {
  workspaceId: string | null;
  functionId?: string;
  eventData?: object;
}): Promise<string> {
  const functionId = opts.functionId ?? METER;
  const row = await adminDb.jobRunDlq.create({
    data: {
      workspaceId: opts.workspaceId,
      functionId,
      eventName: functionId,
      eventData: opts.eventData ?? { containerId: 'c-1', idempotencyKey: 'meter-key-1' },
      failure: { message: 'MOTIR_AI_UNAVAILABLE' },
      attempts: 5,
    },
  });
  return row.id;
}

const replayRows = () =>
  adminDb.platformAuditLog.findMany({ where: { action: 'jobs.dlq_replay' } });

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
  const created = await workspacesService.createWorkspace({
    name: 'Tenant Workspace',
    ownerUserId: owner.id,
  });
  workspaceId = created.workspace.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformJobReplayService.replayOne', () => {
  it('replays a workspace-less row: re-emitted with the :replay:<dlqId> key, stamped, and audited', async () => {
    const dlqId = await seedDlq({ workspaceId: null });

    const result = await platformJobReplayService.replayOne({ dlqId, principal: operator });

    expect(result.outcome).toBe('replayed');
    const events = await adminDb.jobEvent.findMany({ where: { name: METER } });
    expect(events).toHaveLength(1);
    expect(events[0]!.idempotencyKey).toBe(`meter-key-1:replay:${dlqId}`);
    expect(
      (await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } }))!.replayedAt,
    ).not.toBeNull();

    const rows = await replayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: operator.userId,
      actorRole: 'operator',
      targetKind: 'platform',
      targetId: dlqId,
      targetLabel: METER,
      reason: DLQ_REPLAY_AUDIT_REASON,
      metadata: {
        dlqId,
        functionId: METER,
        eventName: METER,
        hasWorkspace: false,
        workspaceId: null,
      },
    });
  });

  it('replays a row that BELONGS to a workspace — the one thing the system door refuses', async () => {
    const dlqId = await seedDlq({ workspaceId, functionId: 'workspace.search-index' });

    const result = await platformJobReplayService.replayOne({ dlqId, principal: operator });

    expect(result.outcome).toBe('replayed');
    expect(
      (await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } }))!.replayedAt,
    ).not.toBeNull();
    const rows = await replayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ hasWorkspace: true, workspaceId });
  });

  it('a superadmin replays too — the ladder contains operator', async () => {
    const dlqId = await seedDlq({ workspaceId: null });
    await adminDb.user.update({
      where: { id: operator.userId },
      data: { platformRole: 'superadmin' },
    });

    const result = await platformJobReplayService.replayOne({
      dlqId,
      principal: { ...operator, role: 'superadmin' },
    });

    expect(result.outcome).toBe('replayed');
    expect(await replayRows()).toHaveLength(1);
  });

  it('refuses support before any transaction: nothing replayed, nothing audited, whether the id exists or not', async () => {
    const dlqId = await seedDlq({ workspaceId: null });

    await expect(
      platformJobReplayService.replayOne({ dlqId, principal: support }),
    ).rejects.toBeInstanceOf(SystemReplayForbiddenError);
    await expect(
      platformJobReplayService.replayOne({ dlqId: 'does-not-exist', principal: support }),
    ).rejects.toBeInstanceOf(SystemReplayForbiddenError);

    expect((await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } }))!.replayedAt).toBeNull();
    expect(await adminDb.jobEvent.count()).toBe(0);
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('stamps replayedAt only when the event was actually published', async () => {
    // The ordering lib/jobs/dlq.ts promises, held through THIS door (moved here
    // from the retired System tab door's suite, MOTIR-10044): if the re-emit
    // throws, the system transaction rolls back and the row is still
    // un-replayed, so "replayed" never records a send that did not happen.
    const dlqId = await seedDlq({ workspaceId: null });
    vi.spyOn(jobEventRepository, 'create').mockRejectedValueOnce(new Error('publish failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      platformJobReplayService.replayOne({ dlqId, principal: operator }),
    ).rejects.toThrow('publish failed');

    expect((await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } }))!.replayedAt).toBeNull();
    expect(await adminDb.jobEvent.count()).toBe(0);
    expect(await replayRows()).toHaveLength(0);
  });

  it('answers not-found for an unknown id and writes no audit row', async () => {
    await expect(
      platformJobReplayService.replayOne({ dlqId: 'does-not-exist', principal: operator }),
    ).rejects.toBeInstanceOf(DlqEntryNotFoundError);
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('a second replay answers already-replayed: nothing enqueued, the stamp kept, no second audit row', async () => {
    const dlqId = await seedDlq({
      workspaceId: null,
      functionId: 'email.send',
      eventData: { to: 'reset@example.com', template: 'password-reset', idempotencyKey: 'pw-1' },
    });

    const first = await platformJobReplayService.replayOne({ dlqId, principal: operator });
    const second = await platformJobReplayService.replayOne({ dlqId, principal: operator });

    expect(first.outcome).toBe('replayed');
    expect(second.outcome).toBe('already-replayed');
    expect(second.entry.replayedAt).toBe(first.entry.replayedAt);
    expect(await adminDb.jobEvent.count({ where: { name: 'email.send' } })).toBe(1);
    expect(await replayRows()).toHaveLength(1);
  });

  it('a row already stamped answers already-replayed even for a job with no idempotency template', async () => {
    // The meter report declares no template, so the re-emit's dedup has no key to
    // collide on; the stamp is what stops a raced row being sent twice.
    const dlqId = await seedDlq({ workspaceId: null });
    const stampedAt = new Date('2026-10-27T10:00:00Z');
    await adminDb.jobRunDlq.update({ where: { id: dlqId }, data: { replayedAt: stampedAt } });

    const result = await platformJobReplayService.replayOne({ dlqId, principal: operator });

    expect(result.outcome).toBe('already-replayed');
    expect(result.entry.replayedAt).toBe(stampedAt.toISOString());
    expect(await adminDb.jobEvent.count()).toBe(0);
    expect(await replayRows()).toHaveLength(0);
  });

  it('writes the [jobs.replay] warn line with door: platform', async () => {
    const dlqId = await seedDlq({ workspaceId });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await platformJobReplayService.replayOne({ dlqId, principal: operator });

    const line = warn.mock.calls.find(([tag]) => tag === '[jobs.replay]');
    expect(JSON.parse(line![1] as string)).toMatchObject({
      dlqId,
      workspaceId,
      actorUserId: operator.userId,
      door: 'platform',
      outcome: 'replayed',
    });
  });

  it('a failed audit write after a committed replay: the replay stands and the error reaches the caller', async () => {
    const dlqId = await seedDlq({ workspaceId: null });
    vi.spyOn(platformAuditService, 'record').mockRejectedValueOnce(new Error('audit down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      platformJobReplayService.replayOne({ dlqId, principal: operator }),
    ).rejects.toThrow('audit down');

    expect(
      (await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } }))!.replayedAt,
    ).not.toBeNull();
    expect(await replayRows()).toHaveLength(0);
  });
});
