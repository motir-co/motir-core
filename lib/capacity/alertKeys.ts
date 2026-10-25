// The KEY of a capacity alert, and the alert share's bounds (Story MOTIR-9539 ·
// MOTIR-9609). Both sets are closed by motir-gateway's capacity contract
// (`docs/motir-capacity-api.md` §3): the providers the gateway reports and the
// six limit units every entry carries. The gateway client
// (`lib/gateway/capacityClient.ts`) re-exports these, so there is one list.
//
// No `server-only`: a screen may name a unit or provider without importing the
// client.

export const CAPACITY_PROVIDERS = ['claude', 'qwen', 'deepseek'] as const;
export type CapacityProvider = (typeof CAPACITY_PROVIDERS)[number];

export const CAPACITY_LIMIT_UNITS = [
  'max_concurrency',
  'rpm',
  'input_tpm',
  'output_tpm',
  'tpm',
  'tpd',
] as const;
export type CapacityLimitUnit = (typeof CAPACITY_LIMIT_UNITS)[number];

/** The alert share when nobody has set one. */
export const DEFAULT_ALERT_SHARE_PERCENT = 80;
export const MIN_ALERT_SHARE_PERCENT = 1;
export const MAX_ALERT_SHARE_PERCENT = 100;

/** One raised alert's identity: a provider model's limit unit. */
export interface CapacityAlertKey {
  provider: CapacityProvider;
  model: string;
  limitUnit: CapacityLimitUnit;
}

export function isCapacityProvider(value: unknown): value is CapacityProvider {
  return (CAPACITY_PROVIDERS as readonly unknown[]).includes(value);
}

export function isCapacityLimitUnit(value: unknown): value is CapacityLimitUnit {
  return (CAPACITY_LIMIT_UNITS as readonly unknown[]).includes(value);
}
