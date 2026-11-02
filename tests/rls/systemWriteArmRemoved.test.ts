// MOTIR-10219 — the system-admin WRITE arm is gone from the seven workspace tables
// system code writes as a known row: `hosted_application`, `hosted_release`,
// `preview_deployment`, `repo_deployment`, `monitor_connection`,
// `monitor_installation` and `monitor_issue`.
//
// Each table's `<table>_workspace_or_system` policy keeps `app.system_admin` on
// USING — a sweep still FINDS a row before it knows the row's workspace — and
// reads only `app.workspace_id` on WITH CHECK. So, run as the non-bypass
// `motir_app` role (the role every vitest worker's `db` connects as):
//
//   * a write under `withSystemContext` alone is REFUSED (SQLSTATE 42501);
//   * the same write with the row's workspace bound — `bindWorkspaceContext` in
//     the system transaction, or `withWorkspaceServiceContext` — passes;
//   * a write bound to one workspace cannot change another workspace's row:
//     under the system flag it is refused, without it the row is not even seen.
//
// The per-path suites (`tests/integration/monitors/*`, `tests/hosting/*`,
// `tests/preview/*`, `tests/github/*Deployment*`) show each changed writer still
// writes its row; this file pins the POLICY those writers now depend on.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { encryptToken } from '@/lib/monitors/tokenCrypto';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import {
  bindWorkspaceContext,
  withSystemContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../helpers/sqlstate';

const TABLES = [
  'hosted_application',
  'hosted_release',
  'preview_deployment',
  'repo_deployment',
  'monitor_connection',
  'monitor_installation',
  'monitor_issue',
] as const;
type Table = (typeof TABLES)[number];

let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** One row in every one of the seven tables, all in one fresh workspace. */
async function tenant(tag: string) {
  const n = seq++;
  const identifier = `${tag}${n}`;
  const fx = await makeWorkItemFixture({ name: identifier, identifier });

  // hosted_application + hosted_release, through the service that owns them.
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: `app-${n}` },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { state: 'created', hostingTarget: 'fly', seedSource: 'initialised' },
  });
  const app = await hostedApplicationService.ensureApplication(row.id);
  const release = await hostedApplicationService.createRelease({
    applicationId: app.id,
    commitSha: 'abc',
    cause: 'merge',
  });

  // A connected GitHub repository, for the two deployment tables.
  const providerRepoId = String(9000 + n);
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: String(8000 + n),
      accountLogin: `org-${n}`,
      accountType: 'Organization',
    },
    repos: [
      { providerRepoId, owner: `org-${n}`, name: 'app', defaultBranch: 'main', archived: false },
    ],
  });
  const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: providerRepoId },
  });
  const preview = await adminDb.previewDeployment.create({
    data: {
      workspaceId: fx.workspaceId,
      repoId: githubRepo.id,
      pullRequestNumber: 1,
      headSha: 'a'.repeat(40),
      host: `pr-1--app-${n}.preview.motir.site`,
    },
  });
  const deployment = await adminDb.repoDeployment.create({
    data: {
      workspaceId: fx.workspaceId,
      repoId: githubRepo.id,
      provider: 'github',
      providerDeploymentId: `dep-${n}`,
      commitSha: 'a'.repeat(40),
      ref: 'main',
      environment: 'preview',
      state: 'in_progress',
      occurredAt: new Date('2026-11-01T00:00:00Z'),
    },
  });

  // A monitor grant, a binding on it and one ingested issue.
  const installation = await adminDb.monitorInstallation.create({
    data: {
      provider: 'sentry',
      installationId: `inst-${n}`,
      workspaceId: fx.workspaceId,
      accessTokenEncrypted: encryptToken('access'),
      refreshTokenEncrypted: encryptToken('refresh'),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const connection = await adminDb.monitorConnection.create({
    data: {
      installationId: installation.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      externalProjectId: `ext-${n}`,
      externalProjectSlug: `slug-${n}`,
      boundByUserId: fx.ownerId,
    },
  });
  const issue = await adminDb.monitorIssue.create({
    data: {
      connectionId: connection.id,
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      externalIssueId: `issue-${n}`,
      title: 'TypeError',
      firstSeenAt: new Date('2026-11-01T00:00:00Z'),
      lastSeenAt: new Date('2026-11-01T00:00:00Z'),
    },
  });

  const ids: Record<Table, string> = {
    hosted_application: app.id,
    hosted_release: release.id,
    preview_deployment: preview.id,
    repo_deployment: deployment.id,
    monitor_connection: connection.id,
    monitor_installation: installation.id,
    monitor_issue: issue.id,
  };
  return { workspaceId: fx.workspaceId, projectId: fx.projectId, ids, connectionId: connection.id };
}

/** One UPDATE per table, of a column no policy reads — the write each test makes. */
function update(
  table: Table,
  id: string,
  tx: Prisma.TransactionClient,
): Promise<{ count: number }> {
  const where = { where: { id } };
  switch (table) {
    case 'hosted_application':
      return tx.hostedApplication.updateMany({
        ...where,
        data: { productionAddress: 'x.motir.site' },
      });
    case 'hosted_release':
      return tx.hostedRelease.updateMany({ ...where, data: { artifactRef: 'img@sha256:1' } });
    case 'preview_deployment':
      return tx.previewDeployment.updateMany({ ...where, data: { headSha: 'b'.repeat(40) } });
    case 'repo_deployment':
      return tx.repoDeployment.updateMany({ ...where, data: { state: 'success' } });
    case 'monitor_connection':
      return tx.monitorConnection.updateMany({ ...where, data: { externalProjectSlug: 'moved' } });
    case 'monitor_installation':
      return tx.monitorInstallation.updateMany({ ...where, data: { healthReason: 'checked' } });
    case 'monitor_issue':
      return tx.monitorIssue.updateMany({ ...where, data: { title: 'RangeError' } });
  }
}

/** One INSERT into a table whose rows system code creates. */
async function insert(
  table: 'monitor_issue' | 'hosted_release',
  a: Awaited<ReturnType<typeof tenant>>,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (table === 'monitor_issue') {
    await tx.monitorIssue.create({
      data: {
        connectionId: a.connectionId,
        projectId: a.projectId,
        workspaceId: a.workspaceId,
        externalIssueId: 'fresh',
        title: 'New',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    return;
  }
  await tx.hostedRelease.create({
    data: {
      workspaceId: a.workspaceId,
      applicationId: a.ids.hosted_application,
      commitSha: 'def',
      cause: 'merge',
    },
  });
}

/** The column `update` writes, read back as the owner. */
async function written(table: Table, id: string): Promise<boolean> {
  const where = { where: { id } };
  switch (table) {
    case 'hosted_application':
      return (
        (await adminDb.hostedApplication.findUniqueOrThrow(where)).productionAddress ===
        'x.motir.site'
      );
    case 'hosted_release':
      return (await adminDb.hostedRelease.findUniqueOrThrow(where)).artifactRef === 'img@sha256:1';
    case 'preview_deployment':
      return (await adminDb.previewDeployment.findUniqueOrThrow(where)).headSha === 'b'.repeat(40);
    case 'repo_deployment':
      return (await adminDb.repoDeployment.findUniqueOrThrow(where)).state === 'success';
    case 'monitor_connection':
      return (
        (await adminDb.monitorConnection.findUniqueOrThrow(where)).externalProjectSlug === 'moved'
      );
    case 'monitor_installation':
      return (
        (await adminDb.monitorInstallation.findUniqueOrThrow(where)).healthReason === 'checked'
      );
    case 'monitor_issue':
      return (await adminDb.monitorIssue.findUniqueOrThrow(where)).title === 'RangeError';
  }
}

describe('the seven `*_workspace_or_system` policies', () => {
  it('read app.system_admin on USING and only app.workspace_id on WITH CHECK', async () => {
    const rows = await adminDb.$queryRaw<
      { tablename: string; policyname: string; cmd: string; qual: string; with_check: string }[]
    >`
      SELECT tablename, policyname, cmd, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND policyname = tablename || '_workspace_or_system'
         AND tablename = ANY(${[...TABLES]}::text[])
       ORDER BY tablename
    `;
    expect(rows.map((r) => r.tablename)).toEqual([...TABLES].sort());
    for (const r of rows) {
      expect(r.cmd, r.policyname).toBe('ALL');
      expect(r.qual, `${r.policyname} USING keeps the system arm`).toContain(
        "current_setting('app.system_admin'",
      );
      expect(r.qual, `${r.policyname} USING keeps the workspace arm`).toContain(
        "current_setting('app.workspace_id'",
      );
      expect(r.with_check, `${r.policyname} WITH CHECK has no system arm`).not.toContain(
        'system_admin',
      );
      expect(r.with_check, `${r.policyname} WITH CHECK keeps the workspace arm`).toContain(
        "current_setting('app.workspace_id'",
      );
    }
  });

  it('no other policy on these tables admits a system-only write', async () => {
    // A second permissive policy would OR its own check back in; the org read
    // arms on the two deployment tables are FOR SELECT and cannot.
    const rows = await adminDb.$queryRaw<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = ANY(${[...TABLES]}::text[])
         AND cmd IN ('ALL', 'INSERT', 'UPDATE')
         AND coalesce(with_check, qual, '') LIKE '%system_admin%'
         AND policyname <> tablename || '_workspace_or_system'
    `;
    expect(rows).toEqual([]);
  });
});

describe('a write under withSystemContext', () => {
  it.each(TABLES)('%s — refused alone, admitted with the row’s workspace bound', async (table) => {
    const a = await tenant('SYS');
    const id = a.ids[table];

    // The system flag still FINDS the row (USING)…
    const found = await withSystemContext((tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${table}" WHERE id = $1`, id),
    );
    expect(found).toEqual([{ id }]);

    // …but cannot WRITE it.
    await expect(
      withSystemContext((tx) => update(table, id, tx)),
      RLS_DENIAL,
    ).rejects.toSatisfy(isRlsDenial);
    expect(await written(table, id)).toBe(false);

    // Bound to the row's own workspace, inside the same kind of transaction: written.
    const bound = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, a.workspaceId);
      return update(table, id, tx);
    });
    expect(bound.count).toBe(1);
    expect(await written(table, id)).toBe(true);
  });

  it.each(TABLES)('%s — admitted under withWorkspaceServiceContext', async (table) => {
    const a = await tenant('SVC');
    const result = await withWorkspaceServiceContext(a.workspaceId, (tx) =>
      update(table, a.ids[table], tx),
    );
    expect(result.count).toBe(1);
    expect(await written(table, a.ids[table])).toBe(true);
  });

  it.each(['monitor_issue', 'hosted_release'] as const)(
    '%s — an INSERT is refused alone and admitted bound',
    async (table) => {
      const a = await tenant('INS');
      await expect(
        withSystemContext((tx) => insert(table, a, tx)),
        RLS_DENIAL,
      ).rejects.toSatisfy(isRlsDenial);
      await withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, a.workspaceId);
        return insert(table, a, tx);
      });
      expect(await adminDb.monitorIssue.count({ where: { externalIssueId: 'fresh' } })).toBe(
        table === 'monitor_issue' ? 1 : 0,
      );
      expect(await adminDb.hostedRelease.count({ where: { commitSha: 'def' } })).toBe(
        table === 'hosted_release' ? 1 : 0,
      );
    },
  );
});

describe('a write bound to one workspace', () => {
  it.each([
    'monitor_issue',
    'monitor_installation',
    'hosted_release',
    'hosted_application',
  ] as const)("%s — cannot change another workspace's row", async (table) => {
    const a = await tenant('AAA');
    const b = await tenant('BBB');
    const theirs = a.ids[table];

    // Under the system flag the row is FOUND, and the bound check refuses it.
    await expect(
      withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, b.workspaceId);
        return update(table, theirs, tx);
      }),
      RLS_DENIAL,
    ).rejects.toSatisfy(isRlsDenial);

    // Without the system flag the row is not even visible.
    const unseen = await withWorkspaceServiceContext(b.workspaceId, (tx) =>
      update(table, theirs, tx),
    );
    expect(unseen.count).toBe(0);

    expect(await written(table, theirs)).toBe(false);
    // B's own row is still writable from B.
    const own = await withWorkspaceServiceContext(b.workspaceId, (tx) =>
      update(table, b.ids[table], tx),
    );
    expect(own.count).toBe(1);
  });
});
