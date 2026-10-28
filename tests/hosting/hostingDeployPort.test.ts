// MOTIR-5773 — the hosting deploy port's composition: which adapter
// `getHostingDeployPort(target)` returns, and the typed not-configured error when
// a target has none. Pure: no database, no network.
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { HostingManifest } from '@/lib/hosting/manifest';
import {
  OrchestratorNotConfiguredError,
  createFakeHostingDeployPort,
  getHostingDeployPort,
  registerHostingAdapter,
  resetHostingFakes,
  unregisterHostingAdapter,
  type ReleaseRuntime,
} from '@/lib/orchestrator';

afterEach(() => {
  vi.unstubAllEnvs();
  unregisterHostingAdapter('aws');
  resetHostingFakes();
});

describe('getHostingDeployPort', () => {
  it('returns one fake per target while the fake is selected', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const fly = getHostingDeployPort('fly');
    expect(fly.target).toBe('fly');
    expect(getHostingDeployPort('fly')).toBe(fly);
    expect(getHostingDeployPort('aws').target).toBe('aws');
  });

  it('builds the Fly adapter from MOTIR_HOSTING_FLY_API_TOKEN, read at call time', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('MOTIR_HOSTING_FLY_API_TOKEN', '');
    expect(() => getHostingDeployPort('fly')).toThrow(OrchestratorNotConfiguredError);
    expect(() => getHostingDeployPort('fly')).toThrow(/MOTIR_HOSTING_FLY_API_TOKEN/);
    vi.stubEnv('MOTIR_HOSTING_FLY_API_TOKEN', 'token');
    expect(getHostingDeployPort('fly').target).toBe('fly');
  });

  it('refuses a target with no registered adapter, and uses one once registered', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    expect(() => getHostingDeployPort('aws')).toThrow(OrchestratorNotConfiguredError);
    expect(() => getHostingDeployPort('serverless')).toThrow(/no serverless hosting adapter/);
    const aws = createFakeHostingDeployPort({ target: 'aws' });
    registerHostingAdapter('aws', () => aws);
    expect(getHostingDeployPort('aws')).toBe(aws);
  });
});

describe('the manifest is the port’s runtime input', () => {
  it('a HostingManifest satisfies ReleaseRuntime', () => {
    expectTypeOf<HostingManifest>().toMatchTypeOf<ReleaseRuntime>();
    const manifest: HostingManifest = {
      schemaVersion: 1,
      targets: ['fly'],
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: '/whoami',
      buildCommand: 'echo prebuilt',
      requires: { websockets: false, backgroundWork: false },
      database: { kind: 'none' },
    };
    // Compiles only while the two agree — `pnpm typecheck` is the drift guard.
    const runtime: ReleaseRuntime = manifest;
    expect(runtime.port).toBe(8080);
  });
});
