// The operator console's RUN-SIDE DEFAULTS card — Story MOTIR-10838 · MOTIR-10844,
// on the Hosted-run models page. The model a hosted review, a design run or an
// agent run of each difficulty starts on when nobody below the platform chose
// one. Staff-facing only.

import type { RunModelDefaultKey } from '@/lib/ai/types';

/** One run-side default, as the card renders it. */
export interface PlatformRunModelDefaultRowDTO {
  key: RunModelDefaultKey;
  /** The stored model, or null: the row inherits (see `inherits`). */
  model: string | null;
  /** A stored model motir-ai no longer offers, or that is off the run-model list. */
  withdrawn: boolean;
  /**
   * What an unset row falls back to, as the row names it: the run default for the
   * review agent, nothing (the card's difficulty) for the design run, and the
   * environment value motir-ai answers for a level. Null when there is none.
   */
  inheritsModel: string | null;
  /** Null while nobody has changed it (seeded or never set). */
  updatedAt: string | null;
  updatedBy: string | null;
  /** True while no operator has ever changed it. */
  seeded: boolean;
}

/** A model the pickers may offer: on the run-model list AND offered by motir-ai. */
export interface PlatformRunModelDefaultOptionDTO {
  id: string;
  provider: string;
}

/** The whole card: six rows in `review`, `design`, `trivial`, `low`, `medium`, `high` order. */
export interface PlatformRunModelDefaultsDTO {
  rows: PlatformRunModelDefaultRowDTO[];
  options: PlatformRunModelDefaultOptionDTO[];
  /** True only for a `superadmin`; every other staff role reads. */
  canEdit: boolean;
}

/** What a save reports back, from → to as motir-ai's audit answered it. */
export interface PlatformRunModelDefaultWriteDTO {
  key: RunModelDefaultKey;
  fromModel: string | null;
  toModel: string | null;
  at: string;
}
