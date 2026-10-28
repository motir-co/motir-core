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
 *   destroy   destroy the release (prints its usage as JSON), then the app, then
 *             the app's listing, which should be empty
 *   all       every step above, in order
 *
 * Flags: `--manifest <path>` (default: the committed fixture), `--name <app>`
 * (default `motir-deploy-check-default`; any name without that prefix is refused,
 * so `destroy` cannot reach a tenant's app), `--image <ref>` (default: the
 * record's pinned `traefik/whoami`).
 *
 * Every deploying step parses the manifest FIRST: an invalid or missing one is
 * printed with its field and reason and exits 1 with no port call. The target is
 * Fly, through the composition-root accessor alone, so it needs
 * `MOTIR_HOSTING_FLY_API_TOKEN`, `MOTIR_HOSTING_GUARD_IMAGE` and
 * `MOTIR_HOSTING_ORIGIN_SECRET_KEY`; without one the step exits 1 with the
 * accessor's not-configured error naming it. With `MOTIR_FLEET_ORCHESTRATOR=fake`
 * it runs against the fake port, and `probe` against a stand-in for the guard.
 * It writes no database row.
 *
 * `--target serverless` (MOTIR-9975) runs the serverless target instead, on
 * Motir's own serverless account and Neon organisation, with its app named
 * `mh-deploy-check-<name>` (inside the scoped role's `mh-*`):
 *   database  create the app's database; print its provider, ref and pair NAMES
 *   image     build tests/fixtures/hosting/serverless for release 1 and push it
 *             to the app's ECR repository; print the digest
 *   deploy    ensure the app, build and push release 1, deploy it with the
 *             database's pairs as secret env
 *   release2  the same for release 2 (another label, so another digest)
 *   rollback · status  as for Fly
 *   probe     GET the health path SIGNED (SigV4) and unsigned; fail unless the
 *             first is 200 with `database: reachable` and the second 403
 *   refuse    deploy the worker fixture (requires.backgroundWork) and pass only
 *             on the target's refusal naming that field and Fly
 *   destroy   destroy the release, the app and the database, printing both
 *             usages, then fail unless nothing is left
 *   all       refuse, database, deploy, probe, release2, probe, rollback,
 *             probe, status, destroy
 * It needs `MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN` (assumed from the operator's
 * own AWS credentials), `MOTIR_HOSTING_NEON_API_KEY`, `MOTIR_HOSTING_NEON_ORG_ID`,
 * Docker with buildx, and the AWS CLI for the registry login. Pair values are
 * never printed.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPLOY_CHECK_APP_PREFIX,
  fakeGuardedFetch,
  runDeployCheck,
} from '@/lib/hosting/deployCheck';
import {
  FAKE_SERVERLESS_REGISTRY,
  fakeFunctionUrlFetch,
  fakeImageBuilder,
  SERVERLESS_DEPLOY_CHECK_APP_PREFIX,
  SERVERLESS_DEPLOY_CHECK_IMAGE_CONTEXT,
  type ServerlessDeployCheckDeps,
} from '@/lib/hosting/serverlessDeployCheck';
import { getDatabasePort } from '@/lib/orchestrator/database';
import { getHostingDeployPort, hostingOriginSecretKey } from '@/lib/orchestrator/hosting';
import { selectedOrchestratorProvider } from '@/lib/orchestrator/provider';
import {
  serverlessHostingConfig,
  signFunctionUrlRequest,
  type FakeHostingControls,
} from '@motir/orchestrator';

const TAG = '[hosting-deploy-check]';

const serverlessPort = () =>
  getHostingDeployPort('serverless', { appPrefix: SERVERLESS_DEPLOY_CHECK_APP_PREFIX });

/** The serverless account's registry host, from the adapter's own config. */
function serverlessRegistry(): string {
  const { accountId, region } = serverlessHostingConfig();
  return `${accountId}.dkr.ecr.${region}.amazonaws.com`;
}

/** Build the fixture with its label baked in, push it, and read the digest the
 *  registry gave it back from buildx's metadata. Lambda takes a single-platform
 *  image with no attestation manifest, hence `--provenance=false`. */
async function buildAndPushImage(input: {
  pushNamespace: string;
  label: string;
}): Promise<{ ref: string; digest: string }> {
  const { region } = serverlessHostingConfig();
  const registry = serverlessRegistry();
  const password = execFileSync('aws', ['ecr', 'get-login-password', '--region', region], {
    encoding: 'utf8',
  });
  execFileSync('docker', ['login', '--username', 'AWS', '--password-stdin', registry], {
    input: password,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const ref = `${registry}/${input.pushNamespace}`;
  const metadata = join(mkdtempSync(join(tmpdir(), 'deploy-check-')), 'metadata.json');
  execFileSync(
    'docker',
    [
      'buildx',
      'build',
      '--platform',
      'linux/amd64',
      '--provenance=false',
      '--build-arg',
      `RELEASE_LABEL=${input.label}`,
      '--tag',
      `${ref}:${input.label}`,
      '--metadata-file',
      metadata,
      '--push',
      SERVERLESS_DEPLOY_CHECK_IMAGE_CONTEXT,
    ],
    { stdio: 'inherit' },
  );
  const digest = (JSON.parse(readFileSync(metadata, 'utf8')) as Record<string, unknown>)[
    'containerimage.digest'
  ];
  if (typeof digest !== 'string') throw new Error('buildx reported no image digest');
  return { ref, digest };
}

function serverlessDeps(): ServerlessDeployCheckDeps {
  if (selectedOrchestratorProvider() === 'fake') {
    return {
      port: serverlessPort,
      databasePort: () => getDatabasePort(),
      signedFetch: fakeFunctionUrlFetch(
        serverlessPort() as unknown as FakeHostingControls,
        getDatabasePort,
      ).signed,
      buildAndPushImage: fakeImageBuilder(FAKE_SERVERLESS_REGISTRY),
      registry: () => FAKE_SERVERLESS_REGISTRY,
    };
  }
  return {
    port: serverlessPort,
    databasePort: () => getDatabasePort(),
    signedFetch: async (url, init) => {
      const signed = await signFunctionUrlRequest(url, init);
      return fetch(url, { method: signed.method, headers: signed.headers, redirect: 'manual' });
    },
    buildAndPushImage,
    registry: serverlessRegistry,
  };
}

async function main(): Promise<number> {
  return runDeployCheck(process.argv.slice(2), {
    port: () => getHostingDeployPort('fly', { appPrefix: DEPLOY_CHECK_APP_PREFIX }),
    readManifest: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    print: (label, fields) => {
      console.log(`${TAG} ${label}`);
      for (const [key, value] of Object.entries(fields)) console.log(`  ${key}: ${String(value)}`);
    },
    fetch:
      selectedOrchestratorProvider() === 'fake'
        ? fakeGuardedFetch(hostingOriginSecretKey())
        : (url, init) => fetch(url, { ...init, redirect: 'manual' }),
    originSecretKey: hostingOriginSecretKey,
    serverless: serverlessDeps(),
  });
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(TAG, err);
    process.exit(1);
  },
);
