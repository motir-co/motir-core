import { afterEach, describe, expect, it, vi } from 'vitest';
import { ecsDeploymentStatusProvider } from '@/lib/deployment/adapters/ecs/ecsServicesStatus';
import { deploymentStatusProvider, usingFakeDeploymentStatus } from '@/lib/deployment/providers';

// THE DEPLOYMENT-STATUS BINDING (MOTIR-7332, MOTIR-10952): which provider a
// deployment gets, and that the E2E fake can never arm in a real production build.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('deploymentStatusProvider', () => {
  it('binds nothing off a managed host — a self-hosted install has no provider', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '');
    vi.stubEnv('AWS_EXECUTION_ENV', '');
    expect(await deploymentStatusProvider()).toBeNull();
  });

  it('binds nothing on a host that is not Fargate (a Lambda, an EC2 box)', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '');
    vi.stubEnv('AWS_EXECUTION_ENV', 'AWS_ECS_EC2');
    expect(await deploymentStatusProvider()).toBeNull();
  });

  it('binds the ECS adapter on Fargate', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '');
    vi.stubEnv('AWS_EXECUTION_ENV', 'AWS_ECS_FARGATE');
    expect(await deploymentStatusProvider()).toBe(ecsDeploymentStatusProvider);
  });

  it('binds the fake under the E2E flag: two healthy services, each steady on its own release', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '1');
    vi.stubEnv('AWS_EXECUTION_ENV', '');
    expect(usingFakeDeploymentStatus()).toBe(true);
    const provider = await deploymentStatusProvider();
    expect(provider).not.toBe(ecsDeploymentStatusProvider);
    expect(provider?.configured()).toBe(true);
    const status = await provider?.read();
    expect(status?.groups).toHaveLength(2);
    expect(status).not.toHaveProperty('releases');
    for (const group of status?.groups ?? []) {
      expect(group.started).toBe(group.expected);
      expect(group.release).toEqual(expect.any(String));
      expect(group.rolling).toBe(false);
    }
  });

  it('⚠️ IGNORES the flag in a production build without the E2E harness', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '1');
    vi.stubEnv('AWS_EXECUTION_ENV', 'AWS_ECS_FARGATE');
    expect(usingFakeDeploymentStatus()).toBe(false);
    expect(await deploymentStatusProvider()).toBe(ecsDeploymentStatusProvider);
  });

  it('arms in a production build only when the E2E harness is ALSO set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '1');
    expect(usingFakeDeploymentStatus()).toBe(true);
  });
});
