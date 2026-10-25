import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_INDEX_TAG_KEYS,
  AWS_SHARD_TAG_KEY,
  AWS_TAG_VALUE_MAX,
  AwsIndexAttributionError,
  FLEET_METADATA_KEY,
  createAwsOrchestrator,
  type ContainerSpec,
} from '../src/index';
import { AwsEc2Fake } from './contract/awsEc2Fake';
import { AWS_AMI_ID, AWS_SHARD_TAG, AWS_SPEC } from './contract/awsHarness';

// MOTIR-9450 — an index VM's four attribution tags, on every resource its launch
// bills, and one account's machine listing for the attribution reconciler.

const INDEXER_AMI_ID = 'ami-0dockerhost00000';
const INDEX_SPEC: ContainerSpec = {
  ...AWS_SPEC,
  workload: 'code_graph_index',
  workflowJobId: null,
  image: `ghcr.io/motir-co/motir-indexer@sha256:${'c'.repeat(64)}`,
  orgId: 'org-9450',
  projectId: 'proj-9450',
  repoFullName: 'acme/widgets',
  env: { MOTIR_INDEX_PROJECT_ID: 'proj-9450' },
};

let ec2: AwsEc2Fake;

function adapter() {
  return createAwsOrchestrator({
    ec2,
    region: 'us-east-1',
    shardTag: AWS_SHARD_TAG,
    amiId: AWS_AMI_ID,
    indexerAmiId: INDEXER_AMI_ID,
  });
}

function tagMap(tags: ReadonlyArray<{ key: string; value: string }>): Record<string, string> {
  return Object.fromEntries(tags.map((t) => [t.key, t.value]));
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  ec2.seedShardNetwork(AWS_SHARD_TAG);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an index VM carries its four attribution tags (MOTIR-9450)', () => {
  it('tags the instance, its volumes and its network interface with workload, org, project and repo', async () => {
    const handle = await adapter().provision(INDEX_SPEC);
    const request = ec2.requestOf(handle.id);

    expect(tagMap(request.tags)).toMatchObject({
      [AWS_INDEX_TAG_KEYS.workload]: 'code_graph_index',
      [AWS_INDEX_TAG_KEYS.org]: 'org-9450',
      [AWS_INDEX_TAG_KEYS.project]: 'proj-9450',
      [AWS_INDEX_TAG_KEYS.repo]: 'acme/widgets',
      // The fleet's own tags stay: the shard scopes the key, the reaper and the IAM.
      [AWS_SHARD_TAG_KEY]: AWS_SHARD_TAG,
    });
    // One tag list, written on instance, volume and interface in the same call.
    expect(request.tagNetworkInterface).toBe(true);
    // And the instance as EC2 reports it carries them.
    const listed = await ec2.describeInstances({ instanceIds: [handle.id] });
    expect(tagMap(listed.instances[0]!.tags)[AWS_INDEX_TAG_KEYS.repo]).toBe('acme/widgets');
    expect(request.tags.some((t) => t.key.startsWith('aws:'))).toBe(false);
  });

  it.each(['orgId', 'projectId', 'repoFullName'] as const)(
    'refuses a spec with no %s before any EC2 call, naming the field',
    async (field) => {
      const spec = { ...INDEX_SPEC, [field]: ' ' };
      await expect(adapter().provision(spec)).rejects.toMatchObject({
        name: 'AwsIndexAttributionError',
        field,
      });
      await expect(adapter().provision(spec)).rejects.toBeInstanceOf(AwsIndexAttributionError);
      expect(ec2.calls).toEqual([]);
    },
  );

  it('cuts a value over 256 characters to 256 and still launches', async () => {
    const long = `acme/${'r'.repeat(400)}`;
    const handle = await adapter().provision({ ...INDEX_SPEC, repoFullName: long });
    const value = tagMap(ec2.requestOf(handle.id).tags)[AWS_INDEX_TAG_KEYS.repo]!;
    expect(value).toHaveLength(AWS_TAG_VALUE_MAX);
    expect(value).toBe(long.slice(0, AWS_TAG_VALUE_MAX));
  });

  it('leaves a CI runner launch and its tags as they were', async () => {
    const handle = await adapter().provision(AWS_SPEC);
    const request = ec2.requestOf(handle.id);
    expect(request).not.toHaveProperty('tagNetworkInterface');
    expect(Object.keys(tagMap(request.tags)).some((k) => k.startsWith('motir:'))).toBe(false);
    expect(tagMap(request.tags)[FLEET_METADATA_KEY]).toBe('ci-runner');
  });
});
