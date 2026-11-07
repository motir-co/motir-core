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

/**
 * The ONE key of the gateway-saturation series (MOTIR-9675, design D6), in the
 * same raised-alert store as the provider limits. Not a provider model: the
 * migration `gateway_saturation_alert_key` admits `gateway` and `saturation`
 * only together, on this key.
 */
export const GATEWAY_SATURATION_ALERT_KEY = {
  provider: 'gateway',
  model: 'connections',
  limitUnit: 'saturation',
} as const;
export type GatewaySaturationAlertKey = typeof GATEWAY_SATURATION_ALERT_KEY;

/** Any key the raised-alert store holds. */
export type CapacityStoreKey = CapacityAlertKey | GatewaySaturationAlertKey;

export function isGatewaySaturationAlertKey(key: {
  provider: unknown;
  model: unknown;
  limitUnit: unknown;
}): key is GatewaySaturationAlertKey {
  return (
    key.provider === GATEWAY_SATURATION_ALERT_KEY.provider &&
    key.model === GATEWAY_SATURATION_ALERT_KEY.model &&
    key.limitUnit === GATEWAY_SATURATION_ALERT_KEY.limitUnit
  );
}

export function isCapacityProvider(value: unknown): value is CapacityProvider {
  return (CAPACITY_PROVIDERS as readonly unknown[]).includes(value);
}

export function isCapacityLimitUnit(value: unknown): value is CapacityLimitUnit {
  return (CAPACITY_LIMIT_UNITS as readonly unknown[]).includes(value);
}
