import type { ProductionUsageUnitDto } from '@/lib/dto/productionUsage';

// How the Production panel's Usage section words each unit of Decision
// MOTIR-12100 (Story MOTIR-9799 · MOTIR-12110; `design/hosting/design-notes.md`
// § Usage): its label and its amount in the HUMAN measure — machine hours at its
// size on Fly, GB-seconds and requests for a function, vCPU-hours and GB-hours
// for an AWS container, CU-hours / ACU-hours and GB-hours for a database. Pure:
// message KEYS under `settings.production.usage`, never English. Provider names
// (Neon, Aurora) are proper names and are not translated.

export type UsageLabelKey =
  | 'unit.machine'
  | 'unit.lambdaCompute'
  | 'unit.lambdaRequests'
  | 'unit.containerCpu'
  | 'unit.containerMemory'
  | 'unit.dbCompute'
  | 'unit.dbStorage';

export type UsageAmountKey =
  | 'amount.hours'
  | 'amount.gbSeconds'
  | 'amount.count'
  | 'amount.vcpuHours'
  | 'amount.gbHours'
  | 'amount.cuHours'
  | 'amount.acuHours';

export interface UsageUnitWords {
  labelKey: UsageLabelKey;
  /** A Fly machine's size, as a key under `settings.production.usage`. */
  sizeKey?: 'size.small' | 'size.medium' | 'size.large';
  /** The database provider's proper name. */
  provider?: 'Neon' | 'Aurora';
  amountKey: UsageAmountKey;
  /** The quantity in the human measure `amountKey` names. */
  amount: number;
}

const HOUR_SECONDS = 3600;

export function usageUnitWords(unit: ProductionUsageUnitDto, quantity: number): UsageUnitWords {
  switch (unit) {
    case 'fly_small_seconds':
    case 'fly_medium_seconds':
    case 'fly_large_seconds':
      return {
        labelKey: 'unit.machine',
        sizeKey: `size.${unit.slice(4, -8) as 'small' | 'medium' | 'large'}`,
        amountKey: 'amount.hours',
        amount: quantity / HOUR_SECONDS,
      };
    case 'lambda_gb_seconds':
      return { labelKey: 'unit.lambdaCompute', amountKey: 'amount.gbSeconds', amount: quantity };
    case 'lambda_requests':
      return { labelKey: 'unit.lambdaRequests', amountKey: 'amount.count', amount: quantity };
    case 'fargate_vcpu_seconds':
      return {
        labelKey: 'unit.containerCpu',
        amountKey: 'amount.vcpuHours',
        amount: quantity / HOUR_SECONDS,
      };
    case 'fargate_gb_seconds':
      return {
        labelKey: 'unit.containerMemory',
        amountKey: 'amount.gbHours',
        amount: quantity / HOUR_SECONDS,
      };
    case 'neon_compute_hours':
      return {
        labelKey: 'unit.dbCompute',
        provider: 'Neon',
        amountKey: 'amount.cuHours',
        amount: quantity,
      };
    case 'neon_storage_gb_hours':
      return {
        labelKey: 'unit.dbStorage',
        provider: 'Neon',
        amountKey: 'amount.gbHours',
        amount: quantity,
      };
    case 'aurora_compute_hours':
      return {
        labelKey: 'unit.dbCompute',
        provider: 'Aurora',
        amountKey: 'amount.acuHours',
        amount: quantity,
      };
    case 'aurora_storage_gb_hours':
      return {
        labelKey: 'unit.dbStorage',
        provider: 'Aurora',
        amountKey: 'amount.gbHours',
        amount: quantity,
      };
  }
}
