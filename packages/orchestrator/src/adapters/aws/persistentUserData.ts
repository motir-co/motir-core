import type { PersistentContainerSpec, PersistentTerminalConfig } from '../../types';
import { USER_DATA_MAX_BYTES } from './userData';

// An agent instance's USER-DATA on EC2 (Story MOTIR-9361 · MOTIR-9469, MOTIR-9479):
// the instance's whole config as ONE parseable document, and the script that
// boots it on EVERY start.
//
// A Fly machine keeps its main process, env, image and terminal service in the
// provider's machine config, which the port rewrites. EC2 has no such record, so
// on AWS the config lives in the instance's user-data — the one per-instance
// value a STOPPED instance can have replaced (ModifyInstanceAttribute `UserData`,
// "you can only modify the user data of an instance that is stopped",
// https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html#user-data-view-change).
// The document is a base64 JSON line inside the script, so
// `parseInstanceUserData(renderInstanceUserData(config))` is `config` again, and a
// rewrite is read · replace one field · write, never a config rebuilt from Motir's
// record.
//
// The user-data is a MIME multi-part: a cloud-config part that sets
// `scripts-user` to `always`, so cloud-init runs the shell part on every boot
// rather than only the first ("Run commands on your Linux instance at launch" →
// running on every restart,
// https://repost.aws/knowledge-center/execute-user-data-ec2), and the shell part
// itself. That part does NOT trust what cloud-init cached: it re-reads the CURRENT
// user-data from the instance metadata service (IMDSv2, token first — the launch
// requires tokens and a hop limit of 1, so no container reaches it), then
//
//   1. formats the home disk ONLY if it holds no filesystem, and mounts it;
//   2. writes the env (the spec's, the terminal's merged over it) to a mode-600 file;
//   3. starts the image FRESH — the previous boot's container is removed — with
//      the home mounted, as the terminal's command or the idle command.
//
// That is the port's rule that a wake is a cold boot with the volume intact, and
// it is what makes a rewritten document take effect at the next start.
//
// ⚠️ THE ENV CAN CARRY A SECRET (the terminal key). No refusal names a value —
// only the key — and nothing here logs the payload. A value with a line break
// would forge a second env line, so it is refused, not escaped.

/** Where the boot script writes the instance's env. */
export const PERSISTENT_ENV_FILE = '/etc/motir/instance.env';

/** Where the boot script keeps the decoded config document (mode 600). */
export const PERSISTENT_CONFIG_FILE = '/etc/motir/instance.json';

/** The container's name on the VM — one per instance. */
export const PERSISTENT_CONTAINER_NAME = 'motir-instance';

/** The filesystem label the home disk is formatted with, and mounted by. */
export const HOME_FILESYSTEM_LABEL = 'motir-home';

/** Where the boot script writes the host agent's TLS files (MOTIR-9470), mode 600. */
export const HOST_AGENT_TLS_DIR = '/etc/motir/host-agent';

/** The script line that carries the config document. */
export const INSTANCE_CONFIG_MARKER = '# motir-instance-config: ';

/** The MIME boundary between the cloud-config part and the script. */
const MIME_BOUNDARY = 'MOTIR-INSTANCE-USER-DATA';

/** The device names the home disk can appear under (Xen, then Nitro NVMe). */
const HOME_DEVICE_CANDIDATES = ['/dev/sdf', '/dev/xvdf', '/dev/nvme1n1'];

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Everything an AWS agent instance boots from — the document the user-data
 * carries, and the only record of the machine's configuration.
 */
export interface AwsInstanceConfig {
  /** OCI image ref, digest-pinned. */
  readonly image: string;
  /** Where the home disk is mounted. */
  readonly mountPath: string;
  readonly env: Readonly<Record<string, string>>;
  /** The main process when {@link terminal} is null; null keeps the image's `CMD`. */
  readonly idleCommand: readonly string[] | null;
  readonly terminal: PersistentTerminalConfig | null;
  /**
   * The host agent's TLS material (MOTIR-9470): the instance's own server
   * certificate and key, minted at provision, and the Motir hoster CA it verifies
   * client certificates against. Null on a document written before the reach
   * channel. The key is a SECRET: it lives here and in the mode-600 file the boot
   * script writes, nowhere else.
   */
  readonly hostAgent: AwsHostAgentTlsFiles | null;
}

/** The host agent's server certificate, key and trusted CA, PEM. */
export interface AwsHostAgentTlsFiles {
  readonly certPem: string;
  readonly keyPem: string;
  readonly caPem: string;
}

/** A config the user-data cannot carry, or user-data that carries none.
 *  `key` names the offender, never a value. */
export class PersistentUserDataError extends Error {
  readonly code = 'AWS_PERSISTENT_USER_DATA_REFUSED' as const;
  constructor(
    readonly reason: 'newline' | 'bad_key' | 'too_large' | 'unreadable',
    readonly key: string | null,
  ) {
    super(
      reason === 'too_large'
        ? `The agent instance's user-data is over AWS's ${USER_DATA_MAX_BYTES}-byte limit.`
        : reason === 'bad_key'
          ? `The agent instance's env key ${key} is not a valid variable name.`
          : reason === 'unreadable'
            ? "The agent instance's user-data holds no readable config document."
            : `The agent instance's ${key} holds a line break (the value is not shown).`,
    );
    this.name = 'PersistentUserDataError';
  }
}

/** The config document a new instance is launched with. */
export function instanceConfigOf(
  spec: PersistentContainerSpec,
  hostAgent: AwsHostAgentTlsFiles | null = null,
): AwsInstanceConfig {
  return {
    image: spec.image,
    mountPath: spec.mountPath,
    env: { ...spec.env },
    idleCommand: spec.idleCommand ? [...spec.idleCommand] : null,
    terminal: spec.terminal,
    hostAgent,
  };
}

function refuseNewline(key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new PersistentUserDataError('newline', key);
}

function validate(config: AwsInstanceConfig): void {
  const env = { ...config.env, ...(config.terminal?.env ?? {}) };
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_PATTERN.test(key)) throw new PersistentUserDataError('bad_key', key);
    refuseNewline(key, value);
  }
  refuseNewline('image', config.image);
  refuseNewline('mountPath', config.mountPath);
  (config.terminal?.command ?? []).forEach((arg, i) =>
    refuseNewline(`terminal.command[${i}]`, arg),
  );
  (config.idleCommand ?? []).forEach((arg, i) => refuseNewline(`idleCommand[${i}]`, arg));
}

// The boot steps that read the document. Python 3 is on the hoster AMI (Amazon
// Linux 2023 ships it), and argv goes to docker as a list — never through a shell.
const WRITE_ENV_PY = [
  'import json, sys',
  `c = json.load(open(${JSON.stringify(PERSISTENT_CONFIG_FILE)}))`,
  'env = {**c["env"], **((c.get("terminal") or {}).get("env") or {})}',
  'sys.stdout.write("".join(f"{k}={v}\\n" for k, v in env.items()))',
].join('; ');

/** Writes the host agent's TLS files from the document, each created mode 600. */
const WRITE_TLS_PY = [
  'import json, os',
  `c = json.load(open(${JSON.stringify(PERSISTENT_CONFIG_FILE)}))`,
  'h = c.get("hostAgent") or {}',
  'for name, key in (("server.crt", "certPem"), ("server.key", "keyPem"), ("ca.crt", "caPem")):',
  '    if key in h:',
  `        fd = os.open(${JSON.stringify(HOST_AGENT_TLS_DIR + '/')} + name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)`,
  '        os.fdopen(fd, "w").write(h[key])',
].join('\n');

const RUN_PY = [
  'import json, os, subprocess',
  `c = json.load(open(${JSON.stringify(PERSISTENT_CONFIG_FILE)}))`,
  'cmd = (c.get("terminal") or {}).get("command") or c.get("idleCommand") or []',
  'm = c["mountPath"]',
  'subprocess.run(["docker", "pull", c["image"]], check=True)',
  `os.execvp("docker", ["docker", "run", "-d", "--name", ${JSON.stringify(PERSISTENT_CONTAINER_NAME)}, "--restart", "no", "--env-file", ${JSON.stringify(PERSISTENT_ENV_FILE)}, "-v", m + ":" + m, c["image"], *cmd])`,
].join('; ');

/** The per-boot script, carrying `document` (base64 JSON) on its marker line. */
function bootScript(document: string): string {
  return [
    '#!/bin/bash',
    `${INSTANCE_CONFIG_MARKER}${document}`,
    'set -euo pipefail',
    'umask 077',
    '',
    '# The CURRENT config: the user-data as it is now, from the metadata service.',
    'imds=http://169.254.169.254/latest',
    `token=$(curl -fsS -X PUT "$imds/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')`,
    `config=$(curl -fsS -H "X-aws-ec2-metadata-token: $token" "$imds/user-data" | sed -n 's/^${INSTANCE_CONFIG_MARKER}//p' | head -n 1)`,
    '[ -n "$config" ] || { echo "motir: no instance config" >&2; exit 1; }',
    `install -d -m 700 /etc/motir`,
    `printf '%s' "$config" | base64 -d > ${PERSISTENT_CONFIG_FILE}`,
    `mount_path=$(python3 -c 'import json; print(json.load(open("${PERSISTENT_CONFIG_FILE}"))["mountPath"])')`,
    '',
    '# The home disk: format only when it holds no filesystem, then mount it.',
    'home_device=""',
    'for _ in $(seq 1 60); do',
    `  for candidate in ${HOME_DEVICE_CANDIDATES.join(' ')}; do`,
    '    if [ -b "$candidate" ]; then home_device="$candidate"; break 2; fi',
    '  done',
    '  sleep 1',
    'done',
    '[ -n "$home_device" ] || { echo "motir: no home disk" >&2; exit 1; }',
    `blkid "$home_device" >/dev/null 2>&1 || mkfs.ext4 -q -L ${HOME_FILESYSTEM_LABEL} "$home_device"`,
    'mkdir -p "$mount_path"',
    `mountpoint -q "$mount_path" || mount -L ${HOME_FILESYSTEM_LABEL} "$mount_path"`,
    '',
    "# The host agent's TLS files — mode 600, read by the agent on 8443.",
    `install -d -m 700 ${HOST_AGENT_TLS_DIR}`,
    "python3 - <<'MOTIR_TLS'",
    WRITE_TLS_PY,
    'MOTIR_TLS',
    '',
    '# The env file — mode 600, written before any byte of it.',
    `install -m 600 /dev/null ${PERSISTENT_ENV_FILE}`,
    `python3 -c '${WRITE_ENV_PY}' > ${PERSISTENT_ENV_FILE}`,
    '',
    '# The agent, FRESH on every boot: the pinned image, the home mounted.',
    `docker rm -f ${PERSISTENT_CONTAINER_NAME} >/dev/null 2>&1 || true`,
    `python3 -c '${RUN_PY}'`,
    '',
  ].join('\n');
}

/**
 * The user-data for `config` — raw text, not yet base64 for RunInstances. Refuses
 * a line break in a value, a bad env key, or a payload over AWS's 16 KB limit,
 * before any EC2 call.
 */
export function renderInstanceUserData(config: AwsInstanceConfig): string {
  validate(config);
  const document = Buffer.from(
    JSON.stringify({
      image: config.image,
      mountPath: config.mountPath,
      env: config.env,
      idleCommand: config.idleCommand,
      terminal: config.terminal,
      hostAgent: config.hostAgent,
    }),
    'utf8',
  ).toString('base64');
  const text = [
    `Content-Type: multipart/mixed; boundary="${MIME_BOUNDARY}"`,
    'MIME-Version: 1.0',
    '',
    `--${MIME_BOUNDARY}`,
    'Content-Type: text/cloud-config; charset="us-ascii"',
    'MIME-Version: 1.0',
    'Content-Disposition: attachment; filename="cloud-config.txt"',
    '',
    '#cloud-config',
    'cloud_final_modules:',
    '- [scripts-user, always]',
    '',
    `--${MIME_BOUNDARY}`,
    'Content-Type: text/x-shellscript; charset="us-ascii"',
    'MIME-Version: 1.0',
    'Content-Disposition: attachment; filename="motir-instance.sh"',
    '',
    bootScript(document),
    `--${MIME_BOUNDARY}--`,
    '',
  ].join('\n');
  if (Buffer.byteLength(text, 'utf8') > USER_DATA_MAX_BYTES) {
    throw new PersistentUserDataError('too_large', null);
  }
  return text;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isTerminal(value: unknown): value is PersistentTerminalConfig {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t['version'] === 'number' &&
    typeof t['keyId'] === 'string' &&
    isStringList(t['command']) &&
    isStringRecord(t['env']) &&
    typeof t['service'] === 'object' &&
    t['service'] !== null
  );
}

function isHostAgentTls(value: unknown): value is AwsHostAgentTlsFiles {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Record<string, unknown>;
  return ['certPem', 'keyPem', 'caPem'].every((k) => typeof h[k] === 'string');
}

/** The config document `text` (raw user-data) carries. Unreadable user-data is
 *  refused; the error never holds the text. */
export function parseInstanceUserData(text: string): AwsInstanceConfig {
  const line = text.split('\n').find((l) => l.startsWith(INSTANCE_CONFIG_MARKER));
  if (!line) throw new PersistentUserDataError('unreadable', null);
  let doc: unknown;
  try {
    doc = JSON.parse(
      Buffer.from(line.slice(INSTANCE_CONFIG_MARKER.length), 'base64').toString('utf8'),
    );
  } catch {
    throw new PersistentUserDataError('unreadable', null);
  }
  const d = (typeof doc === 'object' && doc !== null ? doc : {}) as Record<string, unknown>;
  const { image, mountPath, env, idleCommand, terminal } = d;
  const hostAgent = d['hostAgent'] ?? null;
  if (
    typeof image !== 'string' ||
    typeof mountPath !== 'string' ||
    !isStringRecord(env) ||
    !(idleCommand === null || isStringList(idleCommand)) ||
    !(terminal === null || isTerminal(terminal)) ||
    !(hostAgent === null || isHostAgentTls(hostAgent))
  ) {
    throw new PersistentUserDataError('unreadable', null);
  }
  return { image, mountPath, env, idleCommand, terminal, hostAgent };
}

/** The base64 `UserData` for RunInstances, refused above AWS's 16 KB raw limit. */
export function encodeInstanceUserData(userData: string): string {
  const raw = Buffer.from(userData, 'utf8');
  if (raw.length > USER_DATA_MAX_BYTES) throw new PersistentUserDataError('too_large', null);
  return raw.toString('base64');
}
