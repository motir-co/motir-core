/**
 * `pnpm hosting:deploy-check <step>` — the OPERATOR DEPLOY CHECK (MOTIR-9805):
 * drive the hosting deploy port end to end against a real target and print what
 * happened at each step. The decision of record is MOTIR-5769.
 *
 * Steps, run one at a time so a person can open the address between them:
 *   deploy    parse the manifest, ensure the check's app, deploy release 1
 *   release2  deploy release 2 of the same image (MOTIR_DEPLOY_CHECK_RELEASE=2)
 *   rollback  roll back to the previous release and print which one serves
 *   status    print which release serves, from the port
 *   probe     GET the health path with the app's derived X-Motir-Origin-Secret
 *             and without it; print both status lines (never the secret) and
 *             fail unless they are 2xx and 403 (MOTIR-9947)
 *   report    GET / on the serving release and print the lines it answers — the
 *             env-reporting fixture's GREETING value and API_KEY presence
 *             (MOTIR-9965); fail unless it is 2xx
 *   destroy   destroy the release (prints its usage as JSON), then the app, then
 *             the app's listing, which should be empty
 *   all       every step above, in order
 *
 * Flags: `--manifest <path>` (default: the committed fixture), `--name <app>`
 * (default `motir-deploy-check-default`; any name without that prefix is refused,
 * so `destroy` cannot reach a tenant's app), `--image <ref>` (default: the
 * record's pinned `traefik/whoami`).
 *
 * `--workspace <id> --repository <projectRepositoryId> --environment <env>` (all
 * three or none, MOTIR-9965): the deploying steps take their environment from the
 * entries stored for that repository and environment, and the manifest and image
 * default to the env-reporting fixture on a pinned public Node image. Only then
 * does the script READ THE DATABASE: it needs `DATABASE_URL` and
 * `ENVIRONMENT_CONFIG_ENCRYPTION_KEY`, so run it where both live — on a motir-core
 * machine, as the bundle `node hosting/deploy-check.mjs <step> …` (built by
 * `pnpm build:deploy-check`), over `fly ssh console -a motir-core`. It prints entry
 * names and whether each is secret, never a value. Without the three flags it
 * loads no database module at all.
 *
 * Every deploying step parses the manifest FIRST: an invalid or missing one is
 * printed with its field and reason and exits 1 with no port call. The target is
 * Fly, through the composition-root accessor alone, so it needs
 * `MOTIR_HOSTING_FLY_API_TOKEN`, `MOTIR_HOSTING_GUARD_IMAGE` and
 * `MOTIR_HOSTING_ORIGIN_SECRET_KEY`; without one the step exits 1 with the
 * accessor's not-configured error naming it. With `MOTIR_FLEET_ORCHESTRATOR=fake`
 * it runs against the fake port, and `probe` against a stand-in for the guard.
 * It writes no database row, with or without the three flags.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import { existsSync, readFileSync } from 'node:fs';
import {
  DEPLOY_CHECK_APP_PREFIX,
  fakeGuardedFetch,
  runDeployCheck,
} from '@/lib/hosting/deployCheck';
import { getHostingDeployPort, hostingOriginSecretKey } from '@/lib/orchestrator/hosting';
import { selectedOrchestratorProvider } from '@/lib/orchestrator/provider';

const TAG = '[hosting-deploy-check]';

/** The committed fixtures, carried inside the bundle: the motir-core image has no
 *  `tests/`, so on a machine the default paths resolve to the texts
 *  `scripts/build-deploy-check.mjs` inlines here at build time (path → text). Unset
 *  under tsx, where the files are on disk. */
const EMBEDDED_MANIFESTS: Record<string, string> = JSON.parse(
  process.env.MOTIR_DEPLOY_CHECK_EMBEDDED_MANIFESTS ?? '{}',
) as Record<string, string>;

function readManifest(path: string): string | null {
  if (existsSync(path)) return readFileSync(path, 'utf8');
  return EMBEDDED_MANIFESTS[path] ?? null;
}

async function main(): Promise<number> {
  return runDeployCheck(process.argv.slice(2), {
    port: () => getHostingDeployPort('fly', { appPrefix: DEPLOY_CHECK_APP_PREFIX }),
    readManifest,
    print: (label, fields) => {
      console.log(`${TAG} ${label}`);
      for (const [key, value] of Object.entries(fields)) console.log(`  ${key}: ${String(value)}`);
    },
    fetch:
      selectedOrchestratorProvider() === 'fake'
        ? fakeGuardedFetch(hostingOriginSecretKey())
        : (url, init) => fetch(url, { ...init, redirect: 'manual' }),
    originSecretKey: hostingOriginSecretKey,
    // Loaded only when a step resolves a stored environment: `@/lib/db` needs
    // DATABASE_URL at import, and the plain check runs without one.
    resolveEnvironment: async (repositoryId, environment, options) => {
      const { resolveEnvironment } = await import('@/lib/environmentConfig/resolveEnvironment');
      return resolveEnvironment(repositoryId, environment, options);
    },
  });
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(TAG, err);
    process.exit(1);
  },
);
