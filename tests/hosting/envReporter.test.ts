// MOTIR-9965 — the env-reporting fixture app the deploy check deploys with a
// stored environment. It runs here on localhost, twice: as the readable
// `server.mjs`, and as the inline program in the manifest's start command, split
// on whitespace exactly as the Fly adapter builds a container's `exec`. Both must
// report GREETING's value and only API_KEY's presence.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEPLOY_CHECK_ENV_REPORT_MANIFEST } from '@/lib/hosting/deployCheck';
import { parseHostingManifest } from '@/lib/hosting/manifest';

const SERVER = resolve(process.cwd(), 'tests/fixtures/hosting/envReporter/server.mjs');
const manifest = parseHostingManifest(
  readFileSync(resolve(process.cwd(), DEPLOY_CHECK_ENV_REPORT_MANIFEST), 'utf8'),
);
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

/** Start `argv` with only the given environment, and wait for /health. */
async function start(argv: string[], env: Record<string, string>): Promise<string> {
  const port = await freePort();
  const [command, ...args] = argv;
  const child = spawn(command!, args, {
    env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', PORT: String(port), ...env },
    stdio: 'ignore',
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return base;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${argv.join(' ')} did not start`);
}

const fromFile = ['node', SERVER];
// The Fly adapter's `argvOf`: the start command split on whitespace.
const fromManifest = manifest.startCommand.trim().split(/\s+/);

describe.each([
  ['server.mjs', fromFile],
  ['the manifest start command', fromManifest],
])('the env-reporting fixture, as %s', (_label, argv) => {
  it('reports GREETING’s value and API_KEY’s presence, never its value', async () => {
    const base = await start(argv, { GREETING: 'hello-prod', API_KEY: 's3cret' });
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('GREETING=hello-prod');
    expect(body).toContain('API_KEY: present');
    expect(body).not.toContain('s3cret');
  });

  it('says absent when API_KEY is not set', async () => {
    const base = await start(argv, { GREETING: 'hello-prod' });
    expect(await (await fetch(`${base}/`)).text()).toContain('API_KEY: absent');
  });
});

describe('the env-report manifest', () => {
  it('parses, on the health path and port the fixture serves', () => {
    expect(manifest.port).toBe(8080);
    expect(manifest.healthCheck.path).toBe('/health');
    expect(fromManifest[0]).toBe('node');
    expect(fromManifest).toHaveLength(3);
  });

  it('pins the fixture image by digest, with the date it was read', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/hosting/deployCheck.ts'), 'utf8');
    expect(source).toMatch(
      /DEPLOY_CHECK_ENV_REPORT_IMAGE =\s+'docker\.io\/library\/node@sha256:[0-9a-f]{64}'/,
    );
    expect(source).toMatch(
      /node:22-alpine`, pinned by its multi-arch index digest \(read from Docker Hub\s+\*\s+2026-10-28/,
    );
  });
});
