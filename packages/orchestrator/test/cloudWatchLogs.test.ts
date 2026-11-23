import { describe, expect, it } from 'vitest';
import {
  LOG_GROUP_MISSING,
  LogsUnavailableError,
  OrchestratorApiError,
  cloudWatchLiteralPattern,
  cloudWatchLogsUnavailable,
  cloudWatchSliceReader,
  isLogGroupMissing,
  lastLambdaInvocationBefore,
  readLambdaRuntimeSignals,
  CLOUDWATCH_LOG_LIMITS,
  type LogSliceReader,
} from '../src/index';

// THE SHARED CLOUDWATCH LOGS READ (MOTIR-12103 · MOTIR-12104): the parts both
// AWS targets read a release's log group through — the literal filter pattern,
// the failure mapping, the slice reader's edges and the Lambda runtime readers'.

describe('cloudWatchLiteralPattern', () => {
  it('sends the text as a two-case regex in which nothing is an operator', () => {
    expect(cloudWatchLiteralPattern('Error 5')).toBe('%[eE][rR][rR][oO][rR]\\x205%');
    expect(cloudWatchLiteralPattern('a?b-{c}.*+^$|[]\\')).toBe(
      '%[aA]\\?[bB]-\\{[cC]\\}\\.\\*\\+\\^\\$\\|\\[\\]\\\\%',
    );
    expect(cloudWatchLiteralPattern(':_#=@/;,')).toBe('%:_#=@/;,%');
    expect(cloudWatchLiteralPattern('"quoted" (x)!')).toBe(
      '%\\x22[qQ][uU][oO][tT][eE][dD]\\x22\\x20\\x28[xX]\\x29\\x21%',
    );
  });

  it('matches every casing of the text and nothing it does not contain', () => {
    const regex = (pattern: string) => new RegExp(pattern.slice(1, -1));
    const pattern = cloudWatchLiteralPattern('a?B-{c')!;
    expect(regex(pattern).test('GET /A?b-{C} 200')).toBe(true);
    expect(regex(pattern).test('GET /ab-{c} 200')).toBe(false);
  });

  it('sends nothing for an empty text, one past ASCII, a control character or one too long', () => {
    expect(cloudWatchLiteralPattern('')).toBeNull();
    expect(cloudWatchLiteralPattern('café')).toBeNull();
    expect(cloudWatchLiteralPattern('a\tb')).toBeNull();
    expect(cloudWatchLiteralPattern('x'.repeat(200))).toBeNull();
    expect(cloudWatchLiteralPattern('1'.repeat(200))).toBe(`%${'1'.repeat(200)}%`);
  });
});

describe('the CloudWatch failure mapping and slice reader', () => {
  it('names AWS’s refusal by its code, keeps its own refusal, and rethrows anything else', () => {
    const unavailable = cloudWatchLogsUnavailable('aws');
    const own = new LogsUnavailableError('aws', 'mine');
    expect(() => unavailable(own)).toThrow(own);
    expect(() => unavailable(new OrchestratorApiError('aws', 403, 'logs Denied'))).toThrow(
      LogsUnavailableError,
    );
    const bug = new TypeError('a bug');
    expect(() => unavailable(bug)).toThrow(bug);
    expect(isLogGroupMissing(new LogsUnavailableError('aws', LOG_GROUP_MISSING))).toBe(true);
    expect(isLogGroupMissing(own)).toBe(false);
  });

  it('reads nothing for a slice under one millisecond, and a missing group by name', async () => {
    let calls = 0;
    const read = cloudWatchSliceReader({
      target: 'aws',
      filter: async () => {
        calls += 1;
        return null;
      },
      streamOf: () => 'app',
      unavailable: cloudWatchLogsUnavailable('aws'),
    });
    expect(await read(1_000_100n, 1_000_200n, 5, { requests: 5 })).toEqual({
      lines: [],
      complete: true,
      pages: 0,
    });
    expect(calls).toBe(0);
    await expect(read(0n, 5_000_000n, 5, { requests: 5 })).rejects.toMatchObject({
      reason: LOG_GROUP_MISSING,
    });
  });
});

describe('the Lambda runtime readers', () => {
  const refusing: LogSliceReader = async () => {
    throw new LogsUnavailableError('aws', 'logs AccessDeniedException');
  };

  it('pass a refusal other than a missing group through', async () => {
    const since = new Date('2026-11-23T10:00:00Z');
    const until = new Date('2026-11-23T10:05:00Z');
    await expect(
      readLambdaRuntimeSignals('aws', refusing, since, until, CLOUDWATCH_LOG_LIMITS),
    ).rejects.toMatchObject({ reason: 'logs AccessDeniedException' });
    await expect(
      lastLambdaInvocationBefore('aws', 'g', refusing, until, null, CLOUDWATCH_LOG_LIMITS),
    ).rejects.toMatchObject({ reason: 'logs AccessDeniedException' });
    expect(
      await lastLambdaInvocationBefore('aws', 'g', refusing, until, until, CLOUDWATCH_LOG_LIMITS),
    ).toBeNull();
  });
});
