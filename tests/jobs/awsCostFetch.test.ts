import { afterEach, describe, expect, it, vi } from 'vitest';
import { AWS_COST_FETCH_CRON, awsCostFetch } from '@/lib/jobs/definitions/awsCostFetch';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { awsCostService } from '@/lib/services/awsCostService';

// THE AWS COST FETCH'S SCHEDULE (MOTIR-11712): a registered 6-hourly system job
// that runs the service's fetch in one memoised step.

afterEach(() => vi.restoreAllMocks());

describe('the registration', () => {
  it('is a registered system job at :20 every 6 hours that catches up to the latest fire', () => {
    expect(awsCostFetch.id).toBe('system.aws-cost-fetch');
    expect(awsCostFetch.cron).toBe(AWS_COST_FETCH_CRON);
    expect(AWS_COST_FETCH_CRON).toBe('20 */6 * * *');
    expect(awsCostFetch.catchUp).toBe('latest');
    expect(jobDefinitions).toContain(awsCostFetch);
    expect(jobServices.awsCost).toBe(awsCostService);
  });
});

describe('the handler', () => {
  it('runs the fetch in the `fetch-aws-costs` step and answers its outcome', async () => {
    const outcome = { status: 'not_configured' } as const;
    const fetchRecent = vi.spyOn(awsCostService, 'fetchRecent').mockResolvedValue(outcome);
    const run = vi.fn(async (_id: string, fn: () => unknown) => fn());
    const ctx = {
      event: { name: 'scheduled.system.aws-cost-fetch', data: {}, id: 'e' },
      runId: 'run',
      attempt: 0,
      step: { run },
    } as unknown as Parameters<typeof awsCostFetch.handler>[0];

    await expect(awsCostFetch.handler(ctx, jobServices)).resolves.toEqual(outcome);
    expect(run).toHaveBeenCalledWith('fetch-aws-costs', expect.any(Function));
    expect(fetchRecent).toHaveBeenCalledTimes(1);
  });
});
