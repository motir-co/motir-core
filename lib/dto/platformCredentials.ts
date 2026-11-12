// THE CREDENTIALS PAGE'S DTO (MOTIR-9408, design MOTIR-11084): what
// `platformCredentialsService.read` judged from one `credentialExpiryService.check()`
// over `CREDENTIAL_REGISTRY`. The page renders what is here and decides nothing.
//
// ⚠️ NAMES AND DECLARED DATES ONLY. No field holds, masks or hints at a
// credential's value: the probe answers whether a variable is set, and that is
// the only thing read from the environment.

/** How one registered credential stands: the probe's three states, plus
 *  `notSet` for an entry the probe skipped. */
export type PlatformCredentialState = 'expired' | 'expiring' | 'notSet' | 'healthy';

/** The page's overall verdict. `ok` needs at least one judged credential;
 *  `noneSet` is a registry whose every variable is unset; `empty` a registry
 *  with no entry. */
export type PlatformCredentialsOverall = 'expired' | 'expiring' | 'ok' | 'noneSet' | 'empty';

export interface PlatformCredentialRowDTO {
  envVar: string;
  name: string;
  /** The declared ISO date (`YYYY-MM-DD`). */
  expiresAt: string;
  state: PlatformCredentialState;
  /** Whole days left, truncated toward zero; null for a `notSet` row, which is
   *  never given a number. */
  daysRemaining: number | null;
  /** The entry's lead time in days (`LEAD_TIME_DAYS` unless it declares its own). */
  leadTimeDays: number;
  /** `expiresAt` minus the lead time, as an ISO date: the day the check starts failing. */
  warnsFrom: string;
  renewal: string;
  source: string;
}

export interface PlatformCredentialCountsDTO {
  expired: number;
  expiring: number;
  notSet: number;
  healthy: number;
}

export type PlatformCredentialsDTO =
  | {
      status: 'ok';
      /** When `check()` ran, ISO. */
      checkedAt: string;
      overall: PlatformCredentialsOverall;
      counts: PlatformCredentialCountsDTO;
      /** Expired, expiring, not set, healthy; soonest `expiresAt` first in each. */
      rows: PlatformCredentialRowDTO[];
    }
  | {
      /** `check()` threw — a registry entry that does not parse. Nothing is listed. */
      status: 'failed';
      checkedAt: string;
      message: string;
    };
