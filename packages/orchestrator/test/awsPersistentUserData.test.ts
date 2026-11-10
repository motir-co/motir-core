import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DROP_TO_IMAGE_USER_ARGV0,
  DROP_TO_IMAGE_USER_SH,
  HOME_FILESYSTEM_LABEL,
  INSTANCE_CONFIG_MARKER,
  MACHINE_ID_ENV_KEYS,
  PERSISTENT_CONFIG_FILE,
  PERSISTENT_ENV_FILE,
  PersistentUserDataError,
  USER_DATA_MAX_BYTES,
  encodeInstanceUserData,
  instanceConfigOf,
  parseInstanceUserData,
  renderInstanceUserData,
  type AwsInstanceConfig,
  type PersistentTerminalConfig,
} from '../src/index';
import { AWS_PERSISTENT_SPEC } from './contract/awsPersistentHarness';

// An agent instance's user-data (Story MOTIR-9361 · MOTIR-9469, MOTIR-9479): the
// config as one parseable document, the per-boot script that reads it from the
// metadata service, and what is refused before any EC2 call.

const TERMINAL: PersistentTerminalConfig = {
  version: 3,
  keyId: 'kid-1',
  command: ['sh', '-c', "exec motir agent-terminal serve 'x'"],
  env: { MOTIR_TERMINAL_KEY: 'derived' },
  service: {
    internalPort: 7681,
    ports: [{ port: 443, handlers: ['tls', 'http'] }],
    autostart: false,
    autostop: 'off',
  },
};

function config(overrides: Partial<AwsInstanceConfig> = {}): AwsInstanceConfig {
  return { ...instanceConfigOf(AWS_PERSISTENT_SPEC), ...overrides };
}

function refusal(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('renderInstanceUserData · parseInstanceUserData', () => {
  it('round-trips a config with and without a terminal block', () => {
    for (const c of [config(), config({ terminal: TERMINAL, idleCommand: null })]) {
      expect(parseInstanceUserData(renderInstanceUserData(c))).toEqual(c);
    }
  });

  it('is a multi-part whose cloud-config runs the script on every boot', () => {
    const text = renderInstanceUserData(config());
    expect(text).toMatch(/^Content-Type: multipart\/mixed; boundary=/);
    expect(text).toContain('#cloud-config\ncloud_final_modules:\n- [scripts-user, always]');
    expect(text).toContain('Content-Type: text/x-shellscript');
    expect(text).toContain(`#!/bin/bash\n${INSTANCE_CONFIG_MARKER}`);
  });

  it('re-reads the CURRENT user-data from IMDSv2, and boots from it fresh', () => {
    const text = renderInstanceUserData(config());
    expect(text).toContain(`-X PUT "$imds/api/token"`);
    expect(text).toContain(`-H "X-aws-ec2-metadata-token: $token" "$imds/user-data"`);
    expect(text).toContain(`base64 -d > ${PERSISTENT_CONFIG_FILE}`);
    expect(text).toContain(
      `blkid "$home_device" >/dev/null 2>&1 || mkfs.ext4 -q -L ${HOME_FILESYSTEM_LABEL} "$home_device"`,
    );
    expect(text).toContain(
      `mountpoint -q "$mount_path" || mount -L ${HOME_FILESYSTEM_LABEL} "$mount_path"`,
    );
    expect(text).toContain(`install -m 600 /dev/null ${PERSISTENT_ENV_FILE}`);
    expect(text).toContain('docker rm -f motir-instance');
    expect(text).toContain('"docker", "pull", c["image"]');
    // The script's own python never breaks out of its single quotes.
    for (const line of text.split('\n').filter((l) => l.startsWith("python3 -c '"))) {
      expect(line.slice("python3 -c '".length).split("'")).toHaveLength(2);
    }
  });

  it('carries values only inside the base64 document, never as script text', () => {
    const marker = 'SECRET-MARKER-9479';
    const text = renderInstanceUserData(
      config({ env: { TOKEN: marker }, terminal: { ...TERMINAL, env: { K: marker } } }),
    );
    expect(text).not.toContain(marker);
    expect(parseInstanceUserData(text).env).toEqual({ TOKEN: marker });
  });

  it('refuses a line break in a value, the image, the mount or a command — naming the key only', () => {
    const marker = 'SECRET-MARKER';
    for (const bad of [
      config({ env: { TOKEN: `${marker}\nEVIL=1` } }),
      config({ terminal: { ...TERMINAL, env: { MOTIR_TERMINAL_KEY: `a\r${marker}` } } }),
      config({ image: `img\n${marker}` }),
      config({ mountPath: `/home\r${marker}` }),
      config({ idleCommand: ['sleep', `1\n${marker}`] }),
      config({ terminal: { ...TERMINAL, command: [`x\n${marker}`] } }),
    ]) {
      const err = refusal(() => renderInstanceUserData(bad));
      expect(err).toBeInstanceOf(PersistentUserDataError);
      expect(err).toMatchObject({ reason: 'newline' });
      expect((err as Error).message).not.toContain(marker);
    }
    expect(
      refusal(() => renderInstanceUserData(config({ env: { 'BAD-KEY': 'v' } }))),
    ).toMatchObject({ reason: 'bad_key', key: 'BAD-KEY' });
  });

  it('refuses a payload over AWS’s 16 KB raw limit', () => {
    expect(
      refusal(() =>
        renderInstanceUserData(config({ env: { BIG: 'x'.repeat(USER_DATA_MAX_BYTES) } })),
      ),
    ).toMatchObject({ reason: 'too_large', key: null });
    expect(new PersistentUserDataError('too_large', null).message).toMatch(/16384-byte/);
  });

  it('refuses user-data that carries no readable document, without echoing it', () => {
    const marker = 'SECRET-MARKER-PARSE';
    const doc = (value: unknown) =>
      `${INSTANCE_CONFIG_MARKER}${Buffer.from(JSON.stringify(value)).toString('base64')}`;
    const good = JSON.parse(
      Buffer.from(
        renderInstanceUserData(config())
          .split('\n')
          .find((l) => l.startsWith(INSTANCE_CONFIG_MARKER))!
          .slice(INSTANCE_CONFIG_MARKER.length),
        'base64',
      ).toString(),
    ) as Record<string, unknown>;
    for (const text of [
      '',
      `#!/bin/bash\necho ${marker}\n`,
      `${INSTANCE_CONFIG_MARKER}${Buffer.from(`{${marker}`).toString('base64')}`,
      doc(null),
      doc({ ...good, image: 7 }),
      doc({ ...good, env: { A: 1 } }),
      doc({ ...good, env: [] }),
      doc({ ...good, idleCommand: 'sleep' }),
      doc({ ...good, terminal: { ...TERMINAL, version: '3' } }),
      doc({ ...good, terminal: { ...TERMINAL, service: null } }),
      doc({ ...good, terminal: 'yes' }),
    ]) {
      const err = refusal(() => parseInstanceUserData(text));
      expect(err).toMatchObject({ reason: 'unreadable', key: null });
      expect((err as Error).message).not.toContain(marker);
    }
  });
});

describe('instanceConfigOf', () => {
  it('takes the image, mount, env, idle command and terminal from the spec', () => {
    expect(instanceConfigOf({ ...AWS_PERSISTENT_SPEC, terminal: TERMINAL })).toEqual({
      image: AWS_PERSISTENT_SPEC.image,
      mountPath: '/home/node',
      env: AWS_PERSISTENT_SPEC.env,
      idleCommand: ['sleep', 'infinity'],
      terminal: TERMINAL,
      hostAgent: null,
    });
    expect(instanceConfigOf({ ...AWS_PERSISTENT_SPEC, idleCommand: undefined }).idleCommand).toBe(
      null,
    );
  });
});

describe('encodeInstanceUserData', () => {
  it('base64-encodes up to AWS’s 16 KB raw limit and refuses beyond it', () => {
    expect(Buffer.from(encodeInstanceUserData('#!/bin/bash\n'), 'base64').toString()).toBe(
      '#!/bin/bash\n',
    );
    expect(() => encodeInstanceUserData('x'.repeat(USER_DATA_MAX_BYTES + 1))).toThrow(
      expect.objectContaining({ reason: 'too_large', key: null }),
    );
  });
});

// THE MACHINE ID (MOTIR-10817). The terminal server refuses to start without a
// machine id and the relay's tokens bind it; Fly sets FLY_MACHINE_ID, EC2 sets
// nothing. These run the boot script's OWN bash and python — the metadata reads,
// the document decode and the env file — against a stand-in metadata service, so
// what is asserted is what the VM executes, not a substring of it. The disk,
// TLS and docker steps need a real VM and are cut out; `/etc/motir` is pointed at
// a temporary directory.
describe('the boot script gives the container the instance id as its machine id', () => {
  const INSTANCE_ID = 'i-00df27f5ec6ca138a';
  const TOKEN = 'imds-token-10817';
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The script's metadata, decode and env-file steps, runnable on this machine. */
  function runnableSteps(userData: string, etc: string): string {
    const script = userData.slice(userData.indexOf('#!/bin/bash'), userData.lastIndexOf('\n--'));
    const cut = (text: string, from: string, to: string | null): string => {
      const start = text.indexOf(from);
      expect(start).toBeGreaterThan(-1);
      const end = to === null ? text.length : text.indexOf(to, start);
      expect(end).toBeGreaterThan(start);
      return text.slice(0, start) + text.slice(end);
    };
    const steps = cut(cut(script, '# The home disk', '# The env file'), '# The agent, FRESH', null);
    return steps.replaceAll('/etc/motir', etc);
  }

  /** Boots `userData` once against a metadata service answering `instanceId`. */
  function boot(userData: string, instanceId: string) {
    const root = mkdtempSync(join(tmpdir(), 'motir-10817-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    const etc = join(root, 'etc-motir');
    writeFileSync(join(root, 'user-data'), userData);
    spawnSync('mkdir', ['-p', bin]);
    // A stand-in IMDSv2: a token on PUT, and every read refused without it.
    writeFileSync(
      join(bin, 'curl'),
      [
        '#!/bin/bash',
        'args="$*"',
        `case "$args" in *"-X PUT"*api/token*) printf '%s' '${TOKEN}'; exit 0;; esac`,
        `case "$args" in *"X-aws-ec2-metadata-token: ${TOKEN}"*) ;; *) exit 22;; esac`,
        'case "$args" in',
        `  *meta-data/instance-id*) printf '%s' "$FAKE_INSTANCE_ID";;`,
        `  *user-data*) cat ${JSON.stringify(join(root, 'user-data'))};;`,
        '  *) exit 22;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(join(bin, 'curl'), 0o755);
    const run = spawnSync('bash', ['-c', runnableSteps(userData, etc)], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env['PATH']}`, FAKE_INSTANCE_ID: instanceId },
    });
    const envFile = join(etc, 'instance.env');
    const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n') : null;
    return { status: run.status, stderr: run.stderr, lines };
  }

  const machineIdLines = (id: string) => MACHINE_ID_ENV_KEYS.map((k) => `${k}=${id}`);

  it('names the host-neutral key first, and Fly’s for images that read only that', () => {
    expect(MACHINE_ID_ENV_KEYS).toEqual(['MOTIR_MACHINE_ID', 'FLY_MACHINE_ID']);
  });

  it('reads instance-id from IMDSv2 with the boot’s token, and refuses an id that is not one', () => {
    const text = renderInstanceUserData(config());
    expect(text).toContain(`-H "X-aws-ec2-metadata-token: $token" "$imds/meta-data/instance-id"`);
    expect(text).toContain(`python3 -c '`);
    expect(text).toMatch(/python3 -c '[^\n]*' "\$instance_id" > \/etc\/motir\/instance\.env/);
  });

  it('on create: the env file carries the document’s env, the terminal’s, and the instance id', () => {
    const { status, stderr, lines } = boot(
      renderInstanceUserData(config({ terminal: TERMINAL, idleCommand: null })),
      INSTANCE_ID,
    );
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(lines).toEqual(
      expect.arrayContaining([
        'MOTIR_INSTANCE_ID=inst-contract-a',
        'MOTIR_TERMINAL_KEY=derived',
        ...machineIdLines(INSTANCE_ID),
      ]),
    );
  });

  it('a value the document carries under a machine-id key never stands in for the instance id', () => {
    const { status, lines } = boot(
      renderInstanceUserData(config({ env: { FLY_MACHINE_ID: 'forged', MOTIR_MACHINE_ID: 'x' } })),
      INSTANCE_ID,
    );
    expect(status).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(machineIdLines(INSTANCE_ID)));
    expect(lines).not.toContain('FLY_MACHINE_ID=forged');
    expect(lines).not.toContain('MOTIR_MACHINE_ID=x');
  });

  it('on wake, from a rewritten document: the same instance id, read again', () => {
    const created = boot(renderInstanceUserData(config()), INSTANCE_ID);
    const woken = boot(
      renderInstanceUserData(
        config({ terminal: { ...TERMINAL, keyId: 'kid-2' }, idleCommand: null }),
      ),
      INSTANCE_ID,
    );
    expect(created.lines).toEqual(expect.arrayContaining(machineIdLines(INSTANCE_ID)));
    expect(woken.status).toBe(0);
    expect(woken.lines).toEqual(expect.arrayContaining(machineIdLines(INSTANCE_ID)));
  });

  it.each(['', 'not-an-instance', 'i-00DF', `i-0abc\nEVIL=1`])(
    'stops the boot, before any env is written, when the metadata answers %j',
    (answer) => {
      const { status, stderr, lines } = boot(renderInstanceUserData(config()), answer);
      expect(status).not.toBe(0);
      expect(stderr).toContain('motir: no instance id');
      expect(lines).toBeNull();
    },
  );
});

// THE CONTAINER'S USER (MOTIR-10836). Every command Motir sends into an instance
// is `runuser -u node -- …`, which only root may call; the AWS host agent's
// `docker exec` runs as the CONTAINER's user, so the container starts as root and
// its main process drops to the image's user. These run the boot script's OWN
// container step against a stand-in `docker` that answers the image inspect and
// records every call — the argv asserted is the argv the VM would run.
describe('the boot script starts the container as root and drops to the image user', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const MOUNT = AWS_PERSISTENT_SPEC.mountPath;

  /** Runs the container step of `userData` against an image whose config is `imageConfig`. */
  function startContainer(userData: string, imageConfig: unknown) {
    const root = mkdtempSync(join(tmpdir(), 'motir-10836-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    const etc = join(root, 'etc-motir');
    spawnSync('mkdir', ['-p', bin, etc]);
    const document = parseInstanceUserData(userData);
    writeFileSync(join(etc, 'instance.json'), JSON.stringify(document));
    writeFileSync(join(root, 'image-config.json'), JSON.stringify(imageConfig));
    // Each call is one JSON line: its argv.
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/usr/bin/env python3',
        'import json, sys',
        `open(${JSON.stringify(join(root, 'calls'))}, "a").write(json.dumps(sys.argv[1:]) + "\\n")`,
        'if sys.argv[1:3] == ["image", "inspect"]:',
        `    sys.stdout.write(open(${JSON.stringify(join(root, 'image-config.json'))}).read())`,
      ].join('\n'),
    );
    chmodSync(join(bin, 'docker'), 0o755);
    const script = userData.slice(userData.indexOf('#!/bin/bash'), userData.lastIndexOf('\n--'));
    const step = script.slice(script.indexOf('# The agent, FRESH')).replaceAll('/etc/motir', etc);
    const run = spawnSync('bash', ['-c', `set -euo pipefail\n${step}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` },
    });
    const callsFile = join(root, 'calls');
    const calls: string[][] = existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[])
      : [];
    return { status: run.status, stderr: run.stderr, calls, etc };
  }

  const SANDBOX_IMAGE = {
    User: 'node',
    Entrypoint: ['motir-sandbox-entrypoint'],
    Cmd: ['bash', '-l'],
  };

  it('an image with a user: run as root, the drop script owning the home and becoming the user', () => {
    const { status, stderr, calls, etc } = startContainer(
      renderInstanceUserData(config({ terminal: TERMINAL, idleCommand: null })),
      SANDBOX_IMAGE,
    );
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const image = AWS_PERSISTENT_SPEC.image;
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['rm', '-f'],
      ['pull', image],
      ['image', 'inspect'],
      ['run', '-d'],
    ]);
    expect(calls[2]).toEqual(['image', 'inspect', '--format', '{{json .Config}}', image]);
    expect(calls[3]).toEqual([
      'run',
      '-d',
      '--name',
      'motir-instance',
      '--restart',
      'no',
      '--env-file',
      join(etc, 'instance.env'),
      '-v',
      `${MOUNT}:${MOUNT}`,
      '--user',
      '0',
      '--entrypoint',
      'sh',
      image,
      '-c',
      DROP_TO_IMAGE_USER_SH,
      DROP_TO_IMAGE_USER_ARGV0,
      'node',
      MOUNT,
      'motir-sandbox-entrypoint',
      ...TERMINAL.command,
    ]);
  });

  it('keeps the image’s default command when the document names none', () => {
    const { status, calls } = startContainer(
      renderInstanceUserData(config({ terminal: null, idleCommand: null })),
      { ...SANDBOX_IMAGE, User: '1000:1000' },
    );
    expect(status).toBe(0);
    const run = calls.at(-1)!;
    expect(run.slice(-5)).toEqual(['1000', MOUNT, 'motir-sandbox-entrypoint', 'bash', '-l']);
  });

  it('runs an idle command under the image’s entrypoint, and an image with no entrypoint without one', () => {
    const idle = ['sleep', 'infinity'];
    const withEntrypoint = startContainer(
      renderInstanceUserData(config({ terminal: null, idleCommand: idle })),
      SANDBOX_IMAGE,
    );
    expect(withEntrypoint.calls.at(-1)!.slice(-3)).toEqual(['motir-sandbox-entrypoint', ...idle]);
    const bare = startContainer(
      renderInstanceUserData(config({ terminal: null, idleCommand: idle })),
      { User: 'node', Entrypoint: null, Cmd: null },
    );
    expect(bare.calls.at(-1)!.slice(-4)).toEqual(['node', MOUNT, ...idle]);
  });

  it.each([{ User: '' }, { User: 'root' }, { User: '0:0' }, null])(
    'an image that runs as root (%j) starts exactly as before, with no wrapper',
    (imageConfig) => {
      const { status, calls } = startContainer(
        renderInstanceUserData(config({ terminal: TERMINAL, idleCommand: null })),
        imageConfig,
      );
      expect(status).toBe(0);
      const run = calls.at(-1)!;
      expect(run).not.toContain('--user');
      expect(run).not.toContain('--entrypoint');
      expect(run.slice(-(TERMINAL.command.length + 1))).toEqual([
        AWS_PERSISTENT_SPEC.image,
        ...TERMINAL.command,
      ]);
    },
  );

  it('stops the boot, with no container started, when the image cannot be inspected', () => {
    const root = mkdtempSync(join(tmpdir(), 'motir-10836-'));
    dirs.push(root);
    const userData = renderInstanceUserData(config());
    const { status, calls } = startContainer(userData, 'not json {');
    expect(status).not.toBe(0);
    expect(calls.map((c) => c[0])).not.toContain('run');
  });
});

// THE DROP SCRIPT ITSELF, against stand-ins for getent, chown and runuser — what
// it resolves, what it chowns, and what it execs.
describe('DROP_TO_IMAGE_USER_SH', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function drop(user: string, passwd: string) {
    const root = mkdtempSync(join(tmpdir(), 'motir-10836-drop-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    const log = join(root, 'log');
    spawnSync('mkdir', ['-p', bin]);
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    writeFileSync(join(root, 'passwd'), passwd);
    stub(
      'getent',
      `awk -F: -v k="$2" '$1 == k || $3 == k' ${JSON.stringify(join(root, 'passwd'))}`,
    );
    stub('chown', `echo "chown $*" >> ${JSON.stringify(log)}`);
    stub('runuser', `echo "runuser $*" >> ${JSON.stringify(log)}`);
    const run = spawnSync(
      'sh',
      [
        '-c',
        DROP_TO_IMAGE_USER_SH,
        DROP_TO_IMAGE_USER_ARGV0,
        user,
        '/home/node',
        'motir-sandbox-entrypoint',
        'sh',
        '-c',
        'exec motir agent-terminal serve',
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` } },
    );
    const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { status: run.status, stderr: run.stderr, lines };
  }

  const PASSWD = 'root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n';

  it.each(['node', '1000'])(
    'resolves %j to the name, owns the home to it, and execs as it',
    (user) => {
      const { status, stderr, lines } = drop(user, PASSWD);
      expect(stderr).toBe('');
      expect(status).toBe(0);
      expect(lines).toEqual([
        'chown node: /home/node',
        'runuser -u node -- motir-sandbox-entrypoint sh -c exec motir agent-terminal serve',
      ]);
    },
  );

  it('refuses a user the image does not know, rather than run as root', () => {
    const { status, stderr, lines } = drop('ghost', PASSWD);
    expect(status).not.toBe(0);
    expect(stderr).toContain('motir: the image user ghost has no passwd entry');
    expect(lines).toEqual([]);
  });
});
