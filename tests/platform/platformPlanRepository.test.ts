import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { platformPlanRepository } from '@/lib/repositories/platformPlanRepository';
import { plannerFindingRecordsService } from '@/lib/services/plannerFindingsService';
import { createTestUser } from '../fixtures/userFixtures';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The `plan` table's `platform_staff` READ arm and the one repository that reads
 * through it (Story MOTIR-11455 · MOTIR-11458).
 *
 * Tested from the side that can fail: an arm that is missing raises nothing —
 * the read returns null and the plan reads as gone — so the catalog is read
 * back, and the read runs under `motir_app` (`@/lib/db`, the non-bypass role) as
 * an operator who belongs to NO workspace at all.
 *
 * The `work_item` arm (MOTIR-11504) and `findWorkItemByIdentifier` are proved
 * here too, beside the plan arm: the record-level link routes that first used
 * them are gone (MOTIR-11587), and a finding's own planning-bug key resolves
 * through the same arm and lookup.
 */

let operator: PlatformPrincipal;

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  const user = await createTestUser({ email: 'ops+plan-arm@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'operator' } });
  operator = { userId: user.id, email: user.email, role: 'operator' };
});

afterAll(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the `plan` platform_staff arm', () => {
  it('is ONE permissive SELECT arm bound to `app.platform_staff` alone', async () => {
    const rows = await adminDb.$queryRaw<
      {
        policyname: string;
        cmd: string;
        permissive: string;
        qual: string;
        with_check: string | null;
      }[]
    >`
      SELECT "policyname", "cmd", "permissive", "qual", "with_check"
      FROM pg_policies
      WHERE "tablename" = 'plan'
        AND ("qual" LIKE '%app.platform_staff%' OR "with_check" LIKE '%app.platform_staff%')
    `;
    expect(rows).toHaveLength(1);
    const [arm] = rows;
    expect(arm).toMatchObject({
      policyname: 'plan_platform_staff_read',
      cmd: 'SELECT',
      permissive: 'PERMISSIVE',
      with_check: null,
    });
    expect(arm!.qual).not.toContain('app.workspace_id');
    expect(arm!.qual).not.toContain('app.system_admin');
  });
});

describe('platformPlanRepository.findRecordContext', () => {
  it("reads another tenant's plan inside a platform read, with its org and project key", async () => {
    const fx = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const plan = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'planned',
        title: 'A plan',
        sourceJobId: 'job_1',
        authorModel: 'claude-opus-5-5',
      },
    });

    const read = await withPlatformRead(
      operator,
      { action: 'estate.read', targetKind: 'platform', targetId: plan.id },
      (tx) => platformPlanRepository.findRecordContext(plan.id, tx),
    );
    expect(read).toEqual({
      id: plan.id,
      title: 'A plan',
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: null,
      sourceJobId: 'job_1',
      authorModel: 'claude-opus-5-5',
      workspace: { organizationId: fx.workspace.organizationId },
      project: { identifier: 'ELSE' },
    });
    expect(await adminDb.platformAuditLog.count({ where: { action: 'estate.read' } })).toBe(1);
  });

  it('sees nothing outside a platform read — the arm is the platform context only', async () => {
    const fx = await makeWorkItemFixture({ name: 'Hidden', identifier: 'HIDE' });
    const plan = await adminDb.plan.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, status: 'planned' },
    });
    const outside = await db.$transaction((tx) =>
      platformPlanRepository.findRecordContext(plan.id, tx),
    );
    expect(outside).toBeNull();
  });

  it('answers null for an unknown plan', async () => {
    const read = await withPlatformRead(
      operator,
      { action: 'estate.read', targetKind: 'platform', targetId: 'nope' },
      (tx) => platformPlanRepository.findRecordContext('nope', tx),
    );
    expect(read).toBeNull();
  });
});

describe('the `work_item` platform_staff arm', () => {
  it('is ONE permissive SELECT arm bound to `app.platform_staff` alone', async () => {
    const rows = await adminDb.$queryRaw<
      {
        policyname: string;
        cmd: string;
        permissive: string;
        qual: string;
        with_check: string | null;
      }[]
    >`
      SELECT "policyname", "cmd", "permissive", "qual", "with_check"
      FROM pg_policies
      WHERE "tablename" = 'work_item'
        AND ("qual" LIKE '%app.platform_staff%' OR "with_check" LIKE '%app.platform_staff%')
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      policyname: 'work_item_platform_staff_read',
      cmd: 'SELECT',
      permissive: 'PERMISSIVE',
      with_check: null,
    });
    expect(rows[0]!.qual).not.toContain('app.workspace_id');
    expect(rows[0]!.qual).not.toContain('app.system_admin');
  });
});

describe('platformPlanRepository.findWorkItemByIdentifier', () => {
  it("finds a PRIVATE project's work item inside a platform read, and nothing outside one", async () => {
    const fx = await makeWorkItemFixture({ name: 'Work item arm tenant', identifier: 'PROD' });
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'A planning bug' });
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.accessMode).not.toBe('public');

    const inside = await withPlatformRead(
      operator,
      { action: 'estate.read', targetKind: 'platform', targetId: bug.id },
      (tx) => platformPlanRepository.findWorkItemByIdentifier(bug.identifier, fx.projectId, tx),
    );
    expect(inside).toEqual({ id: bug.id, identifier: bug.identifier });

    const outside = await db.$transaction((tx) =>
      platformPlanRepository.findWorkItemByIdentifier(bug.identifier, fx.projectId, tx),
    );
    expect(outside).toBeNull();
  });
});

describe('the records service read level', () => {
  it('refuses a record read to an actor with no platform role, before any read', async () => {
    const actor = {
      userId: 'u_none',
      email: 'none@example.com',
      role: null as never,
      credential: { kind: 'session' as const },
    };
    await expect(plannerFindingRecordsService.getRecord(actor, 'rec_1')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });
});
