// MOTIR-10034 — a production release's running time, recorded on the release:
// against real Postgres and the deploy port's fake. The first settle reads from
// live_at, the next from where the last stopped; two settles of one window add
// it once; a replacing deploy settles the serving release before the port
// replaces it; a port that cannot answer changes nothing and leaks nothing; and
// nothing here prices the seconds.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostingTarget } from '@/generated/prisma/client';
import type { FakeHostingControls } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { releaseHandleFor, settledWindow, usageWindowStart } from '@/lib/hosting/releaseUsage';
import { resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedReleaseUsageService as usage } from '@/lib/services/hostedReleaseUsageService';
import {
  productionReleaseService,
  type ProductionReleaseDeps,
} from '@/lib/services/productionReleaseService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

const CONNECTION_STRING = /postgres(ql)?:\/\//;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly', 'serverless'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'none' },
};
const DEPS: ProductionReleaseDeps = { readManifest: async () => MANIFEST };

let logged: string[];

function hosting(target: HostingTarget = 'fly') {
  return getHostingDeployPort(target) as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  resetHostingFakes();
  resetDatabaseFakes();
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args
          .map((a) =>
            a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a),
          )
          .join(' '),
      );
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function workspace(identifier = 'ACME'): Promise<WorkItemFixture> {
  return makeWorkItemFixture({ name: identifier, identifier });
}

async function repo(fx: WorkItemFixture, role: 'web' | 'api' = 'web'): Promise<string> {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role, name: `repo-${role}` },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { seedSource: 'initialised', state: 'created', hostingTarget: 'fly' },
  });
  return row.id;
}

const release = (repositoryId: string, commitSha = SHA_A) => ({
  projectRepositoryId: repositoryId,
  commitSha,
  artifactRef: `registry.fly.io/mh-${repositoryId}:${commitSha}`,
  cause: 'merge' as const,
});

async function releaseRow(id: string) {
  return adminDb.hostedRelease.findUniqueOrThrow({ where: { id } });
}

/** Release the repository live, with its live_at on the fake's clock so the
 *  fake's running time is measured from it. */
async function goLive(repositoryId: string, commitSha = SHA_A) {
  const live = await productionReleaseService.deployProductionRelease(
    release(repositoryId, commitSha),
    DEPS,
  );
  expect(live.state).toBe('live');
  await adminDb.hostedRelease.update({
    where: { id: live.id },
    data: { liveAt: hosting().now() },
  });
  return live;
}

let recorded: Array<{ handle: unknown; since: Date }> = [];
const usageCalls = () => recorded;

/** Record every usageSince the fake receives, with its arguments. */
function recordUsageCalls(): void {
  recorded = [];
  const port = hosting();
  const inner = port.usageSince.bind(port);
  vi.spyOn(port, 'usageSince').mockImplementation(async (handle, since) => {
    recorded.push({ handle, since });
    return inner(handle, since);
  });
}

describe('the pure half', () => {
  const facts = {
    liveAt: new Date('2026-01-01T00:00:00Z'),
    usageSettledUntil: null,
    providerReleaseId: 'rel-1',
    providerRef: 'machine-1',
  };

  it('starts the first window at live_at and the next where the last stopped', () => {
    expect(usageWindowStart(facts)).toEqual(facts.liveAt);
    const later = new Date('2026-01-01T01:00:00Z');
    expect(usageWindowStart({ ...facts, usageSettledUntil: later })).toEqual(later);
    expect(usageWindowStart({ ...facts, liveAt: null })).toBeNull();
  });

  it('rebuilds the production handle, and none without the provider ids', () => {
    expect(releaseHandleFor({ target: 'fly', appRef: 'mh-x' }, facts)).toEqual({
      target: 'fly',
      appRef: 'mh-x',
      environment: { kind: 'production' },
      releaseId: 'rel-1',
      providerRef: 'machine-1',
    });
    expect(
      releaseHandleFor({ target: 'fly', appRef: 'mh-x' }, { ...facts, providerRef: null }),
    ).toBe(null);
    expect(
      releaseHandleFor({ target: 'fly', appRef: 'mh-x' }, { ...facts, providerReleaseId: null }),
    ).toBeNull();
  });

  it('settles whole seconds, and never moves the window back before since', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    const until = new Date('2026-01-01T00:02:00Z');
    expect(settledWindow(since, { runningSeconds: 119.9, until })).toEqual({
      seconds: 119,
      settledUntil: until,
    });
    expect(
      settledWindow(since, { runningSeconds: -3, until: new Date('2025-12-31T00:00:00Z') }),
    ).toEqual({ seconds: 0, settledUntil: since });
  });
});

describe('settleReleaseUsage', () => {
  it('settles the first window from live_at with the rebuilt handle', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    const row = await releaseRow(live.id);
    recordUsageCalls();
    hosting().advanceSeconds(120);

    expect(await usage.settleReleaseUsage(live.id)).toEqual({ outcome: 'settled', seconds: 120 });

    expect(usageCalls()).toHaveLength(1);
    expect(usageCalls()[0]).toEqual({
      handle: {
        target: 'fly',
        appRef: `mh-${id}`,
        environment: { kind: 'production' },
        releaseId: row.providerReleaseId,
        providerRef: row.providerRef,
      },
      since: row.liveAt,
    });
    expect(row.providerRef).toBe(`fake-mh-${id}`);
    const after = await releaseRow(live.id);
    expect(after.usageSeconds).toBe(120);
    expect(after.usageSettledUntil).toEqual(hosting().now());
    const [dto] = await hostedApplicationService.listReleases(
      fx.workspaceId,
      after.applicationId,
      10,
    );
    expect(dto).toMatchObject({ id: live.id, usageSeconds: 120 });
  });

  it('starts a second settle where the first stopped, adding only the new window', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    hosting().advanceSeconds(60);
    await usage.settleReleaseUsage(live.id);
    const settledAt = (await releaseRow(live.id)).usageSettledUntil;
    recordUsageCalls();
    hosting().advanceSeconds(45);

    expect(await usage.settleReleaseUsage(live.id)).toEqual({ outcome: 'settled', seconds: 45 });

    expect(usageCalls()[0]!.since).toEqual(settledAt);
    expect((await releaseRow(live.id)).usageSeconds).toBe(105);
  });

  it('adds one window when two settles race, the loser skipping', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    hosting().advanceSeconds(90);

    const outcomes = await Promise.all([
      usage.settleReleaseUsage(live.id),
      usage.settleReleaseUsage(live.id),
    ]);

    // Both interleavings are legal: the second either loses the conditional
    // write (skipped) or reads the first's end and settles an empty window. Either
    // way the window is added once.
    for (const o of outcomes) expect(['settled', 'skipped']).toContain(o.outcome);
    const added = outcomes.reduce((sum, o) => sum + (o.outcome === 'settled' ? o.seconds : 0), 0);
    expect(added).toBe(90);
    expect((await releaseRow(live.id)).usageSeconds).toBe(90);
  });

  it('skips, adding nothing, when another settle wrote the window while it read the port', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    hosting().advanceSeconds(70);
    const port = hosting();
    const inner = port.usageSince.bind(port);
    let raced = false;
    vi.spyOn(port, 'usageSince').mockImplementation(async (handle, since) => {
      const answer = await inner(handle, since);
      if (!raced) {
        raced = true;
        expect(await usage.settleReleaseUsage(live.id)).toEqual({
          outcome: 'settled',
          seconds: 70,
        });
      }
      return answer;
    });

    expect(await usage.settleReleaseUsage(live.id)).toEqual({ outcome: 'skipped' });
    expect((await releaseRow(live.id)).usageSeconds).toBe(70);
  });

  it('writes nothing and leaks nothing when the port cannot answer', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    hosting().advanceSeconds(30);
    await usage.settleReleaseUsage(live.id);
    const before = await releaseRow(live.id);
    const secret = 'postgresql://app:hunter2@db.internal/app';
    vi.spyOn(hosting(), 'usageSince').mockRejectedValue(
      Object.assign(new Error(`cannot reach ${secret}`), { code: 'FLY_DOWN' }),
    );
    hosting().advanceSeconds(30);

    expect(await usage.settleReleaseUsage(live.id)).toEqual({ outcome: 'unavailable' });

    const after = await releaseRow(live.id);
    expect(after.usageSeconds).toBe(before.usageSeconds);
    expect(after.usageSettledUntil).toEqual(before.usageSettledUntil);
    expect(after.state).toBe('live');
    const text = logged.join('\n');
    expect(text).not.toMatch(CONNECTION_STRING);
    expect(text).not.toContain('hunter2');
    expect(text).toContain('FLY_DOWN');
  });

  it('keeps an unnamed failure to its class name, and an unknown one to UNKNOWN', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    const spy = vi.spyOn(hosting(), 'usageSince');

    spy.mockRejectedValueOnce(new TypeError('postgres://leak'));
    expect(await usage.settleReleaseUsage(live.id)).toEqual({ outcome: 'unavailable' });
    spy.mockRejectedValueOnce('a bare string postgres://leak');
    expect(await usage.settleReleaseUsage(live.id)).toEqual({ outcome: 'unavailable' });

    expect(logged.join('\n')).toContain('TypeError');
    expect(logged.join('\n')).toContain('UNKNOWN');
    expect(logged.join('\n')).not.toMatch(CONNECTION_STRING);
    expect((await releaseRow(live.id)).usageSeconds).toBeNull();
  });

  it('returns unavailable, writing nothing, when the usage cannot be recorded', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    hosting().advanceSeconds(10);
    const { hostedReleaseRepository } = await import('@/lib/repositories/hostedReleaseRepository');
    vi.spyOn(hostedReleaseRepository, 'addSettledUsage').mockRejectedValueOnce(
      new Error('postgresql://db down'),
    );

    expect(await usage.settleReleaseUsage(live.id)).toEqual({ outcome: 'unavailable' });

    expect((await releaseRow(live.id)).usageSeconds).toBeNull();
    expect(logged.join('\n')).toContain('record');
    expect(logged.join('\n')).not.toMatch(CONNECTION_STRING);
  });

  it('settles nothing for a release that is gone, not live, or has no handle', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const live = await goLive(id);
    recordUsageCalls();

    expect(await usage.settleReleaseUsage('missing')).toEqual({ outcome: 'not_live' });
    await adminDb.hostedRelease.update({ where: { id: live.id }, data: { providerRef: null } });
    expect(await usage.settleReleaseUsage(live.id)).toEqual({ outcome: 'not_live' });
    await adminDb.hostedRelease.update({ where: { id: live.id }, data: { state: 'replaced' } });
    expect(await usage.settleReleaseUsage(live.id)).toEqual({ outcome: 'not_live' });

    expect(usageCalls()).toHaveLength(0);
  });

  it('settles one application without touching another in the same project', async () => {
    const fx = await workspace();
    const web = await repo(fx, 'web');
    const api = await repo(fx, 'api');
    const a = await goLive(web);
    const b = await goLive(api);
    hosting().advanceSeconds(50);

    await usage.settleReleaseUsage(a.id);

    expect((await releaseRow(a.id)).usageSeconds).toBe(50);
    const other = await releaseRow(b.id);
    expect(other.usageSeconds).toBeNull();
    expect(other.usageSettledUntil).toBeNull();
  });
});

describe('a replacing deploy', () => {
  it('settles the serving release before the port deploys its replacement', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const first = await goLive(id);
    hosting().advanceSeconds(200);
    const callsBefore = hosting().calls.length;

    const second = await productionReleaseService.deployProductionRelease(release(id, SHA_B), DEPS);

    const ops = hosting()
      .calls.slice(callsBefore)
      .map((c) => c.operation);
    expect(ops.indexOf('usageSince')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('usageSince')).toBeLessThan(ops.indexOf('deploy'));
    const replaced = await releaseRow(first.id);
    expect(replaced.state).toBe('replaced');
    expect(replaced.usageSeconds).toBe(200);
    expect(second.state).toBe('live');
  });

  it('makes no usage call for a first release, with nothing live', async () => {
    const fx = await workspace();
    const id = await repo(fx);

    await productionReleaseService.deployProductionRelease(release(id), DEPS);

    expect(hosting().calls.map((c) => c.operation)).not.toContain('usageSince');
  });

  it('keeps the settled seconds when the replacement fails, and settles only later time after', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const first = await goLive(id);
    hosting().advanceSeconds(100);
    hosting().failNext('deploy');

    const failed = await productionReleaseService.deployProductionRelease(release(id, SHA_B), DEPS);

    expect(failed.state).toBe('failed');
    const serving = await releaseRow(first.id);
    expect(serving.state).toBe('live');
    expect(serving.usageSeconds).toBe(100);

    hosting().advanceSeconds(25);
    expect(await usage.settleReleaseUsage(first.id)).toEqual({ outcome: 'settled', seconds: 25 });
    expect((await releaseRow(first.id)).usageSeconds).toBe(125);
  });

  it('still deploys when the serving release’s usage cannot be read', async () => {
    const fx = await workspace();
    const id = await repo(fx);
    const first = await goLive(id);
    vi.spyOn(hosting(), 'usageSince').mockRejectedValue(new Error('postgres://down'));

    const second = await productionReleaseService.deployProductionRelease(release(id, SHA_B), DEPS);

    expect(second.state).toBe('live');
    expect((await releaseRow(first.id)).usageSeconds).toBeNull();
    expect(logged.join('\n')).not.toMatch(CONNECTION_STRING);
  });
});

describe('boundaries', () => {
  it('prices nothing and writes nowhere but hosted_release', () => {
    const source = readFileSync('lib/services/hostedReleaseUsageService.ts', 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    for (const banned of [/credit/i, /ledger/i, /wallet/i, /billing/i, /meter/i, /pric/i]) {
      expect(
        imports.filter((i) => banned.test(i)),
        String(banned),
      ).toEqual([]);
    }
    expect(imports.filter((i) => i.includes('/repositories/'))).toEqual([
      '@/lib/repositories/hostedReleaseRepository',
    ]);
    expect(source).not.toMatch(/@\/lib\/db['/]/);
  });
});
