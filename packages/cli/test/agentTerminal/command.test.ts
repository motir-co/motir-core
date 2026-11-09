import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommanderError } from 'commander';
import { NOT_AN_AGENT_IMAGE } from '../../src/agentTerminal/pty.js';
import {
  newNonce,
  relayAuthorizationHeader,
  signRelayToken,
} from '../../src/agentTerminal/relayToken.js';
import type { TerminalServer } from '../../src/agentTerminal/server.js';
import {
  DEFAULT_TERMINAL_PORT,
  FLY_MACHINE_ID_ENV,
  MACHINE_ID_ENV,
  agentTerminalServeCommand,
} from '../../src/commands/agentTerminal.js';
import { CliError } from '../../src/errors.js';
import { buildProgram } from '../../src/program.js';
import { Client, INSTANCE, KEY, MACHINE, fakeSpawner } from './harness.js';

// `motir agent-terminal serve` (MOTIR-6938 · `docs/decisions/agent-terminal.md`
// Q4, Q8): the refusal outside an image, the env it needs, the `--help` the
// machine's init probes, and the no-byte-in-a-log guarantee measured on the
// REAL sinks — process.stdout and process.stderr — across a whole session.

const ENV = {
  HOME: '/nonexistent-home',
  MOTIR_TERMINAL_KEY: KEY,
  MOTIR_INSTANCE_ID: INSTANCE,
  FLY_MACHINE_ID: MACHINE,
  MOTIR_SANDBOX_AGENT: 'claude',
};

let running: TerminalServer | null = null;

/** A port nothing is listening on, from the OS. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}
afterEach(async () => {
  await running?.close();
  running = null;
  vi.restoreAllMocks();
});

describe('motir agent-terminal serve — where it may run', () => {
  it('refuses in words outside an agent image (no node-pty), before listening', async () => {
    const error = await agentTerminalServeCommand({}, { env: ENV, loadPty: () => null }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      'The terminal server runs inside a Motir agent image.',
    );
    expect(NOT_AN_AGENT_IMAGE).toBe((error as CliError).message);
  });

  it('looks for node-pty in /opt/motir-terminal, or MOTIR_TERMINAL_MODULE_DIR', async () => {
    const seen: string[] = [];
    const loadPty = (dir: string) => {
      seen.push(dir);
      return null;
    };
    await agentTerminalServeCommand({}, { env: ENV, loadPty }).catch(() => {});
    await agentTerminalServeCommand(
      {},
      { env: { ...ENV, MOTIR_TERMINAL_MODULE_DIR: '/elsewhere' }, loadPty },
    ).catch(() => {});
    expect(seen).toEqual(['/opt/motir-terminal', '/elsewhere']);
  });

  it.each(['MOTIR_TERMINAL_KEY', 'MOTIR_INSTANCE_ID'])(
    'refuses without %s, naming it and never a value',
    async (name) => {
      const env: NodeJS.ProcessEnv = { ...ENV, [name]: '' };
      const error = (await agentTerminalServeCommand(
        {},
        { env, loadPty: () => fakeSpawner().spawn },
      ).catch((err: unknown) => err)) as CliError;
      expect(error).toBeInstanceOf(CliError);
      expect(error.message).toContain(name);
      expect(error.message).not.toContain(KEY);
    },
  );

  it('refuses with no machine id under either name, naming both and never a value', async () => {
    for (const env of [
      { ...ENV, FLY_MACHINE_ID: '' },
      { ...ENV, FLY_MACHINE_ID: '  ', MOTIR_MACHINE_ID: ' ' },
    ]) {
      const error = (await agentTerminalServeCommand(
        {},
        { env, loadPty: () => fakeSpawner().spawn },
      ).catch((err: unknown) => err)) as CliError;
      expect(error).toBeInstanceOf(CliError);
      expect(error.message).toBe(
        `The terminal server needs ${MACHINE_ID_ENV} (${FLY_MACHINE_ID_ENV} on Fly), which the agent's machine sets.`,
      );
      expect(error.message).not.toContain(KEY);
    }
    expect([MACHINE_ID_ENV, FLY_MACHINE_ID_ENV]).toEqual(['MOTIR_MACHINE_ID', 'FLY_MACHINE_ID']);
  });

  it.each(['0', '65536', 'abc', '80x'])('refuses --port %s', async (port) => {
    await expect(
      agentTerminalServeCommand({ port }, { env: ENV, loadPty: () => fakeSpawner().spawn }),
    ).rejects.toThrow('--port must be a TCP port');
  });

  it('defaults to port 7681', () => {
    expect(DEFAULT_TERMINAL_PORT).toBe(7681);
  });
});

describe('the machine id the relay token must carry (MOTIR-10817)', () => {
  const tokenFor = (machineId: string): string =>
    relayAuthorizationHeader(
      signRelayToken(KEY, {
        instanceId: INSTANCE,
        machineId,
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: newNonce(),
      }),
    );

  async function serve(env: NodeJS.ProcessEnv): Promise<number> {
    const port = await freePort();
    running = await agentTerminalServeCommand(
      { port: String(port) },
      { env, loadPty: () => fakeSpawner().spawn, log: () => {} },
    );
    return port;
  }

  async function accepts(port: number, machineId: string): Promise<boolean> {
    try {
      const client = await Client.connect(port, tokenFor(machineId));
      client.close();
      await client.closed();
      return true;
    } catch {
      return false;
    }
  }

  it('an AWS VM: MOTIR_MACHINE_ID alone (the instance id) starts the server and binds its tokens', async () => {
    const { FLY_MACHINE_ID: _fly, ...aws } = ENV;
    const port = await serve({ ...aws, MOTIR_MACHINE_ID: 'i-00df27f5ec6ca138a' });
    expect(await accepts(port, 'i-00df27f5ec6ca138a')).toBe(true);
    expect(await accepts(port, MACHINE)).toBe(false);
  });

  it('a Fly machine: FLY_MACHINE_ID alone behaves as before', async () => {
    const port = await serve(ENV);
    expect(await accepts(port, MACHINE)).toBe(true);
    expect(await accepts(port, 'i-00df27f5ec6ca138a')).toBe(false);
  });

  it('both set: the host-neutral name wins, and a blank one falls through to Fly’s', async () => {
    let port = await serve({ ...ENV, MOTIR_MACHINE_ID: 'i-0abc' });
    expect(await accepts(port, 'i-0abc')).toBe(true);
    expect(await accepts(port, MACHINE)).toBe(false);
    await running?.close();
    running = null;
    port = await serve({ ...ENV, MOTIR_MACHINE_ID: '  ' });
    expect(await accepts(port, MACHINE)).toBe(true);
  });
});

describe('motir agent-terminal --help — the machine init’s probe', () => {
  it('exits 0 and lists `serve`', () => {
    let printed = '';
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: (text) => (printed += text), writeErr: () => {} });
    for (const command of program.commands) {
      command.exitOverride();
      command.configureOutput({ writeOut: (text) => (printed += text), writeErr: () => {} });
    }
    let exitCode: number | null = null;
    try {
      program.parse(['node', 'motir', 'agent-terminal', '--help']);
    } catch (err) {
      exitCode = (err as CommanderError).exitCode;
    }
    expect(exitCode).toBe(0);
    expect(printed).toContain('serve');
    expect(printed).toContain('agent-terminal');
  });
});

describe('no stream byte reaches stdout or stderr (Q8)', () => {
  it('a marker through the PTY, both ways and on resume, never appears in the process output', async () => {
    const MARKER = 'MARKER-6938-stdout-stderr';
    const captured: string[] = [];
    const capture = (chunk: unknown): boolean => {
      captured.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);

    const { spawn, ptys } = fakeSpawner();
    // The DEFAULT log sink (process.stdout), not an injected one.
    const port = await freePort();
    running = await agentTerminalServeCommand(
      { port: String(port) },
      { env: ENV, loadPty: () => spawn },
    );

    const header = (): string =>
      relayAuthorizationHeader(
        signRelayToken(KEY, {
          instanceId: INSTANCE,
          machineId: MACHINE,
          exp: Math.floor(Date.now() / 1000) + 60,
          nonce: newNonce(),
        }),
      );

    const client = await Client.connect(port, header());
    client.sendJson({ t: 'open', cols: 80, rows: 24 });
    const session = (await client.frame('ready'))['session'] as string;
    client.sendBytes(`echo ${MARKER}\r`);
    await client.until(() => client.output().includes(MARKER));
    ptys[0]!.emitData(`${MARKER}\r\n`);
    client.close();
    await client.closed();

    const again = await Client.connect(port, header());
    again.sendJson({ t: 'open', cols: 80, rows: 24, session });
    await again.until(() => again.output().includes(MARKER));
    ptys[0]!.exit(0, null);
    await again.frame('exit');
    await again.closed();
    const refusedHeader = header();
    await expect(Client.connect(port, `${refusedHeader}tampered`)).rejects.toThrow();

    vi.restoreAllMocks();
    const output = captured.join('');
    expect(output).toContain('agent-terminal: listening on 0.0.0.0:');
    expect(output).toContain(`agent-terminal: session ${session} resumed`);
    expect(output).not.toContain(MARKER);
    expect(output).not.toContain(KEY);
    expect(output).not.toContain(refusedHeader.split(' ')[1]!);
  });
});
