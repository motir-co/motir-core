// THE STAGING SIDE-EFFECT SWITCH TABLE (Story MOTIR-8538 · MOTIR-8672).
//
// A staging app runs a COPY of production's database. Every outbound side effect
// motir-core can cause is already behind an environment variable that is read at
// CALL time, and the shipped seam refuses loudly when it is unset. This table is
// that fact made reviewable: one row per channel, the keys that switch it, the
// state each key must be in on a staging machine for the channel to be a sink,
// and the shipped file + symbol the row relies on.
//
// The preflight (`loadtest/preflight/sideEffects.ts`) reads each RUNNING staging
// machine's environment and evaluates every row against it; the secrets template
// (`loadtest/staging/staging.secrets.example`) is generated from this file, so the
// names the provisioning card sets and the names the preflight demands cannot drift.
//
// ⚠️ A row that claims "unset is a sink" owes the reading of WHICH seam refuses.
// Each row's `seams` names it; the PR that introduced this file carries the
// per-row readings (`git grep` on origin/main, 2026-10-15).
//
// Adding a row: append it, give it an id, extend `ROW_IDS` (the runbook keeps one
// by-hand subsection per id, and its guard test fails when the two sets differ),
// then regenerate the template with `pnpm loadtest:secrets-template`.

/** The nine row ids, in table order. The runbook's sink subsections use these names. */
export const ROW_IDS = [
  'email',
  'github',
  'sentry',
  'motir-ai',
  'fleet',
  'billing',
  'database',
  'stored-credentials',
  'provider-seams',
] as const;

export type RowId = (typeof ROW_IDS)[number];

/**
 * The state a key must be in on every started staging machine.
 *
 * - `absent` — the key is not in the machine's environment at all. Every row that
 *   uses it relies on a seam that refuses (throws a typed not-configured error, or
 *   returns null) when the key is unset.
 * - `equals` — the key holds exactly `value`.
 * - `host-is-staging` — the key is a connection URL whose endpoint host (after
 *   stripping `-pooler`) equals `LOADTEST_ALLOWED_DB_HOST` and is not one of
 *   `LOADTEST_PRODUCTION_DB_HOSTS`. Hosts, never digests: production's URL with one
 *   extra query parameter has a different digest and still points at production.
 * - `differs-from-production` — the key is a Sentry DSN whose project id is not
 *   `LOADTEST_PRODUCTION_SENTRY_PROJECT_ID`.
 */
export type RequiredState =
  | { kind: 'absent' }
  | { kind: 'equals'; value: string }
  | { kind: 'host-is-staging' }
  | { kind: 'differs-from-production' };

export interface SwitchKey {
  key: string;
  state: RequiredState;
}

export interface Seam {
  file: string;
  symbol: string;
}

export interface SwitchRow {
  id: RowId;
  channel: string;
  /** The keys and their required states. Empty for a row `coveredBy` another. */
  keys: readonly SwitchKey[];
  /** A row whose channel is closed by ANOTHER row's keys (billing → motir-ai). */
  coveredBy?: RowId;
  seams: readonly Seam[];
  /** One sentence: why that state is a sink. */
  why: string;
}

const absent = (...keys: string[]): SwitchKey[] =>
  keys.map((key) => ({ key, state: { kind: 'absent' } }));

export const SWITCH_TABLE: readonly SwitchRow[] = [
  {
    id: 'email',
    channel: 'email',
    keys: [
      { key: 'EMAIL_PROVIDER', state: { kind: 'equals', value: 'console' } },
      ...absent('RESEND_API_KEY'),
    ],
    seams: [{ file: 'lib/email.ts', symbol: 'getEmailProvider' }],
    why:
      'The `console` provider logs the message and delivers nothing; `file` is refused under ' +
      'NODE_ENV=production (`fileProvider`), so `console` is the only sink a staging build can use.',
  },
  {
    id: 'github',
    channel: 'GitHub writes',
    keys: absent(
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_STUDIO_APP_ID',
      'GITHUB_STUDIO_APP_PRIVATE_KEY',
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_BILLING_TOKEN',
    ),
    seams: [
      { file: 'lib/github/appAuth.ts', symbol: 'APP_ENV' },
      { file: 'lib/github/appAuth.ts', symbol: 'GithubAppNotConfiguredError' },
      {
        file: 'lib/ciMetering/config.ts',
        symbol: 'GITHUB_BILLING_TOKEN (returns null when unset)',
      },
    ],
    why:
      'With no App id or private key no installation token can be minted, so nothing can write to ' +
      'a repository; the OAuth pair and the billing token are the remaining GitHub credentials.',
  },
  {
    id: 'sentry',
    channel: 'Sentry',
    keys: [
      { key: 'SENTRY_DSN', state: { kind: 'differs-from-production' } },
      { key: 'SENTRY_ENVIRONMENT', state: { kind: 'equals', value: 'staging' } },
      ...absent('SENTRY_READ_TOKEN', 'SENTRY_APP_CLIENT_ID', 'SENTRY_APP_CLIENT_SECRET'),
    ],
    seams: [
      { file: 'lib/monitoring/config.ts', symbol: 'serverSentryDsn' },
      { file: 'lib/monitoring/serverInit.ts', symbol: 'serverSentryInitOptions' },
      { file: 'lib/monitoring/sentryErrorCount.ts', symbol: 'SENTRY_READ_TOKEN (returns null)' },
      { file: 'lib/monitors/providers/sentry.ts', symbol: 'SENTRY_APP_CLIENT_ID (throws)' },
    ],
    why:
      'Server events and traces go to a separate staging project, wanted for the slowest spans; ' +
      'the browser DSN (`NEXT_PUBLIC_SENTRY_DSN`) is inlined at build time and never fires during a ' +
      'run because k6 executes no client JavaScript, but a person opening staging in a browser would ' +
      "send errors to production's project (the runbook carries that warning).",
  },
  {
    id: 'motir-ai',
    channel: 'motir-ai',
    keys: absent(
      'MOTIR_AI_URL',
      'MOTIR_AI_SERVICE_TOKEN',
      'MOTIR_AI_CONTAINER_URL',
      'MOTIR_AI_TO_CORE_SERVICE_TOKEN',
    ),
    seams: [
      { file: 'lib/ai/motirAiClient.ts', symbol: 'motirAiBaseUrl' },
      { file: 'lib/ai/motirAiClient.ts', symbol: 'config' },
      { file: 'lib/ai/motirAiClient.ts', symbol: 'motirAiContainerBaseUrl' },
    ],
    why:
      'Unset, every call throws `MotirAiConfigError`, so no planning, indexing or billing read ' +
      "reaches production's motir-ai and no AI credit is spent; without the inbound token motir-ai " +
      'cannot call this app either.',
  },
  {
    id: 'fleet',
    channel: 'fleet machines',
    keys: absent(
      'FLY_FLEET_API_TOKEN',
      'FLY_FLEET_APP',
      'FLY_INSTANCES_API_TOKEN',
      'FLY_INVENTORY_API_TOKEN',
      'FLY_CERTS_TOKEN',
      'FLY_CERTS_APP',
      'FLY_DEPLOYMENT_READ_TOKEN',
    ),
    seams: [
      { file: 'lib/orchestrator/index.ts', symbol: 'getOrchestrator' },
      { file: 'lib/orchestrator/index.ts', symbol: 'getPersistentOrchestrator' },
      {
        file: 'packages/orchestrator/src/adapters/fly/inventory.ts',
        symbol: 'OrchestratorNotConfiguredError',
      },
      {
        file: 'lib/publicAddresses/adapters/fly/flyCertificates.ts',
        symbol: 'CertificateProviderNotConfiguredError',
      },
      {
        file: 'lib/deployment/adapters/fly/flyMachinesStatus.ts',
        symbol: 'FLY_DEPLOYMENT_READ_TOKEN (returns null)',
      },
    ],
    why:
      'With no Fly token the orchestrator throws `OrchestratorNotConfiguredError`, so no agent or ' +
      'index machine is booted and no container usage is charged; the certificate and ' +
      'deployment-status tokens are the other ways the app acts on Fly.',
  },
  {
    id: 'billing',
    channel: 'billing',
    keys: [],
    coveredBy: 'motir-ai',
    seams: [
      {
        file: 'lib/ai/motirAiClient.ts',
        symbol: '/v1/stripe/subscription, /v1/stripe/billing-history',
      },
      {
        file: 'lib/services/agentInstanceChargeService.ts',
        symbol: 'recordContainerUsage (via the fleet)',
      },
    ],
    why:
      'The only billing calls in core are read-throughs to motir-ai (closed by the motir-ai row), and ' +
      'the only charge core writes is container usage, reached only when a fleet machine boots ' +
      '(closed by the fleet row) — and it writes into the copied database, not to a provider.',
  },
  {
    id: 'database',
    channel: 'the database',
    keys: [
      { key: 'DATABASE_URL', state: { kind: 'host-is-staging' } },
      { key: 'DATABASE_URL_UNPOOLED', state: { kind: 'host-is-staging' } },
    ],
    seams: [
      { file: 'lib/db.ts', symbol: 'DATABASE_URL' },
      { file: 'lib/jobs/engine/notify.ts', symbol: 'DATABASE_URL_UNPOOLED (the listener)' },
    ],
    why:
      "The worst side effect a staging run can have is writing to production's branch, so both " +
      "URLs must point at the staging branch's endpoint, compared by host.",
  },
  {
    id: 'stored-credentials',
    channel: 'stored outbound credentials',
    keys: absent(
      'GITHUB_TOKEN_ENCRYPTION_KEY',
      'GITLAB_TOKEN_ENCRYPTION_KEY',
      'SENTRY_TOKEN_ENCRYPTION_KEY',
      'IMPORT_TOKEN_ENCRYPTION_KEY',
      'MOTIR_TERMINAL_MASTER_KEY',
    ),
    seams: [
      { file: 'lib/github/tokenCrypto.ts', symbol: 'ENV_KEY' },
      { file: 'lib/gitlab/tokenCrypto.ts', symbol: 'GITLAB_TOKEN_ENCRYPTION_KEY' },
      { file: 'lib/monitors/tokenCrypto.ts', symbol: 'SENTRY_TOKEN_ENCRYPTION_KEY' },
      {
        file: 'lib/services/importSourceIdentityService.ts',
        symbol: 'IMPORT_TOKEN_ENCRYPTION_KEY',
      },
      {
        file: 'lib/agentInstances/terminal.ts',
        symbol: 'MOTIR_TERMINAL_MASTER_KEY (terminal off)',
      },
    ],
    why:
      'The copied database carries encrypted provider tokens; with no decrypt key a staging worker ' +
      "cannot use or refresh them, so it can never rotate a real customer's token upstream.",
  },
  {
    id: 'provider-seams',
    channel: 'other provider and relay seams',
    keys: absent(
      'GITLAB_APP_CLIENT_ID',
      'GITLAB_APP_CLIENT_SECRET',
      'GITLAB_WEBHOOK_SECRET',
      'JIRA_OAUTH_CLIENT_ID',
      'JIRA_OAUTH_CLIENT_SECRET',
      'LINEAR_OAUTH_CLIENT_ID',
      'LINEAR_OAUTH_CLIENT_SECRET',
      'PLANE_OAUTH_CLIENT_ID',
      'PLANE_OAUTH_CLIENT_SECRET',
      'MOTIR_GATEWAY_URL',
      'MOTIR_GATEWAY_RUN_URL',
      'MOTIR_RUN_KEY_MINT_SECRET',
      'MOTIR_RELAY_URL',
      'CORE_CALLBACK_SECRET',
      'MOTIR_S3_ACCESS_KEY_ID',
      'MOTIR_S3_SECRET_ACCESS_KEY',
    ),
    seams: [
      { file: 'lib/gitlab/gitlabOAuth.ts', symbol: 'GitlabOAuthNotConfiguredError' },
      { file: 'lib/gitlab/projectWebhook.ts', symbol: 'SECRET_ENV' },
      { file: 'lib/services/jiraOAuthService.ts', symbol: 'JiraOAuthNotConfiguredError' },
      { file: 'lib/services/linearImportOAuthService.ts', symbol: 'LinearOAuthNotConfiguredError' },
      { file: 'lib/services/planeImportOAuthService.ts', symbol: 'PlaneOAuthNotConfiguredError' },
      { file: 'lib/gateway/runKeyClient.ts', symbol: 'GatewayRunKeyConfigError' },
      { file: 'lib/agentTerminal/protocol.ts', symbol: 'terminalRelayUrl' },
      { file: 'lib/ai/jobAuth.ts', symbol: 'CORE_CALLBACK_SECRET' },
      { file: 'lib/blob/s3.ts', symbol: 'S3_ENV (required() throws)' },
    ],
    why:
      'Each import, webhook, gateway and object-storage seam throws a typed not-configured error ' +
      'when its key is unset, so no third-party API is called and no object is written to the ' +
      'production buckets; the relay URL is only handed to a browser, and with the terminal key ' +
      'absent no terminal ticket is minted.',
  },
];

/**
 * Names the staging app must carry WITH ANY VALUE: the app cannot run, or be
 * driven, without them. Not sink rows, so they have no row id. A required name
 * that is absent from a machine is `MISSING` and refuses exactly like `LIVE`.
 *
 * Hypothesis checked on the first deploy (the provisioning card): the app boots
 * with exactly the names in the template. If it refuses to boot naming another
 * variable, that name is added here WITH THE REASON, never with a production value.
 */
export const REQUIRED_SET: readonly { key: string; why: string }[] = [
  {
    key: 'BETTER_AUTH_SECRET',
    why: 'required at module load (`lib/auth/index.ts`); a fresh value per environment',
  },
  {
    key: 'GOOGLE_CLIENT_ID',
    why: "required at module load (`lib/auth/index.ts`); a placeholder, never production's client",
  },
  {
    key: 'GOOGLE_CLIENT_SECRET',
    why: 'required at module load (`lib/auth/index.ts`); a placeholder',
  },
  { key: 'MOTIR_BASE_URL', why: "the app's own origin, `http://motir-core-staging.flycast`" },
  {
    key: 'MOTIR_API_V1_RATE_LIMIT',
    why: 'the per-token `/api/v1` budget the run-lifecycle scenario needs (6000)',
  },
  { key: 'SENTRY_TRACES_SAMPLE_RATE', why: 'the trace rate the run header records' },
];

/**
 * Keys deliberately NOT checked on a machine, with the reason. They are inlined
 * at BUILD time, so the deployed image decides them and no secret can change them.
 */
export const BUILD_TIME_EXCLUSIONS: readonly { key: string; why: string }[] = [
  {
    key: 'NEXT_PUBLIC_SENTRY_DSN',
    why:
      "Inlined into the client bundle when CI builds the image, so staging carries production's " +
      'browser DSN. k6 runs no client JavaScript, so no event is sent during a run; a person who opens ' +
      "staging in a browser would send errors to production's project.",
  },
];

/** Every key the table lists, in table order. */
export function tableKeys(): string[] {
  return SWITCH_TABLE.flatMap((row) => row.keys.map((k) => k.key));
}

/**
 * The template's "set" names: the union of the rows' `equals` / `host-is-staging`
 * / `differs-from-production` keys and the required-set entries. THIS is the exact
 * set of secret names the provisioning card sets on the staging app, and no other.
 */
export function templateSetNames(): string[] {
  const fromRows = SWITCH_TABLE.flatMap((row) =>
    row.keys.filter((k) => k.state.kind !== 'absent').map((k) => k.key),
  );
  return [...new Set([...fromRows, ...REQUIRED_SET.map((r) => r.key)])];
}

/** The template's "do not set" names: every `absent` key, in table order. */
export function templateDoNotSetNames(): string[] {
  return SWITCH_TABLE.flatMap((row) =>
    row.keys.filter((k) => k.state.kind === 'absent').map((k) => k.key),
  );
}

/**
 * The names the provisioning card (MOTIR-8674) sets with `fly secrets import`,
 * listed as that card lists them. A unit test fails when this differs from
 * `templateSetNames()`, so a row change that moves a set name has to move the
 * provisioning list with it.
 */
export const PROVISIONING_SET_NAMES: readonly string[] = [
  'EMAIL_PROVIDER',
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MOTIR_BASE_URL',
  'MOTIR_API_V1_RATE_LIMIT',
  'SENTRY_TRACES_SAMPLE_RATE',
];

function setLine(key: string): string {
  for (const row of SWITCH_TABLE) {
    const k = row.keys.find((x) => x.key === key);
    if (!k) continue;
    switch (k.state.kind) {
      case 'equals':
        return `${key}="${k.state.value}"`;
      case 'host-is-staging':
        return `# ${row.id}: a URL whose endpoint host is the STAGING branch's (LOADTEST_ALLOWED_DB_HOST)\n${key}=""`;
      case 'differs-from-production':
        return `# ${row.id}: the STAGING Sentry project's DSN, never production's\n${key}=""`;
    }
  }
  const required = REQUIRED_SET.find((r) => r.key === key);
  return `# set, any value: ${required?.why ?? ''}\n${key}=""`;
}

/** The generated `staging.secrets.example`. No secret value is ever written into it. */
export function renderSecretsTemplate(): string {
  const lines: string[] = [
    '# GENERATED by `pnpm loadtest:secrets-template` from loadtest/staging/sideEffectSwitches.ts.',
    '# Do not edit by hand; edit the table and regenerate.',
    '#',
    '# Copy to staging.secrets.local (uncommitted), fill the empty values, and apply with',
    '#   fly secrets import -a motir-core-staging < staging.secrets.local',
    '# The names below are EXACTLY the set the preflight demands: an extra name or a missing one',
    '# refuses a run. Never paste a production value.',
    '',
    '# ── SET ──────────────────────────────────────────────────────────────────────',
  ];
  for (const key of templateSetNames()) lines.push(setLine(key));
  lines.push('', '# ── DO NOT SET (each must be absent on every staging machine) ───────────────');
  for (const row of SWITCH_TABLE) {
    const keys = row.keys.filter((k) => k.state.kind === 'absent').map((k) => k.key);
    if (keys.length === 0) continue;
    lines.push(`# ${row.id}: ${keys.join(', ')}`);
  }
  lines.push('', '# ── COVERED BY ANOTHER ROW ─────────────────────────────────────────────────');
  for (const row of SWITCH_TABLE) {
    if (row.coveredBy) lines.push(`# ${row.id}: covered by ${row.coveredBy}`);
  }
  lines.push('', '# ── NOT CHECKED (inlined at build time) ────────────────────────────────────');
  for (const ex of BUILD_TIME_EXCLUSIONS) lines.push(`# ${ex.key}: build-time, see the table`);
  return `${lines.join('\n')}\n`;
}

/* v8 ignore start -- the generator's process entry; `renderSecretsTemplate` is tested. */
if (/sideEffectSwitches\.ts$/.test(process.argv[1] ?? '') && process.argv.includes('--write')) {
  void import('node:fs').then(({ writeFileSync }) => {
    const out = new URL('./staging.secrets.example', import.meta.url);
    writeFileSync(out, renderSecretsTemplate());
    process.stdout.write(`wrote ${out.pathname}\n`);
  });
}
/* v8 ignore stop */
