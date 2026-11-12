import { LEAD_TIME_DAYS, type DeclaredCredential } from './credentialRegistry';

// THE CREDENTIAL-EXPIRY PROBE (MOTIR-1933) — a pure function of
// `(registry, env, now)`, so its tests inject the clock and the environment and
// never read the wall clock or `process.env`.
//
// It knows no credential by name: every entry is judged by the same three
// arms, so registering a second credential changes no line here.
//
//   • the variable is UNSET → SKIPPED, never failed. For an entry with `heldIn`
//     — a credential another store holds, which core cannot see — "set" means
//     this is Motir's own cloud (`MOTIR_CLOUD=true`), the one deployment that
//     holds it. An unset credential is its
//     feature's own `notConfigured` state (a self-hosted build has no billing
//     token at all), and failing on it would dead-letter the check every morning
//     on every deployment that never wanted the feature.
//   • `now` is past `expiresAt` → EXPIRED. The variable is still set, so the
//     feature is still trying to use a dead token.
//   • `now + leadTime` reaches `expiresAt` → EXPIRING.
//
// ⚠️ IT REPORTS NAMES, NEVER VALUES — the same rule as the monitor-config probe
// beside it. Only the env var's name and whether it is set reach the verdict.

const DAY_MS = 24 * 60 * 60 * 1000;

/** One registered credential, judged. */
export interface CredentialExpiryEntry {
  envVar: string;
  name: string;
  expiresAt: string;
  /** Whole days between `now` and `expiresAt`, truncated toward zero, so it
   *  counts COMPLETED days either way; negative once it has passed. */
  daysRemaining: number;
  state: 'healthy' | 'expiring' | 'expired';
  renewal: string;
  source: string;
}

/** The probe's answer. `expired` outranks `expiring` when both are present.
 *  Every arm carries `entries` (each credential whose variable is set, judged)
 *  and `skipped` (registered credentials whose variable is unset, which is not a
 *  fault). The arms are written out flat rather than as an intersection so the
 *  memoized step's pinned shape reads as three plain objects. */
export type CredentialExpiryVerdict =
  | {
      verdict: 'ok';
      checkedAt: string;
      entries: CredentialExpiryEntry[];
      skipped: string[];
    }
  | {
      verdict: 'expiring';
      checkedAt: string;
      entries: CredentialExpiryEntry[];
      skipped: string[];
      offenders: CredentialExpiryEntry[];
    }
  | {
      verdict: 'expired';
      checkedAt: string;
      entries: CredentialExpiryEntry[];
      skipped: string[];
      offenders: CredentialExpiryEntry[];
      expiring: CredentialExpiryEntry[];
    };

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Whether this deployment holds the credential, so its date is judged. */
function isHeld(
  credential: DeclaredCredential,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return credential.heldIn === undefined
    ? isSet(env[credential.envVar])
    : env['MOTIR_CLOUD'] === 'true';
}

function expiryInstant(isoDate: string): number {
  const at = Date.parse(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(at)) {
    // A typo in the registry must not read as "never expires".
    throw new Error(`credential registry: expiresAt "${isoDate}" is not an ISO date`);
  }
  return at;
}

/** Judge every registered credential against `now`. Never reads the wall clock. */
export function probeCredentialExpiry(
  registry: readonly DeclaredCredential[],
  env: Readonly<Record<string, string | undefined>>,
  now: Date,
): CredentialExpiryVerdict {
  const nowMs = now.getTime();
  const entries: CredentialExpiryEntry[] = [];
  const skipped: string[] = [];

  for (const credential of registry) {
    if (!isHeld(credential, env)) {
      skipped.push(credential.envVar);
      continue;
    }
    const expiresMs = expiryInstant(credential.expiresAt);
    const leadMs = (credential.leadTimeDays ?? LEAD_TIME_DAYS) * DAY_MS;
    const state: CredentialExpiryEntry['state'] =
      nowMs >= expiresMs ? 'expired' : nowMs + leadMs >= expiresMs ? 'expiring' : 'healthy';
    entries.push({
      envVar: credential.envVar,
      name: credential.name,
      expiresAt: credential.expiresAt,
      daysRemaining: Math.trunc((expiresMs - nowMs) / DAY_MS),
      state,
      renewal: credential.renewal,
      source: credential.source,
    });
  }

  const base = { checkedAt: now.toISOString(), entries, skipped };
  const expired = entries.filter((e) => e.state === 'expired');
  const expiring = entries.filter((e) => e.state === 'expiring');
  if (expired.length > 0) return { ...base, verdict: 'expired', offenders: expired, expiring };
  if (expiring.length > 0) return { ...base, verdict: 'expiring', offenders: expiring };
  return { ...base, verdict: 'ok' };
}
