import { describe, expect, it } from 'vitest';
import {
  CustomerRepositoryRefusedError,
  ReleaseShapeRequiredError,
  type DeployReleaseInput,
  type HostingEnvironment,
  type ReleaseHandle,
  type ReleaseShape,
  type ReleaseUsage,
} from '../src/index';
import {
  AWS_CUSTOMER,
  awsAdapterHarness,
  tenantSnapshot,
  type AwsAdapterHarness,
} from './contract/awsHostingHarness';

// A RUN CUT OFF AT EVERY STEP RESUMES TO THE SAME END (MOTIR-10012). For each
// shape, the uninterrupted run of an operation is recorded call by call across
// all eight tenant clients; then, for every position N, a fresh account fails
// the Nth call — `before` it acts (the request never landed) and `after` (it
// landed, the answer was lost) — the same request is replayed, and what the
// account holds is deep-compared with the uninterrupted run's: every stack with
// its parameters, tags and outputs, every function version, service, task
// definition, running task, listener rule, SSM parameter, secret, role and
// database. An extra object of any name fails the comparison. Then one more
// replay must change nothing.

const APP = 'mh-cmrepo1';
const PREVIEW_APP = 'mh-cmrepo1-pr4';
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 4 };
const SHAPES: readonly ReleaseShape[] = ['function', 'container'];
const MODES = ['before', 'after'] as const;

function release(
  shape: ReleaseShape | undefined,
  overrides: Partial<DeployReleaseInput> = {},
): DeployReleaseInput {
  return {
    appRef: APP,
    environment: PRODUCTION,
    artifact: { kind: 'image', ref: 'release-1', digest: 'sha256:aaa' },
    runtime: {
      port: 3000,
      healthCheck: { path: '/healthz' },
      startCommand: 'node server.js',
      database: { kind: 'postgres' },
    },
    env: [{ name: 'NODE_ENV', value: 'production', secret: false }],
    size: 'small',
    idle: shape === 'container' ? { mode: 'always_on' } : { mode: 'suspend', idleSeconds: 300 },
    ...(shape ? { shape } : {}),
    ...overrides,
  };
}

const previewRelease = (shape: ReleaseShape) =>
  release(shape, { appRef: PREVIEW_APP, environment: PREVIEW });

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function attempt<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

interface Sweep<C, T> {
  /** What exists before the operation, run uninterrupted. */
  setup(h: AwsAdapterHarness): Promise<C>;
  operation(h: AwsAdapterHarness, context: C): Promise<T>;
}

interface SweepResult<T> {
  readonly clean: { value: T; calls: readonly string[]; end: ReturnType<typeof tenantSnapshot> };
  /** Per cut: the position, the mode, the cut attempt and what the caller got. */
  readonly cuts: Array<{
    n: number;
    when: 'before' | 'after';
    delivered: T[];
    h: AwsAdapterHarness;
  }>;
}

/** Runs the operation uninterrupted, then cut at every call position in both
 *  modes, replaying after each cut until it answers, and checks that the
 *  account ends where the uninterrupted run left it — and stays there. */
async function sweep<C, T>(s: Sweep<C, T>): Promise<SweepResult<T>> {
  const reference = awsAdapterHarness();
  const context = await s.setup(reference);
  const start = reference.recorder.calls.length;
  const value = await s.operation(reference, context);
  const calls = reference.recorder.calls.slice(start);
  const end = tenantSnapshot(reference.fakes);
  expect(calls.length).toBeGreaterThan(0);

  const cuts: SweepResult<T>['cuts'] = [];
  for (let n = 1; n <= calls.length; n += 1) {
    for (const when of MODES) {
      const h = awsAdapterHarness();
      const c = await s.setup(h);
      const before = h.recorder.calls.length;
      h.recorder.failAt(n, when);
      const cut = await attempt(() => s.operation(h, c));
      // The fault fired: the run reached the Nth call.
      expect(h.recorder.calls.length - before, `${when} ${n}`).toBeGreaterThanOrEqual(n);
      // The caller gets an answer once: from the cut attempt if it survived the
      // fault, else from the replay.
      const delivered = cut.ok ? [cut.value] : [await s.operation(h, c)];
      expect.soft(tenantSnapshot(h.fakes), `${when} ${n} (${calls[n - 1]})`).toEqual(end);
      // A further repeat changes nothing.
      await attempt(() => s.operation(h, c));
      expect(tenantSnapshot(h.fakes), `${when} ${n} repeated`).toEqual(end);
      cuts.push({ n, when, delivered, h });
    }
  }
  return { clean: { value, calls, end }, cuts };
}

const stackNames = (end: ReturnType<typeof tenantSnapshot>) => end.stacks.map((s) => s.name);

describe.each(SHAPES)('the %s shape', (shape) => {
  it('a deploy cut off at every call resumes to the same release and one of everything', async () => {
    const { clean, cuts } = await sweep<null, ReleaseHandle>({
      setup: async () => null,
      operation: (h) => h.port.deploy(release(shape)),
    });

    // The uninterrupted run's account: one network stack, one registry stack,
    // one database stack, one release stack, and nothing else.
    expect(stackNames(clean.end)).toEqual([
      'motir-database-cmrepo1',
      'motir-network',
      'motir-registry-cmrepo1',
      `motir-release-${APP}`,
    ]);
    const network = clean.end.stacks.find((s) => s.name === 'motir-network')!;
    expect(network.outputs).toMatchObject({
      AlbArn: expect.stringContaining(':loadbalancer/app/motir-tenant/'),
      AlbListenerArn: expect.stringContaining(':listener/app/motir-tenant/'),
    });
    const registry = clean.end.stacks.find((s) => s.name === 'motir-registry-cmrepo1')!;
    expect(registry.outputs).toEqual({
      PreviewRepositoryUri: expect.stringMatching(/\/mh\/cmrepo1\/preview$/),
      ProductionRepositoryUri: expect.stringMatching(/\/mh\/cmrepo1\/production$/),
      PreviewPushRoleArn: expect.stringMatching(/:role\/mh-cmrepo1-preview-push$/),
      ProductionPushRoleArn: expect.stringMatching(/:role\/mh-cmrepo1-production-push$/),
    });
    if (shape === 'container') {
      expect(clean.end.services.map((s) => s.name)).toEqual([APP]);
      expect(clean.end.listenerRules.map(([app]) => app)).toEqual([APP]);
      const releaseStack = clean.end.stacks.find((s) => s.name === `motir-release-${APP}`)!;
      expect(releaseStack.outputs['TargetGroupArn']).toMatch(/:targetgroup\/mh-cmrepo1\//);
      expect(clean.end.functions).toEqual([]);
    } else {
      expect(clean.end.functions.map((f) => f.name)).toEqual([APP]);
      expect(clean.end.services).toEqual([]);
      expect(clean.end.listenerRules).toEqual([]);
    }

    for (const cut of cuts) {
      expect(
        cut.delivered.map((d) => d.releaseId),
        `${cut.when} ${cut.n}`,
      ).toEqual([clean.value.releaseId]);
      expect((await cut.h.port.describe(clean.value)).state).toBe('healthy');
    }
  });

  it('a destroy cut off at every call ends with the release gone and its usage returned once', async () => {
    const { clean, cuts } = await sweep({
      setup: async (h) => {
        const handle = await h.port.deploy(release(shape));
        h.advanceSeconds(600);
        return handle;
      },
      operation: (h, handle) => h.port.destroy(handle, 'retired'),
    });

    expect(stackNames(clean.end)).toEqual([
      'motir-database-cmrepo1',
      'motir-network',
      'motir-registry-cmrepo1',
    ]);
    expect(clean.value.runningSeconds).toBe(600);
    for (const cut of cuts) {
      expect(cut.delivered, `${cut.when} ${cut.n}`).toHaveLength(1);
      expectSameUsage(cut.delivered[0]!, clean.value, `${cut.when} ${cut.n}`);
    }
  });

  it("a preview's destroy cut off at every call drops its database and leaves production's", async () => {
    const { clean, cuts } = await sweep({
      setup: async (h) => {
        await h.port.deploy(release(shape));
        const preview = await h.port.deploy(previewRelease(shape));
        h.advanceSeconds(300);
        return preview;
      },
      operation: (h, preview) => h.port.destroy(preview, 'pull_request_closed'),
    });

    expect(stackNames(clean.end)).toEqual([
      'motir-database-cmrepo1',
      'motir-network',
      'motir-registry-cmrepo1',
      `motir-release-${APP}`,
    ]);
    expect(clean.end.databases.map(([name]) => name)).toEqual(['app']);
    expect(clean.end.databaseRoles.some((role) => role.includes('pr4'))).toBe(false);
    expect(clean.end.secrets.some((arn) => arn.includes('preview-4'))).toBe(false);
    for (const cut of cuts) {
      expect(cut.delivered, `${cut.when} ${cut.n}`).toHaveLength(1);
      expectSameUsage(cut.delivered[0]!, clean.value, `${cut.when} ${cut.n}`);
      expect((await cut.h.port.listReleases({ appRef: APP })).map((r) => r.state)).toEqual([
        'healthy',
      ]);
    }
  });

  it('a destroyApp cut off at every call removes the release and database stacks only', async () => {
    const { clean, cuts } = await sweep({
      setup: async (h) => {
        await h.port.deploy(release(shape));
        h.advanceSeconds(120);
        return null;
      },
      operation: (h) => h.port.destroyApp({ appRef: APP }),
    });

    expect(stackNames(clean.end)).toEqual(['motir-network', 'motir-registry-cmrepo1']);
    expect(clean.value).toHaveLength(1);
    for (const cut of cuts) {
      const usages = cut.delivered.flat();
      expect.soft(usages, `${cut.when} ${cut.n}`).toHaveLength(1);
      if (usages[0]) expectSameUsage(usages[0], clean.value[0]!, `${cut.when} ${cut.n}`);
    }
  });

  it('no shape, a customer repository and a held account make no AWS call', async () => {
    const h = awsAdapterHarness();
    await expect(h.port.deploy(release(undefined))).rejects.toBeInstanceOf(
      ReleaseShapeRequiredError,
    );
    await expect(
      h.port.deploy(release(shape, { appRef: `mh-${AWS_CUSTOMER}` })),
    ).rejects.toBeInstanceOf(CustomerRepositoryRefusedError);
    h.state.ready = false;
    const held = await h.port.deploy(release(shape));
    expect((await h.port.describe(held)).state).toBe('waiting_for_account');
    expect(h.recorder.calls).toEqual([]);
  });
});

/** The same usage as the uninterrupted run: one record, same release, same
 *  running time and compute. */
function expectSameUsage(actual: ReleaseUsage, expected: ReleaseUsage, label: string): void {
  expect
    .soft(
      {
        releaseId: actual.releaseId,
        runningSeconds: actual.runningSeconds,
        compute: actual.compute,
      },
      label,
    )
    .toEqual({
      releaseId: expected.releaseId,
      runningSeconds: expected.runningSeconds,
      compute: expected.compute,
    });
}
