import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { deriveApplicationSlug } from '@/lib/hosting/applicationAddress';
import { toHostedApplicationDto } from '@/lib/mappers/hostedApplicationMappers';
import { hostedApplicationExportRepository as exportsRepo } from '@/lib/repositories/hostedApplicationExportRepository';
import {
  hostedApplicationRepository as repo,
  RELEASED_SLUG_PREFIX,
  releasedSlugOf,
} from '@/lib/repositories/hostedApplicationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { createTestProject } from '../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE HANDOVER RECORDS ON A HOSTED APPLICATION (Story MOTIR-9800 · MOTIR-12126),
// against the real database: the state column and its conditional moves, the
// address release on a kept row, the workspace default cleared only for its own
// application, the grace and AWS reads, and the export record.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function addApplication(
  fx: WorkItemFixture,
  name: string,
  target: 'fly' | 'aws' = 'fly',
  projectId: string = fx.projectId,
) {
  const row = await projectRepoSetService.addRow(projectId, { role: 'web', name }, fx.ctx);
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { state: 'created', hostingTarget: target, seedSource: 'initialised' },
  });
  return hostedApplicationService.ensureApplication(row.id);
}

describe('the application handover state', () => {
  it('reads live with the four other fields null, for a row written by the raw insert', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const app = await addApplication(fx, 'shop');
    expect(app).toMatchObject({
      state: 'live',
      stopsAt: null,
      handedOverAt: null,
      upstreamAddress: null,
      handedOverAccountId: null,
    });
    const raw = await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(raw.state).toBe('live');
  });

  it('moves only while the state is in from, and reads every field back through the DTO', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const app = await addApplication(fx, 'shop');
    const stopsAt = new Date('2026-12-23T12:00:00Z');
    const handedOverAt = new Date('2026-11-24T08:00:00Z');

    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        repo.setStateIfIn(app.id, ['handing_over'], 'grace', { stopsAt }, tx),
      ),
    ).toBe(false);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        repo.setStateIfIn(app.id, ['live'], 'grace', { stopsAt }, tx),
      ),
    ).toBe(true);
    // A replayed move finds the row already moved and writes nothing.
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        repo.setStateIfIn(app.id, ['live'], 'grace', { stopsAt: new Date() }, tx),
      ),
    ).toBe(false);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        repo.setStateIfIn(
          app.id,
          ['grace', 'handing_over'],
          'handed_over',
          { handedOverAt, handedOverAccountId: '400000000123' },
          tx,
        ),
      ),
    ).toBe(true);
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      repo.setUpstreamAddress(app.id, 'shop.acme-upstream.example', tx),
    );

    const row = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      repo.findById(app.id, tx),
    );
    expect(toHostedApplicationDto(row!)).toMatchObject({
      state: 'handed_over',
      stopsAt: stopsAt.toISOString(),
      handedOverAt: handedOverAt.toISOString(),
      handedOverAccountId: '400000000123',
      upstreamAddress: 'shop.acme-upstream.example',
    });
  });

  it('lists only grace rows stopping at or before the instant, soonest first', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const [soon, sooner, later, live] = [
      await addApplication(fx, 'soon'),
      await addApplication(fx, 'sooner'),
      await addApplication(fx, 'later'),
      await addApplication(fx, 'live'),
    ];
    const at = new Date('2026-12-23T12:00:00Z');
    const set = (id: string, stopsAt: Date) =>
      withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        repo.setStateIfIn(id, ['live'], 'grace', { stopsAt }, tx),
      );
    await set(soon.id, at);
    await set(sooner.id, new Date(at.getTime() - 60_000));
    await set(later.id, new Date(at.getTime() + 1));
    void live;
    const due = await withSystemContext((tx) => repo.listInGraceStoppingBy(at, tx));
    expect(due.map((r) => r.id)).toEqual([sooner.id, soon.id]);
    expect(due[0]).toMatchObject({ workspaceId: fx.workspaceId });
  });

  it('lists the AWS applications of every workspace in the organisation, and no other', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const awsApp = await addApplication(a, 'api', 'aws');
    await addApplication(a, 'site', 'fly');
    await addApplication(b, 'api', 'aws');
    const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: a.workspaceId } }))
      .organizationId;
    const rows = await withSystemContext((tx) => repo.listAwsByOrganization(orgId, tx));
    expect(rows).toEqual([
      expect.objectContaining({
        id: awsApp.id,
        workspaceId: a.workspaceId,
        state: 'live',
        upstreamAddress: null,
      }),
    ]);
  });
});

describe('releasing a kept application’s addresses', () => {
  it('clears the address and tombstones the slug, keeps the row, and frees the slug', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const app = await addApplication(fx, 'shop');
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      repo.setProductionAddress(app.id, 'shop--acme.motir.site', tx),
    );
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      repo.setStateIfIn(app.id, ['live'], 'handed_over', {}, tx),
    );

    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) => repo.releaseAddresses(app.id, tx)),
    ).toBe(true);
    const released = await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: app.id } });
    expect(released).toMatchObject({
      slug: releasedSlugOf(app.id),
      productionAddress: null,
      state: 'handed_over',
    });
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) => repo.releaseAddresses(app.id, tx)),
    ).toBe(false);
    expect(
      await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: app.id } }),
    ).toMatchObject({ slug: releasedSlugOf(app.id), productionAddress: null });

    // The same repository name, in another project of the workspace, derives the
    // old slug again for a new application.
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SEC',
    });
    const next = await addApplication(fx, 'shop', 'fly', other.id);
    expect(next.slug).toBe('shop');
    expect(await adminDb.hostedApplication.count()).toBe(2);
  });

  it('the shipped slug derivation never produces a tombstone', () => {
    const names = [
      'released',
      'released--app',
      'Released--',
      'released-',
      '--released--',
      'a--b',
      'r'.repeat(80),
      'released----' + 'x'.repeat(40),
      'shop',
    ];
    for (const name of names) {
      for (const taken of [new Set<string>(), new Set(['released', 'released-2', 'shop'])]) {
        const slug = deriveApplicationSlug(name, taken);
        expect(slug.startsWith(RELEASED_SLUG_PREFIX), `${name} → ${slug}`).toBe(false);
        expect(slug).not.toContain('--');
      }
    }
    // A sweep over random inputs, seeded so a failure reproduces.
    let seed = 12126;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
    const alphabet = 'released-_. RELEASED0123456789--';
    for (let i = 0; i < 2000; i += 1) {
      const len = 1 + Math.floor(rand() * 40);
      const name = Array.from(
        { length: len },
        () => alphabet[Math.floor(rand() * alphabet.length)],
      ).join('');
      expect(deriveApplicationSlug(name, new Set()).includes('--')).toBe(false);
    }
  });
});

describe('workspaceRepository.clearDefaultApplicationIf', () => {
  it('clears the default only when it names that application', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const first = await addApplication(fx, 'shop');
    const second = await addApplication(fx, 'blog');
    const defaultOf = async () =>
      (await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } }))
        .defaultApplicationId;
    expect(await defaultOf()).toBe(first.id);

    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workspaceRepository.clearDefaultApplicationIf(fx.workspaceId, second.id, tx),
      ),
    ).toBe(false);
    expect(await defaultOf()).toBe(first.id);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workspaceRepository.clearDefaultApplicationIf(fx.workspaceId, first.id, tx),
      ),
    ).toBe(true);
    expect(await defaultOf()).toBeNull();
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workspaceRepository.clearDefaultApplicationIf(fx.workspaceId, first.id, tx),
      ),
    ).toBe(false);
  });
});

describe('hostedApplicationExportRepository', () => {
  it('creates, finds, lists newest first and finds the final export', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const app = await addApplication(fx, 'shop');
    const make = (kind: 'on_demand' | 'final', at: string, requestedByUserId: string | null) =>
      withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        exportsRepo.create(
          {
            workspaceId: fx.workspaceId,
            applicationId: app.id,
            kind,
            requestedByUserId,
            storageKey: `exports/${app.id}/${at}.dump`,
            sizeBytes: BigInt(5_000_000_000),
            expiresAt: new Date('2027-01-01T00:00:00Z'),
          },
          tx,
        ),
      );
    const first = await make('on_demand', 'a', fx.ownerId);
    await new Promise((r) => setTimeout(r, 5));
    const final = await make('final', 'b', null);

    const read = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      exportsRepo.findById(first.id, tx),
    );
    expect(read).toMatchObject({
      kind: 'on_demand',
      requestedByUserId: fx.ownerId,
      sizeBytes: BigInt(5_000_000_000),
    });
    const listed = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      exportsRepo.listByApplication(app.id, tx),
    );
    expect(listed.map((r) => r.id)).toEqual([final.id, first.id]);
    expect(
      (
        await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
          exportsRepo.findFinalByApplication(app.id, tx),
        )
      )?.id,
    ).toBe(final.id);
  });

  it('finds no final export for an application never stopped, and refuses an unknown kind', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const app = await addApplication(fx, 'shop');
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        exportsRepo.findFinalByApplication(app.id, tx),
      ),
    ).toBeNull();
    await expect(
      adminDb.hostedApplicationExport.create({
        data: {
          workspaceId: fx.workspaceId,
          applicationId: app.id,
          kind: 'nightly',
          storageKey: 'k',
          sizeBytes: BigInt(1),
          expiresAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('goes with its application', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACM' });
    const app = await addApplication(fx, 'shop');
    await adminDb.hostedApplicationExport.create({
      data: {
        workspaceId: fx.workspaceId,
        applicationId: app.id,
        kind: 'final',
        storageKey: 'k',
        sizeBytes: BigInt(1),
        expiresAt: new Date(),
      },
    });
    await adminDb.hostedApplication.delete({ where: { id: app.id } });
    expect(await adminDb.hostedApplicationExport.count()).toBe(0);
  });
});
