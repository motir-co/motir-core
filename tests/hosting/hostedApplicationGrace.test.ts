import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: vi.fn(async () => undefined) }));

import { db } from '@/lib/db';
import { HostedApplicationHandoverError } from '@/lib/hosting/errors';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { resetHostingFakes } from '@/lib/orchestrator/hosting';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import { hostedApplicationHandoverService } from '@/lib/services/hostedApplicationHandoverService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The grace window's service outcomes (Story MOTIR-9800 · MOTIR-12132) that the
// takeover saga's suite does not reach: the rows the window does not apply to, a
// repository never realized on GitHub, a re-run, and `startGrace` on its own.
// Real Postgres; the hosting port is the orchestrator's fake; the job queue is
// a recording stub. No call here reaches GitHub: a stray fetch fails the test.

const DAY = 86_400_000;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  resetHostingFakes();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  vi.mocked(sendEvent).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A Motir repository row with NO realized GitHub repository, and (unless told
 *  otherwise) its application on `target` in `state`. */
async function seedRow(
  fx: WorkItemFixture,
  opts: {
    target?: 'fly' | 'serverless' | 'aws';
    state?: 'live' | 'handing_over' | 'grace' | 'handed_over';
    application?: boolean;
    seedSource?: string;
  } = {},
) {
  seq += 1;
  const repo = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: `web-${seq}`,
      position: `g${seq}`,
      seedSource: opts.seedSource ?? 'initialised',
      state: 'created',
    },
  });
  if (opts.application === false) return { rowId: repo.id, applicationId: null };
  const at = new Date('2026-11-01T00:00:00Z');
  const app = await adminDb.hostedApplication.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectRepositoryId: repo.id,
      target: opts.target ?? 'fly',
      slug: `web-${seq}`,
      state: opts.state ?? 'live',
      productionEnabledAt: at,
      productionTokenMintedAt: at,
    },
  });
  return { rowId: repo.id, applicationId: app.id };
}

const application = (id: string) => adminDb.hostedApplication.findUniqueOrThrow({ where: { id } });

describe('prepareForTransfer', () => {
  it('freezes and revokes for a repository never realized, with no GitHub call, and answers the same on a re-run', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId, applicationId } = await seedRow(fx);
    const first = await hostedApplicationHandoverService.prepareForTransfer(rowId);
    expect(first).toEqual({ outcome: 'prepared', applicationId });
    expect((await application(applicationId!)).state).toBe('handing_over');
    const again = await hostedApplicationHandoverService.prepareForTransfer(rowId);
    expect(again).toEqual(first);
    expect((await application(applicationId!)).state).toBe('handing_over');
  });

  it.each([
    ['an unknown row', async () => ({ rowId: 'no-such-row' })],
    ['an AWS application', async (fx: WorkItemFixture) => seedRow(fx, { target: 'aws' })],
    [
      'a row with no application',
      async (fx: WorkItemFixture) => seedRow(fx, { application: false }),
    ],
    [
      'a customer repository',
      async (fx: WorkItemFixture) => seedRow(fx, { seedSource: SEED_SOURCE_ORGANIZATION }),
    ],
  ])('does not apply to %s', async (_label, seed) => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await seed(fx);
    expect(await hostedApplicationHandoverService.prepareForTransfer(rowId)).toEqual({
      outcome: 'not_applicable',
    });
  });

  it.each(['grace', 'handed_over'] as const)(
    'answers past_transfer for an application already in %s, changing nothing',
    async (state) => {
      const fx = await makeWorkItemFixture();
      const { rowId, applicationId } = await seedRow(fx, { state });
      expect(await hostedApplicationHandoverService.prepareForTransfer(rowId)).toEqual({
        outcome: 'past_transfer',
      });
      expect((await application(applicationId!)).state).toBe(state);
    },
  );

  it('names the step in the typed error, whatever was thrown', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await seedRow(fx);
    const { hostedApplicationRepository } =
      await import('@/lib/repositories/hostedApplicationRepository');
    const spy = vi
      .spyOn(hostedApplicationRepository, 'setStateIfIn')
      .mockRejectedValueOnce('not an Error');
    const error = await hostedApplicationHandoverService
      .prepareForTransfer(rowId)
      .catch((e: unknown) => e);
    spy.mockRestore();
    expect(error).toBeInstanceOf(HostedApplicationHandoverError);
    expect((error as HostedApplicationHandoverError).message).toContain('set_state');
  });
});

describe('cancelPreparation', () => {
  it('restores a handing-over application and forgets production enablement', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId, applicationId } = await seedRow(fx, { state: 'handing_over' });
    expect(await hostedApplicationHandoverService.cancelPreparation(rowId)).toEqual({
      outcome: 'restored',
      applicationId,
    });
    expect(await application(applicationId!)).toMatchObject({
      state: 'live',
      productionEnabledAt: null,
      productionTokenMintedAt: null,
    });
  });

  it('leaves a live application and its enablement alone', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId, applicationId } = await seedRow(fx);
    expect(await hostedApplicationHandoverService.cancelPreparation(rowId)).toEqual({
      outcome: 'not_handing_over',
      applicationId,
    });
    expect((await application(applicationId!)).productionEnabledAt).not.toBeNull();
  });

  it('does not apply to an unknown row', async () => {
    expect(await hostedApplicationHandoverService.cancelPreparation('nope')).toEqual({
      outcome: 'not_applicable',
    });
  });
});

describe('startGrace on its own', () => {
  const transferredAt = new Date('2026-11-20T10:00:00Z');

  it('opens the 30-day window and enqueues one transferred notice, keyed by the application', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId, applicationId } = await seedRow(fx, { state: 'handing_over' });
    const started = await hostedApplicationHandoverService.startGrace(rowId, transferredAt);
    expect(started).toMatchObject({ outcome: 'started', applicationId });
    expect(await application(applicationId!)).toMatchObject({
      state: 'grace',
      stopsAt: new Date(transferredAt.getTime() + 30 * DAY),
    });
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith('hosting.application-grace.notice', {
      workspaceId: fx.workspaceId,
      applicationId,
      kind: 'transferred',
      idempotencyKey: `${applicationId}:transferred`,
    });

    const again = await hostedApplicationHandoverService.startGrace(rowId, new Date());
    expect(again).toEqual({ outcome: 'already_started', applicationId, notice: null });
    expect((await application(applicationId!)).stopsAt).toEqual(
      new Date(transferredAt.getTime() + 30 * DAY),
    );
    expect(sendEvent).toHaveBeenCalledTimes(1);
  });

  it('does not apply to an unknown row or an AWS application, and sends nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId, applicationId } = await seedRow(fx, { target: 'aws' });
    for (const id of ['nope', rowId]) {
      expect(await hostedApplicationHandoverService.startGrace(id, transferredAt)).toEqual({
        outcome: 'not_applicable',
        notice: null,
      });
    }
    expect((await application(applicationId!)).state).toBe('live');
    expect(sendEvent).not.toHaveBeenCalled();
  });
});
