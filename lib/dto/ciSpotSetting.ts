// The CI runner Spot setting (MOTIR-11725) — what the platform route answers.

/** What system code reads: whether CI runners launch as Spot, and the ordered
 *  instance types a launch may walk. */
export interface CiSpotSettingValue {
  enabled: boolean;
  instanceTypes: string[];
}

/** The STORED state of the setting. No row ⇒ off, the default types,
 *  `isDefault: true`, never changed. */
export interface CiSpotSettingStateDTO extends CiSpotSettingValue {
  /** true while no save has ever been made — the values are the defaults. */
  isDefault: boolean;
  lastReason: string | null;
  updatedBy: { userId: string; email: string } | null;
  updatedAt: string | null;
}

/** What a save answers. `unchanged` = the setting already held the asked values
 *  (the same flag and the same types in the same order); nothing was written and
 *  no audit row exists. */
export interface CiSpotSettingSaveDTO {
  outcome: 'changed' | 'unchanged';
  state: CiSpotSettingStateDTO;
}
