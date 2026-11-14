/**
 * What `next.config.ts` sets so a tab left open across a deploy keeps working
 * (MOTIR-11241).
 *
 * On 2026-11-13 a tab loaded from the previous build navigated after ECS had
 * stopped that build's task. It asked for a chunk named for its own build, the
 * new task answered 404, and the tab fell to `app/global-error.tsx` — whose own
 * stylesheet was also an old-build file, so it rendered unstyled. Two settings
 * close that, and each covers a different half:
 *
 * - **`assetPrefix`** — the release's `/_next/static` is served from a durable
 *   origin (motir-infra's MOTIR-11240 static-asset origin) that keeps
 *   every release's files after its task has stopped. The deploy uploads the
 *   build's files there BEFORE it rolls (`scripts/aws-deploy/staticAssets.ts`).
 * - **`deploymentId`** — the commit SHA. Next sends it with every in-app
 *   navigation and Server Action and, when the server answers from a different
 *   build, does a full page load instead of mixing two builds' payloads
 *   (`fetch-server-response.js`: a navigation build id that differs from the
 *   client's → `doMpaNavigation`). The Server Action SALT is already stable
 *   (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, MOTIR-3948); action ids and the
 *   navigation payload are still per build.
 *
 * ⚠️ BOTH ARE PRODUCTION-BUILD ONLY, AND ONLY WHEN THE VALUE ARRIVED. The image
 * build passes `MOTIR_RELEASE` (the commit SHA, already the Sentry release) and
 * `MOTIR_ASSET_PREFIX` (the origin the deploy read from
 * `/<prefix>/core/static-assets`) as build arguments. `next dev`, CI's builds,
 * the E2E servers and a self-hoster's `docker build` pass neither, so they keep
 * serving `/_next/static` from the app itself — no prefix, no change.
 *
 * A prefix that is not an absolute `https://` origin FAILS THE BUILD rather than
 * shipping: every script and stylesheet the HTML names would point at it, and a
 * typo there is an outage that every health check passes.
 */

/** The build arguments this reads — `Dockerfile`'s builder stage declares both. */
export const ASSET_PREFIX_ENV = 'MOTIR_ASSET_PREFIX';
export const DEPLOYMENT_ID_ENV = 'MOTIR_RELEASE';

export interface VersionSkewConfig {
  assetPrefix?: string;
  deploymentId?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The static origin as Next wants it: an absolute `https://` URL with no
 * trailing slash, no query and no fragment (Next joins `/_next/static/…` onto
 * it). Throws on anything else.
 */
export function normalizeAssetPrefix(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${ASSET_PREFIX_ENV} must be an absolute https:// URL, got '${raw}'`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${ASSET_PREFIX_ENV} must be an https:// URL, got '${raw}'`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(
      `${ASSET_PREFIX_ENV} must be a bare origin (optionally with a path), got '${raw}'`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Next's `deploymentId` is sent as a header and appended as `?dpl=`; keep it to safe characters. */
export function normalizeDeploymentId(raw: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(raw)) {
    throw new Error(
      `${DEPLOYMENT_ID_ENV} must be 1–64 characters of [A-Za-z0-9._-] to serve as Next's deploymentId, got '${raw}'`,
    );
  }
  return raw;
}

/**
 * The `next.config` keys for this build: `{}` for anything but a production
 * build, and each key only when its build argument is set.
 */
export function versionSkewConfig(env: Env = process.env): VersionSkewConfig {
  if (env['NODE_ENV'] !== 'production') return {};
  const prefix = nonEmpty(env[ASSET_PREFIX_ENV]);
  const release = nonEmpty(env[DEPLOYMENT_ID_ENV]);
  return {
    ...(prefix ? { assetPrefix: normalizeAssetPrefix(prefix) } : {}),
    ...(release ? { deploymentId: normalizeDeploymentId(release) } : {}),
  };
}
