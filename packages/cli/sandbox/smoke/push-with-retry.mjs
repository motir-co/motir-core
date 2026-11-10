#!/usr/bin/env node
//
// PUSH AN IMAGE THAT IS ALREADY BUILT, AND RETRY ONLY WHAT THE REGISTRY REFUSED (MOTIR-10884)
//
// `cli-v0.17.2` (run 42705348239) built and smoke-tested all nine images, then
// six of the eight profile pushes came back
//
//   ERROR: failed to build: failed to solve: failed to push
//   ghcr.io/motir-co/motir-sandbox:claude: denied: permission_denied: write_package
//
// from the same token that, a few minutes later, pushed `goose` and
// `antigravity` to the same package. The refusal was intermittent, each leg
// pushed exactly once, and the release ended half-published: new agents of
// `claude`, `codex` and `opencode` kept getting 0.17.1.
//
// So the release lane now BUILDS the two-platform image in one step and PUSHES
// it in a second, and this script is the second step. It runs the push command
// it is handed (a `docker buildx build --push` that the builder's local cache
// answers entirely, so nothing is rebuilt) and, when it fails, decides from the
// command's own last `ERROR:` line whether the failure is the registry's:
//
//   * a registry refusal — `denied`, `unauthorized`, a 5xx, a 429, a timeout, a
//     reset connection — is retried with exponential backoff, up to `--attempts`;
//   * anything else, and above all a BUILD failure (`did not complete
//     successfully`, a missing file, a Dockerfile that does not parse), fails at
//     once. A build that failed will fail again, and retrying it would only hide
//     a real defect behind a slower red.
//
// An output with no recognisable registry refusal is NOT retried either. A wrong
// give-up costs one re-run of the failed job, which then skips every profile
// already published (`release-set.mjs plan`); a wrong retry costs the same
// minutes again and reports the real cause later.
//
// On success it reads the push's `--metadata-file` and writes `digest=<sha256>`
// to `$GITHUB_OUTPUT`, the output the "Record the published digest" step reads.
//
// Usage:
//   push-with-retry.mjs [--attempts 3] [--base-delay-ms 30000] [--label <name>]
//                       --metadata-file <path> [--github-output <path>]
//                       -- <push command…>
//
// Zero dependencies, like its neighbours: it runs on a bare release runner.

/** How many pushes, in all, before a registry refusal is final. */
export const DEFAULT_ATTEMPTS = 3;

/** The first backoff. Doubles each attempt: 30 s, then 60 s. GHCR's refusals
 *  in run 42705348239 were minutes apart across legs, so a sub-second retry
 *  would only ask the same question of the same hiccup. */
export const DEFAULT_BASE_DELAY_MS = 30_000;

/** How much of the command's output is kept to classify. The verdict is on the
 *  LAST `ERROR:` line, so only the tail matters; a two-platform push prints
 *  thousands of `writing layer` lines before it. */
const TAIL_BYTES = 64 * 1024;

/**
 * Signatures of a failure IN THE BUILD. Checked FIRST: a build failure is never
 * retried, even when its text also happens to say `timeout` (a `RUN curl` that
 * timed out is a build failure, not a registry one).
 */
const BUILD_FAILURE = [
  /did not complete successfully/i,
  /failed to compute cache key/i,
  /dockerfile parse error/i,
  /failed to read dockerfile/i,
];

/**
 * Signatures of a REGISTRY refusal or a transport failure on the way to it —
 * the class worth asking again. `failed to push` is the line buildx prints for
 * every push the registry refused; the rest are what a refused or broken
 * request says in its place.
 */
const REGISTRY_REFUSAL = [
  /failed to push/i,
  /\bdenied\b/i,
  /\bunauthorized\b/i,
  /toomanyrequests|too many requests|\b429\b/i,
  /\b5\d\d\b(?:\s|:|$)/,
  /unexpected status/i,
  /failed to do request/i,
  /timeout|timed out|deadline exceeded/i,
  /connection reset|connection refused|broken pipe|\bEOF\b/i,
];

/** The last line carrying `ERROR:` — buildx's verdict line — or null. */
export function lastErrorLine(output) {
  const lines = String(output ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/\bERROR:/.test(lines[i])) return lines[i].trim();
  }
  return null;
}

/**
 * Should this failed push be retried?
 *
 * Returns `{ retry, reason, line }`. `line` is the ERROR line the verdict was
 * read from, so the annotation can quote the registry rather than paraphrase it.
 */
export function classifyPushFailure(output) {
  const line = lastErrorLine(output);
  if (!line) {
    return {
      retry: false,
      reason: 'the command printed no ERROR line, so there is no registry refusal to retry',
      line: null,
    };
  }
  if (BUILD_FAILURE.some((pattern) => pattern.test(line))) {
    return { retry: false, reason: 'the BUILD failed, and a build failure is never retried', line };
  }
  if (REGISTRY_REFUSAL.some((pattern) => pattern.test(line))) {
    return { retry: true, reason: 'the registry refused the push', line };
  }
  return { retry: false, reason: 'not a recognised registry refusal', line };
}

/** The wait before attempt `attempt + 1`: base, then double it each time. */
export function backoffMs(attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS) {
  return baseDelayMs * 2 ** (attempt - 1);
}

/**
 * Run the push until it succeeds, a failure is final, or the attempts run out.
 *
 * `run()` resolves `{ code, output }`; `sleep(ms)` waits. Both are injected so
 * the decision is tested without a registry or a clock. Returns
 * `{ ok, attempts, failures }`, `failures` holding each failed attempt's
 * classification in order.
 */
export async function pushWithRetry({
  run,
  sleep,
  attempts = DEFAULT_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  label = 'image',
  log = () => {},
}) {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { code, output } = await run(attempt);
    if (code === 0) {
      if (attempt > 1) {
        log(
          `::notice::Pushed ${label} on attempt ${attempt} of ${attempts}, after ` +
            `${failures.length} registry refusal${failures.length === 1 ? '' : 's'}.`,
        );
      }
      return { ok: true, attempts: attempt, failures };
    }
    const verdict = classifyPushFailure(output);
    failures.push({ attempt, code, ...verdict });
    if (!verdict.retry) {
      log(
        `::error::Push of ${label} failed on attempt ${attempt} and is not retried — ` +
          `${verdict.reason}${verdict.line ? `: ${verdict.line}` : ''}`,
      );
      return { ok: false, attempts: attempt, failures };
    }
    if (attempt === attempts) {
      log(
        `::error::Push of ${label} was refused on all ${attempts} attempts — last: ${verdict.line}`,
      );
      return { ok: false, attempts: attempt, failures };
    }
    const wait = backoffMs(attempt, baseDelayMs);
    log(
      `::warning::Push of ${label} refused on attempt ${attempt} of ${attempts} ` +
        `(${verdict.line}) — retrying in ${Math.round(wait / 1000)} s.`,
    );
    await sleep(wait);
  }
  // Unreachable for attempts >= 1; a zero or negative count pushes nothing.
  return { ok: false, attempts: 0, failures };
}

/** The image digest buildx recorded in its `--metadata-file`. */
export function readDigest(metadataJson) {
  let metadata;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    throw new Error('the push metadata file is not JSON');
  }
  const digest = metadata?.['containerimage.digest'];
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`the push metadata names no sha256 image digest (got '${digest ?? ''}')`);
  }
  return digest;
}

/** Split `argv` at `--` into the script's own flags and the command it runs. */
export function parseArgs(argv) {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const arg = (name) => {
    const i = own.indexOf(`--${name}`);
    return i === -1 ? undefined : own[i + 1];
  };
  const number = (name, fallback) => {
    const raw = arg(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < (name === 'attempts' ? 1 : 0)) {
      throw new Error(`--${name} must be a whole number, got '${raw}'`);
    }
    return value;
  };
  if (command.length === 0) {
    throw new Error('usage: push-with-retry.mjs --metadata-file <path> [options] -- <command…>');
  }
  const metadataFile = arg('metadata-file');
  if (!metadataFile) throw new Error('--metadata-file is required: it is where the digest is read');
  return {
    command,
    metadataFile,
    githubOutput: arg('github-output'),
    label: arg('label') ?? 'image',
    attempts: number('attempts', DEFAULT_ATTEMPTS),
    baseDelayMs: number('base-delay-ms', DEFAULT_BASE_DELAY_MS),
  };
}

/** The CLI: 0 pushed (and the digest written), 1 the push failed for good. */
export async function main(argv, io) {
  const options = parseArgs(argv);
  const result = await pushWithRetry({
    run: () => io.run(options.command),
    sleep: io.sleep,
    attempts: options.attempts,
    baseDelayMs: options.baseDelayMs,
    label: options.label,
    log: io.log,
  });
  if (!result.ok) return 1;

  const digest = readDigest(await io.readFile(options.metadataFile));
  io.log(`${options.label} pushed as ${digest}`);
  if (options.githubOutput) await io.appendFile(options.githubOutput, `digest=${digest}\n`);
  return 0;
}

/**
 * Run a command with its output passed straight through to this process, while
 * keeping the tail to classify. `stdin` is inherited; nothing is buffered whole.
 */
export function nodeRun(spawn, stdout, stderr) {
  return (command) =>
    new Promise((resolve) => {
      let tail = '';
      const keep = (chunk) => {
        tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
      };
      const child = spawn(command[0], command.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => {
        stdout.write(chunk);
        keep(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr.write(chunk);
        keep(chunk);
      });
      // A command that cannot even start (not on PATH) is not a registry
      // refusal: report it as a failure with no ERROR line, which is final.
      child.on('error', (err) => resolve({ code: 127, output: `${tail}\n${err.message}` }));
      child.on('close', (code) => resolve({ code: code ?? 1, output: tail }));
    });
}

// Only when executed, never when imported by the unit tests. The block runs in
// a child process, which the coverage run does not measure, so it is driven as a
// real process by the script's own suite instead.
/* v8 ignore start */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { spawn } = await import('node:child_process');
  const { readFile, appendFile } = await import('node:fs/promises');
  const io = {
    run: nodeRun(spawn, process.stdout, process.stderr),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readFile: (path) => readFile(path, 'utf8'),
    appendFile: (path, text) => appendFile(path, text),
    // Annotations go to stdout, where the runner reads workflow commands.
    log: (line) => process.stdout.write(`${line}\n`),
  };
  main(process.argv.slice(2), io).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
/* v8 ignore stop */
