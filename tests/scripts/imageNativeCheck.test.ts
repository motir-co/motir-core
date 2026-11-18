import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ELF_MACHINE,
  elfMachine,
  inspectNatives,
  loadAddons,
  main,
  packageRoot,
  prebuildPlatform,
  walk,
} from '../../scripts/imageNativeCheck.mjs';

// MOTIR-11718: the image is built for linux/amd64 AND linux/arm64 with the
// JavaScript compiled once on the build machine. The runner stage runs this
// check under the TARGET platform, so a native file built for the other CPU
// stops the build instead of failing on its first request in production.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-check-'));
  dirs.push(dir);
  return dir;
}

/** A 64-byte ELF header for `machine`, little- or big-endian. */
function elf(machine: number, bigEndian = false): Buffer {
  const buf = Buffer.alloc(64);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, bigEndian ? 2 : 1, 1], 0);
  if (bigEndian) buf.writeUInt16BE(machine, 18);
  else buf.writeUInt16LE(machine, 18);
  return buf;
}

function put(root: string, rel: string, body: Buffer | string): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

const X64 = ELF_MACHINE.x64;
const ARM64 = ELF_MACHINE.arm64;

describe('elfMachine', () => {
  it('reads e_machine in either byte order, and null for anything else', () => {
    const root = tree();
    expect(elfMachine(put(root, 'le', elf(X64)))).toBe(62);
    expect(elfMachine(put(root, 'be', elf(ARM64, true)))).toBe(183);
    expect(elfMachine(put(root, 'js', 'module.exports = 1;\n'.repeat(4)))).toBeNull();
    expect(elfMachine(put(root, 'short', Buffer.from([0x7f, 0x45, 0x4c, 0x46])))).toBeNull();
  });
});

describe('prebuildPlatform / packageRoot / walk', () => {
  it('finds the prebuild platform directory a file sits in', () => {
    expect(prebuildPlatform('/a/argon2/prebuilds/linux-arm64/argon2.glibc.node')).toEqual({
      prebuilds: '/a/argon2/prebuilds',
      platform: 'linux-arm64',
    });
    expect(prebuildPlatform('/a/argon2/prebuilds/linux-arm64')).toBeNull();
    expect(prebuildPlatform('/a/argon2/build/Release/argon2.node')).toBeNull();
  });

  it('finds the nearest package.json at or below the root', () => {
    const root = tree();
    put(root, 'node_modules/argon2/package.json', '{"name":"argon2"}');
    const file = put(root, 'node_modules/argon2/build/Release/argon2.node', elf(X64));
    expect(packageRoot(file, root)).toBe(join(root, 'node_modules/argon2'));
    expect(packageRoot(put(root, 'loose/x.node', elf(X64)), join(root, 'loose'))).toBeNull();
    expect(packageRoot('/x.node', '/')).toBeNull();
  });

  it('walks regular files without following a symlink', () => {
    const root = tree();
    const outside = tree();
    put(outside, 'hidden.node', elf(X64));
    put(root, 'a/b/c.txt', 'c');
    symlinkSync(outside, join(root, 'link'));
    expect(walk(root)).toEqual([join(root, 'a/b/c.txt')]);
  });
});

describe('inspectNatives', () => {
  it('accepts an image whose natives are all this CPU and lists each addon package', () => {
    const root = tree();
    put(root, 'node_modules/argon2/package.json', '{"name":"argon2"}');
    put(root, 'node_modules/argon2/prebuilds/linux-arm64/argon2.glibc.node', elf(ARM64));
    put(root, 'node_modules/argon2/prebuilds/linux-x64/argon2.glibc.node', elf(X64));
    put(root, 'node_modules/argon2/prebuilds/darwin-arm64/argon2.node', 'macho');
    put(root, 'bin/tool', elf(ARM64));
    const report = inspectNatives([root], 'arm64');
    expect(report.problems).toEqual([]);
    expect(report.binaries.sort()).toEqual(
      [
        join(root, 'bin/tool'),
        join(root, 'node_modules/argon2/prebuilds/linux-arm64/argon2.glibc.node'),
      ].sort(),
    );
    expect(report.addonPackages).toEqual([join(root, 'node_modules/argon2')]);
  });

  it('refuses a file built for the other CPU outside a prebuild set', () => {
    const root = tree();
    const engine = put(root, 'migrate/node_modules/@prisma/engines/schema-engine', elf(X64));
    const report = inspectNatives([root], 'arm64');
    expect(report.problems).toEqual([`${engine}: ELF machine 62, this image is arm64 (183)`]);
  });

  it('refuses a prebuild set with Linux builds but none for this CPU', () => {
    const root = tree();
    put(root, 'node_modules/argon2/prebuilds/linux-x64/argon2.glibc.node', elf(X64));
    const report = inspectNatives([root], 'arm64');
    expect(report.problems).toEqual([
      `${join(root, 'node_modules/argon2/prebuilds')}: Linux prebuilds for linux-x64 but none for linux-arm64`,
    ]);
  });

  it('refuses a prebuild in this CPU directory that is really the other CPU', () => {
    const root = tree();
    const wrong = put(root, 'node_modules/argon2/prebuilds/linux-arm64/argon2.node', elf(X64));
    expect(inspectNatives([root], 'arm64').problems).toEqual([
      `${wrong}: ELF machine 62, this image is arm64 (183)`,
    ]);
  });
});

describe('loadAddons', () => {
  it('requires each package by its own name, reporting the ones that fail', () => {
    const root = tree();
    const good = join(root, 'node_modules/good-addon');
    put(root, 'node_modules/good-addon/package.json', '{"name":"good-addon","main":"index.js"}');
    put(root, 'node_modules/good-addon/index.js', 'module.exports = 1;');
    const bad = join(root, 'node_modules/bad-addon');
    put(root, 'node_modules/bad-addon/package.json', '{"name":"bad-addon","main":"index.js"}');
    put(root, 'node_modules/bad-addon/index.js', "throw new Error('No native build was found');");
    const nameless = join(root, 'node_modules/nameless');
    put(root, 'node_modules/nameless/package.json', '{}');
    expect(loadAddons([good, bad, nameless])).toEqual([
      `${bad}: require('bad-addon') failed: No native build was found`,
      `${nameless}: package.json has no name`,
    ]);
  });

  it("loads the .node files of a package that exports no main entry (sharp's platform packages)", () => {
    // A real addon to load: argon2's own prebuild for this CPU, copied in.
    const prebuilds = join(
      dirname(createRequire(import.meta.url).resolve('argon2/package.json')),
      'prebuilds',
      `linux-${process.arch}`,
    );
    const real = readdirSync(prebuilds).find((f) => f.endsWith('.glibc.node'));
    expect(real).toBeDefined();
    const root = tree();
    const pkg = join(root, 'node_modules/@img/sharp-linux-test');
    put(
      root,
      'node_modules/@img/sharp-linux-test/package.json',
      JSON.stringify({
        name: '@img/sharp-linux-test',
        exports: { './package.json': './package.json' },
      }),
    );
    put(
      root,
      'node_modules/@img/sharp-linux-test/lib/sharp.node',
      readFileSync(join(prebuilds, real!)),
    );
    put(root, 'node_modules/@img/sharp-linux-test/prebuilds/linux-x64/never.node', 'not loaded');
    expect(loadAddons([pkg])).toEqual([]);
    const broken = put(
      root,
      'node_modules/@img/sharp-linux-test/lib/broken.node',
      elf(ELF_MACHINE.x64),
    );
    expect(loadAddons([pkg])).toEqual([
      expect.stringMatching(new RegExp(`^${broken}: loading it failed: `)),
    ]);
  });

  it('reports a thrown non-Error as text', () => {
    const root = tree();
    const pkg = join(root, 'node_modules/odd-addon');
    put(root, 'node_modules/odd-addon/package.json', '{"name":"odd-addon"}');
    put(root, 'node_modules/odd-addon/index.js', "throw 'odd';");
    expect(loadAddons([pkg])).toEqual([`${pkg}: require('odd-addon') failed: odd`]);
  });
});

describe('main', () => {
  const run = (argv: string[]) => {
    const lines: string[] = [];
    const code = main(argv, (l) => lines.push(l));
    return { code, lines };
  };
  const here = process.arch as 'x64' | 'arm64';
  const other = here === 'x64' ? 'arm64' : 'x64';

  it('passes a clean tree for this CPU and loads its addons', () => {
    const root = tree();
    put(root, 'node_modules/good-addon/package.json', '{"name":"good-addon"}');
    put(root, 'node_modules/good-addon/index.js', 'module.exports = 1;');
    put(root, `node_modules/good-addon/prebuilds/linux-${here}/a.node`, elf(ELF_MACHINE[here]));
    const { code, lines } = run([root]);
    expect(code).toBe(0);
    expect(lines).toContain(`  loaded ${join(root, 'node_modules/good-addon')}`);
    expect(lines.at(-1)).toBe(`image-native-check: every native file is built for ${here}`);
  });

  it('fails when an addon this CPU should load does not', () => {
    const root = tree();
    put(root, 'node_modules/bad-addon/package.json', '{"name":"bad-addon"}');
    put(root, 'node_modules/bad-addon/index.js', "throw new Error('wrong ELF class');");
    put(root, 'node_modules/bad-addon/build/Release/a.node', elf(ELF_MACHINE[here]));
    const { code, lines } = run([root]);
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(
      /1 problem\(s\).*\n.*require\('bad-addon'\) failed: wrong ELF class/,
    );
  });

  it('judges another CPU with --arch without loading anything', () => {
    const root = tree();
    put(root, 'node_modules/bad-addon/package.json', '{"name":"bad-addon"}');
    put(root, 'node_modules/bad-addon/index.js', "throw new Error('never required');");
    put(root, 'node_modules/bad-addon/a.node', elf(ELF_MACHINE[other]));
    const clean = run(['--arch', other, root]);
    expect(clean.code).toBe(0);
    expect(clean.lines.some((l) => l.includes('loaded'))).toBe(false);
    const dirty = run(['--arch', here, root]);
    expect(dirty.code).toBe(1);
    expect(dirty.lines.join('\n')).toMatch(/this image would fail on/);
  });

  it('refuses an unknown arch, no directory, and a path that is not one', () => {
    expect(run(['--arch', 'riscv64', '/']).lines).toEqual([
      "image-native-check: unsupported arch 'riscv64' (expected x64 or arm64)",
    ]);
    expect(run([]).lines[0]).toMatch(/^usage:/);
    const root = tree();
    const file = put(root, 'f', 'x');
    const missing = run([file, join(root, 'nope')]);
    expect(missing.code).toBe(1);
    expect(missing.lines).toEqual([
      `image-native-check: not a directory: ${file}, ${join(root, 'nope')}`,
    ]);
  });
});
