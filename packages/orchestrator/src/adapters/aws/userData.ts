// The runner's USER-DATA (Story MOTIR-9270 · MOTIR-9276) — the four `KEY=value`
// lines the AMI's boot hook accepts (`infra/ci-runner-aws/boot/motir-runner-prepare.sh`,
// `KNOWN_KEYS`), built from the spec's env.
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
    readonly reason: 'unexpected_key' | 'missing_key' | 'bad_value' | 'too_large',
    readonly key: string | null,
  ) {
    super(
      reason === 'too_large'
        ? `The runner user-data is over AWS's ${USER_DATA_MAX_BYTES}-byte limit.`
        : reason === 'unexpected_key'
          ? `The runner image does not accept ${key}; add it to the boot hook first.`
          : reason === 'missing_key'
            ? `The runner user-data has no ${key}.`
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

/** The base64 `UserData` for RunInstances, refused above AWS's limit. */
export function encodeUserData(userData: string): string {
  const raw = Buffer.from(userData, 'utf8');
  if (raw.length > USER_DATA_MAX_BYTES) throw new RunnerUserDataError('too_large', null);
  return raw.toString('base64');
}
