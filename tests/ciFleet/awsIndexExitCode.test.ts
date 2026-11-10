import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FLEET_CONTAINER_SIZE, type ContainerSpec, type Ec2Api } from '@motir/orchestrator';
import { classifyIndexExit } from '@/lib/services/codeGraphIndexDispatchService';

// MOTIR-9449 — what an AWS index VM's describe reports reaches classifyIndexExit
// with no provider branch: the real AWS adapter over the in-memory EC2, the
// container's exit scripted per instance, and the status it describes fed to the
// one place the number is interpreted.

const paths = {
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
};

interface Ec2Fake extends Ec2Api {
  seedShardNetwork(shardTag: string): void;
  exitIndexContainer(instanceId: string, code: number): void;
  powerOff(instanceId: string): void;
  markImageUnpullable(image: string): void;
  exitIndexContainerUnposted(instanceId: string, code: number): void;
  postConsole(instanceId: string): void;
}

type Source = typeof import('@motir/orchestrator');

const SHARD_TAG = 'indexer-use1-1';
const INDEX_IMAGE = `ghcr.io/motir-co/motir-indexer@sha256:${'b'.repeat(64)}`;
const INDEX_SPEC: ContainerSpec = {
  orgId: 'org-aws-exit',
  workspaceId: 'ws-aws-exit',
  projectId: 'proj-aws-exit',
  repoFullName: 'acme/widgets',
  workload: 'code_graph_index',
  workflowJobId: null,
  image: INDEX_IMAGE,
  size: FLEET_CONTAINER_SIZE,
  env: { MOTIR_INDEX_PROJECT_ID: 'proj-aws-exit' },
  timeoutSeconds: 3600,
  region: 'us-east-1',
};

let source: Source;
let AwsEc2Fake: new () => Ec2Fake;
let ec2: Ec2Fake;

beforeAll(async () => {
  source = (await import(/* @vite-ignore */ paths.orchestratorSource)) as Source;
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  ec2.seedShardNetwork(SHARD_TAG);
});

function orchestrator(now?: () => Date) {
  return source.createAwsOrchestrator({
    ec2,
    region: 'us-east-1',
    shardTag: SHARD_TAG,
    amiId: 'ami-0runner000000000',
    indexerAmiId: 'ami-0dockerhost00000',
    ...(now ? { now } : {}),
  });
}

async function finished(exit: (id: string) => void) {
  const aws = orchestrator();
  const handle = await aws.provision(INDEX_SPEC);
  exit(handle.id);
  return aws.describe(handle);
}

describe('an AWS index VM’s exit code classifies as on Fly (MOTIR-9449)', () => {
  it.each([
    [0, 'indexed', true],
    [10, 'dispatch_malformed', false],
    [20, 'repo_unfetchable', false],
  ] as const)('exit %i classifies as %s', async (code, exitClass, indexed) => {
    const status = await finished((id) => ec2.exitIndexContainer(id, code));
    expect(status).toMatchObject({ terminal: true, exitCode: code });
    expect(classifyIndexExit(status.exitCode)).toMatchObject({ exitClass, indexed });
  });

  it('a VM that stopped with no recorded code classifies as exit_unobserved once the console grace window closes', async () => {
    let clock = Date.parse('2026-11-09T11:13:00Z');
    const aws = orchestrator(() => new Date(clock));
    const handle = await aws.provision(INDEX_SPEC);
    ec2.powerOff(handle.id);

    // EC2 may not have posted the console yet: not terminal, so supervision polls again.
    expect((await aws.describe(handle)).terminal).toBe(false);
    clock += source.AWS_INDEX_CONSOLE_GRACE_MS;
    const status = await aws.describe(handle);
    expect(status.terminal).toBe(true);
    expect(classifyIndexExit(status.exitCode).exitClass).toBe('exit_unobserved');
  });

  it('a code EC2 posts minutes after the stop classifies as indexed (MOTIR-10805)', async () => {
    let clock = Date.parse('2026-11-09T11:13:00Z');
    const aws = orchestrator(() => new Date(clock));
    const handle = await aws.provision(INDEX_SPEC);
    ec2.exitIndexContainerUnposted(handle.id, 0);

    expect((await aws.describe(handle)).terminal).toBe(false);
    clock += 5 * 60_000;
    ec2.postConsole(handle.id);
    const status = await aws.describe(handle);
    expect(status.terminal).toBe(true);
    expect(classifyIndexExit(status.exitCode)).toMatchObject({
      exitClass: 'indexed',
      indexed: true,
    });
  });

  it('a running VM carries no code', async () => {
    const aws = orchestrator();
    const status = await aws.describe(await aws.provision(INDEX_SPEC));
    expect(status).toMatchObject({ terminal: false, exitCode: null });
  });

  it('a pull failure carries no exit code', async () => {
    ec2.markImageUnpullable(INDEX_IMAGE);
    const aws = orchestrator();
    const status = await aws.describe(await aws.provision(INDEX_SPEC));
    expect(status).toMatchObject({ imagePullFailed: true, exitCode: null });
  });
});
