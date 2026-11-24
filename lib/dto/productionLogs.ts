import type { ReleaseLogStream } from '@motir/orchestrator';

// A Motir repository's PRODUCTION LOGS as the panel reads them (Story MOTIR-9799
// · MOTIR-12105): one page of the current release's output, newest first, with
// every production secret value already masked. Nothing here is stored.

/** Why a page holds the lines it does: `ok` read from the target;
 *  `no_release` — nothing is live, so there is nothing to read; `unavailable`
 *  — the target could not answer, which the panel shows as such, not as an
 *  error. */
export type ProductionLogsState = 'ok' | 'no_release' | 'unavailable';

export interface ProductionLogLineDto {
  /** ISO 8601. */
  at: string;
  stream: ReleaseLogStream;
  /** The line with every secret value replaced by the mask. */
  message: string;
}

export interface ProductionLogsDto {
  lines: ProductionLogLineDto[];
  /** The opaque token for the page of older lines, or null when there are none. */
  cursor: string | null;
  state: ProductionLogsState;
}
