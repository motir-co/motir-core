import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import {
  E2E_SERVER_KEEP_ALIVE_MS,
  NEXT_START_KEEP_ALIVE_FLAG,
} from './e2e/_helpers/server-keep-alive';

// Guard for MOTIR-5697: the E2E server must not close an idle keep-alive socket
// while a Playwright runner can still reuse it.
//
// The acceptance lane lost ONE request — a spec's own liveness control, `GET
// /sign-in` — to `apiRequestContext.get: read ECONNRESET` against a server that
// was healthy before and after. The mechanism is a pair of timeouts, and the
// helper's header reads both; this file pins the three things the fix rests on,
// so that a lane added later, a CI job lengthened later, or a Node that starts
// honouring the server's hint each shows up as a red test rather than as the
// next single unexplained reset.
//
// The configs are read as TEXT, never imported — importing one executes a
// module that spawns a webServer command and reads the environment (the same
// constraint `tests/playwright-navigation-timeout.test.ts` states).

const ROOT = join(__dirname, '..');

/** Every Playwright config at the repo root — a new lane is covered unasked. */
const CONFIGS = readdirSync(ROOT).filter((f) => /^playwright(\..+)?\.config\.ts$/.test(f));

/**
 * The source that starts `config`'s server. A config that declares no
 * `webServer` of its own and spreads another lane's config runs THAT config's
 * server (`playwright.regression.config.ts` is the acceptance lane's, MOTIR-9411),
 * so the flag is checked where the command is written.
 */
function serverSourceOf(config: string): string {
  const source = readFileSync(join(ROOT, config), 'utf8');
  if (/^\s*webServer:/m.test(source)) return source;
  const parent = /^import (\w+) from '\.\/(playwright\.[\w.]+\.config)';$/m.exec(source);
  if (parent && source.includes(`...${parent[1]},`)) return serverSourceOf(`${parent[2]}.ts`);
  return source;
}

describe('every E2E `next start` carries the keep-alive flag', () => {
  it('finds the lanes it guards', () => {
    expect(CONFIGS).toEqual(
      expect.arrayContaining([
        'playwright.config.ts',
        'playwright.acceptance.config.ts',
        'playwright.cloud.config.ts',
      ]),
    );
  });

  it.each(CONFIGS)('%s', (config) => {
    const source = serverSourceOf(config);
    // Only a COMMAND says `next start --port`; the prose around it says `next start`.
    const starts = [...source.matchAll(/next start --port \$\{PORT\}[^`'\n]*/g)].map((m) => m[0]);
    expect(starts.length, `${config} starts no server`).toBeGreaterThan(0);
    for (const start of starts) {
      expect(start).toContain('${NEXT_START_KEEP_ALIVE_FLAG}');
    }
    expect(source).toContain(
      "import { NEXT_START_KEEP_ALIVE_FLAG } from './tests/e2e/_helpers/server-keep-alive';",
    );
  });

  it('spells the flag the way `next start` parses it', () => {
    // `next/dist/bin/next`: `new Option('--keepAliveTimeout <keepAliveTimeout>')`.
    expect(NEXT_START_KEEP_ALIVE_FLAG).toBe(`--keepAliveTimeout ${E2E_SERVER_KEEP_ALIVE_MS}`);
  });
});

describe('the window outlives every CI job', () => {
  it('is longer than the longest `timeout-minutes` in .github/workflows', () => {
    // A Playwright worker lives no longer than its job, and the client never
    // expires an idle socket — so only a server window past the job's own
    // ceiling makes the race unreachable. Lengthen a job past it and this fails.
    const dir = join(ROOT, '.github', 'workflows');
    const minutes = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .flatMap((f) =>
        [...readFileSync(join(dir, f), 'utf8').matchAll(/timeout-minutes:\s*(\d+)/g)].map((m) =>
          Number(m[1]),
        ),
      );
    expect(minutes.length).toBeGreaterThan(0);
    expect(E2E_SERVER_KEEP_ALIVE_MS).toBeGreaterThan(Math.max(...minutes) * 60_000);
  });
});

describe('the premise: a keep-alive client does not honour the server hint', () => {
  const servers: http.Server[] = [];
  const agents: http.Agent[] = [];
  afterEach(() => {
    for (const a of agents.splice(0)) a.destroy();
    for (const s of servers.splice(0)) s.close();
  });

  /** One request through `agent`, then the socket the agent pooled afterwards. */
  async function pooledSocketAfterOneRequest(
    server: http.Server,
    agent: http.Agent,
  ): Promise<{ hint: string | undefined; socket: Socket }> {
    servers.push(server);
    agents.push(agent);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const hint = await new Promise<string | undefined>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
          res.resume();
          // Typed as the index signature's `string | string[]`; the header is single-valued.
          res.on('end', () => resolve(res.headers['keep-alive']?.toString()));
        })
        .on('error', reject);
    });
    // `keepSocketAlive` runs as the response completes; let it settle.
    await new Promise((resolve) => setImmediate(resolve));
    const pooled = Object.values(agent.freeSockets).flat();
    expect(pooled).toHaveLength(1);
    return { hint, socket: pooled[0] as Socket };
  }

  it('keeps an idle socket with NO timeout, whatever `Keep-Alive: timeout=` says', async () => {
    // Playwright's APIRequestContext agent is `new …Agent({ keepAlive: true })`
    // with no `timeout` (playwright-core 1.60). Node lets the server's hint only
    // SHORTEN an agent timeout that exists, so this one stays 0 — the client
    // side of the pair is "for ever". If Node or Playwright ever changes that,
    // this fails and the fix's premise needs re-reading.
    const server = http.createServer((_req, res) => res.end('ok')); // `next start`'s default
    const { hint, socket } = await pooledSocketAfterOneRequest(
      server,
      new http.Agent({ keepAlive: true }),
    );
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(hint).toBe('timeout=5');
    expect(socket.timeout ?? 0).toBe(0);
  });

  it('announces the raised window once the flag is applied', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    server.keepAliveTimeout = E2E_SERVER_KEEP_ALIVE_MS; // what `--keepAliveTimeout` assigns
    const { hint } = await pooledSocketAfterOneRequest(server, new http.Agent({ keepAlive: true }));
    expect(hint).toBe(`timeout=${E2E_SERVER_KEEP_ALIVE_MS / 1000}`);
  });
});
