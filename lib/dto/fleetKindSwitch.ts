// One fleet kind's persisted Fly↔AWS switch (MOTIR-9503) — what the /admin
// console reads and is answered. Only the agent hoster (`agent_instance`) is
// offered today: its section is "Agent hosting" on /admin/fleet-settings
// (design MOTIR-9534).

/** The STORED state of one kind's switch. No row ⇒ off, never changed. */
export interface FleetKindSwitchStateDTO {
  /** true ⇒ the kind's new work goes to its AWS pool; false ⇒ Fly. */
  onPool: boolean;
  updatedBy: { userId: string; email: string } | null;
  updatedAt: string | null;
  lastReason: string | null;
}

/** What a flip answers. `unchanged` = the switch already held the asked state;
 *  nothing was written and no audit row exists. */
export interface FleetKindSwitchFlipDTO {
  outcome: 'changed' | 'unchanged';
  state: FleetKindSwitchStateDTO;
}
