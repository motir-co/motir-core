import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { platformPlanRepository } from '@/lib/repositories/platformPlanRepository';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
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
