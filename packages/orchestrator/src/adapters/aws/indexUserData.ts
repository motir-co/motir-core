import { parseImageReference } from '../../imagePull';

// The INDEXER's user-data (Story MOTIR-9360 · MOTIR-9446) — the boot script a
// `code_graph_index` VM runs. Unlike the runner, it does not boot a Motir AMI with
// a boot hook: it boots a stock Docker host, pulls the pinned indexer image BY
// DIGEST, and runs it with the spec's env.
//
// THE AMI is the Amazon ECS-optimized Amazon Linux 2023 AMI (x86_64), passed in as
// `indexerAmiId` (`MOTIR_AWS_INDEXER_AMI_ID`). AWS publishes the current id per
// region at the public SSM parameter
// `/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id`. It was
// chosen because Docker is preinstalled and kept patched by AWS: no package
// install at boot (which would add minutes and a dependency on a package mirror
// to every index run), and no AMI of our own to bake and keep current. The ECS
// agent it also carries is stopped first: this VM joins no cluster.
//
// THE PULL-FAILURE CHANNEL is the serial console. The VM has no inbound rule and
// no instance profile, so it cannot call any AWS API. It can write to its own
// console, and `GetConsoleOutput` reads that console with the adapter's own key.
// When the pull fails, the script writes ONE line, {@link AWS_INDEX_PULL_FAILED_MARKER},
// to the console and powers off. The adapter's `describe` reads the console of a
// stopped index VM and reports `imagePullFailed`. Every other line of the script,
// the container's own output included, goes to a log file on the VM, never the
// console. That way an indexed repository's content cannot forge the marker, and
// the exit-code channel stays free for its own card.
//
// ⚠️ THE PAYLOAD CARRIES THE RUN CREDENTIAL and two pre-signed URLs. Nothing here
// logs it, and no refusal names a value: it names the KEY only. IMDSv2 with a hop
// limit of 1 (set on every launch) keeps the container off the metadata service,
// which serves the user-data.

/** The console line an index VM writes when it cannot pull its image. */
export const AWS_INDEX_PULL_FAILED_MARKER = 'MOTIR_INDEX_BOOT: image_pull_failed';

/** The comment line naming the image the script pulls. The fake EC2 reads it to
 *  decide whether the pull succeeds; nothing in AWS does. */
export const AWS_INDEX_IMAGE_COMMENT = '# motir-index-image: ';

/** What `docker --env-file` takes as a variable name. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The characters a digest reference is made of. Anything else in a value that
 *  sits in single quotes in a shell script is refused rather than escaped. */
const IMAGE_PATTERN = /^[A-Za-z0-9./:@_-]+$/;

/** Ends the env heredoc. Quoted where it opens, so nothing in it is expanded. */
const ENV_DELIMITER = 'MOTIR_INDEX_ENV';

/** An index spec the VM cannot take. Names the key or the reason, never a value. */
export class IndexUserDataError extends Error {
  readonly code = 'AWS_INDEX_USER_DATA_REFUSED' as const;
  constructor(
    readonly reason: 'image_not_digest' | 'bad_key' | 'bad_value',
    readonly key: string | null,
  ) {
    super(
      reason === 'image_not_digest'
        ? 'The indexer image must be pinned by digest (…@sha256:…) to boot on AWS; a tag is refused.'
        : reason === 'bad_key'
          ? `The index env key ${key} is not a valid variable name.`
          : `The index env value for ${key} holds a line break or NUL (the value is not shown).`,
    );
    this.name = 'IndexUserDataError';
  }
}

/**
 * Refuse an image that is not pinned by digest — before any EC2 call, so a tag
 * never boots a VM that pulls whatever the tag points at today.
 */
export function requireIndexImageDigest(image: string): string {
  const parsed = parseImageReference(image);
  if (!parsed?.isDigest || !IMAGE_PATTERN.test(image)) {
    throw new IndexUserDataError('image_not_digest', null);
  }
  return image;
}

/** The env file's lines, `KEY=value`, each refused rather than escaped. */
function envLines(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).map(([key, value]) => {
    if (!ENV_KEY_PATTERN.test(key)) throw new IndexUserDataError('bad_key', key);
    // A line break would end the variable early, or close the heredoc.
    if (/[\r\n\0]/.test(value)) throw new IndexUserDataError('bad_value', key);
    return `${key}=${value}`;
  });
}

/** The boot script for one index VM: pull by digest, run, power off. */
export function buildIndexUserData(spec: {
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
}): string {
  const image = requireIndexImageDigest(spec.image);
  return [
    '#!/bin/bash',
    `${AWS_INDEX_IMAGE_COMMENT}${image}`,
    'set -u',
    'console() { echo "$1" >/dev/ttyS0 2>/dev/null || echo "$1" >/dev/console; }',
    // Everything below stays off the console: only the marker may reach it.
    'exec >>/var/log/motir-index-boot.log 2>&1',
    'systemctl disable --now ecs || true',
    'systemctl start docker',
    'umask 077',
    `cat >/run/motir-index.env <<'${ENV_DELIMITER}'`,
    ...envLines(spec.env),
    ENV_DELIMITER,
    `IMAGE='${image}'`,
    'if ! docker pull "$IMAGE"; then',
    `  console '${AWS_INDEX_PULL_FAILED_MARKER}'`,
    '  shutdown -h now',
    '  exit 0',
    'fi',
    'docker run --rm --env-file /run/motir-index.env "$IMAGE"',
    'shutdown -h now',
    '',
  ].join('\n');
}

/** Whether a console read holds the pull-failure marker on a line of its own. */
export function consoleShowsPullFailure(output: string | null): boolean {
  return (output ?? '').split(/\r?\n/).some((line) => line.trim() === AWS_INDEX_PULL_FAILED_MARKER);
}
