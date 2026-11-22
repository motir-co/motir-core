import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { SEED_SOURCE_FLY_STARTER } from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The two reads/writes the hosted-repository delete uses on `hosted_application`
// (MOTIR-11981; design repository-set §19): the teardown read — everything the
// production step needs, and the custom-domain count the confirm shows — and the
// idempotent delete that releases the domains and takes the releases with it.
// The full delete is pinned in `tests/projectRepos/hostedRepositoryRemovalService.test.ts`.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function application() {
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: 'acme-web',
      seedSource: SEED_SOURCE_FLY_STARTER,
      state: 'created',
      hostingTarget: 'fly',
      position: 'a0',
    },
  });
  const app = await adminDb.hostedApplication.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectRepositoryId: row.id,
      target: 'fly',
      slug: 'web--acme',
      productionAddress: 'web--acme.motir.site',
      productionAppName: 'mh-web',
      databaseProjectId: 'neon-web',
    },
  });
  const release = await adminDb.hostedRelease.create({
    data: {
      workspaceId: fx.workspaceId,
      applicationId: app.id,
      commitSha: 'abc',
      cause: 'merge',
      state: 'live',
      liveAt: new Date(),
    },
  });
  await adminDb.hostedApplication.update({
    where: { id: app.id },
    data: { currentReleaseId: release.id },
  });
  const domain = await adminDb.publicAddress.create({
    data: {
      workspaceId: fx.workspaceId,
      applicationId: app.id,
      hostname: 'web.acme.test',
      kind: 'custom_domain',
      status: 'active',
    },
  });
  return { row, app, release, domain };
}

describe('hostedApplicationRepository — the hosted delete’s teardown', () => {
  it('reads what the production teardown needs, with the custom-domain count', async () => {
    const { row, app, release } = await application();
    expect(
      await withSystemContext((tx) =>
        hostedApplicationRepository.findTeardownByProjectRepository(row.id, tx),
      ),
    ).toEqual({
      id: app.id,
      projectRepositoryId: row.id,
      target: 'fly',
      slug: 'web--acme',
      productionAddress: 'web--acme.motir.site',
      productionAppName: 'mh-web',
      currentReleaseId: release.id,
      previousReleaseId: null,
      databaseProjectId: 'neon-web',
      customDomainCount: 1,
    });
  });

  it('reads nothing for a row with no application', async () => {
    expect(
      await withSystemContext((tx) =>
        hostedApplicationRepository.findTeardownByProjectRepository('no-such-row', tx),
      ),
    ).toBeNull();
  });

  it('forgets production’s releases and app name once the app is destroyed', async () => {
    const { app } = await application();
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      hostedApplicationRepository.clearProductionPointers(app.id, tx),
    );
    expect(
      await adminDb.hostedApplication.findUnique({
        where: { id: app.id },
        select: { currentReleaseId: true, previousReleaseId: true, productionAppName: true },
      }),
    ).toEqual({ currentReleaseId: null, previousReleaseId: null, productionAppName: null });
  });

  it('deletes the application with its releases, releases its domains, and is idempotent', async () => {
    const { app, domain } = await application();
    expect(
      await withSystemContext((tx) => hostedApplicationRepository.deleteById(app.id, tx)),
    ).toBe(1);
    expect(await adminDb.hostedRelease.count({ where: { applicationId: app.id } })).toBe(0);
    expect(await adminDb.publicAddress.findUnique({ where: { id: domain.id } })).toMatchObject({
      applicationId: null,
    });
    expect(
      await withSystemContext((tx) => hostedApplicationRepository.deleteById(app.id, tx)),
    ).toBe(0);
  });
});
