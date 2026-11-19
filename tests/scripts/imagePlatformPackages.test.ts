import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CPU_TOKEN,
  main,
  platformCpu,
  swapPlatformPackages,
  symlinksUnder,
  twinName,
} from '../../scripts/imagePlatformPackages.mjs';

// MOTIR-11718: `next build` runs once, on the build machine, so the standalone
// server it traces holds that machine's per-platform packages (sharp's
// `@img/sharp-linux-x64` pair). The Dockerfile's `standalone` stage runs this
// script once per target to swap each for the target CPU's twin.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-packages-'));
  dirs.push(dir);
  return dir;
}

function file(path: string, body = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

function link(target: string, path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  symlinkSync(target, path);
}

const SHARP = 'sharp@0.35.5_@types+node@22.20.3';

/** A pnpm store laid out as the full install leaves it, for both CPUs. */
function fullStore(root: string): string {
  const store = join(root, 'node_modules/.pnpm');
  for (const cpu of ['x64', 'arm64']) {
    file(
      join(
        store,
        `@img+sharp-linux-${cpu}@0.35.5/node_modules/@img/sharp-linux-${cpu}/lib/sharp.node`,
      ),
    );
    link(
      `../../../@img+sharp-libvips-linux-${cpu}@1.3.4/node_modules/@img/sharp-libvips-linux-${cpu}`,
      join(store, `@img+sharp-linux-${cpu}@0.35.5/node_modules/@img/sharp-libvips-linux-${cpu}`),
    );
    file(
      join(
        store,
        `@img+sharp-libvips-linux-${cpu}@1.3.4/node_modules/@img/sharp-libvips-linux-${cpu}/lib/libvips.so`,
      ),
    );
  }
  return store;
}

/** A standalone tree as `next build` traced it on an x64 machine. */
function tracedStandalone(root: string): string {
  const standalone = join(root, 'standalone');
  const vs = join(standalone, 'node_modules/.pnpm');
  file(join(vs, `${SHARP}/node_modules/sharp/lib/sharp.js`));
  for (const pkg of ['sharp-linux-x64@0.35.5', 'sharp-libvips-linux-x64@1.3.4']) {
    const [name] = pkg.split('@');
    file(join(vs, `@img+${pkg}/node_modules/@img/${name}/lib/native`));
    link(
      `../../../@img+${pkg}/node_modules/@img/${name}`,
      join(vs, `${SHARP}/node_modules/@img/${name}`),
    );
  }
  link(
    '../../@img+colour@1.1.0/node_modules/@img/colour',
    join(vs, `${SHARP}/node_modules/@img/colour`),
  );
  link(
    '../../@img+sharp-linux-x64@0.35.5/node_modules/@img/sharp-linux-x64',
    join(vs, 'node_modules/@img/sharp-linux-x64'),
  );
  return standalone;
}

describe('platformCpu / twinName', () => {
  it.each([
    ['@img+sharp-linux-x64@0.35.5', 'x64', '@img+sharp-linux-arm64@0.35.5'],
    ['@img+sharp-libvips-linux-x64@1.3.4', 'x64', '@img+sharp-libvips-linux-arm64@1.3.4'],
    ['lightningcss-linux-x64-gnu@1.32.0', 'x64', 'lightningcss-linux-arm64-gnu@1.32.0'],
    ['@img+sharp-linuxmusl-x64@0.35.5', 'x64', '@img+sharp-linuxmusl-arm64@0.35.5'],
    ['sharp-linux-x64', 'x64', 'sharp-linux-arm64'],
    ['@parcel+watcher-linux-x64-glibc_x@2.5.6', 'x64', '@parcel+watcher-linux-arm64-glibc_x@2.5.6'],
  ])('reads and switches the CPU of %s', (name, cpu, twin) => {
    expect(platformCpu(name)).toBe(cpu);
    expect(twinName(name, 'arm64')).toBe(twin);
    expect(twinName(twin, 'x64')).toBe(name);
  });

  it.each(['sharp@0.35.5', 'linux-x64ish', '@img+colour@1.1.0', 'notlinux-x64', 'node_modules'])(
    'does not mistake %s for a platform package',
    (name) => {
      expect(platformCpu(name)).toBeNull();
      expect(twinName(name, 'arm64')).toBe(name);
    },
  );

  it('maps Docker and Node CPU names to the package token', () => {
    expect(CPU_TOKEN).toEqual({ amd64: 'x64', x64: 'x64', arm64: 'arm64' });
  });
});

describe('symlinksUnder', () => {
  it('lists links without following them', () => {
    const root = tmp();
    file(join(root, 'a/real'));
    link('../outside', join(root, 'a/l1'));
    link(root, join(root, 'loop'));
    expect(symlinksUnder(root).sort()).toEqual([join(root, 'a/l1'), join(root, 'loop')]);
  });
});

describe('swapPlatformPackages', () => {
  it("swaps the build machine's sharp pair for the target's and re-points every link", () => {
    const root = tmp();
    const store = fullStore(root);
    const standalone = tracedStandalone(root);
    const vs = join(standalone, 'node_modules/.pnpm');

    const report = swapPlatformPackages(standalone, store, 'arm64');

    expect(report.problems).toEqual([]);
    expect(report.swapped.sort()).toEqual([
      '@img+sharp-libvips-linux-x64@1.3.4 -> @img+sharp-libvips-linux-arm64@1.3.4',
      '@img+sharp-linux-x64@0.35.5 -> @img+sharp-linux-arm64@0.35.5',
    ]);
    expect(existsSync(join(vs, '@img+sharp-linux-x64@0.35.5'))).toBe(false);
    expect(
      existsSync(
        join(
          vs,
          '@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64/lib/sharp.node',
        ),
      ),
    ).toBe(true);
    // The copied entry keeps its own dependency link verbatim.
    expect(
      readlinkSync(
        join(vs, '@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-libvips-linux-arm64'),
      ),
    ).toBe(
      '../../../@img+sharp-libvips-linux-arm64@1.3.4/node_modules/@img/sharp-libvips-linux-arm64',
    );
    // sharp's own links: renamed and re-pointed, so it resolves the arm64 build.
    const img = join(vs, `${SHARP}/node_modules/@img`);
    expect(existsSync(join(img, 'sharp-linux-x64'))).toBe(false);
    expect(readlinkSync(join(img, 'sharp-linux-arm64'))).toBe(
      '../../../@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64',
    );
    expect(existsSync(join(img, 'sharp-linux-arm64/lib/sharp.node'))).toBe(true);
    expect(existsSync(join(img, 'sharp-libvips-linux-arm64/lib/libvips.so'))).toBe(true);
    // A link to something that is not a platform package is left alone.
    expect(readlinkSync(join(img, 'colour'))).toBe(
      '../../@img+colour@1.1.0/node_modules/@img/colour',
    );
    expect(readlinkSync(join(vs, 'node_modules/@img/sharp-linux-arm64'))).toBe(
      '../../@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64',
    );
    expect(report.relinked).toHaveLength(3);
  });

  it('changes nothing when the target is the build machine', () => {
    const root = tmp();
    const standalone = tracedStandalone(root);
    const report = swapPlatformPackages(standalone, fullStore(root), 'x64');
    expect(report).toEqual({ swapped: [], relinked: [], problems: [] });
    expect(existsSync(join(standalone, 'node_modules/.pnpm/@img+sharp-linux-x64@0.35.5'))).toBe(
      true,
    );
  });

  it('keeps a twin the trace already took and does not duplicate its link', () => {
    const root = tmp();
    const store = fullStore(root);
    const standalone = tracedStandalone(root);
    const vs = join(standalone, 'node_modules/.pnpm');
    file(join(vs, '@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64/lib/traced'));
    link(
      '../../../@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64',
      join(vs, `${SHARP}/node_modules/@img/sharp-linux-arm64`),
    );
    const report = swapPlatformPackages(standalone, store, 'arm64');
    expect(report.problems).toEqual([]);
    expect(
      existsSync(
        join(vs, '@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64/lib/traced'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          vs,
          '@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64/lib/sharp.node',
        ),
      ),
    ).toBe(false);
    expect(readlinkSync(join(vs, `${SHARP}/node_modules/@img/sharp-linux-arm64`))).toBe(
      '../../../@img+sharp-linux-arm64@0.35.5/node_modules/@img/sharp-linux-arm64',
    );
  });

  it('reports a package whose twin the install lacks, and leaves it in place', () => {
    const root = tmp();
    const standalone = tracedStandalone(root);
    const store = join(root, 'empty/.pnpm');
    mkdirSync(store, { recursive: true });
    const report = swapPlatformPackages(standalone, store, 'arm64');
    expect(report.problems.sort()).toEqual([
      '@img+sharp-libvips-linux-x64@1.3.4: the install holds no @img+sharp-libvips-linux-arm64@1.3.4 for arm64',
      '@img+sharp-linux-x64@0.35.5: the install holds no @img+sharp-linux-arm64@0.35.5 for arm64',
    ]);
    expect(existsSync(join(standalone, 'node_modules/.pnpm/@img+sharp-linux-x64@0.35.5'))).toBe(
      true,
    );
  });

  it('does nothing for a tree with no pnpm store', () => {
    expect(swapPlatformPackages(tmp(), tmp(), 'arm64')).toEqual({
      swapped: [],
      relinked: [],
      problems: [],
    });
  });
});

describe('main', () => {
  const run = (argv: string[]) => {
    const lines: string[] = [];
    return { code: main(argv, (l) => lines.push(l)), lines };
  };

  it('swaps for a Docker TARGETARCH and logs each change', () => {
    const root = tmp();
    const store = fullStore(root);
    const standalone = tracedStandalone(root);
    const { code, lines } = run(['--arch', 'arm64', '--store', store, standalone]);
    expect(code).toBe(0);
    expect(lines).toContain(
      'platform package: @img+sharp-linux-x64@0.35.5 -> @img+sharp-linux-arm64@0.35.5',
    );
    expect(lines.at(-1)).toBe('image-platform-packages: 2 package(s) now for linux-arm64');
  });

  it('accepts amd64 as x64', () => {
    const root = tmp();
    const { code, lines } = run([
      '--arch',
      'amd64',
      '--store',
      fullStore(root),
      tracedStandalone(root),
    ]);
    expect(code).toBe(0);
    expect(lines).toEqual(['image-platform-packages: 0 package(s) now for linux-x64']);
  });

  it('fails when a twin is missing', () => {
    const root = tmp();
    const store = join(root, 'empty');
    mkdirSync(store);
    const { code, lines } = run(['--arch', 'arm64', '--store', store, tracedStandalone(root)]);
    expect(code).toBe(1);
    expect(lines[0]).toBe('image-platform-packages: 2 package(s) have no arm64 build installed:');
  });

  it.each([
    [['--store', '/s', '/x']],
    [['--arch', 'riscv64', '--store', '/s', '/x']],
    [['--arch', 'arm64', '/x']],
    [['--arch', 'arm64', '--store', '/s']],
    [['--arch', 'arm64', '--store', '/s', '/x', '/y']],
  ])('prints usage for %j', (argv) => {
    const { code, lines } = run(argv);
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^usage:/);
  });
});
