// THE DECLARED CREDENTIAL REGISTRY (MOTIR-1933) — every platform credential
// whose lapse would go silent, with the date it lapses on.
//
// ⚠️ EXPIRY IS DECLARED, NOT DISCOVERED. Neither a GitHub fine-grained token nor
// a Fly org token exposes its own expiry to the bearer in a way motir-core can
// read without a further privileged call, and that call would itself need a
// credential to watch. So the date lives HERE, typed by whoever minted the
// token, and a declared date can drift from the real one: a token re-minted
// early, or with a different lifetime, is wrong here until somebody edits this
// file. That is why every entry cites the card or comment that minted it
// (`source`) — the date is only as good as that record, and a reader checking it
// has to know where to look.
//
// ⚠️ WHY THIS EXISTS. When `GITHUB_BILLING_TOKEN` lapses, `billingUsageToken()`
// (`lib/ciMetering/config.ts`) still returns it — the variable is still SET — so
// `system.ci-minutes-reconcile` keeps calling GitHub with a token GitHub refuses,
// and the audit that falsifies meter drift stops with nothing going red. `system.daily-health-check` reads this registry every morning and
// fails, naming the credential, thirty days before that happens.
//
// ADDING A CREDENTIAL is one entry here and nothing else: the probe
// (`credentialExpiryProbe.ts`) iterates the registry and knows no names. Each
// later credential is registered by the card that introduces it, as 10.2.4b
// (MOTIR-7332) did for `FLY_DEPLOYMENT_READ_TOKEN`. A credential that does
// not expire (`SENTRY_READ_TOKEN`, MOTIR-739) is not registered at all.
//
// THE FULL LIST lives in the credential inventory (MOTIR-9408), a Motir page
// that names every platform credential, where it is set, what it is for, who
// issued it and when it expires. Every credential it marks as expiring on a
// known date is an entry below; the console's `/admin/credentials` page shows
// this registry as the daily health check judges it.
//
// ⚠️ A CREDENTIAL CORE DOES NOT HOLD. Some expiring credentials live outside
// motir-core's own environment — another service's Secrets Manager entry, a
// GitHub Actions repository secret — so core can never see whether they are
// set. They carry `heldIn`, and the probe judges them on Motir's own cloud
// (`MOTIR_CLOUD=true`) instead of by their variable: that is the one deployment
// that holds them. A self-hosted build skips them, as it skips an unset token.

/** One credential whose expiry is watched by the daily health check. */
export interface DeclaredCredential {
  /** The environment variable the credential is read from. A probe reports the NAME, never the value. */
  readonly envVar: string;
  /** What a human calls it, for the DLQ row. */
  readonly name: string;
  /** The day it lapses, as an ISO date (`YYYY-MM-DD`), read as 00:00 UTC on that day. */
  readonly expiresAt: string;
  /** Days ahead of `expiresAt` at which the probe starts failing. Defaults to {@link LEAD_TIME_DAYS}. */
  readonly leadTimeDays?: number;
  /** What the operator renews, and where — the sentence the DLQ row ends on. */
  readonly renewal: string;
  /** The card or comment that minted it, which is where `expiresAt` came from. */
  readonly source: string;
  /**
   * Where the credential is held when that is NOT motir-core's own environment
   * (`motir-ai`'s Secrets Manager group, a repository's Actions secrets). Such an
   * entry is judged on Motir's cloud (`MOTIR_CLOUD=true`) and skipped elsewhere,
   * because core cannot read whether another store holds it.
   */
  readonly heldIn?: string;
}

/**
 * How many days ahead of a declared expiry the daily health check starts
 * failing: **30**.
 *
 * Renewing either credential this registry exists for is a `manual` card — a
 * person mints a fine-grained GitHub token or a Fly org token in a dashboard,
 * writes it to the secret store that holds it, and confirms it on the card. That is minutes of
 * work, but it waits on a person reading the alert, picking the card up and
 * having the org-owner role, across weekends and leave. Thirty days covers a
 * missed fortnight with time to spare; a week would not survive one holiday, and
 * a quarter would leave the check red for so long that people learn to read past
 * it — the way MOTIR-3606 sat red for 23 days.
 */
export const LEAD_TIME_DAYS = 30;

/** Core's own `later` secret group in AWS Secrets Manager, where the motir-core
 *  credentials below are held since the AWS cutover (motir-infra
 *  `docs/core-secret-groups.md`). */
const CORE_LATER_GROUP = '`motir/core/grouped-later`';

/** How a key in one of the grouped secrets is changed, per motir-infra. */
function inGroup(envVar: string, group: string): string {
  return (
    `set it as the \`${envVar}\` key of ${group} in AWS Secrets Manager ` +
    '(Retrieve secret value → Edit), redeploy the service that reads it'
  );
}

/** The credentials the daily health check watches. */
export const CREDENTIAL_REGISTRY: readonly DeclaredCredential[] = [
  {
    envVar: 'GITHUB_BILLING_TOKEN',
    name: 'GitHub billing usage token (the CI-minutes reconciliation audit)',
    expiresAt: '2027-07-31',
    renewal:
      'mint a replacement fine-grained token the way MOTIR-1908 did, then ' +
      `${inGroup('GITHUB_BILLING_TOKEN', CORE_LATER_GROUP)} and move this entry's expiresAt`,
    source: 'MOTIR-1908, the manual card that minted it (expiry as recorded on MOTIR-1933)',
  },
  {
    envVar: 'GITHUB_ENTERPRISE_ADMIN_TOKEN',
    name: "GitHub Enterprise admin token (creating a hosted customer's GitHub organization)",
    expiresAt: '2027-10-23',
    renewal:
      "mint a replacement classic `admin:enterprise` token from the Enterprise owner's account " +
      `the way MOTIR-8962 did, then ${inGroup('GITHUB_ENTERPRISE_ADMIN_TOKEN', CORE_LATER_GROUP)} ` +
      "and move this entry's expiresAt",
    source: 'MOTIR-8962, the comment of 2026-10-23 that recorded the minted token and its expiry',
  },
  {
    envVar: 'MOTIR_HOSTING_FLY_API_TOKEN',
    name: 'Fly org token for motir-hosting (hosted applications)',
    // Minted with an explicit one-year expiry; read back as 2027-10-28 02:21:47 UTC.
    expiresAt: '2027-10-28',
    renewal:
      'mint a replacement org token for `motir-hosting` the way MOTIR-9804 did, then ' +
      `${inGroup('MOTIR_HOSTING_FLY_API_TOKEN', CORE_LATER_GROUP)} and move this entry's expiresAt`,
    source: 'MOTIR-9804, the manual card that minted it (expiry read back from `fly tokens list`)',
  },
  {
    envVar: 'MOTIR_AI_READ_TOKEN',
    name: "motir-ai read token (motir-meta's guards read motir-ai's corpus)",
    expiresAt: '2027-09-15',
    renewal:
      'mint a replacement fine-grained token with Contents read on motir-ai the way MOTIR-5208 ' +
      'did, set it as the `MOTIR_AI_READ_TOKEN` Actions secret of motir-meta, and move this ' +
      "entry's expiresAt (MOTIR-5435 is the renewal card)",
    source: 'MOTIR-5208, the manual card that minted it',
    heldIn: 'the motir-meta repository Actions secrets',
  },
  {
    envVar: 'MARKETING_DISPATCH_TOKEN',
    name: 'Marketing dispatch token (motir-ai writes to motir-marketing)',
    expiresAt: '2027-11-09',
    renewal:
      'mint a replacement fine-grained token scoped to motir-marketing with Contents read and ' +
      `write the way MOTIR-10654 did, then ${inGroup('MARKETING_DISPATCH_TOKEN', '`motir/ai/grouped-boot`')} ` +
      "and move this entry's expiresAt",
    source: 'MOTIR-10654, the manual card that minted it',
    heldIn: "motir-ai's Secrets Manager group `motir/ai/grouped-boot`",
  },
  {
    envVar: 'FLY_CERTS_TOKEN',
    name: 'Fly certificates token (customer-domain certificates at the edge)',
    // Fly's default lifetime, read back as 2046-08-29 03:03:40 UTC. MOTIR-10131
    // re-points it at the motir-edge app; that re-mint moves this date.
    expiresAt: '2046-08-29',
    renewal:
      'mint a replacement deploy token for the app `FLY_CERTS_APP` names the way MOTIR-4214 did ' +
      `(MOTIR-10131 re-points it at motir-edge), then ${inGroup('FLY_CERTS_TOKEN', CORE_LATER_GROUP)} ` +
      "and move this entry's expiresAt",
    source: 'MOTIR-4214, the manual card that minted it (expiry read from `fly tokens list`)',
  },
  {
    envVar: 'FLY_FLEET_DEPLOY_TOKEN',
    name: "Fly deploy token for motir-index-runners (motir-ai's index image release)",
    // Minted 2026-08-03 without `--expiry`: flyctl's default of 175,200 hours.
    expiresAt: '2046-07-29',
    renewal:
      'mint a replacement deploy token on `motir-index-runners` the way MOTIR-2024 did, set it ' +
      "as the `FLY_FLEET_DEPLOY_TOKEN` Actions secret of motir-ai, and move this entry's expiresAt",
    source:
      "MOTIR-2024, the manual card that minted it on 2026-08-03 (expiry is flyctl's 20-year default from that day)",
    heldIn: 'the motir-ai repository Actions secrets',
  },
  {
    envVar: 'FLY_DEPLOYMENT_READ_TOKEN',
    name: "Fly read-only org token (the operator console's Hosting card)",
    // Fly's default lifetime: it was minted without `--expiry`, by the owner's
    // decision. Far off, and declared anyway, so a re-mint with a shorter life is
    // one edit here rather than a credential nobody watches. Since the AWS cutover
    // it is not injected into core (MOTIR-10957 revokes it), so it is skipped.
    expiresAt: '2046-09-27',
    renewal:
      'mint a replacement with `fly tokens create readonly moooon` the way MOTIR-7331 did, then ' +
      "set `FLY_DEPLOYMENT_READ_TOKEN` where core reads it and move this entry's expiresAt",
    source: 'MOTIR-7331, the manual card that minted it (expiry read from `fly tokens list`)',
  },
];
