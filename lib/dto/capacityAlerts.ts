import type { CapacityLimitUnit, CapacityProvider } from '@/lib/capacity/alertKeys';

// The capacity alert state's DTOs (Story MOTIR-9539 · MOTIR-9609). Neither
// carries who set the share or any tenant, workspace or organisation identifier.

export interface CapacityAlertShareDTO {
  percent: number;
  /** True when nothing is stored and the default applies. */
  isDefault: boolean;
  updatedAt: Date | null;
}

export interface CapacityRaisedAlertDTO {
  provider: CapacityProvider;
  model: string;
  limitUnit: CapacityLimitUnit;
  raisedAt: Date;
  /** Numbers, not strings: a usage or limit past 2^53 is not a real provider figure,
   *  and the mapper refuses one rather than rounding it. */
  observedValue: number;
  limitValue: number;
  alertSharePercent: number;
}
