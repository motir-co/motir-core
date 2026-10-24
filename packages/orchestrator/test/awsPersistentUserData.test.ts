import { describe, expect, it } from 'vitest';
import {
  HOME_FILESYSTEM_LABEL,
  PERSISTENT_ENV_FILE,
  PersistentUserDataError,
  USER_DATA_MAX_BYTES,
  buildInstanceUserData,
  encodeInstanceUserData,
  type PersistentContainerSpec,
} from '../src/index';
import { AWS_PERSISTENT_SPEC } from './contract/awsPersistentHarness';

// An agent instance's first-boot script (Story MOTIR-9361 · MOTIR-9469): what it
// formats, mounts, writes and starts, and what it refuses before any EC2 call.

function spec(overrides: Partial<PersistentContainerSpec> = {}): PersistentContainerSpec {
  return { ...AWS_PERSISTENT_SPEC, ...overrides };
}

describe('buildInstanceUserData', () => {
  it('formats the home disk only when blank, mounts it by label, and keeps it in fstab', () => {
    const script = buildInstanceUserData(spec());
    expect(script.startsWith('#!/bin/bash\nset -euo pipefail\n')).toBe(true);
    expect(script).toContain(
      `blkid "$home_device" >/dev/null 2>&1 || mkfs.ext4 -q -L ${HOME_FILESYSTEM_LABEL} "$home_device"`,
    );
    expect(script).toContain(`LABEL=${HOME_FILESYSTEM_LABEL} /home/node ext4 defaults,nofail 0 2`);
    expect(script).toContain(`mountpoint -q '/home/node' || mount '/home/node'`);
  });

  it('writes the env and the terminal env to a mode-600 file, and starts the pinned image on it', () => {
    const script = buildInstanceUserData(
      spec({
        env: { MOTIR_INSTANCE_ID: 'inst-1' },
        terminal: {
          version: 1,
          keyId: 'kid',
          command: ['sh', '-c', "exec motir agent-terminal serve 'x'"],
          env: { MOTIR_TERMINAL_KEY: 'derived' },
          service: { internalPort: 7681, ports: [], autostart: false, autostop: 'off' },
        },
      }),
    );
    expect(script).toContain(`install -m 600 /dev/null '${PERSISTENT_ENV_FILE}'`);
    expect(script).toContain('MOTIR_INSTANCE_ID=inst-1\nMOTIR_TERMINAL_KEY=derived\nMOTIR_ENV');
    expect(script).toContain(
      `docker run -d --name motir-instance --restart unless-stopped --env-file '${PERSISTENT_ENV_FILE}' -v '/home/node:/home/node' '${AWS_PERSISTENT_SPEC.image}' 'sh' '-c' 'exec motir agent-terminal serve '\\''x'\\'''`,
    );
  });

  it('runs the idle command with no terminal, and the image’s own CMD with neither', () => {
    expect(buildInstanceUserData(spec({ idleCommand: ['sleep', 'infinity'] }))).toMatch(
      /' 'sleep' 'infinity'\n$/,
    );
    const bare = buildInstanceUserData(spec({ idleCommand: null, env: {} }));
    expect(bare).toMatch(
      new RegExp(`'${AWS_PERSISTENT_SPEC.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\n$`),
    );
    expect(bare).toContain("<<'MOTIR_ENV'\nMOTIR_ENV");
  });

  it('refuses a line break in a value, the image, the mount or the command — naming the key only', () => {
    const marker = 'SECRET-MARKER';
    for (const bad of [
      spec({ env: { TOKEN: `${marker}\nEVIL=1` } }),
      spec({ image: `img\n${marker}` }),
      spec({ mountPath: `/home\r${marker}` }),
      spec({ idleCommand: ['sleep', `1\n${marker}`] }),
    ]) {
      const err = (() => {
        try {
          buildInstanceUserData(bad);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(err).toBeInstanceOf(PersistentUserDataError);
      expect(err).toMatchObject({ reason: 'newline' });
      expect((err as Error).message).not.toContain(marker);
    }
    expect(() => buildInstanceUserData(spec({ env: { 'BAD-KEY': 'v' } }))).toThrow(
      expect.objectContaining({ reason: 'bad_key', key: 'BAD-KEY' }),
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
    expect(new PersistentUserDataError('too_large', null).message).toMatch(/16384-byte/);
  });
});
