import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
// A zero-dependency release-lane script, deliberately `.mjs`; its typed contract
// lives beside it in `release-set.d.mts`.
import {
  BASE,
  main,
  plan,
  planRelease,
  probeReleaseSet,
  releaseNames,
  verify,
  versionTag,
  type ReleaseProfile,
} from '../sandbox/smoke/release-set.mjs';

// The release set (MOTIR-10884): which `:<name>-<version>` tags a release has,
// read anonymously from the registry. The registry here is a fetch that answers
// like GHCR does for a PUBLIC package — the manifest straight away, or a 404 for
// a tag it has not got — and the shape under test is `cli-v0.17.2`'s first run:
// base, goose and antigravity published, the six others refused.

const IMAGE = 'ghcr.io/motir-co/motir-sandbox';
const CONTROL = 'ghcr.io/astral-sh/uv:latest';
const VERSION = '0.17.2';
const PROFILES: ReleaseProfile[] = [
  { id: 'claude', tier: 1, liveness: 'claude --version' },
  { id: 'codex', tier: 1, liveness: 'codex --version' },
  { id: 'goose', tier: 2, liveness: 'goose --version' },
  { id: 'antigravity', tier: 2, liveness: 'agy --version' },
];
const digestOf = (name: string) => `sha256:${name.padEnd(64, '0').slice(0, 64)}`;

/** A registry holding `published` tags; `broken` tags throw a transport error. */
const registry = (
  published: string[],
  options: { broken?: string[]; controlDown?: boolean } = {},
) =>
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const [, repo, ref] = /^https:\/\/ghcr\.io\/v2\/(.+)\/manifests\/(.+)$/.exec(url) ?? [];
    const reference = `ghcr.io/${repo}:${ref}`;
    if (reference === CONTROL) {
      if (options.controlDown) throw new Error('getaddrinfo ENOTFOUND ghcr.io');
      return new Response('{}', {
        status: 200,
        headers: { 'docker-content-digest': digestOf('uv') },
      });
    }
    if (options.broken?.includes(reference)) throw new Error('socket hang up');
    if (published.includes(reference)) {
      return new Response('{}', {
        status: 200,
        headers: { 'docker-content-digest': digestOf(ref!.split('-')[0]!) },
      });
    }
    return new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404 });
  }) as unknown as typeof fetch;

const tag = (name: string) => versionTag(IMAGE, name, VERSION);
const HALF = [tag('base'), tag('goose'), tag('antigravity')];
const ALL = [tag('base'), ...PROFILES.map((p) => tag(p.id))];
const noWait = { sleep: async () => {}, retryDelayMs: 0 };

const seam = () => {
  const files = new Map<string, string>();
  return {
    files,
    readFile: vi.fn(async () => JSON.stringify({ profiles: PROFILES })),
    writeFile: vi.fn(async (path: string, text: string) => void files.set(path, text)),
    appendFile: vi.fn(
      async (path: string, text: string) => void files.set(path, (files.get(path) ?? '') + text),
    ),
    mkdir: vi.fn(async () => undefined),
    log: vi.fn(),
    error: vi.fn(),
  };
};
const args = ['--image', IMAGE, '--version', VERSION, '--profiles', 'profiles.json'];

describe('the release set', () => {
  it('is the base plus every profile, each tagged with the version', () => {
    expect(BASE).toBe('base');
    expect(releaseNames(PROFILES)).toEqual(['base', 'claude', 'codex', 'goose', 'antigravity']);
    expect(tag('claude')).toBe('ghcr.io/motir-co/motir-sandbox:claude-0.17.2');
  });

  it('sorts each name into published, missing or could-not-tell', async () => {
    const fetch = registry(HALF, { broken: [tag('codex')] });
    const set = await probeReleaseSet(
      { image: IMAGE, version: VERSION, names: releaseNames(PROFILES) },
      { fetch, ...noWait },
    );
    expect(set.published.map((e) => e.name)).toEqual(['base', 'goose', 'antigravity']);
    expect(set.missing.map((e) => e.name)).toEqual(['claude']);
    expect(set.unknown.map((e) => e.name)).toEqual(['codex']);
    // A transport failure is re-asked; a 404 is an answer and is asked once.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([u]) =>
      String(u),
    );
    expect(calls.filter((u) => u.endsWith('/codex-0.17.2'))).toHaveLength(3);
    expect(calls.filter((u) => u.endsWith('/claude-0.17.2'))).toHaveLength(1);
  });

  it('asks nothing about the release when the control does not resolve', async () => {
    const set = await probeReleaseSet(
      { image: IMAGE, version: VERSION, names: ['base'] },
      { fetch: registry(ALL, { controlDown: true }), attempts: 1 },
    );
    expect(set.control.pullable).toBeNull();
    expect(set).toMatchObject({ published: [], missing: [], unknown: [] });
  });

  it('counts a refusal as could-not-tell, never as missing', async () => {
    const refusing = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('astral-sh')
        ? new Response('{}', { status: 200 })
        : new Response('', { status: 403 }),
    ) as unknown as typeof fetch;
    const set = await probeReleaseSet(
      { image: IMAGE, version: VERSION, names: ['claude'] },
      { fetch: refusing },
    );
    expect(set.missing).toEqual([]);
    expect(set.unknown[0]!.verdict).toMatchObject({ pullable: false, reason: 'unauthorized' });
  });

  it('plans only what is missing, and keeps the published digests', async () => {
    const set = await probeReleaseSet(
      { image: IMAGE, version: VERSION, names: releaseNames(PROFILES) },
      { fetch: registry(HALF) },
    );
    expect(planRelease(PROFILES, set)).toEqual({
      profiles: [PROFILES[0], PROFILES[1]],
      basePublished: true,
      digests: {
        base: digestOf('base'),
        goose: digestOf('goose'),
        antigravity: digestOf('antigravity'),
      },
    });
  });
});

describe('plan — the re-run builds only the gap', () => {
  it('outputs the missing profiles and records the published digests (cli-v0.17.2)', async () => {
    const io = seam();
    const code = await plan(
      [...args, '--digests', '/d', '--github-output', '/out', '--summary', '/sum'],
      io,
      {
        fetch: registry(HALF),
      },
    );
    expect(code).toBe(0);
    const out = io.files.get('/out')!;
    expect(out).toContain(`profiles=${JSON.stringify([PROFILES[0], PROFILES[1]])}\n`);
    expect(out).toContain('base_published=true\n');
    expect(out).toContain('published=base,goose,antigravity\n');
    expect(io.mkdir).toHaveBeenCalledWith('/d');
    expect(io.files.get('/d/goose')).toBe(`${digestOf('goose')}\n`);
    expect(io.files.has('/d/claude')).toBe(false);
    expect(io.files.get('/sum')).toContain('| `claude` | **missing** | — |');
    expect(io.log).toHaveBeenCalledWith(
      'already published at 0.17.2, skipped: base, goose, antigravity · to build: claude, codex',
    );
  });

  it('builds everything for a version nothing has been published at', async () => {
    const io = seam();
    expect(await plan([...args, '--github-output', '/out'], io, { fetch: registry([]) })).toBe(0);
    expect(io.files.get('/out')).toContain(`profiles=${JSON.stringify(PROFILES)}\n`);
    expect(io.files.get('/out')).toContain('base_published=false\n');
    expect(io.files.get('/out')).toContain('published=\n');
    expect(io.writeFile).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith('nothing is published at 0.17.2 yet — building all 5');
  });

  it('plans an empty matrix when the release is already complete', async () => {
    const io = seam();
    expect(await plan([...args, '--github-output', '/out'], io, { fetch: registry(ALL) })).toBe(0);
    expect(io.files.get('/out')).toContain('profiles=[]\n');
    expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/· to build: nothing$/));
  });

  it('stops (exit 2) rather than guess when the control is down', async () => {
    const io = seam();
    expect(await plan(args, io, { fetch: registry([], { controlDown: true }), ...noWait })).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('Nothing is skipped on a guess'));
  });

  it('stops (exit 2) when any name could not be asked', async () => {
    const io = seam();
    const code = await plan([...args, '--github-output', '/out'], io, {
      fetch: registry(HALF, { broken: [tag('codex')] }),
      ...noWait,
    });
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('could move an immutable tag'));
    expect(io.files.has('/out')).toBe(false);
  });
});

describe('verify — a partial release fails naming each missing image', () => {
  it('names every image the release lacks (cli-v0.17.2, first run)', async () => {
    const io = seam();
    expect(await verify([...args, '--summary', '/sum'], io, { fetch: registry(HALF) })).toBe(1);
    expect(io.error).toHaveBeenCalledWith(
      '::error::The 0.17.2 release is INCOMPLETE: 2 of 5 images have no :<name>-0.17.2 tag — ' +
        'claude, codex. Re-run the release for this tag; it pushes only the missing images.',
    );
    expect(io.log).toHaveBeenCalledWith(`MISSING    ${tag('claude')}`);
    expect(io.log).toHaveBeenCalledWith(`published  ${tag('goose')}  ${digestOf('goose')}`);
    expect(io.files.get('/sum')).toContain('### Release set — 0.17.2');
  });

  it('ends green once a re-run has landed the rest', async () => {
    const io = seam();
    expect(await verify(args, io, { fetch: registry(ALL) })).toBe(0);
    expect(io.log).toHaveBeenLastCalledWith('all 5 images are published at 0.17.2');
    expect(io.error).not.toHaveBeenCalled();
  });

  it('still names the missing ones when others could not be checked', async () => {
    const io = seam();
    const code = await verify([...args, '--summary', '/sum'], io, {
      fetch: registry(HALF, { broken: [tag('codex')] }),
      ...noWait,
    });
    expect(code).toBe(1);
    expect(io.files.get('/sum')).toContain('| `codex` | could not tell | unreachable |');
    expect(io.error).toHaveBeenCalledWith(
      expect.stringContaining('have no :<name>-0.17.2 tag — claude.'),
    );
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('And 1 could not be checked'));
    expect(io.log).toHaveBeenCalledWith(
      expect.stringMatching(/^UNKNOWN {4}.*codex-0\.17\.2 \(unreachable/),
    );
  });

  it('is a probe failure (exit 2), not a verdict, when only some could not be checked', async () => {
    const io = seam();
    const code = await verify(args, io, {
      fetch: registry(
        ALL.filter((t) => t !== tag('codex')),
        { broken: [tag('codex')] },
      ),
      ...noWait,
    });
    expect(code).toBe(2);
    expect(io.error).toHaveBeenCalledWith(
      expect.stringContaining('a PROBE failure, not a verdict'),
    );
  });

  it('proves nothing (exit 2) when the control is down', async () => {
    const io = seam();
    expect(await verify(args, io, { fetch: registry(ALL, { controlDown: true }), ...noWait })).toBe(
      2,
    );
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining('this run proves NOTHING'));
  });
});

describe('main', () => {
  it('dispatches plan and verify', async () => {
    expect(await main(['verify', ...args], seam(), { fetch: registry(ALL) })).toBe(0);
    expect(await main(['plan', ...args], seam(), { fetch: registry(ALL) })).toBe(0);
  });

  it('refuses an unknown command, missing flags, a bad version and an empty table', async () => {
    await expect(main(['publish'], seam())).rejects.toThrow("unknown command 'publish'");
    await expect(main([], seam())).rejects.toThrow("unknown command ''");
    await expect(main(['verify', '--image', IMAGE], seam())).rejects.toThrow('usage:');
    await expect(
      main(['verify', '--image', IMAGE, '--version', 'main', '--profiles', 'p.json'], seam()),
    ).rejects.toThrow("got 'main'");
    const empty = { ...seam(), readFile: vi.fn(async () => '{"profiles":[]}') };
    await expect(main(['plan', ...args], empty)).rejects.toThrow('lists no profiles');
  });
});

describe('as a process', () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'sandbox',
    'smoke',
    'release-set.mjs',
  );

  it('exits 2 with one annotation on a usage error, never a stack', () => {
    const run = spawnSync(process.execPath, [script, 'verify'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr.trim()).toMatch(/^::error::usage: release-set\.mjs plan\|verify/);
  });
});
