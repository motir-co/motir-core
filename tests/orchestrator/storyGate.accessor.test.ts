// MOTIR-9976 — the story gate's app-side half: the serverless deploy port and
// the database port as callers get them, through the composition roots. A
// refused manifest is refused by name before any provider call, and an unset
// variable is named, never its value. Pure: no database, no network; the
// serverless port is backed by the in-memory account the adapter's own tests use.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OrchestratorNotConfiguredError,
  ReleaseRuntimeRefusedError,
  createServerlessHostingDeployPort,
  getDatabasePort,
  getHostingDeployPort,
  registerHostingAdapter,
  resetDatabaseFakes,
  resetHostingFakes,
  unregisterDatabaseAdapter,
  unregisterHostingAdapter,
  type DeployReleaseInput,
  type ReleaseRuntime,
  type ServerlessSdkClientFactory,
} from '@/lib/orchestrator';

const simPath = '../../packages/orchestrator/test/contract/hostingLambdaSim';
interface LambdaSim {
  readonly clientFactory: ServerlessSdkClientFactory;
  callCount(): number;
}
let createLambdaSim: (clock: () => number) => LambdaSim;
let SIM_ACCOUNT: string;

beforeAll(async () => {
  ({ createLambdaSim, SIM_ACCOUNT } = (await import(/* @vite-ignore */ simPath)) as {
    createLambdaSim: typeof createLambdaSim;
    SIM_ACCOUNT: string;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  unregisterHostingAdapter('serverless');
  unregisterDatabaseAdapter('neon');
  resetHostingFakes();
  resetDatabaseFakes();
});

/** The serverless port as the accessor returns it, over a fresh account. */
function serverlessThroughAccessor(): LambdaSim {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  const sim = createLambdaSim(() => Date.parse('2026-10-28T00:00:00.000Z'));
  registerHostingAdapter('serverless', ({ appPrefix }) =>
    createServerlessHostingDeployPort(
      {
        roleArn: `arn:aws:iam::${SIM_ACCOUNT}:role/motir-hosting-serverless-deploy`,
        accountId: SIM_ACCOUNT,
        region: 'us-east-1',
        appPrefix: appPrefix ?? 'mh-',
      },
      { clientFactory: sim.clientFactory, sleep: async () => {} },
    ),
  );
  return sim;
}

function release(requires: ReleaseRuntime['requires'] | undefined): DeployReleaseInput {
  return {
    appRef: 'mh-cmgate1',
    environment: { kind: 'production' },
    artifact: {
      kind: 'image',
      ref: `${SIM_ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/mh/cmgate1/production`,
      digest: 'sha256:abc',
    },
    runtime: {
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: 'node server.js',
      database: { kind: 'none' },
      ...(requires ? { requires } : {}),
    },
    env: [],
    idle: { mode: 'suspend', idleSeconds: 300 },
  };
}

describe('the serverless refusals through getHostingDeployPort', () => {
  it.each([
    ['requires.backgroundWork', { websockets: true, backgroundWork: true }],
    ['requires.websockets', { websockets: true, backgroundWork: false }],
    ['requires', undefined],
  ] as const)('refuses %s by name, naming Fly, with no provider call', async (field, requires) => {
    const sim = serverlessThroughAccessor();
    const port = getHostingDeployPort('serverless');
    const refused = await port.deploy(release(requires)).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ReleaseRuntimeRefusedError);
    expect(refused).toMatchObject({ target: 'serverless', field });
    expect((refused as Error).message).toMatch(/\bfly\b/);
    expect(sim.callCount()).toBe(0);
  });

  it('accepts the same release over HTTP only, so the refusals are the cause', async () => {
    const sim = serverlessThroughAccessor();
    const port = getHostingDeployPort('serverless');
    await port.ensureApp({ repositoryId: 'cmgate1', environment: { kind: 'production' } });
    await expect(
      port.deploy(release({ websockets: false, backgroundWork: false })),
    ).resolves.toMatchObject({ target: 'serverless', appRef: 'mh-cmgate1' });
    expect(sim.callCount()).toBeGreaterThan(0);
  });
});

describe('unset provider variables', () => {
  it('the serverless port names its role variable, and never a value', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN', '');
    expect(() => getHostingDeployPort('serverless')).toThrow(OrchestratorNotConfiguredError);
    expect(() => getHostingDeployPort('serverless')).toThrow(
      /MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN/,
    );
    vi.stubEnv('MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN', 'not-an-arn-secretish-4711');
    const malformed = (() => {
      try {
        getHostingDeployPort('serverless');
      } catch (err) {
        return err as Error;
      }
    })();
    expect(malformed).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(malformed?.message).toMatch(/MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN/);
    expect(malformed?.message).not.toContain('secretish-4711');
  });

  it('the database port names each Neon variable, and never a value', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('MOTIR_HOSTING_NEON_API_KEY', '');
    vi.stubEnv('MOTIR_HOSTING_NEON_ORG_ID', 'org-gate-value-1');
    const noKey = (() => {
      try {
        getDatabasePort();
      } catch (err) {
        return err as Error;
      }
    })();
    expect(noKey).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(noKey?.message).toMatch(/MOTIR_HOSTING_NEON_API_KEY/);
    expect(noKey?.message).not.toContain('org-gate-value-1');

    vi.stubEnv('MOTIR_HOSTING_NEON_API_KEY', 'napi_gate_value_2');
    vi.stubEnv('MOTIR_HOSTING_NEON_ORG_ID', '');
    const noOrg = (() => {
      try {
        getDatabasePort();
      } catch (err) {
        return err as Error;
      }
    })();
    expect(noOrg).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(noOrg?.message).toMatch(/MOTIR_HOSTING_NEON_ORG_ID/);
    expect(noOrg?.message).not.toContain('napi_gate_value_2');
  });
});
