import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_EC2_ACTIVATION_TIMEOUT_MS,
  AWS_EC2_ACTIVATION_WINDOW_MS,
  AwsEc2ActivationPendingError,
  Ec2ApiError,
  isAwsEc2ActivationRefusal,
  withAwsEc2Activation,
} from '../src/index';

// A new account's EC2 activation (MOTIR-10204): in the minutes after
// CreateAccount, EC2 answers OptInRequired (HTTP 401) until it is active. The
// first EC2 call of a run is retried through that — for a young account only —
// to a deadline, on an injected clock.

const ACCOUNT = '478747422311';
const JOINED = Date.parse('2026-11-01T21:28:51Z');

function clockAt(t: number) {
  const clock = { t, sleeps: [] as number[] };
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
}

/** A call that refuses with `code` `times` times, then answers `value`. */
function refusing<T>(times: number, value: T, code = 'OptInRequired', status = 401) {
  let calls = 0;
  const call = vi.fn(async () => {
    calls += 1;
    if (calls <= times) throw new Ec2ApiError(code, status, false);
    return value;
  });
  return call;
}

describe('withAwsEc2Activation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['OptInRequired', 'PendingVerification'])(
    'waits a just-created account’s %s out and answers the call',
    async (code) => {
      const { clock, now, sleep } = clockAt(JOINED + 5_000);
      const call = refusing(3, true, code);
      await expect(
        withAwsEc2Activation(call, {
          accountId: ACCOUNT,
          accountJoinedAt: new Date(JOINED),
          now,
          sleep,
        }),
      ).resolves.toBe(true);
      expect(call).toHaveBeenCalledTimes(4);
      expect(clock.sleeps).toEqual([15_000, 15_000, 15_000]);
    },
  );

  it('answers at once, with no wait, when EC2 is already active', async () => {
    const { clock, now, sleep } = clockAt(JOINED);
    const call = refusing(0, 'vpcs');
    await expect(
      withAwsEc2Activation(call, {
        accountId: ACCOUNT,
        accountJoinedAt: new Date(JOINED),
        now,
        sleep,
      }),
    ).resolves.toBe('vpcs');
    expect(clock.sleeps).toEqual([]);
  });

  it('past the deadline throws AwsEc2ActivationPendingError saying to run again', async () => {
    const { clock, now, sleep } = clockAt(JOINED + 1_000);
    const call = refusing(Infinity, true);
    const err = await withAwsEc2Activation(call, {
      accountId: ACCOUNT,
      accountJoinedAt: new Date(JOINED),
      now,
      sleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsEc2ActivationPendingError);
    expect(err).toMatchObject({
      code: 'AWS_EC2_ACTIVATION_PENDING',
      accountId: ACCOUNT,
      awsCode: 'OptInRequired',
    });
    expect((err as Error).message).toMatch(
      /AWS account 478747422311 was still activating \(OptInRequired\) after 15 minutes; run the command again/,
    );
    expect(clock.t - (JOINED + 1_000)).toBeGreaterThanOrEqual(AWS_EC2_ACTIVATION_TIMEOUT_MS);
  });

  it('a re-run inside the window waits again and completes', async () => {
    // The first run gave up at its deadline; the re-run, minutes later, finds EC2 active.
    const { now, sleep } = clockAt(JOINED + AWS_EC2_ACTIVATION_TIMEOUT_MS + 60_000);
    const call = refusing(1, 'done');
    await expect(
      withAwsEc2Activation(call, {
        accountId: ACCOUNT,
        accountJoinedAt: new Date(JOINED),
        now,
        sleep,
      }),
    ).resolves.toBe('done');
  });

  it('throws the refusal unchanged for an account older than the window', async () => {
    const { clock, now, sleep } = clockAt(JOINED + AWS_EC2_ACTIVATION_WINDOW_MS + 1);
    const call = refusing(1, true);
    const err = await withAwsEc2Activation(call, {
      accountId: ACCOUNT,
      accountJoinedAt: new Date(JOINED),
      now,
      sleep,
    }).catch((e: unknown) => e);
    expect(err).toEqual(new Ec2ApiError('OptInRequired', 401, false));
    expect(clock.sleeps).toEqual([]);
  });

  it('throws the refusal unchanged when the account’s age is not known', async () => {
    const { now, sleep } = clockAt(JOINED);
    const err = await withAwsEc2Activation(refusing(1, true), {
      accountId: ACCOUNT,
      accountJoinedAt: null,
      now,
      sleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Ec2ApiError);
  });

  it('throws any other error at once, whatever the account’s age', async () => {
    const { clock, now, sleep } = clockAt(JOINED);
    const other = refusing(1, true, 'UnauthorizedOperation', 403);
    await expect(
      withAwsEc2Activation(other, {
        accountId: ACCOUNT,
        accountJoinedAt: new Date(JOINED),
        now,
        sleep,
      }),
    ).rejects.toEqual(new Ec2ApiError('UnauthorizedOperation', 403, false));
    const boom = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(
      withAwsEc2Activation(boom, {
        accountId: ACCOUNT,
        accountJoinedAt: new Date(JOINED),
        now,
        sleep,
      }),
    ).rejects.toThrow('socket hang up');
    expect(clock.sleeps).toEqual([]);
  });

  it('waits on a real timer and the real clock when none is injected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JOINED + 10_000);
    const pending = withAwsEc2Activation(refusing(1, 'ok'), {
      accountId: ACCOUNT,
      accountJoinedAt: new Date(JOINED),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toBe('ok');
  });
});

describe('isAwsEc2ActivationRefusal', () => {
  it('names the two activation codes only', () => {
    expect(isAwsEc2ActivationRefusal(new Ec2ApiError('OptInRequired', 401, false))).toBe(true);
    expect(isAwsEc2ActivationRefusal(new Ec2ApiError('PendingVerification', 401, false))).toBe(
      true,
    );
    expect(isAwsEc2ActivationRefusal(new Ec2ApiError('AuthFailure', 401, false))).toBe(false);
    expect(isAwsEc2ActivationRefusal(new Error('OptInRequired'))).toBe(false);
  });
});
