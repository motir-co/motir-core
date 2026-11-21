import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_RUN_COMMANDS,
  controlRequest,
  runStateDir,
  runWorkspaceDir,
} from '../../src/agentTerminal/control.js';
import { AGENT_RUN_ENV, type SignalGroup } from '../../src/agentTerminal/server.js';
import { HOSTED_STATE_ENV } from '../../src/hostedGit.js';
import { RUN_ID_ENV_VAR } from '../../src/hostedMode.js';
import { startHarness, type Client, type FakePty, type Harness } from './harness.js';

// THE SERVER ACTS ON THE RUN'S COMMAND (MOTIR-9050): `run` opens `motir run <KEY>
// --run-id <id>` exactly as before; `fix` and `continue` open `motir <command> <KEY>`
// with the run id in MOTIR_DISPATCH_RUN_ID. Driven through the real control socket and
// the fake PTY, which keeps the options it was spawned with.

const CLI = ['node', '/opt/motir/cli.js'];
const HOME = '/home/agent-test';

interface CommandHarness extends Harness {
  signals: { pid: number; signal: NodeJS.Signals }[];
  removed: string[];
  socket: string;
}

let harness: Harness | null = null;
const clients: Client[] = [];
const temps: string[] = [];

async function start(
  options: { maxSessions?: number; ignoreTerm?: boolean; stopGraceMs?: number } = {},
): Promise<CommandHarness> {
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  const removed: string[] = [];
  let ptys: FakePty[] = [];
  const signalGroup: SignalGroup = (pid, signal) => {
    signals.push({ pid, signal });
    if (signal === 'SIGTERM' && options.ignoreTerm) return;
    ptys.find((candidate) => candidate.pid === pid)?.exit(null, signal === 'SIGKILL' ? 9 : 15);
  };
  const h = await startHarness({
    env: { HOME, MOTIR_SANDBOX_AGENT: 'kimi', MOTIR_TERMINAL_KEY: 'k', PATH: '/usr/bin' },
    cli: CLI,
    signalGroup,
    removeDir: (path) => removed.push(path),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
  });
  ptys = h.ptys;
  const dir = mkdtempSync(join(tmpdir(), 'mtr-9050-'));
  temps.push(dir);
  const socket = join(dir, 'ctl', 'control.sock');
  await h.terminal.listenControl(socket);
  harness = h;
  return { ...h, signals, removed, socket };
}

const ask = (h: CommandHarness, request: Parameters<typeof controlRequest>[1]) =>
  controlRequest(h.socket, request, 2_000);

/** A raw line on the socket, bypassing the typed launcher — what a hostile or stale client sends. */
function raw(h: CommandHarness, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(h.socket);
    let buffer = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) {
        socket.destroy();
        resolve(JSON.parse(buffer.split('\n')[0] as string));
      }
    });
    socket.on('connect', () => socket.write(`${line}\n`));
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await harness?.terminal.close();
  harness = null;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the process each command opens', () => {
  it('`run` keeps today’s argv and env exactly, with or without a command on the request', async () => {
    const h = await start();
    await ask(h, { op: 'run', runId: 'run_1', workItemKey: 'MOTIR-1' });
    h.ptys[0]!.exit(0, null);
    await ask(h, { op: 'run', runId: 'run_2', workItemKey: 'MOTIR-1', command: 'run' });
    for (const [index, runId] of ['run_1', 'run_2'].entries()) {
      const options = h.ptys[index]!.options;
      expect(options.args).toEqual(['/opt/motir/cli.js', 'run', 'MOTIR-1', '--run-id', runId]);
      expect(options.env[HOSTED_STATE_ENV]).toBe(runStateDir(runId));
      expect(options.env[AGENT_RUN_ENV]).toBe('1');
      expect(options.env['MOTIR_WORKSPACE']).toBe(runWorkspaceDir(HOME, runId));
      expect(options.env[RUN_ID_ENV_VAR]).toBeUndefined();
    }
  });

  for (const command of ['fix', 'continue', 'review'] as const) {
    it(`\`${command}\` opens \`motir ${command} <KEY>\` with the run id in the environment and no --run-id`, async () => {
      const h = await start();
      const answer = await ask(h, { op: 'run', runId: 'run_9', workItemKey: 'MOTIR-7', command });
      expect(answer).toMatchObject({ ok: true });
      const options = h.ptys[0]!.options;
      expect(options.file).toBe('node');
      expect(options.args).toEqual(['/opt/motir/cli.js', command, 'MOTIR-7']);
      expect(options.env[RUN_ID_ENV_VAR]).toBe('run_9');
      expect(options.env[HOSTED_STATE_ENV]).toBe(runStateDir('run_9'));
      expect(options.env[AGENT_RUN_ENV]).toBe('1');
      expect(options.env['MOTIR_WORKSPACE']).toBe(runWorkspaceDir(HOME, 'run_9'));
      // The run's environment loses nothing a `run` child carries.
      expect(options.env['MOTIR_TERMINAL_KEY']).toBeUndefined();
      expect(options.cwd).toBe(HOME);
    });
  }

  it('the launcher’s own request shapes both spawn what they name', async () => {
    const h = await start();
    await ask(h, { op: 'run', runId: 'a', workItemKey: 'ACME-7', command: 'fix' });
    expect(h.ptys[0]!.options.args.slice(-2)).toEqual(['fix', 'ACME-7']);
    h.ptys[0]!.exit(0, null);
    await ask(h, { op: 'run', runId: 'b', workItemKey: 'ACME-7' });
    expect(h.ptys[1]!.options.args.slice(-4)).toEqual(['run', 'ACME-7', '--run-id', 'b']);
  });

  it('every command the CLI accepts spawns its own subcommand, with no list of its own here', async () => {
    const h = await start();
    for (const [index, command] of AGENT_RUN_COMMANDS.entries()) {
      await ask(h, { op: 'run', runId: `r${index}`, workItemKey: 'A-1', command });
      expect(h.ptys[index]!.options.args[1]).toBe(command);
      h.ptys[index]!.exit(0, null);
    }
    expect(h.ptys).toHaveLength(AGENT_RUN_COMMANDS.length);
  });
});

describe('a command outside the four reaches no spawn', () => {
  for (const command of ['REVIEW', 'run_scope', 'superfix', 42]) {
    it(`refuses ${JSON.stringify(command)} bad_request`, async () => {
      const h = await start();
      const answer = await raw(
        h,
        JSON.stringify({ op: 'run', runId: 'run_1', workItemKey: 'MOTIR-1', command }),
      );
      expect(answer).toEqual({ ok: false, code: 'bad_request' });
      expect(h.ptys).toEqual([]);
    });
  }
});

describe('one run at a time, across commands', () => {
  it('a run while a fix is live is run_active, and a fix while a run is live is too', async () => {
    const h = await start();
    await ask(h, { op: 'run', runId: 'f1', workItemKey: 'A-1', command: 'fix' });
    expect(await ask(h, { op: 'run', runId: 'r1', workItemKey: 'A-1' })).toEqual({
      ok: false,
      code: 'run_active',
    });
    h.ptys[0]!.exit(0, null);
    await ask(h, { op: 'run', runId: 'r2', workItemKey: 'A-1' });
    expect(await ask(h, { op: 'run', runId: 'f2', workItemKey: 'A-1', command: 'fix' })).toEqual({
      ok: false,
      code: 'run_active',
    });
    expect(h.ptys).toHaveLength(2);
    expect(h.logs.some((line) => line.includes('(fix) refused (run r2 active)'))).toBe(true);
  });
});

describe('a fix run is a first-class run', () => {
  it('reports running then exited, and removes its state and workspace however it ends', async () => {
    const h = await start();
    const opened = (await ask(h, {
      op: 'run',
      runId: 'f1',
      workItemKey: 'A-1',
      command: 'fix',
    })) as { session: string };
    expect(await ask(h, { op: 'status', runId: 'f1' })).toEqual({
      ok: true,
      state: 'running',
      session: opened.session,
    });
    expect(h.logs).toContain(
      `agent-terminal: run f1 (fix) session ${opened.session} opened (pid ${h.ptys[0]!.pid})`,
    );
    h.ptys[0]!.exit(3, null);
    expect(await ask(h, { op: 'status', runId: 'f1' })).toEqual({
      ok: true,
      state: 'exited',
      session: opened.session,
      exitCode: 3,
      signal: null,
    });
    expect(h.removed).toEqual([runStateDir('f1'), runWorkspaceDir(HOME, 'f1')]);
    expect(h.logs).toContain('agent-terminal: run f1 (fix) ended (code 3)');
  });

  it('stop sends SIGTERM and SIGKILL after the grace when the process ignores it', async () => {
    const h = await start({ ignoreTerm: true, stopGraceMs: 30 });
    await ask(h, { op: 'run', runId: 'f1', workItemKey: 'A-1', command: 'continue' });
    expect(await ask(h, { op: 'stop', runId: 'f1' })).toEqual({ ok: true, result: 'stopped' });
    expect(h.signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.logs).toContain('agent-terminal: run f1 (continue) stopping');
    expect(h.removed).toContain(runStateDir('f1'));
  });

  it('a spawn that throws is spawn_failed and removes the state dir', async () => {
    const removed: string[] = [];
    const failing = await startHarness({
      cli: CLI,
      spawnPty: () => {
        throw new Error('no such file');
      },
      removeDir: (path) => removed.push(path),
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), 'mtr-9050-'));
      temps.push(dir);
      const socket = join(dir, 'ctl', 'control.sock');
      await failing.terminal.listenControl(socket);
      expect(
        await controlRequest(
          socket,
          { op: 'run', runId: 'f9', workItemKey: 'A-1', command: 'fix' },
          2_000,
        ),
      ).toEqual({ ok: false, code: 'spawn_failed' });
      expect(removed).toEqual([runStateDir('f9')]);
      expect(failing.logs).toContain('agent-terminal: run f9 (fix) failed to start');
    } finally {
      await failing.terminal.close();
    }
  });

  it('is never counted as a shell and is listed as a run session', async () => {
    const h = await start({ maxSessions: 1 });
    await ask(h, { op: 'run', runId: 'f1', workItemKey: 'A-1', command: 'fix' });
    // The only shell slot is still free: the run is not one of the person's shells.
    const client = await h.connect();
    clients.push(client);
    client.sendJson({ t: 'open', cols: 80, rows: 24 });
    const ready = await client.frame('ready');
    expect(ready['kind']).not.toBe('run');
    const sessions = await client.frame('sessions');
    expect(sessions['sessions']).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'run', runId: 'f1' })]),
    );
  });
});
