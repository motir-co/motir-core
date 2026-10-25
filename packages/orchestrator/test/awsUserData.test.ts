import { describe, expect, it } from 'vitest';
import {
  HOSTED_AGENT_ENV_NAMES,
  RUNNER_USER_DATA_KEYS,
  RunnerUserDataError,
  USER_DATA_MAX_BYTES,
  buildContainerUserData,
  buildRunnerUserData,
  encodeUserData,
} from '../src/index';
import { AWS_HOSTED_ENV, AWS_HOSTED_IMAGE, AWS_SPEC_ENV } from './contract/awsHarness';

// The runner's user-data (MOTIR-9276): exactly the four lines the AMI's boot hook
// accepts, refused — never filtered — when the spec's env holds anything else.

describe('buildRunnerUserData', () => {
  it('writes the four KEY=value lines in order and drops ACTIONS_RUNNER_CONFIG_ARGS', () => {
    const userData = buildRunnerUserData(AWS_SPEC_ENV);

    expect(userData).toBe(
      [
        'ACTIONS_RUNNER_INPUT_JITCONFIG=eyJqaXQiOiJjb25maWcifQ==',
        'MOTIR_RUNNER_LABEL=motir-fleet',
        'MOTIR_INTENT_ID=intent-1',
        'MOTIR_WORKFLOW_JOB_ID=44001',
        '',
      ].join('\n'),
    );
    expect(userData).not.toContain('ACTIONS_RUNNER_CONFIG_ARGS');
    expect(RUNNER_USER_DATA_KEYS).toHaveLength(4);
  });

  it('refuses any other key, naming the key', () => {
    const thrown = (() => {
      try {
        buildRunnerUserData({ ...AWS_SPEC_ENV, MOTIR_SOMETHING_NEW: 'x' });
      } catch (err) {
        return err;
      }
    })();
    expect(thrown).toBeInstanceOf(RunnerUserDataError);
    expect(thrown).toMatchObject({ reason: 'unexpected_key', key: 'MOTIR_SOMETHING_NEW' });
  });

  it.each(RUNNER_USER_DATA_KEYS)('refuses a spec missing %s', (key) => {
    const env: Record<string, string> = { ...AWS_SPEC_ENV };
    delete env[key];
    expect(() => buildRunnerUserData(env)).toThrow(
      expect.objectContaining({ reason: 'missing_key', key }),
    );
    expect(() => buildRunnerUserData({ ...AWS_SPEC_ENV, [key]: '' })).toThrow(
      expect.objectContaining({ reason: 'missing_key', key }),
    );
  });

  it('refuses a value with a newline or a character the image refuses, never echoing it', () => {
    for (const value of ['abc\nEVIL=1', 'has space', 'quote"d']) {
      const thrown = (() => {
        try {
          buildRunnerUserData({ ...AWS_SPEC_ENV, MOTIR_INTENT_ID: value });
        } catch (err) {
          return err as Error;
        }
      })();
      expect(thrown).toMatchObject({ reason: 'bad_value', key: 'MOTIR_INTENT_ID' });
      expect(thrown!.message).not.toContain(value);
    }
  });
});

describe('encodeUserData', () => {
  it('base64-encodes the payload', () => {
    const userData = buildRunnerUserData(AWS_SPEC_ENV);
    expect(Buffer.from(encodeUserData(userData), 'base64').toString('utf8')).toBe(userData);
  });

  it('accepts exactly the 16 KB limit and refuses a byte more', () => {
    expect(() => encodeUserData('a'.repeat(USER_DATA_MAX_BYTES))).not.toThrow();
    expect(() => encodeUserData('a'.repeat(USER_DATA_MAX_BYTES + 1))).toThrow(
      expect.objectContaining({ code: 'AWS_RUNNER_USER_DATA_REFUSED', reason: 'too_large' }),
    );
  });
});

// The AMI's CONTAINER-MODE user-data (MOTIR-9422): the image and the run's env,
// refused — never filtered — when the env holds a key no start path sets.
describe('buildContainerUserData', () => {
  const MARKER = 'S3CRETMARKERVALUE';

  function refusal(input: { image: string; env: Record<string, string> }): RunnerUserDataError {
    try {
      buildContainerUserData(input);
    } catch (err) {
      return err as RunnerUserDataError;
    }
    throw new Error('expected a refusal');
  }

  it('writes the mode, the image and the plain Run hosted env, sorted, values unchanged', () => {
    const env = { ...AWS_HOSTED_ENV, MOTIR_MODEL: 'a=b c $HOME' };
    expect(buildContainerUserData({ image: AWS_HOSTED_IMAGE, env })).toBe(
      [
        'MOTIR_BOOT_MODE=container',
        `MOTIR_CONTAINER_IMAGE=${AWS_HOSTED_IMAGE}`,
        'MOTIR_ENV_MOTIR_API_URL=https://app.motir.test',
        'MOTIR_ENV_MOTIR_DISPATCH_RUN_ID=run-77',
        'MOTIR_ENV_MOTIR_GATEWAY_URL=https://gateway.motir.test',
        'MOTIR_ENV_MOTIR_MODEL=a=b c $HOME',
        'MOTIR_ENV_MOTIR_RUN_KEY=rk_live_key_value',
        'MOTIR_ENV_MOTIR_RUN_TOKEN=mtr_run_token_value',
        'MOTIR_ENV_MOTIR_WORK_ITEM_KEY=ACME-12',
        '',
      ].join('\n'),
    );
  });

  it('accepts the review env', () => {
    const env = {
      ...AWS_HOSTED_ENV,
      MOTIR_RUN_MODE: 'review',
      MOTIR_REVIEW_GATE_ID: 'gate-1',
      MOTIR_REVIEW_VERSION: '3',
    };
    const lines = buildContainerUserData({ image: AWS_HOSTED_IMAGE, env }).trim().split('\n');
    expect(lines).toHaveLength(12);
    expect(lines).toContain('MOTIR_ENV_MOTIR_RUN_MODE=review');
    expect(HOSTED_AGENT_ENV_NAMES).toHaveLength(10);
  });

  it.each([
    ['a tag and no digest', 'ghcr.io/motir-co/motir-hosted-agent:main'],
    ['a short digest', `ghcr.io/motir-co/agent@sha256:${'a'.repeat(63)}`],
    ['an upper-case digest', `ghcr.io/motir-co/agent@sha256:${'A'.repeat(64)}`],
    ['text after the digest', `${AWS_HOSTED_IMAGE}${MARKER}`],
  ])('refuses an image with %s', (_case, image) => {
    const err = refusal({ image, env: { ...AWS_HOSTED_ENV } });
    expect(err).toMatchObject({ reason: 'bad_image', key: 'MOTIR_CONTAINER_IMAGE' });
    expect(err.message).not.toContain(MARKER);
  });

  it('refuses a key off the allow-list, naming it', () => {
    const err = refusal({
      image: AWS_HOSTED_IMAGE,
      env: { ...AWS_HOSTED_ENV, LD_PRELOAD: MARKER },
    });
    expect(err).toMatchObject({ reason: 'unexpected_key', key: 'LD_PRELOAD' });
    expect(err.message).not.toContain(MARKER);
  });

  it('refuses a spec with no run id', () => {
    const env: Record<string, string> = { ...AWS_HOSTED_ENV };
    delete env['MOTIR_DISPATCH_RUN_ID'];
    expect(refusal({ image: AWS_HOSTED_IMAGE, env })).toMatchObject({
      reason: 'missing_key',
      key: 'MOTIR_DISPATCH_RUN_ID',
    });
  });

  it.each(['\n', '\r', '\0'])('refuses a value holding %j, never echoing it', (ch) => {
    const err = refusal({
      image: AWS_HOSTED_IMAGE,
      env: { ...AWS_HOSTED_ENV, MOTIR_RUN_TOKEN: `${MARKER}${ch}MOTIR_ENV_X=1` },
    });
    expect(err).toMatchObject({ reason: 'bad_value', key: 'MOTIR_RUN_TOKEN' });
    expect(err.message).not.toContain(MARKER);
  });

  it('refuses a payload over 16 KB raw', () => {
    const err = refusal({
      image: AWS_HOSTED_IMAGE,
      env: { ...AWS_HOSTED_ENV, MOTIR_RUN_TOKEN: MARKER.repeat(1_000) },
    });
    expect(err).toMatchObject({ reason: 'too_large' });
    expect(err.message).not.toContain(MARKER);
    expect(USER_DATA_MAX_BYTES).toBe(16 * 1024);
  });
});
