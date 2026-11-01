// MOTIR-5772 — `preview_deployment` and its repository, on real Postgres: one
// row per pull request, state moved only by the conditional `transition` (a
// race has one winner, asserted with two live connections), the reads the
// lifecycle, serving and the reaper use, and the table's RLS under the
// non-bypass `motir_app` role.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma, PreviewDeploymentState } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { previewDeploymentRepository as repo } from '@/lib/repositories/previewDeploymentRepository';
import { isLegalPreviewTransition, legalSourcesFor, PREVIEW_STATES } from '@/lib/preview/states';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { usersService } from '@/lib/services/usersService';
import { withSystemContext } from '@/lib/workspaces/context';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const SHA_1 = 'a'.repeat(40);
const SHA_2 = 'b'.repeat(40);

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A workspace with one connected repository. */
async function connectedRepo(tag: string, installationId: number) {
  const user = await usersService.createUser({
    email: `${tag}@ex.com`,
    password: 'hunter2hunter2',
    name: tag,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: tag,
    ownerUserId: user.id,
  });
  const providerRepoId = String(installationId * 10);
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: String(installationId),
      accountLogin: tag,
      accountType: 'Organization',
    },
    repos: [{ providerRepoId, owner: tag, name: 'app', defaultBranch: 'main', archived: false }],
  });
  const row = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: providerRepoId } });
  return { userId: user.id, workspaceId: workspace.id, repoId: row.id };
}

function upsert(r: { workspaceId: string; repoId: string }, n: number, headSha = SHA_1) {
  return withSystemContext((tx) =>
    repo.upsertForPullRequest(
      {
        workspaceId: r.workspaceId,
        repoId: r.repoId,
        pullRequestNumber: n,
        headSha,
        host: `pr-${n}--app-${r.repoId}.preview.motir.site`,
      },
      tx,
    ),
  );
}

function transition(
  id: string,
  from: PreviewDeploymentState[],
  to: PreviewDeploymentState,
  patch: Parameters<typeof repo.transition>[3] = {},
) {
  return withSystemContext((tx) => repo.transition(id, from, to, patch, tx));
}

describe('the state machine', () => {
  it('allows exactly the moves the decision’s lifecycle makes', () => {
    const legal = PREVIEW_STATES.flatMap((from) =>
      PREVIEW_STATES.filter((to) => isLegalPreviewTransition(from, to)).map(
        (to) => `${from}→${to}`,
      ),
    );
    expect(legal.sort()).toEqual(
      [
        'building→building',
        'building→starting',
        'building→failed',
        'building→closed',
        'starting→building',
        'starting→ready',
        'starting→failed',
        'starting→closed',
        'ready→building',
        'ready→failed',
        'ready→closed',
        'failed→building',
        'failed→closed',
        'closed→building',
      ].sort(),
    );
    expect(legalSourcesFor(['closed', 'closed', 'starting'], 'ready')).toEqual(['starting']);
  });
});

describe('previewDeploymentRepository', () => {
  it('creates one building row per pull request, and a second upsert moves only its head', async () => {
    const r = await connectedRepo('acme', 101);
    const created = await upsert(r, 7);
    expect(created).toMatchObject({
      workspaceId: r.workspaceId,
      repoId: r.repoId,
      pullRequestNumber: 7,
      headSha: SHA_1,
      state: 'building',
      closedAt: null,
      failureReason: null,
    });
    await transition(created.id, ['building'], 'starting');
    const again = await upsert(r, 7, SHA_2);
    expect(again).toMatchObject({
      id: created.id,
      headSha: SHA_2,
      state: 'starting',
      host: created.host,
    });
    expect(await adminDb.previewDeployment.count()).toBe(1);
    await upsert(r, 8);
    expect(await adminDb.previewDeployment.count()).toBe(2);
  });

  it('moves a row only from a listed state, writes the patch, and stamps closed_at', async () => {
    const r = await connectedRepo('acme', 102);
    const { id } = await upsert(r, 1);
    expect(await transition(id, ['ready'], 'closed')).toBeNull();
    const failed = await transition(id, ['building'], 'failed', {
      failureReason: 'image pull failed',
    });
    expect(failed).toMatchObject({ state: 'failed', failureReason: 'image pull failed' });
    const closed = await transition(id, ['failed'], 'closed');
    expect(closed?.state).toBe('closed');
    expect(closed?.closedAt).toBeInstanceOf(Date);
    const reopened = await transition(id, ['closed'], 'building', {
      headSha: SHA_2,
      failureReason: null,
      flyAppName: 'mh-x-pr1',
      flyMachineId: 'm1',
      neonProjectId: 'proj-1',
      neonBranchId: 'br-1',
      githubDeploymentId: '42',
    });
    expect(reopened).toMatchObject({
      state: 'building',
      closedAt: null,
      headSha: SHA_2,
      failureReason: null,
      flyAppName: 'mh-x-pr1',
      neonBranchId: 'br-1',
      githubDeploymentId: '42',
    });
    expect(await transition('no-such-row', ['building'], 'starting')).toBeNull();
  });

  it('refuses an illegal move whatever `from` says, and writes nothing', async () => {
    const r = await connectedRepo('acme', 103);
    const { id } = await upsert(r, 1);
    await transition(id, ['building'], 'closed');
    const before = await adminDb.previewDeployment.findUniqueOrThrow({ where: { id } });
    expect(await transition(id, ['closed'], 'ready')).toBeNull();
    expect(await transition(id, ['closed'], 'starting')).toBeNull();
    expect(await transition(id, ['closed'], 'closed')).toBeNull();
    const after = await adminDb.previewDeployment.findUniqueOrThrow({ where: { id } });
    expect(after).toEqual(before);
  });

  it('two concurrent transitions from building have exactly one winner', async () => {
    const r = await connectedRepo('acme', 104);
    const { id } = await upsert(r, 1);

    // Connection A moves the row and HOLDS its lock until B is waiting on it;
    // B's conditional UPDATE then re-reads the committed state and matches
    // nothing. Two transactions on two pooled connections, not a mock.
    let releaseA!: () => void;
    const aHolds = new Promise<void>((resolve) => (releaseA = resolve));
    let aMoved!: () => void;
    const aHasMoved = new Promise<void>((resolve) => (aMoved = resolve));
    const a = withSystemContext(async (tx: Prisma.TransactionClient) => {
      const row = await repo.transition(id, ['building'], 'starting', {}, tx);
      aMoved();
      await aHolds;
      return row;
    });
    await aHasMoved;
    const b = withSystemContext((tx) =>
      repo.transition(id, ['building'], 'failed', { failureReason: 'lost the race' }, tx),
    );
    // B is now blocked on A's row lock; give it time to reach the lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const blocked = await adminDb.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*)::bigint AS waiting FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE '%preview_deployment%'
    `;
    expect(Number(blocked[0]!.waiting)).toBeGreaterThanOrEqual(1);
    releaseA();
    const [won, lost] = await Promise.all([a, b]);
    expect(won?.state).toBe('starting');
    expect(lost).toBeNull();
    const row = await adminDb.previewDeployment.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ state: 'starting', failureReason: null });
  });

  it('finds a row by its host, lists a repository’s live rows, and the stale ones', async () => {
    const r = await connectedRepo('acme', 105);
    const one = await upsert(r, 1);
    const two = await upsert(r, 2);
    const three = await upsert(r, 3);
    await transition(three.id, ['building'], 'closed');

    // The lifecycle, serving and the reaper read under the system context.
    const system = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => withSystemContext(fn);
    expect((await system((tx) => repo.findByHost(one.host, tx)))?.id).toBe(one.id);
    expect(
      await system((tx) => repo.findByHost('pr-9--nothing.preview.motir.site', tx)),
    ).toBeNull();
    expect(
      (await system((tx) => repo.listOpenForRepo(r.repoId, tx))).map(
        (row) => row.pullRequestNumber,
      ),
    ).toEqual([1, 2]);
    // With no context bound, the runtime role sees nothing at all.
    expect(await repo.findByHost(one.host)).toBeNull();
    expect(await repo.listOpenForRepo(r.repoId)).toEqual([]);

    const old = new Date('2026-10-01T00:00:00Z');
    await adminDb.previewDeployment.updateMany({
      where: { id: { in: [two.id, three.id] } },
      data: { updatedAt: old },
    });
    const cutoff = new Date('2026-10-22T00:00:00Z');
    // The closed row is old too, and is not a reaper's concern.
    expect((await system((tx) => repo.listStale(cutoff, tx))).map((row) => row.id)).toEqual([
      two.id,
    ]);
    expect(await repo.listStale(cutoff)).toEqual([]);
    expect(await withSystemContext((tx) => repo.listStale(cutoff, tx, 0))).toEqual([]);
  });
});

describe('preview_deployment RLS', () => {
  async function asAppRole<T>(
    workspaceId: string,
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return fn(tx);
    });
  }

  it('a workspace reads its own previews and none of another workspace’s', async () => {
    const a = await connectedRepo('acme', 201);
    const b = await connectedRepo('other', 202);
    const mine = await upsert(a, 1);
    const theirs = await upsert(b, 1);
    expect(await adminDb.previewDeployment.count()).toBe(2);

    const seenByA = await asAppRole(a.workspaceId, a.userId, (tx) =>
      tx.previewDeployment.findMany(),
    );
    expect(seenByA.map((row) => row.id)).toEqual([mine.id]);
    const crossRead = await asAppRole(a.workspaceId, a.userId, (tx) =>
      repo.findByHost(theirs.host, tx),
    );
    expect(crossRead).toBeNull();
    const crossMove = await asAppRole(a.workspaceId, a.userId, (tx) =>
      repo.transition(theirs.id, ['building'], 'closed', {}, tx),
    );
    expect(crossMove).toBeNull();
    expect(
      (await adminDb.previewDeployment.findUniqueOrThrow({ where: { id: theirs.id } })).state,
    ).toBe('building');
  });
});
