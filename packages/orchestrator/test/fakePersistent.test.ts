import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorApiError,
  fakePersistentOrchestrator as fake,
  type PersistentContainerSpec,
  type PersistentTerminalConfig,
} from '../src/index';

// The FAKE persistent adapter (Story MOTIR-6860 · MOTIR-6869) — the second
// implementation of the persistent port. These pin the behaviours the lifecycle
// service and the story's gates rely on it to model (§1, §2).

const SPEC: PersistentContainerSpec = {
  orgId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  instanceId: 'inst-1',
  image: 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'c'.repeat(64),
  size: FLEET_CONTAINER_SIZE,
  env: {},
  region: 'iad',
  volumeSizeGb: 10,
  mountPath: '/home/node',
  terminal: null,
};

beforeEach(() => fake.reset());

describe('fakePersistentOrchestrator', () => {
  it('provisions an app once per org, a volume, then a running machine mounting it', async () => {
    const a = await fake.provisionPersistent(SPEC);
    const b = await fake.provisionPersistent({ ...SPEC, instanceId: 'inst-2' });
    expect(a.app).toBe(fake.appNameFor('org-1'));
    expect(fake.defaultRegion()).toBe('iad');
    expect(fake.appNames()).toEqual([a.app]);
    expect(fake.operations).toEqual([
      `app:create:${a.app}`,
      `volume:create:${a.volumeId}`,
      `machine:create:${a.machineId}`,
      `volume:create:${b.volumeId}`,
      `machine:create:${b.machineId}`,
    ]);
    expect(fake.persistentSpecs).toHaveLength(2);
    expect((await fake.describePersistent(a)).state).toBe('running');
    expect(fake.liveVolumeIds()).toEqual([a.volumeId, b.volumeId]);
  });

  // A refused MACHINE create cleaning up its volume is a contract case
  // (`test/contract/persistentContract.ts`); the whole-provision refusal is the fake's own control.
  it('a refused provision creates nothing', async () => {
    fake.failNextProvision();
    await expect(fake.provisionPersistent(SPEC)).rejects.toThrow(OrchestratorApiError);
    expect(fake.liveVolumeIds()).toEqual([]);
    expect(fake.liveMachineIds()).toEqual([]);
  });

  it('stop keeps the volume and records the stop; start is a NEW run with its own start instant', async () => {
    let clock = new Date('2026-09-28T10:00:00.000Z');
    fake.setNow(() => clock);
    const h = await fake.provisionPersistent(SPEC);
    clock = new Date('2026-09-28T10:30:00.000Z');
    await fake.stop(h);
    await fake.stop(h); // idempotent
    const stopped = await fake.describePersistent(h);
    expect(stopped).toMatchObject({ state: 'stopped' });
    expect(stopped.stoppedAt?.toISOString()).toBe('2026-09-28T10:30:00.000Z');
    expect(fake.liveVolumeIds()).toEqual([h.volumeId]);

    clock = new Date('2026-09-28T12:00:00.000Z');
    await fake.start(h);
    await fake.start(h); // idempotent while running
    const woken = await fake.describePersistent(h);
    expect(woken.state).toBe('running');
    expect(woken.startedAt?.toISOString()).toBe('2026-09-28T12:00:00.000Z');
    expect(woken.stoppedAt).toBeNull();
  });

  it('a start can fail (no capacity), and a start of a gone machine throws', async () => {
    const h = await fake.provisionPersistent(SPEC);
    await fake.stop(h);
    fake.failNextStart();
    await expect(fake.start(h)).rejects.toThrow(/capacity/);
    fake.destroyOutside(h.machineId);
    await expect(fake.start(h)).rejects.toThrow(/gone/);
    await expect(fake.stop(h)).resolves.toBeUndefined();
    fake.failNextStop();
    await expect(fake.stop(h)).rejects.toThrow(OrchestratorApiError);
  });

  it('models a machine that never boots, completes it, and one stopped or destroyed outside Motir', async () => {
    fake.setBootBehaviour('never_start');
    const h = await fake.provisionPersistent(SPEC);
    expect((await fake.describePersistent(h)).state).toBe('starting');
    await fake.stop(h);
    await fake.start(h);
    expect((await fake.describePersistent(h)).state).toBe('starting');
    fake.completeBoot(h.machineId);
    expect((await fake.describePersistent(h)).state).toBe('running');
    fake.completeBoot(h.machineId); // no-op once running

    fake.backdateRun(h.machineId, new Date('2026-09-28T08:00:00.000Z'));
    expect((await fake.describePersistent(h)).startedAt?.toISOString()).toBe(
      '2026-09-28T08:00:00.000Z',
    );
    fake.stopOutside(h.machineId);
    expect((await fake.describePersistent(h)).state).toBe('stopped');
    fake.destroyOutside(h.machineId);
    expect(await fake.describePersistent(h)).toMatchObject({ state: 'gone', startedAt: null });
    // The volume survives the machine and is now unattached — the reconcile's orphan.
    const inventory = await fake.listPersistent(h.app);
    expect(inventory.machines).toEqual([]);
    expect(inventory.volumes).toEqual([
      expect.objectContaining({ volumeId: h.volumeId, attachedMachineId: null }),
    ]);
    expect(() => fake.completeBoot('nope')).toThrow(/no machine/);
  });

  it('models a main process that EXITS during boot — its code read back, cleared by the next start (MOTIR-7336)', async () => {
    fake.setBootBehaviour('never_start');
    const h = await fake.provisionPersistent(SPEC);
    expect((await fake.describePersistent(h)).exitCode).toBeNull();
    fake.exitOutside(h.machineId, 0);
    const exited = await fake.describePersistent(h);
    expect(exited).toMatchObject({ state: 'stopped', providerState: 'stopped', exitCode: 0 });
    expect(exited.startedAt).not.toBeNull();
    expect(exited.stoppedAt).not.toBeNull();
    await fake.start(h);
    expect((await fake.describePersistent(h)).exitCode).toBeNull();
    // A stop by Motir or an operator is not an exit: it carries no code.
    fake.completeBoot(h.machineId);
    fake.stopOutside(h.machineId);
    expect((await fake.describePersistent(h)).exitCode).toBeNull();
  });

  it('records the machine’s own events: launch, start, and an exit with the scripted code (MOTIR-7396)', async () => {
    fake.setBootBehaviour('never_start');
    const h = await fake.provisionPersistent(SPEC);
    expect((await fake.describePersistent(h)).events.map((e) => e.type)).toEqual(['launch']);
    fake.exitOutside(h.machineId, 3);
    await fake.start(h);
    fake.completeBoot(h.machineId);
    const events = (await fake.describePersistent(h)).events;
    expect(events.map((e) => e.type)).toEqual(['launch', 'exit', 'start']);
    expect(events[1]).toMatchObject({ type: 'exit', exitCode: 3 });
    expect(events[0]!.at).toBeInstanceOf(Date);
  });

  it('records a stop, an exit and a new start across a stop and a start', async () => {
    const h = await fake.provisionPersistent(SPEC);
    await fake.stop(h);
    await fake.start(h);
    const events = (await fake.describePersistent(h)).events;
    expect(events.map((e) => e.type)).toEqual(['launch', 'start', 'stop', 'exit', 'start']);
  });

  // Machine-then-volume, idempotent destroys and the inventory read are contract
  // cases; an armed destroy failure is the fake's own control.
  it('a destroy armed to fail throws', async () => {
    const h = await fake.provisionPersistent(SPEC);
    fake.failNextDestroy();
    await expect(fake.destroyPersistent(h)).rejects.toThrow(OrchestratorApiError);
  });
});

describe('the cross-process seam', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-persistent-'));
    vi.stubEnv('MOTIR_FAKE_PERSISTENT_STATE_PATH', join(dir, 'state.json'));
    fake.reset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists the fleet to the shared file, so another process sees the same machines', async () => {
    const h = await fake.provisionPersistent(SPEC);
    expect(h.machineId).toMatch(new RegExp(`^fake-instance-${process.pid}-`));
    const inventory = await fake.listPersistent(h.app);
    expect(inventory.machines[0]!.createdAt).toBeInstanceOf(Date);
    expect(fake.liveMachineIds()).toEqual([h.machineId]);
  });

  it('a failure armed by ANOTHER process (the sidecar) is met once, here', async () => {
    // What an E2E runner does: write the arranged failure beside the shared state.
    writeFileSync(
      join(dir, 'state.json.failures.json'),
      JSON.stringify({ provision: 'no room on the host' }),
    );
    await expect(fake.provisionPersistent(SPEC)).rejects.toThrow('no room on the host');
    await expect(fake.provisionPersistent(SPEC)).resolves.toBeTruthy();
    // …and one armed here reaches the sidecar for the other process to meet.
    fake.failNextStart('capacity');
    const h = await fake.provisionPersistent(SPEC);
    await fake.stop(h);
    await expect(fake.start(h)).rejects.toThrow('capacity');
  });
});

describe('exec (MOTIR-6872)', () => {
  it('records each command on a running machine and returns the arranged result once', async () => {
    const h = await fake.provisionPersistent(SPEC);
    expect(await fake.exec(h, ['echo', 'hi'])).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    fake.setNextExecResult({ exitCode: 128, stdout: '', stderr: 'fatal' });
    expect((await fake.exec(h, ['git', 'clone'])).exitCode).toBe(128);
    expect((await fake.exec(h, ['true'])).exitCode).toBe(0);
    expect(fake.execs.map((e) => e.command[0])).toEqual(['echo', 'git', 'true']);
  });

  it('records stdin, answers through a responder, and lets a one-shot result win (MOTIR-7026)', async () => {
    const h = await fake.provisionPersistent(SPEC);
    fake.setExecResponder((command, stdin) => ({
      exitCode: 0,
      stdout: `${command.join(' ')}|${stdin ?? '-'}`,
      stderr: '',
    }));
    expect((await fake.exec(h, ['cat'], { stdin: 'secret' })).stdout).toBe('cat|secret');
    fake.setNextExecResult({ exitCode: 9, stdout: '', stderr: '' });
    expect((await fake.exec(h, ['cat'])).exitCode).toBe(9);
    expect((await fake.exec(h, ['ls'])).stdout).toBe('ls|-');
    expect(fake.execs.map((e) => e.stdin)).toEqual(['secret', undefined, undefined]);
    fake.setExecResponder(null);
    expect((await fake.exec(h, ['ls'])).stdout).toBe('');
  });

  it('refuses a machine that is not running', async () => {
    const h = await fake.provisionPersistent(SPEC);
    await fake.stop(h);
    await expect(fake.exec(h, ['true'])).rejects.toThrow(/not running/);
    fake.destroyOutside(h.machineId);
    await expect(fake.exec(h, ['true'])).rejects.toThrow(/not running/);
  });

  describe('the exec bridge (MOTIR-7031)', () => {
    afterEach(() => vi.unstubAllEnvs());

    async function withBridge(
      answer: (body: Record<string, unknown>) => { status: number; json: unknown },
      body: (url: string, seen: Record<string, unknown>[]) => Promise<void>,
    ): Promise<void> {
      const seen: Record<string, unknown>[] = [];
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
        req.on('end', () => {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          seen.push(parsed);
          const { status, json } = answer(parsed);
          res.statusCode = status;
          res.end(JSON.stringify(json));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        await body(`http://127.0.0.1:${port}/exec`, seen);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    it('posts an unscripted exec to MOTIR_FAKE_EXEC_URL and answers its result', async () => {
      const h = await fake.provisionPersistent(SPEC);
      await withBridge(
        () => ({ status: 200, json: { exitCode: 0, stdout: '{"session":"s-1"}\n', stderr: '' } }),
        async (url, seen) => {
          vi.stubEnv('MOTIR_FAKE_EXEC_URL', url);
          const result = await fake.exec(h, ['motir', 'agent-terminal', 'run'], {
            stdin: '{"token":"t"}',
            timeoutSeconds: 30,
          });
          expect(result).toEqual({ exitCode: 0, stdout: '{"session":"s-1"}\n', stderr: '' });
          expect(seen).toEqual([
            {
              machineId: h.machineId,
              command: ['motir', 'agent-terminal', 'run'],
              stdin: '{"token":"t"}',
              timeoutSeconds: 30,
            },
          ]);
          // A scripted answer still wins over the bridge.
          fake.setNextExecResult({ exitCode: 7, stdout: '', stderr: '' });
          expect((await fake.exec(h, ['true'])).exitCode).toBe(7);
          expect(seen).toHaveLength(1);
        },
      );
    });

    it("turns the bridge's refusal, or its silence, into the provider's error", async () => {
      const h = await fake.provisionPersistent(SPEC);
      await withBridge(
        () => ({ status: 409, json: { error: 'machine is not booted' } }),
        async (url) => {
          vi.stubEnv('MOTIR_FAKE_EXEC_URL', url);
          await expect(fake.exec(h, ['true'])).rejects.toThrow(OrchestratorApiError);
        },
      );
      vi.stubEnv('MOTIR_FAKE_EXEC_URL', 'http://127.0.0.1:1/exec');
      await expect(fake.exec(h, ['true'])).rejects.toThrow(/exec bridge did not answer/);
    });
  });
});

describe('the terminal (agent-terminal.md Q2, Q8 · MOTIR-6939)', () => {
  const TERMINAL: PersistentTerminalConfig = {
    version: 1,
    keyId: 'kid-1',
    command: ['sh', '-c', 'exec motir agent-terminal serve'],
    env: { MOTIR_TERMINAL_KEY: 'k' },
    service: {
      internalPort: 7681,
      ports: [{ port: 443, handlers: ['tls', 'http'] }],
      autostart: false,
      autostop: 'off',
    },
  };

  afterEach(() => vi.unstubAllEnvs());

  it('stamps a machine created with a terminal config, and 0 for one created without', async () => {
    const withTerminal = await fake.provisionPersistent({ ...SPEC, terminal: TERMINAL });
    const legacy = await fake.provisionPersistent({ ...SPEC, instanceId: 'inst-2' });
    expect(fake.machineConfigVersion(withTerminal.machineId)).toBe(1);
    expect(fake.machineConfigVersion(legacy.machineId)).toBe(0);
    expect(await fake.ensureMachineConfig(withTerminal, TERMINAL)).toBe('current');
  });

  it('updates an older machine ONCE without starting it, re-applies a rotated key, and leaves a newer one alone', async () => {
    const handle = await fake.provisionPersistent(SPEC);
    await fake.stop(handle);
    expect(await fake.ensureMachineConfig(handle, TERMINAL)).toBe('updated');
    expect(await fake.ensureMachineConfig(handle, TERMINAL)).toBe('current');
    expect((await fake.describePersistent(handle)).state).toBe('stopped');
    expect(fake.operations.filter((o) => o.startsWith('machine:update'))).toHaveLength(1);
    expect(await fake.ensureMachineConfig(handle, { ...TERMINAL, keyId: 'rotated' })).toBe(
      'updated',
    );
    expect(await fake.ensureMachineConfig(handle, { ...TERMINAL, version: 0 })).toBe('current');
    fake.destroyOutside(handle.machineId);
    await expect(fake.ensureMachineConfig(handle, TERMINAL)).rejects.toThrow(OrchestratorApiError);
  });

  it('resolves an agent’s address to a REAL locally started server, carrying the machine id', async () => {
    // A stand-in for the in-image server (MOTIR-6938 ships the real one): it
    // answers the WebSocket upgrade on /v1/terminal, which is all the relay dials.
    const seen: IncomingMessage[] = [];
    const server = createServer();
    server.on('upgrade', (req, socket) => {
      seen.push(req);
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const handle = await fake.provisionPersistent({ ...SPEC, terminal: TERMINAL });
      fake.setTerminalAddress(`ws://127.0.0.1:${port}/`);
      const endpoint = fake.terminalEndpoint(handle);
      expect(endpoint).toEqual({
        url: `ws://127.0.0.1:${port}/v1/terminal`,
        headers: { 'x-motir-machine-id': handle.machineId },
      });
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(endpoint.url.replace(/^ws/, 'http'), {
          headers: { ...endpoint.headers, connection: 'Upgrade', upgrade: 'websocket' },
        });
        req.on('upgrade', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(101);
      expect(seen.map((r) => [r.url, r.headers['x-motir-machine-id']])).toEqual([
        ['/v1/terminal', handle.machineId],
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('defaults the address to MOTIR_FAKE_TERMINAL_URL, then to 127.0.0.1:7681', async () => {
    const handle = await fake.provisionPersistent(SPEC);
    expect(fake.terminalEndpoint(handle).url).toBe('ws://127.0.0.1:7681/v1/terminal');
    vi.stubEnv('MOTIR_FAKE_TERMINAL_URL', 'ws://localhost:9999');
    expect(fake.terminalEndpoint(handle).url).toBe('ws://localhost:9999/v1/terminal');
    fake.reset();
    vi.stubEnv('MOTIR_FAKE_TERMINAL_URL', '');
    expect(fake.terminalEndpoint(handle).url).toBe('ws://127.0.0.1:7681/v1/terminal');
  });
});

describe('the image move and the liveness check (agent-image-update.md Q2, Q3 · MOTIR-6950)', () => {
  const NEW_IMAGE = 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'd'.repeat(64);

  it('moves a RUNNING machine to the new image on the same volume: a new run, the handle unchanged', async () => {
    let clock = new Date('2026-10-01T10:00:00.000Z');
    fake.setNow(() => clock);
    const h = await fake.provisionPersistent(SPEC);
    clock = new Date('2026-10-01T10:05:00.000Z');
    await fake.moveImage(h, NEW_IMAGE, { launch: true });
    const status = await fake.describePersistent(h);
    expect(status).toMatchObject({ state: 'running', image: NEW_IMAGE });
    expect(status.startedAt?.toISOString()).toBe('2026-10-01T10:05:00.000Z');
    expect(fake.machineImage(h.machineId)).toBe(NEW_IMAGE);
    expect(fake.liveMachineIds()).toEqual([h.machineId]);
    expect(fake.liveVolumeIds()).toEqual([h.volumeId]);
  });

  it('moves a STOPPED machine without starting it; the next start boots the new image', async () => {
    const h = await fake.provisionPersistent(SPEC);
    await fake.stop(h);
    await fake.moveImage(h, NEW_IMAGE, { launch: false });
    expect(await fake.describePersistent(h)).toMatchObject({ state: 'stopped', image: NEW_IMAGE });
    await fake.start(h);
    expect(await fake.describePersistent(h)).toMatchObject({ state: 'running', image: NEW_IMAGE });
  });

  it('a refused move changes nothing, and a gone machine throws', async () => {
    const h = await fake.provisionPersistent(SPEC);
    fake.failNextMove('version mismatch');
    await expect(fake.moveImage(h, NEW_IMAGE, { launch: true })).rejects.toThrow(
      OrchestratorApiError,
    );
    expect(fake.machineImage(h.machineId)).toBe(SPEC.image);
    fake.destroyOutside(h.machineId);
    await expect(fake.moveImage(h, NEW_IMAGE, { launch: true })).rejects.toThrow(
      OrchestratorApiError,
    );
  });

  it('a machine that never boots after the move reads starting', async () => {
    const h = await fake.provisionPersistent(SPEC);
    fake.setBootBehaviour('never_start');
    await fake.moveImage(h, NEW_IMAGE, { launch: true });
    expect((await fake.describePersistent(h)).state).toBe('starting');
  });

  it('answers alive on a running machine, and NOT alive (exit 127) for an image marked failing', async () => {
    const h = await fake.provisionPersistent(SPEC);
    expect(await fake.checkLiveness(h, ['claude', '--version'])).toEqual({ alive: true });
    fake.markImageFailing(NEW_IMAGE);
    await fake.moveImage(h, NEW_IMAGE, { launch: true });
    expect(await fake.checkLiveness(h, ['claude', '--version'])).toMatchObject({
      alive: false,
      reason: 'exit',
      exitCode: 127,
    });
    // Back on the old image, it is alive again: the mark is per image.
    await fake.moveImage(h, SPEC.image, { launch: true });
    expect((await fake.checkLiveness(h, ['claude', '--version'])).alive).toBe(true);
  });

  it('answers unreachable for a stopped machine, and follows a scripted exec answer', async () => {
    const h = await fake.provisionPersistent(SPEC);
    fake.setNextExecResult({ exitCode: 2, stdout: '', stderr: 'boom' });
    expect(await fake.checkLiveness(h, ['codex', '--version'])).toMatchObject({
      alive: false,
      reason: 'exit',
      exitCode: 2,
    });
    await fake.stop(h);
    expect(await fake.checkLiveness(h, ['codex', '--version'])).toMatchObject({
      alive: false,
      reason: 'unreachable',
    });
  });
});

describe('the home a volume holds (MOTIR-6954)', () => {
  it('keeps a written file across an image move, and answers null once the volume is gone', async () => {
    const h = await fake.provisionPersistent(SPEC);
    fake.writeHomeFile(h.volumeId, 'notes.txt', 'mine');
    await fake.moveImage(h, 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'e'.repeat(64), {
      launch: true,
    });
    expect(fake.readHomeFile(h.volumeId, 'notes.txt')).toBe('mine');
    expect(fake.readHomeFile(h.volumeId, 'other.txt')).toBeNull();
    await fake.destroyPersistent(h);
    expect(fake.readHomeFile(h.volumeId, 'notes.txt')).toBeNull();
    expect(() => fake.writeHomeFile(h.volumeId, 'x', 'y')).toThrow(OrchestratorApiError);
  });
});
