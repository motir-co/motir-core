import { hostingAppNames } from '../../../../hosting/names';
import type { HostingEnvironment } from '../../../../hosting/types';
import type { FargateSize } from '../../../../hosting/usage';

// The container release's NAMES (MOTIR-10009). One app name, `mh-<rid>` or
// `mh-<rid>-pr<n>` (`hostingAppNames`), names the cluster, the service and the
// task definition family alike; the stack is `motir-release-<appRef>` (the
// templates README) and the usage accrual the one SSM parameter beside it.

export interface ContainerReleaseNames {
  readonly appRef: string;
  readonly stackName: string;
  readonly cluster: string;
  readonly service: string;
  readonly family: string;
  /** The SSM parameter holding the release's accrued Fargate usage. */
  readonly usageParameter: string;
}

export function containerReleaseNames(
  repositoryId: string,
  environment: HostingEnvironment,
): ContainerReleaseNames {
  const { appRef } = hostingAppNames('mh-', repositoryId, environment);
  return {
    appRef,
    stackName: `motir-release-${appRef}`,
    cluster: appRef,
    service: appRef,
    family: appRef,
    usageParameter: `/motir/hosting/${appRef}/usage`,
  };
}

/** A size from the size table as Fargate's units: CPU units (1024 a vCPU) and
 *  memory in MiB — the template's `TaskCpu` and `TaskMemory`. */
export function fargateTaskUnits(size: FargateSize): { cpu: string; memory: string } {
  return { cpu: String(size.vcpu * 1024), memory: String(size.memoryGb * 1024) };
}

/** A task definition ARN's revision number (`…:task-definition/<family>:<n>`). */
export function taskDefinitionRevision(arn: string): number {
  return Number(arn.slice(arn.lastIndexOf(':') + 1));
}
