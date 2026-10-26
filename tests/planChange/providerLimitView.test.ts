import { describe, expect, it } from 'vitest';

import { providerLimitView } from '@/lib/planChange/providerLimitView';
import type { PlanSessionFailureReasonDto } from '@/lib/dto/planChange';
import type { PlanStepProviderWaitDto } from '@/lib/dto/plans';

// THE PROVIDER-LIMIT PRECEDENCE (Story MOTIR-9540 · MOTIR-9622): a failure wins over a wait, a
// wait with no failure is `retrying`, and only a `rate_limited` failure is `stopped`.

const WAIT: PlanStepProviderWaitDto = {
  attempt: 1,
  maxAttempts: 3,
  since: '2026-10-26T08:00:00.000Z',
  retryAt: '2026-10-26T08:00:05.000Z',
};
const fail = (reason: PlanSessionFailureReasonDto) => ({ reason });

describe('providerLimitView', () => {
  it.each([
    ['rate_limited', WAIT, 'stopped'],
    ['rate_limited', null, 'stopped'],
    ['internal', WAIT, 'none'],
    ['internal', null, 'none'],
    ['out_of_credits', WAIT, 'none'],
    ['job_failed', null, 'none'],
    [null, WAIT, 'retrying'],
    [null, null, 'none'],
  ] as const)('failure %s, wait %o → %s', (reason, wait, view) => {
    expect(providerLimitView(reason === null ? null : fail(reason), wait)).toBe(view);
  });

  it('treats an absent failure and an absent wait as none', () => {
    expect(providerLimitView(undefined, undefined)).toBe('none');
  });
});
