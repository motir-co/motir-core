/**
 * `node imageNativeCheck.mjs <dir>…` — every native binary in the image is built
 * for the CPU the image runs on (MOTIR-11718).
 *
 * The production image is built for linux/amd64 AND linux/arm64 in one push, and
 * the JavaScript half of it is compiled ONCE, on the build machine (the
 * Dockerfile's `--platform=$BUILDPLATFORM` stages): `next build`'s output, the
 * esbuild bundles and the static files are the same bytes for both CPUs, so the
 * two images serve one set of `/_next/static` files and one Sentry release.
 * Native code is the exception. A `.node` addon or an engine executable copied
 * from the build machine into the arm64 image would be an x86-64 file that only
 * fails when a request first loads it, in production, on the new CPU.
 *
 * So the runner stage runs this script under the TARGET platform (QEMU in CI for
 * arm64) and the build stops on any of:
 *
 *   * an ELF file whose machine is not this CPU's — except inside a
 *     node-gyp-build `prebuilds/<os>-<arch>/` directory for ANOTHER platform,
 *     which is a fallback set the loader picks from at run time;
 *   * a `prebuilds/` directory with Linux builds but none for this CPU;
 *   * a package holding a `.node` addon that cannot be `require`d here, which is
 *     the proof the loader really finds a binary this CPU runs.
 *
 * It reads only the directories it is given and follows no symlink, so pnpm's
 * `.pnpm` tree is walked once. `--arch <x64|arm64>` judges files for another CPU
 * without loading them (the unit tests use it); the image passes nothing and is
 * judged as `process.arch`. Exit 0 when clean, 1 with every problem listed.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** `e_machine` of an ELF file, per Node's `process.arch` name. */
export const ELF_MACHINE = /** @type {const} */ ({ x64: 62, arm64: 183 });

/** The ELF magic: 0x7F 'E' 'L' 'F'. */
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];

/**
 * The ELF `e_machine` of `file`, or null when it is not an ELF file.
 *
 * @param {string} file
 * @returns {number | null}
 */
export function elfMachine(file) {
  const header = Buffer.alloc(20);
  const fd = openSync(file, 'r');
  let read;
  try {
    read = readSync(fd, header, 0, 20, 0);
  } finally {
    closeSync(fd);
  }
  if (read < 20 || ELF_MAGIC.some((byte, i) => header[i] !== byte)) return null;
  // EI_DATA (byte 5): 1 little-endian, 2 big-endian. e_machine is at offset 18.
  return header[5] === 2 ? header.readUInt16BE(18) : header.readUInt16LE(18);
}

/**
 * The `<os>-<arch>` of a node-gyp-build prebuild directory `file` sits in, or null.
 *
 * @param {string} file
 * @returns {{ prebuilds: string, platform: string } | null}
 */
export function prebuildPlatform(file) {
  const parts = file.split(sep);
  const at = parts.lastIndexOf('prebuilds');
  if (at === -1 || at + 2 >= parts.length) return null;
  return { prebuilds: parts.slice(0, at + 1).join(sep), platform: parts[at + 1] };
}

/**
 * The nearest directory at or above `file` holding a `package.json`, below `root`.
 *
 * @param {string} file
 * @param {string} root
 * @returns {string | null}
 */
export function packageRoot(file, root) {
  for (let dir = dirname(file); dir.startsWith(root); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dir === dirname(dir)) break;
  }
  return null;
}

/**
 * Every regular file under `dir`, symlinks not followed.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function walk(dir) {
  /** @type {string[]} */
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = /** @type {string} */ (stack.pop());
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

/**
 * @typedef {object} NativeReport
 * @property {string[]} problems   every reason the image is not right for `arch`
 * @property {string[]} binaries   every ELF file judged for `arch`
 * @property {string[]} addonPackages  every package root holding a `.node` addon
 */

/**
 * Judge every native file under `roots` for `arch`. Pure apart from reading files.
 *
 * @param {string[]} roots
 * @param {keyof typeof ELF_MACHINE} arch
 * @returns {NativeReport}
 */
export function inspectNatives(roots, arch) {
  const machine = ELF_MACHINE[arch];
  const own = `linux-${arch}`;
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const binaries = [];
  /** @type {Set<string>} */
  const addonPackages = new Set();
  /** @type {Map<string, Set<string>>} */
  const prebuildSets = new Map();

  for (const root of roots) {
    for (const file of walk(root)) {
      const found = elfMachine(file);
      if (found === null) continue;
      const prebuild = prebuildPlatform(file);
      if (prebuild) {
        const platforms = prebuildSets.get(prebuild.prebuilds) ?? new Set();
        platforms.add(prebuild.platform);
        prebuildSets.set(prebuild.prebuilds, platforms);
        // Another platform's prebuild is a fallback the loader never picks here.
        if (prebuild.platform !== own) continue;
      }
      binaries.push(file);
      if (found !== machine) {
        problems.push(`${file}: ELF machine ${found}, this image is ${arch} (${machine})`);
        continue;
      }
      if (basename(file).endsWith('.node')) {
        const pkg = packageRoot(file, root);
        if (pkg) addonPackages.add(pkg);
      }
    }
  }

  for (const [prebuilds, platforms] of prebuildSets) {
    const linux = [...platforms].filter((p) => p.startsWith('linux-'));
    if (linux.length > 0 && !platforms.has(own)) {
      problems.push(`${prebuilds}: Linux prebuilds for ${linux.join(', ')} but none for ${own}`);
    }
  }

  return { problems, binaries, addonPackages: [...addonPackages].sort() };
}

/**
 * `require` each addon package by its own name from inside itself, which is how
 * node-gyp-build and friends pick the binary at run time. A package that exports
 * no main entry (sharp's `@img/sharp-linux-<cpu>`, whose consumer requires its
 * `.node` by subpath) has each of its own `.node` files loaded instead —
 * prebuild sets aside, which only the package's loader may choose from.
 *
 * @param {string[]} packages
 * @returns {string[]} the packages that failed, with why
 */
export function loadAddons(packages) {
  /** @type {string[]} */
  const failures = [];
  for (const pkg of packages) {
    const { name } = /** @type {{ name?: string }} */ (
      JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
    );
    if (!name) {
      failures.push(`${pkg}: package.json has no name`);
      continue;
    }
    const load = createRequire(join(pkg, 'package.json'));
    try {
      load(name);
    } catch (err) {
      if (/** @type {{ code?: unknown }} */ (err)?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        failures.push(`${pkg}: require('${name}') failed: ${message(err)}`);
        continue;
      }
      for (const file of walk(pkg).filter((f) => f.endsWith('.node') && !prebuildPlatform(f))) {
        try {
          load(file);
        } catch (fileErr) {
          failures.push(`${file}: loading it failed: ${message(fileErr)}`);
        }
      }
    }
  }
  return failures;
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {string[]} argv
 * @param {(line: string) => void} log
 * @returns {number} the exit code
 */
export function main(argv, log) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { arch: { type: 'string' } },
    allowPositionals: true,
  });
  const arch = values.arch ?? process.arch;
  if (!(arch in ELF_MACHINE)) {
    log(
      `image-native-check: unsupported arch '${arch}' (expected ${Object.keys(ELF_MACHINE).join(' or ')})`,
    );
    return 1;
  }
  if (positionals.length === 0) {
    log('usage: node imageNativeCheck.mjs [--arch x64|arm64] <dir>…');
    return 1;
  }
  const missing = positionals.filter((dir) => !existsSync(dir) || !lstatSync(dir).isDirectory());
  if (missing.length > 0) {
    log(`image-native-check: not a directory: ${missing.join(', ')}`);
    return 1;
  }

  const typedArch = /** @type {keyof typeof ELF_MACHINE} */ (arch);
  const report = inspectNatives(positionals, typedArch);
  // Loading proves the loader's own choice, and only works on the CPU it runs on.
  const loadFailures = typedArch === process.arch ? loadAddons(report.addonPackages) : [];
  const problems = [...report.problems, ...loadFailures];

  log(`image-native-check: ${report.binaries.length} native file(s) for ${arch}`);
  for (const file of report.binaries) log(`  ${file}`);
  if (typedArch === process.arch) {
    for (const pkg of report.addonPackages) log(`  loaded ${pkg}`);
  }
  if (problems.length > 0) {
    log(`image-native-check: ${problems.length} problem(s) — this image would fail on ${arch}:`);
    for (const problem of problems) log(`  ${problem}`);
    return 1;
  }
  log(`image-native-check: every native file is built for ${arch}`);
  return 0;
}

/* v8 ignore start -- the CLI entry: the Dockerfile runs it, the tests call main(). */
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2), (line) => console.error(line));
}
/* v8 ignore stop */
