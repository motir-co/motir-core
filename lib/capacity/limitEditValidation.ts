import 'server-only';

import { isCapacityProvider } from '@/lib/capacity/alertKeys';
import { CapacityLimitEditInvalidError } from '@/lib/capacity/errors';
import { CAPACITY_EDIT_KEYS, type CapacityLimitsEdit } from '@/lib/gateway/capacityClient';

/**
 * Core's check of a capacity limit edit BEFORE anything is sent (Story MOTIR-9539
 * · MOTIR-9613), by the gateway's own rules (the capacity contract §4), so a bad
 * value is refused without a round trip and in the gateway's vocabulary: the
 * same codes, and `field` as the gateway's snake_case key. Where several keys are
 * at fault the first in alphabetical order of that key is reported, as the
 * gateway does.
 *
 * The input is untrusted (it arrives through a Server Action), so the edit that
 * comes back is REBUILT from the known keys only: an absent key stays absent,
 * `null` stays "unknown", and nothing else rides along.
 */

const TIER_NOTE_MAX = 1000;
const LIMIT_KEYS = new Set<keyof CapacityLimitsEdit>([
  'maxConcurrency',
  'rpm',
  'inputTpm',
  'outputTpm',
  'tpm',
  'tpd',
]);
const KNOWN_KEYS = new Map<string, string>(CAPACITY_EDIT_KEYS);

function isLimitValue(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isValid(key: keyof CapacityLimitsEdit, value: unknown): boolean {
  if (LIMIT_KEYS.has(key)) return isLimitValue(value);
  if (key === 'planningSharePercent') {
    return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;
  }
  return typeof value === 'string' && value.length <= TIER_NOTE_MAX;
}

export function validateCapacityLimitEdit(
  provider: unknown,
  model: unknown,
  edit: unknown,
): CapacityLimitsEdit {
  if (!isCapacityProvider(provider) || typeof model !== 'string' || !model.trim()) {
    throw new CapacityLimitEditInvalidError('capacity_unknown_provider');
  }
  if (typeof edit !== 'object' || edit === null || Array.isArray(edit)) {
    throw new CapacityLimitEditInvalidError('capacity_invalid_body');
  }
  const supplied = Object.entries(edit).filter(([, value]) => value !== undefined);
  const unknown = supplied.map(([key]) => key).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new CapacityLimitEditInvalidError('capacity_invalid_body', unknown.sort()[0]!);
  }
  if (supplied.length === 0) throw new CapacityLimitEditInvalidError('capacity_empty_edit');
  const faults = supplied
    .filter(([key, value]) => !isValid(key as keyof CapacityLimitsEdit, value))
    .map(([key]) => KNOWN_KEYS.get(key)!)
    .sort();
  if (faults.length > 0)
    throw new CapacityLimitEditInvalidError('capacity_invalid_value', faults[0]!);
  return Object.fromEntries(supplied) as CapacityLimitsEdit;
}
