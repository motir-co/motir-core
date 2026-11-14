/**
 * `pnpm deploy:static <command>` (MOTIR-11241) — the AWS deploy's half of "a tab
 * left open across a deploy keeps working": every release's `/_next/static` is
 * served from the durable origin motir-infra's MOTIR-11240 built
 * (`https://static.motir.co`, a bucket whose lifecycle rule — never a deploy —
 * expires old files), and the deploy proves it after the roll.
 *
 *   target            read `/<prefix>/core/static-assets` → `url`, `bucket` (or
 *                     both empty: the image is then built with no prefix)
 *   capture-previous  before the roll: one `/_next/static` file the LIVE release
 *                     serves from the origin → `previous` (empty when the live
 *                     release predates the origin)
 *   verify-upload     after the upload, before the roll: one of this build's
 *                     files answers 200 from the origin, with CORS for the app
 *                     and an immutable cache header — so a missing CNAME fails
 *                     the job before any task rolls
 *   verify-release    after the roll: the app's HTML references this build's
 *                     files on the origin, and the previous release's file
 *                     still answers 200
 *
 * The upload itself is `aws s3 cp` in `aws-deploy.yml` (no `--delete`, ever).
 *
 * ⚠️ WHY `target` ANSWERS EMPTY RATHER THAN FAILING. The parameter exists only
 * once motir-infra's `<prefix>-core-static` stack has deployed, which waits on a
 * person laying `static.motir.co`'s certificate validation record. Until then the
 * release must still go out — exactly as it did before this card — so a missing
 * parameter, a role not granted it, or an origin whose name does not resolve yet
 * builds an unprefixed image with a warning, and every later step stands down.
 * Once the origin answers, the next release switches over on its own, and from
 * then on every check below is strict.
 *
 * It reads `AWS_REGION`, `AWS_DEPLOY_NAME_PREFIX`, `MOTIR_APP_URL` (default
 * `https://app.motir.co`) and `GITHUB_OUTPUT`. Exit codes: 0 on success, 1 on a
 * failed check or a usage error.
 */
import { appendFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { awsSdkPorts, type ParameterRead } from './ports';

export const DEFAULT_APP_URL = 'https://app.motir.co';
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

export interface StaticTarget {
  bucket: string;
  url: string;
}

/** What the commands touch, so every branch is testable without AWS or a network. */
export interface StaticPorts {
  readParameter(name: string): Promise<ParameterRead>;
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
  listFiles(dir: string): string[];
  sleep(ms: number): Promise<void>;
}

export interface StaticIo {
  /** A `key=value` line for `$GITHUB_OUTPUT`. */
  output(key: string, value: string): void;
  log(line: string): void;
}

export interface Retry {
  attempts: number;
  delayMs: number;
}

export const staticAssetsParameterName = (namePrefix: string): string =>
  `/${namePrefix}/core/static-assets`;

/** `{ "bucket", "url", "region" }` as motir-infra writes it; throws on anything else. */
export function parseTarget(raw: string): StaticTarget {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('the static-assets parameter is not JSON');
  }
  const { bucket, url } = (value ?? {}) as Record<string, unknown>;
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('the static-assets parameter has no valid "bucket"');
  }
  if (typeof url !== 'string' || !/^https:\/\/[^/\s?#]+$/.test(url.replace(/\/+$/, ''))) {
    throw new Error('the static-assets parameter has no https "url" origin');
  }
  return { bucket, url: url.replace(/\/+$/, '') };
}

async function tryFetch(
  ports: StaticPorts,
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
): Promise<Awaited<ReturnType<StaticPorts['fetch']>> | undefined> {
  try {
    return await ports.fetch(url, init);
  } catch {
    return undefined;
  }
}

/** Whether the origin answers HTTPS at all — any status counts; a DNS or TLS failure does not. */
export async function originReachable(
  ports: StaticPorts,
  url: string,
  retry: Retry,
): Promise<boolean> {
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    if (await tryFetch(ports, `${url}/_next/static/`, { method: 'HEAD' })) return true;
    if (attempt < retry.attempts) await ports.sleep(retry.delayMs);
  }
  return false;
}

/** The deploy target, or why there is none (the release then ships unprefixed). */
export async function resolveTarget(
  ports: StaticPorts,
  namePrefix: string,
  retry: Retry,
): Promise<{ target: StaticTarget } | { skip: string }> {
  const name = staticAssetsParameterName(namePrefix);
  const read = await ports.readParameter(name);
  if (read.state === 'not_granted') {
    return { skip: `the deploy role may not read ${name} (motir-infra's staticAssets is off)` };
  }
  if (read.value === undefined) {
    return { skip: `${name} does not exist yet (motir-infra's core-static stack is not deployed)` };
  }
  const target = parseTarget(read.value);
  if (!(await originReachable(ports, target.url, retry))) {
    return {
      skip: `${target.url} does not answer yet — is its CNAME at the DNS (motir-infra docs/static-assets.md, step 2)?`,
    };
  }
  return { target };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every `/_next/static/<path>` an HTML page names under `base` (an origin, or
 * `''` for the app's own), as paths relative to `_next/static/`, de-duplicated.
 */
export function staticRefs(html: string, base: string): string[] {
  const lead = base ? escapeRegExp(base) : '(?<![\\w.:/-])';
  const pattern = new RegExp(`${lead}/_next/static/([^"'\\s?#)\\\\<>]+)`, 'g');
  return [...new Set([...html.matchAll(pattern)].map((m) => m[1]!))];
}

/** Every file under `dir`, relative to it, with `/` separators, sorted. */
export function listStaticFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

/** The file `verify-upload` asks for: the first JavaScript chunk, else the first file. */
export function pickProbeFile(files: readonly string[]): string | undefined {
  return files.find((f) => f.startsWith('chunks/') && f.endsWith('.js')) ?? files[0];
}

async function readHtml(ports: StaticPorts, appUrl: string): Promise<string | undefined> {
  const res = await tryFetch(ports, appUrl, { headers: { 'cache-control': 'no-cache' } });
  if (!res || res.status !== 200) return undefined;
  return res.text();
}

/** One file of the LIVE release on the origin, or `undefined` when the live HTML names none. */
export async function capturePrevious(
  ports: StaticPorts,
  opts: { appUrl: string; url: string },
): Promise<{ previous?: string; note: string }> {
  const html = await readHtml(ports, opts.appUrl);
  if (html === undefined) {
    return {
      note: `could not read ${opts.appUrl} before the roll; the previous-release check is skipped`,
    };
  }
  const [first] = staticRefs(html, opts.url);
  if (!first) {
    return {
      note: `the live release serves /_next/static from the app itself (it predates the static origin); the previous-release check is skipped`,
    };
  }
  const previous = `${opts.url}/_next/static/${first}`;
  return { previous, note: `the previous release's file: ${previous}` };
}

/** Why a static file's response is not what an old tab needs, or `undefined` when it is. */
function servedProblem(
  res: Awaited<ReturnType<StaticPorts['fetch']>> | undefined,
  appOrigin: string,
): string | undefined {
  if (!res) return 'no response';
  if (res.status !== 200) return `HTTP ${res.status}`;
  const allow = res.headers.get('access-control-allow-origin');
  if (allow !== appOrigin && allow !== '*')
    return `access-control-allow-origin is '${allow ?? ''}'`;
  if (!/\bimmutable\b/.test(res.headers.get('cache-control') ?? '')) {
    return `cache-control is '${res.headers.get('cache-control') ?? ''}', not immutable`;
  }
  return undefined;
}

/** After the upload, before the roll: this build's probe file is served as an old tab needs it. */
export async function verifyUpload(
  ports: StaticPorts,
  opts: { url: string; dir: string; appUrl: string; retry: Retry },
): Promise<{ ok: boolean; message: string }> {
  const probe = pickProbeFile(ports.listFiles(opts.dir));
  if (!probe) return { ok: false, message: `${opts.dir} holds no files — nothing was uploaded` };
  const fileUrl = `${opts.url}/_next/static/${probe}`;
  const appOrigin = new URL(opts.appUrl).origin;
  let problem: string | undefined;
  for (let attempt = 1; attempt <= opts.retry.attempts; attempt += 1) {
    problem = servedProblem(
      await tryFetch(ports, fileUrl, { headers: { origin: appOrigin } }),
      appOrigin,
    );
    if (!problem) return { ok: true, message: `${fileUrl} is served (200, CORS, immutable)` };
    if (attempt < opts.retry.attempts) await ports.sleep(opts.retry.delayMs);
  }
  return { ok: false, message: `${fileUrl}: ${problem ?? 'unknown'} — no task has rolled` };
}

/** Polls the app until its HTML names one of THIS build's files on the origin. */
async function htmlServesThisBuild(
  ports: StaticPorts,
  opts: { appUrl: string; url: string; dir: string; retry: Retry },
): Promise<{ ok: boolean; message: string }> {
  const built = new Set(ports.listFiles(opts.dir));
  let seen = 'no HTML';
  for (let attempt = 1; attempt <= opts.retry.attempts; attempt += 1) {
    const html = await readHtml(ports, opts.appUrl);
    if (html !== undefined) {
      const refs = staticRefs(html, opts.url);
      const ours = refs.find((r) => built.has(r));
      if (ours)
        return { ok: true, message: `${opts.appUrl} loads ${opts.url}/_next/static/${ours}` };
      seen = refs.length
        ? `files of another build (${refs[0]})`
        : `no ${opts.url}/_next/static/ reference`;
    }
    if (attempt < opts.retry.attempts) await ports.sleep(opts.retry.delayMs);
  }
  return { ok: false, message: `${opts.appUrl}'s HTML has ${seen}` };
}

/** After the roll: the HTML is this build's on the origin, and the previous release's file survives. */
export async function verifyRelease(
  ports: StaticPorts,
  opts: { appUrl: string; url: string; dir: string; previous?: string; retry: Retry },
): Promise<{ ok: boolean; messages: string[] }> {
  const html = await htmlServesThisBuild(ports, opts);
  const messages = [html.message];
  let ok = html.ok;
  if (opts.previous) {
    const res = await tryFetch(ports, opts.previous);
    const status = res ? `HTTP ${res.status}` : 'no response';
    messages.push(`the previous release's ${opts.previous} → ${status}`);
    ok = ok && res?.status === 200;
  } else {
    messages.push('no previous-release file to check (the live release predated the origin)');
  }
  return { ok, messages };
}

const RETRY = {
  origin: { attempts: 3, delayMs: 10_000 },
  upload: { attempts: 6, delayMs: 10_000 },
  release: { attempts: 12, delayMs: 10_000 },
} as const satisfies Record<string, Retry>;

type Env = Readonly<Record<string, string | undefined>>;

async function runTarget(ports: StaticPorts, env: Env, io: StaticIo): Promise<number> {
  const namePrefix = env['AWS_DEPLOY_NAME_PREFIX']?.trim();
  if (!namePrefix) {
    io.log('::error::AWS_DEPLOY_NAME_PREFIX is not set');
    return EXIT_ERROR;
  }
  const resolved = await resolveTarget(ports, namePrefix, RETRY.origin);
  if ('skip' in resolved) {
    io.log(
      `::warning::No static-asset origin: ${resolved.skip}. This release serves /_next/static from its own tasks, so a tab open across it can still lose its chunks (MOTIR-11241).`,
    );
    io.output('url', '');
    io.output('bucket', '');
    return EXIT_OK;
  }
  io.log(`static-asset origin ${resolved.target.url}, bucket ${resolved.target.bucket}`);
  io.output('url', resolved.target.url);
  io.output('bucket', resolved.target.bucket);
  return EXIT_OK;
}

interface Flags {
  url: string;
  dir?: string;
  previous?: string;
}

function readFlags(argv: string[]): Flags {
  const { values } = parseArgs({
    args: argv,
    options: { url: { type: 'string' }, dir: { type: 'string' }, previous: { type: 'string' } },
    strict: true,
  });
  if (!values.url) throw new Error('--url is required');
  return {
    url: values.url.replace(/\/+$/, ''),
    dir: values.dir,
    previous: values.previous || undefined,
  };
}

function requireDir(flags: Flags): string {
  if (!flags.dir) throw new Error('--dir is required');
  return flags.dir;
}

async function runCommand(
  command: string,
  flags: Flags,
  ports: StaticPorts,
  appUrl: string,
  io: StaticIo,
): Promise<number> {
  if (command === 'capture-previous') {
    const { previous, note } = await capturePrevious(ports, { appUrl, url: flags.url });
    io.log(note);
    io.output('previous', previous ?? '');
    return EXIT_OK;
  }
  if (command === 'verify-upload') {
    const result = await verifyUpload(ports, {
      url: flags.url,
      dir: requireDir(flags),
      appUrl,
      retry: RETRY.upload,
    });
    io.log(result.ok ? result.message : `::error::${result.message}`);
    return result.ok ? EXIT_OK : EXIT_ERROR;
  }
  const result = await verifyRelease(ports, {
    appUrl,
    url: flags.url,
    dir: requireDir(flags),
    previous: flags.previous,
    retry: RETRY.release,
  });
  for (const line of result.messages) io.log(result.ok ? line : `::error::${line}`);
  return result.ok ? EXIT_OK : EXIT_ERROR;
}

const COMMANDS = ['target', 'capture-previous', 'verify-upload', 'verify-release'];

/** The script's whole behaviour: argv and env in, an exit code out. */
export async function main(
  argv: string[],
  env: Env,
  io: StaticIo,
  ports: StaticPorts,
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command)) {
    io.log(
      `usage: staticAssets.ts <${COMMANDS.join('|')}> [--url <origin>] [--dir <static dir>] [--previous <file url>]`,
    );
    return EXIT_ERROR;
  }
  try {
    if (command === 'target') return await runTarget(ports, env, io);
    const appUrl = env['MOTIR_APP_URL']?.trim() || DEFAULT_APP_URL;
    return await runCommand(command, readFlags(rest), ports, appUrl, io);
  } catch (err) {
    io.log(`::error::${err instanceof Error ? err.message : String(err)}`);
    return EXIT_ERROR;
  }
}

/* v8 ignore start -- the production adapters: one call each, exercised by the deploy itself. */
export function processPorts(region: string): StaticPorts {
  // Built on first use: only `target` talks to AWS, so the HTTP checks need no region.
  let aws: ReturnType<typeof awsSdkPorts> | undefined;
  return {
    readParameter: (name) => (aws ??= awsSdkPorts(region)).readParameter(name),
    fetch: (url, init) =>
      fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(30_000) }),
    listFiles: listStaticFiles,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function processIo(env: Env): StaticIo {
  return {
    output: (key, value) => {
      const file = env['GITHUB_OUTPUT'];
      if (file) appendFileSync(file, `${key}=${value}\n`);
      process.stdout.write(`${key}=${value}\n`);
    },
    log: (line) => process.stderr.write(`${line}\n`),
  };
}

const isEntry =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  const region = process.env['AWS_REGION'] ?? '';
  void main(process.argv.slice(2), process.env, processIo(process.env), processPorts(region)).then(
    (code) => process.exit(code),
  );
}
/* v8 ignore stop */
