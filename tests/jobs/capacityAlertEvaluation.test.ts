import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPACITY_ALERT_EVALUATION_CRON,
  CAPACITY_ALERT_READ_SECOND,
  capacityAlertEvaluation,
  msUntilReadSecond,
} from '@/lib/jobs/definitions/capacityAlertEvaluation';
import { JobStepYield } from '@/lib/jobs/engine/step';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { JobTestEngine } from '../helpers/jobs';

// THE CAPACITY ALERT PASS'S SCHEDULE (Story MOTIR-9539 · MOTIR-9612): the
// registration, the late-minute alignment, and the handler yielding on its sleep
// before it reads anything.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const at = (iso: string) => new Date(`2026-10-25T${iso}Z`);

describe('msUntilReadSecond', () => {
  it.each([
    ['12:00:00.000', 45_000],
    ['12:00:15.000', 30_000],
    ['12:00:44.999', 1],
    ['12:00:45.000', 0],
    ['12:00:59.999', 0],
  ])('at %s sleeps %i ms', (iso, ms) => {
    expect(msUntilReadSecond(at(iso))).toBe(ms);
  });

  it('never returns a negative number', () => {
    for (let ms = 0; ms < 60_000; ms += 250) {
      expect(msUntilReadSecond(new Date(at('12:00:00.000').getTime() + ms))).toBeGreaterThanOrEqual(
        0,
      );
    }
  });
});

describe('the registration', () => {
  it('is a registered every-minute system job that catches up to the latest tick', () => {
    expect(capacityAlertEvaluation.id).toBe('system.capacity-alert-evaluation');
    expect(capacityAlertEvaluation.cron).toBe(CAPACITY_ALERT_EVALUATION_CRON);
    expect(CAPACITY_ALERT_EVALUATION_CRON).toBe('* * * * *');
    expect(CAPACITY_ALERT_READ_SECOND).toBe(45);
    expect(capacityAlertEvaluation.catchUp).toBe('latest');
    expect(jobDefinitions).toContain(capacityAlertEvaluation);
    expect(typeof jobServices.capacityAlertJob.run).toBe('function');
  });
});

describe('the handler', () => {
  /** A step API whose `sleep` yields until its deadline, as the engine's does. */
  function yieldingContext(now: () => Date) {
    const deadlines = new Map<string, Date>();
    const memo = new Map<string, unknown>();
    return {
      event: { name: 'scheduled.system.capacity-alert-evaluation', data: {}, id: 'e' },
      runId: 'run',
      attempt: 0,
      step: {
        sleep: async (id: string, ms: number | string) => {
          const deadline = deadlines.get(id) ?? new Date(now().getTime() + Number(ms));
          deadlines.set(id, deadline);
          if (now() < deadline) throw new JobStepYield(id, deadline);
        },
        run: async (id: string, fn: () => unknown) => {
          if (!memo.has(id)) memo.set(id, await fn());
          return memo.get(id);
        },
      },
    } as unknown as Parameters<typeof capacityAlertEvaluation.handler>[0];
  }

  it('fired at second 0 yields without evaluating, and once resumed past :45 evaluates exactly once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('12:00:00.000'));
    const output = { outcome: 'unavailable', reason: 'not_configured', raisedCount: 0 } as const;
    const run = vi.spyOn(jobServices.capacityAlertJob, 'run').mockResolvedValue(output);
    const ctx = yieldingContext(() => new Date());

    await expect(capacityAlertEvaluation.handler(ctx, jobServices)).rejects.toBeInstanceOf(
      JobStepYield,
    );
    expect(run).not.toHaveBeenCalled();

    vi.setSystemTime(at('12:00:45.200'));
    await expect(capacityAlertEvaluation.handler(ctx, jobServices)).resolves.toEqual(output);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('records the pass outcome as the run output on the ledger', async () => {
    const output = { outcome: 'unavailable', reason: 'not_configured', raisedCount: 0 } as const;
    vi.spyOn(jobServices.capacityAlertJob, 'run').mockResolvedValue(output);
    const outcome = await new JobTestEngine({ function: capacityAlertEvaluation }).execute();
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toEqual(output);
    expect(outcome.ctx.step.sleep).toHaveBeenCalledWith('align-to-late-minute', expect.any(Number));
  });
});
