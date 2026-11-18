// THE CI SPOT SETTING's instance types (MOTIR-11725).
//
// A CI runner on an AWS pool account is one machine class: 2 vCPU / 8 GiB, x86
// (`AWS_DEFAULT_INSTANCE_TYPE = 'm6i.large'` in
// `packages/orchestrator/src/adapters/aws/index.ts`). A Spot launch may walk an
// ORDERED list of instance types so that one type with no spare Spot capacity
// falls through to the next — and every type on it must be that same class, or a
// job would run on a machine the runner was never sized for.
//
// Every entry below was checked against the EC2 general purpose instance
// specifications, https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html
// (read 2026-11-18): each is 2 vCPU, 8 GiB, x86_64.

/**
 * The CLOSED allowlist a write of the setting is validated against. A type not on
 * it is refused (`InvalidCiSpotInstanceTypesError`, rule `not_allowed`). Adding a
 * type is a code change, on purpose: it widens what a launch may run on.
 */
export const CI_SPOT_ALLOWED_INSTANCE_TYPES = [
  'm5.large', // 2 vCPU · 8 GiB · Intel
  'm5a.large', // 2 vCPU · 8 GiB · AMD
  'm6i.large', // 2 vCPU · 8 GiB · Intel
  'm6a.large', // 2 vCPU · 8 GiB · AMD
  'm7i.large', // 2 vCPU · 8 GiB · Intel
  'm7a.large', // 2 vCPU · 8 GiB · AMD
] as const;

/** One allowed CI Spot instance type. */
export type CiSpotInstanceType = (typeof CI_SPOT_ALLOWED_INSTANCE_TYPES)[number];

/**
 * The list a CI runner launches on when nobody has saved the setting — in launch
 * order: today's on-demand type first, then the newer Intel generation, then the
 * older Intel and the AMD equivalents. Every entry is on the allowlist.
 */
export const CI_SPOT_DEFAULT_INSTANCE_TYPES: readonly CiSpotInstanceType[] = [
  'm6i.large', // 2 vCPU · 8 GiB · Intel
  'm7i.large', // 2 vCPU · 8 GiB · Intel
  'm5.large', // 2 vCPU · 8 GiB · Intel
  'm6a.large', // 2 vCPU · 8 GiB · AMD
];

/** True when `value` is one of the allowed types. */
export function isCiSpotInstanceType(value: string): value is CiSpotInstanceType {
  return (CI_SPOT_ALLOWED_INSTANCE_TYPES as readonly string[]).includes(value);
}
