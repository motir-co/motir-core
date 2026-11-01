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
// THE REGISTRY LOGIN (MOTIR-10123). The image is private: GHCR's package is, and
// Fly's mirror serves nothing without a Fly token. On AWS it is pulled from
// Motir's own ECR, so the VM boots with ONE instance profile,
// `motir-fleet-index` (`AWS_INDEX_IAM_ROLE`), whose role may get an ECR login
// and read that one repository and nothing else; the repository's own policy
// admits it from the indexer pool's accounts only. Before the pull the script
// asks ECR for a login with that role and hands it to `docker login`. The
// command it uses is the AWS CLI's `aws ecr get-login-password`, the documented
// way: the ECS-optimized AMI is built from the MINIMAL Amazon Linux 2023 image,
// which may not carry the CLI, so when `aws` is missing the script installs
// `awscli-2` from the region's own Amazon Linux repository first. That is the
// one package a boot may install, and only on an ECR image. An image in any
// other registry is pulled as before, with no login. A failed login is a failed
// pull: it writes the same marker.
//
// THE PULL-FAILURE CHANNEL is the serial console. The VM has no inbound rule, and
// its role can do nothing but read the indexer image, so it reports nothing
// through an AWS API. It can write to its own console, and `GetConsoleOutput`
// reads that console with the adapter's own key.
// When the pull fails, the script writes ONE line, {@link AWS_INDEX_PULL_FAILED_MARKER},
// to the console and powers off. The adapter's `describe` reads the console of a
// stopped index VM and reports `imagePullFailed`. Every other line of the script,
// the container's own output included, goes to a log file on the VM, never the
// console. That way an indexed repository's content cannot forge the marker.
//
// THE EXIT-CODE CHANNEL (MOTIR-9449) is the same console with a DIFFERENT marker:
// once `docker run` returns, the script writes {@link AWS_INDEX_EXIT_MARKER} and the
// code, and only then powers off. A pull failure writes its own marker and never
// this one, so a pull failure is never read as an exit code. The ordering closes
// the race with teardown: an index VM launches with
// `InstanceInitiatedShutdownBehavior: 'stop'` (a runner keeps `terminate`), so the
// power-off leaves it STOPPED — no compute billed, console still readable — and
// only the adapter's `teardown` terminates it, which the dispatcher calls at
// settle, after a describe has returned the final code. A stopped index VM nobody
// settles is still a fleet instance in a live state, so the orphan reaper ends it.
//
// ⚠️ THE PAYLOAD CARRIES THE RUN CREDENTIAL and two pre-signed URLs. Nothing here
// logs it, and no refusal names a value: it names the KEY only. IMDSv2 with a hop
// limit of 1 (set on every launch) keeps the container off the metadata service,
// which serves the user-data and the index role's credentials.

/** The console line an index VM writes when it cannot pull its image. */
export const AWS_INDEX_PULL_FAILED_MARKER = 'MOTIR_INDEX_BOOT: image_pull_failed';

/** The console line an index VM writes when its container returns, before the
 *  code: `MOTIR_INDEX_BOOT: exit_code=0`. */
export const AWS_INDEX_EXIT_MARKER = 'MOTIR_INDEX_BOOT: exit_code=';

/** The comment line naming the image the script pulls. The fake EC2 reads it to
 *  decide whether the pull succeeds; nothing in AWS does. */
export const AWS_INDEX_IMAGE_COMMENT = '# motir-index-image: ';

/** A private ECR registry host: `<account>.dkr.ecr.<region>.amazonaws.com`
 *  (`.com.cn` in the China partition). Captures the region. */
const ECR_REGISTRY_PATTERN =
  /^\d{12}\.dkr\.ecr\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?$/;

/**
 * The ECR registry and region an image reference names, or null for an image in
 * any other registry. Read from the host before the first `/`.
 */
export function ecrRegistryOf(image: string): { registry: string; region: string } | null {
  const slash = image.indexOf('/');
  if (slash <= 0) return null;
  const registry = image.slice(0, slash);
  const match = ECR_REGISTRY_PATTERN.exec(registry);
  return match ? { registry, region: match[1]! } : null;
}

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

/** The lines that end the boot on a failed pull: the marker, then power off. */
const PULL_FAILED_LINES = [
  `  console '${AWS_INDEX_PULL_FAILED_MARKER}'`,
  '  shutdown -h now',
  '  exit 0',
];

/**
 * The ECR login before the pull, or nothing for an image elsewhere: install the
 * AWS CLI when the AMI has none, then pipe the role's login into `docker login`.
 * The password travels on the pipe only, never in an argument or the log.
 */
function ecrLoginLines(image: string): string[] {
  const ecr = ecrRegistryOf(image);
  if (!ecr) return [];
  return [
    'if ! command -v aws >/dev/null 2>&1; then dnf install -y -q awscli-2; fi',
    `if ! aws ecr get-login-password --region '${ecr.region}' | docker login --username AWS --password-stdin '${ecr.registry}'; then`,
    ...PULL_FAILED_LINES,
    'fi',
  ];
}

/** The boot script for one index VM: log in, pull by digest, run, power off. */
export function buildIndexUserData(spec: {
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
}): string {
  const image = requireIndexImageDigest(spec.image);
  return [
    '#!/bin/bash',
    `${AWS_INDEX_IMAGE_COMMENT}${image}`,
    // pipefail: the ECR login is a pipe, and its failure is the CLI's too.
    'set -u -o pipefail',
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
    ...ecrLoginLines(image),
    'if ! docker pull "$IMAGE"; then',
    ...PULL_FAILED_LINES,
    'fi',
    'docker run --rm --env-file /run/motir-index.env "$IMAGE"',
    'code=$?',
    // Written before the power-off, so a VM that reads stopped has written it.
    `console "${AWS_INDEX_EXIT_MARKER}$code"`,
    'sync',
    'shutdown -h now',
    '',
  ].join('\n');
}

/** The container's exit code from a console read: the LAST exit marker on a line
 *  of its own, or null when there is none (a VM that never got that far). */
export function consoleExitCode(output: string | null): number | null {
  let code: number | null = null;
  for (const line of (output ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(AWS_INDEX_EXIT_MARKER)) continue;
    const value = trimmed.slice(AWS_INDEX_EXIT_MARKER.length);
    // A process exit status is 0–255; anything else is not this script's line.
    if (/^\d{1,3}$/.test(value) && Number(value) <= 255) code = Number(value);
  }
  return code;
}

/** Whether a console read holds the pull-failure marker on a line of its own. */
export function consoleShowsPullFailure(output: string | null): boolean {
  return (output ?? '').split(/\r?\n/).some((line) => line.trim() === AWS_INDEX_PULL_FAILED_MARKER);
}
