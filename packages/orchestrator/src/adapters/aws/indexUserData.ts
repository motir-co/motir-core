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
// THE RETRY (MOTIR-11276). The login and the pull each retry with exponential
// backoff for {@link AWS_INDEX_PULL_RETRY_WINDOW_SECONDS} before the script calls
// the pull failed. From 2026-11-09 a few index VMs a day timed out reaching ECR in
// their first seconds (`dial tcp …:443: i/o timeout`, `context deadline exceeded`)
// while every other run that day pulled the same digest, and one try lost the
// whole run to it. A refusal that will not change (a missing image, a denied
// role) is retried too and fails at the window's end: that costs a VM two
// minutes, and telling the two apart from docker's text would be a guess.
//
// THE PULL-FAILURE CHANNEL is the serial console. The VM has no inbound rule, and
// its role can do nothing but read the indexer image, so it reports nothing
// through an AWS API. It can write to its own console, and `GetConsoleOutput`
// reads that console with the adapter's own key.
// When the pull fails, the script writes the last lines of the failed command's
// own output, each prefixed {@link AWS_INDEX_PULL_ERROR_PREFIX}, then ONE line,
// {@link AWS_INDEX_PULL_FAILED_MARKER}, and powers off. The error lines are why a
// failed pull can be diagnosed at all: the log file below lives on the VM's disk,
// which is gone once the VM is terminated (MOTIR-10823). They are docker's and the
// AWS CLI's own words (a registry refusal, a missing image, a network error) —
// the login password travels on a pipe and is never printed, and the env file is
// written by a heredoc that echoes nothing. The adapter's `describe` reads the
// console and reports `imagePullFailed`, logging the error lines. Every other line
// of the script, the container's own output included, goes to a log file on the
// VM, never the console. That way an indexed repository's content cannot forge
// either marker: the error lines come only from the login and the pull, which run
// before the container does.
//
// THE EXIT-CODE CHANNEL (MOTIR-9449) is the same console with a DIFFERENT marker:
// once `docker run` returns, the script writes {@link AWS_INDEX_EXIT_MARKER} and the
// code, and only then powers off.
//
// THE HOLD BEFORE THE POWER-OFF (MOTIR-10823). After either marker the VM stays
// up for {@link AWS_INDEX_MARKER_HOLD_SECONDS} before it powers off, so the
// adapter reads the marker LIVE while the VM is still running. Waiting for EC2 to
// post a STOPPED instance's buffered console is not dependable: on 2026-11-09 it
// took 5 to 9 minutes on the install fleet and more than 10 on a pool account,
// past MOTIR-10805's grace window, and two runs that had a marker settled as
// `exit_unobserved`. The hold is several times supervision's longest poll
// interval (15 s), so a poll lands inside it; the stopped-VM read and its grace
// window stay as the fallback for a hold no poll saw. A pull failure writes its own marker and never
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

/** The prefix of each console line that carries the failed login's or pull's own
 *  output, written before {@link AWS_INDEX_PULL_FAILED_MARKER} (MOTIR-10823). */
export const AWS_INDEX_PULL_ERROR_PREFIX = 'MOTIR_INDEX_BOOT: pull_error: ';

/** How many of the failed command's last output lines reach the console, and how
 *  long each may be. Docker's refusal is its last line; the cap keeps a pull's
 *  progress output off the console. */
export const AWS_INDEX_PULL_ERROR_LINES = 5;
export const AWS_INDEX_PULL_ERROR_LINE_CHARS = 300;

/** How long an index VM stays up after it writes a marker, so a live console read
 *  sees it before the power-off (MOTIR-10823). Supervision polls at most every
 *  15 s; four polls fit inside it. */
export const AWS_INDEX_MARKER_HOLD_SECONDS = 60;

/** How long the boot keeps retrying a failed ECR login, and then a failed pull,
 *  before it calls the pull failed (MOTIR-11276): a transient network timeout to
 *  the registry at boot is retried instead of losing the whole index run. No new
 *  attempt starts after the window; the one in flight runs to its own end. */
export const AWS_INDEX_PULL_RETRY_WINDOW_SECONDS = 120;

/** The first wait between attempts, doubled after each failure up to
 *  {@link AWS_INDEX_PULL_RETRY_MAX_DELAY_SECONDS}: 5, 10, 20, 30, 30 … */
export const AWS_INDEX_PULL_RETRY_FIRST_DELAY_SECONDS = 5;
export const AWS_INDEX_PULL_RETRY_MAX_DELAY_SECONDS = 30;

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

/** The shell functions the boot uses: `console` writes one line to the serial
 *  console; `pull_failed` copies the failed command's last output lines (control
 *  characters dropped, each line capped) to the console, then the marker, holds,
 *  and powers off. */
const FUNCTION_LINES = [
  'console() { echo "$1" >/dev/ttyS0 2>/dev/null || echo "$1" >/dev/console; }',
  'pull_failed() {',
  '  printf \'%s\\n\' "$1"',
  `  printf '%s\\n' "$1" | tr -cd '[:print:]\\n' | grep -v '^[[:space:]]*$' | tail -n ${AWS_INDEX_PULL_ERROR_LINES} | cut -c1-${AWS_INDEX_PULL_ERROR_LINE_CHARS} | while IFS= read -r line; do console "${AWS_INDEX_PULL_ERROR_PREFIX}$line"; done`,
  `  console '${AWS_INDEX_PULL_FAILED_MARKER}'`,
  `  sleep ${AWS_INDEX_MARKER_HOLD_SECONDS}`,
  '  shutdown -h now',
  '  exit 0',
  '}',
  // retry: run the command until it succeeds, waiting with exponential backoff,
  // and give up once the next wait would pass the window. `out` is left holding
  // the LAST attempt's output, which is what `pull_failed` copies to the console.
  // Every attempt's output goes to the boot log, never the console.
  'retry() {',
  `  local deadline=$((SECONDS + ${AWS_INDEX_PULL_RETRY_WINDOW_SECONDS})) delay=${AWS_INDEX_PULL_RETRY_FIRST_DELAY_SECONDS}`,
  '  while :; do',
  '    if out=$("$@" 2>&1); then return 0; fi',
  '    printf \'%s\\n\' "$out"',
  '    if (( SECONDS + delay > deadline )); then return 1; fi',
  '    echo "$1 failed; retrying in ${delay}s"',
  '    sleep "$delay"',
  `    delay=$(( delay * 2 > ${AWS_INDEX_PULL_RETRY_MAX_DELAY_SECONDS} ? ${AWS_INDEX_PULL_RETRY_MAX_DELAY_SECONDS} : delay * 2 ))`,
  '  done',
  '}',
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
    // The whole pipe's stderr and docker's stdout are kept; the password is the
    // CLI's stdout, which only the pipe carries.
    `ecr_login() { aws ecr get-login-password --region '${ecr.region}' | docker login --username AWS --password-stdin '${ecr.registry}'; }`,
    'if ! retry ecr_login; then',
    '  pull_failed "$out"',
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
    ...FUNCTION_LINES,
    // Everything below stays off the console: only the markers may reach it.
    'exec >>/var/log/motir-index-boot.log 2>&1',
    'systemctl disable --now ecs || true',
    'systemctl start docker',
    'umask 077',
    `cat >/run/motir-index.env <<'${ENV_DELIMITER}'`,
    ...envLines(spec.env),
    ENV_DELIMITER,
    `IMAGE='${image}'`,
    ...ecrLoginLines(image),
    'pull_image() { docker pull "$IMAGE"; }',
    'if ! retry pull_image; then',
    '  pull_failed "$out"',
    'fi',
    'docker run --rm --env-file /run/motir-index.env "$IMAGE"',
    'code=$?',
    // Written before the power-off, so a VM that reads stopped has written it.
    `console "${AWS_INDEX_EXIT_MARKER}$code"`,
    'sync',
    `sleep ${AWS_INDEX_MARKER_HOLD_SECONDS}`,
    'shutdown -h now',
    '',
  ].join('\n');
}

/**
 * The text after `marker` on one console line, or null when the line carries no
 * marker. The marker may sit anywhere on the line, at its start or after
 * whitespace: the serial console glues the first line the script writes to the
 * getty login prompt it was printing (`ip-10-65-7-59 login: MOTIR_INDEX_BOOT: …`,
 * MOTIR-11276), so a reader that wants the marker first on its line misses it.
 * The marker must still begin a word, so the script's own source, should it ever
 * reach the console, is not read as one (`console "MOTIR_INDEX_BOOT: …`).
 */
function afterMarker(line: string, marker: string): string | null {
  const trimmed = line.trim();
  for (let at = trimmed.indexOf(marker); at !== -1; at = trimmed.indexOf(marker, at + 1)) {
    if (at === 0 || /\s/.test(trimmed[at - 1]!)) return trimmed.slice(at + marker.length);
  }
  return null;
}

/** The container's exit code from a console read: the LAST exit marker followed
 *  by nothing but the code, or null when there is none (a VM that never got that
 *  far). */
export function consoleExitCode(output: string | null): number | null {
  let code: number | null = null;
  for (const line of (output ?? '').split(/\r?\n/)) {
    const value = afterMarker(line, AWS_INDEX_EXIT_MARKER);
    // A process exit status is 0–255; anything else is not this script's line.
    if (value !== null && /^\d{1,3}$/.test(value) && Number(value) <= 255) code = Number(value);
  }
  return code;
}

/** The failed login's or pull's own output lines from a console read, in order,
 *  without their prefix (MOTIR-10823). Empty when there are none. */
export function consolePullError(output: string | null): string[] {
  return (output ?? '')
    .split(/\r?\n/)
    .map((line) => afterMarker(line, AWS_INDEX_PULL_ERROR_PREFIX))
    .filter((text): text is string => text !== null);
}

/** Whether a console read holds the pull-failure marker, ending its line. */
export function consoleShowsPullFailure(output: string | null): boolean {
  return (output ?? '')
    .split(/\r?\n/)
    .some((line) => afterMarker(line, AWS_INDEX_PULL_FAILED_MARKER) === '');
}
