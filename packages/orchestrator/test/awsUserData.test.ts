import { describe, expect, it } from 'vitest';
import {
  RUNNER_USER_DATA_KEYS,
  RunnerUserDataError,
  USER_DATA_MAX_BYTES,
  buildRunnerUserData,
  encodeUserData,
} from '../src/index';
import { AWS_SPEC_ENV } from './contract/awsHarness';

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
