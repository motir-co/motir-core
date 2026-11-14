import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParameterRead } from '../../scripts/aws-deploy/ports';
import {
  DEFAULT_APP_URL,
  EXIT_ERROR,
  EXIT_OK,
  capturePrevious,
  listStaticFiles,
  main,
  originReachable,
  parseTarget,
  pickProbeFile,
  resolveTarget,
  staticAssetsParameterName,
  staticRefs,
  verifyRelease,
  verifyUpload,
  type StaticIo,
  type StaticPorts,
} from '../../scripts/aws-deploy/staticAssets';

// MOTIR-11241: the deploy uploads each release's `_next/static` to the durable
// origin before it rolls, and proves after the roll that the app loads this
// build from there and that the previous release's files survive.

const ORIGIN = 'https://static.motir.co';
const APP = DEFAULT_APP_URL;
const PARAM = JSON.stringify({
  bucket: 'motir-core-static-944842271421',
  url: ORIGIN,
  region: 'eu-central-1',
});
const NO_WAIT = { attempts: 3, delayMs: 1 };

interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}
type Route = FakeResponse | FakeResponse[] | 'throw';

/** A fake network keyed by URL; an array answers in order and repeats its last entry. */
function fakePorts(opts: {
  parameter?: ParameterRead;
  routes?: Record<string, Route>;
  files?: string[];
}): StaticPorts & { calls: { url: string; init?: unknown }[]; sleeps: number } {
  const calls: { url: string; init?: unknown }[] = [];
  const queues = new Map(Object.entries(opts.routes ?? {}));
  const ports = {
    calls,
    sleeps: 0,
    readParameter: async () => opts.parameter ?? { state: 'granted' as const, value: PARAM },
    fetch: async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      calls.push({ url, init });
      const route = queues.get(url);
      if (route === undefined || route === 'throw') throw new TypeError('fetch failed');
      const answer = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]!) : route;
      const headers = new Map(Object.entries(answer.headers ?? {}));
      return {
        status: answer.status,
        headers: { get: (name: string) => headers.get(name) ?? null },
        text: async () => answer.body ?? '',
      };
    },
    listFiles: () => opts.files ?? [],
    sleep: async () => {
      ports.sleeps += 1;
    },
  };
  return ports;
}

const SERVED = {
  status: 200,
  headers: {
    'access-control-allow-origin': APP,
    'cache-control': 'public, max-age=31536000, immutable',
  },
};

function html(base: string, files: string[]): string {
  return `<!DOCTYPE html><html><head>${files
    .map((f) => `<link rel="stylesheet" href="${base}/_next/static/${f}?dpl=abc"/>`)
    .join('')}<script src="${base}/_next/static/chunks/main.js" async=""></script></head></html>`;
}

function recordingIo(): StaticIo & { outputs: Record<string, string>; logs: string[] } {
  const outputs: Record<string, string> = {};
  const logs: string[] = [];
  return { outputs, logs, output: (k, v) => void (outputs[k] = v), log: (l) => void logs.push(l) };
}

describe('parseTarget', () => {
  it('reads motir-infra’s parameter and drops a trailing slash', () => {
    expect(parseTarget(PARAM)).toEqual({ bucket: 'motir-core-static-944842271421', url: ORIGIN });
    expect(parseTarget(JSON.stringify({ bucket: 'b-1x', url: `${ORIGIN}/` })).url).toBe(ORIGIN);
  });

  it.each([
    ['not JSON', '{', /not JSON/],
    ['null', 'null', /bucket/],
    ['no bucket', JSON.stringify({ url: ORIGIN }), /bucket/],
    ['a bad bucket', JSON.stringify({ bucket: 'UPPER', url: ORIGIN }), /bucket/],
    ['no url', JSON.stringify({ bucket: 'abc' }), /url/],
    ['http', JSON.stringify({ bucket: 'abc', url: 'http://static.motir.co' }), /url/],
    ['a path', JSON.stringify({ bucket: 'abc', url: `${ORIGIN}/x` }), /url/],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => parseTarget(raw)).toThrow(message);
  });
});

describe('resolveTarget', () => {
  it('names the parameter after the install prefix', () => {
    expect(staticAssetsParameterName('motir')).toBe('/motir/core/static-assets');
  });

  it('answers the target once the origin answers HTTPS, whatever the status', async () => {
    const ports = fakePorts({ routes: { [`${ORIGIN}/_next/static/`]: { status: 403 } } });
    expect(await resolveTarget(ports, 'motir', NO_WAIT)).toEqual({
      target: { bucket: 'motir-core-static-944842271421', url: ORIGIN },
    });
    expect(ports.calls[0]!.init).toEqual({ method: 'HEAD' });
  });

  it('skips while the parameter does not exist', async () => {
    const ports = fakePorts({ parameter: { state: 'granted', value: undefined } });
    expect(await resolveTarget(ports, 'motir', NO_WAIT)).toEqual({
      skip: expect.stringContaining('does not exist yet'),
    });
  });

  it('skips when the role is not granted the parameter', async () => {
    const ports = fakePorts({ parameter: { state: 'not_granted' } });
    expect(await resolveTarget(ports, 'motir', NO_WAIT)).toEqual({
      skip: expect.stringContaining('may not read'),
    });
  });

  it('skips, after retrying, while the origin’s name does not resolve', async () => {
    const ports = fakePorts({});
    expect(await resolveTarget(ports, 'motir', NO_WAIT)).toEqual({
      skip: expect.stringContaining('CNAME'),
    });
    expect(ports.calls).toHaveLength(3);
    expect(ports.sleeps).toBe(2);
  });

  it('fails on a malformed parameter rather than building against it', async () => {
    const ports = fakePorts({ parameter: { state: 'granted', value: '{}' } });
    await expect(resolveTarget(ports, 'motir', NO_WAIT)).rejects.toThrow(/bucket/);
  });

  it('originReachable recovers on a later attempt', async () => {
    const ports = fakePorts({});
    let n = 0;
    const flaky: StaticPorts = {
      ...ports,
      fetch: async () => {
        n += 1;
        if (n === 1) throw new TypeError('ENOTFOUND');
        return { status: 404, headers: { get: () => null }, text: async () => '' };
      },
    };
    expect(await originReachable(flaky, ORIGIN, NO_WAIT)).toBe(true);
    expect(n).toBe(2);
  });
});

describe('staticRefs', () => {
  it('lists the files under an origin, without query strings, once each', () => {
    const page =
      html(ORIGIN, ['css/a.css', 'css/a.css']) + `"${ORIGIN}/_next/static/media/f.woff2"`;
    expect(staticRefs(page, ORIGIN)).toEqual(['css/a.css', 'chunks/main.js', 'media/f.woff2']);
  });

  it('lists the app’s own files with an empty base, and not another origin’s', () => {
    const page = html('', ['css/a.css']) + html(ORIGIN, ['css/b.css']);
    expect(staticRefs(page, '')).toEqual(['css/a.css', 'chunks/main.js']);
    expect(staticRefs(html('', ['css/a.css']), ORIGIN)).toEqual([]);
  });
});

describe('listStaticFiles and pickProbeFile', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists every file relative to the directory, sorted', () => {
    dir = mkdtempSync(join(tmpdir(), 'static-'));
    mkdirSync(join(dir, 'chunks'), { recursive: true });
    mkdirSync(join(dir, 'css'));
    writeFileSync(join(dir, 'chunks', 'b.js'), '');
    writeFileSync(join(dir, 'chunks', 'a.js'), '');
    writeFileSync(join(dir, 'css', 'x.css'), '');
    expect(listStaticFiles(dir)).toEqual(['chunks/a.js', 'chunks/b.js', 'css/x.css']);
  });

  it('probes the first JavaScript chunk, else the first file, else nothing', () => {
    expect(pickProbeFile(['abc/_buildManifest.js', 'chunks/x.css', 'chunks/y.js'])).toBe(
      'chunks/y.js',
    );
    expect(pickProbeFile(['css/x.css'])).toBe('css/x.css');
    expect(pickProbeFile([])).toBeUndefined();
  });
});

describe('capturePrevious', () => {
  it('answers one of the live release’s files on the origin', async () => {
    const ports = fakePorts({
      routes: { [APP]: { status: 200, body: html(ORIGIN, ['css/old.css']) } },
    });
    const out = await capturePrevious(ports, { appUrl: APP, url: ORIGIN });
    expect(out.previous).toBe(`${ORIGIN}/_next/static/css/old.css`);
    expect(ports.calls[0]!.init).toEqual({ headers: { 'cache-control': 'no-cache' } });
  });

  it('answers none when the live release serves its files itself', async () => {
    const ports = fakePorts({
      routes: { [APP]: { status: 200, body: html('', ['css/old.css']) } },
    });
    const out = await capturePrevious(ports, { appUrl: APP, url: ORIGIN });
    expect(out.previous).toBeUndefined();
    expect(out.note).toMatch(/predates the static origin/);
  });

  it('answers none when the app cannot be read', async () => {
    for (const route of ['throw', { status: 503 }] as const) {
      const ports = fakePorts({ routes: { [APP]: route } });
      const out = await capturePrevious(ports, { appUrl: APP, url: ORIGIN });
      expect(out.previous).toBeUndefined();
      expect(out.note).toMatch(/could not read/);
    }
  });
});

describe('verifyUpload', () => {
  const file = `${ORIGIN}/_next/static/chunks/a.js`;
  const opts = { url: ORIGIN, dir: '/static', appUrl: APP, retry: NO_WAIT };

  it('passes when the probe is served with CORS for the app and an immutable cache header', async () => {
    const ports = fakePorts({ files: ['chunks/a.js'], routes: { [file]: SERVED } });
    expect(await verifyUpload(ports, opts)).toEqual({
      ok: true,
      message: expect.stringContaining('200'),
    });
    expect(ports.calls[0]!.init).toEqual({ headers: { origin: APP } });
  });

  it('accepts a wildcard CORS answer, and passes after a transient miss', async () => {
    const ports = fakePorts({
      files: ['chunks/a.js'],
      routes: {
        [file]: [
          { status: 403 },
          { ...SERVED, headers: { ...SERVED.headers, 'access-control-allow-origin': '*' } },
        ],
      },
    });
    expect((await verifyUpload(ports, opts)).ok).toBe(true);
    expect(ports.sleeps).toBe(1);
  });

  it.each([
    ['unreachable', 'throw' as const, /no response/],
    ['a 403', { status: 403 }, /HTTP 403/],
    [
      'no CORS',
      { status: 200, headers: { 'cache-control': 'immutable' } },
      /access-control-allow-origin is ''/,
    ],
    [
      'a mutable cache',
      { status: 200, headers: { 'access-control-allow-origin': APP } },
      /not immutable/,
    ],
  ])('fails before the roll when the file is %s', async (_label, route, message) => {
    const ports = fakePorts({ files: ['chunks/a.js'], routes: { [file]: route } });
    const out = await verifyUpload(ports, opts);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(message);
    expect(out.message).toMatch(/no task has rolled/);
    expect(ports.calls).toHaveLength(3);
  });

  it('fails when the extracted directory is empty', async () => {
    const out = await verifyUpload(fakePorts({ files: [] }), opts);
    expect(out).toEqual({ ok: false, message: expect.stringContaining('holds no files') });
  });
});

describe('verifyRelease', () => {
  const previous = `${ORIGIN}/_next/static/css/old.css`;
  const opts = { appUrl: APP, url: ORIGIN, dir: '/static', retry: NO_WAIT };

  it('passes when the HTML loads this build from the origin and the previous file survives', async () => {
    const ports = fakePorts({
      files: ['chunks/main.js', 'css/new.css'],
      routes: {
        [APP]: { status: 200, body: html(ORIGIN, ['css/new.css']) },
        [previous]: { status: 200 },
      },
    });
    const out = await verifyRelease(ports, { ...opts, previous });
    expect(out.ok).toBe(true);
    expect(out.messages).toEqual([
      expect.stringContaining(`${ORIGIN}/_next/static/css/new.css`),
      expect.stringContaining('HTTP 200'),
    ]);
  });

  it('waits out the old build’s HTML until the new one is served', async () => {
    const ports = fakePorts({
      files: ['css/new.css'],
      routes: {
        [APP]: [
          { status: 502 },
          { status: 200, body: html(ORIGIN, ['css/old.css']) },
          { status: 200, body: html(ORIGIN, ['css/new.css']) },
        ],
      },
    });
    const out = await verifyRelease(ports, opts);
    expect(out.ok).toBe(true);
    expect(out.messages[1]).toMatch(/predated the origin/);
    expect(ports.sleeps).toBe(2);
  });

  it('fails when the HTML never references the origin', async () => {
    const ports = fakePorts({
      files: ['css/new.css'],
      routes: { [APP]: { status: 200, body: html('', ['css/new.css']) } },
    });
    const out = await verifyRelease(ports, opts);
    expect(out.ok).toBe(false);
    expect(out.messages[0]).toMatch(/no https:\/\/static\.motir\.co\/_next\/static\/ reference/);
  });

  it('fails when the HTML is still another build’s, or never answers', async () => {
    const other = fakePorts({
      files: ['css/new.css'],
      routes: { [APP]: { status: 200, body: html(ORIGIN, ['css/old.css']) } },
    });
    expect((await verifyRelease(other, opts)).messages[0]).toMatch(/another build/);
    const down = fakePorts({ files: ['css/new.css'], routes: { [APP]: 'throw' } });
    expect((await verifyRelease(down, opts)).messages[0]).toMatch(/no HTML/);
  });

  it('fails when the previous release’s file is gone', async () => {
    for (const route of [{ status: 403 }, 'throw'] as const) {
      const ports = fakePorts({
        files: ['css/new.css'],
        routes: { [APP]: { status: 200, body: html(ORIGIN, ['css/new.css']) }, [previous]: route },
      });
      const out = await verifyRelease(ports, { ...opts, previous });
      expect(out.ok).toBe(false);
      expect(out.messages[1]).toMatch(/HTTP 403|no response/);
    }
  });
});

describe('main', () => {
  const env = { AWS_DEPLOY_NAME_PREFIX: 'motir' };

  it('target writes the origin and bucket', async () => {
    const io = recordingIo();
    const ports = fakePorts({ routes: { [`${ORIGIN}/_next/static/`]: { status: 403 } } });
    expect(await main(['target'], env, io, ports)).toBe(EXIT_OK);
    expect(io.outputs).toEqual({ url: ORIGIN, bucket: 'motir-core-static-944842271421' });
  });

  it('target writes empty outputs and a warning while there is no origin', async () => {
    const io = recordingIo();
    const ports = fakePorts({ parameter: { state: 'granted', value: undefined } });
    expect(await main(['target'], env, io, ports)).toBe(EXIT_OK);
    expect(io.outputs).toEqual({ url: '', bucket: '' });
    expect(io.logs[0]).toMatch(/^::warning::No static-asset origin/);
  });

  it('target refuses without the install prefix, and on a malformed parameter', async () => {
    const io = recordingIo();
    expect(await main(['target'], {}, io, fakePorts({}))).toBe(EXIT_ERROR);
    expect(io.logs[0]).toMatch(/AWS_DEPLOY_NAME_PREFIX/);
    const bad = fakePorts({ parameter: { state: 'granted', value: 'nope' } });
    expect(await main(['target'], env, io, bad)).toBe(EXIT_ERROR);
    expect(io.logs.at(-1)).toMatch(/^::error::.*not JSON/);
  });

  it('capture-previous writes the file, or an empty output', async () => {
    const io = recordingIo();
    const ports = fakePorts({
      routes: { [APP]: { status: 200, body: html(ORIGIN, ['css/old.css']) } },
    });
    expect(await main(['capture-previous', '--url', `${ORIGIN}/`], {}, io, ports)).toBe(EXIT_OK);
    expect(io.outputs['previous']).toBe(`${ORIGIN}/_next/static/css/old.css`);
    const none = recordingIo();
    expect(await main(['capture-previous', '--url', ORIGIN], {}, none, fakePorts({}))).toBe(
      EXIT_OK,
    );
    expect(none.outputs['previous']).toBe('');
  });

  it('reads MOTIR_APP_URL when it is set', async () => {
    const io = recordingIo();
    const app = 'https://app.example.com';
    const ports = fakePorts({
      routes: { [app]: { status: 200, body: html(ORIGIN, ['css/x.css']) } },
    });
    await main(['capture-previous', '--url', ORIGIN], { MOTIR_APP_URL: app }, io, ports);
    expect(ports.calls[0]!.url).toBe(app);
  });

  it('verify-upload exits by its verdict', async () => {
    const file = `${ORIGIN}/_next/static/chunks/a.js`;
    const ok = fakePorts({ files: ['chunks/a.js'], routes: { [file]: SERVED } });
    expect(
      await main(['verify-upload', '--url', ORIGIN, '--dir', '/s'], {}, recordingIo(), ok),
    ).toBe(EXIT_OK);
    const io = recordingIo();
    const bad = fakePorts({ files: ['chunks/a.js'] });
    // The retries wait on the fake clock, so the default count still runs instantly.
    expect(await main(['verify-upload', '--url', ORIGIN, '--dir', '/s'], {}, io, bad)).toBe(
      EXIT_ERROR,
    );
    expect(io.logs[0]).toMatch(/^::error::/);
  });

  it('verify-release exits by its verdict, and treats an empty --previous as none', async () => {
    const body = html(ORIGIN, ['css/new.css']);
    const ok = fakePorts({ files: ['css/new.css'], routes: { [APP]: { status: 200, body } } });
    const args = ['verify-release', '--url', ORIGIN, '--dir', '/s', '--previous', ''];
    const io = recordingIo();
    expect(await main(args, {}, io, ok)).toBe(EXIT_OK);
    expect(io.logs[1]).toMatch(/predated the origin/);
    const bad = fakePorts({ files: ['css/new.css'] });
    const failed = recordingIo();
    expect(await main(args, {}, failed, bad)).toBe(EXIT_ERROR);
    expect(failed.logs.every((l) => l.startsWith('::error::'))).toBe(true);
  });

  it('refuses an unknown command, a missing --url or --dir, and an unknown flag', async () => {
    const io = recordingIo();
    expect(await main([], {}, io, fakePorts({}))).toBe(EXIT_ERROR);
    expect(await main(['upload'], {}, io, fakePorts({}))).toBe(EXIT_ERROR);
    expect(io.logs[1]).toMatch(/^usage:/);
    expect(await main(['verify-upload'], {}, io, fakePorts({}))).toBe(EXIT_ERROR);
    expect(io.logs.at(-1)).toMatch(/--url is required/);
    expect(await main(['verify-release', '--url', ORIGIN], {}, io, fakePorts({}))).toBe(EXIT_ERROR);
    expect(io.logs.at(-1)).toMatch(/--dir is required/);
    expect(await main(['verify-upload', '--url', ORIGIN, '--bogus'], {}, io, fakePorts({}))).toBe(
      EXIT_ERROR,
    );
  });
});
