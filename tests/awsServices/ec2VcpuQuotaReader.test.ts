import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import {
  createEc2VcpuQuotaReader,
  EC2_STANDARD_VCPU_QUOTA,
} from '@/lib/awsServices/ec2VcpuQuotaReader';

// THE FLEET STATUS PAGE'S QUOTA READ (MOTIR-10887). The SDK client is driven at
// its `send`, so what is asserted is the one command the reader sends, the region
// it asks, and the plain number it answers with.

const REGION = process.env.MOTIR_INSTALL_FLEET_REGION;
const AWS_REGION = process.env.AWS_REGION;

afterEach(() => {
  vi.restoreAllMocks();
  if (REGION === undefined) delete process.env.MOTIR_INSTALL_FLEET_REGION;
  else process.env.MOTIR_INSTALL_FLEET_REGION = REGION;
  if (AWS_REGION === undefined) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = AWS_REGION;
});

function quotasAnswering(answer: unknown) {
  return vi
    .spyOn(ServiceQuotasClient.prototype, 'send')
    .mockImplementation((async () => answer) as never);
}

describe('createEc2VcpuQuotaReader', () => {
  it('reads EC2 On-Demand standard vCPU, ec2 / L-1216C47A, in the install fleet’s region', async () => {
    process.env.MOTIR_INSTALL_FLEET_REGION = ' eu-central-1 ';
    const send = quotasAnswering({ Quota: { Value: 384 } });
    const reader = createEc2VcpuQuotaReader();
    expect(await reader.readStandardVcpuQuota()).toBe(384);
    expect(EC2_STANDARD_VCPU_QUOTA).toEqual({ serviceCode: 'ec2', quotaCode: 'L-1216C47A' });
    const command = send.mock.calls[0]![0] as GetServiceQuotaCommand;
    expect(command).toBeInstanceOf(GetServiceQuotaCommand);
    expect(command.input).toEqual({ ServiceCode: 'ec2', QuotaCode: 'L-1216C47A' });
    const client = send.mock.contexts[0] as ServiceQuotasClient;
    expect(await client.config.region()).toBe('eu-central-1');
  });

  it('takes an explicit region, and the default chain’s with none', async () => {
    delete process.env.MOTIR_INSTALL_FLEET_REGION;
    const send = quotasAnswering({ Quota: { Value: 32 } });
    expect(await createEc2VcpuQuotaReader('us-west-2').readStandardVcpuQuota()).toBe(32);
    expect(await (send.mock.contexts[0] as ServiceQuotasClient).config.region()).toBe('us-west-2');
    process.env.AWS_REGION ??= 'us-east-1';
    expect(await createEc2VcpuQuotaReader().readStandardVcpuQuota()).toBe(32);
  });

  it('throws when Service Quotas answers no value — never a 0', async () => {
    quotasAnswering({ Quota: {} });
    await expect(createEc2VcpuQuotaReader('us-east-1').readStandardVcpuQuota()).rejects.toThrow(
      'Service Quotas returned no value',
    );
    quotasAnswering({});
    await expect(createEc2VcpuQuotaReader('us-east-1').readStandardVcpuQuota()).rejects.toThrow();
  });
});
