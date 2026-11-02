/**
 * The `fleet-admin` bundle's ENTRY (MOTIR-10264) — what `node fleet/fleet-admin.mjs`
 * runs, on a Fly machine and in a Fargate task of the core image alike. The
 * commands themselves, and how to run them, are in `fleetAdmin.ts`.
 *
 * It exists for ONE ordering: `@/lib/db` reads `DATABASE_URL` when it is
 * evaluated, and in a Fargate task the variable is not there — only the login
 * parts are (`fleetAdminDatabaseUrl.ts`). So this module imports nothing that
 * reaches the database client: it composes the URL first, and only then loads
 * `fleetAdmin.ts` with a dynamic `import()`, which esbuild keeps lazy inside
 * the one-file bundle.
 *
 * When the URL was composed from the parts — the Fargate path — it also prints
 * `fleet-admin exit <code>` as the LAST line, because `aws ecs execute-command`
 * does not hand the remote command's exit code back to the caller: without the
 * line, a refusal (1) or a pending step (2) would read as success. On Fly,
 * where `DATABASE_URL` is set, the output and the exit code are what they were.
 *
 * ⚠️ NOTHING IT PRINTS CARRIES THE URL OR THE PASSWORD: every line passes
 * through `redactor`, which removes the composed URL and the password (raw and
 * percent-encoded) before `scrubSecrets` removes any other credential shape.
 */
import { pathToFileURL } from 'node:url';
import { scrubSecrets } from '@/lib/fleetShards/scrubSecrets';
import {
  composeDatabaseUrl,
  DatabasePartsIncompleteError,
  type DatabaseEnv,
} from './fleetAdminDatabaseUrl';
import type { FleetAdminIo } from './fleetAdmin';

const EXIT_ERROR = 1;
const REDACTED = '[redacted]';

/** The last line on the Fargate path; the code is what the command answered. */
export const exitLine = (code: number): string => `fleet-admin exit ${code}`;

/** What the entry needs of `fleetAdmin.ts`, behind a seam so a test can stand in. */
export interface FleetAdminCommands {
  runFleetAdmin(argv: string[], io: FleetAdminIo): Promise<number>;
  /** Ends the database pool, so the process can exit once the command answers; a
   *  failure here is ignored, since the command has already answered. */
  disconnect(): Promise<void>;
}

/** Loads the commands — and with them the database client — after the URL is set. */
export async function loadFleetAdmin(): Promise<FleetAdminCommands> {
  const { runFleetAdmin } = await import('./fleetAdmin');
  return {
    runFleetAdmin,
    disconnect: async () => {
      const { db } = await import('@/lib/db');
      await db.$disconnect();
    },
  };
}

/** `text` with each of `secrets` (longest first) and every credential shape removed. */
export function redactor(secrets: readonly string[]): (text: string) => string {
  const ordered = [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length);
  return (text) => scrubSecrets(ordered.reduce((out, s) => out.split(s).join(REDACTED), text));
}

/**
 * Runs one `fleet-admin` command as the bundle's entry: composes `DATABASE_URL`
 * when only the login parts are set, loads and runs the command, ends the pool,
 * and answers the exit code the process should end with.
 */
export async function runFleetAdminEntry(
  argv: string[],
  env: DatabaseEnv,
  rawIo: FleetAdminIo,
  load: () => Promise<FleetAdminCommands> = loadFleetAdmin,
): Promise<number> {
  let secrets: readonly string[] = [];
  let composed: boolean;
  try {
    const url = composeDatabaseUrl(env);
    composed = url.source === 'parts';
    if (url.source === 'parts') secrets = url.secrets;
  } catch (err) {
    // Only some parts are set: this IS the Fargate path, with a broken task.
    // `composeDatabaseUrl` throws nothing else, and its message names variables only.
    rawIo.err(`error: ${(err as DatabasePartsIncompleteError).message}`);
    rawIo.out(exitLine(EXIT_ERROR));
    return EXIT_ERROR;
  }

  const redact = redactor(secrets);
  const io: FleetAdminIo = {
    out: (line) => rawIo.out(redact(line)),
    err: (line) => rawIo.err(redact(line)),
  };

  let code: number;
  let commands: FleetAdminCommands | null = null;
  try {
    commands = await load();
    code = await commands.runFleetAdmin(argv, io);
  } catch (err) {
    // A module that refused to load (a missing variable) — `runFleetAdmin`
    // catches everything a command throws, so this is the load.
    io.err(`error: ${err instanceof Error ? err.message : 'unknown'}`);
    code = EXIT_ERROR;
  }
  await commands?.disconnect().catch(() => undefined);
  if (composed) io.out(exitLine(code));
  return code;
}

/* v8 ignore start -- the process entry: stdio and the exit code over
   `runFleetAdminEntry`, run as the bundle by fleetAdminFargateEntry.test.ts's child
   processes, which v8 coverage does not follow. */
const isEntry =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  const io: FleetAdminIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  void runFleetAdminEntry(process.argv.slice(2), process.env, io).then((code) =>
    process.exit(code),
  );
}
/* v8 ignore stop */
