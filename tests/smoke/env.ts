// The run's inputs for the cutover smoke lane (Story MOTIR-9712 · MOTIR-10076).
//
// Every value comes from the run, and none has a default: the lane drives a
// DEPLOYED stack (a rehearsal hostname, or production), so a missing value must
// stop the run rather than fall back to localhost. `playwright.smoke.config.ts`
// calls this at load, so an unset variable fails before a browser is launched,
// with ONE message naming every variable that is missing.
//
// This module imports nothing: the spec that reads it must stay free of the app
// (`@/lib/*`) and of the E2E harness (`tests/e2e/_helpers/*`).

/** The variables the lane reads, in the order the runbook lists them. */
export const SMOKE_ENV_VARIABLES = [
  'SMOKE_BASE_URL',
  'SMOKE_EMAIL',
  'SMOKE_PASSWORD',
  'SMOKE_ITEM_KEY',
  'SMOKE_PROJECT_NAME',
  'SMOKE_PRIVATE_STORE_HOST',
  'SMOKE_PUBLIC_ASSET_ORIGIN',
] as const;

export type SmokeEnvVariable = (typeof SMOKE_ENV_VARIABLES)[number];

export interface SmokeEnv {
  /** The deployed origin the walk signs in to, e.g. `https://app.motir.co`. */
  baseUrl: string;
  email: string;
  password: string;
  /** An existing work item with at least one comment and one attachment. */
  itemKey: string;
  /** The project, as the project switcher names it, whose uploaded image is checked. */
  projectName: string;
  /** The host a presigned attachment GET must point at — the private bucket's. */
  privateStoreHost: string;
  /** The origin `MOTIR_S3_PUBLIC_BASE_URL` names, which avatars and project images load from. */
  publicAssetOrigin: string;
}

export class SmokeEnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`The cutover smoke run cannot start:\n- ${problems.join('\n- ')}`);
    this.name = 'SmokeEnvError';
  }
}

function originOf(name: SmokeEnvVariable, raw: string, problems: string[]): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} is not a URL: ${raw}`);
    return raw;
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    problems.push(`${name} must be https: ${raw}`);
  }
  return url.origin;
}

/** Read and check the lane's variables; throws one {@link SmokeEnvError} naming every problem. */
export function readSmokeEnv(env: Record<string, string | undefined> = process.env): SmokeEnv {
  const missing = SMOKE_ENV_VARIABLES.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new SmokeEnvError([`missing ${missing.join(', ')}`]);
  }
  const value = (name: SmokeEnvVariable): string => env[name]!.trim();

  const problems: string[] = [];
  const baseUrl = originOf('SMOKE_BASE_URL', value('SMOKE_BASE_URL'), problems);
  const publicAssetOrigin = originOf(
    'SMOKE_PUBLIC_ASSET_ORIGIN',
    value('SMOKE_PUBLIC_ASSET_ORIGIN'),
    problems,
  );
  const privateStoreHost = value('SMOKE_PRIVATE_STORE_HOST').toLowerCase();
  if (/[/:]/.test(privateStoreHost)) {
    problems.push(`SMOKE_PRIVATE_STORE_HOST must be a bare host name: ${privateStoreHost}`);
  }
  if (problems.length > 0) throw new SmokeEnvError(problems);

  return {
    baseUrl,
    email: value('SMOKE_EMAIL'),
    password: value('SMOKE_PASSWORD'),
    itemKey: value('SMOKE_ITEM_KEY').toUpperCase(),
    projectName: value('SMOKE_PROJECT_NAME'),
    privateStoreHost,
    publicAssetOrigin,
  };
}

/** A Tigris storage host — what no asset may load from once the window has run. */
export function isTigrisHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return /(^|\.)tigris\.(dev|io)$/.test(host) || /(^|\.)t3\.storage\.dev$/.test(host);
}
