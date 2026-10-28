import { describe, expect, it } from 'vitest';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import {
  ACCOUNT_KIND_KEYS,
  ACCOUNT_ROLE_KEYS,
  ACCOUNT_STATE_KEYS,
  FIGURE_KEYS,
  FIGURE_SOURCE_KEYS,
  FLEET_KIND_KEYS,
  PROVIDER_KEYS,
  QUOTA_OUTCOME_KEYS,
  REQUEST_STATUS_KEYS,
  SHARED_FLOOR_KEYS,
  figureSourceKey,
  figureView,
  fmtDateTime,
} from '@/app/(authed)/settings/organization/billing/_components/fleetUseFormat';
import {
  checkCapacityRequest,
  problemFromResponse,
} from '@/app/(authed)/settings/organization/billing/_components/FleetUseRequestDialog';

// MOTIR-9663: every code the fleet-use read returns names a real message in en
// and zh, and the pure helpers read a null as NOT READ — never 0.

function lookup(messages: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      (messages as { billing: { fleetUse: unknown } }).billing.fleetUse,
    );
}

const MAPS = {
  FLEET_KIND_KEYS,
  PROVIDER_KEYS,
  ACCOUNT_STATE_KEYS,
  ACCOUNT_KIND_KEYS,
  ACCOUNT_ROLE_KEYS,
  SHARED_FLOOR_KEYS,
  QUOTA_OUTCOME_KEYS,
  REQUEST_STATUS_KEYS,
};

describe('fleetUseFormat — every code has words', () => {
  for (const [name, map] of Object.entries(MAPS)) {
    it(`${name} names a non-empty message in en and zh`, () => {
      for (const key of Object.values(map)) {
        for (const messages of [enMessages, zhMessages]) {
          const value = lookup(messages, key);
          expect(typeof value, `${name} → ${key}`).toBe('string');
          expect((value as string).trim().length).toBeGreaterThan(0);
        }
      }
    });
  }

  it('every figure has a label and an explanation, and every source line resolves', () => {
    for (const figure of FIGURE_KEYS) {
      for (const messages of [enMessages, zhMessages]) {
        expect(typeof lookup(messages, `label.${figure}`)).toBe('string');
        expect(typeof lookup(messages, `explain.${figure}`)).toBe('string');
        for (const source of Object.keys(
          FIGURE_SOURCE_KEYS,
        ) as (keyof typeof FIGURE_SOURCE_KEYS)[]) {
          const key = figureSourceKey(figure, source);
          if (key) expect(typeof lookup(messages, key), key).toBe('string');
        }
      }
    }
  });
});

describe('figureView', () => {
  const row = { figure: 3, inUse: 3, waiting: null, figureSource: 'plan' as const };

  it('reads in use of the figure with a full meter', () => {
    expect(figureView('agentRunsInParallel', row, 'en')).toEqual({
      reading: { key: 'inUseOf', values: { inUse: '3', figure: '3' } },
      pct: 100,
    });
  });

  it('never reads a null count or figure as zero', () => {
    expect(figureView('ciJobsInFlight', { ...row, inUse: null }, 'en').reading.key).toBe('notRead');
    expect(figureView('ciJobsInFlight', { ...row, figure: null }, 'en').reading.key).toBe(
      'notRead',
    );
  });

  it('reads members at the per-person figure without a meter', () => {
    expect(figureView('agentsPerPerson', { ...row, figure: 2, inUse: 1 }, 'en')).toEqual({
      reading: { key: 'membersAt', values: { count: 1, figure: '2' } },
      pct: null,
    });
  });

  it('reads use alone under no plan limits', () => {
    expect(figureView('agentsInOrg', { ...row, figure: null, inUse: 7 }, 'en', true)).toEqual({
      reading: { key: 'running', values: { count: '7' } },
      pct: null,
    });
  });
});

describe('fmtDateTime', () => {
  it('formats in UTC and returns null for nothing or garbage', () => {
    expect(fmtDateTime('2026-10-23T09:12:00.000Z', 'en')).toBe('Oct 23, 09:12');
    expect(fmtDateTime(null, 'en')).toBeNull();
    expect(fmtDateTime('nope', 'en')).toBeNull();
  });
});

describe('checkCapacityRequest', () => {
  it('wants a whole number above what is granted, and a reason of at most 2,000 characters', () => {
    expect(checkCapacityRequest('512', 'more builds', 256)).toBeNull();
    expect(checkCapacityRequest('1', 'more builds', null)).toBeNull();
    expect(checkCapacityRequest('256', 'x', 256)).toBe('figure');
    expect(checkCapacityRequest('12.5', 'x', null)).toBe('figure');
    expect(checkCapacityRequest('', 'x', null)).toBe('figure');
    expect(checkCapacityRequest('512', '  ', 256)).toBe('reason');
    expect(checkCapacityRequest('512', 'x'.repeat(2001), 256)).toBe('reason');
  });
});

describe('problemFromResponse', () => {
  it('tells every refusal apart by status and code', () => {
    expect(problemFromResponse(400, { field: 'desiredVcpu' })).toEqual({
      kind: 'field',
      field: 'figure',
    });
    expect(problemFromResponse(400, { field: 'reason' })).toEqual({
      kind: 'field',
      field: 'reason',
    });
    expect(problemFromResponse(400, { field: 'fleetKind' })).toEqual({
      kind: 'refused',
      refusal: 'invalid',
    });
    expect(problemFromResponse(409, { code: 'FLEET_CAPACITY_REQUEST_OPEN' })).toEqual({
      kind: 'refused',
      refusal: 'open',
    });
    expect(problemFromResponse(403, null)).toEqual({ kind: 'refused', refusal: 'forbidden' });
    expect(problemFromResponse(404, {})).toEqual({ kind: 'refused', refusal: 'notFound' });
    expect(problemFromResponse(502, {})).toEqual({ kind: 'refused', refusal: 'failed' });
  });
});
