import type { HostingSize, ProductionUsageUnit } from '@/generated/prisma/client';
import {
  SERVERLESS_MEMORY_MB,
  type DatabaseUsage,
  type HostingDeployTarget,
  type ReleaseUsage,
} from '@motir/orchestrator';

// A production application's usage IN THE DECISION'S UNITS (Story MOTIR-9799 ·
// MOTIR-12108; Decision MOTIR-12100 §2). The pure half of the meter: what one
// port answer is worth in each unit. No I/O.

export interface UnitQuantity {
  readonly unit: ProductionUsageUnit;
  readonly quantity: number;
}

/** Below this a quantity is a rounding residue, not usage. */
export const USAGE_EPSILON = 1e-9;

/** The units a release window is billed in, whatever its target — the meter's
 *  release watermark spans all of them, so a size change starts no new window. */
export const RELEASE_UNITS: readonly ProductionUsageUnit[] = [
  'fly_small_seconds',
  'fly_medium_seconds',
  'fly_large_seconds',
  'lambda_gb_seconds',
  'lambda_requests',
  'fargate_vcpu_seconds',
  'fargate_gb_seconds',
];

/** The units a database window is billed in. */
export const DATABASE_UNITS: readonly ProductionUsageUnit[] = [
  'neon_compute_hours',
  'neon_storage_gb_hours',
  'aurora_compute_hours',
  'aurora_storage_gb_hours',
];

const MACHINE_SECONDS_UNIT: Readonly<Record<HostingSize, ProductionUsageUnit>> = {
  small: 'fly_small_seconds',
  medium: 'fly_medium_seconds',
  large: 'fly_large_seconds',
};

/** Motir's serverless function memory in GB (1769 MB = 1.7275 GB, §2 note). */
export const SERVERLESS_MEMORY_GB = SERVERLESS_MEMORY_MB / 1024;

const GIB = 2 ** 30;

/** Only what was used: a residue or a negative is no usage. */
function used(entries: readonly UnitQuantity[]): UnitQuantity[] {
  return entries.filter((e) => e.quantity > USAGE_EPSILON);
}

/**
 * One release window in the decision's units. Fly bills its running seconds at
 * the release's size; Motir's serverless account its running seconds as
 * GB-seconds at the function's memory, and its requests; an AWS function its
 * GB-seconds (and requests where the port counts them); an AWS container its
 * vCPU-seconds and GB-seconds.
 */
export function releaseUnitQuantities(
  target: HostingDeployTarget,
  size: HostingSize | null,
  usage: ReleaseUsage,
): UnitQuantity[] {
  const requests: UnitQuantity = { unit: 'lambda_requests', quantity: usage.invocations ?? 0 };
  if (target === 'fly') {
    return used([{ unit: MACHINE_SECONDS_UNIT[size ?? 'small'], quantity: usage.runningSeconds }]);
  }
  const compute = usage.compute;
  if (compute?.unit === 'fargate') {
    return used([
      { unit: 'fargate_vcpu_seconds', quantity: compute.vcpuSeconds },
      { unit: 'fargate_gb_seconds', quantity: compute.gbSeconds },
    ]);
  }
  if (compute?.unit === 'lambda') {
    return used([{ unit: 'lambda_gb_seconds', quantity: compute.gbSeconds }, requests]);
  }
  if (target === 'serverless') {
    return used([
      { unit: 'lambda_gb_seconds', quantity: usage.runningSeconds * SERVERLESS_MEMORY_GB },
      requests,
    ]);
  }
  // An AWS window with no compute figure has nothing the decision prices.
  return [];
}

/**
 * One database window in the decision's units: compute as CU-hours (Neon) or
 * ACU-hours (Aurora), and storage as GB-hours — the bytes sampled at the
 * window's end, for the window's length (§2 notes).
 */
export function databaseUnitQuantities(
  usage: DatabaseUsage,
  window: { start: Date; end: Date },
): UnitQuantity[] {
  const hours = Math.max(0, window.end.getTime() - window.start.getTime()) / 3_600_000;
  // `aws` is the AWS target's Aurora cluster, read in its tenant account
  // (MOTIR-12191); every other provider is the database port's Neon.
  const aurora = usage.provider === 'aws';
  return used([
    {
      unit: aurora ? 'aurora_compute_hours' : 'neon_compute_hours',
      quantity: usage.computeSeconds / 3600,
    },
    {
      unit: aurora ? 'aurora_storage_gb_hours' : 'neon_storage_gb_hours',
      quantity: (usage.storageBytes / GIB) * hours,
    },
  ]);
}

/** Midnight UTC of the day `at` falls in. */
export function utcDayOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** The UTC day a slice ending at `end` belongs to (§5): the day its last
 *  instant falls in, so a slice ending exactly at midnight is the day before's. */
export function chargeDayOf(end: Date): Date {
  return utcDayOf(new Date(end.getTime() - 1));
}

/** `YYYY-MM-DD` of a midnight-UTC date. */
export function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** Decision MOTIR-12100 §5's slice key: (application, unit, slice end). */
export function sliceIdempotencyKey(
  applicationId: string,
  unit: ProductionUsageUnit,
  sliceEnd: Date,
): string {
  return `${applicationId}:${unit}:${sliceEnd.toISOString()}`;
}
