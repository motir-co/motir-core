/**
 * The operator deploy check's process ENTRY (MOTIR-10301) — what `pnpm
 * hosting:deploy-check` and the bundle `node hosting/deploy-check.mjs` both run,
 * from a shell, on a Fly machine and in a Fargate task of the core image alike.
 * The check itself, and its steps, are in `hosting-deploy-check.ts`;
 * docs/hosting/aws-deploy-check.md is how to run it inside AWS.
 *
 * It exists for the ordering `fleet-admin`'s entry exists for (MOTIR-10264): the
 * check's database reads (`converge`, and every AWS step through the adapter's
 * lookups) need `DATABASE_URL`, and a Fargate task holds only the login parts
 * (`MOTIR_DB_*`), from which each service composes the URL inside its own
 * process. So this module imports nothing that reaches the database client: it
 * composes the URL first, exactly as the services do (`composeDatabaseUrl`,
 * `sslmode=verify-full`), and only then loads the check with a dynamic
 * `import()`, which esbuild keeps lazy inside the one-file bundle.
 *
 * When the URL was composed from the parts — the Fargate path, run over `aws ecs
 * execute-command`, which does not hand the remote exit code back — it also
 * prints `deploy-check exit <code>` as the LAST line, so a refusal does not read
 * as success. With `DATABASE_URL` set, or with neither it nor the parts (a laptop
 * on the Fly target, the fake), the output and the exit code are what they were.
 *
 * ⚠️ NOTHING IT PRINTS CARRIES THE URL OR THE PASSWORD: on the Fargate path every
 * write to stdout and stderr — the check's blocks, the adapter's log lines, an
 * error a dependency prints — passes through `redactor`, which removes the
 * composed URL and the password (raw and percent-encoded) and every other
 * credential shape `scrubSecrets` knows.
 */
import { pathToFileURL } from 'node:url';
// Never `./fleet/fleetAdminMain`: in a one-file bundle its entry guard is true too.
import {
  composeDatabaseUrl,
  redactor,
  redactStream,
  type DatabaseEnv,
  type EntryStream,
} from './fleet/fleetAdminDatabaseUrl';

// Moved beside `redactor` (MOTIR-10465) so the data-script entry shares them without
// importing this module, whose entry guard would run the check inside its bundle.
export { redactStream, type EntryStream };

const EXIT_ERROR = 1;
const TAG = '[hosting-deploy-check]';

/** The last line on the Fargate path; the code is what the check answered. */
export const deployCheckExitLine = (code: number): string => `deploy-check exit ${code}`;

/** Runs one deploy-check command line; answers the process exit code. */
export type LoadDeployCheck = () => Promise<(argv: readonly string[]) => Promise<number>>;

/** Loads the check — and with it, lazily, the database client — after the URL is set. */
export const loadDeployCheck: LoadDeployCheck = async () =>
  (await import('./hosting-deploy-check')).runHostingDeployCheck;

/**
 * Runs the deploy check as the process entry: composes `DATABASE_URL` when only
 * the login parts are set (and then redacts both streams), loads and runs the
 * check, and answers the exit code the process should end with.
 */
export async function runDeployCheckEntry(
  argv: readonly string[],
  env: DatabaseEnv,
  streams: { stdout: EntryStream; stderr: EntryStream },
  load: LoadDeployCheck = loadDeployCheck,
): Promise<number> {
  let composed = false;
  try {
    const url = composeDatabaseUrl(env);
    if (url.source === 'parts') {
      composed = true;
      const redact = redactor(url.secrets);
      redactStream(streams.stdout, redact);
      redactStream(streams.stderr, redact);
    }
  } catch (err) {
    // Only some parts are set: this IS the Fargate path, with a broken task.
    // `composeDatabaseUrl` throws nothing else, and its message names variables only.
    streams.stderr.write(`${TAG} error: ${(err as Error).message}\n`);
    streams.stdout.write(`${deployCheckExitLine(EXIT_ERROR)}\n`);
    return EXIT_ERROR;
  }

  let code: number;
  try {
    const run = await load();
    code = await run(argv);
  } catch (err) {
    // `runDeployCheck` prints every refusal a step throws as a block and answers
    // 1, so this is a module that refused to load or a throw that escaped it.
    streams.stderr.write(`${TAG} error: ${err instanceof Error ? err.message : 'unknown'}\n`);
    code = EXIT_ERROR;
  }
  if (composed) streams.stdout.write(`${deployCheckExitLine(code)}\n`);
  return code;
}

/* v8 ignore start -- the process entry: the real streams and the exit code over
   `runDeployCheckEntry`, run as the bundle by deployCheckFargateEntry.test.ts's
   child processes, which v8 coverage does not follow. */
const isEntry =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  void runDeployCheckEntry(process.argv.slice(2), process.env, {
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((code) => process.exit(code));
}
/* v8 ignore stop */
