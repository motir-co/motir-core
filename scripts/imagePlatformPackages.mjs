/**
 * `node imagePlatformPackages.mjs --arch <amd64|arm64> --store <.pnpm> <standalone>`
 * — give a traced standalone server the TARGET CPU's platform packages
 * (MOTIR-11718).
 *
 * Some dependencies ship their native code as one optional package per platform
 * — sharp, which `next/image` optimises with, is `@img/sharp-linux-x64` +
 * `@img/sharp-libvips-linux-x64` on an x86-64 machine and the `-linux-arm64`
 * pair on a Graviton one — and load the one for `process.arch` at run time.
 * `next build` runs ONCE, on the build machine (the Dockerfile's
 * `--platform=$BUILDPLATFORM` builder), so the server it traces holds the BUILD
 * machine's package, which the arm64 image cannot load.
 *
 * The Dockerfile's `deps` stage installs every one of those packages for both
 * Linux CPUs (`supportedArchitectures`), and this script, run once per target in
 * the `standalone` stage, swaps each platform package in the standalone pnpm
 * store for the target's twin:
 *
 *   * a `.pnpm/<name>` entry naming `linux-<other cpu>` (or `linuxmusl-…`) is
 *     replaced by the store's `linux-<target cpu>` entry — copied whole, its own
 *     symlinks kept as they are;
 *   * every symlink in the standalone tree that pointed into the old entry is
 *     re-pointed (and renamed) to the new one, so `require('@img/sharp-linux-arm64')`
 *     from sharp's own directory resolves.
 *
 * A twin missing from the store stops the build (exit 1): the image would ship a
 * package its CPU cannot load. `node imageNativeCheck.mjs` in the runner then
 * proves the result on the target CPU itself.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Docker's (and Node's) CPU names → the token platform packages carry. */
export const CPU_TOKEN = /** @type {const} */ ({ amd64: 'x64', x64: 'x64', arm64: 'arm64' });

/** The CPU tokens this image is built for. */
const TOKENS = ['x64', 'arm64'];

/**
 * The CPU token in a platform package's name (`@img+sharp-linux-x64@0.35.5`,
 * `lightningcss-linux-arm64-gnu@1.32.0`, `sharp-linuxmusl-x64`), or null.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function platformCpu(name) {
  const match = /(?:^|[+/-])linux(?:musl)?-(x64|arm64)(?=$|[-@_])/.exec(name);
  return match ? /** @type {string} */ (match[1]) : null;
}

/**
 * `name` with its Linux CPU token switched to `cpu`.
 *
 * @param {string} name
 * @param {string} cpu
 * @returns {string}
 */
export function twinName(name, cpu) {
  return name.replace(/((?:^|[+/-])linux(?:musl)?-)(x64|arm64)(?=$|[-@_])/, `$1${cpu}`);
}

/**
 * Every symlink under `dir`, not followed.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function symlinksUnder(dir) {
  /** @type {string[]} */
  const links = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = /** @type {string} */ (stack.pop());
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) links.push(path);
      else if (entry.isDirectory()) stack.push(path);
    }
  }
  return links;
}

/**
 * @typedef {object} SwapReport
 * @property {string[]} swapped   `<old> -> <new>` per replaced store entry
 * @property {string[]} relinked  every symlink re-pointed
 * @property {string[]} problems  every twin the store lacks
 */

/**
 * Swap the standalone tree's platform packages for `cpu`'s.
 *
 * @param {string} standalone  the `.next/standalone` directory
 * @param {string} store       the full install's `node_modules/.pnpm`
 * @param {string} cpu         `x64` or `arm64`
 * @returns {SwapReport}
 */
export function swapPlatformPackages(standalone, store, cpu) {
  const virtualStore = join(standalone, 'node_modules', '.pnpm');
  /** @type {SwapReport} */
  const report = { swapped: [], relinked: [], problems: [] };
  if (!existsSync(virtualStore)) return report;

  /** @type {Map<string, string>} old entry name → new entry name */
  const renames = new Map();
  for (const entry of readdirSync(virtualStore)) {
    const found = platformCpu(entry);
    if (found === null || found === cpu) continue;
    const twin = twinName(entry, cpu);
    if (!existsSync(join(store, twin))) {
      report.problems.push(`${entry}: the install holds no ${twin} for ${cpu}`);
      continue;
    }
    if (!existsSync(join(virtualStore, twin))) {
      cpSync(join(store, twin), join(virtualStore, twin), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    rmSync(join(virtualStore, entry), { recursive: true, force: true });
    renames.set(entry, twin);
    report.swapped.push(`${entry} -> ${twin}`);
  }

  for (const link of symlinksUnder(join(standalone, 'node_modules'))) {
    const target = readlinkSync(link);
    const segments = target.split('/');
    const hit = segments.findIndex((s) => renames.has(s));
    if (hit === -1) continue;
    const newTarget = segments
      .map((s, i) =>
        i === hit ? /** @type {string} */ (renames.get(s)) : i > hit ? twinName(s, cpu) : s,
      )
      .join('/');
    const name = basename(link);
    const newLink = join(dirname(link), platformCpu(name) === null ? name : twinName(name, cpu));
    rmSync(link, { force: true });
    if (!existsSync(newLink) && !isLink(newLink)) symlinkSync(newTarget, newLink);
    report.relinked.push(`${newLink} -> ${newTarget}`);
  }
  return report;
}

/** @param {string} path */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * @param {string[]} argv
 * @param {(line: string) => void} log
 * @returns {number} the exit code
 */
export function main(argv, log) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { arch: { type: 'string' }, store: { type: 'string' } },
    allowPositionals: true,
  });
  const cpu = values.arch
    ? CPU_TOKEN[/** @type {keyof typeof CPU_TOKEN} */ (values.arch)]
    : undefined;
  if (!cpu || !TOKENS.includes(cpu) || !values.store || positionals.length !== 1) {
    log(
      'usage: node imagePlatformPackages.mjs --arch <amd64|arm64> --store <node_modules/.pnpm> <standalone>',
    );
    return 1;
  }
  const report = swapPlatformPackages(/** @type {string} */ (positionals[0]), values.store, cpu);
  for (const line of report.swapped) log(`platform package: ${line}`);
  for (const line of report.relinked) log(`  link ${line}`);
  if (report.problems.length > 0) {
    log(
      `image-platform-packages: ${report.problems.length} package(s) have no ${cpu} build installed:`,
    );
    for (const problem of report.problems) log(`  ${problem}`);
    return 1;
  }
  log(`image-platform-packages: ${report.swapped.length} package(s) now for linux-${cpu}`);
  return 0;
}

/* v8 ignore start -- the CLI entry: the Dockerfile runs it, the tests call main(). */
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2), (line) => console.error(line));
}
/* v8 ignore stop */
