import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ec2ApiError, OrchestratorNotConfiguredError, type Ec2Api } from '@motir/orchestrator';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { describeAwsImages, setAwsEc2OverrideForTests } from '@/lib/orchestrator';
import { createFileBackedEc2 } from '@/lib/test-fake-aws';

// `describeAwsImages` (MOTIR-10395): the daily health check reads the pinned
// runner AMI through an aws account's own EC2 client — the one its launches
// use, as its `motir-fleet-runner` role — and nothing else. The SDK mapping is
// pinned in `packages/orchestrator/test/awsEc2Client.test.ts`.

const SHARD = {
  id: 'shard-1',
  name: 'motir-ci-1',
  fleetKind: 'ci_runner',
  provider: 'aws',
  aws: { accountId: '111111111111', region: 'us-east-1' },
} as unknown as FleetShardDTO;

afterEach(() => {
  setAwsEc2OverrideForTests(null);
});

describe('describeAwsImages', () => {
  it("asks the account's own EC2 client for exactly the named AMIs", async () => {
    const image = {
      imageId: 'ami-1',
      name: 'motir-ci-runner-2.329.0-202611050900-4a9cb14',
      description: null,
      ownerId: null,
      creationDate: null,
    };
    const describeImages = vi.fn(async () => [image]);
    const factory = vi.fn(() => ({ describeImages }) as unknown as Ec2Api);
    setAwsEc2OverrideForTests(factory);

    expect(await describeAwsImages(SHARD, ['ami-1'])).toEqual([image]);
    expect(factory).toHaveBeenCalledWith(SHARD, { Ec2ApiError });
    expect(describeImages).toHaveBeenCalledWith(['ami-1']);
  });

  it('refuses an account that is not on AWS, reading nothing', async () => {
    const factory = vi.fn();
    setAwsEc2OverrideForTests(factory);
    await expect(
      describeAwsImages({ ...SHARD, provider: 'fly' } as FleetShardDTO, ['ami-1']),
    ).rejects.toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("the acceptance lane's EC2 knows no AMI, as EC2 answers an unknown id", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-aws-'));
    try {
      const ec2 = createFileBackedEc2(join(dir, 'state.json'), SHARD, { Ec2ApiError });
      await expect(ec2.describeImages(['ami-00000000000000000'])).rejects.toMatchObject({
        code: 'InvalidAMIID.NotFound',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
