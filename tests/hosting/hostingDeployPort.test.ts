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
    // Fail closed (MOTIR-9947): no guard image or origin-secret key, no adapter.
    vi.stubEnv('MOTIR_HOSTING_GUARD_IMAGE', '');
    expect(() => getHostingDeployPort('fly')).toThrow(/MOTIR_HOSTING_GUARD_IMAGE/);
    vi.stubEnv('MOTIR_HOSTING_GUARD_IMAGE', 'registry.fly.io/motir-hosting-guard@sha256:g');
    vi.stubEnv('MOTIR_HOSTING_ORIGIN_SECRET_KEY', '');
    expect(() => getHostingDeployPort('fly')).toThrow(/MOTIR_HOSTING_ORIGIN_SECRET_KEY/);
    vi.stubEnv('MOTIR_HOSTING_ORIGIN_SECRET_KEY', 'k');
    expect(getHostingDeployPort('fly').target).toBe('fly');
  });

  it('refuses a target with no registered adapter, and uses one once registered', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    expect(() => getHostingDeployPort('aws')).toThrow(OrchestratorNotConfiguredError);
    const aws = createFakeHostingDeployPort({ target: 'aws' });
    registerHostingAdapter('aws', () => aws);
    expect(getHostingDeployPort('aws')).toBe(aws);
  });

  it('builds the serverless adapter from its scoped role, read at call time (MOTIR-9972)', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN', '');
    expect(() => getHostingDeployPort('serverless')).toThrow(OrchestratorNotConfiguredError);
    expect(() => getHostingDeployPort('serverless')).toThrow(
      /MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN/,
    );
    vi.stubEnv(
      'MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN',
      'arn:aws:iam::212859366014:role/motir-hosting-serverless-deploy',
    );
    // With and without Motir's management key as the identity that assumes it.
    vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', '');
    expect(getHostingDeployPort('serverless').target).toBe('serverless');
    vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', 'AKIA');
    vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', '');
    expect(getHostingDeployPort('serverless', { appPrefix: 'mh-check-' }).target).toBe(
      'serverless',
    );
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::576360162297:role/motir-add-shard');
    expect(getHostingDeployPort('serverless').target).toBe('serverless');
  });

  it('narrows the app prefix for a caller that owns its own apps', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const own = getHostingDeployPort('fly', { appPrefix: 'motir-deploy-check-' });
    expect(own).not.toBe(getHostingDeployPort('fly'));
    expect(getHostingDeployPort('fly', { appPrefix: 'motir-deploy-check-' })).toBe(own);
    const app = await own.ensureApp({ repositoryId: 'x', environment: { kind: 'production' } });
    expect(app.appRef).toBe('motir-deploy-check-x');

    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const factory = vi.fn(() => createFakeHostingDeployPort({ target: 'aws' }));
    registerHostingAdapter('aws', factory);
    getHostingDeployPort('aws', { appPrefix: 'motir-deploy-check-' });
    expect(factory).toHaveBeenCalledWith({ appPrefix: 'motir-deploy-check-' });

    vi.stubEnv('MOTIR_HOSTING_FLY_API_TOKEN', 'token');
    vi.stubEnv('MOTIR_HOSTING_GUARD_IMAGE', 'registry.fly.io/motir-hosting-guard@sha256:g');
    vi.stubEnv('MOTIR_HOSTING_ORIGIN_SECRET_KEY', 'k');
    expect(getHostingDeployPort('fly', { appPrefix: 'motir-deploy-check-' }).target).toBe('fly');
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
