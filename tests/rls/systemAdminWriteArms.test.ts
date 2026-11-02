// MOTIR-10217 — the seven policies whose `WITH CHECK` no longer carries the
// `app.system_admin` arm (`20261102120000_drop_unused_system_admin_write_arms`).
//
// For each table, against the non-bypass `motir_app` role:
//   * a write under `withSystemContext` ALONE is refused — the arm is gone from
//     `WITH CHECK`, so a system transaction can no longer place a row in an
//     arbitrary workspace;
//   * the same write with the tenant bound passes — `bindWorkspaceContext` inside
//     the system transaction, or `withUserContext` for `import_source_identity`,
//     whose other arm is the user;
//   * a system read still returns rows — every `USING` clause kept its arm;
//   * on the three tables whose system code only DELETES (the orphan-attachment
//     GC, the unconfirmed-follow sweep, the unsubscribe link), that delete still
//     succeeds, because Postgres evaluates `USING`, not `WITH CHECK`, for one.
//
// The catalog half reads `pg_policies` rather than the migration, for the reason
// `policyArms.ts` gives: the deployed policy set is the fact.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { publicFollowRepository } from '@/lib/repositories/publicFollowRepository';
import { savedFilterSubscriptionRepository } from '@/lib/repositories/savedFilterSubscriptionRepository';
import { bindWorkspaceContext, withSystemContext, withUserContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../helpers/sqlstate';

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Five of the six altered policies keep the workspace arm on `WITH CHECK`. */
const WORKSPACE_CHECK = "(workspace_id = current_setting('app.workspace_id'::text, true))";
const USER_CHECK = "(user_id = current_setting('app.user_id'::text, true))";

const ALTERED: ReadonlyArray<{ table: string; policy: string; check: string }> = [
  { table: 'attachment', policy: 'attachment_workspace_or_system_admin', check: WORKSPACE_CHECK },
  { table: 'public_follow', policy: 'public_follow_workspace_or_system', check: WORKSPACE_CHECK },
  {
    table: 'saved_filter_subscription',
    policy: 'saved_filter_subscription_access',
    check: WORKSPACE_CHECK,
  },
  {
    table: 'work_item_delivery',
    policy: 'work_item_delivery_workspace_or_system',
    check: WORKSPACE_CHECK,
  },
  {
    table: 'migrate_onboarding',
    policy: 'migrate_onboarding_workspace_or_system_admin',
    check: WORKSPACE_CHECK,
  },
  {
    table: 'import_source_identity',
    policy: 'import_source_identity_owner_or_system',
    check: USER_CHECK,
  },
];

describe('the deployed policies', () => {
  it('runs every context below as the non-bypass runtime role', async () => {
    // `@/lib/db` is `motir_app` in this suite (`tests/helpers/parallelDb.ts`), so
    // the contexts below exercise the policies rather than a superuser's bypass.
    const [role] = await withSystemContext(
      (tx) => tx.$queryRaw<{ name: string; bypass: boolean; superuser: boolean }[]>`
        SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser
          FROM pg_roles WHERE rolname = current_user
      `,
    );
    expect(role).toEqual({ name: 'motir_app', bypass: false, superuser: false });
  });

  it('six policies keep their tenant arm on WITH CHECK and their system arm on USING', async () => {
    const rows = await adminDb.$queryRaw<
      { policyname: string; cmd: string; qual: string | null; with_check: string | null }[]
    >`
      SELECT policyname, cmd, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname = ANY(${ALTERED.map((a) => a.policy)})
    `;
    const byName = new Map(rows.map((r) => [r.policyname, r]));
    for (const { policy, check } of ALTERED) {
      const row = byName.get(policy);
      expect(row, `${policy} exists`).toBeDefined();
      expect(row?.cmd, `${policy} is still FOR ALL`).toBe('ALL');
      expect(row?.with_check, `${policy} WITH CHECK is the tenant arm alone`).toBe(check);
      expect(row?.qual, `${policy} USING keeps the system arm`).toContain(
        "current_setting('app.system_admin'::text, true) = 'true'::text",
      );
    }
  });

  it('public_subdomain_change_system is a read arm; the workspace policy keeps the writes', async () => {
    const rows = await adminDb.$queryRaw<
      { policyname: string; cmd: string; qual: string | null; with_check: string | null }[]
    >`
      SELECT policyname, cmd, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'public_subdomain_change'
       ORDER BY policyname
    `;
    expect(rows).toEqual([
      {
        policyname: 'public_subdomain_change_active_workspace',
        cmd: 'ALL',
        qual: WORKSPACE_CHECK,
        with_check: WORKSPACE_CHECK,
      },
      {
        policyname: 'public_subdomain_change_system',
        cmd: 'SELECT',
        qual: "(current_setting('app.system_admin'::text, true) = 'true'::text)",
        with_check: null,
      },
    ]);
  });
});

// ── attachment ───────────────────────────────────────────────────────────────

function attachmentData(fx: WorkItemFixture, name: string) {
  return {
    workspaceId: fx.workspaceId,
    uploaderUserId: fx.ownerId,
    blobPathname: `https://blob.example/attachments/${fx.workspaceId}/${name}`,
    mimeType: 'image/png',
    sizeBytes: 4,
    originalFilename: name,
  };
}

describe('attachment', () => {
  it('refuses a system-only insert and update; admits them once the workspace is bound', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await adminDb.attachment.create({ data: attachmentData(fx, 'seed.png') });

    await expect(
      withSystemContext((tx) => attachmentRepository.create(attachmentData(fx, 'sys.png'), tx)),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    await expect(
      withSystemContext((tx) =>
        attachmentRepository.linkToWorkItem([seeded.id], item.id, 'panel', tx),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    const created = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return attachmentRepository.create(attachmentData(fx, 'bound.png'), tx);
    });
    expect(created.workspaceId).toBe(fx.workspaceId);
    await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return attachmentRepository.linkToWorkItem([seeded.id], item.id, 'panel', tx);
    });
    expect(
      (await adminDb.attachment.findUniqueOrThrow({ where: { id: seeded.id } })).workItemId,
    ).toBe(item.id);
  });

  it('still lets the system context read every workspace and delete (the orphan GC)', async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    const mine = await adminDb.attachment.create({ data: attachmentData(a, 'a.png') });
    const theirs = await adminDb.attachment.create({ data: attachmentData(b, 'b.png') });

    const seen = await withSystemContext((tx) => tx.attachment.findMany({ select: { id: true } }));
    expect(seen.map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());

    await withSystemContext((tx) => attachmentRepository.delete(theirs.id, tx));
    expect(await adminDb.attachment.findUnique({ where: { id: theirs.id } })).toBeNull();
  });
});

// ── public_follow ────────────────────────────────────────────────────────────

describe('public_follow', () => {
  it('refuses a system-only insert and update; admits them once the workspace is bound', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await adminDb.publicFollow.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, email: 'seed@example.com' },
    });
    const row = {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      email: 'x@example.com',
      digestOptIn: false,
    };

    await expect(
      withSystemContext((tx) => publicFollowRepository.create(row, tx)),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    await expect(
      withSystemContext((tx) =>
        publicFollowRepository.update(seeded.id, { lastDigestAt: new Date() }, tx),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    const created = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return publicFollowRepository.create(row, tx);
    });
    expect(created.workspaceId).toBe(fx.workspaceId);
    const stamp = new Date('2026-11-02T00:00:00.000Z');
    await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return publicFollowRepository.update(seeded.id, { lastDigestAt: stamp }, tx);
    });
    expect(
      (await adminDb.publicFollow.findUniqueOrThrow({ where: { id: seeded.id } })).lastDigestAt,
    ).toEqual(stamp);
  });

  it('still lets the system context read and run the unconfirmed sweep', async () => {
    const fx = await makeWorkItemFixture();
    const old = new Date('2026-08-01T00:00:00.000Z');
    const stale = await adminDb.publicFollow.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        email: 'stale@example.com',
        createdAt: old,
      },
    });

    const seen = await withSystemContext((tx) => publicFollowRepository.findById(stale.id, tx));
    expect(seen?.id).toBe(stale.id);

    const deleted = await withSystemContext((tx) =>
      publicFollowRepository.deleteUnconfirmedBefore(new Date('2026-08-10T00:00:00.000Z'), tx),
    );
    expect(deleted).toBe(1);
    expect(await adminDb.publicFollow.count()).toBe(0);
  });
});

// ── saved_filter_subscription ────────────────────────────────────────────────

async function savedFilterIn(fx: WorkItemFixture) {
  return adminDb.savedFilter.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      ownerId: fx.ownerId,
      name: 'Mine',
      nameLower: 'mine',
      astEnvelope: {},
    },
  });
}

describe('saved_filter_subscription', () => {
  it('refuses a system-only insert and update; admits them once the workspace is bound', async () => {
    const fx = await makeWorkItemFixture();
    const filter = await savedFilterIn(fx);
    const row = {
      workspaceId: fx.workspaceId,
      savedFilterId: filter.id,
      userId: fx.ownerId,
      schedule: 'daily' as const,
      hour: 9,
    };

    await expect(
      withSystemContext((tx) => savedFilterSubscriptionRepository.create(row, tx)),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    const created = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return savedFilterSubscriptionRepository.create(row, tx);
    });
    expect(created.workspaceId).toBe(fx.workspaceId);

    await expect(
      withSystemContext((tx) =>
        savedFilterSubscriptionRepository.update(created.id, { hour: 10 }, tx),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return savedFilterSubscriptionRepository.update(created.id, { hour: 11 }, tx);
    });
    expect(
      (await adminDb.savedFilterSubscription.findUniqueOrThrow({ where: { id: created.id } })).hour,
    ).toBe(11);
  });

  it('still lets the system context read and delete (the unsubscribe link)', async () => {
    const fx = await makeWorkItemFixture();
    const filter = await savedFilterIn(fx);
    const sub = await adminDb.savedFilterSubscription.create({
      data: {
        workspaceId: fx.workspaceId,
        savedFilterId: filter.id,
        userId: fx.ownerId,
        schedule: 'daily',
        hour: 9,
      },
    });

    const seen = await withSystemContext((tx) => tx.savedFilterSubscription.findMany());
    expect(seen.map((r) => r.id)).toEqual([sub.id]);

    expect(
      await withSystemContext((tx) => savedFilterSubscriptionRepository.deleteById(sub.id, tx)),
    ).toBe(1);
    expect(await adminDb.savedFilterSubscription.count()).toBe(0);
  });
});

// ── work_item_delivery ───────────────────────────────────────────────────────

async function pullRequestIn(fx: WorkItemFixture) {
  const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: workspace.organizationId,
      repoId: `repo-${fx.workspaceId}`,
      owner: 'acme',
      name: 'core',
      defaultBranch: 'main',
    },
  });
  return adminDb.githubPullRequest.create({
    data: { repoId: repo.id, number: 1, state: 'open', headRef: 'subtask/x' },
  });
}

describe('work_item_delivery', () => {
  it('refuses a system-only insert and update; admits them once the workspace is bound', async () => {
    const fx = await makeWorkItemFixture();
    const pr = await pullRequestIn(fx);
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Delivered' });
    const row = {
      workspaceId: fx.workspaceId,
      workItemId: item.id,
      githubPullRequestId: pr.id,
      repoId: pr.repoId,
    };

    await expect(
      withSystemContext((tx) => tx.workItemDelivery.create({ data: row })),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    const created = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return tx.workItemDelivery.create({ data: row });
    });
    expect(created.workspaceId).toBe(fx.workspaceId);

    const later = new Date('2026-11-02T00:00:00.000Z');
    await expect(
      withSystemContext((tx) =>
        tx.workItemDelivery.update({ where: { id: created.id }, data: { createdAt: later } }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return tx.workItemDelivery.update({ where: { id: created.id }, data: { createdAt: later } });
    });
    expect(
      (await adminDb.workItemDelivery.findUniqueOrThrow({ where: { id: created.id } })).createdAt,
    ).toEqual(later);
  });

  it('still lets the system context read the delivery rows', async () => {
    const fx = await makeWorkItemFixture();
    const pr = await pullRequestIn(fx);
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Delivered' });
    const row = await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pr.id,
        repoId: pr.repoId,
      },
    });

    const seen = await withSystemContext((tx) =>
      tx.workItemDelivery.findMany({ select: { id: true } }),
    );
    expect(seen.map((r) => r.id)).toEqual([row.id]);
  });
});

// ── migrate_onboarding ───────────────────────────────────────────────────────

describe('migrate_onboarding', () => {
  it('refuses a system-only insert and update; admits them once the workspace is bound', async () => {
    const fx = await makeWorkItemFixture();
    const row = { workspaceId: fx.workspaceId, projectId: fx.projectId };

    await expect(
      withSystemContext((tx) => tx.migrateOnboarding.create({ data: row })),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    const created = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return tx.migrateOnboarding.create({ data: row });
    });
    expect(created.workspaceId).toBe(fx.workspaceId);

    await expect(
      withSystemContext((tx) =>
        tx.migrateOnboarding.update({ where: { id: created.id }, data: { codeGraphReady: true } }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return tx.migrateOnboarding.update({
        where: { id: created.id },
        data: { importSkipped: true },
      });
    });
    const after = await adminDb.migrateOnboarding.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.codeGraphReady).toBe(false);
    expect(after.importSkipped).toBe(true);
  });

  it('still lets the sweeps read every run under the system flag', async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    await adminDb.migrateOnboarding.create({
      data: { workspaceId: a.workspaceId, projectId: a.projectId },
    });
    await adminDb.migrateOnboarding.create({
      data: { workspaceId: b.workspaceId, projectId: b.projectId },
    });

    const seen = await withSystemContext((tx) => tx.migrateOnboarding.count());
    expect(seen).toBe(2);
  });
});

// ── import_source_identity ───────────────────────────────────────────────────

describe('import_source_identity', () => {
  it('refuses a system-only insert and update; admits them once the USER is bound', async () => {
    const fx = await makeWorkItemFixture();
    const row = {
      source: 'linear' as const,
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      accessTokenEncrypted: 'cipher',
    };

    await expect(
      withSystemContext((tx) => tx.importSourceIdentity.create({ data: row })),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    const created = await withUserContext(fx.ownerId, async (tx) => {
      return tx.importSourceIdentity.create({ data: row });
    });
    expect(created.userId).toBe(fx.ownerId);

    await expect(
      withSystemContext((tx) =>
        tx.importSourceIdentity.update({
          where: { id: created.id },
          data: { accessTokenEncrypted: 'system' },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    await withUserContext(fx.ownerId, async (tx) => {
      return tx.importSourceIdentity.update({
        where: { id: created.id },
        data: { accessTokenEncrypted: 'rotated' },
      });
    });
    expect(
      (await adminDb.importSourceIdentity.findUniqueOrThrow({ where: { id: created.id } }))
        .accessTokenEncrypted,
    ).toBe('rotated');
  });

  it('still lets the system context read the identities', async () => {
    const fx = await makeWorkItemFixture();
    const row = await adminDb.importSourceIdentity.create({
      data: {
        source: 'linear',
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        accessTokenEncrypted: 'cipher',
      },
    });

    const seen = await withSystemContext((tx) =>
      tx.importSourceIdentity.findMany({ select: { id: true } }),
    );
    expect(seen.map((r) => r.id)).toEqual([row.id]);
  });
});

// ── public_subdomain_change ──────────────────────────────────────────────────

describe('public_subdomain_change', () => {
  it('refuses a system-only insert, and a system-only update reaches no row', async () => {
    const fx = await makeWorkItemFixture();
    const at = new Date('2026-11-01T00:00:00.000Z');

    await expect(
      withSystemContext((tx) =>
        tx.publicSubdomainChange.create({
          data: { workspaceId: fx.workspaceId, lastChangedAt: at },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    const created = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return tx.publicSubdomainChange.create({
        data: { workspaceId: fx.workspaceId, lastChangedAt: at },
      });
    });
    expect(created.workspaceId).toBe(fx.workspaceId);

    // The system policy is FOR SELECT now, so no UPDATE policy's `USING` admits
    // the row to a system-only transaction: the update matches nothing, rather
    // than raising, which is how Postgres refuses an UPDATE on a hidden row.
    const later = new Date('2026-11-02T00:00:00.000Z');
    const touched = await withSystemContext((tx) =>
      tx.publicSubdomainChange.updateMany({
        where: { id: created.id },
        data: { lastChangedAt: later },
      }),
    );
    expect(touched.count).toBe(0);

    const bound = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, fx.workspaceId);
      return tx.publicSubdomainChange.updateMany({
        where: { id: created.id },
        data: { lastChangedAt: later },
      });
    });
    expect(bound.count).toBe(1);
    expect(
      (await adminDb.publicSubdomainChange.findUniqueOrThrow({ where: { id: created.id } }))
        .lastChangedAt,
    ).toEqual(later);
  });

  it('still lets the system context read every workspace’s row', async () => {
    const a = await makeWorkItemFixture();
    const b = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    const at = new Date('2026-11-01T00:00:00.000Z');
    await adminDb.publicSubdomainChange.create({
      data: { workspaceId: a.workspaceId, lastChangedAt: at },
    });
    await adminDb.publicSubdomainChange.create({
      data: { workspaceId: b.workspaceId, lastChangedAt: at },
    });

    expect(await withSystemContext((tx) => tx.publicSubdomainChange.count())).toBe(2);
  });
});
