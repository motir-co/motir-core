import { GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';

// THE FLEET STATUS PAGE'S QUOTA READ (MOTIR-10887) — the EC2 On-Demand standard
// vCPU quota of core's OWN account, the one quota the install fleet's three
// pools share (`lib/ciFleet/installFleet.ts`). It lives beside
// `ecsServicesReader.ts` because this directory is the one place motir-core
// talks to Service Quotas about its own account (`tests/ciFleet/awsSdkBoundary.test.ts`).
//
// ⚠️ NO CREDENTIALS ARE PASSED, DELIBERATELY — the SDK's default chain, which on
// ECS is the web task's role. motir-infra's services stack grants that role
// `servicequotas:GetServiceQuota` on exactly this quota. Off AWS the chain finds
// nothing and the read fails, which the page renders as Not read — never as 0.
//
// ⚠️ THE REGION IS THE INSTALL FLEET'S. A vCPU quota is regional: the install
// fleet's VMs run in `MOTIR_INSTALL_FLEET_REGION`, so that is the region asked;
// unset, the default chain's (the task's own `AWS_REGION`).

/** Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances — Service Quotas `ec2` / `L-1216C47A`. */
export const EC2_STANDARD_VCPU_QUOTA = { serviceCode: 'ec2', quotaCode: 'L-1216C47A' } as const;

/** What the page reads. Throws when AWS does not answer. */
export interface Ec2VcpuQuotaReader {
  readStandardVcpuQuota(): Promise<number>;
}

/** The reader over the default credential chain, in the install fleet's region. */
export function createEc2VcpuQuotaReader(
  region: string | undefined = process.env.MOTIR_INSTALL_FLEET_REGION?.trim() || undefined,
): Ec2VcpuQuotaReader {
  const quotas = new ServiceQuotasClient(region ? { region } : {});
  return {
    async readStandardVcpuQuota() {
      const { Quota } = await quotas.send(
        new GetServiceQuotaCommand({
          ServiceCode: EC2_STANDARD_VCPU_QUOTA.serviceCode,
          QuotaCode: EC2_STANDARD_VCPU_QUOTA.quotaCode,
        }),
      );
      if (Quota?.Value === undefined) throw new Error('Service Quotas returned no value');
      return Quota.Value;
    },
  };
}
