import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MotirClient } from '../src/client.js';
import {
  activeHostedRun,
  hostedAttributionLine,
  hostedPromptAddendum,
  resetHostedRun,
  withHostedAttribution,
} from '../src/hostedAttribution.js';
import {
  claimAgentRunScratch,
  gitCredentialCommand,
  githubRepository,
  prepareHostedRun,
} from '../src/hostedGit.js';
import { openSessionPr } from '../src/git.js';

// A HOSTED RUN'S GITHUB ACCESS (MOTIR-6559), driven through REAL git.
//
// A stub Motir answers the run's git-credential route (MOTIR-6538) with one
// token per repository, each App's bot as its author. `prepareHostedRun` writes
// the run's git config; then real `git` — asking the real `motir git-credential`
// helper, run from source through tsx — must hand each repository ITS token,
// refresh one about to expire, and author every commit as that repository's
// bot. The `gh` shim must give a real (fake) `gh` the repository's token for
// that one invocation.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI_SRC_INDEX = join(HERE, '..', 'src', 'index.ts');
const TSX = join(HERE, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const CLI = [TSX, CLI_SRC_INDEX];

const RUN = 'run_hosted_6559';
const RUN_TOKEN = 'mrt_run_credential';

const BOT_A = {
  name: 'motir-studio[bot]',
  email: '101+motir-studio[bot]@users.noreply.github.com',
};
const BOT_B = {
  name: 'motir-integration[bot]',
  email: '202+motir-integration[bot]@users.noreply.github.com',
};

let server: Server;
let serverUrl = '';
let issued = 0;
/** How long the NEXT issued token for repository A lives — the refresh lever. */
let aLifetimeMs = 60 * 60_000;
const authSeen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    authSeen.push(String(req.headers.authorization));
    if (req.method !== 'POST' || req.url !== `/api/v1/dispatch-runs/${RUN}/git-credential`) {
      res.writeHead(404).end();
      return;
    }
    issued += 1;
    const now = Date.now();
    const body = {
      credentials: [
        {
          repository: 'acme/app-a',
          token: `tok-a-${issued}`,
          expiresAt: new Date(now + aLifetimeMs).toISOString(),
          authorName: BOT_A.name,
          authorEmail: BOT_A.email,
        },
        {
          repository: 'acme/app-b',
          token: `tok-b-${issued}`,
          expiresAt: new Date(now + 60 * 60_000).toISOString(),
          authorName: BOT_B.name,
          authorEmail: BOT_B.email,
        },
      ],
      dispatchedBy: 'Yue Zhu',
    };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const tmp: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmp.push(dir);
  return dir;
}

afterEach(() => {
  resetHostedRun();
  issued = 0;
  aLifetimeMs = 60 * 60_000;
  authSeen.length = 0;
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An environment with nothing of the host's git identity or config in it. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k === 'GH_TOKEN' || k === 'GITHUB_TOKEN') continue;
    env[k] = v;
  }
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['HOME'] = tempDir('motir-hosted-home-');
  return env;
}

async function prepare(env: NodeJS.ProcessEnv) {
  const stateDir = tempDir('motir-hosted-state-');
  const run = await prepareHostedRun({
    serverUrl,
    token: RUN_TOKEN,
    runId: RUN,
    targetKey: 'PROD-7',
    client: new MotirClient({ serverUrl, token: RUN_TOKEN }),
    env,
    stateDir,
    cli: CLI,
  });
  return { stateDir, run };
}

/** A checkout whose `origin` is the GitHub repository — nothing is fetched. */
function checkout(env: NodeJS.ProcessEnv, repository: string): string {
  const dir = tempDir('motir-hosted-repo-');
  execFileSync('git', ['init', '--quiet', dir], { env });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`], {
    cwd: dir,
    env,
  });
  return dir;
}

/**
 * Run a command WITHOUT blocking this process — the stub server lives here, and
 * a `spawnSync` whose child calls it back would deadlock the two.
 */
function runAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}

/** What `git push` asks the helper — `git credential fill` IS that request. */
async function credentialFill(
  env: NodeJS.ProcessEnv,
  cwd: string,
  repository: string,
): Promise<string> {
  const res = await runAsync('git', ['credential', 'fill'], {
    cwd,
    env,
    input: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`,
  });
  expect(res.status, res.stderr).toBe(0);
  return /password=(.*)/.exec(res.stdout)?.[1] ?? '';
}

describe('githubRepository', () => {
  it('reads owner/name from every form git and gh hand over, and nothing else', () => {
    expect(githubRepository('acme/app-a.git')).toBe('acme/app-a');
    expect(githubRepository('https://github.com/acme/app-a.git\n')).toBe('acme/app-a');
    expect(githubRepository('git@github.com:acme/app-a.git')).toBe('acme/app-a');
    expect(githubRepository('https://gitlab.com/acme/app-a.git')).toBeNull();
    expect(githubRepository('acme')).toBeNull();
  });
});

describe('prepareHostedRun (MOTIR-6559)', () => {
  it('points the environment at the run git config and the gh shim — and puts no token in it', async () => {
    const env = cleanEnv();
    const { stateDir, run } = await prepare(env);

    expect(env['GIT_CONFIG_GLOBAL']).toBe(join(stateDir, 'gitconfig'));
    expect(env['PATH']!.split(delimiter)[0]).toBe(join(stateDir, 'bin'));
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(Object.values(env).some((v) => v?.includes('tok-a-'))).toBe(false);
    expect(run.dispatchedBy).toBe('Yue Zhu');
    expect(activeHostedRun()?.runId).toBe(RUN);
    // The route was called with the RUN credential.
    expect(authSeen).toContain(`Bearer ${RUN_TOKEN}`);
    // The run credential and tokens sit in files only their owner can read.
    for (const f of ['run.json', 'credentials.json', 'gitconfig']) {
      expect(statSync(join(stateDir, f)).mode & 0o077).toBe(0);
    }
  });
});

describe('git reaches GitHub only through the helper (AC1)', () => {
  it('hands each repository ITS token, and serves a fresh one from the cache', async () => {
    const env = cleanEnv();
    await prepare(env);
    const a = checkout(env, 'acme/app-a');
    const b = checkout(env, 'acme/app-b');

    expect(await credentialFill(env, a, 'acme/app-a')).toBe('tok-a-1');
    expect(await credentialFill(env, b, 'acme/app-b')).toBe('tok-b-1');
    // Both answered from the cache prepare wrote — one route call in all.
    expect(issued).toBe(1);
  }, 60_000);

  it('refreshes a token with less than five minutes left BEFORE handing it to git', async () => {
    aLifetimeMs = 2 * 60_000; // prepare caches an A token that is about to expire
    const env = cleanEnv();
    await prepare(env);
    aLifetimeMs = 60 * 60_000;
    const a = checkout(env, 'acme/app-a');

    expect(await credentialFill(env, a, 'acme/app-a')).toBe('tok-a-2');
    expect(issued).toBe(2);
  }, 60_000);

  it('answers nothing for a host that is not GitHub, and erase forces a refetch', async () => {
    const env = cleanEnv();
    const { stateDir } = await prepare(env);
    const out: string[] = [];
    const io = (stdin: string) => ({ stdin, write: (s: string) => out.push(s) });

    await gitCredentialCommand(['--state', stateDir, 'get'], io('host=gitlab.com\npath=a/b\n'));
    expect(out).toEqual([]);

    await gitCredentialCommand(
      ['--state', stateDir, 'erase'],
      io('protocol=https\nhost=github.com\npath=acme/app-a.git\n'),
    );
    await gitCredentialCommand(
      ['--state', stateDir, 'get'],
      io('protocol=https\nhost=github.com\npath=acme/app-a.git\n'),
    );
    expect(out.join('')).toBe('username=x-access-token\npassword=tok-a-2\n');
  });
});

describe('every commit is the App bot of its repository (AC4)', () => {
  it('authors and commits as bot A in repository A and bot B in B, and refuses elsewhere', async () => {
    const env = cleanEnv();
    await prepare(env);
    const commitIn = (cwd: string) =>
      spawnSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'work'], {
        cwd,
        env,
        encoding: 'utf8',
      });
    const who = (cwd: string) =>
      execFileSync('git', ['log', '-1', '--format=%an <%ae>|%cn <%ce>'], {
        cwd,
        env,
        encoding: 'utf8',
      }).trim();

    const a = checkout(env, 'acme/app-a');
    const b = checkout(env, 'acme/app-b');
    expect(commitIn(a).status).toBe(0);
    expect(commitIn(b).status).toBe(0);
    expect(who(a)).toBe(`${BOT_A.name} <${BOT_A.email}>|${BOT_A.name} <${BOT_A.email}>`);
    expect(who(b)).toBe(`${BOT_B.name} <${BOT_B.email}>|${BOT_B.name} <${BOT_B.email}>`);

    // A repository the run does not hold refuses to commit rather than guess.
    const stranger = checkout(env, 'someone/else');
    expect(commitIn(stranger).status).not.toBe(0);
  }, 60_000);
});

describe('gh gets the repository token for ONE invocation (AC2)', () => {
  it('runs the real gh with GH_TOKEN for that repository, leaving the environment clean', async () => {
    const env = cleanEnv();
    const realBin = tempDir('motir-hosted-realgh-');
    const record = join(realBin, 'record.txt');
    writeFileSync(join(realBin, 'gh'), `#!/bin/sh\necho "$GH_TOKEN|$*" >> '${record}'\n`);
    chmodSync(join(realBin, 'gh'), 0o755);
    env['PATH'] = [realBin, env['PATH']].join(delimiter);
    const { stateDir } = await prepare(env);
    const a = checkout(env, 'acme/app-a');

    const res = await runAsync('gh', ['pr', 'create', '--draft', '--title', 't'], { cwd: a, env });
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(record, 'utf8').trim()).toBe('tok-a-1|pr create --draft --title t');
    // -R names a repository explicitly, and wins over the checkout's origin.
    await runAsync('gh', ['pr', 'list', '-R', 'acme/app-b'], { cwd: a, env });
    expect(readFileSync(record, 'utf8').trim().split('\n')[1]).toBe(
      'tok-b-1|pr list -R acme/app-b',
    );
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(readFileSync(join(stateDir, 'bin', 'gh'), 'utf8')).toContain('hosted-gh');
  }, 60_000);
});

describe('pull requests name the dispatcher, the card and the run (AC4)', () => {
  it('appends the attribution once, to the bodies the CLI opens and edits', async () => {
    await prepare(cleanEnv());
    const line = hostedAttributionLine()!;
    expect(line).toContain('Dispatched by Yue Zhu');
    expect(line).toContain(`(${serverUrl}/items/PROD-7)`);
    expect(line).toContain(`(${serverUrl}/runs?run=${RUN})`);
    const once = withHostedAttribution('Body.');
    expect(withHostedAttribution(once)).toBe(once);

    const calls: string[][] = [];
    openSessionPr('/nowhere', { branch: 'b', title: 't', body: 'Carried: PROD-8' }, (cmd, args) => {
      calls.push([cmd, ...args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const create = calls.find((c) => c[2] === 'create')!;
    expect(create[create.indexOf('--body') + 1]).toContain('Dispatched by Yue Zhu');

    // …and the agent is told the same line for the pull requests IT opens.
    expect(hostedPromptAddendum()).toContain(line);
  });

  it('changes nothing on a local run', () => {
    resetHostedRun();
    expect(withHostedAttribution('Body.')).toBe('Body.');
    expect(hostedPromptAddendum()).toBe('');
  });
});

describe('agent mode (MOTIR-7024)', () => {
  it('redirects gh’s own state into the run, and drops the Motir tokens from the environment', async () => {
    const env = cleanEnv();
    env['MOTIR_TOKEN'] = 'mtk_developer_pat';
    env['MOTIR_RUN_TOKEN'] = 'mrt_run';
    const stateDir = tempDir('motir-agent-state-');
    await prepareHostedRun({
      serverUrl,
      token: RUN_TOKEN,
      runId: RUN,
      targetKey: 'PROD-7',
      client: new MotirClient({ serverUrl, token: RUN_TOKEN }),
      env,
      stateDir,
      cli: CLI,
      agentMode: true,
    });

    expect(env['GH_CONFIG_DIR']).toBe(join(stateDir, 'gh'));
    expect(env['GH_NO_UPDATE_NOTIFIER']).toBe('1');
    expect(env['MOTIR_TOKEN']).toBeUndefined();
    expect(env['MOTIR_RUN_TOKEN']).toBeUndefined();
    expect(env['GIT_CONFIG_GLOBAL']).toBe(join(stateDir, 'gitconfig'));
  });

  it('claims the workspace and removes it, the state and only the parents it created', () => {
    const home = tempDir('motir-agent-home-');
    mkdirSync(join(home, '.motir'), { recursive: true });
    writeFileSync(join(home, '.motir', 'mine'), 'the developer’s');
    const stateDir = tempDir('motir-agent-state-');
    const workspace = join(home, '.motir', 'runs', 'run-1');
    const listeners: (() => void)[] = [];
    let detached = 0;
    const release = claimAgentRunScratch(
      { stateDir, workspace },
      {
        onExit: (fn) => {
          listeners.push(fn);
          return () => {
            detached++;
          };
        },
      },
    );
    expect(existsSync(workspace)).toBe(true);
    writeFileSync(join(workspace, 'file'), 'x');

    listeners[0]!();
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(join(home, '.motir', 'runs'))).toBe(false);
    // `.motir` existed before, and still holds the developer's file.
    expect(existsSync(join(home, '.motir', 'mine'))).toBe(true);
    // A second removal (the `finally` after the interrupt's) is harmless.
    release();
    expect(detached).toBe(2);
  });

  it('stops at a parent that is no longer empty', () => {
    const home = tempDir('motir-agent-home-');
    const workspace = join(home, '.motir', 'runs', 'run-1');
    const release = claimAgentRunScratch({ stateDir: tempDir('motir-agent-state-'), workspace });
    writeFileSync(join(home, '.motir', 'written-meanwhile'), 'x');
    release();
    expect(existsSync(join(home, '.motir', 'runs'))).toBe(false);
    expect(existsSync(join(home, '.motir', 'written-meanwhile'))).toBe(true);
  });
});
