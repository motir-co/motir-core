// MOTIR-10026 — row-level security on `hosted_application` and `hosted_release`:
// a session in workspace B neither reads nor writes workspace A's rows, a
// session in A does, and the system context the release paths run under writes.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withSystemContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../helpers/sqlstate';
import { armedTables, rlsEnabledTables } from './policyArms';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Run as the runtime role, bound to one workspace — the test connection is a
 *  superuser and bypasses row-level security. */
function asWorkspace<T>(
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

async function applicationIn(identifier: string) {
  const fx = await makeWorkItemFixture({ name: identifier, identifier });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'app' },
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
  return { fx, app, release };
}

describe('hosted_application and hosted_release RLS', () => {
  it('is enabled and forced, with a workspace and a system arm on both tables', async () => {
    const enabled = await rlsEnabledTables();
    const workspaceArmed = await armedTables('app.workspace_id');
    const systemArmed = await armedTables('app.system_admin');
    for (const table of ['hosted_application', 'hosted_release']) {
      expect(enabled.has(table), `${table} has RLS enabled`).toBe(true);
      expect(workspaceArmed.has(table), `${table} has a workspace arm`).toBe(true);
      expect(systemArmed.has(table), `${table} has a system arm`).toBe(true);
    }
    const forced = await adminDb.$queryRaw<{ relname: string }[]>`
      SELECT relname FROM pg_class
       WHERE relname IN ('hosted_application', 'hosted_release') AND relforcerowsecurity
    `;
    expect(forced.map((r) => r.relname).sort()).toEqual(['hosted_application', 'hosted_release']);
  });

  it('lets workspace A read its own rows and hides them from workspace B', async () => {
    const a = await applicationIn('AAA');
    const b = await applicationIn('BBB');

    const own = await asWorkspace(a.fx.workspaceId, async (tx) => ({
      apps: await tx.hostedApplication.findMany(),
      releases: await tx.hostedRelease.findMany(),
    }));
    expect(own.apps.map((r) => r.id)).toEqual([a.app.id]);
    expect(own.releases.map((r) => r.id)).toEqual([a.release.id]);

    const seenByB = await asWorkspace(b.fx.workspaceId, async (tx) => ({
      app: await tx.hostedApplication.findUnique({ where: { id: a.app.id } }),
      release: await tx.hostedRelease.findUnique({ where: { id: a.release.id } }),
    }));
    expect(seenByB).toEqual({ app: null, release: null });
  });

  it("refuses workspace B's writes to workspace A's rows", async () => {
    const a = await applicationIn('AAA');
    const b = await applicationIn('BBB');

    const updated = await asWorkspace(b.fx.workspaceId, async (tx) => ({
      apps: (
        await tx.hostedApplication.updateMany({
          where: { id: a.app.id },
          data: { productionAddress: 'stolen.motir.site' },
        })
      ).count,
      releases: (
        await tx.hostedRelease.updateMany({
          where: { id: a.release.id },
          data: { state: 'failed' },
        })
      ).count,
      deleted: (await tx.hostedRelease.deleteMany({ where: { id: a.release.id } })).count,
    }));
    expect(updated).toEqual({ apps: 0, releases: 0, deleted: 0 });

    const insert = asWorkspace(b.fx.workspaceId, (tx) =>
      tx.hostedRelease.create({
        data: {
          workspaceId: a.fx.workspaceId,
          applicationId: a.app.id,
          commitSha: 'evil',
          cause: 'merge',
        },
      }),
    );
    await expect(insert, RLS_DENIAL).rejects.toSatisfy(isRlsDenial);

    const row = await adminDb.hostedRelease.findUniqueOrThrow({ where: { id: a.release.id } });
    expect(row.state).toBe('building');
    const app = await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: a.app.id } });
    // Workspace AAA claimed no label in this fixture, so its address stays null.
    expect(app.productionAddress).toBeNull();
  });

  it('admits a system-context write', async () => {
    const a = await applicationIn('AAA');
    await withSystemContext((tx) =>
      tx.hostedRelease.update({
        where: { id: a.release.id },
        data: { artifactRef: 'img@sha256:1' },
      }),
    );
    const row = await adminDb.hostedRelease.findUniqueOrThrow({ where: { id: a.release.id } });
    expect(row.artifactRef).toBe('img@sha256:1');
  });
});
