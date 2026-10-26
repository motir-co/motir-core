import type { PillProps } from '@/components/ui/Pill';
import type { CapacityLimitUnit } from '@/lib/capacity/alertKeys';
import type { CapacityLimitState } from '@/lib/capacity/threshold';
import type { PlatformCapacityEditInput } from '@/lib/dto/platformCapacity';

// The capacity screen's lookups (MOTIR-9614, design `platform-admin` AMENDMENT
// 2026-10-25 § Colour and shape roles). Every one is a `Record` over a closed
// union, so a state or unit the doors grow fails the type-check here instead of
// rendering blank. The screen judges nothing: the row's `state` arrives decided.

type StateCopyKey = 'normal' | 'near' | 'over' | 'unavailable' | 'unknown' | 'na' | 'unreported';

export interface StateLook {
  /** `platformAdmin.capacity.state.<key>`. */
  label: StateCopyKey;
  pill: Pick<PillProps, 'severity' | 'tone'>;
  /** The share bar's fill; only drawn when the row carries a share. */
  bar: string;
}

const ACCENT_BAR = 'bg-(--el-accent)';

export const STATE_LOOK: Record<CapacityLimitState, StateLook> = {
  normal: { label: 'normal', pill: { severity: 'success' }, bar: ACCENT_BAR },
  near_limit: { label: 'near', pill: { tone: 'awaiting' }, bar: 'bg-(--el-warning)' },
  over_share: { label: 'over', pill: { severity: 'danger' }, bar: 'bg-(--el-danger)' },
  unavailable: { label: 'unavailable', pill: { tone: 'neutral' }, bar: ACCENT_BAR },
  unknown_limit: { label: 'unknown', pill: { tone: 'neutral' }, bar: ACCENT_BAR },
  not_applicable: { label: 'na', pill: { tone: 'neutral' }, bar: ACCENT_BAR },
  usage_not_reported: { label: 'unreported', pill: { tone: 'neutral' }, bar: ACCENT_BAR },
};

/** Each unit's camelCase edit key. The server-only client keeps its own copy. */
export const UNIT_EDIT_KEY: Record<
  CapacityLimitUnit,
  Exclude<keyof PlatformCapacityEditInput, 'planningSharePercent' | 'tierNote'>
> = {
  max_concurrency: 'maxConcurrency',
  rpm: 'rpm',
  input_tpm: 'inputTpm',
  output_tpm: 'outputTpm',
  tpm: 'tpm',
  tpd: 'tpd',
};

/** `HH:MM:SS` (or `HH:MM`) of an ISO instant, in UTC — never the browser's zone. */
export function utcClock(iso: string, seconds = true): string {
  return new Date(iso).toISOString().slice(11, seconds ? 19 : 16);
}
