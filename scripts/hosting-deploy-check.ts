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
 * `--target aws --repository <id>` (MOTIR-10011) drives the AWS adapter on the
 * tenant app `mh-<id>` instead, with `--shape <function|container>` and these
 * steps besides (docs/hosting/aws-deploy-check.md is the operator's run order):
 *   converge  bring `--organization`'s tenant deploy role onto today's policy
 *   push      build the fixture app as release 1 and 2 and push both to
 *             mh/<id>/production under `--aws-profile`
 *   page      GET the serving release's /health and /row with its origin
 *             credential (SigV4 for a function, the origin secret for a
 *             container); release2 and rollback run it too
 *   no-shape  deploy with no shape, which the port must refuse, and list the
 *             app's releases, which must be none
 *   all       converge, push, deploy, page, release2, rollback, destroy
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
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createSigV4Fetch } from '@motir/orchestrator';
import {
  DEPLOY_CHECK_APP_PREFIX,
  DEPLOY_CHECK_AWS_REGION,
  fakeGuardedFetch,
  runDeployCheck,
  type DeployCheckDeps,
} from '@/lib/hosting/deployCheck';
import { getHostingDeployPort, hostingOriginSecretKey } from '@/lib/orchestrator/hosting';
import { selectedOrchestratorProvider } from '@/lib/orchestrator/provider';

const TAG = '[hosting-deploy-check]';

/** Runs a command with its stderr on the operator's terminal and its stdout
 *  captured; `stdin` is written to the pipe, never put in an argument. A
 *  failure names the command and its exit code only. */
const exec: NonNullable<DeployCheckDeps['exec']> = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => reject(new Error(`${command} ${args[0] ?? ''} could not start`)));
    child.on('close', (code) =>
      code === 0
        ? resolve({ stdout })
        : reject(new Error(`${command} ${args[0] ?? ''} exited ${String(code)}`)),
    );
    child.stdin.end(options.stdin ?? '');
  });

/** The deploy-role convergence `fleet-admin hosting-tenant
 *  converge-deploy-policy --organization` runs; it reads the tenant account row,
 *  so a live run needs DATABASE_URL. */
async function converge(organizationId: string): Promise<string> {
  const { hostingTenantAccountService } =
    await import('@/lib/services/hostingTenantAccountService');
  return (await hostingTenantAccountService.convergeDeployPolicy(organizationId)).outcome;
}

const signedFetch = createSigV4Fetch({ region: DEPLOY_CHECK_AWS_REGION });

async function main(): Promise<number> {
  return runDeployCheck(process.argv.slice(2), {
    port: (target) =>
      target === 'aws'
        ? getHostingDeployPort('aws')
        : getHostingDeployPort('fly', { appPrefix: DEPLOY_CHECK_APP_PREFIX }),
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
    exec,
    converge,
    signedFetch: (url) => signedFetch(url),
  });
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(TAG, err);
    process.exit(1);
  },
);
