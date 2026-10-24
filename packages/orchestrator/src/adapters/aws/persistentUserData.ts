import type { PersistentContainerSpec } from '../../types';
import { USER_DATA_MAX_BYTES } from './userData';

// An agent instance's FIRST-BOOT SCRIPT on EC2 (Story MOTIR-9361 · MOTIR-9469):
// the user-data the hoster AMI runs once, at the first boot of the instance.
//
//   1. Find the home disk (the second EBS mapping, `/dev/sdf`, which a Nitro
//      instance names `/dev/nvme1n1`), format it ONLY if it holds no filesystem,
//      and mount it at `spec.mountPath` — with an fstab line, so every later boot
//      (a wake) mounts the same disk again.
//   2. Write `spec.env` (and `spec.terminal.env`) to a mode-600 env file.
//   3. Start the digest-pinned `spec.image` with that mount and that env file,
//      `--restart unless-stopped`, so a wake (an EC2 start) brings it back.
//
// ⚠️ THE ENV CAN CARRY A SECRET (the terminal key). No refusal names a value —
// only the key — and nothing here logs the payload. A value with a newline
// would forge a second env line, so it is refused, not escaped.

/** Where the AMI's boot script writes the instance's env. */
export const PERSISTENT_ENV_FILE = '/etc/motir/instance.env';

/** The container's name on the VM — one per instance. */
export const PERSISTENT_CONTAINER_NAME = 'motir-instance';

/** The filesystem label the home disk is formatted with, and mounted by. */
export const HOME_FILESYSTEM_LABEL = 'motir-home';

/** The device names the home disk can appear under (Xen, then Nitro NVMe). */
const HOME_DEVICE_CANDIDATES = ['/dev/sdf', '/dev/xvdf', '/dev/nvme1n1'];

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A spec the first-boot script cannot carry. `key` names the offender, never a value. */
export class PersistentUserDataError extends Error {
  readonly code = 'AWS_PERSISTENT_USER_DATA_REFUSED' as const;
  constructor(
    readonly reason: 'newline' | 'bad_key' | 'too_large',
    readonly key: string | null,
  ) {
    super(
      reason === 'too_large'
        ? `The agent instance's user-data is over AWS's ${USER_DATA_MAX_BYTES}-byte limit.`
        : reason === 'bad_key'
          ? `The agent instance's env key ${key} is not a valid variable name.`
          : `The agent instance's ${key} holds a line break (the value is not shown).`,
    );
    this.name = 'PersistentUserDataError';
  }
}

/** One argument, single-quoted for `sh`. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function refuseNewline(key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new PersistentUserDataError('newline', key);
}

/** The first-boot script for `spec`, or a refusal. Not encoded. */
export function buildInstanceUserData(spec: PersistentContainerSpec): string {
  const env: Record<string, string> = { ...spec.env, ...(spec.terminal?.env ?? {}) };
  const envLines = Object.entries(env).map(([key, value]) => {
    if (!ENV_KEY_PATTERN.test(key)) throw new PersistentUserDataError('bad_key', key);
    refuseNewline(key, value);
    return `${key}=${value}`;
  });
  refuseNewline('image', spec.image);
  refuseNewline('mountPath', spec.mountPath);
  const command = spec.terminal?.command ?? spec.idleCommand ?? [];
  command.forEach((arg, i) => refuseNewline(`command[${i}]`, arg));

  const mount = quote(spec.mountPath);
  const envBody = envLines.length > 0 ? `${envLines.join('\n')}\n` : '';
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    '# The home disk: format only when it holds no filesystem, then mount it.',
    'home_device=""',
    `for _ in $(seq 1 60); do`,
    `  for candidate in ${HOME_DEVICE_CANDIDATES.join(' ')}; do`,
    '    if [ -b "$candidate" ]; then home_device="$candidate"; break 2; fi',
    '  done',
    '  sleep 1',
    'done',
    '[ -n "$home_device" ] || { echo "motir: no home disk" >&2; exit 1; }',
    `blkid "$home_device" >/dev/null 2>&1 || mkfs.ext4 -q -L ${HOME_FILESYSTEM_LABEL} "$home_device"`,
    `mkdir -p ${mount}`,
    `grep -q 'LABEL=${HOME_FILESYSTEM_LABEL} ' /etc/fstab || echo 'LABEL=${HOME_FILESYSTEM_LABEL} ${spec.mountPath.replace(/'/g, '')} ext4 defaults,nofail 0 2' >> /etc/fstab`,
    `mountpoint -q ${mount} || mount ${mount}`,
    '',
    '# The env file — mode 600, written before any byte of it.',
    `install -d -m 700 ${quote(PERSISTENT_ENV_FILE.replace(/\/[^/]+$/, ''))}`,
    `install -m 600 /dev/null ${quote(PERSISTENT_ENV_FILE)}`,
    `cat > ${quote(PERSISTENT_ENV_FILE)} <<'MOTIR_ENV'`,
    `${envBody}MOTIR_ENV`,
    '',
    '# The agent: the digest-pinned image, the home mounted, started on every boot.',
    [
      'docker run -d',
      `--name ${PERSISTENT_CONTAINER_NAME}`,
      '--restart unless-stopped',
      `--env-file ${quote(PERSISTENT_ENV_FILE)}`,
      `-v ${quote(`${spec.mountPath}:${spec.mountPath}`)}`,
      quote(spec.image),
      ...command.map(quote),
    ].join(' '),
    '',
  ].join('\n');
}

/** The base64 `UserData` for RunInstances, refused above AWS's 16 KB raw limit. */
export function encodeInstanceUserData(userData: string): string {
  const raw = Buffer.from(userData, 'utf8');
  if (raw.length > USER_DATA_MAX_BYTES) throw new PersistentUserDataError('too_large', null);
  return raw.toString('base64');
}
