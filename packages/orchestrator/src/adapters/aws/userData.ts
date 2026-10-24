// The runner's USER-DATA (Story MOTIR-9270 · MOTIR-9276) — the four `KEY=value`
// lines the AMI's boot hook accepts (`infra/ci-runner-aws/boot/parse-user-data.sh`,
// `CI_KEYS`), built from the spec's env. And, for a hosted agent run
// (MOTIR-9422), the AMI's CONTAINER MODE: one digest-pinned image and its env.
//
// ⚠️ A REFUSAL, NOT A FILTER. A key outside the four is thrown, never dropped:
// dropping it would hide a change to `buildSpec`, and a runner would boot without
// the value someone added. The ONE name dropped is listed below with its reason.
//
// ⚠️ THE PAYLOAD CARRIES THE JIT CONFIG — a live runner credential. Nothing here
// logs it, and no error names a value: a refusal names the KEY only.

/** The keys the boot hook accepts, in the order they are written. */
export const RUNNER_USER_DATA_KEYS = [
  'ACTIONS_RUNNER_INPUT_JITCONFIG',
  'MOTIR_RUNNER_LABEL',
  'MOTIR_INTENT_ID',
  'MOTIR_WORKFLOW_JOB_ID',
] as const;

/**
 * The env keys `buildSpec` sets that the AMI does not take, with the reason.
 * `ACTIONS_RUNNER_CONFIG_ARGS` is a `config.sh` flag: a JIT runner never runs
 * `config.sh`, and the Fly entrypoint already logs it without forwarding it.
 */
export const RUNNER_USER_DATA_DROPPED_KEYS: Readonly<Record<string, string>> = {
  ACTIONS_RUNNER_CONFIG_ARGS: 'a config.sh flag; a JIT runner never runs config.sh',
};

/** AWS's limit on user-data: 16 KB "in raw form, not base64-encoded form" —
 *  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html */
export const USER_DATA_MAX_BYTES = 16 * 1024;

/** The boot hook's own value check: anything else it refuses at boot, after the
 *  instance is billing, so it is refused here first. */
const VALUE_PATTERN = /^[A-Za-z0-9+/=._:-]+$/;

/** A spec env the AMI cannot take. `key` names the offending key, never a value. */
export class RunnerUserDataError extends Error {
  readonly code = 'AWS_RUNNER_USER_DATA_REFUSED' as const;
  constructor(
    readonly reason: 'unexpected_key' | 'missing_key' | 'bad_value' | 'too_large' | 'bad_image',
    readonly key: string | null,
  ) {
    super(
      reason === 'too_large'
        ? `The runner user-data is over AWS's ${USER_DATA_MAX_BYTES}-byte limit.`
        : reason === 'unexpected_key'
          ? `The runner image does not accept ${key}; add it to the boot hook first.`
          : reason === 'missing_key'
            ? `The runner user-data has no ${key}.`
            : reason === 'bad_image'
              ? `The container image must be <registry>/<repo>@sha256:<64 hex>, with no tag (the value is not shown).`
              : `The runner user-data value for ${key} holds a character the image refuses (the value is not shown).`,
    );
    this.name = 'RunnerUserDataError';
  }
}

/** The four `KEY=value` lines, newline-terminated, or a refusal. */
export function buildRunnerUserData(env: Readonly<Record<string, string>>): string {
  const accepted = new Set<string>(RUNNER_USER_DATA_KEYS);
  for (const key of Object.keys(env)) {
    if (!accepted.has(key) && !(key in RUNNER_USER_DATA_DROPPED_KEYS)) {
      throw new RunnerUserDataError('unexpected_key', key);
    }
  }
  const lines = RUNNER_USER_DATA_KEYS.map((key) => {
    const value = env[key];
    if (value === undefined || value === '') throw new RunnerUserDataError('missing_key', key);
    // A newline would forge a fifth line; the pattern refuses it with the rest.
    if (!VALUE_PATTERN.test(value)) throw new RunnerUserDataError('bad_value', key);
    return `${key}=${value}`;
  });
  return `${lines.join('\n')}\n`;
}

/** AWS's raw-size rule, shared by both builders. */
function assertWithinLimit(userData: string): void {
  if (Buffer.byteLength(userData, 'utf8') > USER_DATA_MAX_BYTES) {
    throw new RunnerUserDataError('too_large', null);
  }
}

/** The base64 `UserData` for RunInstances, refused above AWS's limit. */
export function encodeUserData(userData: string): string {
  assertWithinLimit(userData);
  return Buffer.from(userData, 'utf8').toString('base64');
}

/**
 * THE ENV A HOSTED AGENT RUN MAY CARRY onto an agent-runner VM (MOTIR-9422) —
 * exactly what the start paths put in the spec: `admitHostedRun`'s four, its
 * `envAtAdmission`'s three credentials, and the continue / fix / review
 * `extraEnv`. Like the CI keys it is a REFUSAL, never a filter: a start path that
 * adds a key fails loudly here (`tests/hostedRuns/hostedAgentEnvAllowList.test.ts`
 * pins the two lists together) instead of booting a run missing a variable.
 */
export const HOSTED_AGENT_ENV_NAMES = [
  'MOTIR_API_URL',
  'MOTIR_DISPATCH_RUN_ID',
  'MOTIR_GATEWAY_URL',
  'MOTIR_MODEL',
  'MOTIR_REVIEW_GATE_ID',
  'MOTIR_REVIEW_VERSION',
  'MOTIR_RUN_KEY',
  'MOTIR_RUN_MODE',
  'MOTIR_RUN_TOKEN',
  'MOTIR_WORK_ITEM_KEY',
] as const;

/** The AMI's container-mode image rule (`parse-user-data.sh`'s `IMAGE_RE`). */
const CONTAINER_IMAGE_PATTERN =
  /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/;

/** A character that would forge a line or end the string in the AMI's parse. */
const LINE_BREAKING = /[\n\r\0]/;

/**
 * The AMI's CONTAINER-MODE user-data (MOTIR-9422; contract in
 * `infra/ci-runner-aws/README.md`): `MOTIR_BOOT_MODE=container`, the image, and
 * one `MOTIR_ENV_<NAME>=<value>` line per env key, sorted, values unchanged —
 * `docker --env-file` reads them literally. Refused before returning: an image
 * not pinned by digest, a key outside {@link HOSTED_AGENT_ENV_NAMES}, a missing
 * `MOTIR_DISPATCH_RUN_ID`, a value with a newline, carriage return or NUL, and a
 * payload over AWS's 16 KB. A refusal names the KEY, never a value: the env
 * carries the run token and the run key.
 */
export function buildContainerUserData(input: {
  image: string;
  env: Readonly<Record<string, string>>;
}): string {
  if (!CONTAINER_IMAGE_PATTERN.test(input.image)) {
    throw new RunnerUserDataError('bad_image', 'MOTIR_CONTAINER_IMAGE');
  }
  const accepted = new Set<string>(HOSTED_AGENT_ENV_NAMES);
  const keys = Object.keys(input.env).sort();
  for (const key of keys) {
    if (!accepted.has(key)) throw new RunnerUserDataError('unexpected_key', key);
    if (LINE_BREAKING.test(input.env[key]!)) throw new RunnerUserDataError('bad_value', key);
  }
  if (!input.env['MOTIR_DISPATCH_RUN_ID']) {
    throw new RunnerUserDataError('missing_key', 'MOTIR_DISPATCH_RUN_ID');
  }
  const lines = [
    'MOTIR_BOOT_MODE=container',
    `MOTIR_CONTAINER_IMAGE=${input.image}`,
    ...keys.map((key) => `MOTIR_ENV_${key}=${input.env[key]}`),
  ];
  const userData = `${lines.join('\n')}\n`;
  assertWithinLimit(userData);
  return userData;
}
