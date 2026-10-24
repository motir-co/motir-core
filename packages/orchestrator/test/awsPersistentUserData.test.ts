import { describe, expect, it } from 'vitest';
import {
  HOME_FILESYSTEM_LABEL,
  INSTANCE_CONFIG_MARKER,
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
