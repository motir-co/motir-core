/**
 * The data-script ENTRY (MOTIR-10465) — what `pnpm db:backfill:boards`,
 * `pnpm db:backfill:ci-state`, `pnpm db:backfill:fix-reason`,
 * `pnpm db:backfill:author-finished` and `pnpm db:converge:unlanded-cards` run
 * from a checkout, and what the bundle `node /app/data/data-script.mjs <script>
 * [flags]` runs inside a task of the core image.
 * docs/runbooks/production-data-scripts.md is how to run one against production.
 *
 * WHY IT EXISTS. After the AWS cutover, production's database admits only core's
 * service security group, so a GitHub runner cannot reach it, and the image
 * carried no `scripts/`. The data scripts now ship in the image the way
 * `fleet-admin` and the deploy check do — one esbuilt file — and run in a core
 * worker task over ECS Exec, as the core database's APPLICATION role.
 *
 * It exists for the ordering `fleet-admin`'s entry exists for (MOTIR-10264): a
 * Fargate task holds the database LOGIN PARTS (`MOTIR_DB_*`), not `DATABASE_URL`,
 * and `@/lib/db` reads the URL when it is evaluated. So this module imports
 * nothing that reaches the database client: it composes the URL first, exactly as
 * the services do (`composeDatabaseUrl`, `sslmode=verify-full`), and only then
 * loads the named script with a dynamic `import()`, which esbuild keeps lazy
 * inside the one-file bundle.
 *
 * When the URL was composed from the parts — the Fargate path, run over `aws ecs
 * execute-command`, which does not hand the remote exit code back — it prints
 * `data-script exit <code>` as the LAST line, so a failed sweep does not read as
 * success. From a checkout (`DATABASE_URL` set, from the shell or `.env`) the
 * output and the exit code are what the scripts printed before.
 *
 * ⚠️ NOTHING IT PRINTS CARRIES THE URL OR THE PASSWORD: on the Fargate path every
 * write to stdout and stderr — a script's report, an error a dependency prints —
 * passes through `redactor`.
 */
import { pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';
// Never `./hosting-deploy-check-main` or `./fleet/fleetAdminMain`: in a one-file
// bundle their entry guards are true too.
import {
  composeDatabaseUrl,
  redactor,
  redactStream,
  type DatabaseEnv,
  type EntryStream,
} from './fleet/fleetAdminDatabaseUrl';

// A checkout's `.env` supplies DATABASE_URL, as `scripts/_loadEnv.ts` did for each
// script. Before anything loads the database client: the imports above reach none.
// Quiet, so a task's log carries the script's report and not dotenv's banner.
loadEnv({ quiet: true });

const EXIT_ERROR = 1;
const TAG = '[data-script]';

/** One data script: runs on its arguments and answers the process exit code. */
export interface DataScript {
  main(argv: readonly string[]): Promise<number>;
}

/**
 * The scripts the entry runs, by the name an operator types. Each is a
 * `workflow_dispatch` data script that changes production rows; adding one here
 * is what ships it in the image. A loader, so nothing evaluates the database
 * client before the URL is composed.
 */
export const DATA_SCRIPTS = {
  'backfill-boards': () => import('./backfill-default-boards'),
  'backfill-ci-state': () => import('./backfill-work-item-ci-state'),
  'backfill-fix-reason': () => import('./backfill-fix-reason'),
  'backfill-author-finished': () => import('./backfill-plan-author-finished'),
  'converge-unlanded-cards': () => import('./converge-ejected-cards'),
} satisfies Record<string, () => Promise<DataScript>>;

export type DataScriptName = keyof typeof DATA_SCRIPTS;

export const isDataScriptName = (name: string | undefined): name is DataScriptName =>
  name !== undefined && Object.hasOwn(DATA_SCRIPTS, name);

/** What the entry needs to run one script, behind a seam so a test can stand in. */
export interface LoadedDataScript {
  main(argv: readonly string[]): Promise<number>;
  /** Ends the database pool, so the process can exit once the script answers. */
  disconnect(): Promise<void>;
}

export type LoadDataScript = (name: DataScriptName) => Promise<LoadedDataScript>;

/** Loads the named script — and with it the database client — after the URL is set. */
export const loadDataScript: LoadDataScript = async (name) => {
  const script: DataScript = await DATA_SCRIPTS[name]();
  return {
    main: (argv) => script.main(argv),
    disconnect: async () => {
      const { db } = await import('@/lib/db');
      await db.$disconnect();
    },
  };
};

/** The last line on the Fargate path; the code is what the script answered. */
export const dataScriptExitLine = (code: number): string => `data-script exit ${code}`;

/** The usage block, printed for a missing or unknown script name. */
export const dataScriptUsage = (): string =>
  ['usage: data-script <script> [flags]', `scripts: ${Object.keys(DATA_SCRIPTS).join(', ')}`].join(
    '\n',
  );

type Streams = { stdout: EntryStream; stderr: EntryStream };

/** Composes the URL; answers whether it came from the parts, or the error to print. */
function composeFor(env: DatabaseEnv, streams: Streams): { composed: boolean } | { error: string } {
  try {
    const url = composeDatabaseUrl(env);
    if (url.source !== 'parts') return { composed: false };
    const redact = redactor(url.secrets);
    redactStream(streams.stdout, redact);
    redactStream(streams.stderr, redact);
    return { composed: true };
  } catch (err) {
    // Only some parts are set: the Fargate path with a broken task. The message
    // names variables only (`DatabasePartsIncompleteError`).
    return { error: (err as Error).message };
  }
}

/** Loads and runs one script; a throw (a bad flag, a refused load) answers 1. */
async function runScript(
  name: DataScriptName,
  argv: readonly string[],
  stderr: EntryStream,
  load: LoadDataScript,
): Promise<number> {
  let script: LoadedDataScript | null = null;
  let code: number;
  try {
    script = await load(name);
    code = await script.main(argv);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    stderr.write(`${TAG} ${name} failed: ${detail}\n`);
    code = EXIT_ERROR;
  }
  // The script has answered; a pool that will not close changes nothing.
  await script?.disconnect().catch(() => undefined);
  return code;
}

/**
 * Runs one data script as the process entry: `argv[0]` names the script and the
 * rest are its flags. Composes `DATABASE_URL` when only the login parts are set
 * (and then redacts both streams), loads and runs the script, ends the pool, and
 * answers the exit code the process should end with.
 */
export async function runDataScriptEntry(
  argv: readonly string[],
  env: DatabaseEnv,
  streams: Streams,
  load: LoadDataScript = loadDataScript,
): Promise<number> {
  const composed = composeFor(env, streams);
  if ('error' in composed) {
    streams.stderr.write(`${TAG} error: ${composed.error}\n`);
    streams.stdout.write(`${dataScriptExitLine(EXIT_ERROR)}\n`);
    return EXIT_ERROR;
  }

  const [name, ...flags] = argv;
  let code: number;
  if (isDataScriptName(name)) {
    code = await runScript(name, flags, streams.stderr, load);
  } else {
    const what = name === undefined ? 'no script named' : `unknown script "${name}"`;
    streams.stderr.write(`${TAG} ${what}\n${dataScriptUsage()}\n`);
    code = EXIT_ERROR;
  }
  if (composed.composed) streams.stdout.write(`${dataScriptExitLine(code)}\n`);
  return code;
}

/* v8 ignore start -- the process entry: the real streams and the exit code over
   `runDataScriptEntry`, run as the bundle by dataScriptBundle.test.ts's child
   processes, which v8 coverage does not follow. */
const isEntry =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  void runDataScriptEntry(process.argv.slice(2), process.env, {
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((code) => process.exit(code));
}
/* v8 ignore stop */
