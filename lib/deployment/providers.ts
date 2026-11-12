import 'server-only';

import { deploymentIdentity } from '@/lib/deployment/identity';
import { isE2EProdHarness } from '@/lib/e2eProdHarness';
import type { DeploymentStatusProvider } from '@/lib/deployment/deploymentStatus';

// THE DEPLOYMENT-STATUS BINDING (MOTIR-7332): the same shape as
// `lib/publicAddresses/providers.ts`. One place chooses between the platform's
// adapter, an in-memory fake for the E2E lane, and nothing at all.
//
// ⚠️ THE FAKE CANNOT ARM IN A REAL PRODUCTION BUILD. A fake reporting a healthy
// fleet in production would paint the Hosting card green while a service is
// down, which is the blindness this card exists to end. So the flag is read at
// call time and refused when `NODE_ENV === 'production'` unless the E2E harness
// is ALSO set (`lib/e2eProdHarness.ts`, set by a Playwright config and nothing
// else): arming it in a real deployment takes two misconfigurations, not one.

const FAKE_FLAG = 'MOTIR_E2E_FAKE_DEPLOYMENT_STATUS';

/** Is the in-memory binding armed? Never true in a real production build. */
export function usingFakeDeploymentStatus(): boolean {
  if (process.env.NODE_ENV === 'production' && !isE2EProdHarness()) return false;
  return process.env[FAKE_FLAG] === '1';
}

/**
 * The fake: two healthy services, each steady on its own release.
 *
 * Happy path only, deliberately. The short-group, mixed-release and failed-read
 * arms are proved at the service tier with a stubbed provider; the lane's job is
 * to show the card populated.
 */
const fakeDeploymentStatusProvider: DeploymentStatusProvider = {
  configured: () => true,
  read: async () => ({
    groups: [
      { name: 'web', started: 2, total: 2, expected: 2, release: 'web:e2e', rolling: false },
      {
        name: 'worker',
        started: 1,
        total: 1,
        expected: 1,
        release: 'worker:e2e',
        rolling: false,
      },
    ],
  }),
};

/**
 * The provider this deployment should use, or `null` when it runs somewhere no
 * provider can read: a local `next start`, a self-hosted container. `null` is an
 * ordinary answer, the same one `deploymentIdentity()` gives off a managed host.
 */
export async function deploymentStatusProvider(): Promise<DeploymentStatusProvider | null> {
  if (usingFakeDeploymentStatus()) return fakeDeploymentStatusProvider;
  if (deploymentIdentity().provider !== 'fargate') return null;
  // Lazily imported, so a deployment off the platform, and every unit test that
  // does not ask, never loads the adapter (or the AWS SDK under it).
  const { ecsDeploymentStatusProvider } =
    await import('@/lib/deployment/adapters/ecs/ecsServicesStatus');
  return ecsDeploymentStatusProvider;
}
