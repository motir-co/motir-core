import type {
  PlatformCredentialRowDTO,
  PlatformCredentialState,
  PlatformCredentialsDTO,
  PlatformCredentialsOverall,
} from '@/lib/dto/platformCredentials';
import type { CredentialExpiryVerdict } from '@/lib/health/credentialExpiryProbe';
import {
  CREDENTIAL_REGISTRY,
  LEAD_TIME_DAYS,
  type DeclaredCredential,
} from '@/lib/health/credentialRegistry';
import { credentialExpiryService } from '@/lib/services/credentialExpiryService';

// THE CONSOLE'S CREDENTIALS READ (MOTIR-9408, design MOTIR-11084). One
// `credentialExpiryService.check()` — the verdict `system.daily-health-check`
// reaches every morning — turned into the rows `/admin/credentials` draws.
//
// ⚠️ IT READS NO VALUE. The probe is the only thing that touches the environment,
// and it answers set / unset per NAME. The rows are built from the probe's
// answer and the registry's own declared text.
//
// ⚠️ A THROW LISTS NOTHING. A registry entry whose date does not parse makes
// `check()` throw; the page then shows the message and no row, because a list
// missing that entry would read as complete.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The page's group order: expired first, healthy last. */
const ORDER: Record<PlatformCredentialState, number> = {
  expired: 0,
  expiring: 1,
  notSet: 2,
  healthy: 3,
};

function warnsFrom(expiresAt: string, leadTimeDays: number): string {
  const at = Date.parse(`${expiresAt}T00:00:00.000Z`);
  return new Date(at - leadTimeDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Turn the probe's verdict into the page's rows, counts and overall verdict.
 * Pure: `registry` supplies the not-set rows' text and every entry's lead time,
 * because the probe's `skipped` list carries only env var names.
 */
export function judgeCredentials(
  registry: readonly DeclaredCredential[],
  verdict: CredentialExpiryVerdict,
): Extract<PlatformCredentialsDTO, { status: 'ok' }> {
  const byEnvVar = new Map(registry.map((c) => [c.envVar, c]));
  const lead = (envVar: string) => byEnvVar.get(envVar)?.leadTimeDays ?? LEAD_TIME_DAYS;

  const judged: PlatformCredentialRowDTO[] = verdict.entries.map((e) => ({
    envVar: e.envVar,
    name: e.name,
    expiresAt: e.expiresAt,
    state: e.state,
    daysRemaining: e.daysRemaining,
    leadTimeDays: lead(e.envVar),
    warnsFrom: warnsFrom(e.expiresAt, lead(e.envVar)),
    renewal: e.renewal,
    source: e.source,
  }));
  const notSet: PlatformCredentialRowDTO[] = verdict.skipped.flatMap((envVar) => {
    const c = byEnvVar.get(envVar);
    if (!c) return [];
    const leadTimeDays = c.leadTimeDays ?? LEAD_TIME_DAYS;
    return [
      {
        envVar,
        name: c.name,
        expiresAt: c.expiresAt,
        state: 'notSet' as const,
        daysRemaining: null,
        leadTimeDays,
        warnsFrom: warnsFrom(c.expiresAt, leadTimeDays),
        renewal: c.renewal,
        source: c.source,
      },
    ];
  });

  const rows = [...judged, ...notSet].sort(
    (a, b) =>
      ORDER[a.state] - ORDER[b.state] ||
      (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0),
  );
  const counts = { expired: 0, expiring: 0, notSet: 0, healthy: 0 };
  for (const row of rows) counts[row.state] += 1;

  const overall: PlatformCredentialsOverall =
    rows.length === 0
      ? 'empty'
      : verdict.verdict !== 'ok'
        ? verdict.verdict
        : judged.length === 0
          ? 'noneSet'
          : 'ok';

  return { status: 'ok', checkedAt: verdict.checkedAt, overall, counts, rows };
}

export const platformCredentialsService = {
  /** One check, judged for the page. Never throws: a throw from `check()` is the
   *  `failed` answer, with its message. */
  read(now: Date = new Date()): PlatformCredentialsDTO {
    try {
      return judgeCredentials(CREDENTIAL_REGISTRY, credentialExpiryService.check(now));
    } catch (error) {
      return {
        status: 'failed',
        checkedAt: now.toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
