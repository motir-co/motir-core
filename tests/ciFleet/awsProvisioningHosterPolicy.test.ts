import { describe, expect, it } from 'vitest';
import {
  awsAgentHosterPolicyDocument,
  awsRunnerPolicyDocument,
  type AwsManagementApi,
  type AwsPolicyDocument,
} from '@motir/orchestrator';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import type { ProviderStepContext } from '@/lib/fleetShards/provisioningProviders';

// The runtime key an AWS fleet account gets (Story MOTIR-9361 · MOTIR-9479): an
// agent-hoster account's key carries the persistent instance's calls (stop,
// start, user-data, re-tag, delete its disk); every other kind keeps the runner's.

function policyFor(fleetKind: string): Promise<AwsPolicyDocument> {
  let policy: AwsPolicyDocument | null = null;
  const management = {
    async ensureRunnerIamUser(_credentials: unknown, doc: AwsPolicyDocument) {
      policy = doc;
      return { created: [] };
    },
  } as unknown as AwsManagementApi;
  const provider = createAwsShardProvisioningProvider({
    management: () => management,
    ec2: () => {
      throw new Error('no EC2 call is expected without a runtime key');
    },
    env: () => ({}),
  });
  const ctx = {
    name: 'agent-hoster-use1-1',
    fleetKind,
    region: 'us-east-1',
    options: {},
    credentialRef: 'FLEET_SHARD_AGENT_HOSTER_USE1_1',
    account: {
      accountId: '111122223333',
      credentials: {
        accessKeyId: 'ASIA',
        secretAccessKey: 's',
        sessionToken: 't',
        expiration: null,
      },
    },
  } as unknown as ProviderStepContext;
  return provider.runtimeCredential(ctx).then(() => policy!);
}

describe('the AWS runtime key policy, by fleet kind', () => {
  it('gives an agent-hoster account the hoster policy', async () => {
    expect(await policyFor('agent_instance')).toEqual(
      awsAgentHosterPolicyDocument({ shardTag: 'agent-hoster-use1-1', regionId: 'us-east-1' }),
    );
  });

  it('keeps the runner policy for every other kind', async () => {
    for (const kind of ['ci_runner', 'agent_runner', 'indexer']) {
      expect(await policyFor(kind)).toEqual(
        awsRunnerPolicyDocument({ shardTag: 'agent-hoster-use1-1', regionId: 'us-east-1' }),
      );
    }
  });
});
