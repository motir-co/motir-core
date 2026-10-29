// MOTIR-10026 — the application record and release model, against real
// Postgres: eligibility, slug and address, the default application, idempotent
// creation under real concurrency, conditional release moves and the locked
// current/previous swap.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { HostingTarget, ProjectRepoState } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  ApplicationNotFoundError,
  CustomerRepositoryNotDeployableError,
  HostingTargetMissingError,
  IllegalReleaseTransitionError,
  ReleaseNotOfApplicationError,
  RepositoryNotEstablishedError,
} from '@/lib/hosting/errors';
import { hostedApplicationService as service } from '@/lib/services/hostedApplicationService';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { hostedReleaseRepository } from '@/lib/repositories/hostedReleaseRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withSystemContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface RepoOptions {
  name?: string;
  role?: 'web' | 'api';
  seedSource?: string;
  state?: ProjectRepoState;
  hostingTarget?: HostingTarget | null;
}

async function workspace(identifier = 'ACME', label: string | null = 'acme') {
  const fx = await makeWorkItemFixture({ name: identifier, identifier });
  if (label) {
    await adminDb.publicAddress.create({
      data: {
        workspaceId: fx.workspaceId,
        hostname: `${label}.motir.site`,
        kind: 'workspace_subdomain',
        status: 'active',
      },
    });
  }
  return fx;
}

async function repo(fx: WorkItemFixture, opts: RepoOptions = {}): Promise<string> {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: opts.role ?? 'web', name: `repo-${opts.role ?? 'web'}` },
    fx.ctx,
  );
  // The name is written directly: the criterion's `Shop App` is a display-style
  // name the add-row form would refuse, and the slug derivation must cope with it.
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      name: opts.name ?? 'Shop App',
      seedSource: opts.seedSource ?? 'initialised',
      state: opts.state ?? 'created',
      hostingTarget: opts.hostingTarget === undefined ? 'fly' : opts.hostingTarget,
    },
  });
  return row.id;
}

/** A release moved straight to `live`, through the legal edges. */
async function liveRelease(applicationId: string, commitSha: string) {
  const r = await service.createRelease({ applicationId, commitSha, cause: 'merge' });
  await service.transitionRelease(r.id, 'building', 'releasing');
  return service.transitionRelease(r.id, 'releasing', 'live');
}

async function stateOf(releaseId: string) {
  return (await adminDb.hostedRelease.findUniqueOrThrow({ where: { id: releaseId } })).state;
}

describe('ensureApplication', () => {
  it('stores the slug, the address and the target, and becomes the default', async () => {
    const fx = await workspace();
    const id = await repo(fx);

    const app = await service.ensureApplication(id);

    expect(app).toMatchObject({
      slug: 'shop-app',
      productionAddress: 'shop-app--acme.motir.site',
      target: 'fly',
      projectRepositoryId: id,
      workspaceId: fx.workspaceId,
      currentRelease: null,
      previousRelease: null,
      hasDatabase: false,
    });
    const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    expect(ws.defaultApplicationId).toBe(app.id);
  });

  it('gives a second repository with the same slug -2, and keeps the first default', async () => {
    const fx = await workspace();
    const first = await service.ensureApplication(await repo(fx));
    const second = await service.ensureApplication(
      await repo(fx, { name: 'shop_app', role: 'api', hostingTarget: 'serverless' }),
    );

    expect(second.slug).toBe('shop-app-2');
    expect(second.productionAddress).toBe('shop-app-2--acme.motir.site');
    expect(second.target).toBe('serverless');
    expect(second.id).not.toBe(first.id);
    const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    expect(ws.defaultApplicationId).toBe(first.id);
  });

  it('stores a null address while the workspace has claimed no label', async () => {
    const fx = await workspace('BARE', null);
    const app = await service.ensureApplication(await repo(fx));
    expect(app.slug).toBe('shop-app');
    expect(app.productionAddress).toBeNull();
  });

  it('is idempotent', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const a = await service.ensureApplication(id);
    const b = await service.ensureApplication(id);
    expect(b.id).toBe(a.id);
    expect(await adminDb.hostedApplication.count()).toBe(1);
  });

  it('leaves exactly one row when called twice at once', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const settled = await Promise.allSettled([
      service.ensureApplication(id),
      service.ensureApplication(id),
    ]);
    // Both outcomes are accepted; the row count is the invariant.
    const ok = settled.filter((s) => s.status === 'fulfilled');
    expect(ok.length).toBeGreaterThan(0);
    expect(await adminDb.hostedApplication.count({ where: { projectRepositoryId: id } })).toBe(1);
  });

  it('refuses a customer repository and writes nothing', async () => {
    const fx = await workspace();
    const id = await repo(fx, { seedSource: 'organization' });
    await expect(service.ensureApplication(id)).rejects.toBeInstanceOf(
      CustomerRepositoryNotDeployableError,
    );
    expect(await adminDb.hostedApplication.count()).toBe(0);
  });

  it('refuses a repository that is not established', async () => {
    const fx = await workspace();
    const id = await repo(fx, { state: 'proposed' });
    await expect(service.ensureApplication(id)).rejects.toBeInstanceOf(
      RepositoryNotEstablishedError,
    );
    expect(await adminDb.hostedApplication.count()).toBe(0);
  });

  it('refuses a repository with no hosting target', async () => {
    const fx = await workspace();
    const id = await repo(fx, { hostingTarget: null });
    await expect(service.ensureApplication(id)).rejects.toBeInstanceOf(HostingTargetMissingError);
    expect(await adminDb.hostedApplication.count()).toBe(0);
  });

  it('refuses a repository row that does not exist', async () => {
    await expect(service.ensureApplication('nope')).rejects.toBeInstanceOf(
      ApplicationNotFoundError,
    );
  });
});

describe('assignProductionAddress', () => {
  it('writes the host once a label is claimed, and null once it is gone', async () => {
    const fx = await workspace('LATE', null);
    const app = await service.ensureApplication(await repo(fx));
    expect(app.productionAddress).toBeNull();

    const claimed = await adminDb.publicAddress.create({
      data: {
        workspaceId: fx.workspaceId,
        hostname: 'late.motir.site',
        kind: 'workspace_subdomain',
        status: 'active',
      },
    });
    expect((await service.assignProductionAddress(app.id)).productionAddress).toBe(
      'shop-app--late.motir.site',
    );

    await adminDb.publicAddress.delete({ where: { id: claimed.id } });
    expect((await service.assignProductionAddress(app.id)).productionAddress).toBeNull();
    const row = await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.productionAddress).toBeNull();
  });

  it('refuses an unknown application', async () => {
    await expect(service.assignProductionAddress('nope')).rejects.toBeInstanceOf(
      ApplicationNotFoundError,
    );
  });
});

describe('reads', () => {
  it('reads the application and its releases within its workspace only', async () => {
    const a = await workspace('AAA', 'aaa');
    const b = await workspace('BBB', 'bbb');
    const id = await repo(a);
    const app = await service.ensureApplication(id);
    const r1 = await service.createRelease({
      applicationId: app.id,
      commitSha: 'c1',
      cause: 'merge',
    });
    const r2 = await service.createRelease({
      applicationId: app.id,
      commitSha: 'c1',
      ref: 'v1.0.0',
      cause: 'config_change',
    });

    expect((await service.getApplicationForRepository(a.workspaceId, id))?.id).toBe(app.id);
    const listed = await service.listReleases(a.workspaceId, app.id);
    expect(listed.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    expect(listed.find((r) => r.id === r2.id)).toMatchObject({
      ref: 'v1.0.0',
      cause: 'config_change',
    });
    expect(await service.listReleases(a.workspaceId, app.id, 1)).toHaveLength(1);

    // The same ids from workspace B find nothing.
    expect(await service.getApplicationForRepository(b.workspaceId, id)).toBeNull();
    await expect(service.listReleases(b.workspaceId, app.id)).rejects.toBeInstanceOf(
      ApplicationNotFoundError,
    );
  });

  it('never carries the database URL ciphertext in the DTO', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const app = await service.ensureApplication(id);
    await adminDb.hostedApplication.update({
      where: { id: app.id },
      data: { databaseUrlCiphertext: 'v1:SECRET-CIPHERTEXT', databaseProjectId: 'neon-1' },
    });
    const dto = await service.getApplicationForRepository(fx.workspaceId, id);
    expect(dto?.hasDatabase).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('SECRET-CIPHERTEXT');
    expect(Object.keys(dto!)).not.toContain('databaseUrlCiphertext');
  });
});

describe('releases', () => {
  it('creates a release in building, and refuses one for an unknown application', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const r = await service.createRelease({
      applicationId: app.id,
      commitSha: 'abc',
      cause: 'merge',
    });
    expect(r).toMatchObject({ state: 'building', commitSha: 'abc', ref: null, liveAt: null });
    await expect(
      service.createRelease({ applicationId: 'nope', commitSha: 'abc', cause: 'merge' }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
  });

  it('moves along the legal edges and stamps the times and details', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const r = await service.createRelease({
      applicationId: app.id,
      commitSha: 'abc',
      cause: 'merge',
    });
    const releasing = await service.transitionRelease(r.id, 'building', 'releasing', {
      artifactRef: 'registry.fly.io/app@sha256:1',
    });
    expect(releasing).toMatchObject({
      state: 'releasing',
      artifactRef: 'registry.fly.io/app@sha256:1',
    });
    const live = await service.transitionRelease(r.id, 'releasing', 'live', {
      providerReleaseId: 'v7',
    });
    expect(live.state).toBe('live');
    expect(live.liveAt).not.toBeNull();
    expect(live.providerReleaseId).toBe('v7');

    const failed = await service.createRelease({
      applicationId: app.id,
      commitSha: 'def',
      cause: 'merge',
    });
    const out = await service.transitionRelease(failed.id, 'building', 'failed', {
      failureReason: 'build',
    });
    expect(out).toMatchObject({ state: 'failed', failureReason: 'build' });
    expect(out.endedAt).not.toBeNull();
  });

  it('refuses an illegal edge and changes no row', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const r = await service.createRelease({
      applicationId: app.id,
      commitSha: 'abc',
      cause: 'merge',
    });
    await expect(service.transitionRelease(r.id, 'building', 'live')).rejects.toBeInstanceOf(
      IllegalReleaseTransitionError,
    );
    expect(await stateOf(r.id)).toBe('building');
  });

  it('refuses a stale edge — the release already moved — and changes no row', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const r = await service.createRelease({
      applicationId: app.id,
      commitSha: 'abc',
      cause: 'merge',
    });
    await service.transitionRelease(r.id, 'building', 'failed');

    const stale = service.transitionRelease(r.id, 'building', 'releasing');
    await expect(stale).rejects.toBeInstanceOf(IllegalReleaseTransitionError);
    await expect(stale).rejects.toMatchObject({ actual: 'failed' });
    expect(await stateOf(r.id)).toBe('failed');
    await expect(service.transitionRelease('gone', 'building', 'failed')).rejects.toMatchObject({
      actual: null,
    });
  });
});

describe('swapCurrentRelease', () => {
  it('moves current to previous and the outgoing release to replaced', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const r1 = await liveRelease(app.id, 'c1');
    const first = await withSystemContext((tx) => service.swapCurrentRelease(app.id, r1.id, tx));
    expect(first.currentRelease?.id).toBe(r1.id);
    expect(first.previousRelease).toBeNull();

    const r2 = await liveRelease(app.id, 'c2');
    const second = await withSystemContext((tx) => service.swapCurrentRelease(app.id, r2.id, tx));
    expect(second.currentRelease?.id).toBe(r2.id);
    expect(second.previousRelease?.id).toBe(r1.id);
    expect(await stateOf(r1.id)).toBe('replaced');

    // Swapping to the release that is already current is a no-op.
    const again = await withSystemContext((tx) => service.swapCurrentRelease(app.id, r2.id, tx));
    expect(again.previousRelease?.id).toBe(r1.id);
  });

  it('marks the outgoing release rolled_back when a rollback swaps back', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const r1 = await liveRelease(app.id, 'c1');
    await withSystemContext((tx) => service.swapCurrentRelease(app.id, r1.id, tx));
    const r2 = await liveRelease(app.id, 'c2');
    await withSystemContext((tx) => service.swapCurrentRelease(app.id, r2.id, tx));

    const back = await withSystemContext((tx) =>
      service.swapCurrentRelease(app.id, r1.id, tx, { outgoing: 'rolled_back' }),
    );
    expect(back.currentRelease?.id).toBe(r1.id);
    expect(back.previousRelease?.id).toBe(r2.id);
    expect(await stateOf(r2.id)).toBe('rolled_back');
    // The rollback card revives r1; the edge it uses is legal.
    await service.transitionRelease(r1.id, 'replaced', 'live');
    expect(await stateOf(r1.id)).toBe('live');
  });

  it("refuses another application's release, and touches neither application", async () => {
    const fx = await workspace();
    const a = await service.ensureApplication(await repo(fx));
    const b = await service.ensureApplication(await repo(fx, { name: 'api', role: 'api' }));
    expect(b.id).not.toBe(a.id);
    const ra = await liveRelease(a.id, 'a1');
    const rb = await liveRelease(b.id, 'b1');
    await withSystemContext((tx) => service.swapCurrentRelease(b.id, rb.id, tx));

    await expect(
      withSystemContext((tx) => service.swapCurrentRelease(a.id, rb.id, tx)),
    ).rejects.toBeInstanceOf(ReleaseNotOfApplicationError);
    await expect(
      withSystemContext((tx) => service.swapCurrentRelease(a.id, 'gone', tx)),
    ).rejects.toBeInstanceOf(ReleaseNotOfApplicationError);
    await expect(
      withSystemContext((tx) => service.swapCurrentRelease('gone', ra.id, tx)),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);

    await withSystemContext((tx) => service.swapCurrentRelease(a.id, ra.id, tx));
    const after = await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.currentReleaseId).toBe(rb.id);
    expect(await stateOf(rb.id)).toBe('live');
  });

  it('serialises two swaps at once on the application lock', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const r0 = await liveRelease(app.id, 'c0');
    await withSystemContext((tx) => service.swapCurrentRelease(app.id, r0.id, tx));
    const r1 = await liveRelease(app.id, 'c1');
    const r2 = await liveRelease(app.id, 'c2');

    await Promise.all([
      withSystemContext((tx) => service.swapCurrentRelease(app.id, r1.id, tx)),
      withSystemContext((tx) => service.swapCurrentRelease(app.id, r2.id, tx)),
    ]);

    const row = await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect([r1.id, r2.id]).toContain(row.currentReleaseId);
    expect(row.previousReleaseId).not.toBe(row.currentReleaseId);
    expect([r1.id, r2.id]).toContain(row.previousReleaseId);
    // The serial order: r0 was replaced by the first swap, the loser's release
    // by the second; only the winner is still live.
    expect(await stateOf(r0.id)).toBe('replaced');
    expect(await stateOf(row.previousReleaseId!)).toBe('replaced');
    expect(await stateOf(row.currentReleaseId!)).toBe('live');
  });
});

describe('the repositories', () => {
  it('finds an application by its production address and renames its slug', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const found = await withSystemContext((tx) =>
      hostedApplicationRepository.findByProductionAddress('shop-app--acme.motir.site', tx),
    );
    expect(found?.id).toBe(app.id);

    await withSystemContext((tx) => hostedApplicationRepository.setSlug(app.id, 'shop', tx));
    const row = await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.slug).toBe('shop');
  });

  it('inserts nothing when the repository already has an application', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const again = await withSystemContext((tx) =>
      hostedApplicationRepository.insertIfAbsent(
        {
          workspaceId: app.workspaceId,
          projectId: app.projectId,
          projectRepositoryId: app.projectRepositoryId,
          target: 'aws',
          slug: 'other',
          productionAddress: null,
        },
        tx,
      ),
    );
    expect(again).toBeNull();
    expect(await adminDb.hostedApplication.count()).toBe(1);
  });

  it('reads nothing without a bound context — the tx-less fallback is still policy-gated', async () => {
    const fx = await workspace();
    const app = await service.ensureApplication(await repo(fx));
    const r = await service.createRelease({
      applicationId: app.id,
      commitSha: 'c',
      cause: 'merge',
    });
    expect(await hostedApplicationRepository.findById(app.id)).toBeNull();
    expect(
      await hostedApplicationRepository.findByProjectRepository(app.projectRepositoryId),
    ).toBeNull();
    expect(
      await hostedApplicationRepository.findByProductionAddress('shop-app--acme.motir.site'),
    ).toBeNull();
    expect(await hostedReleaseRepository.findById(r.id)).toBeNull();
    expect(await hostedReleaseRepository.listByApplication(app.id, 5)).toEqual([]);
  });
});
